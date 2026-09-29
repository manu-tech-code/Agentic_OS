import AVFoundation

/// The phone's ears and voice for Nova. The microphone runs only while the talk button is held, through
/// Apple's voice processing (echo cancellation, noise suppression), and goes to the Mac as 16 kHz 16-bit PCM,
/// 20 ms at a time - as Nova.app's does. Nova's replies, in Kokoro's voice, play through the same engine,
/// so the echo canceller knows Nova's voice: talking over it works.
final class Voice {
  /// 20 ms of microphone while talking, for the Mac (or the phone's own hearing).
  var onFrame: (Data) -> Void = { _ in }
  /// How loud the microphone is while talking, and Nova while it speaks: 0-1, for the Orb.
  var onLevel: (Float) -> Void = { _ in }
  /// The last of a reply finished playing (not when it was cut off).
  var onFinished: () -> Void = {}
  var onProblem: (String) -> Void = { _ in }

  static let frameBytes = 640 // 20 ms at 16 kHz, 16-bit
  static let sendFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
  private let playFormat = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!

  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private var started = false
  private(set) var talking = false
  private var pending = Data()

  // What's playing: one reply at a time, its pieces in order.
  private(set) var playing: String?
  private var pieces: [Int: AVAudioPCMBuffer] = [:]
  private var nextPiece = 0
  private var lastPiece: Int?
  private var outstanding = 0
  private var generation = 0
  private var cut: [String] = []
  private var resamplers: [Double: AVAudioConverter] = [:]

  var speaking: Bool { playing != nil }

