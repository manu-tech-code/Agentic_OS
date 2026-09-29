import ServiceManagement

/// Opening Nova at login: macOS's own switch for it (also in System Settings → General → Login Items).
enum LoginItem {
  /// How it stands, without changing it.
  static func current() -> String {
    switch SMAppService.mainApp.status {
    case .enabled: return "on"
    case .requiresApproval: return "needs-approval"
    default: return "off"
    }
  }

  /// Turn it on or off, and say how it stands: "on", "off", "needs-approval" or "error" (with why).
  static func apply(_ on: Bool) -> (state: String, message: String?) {
    let service = SMAppService.mainApp
    var message: String?
    do {
      switch (on, service.status) {
      case (true, .notRegistered), (true, .notFound): try service.register()
      case (false, .enabled), (false, .requiresApproval): try service.unregister()
      default: break
      }
    } catch {
      message = error.localizedDescription
    }
    switch service.status {
    case .enabled: return ("on", nil)
    case .requiresApproval: return ("needs-approval", nil)
    default: return (on ? "error" : "off", on ? (message ?? "macOS didn't add it") : nil)
    }
  }
}
