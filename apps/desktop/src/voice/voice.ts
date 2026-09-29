/**
 * Voice I/O for the prototype, built on standard browser APIs so it works in
 * Safari, Chrome and Edge alike (feature-detected, never browser-sniffed):
 *   - SpeechRecognition / webkitSpeechRecognition, restarted to stay always-listening
 *     (the wake word is matched by the daemon)
 *   - Web Audio analyser for the Orb's live level
 *   - Kokoro's voice for replies, streamed from the daemon and played through Web Audio
 * Browsers only allow sound (and some allow listening) after one click or key
 * press per page load, so the shell calls unlockAudio() on the first one.
 * With on-device hearing (Settings → Hearing), the microphone streams to the daemon instead
 * (startCapture) and the daemon's recognizer turns it into text.
 */
export { soundsUnfinished, UtteranceAssembler } from '@nova/core/speech';

type SR = any;
const SpeechRecognitionImpl: SR | undefined =
  typeof window !== 'undefined' ? (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition : undefined;

export const voiceSupported = Boolean(SpeechRecognitionImpl);

export const NO_SPEECH_TEXT = "This browser can't turn speech into text. Open Nova in Safari, Chrome or Edge, or press ⌘K to type.";

export const MIC_HELP =
  'The microphone is blocked for this page. Allow it (Safari: Settings → Websites → Microphone → localhost → Allow; ' +
  'Chrome or Edge: the icon at the left of the address bar), then click anywhere.';

/** Recognition errors that restarting won't fix. */
const BLOCKING = new Set(['not-allowed', 'service-not-allowed', 'audio-capture']);

function speechErrorText(code: string): string {
  switch (code) {
    case 'not-allowed':
      return MIC_HELP;
    case 'service-not-allowed':
      return 'Speech recognition is turned off. On a Mac, Safari needs Dictation on (System Settings → Keyboard → Dictation); then click anywhere.';
    case 'audio-capture':
      return 'No microphone was found. Check your input device, then click anywhere.';
    case 'network':
      return "Speech recognition couldn't reach its service. This browser needs an internet connection for it.";
    default:
      return `Speech recognition error: ${code}`;
  }
}

export interface ListenerEvents {
  onInterim(text: string): void;
  onFinal(text: string): void;
  onError(message: string): void;
}

export class WebSpeechListener {
  private rec: SR | null = null;
  private wanted = false;
  private paused = false;

  constructor(private readonly events: ListenerEvents, private lang = 'en-US') {}

  /** True while it should be listening - false after stop() or an error restarting can't fix. */
  get active() {
    return this.wanted;
  }

  /** Listen for another language; the running session restarts with it. */
  setLang(lang: string) {
    if (lang === this.lang) return;
    this.lang = lang;
    this.rec?.abort(); // onend spawns a fresh session with the new language
  }

  start() {
    if (!SpeechRecognitionImpl) return this.events.onError(NO_SPEECH_TEXT);
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
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (BLOCKING.has(e.error)) this.wanted = false; // restarting would only fail again
      this.events.onError(speechErrorText(e.error));
    };
    // Browsers end recognition sessions periodically (Safari after each phrase) - always-listening means restart.
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

const contexts = new Set<AudioContext>();
function audioContext() {
  const ctx = new AudioContext();
  contexts.add(ctx);
  return ctx;
}

/**
 * Call from a click or key handler: browsers only allow sound after one interaction per page load,
 * and an audio context only starts inside one. So the natural voice's output is created here.
 */
export function unlockAudio() {
  output();
  for (const ctx of contexts) if (ctx.state !== 'running') void ctx.resume().catch(() => {});
}

/** Microphone permission, or 'unknown' where the Permissions API can't tell. */
export async function micPermission(): Promise<PermissionState | 'unknown'> {
  try {
    return (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state;
  } catch {
    return 'unknown';
  }
}

/**
 * The microphone for hearing on the Mac: streamed as 16 kHz mono 16-bit PCM in 20 ms frames, with
 * echo cancellation so Nova doesn't hear itself (and the user can talk over it). Also reports the
 * level for the Orb. Returns a function that stops it.
 */
export async function startCapture(onFrame: (pcm: ArrayBuffer) => void, onLevel: (level: number) => void, onBlocked?: () => void): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  const ctx = audioContext();
  if (ctx.state === 'suspended') void ctx.resume(); // otherwise unlockAudio() resumes it on the first click
  try {
    await ctx.audioWorklet.addModule('/capture-worklet.js');
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    contexts.delete(ctx);
    void ctx.close();
    throw e;
  }
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'nova-capture');
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => onFrame(e.data);
  // Some browsers only run a node that leads somewhere: into silence, then the speakers.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node).connect(mute).connect(ctx.destination);
  const stopLevel = meter(ctx, source, onLevel);
  // Some browsers hold audio until the page is clicked once: say so, rather than seem deaf.
  const check = setTimeout(() => ctx.state !== 'running' && onBlocked?.(), 800);
  return () => {
    clearTimeout(check);
    stopLevel();
    node.port.onmessage = null;
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    contexts.delete(ctx);
    void ctx.close();
  };
}

/** The Orb's level meter on an audio source: RMS in [0, 1], every animation frame. */
function meter(ctx: AudioContext, source: AudioNode, onLevel: (level: number) => void) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
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
  return () => cancelAnimationFrame(raf);
}

