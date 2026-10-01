import { describe, expect, it } from 'vitest';
import { EvaluationDecisionEngine, HeuristicEvaluationModel, isCompound, NovaBrain, outputText, type DecisionExample, type Platform, type ReasoningBrain, type ServerEvent } from '../src/index.ts';

type Say = Extract<ServerEvent, { type: 'say' }>;
const tick = () => new Promise((r) => setTimeout(r, 0));
/** Wait until something has happened (the brain answers asynchronously). */
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
}

async function setup(reasoning?: ReasoningBrain) {
  const events: ServerEvent[] = [];
  const opened: string[] = [];
  const quit: string[] = [];
  const platform: Platform = {
    listApps: async () => ['Slack', 'Spotify', 'Notes'],
    openApp: async (a) => void opened.push(a),
    quitApp: async (a) => void quit.push(a),
    now: () => new Date('2026-09-27T10:00:00'),
  };
  const engine = new EvaluationDecisionEngine({ name: 'heuristic', model: new HeuristicEvaluationModel() });
  const learned: DecisionExample[] = [];
  engine.learn = (e) => void learned.push(e);
  const nova = new NovaBrain({ engine, platform, emit: (e) => events.push(e), reasoning });
  await nova.init();
  const says = () => events.filter((e): e is Say => e.type === 'say');
  return { nova, events, opened, quit, says, learned };
}

describe("Nova's skills as tools", () => {
  it('offers them to agents and runs them', async () => {
    const { nova, opened } = await setup();
    const open = nova.specs().find((t) => t.name === 'open_app')!;
    expect(open.parameters.required).toEqual(['app']);
    expect(nova.specs().find((t) => t.name === 'quit_app')!.description).toMatch(/asks the user out loud first/);
    expect(await nova.call('open_app', { app: 'slack' }, 'Claude')).toBe('Opening Slack.');
    expect(opened).toEqual(['Slack']);
    expect(await nova.call('open_app', { app: 'Photoshop' }, 'Claude')).toMatch(/No installed app/);
    expect(await nova.call('launch_rockets', {}, 'Claude')).toMatch(/no tool/);
  });

  it('asks out loud before a risky one, whoever calls it', async () => {
    const { nova, quit, says } = await setup();
    const refused = nova.call('quit_app', { app: 'Spotify' }, 'Codex');
    await tick();
    expect(says().at(-1)?.text).toMatch(/Quit Spotify/);
    await nova.handle('no');
    expect(await refused).toMatch(/said no/);
    expect(quit).toEqual([]);

    const allowed = nova.call('quit_app', { app: 'Spotify' }, 'Codex');
    await tick();
    await nova.handle('yes');
    expect(await allowed).toBe('Spotify closed.');
    expect(quit).toEqual(['Spotify']);
  });
});

describe('a yes or no that Nova did not ask for', () => {
  it("answers the brain's last question", async () => {
    const asked: string[] = [];
    const brain: ReasoningBrain = { name: 'Brain', reply: async (u) => (asked.push(u), 'Great, opening it.') };
    const { nova, says } = await setup(brain);
    await nova.handle('nova yes');
    expect(asked).toEqual(['yes']);
    expect(says().at(-1)?.text).toBe('Great, opening it.');
  });
});

describe('requests with several steps', () => {
  it('go to the brain, which can use several tools', async () => {
    expect(isCompound('open Notes and set a timer for ten minutes')).toBe(true);
    expect(isCompound('quit Spotify then open Slack')).toBe(true);
    expect(isCompound('tell me the time and date')).toBe(false);
    expect(isCompound('ask claude to fix the build and the tests')).toBe(false);
    const asked: string[] = [];
    const brain: ReasoningBrain = { name: 'Brain', reply: async (u) => (asked.push(u), 'On it.') };
    const { nova, opened } = await setup(brain);
    await nova.handle('nova open slack and set a timer for ten minutes');
    expect(asked).toEqual(['open slack and set a timer for ten minutes']);
    expect(opened).toEqual([]); // the brain decides; the skill didn't jump in
  });
});

