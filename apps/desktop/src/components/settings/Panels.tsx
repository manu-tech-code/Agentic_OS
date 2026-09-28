import { useEffect, useRef, useState } from 'react';
import type { ClientEvent, OrbPrefs, Phase } from '@nova/core/protocol';
import { isEntryName, personalize, type SettingsSnapshot, type VoiceEnrollStep, type VoiceTestResult } from '@nova/core/settings';
import { ParticleOrb } from '../ParticleOrb';
import { appLevel } from '../../lib/shell';
import { Info, SecretStatus, Switch, TextInput, type Save } from './Controls';

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
    size: 100, // the preview keeps its own size
    floatingSize: 100,
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

/**
 * Voice ID: its model, learning the user's voice (the phrase to say now, and how far along), testing it (what
 * each thing said sounded like), and forgetting it. The voiceprint itself never reaches a window - only whether
 * there is one, and how closely each test matched it.
 */
export function VoiceIdPanel({ snapshot, name, result, onAction }: ActionProps) {
  const v = snapshot.voiceId;
  const browser = snapshot.hearing.status.engine === 'browser';
  const [busy, setBusy] = useBusy([v.installed, v.enrolled, v.enrolling?.step, Boolean(v.testing), v.keyword.set, v.keyword.overriddenAt], result);
  const act = (action: 'install' | 'enroll' | 'improve' | 'test' | 'cancel' | 'forget' | 'keyword-clear' | 'override-end') => (setBusy(true), onAction({ type: 'voiceid', action }));
  const idle = v.installed && !v.enrolling && !v.testing;
  return (
    <div className="tile">
      <div className="tile__head tile__head--wrap">
        <span className={`dot ${v.keyword.overriddenAt ? 'dot--warn' : v.on ? 'dot--on' : ''}`} />
        <strong>Voice ID</strong>
        <Info label="Voice ID" text={personalize("With Voice ID on, Nova listens to you alone: other voices are ignored, even saying its name, and a TV can't answer its questions. When it can't tell (a very short \"yes\"), it says so - holding the talk shortcut always counts as you. To set it up, read a few short phrases (about 45 seconds) where it's quiet; Test my voice then shows whether it knows you. Three models listen, and their matches are weighed together. Your voiceprint is made and kept on this Mac, and never leaves it.", name)} />
        <span className="muted">
          {v.enrolling
            ? v.enrolling.phase === 'check'
              ? `checking it's you · ${v.enrolling.step} of ${v.enrolling.of} in a row`
              : `learning your voice · ${v.enrolling.step} of ${v.enrolling.of}`
            : v.testing
              ? 'testing your voice'
              : v.keyword.overriddenAt
                ? 'off · the master keyword was said'
              : v.on
                ? `on${v.learned ? ` · learned from ${v.learned} of your turns` : ''}`
                : v.enrolled
                  ? 'your voice is learned · switched off'
                  : v.installed
                    ? 'not set up'
                    : 'not installed'}
        </span>
        {!v.installed && (
          <button type="button" className="btn btn--ghost tile__action" disabled={busy} onClick={() => act('install')}>
            {busy ? 'Installing…' : `Install${v.size ? ` · ${v.size}` : ''}`}
          </button>
        )}
        {idle && (
          <button type="button" className="btn btn--ghost tile__action" disabled={busy || browser} onClick={() => act('enroll')}>
            {v.enrolled ? 'Learn it again' : 'Set up'}
          </button>
        )}
        {(v.enrolling || v.testing) && (
          <button type="button" className="link tile__action" onClick={() => act('cancel')}>
            {v.testing ? 'Done' : 'Stop'}
          </button>
        )}
        {idle && v.enrolled && (
          <button type="button" className="link" onClick={() => act('forget')}>
            Forget my voice
          </button>
        )}
      </div>
      {v.enrolling && <Enrolling enrolling={v.enrolling} />}
      {idle && v.enrolled && (
        <div className="voice-test__offer">
          <button type="button" className="btn btn--primary" disabled={busy || browser} onClick={() => act('test')}>
            Test my voice
          </button>
          {v.improvable && (
            <button type="button" className="btn btn--ghost" disabled={busy || browser} onClick={() => act('improve')}>
              Improve my voice
            </button>
          )}
          <span className="muted">{personalize('Say anything, and see whether Nova knows it was you.', name)}</span>
        </div>
      )}
      {v.testing && <VoiceTest testing={v.testing} bars={v.bars} on={v.on} name={name} />}
      {v.keyword.overriddenAt && (
        <div className="banner voice-override">
          <span>
            {personalize(
              `Voice ID is off: the master keyword was said ${saidAt(v.keyword.overriddenAt)}. Anyone Nova hears can ask it things - nothing is deleted, spent or allowed for good.`,
              name,
            )}
          </span>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => act('override-end')}>
            Turn Voice ID back on
          </button>
        </div>
      )}
      {v.enrolled && idle && (
        <KeywordRow
          set={v.keyword.set}
          name={name}
          busy={busy}
          onSet={(keyword) => (setBusy(true), onAction({ type: 'voiceid', action: 'keyword-set', keyword }))}
          onClear={() => act('keyword-clear')}
        />
      )}
      {v.message && <span className="muted">{v.message}</span>}
      {browser && <span className="muted">Voice ID needs Nova's own hearing - Nova.app, or Hearing on Apple or Parakeet: the browser's speech recognition never passes the voice on.</span>}
    </div>
  );
}

