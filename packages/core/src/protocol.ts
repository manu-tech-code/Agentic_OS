/**
 * Wire protocol between the Nova daemon (brain) and any shell (desktop, web, IDE).
 * Dependency-free so UIs can import it without pulling in model SDKs.
 */
import type { HearingStatus, SettingsSnapshot, SettingValue, ShellContext, ShellStatus } from './settings.ts';
import type { TaskRecord } from './skills/types.ts';

export type Phase = 'idle' | 'listening' | 'thinking' | 'acting' | 'speaking';

/** How the Orb looks. */
export interface OrbPrefs {
  /** Particles: a sphere of moving dots. Glass: the classic orb. */
  style: 'particles' | 'glass';
  colors: 'nova' | 'aurora' | 'ember' | 'ice';
  motion: 'lively' | 'calm' | 'still';
}

/** Preferences the shell applies itself (browser speech APIs, looks), set in Settings. */
export interface UiPrefs {
  autoListen: boolean;
  /** How fast Kokoro speaks (1 = normal). */
  rate: number;
  lang: string;
  orb: OrbPrefs;
}

/** How Nova's Mac app behaves, from Settings → Menu bar. */
export interface PresenceConfig {
  /** Held to talk, tapped to listen: "option+space". */
  shortcut: string;
  /** When the microphone listens for the name: always, while the window is open, or only after the shortcut. */
  listen: 'always' | 'window' | 'shortcut';
  pauseWhenLocked: boolean;
  /** The corner the orb appears in. */
  orb: 'bottom-right' | 'top-right' | 'bottom-left' | 'top-left';
  /** How long a reply stays up after Nova finishes speaking. */
  orbSeconds: number;
  sounds: boolean;
  launchAtLogin: boolean;
  /** Who runs the daemon: Nova.app, or the user in a terminal. */
  daemon: 'app' | 'terminal';
}

/** Things Settings asks Nova's Mac app to do (the daemon passes them on). */
export type ShellAction =
  | 'request-mic'
  | 'open-mic-settings'
  | 'open-login-items'
  | 'restart-daemon'
  | 'request-calendar'
  | 'request-reminders'
  | 'request-notifications'
  | 'open-privacy-settings';

/** What the daemon asks Nova's Mac app for: the Reminders app, the calendar, a notification. */
export type ShellOp = 'reminders.add' | 'reminders.list' | 'reminders.complete' | 'reminders.remove' | 'calendar.events' | 'notify';

export type RiskTier = 0 | 1 | 2 | 3;

export interface Card {
  id: string;
  kind: 'app' | 'time' | 'timer' | 'reminder' | 'info' | 'confirm' | 'error' | 'answer' | 'task';
  title: string;
  body?: string;
  /** epoch ms, for countdown cards */
  endsAt?: number;
  icon?: string;
  /** The agent working on a task card. */
  agent?: string;
}

export interface ActivityItem {
  id: string;
  at: number;
  label: string;
  status: 'done' | 'failed' | 'pending' | 'cancelled';
  skill?: string;
  tier?: RiskTier;
  /** Who asked: "you", a brain or agent by name, "routine: start work", or "Nova" for what it did by itself. */
  by?: string;
  /** It can be undone (the timeline's Undo, or "undo that"). */
  undoable?: boolean;
  /** When it was undone. */
  undone?: number;
  /** The files an agent changed (undoing it puts them back). */
  files?: string[];
}

/**
 * How to take an action back, kept with it in the record. Each is the opposite of one thing Nova
 * did - never more - and runs only when the user asks.
 */
