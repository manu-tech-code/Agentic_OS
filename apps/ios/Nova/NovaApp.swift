import SwiftUI

/// Nova on the iPhone: the same Nova as on the Mac - heard and answered there - in your pocket.
@main
struct NovaApp: App {
  @State private var nova = Nova()
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(nova)
        .preferredColorScheme(.dark)
        // A pairing link: from AirDrop, a message, or the Simulator (xcrun simctl openurl booted "nova://pair?…").
        .onOpenURL { url in nova.pair(link: url.absoluteString) }
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { nova.resume() }
    }
  }
}

struct RootView: View {
  @Environment(Nova.self) private var nova

  var body: some View {
    if nova.mac == nil {
      PairView()
    } else {
      HomeView()
    }
  }
}
