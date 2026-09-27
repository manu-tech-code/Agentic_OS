import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { News, Reminder, TaskRecord } from '@nova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Briefing } from '../src/initiative/briefing.ts';
import { Deliverer, type Moment } from '../src/initiative/deliver.ts';
import { ReminderStore, type AppleReminders } from '../src/initiative/reminders.ts';
import { Routines } from '../src/initiative/routines.ts';
import { InitiativeState, projectIn } from '../src/initiative/state.ts';
import { TaskStore } from '../src/initiative/tasks.ts';
import { sayWeather, Weather } from '../src/initiative/weather.ts';
import { ShellRpc } from '../src/shell/rpc.ts';

const temp = () => mkdtemp(join(tmpdir(), 'nova-initiative-'));
// Sunday 27 September 2026, 1:43 PM.
const NOW = new Date(2026, 8, 27, 13, 43).getTime();

function fakeApple() {
  const items = new Map<string, { title: string; due: number | null; done?: boolean }>();
  let n = 0;
  const apple: AppleReminders = {
    add: async ({ title, due }) => {
      const id = `A${++n}`;
      items.set(id, { title, due });
      return id;
    },
    list: async () => [...items].filter(([, v]) => !v.done).map(([id, v]) => ({ id, title: v.title, due: v.due })),
    complete: async (id) => void (items.get(id)!.done = true),
    remove: async (id) => void items.delete(id),
  };
  return { apple, items };
}

