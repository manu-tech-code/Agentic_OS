import { describe, expect, it } from 'vitest';
import {
  agentSkills,
  aliasesFor,
  buildQuestions,
  builtinSkills,
  createDecisionEngine,
  EvaluationDecisionEngine,
  expand,
  HeuristicEvaluationModel,
  matchName,
  handsSkills,
  initiativeSkills,
  memorySkills,
  trustSkills,
  nameTokens,
  NovaBrain,
  readSafetensor,
  REFLEX_PHRASES,
  ReflexEvaluationModel,
  WordPieceTokenizer,
  type DecisionExample,
  type Embedder,
  type Platform,
} from '../src/index.ts';
import { normalise } from '../src/decision/reflex/embedder.ts';

/** A stand-in embedding model: hashed bag of words, so similarity is word overlap. */
class BagEmbedder implements Embedder {
  readonly id = 'bag';
  readonly dim = 1024;
  embed(text: string) {
    const v = new Float32Array(this.dim);
    for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let h = 2166136261;
      for (const ch of w) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
      v[h % this.dim]! += 1;
    }
    return normalise(v);
  }
}

const skills = [...builtinSkills, ...agentSkills, ...memorySkills.filter((m) => !m.toolOnly), ...initiativeSkills, ...trustSkills, ...handsSkills];
const APPS = ['Notes', 'Spotify', 'Figma', 'Visual Studio Code', 'Google Chrome', 'zoom.us', 'Weather', 'FindMy'];
const host = { agents: [{ name: 'claude', label: 'Claude' }, { name: 'codex', label: 'Codex' }], projects: ['website'] } as never;

async function decide(model: ReflexEvaluationModel, utterance: string, state: Record<string, unknown> = {}) {
  const { answers } = await model.doEvaluate({ state: { utterance, wakeWordUsed: true, ...state }, questions: buildQuestions(skills, APPS, utterance, host) } as never);
  return answers as Record<string, any>;
}

