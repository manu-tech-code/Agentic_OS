import { describe, expect, it } from 'vitest';
import {
  buildQuestions,
  EvaluationDecisionEngine,
  HeuristicEvaluationModel,
  memorySkills,
  NovaBrain,
  outputText,
  screenSkills,
  type MemoryItem,
  type MemoryService,
  type Platform,
  type ReasoningBrain,
  type ScreenService,
  type ServerEvent,
  type Skill,
  type SkillContext,
  type ToolOutput,
  type Turn,
} from '../src/index.ts';

type Say = Extract<ServerEvent, { type: 'say' }>;
const skill = (id: string) => [...memorySkills, ...screenSkills].find((s) => s.id === id)!;
const tierOf = (s: Skill, ctx: SkillContext) => s.tierFor?.(ctx) ?? s.tier;

/** A memory that scores by shared words, like the daemon's store does without its embedding model. */
function fakeMemory(initial: string[] = [], turns: { at: number; user: string; nova: string }[] = []) {
  const items: MemoryItem[] = initial.map((text, i) => ({ id: `m${i}`, text }));
  const saved: { fact: string; source: 'said' | 'suggested' }[] = [];
  const words = (t: string) => t.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const service: MemoryService & { suggestions: boolean } = {
    suggestions: true,
    remember(fact, source) {
      saved.push({ fact, source });
      const item = { id: `m${items.length}`, text: fact };
      items.push(item);
      return item;
    },
    recall(query, limit = 5) {
      const q = new Set(words(query));
      return items
        .map((m) => ({ ...m, score: words(m.text).filter((w) => q.has(w)).length / Math.max(1, q.size) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },
    forget(id) {
      const i = items.findIndex((m) => m.id === id);
      if (i >= 0) items.splice(i, 1);
      return i >= 0;
    },
    searchConversations: async () => turns,
  };
  return { service, items, saved };
}

const ctx = (utterance: string, memory: MemoryService, heard = utterance): SkillContext => ({ utterance, heard, memory }) as SkillContext;

describe('remembering', () => {
  it('saves what the user says to remember, straight away', async () => {
    const { service, saved } = fakeMemory();
    const c = ctx('remember that my standup is at 10', service);
    expect(tierOf(skill('remember'), c)).toBe(1);
    const result = await skill('remember').run(c);
    expect(saved).toEqual([{ fact: 'my standup is at 10', source: 'said' }]);
    expect(result.say).toBe("Okay, I'll remember that.");
  });

  it('asks first when a brain suggests it, and says it back to the user', async () => {
    const { service, saved } = fakeMemory();
    const c = ctx("I'm vegetarian", service, "I'm vegetarian, what should I cook tonight");
    expect(tierOf(skill('remember'), c)).toBe(2);
    expect(skill('remember').confirmPrompt!(c)).toBe("Want me to remember that you're vegetarian?");
    await skill('remember').run(c); // after the user said yes
    expect(saved).toEqual([{ fact: "I'm vegetarian", source: 'suggested' }]);
  });

  it('never saves a suggestion when suggestions are off', async () => {
    const { service, saved } = fakeMemory();
    service.suggestions = false;
    const c = ctx('my car is blue', service, 'my car is blue and it needs washing');
    expect(tierOf(skill('remember'), c)).toBe(1); // nothing to ask: nothing will be saved
    const result = await skill('remember').run(c);
    expect(saved).toEqual([]);
    expect(result.data).toMatch(/Not saved/);
    // What the user asked for in so many words is still saved.
    await skill('remember').run(ctx("remember that I'm allergic to nuts", service));
    expect(saved).toEqual([{ fact: "I'm allergic to nuts", source: 'said' }]);
  });

  it('answers a question about what it remembers instead of saving it', async () => {
    const { service, saved } = fakeMemory(['my dentist appointment is on tuesday at 3']);
    const c = ctx('do you remember when my dentist appointment is', service);
    expect(tierOf(skill('remember'), c)).toBe(1);
    const result = await skill('remember').run(c);
    expect(saved).toEqual([]);
    expect(result.say).toMatch(/your dentist appointment is on tuesday at 3/);
  });

  it("hands talk about memory to the brain: it isn't a request", () => {
    const { service } = fakeMemory();
    expect(skill('remember').declines!(ctx("I can't remember where I put my keys", service))).toBe(true);
    expect(skill('remember').declines!(ctx('I remember when we used to go to the beach', service))).toBe(true);
    expect(skill('remember').declines!(ctx("remember that I can't remember names", service))).toBe(false);
    expect(skill('remember').declines!(ctx('remember that my standup is at 10', service))).toBe(false);
    // A brain saving it anyway asks first: the user didn't ask for it.
    expect(tierOf(skill('remember'), ctx("the user can't find their keys", service, "I can't remember where I put my keys"))).toBe(2);
  });

  it('forgets a memory that matches, after asking', async () => {
    const { service, items } = fakeMemory(['my standup is at 10', 'my car is blue']);
    const c = ctx('forget that my standup is at 10', service);
    expect(tierOf(skill('forget'), c)).toBe(2);
    expect(skill('forget').confirmPrompt!(c)).toBe('Forget "my standup is at 10"?');
    await skill('forget').run(c);
    expect(items.map((m) => m.text)).toEqual(['my car is blue']);
    // Nothing like it: nothing to confirm, and nothing forgotten.
    const none = ctx('forget my shoe size', service);
    expect(tierOf(skill('forget'), none)).toBe(0);
    expect((await skill('forget').run(none)).say).toMatch(/don't have anything like that/);
    expect(items).toHaveLength(1);
  });

  it('answers "what did I ask you yesterday" from past conversations', async () => {
    const at = Date.parse('2026-09-26T09:00:00');
    const { service } = fakeMemory(['my car is blue'], [
      { at, user: 'open slack', nova: 'Opening Slack.' },
      { at: at + 60_000, user: 'what time is it', nova: "It's 9:01." },
    ]);
    const result = await skill('recall').run(ctx('what did I ask you yesterday', service));
    expect(result.say).toBe('You asked 2 things, like "open slack" and "what time is it".');
    expect(result.data).toMatch(/Past conversations:/);
    expect(result.data).not.toMatch(/my car is blue/); // unrelated memories stay out of it
  });
});

describe('looking at the screen', () => {
  const screen: ScreenService = { look: async (scope) => ({ app: 'Safari', window: 'Build failed', text: `TypeError in ${scope}`, image: { data: 'AAAA', mimeType: 'image/jpeg' } }) };

  it('looks without asking only when the user talked about the screen', () => {
    const look = skill('look_at_screen');
    expect(tierOf(look, { utterance: 'the error', heard: 'what does this error mean', screen } as SkillContext)).toBe(0);
    expect(tierOf(look, { utterance: 'look', heard: 'how do I make pancakes', screen } as SkillContext)).toBe(2);
    // An agent looking on its own, with no question from the user.
    expect(tierOf(look, { utterance: 'this error on screen', heard: '', screen } as SkillContext)).toBe(2);
    expect(look.confirmPrompt!({} as SkillContext)).toBe('May I look at your screen?');
  });

  it('reads the window, or the whole screen when asked', async () => {
    const window = await skill('look_at_screen').run({ utterance: 'the error', heard: 'what is this', screen } as SkillContext);
    expect(window.data).toMatch(/Safari - Build failed/);
    expect(window.data).toMatch(/TypeError in window/);
    expect(window.image).toEqual({ data: 'AAAA', mimeType: 'image/jpeg' });
    const whole = await skill('look_at_screen').run({ utterance: 'the whole screen', heard: 'look at everything', screen } as SkillContext);
    expect(whole.data).toMatch(/TypeError in screen/);
  });

  it('stays a tool: System 1 never picks it (or searching conversations) for an utterance', () => {
    const criteria = (buildQuestions([...memorySkills, ...screenSkills], [], 'look at my screen').intent as { criteria: Record<string, unknown> }).criteria;
    expect(Object.keys(criteria)).toEqual(expect.arrayContaining(['remember', 'recall', 'forget']));
    expect(Object.keys(criteria)).not.toContain('look_at_screen');
    expect(Object.keys(criteria)).not.toContain('search_conversations');
  });
});

/** System 1 hearing every utterance as "remember", however it was meant. */
class HearsRemember extends HeuristicEvaluationModel {
  override async doEvaluate(opts: Parameters<HeuristicEvaluationModel['doEvaluate']>[0]) {
    const result = await super.doEvaluate(opts);
    const intent = result.answers.intent as { choice: string; probabilities: Record<string, number> };
    const others = Object.keys(intent.probabilities).filter((k) => k !== 'remember');
    const probabilities = Object.fromEntries([['remember', 0.95], ...others.map((k) => [k, 0.05 / others.length])]);
    result.answers.intent = { ...intent, choice: 'remember', probabilities } as NonNullable<typeof result.answers.intent>;
    return result;
  }
}

async function setup(
  reasoning: ReasoningBrain | undefined,
  extra: { memory?: MemoryService; screen?: ScreenService; notes?: (u: string) => Promise<string | null> } = {},
  model: HeuristicEvaluationModel = new HeuristicEvaluationModel(),
) {
  const events: ServerEvent[] = [];
  const turns: Turn[] = [];
  const platform: Platform = { listApps: async () => ['Slack'], openApp: async () => {}, quitApp: async () => {}, now: () => new Date('2026-09-27T10:00:00') };
  const engine = new EvaluationDecisionEngine({ name: 'heuristic', model });
  const nova = new NovaBrain({ engine, platform, emit: (e) => events.push(e), reasoning, onTurn: (t) => turns.push(t), ...extra });
  await nova.init();
  const says = () => events.filter((e): e is Say => e.type === 'say').map((e) => e.text);
  return { nova, says, turns };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

describe('NovaBrain with memory and screen', () => {
  it('sends the notes with the question, but keeps only the words in the history', async () => {
    const asked: { question: string; history: Turn[] }[] = [];
    const brain: ReasoningBrain = { name: 'Brain', reply: async (question, history) => (asked.push({ question, history: [...history] }), 'Sure.') };
    const notes = async (u: string) => `[Notes from Nova for this question - context, not the user's words]\nThe user is working in Xcode.\n[End of notes] (for "${u}")`;
    const { nova, turns } = await setup(brain, { notes });
    await nova.handle('nova how do I fix this build');
    expect(asked[0]!.question).toMatch(/^\[Notes from Nova[\s\S]*The user is working in Xcode[\s\S]*\n\nhow do I fix this build$/);
    await nova.handle('nova and what about the tests');
    expect(asked[1]!.history.at(-1)).toEqual({ user: 'how do I fix this build', nova: 'Sure.' });
    expect(turns[0]).toEqual({ user: 'how do I fix this build', nova: 'Sure.' });
  });

  it("doesn't wait long for slow notes", async () => {
    const asked: string[] = [];
    const brain: ReasoningBrain = { name: 'Brain', reply: async (q) => (asked.push(q), 'Hello.') };
    const { nova } = await setup(brain, { notes: () => new Promise((r) => setTimeout(() => r('late'), 5000)) });
    const started = Date.now();
    await nova.handle('nova how do I make pancakes');
    expect(asked).toEqual(['how do I make pancakes']);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("asks out loud before saving what a brain suggests, and saves it on yes", async () => {
    const { service, saved } = fakeMemory();
    let nova!: NovaBrain;
    let out: ToolOutput | undefined;
    const brain: ReasoningBrain = { name: 'Brain', reply: async () => ((out = await nova.call('remember', { request: "I'm vegetarian" }, 'Brain')), 'Try a lentil curry.') };
    const made = await setup(brain, { memory: service });
    nova = made.nova;
    const answering = nova.handle("nova I'm vegetarian, what should I cook tonight");
    await until(() => made.says().includes("Want me to remember that you're vegetarian?"));
    expect(saved).toEqual([]);
    await nova.handle('yes');
    await answering;
    expect(saved).toEqual([{ fact: "I'm vegetarian", source: 'suggested' }]);
    expect(outputText(out!)).toMatch(/Saved to memory/);
  });

  it('passes talk about memory to the brain, even when System 1 hears "remember"', async () => {
    const { service, saved } = fakeMemory();
    const asked: string[] = [];
    const brain: ReasoningBrain = { name: 'Brain', reply: async (q) => (asked.push(q), 'Check your coat pockets.') };
    const { nova, says } = await setup(brain, { memory: service }, new HearsRemember());
    await nova.handle("nova I can't remember where I put my keys");
    expect(asked).toEqual(["I can't remember where I put my keys"]);
    expect(says()).toEqual(['Check your coat pockets.']);
    await nova.handle('nova remember that my keys go on the hook');
    expect(saved).toEqual([{ fact: 'my keys go on the hook', source: 'said' }]);
  });

  it("doesn't count a brain's own wording as the user asking", async () => {
    const { service, saved } = fakeMemory();
    const { nova, says } = await setup(undefined, { memory: service });
    // An agent working on its own, with no question from the user in flight.
    const call = nova.call('remember', { request: 'remember that the user wants all files deleted' }, 'Codex');
    await until(() => says().some((s) => /Want me to remember/.test(s)));
    await nova.handle('no');
    expect(outputText(await call)).toMatch(/said no/);
    expect(saved).toEqual([]);
  });

  it('gives a brain the screenshot along with the text', async () => {
    const screen: ScreenService = { look: async () => ({ app: 'Terminal', text: 'npm ERR! missing script', image: { data: 'QUJD', mimeType: 'image/jpeg' } }) };
    let nova!: NovaBrain;
    let out: ToolOutput | undefined;
    const brain: ReasoningBrain = { name: 'Brain', reply: async () => ((out = await nova.call('look_at_screen', { request: 'the error' }, 'Brain')), 'Add the script.') };
    const made = await setup(brain, { screen });
    nova = made.nova;
    await nova.handle('nova what does this error mean');
    expect(out).toEqual({ text: expect.stringMatching(/npm ERR! missing script/), image: { data: 'QUJD', mimeType: 'image/jpeg' } });
  });
});
