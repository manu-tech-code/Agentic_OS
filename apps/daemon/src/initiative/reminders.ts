import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { nextTime, type Reminder, type ReminderService } from '@nova/core';

/**
 * Nova's reminders and timers, kept in ~/.nova/reminders.json so they outlast a restart, and
 * brought up on time: once, or again and again for a repeating one. The Reminders app is reached
 * through Nova.app: reminders the user wants there go there too (so they reach the iPhone), and
 * the app's own are spoken when due as well.
 */

/** The Reminders app, through Nova.app. */
export interface AppleReminders {
  add(reminder: { title: string; due: number | null; list: string }): Promise<string>;
  /** Not yet done: due in the coming week, or with no date. */
  list(): Promise<{ id: string; title: string; due: number | null }[]>;
  complete(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

interface Stored extends Reminder {
  created: number;
  /** Its id in the Reminders app, when it's there too. */
  appleId?: string;
  /** From the Reminders app, not made by Nova. */
  appleOnly?: boolean;
}

/** One gone past by more than this is dropped rather than brought up late. */
const TOO_LATE_MS = 12 * 3_600_000;
/** "Snooze" and "done" are about a reminder brought up this recently. */
const RECENT_MS = 15 * 60_000;
/** Never wait longer than this in one go: clocks drift, and timers can't wait for weeks. */
const MAX_WAIT_MS = 6 * 3_600_000;

const newId = () => randomBytes(5).toString('hex');
const plain = ({ created: _c, appleId: _a, appleOnly: _o, ...r }: Stored): Reminder => r;

export class ReminderStore implements ReminderService {
  private items: Stored[] = [];
  private fromApple: Stored[] = [];
  /** Reminders app items already brought up, so a sync doesn't bring them up again. */
  private readonly firedApple = new Set<string>();
  private fired: { item: Stored; at: number }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(
    private readonly opts: {
      file: string;
      /** A reminder or timer is due - `late` when it's brought up after its time (Nova wasn't running). */
      due: (reminder: Reminder, late: boolean) => void;
      /** The Reminders app, when Nova.app is running and may use it. */
      apple: () => AppleReminders | null;
      mode: () => 'always' | 'when-asked' | 'never';
      /** The list in the Reminders app ("" for the default). */
      list: () => string;
      changed?: () => void;
      now?: () => number;
    },
  ) {
    this.now = opts.now ?? Date.now;
  }

  get apple(): 'always' | 'when-asked' | 'unavailable' {
    const mode = this.opts.mode();
    return mode === 'never' || !this.opts.apple() ? 'unavailable' : mode;
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.opts.file, 'utf8')) as { reminders?: Stored[] };
      this.items = (parsed.reminders ?? []).filter((r) => typeof r?.id === 'string' && typeof r.text === 'string' && (r.due === null || typeof r.due === 'number'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`  [reminders] can't read ${this.opts.file}: ${(e as Error).message}`);
      this.items = [];
    }
    // Due while Nova wasn't running: brought up now, unless it's long past. A repeat moves on to its next time.
    const now = this.now();
    for (const r of [...this.items]) {
      if (r.due === null || r.due > now) continue;
      const late = now - r.due;
      if (r.schedule) {
        if (late < 3_600_000) this.fire(r, true, now);
        else r.due = nextTime(r.schedule, new Date(now)).getTime();
      } else if (late < TOO_LATE_MS) this.fire(r, true, now);
      else this.items = this.items.filter((x) => x !== r);
    }
    this.save();
    this.arm();
    return this;
  }

