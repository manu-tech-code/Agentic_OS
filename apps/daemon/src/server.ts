import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir, platform as osPlatform } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createDecisionEngine,
  formatShortcut,
  LlmReasoningBrain,
  NovaBrain,
  setPath,
  settingProblem,
  type ActivityItem,
  type ClientEvent,
  type NovaSettings,
  type Phase,
  type PrefKey,
  type PrefsService,
  type ReasoningBrain,
  type ServerEvent,
  type SettingsSnapshot,
  type ToolHost,
} from '@nova/core';
import { WebSocketServer, type WebSocket } from 'ws';
import { startBridge } from './agents/bridge.ts';
import { createAgentHost, findProjects, type NovaAgentHost } from './agents/host.ts';
import type { CustomAgentSpec } from './agents/presets.ts';
import { loadConfig, loadDotEnv, migrateSettings, readSettings, settingsFile, settingsInEnv, watchSettings, writeSettings, type Config, type Settings } from './config.ts';
import { modelResolver } from './models.ts';
import { createPlatform } from './platform.ts';
import { createHands } from './hands/index.ts';
import { Hearing } from './hearing/service.ts';
import { Keyword } from './hearing/keyword.ts';
import { VoiceRecordings } from './hearing/recordings.ts';
import { VoiceId, VoiceprintStore, type VoiceModels } from './hearing/voiceid.ts';
import { Initiative } from './initiative/index.ts';
import { IntegrationHub } from './integrations/hub.ts';
import { Journal, MemoryStore } from './memory/store.ts';
import { describeContext, Eyes } from './screen/eyes.ts';
import { connectionToken, refusal, tokenFile, windowOrigins } from './shell/access.ts';
import { readClientEvent } from './shell/events.ts';
import { Presence } from './shell/presence.ts';
import { serveUi, UI_DIR } from './shell/static.ts';
import { DEFAULT_REFLEX_MODEL, downloadModel, isInstalled, KOKORO_MODEL, MODELS, modelsDir, PARAKEET_MODEL, SMART_TURN_MODEL, VOICE_ID_MODEL, VOICE_ID_MODELS, whereInstalled } from './models/files.ts';
import { forgetLearned, loadReflex, reflexEmbedder, type ReflexRuntime } from './reflex/runtime.ts';
import { buildSnapshot, validateChanges } from './snapshot.ts';
import { Trust } from './trust/index.ts';
import { kokoro, sentences, stopVoice, synthesize } from './voice/tts.ts';

// Something that failed where nothing waited for it is logged, and Nova carries on. An exception
// nothing caught is survived when it's only a connection or a program that failed (a system call);
// anything else leaves the daemon in a state nobody knows, so it stops cleanly (Nova.app starts it again).
/** Stops the daemon cleanly: set once everything it has to stop exists. */
let shutdown: (code: number) => void = (code) => process.exit(code);
const why = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e));
process.on('unhandledRejection', (reason) => console.error(`  [daemon] something failed unnoticed: ${why(reason)}`));
process.on('uncaughtException', (error) => {
  const { syscall, code } = error as NodeJS.ErrnoException;
  if (syscall || code?.startsWith('ERR_STREAM_')) return console.error(`  [daemon] ${why(error)}`);
  console.error(`  [daemon] stopping after an unexpected error: ${why(error)}`);
  shutdown(1);
});

loadDotEnv(); // constants and secrets
const migrated = await migrateSettings(process.env);
/** What every client shows to connect: a secret only this user can read (see shell/access.ts). */
const wsToken = await connectionToken();
// Agents and models act through Nova's skills, with Nova's rules: tool calls come back here.
let toolHost: NovaBrain | undefined; // set once Nova is up
const tools: ToolHost = {
  specs: () => toolHost?.specs() ?? [],
  call: (name, args, caller) => (toolHost ? toolHost.call(name, args, caller) : Promise.resolve('Nova is still starting.')),
};
const bridge = await startBridge(tools);

async function readAgentsFile(file: string): Promise<Record<string, CustomAgentSpec>> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[agents] can't read ${file}: ${(e as Error).message}`);
    return {};
  }
}

interface Runtime {
  settings: Settings;
  /** Why the settings file can't be read; Nova runs on its defaults until it's fixed. */
  fileError?: string;
  config: Config;
  custom: Record<string, CustomAgentSpec>;
  reflex: ReflexRuntime;
  /** Whether Kokoro, Nova's voice, is here - and whether it came inside Nova.app. */
  voiceInstalled: boolean;
  voiceBundled: boolean;
  /** Whether hearing's downloadable models are installed. */
  parakeetInstalled: boolean;
  smartTurnInstalled: boolean;
  /** Paired agents, some kept running as brains; closed when a runtime with other agent settings replaces this one. */
  host: NovaAgentHost | null;
  /** What the host was made from: the same again, and the next runtime keeps it (and the brain's answer in progress). */
  agentsKey: string;
  options: NovaSettings;
}

/** The settings file as it is now, or why it can't be read. */
async function currentSettings(): Promise<{ settings: Settings; fileError?: string }> {
  try {
    return { settings: (await readSettings()) ?? {} };
  } catch (e) {
    return { settings: {}, fileError: (e as Error).message };
  }
}

/**
 * Everything Nova runs on: the settings file, plus constants and secrets from .env. The agents of
 * `previous` stay if nothing about them changed - saving an unrelated setting ("yes, always", say)
 * never restarts the brain mid-answer.
 */
async function buildRuntime(previous?: Runtime): Promise<Runtime> {
  const { settings, fileError } = await currentSettings();
  const config = loadConfig(settings, process.env);
  const custom = { ...(await readAgentsFile(config.agentsFile)), ...config.customAgents };
  const folders = [...(await findProjects(config.projectsDir, config.projects))];
  const agentsKey = JSON.stringify([config.agents, custom, folders, config.agentOptions, config.agentTaskTimeoutMs, config.name]);
  const kept = previous && previous.agentsKey === agentsKey;
  const agents = kept
    ? previous.host
    : await createAgentHost({
        names: config.agents,
        custom,
        projects: config.projects,
        projectsDir: config.projectsDir,
        options: config.agentOptions,
        bridge,
        taskTimeoutMs: config.agentTaskTimeoutMs,
        assistant: config.name,
      });
  try {
    return await finishRuntime(settings, fileError, config, custom, agents, agentsKey);
  } catch (e) {
    if (!kept) agents?.close(); // made for a runtime that never came: its agents go too
    throw e;
  }
}

