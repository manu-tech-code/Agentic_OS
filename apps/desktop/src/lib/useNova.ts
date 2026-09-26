import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ActivityItem, Card, ClientEvent, DecisionTrace, Phase, ServerEvent } from '@nova/core/protocol';
import { demoScript } from './demo';

const URL = import.meta.env.VITE_NOVA_URL ?? 'ws://127.0.0.1:7878';

export interface NovaState {
  connected: boolean;
  engine: string | null;
  brain: string | null;
  apps: number;
  wakeWords: string[];
  phase: Phase;
  phaseLabel?: string;
  cards: Card[];
  activity: ActivityItem[];
  decision: DecisionTrace | null;
  reply: string | null;
  error: string | null;
}

const initial: NovaState = {
  connected: false,
  engine: null,
  brain: null,
  apps: 0,
  wakeWords: ['hey nova', 'nova'],
  phase: 'idle',
  cards: [],
  activity: [],
  decision: null,
  reply: null,
  error: null,
};

type Action = ServerEvent | { type: 'connected'; value: boolean };

function reducer(s: NovaState, a: Action): NovaState {
  switch (a.type) {
    case 'connected':
      return { ...s, connected: a.value, phase: a.value ? s.phase : 'idle' };
    case 'hello':
      return { ...s, engine: a.engine, brain: a.brain, apps: a.apps, wakeWords: a.wakeWords, error: null };
    case 'phase':
      return { ...s, phase: a.phase, phaseLabel: a.label };
    case 'say':
      return { ...s, reply: a.text };
    case 'card':
      return { ...s, cards: [a.card, ...s.cards.filter((c) => c.id !== a.card.id)].slice(0, 5) };
    case 'dismiss':
      return { ...s, cards: s.cards.filter((c) => c.id !== a.id) };
    case 'activity':
      return { ...s, activity: [a.item, ...s.activity].slice(0, 50) };
    case 'decision':
      return { ...s, decision: a.trace };
    case 'error':
      return { ...s, error: a.message };
  }
}

/** Connection to the Nova daemon with auto-reconnect. */
export function useNova(onSay: (text: string) => void) {
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
        dispatch(event);
        if (event.type === 'say') sayRef.current(event.text);
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

  const dismiss = useCallback((id: string) => dispatch({ type: 'dismiss', id }), []);

  return { state, send, dismiss };
}
