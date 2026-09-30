import Foundation

/// What Nova on the Mac sends a phone (packages/core/src/protocol.ts and phone.ts), read loosely: a field a
/// newer Mac adds is ignored, a message this app doesn't know is skipped - never a crash.
enum Incoming {
  // The door's handshake.
  case challenge(nonce: String, mac: String, name: String, version: Int)
  case welcome(device: String, name: String)
  // Nova's own events.
  case hello(Hello)
  case hearing(HearingStatus)
  case transcript(text: String, final: Bool)
  case bargeIn
  case phase(String, label: String?)
  case say(text: String, id: String?, partial: Bool, audio: String?)
  case audio(id: String, seq: Int, sampleRate: Double, pcm: Data, last: Bool, error: String?)
  case card(Card)
  case dismiss(String)
  case tasks([AgentTask])
  case computer(active: Bool, caller: String?, app: String?, paused: Bool)
  case phoneConfig(hearing: String)
  case phoneReminders([PhoneReminder])
  case result(ok: Bool, message: String)
  case error(String)

  static func read(_ data: Data) -> Incoming? {
    guard let m = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let type = m["type"] as? String else { return nil }
    switch type {
    case "phone-challenge":
      guard let nonce = m["nonce"] as? String, let mac = m["mac"] as? String else { return nil }
      return .challenge(nonce: nonce, mac: mac, name: m["name"] as? String ?? "Nova", version: m["v"] as? Int ?? 0)
    case "phone-welcome":
      guard let device = m["device"] as? String else { return nil }
      return .welcome(device: device, name: m["name"] as? String ?? "Nova")
    case "hello":
      let ui = m["ui"] as? [String: Any] ?? [:]
      return .hello(Hello(
        name: m["name"] as? String ?? "Nova",
        brain: m["brain"] as? String,
        wakeWords: m["wakeWords"] as? [String] ?? [],
        hearing: HearingStatus(m["hearing"] as? [String: Any] ?? [:]),
        language: ui["lang"] as? String,
        cardSeconds: (ui["cardSeconds"] as? NSNumber)?.doubleValue))
    case "hearing":
      return .hearing(HearingStatus(m["status"] as? [String: Any] ?? [:]))
    case "transcript":
      return .transcript(text: m["text"] as? String ?? "", final: m["final"] as? Bool ?? false)
    case "barge-in":
      return .bargeIn
    case "phase":
      return .phase(m["phase"] as? String ?? "idle", label: m["label"] as? String)
    case "say":
      return .say(text: m["text"] as? String ?? "", id: m["id"] as? String, partial: m["partial"] as? Bool ?? false, audio: m["audio"] as? String)
    case "audio":
      guard let id = m["id"] as? String else { return nil }
      return .audio(
        id: id, seq: m["seq"] as? Int ?? 0, sampleRate: (m["sampleRate"] as? NSNumber)?.doubleValue ?? 24_000,
        pcm: Data(base64Encoded: m["pcm"] as? String ?? "") ?? Data(), last: m["last"] as? Bool ?? false, error: m["error"] as? String)
    case "card":
      guard let card = Card(m["card"] as? [String: Any] ?? [:]) else { return nil }
      return .card(card)
    case "dismiss":
      return (m["id"] as? String).map { .dismiss($0) }
    case "tasks":
      return .tasks((m["tasks"] as? [[String: Any]] ?? []).compactMap(AgentTask.init))
    case "computer":
      return .computer(active: m["active"] as? Bool ?? false, caller: m["caller"] as? String, app: m["app"] as? String, paused: m["paused"] as? Bool ?? false)
    case "phone-config":
      return .phoneConfig(hearing: m["hearing"] as? String ?? "auto")
    case "phone-reminders":
      return .phoneReminders((m["items"] as? [[String: Any]] ?? []).compactMap(PhoneReminder.init))
    case "settings-result":
      return .result(ok: m["ok"] as? Bool ?? false, message: m["message"] as? String ?? "")
    case "error":
      return .error(m["message"] as? String ?? "Something went wrong.")
    default:
      return nil
    }
  }
}

