/**
 * Everything a user can change in Nova, as one schema. Settings live in a JSON file
 * (~/.nova/settings.json by default) that the Settings window edits and that reads well
 * by hand. .env holds only constants - the port, allowed origins, file paths and secrets.
 * Dependency-free so shells can import it.
 */

import { argsSecret, looksSecret, urlSecret, type AskPolicy, type ToolPolicy } from './integrations.ts';
import { shortcutProblem } from './shortcut.ts';
import type { Reminder, Routine, TaskRecord } from './skills/types.ts';
import { parseWhen } from './when.ts';

// Shells reach integrations' presets and names through this module.
import type { PhoneStatus } from './phone.ts';
export { INTEGRATION_PRESETS, integrationName, secretRefs, type AskPolicy, type IntegrationEntry, type IntegrationPreset, type ToolPolicy } from './integrations.ts';

export type SettingValue = string | number | boolean | string[] | { [key: string]: unknown };

/** One step of setting Nova up, for the checklist and the first-run walkthrough. */
export interface SetupStep {
  id: string;
  label: string;
  done: boolean;
  /** Nice to have, not needed. */
  optional?: boolean;
  /** Where it stands, or what's missing. */
  detail: string;
  /** Where to fix it: a Settings section, or a download. */
  fix?: { section?: SettingsSection; install?: 'reflex' | 'parakeet' | 'smart-turn'; command?: string };
}

/** Something that leaves this Mac (or stays), for the privacy page. */
export interface PrivacyFlow {
  id: string;
  what: string;
  /** Where it goes: "Anthropic, through Claude Code", "open-meteo.com", "this Mac". */
  where: string;
  /** More about it: what exactly goes, and when. */
  detail?: string;
  leaves: boolean;
  on: boolean;
  /** Its switch: the setting, and its value for on and for off. */
  toggle?: { key: string; on: SettingValue; off: SettingValue };
  /** Where it's chosen, when it takes more than a switch. */
  section?: SettingsSection;
}

/** Whether the user is here, as Nova's Mac app sees it. */
export interface ShellContext {
  locked: boolean;
  /** A camera is on: a video call, most likely. */
  camera: boolean;
  /** Seconds since the last key press or click. */
  idleSeconds: number;
  /** When the Mac was last unlocked (epoch ms). */
  unlockedAt?: number;
}

/** What macOS lets Nova's Mac app reach. */
export type Access = 'granted' | 'denied' | 'undetermined' | 'restricted';

/** Nova's Mac app, as it reports itself: what macOS lets it do, and how it's listening. */
export interface ShellStatus {
  version: string;
  /** Microphone access, as macOS says. */
  mic: 'granted' | 'denied' | 'undetermined' | 'restricted';
  /** What it's doing with the microphone right now. */
  listening: 'wake-word' | 'shortcut' | 'window' | 'muted' | 'locked' | 'no-mic' | 'starting';
  /** Opening at login - macOS's own switch, also in System Settings → General → Login Items. */
  loginItem: 'on' | 'off' | 'needs-approval' | 'error';
  loginItemMessage?: string;
  /** The shortcut, and whether macOS let Nova have it (another app may hold it). */
  shortcut: { keys: string; ok: boolean; message?: string };
  /** It started Nova's daemon itself, or uses one started elsewhere (a terminal). */
  daemon: 'hosted' | 'external';
  /** The Calendar and Reminders apps, and notifications. */
  access?: { calendar: Access; reminders: Access; notifications: Access };
}

/** How Nova hears you right now. */
/** One thing said while setting Voice ID up: whether it was taken, and why not - with how it sounded. */
export interface VoiceEnrollStep {
  say: string;
  kind: 'normal' | 'far' | 'quiet' | 'free' | 'check';
  ok: boolean;
  why?: string;
  /** Speech loudness (dB below full scale), how far above the room's noise (dB), seconds of speech. */
  level?: number;
  snr?: number;
  speech?: number;
  /** A check's match against the voiceprint as it stands. */
  score?: number;
}

/** One thing said while testing Voice ID: whose voice it sounded like, how closely, and what Nova would do. */
export interface VoiceTestResult {
  speaker: 'you' | 'not-you' | 'unsure';
  /** How closely it matched the user's voiceprint (cosine, about 0-1); null when no voiceprint could be made. */
  score: number | null;
  seconds: number;
  heard: string;
  /** "That's you - Nova would answer." and the like. */
  verdict: string;
  /** Why Nova couldn't tell, when it couldn't. */
  why?: string;
  /** Each of Voice ID's models' own match, when more than one heard it. */
  models?: { name: string; score: number }[];
  at: string;
}

export interface HearingStatus {
  /** 'browser': the window's own speech recognition. Otherwise the daemon hears the audio the window streams. */
  engine: 'apple' | 'parakeet' | 'browser';
  state: 'starting' | 'ready' | 'unavailable';
  /** What it's doing (building, loading) or why it can't hear. */
  message?: string;
}

export type SettingsSection =
  | 'setup'
  | 'general'
  | 'voice'
  | 'hearing'
  | 'presence'
  | 'phone'
  | 'appearance'
  | 'decisions'
  | 'answers'
  | 'initiative'
  | 'memory'
  | 'screen'
  | 'hands'
  | 'integrations'
  | 'models'
  | 'agents'
  | 'projects'
  | 'privacy'
  | 'system';

