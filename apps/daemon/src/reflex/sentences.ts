import { fork, type ChildProcess } from 'node:child_process';
import { fingerprint, type SentenceEncoder } from '@nova/core';
import { isInstalled, MODELS, modelsDir, SENTENCE_MODEL } from '../models/files.ts';

const DIM = 384;
/** How long a decision waits for the sentence model (it answers in a millisecond or two); longer for many texts at once. */
const waitFor = (texts: number) => 250 + 20 * texts;
/** A worker that keeps stopping isn't started again after this many times. */
const MAX_STARTS = 3;

/**
 * Reflex's sentence model (MiniLM L6, Apache-2.0) in its own process (sentence-worker.ts), as Nova's other ONNX models
 * run: it reads whole sentences - word order, "not", new ways of saying things - for Reflex's classifier. It never
 * keeps Nova (or a test) running on its own, and if it stops, Reflex decides without it.
 */
export class SentenceWorker implements SentenceEncoder {
  readonly id: string;
  readonly dim = DIM;
  private seq = 0;
  private readonly waiting = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();
  private ready: ((ok: boolean) => void) | null = null;
  private exited = false;
  /** Requests under way: only while there are some does it keep the process running (see `hold`). */
  private busy = 0;

  private constructor(private readonly child: ChildProcess) {
    const spec = MODELS[SENTENCE_MODEL]!;
    this.id = `${SENTENCE_MODEL}@${fingerprint(JSON.stringify([spec.revision, spec.files]))}`;
    child.stderr?.on('data', () => {});
    child.on('error', (e) => {
      if (!this.exited) console.warn(`  [reflex] the sentence model: ${e.message}`);
    });
    child.on('message', (msg: any) => {
      if (msg?.type === 'ready') this.settle(true);
      else if (msg?.type === 'error') {
        console.warn(`  [reflex] the sentence model didn't load: ${msg.message}`);
        this.settle(false);
      } else if (msg?.type === 'vectors') {
        const asked = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        if (msg.vectors) asked?.resolve(msg.vectors as Float32Array[]);
        else asked?.reject(new Error(msg.error ?? 'no vectors'));
      }
    });
    child.once('exit', () => {
      this.exited = true;
      this.settle(false);
      for (const { reject } of this.waiting.values()) reject(new Error('the sentence model stopped'));
      this.waiting.clear();
    });
    // Idle, it never keeps the daemon - or an evaluation, or a test - from exiting: not the process, its channel or its stderr.
    child.unref();
    this.channel?.unref();
    (child.stderr as unknown as { unref?: () => void } | null)?.unref?.();
  }

  private get channel() {
    return (this.child as unknown as { channel?: { ref(): void; unref(): void } }).channel;
  }

  /** While a request is under way, its channel keeps the process running until the answer comes. */
  private hold() {
    if (this.busy++ === 0) this.channel?.ref();
  }

  private release() {
    if (--this.busy === 0) this.channel?.unref();
  }

  /** Start it, or null when the model isn't installed or won't load. */
  static async start(): Promise<SentenceWorker | null> {
    if (!(await isInstalled(SENTENCE_MODEL))) return null;
    const worker = new SentenceWorker(fork(new URL('./sentence-worker.ts', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced' }));
    worker.hold();
    const ok = await new Promise<boolean>((resolve) => {
      worker.ready = resolve;
      if (!worker.send({ type: 'load', models: modelsDir(), name: SENTENCE_MODEL })) worker.settle(false);
    }).finally(() => worker.release());
    if (!ok) {
      worker.close();
      return null;
    }
    return worker;
  }

  get alive() {
    return !this.exited && this.child.connected;
  }

  encode(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return Promise.resolve([]);
    if (!this.alive) return Promise.reject(new Error('the sentence model stopped'));
    const id = ++this.seq;
    this.hold();
    return new Promise<Float32Array[]>((resolve, reject) => {
      const timer = setTimeout(() => (this.waiting.delete(id), reject(new Error('the sentence model was too slow'))), waitFor(texts.length));
      this.waiting.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      if (!this.send({ type: 'encode', id, texts })) {
        clearTimeout(timer);
        this.waiting.delete(id);
        reject(new Error('the sentence model stopped'));
      }
    }).finally(() => this.release());
  }

  close() {
    this.child.kill('SIGKILL'); // nothing to save, and exiting normally is what crashes ONNX Runtime
  }

  private settle(ok: boolean) {
    const ready = this.ready;
    this.ready = null;
    ready?.(ok);
  }

  private send(message: unknown) {
    if (!this.alive) return false;
    try {
      this.child.send(message as Parameters<ChildProcess['send']>[0]);
      return true;
    } catch {
      return false;
    }
  }
}

let chain: Promise<SentenceWorker | null> = Promise.resolve(null);
let starts = 0;

/**
 * Reflex's sentence model, started once while it's installed - and again if it stopped, a few times at most. Null
 * without it. Callers queue up, so two at once never start two.
 */
export function sentenceEncoder(): Promise<SentenceWorker | null> {
  chain = chain.then(async (worker) => {
    if (worker?.alive) return worker;
    if (!(await isInstalled(SENTENCE_MODEL)) || starts >= MAX_STARTS) return null;
    starts++;
    return SentenceWorker.start().catch(() => null);
  });
  return chain;
}
