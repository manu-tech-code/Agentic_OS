import { join } from 'node:path';
import { dueText, nextTime, onDay, type News, type Phase, type PhoneReminder, type Reminder, type Routine, type ServerEvent, type SettingsSnapshot, type ShellContext, type TaskRecord } from '@nova/core';
import type { Config } from '../config.ts';
import type { Presence } from '../shell/presence.ts';
import { ShellRpc } from '../shell/rpc.ts';
import { Briefing, type CalendarEvent } from './briefing.ts';
import { atTime, type Waiting } from './clock.ts';
import { Deliverer, type Moment } from './deliver.ts';
import { ReminderStore, type AppleReminders } from './reminders.ts';
import { LATE_RUN_MS, Routines } from './routines.ts';
import { InitiativeState, projectIn } from './state.ts';
import { TaskStore } from './tasks.ts';
import { Weather } from './weather.ts';

/** What Initiative needs of NovaBrain, set once Nova is up. */
export interface NovaForInitiative {
  tell(text: string): void;
  runRoutine(routine: Routine): Promise<void>;
  cancelTask(id: string): boolean;
  retryTask(task: Pick<TaskRecord, 'agent' | 'task' | 'project'>): string | null;
}

const BUSY: Phase[] = ['thinking', 'acting', 'speaking'];
/** After the first window or Nova.app connects: a moment for Nova.app to say hello, so it speaks what waited. */
const SETTLE_MS = 2000;
const localDay = (at: Date) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;

/**
 * Nova's initiative, put together: reminders (its own and the Reminders app's), the morning
 * briefing, routines, agents reporting back, the project the user is on - and the one judgement
 * they share: whether now is a good moment to speak up.
 */
export class Initiative {
  readonly rpc: ShellRpc;
  readonly reminders: ReminderStore;
  readonly deliverer: Deliverer;
  readonly briefing: Briefing;
  readonly routines: Routines;
  readonly state: InitiativeState;
  readonly tasks: TaskStore;
  nova: NovaForInitiative | null = null;
  private readonly weather = new Weather();
  private context: ShellContext | null = null;
  private calendar: { at: number; events: CalendarEvent[] } | null = null;
  private phase: Phase = 'idle';
  private phaseAt = 0;
  private wasAway = false;
  private wasCall = false;
  private briefWhenBack = false;
  private weatherStatus: SettingsSnapshot['initiative']['weather'] = null;
  private briefTimer: Waiting | undefined;
  private listenerTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly timers: ReturnType<typeof setInterval>[] = [];

  constructor(
    private readonly opts: {
      home: string;
      config: () => Config;
      presence: Presence<unknown>;
      /** To every window: news cards, the task board. */
      broadcast: (event: ServerEvent) => void;
      /** Services connected through Nova, by label - where the brain can look for the briefing. */
      services: () => string[];
      hasBrain: () => boolean;
      saveRoutine: (routine: Routine) => Promise<void>;
      /** Settings should show something new. */
      changed: () => void;
      /** A paired iPhone with Nova open: whether there is one, and saying something on it. */
      phone?: { inUse: () => boolean; tell: (text: string) => void };
    },
  ) {
    const { home, config } = opts;
    this.rpc = new ShellRpc((event) => opts.presence.send(event));
    this.deliverer = new Deliverer({
      policy: () => config().initiative.speak,
      moment: () => this.moment(),
      speak: (text) => this.nova?.tell(text),
      notify: (news) => this.notify(news),
      phone: {
        wants: (away) => {
          if (!opts.phone?.inUse()) return false;
          const when = config().phone.news;
          return when === 'always' || (when === 'away' && away);
        },
        speak: (text) => opts.phone?.tell(text),
      },
    });
    this.reminders = new ReminderStore({
      file: join(home, 'reminders.json'),
      due: (r, late) => this.due(r, late),
      apple: () => this.apple(),
      mode: () => config().initiative.appleReminders,
      list: () => config().initiative.remindersList,
      changed: opts.changed,
    });
    this.tasks = new TaskStore(join(home, 'tasks.json'), (tasks) => opts.broadcast({ type: 'tasks', tasks: tasks.slice(0, 50) }));
    this.state = new InitiativeState(join(home, 'state.json'), opts.changed);
    this.briefing = new Briefing({
      now: () => new Date(),
      name: () => config().name,
      calendar: (from, to) => this.events(from, to, true),
      weather: () => this.todaysWeather(),
      reminders: () => this.reminders.list(),
      tasks: () => this.tasks.list(),
      missed: () => this.deliverer.missed(),
      brain: () => ({ use: config().initiative.briefingBrain && opts.hasBrain(), services: opts.services() }),
    });
    this.routines = new Routines({
      routines: () => config().routines ?? {},
      save: opts.saveRoutine,
      run: (routine) => void this.nova?.runRoutine(routine),
      away: () => this.moment().away,
    });
  }

