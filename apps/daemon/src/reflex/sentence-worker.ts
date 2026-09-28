/**
 * Reflex's sentence model runs in this child process, as Nova's other ONNX models do: ONNX Runtime's native threads can
 * crash a process as it exits, and deciding should never take Nova down. The daemon sends texts; this sends back each
 * one's vector - MiniLM's reading of the whole sentence, averaged over its words and unit length.
 */
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

type Request = { type: 'load'; models: string; name: string } | { type: 'encode'; id: number; texts: string[] };

let extractor: FeatureExtractionPipeline | null = null;
/** `pipeline` for this one task: its full overloads are too many for the type checker. */
const featureExtraction = pipeline as unknown as (task: 'feature-extraction', model: string, opts: { dtype: 'q8'; device: 'cpu' }) => Promise<FeatureExtractionPipeline>;
const reply = (message: unknown) => process.send?.(message);

process.on('message', async (msg: Request) => {
  if (msg.type === 'load') {
    try {
      // Only the files downloaded (and checked) into Nova's models folder: nothing is fetched here.
      env.localModelPath = msg.models;
      env.allowRemoteModels = false;
      extractor = await featureExtraction('feature-extraction', msg.name, { dtype: 'q8', device: 'cpu' });
      reply({ type: 'ready' });
    } catch (e) {
      reply({ type: 'error', message: (e as Error).message });
    }
    return;
  }
  try {
    if (!extractor) throw new Error("The sentence model isn't loaded.");
    const out = await extractor(msg.texts, { pooling: 'mean', normalize: true });
    const [n, dim] = out.dims as [number, number];
    const data = out.data as Float32Array;
    reply({ type: 'vectors', id: msg.id, vectors: Array.from({ length: n }, (_, i) => data.slice(i * dim, (i + 1) * dim)) });
  } catch (e) {
    reply({ type: 'vectors', id: msg.id, vectors: null, error: (e as Error).message });
  }
});

process.on('disconnect', () => process.kill(process.pid, 'SIGKILL'));