/** Section blurbs and field text say "Nova"; shells swap in the name the user chose. */
export const SECTIONS: { id: SettingsSection; label: string; icon: string; blurb: string }[] = [
  { id: 'setup', label: 'Setup', icon: '✓', blurb: "What's set up, what isn't, and the fix for each - or the walkthrough, again." },
  { id: 'general', label: 'General', icon: '✺', blurb: 'Who your assistant is.' },
  { id: 'voice', label: 'Voice', icon: '◉', blurb: 'How Nova speaks, and when it listens.' },
  { id: 'hearing', label: 'Hearing', icon: '◎', blurb: 'How Nova turns what you say into text - on this Mac - and knows when you have finished.' },
  {
    id: 'presence',
    label: 'Menu bar',
    icon: '⌥',
    blurb: 'Nova in your menu bar: the shortcut that summons it, when it listens, and the orb that shows what it hears and says.',
  },
  {
    id: 'phone',
    label: 'iPhone',
    icon: '▯',
    blurb: 'Nova on your iPhone: pair it here, then talk to Nova from anywhere on your Wi-Fi - the same Nova, heard and answered by this Mac.',
  },
  { id: 'appearance', label: 'Appearance', icon: '◐', blurb: 'How Nova looks and moves.' },
  { id: 'decisions', label: 'Decisions', icon: '⚡︎', blurb: 'System 1 - what decides what each thing you say means. Reflex does it on this Mac in about a millisecond.' },
  { id: 'answers', label: 'Answers', icon: '✦', blurb: "System 2 - who answers open questions and acts through Nova's tools." },
  {
    id: 'initiative',
    label: 'Reminders & routines',
    icon: '◷',
    blurb: 'When Nova speaks up by itself: reminders, the morning briefing, your routines, and news from your agents.',
  },
  { id: 'memory', label: 'Memory', icon: '❋', blurb: 'What Nova remembers about you: only what you say, or agree to when it asks.' },
  {
    id: 'screen',
    label: 'Screen',
    icon: '◧',
    blurb: "What Nova can see: what you're working in, with each question - and your screen, when you ask it to look.",
  },
  {
    id: 'hands',
    label: 'Hands',
    icon: '☝︎',
    blurb: 'What Nova can do on your Mac: its settings, your music, windows, files, the clipboard, your Shortcuts - and using the computer for you, one step at a time, with your yes.',
  },
  {
    id: 'integrations',
    label: 'Integrations',
    icon: '⌁',
    blurb: "Services Nova's brains can use through Nova - Notion, Linear, GitHub and more. Nova asks you out loud before each action unless you say otherwise.",
  },
  { id: 'models', label: 'Local models', icon: '▣', blurb: 'Model servers on this Mac: LM Studio, Ollama, oMLX and anything OpenAI-compatible.' },
  { id: 'agents', label: 'Agents', icon: '✳︎', blurb: 'Agents Nova hands questions and project tasks to. Each runs its own CLI, signed in with your account.' },
  { id: 'projects', label: 'Projects', icon: '▤', blurb: 'Folders agents may work in. Speech only ever picks one of these names.' },
  {
    id: 'privacy',
    label: 'Privacy & trust',
    icon: '⛨',
    blurb: 'What leaves this Mac and where it goes, what you let Nova do without asking, and the record of what it did.',
  },
  { id: 'system', label: 'System', icon: '⚙︎', blurb: 'Where settings are kept, and the constants that live in .env.' },
];

export type FieldType = 'text' | 'list' | 'number' | 'slider' | 'toggle' | 'select' | 'model' | 'path' | 'kokoro-voice' | 'language' | 'shortcut' | 'time';

export interface SettingField {
  /** Where the value lives in the settings file, e.g. "voice.wakeWords". */
  key: string;
  section: SettingsSection;
  label: string;
  help?: string;
  type: FieldType;
  default: SettingValue;
  options?: { value: string; label: string }[];
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  /** Only relevant while another setting has one of these values. */
  when?: { key: string; is: SettingValue[] };
}

/** Kokoro voices Nova offers (all ship with kokoro-js). */
export const KOKORO_VOICES = [
  { value: 'af_heart', label: 'Heart - American, warm' },
  { value: 'af_bella', label: 'Bella - American, bright' },
  { value: 'af_nicole', label: 'Nicole - American, soft' },
  { value: 'af_sarah', label: 'Sarah - American' },
  { value: 'af_nova', label: 'Nova - American' },
  { value: 'am_michael', label: 'Michael - American' },
  { value: 'am_fenrir', label: 'Fenrir - American, deep' },
  { value: 'am_puck', label: 'Puck - American, lively' },
  { value: 'bf_emma', label: 'Emma - British' },
  { value: 'bf_isabella', label: 'Isabella - British' },
  { value: 'bm_george', label: 'George - British' },
  { value: 'bm_fable', label: 'Fable - British' },
];

