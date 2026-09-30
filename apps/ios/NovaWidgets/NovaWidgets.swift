import AppIntents
import SwiftUI
import WidgetKit

// Nova on the Home Screen, the Lock Screen, StandBy and in Control Center. The widgets show what the app last heard
// from the Mac (`WidgetState`, in the app group they share): what's coming up and what the agents are doing. A tap
// talks to Nova (nova://talk). The control runs Talk to Nova (Shared/TalkToNova.swift), which iOS opens the app to
// do - for Control Center, the Lock Screen and the Action button. None of it reaches the Mac itself: that's the app's job.

@main
struct NovaWidgets: WidgetBundle {
  var body: some Widget {
    NovaWidget()
    TalkControl()
  }
}

// MARK: - The widget

struct NovaEntry: TimelineEntry {
  let date: Date
  let state: WidgetState
}

struct NovaTimeline: TimelineProvider {
  func placeholder(in context: Context) -> NovaEntry {
    NovaEntry(date: .now, state: .preview)
  }

  func getSnapshot(in context: Context, completion: @escaping (NovaEntry) -> Void) {
    completion(NovaEntry(date: .now, state: context.isPreview ? .preview : WidgetState.load() ?? WidgetState()))
  }

  /// Now, and again as each reminder comes due - so "next" moves on by itself, with the app closed.
  func getTimeline(in context: Context, completion: @escaping (Timeline<NovaEntry>) -> Void) {
    let state = WidgetState.load() ?? WidgetState()
    let now = Date()
    let dues = state.upcoming(after: now).prefix(24).map { $0.due.addingTimeInterval(1) }
    let entries = [NovaEntry(date: now, state: state)] + dues.map { NovaEntry(date: $0, state: state) }
    // After the last reminder - or in an hour, when agents last seen at work no longer count - it's drawn afresh.
    completion(Timeline(entries: entries, policy: .after(dues.last ?? now.addingTimeInterval(3600))))
  }
}

struct NovaWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "dev.nova.phone.nova", provider: NovaTimeline()) { entry in
      NovaWidgetView(entry: entry)
    }
    .configurationDisplayName("Nova")
    .description("What's coming up and what your agents are doing - and a tap to talk to Nova.")
    .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
  }
}

