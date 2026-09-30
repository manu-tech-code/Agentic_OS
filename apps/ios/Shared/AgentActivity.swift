import ActivityKit
import AppIntents
import Foundation

/// An agent's task on the Lock Screen and in the Dynamic Island. (Compiled into both the app, which starts and updates
/// it, and its widgets, which draw it.)
struct AgentActivity: ActivityAttributes {
  /// What changes as the agent works, as the app last heard it from the Mac.
  struct ContentState: Codable, Hashable {
    /// running, done, failed or cancelled.
    var status: String
    /// What it's doing now: "running the tests".
    var step: String?
    /// What it found or did, once it's done.
    var report: String?
    var ended: Date?
    /// When the app last heard about it: with no push, what's shown can be this old.
    var heard: Date
  }

  var taskId: String
  /// "Claude".
  var agent: String
  var project: String
  var task: String
  var started: Date
}

/// Stop an agent's task from its Live Activity. A Live Activity intent runs in the app - started in the background if
/// need be - and the app asks the Mac, as the task board's Stop does.
struct StopAgentTask: LiveActivityIntent {
  static let title: LocalizedStringResource = "Stop an Agent's Task"
  static let description = IntentDescription("Stops the task an agent is working on for Nova, from its Live Activity.")
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  /// Only from the activity's button.
  static let isDiscoverable = false

  @Parameter(title: "Task")
  var taskId: String

  init() {}

  init(taskId: String) {
    self.taskId = taskId
  }

  /// What the app does with it: set as it starts (the widgets never run it themselves).
  @MainActor static var stop: (String) async -> Void = { _ in }

  @MainActor
  func perform() async throws -> some IntentResult {
    await Self.stop(taskId)
    return .result()
  }
}
