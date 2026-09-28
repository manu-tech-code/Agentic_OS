import { Experimental_EvaluationMockModelV4 as MockEvaluationModel, MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import {
  builtinSkills,
  createDecisionEngine,
  EvaluationDecisionEngine,
  HeuristicEvaluationModel,
  META_INTENTS,
  NovaBrain,
  parseDuration,
  type AgentHost,
  type DecisionEngine,
  type NovaOptions,
  type Platform,
  type ServerEvent,
} from '../src/index.ts';

function fakePlatform(apps = ['Safari', 'Slack', 'Spotify', 'Visual Studio Code']) {
  const opened: string[] = [];
  const quit: string[] = [];
  const platform: Platform = {
    listApps: async () => apps,
    openApp: async (a) => void opened.push(a),
    quitApp: async (a) => void quit.push(a),
    now: () => new Date('2026-09-26T15:42:00'),
  };
  return { platform, opened, quit };
}

async function setup(
  engine: DecisionEngine = new EvaluationDecisionEngine({ name: 'heuristic', model: new HeuristicEvaluationModel() }),
  extra: Partial<NovaOptions> = {},
) {
  const events: ServerEvent[] = [];
  const { platform, opened, quit } = fakePlatform();
  const nova = new NovaBrain({ engine, platform, emit: (e) => events.push(e), ...extra });
  await nova.init();
  const said = () => events.filter((e) => e.type === 'say').map((e) => (e as { text: string }).text);
  return { nova, events, opened, quit, said };
}

/** A stand-in for Jev returning fixed typed answers. */
function mockJev(answers: Record<string, unknown>) {
  return new EvaluationDecisionEngine({
    name: 'mock-jev',
    model: new MockEvaluationModel({ doEvaluate: async () => ({ answers: answers as any, warnings: [] }) }),
  });
}

const intent = (choice: string, p: number) => {
  // Every intent the brain asks about - a typed answer must cover all of them.
  const keys = [...builtinSkills.map((s) => s.id), 'brief', 'stop_everything', ...Object.keys(META_INTENTS)]; // always there
  const rest = (1 - p) / (keys.length - 1);
  return { type: 'choice', choice, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? p : rest])) };
};
const appAnswer = (choice: string, p: number) => {
  const keys = ['none', 'Safari', 'Slack', 'Spotify', 'Visual Studio Code'];
  const rest = (1 - p) / (keys.length - 1);
  return { type: 'choice', choice, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? p : rest])) };
};

describe('wake word', () => {
  it('ignores speech without the wake word', async () => {
    const { nova, opened, events } = await setup();
    await nova.handle('open slack');
    expect(opened).toEqual([]);
    expect(events).toEqual([]);
  });

  it('treats speech before the wake word as background', async () => {
    const { nova } = await setup();
    expect(nova.stripWake('you charlie now you cry hey nova open slack')).toEqual({ found: true, rest: 'open slack' });
    expect(nova.stripWake('open slack, nova')).toEqual({ found: true, rest: 'open slack,' });
  });

  it('bare wake word opens a listening window, next utterance needs no wake word', async () => {
    const { nova, opened, events } = await setup();
    await nova.handle('hey nova');
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'listening', label: undefined });
    await nova.handle('open spotify');
    expect(opened).toEqual(['Spotify']);
  });
});

