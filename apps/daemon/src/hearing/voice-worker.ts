/**
 * Voice ID's larger models run in this child process, as Smart Turn does: ONNX Runtime's native threads can crash a
 * process as it exits, and hearing should never take Nova down. The daemon sends a turn's audio; this sends back a
 * voiceprint from each model - its features made as it was trained (features.ts), the model, then unit length.
 */
import * as ort from 'onnxruntime-node';
import { kaldiFbank, MEL_BANDS, nemoMel } from './features.ts';
import type { WorkerModel } from './printer.ts';

type Request = { type: 'load'; models: WorkerModel[] } | { type: 'print'; id: number; audio: Int16Array };

const RATE = 16_000;
/** The models hear the latest 10 s of a longer turn (as the helper's does): more adds time, not surety. */
const WINDOW = RATE * 10;
/** Under half a second there's too little to make a voiceprint of. */
const MIN_SAMPLES = RATE / 2;

const sessions = new Map<string, { kind: WorkerModel['kind']; session: ort.InferenceSession }>();
const reply = (message: unknown) => process.send?.(message);

function unit(v: Float32Array): number[] | null {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  return n > 0 && Number.isFinite(n) ? Array.from(v, (x) => x / n) : null;
}

async function printOf(kind: WorkerModel['kind'], session: ort.InferenceSession, audio: Int16Array): Promise<number[] | null> {
  if (kind === 'wespeaker') {
    const { feats, frames } = kaldiFbank(audio);
    const out = await session.run({ feats: new ort.Tensor('float32', feats, [1, frames, MEL_BANDS]) });
    return unit(out.embs!.data as Float32Array);
  }
  const { feats, frames, padded } = nemoMel(audio);
  const out = await session.run({
    audio_signal: new ort.Tensor('float32', feats, [1, MEL_BANDS, padded]),
    length: new ort.Tensor('int64', BigInt64Array.of(BigInt(frames)), [1]),
  });
  return unit(out.embs!.data as Float32Array);
}

process.on('message', async (msg: Request) => {
  if (msg.type === 'load') {
    try {
      for (const model of msg.models) {
        if (sessions.has(model.ear)) continue;
        const session = await ort.InferenceSession.create(model.file, { executionMode: 'sequential', intraOpNumThreads: 4, graphOptimizationLevel: 'all' });
        sessions.set(model.ear, { kind: model.kind, session });
      }
      reply({ type: 'ready', ears: [...sessions.keys()] });
    } catch (e) {
      reply({ type: 'error', message: (e as Error).message });
    }
    return;
  }
  const started = performance.now();
  const prints: Record<string, number[]> = {};
  const errors: string[] = [];
  const audio = msg.audio.length > WINDOW ? msg.audio.subarray(msg.audio.length - WINDOW) : msg.audio;
  if (audio.length >= MIN_SAMPLES) {
    for (const [ear, { kind, session }] of sessions) {
      try {
        const print = await printOf(kind, session, audio);
        if (print) prints[ear] = print;
      } catch (e) {
        errors.push(`${ear}: ${(e as Error).message}`);
      }
    }
  }
  reply({ type: 'prints', id: msg.id, prints, ms: Math.round(performance.now() - started), ...(errors.length ? { error: errors.join('; ') } : {}) });
});

process.on('disconnect', () => process.kill(process.pid, 'SIGKILL'));