export const FIELDS: SettingField[] = [
  {
    key: 'name',
    section: 'general',
    label: 'Name',
    help: 'What your assistant is called and answers to. Unless you set your own wake words, "hey <name>", "okay <name>" and the name alone wake it.',
    type: 'text',
    default: 'Nova',
    placeholder: 'Nova',
  },

  { key: 'voice.kokoroVoice', section: 'voice', label: 'Voice', help: "Kokoro's voices, all on this Mac.", type: 'kokoro-voice', default: 'af_heart', options: KOKORO_VOICES },
  { key: 'voice.rate', section: 'voice', label: 'Speaking rate', type: 'number', default: 1.05, unit: '×', min: 0.5, max: 2, step: 0.05 },
  { key: 'voice.wakeWords', section: 'voice', label: 'Wake words', help: 'Comma separated; the first is shown as the hint. Reset to follow the name again.', type: 'list', default: [] },
  {
    key: 'voice.requireWakeWord',
    section: 'voice',
    label: 'Require the wake word',
    help: 'Off is conversation mode: Nova decides what was meant for it. Works best with Jev or a decision model, not the keyword matcher.',
    type: 'toggle',
    default: true,
  },
  {
    key: 'voice.followUpSeconds',
    section: 'voice',
    label: 'Keep listening after replies',
    help: 'How long you can talk without the wake word after Nova answers.',
    type: 'number',
    default: 30,
    unit: 's',
    min: 0,
    max: 600,
    step: 5,
    when: { key: 'voice.requireWakeWord', is: [true] },
  },
  { key: 'voice.listenOnOpen', section: 'voice', label: 'Listen when Nova opens', help: 'Start the microphone as soon as the page loads.', type: 'toggle', default: true },

  {
    key: 'initiative.speak',
    section: 'initiative',
    label: 'Speaking up',
    help: 'Reminders, the briefing and finished agent tasks always show in the orb and as a notification. This is when Nova also says them.',
    type: 'select',
    default: 'free',
    options: [
      { value: 'free', label: "When you're free - not on a call or in a meeting; while you're away it waits" },
      { value: 'show', label: 'Never - only show them' },
      { value: 'always', label: 'Always, at once' },
    ],
  },
  {
    key: 'initiative.awayMinutes',
    section: 'initiative',
    label: 'Away after',
    help: "No typing or clicking for this long counts as away (so does a locked Mac): Nova waits and tells you what you missed when you're back.",
    type: 'number',
    default: 10,
    unit: 'min',
    min: 2,
    max: 120,
    step: 1,
    when: { key: 'initiative.speak', is: ['free'] },
  },
  {
    key: 'initiative.appleReminders',
    section: 'initiative',
    label: 'The Reminders app',
    help: 'Reminders there reach your iPhone. Nova speaks them when they are due either way.',
    type: 'select',
    default: 'when-asked',
    options: [
      { value: 'when-asked', label: 'When you say "in my Reminders"' },
      { value: 'always', label: 'Every reminder goes there too' },
      { value: 'never', label: 'Never - reminders stay with Nova' },
    ],
  },
  { key: 'initiative.remindersList', section: 'initiative', label: 'Reminders list', help: 'The list in the Reminders app. Empty uses your default list.', type: 'text', default: '', placeholder: 'default list', when: { key: 'initiative.appleReminders', is: ['when-asked', 'always'] } },
  {
    key: 'initiative.briefing',
    section: 'initiative',
    label: 'Morning briefing',
    type: 'select',
    default: 'first-unlock',
    options: [
      { value: 'first-unlock', label: 'The first time you unlock the Mac each morning' },
      { value: 'time', label: 'At a set time' },
      { value: 'off', label: 'Only when you ask ("brief me")' },
    ],
  },
  { key: 'initiative.briefingTime', section: 'initiative', label: 'Briefing time', type: 'time', default: '08:30', when: { key: 'initiative.briefing', is: ['time'] } },
  {
    key: 'initiative.calendar',
    section: 'initiative',
    label: 'Use your calendar',
    help: "Today's events from the Calendar app, through Nova.app - for the briefing, and so Nova stays quiet in meetings.",
    type: 'toggle',
    default: true,
  },
  {
    key: 'initiative.town',
    section: 'initiative',
    label: 'Weather for',
    help: 'Your town, for the weather in the briefing - from Open-Meteo (free, no key), so the town goes to open-meteo.com. Empty: no weather.',
    type: 'text',
    default: '',
    placeholder: 'e.g. Accra',
  },
  {
    key: 'initiative.units',
    section: 'initiative',
    label: 'Temperatures in',
    type: 'select',
    default: 'celsius',
    options: [
      { value: 'celsius', label: 'Celsius' },
      { value: 'fahrenheit', label: 'Fahrenheit' },
    ],
  },
  {
    key: 'initiative.briefingBrain',
    section: 'initiative',
    label: 'Let the brain add from your services',
    help: 'Linear issues, GitHub reviews, Notion pages due today: the brain checks the services connected through Nova. A few seconds slower.',
    type: 'toggle',
    default: true,
  },

  {
    key: 'trust.mode',
    section: 'privacy',
    label: 'Permissions',
    help: "How often Nova checks with you first - kept until you change it here. Ask first: a yes for every change. Do what I ask: what you tell it to do is done at once; it asks only about what you didn't ask for (a brain's own idea, an agent's commands) and before anything that spends money or can't be undone. Don't ask: nothing waits for a yes - Nova, its brains and your agents act on their own, and anything you blocked stays blocked. Everything done is in the record, and most of it can be undone.",
    type: 'select',
    default: 'auto',
    options: [
      { value: 'ask', label: 'Ask first' },
      { value: 'auto', label: 'Do what I ask' },
      { value: 'free', label: "Don't ask" },
    ],
  },
  {
    key: 'trust.alwaysForGood',
    section: 'privacy',
    label: 'Remember "yes, always" for good, whatever it\'s for',
    help: 'Whatever you say "yes, always" to - a step on the screen, a service\'s tool that changes things, an agent\'s command - Nova never asks about it again, after restarts too, until you remove it from the list below. Off: screen steps are allowed only for the task, and a service\'s changes and an agent\'s risky commands are asked each time.',
    type: 'toggle',
    default: true,
  },
  {
    key: 'trust.stillAsk',
    section: 'privacy',
    label: 'Always ask before paying, deleting for good and risky commands',
    help: "In every mode, and even after a \"yes, always\": Nova checks before spending money, deleting something that can't be brought back, and an agent's risky commands (deleting files, force-pushing, superuser). Off: nothing is kept back. With Voice ID off, any voice Nova hears can ask it for things.",
    type: 'toggle',
    default: true,
  },
  {
    key: 'trust.keepActivity',
    section: 'privacy',
    label: 'Keep the record of actions',
    help: 'Everything Nova did, who asked, and whether it can be undone - on this Mac only. Ask "what did you do today?".',
    type: 'select',
    default: '30',
    options: [
      { value: '7', label: 'A week' },
      { value: '30', label: 'A month' },
      { value: '90', label: 'Three months' },
      { value: '365', label: 'A year' },
    ],
  },
  {
    key: 'trust.snapshots',
    section: 'privacy',
    label: "Make agents' changes undoable",
    help: "Before an agent works in a git project, Nova takes a snapshot of its files (kept in the repository, out of sight), so you can put back what the agent changed. It refuses rather than overwrite your own edits.",
    type: 'toggle',
    default: true,
  },

  {
    key: 'memory.suggest',
    section: 'memory',
    label: 'Suggest things to remember',
    help: 'When you mention something worth keeping - a schedule, a preference, a person - Nova asks "Want me to remember that?". Nothing is saved without your yes.',
    type: 'toggle',
    default: true,
  },
  {
    key: 'memory.useInAnswers',
    section: 'memory',
    label: 'Use memories in answers',
    help: 'Memories related to a question go with it to whoever answers.',
    type: 'toggle',
    default: true,
  },
  {
    key: 'memory.keepConversations',
    section: 'memory',
    label: 'Keep conversations',
    help: 'Past conversations stay on this Mac, so you can ask "what did I ask you yesterday?".',
    type: 'select',
    default: '90',
    options: [
      { value: '7', label: 'A week' },
      { value: '30', label: 'A month' },
      { value: '90', label: 'Three months' },
      { value: '365', label: 'A year' },
      { value: 'forever', label: 'Forever' },
    ],
  },
  {
    key: 'screen.context',
    section: 'screen',
    label: "Share what I'm working in",
    help: 'With each question to the brain: the app and window in front, the browser page, and any text you have selected. Nothing else is read unless you ask Nova to look.',
    type: 'toggle',
    default: true,
  },
  {
    key: 'screen.images',
    section: 'screen',
    label: 'Show the picture too',
    help: "When you ask Nova to look, brains that can see get the screenshot as well as the text read from it. The picture goes to that brain's service (Claude's runs in the cloud).",
    type: 'toggle',
    default: true,
  },

  {
    key: 'hands.computerUse',
    section: 'hands',
    label: 'Let brains use the computer',
    help: 'Whoever answers can look at your screen and click, type and scroll for you: what you asked for it just does (unless Privacy & trust says to ask first), and anything else it asks about - each step, or once when you say "go ahead with all of it". Off: only your own commands, like "click send".',
    type: 'toggle',
    default: true,
  },
  {
    key: 'hands.showTarget',
    section: 'hands',
    label: "Show what's about to be clicked",
    help: 'While Nova asks, a frame around the button or field it means, so you can see what your yes is for.',
    type: 'toggle',
    default: true,
  },
  {
    key: 'hands.pauseOnInput',
    section: 'hands',
    label: 'Wait while you use the mouse or keyboard',
    help: "While a brain uses the computer, Nova holds off whenever you're using the mouse or keyboard, so it never fights you for them.",
    type: 'toggle',
    default: true,
  },
  {
    key: 'hands.maxSteps',
    section: 'hands',
    label: 'Most steps for one request',
    help: 'Clicks, typing, keys and scrolls a brain may take for one thing you ask, before it stops and tells you what is left.',
    type: 'number',
    default: 60,
    min: 5,
    max: 300,
    step: 5,
  },
  {
    key: 'hands.shortcutSeconds',
    section: 'hands',
    label: 'Longest a shortcut may run',
    help: 'Your Shortcuts, run by name ("run my log water shortcut"). One still running after this is stopped.',
    type: 'number',
    default: 60,
    unit: 's',
    min: 5,
    max: 600,
    step: 5,
  },
  {
    key: 'media.player',
    section: 'hands',
    label: 'Music player',
    help: '"Play", "pause" and "next song" go to the one playing. This one plays when nothing is, and searches your library for "play some jazz" (the Music app only).',
    type: 'select',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Automatic - whichever is playing, else the Music app' },
      { value: 'Music', label: 'The Music app' },
      { value: 'Spotify', label: 'Spotify' },
    ],
  },

  {
    key: 'hearing.engine',
    section: 'hearing',
    label: 'Speech recognition',
    help: "Apple's and Parakeet run on this Mac: nothing you say leaves it, and you can talk over Nova. The browser's own recognition is the fallback.",
    type: 'select',
    default: 'auto',
    options: [
      { value: 'auto', label: "Automatic - Apple's on-device recognizer when it's available" },
      { value: 'apple', label: 'Apple on-device - live text as you speak, nothing to download' },
      { value: 'parakeet', label: 'Parakeet (NVIDIA) - most accurate in noise, 464 MB' },
      { value: 'browser', label: "The browser's speech recognition" },
    ],
  },
  { key: 'voice.language', section: 'hearing', label: 'Language', help: 'The language Nova listens for (Parakeet hears English only).', type: 'language', default: 'en-US' },
  {
    key: 'hearing.patience',
    section: 'hearing',
    label: 'Waiting for you',
    help: 'How long Nova waits after you pause before it acts. It always waits longer when you trail off mid-sentence.',
    type: 'select',
    default: 'normal',
    options: [
      { value: 'quick', label: 'Quick - acts on short pauses' },
      { value: 'normal', label: 'Normal' },
      { value: 'patient', label: 'Patient - for thinking out loud' },
    ],
  },
  {
    key: 'hearing.smartTurn',
    section: 'hearing',
    label: "Hear when you've finished",
    help: 'Smart Turn listens to your tone as well as your words, so "in my current project I want to…" waits for the rest. Needs its 9 MB model.',
    type: 'toggle',
    default: true,
  },
  {
    key: 'hearing.speechOnly',
    section: 'hearing',
    label: "Ignore sounds that aren't speech",
    help: 'A small speech detector (Silero VAD) tells a voice from other sounds, so typing, music, a door or a fan never start a turn. Needs its 2 MB model.',
    type: 'toggle',
    default: true,
  },
  {
    key: 'hearing.bargeIn',
    section: 'hearing',
    label: 'Interrupt by talking',
    help: 'Talk while Nova is speaking to stop it and say something else. Needs on-device recognition.',
    type: 'toggle',
    default: true,
  },

  {
    key: 'presence.shortcut',
    section: 'presence',
    label: 'Shortcut',
    help: 'Hold it while you talk and let go when you are done, or tap it and just talk. Tap it again to stop listening; press it while Nova speaks to cut in.',
    type: 'shortcut',
    default: 'option+space',
  },
  {
    key: 'presence.listen',
    section: 'presence',
    label: 'Listen for its name',
    help: 'The microphone is on while Nova listens for its name (macOS shows its orange dot). What it hears is turned into text on this Mac.',
    type: 'select',
    default: 'always',
    options: [
      { value: 'always', label: 'Always - say its name from anywhere' },
      { value: 'window', label: "While Nova's window is open" },
      { value: 'shortcut', label: 'Never - only after the shortcut' },
    ],
  },
  {
    key: 'presence.pauseWhenLocked',
    section: 'presence',
    label: 'Stop listening while the Mac is locked',
    type: 'toggle',
    default: true,
    when: { key: 'presence.listen', is: ['always', 'window'] },
  },
  {
    key: 'presence.orb',
    section: 'presence',
    label: 'Where the orb appears',
    help: 'The orb shows what Nova hears and says over whatever you are doing. Click it for the full window.',
    type: 'select',
    default: 'bottom-right',
    options: [
      { value: 'bottom-right', label: 'Bottom right' },
      { value: 'top-right', label: 'Top right, under the menu bar' },
      { value: 'bottom-left', label: 'Bottom left' },
      { value: 'top-left', label: 'Top left' },
    ],
  },
  {
    key: 'presence.orbSeconds',
    section: 'presence',
    label: 'Keep the reply up',
    help: 'How long the reply stays after Nova finishes speaking.',
    type: 'number',
    default: 6,
    unit: 's',
    min: 2,
    max: 60,
    step: 1,
  },
  {
    key: 'voiceId.enabled',
    section: 'voice',
    label: 'Voice ID - only your voice',
    help: "Nova listens to you alone: other voices are ignored, even saying its name, and a TV can't answer its questions. Holding the talk shortcut always counts as you. Set it up below; your voiceprint stays on this Mac.",
    type: 'toggle',
    default: false,
  },
  {
    key: 'voiceId.learn',
    section: 'voice',
    label: 'Keep learning your voice',
    help: 'Turns that were clearly you refine your voiceprint a little, so a cold, another microphone or a noisy room still works.',
    type: 'toggle',
    default: true,
    when: { key: 'voiceId.enabled', is: [true] },
  },
  {
    key: 'voiceId.keepRecordings',
    section: 'voice',
    label: 'Keep recordings of my turns for a week',
    help: "Each turn Voice ID checks - yours, and any other voice it hears (a TV, someone nearby) - its setup phrases and tests are kept on this Mac for 7 days, with what was heard and what Voice ID made of it, so its accuracy can be checked and tuned on your own voice. Readable by you alone, never sent anywhere; deleted after 7 days, and all of it at once when you switch this off.",
    type: 'toggle',
    default: false,
  },
  { key: 'presence.sounds', section: 'presence', label: 'Chime when Nova starts listening', type: 'toggle', default: true },
  { key: 'presence.launchAtLogin', section: 'presence', label: 'Open Nova at login', type: 'toggle', default: true },
  {
    key: 'presence.daemon',
    section: 'presence',
    label: "Who runs Nova's daemon",
    help: "Nova.app starts the daemon for you and starts it again if it stops. Choose the terminal while you work on Nova itself (npm run dev) - but when Nova is signed with your certificate, Nova Eyes (the screen and Nova's hands) answers only the daemon Nova.app runs.",
    type: 'select',
    default: 'app',
    options: [
      { value: 'app', label: 'Nova.app - started for you' },
      { value: 'terminal', label: 'You, in a terminal (npm run dev)' },
    ],
  },

  {
    key: 'phone.enabled',
    section: 'phone',
    label: 'Let your iPhone connect',
    help: "Opens a door on your Wi-Fi for the iPhones you pair, and for nothing else: every connection is encrypted (TLS, with a certificate the phone checks), and each phone proves who it is with a key only it holds. Off, nothing listens beyond this Mac.",
    type: 'toggle',
    default: false,
  },
  {
    key: 'phone.hearing',
    section: 'phone',
    label: "Where your iPhone's speech is heard",
    help: "On this Mac, the phone streams its microphone here and Nova hears it as it hears you at the Mac - the same recognizer, Smart Turn and speech detector. On the iPhone, Apple's recognizer on the phone does it and only the text comes here - lighter on a weak connection. Automatic uses this Mac unless the connection is weak.",
    type: 'select',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Automatic - this Mac, or the iPhone on a weak connection' },
      { value: 'mac', label: 'On this Mac' },
      { value: 'iphone', label: 'On the iPhone' },
    ],
  },

  {
    key: 'appearance.orbStyle',
    section: 'appearance',
    label: 'Orb',
    type: 'select',
    default: 'particles',
    options: [
      { value: 'particles', label: 'Particles - thousands of moving dots' },
      { value: 'glass', label: 'Glass - the classic orb' },
    ],
  },
  {
    key: 'appearance.orbColors',
    section: 'appearance',
    label: 'Colours',
    type: 'select',
    default: 'nova',
    options: [
      { value: 'nova', label: 'Nova - cyan to violet' },
      { value: 'aurora', label: 'Aurora - teal to violet' },
      { value: 'ember', label: 'Ember - blue to orange' },
      { value: 'ice', label: 'Ice - white to blue' },
    ],
    when: { key: 'appearance.orbStyle', is: ['particles'] },
  },
  {
    key: 'appearance.orbMotion',
    section: 'appearance',
    label: 'Motion',
    help: 'How much the Orb moves. Your Mac\'s "Reduce motion" setting keeps it calm too.',
    type: 'select',
    default: 'lively',
    options: [
      { value: 'lively', label: 'Lively' },
      { value: 'calm', label: 'Calm' },
      { value: 'still', label: 'Still - barely moves' },
    ],
    when: { key: 'appearance.orbStyle', is: ['particles'] },
  },
  {
    key: 'appearance.textSize',
    section: 'appearance',
    label: 'Text size',
    help: 'What you said and Nova\'s replies, in the window and the floating orb. Or press ⌘+ and ⌘− in the window (⌘0 for normal), or say "make the text bigger".',
    type: 'slider',
    default: 100,
    unit: '%',
    min: 75,
    max: 200,
    step: 5,
  },
  {
    key: 'appearance.cardsClose',
    section: 'appearance',
    label: 'Cards close by themselves',
    help: 'The cards that show beside a reply ("Opened Figma", an answer) go after this long - pointing at one keeps it until you move away. Questions, running timers and agents\' tasks stay until they are done.',
    type: 'select',
    default: '8',
    options: [
      { value: '5', label: 'After 5 seconds' },
      { value: '8', label: 'After 8 seconds' },
      { value: '15', label: 'After 15 seconds' },
      { value: '30', label: 'After 30 seconds' },
      { value: 'never', label: 'Never - I close them' },
    ],
  },
  {
    key: 'appearance.orbSize',
    section: 'appearance',
    label: 'Orb size in the window',
    help: 'Or resize the Orb right there: pinch it, hold ⌥ and scroll over it, or drag the handle that shows when you point at it.',
    type: 'slider',
    default: 100,
    unit: '%',
    min: 50,
    max: 200,
    step: 5,
  },
  {
    key: 'appearance.floatingOrbSize',
    section: 'appearance',
    label: 'Floating orb size',
    help: 'The orb over your other apps. While it shows, pinch it, hold ⌥ and scroll over it, or drag its handle.',
    type: 'slider',
    default: 100,
    unit: '%',
    min: 75,
    max: 300,
    step: 5,
  },

  {
    key: 'decisions.engine',
    section: 'decisions',
    label: 'Decision engine',
    type: 'select',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Automatic - Reflex when installed' },
      { value: 'reflex', label: "Reflex - Nova's own, on this Mac, in about a millisecond" },
      { value: 'heuristic', label: 'Keyword matcher - offline and instant' },
      { value: 'llm', label: 'Language model - on one of your model servers' },
      { value: 'jev', label: "Jev - TypeSafe's System One model, in the cloud (needs NOVA_JEV_API_KEY)" },
    ],
  },
  {
    key: 'decisions.learn',
    section: 'decisions',
    label: 'Learn from what you confirm',
    help: 'When you say yes to "Quit Spotify?" or answer "Which app?", Reflex remembers what that request meant. Kept on this Mac.',
    type: 'toggle',
    default: true,
    when: { key: 'decisions.engine', is: ['auto', 'reflex', 'jev'] },
  },
  {
    key: 'decisions.model',
    section: 'decisions',
    label: 'Decision model',
    help: 'Small, fast models that answer without "thinking" work best.',
    type: 'model',
    default: '',
    placeholder: 'lmstudio/liquid/lfm2.5-1.2b',
    when: { key: 'decisions.engine', is: ['llm'] },
  },
  {
    key: 'decisions.fallback',
    section: 'decisions',
    label: 'When it fails or runs slow',
    type: 'select',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Automatic - Reflex, or the keyword matcher without it' },
      { value: 'reflex', label: 'Use Reflex' },
      { value: 'heuristic', label: 'Use the keyword matcher' },
      { value: 'llm', label: 'Use the decision model' },
      { value: 'none', label: 'Say it failed' },
    ],
  },
  { key: 'decisions.timeoutMs', section: 'decisions', label: 'Time limit', help: 'How long Nova waits for Jev before Reflex decides instead. A model on your own server always gets at least 6 seconds.', type: 'number', default: 1500, unit: 'ms', min: 200, max: 30000, step: 100 },
  {
    key: 'decisions.jevModel',
    section: 'decisions',
    label: 'Jev model',
    help: 'jev-latest follows the current release; jev-preview tries the next one; a version (jev-1.13.0) stays put.',
    type: 'text',
    default: 'jev-latest',
    placeholder: 'jev-latest',
    when: { key: 'decisions.engine', is: ['jev'] },
  },

  {
    key: 'answers.model',
    section: 'answers',
    label: 'Who answers open questions',
    help: 'Leave empty for automatic: your default paired agent answers. Or name an agent (claude, codex, ...), a local model (lmstudio/...) or a cloud model id. Whoever answers can use Nova\'s tools. Type "off" to turn open questions off.',
    type: 'model',
    default: '',
    placeholder: 'automatic',
  },
  {
    key: 'answers.timeoutSeconds',
    section: 'answers',
    label: 'Time limit',
    help: "How long whoever answers may think without getting anywhere. Time in Nova's tools - using the computer, waiting for your yes - doesn't count.",
    type: 'number',
    default: 60,
    unit: 's',
    min: 5,
    max: 600,
    step: 5,
  },

  { key: 'agents.taskTimeoutMinutes', section: 'agents', label: 'Longest a task may run', type: 'number', default: 30, unit: 'min', min: 1, max: 240, step: 1 },

  { key: 'projects.scan', section: 'projects', label: 'Use every folder in the projects folder', type: 'toggle', default: true },
  {
    key: 'projects.folder',
    section: 'projects',
    label: 'Projects folder',
    help: 'Empty means the folder that holds Nova.',
    type: 'path',
    default: '',
    placeholder: '~/dev',
    when: { key: 'projects.scan', is: [true] },
  },
];

