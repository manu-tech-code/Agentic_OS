import { isBargeIn, isEcho, SpeechActivity, TurnDetector, type HearingStatus, type Patience } from '@nova/core';
import { platform } from 'node:os';
import { join } from 'node:path';
import { isInstalled, modelsDir, PARAKEET_MODEL } from '../models/files.ts';
import { ensureHelper } from './build.ts';
import { HearingHelper, type HelperEvent } from './helper.ts';
import { Voiceprinter, type WorkerModel } from './printer.ts';
import { SmartTurn } from './smart-turn.ts';
import { SPEECH_CHUNK, SpeechDetector } from './speech-detector.ts';
import { HELPER_EAR, type Prints, type Speaker, type VoiceModels } from './voiceid.ts';

export type HearingEngine = 'auto' | 'apple' | 'parakeet' | 'browser';

export interface HearingConfig {
  engine: HearingEngine;
  /** BCP 47, e.g. "en-US". */
  language: string;
  patience: Patience;
  smartTurn: boolean;
  /** Only a voice starts a turn: Silero VAD (when it's installed) tells speech from other sounds. */
  speechOnly: boolean;
  bargeIn: boolean;
}

export interface HearingEvents {
  status(status: HearingStatus): void;
  /** Words heard so far (`final` false), or the finished turn. */
  transcript(text: string, final: boolean): void;
  /**
   * A finished turn, for Nova to act on - `explicit` when it was said to Nova with the talk shortcut, and
   * with Voice ID on, whose voice it was.
   */
  utterance(text: string, explicit: boolean, speaker?: Speaker): void;
  /** The user started talking over Nova. */
  bargeIn(): void;
}

const RATE = 16_000;
const MAX_RESTARTS = 3;
/** A tap of the talk shortcut makes the next turn Nova's for this long; nothing said by then, it lapses. */
const ARMED_MS = 8000;
/** Let go without a word: a moment for the speech detector to catch up, then the turn lapses. */
const ARMED_AFTER_HOLD_MS = 1500;

/**
 * Voice ID, as hearing uses it: whether to take voiceprints (and with which models), and who a turn's is.
 * While the user sets it up or tests it, their turns go to it instead of to Nova.
 */
export interface VoiceCheck {
  /** The models to take voiceprints with, or null when Voice ID is off. */
  active(): VoiceModels | null;
  /**
   * Whose voice a turn was (null prints: none could be made) - undefined when Voice ID decides nothing now. With the
   * turn's audio, for the recordings (when the user keeps them). `learn: false` for a glance at part of a turn
   * (someone talking over Nova), which mustn't teach it.
   */
  decide(prints: Prints | null, seconds: number, opts?: { learn?: boolean; text?: string; audio?: Int16Array; overlapped?: boolean }): Speaker | undefined;
  /** Setting up or testing Voice ID: the turn is for it, not for Nova (with its audio, to check the recording). True when it took it. */
  claim(prints: Prints | null, seconds: number, text: string, audio?: Int16Array): boolean;
  /** A turn said with the talk shortcut: the user's own - Voice ID may learn from it. */
  confirmed?(prints: Prints | null, seconds: number, text: string, audio?: Int16Array): void;
  /** The master keyword, in any voice: what was said after it (Voice ID is off from now on), or null. */
  unlock?(text: string): string | null;
}

/** Longest Nova waits for a turn's voiceprint before deciding without one (unsure, then). */
const PRINT_WAIT_MS = 2000;
/** Talking over Nova: how long the voice check may hold the interruption up. */
const BARGE_WAIT_MS = 600;

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

/** Audio waiting for the speech detector's say on it, taken off in order as that comes back. */
class Backlog {
  private chunks: Int16Array[] = [];
  length = 0;

  push(samples: Int16Array) {
    this.chunks.push(samples);
    this.length += samples.length;
  }

