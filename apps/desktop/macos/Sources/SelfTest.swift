import AVFoundation
import Carbon.HIToolbox

/// `Nova --selftest`: the parts that need no microphone, speaker or daemon.
enum SelfTest {
  static func run() -> Bool {
    var passed = true
    func check(_ name: String, _ ok: Bool) {
      print(ok ? "ok    \(name)" : "FAIL  \(name)")
      passed = passed && ok
    }

    // Shortcuts, as the settings file keeps them.
    let space = Shortcut("option+space")
    check("option+space is ⌥Space", space?.keyCode == UInt32(kVK_Space) && space?.modifiers == UInt32(optionKey) && space?.display == "⌥Space")
    check("cmd+shift+k is ⇧⌘K", Shortcut("cmd+shift+k")?.display == "⇧⌘K")
    check("control+option+f5", Shortcut("control+option+f5")?.keyCode == UInt32(kVK_F5))
    check("unknown ones refused", Shortcut("hyper+space") == nil && Shortcut("option+") == nil && Shortcut("option+option+a") == nil)

    // The microphone: five 20 ms blocks at 48 kHz become 1600 samples at 16 kHz, just as loud.
    let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 1, interleaved: false)!
    let send = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
    let converter = AVAudioConverter(from: mono, to: send)!
    var samples = 0
    var peak = 0
    for block in 0..<5 {
      let buffer = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: 960)!
      buffer.frameLength = 960
      for i in 0..<960 { buffer.floatChannelData![0][i] = 0.5 * Float(sin(2 * Double.pi * 440 * Double(block * 960 + i) / 48_000)) }
      guard let data = Voice.convert(buffer, with: converter) else { continue }
      samples += data.count / 2
      data.withUnsafeBytes { raw in
        for j in 0..<(data.count / 2) { peak = max(peak, abs(Int(raw.loadUnaligned(fromByteOffset: j * 2, as: Int16.self)))) }
      }
    }
    check("48 kHz becomes 16 kHz (\(samples) samples)", abs(samples - 1600) <= 64)
    check("as loud (peak \(peak))", peak > 12_000 && peak < 20_000)

    // Nova's voice: 16-bit PCM from the daemon, ready to play.
    var pcm = Data()
    for i in 0..<2400 {
      let v = Int16(10_000 * sin(Double(i) / 5))
      pcm.append(UInt8(truncatingIfNeeded: v))
      pcm.append(UInt8(truncatingIfNeeded: v >> 8))
    }
    let decoded = Voice.decode(pcm, rate: 24_000)
    let expected = Float(Int16(10_000 * sin(1.0))) / 32768
    check("reply audio decoded", decoded?.frameLength == 2400 && abs((decoded?.floatChannelData?[0][5] ?? 0) - expected) < 0.0001)
    check("the chime", (Voice.chimeBuffer(format: AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!)?.frameLength ?? 0) > 4000)

    print(passed ? "selftest passed" : "selftest FAILED")
    return passed
  }
}
