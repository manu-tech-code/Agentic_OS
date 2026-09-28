import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/** What the hearing helper reports, one JSON object per line. */
export type HelperEvent =
  | { type: 'ready'; engine: string; ms: number }
  | { type: 'partial'; text: string }
  | { type: 'final'; turn: number; text: string; ms: number }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'log'; message: string }
  /** A voiceprint (Voice ID), or why there isn't one. */
  | { type: 'voiceprint'; id: number; print?: number[]; error?: string };

/** One message for the helper's stdin: [type: 1 = audio, 2 = JSON command][length, 4 bytes little endian][payload]. */
export function frame(type: 1 | 2, payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(5 + payload.length);
  out[0] = type;
  out.writeUInt32LE(payload.length, 1);
  payload.copy(out, 5);
  return out;
}

/**
 * The hearing helper process (native/hearing): speech to text with Apple's recognizer or
 * Parakeet. Audio and commands go in on stdin; transcripts come back on stdout.
 */
export class HearingHelper {
  private readonly child: ChildProcess;
  private closed = false;
  private gone = false;

  constructor(bin: string, onEvent: (event: HelperEvent) => void, onExit: (code: number | null, stderr: string) => void) {
    this.child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    // Once, however it ends: it exited, or it never started (the binary is missing) - never an unhandled 'error'.
    const ended = (code: number | null, why?: string) => {
      this.closed = true;
      if (this.gone) return;
      this.gone = true;
      onExit(code, why ?? stderr.trim());
    };
    this.child.on('error', (e) => ended(null, e.message));
    this.child.stderr!.on('data', (d: Buffer) => (stderr = (stderr + String(d)).slice(-2000)));
    createInterface({ input: this.child.stdout! }).on('line', (line) => {
      try {
        onEvent(JSON.parse(line) as HelperEvent);
      } catch {
        // not an event: FluidAudio or the OS logging to stdout
      }
    });
    this.child.stdin!.on('error', () => {}); // it exited; 'exit' reports why
    this.child.on('exit', (code) => ended(code));
  }

  command(command: Record<string, unknown>) {
    this.write(frame(2, Buffer.from(JSON.stringify(command))));
  }

  audio(pcm: Buffer) {
    this.write(frame(1, pcm));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin!.end();
    this.child.kill();
  }

  private write(data: Buffer) {
    if (!this.closed && this.child.stdin!.writable) this.child.stdin!.write(data);
  }
}
