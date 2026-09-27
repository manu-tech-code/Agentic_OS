import { describe, expect, it } from 'vitest';
import {
  builtinSkills,
  countdownText,
  dueText,
  EvaluationDecisionEngine,
  HeuristicEvaluationModel,
  initiativeSkills,
  NovaBrain,
  reminderText,
  routineFrom,
  splitSteps,
  type AgentHost,
  type News,
  type Platform,
  type ReasoningBrain,
  type Reminder,
  type ReminderService,
  type Routine,
  type ServerEvent,
  type Skill,
  type SkillContext,
  type TaskRecord,
} from '../src/index.ts';

// Sunday 27 September 2026, 1:43 PM.
const NOW = new Date(2026, 8, 27, 13, 43);
const skill = (id: string) => [...initiativeSkills, ...builtinSkills].find((s) => s.id === id)!;
const tierOf = (s: Skill, ctx: SkillContext) => s.tierFor?.(ctx) ?? s.tier;

function fakeReminders(apple: ReminderService['apple'] = 'when-asked') {
  const items: Reminder[] = [];
  let recent: Reminder | null = null;
  let n = 0;
  const service: ReminderService & { items: Reminder[]; bringUp(r: Reminder): void; snoozed: [string, number][] } = {
    items,
    snoozed: [],
    apple,
    add: async (r) => {
      const item = { ...r, id: `r${++n}`, apple: Boolean(r.apple && apple !== 'unavailable') };
      items.push(item);
      return item;
    },
    list: () => [...items].sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity)),
    cancel: async (id) => {
      const i = items.findIndex((r) => r.id === id);
      if (i >= 0) items.splice(i, 1);
      return i >= 0;
    },
    recent: () => recent,
    snooze: async (id, ms) => (service.snoozed.push([id, ms]), recent),
    done: async () => ((recent = null), true),
    bringUp: (r) => (recent = r),
  };
  return service;
}

const platform: Platform = { listApps: async () => ['Slack', 'Spotify'], openApp: async () => {}, quitApp: async () => {}, now: () => NOW };
const ctx = (utterance: string, more: Partial<SkillContext> = {}): SkillContext => ({ utterance, heard: utterance, platform, ...more }) as SkillContext;

describe('what a reminder is about', () => {
  it('takes the words after "remind me", and how they were put', () => {
    expect(reminderText('remind me to call my mum')).toEqual({ text: 'call my mum', about: 'to' });
    expect(reminderText('please remind me about the dentist')).toEqual({ text: 'the dentist', about: 'about' });
    expect(reminderText('remind me that the car needs a service')).toEqual({ text: 'the car needs a service', about: 'that' });
    expect(reminderText('add buy milk to my reminders')).toEqual({ text: 'buy milk', about: 'to' });
    expect(reminderText("don't let me forget to water the plants")).toEqual({ text: 'water the plants', about: 'to' });
  });

  it('says it back when it is due', () => {
    expect(dueText({ id: 'x', text: 'call my mum', about: 'to', due: 1 })).toBe("It's time to call your mum.");
    expect(dueText({ id: 'x', text: 'the dentist', about: 'about', due: 1 })).toBe('A reminder about the dentist.');
    expect(dueText({ id: 'x', text: 'the car needs a service', about: 'that', due: 1 })).toBe('Remember that the car needs a service.');
    expect(dueText({ id: 'x', text: '', due: 1, countdown: true, ms: 300_000 })).toBe('Your 5 minutes timer is done.');
    expect(dueText({ id: 'x', text: 'the laundry', due: 1, countdown: true, ms: 3_600_000 })).toBe('Your one hour timer for the laundry is done.');
  });

  it('tells a timer with a label from a reminder in a while', () => {
    expect(countdownText('set a timer for the laundry, forty minutes')).toMatchObject({ text: 'the laundry', reminder: false });
    expect(countdownText('remind me in 10 minutes to check the oven')).toMatchObject({ text: 'check the oven', about: 'to', reminder: true });
    expect(countdownText('set a timer for 5 minutes')).toMatchObject({ text: '', reminder: false });
  });
});

