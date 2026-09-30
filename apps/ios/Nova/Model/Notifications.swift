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
    for item in coming.sorted(by: { $0.due < $1.due }).prefix(60) {
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

/// A reminder or timer coming up, as the Mac sends it (packages/core/src/phone.ts).
struct PhoneReminder: Equatable {
  var id: String
  var title: String
  var body: String
  var due: Date
  var timer: Bool

  init?(_ m: [String: Any]) {
    guard let id = m["id"] as? String, let due = m["due"] as? NSNumber else { return nil }
    self.id = id
    title = m["title"] as? String ?? "Reminder"
    body = m["body"] as? String ?? ""
    self.due = Date(timeIntervalSince1970: due.doubleValue / 1000)
    timer = m["timer"] as? Bool ?? false
  }
}