async function finishRuntime(settings: Settings, fileError: string | undefined, config: Config, custom: Record<string, CustomAgentSpec>, agents: NovaAgentHost | null, agentsKey: string): Promise<Runtime> {
  const models = modelResolver(config.localProviders);

  // Who answers open questions: a paired agent (claude, codex, ...) or a model on one of the user's
  // local servers (lmstudio/...). Automatic (empty) means the default paired agent. Every one of them
  // gets Nova's tools.
  const id = config.brainModel === 'off' ? '' : config.brainModel || agents?.agents[0]?.name || '';
  let reasoning: ReasoningBrain | null = null;
  if (id && agents?.agents.some((a) => a.name === id)) {
    const brain = agents.brain(id);
    brain.warm?.(); // start it now, so the first question doesn't wait for it
    reasoning = brain;
  } else if (id) {
    const local = models.resolve(id);
    if (local) reasoning = new LlmReasoningBrain(local, id, config.name, tools);
    else console.warn(`  [answers] ${id} is neither a paired agent nor a model on one of your servers - nobody answers open questions.`);
  }

  const reflex = await loadReflex({ learn: config.learn });
  const voiceAt = await whereInstalled(KOKORO_MODEL);
  const voiceInstalled = voiceAt !== null;
  const [parakeetInstalled, smartTurnInstalled] = await Promise.all([isInstalled(PARAKEET_MODEL), isInstalled(SMART_TURN_MODEL)]);
  if (voiceInstalled) kokoro().catch((e) => console.warn(`  [voice] Kokoro didn't load: ${(e as Error).message}`)); // warm it up before the first reply
  const engine = createDecisionEngine({
    engine: config.engine,
    fallback: config.fallback,
    timeoutMs: config.timeoutMs,
    jevApiKey: config.jevKey,
    jevModel: config.jevModel,
    llmModel: config.decisionModel || undefined,
    resolveModel: models.resolve,
    reflex: reflex.model ?? undefined,
  });

  return {
    settings,
    fileError,
    config,
    custom,
    reflex,
    voiceInstalled,
    voiceBundled: voiceAt?.bundled ?? false,
    parakeetInstalled,
    smartTurnInstalled,
    host: agents,
    agentsKey,
    options: {
      name: config.name,
      engine,
      reasoning,
      agents,
      wakeWords: config.wakeWords,
      followUpMs: config.followUpMs,
      requireWakeWord: config.requireWakeWord,
      replyTimeoutMs: config.replyTimeoutMs,
      ui: config.ui,
      computerUse: config.hands.computerUse,
      askFirst: config.askFirst,
      talkShortcut: formatShortcut(config.presence.shortcut),
    },
  };
}

let runtime = await buildRuntime();
const port = runtime.config.port; // a constant from .env

const clients = new Set<WebSocket>();
const send = (ws: WebSocket, event: ServerEvent) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(event));
const broadcast = (event: ServerEvent) => {
  for (const ws of clients) send(ws, event);
};

// Nova's Mac app: while it's connected it hears and speaks for Nova, and windows only show what happens.
const presence = new Presence<WebSocket>({
  send,
  changed(app) {
    broadcast({ type: 'voice-owner', app }); // windows stop (or start) their own microphone and voice
    if (!app) initiative?.onAppGone();
    broadcastSnapshot();
  },
});
/** Reminders, the briefing, routines, agents reporting back - set up once Nova is. */
let initiative: Initiative | undefined;
/** Nova's voice goes to the Mac app while it's there - else to every window. */
const toVoice = (event: ServerEvent) => {
  for (const ws of presence.voice(clients)) send(ws, event);
};

// Replies are spoken in Kokoro's voice (it comes inside Nova.app): the daemon streams the audio
// sentence by sentence and Nova.app, or each window, plays it. Without it replies are shown, not spoken. A reply
// that's still being written (several "say" events with one id) keeps one audio stream, fed as
// sentences finish.
let speechCount = 0;
let speaking: string | null = null;
const speaksAloud = () => runtime.voiceInstalled;
const replies = new Map<string, { audio: string; said: number; seq: number; chain: Promise<unknown> }>();

function speakAloud(id: string, text: string, voice: string, deliver: (e: ServerEvent) => void, more: { first?: number; final?: boolean; stillWanted?: () => boolean } = {}) {
  return synthesize(text, { voice, speed: runtime.config.ui.rate, ...more, onChunk: (chunk) => deliver({ type: 'audio', id, ...chunk }) }).catch((e) =>
    deliver({ type: 'audio', id, seq: more.first ?? 0, sampleRate: 24_000, pcm: '', last: true, error: (e as Error).message }),
  );
}

// What Nova is saying, for hearing: talking over it stops it, and its own voice isn't mistaken for the user's.
let replyText = '';
/** What Nova is doing, so the talk shortcut knows whether it cuts in. */
let phase: Phase = 'idle';
function trackSpeech(event: ServerEvent) {
  if (event.type === 'phase') {
    phase = event.phase;
    initiative?.onPhase(event.phase); // news that waited for Nova to finish goes out now
  }
  if (event.type === 'say') {
    replyText = event.text;
    hearing?.setSpoken(replyText);
  } else if (event.type === 'phase' && event.phase !== 'speaking' && replyText) {
    replyText = '';
    hearing?.setSpoken(null);
  }
}

function emit(event: ServerEvent) {
  // What Nova did goes into the record, with how to take it back; windows get it without that.
  if (event.type === 'activity') return broadcast({ type: 'activity', item: trust.record(event.item, event.undo) });
  trackSpeech(event);
  if (event.type !== 'say' || !speaksAloud()) return broadcast(event);
  const key = event.id ?? `whole-${speechCount + 1}`;
  let reply = replies.get(key);
  if (!reply) {
    reply = { audio: `say-${++speechCount}`, said: 0, seq: 0, chain: Promise.resolve() };
    replies.set(key, reply);
    speaking = reply.audio;
  }
  broadcast({ ...event, audio: reply.audio });
  const fresh = event.text.slice(reply.said);
  const final = !event.partial;
  reply.said = event.text.length;
  if (final) replies.delete(key);
  const first = reply.seq;
  reply.seq += Math.max(1, sentences(fresh).length);
  const audio = reply.audio;
  reply.chain = reply.chain.then(() => speakAloud(audio, fresh, runtime.config.voice.kokoroVoice, toVoice, { first, final, stillWanted: () => speaking === audio }));
}

