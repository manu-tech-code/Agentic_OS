import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { barsFrom, consistent, cosine, enrollFrom, judge, leaveOneOut, learnFrom, migrateVoiceprint, scoreOf, VoiceId, VoiceprintStore, type StoredVoiceprint } from '../src/hearing/voiceid.ts';
import { Keyword } from '../src/hearing/keyword.ts';

/** Voiceprints for tests: a person's is their direction in 256-d, plus a little noise each time they speak. */
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
  const base = unit(Array.from({ length: 256 }, r));
  return (noise = 0.35) => unit(base.map((x) => x + noise * r() * 0.12));
}

describe('voiceprints, in code', () => {
  const you = person(1);
  const other = person(99);

  it("learns a voice from its setup phrases, with thresholds from how alike they came out", () => {
    const voice = enrollFrom([you(), you(), you(), you(), you(), you()], 'wespeaker-v2');
    expect(voice.accept).toBeGreaterThanOrEqual(0.5);
    expect(voice.accept).toBeLessThanOrEqual(0.75);
    expect(voice.reject).toBeLessThan(voice.accept);
    expect(cosine(voice.print, you())).toBeGreaterThan(voice.accept);
    expect(() => enrollFrom([you(), you()], 'wespeaker-v2')).toThrow(/Too few/);
  });

  it("tells the user from someone else - and says it can't tell from too little speech", () => {
    const voice = enrollFrom([you(), you(), you(), you(), you(), you()], 'wespeaker-v2');
    expect(judge(voice, you(), 3).speaker).toBe('you');
    expect(judge(voice, other(), 3).speaker).toBe('not-you');
    expect(judge(voice, you(), 0.5).speaker).toBe('unsure'); // under MIN_SECONDS
    // A short turn needs a clearer match than a long one.
    const borderline = { ...voice, accept: cosine(voice.print, you()) - 0.02 };
    const print = unit(voice.print.map((x, i) => x + (i % 7 === 0 ? 0.001 : 0)));
    expect(judge({ ...borderline, accept: cosine(voice.print, print) - 0.02 }, print, 1).speaker).toBe('unsure');
    expect(judge({ ...borderline, accept: cosine(voice.print, print) - 0.02 }, print, 3).speaker).toBe('you');
  });

  it('sets the bars from each setup phrase against the others - never flattered by an average that includes it', () => {
    const prints = [you(0.9), you(0.9), you(0.9), you(0.9), you(0.9), you(0.9)];
    const avg = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
    const flattering = avg(prints.map((p) => cosine(p, unit(prints[0]!.map((_, i) => prints.reduce((a, q) => a + q[i]!, 0))))));
    expect(avg(leaveOneOut(prints))).toBeLessThan(flattering);
    const voice = enrollFrom(prints, 'wespeaker-v2');
    expect(voice).toMatchObject({ version: 2, enrolled: 6 });
    expect(voice.phrases).toHaveLength(6); // kept, to set the bars again or add phrases later
    // Well under how alike the phrases were, and never above 0.62 or below what tells people apart.
    expect(barsFrom([0.9])).toEqual({ accept: 0.62, reject: 0.4 });
    expect(barsFrom([0.7]).accept).toBeCloseTo(0.5);
    expect(barsFrom([0.4])).toEqual({ accept: 0.45, reject: 0.25 });
  });

  it('sets the bars of a voiceprint set up the old way as the new way would have, without setting up again', () => {
    // Set up with six phrases, whose likeness to their own average came out at 0.837: "you" was 0.687, "not you" 0.45.
    const old: StoredVoiceprint = { version: 1, model: 'wespeaker-v2', print: [1], accept: 0.6867, reject: 0.45, enrolled: 6, learned: 0, updated: '' };
    const now = migrateVoiceprint(old);
    expect(now.version).toBe(2);
    expect(now.accept).toBeCloseTo(0.559, 2); // phrases alike by 0.64 each: one against the others, 0.76
    expect(now.reject).toBeCloseTo(0.359, 2);
    expect(migrateVoiceprint(now)).toBe(now); // already the new way
  });

  it('keeps a phrase out of the setup when it sounds like someone else', () => {
    expect(consistent([], other())).toBe(true);
    expect(consistent([you(), you()], you())).toBe(true);
    expect(consistent([you(), you()], other())).toBe(false);
  });

  it('learns only from turns that were clearly the user, and long enough - a little at a time', () => {
    const voice = enrollFrom([you(), you(), you(), you(), you(), you()], 'wespeaker-v2');
    const turn = you();
    const score = cosine(voice.print, turn);
    expect(learnFrom(voice, turn, score, 1)).toBeNull(); // too short
    expect(learnFrom(voice, turn, voice.accept, 3)).toBeNull(); // not clear enough
    const next = learnFrom(voice, turn, Math.max(score, voice.accept + 0.06), 3)!;
    expect(next.learned).toBe(1);
    expect(cosine(next.print, turn)).toBeGreaterThan(cosine(voice.print, turn));
    expect(cosine(next.print, voice.print)).toBeGreaterThan(0.99); // a little at a time
  });
});