  async load() {
    await Promise.all([this.reminders.load(), this.tasks.load(), this.state.load()]);
    this.configure();
    // Every minute: has a meeting ended, has the user come back? Every five: what the Reminders app holds.
    this.timers.push(setInterval(() => this.check(), 60_000));
    this.timers.push(setInterval(() => void this.syncApple(), 5 * 60_000));
    return this;
  }

  /** What NovaBrain gets. */
  get options() {
    return {
      reminders: this.reminders,
      briefing: this.briefing,
      news: this.deliverer,
      projects: this.state,
      routines: this.routines,
      deliver: (news: News) => this.deliverer.deliver(news),
      onTask: (task: TaskRecord) => this.tasks.update(task),
      taskHistory: () => this.tasks.list(),
    };
  }

  /** Settings changed. */
  configure() {
    this.routines.configure();
    this.armBriefing();
  }

  /** Whether now is a good moment to speak up. */
  moment(): Moment {
    const c = this.context;
    const away = Boolean(c && (c.locked || c.idleSeconds > this.opts.config().initiative.awayMinutes * 60));
    // "Speaking" ends when a window says so; if none does (nothing played it), it doesn't hold news up for long.
    const busy = BUSY.includes(this.phase) && Date.now() - this.phaseAt < 45_000;
    return { away, call: Boolean(c?.camera) || this.inMeeting(), busy };
  }

  /** What Nova is doing: when it stops, what waited for it can be said. */
  onPhase(phase: Phase) {
    const was = this.phase;
    this.phase = phase;
    this.phaseAt = Date.now();
    if (BUSY.includes(was) && !BUSY.includes(phase)) setTimeout(() => this.deliverer.idle(), 400);
  }

  /** Nova.app said whether the user is here. */
  onContext(context: ShellContext) {
    const unlocked = context.unlockedAt && context.unlockedAt !== this.context?.unlockedAt;
    this.context = context;
    if (unlocked) {
      this.rearm(); // the Mac may just have woken: what came due while it slept, now
      this.maybeBrief('unlock');
    }
    this.check();
  }

  /** The reminders and timers of the next week, for a phone to ring for itself: what Nova would say, when. */
  phoneReminders(now = Date.now()): PhoneReminder[] {
    return this.reminders
      .list()
      .filter((r) => r.due !== null && r.due > now && r.due < now + 7 * 86_400_000)
      .slice(0, 50)
      .map((r) => {
        const timer = Boolean(r.countdown && !r.about);
        return { id: r.id, title: timer ? (r.text ? `Timer · ${r.text}` : 'Timer') : 'Reminder', body: dueText(r), due: r.due!, timer };
      });
  }

  /** Nova came to the front on the user's iPhone: what waited for them, said there if they're away from the Mac. */
  onPhoneActive() {
    this.deliverer.phoneBack();
  }

  onAppConnected() {
    this.onListener();
    void this.syncApple();
  }

  /**
   * A window or Nova.app connected: someone can hear Nova. Call it on every connection - only the
   * first counts. What came due while no one could (while Nova was off) comes up a moment later,
   * once Nova.app has said hello and can speak it; until then nothing is said to an empty room.
   */
  onListener() {
    if (this.listenerTimer) return;
    this.listenerTimer = setTimeout(() => this.reminders.listening(), SETTLE_MS);
  }

