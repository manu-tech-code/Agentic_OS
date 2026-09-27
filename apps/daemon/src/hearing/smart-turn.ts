import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { isInstalled, MODELS, modelsDir, SMART_TURN_MODEL } from '../models/files.ts';

/**
 * Smart Turn (pipecat-ai, BSD-2): hears from the audio - tone and rhythm as well as words -
 * whether the speaker has finished their turn. Runs in its own process (turn-worker.ts): if that
 * stops, turn-taking goes on without it, and nothing is ever sent to it again.
 */
export class SmartTurn {
  private seq = 0;
  private readonly waiting = new Map<number, (p: number | null) => void>();
  private ready: ((ok: boolean) => void) | null = null;
  private exited = false;

  private constructor(
    private readonly child: ChildProcess,
    onExit: (turn: SmartTurn) => void = () => {},
  ) {
    child.stderr?.on('data', () => {});
    // It couldn't start, or a message couldn't reach it: never an unhandled 'error' that takes Nova down.
    child.on('error', (e) => {
      if (!this.exited) console.warn(`  [hearing] Smart Turn: ${e.message}`);
    });
    child.on('message', (msg: any) => {
      if (msg?.type === 'ready') this.settle(true);
      else if (msg?.type === 'error') {
        console.warn(`  [hearing] Smart Turn didn't load: ${msg.message}`);
        this.settle(false);
      } else if (msg?.type === 'verdict') {
        this.waiting.get(msg.id)?.(typeof msg.p === 'number' ? msg.p : null);
        this.waiting.delete(msg.id);
      }
    });
    child.once('exit', () => {
      this.exited = true;
      this.settle(false);
      for (const done of this.waiting.values()) done(null);
      this.waiting.clear();
      onExit(this);
    });
  }

  /** Start it, or null when its model isn't installed or won't load. `onExit`: its process stopped. */
  static async start(onExit?: (turn: SmartTurn) => void): Promise<SmartTurn | null> {
    if (!(await isInstalled(SMART_TURN_MODEL))) return null;
    const turn = new SmartTurn(fork(new URL('./turn-worker.ts', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced' }), onExit);
    const file = Object.keys(MODELS[SMART_TURN_MODEL]!.files)[0]!;
    const ready = await turn.load(join(modelsDir(), SMART_TURN_MODEL, file));
    if (!ready) {
      turn.close();
      return null;
    }
    return turn;
  }

  /** Whether its process is still there to ask. */
  get alive() {
    return !this.exited && this.child.connected;
  }

  /** The probability the speaker has finished, from the turn's audio (16 kHz), or null if it can't tell. */
  judge(samples: Int16Array): Promise<number | null> {
    if (!this.alive) return Promise.resolve(null);
    const audio = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) audio[i] = samples[i]! / 32768;
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => (this.waiting.delete(id), resolve(null)), 400); // too slow to help
      const done = (p: number | null) => (clearTimeout(timer), this.waiting.delete(id), resolve(p));
      this.waiting.set(id, done);
      if (!this.send({ type: 'judge', id, audio })) done(null);
    });
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
        if (!e) return;
        this.settle(false);
        for (const done of [...this.waiting.values()]) done(null);
      });
      return true;
    } catch {
      return false;
    }
  }
}
