import AppKit
import ApplicationServices

/// Windows and apps: where every window is, the screens they're on, and moving, sizing, minimizing,
/// full screen, hiding. Frames are in global points from the top-left of the main display, as
/// Accessibility measures them. The daemon works out where things go; this only moves them.
enum Windows {
  static func rect(_ r: CGRect) -> [String: Any] {
    ["x": Double(r.minX), "y": Double(r.minY), "w": Double(r.width), "h": Double(r.height)]
  }

  static func rect(_ d: Any?) -> CGRect? {
    guard let d = d as? [String: Any], let x = (d["x"] as? NSNumber)?.doubleValue, let y = (d["y"] as? NSNumber)?.doubleValue,
      let w = (d["w"] as? NSNumber)?.doubleValue, let h = (d["h"] as? NSNumber)?.doubleValue, w > 0, h > 0
    else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
  }

  /// A screen in global top-left points (Cocoa counts from the bottom-left of the main display).
  @MainActor static func topLeft(_ r: NSRect) -> CGRect {
    let primary = NSScreen.screens.first?.frame.maxY ?? r.maxY
    return CGRect(x: r.minX, y: primary - r.maxY, width: r.width, height: r.height)
  }

  @MainActor static func screens() -> [[String: Any]] {
    NSScreen.screens.enumerated().map { i, s in
      [
        "index": i, "id": Int((s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0),
        "name": s.localizedName, "main": i == 0, "frame": rect(topLeft(s.frame)), "visible": rect(topLeft(s.visibleFrame)),
      ]
    }
  }

  @MainActor static func regularApps() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && !$0.isTerminated && !Context.novaApps.contains($0.bundleIdentifier ?? "") }
  }

  static func windows(of pid: pid_t) -> [AXUIElement] {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.6)
    return AX.elements(AX.attr(app, "AXWindows"))
  }

  static func describe(_ window: AXUIElement, index: Int) -> [String: Any]? {
    let v = AX.values(window, ["AXTitle", "AXPosition", "AXSize", "AXMinimized", "AXFullScreen", "AXMain", "AXFocused", "AXSubrole"])
    guard let frame = AX.frame(v) else { return nil }
    var out: [String: Any] = [
      "index": index, "title": AX.string(v["AXTitle"]) ?? "", "frame": rect(frame), "minimized": AX.bool(v["AXMinimized"]) ?? false,
      "fullscreen": AX.bool(v["AXFullScreen"]) ?? false, "main": AX.bool(v["AXMain"]) ?? false, "focused": AX.bool(v["AXFocused"]) ?? false,
      "standard": (AX.string(v["AXSubrole"]) ?? "AXStandardWindow") == "AXStandardWindow",
    ]
    if let id = AX.windowID(window) { out["id"] = Int(id) }
    return out
  }

  /// Every app with windows (without Accessibility, the apps alone), and the screens.
  static func list() async -> [String: Any] {
    let (apps, screens, front) = await MainActor.run { (regularApps().map { ($0.processIdentifier, $0.localizedName ?? "", $0.bundleIdentifier ?? "", $0.isHidden, $0.isActive) }, Windows.screens(), Target.app()?.pid) }
    let trusted = AXIsProcessTrusted()
    let described: [[String: Any]] = apps.map { pid, name, bundle, hidden, active in
      let windows = trusted ? Windows.windows(of: pid).enumerated().compactMap { describe($1, index: $0) } : []
      return ["pid": Int(pid), "name": name, "bundleId": bundle, "hidden": hidden, "active": active, "front": pid == front, "windows": windows]
    }
    return ["apps": described, "screens": screens, "accessibility": trusted]
  }

  /// A window of an app, by its window server id, else its title, else its place in the app's list.
  static func find(pid: pid_t, id: Int?, title: String?, index: Int?) -> AXUIElement? {
    let all = windows(of: pid)
    if let id, let hit = all.first(where: { AX.windowID($0).map(Int.init) == id }) { return hit }
    if let title, !title.isEmpty {
      let named = all.filter { AX.string(AX.attr($0, "AXTitle")) == title }
      if named.count == 1 { return named[0] }
    }
    if let index, index >= 0, index < all.count { return all[index] }
    return nil
  }

  /// Move, size, minimize, full screen or raise one window; answers with where it ended up.
  static func set(_ request: [String: Any]) async -> [String: Any] {
    guard AXIsProcessTrusted() else { return ["error": "accessibility-permission"] }
    guard let pid = (request["pid"] as? NSNumber)?.int32Value else { return ["error": "no-app"] }
    guard let window = find(pid: pid, id: request["id"] as? Int, title: request["title"] as? String, index: request["window"] as? Int) else { return ["error": "no-window"] }
    let full = AX.bool(AX.attr(window, "AXFullScreen")) ?? false
    if let fullscreen = request["fullscreen"] as? Bool, fullscreen != full {
      _ = AX.set(window, "AXFullScreen", fullscreen as CFBoolean)
      UIActions.pause(900) // the animation
    }
    if let minimized = request["minimized"] as? Bool {
      _ = AX.set(window, "AXMinimized", minimized as CFBoolean)
      if minimized { return ["ok": true] }
      UIActions.pause(250)
    }
    if let frame = rect(request["frame"]) {
      // A full-screen window can't be moved: it leaves full screen first.
      if AX.bool(AX.attr(window, "AXFullScreen")) == true {
        _ = AX.set(window, "AXFullScreen", kCFBooleanFalse)
        UIActions.pause(900)
      }
      var origin = frame.origin
      var size = frame.size
      // Position, size, then position again: a window grown near a screen edge gets pushed back otherwise.
      if let p = AXValueCreate(.cgPoint, &origin) { _ = AX.set(window, "AXPosition", p) }
      if let s = AXValueCreate(.cgSize, &size) { _ = AX.set(window, "AXSize", s) }
      if let p = AXValueCreate(.cgPoint, &origin) { _ = AX.set(window, "AXPosition", p) }
    }
    if request["raise"] as? Bool == true {
      AXUIElementPerformAction(window, "AXRaise" as CFString)
      await MainActor.run { _ = NSRunningApplication(processIdentifier: pid)?.activate() }
    }
    var out: [String: Any] = ["ok": true]
    if let now = AX.liveFrame(window) { out["frame"] = rect(now) }
    return out
  }

  static func app(_ request: [String: Any], _ what: String) async -> [String: Any] {
    await MainActor.run {
      if what == "unhideAll" {
        for app in regularApps() where app.isHidden { app.unhide() }
        return ["ok": true]
      }
      guard let pid = (request["pid"] as? NSNumber)?.int32Value, let app = NSRunningApplication(processIdentifier: pid) else { return ["error": "no-app"] }
      switch what {
      case "hide": return ["ok": app.hide()]
      case "unhide": return ["ok": app.unhide()]
      default: return ["ok": app.activate()]
      }
    }
  }
}
