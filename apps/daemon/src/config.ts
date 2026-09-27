import { config as dotenv } from 'dotenv';
import { watch } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COLLECTIONS,
  defaultOf,
  ENTRY_COLLECTIONS,
  FIELDS,
  getPath,
  LOCAL_SERVERS,
  serverKeyVar,
  setPath,
  settingProblem,
  wakeWordsFor,
  type EngineKind,
  type FallbackKind,
  type IntegrationEntry,
  type PresenceConfig,
  type SettingValue,
  type UiPrefs,
} from '@nova/core';
import type { AgentOptions } from './agents/host.ts';
import type { CustomAgentSpec } from './agents/presets.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Constants only: the port, allowed origins, where files live, and secrets. Your settings live in the settings file. */
export const ENV_FILE = join(ROOT, '.env');

/** Load the repo's .env into process.env; real environment variables win. */
export function loadDotEnv() {
  dotenv({ path: ENV_FILE, quiet: true });
}

export type Env = Record<string, string | undefined>;
/** The settings file: nested JSON such as { "name": "Jarvis", "voice": { "rate": 1.1 } }. */
export type Settings = Record<string, unknown>;

const expand = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/** Everything the Settings window changes, as JSON you can also edit by hand. */
export const settingsFile = () => resolve(ROOT, expand(process.env.NOVA_SETTINGS_FILE || '~/.nova/settings.json'));

/** Where agents find projects unless you pick a folder: the one holding this repo, e.g. ~/dev. */
export const DEFAULT_PROJECTS_FOLDER = dirname(ROOT);

/** The settings file, or null if there isn't one yet. Throws if it can't be read, so a broken file is never overwritten. */
export async function readSettings(file = settingsFile()): Promise<Settings | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} isn't valid JSON (${(e as Error).message}). Fix or delete it - until then Nova uses its defaults.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} should hold a JSON object.`);
  return parsed as Settings;
}

export async function writeSettings(settings: Settings, file = settingsFile()) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

/** Calls `onChange` shortly after the settings file changes on disk, whoever changed it. */
export function watchSettings(onChange: () => void, file = settingsFile()) {
  let timer: NodeJS.Timeout | undefined;
  try {
    watch(dirname(file), (_event, name) => {
      if (name && name !== basename(file)) return;
      clearTimeout(timer);
      timer = setTimeout(onChange, 150);
    }).on('error', () => {});
  } catch {
    // no folder to watch
  }
}

type ServerEntry = { url?: string; structuredOutputs?: boolean };
type AgentEntry = { model?: string; args?: string | string[]; bin?: string };

/** Keeps a collection's usable entries, noting the rest. */
function usableEntries(key: string, saved: unknown, warnings: string[]): Record<string, unknown> {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
    warnings.push(`${key} should be an object - ignoring it.`);
    return {};
  }
  return Object.fromEntries(
    Object.entries(saved).filter(([name, entry]) => {
      const problem = settingProblem(`${key}.${name}`, entry);
      if (problem) warnings.push(`${key}.${name} ${problem} - ignoring it.`);
      return !problem;
    }),
  );
}

/**
 * Everything the daemon runs on: your settings, where anything unusable falls back to its
 * default (with a warning), plus constants and secrets from the environment.
 */
