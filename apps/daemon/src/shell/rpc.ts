import type { ServerEvent, ShellOp } from '@nova/core';

/**
 * What the daemon asks Nova's Mac app to do - add to the Reminders app, read the calendar, post a
 * notification - and its answers. Each request waits a few seconds at most, and fails at once when
 * there's no app to ask.
 */
export class ShellRpc {
  private seq = 0;
  private readonly waiting = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  /** `send` delivers to the app and says whether there was one. */
  constructor(private readonly send: (event: ServerEvent) => boolean) {}

  request<T = unknown>(op: ShellOp, args: Record<string, unknown> = {}, timeoutMs = 8000): Promise<T> {
    const id = `r${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error("Nova.app didn't answer in time."));
      }, timeoutMs);
      this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      if (!this.send({ type: 'shell-request', id, op, args })) {
        clearTimeout(timer);
        this.waiting.delete(id);
        reject(new Error("Nova.app isn't running."));
      }
    });
  }

  /** The app's answer to one request. */
  reply(id: string, ok: boolean, result?: unknown, error?: string) {
    const waiting = this.waiting.get(id);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.waiting.delete(id);
    if (ok) waiting.resolve(result);
    else waiting.reject(new Error(error || "Nova.app couldn't do it."));
  }

  /** The app went away: nothing it was asked will be answered. */
  gone() {
    for (const [id, waiting] of this.waiting) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error('Nova.app closed.'));
      this.waiting.delete(id);
    }
  }
}
