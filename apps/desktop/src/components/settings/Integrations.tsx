import { useState } from 'react';
import type { ClientEvent } from '@nova/core/protocol';
import {
  INTEGRATION_PRESETS,
  integrationName,
  personalize,
  type AskPolicy,
  type IntegrationEntry,
  type IntegrationPreset,
  type SettingsSnapshot,
  type ToolPolicy,
} from '@nova/core/settings';
import { Info, SecretStatus, type Save } from './Controls';

type Props = { snapshot: SettingsSnapshot; name: string; onSave: Save; onAction: (event: ClientEvent) => void };
type Status = SettingsSnapshot['integrations'][number];

const ASK: { value: AskPolicy; label: string }[] = [
  { value: 'always', label: 'Before every action' },
  { value: 'changes', label: 'Only before changes' },
  { value: 'never', label: 'Never' },
];
const TOOL: { value: ToolPolicy; label: string }[] = [
  { value: 'allow', label: 'Allow' },
  { value: 'ask', label: 'Ask first' },
  { value: 'block', label: 'Block' },
];

const STATE_TEXT: Record<Status['state'], string> = {
  connected: 'connected',
  connecting: 'connecting…',
  'sign-in': 'needs you to sign in',
  error: "can't connect",
  off: 'switched off',
};

/** Services Nova's brains can use through Nova: connections, sign-in, and when Nova asks first. */
export function IntegrationsPanel({ snapshot, name, onSave, onAction }: Props) {
  const entries = (snapshot.values['integrations.servers'] ?? {}) as Record<string, IntegrationEntry>;
  const save = (key: string, entry: IntegrationEntry | null) => onSave({ [`integrations.servers.${key}`]: entry as never });
  const added = new Set(Object.keys(entries));
  const [justAdded, setJustAdded] = useState<IntegrationPreset | null>(null);

  const addPreset = (p: IntegrationPreset) => {
    let key = p.id;
    for (let i = 2; added.has(key); i++) key = `${p.id}-${i}`;
    save(key, { url: p.url, label: p.label, ...(p.token ? { headers: { [p.token.header]: p.token.template } } : {}) });
    setJustAdded(p.token ? p : null);
  };

  return (
    <div className="integrations">
      {snapshot.integrations.map((s) => (
        <Integration key={s.name} status={s} entry={entries[s.name] ?? {}} save={(e) => save(s.name, e)} onAction={onAction} />
      ))}
      {justAdded?.token && (
        <div className="tile">
          <strong>One more step for {justAdded.label}</strong>
          <span className="muted">
            {justAdded.token.help} Add it to Nova's .env as <code>{justAdded.token.variable}=…</code>, then press Retry on {justAdded.label}. The token stays in
            .env; the settings only name it.
          </span>
        </div>
      )}
      <div className="tile tile--add">
        <div className="tile__head">
          <strong>Add a service</strong>
          <Info label="Add a service" text={personalize('Every brain - your paired agents and models alike - can use it through Nova. Services with "sign in" open your browser; you sign in yourself, and Nova keeps only the access it was given.', name)} />
        </div>
        <div className="preset-grid">
          {INTEGRATION_PRESETS.map((p) => {
            const has = Object.values(entries).some((e) => e.url === p.url);
            return (
              <button key={p.id} type="button" className="preset" disabled={has} onClick={() => addPreset(p)} title={p.description}>
                <strong>{p.label}</strong>
                <span className="muted">{has ? 'added' : p.auth === 'oauth' ? 'sign in' : p.auth === 'token' ? 'your token' : 'no sign-in'}</span>
              </button>
            );
          })}
        </div>
        <CustomForm taken={added} onAdd={(key, entry) => save(key, entry)} />
      </div>
    </div>
  );
}

