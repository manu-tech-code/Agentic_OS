import { useEffect, useRef, useState } from 'react';
import type { ClientEvent, OrbPrefs, Phase } from '@nova/core/protocol';
import { isEntryName, personalize, type SettingsSnapshot } from '@nova/core/settings';
import { ParticleOrb } from '../ParticleOrb';
import { SecretStatus, Switch, TextInput, type Save } from './Controls';

type ServerEntry = { url?: string; structuredOutputs?: boolean };
type AgentEntry = { model?: string; args?: string | string[]; bin?: string };

/** Drops unset fields; an entry with nothing left is removed (null). */
function tidy<T extends object>(entry: T): T | null {
  const kept = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined && v !== ''));
  return Object.keys(kept).length ? (kept as T) : null;
}

const PREVIEW_PHASES: [Phase, string][] = [
  ['idle', 'Idle'],
  ['listening', 'Listening'],
  ['thinking', 'Thinking'],
  ['speaking', 'Speaking'],
];

/** A live Orb with the chosen colours and motion, in each of its moods. */
export function OrbPreview({ snapshot }: { snapshot: SettingsSnapshot }) {
  const [phase, setPhase] = useState<Phase>('speaking');
  const level = useRef(0);
  useEffect(() => {
    if (phase !== 'listening') return;
    // Stand-in for a voice: bursts of sound with pauses.
    const id = setInterval(() => {
      const t = performance.now() / 1000;
      level.current = Math.max(0, Math.sin(t * 9) * Math.sin(t * 1.3)) * 0.6;
    }, 30);
    return () => clearInterval(id);
  }, [phase]);
  const prefs: OrbPrefs = {
    style: 'particles',
    colors: snapshot.values['appearance.orbColors'] as OrbPrefs['colors'],
    motion: snapshot.values['appearance.orbMotion'] as OrbPrefs['motion'],
  };
  if (snapshot.values['appearance.orbStyle'] === 'glass') return null;
  return (
    <div className="tile orb-preview">
      <div className="orb-preview__stage">
        <ParticleOrb phase={phase} levelRef={level} prefs={prefs} small />
      </div>
      <div className="chips">
        {PREVIEW_PHASES.map(([p, label]) => (
          <button key={p} type="button" className={`chip chip--button ${p === phase ? 'chip--accent' : ''}`} onClick={() => setPhase(p)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

type ActionProps = {
  snapshot: SettingsSnapshot;
  name: string;
  result: { ok: boolean; at: number } | null;
  onAction: (event: ClientEvent) => void;
};

/** A button that waits for the daemon: busy until the snapshot changes, or a failure. */
function useBusy(done: unknown[], result: ActionProps['result']) {
  const [busy, setBusy] = useState(false);
  useEffect(() => setBusy(false), done); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (result && !result.ok) setBusy(false); // it failed; the toast says why
  }, [result]);
  return [busy, setBusy] as const;
}

/** Kokoro, the natural voice: installed or not. */
export function VoicePanel({ snapshot, name }: ActionProps) {
  const { voice } = snapshot;
  return (
    <div className="tile">
      <div className="tile__head">
        <span className={`dot ${voice.installed ? 'dot--on' : ''}`} />
        <strong>Kokoro</strong>
        <span className="muted">{voice.installed ? `${voice.label.split(' · ')[0]}${voice.bundled ? ' · built into Nova.app' : ''}` : 'comes with Nova.app'}</span>
      </div>
      <span className="muted">
        {voice.installed
          ? personalize("Nova's voice: close to a real person's, on this Mac - free, private, and quick to start talking.", name)
          : personalize("Nova's voice comes inside Nova.app. Install the app once - npm run app in the Nova folder - and Nova speaks; there's nothing else to download. Until then, replies are shown, not spoken.", name)}
      </span>
    </div>
  );
}

/** One downloadable model: installed, or a button that installs it. */
function ModelRow({ name, label, installed, size, busy, onInstall }: { name: string; label: string; installed: boolean; size: string; busy: boolean; onInstall: () => void }) {
  return (
    <div className="tile__head">
      <span className={`dot ${installed ? 'dot--on' : ''}`} />
      <strong>{name}</strong>
      <span className="muted">{installed ? label : 'not installed'}</span>
      {!installed && (
        <button type="button" className="btn btn--ghost tile__action" disabled={busy} onClick={onInstall}>
          {busy ? 'Installing…' : `Install · ${size}`}
        </button>
      )}
    </div>
  );
}

/** How Nova hears: the engine in use (and why, when the browser listens instead), and the models hearing can use. */
export function HearingPanel({ snapshot, name, result, onAction }: ActionProps) {
  const { status, parakeet, smartTurn } = snapshot.hearing;
  const [busyParakeet, setBusyParakeet] = useBusy([parakeet.installed], result);
  const [busyTurn, setBusyTurn] = useBusy([smartTurn.installed], result);
  const engine = status.engine === 'apple' ? "Apple's on-device recognizer" : status.engine === 'parakeet' ? 'Parakeet, on this Mac' : "The browser's speech recognition";
  const state = status.state === 'ready' ? 'hearing you' : status.state === 'starting' ? 'getting ready…' : "can't hear";
  return (
    <div className="tile">
      <div className="tile__head">
        <span className={`dot ${status.engine !== 'browser' && status.state === 'ready' ? 'dot--on' : ''}`} />
        <strong>{engine}</strong>
        <span className="muted">{state}</span>
      </div>
      {status.message && <span className="muted">{status.message}</span>}
      <ModelRow
        name="Parakeet"
        label={parakeet.label}
        installed={parakeet.installed}
        size="464 MB"
        busy={busyParakeet}
        onInstall={() => {
          setBusyParakeet(true);
          onAction({ type: 'hearing-install', model: 'parakeet' });
        }}
      />
      <ModelRow
        name="Smart Turn"
        label={smartTurn.label}
        installed={smartTurn.installed}
        size="9 MB"
        busy={busyTurn}
        onInstall={() => {
          setBusyTurn(true);
          onAction({ type: 'hearing-install', model: 'smart-turn' });
        }}
      />
      <span className="muted">
        {personalize(
          "On-device hearing turns what you say into text on this Mac - nothing you say leaves it - and lets you talk over Nova to stop it. Apple's recognizer needs no download. Parakeet is NVIDIA's open model, the most accurate in a noisy room. Smart Turn hears from your tone when you've finished a sentence.",
          name,
        )}
      </span>
    </div>
  );
}

/** Reflex, Nova's own decision model: installed or not, and what it has learned. */
export function ReflexPanel({ snapshot, name, result, onAction }: ActionProps) {
  const { reflex } = snapshot;
  const [busy, setBusy] = useBusy([reflex.installed, reflex.learned], result);
  return (
    <div className="tile">
      <div className="tile__head">
        <span className={`dot ${reflex.installed ? 'dot--on' : ''}`} />
        <strong>Reflex</strong>
        <span className="muted">
          {reflex.installed
            ? [
                reflex.label,
                reflex.trained ? `classifier trained on ${(reflex.phrasings ?? 0).toLocaleString()} phrasings` : 'training its classifier…',
                `learned ${reflex.learned} from you${reflex.taught ? ` (${reflex.taught} taught by the brain)` : ''}`,
              ].join(' · ')
            : 'not installed'}
        </span>
        {reflex.installed
          ? reflex.learned > 0 && (
              <button type="button" className="link tile__action" onClick={() => onAction({ type: 'reflex-forget' })}>
                Forget what it learned
              </button>
            )
          : (
              <button
                type="button"
                className="btn btn--ghost tile__action"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  onAction({ type: 'reflex-install' });
                }}
              >
                {busy ? 'Installing…' : 'Install · 31 MB'}
              </button>
            )}
      </div>
      <span className="muted">
        {personalize(
          "Nova's own decision model. A classifier trained on thousands of phrasings and a search of the closest examples read what you mean; app, project and agent names are matched in code. It answers in about a millisecond, on this Mac, with no language model and nothing sent anywhere. When it isn't sure, the brain answers - and when the brain handles it with one of Nova's skills, Reflex learns that phrasing for next time.",
          name,
        )}
      </span>
    </div>
  );
}

/** Local model servers: address, key, JSON replies, and what's running right now. */
export function ServersPanel({ snapshot, onSave }: { snapshot: SettingsSnapshot; onSave: Save }) {
  const entries = snapshot.values['models.servers'] as Record<string, ServerEntry>;
  const setEntry = (name: string, entry: ServerEntry | null) => onSave({ [`models.servers.${name}`]: entry && tidy(entry) });
  const [name, setName] = useState('');
  const [url, setNewUrl] = useState('');
  const validName = /^[a-z][a-z0-9_-]*$/.test(name) && !snapshot.servers.some((s) => s.name === name);
  const validUrl = /^https?:\/\/\S+$/.test(url.trim());

  return (
    <div className="cards-grid">
      {snapshot.servers.map((s) => {
        const entry = entries[s.name] ?? {};
        return (
          <div className="tile" key={s.name}>
            <div className="tile__head">
              <span className={`dot ${s.online ? 'dot--on' : ''}`} />
              <strong>{s.name}</strong>
              <span className="muted">{s.online ? `${s.models.length} model${s.models.length === 1 ? '' : 's'} available` : 'not running'}</span>
              {!s.builtIn && (
                <button type="button" className="link tile__action" onClick={() => setEntry(s.name, null)}>
                  Remove
                </button>
              )}
            </div>
            <div className="tile__grid">
              <label>Address</label>
              <TextInput
                mono
                value={s.url}
                placeholder={s.defaultUrl}
                onSave={(v) => (s.builtIn || v) && setEntry(s.name, { ...entry, url: v && v !== s.defaultUrl ? v : undefined })}
              />
              <label>API key</label>
              <SecretStatus name={s.keyVar} set={Boolean(snapshot.secrets[s.keyVar])} />
              <label title="Send the answer format as a JSON schema. Turn off for servers that reject it.">JSON replies</label>
              <Switch
                label={`JSON replies for ${s.name}`}
                on={entry.structuredOutputs !== false}
                onChange={(on) => setEntry(s.name, { ...entry, structuredOutputs: on ? undefined : false })}
              />
            </div>
            {s.models.length > 0 && (
              <div className="chips">
                {s.models.slice(0, 8).map((m) => (
                  <span className="chip" key={m} title={`${s.name}/${m}`}>
                    {m}
                  </span>
                ))}
                {s.models.length > 8 && <span className="chip">+{s.models.length - 8}</span>}
              </div>
            )}
          </div>
        );
      })}
      <form
        className="tile tile--add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!validName || !validUrl) return;
          setEntry(name, { url: url.trim() });
          setName('');
          setNewUrl('');
        }}
      >
        <strong>Add a server</strong>
        <span className="muted">Anything that speaks the OpenAI API: vLLM, Jan, LocalAI, a machine on your network. If it needs a key, add it to .env.</span>
        <div className="tile__row">
          <input className="setting__input" placeholder="name, e.g. jan" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
          <input className="setting__input is-mono" placeholder="http://localhost:1337/v1" value={url} onChange={(e) => setNewUrl(e.target.value)} />
          <button className="btn btn--ghost" type="submit" disabled={!validName || !validUrl}>
            Add
          </button>
        </div>
      </form>
    </div>
  );
}