  /** The next `n` samples (all there are, when fewer). */
  take(n: number): Int16Array {
    const out = new Int16Array(Math.min(n, this.length));
    for (let filled = 0; filled < out.length; ) {
      const first = this.chunks[0]!;
      const used = Math.min(first.length, out.length - filled);
      out.set(first.subarray(0, used), filled);
      filled += used;
      if (used === first.length) this.chunks.shift();
      else this.chunks[0] = first.subarray(used);
    }
    this.length -= out.length;
    return out;
  }

  clear() {
    this.chunks = [];
    this.length = 0;
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
  /** Where `vad` began reading, in the ring: the positions of its changes count from here. */
  private vadFrom = 0;
  /** Silero VAD, when Settings want it and it's installed: its say on each 32 ms decides what's a voice. */
  private speech: SpeechDetector | null = null;
  private speechStarting: Promise<void> | null = null;
  private speechRestarts = 0;
  /** Audio the speech detector has, until its say on it comes back. */
  private readonly unheard = new Backlog();
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
  /** Voice ID's check, when there is one. */
  voice: VoiceCheck | null = null;
  /** Voiceprints asked of the helper, by request id: a turn's, or the audio so far when someone talks over Nova. */
  private readonly helperPrints = new Map<number, (print: number[] | null) => void>();
  private printSeq = 0;
  /** The voiceprints of each finished turn, until its words come back. */
  private readonly turnPrints = new Map<number, { prints: Promise<Prints | null>; seconds: number; audio: Int16Array; overlapped: boolean }>();
  /** Voice ID's larger models, in their own process - started when Voice ID wants voiceprints, with the models it names. */
  private printer: Voiceprinter | null = null;
  private printerFor = '';
  private printerStarting: Promise<void> | null = null;
  private printerRestarts = 0;

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
    if (config.speechOnly) {
      this.speechRestarts = 0;
      this.startSpeech();
    } else if (this.speech) this.loseSpeech(this.speech, false);
    if (!previous || previous.engine !== config.engine || previous.language !== config.language) {
      this.restarts = 0;
      void this.restart();
    }
  }

  /**
   * Voice ID wants voiceprints now (its models just installed, setting up or a test begun): its models are loaded
   * now rather than on the next turn - which would then have the helper's alone - and tried again if they'd stopped.
   */
  voiceWanted() {
    this.printerRestarts = 0;
    if (!this.printer?.alive && !this.printerStarting) this.printerFor = '';
    this.warmVoice();
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
    // With the speech detector, its say on this audio decides whether it's a voice - in a moment, once it
    // comes back. Half a second behind, it's no use: loudness alone, until it's started again.
    if (this.speech?.push(samples)) {
      this.unheard.push(samples);
      if (this.unheard.length > RATE / 2) this.loseSpeech(this.speech, true);
      return;
    }
    this.flushUnheard();
    this.detect(samples);
  }