/** Settings edited by dedicated panels rather than a single field, with their defaults. */
export const COLLECTIONS: Record<string, SettingValue> = {
  /** Local model servers by name: address overrides and extras, { url?, structuredOutputs? }. */
  'models.servers': {},
  /** Paired agents in order, default first. Absent = every installed agent. */
  'agents.enabled': [],
  /** Per agent: { model?, args?, bin? }. */
  'agents.options': {},
  /** Your own agent CLIs: { command, ask, task, label?, output? }. */
  'agents.custom': {},
  /** Project folders by name. */
  'projects.named': {},
  /** Services the brains can use, by name: { url } or { command, args }, plus when to ask first (see integrations.ts). */
  'integrations.servers': {},
  /** Routines by name: { phrase?, schedule?, steps: [...], enabled? } - "when I say start work", "every weekday at 9". */
  routines: {},
  /** What the user said "yes, always" (or "for today") to, by id: { key, label, until? }. */
  'trust.rules': {},
  /** Window layouts by name ("save this layout as work"): each window's app, title and place on its display. */
  'windows.layouts': {},
};

/** Collections whose entries can be saved one at a time, e.g. "projects.named.site". */
export const ENTRY_COLLECTIONS = ['models.servers', 'agents.options', 'agents.custom', 'projects.named', 'integrations.servers', 'routines', 'trust.rules', 'windows.layouts'];

