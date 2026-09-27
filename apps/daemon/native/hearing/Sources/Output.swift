import Foundation

private let output = DispatchQueue(label: "nova.hearing.output")

/// One event to the daemon, as a line of JSON.
func emit(_ event: [String: Any]) {
  output.async {
    guard var data = try? JSONSerialization.data(withJSONObject: event) else { return }
    data.append(0x0a)
    FileHandle.standardOutput.write(data)
  }
}

/// Detailed logging to stderr, with NOVA_HEARING_DEBUG=1.
let debugging = ProcessInfo.processInfo.environment["NOVA_HEARING_DEBUG"] == "1"
func debug(_ message: @autoclosure () -> String) {
  if debugging { FileHandle.standardError.write(Data((message() + "\n").utf8)) }
}

func flushOutput() {
  output.sync {}
}

struct HelperError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

/// A speech-to-text engine. Audio arrives continuously; the daemon decides when a turn - what
/// the user said before pausing to let Nova answer - is over, and asks for its text.
protocol Engine: AnyObject {
  func audio(_ samples: [Int16])
  /// The daemon's voice-activity detector: speech started or stopped, at this point of the audio.
  func speech(active: Bool, atMs: Int)
  /// Close the current turn here and start the next; the returned work produces its text (a "final" event).
  func finalize(turn: Int) -> () async -> Void
  /// Drop the current turn (it was Nova's own voice, or not worth hearing); the next one starts at `atMs`.
  func cancelTurn(atMs: Int?)
  /// Names worth recognising: apps, agents, projects, the wake words.
  func setVocabulary(_ words: [String]) async
  /// The wake words, so a misheard one ("No, open Slack") can be recovered from the alternatives.
  func setWakeWords(_ words: [String])
}

extension Engine {
  func setWakeWords(_ words: [String]) {}
}

/// Pieces of a transcript joined with single spaces (pieces with no words, like a lone ".", are dropped).
func joinText(_ parts: [String]) -> String {
  parts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { $0.rangeOfCharacter(from: .alphanumerics) != nil }.joined(separator: " ")
}

/// Whether text contains one of these words or phrases, as whole words.
func mentions(_ text: String, any phrases: [String]) -> Bool {
  let words = " " + text.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }.joined(separator: " ") + " "
  return phrases.contains { !$0.isEmpty && words.contains(" \($0) ") }
}
