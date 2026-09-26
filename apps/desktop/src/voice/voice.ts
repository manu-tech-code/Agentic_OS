/**
 * Voice I/O for the prototype, built on browser APIs:
 *   - WebSpeech continuous recognition (the wake word is matched by the daemon)
 *   - Web Audio analyser for the Orb's live level
 *   - speechSynthesis for replies
 * Behind small interfaces so they can be swapped for on-device Whisper +
 * openWakeWord (daemon side) and a neural TTS later.
 */

type SR = any;
const SpeechRecognitionImpl: SR | undefined =
  typeof window !== 'undefined' ? (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition : undefined;

export const voiceSupported = Boolean(SpeechRecognitionImpl);

export interface ListenerEvents {
  onInterim(text: string): void;
  onFinal(text: string): void;
  onError(message: string): void;
}

export class WebSpeechListener {
  private rec: SR | null = null;
  private wanted = false;
  private paused = false;

  constructor(private readonly events: ListenerEvents, private readonly lang = 'en-US') {}

  start() {
    if (!SpeechRecognitionImpl) return this.events.onError('Speech recognition is not available in this webview.');
    this.wanted = true;
    this.spawn();
  }

  stop() {
    this.wanted = false;
    this.rec?.abort();
  }

  /** Stop hearing ourselves while Nova speaks. */
  pause() {
    this.paused = true;
    this.rec?.abort();
  }

  resume() {
    this.paused = false;
    if (this.wanted && !this.rec) this.spawn();
  }

  private spawn() {
    if (this.paused || this.rec) return;
    const rec = new SpeechRecognitionImpl();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.lang;
    rec.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.events.onFinal(r[0].transcript.trim());
        else interim += r[0].transcript;
      }
      this.events.onInterim(interim.trim());
    };
    rec.onerror = (e: any) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') this.events.onError(`Mic: ${e.error}`);
    };
    // Browsers end continuous sessions periodically - always-listening means restart.
    rec.onend = () => {
      this.rec = null;
      if (this.wanted && !this.paused) setTimeout(() => this.spawn(), 250);
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      this.rec = null;
    }
  }
}

/** Microphone RMS level in [0, 1], sampled every animation frame. */
export async function startMicLevel(onLevel: (level: number) => void): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);
  let raf = 0;
  let smooth = 0;
  const tick = () => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    const rms = Math.sqrt(sum / buf.length);
    smooth = smooth * 0.8 + Math.min(1, rms * 4) * 0.2;
    onLevel(smooth);
    raf = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    cancelAnimationFrame(raf);
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };
}

const PREFERRED_VOICES = ['Ava (Premium)', 'Zoe (Premium)', 'Samantha', 'Google UK English Female', 'Microsoft Aria Online (Natural) - English (United States)'];

export function speak(text: string, onEnd: () => void) {
  if (!('speechSynthesis' in window)) return onEnd();
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();
  u.voice = PREFERRED_VOICES.map((n) => voices.find((v) => v.name === n)).find(Boolean) ?? voices.find((v) => v.lang.startsWith('en')) ?? null;
  u.rate = 1.05;
  u.onend = onEnd;
  u.onerror = onEnd;
  window.speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

/** Tiny synthesized earcons - no audio assets needed. */
let earCtx: AudioContext | null = null;
export function earcon(kind: 'wake' | 'done' | 'error') {
  earCtx ??= new AudioContext();
  const ctx = earCtx;
  const notes = { wake: [660, 990], done: [880, 1320], error: [300, 220] }[kind];
  notes.forEach((f, i) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    const t = ctx.currentTime + i * 0.09;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.08, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.25);
  });
}
