import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

/** Spotlight-style fallback for when you can't talk. Opens with ⌘K. */
export function CommandBar({ name, onSubmit, onClose }: { name: string; onSubmit: (text: string) => void; onClose: () => void }) {
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  return (
    <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.form
        className="glass command"
        initial={{ y: -20, scale: 0.96, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        exit={{ y: -20, scale: 0.96, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 420, damping: 32 }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
          onClose();
        }}
      >
        <span className="command__glyph">✦</span>
        <input
          ref={input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
          placeholder={`Ask ${name}… (open Slack, set a timer for 5 minutes, what time is it)`}
        />
        <kbd>↵</kbd>
      </motion.form>
    </motion.div>
  );
}
