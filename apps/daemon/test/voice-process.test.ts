import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

/** A stand-in for Kokoro's process that behaves as Node's does: sending to it once it's gone is an 'error'. */
class Child extends EventEmitter {
  connected = true;
  sent: Record<string, unknown>[] = [];
  stderr = new EventEmitter();
  send(message: Record<string, unknown>, callback?: (e: Error | null) => void) {
    if (!this.connected) {
      const e = Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' });
      queueMicrotask(() => (callback ? callback(e) : this.emit('error', e)));
      return false;
    }
    this.sent.push(message);
    queueMicrotask(() => callback?.(null));
    return true;
  }
  kill() {
    this.stop();
    return true;
  }
  /** It crashed. */
  stop() {
    if (!this.connected) return;
    this.connected = false;
    this.emit('exit', null, 'SIGKILL');
  }
}

const children: Child[] = [];
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  fork: () => {
    const child = new Child();
    children.push(child);
    return child;
  },
}));
vi.mock('../src/models/files.ts', async (original) => ({
  ...(await original<typeof import('../src/models/files.ts')>()),
  whereInstalled: async () => ({ dir: '/nowhere', bundled: false }),
}));

const { kokoro, stopVoice, synthesize } = await import('../src/voice/tts.ts');
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Kokoro's process", () => {
  it("never takes Nova down when it stops, and the next reply starts it again", async () => {
    const ready = kokoro();
    await tick();
    children[0]!.emit('message', { type: 'ready', ms: 5 });
    expect(await ready).toBe(true);

    const speaking = synthesize('Hello there.', { voice: 'af_heart', speed: 1, onChunk: () => {} });
    await tick();
    expect(children[0]!.sent.at(-1)).toMatchObject({ type: 'speak', text: 'Hello there.' });
    children[0]!.stop(); // it crashed mid-reply
    await expect(speaking).rejects.toThrow('The voice stopped.');

    // A reply wanted no more, its chunk arriving as the process goes: no 'stop' sent into the void.
    const next = synthesize('Again.', { voice: 'af_heart', speed: 1, stillWanted: () => false, onChunk: () => {} });
    await tick();
    expect(children).toHaveLength(2);
    children[1]!.emit('message', { type: 'ready', ms: 5 });
    await tick();
    const id = children[1]!.sent.find((m) => m.type === 'speak')!.id;
    children[1]!.connected = false;
    children[1]!.emit('message', { type: 'chunk', id, seq: 0, sampleRate: 24_000, pcm: '', last: true });
    await expect(next).resolves.toBeUndefined();
    await tick();
    stopVoice();
  });
});
