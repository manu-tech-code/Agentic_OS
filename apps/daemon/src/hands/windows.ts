import { findNamed, type HandsService, type LayoutWindow, type WindowFrame, type WindowPosition } from '@nova/core';
import { EyesError, type EyesApp, type EyesScreen, type EyesWindow, type Rect } from '../screen/eyes.ts';
import type { HandsEyes } from './types.ts';

/**
 * Windows, placed where the user says: halves, quarters, thirds, two thirds, filling the screen,
 * centred - worked out here, in code, on the usable part of the window's own display. Layouts are
 * saved as each window's place on its display (fractions of it), so they fit any display again.
 */

const round = (n: number) => Math.round(n);

/** Where a window goes, in the usable area of its display. `current` is its frame now (to centre it at its size). */
export function frameFor(position: WindowPosition, visible: Rect, current?: Rect): Rect {
  const { x, y, w, h } = visible;
  const halfW = round(w / 2);
  const halfH = round(h / 2);
  const third = round(w / 3);
  switch (position) {
    case 'left':
      return { x, y, w: halfW, h };
    case 'right':
      return { x: x + w - halfW, y, w: halfW, h };
    case 'top':
      return { x, y, w, h: halfH };
    case 'bottom':
      return { x, y: y + h - halfH, w, h: halfH };
    case 'top-left':
      return { x, y, w: halfW, h: halfH };
    case 'top-right':
      return { x: x + w - halfW, y, w: halfW, h: halfH };
    case 'bottom-left':
      return { x, y: y + h - halfH, w: halfW, h: halfH };
    case 'bottom-right':
      return { x: x + w - halfW, y: y + h - halfH, w: halfW, h: halfH };
    case 'left-third':
      return { x, y, w: third, h };
    case 'center-third':
      return { x: x + third, y, w: w - 2 * third, h };
    case 'right-third':
      return { x: x + w - third, y, w: third, h };
    case 'left-two-thirds':
      return { x, y, w: w - third, h };
    case 'right-two-thirds':
      return { x: x + third, y, w: w - third, h };
    case 'maximize':
      return { x, y, w, h };
    case 'almost-maximize': {
      const ww = round(w * 0.9);
      const hh = round(h * 0.9);
      return { x: x + round((w - ww) / 2), y: y + round((h - hh) / 2), w: ww, h: hh };
    }
    case 'center': {
      // Its own size (no bigger than the display), in the middle.
      const ww = Math.min(current?.w ?? round(w * 0.6), w);
      const hh = Math.min(current?.h ?? round(h * 0.7), h);
      return { x: x + round((w - ww) / 2), y: y + round((h - hh) / 2), w: ww, h: hh };
    }
  }
}

const area = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** The display a window is on: the one holding its middle, else the one it overlaps most, else the main one. */
export function screenFor(frame: Rect, screens: EyesScreen[]): EyesScreen | undefined {
  const mx = frame.x + frame.w / 2;
  const my = frame.y + frame.h / 2;
  const holding = screens.find((s) => mx >= s.frame.x && mx < s.frame.x + s.frame.w && my >= s.frame.y && my < s.frame.y + s.frame.h);
  if (holding) return holding;
  const best = [...screens].sort((a, b) => area(frame, b.frame) - area(frame, a.frame))[0];
  return best && area(frame, best.frame) > 0 ? best : (screens.find((s) => s.main) ?? screens[0]);
}

/** A window's place on its display, as fractions of the usable area (for saving a layout). */
export function relative(frame: Rect, visible: Rect) {
  const clamp = (n: number) => Math.min(1, Math.max(0, Math.round(n * 10_000) / 10_000));
  const x = clamp((frame.x - visible.x) / visible.w);
  const y = clamp((frame.y - visible.y) / visible.h);
  return { x, y, w: Math.max(0.01, Math.min(1 - x, clamp(frame.w / visible.w))), h: Math.max(0.01, Math.min(1 - y, clamp(frame.h / visible.h))) };
}

/** A saved place back on a display. */
export function absolute(place: { x: number; y: number; w: number; h: number }, visible: Rect): Rect {
  return { x: round(visible.x + place.x * visible.w), y: round(visible.y + place.y * visible.h), w: round(place.w * visible.w), h: round(place.h * visible.h) };
}