/**
 * One window of a saved layout: which app (and window, by title), and where on its display - as
 * fractions of the display's usable area (0-1), so it fits a display of any size.
 */
export interface LayoutWindow {
  app: string;
  title?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Which display, counted from the main one (0). */
  display?: number;
}

/** Local servers that speak the OpenAI-compatible API, addressed as "<name>/<model>". */
export const LOCAL_SERVERS: Record<string, string> = {
  lmstudio: 'http://localhost:1234/v1',
  ollama: 'http://localhost:11434/v1',
  omlx: 'http://localhost:9000/v1',
  mlx: 'http://localhost:8080/v1',
  llamacpp: 'http://localhost:8080/v1',
};

/** The .env variable holding a local server's API key, e.g. NOVA_OMLX_API_KEY. */
export const serverKeyVar = (server: string) => `NOVA_${server.toUpperCase().replace(/\W/g, '_')}_API_KEY`;

/** The wake words a name gives by default: "hey jarvis", "okay jarvis", "jarvis". */
export const wakeWordsFor = (name: string) => {
  const n = name.trim().toLowerCase() || 'nova';
  return [`hey ${n}`, `okay ${n}`, n];
};

/** Swap the product name in shared text for the name the user chose - but not in the apps' own names (Nova.app, Nova Eyes). */
export const personalize = (text: string, name: string) => (name && name !== 'Nova' ? text.replace(/\bNova\b(?!\.app|\s+Eyes)/g, name) : text);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const fieldFor = (key: string) => FIELDS.find((f) => f.key === key);
const SERVER_NAME = /^[a-z][a-z0-9_-]*$/;
const OUTPUTS = ['claude', 'codex', 'opencode', 'text'];

