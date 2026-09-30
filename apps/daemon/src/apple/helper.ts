/**
 * Apple Intelligence's on-device model, through Nova's Apple model helper (native/apple-model): a
 * small Swift program on Apple's Foundation Models framework, built on this Mac the first time it's
 * needed and again after its sources change, and signed like Nova's other helpers. It takes one
 * JSON object per line on stdin and answers the same way on stdout (see its main.swift).
 *   npm run apple:build
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { AppleModelStatus, ToolOutput, ToolSpec } from '@nova/core';
import { channel, type Channel } from '../agents/stream.ts';
import { currentIdentity, needsSigning, signApp } from '../shell/signing.ts';

export const applePackage = fileURLToPath(new URL('../../native/apple-model', import.meta.url));
export const appleBinary = join(applePackage, '.build', 'release', 'nova-apple-model');

/** What a tool says goes to the model at most this long; the helper cuts it further, to what's left of the context. */
const MOST_TOOL_TEXT = 6000;

const mtime = (path: string) => stat(path).then((s) => s.mtimeMs, () => 0);

/** Why this Mac can't have Apple's on-device model, whatever is built: it takes Apple silicon and macOS 26. */
export function cantRunHere(os = { platform: platform(), arch: arch(), release: release() }): AppleModelStatus['reason'] | null {
  if (os.platform !== 'darwin') return 'system';
  if (os.arch !== 'arm64') return 'device';
  return Number(os.release.split('.')[0]) < 25 ? 'system' : null; // Darwin 25 is macOS 26
}

let building: Promise<string> | null = null;

