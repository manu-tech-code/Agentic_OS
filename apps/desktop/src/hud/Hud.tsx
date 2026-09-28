import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Orb } from '../components/Orb';
import { sizeRange, useResizable } from '../lib/resize';
import { appLevel, tellApp, useAppHover, useAppState } from '../lib/shell';
import { useNova, type SayEvent } from '../lib/useNova';
import './hud.css';

/** How long the orb alone stays up in a quiet listening window (conversation mode never ends one). */
const ORB_ALONE_MS = 30_000;
/** Just summoned or woken: say that Nova is listening, before any words arrive. */
const FRESH_MS = 4000;
/** The floating orb at 100%, in points; its setting's range. */
const ORB_PT = 48;
const FLOATING_RANGE = sizeRange('appearance.floatingOrbSize');
/** Which way the orb grows from each corner it can be pinned to: into the screen. */
const AWAY: Record<string, { x: number; y: number }> = {
  'bottom-right': { x: -1, y: -1 },
  'top-right': { x: -1, y: 1 },
  'bottom-left': { x: 1, y: -1 },
  'top-left': { x: 1, y: 1 },
};

/**
 * Nova's floating orb, shown by the Mac app over whatever the user is doing: the orb with what Nova
 * hears and says, then the orb alone while it keeps listening, then nothing. The app sizes its
 * panel to what this shows, so the rest of the screen stays clickable.
 */
export default function Hud() {
  const [reply, setReply] = useState<{ text: string; at: number } | null>(null);
  const onSay = useCallback((say: SayEvent) => setReply({ text: say.text, at: Date.now() }), []);
  const { state, send } = useNova(onSay);
  const app = useAppState();
  const hovered = useAppHover();
  const corner = app?.corner ?? 'bottom-right';
  // Resized by hand (pinch, ⌥-scroll, its handle) or in Settings → Appearance.
  const orbSize = useResizable({
    saved: state.ui.orb.floatingSize ?? 100,
    range: FLOATING_RANGE,
    grows: { from: 'corner', away: () => AWAY[corner] ?? AWAY['bottom-right']! },
    measure: () => (ORB_PT * orbSize.size) / 100,
    save: (size) => send({ type: 'settings-set', values: { 'appearance.floatingOrbSize': size } }),
  });
  const resizing = useRef(false);
  resizing.current = orbSize.resizing;
  const { ref: resizeRef } = orbSize;
  const [heard, setHeard] = useState<{ text: string; final: boolean; at: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** When Nova last finished thinking or speaking. */
  const [endedAt, setEndedAt] = useState(0);
  /** When this conversation started: Nova was summoned, or heard its name. */
  const [startedAt, setStartedAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  /** The box the app sizes its panel to is also where pinches and ⌥-scrolls resize the orb. */
  const setBox = useCallback(
    (el: HTMLDivElement | null) => {
      box.current = el;
      resizeRef.current = el;
    },
    [resizeRef],
  );

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 400);
    return () => clearInterval(t);
  }, []);

  // What Nova hears, as it hears it. An empty final turn (its own echo, a murmur) takes the words away.
  useEffect(() => {
    const t = state.transcript;
    if (!t) return;
    if (t.text) setHeard({ text: t.text, final: t.final, at: Date.now() });
    else if (t.final) setHeard((h) => (h && !h.final ? null : h));
  }, [state.transcript]);

  // A new conversation clears the last one; a finished answer starts the countdown to hiding.
  const previous = useRef(state.phase);
  useEffect(() => {
    const was = previous.current;
    previous.current = state.phase;
    if (was === 'idle' && state.phase !== 'idle') {
      setStartedAt(Date.now());
      setHeard(null);
      if (state.phase === 'listening') setReply(null);
    }
    if ((was === 'thinking' || was === 'acting' || was === 'speaking') && (state.phase === 'listening' || state.phase === 'idle')) setEndedAt(Date.now());
  }, [state.phase]);

  // Pressing the shortcut is a fresh start too, even mid-conversation.
  useEffect(() => {
    if (app?.talk) setStartedAt(Date.now());
  }, [app?.talk]);

  const busy = state.phase === 'thinking' || state.phase === 'acting' || state.phase === 'speaking';
  // A brain using the computer: said plainly, with how to stop it, for as long as it does.
  const computer = state.computer;
  const using = computer ? `${computer.paused ? 'Waiting while you use the Mac' : `${computer.caller ?? state.name} is using the computer${computer.app ? ` in ${computer.app}` : ''}`} · ⌃⌥⌘. stops` : null;
  const confirm = state.cards.find((c) => c.kind === 'confirm');
  const incoming = heard !== null && !heard.final;
  const lingering = endedAt > 0 && now - endedAt < (app?.orbSeconds ?? 6) * 1000;
  const fresh = now - startedAt < FRESH_MS;
  const holding = app?.talk === 'hold';
  const listening = state.phase === 'listening';
  const quietFor = now - Math.max(endedAt, startedAt, heard?.at ?? 0);

  // The reply: the one heard in this conversation - or, while Nova speaks, whatever it's saying.
  const shownReply = reply && (busy || lingering) && reply.at >= startedAt ? reply.text : state.phase === 'speaking' ? state.reply : null;
  const words = heard && heard.at >= startedAt ? heard : null;
  const status =
    state.phase === 'thinking'
      ? state.phaseLabel
        ? `Asking ${state.phaseLabel}…`
        : 'Thinking…'
      : state.phase === 'acting'
        ? 'On it…'
        : holding
          ? `Listening - let go of ${app?.shortcut ?? 'the shortcut'} when you're done`
          : listening && !words
            ? 'Listening…'
            : null;
  const somethingToSay = Boolean(words || status || shownReply || confirm || using);

  const card = state.connected && somethingToSay && (busy || incoming || holding || Boolean(confirm) || Boolean(using) || (lingering && reply !== null) || (listening && fresh));
  const mode: 'hidden' | 'orb' | 'card' = card ? 'card' : state.connected && (busy || (listening && quietFor < ORB_ALONE_MS)) ? 'orb' : 'hidden';

  // Tell the app what to show, and how big it is (it sizes its panel to this, from its corner).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      // While it's resized by hand, the app follows at once rather than animating each step.
      tellApp({ type: 'hud', state: mode, width: Math.ceil(r.width), height: Math.ceil(r.height), ...(resizing.current ? { live: true } : {}) });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [mode]);

  return (
    <div
      ref={setBox}
      className={`hud hud--${mode} hud--${corner} ${hovered ? 'is-hovered' : ''} ${orbSize.resizing ? 'is-resizing' : ''}`}
      style={{ ['--hud-orb' as string]: `${(ORB_PT * orbSize.size) / 100}px` }}
      onClick={() => orbSize.justResized() || tellApp({ type: 'expand' })}
      aria-live="polite"
    >
      <div className="hud__orb">
        <Orb name={state.name} phase={state.phase} levelRef={appLevel} prefs={state.ui.orb} />
        <span className="hud__handle" aria-hidden {...orbSize.handle} />
      </div>
      {mode === 'card' && (
        <div className="hud__body">
          {words && <p className={`hud__heard ${words.final ? '' : 'is-live'}`}>{words.final ? `“${words.text}”` : words.text}</p>}
          {using && <p className="hud__computer">{using}</p>}
          {status && !shownReply && !using && <p className="hud__status">{status}</p>}
          {shownReply && <p className="hud__reply">{shownReply}</p>}
          {confirm && (
            <p className="hud__ask">
              {confirm.title} <span>Say yes or no</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
