import Darwin
import Foundation

/// A Unix socket that only the given process may use: requests and answers are JSON lines.
final class EyesServer {
  private let path: String
  private let client: pid_t

  init(path: String, client: pid_t) {
    self.path = path
    self.client = client
  }

  func start() throws {
    unlink(path)
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw EyesError("socket() failed") }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8.prefix(103))
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
      for (i, b) in bytes.enumerated() { raw[i] = b }
      raw[bytes.count] = 0
    }
    let size = socklen_t(MemoryLayout<sockaddr_un>.size)
    let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) } }
    guard bound == 0 else { throw EyesError("bind(\(path)) failed: \(String(cString: strerror(errno)))") }
    chmod(path, 0o600)
    guard listen(fd, 4) == 0 else { throw EyesError("listen() failed") }
    Thread {
      while true {
        let conn = accept(fd, nil, nil)
        if conn < 0 { continue }
        // Only the daemon that launched Nova Eyes may ask it anything.
        var peer: pid_t = 0
        var len = socklen_t(MemoryLayout<pid_t>.size)
        if getsockopt(conn, SOL_LOCAL, LOCAL_PEERPID, &peer, &len) != 0 || peer != self.client {
          close(conn)
          continue
        }
        Thread { self.serve(conn) }.start()
      }
    }.start()
  }

  private func serve(_ fd: Int32) {
    let writes = DispatchQueue(label: "nova.eyes.write")
    var buffer = Data()
    var chunk = [UInt8](repeating: 0, count: 65536)
    while true {
      let n = read(fd, &chunk, chunk.count)
      if n <= 0 { break }
      buffer.append(contentsOf: chunk[0..<n])
      while let newline = buffer.firstIndex(of: 0x0a) {
        let line = buffer[buffer.startIndex..<newline]
        buffer = Data(buffer[(newline + 1)...])
        guard let request = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
        Task {
          var answer = await handle(request)
          answer["id"] = request["id"] ?? NSNull()
          guard var data = try? JSONSerialization.data(withJSONObject: answer) else { return }
          data.append(0x0a)
          writes.async { data.withUnsafeBytes { _ = write(fd, $0.baseAddress, data.count) } }
        }
      }
    }
    close(fd)
  }
}

struct EyesError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

func handle(_ request: [String: Any]) async -> [String: Any] {
  let skip = request["skipTitles"] as? [String] ?? []
  switch request["type"] as? String {
  case "ping":
    return ["ok": true]
  case "context":
    return await MainActor.run { Context.gather(skipTitles: skip) }
  case "look":
    return await Look.capture(scope: request["scope"] as? String ?? "window", maxSize: request["maxSize"] as? Int ?? 1568, image: request["image"] as? Bool ?? true, skipTitles: skip)
  case "permissions":
    return await MainActor.run { Permissions.request(request["request"] as? [String] ?? []) }

  // Nova's hands: seeing and using the front window.
  case "ui.snapshot":
    return await UISnapshots.take(scope: request["scope"] as? String ?? "screen", maxSize: request["maxSize"] as? Int ?? 1440, withImage: request["image"] as? Bool ?? true, skipTitles: skip)
  case "ui.act":
    return await UIActions.perform(request)
  case "ui.idle":
    return UIActions.idle()
  case "ui.highlight":
    return await MainActor.run { Highlight.show(request) }
  case "ui.unhighlight":
    await MainActor.run { Highlight.hide() }
    return ["ok": true]

  // Windows and apps.
  case "windows.list":
    return await Windows.list()
  case "windows.set":
    return await Windows.set(request)
  case "app.hide":
    return await Windows.app(request, "hide")
  case "app.unhide":
    return await Windows.app(request, "unhide")
  case "app.activate":
    return await Windows.app(request, "activate")
  case "app.unhideAll":
    return await Windows.app(request, "unhideAll")

  // The Mac's own controls.
  case "system.brightness":
    return SystemControls.brightness(request)
  case "system.bluetooth":
    return SystemControls.bluetooth(request)
  case "system.lock":
    return SystemControls.lock()
  case "media.key":
    let key = request["key"] as? String ?? ""
    return await MainActor.run { SystemControls.mediaKey(key) }

  // The clipboard and files.
  case "clipboard.read":
    return Clipboard.read(max: request["max"] as? Int ?? 20_000)
  case "clipboard.write":
    return Clipboard.write(request["text"] as? String ?? "")
  case "files.trash":
    return FileOps.trash(request["path"] as? String ?? "")
  case "files.untrash":
    return FileOps.untrash(request["trashed"] as? String ?? "", to: request["original"] as? String ?? "")
  case "files.text":
    return FileOps.pdfText(request["path"] as? String ?? "", max: request["max"] as? Int ?? 20_000)

  case "quit":
    exit(0)
  default:
    return ["error": "unknown request"]
  }
}