/** The helper, built and signed on this Mac - built again only after its sources change, signed again when the identity does. */
export function ensureAppleHelper(): Promise<string> {
  building ??= (async () => {
    const sources = [join(applePackage, 'Package.swift'), ...(await readdir(join(applePackage, 'Sources'))).map((f) => join(applePackage, 'Sources', f))];
    const newest = Math.max(...(await Promise.all(sources.map(mtime))));
    const identity = await currentIdentity();
    if ((await mtime(appleBinary)) >= newest) {
      if (await needsSigning(appleBinary, identity)) await signApp(appleBinary, 'apple', identity);
      return appleBinary;
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn('swift', ['build', '-c', 'release', '--package-path', applePackage], { stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      child.stdout.on('data', (d) => (log = (log + d).slice(-3000)));
      child.stderr.on('data', (d) => (log = (log + d).slice(-3000)));
      child.on('error', (e) => reject(new Error(`Couldn't run swift (install Xcode or its Command Line Tools): ${e.message}`)));
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Building Nova's helper for Apple's model failed:\n${log.split('\n').slice(-10).join('\n')}`))));
    });
    // Hardened, and with the user's certificate when there is one - like Nova's other helpers.
    await signApp(appleBinary, 'apple', identity);
    return appleBinary;
  })().finally(() => (building = null));
  return building;
}

/** One question for Apple's model. */
export interface AppleQuestion {
  instructions: string;
  /** Earlier turns, as turns of the conversation. */
  history: { user: string; nova: string }[];
  /** Or earlier turns written into the instructions, after a note: each turn's lines, oldest first. */
  context?: { note: string; turns: string[] };
  prompt: string;
  /** Nova's tools for it, best first: what doesn't fit in the model's context goes from the end. */
  tools: ToolSpec[];
  /** It asks for something to be done: a tool call comes before any answer (macOS 27 on). */
  act?: boolean;
  /** Room for the answer, in tokens. */
  maxTokens?: number;
}

/** Runs a tool call the model makes, and says what happened. */
export type AppleToolRunner = (name: string, args: Record<string, unknown>) => Promise<ToolOutput>;

interface HelperStatus {
  type: 'status';
  available: boolean;
  reason?: string;
  model?: string;
  contextSize?: number;
  vision?: boolean;
}

type HelperEvent =
  | HelperStatus
  | { type: 'text'; id: string; text: string }
  | { type: 'tool-call'; id: string; call: string; name: string; arguments?: Record<string, unknown> }
  | { type: 'done'; id: string }
  | { type: 'error'; id: string; code: string; detail?: string };

/** Why Apple's model couldn't answer, by the helper's code - in words Nova can say. */
export const APPLE_PROBLEMS: Record<string, string> = {
  off: 'Apple Intelligence is off - turn it on in System Settings → Apple Intelligence & Siri.',
  downloading: "Apple's model isn't ready yet - macOS may still be downloading it.",
  device: "This Mac can't run Apple Intelligence.",
  system: 'Apple Intelligence needs a Mac with Apple silicon and macOS 26 or later.',
  build: "Nova couldn't set up its helper for Apple's model - see Settings → Answers.",
  language: "Apple's model doesn't speak this language yet.",
  context: "That's more than Apple's model can take in at once.",
  guardrail: "Apple's model wouldn't answer that - its safety rules stopped it.",
  refusal: "Apple's model chose not to answer that.",
  busy: "Apple's model is busy - try again in a moment.",
  timeout: "Apple's model took too long.",
  stopped: "Apple's model stopped.",
};

/** Something Apple's model couldn't do: the helper's code, and the framework's own account of it. */
export class AppleModelError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string,
  ) {
    super(APPLE_PROBLEMS[code] ?? detail ?? "Apple's model couldn't answer.");
  }
}

/** The helper's status, as Settings shows it. */
export function statusFrom(e: HelperStatus): AppleModelStatus {
  const about = { ...(e.model ? { model: e.model } : {}), ...(e.contextSize ? { contextSize: e.contextSize } : {}), ...(e.vision !== undefined ? { vision: e.vision } : {}) };
  if (e.available) return { state: 'ready', ...about };
  const reason = e.reason === 'off' || e.reason === 'downloading' || e.reason === 'device' ? e.reason : 'failed';
  return { state: 'unavailable', reason, ...about };
}

interface Asking {
  out: Channel<string>;
  run: AppleToolRunner;
  vision: boolean;
  done: () => void;
}

/**
 * The daemon's link to the helper: started on first use and again if it stops, one question at a
 * time (the next waits its turn), each answer streamed as it's written.
 */
export class AppleModel {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<ChildProcessWithoutNullStreams> | null = null;
  private readonly asking = new Map<string, Asking>();
  private statusWaiters: { resolve: (s: HelperStatus) => void; reject: (e: Error) => void }[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private stderr = '';
  private started = false;
  private checkedAt = 0;
  private checking: Promise<AppleModelStatus> | null = null;
  /** What the Mac said last - 'checking' until it's been asked. */
  known: AppleModelStatus = { state: 'checking' };

  constructor(
    private readonly opts: {
      /** What the Mac says changed (Apple Intelligence switched on, say). */
      changed?: (status: AppleModelStatus) => void;
      /** The program to run - the built helper unless a test says otherwise. */
      command?: () => Promise<{ command: string; args: string[] }>;
      /** Why this Mac can't run it at all, if it can't. */
      cantRun?: () => AppleModelStatus['reason'] | null;
    } = {},
  ) {}

  /** Whether Apple's model can answer on this Mac now - asked of the helper again once the last answer is a minute old. */
  status(maxAgeMs = 60_000): Promise<AppleModelStatus> {
    const here = (this.opts.cantRun ?? cantRunHere)();
    if (here) return Promise.resolve(this.settle({ state: 'unavailable', reason: here }));
    if (this.known.state !== 'checking' && Date.now() - this.checkedAt < maxAgeMs) return Promise.resolve(this.known);
    this.checking ??= (async () => {
      try {
        const child = await this.start();
        const status = await new Promise<HelperStatus>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Nova's helper for Apple's model didn't answer.")), 10_000);
          this.statusWaiters.push({ resolve: (s) => (clearTimeout(timer), resolve(s)), reject: (e) => (clearTimeout(timer), reject(e)) });
          this.write(child, { type: 'status' });
        });
        return this.settle(statusFrom(status));
      } catch (e) {
        return this.settle({ state: 'unavailable', reason: this.started ? 'failed' : 'build', message: (e as Error).message });
      }
    })().finally(() => (this.checking = null));
    return this.checking;
  }

  /** Start the helper and load the model, so the next question waits for neither. */
  warm(instructions: string) {
    if ((this.opts.cantRun ?? cantRunHere)()) return;
    this.start().then(
      (child) => this.write(child, { type: 'warm', instructions }),
      () => {},
    );
  }

  /** One question: its answer as it's written. `run` does each tool call the model makes. */
  ask(question: AppleQuestion, run: AppleToolRunner, signal?: AbortSignal): AsyncIterable<string> {
    const out = channel<string>();
    this.queue = this.queue.then(
      () =>
        new Promise<void>((done) => {
          if (signal?.aborted) {
            out.end(new Error('Stopped.'));
            return done();
          }
          const here = (this.opts.cantRun ?? cantRunHere)();
          if (here) {
            out.end(new AppleModelError(here));
            return done();
          }
          const id = `q${++this.seq}`;
          const stop = () => {
            if (!this.asking.has(id)) return;
            if (this.child) this.write(this.child, { type: 'cancel', id });
            this.finish(id, new Error('Stopped.'));
          };
          signal?.addEventListener('abort', stop, { once: true });
          const finished = () => {
            signal?.removeEventListener('abort', stop);
            done();
          };
          this.asking.set(id, { out, run, vision: this.known.vision === true, done: finished });
          const tools = question.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
          this.start().then(
            (child) => this.asking.has(id) && this.write(child, { type: 'ask', id, ...question, tools }),
            (e) => this.finish(id, new AppleModelError('build', (e as Error).message)),
          );
        }),
    );
    return out;
  }

  /** The helper goes, and any question it was answering ends. */
  close() {
    const child = this.child;
    this.child = null;
    this.dropAll(new AppleModelError('stopped'));
    child?.stdin.end();
    child?.kill();
  }

  private start(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child) return Promise.resolve(this.child);
    this.starting ??= (async () => {
      const { command, args } = await (this.opts.command?.() ?? ensureAppleHelper().then((bin) => ({ command: bin, args: [] })));
      const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      this.started = true;
      this.child = child;
      this.stderr = '';
      child.stdin.on('error', () => {});
      child.stderr.on('data', (d) => (this.stderr = (this.stderr + d).slice(-2000)));
      // Only the current helper speaks: one that was replaced is ignored.
      createInterface({ input: child.stdout }).on('line', (line) => this.child === child && this.onLine(line));
      const gone = (why: string) => {
        if (this.child !== child) return;
        this.child = null;
        this.dropAll(new AppleModelError('stopped', why));
      };
      child.on('error', (e) => gone(e.message));
      child.on('exit', (code) => gone(this.stderr.trim().split('\n').at(-1)?.slice(0, 200) || `it stopped (${code})`));
      return child;
    })().finally(() => (this.starting = null));
    return this.starting;
  }

  private write(child: ChildProcessWithoutNullStreams, command: Record<string, unknown>) {
    child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private onLine(line: string) {
    let e: HelperEvent;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (e.type === 'status') return this.statusWaiters.shift()?.resolve(e);
    const asking = this.asking.get(e.id);
    if (!asking) return; // stopped already
    if (e.type === 'text') asking.out.push(e.text);
    else if (e.type === 'tool-call') void this.runTool(e.id, e.call, e.name, e.arguments ?? {}, asking);
    else if (e.type === 'done') this.finish(e.id);
    else if (e.type === 'error') {
      // Unavailable: the reason is the detail (Apple Intelligence switched off, say) - and Settings hears of it now.
      const unavailable = e.code === 'unavailable';
      this.finish(e.id, new AppleModelError(unavailable && e.detail ? e.detail : e.code, e.detail));
      if (unavailable) void this.status(0);
    }
  }

  private async runTool(id: string, call: string, name: string, args: Record<string, unknown>, asking: Asking) {
    let output: ToolOutput;
    try {
      output = await asking.run(name, args);
    } catch (e) {
      output = `That didn't work: ${(e as Error).message}`;
    }
    if (this.asking.get(id) !== asking || !this.child) return; // the question ended meanwhile
    const text = typeof output === 'string' ? output : output.text;
    const image = typeof output === 'string' ? undefined : output.image;
    this.write(this.child, {
      type: 'tool-result',
      id,
      call,
      text: text.length > MOST_TOOL_TEXT ? `${text.slice(0, MOST_TOOL_TEXT)} …(cut short)` : text,
      ...(image && asking.vision ? { image } : {}),
    });
  }

  private finish(id: string, error?: Error) {
    const asking = this.asking.get(id);
    if (!asking) return;
    this.asking.delete(id);
    asking.out.end(error);
    asking.done();
  }

  private dropAll(error: Error) {
    for (const id of [...this.asking.keys()]) this.finish(id, error);
    for (const waiter of this.statusWaiters.splice(0)) waiter.reject(error);
  }

  private settle(status: AppleModelStatus): AppleModelStatus {
    this.checkedAt = Date.now();
    const was = JSON.stringify(this.known);
    this.known = status;
    if (JSON.stringify(status) !== was) this.opts.changed?.(status);
    return status;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log("Building Nova's helper for Apple's model…");
  const bin = await ensureAppleHelper();
  const model = new AppleModel({ command: async () => ({ command: bin, args: [] }) });
  const status = await model.status();
  model.close();
  console.log(`Ready: ${bin}\n  ${status.state === 'ready' ? `${status.model ?? "Apple's model"} can answer (${status.contextSize} tokens at a time)` : APPLE_PROBLEMS[status.reason ?? ''] ?? status.message ?? status.state}`);
}
