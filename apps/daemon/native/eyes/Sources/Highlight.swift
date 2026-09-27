import AppKit

/// While Nova asks "Allow it?", a frame around what's about to be clicked or typed in, with a caption -
/// above everything, never taking a click or the focus, and kept out of screenshots and screen sharing.
@MainActor enum Highlight {
  private static var panel: NSPanel?
  private static var hideTimer: Timer?
  nonisolated static let padding: CGFloat = 6
  nonisolated static let captionHeight: CGFloat = 28

  /// Where the frame and caption go (in global top-left points): the caption below the target when there's room, else above.
  nonisolated static func layout(target: CGRect, screen: CGRect) -> (panel: CGRect, captionBelow: Bool) {
    let framed = target.insetBy(dx: -padding, dy: -padding)
    let below = framed.maxY + captionHeight + 4 <= screen.maxY
    var panel = framed
    panel.size.height += captionHeight + 4
    if !below { panel.origin.y -= captionHeight + 4 }
    // Wide enough for the caption, and on screen.
    panel.size.width = max(panel.width, 220)
    panel.origin.x = min(max(panel.minX, screen.minX), max(screen.minX, screen.maxX - panel.width))
    panel.origin.y = min(max(panel.minY, screen.minY), max(screen.minY, screen.maxY - panel.height))
    return (panel, below)
  }

  static func show(_ request: [String: Any]) -> [String: Any] {
    let snapshot = SnapshotStore.shared.get(request["snapshot"] as? String)
    var target: CGRect
    if let id = request["element"] as? String, !id.isEmpty {
      guard let snapshot, let thing = snapshot.things[id] else { return ["error": "stale"] }
      target = AX.liveFrame(thing.element) ?? thing.frame
    } else if let x = (request["x"] as? NSNumber)?.doubleValue, let y = (request["y"] as? NSNumber)?.doubleValue {
      guard let snapshot else { return ["error": "stale"] }
      let p = snapshot.frame.toScreen(CGPoint(x: x, y: y))
      target = CGRect(x: p.x - 14, y: p.y - 14, width: 28, height: 28)
    } else {
      return ["error": "no-target"]
    }
    let caption = Labels.clean(request["label"] as? String, max: 70)
    guard let primary = NSScreen.screens.first else { return ["error": "no-display"] }
    let screen = NSScreen.screens.first { $0.frame.contains(cocoa(CGPoint(x: target.midX, y: target.midY), primary: primary)) } ?? primary
    let screenTopLeft = CGRect(x: screen.frame.minX, y: primary.frame.maxY - screen.frame.maxY, width: screen.frame.width, height: screen.frame.height)
    let (frame, below) = layout(target: target, screen: screenTopLeft)

    let panel = self.panel ?? make()
    self.panel = panel
    let cocoaFrame = NSRect(x: frame.minX, y: primary.frame.maxY - frame.maxY, width: frame.width, height: frame.height)
    panel.setFrame(cocoaFrame, display: false)
    let view = HighlightView(frame: NSRect(origin: .zero, size: cocoaFrame.size))
    // The target inside the panel, in the view's (bottom-left) coordinates.
    let inner = target.insetBy(dx: -padding, dy: -padding)
    view.box = NSRect(x: inner.minX - frame.minX, y: frame.maxY - inner.maxY, width: inner.width, height: inner.height)
    view.caption = caption
    view.captionBelow = below
    panel.contentView = view
    panel.orderFrontRegardless()
    hideTimer?.invalidate()
    hideTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { _ in MainActor.assumeIsolated { hide() } }
    return ["ok": true]
  }

  static func hide() {
    hideTimer?.invalidate()
    hideTimer = nil
    panel?.orderOut(nil)
  }

  private static func cocoa(_ p: CGPoint, primary: NSScreen) -> NSPoint { NSPoint(x: p.x, y: primary.frame.maxY - p.y) }

  private static func make() -> NSPanel {
    let panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.ignoresMouseEvents = true
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.level = .screenSaver
    panel.sharingType = .none
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle, .transient]
    return panel
  }
}

/// The frame and its caption.
final class HighlightView: NSView {
  var box = NSRect.zero
  var caption = ""
  var captionBelow = true

  override func draw(_ dirtyRect: NSRect) {
    let accent = NSColor.controlAccentColor
    let path = NSBezierPath(roundedRect: box.insetBy(dx: 1.5, dy: 1.5), xRadius: 8, yRadius: 8)
    accent.withAlphaComponent(0.1).setFill()
    path.fill()
    accent.setStroke()
    path.lineWidth = 3
    path.stroke()
    guard !caption.isEmpty else { return }
    let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 13, weight: .semibold), .foregroundColor: NSColor.white]
    let text = NSAttributedString(string: caption, attributes: attributes)
    let size = text.size()
    let width = min(size.width + 22, bounds.width)
    let height = Highlight.captionHeight - 4
    let y = captionBelow ? box.minY - height - 4 : box.maxY + 4
    let pill = NSRect(x: max(0, min(box.minX, bounds.width - width)), y: max(0, y), width: width, height: height)
    NSColor.black.withAlphaComponent(0.78).setFill()
    NSBezierPath(roundedRect: pill, xRadius: height / 2, yRadius: height / 2).fill()
    text.draw(in: NSRect(x: pill.minX + 11, y: pill.minY + (height - size.height) / 2, width: pill.width - 22, height: size.height))
  }
}
