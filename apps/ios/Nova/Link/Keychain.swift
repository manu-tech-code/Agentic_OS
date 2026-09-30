import Foundation
import os
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
    let status = SecItemAdd(q as CFDictionary, nil)
    // An app built without signing (the Simulator's -34018) has no Keychain: nothing it keeps outlasts it.
    if status != errSecSuccess { Logger(subsystem: "dev.nova.phone", category: "keychain").error("keychain: couldn't keep \(account, privacy: .public): \(status)") }
    return status == errSecSuccess
  }

  static func delete(_ account: String) {
    SecItemDelete(query(account) as CFDictionary)
  }
}
