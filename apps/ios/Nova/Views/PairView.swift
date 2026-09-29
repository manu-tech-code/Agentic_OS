import SwiftUI
import VisionKit

/// Not paired yet (or the Mac forgot this phone): how to pair, and the camera for the code.
struct PairView: View {
  @Environment(Nova.self) private var nova
  @State private var scanning = false

  var body: some View {
    VStack(spacing: 22) {
      Spacer()
      OrbView(phase: nova.link == .connecting ? "thinking" : "idle", level: 0).frame(width: 200, height: 200)
      Text("Nova on your iPhone").font(.largeTitle.weight(.bold))
      if case .lost(let why) = nova.link {
        Text(why).font(.callout).foregroundStyle(Style.warn).multilineTextAlignment(.center)
      }
      VStack(alignment: .leading, spacing: 12) {
        step(1, "On your Mac, open Nova's Settings → iPhone.")
        step(2, "Turn on “Let your iPhone connect”, then press Pair an iPhone.")
        step(3, "Scan the code with this iPhone - on the same Wi-Fi.")
      }
      .padding(18)
      .glass()
      if nova.link == .connecting {
        ProgressView("Pairing with your Mac…").tint(.white)
      } else {
        Button {
          scanning = true
        } label: {
          Label("Scan the code", systemImage: "qrcode.viewfinder").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 16)
        }
        .buttonStyle(.borderedProminent)
        .disabled(!DataScannerViewController.isSupported)
        Button("Paste a pairing link") {
          if let link = UIPasteboard.general.string { nova.pair(link: link) }
        }
        .font(.subheadline)
      }
      Spacer()
      Text("Pairing lets this iPhone - and nothing else - reach Nova on your Mac: the Mac is checked by its certificate, and this iPhone signs in with a key only it holds.")
        .font(.footnote).foregroundStyle(Style.faint).multilineTextAlignment(.center)
    }
    .foregroundStyle(.white)
    .padding(24)
    .background { Backdrop() }
    .overlay(alignment: .top) { NoticeView() }
    .sheet(isPresented: $scanning) {
      ScannerView { link in
        scanning = false
        nova.pair(link: link)
      }
      .ignoresSafeArea()
    }
  }

  private func step(_ n: Int, _ text: String) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Text("\(n)").font(.subheadline.weight(.bold)).frame(width: 24, height: 24).background(Style.accent.opacity(0.35), in: Circle())
      Text(text).font(.subheadline).fixedSize(horizontal: false, vertical: true)
    }
  }
}

/// The camera, looking for Nova's pairing code.
struct ScannerView: UIViewControllerRepresentable {
  var found: (String) -> Void

  func makeUIViewController(context: Context) -> DataScannerViewController {
    let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, isHighlightingEnabled: true)
    scanner.delegate = context.coordinator
    try? scanner.startScanning()
    return scanner
  }

  func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {}

  func makeCoordinator() -> Coordinator { Coordinator(found: found) }

  final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    let found: (String) -> Void
    private var done = false

    init(found: @escaping (String) -> Void) {
      self.found = found
    }

    func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
      for item in items {
        guard !done, case .barcode(let code) = item, let text = code.payloadStringValue, text.hasPrefix("nova://pair?") else { continue }
        done = true
        scanner.stopScanning()
        found(text)
      }
    }
  }
}
