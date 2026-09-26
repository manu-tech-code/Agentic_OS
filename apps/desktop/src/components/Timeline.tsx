import { AnimatePresence, motion } from 'motion/react';
import type { ActivityItem } from '@nova/core/protocol';

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Everything Nova did, newest first. Undo lands here later. */
export function Timeline({ items }: { items: ActivityItem[] }) {
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
        <span className="chip">{items.length}</span>
      </header>
      {items.length === 0 && <p className="muted">Nothing yet. Actions Nova takes show up here.</p>}
      <ol className="timeline__list">
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <motion.li key={item.id} layout initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="timeline__item">
              <span className={`timeline__dot timeline__dot--${item.status}`} />
              <span className="timeline__label">{item.label}</span>
              {item.tier !== undefined && <span className="chip chip--tiny">T{item.tier}</span>}
              <span className="timeline__time">{time(item.at)}</span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
    </motion.aside>
  );
}
