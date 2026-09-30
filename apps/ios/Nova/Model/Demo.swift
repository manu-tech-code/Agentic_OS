import Foundation

/// Nova's scripted session on the iPhone, for the README's pictures: launched with `-demo <scene>` (`npm run
/// readme:phone`), it never connects to a Mac. The Mac, what it says and its agents' work are made up here - as in
/// the window's #demo - and this phone's own pairing is left as it was.
enum Demo {
  /// The scene asked for at launch: talk, answer, faceid, tasks, pair or island.
  static let scene: String? = {
    let args = ProcessInfo.processInfo.arguments
    guard let at = args.firstIndex(of: "-demo"), args.indices.contains(at + 1) else { return nil }
    return args[at + 1]
  }()

  /// The Mac it seems to be paired with.
  static let mac = PairedMac(mac: "demo", name: "MacBook Pro", hosts: [], port: 0, pin: "", device: "demo")

  /// What Nova says in the island scene, as it says it.
  static let saying = "Claude fixed both tests in web-app: the date was read in the wrong time zone, and the login redirect had lost its query string."

  /// What the made-up Mac says in a scene, and when (seconds after launch), as the Mac's own events.
  static func script(_ scene: String, now: Date = Date()) -> [(at: Double, event: [String: Any])] {
    // The task board shows times of day: as of 9:41, the time the pictures' status bar shows. The island counts how
    // long a task has run, so there it's as of now.
    let nine41 = Calendar.current.date(bySettingHour: 9, minute: 41, second: 0, of: now) ?? now
    let ago = { (seconds: Double, from: Date) in (from.timeIntervalSince1970 - seconds) * 1000 }
    let claude = { (from: Date) -> [String: Any] in
      ["id": "t1", "label": "Claude", "project": "web-app", "task": "fix the failing tests", "status": "running", "step": "running npm test", "started": ago(134, from)]
    }
    let codex: [String: Any] = [
      "id": "t2", "label": "Codex", "project": "docs", "task": "update the install steps", "status": "done",
      "report": "Updated them for macOS 26, and ran each one in a clean shell.", "started": ago(1_460, nine41), "ended": ago(1_210, nine41),
    ]
    let gemini: [String: Any] = [
      "id": "t3", "label": "Gemini CLI", "project": "api", "task": "rate-limit the login route", "status": "failed",
      "report": "ioredis isn't installed in api.", "started": ago(820, nine41), "ended": ago(690, nine41),
    ]
    let heard = { (text: String) -> [String: Any] in ["type": "transcript", "text": text, "final": true] }
    switch scene {
    case "talk":
      return [
        (0.2, ["type": "phase", "phase": "listening"]),
        (0.4, ["type": "transcript", "text": "ask Claude to fix", "final": false]),
        (0.9, ["type": "transcript", "text": "ask Claude to fix the failing tests in web-app", "final": false]),
      ]
    case "answer":
      return [
        (0.2, heard("ask Claude to fix the failing tests in web-app")),
        (0.3, ["type": "tasks", "tasks": [claude(now)]]),
        (0.4, ["type": "phase", "phase": "speaking"]),
        (0.5, ["type": "say", "text": "Claude's on it in web-app. I'll tell you what it finds."]),
        (0.9, [
          "type": "card",
          "card": ["id": "c1", "kind": "confirm", "agent": "Claude", "title": "Claude wants to run \"npm install date-fns\". Allow it?", "body": "Say \"yes\", \"yes, always\" or \"no\""],
        ]),
      ]
    case "faceid":
      return [
        (0.2, heard("renew the nova-demo.dev domain")),
        (0.4, ["type": "phase", "phase": "speaking"]),
        (0.5, ["type": "say", "text": "That needs a tap: Allow on the Mac's screen, or Face ID on your iPhone."]),
        (0.9, [
          "type": "card",
          "card": [
            "id": "c2", "kind": "confirm", "tap": true, "agent": "Claude", "title": "Claude wants to use Stripe: pay $12.00. Allow it?",
            "body": "Tap Allow on the Mac's screen, or confirm with Face ID on your iPhone",
          ],
        ]),
      ]
    case "tasks":
      return [(0.3, ["type": "tasks", "tasks": [claude(nine41), gemini, codex]])]
    case "island":
      return [(0.2, heard("how did Claude get on?")), (0.3, ["type": "tasks", "tasks": [claude(now)]]), (0.5, ["type": "say", "text": saying])]
    default:
      return []
    }
  }

  /// A voice, as bars (low to high pitch, 0-1): syllables rising and falling, each part of it on its own, and a pause
  /// now and then - about as loud as Kokoro's.
  static func bands(at t: Double) -> [Float] {
    guard t.truncatingRemainder(dividingBy: 3.2) < 2.85 else { return [0, 0, 0, 0, 0] }
    let syllable = 0.4 + 0.6 * (0.5 + 0.5 * sin(t * 13))
    return (0..<5).map { band in
      let part = 0.55 + 0.45 * sin(t * 7.7 + Double(band) * 1.9)
      return Float(min(1, syllable * part * (1 - Double(band) * 0.08)))
    }
  }
}
