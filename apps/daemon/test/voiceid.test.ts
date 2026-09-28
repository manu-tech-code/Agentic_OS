import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  barsFrom,
  consistent,
  cosine,
  EARS,
  EAR_WEIGHTS,
  enrollFrom,
  HELPER_EAR,
  judge,
  leaveOneOut,
  learnFrom,
  migrateVoiceprint,
  scoreOf,
  VoiceId,
  VoiceprintStore,
  type Ear,
  type LegacyVoiceprint,
  type Prints,
  type StoredVoiceprint,
  type VoiceModels,
} from '../src/hearing/voiceid.ts';
import { Keyword } from '../src/hearing/keyword.ts';
import type { Recording } from '../src/hearing/recordings.ts';

/** Voiceprints for tests: a person's is their own direction in each model, plus a little noise each time they speak. */
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
}
const unit = (v: number[]) => {
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map((x) => x / n);
};
function person(seed: number) {
  const r = rng(seed);
  const bases = Object.fromEntries(EARS.map((ear) => [ear, unit(Array.from({ length: 256 }, r))])) as Record<Ear, number[]>;
  return (noise = 0.35): Prints => Object.fromEntries(EARS.map((ear) => [ear, unit(bases[ear].map((x) => x + noise * r() * 0.12))]));
}
/** One voice moved toward another, in every model: a turn like the user's, but not quite. */
const blend = (a: Prints, b: Prints, k: number): Prints => Object.fromEntries(EARS.map((ear) => [ear, unit(a[ear]!.map((x, i) => x + k * b[ear]![i]!))]));
/** Just one model's print. */
const only = (p: Prints, ear: Ear = HELPER_EAR): Prints => ({ [ear]: p[ear]! });
const all = (n: number, say: () => Prints) => Array.from({ length: n }, say);
const score = (voice: StoredVoiceprint, p: Prints) => scoreOf(voice, p)!.score;

/** Every model on the Mac, as Voice ID finds them. */
const models = (dir: string): VoiceModels => ({
  helper: dir,
  worker: [
    { ear: 'wespeaker-resnet293', kind: 'wespeaker', file: join(dir, 'resnet293.onnx') },
    { ear: 'titanet-large', kind: 'nemo', file: join(dir, 'titanet.onnx') },
  ],
  complete: true,
});

