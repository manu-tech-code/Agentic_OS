import Darwin
import Foundation
import Security

/// Who may use Nova Eyes: only the daemon Nova.app runs - checked by code signature, never by name.
///
/// Anything could start Nova Eyes and name itself as its client, so that alone proves nothing. Signed
/// with the user's Apple certificate, Nova Eyes answers a client only when the client's parent is
/// Nova.app signed by the same team - which only the user's own certificate can sign, and which runs
/// hardened, so nothing else can be injected into it. Signed for this Mac alone (no team), there's
/// nothing to check against: then only the client's pid counts, as before.
enum CallerLock {
  /// The team Nova Eyes itself is signed by; nil when it's signed ad hoc.
  static let team: String? = ownTeam()

  /// Nova.app as Nova Eyes knows it: its id, and a certificate Apple issued to this team.
  static func requirement(team: String) -> String {
    "identifier \"dev.nova.app\" and anchor apple generic and certificate leaf[subject.OU] = \"\(team)\""
  }

  /// Whether `client` (the process Nova Eyes was started for) is the daemon Nova.app runs.
  static func allows(client: pid_t) -> Bool {
    guard let team else { return true }
    let parent = parentPid(of: client)
    guard parent > 1 else { return false } // its parent gone: it's launchd's now
    return satisfies(pid: parent, requirement: requirement(team: team))
  }

  static func parentPid(of pid: pid_t) -> pid_t {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    let ok = mib.withUnsafeMutableBufferPointer { sysctl($0.baseAddress, 4, &info, &size, nil, 0) } == 0
    return ok && size > 0 ? info.kp_eproc.e_ppid : 0
  }

  /// Whether the running process `pid` is signed as `requirement` says - its code as it runs, not a file.
  static func satisfies(pid: pid_t, requirement text: String) -> Bool {
    var code: SecCode?
    let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess, let code else { return false }
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess, let requirement else { return false }
    return SecCodeCheckValidity(code, [], requirement) == errSecSuccess
  }

  private static func ownTeam() -> String? {
    var me: SecCode?
    guard SecCodeCopySelf([], &me) == errSecSuccess, let me else { return nil }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(me, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
      let dict = info as? [String: Any],
      let team = dict[kSecCodeInfoTeamIdentifier as String] as? String,
      team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil
    else { return nil }
    return team
  }
}
