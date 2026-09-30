import AppIntents
import SwiftUI

// Nova for Siri, Shortcuts, Spotlight and the Action button. These are App Intents, which a free Apple account
// allows (SiriKit's own entitlement it doesn't): Siri knows them by the phrases in `NovaShortcuts`, with no setup.
// Each runs in this app - in the background unless it's there to listen - and asks the Mac as the app does, so
// the Mac's rules apply to it as to anything said into this phone. Nova's answers are shown, and said in Nova's
// own voice from this iPhone: never in Siri's.

/// Ask Nova anything, as you would out loud: "Hey Siri, ask Nova", then what you want.
struct AskNova: AppIntent {
  static let title: LocalizedStringResource = "Ask Nova"
  static let description = IntentDescription("Ask Nova on your Mac anything - a question, or something to do. The answer is shown here and said in Nova's voice.")
  /// In the background; when Nova asks something back, it goes on in Nova, which listens for the answer.
  static let supportedModes: IntentModes = [.background, .foreground(.dynamic)]
  /// Only the phone's owner: a locked phone asks for Face ID first (its key to the Mac needs it unlocked anyway).
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @Parameter(title: "Request", requestValueDialog: "What should I ask Nova?")
  var request: String

  static var parameterSummary: some ParameterSummary {
    Summary("Ask Nova \(\.$request)")
  }

  init() {}

  init(request: String) {
    self.request = request
  }

  @MainActor
  func perform() async throws -> some IntentResult & ReturnsValue<String> & ShowsSnippetView {
    try await NovaAnswers.ask(request, intent: self)
  }
}

/// The morning briefing, whenever: what's on today, the weather, reminders, and what agents did.
struct NovaBriefing: AppIntent {
  static let title: LocalizedStringResource = "Nova's Briefing"
  static let description = IntentDescription("Nova's briefing: what's on today, the weather, your reminders, and what your agents did.")
  static let supportedModes: IntentModes = [.background, .foreground(.dynamic)]
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @MainActor
  func perform() async throws -> some IntentResult & ReturnsValue<String> & ShowsSnippetView {
    try await NovaAnswers.ask("brief me", intent: self, shown: "Brief me")
  }
}

/// How the agents' tasks are going.
struct NovaAgents: AppIntent {
  static let title: LocalizedStringResource = "What Nova's Agents Are Doing"
  static let description = IntentDescription("How the tasks you gave Nova's agents are going: what's still running, and what they found.")
  static let supportedModes: IntentModes = [.background, .foreground(.dynamic)]
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @MainActor
  func perform() async throws -> some IntentResult & ReturnsValue<String> & ShowsSnippetView {
    try await NovaAnswers.ask("what are the agents doing", intent: self, shown: "What are the agents doing?")
  }
}

/// The reminders coming up.
struct NovaReminders: AppIntent {
  static let title: LocalizedStringResource = "Nova's Reminders"
  static let description = IntentDescription("The reminders you asked Nova for that are still coming up.")
  static let supportedModes: IntentModes = [.background, .foreground(.dynamic)]
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @MainActor
  func perform() async throws -> some IntentResult & ReturnsValue<String> & ShowsSnippetView {
    try await NovaAnswers.ask("what are my reminders", intent: self, shown: "What are my reminders?")
  }
}

/// Stop everything, as the Stop button: Nova stops speaking and thinking, agents' tasks stop, questions are withdrawn.
struct StopNova: AppIntent {
  static let title: LocalizedStringResource = "Stop Nova"
  static let description = IntentDescription("Nova stops everything: what it's saying and thinking, your agents' tasks, and the questions it's waiting on.")
  static let supportedModes: IntentModes = .background
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @MainActor
  func perform() async throws -> some IntentResult & ShowsSnippetView {
    let nova = Nova.shared
    let answer = await nova.stopEverything()
    return .result(view: AnswerView(answer: answer, name: nova.name))
  }
}

/// What Siri knows without being taught: each needs the app's name in it ("Nova", or what the app is called).
struct NovaShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AskNova(),
      phrases: ["Ask \(.applicationName)", "Ask \(.applicationName) something", "Ask \(.applicationName) a question", "Tell \(.applicationName) something", "Get \(.applicationName) to do something"],
      shortTitle: "Ask Nova",
      systemImageName: "sparkles")
    AppShortcut(
      intent: TalkToNova(),
      phrases: ["Talk to \(.applicationName)", "Start talking to \(.applicationName)", "Open \(.applicationName) and listen"],
      shortTitle: "Talk",
      systemImageName: "waveform")
    AppShortcut(
      intent: NovaBriefing(),
      phrases: ["\(.applicationName) brief me", "Brief me with \(.applicationName)", "Get my briefing from \(.applicationName)", "What's my day like, \(.applicationName)"],
      shortTitle: "Briefing",
      systemImageName: "sun.horizon")
    AppShortcut(
      intent: NovaAgents(),
      phrases: ["What are \(.applicationName)'s agents doing", "Check on \(.applicationName)'s agents", "How are my \(.applicationName) tasks going"],
      shortTitle: "Agents",
      systemImageName: "asterisk")
    AppShortcut(
      intent: NovaReminders(),
      phrases: ["What are my \(.applicationName) reminders", "Read my \(.applicationName) reminders"],
      shortTitle: "Reminders",
      systemImageName: "bell")
    AppShortcut(
      intent: StopNova(),
      phrases: ["Stop \(.applicationName)", "Tell \(.applicationName) to stop", "\(.applicationName) stop everything"],
      shortTitle: "Stop",
      systemImageName: "stop.fill")
  }

  static let shortcutTileColor: ShortcutTileColor = .navy
}

/// Asking Nova from an intent: the answer as the intent's result - and, when Nova asks something back, Nova comes to
/// the front to hear the answer (or, for what only a tap allows, to show Allow with Face ID).
enum NovaAnswers {
  @MainActor
  static func ask(_ request: String, intent: some AppIntent, shown: String? = nil) async throws -> some IntentResult & ReturnsValue<String> & ShowsSnippetView {
    let nova = Nova.shared
    var answer = await nova.ask(request)
    if let shown { answer.heard = shown }
    if answer.asks, !answer.failed, intent.systemContext.currentMode.canContinueInForeground {
      do {
        // Siri's own words, if it asks before opening Nova: why Nova is opening.
        let why = answer.tap ? "To allow it, open \(nova.name) and use Face ID." : "\(nova.name) is asking you something. Answer it in \(nova.name)."
        try await intent.continueInForeground(IntentDialog(stringLiteral: why), alwaysConfirm: false)
        if !answer.tap { nova.listenSoon() }
      } catch {
        // Not now (the user said no, or it can't open here): the question stays on the answer.
      }
    }
    return .result(value: answer.text, view: AnswerView(answer: answer, name: nova.name))
  }
}
