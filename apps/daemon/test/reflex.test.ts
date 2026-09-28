import { mkdtempSync, readFileSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentSkills, buildQuestions, builtinSkills, handsSkills, initiativeSkills, memorySkills, ReflexEvaluationModel, StaticEmbedder, trustSkills } from '@nova/core';
import { EVAL_AGENTS, EVAL_APPS, EVAL_PROJECTS, REPLIES, SET_A, SET_B, SET_C, SET_D, SET_E } from '../src/reflex/evalSet.ts';
import { DEFAULT_REFLEX_MODEL, downloadModel, isInstalled, modelsDir, readModelFiles, REFLEX_MODELS, SPEECH_MODEL } from '../src/models/files.ts';
import { sentenceEncoder } from '../src/reflex/sentences.ts';

describe('Reflex model files', () => {
  it('pins every model to a revision and checksums', () => {
    for (const spec of Object.values(REFLEX_MODELS)) {
      if (spec.source === 'github-release') {
        // A release's tag can move: each file's SHA-256 is what pins it.
        expect(spec.revision).toMatch(/\S/);
        for (const check of Object.values(spec.files)) expect(check.sha256).toMatch(/^[0-9a-f]{64}$/);
        continue;
      }
      expect(spec.revision).toMatch(/^[0-9a-f]{40}$/);
      for (const check of Object.values(spec.files)) expect(check.sha256 ?? check.gitSha1).toMatch(/^[0-9a-f]{40,64}$/);
    }
  });

  it("knows when a model isn't installed", async () => {
    expect(await isInstalled(DEFAULT_REFLEX_MODEL, mkdtempSync(join(tmpdir(), 'nova-models-')))).toBe(false);
    expect(await isInstalled('no-such-model')).toBe(false);
  });
});

// With the real model (after `npm run reflex:download`): accurate and fast on phrasings it wasn't built from.
const installed = await isInstalled(DEFAULT_REFLEX_MODEL);

describe('downloading a model', () => {
  afterEach(() => vi.unstubAllGlobals());
  const serve = (bytes: (file: string) => Uint8Array) =>
    vi.stubGlobal('fetch', async (url: string) => new Response(bytes(url.split('/').at(-1)!) as BodyInit, { status: 200 }));

  it('refuses files that fail their checksum, and saves nothing', async () => {
    serve(() => new Uint8Array(202));
    const dir = mkdtempSync(join(tmpdir(), 'nova-models-'));
    await expect(downloadModel(DEFAULT_REFLEX_MODEL, { dir })).rejects.toThrow(/checksum/);
    expect(await isInstalled(DEFAULT_REFLEX_MODEL, dir)).toBe(false);
  });

  it('fetches a file kept in a GitHub repository from its pinned commit, by its path there', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => (urls.push(url), new Response(new Uint8Array(10) as BodyInit, { status: 200 })));
    const dir = mkdtempSync(join(tmpdir(), 'nova-models-'));
    await expect(downloadModel(SPEECH_MODEL, { dir })).rejects.toThrow(/checksum/);
    expect(urls).toEqual([`https://raw.githubusercontent.com/snakers4/silero-vad/${REFLEX_MODELS[SPEECH_MODEL]!.revision}/src/silero_vad/data/silero_vad.onnx`]);
  });

  it.skipIf(!installed)('saves verified files from the pinned revision', async () => {
    const urls: string[] = [];
    serve((file) => new Uint8Array(readFileSync(join(modelsDir(), DEFAULT_REFLEX_MODEL, file))));
    const served = fetch;
    vi.stubGlobal('fetch', (url: string) => (urls.push(url), served(url)));
    const dir = mkdtempSync(join(tmpdir(), 'nova-models-'));
    await downloadModel(DEFAULT_REFLEX_MODEL, { dir });
    expect(await isInstalled(DEFAULT_REFLEX_MODEL, dir)).toBe(true);
    expect(urls.every((u) => u.includes(`/resolve/${REFLEX_MODELS[DEFAULT_REFLEX_MODEL]!.revision}/`))).toBe(true);
  });

  it('stops downloading (and rejects) if the server sends more bytes than expected, rather than writing it all anyway', async () => {
    const fakeName = '__oversized_test_model__';
    (REFLEX_MODELS as Record<string, (typeof REFLEX_MODELS)[string]>)[fakeName] = {
      label: 'test',
      repo: 'test/test',
      revision: '0'.repeat(40),
      license: 'MIT',
      files: { 'file.bin': { size: 100, sha256: '0'.repeat(64) } },
    };
    try {
      serve(() => new Uint8Array(500)); // far more than the declared 100 bytes
      const dir = mkdtempSync(join(tmpdir(), 'nova-models-'));
      await expect(downloadModel(fakeName, { dir })).rejects.toThrow(/bigger than expected/);
      expect(await isInstalled(fakeName, dir)).toBe(false); // nothing left half-written behind
    } finally {
      delete (REFLEX_MODELS as Record<string, unknown>)[fakeName];
    }
  });

  // Root ignores the permission bits this test relies on to force a write error.
  it.skipIf(process.getuid?.() === 0)("doesn't crash on a disk-write error (no listener for the write stream's 'error' event used to be fatal) - it just rejects", async () => {
    serve(() => new Uint8Array(202));
    const dir = mkdtempSync(join(tmpdir(), 'nova-models-'));
    const target = join(dir, DEFAULT_REFLEX_MODEL);
    await mkdir(target, { recursive: true });
    await chmod(target, 0o500); // read + execute only: creating a file inside it fails (EACCES)
    try {
      await expect(downloadModel(DEFAULT_REFLEX_MODEL, { dir })).rejects.toThrow();
    } finally {
      await chmod(target, 0o700); // restore, so the temp dir can be cleaned up
    }
  });
});

