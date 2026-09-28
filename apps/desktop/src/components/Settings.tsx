import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import type { ClientEvent } from '@nova/core/protocol';
import { FIELDS, personalize, SECTIONS, type SettingField, type SettingsSection, type SettingsSnapshot, type SettingValue } from '@nova/core/settings';
import { previewVoice } from '../voice/voice';
import { ListInput, NumberInput, Reset, Switch, TextInput, type Save } from './settings/Controls';
import { AgentsPanel, HearingPanel, JevPanel, OrbPreview, ProjectsPanel, ReflexPanel, ServersPanel, SystemPanel, VoiceIdPanel, VoicePanel } from './settings/Panels';
import { IntegrationsPanel } from './settings/Integrations';
import { HandsPanel } from './settings/Hands';
import { MemoryPanel, ScreenPanel } from './settings/Memory';
import { PresencePanel, ShortcutInput } from './settings/Presence';
import { InitiativePanel } from './settings/Initiative';
import { PrivacyPanel, SetupPanel } from './settings/Trust';
import { inApp, tellApp, useVoiceOwner } from '../lib/shell';

const LANGUAGES: [string, string][] = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['en-GH', 'English (Ghana)'],
  ['en-NG', 'English (Nigeria)'],
  ['en-KE', 'English (Kenya)'],
  ['en-IN', 'English (India)'],
  ['en-AU', 'English (Australia)'],
  ['fr-FR', 'Français'],
  ['de-DE', 'Deutsch'],
  ['es-ES', 'Español'],
  ['pt-BR', 'Português (Brasil)'],
  ['it-IT', 'Italiano'],
  ['nl-NL', 'Nederlands'],
  ['sw-KE', 'Kiswahili'],
  ['ar-SA', 'العربية'],
  ['zh-CN', '中文'],
  ['ja-JP', '日本語'],
  ['ko-KR', '한국어'],
];

