import Foundation

/// The door's protocol, as packages/core/src/phone.ts has it.
enum PhoneProtocol {
  static let version = 1

  /// What the phone signs to show it holds its key: this challenge, from this Mac, for this purpose.
  static func challenge(_ purpose: String, mac: String, nonce: String) -> String {
    "nova-phone:\(purpose):\(version):\(mac):\(nonce)"
  }

  /// Why the door closed the connection.
  enum Closed: UInt16 {
    /// An unknown or forgotten phone: pair it again.
    case unknown = 4401
    /// A pairing code that's wrong, used or run out.
    case refused = 4403
    /// Another version of the door.
    case version = 4426
    /// Too many wrong codes.
    case busy = 4429
    /// Over Tailscale, while the Mac's Settings → iPhone keeps Nova to the Wi-Fi.
    case away = 4404
  }

  /// A Tailscale address - 100.64.0.0/10, or fd7a:115c:a1e0::/48 - the way to the Mac from anywhere.
  static func isTailnet(_ address: String) -> Bool {
    let a = address.lowercased().replacingOccurrences(of: "::ffff:", with: "")
    guard a.contains(".") else { return a.hasPrefix("fd7a:115c:a1e0:") }
    let parts = a.split(separator: ".").compactMap { Int($0) }
    return parts.count == 4 && parts[0] == 100 && (64..<128).contains(parts[1])
  }
}

/// What the pairing QR code - and the same nova://pair link - carries.
struct PairingOffer: Equatable {
  var mac: String
  var name: String
  var hosts: [String]
  var port: Int
  var pin: String
  var code: String

  init?(link: String) {
    guard link.hasPrefix("nova://pair?"), let parts = URLComponents(string: link) else { return nil }
    var q: [String: String] = [:]
    for item in parts.queryItems ?? [] { q[item.name] = item.value ?? "" }
    guard q["v"] == String(PhoneProtocol.version), let mac = q["m"], let name = q["n"], let pin = q["k"], let code = q["c"],
      let port = Int(q["p"] ?? ""), (1...65535).contains(port), !mac.isEmpty, !pin.isEmpty, !code.isEmpty
    else { return nil }
    self.mac = mac
    self.name = name
    self.hosts = (q["h"] ?? "").split(separator: ",").map(String.init).filter { !$0.isEmpty }
    self.port = port
    self.pin = pin
    self.code = code
  }
}

/// The Mac this phone is paired with: how to find it, how to know it's the one, and who this phone is to it.
struct PairedMac: Codable, Equatable {
  var mac: String
  var name: String
  var hosts: [String]
  var port: Int
  var pin: String
  /// This phone's id on that Mac.
  var device: String

  private static let account = "mac"

  static func load() -> PairedMac? {
    Keychain.read(account).flatMap { try? JSONDecoder().decode(PairedMac.self, from: $0) }
  }

  func save() {
    if let data = try? JSONEncoder().encode(self) { Keychain.write(Self.account, data) }
  }

  static func forget() {
    Keychain.delete(account)
  }
}
