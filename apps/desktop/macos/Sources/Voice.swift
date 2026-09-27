import AVFoundation
import os

/// Nova.app's own log lines: `log show --predicate 'subsystem == "dev.nova.app"'`.
let novaLog = Logger(subsystem: "dev.nova.app", category: "nova")

/// Nova's ears and voice on the Mac. The microphone runs through Apple's voice processing (echo
/// cancellation, noise suppression) and Nova's replies - Kokoro's voice - play through the same engine, so the echo
/// canceller knows Nova's voice and takes it out of what the microphone hears: talking over Nova
/// just works. What the microphone hears goes to the daemon as 16 kHz 16-bit PCM, 20 ms at a time.
final class Voice {
  /// 20 ms of microphone, for the daemon.
  var onFrame: (Data) -> Void = { _ in }
  /// How loud the microphone is, 0-1 (the orb moves with it).
  var onLevel: (Float) -> Void = { _ in }
  /// The last of a reply finished playing (not when it was cut off).
  var onFinished: () -> Void = {}
  var onProblem: (String) -> Void = { _ in }

  static let frameBytes = 640 // 20 ms at 16 kHz, 16-bit
  private static let sendFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
  private let playFormat = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!

  private var engine = AVAudioEngine()
  private var player = AVAudioPlayerNode()
  private(set) var capturing = false
  private var tapped = false
  /// Bumped whenever the engine is rebuilt, so the old one's microphone and playback are ignored.
  private var session = 0
  private var pending = Data()

  // What's playing: one reply at a time, its pieces in order.
  private(set) var playing: String?
  private var pieces: [Int: AVAudioPCMBuffer] = [:]
  private var nextPiece = 0
  private var lastPiece: Int?
  private var outstanding = 0
  private var generation = 0
  private var resamplers: [Double: AVAudioConverter] = [:]

  init() {
    NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { [weak self] note in
      // A microphone or speaker came or went (AirPods, say): start over on the new ones.
      guard let self, (note.object as? AVAudioEngine) === self.engine else { return }
      self.rebuild(capture: self.capturing)
    }
    rebuild(capture: false)
  }

  var speaking: Bool { playing != nil }

  /// Start or stop the microphone. Stopping really lets go of it, so macOS's orange dot goes away.
  func setCapture(_ on: Bool) {
    guard on != capturing else { return }
    rebuild(capture: on)
  }

  /// How the microphone is set up. Apple's voice processing wants the speaker side in the
  /// microphone's format; some Macs want it mono. Without it (the last resort) Nova can still
  /// hear, but only the daemon's echo check keeps it from hearing itself.
  private enum Microphone: String, CaseIterable {
    case echoCancelledMono = "echo-cancelled, mono out"
    case echoCancelled = "echo-cancelled"
    case plain = "without echo cancellation"
  }

  private func rebuild(capture: Bool) {
    let interrupted = playing != nil
    session += 1
    generation += 1 // the old player's buffers never report back
    teardown()
    capturing = false
    pending.removeAll()
    if capture {
      for setup in Microphone.allCases {
        fresh()
        if startMicrophone(setup), start() {
          capturing = true
          novaLog.notice("listening, \(setup.rawValue, privacy: .public)")
          if setup == .plain { onProblem("Echo cancellation wouldn't start, so the microphone runs without it.") }
          break
        }
        teardown()
      }
      if !capturing {
        onProblem("The microphone wouldn't start.")
        speakOnly(attempt: 0)
      }
    } else {
      speakOnly(attempt: 0)
    }
    if interrupted { endPlayback(finished: false) }
  }

