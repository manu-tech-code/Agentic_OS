/**
 * How good a setup phrase's recording is, before Voice ID learns a voice from it: loud enough, not clipped, clear of
 * background noise, long enough in actual speech, and voiced (a person talking - its pitch is found in code). The
 * arithmetic is here; the audio is the turn's own, 16 kHz 16-bit, and goes nowhere.
 */

export interface Quality {
  ok: boolean;
  /** Why it won't do, most important first - said to the user as it is. */
  problems: string[];
  /** Speech loudness (median of the speaking frames), in dB below full scale. */
  level: number;
  /** How far the speech stands above the room's noise, in dB. */
  snr: number;
  /** Seconds of actual speech. */
  speech: number;
  /** Share of samples at (or next to) full scale. */
  clipped: number;
  /** The voice's pitch: its middle and its range (10th to 90th percentile), in Hz; null when none was voiced. */
  pitch: { median: number; low: number; high: number } | null;
}

const RATE = 16_000;
const FRAME = 320; // 20 ms
/** Thresholds: quieter than this is hard to learn from; below this, the room drowns it; more than this share clipped is distorted. */
const QUIET_DB = -42;
const MIN_SNR_DB = 12;
const CLIP_SHARE = 0.002;

const db = (rms: number) => 20 * Math.log10(Math.max(rms, 1e-9) / 32768);

function percentile(sorted: readonly number[], p: number) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i]!;
}

/**
 * A frame's pitch, by autocorrelation over 70-400 Hz (a speaking voice): the lag that best repeats the frame, when it
 * repeats well enough to be voiced - null otherwise (a hiss, a click, silence).
 */
export function pitchOf(frame: Int16Array | Float32Array): number | null {
  const n = frame.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += frame[i]!;
  mean /= n;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += (frame[i]! - mean) ** 2;
  if (energy <= 0) return null;
  const minLag = Math.floor(RATE / 400);
  const maxLag = Math.min(n - 1, Math.ceil(RATE / 70));
  let best = 0;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i + lag < n; i++) {
      const a = frame[i]! - mean;
      const b = frame[i + lag]! - mean;
      sum += a * b;
      e1 += a * a;
      e2 += b * b;
    }
    const r = sum / Math.sqrt(e1 * e2 || 1);
    if (r > best) {
      best = r;
      bestLag = lag;
    }
  }
  return best >= 0.5 && bestLag ? RATE / bestLag : null;
}

/** The quality of a recording for learning a voice from; `minSpeech` seconds of speech at least (a phrase, or free talk). */
export function speechQuality(audio: Int16Array, minSpeech: number): Quality {
  const frames = Math.floor(audio.length / FRAME);
  const levels: number[] = [];
  let clippedSamples = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) {
      const x = audio[i]!;
      sum += x * x;
      if (x >= 32_000 || x <= -32_000) clippedSamples++;
    }
    levels.push(db(Math.sqrt(sum / FRAME)));
  }
  const sorted = [...levels].sort((a, b) => a - b);
  const noise = percentile(sorted, 0.1);
  // Speaking frames: well above the room, and above the quietest a voice can be.
  const speaking = levels.map((l, f) => ({ l, f })).filter(({ l }) => l > noise + 8 && l > -55);
  const speakingLevels = speaking.map((s) => s.l).sort((a, b) => a - b);
  const level = speaking.length ? percentile(speakingLevels, 0.5) : (sorted.at(-1) ?? -120);
  const snr = speaking.length ? level - noise : 0;
  const speech = (speaking.length * FRAME) / RATE;
  const clipped = audio.length ? clippedSamples / audio.length : 0;

  // Pitch, from 40 ms windows centred on the speaking frames.
  const pitches: number[] = [];
  for (const { f } of speaking) {
    const start = Math.max(0, f * FRAME - FRAME / 2);
    const window = audio.subarray(start, Math.min(audio.length, start + 2 * FRAME));
    if (window.length < 2 * FRAME) continue;
    const p = pitchOf(window);
    if (p) pitches.push(p);
  }
  pitches.sort((a, b) => a - b);
  const voiced = speaking.length ? pitches.length / speaking.length : 0;
  const pitch = pitches.length >= 5 ? { median: Math.round(percentile(pitches, 0.5)), low: Math.round(percentile(pitches, 0.1)), high: Math.round(percentile(pitches, 0.9)) } : null;

  const problems: string[] = [];
  if (clipped > CLIP_SHARE) problems.push('It was too loud and distorted - speak a little softer, or further from the microphone.');
  const noisy = 'There was too much noise around it - somewhere quieter, or closer to the microphone.';
  // Nothing stood out: a quiet room is too quiet a voice; a loud one drowned it.
  if (!speaking.length) problems.push(noise > -45 ? noisy : 'It was too quiet to learn from - speak up a little, or come closer.');
  else if (level < QUIET_DB) problems.push('It was too quiet to learn from - speak up a little, or come closer.');
  else if (snr < MIN_SNR_DB) problems.push(noisy);
  if (speaking.length && speech < minSpeech)
    problems.push(minSpeech > 5 ? `Keep talking a little longer - about ${Math.ceil(minSpeech)} seconds of speech.` : 'That was too short - say the whole phrase.');
  if (speaking.length && speech >= minSpeech && voiced < 0.2) problems.push("That didn't sound like someone talking - just your voice, please.");
  return { ok: problems.length === 0, problems, level: Math.round(level), snr: Math.round(snr), speech: Math.round(speech * 10) / 10, clipped, pitch };
}
