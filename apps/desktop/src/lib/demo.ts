import type { TaskRecord } from '@nova/core';
import type { ActivityItem, DecisionTrace, ServerEvent } from '@nova/core/protocol';
import { pairingLink } from '@nova/core/phone';
import { COLLECTIONS, FIELDS, type SettingsSnapshot, type SettingValue } from '@nova/core/settings';

/**
 * A scripted session for design work without the daemon: open http://localhost:5173/#demo. Three things
 * said - an app Reflex opens at once, a question Claude answers, a task for Claude that then asks before it
 * runs a command - and made-up settings, so every panel has something to show. The README's pictures are
 * taken from it (`npm run readme:media`).
 */

const now = Date.now();
const MINUTE = 60_000;

const probs = (keys: string[], pick: string, p: number) =>
  Object.fromEntries(keys.map((k) => [k, k === pick ? p : (1 - p) / (keys.length - 1)]));
const intents = ['open_app', 'quit_app', 'set_timer', 'agent_task', 'tell_time', 'stop', 'confirm_yes', 'chat', 'other'];
const choice = (keys: string[], pick: string, p: number) => ({ type: 'choice', choice: pick, probabilities: probs(keys, pick, p) });

/** What Reflex decided: the intent, anything it named, and whether it was said to Nova. */
const decided = (utterance: string, outcome: string, intent: string, p: number, latencyMs: number, named: Record<string, unknown> = {}): ServerEvent => ({
  type: 'decision',
  trace: {
    utterance,
    engine: 'reflex (potion-base-8M)',
    latencyMs,
    fellBack: false,
    outcome,
    answers: { intent: choice(intents, intent, p), ...named, addressed: { type: 'boolean', probability: 0.99 } },
  } satisfies DecisionTrace,
});

/** Someone says it: the words as they come, then the finished turn. */
const said = (at: number, words: string[]): Array<[number, ServerEvent]> =>
  words.map((text, i) => [at + i * 350, { type: 'transcript', text, final: i === words.length - 1 }]);

const done = (id: string, at: number, label: string, skill: string, tier: 0 | 1 | 2 | 3, by = 'you'): ServerEvent => ({
  type: 'activity',
  item: { id, at, label, status: 'done', skill, tier, by } satisfies ActivityItem,
});

const earlierTask: TaskRecord = {
  id: 't0',
  agent: 'codex',
  label: 'Codex',
  project: 'mobile-app',
  task: 'update the README for the new sign-in flow',
  status: 'done',
  report: 'Updated README.md: the sign-in section, and a screenshot of the new flow.',
  started: now - 52 * MINUTE,
  ended: now - 47 * MINUTE,
};
const claudeTask = (step: string): TaskRecord => ({
  id: 't1',
  agent: 'claude',
  label: 'Claude',
  project: 'website',
  task: 'fix the failing test',
  status: 'running',
  step,
  started: now + 9650,
});

const QUESTION = "What's the difference between a merge and a rebase?";
const ANSWER = [
  'A merge joins the two branches with a new commit, and keeps both histories as they were.',
  'A rebase replays your commits on top of the other branch instead, for one straight line.',
];

/** When the demo's "you" is talking, in ms from the start: the Orb follows a voice then (see `demoVoice`). */
const TALKING: Array<[number, number]> = [
  [600, 1700],
  [3000, 4450],
  [8300, 9400],
];

