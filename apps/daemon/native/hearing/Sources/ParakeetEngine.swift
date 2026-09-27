import FluidAudio
import Foundation

/// NVIDIA Parakeet TDT 0.6B v2 on the Neural Engine (through FluidAudio): the most accurate
/// open model in noise. It transcribes a turn's audio when asked, plus a draft every so often
/// while the user is still talking.
final class ParakeetEngine: Engine {
  private let asr: AsrManager
  private let lock = NSLock()
  /// Audio since shortly before the current turn (or the last second, between turns).
  private var samples: [Float] = []
  /// The audio position of samples[0].
  private var bufferStart: Int64 = 0
  private var fed: Int64 = 0
  /// Where the current turn began (just before speech was detected), if one is open.
  private var turnFrom: Int64?
  private var speaking = false
  private var draft: Task<Void, Never>?
  private var draftedAt: Int64 = 0

  private static let rate: Int64 = 16000
  private static let preRoll: Int64 = 4800  // 0.3 s kept from before speech was detected
  private static let draftEvery: Int64 = 11200  // a draft each 0.7 s of speech

  private init(asr: AsrManager) {
    self.asr = asr
  }

  static func make(modelDir: String) async throws -> ParakeetEngine {
    let models = try AsrModels.loadLocal(from: URL(fileURLWithPath: modelDir), version: .v2)
    let asr = AsrManager(config: .default, models: models)
    guard await asr.isAvailable else { throw HelperError("Parakeet's models didn't load.") }
    let engine = ParakeetEngine(asr: asr)
    _ = try? await engine.transcribe([Float](repeating: 0, count: 16000)) // warm up, so the first turn is quick
    return engine
  }

  /// One transcription, from its own decoder state (each is a separate utterance).
  private func transcribe(_ audio: [Float]) async throws -> String {
    var state = TdtDecoderState.make(decoderLayers: AsrModelVersion.v2.decoderLayers)
    return try await asr.transcribe(padded(audio), decoderState: &state).text
  }

  func audio(_ incoming: [Int16]) {
    lock.withLock {
      samples.append(contentsOf: incoming.map { Float($0) / 32768 })
      fed += Int64(incoming.count)
      // Between turns only the pre-roll matters; during one, up to a minute. Trimmed a second at a time.
      let keep = turnFrom == nil ? Self.rate : Self.rate * 60
      if Int64(samples.count) > keep + Self.rate {
        let drop = samples.count - Int(keep)
        samples.removeFirst(drop)
        bufferStart += Int64(drop)
      }
      guard speaking, turnFrom != nil, draft == nil, fed - draftedAt >= Self.draftEvery else { return }
      draftedAt = fed
      let audio = turnAudio()
      if audio.count >= 8000 { draft = Task { [weak self] in await self?.makeDraft(audio) } }
    }
  }

  private func makeDraft(_ audio: [Float]) async {
    let text = try? await transcribe(audio)
    let open = lock.withLock {
      draft = nil
      return turnFrom != nil
    }
    if open, let text, !text.isEmpty { emit(["type": "partial", "text": text]) }
  }

  /// The current turn's audio. Call with the lock held.
  private func turnAudio() -> [Float] {
    guard let from = turnFrom else { return [] }
    let start = Int(max(0, from - bufferStart))
    return start < samples.count ? Array(samples[start...]) : []
  }

  func speech(active: Bool, atMs: Int) {
    lock.withLock {
      speaking = active
      if active && turnFrom == nil {
        // Positions count from this helper's start; one past what it has heard (never sent by a
        // daemon that counts right) still starts the turn at the audio that's here.
        turnFrom = min(max(bufferStart, Int64(atMs) * 16 - Self.preRoll), max(bufferStart, fed - Self.preRoll))
        draftedAt = fed
      }
    }
  }

  func finalize(turn: Int) -> () async -> Void {
    // The turn's audio is taken now; the next turn can begin while this one is transcribed.
    let (audio, pending) = lock.withLock {
      defer {
        turnFrom = nil
        speaking = false
      }
      return (turnAudio(), draft)
    }
    return { [self] in
      let started = Date()
      await pending?.value // a draft still being written goes first (the model does one thing at a time)
      var text = ""
      if audio.count >= 1600 {
        do {
          text = try await transcribe(audio)
        } catch {
          emit(["type": "error", "message": "Parakeet couldn't transcribe: \(error.localizedDescription)", "fatal": false])
        }
      }
      emit(["type": "final", "turn": turn, "text": joinText([text]), "ms": Int(Date().timeIntervalSince(started) * 1000)])
    }
  }

  func cancelTurn(atMs: Int?) {
    lock.withLock {
      turnFrom = nil
      speaking = false
    }
  }

  func setVocabulary(_ words: [String]) async {} // Parakeet takes no vocabulary hints

  /// At least a second of audio: very short clips are padded with silence.
  private func padded(_ audio: [Float]) -> [Float] {
    audio.count >= 16000 ? audio : audio + [Float](repeating: 0, count: 16000 - audio.count)
  }
}