/** Paired agents: which are on, which is the default, and how each one runs. */
export function AgentsPanel({ snapshot, onSave }: { snapshot: SettingsSnapshot; onSave: Save }) {
  const enabled = snapshot.saved['agents.enabled'] ? (snapshot.values['agents.enabled'] as string[]) : snapshot.agents.filter((a) => a.path).map((a) => a.name);
  const setEnabled = (names: string[]) => onSave({ 'agents.enabled': names });
  const ordered = [
    ...enabled.map((n) => snapshot.agents.find((a) => a.name === n)).filter((a): a is SettingsSnapshot['agents'][number] => Boolean(a)),
    ...snapshot.agents.filter((a) => !enabled.includes(a.name)),
  ];
  const options = snapshot.values['agents.options'] as Record<string, AgentEntry>;
  const field = (agent: string, key: keyof AgentEntry, value: string) => onSave({ [`agents.options.${agent}`]: tidy({ ...options[agent], [key]: value || undefined }) });

  return (
    <div className="cards-grid">
      {ordered.map((a) => {
        const on = enabled.includes(a.name);
        const o = options[a.name] ?? {};
        return (
          <div className={`tile ${on ? '' : 'is-off'}`} key={a.name}>
            <div className="tile__head">
              <span className="tile__glyph">{a.label[0]}</span>
              <div className="tile__title">
                <strong>
                  {a.label}
                  {a.custom && <span className="chip chip--tiny">custom</span>}
                </strong>
                <span className="muted is-mono">{a.path ?? `${a.bin} isn't installed`}</span>
              </div>
              {on && enabled[0] === a.name ? (
                <span className="chip chip--accent">Default</span>
              ) : (
                on && (
                  <button type="button" className="link" onClick={() => setEnabled([a.name, ...enabled.filter((n) => n !== a.name)])}>
                    Make default
                  </button>
                )
              )}
              <Switch
                label={`Pair ${a.label}`}
                on={on}
                disabled={!a.path && !on}
                onChange={(v) => setEnabled(v ? [...enabled, a.name] : enabled.filter((n) => n !== a.name))}
              />
            </div>
            <div className="tile__grid">
              {on && (
                <>
                  <label>Model</label>
                  <TextInput value={o.model ?? ''} placeholder="its default" onSave={(v) => field(a.name, 'model', v)} />
                  <label>Extra arguments</label>
                  <TextInput
                    mono
                    value={Array.isArray(o.args) ? o.args.join(' ') : (o.args ?? '')}
                    placeholder={a.name === 'codex' ? '--oss --local-provider lmstudio' : 'none'}
                    onSave={(v) => field(a.name, 'args', v)}
                  />
                </>
              )}
              <label>CLI path</label>
              <TextInput mono value={o.bin ?? ''} placeholder={a.path ?? a.bin} onSave={(v) => field(a.name, 'bin', v)} />
            </div>
          </div>
        );
      })}
      <CustomAgents snapshot={snapshot} onSave={onSave} />
    </div>
  );
}

