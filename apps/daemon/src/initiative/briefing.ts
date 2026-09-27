import { clockText, onDay, toYou, type BriefingService, type Reminder, type TaskRecord } from '@nova/core';
import { sayWeather, type WeatherToday } from './weather.ts';

/** An event in the user's calendar, as Nova.app reads it. */
export interface CalendarEvent {
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  /** How many people are invited (0 when it's just the user). */
  attendees: number;
  location?: string;
  /** It has a video call link (Zoom, Meet, Teams...). */
  call?: boolean;
}

const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/**
 * The briefing: the day, the weather, what's on the calendar, the reminders, and what the agents
 * did - gathered in code and said plainly. When the user wants it and a brain is there, the brain
 * gets these facts and adds what their connected services hold for today (issues, reviews).
 */
export class Briefing implements BriefingService {
  constructor(
    private readonly opts: {
      now: () => Date;
      name: () => string;
      calendar: (from: Date, to: Date) => Promise<CalendarEvent[] | null>;
      weather: () => Promise<WeatherToday | null>;
      reminders: () => Reminder[];
      tasks: () => TaskRecord[];
      missed: () => { at: number; text: string }[];
      /** The services the brain could look in, and whether to ask it. */
      brain: () => { use: boolean; services: string[] };
    },
  ) {}

  async compose() {
    const now = this.opts.now();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const [events, weather] = await Promise.all([
      this.opts.calendar(now, endOfDay).catch(() => null),
      this.opts.weather().catch(() => null),
    ]);
    const facts: string[] = [];
    const spoken: string[] = [];
    const part = now.getHours() < 12 ? 'morning' : now.getHours() < 18 ? 'afternoon' : 'evening';
    const date = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    facts.push(`It's ${date}, ${clockText(now)}.`);
    spoken.push(`Good ${part}. It's ${date}.`);

    if (weather) {
      facts.push(`Weather: ${weather.now}°${weather.unit} and ${weather.sky} in ${weather.place} now; high ${weather.high}°, low ${weather.low}°; ${weather.rain}% chance of rain.`);
      spoken.push(sayWeather(weather));
    }

    if (events) {
      const coming = events.filter((e) => e.end > now.getTime()).sort((a, b) => a.start - b.start);
      if (!coming.length) {
        facts.push('Calendar: nothing more today.');
        spoken.push('Your calendar is clear for the rest of the day.');
      } else {
        facts.push(`Calendar today: ${coming.map((e) => `${e.allDay ? 'all day' : clockText(new Date(e.start))} ${e.title}${e.attendees > 1 ? ` (${e.attendees} people)` : ''}${e.location ? ` at ${e.location}` : ''}`).join('; ')}.`);
        const said = coming.slice(0, 4).map((e) => (e.allDay ? e.title : `${e.title} at ${clockText(new Date(e.start))}`));
        spoken.push(`You have ${coming.length === 1 ? 'one thing' : `${coming.length} things`} on your calendar: ${list(said)}${coming.length > 4 ? ', and more' : ''}.`);
      }
    }

    const today = this.opts.reminders().filter((r) => r.due !== null && r.due < endOfDay.getTime() && r.due >= now.getTime() - 60_000);
    if (today.length) {
      facts.push(`Reminders today: ${today.map((r) => `${r.text || 'timer'} at ${clockText(new Date(r.due!))}`).join('; ')}.`);
      spoken.push(`Reminders: ${list(today.slice(0, 4).map((r) => `${toYou(r.text) || 'one'} at ${clockText(new Date(r.due!))}`))}.`);
    }

    const since = now.getTime() - 16 * 3_600_000;
    const tasks = this.opts.tasks();
    const running = tasks.filter((t) => t.status === 'running');
    const ended = tasks.filter((t) => t.status !== 'running' && (t.ended ?? 0) > since);
    if (running.length || ended.length) {
      facts.push(`Agents: ${[...running.map((t) => `${t.label} is working on "${t.task}" in ${t.project}`), ...ended.map((t) => `${t.label} ${t.status === 'done' ? 'finished' : t.status === 'failed' ? 'failed at' : 'stopped'} "${t.task}" in ${t.project}${t.report ? ` - said: ${t.report.slice(0, 300)}` : ''}`)].join('; ')}.`);
      const done = ended.filter((t) => t.status === 'done');
      const failed = ended.filter((t) => t.status === 'failed');
      spoken.push(
        [
          done.length ? `${list([...new Set(done.map((t) => t.label))])} finished ${done.length === 1 ? 'a task' : `${done.length} tasks`}` : '',
          failed.length ? `${failed.length === 1 ? 'one task' : `${failed.length} tasks`} failed` : '',
          running.length ? `${list([...new Set(running.map((t) => t.label))])} ${running.length === 1 ? 'is' : 'are'} still working` : '',
        ]
          .filter(Boolean)
          .join('; ')
          .replace(/^./, (c) => c.toUpperCase()) + '.',
      );
    }

    const missed = this.opts.missed();
    if (missed.length) facts.push(`Held back while the user was away: ${missed.map((m) => `${onDay(new Date(m.at), now)}: ${m.text}`).join(' ')}`);

    const brain = this.opts.brain();
    const ask =
      brain.use && brain.services.length
        ? `Give me my ${part} briefing, spoken: a few natural sentences, no lists, no markdown. Here's what ${this.opts.name()} knows:\n${facts.map((f) => `- ${f}`).join('\n')}\n` +
          `Also look in my connected services (${brain.services.join(', ')}) for anything that needs me today - issues assigned to me, reviews waiting, things due - and mention only what matters. Don't repeat the date and time unless it helps.`
        : undefined;
    return { facts, spoken: spoken.join(' '), ask };
  }
}
