/**
 * Smart Turn runs in this child process: ONNX Runtime's native threads can crash a process as it
 * exits, and turn-taking should never take Nova down. The daemon sends the audio of the turn so
 * far; this sends back the probability that the speaker has finished.
 */
import { WhisperFeatureExtractor } from '@huggingface/transformers';
import * as ort from 'onnxruntime-node';

type Request = { type: 'load'; model: string } | { type: 'judge'; id: number; audio: Float32Array };

const SECONDS = 8;
const RATE = 16_000;
const extractor = new WhisperFeatureExtractor({
  feature_size: 80,
  sampling_rate: RATE,
  hop_length: 160,
  n_fft: 400,
  chunk_length: SECONDS,
  n_samples: SECONDS * RATE,
  nb_max_frames: (SECONDS * RATE) / 160,
  padding_value: 0,
});
let session: ort.InferenceSession | null = null;
const reply = (message: unknown) => process.send?.(message);

/** The last 8 s of the turn (silence before it if shorter), normalised as Smart Turn was trained. */
function prepare(audio: Float32Array) {
  const n = SECONDS * RATE;
  const clip = new Float32Array(n);
  const tail = audio.length > n ? audio.subarray(audio.length - n) : audio;
  clip.set(tail, n - tail.length);
  let mean = 0;
  for (const v of clip) mean += v;
  mean /= n;
  let variance = 0;
  for (const v of clip) variance += (v - mean) ** 2;
  const scale = 1 / Math.sqrt(variance / n + 1e-7);
  for (let i = 0; i < n; i++) clip[i] = (clip[i]! - mean) * scale;
  return clip;
}

process.on('message', async (msg: Request) => {
  if (msg.type === 'load') {
    try {
      session = await ort.InferenceSession.create(msg.model, { executionMode: 'sequential', interOpNumThreads: 1, graphOptimizationLevel: 'all' });
      reply({ type: 'ready' });
    } catch (e) {
      reply({ type: 'error', message: (e as Error).message });
    }
    return;
  }
  try {
    if (!session) throw new Error("Smart Turn isn't loaded.");
    const { input_features } = await extractor(prepare(msg.audio));
    const input = new ort.Tensor('float32', input_features.data as Float32Array, input_features.dims as number[]);
    const outputs = await session.run({ input_features: input });
    const p = Number((Object.values(outputs)[0]!.data as Float32Array)[0]);
    reply({ type: 'verdict', id: msg.id, p });
  } catch (e) {
    reply({ type: 'verdict', id: msg.id, p: null, error: (e as Error).message });
  }
});

process.on('disconnect', () => process.kill(process.pid, 'SIGKILL'));
