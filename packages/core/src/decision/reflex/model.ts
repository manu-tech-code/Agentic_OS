import { answerFromWeights, softmax } from '../distribution.ts';
import type { CallOptions, EvaluationModelV4, Question, RawAnswer, RawResult, StateInput } from '../types.ts';
import { dot, type Embedder } from './embedder.ts';
import { grammarPhrases } from './grammar.ts';
import { fingerprint, HEAD_VERSION, ReflexHead, trainHead, type HeadData, type TrainOptions } from './head.ts';
import { aliasesFor, matchName, nameTokens, type NameMatch } from './names.ts';
import { REFLEX_PHRASES } from './phrases.ts';

/**
 * Reflex: Nova's own System 1. A local stand-in for Jev tuned to Nova's questions, answering
 * in about a millisecond with no network and no language model:
 *  - names (apps, projects, agents) are matched in code, including speech-recognition slips;
 *  - intents are matched by meaning against many example phrasings, with named things masked
 *    ("pull up notes" reads as "pull up app"), plus what Nova is waiting for;
 *  - a classifier trained on thousands of phrasings weighs in on every intent;
 *  - "was that for me?" follows from the intent and the conversation state.
 * Answers are calibrated probabilities, so the Guardian's confidence thresholds keep working.
 */

type ChoiceQuestion = Extract<Question, { type: 'choice' }>;
/** One reading of the utterance: its meaning as a whole, and of its opening words. */
type Variant = { full: Float32Array; lead: Float32Array };

export interface LearnedExample {
  utterance: string;
  question: string;
  choice: string;
  /** The utterance with named things masked, as Reflex read it. */
  masked?: string[];
  at?: number;
  /** How the right answer became known: the user confirmed it, answered a follow-up, or the brain used that skill. */
  source?: 'confirmed' | 'clarified' | 'brain';
}

export interface ReflexOptions {
  embedder: Embedder;
  /** Extra phrasings by option key; defaults to Nova's own phrase bank. */
  phrases?: Record<string, string[]>;
  /** Patterns that multiply into more phrasings for the classifier; defaults to Nova's own. */
  grammar?: Record<string, string[]>;
  /** A classifier trained earlier (see `train`), when it was trained on the same data. */
  head?: HeadData | null;
  /**
   * Phrasings to leave out of everything Reflex learns from, so an evaluation measures only
   * what it hasn't seen. Compared ignoring case and punctuation, with names blanked.
   */
  holdOut?: { texts: string[]; names?: string[] };
  /** Examples confirmed in use, from earlier sessions. */
  learned?: LearnedExample[];
  /** Keep learning from confirmed decisions (default true). */
  learn?: boolean;
  /** Called with each new example, so it can be saved. */
  onLearn?: (example: LearnedExample) => void;
  /** Overrides for the tuned constants, for experiments. */
  tuning?: Partial<Tuning>;
}

interface Tuning {
  /** Softmax temperature for intents, in similarity units. */
  temperature: number;
  /** Below this similarity to every intent, the utterance probably isn't one of them. */
  otherFloor: number;
  /**
   * With a brain to hand things to (Nova says so in the state), a match must beat this to run
   * directly: a doubtful one goes to the brain, which can still use the skill as a tool.
   */
  rejectFloor: number;
  /** How many of an option's closest examples count toward its score. */
  topK: number;
  /** How much the closest example counts, against the mean of the others. */
  topWeight: number;
  /** Weight of the opening words ("who", "can you open", "tell codex to"), which carry what kind of request it is. */
  leadWeight: number;
  /** How many opening words count as the lead. */
  leadWords: number;
  /** How much the classifier's opinion counts: similarity units per unit of its log-probability. */
  headWeight: number;
  /**
   * 0: the classifier can only take away (an intent it doubts drops below the brain's floor);
   * 1: it can also lift an intent it's sure of over that floor. Measured relative to "no idea".
   */
  headCenter: number;
}

