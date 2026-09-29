import AppKit

/// `nova-eyes --hands-selftest`: the parts of Nova's hands that need no permission - reading keys,
/// mapping a picture's pixels to the screen, cleaning labels, naming roles - checked here.
enum HandsSelfTest {
  static func run() -> [String: Any] {
    var failed: [String] = []
    var passed = 0
    func check(_ name: String, _ ok: Bool) {
      if ok { passed += 1 } else { failed.append(name) }
    }
    let us = Keys.us

    // Keys, read as Nova Eyes presses them.
    // Who may use Nova Eyes: its parent-process lookup, and a requirement nothing here meets.
    check("parent of this process", CallerLock.parentPid(of: getpid()) == getppid())
    check("a pid that isn't running has no parent", CallerLock.parentPid(of: 999_999) == 0)
    check("Nova.app's requirement names its id and team", CallerLock.requirement(team: "AB12CD34EF") == "identifier \"dev.nova.app\" and anchor apple generic and certificate leaf[subject.OU] = \"AB12CD34EF\"")
    check("a process that isn't Nova.app doesn't pass", !CallerLock.satisfies(pid: getpid(), requirement: CallerLock.requirement(team: "AB12CD34EF")))
    check("cmd+shift+t", Keys.parse("cmd+shift+t", layout: us) == KeyCombo(code: 17, flags: [.maskCommand, .maskShift]))
    check("Command+L", Keys.parse("Command+L", layout: us) == KeyCombo(code: 37, flags: [.maskCommand]))
    check("return", Keys.parse("return", layout: us) == KeyCombo(code: 36, flags: []))
    check("enter", Keys.parse("enter", layout: us)?.code == 36)
    check("escape", Keys.parse("esc", layout: us)?.code == 53)
    check("tab", Keys.parse("tab", layout: us)?.code == 48)
    check("space", Keys.parse("space", layout: us)?.code == 49)
    check("arrows", [Keys.parse("left")?.code, Keys.parse("right")?.code, Keys.parse("down")?.code, Keys.parse("up")?.code] == [123, 124, 125, 126])
    check("f5", Keys.parse("f5", layout: us)?.code == 96)
    check("f12", Keys.parse("f12", layout: us)?.code == 111)
    check("ctrl+alt+cmd+.", Keys.parse("ctrl+alt+cmd+.", layout: us) == KeyCombo(code: 47, flags: [.maskControl, .maskAlternate, .maskCommand]))
    check("option+comma", Keys.parse("option+comma", layout: us) == KeyCombo(code: 43, flags: [.maskAlternate]))
    check("cmd++", Keys.parse("cmd++", layout: us) == KeyCombo(code: 24, flags: [.maskCommand]))
    check("page down", Keys.parse("page down", layout: us)?.code == 121)
    check("digits", Keys.parse("cmd+1", layout: us)?.code == 18 && Keys.parse("0", layout: us)?.code == 29)
    check("unknown modifier", Keys.parse("hyper+x", layout: us) == nil)
    check("no key", Keys.parse("cmd+", layout: us) == nil && Keys.parse("", layout: us) == nil)
    check("unknown key", Keys.parse("cmd+banana", layout: us) == nil)
    // Another layout moves the letters, not the named keys: AZERTY has "a" where US has "q".
    var azerty = us
    azerty["a"] = 12
    azerty["q"] = 0
    check("layout letters", Keys.parse("cmd+a", layout: azerty)?.code == 12 && Keys.parse("return", layout: azerty)?.code == 36)

    // A picture's pixels and the screen's points.
    let frame = SnapFrame(origin: CGPoint(x: 100, y: 50), scale: 0.9524, size: CGSize(width: 1440, height: 935))
    let p = CGPoint(x: 812, y: 44)
    let back = frame.toImage(frame.toScreen(p))
    check("pixels to points and back", abs(back.x - p.x) < 0.001 && abs(back.y - p.y) < 0.001)
    check("origin maps to 0,0", frame.toImage(CGPoint(x: 100, y: 50)) == .zero)
    let r = frame.toImage(CGRect(x: 200, y: 150, width: 63, height: 21))
    check("rects scale", abs(r.minX - 95.24) < 0.01 && abs(r.width - 60) < 0.01 && abs(r.height - 20) < 0.01)
    check("pictured area", abs(frame.screenRect.width - 1440 / 0.9524) < 0.01)
    let second = SnapFrame(origin: CGPoint(x: -1920, y: -200), scale: 0.75, size: CGSize(width: 1440, height: 810))
    check("a display left of the main one", second.toScreen(CGPoint(x: 720, y: 405)) == CGPoint(x: -960, y: 340))
    check("scale for a retina display", abs(SnapFrame.scale(points: CGSize(width: 1512, height: 982), backing: 2, maxSize: 1440) - 1440.0 / 1512) < 0.0001)
    check("scale for a small window", SnapFrame.scale(points: CGSize(width: 600, height: 400), backing: 2, maxSize: 1440) == 2)
    check("scale never zero", SnapFrame.scale(points: .zero, backing: 2, maxSize: 1440) == 1)

    // Labels, as Nova says them.
    check("whitespace", Labels.clean("  Send\n   now  ") == "Send now")
    check("zero width", Labels.clean("\u{200B}OK\u{FEFF}") == "OK")
    check("icon fonts", Labels.clean("\u{F8FF} Apple \u{E001}") == "Apple")
    check("too long", Labels.clean(String(repeating: "a", count: 100)).count == 80 && Labels.clean(String(repeating: "a", count: 100)).hasSuffix("…"))
    check("empty", Labels.clean(nil) == "" && Labels.clean("   ") == "")
    check("accents stay", Labels.clean("Résumé – final") == "Résumé – final")

    // Roles, and password fields.
    check("password field", Roles.name(role: "AXTextField", subrole: "AXSecureTextField").map { $0.name == "password field" && $0.secure } == true)
    check("search field", Roles.name(role: "AXTextField", subrole: "AXSearchField")?.name == "search field")
    check("tab", Roles.name(role: "AXRadioButton", subrole: "AXTabButton")?.name == "tab")
    check("button", Roles.name(role: "AXButton", subrole: nil).map { $0.name == "button" && !$0.secure } == true)
    check("not actionable", Roles.name(role: "AXGroup", subrole: nil) == nil && Roles.name(role: "AXStaticText", subrole: nil) == nil)
    check("secure either way", Roles.isSecure(role: "AXSecureTextField", subrole: nil) && Roles.isSecure(role: "AXTextField", subrole: "AXSecureTextField") && !Roles.isSecure(role: "AXTextField", subrole: nil))

    // Typing in pieces the keyboard events can carry.
    let pieces = UIActions.pieces("hello world, this is Nova typing\nsecond line 👍🏽 done")
    check("pieces fit", pieces.allSatisfy { $0.utf16.count <= 16 })
    check("pieces keep the text", pieces.joined() == "hello world, this is Nova typing\nsecond line 👍🏽 done")
    check("newlines alone", pieces.contains("\n"))

    // The highlight's caption: below the target, or above at the bottom of the screen.
    let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)
    let below = Highlight.layout(target: CGRect(x: 100, y: 100, width: 60, height: 24), screen: screen)
    check("caption below", below.captionBelow && below.panel.minY == 94 && below.panel.height == 24 + 12 + Highlight.captionHeight + 4)
    let above = Highlight.layout(target: CGRect(x: 1480, y: 950, width: 30, height: 24), screen: screen)
    check("caption above, on screen", !above.captionBelow && above.panel.maxX <= screen.maxX && above.panel.minX >= 0)

    // Media keys and private clipboards.
    check("media key data", SystemControls.mediaData(key: 16, down: true) == 0x100A00 && SystemControls.mediaData(key: 17, down: false) == 0x110B00)
    check("concealed clipboard", Clipboard.isPrivate(["public.utf8-plain-text", "org.nspasteboard.ConcealedType"]) && !Clipboard.isPrivate(["public.utf8-plain-text"]))

    // Files stay in the home folder, out of its hidden folders.
    check("home files", FileOps.allowed(FileOps.home + "/Documents/a.pdf") && !FileOps.allowed(FileOps.home + "/.ssh/id_rsa") && !FileOps.allowed("/etc/hosts") && !FileOps.allowed(FileOps.home + "/../x"))

    return ["ok": failed.isEmpty, "passed": passed, "failed": failed]
  }
}
