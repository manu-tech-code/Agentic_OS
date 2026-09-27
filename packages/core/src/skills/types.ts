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
  /** What the skill's `prepare` settled when the request came in: the thing a confirmation named. */
  prepared?: unknown;
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
   * Settle what the request is about when it comes in (the action "undo" means), so a yes to the
   * confirmation acts on exactly that - not on whatever is newest by then. Reaches the skill as `ctx.prepared`.
   */
  prepare?: (ctx: SkillContext) => unknown;
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
