import { describe, expect, it } from 'vitest';
import { pitchOf, speechQuality } from '../src/hearing/quality.ts';

const RATE = 16_000;
let seed = 1;
const noise = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;

/** Something like a voice: a pitch with harmonics, in syllables, rising and falling a little. */
function voice(seconds: number, { f0 = 150, amp = 6000, hiss = 60 } = {}) {
  const a = new Int16Array(Math.round(RATE * seconds));
  for (let i = 0; i < a.length; i++) {
    const t = i / RATE;
    const syllables = Math.max(0, Math.sin(2 * Math.PI * 2.5 * t)) ** 0.6;
    const f = f0 * (1 + 0.08 * Math.sin(2 * Math.PI * 0.7 * t));
    let s = 0;
    for (let h = 1; h <= 6; h++) s += Math.sin(2 * Math.PI * f * h * t) / h;
    a[i] = Math.max(-32768, Math.min(32767, amp * syllables * s + hiss * noise()));
  }
  return a;
}

describe('a setup phrase, before Voice ID learns from it', () => {
  it('passes a clear voice, with its loudness, how far it stands above the room, and its pitch', () => {
    const q = speechQuality(voice(3), 1.2);
    expect(q.ok).toBe(true);
    expect(q.level).toBeGreaterThan(-30);
    expect(q.snr).toBeGreaterThan(20);
    expect(q.speech).toBeGreaterThan(1.2);
    expect(q.pitch!.low).toBeGreaterThanOrEqual(100);
    expect(q.pitch!.low).toBeLessThanOrEqual(170);
  });

  it('says why a recording will not do: too quiet, drowned in noise, distorted, too short, not a voice', () => {
    expect(speechQuality(new Int16Array(RATE * 2), 1.2).problems[0]).toMatch(/too quiet/);
    expect(speechQuality(voice(3, { amp: 150, hiss: 20 }), 1.2).problems[0]).toMatch(/too quiet/);
    const room = new Int16Array(RATE * 3).map(() => 3000 * noise());
    expect(speechQuality(room, 1.2).problems[0]).toMatch(/too much noise/);
    expect(speechQuality(voice(3, { amp: 40_000 }), 1.2).problems[0]).toMatch(/too loud and distorted/);
    expect(speechQuality(voice(0.8), 1.2).problems[0]).toMatch(/too short/);
    expect(speechQuality(voice(6), 6).problems[0]).toMatch(/Keep talking a little longer/); // free talk needs more
    const hiss = new Int16Array(RATE * 3).map((_, i) => (Math.sin(2 * Math.PI * 0.5 * (i / RATE)) > 0 ? 8000 * noise() : 20 * noise()));
    expect(speechQuality(hiss, 1.2).problems).toContainEqual(expect.stringMatching(/didn't sound like someone talking/));
  });

  it('finds a voiced frame\'s pitch, and none in a hiss', () => {
    const tone = new Int16Array(640).map((_, i) => 8000 * Math.sin((2 * Math.PI * 200 * i) / RATE));
    expect(pitchOf(tone)).toBeGreaterThan(190);
    expect(pitchOf(tone)).toBeLessThan(210);
    expect(pitchOf(new Int16Array(640).map(() => 8000 * noise()))).toBeNull();
  });
});
