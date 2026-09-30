import Accelerate
import AVFoundation

/// Nova's voice as the Dynamic Island's bars show it: how loud each part of its spectrum is right now, low to high
/// pitch, 0-1 - so the bars move with what Nova says, as music's do. Used on the tap's thread only.
final class Spectrum {
  static let bands = 5
  private static let log2n: vDSP_Length = 10
  private static let size = 1 << 10
  /// Where each band starts, and the last one ends, in Hz: a voice's pitch, its vowels, its s-sounds.
  private static let edges: [Double] = [80, 250, 600, 1400, 3000, 7000]
  /// A voice carries less the higher it goes: each band is lifted this much (dB), so they all move.
  private static let lift: [Float] = [0, 3, 8, 13, 18]
  /// The loudest band lately shows full; this far below it (dB) shows nothing.
  private static let range: Float = 30

  private let setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2))
  private let window = vDSP.window(ofType: Float.self, usingSequence: .hanningDenormalized, count: size, isHalfWindow: false)
  /// The loudest a band has been lately (dB, lifted): the bars' full height. It sinks slowly, so a quieter reply fills them too.
  private var top: Float = -200

  deinit {
    if let setup { vDSP_destroy_fftsetup(setup) }
  }

  func levels(_ buffer: AVAudioPCMBuffer) -> [Float] {
    let quiet = [Float](repeating: 0, count: Self.bands)
    let frames = Int(buffer.frameLength)
    guard let setup, let samples = buffer.floatChannelData?[0], frames > 0, Voice.rms(buffer) > 0.003 else { return quiet } // a pause: the bars rest
    let binHz = buffer.format.sampleRate / Double(Self.size)
    let half = Self.size / 2
    var power = [Float](repeating: 0, count: Self.bands)
    var chunk = [Float](repeating: 0, count: Self.size)
    var real = [Float](repeating: 0, count: half)
    var imag = [Float](repeating: 0, count: half)
    var bins = [Float](repeating: 0, count: half)
    var start = 0
    var windows: Float = 0
    repeat {
      // The buffer, a window at a time (the last one padded with silence).
      let count = min(Self.size, frames - start)
      for i in 0..<Self.size { chunk[i] = i < count ? samples[start + i] * window[i] : 0 }
      real.withUnsafeMutableBufferPointer { re in
        imag.withUnsafeMutableBufferPointer { im in
          var split = DSPSplitComplex(realp: re.baseAddress!, imagp: im.baseAddress!)
          chunk.withUnsafeBufferPointer { floats in
            floats.withMemoryRebound(to: DSPComplex.self) { vDSP_ctoz($0.baseAddress!, 2, &split, 1, vDSP_Length(half)) }
          }
          vDSP_fft_zrip(setup, &split, 1, Self.log2n, FFTDirection(kFFTDirection_Forward))
          vDSP_zvmags(&split, 1, &bins, 1, vDSP_Length(half))
        }
      }
      for band in 0..<Self.bands {
        let low = max(1, Int((Self.edges[band] / binHz).rounded(.up)))
        let high = min(half - 1, Int(Self.edges[band + 1] / binHz))
        guard high >= low else { continue }
        power[band] += bins[low...high].reduce(0, +) / Float(high - low + 1)
      }
      start += Self.size
      windows += 1
    } while start < frames
    let loudness = power.enumerated().map { 10 * log10($0.element / windows + 1e-20) + Self.lift[$0.offset] }
    top = max(loudness.max() ?? top, top - 0.2)
    return loudness.map { min(1, max(0, ($0 - top + Self.range) / Self.range)) }
  }
}