describe('voiceprints, in code', () => {
  const you = person(1);
  const other = person(99);

  it('learns a voice from its setup phrases in each model, with bars from how alike they came out', () => {
    const voice = enrollFrom(all(6, you));
    expect(Object.keys(voice.ears).sort()).toEqual([...EARS].sort());
    for (const ear of EARS) expect(voice.ears[ear]!.reject).toBeLessThan(voice.ears[ear]!.accept);
    expect(voice.accept).toBeGreaterThanOrEqual(0.45);
    expect(voice.accept).toBeLessThanOrEqual(0.62);
    expect(voice.reject).toBeLessThan(voice.accept);
    expect(score(voice, you())).toBeGreaterThan(voice.accept);
    expect(() => enrollFrom(all(2, you))).toThrow(/Too few/);
    // A model that heard fewer than three phrases isn't part of it.
    const partial = enrollFrom([you(), you(), you(), only(you())]);
    expect(Object.keys(partial.ears)).toHaveLength(3);
    const thin = enrollFrom([you(), only(you()), only(you()), only(you())]);
    expect(Object.keys(thin.ears)).toEqual([HELPER_EAR]);
  });

  it('weighs the models together on one scale: their own bars, weighed, and a match placed between them', () => {
    const voice = enrollFrom(all(6, you));
    const weighed = (key: 'accept' | 'reject') => EARS.reduce((s, ear) => s + EAR_WEIGHTS[ear] * voice.ears[ear]![key], 0) / EARS.reduce((s, ear) => s + EAR_WEIGHTS[ear], 0);
    expect(voice.accept).toBeCloseTo(weighed('accept'), 10);
    expect(voice.reject).toBeCloseTo(weighed('reject'), 10);
    // A match right at each model's own "you" bar is right at the voiceprint's.
    const turn = you();
    const at: StoredVoiceprint = { ...voice, accept: 0.6, reject: 0.4, ears: Object.fromEntries(EARS.map((ear) => [ear, { ...voice.ears[ear]!, centroids: undefined, accept: cosine(voice.ears[ear]!.print, turn[ear]!) }])) };
    const placed = scoreOf(at, turn)!;
    expect(placed.score).toBeCloseTo(0.6, 10);
    expect(Object.keys(placed.ears)).toHaveLength(3);
    // With one model, it's that model's match; with none of the voiceprint's, there's none.
    const one = enrollFrom(all(4, you).map((p) => only(p)));
    expect(score(one, turn)).toBeCloseTo(cosine(one.ears[HELPER_EAR]!.print, turn[HELPER_EAR]!), 10);
    expect(scoreOf(one, only(turn, 'titanet-large'))).toBeNull();
    expect(judge(one, only(turn, 'titanet-large'), 3)).toEqual({ speaker: 'unsure', score: null, ears: {} });
    // A turn some models didn't answer for is judged by those that did.
    expect(judge(voice, only(turn, 'wespeaker-resnet293'), 3).speaker).toBe('you');
    expect(judge(voice, only(other(), 'wespeaker-resnet293'), 3).speaker).toBe('not-you');
  });

  it("tells the user from someone else - and says it can't tell from too little speech", () => {
    const voice = enrollFrom(all(6, you));
    expect(judge(voice, you(), 3).speaker).toBe('you');
    expect(judge(voice, other(), 3).speaker).toBe('not-you');
    expect(judge(voice, you(), 0.5).speaker).toBe('unsure'); // under MIN_SECONDS
    // A short turn needs a clearer match than a long one.
    const one = enrollFrom(all(6, you).map((p) => only(p)));
    const print = only(you());
    const s = score(one, print);
    const borderline: StoredVoiceprint = { ...one, accept: s - 0.02, reject: s - 0.22, ears: { [HELPER_EAR]: { ...one.ears[HELPER_EAR]!, centroids: undefined, accept: s - 0.02, reject: s - 0.22 } } };
    expect(judge(borderline, print, 1).speaker).toBe('unsure');
    expect(judge(borderline, print, 3).speaker).toBe('you');
  });

  it('sets the bars from each setup phrase against the others - never flattered by an average that includes it', () => {
    const phrases = all(6, () => you(0.9));
    const prints = phrases.map((p) => p[HELPER_EAR]!);
    const avg = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
    const flattering = avg(prints.map((p) => cosine(p, unit(prints[0]!.map((_, i) => prints.reduce((a, q) => a + q[i]!, 0))))));
    expect(avg(leaveOneOut(prints))).toBeLessThan(flattering);
    const voice = enrollFrom(phrases);
    expect(voice).toMatchObject({ version: 3, enrolled: 6 });
    expect(voice.phrases).toHaveLength(6); // kept, to set the bars again or add phrases later
    // Well under how alike the phrases were, and never above 0.62 or below what tells people apart.
    expect(barsFrom([0.9])).toEqual({ accept: 0.62, reject: 0.4 });
    expect(barsFrom([0.7]).accept).toBeCloseTo(0.5);
    expect(barsFrom([0.4])).toEqual({ accept: 0.45, reject: 0.25 });
    // TitaNet's matches run lower, and so do its bars.
    expect(barsFrom([0.9], 'titanet-large')).toEqual({ accept: 0.6, reject: 0.38 });
    expect(barsFrom([0.5], 'titanet-large')).toEqual({ accept: 0.35, reject: 0.2 });
  });

  it('keeps a voiceprint set up the old way - its bars set as the new way would have, the small model its only one', () => {
    // Set up with six phrases, whose likeness to their own average came out at 0.837: "you" was 0.687, "not you" 0.45.
    const old: LegacyVoiceprint = { version: 1, model: 'wespeaker-v2', print: [1], accept: 0.6867, reject: 0.45, enrolled: 6, learned: 0, updated: '' };
    const now = migrateVoiceprint(old);
    expect(now.version).toBe(3);
    expect(now.accept).toBeCloseTo(0.559, 2); // phrases alike by 0.64 each: one against the others, 0.76
    expect(now.reject).toBeCloseTo(0.359, 2);
    expect(now.ears).toEqual({ [HELPER_EAR]: { print: [1], accept: now.accept, reject: now.reject } });
    expect(migrateVoiceprint(now)).toBe(now); // already the new way
    const two: LegacyVoiceprint = { version: 2, model: 'wespeaker-v2', print: [0, 1], accept: 0.55, reject: 0.35, enrolled: 3, learned: 2, updated: '', phrases: [[0, 1], [0.1, 0.9], [0, 1]], conditions: ['normal', 'far', 'free'] };
    expect(migrateVoiceprint(two)).toMatchObject({ version: 3, accept: 0.55, reject: 0.35, learned: 2, phrases: [{ [HELPER_EAR]: [0, 1] }, { [HELPER_EAR]: [0.1, 0.9] }, { [HELPER_EAR]: [0, 1] }], conditions: ['normal', 'far', 'free'] });
  });

  it('keeps a phrase out of the setup when it sounds like someone else', () => {
    expect(consistent([], other())).toBe(true);
    expect(consistent([you(), you()], you())).toBe(true);
    expect(consistent([you(), you()], other())).toBe(false);
    expect(consistent([you(), you()], only(other(), 'titanet-large'))).toBe(false); // by the models that heard it
  });

  it('learns only from turns that were clearly the user, and long enough - a little at a time, in each model', () => {
    const voice = enrollFrom(all(6, you));
    const turn = you();
    const s = score(voice, turn);
    expect(learnFrom(voice, turn, s, 1)).toBeNull(); // too short
    expect(learnFrom(voice, turn, voice.accept, 3)).toBeNull(); // not clear enough
    const next = learnFrom(voice, turn, Math.max(s, voice.accept + 0.06), 3)!;
    expect(next.learned).toBe(1);
    for (const ear of EARS) {
      expect(cosine(next.ears[ear]!.print, turn[ear]!)).toBeGreaterThan(cosine(voice.ears[ear]!.print, turn[ear]!));
      expect(cosine(next.ears[ear]!.print, voice.ears[ear]!.print)).toBeGreaterThan(0.99); // a little at a time
    }
  });
});

