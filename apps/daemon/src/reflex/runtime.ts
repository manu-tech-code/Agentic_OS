import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fingerprint, ReflexEvaluationModel, StaticEmbedder, type Embedder, type HeadData, type LearnedExample, type SettingsSnapshot } from '@nova/core';
import { settingsFile } from '../config.ts';
import { DEFAULT_REFLEX_MODEL, isInstalled, readModelFiles, REFLEX_MODELS } from '../models/files.ts';

/** Loaded once: the model is 30 MB and never changes while Nova runs. */
const embedders = new Map<string, Embedder>();

/** Reflex's embedding model, once loaded - memory uses it too, to find related memories. */
export const reflexEmbedder = (name = DEFAULT_REFLEX_MODEL): Embedder | null => embedders.get(name) ?? null;

/** What Reflex learned from your confirmations, kept next to the settings file. */
export const learnedFile = () => join(dirname(settingsFile()), 'reflex-learned.json');

let learned: LearnedExample[] | null = null;
let saving: Promise<unknown> = Promise.resolve();

/** Reflex's trained classifier, kept next to the settings file with a fingerprint of what it learned from. */
export const classifierFile = () => join(dirname(settingsFile()), 'reflex-classifier.json');
/** Classifiers by training fingerprint: trained once per set of phrasings, however often settings reload Reflex. */
const classifiers = new Map<string, Promise<HeadData | null>>();

async function readClassifier(key: string): Promise<HeadData | null> {
  try {
    const saved = JSON.parse(await readFile(classifierFile(), 'utf8')) as { key?: string; head?: HeadData };
    return saved.key === key && saved.head ? saved.head : null;
  } catch {
    return null;
  }
}

async function saveClassifier(key: string, head: HeadData) {
  const file = classifierFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify({ key, head }), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

/**
 * The classifier for what this model learns from: saved from an earlier run, or trained now in
 * the background (a second or two, in slices, so Nova stays responsive). Until it's ready,
 * Reflex decides from its examples alone.
 */
function classifierFor(model: ReflexEvaluationModel): Promise<HeadData | null> {
  const key = model.trainingKey();
  let ready = classifiers.get(key);
  if (!ready) {
    ready = (async () => {
      const saved = await readClassifier(key);
      if (saved) return saved;
      const started = performance.now();
      const head = await model.train({ pause: () => new Promise((resolve) => setImmediate(resolve)) });
      console.log(`  [reflex] classifier trained on ${model.trainingExamples().length} phrasings in ${Math.round(performance.now() - started)} ms`);
      await saveClassifier(key, head).catch((e) => console.warn(`[reflex] can't save the classifier: ${(e as Error).message}`));
      return head;
    })().catch((e) => {
      console.warn(`[reflex] couldn't train the classifier: ${(e as Error).message}`);
      classifiers.delete(key);
      return null;
    });
    classifiers.set(key, ready);
  }
  return ready;
}

/** Unset is fine (it's optional); anything but a list of strings isn't - and would throw later, spread into `trainingExamples()`. */
const validMasked = (m: unknown): m is string[] | undefined => m === undefined || (Array.isArray(m) && m.every((x) => typeof x === 'string'));

async function readLearned(): Promise<LearnedExample[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(learnedFile(), 'utf8'));
    return Array.isArray(parsed)
      ? parsed.filter((e) => typeof e?.utterance === 'string' && typeof e?.question === 'string' && typeof e?.choice === 'string' && validMasked(e?.masked))
      : [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[reflex] can't read ${learnedFile()}: ${(e as Error).message}`);
    return [];
  }
}

function saveLearned(list: LearnedExample[]) {
  learned = list;
  saving = saving.then(async () => {
    const file = learnedFile();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }).catch((e) => console.warn(`[reflex] can't save what it learned: ${(e as Error).message}`));
  return saving;
}

export interface ReflexRuntime {
  model: ReflexEvaluationModel | null;
  status: SettingsSnapshot['reflex'];
  /** Resolves once the classifier weighs in (at once when it was saved before). */
  classifier: Promise<boolean>;
}

/** Reflex, ready to decide - or no model when its embedding model isn't installed (or won't load). */
export async function loadReflex(opts: { learn: boolean; name?: string }): Promise<ReflexRuntime> {
  const name = opts.name ?? DEFAULT_REFLEX_MODEL;
  const status = { model: name, label: REFLEX_MODELS[name]?.label ?? name, installed: false, learned: 0, phrasings: 0 };
  const none = { model: null, status, classifier: Promise.resolve(false) };
  if (!(await isInstalled(name))) return none;
  try {
    let embedder = embedders.get(name);
    if (!embedder) {
      embedder = StaticEmbedder.fromFiles(name, await readModelFiles(name));
      embedders.set(name, embedder);
    }
    learned ??= await readLearned();
    // The pinned revision and per-file checksums, not just the model's name (which never changes
    // on its own): a saved classifier trained on a since-changed model or reader must retrain.
    const spec = REFLEX_MODELS[name];
    const modelKey = spec ? `${name}@${fingerprint(JSON.stringify([spec.revision, spec.files]))}` : name;
    const model: ReflexEvaluationModel = new ReflexEvaluationModel({
      embedder,
      modelKey,
      learned,
      learn: opts.learn,
      onLearn: () => void saveLearned([...model.learned]),
    });
    const classifier = classifierFor(model).then((head) => {
      model.useHead(head);
      return model.trained;
    });
    return { model, status: { ...status, installed: true, learned: learned.length, phrasings: model.trainingExamples().length }, classifier };
  } catch (e) {
    console.warn(`[reflex] couldn't load ${name}: ${(e as Error).message}`);
    return none;
  }
}

/** Forget everything Reflex learned: drops the classifier trained on it too, and retrains (in the background - it decides from its examples alone meanwhile). */
export function forgetLearned(model: ReflexEvaluationModel | null) {
  model?.forget();
  if (model) void classifierFor(model).then((head) => model.useHead(head));
  return saveLearned([]);
}
