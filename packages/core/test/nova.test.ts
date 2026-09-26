import { Experimental_EvaluationMockModelV4 as MockEvaluationModel } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import {
  EvaluationDecisionEngine,
  HeuristicEvaluationModel,
  NovaBrain,
  parseDuration,
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

async function setup(engine = new EvaluationDecisionEngine({ name: 'heuristic', model: new HeuristicEvaluationModel() })) {
  const events: ServerEvent[] = [];
  const { platform, opened, quit } = fakePlatform();
  const nova = new NovaBrain({ engine, platform, emit: (e) => events.push(e) });
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
  const keys = ['open_app', 'quit_app', 'tell_time', 'set_timer', 'cancel_timer', 'stop', 'confirm_yes', 'confirm_no', 'chat', 'other'];
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

describe('parseDuration', () => {
  it.each([
    ['set a timer for 5 minutes', 300_000],
    ['timer for thirty seconds', 30_000],
    ['remind me in an hour and 10 minutes', 4_200_000],
    ['half an hour', 1_800_000],
    ['set a timer', null],
  ])('%s', (text, ms) => expect(parseDuration(text)).toBe(ms));
});