/** A Kokoro voice, with a button to hear it (the daemon speaks the sample). */
export function KokoroVoiceSelect({ field, value, installed, onSave, onAction }: { field: SettingField; value: string; installed: boolean; onSave: (v: string) => void; onAction: (e: ClientEvent) => void }) {
  // Nova.app owns the voice: previewing here, in a plain browser window with no bridge to it, would
  // play "Hi, I'm Nova" out loud where its microphone - listening with no reason to expect its own
  // voice from somewhere else - could hear it and answer itself. Inside the app, the bridge sends the
  // preview to ask for itself instead, so it plays through the app's own echo-cancelled engine.
  const appVoice = useVoiceOwner();
  const blocked = !inApp && appVoice;
  const preview = () => (inApp ? tellApp({ type: 'preview', voice: value }) : onAction({ type: 'voice-preview', id: previewVoice(), voice: value }));
  return (
    <span className="setting__inline">
      <select className="setting__input" value={value} onChange={(e) => onSave(e.target.value)}>
        {field.options!.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn btn--ghost"
        disabled={!installed || blocked}
        title={blocked ? "Nova.app is listening on this Mac - open its own window to preview a voice" : undefined}
        onClick={preview}
      >
        Preview
      </button>
    </span>
  );
}

function Control({
  field,
  snapshot,
  name,
  onSave,
  onAction,
}: {
  field: SettingField;
  snapshot: SettingsSnapshot;
  name: string;
  onSave: (v: SettingValue | null) => void;
  onAction: (e: ClientEvent) => void;
}) {
  const value = snapshot.values[field.key] ?? field.default;
  // Clearing a text field resets it to its default.
  const saveText = (v: string) => onSave(v === '' ? null : v);
  switch (field.type) {
    case 'toggle':
      return <Switch label={field.label} on={value === true} onChange={onSave} />;
    case 'number':
      return <NumberInput value={Number(value)} unit={field.unit} min={field.min} max={field.max} step={field.step} onSave={onSave} />;
    case 'list':
      return <ListInput value={Array.isArray(value) ? value : []} onSave={(v) => onSave(v.length ? v : null)} />;
    case 'select':
      return (
        <select className="setting__input" value={String(value)} onChange={(e) => onSave(e.target.value)}>
          {field.options!.map((o) => (
            <option key={o.value} value={o.value}>
              {personalize(o.label, name)}
            </option>
          ))}
        </select>
      );
    case 'kokoro-voice':
      return <KokoroVoiceSelect field={field} value={String(value)} installed={snapshot.voice.installed} onSave={saveText} onAction={onAction} />;
    case 'language':
      return (
        <select className="setting__input" value={String(value)} onChange={(e) => onSave(e.target.value)}>
          {!LANGUAGES.some(([code]) => code === value) && <option value={String(value)}>{String(value)}</option>}
          {LANGUAGES.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      );
    case 'model':
      return <TextInput mono value={String(value)} placeholder={field.placeholder} list="nova-models" onSave={saveText} />;
    case 'shortcut':
      return <ShortcutInput value={String(value)} onSave={saveText} />;
    case 'time':
      return <input type="time" className="setting__input" value={String(value)} onChange={(e) => e.target.value && onSave(e.target.value)} />;
    default:
      return <TextInput mono={field.type === 'path'} value={String(value)} placeholder={field.placeholder} onSave={saveText} />;
  }
}

function FieldRow({ field, snapshot, name, onSave, onAction }: { field: SettingField; snapshot: SettingsSnapshot; name: string; onSave: Save; onAction: (e: ClientEvent) => void }) {
  const save = (v: SettingValue | null) => onSave({ [field.key]: v });
  return (
    <div className="setting">
      <div className="setting__text">
        <div className="setting__label">{personalize(field.label, name)}</div>
        {field.help && <div className="setting__help">{personalize(field.help, name)}</div>}
      </div>
      <div className="setting__control">
        <Control field={field} snapshot={snapshot} name={name} onSave={save} onAction={onAction} />
        <Reset saved={Boolean(snapshot.saved[field.key])} onReset={() => save(null)} />
      </div>
    </div>
  );
}

const visible = (f: SettingField, snapshot: SettingsSnapshot) => !f.when || f.when.is.includes(snapshot.values[f.when.key] as SettingValue);

function SectionBody({
  section,
  snapshot,
  name,
  onSave,
  onAction,
  result,
  screenPreview,
  onNavigate,
  onWalkthrough,
}: {
  section: SettingsSection;
  snapshot: SettingsSnapshot;
  name: string;
  onSave: Save;
  onAction: (e: ClientEvent) => void;
  result: SettingsProps['result'];
  screenPreview: SettingsProps['screenPreview'];
  onNavigate: (section: SettingsSection) => void;
  onWalkthrough?: () => void;
}) {
  const fields = FIELDS.filter((f) => f.section === section && visible(f, snapshot));
  return (
    <>
      {section === 'setup' && <SetupPanel snapshot={snapshot} name={name} onAction={onAction} onNavigate={onNavigate} onWalkthrough={onWalkthrough} />}
      {section === 'privacy' && <PrivacyPanel snapshot={snapshot} name={name} onSave={onSave} onNavigate={onNavigate} />}
      {section === 'voice' && <VoicePanel snapshot={snapshot} name={name} result={result} onAction={onAction} />}
      {section === 'voice' && <VoiceIdPanel snapshot={snapshot} name={name} result={result} onAction={onAction} />}
      {section === 'hearing' && <HearingPanel snapshot={snapshot} name={name} result={result} onAction={onAction} />}
      {section === 'presence' && <PresencePanel snapshot={snapshot} name={name} onAction={onAction} />}
      {section === 'initiative' && <InitiativePanel snapshot={snapshot} name={name} onSave={onSave} onAction={onAction} />}
      {section === 'appearance' && <OrbPreview snapshot={snapshot} />}
      {section === 'decisions' && <ReflexPanel snapshot={snapshot} name={name} result={result} onAction={onAction} />}
      {section === 'decisions' && snapshot.values['decisions.engine'] === 'jev' && <JevPanel snapshot={snapshot} />}
      {section === 'integrations' && <IntegrationsPanel snapshot={snapshot} name={name} onSave={onSave} onAction={onAction} />}
      {section === 'memory' && <MemoryPanel snapshot={snapshot} name={name} onAction={onAction} />}
      {section === 'screen' && <ScreenPanel snapshot={snapshot} name={name} onAction={onAction} preview={screenPreview} />}
      {section === 'hands' && <HandsPanel snapshot={snapshot} name={name} onSave={onSave} onAction={onAction} />}
      {section === 'models' && <ServersPanel snapshot={snapshot} onSave={onSave} />}
      {section === 'agents' && <AgentsPanel snapshot={snapshot} onSave={onSave} />}
      {fields.length > 0 && (
        <div className="settings__group">
          {fields.map((f) => (
            <FieldRow key={f.key} field={f} snapshot={snapshot} name={name} onSave={onSave} onAction={onAction} />
          ))}
        </div>
      )}
      {section === 'projects' && <ProjectsPanel snapshot={snapshot} onSave={onSave} />}
      {section === 'system' && <SystemPanel snapshot={snapshot} />}
    </>
  );
}

/** Model ids to suggest wherever a model is picked: paired agents and every model the local servers offer. */
function ModelSuggestions({ snapshot }: { snapshot: SettingsSnapshot }) {
  return (
    <datalist id="nova-models">
      {snapshot.agents
        .filter((a) => a.path)
        .map((a) => (
          <option key={a.name} value={a.name}>{`${a.label} (agent)`}</option>
        ))}
      {snapshot.servers.flatMap((s) =>
        s.models.map((m) => <option key={`${s.name}/${m}`} value={`${s.name}/${m}`}>{`${s.name} (local)`}</option>),
      )}
    </datalist>
  );
}

export interface SettingsProps {
  /** The assistant's current name, swapped into the text. */
  name: string;
  snapshot: SettingsSnapshot | null;
  result: { ok: boolean; message: string; at: number } | null;
  /** What Nova Eyes reported when the Screen section asked. */
  screenPreview: { text: string; at: number } | null;
  onSave: Save;
  /** Actions beyond saving: install a model, forget what Reflex learned, preview a voice. */
  onAction: (event: ClientEvent) => void;
  onClose: () => void;
  /** The section to open on (the walkthrough sends people to one). */
  initialSection?: SettingsSection;
  /** Run the first-run walkthrough again. */
  onWalkthrough?: () => void;
}

/** A macOS-style settings window: every setting Nova has, applied live. */
export function Settings({ name, snapshot, result, screenPreview, onSave, onAction, onClose, initialSection, onWalkthrough }: SettingsProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection ?? 'general');
  useEffect(() => void (initialSection && setSection(initialSection)), [initialSection]);
  const [toast, setToast] = useState<SettingsProps['result']>(null);
  const meta = SECTIONS.find((s) => s.id === section)!;

  useEffect(() => {
    if (!result) return;
    setToast(result);
    const t = setTimeout(() => setToast(null), result.ok ? 1800 : 6000);
    return () => clearTimeout(t);
  }, [result]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <motion.div className="scrim scrim--center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        className="glass settings"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.96, y: 14 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 14 }}
        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      >
        <nav className="settings__nav">
          <div className="settings__brand">
            <img src="/nova.svg" alt="" />
            Settings
          </div>
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className={`settings__navitem ${s.id === section ? 'is-active' : ''}`} onClick={() => setSection(s.id)}>
              <span className="settings__navicon">{s.icon}</span>
              {s.label}
              {s.id === 'setup' && snapshot && snapshot.setup.steps.some((step) => !step.done && !step.optional) && <span className="settings__navbadge" aria-label="Something to set up" />}
            </button>
          ))}
        </nav>
        <section className="settings__pane">
          <header className="settings__header">
            <div>
              <h2>{meta.label}</h2>
              <p>{personalize(meta.blurb, name)}</p>
            </div>
            <button type="button" className="settings__close" onClick={onClose} aria-label="Close settings">
              ×
            </button>
          </header>
          <div className="settings__body">
            {snapshot && snapshot.problems.length > 0 && (
              <div className="banner banner--error">
                <strong>Some settings in the settings file can't be used, so Nova uses their defaults:</strong>
                <ul>
                  {snapshot.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            )}
            {snapshot ? (
              <SectionBody
                section={section}
                snapshot={snapshot}
                name={name}
                onSave={onSave}
                onAction={onAction}
                result={result}
                screenPreview={screenPreview}
                onNavigate={setSection}
                onWalkthrough={onWalkthrough}
              />
            ) : (
              <p className="muted">Loading settings…</p>
            )}
          </div>
          {snapshot && <ModelSuggestions snapshot={snapshot} />}
          <AnimatePresence>
            {toast && (
              <motion.div
                key={toast.at}
                className={`settings__toast ${toast.ok ? '' : 'is-error'}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
              >
                {toast.ok ? `✓ ${toast.message}` : toast.message}
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      </motion.div>
    </motion.div>
  );
}
