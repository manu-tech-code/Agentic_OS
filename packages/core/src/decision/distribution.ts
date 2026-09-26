import type { Question, RawAnswer } from './types.ts';

/** Normalise non-negative weights into a probability distribution. */
export function normalise(weights: number[]): number[] {
  const clean = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const total = clean.reduce((a, b) => a + b, 0);
  if (total === 0) return clean.map(() => 1 / clean.length);
  return clean.map((w) => w / total);
}

/** Softmax with temperature - turns similarity scores into probabilities. */
export function softmax(scores: number[], temperature = 1): number[] {
  const max = Math.max(...scores);
  return normalise(scores.map((s) => Math.exp((s - max) / temperature)));
}

/**
 * Build a spec-valid answer for a question from per-option weights
 * (choice: one weight per criteria key, score: one per level, boolean: [pFalse, pTrue]).
 */
export function answerFromWeights(question: Question, weights: number[]): RawAnswer {
  const probs = normalise(weights);
  switch (question.type) {
    case 'choice': {
      const keys = Object.keys(question.criteria);
      const probabilities: Record<string, number> = {};
      keys.forEach((k, i) => (probabilities[k] = probs[i] ?? 0));
      let best = keys[0]!;
      for (const k of keys) if ((probabilities[k] ?? 0) > (probabilities[best] ?? 0)) best = k;
      return { type: 'choice', choice: best, probabilities };
    }
    case 'score': {
      const probabilities: Record<string, number> = {};
      let score = 0;
      probs.forEach((p, i) => {
        probabilities[String(i)] = p;
        score += i * p;
      });
      return { type: 'score', score, probabilities };
    }
    case 'boolean':
      return { type: 'boolean', probability: probs[1] ?? 0.5 };
  }
}

/** Probability of the selected option (choice) or P(true) (boolean). */
export function topProbability(answer: RawAnswer | undefined): number {
  if (!answer) return 0;
  if (answer.type === 'boolean') return answer.probability;
  if (answer.type === 'choice') return answer.probabilities?.[answer.choice] ?? 0;
  const values = Object.values(answer.probabilities ?? {});
  return values.length ? Math.max(...values) : 0;
}
