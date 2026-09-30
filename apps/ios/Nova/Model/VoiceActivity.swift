import ActivityKit
import Foundation
import os

private let log = Logger(subsystem: "dev.nova.phone", category: "activities")

/// Nova thinking about or saying its answer to you, as a Live Activity - so leaving Nova for the Home Screen or another
/// app, you can see it's still at it (while it speaks, bars move with its voice). iOS lets an app start one only while
/// it's in front (and hides it there), so it's started as soon as Nova is at work on your turn, ready for the moment
/// you leave; it ends as soon as Nova is done.
@MainActor
final class VoiceActivity {
  static let shared = VoiceActivity()

  /// Settings → iPhone → Nova speaking, in the Dynamic Island, as the Mac last said.
  private(set) var enabled = UserDefaults.standard.object(forKey: "voiceActivity") as? Bool ?? true
  private var current: Activity<NovaVoiceActivity>?
  /// Above an agent's task (0): while Nova speaks, the Dynamic Island - which shows one of an app's activities - is Nova's.
  private let relevance: Double = 100
  private var shown: NovaVoiceActivity.ContentState?

  func setEnabled(_ on: Bool) {
    guard on != enabled else { return }
    enabled = on
    UserDefaults.standard.set(on, forKey: "voiceActivity")
    if !on { show(nil, text: "", name: "", inFront: false) }
  }

  // What's wanted, as last said - put in place one change at a time, always the latest.
  private var phase: String?
  private var text = ""
  private var name = ""
  private var inFront = false
  private var levels: [Int] = []
  private var changed = false
  private var applying = false
  /// When the activity was last brought up to date: the bars move a few times a second, no faster.
  private var updated = Date.distantPast

  /// What Nova is doing about your turn now: thinking, speaking - or nil, done. `inFront`: iOS lets it start one.
  func show(_ phase: String?, text: String, name: String, inFront: Bool) {
    (self.phase, self.text, self.name, self.inFront) = (phase, text, name, inFront)
    if phase != "speaking" { levels = [] }
    refresh()
  }

  /// How Nova's voice sounds as it plays out of the front, low to high pitch, 0-1 each: the bars in the Dynamic
  /// Island and on the Lock Screen move with it.
  func hear(_ bands: [Float]) {
    guard phase == "speaking", !inFront, current != nil else { return }
    levels = bands.map { Int(($0 * Float(NovaVoiceActivity.top)).rounded()) }
    guard levels != shown?.levels, Date().timeIntervalSince(updated) >= 0.2 else { return }
    refresh()
  }

  private func refresh() {
    changed = true
    guard !applying else { return }
    applying = true
    Task {
      while changed {
        changed = false
        await apply()
      }
      applying = false
    }
  }

  private func apply() async {
    guard let phase, enabled else { return await end() }
    let state = NovaVoiceActivity.ContentState(phase: phase, text: Self.tail(text), levels: levels)
    if let current, current.activityState == .active {
      guard state != shown else { return }
      shown = state
      updated = Date()
      await current.update(ActivityContent(state: state, staleDate: nil, relevanceScore: relevance))
    } else if !inFront {
      log.info("activities: Nova's voice can't start out of the front")
    } else if !ActivityAuthorizationInfo().areActivitiesEnabled {
      log.notice("activities: Live Activities are off for Nova (Settings → Nova)")
    } else {
      do {
        current = try Activity.request(attributes: NovaVoiceActivity(name: name), content: ActivityContent(state: state, staleDate: nil, relevanceScore: relevance))
        shown = state
        updated = Date()
        log.info("activities: Nova's voice shows (\(phase, privacy: .public))")
      } catch {
        log.notice("activities: Nova's voice couldn't show: \(error.localizedDescription, privacy: .public)")
      }
    }
  }

  /// Nothing of Nova's voice on show, nor any left from before: the README's scripted session starts clean.
  func clear() async {
    phase = nil
    await end()
  }

  private func end() async {
    if current != nil { log.info("activities: Nova's voice is done") }
    let ending = current
    current = nil
    shown = nil
    await ending?.end(nil, dismissalPolicy: .immediate)
    // One left over from before Nova last closed goes too.
    for stray in Activity<NovaVoiceActivity>.activities where stray.id != ending?.id { await stray.end(nil, dismissalPolicy: .immediate) }
  }

  /// The end of what's being said: the Dynamic Island has room for a line or two.
  private static func tail(_ text: String) -> String {
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard text.count > 140 else { return text }
    return "…" + String(text.suffix(139)).trimmingCharacters(in: .whitespaces)
  }
}
