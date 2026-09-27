import { isBargeIn, isEcho, SpeechActivity, TurnDetector, type HearingStatus, type Patience } from '@nova/core';
import { platform } from 'node:os';
import { join } from 'node:path';
import { isInstalled, modelsDir, PARAKEET_MODEL } from '../models/files.ts';
import { ensureHelper } from './build.ts';
import { HearingHelper, type HelperEvent } from './helper.ts';
import { SmartTurn } from './smart-turn.ts';

export type HearingEngine = 'auto' | 'apple' | 'parakeet' | 'browser';

export interface HearingConfig {
  engine: HearingEngine;
  /** BCP 47, e.g. "en-US". */
  language: string;
  patience: Patience;
  smartTurn: boolean;
  bargeIn: boolean;
}

export interface HearingEvents {
  status(status: HearingStatus): void;
  /** Words heard so far (`final` false), or the finished turn. */
  transcript(text: string, final: boolean): void;
  /** A finished turn, for Nova to act on - `explicit` when it was said to Nova with the talk shortcut. */
  utterance(text: string, explicit: boolean): void;
  /** The user started talking over Nova. */
  bargeIn(): void;
}

const RATE = 16_000;
const MAX_RESTARTS = 3;
/** A tap of the talk shortcut makes the next turn Nova's for this long; nothing said by then, it lapses. */
const ARMED_MS = 8000;
/** Let go without a word: a moment for the speech detector to catch up, then the turn lapses. */
const ARMED_AFTER_HOLD_MS = 1500;

/** The hearing helper, as the service uses it. */
type Helper = Pick<HearingHelper, 'command' | 'audio' | 'close'>;

/** The last 30 s of audio, so Smart Turn can hear the turn so far. */
class AudioRing {
  private readonly data = new Int16Array(RATE * 30);
  /** Samples written since the start. */
  position = 0;

  push(samples: Int16Array) {
    const n = this.data.length;
    for (let i = 0; i < samples.length; i++) this.data[(this.position + i) % n] = samples[i]!;
    this.position += samples.length;
  }

  /** Audio from an absolute position until now (as much of it as is kept). */
  since(from: number): Int16Array {
    const n = this.data.length;
    const start = Math.max(from, this.position - n, 0);
    const out = new Int16Array(this.position - start);
    for (let i = 0; i < out.length; i++) out[i] = this.data[(start + i) % n]!;
    return out;
  }
}

/**
 * Nova's hearing on the Mac. The window streams its microphone; this finds speech in it, relays
 * it to the hearing helper (Apple's recognizer or Parakeet), decides when each turn is over -
 * pauses, words, and Smart Turn's ear for tone - and hands finished turns to Nova. It also lets the
 * user talk over Nova, and never mistakes Nova's own voice for theirs.
 */
export class Hearing {
  status: HearingStatus = { engine: 'browser', state: 'ready' };
  private config: HearingConfig | null = null;
  private helper: Helper | null = null;
  /** Where the running helper's audio began in the ring: it counts from its own start, so positions sent to it are from there. */
  private helperFrom = 0;
  private smart: SmartTurn | null = null;
  private smartStarting: Promise<void> | null = null;
  private smartRestarts = 0;
  private vad = new SpeechActivity();
  private readonly ring = new AudioRing();
  private readonly turnOpts: { patience: Patience; judge: () => Promise<number | null> };
  private readonly turn: TurnDetector;
  private turnId = 0;
  /** Where the current turn's audio began. */
  private turnStart = 0;
  private vocabulary: string[] = [];
  private wakeWords: string[] = [];
  /** What Nova is saying now (null when it isn't), and what it said last. */
  private spoken: string | null = null;
  private lastSpoken = '';
  private spokeUntil = 0;
  /** The current turn began while Nova was speaking, and whether it has stopped Nova. */
  private overlapping = false;
  private interrupted = false;
  private restarts = 0;
  /** The talk shortcut went down: the next turn is for Nova (no wake word needed, never taken for its echo). */
  private armed = false;
  /** Ends `armed` when no turn followed the shortcut. */
  private armTimer: ReturnType<typeof setTimeout> | undefined;
  /** Turns that were ended while armed, until their text comes back. */
  private readonly explicitTurns = new Set<number>();
  /** Bumped on every (re)start, so a replaced helper's events are ignored. */
  private generation = 0;

