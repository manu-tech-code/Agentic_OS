import AVFoundation
import Speech

/// Apple's recognizer on the iPhone (SpeechAnalyzer): what's said into the phone is turned into text here
/// when the Mac can't hear it - a weak connection, the Mac's own hearing off, or Settings on the Mac says
/// so. Only the text goes to the Mac. One session per turn, as the Mac's hearing helper does.
final class PhoneHearing {
  /// The words so far, as they come.
  var onPartial: (String) -> Void = { _ in }

  private static let format = Voice.sendFormat
  private var analyzer: SpeechAnalyzer?
  private var input: AsyncStream<AnalyzerInput>.Continuation?
  private var results: Task<Void, Never>?
  private var pieces: [String] = []
  private var guess = ""
  private var fed: Int64 = 0

  /// Whether Apple's speech model for this language is on the iPhone (it's never downloaded behind the user's back).
  static func ready(_ language: String) async -> Bool {
    guard SpeechTranscriber.isAvailable, let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: language)) else { return false }
    return await SpeechTranscriber.installedLocales.contains { $0.identifier == locale.identifier }
  }

  /// Download Apple's speech model for this language onto the iPhone - when the user asks.
  static func install(_ language: String) async throws {
    guard SpeechTranscriber.isAvailable, let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: language)) else {
      throw PhoneHearingError("Apple's recognizer doesn't hear \(language) on this iPhone.")
    }
    let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      try await request.downloadAndInstall()
    }
  }

  /// A turn begins: a fresh session hears it.
  func start(language: String) async throws {
    await cancel()
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: language)) else {
      throw PhoneHearingError("Apple's recognizer doesn't hear \(language) on this iPhone.")
    }
    let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults], attributeOptions: [])
    let analyzer = SpeechAnalyzer(modules: [transcriber], options: .init(priority: .userInitiated, modelRetention: .whileInUse))
    let (stream, input) = AsyncStream<AnalyzerInput>.makeStream()
    try await analyzer.prepareToAnalyze(in: Self.format)
    try await analyzer.start(inputSequence: stream)
    self.analyzer = analyzer
    self.input = input
    pieces = []
    guess = ""
    fed = 0
    results = Task { [weak self] in
      do {
        for try await result in transcriber.results {
          let text = String(result.text.characters)
          await MainActor.run {
            guard let self else { return }
            if result.isFinal {
              self.pieces.append(text)
              self.guess = ""
            } else {
              self.guess = text
            }
            self.onPartial(self.text)
          }
        }
      } catch {
        // the session ended; what was heard stays
      }
    }
  }

  /// 20 ms of the microphone: 16 kHz 16-bit PCM, as the Mac would get it.
  func feed(_ pcm: Data) {
    let count = pcm.count / 2
    guard let input, count > 0, let buffer = AVAudioPCMBuffer(pcmFormat: Self.format, frameCapacity: AVAudioFrameCount(count)), let out = buffer.int16ChannelData?[0] else { return }
    buffer.frameLength = AVAudioFrameCount(count)
    pcm.withUnsafeBytes { raw in
      for i in 0..<count { out[i] = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self)) }
    }
    input.yield(AnalyzerInput(buffer: buffer, bufferStartTime: CMTime(value: fed, timescale: 16_000)))
    fed += Int64(count)
  }

  /// The turn ended: its last words settle, and this is what was said.
  func finish() async -> String {
    input?.finish()
    try? await analyzer?.finalizeAndFinishThroughEndOfInput()
    await results?.value
    let said = text
    analyzer = nil
    input = nil
    results = nil
    return said
  }

  func cancel() async {
    input?.finish()
    await analyzer?.cancelAndFinishNow()
    results?.cancel()
    analyzer = nil
    input = nil
    results = nil
  }

  private var text: String {
    (pieces + [guess]).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " ")
  }
}

struct PhoneHearingError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}
