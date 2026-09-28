import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Cards } from './components/Cards';
import { CommandBar } from './components/CommandBar';
import { Dock, type DockItem } from './components/Dock';
import { Inspector } from './components/Inspector';
import { LivePill } from './components/LivePill';
import { Onboarding } from './components/Onboarding';
import { Orb } from './components/Orb';
import { Settings } from './components/Settings';
import { Tasks } from './components/Tasks';
import { Timeline } from './components/Timeline';
import { formatShortcut } from '@nova/core/shortcut';
import type { SettingsSection } from '@nova/core/settings';
import { appLevel, inApp, onShellOpen, openOnLoad, tellApp, useAppState } from './lib/shell';
import { sizeRange, useResizable } from './lib/resize';
import { useNova, type SayEvent } from './lib/useNova';
import {
  earcon,
  MIC_HELP,
  micPermission,
  NO_SPEECH_TEXT,
  speakStream,
  startCapture,
  startMicLevel,
  stopSpeaking,
  unlockAudio,
  UtteranceAssembler,
  voiceSupported,
  WebSpeechListener,
} from './voice/voice';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
// Listening as soon as the page opens is a setting (Voice → Listen when Nova opens); #demo never listens.
const AUTO_LISTEN = location.hash !== '#demo';

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return <span>{now.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>;
}

/** How far the Orb in the window can be resized: its setting's range. */
const ORB_RANGE = sizeRange('appearance.orbSize');

