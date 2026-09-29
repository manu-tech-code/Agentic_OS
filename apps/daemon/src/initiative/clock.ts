/**
 * Waiting for a time on the wall clock. Node's timers count time the Mac is awake - they stop
 * while it sleeps - so one long wait comes due late by however long the Mac slept (an 8:30
 * briefing armed at 18:00 as one 6-hour wait runs mid-afternoon), and a change of the clock or
 * the time zone goes unnoticed. This waits at most a minute at a time, each step measured from
 * the clock afresh: never more than a minute late once the Mac is awake.
 */

/** The longest one step waits. */
export const STEP_MS = 60_000;

export interface Waiting {
  cancel(): void;
}

/** Call `fire` once `due` (ms since the epoch) has come, with how late it is by then. */
export function atTime(due: number, fire: (lateMs: number) => void, now: () => number = Date.now): Waiting {
  if (!Number.isFinite(due)) return { cancel() {} }; // a time that never comes (a schedule edited into nonsense)
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const step = () => {
    if (cancelled) return;
    const wait = due - now();
    if (wait <= 0) return fire(-wait);
    timer = setTimeout(step, Math.min(wait, STEP_MS));
  };
  timer = setTimeout(step, Math.max(0, Math.min(due - now(), STEP_MS)));
  return {
    cancel() {
      cancelled = true;
      clearTimeout(timer);
    },
  };
}