const CUSTOM_EXAMPLE = `{
  "aider": {
    "label": "Aider",
    "command": "aider",
    "ask": ["--message", "{prompt}", "--dry-run"],
    "task": ["--message", "{prompt}", "--yes-always"]
  }
}`;

function CustomAgents({ snapshot, onSave }: { snapshot: SettingsSnapshot; onSave: Save }) {
  const custom = snapshot.values['agents.custom'] as Record<string, unknown>;
  const saved = Object.keys(custom).length ? JSON.stringify(custom, null, 2) : '';
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState('');
  useEffect(() => setDraft(saved), [saved]);
  const save = () => {
    if (!draft.trim()) return onSave({ 'agents.custom': null });
    try {
      const parsed: unknown = JSON.parse(draft);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Give an object of agents by name.');
      setError('');
      onSave({ 'agents.custom': parsed as Record<string, unknown> });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="tile tile--add">
      <strong>Your own agents</strong>
      <span className="muted">
        Any agent CLI: give its command and the arguments for a question and for a task. <code>{'{prompt}'}</code> is filled in; without it the prompt goes to stdin.
      </span>
      <textarea
        className="setting__input is-mono setting__code"
        rows={7}
        value={draft}
        placeholder={CUSTOM_EXAMPLE}
        spellCheck={false}
        onChange={(e) => {
          setDraft(e.target.value);
          setError('');
        }}
      />
      {error && <span className="setting__error">{error}</span>}
      <div className="tile__row tile__row--end">
        <button className="btn btn--ghost" type="button" disabled={draft === saved} onClick={save}>
          Save agents
        </button>
      </div>
    </div>
  );
}

/** Named project folders, plus everything agents can currently work in. */
export function ProjectsPanel({ snapshot, onSave }: { snapshot: SettingsSnapshot; onSave: Save }) {
  const named = snapshot.values['projects.named'] as Record<string, string>;
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const valid = isEntryName(name.trim()) && path.trim() !== '';
  return (
    <>
      <div className="tile tile--add">
        <strong>Named projects</strong>
        <span className="muted">Folders outside the projects folder, by the name you'll say.</span>
        {Object.entries(named).map(([n, p]) => (
          <div className="tile__row" key={n}>
            <strong className="tile__name">{n}</strong>
            <span className="muted is-mono tile__path">{p}</span>
            <button type="button" className="link" onClick={() => onSave({ [`projects.named.${n}`]: null })}>
              Remove
            </button>
          </div>
        ))}
        <form
          className="tile__row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            onSave({ [`projects.named.${name.trim()}`]: path.trim() });
            setName('');
            setPath('');
          }}
        >
          <input className="setting__input" placeholder="name, e.g. website" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="setting__input is-mono" placeholder="~/work/website" value={path} onChange={(e) => setPath(e.target.value)} />
          <button className="btn btn--ghost" type="submit" disabled={!valid}>
            Add
          </button>
        </form>
      </div>
      <div className="tile">
        <strong>
          {snapshot.projects.length} project{snapshot.projects.length === 1 ? '' : 's'} agents can work in
        </strong>
        <div className="chips">
          {snapshot.projects.map((p) => (
            <span className="chip" key={p.name} title={p.path}>
              {p.name}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

export function GatewayPanel({ snapshot }: { snapshot: SettingsSnapshot }) {
  const oidc = !snapshot.secrets.AI_GATEWAY_API_KEY && snapshot.secrets.VERCEL_OIDC_TOKEN;
  return (
    <div className="tile">
      <div className="tile__head">
        <strong>API key</strong>
        {oidc ? <SecretStatus name="VERCEL_OIDC_TOKEN" set /> : <SecretStatus name="AI_GATEWAY_API_KEY" set={Boolean(snapshot.secrets.AI_GATEWAY_API_KEY)} />}
      </div>
      <span className="muted">
        Keys are secrets, so they stay out of the settings file. Create one in the Vercel dashboard → AI Gateway → API Keys, add{' '}
        <code>AI_GATEWAY_API_KEY=...</code> to <code>{snapshot.constants.envFile}</code>, and restart Nova. Without a key, decisions run offline and
        answers come from an agent or a local model.
      </span>
    </div>
  );
}

export function SystemPanel({ snapshot }: { snapshot: SettingsSnapshot }) {
  const { constants } = snapshot;
  return (
    <>
      <div className="tile">
        <strong>Your settings</strong>
        <span className="muted">
          Everything in this window is saved to <code>{snapshot.file}</code> and applies right away. It's plain JSON - edit it by hand if you like; Nova applies
          the change as soon as you save the file.
        </span>
      </div>
      <div className="tile">
        <strong>Constants</strong>
        <span className="muted">
          <code>{constants.envFile}</code> holds what belongs to this machine rather than to you: the port (<code>NOVA_PORT</code>, now {constants.port}), the
          pages allowed to change settings (<code>NOVA_UI_ORIGINS</code>), file locations and API keys. Changes there need a restart.
        </span>
      </div>
      {constants.ignored.length > 0 && (
        <div className="banner">
          These entries in .env are settings from an earlier version. Nova ignores them now - your settings live in the file above - so you can delete them:{' '}
          <code>{constants.ignored.join(', ')}</code>
        </div>
      )}
    </>
  );
}
