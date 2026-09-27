import { describe, expect, it, vi } from 'vitest';
import {
  EvaluationDecisionEngine,
  HeuristicEvaluationModel,
  NovaBrain,
  outputText,
  type AgentHost,
  type DecisionEngine,
  type MemoryService,
  type NovaOptions,
  type Platform,
  type ReasoningBrain,
  type Reminder,
  type ReminderService,
  type Routine,
  type ServerEvent,
  type TrustService,
} from '../src/index.ts';

/** What Nova asks, and what an answer means: approvals, its own questions, routines, tool calls. */

const tick = () => new Promise((r) => setTimeout(r, 0));

/** The heuristic engine, with a hand on it: hold its answer back, say speech wasn't meant for Nova, and see what it was told. */
function testEngine() {
  const inner = new EvaluationDecisionEngine({ name: 'heuristic', model: new HeuristicEvaluationModel() });
  let gate: Promise<void> | null = null;
  let addressed: number | null = null;
  const states: Record<string, unknown>[] = [];
  const engine: DecisionEngine = {
    name: 'test',
    async decide(state, questions) {
      states.push(state as Record<string, unknown>);
      const decision = await inner.decide(state, questions);
      if (addressed !== null) (decision.answers as Record<string, unknown>).addressed = { type: 'boolean', probability: addressed };
      if (gate) await gate;
      return decision;
    },
  };
  return {
    engine,
    states,
    /** Hold the next answers until released. */
    hold() {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return () => ((gate = null), release());
    },
    addressed: (p: number | null) => void (addressed = p),
  };
}

function fakeTrust(fails = false) {
  const rules = new Map<string, { label: string; until?: string }>();
  const trust: TrustService = {
    allows: (key) => rules.has(key),
    allow: async (key, label, until) => {
      if (fails) throw new Error('The settings file is read-only.');
      rules.set(key, { label, until });
    },
    list: () => [...rules].map(([key, r]) => ({ key, ...r })),
  };
  return { trust, rules };
}

async function setup(extra: Partial<NovaOptions> = {}) {
  const events: ServerEvent[] = [];
  const opened: string[] = [];
  const quit: string[] = [];
  const test = testEngine();
  const { trust, rules } = fakeTrust();
  const platform: Platform = {
    listApps: async () => ['Safari', 'Slack', 'Spotify'],
    openApp: async (a) => void opened.push(a),
    quitApp: async (a) => void quit.push(a),
    now: () => new Date(),
  };
  const nova = new NovaBrain({ engine: test.engine, platform, emit: (e) => events.push(e), trust, ...extra });
  await nova.init();
  const said = () => events.filter((e): e is Extract<ServerEvent, { type: 'say' }> => e.type === 'say').map((e) => e.text);
  const phases = () => events.filter((e): e is Extract<ServerEvent, { type: 'phase' }> => e.type === 'phase').map((e) => e.phase);
  const lastCard = (kind: string) => events.filter((e): e is Extract<ServerEvent, { type: 'card' }> => e.type === 'card' && e.card.kind === kind).at(-1)?.card.id;
  return { nova, events, opened, quit, said, phases, lastCard, rules, ...test };
}

/** Agents whose task each asks one thing and waits; `end(name)` finishes one's task. */
function askingAgents(asks: Record<string, string>) {
  const answers: Record<string, boolean | undefined> = {};
  const ends: Record<string, () => void> = {};
  const host: AgentHost = {
    agents: Object.keys(asks).map((name) => ({ name, label: `${name[0]!.toUpperCase()}${name.slice(1)}` })),
    projects: ['site'],
    ask: async () => '',
    run: (agent, _task, _project, callbacks, signal) =>
      new Promise((resolve, reject) => {
        ends[agent] = () => resolve('Done.');
        signal.addEventListener('abort', () => reject(new Error('Stopped.')));
        void callbacks.approve({ action: `run "${asks[agent]}"`, tool: 'Bash', detail: asks[agent] }).then((ok) => void (answers[agent] = ok));
      }),
  };
  return { host, answers, end: (name: string) => ends[name]?.() };
}

const start = (nova: NovaBrain, agent: string) => nova.retryTask({ agent, task: 'work on it', project: 'site' });

function fakeReminders(items: Reminder[] = []): ReminderService {
  return {
    apple: 'when-asked',
    add: async (r) => {
      const item = { ...r, id: `r${items.length + 1}` };
      items.push(item);
      return item;
    },
    list: () => [...items],
    cancel: async (id) => {
      const i = items.findIndex((r) => r.id === id);
      if (i >= 0) items.splice(i, 1);
      return i >= 0;
    },
    recent: () => null,
    snooze: async () => null,
    done: async () => true,
  };
}

