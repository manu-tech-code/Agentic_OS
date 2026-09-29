import { appendFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Recordings of the user's turns, kept only when they switch it on (Settings → Voice ID): what Nova heard of each
 * turn, with what Voice ID made of it, so its accuracy can be checked - and its models tuned - on the user's own
 * voice. On this Mac only, readable by the user alone: a folder a day (WAV files and an index), deleted after a
 * week, and all of it at once when it's switched off.
 */

/** What a recording was: a turn Voice ID judged, one said with the talk shortcut, or part of setting up or a test. */
export type RecordingKind = 'turn' | 'shortcut' | 'setup' | 'check' | 'test';

export interface Recording {
  kind: RecordingKind;
  audio: Int16Array;
  /** What was heard. */
  text: string;
  seconds: number;
  /** Voice ID's decision and match, and each model's. */
  speaker?: string;
  score?: number | null;
  scores?: Record<string, number>;
  why?: string;
  /** Who heard it ("Nova.app"), and whether Nova was speaking meanwhile. */
  heardBy?: string;
  overlapped?: boolean;
  /** A setup phrase: whether it was taken. */
  ok?: boolean;
}

const RATE = 16_000;
export const KEEP_DAYS = 7;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
/** The local day a moment falls on ("2026-09-28"), as the conversation files are named. */
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 16 kHz mono 16-bit PCM, as a WAV file. */
export function wav(audio: Int16Array): Buffer {
  const data = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

export class VoiceRecordings {
  private seq = 0;
  /** Writes, one after another, so the index keeps their order - and clearing waits for them. */
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly opts: { on: () => boolean; days?: number; now?: () => Date },
  ) {}

  get on() {
    return this.opts.on();
  }

  /** Keep this one, when recordings are switched on - in the background: a failed write never holds a turn up. */
  keep(recording: Recording) {
    if (!this.opts.on() || !recording.audio.length) return;
    const at = this.opts.now?.() ?? new Date();
    const folder = join(this.dir, dayOf(at));
    const file = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}-${pad(++this.seq % 10_000, 4)}-${recording.kind}.wav`;
    const { audio, ...about } = recording;
    const entry = { at: at.toISOString(), file, ...about, seconds: Math.round(about.seconds * 100) / 100 };
    this.writing = this.writing
      .then(async () => {
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await writeFile(join(folder, file), wav(audio), { mode: 0o600 });
        await appendFile(join(folder, 'index.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      })
      .catch((e) => console.warn(`  [voice-id] couldn't keep a recording: ${(e as Error).message}`));
  }

  /** Delete the days older than a week (or all of them, when recordings are off). How many days went. */
  async sweep(): Promise<number> {
    await this.writing;
    if (!this.opts.on()) return (await this.clear(), 0);
    const now = this.opts.now?.() ?? new Date();
    const oldest = dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((this.opts.days ?? KEEP_DAYS) - 1)));
    const days = await readdir(this.dir).catch(() => [] as string[]);
    const old = days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < oldest);
    for (const d of old) await rm(join(this.dir, d), { recursive: true, force: true });
    return old.length;
  }

  /** Delete every recording. */
  async clear() {
    await this.writing;
    await rm(this.dir, { recursive: true, force: true });
  }

  flushed() {
    return this.writing;
  }
}
