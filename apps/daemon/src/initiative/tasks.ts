import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TaskRecord } from '@nova/core';

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

  constructor(
    private readonly file: string,
    private readonly changed: (tasks: TaskRecord[]) => void = () => {},
  ) {}

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as { tasks?: TaskRecord[] };
      this.tasks = (parsed.tasks ?? []).filter((t) => typeof t?.id === 'string' && typeof t.task === 'string');
    } catch {
      this.tasks = [];
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
    const data = `${JSON.stringify({ tasks: this.tasks }, null, 2)}\n`;
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(`${this.file}.tmp`, data, { mode: 0o600 });
        await rename(`${this.file}.tmp`, this.file);
      })
      .catch((e) => console.warn(`  [tasks] can't save: ${(e as Error).message}`));
    return this.saving;
  }
}
