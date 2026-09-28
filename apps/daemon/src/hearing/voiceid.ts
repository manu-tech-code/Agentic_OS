import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SettingsSnapshot, VoiceTestResult } from '@nova/core';

/**
 * Voice ID: whether a turn was said by the user. The hearing helper turns a turn's audio into a voiceprint
 * (256 numbers, unit length); this compares it with the user's own - the average of what they said when
 * setting it up, refined only by turns that were clearly them - kept in one file on this Mac (0600) and
 * never sent anywhere. The arithmetic is here, in code; the helper only listens.
 */

export type Speaker = 'you' | 'not-you' | 'unsure';

export interface StoredVoiceprint {
  /** 2: the bars come from each setup phrase against the others (1: against an average that included it). */
  version: 1 | 2;
  /** The model the prints come from: prints of another model can't be compared with it. */
  model: string;
  print: number[];
  /** At or above this, it's the user; below `reject`, it isn't; between, Nova can't tell. */
  accept: number;
  reject: number;
  enrolled: number;
  learned: number;
  updated: string;
  /** The setup phrases' own voiceprints, so the bars can be set again and more phrases added later. */
  phrases?: number[][];
}

/** What the user reads while Nova learns their voice: short and long, a question, a yes. */
export const ENROLL_PHRASES = (name: string) => [
  `${name}, what's on my calendar today?`,
  'Open Safari and find the weather for this weekend.',
  'Remind me to call my sister at six this evening.',
  'Play some music I like while I work.',
  'Yes, go ahead with all of it.',
  'What did I ask you to do yesterday?',
];

/** Too little speech to tell anyone apart: a voiceprint of it proves nothing either way. */
export const MIN_SECONDS = 0.8;
/** A turn this short is only ever "you" when it's clearly them - a quick "yes" is easy to mistake. */
const SHORT_SECONDS = 1.5;
/** A short turn this soon after a clear one in the user's voice is theirs too: the user, carrying on ("yes"). */
const FOLLOWS_MS = 20_000;
/** How much one clear turn moves the voiceprint, as the voice changes (a cold, another microphone). */
const LEARN_RATE = 0.05;
/** A voice test ends by itself after this long without a word: Nova mustn't stay deaf if the user walks away. */
const TEST_QUIET_MS = 60_000;
/** How many of a test's results are kept to show, newest first. */
const TEST_RESULTS = 8;

export const cosine = (a: readonly number[], b: readonly number[]) => {
  let dot = 0;
  for (let i = 0; i < a.length && i < b.length; i++) dot += a[i]! * b[i]!;
  return dot;
};

const unit = (v: number[]) => {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm > 0 ? v.map((x) => x / norm) : v;
};

const mean = (prints: readonly number[][]) => unit(prints[0]!.map((_, i) => prints.reduce((s, p) => s + p[i]!, 0) / prints.length));

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Each setup phrase against the average of the others: how alike a new turn in the same voice comes out. (Against
 * an average that includes the phrase itself, each looks more alike than any new turn ever will.)
 */
export function leaveOneOut(prints: readonly number[][]): number[] {
  return prints.map((p, i) => cosine(p, mean(prints.filter((_, j) => j !== i))));
}

/**
 * The bars from how alike the setup phrases came out, one against the others: a turn in the user's voice, said
 * another time, somewhere else, scores somewhat lower than that - so the "you" bar sits well under it. Other people
 * score far lower still (0.3 at most, as a rule, for this model), so the "not you" bar stays above them.
 */
export function barsFrom(alike: readonly number[]): { accept: number; reject: number } {
  const typical = alike.reduce((s, x) => s + x, 0) / alike.length;
  const accept = clamp(typical - 0.2, 0.45, 0.62);
  return { accept, reject: clamp(accept - 0.2, 0.25, 0.4) };
}

/** The user's voiceprint from their setup phrases, with its bars set by how alike those came out. */
export function enrollFrom(prints: readonly number[][], model: string, now = new Date()): StoredVoiceprint {
  if (prints.length < 3) throw new Error('Too few phrases to know a voice by.');
  const { accept, reject } = barsFrom(leaveOneOut(prints));
  return { version: 2, model, print: mean(prints), accept, reject, enrolled: prints.length, learned: 0, updated: now.toISOString(), phrases: prints.map((p) => [...p]) };
}

/**
 * A voiceprint set up before the bars came from each phrase against the others (version 1, phrases not kept): its
 * "you" bar was the phrases' likeness to their own average less 0.15. That likeness gives back how alike two of the
 * phrases were (for n unit prints alike by r each, it is √((1 + (n−1)r) / n)), and from that, how alike one is to
 * the others - so the bars are set as a version 2 setup would have set them, without setting up again.
 */