/** Names for agents and projects: letters and digits first, then also spaces, - and _. */
export const isEntryName = (name: string) => /^[\p{L}\p{N}][\p{L}\p{N}_ -]*$/u.test(name);

function entryOf(key: string) {
  const collection = ENTRY_COLLECTIONS.find((c) => key.startsWith(`${c}.`));
  const name = collection ? key.slice(collection.length + 1) : '';
  return collection && name && !name.includes('.') ? { collection, name } : null;
}

/** Keys Settings may change: fields, collections and single collection entries. Secrets and constants aren't among them. */
export const isSettingKey = (key: string) => Boolean(fieldFor(key)) || Object.hasOwn(COLLECTIONS, key) || entryOf(key) !== null;

/** A setting's default, if it is one. */
export const defaultOf = (key: string): SettingValue | undefined => fieldFor(key)?.default ?? (Object.hasOwn(COLLECTIONS, key) ? COLLECTIONS[key] : undefined);

function fieldProblem(field: SettingField, v: unknown): string | null {
  switch (field.type) {
    case 'toggle':
      return typeof v === 'boolean' ? null : 'should be true or false';
    case 'number':
    case 'slider':
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'should be a number';
      if (field.min !== undefined && v < field.min) return `should be at least ${field.min}`;
      if (field.max !== undefined && v > field.max) return `should be at most ${field.max}`;
      return null;
    case 'list':
      return isTextList(v) ? null : 'should be a list of text';
    case 'shortcut':
      return typeof v === 'string' ? shortcutProblem(v) : 'should be keys joined by +, like "option+space"';
    case 'time':
      return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? null : 'should be a time like 08:30';
    case 'select':
    case 'kokoro-voice':
      return field.options!.some((o) => o.value === v) ? null : `should be one of: ${field.options!.map((o) => o.value).join(', ')}`;
    default:
      return typeof v === 'string' ? null : 'should be text';
  }
}

const ASK_POLICIES: AskPolicy[] = ['always', 'changes', 'never'];
const TOOL_POLICIES: ToolPolicy[] = ['allow', 'ask', 'block'];
const isTextMap = (v: unknown): v is Record<string, string> => isObject(v) && Object.values(v).every((x) => typeof x === 'string');

function integrationProblem(name: string, v: unknown): string | null {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) return 'needs a name of lower-case letters, digits, - and _';
  if (!isObject(v)) return 'should look like { "url": "https://mcp.example.com/mcp" } or { "command": "npx", "args": [...] }';
  const hosted = v.url !== undefined;
  const local = v.command !== undefined;
  if (hosted === local) return 'needs either a url or a command';
  if (hosted && !(typeof v.url === 'string' && /^https?:\/\/\S+$/.test(v.url))) return 'needs a url starting with http:// or https://';
  if (local && !(typeof v.command === 'string' && v.command.trim())) return 'needs a command';
  if (v.args !== undefined && !isTextList(v.args)) return 'needs args to be a list of text';
  // A token pasted into args or the address would sit in the settings file, in plain sight - like one in a header.
  if (isTextList(v.args) && argsSecret(v.args)) return 'has what looks like a secret in args - put it in .env and write ${NAME} in env instead';
  if (hosted && urlSecret(v.url as string)) return 'has what looks like a secret in the url - put it in .env and send it in a header instead, like "Authorization": "Bearer ${NAME}"';
  for (const key of ['env', 'headers'] as const) {
    const map = v[key];
    if (map === undefined) continue;
    if (!isTextMap(map)) return `needs ${key} to map names to text`;
    const secret = Object.entries(map).find(([k, value]) => looksSecret(k, value));
    if (secret) return `has what looks like a secret in ${key} "${secret[0]}" - put it in .env and write \${NAME} here instead`;
  }
  if (v.ask !== undefined && !ASK_POLICIES.includes(v.ask as AskPolicy)) return `needs ask to be one of: ${ASK_POLICIES.join(', ')}`;
  if (v.tools !== undefined && !(isObject(v.tools) && Object.values(v.tools).every((p) => TOOL_POLICIES.includes(p as ToolPolicy)))) {
    return `needs each tool to be one of: ${TOOL_POLICIES.join(', ')}`;
  }
  if (v.enabled !== undefined && typeof v.enabled !== 'boolean') return 'needs enabled to be true or false';
  return v.label === undefined || typeof v.label === 'string' ? null : 'needs label to be text';
}

