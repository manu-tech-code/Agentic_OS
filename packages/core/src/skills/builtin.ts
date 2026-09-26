import type { Skill } from './types.ts';

const id = () => Math.random().toString(36).slice(2, 10);

/**
 * Direct skills: handled entirely in code after one System 1 decision.
 * No LLM involved - this is what makes "open Spotify" feel instant.
 */
export const builtinSkills: Skill[] = [
  {
    id: 'open_app',
    tier: 0,
    needsApp: true,
    examples: ['open', 'open an application', 'open Safari', 'launch Spotify', 'start Slack', 'bring up Visual Studio Code', 'switch to Chrome'],
    async run({ app, platform }) {
      await platform.openApp(app!);
      return {
        say: `Opening ${app}.`,
        activity: `Opened ${app}`,
        card: { id: id(), kind: 'app', title: app!, body: 'Opened', icon: 'app' },
      };
    },
  },
  {
    id: 'quit_app',
    tier: 2,
    needsApp: true,
    examples: ['quit', 'close', 'quit an application', 'close Spotify', 'quit Slack', 'shut down Chrome', 'kill Xcode'],
    confirmPrompt: ({ app }) => `Quit ${app}? Unsaved work could be lost.`,
    async run({ app, platform }) {
      await platform.quitApp(app!);
      return {
        say: `${app} closed.`,
        activity: `Quit ${app}`,
        card: { id: id(), kind: 'app', title: app!, body: 'Quit', icon: 'app' },
      };
    },
  },
  {
    id: 'tell_time',
    tier: 0,
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
    tier: 1,
    examples: ['set a timer for 5 minutes', 'timer 30 seconds', 'remind me in 10 minutes', 'start a countdown'],
    async run({ utterance, timers }) {
      // Durations are arithmetic: parsed in code, never by the decision model.
      const ms = parseDuration(utterance);
      if (!ms) return { say: 'For how long?', activity: 'Timer: missing duration' };
      const label = humanDuration(ms);
      const timerId = timers.start(ms, label);
      return {
        say: `Timer set for ${label}.`,
        activity: `Timer ${label}`,
        card: { id: timerId, kind: 'timer', title: `Timer · ${label}`, endsAt: Date.now() + ms },
      };
    },
  },
  {
    id: 'cancel_timer',
    tier: 0,
    examples: ['cancel the timer', 'stop the timer', 'clear my timers'],
    async run({ timers }) {
      const n = timers.cancelAll();
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

export function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const parts = [h && `${h} hour${h > 1 ? 's' : ''}`, m && `${m} minute${m > 1 ? 's' : ''}`, sec && `${sec} second${sec > 1 ? 's' : ''}`];
  return parts.filter(Boolean).join(' ');
}