/** Something done from a window (not through Nova's words), for the record and the timeline. */
function note(label: string, status: ActivityItem['status']) {
  emit({ type: 'activity', item: { id: randomBytes(6).toString('hex'), at: Date.now(), label, status, by: 'you' } });
}

let hearing: Hearing | undefined; // set just below; emit() may run first

// Integrations: services every brain can use through Nova (Notion, Linear, ...), with Nova asking first.
let integrationsChanged = () => {}; // set once the Settings window can be told
const integrations = new IntegrationHub({
  env: process.env,
  redirectUri: () => `http://127.0.0.1:${runtime.config.port}/oauth/callback`,
  open: (url) => execFile('open', [url], () => {}),
  changed: () => integrationsChanged(),
});
integrations.configure(runtime.config.integrations);

// Memory: what the user said to remember (or agreed to), and past conversations - all on this Mac.
const home = dirname(settingsFile());
const memory = await new MemoryStore(join(home, 'memory.json'), () => reflexEmbedder(), new Journal(join(home, 'conversations'), () => runtime.config.memory.keepDays)).load();
memory.suggestions = runtime.config.memory.suggest;
const pruneJournal = () => memory.journal.prune().catch((e) => console.warn(`  [memory] couldn't tidy the conversation history: ${(e as Error).message}`));
void pruneJournal();

// Nova Eyes: what the user is working in, with each question, and the screen when they ask.
const eyes =
  osPlatform() === 'darwin'
    ? new Eyes({ skipTitles: () => [runtime.config.name], images: () => runtime.config.screen.images, onChange: () => broadcastSnapshot() })
    : null;

// Nova's hands: the Mac's settings, music, windows, files, the clipboard, Shortcuts, and using the computer.
// NOVA_DRY_RUN=1 (for trying Nova out) only says what they'd change.
const dryRun = process.env.NOVA_DRY_RUN === '1';
const hands = eyes
  ? createHands({
      eyes,
      config: () => runtime.config.hands,
      saveLayout: (name, windows) => saveSettings({ [`windows.layouts.${name}`]: windows }),
      projects: () => Object.fromEntries((runtime.host?.projects ?? []).flatMap((p) => ((path) => (path ? [[p, path]] : []))(runtime.host?.projectPath(p)))),
      name: () => runtime.config.name,
      broadcast,
      dryRun,
    })
  : null;

/** The notes that go with a question to the brain: what the user is working in, and related memories. */
async function notes(utterance: string): Promise<string | null> {
  const { config } = runtime;
  const seen = config.screen.context && eyes ? await eyes.context() : null;
  // A project in the window they're working in becomes the one agents work in, unless they named another.
  if (seen && !seen.isNova) initiative?.seen([seen.window, seen.page, seen.url], runtime.host?.projects ?? []);
  const context = describeContext(seen, config.name);
  const project = initiative?.notes();
  const memories = config.memory.useInAnswers ? memory.relevant(utterance) : [];
  const parts = [
    ...(context ? [context] : []),
    ...(project ? [project] : []),
    ...(memories.length ? [`Things the user asked ${config.name} to remember:\n${memories.map((m) => `- ${m.text}`).join('\n')}`] : []),
  ];
  return parts.length ? `[Notes from ${config.name} for this question - context, not the user's words]\n${parts.join('\n')}\n[End of notes]` : null;
}

// Trust: the record of what Nova did (and undoing it), snapshots of agents' projects, "yes, always".
const trust = await new Trust({
  home,
  config: () => runtime.config,
  broadcast,
  // Nobody waits for these ("yes, always" is saved while Nova carries on): a save that fails - the
  // settings file doesn't read as JSON, say - is logged and shown, and the rule holds until Nova restarts.
  save: (changes) =>
    saveSettings(changes).catch((e) => {
      console.warn(`  [trust] couldn't save to ${settingsFile()}: ${(e as Error).message}`);
      broadcast({ type: 'error', message: `Couldn't save that to Settings: ${(e as Error).message}` });
    }),
  projectPath: (name) => runtime.host?.projectPath(name),
}).load();
const platform = createPlatform();

initiative = new Initiative({
  home,
  config: () => runtime.config,
  presence: presence as never,
  broadcast,
  services: () => integrations.status().filter((s) => s.state === 'connected').map((s) => s.label),
  hasBrain: () => Boolean(runtime.options.reasoning),
  saveRoutine: (r) => saveSettings({ [`routines.${r.name}`]: { ...(r.phrase ? { phrase: r.phrase } : {}), ...(r.schedule ? { schedule: r.schedule } : {}), steps: r.steps } }),
  changed: () => snapshotsReady && broadcastSnapshot(),
});
let snapshotsReady = false;

// Nova's own looks a skill may change by voice ("make the text bigger"): these keys alone, each checked as Settings would.
const PREFS: Record<PrefKey, () => number> = { 'appearance.textSize': () => runtime.config.ui.textSize };
const prefs: PrefsService = {
  get: (key) => PREFS[key](),
  async set(key, value) {
    if (!Object.hasOwn(PREFS, key)) throw new Error(`${key} isn't one a skill may change.`);
    const problem = settingProblem(key, value);
    if (problem) throw new Error(`The text size ${problem}.`);
    await saveSettings({ [key]: value });
  },
};

const nova = new NovaBrain({
  ...runtime.options,
  ...initiative.options,
  ...trust.options,
  integrations,
  memory,
  screen: eyes,
  hands,
  prefs,
  notes,
  onTurn: (turn) => memory.journal.append(turn),
  platform,
  emit,
});
toolHost = nova;
initiative.nova = nova;
trust.wire({
  reminders: initiative.reminders,
  memory,
  platform,
  project: initiative.state,
  hands,
  prefs,
  saveRoutine: (name, routine) => saveSettings({ [`routines.${name}`]: routine ? { ...(routine.phrase ? { phrase: routine.phrase } : {}), ...(routine.schedule ? { schedule: routine.schedule } : {}), steps: routine.steps } : null }),
});
await nova.init();

/** Names worth recognising when the Mac hears you: the assistant, its wake words, apps, agents and projects. */
const vocabulary = () => [runtime.config.name, ...runtime.config.wakeWords, ...nova.apps, ...(runtime.host?.agents.flatMap((a) => [a.label, a.name]) ?? []), ...(runtime.host?.projects ?? [])];

