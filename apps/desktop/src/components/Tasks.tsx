import { AnimatePresence, motion } from 'motion/react';
import type { TaskRecord } from '@nova/core';

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const took = (t: TaskRecord) => {
  const s = Math.round(((t.ended ?? Date.now()) - t.started) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
};
const STATUS: Record<TaskRecord['status'], string> = { running: 'working', done: 'done', failed: 'failed', cancelled: 'stopped' };

/** The task board: what the agents are doing, and what they did and said. */
export function Tasks({ tasks, onCancel, onRetry }: { tasks: TaskRecord[]; onCancel: (id: string) => void; onRetry: (id: string) => void }) {
  const running = tasks.filter((t) => t.status === 'running').length;
  return (
    <motion.aside
      className="glass panel tasks"
      initial={{ opacity: 0, x: -30, filter: 'blur(10px)' }}
      animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
      exit={{ opacity: 0, x: -30, filter: 'blur(10px)' }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
    >
      <header className="panel__header">
        <span>Agent tasks</span>
        <span className="chip">{running ? `${running} working` : tasks.length}</span>
      </header>
      {tasks.length === 0 && <p className="muted">Tasks you give agents - "ask Claude to fix the tests" - show here, with what they did and said.</p>}
      <ol className="tasks__list">
        <AnimatePresence initial={false}>
          {tasks.map((t) => (
            <motion.li key={t.id} layout initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className={`task task--${t.status}`}>
              <div className="task__head">
                <span className={`timeline__dot timeline__dot--${t.status === 'running' ? 'pending' : t.status === 'done' ? 'done' : t.status === 'failed' ? 'failed' : 'cancelled'}`} />
                <strong>{t.label}</strong>
                <span className="muted">· {t.project}</span>
                <span className="task__meta">
                  {STATUS[t.status]} · {time(t.started)} · {took(t)}
                </span>
              </div>
              <div className="task__what">{t.task}</div>
              {t.status === 'running' && t.step && <div className="task__step">{t.step}</div>}
              {t.status !== 'running' && t.report && (
                <details className="task__report">
                  <summary>{t.status === 'failed' ? 'Why' : 'What it said'}</summary>
                  <p>{t.report}</p>
                </details>
              )}
              <div className="task__actions">
                {t.status === 'running' ? (
                  <button type="button" className="link" onClick={() => onCancel(t.id)}>
                    Stop
                  </button>
                ) : (
                  <button type="button" className="link" onClick={() => onRetry(t.id)}>
                    Run again
                  </button>
                )}
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
    </motion.aside>
  );
}
