import AppKit
import AVFoundation
import EventKit

/// Nova.app. It runs the daemon, hears and speaks for Nova (one audio engine, so Nova never hears
/// itself), answers the shortcut, and shows Nova in the menu bar, in the floating orb and in its
/// window. It decides when the microphone listens: always for Nova's name (the default), while the
/// window is open, or only after the shortcut - never while muted, locked or asleep.
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  private let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
  private var config: ShellConfig!
  private var link: Link!
  private var daemon: DaemonHost!
  private let voice = Voice()
  private let hotkey = Hotkey(id: 1)
  /// ⌃⌥⌘. - stop everything, from anywhere.
  private let stopKey = Hotkey(id: 2)
  private static let stopShortcut = Shortcut("control+option+command+.")
  private let bar = MenuBar()
  private let organizer = Organizer()
  private let notifier = Notifier()
  private var unlockedAt: Date?
  private var sentContext = ""
  private var contextSentAt = Date.distantPast
  private var hudPage: WebHost!
  private var hud: HudPanel!
  private var windowPage: WebHost?
  private var window: MainWindow?
  private var windowPanel: String?
  private var devUiUp = false
  private var timers: [Timer] = []
  private var signals: [DispatchSourceSignal] = []

  // What Nova is doing, as the daemon says.
  private var name = "Nova"
  private var phase = "idle"
  /// The daemon's hearing: "ready" on this Mac, "starting", or "browser" (it can't use the app's microphone).
  private var hearing = "starting"
  private var presence = PresenceConfig()
  private var configured = false

  // The microphone. Muting outlasts a restart: the microphone never comes back on by itself.
  private var muted = UserDefaults.standard.bool(forKey: "muted")
  private var locked = false
  private var asleep = false
  /// The shortcut summoned Nova: the microphone listens until the conversation is over, whatever the mode.
  private var summoned = false
  private var pressedAt = Date.distantPast
  private var secondTap = false
  /// Listening hands-free after a tap, with nothing heard yet - a second tap stops it.
  private var tapped = false
  private var heardSinceTap = false
  /// "hold" or "tap", for the orb.
  private var talk: String?

  private var appliedShortcut: String?
  private var shortcutState: (ok: Bool, message: String?) = (false, nil)
  private var appliedLogin: Bool?
  private var loginItem: (state: String, message: String?) = ("off", nil)
  private var sentStatus = ""
  private var sentState = ""
  private var sentLevel = Date.distantPast

  func applicationDidFinishLaunching(_ notification: Notification) {
    guard let config = ShellConfig.load() else {
      let alert = NSAlert()
      alert.messageText = "Nova.app needs to be built by Nova"
      alert.informativeText = "Run npm run app in your Nova folder: it builds Nova.app on this Mac and puts it in ~/Applications."
      alert.runModal()
      return NSApp.terminate(nil)
    }
    self.config = config
    daemon = DaemonHost(config: config)
    daemon.onChange = { [weak self] in self?.refresh() }
    link = Link(url: config.daemonSocket)
    link.onOpen = { [weak self] in self?.connected() }
    link.onClose = { [weak self] in self?.disconnected() }
    link.onEvent = { [weak self] in self?.handle($0) }
    voice.onFrame = { [weak self] in self?.link.sendAudio($0) }
    voice.onLevel = { [weak self] in self?.level($0) }
    voice.onFinished = { [weak self] in
      self?.link.send(["type": "speech-finished"])
      self?.refresh()
    }
    voice.onProblem = { novaLog.error("\($0, privacy: .public)") }
    notifier.onAction = { [weak self] ref, action in self?.link.send(["type": "notification-action", "ref": ref, "action": action]) }
    notifier.onOpen = { [weak self] in self?.openWindow() }
    notifier.setUp()
    hotkey.onPress = { [weak self] in self?.pressed() }
    hotkey.onRelease = { [weak self] in self?.released() }
    stopKey.onPress = { [weak self] in self?.stopEverything() }
    if let stop = AppDelegate.stopShortcut, let problem = stopKey.register(stop) { novaLog.error("The stop shortcut: \(problem, privacy: .public)") }
    bar.fill = { [weak self] in self?.fillMenu($0) }

    hudPage = WebHost(transparent: true, allowedOrigins: { [weak self] in self?.allowedOrigins() ?? [] }) { [weak self] in self?.page(hud: true) ?? config.daemonPage }
    hudPage.onMessage = { [weak self] in self?.fromPage($0) }
    hudPage.onLoad = { [weak self] in self?.pushState(force: true) }
    hud = HudPanel(web: hudPage.view)
    hud.title = name

    // What Settings said last time, so the microphone behaves correctly from this moment - not
    // "always" (the hardcoded default) - even before the daemon connects and says it again.
    if let last = PresenceConfig.loadLast() {
      presence = last
      configured = true
    }
    watchSystem()
    locked = AppDelegate.screenLocked()
    checkDevUi()
    timers.append(Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.checkDevUi() })
    applyPresence()
    daemon.begin()
    link.start()
    if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined { requestMicrophone() }
    // Reminders, the briefing and agents' news show as notifications: ask once.
    notifier.refresh { [weak self] in
      guard let self, self.notifier.access == "undetermined", !UserDefaults.standard.bool(forKey: "askedNotifications") else { return }
      UserDefaults.standard.set(true, forKey: "askedNotifications")
      self.notifier.request { self.pushState(force: true) }
    }
    // Whether the user is here: locked, on a call, away from the keyboard - for when Nova may speak up.
    timers.append(Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in self?.pushContext(force: false) })
    refresh()
  }

  func applicationWillTerminate(_ notification: Notification) {
    link?.stop()
    voice.shutdown()
    daemon?.stop()
  }

  /// Opening the app again (Finder, Spotlight, the Dock) shows its window.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    openWindow()
    return true
  }

  // MARK: The daemon

  private func connected() {
    daemon.connected()
    link.send(["type": "shell-hello", "kind": "mac", "version": version])
    sentStatus = ""
    if voice.capturing { link.send(["type": "audio-start", "sampleRate": 16_000]) }
    refresh()
    pushContext(force: true)
  }

  private func disconnected() {
    phase = "idle"
    summoned = false
    voice.stopPlayback()
    refresh()
  }

  private func handle(_ event: [String: Any]) {
    switch event["type"] as? String {
    case "hello":
      name = event["name"] as? String ?? name
      hud.title = name
      window?.title = name
      if let status = event["hearing"] as? [String: Any] { heard(status) }
    case "hearing":
      if let status = event["status"] as? [String: Any] { heard(status) }
    case "shell-config":
      if let json = event["presence"] as? [String: Any] {
        presence = PresenceConfig(json)
        configured = true
        presence.saveAsLast()
        applyPresence()
      }
    case "shell-action":
      perform(event["action"] as? String ?? "")
    case "shell-request":
      answer(event)
    case "phase":
      phase = event["phase"] as? String ?? "idle"
      if phase == "idle" { clearTalk() } // the conversation is over: back to listening the usual way
    case "transcript":
      if let text = event["text"] as? String, !text.isEmpty { heardSinceTap = true }
    case "say":
      said(event)
    case "audio":
      audio(event)
    case "barge-in":
      voice.stopPlayback()
    case "listen":
      // "Stop listening" said out loud mutes the microphone; the shortcut still works.
      if let on = event["on"] as? Bool { setMuted(!on) }
    case "show":
      openWindow(panel: event["panel"] as? String == "welcome" ? "welcome" : "settings")
    default:
      return
    }
    refresh()
  }

  private func heard(_ status: [String: Any]) {
    hearing = status["engine"] as? String == "browser" ? "browser" : (status["state"] as? String ?? "starting")
  }

  /// A reply. Kokoro's audio follows it; without Kokoro (not in the app) it's shown, not spoken, so it's done at once.
  private func said(_ event: [String: Any]) {
    guard event["audio"] == nil, event["partial"] as? Bool != true else { return }
    link.send(["type": "speech-finished"])
  }

  private func audio(_ event: [String: Any]) {
    guard let id = event["id"] as? String else { return }
    let seq = (event["seq"] as? NSNumber)?.intValue ?? 0
    if let error = event["error"] as? String, !error.isEmpty {
      // What already came plays out; the rest of this reply is shown, not spoken.
      novaLog.error("Kokoro couldn't speak: \(error, privacy: .public)")
      voice.play(id: id, seq: seq, sampleRate: 24_000, pcm: Data(), last: true)
      return
    }
    voice.play(id: id, seq: seq, sampleRate: (event["sampleRate"] as? NSNumber)?.doubleValue ?? 24_000,
               pcm: Data(base64Encoded: event["pcm"] as? String ?? "") ?? Data(), last: event["last"] as? Bool ?? false)
  }

  private func perform(_ action: String) {
    switch action {
    case "request-mic": requestMicrophone()
    case "open-mic-settings": open("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
    case "open-login-items": open("x-apple.systempreferences:com.apple.LoginItems-Settings.extension")
    case "restart-daemon": daemon.restart()
    case "request-calendar": organizer.ensure(.event) { [weak self] _ in self?.pushState(force: true) }
    case "request-reminders": organizer.ensure(.reminder) { [weak self] _ in self?.pushState(force: true) }
    case "request-notifications": notifier.request { [weak self] in self?.pushState(force: true) }
    case "open-privacy-settings": open("x-apple.systempreferences:com.apple.preference.security?Privacy")
    default: break
    }
  }

  /// The daemon asks something of the Mac: the Reminders app, the calendar, a notification.
  private func answer(_ event: [String: Any]) {
    guard let id = event["id"] as? String, let op = event["op"] as? String else { return }
    let args = event["args"] as? [String: Any] ?? [:]
    let reply = { [weak self] (ok: Bool, result: Any?, error: String?) in
      var message: [String: Any] = ["type": "shell-reply", "id": id, "ok": ok]
      if let result { message["result"] = result }
      if let error { message["error"] = error }
      self?.link.send(message)
      self?.pushState(force: false)
    }
    let date = { (key: String) in (args[key] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) } }
    switch op {
    case "calendar.events":
      organizer.ensure(.event) { [weak self] granted in
        guard let self, granted else { return reply(false, nil, "Nova may not read your calendar - System Settings → Privacy & Security → Calendars.") }
        reply(true, self.organizer.events(from: date("from") ?? Date(), to: date("to") ?? Date().addingTimeInterval(86_400)), nil)
      }
    case "reminders.add", "reminders.list", "reminders.complete", "reminders.remove":
      organizer.ensure(.reminder) { [weak self] granted in
        guard let self, granted else { return reply(false, nil, "Nova may not use the Reminders app - System Settings → Privacy & Security → Reminders.") }
        do {
          switch op {
          case "reminders.add": reply(true, try self.organizer.addReminder(title: args["title"] as? String ?? "Reminder", due: date("due"), list: args["list"] as? String ?? ""), nil)
          case "reminders.list": self.organizer.reminders(days: (args["days"] as? NSNumber)?.intValue ?? 7) { reply(true, $0, nil) }
          case "reminders.complete":
            try self.organizer.complete(args["id"] as? String ?? "")
            reply(true, nil, nil)
          default:
            try self.organizer.remove(args["id"] as? String ?? "")
            reply(true, nil, nil)
          }
        } catch {
          reply(false, nil, error.localizedDescription)
        }
      }
    case "notify":
      notifier.post(ref: args["ref"] as? String ?? "", title: args["title"] as? String ?? name, body: args["body"] as? String ?? "", actions: !((args["actions"] as? [String]) ?? []).isEmpty)
      reply(true, nil, nil)
    default:
      reply(false, nil, "Nova.app doesn't know \(op).")
    }
  }

  /// Whether the user is here, for when Nova may speak up: sent when it changes, and now and then for the idle time.
  private func pushContext(force: Bool) {
    guard link.isOpen else { return }
    var context: [String: Any] = ["locked": locked, "camera": UserPresence.cameraOn(), "idleSeconds": Int(UserPresence.idleSeconds())]
    if let unlockedAt { context["unlockedAt"] = (unlockedAt.timeIntervalSince1970 * 1000).rounded() }
    let key = "\(context["locked"]!)|\(context["camera"]!)|\(context["unlockedAt"] ?? "")"
    guard force || key != sentContext || Date().timeIntervalSince(contextSentAt) >= 30 else { return }
    sentContext = key
    contextSentAt = Date()
    link.send(["type": "shell-context", "context": context])
  }

  // MARK: The microphone

  private var micAllowed: Bool { AVCaptureDevice.authorizationStatus(for: .audio) == .authorized }

  /// Whether the microphone should be on right now.
  private var wantsMicrophone: Bool {
    // Not configured yet: Settings hasn't said what to do (or a persisted guess), so the microphone
    // stays off rather than briefly listening "always" - the hardcoded default - at every launch.
    guard configured, micAllowed, !asleep, link.isOpen, hearing != "browser" else { return false }
    // Locked or muted always wins, even over a shortcut summon from before the screen locked.
    if muted || (locked && presence.pauseWhenLocked) { return false }
    if summoned { return true }
    switch presence.listen {
    case "always": return true
    case "window": return window?.isVisible == true
    default: return false
    }
  }

  /// What it's doing with the microphone, for Settings and the menu.
  private var listening: String {
    if !micAllowed { return "no-mic" }
    if !link.isOpen { return "starting" }
    if locked && presence.pauseWhenLocked && !summoned { return "locked" }
    if muted { return "muted" }
    switch presence.listen {
    case "always": return "wake-word"
    case "window": return "window"
    default: return "shortcut"
    }
  }

  private func requestMicrophone() {
    AVCaptureDevice.requestAccess(for: .audio) { [weak self] _ in
      DispatchQueue.main.async { self?.refresh() }
    }
  }

  private func setMuted(_ on: Bool) {
    muted = on
    UserDefaults.standard.set(on, forKey: "muted")
    if on { clearTalk() }
    refresh()
  }

  /// Whatever the shortcut was doing is over: muted, the screen locked or slept, or the conversation
  /// finished. Cleared here so a stale summon can't keep the microphone on through any of those.
  private func clearTalk() {
    summoned = false
    tapped = false
    talk = nil
  }

  private func level(_ value: Float) {
    let now = Date()
    guard now.timeIntervalSince(sentLevel) > 0.05 else { return }
    sentLevel = now
    if hud.isVisible { hudPage.call("level", value) }
    if window?.isVisible == true { windowPage?.call("level", value) }
  }

  // MARK: The shortcut

  /// Down: Nova stops talking and listens - what comes next is for it.
  private func pressed() {
    pressedAt = Date()
    secondTap = tapped && phase == "listening" && !heardSinceTap
    if voice.speaking { voice.stopPlayback() } // cut in at once; the daemon stops the rest
    summoned = true
    talk = "hold"
    // Before refresh(), which can block for a moment rebuilding voice processing for the microphone -
    // the daemon should hear "talk-start" (and so stop and listen) without waiting on that.
    link.send(["type": "talk-start"])
    refresh() // the microphone comes on, if it was off
    if presence.sounds && !secondTap { voice.chime() }
    pushState(force: true)
  }

  /// Up: held, what they said is done; tapped, Nova listens until they pause. Tapped again, it stops.
  private func released() {
    let held = Date().timeIntervalSince(pressedAt) > 0.35
    if secondTap && !held {
      link.send(["type": "listen-stop"])
      summoned = false
      tapped = false
      talk = nil
    } else {
      link.send(["type": "talk-end", "held": held])
      tapped = !held
      heardSinceTap = false
      talk = held ? nil : "tap"
    }
    secondTap = false
    refresh()
    pushState(force: true)
  }

  @objc private func talkNow() {
    pressed()
    released()
  }

  /// Stop everything: agents, questions, speech - and mute, here at once, whatever the daemon is doing.
  @objc private func stopEverything() {
    voice.stopPlayback()
    link.send(["type": "stop-all"])
    setMuted(true)
  }

  // MARK: Settings

  private func applyPresence() {
    if appliedShortcut != presence.shortcut {
      appliedShortcut = presence.shortcut
      if let shortcut = Shortcut(presence.shortcut) {
        let problem = hotkey.register(shortcut)
        shortcutState = (problem == nil, problem)
      } else {
        hotkey.unregister()
        shortcutState = (false, "“\(presence.shortcut)” isn't a shortcut Nova knows")
      }
    }
    // Opening at login follows the user's choice, once the daemon has said what it is.
    if configured, appliedLogin != presence.launchAtLogin {
      appliedLogin = presence.launchAtLogin
      loginItem = LoginItem.apply(presence.launchAtLogin)
    }
    hud.corner = presence.orb
    refresh()
  }

  // MARK: What everyone sees

  private func refresh() {
    let want = wantsMicrophone
    if want != voice.capturing {
      voice.setCapture(want)
      if link.isOpen { link.send(want ? ["type": "audio-start", "sampleRate": 16_000] : ["type": "audio-stop"]) }
    }
    pushState(force: false)
    bar.show(look(), tip: "\(name) - \(statusLine())")
  }

  private func pushState(force: Bool) {
    var shortcut: [String: Any] = ["keys": presence.shortcut, "ok": shortcutState.ok]
    if let message = shortcutState.message { shortcut["message"] = message }
    var status: [String: Any] = [
      "version": version,
      "mic": micStatus(),
      "listening": listening,
      "loginItem": appliedLogin == nil ? LoginItem.current() : loginItem.state,
      "shortcut": shortcut,
      "daemon": daemon.hosted ? "hosted" : "external",
    ]
    if let message = loginItem.message { status["loginItemMessage"] = message }
    status["access"] = ["calendar": Organizer.access(.event), "reminders": Organizer.access(.reminder), "notifications": notifier.access]
    if let json = AppDelegate.json(status), force || json != sentStatus, link.isOpen {
      sentStatus = json
      link.send(["type": "shell-status", "status": status])
    }
    let state: [String: Any] = [
      "muted": muted,
      "listening": listening,
      "shortcut": Shortcut(presence.shortcut)?.display ?? presence.shortcut,
      "talk": talk ?? NSNull(),
      "orbSeconds": presence.orbSeconds,
      "corner": presence.orb,
    ]
    if let json = AppDelegate.json(state), force || json != sentState {
      sentState = json
      hudPage.call("state", state)
      windowPage?.call("state", state)
    }
  }

  private func micStatus() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    default: return "undetermined"
    }
  }

  private func look() -> MenuBar.Look {
    guard link.isOpen else { return .offline }
    if phase == "thinking" || phase == "acting" { return .thinking }
    if phase == "speaking" || voice.speaking { return .speaking }
    if !micAllowed || (muted && !summoned) { return .muted }
    if locked && presence.pauseWhenLocked && !summoned { return .paused }
    return phase == "listening" ? .listening : .idle
  }

  private func statusLine() -> String {
    guard link.isOpen else {
      switch daemon.state {
      case .failed(let why): return "Nova's daemon stopped: \(why)"
      case .elsewhere: return "Waiting for Nova's daemon (npm run dev)"
      default: return "Starting…"
      }
    }
    if hearing == "browser" { return "Hearing is set to the browser - choose Apple or Parakeet in Settings → Hearing" }
    let keys = Shortcut(presence.shortcut)?.display ?? presence.shortcut
    switch listening {
    case "wake-word": return "Listening for “\(name)” · \(keys) to talk"
    case "window": return "Listening while the window is open · \(keys) to talk"
    case "shortcut": return "Press \(keys) to talk"
    case "muted": return "Microphone muted · \(keys) still works"
    case "locked": return "Paused while the Mac is locked"
    case "no-mic": return "Nova can't use the microphone"
    default: return "Starting…"
    }
  }

  private func fillMenu(_ menu: NSMenu) {
    func item(_ title: String, _ action: Selector?, key: String = "") -> NSMenuItem {
      let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
      item.target = self
      item.isEnabled = action != nil
      menu.addItem(item)
      return item
    }
    _ = item(statusLine(), nil)
    menu.addItem(.separator())
    let keys = hotkey.shortcut.map { " (\($0.display))" } ?? ""
    _ = item("Talk to \(name)\(keys)", link.isOpen ? #selector(talkNow) : nil)
    let stop = item("Stop Everything", link.isOpen ? #selector(stopEverything) : nil, key: ".")
    stop.keyEquivalentModifierMask = [.control, .option, .command]
    if micAllowed {
      _ = item(muted ? "Unmute the Microphone" : "Mute the Microphone", #selector(toggleMute))
    } else {
      _ = item("Allow the Microphone…", #selector(allowMicrophone))
    }
    menu.addItem(.separator())
    _ = item("Open \(name)", #selector(openMain))
    _ = item("Settings…", #selector(openSettings), key: ",")
    menu.addItem(.separator())
    switch daemon.state {
    case .starting: _ = item("Daemon: starting…", nil)
    case .running: _ = item("Daemon: running", nil)
    case .elsewhere: _ = item(link.isOpen ? "Daemon: started in a terminal" : "Daemon: not running", nil)
    case .failed(let why): _ = item("Daemon: \(why)", nil)
    case .checking: _ = item("Daemon: looking for it…", nil)
    }
    if daemon.hosted || daemon.state != .elsewhere {
      _ = item("Restart the Daemon", #selector(restartDaemon))
      _ = item("Show the Daemon's Log", #selector(showLog))
    }
    menu.addItem(.separator())
    _ = item("Quit Nova", #selector(quit), key: "q")
  }

  @objc private func toggleMute() { setMuted(!muted) }

  @objc private func allowMicrophone() {
    if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined { requestMicrophone() } else { perform("open-mic-settings") }
  }

  @objc private func openMain() { openWindow() }

  @objc private func openSettings() { openWindow(panel: "settings") }

  @objc private func restartDaemon() { daemon.restart() }

  @objc private func showLog() { NSWorkspace.shared.open(daemon.log) }

  @objc private func quit() { NSApp.terminate(nil) }

  // MARK: The orb and the window

  private func fromPage(_ message: [String: Any]) {
    switch message["type"] as? String {
    case "hud":
      let number = { (key: String) in CGFloat((message[key] as? NSNumber)?.doubleValue ?? 64) }
      hud.show(message["state"] as? String ?? "hidden", width: number("width"), height: number("height"))
    case "expand": openWindow()
    case "talk": talkNow()
    case "mute": setMuted(message["on"] as? Bool ?? true)
    case "preview":
      if let voice = message["voice"] as? String { previewVoice(voice) }
    default: break
    }
  }

  /// Settings asked to hear a voice: asked for over the app's own connection, so the audio comes
  /// back through Voice's engine (already wired to `handle`'s "audio" case) - echo-cancelled, like
  /// any other reply - rather than through the page's own, which the microphone would just hear.
  private func previewVoice(_ voice: String) {
    link.send(["type": "voice-preview", "id": "preview-\(UUID().uuidString.prefix(8))", "voice": voice])
  }

  private func openWindow(panel: String? = nil) {
    if window == nil {
      windowPanel = panel
      let page = WebHost(transparent: false, allowedOrigins: { [weak self] in self?.allowedOrigins() ?? [] }) { [weak self] in self?.page(hud: false) ?? self!.config.daemonPage }
      page.onMessage = { [weak self] in self?.fromPage($0) }
      page.onLoad = { [weak self] in
        self?.windowPanel = nil
        self?.pushState(force: true)
      }
      let window = MainWindow(web: page.view, title: name)
      window.delegate = self
      self.window = window
      windowPage = page
    } else if let panel {
      // windowPanel only takes on a fresh page load - the window already has one, so the page is
      // told directly (novaShell.open), the same way a live state push reaches it.
      windowPage?.call("open", panel)
    }
    NSApp.setActivationPolicy(.regular)
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate()
    refresh()
  }

  func windowWillClose(_ notification: Notification) {
    guard (notification.object as? NSWindow) === window else { return }
    NSApp.setActivationPolicy(.accessory)
    DispatchQueue.main.async { [weak self] in self?.refresh() }
  }

  /// The page's address: the dev server while it runs, else the daemon, which serves the built window.
  private func page(hud: Bool) -> URL {
    let base = devUiUp ? (config.devUi.flatMap { URL(string: $0) } ?? config.daemonPage) : config.daemonPage
    var parts = URLComponents(url: base, resolvingAgainstBaseURL: false)!
    parts.path = "/"
    parts.queryItems = [URLQueryItem(name: "shell", value: "mac"), URLQueryItem(name: "daemon", value: config.daemonSocket.absoluteString)]
      + (hud ? [URLQueryItem(name: "view", value: "hud")] : [])
      + (!hud && windowPanel != nil ? [URLQueryItem(name: "panel", value: windowPanel)] : [])
    return parts.url!
  }

  private func checkDevUi() {
    guard let dev = config.devUi, let url = URL(string: dev) else { return }
    var request = URLRequest(url: url)
    request.timeoutInterval = 0.6
    URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
      let up = (response as? HTTPURLResponse)?.statusCode == 200 && AppDelegate.isNovaPage(data)
      DispatchQueue.main.async {
        guard let self, up != self.devUiUp else { return }
        self.devUiUp = up
        self.hudPage.reload()
        self.windowPage?.reload()
      }
    }.resume()
  }

  /// Whatever answers on the dev server's port - before the app treats it as Nova's own and loads it
  /// into its privileged views. Anyone can run a Vite project on 5173; this checks the page itself,
  /// not just that something's there. `apps/desktop/index.html` ideally carries a `nova-app` meta tag
  /// (ask the lead to add one) - until then, the page's known entry point is the fallback signal.
  static func isNovaPage(_ data: Data?) -> Bool {
    guard let data, let body = String(data: data, encoding: .utf8) else { return false }
    return body.contains(#"name="nova-app""#) || (body.contains("/src/main.tsx") && body.contains("<title>Nova</title>"))
  }

  /// Origins the page may load from and talk to the app from: the daemon's own address always, and
  /// the dev server too while it's confirmed to be Nova's own and switched on. Anything else is a
  /// stranger that happens to answer on the same port, or a page trying to take Nova's window
  /// somewhere else - never trusted with the microphone, HUD sizing, or a place to navigate to.
  private func allowedOrigins() -> Set<String> {
    var origins: Set<String> = []
    if let o = WebHost.originString(config.daemonPage) { origins.insert(o) }
    if devUiUp, let dev = config.devUi, let url = URL(string: dev), let o = WebHost.originString(url) { origins.insert(o) }
    return origins
  }

  // MARK: The Mac

  private func watchSystem() {
    let distributed = DistributedNotificationCenter.default()
    distributed.addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
      self?.locked = true
      self?.clearTalk() // whatever the shortcut had going is over now, not resumed on unlock
      self?.refresh()
      self?.pushContext(force: true)
    }
    distributed.addObserver(forName: .init("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
      self?.locked = false
      self?.unlockedAt = Date() // the morning briefing comes on the first unlock of the day
      self?.refresh()
      self?.pushContext(force: true)
    }
    // Opened again while running (a second copy asked): show the window.
    distributed.addObserver(forName: .init("dev.nova.app.open"), object: nil, queue: .main) { [weak self] _ in self?.openWindow() }
    let workspace = NSWorkspace.shared.notificationCenter
    workspace.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
      self?.asleep = true
      self?.clearTalk() // whatever the shortcut had going is over now, not resumed on waking
      self?.refresh()
    }
    workspace.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
      self?.asleep = false
      self?.refresh()
    }
    // Asked to quit (npm run app replacing it): quit properly, stopping the daemon.
    for sig in [SIGTERM, SIGINT] {
      signal(sig, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
      source.setEventHandler { NSApp.terminate(nil) }
      source.resume()
      signals.append(source)
    }
  }

  private func open(_ address: String) {
    if let url = URL(string: address) { NSWorkspace.shared.open(url) }
  }

  static func screenLocked() -> Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    return session["CGSSessionScreenIsLocked"] as? Bool ?? false
  }

  static func json(_ value: Any) -> String? {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return nil }
    return String(data: data, encoding: .utf8)
  }
}