describe('the voiceprint on disk', () => {
  const you = person(3);
  const voice = (): StoredVoiceprint => enrollFrom(all(4, you));

  it('is readable by the user alone, only for the models it knows, and gone when forgotten', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nova-voice-'));
    const file = join(dir, 'voiceprint.json');
    const store = new VoiceprintStore(file, 'wespeaker-v2');
    expect(await store.load()).toBeNull();
    await store.set(voice());
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await new VoiceprintStore(file, 'wespeaker-v2').load()).toMatchObject({ version: 3, enrolled: 4 });
    // Kept the old way, by another model: its prints don't compare with any made now.
    await writeFile(file, JSON.stringify({ version: 2, model: 'another-model', print: [1, 0], accept: 0.5, reject: 0.3, enrolled: 3, learned: 0, updated: '' }));
    expect(await new VoiceprintStore(file, 'wespeaker-v2').load()).toBeNull();
    // A model it doesn't know is left out; with none it knows, there's no voiceprint.
    await writeFile(file, JSON.stringify({ ...voice(), ears: { 'some-model': { print: [1], accept: 0.5, reject: 0.3 }, [HELPER_EAR]: voice().ears[HELPER_EAR] } }));
    expect(Object.keys((await new VoiceprintStore(file, 'wespeaker-v2').load())!.ears)).toEqual([HELPER_EAR]);
    await writeFile(file, JSON.stringify({ ...voice(), ears: { 'some-model': { print: [1], accept: 0.5, reject: 0.3 } } }));
    expect(await new VoiceprintStore(file, 'wespeaker-v2').load()).toBeNull();
    await writeFile(file, '{ broken');
    expect(await new VoiceprintStore(file, 'wespeaker-v2').load()).toBeNull();
    await store.forget();
    await expect(stat(file)).rejects.toThrow();
  });

  it('keeps an old voiceprint the new way once, as it loads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nova-voice-'));
    const file = join(dir, 'voiceprint.json');
    await writeFile(file, JSON.stringify({ version: 1, model: 'wespeaker-v2', print: [0.6, 0.8], accept: 0.6867, reject: 0.45, enrolled: 6, learned: 0, updated: '' }));
    const loaded = await new VoiceprintStore(file, 'wespeaker-v2').load();
    expect(loaded).toMatchObject({ version: 3, accept: expect.closeTo(0.559, 2) });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 3, ears: { [HELPER_EAR]: { print: [0.6, 0.8] } } });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('writes what it learns now and then, not on every turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nova-voice-'));
    const file = join(dir, 'voiceprint.json');
    const store = new VoiceprintStore(file, 'wespeaker-v2');
    const v = voice();
    await store.set(v);
    for (let i = 1; i <= 9; i++) await store.learned({ ...v, learned: i });
    expect(JSON.parse(await readFile(file, 'utf8')).learned).toBe(0);
    await store.learned({ ...v, learned: 10 });
    expect(JSON.parse(await readFile(file, 'utf8')).learned).toBe(10);
    await store.learned({ ...v, learned: 11 });
    await store.flush();
    expect(JSON.parse(await readFile(file, 'utf8')).learned).toBe(11);
  });
});