const percent = (x: number) => `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%`;

/** The microphone's level as the Mac app hears it, for the setup - drawn every frame, never through React. */
function LevelMeter() {
  const bar = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      bar.current?.style.setProperty('--level', String(Math.min(1, Math.max(0, appLevel.current ?? 0))));
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <span className="voice-meter-live" aria-hidden>
      <span ref={bar} className="voice-meter-live__bar" />
    </span>
  );
}

const HOW: Record<VoiceEnrollStep['kind'], string> = { normal: 'as usual', far: 'a step back', quiet: 'quietly', free: 'talking freely', check: 'check' };

/** Setting up (or improving): what to say now and how, the microphone's level, and what each thing said came to. */
function Enrolling({ enrolling: e }: { enrolling: NonNullable<SettingsSnapshot['voiceId']['enrolling']> }) {
  return (
    <div className="voice-enroll">
      <div className="banner">
        {e.hint && <span className="voice-enroll__hint">{e.hint}</span>}
        {e.phase === 'check' ? 'To check it knows you, say: ' : 'Say: '}
        <strong>“{e.say}”</strong>
      </div>
      <div className="voice-enroll__level">
        <span className="muted">Your microphone</span>
        <LevelMeter />
      </div>
      {e.done.length > 0 && (
        <ol className="voice-enroll__done">
          {[...e.done].reverse().slice(0, 6).map((d, i) => (
            <li key={`${e.done.length - i}`} className={d.ok ? 'is-ok' : 'is-again'}>
              <span className="voice-enroll__mark" aria-label={d.ok ? 'taken' : 'say it again'}>
                {d.ok ? '✓' : '↻'}
              </span>
              <span className="voice-enroll__text">
                <span>
                  {HOW[d.kind]} · “{d.say.length > 48 ? `${d.say.slice(0, 46)}…` : d.say}”{d.score !== undefined ? ` · match ${Math.round(d.score * 100)}%` : ''}
                </span>
                {d.why && <span className="muted">{d.why}</span>}
                {d.level !== undefined && (
                  <span className="muted voice-enroll__stats">
                    {d.level} dB · {d.snr} dB over the room · {d.speech} s of speech
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** "at 10:42" today, "on Mon at 10:42" before. */
function saidAt(iso: string) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `at ${time}` : `on ${d.toLocaleDateString([], { weekday: 'short' })} at ${time}`;
}

/** Long enough never to be said by chance - the daemon's own rule, checked there too. */
const keywordOk = (k: string) => k.trim().split(/\s+/).filter(Boolean).length >= 2 && k.replace(/[^\p{L}\p{N}]/gu, '').length >= 8;

/** Voice ID's master keyword: typed, never shown back, and hashed by the daemon at once. */
function KeywordRow({ set, name, busy, onSet, onClear }: { set: boolean; name: string; busy: boolean; onSet: (keyword: string) => void; onClear: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const about = (
    <Info
      label="Master keyword"
      text={personalize(
        "Said in any voice, anywhere in a sentence, it turns Voice ID off until you turn it back on here - for a guest, or on a day Nova doesn't know your voice. Meanwhile any voice is heard, but nothing gets deleted, spent or allowed for good. Nova says so aloud, sends a notification and puts it in Activity. Only a hash of it is kept, on this Mac.",
        name,
      )}
    />
  );
  if (set && !editing) {
    return (
      <div className="voice-keyword">
        <span className="muted">Master keyword: set</span>
        {about}
        <button type="button" className="link" disabled={busy} onClick={() => setEditing(true)}>
          Change
        </button>
        <button type="button" className="link" disabled={busy} onClick={onClear}>
          Clear
        </button>
      </div>
    );
  }
  return (
    <form
      className="voice-keyword"
      onSubmit={(e) => {
        e.preventDefault();
        if (!keywordOk(draft)) return;
        onSet(draft.trim());
        setDraft('');
        setEditing(false);
      }}
    >
      <input
        type="password"
        className="setting__input"
        value={draft}
        placeholder="Master keyword - two words or more"
        aria-label="Master keyword"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button type="submit" className="btn btn--ghost" disabled={busy || !keywordOk(draft)}>
        {set ? 'Change' : 'Set keyword'}
      </button>
      {editing && (
        <button type="button" className="link" onClick={() => (setEditing(false), setDraft(''))}>
          Cancel
        </button>
      )}
      {about}
    </form>
  );
}

/** A voice test under way: what to do, and what each thing said sounded like, newest first. */
function VoiceTest({ testing, bars, on, name }: { testing: NonNullable<SettingsSnapshot['voiceId']['testing']>; bars: SettingsSnapshot['voiceId']['bars']; on: boolean; name: string }) {
  const { results } = testing;
  return (
    <div className="voice-test">
      <div className="banner banner--quiet">
        {personalize('Say something - anything. While the test runs, what you say is only checked, never acted on.', name)}
        {!on && ' Voice ID is switched off, so this shows what it would do once it is on.'}
      </div>
      {bars && (
        <span className="muted">
          {personalize(`A match of ${percent(bars.accept)} or more is you; under ${percent(bars.reject)}, it isn't; in between, Nova can't tell.`, name)}
        </span>
      )}
      {results.length === 0 ? (
        <span className="muted voice-test__listening">Listening…</span>
      ) : (
        results.map((r, i) => <VoiceTestRow key={`${r.at}-${i}`} result={r} bars={bars} />)
      )}
      {results.some((r) => r.speaker === 'you') && (
        <span className="muted">Now have someone else say something, or play a video: it should say it isn't you.</span>
      )}
    </div>
  );
}

function VoiceTestRow({ result: r, bars }: { result: VoiceTestResult; bars: SettingsSnapshot['voiceId']['bars'] }) {
  const tone = r.speaker === 'you' ? 'dot--on' : r.speaker === 'not-you' ? 'dot--bad' : 'dot--warn';
  return (
    <div className="voice-test__row">
      <span className={`dot ${tone}`} />
      <div className="voice-test__text">
        <strong>{r.verdict}</strong>
        <span className="muted">
          {r.score === null ? 'no match measured' : `match ${percent(r.score)}`} · {r.seconds.toFixed(1)} s{r.heard ? ` · “${r.heard}”` : ''}
        </span>
        {r.why && <span className="muted">{r.why}</span>}
        {r.models && <span className="muted">each model: {r.models.map((m) => `${m.name} ${percent(m.score)}`).join(' · ')}</span>}
        {bars && r.score !== null && (
          <div className="voice-meter" role="img" aria-label={`Match ${percent(r.score)}: ${percent(bars.accept)} or more is you, under ${percent(bars.reject)} isn't.`}>
            <span className="voice-meter__zone voice-meter__zone--not" style={{ left: 0, width: percent(bars.reject) }} />
            <span className="voice-meter__zone voice-meter__zone--unsure" style={{ left: percent(bars.reject), width: percent(bars.accept - bars.reject) }} />
            <span className="voice-meter__zone voice-meter__zone--you" style={{ left: percent(bars.accept), right: 0 }} />
            <span className="voice-meter__mark" style={{ left: percent(r.score) }} />
          </div>
        )}
      </div>
    </div>
  );
}

/** How Nova hears: the engine in use (and why, when the browser listens instead), and the models hearing can use. */
export function HearingPanel({ snapshot, name, result, onAction }: ActionProps) {
  const { status, parakeet, smartTurn, speech } = snapshot.hearing;
  const [busyParakeet, setBusyParakeet] = useBusy([parakeet.installed], result);
  const [busyTurn, setBusyTurn] = useBusy([smartTurn.installed], result);
  const [busySpeech, setBusySpeech] = useBusy([speech.installed], result);
  const engine = status.engine === 'apple' ? "Apple's on-device recognizer" : status.engine === 'parakeet' ? 'Parakeet, on this Mac' : "The browser's speech recognition";
  const state = status.state === 'ready' ? 'hearing you' : status.state === 'starting' ? 'getting ready…' : "can't hear";
  return (
    <div className="tile">
      <div className="tile__head">
        <span className={`dot ${status.engine !== 'browser' && status.state === 'ready' ? 'dot--on' : ''}`} />
        <strong>{engine}</strong>
        <Info label="Hearing" text={personalize("On-device hearing turns what you say into text on this Mac - nothing you say leaves it - and lets you talk over Nova to stop it. Apple's recognizer needs no download. Parakeet is NVIDIA's open model, the most accurate in a noisy room. Smart Turn hears from your tone when you've finished a sentence. The speech detector tells a voice from other sounds, so typing, music or a fan don't start a turn.", name)} />
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
      <ModelRow
        name="Speech detector"
        label={speech.label}
        installed={speech.installed}
        size="2 MB"
        busy={busySpeech}
        onInstall={() => {
          setBusySpeech(true);
          onAction({ type: 'hearing-install', model: 'speech' });
        }}
      />
    </div>
  );
}

/** Reflex, Nova's own decision model: installed or not, and what it has learned. */
export function ReflexPanel({ snapshot, name, result, onAction }: ActionProps) {
  const { reflex } = snapshot;
  const [busy, setBusy] = useBusy([reflex.installed, reflex.sentences, reflex.learned], result);
  return (
    <div className="tile">
      <div className="tile__head">
        <span className={`dot ${reflex.installed ? 'dot--on' : ''}`} />
        <strong>Reflex</strong>
        <Info label="Reflex" text={personalize("Nova's own decision model. A classifier trained on thousands of phrasings - reading word meanings and, with its sentence model, whole sentences - and a search of the closest examples read what you mean; app, project and agent names are matched in code; yes and no are read in code. It answers in about a millisecond, on this Mac, with no language model and nothing sent anywhere. When it isn't sure, the brain answers - and when the brain handles it with one of Nova's skills, Reflex learns that phrasing for next time.", name)} />
        <span className="muted">
          {reflex.installed
            ? [
                reflex.label,
                reflex.trained ? `classifier trained on ${(reflex.phrasings ?? 0).toLocaleString()} phrasings` : 'training its classifier…',
                `learned ${reflex.learned} from you${reflex.taught ? ` (${reflex.taught} taught by the brain)` : ''}`,
              ].join(' · ')
            : 'not installed'}
        </span>
        {reflex.installed && reflex.sentences === false && (
          <button
            type="button"
            className="btn btn--ghost tile__action"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              onAction({ type: 'reflex-install' });
            }}
          >
            {busy ? 'Installing…' : 'Add its sentence model · 24 MB'}
          </button>
        )}
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
                {busy ? 'Installing…' : 'Install · 55 MB'}
              </button>
            )}
      </div>
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
      <div className="tile__head">
        <strong>Your own agents</strong>
        <Info
          label="Your own agents"
          text={
            <>
              Any agent CLI: give its command and the arguments for a question and for a task. <code>{'{prompt}'}</code> is filled in; without it the prompt goes to stdin.
            </>
          }
        />
      </div>
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

/** Jev's key: whether it's set (never its value), and where it goes. */
export function JevPanel({ snapshot }: { snapshot: SettingsSnapshot }) {
  const set = Boolean(snapshot.secrets.NOVA_JEV_API_KEY);
  return (
    <div className="tile">
      <div className="tile__head">
        <span className={`dot ${set ? 'dot--on' : ''}`} />
        <strong>Jev</strong>
        <SecretStatus name="NOVA_JEV_API_KEY" set={set} />
      </div>
      <span className="muted">
        {set
          ? "Each thing you say goes to TypeSafe's Jev to be decided, with your last few exchanges and the choices Nova weighs. When it can't answer in time, the fallback below decides on this Mac."
          : 'Keys are secrets, so they stay out of the settings file.'}{' '}
        {!set && (
          <>
            Create one at TypeSafe, add <code>NOVA_JEV_API_KEY=...</code> to <code>{snapshot.constants.envFile}</code>, and restart Nova. Until then, Reflex decides.
          </>
        )}
      </span>
    </div>
  );
}

const SIGNED: Record<SettingsSnapshot['signing']['apps'][number]['signed'], string> = {
  yours: 'your certificate',
  'ad hoc': 'this Mac alone',
  other: 'another certificate',
  'not built': 'not built yet',
};

/** Who signs Nova's apps: with the user's certificate their permissions survive rebuilds, and Nova Eyes answers only Nova.app. */
function SigningTile({ signing }: { signing: SettingsSnapshot['signing'] }) {
  const ok = !signing.adHoc && signing.apps.every((a) => a.signed === 'not built' || (a.signed === 'yours' && a.hardened));
  return (
    <div className="tile">
      <div className="tile__head">
        <span className={`dot ${ok ? 'dot--on' : ''}`} />
        <strong>Signing</strong>
        <span className="muted">{signing.identity}</span>
      </div>
      <span className="muted">
        {signing.apps.map((a) => `${a.name}: ${SIGNED[a.signed]}${a.signed !== 'not built' && !a.hardened ? ', not hardened' : ''}`).join(' · ')}.{' '}
        {signing.adHoc
          ? 'macOS asks for the microphone, the screen and Accessibility again after every rebuild. Sign in to Xcode (Settings → Accounts) for a free Apple Development certificate, then run npm run app.'
          : ok
            ? 'What macOS allows Nova survives rebuilds and renewals, nothing can be injected into its apps, and Nova Eyes answers only the daemon Nova.app runs.'
            : 'Run npm run app to sign Nova.app with it; Nova Eyes and the hearing helper follow by themselves. macOS asks for each permission one last time.'}
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
      <SigningTile signing={snapshot.signing} />
      {constants.ignored.length > 0 && (
        <div className="banner">
          These entries in .env are settings from an earlier version. Nova ignores them now - your settings live in the file above - so you can delete them:{' '}
          <code>{constants.ignored.join(', ')}</code>
        </div>
      )}
    </>
  );
}
