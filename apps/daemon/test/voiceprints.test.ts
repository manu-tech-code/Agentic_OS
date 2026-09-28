import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kaldiFbank, MEL_BANDS, nemoMel } from '../src/hearing/features.ts';
import { Voiceprinter, type WorkerModel } from '../src/hearing/printer.ts';
import { VoiceRecordings, wav } from '../src/hearing/recordings.ts';
import { isInstalled, MODELS, modelsDir } from '../src/models/files.ts';

const RATE = 16_000;
let seed = 7;
const noise = (n: number, level: number) => Int16Array.from({ length: n }, () => Math.round(((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 - 0.5) * 2 * level));
const tone = (n: number, hz: number, level = 8000) => Int16Array.from({ length: n }, (_, i) => Math.round(level * Math.sin((2 * Math.PI * hz * i) / RATE)));
const joined = (...parts: Int16Array[]) => {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};

describe("what Voice ID's larger models hear, in code", () => {
  it("makes WeSpeaker's Kaldi filterbanks: a frame each 10 ms within the audio, each band less its mean", () => {
    expect(kaldiFbank(new Int16Array(399)).frames).toBe(0);
    const audio = noise(RATE, 3000);
    const { feats, frames } = kaldiFbank(audio);
    expect(frames).toBe(1 + Math.floor((RATE - 400) / 160));
    expect(feats.length).toBe(frames * MEL_BANDS);
    for (let b = 0; b < MEL_BANDS; b++) {
      let sum = 0;
      for (let t = 0; t < frames; t++) sum += feats[t * MEL_BANDS + b]!;
      expect(Math.abs(sum / frames)).toBeLessThan(1e-4);
    }
    // Louder is the same to it: its bands' means go.
    const louder = kaldiFbank(Int16Array.from(audio, (x) => x * 4)).feats;
    expect(Math.max(...feats.map((x, i) => Math.abs(x - louder[i]!)))).toBeLessThan(1e-3);
  });

  it('hears a 1 kHz tone in the band around 1 kHz', () => {
    const { feats, frames } = kaldiFbank(joined(tone(RATE / 2, 1000), noise(RATE / 2, 10)));
    const early = 10;
    const late = frames - 10;
    const rise = Array.from({ length: MEL_BANDS }, (_, b) => feats[early * MEL_BANDS + b]! - feats[late * MEL_BANDS + b]!);
    expect(rise.indexOf(Math.max(...rise))).toBeGreaterThanOrEqual(26); // Kaldi's band 27 is centred on 1 kHz
    expect(rise.indexOf(Math.max(...rise))).toBeLessThanOrEqual(28);
  });

  it("makes TitaNet's log-mel spectrogram as NeMo does: each band normalised over the turn, padded to 16 frames", () => {
    const audio = noise(RATE + 80, 3000);
    const { feats, frames, padded } = nemoMel(audio);
    expect(frames).toBe(Math.floor(audio.length / 160));
    expect(padded % 16).toBe(0);
    expect(padded).toBeGreaterThan(frames);
    expect(feats.length).toBe(MEL_BANDS * padded);
    for (const b of [0, 20, 79]) {
      const row = Array.from(feats.subarray(b * padded, b * padded + frames));
      const mean = row.reduce((s, x) => s + x, 0) / frames;
      const sd = Math.sqrt(row.reduce((s, x) => s + (x - mean) ** 2, 0) / (frames - 1));
      expect(Math.abs(mean)).toBeLessThan(1e-4);
      expect(sd).toBeCloseTo(1, 2);
      expect(Array.from(feats.subarray(b * padded + frames, (b + 1) * padded)).every((x) => x === 0)).toBe(true); // past the turn
    }
    // Louder is nearly the same to it (NeMo's guard under the log, 2⁻²⁴, is all that tells them apart).
    const louder = nemoMel(Int16Array.from(audio, (x) => x * 4)).feats;
    expect(Math.max(...feats.map((x, i) => Math.abs(x - louder[i]!)))).toBeLessThan(0.05);
  });
});

describe('recordings of the user’s turns', () => {
  const at = new Date(2026, 8, 28, 17, 5, 9);
  const turn = { kind: 'turn' as const, audio: tone(RATE, 440), text: 'manuel open safari', seconds: 1, speaker: 'you', score: 0.71, scores: { 'wespeaker-v2': 0.7 } };

  it('keeps each one when switched on - a WAV and a line in the day’s index, readable by the user alone', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'nova-rec-')), 'voice-recordings');
    let on = false;
    const recordings = new VoiceRecordings(dir, { on: () => on, now: () => at });
    recordings.keep(turn);
    await recordings.flushed();
    await expect(stat(dir)).rejects.toThrow(); // off: nothing kept
    on = true;
    recordings.keep(turn);
    recordings.keep({ ...turn, kind: 'shortcut', text: 'open slack' });
    await recordings.flushed();
    const day = join(dir, '2026-09-28');
    expect((await stat(day)).mode & 0o777).toBe(0o700);
    const files = (await readdir(day)).sort();
    expect(files).toEqual(['170509-0001-turn.wav', '170509-0002-shortcut.wav', 'index.jsonl']);
    for (const f of files) expect((await stat(join(day, f))).mode & 0o777).toBe(0o600);
    const lines = (await readFile(join(day, 'index.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ at: at.toISOString(), file: '170509-0001-turn.wav', kind: 'turn', text: 'manuel open safari', seconds: 1, speaker: 'you', score: 0.71, scores: { 'wespeaker-v2': 0.7 } });
    expect(lines[1]).toMatchObject({ kind: 'shortcut', text: 'open slack' });
    const file = await readFile(join(day, files[0]!));
    expect(file.toString('ascii', 0, 4)).toBe('RIFF');
    expect(file.readUInt32LE(24)).toBe(RATE);
    expect(file.readUInt32LE(40)).toBe(RATE * 2);
    expect(file.length).toBe(44 + RATE * 2);
  });

  it('deletes the days older than a week - and everything once switched off', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'nova-rec-')), 'voice-recordings');
    let on = true;
    const recordings = new VoiceRecordings(dir, { on: () => on, now: () => at });
    for (const d of ['2026-09-28', '2026-09-22', '2026-09-21', '2026-09-10', 'notes']) await mkdir(join(dir, d), { recursive: true });
    expect(await recordings.sweep()).toBe(2);
    expect((await readdir(dir)).sort()).toEqual(['2026-09-22', '2026-09-28', 'notes']); // today and the six days before
    on = false;
    await recordings.sweep();
    await expect(stat(dir)).rejects.toThrow();
  });

  it('writes 16 kHz mono 16-bit WAV', () => {
    const out = wav(Int16Array.of(1, -1, 32767));
    expect(out.length).toBe(50);
    expect(out.toString('ascii', 8, 12)).toBe('WAVE');
    expect(out.readUInt16LE(22)).toBe(1);
    expect(out.readUInt16LE(34)).toBe(16);
    expect(out.readInt16LE(48)).toBe(32767);
  });
});

