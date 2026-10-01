import Foundation
import FoundationModels

/// Room kept for the answer itself unless the daemon asks for other, and for the tools: their calls, and what they say.
let answerTokens = 600
let toolTokens = 1500
let callTokens = 60
let pictureTokens = 400
/// Steps a question may take in the tools before it has to answer.
let maxSteps = 6

/// Tokens as the model counts them (macOS 26.4 on), or a careful guess before that.
func tokens(_ text: String) async -> Int {
  if #available(macOS 26.4, *), let count = try? await SystemLanguageModel.default.tokenCount(for: text) { return count }
  return text.utf8.count / 3 + 1
}

func tokens(_ entries: [Transcript.Entry]) async -> Int {
  if #available(macOS 26.4, *), let count = try? await SystemLanguageModel.default.tokenCount(for: entries) { return count }
  return entries.reduce(0) { $0 + $1.description.utf8.count / 3 + 4 }
}

/// One open question: Nova's instructions, the conversation so far, what was asked, and the tools
/// Nova chose for it, best first - fitted into the model's context window, then answered as it's written.
///
/// The conversation comes as turns of the transcript (`history`), or written into the instructions as
/// context (`context`: a note, then each turn's lines). A small model copies its own past replies - ones
/// that say something was done, with no tool call in sight - so Nova sends a request to act with only
/// its last turns, and it must call a tool before it answers (`act`, from macOS 27).
struct Question {
  let id: String
  let instructions: String
  let history: [(user: String, nova: String)]
  let contextNote: String
  let context: [String]
  let prompt: String
  let specs: [[String: Any]]
  let maxTokens: Int
  let act: Bool
  let calls: Calls

  init(_ command: [String: Any], id: String, calls: Calls) {
    self.id = id
    instructions = command["instructions"] as? String ?? ""
    history = (command["history"] as? [[String: Any]] ?? []).compactMap { turn in
      guard let user = turn["user"] as? String, let nova = turn["nova"] as? String else { return nil }
      return (user, nova)
    }
    let context = command["context"] as? [String: Any]
    contextNote = context?["note"] as? String ?? ""
    self.context = context?["turns"] as? [String] ?? []
    prompt = command["prompt"] as? String ?? ""
    specs = command["tools"] as? [[String: Any]] ?? []
    maxTokens = command["maxTokens"] as? Int ?? answerTokens
    act = command["act"] as? Bool ?? false
    self.calls = calls
  }

  func answer() async {
    do {
      let model = SystemLanguageModel.default
      if case .unavailable(let reason) = model.availability { throw HelperError("unavailable", Status.code(reason)) }
      let budget = Budget(steps: maxSteps)
      let offered = specs.compactMap { spec -> NovaTool? in
        guard let name = spec["name"] as? String, let parameters = spec["parameters"] as? [String: Any] else { return nil }
        do {
          return NovaTool(
            name: name, description: spec["description"] as? String ?? "", parameters: try generationSchema(parameters, name: "\(name)_arguments"),
            question: id, budget: budget, calls: calls)
        } catch {
          debug("\(id): left out \(name) - \(error)")
          return nil
        }
      }
      let fit = try await fitted(model, tools: offered)
      budget.setRoom(model.contextSize - maxTokens - fit.used)
      var sent = ""
      let options = GenerationOptions(maximumResponseTokens: maxTokens)
      for try await snapshot in session(model, fit).streamResponse(to: Prompt(prompt), options: options) {
        let text = snapshot.content
        guard text.count > sent.count, text.hasPrefix(sent) else { continue }
        emit(["type": "text", "id": id, "text": String(text.dropFirst(sent.count))])
        sent = text
      }
      try Task.checkCancellation()
      emit(["type": "done", "id": id, "tools": fit.tools.map(\.name), "turns": fit.turns.count + fit.context.count])
    } catch {
      if Task.isCancelled { return debug("\(id): stopped") } // the daemon stopped it: there's no one to tell
      let (code, detail) = problem(error)
      debug("\(id): \(code) - \(detail)")
      emit(["type": "error", "id": id, "code": code, "detail": detail])
    }
  }

  private struct Fit {
    var instructions: String
    var turns: ArraySlice<(user: String, nova: String)>
    var context: ArraySlice<String>
    var tools: [NovaTool]
    var used: Int
  }

