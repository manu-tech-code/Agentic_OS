import { afterAll, describe, expect, it } from 'vitest';
import { isInstalled, KOKORO_MODEL } from '../src/models/files.ts';
import { pcm16Base64, sentences, stopVoice, synthesize, type SpeechChunk } from '../src/voice/tts.ts';

describe('speaking a reply', () => {
  it('splits it into sentences, keeping tiny ones with the next', () => {
    expect(sentences('Okay. Opening Slack now! It should be up in a second... Anything else?')).toEqual([
      'Okay. Opening Slack now!',
      'It should be up in a second...',
      'Anything else?',
    ]);
    expect(sentences('No punctuation at all')).toEqual(['No punctuation at all']);
    expect(sentences('   ')).toEqual([]);
  });

  it('sends 16-bit audio', () => {
    const bytes = Buffer.from(pcm16Base64(Float32Array.from([0, 1, -1, 2])), 'base64');
    expect([...new Int16Array(bytes.buffer, bytes.byteOffset, 4)]).toEqual([0, 32767, -32767, 32767]);
  });
});

const installed = await isInstalled(KOKORO_MODEL);
describe.skipIf(!installed)('Kokoro', () => {
  afterAll(stopVoice);
  it('speaks sentence by sentence, starting quickly', async () => {
    const chunks: SpeechChunk[] = [];
    let first = 0;
    const started = performance.now();
    await synthesize('Your timer is set for ten minutes. I will let you know when it is done.', {
      voice: 'af_heart',
      speed: 1,
      onChunk: (c) => {
        first ||= performance.now() - started;
        chunks.push(c);
      },
    });
    expect(chunks.map((c) => [c.seq, c.last])).toEqual([
      [0, false],
      [1, true],
    ]);
    const seconds = chunks.reduce((sum, c) => sum + Buffer.from(c.pcm, 'base64').length / 2 / c.sampleRate, 0);
    expect(chunks[0]!.sampleRate).toBe(24_000);
    expect(seconds).toBeGreaterThan(1.5);
    expect(seconds).toBeLessThan(8);
    console.log(`Kokoro: first sentence after ${Math.round(first)} ms (including loading), ${seconds.toFixed(1)} s of speech`);
  }, 60_000);

  it('stops early when the reply is no longer wanted', async () => {
    const chunks: SpeechChunk[] = [];
    await synthesize('This is the first sentence of a long reply. This one should never be spoken. Nor should this one.', {
      voice: 'af_heart',
      speed: 1,
      stillWanted: () => chunks.length === 0,
      onChunk: (c) => chunks.push(c),
    });
    expect(chunks).toHaveLength(1);
  }, 60_000);
});
