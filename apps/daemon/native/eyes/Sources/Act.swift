import AppKit
import ApplicationServices

/// Nova's hands on the screen: clicks, typing, keys, scrolling and drags, posted as the user's own input
/// would be. Password fields are never typed into, whoever asks.
enum UIActions {
  /// Marks Nova's own events, so they can be told apart from the user's.
  static let marker: Int64 = 0x4E4F_5641
  /// Its own event source: the modifier keys Nova presses never mix with the ones the user holds.
  static let source = CGEventSource(stateID: .privateState)
  private static let lock = NSLock()
  private static var lastPosted: Date?

  /// Apps Nova never types into: macOS's own password prompts and the lock screen.
  static let neverType: Set<String> = ["com.apple.SecurityAgent", "com.apple.loginwindow", "com.apple.systemuiserver.password", "com.apple.CoreServicesUIAgent"]

  static func post(_ event: CGEvent?) {
    guard let event else { return }
    event.setIntegerValueField(.eventSourceUserData, value: marker)
    event.post(tap: .cghidEventTap)
    lock.lock()
    lastPosted = Date()
    lock.unlock()
  }

  static func pause(_ ms: UInt32) { usleep(ms * 1000) }

  /// How long since anyone touched the mouse or keyboard, and since Nova last did.
  static func idle() -> [String: Any] {
    // Modifier keys alone don't count: letting go of the talk shortcut isn't using the Mac.
    let kinds: [CGEventType] = [.mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseDragged, .keyDown, .scrollWheel]
    let idle = kinds.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min() ?? .infinity
    lock.lock()
    let ours = lastPosted.map { Date().timeIntervalSince($0) }
    lock.unlock()
    var out: [String: Any] = ["idle": idle.isFinite ? idle : 86_400]
    if let ours { out["sinceNova"] = ours }
    return out
  }

  // MARK: - The mouse

  static func move(to p: CGPoint) {
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
  }

