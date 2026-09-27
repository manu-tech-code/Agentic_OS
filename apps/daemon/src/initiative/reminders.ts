import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { nextTime, type Reminder, type ReminderService } from '@nova/core';
import { atTime, type Waiting } from './clock.ts';
import { setAside, writeDurably } from './durable.ts';

/**
 * Nova's reminders and timers, kept in ~/.nova/reminders.json so they outlast a restart, and
 * brought up on time: once, or again and again for a repeating one. The Reminders app is reached
 * through Nova.app: reminders the user wants there go there too (so they reach the iPhone), and
 * the app's own are spoken when due as well. Nothing is brought up while no one can hear it: what
 * came due while Nova was off waits for the first window, or Nova.app.
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

/** What reminders.json holds. */
interface Kept {
  reminders: Stored[];
  /** Reminders app items already brought up, by the app's id, with when they were due then (a new time brings one up again). */
  firedApple?: Record<string, number>;
  /** Nova's ids for the reminders without a time it put in the Reminders app, by the app's id: undoing one still works after a sync or a restart. */
  appleIds?: Record<string, string>;
}

/** One gone past by more than this is dropped rather than brought up late - the Reminders app's own too. */
const TOO_LATE_MS = 12 * 3_600_000;
/** A repeating one more than this late (Nova was off, the Mac asleep) waits for its next time. */
const REPEAT_LATE_MS = 3_600_000;
/** "Snooze" and "done" are about a reminder brought up this recently. */
const RECENT_MS = 15 * 60_000;

const newId = () => randomBytes(5).toString('hex');
const plain = ({ created: _c, appleId: _a, appleOnly: _o, ...r }: Stored): Reminder => r;
const valid = (r: Stored) => typeof r?.id === 'string' && typeof r.text === 'string' && (r.due === null || Number.isFinite(r.due));

