import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SettingsSnapshot, VoiceEnrollStep, VoiceTestResult } from '@nova/core';
import type { Keyword } from './keyword.ts';
import { speechQuality, type Quality } from './quality.ts';

/**
 * Voice ID: whether a turn was said by the user. The hearing helper turns a turn's audio into a voiceprint
 * (256 numbers, unit length); this compares it with the user's own - the average of what they said when
 * setting it up, refined only by turns that were clearly them - kept in one file on this Mac (0600) and
 * never sent anywhere. The arithmetic is here, in code; the helper only listens.
 */

/** Whose voice a turn was - or `anyone`: Voice ID is off, since the master keyword was said. */
export type Speaker = 'you' | 'not-you' | 'unsure' | 'anyone';

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
  /** How each setup phrase was said (lined up with `phrases`). */
  conditions?: Condition[];
  /** A voiceprint for each way the user was heard setting up: a turn is "you" by the closest of them. */
  centroids?: { condition: Condition; print: number[] }[];
}

/** How a setup phrase was said: as usual, a step back from the microphone, quietly, or talking freely. */
export type Condition = 'normal' | 'far' | 'quiet' | 'free';

/** A step of setting up: what to say, and how - or a check at the end, which must come out as the user. */
export interface EnrollStep {
  kind: Condition | 'check';
  say: string;
  /** How to say it ("step back a little"). */
  hint?: string;
}

/**
 * Setting up: six phrases as usual, two a step back, two quietly and a quarter of a minute of talking freely - about
 * 45 seconds in all, as the user sounds on different days, at different distances - then the check.
 */
export const ENROLL_STEPS = (name: string): EnrollStep[] => [
  { kind: 'normal', say: `${name}, what's on my calendar today, and has anything moved?` },
  { kind: 'normal', say: 'Open Safari and find the weather for this weekend.' },
  { kind: 'normal', say: 'Remind me to call my sister at six this evening, before dinner.' },
  { kind: 'normal', say: 'Play some music I like while I work on the report.' },
  { kind: 'normal', say: "Yes, go ahead with all of it, and tell me when it's done." },
  { kind: 'normal', say: 'What did I ask you to do yesterday afternoon?' },
  { kind: 'far', say: 'Turn the volume down a little and dim the screen.', hint: "Step back a little - an arm's length or more from the microphone." },
  { kind: 'far', say: 'How long will it take me to get to the office today?', hint: 'Still a step back.' },
  { kind: 'quiet', say: 'Set a timer for twenty minutes, please.', hint: 'Now quietly, as if someone nearby is asleep.' },
  { kind: 'quiet', say: "What's the time, and do I have anything next?", hint: 'Quietly again.' },
  { kind: 'free', say: 'Now just talk for about fifteen seconds - about your day, your plans, anything at all.', hint: 'Talk as you usually would.' },
];

/** Improving: a few more - as usual, a step back, and talking - added to what was learned before. */
export const IMPROVE_STEPS = (name: string): EnrollStep[] => [
  { kind: 'normal', say: `${name}, read me my last message, please.` },
  { kind: 'normal', say: 'Move this window to the left half of the screen.' },
  { kind: 'normal', say: 'Add milk and bread to my shopping list.' },
  { kind: 'far', say: 'Turn the music up a bit.', hint: 'A step back from the microphone.' },
  { kind: 'free', say: 'Now talk for about fifteen seconds - anything at all.', hint: 'Talk as you usually would.' },
];

/** The check: new phrases that must come out as the user before Voice ID goes on. */
export const CHECK_PHRASES = (name: string) => [
  'Open my notes and read me the last one.',
  `${name}, what's the weather like tomorrow morning?`,
  "Send the report to the team when it's ready.",
  'Pause the music for a moment.',
  'Show me what I did this week.',
  'Remind me about the dentist on Friday.',
  'Close all the windows except this one.',
];
/** How many checks in a row must come out as the user; how many at most before it goes on anyway. */
const CHECKS_IN_A_ROW = 3;
const MAX_CHECKS = 7;
/** Speech a phrase needs, and talking freely. */
const PHRASE_SPEECH = 1.2;
const FREE_SPEECH = 6;
/** An unsure turn said again with the talk shortcut within this long is the user's: it teaches Voice ID. */
const CONFIRM_MS = 30_000;

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

