import { nextTime, parseWhen, type Routine, type RoutineService } from '@nova/core';

const MAX_WAIT_MS = 6 * 3_600_000;

/**
 * The user's routines, from Settings (routines.<name>): run by their phrase (NovaBrain matches it)
 * or by their schedule, here. A scheduled one due while the user is away runs when they're back.
 */
export class Routines implements RoutineService {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private waiting = new Set<string>();

  constructor(
    private readonly opts: {
      /** What Settings hold, by name. */
      routines: () => Record<string, { phrase?: string; schedule?: string; steps: string[]; enabled?: boolean }>;
      save: (routine: Routine) => Promise<void>;
      run: (routine: Routine) => void;
      away: () => boolean;
      now?: () => number;
    },
  ) {}

  list(): Routine[] {
    return Object.entries(this.opts.routines())
      .filter(([, r]) => r.enabled !== false)
      .map(([name, r]) => ({ name, phrase: r.phrase, schedule: r.schedule, steps: r.steps }));
  }

  save(routine: Routine) {
    return this.opts.save(routine);
  }

  /** Settings changed: time the scheduled ones afresh. */
  configure() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    for (const routine of this.list()) {
      if (!routine.schedule) continue;
      const schedule = parseWhen(routine.schedule, new Date(this.now()))?.schedule;
      if (schedule) this.arm(routine, schedule);
    }
  }

  /** The user is back: routines that came due while they were away run now. */
  back() {
    for (const name of [...this.waiting]) {
      this.waiting.delete(name);
      const routine = this.list().find((r) => r.name === name);
      if (routine) this.opts.run(routine);
    }
  }

  close() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private arm(routine: Routine, schedule: NonNullable<ReturnType<typeof parseWhen>>['schedule'] & object) {
    const due = nextTime(schedule, new Date(this.now())).getTime();
    const timer = setTimeout(() => {
      if (this.now() + 1000 < due) return this.arm(routine, schedule); // woke early (a long wait is split up)
      if (this.opts.away()) this.waiting.add(routine.name);
      else this.opts.run(routine);
      this.arm(routine, schedule);
    }, Math.min(Math.max(0, due - this.now()), MAX_WAIT_MS));
    this.timers.push(timer);
  }
}