export const demoScript: Array<[number, ServerEvent]> = [
  [0, { type: 'hello', name: 'Nova', engine: 'reflex (potion-base-8M) → heuristic', brain: 'Claude', apps: 142, wakeWords: ['hey nova', 'nova'], requireWakeWord: true, agents: [{ name: 'claude', label: 'Claude' }, { name: 'codex', label: 'Codex' }], projects: ['website', 'mobile-app', 'Agentic_OS'], hearing: { engine: 'parakeet', state: 'ready' },
      ui: { autoListen: false, rate: 1.05, lang: 'en-US', orb: { style: 'particles', colors: 'nova', motion: 'lively', size: 100, floatingSize: 100 }, textSize: 100, cardSeconds: 8 } }],
  [0, { type: 'settings', snapshot: demoSettings() }],
  [0, { type: 'tasks', tasks: [earlierTask] }],
  [0, { type: 'activity-history', items: [
    { id: 'a-2', at: now - 47 * MINUTE, label: 'Codex finished in mobile-app: update the README for the new sign-in flow', status: 'done', skill: 'agent_task', tier: 2, by: 'you', undoable: true, files: ['README.md'] },
    { id: 'a-1', at: now - 31 * MINUTE, label: 'Volume to 30%', status: 'done', skill: 'system_control', tier: 1, by: 'you', undoable: true },
    { id: 'a-0', at: now - 12 * MINUTE, label: 'Safari on the left, Slack on the right', status: 'done', skill: 'window_control', tier: 1, by: 'you', undoable: true },
  ] }],

  // "Hey Nova, open Figma." - Reflex decides on the Mac, in a few milliseconds.
  [400, { type: 'phase', phase: 'listening' }],
  ...said(600, ['Hey Nova', 'Hey Nova, open', 'Hey Nova, open Figma', 'Hey Nova, open Figma.']),
  [1750, { type: 'phase', phase: 'thinking' }],
  [1780, decided('open Figma', 'open_app → Figma (p=0.97)', 'open_app', 0.97, 3, { app: choice(['none', 'Figma', 'Safari', 'Slack', 'Spotify', 'Visual Studio Code'], 'Figma', 0.98) })],
  [1820, { type: 'phase', phase: 'acting', label: 'open_app' }],
  [1950, { type: 'card', card: { id: 'c1', kind: 'app', title: 'Figma', body: 'Opened' } }],
  [1960, done('a1', now + 1960, 'Opened Figma', 'open_app', 1)],
  [2000, { type: 'say', text: 'Opening Figma.' }],
  [2000, { type: 'phase', phase: 'speaking' }],

  // Then, without the wake word (Nova keeps listening after a reply), a question: Claude answers it.
  [2800, { type: 'phase', phase: 'listening' }],
  ...said(3000, ["What's the difference", "What's the difference between a merge", "What's the difference between a merge and a", "What's the difference between a merge and a rebase", QUESTION]),
  [4500, { type: 'phase', phase: 'thinking', label: 'Claude' }],
  [4520, decided("what's the difference between a merge and a rebase", 'chat', 'chat', 0.91, 2)],
  [6100, { type: 'say', id: 's2', text: ANSWER[0]!, partial: true }],
  [6100, { type: 'phase', phase: 'speaking' }],
  [7000, { type: 'say', id: 's2', text: ANSWER.join(' ') }],
  [7000, { type: 'card', card: { id: 'c2', kind: 'answer', title: QUESTION, body: ANSWER.join(' ') } }],
  [7010, done('a2', now + 7010, 'Asked Claude', 'chat', 0)],

  // "Ask Claude to fix the failing test in the website." - and Claude asks before it runs a command.
  [8100, { type: 'phase', phase: 'listening' }],
  ...said(8300, ['Ask Claude', 'Ask Claude to fix the failing', 'Ask Claude to fix the failing test in', 'Ask Claude to fix the failing test in the website.']),
  [9450, { type: 'phase', phase: 'thinking' }],
  [9480, decided('ask claude to fix the failing test in the website', 'agent_task → Claude · website (p=0.94)', 'agent_task', 0.94, 3, {
    agent: choice(['none', 'Claude', 'Codex'], 'Claude', 0.97),
    project: choice(['none', 'website', 'mobile-app', 'Agentic_OS'], 'website', 0.95),
  })],
  [9520, { type: 'phase', phase: 'acting', label: 'agent_task' }],
  [9650, { type: 'card', card: { id: 't1', kind: 'task', title: 'Claude · website', body: 'Reading test/checkout.test.ts', agent: 'claude' } }],
  [9650, { type: 'tasks', tasks: [claudeTask('Reading test/checkout.test.ts'), earlierTask] }],
  [9660, done('a3', now + 9660, 'Asked Claude in website: fix the failing test', 'agent_task', 2)],
  [9700, { type: 'say', text: "Claude's on it, in website." }],
  [9700, { type: 'phase', phase: 'speaking' }],
  [10600, { type: 'phase', phase: 'listening' }],
  [11300, { type: 'card', card: { id: 't1', kind: 'task', title: 'Claude · website', body: 'Fixed the date parsing in src/checkout.ts', agent: 'claude' } }],
  [11300, { type: 'tasks', tasks: [claudeTask('Fixed the date parsing in src/checkout.ts'), earlierTask] }],
  [11800, { type: 'card', card: { id: 'c3', kind: 'confirm', title: 'Claude wants to run npm test in website. Allow it?', body: 'Say "yes" or "no"' } }],
  [11810, { type: 'activity', item: { id: 'a4', at: now + 11810, label: 'Claude: run npm test in website? (awaiting confirmation)', status: 'pending', skill: 'agent_command', tier: 2, by: 'Claude' } }],
  [11850, { type: 'say', text: 'Claude wants to run npm test in website. Allow it?' }],
  [11850, { type: 'phase', phase: 'speaking' }],
  [13700, { type: 'phase', phase: 'listening' }],
];

