import { describe, expect, it } from 'vitest';
import { NovaBrain, partsOf, type DecisionEngine, type HandsService, type QuestionHints, type ReasoningBrain, type ServerEvent } from '../src/index.ts';

/** What a brain that takes only the tools a question needs is told besides the question. */

const choice = (c: string, probabilities: Record<string, number>) => ({ type: 'choice', choice: c, probabilities });

/** System 1, by what's said: its pick, and each option's chance. Counts what it was asked. */
function engine(table: Record<string, [string, Record<string, number>]>) {
  const asked: string[] = [];
  const decisions: DecisionEngine = {
    name: 'test',
    decide: async (state) => {
      const u = String((state as { utterance?: string }).utterance ?? '').toLowerCase().replace(/[.?!]+$/, '');
      asked.push(u);
      const [intent, p] = table[u] ?? ['chat', { chat: 1 }];
      return { answers: { intent: choice(intent, p), app: choice('none', { none: 1 }), addressed: { type: 'boolean', probability: 1 } } as never, engine: 'test', latencyMs: 0, fellBack: false };
    },
  };
  return { decisions, asked };
}

/** A brain that keeps what it was told. */
function listening(extra: Partial<ReasoningBrain> = {}) {
  const heard: (QuestionHints | undefined)[] = [];
  const brain: ReasoningBrain = {
    name: 'Small',
    ...extra,
    reply: async () => 'Done.',
    async *stream(_q, _h, _s, hints) {
      heard.push(hints);
      yield 'Done.';
    },
  };
  return { brain, heard };
}

async function setup(table: Record<string, [string, Record<string, number>]>, brain: ReasoningBrain | null, hands?: HandsService) {
  const events: ServerEvent[] = [];
  const { decisions, asked } = engine(table);
  const platform = { listApps: async () => ['Safari', 'Notes'], openApp: async () => {}, quitApp: async () => {}, now: () => new Date('2026-09-30T15:00:00') };
  const nova = new NovaBrain({ engine: decisions, platform, emit: (e) => events.push(e), reasoning: brain, requireWakeWord: false, hands });
  await nova.init();
  const said = () => events.filter((e) => e.type === 'say' && !(e as { partial?: boolean }).partial).map((e) => (e as { text: string }).text);
  return { nova, events, asked, said };
}

describe('the parts of a request for several things', () => {
  it('are what comes between and, then, also and commas', () => {
    expect(partsOf('Turn on dark mode and then open Notes')).toEqual(['Turn on dark mode', 'open Notes']);
    expect(partsOf('Open Slack, then play jazz and set a timer')).toEqual(['Open Slack', 'play jazz', 'set a timer']);
    expect(partsOf('What is the capital of Ghana?')).toEqual(['What is the capital of Ghana?']);
  });
});

describe('hints for the brain', () => {
  const whole: Record<string, [string, Record<string, number>]> = {
    'open safari and then set a timer for 5 minutes': ['other', { other: 0.9, open_app: 0.09, files: 0.009, set_timer: 0.0001, chat: 0.0009 }],
    'open safari': ['open_app', { open_app: 0.99, set_timer: 0.01 }],
    'set a timer for 5 minutes': ['set_timer', { set_timer: 0.98, open_app: 0.02 }],
    'who wrote things fall apart': ['chat', { chat: 0.99, open_app: 0.01 }],
  };

  it("are the user's own words and what System 1 made of them - without its own intents", async () => {
    const { brain, heard } = listening();
    const t = await setup(whole, brain);
    await t.nova.handle('Who wrote Things Fall Apart?', 'keyboard');
    expect(heard[0]).toEqual({ heard: 'Who wrote Things Fall Apart?', intent: 'chat', skills: [{ id: 'open_app', p: 0.01 }] });
  });

  it('weigh each part of several things on its own, for a brain that takes a few tools at a time - their picks first', async () => {
    const small = listening({ fewTools: true });
    const t = await setup(whole, small.brain);
    await t.nova.handle('Open Safari and then set a timer for 5 minutes.', 'keyboard');
    expect(small.heard[0]?.skills.map((s) => s.id)).toEqual(['open_app', 'set_timer', 'files']);
    expect(t.asked).toEqual(['open safari and then set a timer for 5 minutes', 'open safari', 'set a timer for 5 minutes']);

    // A brain that takes all the tools gets the whole weighing, and System 1 isn't asked again.
    const big = listening();
    const u = await setup(whole, big.brain);
    await u.nova.handle('Open Safari and then set a timer for 5 minutes.', 'keyboard');
    expect(big.heard[0]?.skills.map((s) => s.id)).toEqual(['open_app', 'files', 'set_timer']);
    expect(u.asked).toHaveLength(1);
  });
});

