import Foundation
import PDFKit

/// Files, for Nova's hands: into the Trash (never deleted for good) and back out, and the text in a PDF.
/// Only inside the user's home folder; the daemon decides which file, and checks it too.
enum FileOps {
  static let home = URL(fileURLWithPath: NSHomeDirectory()).standardizedFileURL.path

  /// Inside the home folder, and not one of its hidden folders.
  static func allowed(_ path: String) -> Bool {
    let full = URL(fileURLWithPath: path).standardizedFileURL.path
    guard full.hasPrefix(home + "/") else { return false }
    return !full.dropFirst(home.count + 1).split(separator: "/").contains { $0.hasPrefix(".") }
  }

  static func trash(_ path: String) -> [String: Any] {
    guard allowed(path) else { return ["error": "not-allowed"] }
    guard FileManager.default.fileExists(atPath: path) else { return ["error": "missing"] }
    do {
      var result: NSURL?
      try FileManager.default.trashItem(at: URL(fileURLWithPath: path), resultingItemURL: &result)
      return ["trashed": (result as URL?)?.path ?? ""]
    } catch {
      return ["error": error.localizedDescription]
    }
  }

  /// Put a file back from the Trash where it was - never over another file.
  static func untrash(_ trashed: String, to original: String) -> [String: Any] {
    let trash = URL(fileURLWithPath: home).appendingPathComponent(".Trash").path
    let from = URL(fileURLWithPath: trashed).standardizedFileURL.path
    guard from.hasPrefix(trash + "/"), allowed(original) else { return ["error": "not-allowed"] }
    guard FileManager.default.fileExists(atPath: from) else { return ["error": "missing"] }
    guard !FileManager.default.fileExists(atPath: original) else { return ["error": "exists"] }
    do {
      try FileManager.default.createDirectory(at: URL(fileURLWithPath: original).deletingLastPathComponent(), withIntermediateDirectories: true)
      try FileManager.default.moveItem(atPath: from, toPath: original)
      return ["ok": true]
    } catch {
      return ["error": error.localizedDescription]
    }
  }

  /// The text of a PDF, page by page, cut to `max` characters.
  static func pdfText(_ path: String, max: Int) -> [String: Any] {
    guard allowed(path) else { return ["error": "not-allowed"] }
    guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else { return ["error": "unreadable"] }
    if doc.isLocked { return ["error": "locked"] }
    var text = ""
    for i in 0..<doc.pageCount {
      guard let page = doc.page(at: i)?.string else { continue }
      text += page + "\n\n"
      if text.count >= max { break }
    }
    return ["text": String(text.prefix(max)), "pages": doc.pageCount]
  }
}
