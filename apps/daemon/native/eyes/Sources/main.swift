import AppKit

// Nova Eyes. Nova's daemon launches it (through LaunchServices, so it's its own app to macOS) with
// --socket <path> --parent <daemon pid>, and asks it one JSON line at a time over that socket.
// It answers only that process, and quits when it goes away.

let args = CommandLine.arguments
func option(_ flag: String) -> String? {
  guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
  return args[i + 1]
}

// Tests: read the text in an image file, or in a picture of some text drawn here.
if let path = option("--ocr") {
  printJSON(OCR.file(path))
  exit(0)
}
if let text = option("--ocr-selftest") {
  printJSON(["text": OCR.recognize(OCR.render(text))])
  exit(0)
}
if args.contains("--permissions") {
  printJSON(Permissions.status())
  exit(0)
}

guard let socket = option("--socket"), let parent = option("--parent").flatMap({ Int32($0) }) else {
  FileHandle.standardError.write(Data("usage: nova-eyes --socket <path> --parent <pid>\n".utf8))
  exit(2)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // no Dock icon, no menu bar
MainActor.assumeIsolated { Context.watch() }
let server = EyesServer(path: socket, client: parent)
do {
  try server.start()
} catch {
  FileHandle.standardError.write(Data("nova-eyes: \(error)\n".utf8))
  exit(1)
}
// Leave when Nova does.
Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
  if kill(parent, 0) != 0 && errno == ESRCH { exit(0) }
}
app.run()

func printJSON(_ value: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: value) { FileHandle.standardOutput.write(data + Data("\n".utf8)) }
}
