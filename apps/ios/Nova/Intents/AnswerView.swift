import SwiftUI

/// Nova's answer as Siri, Spotlight and Shortcuts show it: what was asked, what Nova said - and, when it asked
/// something back, where to answer. It's drawn by the system over whatever is on screen, light or dark.
struct AnswerView: View {
  let answer: Answer
  let name: String

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      // The Orb, at rest: a snippet can't run the app's Metal one.
      Circle()
        .fill(RadialGradient(colors: [Color(red: 0.72, green: 0.8, blue: 1), Color(red: 0.42, green: 0.45, blue: 1), Color(red: 0.36, green: 0.18, blue: 0.78)], center: UnitPoint(x: 0.35, y: 0.3), startRadius: 1, endRadius: 24))
        .overlay(Circle().stroke(Color.white.opacity(0.3), lineWidth: 1))
        .shadow(color: Color(red: 0.42, green: 0.45, blue: 1).opacity(0.5), radius: 8)
        .frame(width: 34, height: 34)
      VStack(alignment: .leading, spacing: 6) {
        if !answer.heard.isEmpty {
          Text("“\(answer.heard)”").font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
        }
        Text(answer.text)
          .font(.body.weight(.medium))
          .foregroundStyle(answer.failed ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.primary))
          .fixedSize(horizontal: false, vertical: true)
        if answer.tap {
          Label("Allow it in \(name), with Face ID", systemImage: "faceid").font(.footnote.weight(.semibold)).foregroundStyle(Color.accentColor)
        } else if answer.asks {
          Label("Answer in \(name)", systemImage: "mic.fill").font(.footnote.weight(.semibold)).foregroundStyle(Color.accentColor)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(16)
  }
}
