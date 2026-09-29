import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SettingsSnapshot, VoiceEnrollStep, VoiceTestResult } from '@nova/core';
import type { Keyword } from './keyword.ts';
import type { WorkerModel } from './printer.ts';
import { speechQuality, type Quality } from './quality.ts';
import type { Recording, RecordingKind } from './recordings.ts';

/**
 * Voice ID: whether a turn was said by the user. Three models each turn a turn's audio into a voiceprint (a few
 * hundred numbers, unit length) - the hearing helper's small one and two larger ones in their own process - and
 * this compares each with the user's own in that model - the average of what they said when setting it up, refined
 * only by turns that were clearly them - kept in one file on this Mac (0600) and never sent anywhere. The models'
 * matches are weighed together into one. The arithmetic is here, in code; the models only listen.
 */

/** Whose voice a turn was - or `anyone`: Voice ID is off, since the master keyword was said. */
export type Speaker = 'you' | 'not-you' | 'unsure' | 'anyone';

/** Voice ID's models, by the names their files are kept under: each makes its own kind of voiceprint. */
export type Ear = 'wespeaker-v2' | 'wespeaker-resnet293' | 'titanet-large';
export const EARS: readonly Ear[] = ['wespeaker-v2', 'wespeaker-resnet293', 'titanet-large'];
/** The hearing helper's model (on the Neural Engine) - and the one a voiceprint set up before the others was made with. */
export const HELPER_EAR: Ear = 'wespeaker-v2';
/** How each is named in the log and in a test's results. */
export const EAR_NAMES: Record<Ear, string> = { 'wespeaker-v2': 'WeSpeaker v2', 'wespeaker-resnet293': 'ResNet293', 'titanet-large': 'TitaNet' };

/**
 * How much each model counts. From test voices heard four ways - as they were, through a room's echo, a headset's
 * microphone and a noisy room - weighed so, together they got half as many wrong as the small model alone (0.7% of
 * trials against 1.5%, and 1.5% at worst against 3.4%). ResNet293 is the surest of the three through echo; TitaNet
 * helps most through a headset. To be set again from the user's own recordings.
 */
export const EAR_WEIGHTS: Record<Ear, number> = { 'wespeaker-v2': 0.3, 'wespeaker-resnet293': 0.5, 'titanet-large': 0.2 };

/**
 * Where each model's bars may fall. The two WeSpeaker models score alike; TitaNet's matches run lower through echo
 * and distance (about 0.4 where the others give 0.6) - and so do other people's - so its bars sit lower.
 */
const BAR_RANGES: Record<Ear, { accept: [number, number]; reject: [number, number] }> = {
  'wespeaker-v2': { accept: [0.45, 0.62], reject: [0.25, 0.4] },
  'wespeaker-resnet293': { accept: [0.45, 0.62], reject: [0.25, 0.4] },
  'titanet-large': { accept: [0.35, 0.6], reject: [0.2, 0.38] },
};

/** A turn's voiceprints: one from each model that heard it (one that didn't answer in time has none). */
export type Prints = Partial<Record<Ear, number[]>>;

/** One model's knowledge of the user's voice: its voiceprint, one for each way they were heard, and its own bars. */
export interface EarPrint {
  print: number[];
  accept: number;
  reject: number;
  /** A voiceprint for each way the user was heard setting up: a turn matches the closest of them. */
  centroids?: { condition: Condition; print: number[] }[];
}

export interface StoredVoiceprint {
  /** 3: a voiceprint in each model (1 and 2 had the small model's alone, and are read as 3). */
  version: 3;
  ears: Partial<Record<Ear, EarPrint>>;
  /**
   * The bars a turn's match, all models together, is judged by - the models' own, weighed as they are: at or above
   * `accept` it's the user, below `reject` it isn't; between, Nova can't tell.
   */
  accept: number;
  reject: number;
  enrolled: number;
  learned: number;
  updated: string;
  /** The setup phrases' own voiceprints, in each model, so the bars can be set again and more phrases added later. */
  phrases?: Prints[];
  /** How each setup phrase was said (lined up with `phrases`). */
  conditions?: Condition[];
}