describe('reminders', () => {
  it('sets one at a time, and says it back', async () => {
    const reminders = fakeReminders();
    const result = await skill('remind').run(ctx('remind me to call my mum at 5', { reminders }));
    expect(result.say).toBe("Okay, I'll remind you to call your mum at 5 PM.");
    expect(reminders.items[0]).toMatchObject({ text: 'call my mum', about: 'to', due: new Date(2026, 8, 27, 17, 0).getTime(), apple: false });
  });

  it('sets a repeating one', async () => {
    const reminders = fakeReminders();
    const result = await skill('remind').run(ctx('every weekday at 9 remind me to stand up', { reminders }));
    expect(result.say).toBe("Okay, every weekday at 9 AM I'll remind you to stand up.");
    expect(reminders.items[0]!.schedule).toMatchObject({ every: 'weekday', hour: 9 });
  });

  it('puts it in the Reminders app when asked - and says when it could not', async () => {
    const reminders = fakeReminders();
    expect((await skill('remind').run(ctx('remind me tomorrow at 9 in my reminders to book the flight', { reminders }))).say).toBe(
      "Okay, I'll remind you to book the flight tomorrow at 9 AM. It's in your Reminders too.",
    );
    expect((await skill('remind').run(ctx('add buy milk to my reminders', { reminders }))).say).toBe('Added buy milk to your Reminders.');
    const offline = fakeReminders('unavailable');
    expect((await skill('remind').run(ctx('remind me at 5 in my reminders to call kofi', { reminders: offline }))).say).toMatch(/only with me for now/);
  });

  it('asks when, if it wasn\'t said', async () => {
    const reminders = fakeReminders();
    const result = await skill('remind').run(ctx('remind me to call the landlord', { reminders }));
    expect(result).toMatchObject({ say: 'When should I remind you?', needs: 'when' });
    expect(reminders.items).toEqual([]);
  });

  it('lists what is coming up', async () => {
    const reminders = fakeReminders();
    await reminders.add({ text: 'call my mum', about: 'to', due: new Date(2026, 8, 27, 17, 0).getTime() });
    await reminders.add({ text: 'pay the rent', about: 'to', due: new Date(2026, 8, 28, 9, 0).getTime() });
    expect((await skill('reminders').run(ctx('what reminders do i have today', { reminders }))).say).toBe('You have one reminder today: call your mum at 5 PM.');
    expect((await skill('reminders').run(ctx('what are my reminders', { reminders }))).say).toBe('You have 2 reminders: call your mum at 5 PM and pay the rent tomorrow at 9 AM.');
  });

  it('cancels the one named, after asking - and all of them', async () => {
    const reminders = fakeReminders();
    await reminders.add({ text: 'call my mum', about: 'to', due: new Date(2026, 8, 27, 17, 0).getTime() });
    await reminders.add({ text: 'pay the rent', about: 'to', due: new Date(2026, 8, 28, 9, 0).getTime() });
    const c = ctx('cancel the reminder to pay the rent', { reminders });
    expect(tierOf(skill('cancel_reminder'), c)).toBe(2);
    expect(skill('cancel_reminder').confirmPrompt!(c)).toBe('Cancel the reminder to pay the rent tomorrow at 9 AM?');
    await skill('cancel_reminder').run(c);
    expect(reminders.items.map((r) => r.text)).toEqual(['call my mum']);
    expect(tierOf(skill('cancel_reminder'), ctx('cancel the reminder about the moon', { reminders }))).toBe(0); // nothing like it
    // "Cancel my reminders" heard as the timer skill, with no timer running: the reminders, confirmed first.
    const all = ctx('cancel all my reminders', { reminders, timers: { start: () => '', cancelAll: () => 0 } } as never);
    expect(tierOf(skill('cancel_timer'), all)).toBe(2);
    expect(skill('cancel_timer').confirmPrompt!(all)).toBe('Cancel all 1 of your reminders?');
  });

  it('snoozes and marks done the one just brought up', async () => {
    const reminders = fakeReminders();
    const r = await reminders.add({ text: 'take my pills', about: 'to', due: NOW.getTime() });
    reminders.bringUp(r);
    expect((await skill('snooze_reminder').run(ctx('snooze it for 20 minutes', { reminders }))).say).toBe("Okay, I'll remind you again in 20 minutes.");
    expect(reminders.snoozed).toEqual([[r.id, 20 * 60_000]]);
    // "Remind me again in 10 minutes", heard as a timer: still a snooze.
    await skill('set_timer').run(ctx('remind me again in 10 minutes', { reminders, timers: { start: () => '', cancelAll: () => 0 } } as never));
    expect(reminders.snoozed.at(-1)).toEqual([r.id, 10 * 60_000]);
    expect((await skill('reminder_done').run(ctx('mark it done', { reminders }))).say).toBe('Great, marked done.');
    expect((await skill('snooze_reminder').run(ctx('snooze', { reminders }))).say).toBe("There's nothing to snooze.");
  });

  it('keeps a timer through the reminder service, so it outlasts a restart', async () => {
    const reminders = fakeReminders();
    const result = await skill('set_timer').run(ctx('remind me in 10 minutes to check the oven', { reminders, timers: { start: () => '', cancelAll: () => 0 } } as never));
    expect(result.say).toBe("Okay, I'll remind you to check the oven in 10 minutes.");
    expect(reminders.items[0]).toMatchObject({ text: 'check the oven', about: 'to', countdown: true, ms: 600_000 });
  });
});

describe('routines by voice', () => {
  it('reads a phrase and its steps, or a schedule', () => {
    expect(routineFrom('when i say start work, open slack and brief me', NOW)).toEqual({ name: 'start work', phrase: 'start work', steps: ['open slack', 'brief me'] });
    expect(routineFrom('when I say "good night" mute yourself then quit spotify', NOW)).toEqual({ name: 'good night', phrase: 'good night', steps: ['mute yourself', 'quit spotify'] });
    expect(routineFrom('whenever i say focus time quit slack and open linear', NOW)).toMatchObject({ phrase: 'focus time', steps: ['quit slack', 'open linear'] });
    expect(routineFrom('every weekday at 9 open slack and brief me', NOW)).toMatchObject({ schedule: 'every weekday at 9 AM', steps: ['open slack', 'brief me'] });
    expect(routineFrom('every friday at 5 remind me to file my hours', NOW)).toBeNull(); // that's a reminder
    expect(splitSteps('open slack, then linear and brief me')).toEqual(['open slack', 'linear', 'brief me']);
  });
});

