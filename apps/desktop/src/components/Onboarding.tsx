import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import type { ClientEvent } from '@nova/core/protocol';
import { FIELDS, personalize, type SettingsSection, type SettingsSnapshot, type SetupStep } from '@nova/core/settings';
import { KokoroVoiceSelect } from './Settings';
import { TextInput, type Save } from './settings/Controls';
import { StepFix } from './settings/Trust';

/** The walkthrough's pages: most are a setup step, shown live as it gets done. */
const PAGES: { id: string; title: string; steps: string[]; blurb: string }[] = [
  { id: 'welcome', title: 'Hi, I’m Nova', steps: ['voice'], blurb: 'Your assistant on this Mac. You talk; Nova does - apps, reminders, your agents - and asks before anything risky. First, what should it be called, and how should it sound?' },
  { id: 'hearing', title: 'Can you hear me?', steps: ['hearing'], blurb: 'Say something - what Nova hears shows up below. It hears on this Mac, and only acts after its name or the shortcut.' },
  { id: 'reflex', title: 'Reflex', steps: ['reflex'], blurb: 'Nova’s own model decides what each thing you say means, on this Mac, in about a millisecond - and learns from you as you go.' },
  { id: 'agents', title: 'Your agents', steps: ['agents', 'answers'], blurb: 'Nova hands questions and project work to the agents you already use - Claude Code, Codex, OpenCode, Gemini - each signed in with your own account.' },
  { id: 'projects', title: 'Your projects', steps: ['projects'], blurb: 'Agents only ever work in these folders - never a path from speech. In a git project, Nova snapshots it first, so “undo that” puts back what an agent changed.' },
  { id: 'app', title: 'Nova in the menu bar', steps: ['app', 'permissions'], blurb: 'Nova.app listens with echo cancellation, shows the orb, has the shortcut, and opens at login. macOS asks you before it may use each thing.' },
  { id: 'privacy', title: 'What stays on this Mac', steps: [], blurb: 'Almost everything. Here is what goes anywhere, and where - each has a switch in Settings → Privacy & trust.' },
  { id: 'try', title: 'Things to try', steps: [], blurb: 'Say Nova’s name first, or press the shortcut.' },
];

const TRY: [string, string][] = [
  ['open Slack', 'apps, by name'],
  ['remind me to call mum at 5', 'reminders - repeating ones too'],
  ['brief me', 'your day: calendar, weather, reminders, agents'],
  ['ask Claude to fix the failing test in Agentic_OS', 'an agent works; you approve each step out loud'],
  ['yes, always', 'to one of Nova’s questions: it won’t ask about exactly that again'],
  ['undo that', 'takes back the last thing - even an agent’s file changes'],
  ['what did you do today?', 'the record of actions, with who asked'],
  ['stop everything', 'or ⌃⌥⌘. - halts agents, questions and speech, and mutes'],
];

export interface OnboardingProps {
  name: string;
  snapshot: SettingsSnapshot;
  /** What Nova heard just now, for the hearing check. */
  heard: string;
  shortcut?: string;
  onSave: Save;
  onAction: (e: ClientEvent) => void;
  /** Open Settings at a section (and leave the walkthrough). */
  onOpenSettings: (section: SettingsSection) => void;
  onClose: () => void;
}

