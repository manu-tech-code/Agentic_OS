import Foundation

private let output = DispatchQueue(label: "nova.apple-model.output")

/// One event to the daemon, as a line of JSON.
func emit(_ event: [String: Any]) {
  output.async {
    guard var data = try? JSONSerialization.data(withJSONObject: event) else { return }
    data.append(0x0a)
    FileHandle.standardOutput.write(data)
  }
}

/// Detailed logging to stderr, with NOVA_APPLE_DEBUG=1.
let debugging = ProcessInfo.processInfo.environment["NOVA_APPLE_DEBUG"] == "1"
func debug(_ message: @autoclosure () -> String) {
  if debugging { FileHandle.standardError.write(Data((message() + "\n").utf8)) }
}

/// Something the helper can't do, with a code the daemon reads and words it can say.
struct HelperError: LocalizedError {
  let code: String
  let message: String
  init(_ code: String, _ message: String) {
    self.code = code
    self.message = message
  }
  var errorDescription: String? { message }
}
