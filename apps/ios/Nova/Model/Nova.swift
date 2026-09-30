import BackgroundTasks
import Foundation
import LocalAuthentication
import Observation
import os
import UIKit
import WidgetKit

/// What Siri and Shortcuts asked, and how long each step took - never what was said (Console.app, `dev.nova.phone`).
private let log = Logger(subsystem: "dev.nova.phone", category: "siri")

/// Nova on this iPhone: the connection to the Mac, what Nova is doing and saying, and what the user does.
/// One for the app - its window, and Siri, Shortcuts and the Action button, which may start it in the background.
@MainActor
@Observable
final class Nova {
  static let shared = Nova()

  enum Link: Equatable {
    case unpaired
    case connecting
    case connected
    /// Can't reach the Mac just now; it keeps trying.
    case offline(String)
    /// The Mac doesn't know this phone any more.
    case lost(String)
  }

  private(set) var link: Link
  private(set) var mac: PairedMac?
  /// The assistant's name, from the Mac (kept, for when Siri asks while it can't be reached).
  private(set) var name = UserDefaults.standard.string(forKey: "assistantName") ?? "Nova"
  private(set) var phase = "idle"
  private(set) var phaseLabel: String?
  /// What Nova heard: the words as they come, then the whole turn.
  private(set) var heard = ""
  private(set) var reply = ""
  private(set) var cards: [Card] = []
  private(set) var tasks: [AgentTask] = []
  /// "Claude is using the computer": Nova's hands are on the Mac.
  private(set) var computer: String?
  /// How loud the microphone or Nova's voice is: the Orb moves with it.
  private(set) var level: Float = 0
  private(set) var talking = false
  /// Where the Mac says this phone's speech is heard (Settings → iPhone): auto, mac or iphone.
  private(set) var hearingMode = "auto"
  private(set) var macHearing = HearingStatus([:])
  /// Apple's speech model is on this iPhone, so it can hear by itself.
  private(set) var phoneHearingReady = false
  /// This turn is being heard on the iPhone.
  private(set) var hearingHere = false
  /// The button was tapped, not held: the turn ends when you pause, as the Mac's ⌥Space tapped.
  private(set) var tapped = false
  /// The agents' task board is open (a widget's link can open it).
  var showingTasks = false
  /// A short message to show: an error, or what happened.
  var notice: String?

  private let door: Door?
  private let voice = Voice()
  private let phoneHearing = PhoneHearing()
  private var language = "en-US"
  /// Nova is in front on this phone: the Mac sends news here while the user is away from it. Not until it
  /// comes there - Siri and Shortcuts start the app in the background.
  private(set) var foreground = false
  /// Snooze and Done pressed while the Mac couldn't be reached: sent once it can (kept across launches).
  private var unsent: [[String]] {
    get { UserDefaults.standard.array(forKey: "unsentActions") as? [[String]] ?? [] }
    set { UserDefaults.standard.set(newValue, forKey: "unsentActions") }
  }
  private var cardSeconds: Double = 8
  private var closing: [String: Task<Void, Never>] = [:]
  /// Watches a turn: the microphone getting through, and - tapped - the pause that ends it.
  private var watch: Task<Void, Never>?
  /// When the microphone last heard speech in this turn (heard on the iPhone, tapped).
  private var spokeAt: Date?
  /// Questions from Siri, Shortcuts or the Action button under way.
  private var asking = 0
  /// The one being answered now: what's come back since it was asked.
  private var waiting: Waiting?
  /// Siri or the Action button asked for Nova to listen, once it can.
  private var listening: Task<Void, Never>?
  /// Letting the connection go, out of the front with nothing to do.
  private var resting: Task<Void, Never>?
  /// A check-in waiting for what the Mac held for you.
  private var checkingIn = false
  /// Your turn went to the Mac then, and Nova hasn't finished answering it.
  private var owedSince: Date?
  /// The answer's words are in, and its voice (this audio) is on the way.
  private var answerAudio: (id: String, since: Date)?
  /// Time iOS gives Nova out of the front while it's answering you - until its voice (which keeps it awake) starts.
  private var answerTime: BackgroundTime?
  private var voiceTick: Task<Void, Never>?
  /// What the widgets show, as last written for them.
  private var widgetState = WidgetState.load() ?? WidgetState()
  private var widgetReload: Task<Void, Never>?

