import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { withTime, type ReasoningBrain, type Turn } from '@nova/core';
import type { McpServer } from './bridge.ts';
import { claudeDelta } from './parsers.ts';
import type { AgentPreset } from './presets.ts';
import { channel, type Channel } from './stream.ts';

export interface SessionAgent {
  preset: AgentPreset;
  bin: string;
  model?: string;
  extraArgs: string[];
}

interface ActiveTurn {
  out: Channel<string>;
  wrote: boolean;
  done: () => void;
}

/**
 * An agent kept running as Nova's brain: one CLI process for the whole conversation, so there's
 * no start-up for each question, it remembers what was said, and answers stream as they're
 * written. Questions take turns; stopping one restarts the process (the next question gets the
 * recent conversation to pick up from).
 */
export class AgentSession implements ReasoningBrain {
  readonly name: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private turn: ActiveTurn | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private fresh = true;
  private stderr = '';

  constructor(
    private readonly agent: SessionAgent,
    private readonly opts: { cwd: string; assistant: string; tools?: McpServer; env: (extra?: Record<string, string>) => NodeJS.ProcessEnv },
  ) {
    this.name = agent.preset.label;
  }

  /** Start the process ahead of the first question. */
  warm() {
    if (!this.child) this.start();
  }

  private start() {
    const invocation = this.agent.preset.session!({ model: this.agent.model, assistant: this.opts.assistant, tools: this.opts.tools });
    const child = spawn(this.agent.bin, [...invocation.args, ...this.agent.extraArgs], { cwd: this.opts.cwd, env: this.opts.env(invocation.env), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.fresh = true;
    child.stderr.on('data', (d) => (this.stderr = (this.stderr + d).slice(-2000)));
    child.stdin.on('error', () => {});
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      const turn = this.turn;
      this.turn = null;
      turn?.out.end(new Error(this.stderr.trim().split('\n').at(-1)?.slice(0, 200) || `${this.name} stopped (${code}).`));
      turn?.done();
    });
  }

  private onLine(line: string) {
    const turn = this.turn;
    if (!turn) return;
    const piece = claudeDelta(line);
    if (piece) {
      turn.wrote = true;
      return turn.out.push(piece);
    }
    if (!line.includes('"result"')) return;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (e?.type !== 'result') return;
    // Without partial messages the whole answer arrives here.
    if (!turn.wrote && typeof e.result === 'string' && !e.is_error) turn.out.push(e.result);
    this.turn = null;
    turn.out.end(e.is_error ? new Error(typeof e.result === 'string' ? e.result : `${this.name} failed`) : undefined);
    turn.done();
  }

  stream(utterance: string, history: Turn[], signal?: AbortSignal): AsyncIterable<string> {
    const out = channel<string>();
    this.queue = this.queue.then(
      () =>
        new Promise<void>((done) => {
          if (signal?.aborted) {
            out.end(new Error('Stopped.'));
            return done();
          }
          if (!this.child) this.start();
          // A new process doesn't know the conversation yet: give it the recent turns.
          const context =
            this.fresh && history.length
              ? `Conversation so far:\n${history.map((t) => `User: ${t.user}\n${this.opts.assistant}: ${t.nova}`).join('\n')}\n\nUser: `
              : '';
          this.fresh = false;
          const finish = () => {
            signal?.removeEventListener('abort', stop);
            done();
          };
          const stop = () => {
            this.close(); // the only way to stop a turn mid-answer; the next question starts a new process
            out.end(new Error('Stopped.'));
          };
          signal?.addEventListener('abort', stop, { once: true });
          this.turn = { out, wrote: false, done: finish };
          this.child!.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: withTime(context + utterance) } })}\n`);
        }),
    );
    return out;
  }

  async reply(utterance: string, history: Turn[], signal?: AbortSignal) {
    let text = '';
    for await (const piece of this.stream(utterance, history, signal)) text += piece;
    return text.trim();
  }

  /** Start a fresh process after any question in progress, so it sees what changed (its tools, say). */
  refresh() {
    this.queue = this.queue.then(() => {
      if (!this.child) return;
      this.close();
      this.start();
    });
  }

  close() {
    const child = this.child;
    this.child = null;
    child?.kill();
  }
}
