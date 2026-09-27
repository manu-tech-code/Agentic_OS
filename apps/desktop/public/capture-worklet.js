/**
 * Nova's microphone for hearing on the Mac: the input, low-passed and resampled to 16 kHz mono
 * 16-bit PCM, posted in 20 ms frames. Runs on the audio thread (an AudioWorklet), so capture never
 * stutters when the page is busy.
 */
class NovaCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000; // `sampleRate` is the context's rate, a global here
    this.t = 1; // input-sample time of the next output sample
    this.n = 0; // input samples read
    this.prev = 0;
    this.frame = new Int16Array(320);
    this.filled = 0;
    // Two Butterworth low-pass stages at 7.2 kHz, so nothing above 8 kHz folds back into speech.
    const w = (2 * Math.PI * 7200) / sampleRate;
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    this.k = { b0: (1 - Math.cos(w)) / 2 / a0, b1: (1 - Math.cos(w)) / a0, b2: (1 - Math.cos(w)) / 2 / a0, a1: (-2 * Math.cos(w)) / a0, a2: (1 - alpha) / a0 };
    this.stages = [{ x1: 0, x2: 0, y1: 0, y2: 0 }, { x1: 0, x2: 0, y1: 0, y2: 0 }];
  }

  lowpass(x) {
    const k = this.k;
    for (const s of this.stages) {
      const y = k.b0 * x + k.b1 * s.x1 + k.b2 * s.x2 - k.a1 * s.y1 - k.a2 * s.y2;
      s.x2 = s.x1;
      s.x1 = x;
      s.y2 = s.y1;
      s.y1 = y;
      x = y;
    }
    return x;
  }

  push(v) {
    const clipped = Math.max(-1, Math.min(1, v));
    this.frame[this.filled++] = clipped < 0 ? clipped * 32768 : clipped * 32767;
    if (this.filled === this.frame.length) {
      this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
      this.frame = new Int16Array(320);
      this.filled = 0;
    }
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const x = this.lowpass(channel[i]);
      this.n++;
      while (this.t <= this.n) {
        this.push(this.prev + (x - this.prev) * (this.t - (this.n - 1)));
        this.t += this.ratio;
      }
      this.prev = x;
    }
    return true;
  }
}

registerProcessor('nova-capture', NovaCapture);