describe("a skill's part done", () => {
  it("isn't handed to the brain as System 1's pick again - one that hands its request on, or says the words aren't for it", async () => {
    const { brain, heard } = listening({ fewTools: true });
    const briefing = { id: 'brief', examples: ['brief me'], tier: 0, run: async () => ({ say: 'Here is your day.', handoff: 'Put this into a briefing: sunny, two meetings.' }) };
    const shy = { id: 'shy', examples: ['shy'], tier: 0, declines: () => true, run: async () => ({ say: 'Never.' }) };
    const events: ServerEvent[] = [];
    const { decisions } = engine({ 'brief me': ['brief', { brief: 0.97, shy: 0.02 }], 'be shy': ['shy', { shy: 0.95, brief: 0.03 }] });
    const platform = { listApps: async () => [], openApp: async () => {}, quitApp: async () => {}, now: () => new Date('2026-09-30T08:00:00') };
    const nova = new NovaBrain({ engine: decisions, platform, emit: (e) => events.push(e), reasoning: brain, requireWakeWord: false, skills: [briefing as never, shy as never] });
    await nova.init();
    await nova.handle('Brief me', 'keyboard');
    await nova.handle('Be shy', 'keyboard');
    expect(heard).toEqual([
      { heard: 'Brief me', intent: 'other', skills: [{ id: 'shy', p: 0.02 }] },
      { heard: 'Be shy', intent: 'other', skills: [{ id: 'brief', p: 0.03 }] },
    ]);
  });
});

describe('a task on the computer', () => {
  const hands = new Proxy({}, { get: () => new Proxy(() => undefined, { get: (target, key) => (key === 'then' ? undefined : target) }) }) as unknown as HandsService;
  const table: Record<string, [string, Record<string, number>]> = { 'use the computer to book a table at luigi\'s': ['computer_task', { computer_task: 0.97, chat: 0.03 }] };

  it("isn't asked about when the brain can't use the computer - it says so, and names one that can", async () => {
    const { brain, heard } = listening({ usesComputer: false });
    const t = await setup(table, brain, hands);
    await t.nova.handle("Use the computer to book a table at Luigi's.", 'keyboard');
    expect(t.said()).toEqual(["Small can't use the computer - that takes a brain that sees the screen a step at a time, like Claude. Choose one in Settings → Answers."]);
    expect(t.events.some((e) => e.type === 'card' && (e as { card: { kind: string } }).card.kind === 'confirm')).toBe(false);
    expect(heard).toHaveLength(0);
  });

  it("isn't asked about with no brain at all", async () => {
    const t = await setup(table, null, hands);
    await t.nova.handle("Use the computer to book a table at Luigi's.", 'keyboard');
    expect(t.said()).toEqual(["I can't use the computer without a brain - pair Claude, or choose one in Settings → Answers."]);
  });

  it('is asked about first when the brain can', async () => {
    const { brain } = listening();
    const t = await setup(table, brain, hands);
    await t.nova.handle("Use the computer to book a table at Luigi's.", 'keyboard');
    expect(t.said()[0]).toMatch(/^Use the computer to book a table at Luigi's\?/);
  });
});
