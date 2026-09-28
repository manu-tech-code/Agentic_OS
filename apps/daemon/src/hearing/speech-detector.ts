import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { isInstalled, MODELS, modelsDir, SPEECH_MODEL } from '../models/files.ts';

/** How much audio the model reads at a time: its say covers this many samples (32 ms). */
export const SPEECH_CHUNK = 512;

/**
 * Silero VAD (MIT): whether the microphone hears someone speaking, 32 ms at a time - typing, music, a
 * door or a fan aren't. Runs in its own process (speech-worker.ts): if that stops, hearing goes on by
 * loudness alone, as it did before.
 */
export class SpeechDetector {
  /** The probability that each 32 ms of what was pushed is a voice, in order. */
  onVoice: (p: number[]) => void = () => {};
  /** Bumped by `reset`: its say on audio from before then is dropped when it comes back. */
  private epoch = 0;
  private ready: ((ok: boolean) => void) | null = null;
  private exited = false;

  private constructor(
    private readonly child: ChildProcess,
    onExit: (detector: SpeechDetector) => void = () => {},
  ) {
    child.stderr?.on('data', () => {});
    // It couldn't start, or a message couldn't reach it: never an unhandled 'error' that takes Nova down.
    child.on('error', (e) => {
      if (!this.exited) console.warn(`  [hearing] speech detector: ${e.message}`);
    });
    child.on('message', (msg: any) => {
      if (msg?.type === 'ready') this.settle(true);
      else if (msg?.type === 'error') {
        console.warn(`  [hearing] the speech detector ${this.ready ? "didn't load" : 'stopped'}: ${msg.message}`);
        if (this.ready) this.settle(false);
        else this.close(); // it can't hear any more: loudness alone, until it's started again
      } else if (msg?.type === 'voice' && msg.epoch === this.epoch && Array.isArray(msg.p)) this.onVoice(msg.p);
    });
    child.once('exit', () => {
      this.exited = true;
      this.settle(false);
      onExit(this);
    });
  }

  /** Start it, or null when its model isn't installed or won't load. `onExit`: its process stopped. */
  static async start(onExit?: (detector: SpeechDetector) => void): Promise<SpeechDetector | null> {
    if (!(await isInstalled(SPEECH_MODEL))) return null;
    const detector = new SpeechDetector(fork(new URL('./speech-worker.ts', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced' }), onExit);
    const file = Object.keys(MODELS[SPEECH_MODEL]!.files)[0]!;
    if (!(await detector.load(join(modelsDir(), SPEECH_MODEL, file)))) {
      detector.close();
      return null;
    }
    return detector;
  }

  /** Whether its process is still there to hear. */
  get alive() {
    return !this.exited && this.child.connected;
  }

  /** Audio to hear (16 kHz): false when it can't take any, because it has stopped. */
  push(samples: Int16Array) {
    return this.send({ type: 'audio', samples });
  }

  /** A new stream: what it was hearing, and its say on that still on the way, is forgotten. */
  reset() {
    this.epoch++;
    this.send({ type: 'reset', epoch: this.epoch });
  }

  close() {
    this.child.kill('SIGKILL'); // nothing to save, and exiting normally is what crashes ONNX Runtime
  }

  private load(model: string) {
    return new Promise<boolean>((resolve) => {
      this.ready = resolve;
      if (!this.send({ type: 'load', model })) this.settle(false);
    });
  }

  private settle(ok: boolean) {
    const ready = this.ready;
    this.ready = null;
    ready?.(ok);
  }

  /** A message for the worker, if it's still there: false when it isn't (it never throws). */
  private send(message: unknown) {
    if (!this.alive) return false;
    try {
      this.child.send(message as Parameters<ChildProcess['send']>[0], (e) => {
        if (e) this.settle(false);
      });
      return true;
    } catch {
      return false;
    }
  }
}
