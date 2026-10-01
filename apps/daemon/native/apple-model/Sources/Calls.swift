import CoreGraphics
import Foundation
import FoundationModels
import ImageIO
import Synchronization

/// What a tool came back with: words, and sometimes a picture (the screen, when it looked).
struct Reply: @unchecked Sendable {
  var text: String
  var image: CGImage?

  /// A `tool-result` from the daemon: {"text": "...", "image": {"data": base64, "mimeType": "image/png"}}.
  init(_ command: [String: Any]) {
    text = command["text"] as? String ?? ""
    if let picture = command["image"] as? [String: Any], let base64 = picture["data"] as? String, let data = Data(base64Encoded: base64),
      let source = CGImageSourceCreateWithData(data as CFData, nil)
    {
      image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    }
  }
}

/// Tool calls waiting on the daemon, by call id. A question that's stopped stops waiting.
final class Calls: Sendable {
  private struct State {
    var waiting: [String: CheckedContinuation<Reply, Error>] = [:]
    /// Stopped before they started waiting.
    var stopped: Set<String> = []
    var seq = 0
  }
  private let state = Mutex(State())

  func next() -> String {
    state.withLock { s in
      s.seq += 1
      return "c\(s.seq)"
    }
  }

  func wait(for call: String) async throws -> Reply {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Reply, Error>) in
        let stopped = state.withLock { s in
          if s.stopped.remove(call) != nil { return true }
          s.waiting[call] = continuation
          return false
        }
        if stopped { continuation.resume(throwing: CancellationError()) }
      }
    } onCancel: {
      let continuation = state.withLock { s in
        let waiting = s.waiting.removeValue(forKey: call)
        if waiting == nil { s.stopped.insert(call) }
        return waiting
      }
      continuation?.resume(throwing: CancellationError())
    }
  }

  func deliver(_ call: String, _ reply: Reply) {
    state.withLock { $0.waiting.removeValue(forKey: call) }?.resume(returning: reply)
  }
}

/// A question's allowance: steps in the tools, and room left in the context window for what the
/// tools say. Words that don't fit are cut short, rather than the whole answer failing.
final class Budget: Sendable {
  private struct State {
    var room = 0
    var steps: Int
  }
  private let state: Mutex<State>

  init(steps: Int) {
    state = Mutex(State(steps: steps))
  }

  func setRoom(_ tokens: Int) {
    state.withLock { $0.room = max(0, tokens) }
  }

  /// One more step, if any are left.
  func step() -> Bool {
    state.withLock { s in
      guard s.steps > 0 else { return false }
      s.steps -= 1
      return true
    }
  }

  /// A tool's words, cut to what's left of the room (a picture takes its share first).
  func fit(_ text: String, picture: Bool) async -> String {
    let overhead = callTokens + (picture ? pictureTokens : 0)
    let needed = await tokens(text) + overhead
    let room = state.withLock { s in
      let room = s.room
      s.room = max(0, s.room - needed)
      return room
    }
    if needed <= room { return text }
    let keep = text.count * max(0, room - overhead) / max(needed - overhead, 1)
    return keep < 80 ? "(What this said was too long to take in here.)" : "\(text.prefix(keep)) …(cut short)"
  }
}

/// One of Nova's tools as the model sees it. Its calls go to the daemon, which runs them with
/// Nova's rules - asking the user first when one changes something - and says what happened.
struct NovaTool: Tool {
  typealias Arguments = GeneratedContent
  typealias Output = Prompt

  let name: String
  let description: String
  let parameters: GenerationSchema
  let question: String
  let budget: Budget
  let calls: Calls

  func call(arguments: GeneratedContent) async throws -> Prompt {
    guard budget.step() else { return Prompt("That's enough steps: answer the user now, with what you have.") }
    let call = calls.next()
    let args = (try? JSONSerialization.jsonObject(with: Data(arguments.jsonString.utf8))) ?? [String: Any]()
    debug("\(question) \(call): \(name) \(arguments.jsonString)")
    emit(["type": "tool-call", "id": question, "call": call, "name": name, "arguments": args])
    let reply = try await calls.wait(for: call)
    let text = await budget.fit(reply.text, picture: reply.image != nil)
    if #available(macOS 27, *), let image = reply.image {
      return Prompt {
        text
        Attachment(image)
      }
    }
    return Prompt(text)
  }
}
