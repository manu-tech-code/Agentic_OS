import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, type RefObject } from 'react';
import type { Phase } from '@nova/core/protocol';

const PALETTE: Record<Phase, [string, string, string]> = {
  idle: ['#6d7cff', '#b28cff', '#2b2a6e'],
  listening: ['#3fd0ff', '#8af3ff', '#123a6e'],
  thinking: ['#9b6bff', '#ff7ad9', '#3a1a6e'],
  acting: ['#2fe0a3', '#5ad1ff', '#0f4a4a'],
  speaking: ['#8fd3ff', '#ffffff', '#2a3f8e'],
};

const SPIN: Record<Phase, string> = { idle: '18s', listening: '9s', thinking: '2.4s', acting: '4s', speaking: '6s' };

/**
 * The glass Orb - Nova's face. Reacts to mic level (listening), swirls while
 * thinking and pulses while speaking. Level is written straight to a CSS var
 * every frame to avoid React re-renders.
 */
export function Orb({ phase, levelRef, onClick }: { phase: Phase; levelRef: RefObject<number>; onClick?: () => void }) {
  const el = useRef<HTMLButtonElement>(null);
  const [a, b, c] = PALETTE[phase];

  useEffect(() => {
    let raf = 0;
    const loop = (t: number) => {
      let level = levelRef.current ?? 0;
      if (phase === 'speaking') level = 0.35 + 0.25 * Math.sin(t / 110) * Math.sin(t / 370);
      if (phase === 'thinking') level = 0.15 + 0.08 * Math.sin(t / 240);
      if (phase === 'idle') level = 0.04 + 0.03 * Math.sin(t / 900);
      el.current?.style.setProperty('--level', level.toFixed(3));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [phase, levelRef]);

  return (
    <button
      ref={el}
      className={`orb orb--${phase}`}
      onClick={onClick}
      aria-label={`Nova is ${phase}`}
      style={{ ['--a' as string]: a, ['--b' as string]: b, ['--c' as string]: c, ['--spin' as string]: SPIN[phase] }}
    >
      <span className="orb__glow" />
      <AnimatePresence>
        {phase === 'listening' &&
          [0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="orb__ring"
              initial={{ scale: 0.9, opacity: 0.5 }}
              animate={{ scale: 1.9, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 2.4, repeat: Infinity, delay: i * 0.8, ease: 'easeOut' }}
            />
          ))}
      </AnimatePresence>
      <span className="orb__body">
        <span className="orb__swirl" />
        <span className="orb__swirl orb__swirl--2" />
        <span className="orb__core" />
        <span className="orb__shine" />
      </span>
    </button>
  );
}