describe('a yes or no', () => {
  it('answers only the question it was said to: one that took its place meanwhile is asked again', async () => {
    const agents = askingAgents({ claude: 'npm test', codex: 'npm run deploy' });
    const t = await setup({ agents: agents.host });
    start(t.nova, 'claude');
    await vi.waitFor(() => expect(t.said().at(-1)).toBe('Claude wants to run "npm test" in site. Allow it?'));
    start(t.nova, 'codex');
    await tick();
    await tick();
    const release = t.hold();
    const answering = t.nova.handle('yes, always');
    await tick();
    // Claude's task ends while the yes is being decided: its question is withdrawn, and Codex's comes up.
    agents.end('claude');
    await vi.waitFor(() => expect(t.said().at(-1)).toBe('Codex wants to run "npm run deploy" in site. Allow it?'));
    release();
    await answering;
    expect(agents.answers.codex).toBeUndefined(); // a yes meant for Claude
    expect(t.rules.size).toBe(0);
    expect(t.said().at(-1)).toMatch(/^Sorry, that question went away just as you answered\. Codex wants to run "npm run deploy" in site\. Allow it\?$/);
    await t.nova.handle('yes');
    await vi.waitFor(() => expect(agents.answers.codex).toBe(true));
  });

  it("says \"always\" to exactly one thing - never to a whole tool it can't pin down", async () => {
    const answers: boolean[] = [];
    const host: AgentHost = {
      agents: [{ name: 'claude', label: 'Claude' }],
      projects: ['site'],
      ask: async () => '',
      run: async (_agent, _task, _project, callbacks) => {
        for (let i = 0; i < 2; i++) answers.push(await callbacks.approve({ action: 'use Linear to create an issue', tool: 'mcp__linear__create_issue', detail: '' }));
        return 'Done.';
      },
    };
    const t = await setup({ agents: host });
    start(t.nova, 'claude');
    await vi.waitFor(() => expect(t.said().at(-1)).toMatch(/Allow it\?$/));
    await t.nova.handle('yes, always');
    expect(t.said().some((s) => s === "Okay, go ahead. I'll still ask each time for that one.")).toBe(true);
    await vi.waitFor(() => expect(t.said().at(-1)).toMatch(/Allow it\?$/)); // asked again
    expect(t.rules.size).toBe(0);
    await t.nova.handle('no');
    await vi.waitFor(() => expect(answers).toEqual([true, false]));
  });

  it('carries on when a "yes, always" cannot be saved, and says so', async () => {
    const { trust } = fakeTrust(true);
    const t = await setup({ trust });
    await t.nova.handle('nova quit spotify');
    await t.nova.handle('yes, always');
    await tick();
    expect(t.quit).toEqual(['Spotify']);
    expect(t.events).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringMatching(/read-only/) }));
  });
});