export function loadConfig(settings: Settings, env: Env) {
  const warnings: string[] = [];
  const values: Record<string, SettingValue> = {};
  for (const key of [...FIELDS.map((f) => f.key), ...Object.keys(COLLECTIONS)]) {
    const saved = getPath(settings, key);
    const fallback = structuredClone(defaultOf(key)!);
    if (saved === undefined) values[key] = fallback;
    else if (ENTRY_COLLECTIONS.includes(key)) values[key] = usableEntries(key, saved, warnings);
    else {
      const problem = settingProblem(key, saved);
      if (problem) warnings.push(`${key} ${problem} - using the default.`);
      values[key] = problem ? fallback : (saved as SettingValue);
    }
  }
  const text = (key: string) => (values[key] as string).trim();
  const num = (key: string) => values[key] as number;
  const name = text('name') || 'Nova';
  const wake = (values['voice.wakeWords'] as string[]).map((w) => w.trim()).filter(Boolean);

  const servers = values['models.servers'] as Record<string, ServerEntry>;
  const localProviders = Object.fromEntries(
    [...new Set([...Object.keys(LOCAL_SERVERS), ...Object.keys(servers)])].map((server) => [
      server,
      {
        url: servers[server]?.url || LOCAL_SERVERS[server]!,
        apiKey: env[serverKeyVar(server)] || undefined,
        structuredOutputs: servers[server]?.structuredOutputs ?? true,
      },
    ]),
  );

  const agentOptions: Record<string, AgentOptions> = Object.fromEntries(
    Object.entries(values['agents.options'] as Record<string, AgentEntry>).map(([agent, o]) => [
      agent,
      {
        model: o.model?.trim() || undefined,
        bin: o.bin?.trim() || undefined,
        args: Array.isArray(o.args) ? o.args : (o.args ?? '').split(/\s+/).filter(Boolean),
      },
    ]),
  );

  const enabled = getPath(settings, 'agents.enabled');
  const port = Number(env.NOVA_PORT || 7878);
  const ui: UiPrefs = {
    autoListen: values['voice.listenOnOpen'] as boolean,
    rate: num('voice.rate'),
    lang: text('voice.language') || 'en-US',
    orb: {
      style: text('appearance.orbStyle') as UiPrefs['orb']['style'],
      colors: text('appearance.orbColors') as UiPrefs['orb']['colors'],
      motion: text('appearance.orbMotion') as UiPrefs['orb']['motion'],
    },
  };
  return {
    name,
    // Constants and secrets, from .env or the environment.
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 7878,
    gatewayKey: env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN || '',
    agentsFile: resolve(ROOT, expand(env.NOVA_AGENTS_FILE || 'nova.agents.json')),
    // Your settings.
    engine: text('decisions.engine') as EngineKind,
    fallback: text('decisions.fallback') as FallbackKind,
    timeoutMs: num('decisions.timeoutMs'),
    learn: values['decisions.learn'] as boolean,
    jevModel: text('decisions.jevModel') || 'typesafe-ai/jev',
    decisionModel: text('decisions.model'),
    brainModel: text('answers.model'),
    localProviders,
    wakeWords: wake.length ? wake : wakeWordsFor(name),
    followUpMs: num('voice.followUpSeconds') * 1000,
    requireWakeWord: values['voice.requireWakeWord'] as boolean,
    replyTimeoutMs: num('answers.timeoutSeconds') * 1000,
    // No list = every installed agent; an empty list = none.
    agents: settingProblem('agents.enabled', enabled) ? null : (enabled as string[]).map((a) => a.trim()).filter(Boolean),
    agentOptions,
    customAgents: values['agents.custom'] as Record<string, CustomAgentSpec>,
    projects: values['projects.named'] as Record<string, string>,
    projectsDir: values['projects.scan'] ? text('projects.folder') || DEFAULT_PROJECTS_FOLDER : '',
    agentTaskTimeoutMs: num('agents.taskTimeoutMinutes') * 60_000,
    ui,
    /** Nova speaks with Kokoro, on this Mac - there's no other voice. */
    voice: { kokoroVoice: text('voice.kokoroVoice') },
    integrations: values['integrations.servers'] as Record<string, IntegrationEntry>,
    memory: {
      suggest: values['memory.suggest'] as boolean,
      useInAnswers: values['memory.useInAnswers'] as boolean,
      /** Days of conversation to keep; null keeps them all. */
      keepDays: text('memory.keepConversations') === 'forever' ? null : Number(text('memory.keepConversations')) || 90,
    },
    screen: { context: values['screen.context'] as boolean, images: values['screen.images'] as boolean },
    /** When Nova speaks up by itself (Settings → Reminders & routines). */
    initiative: {
      speak: text('initiative.speak') as 'free' | 'show' | 'always',
      awayMinutes: num('initiative.awayMinutes'),
      appleReminders: text('initiative.appleReminders') as 'when-asked' | 'always' | 'never',
      remindersList: text('initiative.remindersList'),
      briefing: text('initiative.briefing') as 'first-unlock' | 'time' | 'off',
      briefingTime: text('initiative.briefingTime'),
      calendar: values['initiative.calendar'] as boolean,
      town: text('initiative.town'),
      units: text('initiative.units') as 'celsius' | 'fahrenheit',
      briefingBrain: values['initiative.briefingBrain'] as boolean,
    },
    routines: values.routines as Record<string, { phrase?: string; schedule?: string; steps: string[]; enabled?: boolean }>,
    /** The record of actions, snapshots for undoing agents' changes, and what the user said "yes, always" to. */
    trust: {
      keepDays: Number(text('trust.keepActivity')) || 30,
      snapshots: values['trust.snapshots'] as boolean,
      rules: values['trust.rules'] as Record<string, { key: string; label: string; until?: string }>,
    },
    /** How Nova's Mac app behaves (Settings → Menu bar). */
    presence: {
      shortcut: text('presence.shortcut'),
      listen: text('presence.listen'),
      pauseWhenLocked: values['presence.pauseWhenLocked'] as boolean,
      orb: text('presence.orb'),
      orbSeconds: num('presence.orbSeconds'),
      sounds: values['presence.sounds'] as boolean,
      launchAtLogin: values['presence.launchAtLogin'] as boolean,
      daemon: text('presence.daemon'),
    } as PresenceConfig,
    hearing: {
      engine: text('hearing.engine') as 'auto' | 'apple' | 'parakeet' | 'browser',
      language: text('voice.language') || 'en-US',
      patience: text('hearing.patience') as 'quick' | 'normal' | 'patient',
      smartTurn: values['hearing.smartTurn'] as boolean,
      bargeIn: values['hearing.bargeIn'] as boolean,
    },
    /** Every setting's value in effect, by key. */
    values,
    warnings,
  };
}