// Voice ID: the user's voiceprint (on this Mac only), read before hearing starts so its first turn is checked too.
// Hearing starts without a wait between it and Settings' snapshots below: its status can come back at any await.
const voiceprints = new VoiceprintStore(join(dirname(settingsFile()), 'voiceprint.json'), VOICE_ID_MODEL);
await voiceprints.load();
// The master keyword (a hash of it): said in any voice, it turns Voice ID off until the user turns it back on.
const keyword = await new Keyword(join(dirname(settingsFile()), 'voiceid-keyword.json')).load();
// Recordings of the user's turns - only when they keep them (a week, then gone; all at once when switched off).
const recordings = new VoiceRecordings(join(dirname(settingsFile()), 'voice-recordings'), { on: () => runtime.config.voiceId.keepRecordings });
void recordings.sweep().catch(() => {});
setInterval(() => void recordings.sweep().catch(() => {}), 6 * 3600_000).unref();
/** Voice ID's models on this Mac: the hearing helper's, and the two the voiceprint worker runs (with how each hears). */
async function voiceModels(): Promise<VoiceModels | null> {
  const helper = (await isInstalled(VOICE_ID_MODEL)) ? join(modelsDir(), VOICE_ID_MODEL) : null;
  const worker = [];
  for (const [ear, kind] of [['wespeaker-resnet293', 'wespeaker'], ['titanet-large', 'nemo']] as const) {
    if (await isInstalled(ear)) worker.push({ ear, kind, file: join(modelsDir(), ear, Object.keys(MODELS[ear]!.files)[0]!) });
  }
  return helper || worker.length ? { helper, worker, complete: Boolean(helper) && worker.length === 2 } : null;
}
const voiceId = new VoiceId({
  store: voiceprints,
  label: 'WeSpeaker v2, WeSpeaker ResNet293 and NVIDIA TitaNet-Large',
  size: `${Math.round(VOICE_ID_MODELS.reduce((n, m) => n + Object.values(MODELS[m]!.files).reduce((s, f) => s + f.size, 0), 0) / 1e6)} MB`,
  models: voiceModels,
  recordings,
  enabled: () => runtime.config.voiceId.enabled,
  learning: () => runtime.config.voiceId.learn,
  name: () => runtime.config.name,
  shortcut: () => formatShortcut(runtime.config.presence.shortcut),
  ear: () => (presence.status ? 'Nova.app' : 'a window'),
  keyword,
  onOverride() {
    // Said aloud, as a notification, and in the record - whoever said it, the user hears of it.
    nova.tell("The master keyword: Voice ID is off. I'll hear anyone now - but nothing gets deleted, spent or allowed for good - until you turn it back on in Settings.");
    if (presence.status) {
      void initiative!.rpc.request('notify', { ref: '', title: 'Voice ID is off', body: 'Someone said the master keyword. Nova hears any voice until you turn Voice ID back on in Settings.', actions: [] }, 5000).catch(() => {});
    }
    emit({ type: 'activity', item: { id: randomBytes(6).toString('hex'), at: Date.now(), label: 'Voice ID turned off with the master keyword', status: 'done', by: 'someone, with the master keyword' } });
  },
  turnOn: () => saveSettings({ 'voiceId.enabled': true }),
  changed: () => snapshotsReady && broadcastSnapshot(),
});
await voiceId.refresh();

// Hearing on this Mac: the window streams its microphone, and finished turns come back to Nova.
let micOwner: WebSocket | null = null;
/** The walkthrough was offered this run. */
let welcomed = false;
hearing = new Hearing({
  status(status) {
    nova.reconfigure({ hearing: status });
    broadcast({ type: 'hearing', status });
    // Not while Nova is still starting: a window gets the whole of Settings when it connects.
    if (snapshotsReady) broadcastSnapshot();
  },
  transcript: (text, final) => broadcast({ type: 'transcript', text, final }),
  utterance: (text, explicit, speaker) => void nova.handle(text, explicit ? 'shortcut' : 'voice', speaker).catch((e) => console.warn(`  [nova] ${why(e)}`)),
  bargeIn() {
    broadcast({ type: 'barge-in' }); // windows stop the audio
    speaking = null; // and the rest of the reply isn't synthesized
    nova.interrupt();
  },
});
hearing.voice = voiceId;
hearing.configure(runtime.config.hearing, vocabulary(), runtime.config.wakeWords);

const voiceStatus = () => ({ model: KOKORO_MODEL, label: MODELS[KOKORO_MODEL]!.label, installed: runtime.voiceInstalled, bundled: runtime.voiceBundled });
const hearingStatus = () => ({
  status: hearing!.status,
  parakeet: { model: PARAKEET_MODEL, label: MODELS[PARAKEET_MODEL]!.label, installed: runtime.parakeetInstalled },
  smartTurn: { model: SMART_TURN_MODEL, label: MODELS[SMART_TURN_MODEL]!.label, installed: runtime.smartTurnInstalled },
});
const memoryStatus = async () => ({ items: [...memory.list()], conversations: await memory.journal.stats() });
const screenStatus = async () => {
  if (!eyes) return { available: false, running: false, permissions: null, message: 'Seeing the screen needs macOS.' };
  const { running, starting, permissions, problem } = await eyes.status();
  const message = problem ?? (running ? undefined : starting ? 'Nova Eyes is starting - the first time, it is built on this Mac.' : 'Nova Eyes starts when Nova first needs it.');
  return { available: true, running, permissions, message };
};
/** Nova's hands, for Settings: what Nova Eyes may do, the user's Shortcuts, saved layouts. */
const handsStatus = async (): Promise<SettingsSnapshot['hands']> => {
  if (!hands || !eyes) return { available: false, permissions: null, shortcuts: null, focus: {}, layouts: [], active: false, message: "Nova's hands need macOS." };
  const { shortcuts, focus } = await hands.status();
  const layouts = Object.entries(runtime.config.hands.layouts).map(([name, windows]) => ({ name, windows: windows.length, apps: [...new Set(windows.map((w) => w.app))] }));
  return { available: true, permissions: eyes.known, shortcuts, focus, layouts, active: hands.computer.status().active, ...(dryRun ? { message: 'Trying Nova out (NOVA_DRY_RUN=1): changes are only written to the log.' } : {}) };
};
/** Whether Nova.app is installed (in either Applications folder). */
const appInstalled = async () => {
  for (const dir of [join(homedir(), 'Applications'), '/Applications']) if (await stat(join(dir, 'Nova.app')).then(() => true, () => false)) return true;
  return false;
};
const snapshot = async () =>
  buildSnapshot(
    runtime.settings,
    runtime.config,
    runtime.custom,
    process.env,
    runtime.reflex,
    voiceStatus(),
    hearingStatus(),
    integrations.status(),
    await memoryStatus(),
    await screenStatus(),
    await handsStatus(),
    voiceId.status(),
    { app: presence.status },
    initiative!.snapshot(),
    {
      onboarded: initiative!.state.onboarded,
      appInstalled: await appInstalled(),
      paired: runtime.host?.agents ?? [],
      brain: runtime.options.reasoning?.name ?? null,
      trust: trust.snapshot(),
    },
    runtime.fileError,
  );

