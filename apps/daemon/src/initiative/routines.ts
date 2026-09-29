import { nextTime, parseWhen, type Routine, type RoutineService } from '@nova/core';
import { atTime, type Waiting } from './clock.ts';

/** A run more than this late (the Mac was asleep, or Nova off) is skipped: it waits for its next time. */
export const LATE_RUN_MS = 3_600_000;

/**
 * The user's routines, from Settings (routines.<name>): run by their phrase (NovaBrain matches it)
 * or by their schedule, here - timed by the wall clock, so the Mac sleeping never moves them. A
 * scheduled one due while the user is away runs when they're back.
 */
export class Routines implements RoutineService {
  private readonly timers = new Map<string, Waiting>();
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

  /** Settings changed (or the clock did): time the scheduled ones afresh. */
  configure() {
    this.close();
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
    for (const t of this.timers.values()) t.cancel();
    this.timers.clear();
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private arm(routine: Routine, schedule: NonNullable<ReturnType<typeof parseWhen>>['schedule'] & object) {
    const due = nextTime(schedule, new Date(this.now())).getTime();
    this.timers.get(routine.name)?.cancel();
    this.timers.set(
      routine.name,
      atTime(
        due,
        (late) => {
          if (late > LATE_RUN_MS) console.log(`  [routines] "${routine.name}" was due ${Math.round(late / 60_000)} minutes ago - the Mac was asleep, or Nova off - so it waits for next time`);
          else if (this.opts.away()) this.waiting.add(routine.name);
          else this.opts.run(routine);
          this.arm(routine, schedule);
        },
        () => this.now(),
      ),
    );
  }
}
