import ActivityKit
import AppIntents
import Foundation

/// Nova thinking about, then saying, its answer to you - in the Dynamic Island (and on the Lock Screen) once you've left
/// it. (Compiled into both the app, which starts and ends it, and its widgets, which draw it.)
struct NovaVoiceActivity: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    /// thinking or speaking.
    var phase: String
    /// What Nova is saying - or, while it thinks, what you asked.
    var text: String
    /// While it speaks: how loud its voice is now, low to high pitch, 0-`top` each - the bars. Empty until it's heard.
    var levels: [Int] = []
  }

  /// A bar at full height.
  static let top = 8

  /// The assistant's name: "Nova".
  var name: String
}

/// Stop, on Nova speaking: it stops saying (or thinking about) that answer - not agents' tasks, as Stop everything would.
/// A Live Activity intent runs in the app, which tells the Mac.
struct StopNovaSpeaking: LiveActivityIntent {
  static let title: LocalizedStringResource = "Stop Nova Speaking"
  static let description = IntentDescription("Nova stops saying, or thinking about, its answer.")
  /// Only from the activity's button.
  static let isDiscoverable = false

  init() {}

  /// What the app does with it: set as it starts.
  @MainActor static var stop: () -> Void = {}

  @MainActor
  func perform() async throws -> some IntentResult {
    Self.stop()
    return .result()
  }
}
