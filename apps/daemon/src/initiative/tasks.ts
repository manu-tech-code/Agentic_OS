import { readFile } from 'node:fs/promises';
import type { TaskRecord } from '@nova/core';
import { setAside, writeDurably } from './durable.ts';

const KEEP = 100;

/**
 * The task board: every agent task - running, finished, failed or stopped - with what it did and
 * said, kept in ~/.nova/tasks.json (the latest 100). A task still running when Nova stopped is
 * marked as stopped: its agent went with it.
 */
export class TaskStore {
  private tasks: TaskRecord[] = [];
  private saving: Promise<unknown> = Promise.resolve();
  private pending: ReturnType<typeof setTimeout> | undefined;
  /** The file couldn't be read, nor kept aside: nothing is saved over it. */
  private broken = false;

  constructor(
    private readonly file: string,
    private readonly changed: (tasks: TaskRecord[]) => void = () => {},
  ) {}

  async load() {
    let raw: string | null = null;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.broken = true; // there, but not readable: left as it is
    }
    this.tasks = [];
    if (raw !== null) {
      let parsed: { tasks?: unknown } | null = null;
      try {
        parsed = JSON.parse(raw) as { tasks?: unknown };
      } catch {
        // below
      }
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tasks)) {
        this.tasks = (parsed.tasks as TaskRecord[]).filter((t) => typeof t?.id === 'string' && typeof t.task === 'string');
      } else {
        const kept = await setAside(this.file); // unreadable: kept beside, never written over
        this.broken = !kept;
        console.warn(`  [tasks] ${this.file} couldn't be read${kept ? `, so it's kept as ${kept}` : " - it's left as it is"}`);
      }
    }
    for (const t of this.tasks) {
      if (t.status !== 'running') continue;
      t.status = 'cancelled';
      t.report = t.report ?? 'Nova stopped before it finished.';
      t.ended = t.ended ?? Date.now();
    }
    return this;
  }

  /** A task started, took a step, or ended. */
  update(task: TaskRecord) {
    const i = this.tasks.findIndex((t) => t.id === task.id);
    if (i >= 0) this.tasks[i] = task;
    else this.tasks.unshift(task);
    if (this.tasks.length > KEEP) this.tasks.length = KEEP;
    this.changed(this.list());
    // Steps come fast: one save a moment later covers them.
    clearTimeout(this.pending);
    this.pending = setTimeout(() => void this.save(), task.status === 'running' ? 1000 : 0);
  }

  /** Newest first. */
  list(): TaskRecord[] {
    return [...this.tasks].sort((a, b) => b.started - a.started);
  }

  get(id: string) {
    return this.tasks.find((t) => t.id === id);
  }

  flushed() {
    clearTimeout(this.pending);
    return this.save();
  }

  private save() {
    if (this.broken) return this.saving;
    const data = `${JSON.stringify({ tasks: this.tasks }, null, 2)}\n`;
    this.saving = this.saving.then(() => writeDurably(this.file, data)).catch((e) => console.warn(`  [tasks] can't save: ${(e as Error).message}`));
    return this.saving;
  }
}
