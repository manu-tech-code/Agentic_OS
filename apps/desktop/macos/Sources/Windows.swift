import AppKit
import WebKit

/// The floating orb: a small frosted panel over everything - full-screen apps too - that never
/// takes focus, so the app you're in stays in front (and Nova still knows what you're working in).
/// The page decides what it shows and says how big it is; the panel keeps to the chosen corner of
/// the screen your pointer was on when it appeared. It stays out of screenshots and screen shares.
final class HudPanel: NSPanel {
  var corner = "bottom-right"
  private let glass = NSVisualEffectView()
  private var mode = "hidden"
  private var screenShown: NSScreen?

  init(web: WKWebView) {
    super.init(contentRect: NSRect(x: 0, y: 0, width: 64, height: 64), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    isFloatingPanel = true
    level = .statusBar
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    backgroundColor = .clear
    isOpaque = false
    hasShadow = true
    hidesOnDeactivate = false
    isReleasedWhenClosed = false
    sharingType = .none
    glass.material = .hudWindow
    glass.blendingMode = .behindWindow
    glass.state = .active
    glass.maskImage = HudPanel.mask(radius: 32)
    contentView = glass
    web.frame = glass.bounds
    web.autoresizingMask = [.width, .height]
    glass.addSubview(web)
  }

  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }

  /// What the page shows: nothing, the orb alone, or the orb with words - and its size.
  func show(_ mode: String, width: CGFloat, height: CGFloat) {
    if mode != self.mode { novaLog.notice("orb: \(mode, privacy: .public) \(Int(width))×\(Int(height))") }
    self.mode = mode
    guard mode != "hidden" else { return disappear() }
    let size = NSSize(width: max(40, width), height: max(40, height))
    glass.maskImage = HudPanel.mask(radius: mode == "orb" ? size.height / 2 : 20)
    if !isVisible {
      screenShown = HudPanel.screenUnderPointer()
      setFrame(place(size), display: true)
      alphaValue = 0
      orderFrontRegardless()
      NSAnimationContext.runAnimationGroup { $0.duration = 0.16; animator().alphaValue = 1 }
    } else {
      alphaValue = 1
      NSAnimationContext.runAnimationGroup { context in
        context.duration = 0.18
        context.allowsImplicitAnimation = true
        animator().setFrame(place(size), display: true)
      }
    }
    invalidateShadow()
  }

  private func disappear() {
    guard isVisible else { return }
    NSAnimationContext.runAnimationGroup({ $0.duration = 0.22; animator().alphaValue = 0 }) { [weak self] in
      guard let self, self.mode == "hidden" else { return }
      self.orderOut(nil)
      self.screenShown = nil
    }
  }

  /// Its frame: the chosen corner of its screen, clear of the menu bar and the Dock.
  private func place(_ size: NSSize) -> NSRect {
    let screen = screenShown ?? NSScreen.main ?? NSScreen.screens[0]
    let area = screen.visibleFrame.insetBy(dx: 14, dy: 14)
    let x = corner.hasSuffix("left") ? area.minX : area.maxX - size.width
    let y = corner.hasPrefix("top") ? area.maxY - size.height : area.minY
    return NSRect(x: x.rounded(), y: y.rounded(), width: size.width, height: size.height)
  }

  private static func screenUnderPointer() -> NSScreen? {
    let mouse = NSEvent.mouseLocation
    return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
  }

  /// A rounded shape that stretches: the frosted glass takes the page's shape.
  private static func mask(radius: CGFloat) -> NSImage {
    let edge = radius * 2 + 1
    let image = NSImage(size: NSSize(width: edge, height: edge), flipped: false) { rect in
      NSColor.black.setFill()
      NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
      return true
    }
    image.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
    image.resizingMode = .stretch
    return image
  }
}

/// The full window: Nova's glass UI, with the Mac's window buttons over its top-left corner.
final class MainWindow: NSWindow {
  init(web: WKWebView, title: String) {
    super.init(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
               backing: .buffered, defer: false)
    self.title = title
    titleVisibility = .hidden
    titlebarAppearsTransparent = true
    isReleasedWhenClosed = false
    minSize = NSSize(width: 900, height: 600)
    backgroundColor = NSColor(calibratedRed: 0.035, green: 0.04, blue: 0.08, alpha: 1)
    let content = NSView()
    contentView = content
    web.frame = content.bounds
    web.autoresizingMask = [.width, .height]
    content.addSubview(web)
    // The page's top bar moves the window, like a title bar.
    let strip = DragStrip(frame: NSRect(x: 0, y: content.bounds.height - 40, width: content.bounds.width, height: 40))
    strip.autoresizingMask = [.width, .minYMargin]
    content.addSubview(strip)
    setFrameAutosaveName("NovaWindow")
    if !setFrameUsingName("NovaWindow") { center() }
  }
}

private final class DragStrip: NSView {
  override var mouseDownCanMoveWindow: Bool { true }

  override func mouseDown(with event: NSEvent) {
    if event.clickCount == 2 { window?.performZoom(nil) } else { window?.performDrag(with: event) }
  }
}
