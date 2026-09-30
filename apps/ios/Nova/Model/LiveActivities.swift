import ActivityKit
import Foundation
import os

private let log = Logger(subsystem: "dev.nova.phone", category: "activities")

/// Agents' tasks as Live Activities, kept in step with the task board the Mac sends. iOS lets an app start one only
/// while it's in front, so a task that began while Nova wasn't gets its activity the next time Nova is; after that it's
/// brought up to date whenever the app hears from the Mac, and ended - with what the agent found - when the task is.
@MainActor
final class LiveActivities {
  static let shared = LiveActivities()

  /// Settings → iPhone → Agents on your Lock Screen, as the Mac last said (kept, for the times it can't be reached).
  private(set) var enabled = UserDefaults.standard.object(forKey: "liveActivities") as? Bool ?? true

  /// How long what an activity shows counts as fresh: after that it says when it was last heard.
  private let freshFor: TimeInterval = 15 * 60
  /// At most this many at once: iOS allows few, and the Lock Screen has room for fewer.
  private let most = 3

  func setEnabled(_ on: Bool) async {
    guard on != enabled else { return }
    enabled = on
    UserDefaults.standard.set(on, forKey: "liveActivities")
    if !on {
      for activity in Activity<AgentActivity>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
    }
  }

  /// The task board as the Mac sent it just now: activities started, updated and ended to match. `inFront`: Nova is
  /// in front, so iOS lets it start one.
  func update(_ tasks: [AgentTask], inFront: Bool) async {
    let now = Date()
    let current = Activity<AgentActivity>.activities
    var shown = Dictionary(current.map { ($0.attributes.taskId, $0) }, uniquingKeysWith: { first, _ in first })
    for task in tasks {
      let state = AgentActivity.ContentState(status: task.status, step: task.step, report: task.report, ended: task.ended, heard: now)
      if let activity = shown.removeValue(forKey: task.id) {
        if task.status == "running" {
          await activity.update(ActivityContent(state: state, staleDate: now.addingTimeInterval(freshFor)))
        } else if activity.activityState == .active {
          // Done: what it found stays on the Lock Screen a while.
          await activity.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: .after(now.addingTimeInterval(30 * 60)))
        }
      } else if enabled, inFront, task.status == "running", now.timeIntervalSince(task.started) < 6 * 3600,
        ActivityAuthorizationInfo().areActivitiesEnabled,
        Activity<AgentActivity>.activities.filter({ $0.activityState == .active }).count < most
      {
        let attributes = AgentActivity(taskId: task.id, agent: task.label, project: task.project, task: task.task, started: task.started)
        do {
          _ = try Activity.request(attributes: attributes, content: ActivityContent(state: state, staleDate: now.addingTimeInterval(freshFor)))
        } catch {
          log.notice("activities: couldn't start one: \(error.localizedDescription, privacy: .public)")
        }
      }
    }
    // Tasks no longer on the board: their activities go.
    for activity in shown.values where activity.activityState == .active { await activity.end(nil, dismissalPolicy: .immediate) }
  }

  /// An agent's task is on the Lock Screen, at work.
  var anyAtWork: Bool {
    Activity<AgentActivity>.activities.contains { $0.activityState == .active && $0.content.state.status == "running" }
  }

  /// This phone was unpaired: nothing of that Mac's stays on the Lock Screen.
  func endAll() async {
    for activity in Activity<AgentActivity>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
  }
}