  init() {
    engine.attach(player)
    NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
      // A call, Siri, another app's audio: when it's over, pick up again.
      guard let self, let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
      self.started = false
      _ = self.start()
    }
    NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
      // Headphones in or out: the engine stopped - start it on the new route.
      self?.started = false
      if self?.talking == true { self?.talking = false }
      _ = self?.start()
    }
  }

  /// The audio session and the engine, set up for talking and listening. Asks for the microphone the first time.
  @discardableResult
  func start() -> Bool {
    guard !started else { return true }
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
      try session.setPreferredIOBufferDuration(0.02)
      try session.setActive(true)
    } catch {
      onProblem("The audio wouldn't start: \(error.localizedDescription)")
      return false
    }
    // Echo cancellation runs the microphone, so it waits until the user has let Nova have it (their first talk):
    // a reply to something typed never asks for the microphone.
    if AVAudioApplication.shared.recordPermission == .granted, !engine.inputNode.isVoiceProcessingEnabled {
      do {
        try engine.inputNode.setVoiceProcessingEnabled(true)
      } catch {
        onProblem("Echo cancellation wouldn't start, so Nova's voice may be heard back.")
      }
    }
    engine.connect(player, to: engine.mainMixerNode, format: playFormat)
    // Nova's voice, as it plays: how loud it is moves the Orb.
    engine.mainMixerNode.removeTap(onBus: 0)
    engine.mainMixerNode.installTap(onBus: 0, bufferSize: 1024, format: engine.mainMixerNode.outputFormat(forBus: 0)) { [weak self] buffer, _ in
      let level = Voice.rms(buffer)
      DispatchQueue.main.async {
        guard let self, self.playing != nil, !self.talking else { return }
        self.onLevel(min(1, level * 4))
      }
    }
    engine.prepare()
    do {
      try engine.start()
      started = true
    } catch {
      onProblem("The audio engine wouldn't start: \(error.localizedDescription)")
    }
    return started
  }

  /// The talk button went down: the microphone, until it comes up.
  func startTalking() async -> Bool {
    guard await AVAudioApplication.requestRecordPermission() else {
      onProblem("Nova can't use the microphone: allow it in Settings → Nova.")
      return false
    }
    // Allowed just now: start again, with echo cancellation this time.
    if started, !engine.inputNode.isVoiceProcessingEnabled {
      engine.stop()
      started = false
    }
    guard start(), !talking else { return talking }
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: 1, interleaved: false),
      let converter = AVAudioConverter(from: mono, to: Voice.sendFormat)
    else {
      onProblem("There's no microphone to listen with.")
      return false
    }
    pending.removeAll()
    input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(format.sampleRate / 50), format: format) { [weak self] buffer, _ in
      guard let one = Voice.firstChannel(buffer, as: mono), let pcm = Voice.convert(one, with: converter) else { return }
      let level = Voice.rms(one)
      DispatchQueue.main.async { self?.heard(pcm, level: level) }
    }
    talking = true
    return true
  }

  /// The talk button came up.
  func stopTalking() {
    guard talking else { return }
    engine.inputNode.removeTap(onBus: 0)
    talking = false
    if !pending.isEmpty {
      onFrame(pending)
      pending.removeAll()
    }
    onLevel(0)
  }

  private func heard(_ pcm: Data, level: Float) {
    guard talking else { return }
    pending.append(pcm)
    while pending.count >= Voice.frameBytes {
      onFrame(Data(pending.prefix(Voice.frameBytes)))
      pending.removeFirst(Voice.frameBytes)
    }
    onLevel(min(1, level * 5))
  }

  // MARK: Speaking

  /// A piece of a reply in Kokoro's voice: 16-bit PCM, in order by `seq`, the last one marked.
  func play(id: String, seq: Int, sampleRate: Double, pcm: Data, last: Bool) {
    guard !cut.contains(id) else { return } // already in flight when it was cut off
    if playing != id {
      stopPlayback()
      playing = id
      nextPiece = seq
    }
    if last { lastPiece = seq }
    pieces[seq] = (pcm.isEmpty ? nil : floatBuffer(pcm, rate: sampleRate)) ?? silence()
    schedule()
  }

  /// Stop speaking now: the user talked over Nova, or said stop.
  func stopPlayback() {
    generation += 1
    player.stop()
    if let id = playing {
      cut.append(id)
      if cut.count > 20 { cut.removeFirst(cut.count - 20) }
      endPlayback(finished: false)
    }
  }

  private func schedule() {
    while let buffer = pieces.removeValue(forKey: nextPiece) {
      nextPiece += 1
      guard buffer.frameLength > 0 else { continue }
      outstanding += 1
      start()
      let generation = self.generation
      player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
        DispatchQueue.main.async {
          guard let self, generation == self.generation else { return }
          self.outstanding -= 1
          self.checkFinished()
        }
      }
      if engine.isRunning, !player.isPlaying { player.play() }
    }
    checkFinished()
  }

  private func checkFinished() {
    guard playing != nil, let last = lastPiece, nextPiece > last, outstanding == 0 else { return }
    endPlayback(finished: true)
  }

  private func endPlayback(finished: Bool) {
    playing = nil
    pieces.removeAll()
    lastPiece = nil
    outstanding = 0
    onLevel(0)
    if finished { onFinished() }
  }

  // MARK: Audio arithmetic (as Nova.app's)

  static func firstChannel(_ buffer: AVAudioPCMBuffer, as mono: AVAudioFormat) -> AVAudioPCMBuffer? {
    let frames = Int(buffer.frameLength)
    guard frames > 0, let source = buffer.floatChannelData, let one = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: AVAudioFrameCount(frames)),
      let target = one.floatChannelData?[0]
    else { return nil }
    one.frameLength = AVAudioFrameCount(frames)
    if buffer.format.isInterleaved {
      let stride = Int(buffer.format.channelCount)
      for i in 0..<frames { target[i] = source[0][i * stride] }
    } else {
      target.update(from: source[0], count: frames)
    }
    return one
  }

  static func rms(_ buffer: AVAudioPCMBuffer) -> Float {
    guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
    var sum: Float = 0
    for i in 0..<Int(buffer.frameLength) { sum += samples[i] * samples[i] }
    return (sum / Float(buffer.frameLength)).squareRoot()
  }

  /// Mono float audio as the Mac hears it: 16 kHz 16-bit little-endian PCM. The converter keeps its state, so the stream stays seamless.
  static func convert(_ input: AVAudioPCMBuffer, with converter: AVAudioConverter) -> Data? {
    let capacity = AVAudioFrameCount(Double(input.frameLength) * 16_000 / input.format.sampleRate) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: sendFormat, frameCapacity: capacity) else { return nil }
    var given = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if given {
        status.pointee = .noDataNow
        return nil
      }
      given = true
      status.pointee = .haveData
      return input
    }
    guard error == nil, out.frameLength > 0, let samples = out.int16ChannelData?[0] else { return nil }
    return Data(bytes: samples, count: Int(out.frameLength) * 2)
  }

  private func silence() -> AVAudioPCMBuffer? {
    let empty = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: 1)
    empty?.frameLength = 0
    return empty
  }

  private func floatBuffer(_ pcm: Data, rate: Double) -> AVAudioPCMBuffer? {
    guard let decoded = Voice.decode(pcm, rate: rate) else { return nil }
    if rate == playFormat.sampleRate { return decoded }
    let converter = resamplers[rate] ?? AVAudioConverter(from: decoded.format, to: playFormat)
    resamplers[rate] = converter
    return converter.flatMap { resample(decoded, with: $0) }
  }

  /// 16-bit little-endian PCM as a float buffer.
  static func decode(_ pcm: Data, rate: Double) -> AVAudioPCMBuffer? {
    let count = pcm.count / 2
    guard count > 0, let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1),
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)), let out = buffer.floatChannelData?[0]
    else { return nil }
    buffer.frameLength = AVAudioFrameCount(count)
    pcm.withUnsafeBytes { raw in
      for i in 0..<count { out[i] = Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))) / 32768 }
    }
    return buffer
  }

  private func resample(_ input: AVAudioPCMBuffer, with converter: AVAudioConverter) -> AVAudioPCMBuffer? {
    let capacity = AVAudioFrameCount(Double(input.frameLength) * playFormat.sampleRate / input.format.sampleRate) + 64
    guard let out = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: capacity) else { return nil }
    var given = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if given {
        status.pointee = .noDataNow
        return nil
      }
      given = true
      status.pointee = .haveData
      return input
    }
    return error == nil && out.frameLength > 0 ? out : nil
  }
}
