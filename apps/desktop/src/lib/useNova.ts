import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ActivityItem, Card, ClientEvent, DecisionTrace, Phase, ServerEvent, UiPrefs } from '@nova/core/protocol';
import type { TaskRecord } from '@nova/core';
import type { HearingStatus, SettingsSnapshot } from '@nova/core/settings';
import { pushAudio } from '../voice/voice';
import { demoScript } from './demo';
import { daemonUrl, setVoiceOwner } from './shell';

const URL = daemonUrl(import.meta.env.VITE_NOVA_URL ?? 'ws://127.0.0.1:7878');

export interface NovaState {
  /** The assistant's name from Settings. */
  name: string;
  connected: boolean;
  engine: string | null;
  brain: string | null;
  apps: number;
  wakeWords: string[];
  requireWakeWord: boolean;
  /** Paired agents (Claude Code, Codex, ...), default first. */
  agents: { name: string; label: string }[];
  projects: string[];
  /** The daemon has said hello, so `ui` holds real preferences. */
  hello: boolean;
  ui: UiPrefs;
  /** Whether the daemon hears on this Mac (the window streams its microphone) or the window's own recognition does. */
  hearing: HearingStatus;
  /** What the daemon is hearing: words so far, then the finished turn. */
  transcript: { text: string; final: boolean; at: number } | null;
  /** When the user last talked over Nova (the window stops speaking). */
  bargeIn: number;
  /** Nova's Mac app hears and speaks for Nova, so this window does neither. */
  appVoice: boolean;
  /** The task board: agents' tasks, newest first. */
  tasks: TaskRecord[];
  /** What Nova Eyes saw, when Settings asked. */
  screenPreview: { text: string; at: number } | null;
  settings: SettingsSnapshot | null;
  settingsResult: { ok: boolean; message: string; at: number } | null;
  /** The assistant asked the shell to turn its microphone on or off (e.g. "stop listening"). */
  listenRequest: { on: boolean; at: number } | null;
  /** The assistant asked the shell to open a panel (e.g. "open settings"). */
  showRequest: { panel: 'settings' | 'welcome'; at: number } | null;
  phase: Phase;
  phaseLabel?: string;
  cards: Card[];
  /** The record of what Nova did lately, newest first. */
  activity: ActivityItem[];
  /** What the last search of the whole record found. */
  found: { query: string; items: ActivityItem[]; at: number } | null;
  /** Nova's hands on the computer right now: who is using it, in which app, and whether it's waiting for the user. */
  computer: { caller?: string; app?: string; paused?: boolean; steps?: number; at: number } | null;
  decision: DecisionTrace | null;
  reply: string | null;
  error: string | null;
}

const initial: NovaState = {
  name: 'Nova',
  connected: false,
  engine: null,
  brain: null,
  apps: 0,
  wakeWords: ['hey nova', 'nova'],
  requireWakeWord: true,
  agents: [],
  projects: [],
  hello: false,
  ui: { autoListen: true, rate: 1.05, lang: 'en-US', orb: { style: 'particles', colors: 'nova', motion: 'lively', size: 100, floatingSize: 100 } },
  hearing: { engine: 'browser', state: 'ready' },
  transcript: null,
  bargeIn: 0,
  appVoice: false,
  tasks: [],
  screenPreview: null,
  settings: null,
  settingsResult: null,
  listenRequest: null,
  showRequest: null,
  phase: 'idle',
  cards: [],
  activity: [],
  found: null,
  computer: null,
  decision: null,
  reply: null,
  error: null,
};

type Action = ServerEvent | { type: 'connected'; value: boolean };

