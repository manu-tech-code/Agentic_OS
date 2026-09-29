import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * How Nova's hands run the Mac's own commands (osascript, networksetup, pmset, mdfind, shortcuts):
 * as small functions, so tests hand in fakes and check exactly which command lines would run.
 * Arguments are always passed as a list - never through a shell.
 */

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Run a command; rejects with its last line of stderr when it fails. */
export type Run = (command: string, args: string[], opts?: { timeoutMs?: number; input?: string }) => Promise<RunResult>;

/** The first `max` lines a command prints, then it's stopped (a Spotlight search can print thousands). */
export type Lines = (command: string, args: string[], max: number, timeoutMs?: number) => Promise<string[]>;

export class CommandError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export const run: Run = (command, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: opts.timeoutMs ?? 15_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout, stderr });
      const code = typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((error as unknown as { code: number }).code) : null;
      const last = String(stderr).trim().split('\n').at(-1) || error.message;
      reject(new CommandError(error.killed ? `${command} took too long.` : last, code, String(stderr)));
    });
    child.stdin?.on('error', () => {});
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });

export const lines: Lines = (command, args, max, timeoutMs = 8000) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: string[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(out);
    };
    const timer = setTimeout(finish, timeoutMs);
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (line.trim()) out.push(line);
      if (out.length >= max) finish();
    });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', finish);
  });

/** AppleScript, with values passed as arguments (`item 1 of argv`) - never pasted into the script. */
export const osascript = (run: Run, lines: string[], args: string[] = [], timeoutMs = 10_000) =>
  run('osascript', [...lines.flatMap((l) => ['-e', l]), ...args], { timeoutMs }).then((r) => r.stdout.trim());
