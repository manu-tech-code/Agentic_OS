import { seeded } from './grammar.ts';

/**
 * Reflex's classifier: a softmax layer over meaning vectors, trained on thousands of phrasings
 * so it learns how much each word says about each intent, instead of looking examples up one
 * at a time. Its opinion is combined with the closest-example search. Pure TypeScript: it
 * trains in a couple of seconds and answers in microseconds.
 */

/**
 * Bump when the inputs or the training change in a way `ReflexEvaluationModel.trainingKey()`
 * can't already tell apart on its own (e.g. this file's feature extraction or training math),
 * so saved classifiers get retrained. A changed embedding model or `DEFAULT_TRAIN_OPTIONS`
 * doesn't need a bump: the key already covers those.
 */
export const HEAD_VERSION = 2;

export interface HeadData {
  version: number;
  classes: string[];
  dim: number;
  /** One row of `dim` weights per class. */
  weights: number[];
  bias: number[];
}

export interface TrainOptions {
  epochs?: number;
  batch?: number;
  rate?: number;
  /** Weight decay, which keeps the classifier from leaning on rare words. */
  l2?: number;
  seed?: number;
  /** Awaited now and then, so a server stays responsive while it trains. */
  pause?: () => Promise<void>;
}

/** `trainHead`'s defaults, named so a cache key can include them (see `ReflexEvaluationModel.trainingKey`). */
export const DEFAULT_TRAIN_OPTIONS: Required<Omit<TrainOptions, 'pause'>> = { epochs: 12, batch: 32, rate: 0.02, l2: 1e-5, seed: 7 };

export class ReflexHead {
  readonly classes: string[];
  readonly dim: number;
  private readonly index: Map<string, number>;
  private readonly w: Float32Array;
  private readonly b: Float32Array;

  constructor(readonly data: HeadData) {
    if (data.weights.length !== data.classes.length * data.dim || data.bias.length !== data.classes.length) throw new Error('Malformed Reflex classifier.');
    this.classes = data.classes;
    this.dim = data.dim;
    this.index = new Map(data.classes.map((c, i) => [c, i]));
    this.w = Float32Array.from(data.weights);
    this.b = Float32Array.from(data.bias);
  }

  has(option: string) {
    return this.index.has(option);
  }

  /**
   * Log-probabilities for `options`, from the classes it knows among them (the others get
   * `null`): the softmax is over the options actually on offer.
   */
  logProbs(x: Float32Array, options: string[]): (number | null)[] {
    const rows = options.map((o) => this.index.get(o) ?? -1);
    const logits = rows.map((r) => (r < 0 ? -Infinity : this.logit(x, r)));
    const max = Math.max(...logits);
    if (max === -Infinity) return options.map(() => null);
    const norm = Math.log(logits.reduce((s, l) => s + (l === -Infinity ? 0 : Math.exp(l - max)), 0)) + max;
    return logits.map((l) => (l === -Infinity ? null : l - norm));
  }

  private logit(x: Float32Array, row: number) {
    let s = this.b[row]!;
    const off = row * this.dim;
    for (let j = 0; j < this.dim; j++) s += this.w[off + j]! * x[j]!;
    return s;
  }
}

/**
 * Train the classifier: softmax regression with class weights and weight decay, by mini-batch
 * Adam. Deterministic for a given seed.
 */
export async function trainHead(inputs: Float32Array[], labels: number[], classes: string[], opts: TrainOptions = {}): Promise<HeadData> {
  const { epochs, batch, rate, l2, seed, pause } = { ...DEFAULT_TRAIN_OPTIONS, ...opts };
  const n = inputs.length;
  const dim = inputs[0]?.length ?? 0;
  const k = classes.length;
  if (!n || !dim || k < 2) throw new Error('Reflex needs examples of at least two intents to train on.');

  // Rare intents count for more, so a few hundred background phrasings don't drown out "stop".
  const counts = new Array(k).fill(0);
  for (const y of labels) counts[y]++;
  const classWeight = counts.map((c) => (c ? Math.sqrt(n / (k * c)) : 0));

  const w = new Float32Array(k * dim);
  const b = new Float32Array(k);
  const gw = new Float32Array(k * dim);
  const gb = new Float32Array(k);
  const mw = new Float32Array(k * dim);
  const vw = new Float32Array(k * dim);
  const mb = new Float32Array(k);
  const vb = new Float32Array(k);
  const [beta1, beta2, eps] = [0.9, 0.999, 1e-8];
  const probs = new Float64Array(k);
  const order = Array.from({ length: n }, (_, i) => i);
  const random = seeded(seed);
  let step = 0;
  let lastPause = Date.now();

  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    for (let start = 0; start < n; start += batch) {
      gw.fill(0);
      gb.fill(0);
      let total = 0;
      for (let s = start; s < Math.min(n, start + batch); s++) {
        const i = order[s]!;
        const x = inputs[i]!;
        const y = labels[i]!;
        let max = -Infinity;
        for (let c = 0; c < k; c++) {
          let z = b[c]!;
          const off = c * dim;
          for (let j = 0; j < dim; j++) z += w[off + j]! * x[j]!;
          probs[c] = z;
          if (z > max) max = z;
        }
        let sum = 0;
        for (let c = 0; c < k; c++) sum += probs[c] = Math.exp(probs[c]! - max);
        const cw = classWeight[y]!;
        total += cw;
        for (let c = 0; c < k; c++) {
          const g = (probs[c]! / sum - (c === y ? 1 : 0)) * cw;
          if (g === 0) continue;
          gb[c]! += g;
          const off = c * dim;
          for (let j = 0; j < dim; j++) gw[off + j]! += g * x[j]!;
        }
      }
      step++;
      const c1 = 1 - beta1 ** step;
      const c2 = 1 - beta2 ** step;
      for (let p = 0; p < w.length; p++) {
        const g = gw[p]! / total + l2 * w[p]!;
        mw[p] = beta1 * mw[p]! + (1 - beta1) * g;
        vw[p] = beta2 * vw[p]! + (1 - beta2) * g * g;
        w[p]! -= (rate * (mw[p]! / c1)) / (Math.sqrt(vw[p]! / c2) + eps);
      }
      for (let c = 0; c < k; c++) {
        const g = gb[c]! / total;
        mb[c] = beta1 * mb[c]! + (1 - beta1) * g;
        vb[c] = beta2 * vb[c]! + (1 - beta2) * g * g;
        b[c]! -= (rate * (mb[c]! / c1)) / (Math.sqrt(vb[c]! / c2) + eps);
      }
      if (pause && Date.now() - lastPause > 12) {
        await pause();
        lastPause = Date.now();
      }
    }
  }
  const round = (v: number) => Math.round(v * 1e5) / 1e5;
  return { version: HEAD_VERSION, classes, dim, weights: Array.from(w, round), bias: Array.from(b, round) };
}

/** A short fingerprint of some text (FNV-1a, twice), for telling whether saved training is still current. */
export function fingerprint(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
