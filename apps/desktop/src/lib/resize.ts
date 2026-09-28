import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { FIELDS } from '@nova/core/settings';

/**
 * Resizing an orb by hand: a pinch, ⌥ and scroll, or dragging its handle. Sizes are percents of the orb's
 * usual size, as its setting saves them; the arithmetic is here, apart from the page, so it's tested.
 */

export interface SizeRange {
  min: number;
  max: number;
  step: number;
}

/** How far a size may go, and its steps: those of the setting it's saved as. */
export function sizeRange(key: string): SizeRange {
  const field = FIELDS.find((f) => f.key === key);
  return { min: field?.min ?? 50, max: field?.max ?? 200, step: field?.step ?? 5 };
}

export const clampSize = (size: number, range: SizeRange) => Math.min(range.max, Math.max(range.min, size));

/** What's saved: the size on the setting's steps, within its range. */
export const snapSize = (size: number, range: SizeRange) => clampSize(Math.round(size / range.step) * range.step, range);

/**
 * One wheel event over the orb: ⌥ and scroll, or a pinch (which Chrome and Firefox send as a wheel with ctrl).
 * Scrolling up or pinching out grows it. A pinch's events come thick and small, so each counts for more.
 */
export function wheelSize(size: number, e: { deltaY: number; deltaMode: number; ctrlKey: boolean }): number {
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY; // lines, pages → pixels
  return size * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002));
}

/** Dragging the handle of an orb that grows around its centre (the window's): its rim follows the pointer. */
export function dragFromCentre(start: number, pxPerPercent: number, startDistance: number, distance: number): number {
  return start + (2 * (distance - startDistance)) / pxPerPercent;
}

/**
 * Dragging the handle of an orb pinned to a corner of the screen (the floating one): the handle moves along the
 * diagonal away from that corner, a point each way for each point the orb grows. `away` is that direction:
 * { x: -1, y: -1 } for an orb in the bottom-right corner (left and up grow it).
 */
export function dragFromCorner(start: number, pxPerPercent: number, dx: number, dy: number, away: { x: number; y: number }): number {
  return start + (away.x * dx + away.y * dy) / 2 / pxPerPercent;
}

/** The arrow keys on the handle: a step bigger or smaller. */
export function keySize(size: number, key: string, range: SizeRange): number | null {
  if (key === 'ArrowUp' || key === 'ArrowRight') return snapSize(size + range.step, range);
  if (key === 'ArrowDown' || key === 'ArrowLeft') return snapSize(size - range.step, range);
  if (key === 'Home') return range.min;
  if (key === 'End') return range.max;
  return null;
}

export interface Resizable {
  /** The size to show now: the saved one, or the one it's being resized to. */
  size: number;
  /** Being resized right now. */
  resizing: boolean;
  /** Pinching or ⌥-scrolling over this element resizes the orb. */
  ref: RefObject<HTMLDivElement | null>;
  /** The drag handle's props (a slider, for keys and screen readers too). */
  handle: {
    onPointerDown(e: PointerEvent<HTMLElement>): void;
    onPointerMove(e: PointerEvent<HTMLElement>): void;
    onPointerUp(e: PointerEvent<HTMLElement>): void;
    onPointerCancel(e: PointerEvent<HTMLElement>): void;
    onKeyDown(e: KeyboardEvent<HTMLElement>): void;
    onClick(e: { stopPropagation(): void }): void;
  };
  /** The click that ends a pinch or drag isn't a click on the orb. */
  justResized(): boolean;
}

/** How long after the last wheel event a size is saved; a pinch or a drag is saved as it ends. */
const SAVE_AFTER_MS = 450;

/** How an orb grows: around its centre (in page coordinates), or away from the corner of the screen it's pinned to. */
export type Growth = { from: 'centre'; centre(): { x: number; y: number } } | { from: 'corner'; away(): { x: number; y: number } };