export function migrateVoiceprint(v: StoredVoiceprint): StoredVoiceprint {
  if (v.version === 2) return v;
  const n = Math.max(3, v.enrolled || 6);
  const self = clamp(v.accept + 0.15, 0, 0.999);
  const r = clamp((n * self * self - 1) / (n - 1), 0, 0.999);
  const alike = r / Math.sqrt((1 + (n - 2) * r) / (n - 1));
  return { ...v, version: 2, ...barsFrom([alike]) };
}

/** Whether a setup phrase sounds like the others so far (not a cough, a TV, another person). */
export function consistent(prints: readonly number[][], next: readonly number[]): boolean {
  if (prints.length === 0) return true;
  return cosine(mean(prints), next) >= 0.5;
}

/** Who said a turn: its score against the user's voiceprint, and how long it was. */
export function judge(voice: StoredVoiceprint, print: readonly number[], seconds: number): { speaker: Speaker; score: number } {
  const score = cosine(voice.print, print);
  if (seconds < MIN_SECONDS) return { speaker: 'unsure', score };
  if (score < voice.reject) return { speaker: 'not-you', score };
  // A short turn needs a clearer match: little speech gives a rougher print.
  const bar = seconds < SHORT_SECONDS ? voice.accept + 0.05 : voice.accept;
  return { speaker: score >= bar ? 'you' : 'unsure', score };
}

/** Why Nova couldn't place a turn, in words (score null: no voiceprint could be made of it). */
export function unsureWhy(voice: StoredVoiceprint, score: number | null, seconds: number): string {
  if (seconds < MIN_SECONDS) return 'Too short to tell - say a whole sentence.';
  if (score === null) return "No voiceprint came back in time - say it again.";
  if (seconds < SHORT_SECONDS && score >= voice.accept) return 'Close, but short: a short turn needs a clearer match.';
  return 'Between the two bars: like your voice, but not enough to be sure.';
}

/** A turn that was clearly the user, long enough to trust: the voiceprint moves a little toward it. */
export function learnFrom(voice: StoredVoiceprint, print: readonly number[], score: number, seconds: number): StoredVoiceprint | null {
  if (seconds < SHORT_SECONDS || score < voice.accept + 0.05) return null;
  const next = unit(voice.print.map((x, i) => (1 - LEARN_RATE) * x + LEARN_RATE * print[i]!));
  return { ...voice, print: next, learned: voice.learned + 1, updated: new Date().toISOString() };
}

/** The user's voiceprint on disk: read once, written as it changes (at most every so often while learning). */
export class VoiceprintStore {
  private voice: StoredVoiceprint | null = null;
  private dirty = 0;

  constructor(
    private readonly file: string,
    private readonly model: string,
  ) {}

  async load(): Promise<StoredVoiceprint | null> {
    try {
      const v = JSON.parse(await readFile(this.file, 'utf8')) as StoredVoiceprint;
      // A voiceprint of another model (or a broken file) can't be compared with what the helper makes now.
      const usable = (v?.version === 1 || v?.version === 2) && v.model === this.model && Array.isArray(v.print) && v.print.length > 0;
      this.voice = usable ? migrateVoiceprint(v) : null;
      // Bars set the old way: set again, once, and kept.
      if (usable && v.version !== 2) await this.write().catch(() => {});
    } catch {
      this.voice = null;
    }
    return this.voice;
  }

  get current() {
    return this.voice;
  }

  async set(voice: StoredVoiceprint) {
    this.voice = voice;
    await this.write();
  }

  /** A learned change: kept in memory now, on disk every tenth. */
  async learned(voice: StoredVoiceprint) {
    this.voice = voice;
    if (++this.dirty >= 10) await this.write();
  }

  async flush() {
    if (this.dirty && this.voice) await this.write();
  }

  async forget() {
    this.voice = null;
    this.dirty = 0;
    await rm(this.file, { force: true });
  }

  private async write() {
    this.dirty = 0;
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.voice)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
  }
}

/** What Settings shows of Voice ID: the model, whether there's a voiceprint (never the print), setup, a test. */
export type VoiceIdStatus = SettingsSnapshot['voiceId'];

/**
 * Voice ID for the daemon: setting it up (the user reads a few phrases), deciding whose each turn is,
 * learning from the clear ones, and testing it. Hearing asks it; Settings and the setup checklist read `status()`.
 */
export class VoiceId {
  private phrases: string[] = [];
  private prints: number[][] = [];
  private enrollingStep: number | null = null;
  /** A setup phrase unlike the rest, kept in case the rest (one phrase so far) was the odd one out. */
  private missed: number[] | null = null;
  private message: string | undefined;
  /** A voice test: its results so far, newest first - null when none is running. */
  private testing: VoiceTestResult[] | null = null;
  private testTimer: ReturnType<typeof setTimeout> | undefined;
  /** When a turn was last clearly the user's, for a short one right after it. */
  private youAt = 0;

