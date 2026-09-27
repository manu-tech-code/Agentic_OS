import { useEffect, useState } from 'react';
import type { SettingValue } from '@nova/core/settings';

/** Keys are settings-file paths; null resets one to its default. */
export type Save = (changes: Record<string, SettingValue | null>) => void;

export function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (on: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`switch ${on ? 'is-on' : ''}`} onClick={() => onChange(!on)}>
      <span className="switch__knob" />
    </button>
  );
}

/** Commits on Enter or when focus leaves, only if the text changed. */
export function TextInput({
  value,
  onSave,
  placeholder,
  list,
  mono,
}: {
  value: string;
  onSave: (value: string) => void;
  placeholder?: string;
  list?: string;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className={`setting__input ${mono ? 'is-mono' : ''}`}
      value={draft}
      placeholder={placeholder}
      list={list}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft.trim() !== value && onSave(draft.trim())}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
}

/** A number, clamped to its range; saved only when it changes. */
export function NumberInput({
  value,
  onSave,
  unit,
  min,
  max,
  step,
}: {
  value: number;
  onSave: (value: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    let n = Number(draft);
    if (!Number.isFinite(n) || draft.trim() === '') return setDraft(String(value));
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    setDraft(String(n));
    if (n !== value) onSave(n);
  };
  return (
    <span className="setting__number">
      <input
        className="setting__input"
        type="number"
        inputMode="decimal"
        value={draft}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      {unit && <span className="setting__unit">{unit}</span>}
    </span>
  );
}

/** A list edited as comma-separated text. */
export function ListInput({ value, onSave, placeholder }: { value: string[]; onSave: (value: string[]) => void; placeholder?: string }) {
  return (
    <TextInput
      value={value.join(', ')}
      placeholder={placeholder}
      onSave={(text) =>
        onSave(
          text
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        )
      }
    />
  );
}

/** Secrets are constants in .env: Settings only shows whether one is set, never its value. */
export function SecretStatus({ name, set }: { name: string; set: boolean }) {
  return (
    <span className="setting__secret" title={set ? `${name} is set in .env` : `Add ${name}=... to .env, then restart Nova`}>
      <span className={`dot ${set ? 'dot--on' : ''}`} />
      <span className="muted">{set ? 'Set in .env' : 'Not set'}</span>
      <code className="setting__var">{name}</code>
    </span>
  );
}

/** Saved values can be reset to their default; unsaved ones already are. */
export function Reset({ saved, onReset }: { saved: boolean; onReset: () => void }) {
  if (!saved) return <span className="setting__source" />;
  return (
    <button type="button" className="setting__source is-reset" title="Reset to the default" onClick={onReset}>
      ↺
    </button>
  );
}