function Integration({ status: s, entry, save, onAction }: { status: Status; entry: IntegrationEntry; save: (e: IntegrationEntry | null) => void; onAction: (e: ClientEvent) => void }) {
  const [open, setOpen] = useState(false);
  const on = entry.enabled !== false;
  const setTool = (tool: string, policy: ToolPolicy | null) => {
    const tools = { ...(entry.tools ?? {}) };
    if (policy) tools[tool] = policy;
    else delete tools[tool];
    save({ ...entry, tools: Object.keys(tools).length ? tools : undefined });
  };
  const allowed = s.tools.filter((t) => t.policy === 'allow').length;
  const blocked = s.tools.filter((t) => t.policy === 'block').length;
  return (
    <div className="tile">
      <div className="tile__head">
        <span className={`dot ${s.state === 'connected' ? 'dot--on' : ''}`} />
        <strong>{s.label}</strong>
        <span className="muted">
          {STATE_TEXT[s.state]}
          {s.state === 'connected' ? ` · ${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}` : ''}
        </span>
        <span className="tile__actions">
          {s.state === 'sign-in' && (
            <button type="button" className="btn btn--ghost" onClick={() => onAction({ type: 'integration-sign-in', name: s.name })}>
              Sign in
            </button>
          )}
          {s.state === 'error' && (
            <button type="button" className="btn btn--ghost" onClick={() => onAction({ type: 'integration-retry', name: s.name })}>
              Retry
            </button>
          )}
          {s.signedIn && (
            <button type="button" className="link" onClick={() => onAction({ type: 'integration-sign-out', name: s.name })}>
              Sign out
            </button>
          )}
          <button type="button" className="link" onClick={() => save({ ...entry, enabled: on ? false : undefined })}>
            {on ? 'Turn off' : 'Turn on'}
          </button>
          <button type="button" className="link" onClick={() => save(null)}>
            Remove
          </button>
        </span>
      </div>
      {s.message && s.state !== 'connected' && <span className="muted">{s.message}</span>}
      <span className="muted is-mono">{s.where}</span>
      {s.secrets.length > 0 && (
        <div className="chips">
          {s.secrets.map((secret) => (
            <SecretStatus key={secret.name} name={secret.name} set={secret.set} />
          ))}
        </div>
      )}
      <div className="tile__grid">
        <label title="Nova says what the action is and waits for your yes. Your choices for single tools come first.">Ask me</label>
        <select className="setting__input" value={s.ask} onChange={(e) => save({ ...entry, ask: e.target.value === 'always' ? undefined : (e.target.value as AskPolicy) })}>
          {ASK.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {s.ask === 'changes' && <span className="muted">"Changes" counts every tool the service doesn't itself label read-only.</span>}
      {s.tools.length > 0 && (
        <details className="tools" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
          <summary>
            {s.tools.length} tools · {allowed} run without asking{blocked ? ` · ${blocked} blocked` : ''}
          </summary>
          {s.tools.map((t) => (
            <div className="tool-row" key={t.name}>
              <div>
                <span className="is-mono">{t.title || t.name}</span>
                {t.readOnly && <span className="chip">read-only</span>}
                {t.description && <div className="muted">{t.description}</div>}
              </div>
              <select className="setting__input" value={t.policy} onChange={(e) => setTool(t.name, e.target.value as ToolPolicy)}>
                {TOOL.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {t.chosen ? (
                <button type="button" className="link" title="Follow the service's rule again" onClick={() => setTool(t.name, null)}>
                  Reset
                </button>
              ) : (
                <span />
              )}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

/** A service that isn't a preset: a hosted address, or a command that starts one on this Mac. */
function CustomForm({ taken, onAdd }: { taken: Set<string>; onAdd: (key: string, entry: IntegrationEntry) => void }) {
  const [label, setLabel] = useState('');
  const [where, setWhere] = useState('');
  const [secret, setSecret] = useState('');
  const key = integrationName(label);
  const hosted = /^https?:\/\//.test(where.trim());
  const valid = label.trim() && where.trim() && !taken.has(key);
  const submit = () => {
    if (!valid) return;
    const extra = secret.trim();
    if (hosted) onAdd(key, { url: where.trim(), label: label.trim(), ...(extra ? { headers: { Authorization: extra } } : {}) });
    else {
      const [command, ...args] = where.trim().split(/\s+/);
      const env = Object.fromEntries(
        extra
          .split(/\s+/)
          .filter((pair) => pair.includes('='))
          .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
      );
      onAdd(key, { command: command!, args, label: label.trim(), ...(Object.keys(env).length ? { env } : {}) });
    }
    setLabel('');
    setWhere('');
    setSecret('');
  };
  return (
    <form
      className="tile__grid"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label>Name</label>
      <input className="setting__input" placeholder="e.g. My tracker" value={label} onChange={(e) => setLabel(e.target.value)} />
      <label title="An https:// address for a hosted server, or the command that starts a local one">Address or command</label>
      <input className="setting__input is-mono" placeholder="https://mcp.example.com/mcp  or  npx -y some-mcp-server" value={where} onChange={(e) => setWhere(e.target.value)} />
      <label title={hosted ? 'An Authorization header, e.g. Bearer ${NOVA_TRACKER_TOKEN}' : 'Environment, e.g. API_KEY=${NOVA_TRACKER_KEY}'}>{hosted ? 'Authorization' : 'Environment'}</label>
      <input
        className="setting__input is-mono"
        placeholder={hosted ? 'optional: Bearer ${NOVA_TRACKER_TOKEN}' : 'optional: API_KEY=${NOVA_TRACKER_KEY}'}
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
      />
      <span />
      <button className="btn btn--ghost" type="submit" disabled={!valid}>
        Add
      </button>
    </form>
  );
}