  private init() {
    if let scene = Demo.scene {
      // The README's scripted session: no Mac at all, and this phone's own pairing left as it was.
      door = nil
      mac = scene == "pair" ? nil : Demo.mac
      link = scene == "pair" ? .unpaired : .connected
      Task { self.playDemo(scene) }
      return
    }
    var problem: String?
    let key: DeviceKey?
    do {
      key = try DeviceKey.load()
    } catch {
      key = nil
      problem = "This iPhone couldn't make its key: \(error.localizedDescription)"
    }
    let saved = PairedMac.load()
    door = key.map { Door(key: $0) }
    mac = saved
    link = saved == nil ? .unpaired : .connecting
    notice = problem
    wire()
    if let saved { door?.connect(saved) }
    updateWidgets { $0.mac = saved?.name }
    Task { await checkPhoneHearing() }
  }

  private func wire() {
    door?.onState = { [weak self] state in self?.doorState(state) }
    door?.onEvent = { [weak self] event in self?.handle(event) }
    door?.onPaired = { [weak self] paired in
      paired.save()
      self?.mac = paired
      self?.updateWidgets { $0.mac = paired.name }
    }
    voice.onFrame = { [weak self] pcm in
      guard let self else { return }
      if self.hearingHere { self.phoneHearing.feed(pcm) } else { self.door?.send(audio: pcm) }
    }
    voice.onLevel = { [weak self] level in
      guard let self else { return }
      self.level = level
      if self.talking, level > 0.06 { self.spokeAt = Date() }
    }
    voice.onFinished = { [weak self] in
      self?.door?.send(.speechFinished)
      self?.restLater()
    }
    voice.onProblem = { [weak self] message in
      log.notice("voice: \(message, privacy: .public)")
      self?.notice = message
    }
    phoneHearing.onPartial = { [weak self] text in self?.heard = text }
    TalkToNova.listen = { [weak self] in self?.listenSoon() }
    StopAgentTask.stop = { [weak self] id in await self?.stopTask(id) }
    StopNovaSpeaking.stop = { [weak self] in self?.hush() }
    voice.onPlaying = { [weak self] _ in self?.showVoice() }
    voice.onBands = { VoiceActivity.shared.hear($0) }
    Notifications.shared.setUp()
    Notifications.shared.quiet = { [weak self] in self?.link == .connected && self?.foreground == true }
    Notifications.shared.onAction = { [weak self] ref, action in
      guard let self, action != "open" else { return }
      if self.link == .connected { self.door?.send(.notificationAction(ref: ref, action: action)) } else { self.unsent.append([ref, action]) }
    }
  }

  // MARK: - Pairing

  /// A pairing link - from the QR code, AirDrop or the Simulator. False when it isn't one.
  @discardableResult
  func pair(link text: String) -> Bool {
    guard let offer = PairingOffer(link: text.trimmingCharacters(in: .whitespacesAndNewlines)) else {
      notice = "That isn't a pairing code from Nova. Show one in Nova's Settings → iPhone on the Mac."
      return false
    }
    link = .connecting
    door?.pair(offer)
    return true
  }

  /// Forget the Mac on this iPhone (the Mac still lists it until it's forgotten there too).
  func unpair() {
    door?.disconnect()
    PairedMac.forget()
    mac = nil
    link = .unpaired
    cards = []
    tasks = []
    reply = ""
    heard = ""
    updateWidgets { $0 = WidgetState(name: $0.name) }
    Task { await LiveActivities.shared.endAll() }
    VoiceActivity.shared.show(nil, text: "", name: name, inFront: false)
  }

  /// A nova:// link: a pairing code - or, from a widget or the control, Nova listening, or the agents' task board.
  func open(_ url: URL) {
    switch url.host {
    case NovaLink.talk.host: listenSoon()
    case NovaLink.tasks.host: showingTasks = true
    default: pair(link: url.absoluteString)
    }
  }

  /// The app came back to the front: reconnect now if it needs to.
  func resume() {
    door?.resume()
    Task { await checkPhoneHearing() }
  }

