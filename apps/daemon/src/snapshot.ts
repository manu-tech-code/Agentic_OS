import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getPath, isSettingKey, LOCAL_SERVERS, serverKeyVar, settingProblem, type SettingsSnapshot, type SettingValue } from '@nova/core';
import { agentCandidates, findProjects } from './agents/host.ts';
import type { CustomAgentSpec } from './agents/presets.ts';
import { DEFAULT_PROJECTS_FOLDER, ENV_FILE, settingsFile, settingsInEnv, type Config, type Env, type Settings } from './config.ts';
import { modelResolver } from './models.ts';
import type { ReflexRuntime } from './reflex/runtime.ts';
import { helperBinary } from './hearing/build.ts';
import { eyesApp } from './screen/eyes.ts';
import { APP } from './shell/install.ts';
import { currentIdentity, signingStatus } from './shell/signing.ts';
import { privacyFlows, setupSteps } from './trust/index.ts';

/** The values in effect, which of them are saved in the settings file, and whether each secret is set - never its value. */
export function settingValues(settings: Settings, config: Config, env: Env) {
  const values: Record<string, SettingValue> = {
    ...config.values,
    'voice.wakeWords': config.wakeWords, // they may follow the name
    'projects.folder': config.values['projects.folder'] || DEFAULT_PROJECTS_FOLDER,
  };
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, getPath(settings, key) !== undefined]));
  const secrets: Record<string, boolean> = { NOVA_JEV_API_KEY: Boolean(env.NOVA_JEV_API_KEY) };
  for (const server of Object.keys(config.localProviders)) secrets[serverKeyVar(server)] = Boolean(env[serverKeyVar(server)]);
  return { values, saved, secrets };
}

/** Rejects changes Settings may not make, before anything is saved. Secrets and constants can't be changed from here. */
export function validateChanges(changes: unknown): asserts changes is Record<string, SettingValue | null> {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Nothing to save.');
  for (const [key, value] of Object.entries(changes)) {
    if (!isSettingKey(key)) throw new Error(`${key} can't be changed from Settings.`);
    const problem = value === null ? null : settingProblem(key, value);
    if (problem) throw new Error(`${key} ${problem}.`);
  }
}

/** Is a model server up, and which models does it offer? */
async function probe(url: string, apiKey?: string) {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return { online: true, models: [] as string[] };
    const body: any = await res.json();
    return { online: true, models: ((body?.data ?? []) as any[]).map((m) => String(m?.id ?? '')).filter(Boolean) };
  } catch {
    return { online: false, models: [] as string[] };
  }
}

/** Whether a folder is in a git repository: a .git in it or above it (no git process, so it's cheap to ask often). */
const gitCache = new Map<string, { at: number; git: boolean }>();
async function inGit(path: string): Promise<boolean> {
  const hit = gitCache.get(path);
  if (hit && Date.now() - hit.at < 60_000) return hit.git;
  let dir = path;
  let git = false;
  for (let i = 0; i < 12 && !git; i++) {
    git = await stat(join(dir, '.git')).then(() => true, () => false);
    if (dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  gitCache.set(path, { at: Date.now(), git });
  return git;
}

let signingCache: { at: number; value: SettingsSnapshot['signing'] } | null = null;
/** How Nova's apps are signed now - asked of codesign at most once a minute. */
async function signing(): Promise<SettingsSnapshot['signing']> {
  if (signingCache && Date.now() - signingCache.at < 60_000) return signingCache.value;
  const value = await signingStatus(await currentIdentity(), [
    { name: 'Nova.app', path: APP },
    { name: 'Nova Eyes', path: eyesApp() },
    { name: 'the hearing helper', path: helperBinary },
  ]);
  signingCache = { at: Date.now(), value };
  return value;
}

/** What the Setup and Privacy & trust pages need besides the rest. */
export interface TrustSnapshotInput {
  onboarded: boolean;
  appInstalled: boolean;
  /** Paired agents, default first. */
  paired: { name: string; label: string }[];
  /** Who answers open questions now, if anyone. */
  brain: string | null;
  trust: SettingsSnapshot['trust'];
}

/** Everything the Settings window shows: values, what's saved, and what's installed or running. */
export async function buildSnapshot(
  settings: Settings,
  config: Config,
  custom: Record<string, CustomAgentSpec>,
  env: Env,
  reflex: ReflexRuntime,
  voice: SettingsSnapshot['voice'],
  hearing: SettingsSnapshot['hearing'],
  integrations: SettingsSnapshot['integrations'],
  memory: SettingsSnapshot['memory'],
  screen: SettingsSnapshot['screen'],
  hands: SettingsSnapshot['hands'],
  presence: SettingsSnapshot['presence'],
  initiative: SettingsSnapshot['initiative'],
  trust: TrustSnapshotInput,
  fileError?: string,
): Promise<SettingsSnapshot> {
  const [agents, projects, servers] = await Promise.all([
    agentCandidates(custom, config.agentOptions),
    findProjects(config.projectsDir, config.projects),
    Promise.all(
      Object.entries(config.localProviders).map(async ([name, server]) => ({
        name,
        url: server.url,
        builtIn: Object.hasOwn(LOCAL_SERVERS, name),
        defaultUrl: LOCAL_SERVERS[name],
        keyVar: serverKeyVar(name),
        ...(await probe(server.url, server.apiKey)),
      })),
    ),
  ]);
  const pairedNames = new Set(trust.paired.map((a) => a.name));
  const installed = agents.filter((a) => a.path);
  const reflexInstalled = Boolean(reflex.model) || reflex.status.installed;
  const projectList = [...projects].map(([name, path]) => ({ name, path }));
  const signed = await signing();
  const setup = setupSteps({
    config,
    signing: signed,
    reflex: { installed: reflexInstalled, learned: reflex.model?.learned.length ?? reflex.status.learned, label: reflex.status.label },
    voice,
    hearing,
    app: presence.app,
    appInstalled: trust.appInstalled,
    agents: trust.paired,
    brain: trust.brain,
    projects: await Promise.all(projectList.map(async (p) => ({ name: p.name, git: await inGit(p.path) }))),
    screen,
    hands,
  });
  const privacy = privacyFlows({
    config,
    reflex: Boolean(reflex.model),
    hasJevKey: Boolean(config.jevKey),
    // The paired ones first (the default first), then the rest installed here.
    agents: [...trust.paired.map((a) => ({ ...a, paired: true })), ...installed.filter((a) => !pairedNames.has(a.name)).map((a) => ({ name: a.name, label: a.label, paired: false }))],
    brain: Boolean(trust.brain),
    integrations,
    hearing: hearing.status,
    voiceInstalled: voice.installed,
    isLocal: modelResolver(config.localProviders).isLocal,
  });
  return {
    ...settingValues(settings, config, env),
    file: settingsFile(),
    problems: fileError ? [fileError] : config.warnings,
    constants: { port: config.port, envFile: ENV_FILE, ignored: settingsInEnv(env) },
    reflex: {
      ...reflex.status,
      learned: reflex.model?.learned.length ?? reflex.status.learned,
      taught: reflex.model?.learned.filter((e) => e.source === 'brain').length ?? 0,
      trained: reflex.model?.trained ?? false,
    },
    voice,
    hearing,
    integrations,
    memory,
    screen,
    hands,
    signing: signed,
    presence,
    initiative,
    setup: { onboarded: trust.onboarded, steps: setup },
    privacy,
    trust: trust.trust,
    agents,
    servers,
    projects: projectList,
  };
}