describe('direct skills (heuristic engine, no keys)', () => {
  it('opens an app in one decision', async () => {
    const { nova, opened, said } = await setup();
    await nova.handle('Hey Nova, open Slack');
    expect(opened).toEqual(['Slack']);
    expect(said()).toEqual(['Opening Slack.']);
  });

  it('tells the time', async () => {
    const { nova, said } = await setup();
    await nova.handle('nova what time is it');
    expect(said()[0]).toMatch(/^It's 3:42/);
  });

  it('asks which app when none is named, then fills the slot', async () => {
    const { nova, opened, said } = await setup();
    await nova.handle('nova open');
    expect(said()).toEqual(['Which app?']);
    await nova.handle('visual studio code');
    expect(opened).toEqual(['Visual Studio Code']);
  });

  it('requires spoken confirmation for tier-2 actions', async () => {
    const { nova, quit, said } = await setup();
    await nova.handle('nova quit spotify');
    expect(quit).toEqual([]);
    expect(said()[0]).toMatch(/Quit Spotify\?/);
    await nova.handle('yes');
    expect(quit).toEqual(['Spotify']);
  });

  it('turns the microphone off when asked to stop listening', async () => {
    const { nova, events, said } = await setup();
    await nova.handle('nova stop listening');
    expect(events).toContainEqual({ type: 'listen', on: false });
    expect(said()).toEqual(["Okay, I've stopped listening. Tap the microphone when you need me."]);
  });

  it('opens its settings when asked, but "open system settings" still opens the app', async () => {
    const { nova, events, opened } = await setup(undefined, {
      platform: { listApps: async () => ['System Settings', 'Slack'], openApp: async (a) => void opened.push(a), quitApp: async () => {}, now: () => new Date() },
    });
    await nova.init();
    await nova.handle('nova open settings');
    expect(events).toContainEqual({ type: 'show', panel: 'settings' });
    await nova.handle('nova open system settings');
    expect(opened).toEqual(['System Settings']);
  });

  it('declining a confirmation does nothing', async () => {
    const { nova, quit } = await setup();
    await nova.handle('nova close slack');
    await nova.handle('no');
    expect(quit).toEqual([]);
  });
});

describe('decision thresholds (mocked Jev)', () => {
  it('rejects follow-ups Jev thinks were not addressed to Nova', async () => {
    const { nova, opened, events } = await setup(
      mockJev({ intent: intent('open_app', 0.9), addressed: { type: 'boolean', probability: 0.1 }, app: appAnswer('Slack', 0.9) }),
    );
    nova.speechFinished(); // follow-up window open
    await nova.handle('open slack'); // no wake word, e.g. from a video
    expect(opened).toEqual([]);
    const trace = events.find((e) => e.type === 'decision');
    expect(trace && trace.type === 'decision' && trace.trace.outcome).toMatch(/^ignored/);
  });

  it('asks again when intent confidence is below the tier floor', async () => {
    const { nova, opened, said } = await setup(
      mockJev({ intent: intent('open_app', 0.3), addressed: { type: 'boolean', probability: 0.9 }, app: appAnswer('Slack', 0.9) }),
    );
    await nova.handle('nova mumble slack');
    expect(opened).toEqual([]);
    expect(said()[0]).toMatch(/not sure/);
  });

  it('falls back to the heuristic engine when the primary fails', async () => {
    const broken = new MockEvaluationModel({
      doEvaluate: async () => {
        throw new Error('503');
      },
    });
    const engine = new EvaluationDecisionEngine(
      { name: 'jev', model: broken },
      { name: 'heuristic', model: new HeuristicEvaluationModel() },
    );
    const { nova, opened, events } = await setup(engine);
    await nova.handle('nova open safari');
    expect(opened).toEqual(['Safari']);
    const trace = events.find((e) => e.type === 'decision');
    expect(trace && trace.type === 'decision' && trace.trace.fellBack).toBe(true);
  });

  it('routes open questions to the reasoning brain', async () => {
    const events: ServerEvent[] = [];
    const reply = vi.fn(async () => 'Jevons paradox says efficiency increases total demand.');
    const nova = new NovaBrain({
      engine: mockJev({ intent: intent('chat', 0.95), addressed: { type: 'boolean', probability: 0.95 } }),
      platform: fakePlatform([]).platform,
      reasoning: { name: 'test-llm', reply },
      emit: (e) => events.push(e),
    });
    await nova.handle('nova what is the jevons paradox');
    expect(reply).toHaveBeenCalledOnce();
    expect(events.some((e) => e.type === 'say' && e.text.startsWith('Jevons'))).toBe(true);
  });
});

describe('follow-up window', () => {
  it('keeps listening after a reply, so the next command needs no wake word', async () => {
    const { nova, opened } = await setup();
    await nova.handle('nova what time is it');
    await nova.handle('open spotify'); // before the shell reports speech finished
    expect(opened).toEqual(['Spotify']);
  });

  it('needs the wake word again once the window has passed', async () => {
    let t = 0;
    const { nova, opened } = await setup(undefined, { clock: () => t, followUpMs: 20_000 });
    await nova.handle('nova what time is it');
    t = 20_001;
    await nova.handle('open spotify');
    expect(opened).toEqual([]);
  });

  it('conversation mode needs no wake word but still ignores speech not meant for Nova', async () => {
    const { nova, opened } = await setup(undefined, { requireWakeWord: false });
    await nova.handle('open spotify');
    expect(opened).toEqual(['Spotify']);

    const background = await setup(
      mockJev({ intent: intent('open_app', 0.9), addressed: { type: 'boolean', probability: 0.1 }, app: appAnswer('Slack', 0.9) }),
      { requireWakeWord: false },
    );
    await background.nova.handle('open slack');
    expect(background.opened).toEqual([]);
  });
});

describe('live settings', () => {
  it('takes new settings without losing the conversation', async () => {
    const { nova, opened, events } = await setup();
    await nova.handle('computer open slack');
    expect(opened).toEqual([]); // "computer" isn't a wake word yet

    nova.reconfigure({ wakeWords: ['computer'], requireWakeWord: true, ui: { autoListen: false, rate: 1.2, lang: 'en-GB', orb: { style: 'particles', colors: 'ember', motion: 'calm', size: 120, floatingSize: 150 } } });
    await nova.handle('computer open slack');
    expect(opened).toEqual(['Slack']);
    expect(nova.hello()).toMatchObject({ wakeWords: ['computer'], ui: { rate: 1.2, lang: 'en-GB' } });
    expect(events.filter((e) => e.type === 'decision')).toHaveLength(1);
  });

  it('answers to a new name without being told new wake words', async () => {
    const { nova, opened } = await setup();
    nova.reconfigure({ name: 'Jarvis' });
    await nova.handle('nova open spotify'); // the old name no longer wakes it
    expect(opened).toEqual([]);
    await nova.handle('hey jarvis, open slack');
    expect(opened).toEqual(['Slack']);
    expect(nova.hello()).toMatchObject({ name: 'Jarvis', wakeWords: ['hey jarvis', 'okay jarvis', 'jarvis'] });
  });
});

describe('LLM decisions (e.g. a local model)', () => {
  const llmReplying = (text: string) =>
    new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      },
    });

  it('resolves the configured model id and acts on its typed answers', async () => {
    const model = llmReplying(
      JSON.stringify({ intent: { choice: 'open_app', confidence: 0.9 }, addressed: { probability: 0.95 }, app: { choice: 'Slack', confidence: 0.9 } }),
    );
    const resolved: string[] = [];
    const engine = createDecisionEngine({ engine: 'llm', fallback: 'none', llmModel: 'lmstudio/tiny', resolveModel: (id) => (resolved.push(id), model) });
    expect(engine.name).toBe('llm (lmstudio/tiny)');

    const { nova, opened } = await setup(engine);
    await nova.handle('hey nova open slack');
    expect(resolved).toEqual(['lmstudio/tiny']);
    expect(opened).toEqual(['Slack']);
    // The reply shape is spelled out for servers that can't enforce a JSON schema.
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain('Reply with one JSON object');
  });

  it('falls back to the heuristic engine when the model replies with something unusable', async () => {
    const engine = createDecisionEngine({ engine: 'llm', llmModel: 'lmstudio/tiny', resolveModel: () => llmReplying('Sure! Opening Slack now.') });
    const { nova, opened, events } = await setup(engine);
    await nova.handle('hey nova open slack');
    expect(opened).toEqual(['Slack']);
    const trace = events.find((e) => e.type === 'decision');
    expect(trace && trace.type === 'decision' && trace.trace.fellBack).toBe(true);
  });
});