export type Config = ReturnType<typeof loadConfig>;

// Settings used to be flat NOVA_* variables in .env. They're read once, to move them into the settings file.

const words = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const pairs = (v: string) =>
  Object.fromEntries(
    words(v)
      .filter((p) => p.includes('='))
      .map((p) => [p.slice(0, p.indexOf('=')).trim(), p.slice(p.indexOf('=') + 1).trim()])
      .filter(([k, path]) => k && path),
  );
const flag = (v: string) => v !== 'false';
const per = (unit: number) => (v: string) => Number(v) / unit;

/** The old flat keys and where each setting lives now. */
const LEGACY: Record<string, [key: string, convert: (v: string) => unknown]> = {
  NOVA_NAME: ['name', String],
  NOVA_WAKE_WORDS: ['voice.wakeWords', words],
  NOVA_REQUIRE_WAKE_WORD: ['voice.requireWakeWord', flag],
  NOVA_FOLLOW_UP_MS: ['voice.followUpSeconds', per(1000)],
  NOVA_AUTO_LISTEN: ['voice.listenOnOpen', flag],
  NOVA_SPEECH_LANG: ['voice.language', String],
  NOVA_VOICE_RATE: ['voice.rate', Number],
  NOVA_DECISION_ENGINE: ['decisions.engine', String],
  NOVA_DECISION_MODEL: ['decisions.model', String],
  NOVA_DECISION_FALLBACK: ['decisions.fallback', String],
  NOVA_DECISION_TIMEOUT_MS: ['decisions.timeoutMs', Number],
  NOVA_JEV_MODEL: ['decisions.jevModel', String],
  NOVA_BRAIN_MODEL: ['answers.model', String],
  NOVA_REPLY_TIMEOUT_MS: ['answers.timeoutSeconds', per(1000)],
  NOVA_AGENTS: ['agents.enabled', words],
  NOVA_AGENT_TASK_TIMEOUT_MS: ['agents.taskTimeoutMinutes', per(60_000)],
  NOVA_CUSTOM_AGENTS: ['agents.custom', JSON.parse],
  NOVA_PROJECTS: ['projects.named', pairs],
  NOVA_PROJECTS_DIR: ['projects.folder', String],
  NOVA_LOCAL_PROVIDERS: ['models.servers', pairs],
};
/** Per agent or server: NOVA_<NAME>_MODEL, _ARGS, _BIN or _STRUCTURED_OUTPUTS. */
const LEGACY_NAMED = /^NOVA_([A-Z0-9_]+?)_(MODEL|ARGS|BIN|STRUCTURED_OUTPUTS)$/;

/** Old keys for settings Nova no longer has (it has one voice, Kokoro). */
const RETIRED_ENV = ['NOVA_VOICE'];

/** Old settings still in the environment (usually .env). They're ignored: settings live in the settings file. */
export const settingsInEnv = (env: Env) => Object.keys(env).filter((k) => Object.hasOwn(LEGACY, k) || LEGACY_NAMED.test(k) || RETIRED_ENV.includes(k)).sort();

const sameWords = (a: string[], b: string[]) => a.length === b.length && b.every((w) => a.map((x) => x.toLowerCase()).includes(w));

