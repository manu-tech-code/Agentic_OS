import type { ClientEvent } from '@nova/core/protocol';
import { personalize, SECTIONS, type PrivacyFlow, type SettingsSection, type SettingsSnapshot, type SetupStep } from '@nova/core/settings';
import { Switch, type Save } from './Controls';

const sectionLabel = (id: SettingsSection) => SECTIONS.find((s) => s.id === id)?.label ?? id;

/** What fixes a setup step: a download, a command to run, or the Settings section where it's chosen. */
export function StepFix({ step, onAction, onNavigate }: { step: SetupStep; onAction: (e: ClientEvent) => void; onNavigate?: (section: SettingsSection) => void }) {
  const fix = step.fix;
  if (!fix) return null;
  const install = fix.install;
  return (
    <span className="setup__fix">
      {install && !step.done && (
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() =>
            onAction(install === 'reflex' ? { type: 'reflex-install' } : { type: 'hearing-install', model: install })
          }
        >
          Download
        </button>
      )}
      {fix.command && !step.done && (
        <span className="setup__command">
          <code className="cmd-snippet">{fix.command}</code>
          <button type="button" className="link" onClick={() => void navigator.clipboard?.writeText(fix.command!)}>
            Copy
          </button>
        </span>
      )}
      {fix.section && onNavigate && (
        <button type="button" className="link" onClick={() => onNavigate(fix.section!)}>
          {sectionLabel(fix.section)} →
        </button>
      )}
    </span>
  );
}

/** Settings → Setup: each thing Nova needs, whether it's there, and the fix - or the walkthrough again. */
export function SetupPanel({
  snapshot,
  name,
  onAction,
  onNavigate,
  onWalkthrough,
}: {
  snapshot: SettingsSnapshot;
  name: string;
  onAction: (e: ClientEvent) => void;
  onNavigate: (section: SettingsSection) => void;
  onWalkthrough?: () => void;
}) {
  const steps = snapshot.setup.steps;
  const needed = steps.filter((s) => !s.optional);
  const done = needed.filter((s) => s.done).length;
  return (
    <div className="integrations">
      <div className="tile">
        <div className="tile__head">
          <strong>{done === needed.length ? `${name} is set up` : `${done} of ${needed.length} set up`}</strong>
          {onWalkthrough && (
            <button type="button" className="btn btn--ghost tile__action" onClick={onWalkthrough}>
              Run the walkthrough again
            </button>
          )}
        </div>
        <div className="setup__bar" aria-hidden>
          <span style={{ width: `${needed.length ? (done / needed.length) * 100 : 100}%` }} />
        </div>
      </div>
      <div className="tile">
        {steps.map((step) => (
          <div key={step.id} className="setup__step">
            <span className={`dot ${step.done ? 'dot--on' : step.optional ? '' : 'dot--warn'}`} />
            <div className="setup__text">
              <strong>
                {personalize(step.label, name)}
                {step.optional && !step.done && <span className="chip chip--tiny">optional</span>}
              </strong>
              <span className="muted">{personalize(step.detail, name)}</span>
            </div>
            <StepFix step={step} onAction={onAction} onNavigate={onNavigate} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A flow's switch shows the setting itself (a flow can be off for another reason, like no brain). */
function switchedOn(flow: PrivacyFlow, snapshot: SettingsSnapshot) {
  const t = flow.toggle!;
  return t.on === true && t.off === false ? snapshot.values[t.key] === true : flow.on;
}

function FlowRow({ flow, snapshot, name, onSave, onNavigate }: { flow: PrivacyFlow; snapshot: SettingsSnapshot; name: string; onSave: Save; onNavigate: (s: SettingsSection) => void }) {
  return (
    <div className={`privacy__flow ${flow.on ? '' : 'is-off'}`}>
      <div className="privacy__text">
        <div>{personalize(flow.what, name)}</div>
        <div className="muted">
          → {flow.where}
          {!flow.on && ' · off'}
        </div>
        {flow.detail && <div className="muted privacy__detail">{personalize(flow.detail, name)}</div>}
      </div>
      {flow.toggle ? (
        <Switch label={flow.what} on={switchedOn(flow, snapshot)} onChange={(on) => onSave({ [flow.toggle!.key]: on ? flow.toggle!.on : flow.toggle!.off })} />
      ) : flow.section ? (
        <button type="button" className="link" onClick={() => onNavigate(flow.section!)}>
          {sectionLabel(flow.section)} →
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

/** Settings → Privacy & trust: what leaves this Mac and where to, what Nova may do without asking, and the record. */
export function PrivacyPanel({
  snapshot,
  name,
  onSave,
  onNavigate,
}: {
  snapshot: SettingsSnapshot;
  name: string;
  onSave: Save;
  onNavigate: (section: SettingsSection) => void;
}) {
  const leaving = snapshot.privacy.filter((f) => f.leaves);
  const staying = snapshot.privacy.filter((f) => !f.leaves);
  const { rules, activity } = snapshot.trust;
  return (
    <div className="integrations">
      <div className="tile">
        <div className="tile__head">
          <strong>What leaves this Mac</strong>
          <span className="muted">{leaving.filter((f) => f.on).length} of {leaving.length} on</span>
        </div>
        {leaving.map((f) => (
          <FlowRow key={f.id} flow={f} snapshot={snapshot} name={name} onSave={onSave} onNavigate={onNavigate} />
        ))}
      </div>

      <div className="tile">
        <div className="tile__head">
          <strong>What stays on this Mac</strong>
        </div>
        {staying.map((f) => (
          <FlowRow key={f.id} flow={f} snapshot={snapshot} name={name} onSave={onSave} onNavigate={onNavigate} />
        ))}
      </div>

      <div className="tile">
        <div className="tile__head">
          <strong>What {name} may do without asking</strong>
          <span className="muted">{rules.length ? `${rules.length}` : ''}</span>
        </div>
        {rules.length === 0 ? (
          <span className="muted">
            {personalize(
              'Nothing: Nova asks first. When it does, "yes, always" (or "yes, for today") remembers exactly that one thing - quitting Spotify, Claude running npm test in one project - and never deleting things or risky commands.',
              name,
            )}
          </span>
        ) : (
          rules.map((r) => (
            <div key={r.id} className="tool-row memory-row">
              <div>
                <div>{r.label}</div>
                <div className="muted">{r.until ? 'For today only' : 'From now on'}</div>
              </div>
              <button type="button" className="link" onClick={() => onSave({ [`trust.rules.${r.id}`]: null })}>
                Revoke
              </button>
            </div>
          ))
        )}
      </div>

      <div className="tile">
        <div className="tile__head">
          <strong>The record of actions</strong>
          <span className="muted">
            {activity.kept} {activity.kept === 1 ? 'action' : 'actions'} · kept {activity.days} days
          </span>
        </div>
        <span className="muted">
          {personalize(
            'Everything Nova did, who asked, and whether it can be undone - in the Activity panel (⌘J), or ask "what did you do today?", "what did Claude change?", "undo that". "Stop everything" (or ⌃⌥⌘.) halts it all at once.',
            name,
          )}
        </span>
      </div>
    </div>
  );
}
