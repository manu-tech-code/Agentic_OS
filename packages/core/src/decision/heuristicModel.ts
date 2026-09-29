import { answerFromWeights, softmax } from './distribution.ts';
import type { CallOptions, EvaluationModelV4, RawAnswer, RawResult, StateInput } from './types.ts';

/**
 * Offline, zero-cost stand-in for Jev. Keyword/phrase overlap, nothing clever.
 * Exists so the whole voice -> decide -> act loop runs with no API keys, and so
 * tests are deterministic. Not meant to be accurate on open-ended questions.
 */
const STOP = new Set(
  'a an the to of for and or is are am be me my i you your it this that please can could would will just now up on in at with'.split(' '),
);
const FALLBACK_KEYS = new Set(['other', 'none', 'unknown', 'no_match']);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t));
}

function flatten(input: StateInput | null | undefined): string[] {
  if (input == null) return [];
  if (typeof input === 'string') return [input];
  if (Array.isArray(input)) return input.flatMap((v) => flatten(v as StateInput));
  if (typeof input === 'object') return Object.values(input).flatMap((v) => flatten(v as StateInput));
  return [String(input)];
}

/** Prefer a focused `utterance` field when the state has one. */
function focusText(state: StateInput): string {
  const utterance = state && typeof state === 'object' ? (state as Record<string, unknown>).utterance : undefined;
  if (typeof utterance === 'string') return utterance;
  return flatten(state).join(' ');
}

function similarity(text: string, textTokens: Set<string>, phrase: string): number {
  const p = tokens(phrase);
  if (!p.length) return 0;
  const lowered = text.toLowerCase();
  const exact = lowered.includes(phrase.toLowerCase()) ? 0.5 : 0;
  const hits = p.filter((t) => textTokens.has(t)).length;
  // Small bonus per matched word, so "stop the agent" beats a bare "stop" on the same text.
  return hits / p.length + exact + 0.05 * hits;
}

export class HeuristicEvaluationModel implements EvaluationModelV4 {
  readonly specificationVersion = 'v4' as const;
  readonly provider = 'nova';
  readonly modelId = 'heuristic';
  readonly supportedQuestionTypes = ['choice', 'score', 'boolean'] as const;

  async doEvaluate({ state, questions }: CallOptions): Promise<RawResult> {
    const text = focusText(state);
    const textTokens = new Set(tokens(text));
    const answers: Record<string, RawAnswer> = {};

    for (const [id, q] of Object.entries(questions)) {
      if (q.type === 'choice') {
        const scores = Object.entries(q.criteria).map(([key, desc]) => {
          if (FALLBACK_KEYS.has(key)) return 0.35;
          const phrases = [key.replace(/_/g, ' '), ...flatten(desc)];
          return Math.max(...phrases.map((ph) => similarity(text, textTokens, ph)));
        });
        answers[id] = answerFromWeights(q, softmax(scores, 0.12));
      } else if (q.type === 'score') {
        const scores = q.criteria.map((level) => Math.max(0, ...flatten(level).map((ph) => similarity(text, textTokens, ph))));
        answers[id] = answerFromWeights(q, softmax(scores, 0.3));
      } else {
        const t = Math.max(0, ...flatten(q.criteria?.true ?? null).map((ph) => similarity(text, textTokens, ph)));
        const f = Math.max(0, ...flatten(q.criteria?.false ?? null).map((ph) => similarity(text, textTokens, ph)));
        // No signal either way -> lean yes, so follow-ups are treated as addressed.
        answers[id] = answerFromWeights(q, t === f ? [0.4, 0.6] : softmax([f, t], 0.3));
      }
    }
    return { answers, warnings: [] };
  }
}