  /// Nova came to the front on this phone, or went: the Mac says news here while the user is away from it. Gone,
  /// the microphone stops, a reply that's playing finishes, and then the connection is let go.
  func setForeground(_ on: Bool) {
    guard on != foreground else { return }
    foreground = on
    let wasTalking = talking
    voice.setAway(!on)
    if link == .connected { door?.send(.phoneState(active: on)) }
    if !on { scheduleCheckIn() }
    if !on, answer != nil, answerTime == nil { answerTime = BackgroundTime("Nova answering") }
    showVoice()
    if on {
      resting?.cancel()
    } else if wasTalking {
      // What was said so far still counts: the turn ends, and then the connection may rest.
      Task {
        await talkEnd()
        restLater()
      }
    } else {
      restLater()
    }
  }

  /// Out of the front with nothing left to do - no question from Siri under way, nothing being said, nothing
  /// waiting to be sent: the connection is let go, so the Mac knows this phone isn't there (it's made again when
  /// Nova comes back, or Siri asks something).
  private func restLater() {
    resting?.cancel()
    guard !foreground else { return }
    resting = Task { [weak self] in
      let time = BackgroundTime("Nova finishing up")
      defer { time.end() }
      // What was just sent goes out first - and an app Siri just started has time to ask its question.
      try? await Task.sleep(for: .seconds(2))
      guard let self, !Task.isCancelled, !self.foreground, self.asking == 0, self.answer == nil, self.unsent.isEmpty else { return }
      self.door?.pause()
    }
  }

  // MARK: - Talking

  /// The talk button went down.
  func talkStart() async {
    guard link == .connected, !talking else { return }
    talking = true
    tapped = false
    spokeAt = nil
    hearingHere = hearOnPhone
    voice.stopPlayback()
    if hearingHere {
      heard = ""
      do {
        try await phoneHearing.start(language: language)
      } catch {
        hearingHere = false
        notice = error.localizedDescription
      }
    }
    // Heard on the Mac: it stops talking, and takes what comes as meant for Nova, wake word or not.
    if !hearingHere { door?.send(.talkStart) }
    if !(await voice.startTalking()) {
      talking = false
      if !hearingHere { door?.send(.talkEnd(held: false)) }
      return
    }
    watchTurn()
  }

  /// Tapped rather than held: just talk, and the turn ends when you pause. Heard on the Mac, its turn-taking
  /// (Smart Turn) hears the pause, as for ⌥Space; heard here, the phone listens for a second of quiet itself.
  func talkTapped() {
    guard talking, !tapped else { return }
    tapped = true
    if !hearingHere { door?.send(.talkEnd(held: false)) }
  }