struct NovaWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: NovaEntry

  private var state: WidgetState { entry.state }
  private var next: [WidgetState.Reminder] { state.upcoming(after: entry.date) }
  private var atWork: [WidgetState.Work] { state.atWork(at: entry.date) }

  var body: some View {
    switch family {
    case .accessoryCircular: circular
    case .accessoryRectangular: rectangular
    case .accessoryInline: inline
    case .systemMedium: medium
    default: small
    }
  }

  // MARK: Home Screen and StandBy

  private var small: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        WidgetOrb(size: 30)
        Spacer()
        Image(systemName: "waveform").font(.subheadline.weight(.semibold)).foregroundStyle(.white.opacity(0.8))
      }
      Spacer(minLength: 0)
      if let first = next.first {
        Text("Next").font(.caption2.weight(.semibold)).foregroundStyle(.white.opacity(0.6)).textCase(.uppercase)
        ReminderLine(reminder: first, now: entry.date, big: true)
      } else if state.mac == nil {
        Text("Pair Nova with your Mac").font(.subheadline.weight(.semibold)).foregroundStyle(.white)
      } else {
        Text("Tap to talk").font(.headline).foregroundStyle(.white)
        Text(atWork.isEmpty ? "Nothing coming up" : agentsLine).font(.caption).foregroundStyle(.white.opacity(0.65)).lineLimit(2)
      }
    }
    .containerBackground(for: .widget) { WidgetBackdrop() }
    .widgetURL(NovaLink.talk)
  }

  private var medium: some View {
    HStack(alignment: .top, spacing: 14) {
      // Talk: the left of the widget; the rest opens the task board.
      Link(destination: NovaLink.talk) {
        VStack(alignment: .leading, spacing: 8) {
          WidgetOrb(size: 40)
          Spacer(minLength: 0)
          Text(state.name).font(.headline).foregroundStyle(.white)
          Label("Talk", systemImage: "waveform").font(.caption.weight(.semibold)).foregroundStyle(.white.opacity(0.8))
        }
      }
      VStack(alignment: .leading, spacing: 6) {
        if next.isEmpty {
          Text(state.mac == nil ? "Pair Nova with your Mac" : "Nothing coming up").font(.subheadline).foregroundStyle(.white.opacity(0.7))
        } else {
          ForEach(Array(next.prefix(3).enumerated()), id: \.offset) { _, reminder in
            ReminderLine(reminder: reminder, now: entry.date, big: false)
          }
        }
        Spacer(minLength: 0)
        if !atWork.isEmpty {
          Label(agentsLine, systemImage: "asterisk").font(.caption).foregroundStyle(.white.opacity(0.75)).lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .containerBackground(for: .widget) { WidgetBackdrop() }
    .widgetURL(NovaLink.tasks)
  }

  /// "Claude: fixing the tests", or "2 agents at work".
  private var agentsLine: String {
    guard atWork.count == 1, let one = atWork.first else { return "\(atWork.count) agents at work" }
    return "\(one.agent): \(one.step ?? one.task)"
  }

  // MARK: Lock Screen

  private var circular: some View {
    ZStack {
      AccessoryWidgetBackground()
      Image(systemName: "waveform").font(.title3.weight(.semibold))
    }
    .containerBackground(for: .widget) { Color.clear }
    .widgetURL(NovaLink.talk)
  }

  private var rectangular: some View {
    VStack(alignment: .leading, spacing: 2) {
      Label(state.name, systemImage: "waveform").font(.headline).widgetAccentable()
      if let first = next.first {
        Text(first.label).font(.body).lineLimit(1).privacySensitive()
        (first.timer ? Text(first.due, style: .timer) : Text(first.due, style: .time)).font(.caption)
      } else {
        Text("Tap to talk").font(.body)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .containerBackground(for: .widget) { Color.clear }
    .widgetURL(NovaLink.talk)
  }

  private var inline: some View {
    Group {
      if let first = next.first {
        Text("\(first.label) · \(first.due, style: .time)").privacySensitive()
      } else {
        Text("Talk to \(state.name)")
      }
    }
    .containerBackground(for: .widget) { Color.clear }
    .widgetURL(NovaLink.talk)
  }
}

/// A reminder: what it's for, and when - a timer counts down.
private struct ReminderLine: View {
  let reminder: WidgetState.Reminder
  let now: Date
  let big: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      Label(reminder.label, systemImage: reminder.timer ? "timer" : "bell")
        .font(big ? .subheadline.weight(.semibold) : .caption.weight(.semibold))
        .foregroundStyle(.white)
        .lineLimit(big ? 2 : 1)
        .privacySensitive()
      Group {
        if reminder.timer {
          Text(reminder.due, style: .timer)
        } else if Calendar.current.isDate(reminder.due, inSameDayAs: now) {
          Text(reminder.due, style: .time)
        } else {
          Text(reminder.due.formatted(.dateTime.weekday(.abbreviated).hour().minute()))
        }
      }
      .font(.caption2)
      .foregroundStyle(.white.opacity(0.65))
    }
  }
}

/// The Orb, still: a widget can't run the app's Metal one.
private struct WidgetOrb: View {
  let size: CGFloat

  var body: some View {
    Circle()
      .fill(RadialGradient(colors: [Color(red: 0.72, green: 0.8, blue: 1), Color(red: 0.42, green: 0.45, blue: 1), Color(red: 0.36, green: 0.18, blue: 0.78)], center: UnitPoint(x: 0.35, y: 0.3), startRadius: 1, endRadius: size * 0.7))
      .overlay(Circle().stroke(Color.white.opacity(0.3), lineWidth: 1))
      .shadow(color: Color(red: 0.42, green: 0.45, blue: 1).opacity(0.6), radius: size / 4)
      .frame(width: size, height: size)
  }
}

/// The app's wallpaper, for a widget: deep blue to violet.
private struct WidgetBackdrop: View {
  var body: some View {
    LinearGradient(colors: [Color(red: 0.09, green: 0.11, blue: 0.32), Color(red: 0.2, green: 0.09, blue: 0.36)], startPoint: .topLeading, endPoint: .bottomTrailing)
  }
}

extension WidgetState {
  /// What the widget gallery shows before the app has written anything.
  static let preview = WidgetState(
    name: "Nova", mac: "Nova on your Mac",
    reminders: [
      .init(what: "call mum", due: Date().addingTimeInterval(3600), timer: false),
      .init(what: "the tea", due: Date().addingTimeInterval(240), timer: true),
    ],
    work: [.init(agent: "Claude", task: "fix the tests", status: "running", step: "running the tests")], at: Date())
}

// MARK: - The control

/// Talk to Nova from Control Center, the Lock Screen or the Action button: Nova opens, listening.
struct TalkControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: "dev.nova.phone.talk") {
      ControlWidgetButton(action: TalkToNova()) {
        Label("Talk to Nova", systemImage: "waveform")
      }
    }
    .displayName("Talk to Nova")
    .description("Opens Nova, listening: say what you want, and it hears the end when you pause.")
  }
}
