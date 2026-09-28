import AVFoundation
import CoreML
import FluidAudio
import Foundation

/// Who is speaking: a voiceprint - 256 numbers, unit length - of up to 10 s of 16 kHz speech, from
/// WeSpeaker v2 on the Neural Engine (through FluidAudio). The daemon compares it with the user's own,
/// kept on this Mac; nothing here knows who anyone is.
final class VoicePrinter {
  static let rate = 16_000
  /// The model hears a 10 s window at most: the latest part of a longer turn.
  static let window = 160_000
  private let extractor: EmbeddingExtractor
  /// The mask's length per window: the frames the model was made for, read from the model itself.
  private let frames: Int

  init(directory: URL) throws {
    let config = MLModelConfiguration()
    config.computeUnits = .all
    let model = try MLModel(contentsOf: directory.appendingPathComponent("wespeaker_v2.mlmodelc"), configuration: config)
    extractor = EmbeddingExtractor(embeddingModel: model)
    frames = model.modelDescription.inputDescriptionsByName["mask"]?.multiArrayConstraint?.shape.last?.intValue ?? 589
  }

  /// The voiceprint of this speech - all of it one speaker's - or nil when there's too little to tell (under half a second).
  func voiceprint(_ samples: [Float]) throws -> [Float]? {
    guard samples.count >= VoicePrinter.rate / 2 else { return nil }
    let clip = Array(samples.suffix(VoicePrinter.window))
    let mask = [Float](repeating: 1, count: frames)
    guard let raw = try extractor.getEmbeddings(audio: clip, masks: [mask]).first else { return nil }
    let norm = raw.reduce(0) { $0 + $1 * $1 }.squareRoot()
    return norm > 0 ? raw.map { $0 / norm } : nil
  }

  static func cosine(_ a: [Float], _ b: [Float]) -> Float {
    zip(a, b).reduce(0) { $0 + $1.0 * $1.1 }
  }
}

/// `--voice-selftest <models folder>`: speech from two of macOS's own voices, two sentences each - the same
/// voice must come out closer to itself than to the other. Needs no microphone and no person.
enum VoiceSelfTest {
  static func run(models: String) -> [String: Any] {
    do {
      let printer = try VoicePrinter(directory: URL(fileURLWithPath: models))
      let voices = pickVoices()
      guard voices.count == 2 else { return ["ok": false, "error": "fewer than two English voices installed"] }
      let lines = ["The weather today should be bright with a light breeze in the afternoon.", "Please remind me to call my sister when I get home tonight."]
      var prints: [String: [Float]] = [:]
      for voice in voices {
        for (i, line) in lines.enumerated() {
          guard let print = try printer.voiceprint(try speak(line, voice: voice)) else { return ["ok": false, "error": "no voiceprint for \(voice)"] }
          prints["\(voice)\(i)"] = print
        }
      }
      let (a, b) = (voices[0], voices[1])
      let same = [VoicePrinter.cosine(prints["\(a)0"]!, prints["\(a)1"]!), VoicePrinter.cosine(prints["\(b)0"]!, prints["\(b)1"]!)]
      let other = [VoicePrinter.cosine(prints["\(a)0"]!, prints["\(b)0"]!), VoicePrinter.cosine(prints["\(a)1"]!, prints["\(b)1"]!)]
      let ok = same.min()! > other.max()! + 0.1
      return ["ok": ok, "voices": voices, "same": same, "other": other]
    } catch {
      return ["ok": false, "error": error.localizedDescription]
    }
  }

  private static func pickVoices() -> [String] {
    let preferred = ["Daniel", "Samantha", "Karen", "Moira", "Rishi", "Tessa"]
    let out = (try? run("/usr/bin/say", ["-v", "?"])) ?? ""
    let installed = Set(out.split(separator: "\n").compactMap { $0.split(separator: " ").first.map(String.init) })
    return Array(preferred.filter(installed.contains).prefix(2))
  }

  private static func speak(_ text: String, voice: String) throws -> [Float] {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("nova-voice-\(voice)-\(UUID().uuidString).wav")
    defer { try? FileManager.default.removeItem(at: url) }
    _ = try run("/usr/bin/say", ["-v", voice, "-o", url.path, "--file-format=WAVE", "--data-format=LEI16@16000", text])
    let file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false)
    guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)) else { return [] }
    try file.read(into: buffer)
    return Array(UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength)))
  }

  private static func run(_ path: String, _ args: [String]) throws -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = args
    let pipe = Pipe()
    process.standardOutput = pipe
    try process.run()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return String(decoding: data, as: UTF8.self)
  }
}
