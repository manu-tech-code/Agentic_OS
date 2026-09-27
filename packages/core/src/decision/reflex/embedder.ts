/**
 * Turns text into meaning vectors for Reflex. The default is a static (Model2Vec) model:
 * every word piece has a vector and a text's vector is their normalised mean, so an
 * utterance takes microseconds and needs no ML runtime. Pure TypeScript, no file access:
 * the daemon reads the model's files and hands over their contents.
 */

export interface Embedder {
  readonly id: string;
  readonly dim: number;
  /** A unit-length vector; all zeros when nothing in the text is known. */
  embed(text: string): Float32Array;
  /** Whether a word is an everyday word the model knows whole (so a name like "Weather" could just be the word). */
  knows?(word: string): boolean;
}

/** BERT-style WordPiece tokenization, as the model's tokenizer.json describes it. */
export class WordPieceTokenizer {
  private readonly vocab: Map<string, number>;
  private readonly prefix: string;
  private readonly maxChars: number;
  private readonly lowercase: boolean;
  private readonly stripAccents: boolean;
  readonly unkId: number | undefined;

  constructor(json: unknown) {
    const t = json as { model?: any; normalizer?: any };
    if (t?.model?.type !== 'WordPiece' || typeof t.model.vocab !== 'object') throw new Error('Reflex needs a WordPiece tokenizer.');
    this.vocab = new Map(Object.entries(t.model.vocab as Record<string, number>));
    this.prefix = t.model.continuing_subword_prefix ?? '##';
    this.maxChars = t.model.max_input_chars_per_word ?? 100;
    this.lowercase = t.normalizer?.lowercase ?? true;
    this.stripAccents = t.normalizer?.strip_accents ?? this.lowercase;
    this.unkId = this.vocab.get(t.model.unk_token ?? '[UNK]');
  }

  /** Whether the vocabulary has this word whole. */
  has(word: string) {
    return this.vocab.has(word);
  }

  /** Token ids for a text, without special tokens and without unknown pieces. */
  encode(text: string): number[] {
    const ids: number[] = [];
    for (const word of this.words(text)) for (const id of this.pieces(word)) if (id !== this.unkId) ids.push(id);
    return ids;
  }

  private words(text: string): string[] {
    let s = text.replace(/[\t\n\r]/g, ' ').replace(/[\p{Cc}\p{Cf}\u{fffd}]/gu, '');
    s = s.replace(/[\u{4e00}-\u{9fff}\u{3400}-\u{4dbf}\u{f900}-\u{faff}]/gu, (c) => ` ${c} `);
    if (this.lowercase) s = s.toLowerCase();
    if (this.stripAccents) s = s.normalize('NFD').replace(/\p{Mn}/gu, '');
    // Whitespace splits words; every punctuation mark is a word of its own.
    return s.split(/\s+/).flatMap((w) => w.split(/([\p{P}$+<=>^`|~])/u)).filter(Boolean);
  }

  /** Greedy longest-match-first word pieces; a word that can't be pieced together is unknown. */
  private pieces(word: string): number[] {
    const chars = [...word];
    const unknown = this.unkId === undefined ? [] : [this.unkId];
    if (chars.length > this.maxChars) return unknown;
    const out: number[] = [];
    for (let start = 0; start < chars.length; ) {
      let end = chars.length;
      let id: number | undefined;
      for (; end > start; end--) {
        id = this.vocab.get((start ? this.prefix : '') + chars.slice(start, end).join(''));
        if (id !== undefined) break;
      }
      if (id === undefined) return unknown;
      out.push(id);
      start = end;
    }
    return out;
  }
}

function halfToFloat(h: number) {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 0x1f) return frac ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

/** One float tensor from a .safetensors file. */
export function readSafetensor(bytes: Uint8Array, name: string): { data: Float32Array; shape: number[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = Number(view.getBigUint64(0, true));
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength))) as Record<string, any>;
  const tensor = header[name];
  if (!tensor) throw new Error(`The model has no "${name}" tensor.`);
  const [start, end] = tensor.data_offsets as [number, number];
  const raw = bytes.slice(8 + headerLength + start, 8 + headerLength + end); // a copy, so it's aligned
  if (tensor.dtype === 'F32') return { data: new Float32Array(raw.buffer, 0, raw.byteLength / 4), shape: tensor.shape };
  if (tensor.dtype === 'F16') {
    const halves = new Uint16Array(raw.buffer, 0, raw.byteLength / 2);
    return { data: Float32Array.from(halves, halfToFloat), shape: tensor.shape };
  }
  throw new Error(`Reflex can't read ${tensor.dtype} weights.`);
}

/** A Model2Vec static embedding model. */
export class StaticEmbedder implements Embedder {
  readonly dim: number;
  private readonly matrix: Float32Array;
  private readonly rows: number;

  constructor(
    readonly id: string,
    private readonly tokenizer: WordPieceTokenizer,
    embeddings: { data: Float32Array; shape: number[] },
  ) {
    const [rows, dim] = embeddings.shape as [number, number];
    this.rows = rows;
    this.dim = dim;
    this.matrix = embeddings.data;
  }

  /** From the model's files: model.safetensors (bytes) and tokenizer.json (parsed). */
  static fromFiles(id: string, files: { weights: Uint8Array; tokenizer: unknown }) {
    return new StaticEmbedder(id, new WordPieceTokenizer(files.tokenizer), readSafetensor(files.weights, 'embeddings'));
  }

  knows(word: string) {
    return this.tokenizer.has(word.toLowerCase());
  }

  embed(text: string): Float32Array {
    const out = new Float32Array(this.dim);
    for (const id of this.tokenizer.encode(text)) {
      if (id >= this.rows) continue;
      const row = id * this.dim;
      for (let j = 0; j < this.dim; j++) out[j]! += this.matrix[row + j]!;
    }
    return normalise(out);
  }
}

export function normalise(v: Float32Array): Float32Array {
  let norm = 0;
  for (let j = 0; j < v.length; j++) norm += v[j]! * v[j]!;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let j = 0; j < v.length; j++) v[j]! /= norm;
  return v;
}

export function dot(a: Float32Array, b: Float32Array, offset = 0): number {
  let s = 0;
  for (let j = 0; j < a.length; j++) s += a[j]! * b[offset + j]!;
  return s;
}
