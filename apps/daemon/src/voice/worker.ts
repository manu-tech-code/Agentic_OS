/**
 * Kokoro runs in this child process, not in the daemon: ONNX Runtime's native threads crash a
 * process as it exits, and a voice problem should never take Nova down. The daemon sends text;
 * this sends back sentence-sized 16-bit PCM, and stops early when asked.
 */
import { env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { pcm16Base64, sentences } from './speech.ts';

type Request =
  | { type: 'load'; dir: string; model: string }
  /** `first` numbers the sentences on from earlier pieces of the same reply; `final` marks its last piece. */
  | { type: 'speak'; id: string; text: string; voice: string; speed: number; first?: number; final?: boolean }
  | { type: 'stop'; id: string };

let tts: KokoroTTS | null = null;
const stopped = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();
const reply = (message: unknown) => process.send?.(message);

async function speak({ id, text, voice, speed, first = 0, final = true }: Extract<Request, { type: 'speak' }>) {
  try {
    if (!tts) return reply({ type: 'failed', id, message: "Kokoro isn't loaded." });
    const parts = sentences(text);
    if (!parts.length && final) reply({ type: 'chunk', id, seq: first, sampleRate: 24_000, pcm: '', last: true });
    for (let i = 0; i < parts.length; i++) {
      if (stopped.delete(id)) return;
      const audio = await tts.generate(parts[i]!, { voice: voice as never, speed });
      reply({ type: 'chunk', id, seq: first + i, sampleRate: audio.sampling_rate, pcm: pcm16Base64(audio.audio), last: final && i === parts.length - 1 });
    }
  } catch (e) {
    reply({ type: 'failed', id, message: (e as Error).message });
  } finally {
    reply({ type: 'done', id });
  }
}

process.on('message', async (msg: Request) => {
  if (msg.type === 'load') {
    env.allowRemoteModels = false; // only the pinned, checked files
    env.localModelPath = `${msg.dir}/`;
    try {
      const started = performance.now();
      tts = await KokoroTTS.from_pretrained(msg.model, { dtype: 'fp32', device: 'cpu' });
      reply({ type: 'ready', ms: Math.round(performance.now() - started) });
    } catch (e) {
      reply({ type: 'error', message: (e as Error).message });
    }
  } else if (msg.type === 'stop') stopped.add(msg.id);
  else queue = queue.then(() => speak(msg)); // one reply at a time, in order
});

// The daemon went away: no one to speak for.
process.on('disconnect', () => process.kill(process.pid, 'SIGKILL'));
