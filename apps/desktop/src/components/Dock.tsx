import { motion, useMotionValue, useSpring, useTransform, type MotionValue } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

/** Shrinks the dock to fit narrow windows, measured from its resting size (icons 48px, gaps 10px). */
function useFitScale(items: DockItem[]) {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const icons = items.filter((i) => i.id !== '|').length;
  const resting = icons * 48 + (items.length - icons) * 5 + (items.length - 1) * 10 + 26;
  return Math.min(1, (width - 24) / resting);
}

export interface DockItem {
  id: string;
  label: string;
  glyph: string;
  active?: boolean;
  status?: 'on' | 'off' | 'warn' | 'busy';
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

/**
 * macOS-style magnifying dock: brains, agents and panels. The wrapper centres it; the dock's
 * own slide-in animation owns its transform, so centring can't live on the dock itself.
 */
export function Dock({ items }: { items: DockItem[] }) {
  const mouseX = useMotionValue(Infinity);
  const scale = useFitScale(items);
  return (
    <div className="dock-wrap" style={scale < 1 ? { transform: `scale(${scale})`, transformOrigin: 'bottom center' } : undefined}>
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
    </div>
  );
}
