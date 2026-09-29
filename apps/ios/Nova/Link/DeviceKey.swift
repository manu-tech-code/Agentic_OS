import CryptoKit
import Foundation

/// The phone's own key, made once. In the Secure Enclave when the phone has one - its private half never
/// leaves it - otherwise (the Simulator) kept in the Keychain. It signs the Mac's challenge every time the
/// phone connects, which is how the Mac knows it's this phone.
struct DeviceKey {
  /// The public half, as the Mac keeps it: P-256, SPKI DER.
  let publicKey: Data
  private let signer: (Data) throws -> Data

  private static let enclaveAccount = "device-key.enclave"
  private static let plainAccount = "device-key"

  static func load() throws -> DeviceKey {
    if SecureEnclave.isAvailable {
      if let blob = Keychain.read(enclaveAccount), let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob) {
        return DeviceKey(key)
      }
      let key = try SecureEnclave.P256.Signing.PrivateKey()
      Keychain.write(enclaveAccount, key.dataRepresentation)
      return DeviceKey(key)
    }
    if let raw = Keychain.read(plainAccount), let key = try? P256.Signing.PrivateKey(rawRepresentation: raw) {
      return DeviceKey(key)
    }
    let key = P256.Signing.PrivateKey()
    Keychain.write(plainAccount, key.rawRepresentation)
    return DeviceKey(key)
  }

  /// A fresh key for a fresh pairing: the Mac will know this phone by the new one.
  static func reset() {
    Keychain.delete(enclaveAccount)
    Keychain.delete(plainAccount)
  }

  private init(_ key: SecureEnclave.P256.Signing.PrivateKey) {
    publicKey = key.publicKey.derRepresentation
    signer = { try key.signature(for: $0).derRepresentation }
  }

  private init(_ key: P256.Signing.PrivateKey) {
    publicKey = key.publicKey.derRepresentation
    signer = { try key.signature(for: $0).derRepresentation }
  }

  /// An ECDSA signature (SHA-256, DER) of the text, as the Mac checks it.
  func sign(_ text: String) throws -> Data {
    try signer(Data(text.utf8))
  }
}