  /// The microphone must be getting through; and a tapped turn ends at a pause, or after half a minute however long.
  private func watchTurn() {
    watch?.cancel()
    let started = Date()
    watch = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .milliseconds(150))
        guard let self, self.talking else { return }
        let now = Date()
        if now.timeIntervalSince(started) > 1.5, self.voice.frames == 0 {
          self.notice = "The microphone isn't sending anything. Check Settings → Privacy & Security → Microphone → Nova, then try again."
          return await self.talkEnd()
        }
        guard self.tapped else { continue }
        let quiet = self.spokeAt.map { now.timeIntervalSince($0) > 1.2 } ?? (now.timeIntervalSince(started) > 8)
        if now.timeIntervalSince(started) > 30 || (self.hearingHere && quiet) {
          return self.hearingHere ? await self.talkEnd() : self.turnHeard()
        }
      }
    }
  }

  /// The Mac heard the end of a tapped turn: the phone stops streaming and gives the microphone back.
  private func turnHeard() {
    guard talking, tapped, !hearingHere else { return }
    watch?.cancel()
    talking = false
    tapped = false
    voice.stopTalking()
    door?.send(.audioStop)
    answering()
  }

  /// The talk button came up after a hold, or was tapped again.
  func talkEnd() async {
    guard talking else { return }
    watch?.cancel()
    talking = false
    let wasTapped = tapped
    tapped = false
    voice.stopTalking()
    if hearingHere {
      let said = await phoneHearing.finish()
      hearingHere = false
      if said.isEmpty { return }
      heard = said
      door?.send(.utterance(said, source: "phone"))
    } else if wasTapped {
      door?.send(.audioStop) // the Mac already ends the turn at the pause
    } else {
      door?.send(.talkEnd(held: true))
    }
    answering()
  }

  /// Your turn is with the Mac now: Nova is working on its answer to you.
  private func answering() {
    owedSince = Date()
    answerAudio = nil
    showVoice()
  }

  /// Nova's answer to you, as it stands: thinking, or speaking - nil once it's done. The Dynamic Island shows it once
  /// you've left Nova, and meanwhile the line to the Mac stays open (and Nova awake) for it.
  private var answer: String? {
    if voice.speaking { return "speaking" }
    let busy = ["thinking", "acting", "speaking"].contains(phase)
    // Its words are in and its voice is on the way: the Mac is still at it, however long Kokoro takes over a long sentence.
    if let audio = answerAudio, voice.lastPlayed != audio.id, busy, Date().timeIntervalSince(audio.since) < 60 { return "speaking" }
    // The Mac is at work on your turn - however long it thinks, within reason - or has only just got it.
    guard let since = owedSince else { return nil }
    let waited = Date().timeIntervalSince(since)
    return waited < 180 && (busy || waited < 8) ? "thinking" : nil
  }

  private func showVoice() {
    guard Demo.scene == nil else { return } // the demo shows its own
    let now = answer
    // Out of the front, time from iOS while Nova thinks - until its voice plays, which keeps it awake by itself.
    if now == nil || voice.speaking {
      answerTime?.end()
      answerTime = nil
    }
    if now == nil, !foreground { restLater() }
    // Out of the front, until the voice plays: silence keeps Nova awake for it, so it's said here, when it comes.
    voice.stayAwake(!foreground && now != nil && !voice.speaking)
    if now != nil, voiceTick == nil {
      // Nothing may come to say it's over (the Mac gone quiet): look again every couple of seconds.
      voiceTick = Task { [weak self] in
        while let self, !Task.isCancelled, self.answer != nil {
          try? await Task.sleep(for: .seconds(2))
          self.showVoice()
        }
        self?.voiceTick = nil
      }
    }
    let text = now == "speaking" ? reply : heard.isEmpty ? "" : "“\(heard)”"
    VoiceActivity.shared.show(now, text: text, name: name, inFront: foreground)
  }

  /// Stop, on Nova speaking in the Dynamic Island or on the Lock Screen: it stops saying, or thinking about, that
  /// answer (agents go on).
  func hush() {
    log.notice("stop: Nova stops answering, from its Live Activity")
    voice.stopPlayback()
    door?.send(.cancel)
    owedSince = nil
    answerAudio = nil
    showVoice()
  }

  func type(_ text: String) {
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    heard = text
    door?.send(.utterance(text, source: "keyboard"))
    answering()
  }

  /// A yes or no to the question on a card - as the window's buttons send it.
  func answer(_ yes: Bool) {
    type(yes ? "yes" : "no")
  }

  /// A question only a tap answers: Allow needs Face ID first (the phone's owner, not whoever holds it - the passcode
  /// if Face ID can't tell), then goes to the Mac as the tap. No needs nothing.
  func tapAnswer(_ card: Card, yes: Bool) async {
    if yes {
      let owner = LAContext()
      owner.localizedFallbackTitle = "Use Passcode"
      do {
        guard try await owner.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Allow: \(card.title)") else { return }
      } catch {
        notice = "Not allowed: Face ID didn't confirm it's you."
        return
      }
    }
    door?.send(.tapAnswer(id: card.id, yes: yes))
  }

  /// Stop everything: Nova stops speaking and thinking, agents' tasks stop, and its questions are withdrawn.
  func stop() {
    voice.stopPlayback()
    door?.send(.stopAll)
  }

  func cancelTask(_ id: String) {
    door?.send(.taskCancel(id))
  }

  /// Stop from a task's Live Activity - Nova may be in the background: the Mac stops it, and the activity ends with it.
  func stopTask(_ id: String) async {
    asking += 1
    defer {
      asking -= 1
      restLater()
    }
    guard await reachMac() else { return }
    door?.send(.taskCancel(id))
    let until = Date().addingTimeInterval(4)
    while tasks.first(where: { $0.id == id })?.status == "running", link == .connected, Date() < until {
      try? await Task.sleep(for: .milliseconds(100))
    }
  }

  func retryTask(_ id: String) {
    door?.send(.taskRetry(id))
  }

  func dismiss(_ id: String) {
    cards.removeAll { $0.id == id }
  }

  /// Download Apple's speech model for Nova's language onto this iPhone, so it can hear by itself.
  func installPhoneHearing() async {
    do {
      try await PhoneHearing.install(language)
      await checkPhoneHearing()
      notice = phoneHearingReady ? "This iPhone can hear by itself now." : "The speech model didn't install."
    } catch {
      notice = error.localizedDescription
    }
  }

  /// Where this turn should be heard: the Mac unless Settings says the iPhone, or the Mac can't, or - on
  /// automatic - the connection is weak (a ping slower than a third of a second).
  private var hearOnPhone: Bool {
    guard phoneHearingReady else { return false }
    switch hearingMode {
    case "iphone": return true
    case "mac": return !macHearing.ready
    default: return !macHearing.ready || (door?.roundTrip ?? 0) > 0.3
    }
  }

  private func checkPhoneHearing() async {
    phoneHearingReady = await PhoneHearing.ready(language)
  }

  // MARK: - Checking in by itself

  /// What iOS runs when it lets Nova check in (Background App Refresh).
  static let checkInTask = "dev.nova.phone.check-in"

  /// Out of the front: ask iOS to wake Nova in a while to check in with the Mac - sooner while an agent's task is on the
  /// Lock Screen. When is up to iOS - it goes by how the phone is used, and may be hours - which is all a free Apple
  /// account, with no push, allows.
  func scheduleCheckIn() {
    let request = BGAppRefreshTaskRequest(identifier: Self.checkInTask)
    request.earliestBeginDate = Date().addingTimeInterval((LiveActivities.shared.anyAtWork ? 5 : 20) * 60)
    do {
      try BGTaskScheduler.shared.submit(request)
    } catch {
      log.notice("check-in: iOS wouldn't take it: \(error.localizedDescription, privacy: .public)")
    }
  }

  /// iOS woke Nova in the background: catch up with the Mac - the reminders to ring for and the widgets (sent on
  /// connecting, as always), and the news it held while you were away, shown as notifications - then rest again.
  func checkIn() async {
    scheduleCheckIn()
    guard mac != nil, !foreground else { return }
    asking += 1
    let started = Date()
    defer {
      asking -= 1
      restLater()
    }
    guard await reachMac(within: 10) else { return log.notice("check-in: the Mac couldn't be reached") }
    checkingIn = true
    door?.send(.phoneRefresh)
    let until = Date().addingTimeInterval(8)
    while checkingIn, link == .connected, Date() < until { try? await Task.sleep(for: .milliseconds(100)) }
    try? await Task.sleep(for: .seconds(1)) // what's coming up, which the Mac sends on connecting, is in by now
    log.notice("check-in: done in \(Date().timeIntervalSince(started), format: .fixed(precision: 2)) s")
  }

  // MARK: - Siri, Shortcuts and the Action button

  /// A question from Siri, a shortcut or Spotlight, said to Nova as if into this phone: what Nova answers. Its voice
  /// plays here as it would in the app - in the background too - so this waits until the answer has started playing.
  func ask(_ question: String) async -> Answer {
    let question = question.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !question.isEmpty else { return Answer(heard: "", text: "Ask \(name) something.", failed: true) }
    guard mac != nil else { return Answer(heard: question, text: "This iPhone isn't paired with \(name) yet: open \(name) and pair it with your Mac.", failed: true) }
    asking += 1
    let time = BackgroundTime("Asking Nova")
    defer {
      asking -= 1
      time.end()
      restLater()
    }
    let asked = Date()
    guard await reachMac() else {
      log.notice("ask: the Mac couldn't be reached (\(Date().timeIntervalSince(asked), format: .fixed(precision: 2)) s)")
      return Answer(heard: question, text: unreachable, failed: true)
    }
    log.notice("ask: connected after \(Date().timeIntervalSince(asked), format: .fixed(precision: 2)) s")
    // One question at a time: Nova's answers come back in order, with nothing to tell them apart.
    let turn = Date().addingTimeInterval(Self.answerSeconds)
    while self.waiting != nil, Date() < turn { try? await Task.sleep(for: .milliseconds(100)) }
    let waiting = Waiting()
    self.waiting = waiting
    defer { if self.waiting === waiting { self.waiting = nil } }
    heard = question
    door?.send(.utterance(question, source: "phone"))
    let until = Date().addingTimeInterval(Self.answerSeconds)
    while !waiting.done, link == .connected, Date() < until { try? await Task.sleep(for: .milliseconds(50)) }
    guard waiting.done else {
      let failed = link != .connected
      return Answer(
        heard: question,
        text: failed ? "The connection to your Mac dropped before \(name) answered." : waiting.text.isEmpty ? "\(name) is still working on that - open \(name) for the answer." : "\(waiting.text)…",
        failed: failed || waiting.text.isEmpty)
    }
    log.notice("ask: answered after \(Date().timeIntervalSince(asked), format: .fixed(precision: 2)) s")
    if let failure = waiting.failure { return Answer(heard: question, text: failure, failed: true) }
    // Said aloud too: once it's playing here, iOS keeps Nova awake to finish saying it.
    if let audio = waiting.audio {
      let until = Date().addingTimeInterval(4)
      while voice.lastPlayed != audio, link == .connected, Date() < until { try? await Task.sleep(for: .milliseconds(50)) }
      log.notice("ask: \(self.voice.lastPlayed == audio ? "speaking" : "not speaking") after \(Date().timeIntervalSince(asked), format: .fixed(precision: 2)) s")
    }
    return Answer(heard: question, text: waiting.text, asks: waiting.card != nil || waiting.text.hasSuffix("?"), tap: waiting.card?.tap ?? false)
  }

  /// How long Siri is kept waiting for Nova's answer: a brain can take a while, and past this Siri gives up anyway.
  static let answerSeconds: TimeInterval = 20

  /// Stop everything, from Siri or a shortcut: as the Stop button.
  func stopEverything() async -> Answer {
    asking += 1
    defer {
      asking -= 1
      restLater()
    }
    guard mac != nil, await reachMac() else { return Answer(heard: "", text: mac == nil ? "This iPhone isn't paired with \(name) yet." : unreachable, failed: true) }
    stop()
    try? await Task.sleep(for: .milliseconds(300)) // it goes out before the connection may be let go
    return Answer(heard: "", text: "\(name) stopped everything.")
  }

  /// Siri, the Action button or a question Nova asked back: Nova, in front, listens - as if its talk button were
  /// tapped, so the turn ends when you pause - once it's connected and has finished what it's saying.
  func listenSoon() {
    listening?.cancel()
    listening = Task { [weak self] in
      guard let self, await self.reachMac() else { return }
      let until = Date().addingTimeInterval(15)
      while !Task.isCancelled, Date() < until, !self.foreground || self.voice.speaking || self.talking {
        try? await Task.sleep(for: .milliseconds(100))
      }
      guard !Task.isCancelled, self.foreground, !self.talking, self.link == .connected else { return }
      try? await Task.sleep(for: .milliseconds(300)) // Siri lets go of the microphone
      await self.talkStart()
      self.talkTapped()
    }
  }

  /// Connected to the Mac - now, or after trying again straight away.
  private func reachMac(within seconds: TimeInterval = 10) async -> Bool {
    if link == .connected { return true }
    guard mac != nil else { return false }
    door?.hurry()
    let until = Date().addingTimeInterval(seconds)
    while link != .connected, Date() < until {
      if case .lost = link { return false }
      try? await Task.sleep(for: .milliseconds(100))
    }
    return link == .connected
  }

  private var unreachable: String {
    if case .lost(let why) = link { return why }
    return "\(name) on your Mac can't be reached. Is the Mac awake with \(name) open, and this iPhone on its Wi-Fi?"
  }

  // MARK: - What the Mac says

  private func doorState(_ state: Door.State) {
    switch state {
    case .idle: link = mac == nil ? .unpaired : .offline("Not connected.")
    case .connecting: if link != .connected || mac == nil { link = .connecting }
    case .connected:
      link = .connected
      door?.send(.phoneState(active: foreground))
      for pair in unsent where pair.count == 2 { door?.send(.notificationAction(ref: pair[0], action: pair[1])) }
      unsent = []
      restLater()
    case .failed(let message, let unpaired):
      if unpaired {
        PairedMac.forget()
        mac = nil
        link = .lost(message)
      } else if mac == nil {
        link = .unpaired
        notice = message
      } else {
        link = .offline(message)
      }
    }
    if link != .connected, talking {
      talking = false
      voice.stopTalking()
    }
    // A reply still coming in ends with what came: the Mac doesn't send the rest anywhere else.
    if link != .connected { voice.streamLost() }
  }

  private func handle(_ event: Incoming) {
    switch event {
    case .hello(let hello):
      name = hello.name
      UserDefaults.standard.set(hello.name, forKey: "assistantName")
      updateWidgets { $0.name = hello.name }
      macHearing = hello.hearing
      if let lang = hello.language { language = lang }
      cardSeconds = hello.cardSeconds ?? 8
    case .hearing(let status):
      macHearing = status
    case .transcript(let text, let final):
      if !hearingHere { heard = text }
      if final { turnHeard() }
    case .bargeIn:
      voice.stopPlayback()
    case .phase(let phase, let label):
      self.phase = phase
      phaseLabel = label
      // Nothing came of your turn (nothing was heard): it's over. (A moment's grace for what was already on its way.)
      if phase == "idle", let since = owedSince, Date().timeIntervalSince(since) > 1.5 { owedSince = nil }
      showVoice()
      if ["thinking", "acting", "speaking"].contains(phase) { turnHeard() }
    case .say(let text, _, let partial, let audio):
      reply = text
      waiting?.said(text, audio: audio, final: !partial)
      if owedSince != nil {
        if let audio { answerAudio = (audio, Date()) }
        if !partial { owedSince = nil } // all its words are in: what's left is saying them
      }
      showVoice()
    case .audio(let id, let seq, let rate, let pcm, let last, _):
      voice.play(id: id, seq: seq, sampleRate: rate, pcm: pcm, last: last)
    case .card(let card):
      if card.kind == "confirm" { waiting?.asks(card) }
      cards.removeAll { $0.id == card.id }
      cards.insert(card, at: 0)
      if cards.count > 6 { cards.removeLast(cards.count - 6) }
      closeLater(card)
    case .dismiss(let id):
      dismiss(id)
    case .tasks(let tasks):
      self.tasks = tasks
      let inFront = foreground
      Task { await LiveActivities.shared.update(tasks, inFront: inFront) }
      let work = tasks.prefix(12).map { WidgetState.Work(agent: $0.label, task: $0.task, status: $0.status, step: $0.step) }
      updateWidgets { state in
        if state.work != work { (state.work, state.at) = (work, Date()) }
      }
    case .computer(let active, let caller, let app, let paused):
      computer = !active ? nil : paused ? "Waiting while you use the Mac" : "\(caller ?? name) is using the computer\(app.map { " · \($0)" } ?? "")"
    case .phoneConfig(let hearing, let activities, let voiceActivity):
      hearingMode = hearing
      Task { await LiveActivities.shared.setEnabled(activities) }
      VoiceActivity.shared.setEnabled(voiceActivity)
    case .phoneNews(let items):
      Task {
        let shown = await Notifications.shared.news(items)
        if !shown.isEmpty { door?.send(.phoneNewsShown(shown)) }
        log.notice("check-in: \(items.count) held, \(shown.count) shown")
        checkingIn = false
      }
    case .phoneReminders(let items):
      Task { await Notifications.shared.replace(items) }
      updateWidgets { $0.reminders = items.map { .init(what: $0.what, due: $0.due, timer: $0.timer) } }
    case .result(let ok, let message):
      if !ok {
        notice = message
        waiting?.failed(message)
      }
    case .error(let message):
      notice = message
      waiting?.failed(message)
    case .challenge, .welcome:
      break
    }
  }

  /// What the widgets show changed: it's kept for them, and they're drawn again a moment later (once for a burst).
  private func updateWidgets(_ change: (inout WidgetState) -> Void) {
    var next = widgetState
    change(&next)
    guard next != widgetState else { return }
    widgetState = next
    next.save()
    guard widgetReload == nil else { return }
    widgetReload = Task { [weak self] in
      // Out of the front (answering Siri), iOS could put Nova to sleep first: a moment of its time for the widgets.
      let time = BackgroundTime("Nova's widgets")
      defer { time.end() }
      try? await Task.sleep(for: .seconds(1))
      WidgetCenter.shared.reloadAllTimelines()
      self?.widgetReload = nil
    }
  }

  /// A reply's card closes by itself after a few seconds; questions, timers and tasks stay until they're done.
  private func closeLater(_ card: Card) {
    closing[card.id]?.cancel()
    guard !card.stays, cardSeconds > 0 else { return }
    let seconds = cardSeconds
    closing[card.id] = Task { [weak self] in
      try? await Task.sleep(for: .seconds(seconds))
      guard !Task.isCancelled else { return }
      self?.dismiss(card.id)
    }
  }
}

