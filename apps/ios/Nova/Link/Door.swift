import CryptoKit
import Foundation
import Network
import os

/// How connecting went, for Console.app (`dev.nova.phone`): which way, how long, and why it failed.
private let log = Logger(subsystem: "dev.nova.phone", category: "door")

/// The phone's side of Nova's door. It finds the Mac - by Bonjour on the Wi-Fi, or at the addresses it last
/// had, its tailnet's among them (Tailscale, from anywhere) - trying every way at once, connects over TLS accepting
/// only the certificate the pairing QR code named, and proves who the phone is by signing the Mac's challenge with
/// its key. Then it carries Nova's events both ways, and comes back by itself when the connection drops.
final class Door {
  enum State: Equatable {
    case idle
    case connecting
    case connected(name: String)
    /// Couldn't get in, and why. `unpaired`: the Mac doesn't know this phone any more - pair again.
    case failed(String, unpaired: Bool)
  }

  /// All called on the main queue.
  var onState: (State) -> Void = { _ in }
  var onEvent: (Incoming) -> Void = { _ in }
  /// Paired just now: what to keep.
  var onPaired: (PairedMac) -> Void = { _ in }

  /// How long the last ping took to come back, in seconds - how the phone tells a weak connection.
  var roundTrip: TimeInterval? { queue.sync { lastRoundTrip } }

  private enum Target {
    case paired(PairedMac)
    case pairing(PairingOffer)

    var mac: String {
      switch self {
      case .paired(let m): return m.mac
      case .pairing(let o): return o.mac
      }
    }
    var pin: String {
      switch self {
      case .paired(let m): return m.pin
      case .pairing(let o): return o.pin
      }
    }
    var hosts: [String] {
      switch self {
      case .paired(let m): return m.hosts
      case .pairing(let o): return o.hosts
      }
    }
    var port: Int {
      switch self {
      case .paired(let m): return m.port
      case .pairing(let o): return o.port
      }
    }
  }

  private let queue = DispatchQueue(label: "dev.nova.phone.door")
  private let key: DeviceKey
  private var target: Target?
  private var connection: NWConnection?
  /// A round's ways, all tried at once: the first in is the connection, the rest are let go.
  private var racing: [NWConnection] = []
  private var browser: NWBrowser?
  /// Where Bonjour last saw this phone's Mac.
  private var found: NWEndpoint?
  private var welcomed = false
  private var retry: DispatchWorkItem?
  private var backoff: TimeInterval = 1
  private var attempt = 0
  /// The ways tried since the last pause: each is tried once, straight away, before the phone waits.
  private var tried: [NWEndpoint] = []
  /// Bumped for every new connection, so an old one's callbacks are ignored.
  private var generation = 0
  private var pinger: DispatchSourceTimer?
  private var lastRoundTrip: TimeInterval?
  /// When this try to get in began.
  private var tryingSince = Date()

  init(key: DeviceKey) {
    self.key = key
  }

  /// Connect to the paired Mac, and stay connected.
  func connect(_ mac: PairedMac) {
    queue.async { self.start(.paired(mac)) }
  }

  /// Pair with the Mac this offer came from; once it's welcomed, it's the paired Mac.
  func pair(_ offer: PairingOffer) {
    queue.async { self.start(.pairing(offer)) }
  }

  /// Try again now - the app came back to the front, or Siri asks something - rather than wait out the backoff.
  func resume() {
    queue.async {
      guard let target = self.target, !self.welcomed else { return }
      self.backoff = 1
      self.start(target)
    }
  }

  /// Connect as soon as it can - Siri is waiting: straight away if it's resting or waiting to try again, while an
  /// attempt under way is left to finish.
  func hurry() {
    queue.async {
      guard let target = self.target, !self.welcomed else { return }
      if self.connection != nil, self.retry == nil { return }
      self.backoff = 1
      self.start(target)
    }
  }

  /// Let the connection go for now - Nova left the front with nothing to do - and don't look for the Mac again
  /// until `resume`. The Mac sees the phone go, so it speaks for itself again.
  func pause() {
    queue.async {
      guard self.target != nil, self.connection != nil || self.retry != nil else { return }
      self.stop()
      self.browser?.cancel()
      self.browser = nil // where it last saw the Mac is kept: that's tried first next time
      self.report(.idle)
    }
  }