async function setup(opts: { reasoning?: ReasoningBrain; routines?: Routine[]; agents?: AgentHost; current?: string | null } = {}) {
  const events: ServerEvent[] = [];
  const news: News[] = [];
  const tasks: TaskRecord[] = [];
  const saved: Routine[] = [];
  const reminders = fakeReminders();
  const opened: string[] = [];
  const nova = new NovaBrain({
    engine: new EvaluationDecisionEngine({ name: 'heuristic', model: new HeuristicEvaluationModel() }),
    platform: { ...platform, openApp: async (a) => void opened.push(a), quitApp: async () => {} },
    emit: (e) => events.push(e),
    reasoning: opts.reasoning,
    agents: opts.agents,
    reminders,
    routines: { list: () => opts.routines ?? [], save: async (r) => void saved.push(r) },
    projects: { current: opts.current ?? null, set: () => {} },
    deliver: (n) => news.push(n),
    onTask: (t) => tasks.push({ ...t }),
  });
  await nova.init();
  const says = () => events.filter((e): e is Extract<ServerEvent, { type: 'say' }> => e.type === 'say').map((e) => e.text);
  return { nova, events, news, tasks, saved, reminders, opened, says };
}

describe('NovaBrain and initiative', () => {
  it('asks when, and the answer completes the reminder', async () => {
    const { nova, reminders, says } = await setup();
    await nova.handle('nova remind me to call the landlord');
    expect(says().at(-1)).toBe('When should I remind you?');
    await nova.handle('at 5');
    expect(says().at(-1)).toBe("Okay, I'll remind you to call the landlord at 5 PM.");
    expect(reminders.items).toHaveLength(1);
  });

  it('runs a routine by its phrase, and waits on a step that asks something', async () => {
    const routine: Routine = { name: 'wind down', phrase: 'wind down', steps: ['open slack', 'quit spotify', 'open spotify'] };
    const { nova, opened, says } = await setup({ routines: [routine] });
    await nova.handle('nova wind down');
    expect(opened).toEqual(['Slack']);
    expect(says().at(-1)).toMatch(/Quit Spotify\?/);
    await nova.handle('yes');
    expect(opened).toEqual(['Slack', 'Spotify']); // then the rest
  });

  it('makes a routine by voice', async () => {
    const { nova, saved, says } = await setup();
    await nova.handle('nova when i say start work open slack and brief me');
    expect(saved).toEqual([{ name: 'start work', phrase: 'start work', steps: ['open slack', 'brief me'] }]);
    expect(says().at(-1)).toBe('Okay: when you say "start work", I\'ll open slack and brief you.');
  });

  it('hands the briefing to the brain when there is one to add from the services', async () => {
    const asked: string[] = [];
    const brain: ReasoningBrain = { name: 'Brain', reply: async (q) => (asked.push(q), 'Morning! Two reviews are waiting on GitHub.') };
    const { nova, says } = await setup({ reasoning: brain });
    (nova as unknown as { opts: { briefing: unknown } }).opts.briefing = {
      compose: async () => ({ facts: ["It's Sunday."], spoken: "It's Sunday.", ask: 'Give me my morning briefing. Facts: Sunday. Check GitHub too.' }),
    };
    nova.reconfigure({});
    await nova.handle('nova brief me');
    expect(asked).toEqual(['Give me my morning briefing. Facts: Sunday. Check GitHub too.']);
    expect(says().at(-1)).toBe('Morning! Two reviews are waiting on GitHub.');
  });

  it('gives an agent task to the current project, and reports back through the deliverer', async () => {
    let resolveRun: (report: string) => void = () => {};
    const agents: AgentHost = {
      agents: [{ name: 'claude', label: 'Claude' }],
      projects: ['website', 'api'],
      ask: async () => '',
      run: () => new Promise<string>((r) => (resolveRun = r)),
    };
    const { nova, news, tasks, says } = await setup({ agents, current: 'website' });
    await nova.handle('nova ask claude to fix the failing test');
    expect(says().at(-1)).toBe('Ask Claude to work in website? It can edit files and run commands there.'); // no "Which project?"
    await nova.handle('yes');
    await new Promise((r) => setTimeout(r, 5));
    expect(tasks.at(-1)).toMatchObject({ status: 'running', project: 'website', label: 'Claude' });
    resolveRun('Fixed the date parsing test.\n\nAll 42 tests pass now.');
    await new Promise((r) => setTimeout(r, 5));
    expect(tasks.at(-1)).toMatchObject({ status: 'done', report: 'Fixed the date parsing test.\n\nAll 42 tests pass now.' });
    expect(news.at(-1)).toMatchObject({ kind: 'task', text: 'All 42 tests pass now.', title: 'Claude finished · website' });
  });
});