/** The microphone's level while the demo's "you" talks - syllables, so the Orb ripples as it does for a voice. */
export function demoVoice(level: { current: number }) {
  const start = performance.now();
  let frame = 0;
  const tick = (at: number) => {
    const t = at - start;
    const talking = TALKING.some(([from, to]) => t >= from && t <= to);
    level.current = talking ? 0.12 + 0.3 * Math.max(0, Math.sin(t / 42)) * (0.6 + 0.4 * Math.sin(t / 290)) : 0;
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}

/** Made-up settings for the demo: what the daemon would send for a Mac with Nova.app, Claude and Codex, set up. */
function demoSettings(): SettingsSnapshot {
  const values: Record<string, SettingValue> = {
    ...Object.fromEntries(FIELDS.map((f) => [f.key, f.default])),
    ...COLLECTIONS,
    'voice.wakeWords': ['hey nova', 'nova'],
    'hearing.engine': 'parakeet',
    'agents.enabled': ['claude', 'codex'],
    'projects.folder': '~/dev',
    'initiative.town': 'Lisbon',
    'phone.enabled': true,
    routines: { 'start work': { phrase: 'start work', steps: ['open Slack', 'brief me'] } },
    'integrations.servers': { github: { url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${NOVA_GITHUB_TOKEN}' } } },
  };
  const thisMac = 'this Mac';
  const claude = 'Anthropic, through Claude - on your own plan';
  return {
    values,
    saved: { 'hearing.engine': true, 'agents.enabled': true, 'initiative.town': true, routines: true, 'integrations.servers': true },
    secrets: { NOVA_JEV_API_KEY: false, NOVA_LMSTUDIO_API_KEY: false },
    file: '~/.nova/settings.json',
    problems: [],
    constants: { port: 7878, envFile: '.env', ignored: [] },
    reflex: { model: 'potion-base-8M', label: 'potion-base-8M · English · 31 MB', installed: true, sentences: true, learned: 31, taught: 6, phrasings: 10412, trained: true },
    voice: { model: 'kokoro-82m', label: 'Kokoro 82M · natural voices · 326 MB', installed: true, bundled: true },
    integrations: [
      {
        name: 'github',
        label: 'GitHub',
        kind: 'hosted',
        where: 'https://api.githubcopilot.com/mcp/',
        state: 'connected',
        canSignIn: false,
        signedIn: false,
        ask: 'changes',
        tools: [
          { name: 'list_pull_requests', title: 'List pull requests', description: 'Pull requests in a repository.', readOnly: true, policy: 'allow', chosen: false },
          { name: 'create_issue', title: 'Create an issue', description: 'Opens an issue in a repository.', readOnly: false, policy: 'ask', chosen: false },
          { name: 'merge_pull_request', title: 'Merge a pull request', description: 'Merges a pull request.', readOnly: false, policy: 'ask', chosen: false },
        ],
        secrets: [{ name: 'NOVA_GITHUB_TOKEN', set: true }],
      },
    ],
    memory: {
      items: [
        { id: 'm1', text: 'My standup is at 10', created: now - 6 * 86_400_000, source: 'said' },
        { id: 'm2', text: 'I like short answers', created: now - 3 * 86_400_000, source: 'suggested' },
        { id: 'm3', text: 'The website deploys from the main branch', created: now - 86_400_000, source: 'said' },
      ],
      conversations: { days: 12, turns: 348 },
    },
    presence: { app: { version: '0.2.0', mic: 'granted', listening: 'wake-word', loginItem: 'on', shortcut: { keys: 'option+space', ok: true }, daemon: 'hosted', access: { calendar: 'granted', reminders: 'granted', notifications: 'granted' } } },
    setup: {
      onboarded: true,
      steps: [
        { id: 'name', label: 'Name', done: true, detail: 'Called Nova - say "hey nova", or press the shortcut.', fix: { section: 'general' } },
        { id: 'voice', label: "Nova's voice", done: true, detail: 'Kokoro, as af_heart - built into Nova.app.', fix: { section: 'voice' } },
        { id: 'hearing', label: 'Microphone and hearing', done: true, detail: 'Parakeet is listening (for the wake word).', fix: { section: 'hearing' } },
        { id: 'reflex', label: "Reflex, Nova's own decision model", done: true, detail: 'Installed - deciding on this Mac in about a millisecond, with 31 things learned from you.', fix: { section: 'decisions' } },
        { id: 'agents', label: 'Agents on this Mac', done: true, detail: 'Claude, Codex and OpenCode - each signed in with your own account.', fix: { section: 'agents' } },
        { id: 'answers', label: 'Who answers open questions', done: true, detail: "Claude, with Nova's tools.", fix: { section: 'answers' } },
        { id: 'projects', label: 'Projects agents may work in', done: true, optional: true, detail: '3 projects in ~/dev.', fix: { section: 'projects' } },
        { id: 'app', label: 'Nova.app in the menu bar', done: true, detail: 'Running, and opens at login. Shortcut: ⌥Space.', fix: { section: 'presence' } },
        { id: 'voice-id', label: 'Voice ID', done: false, optional: true, detail: 'Off: anyone Nova hears can ask it things - a TV too. Set it up to have Nova answer your voice alone.', fix: { section: 'voice' } },
        { id: 'screen', label: "Nova Eyes - what you're working in", done: true, optional: true, detail: 'Accessibility: allowed · Screen Recording: allowed.', fix: { section: 'screen' } },
        { id: 'privacy', label: 'What leaves this Mac', done: true, optional: true, detail: 'Each thing that goes anywhere, where to, and its switch.', fix: { section: 'privacy' } },
      ],
    },
    privacy: [
      { id: 'hearing', what: 'What the microphone hears', where: `${thisMac} (Parakeet)`, detail: 'Audio is never kept. What you say to Nova is kept as text in your conversation history, on this Mac.', leaves: false, on: true, section: 'hearing' },
      { id: 'voice', what: 'What Nova says, spoken aloud', where: `${thisMac} (Kokoro)`, leaves: false, on: true, section: 'voice' },
      { id: 'decisions', what: 'Each thing you say, to decide what it means', where: `${thisMac} (Reflex)`, detail: 'Nothing else goes with it.', leaves: false, on: true, section: 'decisions' },
      { id: 'answers', what: 'Open questions, with the last few turns of the conversation', where: claude, detail: "Whoever answers can use Nova's tools; each one that changes something is asked about first.", leaves: true, on: true, section: 'answers' },
      { id: 'screen-context', what: "What you're working in - the app, window title and page address - with each open question", where: claude, leaves: true, on: true, toggle: { key: 'screen.context', on: true, off: false } },
      { id: 'agent-claude', what: 'Claude: the questions and tasks you give it, and the project files it reads', where: claude, detail: 'Claude runs its own app, signed in with your account - Nova never holds its keys.', leaves: true, on: true, toggle: { key: 'agents.enabled', on: ['claude', 'codex'], off: ['codex'] } },
      { id: 'agent-codex', what: 'Codex: the questions and tasks you give it, and the project files it reads', where: 'OpenAI, through Codex - on your own plan', detail: 'Codex runs its own app, signed in with your account - Nova never holds its keys.', leaves: true, on: true, toggle: { key: 'agents.enabled', on: ['claude', 'codex'], off: ['claude'] } },
      { id: 'integration-github', what: 'GitHub: what the brain looks up and creates there', where: 'api.githubcopilot.com', detail: 'Each call that changes something is asked about first, unless you said otherwise for that service.', leaves: true, on: true, section: 'integrations' },
      { id: 'weather', what: 'Your town, for the weather in the briefing', where: 'open-meteo.com', detail: 'Only the town you set; no account.', leaves: true, on: true, section: 'initiative' },
      { id: 'kept', what: 'Memories, conversations, reminders and the record of actions', where: `${thisMac} (~/.nova, readable only by you)`, leaves: false, on: true, section: 'memory' },
      { id: 'snapshots', what: "Snapshots of your projects, so agents' changes can be undone", where: 'each git project itself (refs/nova/snapshots - never pushed unless you push everything)', leaves: false, on: true, toggle: { key: 'trust.snapshots', on: true, off: false } },
    ],
    trust: {
      rules: [
        { id: 'r1', key: 'skill:quit_app:Spotify', label: 'Quit Spotify' },
        { id: 'r2', key: 'agent:claude:npm test', label: 'Claude running npm test in website' },
      ],
      activity: { days: 30, kept: 214 },
    },
    initiative: {
      reminders: [{ id: 'r-standup', text: 'standup', about: 'about', due: now + 40 * MINUTE }],
      routines: [{ name: 'start work', phrase: 'start work', steps: ['open Slack', 'brief me'] }],
      project: { name: 'website', source: 'screen' },
      weather: { town: 'Lisbon', ok: true },
      tasks: [earlierTask],
      moment: { away: false, call: false, waiting: 0 },
    },
    signing: {
      identity: 'Apple Development: Your Name (AB12CD34EF), until 17 September 2027',
      team: 'AB12CD34EF',
      expires: now + 350 * 86_400_000,
      adHoc: false,
      apps: [
        { name: 'Nova.app', signed: 'yours', hardened: true },
        { name: 'Nova Eyes', signed: 'yours', hardened: true },
        { name: 'the hearing helper', signed: 'yours', hardened: true },
      ],
    },
    voiceId: { installed: false, label: 'WeSpeaker v2 · 8 MB', size: '8 MB', enrolled: false, on: false, learned: 0, enrolling: null, improvable: false, testing: null, bars: null, keyword: { set: false, overriddenAt: null } },
    screen: { available: true, running: true, permissions: { accessibility: true, screen: true } },
    hands: {
      available: true,
      permissions: { accessibility: true, screen: true },
      shortcuts: ['Log water', 'Translate', 'Start focus'],
      focus: {},
      layouts: [{ name: 'work', windows: 3, apps: ['Safari', 'Slack', 'Visual Studio Code'] }],
      active: false,
    },
    hearing: {
      status: { engine: 'parakeet', state: 'ready' },
      parakeet: { model: 'parakeet-tdt-0.6b-v2', label: 'Parakeet TDT 0.6B v2 · English · 464 MB', installed: true },
      smartTurn: { model: 'smart-turn-v3.2', label: 'Smart Turn v3.2 · 9 MB', installed: true },
      speech: { model: 'silero-vad-v6.2', label: 'Silero VAD v6.2 · 2 MB', installed: true },
    },
    agents: [
      { name: 'claude', label: 'Claude', bin: 'claude', path: '/opt/homebrew/bin/claude', custom: false },
      { name: 'codex', label: 'Codex', bin: 'codex', path: '/opt/homebrew/bin/codex', custom: false },
      { name: 'opencode', label: 'OpenCode', bin: 'opencode', path: '/opt/homebrew/bin/opencode', custom: false },
      { name: 'gemini', label: 'Gemini CLI', bin: 'gemini', path: null, custom: false },
    ],
    servers: [
      { name: 'lmstudio', url: 'http://localhost:1234/v1', builtIn: true, defaultUrl: 'http://localhost:1234/v1', keyVar: 'NOVA_LMSTUDIO_API_KEY', online: true, models: ['google/gemma-4-e4b', 'qwen/qwen3-8b'] },
      { name: 'ollama', url: 'http://localhost:11434/v1', builtIn: true, defaultUrl: 'http://localhost:11434/v1', keyVar: 'NOVA_OLLAMA_API_KEY', online: false, models: [] },
    ],
    projects: [
      { name: 'website', path: '~/dev/website' },
      { name: 'mobile-app', path: '~/dev/mobile-app' },
      { name: 'Agentic_OS', path: '~/dev/Agentic_OS' },
    ],
    phone: {
      door: { port: 7879, addresses: ['192.168.1.23', '100.101.102.103'], tailnet: ['100.101.102.103'] },
      devices: [{ id: 'p1', name: 'iPhone', model: 'iPhone 17', pairedAt: now - 2 * 86_400_000, lastSeen: now - 5 * MINUTE, connected: false }],
      pairing: {
        link: pairingLink({ mac: 'q8vhQPDU2vGUQjL_rojjFw', name: 'Nova on the MacBook Pro', hosts: ['192.168.1.23'], port: 7879, pin: 'n4bQgYhMLqWVNdzUbPrXxJ2mPZcDs6GwZ4IxVv0kC1c', code: 'm2ZrV0bq6FQ3n1pX8yT4dw' }),
        expires: now + 9 * MINUTE,
      },
    },
  };
}
