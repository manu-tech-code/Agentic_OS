import Foundation
import UserNotifications

/// Nova's reminders and timers as this iPhone's own notifications. The Mac sends what's coming up; the
/// phone rings for it itself - even with Nova closed, which is all a free Apple account allows (no push).
/// Snooze and Done go back to the Mac, now or the next time it's reachable.
final class Notifications: NSObject, UNUserNotificationCenterDelegate {
  static let shared = Notifications()

  /// Nova is open and connected: the Mac says the reminder, so the phone shows no banner of its own.
  var quiet: () -> Bool = { false }
  /// Snooze or Done (or just opened), for a reminder's id.
  var onAction: (_ ref: String, _ action: String) -> Void = { _, _ in }

  private let center = UNUserNotificationCenter.current()
  private let prefix = "nova-reminder-"
  /// When each reminder this phone was set to ring for is due, by its id: news of one it already rang isn't shown again.
  private var ringing: [String: Double] {
    get { UserDefaults.standard.dictionary(forKey: "reminderTimes") as? [String: Double] ?? [:] }
    set { UserDefaults.standard.set(newValue, forKey: "reminderTimes") }
  }

  func setUp() {
    center.delegate = self
    let snooze = UNNotificationAction(identifier: "snooze", title: "In 10 minutes")
    let done = UNNotificationAction(identifier: "done", title: "Done")
    center.setNotificationCategories([
      UNNotificationCategory(identifier: "nova.reminder", actions: [snooze, done], intentIdentifiers: []),
      UNNotificationCategory(identifier: "nova.timer", actions: [done], intentIdentifiers: []),
    ])
  }

  /// What's coming up now: it replaces whatever the phone had from the Mac before.
  func replace(_ items: [PhoneReminder]) async {
    let old = await center.pendingNotificationRequests().map(\.identifier).filter { $0.hasPrefix(prefix) }
    center.removePendingNotificationRequests(withIdentifiers: old)
    let coming = items.filter { $0.due > Date() }
    guard !coming.isEmpty, (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) == true else { return }
    // iOS keeps 64 at most: the soonest.
    let soonest = coming.sorted(by: { $0.due < $1.due }).prefix(60)
    // Kept a day after it's due, for telling news of it apart.
    let day = Date().addingTimeInterval(-86_400).timeIntervalSince1970
    ringing = ringing.filter { $0.value > day }.merging(soonest.map { ($0.id, $0.due.timeIntervalSince1970) }) { $1 }
    for item in soonest {
      let content = UNMutableNotificationContent()
      content.title = item.title
      content.body = item.body
      content.sound = .default
      content.categoryIdentifier = item.timer ? "nova.timer" : "nova.reminder"
      content.userInfo = ["ref": item.id]
      let when = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: item.due)
      try? await center.add(UNNotificationRequest(identifier: prefix + item.id, content: content, trigger: UNCalendarNotificationTrigger(dateMatching: when, repeats: false)))
    }
  }

  /// News the Mac held while you were away, shown now - but not a reminder this phone already rang for by itself.
  /// What was shown (or had rung already) comes back, so the Mac doesn't say it again; the rest it keeps.
  func news(_ items: [PhoneNews]) async -> [String] {
    guard !items.isEmpty else { return [] }
    let allowed = await center.notificationSettings().authorizationStatus
    guard allowed == .authorized || allowed == .provisional || allowed == .ephemeral else { return [] }
    let rang = ringing
    var shown: [String] = []
    for item in items {
      if let ref = item.ref, let due = rang[ref], due <= Date().timeIntervalSince1970 {
        shown.append(item.id)
        continue
      }
      let content = UNMutableNotificationContent()
      content.title = item.title
      content.body = item.text
      // Not just now: when it came up.
      if Date().timeIntervalSince(item.at) > 600 {
        content.subtitle = Calendar.current.isDateInToday(item.at) ? item.at.formatted(date: .omitted, time: .shortened) : item.at.formatted(.dateTime.weekday(.abbreviated).hour().minute())
      }
      content.sound = .default
      content.threadIdentifier = "nova.news"
      content.userInfo = ["news": item.id]
      do {
        try await center.add(UNNotificationRequest(identifier: "nova-news-" + item.id, content: content, trigger: nil))
        shown.append(item.id)
      } catch {
        // not shown: the Mac keeps it, and says it when you're back
      }
    }
    return shown
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
    let quiet = await MainActor.run { self.quiet() }
    return quiet ? [] : [.banner, .list, .sound]
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
    guard let ref = response.notification.request.content.userInfo["ref"] as? String else { return }
    let action = ["snooze", "done"].contains(response.actionIdentifier) ? response.actionIdentifier : "open"
    await MainActor.run { self.onAction(ref, action) }
  }
}

/// News the Mac held for you while you were away, as it sends it (packages/core/src/phone.ts).
struct PhoneNews: Equatable {
  var id: String
  /// timer, reminder, task or briefing.
  var kind: String
  var title: String
  var text: String
  var at: Date
  /// The reminder or task it's about.
  var ref: String?

  init?(_ m: [String: Any]) {
    guard let id = m["id"] as? String, let text = m["text"] as? String else { return nil }
    self.id = id
    kind = m["kind"] as? String ?? "task"
    title = m["title"] as? String ?? "Nova"
    self.text = text
    at = (m["at"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) } ?? Date()
    ref = m["ref"] as? String
  }
}

/// A reminder or timer coming up, as the Mac sends it (packages/core/src/phone.ts).
struct PhoneReminder: Equatable {
  var id: String
  var title: String
  var body: String
  /// What it's for, in the user's words ("call mum"): what the widgets show.
  var what: String
  var due: Date
  var timer: Bool

  init?(_ m: [String: Any]) {
    guard let id = m["id"] as? String, let due = m["due"] as? NSNumber else { return nil }
    self.id = id
    title = m["title"] as? String ?? "Reminder"
    body = m["body"] as? String ?? ""
    what = m["what"] as? String ?? ""
    self.due = Date(timeIntervalSince1970: due.doubleValue / 1000)
    timer = m["timer"] as? Bool ?? false
  }
}