describe('reminders', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  async function store(file: string, apple: AppleReminders | null = null, mode: 'always' | 'when-asked' | 'never' = 'when-asked') {
    const due: { r: Reminder; late: boolean }[] = [];
    const s = await new ReminderStore({ file, due: (r, late) => due.push({ r, late }), apple: () => apple, mode: () => mode, list: () => '' }).load();
    return { s, due };
  }

  it('brings one up on time, and keeps it in a file only the user can read', async () => {
    const file = join(await temp(), 'reminders.json');
    const { s, due } = await store(file);
    await s.add({ text: 'call mum', about: 'to', due: NOW + 60 * 60_000 });
    await s.flushed();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8')).reminders[0]).toMatchObject({ text: 'call mum', due: NOW + 3_600_000 });
    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(due).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(due.map((d) => [d.r.text, d.late])).toEqual([['call mum', false]]);
    expect(s.list()).toEqual([]); // once: gone
    expect(s.recent()?.text).toBe('call mum');
  });

  it('comes round again when it repeats', async () => {
    const { s, due } = await store(join(await temp(), 'r.json'));
    const at = new Date(2026, 8, 28, 8, 30).getTime(); // Monday
    await s.add({ text: 'stand up', about: 'to', due: at, schedule: { every: 'weekday', hour: 8, minute: 30 } });
    await vi.advanceTimersByTimeAsync(at - NOW + 1000);
    expect(due).toHaveLength(1);
    expect(new Date(s.list()[0]!.due!).toString()).toBe(new Date(2026, 8, 29, 8, 30).toString()); // Tuesday
  });

  it('snoozes the one just brought up, and marks it done', async () => {
    const { s, due } = await store(join(await temp(), 'r.json'));
    const r = await s.add({ text: 'take my pills', about: 'to', due: NOW + 1000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(due).toHaveLength(1);
    const again = await s.snooze(r.id, 10 * 60_000);
    expect(again?.due).toBe(NOW + 2000 + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(due.map((d) => d.r.text)).toEqual(['take my pills', 'take my pills']);
    expect(await s.done(s.recent()!.id)).toBe(true);
    expect(s.recent()).toBeNull();
  });

  it('brings up what came due while Nova was off, marked late - and drops what is long gone', async () => {
    const file = join(await temp(), 'r.json');
    await writeFile(
      file,
      JSON.stringify({
        reminders: [
          { id: 'a', text: 'an hour ago', due: NOW - 3_600_000, created: 0 },
          { id: 'b', text: 'two days ago', due: NOW - 2 * 86_400_000, created: 0 },
          { id: 'c', text: 'later', due: NOW + 3_600_000, created: 0 },
        ],
      }),
    );
    const { s, due } = await store(file);
    expect(due.map((d) => [d.r.text, d.late])).toEqual([['an hour ago', true]]);
    expect(s.list().map((r) => r.text)).toEqual(['later']);
  });

  it('puts one in the Reminders app when asked, and reads what the app has', async () => {
    const { apple, items } = fakeApple();
    const { s, due } = await store(join(await temp(), 'r.json'), apple);
    expect(s.apple).toBe('when-asked');
    await s.add({ text: 'book the flight', about: 'to', due: NOW + 3_600_000, apple: true });
    await s.add({ text: 'buy milk', about: 'to', due: null, apple: true }); // no time: it lives in the app
    expect([...items.values()].map((i) => i.title)).toEqual(['book the flight', 'buy milk']);
    items.set('X', { title: 'renew passport', due: NOW + 30 * 60_000 }); // added on the iPhone
    await s.syncApple();
    expect(s.list().map((r) => r.text)).toEqual(['renew passport', 'book the flight', 'buy milk']);
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(due.map((d) => d.r.text)).toEqual(['renew passport']); // Nova says the app's own too
    await s.syncApple();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(due).toHaveLength(1); // and only once
    await s.done(s.recent()!.id);
    expect(items.get('X')!.done).toBe(true);
    const flight = s.list().find((r) => r.text === 'book the flight')!;
    await s.cancel(flight.id);
    expect(items.has('A1')).toBe(false);
  });

  it("keeps it with Nova when the Reminders app can't be reached", async () => {
    const { s } = await store(join(await temp(), 'r.json'), null);
    expect(s.apple).toBe('unavailable');
    const r = await s.add({ text: 'call kofi', about: 'to', due: NOW + 60_000, apple: true });
    expect(r.apple).toBe(false);
    await expect(s.add({ text: 'buy milk', due: null, apple: true })).rejects.toThrow(/no time/);
  });
});

describe('speaking up', () => {
  const news = (text: string): News => ({ kind: 'reminder', title: text, text });

  function setup(policy: 'free' | 'show' | 'always' = 'free') {
    let moment: Moment = { away: false, call: false, busy: false };
    let now = NOW;
    const said: string[] = [];
    const shown: string[] = [];
    const d = new Deliverer({ policy: () => policy, moment: () => moment, speak: (t) => said.push(t), notify: (n) => shown.push(n.title), now: () => now });
    return { d, said, shown, set: (m: Partial<Moment>) => (moment = { ...moment, ...m }), later: (ms: number) => (now += ms) };
  }

  it('says it when the user is free, and always shows it', () => {
    const { d, said, shown } = setup();
    d.deliver(news("It's time to call your mum."));
    expect(said).toEqual(["It's time to call your mum."]);
    expect(shown).toEqual(["It's time to call your mum."]);
  });

  it('waits while Nova is talking with the user', () => {
    const { d, said, set } = setup();
    set({ busy: true });
    d.deliver(news('Claude finished.'));
    expect(said).toEqual([]);
    set({ busy: false });
    d.idle();
    expect(said).toEqual(['Claude finished.']);
  });

  it('holds it during a call or while away, and tells them when they are back', () => {
    const { d, said, set, later } = setup();
    set({ call: true });
    d.deliver(news("It's time to call your mum."));
    set({ call: false, away: true });
    d.deliver(news('Claude finished in Agentic_OS.'));
    expect(said).toEqual([]);
    expect(d.missed().map((m) => m.text)).toEqual(["It's time to call your mum.", 'Claude finished in Agentic_OS.']);
    later(20 * 60_000);
    d.back(); // still away: nothing
    set({ away: false });
    d.back();
    expect(said).toEqual(["While you were away, 2 things came up. At 1:43 PM: it's time to call your mum. At 1:43 PM: Claude finished in Agentic_OS."]);
    expect(d.missed()).toEqual([]);
  });

  it('never speaks unasked when set to show, and always does when set to always', () => {
    const shy = setup('show');
    shy.d.deliver(news('A reminder about the dentist.'));
    shy.d.back();
    expect(shy.said).toEqual([]);
    expect(shy.d.missed()).toHaveLength(1);
    const loud = setup('always');
    loud.set({ call: true });
    loud.d.deliver(news('Your timer is done.'));
    expect(loud.said).toEqual(['Your timer is done.']);
  });
});

describe('the weather', () => {
  const answers = (calls: string[]) => async (url: string) => {
    calls.push(url);
    if (url.includes('geocoding')) return { results: [{ latitude: 5.56, longitude: -0.2, name: 'Accra' }] };
    return { current: { temperature_2m: 28.6, weather_code: 2 }, daily: { temperature_2m_max: [31.2], temperature_2m_min: [24.4], precipitation_probability_max: [72] } };
  };

  it('finds the town once, and sends only it', async () => {
    const calls: string[] = [];
    const weather = new Weather(answers(calls), () => NOW);
    const today = await weather.today('Accra', 'celsius');
    expect(today).toEqual({ place: 'Accra', now: 29, high: 31, low: 24, rain: 72, sky: 'partly cloudy', unit: 'C' });
    expect(sayWeather(today)).toBe("In Accra it's 29 degrees and partly cloudy - up to 31 today, with rain likely.");
    await weather.today('accra', 'celsius');
    expect(calls).toHaveLength(2); // the forecast was fresh enough
    expect(calls[0]).toContain('name=Accra');
    expect(calls[1]).toContain('latitude=5.56');
  });

  it("says so when there's no such place", async () => {
    const weather = new Weather(async () => ({ results: [] }));
    await expect(weather.today('Nowhereville', 'celsius')).rejects.toThrow(/doesn't know a place/);
  });
});

describe('the briefing', () => {
  const task = (over: Partial<TaskRecord>): TaskRecord => ({ id: 't', agent: 'claude', label: 'Claude', project: 'Agentic_OS', task: 'fix the build', status: 'done', started: NOW - 7_200_000, ended: NOW - 3_600_000, ...over });

  it('tells the day, the weather, the calendar, reminders and what agents did', async () => {
    const briefing = new Briefing({
      now: () => new Date(2026, 8, 27, 8, 5),
      name: () => 'Bond',
      calendar: async () => [
        { title: 'Standup', start: new Date(2026, 8, 27, 10, 0).getTime(), end: new Date(2026, 8, 27, 10, 15).getTime(), allDay: false, attendees: 6, call: true },
        { title: 'Lunch with Ama', start: new Date(2026, 8, 27, 13, 0).getTime(), end: new Date(2026, 8, 27, 14, 0).getTime(), allDay: false, attendees: 2 },
      ],
      weather: async () => ({ place: 'Accra', now: 27, high: 31, low: 24, rain: 20, sky: 'mostly clear', unit: 'C' }),
      reminders: () => [{ id: 'r', text: 'call my mum', about: 'to', due: new Date(2026, 8, 27, 17, 0).getTime() }],
      tasks: () => [task({})],
      missed: () => [],
      brain: () => ({ use: true, services: ['Linear', 'GitHub'] }),
    });
    const { spoken, facts, ask } = await briefing.compose();
    expect(spoken).toBe(
      "Good morning. It's Sunday, September 27. In Accra it's 27 degrees and mostly clear - up to 31 today. You have 2 things on your calendar: Standup at 10 AM and Lunch with Ama at 1 PM. Reminders: call your mum at 5 PM. Claude finished a task.",
    );
    expect(facts.join('\n')).toContain('Standup (6 people)');
    expect(ask).toContain('Linear, GitHub');
    expect(ask).toContain('- Reminders today: call my mum at 5 PM.');
  });

  it("says what it can when there's no calendar, weather or brain", async () => {
    const briefing = new Briefing({
      now: () => new Date(2026, 8, 27, 19, 0),
      name: () => 'Nova',
      calendar: async () => null,
      weather: async () => {
        throw new Error('offline');
      },
      reminders: () => [],
      tasks: () => [],
      missed: () => [],
      brain: () => ({ use: true, services: [] }),
    });
    const { spoken, ask } = await briefing.compose();
    expect(spoken).toBe("Good evening. It's Sunday, September 27.");
    expect(ask).toBeUndefined(); // no services for the brain to look in
  });
});

describe('the task board', () => {
  it('keeps every task, and marks the ones Nova stopped with as stopped', async () => {
    const file = join(await temp(), 'tasks.json');
    const seen: number[] = [];
    const board = await new TaskStore(file, (tasks) => seen.push(tasks.length)).load();
    board.update({ id: 'a', agent: 'claude', label: 'Claude', project: 'site', task: 'fix it', status: 'running', started: 1 });
    board.update({ id: 'b', agent: 'codex', label: 'Codex', project: 'api', task: 'test it', status: 'done', report: 'All green.', started: 2, ended: 3 });
    await board.flushed();
    expect(board.list().map((t) => t.id)).toEqual(['b', 'a']);
    const again = await new TaskStore(file).load();
    expect(again.get('a')).toMatchObject({ status: 'cancelled', report: 'Nova stopped before it finished.' });
    expect(again.get('b')).toMatchObject({ status: 'done', report: 'All green.' });
  });
});

describe('the current project', () => {
  it('is what the user said, or the project in the window they work in', async () => {
    expect(projectIn(['server.ts — Agentic_OS'], ['website', 'Agentic_OS'])).toBe('Agentic_OS');
    expect(projectIn(['nova-web – main.ts', 'https://github.com/me/nova-web'], ['nova', 'nova-web'])).toBe('nova-web');
    expect(projectIn(['Inbox — Mail'], ['website'])).toBeNull();
    const state = await new InitiativeState(join(await temp(), 'state.json')).load();
    state.seen('website');
    expect(state.currentProject).toEqual({ name: 'website', source: 'screen' });
    state.set('Agentic_OS');
    state.seen('website'); // what they said wins for a while
    expect(state.current).toBe('Agentic_OS');
  });
});

describe('routines on a schedule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('run on time - or when the user is back, if they were away', async () => {
    const ran: string[] = [];
    let away = false;
    const routines = new Routines({
      routines: () => ({ 'every weekday at 9': { schedule: 'every weekday at 9', steps: ['brief me'] }, off: { schedule: 'every day at 9', steps: ['x'], enabled: false } }),
      save: async () => {},
      run: (r) => ran.push(r.name),
      away: () => away,
    });
    routines.configure();
    await vi.advanceTimersByTimeAsync(new Date(2026, 8, 28, 9, 0).getTime() - NOW + 1000); // Monday 9:00
    expect(ran).toEqual(['every weekday at 9']);
    away = true;
    await vi.advanceTimersByTimeAsync(86_400_000); // Tuesday 9:00, away
    expect(ran).toHaveLength(1);
    away = false;
    routines.back();
    expect(ran).toHaveLength(2);
    routines.close();
  });
});

describe('asking Nova.app', () => {
  it('matches answers to requests, and fails at once without the app', async () => {
    const sent: { id: string }[] = [];
    let app = true;
    const rpc = new ShellRpc((e) => (app ? (sent.push(e as { id: string }), true) : false));
    const asked = rpc.request<string>('reminders.add', { title: 'x' });
    rpc.reply(sent[0]!.id, true, 'A1');
    expect(await asked).toBe('A1');
    const refused = rpc.request('calendar.events');
    rpc.reply(sent[1]!.id, false, undefined, 'No access to the calendar.');
    await expect(refused).rejects.toThrow('No access to the calendar.');
    app = false;
    await expect(rpc.request('notify')).rejects.toThrow(/isn't running/);
  });
});