/** A voiceprint as versions 1 and 2 kept it: the small model's alone. */
export interface LegacyVoiceprint {
  /** 2: the bars come from each setup phrase against the others (1: against an average that included it). */
  version: 1 | 2;
  model: string;
  print: number[];
  accept: number;
  reject: number;
  enrolled: number;
  learned: number;
  updated: string;
  phrases?: number[][];
  conditions?: Condition[];
  centroids?: { condition: Condition; print: number[] }[];
}

/** Voice ID's models on this Mac: the hearing helper's (its folder), the worker's, and whether all of them are there. */
export interface VoiceModels {
  helper: string | null;
  worker: WorkerModel[];
  complete: boolean;
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
/**
 * The voice in the room: the user's clear turns of the last ten minutes (five at most) count as voiceprints too -
 * same microphone, same room, same day - far surer than a setup from another day. Only clear turns, never one they
 * made sure of, so they never chain.
 */
const RECENT_MS = 10 * 60_000;
const RECENT_TURNS = 5;
/** A match with the voice in the room counts this much less: through the same microphone, in the same room, anyone sounds a little more alike. */
const ROOM_MARGIN = 0.1;
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

/** One model's prints of these turns (those it made). */
const printsOf = (all: readonly Prints[], ear: Ear) => all.flatMap((p) => (p[ear]?.length ? [p[ear]!] : []));

/**
 * Each setup phrase against the average of the others: how alike a new turn in the same voice comes out. (Against
 * an average that includes the phrase itself, each looks more alike than any new turn ever will.)
 */
export function leaveOneOut(prints: readonly number[][]): number[] {
  return prints.map((p, i) => cosine(p, mean(prints.filter((_, j) => j !== i))));
}

/**
 * A model's bars from how alike the setup phrases came out, one against the others: a turn in the user's voice, said
 * another time, somewhere else, scores somewhat lower than that - so the "you" bar sits well under it. Other people
 * score far lower still (0.3 at most, as a rule, for the WeSpeaker models), so the "not you" bar stays above them.
 */
export function barsFrom(alike: readonly number[], ear: Ear = HELPER_EAR): { accept: number; reject: number } {
  const range = BAR_RANGES[ear];
  const typical = alike.reduce((s, x) => s + x, 0) / alike.length;
  const accept = clamp(typical - 0.2, ...range.accept);
  return { accept, reject: clamp(accept - 0.2, ...range.reject) };
}

/** The bars all these models' matches together are judged by: theirs, weighed as the models are. */
function barsOf(ears: StoredVoiceprint['ears']): { accept: number; reject: number } {
  let accept = 0;
  let reject = 0;
  let total = 0;
  for (const ear of EARS) {
    const e = ears[ear];
    if (!e) continue;
    accept += EAR_WEIGHTS[ear] * e.accept;
    reject += EAR_WEIGHTS[ear] * e.reject;
    total += EAR_WEIGHTS[ear];
  }
  return total ? { accept: accept / total, reject: reject / total } : { accept: 1, reject: 1 };
}

/**
 * The user's voiceprint from their setup phrases, in each model that heard at least three of them, with each model's
 * bars set by how alike its prints came out - and, when how each was said is known, a voiceprint for each way (as
 * usual, a step back, quietly, talking), to match the closest.
 */
export function enrollFrom(phrases: readonly Prints[], now = new Date(), conditions?: readonly Condition[]): StoredVoiceprint {
  const how = conditions && conditions.length === phrases.length ? [...conditions] : null;
  const ears: StoredVoiceprint['ears'] = {};
  for (const ear of EARS) {
    const taken = phrases.flatMap((p, i) => (p[ear]?.length ? [{ print: p[ear]!, condition: how?.[i] }] : []));
    if (taken.length < 3) continue;
    const prints = taken.map((t) => t.print);
    const centroids = how
      ? (['normal', 'far', 'quiet', 'free'] as const).flatMap((condition) => {
          const own = taken.filter((t) => t.condition === condition).map((t) => t.print);
          return own.length ? [{ condition, print: mean(own) }] : [];
        })
      : undefined;
    ears[ear] = { print: mean(prints), ...barsFrom(leaveOneOut(prints), ear), ...(centroids ? { centroids } : {}) };
  }
  if (phrases.length < 3 || !Object.keys(ears).length) throw new Error('Too few phrases to know a voice by.');
  return {
    version: 3,
    ears,
    ...barsOf(ears),
    enrolled: phrases.length,
    learned: 0,
    updated: now.toISOString(),
    phrases: phrases.map((p) => ({ ...p })),
    ...(how ? { conditions: how } : {}),
  };
}

/**
 * How much a turn sounds like the user, all models together. Each model's match is the closest of its voiceprints -
 * overall, each way the user was heard, and (`recent`, less a margin) their clear turns minutes ago - placed between its own bars
 * (0 at "not you", 1 at "you"); those are weighed together and put back between the voiceprint's bars, so one number
 * is judged by them. With one model it's simply that model's match. Null when no model of the voiceprint heard it.
 */
export function scoreOf(voice: StoredVoiceprint, prints: Prints, recent: readonly Prints[] = []): { score: number; ears: Partial<Record<Ear, number>> } | null {
  const ears: Partial<Record<Ear, number>> = {};
  let placed = 0;
  let total = 0;
  for (const ear of EARS) {
    const known = voice.ears[ear];
    const print = prints[ear];
    if (!known || !print?.length) continue;
    let best = cosine(known.print, print);
    for (const c of known.centroids ?? []) best = Math.max(best, cosine(c.print, print));
    for (const r of printsOf(recent, ear)) best = Math.max(best, cosine(r, print) - ROOM_MARGIN);
    ears[ear] = best;
    placed += EAR_WEIGHTS[ear] * ((best - known.reject) / Math.max(known.accept - known.reject, 0.05));
    total += EAR_WEIGHTS[ear];
  }
  if (!total) return null;
  return { score: voice.reject + (placed / total) * (voice.accept - voice.reject), ears };
}

/**
 * A voiceprint kept by an older Nova, as it's kept now. Version 1's "you" bar was the phrases' likeness to their own
 * average less 0.15; that likeness gives back how alike two of the phrases were (for n unit prints alike by r each,
 * it is √((1 + (n−1)r) / n)), and from that, how alike one is to the others - so its bars are set as a setup now
 * would have set them, without setting up again. Either way, the small model's voiceprint becomes that model's part.
 */
export function migrateVoiceprint(v: StoredVoiceprint | LegacyVoiceprint): StoredVoiceprint {
  if (v.version === 3) return v;
  let bars = { accept: v.accept, reject: v.reject };
  if (v.version === 1) {
    const n = Math.max(3, v.enrolled || 6);
    const self = clamp(v.accept + 0.15, 0, 0.999);
    const r = clamp((n * self * self - 1) / (n - 1), 0, 0.999);
    bars = barsFrom([r / Math.sqrt((1 + (n - 2) * r) / (n - 1))]);
  }
  return {
    version: 3,
    ears: { [HELPER_EAR]: { print: v.print, ...bars, ...(v.centroids ? { centroids: v.centroids } : {}) } },
    ...bars,
    enrolled: v.enrolled,
    learned: v.learned,
    updated: v.updated,
    ...(v.phrases ? { phrases: v.phrases.map((p) => ({ [HELPER_EAR]: p })) } : {}),
    ...(v.conditions ? { conditions: v.conditions } : {}),
  };
}

/** Whether a setup phrase sounds like the others so far (not a cough, a TV, another person) - the models' likeness, weighed. */
export function consistent(phrases: readonly Prints[], next: Prints): boolean {
  let alike = 0;
  let total = 0;
  for (const ear of EARS) {
    const before = printsOf(phrases, ear);
    if (!before.length || !next[ear]?.length) continue;
    alike += EAR_WEIGHTS[ear] * cosine(mean(before), next[ear]!);
    total += EAR_WEIGHTS[ear];
  }
  return total === 0 || alike / total >= 0.5;
}

/** Who said a turn: its match with the user's voiceprint (and their clear turns minutes ago), and how long it was. */
export function judge(
  voice: StoredVoiceprint,
  prints: Prints,
  seconds: number,
  recent: readonly Prints[] = [],
): { speaker: Exclude<Speaker, 'anyone'>; score: number | null; ears: Partial<Record<Ear, number>> } {
  const match = scoreOf(voice, prints, recent);
  if (!match) return { speaker: 'unsure', score: null, ears: {} };
  const { score, ears } = match;
  if (seconds < MIN_SECONDS) return { speaker: 'unsure', score, ears };
  if (score < voice.reject) return { speaker: 'not-you', score, ears };
  // A short turn needs a clearer match: little speech gives a rougher print.
  const bar = seconds < SHORT_SECONDS ? voice.accept + 0.05 : voice.accept;
  return { speaker: score >= bar ? 'you' : 'unsure', score, ears };
}

/** Why Nova couldn't place a turn, in words (score null: no voiceprint could be made of it). */
export function unsureWhy(voice: StoredVoiceprint, score: number | null, seconds: number): string {
  if (seconds < MIN_SECONDS) return 'Too short to tell - say a whole sentence.';
  if (score === null) return "No voiceprint came back in time - say it again.";
  if (seconds < SHORT_SECONDS && score >= voice.accept) return 'Close, but short: a short turn needs a clearer match.';
  return 'Between the two bars: like your voice, but not enough to be sure.';
}

/** The voiceprint, a little toward a turn of the user's, in each model that heard it: overall, and the closest of the ways they were heard. */
export function nudge(voice: StoredVoiceprint, prints: Prints): StoredVoiceprint {
  const ears: StoredVoiceprint['ears'] = { ...voice.ears };
  for (const ear of EARS) {
    const known = voice.ears[ear];
    const print = prints[ear];
    if (!known || !print?.length) continue;
    const toward = (v: readonly number[]) => unit(v.map((x, i) => (1 - LEARN_RATE) * x + LEARN_RATE * print[i]!));
    const closest = (known.centroids ?? []).reduce<number>((best, c, i, all) => (best < 0 || cosine(c.print, print) > cosine(all[best]!.print, print) ? i : best), -1);
    ears[ear] = { ...known, print: toward(known.print), ...(known.centroids ? { centroids: known.centroids.map((c, i) => (i === closest ? { ...c, print: toward(c.print) } : c)) } : {}) };
  }
  return { ...voice, ears, learned: voice.learned + 1, updated: new Date().toISOString() };
}

/** A turn that was clearly the user, long enough to trust: the voiceprint moves a little toward it. */
export function learnFrom(voice: StoredVoiceprint, prints: Prints, score: number, seconds: number): StoredVoiceprint | null {
  if (seconds < SHORT_SECONDS || score < voice.accept + 0.05) return null;
  return nudge(voice, prints);
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

/** Each model's match, for the log: " (WeSpeaker v2 0.68, ResNet293 0.74, TitaNet 0.52)" - nothing when only one heard it. */
const earsLine = (ears: Partial<Record<Ear, number>>) => {
  const each = EARS.filter((ear) => ears[ear] !== undefined);
  return each.length > 1 ? ` (${each.map((ear) => `${EAR_NAMES[ear]} ${ears[ear]!.toFixed(2)}`).join(', ')})` : '';
};
const rounded = (ears: Partial<Record<Ear, number>>) => Object.fromEntries(Object.entries(ears).map(([ear, s]) => [ear, Math.round(s * 1000) / 1000]));

/** The user's voiceprint on disk: read once, written as it changes (at most every so often while learning). */
export class VoiceprintStore {
  private voice: StoredVoiceprint | null = null;
  private dirty = 0;
  /** Writes, one after another: two at once would race through the same temporary file. */
  private writing: Promise<void> = Promise.resolve();

  /** `legacyModel`: the model a voiceprint of versions 1 and 2 must have been made with to be read. */
  constructor(
    private readonly file: string,
    private readonly legacyModel: string = HELPER_EAR,
  ) {}

  async load(): Promise<StoredVoiceprint | null> {
    try {
      const v = JSON.parse(await readFile(this.file, 'utf8')) as StoredVoiceprint | LegacyVoiceprint;
      // A voiceprint of another model (or a broken file) can't be compared with what the models make now.
      const legacy = (v?.version === 1 || v?.version === 2) && v.model === this.legacyModel && Array.isArray(v.print) && v.print.length > 0;
      const current = v?.version === 3 && EARS.some((ear) => Array.isArray(v.ears?.[ear]?.print) && v.ears[ear]!.print.length > 0);
      if (current) v.ears = Object.fromEntries(EARS.filter((ear) => v.ears[ear]?.print?.length).map((ear) => [ear, v.ears[ear]!]));
      this.voice = legacy || current ? migrateVoiceprint(v) : null;
      // Kept the old way: kept the new way from now on.
      if (legacy) await this.write().catch(() => {});
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

/** What Settings shows of Voice ID: the models, whether there's a voiceprint (never the print), setup, a test. */
export type VoiceIdStatus = SettingsSnapshot['voiceId'];

/** Setting up (or improving), under way. */
interface Enrolling {
  steps: EnrollStep[];
  at: number;
  /** What was taken this time, and how each was said. */
  prints: Prints[];
  conditions: Condition[];
  done: VoiceEnrollStep[];
  /** Improving: what was learned before, which this adds to. */
  base: StoredVoiceprint | null;
  /** The check at the end: the voiceprint as it stands, checks so far, and how many came out as the user in a row. */
  candidate: StoredVoiceprint | null;
  checks: number;
  inARow: number;
  /** A phrase unlike the rest, kept in case the rest (one phrase so far) was the odd one out. */
  missed: { prints: Prints; condition: Condition } | null;
}

const statsOf = (q: Quality | null) => (q ? { level: q.level, snr: q.snr, speech: q.speech } : {});

/**
 * Voice ID for the daemon: setting it up (the user reads a few phrases), deciding whose each turn is,
 * learning from the clear ones, and testing it. Hearing asks it; Settings and the setup checklist read `status()`.
 */
export class VoiceId {
  private enrolling: Enrolling | null = null;
  /** The last turn Voice ID couldn't place, in case the user says it again with the talk shortcut. */
  private unsure: { prints: Prints; seconds: number; at: number; text: string } | null = null;
  private message: string | undefined;
  /** A voice test: its results so far, newest first - null when none is running. */
  private testing: VoiceTestResult[] | null = null;
  private testTimer: ReturnType<typeof setTimeout> | undefined;
  /** When a turn was last clearly the user's, for a short one right after it. */
  private youAt = 0;
  /** The voice in the room: the user's clear turns of the last few minutes, newest first. */
  private recent: { at: number; prints: Prints }[] = [];

  constructor(
    private readonly opts: {
      store: VoiceprintStore;
      label: string;
      /** What installing downloads ("223 MB"). */
      size?: string;
      /** Voice ID's models on this Mac (null: none of them). */
      models: () => Promise<VoiceModels | null>;
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
      /** Recordings of the user's turns, kept (for a week) only when they switched that on. */
      recordings?: { keep(recording: Recording): void };
      /** A voiceprint was made: switch Voice ID on in Settings. */
      turnOn: () => Promise<void>;
      /** Something changed that Settings shows. */
      changed: () => void;
      now?: () => number;
    },
  ) {}

  private models: VoiceModels | null = null;

  /** Find the models (after an install, say). */
  async refresh() {
    this.models = await this.opts.models();
  }

  /** The models to take voiceprints with - when setting up, testing, or deciding whose turns are - or null. */
  active(): VoiceModels | null {
    if (!this.models) return null;
    if (this.enrolling || this.testing) return this.models;
    return this.opts.enabled() && this.opts.store.current ? this.models : null;
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  /** The user's clear turns of the last few minutes. */
  private inTheRoom(now: number): Prints[] {
    return this.recent.filter((r) => now - r.at < RECENT_MS).map((r) => r.prints);
  }

  private heardClearly(prints: Prints, now: number) {
    this.recent = [{ at: now, prints }, ...this.recent.filter((r) => now - r.at < RECENT_MS)].slice(0, RECENT_TURNS);
  }

  /** A recording of this, when the user keeps them. */
  private keep(kind: RecordingKind, audio: Int16Array | undefined, about: Omit<Recording, 'kind' | 'audio' | 'heardBy'>) {
    if (audio?.length) this.opts.recordings?.keep({ kind, audio, ...about, ...(this.opts.ear ? { heardBy: this.opts.ear() } : {}) });
  }

  /**
   * Whose a turn was. A turn that sounds like the user's clear ones minutes ago counts as theirs - same microphone,
   * same room - and so does a short one moments after a clear one - unless it clearly isn't - but only a clear turn
   * does either, so neither chains. A long turn with no print stays unsure. Each turn's decision goes to the log with
   * its match (each model's too), length and ear, and to the recordings when kept; `learn: false` (a glance at the
   * start of a turn, talking over Nova) neither logs, learns, keeps nor counts as a clear turn.
   */
  decide(prints: Prints | null, seconds: number, opts: { learn?: boolean; text?: string; audio?: Int16Array; overlapped?: boolean } = {}): Speaker | undefined {
    const voice = this.opts.store.current;
    if (!voice || !this.opts.enabled() || !this.models) return undefined;
    const now = this.now();
    const clock = new Date(now).toTimeString().slice(0, 8);
    if (this.overridden()) {
      if (opts.learn !== false) console.log(`  [voice-id] ${clock} anyone · ${seconds.toFixed(1)} s · off since the master keyword was said`);
      return 'anyone';
    }
    const plain = prints ? judge(voice, prints, seconds) : null;
    const room = this.inTheRoom(now);
    const judged = prints && room.length ? judge(voice, prints, seconds, room) : plain;
    const score = judged?.score ?? null;
    let speaker: Speaker = judged?.speaker ?? 'unsure';
    let why = '';
    const short = seconds < SHORT_SECONDS;
    if (speaker === 'you' && plain?.speaker !== 'you') {
      why = `sounds like you ${Math.round((now - this.recent[0]!.at) / 1000)} s ago`;
    } else if (speaker === 'unsure' && short && now - this.youAt < FOLLOWS_MS && (score === null || score >= voice.reject)) {
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
            : short && score >= voice.accept
              ? `short: needs ${(voice.accept + 0.05).toFixed(2)}`
              : `between ${voice.reject.toFixed(2)} and ${voice.accept.toFixed(2)}`;
    }
    if (opts.learn === false) return speaker;
    // Can't place it, though it's long enough to learn from: if the user says it again with the shortcut, it was theirs.
    if (speaker === 'unsure' && prints && seconds >= SHORT_SECONDS) this.unsure = { prints, seconds, at: now, text: opts.text ?? '' };
    const ears = judged?.ears ?? {};
    console.log(`  [voice-id] ${clock} ${speaker}${score === null ? '' : ` ${score.toFixed(2)}`}${earsLine(ears)} · ${seconds.toFixed(1)} s${why ? ` · ${why}` : ''}${this.opts.ear ? ` · heard by ${this.opts.ear()}` : ''}`);
    this.keep('turn', opts.audio, { text: opts.text ?? '', seconds, speaker, score, scores: rounded(ears), ...(why ? { why } : {}), ...(opts.overlapped ? { overlapped: true } : {}) });
    if (speaker === 'you' && !why && prints && plain?.score != null) {
      this.youAt = now;
      this.heardClearly(prints, now);
      if (this.opts.learning()) {
        const next = learnFrom(voice, prints, plain.score, seconds);
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

  /** Start setting up (again): the models must be on this Mac. */
  async start(): Promise<string> {
    return this.begin(ENROLL_STEPS(this.opts.name()), null);
  }

  /** Improve my voice: a few more phrases, added to what was learned before - without setting up again. */
  async improve(): Promise<string> {
    const voice = this.opts.store.current;
    if (!voice?.phrases?.length) throw new Error('This voiceprint was set up before its phrases were kept - set it up again (Learn it again) to improve it later.');
    if (this.missingEars(voice).length) throw new Error('Voice ID has models your voiceprint was made without - set it up again (Learn it again), so each of them knows your voice.');
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
    this.recent = [];
    this.youAt = 0;
    await this.opts.store.forget();
    await this.opts.keyword?.restore(); // nothing left to be off: a new setup starts with Voice ID on
    this.opts.changed();
  }

  /** Setting up or testing: the turn is for Voice ID, not for Nova. True when it took it. */
  claim(prints: Prints | null, seconds: number, text: string, audio?: Int16Array): boolean {
    if (this.enrolling) return this.enroll(prints, seconds, text, audio);
    if (this.testing) return this.tested(prints, seconds, text, audio);
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

  private tested(prints: Prints | null, seconds: number, text: string, audio?: Int16Array): boolean {
    const voice = this.opts.store.current;
    if (!voice || !this.testing) return false;
    const { speaker, score, ears } = prints ? judge(voice, prints, seconds) : { speaker: 'unsure' as const, score: null, ears: {} as Partial<Record<Ear, number>> };
    const name = this.opts.name();
    const verdict =
      speaker === 'you'
        ? `That's you - ${name} would answer.`
        : speaker === 'not-you'
          ? `Not you - ${name} would ignore it.`
          : `Can't tell - ${name} would ask you to hold ${this.opts.shortcut?.() ?? 'the talk shortcut'} and say it again.`;
    const each = EARS.filter((ear) => ears[ear] !== undefined);
    const result: VoiceTestResult = {
      speaker,
      score: score === null ? null : Math.round(score * 1000) / 1000,
      seconds: Math.round(seconds * 10) / 10,
      heard: text.trim().slice(0, 140),
      verdict,
      ...(speaker === 'unsure' ? { why: unsureWhy(voice, score, seconds) } : {}),
      ...(each.length > 1 ? { models: each.map((ear) => ({ name: EAR_NAMES[ear], score: Math.round(ears[ear]! * 100) / 100 })) } : {}),
      at: new Date(this.now()).toISOString(),
    };
    this.testing = [result, ...this.testing].slice(0, TEST_RESULTS);
    this.keep('test', audio, { text, seconds, speaker, score, scores: rounded(ears) });
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
  enroll(prints: Prints | null, seconds: number, text: string, audio?: Int16Array): boolean {
    const e = this.enrolling;
    if (!e) return false;
    const step = e.steps[e.at]!;
    const quality = audio ? speechQuality(audio, step.kind === 'free' ? FREE_SPEECH : PHRASE_SPEECH) : null;
    const record = (entry: Omit<VoiceEnrollStep, 'say' | 'kind'>) => {
      e.done = [...e.done, { say: step.say, kind: step.kind, ...entry }].slice(-24);
      this.keep(step.kind === 'check' ? 'check' : 'setup', audio, { text, seconds, ok: entry.ok, ...(entry.why ? { why: entry.why } : {}), ...(entry.score !== undefined ? { score: entry.score } : {}) });
    };
    const again = (why: string) => {
      record({ ok: false, why, ...statsOf(quality) });
      this.message = why;
      this.opts.changed();
      return true;
    };
    if (!prints) return again('That was too short to learn from - say the whole phrase.');
    if (quality && !quality.ok) return again(quality.problems[0]!);
    if (!quality && seconds < PHRASE_SPEECH) return again('That was too short to learn from - say the whole phrase.');
    if (step.kind === 'check') return this.checked(e, prints, seconds, quality, record);
    if (!consistent(this.everything(e), prints)) {
      if (e.prints.length === 1 && !e.base && e.missed && consistent([e.missed.prints], prints)) {
        // Twice in a row alike, and unlike the first phrase: that one was the odd one out (a cough, a TV).
        e.prints = [e.missed.prints];
        e.conditions = [e.missed.condition];
      } else {
        e.missed = { prints, condition: step.kind };
        return again("That didn't sound like the others - somewhere quieter, and just you, then say it again.");
      }
    }
    e.prints.push(prints);
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
    const voice = enrollFrom(this.everything(e), new Date(this.now()), how);
    return { ...voice, learned: e.base?.learned ?? 0 };
  }

  private checked(e: Enrolling, prints: Prints, seconds: number, quality: Quality | null, record: (entry: Omit<VoiceEnrollStep, 'say' | 'kind'>) => void): boolean {
    const candidate = e.candidate ?? this.build(e);
    const { speaker, score } = judge(candidate, prints, seconds);
    if (score === null) {
      record({ ok: false, why: 'No voiceprint came back in time - say it again.', ...statsOf(quality) });
      this.opts.changed();
      return true;
    }
    const match = Math.round(score * 100) / 100;
    e.checks++;
    if (speaker === 'you') {
      e.inARow++;
      record({ ok: true, score: match, ...statsOf(quality) });
    } else {
      e.inARow = 0;
      // Still the user, if not clearly enough: learned from - unless it didn't sound like them at all.
      const theirs = consistent(this.everything(e), prints);
      if (theirs) {
        e.prints.push(prints);
        e.conditions.push('normal');
        e.candidate = this.build(e);
      }
      record({
        ok: false,
        score: match,
        why: theirs ? `Not quite yet (${match.toFixed(2)}, it needs ${candidate.accept.toFixed(2)}) - learned from it. Another one, please.` : "That didn't sound like you - just your voice, please.",
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
    this.recent = []; // placed by the voiceprint before this one
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
   * it clearly sounds like someone else), counts as the voice in the room, and so does an unsure turn just before it
   * that said the same thing.
   */
  confirmed(prints: Prints | null, seconds: number, text: string, audio?: Int16Array) {
    const voice = this.opts.store.current;
    if (!voice || !this.opts.enabled() || !this.models || this.overridden()) return;
    const now = this.now();
    const match = prints ? scoreOf(voice, prints) : null;
    this.keep('shortcut', audio, { text, seconds, score: match?.score ?? null, scores: rounded(match?.ears ?? {}) });
    if (prints && match && match.score >= voice.reject && seconds >= MIN_SECONDS) this.heardClearly(prints, now);
    if (!this.opts.learning()) return;
    let next = voice;
    const taught: string[] = [];
    const teach = (p: Prints | null, s: number) => {
      if (!p || s < SHORT_SECONDS) return;
      const score = scoreOf(next, p)?.score;
      if (score === undefined || score < next.reject) return;
      next = nudge(next, p);
      taught.push(score.toFixed(2));
    };
    teach(prints, seconds);
    const before = this.unsure;
    this.unsure = null;
    if (before && now - before.at < CONFIRM_MS && sameRequest(before.text, text)) teach(before.prints, before.seconds);
    if (!taught.length) return;
    console.log(`  [voice-id] learned from ${taught.length === 2 ? 'an unsure turn and the shortcut turn that said it again' : 'a turn said with the shortcut'} (${taught.join(', ')})`);
    void this.opts.store.learned(next).catch((err) => console.warn(`  [voice-id] couldn't keep what it learned: ${(err as Error).message}`));
  }

  /** The models on this Mac that the voiceprint was made without: they'd know the user's voice after setting up again. */
  private missingEars(voice: StoredVoiceprint): Ear[] {
    const installed: Ear[] = [...(this.models?.helper ? [HELPER_EAR] : []), ...(this.models?.worker.map((m) => m.ear as Ear) ?? [])];
    return installed.filter((ear) => !voice.ears[ear]);
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
    const missing = voice && !this.enrolling ? this.missingEars(voice) : [];
    const upgrade = missing.length
      ? `Voice ID hears with ${missing.length === 1 ? 'another model' : `${missing.length} more models`} now - Learn it again, so ${missing.length === 1 ? 'it knows' : 'they know'} your voice too. Until then it listens with the one it had.`
      : undefined;
    const message = this.message ?? upgrade;
    return {
      installed: Boolean(this.models?.complete),
      label: this.opts.label,
      ...(this.opts.size ? { size: this.opts.size } : {}),
      enrolled: voice !== null,
      on: Boolean(voice && this.opts.enabled() && this.models),
      learned: voice?.learned ?? 0,
      enrolling: this.enrollingStatus(),
      improvable: Boolean(voice?.phrases?.length) && !missing.length,
      testing: this.testing ? { results: [...this.testing] } : null,
      bars: voice ? { accept: voice.accept, reject: voice.reject } : null,
      keyword: { set: Boolean(this.opts.keyword?.isSet), overriddenAt: this.opts.keyword?.overriddenAt ?? null },
      ...(message ? { message } : {}),
    };
  }
}
