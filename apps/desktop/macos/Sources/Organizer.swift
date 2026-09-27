import AppKit
import CoreMediaIO
import EventKit
import UserNotifications

/// The Calendar and Reminders apps, for Nova: today's events (for the briefing, and to stay quiet in
/// meetings) and reminders that reach the iPhone. macOS asks the user the first time each is needed.
/// Asked to complete or remove a reminder that isn't there any more (already done elsewhere, or its id
/// is stale) - so the caller reports failure instead of a success that didn't actually do anything.
struct ReminderNotFound: LocalizedError {
  var errorDescription: String? { "That reminder isn't there any more." }
}

final class Organizer {
  private let store = EKEventStore()

  static func access(_ type: EKEntityType) -> String {
    switch EKEventStore.authorizationStatus(for: type) {
    case .fullAccess: return "granted"
    case .denied, .writeOnly: return "denied"
    case .restricted: return "restricted"
    default: return "undetermined"
    }
  }

  /// Ask macOS (its own prompt) if it hasn't been asked, then say whether Nova may.
  func ensure(_ type: EKEntityType, _ done: @escaping (Bool) -> Void) {
    switch Organizer.access(type) {
    case "granted": return done(true)
    case "undetermined": break
    default: return done(false)
    }
    let answer: (Bool, Error?) -> Void = { granted, _ in DispatchQueue.main.async { done(granted) } }
    if type == .event { store.requestFullAccessToEvents(completion: answer) } else { store.requestFullAccessToReminders(completion: answer) }
  }

  func events(from: Date, to: Date) -> [[String: Any]] {
    let predicate = store.predicateForEvents(withStart: from, end: to, calendars: nil)
    return store.events(matching: predicate).map { event in
      [
        "title": event.title ?? "Event",
        "start": ms(event.startDate),
        "end": ms(event.endDate),
        "allDay": event.isAllDay,
        "attendees": event.attendees?.count ?? 0,
        "location": event.location ?? "",
        "call": Organizer.hasCall(event),
      ]
    }
  }

  /// A video call link in the event: a meeting, even with no one else invited yet.
  private static func hasCall(_ event: EKEvent) -> Bool {
    let text = [event.url?.absoluteString, event.location, event.notes].compactMap { $0 }.joined(separator: " ").lowercased()
    return ["zoom.us", "meet.google.com", "teams.microsoft.com", "facetime", "webex.com", "whereby.com", "around.co"].contains { text.contains($0) }
  }

  func addReminder(title: String, due: Date?, list: String) throws -> String {
    let reminder = EKReminder(eventStore: store)
    reminder.title = title
    reminder.calendar = store.calendars(for: .reminder).first { !list.isEmpty && $0.title.caseInsensitiveCompare(list) == .orderedSame } ?? store.defaultCalendarForNewReminders()
    if let due {
      reminder.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: due)
      reminder.addAlarm(EKAlarm(absoluteDate: due))
    }
    try store.save(reminder, commit: true)
    return reminder.calendarItemIdentifier
  }

  /// Not yet done: due within `days`, or with no date (at most 200).
  func reminders(days: Int, _ done: @escaping ([[String: Any]]) -> Void) {
    let until = Date().addingTimeInterval(Double(days) * 86_400)
    store.fetchReminders(matching: store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)) { found in
      let items: [[String: Any]] = (found ?? []).compactMap { reminder in
        let due = reminder.dueDateComponents.flatMap { Calendar.current.date(from: $0) }
        if let due, due > until { return nil }
        return ["id": reminder.calendarItemIdentifier, "title": reminder.title ?? "", "due": due.map { (($0.timeIntervalSince1970 * 1000).rounded()) } ?? NSNull()]
      }
      DispatchQueue.main.async { done(Array(items.prefix(200))) }
    }
  }

  func complete(_ id: String) throws {
    guard let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else { throw ReminderNotFound() }
    reminder.isCompleted = true
    try store.save(reminder, commit: true)
  }

  func remove(_ id: String) throws {
    guard let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else { throw ReminderNotFound() }
    try store.remove(reminder, commit: true)
  }

  private func ms(_ date: Date) -> Double { (date.timeIntervalSince1970 * 1000).rounded() }
}

/// Nova's notifications: reminders with Snooze and Done, and news from the agents.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
  var onAction: (String, String) -> Void = { _, _ in }
  var onOpen: () -> Void = {}
  private(set) var access = "undetermined"
  private let center = UNUserNotificationCenter.current()

  func setUp() {
    center.delegate = self
    let snooze = UNNotificationAction(identifier: "snooze", title: "Snooze 10 Minutes")
    let done = UNNotificationAction(identifier: "done", title: "Done")
    center.setNotificationCategories([UNNotificationCategory(identifier: "reminder", actions: [snooze, done], intentIdentifiers: [])])
    refresh()
  }

  func refresh(_ then: (() -> Void)? = nil) {
    center.getNotificationSettings { settings in
      let access: String
      switch settings.authorizationStatus {
      case .authorized, .provisional, .ephemeral: access = "granted"
      case .denied: access = "denied"
      default: access = "undetermined"
      }
      DispatchQueue.main.async {
        self.access = access
        then?()
      }
    }
  }

  func request(_ then: @escaping () -> Void) {
    center.requestAuthorization(options: [.alert, .sound]) { _, _ in self.refresh(then) }
  }

  func post(ref: String, title: String, body: String, actions: Bool) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.userInfo = ["ref": ref]
    if actions { content.categoryIdentifier = "reminder" }
    center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
    [.banner, .list]
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
    let ref = response.notification.request.content.userInfo["ref"] as? String ?? ""
    let action = response.actionIdentifier
    await MainActor.run {
      if action == "snooze" || action == "done" { self.onAction(ref, action) } else if action == UNNotificationDefaultActionIdentifier { self.onOpen() }
    }
  }
}

/// Whether the user is here: a camera on (a call, most likely), and how long since they last typed or clicked.
enum UserPresence {
  static func cameraOn() -> Bool {
    var address = CMIOObjectPropertyAddress(mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyDevices), mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
                                            mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
    var size: UInt32 = 0
    guard CMIOObjectGetPropertyDataSize(CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil, &size) == 0, size > 0 else { return false }
    var devices = [CMIODeviceID](repeating: 0, count: Int(size) / MemoryLayout<CMIODeviceID>.size)
    var used: UInt32 = 0
    guard CMIOObjectGetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil, size, &used, &devices) == 0 else { return false }
    for device in devices {
      var running: UInt32 = 0
      var runningAddress = CMIOObjectPropertyAddress(mSelector: CMIOObjectPropertySelector(kCMIODevicePropertyDeviceIsRunningSomewhere), mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeWildcard),
                                                     mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementWildcard))
      var got: UInt32 = 0
      if CMIOObjectGetPropertyData(device, &runningAddress, 0, nil, UInt32(MemoryLayout<UInt32>.size), &got, &running) == 0, running != 0 { return true }
    }
    return false
  }

  static func idleSeconds() -> Double {
    let types: [CGEventType] = [.keyDown, .mouseMoved, .leftMouseDown, .rightMouseDown, .scrollWheel, .flagsChanged]
    return types.map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? 0
  }
}