  constructor(
    private readonly opts: {
      store: VoiceprintStore;
      model: string;
      label: string;
      /** Where the model is (null: not on this Mac). */
      modelDir: () => Promise<string | null>;
      /** Voice ID switched on in Settings, and keep learning. */
      enabled: () => boolean;
      learning: () => boolean;
      name: () => string;
      /** The talk shortcut as the user presses it ("⌥Space"), for what a test says Nova would do. */
      shortcut?: () => string;
      /** Which ear heard the turn ("Nova.app", "a window"), for the log. */
      ear?: () => string;
      /** A voiceprint was made: switch Voice ID on in Settings. */
      turnOn: () => Promise<void>;
      /** Something changed that Settings shows. */
      changed: () => void;
      now?: () => number;
    },
  ) {}

  private models: string | null = null;

  /** Find the model (after an install, say). */
  async refresh() {
    this.models = await this.opts.modelDir();
  }

  active(): { models: string } | null {
    if (!this.models) return null;
    if (this.enrollingStep !== null || this.testing) return { models: this.models };
    return this.opts.enabled() && this.opts.store.current ? { models: this.models } : null;
  }

  /**
   * Whose a turn was. A short one moments after a clear turn in the user's voice counts as theirs - unless it clearly
   * isn't - but only a clear turn opens that window, so short ones never chain. A long turn with no print stays unsure.
   * Each turn's decision goes to the log with its score, length and ear; `learn: false` (a glance at the start
   * of a turn, talking over Nova) neither logs, learns nor opens the window.
   */
  decide(print: number[] | null, seconds: number, opts: { learn?: boolean } = {}): Speaker | undefined {
    const voice = this.opts.store.current;
    if (!voice || !this.opts.enabled() || !this.models) return undefined;
    const now = this.opts.now?.() ?? Date.now();
    const judged = print ? judge(voice, print, seconds) : { speaker: 'unsure' as const, score: null };
    const { score } = judged;
    let speaker: Speaker = judged.speaker;
    let why = '';
    const short = seconds < SHORT_SECONDS;
    if (speaker === 'unsure' && short && now - this.youAt < FOLLOWS_MS && (score === null || score >= voice.reject)) {
      speaker = 'you';
      why = `short, ${Math.round((now - this.youAt) / 1000)} s after a clear one`;
    } else if (speaker === 'unsure') {
      why =
        score === null
          ? seconds < MIN_SECONDS
            ? 'too short for a voiceprint'
            : 'no voiceprint in time'
          : seconds < MIN_SECONDS
            ? 'too short to tell'
            : seconds < SHORT_SECONDS && score >= voice.accept
              ? `short: needs ${(voice.accept + 0.05).toFixed(2)}`
              : `between ${voice.reject.toFixed(2)} and ${voice.accept.toFixed(2)}`;
    }
    if (opts.learn === false) return speaker;
    console.log(`  [voice-id] ${speaker}${score === null ? '' : ` ${score.toFixed(2)}`} · ${seconds.toFixed(1)} s${why ? ` · ${why}` : ''}${this.opts.ear ? ` · heard by ${this.opts.ear()}` : ''}`);
    if (speaker === 'you' && !why && print && score !== null) {
      this.youAt = now;
      if (this.opts.learning()) {
        const next = learnFrom(voice, print, score, seconds);
        if (next) void this.opts.store.learned(next).catch((e) => console.warn(`  [voice-id] couldn't keep what it learned: ${(e as Error).message}`));
      }
    }
    return speaker;
  }

  /** Start setting up (again): the model must be on this Mac. */
  async start(): Promise<string> {
    await this.refresh();
    if (!this.models) throw new Error('Voice ID needs its model first.');
    this.endTest();
    this.phrases = ENROLL_PHRASES(this.opts.name());
    this.prints = [];
    this.missed = null;
    this.enrollingStep = 0;
    this.message = undefined;
    this.opts.changed();
    return `Say: "${this.phrases[0]}"`;
  }

  cancel() {
    this.endTest();
    this.enrollingStep = null;
    this.prints = [];
    this.missed = null;
    this.message = undefined;
    this.opts.changed();
  }

  async forget() {
    this.cancel();
    await this.opts.store.forget();
    this.opts.changed();
  }

  /** Setting up or testing: the turn is for Voice ID, not for Nova. True when it took it. */
  claim(print: number[] | null, seconds: number, text: string): boolean {
    if (this.enrollingStep !== null) return this.enroll(print, seconds, text);
    if (this.testing) return this.tested(print, seconds, text);
    return false;
  }