  constructor(private readonly events: HearingEvents) {
    this.turnOpts = {
      patience: 'normal',
      judge: () => (this.smart && this.config?.smartTurn ? this.smart.judge(this.ring.since(this.turnStart)) : Promise.resolve(null)),
    };
    this.turn = new TurnDetector(() => this.endTurn(), this.turnOpts);
  }

  /** Apply settings: the engine restarts only when it (or the language) changes. */
  configure(config: HearingConfig, vocabulary: string[], wakeWords: string[] = []) {
    const previous = this.config;
    this.config = config;
    this.turnOpts.patience = config.patience;
    this.setVocabulary(vocabulary);
    this.setWakeWords(wakeWords);
    if (config.smartTurn) {
      this.smartRestarts = 0;
      this.startSmart();
    } else if (this.smart) {
      this.smart.close();
      this.smart = null;
    }
    if (!previous || previous.engine !== config.engine || previous.language !== config.language) {
      this.restarts = 0;
      void this.restart();
    }
  }

  /** Start the engine afresh (after installing a model it was waiting for). */
  retry() {
    this.restarts = 0;
    void this.restart();
  }

  /** The wake words: a misheard one ("No, open Slack") is recovered from the recognizer's alternatives. */
  setWakeWords(words: string[]) {
    const next = words.map((w) => w.trim().toLowerCase()).filter(Boolean);
    if (next.join('\n') === this.wakeWords.join('\n')) return;
    this.wakeWords = next;
    this.helper?.command({ type: 'wake', words: next });
  }

  /** Names worth recognising: apps, agents, projects, the wake words. */
  setVocabulary(words: string[]) {
    const next = [...new Set(words.map((w) => w.trim()).filter(Boolean))].slice(0, 500);
    if (next.join('\n') === this.vocabulary.join('\n')) return;
    this.vocabulary = next;
    this.helper?.command({ type: 'vocabulary', words: next });
  }

  /** Whether the window should stream its microphone here (rather than use its own recognition). */
  get listening() {
    return this.status.engine !== 'browser' && this.status.state === 'ready';
  }

