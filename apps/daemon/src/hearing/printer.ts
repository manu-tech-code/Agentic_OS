import { fork, type ChildProcess } from 'node:child_process';

/** One of Voice ID's ONNX models: the name its voiceprints go by, how its features are made, and its file. */
export interface WorkerModel {
  ear: string;
  kind: 'wespeaker' | 'nemo';
  file: string;
}

/**
 * Voice ID's larger models (WeSpeaker ResNet293, NVIDIA TitaNet-Large) in their own process (voice-worker.ts): if
 * it stops, Voice ID goes on with the hearing helper's model alone, and nothing is sent to it again.
 */
export class Voiceprinter {
  private seq = 0;
  private readonly waiting = new Map<number, (prints: Record<string, number[]> | null) => void>();
  private ready: ((ok: boolean) => void) | null = null;
  private exited = false;

  private constructor(
    private readonly child: ChildProcess,
    onExit: (printer: Voiceprinter) => void = () => {},
  ) {
    child.stderr?.on('data', () => {});
    child.on('error', (e) => {
      if (!this.exited) console.warn(`  [voice-id] the voiceprint worker: ${e.message}`);
    });
    child.on('message', (msg: any) => {
      if (msg?.type === 'ready') this.settle(true);
      else if (msg?.type === 'error') {
        console.warn(`  [voice-id] the larger models didn't load: ${msg.message}`);
        this.settle(false);
      } else if (msg?.type === 'prints') {
        if (msg.error) console.warn(`  [voice-id] no voiceprint from ${msg.error}`);
        this.waiting.get(msg.id)?.(msg.prints && Object.keys(msg.prints).length ? msg.prints : null);
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

  /** Start it with these models, or null when none will load. `onExit`: its process stopped. */
  static async start(models: WorkerModel[], onExit?: (printer: Voiceprinter) => void): Promise<Voiceprinter | null> {
    if (!models.length) return null;
    const printer = new Voiceprinter(fork(new URL('./voice-worker.ts', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced' }), onExit);
    if (!(await printer.load(models))) {
      printer.close();
      return null;
    }
    return printer;
  }

  get alive() {
    return !this.exited && this.child.connected;
  }

  /** A voiceprint of this audio (16 kHz) from each model, or null when none came within `waitMs`. */
  print(audio: Int16Array, waitMs: number): Promise<Record<string, number[]> | null> {
    if (!this.alive) return Promise.resolve(null);
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => (this.waiting.delete(id), resolve(null)), waitMs);
      const done = (prints: Record<string, number[]> | null) => (clearTimeout(timer), this.waiting.delete(id), resolve(prints));
      this.waiting.set(id, done);
      if (!this.send({ type: 'print', id, audio })) done(null);
    });
  }

  close() {
    this.child.kill('SIGKILL'); // nothing to save, and exiting normally is what crashes ONNX Runtime
  }

  private load(models: WorkerModel[]) {
    return new Promise<boolean>((resolve) => {
      this.ready = resolve;
      if (!this.send({ type: 'load', models })) this.settle(false);
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
