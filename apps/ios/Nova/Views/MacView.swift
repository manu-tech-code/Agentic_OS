import SwiftUI

/// The Mac this iPhone is paired with: the connection, where what you say is heard, and unpairing.
struct MacView: View {
  @Environment(Nova.self) private var nova
  @Environment(\.dismiss) private var dismiss
  @State private var installing = false
  @State private var confirming = false

  var body: some View {
    NavigationStack {
      List {
        Section("Your Mac") {
          LabeledContent("Paired with", value: nova.mac?.name ?? "-")
          LabeledContent("Connection", value: connection)
          if let hosts = nova.mac?.hosts, !hosts.isEmpty {
            LabeledContent("Addresses", value: hosts.joined(separator: ", "))
          }
        }
        Section {
          LabeledContent("Heard", value: heardWhere)
          LabeledContent("Mac's recognizer", value: nova.macHearing.ready ? "ready" : (nova.macHearing.message ?? "not ready"))
          LabeledContent("This iPhone's", value: nova.phoneHearingReady ? "ready" : "not downloaded")
          if !nova.phoneHearingReady {
            Button(installing ? "Downloading…" : "Download Apple's speech model to this iPhone") {
              installing = true
              Task {
                await nova.installPhoneHearing()
                installing = false
              }
            }
            .disabled(installing)
          }
        } header: {
          Text("What you say")
        } footer: {
          Text("Nova on the Mac hears what you say into this iPhone, as it hears you at the Mac. When the connection is weak - or the Mac's Settings → iPhone says so - Apple's recognizer on this iPhone does it, and only the text goes to the Mac. Change it in Settings → iPhone on the Mac.")
        }
        Section {
          Button("Unpair this iPhone", role: .destructive) { confirming = true }
        } footer: {
          Text("To stop it connecting from the Mac's side too, forget it in Nova's Settings → iPhone.")
        }
      }
      .navigationTitle("This iPhone")
      .navigationBarTitleDisplayMode(.inline)
      .confirmationDialog("Unpair this iPhone from \(nova.mac?.name ?? "your Mac")?", isPresented: $confirming, titleVisibility: .visible) {
        Button("Unpair", role: .destructive) {
          nova.unpair()
          dismiss()
        }
      }
    }
  }

  private var connection: String {
    switch nova.link {
    case .connected: return "connected"
    case .connecting: return "connecting…"
    case .offline(let why): return why
    case .lost(let why): return why
    case .unpaired: return "not paired"
    }
  }

  private var heardWhere: String {
    switch nova.hearingMode {
    case "iphone": return "on this iPhone"
    case "mac": return "on the Mac"
    default: return "on the Mac, or this iPhone on a weak connection"
    }
  }
}
