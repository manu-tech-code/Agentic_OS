import { useEffect, useState } from 'react';
import type { ClientEvent } from '@nova/core/protocol';
import { personalize, type SettingsSnapshot, type ShellStatus } from '@nova/core/settings';
import { formatShortcut, shortcutFromKeyboard, shortcutProblem } from '@nova/core/shortcut';

const LISTENING: Record<ShellStatus['listening'], string> = {
  'wake-word': 'Listening for its name',
  shortcut: 'Listening only after the shortcut',
  window: "Listening while Nova's window is open",
  muted: 'Microphone muted from the menu bar',
  locked: 'Paused while the Mac is locked',
  'no-mic': "Can't use the microphone",
  starting: 'Starting…',
};

/** Nova.app: whether it's running, what macOS lets it do, and the buttons that ask. */
export function PresencePanel({ snapshot, name, onAction }: { snapshot: SettingsSnapshot; name: string; onAction: (event: ClientEvent) => void }) {
  const app = snapshot.presence.app;
  const act = (action: Extract<ClientEvent, { type: 'shell-action' }>['action']) => onAction({ type: 'shell-action', action });
  if (!app) {
    return (
      <div className="tile">
        <div className="tile__head">
          <span className="dot" />
          <strong>Nova.app isn't running</strong>
        </div>
        <span className="muted">
          {personalize(
            'Nova.app puts Nova in your menu bar: it hears its name from anywhere, shows what it hears and says in a small orb, and comes when you press ⌥Space. Build it on this Mac and open it with:',
            name,
          )}
        </span>
        <code className="cmd-snippet">npm run app</code>
        <span className="muted">It goes in ~/Applications, opens at login, and runs the daemon for you. The settings below apply while it runs.</span>
      </div>
    );
  }
  const row = (on: boolean, label: string, detail: string, button?: { label: string; onClick: () => void }) => (
    <div className="tile__head">
      <span className={`dot ${on ? 'dot--on' : ''}`} />
      <strong>{label}</strong>
      <span className="muted">{detail}</span>
      {button && (
        <span className="tile__actions">
          <button type="button" className="btn btn--ghost" onClick={button.onClick}>
            {button.label}
          </button>
        </span>
      )}
    </div>
  );
  const mic =
    app.mic === 'granted'
      ? row(true, 'Microphone', 'allowed')
      : app.mic === 'undetermined'
        ? row(false, 'Microphone', personalize('Nova needs it to hear you', name), { label: 'Allow', onClick: () => act('request-mic') })
        : row(false, 'Microphone', 'turned off for Nova in System Settings → Privacy & Security → Microphone', { label: 'Open System Settings', onClick: () => act('open-mic-settings') });
  const login =
    app.loginItem === 'on'
      ? row(true, 'At login', 'opens by itself')
      : app.loginItem === 'needs-approval'
        ? row(false, 'At login', 'allow Nova in System Settings → General → Login Items', { label: 'Open System Settings', onClick: () => act('open-login-items') })
        : app.loginItem === 'error'
          ? row(false, 'At login', app.loginItemMessage ?? "macOS wouldn't add it")
          : row(false, 'At login', 'off');
  return (
    <div className="tile">
      <div className="tile__head">
        <span className="dot dot--on" />
        <strong>Nova.app {app.version}</strong>
        <span className="muted">{personalize(LISTENING[app.listening], name)}</span>
      </div>
      {mic}
      {row(app.shortcut.ok, 'Shortcut', app.shortcut.ok ? `${formatShortcut(app.shortcut.keys)} - hold to talk, tap to listen` : (app.shortcut.message ?? `${formatShortcut(app.shortcut.keys)} isn't available`))}
      {login}
      {app.daemon === 'hosted'
        ? row(true, 'Daemon', 'run by Nova.app, started again if it stops', { label: 'Restart it', onClick: () => act('restart-daemon') })
        : row(true, 'Daemon', 'started elsewhere (a terminal) - Nova.app only connects to it')}
    </div>
  );
}

/** A shortcut recorder: click it, then press the keys. Escape leaves it as it was. */
export function ShortcutInput({ value, onSave }: { value: string; onSave: (keys: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation(); // not Settings' Escape, nor the window's own shortcuts
      if (e.key === 'Escape' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) return setRecording(false);
      const keys = shortcutFromKeyboard(e);
      if (!keys) return; // only modifiers so far
      const why = shortcutProblem(keys);
      if (why) return setProblem(`${formatShortcut(keys)} ${why}.`);
      setProblem(null);
      setRecording(false);
      if (keys !== value) onSave(keys);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, value, onSave]);
  return (
    <div className="shortcut">
      <button
        type="button"
        className={`shortcut__keys ${recording ? 'is-recording' : ''}`}
        onClick={() => {
          setProblem(null);
          setRecording((r) => !r);
        }}
      >
        {recording ? 'Press the keys…' : formatShortcut(value)}
      </button>
      {problem && <span className="shortcut__problem">{problem}</span>}
    </div>
  );
}