/** A routine: steps, and a phrase or a schedule (or both) that start it. */
function routineProblem(name: string, v: unknown): string | null {
  if (!isEntryName(name)) return 'needs a name of letters, digits, spaces, - and _';
  if (!isObject(v)) return 'should look like { "phrase": "start work", "steps": ["open Slack", "brief me"] }';
  if (!isTextList(v.steps) || !v.steps.some((s) => s.trim())) return 'needs steps: a list of things to do, each as you would say it';
  if (v.phrase !== undefined && (typeof v.phrase !== 'string' || !v.phrase.trim())) return 'needs phrase to be what you say to start it';
  if (v.schedule !== undefined && (typeof v.schedule !== 'string' || !parseWhen(v.schedule, new Date())?.schedule)) return 'needs schedule to be a repeat Nova can read, like "every weekday at 9"';
  if (v.phrase === undefined && v.schedule === undefined) return 'needs a phrase or a schedule to start it';
  return v.enabled === undefined || typeof v.enabled === 'boolean' ? null : 'needs enabled to be true or false';
}

/**
 * A remembered permission: exactly what it allows (its key, e.g. "quit_app:Spotify"), how it reads,
 * and until when (a day), if not for good. Stored under a short id, as keys hold dots and colons.
 */
function ruleProblem(name: string, v: unknown): string | null {
  if (!/^[\w-]+$/.test(name)) return 'needs a name of letters, digits, - and _';
  if (!isObject(v) || typeof v.key !== 'string' || !v.key.trim() || typeof v.label !== 'string') {
    return 'should look like { "key": "quit_app:Spotify", "label": "Quit Spotify" } (with "until": "2026-09-27" for a day)';
  }
  return v.until === undefined || (typeof v.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.until)) ? null : 'needs until to be a day like 2026-09-27';
}

/** A saved window layout: a list of windows, each with an app and a place given as fractions of its display. */
function layoutProblem(name: string, v: unknown): string | null {
  if (!isEntryName(name)) return 'needs a name of letters, digits, spaces, - and _';
  const shape = 'should be a list like [{ "app": "Safari", "x": 0, "y": 0, "w": 0.5, "h": 1 }]';
  if (!Array.isArray(v) || !v.length || v.length > 50) return shape;
  for (const w of v) {
    if (!isObject(w) || typeof w.app !== 'string' || !w.app.trim()) return shape;
    const place = [w.x, w.y, w.w, w.h];
    if (!place.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) return `has a window of ${w.app} whose x, y, w and h aren't fractions from 0 to 1`;
    if ((w.w as number) <= 0 || (w.h as number) <= 0 || (w.x as number) + (w.w as number) > 1.001 || (w.y as number) + (w.h as number) > 1.001) return `has a window of ${w.app} that doesn't fit its display`;
    if (w.title !== undefined && (typeof w.title !== 'string' || w.title.length > 300)) return 'needs each title to be text';
    if (w.display !== undefined && !(Number.isInteger(w.display) && (w.display as number) >= 0 && (w.display as number) < 16)) return 'needs display to be a number from 0';
  }
  return null;
}

function entryProblem(collection: string, name: string, v: unknown): string | null {
  if (collection === 'integrations.servers') return integrationProblem(name, v);
  if (collection === 'windows.layouts') return layoutProblem(name, v);
  if (collection === 'trust.rules') return ruleProblem(name, v);
  if (collection === 'routines') return routineProblem(name, v);
  if (collection === 'models.servers') {
    if (!SERVER_NAME.test(name)) return 'needs a name of lower-case letters, digits, - and _';
    if (!isObject(v)) return 'should look like { "url": "http://localhost:1337/v1" }';
    if (v.url !== undefined && !(typeof v.url === 'string' && /^https?:\/\/\S+$/.test(v.url))) return 'needs a url starting with http:// or https://';
    if (v.structuredOutputs !== undefined && typeof v.structuredOutputs !== 'boolean') return 'needs structuredOutputs to be true or false';
    return v.url || Object.hasOwn(LOCAL_SERVERS, name) ? null : 'needs a url';
  }
  if (!isEntryName(name)) return 'needs a name made of letters, digits, spaces, - and _';
  if (collection === 'agents.options') {
    if (!isObject(v)) return 'should look like { "model": "sonnet" }';
    if ([v.model, v.bin].some((x) => x !== undefined && typeof x !== 'string')) return 'needs model and bin to be text';
    return v.args === undefined || typeof v.args === 'string' || isTextList(v.args) ? null : 'needs args to be text or a list of text';
  }
  if (collection === 'agents.custom') {
    if (!isObject(v) || typeof v.command !== 'string' || !v.command.trim() || !isTextList(v.ask) || !isTextList(v.task)) return 'needs "command", "ask" and "task"';
    if (v.label !== undefined && typeof v.label !== 'string') return 'needs label to be text';
    return v.output === undefined || OUTPUTS.includes(v.output as string) ? null : `needs output to be one of: ${OUTPUTS.join(', ')}`;
  }
  return typeof v === 'string' && v.trim() ? null : 'should be a folder path'; // projects.named
}

/** Why a value can't be used for a setting, or null if it can. The key may name one entry, e.g. "projects.named.site". */
export function settingProblem(key: string, value: unknown): string | null {
  const field = fieldFor(key);
  if (field) return fieldProblem(field, value);
  if (key === 'agents.enabled') return isTextList(value) ? null : 'should be a list of agent names';
  // Kept from before Permissions: on is "Ask first", off "Do what I ask" - read only when trust.mode isn't set.
  if (key === 'trust.askFirst') return typeof value === 'boolean' ? null : 'should be on or off';
  if (Object.hasOwn(COLLECTIONS, key)) {
    if (!isObject(value)) return 'should be an object';
    for (const [name, v] of Object.entries(value)) {
      const problem = entryProblem(key, name, v);
      if (problem) return `has "${name}", which ${problem}`;
    }
    return null;
  }
  const entry = entryOf(key);
  return entry ? entryProblem(entry.collection, entry.name, value) : "isn't a setting";
}

/** A value at a dotted path, e.g. getPath(settings, "voice.rate"). */
export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (isObject(o) && Object.hasOwn(o, k) ? o[k] : undefined), obj);
}

/** Set a value at a dotted path, creating objects on the way. `undefined` removes it, along with any objects that leaves empty. Mutates `obj`. */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const [head, ...rest] = path.split('.') as [string, ...string[]];
  if (!rest.length) {
    if (value === undefined) delete obj[head];
    else obj[head] = value;
    return;
  }
  const child = obj[head];
  if (value === undefined && !isObject(child)) return;
  const node: Record<string, unknown> = isObject(child) ? child : {};
  obj[head] = node;
  setPath(node, rest.join('.'), value);
  if (!Object.keys(node).length) delete obj[head];
}