/// What Nova said to a question from Siri, Shortcuts or the Action button.
struct Answer {
  var heard: String
  var text: String
  /// Nova asked something back: a yes or no, or which one - or, `tap`, something only Allow with Face ID answers.
  var asks = false
  var tap = false
  /// It didn't reach Nova, or Nova couldn't do it.
  var failed = false
}

/// A question being answered: what's come back since it was asked. The answer is the first reply Nova finishes.
@MainActor
private final class Waiting {
  private(set) var text = ""
  /// The reply is being said aloud, as this audio.
  private(set) var audio: String?
  /// Nova asked for a yes or no (or a tap) with this.
  private(set) var card: Card?
  private(set) var failure: String?
  private(set) var done = false

  func said(_ text: String, audio: String?, final: Bool) {
    guard !done else { return }
    self.text = text
    if let audio { self.audio = audio }
    done = final
  }

  func asks(_ card: Card) {
    if !done { self.card = card }
  }

  func failed(_ message: String) {
    guard !done else { return }
    failure = message
    done = true
  }
}

/// A little time iOS gives an app out of the front, to finish what it started (a question from Siri, a last message).
@MainActor
final class BackgroundTime {
  private var id = UIBackgroundTaskIdentifier.invalid

  init(_ name: String) {
    id = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
      MainActor.assumeIsolated { self?.end() }
    }
  }

  func end() {
    guard id != .invalid else { return }
    UIApplication.shared.endBackgroundTask(id)
    id = .invalid
  }
}