/**
 * The user's voiceprint from their setup phrases, with its bars set by how alike those came out - and, when how
 * each was said is known, a voiceprint for each way (as usual, a step back, quietly, talking), to match the closest.
 */
export function enrollFrom(prints: readonly number[][], model: string, now = new Date(), conditions?: readonly Condition[]): StoredVoiceprint {
  if (prints.length < 3) throw new Error('Too few phrases to know a voice by.');
  const { accept, reject } = barsFrom(leaveOneOut(prints));
  const how = conditions && conditions.length === prints.length ? [...conditions] : null;
  const centroids = how
    ? (['normal', 'far', 'quiet', 'free'] as const).flatMap((condition) => {
        const own = prints.filter((_, i) => how[i] === condition);
        return own.length ? [{ condition, print: mean(own) }] : [];
      })
    : undefined;
  return {
    version: 2,
    model,
    print: mean(prints),
    accept,
    reject,
    enrolled: prints.length,
    learned: 0,
    updated: now.toISOString(),
    phrases: prints.map((p) => [...p]),
    ...(how ? { conditions: how, centroids } : {}),
  };
}

/** How much a turn sounds like the user: the closest of their voiceprints - overall, and each way they were heard. */
export function scoreOf(voice: StoredVoiceprint, print: readonly number[]): number {
  let best = cosine(voice.print, print);
  for (const c of voice.centroids ?? []) best = Math.max(best, cosine(c.print, print));
  return best;
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
export function judge(voice: StoredVoiceprint, print: readonly number[], seconds: number): { speaker: Exclude<Speaker, 'anyone'>; score: number } {
  const score = scoreOf(voice, print);
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

/** The voiceprint, a little toward a turn of the user's: overall, and the closest of the ways they were heard. */
export function nudge(voice: StoredVoiceprint, print: readonly number[]): StoredVoiceprint {
  const toward = (v: readonly number[]) => unit(v.map((x, i) => (1 - LEARN_RATE) * x + LEARN_RATE * print[i]!));
  const closest = (voice.centroids ?? []).reduce<number>((best, c, i, all) => (best < 0 || cosine(c.print, print) > cosine(all[best]!.print, print) ? i : best), -1);
  return {
    ...voice,
    print: toward(voice.print),
    ...(voice.centroids ? { centroids: voice.centroids.map((c, i) => (i === closest ? { ...c, print: toward(c.print) } : c)) } : {}),
    learned: voice.learned + 1,
    updated: new Date().toISOString(),
  };
}

/** A turn that was clearly the user, long enough to trust: the voiceprint moves a little toward it. */
export function learnFrom(voice: StoredVoiceprint, print: readonly number[], score: number, seconds: number): StoredVoiceprint | null {
  if (seconds < SHORT_SECONDS || score < voice.accept + 0.05) return null;
  return nudge(voice, print);
}

/** Whether two things said were the same request, said again (most of their words in common). */
export function sameRequest(a: string, b: string): boolean {
  const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1));
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / new Set([...x, ...y]).size >= 0.5;
}

/** The user's voiceprint on disk: read once, written as it changes (at most every so often while learning). */
export class VoiceprintStore {
  private voice: StoredVoiceprint | null = null;
  private dirty = 0;
  /** Writes, one after another: two at once would race through the same temporary file. */
  private writing: Promise<void> = Promise.resolve();

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
    await this.write();
  }

  /** What's kept now goes to disk - after any write still under way, and as it is when its turn comes. */
  private write() {
    this.dirty = 0;
    const next = this.writing.then(async () => {
      if (!this.voice) return void (await rm(this.file, { force: true }));
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, `${JSON.stringify(this.voice)}\n`, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.file);
    });
    this.writing = next.catch(() => {});
    return next;
  }
}

/** What Settings shows of Voice ID: the model, whether there's a voiceprint (never the print), setup, a test. */
export type VoiceIdStatus = SettingsSnapshot['voiceId'];

/**
 * Voice ID for the daemon: setting it up (the user reads a few phrases), deciding whose each turn is,
 * learning from the clear ones, and testing it. Hearing asks it; Settings and the setup checklist read `status()`.
 */
/** Setting up (or improving), under way. */
interface Enrolling {
  steps: EnrollStep[];
  at: number;
  /** What was taken this time, and how each was said. */
  prints: number[][];
  conditions: Condition[];
  done: VoiceEnrollStep[];
  /** Improving: what was learned before, which this adds to. */
  base: StoredVoiceprint | null;
  /** The check at the end: the voiceprint as it stands, checks so far, and how many came out as the user in a row. */
  candidate: StoredVoiceprint | null;
  checks: number;
  inARow: number;
  /** A phrase unlike the rest, kept in case the rest (one phrase so far) was the odd one out. */
  missed: { print: number[]; condition: Condition } | null;
}