describe('Voice ID, set up and at work', () => {
  const you = person(5);
  const other = person(77);

  async function setup(opts: { enabled?: boolean; model?: boolean; now?: () => number; learning?: boolean; installed?: (dir: string) => VoiceModels | null } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'nova-voice-'));
    const store = new VoiceprintStore(join(dir, 'voiceprint.json'), 'wespeaker-v2');
    let enabled = opts.enabled ?? false;
    const turnOn = vi.fn(async () => void (enabled = true));
    const kept: Recording[] = [];
    const voice = new VoiceId({
      store,
      label: 'three models',
      size: '223 MB',
      models: async () => (opts.model === false ? null : opts.installed ? opts.installed(dir) : models(dir)),
      enabled: () => enabled,
      learning: () => opts.learning ?? true,
      name: () => 'Manuel',
      recordings: { keep: (r) => void kept.push(r) },
      turnOn,
      changed: () => {},
      ...(opts.now ? { now: opts.now } : {}),
    });
    await voice.refresh();
    return { voice, store, turnOn, dir, kept, enable: (on: boolean) => void (enabled = on) };
  }

  /** Says each collecting step of the setup (as usual, a step back, quietly, talking freely) in the same voice. */
  const collect = (voice: VoiceId, say: () => Prints, steps = 11) => {
    for (let i = 0; i < steps; i++) expect(voice.enroll(say(), i === steps - 1 ? 16 : 3, 'phrase')).toBe(true);
  };

  it('needs its models, then learns the voice as usual, a step back, quietly and talking - checks it - and switches itself on', async () => {
    const without = await setup({ model: false });
    await expect(without.voice.start()).rejects.toThrow(/needs its model/);
    expect(without.voice.status()).toMatchObject({ installed: false, size: '223 MB' });

    const { voice, turnOn, store } = await setup();
    expect(voice.active()).toBeNull(); // nothing to check yet
    expect(await voice.start()).toMatch(/Manuel, what's on my calendar today/);
    expect(voice.active()).toMatchObject({ helper: expect.any(String), worker: [{ ear: 'wespeaker-resnet293' }, { ear: 'titanet-large' }] }); // setting up: prints are wanted
    expect(voice.status().enrolling).toMatchObject({ step: 1, of: 11, kind: 'normal', phase: 'collect' });
    expect(voice.enroll(you(), 0.6, 'too short')).toBe(true);
    expect(voice.status()).toMatchObject({ enrolling: { step: 1, done: [{ ok: false, why: expect.stringMatching(/too short/) }] } });
    voice.enroll(you(), 3, 'one');
    expect(voice.enroll(other(), 3, 'someone else')).toBe(true);
    expect(voice.status()).toMatchObject({ enrolling: { step: 2 }, message: expect.stringMatching(/didn't sound like the others/) });
    collect(voice, () => you(), 10);
    expect(voice.status().enrolling).toMatchObject({ phase: 'check', step: 1, of: 3, kind: 'check' });
    for (let i = 0; i < 3; i++) voice.enroll(you(), 3, 'check');
    await vi.waitFor(() => expect(turnOn).toHaveBeenCalled());
    expect(store.current).toMatchObject({ version: 3, enrolled: 11, conditions: ['normal', 'normal', 'normal', 'normal', 'normal', 'normal', 'far', 'far', 'quiet', 'quiet', 'free'] });
    for (const ear of EARS) expect(store.current!.ears[ear]!.centroids!.map((c) => c.condition)).toEqual(['normal', 'far', 'quiet', 'free']);
    expect(voice.status()).toMatchObject({ installed: true, enrolled: true, on: true, enrolling: null, improvable: true, message: expect.stringMatching(/last 3 checks all came out as you/) });
    expect(voice.enroll(you(), 3, 'after')).toBe(false); // done: turns go to Nova again
  });

  it("takes only a recording good enough to learn from, and says why when it isn't", async () => {
    const { voice } = await setup();
    await voice.start();
    const silence = new Int16Array(16_000 * 3);
    expect(voice.enroll(you(), 3, 'phrase', silence)).toBe(true);
    expect(voice.status().enrolling).toMatchObject({ step: 1, done: [{ ok: false, why: expect.stringMatching(/too quiet/) }] });
    const loud = new Int16Array(16_000 * 3).fill(32_767);
    voice.enroll(you(), 3, 'phrase', loud);
    expect(voice.status().enrolling!.done.at(-1)).toMatchObject({ ok: false, why: expect.stringMatching(/too loud and distorted/) });
    expect(voice.status().enrolling!.step).toBe(1); // not taken either time
  });

  it("learns from a check that doesn't come out as the user yet, and needs three in a row - or goes on after seven", async () => {
    const { voice, store, turnOn } = await setup();
    await voice.start();
    collect(voice, () => you());
    // Like the user, but not enough: learned from, and the count starts again.
    const halfway = (seed: number) => blend(you(), person(seed)(), 1.4);
    voice.enroll(you(), 3, 'check');
    voice.enroll(halfway(100), 3, 'check');
    expect(voice.status().enrolling).toMatchObject({ phase: 'check', step: 1, done: expect.arrayContaining([expect.objectContaining({ kind: 'check', ok: false, why: expect.stringMatching(/learned from it/) })]) });
    for (let i = 0; i < 3; i++) voice.enroll(you(), 3, 'check');
    await vi.waitFor(() => expect(turnOn).toHaveBeenCalled());
    expect(store.current!.enrolled).toBe(12); // the one that didn't pass was learned from

    const again = await setup();
    await again.voice.start();
    collect(again.voice, () => you());
    for (let i = 0; i < 7; i++) again.voice.enroll(halfway(200 + i), 3, 'check');
    await vi.waitFor(() => expect(again.turnOn).toHaveBeenCalled());
    expect(again.voice.status().message).toMatch(/may still miss you now and then/);
  });

  it('starts over from the phrases that agree when the first one was the odd one out', async () => {
    const { voice, turnOn, store } = await setup();
    await voice.start();
    voice.enroll(other(), 3, 'the TV, first'); // taken: nothing to compare it with yet
    voice.enroll(you(), 3, 'the user');
    expect(voice.status()).toMatchObject({ enrolling: { step: 2 }, message: expect.stringMatching(/didn't sound like the others/) });
    voice.enroll(you(), 3, 'the user again'); // alike, and both unlike the first: the first goes
    expect(voice.status()).toMatchObject({ enrolling: { step: 3 } });
    expect(voice.status().message).toBeUndefined();
    collect(voice, () => you(), 9);
    for (let i = 0; i < 3; i++) voice.enroll(you(), 3, 'check');
    await vi.waitFor(() => expect(turnOn).toHaveBeenCalled());
    expect(score(store.current!, you())).toBeGreaterThan(store.current!.accept);
    expect(score(store.current!, other())).toBeLessThan(store.current!.reject);
  });

  it('improves the voice with a few more phrases, kept with the ones before - no setting up again', async () => {
    const { voice, store } = await setup({ enabled: true });
    await expect(voice.improve()).rejects.toThrow(/set it up again/); // nothing kept to add to
    await store.set({ ...enrollFrom(all(6, you)), learned: 4 });
    expect(await voice.improve()).toMatch(/read me my last message/);
    expect(voice.status().enrolling).toMatchObject({ of: 5, phase: 'collect' });
    collect(voice, () => you(), 5);
    for (let i = 0; i < 3; i++) voice.enroll(you(), 3, 'check');
    await vi.waitFor(() => expect(store.current!.enrolled).toBe(11));
    expect(store.current).toMatchObject({ learned: 4, conditions: expect.arrayContaining(['far', 'free']) });
  });

  it('asks for the setup again when there are models the voiceprint was made without - and listens with the one it had meanwhile', async () => {
    const { voice, store } = await setup({ enabled: true });
    await store.set(enrollFrom(all(6, you).map((p) => only(p)))); // set up with the small model alone
    expect(voice.status()).toMatchObject({ improvable: false, message: expect.stringMatching(/2 more models now - Learn it again/) });
    await expect(voice.improve()).rejects.toThrow(/Learn it again/);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(voice.decide(you(), 3)).toBe('you'); // the small model's match alone
      expect(voice.decide(other(), 3)).toBe('not-you');
    } finally {
      log.mockRestore();
    }
    const small = await setup({ enabled: true, installed: (dir) => ({ helper: dir, worker: [], complete: false }) });
    await small.store.set(enrollFrom(all(6, you).map((p) => only(p))));
    expect(small.voice.status()).toMatchObject({ installed: false, improvable: true });
    expect(small.voice.status().message).toBeUndefined(); // nothing more to learn it with until they're installed
  });

  it("decides whose each turn is only when it's on - and learns only from the user", async () => {
    const { voice, store } = await setup({ enabled: true });
    await store.set(enrollFrom(all(6, you)));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(voice.decide(you(), 3)).toBe('you');
      expect(voice.decide(other(), 3)).toBe('not-you');
      expect(voice.decide(null, 3)).toBe('unsure'); // no print could be made: not waved through
      expect(voice.decide(you(), 3, { learn: false })).toBe('you');
    } finally {
      log.mockRestore();
    }
    const off = await setup({ enabled: false });
    await off.store.set(enrollFrom(all(3, you)));
    expect(off.voice.decide(other(), 3)).toBeUndefined(); // off: everyone, as before
    expect(off.voice.active()).toBeNull();
  });

  it('tests the voice without acting on it or learning from it - with Voice ID off, too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { voice, store } = await setup({ enabled: false });
      await expect(voice.test()).rejects.toThrow(/Set Voice ID up first/);
      await store.set(enrollFrom(all(6, you)));
      const before = store.current!;
      expect(voice.active()).toBeNull(); // off: no voiceprints wanted...
      expect(await voice.test()).toMatch(/only checked, never acted on/);
      expect(voice.active()).not.toBeNull(); // ...but a test wants them
      expect(voice.claim(you(), 3, 'what time is it')).toBe(true);
      expect(voice.claim(other(), 3, 'the TV')).toBe(true);
      expect(voice.claim(you(), 0.5, 'yes')).toBe(true);
      expect(voice.claim(null, 2, 'nothing came back')).toBe(true);
      const { testing, bars } = voice.status();
      expect(bars).toEqual({ accept: before.accept, reject: before.reject });
      const results = testing!.results;
      expect(results.map((r) => r.speaker)).toEqual(['unsure', 'unsure', 'not-you', 'you']); // newest first
      expect(results[3]).toMatchObject({ heard: 'what time is it', verdict: "That's you - Manuel would answer.", seconds: 3 });
      expect(results[3]!.score!).toBeGreaterThanOrEqual(before.accept);
      expect(results[3]!.models!.map((m) => m.name)).toEqual(['WeSpeaker v2', 'ResNet293', 'TitaNet']); // each model's own match
      expect(results[2]!.verdict).toBe('Not you - Manuel would ignore it.');
      expect(results[1]).toMatchObject({ score: expect.any(Number), why: expect.stringMatching(/Too short/) });
      expect(results[0]).toMatchObject({ score: null, verdict: expect.stringMatching(/hold the talk shortcut/), why: expect.stringMatching(/No voiceprint came back/) });
      expect(results[0]!.models).toBeUndefined();
      expect(store.current).toBe(before); // never learned from
      // A quiet minute ends the test, so Nova isn't left deaf to requests.
      await vi.advanceTimersByTimeAsync(59_000);
      expect(voice.status().testing).not.toBeNull();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(voice.status()).toMatchObject({ testing: null, message: expect.stringMatching(/quiet minute/) });
      expect(voice.claim(you(), 3, 'after')).toBe(false); // what's said goes to Nova again
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last few results of a test, and ends it for Done, setting up again, or forgetting', async () => {
    const { voice, store } = await setup({ enabled: true });
    await store.set(enrollFrom(all(4, you)));
    await voice.test();
    for (let i = 0; i < 12; i++) voice.claim(you(), 2.5, `turn ${i}`);
    expect(voice.status().testing!.results.map((r) => r.heard)).toEqual(['turn 11', 'turn 10', 'turn 9', 'turn 8', 'turn 7', 'turn 6', 'turn 5', 'turn 4']);
    voice.cancel(); // Done
    expect(voice.status().testing).toBeNull();
    await voice.test();
    await voice.start(); // setting up again ends the test
    expect(voice.status()).toMatchObject({ testing: null, enrolling: { step: 1 } });
    await expect(voice.test()).rejects.toThrow(/Finish setting up first/);
    voice.cancel();
    await voice.test();
    await voice.forget();
    expect(voice.status()).toMatchObject({ testing: null, bars: null, enrolled: false });
  });

  it("takes a short turn right after a clear one of the user's as theirs - for 20 seconds, never chained, never a clear no", async () => {
    let now = 1_000_000;
    const { voice, store } = await setup({ enabled: true, learning: false, now: () => now });
    await store.set(enrollFrom(all(6, you)));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(voice.decide(null, 0.4)).toBe('unsure'); // "yes", out of the blue: too little to tell
      expect(voice.decide(you(), 3)).toBe('you'); // "Manuel, quit Spotify"
      now += 6_000;
      expect(voice.decide(null, 0.4)).toBe('you'); // "yes": the user, carrying on
      expect(voice.decide(null, 3)).toBe('unsure'); // a long turn with no print is never waved through
      expect(voice.decide(other(), 1)).toBe('not-you'); // clearly someone else, even so
      now += 15_000; // 21 s after the clear one: the short one since didn't extend it
      expect(voice.decide(null, 0.4)).toBe('unsure');
      expect(voice.decide(you(), 3, { learn: false })).toBe('you'); // a glance while talking over Nova…
      now += 2_000;
      expect(voice.decide(null, 0.4)).toBe('unsure'); // …opens no window
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines).toContainEqual(expect.stringMatching(/\[voice-id\] \d\d:\d\d:\d\d you · 0\.4 s · short, 6 s after a clear one$/));
      expect(lines).toContainEqual(expect.stringMatching(/\[voice-id\] \d\d:\d\d:\d\d you 0\.\d\d \(WeSpeaker v2 0\.\d\d, ResNet293 0\.\d\d, TitaNet 0\.\d\d\) · 3\.0 s$/));
    } finally {
      log.mockRestore();
    }
  });

  it('knows the voice in the room: like the user minutes ago is them - never another voice, never chained, for ten minutes', async () => {
    let now = 5_000_000;
    const { voice, store } = await setup({ enabled: true, learning: false, now: () => now });
    await store.set(enrollFrom(all(6, you)));
    // Today, another microphone: the user sounds alike, not the same - between the bars.
    const mic = person(314)();
    const today = person(5); // the same voice as `you`, from the start of its sequence
    const here = () => blend(today(), mic, 1.4);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(voice.decide(here(), 3)).toBe('unsure');
      voice.confirmed(here(), 3, 'open slack'); // said once with the shortcut: that was them
      now += 5_000;
      expect(voice.decide(here(), 3)).toBe('you'); // like that, a moment ago
      expect(log.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringMatching(/you 0\.\d\d \(.*\) · 3\.0 s · sounds like you 5 s ago$/));
      expect(voice.decide(other(), 3)).toBe('not-you'); // another voice in the room is still another voice
      expect(voice.decide(blend(other(), mic, 1.4), 3)).not.toBe('you'); // …even through the same microphone
      expect(voice.decide(null, 0.4)).toBe('unsure'); // made sure of by the room, it opens no window for a "yes"
      now += 9 * 60_000; // just over nine minutes after the shortcut turn
      expect(voice.decide(here(), 3)).toBe('you');
      now += 60_000; // over ten: the room may have changed - and the turn a minute ago, placed by the room, didn't renew it
      expect(voice.decide(here(), 3)).toBe('unsure');
    } finally {
      log.mockRestore();
    }
  });

  it("keeps a recording of each turn, setup phrase and test - with what Voice ID made of it - when the user keeps them", async () => {
    const { voice, store, kept } = await setup({ enabled: true });
    const audio = new Int16Array(16_000);
    await voice.start();
    voice.enroll(you(), 3, 'a setup phrase', audio);
    voice.cancel();
    await store.set(enrollFrom(all(6, you)));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      voice.decide(other(), 2, { text: 'the tv', audio, overlapped: true });
      voice.decide(you(), 2, { learn: false, audio }); // a glance: not kept
      voice.confirmed(you(), 2, 'open slack', audio);
      await voice.test();
      voice.claim(you(), 2, 'testing', audio);
      voice.decide(you(), 2, { text: 'no audio' }); // nothing to keep
    } finally {
      log.mockRestore();
    }
    expect(kept.map((r) => [r.kind, r.text])).toEqual([
      ['setup', 'a setup phrase'],
      ['turn', 'the tv'],
      ['shortcut', 'open slack'],
      ['test', 'testing'],
    ]);
    expect(kept[0]).toMatchObject({ ok: false, why: expect.stringMatching(/too quiet/) });
    expect(kept[1]).toMatchObject({ speaker: 'not-you', score: expect.any(Number), overlapped: true, scores: { 'wespeaker-v2': expect.any(Number), 'wespeaker-resnet293': expect.any(Number), 'titanet-large': expect.any(Number) } });
    expect(kept[1]!.audio).toBe(audio);
  });

  it('turns itself off for any voice when the master keyword is said - until the user turns it back on', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nova-voice-'));
    const store = new VoiceprintStore(join(dir, 'voiceprint.json'), 'wespeaker-v2');
    const keyword = await new Keyword(join(dir, 'voiceid-keyword.json')).load();
    let enabled = true;
    const said: string[] = [];
    const voice = new VoiceId({ store, label: '', models: async () => models(dir), enabled: () => enabled, learning: () => false, name: () => 'Manuel', turnOn: async () => {}, changed: () => {}, keyword, onOverride: (rest) => void said.push(rest) });
    await voice.refresh();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(voice.unlock('pineapple express open safari')).toBeNull(); // no keyword yet
      await voice.setKeyword('pineapple express');
      expect(voice.unlock('pineapple express open safari')).toBeNull(); // no voiceprint: nothing to override
      await store.set(enrollFrom(all(4, you)));
      expect(voice.decide(other(), 3)).toBe('not-you');
      expect(voice.unlock('Manuel, pineapple express - open Safari')).toBe('open Safari');
      expect(said).toEqual(['open Safari']);
      expect(voice.overridden()).toBe(true);
      expect(voice.status().keyword).toEqual({ set: true, overriddenAt: expect.any(String) });
      expect(voice.decide(other(), 3)).toBe('anyone'); // any voice, from now on
      expect(voice.unlock('pineapple express')).toBeNull(); // already off
      await voice.restore();
      expect(voice.decide(other(), 3)).toBe('not-you');
      // Setting up again, or forgetting the voice, leaves nothing overridden.
      voice.unlock('pineapple express');
      await voice.forget();
      expect(voice.overridden()).toBe(false);
      enabled = false;
      await store.set(enrollFrom(all(4, you)));
      expect(voice.unlock('pineapple express')).toBeNull(); // Voice ID switched off: nothing to override
    } finally {
      log.mockRestore();
    }
  });

  it('matches the closest of the ways the user was heard, and learns from what they say with the shortcut', async () => {
    const { voice, store } = await setup({ enabled: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const room = person(41);
      const far = () => blend(you(), room(), 0.7); // the user from across the room: alike, not the same
      const set = enrollFrom([you(), you(), you(), you(), far(), far()], new Date(), ['normal', 'normal', 'normal', 'normal', 'far', 'far']);
      await store.set(set);
      const turn = far();
      for (const ear of EARS) expect(scoreOf(set, turn)!.ears[ear]).toBeGreaterThan(cosine(set.ears[ear]!.print, turn[ear]!)); // the far voiceprint is closer than the average
      // Said with the talk shortcut: the user's - learned from.
      voice.confirmed(you(), 3, 'open slack');
      expect(store.current!.learned).toBe(1);
      // An unsure turn, then the same said with the shortcut: both are learned from.
      const unsure = blend(you(), other(), 1.4);
      expect(voice.decide(unsure, 3, { text: 'manuel open the report' })).toBe('unsure');
      voice.confirmed(you(), 3, 'open the report');
      expect(store.current!.learned).toBe(3);
      // Something else said with the shortcut doesn't vouch for the unsure turn before it; clearly someone else teaches nothing.
      voice.decide(unsure, 3, { text: 'what is the weather' });
      voice.confirmed(you(), 3, 'play some music');
      expect(store.current!.learned).toBe(4);
      voice.confirmed(other(), 3, 'play some music');
      expect(store.current!.learned).toBe(4);
    } finally {
      log.mockRestore();
    }
  });

  it('forgets the voice entirely', async () => {
    const { voice, store } = await setup({ enabled: true });
    await store.set(enrollFrom(all(3, you)));
    await voice.forget();
    expect(store.current).toBeNull();
    expect(voice.status()).toMatchObject({ enrolled: false, on: false });
  });
});
