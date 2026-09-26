import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Cards } from './components/Cards';
import { CommandBar } from './components/CommandBar';
import { Dock, type DockItem } from './components/Dock';
import { Inspector } from './components/Inspector';
import { LivePill } from './components/LivePill';
import { Orb } from './components/Orb';
import { Timeline } from './components/Timeline';
import { useNova } from './lib/useNova';
import { earcon, speak, startMicLevel, stopSpeaking, voiceSupported, WebSpeechListener } from './voice/voice';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return <span>{now.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>;
}

export default function App() {
  const levelRef = useRef(0);
  const listener = useRef<WebSpeechListener | null>(null);
  const [awake, setAwake] = useState(false);
  const [interim, setInterim] = useState('');
  const [heard, setHeard] = useState('');
  const [micError, setMicError] = useState<string | null>(null);
  const [showInspector, setShowInspector] = useState(true);
  const [showTimeline, setShowTimeline] = useState(false);
  const [showCommand, setShowCommand] = useState(false);

  const sendRef = useRef<(e: any) => void>(() => {});

  const onSay = useCallback((text: string) => {
    listener.current?.pause();
    speak(text, () => {
      listener.current?.resume();
      sendRef.current({ type: 'speech-finished' });
    });
  }, []);

  const { state, send, dismiss } = useNova(onSay);
  sendRef.current = send;

  // Earcons on phase changes
  const prevPhase = useRef(state.phase);
  useEffect(() => {
    if (awake && state.phase === 'listening' && prevPhase.current === 'idle') earcon('wake');
    prevPhase.current = state.phase;
  }, [state.phase, awake]);
  useEffect(() => {
    if (state.error && awake) earcon('error');
  }, [state.error, awake]);

  const wake = useCallback(async () => {
    setAwake(true);
    try {
      await startMicLevel((l) => (levelRef.current = l));
    } catch (e) {
      setMicError(`Microphone blocked: ${(e as Error).message}`);
    }
    listener.current = new WebSpeechListener({
      onInterim: setInterim,
      onFinal: (text) => {
        setInterim('');
        setHeard(text);
        send({ type: 'utterance', text, source: 'voice' });
      },
      onError: setMicError,
    });
    listener.current.start();
    earcon('wake');
  }, [send]);

  const typed = useCallback(
    (text: string) => {
      setHeard(text);
      send({ type: 'utterance', text, source: 'keyboard' });
    },
    [send],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') (e.preventDefault(), setShowCommand((v) => !v));
      if (mod && e.key.toLowerCase() === 'i') (e.preventDefault(), setShowInspector((v) => !v));
      if (mod && e.key.toLowerCase() === 'j') (e.preventDefault(), setShowTimeline((v) => !v));
      if (e.key === 'Escape') {
        stopSpeaking();
        send({ type: 'cancel' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [send]);

  const engineShort = state.engine?.split(' ')[0] ?? 'offline';
  const dock: DockItem[] = [
    { id: 'mic', label: awake ? 'Always listening' : 'Wake Nova', glyph: '●', active: awake, status: awake ? 'on' : 'off', onClick: () => !awake && wake() },
    { id: 'type', label: 'Type (⌘K)', glyph: '⌘', onClick: () => setShowCommand(true) },
    { id: '|', label: '', glyph: '', onClick: () => {} },
    { id: 's1', label: `System 1 · ${state.engine ?? 'offline'}`, glyph: '⚡︎', status: state.connected ? (engineShort === 'jev' ? 'on' : 'warn') : 'off', onClick: () => setShowInspector(true) },
    { id: 's2', label: `System 2 · ${state.brain ?? 'not connected'}`, glyph: '✦', status: state.brain ? 'on' : 'off', onClick: () => setShowCommand(true) },
    { id: '|', label: '', glyph: '', onClick: () => {} },
    { id: 'inspector', label: 'Decision Inspector (⌘I)', glyph: '◎', active: showInspector, onClick: () => setShowInspector((v) => !v) },
    { id: 'timeline', label: 'Activity (⌘J)', glyph: '☰', active: showTimeline, onClick: () => setShowTimeline((v) => !v) },
  ];

  return (
    <div className={`desktop ${isTauri ? 'is-tauri' : ''}`}>
      <div className="wallpaper" aria-hidden>
        <span className="blob blob--1" />
        <span className="blob blob--2" />
        <span className="blob blob--3" />
        <span className="grain" />
      </div>

      <header className="menubar" data-tauri-drag-region>
        <div className="menubar__left" data-tauri-drag-region>
          <img src="/nova.svg" alt="" className="menubar__logo" />
          <strong>Nova</strong>
          <span className="menubar__dim">System 1: {engineShort}</span>
          {state.brain && <span className="menubar__dim">System 2: {state.brain}</span>}
        </div>
        <div className="menubar__right" data-tauri-drag-region>
          <span className={`conn ${state.connected ? 'is-on' : ''}`}>{state.connected ? 'connected' : 'offline'}</span>
          <Clock />
        </div>
      </header>

      <div className="pill-wrap">
        <LivePill phase={state.phase} label={state.phaseLabel} connected={state.connected} />
      </div>

      <main className="stage">
        <Orb phase={state.phase} levelRef={levelRef} onClick={() => (awake ? setShowCommand(true) : wake())} />
        <div className="captions">
          <AnimatePresence mode="wait">
            {!awake ? (
              <motion.button key="wake" className="btn btn--glass wake-btn" onClick={wake} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                Tap to wake Nova
              </motion.button>
            ) : (
              <motion.div key="captions" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <div className="captions__heard">{interim ? <span className="is-interim">{interim}</span> : heard ? `“${heard}”` : `Say “${state.wakeWords[0] ?? 'hey nova'}”…`}</div>
                <AnimatePresence mode="wait">
                  {state.reply && (
                    <motion.div key={state.reply} className="captions__reply" initial={{ opacity: 0, y: 6, filter: 'blur(6px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0)' }} exit={{ opacity: 0 }}>
                      {state.reply}
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
          {(micError || (awake && !voiceSupported)) && (
            <div className="banner">{micError ?? 'Voice input isn’t available in this webview yet - open http://localhost:5173 in Chrome, or press ⌘K to type.'}</div>
          )}
          {state.error && <div className="banner banner--error">{state.error}</div>}
        </div>
      </main>

      <div className="side side--left">
        <AnimatePresence>{showTimeline && <Timeline items={state.activity} />}</AnimatePresence>
      </div>
      <div className="side side--right">
        <Cards cards={state.cards} onDismiss={dismiss} onAnswer={(t) => typed(t)} />
        <AnimatePresence>{showInspector && <Inspector trace={state.decision} engine={state.engine} />}</AnimatePresence>
      </div>

      <Dock items={dock} />

      <AnimatePresence>{showCommand && <CommandBar onSubmit={typed} onClose={() => setShowCommand(false)} />}</AnimatePresence>
    </div>
  );
}
