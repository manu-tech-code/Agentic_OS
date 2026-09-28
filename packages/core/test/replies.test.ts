import { describe, expect, it } from 'vitest';
import { buildQuestions, builtinSkills, createDecisionEngine, readReply, replySays, saysNo, settleReplies, trustSkills, type EvaluationModelV4, type RawResult, type StateInput } from '../src/index.ts';

/** An engine that always picks `choice` for the intent, sure of it as `p`. */
const picking = (choice: string, p = 0.9): EvaluationModelV4 => ({
  specificationVersion: 'v4',
  provider: 'test',
  modelId: 'picking',
  supportedQuestionTypes: ['choice', 'score', 'boolean'],
  async doEvaluate({ questions }): Promise<RawResult> {
    const answers: RawResult['answers'] = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type !== 'choice') answers[id] = q.type === 'score' ? { type: 'score', score: 0 } : { type: 'boolean', probability: 0.9 };
      else if (id !== 'intent') answers[id] = { type: 'choice', choice: 'none' };
      else {
        const keys = Object.keys(q.criteria);
        answers[id] = { type: 'choice', choice, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? p : (1 - p) / (keys.length - 1)])) };
      }
    }
    return { answers, warnings: [] };
  },
});

describe('replies, read in code', () => {
  it('reads a whole reply from its lists, whatever opens or closes it', () => {
    for (const yes of ['yes', 'Okay.', 'okay', 'um, yes please', 'sure thing', "that's right", 'Affirmative!', 'alright do it', 'of course go ahead', 'okay, sounds good', 'do that'])
      expect(readReply(yes, false), yes).toBe('confirm_yes');
    for (const no of ['no', 'nah', 'absolutely not', 'I said no.', "don't do anything", "cancel, don't do it", 'hold off', 'not now', 'no thanks'])
      expect(readReply(no, false), no).toBe('confirm_no');
    for (const stop of ['never mind', 'never mind that', 'cut it out', "that's fine, you can stop", 'hold it'])
      expect(readReply(stop, false), stop).toBe('stop');
  });

  it('reads some only while Nova waits for an answer - and a short reply by its words', () => {
    expect(readReply('right', false)).toBeNull(); // on its own, just talk
    expect(readReply('right', true)).toBe('confirm_yes');
    expect(readReply('wait', true)).toBe('confirm_no');
    expect(replySays('wait, no, keep it open')).toBe('confirm_no');
    expect(replySays('sure, but not now')).toBe('confirm_no');
    expect(replySays('yes quit it')).toBe('confirm_yes');
    expect(replySays('yeah close it')).toBe('confirm_yes');
    expect(replySays('no problem, go ahead')).toBeNull(); // a no that says yes: left to the engine
    expect(replySays('stop everything')).toBeNull(); // a request of its own
    expect(replySays('open safari and play some music for me please now')).toBeNull(); // more than a reply
  });

  it('knows a no when it hears one - and the ways a no says yes', () => {
    expect(saysNo("sure... no, don't")).toBe(true);
    expect(saysNo('absolutely not')).toBe(true);
    expect(saysNo('no problem')).toBe(false);
    expect(saysNo('why not')).toBe(false);
    expect(saysNo('go ahead')).toBe(false);
  });

  it('settles any engine’s answer: a reply for sure wins, a yes that says no is a no, and an app being asked for is left alone', async () => {
    const questions = buildQuestions([...builtinSkills, ...trustSkills], ['Notes', 'Safari'], 'okay');
    // An engine that took a lone "okay" for "stop" while Nova asked "Quit Spotify?" - that would leave it running.
    const stop = createDecisionEngine({ engine: 'reflex', fallback: 'none', reflex: picking('stop') });
    const okay = await stop.decide({ utterance: 'okay', awaitingConfirmationFor: 'quit_app' }, questions);
    expect(okay.answers.intent).toMatchObject({ choice: 'confirm_yes', probabilities: { confirm_yes: 0.97 } });
    // And one that took "absolutely not" for a yes - that would quit it.
    const yes = createDecisionEngine({ engine: 'reflex', fallback: 'none', reflex: picking('confirm_yes') });
    const intentOf = async (engine: ReturnType<typeof createDecisionEngine>, state: StateInput) => ((await engine.decide(state, questions)).answers.intent as { choice: string }).choice;
    expect(await intentOf(yes, { utterance: 'absolutely not', awaitingConfirmationFor: 'quit_app' })).toBe('confirm_no');
    expect(await intentOf(yes, { utterance: 'wait, no, keep it open', awaitingConfirmationFor: 'quit_app' })).toBe('confirm_no');
    expect(await intentOf(yes, { utterance: "yes, but don't close the other one" })).toBe('confirm_no');
    expect(await intentOf(yes, { utterance: 'go ahead' })).toBe('confirm_yes');
    // "Quit Spotify?" - "yes quit it", heard as the action again or as a no: a yes, by its words.
    for (const heard of ['quit_app', 'confirm_no']) {
      const engine = createDecisionEngine({ engine: 'reflex', fallback: 'none', reflex: picking(heard) });
      expect(await intentOf(engine, { utterance: 'yes quit it', awaitingConfirmationFor: 'quit_app' }), heard).toBe('confirm_yes');
    }
    // A request of its own, said while Nova waits, stays one.
    const everything = createDecisionEngine({ engine: 'reflex', fallback: 'none', reflex: picking('stop_everything') });
    expect(await intentOf(everything, { utterance: 'nova stop everything', awaitingConfirmationFor: 'agent_step' })).toBe('stop_everything');
    // Anything else is the engine's to decide.
    const open = createDecisionEngine({ engine: 'reflex', fallback: 'none', reflex: picking('open_app') });
    expect(await intentOf(open, { utterance: 'open safari' })).toBe('open_app');
    // "Which app?" - "no, notes": an answer about the app, not a reply.
    const slot = { intent: { type: 'choice', choice: 'open_app', probabilities: { open_app: 0.8, confirm_no: 0.2 } } } as const;
    expect(settleReplies({ utterance: 'no', awaitingAppFor: 'open_app' }, slot)).toBe(slot);
    // A reply the question doesn't offer isn't forced on it.
    const narrow = { intent: { type: 'choice', choice: 'open_app', probabilities: { open_app: 0.9, chat: 0.1 } } } as const;
    expect(settleReplies({ utterance: 'yes' }, narrow)).toBe(narrow);
  });
});
