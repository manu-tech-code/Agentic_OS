import Carbon.HIToolbox

/// A shortcut registered with macOS for the whole system - the talk shortcut, the stop shortcut.
/// It needs no permission: macOS tells Nova when those keys go down and come up, and nothing
/// else that's typed.
final class Hotkey {
  var onPress: () -> Void = {}
  var onRelease: () -> Void = {}
  private(set) var shortcut: Shortcut?
  private let id: UInt32
  private var ref: EventHotKeyRef?
  private var down = false

  private struct Weak { weak var hotkey: Hotkey? }
  /// Every shortcut Nova holds, by id: one handler for the app hears them all.
  private static var all: [UInt32: Weak] = [:]
  private static var handler: EventHandlerRef?

  init(id: UInt32) {
    self.id = id
    Hotkey.all[id] = Weak(hotkey: self)
    Hotkey.listen()
  }

  private static func listen() {
    guard handler == nil else { return }
    var events = [
      EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
      EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
    ]
    InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
      guard let event else { return OSStatus(eventNotHandledErr) }
      var key = EventHotKeyID()
      let found = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &key)
      guard found == noErr, let hotkey = Hotkey.all[key.id]?.hotkey else { return OSStatus(eventNotHandledErr) }
      hotkey.handle(GetEventKind(event))
      return noErr
    }, events.count, &events, nil, &handler)
  }

  /// Take the shortcut, letting go of the last one. Returns why it couldn't (another app holds it).
  func register(_ shortcut: Shortcut) -> String? {
    unregister()
    let hotKeyID = EventHotKeyID(signature: OSType(0x4E4F_5641), id: id) // "NOVA"
    let status = RegisterEventHotKey(shortcut.keyCode, shortcut.modifiers, hotKeyID, GetApplicationEventTarget(), 0, &ref)
    guard status == noErr else {
      ref = nil
      return status == eventHotKeyExistsErr
        ? "\(shortcut.display) is taken by another app - choose another in Settings → Menu bar"
        : "macOS wouldn't give Nova \(shortcut.display) (error \(status))"
    }
    self.shortcut = shortcut
    return nil
  }

  func unregister() {
    if let ref { UnregisterEventHotKey(ref) }
    ref = nil
    shortcut = nil
    if down {
      down = false
      onRelease()
    }
  }

  private func handle(_ kind: UInt32) {
    // Holding the keys can repeat the press: one press, one release.
    if kind == UInt32(kEventHotKeyPressed), !down {
      down = true
      onPress()
    } else if kind == UInt32(kEventHotKeyReleased), down {
      down = false
      onRelease()
    }
  }
}