// MARK: - The README's scripted session

extension Nova {
  /// One of Demo's scenes: what the made-up Mac says comes in as a real Mac's events do, and the rest - talking, the
  /// Orb moving, the task board open, Nova's voice in the Dynamic Island - is set as the scene needs.
  fileprivate func playDemo(_ scene: String) {
    Task {
      // Each scene starts clean: activities outlive the app that started them.
      await LiveActivities.shared.endAll()
      await VoiceActivity.shared.clear()
      let start = Date()
      Task {
        for (at, event) in Demo.script(scene) {
          try? await Task.sleep(for: .seconds(max(0, at - Date().timeIntervalSince(start))))
          if let data = try? JSONSerialization.data(withJSONObject: event), let incoming = Incoming.read(data) { handle(incoming) }
        }
      }
      switch scene {
      case "talk", "answer", "faceid":
        talking = scene == "talk"
        // A voice: the Orb moves with it.
        while !Task.isCancelled {
          level = Float(0.18 + 0.3 * abs(sin(Date().timeIntervalSince(start) * 4.2)))
          try? await Task.sleep(for: .milliseconds(80))
        }
      case "tasks":
        try? await Task.sleep(for: .seconds(0.7))
        showingTasks = true
      case "island":
        // Nova speaking, and Claude at work: once Nova is sent to the background, the Dynamic Island shows Nova's voice
        // (Claude's task has it again once Nova is done), its bars moving with a made-up voice.
        let time = BackgroundTime("Nova's demo")
        try? await Task.sleep(for: .seconds(0.6))
        VoiceActivity.shared.show("speaking", text: Demo.saying, name: name, inFront: true)
        var away = false
        while Date().timeIntervalSince(start) < 25 {
          if !foreground, !away {
            away = true
            voice.stayAwake(true) // as when Nova really speaks: an app playing audio isn't held back
          }
          VoiceActivity.shared.show("speaking", text: Demo.saying, name: name, inFront: foreground)
          VoiceActivity.shared.hear(Demo.bands(at: Date().timeIntervalSince(start)))
          try? await Task.sleep(for: .milliseconds(250))
        }
        voice.stayAwake(false)
        time.end()
      default:
        break
      }
    }
  }
}