struct Hello {
  var name: String
  var brain: String?
  var wakeWords: [String]
  var hearing: HearingStatus
  /// Nova's language (Settings → Voice), which the iPhone's own hearing uses too.
  var language: String?
  /// How long a reply's cards stay (0: until dismissed).
  var cardSeconds: Double?
}

/// How the Mac hears: its own recognizer (Apple's or Parakeet) when it's ready - else the phone does it.
struct HearingStatus: Equatable {
  var engine: String
  var state: String
  var message: String?

  init(_ m: [String: Any]) {
    engine = m["engine"] as? String ?? "browser"
    state = m["state"] as? String ?? "unavailable"
    message = m["message"] as? String
  }

  /// The Mac can hear what the phone streams to it.
  var ready: Bool { engine != "browser" && state == "ready" }
}

/// One of Nova's cards: an app it opened, an answer, a timer, a question waiting for a yes, an agent's task.
struct Card: Identifiable, Equatable {
  var id: String
  var kind: String
  var title: String
  var body: String?
  var endsAt: Date?
  var agent: String?
  /// Only a tap answers it (money, or what can't be taken back): here, Face ID first.
  var tap: Bool

  init?(_ m: [String: Any]) {
    guard let id = m["id"] as? String, let kind = m["kind"] as? String else { return nil }
    self.id = id
    self.kind = kind
    title = m["title"] as? String ?? ""
    body = m["body"] as? String
    endsAt = (m["endsAt"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) }
    agent = m["agent"] as? String
    tap = m["tap"] as? Bool ?? false
  }

  /// Cards that stay until they're done; the rest close by themselves after a few seconds.
  var stays: Bool { kind == "confirm" || kind == "timer" || kind == "task" }
}

/// An agent's task on the task board.
struct AgentTask: Identifiable, Equatable {
  var id: String
  var label: String
  var project: String
  var task: String
  var status: String
  var step: String?
  var report: String?
  var started: Date
  var ended: Date?

  init?(_ m: [String: Any]) {
    guard let id = m["id"] as? String else { return nil }
    self.id = id
    label = m["label"] as? String ?? m["agent"] as? String ?? "Agent"
    project = m["project"] as? String ?? ""
    task = m["task"] as? String ?? ""
    status = m["status"] as? String ?? "running"
    step = m["step"] as? String
    report = m["report"] as? String
    started = Date(timeIntervalSince1970: ((m["started"] as? NSNumber)?.doubleValue ?? 0) / 1000)
    ended = (m["ended"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) }
  }
}

/// What a phone sends: Nova's own client events, as JSON.
enum Outgoing {
  case talkStart
  case talkEnd(held: Bool)
  /// A tapped turn is over (the Mac heard the pause): the phone stops streaming.
  case audioStop
  /// Nova came to the front on this phone, or left it: news goes where the user is.
  case phoneState(active: Bool)
  /// Snooze or Done on one of the phone's own reminder notifications.
  case notificationAction(ref: String, action: String)
  /// Allow or No on a question only a tap answers - sent after Face ID says it's the phone's owner.
  case tapAnswer(id: String, yes: Bool)
  /// Said into the phone and recognized here (`phone`), or typed (`keyboard`).
  case utterance(String, source: String)
  case speechFinished
  case cancel
  case stopAll
  case taskCancel(String)
  case taskRetry(String)

  var json: [String: Any] {
    switch self {
    case .talkStart: return ["type": "talk-start"]
    case .talkEnd(let held): return ["type": "talk-end", "held": held]
    case .audioStop: return ["type": "audio-stop"]
    case .phoneState(let active): return ["type": "phone-state", "active": active]
    case .notificationAction(let ref, let action): return ["type": "notification-action", "ref": ref, "action": action]
    case .tapAnswer(let id, let yes): return ["type": "tap-answer", "id": id, "yes": yes]
    case .utterance(let text, let source): return ["type": "utterance", "text": text, "source": source]
    case .speechFinished: return ["type": "speech-finished"]
    case .cancel: return ["type": "cancel"]
    case .stopAll: return ["type": "stop-all"]
    case .taskCancel(let id): return ["type": "task-cancel", "id": id]
    case .taskRetry(let id): return ["type": "task-retry", "id": id]
    }
  }
}
