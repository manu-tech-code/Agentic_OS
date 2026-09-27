import AppKit
import Carbon.HIToolbox

/// A key and its modifiers, as Nova Eyes presses them.
struct KeyCombo: Equatable {
  var code: CGKeyCode
  var flags: CGEventFlags

  static func == (a: KeyCombo, b: KeyCombo) -> Bool { a.code == b.code && a.flags.rawValue == b.flags.rawValue }
}

/// Keys by name: "cmd+shift+t", "return", "down", "f5", "space" - read in code, never guessed.
enum Keys {
  /// Keys that aren't characters. Their codes are the same on every keyboard layout.
  static let named: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "spacebar": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
    "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "help": 114, "capslock": 57,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109,
    "f11": 103, "f12": 111, "f13": 105, "f14": 107, "f15": 113, "f16": 106, "f17": 64, "f18": 79, "f19": 80, "f20": 90,
  ]

  /// Where each character is on a US keyboard: the fallback when the layout can't be read.
  static let us: [Character: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
    "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
    "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
    "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
  ]

  /// Punctuation said as a word.
  static let words: [String: Character] = [
    "comma": ",", "period": ".", "dot": ".", "fullstop": ".", "slash": "/", "minus": "-", "dash": "-", "hyphen": "-",
    "equals": "=", "equal": "=", "plus": "=", "semicolon": ";", "quote": "'", "apostrophe": "'", "backtick": "`",
    "backslash": "\\", "leftbracket": "[", "rightbracket": "]",
  ]

  static let modifiers: [String: CGEventFlags] = [
    "cmd": .maskCommand, "command": .maskCommand, "ctrl": .maskControl, "control": .maskControl, "alt": .maskAlternate,
    "option": .maskAlternate, "opt": .maskAlternate, "shift": .maskShift, "fn": .maskSecondaryFn, "function": .maskSecondaryFn,
  ]

  /// "cmd+shift+t" as a key and its modifiers, for the given layout (US when none); nil when a part isn't known.
  static func parse(_ combo: String, layout: [Character: CGKeyCode] = us) -> KeyCombo? {
    var text = combo.lowercased().trimmingCharacters(in: .whitespaces)
    // "cmd++" is command and the plus key.
    if text.hasSuffix("++") { text = String(text.dropLast(2)) + "+plus" }
    let parts = text.split(separator: "+", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: " ", with: "") }
    guard let last = parts.last, !last.isEmpty else { return nil }
    var flags: CGEventFlags = []
    for part in parts.dropLast() {
      guard let flag = modifiers[part] else { return nil }
      flags.insert(flag)
    }
    if let code = named[last] { return KeyCombo(code: code, flags: flags) }
    let character: Character? = last.count == 1 ? last.first : words[last]
    guard let ch = character, let code = layout[ch] ?? us[ch] else { return nil }
    return KeyCombo(code: code, flags: flags)
  }

  /// Where each character is on the keyboard layout in use (read on the main thread, as the Text Input Sources API wants).
  @MainActor static func currentLayout() -> [Character: CGKeyCode] {
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
      let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
    else { return us }
    let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
    var map: [Character: CGKeyCode] = [:]
    data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
      guard let layout = buffer.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return }
      for code in 0..<128 {
        var dead: UInt32 = 0
        var chars = [UniChar](repeating: 0, count: 4)
        var length = 0
        let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDisplay), 0, UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, 4, &length, &chars)
        guard status == noErr, length == 1, let scalar = Unicode.Scalar(chars[0]), !CharacterSet.controlCharacters.contains(scalar) else { continue }
        let ch = Character(String(scalar).lowercased())
        if map[ch] == nil { map[ch] = CGKeyCode(code) }
      }
    }
    return map.count > 20 ? map : us
  }
}
