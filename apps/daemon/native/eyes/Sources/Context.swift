import AppKit
import ApplicationServices

/// What the user is working in: the app in front, its window, the browser page, the selected text.
enum Context {
  /// Browsers whose page address can be asked for (each asks macOS once for permission).
  static let browsers: [String: String] = [
    "com.apple.Safari": "front document",
    "com.apple.SafariTechnologyPreview": "front document",
    "com.google.Chrome": "chromium",
    "com.microsoft.edgemac": "chromium",
    "com.brave.Browser": "chromium",
    "com.vivaldi.Vivaldi": "chromium",
    "company.thebrowser.Browser": "chromium",
  ]

  /// Nova's own apps: Nova.app, and Nova Eyes itself.
  static let novaApps: Set<String> = ["dev.nova.app", "dev.nova.eyes"]

  /// The apps activated most recently, newest last: when Nova's own window is in front, the one
  /// before it is what the user was working in.
  @MainActor static var recent: [NSRunningApplication] = []

  @MainActor static func watch() {
    if let front = NSWorkspace.shared.frontmostApplication { recent = [front] }
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
      guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
      MainActor.assumeIsolated {
        recent.removeAll { $0.processIdentifier == app.processIdentifier }
        recent.append(app)
        if recent.count > 4 { recent.removeFirst() }
      }
    }
  }

  @MainActor static func gather(skipTitles: [String]) -> [String: Any] {
    let first = describe(NSWorkspace.shared.frontmostApplication, skipTitles: skipTitles)
    guard first["isNova"] as? Bool == true else { return first }
    // The user switched to Nova to ask: say what they were doing before.
    let earlier = recent.dropLast().last(where: { $0.processIdentifier != NSWorkspace.shared.frontmostApplication?.processIdentifier && !$0.isTerminated })
    guard let earlier else { return first }
    var out = describe(earlier, skipTitles: skipTitles)
    out["before"] = true
    return out
  }

  @MainActor private static func describe(_ front: NSRunningApplication?, skipTitles: [String]) -> [String: Any] {
    var out: [String: Any] = ["permissions": Permissions.status()]
    guard let front else { return out }
    out["app"] = front.localizedName ?? ""
    out["bundleId"] = front.bundleIdentifier ?? ""
    if AXIsProcessTrusted() {
      let app = AXUIElementCreateApplication(front.processIdentifier)
      if let window = element(app, kAXFocusedWindowAttribute), let title = string(window, kAXTitleAttribute), !title.isEmpty {
        out["window"] = title
      }
      if let focused = element(app, kAXFocusedUIElementAttribute), let selected = string(focused, kAXSelectedTextAttribute),
        !selected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      {
        out["selection"] = String(selected.prefix(4000))
      }
    }
    if let id = front.bundleIdentifier, let kind = browsers[id] {
      // A busy browser gets two seconds to answer, so it can't hold Nova Eyes up.
      let ask =
        kind == "chromium"
        ? "tell application id \"\(id)\" to return {URL, title} of active tab of front window"
        : "tell application id \"\(id)\" to return {URL, name} of front document"
      let script = "with timeout of 2 seconds\n\(ask)\nend timeout"
      var error: NSDictionary?
      if let result = NSAppleScript(source: script)?.executeAndReturnError(&error), result.numberOfItems >= 2 {
        out["url"] = result.atIndex(1)?.stringValue ?? ""
        out["page"] = result.atIndex(2)?.stringValue ?? ""
      } else if let code = error?[NSAppleScript.errorNumber] as? Int {
        out["urlError"] = code == -1743 ? "not-allowed" : "\(code)"
      }
    }
    // Nova's own windows (Nova.app, or its page in a browser) tell nothing about the user's work.
    let skip = Set(skipTitles.map { $0.lowercased() })
    if let title = (out["page"] as? String ?? out["window"] as? String)?.lowercased(), skip.contains(title) { out["isNova"] = true }
    if Context.novaApps.contains(front.bundleIdentifier ?? "") { out["isNova"] = true }
    return out
  }

  private static func element(_ el: AXUIElement, _ attribute: String) -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attribute as CFString, &value) == .success, let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
  }

  private static func string(_ el: AXUIElement, _ attribute: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attribute as CFString, &value) == .success else { return nil }
    return value as? String
  }
}

enum Permissions {
  static func status() -> [String: Any] {
    ["accessibility": AXIsProcessTrusted(), "screen": CGPreflightScreenCaptureAccess()]
  }

  /// Ask macOS: each shows its own prompt (or the System Settings pane) the first time.
  @MainActor static func request(_ which: [String]) -> [String: Any] {
    if which.contains("accessibility") {
      _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    }
    if which.contains("screen") { _ = CGRequestScreenCaptureAccess() }
    return status()
  }
}
