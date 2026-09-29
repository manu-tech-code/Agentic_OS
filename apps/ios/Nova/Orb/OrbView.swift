import MetalKit
import SwiftUI

/// Nova's face on the iPhone: the sphere of dots the Mac's window shows, drawn by the GPU. It breathes when
/// idle, ripples with your voice, swirls while a brain thinks and pulses as Nova speaks. Keep it square.
struct OrbView: UIViewRepresentable {
  var phase: String
  /// The microphone while talking, Nova's voice while it speaks: 0-1.
  var level: Float

  func makeCoordinator() -> OrbRenderer { OrbRenderer() }

  func makeUIView(context: Context) -> MTKView {
    let view = MTKView(frame: .zero, device: MTLCreateSystemDefaultDevice())
    view.isOpaque = false
    view.backgroundColor = .clear
    view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
    view.colorPixelFormat = .bgra8Unorm
    view.preferredFramesPerSecond = 60
    view.isUserInteractionEnabled = false
    context.coordinator.attach(to: view)
    return view
  }

  func updateUIView(_ view: MTKView, context: Context) {
    context.coordinator.phase = phase
    context.coordinator.level = level
  }
}

/// How each phase moves: surface flow, turbulence, spin (radians a second), brightness and the thinking tint.
private struct Look {
  var flow: Float, turb: Float, spin: Float, bright: Float, tint: Float

  static func of(_ phase: String) -> Look {
    switch phase {
    case "listening": return Look(flow: 0.14, turb: 0.55, spin: 0.09, bright: 1, tint: 0)
    case "thinking": return Look(flow: 0.4, turb: 0.95, spin: 0.55, bright: 1, tint: 1)
    case "acting": return Look(flow: 0.28, turb: 0.75, spin: 0.3, bright: 1.05, tint: 0)
    case "speaking": return Look(flow: 0.2, turb: 0.65, spin: 0.12, bright: 1.15, tint: 0)
    default: return Look(flow: 0.08, turb: 0.35, spin: 0.05, bright: 0.85, tint: 0)
    }
  }
}

private struct Particle {
  var x, y, z, s0, s1, shell: Float
}

private struct Uniforms {
  var time: Float = 0, flow: Float = 0, energy: Float = 0, pulse: Float = 0, turb: Float = 0, spin: Float = 0
  var scale: Float = 0.57, point: Float = 2, bright: Float = 1, unused: Float = 0
  var top = SIMD3<Float>(0, 0, 0), mid = SIMD3<Float>(0, 0, 0), low = SIMD3<Float>(0, 0, 0)
}

final class OrbRenderer: NSObject, MTKViewDelegate {
  var phase = "idle"
  var level: Float = 0

  /// Nova's colours, top to bottom (the window's "nova" palette), and the pink thinking leans toward.
  private static let palette: [SIMD3<Float>] = [rgb(0x5cd6ff), rgb(0x6b63ff), rgb(0xc65cff)]
  private static let thinkingTint = SIMD3<Float>(1, 0.36, 0.84)

  private var queue: MTLCommandQueue?
  private var pipeline: MTLRenderPipelineState?
  private var dots: MTLBuffer?
  private var count = 0

  private var look = Look.of("idle")
  private var colors = OrbRenderer.palette
  private var energy: Float = 0
  private var spin: Float = 0
  private var flow: Float = 0
  private var time: Float = 0
  private var pulse: Float = 0
  private var lastLevel: Float = 0
  private var last = CACurrentMediaTime()

  private static func rgb(_ hex: Int) -> SIMD3<Float> {
    SIMD3(Float((hex >> 16) & 0xff) / 255, Float((hex >> 8) & 0xff) / 255, Float(hex & 0xff) / 255)
  }

