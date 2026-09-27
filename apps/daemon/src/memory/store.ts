import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Embedder, MemoryItem, MemoryService, Turn } from '@nova/core';

/**
 * Nova's memory of the user: facts they said to remember, or agreed to when Nova suggested them,
 * kept as plain JSON they can read and edit (~/.nova/memory.json). Related memories are found by
 * meaning (Reflex's embedding model) and by shared words, so it works before Reflex is installed too.
 */

export interface StoredMemory {
  id: string;
  text: string;
  created: number;
  updated?: number;
  source: 'said' | 'suggested';
}

const STOP = new Set(
  'a an the and or but of to in on at for with from by about as is are was were be been am i me my mine you your we our they their it its this that these those do does did have has had what when where which who how can could would should will please remember forget note that just really also some any'.split(' '),
);
const words = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).filter((w) => !STOP.has(w));

function cosine(a: Float32Array, b: Float32Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** How related a memory is to a question, 0-1: its meaning and the words they share. */
function relatedness(query: string, text: string, q?: Float32Array, m?: Float32Array) {
  const qw = new Set(words(query));
  const mw = new Set(words(text));
  const shared = qw.size ? [...qw].filter((w) => mw.has(w)).length / qw.size : 0;
  const meaning = q && m ? Math.max(0, cosine(q, m)) : 0;
  return q && m ? 0.6 * meaning + 0.4 * shared : shared;
}

async function writePrivate(file: string, data: string) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, data, { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

export class MemoryStore implements MemoryService {
  private items: StoredMemory[] = [];
  private readonly vectors = new Map<string, Float32Array>();
  private saving: Promise<unknown> = Promise.resolve();
  suggestions = true;

  constructor(
    private readonly file: string,
    private readonly embedder: () => Embedder | null,
    readonly journal: Journal,
  ) {}

  async load() {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      const list = Array.isArray(parsed) ? parsed : (parsed as { memories?: unknown[] })?.memories;
      this.items = (Array.isArray(list) ? list : []).filter((m): m is StoredMemory => typeof (m as StoredMemory)?.text === 'string' && typeof (m as StoredMemory)?.id === 'string');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`  [memory] can't read ${this.file}: ${(e as Error).message}`);
      this.items = [];
    }
    return this;
  }

  list(): readonly StoredMemory[] {
    return this.items;
  }

  private vector(text: string) {
    const embedder = this.embedder();
    if (!embedder) return undefined;
    let v = this.vectors.get(text);
    if (!v) {
      v = embedder.embed(text);
      this.vectors.set(text, v);
    }
    return v;
  }

  remember(fact: string, source: 'said' | 'suggested'): MemoryItem {
    const text = fact.trim().replace(/\s+/g, ' ');
    // The same thing said again (or nearly): the newer wording replaces it.
    const same = this.items.find((m) => m.text.toLowerCase() === text.toLowerCase() || relatedness(text, m.text, this.vector(text), this.vector(m.text)) > 0.9);
    if (same) {
      same.text = text;
      same.updated = Date.now();
      this.save();
      return { id: same.id, text };
    }
    const item: StoredMemory = { id: randomBytes(4).toString('hex'), text, created: Date.now(), source };
    this.items.push(item);
    this.save();
    return { id: item.id, text };
  }

  recall(query: string, limit = 5): MemoryItem[] {
    const q = this.vector(query);
    const scored = this.items.map((m) => ({ id: m.id, text: m.text, score: relatedness(query, m.text, q, this.vector(m.text)) })).sort((a, b) => b.score - a.score);
    // A few memories are all worth offering; with many, only the related ones.
    return (this.items.length <= 8 ? scored : scored.filter((m) => m.score >= 0.25)).slice(0, limit);
  }

  /** What goes with a question to the brain: everything when there's little, else what's related. */
  relevant(question: string): MemoryItem[] {
    return this.recall(question, this.items.length <= 8 ? 8 : 6);
  }

  forget(id: string) {
    const before = this.items.length;
    this.items = this.items.filter((m) => m.id !== id);
    if (this.items.length !== before) this.save();
    return this.items.length !== before;
  }

  edit(id: string, text: string) {
    const item = this.items.find((m) => m.id === id);
    if (!item || !text.trim()) return false;
    item.text = text.trim();
    item.updated = Date.now();
    this.save();
    return true;
  }

  clear() {
    this.items = [];
    return this.save();
  }

  searchConversations(query: string, days = 90) {
    return this.journal.search(query, days, (text) => this.vector(text));
  }

  /** Once everything said so far is on disk. */
  flushed() {
    return Promise.all([this.saving, this.journal.flushed()]).then(() => undefined);
  }

  private save() {
    const data = `${JSON.stringify({ memories: this.items }, null, 2)}\n`;
    this.saving = this.saving.then(() => writePrivate(this.file, data)).catch((e) => console.warn(`  [memory] can't save: ${(e as Error).message}`));
    return this.saving;
  }
}

