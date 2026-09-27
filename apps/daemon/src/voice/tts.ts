import { fork, type ChildProcess } from 'node:child_process';
import { KOKORO_MODEL, whereInstalled } from '../models/files.ts';

/**
 * Kokoro: Nova's voice - natural-sounding, on this Mac (82M parameters, Apache-2.0). It runs in its
 * own process (worker.ts) so ONNX Runtime can't crash the daemon, on the way out or ever. The model
 * comes inside Nova.app (pinned and checked when the app is built), or from ~/.nova/models; its
 * voices ship with kokoro-js. Nothing is fetched at runtime.
 */

export { pcm16Base64, sentences } from './speech.ts';

export interface SpeechChunk {
  seq: number;
  sampleRate: number;
  pcm: string;
  last: boolean;
}

interface Job {
  onChunk: (chunk: SpeechChunk) => void;
  stillWanted?: () => boolean;
  resolve: () => void;
  reject: (e: Error) => void;
}

let worker: ChildProcess | null = null;
let starting: Promise<boolean> | null = null;
const jobs = new Map<string, Job>();
let jobCount = 0;

/**
 * A message for the voice process, if it's still there: false when it isn't. Never throws, and
 * never leaves an 'error' unhandled - a voice that stopped mustn't take Nova down with it.
 */
function post(child: ChildProcess, message: Record<string, unknown>, failed?: (e: Error) => void) {
  if (!child.connected) return false;
  try {
    child.send(message, (e) => e && failed?.(e));
    return true;
  } catch {
    return false;
  }
}

/** Start the voice process and load Kokoro (a second or so). False when it isn't installed or won't load. */
export function kokoro(): Promise<boolean> {
  starting ??= (async () => {
    const where = await whereInstalled(KOKORO_MODEL);
    if (!where) return false;
    const child = fork(new URL('./worker.ts', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    worker = child;
    child.on('error', (e) => console.warn(`  [voice] ${e.message}`)); // it couldn't start, or a message couldn't reach it: 'exit' does the rest
    child.stderr?.on('data', (d: Buffer) => {
      const text = String(d).trim();
      if (text) console.warn(`  [voice] ${text.split('\n').at(-1)}`);
    });
    child.on('message', (msg: any) => {
      const job = jobs.get(msg.id);
      if (!job) return;
      if (msg.type === 'chunk') {
        if (job.stillWanted && !job.stillWanted()) {
          post(child, { type: 'stop', id: msg.id });
          jobs.delete(msg.id);
          return job.resolve();
        }
        job.onChunk({ seq: msg.seq, sampleRate: msg.sampleRate, pcm: msg.pcm, last: msg.last });
      } else if (msg.type === 'failed') {
        jobs.delete(msg.id);
        job.reject(new Error(msg.message));
      } else if (msg.type === 'done') {
        jobs.delete(msg.id);
        job.resolve();
      }
    });
    child.on('exit', () => {
      if (worker === child) (worker = null), (starting = null);
      for (const [id, job] of jobs) jobs.delete(id), job.reject(new Error('The voice stopped.'));
    });
    return new Promise<boolean>((resolve) => {
      const ready = (msg: any) => {
        if (msg.type === 'ready') console.log(`  [voice] Kokoro ready in ${msg.ms} ms`);
        else if (msg.type === 'error') console.warn(`  [voice] Kokoro didn't load: ${msg.message}`);
        else return;
        child.off('message', ready);
        if (msg.type === 'error') stopVoice();
        resolve(msg.type === 'ready');
      };
      child.on('message', ready);
      child.once('exit', () => resolve(false));
      if (!post(child, { type: 'load', dir: where.dir, model: KOKORO_MODEL }, () => resolve(false))) resolve(false);
    });
  })();
  return starting;
}

/** Stop the voice process: when Nova exits, or to reload Kokoro after installing it. */
export function stopVoice() {
  worker?.kill('SIGKILL'); // it holds nothing worth saving, and exiting normally is what crashes ONNX Runtime
  worker = null;
  starting = null;
}
process.on('exit', stopVoice);

/**
 * Speak text in a Kokoro voice, one sentence at a time. A reply still being written arrives in
 * pieces: `first` numbers the sentences on, and only the `final` piece ends the stream. Stops
 * early when `stillWanted` says so (a newer reply, or the user said stop). Rejects if Kokoro
 * isn't available.
 */
export async function synthesize(
  text: string,
  opts: { voice: string; speed: number; first?: number; final?: boolean; stillWanted?: () => boolean; onChunk: (chunk: SpeechChunk) => void },
) {
  if (!(await kokoro()) || !worker) throw new Error("Kokoro isn't available.");
  const id = `j${++jobCount}`;
  const child = worker;
  return new Promise<void>((resolve, reject) => {
    jobs.set(id, { onChunk: opts.onChunk, stillWanted: opts.stillWanted, resolve, reject });
    const failed = () => jobs.delete(id) && reject(new Error('The voice stopped.'));
    if (!post(child, { type: 'speak', id, text, voice: opts.voice, speed: opts.speed, first: opts.first ?? 0, final: opts.final ?? true }, failed)) failed();
  });
}