/** Microphone RMS level in [0, 1], sampled every animation frame. */
export async function startMicLevel(onLevel: (level: number) => void): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const ctx = audioContext();
  if (ctx.state === 'suspended') void ctx.resume(); // allowed in some browsers; otherwise unlockAudio() resumes it
  const stopLevel = meter(ctx, ctx.createMediaStreamSource(stream), onLevel);
  return () => {
    stopLevel();
    stream.getTracks().forEach((t) => t.stop());
    contexts.delete(ctx);
    void ctx.close();
  };
}

/** Nova's voice as it plays: when it starts, how loud it is, when it ends (the Orb follows it). */
export type SpeechEvent = { type: 'start' } | { type: 'level'; value: number } | { type: 'end' };
const speechListeners = new Set<(e: SpeechEvent) => void>();
const emitSpeech = (e: SpeechEvent) => speechListeners.forEach((listener) => listener(e));

/** Follow Nova's voice as it speaks - when it starts, each word, and when it ends - e.g. to animate the Orb. */
export function onSpeech(listener: (e: SpeechEvent) => void) {
  speechListeners.add(listener);
  return () => void speechListeners.delete(listener);
}

export function stopSpeaking() {
  if (stream) finishStream(stream);
}

// --- Nova's voice: audio the daemon streams (Kokoro), played gap-free through Web Audio. ---

export interface AudioChunk {
  id: string;
  seq: number;
  sampleRate: number;
  pcm: string;
  last: boolean;
  error?: string;
}

interface Stream {
  id: string;
  onEnd: () => void;
  onBlocked?: () => void;
  /** When the next sentence starts, on the audio clock. */
  next: number;
  playing: Set<AudioBufferSourceNode>;
  last: boolean;
  started: boolean;
  /** Told the user to click so sound can play. */
  blockedShown: boolean;
  timer: ReturnType<typeof setTimeout>;
  watchdog: ReturnType<typeof setInterval>;
}

let stream: Stream | null = null;
let playback: { ctx: AudioContext; analyser: AnalyserNode } | null = null;
/** Audio that arrived a moment before its reply did. */
const early: AudioChunk[] = [];

/** Where the natural voice plays. Created once - ideally inside a click, so the browser lets it start. */
function output() {
  if (!playback) {
    const ctx = audioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.connect(ctx.destination);
    playback = { ctx, analyser };
  }
  if (playback.ctx.state !== 'running') void playback.ctx.resume().catch(() => {});
  return playback;
}

function decode(pcm: string): Float32Array {
  const bytes = Uint8Array.from(atob(pcm), (c) => c.charCodeAt(0));
  const ints = new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1);
  return Float32Array.from(ints, (v) => v / 32768);
}

