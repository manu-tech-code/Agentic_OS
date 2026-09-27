import { appendFile, chmod, mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActionRecord, ActionService, ActivityItem, UndoStep } from '@nova/core';

/**
 * The record of what Nova did: every action, who asked for it, how it went, and how to take it
 * back. One file a day in ~/.nova/activity (YYYY-MM-DD.jsonl, only the user can read them), kept
 * as long as Settings says. The last week is at hand for "undo that" and "what did you do today?";
 * searching reads the older days from disk.
 */

/**
 * A line of a day's file: an action as it happened, or a later change to one - it was undone
 * (`undone` 0: it wasn't after all), or only part of it was and `undo` is what's left.
 */
type Line = Logged | { id: string; undone: number; undo?: UndoStep };

interface Logged extends ActivityItem {
  undo?: UndoStep;
}

/** Days kept at hand. */
const AT_HAND_DAYS = 7;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

const dayOf = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const daysBack = (now: number, days: number) => {
  const d = new Date(now);
  return dayOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - days).getTime());
};

/** An action as windows see it: never how it's undone (memory text, snapshot ids stay here). */
const shown = ({ undo: _undo, ...item }: Logged): ActivityItem => ({ ...item, undoable: Boolean(item.undoable && !item.undone) || undefined });

const record = (item: Logged): ActionRecord => ({
  id: item.id,
  at: item.at,
  label: item.label,
  by: item.by,
  skill: item.skill,
  status: item.status,
  undoable: Boolean(item.undo && !item.undone),
  undone: item.undone,
  files: item.files,
});

export interface UndoResult {
  ok: boolean;
  message: string;
  /** Only part of it could be undone: what's left, still to undo (the record keeps it undoable). */
  rest?: UndoStep;
}

export class ActionLog implements ActionService {
  /** The last week, oldest first. */
  private items: Logged[] = [];
  private writing: Promise<unknown> = Promise.resolve();
  private readonly undoing = new Set<string>();
  private readonly private = new Set<string>();
  /** Actions in the whole record, as last counted. */
  private counted = 0;
  private readonly now: () => number;

  constructor(
    private readonly opts: {
      dir: string;
      /** How many days the record keeps. */
      keepDays: () => number;
      /** Take one step back: the Undoer. */
      undo: (step: UndoStep, action: ActionRecord) => Promise<UndoResult>;
      /** An entry changed (it was undone): tell the windows. */
      changed?: (item: ActivityItem) => void;
      now?: () => number;
    },
  ) {
    this.now = opts.now ?? Date.now;
  }

  async load() {
    await mkdir(this.opts.dir, { recursive: true, mode: 0o700 });
    await this.prune();
    const from = daysBack(this.now(), AT_HAND_DAYS - 1);
    this.items = (await this.read((day) => day >= from)).reverse();
    return this;
  }

  /** Something Nova did: kept (with how to take it back), and returned as windows should see it. */
  add(item: ActivityItem, undo?: UndoStep): ActivityItem {
    const logged: Logged = { ...item, undoable: Boolean(undo) || undefined, ...(undo ? { undo } : {}) };
    if (undo?.kind === 'agent-files') logged.files = undo.files;
    this.items.push(logged);
    this.counted++;
    // Only the last week stays at hand; the files keep the rest.
    const from = daysBack(this.now(), AT_HAND_DAYS - 1);
    if (this.items.length > 500 && dayOf(this.items[0]!.at) < from) this.items = this.items.filter((i) => dayOf(i.at) >= from);
    this.write(logged.at, logged);
    return shown(logged);
  }

  /** The latest, newest first, for the timeline. */
  history(limit = 200): ActivityItem[] {
    return this.items.slice(-limit).reverse().map(shown);
  }

  recent(days = 1): ActionRecord[] {
    const from = daysBack(this.now(), Math.min(days, AT_HAND_DAYS) - 1);
    return this.items.filter((i) => dayOf(i.at) >= from).reverse().map(record);
  }

