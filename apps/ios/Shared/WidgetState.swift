import Foundation
import Security

/// What Nova's widgets show, as the app last heard it from the Mac. It's kept in the Keychain group the app and its
/// widgets share - the widgets can't reach the Mac themselves - and written again whenever the reminders or the agents'
/// tasks change. (A Keychain group rather than an app group: a free Apple account can't register app groups from the
/// command line, and Keychain groups need nothing registered. Compiled into both the app and the widgets.)
struct WidgetState: Codable, Equatable {
  struct Reminder: Codable, Equatable {
    /// In the user's words: "call mum", "the tea".
    var what: String
    var due: Date
    var timer: Bool

    /// What a widget calls it: "Call mum", or "Timer" for one with no name.
    var label: String {
      guard let first = what.first else { return timer ? "Timer" : "Reminder" }
      return first.uppercased() + what.dropFirst()
    }
  }

  /// An agent's task, as the task board had it.
  struct Work: Codable, Equatable {
    var agent: String
    var task: String
    /// running, done, failed or cancelled.
    var status: String
    var step: String?
  }

  /// The assistant's name.
  var name = "Nova"
  /// The Mac it's paired with ("Emmanuel's MacBook Pro"); nil when it isn't paired.
  var mac: String?
  var reminders: [Reminder] = []
  var work: [Work] = []
  /// When the app last heard from the Mac.
  var at = Date.distantPast

  /// The shared group, with the team's prefix: from the Info.plist, where the build writes it.
  private static let group = Bundle.main.object(forInfoDictionaryKey: "NovaSharedKeychain") as? String ?? ""

  private static var query: [String: Any] {
    var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "dev.nova.phone.widgets", kSecAttrAccount as String: "state"]
    if !group.isEmpty { q[kSecAttrAccessGroup as String] = group }
    return q
  }

  static func load() -> WidgetState? {
    var q = query
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var found: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &found) == errSecSuccess, let data = found as? Data else { return nil }
    return try? JSONDecoder().decode(WidgetState.self, from: data)
  }

  func save() {
    guard let data = try? JSONEncoder().encode(self) else { return }
    // Readable after the first unlock: the widgets are drawn on a locked phone too.
    let change: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    if SecItemUpdate(Self.query as CFDictionary, change as CFDictionary) == errSecItemNotFound {
      SecItemAdd(Self.query.merging(change) { $1 } as CFDictionary, nil)
    }
  }

  /// What's still to come after this moment, soonest first.
  func upcoming(after date: Date) -> [Reminder] {
    reminders.filter { $0.due > date }.sorted { $0.due < $1.due }
  }

  /// Agents at work, as last heard - for an hour at most: a task last seen running long ago has likely finished.
  func atWork(at date: Date) -> [Work] {
    date.timeIntervalSince(at) < 3600 ? work.filter { $0.status == "running" } : []
  }
}

/// Where the widgets and the control take you, handled by the app's `onOpenURL`.
enum NovaLink {
  /// Nova, listening - as if its talk button were tapped.
  static let talk = URL(string: "nova://talk")!
  /// The agents' task board.
  static let tasks = URL(string: "nova://tasks")!
}
