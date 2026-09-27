import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { isInstalled, MODELS, modelsDir, SMART_TURN_MODEL } from '../models/files.ts';

/**
 * Smart Turn (pipecat-ai, BSD-2): hears from the audio - tone and rhythm as well as words -
 * whether the speaker has finished their turn. Runs in its own process (turn-worker.ts).
 */
export class SmartTurn {
  private constructor(private readonly child: ChildProcess) {}
  private seq = 0;
  private readonly waiting = new Map<number, (p: number | null) => void>();

  /** Start it, or null when its model isn't installed or won't load. */
  static async start(): Promise<SmartTurn | null> {
    if (!(await isInstalled(SMART_TURN_MODEL))) return null;
    const child = fork(new URL('./turn-worker.ts', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced' });
    const turn = new SmartTurn(child);
    child.stderr?.on('data', () => {});
    const ready = await new Promise<boolean>((resolve) => {
      child.on('message', (msg: any) => {
        if (msg.type === 'ready') resolve(true);
        else if (msg.type === 'error') {
          console.warn(`  [hearing] Smart Turn didn't load: ${msg.message}`);
          resolve(false);
        } else if (msg.type === 'verdict') {
          turn.waiting.get(msg.id)?.(typeof msg.p === 'number' ? msg.p : null);
          turn.waiting.delete(msg.id);
        }
      });
      child.once('exit', () => resolve(false));
      const file = Object.keys(MODELS[SMART_TURN_MODEL]!.files)[0]!;
      child.send({ type: 'load', model: join(modelsDir(), SMART_TURN_MODEL, file) });
    });
    child.once('exit', () => {
      for (const done of turn.waiting.values()) done(null);
      turn.waiting.clear();
    });
    if (!ready) {
      turn.close();
      return null;
    }
    return turn;
  }

  /** The probability the speaker has finished, from the turn's audio (16 kHz), or null if it can't tell. */
  judge(samples: Int16Array): Promise<number | null> {
    const audio = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) audio[i] = samples[i]! / 32768;
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => (this.waiting.delete(id), resolve(null)), 400); // too slow to help
      this.waiting.set(id, (p) => (clearTimeout(timer), resolve(p)));
      this.child.send({ type: 'judge', id, audio });
    });
  }

  close() {
    this.child.kill('SIGKILL'); // nothing to save, and exiting normally is what crashes ONNX Runtime
  }
}
