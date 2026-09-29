import Foundation
import Security

/// Small things kept in this iPhone's Keychain, for this app alone and never synced to iCloud: the phone's
/// key, and the Mac it's paired with.
enum Keychain {
  private static let service = "dev.nova.phone"

  private static func query(_ account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  static func read(_ account: String) -> Data? {
    var q = query(account)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var found: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &found) == errSecSuccess else { return nil }
    return found as? Data
  }

  @discardableResult
  static func write(_ account: String, _ data: Data) -> Bool {
    SecItemDelete(query(account) as CFDictionary)
    var q = query(account)
    q[kSecValueData as String] = data
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
  }

  static func delete(_ account: String) {
    SecItemDelete(query(account) as CFDictionary)
  }
}
