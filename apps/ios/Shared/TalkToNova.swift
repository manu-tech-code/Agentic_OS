import AppIntents

/// Nova opens and listens - as if its talk button were tapped, so it hears the end when you pause. For Siri, the
/// Action button and the control in Control Center. It's in both the app and its widgets, so a control can run it;
/// iOS opens the app to do it, and the app says what doing it means (`listen`).
struct TalkToNova: AppIntent {
  static let title: LocalizedStringResource = "Talk to Nova"
  static let description = IntentDescription("Opens Nova, listening: say what you want, and it hears the end when you pause. Put it on the Action button to talk to Nova with one press.")
  static let supportedModes: IntentModes = .foreground(.immediate)
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  /// What the app does when it's run: set as the app starts (the widgets never run it themselves).
  @MainActor static var listen: () -> Void = {}

  @MainActor
  func perform() async throws -> some IntentResult {
    Self.listen()
    return .result()
  }
}