  /** The clock again: after the Mac wakes or the time changes, everything timed is timed afresh. */
  rearm() {
    this.reminders.rearm();
    this.routines.configure();
    this.armBriefing();
  }

  onAppGone() {
    this.rpc.gone();
    this.context = null;
    this.calendar = null;
  }

  /** A button on a notification: snooze it, done, or open Nova. */
  async onNotification(ref: string, action: 'snooze' | 'done' | 'open') {
    if (action === 'snooze') await this.reminders.snooze(ref, 10 * 60_000);
    else if (action === 'done') await this.reminders.done(ref);
  }

  cancelTask(id: string) {
    return this.nova?.cancelTask(id) ?? false;
  }

  retryTask(id: string) {
    const task = this.tasks.get(id);
    return task && task.status !== 'running' ? (this.nova?.retryTask(task) ?? null) : null;
  }

  /** The project the user is on, for the notes that go with a question. */
  notes(): string | null {
    const project = this.state.currentProject;
    return project ? `The user is working on the project "${project.name}"${project.source === 'screen' ? ' (it is in the window they are in)' : ''}.` : null;
  }

  /** What the user is working in: a project in its window becomes the current one. */
  seen(texts: (string | undefined)[], projects: string[]) {
    const name = projectIn(texts, projects);
    if (name) this.state.seen(name);
  }

  snapshot(): SettingsSnapshot['initiative'] {
    return {
      reminders: this.reminders.list().slice(0, 50),
      routines: Object.entries(this.opts.config().routines ?? {}).map(([name, r]) => ({ name, phrase: r.phrase, schedule: r.schedule, steps: r.steps })),
      project: this.state.currentProject,
      weather: this.weatherStatus,
      tasks: this.tasks.list().slice(0, 20),
      moment: { away: this.moment().away, call: this.moment().call, waiting: this.deliverer.count },
    };
  }

  close() {
    for (const t of this.timers) clearInterval(t);
    this.briefTimer?.cancel();
    clearTimeout(this.listenerTimer);
    this.reminders.close();
    this.routines.close();
  }

  flushed() {
    return Promise.all([this.reminders.flushed(), this.tasks.flushed(), this.state.flushed()]).then(() => undefined);
  }

  // --- inside -----------------------------------------------------------------------------

  /** A reminder or timer is due: its card now, the words at a good moment. */
  private due(r: Reminder, late: boolean) {
    const now = new Date();
    const timer = r.countdown && !r.about;
    const text = late && r.due ? `Earlier - ${onDay(new Date(r.due), now)} - you wanted a reminder. ${dueText(r)}` : dueText(r);
    const card = { id: `due-${r.id}-${now.getTime()}`, kind: timer ? ('timer' as const) : ('reminder' as const), title: timer ? (r.text ? `Timer done · ${r.text}` : 'Timer done') : r.text || 'Reminder', body: late ? 'While Nova was off' : undefined };
    this.opts.broadcast({ type: 'card', card });
    this.deliverer.deliver({ kind: timer ? 'timer' : 'reminder', title: card.title, text, ref: r.id, card });
  }

  private notify(news: News) {
    if (!this.opts.presence.connected) return;
    const actions = news.kind === 'reminder' && news.ref ? ['snooze', 'done'] : [];
    this.rpc.request('notify', { ref: news.ref ?? '', title: news.title, body: news.text, actions }, 5000).catch(() => {});
  }

  private access(kind: 'calendar' | 'reminders') {
    return this.opts.presence.connected ? ((this.opts.presence as Presence<unknown>).status?.access?.[kind] ?? null) : null;
  }

  /** The Reminders app, when Nova.app may use it - or may ask to (macOS asks the user as they add one). */
  private apple(): AppleReminders | null {
    const access = this.access('reminders');
    if (access !== 'granted' && access !== 'undetermined') return null;
    return {
      add: (r) => this.rpc.request<string>('reminders.add', r),
      list: () => this.rpc.request<{ id: string; title: string; due: number | null }[]>('reminders.list', { days: 7 }),
      complete: (id) => this.rpc.request('reminders.complete', { id }).then(() => undefined),
      remove: (id) => this.rpc.request('reminders.remove', { id }).then(() => undefined),
    };
  }

