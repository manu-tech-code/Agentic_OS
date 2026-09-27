import { useState } from 'react';
import type { ClientEvent } from '@nova/core/protocol';
import { personalize, type SettingsSnapshot } from '@nova/core/settings';

type Actions = { snapshot: SettingsSnapshot; name: string; onAction: (event: ClientEvent) => void };

const ago = (at: number) => {
  const days = Math.floor((Date.now() - at) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
};

/** Everything Nova remembers: readable, editable, and forgettable one by one or all at once. */
export function MemoryPanel({ snapshot, name, onAction }: Actions) {
  const { items, conversations } = snapshot.memory;
  const [filter, setFilter] = useState('');
  const shown = items.filter((m) => m.text.toLowerCase().includes(filter.toLowerCase())).sort((a, b) => (b.updated ?? b.created) - (a.updated ?? a.created));
  return (
    <div className="integrations">
      <div className="tile">
        <div className="tile__head">
          <strong>What {name} remembers</strong>
          <span className="muted">
            {items.length} {items.length === 1 ? 'memory' : 'memories'}
          </span>
          {items.length > 0 && (
            <span className="tile__actions">
              <button type="button" className="link" onClick={() => confirm(`Forget all ${items.length} memories?`) && onAction({ type: 'memory-clear' })}>
                Forget everything
              </button>
            </span>
          )}
        </div>
        {items.length === 0 ? (
          <span className="muted">{personalize('Nothing yet. Say "remember that my standup is at 10", or say yes when Nova offers to remember something.', name)}</span>
        ) : (
          <>
            {items.length > 6 && <input className="setting__input memory-find" placeholder="Find a memory" value={filter} onChange={(e) => setFilter(e.target.value)} />}
            {shown.map((m) => (
              <MemoryRow key={m.id} item={m} onAction={onAction} />
            ))}
          </>
        )}
      </div>
      <div className="tile">
        <div className="tile__head">
          <strong>Past conversations</strong>
          <span className="muted">
            {conversations.turns} {conversations.turns === 1 ? 'turn' : 'turns'} over {conversations.days} {conversations.days === 1 ? 'day' : 'days'}
          </span>
          {conversations.turns > 0 && (
            <span className="tile__actions">
              <button type="button" className="link" onClick={() => confirm('Clear the whole conversation history?') && onAction({ type: 'conversations-clear' })}>
                Clear history
              </button>
            </span>
          )}
        </div>
        <span className="muted">{personalize('Kept on this Mac only, so you can ask "what did I ask you yesterday?". How long they are kept is set below.', name)}</span>
      </div>
    </div>
  );
}

function MemoryRow({ item, onAction }: { item: SettingsSnapshot['memory']['items'][number]; onAction: (event: ClientEvent) => void }) {
  const [text, setText] = useState(item.text);
  const save = () => text.trim() && text.trim() !== item.text && onAction({ type: 'memory-edit', id: item.id, text: text.trim() });
  return (
    <div className="tool-row memory-row">
      <div>
        <input className="setting__input" aria-label="Memory" value={text} onChange={(e) => setText(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === 'Enter' && save()} />
        <div className="muted">
          {item.source === 'said' ? 'you said to remember this' : 'you said yes when asked'} · {item.updated ? 'edited ' : ''}
          {ago(item.updated ?? item.created)}
        </div>
      </div>
      <button type="button" className="link" onClick={() => onAction({ type: 'memory-delete', id: item.id })}>
        Forget
      </button>
    </div>
  );
}

/** Nova Eyes: whether macOS lets it see, the buttons that ask, and what it sees now. */
export function ScreenPanel({ snapshot, name, onAction, preview }: Actions & { preview: { text: string; at: number } | null }) {
  const { available, running, permissions, message } = snapshot.screen;
  if (!available) return <div className="tile"><span className="muted">{message ?? 'Seeing the screen needs macOS.'}</span></div>;
  const row = (label: string, granted: boolean | undefined, kind: 'accessibility' | 'screen', why: string) => (
    <div className="tile__head">
      <span className={`dot ${granted ? 'dot--on' : ''}`} />
      <strong>{label}</strong>
      <span className="muted">{granted ? 'allowed' : why}</span>
      {!granted && (
        <span className="tile__actions">
          <button type="button" className="btn btn--ghost" onClick={() => onAction({ type: 'screen-permission', kind })}>
            Allow
          </button>
        </span>
      )}
    </div>
  );
  return (
    <div className="integrations">
      <div className="tile">
        <strong>Nova Eyes</strong>
        <span className="muted">
          {personalize(
            "A small background app that sees for Nova. macOS asks you to allow it by name - not the terminal Nova runs in - and it answers only Nova. It reads the screen only when you ask Nova to look.",
            name,
          )}
        </span>
        {!running && !permissions ? (
          <div className="tile__head">
            <span className="muted">{message ?? "Nova Eyes isn't running."}</span>
            <span className="tile__actions">
              <button type="button" className="btn btn--ghost" onClick={() => onAction({ type: 'screen-restart' })}>
                Start Nova Eyes
              </button>
            </span>
          </div>
        ) : (
          <>
            {message && <span className="muted">{message}</span>}
            {row('Accessibility', permissions?.accessibility, 'accessibility', 'needed for the window title and selected text')}
            {row('Screen Recording', permissions?.screen, 'screen', 'needed to look at the screen when you ask')}
            <div className="tile__head">
              <span className="muted">Allowed Screen Recording just now? macOS applies it once Nova Eyes restarts.</span>
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
          <strong>What {name} would know now</strong>
          <span className="tile__actions">
            <button type="button" className="btn btn--ghost" onClick={() => onAction({ type: 'screen-preview' })}>
              Show me
            </button>
          </span>
        </div>
        <span className="muted screen-preview">{preview ? preview.text : personalize("What goes with your next question: the app and window you're in, the page, and any selected text.", name)}</span>
      </div>
    </div>
  );
}
