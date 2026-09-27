import AppKit

// `Nova --selftest` checks what needs no microphone, speaker or daemon.
if CommandLine.arguments.contains("--selftest") { exit(SelfTest.run() ? 0 : 1) }

// One Nova at a time: opening it again shows the running one's window.
if let id = Bundle.main.bundleIdentifier,
   NSRunningApplication.runningApplications(withBundleIdentifier: id).contains(where: { $0 != NSRunningApplication.current }) {
  DistributedNotificationCenter.default().postNotificationName(.init("dev.nova.app.open"), object: nil, userInfo: nil, deliverImmediately: true)
  exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // the menu bar, no Dock icon - until the window opens
app.run()