  func disconnect() {
    queue.async {
      self.stop()
      self.target = nil
      self.report(.idle)
    }
  }

  func send(_ event: Outgoing) {
    guard let data = try? JSONSerialization.data(withJSONObject: event.json) else { return }
    queue.async { self.write(data, opcode: .text, onlyWelcomed: true) }
  }

  /// Microphone audio for the Mac's hearing: 16 kHz mono 16-bit PCM.
  func send(audio: Data) {
    queue.async { self.write(audio, opcode: .binary, onlyWelcomed: true) }
  }

  // MARK: - Connecting

  private func start(_ target: Target) {
    stop()
    tryingSince = Date()
    tried = []
    attempt = 0
    self.target = target
    browse(for: target.mac)
    open()
  }

  private func stop() {
    retry?.cancel()
    retry = nil
    pinger?.cancel()
    pinger = nil
    generation += 1
    connection?.cancel()
    connection = nil
    for other in racing { other.cancel() }
    racing = []
    welcomed = false
  }

  /// The ways to reach the Mac, best first: where Bonjour sees it now, then the addresses it had.
  private var endpoints: [NWEndpoint] {
    guard let target else { return [] }
    let port = NWEndpoint.Port(rawValue: UInt16(target.port)) ?? 7879
    return (found.map { [$0] } ?? []) + target.hosts.map { .hostPort(host: NWEndpoint.Host($0), port: port) }
  }

  private func open() {
    guard let target else { return }
    let ways = endpoints
    guard !ways.isEmpty else { return report(.failed("Looking for your Mac on this Wi-Fi…", unpaired: false)) }
    if attempt == 0 { report(.connecting) } // after that, why it couldn't stays up while it tries again
    // Every way at once - where Bonjour saw it, the Wi-Fi's addresses, the tailnet's: away from home, the ones that
    // can't answer don't hold up the one that can.
    tried = ways
    log.info("door: trying every way at once: \(ways.count) (attempt \(self.attempt))")
    let generation = self.generation
    var left = ways.count
    racing = ways.map { endpoint in
      let connection = NWConnection(to: endpoint, using: parameters(pin: target.pin))
      connection.stateUpdateHandler = { [weak self] state in
        guard let self, generation == self.generation else { return connection.cancel() }
        switch state {
        case .ready:
          guard self.connection == nil else { return connection.cancel() } // another way was in first
          log.info("door: in by \(String(describing: endpoint), privacy: .private)")
          self.connection = connection
          for other in self.racing where other !== connection { other.cancel() }
          self.racing = []
          self.receive(connection, generation: generation)
        case .waiting(let error), .failed(let error):
          guard self.connection !== connection else { return self.again() }
          connection.cancel()
          left -= 1
          log.notice("door: couldn't connect that way: \(error.localizedDescription, privacy: .public)")
          if left == 0, self.connection == nil { self.again() }
        case .cancelled, .setup, .preparing:
          break
        @unknown default:
          break
        }
      }
      connection.start(queue: queue)
      return connection
    }
    // Ways that never get anywhere (an address from another network) give up together.
    queue.asyncAfter(deadline: .now() + 6) { [weak self] in
      guard let self, generation == self.generation, !self.welcomed else { return }
      log.notice("door: no answer in 6 s")
      self.again()
    }
  }