/** One integration as Settings shows it. */
export interface IntegrationStatus {
  name: string;
  label: string;
  kind: 'hosted' | 'local';
  /** Its address, or the command that starts it. */
  where: string;
  state: 'connected' | 'connecting' | 'sign-in' | 'error' | 'off';
  message?: string;
  /** It signs in with the browser; and whether Nova holds a sign-in for it now. */
  canSignIn: boolean;
  signedIn: boolean;
  ask: AskPolicy;
  tools: { name: string; title?: string; description: string; readOnly: boolean; policy: ToolPolicy; chosen: boolean }[];
  /** ${NAME}s it takes from .env, and whether each is set there. */
  secrets: { name: string; set: boolean }[];
}

/** What the daemon sends the Settings window. */
export interface SettingsSnapshot {
  /** The effective value of every field and collection, by key. */
  values: Record<string, SettingValue>;
  /** Keys with a value saved in the settings file; the rest are defaults. */
  saved: Record<string, boolean>;
  /** Secrets from .env by variable name: whether each is set. Their values never leave the daemon. */
  secrets: Record<string, boolean>;
  /** The settings file. */
  file: string;
  /** What's wrong with the settings file (after a hand edit, say); those settings use their defaults. */
  problems: string[];
  /** Constants from .env, shown read-only, and old settings still sitting in .env (ignored now). */
  constants: { port: number; envFile: string; ignored: string[] };
  /** Reflex's embedding model and what it has learned. */
  reflex: {
    model: string;
    label: string;
    installed: boolean;
    /** Its sentence model is on this Mac too (false: word meanings alone - installing adds it). */
    sentences?: boolean;
    /** Examples learned in use, and how many of them the brain taught. */
    learned: number;
    taught?: number;
    /** What its classifier learns from, and whether it's trained yet (it trains in the background). */
    phrasings?: number;
    trained?: boolean;
  };
  /** Kokoro, Nova's voice: whether it's here, and whether it came inside Nova.app. */
  voice: { model: string; label: string; installed: boolean; bundled?: boolean };
  /** Integrations: each service's connection, its tools, and how Nova treats them. */
  integrations: IntegrationStatus[];
  /** What Nova remembers, and how much conversation it keeps. */
  memory: { items: { id: string; text: string; created: number; updated?: number; source: 'said' | 'suggested' }[]; conversations: { days: number; turns: number } };
  /** Nova's Mac app, as it last reported itself - or null when it isn't running. */
  presence: { app: ShellStatus | null };
  /** Setting up: whether the walkthrough was done, and each step. */
  setup: { onboarded: boolean; steps: SetupStep[] };
  /** What leaves this Mac, and where it goes. */
  privacy: PrivacyFlow[];
  /** What the user lets Nova do without asking, and how much of the record is kept. */
  trust: { rules: { id: string; key: string; label: string; until?: string }[]; activity: { days: number; kept: number } };
  /** Reminders to come, the routines, the project the user is on, and whether the weather could be found. */
  initiative: {
    reminders: Reminder[];
    routines: Routine[];
    project: { name: string; source: 'said' | 'screen' } | null;
    weather: { town: string; ok: boolean; message?: string } | null;
    tasks: TaskRecord[];
    /** Right now: whether the user is away or on a call, and how much news is waiting for them. */
    moment: { away: boolean; call: boolean; waiting: number };
  };
  /**
   * How Nova's own apps are signed. With the user's Apple certificate, what macOS allows them survives
   * rebuilds and Nova Eyes answers only the daemon Nova.app runs; ad hoc, macOS asks again after each rebuild.
   */
  signing: {
    /** "Apple Development: … (team AB12CD34EF), until 17 September 2027", or the ad hoc warning. */
    identity: string;
    team: string | null;
    expires: number | null;
    adHoc: boolean;
    /** Each app as it's signed now: with that certificate ("yours"), ad hoc, by something else, or not built yet. */
    apps: { name: string; signed: 'yours' | 'ad hoc' | 'other' | 'not built'; hardened: boolean }[];
  };
  /** Voice ID: its model, the user's voiceprint (whether there is one - never the print), setting it up and testing it. */
  voiceId: {
    installed: boolean;
    label: string;
    /** What installing downloads ("223 MB"). */
    size?: string;
    enrolled: boolean;
    on: boolean;
    learned: number;
    /** Setting up (or improving): the step now, what to say and how, and what each thing said so far came to. */
    enrolling: {
      step: number;
      of: number;
      say: string;
      kind: VoiceEnrollStep['kind'];
      hint?: string;
      /** Collecting the voice, or checking it at the end - `of` is then the checks in a row it needs. */
      phase: 'collect' | 'check';
      done: VoiceEnrollStep[];
    } | null;
    /** Improve my voice can add to it: its setup phrases were kept. */
    improvable: boolean;
    /** Testing: what each thing said since the test began sounded like, newest first. */
    testing: { results: VoiceTestResult[] } | null;
    /** The bars a turn's match (0-1) is judged by: at or above `accept` it's the user, below `reject` it isn't. */
    bars: { accept: number; reject: number } | null;
    /** The master keyword: whether one is set (never what it is), and when it was said - Voice ID off since. */
    keyword: { set: boolean; overriddenAt: string | null };
    message?: string;
  };
  /** Nova Eyes: whether it runs, what macOS lets it do, and why not. */
  screen: { available: boolean; running: boolean; permissions: { accessibility: boolean; screen: boolean } | null; message?: string };
  /** Nova's hands: what they can reach, the user's Shortcuts (and which turn Focus on and off), and saved window layouts. */
  hands: {
    available: boolean;
    /** Null until Nova Eyes has said. */
    permissions: { accessibility: boolean; screen: boolean } | null;
    shortcuts: string[] | null;
    focus: { on?: string; off?: string; toggle?: string; status?: string };
    layouts: { name: string; windows: number; apps: string[] }[];
    /** Nova's hands are on the computer right now. */
    active: boolean;
    message?: string;
  };
  /** How Nova hears: the engine in use, and the models and helper it needs. */
  hearing: {
    status: HearingStatus;
    parakeet: { model: string; label: string; installed: boolean };
    smartTurn: { model: string; label: string; installed: boolean };
    /** Silero VAD: which sounds are speech. */
    speech: { model: string; label: string; installed: boolean };
  };
  agents: { name: string; label: string; bin: string; path: string | null; custom: boolean }[];
  servers: { name: string; url: string; builtIn: boolean; defaultUrl?: string; keyVar: string; online: boolean; models: string[] }[];
  projects: { name: string; path: string }[];
  /** Nova on the iPhone: the door for paired phones, the phones, and a pairing under way. */
  phone: PhoneStatus;
}
