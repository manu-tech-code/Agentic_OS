import AVFoundation
import Foundation
import Speech

/// Apple's on-device recognizer (SpeechAnalyzer): live text as the user speaks, no download
/// (the OS keeps the language models), and a vocabulary of names worth recognising.
///
/// Each turn gets a fresh recognizer session: one carried over from the last turn hears the next
/// in its light ("please. No, in my…" for "Nova, in my…"). A spare session waits, ready; when a
/// turn closes, audio moves to it at once and the old session settles its last words on its own.
final class AppleEngine: Engine {
  private final class Session {
    let transcriber: SpeechTranscriber
    let analyzer: SpeechAnalyzer
    let input: AsyncStream<AnalyzerInput>.Continuation
    var results: Task<Void, Never>?
    // Under the engine's lock:
    var pieces: [String] = []
    var guess = ""
    /// Text about audio before this point (murmurs before the turn began) is dropped.
    var from: Double = 0

    init(transcriber: SpeechTranscriber, analyzer: SpeechAnalyzer, input: AsyncStream<AnalyzerInput>.Continuation) {
      self.transcriber = transcriber
      self.analyzer = analyzer
      self.input = input
    }
  }

  private static let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
  private let locale: Locale

  // Under the lock: audio arrives on the message loop, results on each session's own task.
  private let lock = NSLock()
  private var fed: Int64 = 0
  private var current: Session?
  private var spare: Session?
  private var preparing = false
  /// Audio heard while no session was ready (two turns in quick succession), for the next one.
  private var backlog: [AnalyzerInput] = []
  private var shown = ""
  private var vocabulary: [String] = []
  private var wakeWords: [String] = []

  private init(locale: Locale, vocabulary: [String]) {
    self.locale = locale
    self.vocabulary = vocabulary
  }