  func attach(to view: MTKView) {
    guard let device = view.device, let library = device.makeDefaultLibrary() else { return }
    let described = MTLRenderPipelineDescriptor()
    described.vertexFunction = library.makeFunction(name: "orbVertex")
    described.fragmentFunction = library.makeFunction(name: "orbFragment")
    let color = described.colorAttachments[0]!
    color.pixelFormat = view.colorPixelFormat
    color.isBlendingEnabled = true
    color.rgbBlendOperation = .add
    color.alphaBlendOperation = .add
    color.sourceRGBBlendFactor = .one
    color.destinationRGBBlendFactor = .one
    color.sourceAlphaBlendFactor = .one
    color.destinationAlphaBlendFactor = .one
    pipeline = try? device.makeRenderPipelineState(descriptor: described)
    queue = device.makeCommandQueue()
    let particles = Self.particles(surface: 11_000, dust: 3_000)
    count = particles.count
    dots = particles.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count) }
    view.delegate = self
  }

  /// Evenly spread dots on a sphere, plus loose dust around it - seeded as the window's are, so it's the same sphere.
  private static func particles(surface: Int, dust: Int) -> [Particle] {
    var s: UInt32 = 0x9e37_79b9
    func random() -> Float {
      s = s &+ 0x6d2b_79f5
      var t = (s ^ (s >> 15)) &* (1 | s)
      t = (t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t
      return Float(t ^ (t >> 14)) / 4_294_967_296
    }
    let golden = Float.pi * (3 - 5.0.squareRoot().float)
    var out: [Particle] = []
    out.reserveCapacity(surface + dust)
    for i in 0..<(surface + dust) {
      var x: Float, y: Float, z: Float, shell: Float = 0
      if i < surface {
        y = 1 - (2 * (Float(i) + 0.5)) / Float(surface)
        let r = (1 - y * y).squareRoot()
        x = cos(Float(i) * golden) * r
        z = sin(Float(i) * golden) * r
      } else {
        y = random() * 2 - 1
        let r = (1 - y * y).squareRoot()
        let a = random() * .pi * 2
        x = cos(a) * r
        z = sin(a) * r
        shell = 1
      }
      out.append(Particle(x: x, y: y, z: z, s0: random(), s1: random(), shell: shell))
    }
    return out
  }

  func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

  func draw(in view: MTKView) {
    let now = CACurrentMediaTime()
    let dt = Float(min(0.05, now - last))
    last = now
    let t = Float(now.truncatingRemainder(dividingBy: 10_000))

    // How active the sphere should be now: the voice while listening or speaking, a slow swell otherwise.
    if level - lastLevel > 0.1 { pulse = min(1, pulse + 0.5) } // a syllable starting
    lastLevel = level
    let target: Float
    switch phase {
    case "listening": target = 0.08 + min(1, level * 1.8)
    case "speaking":
      if level > 0.01 {
        target = 0.18 + min(1, level * 1.4) * 0.75 + 0.4 * pulse
      } else {
        let syllables = max(0, sin(t * 27 + 1.7 * sin(t * 2.1)))
        target = 0.3 + 0.4 * syllables * (0.65 + 0.35 * sin(t * 2.2)) + 0.55 * pulse
      }
    case "thinking": target = 0.28 + 0.08 * sin(t * 3.1)
    case "acting": target = 0.4
    default: target = 0.05 + 0.03 * sin(t * 0.8)
    }
    pulse *= exp(-dt * 7)
    energy += (target - energy) * (1 - exp(-dt * (target > energy ? 14 : 4)))

    // Ease the look and the colours toward the phase, so changes melt rather than jump.
    let ease = 1 - exp(-dt * 3)
    let want = Look.of(phase)
    look.flow += (want.flow - look.flow) * ease
    look.turb += (want.turb - look.turb) * ease
    look.spin += (want.spin - look.spin) * ease
    look.bright += (want.bright - look.bright) * ease
    look.tint += (want.tint - look.tint) * ease
    for i in 0..<3 {
      let goal = Self.palette[i] + (Self.thinkingTint - Self.palette[i]) * (look.tint * 0.35)
      colors[i] += (goal - colors[i]) * ease
    }
    time += dt
    flow += dt * look.flow
    spin += dt * look.spin * (1 + energy * 0.5)

    guard let pipeline, let queue, let dots, let pass = view.currentRenderPassDescriptor, let drawable = view.currentDrawable,
      let commands = queue.makeCommandBuffer(), let encoder = commands.makeRenderCommandEncoder(descriptor: pass)
    else { return }
    var u = Uniforms()
    u.time = time
    u.flow = flow
    u.energy = energy
    u.pulse = pulse
    u.turb = look.turb
    u.spin = spin
    u.point = max(1.4, Float(view.drawableSize.width) / 420 * 1.9)
    u.bright = look.bright
    u.top = colors[0]
    u.mid = colors[1]
    u.low = colors[2]
    encoder.setRenderPipelineState(pipeline)
    encoder.setVertexBuffer(dots, offset: 0, index: 0)
    encoder.setVertexBytes(&u, length: MemoryLayout<Uniforms>.stride, index: 1)
    encoder.drawPrimitives(type: .point, vertexStart: 0, vertexCount: count)
    encoder.endEncoding()
    commands.present(drawable)
    commands.commit()
  }
}

private extension Double {
  var float: Float { Float(self) }
}
