import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import type { Card } from '@nova/core/protocol';

const ICON: Record<Card['kind'], string> = {
  app: '◐',
  time: '◷',
  timer: '⏱',
  reminder: '◔',
  info: 'ⓘ',
  confirm: '⚠︎',
  error: '✕',
  answer: '✦',
  task: '✳︎',
};

function Countdown({ endsAt }: { endsAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.round((endsAt - now) / 1000));
  const m = Math.floor(left / 60);
  const s = String(left % 60).padStart(2, '0');
  return <div className="card__countdown">{`${m}:${s}`}</div>;
}

/**
 * A reply's cards close by themselves; these stay until they're done: a question waiting for a yes or no, a timer
 * counting down, an agent's task at work.
 */
const STAYS: ReadonlySet<Card['kind']> = new Set(['confirm', 'timer', 'task']);

/**
 * Floating frosted result cards. Confirm cards also accept a tap. The rest close after `closeAfter` seconds (0: they
 * stay) - a thin bar shows the time left, and pointing at a card holds it (Settings → Appearance).
 */
export function Cards({
  cards,
  closeAfter,
  onDismiss,
  onAnswer,
  onTap,
}: {
  cards: Card[];
  closeAfter: number;
  onDismiss: (id: string) => void;
  onAnswer: (text: 'yes' | 'no') => void;
  /** A question only a tap answers (money, what can't be undone): Allow or No, sent as a tap on this Mac's screen. */
  onTap: (id: string, yes: boolean) => void;
}) {
  return (
    <div className="cards">
      <AnimatePresence initial={false}>
        {cards.map((card) => (
          <motion.article
            key={card.id}
            layout
            className={`glass card card--${card.kind}`}
            initial={{ opacity: 0, x: 40, scale: 0.94, filter: 'blur(8px)' }}
            animate={{ opacity: 1, x: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, x: 40, scale: 0.94, filter: 'blur(8px)' }}
            transition={{ type: 'spring', stiffness: 360, damping: 30 }}
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            onDragEnd={(_, info) => Math.abs(info.offset.x) > 120 && onDismiss(card.id)}
          >
            <div className="card__icon">{ICON[card.kind]}</div>
            <div className="card__content">
              <div className="card__title">{card.title}</div>
              {card.body && <div className="card__body">{card.body}</div>}
              {card.endsAt && <Countdown endsAt={card.endsAt} />}
              {card.kind === 'confirm' && (
                <div className="card__actions">
                  <button className="btn btn--ghost" onClick={() => (card.tap ? onTap(card.id, false) : onAnswer('no'))}>
                    No
                  </button>
                  <button className="btn btn--primary" onClick={() => (card.tap ? onTap(card.id, true) : onAnswer('yes'))}>
                    {card.tap ? 'Allow' : 'Yes'}
                  </button>
                </div>
              )}
            </div>
            <button className="card__close" onClick={() => onDismiss(card.id)} aria-label="Dismiss">
              ×
            </button>
            {closeAfter > 0 && !STAYS.has(card.kind) && !card.endsAt && (
              <div className="card__life" style={{ animationDuration: `${closeAfter}s` }} onAnimationEnd={() => onDismiss(card.id)} aria-hidden />
            )}
          </motion.article>
        ))}
      </AnimatePresence>
    </div>
  );
}
