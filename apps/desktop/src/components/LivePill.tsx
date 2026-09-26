import { AnimatePresence, motion } from 'motion/react';
import type { Phase } from '@nova/core/protocol';

const LABEL: Record<Phase, string> = {
  idle: 'Say "Hey Nova"',
  listening: 'Listening',
  thinking: 'Thinking',
  acting: 'Working',
  speaking: 'Speaking',
};

const pretty = (s?: string) => (s ? s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : undefined);

/** Dynamic-Island-style capsule: what Nova is doing right now. */
export function LivePill({ phase, label, connected }: { phase: Phase; label?: string; connected: boolean }) {
  const text = !connected ? 'Daemon offline' : phase === 'idle' ? LABEL.idle : `${LABEL[phase]}${label ? ` · ${pretty(label)}` : ''}`;
  const expanded = connected && phase !== 'idle';
  return (
    <motion.div
      layout
      className={`pill ${expanded ? 'pill--expanded' : ''} ${!connected ? 'pill--offline' : ''}`}
      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
    >
      <span className={`pill__dot pill__dot--${connected ? phase : 'offline'}`} />
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={text}
          className="pill__text"
          initial={{ opacity: 0, y: 6, filter: 'blur(4px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: -6, filter: 'blur(4px)' }}
          transition={{ duration: 0.22 }}
        >
          {text}
        </motion.span>
      </AnimatePresence>
      {expanded && (
        <span className="pill__bars" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <i key={i} style={{ animationDelay: `${i * 0.12}s` }} />
          ))}
        </span>
      )}
    </motion.div>
  );
}