export default function App() {
  const levelRef = useRef(0);
  const listener = useRef<WebSpeechListener | null>(null);
  const assembler = useRef<UtteranceAssembler | null>(null);
  const [awake, setAwake] = useState(false);
  const [interim, setInterim] = useState('');
  const [heard, setHeard] = useState('');
  const [micError, setMicError] = useState<string | null>(null);
  const [needsTap, setNeedsTap] = useState(false);
  const [showInspector, setShowInspector] = useState(true);
  const [showTimeline, setShowTimeline] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [showCommand, setShowCommand] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  /** The section Settings opens on (the walkthrough and the checklist send people to one). */
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>();
  const [showWelcome, setShowWelcome] = useState(false);
  /** The walkthrough was shown (or closed) in this window: it doesn't come back by itself. */
  const welcomed = useRef(false);

  const sendRef = useRef<(e: any) => void>(() => {});
  const sendAudioRef = useRef<(pcm: ArrayBuffer) => void>(() => {});
  /** Stops the microphone stream to the daemon, while the Mac hears for Nova. */
  const capture = useRef<(() => void) | null>(null);
  const uiRef = useRef({ rate: 1.05, lang: 'en-US' });

  /** Nova's Mac app hears and speaks for Nova (this page is inside it, or the app is running): no mic or voice here. */
  const handsOffRef = useRef(inApp);
  /** The audio stream of the reply being spoken, so more of the same reply doesn't restart it. */
  const speakingAudio = useRef<string | null>(null);
  const onSay = useCallback(({ audio, partial }: SayEvent) => {
    if (handsOffRef.current) return; // the app speaks
    if (audio && audio === speakingAudio.current) return; // more of the reply being spoken
    // Without Kokoro's audio (Nova.app brings it), the reply is shown, not spoken: done at once.
    if (!audio) return void (partial || sendRef.current({ type: 'speech-finished' }));
    listener.current?.pause();
    const finished = () => {
      if (speakingAudio.current === audio) speakingAudio.current = null;
      listener.current?.resume();
      sendRef.current({ type: 'speech-finished' });
    };
    // Kokoro's voice, streamed by the daemon sentence by sentence as the reply is written.
    speakingAudio.current = audio;
    speakStream(audio, finished, () => setNeedsTap(true));
  }, []);

  const { state, send, sendAudio, dismiss } = useNova(onSay);
  // The Orb, resized by hand (pinch, ⌥-scroll, its handle) or in Settings → Appearance.
  const orbSize = useResizable({
    saved: state.ui.orb.size ?? 100,
    range: ORB_RANGE,
    grows: {
      from: 'centre',
      centre: () => {
        const r = orbSize.ref.current?.getBoundingClientRect();
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 };
      },
    },
    measure: () => orbSize.ref.current?.querySelector('.orb')?.getBoundingClientRect().width ?? 220,
    save: (size) => send({ type: 'settings-set', values: { 'appearance.orbSize': size } }),
  });
  const app = useAppState();
  const handsOff = inApp || state.appVoice;
  handsOffRef.current = handsOff;
  sendRef.current = send;
  sendAudioRef.current = sendAudio;
  // The Mac hears (Apple's recognizer or Parakeet, in the daemon): this window only streams its microphone.
  const local = AUTO_LISTEN && state.hearing.engine !== 'browser' && state.hearing.state === 'ready';
  const localRef = useRef(local);
  localRef.current = local;
  uiRef.current = state.ui;
  // Settings → Voice decides whether Nova listens on its own; until the daemon says hello, a click still wakes it.
  const autoListen = AUTO_LISTEN && (!state.hello || state.ui.autoListen);
  const autoListenRef = useRef(autoListen);
  autoListenRef.current = autoListen;

  // Earcons on phase changes
  const prevPhase = useRef(state.phase);
  useEffect(() => {
    if (awake && state.phase === 'listening' && prevPhase.current === 'idle') earcon('wake');
    prevPhase.current = state.phase;
  }, [state.phase, awake]);
  useEffect(() => {
    if (state.error && awake) earcon('error');
  }, [state.error, awake]);

  const waking = useRef(false);
  /** Stops the microphone stream behind the Orb's level meter; null while the mic is off. */
  const micStop = useRef<(() => void) | null>(null);
  /** The user turned listening off; only they turn it back on (a stray click doesn't). */
  const stoppedByUser = useRef(false);
  /** Bumped whenever wake() should stop where it is: sleep() can't cancel an await already in
   * flight (startCapture/startMicLevel), so it's checked again once each one resolves. */
  const wakeGen = useRef(0);
  const wake = useCallback(async () => {
    if (handsOffRef.current || waking.current || capture.current || listener.current?.active) return;
    const gen = ++wakeGen.current;
    waking.current = true;
    setAwake(true);
    setMicError(null);
    if (localRef.current) {
      // Stream the microphone to the daemon; its meter drives the Orb, so the separate one goes.
      micStop.current?.();
      micStop.current = null;
      try {
        const stop = await startCapture(
          (pcm) => sendAudioRef.current(pcm),
          (l) => (levelRef.current = l),
          () => setNeedsTap(true),
        );
        // Nova's Mac app took over, or the user stopped it, while the microphone was starting.
        if (gen !== wakeGen.current || handsOffRef.current) {
          stop();
          waking.current = false;
          return setAwake(false);
        }
        capture.current = stop;
        sendRef.current({ type: 'audio-start', sampleRate: 16_000 });
      } catch {
        waking.current = false; // the next click retries
        return setMicError(MIC_HELP);
      }
      waking.current = false;
      earcon('wake');
      return;
    }
    if (!micStop.current) {
      try {
        const stop = await startMicLevel((l) => (levelRef.current = l));
        if (gen !== wakeGen.current) {
          stop();
          waking.current = false;
          return setAwake(false);
        }
        micStop.current = stop;
      } catch {
        waking.current = false; // the next click retries
        return setMicError(MIC_HELP);
      }
    }
    // Pieces of one sentence (browsers finalize at every pause) are joined before Nova acts on them.
    assembler.current ??= new UtteranceAssembler((text) => send({ type: 'utterance', text, source: 'voice' }));
    const joiner = assembler.current;
    listener.current ??= new WebSpeechListener(
      {
        onInterim: (text) => {
          setInterim(text);
          joiner.interim();
        },
        onFinal: (text) => {
          setInterim('');
          joiner.final(text);
          setHeard(joiner.text);
        },
        onError: setMicError,
      },
      uiRef.current.lang,
    );
    listener.current.start();
    waking.current = false;
    earcon('wake');
  }, [send]);

  /** Stop listening: recognition ends and the microphone is released, not just muted. */
  const sleep = useCallback(() => {
    wakeGen.current++; // a wake() still awaiting the microphone stops where it is once it resumes
    stoppedByUser.current = true;
    if (capture.current) {
      capture.current();
      capture.current = null;
      sendRef.current({ type: 'audio-stop' });
    }
    listener.current?.stop();
    micStop.current?.();
    micStop.current = null;
    levelRef.current = 0;
    setInterim('');
    setAwake(false);
    earcon('done');
  }, []);

  /** Listen again after the user stopped it. */
  const listen = useCallback(() => {
    stoppedByUser.current = false;
    void wake();
  }, [wake]);

  // Nova's Mac app hears and speaks for Nova now: this window lets go of its microphone and voice -
  // and takes them back if the app goes away.
  const wasHandsOff = useRef(handsOff);
  useEffect(() => {
    const was = wasHandsOff.current;
    wasHandsOff.current = handsOff;
    if (handsOff) {
      wakeGen.current++; // a wake() still awaiting the microphone stops where it is once it resumes
      if (capture.current) {
        capture.current();
        capture.current = null;
        sendRef.current({ type: 'audio-stop' });
      }
      listener.current?.stop();
      micStop.current?.();
      micStop.current = null;
      levelRef.current = 0;
      stopSpeaking();
      speakingAudio.current = null;
      setInterim('');
      setAwake(false);
    } else if (was && autoListenRef.current && !stoppedByUser.current) void wake();
  }, [handsOff, wake]);

  // "Stop listening" said out loud comes back from the assistant as a request to turn the mic off.
  useEffect(() => {
    if (state.listenRequest && !state.listenRequest.on) sleep();
  }, [state.listenRequest, sleep]);

  // The browser asks for the microphone once; once it's allowed for every visit, Nova starts listening by itself.
  const listenOnOpen = AUTO_LISTEN && state.hello && state.ui.autoListen;
  useEffect(() => {
    if (!listenOnOpen) return;
    void micPermission().then((p) => (p === 'denied' ? setMicError(MIC_HELP) : wake()));
  }, [listenOnOpen, wake]);

  useEffect(() => listener.current?.setLang(state.ui.lang), [state.ui.lang]);

  // Hearing moved between the Mac and the browser (it became ready, or Settings changed): switch while listening.
  useEffect(() => {
    if (!awake || waking.current) return;
    if (local && !capture.current) {
      listener.current?.stop();
      assembler.current?.cancel();
      micStop.current?.();
      micStop.current = null;
      void wake();
    } else if (!local && capture.current) {
      capture.current();
      capture.current = null;
      sendRef.current({ type: 'audio-stop' });
      void wake();
    }
  }, [local, awake, wake]);

  // A new connection to the daemon: tell it again that this window hears for Nova.
  useEffect(() => {
    if (state.connected && capture.current) send({ type: 'audio-start', sampleRate: 16_000 });
  }, [state.connected, send]);

  // What the Mac hears, as captions: words while you speak, then the turn Nova acts on.
  useEffect(() => {
    const t = state.transcript;
    if (!t || !(localRef.current || handsOffRef.current)) return;
    if (!t.final) return setInterim(t.text);
    setInterim('');
    if (t.text) setHeard(t.text);
  }, [state.transcript]);

  // The user talked over Nova: stop speaking at once.
  useEffect(() => {
    if (!state.bargeIn) return;
    stopSpeaking();
    speakingAudio.current = null;
  }, [state.bargeIn]);
  useEffect(() => void (document.title = state.name), [state.name]);

  const openSettings = useCallback(
    (section?: SettingsSection) => {
      setSettingsSection(section);
      setShowSettings(true);
      send({ type: 'settings-get' });
    },
    [send],
  );

  // What's set up (and whether the walkthrough was done) comes with the settings: asked for on connecting.
  useEffect(() => {
    if (state.connected && state.hello) send({ type: 'settings-get' });
  }, [state.connected, state.hello, send]);

  // The first run: the walkthrough, once. The Mac app may also open the window on it.
  useEffect(() => {
    if (welcomed.current || !state.settings) return;
    if (state.settings.setup.onboarded === false || openOnLoad === 'welcome') {
      welcomed.current = true;
      setShowWelcome(true);
    }
  }, [state.settings]);
  useEffect(() => {
    if (state.showRequest?.panel === 'welcome') setShowWelcome(true);
  }, [state.showRequest]);

  // The app asked this already-open window to show a panel (the menu bar's "Settings…", or "open
  // settings" said while the window was already up - windowPanel in its URL only takes on a fresh load).
  useEffect(() => onShellOpen((panel) => (panel === 'welcome' ? setShowWelcome(true) : openSettings())), [openSettings]);

  // A result from outside Settings (an undo from the timeline), shown for a moment. Settings shows its own.
  const [toast, setToast] = useState<{ ok: boolean; message: string; at: number } | null>(null);
  const settingsOpen = useRef(showSettings);
  settingsOpen.current = showSettings;
  useEffect(() => {
    if (!state.settingsResult || settingsOpen.current) return;
    setToast(state.settingsResult);
    const t = setTimeout(() => setToast(null), state.settingsResult.ok ? 3500 : 7000);
    return () => clearTimeout(t);
  }, [state.settingsResult]);

  const stopEverything = useCallback(() => {
    stopSpeaking();
    speakingAudio.current = null;
    send({ type: 'stop-all' });
  }, [send]);

  // The Mac app opened this window to show Settings ("open settings" said while it was closed).
  const openedOnLoad = useRef(false);
  useEffect(() => {
    if (openOnLoad !== 'settings' || openedOnLoad.current || !state.hello) return;
    openedOnLoad.current = true;
    openSettings();
  }, [state.hello, openSettings]);

  // "Open settings" said out loud (browsers keep ⌘, for their own settings).
  useEffect(() => {
    if (state.showRequest?.panel === 'settings') openSettings();
  }, [state.showRequest, openSettings]);

  // Browsers allow sound, and some allow listening, only after one click or key press per page load.
  // Use every interaction to unlock audio and restart listening if it was blocked.
  useEffect(() => {
    const onInteract = () => {
      if (handsOffRef.current) return;
      unlockAudio();
      setNeedsTap(false);
      if (autoListenRef.current && !stoppedByUser.current && !listener.current?.active && !capture.current) void wake();
    };
    window.addEventListener('pointerdown', onInteract, true);
    window.addEventListener('keydown', onInteract, true);
    return () => {
      window.removeEventListener('pointerdown', onInteract, true);
      window.removeEventListener('keydown', onInteract, true);
    };
  }, [wake]);

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
      if (mod && e.key.toLowerCase() === 'u') (e.preventDefault(), setShowTasks((v) => !v));
      if (mod && e.key === ',') (e.preventDefault(), openSettings());
      // ⌃⌥⌘. stops everything (Nova.app has it everywhere; this is the window's own).
      if (e.ctrlKey && e.altKey && e.metaKey && (e.key === '.' || e.code === 'Period')) (e.preventDefault(), stopEverything());
      // An overlay's own Escape (the ⌘K bar, Settings, the walkthrough) closes itself - it shouldn't
      // also abort the answer or refuse a pending agent approval underneath it.
      if (e.key === 'Escape' && !showCommand && !showSettings && !showWelcome && !e.defaultPrevented) {
        stopSpeaking();
        send({ type: 'cancel' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [send, openSettings, stopEverything, showCommand, showSettings, showWelcome]);

  const engineShort = state.engine?.split(' ')[0] ?? 'offline';
  // Reflex or Jev deciding as chosen; amber for the keyword matcher, or anything standing in ("no Jev key").
  const engineOk = /^(?:reflex|jev)$/.test(engineShort) && !/\((?:no |not installed|[^)]* isn't )[^)]*\)$/.test(state.engine?.split(' → ')[0] ?? '');
  // While the Mac app hears for Nova, "listening" is whatever it says (muted, locked, ...).
  const appListening = inApp ? app?.listening : state.settings?.presence.app?.listening;
  const heardByApp = !['muted', 'no-mic', 'locked'].includes(appListening ?? 'wake-word');
  const listening = handsOff ? heardByApp : awake;
  // The shortcut, from the app itself - or, in a browser, from what the app told Settings.
  const reported = state.settings?.presence.app?.shortcut;
  const shortcut = app?.shortcut ?? (reported?.ok ? formatShortcut(reported.keys) : undefined);
  // In the app, its microphone switch; in a window, this window's.
  const micOn = () => (inApp ? tellApp(app?.muted ? { type: 'mute', on: false } : { type: 'talk' }) : listen());
  const micOff = () => (inApp ? tellApp({ type: 'mute', on: true }) : sleep());
  // With the microphone off, the Orb and pill don't claim to be listening.
  const shownPhase = !listening && state.phase === 'listening' ? 'idle' : state.phase;
  // Agent tasks show as live cards; their agents pulse in the dock while they work.
  const working = state.cards.filter((c) => c.kind === 'task');
  const agentItems: DockItem[] = state.agents.map((a) => {
    const busy = working.some((c) => c.agent === a.name);
    return { id: `agent-${a.name}`, label: `${a.label} · ${busy ? 'working' : 'paired'}`, glyph: a.label[0] ?? '•', status: busy ? 'busy' : 'on', onClick: () => setShowTasks(true) };
  });
  const dock: DockItem[] = [
    {
      id: 'mic',
      label:
        handsOff && !inApp
          ? listening
            ? 'Nova.app is listening'
            : 'Nova.app has the microphone off'
          : listening
            ? inApp
              ? 'Listening - click to mute'
              : 'Listening - click to stop'
            : 'Microphone off - click to listen',
      glyph: listening ? '●' : '○',
      active: listening,
      status: listening ? 'on' : 'off',
      onClick: () => (handsOff && !inApp ? undefined : listening ? micOff() : micOn()),
    },
    { id: 'type', label: 'Type (⌘K)', glyph: '⌘', onClick: () => setShowCommand(true) },
    { id: '|', label: '', glyph: '', onClick: () => {} },
    { id: 's1', label: `System 1 · ${state.engine ?? 'offline'}`, glyph: '⚡︎', status: state.connected ? (engineOk ? 'on' : 'warn') : 'off', onClick: () => setShowInspector(true) },
    { id: 's2', label: `System 2 · ${state.brain ?? 'not connected'}`, glyph: '✦', status: state.brain ? 'on' : 'off', onClick: () => setShowCommand(true) },
    ...(agentItems.length ? [{ id: '|', label: '', glyph: '', onClick: () => {} }, ...agentItems] : []),
    { id: '|', label: '', glyph: '', onClick: () => {} },
    { id: 'inspector', label: 'Decision Inspector (⌘I)', glyph: '◎', active: showInspector, onClick: () => setShowInspector((v) => !v) },
    { id: 'timeline', label: 'Activity (⌘J)', glyph: '☰', active: showTimeline, onClick: () => setShowTimeline((v) => !v) },
    { id: 'tasks', label: 'Agent tasks (⌘U)', glyph: '✳︎', active: showTasks, status: state.tasks.some((t) => t.status === 'running') ? 'busy' : undefined, onClick: () => setShowTasks((v) => !v) },
    { id: 'settings', label: isTauri ? 'Settings (⌘,)' : 'Settings - or say "open settings"', glyph: '⚙︎', active: showSettings, onClick: () => openSettings() },
    { id: 'stop', label: 'Stop everything (⌃⌥⌘.)', glyph: '■', status: state.tasks.some((t) => t.status === 'running') || state.phase === 'thinking' || state.phase === 'speaking' ? 'busy' : undefined, onClick: stopEverything },
  ];

  return (
    <div className={`desktop ${isTauri ? 'is-tauri' : ''} ${inApp ? 'is-app' : ''}`}>
      <div className="wallpaper" aria-hidden>
        <span className="blob blob--1" />
        <span className="blob blob--2" />
        <span className="blob blob--3" />
        <span className="grain" />
      </div>

      <header className="menubar" data-tauri-drag-region>
        <div className="menubar__left" data-tauri-drag-region>
          <img src="/nova.svg" alt="" className="menubar__logo" />
          <strong>{state.name}</strong>
          <span className="menubar__dim">System 1: {engineShort}</span>
          {state.brain && <span className="menubar__dim">System 2: {state.brain}</span>}
        </div>
        <div className="menubar__right" data-tauri-drag-region>
          <span className={`conn ${state.connected ? 'is-on' : ''}`}>{state.connected ? 'connected' : 'offline'}</span>
          <Clock />
        </div>
      </header>

      {/* Nova's hands on the computer: who, where, and how to stop them. */}
      <AnimatePresence>
        {state.computer && (
          <motion.div key="computer" className={`computer-bar ${state.computer.paused ? 'is-paused' : ''}`} role="status" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
            <span className="computer-bar__dot" aria-hidden />
            <span className="computer-bar__text">
              {state.computer.paused ? 'Waiting while you use the Mac' : `${state.computer.caller ?? state.name} is using the computer`}
              {state.computer.app ? ` · ${state.computer.app}` : ''}
            </span>
            <button type="button" className="computer-bar__stop" onClick={stopEverything}>
              Stop · ⌃⌥⌘.
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="pill-wrap">
        <LivePill
          phase={shownPhase}
          label={state.phaseLabel}
          connected={state.connected}
          idleText={
            working[0]
              ? `${working[0].title.split(' · ')[0]} is working`
              : !listening
                ? 'Microphone off'
                : state.requireWakeWord
                  ? `Say "${titleCase(state.wakeWords[0] ?? state.name)}"${shortcut ? ` or press ${shortcut}` : ''}`
                  : 'Listening'
          }
        />
      </div>

      <main className="stage">
        <div ref={orbSize.ref} className={`orb-frame ${orbSize.resizing ? 'is-resizing' : ''}`} style={{ ['--orb-scale' as string]: orbSize.size / 100 }}>
          <Orb name={state.name} phase={shownPhase} levelRef={inApp ? appLevel : levelRef} prefs={state.ui.orb} onClick={() => orbSize.justResized() || (listening ? setShowCommand(true) : micOn())} />
          <span
            className="orb-handle"
            role="slider"
            tabIndex={0}
            title="Drag to resize - or pinch, or hold ⌥ and scroll"
            aria-label={`${state.name}'s size`}
            aria-valuemin={ORB_RANGE.min}
            aria-valuemax={ORB_RANGE.max}
            aria-valuenow={Math.round(orbSize.size)}
            aria-valuetext={`${Math.round(orbSize.size)}%`}
            {...orbSize.handle}
          />
          <span className="orb-frame__size" aria-hidden>
            {Math.round(orbSize.size)}%
          </span>
        </div>
        <div className="captions">
          <AnimatePresence mode="wait">
            {!listening ? (
              <motion.button key="wake" className="btn btn--glass wake-btn" onClick={micOn} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                {inApp && app?.listening === 'no-mic' ? `${state.name} can't use the microphone - see Settings → Menu bar` : `Tap to wake ${state.name}`}
              </motion.button>
            ) : (
              <motion.div key="captions" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <div className="captions__heard">
                  {interim ? (
                    <span className="is-interim">{interim}</span>
                  ) : heard ? (
                    `“${heard}”`
                  ) : state.requireWakeWord ? (
                    `Say “${state.wakeWords[0] ?? 'hey nova'}”${shortcut ? ` or press ${shortcut}` : ''}…`
                  ) : (
                    'Listening - just talk…'
                  )}
                </div>
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
          {!handsOff && (micError || (awake && !voiceSupported)) && <div className="banner">{micError ?? NO_SPEECH_TEXT}</div>}
          {state.appVoice && !inApp && <div className="banner banner--quiet">Nova.app hears and speaks for {state.name} - this window shows what happens.</div>}
          {!handsOff && needsTap && (
            <div className="banner">
              Click anywhere or press a key once so {state.name} can {local ? 'hear you and talk' : 'talk'}. Browsers need one interaction per visit before a page can use sound.
            </div>
          )}
          {!handsOff && awake && state.hearing.state === 'starting' && <div className="banner banner--quiet">{state.hearing.message ?? 'Getting on-device hearing ready'} - the browser listens until then.</div>}
          {state.settings && !state.settings.voice.installed && (
            <div className="banner banner--quiet">{state.name}'s voice, Kokoro, comes with Nova.app - install it (npm run app) and {state.name} speaks. Until then replies are shown here.</div>
          )}
          {state.error && <div className="banner banner--error">{state.error}</div>}
        </div>
      </main>

      <div className="side side--left">
        <AnimatePresence>
          {showTasks && <Tasks tasks={state.tasks} onCancel={(id) => send({ type: 'task-cancel', id })} onRetry={(id) => send({ type: 'task-retry', id })} />}
        </AnimatePresence>
        <AnimatePresence>
          {showTimeline && (
            <Timeline
              items={state.activity}
              found={state.found}
              keepDays={state.settings?.trust.activity.days}
              onUndo={(id) => send({ type: 'activity-undo', id })}
              onSearch={(query) => send({ type: 'activity-search', query })}
            />
          )}
        </AnimatePresence>
      </div>
      <div className="side side--right">
        <Cards cards={state.cards} onDismiss={dismiss} onAnswer={(t) => typed(t)} />
        <AnimatePresence>
          {showInspector && <Inspector trace={state.decision} engine={state.engine} wakeWord={titleCase(state.wakeWords[0] ?? state.name)} />}
        </AnimatePresence>
      </div>

      <Dock items={dock} />

      <AnimatePresence>{showCommand && <CommandBar name={state.name} onSubmit={typed} onClose={() => setShowCommand(false)} />}</AnimatePresence>
      <AnimatePresence>
        {showSettings && (
          <Settings
            name={state.name}
            snapshot={state.settings}
            result={state.settingsResult}
            screenPreview={state.screenPreview}
            onSave={(values) => send({ type: 'settings-set', values })}
            onAction={send}
            onClose={() => setShowSettings(false)}
            initialSection={settingsSection}
            onWalkthrough={() => (setShowSettings(false), setShowWelcome(true))}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showWelcome && state.settings && (
          <Onboarding
            name={state.name}
            snapshot={state.settings}
            heard={interim || heard}
            shortcut={shortcut}
            onSave={(values) => send({ type: 'settings-set', values })}
            onAction={send}
            onOpenSettings={(section) => (setShowWelcome(false), openSettings(section))}
            onClose={() => setShowWelcome(false)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {toast && (
          <motion.div key={toast.at} className={`toast ${toast.ok ? '' : 'is-error'}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}>
            {toast.message}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