/** The same place on another display: in proportion, and no bigger than it. */
export function onOtherScreen(frame: Rect, from: EyesScreen, to: EyesScreen): Rect {
  return absolute(relative(frame, from.visible), to.visible);
}

/** Layout names as settings keep them: letters, digits, spaces, - and _. */
export const layoutName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);

/** The window of an app that "this window" or "Safari" means: its focused (or main) one, not minimized. */
export function mainWindow(app: EyesApp): EyesWindow | undefined {
  const usable = app.windows.filter((w) => !w.minimized);
  return (
    usable.find((w) => w.standard && (w.focused || w.main)) ?? usable.find((w) => w.standard) ?? usable[0] ?? app.windows.find((w) => w.standard) ?? app.windows[0]
  );
}

const frameOf = (app: EyesApp, w: EyesWindow): WindowFrame => ({
  app: app.name,
  pid: app.pid,
  window: w.index,
  ...(w.id !== undefined ? { id: w.id } : {}),
  title: w.title,
  frame: w.frame,
  minimized: w.minimized,
  fullscreen: w.fullscreen,
});

export interface WindowsOptions {
  eyes: HandsEyes;
  layouts: () => Record<string, LayoutWindow[]>;
  /** Save a layout in the settings file (null deletes it). */
  saveLayout: (name: string, windows: LayoutWindow[] | null) => Promise<void>;
  dryRun?: boolean;
  log?: (line: string) => void;
  now?: () => number;
}