  static func click(at p: CGPoint, right: Bool = false, count: Int = 1) {
    let button: CGMouseButton = right ? .right : .left
    let (down, up): (CGEventType, CGEventType) = right ? (.rightMouseDown, .rightMouseUp) : (.leftMouseDown, .leftMouseUp)
    move(to: p)
    pause(40)
    for n in 1...max(1, min(count, 3)) {
      for type in [down, up] {
        let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button)
        e?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
        post(e)
        pause(type == down ? 35 : 25)
      }
    }
  }

  static func drag(from a: CGPoint, to b: CGPoint) {
    move(to: a)
    pause(60)
    post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: a, mouseButton: .left))
    pause(80)
    let steps = 18
    for i in 1...steps {
      let t = CGFloat(i) / CGFloat(steps)
      let p = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
      post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left))
      pause(14)
    }
    pause(60)
    post(CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: b, mouseButton: .left))
  }

  /// Scroll wheel steps at a point: positive dy scrolls up (towards the top), positive dx left.
  static func scroll(at p: CGPoint, dy: Int32, dx: Int32, times: Int) {
    move(to: p)
    pause(30)
    for _ in 0..<max(1, times) {
      let e = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
      e?.location = p
      post(e)
      pause(16)
    }
  }

  // MARK: - The keyboard

  static func press(_ combo: KeyCombo, count: Int = 1) {
    for _ in 0..<max(1, min(count, 20)) {
      for down in [true, false] {
        let e = CGEvent(keyboardEventSource: source, virtualKey: combo.code, keyDown: down)
        e?.flags = combo.flags
        post(e)
        pause(down ? 18 : 14)
      }
      pause(20)
    }
  }

  /// Text split into pieces the keyboard events can carry (at most 20 UTF-16 units each), never splitting a character.
  static func pieces(_ text: String, size: Int = 16) -> [String] {
    var out: [String] = []
    var current = ""
    for ch in text {
      if ch == "\n" || ch == "\r" || ch == "\t" {
        if !current.isEmpty { out.append(current) }
        out.append(String(ch))
        current = ""
        continue
      }
      if current.utf16.count + String(ch).utf16.count > size {
        out.append(current)
        current = ""
      }
      current.append(ch)
    }
    if !current.isEmpty { out.append(current) }
    return out
  }

  static func type(_ text: String, stillSafe: () -> Bool) -> Bool {
    for (i, piece) in pieces(text).enumerated() {
      // Where the typing goes can change (a page moving focus): check again now and then.
      if i > 0, i % 8 == 0, !stillSafe() { return false }
      if piece == "\n" || piece == "\r" {
        press(KeyCombo(code: 36, flags: []))
        continue
      }
      if piece == "\t" {
        press(KeyCombo(code: 48, flags: []))
        continue
      }
      var units = Array(piece.utf16)
      for down in [true, false] {
        let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
        e?.flags = []
        e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
        post(e)
        pause(6)
      }
      pause(12)
    }
    return true
  }

  // MARK: - Requests

  static func perform(_ request: [String: Any]) async -> [String: Any] {
    guard AXIsProcessTrusted() else { return ["error": "accessibility-permission"] }
    let snapshot = SnapshotStore.shared.get(request["snapshot"] as? String)
    switch request["action"] as? String ?? "" {
    case "click":
      return click(request, snapshot)
    case "type":
      return await type(request, snapshot)
    case "key":
      let layout = await MainActor.run { Keys.currentLayout() }
      guard let combo = Keys.parse(request["keys"] as? String ?? "", layout: layout) else { return ["error": "unknown-keys"] }
      press(combo, count: request["count"] as? Int ?? 1)
      return ["ok": true]
    case "scroll":
      return scroll(request, snapshot)
    case "drag":
      guard let from = locate(request["from"] as? [String: Any] ?? [:], snapshot), let to = locate(request["to"] as? [String: Any] ?? [:], snapshot) else {
        return ["error": snapshot == nil ? "stale" : "no-target"]
      }
      if let error = from.error ?? to.error { return ["error": error] }
      drag(from: from.point, to: to.point)
      return ["ok": true]
    default:
      return ["error": "unknown action"]
    }
  }

  /// A place on screen: an element (where it is now), or x,y in the snapshot's picture.
  struct Located {
    var point: CGPoint
    var thing: UIThing?
    var error: String?
  }

  static func locate(_ spec: [String: Any], _ snapshot: UISnapshot?) -> Located? {
    if let id = spec["element"] as? String, !id.isEmpty {
      guard let snapshot else { return Located(point: .zero, error: "stale") }
      guard let thing = snapshot.things[id] else { return Located(point: .zero, error: "no-element") }
      guard let frame = AX.liveFrame(thing.element), frame.width > 0 else { return Located(point: .zero, thing: thing, error: "gone") }
      return Located(point: CGPoint(x: frame.midX, y: frame.midY), thing: thing)
    }
    guard let x = (spec["x"] as? NSNumber)?.doubleValue, let y = (spec["y"] as? NSNumber)?.doubleValue else { return nil }
    guard let snapshot else { return Located(point: .zero, error: "stale") }
    return Located(point: snapshot.frame.toScreen(CGPoint(x: x, y: y)))
  }

  static func onScreen(_ p: CGPoint) -> Bool {
    var count: UInt32 = 0
    var ids = [CGDirectDisplayID](repeating: 0, count: 16)
    CGGetActiveDisplayList(16, &ids, &count)
    return ids.prefix(Int(count)).contains { CGDisplayBounds($0).insetBy(dx: -1, dy: -1).contains(p) }
  }

  private static func click(_ request: [String: Any], _ snapshot: UISnapshot?) -> [String: Any] {
    guard let target = locate(request, snapshot) else { return ["error": "no-target"] }
    if let error = target.error { return ["error": error] }
    let right = request["button"] as? String == "right"
    let count = request["count"] as? Int ?? 1
    // Buttons, links and menu items are pressed as themselves; anything else gets a real click.
    if let thing = target.thing, thing.pressable, !right, count == 1, Roles.pressFirst.contains(thing.axRole),
      AXUIElementPerformAction(thing.element, "AXPress" as CFString) == .success
    {
      return ["ok": true, "via": "press"]
    }
    guard onScreen(target.point) else { return ["error": "off-screen"] }
    click(at: target.point, right: right, count: count)
    return ["ok": true, "via": "mouse"]
  }

  /// Whether the keyboard's focus is somewhere Nova must not type: a password field, or macOS asking for a password.
  static func focusIsPrivate() -> Bool {
    let system = AXUIElementCreateSystemWide()
    if let focused = AX.element(AX.attr(system, "AXFocusedUIElement")) {
      let v = AX.values(focused, ["AXRole", "AXSubrole"])
      if Roles.isSecure(role: AX.string(v["AXRole"]), subrole: AX.string(v["AXSubrole"])) { return true }
    }
    if let app = AX.element(AX.attr(system, "AXFocusedApplication")) {
      var pid: pid_t = 0
      if AXUIElementGetPid(app, &pid) == .success, let bundle = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier, neverType.contains(bundle) { return true }
    }
    return false
  }

  private static func type(_ request: [String: Any], _ snapshot: UISnapshot?) async -> [String: Any] {
    let text = request["text"] as? String ?? ""
    guard !text.isEmpty else { return ["error": "nothing-to-type"] }
    if let id = request["element"] as? String, !id.isEmpty {
      guard let target = locate(["element": id], snapshot) else { return ["error": "no-target"] }
      if let error = target.error { return ["error": error] }
      if target.thing?.secure == true { return ["error": "secure-field"] }
      // Focus the field: through Accessibility, else by clicking it.
      if let el = target.thing?.element {
        _ = AX.set(el, "AXFocused", kCFBooleanTrue)
        pause(60)
        if AX.bool(AX.attr(el, "AXFocused")) != true, onScreen(target.point) {
          click(at: target.point)
          pause(120)
        }
      }
    }
    if focusIsPrivate() { return ["error": "secure-field"] }
    let layout = await MainActor.run { Keys.currentLayout() }
    if request["clear"] as? Bool == true, let all = Keys.parse("cmd+a", layout: layout) {
      press(all)
      press(KeyCombo(code: 51, flags: []))
    }
    guard type(text, stillSafe: { !focusIsPrivate() }) else { return ["error": "secure-field"] }
    if request["submit"] as? Bool == true {
      pause(40)
      press(KeyCombo(code: 36, flags: []))
    }
    return ["ok": true, "typed": text.count]
  }

  private static func scroll(_ request: [String: Any], _ snapshot: UISnapshot?) -> [String: Any] {
    var point: CGPoint
    if let target = locate(request, snapshot) {
      if let error = target.error { return ["error": error] }
      point = target.point
    } else if let snapshot {
      // The middle of what was pictured.
      let r = snapshot.frame.screenRect
      point = CGPoint(x: r.midX, y: r.midY)
    } else {
      let app = AXUIElementCreateApplication(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)
      guard let window = Target.window(app), let r = AX.liveFrame(window) else { return ["error": "no-window"] }
      point = CGPoint(x: r.midX, y: r.midY)
    }
    let amount = max(1, min(request["amount"] as? Int ?? 5, 50))
    switch request["direction"] as? String ?? "down" {
    case "up": scroll(at: point, dy: 3, dx: 0, times: amount)
    case "left": scroll(at: point, dy: 0, dx: 3, times: amount)
    case "right": scroll(at: point, dy: 0, dx: -3, times: amount)
    case "top": scroll(at: point, dy: 60, dx: 0, times: 40)
    case "bottom": scroll(at: point, dy: -60, dx: 0, times: 40)
    default: scroll(at: point, dy: -3, dx: 0, times: amount)
    }
    return ["ok": true]
  }
}