/** Relative days a question may name, as how many days back they start and end. */
function span(query: string): { from: number; to: number } | null {
  const q = query.toLowerCase();
  if (/\btoday\b|\bthis morning\b|\bearlier\b/.test(q)) return { from: 0, to: 0 };
  if (/\byesterday\b|\blast night\b/.test(q)) return { from: 1, to: 1 };
  if (/\bthis week\b/.test(q)) return { from: 6, to: 0 };
  if (/\blast week\b/.test(q)) return { from: 13, to: 7 };
  return null;
}

/** The user's own calendar day, e.g. "2026-09-27" - not UTC's. */
export function dayName(at: number) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** How many calendar days before `now` a day file is (0 for today), in the user's time zone. */
function daysAgo(file: string, now: number) {
  const [y, m, d] = file.slice(0, 10).split('-').map(Number);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - new Date(y!, m! - 1, d!).getTime()) / 86_400_000);
}

/** Past conversations, one file of JSON lines per day (~/.nova/conversations/2026-09-27.jsonl), kept as long as the user chose. */
export class Journal {
  private writing: Promise<unknown> = Promise.resolve();
  private prunedOn = '';

  constructor(
    private readonly dir: string,
    /** How many days to keep; null keeps them all. */
    private readonly keepDays: () => number | null,
  ) {}

  /** Keep one turn; in order, and old days go once a day. */
  append(turn: Turn, at = Date.now()) {
    const line = `${JSON.stringify({ at, user: turn.user, nova: turn.nova })}\n`;
    const day = dayName(at);
    const prune = this.prunedOn !== day;
    this.prunedOn = day;
    this.writing = this.writing
      .then(() => mkdir(this.dir, { recursive: true, mode: 0o700 }))
      .then(() => appendFile(join(this.dir, `${day}.jsonl`), line, { mode: 0o600 }))
      .then(() => (prune ? this.prune() : undefined))
      .catch((e) => console.warn(`  [memory] can't keep the conversation: ${(e as Error).message}`));
    return this.writing;
  }

  private async days(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse();
    } catch {
      return [];
    }
  }

  private async turns(file: string) {
    try {
      return (await readFile(join(this.dir, file), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { at: number; user: string; nova: string });
    } catch {
      return [];
    }
  }

  flushed() {
    return this.writing.then(() => undefined);
  }

  /** Past turns about a question - "yesterday" and "last week" pick days; other words pick turns. */
  async search(query: string, days: number, vector: (text: string) => Float32Array | undefined, limit = 6) {
    const window = span(query);
    const now = Date.now();
    const files = (await this.days()).filter((f) => {
      const age = daysAgo(f, now);
      return window ? age <= window.from && age >= window.to : age <= days;
    });
    const topic = query.replace(/\b(what|did|i|ask|asked|you|tell|told|say|said|we|talk|talked|about|yesterday|today|this|last|week|morning|night|earlier)\b/gi, ' ').trim();
    const all = (await Promise.all(files.map((f) => this.turns(f)))).flat();
    if (!topic || words(topic).length === 0) return all.sort((a, b) => b.at - a.at).slice(0, limit);
    const q = vector(topic);
    return all
      .map((t) => ({ t, score: relatedness(topic, `${t.user} ${t.nova}`, q, vector(`${t.user} ${t.nova}`)) }))
      .filter((x) => x.score >= 0.2)
      .sort((a, b) => b.score - a.score || b.t.at - a.t.at)
      .slice(0, limit)
      .map((x) => x.t);
  }

  /** Forget days older than the user keeps. */
  async prune(now = Date.now()) {
    const keep = this.keepDays();
    if (keep === null) return;
    for (const f of await this.days()) if (daysAgo(f, now) > keep) await rm(join(this.dir, f), { force: true });
  }

  async stats() {
    const files = await this.days();
    const turns = (await Promise.all(files.map((f) => this.turns(f)))).reduce((n, t) => n + t.length, 0);
    return { days: files.length, turns };
  }

  async clear() {
    for (const f of await this.days()) await rm(join(this.dir, f), { force: true });
  }
}