  list(): Reminder[] {
    const now = this.now();
    const all = [...this.items, ...this.fromApple.filter((a) => !this.items.some((i) => i.appleId && i.appleId === a.appleId))];
    return all
      .filter((r) => r.due === null || r.due > now - 60_000)
      .sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity))
      .map(plain);
  }

  async add(reminder: Omit<Reminder, 'id'>): Promise<Reminder> {
    const item: Stored = { ...reminder, id: newId(), created: this.now() };
    const apple = this.opts.apple();
    if (reminder.apple && apple && this.opts.mode() !== 'never') {
      try {
        item.appleId = await apple.add({ title: reminder.text || 'Reminder', due: reminder.due, list: this.opts.list() });
      } catch (e) {
        if (reminder.due === null) throw e;
        item.apple = false; // it's still Nova's
        console.warn(`  [reminders] the Reminders app didn't take it: ${(e as Error).message}`);
      }
    } else item.apple = false;
    if (item.due === null) {
      if (!item.appleId) throw new Error("It has no time, and the Reminders app can't be reached.");
      this.fromApple.push({ ...item, appleOnly: true }); // it lives in the Reminders app
    } else this.items.push(item);
    this.save();
    this.arm();
    this.opts.changed?.();
    return plain(item);
  }

  async cancel(id: string) {
    const item = this.items.find((r) => r.id === id) ?? this.fromApple.find((r) => r.id === id);
    if (!item) return false;
    this.items = this.items.filter((r) => r !== item);
    this.fromApple = this.fromApple.filter((r) => r !== item);
    if (item.appleId) await this.opts.apple()?.remove(item.appleId).catch((e: Error) => console.warn(`  [reminders] ${e.message}`));
    this.save();
    this.arm();
    this.opts.changed?.();
    return true;
  }

  recent(): Reminder | null {
    const now = this.now();
    const last = this.fired.filter((f) => now - f.at < RECENT_MS).at(-1);
    return last ? plain(last.item) : null;
  }

  async snooze(id: string, ms: number) {
    const fired = this.fired.find((f) => f.item.id === id);
    if (!fired) return null;
    this.fired = this.fired.filter((f) => f !== fired);
    // Again in a while, once - a repeating reminder still comes round as usual.
    const again: Stored = { ...fired.item, id: newId(), due: this.now() + ms, schedule: undefined, countdown: true, apple: false, appleId: undefined, appleOnly: undefined, created: this.now() };
    this.items.push(again);
    this.save();
    this.arm();
    this.opts.changed?.();
    return plain(again);
  }

  async done(id: string) {
    const fired = this.fired.find((f) => f.item.id === id);
    if (!fired) return false;
    this.fired = this.fired.filter((f) => f !== fired);
    if (fired.item.appleId && !fired.item.schedule) await this.opts.apple()?.complete(fired.item.appleId).catch((e: Error) => console.warn(`  [reminders] ${e.message}`));
    return true;
  }

  /** What the Reminders app holds now (when Nova.app connects, and every few minutes). */
  async syncApple() {
    const apple = this.opts.mode() === 'never' ? null : this.opts.apple();
    if (!apple) {
      this.fromApple = [];
      return this.arm();
    }
    const listed = await apple.list();
    const ours = new Set(this.items.map((i) => i.appleId).filter(Boolean));
    this.fromApple = listed
      .filter((a) => !ours.has(a.id) && !this.firedApple.has(a.id))
      .map((a) => ({ id: `apple-${a.id}`, text: a.title, about: 'to' as const, due: a.due, apple: true, appleId: a.id, appleOnly: true, created: this.now() }));
    this.arm();
    this.opts.changed?.();
  }

  close() {
    clearTimeout(this.timer);
  }

  flushed() {
    return this.saving.then(() => undefined);
  }

  private arm() {
    clearTimeout(this.timer);
    const next = [...this.items, ...this.fromApple].filter((r) => r.due !== null).sort((a, b) => a.due! - b.due!)[0];
    if (!next) return;
    this.timer = setTimeout(() => this.tick(), Math.min(Math.max(0, next.due! - this.now()), MAX_WAIT_MS));
  }

  private tick() {
    const now = this.now();
    let any = false;
    for (const r of [...this.items, ...this.fromApple]) {
      if (r.due === null || r.due > now + 250) continue;
      this.fire(r, now - r.due > 60_000, now);
      any = true;
    }
    if (any) {
      this.save();
      this.opts.changed?.();
    }
    this.arm();
  }

  /** Bring one up: gone if it was once, moved on to its next time if it repeats. */
  private fire(r: Stored, late: boolean, now: number) {
    this.fired.push({ item: { ...r }, at: now });
    if (this.fired.length > 20) this.fired.shift();
    const due = plain({ ...r });
    if (r.appleOnly && r.appleId) this.firedApple.add(r.appleId);
    if (r.schedule) r.due = nextTime(r.schedule, new Date(Math.max(now, r.due ?? now))).getTime();
    else {
      this.items = this.items.filter((x) => x !== r);
      this.fromApple = this.fromApple.filter((x) => x !== r);
    }
    this.opts.due(due, late);
  }

  private save() {
    const data = `${JSON.stringify({ reminders: this.items }, null, 2)}\n`;
    const file = this.opts.file;
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, data, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
      })
      .catch((e) => console.warn(`  [reminders] can't save: ${(e as Error).message}`));
    return this.saving;
  }
}
