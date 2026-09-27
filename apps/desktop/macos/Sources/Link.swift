import Foundation

extension ShellConfig {
  /// The daemon's connection secret, which only this user can read: next to the settings file.
  var tokenFile: URL { home.appendingPathComponent("run", isDirectory: true).appendingPathComponent("ws-token") }
}

/// The app's line to the daemon: a WebSocket on this Mac, with JSON events both ways and the
/// microphone as binary frames. It reconnects by itself - the daemon restarts, or starts late.
/// The daemon only answers clients that show its connection secret, read afresh for each connection.
final class Link: NSObject, URLSessionWebSocketDelegate {
  var onEvent: ([String: Any]) -> Void = { _ in }
  var onOpen: () -> Void = {}
  var onClose: () -> Void = {}
  private(set) var isOpen = false
  private let url: URL
  private let tokenFile: URL?
  private var task: URLSessionWebSocketTask?
  private lazy var session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: .main)
  private var retry: Timer?
  private var stopped = true

  init(url: URL, tokenFile: URL?) {
    self.url = url
    self.tokenFile = tokenFile
  }

  /// The secret's file is where shell.json says the settings file is.
  convenience init(url: URL) {
    self.init(url: url, tokenFile: ShellConfig.load()?.tokenFile)
  }

  /// The daemon's address with the secret, as the file holds it now (it's made when the daemon first starts).
  private func address() -> URL {
    guard let tokenFile, let raw = try? String(contentsOf: tokenFile, encoding: .utf8) else { return url }
    let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !token.isEmpty, var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
    parts.queryItems = (parts.queryItems ?? []).filter { $0.name != "token" } + [URLQueryItem(name: "token", value: token)]
    return parts.url ?? url
  }

  func start() {
    stopped = false
    connect()
  }

  func stop() {
    stopped = true
    retry?.invalidate()
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    isOpen = false
  }

  func send(_ event: [String: Any]) {
    guard isOpen, let task, let data = try? JSONSerialization.data(withJSONObject: event), let text = String(data: data, encoding: .utf8) else { return }
    task.send(.string(text)) { _ in }
  }

  func sendAudio(_ pcm: Data) {
    guard isOpen, let task else { return }
    task.send(.data(pcm)) { _ in }
  }

  private func connect() {
    retry?.invalidate()
    retry = nil
    let task = session.webSocketTask(with: address())
    task.maximumMessageSize = 32 << 20 // a long sentence of speech audio is several MB of base64
    self.task = task
    task.resume()
    receive(task)
  }

  private func receive(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      DispatchQueue.main.async {
        guard let self, task === self.task else { return }
        switch result {
        case .success(let message):
          if case .string(let text) = message, let data = text.data(using: .utf8),
             let event = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            self.onEvent(event)
          }
          self.receive(task)
        case .failure:
          self.closed(task)
        }
      }
    }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    guard webSocketTask === task else { return }
    isOpen = true
    onOpen()
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    closed(webSocketTask)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if let socket = task as? URLSessionWebSocketTask { closed(socket) }
  }

  private func closed(_ which: URLSessionWebSocketTask) {
    guard which === task else { return }
    task = nil
    let was = isOpen
    isOpen = false
    if was { onClose() }
    guard !stopped else { return }
    retry = Timer.scheduledTimer(withTimeInterval: was ? 0.3 : 1.0, repeats: false) { [weak self] _ in self?.connect() }
  }
}
