import { useEffect, useState } from 'react';

/**
 * Nova's Mac app shows this page in its window and its floating orb (?shell=mac). There the app
 * hears and speaks for Nova - its microphone and speaker share one echo canceller - so the page
 * never uses its own; it shows what's happening and tells the app what the user clicked. The app
 * talks back through `window.novaShell`.
 */

const params = new URLSearchParams(location.search);

/** Shown inside Nova's Mac app. */
export const inApp = params.get('shell') === 'mac';
/** Which view: the floating orb, or the full window. */
export const view: 'hud' | 'app' = params.get('view') === 'hud' ? 'hud' : 'app';
/** A panel to open once the page loads: Settings ("open settings" said while the window was closed), or the walkthrough. */
export const openOnLoad = params.get('panel') === 'settings' ? 'settings' : params.get('panel') === 'welcome' ? 'welcome' : null;

/** The daemon to talk to: the app says where (only ever this Mac), or the daemon served the page. */
export function daemonUrl(fallback: string) {
  const asked = params.get('daemon');
  if (asked && /^ws:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(asked)) return asked;
  if (document.querySelector('meta[name="nova-daemon"]')) return `ws://${location.host}`;
  return fallback;
}

/** What the page tells the app. */
export type ToApp =
  /** The orb's content: nothing (hide it), just the orb, or the orb with words; and how big it is. */
  | { type: 'hud'; state: 'hidden' | 'orb' | 'card'; width: number; height: number }
  /** Open the full window (the orb was clicked). */
  | { type: 'expand' }
  /** Listen now, as if the shortcut were tapped. */
  | { type: 'talk' }
  /** Turn the microphone off or back on. */
  | { type: 'mute'; on: boolean }
  /** Hear a Kokoro voice: asked for over the app's own connection, so it plays through its
   * echo-cancelled engine instead of this page's - which the microphone would just hear. */
  | { type: 'preview'; voice: string };

export function tellApp(message: ToApp) {
  (window as { webkit?: { messageHandlers?: { nova?: { postMessage(m: unknown): void } } } }).webkit?.messageHandlers?.nova?.postMessage(message);
}

/** What the app tells the page about itself. */
export interface AppState {
  /** The microphone is off (the user muted it, or said "stop listening"). */
  muted: boolean;
  /** What it's listening for: its name, or only the shortcut; paused while locked; no microphone. */
  listening: 'wake-word' | 'shortcut' | 'window' | 'muted' | 'locked' | 'no-mic' | 'starting';
  /** The shortcut, as shown ("⌥Space"). */
  shortcut: string;
  /** The shortcut is down (held) or was just tapped. */
  talk: 'hold' | 'tap' | null;
  /** How long a reply stays up after Nova finishes. */
  orbSeconds: number;
  /** The screen corner the orb sits in. */
  corner: 'bottom-right' | 'top-right' | 'bottom-left' | 'top-left';
}

type Listener = (state: AppState) => void;
const listeners = new Set<Listener>();
let current: AppState | null = null;
/** The microphone's level, 0-1, straight from the app (for the orb; no React re-renders). */
export const appLevel = { current: 0 };

/** A panel to open in the window - even one that already exists (the menu bar's "Settings…", or
 * "open settings" said while it was already open): windowPanel in the app's URL only takes on a
 * fresh page load, so an already-open window is told directly instead. */
type OpenPanel = 'settings' | 'welcome';
const openListeners = new Set<(panel: OpenPanel) => void>();

if (inApp) {
  (window as unknown as { novaShell: unknown }).novaShell = {
    state(next: AppState) {
      current = next;
      for (const l of listeners) l(next);
    },
    level(value: number) {
      appLevel.current = value;
    },
    open(panel: OpenPanel) {
      for (const l of openListeners) l(panel);
    },
  };
}

/** The app's state, once it has told the page (null elsewhere). */
export function useAppState(): AppState | null {
  const [state, setState] = useState(current);
  useEffect(() => {
    listeners.add(setState);
    return () => void listeners.delete(setState);
  }, []);
  return state;
}

/** The app asked this already-open window to show a panel. */
export function onShellOpen(handler: (panel: OpenPanel) => void) {
  openListeners.add(handler);
  return () => void openListeners.delete(handler);
}

/** Nova.app is connected (it hears and speaks for Nova), read reactively - so, for example, a voice
 * Preview button can tell whether playing here would go out loud where the app's microphone could
 * hear it, without threading appVoice through every settings panel as a prop. */
const voiceOwnerListeners = new Set<(app: boolean) => void>();
let voiceOwnerNow = false;

export function setVoiceOwner(app: boolean) {
  voiceOwnerNow = app;
  for (const l of voiceOwnerListeners) l(app);
}

export function useVoiceOwner(): boolean {
  const [value, setValue] = useState(voiceOwnerNow);
  useEffect(() => {
    voiceOwnerListeners.add(setValue);
    return () => void voiceOwnerListeners.delete(setValue);
  }, []);
  return value;
}
