import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { consistent, cosine, enrollFrom, judge, learnFrom, VoiceId, VoiceprintStore, type StoredVoiceprint } from '../src/hearing/voiceid.ts';

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

  it('needs its model to set up, then learns the voice from six phrases and switches itself on', async () => {
    const without = await setup({ model: false });
    await expect(without.voice.start()).rejects.toThrow(/needs its model/);

    const { voice, turnOn, store } = await setup();
    expect(voice.active()).toBeNull(); // nothing to check yet
    expect(await voice.start()).toMatch(/Manuel, what's on my calendar today/);
    expect(voice.active()).not.toBeNull(); // setting up: prints are wanted
    expect(voice.enroll(you(), 0.6, 'too short')).toBe(true);
    expect(voice.status()).toMatchObject({ enrolling: { step: 1, of: 6 }, message: expect.stringMatching(/too short/) });
    voice.enroll(you(), 2.5, 'one');
    expect(voice.enroll(other(), 2.5, 'someone else')).toBe(true);
    expect(voice.status()).toMatchObject({ enrolling: { step: 2 }, message: expect.stringMatching(/didn't sound like the others/) });
    for (let i = 0; i < 5; i++) voice.enroll(you(), 2.5, 'phrase');
    await vi.waitFor(() => expect(turnOn).toHaveBeenCalled());
    expect(store.current).toMatchObject({ enrolled: 6 });
    expect(voice.status()).toMatchObject({ enrolled: true, on: true, enrolling: null });
    expect(voice.enroll(you(), 2.5, 'after')).toBe(false); // done: turns go to Nova again
  });

  it('starts over from the phrases that agree when the first one was the odd one out', async () => {
    const { voice, turnOn, store } = await setup();
    await voice.start();
    voice.enroll(other(), 2.5, 'the TV, first'); // taken: nothing to compare it with yet
    voice.enroll(you(), 2.5, 'the user');
    expect(voice.status()).toMatchObject({ enrolling: { step: 2 }, message: expect.stringMatching(/didn't sound like the others/) });
    voice.enroll(you(), 2.5, 'the user again'); // alike, and both unlike the first: the first goes
    expect(voice.status()).toMatchObject({ enrolling: { step: 3 } });
    expect(voice.status().message).toBeUndefined();
    for (let i = 0; i < 4; i++) voice.enroll(you(), 2.5, 'phrase');
    await vi.waitFor(() => expect(turnOn).toHaveBeenCalled());
    expect(cosine(store.current!.print, you())).toBeGreaterThan(store.current!.accept);
    expect(cosine(store.current!.print, other())).toBeLessThan(store.current!.reject);
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

  it('forgets the voice entirely', async () => {
    const { voice, store } = await setup({ enabled: true });
    await store.set(enrollFrom([you(), you(), you()], 'wespeaker-v2'));
    await voice.forget();
    expect(store.current).toBeNull();
    expect(voice.status()).toMatchObject({ enrolled: false, on: false });
  });
});
