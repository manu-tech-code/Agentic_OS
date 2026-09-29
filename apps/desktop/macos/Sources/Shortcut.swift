import Carbon.HIToolbox

/// A shortcut as the settings file keeps it ("option+space"): its key code and modifiers for
/// macOS, and how it's shown ("⌥Space"). The format is Nova's own - packages/core/src/shortcut.ts
/// reads and checks it the same way.
struct Shortcut: Equatable {
  let text: String
  let keyCode: UInt32
  /// Carbon modifiers: controlKey, optionKey, shiftKey, cmdKey.
  let modifiers: UInt32
  let display: String

  private static let keys: [String: (code: Int, shown: String)] = {
    var keys: [String: (code: Int, shown: String)] = [
      "a": (kVK_ANSI_A, "A"), "b": (kVK_ANSI_B, "B"), "c": (kVK_ANSI_C, "C"), "d": (kVK_ANSI_D, "D"), "e": (kVK_ANSI_E, "E"),
      "f": (kVK_ANSI_F, "F"), "g": (kVK_ANSI_G, "G"), "h": (kVK_ANSI_H, "H"), "i": (kVK_ANSI_I, "I"), "j": (kVK_ANSI_J, "J"),
      "k": (kVK_ANSI_K, "K"), "l": (kVK_ANSI_L, "L"), "m": (kVK_ANSI_M, "M"), "n": (kVK_ANSI_N, "N"), "o": (kVK_ANSI_O, "O"),
      "p": (kVK_ANSI_P, "P"), "q": (kVK_ANSI_Q, "Q"), "r": (kVK_ANSI_R, "R"), "s": (kVK_ANSI_S, "S"), "t": (kVK_ANSI_T, "T"),
      "u": (kVK_ANSI_U, "U"), "v": (kVK_ANSI_V, "V"), "w": (kVK_ANSI_W, "W"), "x": (kVK_ANSI_X, "X"), "y": (kVK_ANSI_Y, "Y"),
      "z": (kVK_ANSI_Z, "Z"),
      "0": (kVK_ANSI_0, "0"), "1": (kVK_ANSI_1, "1"), "2": (kVK_ANSI_2, "2"), "3": (kVK_ANSI_3, "3"), "4": (kVK_ANSI_4, "4"),
      "5": (kVK_ANSI_5, "5"), "6": (kVK_ANSI_6, "6"), "7": (kVK_ANSI_7, "7"), "8": (kVK_ANSI_8, "8"), "9": (kVK_ANSI_9, "9"),
      "space": (kVK_Space, "Space"), "return": (kVK_Return, "↩"), "tab": (kVK_Tab, "⇥"), "escape": (kVK_Escape, "⎋"),
      "delete": (kVK_Delete, "⌫"), "left": (kVK_LeftArrow, "←"), "right": (kVK_RightArrow, "→"), "up": (kVK_UpArrow, "↑"),
      "down": (kVK_DownArrow, "↓"), ",": (kVK_ANSI_Comma, ","), ".": (kVK_ANSI_Period, "."), "/": (kVK_ANSI_Slash, "/"),
      ";": (kVK_ANSI_Semicolon, ";"), "'": (kVK_ANSI_Quote, "'"), "[": (kVK_ANSI_LeftBracket, "["), "]": (kVK_ANSI_RightBracket, "]"),
      "\\": (kVK_ANSI_Backslash, "\\"), "-": (kVK_ANSI_Minus, "-"), "=": (kVK_ANSI_Equal, "="), "`": (kVK_ANSI_Grave, "`"),
    ]
    let functionKeys = [kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10,
                        kVK_F11, kVK_F12, kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19, kVK_F20]
    for (i, code) in functionKeys.enumerated() { keys["f\(i + 1)"] = (code, "F\(i + 1)") }
    return keys
  }()

  private static let aliases = ["enter": "return", "esc": "escape", "backspace": "delete", "comma": ",", "period": ".",
                                "slash": "/", "minus": "-", "equals": "="]

  init?(_ text: String) {
    let parts = text.lowercased().split(separator: "+", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
    guard let last = parts.last, !parts.contains(where: { $0.isEmpty }), let key = Shortcut.keys[Shortcut.aliases[last] ?? last] else { return nil }
    var modifiers: UInt32 = 0
    var seen = Set<String>()
    for part in parts.dropLast() {
      let (name, mask): (String, Int)
      switch part {
      case "control", "ctrl": (name, mask) = ("control", controlKey)
      case "option", "opt", "alt": (name, mask) = ("option", optionKey)
      case "shift": (name, mask) = ("shift", shiftKey)
      case "command", "cmd": (name, mask) = ("command", cmdKey)
      default: return nil
      }
      guard seen.insert(name).inserted else { return nil }
      modifiers |= UInt32(mask)
    }
    // Shown in macOS's order: ⌃ ⌥ ⇧ ⌘.
    var symbols = ""
    if modifiers & UInt32(controlKey) != 0 { symbols += "⌃" }
    if modifiers & UInt32(optionKey) != 0 { symbols += "⌥" }
    if modifiers & UInt32(shiftKey) != 0 { symbols += "⇧" }
    if modifiers & UInt32(cmdKey) != 0 { symbols += "⌘" }
    self.text = text
    self.keyCode = UInt32(key.code)
    self.modifiers = modifiers
    self.display = symbols + key.shown
  }
}