describe('Reflex building blocks', () => {
  it('tokenizes like BERT: lower case, no accents, word pieces, punctuation apart, unknown words dropped', () => {
    const tokenizer = new WordPieceTokenizer({
      model: { type: 'WordPiece', vocab: { '[UNK]': 0, open: 1, spot: 2, '##ify': 3, '!': 4, cafe: 5 }, unk_token: '[UNK]' },
      normalizer: { lowercase: true },
    });
    expect(tokenizer.encode('Open Spotify!')).toEqual([1, 2, 3, 4]);
    expect(tokenizer.encode('Café xyz')).toEqual([5]);
  });

  it('reads float tensors from safetensors', () => {
    const header = new TextEncoder().encode(JSON.stringify({ embeddings: { dtype: 'F32', shape: [2, 2], data_offsets: [0, 16] } }));
    const bytes = new Uint8Array(8 + header.length + 16);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(header.length), true);
    bytes.set(header, 8);
    bytes.set(new Uint8Array(Float32Array.from([1, 0, 0.5, 2]).buffer), 8 + header.length);
    const t = readSafetensor(bytes, 'embeddings');
    expect(t.shape).toEqual([2, 2]);
    expect([...t.data]).toEqual([1, 0, 0.5, 2]);
  });

  it('reads the same tensor from a real Node Buffer (its #slice shares memory, unlike Uint8Array#slice, and starts at a nonzero offset)', () => {
    const header = new TextEncoder().encode(JSON.stringify({ embeddings: { dtype: 'F32', shape: [2, 2], data_offsets: [0, 16] } }));
    const bytes = new Uint8Array(8 + header.length + 16);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(header.length), true);
    bytes.set(header, 8);
    bytes.set(new Uint8Array(Float32Array.from([1, 0, 0.5, 2]).buffer), 8 + header.length);
    const t = readSafetensor(Buffer.from(bytes), 'embeddings');
    expect(t.shape).toEqual([2, 2]);
    expect([...t.data]).toEqual([1, 0, 0.5, 2]);
  });

  it("rejects a tensor whose declared shape doesn't match its byte range", () => {
    const header = new TextEncoder().encode(JSON.stringify({ embeddings: { dtype: 'F32', shape: [3, 2], data_offsets: [0, 16] } })); // says 6 numbers, only 4 are there
    const bytes = new Uint8Array(8 + header.length + 16);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(header.length), true);
    bytes.set(header, 8);
    bytes.set(new Uint8Array(Float32Array.from([1, 0, 0.5, 2]).buffer), 8 + header.length);
    expect(() => readSafetensor(bytes, 'embeddings')).toThrow(/embeddings/);
  });

  it('finds names the way speech recognition hears them', () => {
    const find = (u: string, name: string) => matchName(nameTokens(u), aliasesFor(name))?.score ?? 0;
    expect(nameTokens('zoom.us')).toEqual(['zoom', 'us']);
    expect(find('start zoom', 'zoom.us')).toBe(1);
    expect(find('switch to chrome', 'Google Chrome')).toBe(1);
    expect(find('open vs code', 'Visual Studio Code')).toBe(1);
    expect(find('open fig ma', 'Figma')).toBeCloseTo(0.97);
    expect(find('launch spotfy', 'Spotify')).toBeGreaterThan(0.7);
    expect(find('open visual studio', 'Visual Studio Code')).toBeGreaterThan(0.75);
    expect(find('what time is it', 'Time Machine')).toBe(0);
  });

  it("doesn't turn a vendor-trimmed name into a bare function-word alias", () => {
    const find = (u: string, name: string) => matchName(nameTokens(u), aliasesFor(name))?.score ?? 0;
    // "Microsoft To Do" trimmed of its vendor is just "to do" - not a usable alias on its own.
    expect(find('i need to do the dishes', 'Microsoft To Do')).toBe(0);
    expect(find('open microsoft to do', 'Microsoft To Do')).toBe(1); // the full name still matches
  });

  it('keeps a bare-minimum near-miss no more convincing than no name at all', () => {
    const find = (u: string, name: string) => matchName(nameTokens(u), aliasesFor(name))?.score ?? 0;
    // "black" is one edit from "slack" - just barely over the near-miss floor, so alone it should be
    // no likelier than no name being said (NONE_SCORE is 0.6), unlike a stronger near-miss ("spotfy").
    expect(find('explain black holes', 'Slack')).toBeCloseTo(0.6, 5);
    expect(find('launch spotfy', 'Spotify')).toBeGreaterThan(0.75);
  });

  it('has phrasings for every skill', () => {
    for (const s of skills) expect(REFLEX_PHRASES[s.id]?.length, s.id).toBeGreaterThan(10);
  });
});