describe('the voiceprint on disk', () => {
  const you = person(3);
  const voice = (): StoredVoiceprint => enrollFrom([you(), you(), you(), you()], 'wespeaker-v2');

  it('is readable by the user alone, only for its own model, and gone when forgotten', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nova-voice-'));
    const file = join(dir, 'voiceprint.json');
    const store = new VoiceprintStore(file, 'wespeaker-v2');
    expect(await store.load()).toBeNull();
    await store.set(voice());
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await new VoiceprintStore(file, 'wespeaker-v2').load()).toMatchObject({ model: 'wespeaker-v2', enrolled: 4 });
    expect(await new VoiceprintStore(file, 'another-model').load()).toBeNull(); // prints of another model don't compare
    await writeFile(file, '{ broken');
    expect(await new VoiceprintStore(file, 'wespeaker-v2').load()).toBeNull();
    await store.forget();
    await expect(stat(file)).rejects.toThrow();
  });

  it('sets the bars of an old voiceprint again once, as it loads, and keeps them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nova-voice-'));
    const file = join(dir, 'voiceprint.json');
    await writeFile(file, JSON.stringify({ version: 1, model: 'wespeaker-v2', print: [0.6, 0.8], accept: 0.6867, reject: 0.45, enrolled: 6, learned: 0, updated: '' }));
    const loaded = await new VoiceprintStore(file, 'wespeaker-v2').load();
    expect(loaded).toMatchObject({ version: 2, accept: expect.closeTo(0.559, 2) });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 2, print: [0.6, 0.8] });
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

  async function setup(opts: { enabled?: boolean; model?: boolean } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'nova-voice-'));
    const store = new VoiceprintStore(join(dir, 'voiceprint.json'), 'wespeaker-v2');
    let enabled = opts.enabled ?? false;
    const turnOn = vi.fn(async () => void (enabled = true));
    const voice = new VoiceId({
      store,
      model: 'wespeaker-v2',
      label: 'WeSpeaker v2 · 8 MB',
      modelDir: async () => (opts.model === false ? null : dir),
      enabled: () => enabled,
      learning: () => true,
      name: () => 'Manuel',
      turnOn,
      changed: () => {},
    });
    await voice.refresh();
    return { voice, store, turnOn, dir };
  }

  /** Says each collecting step of the setup (as usual, a step back, quietly, talking freely) in the same voice. */
  const collect = (voice: VoiceId, say: () => number[], steps = 11) => {
    for (let i = 0; i < steps; i++) expect(voice.enroll(say(), i === steps - 1 ? 16 : 3, 'phrase')).toBe(true);
  };

  it('needs its model, then learns the voice as usual, a step back, quietly and talking - checks it - and switches itself on', async () => {
    const without = await setup({ model: false });
    await expect(without.voice.start()).rejects.toThrow(/needs its model/);

    const { voice, turnOn, store } = await setup();
    expect(voice.active()).toBeNull(); // nothing to check yet
    expect(await voice.start()).toMatch(/Manuel, what's on my calendar today/);
    expect(voice.active()).not.toBeNull(); // setting up: prints are wanted
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
    expect(store.current).toMatchObject({ enrolled: 11, conditions: ['normal', 'normal', 'normal', 'normal', 'normal', 'normal', 'far', 'far', 'quiet', 'quiet', 'free'] });
    expect(store.current!.centroids!.map((c) => c.condition)).toEqual(['normal', 'far', 'quiet', 'free']);
    expect(voice.status()).toMatchObject({ enrolled: true, on: true, enrolling: null, improvable: true, message: expect.stringMatching(/last 3 checks all came out as you/) });
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
    // Like the user, but not enough (a match around 0.58): learned from, and the count starts again.
    const halfway = (seed: number) => unit(you().map((x, i) => x + 1.4 * person(seed)()[i]!));
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
    expect(cosine(store.current!.print, you())).toBeGreaterThan(store.current!.accept);
    expect(cosine(store.current!.print, other())).toBeLessThan(store.current!.reject);
  });

  it('improves the voice with a few more phrases, kept with the ones before - no setting up again', async () => {
    const { voice, store } = await setup({ enabled: true });
    await expect(voice.improve()).rejects.toThrow(/set it up again/); // nothing kept to add to
    await store.set({ ...enrollFrom([you(), you(), you(), you(), you(), you()], 'wespeaker-v2'), learned: 4 });
    expect(await voice.improve()).toMatch(/read me my last message/);
    expect(voice.status().enrolling).toMatchObject({ of: 5, phase: 'collect' });
    collect(voice, () => you(), 5);
    for (let i = 0; i < 3; i++) voice.enroll(you(), 3, 'check');
    await vi.waitFor(() => expect(store.current!.enrolled).toBe(11));
    expect(store.current).toMatchObject({ learned: 4, conditions: expect.arrayContaining(['far', 'free']) });
  });

  it("decides whose each turn is only when it's on - and learns only from the user", async () => {
    const { voice, store } = await setup({ enabled: true });
    await store.set(enrollFrom([you(), you(), you(), you(), you(), you()], 'wespeaker-v2'));
    expect(voice.decide(you(), 3)).toBe('you');
    expect(voice.decide(other(), 3)).toBe('not-you');
    expect(voice.decide(null, 3)).toBe('unsure'); // no print could be made: not waved through
    expect(voice.decide(you(), 3, { learn: false })).toBe('you');
    const off = await setup({ enabled: false });
    await off.store.set(enrollFrom([you(), you(), you()], 'wespeaker-v2'));
    expect(off.voice.decide(other(), 3)).toBeUndefined(); // off: everyone, as before
    expect(off.voice.active()).toBeNull();
  });

  it('tests the voice without acting on it or learning from it - with Voice ID off, too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { voice, store } = await setup({ enabled: false });
      await expect(voice.test()).rejects.toThrow(/Set Voice ID up first/);
      await store.set(enrollFrom([you(), you(), you(), you(), you(), you()], 'wespeaker-v2'));
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
      expect(results[2]!.verdict).toBe('Not you - Manuel would ignore it.');
      expect(results[1]).toMatchObject({ score: expect.any(Number), why: expect.stringMatching(/Too short/) });
      expect(results[0]).toMatchObject({ score: null, verdict: expect.stringMatching(/hold the talk shortcut/), why: expect.stringMatching(/No voiceprint came back/) });
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
    await store.set(enrollFrom([you(), you(), you(), you()], 'wespeaker-v2'));
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

  it('takes a short turn right after a clear one of the user\'s as theirs - for 20 seconds, never chained, never a clear no', async () => {
    let now = 1_000_000;
    const dir = await mkdtemp(join(tmpdir(), 'nova-voice-'));
    const store = new VoiceprintStore(join(dir, 'voiceprint.json'), 'wespeaker-v2');
    const voice = new VoiceId({ store, model: 'wespeaker-v2', label: '', modelDir: async () => dir, enabled: () => true, learning: () => false, name: () => 'Manuel', turnOn: async () => {}, changed: () => {}, now: () => now });
    await voice.refresh();
    await store.set(enrollFrom([you(), you(), you(), you(), you(), you()], 'wespeaker-v2'));
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
      expect(log.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringMatching(/\[voice-id\] you · 0\.4 s · short, 6 s after a clear one/));
      expect(log.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringMatching(/\[voice-id\] you 0\.9\d · 3\.0 s$/));
    } finally {
      log.mockRestore();
    }
  });

  it('turns itself off for any voice when the master keyword is said - until the user turns it back on', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nova-voice-'));
    const store = new VoiceprintStore(join(dir, 'voiceprint.json'), 'wespeaker-v2');
    const keyword = await new Keyword(join(dir, 'voiceid-keyword.json')).load();
    let enabled = true;
    const said: string[] = [];
    const voice = new VoiceId({ store, model: 'wespeaker-v2', label: '', modelDir: async () => dir, enabled: () => enabled, learning: () => false, name: () => 'Manuel', turnOn: async () => {}, changed: () => {}, keyword, onOverride: (rest) => void said.push(rest) });
    await voice.refresh();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(voice.unlock('pineapple express open safari')).toBeNull(); // no keyword yet
      await voice.setKeyword('pineapple express');
      expect(voice.unlock('pineapple express open safari')).toBeNull(); // no voiceprint: nothing to override
      await store.set(enrollFrom([you(), you(), you(), you()], 'wespeaker-v2'));
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
      await store.set(enrollFrom([you(), you(), you(), you()], 'wespeaker-v2'));
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
      const far = () => unit(you().map((x, i) => x + 0.7 * room()[i]!)); // the user from across the room: alike, not the same
      const set = enrollFrom([you(), you(), you(), you(), far(), far()], 'wespeaker-v2', new Date(), ['normal', 'normal', 'normal', 'normal', 'far', 'far']);
      await store.set(set);
      const turn = far();
      expect(scoreOf(set, turn)).toBeGreaterThan(cosine(set.print, turn)); // the far voiceprint is closer than the average
      // Said with the talk shortcut: the user's - learned from.
      voice.confirmed(you(), 3, 'open slack');
      expect(store.current!.learned).toBe(1);
      // An unsure turn, then the same said with the shortcut: both are learned from.
      const unsure = unit(you().map((x, i) => x + 1.4 * other()[i]!));
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
    await store.set(enrollFrom([you(), you(), you()], 'wespeaker-v2'));
    await voice.forget();
    expect(store.current).toBeNull();
    expect(voice.status()).toMatchObject({ enrolled: false, on: false });
  });
});
