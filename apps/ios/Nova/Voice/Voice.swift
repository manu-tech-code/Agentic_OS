import AVFoundation

/// The phone's ears and voice for Nova. The microphone runs only while the talk button is held, through
/// Apple's voice processing (echo cancellation, noise suppression), and goes to the Mac as 16 kHz 16-bit PCM,
/// 20 ms at a time - as Nova.app's does. Nova's replies, in Kokoro's voice, play through the same engine,
/// so the echo canceller knows Nova's voice: talking over it works.
///
/// Away from the front - answering Siri, or a reply still coming when the phone was locked - Nova only speaks:
/// on an engine of its own with no microphone, in a session that ducks other audio rather than interrupting it
/// (the only kind iOS lets an app start in the background). Once it's done, everything is let go.
final class Voice {
  /// 20 ms of microphone while talking, for the Mac (or the phone's own hearing).
  var onFrame: (Data) -> Void = { _ in }
  /// How loud the microphone is while talking, and Nova while it speaks: 0-1, for the Orb.
  var onLevel: (Float) -> Void = { _ in }
  /// The last of a reply finished playing (not when it was cut off).
  var onFinished: () -> Void = {}
  /// A reply started playing, or stopped - finished or cut off.
  var onPlaying: (Bool) -> Void = { _ in }
  /// How Nova's voice sounds as it plays away from the front, low to high pitch, 0-1 each: the Dynamic Island's bars.
  var onBands: ([Float]) -> Void = { _ in }
  var onProblem: (String) -> Void = { _ in }

  static let frameBytes = 640 // 20 ms at 16 kHz, 16-bit
  static let sendFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
  private let playFormat = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!

  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private var started = false
  /// Speaking away from the front: no microphone, so no echo cancellation and no recording light.
  private let speaker = AVAudioEngine()
  private let speakerPlayer = AVAudioPlayerNode()
  private var speakerStarted = false
  /// The speaker's session ducks other audio (Nova speaking), or only mixes with it (Nova waiting, `stayAwake`).
  private var ducking = false
  /// Silence, looping on the speaker while Nova waits for its answer away from the front: iOS doesn't put an app to
  /// sleep while it plays audio.
  private let idler = AVAudioPlayerNode()
  private var awake = false
  private let spectrum = Spectrum()
  /// Nova isn't in front on this phone (until it first comes there).
  private(set) var away = true
  /// Where the reply playing now plays.
  private var output: AVAudioPlayerNode
  private(set) var talking = false
  /// The microphone's tap is on (it's taken off before the engine is set up again).
  private var tapped = false
  private var pending = Data()
  /// 20 ms frames sent in this turn: none after a moment means the microphone isn't getting through.
  private(set) var frames = 0

  // What's playing: one reply at a time, its pieces in order.
  private(set) var playing: String?
  /// The last reply that started playing.
  private(set) var lastPlayed: String?
  private var pieces: [Int: AVAudioPCMBuffer] = [:]
  private var nextPiece = 0
  private var lastPiece: Int?
  private var outstanding = 0
  /// Handed to the player and not heard yet, by piece: moved to the speaker if Nova leaves the front mid-reply.
  private var inFlight: [Int: AVAudioPCMBuffer] = [:]
  private var generation = 0
  private var cut: [String] = []
  private var resamplers: [Double: AVAudioConverter] = [:]

  var speaking: Bool { playing != nil }