describe('Reflex decisions', () => {
  it('reads intents with named things masked, and answers the names', async () => {
    const reflex = new ReflexEvaluationModel({ embedder: new BagEmbedder() });
    const a = await decide(reflex, 'pull up notes');
    expect(a.intent.choice).toBe('open_app');
    expect(a.app.choice).toBe('Notes');
    const t = await decide(reflex, 'ask codex to fix the tests in the website');
    expect(t.intent.choice).toBe('agent_task');
    expect([t.agent.choice, t.project.choice]).toEqual(['codex', 'website']);
  });

  it('hands a doubtful match to the brain when there is one', async () => {
    const reflex = new ReflexEvaluationModel({ embedder: new BagEmbedder() });
    const vague = 'in my current project right i want to';
    expect((await decide(reflex, vague, { canThink: true })).intent.choice).toBe('other');
    expect((await decide(reflex, 'open slack', { canThink: true })).intent.choice).toBe('open_app'); // clear commands still run directly
  });

  it('uses what Nova is waiting for and what is running', async () => {
    const reflex = new ReflexEvaluationModel({ embedder: new BagEmbedder() });
    expect((await decide(reflex, 'yes quit it', { awaitingConfirmationFor: 'quit_app' })).intent.choice).toBe('confirm_yes');
    expect((await decide(reflex, 'cancel', { activeTimers: 0, activeTasks: 0 })).intent.choice).toBe('stop');
  });

  it("only penalises cancel_timer/cancel_task when it's actually known there's nothing running, not when that's just unknown", async () => {
    const reflex = new ReflexEvaluationModel({ embedder: new BagEmbedder() });
    // activeTimers omitted (unknown): not penalised - a caller that doesn't track it must say so honestly, not send a stale 0.
    expect((await decide(reflex, 'kill the timer')).intent.choice).toBe('cancel_timer');
    // activeTimers really is 0: penalised away from cancel_timer instead.
    expect((await decide(reflex, 'kill the timer', { activeTimers: 0 })).intent.choice).not.toBe('cancel_timer');
  });

  it('decides whether speech was meant for Nova', async () => {
    const reflex = new ReflexEvaluationModel({ embedder: new BagEmbedder() });
    expect((await decide(reflex, 'and then he went back to the office', { wakeWordUsed: false })).addressed.probability).toBeLessThan(0.5);
    expect((await decide(reflex, 'open spotify', { wakeWordUsed: false })).addressed.probability).toBeGreaterThan(0.5);
    expect((await decide(reflex, 'and then he went back to the office')).addressed.probability).toBeGreaterThan(0.9); // the wake word was said
  });

  it("doesn't read an everyday word as an app unless apps are being talked about", async () => {
    const reflex = new ReflexEvaluationModel({ embedder: { ...new BagEmbedder(), id: 'bag', dim: 1024, embed: new BagEmbedder().embed, knows: (w) => w === 'weather' } });
    expect((await decide(reflex, 'the weather today will be sunny', { wakeWordUsed: false })).intent.choice).not.toBe('open_app');
    expect((await decide(reflex, 'open weather')).intent.choice).toBe('open_app');
  });

  it('does the same for several everyday words together (FindMy read as "find my"), not just a single one', async () => {
    const embedder = { ...new BagEmbedder(), id: 'bag', dim: 1024, embed: new BagEmbedder().embed, knows: (w: string) => ['find', 'my'].includes(w) };
    const reflex = new ReflexEvaluationModel({ embedder });
    // "need" alone isn't a strong enough app-opening signal for a multi-word everyday-word span: whether
    // "FindMy" is even a candidate app must make no difference, since it's never masked in without a
    // clearer app-opening word - unlike before this fix, when any 2+ word span skipped the guard entirely.
    const u = 'i need to find my passport';
    const withCandidate = await decide(reflex, u);
    const { answers: withoutCandidate } = await reflex.doEvaluate({ state: { utterance: u, wakeWordUsed: true }, questions: buildQuestions(skills, [], u, host) } as never);
    expect(withCandidate.intent.probabilities.open_app).toBeCloseTo((withoutCandidate as never as typeof withCandidate).intent.probabilities.open_app, 5);
    expect((await decide(reflex, 'open find my')).intent.choice).toBe('open_app'); // a clearer command still works
    expect((await decide(reflex, 'open find my')).app.choice).toBe('FindMy');
  });

  it('learns what the user confirmed, and can forget it', async () => {
    const saved: DecisionExample[] = [];
    const reflex = new ReflexEvaluationModel({ embedder: new BagEmbedder(), onLearn: (e) => saved.push(e) });
    expect((await decide(reflex, 'abracadabra')).intent.choice).not.toBe('tell_time');
    reflex.learn({ utterance: 'abracadabra', question: 'intent', choice: 'tell_time' });
    const after = await decide(reflex, 'abracadabra');
    expect(after.intent.choice).toBe('tell_time');
    expect(after.intent.probabilities.tell_time).toBeGreaterThan(0.9);
    expect(saved).toHaveLength(1);
    reflex.forget();
    expect(reflex.learned).toHaveLength(0);
  });

  it('drops the trained classifier when forgetting, not just the learned examples', async () => {
    const opts = {
      embedder: new BagEmbedder(),
      learn: true,
      phrases: { tell_time: ['what time is it'], chat: ['what is the capital of france'], other: ['the kids are asleep'] },
      grammar: {},
    };
    const reflex = new ReflexEvaluationModel(opts);
    reflex.learn({ utterance: 'abracadabra', question: 'intent', choice: 'tell_time' });
    await reflex.train({ epochs: 40 });
    expect(reflex.trained).toBe(true);
    expect((await decide(reflex, 'abracadabra')).intent.choice).toBe('tell_time');
    reflex.forget();
    // The classifier was trained on what was just forgotten - it can't be left deciding from it.
    expect(reflex.trained).toBe(false);
  }, 20_000);

  it("matches an option by name even when another option's label is too long to be one itself", async () => {
    const reflex = new ReflexEvaluationModel({ embedder: new BagEmbedder() });
    const longHost = {
      agents: [{ name: 'claude', label: 'Claude' }, { name: 'longbot', label: 'My Very Long Custom Agent Label, Written As A Sentence' }],
      projects: [],
    } as never;
    const u = 'get claud to fix the build'; // "claud" is a common mishearing of "claude"
    const { answers } = await reflex.doEvaluate({ state: { utterance: u, wakeWordUsed: true }, questions: buildQuestions(skills, APPS, u, longHost) } as never);
    expect((answers as Record<string, any>).agent.choice).toBe('claude');
  });
});