  static func make(locale id: String, vocabulary: [String]) async throws -> AppleEngine {
    guard SpeechTranscriber.isAvailable else { throw HelperError("Apple's on-device speech recognition isn't available on this Mac.") }
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: id)) else {
      throw HelperError("Apple's recognizer doesn't support \(id).")
    }
    // Nova never downloads Apple's language models behind the user's back: they must already be on the Mac.
    let installed = await SpeechTranscriber.installedLocales
    guard installed.contains(where: { $0.identifier == locale.identifier }) else {
      throw HelperError("Apple's speech model for \(locale.identifier) isn't on this Mac. Turn on Dictation for that language in System Settings → Keyboard, or pick another language.")
    }
    let engine = AppleEngine(locale: locale, vocabulary: vocabulary)
    let first = try await engine.makeSession()
    engine.lock.withLock { engine.activate(first) }
    engine.spare = try await engine.makeSession()
    return engine
  }

  private func makeSession() async throws -> Session {
    let transcriber = SpeechTranscriber(
      locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults, .alternativeTranscriptions], attributeOptions: [.audioTimeRange])
    let analyzer = SpeechAnalyzer(modules: [transcriber], options: .init(priority: .userInitiated, modelRetention: .processLifetime))
    let (stream, input) = AsyncStream<AnalyzerInput>.makeStream()
    try await analyzer.prepareToAnalyze(in: Self.format)
    let words = lock.withLock { vocabulary }
    if !words.isEmpty {
      let context = AnalysisContext()
      context.contextualStrings[.general] = words
      try await analyzer.setContext(context)
    }
    try await analyzer.start(inputSequence: stream)
    let session = Session(transcriber: transcriber, analyzer: analyzer, input: input)
    session.results = Task { [weak self] in await self?.listen(session) }
    return session
  }

  /// Make this session the one hearing the user, starting now. Call with the lock held.
  private func activate(_ session: Session) {
    session.from = Double(fed) / 16000
    current = session
    shown = ""
    for input in backlog { session.input.yield(input) }
    backlog = []
  }

  /// Get a session ready: the current one if there's none, else the spare. Call with the lock held.
  private func prepare() {
    guard !preparing, current == nil || spare == nil else { return }
    preparing = true
    Task {
      let session = try? await makeSession()
      let again: Bool = lock.withLock {
        preparing = false
        if let session {
          if current == nil { activate(session) } else if spare == nil { spare = session } else { session.input.finish() }
        }
        return session != nil && (current == nil || spare == nil)
      }
      if session == nil { emit(["type": "error", "message": "Apple's recognizer couldn't start a new session.", "fatal": true]) }
      if again { lock.withLock { prepare() } }
    }
  }

  private func listen(_ session: Session) async {
    do {
      for try await result in session.transcriber.results {
        var text = String(result.text.characters)
        let wake = lock.withLock { wakeWords }
        // A wake word misheard ("No, open Slack"): take the alternative that has it.
        if result.isFinal, !wake.isEmpty, !mentions(text, any: wake),
          let heard = result.alternatives.first(where: { mentions(String($0.characters), any: wake) })
        {
          debug("wake word from an alternative: \(String(heard.characters)) (was: \(text))")
          text = String(heard.characters)
        }
        debug(String(format: "result %@ %.2f-%.2f %@", result.isFinal ? "FINAL" : "vol  ", result.range.start.seconds, result.range.end.seconds, text))
        let partial: String? = lock.withLock {
          if result.range.end.seconds <= session.from + 0.01 { return nil }
          if result.isFinal {
            session.pieces.append(text)
            session.guess = ""
          } else {
            session.guess = text
          }
          guard session === current else { return nil } // a closed turn settling its last words
          let partial = joinText(session.pieces + [session.guess])
          defer { shown = partial }
          return partial != shown ? partial : nil
        }
        if let partial { emit(["type": "partial", "text": partial]) }
      }
    } catch {
      if lock.withLock({ session === current }) {
        emit(["type": "error", "message": "Recognition stopped: \(error.localizedDescription)", "fatal": true])
      }
    }
  }

  func audio(_ samples: [Int16]) {
    guard !samples.isEmpty, let buffer = AVAudioPCMBuffer(pcmFormat: Self.format, frameCapacity: AVAudioFrameCount(samples.count)) else { return }
    buffer.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { buffer.int16ChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
    lock.withLock {
      let input = AnalyzerInput(buffer: buffer, bufferStartTime: CMTime(value: fed, timescale: 16000))
      fed += Int64(samples.count)
      if let current { current.input.yield(input) } else { backlog.append(input) }
    }
  }

  func speech(active: Bool, atMs: Int) {}

  func finalize(turn: Int) -> () async -> Void {
    debug("finalize turn \(turn) at \(lock.withLock { fed } / 16) ms")
    let closing: Session? = lock.withLock {
      let closing = current
      if let next = spare {
        spare = nil
        activate(next)
      } else {
        current = nil // audio waits in the backlog for the session being prepared
      }
      prepare()
      return closing
    }
    return {
      let started = Date()
      var text = ""
      if let closing {
        closing.input.finish()
        do {
          try await closing.analyzer.finalizeAndFinishThroughEndOfInput()
        } catch {
          emit(["type": "error", "message": "Couldn't finish the sentence: \(error.localizedDescription)", "fatal": false])
        }
        await closing.results?.value
        text = self.lock.withLock { joinText(closing.pieces + [closing.guess]) }
      }
      emit(["type": "final", "turn": turn, "text": text, "ms": Int(Date().timeIntervalSince(started) * 1000)])
    }
  }

  func cancelTurn(atMs: Int?) {
    debug("cancel at \(atMs ?? -1) ms (fed \(lock.withLock { fed } / 16) ms)")
    // Only the text so far is dropped (murmurs before the turn): the session keeps hearing, so the
    // turn's first word - spoken just before the speech detector noticed - isn't lost.
    lock.withLock {
      guard let current else { return }
      current.pieces = []
      current.guess = ""
      current.from = max(current.from, Double(min(fed, atMs.map { Int64($0) * 16 } ?? fed)) / 16000)
      shown = ""
    }
  }

  func setWakeWords(_ words: [String]) {
    lock.withLock { wakeWords = words.map { $0.lowercased() } }
  }

  func setVocabulary(_ words: [String]) async {
    let (sessions, list): ([Session], [String]) = lock.withLock {
      vocabulary = Array(Set(words)).sorted()
      return ([current, spare].compactMap { $0 }, vocabulary)
    }
    let context = AnalysisContext()
    context.contextualStrings[.general] = list
    for session in sessions {
      do {
        try await session.analyzer.setContext(context)
      } catch {
        emit(["type": "error", "message": "Couldn't set the vocabulary: \(error.localizedDescription)", "fatal": false])
      }
    }
  }
}
