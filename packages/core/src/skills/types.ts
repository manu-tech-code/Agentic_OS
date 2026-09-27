import type { FileKind, SystemSetting, WindowPosition } from '../hands.ts';
import type { Card, RiskTier, UndoStep } from '../protocol.ts';
import type { Schedule } from '../when.ts';

/** OS capabilities a shell/daemon provides. Keeps core platform-agnostic. */
export interface Platform {
  listApps(): Promise<string[]>;
  openApp(name: string): Promise<void>;
  quitApp(name: string): Promise<void>;
  /** Whether an app is running (so opening one can be undone only if Nova started it). */
  isRunning?(name: string): Promise<boolean>;
  now(): Date;
}

/** A paired agent as skills see it. */
export interface AgentRef {
  name: string;
  label: string;
}

export interface SkillContext {
  utterance: string;
  /** App resolved by the decision engine, when the skill needs one. */
  app?: string;
  /** Project folder resolved by the decision engine, for agent tasks. */
  project?: string;
  /**
   * What the user said that led here: the utterance itself for a skill run by voice, or the one
   * the brain is answering for a skill it calls as a tool (where `utterance` is the brain's request).
   */
  heard?: string;
  /** The agent the user named, or the default one for agent skills. */
  agent?: AgentRef;
  /** Every paired agent, default first. */
  agents?: AgentRef[];
  platform: Platform;
  timers: TimerService;
  tasks: TaskService;
  shell: ShellService;
  /** What Nova remembers, when memory is on. */
  memory?: MemoryService;
  /** What's on screen, when Nova can see it. */
  screen?: ScreenService;
  /** Reminders and timers that outlast a restart (and the Reminders app, through Nova.app). */
  reminders?: ReminderService;
  /** The day's briefing: the date, weather, calendar, reminders and agents' work. */
  briefing?: BriefingService;
  /** What Nova held back while the user was away or busy. */
  news?: NewsService;
  /** The project the user is working on, for agents when no project is named. */
  projects?: ProjectService;
  /** The user's routines: a phrase or a schedule, and the steps Nova takes. */
  routines?: RoutineService;
  /** The record of what Nova did, and taking things back. */
  actions?: ActionService;
  /** What the user said "yes, always" to. */
  trust?: TrustService;
  /** Stop everything at once: agents, questions, speech, routines - and mute the microphone. Says how many tasks stopped. */
  halt?: () => number;
  /** Nova's hands on the Mac: settings, media, windows, files, the clipboard, Shortcuts, and using the computer. */
  hands?: HandsService;
  /** A tool call's own arguments (computer_click's element, x and y), for skills that take more than a request. */
  args?: Record<string, unknown>;
  /** Who is calling it as a tool - a brain or agent by name ("Claude"); none when the user asked by voice. */
  caller?: string;
  /** What the skill's `prepare` settled when the request came in (the action "undo" means, the file "the invoice" is): the thing a confirmation named, kept while the user is asked. */
  prepared?: unknown;
  /** What Nova said last, for "copy that". */
  lastReply?: string;
}

// ---------------------------------------------------------------------------
// Hands

/** A system setting as it is now. */
export interface SystemState {
  setting: SystemSetting;
  /** 0-100, for the volume and the brightness. */
  level?: number;
  on?: boolean;
  muted?: boolean;
  /** The battery: charging, and time left or to full ("3:12"). */
  charging?: boolean;
  remaining?: string;
}

/** A window where it was, to put it back ("undo that"). */
export interface WindowFrame {
  app: string;
  pid: number;
  /** Its place among the app's windows. */
  window: number;
  /** The window server's id, when known: the same window even after others are raised. */
  id?: number;
  title?: string;
  frame: { x: number; y: number; w: number; h: number };
  minimized?: boolean;
  fullscreen?: boolean;
}

export interface FileHit {
  path: string;
  name: string;
  /** The folder it's in, as said: "Downloads", "Documents/Taxes". */
  folder: string;
  /** Last changed or used, epoch ms. */
  modified: number;
  kind?: string;
}