  init() {
    output = player
    engine.attach(player)
    speaker.attach(speakerPlayer)
    speaker.connect(speakerPlayer, to: speaker.mainMixerNode, format: playFormat)
    speaker.attach(idler)
    speaker.connect(idler, to: speaker.mainMixerNode, format: playFormat)
    // Nova's voice away from the front, as it plays: its spectrum moves the bars in the Dynamic Island.
    speakerPlayer.installTap(onBus: 0, bufferSize: 2048, format: playFormat) { [weak self, spectrum] buffer, _ in
      let bands = spectrum.levels(buffer)
      DispatchQueue.main.async {
        guard let self, self.playing != nil, self.output === self.speakerPlayer else { return }
        self.onBands(bands)
      }
    }
    NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
      // A call, Siri, another app's audio: what Nova was saying stops there; when it's over, pick up again.
      guard let self, let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
      if type == .began {
        if self.playing != nil { self.stopPlayback() }
        return
      }
      self.speakerStarted = false
      guard !self.away else { return self.wakeAgain() }
      self.started = false
      _ = self.start()
    }
    NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: speaker, queue: .main) { [weak self] _ in
      // The route changed while Nova spoke away from the front: that reply ends there rather than hang half-played.
      guard let self else { return }
      self.speakerStarted = false
      if self.playing != nil, self.output === self.speakerPlayer { self.stopPlayback() }
      self.wakeAgain()
    }
    NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
      // The engine stopped because its setup changed - echo cancellation coming on, headphones in or out. Start it
      // again on the new route, and if the user is talking, keep hearing them: the turn goes on. Away from the
      // front it stays stopped: nothing may take the microphone there.
      guard let self, !self.away else { return }
      self.removeTap()
      self.started = false
      guard self.start(), self.talking else { return }
      if !self.installTap() {
        self.talking = false
        self.onProblem("The microphone stopped when the audio changed - press the button again.")
      }
    }
  }

  /// The audio session and the engine, set up for talking and listening. Asks for the microphone the first time.
  @discardableResult
  func start() -> Bool {
    guard !started else { return true }
    stopSpeaker() // one engine at a time
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
      removeTap()
      engine.stop()
      started = false
    }
    guard start(), !talking else { return talking }
    pending.removeAll()
    frames = 0
    guard installTap() else {
      onProblem("There's no microphone to listen with.")
      return false
    }
    talking = true
    return true
  }

  /// The microphone's tap: its first channel (voice processing's cleaned-up microphone), resampled for the Mac.
  private func installTap() -> Bool {
    removeTap()
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0,
      let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: 1, interleaved: false),
      let converter = AVAudioConverter(from: mono, to: Voice.sendFormat)
    else { return false }
    input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(format.sampleRate / 50), format: format) { [weak self] buffer, _ in
      guard let one = Voice.firstChannel(buffer, as: mono), let pcm = Voice.convert(one, with: converter) else { return }
      let level = Voice.rms(one)
      DispatchQueue.main.async { self?.heard(pcm, level: level) }
    }
    tapped = true
    return true
  }

  private func removeTap() {
    if tapped { engine.inputNode.removeTap(onBus: 0) }
    tapped = false
  }

  /// The talk button came up.
  func stopTalking() {
    removeTap()
    guard talking else { return }
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
      frames += 1
    }
    onLevel(min(1, level * 5))
  }

  // MARK: Away from the front

  /// Nova left the front of the phone, or came back. Away, the microphone and the engine that runs it are let go -
  /// a reply that's playing carries on from the speaker - and what Nova says next plays there too; back, it's all as before.
  func setAway(_ on: Bool) {
    guard on != away else { return }
    away = on
    if on {
      stopTalking()
      if playing == nil { letGo() } else if output === player { moveToSpeaker() }
    } else if playing == nil || output !== speakerPlayer {
      stopSpeaker() // a reply still being said away finishes there first
    }
  }

  /// Nothing to say and no one talking, away from the front: the engines stop and the audio session is given back,
  /// so music comes back up and iOS can let Nova sleep.
  private func letGo() {
    removeTap()
    talking = false
    if started {
      engine.stop()
      started = false
    }
    stopSpeaker()
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  /// Nova left the front mid-reply: the rest of it goes to the speaker, so echo cancellation - and the microphone it
  /// holds open - can stop. The sentence that was playing starts again there.
  private func moveToSpeaker() {
    let rest = inFlight.sorted { $0.key < $1.key }
    generation += 1 // what the old player reports as it stops is ignored
    player.stop()
    outstanding = 0
    inFlight.removeAll()
    output = speakerPlayer
    guard startSpeaker() else { return endPlayback(finished: true) }
    for (seq, buffer) in rest { enqueue(buffer, seq: seq) }
    checkFinished()
  }

  /// The speaker, running: Nova's voice away from the front, ducking other audio - or, only waiting (`stayAwake`),
  /// under it.
  private func startSpeaker(ducking duck: Bool = true) -> Bool {
    if speakerStarted, speaker.isRunning, ducking == duck { return true }
    if started {
      removeTap()
      engine.stop()
      started = false
    }
    let session = AVAudioSession.sharedInstance()
    do {
      // Mixing with other audio (ducking it or not) keeps the session mixable: iOS lets an app start that in the
      // background, not one that interrupts.
      try session.setCategory(.playback, mode: .spokenAudio, options: duck ? [.duckOthers] : [.mixWithOthers])
      try session.setActive(true)
      ducking = duck
      if !speakerStarted || !speaker.isRunning {
        speaker.prepare()
        try speaker.start()
        speakerStarted = true
      }
    } catch {
      onProblem("Nova's voice couldn't start: \(error.localizedDescription)")
    }
    return speakerStarted
  }

  private func stopSpeaker() {
    awake = false
    guard speakerStarted else { return }
    speakerPlayer.stop()
    idler.stop()
    speaker.stop()
    speakerStarted = false
  }

  /// Away from the front, with Nova's answer still to come: silence plays, mixed under other audio, so iOS keeps Nova
  /// awake - and its line to the Mac open - until the voice comes, however long the Mac thinks. Off, it's let go.
  func stayAwake(_ on: Bool) {
    guard on != awake else { return }
    if on {
      guard away, playing == nil, startSpeaker(ducking: false), let silence = Voice.silence(playFormat, seconds: 0.5) else { return }
      awake = true
      idler.scheduleBuffer(silence, at: nil, options: .loops)
      idler.play()
    } else {
      awake = false
      idler.stop()
      if away, playing == nil { letGo() }
    }
  }

  /// The speaker stopped under Nova while it waited (a call, a new route): the silence starts again.
  private func wakeAgain() {
    guard awake, playing == nil else { return }
    awake = false
    stayAwake(true)
  }

  /// The line to the Mac went while a reply was still coming: what came is said, and the reply ends there - the Mac
  /// sends the rest nowhere else, and a line made again doesn't bring it.
  func streamLost() {
    guard playing != nil, lastPiece == nil else { return }
    pieces.removeAll()
    lastPiece = nextPiece - 1
    checkFinished()
  }

  // MARK: Speaking

  /// A piece of a reply in Kokoro's voice: 16-bit PCM, in order by `seq`, the last one marked.
  func play(id: String, seq: Int, sampleRate: Double, pcm: Data, last: Bool) {
    guard !cut.contains(id) else { return } // already in flight when it was cut off
    if playing != id {
      stopPlayback()
      playing = id
      lastPlayed = id
      nextPiece = seq
      output = away ? speakerPlayer : player
      onPlaying(true)
    }
    if last { lastPiece = seq }
    pieces[seq] = (pcm.isEmpty ? nil : floatBuffer(pcm, rate: sampleRate)) ?? silence()
    schedule()
  }

  /// Stop speaking now: the user talked over Nova, or said stop.
  func stopPlayback() {
    generation += 1
    player.stop()
    if speakerStarted { speakerPlayer.stop() }
    if let id = playing {
      cut.append(id)
      if cut.count > 20 { cut.removeFirst(cut.count - 20) }
      endPlayback(finished: false)
    }
  }

  private func schedule() {
    while let buffer = pieces.removeValue(forKey: nextPiece) {
      let seq = nextPiece
      nextPiece += 1
      // A piece that can't be played is passed over: the reply still ends, and the Mac hears that it did.
      guard buffer.frameLength > 0, running() else { continue }
      enqueue(buffer, seq: seq)
    }
    checkFinished()
  }

  /// A piece onto the player the reply plays on; once it's been heard, the reply may be over.
  private func enqueue(_ buffer: AVAudioPCMBuffer, seq: Int) {
    outstanding += 1
    inFlight[seq] = buffer
    let generation = self.generation
    output.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
      DispatchQueue.main.async {
        guard let self, generation == self.generation else { return }
        self.inFlight[seq] = nil
        self.outstanding -= 1
        self.checkFinished()
      }
    }
    if !output.isPlaying { output.play() }
  }

  /// The engine this reply plays on, running: the speaker away from the front, else the one that listens too.
  private func running() -> Bool {
    if output === speakerPlayer { return startSpeaker() }
    if started, !engine.isRunning { started = false } // stopped under it - Siri, a call - so it starts again
    return start() && engine.isRunning
  }

  private func checkFinished() {
    guard playing != nil, let last = lastPiece, nextPiece > last, outstanding == 0 else { return }
    endPlayback(finished: true)
  }

  private func endPlayback(finished: Bool) {
    let was = output
    playing = nil
    pieces.removeAll()
    inFlight.removeAll()
    lastPiece = nil
    outstanding = 0
    output = player
    onLevel(0)
    if away { letGo() } else if was === speakerPlayer { stopSpeaker() }
    if finished { onFinished() }
    onPlaying(false)
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

  /// Silence, for as long as asked.
  static func silence(_ format: AVAudioFormat, seconds: Double) -> AVAudioPCMBuffer? {
    let frames = AVAudioFrameCount(format.sampleRate * seconds)
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames), let samples = buffer.floatChannelData?[0] else { return nil }
    buffer.frameLength = frames
    samples.update(repeating: 0, count: Int(frames))
    return buffer
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