  /// What the question is answered from. What doesn't fit goes - the oldest turns first, then the
  /// tools Nova ranked lowest - leaving room for the answer, and for the tools' calls and what they say.
  private func fitted(_ model: SystemLanguageModel, tools offered: [NovaTool]) async throws -> Fit {
    var fit = Fit(instructions: "", turns: history[...], context: context[...], tools: offered, used: 0)
    let asked = await tokens([.prompt(Transcript.Prompt(segments: [.text(.init(content: prompt))]))])
    while true {
      fit.instructions = fit.context.isEmpty ? instructions : "\(instructions)\n\(contextNote)\n\(fit.context.joined(separator: "\n"))"
      fit.used = await tokens(transcript(fit)) + asked
      if fit.used <= model.contextSize - maxTokens - (fit.tools.isEmpty ? 0 : toolTokens) { return fit }
      if !fit.turns.isEmpty {
        fit.turns = fit.turns.dropFirst()
      } else if !fit.context.isEmpty {
        fit.context = fit.context.dropFirst()
      } else if !fit.tools.isEmpty {
        fit.tools.removeLast()
      } else {
        throw HelperError("context", "\(fit.used) tokens")
      }
    }
  }

  private func session(_ model: SystemLanguageModel, _ fit: Fit) -> LanguageModelSession {
    if #available(macOS 27, *) {
      return LanguageModelSession(profile: Acting(instructions: fit.instructions, tools: fit.tools, act: act && !fit.tools.isEmpty), history: transcript(fit).dropFirst())
    }
    return LanguageModelSession(model: model, tools: fit.tools, transcript: Transcript(entries: transcript(fit)))
  }

  /// The instructions (with the tools), then each turn of the conversation that goes as turns.
  private func transcript(_ fit: Fit) -> [Transcript.Entry] {
    var entries: [Transcript.Entry] = [
      .instructions(Transcript.Instructions(segments: [.text(.init(content: fit.instructions))], toolDefinitions: fit.tools.map { Transcript.ToolDefinition(tool: $0) }))
    ]
    for turn in fit.turns {
      entries.append(.prompt(Transcript.Prompt(segments: [.text(.init(content: turn.user))])))
      entries.append(.response(Transcript.Response(assetIDs: [], segments: [.text(.init(content: turn.nova))])))
    }
    return entries
  }
}

@available(macOS 27, *)
extension SessionPropertyValues {
  /// The tool calls made so far in answering a question.
  @SessionPropertyEntry var novaToolCalls: Int = 0
}

/// A question's session on macOS 27: its instructions and tools - and, for a request to act, a tool
/// call before any answer (then it may answer, or call more).
@available(macOS 27, *)
struct Acting: LanguageModelSession.DynamicProfile {
  let instructions: String
  let tools: [any Tool]
  let act: Bool
  @LanguageModelSession.SessionProperty(\.novaToolCalls) var toolCalls

  var body: some LanguageModelSession.DynamicProfile {
    Profile {
      Instructions(instructions)
      tools
    }
    .toolCallingMode(act && toolCalls < 1 ? .required : .allowed)
    .onToolCall { toolCalls += 1 }
  }
}

/// Why a question failed, as a code the daemon puts into words - and the framework's own account, for its log.
func problem(_ error: Error) -> (code: String, detail: String) {
  let detail = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
  if let error = error as? HelperError { return (error.code, error.message) }
  if let error = error as? LanguageModelSession.ToolCallError { return problem(error.underlyingError) }
  if let error = error as? LanguageModelSession.GenerationError {
    switch error {
    case .exceededContextWindowSize: return ("context", detail)
    case .guardrailViolation: return ("guardrail", detail)
    case .unsupportedLanguageOrLocale: return ("language", detail)
    case .assetsUnavailable: return ("unavailable", "downloading")
    case .rateLimited, .concurrentRequests: return ("busy", detail)
    default:
      if #available(macOS 27, *), case .refusal = error { return ("refusal", detail) }
    }
  }
  if #available(macOS 27, *), let error = error as? LanguageModelError {
    switch error {
    case .contextSizeExceeded: return ("context", detail)
    case .guardrailViolation: return ("guardrail", detail)
    case .refusal: return ("refusal", detail)
    case .unsupportedLanguageOrLocale: return ("language", detail)
    case .rateLimited: return ("busy", detail)
    case .timeout: return ("timeout", detail)
    default: break
    }
  }
  return ("failed", detail)
}