/** Settings from the old flat keys, leaving out anything that just repeats a default. */
export function fromLegacy(flat: Env): Settings {
  const out: Settings = {};
  const put = (key: string, value: unknown) => {
    if (settingProblem(key, value)) return;
    // An empty agent list means "no agents", unlike no list at all.
    if (key !== 'agents.enabled' && JSON.stringify(value) === JSON.stringify(defaultOf(key))) return;
    setPath(out, key, value);
  };
  for (const [envKey, [key, convert]] of Object.entries(LEGACY)) {
    const raw = flat[envKey]?.trim();
    if (raw === undefined || (!raw && envKey !== 'NOVA_AGENTS' && envKey !== 'NOVA_PROJECTS_DIR')) continue;
    let value: unknown;
    try {
      value = convert(raw);
    } catch {
      continue; // unreadable, e.g. broken JSON
    }
    if (envKey === 'NOVA_WAKE_WORDS') {
      // The stock words (copied from .env.example) and the name's own words keep following the name.
      const name = flat.NOVA_NAME?.trim() || 'Nova';
      if (sameWords(value as string[], wakeWordsFor('Nova')) || sameWords(value as string[], wakeWordsFor(name))) continue;
    }
    if (envKey === 'NOVA_PROJECTS_DIR') {
      if (!raw) put('projects.scan', false);
      else if (resolve(expand(raw)) !== resolve(DEFAULT_PROJECTS_FOLDER)) put(key, raw);
    } else if (envKey === 'NOVA_LOCAL_PROVIDERS') {
      for (const [server, url] of Object.entries(value as Record<string, string>)) {
        if (LOCAL_SERVERS[server.toLowerCase()] !== url) setPath(out, `models.servers.${server.toLowerCase()}.url`, url);
      }
    } else put(key, value);
  }
  for (const [envKey, raw] of Object.entries(flat)) {
    const m = LEGACY_NAMED.exec(envKey);
    if (!m || Object.hasOwn(LEGACY, envKey) || !raw?.trim()) continue;
    const name = m[1]!.toLowerCase();
    if (m[2] === 'STRUCTURED_OUTPUTS') {
      if (raw.trim() === 'false') setPath(out, `models.servers.${name}.structuredOutputs`, false);
    } else setPath(out, `agents.options.${name}.${m[2]!.toLowerCase()}`, raw.trim());
  }
  // Drop entries that don't hold up, e.g. JSON replies turned off for a server that has no address.
  for (const collection of ['models.servers', 'agents.options']) {
    for (const [name, entry] of Object.entries((getPath(out, collection) as Record<string, unknown> | undefined) ?? {})) {
      if (settingProblem(`${collection}.${name}`, entry)) setPath(out, `${collection}.${name}`, undefined);
    }
  }
  return out;
}

const SECRET = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/;

/**
 * Runs once: moves your settings out of .env (and out of an early, flat settings file) into
 * the settings file. From then on .env only holds constants. Returns what moved, or null when
 * there was nothing to do.
 */
/** Settings Nova no longer has, taken out of the file: it speaks only with Kokoro now. */
const RETIRED = ['voice.engine', 'voice.speaker'];

export async function migrateSettings(env: Env, file = settingsFile()) {
  const existing = await readSettings(file).catch(() => undefined); // an unreadable file is reported elsewhere, never replaced
  if (existing === undefined) return null;
  const legacy = existing !== null && Object.keys(existing).some((k) => k.startsWith('NOVA_') || SECRET.test(k));
  if (existing && !legacy) {
    const retired = RETIRED.filter((k) => getPath(existing, k) !== undefined);
    if (!retired.length) return null;
    for (const key of retired) setPath(existing, key, undefined);
    await writeSettings(existing, file);
    return { moved: [] as string[], secrets: [] as string[], backup: undefined, retired };
  }

  const flat: Env = { ...env };
  let backup: string | undefined;
  const secrets: string[] = [];
  if (legacy) {
    for (const [k, v] of Object.entries(existing!)) {
      if (typeof v !== 'string') continue;
      if (SECRET.test(k)) secrets.push(k); // secrets belong in .env now
      else flat[k] = v;
    }
    backup = `${file}.bak`;
    await copyFile(file, backup);
    await chmod(backup, 0o600); // it may hold API keys
  }
  const settings = fromLegacy(flat);
  await writeSettings(settings, file);
  const moved = [...FIELDS.map((f) => f.key), ...Object.keys(COLLECTIONS)].filter((k) => getPath(settings, k) !== undefined);
  return { moved, secrets, backup, retired: [] as string[] };
}
