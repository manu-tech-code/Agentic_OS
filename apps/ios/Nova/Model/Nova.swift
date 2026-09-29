import Foundation
import Observation

/// Nova on this iPhone: the connection to the Mac, what Nova is doing and saying, and what the user does.
@MainActor
@Observable
final class Nova {
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
  /// The assistant's name, from the Mac.
  private(set) var name = "Nova"
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
  /// A short message to show: an error, or what happened.
  var notice: String?

  private let door: Door?
  private let voice = Voice()
  private let phoneHearing = PhoneHearing()
  private var language = "en-US"
  /// Nova is in front on this phone: the Mac sends news here while the user is away from it.
  private var foreground = true
  private var cardSeconds: Double = 8
  private var closing: [String: Task<Void, Never>] = [:]
  /// Watches a turn: the microphone getting through, and - tapped - the pause that ends it.
  private var watch: Task<Void, Never>?
  /// When the microphone last heard speech in this turn (heard on the iPhone, tapped).
  private var spokeAt: Date?

  init() {
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
    Task { await checkPhoneHearing() }
  }

  private func wire() {
    door?.onState = { [weak self] state in self?.doorState(state) }
    door?.onEvent = { [weak self] event in self?.handle(event) }
    door?.onPaired = { [weak self] paired in
      paired.save()
      self?.mac = paired
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
    voice.onFinished = { [weak self] in self?.door?.send(.speechFinished) }
    voice.onProblem = { [weak self] message in self?.notice = message }
    phoneHearing.onPartial = { [weak self] text in self?.heard = text }
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
  }

  /// The app came back to the front: reconnect now if it needs to.
  func resume() {
    door?.resume()
    Task { await checkPhoneHearing() }
  }

  /// Nova came to the front on this phone, or went: the Mac says news here while the user is away from it.
  func setForeground(_ on: Bool) {
    guard on != foreground else { return }
    foreground = on
    if link == .connected { door?.send(.phoneState(active: on)) }
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
  }

  func type(_ text: String) {
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    heard = text
    door?.send(.utterance(text, source: "keyboard"))
  }

  /// A yes or no to the question on a card - as the window's buttons send it.
  func answer(_ yes: Bool) {
    type(yes ? "yes" : "no")
  }

  /// Stop everything: Nova stops speaking and thinking, agents' tasks stop, and its questions are withdrawn.
  func stop() {
    voice.stopPlayback()
    door?.send(.stopAll)
  }

  func cancelTask(_ id: String) {
    door?.send(.taskCancel(id))
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

  // MARK: - What the Mac says

  private func doorState(_ state: Door.State) {
    switch state {
    case .idle: link = mac == nil ? .unpaired : .offline("Not connected.")
    case .connecting: if link != .connected || mac == nil { link = .connecting }
    case .connected:
      link = .connected
      door?.send(.phoneState(active: foreground))
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
  }

  private func handle(_ event: Incoming) {
    switch event {
    case .hello(let hello):
      name = hello.name
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
      if ["thinking", "acting", "speaking"].contains(phase) { turnHeard() }
    case .say(let text, _, _, _):
      reply = text
    case .audio(let id, let seq, let rate, let pcm, let last, _):
      voice.play(id: id, seq: seq, sampleRate: rate, pcm: pcm, last: last)
    case .card(let card):
      cards.removeAll { $0.id == card.id }
      cards.insert(card, at: 0)
      if cards.count > 6 { cards.removeLast(cards.count - 6) }
      closeLater(card)
    case .dismiss(let id):
      dismiss(id)
    case .tasks(let tasks):
      self.tasks = tasks
    case .computer(let active, let caller, let app, let paused):
      computer = !active ? nil : paused ? "Waiting while you use the Mac" : "\(caller ?? name) is using the computer\(app.map { " · \($0)" } ?? "")"
    case .phoneConfig(let hearing):
      hearingMode = hearing
    case .result(let ok, let message):
      if !ok { notice = message }
    case .error(let message):
      notice = message
    case .challenge, .welcome:
      break
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