const TUNING: Tuning = { temperature: 0.04, otherFloor: 0.2, rejectFloor: 0.6, topK: 2, topWeight: 0.65, leadWeight: 0.35, leadWords: 3, headWeight: 0.08, headCenter: 0 };

const FALLBACK_KEYS = new Set(['other', 'none', 'unknown', 'no_match']);
const NAME_TEMPERATURE = 0.05;
/** Score of "no name mentioned": a match must beat this. */
const NONE_SCORE = 0.6;
/** A name this sure gets masked for intent matching. */
const MASK_SCORE = 0.85;
const MAX_LEARNED = 2000;
/** Words that show an app is being talked about as an app, so a name that's also an everyday word ("Weather") can be masked. */
const APP_CONTEXT = new Set(
  'open launch start run fire bring pull switch show get go focus load boot quit close exit kill shut terminate end dismiss use using need want wanna app application'.split(' '),
);
/** Words that open a reply and settle it, while Nova waits for a yes or no. */
const NO_WORDS = new Set(['no', 'not', 'nope', 'nah', "don't", 'dont', 'never', 'negative', 'cancel']);
const YES_WORDS = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'absolutely', 'definitely', 'affirmative']);
/** Words after a name that say it's an app. */
const APP_WORDS = new Set(['app', 'application', 'program']);
/** When masks overlap, Nova's own agents and projects win over app names. */
const MASK_PRIORITY = ['agent', 'project', 'app'];
/** Words that open an utterance without saying anything about it. */
const FILLERS = new Set(['um', 'uh', 'er', 'erm', 'hmm', 'hey', 'so', 'okay', 'ok', 'well', 'oh', 'please', 'nova']);
/**
 * Names that stand in for placeholders when training the classifier, so it also knows a
 * request whose name wasn't recognised ("open blender" when Blender isn't installed).
 */
const STAND_INS: Record<string, string[]> = {
  app: ['slack', 'spotify', 'figma', 'zoom', 'xcode', 'discord', 'telegram', 'obsidian', 'postman', 'docker', 'blender', 'photoshop', 'excel', 'outlook', 'safari', 'chrome', 'notion', 'whatsapp', 'teams', 'vs code'],
  agent: ['claude', 'codex', 'opencode', 'gemini', 'aider', 'cursor'],
  project: ['website', 'api', 'backend', 'frontend', 'mobile app', 'nova', 'agentic os', 'dashboard'],
};

interface ExemplarSet {
  keys: string[];
  vectors: Float32Array;
  leads: Float32Array;
  owner: Uint16Array;
}

/** The opening words of an utterance, past any fillers. */
function lead(text: string, n: number) {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}{}']+/u).filter(Boolean);
  let i = 0;
  while (i < words.length - 1 && FILLERS.has(words[i]!)) i++;
  return words.slice(i, i + n).join(' ');
}

interface State {
  utterance: string;
  wakeWordUsed: boolean;
  awaitingConfirmationFor: string | null;
  awaitingAppFor: string | null;
  awaitingProjectFor: string | null;
  /** Agent tasks and timers running now, when Nova says. */
  activeTasks?: number;
  activeTimers?: number;
  /** Whether a brain can take what Reflex isn't sure of. */
  canThink: boolean;
}

function readState(state: StateInput): State {
  const s = (state && typeof state === 'object' && !Array.isArray(state) ? state : { utterance: String(state ?? '') }) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const count = (v: unknown) => (typeof v === 'number' ? v : undefined);
  return {
    utterance: typeof s.utterance === 'string' ? s.utterance : JSON.stringify(state ?? ''),
    wakeWordUsed: s.wakeWordUsed === true,
    awaitingConfirmationFor: text(s.awaitingConfirmationFor),
    awaitingAppFor: text(s.awaitingAppFor),
    awaitingProjectFor: text(s.awaitingProjectFor),
    activeTasks: count(s.activeTasks),
    activeTimers: count(s.activeTimers),
    canThink: s.canThink === true,
  };
}

