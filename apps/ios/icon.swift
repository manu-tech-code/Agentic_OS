// Nova's iPhone icon: the Orb - the sphere of Nova.app's icon - drawn full-bleed at 1024 px (iOS rounds the corners
// itself), and in grey for the Home Screen's tinted look. From the repo: swift apps/ios/icon.swift
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Nova/Assets.xcassets/AppIcon.appiconset")

/// A colour from its hex, or - for the tinted icon - its brightness as grey.
func paint(_ hex: UInt32, _ alpha: CGFloat = 1, grey: Bool) -> CGColor {
  let r = CGFloat((hex >> 16) & 0xFF) / 255, g = CGFloat((hex >> 8) & 0xFF) / 255, b = CGFloat(hex & 0xFF) / 255
  if grey {
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return CGColor(srgbRed: y, green: y, blue: y, alpha: alpha)
  }
  return CGColor(srgbRed: r, green: g, blue: b, alpha: alpha)
}

func gradient(_ stops: [(CGFloat, CGColor)]) -> CGGradient {
  CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: stops.map(\.1) as CFArray, locations: stops.map(\.0))!
}

func icon(grey: Bool) -> CGImage {
  let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!  // no transparency: an app icon has none
  ctx.translateBy(x: 0, y: CGFloat(size))
  ctx.scaleBy(x: 1, y: -1)  // top-left origin, as the eye reads it
  let c = CGPoint(x: 512, y: 530), r: CGFloat = 318

  // The night behind it: deep indigo, a touch lighter behind the Orb (black for the tinted icon, which iOS colours).
  if grey {
    ctx.setFillColor(CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))
  } else {
    ctx.drawRadialGradient(gradient([(0, paint(0x1D1B4C, grey: grey)), (1, paint(0x0B0A1C, grey: grey))]),
      startCenter: CGPoint(x: 512, y: 500), startRadius: 0, endCenter: CGPoint(x: 512, y: 500), endRadius: 760, options: .drawsAfterEndLocation)
  }

  // Its glow.
  ctx.drawRadialGradient(gradient([(0, paint(0x5C7BFF, 0.42, grey: grey)), (0.35, paint(0x5C7BFF, 0.16, grey: grey)), (1, paint(0x5C7BFF, 0, grey: grey))]),
    startCenter: c, startRadius: r * 0.95, endCenter: c, endRadius: r * 1.45, options: [])

  // The sphere, lit from the top left.
  ctx.saveGState()
  ctx.addEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
  ctx.clip()
  let body = gradient([
    (0.00, paint(0xF4F9FF, grey: grey)), (0.10, paint(0xC4E6FF, grey: grey)), (0.28, paint(0x86C6FF, grey: grey)),
    (0.50, paint(0x7A86FF, grey: grey)), (0.72, paint(0x6A4FF0, grey: grey)), (0.90, paint(0x3E2A9E, grey: grey)), (1.00, paint(0x251A63, grey: grey)),
  ])
  ctx.drawRadialGradient(body, startCenter: CGPoint(x: c.x - 0.34 * r, y: c.y - 0.36 * r), startRadius: 0,
    endCenter: CGPoint(x: c.x + 0.12 * r, y: c.y + 0.14 * r), endRadius: r * 1.18, options: .drawsAfterEndLocation)
  // Its edge, a little darker, so it reads as round.
  ctx.drawRadialGradient(gradient([(0, paint(0x140A3C, 0, grey: grey)), (1, paint(0x140A3C, 0.25, grey: grey))]),
    startCenter: c, startRadius: r * 0.72, endCenter: c, endRadius: r, options: [])
  // Light thrown back from below.
  let bounce = CGPoint(x: c.x - 0.28 * r, y: c.y + 0.62 * r)
  ctx.drawRadialGradient(gradient([(0, paint(0x8FD8FF, 0.28, grey: grey)), (1, paint(0x8FD8FF, 0, grey: grey))]),
    startCenter: bounce, startRadius: 0, endCenter: bounce, endRadius: r * 0.5, options: [])
  // The shine.
  ctx.translateBy(x: c.x - 0.28 * r, y: c.y - 0.42 * r)
  ctx.rotate(by: -0.28)
  ctx.scaleBy(x: 1, y: 0.52)
  ctx.drawRadialGradient(gradient([(0, paint(0xFFFFFF, 0.92, grey: grey)), (0.55, paint(0xFFFFFF, 0.45, grey: grey)), (1, paint(0xFFFFFF, 0, grey: grey))]),
    startCenter: .zero, startRadius: 0, endCenter: .zero, endRadius: r * 0.4, options: [])
  ctx.restoreGState()
  return ctx.makeImage()!
}

func save(_ image: CGImage, _ name: String) {
  let url = folder.appendingPathComponent(name)
  let file = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(file, image, nil)
  guard CGImageDestinationFinalize(file) else { fatalError("couldn't write \(url.path)") }
  print("wrote \(url.path)")
}

try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
save(icon(grey: false), "AppIcon.png")
save(icon(grey: true), "AppIcon-tinted.png")
