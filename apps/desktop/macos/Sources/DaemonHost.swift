import Foundation

/// Nova's daemon, run by the app: started when the app opens - unless one is already running (in
/// a terminal, say) or the user runs their own - started again if it stops, and stopped when the
/// app quits. Its output goes to ~/.nova/logs/daemon.log.
final class DaemonHost {
  enum State: Equatable {
    case checking
    /// The app runs it.
    case starting, running
    /// Someone else runs it; the app only connects.
    case elsewhere
    case failed(String)
  }

  private(set) var state: State = .checking {
    didSet { if state != oldValue { onChange() } }
  }
  var onChange: () -> Void = {}
  let log: URL
  private let config: ShellConfig
  private var process: Process?
  private var stopping = false
  private var starts: [Date] = []

  init(config: ShellConfig) {
    self.config = config
    let logs = config.home.appendingPathComponent("logs")
    try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
    log = logs.appendingPathComponent("daemon.log")
  }

  /// Whether the app runs the daemon (rather than someone else).
  var hosted: Bool { process != nil }

  /// At launch: use a daemon that's already answering, else start one - unless the user runs their own.
  func begin() {
    answering { [weak self] up in
      guard let self else { return }
      if up || !self.config.runsDaemon() {
        self.state = .elsewhere
      } else {
        self.start()
      }
    }
  }

  /// The app connected to the daemon.
  func connected() {
    if process != nil { state = .running }
  }

  func start() {
    guard process == nil else { return }
    // Stopping over and over: something's wrong that restarting won't fix.
    let now = Date()
    starts = starts.filter { now.timeIntervalSince($0) < 120 } + [now]
    guard starts.count <= 5 else {
      state = .failed("It keeps stopping - see ~/.nova/logs/daemon.log")
      return
    }
    rotateLog()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: node())
    // tsx's loader inside this one node process - not its command-line wrapper, which would start another:
    // the daemon must be Nova.app's own child, since that's what Nova Eyes checks before it answers.
    let tsx = "\(config.repo)/node_modules/tsx/dist"
    process.arguments = ["--require", "\(tsx)/preflight.cjs", "--import", URL(fileURLWithPath: "\(tsx)/loader.mjs").absoluteString, "src/server.ts"]
    process.currentDirectoryURL = URL(fileURLWithPath: "\(config.repo)/apps/daemon")
    var environment = ProcessInfo.processInfo.environment
    environment["PATH"] = config.path
    // Nova's voice (Kokoro) comes inside the app.
    if let models = Bundle.main.resourceURL?.appendingPathComponent("models") { environment["NOVA_BUNDLED_MODELS"] = models.path }
    process.environment = environment
    process.standardInput = FileHandle.nullDevice
    if let handle = FileHandle(forWritingAtPath: log.path) ?? { FileManager.default.createFile(atPath: log.path, contents: nil); return FileHandle(forWritingAtPath: log.path) }() {
      handle.seekToEndOfFile()
      process.standardOutput = handle
      process.standardError = handle
    }
    process.terminationHandler = { [weak self] ended in
      DispatchQueue.main.async { self?.exited(ended) }
    }
    do {
      try process.run()
      self.process = process
      stopping = false
      state = .starting
    } catch {
      state = .failed("Couldn't start it: \(error.localizedDescription)")
    }
  }

  /// Start it afresh (Settings asked, or its settings need a new process).
  func restart() {
    guard let process, process.isRunning else { return start() }
    starts.removeAll()
    process.terminate() // exited() starts it again
  }

  /// The app is quitting: stop the daemon, giving it a moment to save what it was told.
  func stop() {
    guard let process, process.isRunning else { return }
    stopping = true
    process.terminate()
    let deadline = Date().addingTimeInterval(3)
    while process.isRunning && Date() < deadline { usleep(50_000) }
    if process.isRunning { kill(process.processIdentifier, SIGKILL) }
  }

  private func exited(_ ended: Process) {
    guard ended === process else { return }
    process = nil
    if stopping { return }
    state = .starting
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.start() }
  }

  /// Is anything answering on the daemon's port?
  private func answering(_ done: @escaping (Bool) -> Void) {
    var request = URLRequest(url: config.daemonPage.appendingPathComponent("nova-alive"))
    request.timeoutInterval = 0.8
    URLSession.shared.dataTask(with: request) { _, response, _ in
      DispatchQueue.main.async { done(response != nil) }
    }.resume()
  }

  /// Node as installed when the app was built, else the first one on the PATH.
  private func node() -> String {
    if FileManager.default.isExecutableFile(atPath: config.node) { return config.node }
    for dir in config.path.split(separator: ":") where FileManager.default.isExecutableFile(atPath: "\(dir)/node") { return "\(dir)/node" }
    return config.node
  }

  private func rotateLog() {
    guard let size = (try? FileManager.default.attributesOfItem(atPath: log.path))?[.size] as? Int, size > 5_000_000 else { return }
    let old = log.appendingPathExtension("1")
    try? FileManager.default.removeItem(at: old)
    try? FileManager.default.moveItem(at: log, to: old)
  }
}