describe('Reflex in the engine and the brain', () => {
  it('is the automatic choice when installed, and hears what was confirmed', () => {
    const reflex = new ReflexEvaluationModel({ embedder: new BagEmbedder() });
    const engine = createDecisionEngine({ engine: 'auto', reflex });
    expect(engine.name).toBe('reflex (bag) → heuristic');
    engine.learn?.({ utterance: 'banish spotify', question: 'intent', choice: 'quit_app' });
    expect(reflex.learned).toHaveLength(1);
    expect(createDecisionEngine({ engine: 'reflex', fallback: 'none' }).name).toBe('heuristic (Reflex not installed)');
    // Automatic never sends what's said anywhere, key or not: Jev decides only when it's chosen.
    expect(createDecisionEngine({ engine: 'auto', jevApiKey: 'k' }).name).toBe('heuristic');
  });

  it('teaches the engine when the user confirms an action', async () => {
    const learned: DecisionExample[] = [];
    const engine = new EvaluationDecisionEngine({ name: 'heuristic', model: new HeuristicEvaluationModel() });
    engine.learn = (e) => void learned.push(e);
    const platform: Platform = { listApps: async () => ['Spotify'], openApp: async () => {}, quitApp: async () => {}, now: () => new Date() };
    const nova = new NovaBrain({ engine, platform, emit: () => {} });
    await nova.init();
    await nova.handle('nova quit spotify');
    await nova.handle('yes');
    expect(learned).toEqual([{ utterance: 'quit spotify', question: 'intent', choice: 'quit_app', source: 'confirmed' }]);
  });
});

