import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// An agent at work, on the Lock Screen and in the Dynamic Island: the task, its latest step and how long it's been at
/// it - the time counts by itself; the step is as fresh as the app's last word from the Mac - with Stop, and what it
/// found once it's done.
struct AgentActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: AgentActivity.self) { context in
      AgentLockScreen(context: context)
        .activityBackgroundTint(Color(red: 0.08, green: 0.09, blue: 0.26).opacity(0.9))
        .activitySystemActionForegroundColor(.white)
        .widgetURL(NovaLink.tasks)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Label(context.attributes.agent, systemImage: "asterisk").font(.headline).foregroundStyle(accent)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Elapsed(attributes: context.attributes, state: context.state).font(.headline.monospacedDigit())
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 6) {
            Text(context.attributes.task).font(.subheadline.weight(.semibold)).lineLimit(2)
            Status(state: context.state, stale: context.isStale).font(.caption).foregroundStyle(.secondary)
            if context.state.status == "running" {
              Button(intent: StopAgentTask(taskId: context.attributes.taskId)) {
                Label("Stop", systemImage: "stop.fill").font(.caption.weight(.semibold))
              }
              .tint(.red)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      } compactLeading: {
        Image(systemName: "asterisk").foregroundStyle(accent)
      } compactTrailing: {
        Elapsed(attributes: context.attributes, state: context.state).monospacedDigit().frame(maxWidth: 52)
      } minimal: {
        Image(systemName: context.state.status == "running" ? "asterisk" : "checkmark").foregroundStyle(accent)
      }
      .widgetURL(NovaLink.tasks)
      .keylineTint(accent)
    }
  }
}

private let accent = Color(red: 0.42, green: 0.66, blue: 1)

private struct AgentLockScreen: View {
  let context: ActivityViewContext<AgentActivity>

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Image(systemName: "asterisk").font(.headline).foregroundStyle(accent)
        Text(context.attributes.agent).font(.headline)
        if !context.attributes.project.isEmpty {
          Text("· \(context.attributes.project)").font(.subheadline).foregroundStyle(.white.opacity(0.6)).lineLimit(1)
        }
        Spacer()
        Elapsed(attributes: context.attributes, state: context.state).font(.headline.monospacedDigit())
      }
      Text(context.attributes.task).font(.subheadline.weight(.semibold)).lineLimit(2)
      HStack(alignment: .bottom) {
        Status(state: context.state, stale: context.isStale).font(.caption).foregroundStyle(.white.opacity(0.7))
        Spacer()
        if context.state.status == "running" {
          Button(intent: StopAgentTask(taskId: context.attributes.taskId)) {
            Label("Stop", systemImage: "stop.fill").font(.caption.weight(.semibold))
          }
          .buttonStyle(.borderedProminent)
          .tint(.red.opacity(0.85))
        }
      }
    }
    .foregroundStyle(.white)
    .padding(16)
  }
}

/// How long it's been at it: counting while it works, the time it took once it's done.
private struct Elapsed: View {
  let attributes: AgentActivity
  let state: AgentActivity.ContentState

  var body: some View {
    if let ended = state.ended, state.status != "running" {
      Text(Duration.seconds(max(0, ended.timeIntervalSince(attributes.started))).formatted(.time(pattern: .minuteSecond)))
    } else {
      Text(timerInterval: attributes.started...Date.distantFuture, countsDown: false)
    }
  }
}

/// Its latest step while it works - saying how old that is once it's gone quiet - and then how it ended.
private struct Status: View {
  let state: AgentActivity.ContentState
  let stale: Bool

  var body: some View {
    switch state.status {
    case "running":
      if stale {
        Text("\(state.step ?? "At work") · last heard \(state.heard, style: .relative) ago").lineLimit(2)
      } else {
        Text(state.step ?? "At work").lineLimit(2)
      }
    case "done":
      Label(state.report?.split(separator: "\n").first.map(String.init) ?? "Done", systemImage: "checkmark.circle.fill").lineLimit(2)
    case "failed":
      Label(state.report?.split(separator: "\n").first.map(String.init) ?? "It didn't finish", systemImage: "exclamationmark.triangle.fill").lineLimit(2)
    default:
      Label("Stopped", systemImage: "stop.circle.fill")
    }
  }
}