/** The first-run walkthrough: the same steps as Settings → Setup, one page at a time. */
export function Onboarding({ name, snapshot, heard, shortcut, onSave, onAction, onOpenSettings, onClose }: OnboardingProps) {
  const [page, setPage] = useState(0);
  const current = PAGES[page]!;
  const steps = current.steps.map((id) => snapshot.setup.steps.find((s) => s.id === id)).filter((s): s is SetupStep => Boolean(s));
  const last = page === PAGES.length - 1;
  const finish = () => {
    onAction({ type: 'setup-done' });
    onClose();
  };
  const go = (section: SettingsSection) => {
    onAction({ type: 'setup-done' });
    onOpenSettings(section);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && finish();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <motion.div className="scrim scrim--center scrim--welcome" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div
        className="glass welcome"
        role="dialog"
        aria-label={`Setting up ${name}`}
        initial={{ opacity: 0, scale: 0.96, y: 14 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 14 }}
        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      >
        <div className="welcome__dots" aria-hidden>
          {PAGES.map((p, i) => (
            <button key={p.id} type="button" className={`welcome__dot ${i === page ? 'is-on' : ''}`} onClick={() => setPage(i)} />
          ))}
        </div>
        <AnimatePresence mode="wait">
          <motion.div key={current.id} className="welcome__page" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.18 }}>
            <h2>{personalize(current.title, name)}</h2>
            <p className="welcome__blurb">{personalize(current.blurb, name)}</p>

            {current.id === 'welcome' && (
              <div className="setting">
                <div className="setting__text">
                  <div className="setting__label">Name</div>
                  <div className="setting__help">What it's called and answers to - "hey {name.toLowerCase()}", or the name alone.</div>
                </div>
                <div className="setting__control">
                  <TextInput value={name} onSave={(v) => onSave({ name: v || null })} />
                </div>
              </div>
            )}
            {current.id === 'welcome' && snapshot.voice.installed && (
              <div className="setting">
                <div className="setting__text">
                  <div className="setting__label">Voice</div>
                  <div className="setting__help">Kokoro's voices, all on this Mac. Press Preview to hear one.</div>
                </div>
                <div className="setting__control">
                  <KokoroVoiceSelect
                    field={FIELDS.find((f) => f.key === 'voice.kokoroVoice')!}
                    value={String(snapshot.values['voice.kokoroVoice'] ?? 'af_heart')}
                    installed
                    onSave={(v) => onSave({ 'voice.kokoroVoice': v })}
                    onAction={onAction}
                  />
                </div>
              </div>
            )}

            {current.id === 'hearing' && <div className="welcome__heard">{heard ? `“${heard}”` : shortcut ? `Say “hey ${name.toLowerCase()}, what time is it?” - or press ${shortcut}` : `Say “hey ${name.toLowerCase()}, what time is it?”`}</div>}

            {steps.map((step) => (
              <div key={step.id} className="setup__step">
                <span className={`dot ${step.done ? 'dot--on' : step.optional ? '' : 'dot--warn'}`} />
                <div className="setup__text">
                  <strong>{personalize(step.label, name)}</strong>
                  <span className="muted">{personalize(step.detail, name)}</span>
                </div>
                <StepFix step={step} onAction={onAction} onNavigate={go} />
              </div>
            ))}

            {current.id === 'app' && snapshot.presence.app && (
              <div className="chips">
                {snapshot.presence.app.access?.notifications === 'undetermined' && (
                  <button type="button" className="chip chip--button" onClick={() => onAction({ type: 'shell-action', action: 'request-notifications' })}>
                    Allow notifications
                  </button>
                )}
                {snapshot.presence.app.access?.calendar === 'undetermined' && (
                  <button type="button" className="chip chip--button" onClick={() => onAction({ type: 'shell-action', action: 'request-calendar' })}>
                    Allow the calendar
                  </button>
                )}
                {snapshot.presence.app.access?.reminders === 'undetermined' && (
                  <button type="button" className="chip chip--button" onClick={() => onAction({ type: 'shell-action', action: 'request-reminders' })}>
                    Allow Reminders
                  </button>
                )}
              </div>
            )}

            {current.id === 'privacy' && (
              <ul className="welcome__list">
                {snapshot.privacy
                  .filter((f) => f.leaves && f.on)
                  .map((f) => (
                    <li key={f.id}>
                      <strong>{personalize(f.what, name)}</strong>
                      <span className="muted"> → {f.where}</span>
                    </li>
                  ))}
                <li>
                  <strong>Everything else</strong>
                  <span className="muted"> → this Mac: memories, conversations, reminders, the record of actions</span>
                </li>
              </ul>
            )}

            {current.id === 'try' && (
              <ul className="welcome__list">
                {TRY.map(([said, what]) => (
                  <li key={said}>
                    <strong>“{personalize(said, name)}”</strong>
                    <span className="muted"> - {personalize(what, name)}</span>
                  </li>
                ))}
              </ul>
            )}
          </motion.div>
        </AnimatePresence>
        <footer className="welcome__footer">
          <button type="button" className="link" onClick={finish}>
            {last ? '' : 'Skip'}
          </button>
          <span className="welcome__nav">
            {page > 0 && (
              <button type="button" className="btn btn--ghost" onClick={() => setPage(page - 1)}>
                Back
              </button>
            )}
            {current.id === 'privacy' && (
              <button type="button" className="btn btn--ghost" onClick={() => go('privacy')}>
                Privacy & trust
              </button>
            )}
            <button type="button" className="btn btn--primary" onClick={() => (last ? finish() : setPage(page + 1))}>
              {last ? `Start using ${name}` : 'Next'}
            </button>
          </span>
        </footer>
      </motion.div>
    </motion.div>
  );
}
