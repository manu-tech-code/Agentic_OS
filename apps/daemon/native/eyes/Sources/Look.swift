import AppKit
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import Vision

/// A screenshot of the window in front (or the whole screen), with the text in it read on this Mac.
enum Look {
  static func capture(scope: String, maxSize: Int, image withImage: Bool, skipTitles: [String]) async -> [String: Any] {
    guard CGPreflightScreenCaptureAccess() else { return ["error": "screen-permission"] }
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
      let frontPid = await MainActor.run { NSWorkspace.shared.frontmostApplication?.processIdentifier }
      var info: [String: Any] = [:]
      let filter: SCContentFilter
      if scope == "screen" {
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else { return ["error": "no-display"] }
        let own = content.windows.filter { Context.novaApps.contains($0.owningApplication?.bundleIdentifier ?? "") }
        filter = SCContentFilter(display: display, excludingWindows: own)
        info["window"] = "the whole screen"
      } else {
        guard let window = frontWindow(content, frontPid: frontPid, skip: Set(skipTitles.map { $0.lowercased() })) else { return ["error": "no-window"] }
        filter = SCContentFilter(desktopIndependentWindow: window)
        info["app"] = window.owningApplication?.applicationName ?? ""
        info["window"] = window.title ?? ""
      }
      let config = SCStreamConfiguration()
      let scale = CGFloat(filter.pointPixelScale)
      config.width = max(1, Int(filter.contentRect.width * scale))
      config.height = max(1, Int(filter.contentRect.height * scale))
      config.showsCursor = false
      let shot = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
      info["text"] = OCR.recognize(shot)
      if withImage, let jpeg = jpegBase64(downscaled(shot, max: maxSize)) {
        info["image"] = jpeg
        info["mimeType"] = "image/jpeg"
      }
      return info
    } catch {
      return ["error": error.localizedDescription]
    }
  }

  /// The window in front: the front app's top window, else the top window of any app - never Nova's own.
  private static func frontWindow(_ content: SCShareableContent, frontPid: pid_t?, skip: Set<String>) -> SCWindow? {
    let order = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    let byId = Dictionary(content.windows.map { ($0.windowID, $0) }, uniquingKeysWith: { a, _ in a })
    let visible = order.compactMap { w -> SCWindow? in
      guard (w[kCGWindowLayer as String] as? Int) == 0, let id = w[kCGWindowNumber as String] as? CGWindowID, let win = byId[id] else { return nil }
      if Context.novaApps.contains(win.owningApplication?.bundleIdentifier ?? "") || skip.contains((win.title ?? "").lowercased()) { return nil }
      return win.frame.width > 40 && win.frame.height > 40 ? win : nil
    }
    return visible.first(where: { $0.owningApplication?.processID == frontPid }) ?? visible.first
  }

  static func downscaled(_ image: CGImage, max side: Int) -> CGImage {
    let longest = Swift.max(image.width, image.height)
    guard longest > side else { return image }
    let k = Double(side) / Double(longest)
    let w = Int(Double(image.width) * k)
    let h = Int(Double(image.height) * k)
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return image }
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage() ?? image
  }

  static func jpegBase64(_ image: CGImage) -> String? {
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
    return CGImageDestinationFinalize(dest) ? (data as Data).base64EncodedString() : nil
  }
}

/// Apple's on-device text recognition, read top to bottom in lines.
enum OCR {
  static func recognize(_ image: CGImage) -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.automaticallyDetectsLanguage = true
    try? VNImageRequestHandler(cgImage: image).perform([request])
    let found = (request.results ?? []).compactMap { o -> (box: CGRect, text: String)? in
      guard let text = o.topCandidates(1).first?.string else { return nil }
      return (o.boundingBox, text)
    }
    // Vision measures from the bottom: sort top to bottom, then left to right, and join pieces on one line.
    let sorted = found.sorted { a, b in abs(a.box.midY - b.box.midY) > Swift.min(a.box.height, b.box.height) / 2 ? a.box.midY > b.box.midY : a.box.minX < b.box.minX }
    var lines: [(y: CGFloat, h: CGFloat, parts: [String])] = []
    for item in sorted {
      if let last = lines.last, abs(last.y - item.box.midY) < Swift.min(last.h, item.box.height) / 2 {
        lines[lines.count - 1].parts.append(item.text)
      } else {
        lines.append((item.box.midY, item.box.height, [item.text]))
      }
    }
    return String(lines.map { $0.parts.joined(separator: "  ") }.joined(separator: "\n").prefix(20_000))
  }

  static func file(_ path: String) -> [String: Any] {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
      return ["error": "can't read \(path)"]
    }
    return ["text": recognize(image)]
  }

  /// A picture of some text, for testing the reading without screen access.
  static func render(_ text: String) -> CGImage {
    let lines = text.components(separatedBy: "\n")
    let w = 1400
    let h = 90 * lines.count + 80
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    for (i, line) in lines.enumerated() {
      let attributed = NSAttributedString(string: line, attributes: [.font: NSFont.systemFont(ofSize: 44), .foregroundColor: NSColor.black])
      ctx.textPosition = CGPoint(x: 40, y: h - 80 - i * 90)
      CTLineDraw(CTLineCreateWithAttributedString(attributed), ctx)
    }
    return ctx.makeImage()!
  }
}