  /// TLS that trusts only the Mac's own certificate (by its pin), and WebSocket over it.
  private func parameters(pin: String) -> NWParameters {
    let tls = NWProtocolTLS.Options()
    sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
    sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust, complete in
      let trust = sec_trust_copy_ref(trust).takeRetainedValue()
      guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return complete(false) }
      complete(Door.pin(of: SecCertificateCopyData(leaf) as Data) == pin)
    }, queue)
    let ws = NWProtocolWebSocket.Options()
    ws.autoReplyPing = true
    ws.maximumMessageSize = 8 << 20
    let parameters = NWParameters(tls: tls)
    parameters.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
    parameters.includePeerToPeer = false
    return parameters
  }

  /// SHA-256 of a certificate (DER), base64url without padding - as the pairing QR code carries it.
  static func pin(of der: Data) -> String {
    Data(SHA256.hash(data: der)).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  /// This way didn't work (or the connection dropped): the next way straight away - and once every way has been
  /// tried, the next round after a pause that grows.
  private func again() {
    guard target != nil, retry == nil else { return }
    let wasWelcomed = welcomed
    generation += 1
    connection?.cancel()
    connection = nil
    welcomed = false
    pinger?.cancel()
    attempt += 1
    let roundDone = endpoints.allSatisfy { tried.contains($0) }
    let wait = wasWelcomed ? 0.5 : roundDone ? backoff : 0.05
    if roundDone {
      tried = []
      backoff = min(backoff * 2, 15)
    }
    log.info("door: trying again in \(wait, format: .fixed(precision: 2)) s")
    if wasWelcomed {
      attempt = 0
    } else if roundDone, let target {
      // No way got in: say why it may be, and keep trying.
      let tailnet = target.hosts.contains(where: PhoneProtocol.isTailnet)
      report(.failed(tailnet ? "Can't reach your Mac - is Tailscale on?" : "Can't reach your Mac from here", unpaired: false))
    }
    let item = DispatchWorkItem { [weak self] in
      self?.retry = nil
      self?.open()
    }
    retry = item
    queue.asyncAfter(deadline: .now() + wait, execute: item)
  }

  private func browse(for mac: String) {
    browser?.cancel()
    let parameters = NWParameters()
    parameters.includePeerToPeer = false
    let browser = NWBrowser(for: .bonjourWithTXTRecord(type: "_nova._tcp", domain: nil), using: parameters)
    browser.browseResultsChangedHandler = { [weak self] results, _ in
      guard let self else { return }
      let mine = results.first { result in
        if case .bonjour(let txt) = result.metadata { return txt["id"] == mac }
        return false
      }
      let was = self.found
      self.found = mine?.endpoint
      // Seen for the first time while trying the old addresses: go there now.
      if was == nil, self.found != nil, !self.welcomed, self.retry != nil {
        self.retry?.cancel()
        self.retry = nil
        self.open()
      }
    }
    browser.start(queue: queue)
    self.browser = browser
  }

  // MARK: - Talking

  private func receive(_ connection: NWConnection, generation: Int) {
    connection.receiveMessage { [weak self] data, context, _, error in
      guard let self, generation == self.generation else { return }
      if error != nil { return self.again() }
      let meta = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
      if meta?.opcode == .close { return self.closed(meta?.closeCode) }
      if let data, !data.isEmpty, let event = Incoming.read(data) { self.handle(event) }
      self.receive(connection, generation: generation)
    }
  }

  private func handle(_ event: Incoming) {
    guard let target else { return }
    switch event {
    case .challenge(let nonce, let mac, _, let version):
      guard version == PhoneProtocol.version else { return fail("Nova on the Mac and on this iPhone are different versions - update the one that's older.", unpaired: false) }
      guard mac == target.mac else { return fail("That's another Mac than the one this iPhone is paired with.", unpaired: false) }
      do {
        switch target {
        case .pairing(let offer):
          let answer: [String: Any] = [
            "type": "phone-pair", "code": offer.code, "key": key.publicKey.base64EncodedString(),
            "device": ["name": deviceName, "model": deviceModel],
            "signature": try key.sign(PhoneProtocol.challenge("pair", mac: mac, nonce: nonce)).base64EncodedString(),
          ]
          write(try JSONSerialization.data(withJSONObject: answer), opcode: .text, onlyWelcomed: false)
        case .paired(let paired):
          let answer: [String: Any] = [
            "type": "phone-auth", "device": paired.device,
            "signature": try key.sign(PhoneProtocol.challenge("auth", mac: mac, nonce: nonce)).base64EncodedString(),
          ]
          write(try JSONSerialization.data(withJSONObject: answer), opcode: .text, onlyWelcomed: false)
        }
      } catch {
        fail("This iPhone couldn't sign in to the Mac: \(error.localizedDescription)", unpaired: false)
      }
    case .welcome(let device, let name, let hosts):
      log.notice("door: in after \(Date().timeIntervalSince(self.tryingSince), format: .fixed(precision: 2)) s")
      welcomed = true
      backoff = 1
      attempt = 0
      tried = []
      switch target {
      case .pairing(let offer):
        let paired = PairedMac(mac: offer.mac, name: name, hosts: hosts.isEmpty ? offer.hosts : hosts, port: offer.port, pin: offer.pin, device: device)
        self.target = .paired(paired)
        DispatchQueue.main.async { self.onPaired(paired) }
      case .paired(var paired) where !hosts.isEmpty && hosts != paired.hosts:
        // Where the Mac is now - a Tailscale address set up since pairing, a new one on the Wi-Fi - kept for next time.
        paired.hosts = hosts
        self.target = .paired(paired)
        DispatchQueue.main.async { self.onPaired(paired) }
      case .paired:
        break
      }
      startPinging()
      report(.connected(name: name))
    default:
      guard welcomed else { return }
      DispatchQueue.main.async { self.onEvent(event) }
    }
  }

  /// The door closed the connection: why, and whether trying again can help.
  private func closed(_ code: NWProtocolWebSocket.CloseCode?) {
    var number: UInt16?
    if case .privateCode(let n) = code { number = n }
    switch number.flatMap(PhoneProtocol.Closed.init) {
    case .unknown: fail("Your Mac doesn't know this iPhone any more. Pair it again from Nova's Settings → iPhone.", unpaired: true)
    case .refused: fail("That pairing code was wrong, used or ran out. Show a new one in Nova's Settings → iPhone.", unpaired: false)
    case .busy: fail("Too many wrong codes. Show a new one in Nova's Settings → iPhone.", unpaired: false)
    case .version: fail("Nova on the Mac and on this iPhone are different versions - update the one that's older.", unpaired: false)
    case .away:
      // Kept to the Wi-Fi now: the Mac's Tailscale address is let go, and the phone connects at home.
      if case .paired(var paired) = target {
        paired.hosts.removeAll(where: PhoneProtocol.isTailnet)
        target = .paired(paired)
        DispatchQueue.main.async { self.onPaired(paired) }
      }
      fail("Your Mac keeps Nova to your Wi-Fi - Settings → iPhone on the Mac.", unpaired: false)
    case nil: again()
    }
  }

  private func fail(_ message: String, unpaired: Bool) {
    stop()
    // A pairing that failed leaves nothing to come back to; a known Mac is tried again later, unless it forgot us.
    if case .pairing = target { target = nil }
    if unpaired { target = nil }
    report(.failed(message, unpaired: unpaired))
    if let target, !unpaired {
      let item = DispatchWorkItem { [weak self] in
        self?.retry = nil
        self?.start(target)
      }
      retry = item
      queue.asyncAfter(deadline: .now() + 15, execute: item)
    }
  }

  private func write(_ data: Data, opcode: NWProtocolWebSocket.Opcode, onlyWelcomed: Bool) {
    guard let connection, connection.state == .ready, welcomed || !onlyWelcomed else { return }
    let meta = NWProtocolWebSocket.Metadata(opcode: opcode)
    let context = NWConnection.ContentContext(identifier: "nova", metadata: [meta])
    connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
  }

  /// A ping every few seconds: how long it takes says whether the connection is weak.
  private func startPinging() {
    pinger?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + 1, repeating: 8)
    timer.setEventHandler { [weak self] in
      guard let self, let connection = self.connection, self.welcomed else { return }
      let meta = NWProtocolWebSocket.Metadata(opcode: .ping)
      let sent = Date()
      meta.setPongHandler(self.queue) { [weak self] error in
        if error == nil { self?.lastRoundTrip = Date().timeIntervalSince(sent) }
      }
      let context = NWConnection.ContentContext(identifier: "ping", metadata: [meta])
      connection.send(content: Data(), contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
    }
    timer.resume()
    pinger = timer
  }

  private func report(_ state: State) {
    DispatchQueue.main.async { self.onState(state) }
  }

  private var deviceName: String {
    // iOS gives apps only "iPhone" as the device's name; the model says a little more.
    "iPhone"
  }

  private var deviceModel: String {
    var info = utsname()
    uname(&info)
    let id = withUnsafeBytes(of: &info.machine) { raw in String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self) }
    return id.hasPrefix("x86") || id.hasPrefix("arm64") ? "Simulator" : id
  }
}