  lastUndoable(by?: string): ActionRecord | null {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i]!;
      if (item.undo && !item.undone && (!by || item.by === by)) return record(item);
    }
    return null;
  }

  async undo(id: string): Promise<UndoResult> {
    const item = this.items.find((i) => i.id === id);
    if (!item) return { ok: false, message: "I can't find that in the record any more - it's more than a week old." };
    if (item.undone) return { ok: false, message: `"${item.label}" was already undone.` };
    if (!item.undo) return { ok: false, message: `"${item.label}" can't be undone.` };
    if (this.undoing.has(id)) return { ok: false, message: `I'm already undoing "${item.label}".` };
    this.undoing.add(id);
    try {
      // On disk as undone before it's done: Nova stopping halfway must never let it be undone twice.
      const at = this.now();
      if (!(await this.mark(item.at, { id, undone: at }))) return { ok: false, message: `I can't write to the record, so I haven't undone "${item.label}".` };
      let result: UndoResult;
      try {
        result = await this.opts.undo(item.undo, record(item));
      } catch (e) {
        result = { ok: false, message: `I couldn't undo "${item.label}": ${(e as Error).message}` };
      }
      if (result.ok && !result.rest) {
        item.undone = at;
        this.opts.changed?.(shown(item));
      } else {
        // Not undone after all - or only part of it, and what's left can still be.
        if (result.ok) item.undo = result.rest;
        await this.mark(item.at, { id, undone: 0, ...(result.ok ? { undo: result.rest } : {}) });
      }
      return result;
    } finally {
      this.undoing.delete(id);
    }
  }

  /**
   * Search the whole record: every word must be in the label or in who asked ("claude", "reminder",
   * "failed", "undone"). Newest first.
   */
  async search(query: string, days = this.opts.keepDays(), limit = 300): Promise<ActivityItem[]> {
    await this.writing;
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const from = daysBack(this.now(), Math.max(1, days) - 1);
    const all = await this.read((day) => day >= from);
    const found: ActivityItem[] = [];
    for (const item of all) {
      const text = `${item.label} ${item.by ?? ''} ${item.status} ${item.undone ? 'undone' : ''} ${item.files?.join(' ') ?? ''}`.toLowerCase();
      if (words.every((w) => text.includes(w))) found.push(shown(item));
      if (found.length >= limit) break;
    }
    return found;
  }

  /** How long the record is kept, and how much of it there is. */
  stats() {
    return { days: this.opts.keepDays(), kept: this.counted };
  }

  /** Days past what Settings keeps are deleted. */
  async prune() {
    const oldest = daysBack(this.now(), this.opts.keepDays() - 1);
    let kept = 0;
    for (const name of await readdir(this.opts.dir).catch(() => [] as string[])) {
      const day = DAY_FILE.exec(name)?.[1];
      if (!day) continue;
      if (day < oldest) await rm(join(this.opts.dir, name), { force: true });
      else kept += (await readFile(join(this.opts.dir, name), 'utf8').catch(() => '')).split('\n').filter((l) => l.includes('"label":')).length;
    }
    this.counted = kept;
  }

  flushed() {
    return this.writing.then(() => undefined);
  }

  /** The days chosen, newest first, with later changes (undone) applied. */
  private async read(want: (day: string) => boolean): Promise<Logged[]> {
    const names = (await readdir(this.opts.dir).catch(() => [] as string[])).filter((n) => DAY_FILE.test(n) && want(DAY_FILE.exec(n)![1]!)).sort().reverse();
    const out: Logged[] = [];
    for (const name of names) {
      const byId = new Map<string, Logged>();
      const day: Logged[] = [];
      for (const line of (await readFile(join(this.opts.dir, name), 'utf8').catch(() => '')).split('\n')) {
        if (!line.trim()) continue;
        let parsed: Line;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // a line cut short (the Mac lost power mid-write)
        }
        if ('label' in parsed && typeof parsed.label === 'string' && typeof parsed.at === 'number') {
          byId.set(parsed.id, parsed);
          day.push(parsed);
        } else if (typeof (parsed as { undone?: unknown }).undone === 'number') {
          const change = parsed as { id: string; undone: number; undo?: UndoStep };
          const item = byId.get(change.id);
          if (!item) continue;
          if (change.undone) item.undone = change.undone;
          else delete item.undone;
          if (change.undo && typeof change.undo === 'object' && typeof change.undo.kind === 'string') item.undo = change.undo;
        }
      }
      out.push(...day.reverse());
    }
    return out;
  }

  private write(at: number, line: Line) {
    const file = join(this.opts.dir, `${dayOf(at)}.jsonl`);
    const data = `${JSON.stringify(line)}\n`;
    this.writing = this.writing
      .then(async () => {
        await appendFile(file, data, { mode: 0o600 });
        // A file made before (or by hand) is made private too, once.
        if (!this.private.has(file)) await chmod(file, 0o600).then(() => this.private.add(file));
      })
      .catch((e) => console.warn(`  [activity] can't write ${file}: ${(e as Error).message}`));
  }

  /** A line that must be on disk before Nova goes on (after what's being written already): whether it is. */
  private mark(at: number, line: Line): Promise<boolean> {
    const file = join(this.opts.dir, `${dayOf(at)}.jsonl`);
    const data = `${JSON.stringify(line)}\n`;
    const done = this.writing.then(async () => {
      const handle = await open(file, 'a', 0o600);
      try {
        await handle.appendFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return true;
    });
    this.writing = done.catch(() => false);
    return done.catch((e) => {
      console.warn(`  [activity] can't write ${file}: ${(e as Error).message}`);
      return false;
    });
  }
}
