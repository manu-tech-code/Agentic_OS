import SwiftUI

/// The window's look, for the iPhone: deep blue to violet behind frosted glass.
enum Style {
  static let accent = Color(red: 0.42, green: 0.66, blue: 1)
  static let dim = Color.white.opacity(0.62)
  static let faint = Color.white.opacity(0.38)
  static let ok = Color(red: 0.2, green: 0.83, blue: 0.6)
  static let warn = Color(red: 0.98, green: 0.75, blue: 0.14)
}

/// The wallpaper behind everything: the window's three soft blobs. They're an overlay, so they never widen the screen.
struct Backdrop: View {
  var body: some View {
    Color(red: 0.03, green: 0.03, blue: 0.08)
      .overlay {
        ZStack {
          Circle().fill(Color(red: 0.23, green: 0.36, blue: 1)).frame(width: 520, height: 520).blur(radius: 120).offset(x: -150, y: -330).opacity(0.55)
          Circle().fill(Color(red: 0.61, green: 0.3, blue: 1)).frame(width: 560, height: 560).blur(radius: 130).offset(x: 170, y: 380).opacity(0.5)
          Circle().fill(Color(red: 0, green: 0.76, blue: 1)).frame(width: 300, height: 300).blur(radius: 110).offset(x: 90, y: 40).opacity(0.22)
        }
      }
      .clipped()
      .ignoresSafeArea()
  }
}

/// Frosted glass, as the window's `.glass`.
struct Glass: ViewModifier {
  var radius: CGFloat = 22
  func body(content: Content) -> some View {
    content
      .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).stroke(Color.white.opacity(0.12), lineWidth: 1))
  }
}

extension View {
  func glass(radius: CGFloat = 22) -> some View { modifier(Glass(radius: radius)) }
}

/// What Nova is doing, in words (the window's Live Pill).
func phaseText(_ phase: String, label: String?) -> String {
  let pretty = label.map { $0.replacingOccurrences(of: "_", with: " ") }
  switch phase {
  case "listening": return "Listening"
  case "thinking": return pretty.map { "Thinking · \($0)" } ?? "Thinking"
  case "acting": return pretty.map { "On it · \($0)" } ?? "On it"
  case "speaking": return "Speaking"
  default: return "Ready"
  }
}
