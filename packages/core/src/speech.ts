/**
 * Speech helpers for any voice shell: turning a browser's speech-recognition pieces into whole
 * utterances. Dependency-free, so shells can import it.
 */

/** Words a sentence almost never ends on: hearing one last means the speaker isn't done. */
const DANGLING = new Set(
  "a an the to of for with in on at by from into about and or but because if than which who when where my your his her our their its i i'm we they he she want wanna need let let's like just really also then um uh er hmm".split(' '),
);
/** Only fillers so far ("okay so", "um"): the real request is still coming. */
const FILLERS_ONLY = /^(?:(?:okay|ok|so|well|um|uh|er|hmm|right|alright|and|like)[\s,.]*)+$/i;

/** Whether speech so far sounds cut off mid-thought ("in my current project I want to let"). */
export function soundsUnfinished(text: string) {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').trim().split(/\s+/);
  return DANGLING.has(words.at(-1) ?? '') || FILLERS_ONLY.test(text.trim()) || text.trim().endsWith(',');
}

/**
 * Joins speech-recognition results into whole utterances. Browsers finalize at every short pause,
 * so a sentence can arrive in pieces. Each piece is held a moment - longer when it sounds
 * unfinished, and for as long as more speech is coming - then sent as one utterance.
 */
export class UtteranceAssembler {
  private parts: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (text: string) => void,
    private readonly waits = { done: 500, unfinished: 2000, speaking: 4000 },
  ) {}

  /** A finished piece of speech. */
  final(text: string) {
    if (text.trim()) this.parts.push(text.trim());
    this.wait(soundsUnfinished(this.text) ? this.waits.unfinished : this.waits.done);
  }

  /** More speech is being heard: hold on until it's finished too. */
  interim() {
    if (this.parts.length) this.wait(this.waits.speaking);
  }

  /** What's been heard so far. */
  get text() {
    return this.parts.join(' ');
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const text = this.text.trim();
    this.parts = [];
    if (text) this.send(text);
  }

  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.parts = [];
  }

  private wait(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), ms);
  }
}

// --- Hearing on the Mac: speech activity, turn-taking and echo --------------------------

/**
 * Speech or silence, from the audio's loudness against the room's own noise. Takes 16 kHz 16-bit
 * PCM in any size of chunk and reads it in 20 ms frames: speech starts after a few loud frames and
 * ends after a short run of quiet ones, so a word's small gaps don't split it.
 */
export class SpeechActivity {
  private floor = -70;
  private speaking = false;
  private run = 0;
  private pending: number[] = [];
  /** Loudness of the latest frame, 0 to 1, for level meters. */
  level = 0;

  constructor(private readonly opts = { onset: 3, hangover: 12, margin: 14, minimum: -50 }) {}

  get active() {
    return this.speaking;
  }

  /** Feed audio; returns 'start' or 'end' when speech starts or stops within it. */
  push(samples: Int16Array): 'start' | 'end' | null {
    let change: 'start' | 'end' | null = null;
    for (let i = 0; i < samples.length; i++) {
      this.pending.push(samples[i]!);
      if (this.pending.length < 320) continue;
      const frame = this.pending;
      this.pending = [];
      const event = this.frame(frame);
      if (event) change = change && change !== event ? null : event; // started and stopped within one chunk: no change
    }
    return change;
  }

  private frame(frame: number[]): 'start' | 'end' | null {
    let sum = 0;
    for (const s of frame) sum += s * s;
    const db = 10 * Math.log10(sum / frame.length / 1_073_741_824 + 1e-12);
    this.level = Math.min(1, Math.max(0, (db + 60) / 45));
    // The noise floor follows quiet quickly and steady noise slowly, and holds still during speech.
    if (!this.speaking) this.floor = db < this.floor ? 0.8 * this.floor + 0.2 * db : 0.998 * this.floor + 0.002 * db;
    const threshold = Math.max(this.floor + this.opts.margin, this.opts.minimum);
    const loud = db > (this.speaking ? threshold - 4 : threshold);
    if (loud === this.speaking) {
      this.run = 0;
      return null;
    }
    this.run++;
    if (!this.speaking && this.run >= this.opts.onset) {
      this.speaking = true;
      this.run = 0;
      return 'start';
    }
    if (this.speaking && this.run >= this.opts.hangover) {
      this.speaking = false;
      this.run = 0;
      return 'end';
    }
    return null;
  }
}

export type Patience = 'quick' | 'normal' | 'patient';

/** After speech stops: how long Nova waits (ms) when the words sound complete, and when they trail off. */
export const PATIENCE: Record<Patience, { done: number; unfinished: number }> = {
  quick: { done: 200, unfinished: 1100 },
  normal: { done: 400, unfinished: 1700 },
  patient: { done: 750, unfinished: 2500 },
};

