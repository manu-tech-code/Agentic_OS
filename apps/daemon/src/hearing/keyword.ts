import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Voice ID's master keyword: said in any voice, it switches Voice ID off until the user turns it back on (Settings →
 * Voice ID). Only a salted hash of it is kept, in one file on this Mac (0600) - never its words. It's found in what
 * was heard by hashing each run of as many words as it has, and only runs exactly as long as it is.
 */

export interface StoredKeyword {
  version: 1;
  salt: string;
  hash: string;
  iterations: number;
  /** How many words it has, and how many letters and spaces when normalised: the runs worth hashing. */
  words: number;
  letters: number;
  set: string;
  /** When it was last said: Voice ID is off from then until the user turns it back on. */
  overriddenAt?: string;
}

const ITERATIONS = 20_000;
export const KEYWORD_RULE = 'at least two words and eight letters';

/** A word as it compares: lower case, no accents, letters and digits only ("Don't," → "dont"). Empty for punctuation. */
const norm = (word: string) =>
  word
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');

/** The words of what was said, each as heard and as it compares. */
function words(text: string): { raw: string; norm: string }[] {
  return text
    .split(/\s+/)
    .map((raw) => ({ raw, norm: norm(raw) }))
    .filter((w) => w.norm);
}

/** How a keyword compares: its words, normalised, one space apart. */
export const normalise = (phrase: string) =>
  words(phrase)
    .map((w) => w.norm)
    .join(' ');

/** Why a keyword won't do, or null: long enough never to be said by chance - never one common word. */
export function keywordProblem(phrase: string): string | null {
  const n = normalise(phrase);
  if (n.split(' ').filter(Boolean).length < 2 || n.replace(/ /g, '').length < 8) return `The master keyword needs ${KEYWORD_RULE}, so it's never said by chance.`;
  if (n.length > 80) return 'The master keyword is too long to say in one go.';
  return null;
}

const hashOf = (phrase: string, salt: Buffer, iterations: number) => pbkdf2Sync(phrase, salt, iterations, 32, 'sha256');

export class Keyword {
  private stored: StoredKeyword | null = null;
  /** Writes, one after another: two at once would race through the same temporary file. */
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load() {
    try {
      const k = JSON.parse(await readFile(this.file, 'utf8')) as StoredKeyword;
      this.stored = k?.version === 1 && typeof k.hash === 'string' && typeof k.salt === 'string' && k.words > 0 ? k : null;
    } catch {
      this.stored = null;
    }
    return this;
  }

  get isSet() {
    return this.stored !== null;
  }

  get overriddenAt(): string | null {
    return this.stored?.overriddenAt ?? null;
  }

  /** Set (or change) it: hashed at once; the words go no further. Changing it keeps Voice ID as it is (on, or off). */
  async set(phrase: string) {
    const problem = keywordProblem(phrase);
    if (problem) throw new Error(problem);
    const n = normalise(phrase);
    const salt = randomBytes(16);
    this.stored = {
      version: 1,
      salt: salt.toString('hex'),
      hash: hashOf(n, salt, ITERATIONS).toString('hex'),
      iterations: ITERATIONS,
      words: n.split(' ').length,
      letters: n.length,
      set: new Date().toISOString(),
      ...(this.stored?.overriddenAt ? { overriddenAt: this.stored.overriddenAt } : {}),
    };
    await this.write();
  }

  async clear() {
    this.stored = null;
    await this.write();
  }

  /** When this says the keyword (anywhere in it): what was said after it, in the words as heard. Otherwise null. */
  find(text: string): { rest: string } | null {
    const k = this.stored;
    if (!k) return null;
    const heard = words(text);
    const salt = Buffer.from(k.salt, 'hex');
    const want = Buffer.from(k.hash, 'hex');
    for (let i = 0; i + k.words <= heard.length; i++) {
      const run = heard
        .slice(i, i + k.words)
        .map((w) => w.norm)
        .join(' ');
      if (run.length !== k.letters) continue;
      const got = hashOf(run, salt, k.iterations);
      if (got.length === want.length && timingSafeEqual(got, want)) {
        return {
          rest: heard
            .slice(i + k.words)
            .map((w) => w.raw)
            .join(' ')
            .replace(/^[,.;:!?\s-]+/, ''),
        };
      }
    }
    return null;
  }

  /** It was said: Voice ID is off from now until the user turns it back on. Kept on disk, so a restart keeps it off. */
  async override(at = new Date()) {
    if (!this.stored) return;
    this.stored = { ...this.stored, overriddenAt: at.toISOString() };
    await this.write();
  }

  /** The user turned Voice ID back on. */
  async restore() {
    if (!this.stored?.overriddenAt) return;
    const { overriddenAt: _, ...rest } = this.stored;
    this.stored = rest;
    await this.write();
  }

  /** What's kept now goes to disk - after any write still under way, and as it is when its turn comes. */
  private write() {
    const next = this.writing.then(async () => {
      if (!this.stored) return void (await rm(this.file, { force: true }));
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, `${JSON.stringify(this.stored)}\n`, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.file);
    });
    this.writing = next.catch(() => {});
    return next;
  }
}