describe("Reflex's classifier", () => {
  it('multiplies patterns into phrasings, the same way every time', () => {
    expect(expand('[open|launch] {app} [|please]')).toEqual(['open {app}', 'launch {app}', 'open {app} please', 'launch {app} please']);
    const sample = expand('[a|b|c|d] [e|f|g|h] [i|j|k|l]', 10, 3);
    expect(sample).toHaveLength(10);
    expect(expand('[a|b|c|d] [e|f|g|h] [i|j|k|l]', 10, 3)).toEqual(sample);
  });

  it('learns from phrasings the example search never sees, and can do without', async () => {
    const opts = {
      embedder: new BagEmbedder(),
      learn: false,
      phrases: { open_app: ['open {app}', 'launch {app}'], tell_time: ['what time is it'], chat: ['what is the capital of france'], other: ['the kids are asleep'] },
      grammar: {
        open_app: ['[kick off|boot up|get going] {app} [|now|please|for me]'],
        chat: ['[what is|explain|tell me about] [gravity|jazz|a volcano|inflation]'],
        other: ['[he|she|they] [said|went|told me] [it was fine|to the market|about it]'],
      },
    };
    const reflex = new ReflexEvaluationModel(opts);
    const before = (await decide(reflex, 'kick off spotify')).intent.probabilities.open_app;
    const key = reflex.trainingKey();
    expect(reflex.trained).toBe(false);
    const head = await reflex.train({ epochs: 40 });
    expect(reflex.trained).toBe(true);
    expect(head.classes).toEqual(expect.arrayContaining(['open_app', 'chat', 'other']));
    expect((await decide(reflex, 'kick off spotify')).intent.probabilities.open_app).toBeGreaterThan(before);

    reflex.useHead(null);
    expect((await decide(reflex, 'kick off spotify')).intent.probabilities.open_app).toBeCloseTo(before);
    reflex.useHead({ ...head, dim: 3 }); // trained for another embedding model
    expect(reflex.trained).toBe(false);

    // A saved classifier is current only while the training data is the same.
    expect(new ReflexEvaluationModel(opts).trainingKey()).toBe(key);
    const learner = new ReflexEvaluationModel({ ...opts, learn: true });
    learner.learn({ utterance: 'wake up spotify', question: 'intent', choice: 'open_app', source: 'brain' });
    expect(learner.trainingKey()).not.toBe(key);
    expect(learner.trainingExamples()).toContainEqual({ text: 'wake up spotify', label: 'open_app' });
  });

  it('leaves held-out phrasings out of what it learns from, whatever names fill them', () => {
    const texts = (m: ReflexEvaluationModel) => new Set(m.trainingExamples().map((e) => e.text));
    const all = texts(new ReflexEvaluationModel({ embedder: new BagEmbedder() }));
    expect(all.has('fire up app')).toBe(true);
    const held = texts(new ReflexEvaluationModel({ embedder: new BagEmbedder(), holdOut: { texts: ['fire up spotify'], names: ['Spotify'] } }));
    expect(held.has('fire up app')).toBe(false);
    expect([...held].some((t) => /^fire up \w+$/.test(t))).toBe(false);
    expect(held.has('open app')).toBe(true);
  });

  it('also leaves out near-copies of a held-out phrasing that only add or drop a filler word', () => {
    // this.grammar/this.phrases hold literal phrasings (as grammarPhrases() would produce), not raw
    // "$pre ... [a|b]" patterns - expand the pattern first, the way grammarPhrases() does.
    const opts = {
      embedder: new BagEmbedder(),
      phrases: {},
      grammar: { cancel_timer: expand('$pre cancel the timer $post', 150, 1) },
      holdOut: { texts: ['cancel the timer'], names: [] as string[] },
    };
    const texts = (m: ReflexEvaluationModel) => new Set(m.trainingExamples().map((e) => e.text));
    const withoutHoldOut = texts(new ReflexEvaluationModel({ ...opts, holdOut: undefined }));
    expect(withoutHoldOut.has('cancel the timer')).toBe(true);
    expect(withoutHoldOut.has('please cancel the timer now')).toBe(true);
    const held = texts(new ReflexEvaluationModel(opts));
    expect(held.has('cancel the timer')).toBe(false); // the exact held-out text
    expect(held.has('please cancel the timer now')).toBe(false); // the same words plus only fillers
  });

  it("keys the classifier cache to the model's exact identity, not just its (unchanging) name", () => {
    const embedder = new BagEmbedder();
    const a = new ReflexEvaluationModel({ embedder, modelKey: 'bag@rev1' });
    const b = new ReflexEvaluationModel({ embedder, modelKey: 'bag@rev2' });
    expect(a.trainingKey()).not.toBe(b.trainingKey()); // same embedder.id ("bag"), a different exact model
    const c = new ReflexEvaluationModel({ embedder });
    const d = new ReflexEvaluationModel({ embedder });
    expect(c.trainingKey()).toBe(d.trainingKey()); // no modelKey given: falls back to embedder.id, still stable
  });
});