// With the real models and macOS voices: the same voice must come out closer to itself than to another, in both.
const onMac = platform() === 'darwin';
const installed = (await isInstalled('wespeaker-resnet293')) && (await isInstalled('titanet-large'));
const models: WorkerModel[] = [
  { ear: 'wespeaker-resnet293', kind: 'wespeaker', file: join(modelsDir(), 'wespeaker-resnet293', Object.keys(MODELS['wespeaker-resnet293']!.files)[0]!) },
  { ear: 'titanet-large', kind: 'nemo', file: join(modelsDir(), 'titanet-large', Object.keys(MODELS['titanet-large']!.files)[0]!) },
];

describe.skipIf(!onMac || !installed)("Voice ID's larger models, with macOS voices", () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-voices-'));
  const speech = (voice: string, text: string): Int16Array => {
    const file = join(dir, `${voice}-${text.length}.wav`);
    execFileSync('say', ['-v', voice, '-o', file, '--file-format=WAVE', '--data-format=LEI16@16000', text]);
    const bytes = readFileSync(file);
    const at = bytes.indexOf('data');
    const data = bytes.subarray(at + 8, at + 8 + bytes.readUInt32LE(at + 4));
    return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
  };
  const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

  it('tells two voices apart in each model, and makes no voiceprint of half a second', async () => {
    const printer = (await Voiceprinter.start(models))!;
    expect(printer).not.toBeNull();
    try {
      const lines = ['The weather today should be bright with a light breeze in the afternoon.', 'Please remind me to call my sister when I get home tonight.'];
      const prints: Record<string, Record<string, number[]>[]> = {};
      for (const voice of ['Samantha', 'Daniel']) {
        prints[voice] = [];
        for (const line of lines) prints[voice].push((await printer.print(speech(voice, line), 20_000))!);
      }
      for (const { ear } of models) {
        const same = Math.min(cos(prints.Samantha![0]![ear]!, prints.Samantha![1]![ear]!), cos(prints.Daniel![0]![ear]!, prints.Daniel![1]![ear]!));
        const other = Math.max(cos(prints.Samantha![0]![ear]!, prints.Daniel![0]![ear]!), cos(prints.Samantha![1]![ear]!, prints.Daniel![1]![ear]!));
        expect(same, ear).toBeGreaterThan(other + 0.1);
        expect(prints.Samantha![0]![ear]!.length).toBe(ear === 'titanet-large' ? 192 : 256);
      }
      expect(await printer.print(new Int16Array(RATE / 4), 5_000)).toBeNull();
    } finally {
      printer.close();
    }
  }, 60_000);
});
