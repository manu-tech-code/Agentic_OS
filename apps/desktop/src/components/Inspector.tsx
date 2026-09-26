import { motion } from 'motion/react';
import type { DecisionTrace } from '@nova/core/protocol';

function Bars({ probs, selected }: { probs: Record<string, number>; selected?: string }) {
  const rows = Object.entries(probs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  return (
    <div className="bars">
      {rows.map(([k, p]) => (
        <div key={k} className={`bars__row ${k === selected ? 'is-selected' : ''}`}>
          <span className="bars__label">{k.replace(/_/g, ' ')}</span>
          <span className="bars__track">
            <motion.span className="bars__fill" initial={{ width: 0 }} animate={{ width: `${Math.round(p * 100)}%` }} transition={{ type: 'spring', stiffness: 200, damping: 26 }} />
          </span>
          <span className="bars__value">{p.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

/** Developer view of the last System 1 decision. */
export function Inspector({ trace, engine }: { trace: DecisionTrace | null; engine: string | null }) {
  const a = (trace?.answers ?? {}) as Record<string, any>;
  return (
    <motion.aside
      className="glass panel inspector"
      initial={{ opacity: 0, x: 30, filter: 'blur(10px)' }}
      animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
      exit={{ opacity: 0, x: 30, filter: 'blur(10px)' }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
    >
      <header className="panel__header">
        <span>Decision Inspector</span>
        <span className="chip">{engine ?? '—'}</span>
      </header>
      {!trace ? (
        <p className="muted">Say something after "Hey Nova" to see how System 1 decided.</p>
      ) : (
        <>
          <div className="inspector__utterance">“{trace.utterance}”</div>
          <div className="inspector__meta">
            <span className="chip chip--accent">{trace.latencyMs} ms</span>
            <span className="chip">{trace.engine}</span>
            {trace.fellBack && <span className="chip chip--warn">fallback</span>}
          </div>
          <div className="inspector__outcome">→ {trace.outcome}</div>
          {a.intent?.probabilities && (
            <section>
              <h4>Intent · choice</h4>
              <Bars probs={a.intent.probabilities} selected={a.intent.choice} />
            </section>
          )}
          {a.app?.probabilities && (
            <section>
              <h4>App · choice</h4>
              <Bars probs={a.app.probabilities} selected={a.app.choice} />
            </section>
          )}
          {a.addressed && (
            <section>
              <h4>Addressed to Nova · boolean</h4>
              <Bars probs={{ 'P(true)': a.addressed.probability }} selected="P(true)" />
            </section>
          )}
        </>
      )}
    </motion.aside>
  );
}