const statsOf = (q: Quality | null) => (q ? { level: q.level, snr: q.snr, speech: q.speech } : {});

export class VoiceId {
  private enrolling: Enrolling | null = null;
  /** The last turn Voice ID couldn't place, in case the user says it again with the talk shortcut. */
  private unsure: { print: number[]; seconds: number; at: number; text: string } | null = null;
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
      /** The master keyword, when the user set one: said in any voice, it turns Voice ID off until they turn it back on. */
      keyword?: Keyword;
      /** The keyword was just said (with what came after it): tell the user - aloud, a notification, the record. */
      onOverride?: (rest: string) => void;
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
    if (this.enrolling || this.testing) return { models: this.models };
    return this.opts.enabled() && this.opts.store.current ? { models: this.models } : null;
  }

  /**
   * Whose a turn was. A short one moments after a clear turn in the user's voice counts as theirs - unless it clearly
   * isn't - but only a clear turn opens that window, so short ones never chain. A long turn with no print stays unsure.
   * Each turn's decision goes to the log with its score, length and ear; `learn: false` (a glance at the start
   * of a turn, talking over Nova) neither logs, learns nor opens the window.
   */
  decide(print: number[] | null, seconds: number, opts: { learn?: boolean; text?: string } = {}): Speaker | undefined {
    const voice = this.opts.store.current;
    if (!voice || !this.opts.enabled() || !this.models) return undefined;
    if (this.overridden()) {
      if (opts.learn !== false) console.log(`  [voice-id] anyone · ${seconds.toFixed(1)} s · off since the master keyword was said`);
      return 'anyone';
    }
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
    // Can't place it, though it's long enough to learn from: if the user says it again with the shortcut, it was theirs.
    if (speaker === 'unsure' && print && seconds >= SHORT_SECONDS) this.unsure = { print, seconds, at: now, text: opts.text ?? '' };
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

  /** Voice ID is off: the master keyword was said, and the user hasn't turned it back on yet. */
  overridden(): boolean {
    return Boolean(this.opts.keyword?.overriddenAt);
  }

  /**
   * The master keyword, said anywhere in a turn, in any voice (only while Voice ID is on - it's what it overrides):
   * Voice ID goes off until the user turns it back on, and what was said after it goes through. Null when it wasn't said.
   */
  unlock(text: string): string | null {
    const keyword = this.opts.keyword;
    if (!keyword?.isSet || !this.opts.enabled() || !this.opts.store.current || this.overridden()) return null;
    const hit = keyword.find(text);
    if (!hit) return null;
    console.log('  [voice-id] the master keyword was said: Voice ID is off until it is turned back on');
    void keyword.override().catch((e) => console.warn(`  [voice-id] couldn't keep that it's off: ${(e as Error).message}`));
    this.opts.onOverride?.(hit.rest);
    this.opts.changed();
    return hit.rest;
  }

  /** The user turned Voice ID back on (Settings). */
  async restore() {
    await this.opts.keyword?.restore();
    this.opts.changed();
  }

  async setKeyword(phrase: string) {
    if (!this.opts.keyword) throw new Error("A master keyword can't be kept here.");
    await this.opts.keyword.set(phrase);
    this.opts.changed();
  }

  async clearKeyword() {
    await this.opts.keyword?.clear();
    this.opts.changed();
  }

  /** Start setting up (again): the model must be on this Mac. */
  async start(): Promise<string> {
    return this.begin(ENROLL_STEPS(this.opts.name()), null);
  }

  /** Improve my voice: a few more phrases, added to what was learned before - without setting up again. */
  async improve(): Promise<string> {
    const voice = this.opts.store.current;
    if (!voice?.phrases?.length) throw new Error('This voiceprint was set up before its phrases were kept - set it up again (Learn it again) to improve it later.');
    return this.begin(IMPROVE_STEPS(this.opts.name()), voice);
  }

  private async begin(steps: EnrollStep[], base: StoredVoiceprint | null): Promise<string> {
    await this.refresh();
    if (!this.models) throw new Error('Voice ID needs its model first.');
    this.endTest();
    const checks = CHECK_PHRASES(this.opts.name()).map((say): EnrollStep => ({ kind: 'check', say }));
    this.enrolling = { steps: [...steps, ...checks], at: 0, prints: [], conditions: [], done: [], base, candidate: null, checks: 0, inARow: 0, missed: null };
    this.message = undefined;
    this.opts.changed();
    return `Say: "${steps[0]!.say}"`;
  }

  cancel() {
    this.endTest();
    this.enrolling = null;
    this.message = undefined;
    this.opts.changed();
  }

  async forget() {
    this.cancel();
    await this.opts.store.forget();
    await this.opts.keyword?.restore(); // nothing left to be off: a new setup starts with Voice ID on
    this.opts.changed();
  }

  /** Setting up or testing: the turn is for Voice ID, not for Nova. True when it took it. */
  claim(print: number[] | null, seconds: number, text: string, audio?: Int16Array): boolean {
    if (this.enrolling) return this.enroll(print, seconds, text, audio);
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
    if (this.enrolling) throw new Error('Finish setting up first, or stop - then test.');
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

  /**
   * A setup phrase: taken only when the recording is good enough (loud, clear, long enough, someone talking) and it
   * sounds like the others so far; otherwise the user hears why and says it again. Collected, the voice is checked:
   * new phrases must come out as the user, three in a row - each one that doesn't is learned from - before it goes on.
   */
  enroll(print: number[] | null, seconds: number, _text: string, audio?: Int16Array): boolean {
    const e = this.enrolling;
    if (!e) return false;
    const step = e.steps[e.at]!;
    const quality = audio ? speechQuality(audio, step.kind === 'free' ? FREE_SPEECH : PHRASE_SPEECH) : null;
    const record = (entry: Omit<VoiceEnrollStep, 'say' | 'kind'>) => (e.done = [...e.done, { say: step.say, kind: step.kind, ...entry }].slice(-24));
    const again = (why: string) => {
      record({ ok: false, why, ...statsOf(quality) });
      this.message = why;
      this.opts.changed();
      return true;
    };
    if (!print) return again('That was too short to learn from - say the whole phrase.');
    if (quality && !quality.ok) return again(quality.problems[0]!);
    if (!quality && seconds < PHRASE_SPEECH) return again('That was too short to learn from - say the whole phrase.');
    if (step.kind === 'check') return this.checked(e, print, seconds, quality, record);
    if (!consistent(this.everything(e), print)) {
      if (e.prints.length === 1 && !e.base && e.missed && consistent([e.missed.print], print)) {
        // Twice in a row alike, and unlike the first phrase: that one was the odd one out (a cough, a TV).
        e.prints = [e.missed.print];
        e.conditions = [e.missed.condition];
      } else {
        e.missed = { print, condition: step.kind };
        return again("That didn't sound like the others - somewhere quieter, and just you, then say it again.");
      }
    }
    e.prints.push(print);
    e.conditions.push(step.kind);
    e.missed = null;
    record({ ok: true, ...statsOf(quality) });
    this.message = undefined;
    e.at++;
    // Collected: from here on, it's checked.
    if (e.steps[e.at]?.kind === 'check') e.candidate = this.build(e);
    this.opts.changed();
    return true;
  }

  /** What's known of the voice so far: kept from before (improving), and taken this time. */
  private everything(e: Enrolling) {
    return [...(e.base?.phrases ?? []), ...e.prints];
  }

  private build(e: Enrolling): StoredVoiceprint {
    const before = e.base?.phrases ?? [];
    const how: Condition[] = [...before.map((_, i) => e.base?.conditions?.[i] ?? 'normal'), ...e.conditions];
    const voice = enrollFrom(this.everything(e), this.opts.model, new Date(this.opts.now?.() ?? Date.now()), how);
    return { ...voice, learned: e.base?.learned ?? 0 };
  }

  private checked(e: Enrolling, print: number[], seconds: number, quality: Quality | null, record: (entry: Omit<VoiceEnrollStep, 'say' | 'kind'>) => void): boolean {
    const candidate = e.candidate ?? this.build(e);
    const { speaker, score } = judge(candidate, print, seconds);
    const rounded = Math.round(score * 100) / 100;
    e.checks++;
    if (speaker === 'you') {
      e.inARow++;
      record({ ok: true, score: rounded, ...statsOf(quality) });
    } else {
      e.inARow = 0;
      // Still the user, if not clearly enough: learned from - unless it didn't sound like them at all.
      const theirs = consistent(this.everything(e), print);
      if (theirs) {
        e.prints.push(print);
        e.conditions.push('normal');
        e.candidate = this.build(e);
      }
      record({
        ok: false,
        score: rounded,
        why: theirs ? `Not quite yet (${rounded.toFixed(2)}, it needs ${candidate.accept.toFixed(2)}) - learned from it. Another one, please.` : "That didn't sound like you - just your voice, please.",
        ...statsOf(quality),
      });
    }
    if (e.inARow >= CHECKS_IN_A_ROW || e.checks >= MAX_CHECKS || e.at + 1 >= e.steps.length) {
      void this.finish(e).catch((err) => {
        this.message = `Couldn't keep your voiceprint: ${(err as Error).message}`;
        this.opts.changed();
      });
    } else {
      e.at++;
      this.message = undefined;
      this.opts.changed();
    }
    return true;
  }

  private async finish(e: Enrolling) {
    const voice = e.candidate ?? this.build(e);
    const all = e.inARow >= CHECKS_IN_A_ROW;
    this.enrolling = null;
    await this.opts.store.set(voice);
    await this.opts.keyword?.restore(); // set up again: on, whatever the keyword did before
    await this.opts.turnOn();
    const name = this.opts.name();
    this.message = all
      ? `Voice ID is on: ${name} now answers your voice alone - the last ${CHECKS_IN_A_ROW} checks all came out as you. Test my voice shows it at work.`
      : `Voice ID is on, but your voice came out quite differently from one phrase to the next here - it may still miss you now and then. Improve my voice adds more, somewhere quieter.`;
    this.opts.changed();
  }

  /**
   * A turn said with the talk shortcut is the user's - whoever holds the key is at this Mac: it teaches Voice ID (unless
   * it clearly sounds like someone else), and so does an unsure turn just before it that said the same thing.
   */
  confirmed(print: number[] | null, seconds: number, text: string) {
    const voice = this.opts.store.current;
    if (!voice || !this.opts.enabled() || !this.models || this.overridden() || !this.opts.learning()) return;
    const now = this.opts.now?.() ?? Date.now();
    let next = voice;
    const taught: string[] = [];
    const teach = (p: number[] | null, s: number) => {
      if (!p || s < SHORT_SECONDS) return;
      const score = scoreOf(next, p);
      if (score < next.reject) return;
      next = nudge(next, p);
      taught.push(score.toFixed(2));
    };
    teach(print, seconds);
    const before = this.unsure;
    this.unsure = null;
    if (before && now - before.at < CONFIRM_MS && sameRequest(before.text, text)) teach(before.print, before.seconds);
    if (!taught.length) return;
    console.log(`  [voice-id] learned from ${taught.length === 2 ? 'an unsure turn and the shortcut turn that said it again' : 'a turn said with the shortcut'} (${taught.join(', ')})`);
    void this.opts.store.learned(next).catch((err) => console.warn(`  [voice-id] couldn't keep what it learned: ${(err as Error).message}`));
  }

  private enrollingStatus(): VoiceIdStatus['enrolling'] {
    const e = this.enrolling;
    if (!e) return null;
    const step = e.steps[e.at]!;
    const collecting = e.steps.filter((s) => s.kind !== 'check').length;
    const checking = step.kind === 'check';
    return {
      step: checking ? e.inARow + 1 : e.at + 1,
      of: checking ? CHECKS_IN_A_ROW : collecting,
      say: step.say,
      kind: step.kind,
      ...(step.hint ? { hint: step.hint } : {}),
      phase: checking ? 'check' : 'collect',
      done: [...e.done],
    };
  }

  status(): VoiceIdStatus {
    const voice = this.opts.store.current;
    return {
      installed: this.models !== null,
      label: this.opts.label,
      enrolled: voice !== null,
      on: Boolean(voice && this.opts.enabled() && this.models),
      learned: voice?.learned ?? 0,
      enrolling: this.enrollingStatus(),
      improvable: Boolean(voice?.phrases?.length),
      testing: this.testing ? { results: [...this.testing] } : null,
      bars: voice ? { accept: voice.accept, reject: voice.reject } : null,
      keyword: { set: Boolean(this.opts.keyword?.isSet), overriddenAt: this.opts.keyword?.overriddenAt ?? null },
      ...(this.message ? { message: this.message } : {}),
    };
  }
}
