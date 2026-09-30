import Foundation
import FoundationModels

// Nova's Apple model helper: Apple Intelligence's on-device model answering Nova's open questions.
// The daemon writes one JSON object per line to stdin, and events come back on stdout the same way:
//   status                                   -> status {available, reason?, model?, contextSize, vision?, language}
//   warm {instructions}                      loads the model ahead of a question
//   ask {id, instructions, history, context?, prompt, tools, act?, maxTokens?}
//                                            -> text {id, text} ... tool-call {id, call, name, arguments} ... done | error {code}
//   tool-result {id, call, text, image?}     what a tool call did
//   cancel {id}                              stops a question
// One question at a time: a new one stops the last.

actor Answers {
  private var running: (id: String, task: Task<Void, Never>)?
  /// A session kept after warming, so the model stays loaded until the question comes.
  private var warmed: LanguageModelSession?
  private let calls = Calls()

  func handle(_ command: [String: Any]) {
    switch command["type"] as? String {
    case "status":
      emit(Status.now())
    case "warm":
      guard case .available = SystemLanguageModel.default.availability else { return }
      let session = LanguageModelSession(instructions: Instructions(command["instructions"] as? String ?? ""))
      session.prewarm()
      warmed = session
    case "ask":
      guard let id = command["id"] as? String else { return }
      running?.task.cancel()
      let question = Question(command, id: id, calls: calls)
      running = (id, Task { await question.answer() })
    case "tool-result":
      guard let call = command["call"] as? String else { return }
      calls.deliver(call, Reply(command))
    case "cancel":
      guard let id = command["id"] as? String, running?.id == id else { return }
      running?.task.cancel()
      running = nil
    default:
      break
    }
  }
}

let answers = Answers()
let (commands, sink) = AsyncStream<[String: Any]>.makeStream(bufferingPolicy: .unbounded)

/// Reads stdin on its own thread, one line at a time. Only a newline ends a line: text may hold
/// other line separators (U+2028) that JSON leaves as they are.
let reader = Thread {
  var buffer = Data()
  var chunk = [UInt8](repeating: 0, count: 1 << 16)
  while true {
    let count = read(0, &chunk, chunk.count)
    if count <= 0 { break }
    buffer.append(contentsOf: chunk[0..<count])
    while let end = buffer.firstIndex(of: 0x0a) {
      let line = buffer[buffer.startIndex..<end]
      buffer.removeSubrange(buffer.startIndex...end)
      if let command = try? JSONSerialization.jsonObject(with: line) as? [String: Any] { sink.yield(command) }
    }
  }
  sink.finish() // the daemon went away
}
reader.start()

Task {
  for await command in commands { await answers.handle(command) }
  exit(0)
}
dispatchMain()