/** How loud Nova's voice is right now, for the Orb. */
function followLevel(s: Stream) {
  const { analyser } = output();
  const buf = new Uint8Array(analyser.fftSize);
  const tick = () => {
    if (stream !== s) return;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    emitSpeech({ type: 'level', value: Math.min(1, Math.sqrt(sum / buf.length) * 3.5) });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function finishStream(s: Stream) {
  if (stream !== s) return;
  stream = null;
  clearTimeout(s.timer);
  clearInterval(s.watchdog);
  for (const src of s.playing) {
    src.onended = null;
    try {
      src.stop();
    } catch {
      // not started yet
    }
  }
  if (s.started) emitSpeech({ type: 'end' });
  s.onEnd();
}

/**
 * Keeps a stream honest. Sound blocked (no click yet): ask for one, and give up after a while
 * rather than "speaking" forever. Sound playing: end once everything scheduled has played, even
 * if the browser never says so.
 */
function watch(s: Stream) {
  let blocked = 0;
  s.watchdog = setInterval(() => {
    if (stream !== s) return clearInterval(s.watchdog);
    const { ctx } = output();
    if (ctx.state !== 'running') {
      if (s.started && !s.blockedShown) (s.blockedShown = true), s.onBlocked?.();
      if ((blocked += 0.5) > 30) finishStream(s);
      return;
    }
    blocked = 0;
    if (s.last && s.started && ctx.currentTime > s.next + 0.75) finishStream(s);
  }, 500);
}

/**
 * Speak a reply whose audio the daemon streams under `id`. If the audio doesn't arrive (or Kokoro
 * fails), the reply stays on screen, unspoken.
 */
export function speakStream(id: string, onEnd: () => void, onBlocked?: () => void) {
  stopSpeaking();
  output(); // wakes the output if the browser allows it; otherwise the watchdog asks for a click
  const s: Stream = {
    id,
    onEnd,
    onBlocked,
    next: 0,
    playing: new Set(),
    last: false,
    started: false,
    blockedShown: false,
    timer: setTimeout(() => finishStream(s), 10_000),
    watchdog: 0 as unknown as ReturnType<typeof setInterval>,
  };
  stream = s;
  watch(s);
  for (const chunk of early.splice(0).filter((c) => c.id === id)) pushAudio(chunk);
}

/** One sentence of streamed audio. */
export function pushAudio(chunk: AudioChunk) {
  const s = stream;
  if (!s || s.id !== chunk.id) {
    early.push(chunk);
    if (early.length > 32) early.shift();
    return;
  }
  clearTimeout(s.timer);
  if (chunk.error) return finishStream(s);
  if (chunk.last) s.last = true;
  if (chunk.pcm) {
    const { ctx, analyser } = output();
    const samples = decode(chunk.pcm);
    const buffer = ctx.createBuffer(1, samples.length, chunk.sampleRate);
    buffer.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(analyser);
    const at = Math.max(ctx.currentTime + 0.04, s.next);
    src.start(at);
    s.next = at + buffer.duration;
    s.playing.add(src);
    src.onended = () => {
      s.playing.delete(src);
      if (s.last && !s.playing.size) finishStream(s);
    };
    if (!s.started) {
      s.started = true;
      emitSpeech({ type: 'start' });
      followLevel(s);
    }
  }
  if (s.last && !s.playing.size) finishStream(s);
  // Waiting on the next sentence (the brain may be using a tool): if it never comes, end rather than hang.
  else if (!s.last) s.timer = setTimeout(() => finishStream(s), 45_000);
}

/** Hear a Kokoro voice. Returns the id to ask the daemon for. */
export function previewVoice(): string {
  const id = `preview-${Math.random().toString(36).slice(2, 10)}`;
  speakStream(id, () => {});
  return id;
}

/** Tiny synthesized earcons - no audio assets needed. */
let earCtx: AudioContext | null = null;
export function earcon(kind: 'wake' | 'done' | 'error') {
  earCtx ??= audioContext();
  const ctx = earCtx;
  if (ctx.state !== 'running') {
    void ctx.resume(); // not allowed yet - skip rather than play late
    return;
  }
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
