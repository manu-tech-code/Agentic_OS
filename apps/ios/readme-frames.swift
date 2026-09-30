// Frames of a Simulator recording, cropped and scaled, as PNGs - for the README's animations (npm run readme:phone):
// swift apps/ios/readme-frames.swift <movie> <folder> <from s> <to s> <fps> <x> <y> <width> <height> <scale>
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let a = CommandLine.arguments
guard a.count == 11, let from = Double(a[3]), let to = Double(a[4]), let fps = Double(a[5]), let x = Int(a[6]), let y = Int(a[7]), let w = Int(a[8]),
  let h = Int(a[9]), let scale = Double(a[10])
else { fatalError("swift readme-frames.swift <movie> <folder> <from s> <to s> <fps> <x> <y> <width> <height> <scale>") }
let asset = AVURLAsset(url: URL(fileURLWithPath: a[1]))
let folder = URL(fileURLWithPath: a[2])
let frames = AVAssetImageGenerator(asset: asset)
frames.requestedTimeToleranceBefore = .zero
frames.requestedTimeToleranceAfter = .zero
let (width, height) = (Int(Double(w) * scale), Int(Double(h) * scale))

let done = DispatchSemaphore(value: 0)
Task {
  let length = try await asset.load(.duration).seconds
  var n = 0
  var t = from
  while t <= min(to, length) {
    if let (image, _) = try? await frames.image(at: CMTime(seconds: t, preferredTimescale: 600)), let crop = image.cropping(to: CGRect(x: x, y: y, width: w, height: h)),
      let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    {
      ctx.interpolationQuality = .high
      ctx.draw(crop, in: CGRect(x: 0, y: 0, width: width, height: height))
      let file = CGImageDestinationCreateWithURL(folder.appendingPathComponent(String(format: "%04d.png", n)) as CFURL, UTType.png.identifier as CFString, 1, nil)!
      CGImageDestinationAddImage(file, ctx.makeImage()!, nil)
      CGImageDestinationFinalize(file)
      n += 1
    }
    t += 1 / fps
  }
  print(n)
  done.signal()
}
done.wait()
