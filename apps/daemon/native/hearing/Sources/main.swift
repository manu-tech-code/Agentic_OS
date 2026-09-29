import Foundation

// Nova's hearing helper. The daemon writes frames to stdin - [type: 1 byte][length: 4 bytes,
// little endian][payload] - where type 1 is 16 kHz mono 16-bit PCM and type 2 a JSON command.
// Events come back on stdout, one JSON object per line.

if let i = CommandLine.arguments.firstIndex(of: "--voice-selftest"), i + 1 < CommandLine.arguments.count {
  let result = VoiceSelfTest.run(models: CommandLine.arguments[i + 1])
  print(String(decoding: try! JSONSerialization.data(withJSONObject: result), as: UTF8.self))
  exit(result["ok"] as? Bool == true ? 0 : 1)
}

enum Message {
  case audio([Int16])
  case command([String: Any])
}

let (messages, sink) = AsyncStream<Message>.makeStream(bufferingPolicy: .unbounded)

/// Reads stdin on its own thread, so audio never waits on recognition.
let reader = Thread {
  func readExactly(_ count: Int) -> Data? {
    var data = Data(count: count)
    var got = 0
    while got < count {
      let n = data.withUnsafeMutableBytes { buf in read(0, buf.baseAddress!.advanced(by: got), count - got) }
      if n <= 0 { return nil }
      got += n
    }
    return data
  }
  while let header = readExactly(5) {
    let length = Int(UInt32(header[1]) | UInt32(header[2]) << 8 | UInt32(header[3]) << 16 | UInt32(header[4]) << 24)
    guard let payload = length > 0 ? readExactly(length) : Data() else { break }
    if header[0] == 1 {
      var samples = [Int16](repeating: 0, count: payload.count / 2)
      _ = samples.withUnsafeMutableBytes { payload.copyBytes(to: $0) }
      sink.yield(.audio(samples))
    } else if header[0] == 2, let command = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] {
      sink.yield(.command(command))
    }
  }
  sink.finish() // the daemon went away
}
reader.start()

func startEngine(_ command: [String: Any]) async throws -> Engine {
  let words = command["vocabulary"] as? [String] ?? []
  switch command["engine"] as? String {
  case "apple":
    return try await AppleEngine.make(locale: command["locale"] as? String ?? "en_US", vocabulary: words)
  case "parakeet":
    guard let dir = command["modelDir"] as? String else { throw HelperError("Parakeet needs its model folder.") }
    return try await ParakeetEngine.make(modelDir: dir)
  default:
    throw HelperError("Unknown engine \(command["engine"] ?? "(none)").")
  }
}

/// Voiceprints for Voice ID: one at a time, off the audio path, the model loaded on first use.
let voiceQueue = DispatchQueue(label: "nova.hearing.voice")
var printer: VoicePrinter?
var printerFrom = ""

func voiceprint(_ command: [String: Any]) {
  let id = command["id"] ?? NSNull()
  guard let models = command["models"] as? String, let pcm = (command["pcm"] as? String).flatMap({ Data(base64Encoded: $0) }) else {
    return emit(["type": "voiceprint", "id": id, "error": "no model folder or audio"])
  }
  voiceQueue.async {
    do {
      if printer == nil || printerFrom != models {
        printer = try VoicePrinter(directory: URL(fileURLWithPath: models))
        printerFrom = models
      }
      var samples = [Int16](repeating: 0, count: pcm.count / 2)
      _ = samples.withUnsafeMutableBytes { pcm.copyBytes(to: $0) }
      let print = try printer!.voiceprint(samples.map { Float($0) / 32768 })
      emit(print.map { ["type": "voiceprint", "id": id, "print": $0] } ?? ["type": "voiceprint", "id": id, "error": "too short"])
    } catch {
      emit(["type": "voiceprint", "id": id, "error": error.localizedDescription])
    }
  }
}

var engine: Engine?
for await message in messages {
  switch message {
  case .audio(let samples):
    engine?.audio(samples)
  case .command(let command):
    switch command["type"] as? String {
    case "start":
      let started = Date()
      do {
        engine = try await startEngine(command)
        engine?.setWakeWords(command["wakeWords"] as? [String] ?? [])
        emit(["type": "ready", "engine": command["engine"] ?? "", "ms": Int(Date().timeIntervalSince(started) * 1000)])
      } catch {
        emit(["type": "error", "message": error.localizedDescription, "fatal": true])
      }
    case "speech":
      engine?.speech(active: command["active"] as? Bool ?? false, atMs: command["at"] as? Int ?? 0)
    case "finalize":
      // The turn is closed now; its text follows while audio keeps flowing (Apple's recognizer
      // needs a little audio past the end of a turn to settle its last words).
      if let finish = engine?.finalize(turn: command["turn"] as? Int ?? 0) { Task { await finish() } }
    case "cancel":
      engine?.cancelTurn(atMs: command["at"] as? Int)
    case "vocabulary":
      await engine?.setVocabulary(command["words"] as? [String] ?? [])
    case "wake":
      engine?.setWakeWords(command["words"] as? [String] ?? [])
    case "voiceprint":
      voiceprint(command)
    default:
      break
    }
  }
}
flushOutput()
exit(0)