export interface TurnClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: TurnClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Decides when the user has finished a turn - said what they wanted and paused for Nova to act.
 * After speech stops it waits a moment when the words sound complete, and longer when they trail
 * off ("I want to…"). A `judge` (Smart Turn, which hears tone as well as words) can end the wait
 * early or stretch it. Speech resuming carries on the same turn.
 */
/** The longest a turn may run while the talk shortcut is held. */
const HELD_MAX_MS = 120_000;

export class TurnDetector {
  private speaking = false;
  private heard = false;
  /** The talk shortcut is held down: the turn lasts until it's let go. */
  private held = false;
  private words = '';
  private silentSince = 0;
  private startedAt = 0;
  private verdict: number | null = null;
  private episode = 0;
  private timer: unknown = null;

  constructor(
    private readonly end: () => void,
    private readonly opts: { patience?: Patience; judge?: () => Promise<number | null>; maxTurnMs?: number } = {},
    private readonly clock: TurnClock = realClock,
  ) {}

  /** The speech detector says speech started (true) or stopped (false). */
  speech(active: boolean) {
    if (active) {
      if (!this.heard) this.startedAt = this.clock.now();
      this.speaking = this.heard = true;
      this.episode++; // a verdict on the last silence no longer counts
      this.verdict = null;
      // A very long turn is cut - later while the shortcut is held, since the user said when they'd finish.
      this.schedule(this.startedAt + (this.held ? HELD_MAX_MS : (this.opts.maxTurnMs ?? 30_000)) - this.clock.now());
      return;
    }
    if (!this.speaking) return;
    this.speaking = false;
    this.silentSince = this.clock.now();
    const episode = ++this.episode;
    this.verdict = null;
    this.plan();
    this.opts
      .judge?.()
      .then((p) => {
        if (episode !== this.episode || this.speaking || p === null) return;
        this.verdict = p;
        this.plan();
      })
      .catch(() => {});
  }

  /** The words heard so far in this turn. */
  text(words: string) {
    this.words = words;
    if (this.heard && !this.speaking) this.plan();
  }

  /** Whether a turn is under way (speech heard since the last hand-over). */
  get open() {
    return this.heard;
  }

  /** The talk shortcut went down: pauses don't end the turn until it's let go. */
  hold() {
    this.held = true;
    if (!this.speaking) this.clear();
  }

  /**
   * The talk shortcut came up. `finish`: the user held it through what they said, so the turn ends
   * now. Otherwise (a tap) the turn ends the usual way, when they pause.
   */
  release(finish: boolean) {
    if (!this.held) return;
    this.held = false;
    if (finish && this.heard) {
      this.clear();
      this.heard = false; // ends once, as below
      this.end();
    } else if (this.heard && !this.speaking) this.plan();
  }

  /** The turn was handed over, or dropped: start afresh (a shortcut still held stays held). */
  reset() {
    this.clear();
    this.speaking = false;
    this.heard = false;
    this.words = '';
    this.verdict = null;
    this.episode++;
  }

  private plan() {
    if (this.held) return this.clear(); // they'll say when they're done
    const { done, unfinished } = PATIENCE[this.opts.patience ?? 'normal'];
    const trailing = soundsUnfinished(this.words);
    const p = this.verdict;
    let wait: number;
    if (p === null) wait = trailing ? unfinished : done;
    else if (p >= 0.5) wait = trailing ? Math.round(unfinished * 0.6) : Math.min(done, 150); // it hears they're done
    else if (p >= 0.3) wait = Math.round((done + unfinished) / 2);
    else wait = unfinished; // it hears more coming
    this.schedule(this.silentSince + wait - this.clock.now());
  }

  private schedule(ms: number) {
    this.clear();
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (!this.heard) return;
      this.heard = false; // ends once; the owner calls reset() once the turn is handed over
      this.end();
    }, Math.max(0, ms));
  }

  private clear() {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}

const WORDS = /[\p{L}\p{N}']+/gu;

/** Whether heard words are mostly what Nova itself was saying - its own voice reaching the microphone. */
export function isEcho(heard: string, spoken: string) {
  const words = heard.toLowerCase().match(WORDS) ?? [];
  if (!words.length) return false;
  const said = new Set(spoken.toLowerCase().match(WORDS) ?? []);
  return words.filter((w) => said.has(w)).length / words.length >= 0.6;
}

/** Words that stop Nova mid-sentence on their own. */
const STOP_WORDS = new Set(['stop', 'wait', 'cancel', 'enough', 'quiet', 'shh', 'hush', 'pause', 'nova', 'no']);

/**
 * Whether what's being heard while Nova speaks is the user talking over it: two or more words
 * that aren't Nova's own, or a word that means stop.
 */
export function isBargeIn(heard: string, spoken: string) {
  const words = heard.toLowerCase().match(WORDS) ?? [];
  if (!words.length) return false;
  if (STOP_WORDS.has(words[0]!)) return true;
  return words.length >= 2 && !isEcho(heard, spoken);
}