  /// No microphone, only Nova's voice. Right after voice processing stops, macOS can take a moment
  /// to let go of it: try again shortly.
  private func speakOnly(attempt: Int) {
    fresh()
    connectPlayer(to: nil)
    guard !start(), attempt < 4 else { return }
    let session = self.session
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3 * Double(attempt + 1)) { [weak self] in
      guard let self, session == self.session, !self.capturing, !self.engine.isRunning else { return }
      self.speakOnly(attempt: attempt + 1)
    }
  }

  /// The app is quitting: let go of the microphone and the speaker.
  func shutdown() {
    session += 1
    generation += 1
    teardown()
    capturing = false
  }

  private func fresh() {
    engine = AVAudioEngine()
    player = AVAudioPlayerNode()
    engine.attach(player)
  }

  private func teardown() {
    if tapped { engine.inputNode.removeTap(onBus: 0) }
    tapped = false
    engine.stop()
  }

  private func start() -> Bool {
    engine.prepare()
    do {
      try engine.start()
      return true
    } catch {
      novaLog.error("the audio engine wouldn't start: \(error.localizedDescription, privacy: .public)")
      return false
    }
  }

  /// Nova's voice goes through the mixer; with voice processing, out in the microphone's format.
  private func connectPlayer(to output: AVAudioFormat?) {
    engine.connect(player, to: engine.mainMixerNode, format: playFormat)
    if let output { engine.connect(engine.mainMixerNode, to: engine.outputNode, format: output) }
  }

  private func startMicrophone(_ setup: Microphone) -> Bool {
    let input = engine.inputNode
    if setup != .plain {
      do {
        try input.setVoiceProcessingEnabled(true)
      } catch {
        novaLog.error("voice processing unavailable: \(error.localizedDescription, privacy: .public)")
        return false
      }
      // Listening all day mustn't turn the user's music down.
      input.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: true, duckingLevel: .min)
    }
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0,
          let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: 1, interleaved: false),
          let converter = AVAudioConverter(from: mono, to: Voice.sendFormat) else {
      novaLog.error("no microphone to listen with")
      return false
    }
    novaLog.notice("microphone \(setup.rawValue, privacy: .public): \(format.sampleRate, privacy: .public) Hz, \(format.channelCount, privacy: .public) channel(s)")
    let session = self.session
    // On the audio thread: the first channel (voice processing's cleaned-up microphone), resampled
    // for the daemon by this tap's own converter.
    input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(format.sampleRate / 50), format: format) { [weak self] buffer, _ in
      guard let one = Voice.firstChannel(buffer, as: mono), let pcm = Voice.convert(one, with: converter) else { return }
      let level = Voice.rms(one)
      let channels = Voice.channelLevels(buffer)
      DispatchQueue.main.async {
        self?.heard(pcm, level: level, session: session)
        self?.echoCheck(channels)
      }
    }
    tapped = true
    switch setup {
    case .echoCancelled: connectPlayer(to: AVAudioFormat(standardFormatWithSampleRate: format.sampleRate, channels: format.channelCount))
    case .echoCancelledMono: connectPlayer(to: AVAudioFormat(standardFormatWithSampleRate: format.sampleRate, channels: 1))
    case .plain: connectPlayer(to: nil)
    }
    return true
  }

  private func heard(_ pcm: Data, level: Float, session: Int) {
    guard session == self.session, capturing else { return }
    pending.append(pcm)
    while pending.count >= Voice.frameBytes {
      onFrame(Data(pending.prefix(Voice.frameBytes)))
      pending.removeFirst(Voice.frameBytes)
    }
    onLevel(min(1, level * 5))
  }

  static func firstChannel(_ buffer: AVAudioPCMBuffer, as mono: AVAudioFormat) -> AVAudioPCMBuffer? {
    let frames = Int(buffer.frameLength)
    guard frames > 0, let source = buffer.floatChannelData, let one = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: AVAudioFrameCount(frames)),
          let target = one.floatChannelData?[0] else { return nil }
    one.frameLength = AVAudioFrameCount(frames)
    if buffer.format.isInterleaved {
      let stride = Int(buffer.format.channelCount)
      for i in 0..<frames { target[i] = source[0][i * stride] }
    } else {
      target.update(from: source[0], count: frames)
    }
    return one
  }

  /// Each channel's level: voice processing's first channel is the cleaned-up microphone.
  static func channelLevels(_ buffer: AVAudioPCMBuffer) -> [Float] {
    guard let data = buffer.floatChannelData, buffer.frameLength > 0, !buffer.format.isInterleaved else { return [] }
    let n = Int(buffer.frameLength)
    return (0..<Int(buffer.format.channelCount)).map { c in
      var sum: Float = 0
      for i in 0..<n { sum += data[c][i] * data[c][i] }
      return (sum / Float(n)).squareRoot()
    }
  }

  /// How loud each channel is while Nova speaks, against just before: logged once per reply, so
  /// it's plain whether the echo canceller takes Nova's voice out of what the microphone hears.
  private var quiet: [Float] = []
  private var loud: [Float] = []
  private var quietBlocks = 0
  private var loudBlocks = 0

  private func echoCheck(_ levels: [Float]) {
    guard !levels.isEmpty else { return }
    if playing != nil {
      loud = loud.isEmpty ? levels : zip(loud, levels).map { $0 + $1 }
      loudBlocks += 1
    } else if loudBlocks == 0 {
      if quietBlocks >= 100 { (quiet, quietBlocks) = ([], 0) } // the last two seconds or so
      quiet = quiet.isEmpty ? levels : zip(quiet, levels).map { $0 + $1 }
      quietBlocks += 1
    }
  }

  private func reportEcho() {
    guard loudBlocks > 10, quietBlocks > 0 else { return (loud, loudBlocks) = ([], 0) }
    let db = { (x: Float) in 20 * log10(max(x, 1e-7)) }
    let during = loud.map { db($0 / Float(loudBlocks)) }
    let before = quiet.map { db($0 / Float(quietBlocks)) }
    let text = zip(during, before).enumerated().map { "ch\($0.offset) \(Int($0.element.0)) dB (was \(Int($0.element.1)))" }.joined(separator: ", ")
    novaLog.notice("echo check while Nova spoke: \(text, privacy: .public)")
    (loud, loudBlocks, quiet, quietBlocks) = ([], 0, [], 0)
  }

  static func rms(_ buffer: AVAudioPCMBuffer) -> Float {
    guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
    var sum: Float = 0
    for i in 0..<Int(buffer.frameLength) { sum += samples[i] * samples[i] }
    return (sum / Float(buffer.frameLength)).squareRoot()
  }

  /// Mono float audio as the daemon hears it: 16 kHz 16-bit little-endian PCM. The converter keeps
  /// its state between calls, so the stream stays seamless.
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

  // MARK: Speaking

  /// A piece of a reply in Kokoro's voice: 16-bit PCM, in order by `seq`, the last one marked.
  func play(id: String, seq: Int, sampleRate: Double, pcm: Data, last: Bool) {
    if playing != id {
      stopPlayback()
      playing = id
      nextPiece = seq
    }
    if last { lastPiece = seq }
    // A piece that can't be played still takes its place, so the rest isn't held up.
    pieces[seq] = (pcm.isEmpty ? nil : floatBuffer(pcm, rate: sampleRate)) ?? silence()
    schedule()
  }

  /// Stop speaking now: the user talked over Nova, or said stop.
  func stopPlayback() {
    generation += 1
    player.stop()
    if playing != nil { endPlayback(finished: false) }
  }

  /// A soft two-note chime as Nova starts listening - through the engine, so it's never heard back.
  func chime() {
    guard playing == nil, let buffer = Voice.chimeBuffer(format: playFormat) else { return }
    player.scheduleBuffer(buffer, completionHandler: nil)
    if engine.isRunning, !player.isPlaying { player.play() }
  }

  static func chimeBuffer(format: AVAudioFormat) -> AVAudioPCMBuffer? {
    let rate = format.sampleRate
    let notes: [(hz: Double, seconds: Double)] = [(880, 0.075), (1318.5, 0.14)]
    let total = notes.reduce(0) { $0 + Int($1.seconds * rate) }
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(total)), let out = buffer.floatChannelData?[0] else { return nil }
    buffer.frameLength = AVAudioFrameCount(total)
    var i = 0
    for note in notes {
      let n = Int(note.seconds * rate)
      for j in 0..<n {
        let t = Double(j) / rate
        let envelope = min(1, t / 0.006) * exp(-t * 18)
        out[i] = Float(0.16 * envelope * sin(2 * .pi * note.hz * t))
        i += 1
      }
    }
    return buffer
  }

  private func schedule() {
    while let buffer = pieces.removeValue(forKey: nextPiece) {
      nextPiece += 1
      guard buffer.frameLength > 0 else { continue }
      outstanding += 1
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
    if playing != nil { reportEcho() }
    playing = nil
    pieces.removeAll()
    lastPiece = nil
    outstanding = 0
    if finished { onFinished() }
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
          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)), let out = buffer.floatChannelData?[0] else { return nil }
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