const toList = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const fill = (text: string) => text.replace(/\{(\w+)\}/g, '$1');

const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}{}]+/gu, ' ').trim();

/** Whether a phrasing is one of those held out: the same words, whatever names fill it. */
function heldOutCheck(hold: NonNullable<ReflexOptions['holdOut']>): (text: string) => boolean {
  const names = [...new Set([...(hold.names ?? []), ...Object.values(STAND_INS).flat(), 'app', 'agent', 'project'].map(plain).filter(Boolean))];
  names.sort((a, b) => b.length - a.length);
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join('|')})(?![\\p{L}\\p{N}])`, 'gu');
  const shape = (t: string) => plain(fill(t)).replace(re, 'x').replace(/\s+/g, ' ');
  const held = new Set(hold.texts.map(shape));
  return (text) => held.has(shape(text));
}

/** A phrasing as Reflex reads it (names masked to what they are), and once more with a real-sounding name in each placeholder. */
function readings(phrase: string, n: number): string[] {
  const masked = fill(phrase);
  if (!/\{\w+\}/.test(phrase)) return [masked];
  return [masked, phrase.replace(/\{(\w+)\}/g, (_, slot: string) => STAND_INS[slot]?.[n % STAND_INS[slot]!.length] ?? slot)];
}

/** Choice questions over names: every option is just a name, or a name and a short label. */
const isNames = (q: ChoiceQuestion) =>
  Object.entries(q.criteria).every(([key, v]) => FALLBACK_KEYS.has(key) || v == null || (typeof v === 'string' && v.trim().split(/\s+/).length <= 4));

export class ReflexEvaluationModel implements EvaluationModelV4 {
  readonly specificationVersion = 'v4' as const;
  readonly provider = 'nova';
  readonly modelId: string;
  readonly supportedQuestionTypes = ['choice', 'score', 'boolean'] as const;

  private readonly embedder: Embedder;
  private readonly phrases: Record<string, string[]>;
  private readonly grammar: Record<string, string[]>;
  private head: ReflexHead | null = null;
  private readonly heldOut: (text: string) => boolean;
  private learnedExamples: LearnedExample[];
  private readonly exemplarCache = new Map<string, ExemplarSet>();
  private readonly nameCache = new Map<string, Map<string, string[][]>>();
  /** How recent utterances were read, so a later confirmation can be learned the same way. */
  private readonly recent = new Map<string, string[]>();
  /** Vectors of example texts, so a new set of options is assembled without re-embedding. */
  private readonly vectors = new Map<string, Float32Array>();
  private version = 0;
  private readonly tuning: Tuning;

  constructor(private readonly opts: ReflexOptions) {
    this.tuning = { ...TUNING, ...opts.tuning };
    this.embedder = opts.embedder;
    this.modelId = `reflex (${opts.embedder.id})`;
    this.phrases = opts.phrases ?? REFLEX_PHRASES;
    this.grammar = opts.grammar ?? grammarPhrases();
    this.heldOut = opts.holdOut ? heldOutCheck(opts.holdOut) : () => false;
    this.learnedExamples = [...(opts.learned ?? [])].slice(-MAX_LEARNED);
    this.useHead(opts.head ?? null);
    // Embed the phrase bank up front (a few milliseconds), so even the first decision is instant.
    for (const text of Object.values(this.phrases).flat()) this.vector(fill(text));
  }

  private vector(text: string) {
    let v = this.vectors.get(text);
    if (!v) {
      v = this.embedder.embed(text);
      if (this.vectors.size > 20_000) this.vectors.clear();
      this.vectors.set(text, v);
    }
    return v;
  }

  get learned(): readonly LearnedExample[] {
    return this.learnedExamples;
  }

  /** Remember a decision the user confirmed, so similar phrasings are understood next time. */
  learn(example: LearnedExample) {
    if (this.opts.learn === false || !example.utterance.trim()) return;
    const known = this.learnedExamples.some((e) => e.utterance === example.utterance && e.question === example.question && e.choice === example.choice);
    if (known) return;
    const full = { ...example, masked: example.masked ?? this.recent.get(example.utterance), at: example.at ?? Date.now() };
    this.learnedExamples = [...this.learnedExamples, full].slice(-MAX_LEARNED);
    this.version++;
    this.opts.onLearn?.(full);
  }

  forget() {
    this.learnedExamples = [];
    this.version++;
  }

  // --- The classifier -------------------------------------------------------------------

  /** Whether a trained classifier is weighing in. */
  get trained() {
    return this.head !== null;
  }

  /** Use a classifier trained earlier, or none. One trained for another embedding model is ignored. */
  useHead(data: HeadData | null) {
    this.head = data && data.version === HEAD_VERSION && data.dim === this.embedder.dim * 2 ? new ReflexHead(data) : null;
  }

  /** Everything the classifier learns from: the phrase bank, the grammar's phrasings, and what was learned in use. */
  trainingExamples(): { text: string; label: string }[] {
    const seen = new Set<string>();
    const out: { text: string; label: string }[] = [];
    let n = 0;
    const add = (label: string, phrase: string) => {
      for (const text of readings(phrase, n++)) {
        const key = `${label}\u0000${text}`;
        if (!text.trim() || seen.has(key) || this.heldOut(text)) continue;
        seen.add(key);
        out.push({ text, label });
      }
    };
    for (const [label, list] of Object.entries(this.phrases)) for (const p of list) add(label, p);
    for (const [label, list] of Object.entries(this.grammar)) for (const p of list) add(label, p);
    for (const e of this.learnedExamples) if (e.question === 'intent') for (const t of [e.utterance, ...(e.masked ?? [])]) add(e.choice, t);
    return out;
  }

  /** A fingerprint of what the classifier would be trained on: a saved one with the same key is still current. */
  trainingKey() {
    return fingerprint(JSON.stringify([HEAD_VERSION, this.embedder.id, this.tuning.leadWords, this.trainingExamples()]));
  }

  /** Train the classifier (a second or two) and start using it. `pause` lets a server stay responsive meanwhile. */
  async train(opts: TrainOptions = {}): Promise<HeadData> {
    const examples = this.trainingExamples();
    const classes = [...new Set(examples.map((e) => e.label))];
    const at = new Map(classes.map((c, i) => [c, i]));
    const inputs: Float32Array[] = [];
    let lastPause = Date.now();
    for (const e of examples) {
      inputs.push(this.features(this.embedder.embed(e.text), this.embedder.embed(lead(e.text, this.tuning.leadWords))));
      if (opts.pause && Date.now() - lastPause > 12) {
        await opts.pause();
        lastPause = Date.now();
      }
    }
    const data = await trainHead(inputs, examples.map((e) => at.get(e.label)!), classes, opts);
    this.useHead(data);
    return data;
  }

  /** The classifier's input: the meaning of the whole utterance, then of its opening words. */
  private features(full: Float32Array, leadVector: Float32Array) {
    const x = new Float32Array(full.length * 2);
    x.set(full);
    x.set(leadVector, full.length);
    return x;
  }

  /** The classifier's opinion, added to each option's score: its log-probability (averaged over readings), in similarity units. */
  private addOpinion(keys: string[], scores: number[], variants: Variant[]) {
    const head = this.head;
    if (!head) return;
    const sums = keys.map(() => 0);
    const known = keys.map((k) => head.has(k));
    if (!known.some(Boolean)) return;
    for (const v of variants) {
      head.logProbs(this.features(v.full, v.lead), keys).forEach((p, i) => {
        if (p !== null) sums[i]! += p / variants.length;
      });
    }
    const knownSums = sums.filter((_, i) => known[i]);
    const neutral = knownSums.reduce((a, b) => a + b, 0) / knownSums.length;
    const unsure = this.tuning.headCenter * Math.log(1 / knownSums.length);
    keys.forEach((_, i) => (scores[i]! += this.tuning.headWeight * ((known[i] ? sums[i]! : neutral) - unsure)));
  }

  async doEvaluate({ state, questions }: CallOptions): Promise<RawResult> {
    const s = readState(state);
    const words = nameTokens(s.utterance);
    const answers: Record<string, RawAnswer> = {};
    const found: Record<string, NameMatch> = {};

    // Names first: they're answers in their own right, and masking them helps read the intent.
    for (const [id, q] of Object.entries(questions)) {
      if (q.type !== 'choice' || !isNames(q)) continue;
      const { answer, best } = this.names(q, words);
      answers[id] = answer;
      if (best && best.score >= MASK_SCORE && this.maskable(id, best, words)) found[id] = best;
    }

    // "Open the Claude app": a name that's both an agent and an app, said as an app, is the app.
    if (found.app && found.agent && found.app.start < found.agent.end && found.agent.start < found.app.end && APP_WORDS.has(words[found.app.end] ?? '')) delete found.agent;
    const masked = maskedTexts(words, found);
    this.remember(s.utterance, masked);
    const variants = [s.utterance, ...masked].map((t) => ({ full: this.embedder.embed(t), lead: this.embedder.embed(lead(t, this.tuning.leadWords)) }));

    // The intent as it would be without handing doubt to a brain: whether speech was meant for Nova doesn't depend on that.
    let plainIntent: RawAnswer | undefined;
    for (const [id, q] of Object.entries(questions)) {
      if (q.type !== 'choice' || answers[id]) continue;
      const { answer, plain } = this.choose(id, q, variants, s);
      answers[id] = answer;
      if (id === 'intent') plainIntent = plain;
    }
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === 'boolean') {
        answers[id] = id === 'addressed' ? this.addressed(q, s, plainIntent ?? answers.intent, found) : this.judge(q, variants);
      } else if (q.type === 'score') {
        answers[id] = this.score(q, variants);
      }
    }
    return { answers, warnings: [] };
  }

  /** An app name that's also an everyday word only counts as an app when the utterance talks about apps. */
  private maskable(category: string, m: NameMatch, words: string[]) {
    if (category !== 'app' || m.end - m.start > 1 || !this.embedder.knows?.(words[m.start]!)) return true;
    return words.some((w) => APP_CONTEXT.has(w));
  }

  private remember(utterance: string, masked: string[]) {
    this.recent.set(utterance, masked);
    if (this.recent.size > 50) this.recent.delete(this.recent.keys().next().value!);
  }

  private names(q: ChoiceQuestion, words: string[]) {
    const key = JSON.stringify(q.criteria);
    let aliases = this.nameCache.get(key);
    if (!aliases) {
      aliases = new Map(Object.entries(q.criteria).map(([name, label]) => [name, FALLBACK_KEYS.has(name) ? [] : aliasesFor(name, typeof label === 'string' ? label : null)]));
      this.nameCache.set(key, aliases);
      if (this.nameCache.size > 16) this.nameCache.delete(this.nameCache.keys().next().value!);
    }
    let best: NameMatch | null = null;
    const scores = [...aliases].map(([name, list]) => {
      if (FALLBACK_KEYS.has(name)) return NONE_SCORE;
      const m = matchName(words, list);
      if (m && (!best || m.score > best.score)) best = m;
      return m?.score ?? 0;
    });
    return { answer: answerFromWeights(q, softmax(scores, NAME_TEMPERATURE)), best: best as NameMatch | null };
  }

  /** Example phrasings for each option, embedded once per set of options (and again after learning). */
  private exemplars(id: string, criteria: Record<string, unknown>): ExemplarSet {
    const key = `${id}\u0000${this.version}\u0000${JSON.stringify(criteria)}`;
    const cached = this.exemplarCache.get(key);
    if (cached) return cached;
    const keys = Object.keys(criteria);
    const texts: string[] = [];
    const owner: number[] = [];
    keys.forEach((option, i) => {
      const own = FALLBACK_KEYS.has(option) ? [] : [option.replace(/_/g, ' '), ...toList(criteria[option])];
      const learned = this.learnedExamples.filter((e) => e.question === id && e.choice === option).flatMap((e) => [e.utterance, ...(e.masked ?? [])]);
      for (const text of new Set([...own, ...(this.phrases[option] ?? []), ...learned].map(fill))) {
        if (this.heldOut(text)) continue;
        texts.push(text);
        owner.push(i);
      }
    });
    const dim = this.embedder.dim;
    const vectors = new Float32Array(texts.length * dim);
    const leads = new Float32Array(texts.length * dim);
    texts.forEach((t, i) => {
      vectors.set(this.vector(t), i * dim);
      leads.set(this.vector(lead(t, this.tuning.leadWords)), i * dim);
    });
    const set = { keys, vectors, leads, owner: Uint16Array.from(owner) };
    this.exemplarCache.set(key, set);
    if (this.exemplarCache.size > 16) this.exemplarCache.delete(this.exemplarCache.keys().next().value!);
    return set;
  }

  /** Each option's score: the mean of its closest examples, taking the best reading of the utterance. */
  private optionScores(set: ExemplarSet, variants: Variant[]): number[] {
    const dim = this.embedder.dim;
    const { topK, topWeight, leadWeight } = this.tuning;
    const scores = set.keys.map(() => -1);
    for (const v of variants) {
      const top = set.keys.map(() => [] as number[]);
      for (let i = 0; i < set.owner.length; i++) {
        const t = top[set.owner[i]!]!;
        const sim = (1 - leadWeight) * dot(v.full, set.vectors, i * dim) + leadWeight * dot(v.lead, set.leads, i * dim);
        if (t.length < topK) t.push(sim);
        else {
          const min = t.indexOf(Math.min(...t));
          if (sim > t[min]!) t[min] = sim;
        }
      }
      top.forEach((t, i) => {
        if (!t.length) return;
        t.sort((a, b) => b - a);
        const rest = t.length > 1 ? t.slice(1).reduce((a, b) => a + b, 0) / (t.length - 1) : t[0]!;
        scores[i] = Math.max(scores[i]!, topWeight * t[0]! + (1 - topWeight) * rest);
      });
    }
    return scores;
  }

  /** A choice among intents: the answer, and the same answer without doubt handed to a brain (`plain`). */
  private choose(id: string, q: ChoiceQuestion, variants: Variant[], s: State): { answer: RawAnswer; plain: RawAnswer } {
    const set = this.exemplars(id, q.criteria as Record<string, unknown>);
    const scores = this.optionScores(set, variants);
    const best = Math.max(...scores.filter((_, i) => !FALLBACK_KEYS.has(set.keys[i]!)));
    this.addOpinion(set.keys, scores, variants);
    const at = (option: string) => set.keys.indexOf(option);
    set.keys.forEach((option, i) => {
      // A reply is expected: yes, no or stop are likelier.
      if (s.awaitingConfirmationFor && (option === 'confirm_yes' || option === 'confirm_no' || option === 'stop')) scores[i]! += 0.08;
      // Nothing running to cancel: "cancel" and "stop" mean stop.
      if ((option === 'cancel_task' && s.activeTasks === 0) || (option === 'cancel_timer' && s.activeTimers === 0)) scores[i]! -= 0.25;
    });
    // Waiting for a yes or no, the first word usually settles it ("not right now", "sure, go on").
    if (s.awaitingConfirmationFor) {
      const first = s.utterance.toLowerCase().match(/[a-z']+/)?.[0] ?? '';
      const answer = NO_WORDS.has(first) ? at('confirm_no') : YES_WORDS.has(first) ? at('confirm_yes') : -1;
      if (answer >= 0) scores[answer]! += 0.1;
    }
    // Asked "Quit Spotify?", "yes quit it" or "close it" restates the action: that's a yes.
    const pending = s.awaitingConfirmationFor ? at(s.awaitingConfirmationFor) : -1;
    const yes = at('confirm_yes');
    if (pending >= 0 && yes >= 0) {
      scores[yes] = Math.max(scores[yes]!, scores[pending]!);
      scores[pending]! -= 0.1;
    }
    // Nothing close enough: probably none of these. With a brain to hand it to, a doubtful match goes there too -
    // the brain can still use the skill as a tool, while a wrong skill does the wrong thing.
    const floored = (floor: number) => scores.map((v, i) => (FALLBACK_KEYS.has(set.keys[i]!) ? Math.max(v, floor) : v));
    const plainFloor = best < this.tuning.otherFloor ? this.tuning.otherFloor : -1;
    const plain = answerFromWeights(q, softmax(floored(plainFloor), this.tuning.temperature));
    if (!s.canThink) return { answer: plain, plain };
    return { answer: answerFromWeights(q, softmax(floored(Math.max(plainFloor, this.tuning.rejectFloor)), this.tuning.temperature)), plain };
  }

  /** Whether an utterance was meant for Nova, from what it seems to be and what Nova is waiting for. */
  private addressed(q: Question, s: State, intent: RawAnswer | undefined, found: Record<string, NameMatch>): RawAnswer {
    const yes = (p: number) => answerFromWeights(q, [1 - p, p]);
    if (s.wakeWordUsed) return yes(0.97);
    const p = intent?.type === 'choice' ? (intent.probabilities ?? {}) : {};
    const reply = (p.confirm_yes ?? 0) + (p.confirm_no ?? 0) + (p.stop ?? 0);
    if (s.awaitingConfirmationFor && reply >= 0.5) return yes(0.95);
    if ((s.awaitingAppFor && found.app) || (s.awaitingProjectFor && found.project)) return yes(0.93);
    const other = p.other ?? 0;
    const chat = p.chat ?? 0;
    return yes(Math.min(0.98, Math.max(0.02, 0.95 * (1 - other - chat) + 0.7 * chat + 0.1 * other)));
  }

  /** Any other yes/no question: which side's description the utterance is closer to. */
  private judge(q: Extract<Question, { type: 'boolean' }>, variants: Variant[]): RawAnswer {
    const set = this.exemplars('\u0000boolean', { false: toList(q.criteria?.false), true: toList(q.criteria?.true) });
    const [f, t] = this.optionScores(set, variants) as [number, number];
    return answerFromWeights(q, f < 0 && t < 0 ? [0.5, 0.5] : softmax([f, t], this.tuning.temperature * 2));
  }

  private score(q: Extract<Question, { type: 'score' }>, variants: Variant[]): RawAnswer {
    const criteria = Object.fromEntries(q.criteria.map((level, i) => [String(i), toList(level)]));
    const scores = this.optionScores(this.exemplars('\u0000score', criteria), variants);
    return answerFromWeights(q, softmax(scores, this.tuning.temperature * 2));
  }
}

/** The utterance with each confidently found name replaced by what it is ("app"), one at a time and all together. */
function maskedTexts(words: string[], found: Record<string, NameMatch>): string[] {
  const rank = (category: string) => (MASK_PRIORITY.includes(category) ? MASK_PRIORITY.indexOf(category) : MASK_PRIORITY.length);
  const masks: (NameMatch & { word: string })[] = [];
  for (const [category, m] of Object.entries(found).sort((a, b) => rank(a[0]) - rank(b[0]))) {
    if (masks.some((k) => m.start < k.end && k.start < m.end)) continue; // the same words, already read as something more specific
    masks.push({ word: /^[a-z]+$/.test(category) ? category : 'thing', ...m });
  }
  const apply = (list: typeof masks) => {
    const out = [...words];
    for (const m of [...list].sort((a, b) => b.start - a.start)) out.splice(m.start, m.end - m.start, m.word);
    return out.join(' ');
  };
  const texts = masks.map((m) => apply([m]));
  if (masks.length > 1) texts.push(apply(masks));
  return [...new Set(texts)];
}