  /**
   * Test Voice ID: what's said next is judged and shown - never sent to Nova, never learned from - until the
   * test is stopped, or a minute goes by without a word. It works with Voice ID switched off, too.
   */
  async test(): Promise<string> {
    await this.refresh();
    if (!this.models) throw new Error('Voice ID needs its model first.');
    if (!this.opts.store.current) throw new Error('Set Voice ID up first: a test needs your voice to compare with.');
    if (this.enrollingStep !== null) throw new Error('Finish setting up first, or stop - then test.');
    this.testing = [];
    this.message = undefined;
    this.quietIn();
    this.opts.changed();
    return 'Say something - anything. What you say now is only checked, never acted on.';
  }

  private tested(print: number[] | null, seconds: number, text: string): boolean {
    const voice = this.opts.store.current;
    if (!voice || !this.testing) return false;
    const { speaker, score } = print ? judge(voice, print, seconds) : { speaker: 'unsure' as const, score: null };
    const name = this.opts.name();
    const verdict =
      speaker === 'you'
        ? `That's you - ${name} would answer.`
        : speaker === 'not-you'
          ? `Not you - ${name} would ignore it.`
          : `Can't tell - ${name} would ask you to hold ${this.opts.shortcut?.() ?? 'the talk shortcut'} and say it again.`;
    const result: VoiceTestResult = {
      speaker,
      score: score === null ? null : Math.round(score * 1000) / 1000,
      seconds: Math.round(seconds * 10) / 10,
      heard: text.trim().slice(0, 140),
      verdict,
      ...(speaker === 'unsure' ? { why: unsureWhy(voice, score, seconds) } : {}),
      at: new Date(this.opts.now?.() ?? Date.now()).toISOString(),
    };
    this.testing = [result, ...this.testing].slice(0, TEST_RESULTS);
    this.quietIn();
    this.opts.changed();
    return true;
  }

  /** The test's quiet minute starts again: at its end the test stops by itself. */
  private quietIn() {
    clearTimeout(this.testTimer);
    this.testTimer = setTimeout(() => {
      if (!this.testing) return;
      this.endTest();
      this.message = 'The voice test ended after a quiet minute.';
      this.opts.changed();
    }, TEST_QUIET_MS);
    this.testTimer.unref?.();
  }

  private endTest() {
    clearTimeout(this.testTimer);
    this.testTimer = undefined;
    this.testing = null;
  }

  enroll(print: number[] | null, seconds: number, _text: string): boolean {
    if (this.enrollingStep === null) return false;
    if (!print || seconds < 1.2) {
      this.message = 'That was too short to learn from - say the whole phrase.';
    } else if (consistent(this.prints, print)) {
      this.take([...this.prints, print]);
    } else if (this.prints.length === 1 && this.missed && consistent([this.missed], print)) {
      // Twice in a row alike, and unlike the first phrase: that one was the odd one out (a cough, a TV).
      this.take([this.missed, print]);
    } else {
      this.missed = print;
      this.message = "That didn't sound like the others - somewhere quieter, and just you, then say it again.";
    }
    this.opts.changed();
    return true;
  }

  private take(prints: number[][]) {
    this.prints = prints;
    this.missed = null;
    this.message = undefined;
    this.enrollingStep = prints.length;
    if (prints.length < this.phrases.length) return;
    void this.finish().catch((e) => {
      this.message = `Couldn't keep your voiceprint: ${(e as Error).message}`;
      this.opts.changed();
    });
  }

  private async finish() {
    const voice = enrollFrom(this.prints, this.opts.model, new Date(this.opts.now?.() ?? Date.now()));
    this.enrollingStep = null;
    this.prints = [];
    await this.opts.store.set(voice);
    await this.opts.turnOn();
    this.message = `Voice ID is on: ${this.opts.name()} now answers your voice alone. Test my voice shows it at work.`;
    this.opts.changed();
  }

  status(): VoiceIdStatus {
    const voice = this.opts.store.current;
    const step = this.enrollingStep;
    return {
      installed: this.models !== null,
      label: this.opts.label,
      enrolled: voice !== null,
      on: Boolean(voice && this.opts.enabled() && this.models),
      learned: voice?.learned ?? 0,
      enrolling: step === null ? null : { step: step + 1, of: this.phrases.length, say: this.phrases[step] ?? '' },
      testing: this.testing ? { results: [...this.testing] } : null,
      bars: voice ? { accept: voice.accept, reject: voice.reject } : null,
      ...(this.message ? { message: this.message } : {}),
    };
  }
}