  private async syncApple() {
    if (this.access('reminders') !== 'granted') return; // never a prompt out of the blue
    await this.reminders.syncApple().catch((e: Error) => console.warn(`  [reminders] the Reminders app: ${e.message}`));
  }

  /** Events from the calendar (through Nova.app). `ask`: the user is here asking, so macOS may ask them for access. */
  private async events(from: Date, to: Date, ask = false): Promise<CalendarEvent[] | null> {
    const access = this.access('calendar');
    if (!this.opts.config().initiative.calendar || !(access === 'granted' || (ask && access === 'undetermined'))) return null;
    return this.rpc.request<CalendarEvent[]>('calendar.events', { from: from.getTime(), to: to.getTime() });
  }

  /** In a meeting now: a calendar event with other people, or a call link, under way. */
  private inMeeting() {
    const now = Date.now();
    if (!this.calendar || now - this.calendar.at > 5 * 60_000) {
      const start = new Date();
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
      this.calendar = { at: now, events: this.calendar?.events ?? [] };
      void this.events(new Date(start.getFullYear(), start.getMonth(), start.getDate()), end)
        .then((events) => void (this.calendar = { at: Date.now(), events: events ?? [] }))
        .catch(() => {});
    }
    return this.calendar.events.some((e) => !e.allDay && e.start <= now && now < e.end && (e.attendees > 1 || e.call));
  }

  private async todaysWeather() {
    const { town, units } = this.opts.config().initiative;
    if (!town.trim()) {
      this.weatherStatus = null;
      return null;
    }
    try {
      const today = await this.weather.today(town, units);
      this.weatherStatus = { town, ok: true };
      return today;
    } catch (e) {
      this.weatherStatus = { town, ok: false, message: (e as Error).message };
      throw e;
    }
  }

  /** The user came back, or a meeting ended: what was held back, the routines that waited, the briefing. */
  private check() {
    this.deliverer.idle(); // anything that waited for Nova to finish, if it has
    const { away, call } = this.moment();
    const returned = (this.wasAway && !away) || (this.wasCall && !call);
    this.wasAway = away;
    this.wasCall = call;
    if (!returned) return;
    if (this.briefWhenBack) {
      this.briefWhenBack = false;
      this.brief();
    }
    this.routines.back();
    setTimeout(() => this.deliverer.back(), this.briefWhenBack ? 0 : 1500);
  }

  /** The morning briefing - the first unlock after 5 AM, or at the time set - once a day. */
  private maybeBrief(trigger: 'unlock' | 'time') {
    const { briefing } = this.opts.config().initiative;
    const now = new Date();
    if (this.state.briefedOn === localDay(now)) return;
    if (trigger === 'unlock' && (briefing !== 'first-unlock' || now.getHours() < 5 || now.getHours() >= 12)) return;
    if (trigger === 'time' && briefing !== 'time') return;
    if (this.moment().away) {
      this.briefWhenBack = true;
      return;
    }
    this.brief();
  }

  private brief() {
    this.state.briefed(localDay(new Date()));
    void this.nova?.runRoutine({ name: 'Morning briefing', steps: ['brief me'] });
  }

  /** The briefing at its time, by the wall clock - skipped when the Mac slept through it by hours. */
  private armBriefing() {
    this.briefTimer?.cancel();
    this.briefTimer = undefined;
    const { briefing, briefingTime } = this.opts.config().initiative;
    if (briefing !== 'time') return;
    const [hour, minute] = briefingTime.split(':').map(Number);
    const due = nextTime({ every: 'day', hour: hour ?? 8, minute: minute ?? 30 }, new Date()).getTime();
    this.briefTimer = atTime(due, (late) => {
      if (late <= LATE_RUN_MS) this.maybeBrief('time');
      else console.log(`  [briefing] ${briefingTime} came ${Math.round(late / 60_000)} minutes ago, while the Mac slept - tomorrow instead`);
      this.armBriefing();
    });
  }
}
