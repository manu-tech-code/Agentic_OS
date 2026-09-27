// swift-tools-version: 6.2
import PackageDescription

// Nova's hearing helper: speech to text on this Mac, with Apple's on-device recognizer or
// NVIDIA Parakeet on the Neural Engine (through FluidAudio). The daemon builds and runs it.
let package = Package(
  name: "NovaHearing",
  platforms: [.macOS(.v26)],
  dependencies: [
    // Parakeet on the Neural Engine: FluidAudio 0.17.4, fetched and prepared by `npm run hearing:build`
    // (src/hearing/build.ts), which leaves out its optional prebuilt text-normalization binary.
    .package(path: ".vendor/FluidAudio"),
  ],
  targets: [
    .executableTarget(
      name: "nova-hearing",
      dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
      path: "Sources",
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
  ]
)
