import { motion, useMotionValue, useSpring, useTransform, type MotionValue } from 'motion/react';
import { useRef } from 'react';

export interface DockItem {
  id: string;
  label: string;
  glyph: string;
  active?: boolean;
  status?: 'on' | 'off' | 'warn';
  onClick: () => void;
}

function DockIcon({ item, mouseX }: { item: DockItem; mouseX: MotionValue<number> }) {
  const ref = useRef<HTMLButtonElement>(null);
  const distance = useTransform(mouseX, (x) => {
    const r = ref.current?.getBoundingClientRect();
    return r ? x - (r.left + r.width / 2) : Infinity;
  });
  const size = useSpring(useTransform(distance, [-140, 0, 140], [48, 72, 48]), { stiffness: 380, damping: 26, mass: 0.2 });
  return (
    <motion.button ref={ref} style={{ width: size, height: size }} className={`dock__icon ${item.active ? 'is-active' : ''}`} onClick={item.onClick} title={item.label}>
      <span className="dock__glyph">{item.glyph}</span>
      {item.status && <span className={`dock__status dock__status--${item.status}`} />}
      <span className="dock__tooltip">{item.label}</span>
    </motion.button>
  );
}

/** macOS-style magnifying dock: brains, agents and panels. */
export function Dock({ items }: { items: DockItem[] }) {
  const mouseX = useMotionValue(Infinity);
  return (
    <motion.nav
      className="glass dock"
      onMouseMove={(e) => mouseX.set(e.clientX)}
      onMouseLeave={() => mouseX.set(Infinity)}
      initial={{ y: 80, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 260, damping: 26, delay: 0.2 }}
    >
      {items.map((item, i) =>
        item.id === '|' ? <span key={`sep-${i}`} className="dock__sep" /> : <DockIcon key={item.id} item={item} mouseX={mouseX} />,
      )}
    </motion.nav>
  );
}