  /** Microphone audio from the window: 16 kHz mono 16-bit PCM. */
  audio(pcm: Buffer) {
    if (!this.helper || !this.listening || pcm.length < 2) return;
    const bytes = pcm.length & ~1;
    const samples = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + bytes)); // aligned copy
    this.ring.push(samples);
    this.helper.audio(pcm.subarray(0, bytes));
    const change = this.vad.push(samples);
    if (!change) return;
    const active = change === 'start';
    const at = this.helperMs(); // ms of the helper's audio so far
    if (active && !this.turn.open) {
      // A new turn: whatever was transcribed before it (murmurs below the speech threshold) is dropped.
      this.turnStart = Math.max(0, this.ring.position - RATE / 2);
      this.overlapping = this.spoken !== null;
      this.interrupted = false;
      clearTimeout(this.armTimer); // after the shortcut: this turn is the one it was for
      this.helper.command({ type: 'cancel', at: Math.max(0, at - 300) });
    }
    this.helper.command({ type: 'speech', active, at: active ? Math.max(0, at - 60) : at });
    this.turn.speech(active);
  }

  /**
   * The talk shortcut went down: a turn for Nova starts now, before the speech detector even hears
   * it, and pauses don't end it while the key is held. Anything heard before it is dropped.
   */
  hold() {
    this.armed = true;
    clearTimeout(this.armTimer); // held: it lasts until the key comes up
    this.turn.hold();
    if (this.turn.open) return; // they were already talking: that turn is theirs now
    this.turnStart = this.ring.position;
    this.overlapping = false;
    this.interrupted = false;
    this.helper?.command({ type: 'cancel', at: this.helperMs() });
  }

  /**
   * The shortcut came up: held through what they said, the turn ends now; tapped, it ends when they
   * pause. Nothing said, the next turn is Nova's only for a few seconds - never for good.
   */
  release(finish: boolean) {
    this.turn.release(finish);
    if (this.armed && !this.turn.open) {
      clearTimeout(this.armTimer);
      this.armTimer = setTimeout(() => this.disarm(), finish ? ARMED_AFTER_HOLD_MS : ARMED_MS);
    }
  }

  /** Stop listening for Nova (the shortcut tapped again): the turn in progress is dropped. */
  drop() {
    this.disarm();
    this.turn.release(false);
    this.turn.reset();
    this.helper?.command({ type: 'cancel', at: this.helperMs() });
  }

  /** The window stopped streaming: drop the turn in progress. */
  pause() {
    this.disarm();
    this.turn.reset();
    this.helper?.command({ type: 'cancel', at: this.helperMs() });
    this.vad = new SpeechActivity();
  }

  /** Nova is saying this (its reply so far), or null once it has finished speaking. */
  setSpoken(text: string | null) {
    if (text === null) {
      if (this.spoken !== null) this.spokeUntil = Date.now();
      this.spoken = null;
    } else {
      this.spoken = text;
      this.lastSpoken = text;
    }
  }

  close() {
    this.generation++;
    this.disarm();
    this.helper?.close();
    this.helper = null;
    this.smart?.close();
    this.smart = null;
  }

  private setStatus(status: HearingStatus) {
    this.status = status;
    this.events.status(status);
  }

  /** A point of the audio (now, by default) in ms of what the running helper has been sent. */
  private helperMs(position = this.ring.position) {
    return Math.max(0, Math.round((position - this.helperFrom) / 16));
  }

  /** The shortcut's turn is over, or never came. */
  private disarm() {
    clearTimeout(this.armTimer);
    this.armTimer = undefined;
    this.armed = false;
  }

  /** Smart Turn's process, when Settings want it - started again if it stops, a few times. */
  private startSmart() {
    if (this.smart || this.smartStarting) return;
    this.smartStarting = SmartTurn.start((gone) => {
      if (this.smart !== gone) return;
      this.smart = null; // turn-taking goes on without it meanwhile
      if (this.config?.smartTurn && this.smartRestarts++ < MAX_RESTARTS) setTimeout(() => this.config?.smartTurn && this.startSmart(), 5000 * this.smartRestarts);
    })
      .then((smart) => {
        if (smart && !this.config?.smartTurn) smart.close(); // turned off while it started
        else this.smart = smart;
      })
      .catch(() => {})
      .finally(() => (this.smartStarting = null));
  }

  /** Which engine to run: what's asked for, if this Mac has it. */
  private async choose(engine: HearingEngine): Promise<{ engine: 'apple' | 'parakeet' } | { engine: 'browser'; message?: string }> {
    if (engine === 'browser') return { engine: 'browser' };
    if (platform() !== 'darwin') return { engine: 'browser', message: engine === 'auto' ? undefined : 'On-device hearing needs macOS, so the browser listens instead.' };
    if (engine === 'parakeet' && !(await isInstalled(PARAKEET_MODEL))) {
      return { engine: 'browser', message: "Parakeet isn't installed yet (Settings → Hearing → Install), so the browser listens until it is." };
    }
    return { engine: engine === 'parakeet' ? 'parakeet' : 'apple' };
  }

  private async restart() {
    const generation = ++this.generation;
    this.helper?.close();
    this.helper = null;
    this.turn.reset();
    this.disarm();
    const config = this.config!;
    const choice = await this.choose(config.engine);
    if (generation !== this.generation) return;
    if (choice.engine === 'browser') return this.setStatus({ engine: 'browser', state: 'ready', message: choice.message });
    const engine = choice.engine;
    this.setStatus({ engine, state: 'starting', message: 'Getting ready…' });
    let bin: string;
    try {
      let told = false;
      bin = await ensureHelper(() => {
        if (told || generation !== this.generation) return;
        told = true;
        this.setStatus({ engine, state: 'starting', message: 'Building the hearing helper - the first time takes a few minutes.' });
      });
    } catch (e) {
      if (generation === this.generation) this.fallBack(engine, (e as Error).message);
      return;
    }
    if (generation !== this.generation) return;
    this.use(
      engine,
      new HearingHelper(
        bin,
        (event) => generation === this.generation && this.onHelper(engine, event),
        (code, stderr) => generation === this.generation && this.onExit(engine, code, stderr),
      ),
    );
  }

  /**
   * A helper just started. It counts audio from its own start (a restarted one from zero), and it
   * gets none until it's ready - so positions sent to it are from where the ring is now.
   */
  private use(engine: 'apple' | 'parakeet', helper: Helper) {
    this.helper = helper;
    this.helperFrom = this.ring.position;
    helper.command({
      type: 'start',
      engine,
      locale: this.config!.language.replace('-', '_'),
      vocabulary: this.vocabulary,
      wakeWords: this.wakeWords,
      modelDir: join(modelsDir(), PARAKEET_MODEL),
    });
  }

  /** On-device hearing can't run: the window's own recognition takes over, and says why. */
  private fallBack(engine: 'apple' | 'parakeet', why: string) {
    this.helper?.close();
    this.helper = null;
    const name = engine === 'apple' ? "Apple's recognizer" : 'Parakeet';
    this.setStatus({ engine: 'browser', state: 'ready', message: `${name} couldn't start, so the browser listens instead: ${why}` });
  }

  private onHelper(engine: 'apple' | 'parakeet', event: HelperEvent) {
    switch (event.type) {
      case 'ready':
        this.restarts = 0;
        console.log(`  [hearing] ${engine === 'apple' ? "Apple's recognizer" : 'Parakeet'} ready in ${event.ms} ms`);
        return this.setStatus({ engine, state: 'ready' });
      case 'partial':
        return this.onWords(event.text);
      case 'final':
        return this.onFinal(event.turn, event.text);
      case 'error':
        if (event.fatal) return this.fallBack(engine, event.message);
        return console.warn(`  [hearing] ${event.message}`);
      case 'log':
        return console.log(`  [hearing] ${event.message}`);
    }
  }

  private onExit(engine: 'apple' | 'parakeet', code: number | null, stderr: string) {
    this.helper = null;
    if (this.status.engine === 'browser') return; // it already reported why
    if (this.status.state === 'ready' && this.restarts < MAX_RESTARTS) {
      this.restarts++;
      console.warn(`  [hearing] the helper stopped (${code ?? 'signal'}) - restarting`);
      setTimeout(() => void this.restart(), 1000 * this.restarts);
      return;
    }
    this.fallBack(engine, stderr.split('\n').at(-1) || `the helper exited (${code})`);
  }

  private onWords(text: string) {
    if (!this.turn.open) return; // murmurs below the speech threshold: not a turn
    this.turn.text(text);
    this.events.transcript(text, false);
    // Talking over Nova stops it (once per turn).
    if (this.spoken !== null && this.config?.bargeIn && !this.interrupted && isBargeIn(text, this.spoken, this.wakeWords)) {
      this.interrupted = true;
      this.events.bargeIn();
    }
  }

  private endTurn() {
    const id = ++this.turnId;
    if (this.armed) this.explicitTurns.add(id);
    this.disarm();
    this.helper?.command({ type: 'finalize', turn: id });
    this.turn.reset();
  }

  private onFinal(id: number, text: string) {
    const explicit = this.explicitTurns.delete(id);
    if (id !== this.turnId) return;
    const words = text.trim();
    const overlapped = this.overlapping && !this.interrupted;
    this.overlapping = false;
    if (!words) return this.events.transcript('', true);
    const recent = this.spoken ?? (Date.now() - this.spokeUntil < 3000 ? this.lastSpoken : '');
    // Nova's own voice, picked up while it spoke - or speech while it spoke, with talking over it turned off.
    // Never what the user said with the shortcut: that was them.
    if (!explicit && overlapped && ((words.split(/\s+/).length >= 3 && isEcho(words, recent)) || !this.config?.bargeIn)) return this.events.transcript('', true);
    this.events.transcript(words, true);
    this.events.utterance(words, explicit);
  }
}