export function windowsHands(o: WindowsOptions): HandsService['windows'] {
  const log = o.log ?? ((line: string) => console.log(line));
  const now = o.now ?? Date.now;
  let cache: { at: number; names: string[] } | null = null;

  async function read(needAccess = true) {
    const all = await o.eyes.windows();
    if (needAccess && !all.accessibility) throw new EyesError('accessibility-permission');
    return all;
  }

  const byName = (apps: EyesApp[], name?: string) => (name ? (apps.find((a) => a.name === name) ?? apps.find((a) => a.name === findNamed(name, apps.map((x) => x.name)))) : apps.find((a) => a.front));

  /** The window meant: the named app's, or the one in front. */
  function target(apps: EyesApp[], name?: string) {
    const app = byName(apps, name);
    if (!app) throw new Error(name ? `${name} isn't open.` : 'There is no window in front.');
    const window = mainWindow(app);
    if (!window) throw new Error(`${app.name} has no window open.`);
    return { app, window };
  }

  async function move(app: EyesApp, window: EyesWindow, change: { frame?: Rect; minimized?: boolean; fullscreen?: boolean; raise?: boolean }) {
    if (o.dryRun) return log(`  [dry-run] ${app.name} "${window.title}": ${JSON.stringify(change)}`);
    await o.eyes.setWindow({ pid: app.pid, id: window.id, title: window.title, window: window.index, ...change });
  }

  return {
    async apps() {
      if (cache && now() - cache.at < 2000) return cache.names;
      const { apps } = await read(false).catch(() => ({ apps: [] as EyesApp[] }));
      cache = { at: now(), names: apps.map((a) => a.name) };
      return cache.names;
    },

    async list() {
      const { apps } = await read();
      return apps
        .filter((a) => a.windows.some((w) => w.standard))
        .map((a) => ({ app: a.name, windows: a.windows.filter((w) => w.standard).map((w) => `${w.title || 'untitled'}${w.minimized ? ' (minimized)' : ''}${w.fullscreen ? ' (full screen)' : ''}`) }));
    },

    async place(placements) {
      const { apps, screens } = await read();
      const moved: string[] = [];
      const before: WindowFrame[] = [];
      for (const p of placements) {
        const { app, window } = target(apps, p.app);
        if (before.some((b) => b.pid === app.pid && b.window === window.index)) continue;
        const screen = screenFor(window.frame, screens);
        if (!screen) throw new Error("I can't find a display.");
        before.push(frameOf(app, window));
        await move(app, window, { frame: frameFor(p.position, screen.visible, window.frame), raise: true });
        moved.push(app.name);
      }
      return { moved, before };
    },

    async act(action, name) {
      if (action === 'show-all') {
        if (o.dryRun) log('  [dry-run] show every app');
        else await o.eyes.app('unhideAll');
        return { app: 'every app', before: [] };
      }
      const { apps, screens } = await read(action !== 'hide');
      if (action === 'hide') {
        const app = byName(apps, name);
        if (!app) throw new Error(name ? `${name} isn't open.` : 'There is no app in front.');
        if (o.dryRun) log(`  [dry-run] hide ${app.name}`);
        else await o.eyes.app('hide', app.pid);
        return { app: app.name, before: app.windows.filter((w) => !w.minimized).map((w) => frameOf(app, w)) };
      }
      const { app, window } = target(apps, name);
      const before = [frameOf(app, window)];
      if (action === 'minimize') await move(app, window, { minimized: true });
      else if (action === 'fullscreen') await move(app, window, { fullscreen: true });
      else if (action === 'exit-fullscreen') await move(app, window, { fullscreen: false });
      else if (action === 'other-display') {
        if (screens.length < 2) throw new Error("There's only one display.");
        const from = screenFor(window.frame, screens)!;
        const to = screens[(screens.indexOf(from) + 1) % screens.length]!;
        await move(app, window, { frame: onOtherScreen(window.frame, from, to), raise: true });
      }
      return { app: app.name, before };
    },

    async saveLayout(name) {
      const { apps, screens } = await read();
      const windows: LayoutWindow[] = [];
      for (const app of apps) {
        if (app.hidden) continue;
        for (const w of app.windows) {
          if (!w.standard || w.minimized || w.fullscreen) continue;
          const screen = screenFor(w.frame, screens);
          if (!screen) continue;
          windows.push({ app: app.name, ...(w.title ? { title: w.title.slice(0, 300) } : {}), ...relative(w.frame, screen.visible), display: screen.index });
          if (windows.length >= 50) break;
        }
      }
      if (!windows.length) throw new Error('There are no windows to save.');
      const key = layoutName(name);
      if (!key) throw new Error('What should I call the layout?');
      await o.saveLayout(key, windows);
      return { windows: windows.length };
    },

    async layout(name) {
      const saved = o.layouts();
      const names = Object.keys(saved);
      const key = names.find((n) => n === layoutName(name)) ?? findNamed(name, names, 0.7);
      if (!key) return null;
      const { apps, screens } = await read();
      const missing: string[] = [];
      const before: WindowFrame[] = [];
      const used = new Set<string>();
      let windows = 0;
      for (const entry of saved[key]!) {
        const app = apps.find((a) => a.name === entry.app);
        if (!app) {
          if (!missing.includes(entry.app)) missing.push(entry.app);
          continue;
        }
        // The window with that title, else the next one of the app's not placed yet.
        const free = app.windows.filter((w) => w.standard && !used.has(`${app.pid}:${w.index}`));
        const window = free.find((w) => entry.title && w.title === entry.title) ?? free.find((w) => !w.minimized) ?? free[0];
        if (!window) continue;
        used.add(`${app.pid}:${window.index}`);
        const screen = screens[entry.display ?? 0] ?? screens.find((s) => s.main) ?? screens[0];
        if (!screen) continue;
        before.push(frameOf(app, window));
        if (app.hidden && !o.dryRun) await o.eyes.app('unhide', app.pid);
        await move(app, window, { frame: absolute(entry, screen.visible), ...(window.minimized ? { minimized: false } : {}), raise: true });
        windows++;
      }
      return { windows, missing, before };
    },

    layouts: () => Object.keys(o.layouts()),

    async restore(frames) {
      const { apps } = await read();
      let failed = 0;
      for (const f of frames) {
        const app = apps.find((a) => a.pid === f.pid) ?? apps.find((a) => a.name === f.app);
        if (!app) {
          failed++;
          continue;
        }
        if (app.hidden && !o.dryRun) await o.eyes.app('unhide', app.pid);
        const window = app.windows.find((w) => f.id !== undefined && w.id === f.id) ?? app.windows.find((w) => w.title === f.title) ?? app.windows.find((w) => w.index === f.window);
        if (!window) {
          failed++;
          continue;
        }
        // Where it was, then as it was: minimized or full screen again.
        await move(app, window, { frame: f.frame, ...(window.minimized && !f.minimized ? { minimized: false } : {}) });
        if (f.fullscreen) await move(app, window, { fullscreen: true });
        if (f.minimized) await move(app, window, { minimized: true });
      }
      if (failed && failed === frames.length) throw new Error("Those windows aren't open any more.");
    },
  };
}
