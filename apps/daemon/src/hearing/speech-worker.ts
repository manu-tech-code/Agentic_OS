/**
 * Silero VAD runs in this child process, as Smart Turn does in turn-worker.ts: ONNX Runtime's native
 * threads can crash a process as it exits, and hearing should never take Nova down. The daemon streams
 * the microphone here; this answers, for every 32 ms of it in order, the probability that it's someone
 * speaking.
 */
import * as ort from 'onnxruntime-node';

/** Its say comes back with the epoch of the last reset, so the daemon knows what it's on. */
type Request = { type: 'load'; model: string } | { type: 'audio'; samples: Int16Array } | { type: 'reset'; epoch: number };

/** What the model reads at a time (32 ms at 16 kHz), after the last 64 samples of the chunk before. */
const CHUNK = 512;
const CONTEXT = 64;
const sr = new ort.Tensor('int64', BigInt64Array.from([16_000n]), []);
let session: ort.InferenceSession | null = null;
let epoch = 0;
let state: Float32Array = new Float32Array(2 * 128);
/** The model's next input: the context, then the chunk being filled. */
let input = new Float32Array(CONTEXT + CHUNK);
let filled = 0;
/** Requests are handled one after another, so the audio is heard in order. */
let work = Promise.resolve();
const reply = (message: unknown) => process.send?.(message);

function reset(next: number) {
  epoch = next;
  state = new Float32Array(2 * 128);
  input = new Float32Array(CONTEXT + CHUNK);
  filled = 0;
}

/** The say on each chunk this audio completes, in order. */
async function hear(samples: Int16Array) {
  const voices: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    input[CONTEXT + filled++] = samples[i]! / 32768;
    if (filled < CHUNK) continue;
    const out = await session!.run({ input: new ort.Tensor('float32', input, [1, CONTEXT + CHUNK]), state: new ort.Tensor('float32', state, [2, 1, 128]), sr });
    voices.push(Number((out.output!.data as Float32Array)[0]));
    state = out.stateN!.data as Float32Array;
    const next = new Float32Array(CONTEXT + CHUNK);
    next.set(input.subarray(CHUNK)); // this chunk's last 64 samples: the next one's context
    input = next;
    filled = 0;
  }
  if (voices.length) reply({ type: 'voice', epoch, p: voices });
}

async function handle(msg: Request) {
  if (msg.type === 'load') {
    try {
      session = await ort.InferenceSession.create(msg.model, { executionMode: 'sequential', interOpNumThreads: 1, intraOpNumThreads: 1, graphOptimizationLevel: 'all' });
      reply({ type: 'ready' });
    } catch (e) {
      reply({ type: 'error', message: (e as Error).message });
    }
    return;
  }
  if (msg.type === 'reset') return reset(msg.epoch);
  if (!session) return;
  try {
    await hear(msg.samples);
  } catch (e) {
    reply({ type: 'error', message: (e as Error).message });
  }
}

process.on('message', (msg: Request) => {
  work = work.then(() => handle(msg));
});

process.on('disconnect', () => process.kill(process.pid, 'SIGKILL'));
