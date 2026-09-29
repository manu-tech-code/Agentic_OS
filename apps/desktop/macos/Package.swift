// swift-tools-version: 6.2
import PackageDescription

// Nova.app: Nova in the menu bar. It hears (the microphone, with Apple's echo cancellation) and
// speaks for Nova, comes when you press the shortcut, shows a floating orb with what it hears and
// says, opens at login and runs the daemon. `npm run app` builds it here and puts it in ~/Applications.
let package = Package(
  name: "Nova",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(name: "Nova", path: "Sources", swiftSettings: [.swiftLanguageMode(.v5)]),
  ]
)