  /**
   * Speech starting or stopping in this audio - read in order, the speech detector's say (`voice`) with it
   * when there is one, so however late that came, where it happened is known.
   */
  private detect(samples: Int16Array, voice?: number) {
    const change = this.vad.push(samples, voice);
    if (!change || !this.helper) return;
    const active = change === 'start';
    const position = this.vadFrom + this.vad.changedAt;
    const at = this.helperMs(position); // in ms of the helper's audio
    if (active && !this.turn.open) {
      // A new turn: whatever was transcribed before it (murmurs below the speech threshold) is dropped.
      this.turnStart = Math.max(0, position - RATE / 2);
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
    this.vadFrom = this.ring.position;
    this.unheard.clear();
    this.speech?.reset();
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
    this.dropPrints();
    this.helper?.close();
    this.helper = null;
    this.smart?.close();
    this.smart = null;
    this.speech?.close();
    this.speech = null;
    this.unheard.clear();
    this.stopPrinter();
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

  /** The speech detector's process, when Settings want it - started again if it stops or falls behind, a few times. */
  private startSpeech() {
    if (this.speech || this.speechStarting) return;
    const started = Date.now();
    this.speechStarting = SpeechDetector.start((gone) => this.loseSpeech(gone, true))
      .then((speech) => {
        if (!speech) return;
        if (!this.config?.speechOnly) return speech.close(); // turned off while it started
        speech.onVoice = (voices) => this.onVoice(speech, voices);
        this.speech = speech;
        console.log(`  [hearing] speech detector ready in ${Date.now() - started} ms`);
      })
      .catch(() => {})
      .finally(() => (this.speechStarting = null));
  }

  /** The speech detector stopped, fell behind or was turned off: loudness alone from here, until it's started again. */
  private loseSpeech(detector: SpeechDetector, again: boolean) {
    if (this.speech !== detector) return;
    this.speech = null;
    detector.close();
    this.flushUnheard();
    if (again && this.config?.speechOnly && this.speechRestarts++ < MAX_RESTARTS) setTimeout(() => this.config?.speechOnly && this.startSpeech(), 5000 * this.speechRestarts);
  }

  /** Its say on the audio it was sent, 32 ms at a time: that audio is read now, with it. */
  private onVoice(detector: SpeechDetector, voices: number[]) {
    if (this.speech !== detector) return;
    for (const voice of voices) {
      if (this.unheard.length < SPEECH_CHUNK) return;
      this.detect(this.unheard.take(SPEECH_CHUNK), voice);
    }
  }

  /** What the speech detector had and never gave its say on: read by loudness, before anything newer. */
  private flushUnheard() {
    if (this.unheard.length) this.detect(this.unheard.take(this.unheard.length));
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
    this.dropPrints();
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
        this.warmVoice();
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
      case 'voiceprint':
        if (event.error && event.error !== 'too short') console.warn(`  [hearing] no voiceprint: ${event.error}`);
        return this.helperPrints.get(event.id)?.(event.print ?? null);
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
    // Talking over Nova stops it (once per turn) - with Voice ID, only the user does: a TV or another person
    // doesn't. Too little said yet to tell, or no answer in time, it stops: stopping is never harmful.
    if (this.spoken !== null && this.config?.bargeIn && !this.interrupted && isBargeIn(text, this.spoken, this.wakeWords)) {
      this.interrupted = true;
      const voice = this.voice?.active();
      const audio = voice ? this.ring.since(this.turnStart) : null;
      if (!voice || !audio || audio.length < RATE) return this.events.bargeIn();
      void this.prints(audio, voice, BARGE_WAIT_MS).then((prints) => {
        if (this.voice?.decide(prints, audio.length / RATE, { learn: false }) !== 'not-you') this.events.bargeIn();
      });
    }
  }

  private endTurn() {
    const id = ++this.turnId;
    if (this.armed) this.explicitTurns.add(id);
    this.disarm();
    // Voice ID: the turn's own audio, for its voiceprints - asked for now, while the words are still coming.
    const voice = this.voice?.active();
    if (voice) {
      const audio = this.ring.since(this.turnStart);
      this.turnPrints.set(id, { prints: this.prints(audio, voice), seconds: audio.length / RATE, audio, overlapped: this.overlapping });
    } else this.stopPrinter(); // Voice ID is off: its larger models needn't be kept in memory
    this.helper?.command({ type: 'finalize', turn: id });
    this.turn.reset();
  }

  /**
   * With Voice ID on, its models are loaded now, with a second of silence - not on the first turn, whose prints
   * would then come too late (and the turn go unplaced).
   */
  private warmVoice() {
    const voice = this.voice?.active();
    if (!voice) return;
    const started = Date.now();
    const wanted = (voice.helper ? 1 : 0) + voice.worker.length;
    void this.startPrinter(voice.worker)
      .then(() => this.prints(new Int16Array(RATE), voice, 15_000))
      .then((prints) => {
        const got = Object.keys(prints ?? {}).length;
        if (got) console.log(`  [voice-id] voiceprints ready in ${Date.now() - started} ms (${got} of ${wanted} models)`);
        else console.warn("  [voice-id] the voiceprint models didn't load");
      });
  }

  /** The helper is going: voiceprints it was asking for won't come, nor will its turns' words. */
  private dropPrints() {
    for (const done of [...this.helperPrints.values()]) done(null);
    this.turnPrints.clear();
  }

  /**
   * A turn's voiceprints, asked of the helper's model and the worker's at once: those that come within `waitMs`
   * (null: none did). The worker starts on the first ask, so a turn meanwhile has the helper's alone.
   */
  private prints(audio: Int16Array, models: VoiceModels, waitMs = PRINT_WAIT_MS): Promise<Prints | null> {
    void this.startPrinter(models.worker);
    const printer = this.printer?.alive ? this.printer : null;
    return Promise.all([models.helper ? this.helperPrint(audio, models.helper, waitMs) : null, printer ? printer.print(audio, waitMs) : null]).then(([small, large]) => {
      const prints: Prints = { ...(large ?? {}), ...(small ? { [HELPER_EAR]: small } : {}) };
      return Object.keys(prints).length ? prints : null;
    });
  }

  /** A voiceprint of this audio from the helper's model, or null when it can't make one in time. */
  private helperPrint(audio: Int16Array, models: string, waitMs: number): Promise<number[] | null> {
    const helper = this.helper;
    if (!helper) return Promise.resolve(null);
    const id = ++this.printSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => (this.helperPrints.delete(id), resolve(null)), waitMs);
      this.helperPrints.set(id, (print) => (clearTimeout(timer), this.helperPrints.delete(id), resolve(print)));
      const pcm = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength).toString('base64');
      helper.command({ type: 'voiceprint', id, models, pcm });
    });
  }

  /** The worker for these models, started (or started again with others) - a few times at most if it keeps stopping. */
  private startPrinter(models: WorkerModel[]): Promise<void> {
    const key = JSON.stringify(models);
    if (key === this.printerFor && (this.printer?.alive || this.printerStarting)) return this.printerStarting ?? Promise.resolve();
    if (key === this.printerFor && this.printerRestarts >= MAX_RESTARTS) return Promise.resolve();
    this.printerRestarts = key === this.printerFor ? this.printerRestarts + 1 : 0;
    this.stopPrinter();
    this.printerFor = key;
    if (!models.length) return Promise.resolve();
    const starting: Promise<void> = Voiceprinter.start(models, (gone) => {
      if (this.printer === gone) this.printer = null; // prints go on with the helper's model meanwhile
    })
      .then((printer) => {
        if (this.printerFor === key && this.printerStarting === starting) this.printer = printer;
        else printer?.close();
      })
      .catch(() => {})
      .finally(() => {
        if (this.printerStarting === starting) this.printerStarting = null;
      });
    this.printerStarting = starting;
    return starting;
  }

  private stopPrinter() {
    this.printer?.close();
    this.printer = null;
    this.printerStarting = null;
    this.printerFor = '';
  }

  private onFinal(id: number, text: string) {
    const explicit = this.explicitTurns.delete(id);
    const printed = this.turnPrints.get(id);
    this.turnPrints.delete(id);
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
    if (!printed) return this.events.utterance(words, explicit);
    void printed.prints.then((prints) => {
      const voice = this.voice;
      // Setting up or testing Voice ID: what's said is for it, never a request.
      if (voice?.claim(prints, printed.seconds, words, printed.audio)) return;
      // The master keyword, in any voice: Voice ID is off from now on, and what came after it goes through.
      const rest = voice?.unlock?.(words) ?? null;
      if (rest !== null) return rest ? this.events.utterance(rest, explicit, 'anyone') : undefined;
      // Said with the talk shortcut: whoever holds the key down is at this Mac - it counts as the user (and teaches Voice ID).
      if (explicit) {
        voice?.confirmed?.(prints, printed.seconds, words, printed.audio);
        return this.events.utterance(words, true);
      }
      this.events.utterance(words, false, voice?.decide(prints, printed.seconds, { text: words, audio: printed.audio, overlapped: printed.overlapped }));
    });
  }
}