let snapshots = 0;
function broadcastSnapshot() {
  const n = ++snapshots; // probing servers takes a moment; only the newest snapshot goes out
  snapshot().then(
    (s) => n === snapshots && broadcast({ type: 'settings', snapshot: s }),
    (e) => console.warn(`  [settings] couldn't put Settings together: ${why(e)}`),
  );
}
// Reminders due while Nova was off come up once a window or Nova.app connects; routines and the briefing get their times.
snapshotsReady = true;
await initiative.load();

// Start Nova Eyes now (it's built the first time), so the first question already knows what's on screen.
if (runtime.config.screen.context) eyes?.warm();

// A service connected or its tools changed: tell the Settings window, and let agents kept running see the new tools.
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
integrationsChanged = () => {
  broadcastSnapshot();
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => runtime.host?.refresh(), 1500); // several changes at start-up: one refresh
};

/** Reflex's classifier trains in the background: tell the Settings window when it's ready. */
const whenTrained = (r: Runtime) =>
  void r.reflex.classifier.then(
    (trained) => trained && runtime === r && broadcastSnapshot(),
    (e) => console.warn(`  [reflex] its classifier didn't train: ${why(e)}`),
  );
whenTrained(runtime);

/** Switch to a new runtime live, and tell every window. */
function apply(next: Runtime) {
  if (runtime.host !== next.host) runtime.host?.close(); // agents kept running for the old settings
  const keptDays = runtime.config.memory.keepDays;
  runtime = next;
  whenTrained(next);
  nova.reconfigure(next.options);
  hearing!.configure(next.config.hearing, vocabulary(), next.config.wakeWords);
  integrations.configure(next.config.integrations);
  memory.suggestions = next.config.memory.suggest;
  if (next.config.memory.keepDays !== keptDays) void pruneJournal().then(broadcastSnapshot);
  presence.configure(next.config.presence);
  // Voice ID switched off in Settings: the master keyword's "off" goes with it, so switching it on is simply on.
  if (!next.config.voiceId.enabled && voiceId.overridden()) void voiceId.restore();
  // Recordings switched off: every one of them goes, now.
  if (!next.config.voiceId.keepRecordings) void recordings.clear().catch(() => {});
  initiative!.configure();
  trust.configure();
  broadcast(nova.hello());
  broadcastSnapshot();
  banner();
}

let pending: Promise<unknown> = Promise.resolve();
/** Changes to the runtime happen one at a time. */
function queue<T>(task: () => Promise<T>): Promise<T> {
  const run = pending.then(task);
  pending = run.catch(() => {});
  return run;
}

/** Save changes from the Settings window into the settings file and apply them. */
function saveSettings(changes: unknown) {
  return queue(async () => {
    validateChanges(changes);
    const settings = (await readSettings()) ?? {}; // throws for a broken file, so it's never overwritten
    for (const [key, value] of Object.entries(changes)) setPath(settings, key, value ?? undefined);
    await writeSettings(settings);
    apply(await buildRuntime(runtime));
  });
}

/** Download Reflex's embedding model (checked against its pinned checksums) and switch to it. */
function installReflex(progress: (message: string) => void) {
  return queue(async () => {
    let shown = -1;
    await downloadModel(DEFAULT_REFLEX_MODEL, {
      onProgress(file, received, total) {
        const pct = Math.floor((received / total) * 5) * 20;
        if (file === 'model.safetensors' && pct !== shown) progress(`Downloading Reflex… ${(shown = pct)}%`);
      },
    });
    apply(await buildRuntime(runtime));
    return runtime.reflex.model ? 'Reflex is installed and making decisions.' : "Reflex downloaded, but it didn't load - see the daemon log.";
  });
}

/** Download a model for hearing (checked against its pinned checksums) and start using it. */
function installHearing(model: 'parakeet' | 'smart-turn', progress: (message: string) => void) {
  return queue(async () => {
    const name = model === 'parakeet' ? PARAKEET_MODEL : SMART_TURN_MODEL;
    const spec = MODELS[name]!;
    const big = Object.entries(spec.files).sort((a, b) => b[1].size - a[1].size)[0]![0];
    let shown = -1;
    await downloadModel(name, {
      onProgress(file, received, total) {
        const pct = Math.floor((received / total) * 10) * 10;
        if (file === big && pct !== shown) progress(`Downloading ${model === 'parakeet' ? 'Parakeet' : 'Smart Turn'}… ${(shown = pct)}%`);
      },
    });
    apply(await buildRuntime(runtime));
    if (model === 'parakeet') hearing!.retry(); // it may have been waiting for this
    return model === 'parakeet'
      ? 'Parakeet is installed. Choose it in Settings → Hearing → Speech recognition.'
      : 'Smart Turn is installed - Nova now hears when you have finished.';
  });
}

function forgetReflex() {
  return queue(async () => {
    await forgetLearned(runtime.reflex.model);
    broadcastSnapshot();
    return 'Reflex forgot what it learned.';
  });
}

// Edits made by hand apply as soon as the file is saved.
watchSettings(() =>
  queue(async () => {
    // Compared before anything is built: Nova's own save (already applied) starts no second set of agents.
    const { settings, fileError } = await currentSettings();
    if (JSON.stringify([settings, fileError]) === JSON.stringify([runtime.settings, runtime.fileError])) return;
    console.log(`  [settings] ${settingsFile()} changed - applying it`);
    apply(await buildRuntime(runtime));
  }).catch((e) => console.warn(`  [settings] ${(e as Error).message}`)),
);