export function useResizable(opts: {
  /** The saved size (percent). */
  saved: number;
  range: SizeRange;
  grows: Growth;
  /** The orb's width in pixels now, to turn pointer movement into percent. */
  measure(): number;
  save(size: number): void;
}): Resizable {
  const ref = useRef<HTMLDivElement | null>(null);
  const [live, setLive] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const liveRef = useRef<number | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const resizedAt = useRef(0);
  const gesturing = useRef(false);
  /** A drag under way: where it started (screen coordinates), and the orb's centre on screen then. */
  const drag = useRef<{ start: number; pxPerPercent: number; x0: number; y0: number; cx: number; cy: number } | null>(null);

  const current = () => liveRef.current ?? optsRef.current.saved;
  const show = (size: number) => {
    const next = clampSize(size, optsRef.current.range);
    liveRef.current = next;
    setLive(next);
    setResizing(true);
    resizedAt.current = Date.now();
  };
  const saveIn = (ms: number) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      setResizing(false);
      const size = liveRef.current;
      if (size === null) return;
      const snapped = snapSize(size, optsRef.current.range);
      if (snapped === optsRef.current.saved) {
        liveRef.current = null;
        setLive(null);
        return;
      }
      liveRef.current = snapped;
      setLive(snapped);
      optsRef.current.save(snapped);
      // Shown until the saved size comes back; if it never does (the save failed), the saved one again.
      clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => {
        liveRef.current = null;
        setLive(null);
      }, 4000);
    }, ms);
  };

  // The saved size caught up with the one resized to: show the saved one again.
  useEffect(() => {
    if (liveRef.current !== null && !drag.current && !gesturing.current && liveRef.current === opts.saved) {
      clearTimeout(settleTimer.current);
      liveRef.current = null;
      setLive(null);
    }
  }, [opts.saved]);

  useEffect(() => () => (clearTimeout(saveTimer.current), clearTimeout(settleTimer.current)), []);

  // Pinches and ⌥-scrolls over the orb. Not passive: they'd zoom or scroll the page otherwise.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let base = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.altKey && !e.ctrlKey) return;
      e.preventDefault();
      if (gesturing.current) return; // Safari: its gesture events carry the pinch
      show(wheelSize(current(), e));
      saveIn(SAVE_AFTER_MS);
    };
    // Safari's own pinch events (Nova.app's pages are WebKit): `scale` is relative to where the pinch began.
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gesturing.current = true;
      base = current();
      clearTimeout(saveTimer.current);
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      show(base * ((e as Event & { scale?: number }).scale ?? 1));
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      gesturing.current = false;
      saveIn(0);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart);
    el.addEventListener('gesturechange', onGestureChange);
    el.addEventListener('gestureend', onGestureEnd);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
      el.removeEventListener('gestureend', onGestureEnd);
    };
  }, []);

  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    saveIn(0);
  };

  return {
    size: live ?? opts.saved,
    resizing,
    ref,
    handle: {
      onPointerDown(e) {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        // In screen coordinates: the floating orb's panel moves under the pointer as it grows; the screen doesn't.
        const grows = optsRef.current.grows;
        const centre = grows.from === 'centre' ? grows.centre() : { x: e.clientX, y: e.clientY };
        const start = current();
        drag.current = {
          start,
          pxPerPercent: Math.max(0.1, optsRef.current.measure() / start),
          x0: e.screenX,
          y0: e.screenY,
          cx: centre.x + (e.screenX - e.clientX),
          cy: centre.y + (e.screenY - e.clientY),
        };
        clearTimeout(saveTimer.current);
        setResizing(true);
      },
      onPointerMove(e) {
        const d = drag.current;
        if (!d) return;
        const grows = optsRef.current.grows;
        show(
          grows.from === 'centre'
            ? dragFromCentre(d.start, d.pxPerPercent, Math.hypot(d.x0 - d.cx, d.y0 - d.cy), Math.hypot(e.screenX - d.cx, e.screenY - d.cy))
            : dragFromCorner(d.start, d.pxPerPercent, e.screenX - d.x0, e.screenY - d.y0, grows.away()),
        );
      },
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onKeyDown(e) {
        const next = keySize(current(), e.key, optsRef.current.range);
        if (next === null) return;
        e.preventDefault();
        show(next);
        saveIn(SAVE_AFTER_MS);
      },
      onClick(e) {
        e.stopPropagation(); // the handle is never a click on the orb
      },
    },
    justResized: () => Date.now() - resizedAt.current < 350,
  };
}
