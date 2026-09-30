// swift-tools-version: 6.2
import PackageDescription

// Nova's Apple model helper: Apple Intelligence's on-device model (the Foundation Models
// framework) answering Nova's open questions, with Nova's tools. The daemon builds and runs it.
let package = Package(
  name: "NovaAppleModel",
  platforms: [.macOS(.v26)],
  targets: [
    .executableTarget(
      name: "nova-apple-model",
      path: "Sources",
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
  ]
)