function reducer(s: NovaState, a: Action): NovaState {
  switch (a.type) {
    case 'connected':
      // appVoice is left as it was: a daemon blip doesn't mean Nova.app quit - it says voice-owner
      // again the moment it reconnects, and that's what corrects this if it actually changed.
      // The "using the computer" indicator goes with the connection; the daemon says again if it still is.
      return { ...s, connected: a.value, phase: a.value ? s.phase : 'idle', computer: a.value ? s.computer : null };
    case 'hello':
      return {
        ...s,
        name: a.name,
        engine: a.engine,
        brain: a.brain,
        apps: a.apps,
        wakeWords: a.wakeWords,
        requireWakeWord: a.requireWakeWord,
        agents: a.agents,
        projects: a.projects,
        hello: true,
        ui: a.ui,
        hearing: a.hearing,
        error: null,
      };
    case 'hearing':
      return { ...s, hearing: a.status };
    case 'transcript':
      return { ...s, transcript: { text: a.text, final: a.final, at: Date.now() } };
    case 'barge-in':
      return { ...s, bargeIn: Date.now() };
    case 'screen-preview':
      return { ...s, screenPreview: { text: a.text, at: Date.now() } };
    case 'voice-owner':
      return { ...s, appVoice: a.app };
    case 'tasks':
      return { ...s, tasks: a.tasks };
    case 'shell-config':
    case 'shell-action':
    case 'shell-request':
      return s; // for the Mac app itself
    case 'listen':
      return { ...s, listenRequest: { on: a.on, at: Date.now() } };
    case 'show':
      return { ...s, showRequest: { panel: a.panel, at: Date.now() } };
    case 'settings':
      return { ...s, settings: a.snapshot };
    case 'settings-result':
      return { ...s, settingsResult: { ok: a.ok, message: a.message, at: Date.now() } };
    case 'phase':
      return { ...s, phase: a.phase, phaseLabel: a.label };
    case 'say':
      return { ...s, reply: a.text };
    case 'audio':
      return s; // played directly, never stored
    case 'card':
      return { ...s, cards: [a.card, ...s.cards.filter((c) => c.id !== a.card.id)].slice(0, 5) };
    case 'dismiss':
      return { ...s, cards: s.cards.filter((c) => c.id !== a.id) };
    case 'activity':
      return { ...s, activity: [a.item, ...s.activity.filter((i) => i.id !== a.item.id)].slice(0, 300) };
    case 'activity-history': {
      // What happened while this window connected stays, the record's order after it.
      const known = new Set(a.items.map((i) => i.id));
      return { ...s, activity: [...s.activity.filter((i) => !known.has(i.id)), ...a.items].sort((x, y) => y.at - x.at).slice(0, 300) };
    }
    case 'activity-update': {
      const update = (list: ActivityItem[]) => list.map((i) => (i.id === a.item.id ? a.item : i));
      return { ...s, activity: update(s.activity), found: s.found && { ...s.found, items: update(s.found.items) } };
    }
    case 'activity-found':
      return { ...s, found: { query: a.query, items: a.items, at: Date.now() } };
    case 'computer':
      return { ...s, computer: a.active ? { caller: a.caller, app: a.app, paused: a.paused, steps: a.steps, at: Date.now() } : null };
    case 'decision':
      return { ...s, decision: a.trace };
    case 'error':
      return { ...s, error: a.message };
    default:
      // An event type this window doesn't know yet: ignored, not a blank window.
      return s;
  }
}

/** Connection to the Nova daemon with auto-reconnect. */
export type SayEvent = Extract<ServerEvent, { type: 'say' }>;

export function useNova(onSay: (say: SayEvent) => void) {
  const [state, dispatch] = useReducer(reducer, initial);
  const ws = useRef<WebSocket | null>(null);
  const sayRef = useRef(onSay);
  sayRef.current = onSay;

  useEffect(() => {
    if (location.hash === '#demo') {
      dispatch({ type: 'connected', value: true });
      const timers = demoScript.map(([ms, event]) => setTimeout(() => dispatch(event), ms));
      return () => timers.forEach(clearTimeout);
    }
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const socket = new WebSocket(URL);
      ws.current = socket;
      socket.onopen = () => dispatch({ type: 'connected', value: true });
      socket.onclose = () => {
        dispatch({ type: 'connected', value: false });
        if (!closed) retry = setTimeout(connect, 1500);
      };
      socket.onmessage = (m) => {
        const event = JSON.parse(m.data) as ServerEvent;
        // Audio goes straight to the speaker, not through React state.
        if (event.type === 'audio') return pushAudio(event);
        // Read outside any one window's state, so a Preview button knows without new props.
        if (event.type === 'voice-owner') setVoiceOwner(event.app);
        dispatch(event);
        if (event.type === 'say') sayRef.current(event);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws.current?.close();
    };
  }, []);

  const send = useCallback((event: ClientEvent) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(event));
  }, []);

  /** Microphone audio for the daemon's hearing: 16 kHz mono 16-bit PCM. */
  const sendAudio = useCallback((pcm: ArrayBuffer) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(pcm);
  }, []);

  const dismiss = useCallback((id: string) => dispatch({ type: 'dismiss', id }), []);

  return { state, send, sendAudio, dismiss };
}