/** Something to do on screen - what a brain asks for, or what the user said ("click send"). */
export type ComputerAction =
  | { kind: 'click'; element?: string; x?: number; y?: number; button?: 'left' | 'right'; count?: number }
  | { kind: 'type'; text: string; element?: string; clear?: boolean; submit?: boolean }
  | { kind: 'key'; keys: string; count?: number }
  | { kind: 'scroll'; direction: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom'; amount?: number; element?: string; x?: number; y?: number }
  | { kind: 'drag'; from: { element?: string; x?: number; y?: number }; to: { element?: string; x?: number; y?: number } }
  | { kind: 'wait'; seconds: number };

/** The screen, for a brain: a picture, and the things on it to click or type in. */
export interface ComputerView {
  app: string;
  window?: string;
  image?: { data: string; mimeType: string };
  /** The picture's size in pixels: x and y in actions are in these. */
  width: number;
  height: number;
  /** One per line: `[e12] button "Send" at 812,44 (60×28)`. */
  elements: string;
  /** The element with the keyboard focus. */
  focused?: string;
}

export interface ComputerService {
  /** See the screen (or just the window in front) - for `caller`, the brain or agent about to use it. */
  look(opts?: { scope?: 'screen' | 'window'; caller?: string }): Promise<ComputerView>;
  /** Do one thing; says what was done ("Clicked “Send” in Mail"). `caller`: the brain or agent acting, none for the user's own command. */
  act(action: ComputerAction, caller?: string): Promise<string>;
  /** What an action would do, in words, to ask the user first: `click “Send” in Mail`. */
  describe(action: ComputerAction): string;
  /** Show on screen what's about to be clicked or typed in, while the user is asked; resolves with how to take it away. */
  preview(action: ComputerAction): Promise<() => void>;
  /** Something the user named ("send", "reply") in the window in front: one, several that fit, or nothing. */
  find(target: string): Promise<{ element: string; label: string; app: string } | { several: string[]; app: string } | null>;
  /** The app in front. */
  front(): Promise<string | null>;
  /** Stop acting (stop everything) until the user asks for something again. */
  halt(): void;
  resume(): void;
  /** A brain finished its answer: its hands are off the computer. */
  finished?(caller: string): void;
}

export interface HandsService {
  system: {
    get(setting: SystemSetting): Promise<SystemState>;
    set(setting: SystemSetting, change: { level?: number; on?: boolean; muted?: boolean }): Promise<SystemState>;
    lock(): Promise<void>;
    sleep(): Promise<void>;
  };
  media: {
    command(action: 'play' | 'pause' | 'toggle' | 'next' | 'previous', app?: 'Music' | 'Spotify'): Promise<{ app: string | null }>;
    nowPlaying(): Promise<{ app: string; title: string; artist?: string; album?: string; playing: boolean } | null>;
    /** Play something from the Music library (or Spotify's own search): what started, or null when nothing fits. */
    play(query: string, app?: 'Music' | 'Spotify'): Promise<{ app: string; what: string } | null>;
  };
  windows: {
    /** Apps with windows open, for recognising names. */
    apps(): Promise<string[]>;
    list(): Promise<{ app: string; windows: string[] }[]>;
    /** Put windows in their places; says which moved, and where they all were before. */
    place(placements: { app?: string; position: WindowPosition }[]): Promise<{ moved: string[]; before: WindowFrame[] }>;
    act(action: 'minimize' | 'fullscreen' | 'exit-fullscreen' | 'hide' | 'other-display' | 'show-all', app?: string): Promise<{ app: string; before: WindowFrame[] }>;
    saveLayout(name: string): Promise<{ windows: number }>;
    layout(name: string): Promise<{ windows: number; missing: string[]; before: WindowFrame[] } | null>;
    layouts(): string[];
    restore(frames: WindowFrame[]): Promise<void>;
  };
  files: {
    find(q: { query?: string; kind?: FileKind; folder?: string; days?: number }, limit?: number): Promise<FileHit[]>;
    recent(q: { kind?: FileKind; folder?: string; days: number }, limit?: number): Promise<FileHit[]>;
    open(path: string): Promise<void>;
    reveal(path: string): Promise<void>;
    /** A folder to move something to, by name ("documents", a project, "taxes"). */
    folder(name: string): Promise<string | null>;
    move(path: string, toFolder: string): Promise<string>;
    rename(path: string, name: string): Promise<string>;
    /** To the Trash (never deleted): where it is there, to put it back. */
    trash(path: string): Promise<string>;
    untrash(trashed: string, original: string): Promise<void>;
    /** The text in a file (a document, PDF, spreadsheet, text), cut to `max` characters. */
    read(path: string, max?: number): Promise<string>;
  };
  clipboard: {
    /** What's copied - never what a password manager marks as concealed. */
    read(): Promise<{ text?: string; concealed?: boolean; files?: string[]; image?: boolean }>;
    write(text: string): Promise<void>;
  };
  shortcuts: {
    list(): Promise<string[]>;
    run(name: string, input?: string): Promise<{ output?: string }>;
  };
  computer: ComputerService;
  /** The page in front's address, for "copy the link". */
  pageAddress?(): Promise<string | null>;
}

/** One entry of the record of what Nova did. */
export interface ActionRecord {
  id: string;
  at: number;
  label: string;
  by?: string;
  skill?: string;
  status: 'done' | 'failed' | 'pending' | 'cancelled';
  undoable: boolean;
  undone?: number;
  /** The files an agent changed: putting them back is asked about first. */
  files?: string[];
}

export interface ActionService {
  /** What Nova did over the last days, newest first. */
  recent(days?: number): ActionRecord[];
  /** The latest that can still be undone - of what someone did, if they're named ("what Claude did"). */
  lastUndoable(by?: string): ActionRecord | null;
  /** Take it back; says what was put back, or why it couldn't be. */
  undo(id: string): Promise<{ ok: boolean; message: string }>;
}

export interface TrustService {
  /** Whether the user said "yes, always" to this (and it hasn't run out). */
  allows(key: string): boolean;
  /** Remember it - for good, or for a day ("YYYY-MM-DD"). */
  allow(key: string, label: string, until?: string): Promise<void>;
  list(): { key: string; label: string; until?: string }[];
}

/** Something Nova brings up itself: a timer or reminder due, an agent's result, the morning briefing. */
export interface News {
  kind: 'timer' | 'reminder' | 'task' | 'briefing';
  /** What Nova says. */
  text: string;
  /** Short, for the orb and the notification. */
  title: string;
  card?: Card;
  /** The reminder or task it's about. */
  ref?: string;
}

/** A reminder or a timer Nova keeps. */
export interface Reminder {
  id: string;
  /** What it's about ("call mum"), or a timer's label ("the laundry") - empty for a plain timer. */
  text: string;
  /** How it was put: remind me "to" call mum, "about" the dentist, "that" the car needs a wash. None for a timer. */
  about?: 'to' | 'about' | 'that';
  /** A timer's length, to say "your 10 minute timer". */
  ms?: number;
  /** When it's (next) due, epoch ms; null for one only in the Reminders app, with no time. */
  due: number | null;
  schedule?: Schedule;
  /** A timer, or a short wait ("in 10 minutes"): cancelling the timers cancels it. A reminder days away is none. */
  countdown?: boolean;
  /** It's in the Reminders app too (so it reaches the iPhone). */
  apple?: boolean;
  /**
   * It lives only in the Reminders app (made there, not by Nova): Nova can't bring it back once
   * it's cancelled, so cancelling everything by voice leaves it alone. (Ids starting "apple-" are these too.)
   */
  appleOnly?: boolean;
}

export interface ReminderService {
  add(reminder: Omit<Reminder, 'id'>): Promise<Reminder>;
  /** Everything to come, soonest first: Nova's own, and the Reminders app's as last seen. */
  list(): Reminder[];
  cancel(id: string): Promise<boolean>;
  /** The reminder Nova brought up in the last few minutes, if any - "snooze", "done". */
  recent(): Reminder | null;
  snooze(id: string, ms: number): Promise<Reminder | null>;
  done(id: string): Promise<boolean>;
  /** Whether reminders go to the Reminders app too: every time, when asked, or it can't be reached. */
  readonly apple: 'always' | 'when-asked' | 'unavailable';
}

export interface BriefingService {
  /** The day's facts, spoken plainly - and, when a brain should add from the user's services, what to ask it. */
  compose(): Promise<{ facts: string[]; spoken: string; ask?: string }>;
}

export interface NewsService {
  /** What Nova held back (away, on a call) and hasn't said yet, oldest first. */
  missed(): { at: number; text: string }[];
  /** They've heard it now. */
  heard(): void;
}

export interface ProjectService {
  readonly current: string | null;
  set(name: string | null): void;
}

export interface Routine {
  name: string;
  /** Said to start it: "start work". */
  phrase?: string;
  /** When it runs by itself: "every weekday at 9". */
  schedule?: string;
  /** What Nova does, one request each, in order: "open Slack", "brief me". */
  steps: string[];
}

export interface RoutineService {
  list(): Routine[];
  save(routine: Routine): Promise<void>;
}

/** One memory: a fact the user said, or agreed to when Nova suggested it. */
export interface MemoryItem {
  id: string;
  text: string;
  /** Saved over an older wording of the same thing: that wording. */
  replaced?: string;
  /** How related it is to what was asked, 0-1 (when asked for related ones). */
  score?: number;
}

/** Nova's memory of the user, and of past conversations. */
export interface MemoryService {
  /** Whether Nova may offer to remember what the user didn't ask it to (it always asks first). */
  readonly suggestions?: boolean;
  remember(fact: string, source: 'said' | 'suggested'): MemoryItem;
  /** The memories most related to a question, best first (all of them, when there are few). */
  recall(query: string, limit?: number): MemoryItem[];
  forget(id: string): boolean;
  searchConversations(query: string, days?: number): Promise<{ at: number; user: string; nova: string }[]>;
}

/** What Nova sees, when the user asks it to look. */
export interface ScreenService {
  look(scope: 'window' | 'screen'): Promise<{ app?: string; window?: string; text: string; image?: { data: string; mimeType: string } }>;
}

/** Things only the shell (the UI) can do, like its microphone. */
export interface ShellService {
  setListening(on: boolean): void;
  openSettings(): void;
}

export interface SkillResult {
  say: string;
  card?: Card;
  activity: string;
  /** What a brain calling it as a tool gets, when that's more than what's said (the text read off the screen). */
  data?: string;
  /** A picture for brains that can see (a screenshot). */
  image?: { data: string; mimeType: string };
  /** It needs to know when: Nova asks, and the answer completes the request ("When should I remind you?"). */
  needs?: 'when';
  /** A brain should give the answer (with its tools), from this: Nova speaks that instead of `say`, when it has a brain. */
  handoff?: string;
  /** How to take it back - kept in the record, for "undo that". */
  undo?: UndoStep;
}

export interface Skill {
  id: string;
  /** What it does, for agents and models that call it as a tool. */
  summary?: string;
  /** Example phrasings - passed to Jev as the Choice criteria description. */
  examples: string[];
  tier: RiskTier;
  needsApp?: boolean;
  needsProject?: boolean;
  /** With no project named, the one the user is working on will do. */
  usesCurrentProject?: boolean;
  /** It takes the whole request even when it says several things ("when I say start work, open Slack and brief me"). */
  wholeUtterance?: boolean;
  /**
   * What "yes, always" would remember for this request - narrow and stable ("quit Spotify", "Claude
   * working in the website") - or null when it must always ask (anything that deletes).
   */
  rememberAs?: (ctx: SkillContext) => { key: string; label: string } | null;
  /** Offered only when agents are paired. */
  needsAgents?: boolean;
  /** An agent may be named ("undo what Claude did"); as a tool it takes `agent`, and none means anyone's. */
  namesAgent?: boolean;
  /** It acts on what the request says (a duration, a fact, a task): a tool call without `request` is refused, never filled in from an example. */
  needsRequest?: boolean;
  /**
   * Settle what the request is about when it comes in, before the tier is decided and the user is
   * asked (the action "undo" means, which file "the invoice" is), so the question can name it and a
   * yes acts on exactly that - not on whatever is newest by then. Reaches the skill as `ctx.prepared`.
   */
  prepare?: (ctx: SkillContext) => unknown | Promise<unknown>;
  /** Only a tool for brains, never something System 1 picks for an utterance (reading the screen). */
  toolOnly?: boolean;
  /**
   * The tier for this particular request, when it depends on it - decided in code from what the
   * user said, never from the brain or the content it saw ("remember" asks first unless the user said to).
   */
  tierFor?: (ctx: SkillContext) => RiskTier;
  /** Heard as this skill but, by what was said, not meant for it ("I can't remember where my keys are"): the brain takes it. */
  declines?: (ctx: SkillContext) => boolean;
  /**
   * It answers with information a brain may build on (the time, to work out the time in Tokyo),
   * so the brain using it doesn't mean the request was just this skill: nothing is learned from it.
   */
  informs?: boolean;
  /** Spoken confirmation prompt for tier >= 2. */
  confirmPrompt?: (ctx: SkillContext) => string;
  /** What Nova says when a request of this skill needs a tap on screen (tier 3): where the user can do it. */
  tapPrompt?: (ctx: SkillContext) => string;
  /**
   * What "yes, go ahead with all of it" covers for the rest of this task (the brain using the
   * computer) - never remembered past it. Null: each one is asked.
   */
  session?: (ctx: SkillContext) => { key: string; label: string } | null;
  /** While the user is asked: show what's about to happen (the button about to be clicked); resolves with how to stop showing it. */
  preview?: (ctx: SkillContext) => Promise<(() => void) | void>;
  /** For tools that take more than a request: their own arguments (JSON schema properties), and which are needed. */
  parameters?: { properties: Record<string, unknown>; required?: string[] };
  run(ctx: SkillContext): Promise<SkillResult>;
}

export interface TimerService {
  start(ms: number, label: string): string;
  cancelAll(): number;
}

export interface TaskService {
  /** Hand a task to an agent in the background; Nova narrates it and announces the result. */
  start(agent: AgentRef, task: string, project: string): string;
  cancelAll(): number;
  /** What the agents are doing, and what they did lately. */
  status(): { running: TaskRecord[]; recent: TaskRecord[] };
}

/** An agent's task, as the task board shows it. */
export interface TaskRecord {
  id: string;
  agent: string;
  label: string;
  project: string;
  task: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  /** What it's doing now (the last step). */
  step?: string;
  /** Its final message, or why it failed. */
  report?: string;
  started: number;
  ended?: number;
}