export class ReminderStore implements ReminderService {
  private items: Stored[] = [];
  private fromApple: Stored[] = [];
  /** Reminders app items already brought up (by id, with when they were due), so a sync - or a restart - doesn't bring them up again. */
  private readonly firedApple = new Map<string, number>();
  /** Nova's ids for its reminders without a time in the Reminders app, by the app's id. */
  private readonly appleIds = new Map<string, string>();
  private fired: { item: Stored; at: number }[] = [];
  private waiting: Waiting | undefined;
  private saving: Promise<unknown> = Promise.resolve();
  /** Someone can hear Nova (a window or Nova.app is connected): until then, nothing comes up. */
  private live = false;
  /** The file couldn't be read, nor kept aside: nothing is saved over it. */
  private broken = false;
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
    const file = this.opts.file;
    let raw: string | null = null;
    try {
      raw = await readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.broken = true;
        console.warn(`  [reminders] can't read ${file} (${(e as Error).message}) - it's left as it is, and new reminders last only until Nova stops`);
      }
    }
    if (raw !== null) await this.read(raw);
    // Due while Nova wasn't running: long past ones go, a late repeat moves on; the rest wait for someone to hear them.
    this.expire(this.now());
    this.save();
    this.arm();
    return this;
  }

  /**
   * Someone can hear Nova now: a window or Nova.app connected. What came due while no one could
   * - while Nova was off - comes up now, marked late.
   */
  listening() {
    if (this.live) return;
    this.live = true;
    this.tick();
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
      this.appleIds.set(item.appleId, item.id); // under Nova's id still, whatever the app sends back
    } else this.items.push(item);
    this.save();
    this.arm();
    this.opts.changed?.();
    return plain(item);
  }

  async cancel(id: string) {
    const item = this.items.find((r) => r.id === id) ?? this.fromApple.find((r) => r.id === id);
    // One of Nova's in the Reminders app that isn't in view (no sync yet since Nova started): by its id there.
    const appleId = item?.appleId ?? [...this.appleIds].find(([, nova]) => nova === id)?.[0];
    const apple = this.opts.apple();
    if (!item && !(appleId && apple)) return false;
    this.items = this.items.filter((r) => r !== item);
    this.fromApple = this.fromApple.filter((r) => r !== item);
    if (appleId) {
      await apple?.remove(appleId).catch((e: Error) => console.warn(`  [reminders] ${e.message}`));
      this.appleIds.delete(appleId);
    }
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
    const now = this.now();
    const here = new Set(listed.map((a) => a.id));
    // What the app no longer has (done, deleted) needs no remembering.
    let forgot = false;
    for (const known of [this.firedApple, this.appleIds]) {
      for (const id of [...known.keys()]) if (!here.has(id)) forgot = known.delete(id) || forgot;
    }
    const ours = new Set(this.items.map((i) => i.appleId).filter(Boolean));
    this.fromApple = listed
      .filter((a) => !ours.has(a.id))
      // Brought up already at this time, or long overdue there (the app's business, not news): not again.
      .filter((a) => a.due === null || (this.firedApple.get(a.id) !== a.due && now - a.due <= TOO_LATE_MS))
      .map((a) => ({ id: this.appleIds.get(a.id) ?? `apple-${a.id}`, text: a.title, about: 'to' as const, due: a.due, apple: true, appleId: a.id, appleOnly: true, created: now }));
    if (forgot) this.save();
    this.arm();
    this.opts.changed?.();
  }

  close() {
    this.waiting?.cancel();
    this.waiting = undefined;
  }

  flushed() {
    return this.saving.then(() => undefined);
  }

  /** The time again, from the clock: after the Mac wakes, or its clock changes. */
  rearm() {
    this.arm();
  }

  /** reminders.json as it was left - kept beside first, when some or all of it can't be read. */
  private async read(raw: string) {
    const file = this.opts.file;
    let parsed: Partial<Kept> | null = null;
    try {
      parsed = JSON.parse(raw) as Partial<Kept>;
    } catch {
      // cut short, or edited into something else: below
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.reminders)) {
      const kept = await setAside(file);
      if (kept) console.warn(`  [reminders] ${file} couldn't be read, so it's kept as ${kept} and Nova starts with no reminders`);
      else {
        this.broken = true;
        console.warn(`  [reminders] ${file} couldn't be read - it's left as it is, and new reminders last only until Nova stops`);
      }
      return;
    }
    this.items = parsed.reminders.filter(valid);
    if (this.items.length < parsed.reminders.length) {
      const kept = await setAside(file, 'copy');
      if (!kept) this.broken = true;
      console.warn(`  [reminders] ${parsed.reminders.length - this.items.length} of the reminders in ${file} couldn't be read${kept ? ` - the file as it was is kept as ${kept}` : ", so it's left as it is"}`);
    }
    for (const [id, due] of Object.entries(parsed.firedApple ?? {})) if (typeof due === 'number') this.firedApple.set(id, due);
    for (const [appleId, id] of Object.entries(parsed.appleIds ?? {})) if (typeof id === 'string') this.appleIds.set(appleId, id);
  }

  private arm() {
    this.waiting?.cancel();
    this.waiting = undefined;
    if (!this.live) return; // no one to hear it yet
    const next = [...this.items, ...this.fromApple].filter((r) => r.due !== null && Number.isFinite(r.due)).sort((a, b) => a.due! - b.due!)[0];
    if (!next) return;
    this.waiting = atTime(next.due!, () => this.tick(), this.now);
  }

  private tick() {
    if (!this.live) return;
    const now = this.now();
    let any = this.expire(now);
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

  /**
   * Too late to bring up - Nova was off, or the Mac asleep, for hours: a one-off goes (the
   * Reminders app's own stay in the app), a repeat moves on to its next time. Whether any did.
   */
  private expire(now: number) {
    const before = this.items.length + this.fromApple.length;
    let moved = false;
    for (const r of this.items) {
      if (r.schedule && r.due !== null && now - r.due > REPEAT_LATE_MS) {
        r.due = nextTime(r.schedule, new Date(now)).getTime();
        moved = true;
      }
    }
    const gone = (r: Stored) => !r.schedule && r.due !== null && now - r.due > TOO_LATE_MS;
    this.items = this.items.filter((r) => !gone(r));
    this.fromApple = this.fromApple.filter((r) => !gone(r));
    return moved || this.items.length + this.fromApple.length !== before;
  }

  /** Bring one up: gone if it was once, moved on to its next time if it repeats. */
  private fire(r: Stored, late: boolean, now: number) {
    this.fired.push({ item: { ...r }, at: now });
    if (this.fired.length > 20) this.fired.shift();
    const due = plain({ ...r });
    if (r.appleOnly && r.appleId && r.due !== null) this.firedApple.set(r.appleId, r.due);
    if (r.schedule) r.due = nextTime(r.schedule, new Date(Math.max(now, r.due ?? now))).getTime();
    else {
      this.items = this.items.filter((x) => x !== r);
      this.fromApple = this.fromApple.filter((x) => x !== r);
    }
    this.opts.due(due, late);
  }

  private save() {
    if (this.broken) return this.saving;
    const kept: Kept = { reminders: this.items, firedApple: Object.fromEntries(this.firedApple), appleIds: Object.fromEntries(this.appleIds) };
    const data = `${JSON.stringify(kept, null, 2)}\n`;
    this.saving = this.saving.then(() => writeDurably(this.opts.file, data)).catch((e) => console.warn(`  [reminders] can't save: ${(e as Error).message}`));
    return this.saving;
  }
}
