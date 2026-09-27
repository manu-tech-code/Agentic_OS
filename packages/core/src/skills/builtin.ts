import { spokenDuration } from '../when.ts';
import { cancelling, cancelPrompt, cancelReminders, reminderText, snoozeReminder, snoozesRecent } from './initiative.ts';
import { toYou } from './memory.ts';
import type { Skill } from './types.ts';

const id = () => Math.random().toString(36).slice(2, 10);

/**
 * Direct skills: handled entirely in code after one System 1 decision.
 * No LLM involved - this is what makes "open Spotify" feel instant.
 */
export const builtinSkills: Skill[] = [
  {
    id: 'open_app',
    summary: "Open an app on the user's Mac, or switch to it.",
    tier: 0,
    needsApp: true,
    examples: ['open', 'open an application', 'open Safari', 'launch Spotify', 'start Slack', 'bring up Visual Studio Code', 'switch to Chrome'],
    async run({ app, platform }) {
      // Undone by quitting it - but only if it wasn't running already (switching to it is no reason to close it).
      const wasRunning = platform.isRunning ? await platform.isRunning(app!).catch(() => true) : true;
      await platform.openApp(app!);
      return {
        say: `Opening ${app}.`,
        activity: `Opened ${app}`,
        card: { id: id(), kind: 'app', title: app!, body: 'Opened', icon: 'app' },
        undo: wasRunning ? undefined : { kind: 'app-quit', app: app! },
      };
    },
  },
  {
    id: 'quit_app',
    summary: "Quit an app on the user's Mac.",
    tier: 2,
    needsApp: true,
    examples: ['quit', 'close', 'quit an application', 'close Spotify', 'quit Slack', 'shut down Chrome', 'kill Xcode'],
    confirmPrompt: ({ app }) => `Quit ${app}? Unsaved work could be lost.`,
    rememberAs: ({ app }) => (app ? { key: `quit_app:${app}`, label: `Quit ${app}` } : null),
    async run({ app, platform }) {
      await platform.quitApp(app!);
      return {
        say: `${app} closed.`,
        activity: `Quit ${app}`,
        card: { id: id(), kind: 'app', title: app!, body: 'Quit', icon: 'app' },
        undo: { kind: 'app-open', app: app! },
      };
    },
  },
  {
    id: 'tell_time',
    summary: 'The local date and time right now.',
    tier: 0,
    informs: true,
    examples: ['what time is it', 'tell me the time', 'what is the date today', 'what day is it'],
    async run({ platform }) {
      const now = platform.now();
      const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const date = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
      return { say: `It's ${time}.`, activity: 'Told the time', card: { id: id(), kind: 'time', title: time, body: date } };
    },
  },
  {
    id: 'set_timer',
    summary: 'Start a countdown timer. Put the duration in request, e.g. "10 minutes".',
    tier: 1,
    examples: ['set a timer for 5 minutes', 'timer 30 seconds', 'remind me in 10 minutes', 'start a countdown'],
    async run(ctx) {
      const { utterance, timers, reminders } = ctx;
      if (snoozesRecent(ctx)) return snoozeReminder(ctx, reminders!.recent()!);
      // Durations are arithmetic: parsed in code, never by the decision model.
      const ms = parseDuration(utterance);
      if (!ms) return { say: 'For how long?', activity: 'Timer: missing duration' };
      const label = humanDuration(ms);
      if (reminders) {
        // Kept by the daemon, so it outlasts a restart. "Remind me in 10 minutes to check the oven" is a reminder too.
        const { text, about, reminder } = countdownText(utterance);
        const due = ctx.platform.now().getTime() + ms;
        const item = await reminders.add({ text, about: reminder ? about : undefined, due, countdown: true, ms });
        return {
          say: reminder && text ? `Okay, I'll remind you to ${toYou(text)} in ${spokenDuration(ms)}.` : `Timer set for ${label}${text ? ` - ${toYou(text)}` : ''}.`,
          activity: reminder && text ? `Reminder in ${label}: ${text}` : `Timer ${label}${text ? ` · ${text}` : ''}`,
          card: { id: item.id, kind: 'timer', title: text ? `${text} · ${label}` : `Timer · ${label}`, endsAt: due },
          undo: { kind: 'reminder-cancel', id: item.id },
        };
      }
      const timerId = timers.start(ms, label);
      return {
        say: `Timer set for ${label}.`,
        activity: `Timer ${label}`,
        card: { id: timerId, kind: 'timer', title: `Timer · ${label}`, endsAt: Date.now() + ms },
      };
    },
  },
  {
    id: 'stop_listening',
    summary: "Turn the assistant's microphone off (only when the user asks).",
    tier: 0,
    examples: ['stop listening', 'go to sleep', 'turn off the microphone', 'mute yourself', 'stop listening to me'],
    async run({ shell }) {
      shell.setListening(false);
      return { say: "Okay, I've stopped listening. Tap the microphone when you need me.", activity: 'Stopped listening' };
    },
  },
  {
    id: 'open_settings',
    summary: "Show the assistant's settings window.",
    tier: 0,
    examples: ['open settings', 'show your settings', 'open nova settings', 'change your settings', 'open preferences'],
    async run({ shell }) {
      shell.openSettings();
      return { say: 'Here are my settings.', activity: 'Opened settings' };
    },
  },
  {
    id: 'cancel_timer',
    summary: 'Cancel the running timers.',
    tier: 0,
    examples: ['cancel the timer', 'stop the timer', 'clear my timers'],
    // "Cancel my reminder" with no timer running means a reminder: that's confirmed first.
    tierFor: (ctx) => (cancelsReminder(ctx) ? 2 : 0),
    confirmPrompt: (ctx) => cancelPrompt(ctx),
    async run(ctx) {
      const { timers, reminders, utterance } = ctx;
      if (cancelsReminder(ctx)) return cancelReminders(ctx);
      let n = timers.cancelAll();
      if (reminders) {
        // Timers and "in 10 minutes" reminders; reminders at a time are cancelled by name (cancel_reminder).
        for (const r of reminders.list().filter((r) => r.countdown)) if (await reminders.cancel(r.id)) n++;
        if (!n && /\breminder/i.test(utterance) && reminders.list().length) {
          return { say: 'No timers are running. To cancel a reminder, tell me which - like "cancel the reminder to call mum".', activity: 'No timers running' };
        }
      }
      return { say: n ? `Cancelled ${n === 1 ? 'your timer' : `${n} timers`}.` : 'No timers running.', activity: 'Cancelled timers' };
    },
  },
];

const WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, sixty: 60, ninety: 90,
};
const UNIT: Record<string, number> = { second: 1000, sec: 1000, minute: 60_000, min: 60_000, hour: 3_600_000, hr: 3_600_000 };

export function parseDuration(text: string): number | null {
  let t = text.toLowerCase();
  let total = 0;
  if (/half an? hour/.test(t)) {
    total += 30 * 60_000;
    t = t.replace(/half an? hour/g, ' ');
  }
  const re = /(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty-five|forty|sixty|ninety)\s*(second|sec|minute|min|hour|hr)s?\b/g;
  for (const m of t.matchAll(re)) {
    const n = Number.isNaN(Number(m[1])) ? WORDS[m[1]!] ?? 0 : Number(m[1]);
    total += n * (UNIT[m[2]!] ?? 0);
  }
  return total > 0 ? total : null;
}

/** No timer to cancel, and a reminder the words name: "cancel my reminder" is about that. */
function cancelsReminder(ctx: Parameters<NonNullable<Skill['tierFor']>>[0]) {
  if (!ctx.reminders || !/\breminder/i.test(ctx.utterance) || ctx.reminders.list().some((r) => r.countdown)) return false;
  return cancelling(ctx).items.length > 0;
}

/**
 * What a countdown is for: "remind me in 10 minutes to check the oven" is a reminder ("check the
 * oven"); "set a timer for the laundry, 40 minutes" is a timer with a label ("the laundry").
 */
export function countdownText(utterance: string): { text: string; about: 'to' | 'about' | 'that'; reminder: boolean } {
  const reminder = /\b(?:remind|reminder|don'?t let me forget|tell me to|let me know)\b/i.test(utterance);
  const spoken = utterance
    .replace(/\b(?:in|for|after|within)?\s*(?:about\s+)?(?:\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty-five|forty|sixty|ninety|half an?)\s*(?:and a half\s*)?(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)\b(?:\s+from\s+now)?/gi, ' ')
    .replace(/^\s*(?:(?:hey|okay|ok|so|please|nova|um)[\s,]+)*(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:set|start|put|make|give me|get me|i need|i want)?\s*(?:me\s+)?(?:a|an|the|my)?\s*(?:timer|countdown|alarm)s?\b\s*(?:for|on)?\s*/i, ' ')
    .replace(/\b(?:on the clock|please|thanks|now)\b/gi, ' ');
  const { text, about } = reminderText(spoken);
  const label = text.replace(/^(?:a|an|the)\s+(?:timer|countdown|alarm)$/i, '').replace(/^(?:tell me|let me know|ping me|alert me|notify me|nudge me)\s*/i, '');
  return { text: label.length > 1 ? label : '', about, reminder };
}

export function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const parts = [h && `${h} hour${h > 1 ? 's' : ''}`, m && `${m} minute${m > 1 ? 's' : ''}`, sec && `${sec} second${sec > 1 ? 's' : ''}`];
  return parts.filter(Boolean).join(' ');
}
