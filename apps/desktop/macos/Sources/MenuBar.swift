import AppKit

/// Nova in the menu bar: a small orb whose shape says what Nova is doing, and its menu.
final class MenuBar: NSObject, NSMenuDelegate {
  enum Look: Equatable { case idle, listening, thinking, speaking, muted, paused, offline }

  /// Fills the menu each time it opens, so it's always current.
  var fill: (NSMenu) -> Void = { _ in }
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
  private var look: Look = .offline
  private var timer: Timer?
  private let started = Date()

  override init() {
    super.init()
    let menu = NSMenu()
    menu.delegate = self
    menu.autoenablesItems = false
    item.menu = menu
    item.button?.imagePosition = .imageOnly
    draw()
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    fill(menu)
  }

  func show(_ look: Look, tip: String) {
    item.button?.toolTip = tip
    guard look != self.look else { return }
    self.look = look
    timer?.invalidate()
    timer = nil
    if [.listening, .thinking, .speaking].contains(look) {
      timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 12, repeats: true) { [weak self] _ in self?.draw() }
    }
    draw()
  }

  private func draw() {
    let t = Date().timeIntervalSince(started)
    let look = self.look
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
      let c = NSPoint(x: rect.midX, y: rect.midY)
      NSColor.black.set()
      func circle(_ r: CGFloat) -> NSBezierPath { NSBezierPath(ovalIn: NSRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)) }
      switch look {
      case .idle:
        circle(3.2).fill()
        let ring = circle(6.6)
        ring.lineWidth = 1.3
        ring.stroke()
      case .listening:
        circle(3.4).fill()
        let pulse = (sin(t * 4) + 1) / 2
        NSColor.black.withAlphaComponent(0.35 + 0.65 * (1 - pulse)).set()
        let ring = circle(5.6 + 1.6 * pulse)
        ring.lineWidth = 1.5
        ring.stroke()
      case .thinking:
        circle(2.8).fill()
        let arc = NSBezierPath()
        let start = CGFloat(-t * 360).truncatingRemainder(dividingBy: 360)
        arc.appendArc(withCenter: c, radius: 6.4, startAngle: start, endAngle: start + 250)
        arc.lineWidth = 1.6
        arc.lineCapStyle = .round
        arc.stroke()
      case .speaking:
        for (i, phase) in [0.0, 1.3, 2.6].enumerated() {
          let h = 4 + 8 * CGFloat((sin(t * 9 + phase) + 1) / 2)
          let x = c.x - 5 + CGFloat(i) * 4
          NSBezierPath(roundedRect: NSRect(x: x - 1.2, y: c.y - h / 2, width: 2.4, height: h), xRadius: 1.2, yRadius: 1.2).fill()
        }
      case .muted:
        let ring = circle(6.4)
        ring.lineWidth = 1.3
        ring.stroke()
        circle(2.6).fill()
        let slash = NSBezierPath()
        slash.move(to: NSPoint(x: c.x - 6.5, y: c.y + 6.5))
        slash.line(to: NSPoint(x: c.x + 6.5, y: c.y - 6.5))
        slash.lineWidth = 1.6
        slash.lineCapStyle = .round
        slash.stroke()
      case .paused:
        let ring = circle(6.4)
        ring.lineWidth = 1.3
        ring.stroke()
        NSBezierPath(rect: NSRect(x: c.x - 2.6, y: c.y - 2.8, width: 1.8, height: 5.6)).fill()
        NSBezierPath(rect: NSRect(x: c.x + 0.8, y: c.y - 2.8, width: 1.8, height: 5.6)).fill()
      case .offline:
        let ring = circle(6.4)
        ring.lineWidth = 1.3
        ring.setLineDash([2, 2.2], count: 2, phase: 0)
        ring.stroke()
      }
      return true
    }
    image.isTemplate = true // macOS colours it for the menu bar, light or dark
    item.button?.image = image
  }
}