export type UndoStep =
  | { kind: 'reminder-cancel'; id: string }
  | { kind: 'reminder-restore'; reminder: { text: string; about?: 'to' | 'about' | 'that'; due: number | null; schedule?: unknown; countdown?: boolean; ms?: number; apple?: boolean } }
  | { kind: 'memory-forget'; id: string }
  | { kind: 'memory-restore'; text: string; source: 'said' | 'suggested' }
  /** Saying something again replaced its older wording: put that back. */
  | { kind: 'memory-edit'; id: string; text: string }
  | { kind: 'routine-delete'; name: string }
  | { kind: 'routine-restore'; name: string; routine: { phrase?: string; schedule?: string; steps: string[] } }
  | { kind: 'app-quit'; app: string }
  | { kind: 'app-open'; app: string }
  | { kind: 'project-set'; name: string | null }
  /**
   * Put a project's files back as they were before an agent's task. `before` and `after` are
   * snapshot commits (kept under refs/nova/snapshots); `files` are the paths the agent changed.
   * `shared`: another task worked in the project at the same time, so its changes are in there too.
   */
  | { kind: 'agent-files'; project: string; before: string; after: string; agent: string; files: string[]; shared?: boolean }
  | { kind: 'batch'; steps: UndoStep[] };

export interface DecisionTrace {
  utterance: string;
  engine: string;
  latencyMs: number;
  fellBack: boolean;
  answers: Record<string, unknown>;
  outcome: string;
}

/** daemon -> shell */
export type ServerEvent =
  | {
      type: 'hello';
      /** The assistant's name, set in Settings (default "Nova"). */
      name: string;
      engine: string;
      brain: string | null;
      apps: number;
      wakeWords: string[];
      requireWakeWord: boolean;
      /** Paired agents, default first. */
      agents: { name: string; label: string }[];
      projects: string[];
      ui: UiPrefs;
      hearing: HearingStatus;
    }
  /** The hearing engine changed or became ready (or couldn't start). */
  | { type: 'hearing'; status: HearingStatus }
  /** What Nova is hearing: words so far (`final` false), then the whole turn it acts on. */
  | { type: 'transcript'; text: string; final: boolean }
  /** The user started talking over Nova: stop speaking now. */
  | { type: 'barge-in' }
  /** Ask the shell to turn its microphone on or off (e.g. "stop listening"). */
  | { type: 'listen'; on: boolean }
  /** Ask the shell to open one of its panels (e.g. "open settings"). */
  /** Open a panel: Settings, or the first-run walkthrough. */
  | { type: 'show'; panel: 'settings' | 'welcome' }
  | { type: 'settings'; snapshot: SettingsSnapshot }
  | { type: 'settings-result'; ok: boolean; message: string }
  | { type: 'phase'; phase: Phase; label?: string }
  /**
   * A reply to speak. A reply written as it streams arrives as several events with one `id`: each
   * carries the finished sentences so far (`partial`), the last one the whole reply. `audio` is set
   * when the daemon speaks it in a natural voice (Kokoro), streamed under that id.
   */
  | { type: 'say'; text: string; id?: string; partial?: boolean; audio?: string }
  /** Speech audio for a reply or a voice preview: 16-bit PCM in base64, one sentence per event, in order. */
  | { type: 'audio'; id: string; seq: number; sampleRate: number; pcm: string; last: boolean; error?: string }
  | { type: 'card'; card: Card }
  | { type: 'dismiss'; id: string }
  /** Something Nova did. `undo` is kept by the daemon with its record; windows only see `item.undoable`. */
  | { type: 'activity'; item: ActivityItem; undo?: UndoStep }
  | { type: 'decision'; trace: DecisionTrace }
  /** What Nova Eyes sees now, for Settings (the notes a question would get). */
  | { type: 'screen-preview'; text: string }
  /** To Nova's Mac app: how to behave (sent when it connects, and whenever Settings change). */
  | { type: 'shell-config'; presence: PresenceConfig }
  /** To Nova's Mac app: something Settings asked it to do. */
  | { type: 'shell-action'; action: ShellAction }
  /** To windows: Nova's Mac app hears and speaks for Nova (true), so windows neither listen nor speak - or it's gone (false). */
  | { type: 'voice-owner'; app: boolean }
  /** To Nova's Mac app: do this and answer with `shell-reply` under the same id. */
  | { type: 'shell-request'; id: string; op: ShellOp; args: Record<string, unknown> }
  /** The task board: agents' tasks, newest first. */
  | { type: 'tasks'; tasks: TaskRecord[] }
  /** The record of what Nova did lately, newest first (sent as a window connects). */
  | { type: 'activity-history'; items: ActivityItem[] }
  /** One entry of the record changed (it was undone). */
  | { type: 'activity-update'; item: ActivityItem }
  /** What a search of the whole record found, newest first. */
  | { type: 'activity-found'; query: string; items: ActivityItem[] }
  | { type: 'error'; message: string };

