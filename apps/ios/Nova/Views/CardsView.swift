import SwiftUI

/// Nova's cards, newest first: what it opened, answers, timers counting down, an agent's task at work - and
/// a question waiting for a yes or no, answered right here.
struct CardsView: View {
  @Environment(Nova.self) private var nova

  var body: some View {
    ScrollView {
      VStack(spacing: 10) {
        ForEach(nova.cards) { card in
          CardRow(card: card)
            .transition(.asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .opacity))
        }
      }
      .animation(.spring(response: 0.35, dampingFraction: 0.85), value: nova.cards)
    }
    .scrollIndicators(.hidden)
    .frame(maxHeight: 260)
  }
}

private struct CardRow: View {
  @Environment(Nova.self) private var nova
  let card: Card

  private var icon: String {
    switch card.kind {
    case "app": return "app.badge"
    case "time": return "clock"
    case "timer": return "timer"
    case "reminder": return "bell"
    case "confirm": return "exclamationmark.triangle"
    case "error": return "xmark.octagon"
    case "answer": return "sparkles"
    case "task": return "asterisk"
    default: return "info.circle"
    }
  }

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: icon)
        .font(.body.weight(.semibold))
        .foregroundStyle(card.kind == "confirm" ? Style.warn : Style.accent)
        .frame(width: 34, height: 34)
        .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      VStack(alignment: .leading, spacing: 4) {
        Text(card.title).font(.subheadline.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
        if let body = card.body {
          Text(body).font(card.kind == "task" ? .footnote.monospaced() : .footnote).foregroundStyle(Style.dim).lineLimit(card.kind == "answer" ? 8 : 3)
        }
        if let ends = card.endsAt {
          TimelineView(.periodic(from: .now, by: 1)) { context in
            let left = max(0, Int(ends.timeIntervalSince(context.date)))
            Text(String(format: "%d:%02d", left / 60, left % 60)).font(.title2.monospacedDigit().weight(.bold))
          }
        }
        if card.kind == "confirm" {
          HStack(spacing: 10) {
            Button("No") { nova.answer(false) }
              .buttonStyle(.bordered)
            Button("Yes") { nova.answer(true) }
              .buttonStyle(.borderedProminent)
          }
          .padding(.top, 4)
        }
      }
      Spacer(minLength: 0)
      Button { nova.dismiss(card.id) } label: {
        Image(systemName: "xmark").font(.caption.weight(.bold)).foregroundStyle(Style.faint)
      }
      .accessibilityLabel("Dismiss")
    }
    .foregroundStyle(.white)
    .padding(14)
    .glass(radius: 18)
  }
}