// Any web page can try to reach localhost, so every client shows the connection secret (a file only
// this user can read) and, if it's a page, is one of Nova's own windows: the dev server's or the one
// the daemon serves (NOVA_UI_ORIGINS). Programs on this Mac - Nova.app - send no Origin. Only those
// connect, so everything a client can do - speak for the user, change settings, read memories - is
// theirs alone; being Nova's ears and voice (shell-hello) is Nova.app's alone.
const windows = windowOrigins(process.env, port);

const page = (title: string, message: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;color:#222"><div><h2>${title}</h2><p>${message}</p></div></body>`;
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The daemon's own address: WebSocket for windows, and the page the browser returns to after signing in.
async function respond(req: IncomingMessage, res: ServerResponse) {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://127.0.0.1');
  } catch {
    return void res.writeHead(400).end(); // not an address at all, e.g. "//%"
  }
  if (req.method === 'GET' && url.pathname === '/oauth/callback') {
    const done = await integrations
      .completeSignIn(url.searchParams.get('state') ?? '', url.searchParams.get('code'), url.searchParams.get('error'))
      .catch((e: Error) => ({ ok: false, message: e.message }));
    res.writeHead(done.ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
    return void res.end(page(done.ok ? 'Connected' : "Couldn't connect", escape(done.message)));
  }
  if (await serveUi(req, res, port, UI_DIR, wsToken)) return;
  res.writeHead(404).end();
}
const http = createServer((req, res) => {
  respond(req, res).catch((e) => {
    console.warn(`  [http] ${why(e)}`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
const wss = new WebSocketServer({
  server: http,
  verifyClient: ({ origin, req }: { origin?: string; req: IncomingMessage }, done: (ok: boolean, code?: number, message?: string) => void) => {
    const refused = refusal(origin, req.url, wsToken, windows);
    if (refused) done(false, refused, refused === 401 ? 'Unauthorized' : 'Forbidden');
    else done(true);
  },
});
// Another daemon has the port (or it can't be had): a daemon nobody can reach is no use.
http.on('error', (e: NodeJS.ErrnoException) => {
  console.error(e.code === 'EADDRINUSE' ? `  [daemon] port ${port} is in use - is Nova already running?` : `  [daemon] ${why(e)}`);
  shutdown(1);
});
wss.on('error', () => {}); // the same error, passed on by the WebSocket server: handled just above
http.listen(port, '127.0.0.1');

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  // verifyClient already turned away everyone else; this is the same rule, where events are handled.
  if (refusal(origin, req.url, wsToken, windows)) return ws.close(1008, 'Not one of Nova’s windows');
  /** A program on this Mac rather than a page: only it may be Nova's ears and voice. */
  const native = origin === undefined;
  clients.add(ws);
  initiative!.onListener(); // someone can hear now: reminders that came due while Nova was off
  send(ws, nova.hello());
  send(ws, { type: 'voice-owner', app: presence.connected });
  send(ws, { type: 'tasks', tasks: initiative!.tasks.list().slice(0, 50) });
  send(ws, { type: 'activity-history', items: trust.actions.history(200) });
  ws.on('close', () => {
    clients.delete(ws);
    if (micOwner === ws) (micOwner = null), hearing!.pause();
    presence.detach(ws);
  });
  // A broken connection (a bad frame, a reset) ends only that connection.
  ws.on('error', (e) => console.warn(`  [ws] ${e.message}`));

  /** One event from this client, already checked to be one Nova understands. */
  const onEvent = async (event: ClientEvent) => {
    // Speech a window recognised itself never reached Voice ID's ear: with Voice ID on it can't count as the
    // user (the talk shortcut still does). Typing is the user at the keyboard.
    if (event.type === 'utterance') {
      // A window's own speech recognition: the master keyword works here too; otherwise, with Voice ID on, the voice
      // can't be checked - unless Voice ID is off since the keyword, when any voice is heard (held back).
      const rest = event.source === 'voice' ? voiceId.unlock(event.text) : null;
      if (rest !== null) {
        if (rest) await nova.handle(rest, 'voice', 'anyone');
      } else await nova.handle(event.text, event.source, event.source === 'voice' && voiceId.status().on ? (voiceId.overridden() ? 'anyone' : 'unchecked') : undefined);
    }
    else if (event.type === 'audio-start') {
      // The latest window to start its microphone hears for Nova - unless the Mac app does.
      if (presence.mayListen(ws)) micOwner = ws;
    }
    else if (event.type === 'audio-stop') {
      if (micOwner === ws) (micOwner = null), hearing!.pause();
    }
    else if (event.type === 'speech-finished') nova.speechFinished();
    else if (event.type === 'shell-hello') {
      // A page can't take over Nova's microphone, voice and the app's requests - only Nova.app can.
      if (!native) return send(ws, { type: 'error', message: 'Only Nova.app hears and speaks for Nova.' });
      presence.attach(ws, event.version, runtime.config.presence);
      // A first run: the app opens its window on the walkthrough (once).
      if (presence.isApp(ws) && !initiative!.state.onboarded && !welcomed) {
        welcomed = true;
        send(ws, { type: 'show', panel: 'welcome' });
      }
    }
    else if (event.type === 'shell-status') {
      const first = presence.isApp(ws) && !presence.status;
      if (presence.report(ws, event.status)) {
        if (first || event.status.access?.reminders === 'granted') initiative!.onAppConnected();
        broadcastSnapshot();
      }
    } else if (event.type === 'shell-reply') {
      if (presence.isApp(ws)) initiative!.rpc.reply(event.id, event.ok, event.result, event.error);
    } else if (event.type === 'shell-context') {
      if (presence.isApp(ws)) initiative!.onContext(event.context);
    } else if (event.type === 'notification-action') {
      if (presence.isApp(ws)) await initiative!.onNotification(event.ref, event.action);
    } else if (event.type === 'task-cancel' || event.type === 'task-retry' || event.type === 'reminder-cancel') {
      if (event.type === 'task-cancel') initiative!.cancelTask(event.id);
      else if (event.type === 'task-retry') {
        if (!initiative!.retryTask(event.id)) send(ws, { type: 'settings-result', ok: false, message: "That task can't be run again - its agent or project is gone." });
      } else if (await initiative!.reminders.cancel(event.id)) broadcastSnapshot();
    } else if (event.type === 'activity-undo') {
      const action = trust.actions.recent(7).find((a) => a.id === event.id);
      const result = await trust.actions.undo(event.id);
      if (result.ok && action) note(`Undid: ${action.label}`, 'done');
      send(ws, { type: 'settings-result', ok: result.ok, message: result.message });
    } else if (event.type === 'activity-search') {
      const query = String(event.query ?? '').slice(0, 200);
      send(ws, { type: 'activity-found', query, items: await trust.actions.search(query, Math.min(Math.max(Number(event.days) || runtime.config.trust.keepDays, 1), 3650)) });
    } else if (event.type === 'stop-all') {
      // The stop shortcut, or the Stop everything button: no words needed, nothing asked.
      hearing!.drop();
      speaking = null;
      nova.stopEverything();
    } else if (event.type === 'setup-done') {
      initiative!.state.setUp();
      broadcastSnapshot();
    } else if (event.type === 'talk-start') {
      // The shortcut went down: Nova stops talking (or thinking) and listens to what comes next.
      if (phase === 'speaking' || phase === 'thinking') {
        broadcast({ type: 'barge-in' });
        speaking = null;
        hearing!.setSpoken(null);
        nova.interrupt();
      } else nova.listenNow();
      hearing!.hold();
    } else if (event.type === 'talk-end') hearing!.release(event.held);
    else if (event.type === 'listen-stop') {
      hearing!.drop();
      nova.stopListening();
    } else if (event.type === 'shell-action') {
      if (!presence.action(event.action)) send(ws, { type: 'settings-result', ok: false, message: "Nova.app isn't running - open it, or install it with npm run app." });
    }
    else if (event.type === 'cancel') {
      speaking = null; // stop synthesizing the rest of the reply
      nova.cancel();
    }
    else if (event.type === 'voice-preview') {
      // Played where Nova's voice plays (Nova.app's echo canceller knows it), and heard as Nova speaking - never as a request.
      const text = `Hi, I'm ${runtime.config.name}. This is how I sound.`;
      hearing?.setSpoken(text);
      void speakAloud(event.id, text, event.voice, presence.connected ? toVoice : (e) => send(ws, e)).finally(() => hearing?.setSpoken(replyText || null));
    }
    else if (event.type === 'settings-get') send(ws, { type: 'settings', snapshot: await snapshot() });
    else if (event.type === 'settings-set') {
      try {
        await saveSettings(event.values);
        send(ws, { type: 'settings-result', ok: true, message: 'Saved' });
      } catch (error) {
        send(ws, { type: 'settings-result', ok: false, message: (error as Error).message });
      }
    } else if (event.type === 'memory-edit' || event.type === 'memory-delete' || event.type === 'memory-clear' || event.type === 'conversations-clear') {
      if (event.type === 'memory-edit') memory.edit(event.id, event.text);
      else if (event.type === 'memory-delete') memory.forget(event.id);
      else if (event.type === 'memory-clear') await memory.clear();
      else await memory.journal.clear();
      send(ws, { type: 'settings-result', ok: true, message: event.type === 'conversations-clear' ? 'Conversation history cleared.' : 'Saved' });
      broadcastSnapshot();
    } else if (event.type === 'hands-refresh') {
      hands?.shortcuts.forget(); // a shortcut made just now: read the list again
      broadcastSnapshot();
    } else if (event.type === 'screen-permission' || event.type === 'screen-restart' || event.type === 'screen-preview') {
      if (!eyes) return send(ws, { type: 'settings-result', ok: false, message: 'Seeing the screen needs macOS.' });
      try {
        if (event.type === 'screen-preview') {
          const { config } = runtime;
          const seen = config.screen.context ? describeContext(await eyes.context(), config.name) : null;
          const text = !config.screen.context
            ? `Nothing: sharing what you're working in is off, so ${config.name}'s brains only hear your words.`
            : (seen ?? `Nothing right now: nothing you're working in is in front (${config.name}'s own window, or the screen is locked), or Nova Eyes isn't running yet.`);
          return send(ws, { type: 'screen-preview', text });
        }
        const wasRunning = eyes.running;
        if (event.type === 'screen-restart') eyes.restart();
        else await eyes.permissions([event.kind]);
        send(ws, {
          type: 'settings-result',
          ok: true,
          message:
            event.type === 'screen-restart'
              ? wasRunning
                ? 'Nova Eyes restarted.'
                : 'Starting Nova Eyes.'
              : event.kind === 'screen'
                ? 'Turn on Nova Eyes in System Settings → Privacy & Security → Screen Recording, then press Restart Nova Eyes.'
                : 'Turn on Nova Eyes in System Settings → Privacy & Security → Accessibility.',
        });
        setTimeout(broadcastSnapshot, 800);
      } catch (error) {
        send(ws, { type: 'settings-result', ok: false, message: (error as Error).message });
      }
    } else if (event.type === 'integration-sign-in' || event.type === 'integration-sign-out' || event.type === 'integration-retry') {
      try {
        if (event.type === 'integration-sign-in') {
          await integrations.signIn(event.name);
          send(ws, { type: 'settings-result', ok: true, message: 'Sign in in the browser window that opened.' });
        } else if (event.type === 'integration-sign-out') {
          await integrations.signOut(event.name);
          send(ws, { type: 'settings-result', ok: true, message: 'Signed out.' });
        } else {
          loadDotEnv(); // a token just added to .env counts (values already set stay as they were)
          integrations.retry(event.name);
        }
      } catch (error) {
        send(ws, { type: 'settings-result', ok: false, message: (error as Error).message });
      }
    } else if (event.type === 'voiceid') {
      // Voice ID: its model (pinned, checked), learning the user's voice, testing it, forgetting it - and the master
      // keyword: set (hashed at once), cleared, and Voice ID turned back on after it was said.
      try {
        const progress = (message: string) => send(ws, { type: 'settings-result', ok: true, message });
        let message = '';
        if (event.action === 'install') {
          // Its three models, one after another (each file checked against its checksum), with progress on the big files.
          for (const [i, name] of VOICE_ID_MODELS.entries()) {
            let shown = -1;
            await downloadModel(name, {
              onProgress(_file, received, total) {
                const pct = Math.floor((received / total) * 5) * 20;
                if (total > 1_000_000 && pct !== shown) progress(`Downloading Voice ID (${i + 1} of ${VOICE_ID_MODELS.length})… ${(shown = pct)}%`);
              },
            });
          }
          await voiceId.refresh();
          hearing?.voiceWanted();
          message = 'Voice ID is ready to learn your voice.';
        } else if (event.action === 'enroll' || event.action === 'improve' || event.action === 'test') {
          // Voiceprints come from Nova's own hearing: a browser's speech recognition never passes the voice on.
          if (hearing!.status.engine === 'browser') throw new Error("Voice ID needs Nova's own hearing - Nova.app, or Settings → Hearing on Apple or Parakeet.");
          message = event.action === 'enroll' ? await voiceId.start() : event.action === 'improve' ? await voiceId.improve() : await voiceId.test();
          hearing!.voiceWanted(); // every model ready for the first phrase
        }
        else if (event.action === 'cancel') (voiceId.cancel(), (message = 'Stopped.'));
        else if (event.action === 'keyword-set') {
          await voiceId.setKeyword(event.keyword ?? '');
          message = 'The master keyword is set - only a hash of it is kept.';
        } else if (event.action === 'keyword-clear') (await voiceId.clearKeyword(), (message = 'There is no master keyword now.'));
        else if (event.action === 'override-end') (await voiceId.restore(), (message = 'Voice ID is back on: Nova answers your voice alone.'));
        else (await voiceId.forget(), await saveSettings({ 'voiceId.enabled': false }), (message = 'Your voiceprint is gone.'));
        broadcastSnapshot();
        send(ws, { type: 'settings-result', ok: true, message });
      } catch (error) {
        send(ws, { type: 'settings-result', ok: false, message: (error as Error).message });
      }
    } else if (event.type === 'reflex-install' || event.type === 'reflex-forget' || event.type === 'hearing-install') {
      try {
        const progress = (message: string) => send(ws, { type: 'settings-result', ok: true, message });
        const done =
          event.type === 'reflex-install' ? installReflex(progress) : event.type === 'hearing-install' ? installHearing(event.model, progress) : forgetReflex();
        send(ws, { type: 'settings-result', ok: true, message: await done });
      } catch (error) {
        send(ws, { type: 'settings-result', ok: false, message: (error as Error).message });
      }
    }
  };

  ws.on('message', (raw, isBinary) => {
    // Microphone audio from the window that hears for Nova.
    if (isBinary) {
      if (ws === micOwner) hearing!.audio(raw as Buffer);
      return;
    }
    const event = readClientEvent(String(raw));
    if (!event) return console.warn("  [ws] ignored a message that isn't one Nova understands");
    onEvent(event).catch((e) => {
      console.warn(`  [ws] ${event.type}: ${why(e)}`);
      send(ws, { type: 'error', message: `That didn't work: ${(e as Error).message}` });
    });
  });
});

// Ctrl+C, tsx watch restarting after an edit, or an error nothing could handle: stop the voice
// process and the agents kept running, and let what was just said to remember get to disk first.
let stopping = false;
shutdown = (code) => {
  if (stopping) return;
  stopping = true;
  for (const stop of [stopVoice, () => hearing?.close(), () => integrations.close(), () => eyes?.close(), () => runtime.host?.close(), () => initiative?.close(), () => trust.close()]) {
    try {
      stop();
    } catch (e) {
      console.warn(`  [daemon] while stopping: ${why(e)}`);
    }
  }
  void Promise.race([Promise.all([memory.flushed(), initiative?.flushed(), trust.flushed(), voiceprints.flush(), recordings.flushed()]), new Promise((r) => setTimeout(r, 1000))]).finally(() => process.exit(code));
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => shutdown(0));

function banner() {
  const { config, options } = runtime;
  const agents = options.agents;
  console.log(`
  Nova daemon  ws://127.0.0.1:${port} · clients show the secret in ${tokenFile()}
  Settings     ${settingsFile()}
  Name         ${config.name}
  System 1     ${options.engine.name}${runtime.reflex.model ? ` · learned ${runtime.reflex.model.learned.length}` : ['auto', 'reflex'].includes(config.engine) ? ' (install Reflex: npm run reflex:download, or Settings → Decisions)' : ''}
  System 2     ${options.reasoning?.name ?? '(none - choose one in Settings → Answers)'}
  Hearing      ${runtime.config.hearing.engine === 'browser' ? "the browser's speech recognition" : runtime.config.hearing.engine === 'parakeet' ? 'Parakeet, on this Mac' : "Apple's on-device recognizer"}${runtime.smartTurnInstalled && runtime.config.hearing.smartTurn ? ' · Smart Turn' : ''}
  Voice        ${speaksAloud() ? `Kokoro · ${config.voice.kokoroVoice}${runtime.voiceBundled ? ' (inside Nova.app)' : ''}` : 'Kokoro comes with Nova.app (npm run app) - until then replies are shown, not spoken'}
  Apps found   ${nova.apps.length}
  Hands        ${hands ? (dryRun ? 'dry run (NOVA_DRY_RUN=1) - changes are only logged' : `on${config.hands.computerUse ? ', and brains may use the computer (with a yes)' : ''}`) : '(needs macOS)'}
  Integrations ${runtime.config.integrations && Object.keys(runtime.config.integrations).length ? Object.keys(runtime.config.integrations).join(', ') : '(none - add them in Settings → Integrations)'}
  Agents       ${agents ? `${agents.agents.map((a, i) => (i ? a.label : `${a.label} (default)`)).join(', ')} · ${agents.projects.length} projects` : '(none - install Claude Code, Codex, OpenCode or Gemini CLI)'}
  Wake words   ${config.requireWakeWord ? `${config.wakeWords.join(', ')} · then ${config.followUpMs / 1000}s without` : 'not needed (conversation mode)'}
`);
  for (const problem of runtime.fileError ? [runtime.fileError] : config.warnings) console.warn(`  [settings] ${problem}`);
}
banner();
trust.start();

if (migrated?.moved.length) console.log(`  [settings] moved ${migrated.moved.join(', ')} from .env into ${settingsFile()}`);
if (migrated?.retired.length) console.log(`  [settings] took ${migrated.retired.join(', ')} out of ${settingsFile()} - Nova speaks only with Kokoro now`);
if (migrated?.secrets.length) {
  console.warn(`  [settings] the old settings file held ${migrated.secrets.join(', ')} - secrets belong in .env now, so add them there (a copy is in ${migrated.backup})`);
}
const ignored = settingsInEnv(process.env);
if (ignored.length) console.log(`  [settings] .env holds constants only now; these entries are ignored and can be deleted: ${ignored.join(', ')}`);
