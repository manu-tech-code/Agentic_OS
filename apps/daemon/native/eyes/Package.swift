// swift-tools-version: 6.2
import PackageDescription

// Nova Eyes: what's on screen, for Nova - the app in front, its window, the browser page, the
// selected text, and a screenshot read with Apple's on-device text recognition. It runs as its own
// small background app, so macOS asks for permissions in its name, not the terminal's.
let package = Package(
  name: "NovaEyes",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(name: "nova-eyes", path: "Sources", swiftSettings: [.swiftLanguageMode(.v5)]),
  ]
)
