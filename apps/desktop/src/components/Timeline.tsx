import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import type { ActivityItem } from '@nova/core/protocol';

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const startOfDay = (at: number) => new Date(new Date(at).getFullYear(), new Date(at).getMonth(), new Date(at).getDate()).getTime();

function dayLabel(at: number) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(at)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(at).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

type Filter = 'all' | 'you' | 'agents' | 'routines' | 'undoable' | 'failed';
const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['you', 'You'],
  ['agents', 'Agents & brains'],
  ['routines', 'Routines'],
  ['undoable', 'Undoable'],
  ['failed', 'Failed'],
];

const isRoutine = (i: ActivityItem) => i.by?.startsWith('routine:') ?? false;
const passes = (i: ActivityItem, f: Filter) =>
  f === 'all'
    ? true
    : f === 'you'
      ? i.by === 'you'
      : f === 'agents'
        ? Boolean(i.by && i.by !== 'you' && i.by !== 'Nova' && !isRoutine(i))
        : f === 'routines'
          ? isRoutine(i)
          : f === 'undoable'
            ? Boolean(i.undoable && !i.undone)
            : i.status === 'failed';
const matches = (i: ActivityItem, words: string[]) => {
  const text = `${i.label} ${i.by ?? ''} ${i.status} ${i.files?.join(' ') ?? ''} ${i.undone ? 'undone' : ''}`.toLowerCase();
  return words.every((w) => text.includes(w));
};

const base = (path: string) => path.split('/').pop() ?? path;

export interface TimelineProps {
  items: ActivityItem[];
  /** What the last search of the whole record found. */
  found: { query: string; items: ActivityItem[] } | null;
  /** How many days the record keeps. */
  keepDays?: number;
  onUndo: (id: string) => void;
  onSearch: (query: string) => void;
}

/**
 * The record of what Nova did: who asked, how it went, and Undo where it can be taken back.
 * The last week is here; a search reaches the whole record.
 */
export function Timeline({ items, found, keepDays, onUndo, onSearch }: TimelineProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  // The whole record's answer, once it's for what's typed now.
  const fromRecord = asked !== null && found?.query === asked && asked === query.trim() ? found.items : null;
  // The server already matched its own results (status included) - re-running the word search over
  // them here would only drop ones this simpler local check misses. Only the chip filter reapplies.
  const shown = useMemo(
    () => (fromRecord ? fromRecord.filter((i) => passes(i, filter)) : items.filter((i) => passes(i, filter) && matches(i, words))),
    [fromRecord, items, filter, words.join(' ')],
  );

  const groups: { day: string; items: ActivityItem[] }[] = [];
  for (const item of shown) {
    const day = dayLabel(item.at);
    if (groups.at(-1)?.day !== day) groups.push({ day, items: [] });
    groups.at(-1)!.items.push(item);
  }

  const undo = (item: ActivityItem) => {
    // Putting back an agent's files is asked about first, here as out loud.
    if (item.files?.length && confirming !== item.id) return setConfirming(item.id);
    setConfirming(null);
    onUndo(item.id);
  };

  return (
    <motion.aside
      className="glass panel timeline"
      initial={{ opacity: 0, x: -30, filter: 'blur(10px)' }}
      animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
      exit={{ opacity: 0, x: -30, filter: 'blur(10px)' }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
    >
      <header className="panel__header">
        <span>Activity</span>
        <span className="chip">{shown.length}</span>
      </header>
      <form
        className="timeline__search"
        onSubmit={(e) => {
          e.preventDefault();
          if (!query.trim()) return;
          setAsked(query.trim());
          onSearch(query.trim());
        }}
      >
        <input className="setting__input" placeholder="Search: “claude”, “reminder”, “failed”" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
      </form>
      <div className="chips timeline__filters">
        {FILTERS.map(([id, label]) => (
          <button key={id} type="button" className={`chip chip--button ${filter === id ? 'chip--accent' : ''}`} onClick={() => setFilter(id)}>
            {label}
          </button>
        ))}
      </div>
      {query.trim() && !fromRecord && (
        <button type="button" className="link timeline__more" onClick={() => (setAsked(query.trim()), onSearch(query.trim()))}>
          Search the whole record{keepDays ? ` (${keepDays} days)` : ''} →
        </button>
      )}
      {shown.length === 0 && (
        <p className="muted">{items.length === 0 ? 'Nothing yet. What Nova does shows up here - and what can be undone has an Undo.' : 'Nothing like that.'}</p>
      )}
      <ol className="timeline__list">
        {groups.map((group) => (
          <li key={group.day} className="timeline__group">
            <div className="timeline__day">{group.day}</div>
            <ol className="timeline__list">
              <AnimatePresence initial={false}>
                {group.items.map((item) => (
                  <motion.li key={item.id} layout initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className={`timeline__item ${item.undone ? 'is-undone' : ''}`}>
                    <span className={`timeline__dot timeline__dot--${item.undone ? 'cancelled' : item.status}`} />
                    <div className="timeline__body">
                      <span className="timeline__label" title={item.label}>
                        {item.label}
                      </span>
                      <span className="timeline__meta">
                        {item.by && <span className="timeline__by">{item.by === 'you' ? 'you asked' : item.by}</span>}
                        {item.tier !== undefined && <span className="chip chip--tiny">T{item.tier}</span>}
                        {item.undone && <span className="chip chip--tiny">undone {time(item.undone)}</span>}
                      </span>
                      {item.files && item.files.length > 0 && (
                        <details className="timeline__files">
                          <summary>
                            {item.files.length === 1 ? base(item.files[0]!) : `${item.files.length} files`} changed
                          </summary>
                          <ul>
                            {item.files.slice(0, 40).map((f) => (
                              <li key={f}>{f}</li>
                            ))}
                            {item.files.length > 40 && <li>and {item.files.length - 40} more</li>}
                          </ul>
                        </details>
                      )}
                      {confirming === item.id && (
                        <span className="timeline__confirm">
                          Put back {item.files!.length === 1 ? base(item.files![0]!) : `the ${item.files!.length} files`} as before?{' '}
                          <button type="button" className="link" onClick={() => undo(item)}>
                            Put back
                          </button>{' '}
                          <button type="button" className="link" onClick={() => setConfirming(null)}>
                            Cancel
                          </button>
                        </span>
                      )}
                    </div>
                    <span className="timeline__side">
                      <span className="timeline__time">{time(item.at)}</span>
                      {item.undoable && !item.undone && confirming !== item.id && (
                        <button type="button" className="btn btn--ghost timeline__undo" onClick={() => undo(item)}>
                          Undo
                        </button>
                      )}
                    </span>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ol>
          </li>
        ))}
      </ol>
    </motion.aside>
  );
}
