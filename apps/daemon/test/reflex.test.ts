import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentSkills, buildQuestions, builtinSkills, initiativeSkills, memorySkills, ReflexEvaluationModel, StaticEmbedder, trustSkills } from '@nova/core';
import { EVAL_AGENTS, EVAL_APPS, EVAL_PROJECTS, REPLIES, SET_A, SET_B, SET_C, SET_D, SET_E } from '../src/reflex/evalSet.ts';
import { DEFAULT_REFLEX_MODEL, downloadModel, isInstalled, modelsDir, readModelFiles, REFLEX_MODELS } from '../src/models/files.ts';

describe('Reflex model files', () => {
  it('pins every model to a revision and checksums', () => {
    for (const spec of Object.values(REFLEX_MODELS)) {
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
});

describe.skipIf(!installed)('Reflex with its model', () => {
  it('decides intents, names and replies accurately in about a millisecond, on phrasings it never learned from', async () => {
    const all = [...SET_A, ...SET_B, ...SET_C, ...SET_D, ...SET_E];
    // The test phrasings are held out of everything it learns from, as in `npm run reflex:eval`.
    const holdOut = { texts: all.map((c) => c.u).filter((u) => u.split(/\s+/).length > 2), names: [...EVAL_APPS, ...EVAL_AGENTS.map((a) => a.name), ...EVAL_PROJECTS] };
    const reflex = new ReflexEvaluationModel({ embedder: StaticEmbedder.fromFiles(DEFAULT_REFLEX_MODEL, await readModelFiles(DEFAULT_REFLEX_MODEL)), learn: false, holdOut });
    await reflex.train();
    const host = { agents: EVAL_AGENTS, projects: EVAL_PROJECTS } as never;
    const decide = async (u: string, state: Record<string, unknown> = {}) =>
      (await reflex.doEvaluate({ state: { utterance: u, wakeWordUsed: true, canThink: true, ...state }, questions: buildQuestions([...builtinSkills, ...agentSkills, ...memorySkills, ...initiativeSkills, ...trustSkills], EVAL_APPS, u, host) } as never))
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
    expect(right / cases.length).toBeGreaterThan(0.84);
    expect(wrongAction / cases.length).toBeLessThan(0.05);
    expect(addressed / cases.length).toBeGreaterThan(0.9);
    expect(apps / withApp.length).toBeGreaterThan(0.95);
    expect(replies / REPLIES.length).toBeGreaterThan(0.9);
    expect(times[Math.floor(times.length * 0.9)]).toBeLessThan(5);
  }, 60_000);

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
});
