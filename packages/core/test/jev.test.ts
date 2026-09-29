import { describe, expect, it } from 'vitest';
import { buildQuestions, builtinSkills, createDecisionEngine, handDoubtToBrain, JEV_DOUBT_FLOOR, restatedYes, type EvaluationModelV4, type RawResult } from '../src/index.ts';
import { JEV_URL, JevEvaluationModel } from '../src/decision/jev.ts';

const KEY = 'jev-test-key-0000';

/** A stand-in for TypeSafe's endpoint: answers every question as Jev does (rounded probabilities, some options left out). */
function fakeJev(opts: { status?: number; body?: unknown; delayMs?: number } = {}) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetch = (async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    if (opts.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, opts.delayMs);
        init.signal?.addEventListener('abort', () => (clearTimeout(t), reject(init.signal!.reason)));
      });
    }
    if (opts.status && opts.status !== 200) return new Response(JSON.stringify(opts.body ?? { detail: 'nope' }), { status: opts.status });
    const req = calls.at(-1)!.body;
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries<any>(req.questions)) {
      if (q.type === 'choice') {
        const [first, second] = Object.keys(q.criteria);
        answers[id] = { type: 'choice', choice: first, probabilities: { [first!]: 0.62, ...(second ? { [second]: 0.37 } : {}) }, confidence: 0.43 };
      } else if (q.type === 'score') answers[id] = { type: 'score', score: 0.79, probabilities: { 0: 0.2, 1: 0.8 }, confidence: 0.6 };
      else answers[id] = { type: 'noul', noul: 0.83 };
    }
    return new Response(JSON.stringify(opts.body ?? { model: 'jev-1.13.0', answers, usage: { input_tokens: 2100, output_tokens: 40 } }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

/** Reflex, as far as the engine is concerned: it always picks chat. */
const fakeReflex: EvaluationModelV4 = {
  specificationVersion: 'v4',
  provider: 'nova',
  modelId: 'reflex (fake)',
  supportedQuestionTypes: ['choice', 'score', 'boolean'],
  async doEvaluate({ questions }): Promise<RawResult> {
    const answers: RawResult['answers'] = {};
    for (const [id, q] of Object.entries(questions)) {
      answers[id] = q.type === 'choice' ? { type: 'choice', choice: 'chat' in q.criteria ? 'chat' : Object.keys(q.criteria)[0]! } : q.type === 'score' ? { type: 'score', score: 0 } : { type: 'boolean', probability: 0.9 };
    }
    return { answers, warnings: [] };
  },
};

const apps = ['Safari', 'Slack', 'Spotify'];
const state = { utterance: 'open slack', wakeWordUsed: true, recentTurns: [] };

describe('Jev, called directly', () => {
  it("asks TypeSafe's endpoint in Jev's words, with the key only in the Authorization header", async () => {
    const jev = fakeJev();
    const model = new JevEvaluationModel({ apiKey: KEY, fetch: jev.fetch });
    await model.doEvaluate({ state, questions: { go: { type: 'boolean', instructions: 'Is it for Nova?', criteria: { true: 'yes', false: 'no' } }, how: { type: 'score', instructions: 'How sure?', criteria: ['low', 'high'] } } });
    const [call] = jev.calls;
    expect(call!.url).toBe(JEV_URL);
    expect(call!.headers).toMatchObject({ authorization: `Bearer ${KEY}`, 'content-type': 'application/json' });
    expect(call!.body).toEqual({
      model: 'jev-latest',
      state,
      questions: { go: { type: 'noul', instructions: 'Is it for Nova?', criteria: { true: 'yes', false: 'no' } }, how: { type: 'score', instructions: 'How sure?', criteria: ['low', 'high'] } },
    });
    expect(JSON.stringify(call!.body)).not.toContain(KEY);
  });

  it('gives Nova answers the AI SDK accepts: every option there, probabilities that sum to 1, confidence alongside', async () => {
    const jev = fakeJev();
    const engine = createDecisionEngine({ engine: 'jev', fallback: 'none', jevApiKey: KEY, jevFetch: jev.fetch });
    expect(engine.name).toBe('jev (jev-latest)');
    const questions = buildQuestions(builtinSkills, apps, 'open slack');
    const d = await engine.decide(state, questions);
    expect(d.fellBack).toBe(false);
    const intent = (d.answers as any).intent;
    const options = Object.keys((questions as any).intent.criteria);
    expect(Object.keys(intent.probabilities).sort()).toEqual([...options].sort()); // the ones Jev left out, at 0
    expect(Object.values<number>(intent.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(intent.choice).toBe(options[0]);
    expect(d.confidence?.intent).toBe(0.43);
  });

  it('turns Jev\'s noul into a probability and keeps a score the mean of its levels', async () => {
    const model = new JevEvaluationModel({ apiKey: KEY, fetch: fakeJev().fetch });
    const r = await model.doEvaluate({ state, questions: { go: { type: 'boolean', instructions: 'Is it for Nova?' }, how: { type: 'score', instructions: 'How sure?', criteria: ['low', 'high'] } } });
    expect(r.answers.go).toEqual({ type: 'boolean', probability: 0.83 });
    expect(r.answers.how).toEqual({ type: 'score', score: 0.8, probabilities: { 0: 0.2, 1: 0.8 } });
    expect(r.usage).toEqual({ inputTokens: 2100, outputTokens: 40 });
  });

  it('falls back to Reflex when Jev refuses, and never says the key', async () => {
    const jev = fakeJev({ status: 401 });
    const engine = createDecisionEngine({ engine: 'jev', jevApiKey: KEY, jevFetch: jev.fetch, reflex: fakeReflex });
    expect(engine.name).toBe('jev (jev-latest) → reflex (fake)');
    const d = await engine.decide(state, buildQuestions(builtinSkills, apps, 'open slack'));
    expect(d).toMatchObject({ fellBack: true, engine: 'reflex (fake)' });
    await expect(new JevEvaluationModel({ apiKey: KEY, fetch: jev.fetch }).doEvaluate({ state, questions: { go: { type: 'boolean', instructions: 'x' } } })).rejects.toThrow(
      /didn't accept the key in NOVA_JEV_API_KEY/,
    );
    await expect(new JevEvaluationModel({ apiKey: KEY, fetch: jev.fetch }).doEvaluate({ state, questions: { go: { type: 'boolean', instructions: 'x' } } })).rejects.not.toThrow(KEY);
  });

  it('falls back to Reflex when Jev is slower than the time limit', async () => {
    const engine = createDecisionEngine({ engine: 'jev', timeoutMs: 50, jevApiKey: KEY, jevFetch: fakeJev({ delayMs: 2000 }).fetch, reflex: fakeReflex });
    const d = await engine.decide(state, buildQuestions(builtinSkills, apps, 'open slack'));
    expect(d).toMatchObject({ fellBack: true, engine: 'reflex (fake)' });
  });

  it("rejects an answer that isn't one of the options, so Reflex decides instead", async () => {
    const bad = fakeJev({ body: { answers: { intent: { type: 'choice', choice: 'launch_rockets', probabilities: { launch_rockets: 1 } } } } });
    const engine = createDecisionEngine({ engine: 'jev', jevApiKey: KEY, jevFetch: bad.fetch, reflex: fakeReflex });
    const d = await engine.decide(state, { intent: { type: 'choice', instructions: 'What?', criteria: { open_app: null, chat: null } } });
    expect(d).toMatchObject({ fellBack: true, engine: 'reflex (fake)' });
    expect((d.answers as any).intent.choice).toBe('chat');
  });

  it('stands Reflex in when Jev is chosen without a key - and automatic never picks Jev', () => {
    expect(createDecisionEngine({ engine: 'jev', reflex: fakeReflex }).name).toBe('reflex (fake) (no Jev key) → heuristic');
    expect(createDecisionEngine({ engine: 'jev' }).name).toBe('heuristic (no Jev key)');
    expect(createDecisionEngine({ engine: 'auto', jevApiKey: KEY, reflex: fakeReflex }).name).toBe('reflex (fake) → heuristic');
    expect(() => new JevEvaluationModel({ apiKey: '' })).toThrow(/NOVA_JEV_API_KEY/);
  });

  it('only decides with a language model on one of the user\'s own servers', () => {
    expect(createDecisionEngine({ engine: 'llm', llmModel: 'anthropic/claude-haiku-4.5', resolveModel: () => null, reflex: fakeReflex }).name).toBe(
      "reflex (fake) (anthropic/claude-haiku-4.5 isn't a local model server) → heuristic",
    );
    expect(createDecisionEngine({ engine: 'llm', reflex: fakeReflex }).name).toBe('reflex (fake) (no decision model) → heuristic');
  });
});

describe("Jev's unsure answers go to the brain", () => {
  const unsure = (choice: string) => ({ intent: { type: 'choice' as const, choice, probabilities: { [choice]: 0.5, chat: 0.25, other: 0.25 } } });

  it('hands a doubtful skill to the brain when there is one - its probability moves to chat', () => {
    expect(handDoubtToBrain({ canThink: true }, unsure('open_app'), 0.7).intent).toEqual({ type: 'choice', choice: 'chat', probabilities: { open_app: 0, chat: 0.75, other: 0.25 } });
    expect(handDoubtToBrain({ canThink: true }, unsure('open_app'), 0.5).intent.choice).toBe('open_app'); // sure enough
  });

  it("keeps it with Nova without a brain, while Nova waits on its own question, and for replies and stopping", () => {
    expect(handDoubtToBrain({ canThink: false }, unsure('open_app'), 0.7).intent.choice).toBe('open_app');
    expect(handDoubtToBrain({ canThink: true, awaitingConfirmationFor: 'quit_app' }, unsure('open_app'), 0.7).intent.choice).toBe('open_app');
    expect(handDoubtToBrain({ canThink: true, awaitingAppFor: 'open_app' }, unsure('open_app'), 0.7).intent.choice).toBe('open_app');
    for (const choice of ['stop', 'confirm_yes', 'confirm_no', 'other']) expect(handDoubtToBrain({ canThink: true }, unsure(choice), 0.7).intent.choice).toBe(choice);
    // No chat to hand it to: left as it is.
    expect(handDoubtToBrain({ canThink: true }, { intent: { type: 'choice', choice: 'open_app', probabilities: { open_app: 0.5, other: 0.5 } } }, 0.7).intent.choice).toBe('open_app');
  });

  it('happens in the engine for Jev, on what Nova actually acts on', async () => {
    const questions = buildQuestions(builtinSkills, apps, 'open slack');
    const first = Object.keys((questions as any).intent.criteria)[0]!; // the fake picks it at 0.62
    const decide = (opts: object, st: object) => createDecisionEngine({ engine: 'jev', fallback: 'none', jevApiKey: KEY, jevFetch: fakeJev().fetch, ...opts }).decide({ ...state, ...st }, questions);
    expect(JEV_DOUBT_FLOOR).toBeGreaterThan(0.62);
    expect(((await decide({}, { canThink: true })).answers as any).intent.choice).toBe('chat');
    expect(((await decide({}, { canThink: false })).answers as any).intent.choice).toBe(first);
    expect(((await decide({ jevDoubt: 0 }, { canThink: true })).answers as any).intent.choice).toBe(first); // 0: acts on everything
  });
});

describe('a restated action is a yes', () => {
  it('reads "yes quit it" to "Quit Spotify?" as confirm_yes, and nothing else', () => {
    const restated = { intent: { type: 'choice' as const, choice: 'quit_app', probabilities: { quit_app: 0.5, confirm_yes: 0.25, confirm_no: 0.25 } } };
    expect(restatedYes({ awaitingConfirmationFor: 'quit_app' }, restated).intent).toEqual({ type: 'choice', choice: 'confirm_yes', probabilities: { quit_app: 0, confirm_yes: 0.75, confirm_no: 0.25 } });
    expect(restatedYes({ awaitingConfirmationFor: 'open_app' }, restated).intent.choice).toBe('quit_app'); // another action: a new request
    expect(restatedYes({}, restated).intent.choice).toBe('quit_app');
  });

  it('happens in the engine for Jev, with a question waiting', async () => {
    const questions = { intent: { type: 'choice' as const, instructions: 'What?', criteria: { quit_app: null, confirm_yes: null, confirm_no: null, chat: null } } };
    const engine = createDecisionEngine({ engine: 'jev', fallback: 'none', jevApiKey: KEY, jevFetch: fakeJev().fetch });
    const d = await engine.decide({ utterance: 'yes quit it', canThink: true, awaitingConfirmationFor: 'quit_app' }, questions);
    expect((d.answers as any).intent.choice).toBe('confirm_yes');
  });
});