describe('answers as they are written', () => {
  it('speaks finished sentences while the brain is still writing, as one reply', async () => {
    const brain: ReasoningBrain = {
      name: 'Streamer',
      reply: async () => '',
      async *stream() {
        yield 'Sure. ';
        yield 'Opening ';
        yield 'Slack now. ';
        yield 'Done!';
      },
    };
    const { nova, events, says } = await setup(brain);
    await nova.handle('nova who are you');
    expect(says().map((s) => [s.text, s.partial])).toEqual([
      ['Sure.', true],
      ['Sure. Opening Slack now.', true],
      ['Sure. Opening Slack now. Done!', false],
    ]);
    expect(new Set(says().map((s) => s.id)).size).toBe(1);
    expect(events.filter((e) => e.type === 'phase' && e.phase === 'speaking')).toHaveLength(1);
    expect(events.some((e) => e.type === 'card' && e.card.body === 'Sure. Opening Slack now. Done!')).toBe(true);
  });

  it('ends what was said when a tool has to ask, and carries on after', async () => {
    let nova!: NovaBrain;
    const brain: ReasoningBrain = {
      name: 'Agent',
      reply: async () => '',
      async *stream() {
        yield 'Let me close Spotify. ';
        const result = outputText(await nova.call('quit_app', { app: 'Spotify' }, 'Agent'));
        yield result.includes('said no') ? 'Okay, I left it.' : 'Done, it is closed.';
      },
    };
    const t = await setup(brain);
    nova = t.nova;
    const answering = nova.handle('nova why is the sky blue');
    await until(() => t.says().some((s) => /Quit Spotify/.test(s.text)));
    await nova.handle('yes');
    await answering;
    const said = t.says();
    const first = said.find((s) => s.text === 'Let me close Spotify.' && !s.partial)!;
    const last = said.at(-1)!;
    expect(first).toBeDefined();
    expect(said.some((s) => /Quit Spotify/.test(s.text))).toBe(true);
    expect(last.text).toBe('Done, it is closed.');
    expect(last.id).not.toBe(first.id);
    expect(t.quit).toEqual(['Spotify']);
  });

  it('stops mid-answer when told to', async () => {
    let release!: () => void;
    const brain: ReasoningBrain = {
      name: 'Slow',
      reply: async () => '',
      async *stream(_u, _h, signal) {
        yield 'Thinking about it. ';
        await new Promise<void>((r) => (release = r));
        signal?.throwIfAborted();
        yield 'Too late.';
      },
    };
    const { nova, says } = await setup(brain);
    const answering = nova.handle('nova why is the sky blue');
    await until(() => says().length > 0);
    nova.cancel();
    release();
    await answering;
    expect(says().map((s) => s.text)).toEqual(['Thinking about it.']);
  });
});

describe('the brain teaching System 1', () => {
  it('learns a phrasing when the brain handles it with one skill that works', async () => {
    let nova!: NovaBrain;
    const brain: ReasoningBrain = {
      name: 'Brain',
      reply: async (u) => {
        if (u.includes('tunes')) await nova.call('open_app', { app: 'Spotify' }, 'Brain');
        if (u.includes('tokyo')) await nova.call('tell_time', {}, 'Brain');
        if (u.includes('evening')) (await nova.call('open_app', { app: 'Notes' }, 'Brain'), await nova.call('open_app', { app: 'Slack' }, 'Brain'));
        if (u.includes('ditch')) await nova.call('quit_app', { app: 'Spotify' }, 'Brain');
        return 'Done.';
      },
    };
    const t = await setup(brain);
    nova = t.nova;
    await nova.handle('nova i fancy some tunes');
    expect(t.opened).toEqual(['Spotify']);
    expect(t.learned).toEqual([{ utterance: 'i fancy some tunes', question: 'intent', choice: 'open_app', source: 'brain' }]);

    // Not from a skill that only informs (the brain may have built on it), nor from several skills.
    await nova.handle('nova whats it like in tokyo right now');
    await nova.handle('nova sort my evening out');
    expect(t.learned).toHaveLength(1);

    // Nor when the user said no.
    const answering = nova.handle('nova ditch the music');
    await until(() => t.says().some((s) => /Quit Spotify/.test(s.text)));
    await nova.handle('no');
    await answering;
    expect(t.quit).toEqual([]);
    expect(t.learned).toHaveLength(1);
  });

  it("doesn't learn from a brain that chose from System 1's own shortlist", async () => {
    let nova!: NovaBrain;
    const brain: ReasoningBrain = {
      name: 'Small',
      fewTools: true,
      reply: async () => (await nova.call('open_app', { app: 'Spotify' }, 'Small'), 'Done.'),
    };
    const t = await setup(brain);
    nova = t.nova;
    await nova.handle('nova i fancy some tunes');
    expect(t.opened).toEqual(['Spotify']);
    expect(t.learned).toEqual([]);
  });
});
