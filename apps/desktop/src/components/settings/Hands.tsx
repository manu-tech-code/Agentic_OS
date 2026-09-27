import { useState } from 'react';
import type { ClientEvent } from '@nova/core/protocol';
import { personalize, type SettingsSnapshot } from '@nova/core/settings';
import type { Save } from './Controls';

type Props = { snapshot: SettingsSnapshot; name: string; onSave: Save; onAction: (event: ClientEvent) => void };

/** Things to say, to show what Nova's hands can do. */
const EXAMPLES: [string, string][] = [
  ['turn the volume down a bit', 'volume, brightness, dark mode, Wi-Fi, Bluetooth, Focus'],
  ['next song', 'Music and Spotify - or "play some jazz" from your library'],
  ['Safari on the left and Slack on the right', 'halves, quarters, thirds, the other display'],
  ['save this layout as work', 'then "work layout" puts every window back'],
  ['find the invoice from last week', 'by name, kind or date - "summarize it" reads it'],
  ["what's on my clipboard?", 'never what a password manager hides'],
  ['run my log water shortcut', 'any of your Shortcuts, by name'],
  ['click send', 'or "type hello", "press command s", "scroll down"'],
  ['use the computer to book a table', 'a brain looks and clicks, asking before each step'],
];

/**
 * Settings → Hands: what macOS lets Nova Eyes do for Nova's hands, the user's Shortcuts (and which
 * turn Focus on and off), and saved window layouts.
 */
export function HandsPanel({ snapshot, name, onSave, onAction }: Props) {
  const hands = snapshot.hands;
  const [allShortcuts, setAllShortcuts] = useState(false);
  if (!hands.available) return <div className="tile"><span className="muted">{hands.message ?? "Nova's hands need macOS."}</span></div>;
  const p = hands.permissions;
  const computer = snapshot.values['hands.computerUse'] === true;
  const row = (label: string, granted: boolean | undefined, kind: 'accessibility' | 'screen', why: string) => (
    <div className="tile__head">
      <span className={`dot ${granted ? 'dot--on' : granted === false ? 'dot--warn' : ''}`} />
      <strong>{label}</strong>
      <span className="muted">{granted ? 'allowed' : personalize(why, name)}</span>
      {!granted && (
        <span className="tile__actions">
          <button type="button" className="btn btn--ghost" onClick={() => onAction({ type: 'screen-permission', kind })}>
            Allow
          </button>
        </span>
      )}
    </div>
  );
  const shortcuts = hands.shortcuts ?? [];
  const shown = allShortcuts ? shortcuts : shortcuts.slice(0, 12);
  const focus = hands.focus;
  const focusNames = [focus.on && `“${focus.on}”`, focus.off && `“${focus.off}”`, focus.toggle && `“${focus.toggle}”`, focus.status && `“${focus.status}”`].filter(Boolean);
  return (
    <div className="integrations">
      {hands.message && <div className="banner banner--quiet">{hands.message}</div>}
      <div className="tile">
        <div className="tile__head">
          <strong>What macOS lets {name} do</strong>
          {hands.active && <span className="chip chip--accent">using the computer now</span>}
        </div>
        <span className="muted">
          {personalize(
            "Nova's hands work through Nova Eyes, a small background app that macOS asks you about by name. Anything that changes something is asked about out loud first, unless you asked for it yourself - and \"stop everything\" (⌃⌥⌘.) halts it at once.",
            name,
          )}
        </span>
        {!p ? (
          <div className="tile__head">
            <span className="muted">{snapshot.screen.message ?? "Nova Eyes isn't running yet."}</span>
            <span className="tile__actions">
              <button type="button" className="btn btn--ghost" onClick={() => onAction({ type: 'screen-restart' })}>
                Start Nova Eyes
              </button>
            </span>
          </div>
        ) : (
          <>
            {row('Accessibility', p.accessibility, 'accessibility', 'needed to click, type, press keys and move windows')}
            {row('Screen Recording', p.screen, 'screen', computer ? 'needed for brains to see the screen they use' : 'needed only when brains use the computer')}
            <div className="tile__head">
              <span className="muted">Turned one on just now? macOS applies Screen Recording once Nova Eyes restarts.</span>
              <span className="tile__actions">
                <button type="button" className="link" onClick={() => onAction({ type: 'screen-restart' })}>
                  Restart Nova Eyes
                </button>
              </span>
            </div>
          </>
        )}
      </div>

      <div className="tile">
        <div className="tile__head">
          <strong>Your Shortcuts</strong>
          <span className="muted">{hands.shortcuts ? `${shortcuts.length} found` : 'not read yet'}</span>
          <span className="tile__actions">
            <button type="button" className="link" onClick={() => onAction({ type: 'hands-refresh' })}>
              Read them again
            </button>
          </span>
        </div>
        {shortcuts.length === 0 ? (
          <span className="muted">{personalize('None yet. Make one in the Shortcuts app and say "run my … shortcut" - Nova asks first, or not at all once you say "yes, always".', name)}</span>
        ) : (
          <div className="chips">
            {shown.map((s) => (
              <span key={s} className="chip">
                {s}
              </span>
            ))}
            {shortcuts.length > shown.length && (
              <button type="button" className="chip chip--button" onClick={() => setAllShortcuts(true)}>
                {shortcuts.length - shown.length} more
              </button>
            )}
          </div>
        )}
        <span className="muted">
          {focusNames.length
            ? `Focus goes on and off with ${focusNames.join(', ')}.`
            : personalize('To turn Focus (Do Not Disturb) on and off by voice, make two shortcuts with the Set Focus action, named "Focus On" and "Focus Off".', name)}
        </span>
      </div>

      <div className="tile">
        <div className="tile__head">
          <strong>Window layouts</strong>
          <span className="muted">{hands.layouts.length ? `${hands.layouts.length} saved` : ''}</span>
        </div>
        {hands.layouts.length === 0 ? (
          <span className="muted">{personalize('Arrange your windows and say "save this layout as work" - then "work layout" puts them back, on any display.', name)}</span>
        ) : (
          hands.layouts.map((l) => (
            <div key={l.name} className="tool-row memory-row">
              <div>
                <div>{l.name}</div>
                <div className="muted">
                  {l.windows} {l.windows === 1 ? 'window' : 'windows'} · {l.apps.slice(0, 5).join(', ')}
                  {l.apps.length > 5 ? ` and ${l.apps.length - 5} more` : ''}
                </div>
              </div>
              <button type="button" className="link" onClick={() => confirm(`Delete the ${l.name} layout?`) && onSave({ [`windows.layouts.${l.name}`]: null })}>
                Delete
              </button>
            </div>
          ))
        )}
      </div>

      <div className="tile">
        <strong>Things to say</strong>
        <ul className="welcome__list hands__examples">
          {EXAMPLES.map(([said, what]) => (
            <li key={said}>
              <strong>“{said}”</strong>
              <span className="muted"> - {personalize(what, name)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