describe('questions that wait', () => {
  it("refuses an agent that isn't answered in time - counting from when it asked, even behind another question", async () => {
    vi.useFakeTimers();
    try {
      const agents = askingAgents({ claude: 'npm test' });
      const t = await setup({ agents: agents.host });
      await t.nova.handle('nova quit spotify'); // Nova's own question, never answered
      start(t.nova, 'claude');
      await vi.advanceTimersByTimeAsync(10);
      expect(t.said().at(-1)).toMatch(/^Quit Spotify\?/); // Claude waits behind it
      await vi.advanceTimersByTimeAsync(60_000); // "Quit Spotify?" goes unanswered: Claude is asked
      expect(t.said().at(-1)).toBe('Claude wants to run "npm test" in site. Allow it?');
      await vi.advanceTimersByTimeAsync(61_000); // two minutes after it asked: told no
      expect(agents.answers.claude).toBe(false);
      expect(t.events).toContainEqual(expect.objectContaining({ type: 'activity', item: expect.objectContaining({ label: 'No answer - refused Claude to run "npm test"' }) }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a question of its own nobody answers, card and all - a stray yes later does nothing', async () => {
    vi.useFakeTimers();
    try {
      const t = await setup({ requireWakeWord: false }); // conversation mode: every yes is heard
      await t.nova.handle('quit spotify');
      const card = t.lastCard('confirm');
      await vi.advanceTimersByTimeAsync(61_000);
      expect(t.events).toContainEqual({ type: 'dismiss', id: card });
      await t.nova.handle('yes');
      expect(t.quit).toEqual([]);
      await t.nova.handle('open');
      expect(t.said().at(-1)).toBe('Which app?');
      await vi.advanceTimersByTimeAsync(61_000);
      await t.nova.handle('spotify');
      expect(t.states.at(-1)).toMatchObject({ awaitingAppFor: null }); // no longer an answer to "Which app?"
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks the next agent waiting when the user cancels the question in front", async () => {
    const agents = askingAgents({ claude: 'npm test', codex: 'npm run lint' });
    const t = await setup({ agents: agents.host });
    start(t.nova, 'claude');
    await vi.waitFor(() => expect(t.said().at(-1)).toBe('Claude wants to run "npm test" in site. Allow it?'));
    start(t.nova, 'codex');
    await tick();
    await tick();
    t.nova.cancel();
    await vi.waitFor(() => expect(agents.answers.claude).toBe(false));
    expect(t.said().at(-1)).toBe('Codex wants to run "npm run lint" in site. Allow it?');
  });

  it("withdraws a brain's question when its answer runs out of time, so a late yes runs nothing", async () => {
    let nova!: NovaBrain;
    const brain: ReasoningBrain = {
      name: 'Brain',
      reply: async () => '',
      async *stream(_u, _h, signal) {
        yield 'Let me close Spotify. ';
        const stopped = new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('It took too long.'))));
        yield outputText(await Promise.race([nova.call('quit_app', { app: 'Spotify' }, 'Brain'), stopped]));
      },
    };
    const t = await setup({ reasoning: brain, replyTimeoutMs: 100 });
    nova = t.nova;
    await t.nova.handle('nova why is the sky blue');
    expect(t.said().at(-1)).toMatch(/didn't respond/);
    expect(t.events).toContainEqual({ type: 'dismiss', id: t.lastCard('confirm') });
    await t.nova.handle('yes');
    expect(t.quit).toEqual([]);
  });

  it("lets the user answer a brain's question by talking over it", async () => {
    let nova!: NovaBrain;
    const brain: ReasoningBrain = {
      name: 'Brain',
      reply: async () => '',
      async *stream() {
        const result = outputText(await nova.call('quit_app', { app: 'Spotify' }, 'Brain'));
        yield result.includes('said no') ? 'Okay, I left it.' : 'Done, it is closed.';
      },
    };
    const t = await setup({ reasoning: brain });
    nova = t.nova;
    const answering = t.nova.handle('nova why is the sky blue');
    await vi.waitFor(() => expect(t.said().at(-1)).toMatch(/Quit Spotify\?/));
    t.nova.interrupt(); // the user talks over the question...
    await t.nova.handle('yes'); // ...to answer it
    await answering;
    expect(t.quit).toEqual(['Spotify']);
    expect(t.said().at(-1)).toBe('Done, it is closed.');
  });
});

describe('routines', () => {
  const routines = (...list: Routine[]) => ({ list: () => list, save: async () => {} });

  it("end when the user cancels a step's question, card and all", async () => {
    const t = await setup({ routines: routines({ name: 'wind down', phrase: 'wind down', steps: ['quit slack', 'quit spotify'] }) });
    await t.nova.handle('nova wind down');
    expect(t.said().at(-1)).toMatch(/^Quit Slack\?/);
    const card = t.lastCard('confirm');
    t.nova.cancel();
    expect(t.events).toContainEqual({ type: 'dismiss', id: card });
    await t.nova.handle('nova what time is it');
    expect(t.said().at(-1)).toMatch(/^It's /);
    expect(t.said().some((s) => /Quit Spotify/.test(s))).toBe(false);
  });
});

describe('tool calls', () => {
  it("refuse one that leaves out what to do, rather than doing the skill's example", async () => {
    const remembered: string[] = [];
    const memory: MemoryService = { remember: (fact) => (remembered.push(fact), { id: 'm1', text: fact }), recall: () => [], forget: () => true, searchConversations: async () => [] };
    const t = await setup({ memory });
    expect(t.nova.specs().find((s) => s.name === 'set_timer')!.parameters.required).toContain('request');
    expect(await t.nova.call('set_timer', { duration: '10 minutes' }, 'Claude')).toMatch(/needs "request".*Nothing was done/);
    expect(t.events.some((e) => e.type === 'card' && e.card.kind === 'timer')).toBe(false);
    expect(await t.nova.call('remember', { fact: 'I like tea' }, 'Claude')).toMatch(/needs "request"/);
    expect(remembered).toEqual([]);
    expect(await t.nova.call('set_timer', { request: '10 minutes' }, 'Claude')).toBe('Timer set for 10 minutes.');
    expect(await t.nova.call('tell_time', {}, 'Claude')).toMatch(/^It's /); // needs no request
  });
});

describe('the decision engine', () => {
  it('hears about timers the reminder service keeps', async () => {
    const t = await setup({ reminders: fakeReminders([{ id: 't1', text: '', due: Date.now() + 600_000, countdown: true, ms: 600_000 }]) });
    await t.nova.handle('nova cancel the timer');
    expect(t.states[0]).toMatchObject({ activeTimers: 1 });
  });
});