/**
 * shell -> daemon. Besides these JSON events, a window that hears for Nova (see `hello.hearing`)
 * sends its microphone as binary messages: 16 kHz mono 16-bit little-endian PCM, after `audio-start`.
 */
export type ClientEvent =
  | { type: 'utterance'; text: string; source: 'voice' | 'keyboard' }
  | { type: 'audio-start'; sampleRate: number }
  | { type: 'audio-stop' }
  | { type: 'speech-finished' }
  | { type: 'cancel' }
  | { type: 'settings-get' }
  /** Keys are settings-file paths ("voice.rate"); null resets one to its default. */
  | { type: 'settings-set'; values: Record<string, SettingValue | null> }
  /** Download Reflex's embedding model, or forget what Reflex learned. */
  | { type: 'reflex-install' }
  | { type: 'reflex-forget' }
  /** Download Kokoro, the natural voice. */
  /** Download a model for hearing: Parakeet (speech to text) or Smart Turn (when you've finished). */
  | { type: 'hearing-install'; model: 'parakeet' | 'smart-turn' }
  /** Change or forget a memory, forget them all, or clear the conversation history. */
  | { type: 'memory-edit'; id: string; text: string }
  | { type: 'memory-delete'; id: string }
  | { type: 'memory-clear' }
  | { type: 'conversations-clear' }
  /** Ask macOS to let Nova Eyes see (it shows its own prompt), start Nova Eyes afresh, or show what it sees now. */
  | { type: 'screen-permission'; kind: 'accessibility' | 'screen' }
  | { type: 'screen-restart' }
  | { type: 'screen-preview' }
  /** Sign in to an integration with the browser, sign out of one, or try connecting again. */
  | { type: 'integration-sign-in'; name: string }
  | { type: 'integration-sign-out'; name: string }
  | { type: 'integration-retry'; name: string }
  /** Hear a Kokoro voice: its audio comes back to this window under `id`. */
  | { type: 'voice-preview'; id: string; voice: string }
  /**
   * Nova's Mac app says hello: from now on it hears (it streams its microphone) and speaks for
   * Nova (reply audio goes to it alone), and it reports what macOS lets it do.
   */
  | { type: 'shell-hello'; kind: 'mac'; version: string }
  | { type: 'shell-status'; status: ShellStatus }
  /** The shortcut went down: stop speaking and listen - what comes next is for Nova, wake word or not. */
  | { type: 'talk-start' }
  /** The shortcut came up: held, the turn ends now; tapped, Nova keeps listening until the user pauses. */
  | { type: 'talk-end'; held: boolean }
  /** Tapped again: stop listening (until the wake word, or the shortcut). */
  | { type: 'listen-stop' }
  /** From Settings, for Nova's Mac app. */
  | { type: 'shell-action'; action: ShellAction }
  /** Nova's Mac app answers a `shell-request`. */
  | { type: 'shell-reply'; id: string; ok: boolean; result?: unknown; error?: string }
  /** Nova's Mac app says whether the user is here: locked, on a call, away from the keyboard. */
  | { type: 'shell-context'; context: ShellContext }
  /** A button on one of Nova's notifications. */
  | { type: 'notification-action'; ref: string; action: 'snooze' | 'done' | 'open' }
  /** From the task board. */
  | { type: 'task-cancel'; id: string }
  | { type: 'task-retry'; id: string }
  /** From Settings: cancel one reminder. */
  | { type: 'reminder-cancel'; id: string }
  /** From the timeline: take one action back. */
  | { type: 'activity-undo'; id: string }
  /** Search the whole record (older than what the timeline holds): words, who asked, how many days back. */
  | { type: 'activity-search'; query: string; days?: number }
  /** Stop everything: agents, questions, speech, routines - and mute the microphone. */
  | { type: 'stop-all' }
  /** The first-run walkthrough is done (or skipped). */
  | { type: 'setup-done' };
