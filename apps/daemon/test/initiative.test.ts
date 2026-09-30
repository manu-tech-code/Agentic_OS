import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { News, Reminder, TaskRecord } from '@nova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Briefing } from '../src/initiative/briefing.ts';
import { Deliverer, type Moment } from '../src/initiative/deliver.ts';
import { Initiative } from '../src/initiative/index.ts';
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

  /** A store, loaded - and, unless `alone`, with someone there to hear it. */
  async function store(file: string, apple: AppleReminders | null = null, mode: 'always' | 'when-asked' | 'never' = 'when-asked', alone = false) {
    const due: { r: Reminder; late: boolean }[] = [];
    const s = await new ReminderStore({ file, due: (r, late) => due.push({ r, late }), apple: () => apple, mode: () => mode, list: () => '' }).load();
    if (!alone) s.listening();
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

  it('brings up what came due while Nova was off once someone can hear it, marked late - and drops what is long gone', async () => {
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
    const { s, due } = await store(file, null, 'when-asked', true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(due).toEqual([]); // no window yet, no Nova.app: not said to an empty room
    await s.flushed();
    expect(JSON.parse(await readFile(file, 'utf8')).reminders.map((r: Reminder) => r.id)).toEqual(['a', 'c']); // and not lost
    s.listening();
    expect(due.map((d) => [d.r.text, d.late])).toEqual([['an hour ago', true]]);
    expect(s.list().map((r) => r.text)).toEqual(['later']);
  });

  it('comes on time by the clock, however long the Mac slept', async () => {
    const { due, s } = await store(join(await temp(), 'r.json'));
    await s.add({ text: 'leave for the airport', about: 'to', due: NOW + 8 * 3_600_000 });
    await vi.advanceTimersByTimeAsync(3_600_000); // an hour awake
    vi.setSystemTime(Date.now() + 7.5 * 3_600_000); // then asleep, 7½ hours: Node's timers stood still
    await vi.advanceTimersByTimeAsync(61_000); // a minute after it wakes
    expect(due.map((d) => [d.r.text, d.late])).toEqual([['leave for the airport', true]]);
  });

  it("never announces what the Reminders app has long overdue, nor one it brought up already - after a restart too", async () => {
    const { apple, items } = fakeApple();
    items.set('OLD', { title: 'renew the car tax', due: NOW - 90 * 86_400_000 }); // months overdue in the app
    items.set('X', { title: 'water the plants', due: NOW + 30 * 60_000 });
    const file = join(await temp(), 'r.json');
    const first = await store(file, apple);
    await first.s.syncApple();
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(first.due.map((d) => d.r.text)).toEqual(['water the plants']);
    await first.s.flushed();
    first.s.close();
    const again = await store(file, apple); // Nova starts again; the app still has both, not done
    await again.s.syncApple();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(again.due).toEqual([]);
    items.set('X', { title: 'water the plants', due: NOW + 2 * 3_600_000 }); // moved to later in the app: that time counts
    await again.s.syncApple();
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    expect(again.due.map((d) => d.r.text)).toEqual(['water the plants']);
  });

  it('keeps its own id for one it put in the Reminders app, so taking it back works after a sync or a restart', async () => {
    const { apple, items } = fakeApple();
    const file = join(await temp(), 'r.json');
    const { s } = await store(file, apple);
    const milk = await s.add({ text: 'buy milk', about: 'to', due: null, apple: true });
    await s.syncApple();
    expect(s.list().find((r) => r.text === 'buy milk')?.id).toBe(milk.id);
    await s.flushed();
    s.close();
    const again = await store(file, apple);
    expect(await again.s.cancel(milk.id)).toBe(true); // no sync yet since the restart: found by the app's id
    expect(items.has('A1')).toBe(false);
  });

  it("keeps a reminders file it can't read beside, rather than writing over it", async () => {
    const dir = await temp();
    const file = join(dir, 'reminders.json');
    await writeFile(file, '{ "reminders": [ { "id": "a", "text": "call mum", "due": 17'); // cut short
    const { s } = await store(file);
    await s.add({ text: 'water the plants', about: 'to', due: NOW + 3_600_000 });
    await s.flushed();
    const kept = (await readdir(dir)).find((n) => /^reminders\.unreadable-\d{8}-\d{6}\.json$/.test(n));
    expect(await readFile(join(dir, kept!), 'utf8')).toContain('call mum');
    expect(JSON.parse(await readFile(file, 'utf8')).reminders.map((r: Reminder) => r.text)).toEqual(['water the plants']);

    // Some of it unreadable (edited by hand): what can be read is kept, and the file as it was beside it.
    const other = join(await temp(), 'reminders.json');
    await writeFile(other, JSON.stringify({ reminders: [{ id: 'a', text: 'call mum', due: NOW + 60_000, created: 0 }, { id: 'b', text: 'pay rent', due: 'tomorrow' }] }));
    const partly = await store(other);
    expect(partly.s.list().map((r) => r.text)).toEqual(['call mum']);
    const beside = (await readdir(join(other, '..'))).find((n) => n.startsWith('reminders.unreadable-'));
    expect(await readFile(join(other, '..', beside!), 'utf8')).toContain('pay rent');
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

  describe('on the iPhone', () => {
    /** A phone with Nova in front (or not), taking news when away from the Mac - or always. */
    function withPhone(when: 'away' | 'always' = 'away', policy: 'free' | 'show' | 'always' = 'free') {
      let moment: Moment = { away: false, call: false, busy: false };
      let inUse = true;
      const mac: string[] = [];
      const phone: string[] = [];
      const d = new Deliverer({
        policy: () => policy,
        moment: () => moment,
        speak: (t) => mac.push(t),
        phone: { wants: (away) => inUse && (when === 'always' || away), speak: (t) => phone.push(t) },
        now: () => NOW,
      });
      return { d, mac, phone, set: (m: Partial<Moment>) => (moment = { ...moment, ...m }), use: (on: boolean) => (inUse = on) };
    }

    it('says it on the phone at once while the user is away from the Mac, and at the Mac while they are there', () => {
      const { d, mac, phone, set } = withPhone();
      d.deliver(news('Claude finished in Agentic_OS.'));
      set({ away: true });
      d.deliver(news("It's time to call your mum."));
      expect(mac).toEqual(['Claude finished in Agentic_OS.']);
      expect(phone).toEqual(["It's time to call your mum."]);
      expect(d.missed()).toEqual([]);
    });

    it('says what was held when Nova comes to the front on the phone - and not again at the Mac', () => {
      const { d, mac, phone, set, use } = withPhone();
      use(false);
      set({ away: true });
      d.deliver(news("It's time to call your mum."));
      expect(phone).toEqual([]);
      use(true);
      d.phoneBack();
      expect(phone).toEqual(["While you were away - it's time to call your mum."]);
      set({ away: false });
      d.back();
      expect(mac).toEqual([]);
    });

    it('holds it during a call, never speaks unasked when set to show, and takes it always when told to', () => {
      const call = withPhone();
      call.set({ away: true, call: true });
      call.d.deliver(news('Your timer is done.'));
      expect(call.phone).toEqual([]);
      expect(call.d.missed()).toHaveLength(1);
      const shy = withPhone('away', 'show');
      shy.set({ away: true });
      shy.d.deliver(news('Your timer is done.'));
      shy.d.phoneBack();
      expect(shy.phone).toEqual([]);
      const always = withPhone('always');
      always.d.deliver(news('Your timer is done.'));
      expect(always.phone).toEqual(['Your timer is done.']);
      expect(always.mac).toEqual([]);
    });

    it('waits for Nova to finish, then says it on the phone', () => {
      const { d, phone, set } = withPhone();
      set({ away: true, busy: true });
      d.deliver(news('Codex finished.'));
      expect(phone).toEqual([]);
      set({ busy: false });
      d.idle();
      expect(phone).toEqual(['Codex finished.']);
    });
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

  it('skip a run the Mac slept through by hours, and make one it only just missed', async () => {
    const ran: string[] = [];
    const routines = new Routines({ routines: () => ({ 'start work': { schedule: 'every day at 9', steps: ['open slack'] } }), save: async () => {}, run: (r) => ran.push(r.name), away: () => false });
    routines.configure();
    vi.setSystemTime(new Date(2026, 8, 28, 11, 30)); // asleep through Monday 9:00, awake at 11:30
    await vi.advanceTimersByTimeAsync(61_000);
    expect(ran).toEqual([]);
    vi.setSystemTime(new Date(2026, 8, 29, 9, 10)); // asleep again, awake at 9:10 on Tuesday
    await vi.advanceTimersByTimeAsync(61_000);
    expect(ran).toEqual(['start work']);
    routines.close();
  });

  it('the briefing at its time too', async () => {
    const briefed: string[] = [];
    const config = {
      name: 'Nova',
      routines: {},
      initiative: { briefing: 'time', briefingTime: '08:30', awayMinutes: 10, speak: 'free', appleReminders: 'never', remindersList: '', calendar: false, briefingBrain: false, town: '', units: 'celsius' },
    };
    const initiative = new Initiative({
      home: await temp(),
      config: () => config as never,
      presence: { connected: false, status: null, send: () => false } as never,
      broadcast: () => {},
      services: () => [],
      hasBrain: () => false,
      saveRoutine: async () => {},
      changed: () => {},
    });
    initiative.nova = { tell: () => {}, runRoutine: async (r) => void briefed.push(r.name), cancelTask: () => false, retryTask: () => null };
    initiative.configure();
    vi.setSystemTime(new Date(2026, 8, 28, 8, 40)); // the Mac woke ten minutes after 8:30
    await vi.advanceTimersByTimeAsync(61_000);
    expect(briefed).toEqual(['Morning briefing']);
    vi.setSystemTime(new Date(2026, 8, 29, 13, 0)); // the next day it slept till one
    await vi.advanceTimersByTimeAsync(61_000);
    expect(briefed).toHaveLength(1);
    initiative.close();
  });
});

describe('what came due before anyone could hear', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('comes up once the first window or Nova.app connects', async () => {
    const home = await temp();
    await writeFile(join(home, 'reminders.json'), JSON.stringify({ reminders: [{ id: 'a', text: 'call mum', about: 'to', due: NOW - 20 * 60_000, created: 0 }] }));
    const cards: string[] = [];
    const config = { name: 'Nova', routines: {}, initiative: { briefing: 'off', briefingTime: '08:30', awayMinutes: 10, speak: 'free', appleReminders: 'never', remindersList: '', calendar: false, briefingBrain: false, town: '', units: 'celsius' } };
    const initiative = await new Initiative({
      home,
      config: () => config as never,
      presence: { connected: false, status: null, send: () => false } as never,
      broadcast: (e) => void (e.type === 'card' && cards.push(e.card.title)),
      services: () => [],
      hasBrain: () => false,
      saveRoutine: async () => {},
      changed: () => {},
    }).load();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(cards).toEqual([]);
    initiative.onListener();
    initiative.onListener(); // every connection says so: once is what counts
    await vi.advanceTimersByTimeAsync(3000);
    expect(cards).toEqual(['call mum']);
    initiative.close();
  });
});

describe('reminders for the iPhone', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("are the next week's, worded as Nova says them, timers told apart", async () => {
    const home = await temp();
    const day = 86_400_000;
    await writeFile(
      join(home, 'reminders.json'),
      JSON.stringify({
        reminders: [
          { id: 'mum', text: 'call mum', about: 'to', due: NOW + 3_600_000, created: 0 },
          { id: 'tea', text: 'the tea', ms: 300_000, countdown: true, due: NOW + 300_000, created: 0 },
          { id: 'far', text: 'renew the passport', about: 'to', due: NOW + 30 * day, created: 0 },
          { id: 'someday', text: 'milk', due: null, created: 0 },
        ],
      }),
    );
    const config = { name: 'Nova', routines: {}, initiative: { briefing: 'off', briefingTime: '08:30', awayMinutes: 10, speak: 'free', appleReminders: 'never', remindersList: '', calendar: false, briefingBrain: false, town: '', units: 'celsius' } };
    const initiative = await new Initiative({
      home,
      config: () => config as never,
      presence: { connected: false, status: null, send: () => false } as never,
      broadcast: () => {},
      services: () => [],
      hasBrain: () => false,
      saveRoutine: async () => {},
      changed: () => {},
    }).load();
    expect(initiative.phoneReminders(NOW)).toEqual([
      { id: 'tea', title: 'Timer · the tea', body: expect.stringMatching(/tea/i), what: 'the tea', due: NOW + 300_000, timer: true },
      { id: 'mum', title: 'Reminder', body: "It's time to call mum.", what: 'call mum', due: NOW + 3_600_000, timer: false },
    ]);
    initiative.close();
  });
});

describe("Nova's own files", () => {
  it("are kept beside when they can't be read, never written over", async () => {
    const dir = await temp();
    await writeFile(join(dir, 'tasks.json'), '{"tasks": [');
    await writeFile(join(dir, 'state.json'), 'not json at all');
    const board = await new TaskStore(join(dir, 'tasks.json')).load();
    board.update({ id: 'a', agent: 'claude', label: 'Claude', project: 'site', task: 'fix it', status: 'done', started: 1 });
    await board.flushed();
    const state = await new InitiativeState(join(dir, 'state.json')).load();
    state.set('site');
    await state.flushed();
    const names = await readdir(dir);
    expect(names.filter((n) => n.includes('.unreadable-')).map((n) => n.split('.')[0]).sort()).toEqual(['state', 'tasks']);
    expect(JSON.parse(await readFile(join(dir, 'tasks.json'), 'utf8')).tasks).toHaveLength(1);
    expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).project.name).toBe('site');
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
