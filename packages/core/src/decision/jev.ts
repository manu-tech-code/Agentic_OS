import type { CallOptions, EvaluationModelV4, Question, RawAnswer, RawResult } from './types.ts';

/** TypeSafe's System One endpoint, where Jev answers. */
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
/** The current stable release; `jev-preview` or a pinned version (`jev-1.13.0`) work too. */
export const JEV_DEFAULT_MODEL = 'jev-latest';

export interface JevOptions {
  /** NOVA_JEV_API_KEY. A secret: it goes to TypeSafe in the Authorization header and nowhere else. */
  apiKey: string;
  model?: string;
  url?: string;
  /** For tests. */
  fetch?: typeof fetch;
}

/** Jev said no, or couldn't answer: the engine falls back. Never carries the key. */
export class JevError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'JevError';
  }
}

/**
 * Jev, TypeSafe's System One model, called directly (`POST /v1/systemone`, the key as a Bearer
 * token). Its questions and answers are the AI SDK's evaluation spec but for one name - `boolean`
 * is Jev's `noul` - so this only translates. Only the DecisionEngine uses it: Nova never calls Jev
 * anywhere else.
 */
export class JevEvaluationModel implements EvaluationModelV4 {
  readonly specificationVersion = 'v4' as const;
  readonly provider = 'typesafe';
  readonly supportedQuestionTypes = ['choice', 'score', 'boolean'] as const;
  readonly modelId: string;
  private readonly apiKey: string;
  private readonly url: string;
  private readonly fetch: typeof fetch;

  constructor(opts: JevOptions) {
    if (!opts.apiKey) throw new JevError('Jev needs NOVA_JEV_API_KEY in .env.', null);
    this.apiKey = opts.apiKey;
    this.modelId = opts.model || JEV_DEFAULT_MODEL;
    this.url = opts.url ?? JEV_URL;
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  async doEvaluate({ state, questions, abortSignal, headers }: CallOptions): Promise<RawResult> {
    const body = { model: this.modelId, state, questions: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, toJev(q)])) };
    const extra = Object.fromEntries(Object.entries(headers ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'));
    let res: Response;
    try {
      res = await this.fetch(this.url, {
        method: 'POST',
        headers: { ...extra, authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: abortSignal,
      });
    } catch (e) {
      if (abortSignal?.aborted) throw e; // out of time: the engine's own timeout, as it is
      throw new JevError(`Couldn't reach Jev: ${(e as Error).message}`, null);
    }
    if (!res.ok) throw new JevError(await failure(res), res.status);
    const data = (await res.json().catch(() => null)) as JevResponse | null;
    if (!data || typeof data.answers !== 'object' || data.answers === null) throw new JevError('Jev sent back something that isn\'t an answer.', res.status);

    const answers: Record<string, RawAnswer> = {};
    const confidence: Record<string, number> = {};
    for (const [id, q] of Object.entries(questions)) {
      const a = data.answers[id];
      if (!a) throw new JevError(`Jev didn't answer "${id}".`, res.status);
      answers[id] = fromJev(id, q, a);
      if (typeof a.confidence === 'number' && Number.isFinite(a.confidence)) confidence[id] = a.confidence;
    }
    return {
      answers,
      usage: { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens },
      warnings: [],
      providerMetadata: { typesafe: { confidence, model: data.model ?? this.modelId } },
      response: { modelId: data.model ?? this.modelId },
    };
  }
}

interface JevAnswer {
  type?: string;
  choice?: unknown;
  score?: unknown;
  noul?: unknown;
  probabilities?: Record<string, unknown>;
  confidence?: unknown;
}
interface JevResponse {
  model?: string;
  answers: Record<string, JevAnswer | undefined>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** The AI SDK's question in Jev's words: only `boolean` has another name. */
function toJev(q: Question): Record<string, unknown> {
  if (q.type === 'boolean') return { type: 'noul', instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) };
  return { type: q.type, instructions: q.instructions, criteria: q.criteria };
}

/**
 * Jev's answer as the AI SDK checks it: every option present (missing ones at 0), probabilities
 * summing to exactly 1 (Jev rounds them), the choice a most likely option, and a score that is the
 * weighted mean of its levels.
 */
function fromJev(id: string, q: Question, a: JevAnswer): RawAnswer {
  const wrong = (what: string) => new JevError(`Jev's answer to "${id}" ${what}.`, null);
  switch (q.type) {
    case 'choice': {
      const options = Object.keys(q.criteria);
      if (a.type !== 'choice' || typeof a.choice !== 'string' || !options.includes(a.choice)) throw wrong('picked no known option');
      const probabilities = distribution(options, a.probabilities);
      if (!probabilities) return { type: 'choice', choice: a.choice };
      const top = options.reduce((best, o) => (probabilities[o]! > probabilities[best]! ? o : best), a.choice);
      return { type: 'choice', choice: probabilities[a.choice]! >= probabilities[top]! ? a.choice : top, probabilities };
    }
    case 'score': {
      const levels = q.criteria.map((_, i) => String(i));
      const probabilities = distribution(levels, a.probabilities);
      if (probabilities) return { type: 'score', score: levels.reduce((s, l) => s + Number(l) * probabilities[l]!, 0), probabilities };
      if (a.type !== 'score' || typeof a.score !== 'number' || !Number.isFinite(a.score)) throw wrong('has no score');
      return { type: 'score', score: Math.min(levels.length - 1, Math.max(0, a.score)) };
    }
    case 'boolean': {
      if (a.type !== 'noul' || typeof a.noul !== 'number' || !Number.isFinite(a.noul)) throw wrong('has no probability');
      return { type: 'boolean', probability: Math.min(1, Math.max(0, a.noul)) };
    }
  }
}

/** A complete distribution over `keys`, renormalized; null when Jev gave none (or all zeros). */
function distribution(keys: string[], raw: Record<string, unknown> | undefined): Record<string, number> | null {
  if (!raw || typeof raw !== 'object') return null;
  const values = keys.map((k) => {
    const v = raw[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
  });
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;
  return Object.fromEntries(keys.map((k, i) => [k, values[i]! / sum]));
}

/** What went wrong, in words - Jev's own detail when it sends one, never the request (or the key). */
async function failure(res: Response): Promise<string> {
  const detail = await res
    .json()
    .then((b: any) => (typeof b?.detail === 'string' ? b.detail : typeof b?.error?.message === 'string' ? b.error.message : typeof b?.message === 'string' ? b.message : ''))
    .catch(() => '');
  const said = detail ? `: ${detail.slice(0, 200)}` : '';
  switch (res.status) {
    case 401:
      return "Jev didn't accept the key in NOVA_JEV_API_KEY.";
    case 403:
      return `Jev refused this key${said}.`;
    case 422:
      return `Jev couldn't read the question${said}.`;
    case 429:
      return 'Jev is limiting how often Nova can ask right now.';
    case 529:
      return 'Jev is overloaded right now.';
    default:
      return `Jev answered ${res.status}${said}.`;
  }
}
