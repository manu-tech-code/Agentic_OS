import AppKit
import CoreGraphics

/// The Mac's own controls that have no command line: the built-in display's brightness, Bluetooth,
/// locking the screen, and the media keys. The private frameworks are looked up at run time, so a
/// macOS without them gets a clear "not available" rather than a crash.
enum SystemControls {
  private static func symbol<T>(_ library: String, _ name: String, as type: T.Type) -> T? {
    guard let handle = dlopen(library, RTLD_LAZY), let sym = dlsym(handle, name) else { return nil }
    return unsafeBitCast(sym, to: type)
  }

  // MARK: - Brightness (DisplayServices)

  typealias GetBrightness = @convention(c) (CGDirectDisplayID, UnsafeMutablePointer<Float>) -> Int32
  typealias SetBrightness = @convention(c) (CGDirectDisplayID, Float) -> Int32
  static let displayServices = "/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices"

  /// The Mac's own display - external displays set their brightness themselves.
  static func builtInDisplay() -> CGDirectDisplayID? {
    var count: UInt32 = 0
    var ids = [CGDirectDisplayID](repeating: 0, count: 16)
    CGGetActiveDisplayList(16, &ids, &count)
    return ids.prefix(Int(count)).first { CGDisplayIsBuiltin($0) != 0 }
  }

  static func brightness(_ request: [String: Any]) -> [String: Any] {
    guard let display = builtInDisplay() else { return ["error": "external-display"] }
    guard let get = symbol(displayServices, "DisplayServicesGetBrightness", as: GetBrightness.self),
      let set = symbol(displayServices, "DisplayServicesSetBrightness", as: SetBrightness.self)
    else { return ["error": "unavailable"] }
    if let level = (request["level"] as? NSNumber)?.doubleValue {
      let value = Float(min(1, max(0, level / 100)))
      guard set(display, value) == 0 else { return ["error": "refused"] }
    }
    var value: Float = 0
    guard get(display, &value) == 0 else { return ["error": "refused"] }
    return ["level": Int((Double(value) * 100).rounded())]
  }

  // MARK: - Bluetooth (IOBluetooth's preference calls, as blueutil uses them)

  typealias GetPower = @convention(c) () -> Int32
  typealias SetPower = @convention(c) (Int32) -> Void
  static let ioBluetooth = "/System/Library/Frameworks/IOBluetooth.framework/IOBluetooth"

  static func bluetooth(_ request: [String: Any]) -> [String: Any] {
    guard let get = symbol(ioBluetooth, "IOBluetoothPreferenceGetControllerPowerState", as: GetPower.self),
      let set = symbol(ioBluetooth, "IOBluetoothPreferenceSetControllerPowerState", as: SetPower.self)
    else { return ["error": "unavailable"] }
    if let on = request["on"] as? Bool {
      set(on ? 1 : 0)
      // The controller takes a moment to come up or go down.
      for _ in 0..<30 where (get() != 0) != on { usleep(150_000) }
      if (get() != 0) != on { return ["error": "refused", "on": get() != 0] }
    }
    return ["on": get() != 0]
  }

  // MARK: - Locking the screen

  typealias Lock = @convention(c) () -> Int32
  static let login = "/System/Library/PrivateFrameworks/login.framework/Versions/Current/login"

  static func lock() -> [String: Any] {
    if let lock = symbol(login, "SACLockScreenImmediate", as: Lock.self) {
      _ = lock()
      return ["ok": true]
    }
    // macOS's own shortcut for Lock Screen: control-command-Q.
    guard AXIsProcessTrusted() else { return ["error": "accessibility-permission"] }
    UIActions.press(KeyCombo(code: 12, flags: [.maskControl, .maskCommand]))
    return ["ok": true, "via": "shortcut"]
  }

  // MARK: - Media keys

  /// NX_KEYTYPE_PLAY, _NEXT, _PREVIOUS: the keys on the keyboard, sent to whatever is playing.
  static let mediaKeys: [String: Int] = ["play": 16, "pause": 16, "toggle": 16, "next": 17, "previous": 18]

  /// The system-defined event's data for a media key going down or up.
  static func mediaData(key: Int, down: Bool) -> Int { (key << 16) | ((down ? 0xA : 0xB) << 8) }

  @MainActor static func mediaKey(_ name: String) -> [String: Any] {
    guard let key = mediaKeys[name] else { return ["error": "unknown key"] }
    guard AXIsProcessTrusted() else { return ["error": "accessibility-permission"] }
    for down in [true, false] {
      let event = NSEvent.otherEvent(
        with: .systemDefined, location: .zero, modifierFlags: NSEvent.ModifierFlags(rawValue: down ? 0xA00 : 0xB00), timestamp: 0,
        windowNumber: 0, context: nil, subtype: 8, data1: mediaData(key: key, down: down), data2: -1)
      UIActions.post(event?.cgEvent)
      usleep(20_000)
    }
    return ["ok": true]
  }
}

/// The clipboard. What a password manager marks as concealed or passing is never read.
enum Clipboard {
  /// The pasteboard types apps use to say "don't keep or show this" (nspasteboard.org).
  static let privateTypes: Set<String> = [
    "org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType", "com.agilebits.onepassword", "de.petermaurer.TransientPasteboardType",
    "com.apple.is-remote-clipboard-concealed",
  ]

  static func isPrivate(_ types: [String]) -> Bool { types.contains { privateTypes.contains($0) } }

  static func read(max: Int) -> [String: Any] {
    let board = NSPasteboard.general
    let types = (board.types ?? []).map(\.rawValue)
    if isPrivate(types) { return ["concealed": true] }
    var out: [String: Any] = ["change": board.changeCount]
    if let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
      out["files"] = urls.prefix(50).map(\.path)
    }
    if let text = board.string(forType: .string), !text.isEmpty { out["text"] = String(text.prefix(max)) }
    if types.contains(where: { ["public.png", "public.tiff", "public.jpeg", "public.heic"].contains($0) }) { out["image"] = true }
    return out
  }

  static func write(_ text: String) -> [String: Any] {
    let board = NSPasteboard.general
    board.clearContents()
    return ["ok": board.setString(text, forType: .string)]
  }
}
