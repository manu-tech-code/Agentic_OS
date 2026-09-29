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
  /// A short message to show: an error, or what happened.
  var notice: String?

  private let door: Door?
  private let voice = Voice()
  private let phoneHearing = PhoneHearing()
  private var language = "en-US"
  private var cardSeconds: Double = 8
  private var closing: [String: Task<Void, Never>] = [:]

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
    voice.onLevel = { [weak self] level in self?.level = level }
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

  // MARK: - Talking

  /// The talk button went down.
  func talkStart() async {
    guard link == .connected, !talking else { return }
    talking = true
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
    }
  }

  /// The talk button came up.
  func talkEnd() async {
    guard talking else { return }
    talking = false
    voice.stopTalking()
    if hearingHere {
      let said = await phoneHearing.finish()
      hearingHere = false
      if said.isEmpty { return }
      heard = said
      door?.send(.utterance(said, source: "phone"))
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
    case .connected: link = .connected
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
    case .transcript(let text, _):
      if !hearingHere { heard = text }
    case .bargeIn:
      voice.stopPlayback()
    case .phase(let phase, let label):
      self.phase = phase
      phaseLabel = label
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