describe('paired agents', () => {
  /** A stand-in for Claude Code / Codex: records calls, asks one permission question per task. */
  function fakeAgents(run?: AgentHost['run']) {
    const calls: string[] = [];
    const host: AgentHost = {
      agents: [
        { name: 'claude', label: 'Claude' },
        { name: 'codex', label: 'Codex' },
      ],
      projects: ['Agentic_OS', 'website'],
      ask: async (agent, question) => (calls.push(`ask ${agent}: ${question}`), `${agent} answered`),
      run:
        run ??
        (async (agent, task, project, callbacks) => {
          calls.push(`run ${agent} in ${project}: ${task}`);
          callbacks.onStep({ kind: 'command', text: 'running npm test' });
          const ok = await callbacks.approve({ action: 'run "npm test"' });
          calls.push(`approved ${ok}`);
          return ok ? 'Found the bug.\n\nI fixed the failing test and all tests pass.' : 'I could not run the tests.';
        }),
    };
    return { host, calls };
  }

  it('sends a question to the agent the user names', async () => {
    const { host, calls } = fakeAgents();
    const { nova, said } = await setup(undefined, { agents: host });
    await nova.handle('nova ask codex what is the jevons paradox');
    expect(calls).toEqual(['ask codex: ask codex what is the jevons paradox']);
    expect(said()).toEqual(['codex answered']);
  });

  it('confirms a project task, narrates it, asks permission out loud and announces the result', async () => {
    const { host, calls } = fakeAgents();
    const { nova, said, events } = await setup(undefined, { agents: host });
    await nova.handle('nova ask claude to fix the failing test in agentic os');
    expect(said().at(-1)).toBe('Ask Claude to work in Agentic_OS? It can edit files and run commands there.');
    expect(calls).toEqual([]);

    await nova.handle('yes');
    expect(said().at(-1)).toBe('Okay, Claude is on it.');
    await vi.waitFor(() => expect(said().at(-1)).toBe('Claude wants to run "npm test" in Agentic_OS. Allow it?'));
    expect(events.some((e) => e.type === 'card' && e.card.kind === 'task' && e.card.body === 'running npm test')).toBe(true);

    await nova.handle('yes');
    await vi.waitFor(() => expect(said().at(-1)).toBe('I fixed the failing test and all tests pass.'));
    expect(calls).toEqual(['run claude in Agentic_OS: ask claude to fix the failing test in agentic os', 'approved true']);
  });

  it('tells the agent no when the user refuses a step', async () => {
    const { host, calls } = fakeAgents();
    const { nova, said } = await setup(undefined, { agents: host });
    await nova.handle('nova ask claude to fix the failing test in agentic os');
    await nova.handle('yes');
    await vi.waitFor(() => expect(said().at(-1)).toMatch(/Allow it\?$/));
    await nova.handle('no');
    await vi.waitFor(() => expect(said().at(-1)).toBe('I could not run the tests.'));
    expect(calls.at(-1)).toBe('approved false');
  });

  it('asks which project when none is named', async () => {
    const { host } = fakeAgents();
    const { nova, said } = await setup(undefined, { agents: host });
    await nova.handle('nova ask claude to update the docs');
    expect(said().at(-1)).toBe('Which project?');
    await nova.handle('website');
    expect(said().at(-1)).toBe('Ask Claude to work in website? It can edit files and run commands there.');
  });

  it('stops a running task on request', async () => {
    const { host } = fakeAgents(
      (_agent, _task, _project, _callbacks, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    const { nova, said, events } = await setup(undefined, { agents: host });
    await nova.handle('nova ask claude to fix the failing test in agentic os');
    await nova.handle('yes');
    await nova.handle('nova stop the agent');
    expect(said().at(-1)).toBe('Stopped the task.');
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === 'activity' && e.item.status === 'cancelled' && e.item.label === 'Claude stopped in Agentic_OS')).toBe(true),
    );
  });
});

describe('parseDuration', () => {
  it.each([
    ['set a timer for 5 minutes', 300_000],
    ['timer for thirty seconds', 30_000],
    ['remind me in an hour and 10 minutes', 4_200_000],
    ['half an hour', 1_800_000],
    ['set a timer', null],
  ])('%s', (text, ms) => expect(parseDuration(text)).toBe(ms));
});