describe.skipIf(!installed)('Reflex with its model', () => {
  it('decides intents, names and replies accurately in about a millisecond, on phrasings it never learned from', async () => {
    const all = [...SET_A, ...SET_B, ...SET_C, ...SET_D, ...SET_E];
    // The test phrasings are held out of everything it learns from, as in `npm run reflex:eval` -
    // bar one- and two-word replies like "yes" or "stop" (any system knows those), but not a
    // short phrasing for some other intent ("time", "settings"), which still needs holding out.
    const replyIntents = new Set(['confirm_yes', 'confirm_no', 'stop']);
    const short = (u: string) => u.split(/\s+/).length <= 2;
    const holdOut = {
      texts: [...all.filter((c) => !short(c.u) || !replyIntents.has(c.intent)).map((c) => c.u), ...REPLIES.map((r) => r.u).filter((u) => !short(u))],
      names: [...EVAL_APPS, ...EVAL_AGENTS.map((a) => a.name), ...EVAL_PROJECTS],
    };
    // As Nova runs it: with its sentence model, when that's installed.
    const sentences = (await sentenceEncoder()) ?? undefined;
    const reflex = new ReflexEvaluationModel({ embedder: StaticEmbedder.fromFiles(DEFAULT_REFLEX_MODEL, await readModelFiles(DEFAULT_REFLEX_MODEL)), learn: false, holdOut, sentences });
    await reflex.train();
    const host = { agents: EVAL_AGENTS, projects: EVAL_PROJECTS } as never;
    const decide = async (u: string, state: Record<string, unknown> = {}) =>
      (await reflex.doEvaluate({ state: { utterance: u, wakeWordUsed: true, canThink: true, ...state }, questions: buildQuestions([...builtinSkills, ...agentSkills, ...memorySkills, ...initiativeSkills, ...trustSkills, ...handsSkills], EVAL_APPS, u, host) } as never))
        .answers as Record<string, any>;

    // The held-out sets: C, and E (written by an agent that never saw Reflex's data).
    const cases = [...SET_C, ...SET_E];
    const brainy = (i: string) => i === 'chat' || i === 'other';
    let right = 0;
    let wrongAction = 0;
    let addressed = 0;
    let apps = 0;
    const withApp = cases.filter((c) => c.app);
    const times: number[] = [];
    for (const c of cases) {
      const t0 = performance.now();
      const a = await decide(c.u);
      times.push(performance.now() - t0);
      const got = a.intent.choice;
      if (got === c.intent || (brainy(got) && brainy(c.intent))) right++;
      else if (!brainy(got)) wrongAction++;
      if (c.app && a.app?.choice === c.app) apps++;
      if (((await decide(c.u, { wakeWordUsed: false })).addressed.probability >= 0.5) === (c.intent !== 'other')) addressed++;
    }
    let replies = 0;
    for (const r of REPLIES) {
      const choice = (await decide(r.u, { wakeWordUsed: false, awaitingConfirmationFor: 'quit_app' })).intent.choice;
      if (r.yes ? choice === 'confirm_yes' : choice === 'confirm_no' || choice === 'stop') replies++;
    }
    times.sort((a, b) => a - b);
    // Honest numbers, now that holdout also catches near-copies (filler words) and short non-reply
    // phrasings (see model.ts's heldOutCheck and this file's holdOut above): lower than the 0.84 this
    // used to require, when some of what it measured against wasn't fully held out after all.
    expect(right / cases.length).toBeGreaterThan(0.8);
    expect(wrongAction / cases.length).toBeLessThan(0.05);
    expect(addressed / cases.length).toBeGreaterThan(0.9);
    expect(apps / withApp.length).toBeGreaterThan(0.95);
    expect(replies / REPLIES.length).toBeGreaterThan(0.9);
    expect(times[Math.floor(times.length * 0.9)]).toBeLessThan(sentences ? 8 : 5);
  }, 180_000);

  it('trains its classifier in the background once, and keeps it', async () => {
    process.env.NOVA_SETTINGS_FILE = join(mkdtempSync(join(tmpdir(), 'nova-settings-')), 'settings.json');
    const { classifierFile, loadReflex } = await import('../src/reflex/runtime.ts');
    const first = await loadReflex({ learn: false });
    expect(first.model?.trained).toBe(false); // deciding from examples while it trains
    expect(await first.classifier).toBe(true);
    const saved = JSON.parse(readFileSync(classifierFile(), 'utf8'));
    expect(saved.key).toBe(first.model!.trainingKey());
    expect(first.status.phrasings).toBeGreaterThan(5000);
    const again = await loadReflex({ learn: false });
    expect(await again.classifier).toBe(true); // the same training, not a second one
  }, 60_000);

  it('drops learned examples with a malformed \'masked\' field instead of leaving the classifier permanently untrained', async () => {
    const settingsDir = mkdtempSync(join(tmpdir(), 'nova-settings-'));
    process.env.NOVA_SETTINGS_FILE = join(settingsDir, 'settings.json');
    vi.resetModules(); // runtime.ts caches `learned` and the trained classifier at module scope, keyed by nothing but this env var
    const { learnedFile, loadReflex } = await import('../src/reflex/runtime.ts');
    const { writeFile } = await import('node:fs/promises');
    const good = { utterance: 'abracadabra', question: 'intent', choice: 'tell_time', masked: ['abracadabra'] };
    const badString = { utterance: 'x', question: 'intent', choice: 'chat', masked: 'not an array' }; // would spread into characters
    const badNumber = { utterance: 'y', question: 'intent', choice: 'chat', masked: 42 }; // would throw spreading it
    const noMasked = { utterance: 'z', question: 'intent', choice: 'chat' }; // masked is optional - this is fine
    await writeFile(learnedFile(), JSON.stringify([good, badString, badNumber, noMasked]));
    const { model, status, classifier } = await loadReflex({ learn: true });
    expect(status.learned).toBe(2); // only `good` and `noMasked` are valid
    expect(model?.learned.map((e) => e.utterance).sort()).toEqual(['abracadabra', 'z']);
    expect(await classifier).toBe(true); // training didn't throw on the bad entries and silently fail
  }, 60_000);

  it('drops the classifier immediately when forgetting, and retrains it in the background', async () => {
    process.env.NOVA_SETTINGS_FILE = join(mkdtempSync(join(tmpdir(), 'nova-settings-')), 'settings.json');
    vi.resetModules(); // a fresh module: an earlier test's in-memory classifier cache mustn't bleed in here
    const { forgetLearned, loadReflex } = await import('../src/reflex/runtime.ts');
    const first = await loadReflex({ learn: true });
    await first.classifier;
    expect(first.model?.trained).toBe(true);
    first.model!.learn({ utterance: 'abracadabra', question: 'intent', choice: 'tell_time' });
    await forgetLearned(first.model);
    // (`ReflexEvaluationModel.forget()` dropping the head synchronously, so it's never left deciding
    // from a classifier trained on what was just forgotten, is unit-tested directly in packages/core.)
    // Retrains in the background rather than being left permanently without a classifier (with the sentence
    // model, reading every phrasing again takes a while).
    const start = Date.now();
    while (!first.model?.trained && Date.now() - start < 120_000) await new Promise((r) => setTimeout(r, 200));
    expect(first.model?.trained).toBe(true);
  }, 180_000);
});
