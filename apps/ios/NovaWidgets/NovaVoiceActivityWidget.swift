import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// Nova thinking about, then saying, its answer to you, once you've left it: in the Dynamic Island - bars that move with
/// its voice while it speaks - and on the Lock Screen, with what it's saying and Stop. It's gone as soon as Nova is done.
struct NovaVoiceActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: NovaVoiceActivity.self) { context in
      VoiceLockScreen(context: context)
        .activityBackgroundTint(Color(red: 0.08, green: 0.09, blue: 0.26).opacity(0.9))
        .activitySystemActionForegroundColor(.white)
    } dynamicIsland: { context in
      let speaking = context.state.phase == "speaking"
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          HStack(spacing: 8) {
            VoiceOrb(size: 26)
            Text(context.attributes.name).font(.headline)
          }
        }
        DynamicIslandExpandedRegion(.trailing) {
          Button(intent: StopNovaSpeaking()) {
            Image(systemName: "stop.fill").font(.headline).padding(6)
          }
          .tint(.red)
          .accessibilityLabel("Stop")
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
              VoiceSign(state: context.state, height: 11)
              Text(speaking ? "Speaking" : "Thinking…")
            }
            .font(.caption.weight(.semibold)).foregroundStyle(voiceAccent)
            if !context.state.text.isEmpty {
              Text(context.state.text).font(.subheadline).lineLimit(3)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      } compactLeading: {
        VoiceSign(state: context.state, height: 16).foregroundStyle(voiceAccent)
      } compactTrailing: {
        Text(context.attributes.name).font(.caption.weight(.semibold)).foregroundStyle(voiceAccent)
      } minimal: {
        VoiceSign(state: context.state, height: 14).foregroundStyle(voiceAccent)
      }
      .keylineTint(voiceAccent)
    }
  }
}

private let voiceAccent = Color(red: 0.55, green: 0.62, blue: 1)

private struct VoiceLockScreen: View {
  let context: ActivityViewContext<NovaVoiceActivity>

  var body: some View {
    let speaking = context.state.phase == "speaking"
    HStack(alignment: .center, spacing: 12) {
      VoiceOrb(size: 36)
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 8) {
          VoiceSign(state: context.state, height: 15)
          Text(speaking ? "\(context.attributes.name) is speaking" : "\(context.attributes.name) is thinking…")
        }
        .font(.headline)
        if !context.state.text.isEmpty {
          Text(context.state.text).font(.subheadline).foregroundStyle(.white.opacity(0.75)).lineLimit(2)
        }
      }
      Spacer(minLength: 0)
      Button(intent: StopNovaSpeaking()) {
        Image(systemName: "stop.fill").font(.headline).frame(width: 36, height: 36)
      }
      .buttonStyle(.borderedProminent)
      .tint(.red.opacity(0.85))
      .accessibilityLabel("Stop")
    }
    .foregroundStyle(.white)
    .padding(16)
  }
}

/// What Nova is doing, as a sign: bars that move with its voice while it speaks, an ellipsis while it thinks.
private struct VoiceSign: View {
  let state: NovaVoiceActivity.ContentState
  let height: CGFloat

  var body: some View {
    if state.phase == "speaking" {
      VoiceBars(levels: state.levels, height: height).accessibilityLabel("Speaking")
    } else {
      Image(systemName: "ellipsis").accessibilityLabel("Thinking")
    }
  }
}

/// Nova's voice as it plays, like music's in the Dynamic Island: a bar for each part of its spectrum - its pitch in the
/// middle, its vowels beside it, its s-sounds outside - brought up to date a few times a second, and moving smoothly
/// between. Dots while it pauses.
private struct VoiceBars: View {
  let levels: [Int]
  let height: CGFloat

  /// The band each bar shows, left to right.
  private static let order = [3, 1, 0, 2, 4]

  var body: some View {
    let width = max(2, (height / 5).rounded())
    HStack(spacing: width * 0.75) {
      ForEach(0..<Self.order.count, id: \.self) { bar in
        let band = Self.order[bar]
        let level = band < levels.count ? CGFloat(levels[band]) / CGFloat(NovaVoiceActivity.top) : 0
        Capsule().frame(width: width, height: width + (height - width) * level)
      }
    }
    .frame(height: height)
    .animation(.easeInOut(duration: 0.25), value: levels)
  }
}

/// The Orb, still: a Live Activity can't run the app's Metal one.
private struct VoiceOrb: View {
  let size: CGFloat

  var body: some View {
    Circle()
      .fill(RadialGradient(colors: [Color(red: 0.72, green: 0.8, blue: 1), Color(red: 0.42, green: 0.45, blue: 1), Color(red: 0.36, green: 0.18, blue: 0.78)], center: UnitPoint(x: 0.35, y: 0.3), startRadius: 1, endRadius: size * 0.7))
      .overlay(Circle().stroke(Color.white.opacity(0.3), lineWidth: 1))
      .frame(width: size, height: size)
  }
}
