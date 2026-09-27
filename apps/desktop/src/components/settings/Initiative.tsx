import { useState } from 'react';
import type { ClientEvent } from '@nova/core/protocol';
import { personalize, type Access, type SettingsSnapshot } from '@nova/core/settings';
import { describeWhen, onDay } from '@nova/core/when';
import type { Save } from './Controls';

type Props = { snapshot: SettingsSnapshot; name: string; onSave: Save; onAction: (event: ClientEvent) => void };

const ACCESS: Record<Access, string> = { granted: 'allowed', denied: 'turned off in System Settings', undetermined: 'not asked yet', restricted: 'not allowed on this Mac' };

/** Reminders to come, routines, what Nova can reach, and the project the user is on. */
export function InitiativePanel({ snapshot, name, onSave, onAction }: Props) {
  const { reminders, routines, project, weather } = snapshot.initiative;
  const app = snapshot.presence.app;
  const now = new Date();
  const act = (action: Extract<ClientEvent, { type: 'shell-action' }>['action']) => onAction({ type: 'shell-action', action });
  const reach = (label: string, access: Access | undefined, ask: 'request-calendar' | 'request-reminders' | 'request-notifications', why: string) => (
    <div className="tile__head">
      <span className={`dot ${access === 'granted' ? 'dot--on' : ''}`} />
      <strong>{label}</strong>
      <span className="muted">
        {access ? ACCESS[access] : 'unknown'} - {personalize(why, name)}
      </span>
      {access === 'undetermined' && (
        <span className="tile__actions">
          <button type="button" className="btn btn--ghost" onClick={() => act(ask)}>
            Allow
          </button>
        </span>
      )}
      {access === 'denied' && (
        <span className="tile__actions">
          <button type="button" className="link" onClick={() => act('open-privacy-settings')}>
            Open System Settings
          </button>
        </span>
      )}
    </div>
  );
  return (
    <div className="integrations">
      <div className="tile">
        <strong>What {name} can reach</strong>
        {app ? (
          <>
            {reach('Calendar', app.access?.calendar, 'request-calendar', 'for the briefing, and quiet during meetings')}
            {reach('Reminders app', app.access?.reminders, 'request-reminders', 'so reminders reach your iPhone')}
            {reach('Notifications', app.access?.notifications, 'request-notifications', 'reminders and news, even while Nova is quiet')}
          </>
        ) : (
          <span className="muted">{personalize('The calendar, the Reminders app and notifications come through Nova.app (Settings → Menu bar). Nova keeps and speaks its own reminders either way.', name)}</span>
        )}
        {app && (
          <span className="muted">
            Right now: {snapshot.initiative.moment.call ? 'on a call or in a meeting' : snapshot.initiative.moment.away ? 'away' : "you're here"}
            {snapshot.initiative.moment.waiting ? ` · ${snapshot.initiative.moment.waiting} waiting to be told` : ''}
          </span>
        )}
        {weather && <span className="muted">{weather.ok ? `Weather for ${weather.town}: found.` : `Weather: ${weather.message}`}</span>}
        {project && <span className="muted">Working on {project.name} ({project.source === 'said' ? 'you said so' : 'from the window you are in'}) - agents work there unless you name another project.</span>}
      </div>

      <div className="tile">
        <div className="tile__head">
          <strong>Coming up</strong>
          <span className="muted">{reminders.length ? `${reminders.length} ${reminders.length === 1 ? 'reminder' : 'reminders'}` : ''}</span>
        </div>
        {reminders.length === 0 ? (
          <span className="muted">{personalize('No reminders. Say "remind me to call mum at 5", "every weekday at 9 remind me to stand up" - or "add milk to my Reminders".', name)}</span>
        ) : (
          reminders.map((r) => (
            <div key={r.id} className="tool-row memory-row">
              <div>
                <div>{r.text || (r.countdown ? 'Timer' : 'Reminder')}</div>
                <div className="muted">
                  {r.due ? (r.schedule ? describeWhen({ at: new Date(r.due), schedule: r.schedule }, now) : onDay(new Date(r.due), now)) : 'no time'}
                  {r.apple ? ' · in the Reminders app' : ''}
                </div>
              </div>
              {!r.id.startsWith('apple-') && (
                <button type="button" className="link" onClick={() => onAction({ type: 'reminder-cancel', id: r.id })}>
                  Cancel
                </button>
              )}
            </div>
          ))
        )}
      </div>

      <div className="tile">
        <div className="tile__head">
          <strong>Routines</strong>
          <span className="muted">{personalize('Things Nova does when you say a phrase, or on a schedule', name)}</span>
        </div>
        {routines.map((r) => (
          <div key={r.name} className="tool-row memory-row">
            <div>
              <div>{r.phrase ? `When you say “${r.phrase}”` : r.schedule}</div>
              <div className="muted">{r.steps.join(' → ')}</div>
            </div>
            <button type="button" className="link" onClick={() => onSave({ [`routines.${r.name}`]: null })}>
              Delete
            </button>
          </div>
        ))}
        <NewRoutine onSave={onSave} />
      </div>
    </div>
  );
}

function NewRoutine({ onSave }: { onSave: Save }) {
  const [trigger, setTrigger] = useState('');
  const [steps, setSteps] = useState('');
  const scheduled = /^(?:every|each|on\s+weekdays|on\s+weekends|daily|weekly|monthly)\b/i.test(trigger.trim());
  const list = steps
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const save = () => {
    const name = trigger.trim().toLowerCase();
    if (!name || !list.length) return;
    onSave({ [`routines.${name}`]: scheduled ? { schedule: trigger.trim(), steps: list } : { phrase: name, steps: list } });
    setTrigger('');
    setSteps('');
  };
  return (
    <div className="routine-new">
      <input className="setting__input" placeholder='A phrase ("start work") or a schedule ("every weekday at 9")' value={trigger} onChange={(e) => setTrigger(e.target.value)} />
      <textarea className="setting__input" rows={3} placeholder={'One thing to do per line, as you would say it:\nopen Slack\nbrief me'} value={steps} onChange={(e) => setSteps(e.target.value)} />
      <button type="button" className="btn btn--ghost" disabled={!trigger.trim() || !list.length} onClick={save}>
        Add routine
      </button>
    </div>
  );
}
