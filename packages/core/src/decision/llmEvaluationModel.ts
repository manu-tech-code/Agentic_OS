import { generateText, Output, type LanguageModel } from 'ai';
import { z } from 'zod';
import { answerFromWeights } from './distribution.ts';
import type { CallOptions, EvaluationModelV4, Question, RawAnswer, RawResult } from './types.ts';

/**
 * Makes a chat model on one of the user's local servers behave like a System One model: typed
 * answers only, schema-constrained. Slower than Reflex or Jev and its probabilities are
 * self-reported, but it keeps everything on the Mac - and it's a baseline to compare them against.
 */
export class LlmEvaluationModel implements EvaluationModelV4 {
  readonly specificationVersion = 'v4' as const;
  readonly provider = 'nova-llm';
  readonly supportedQuestionTypes = ['choice', 'score', 'boolean'] as const;

  constructor(
    private readonly model: Exclude<LanguageModel, string>,
    readonly modelId: string = 'custom-llm',
  ) {}

  async doEvaluate({ state, questions, abortSignal }: CallOptions): Promise<RawResult> {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [id, q] of Object.entries(questions)) shape[id] = schemaFor(q);

    const { output } = await generateText({
      model: this.model,
      abortSignal,
      temperature: 0,
      output: Output.object({ schema: z.object(shape), name: 'decisions' }),
      system:
        'You are a decision function inside software. Answer every question strictly from the STATE. ' +
        'Read instructions literally. For choice pick one option key; for score pick a level index (0 = first level); ' +
        'for boolean give P(true). Confidence/probability must be honest and calibrated.',
      prompt:
        `STATE:\n${JSON.stringify(state, null, 2)}\n\nQUESTIONS:\n${JSON.stringify(questions, null, 2)}\n\n` +
        `Reply with one JSON object in this shape:\n${JSON.stringify(answerShape(questions))}`,
    });

    const answers: Record<string, RawAnswer> = {};
    for (const [id, q] of Object.entries(questions)) {
      answers[id] = toAnswer(q, (output as Record<string, any>)[id]);
    }
    return { answers, warnings: [] };
  }
}

/** The reply shape in plain words, for local servers that can't enforce the JSON schema. */
function answerShape(questions: Record<string, Question>) {
  const shape: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    shape[id] =
      q.type === 'choice'
        ? { choice: `one key of QUESTIONS.${id}.criteria`, confidence: 'number 0-1' }
        : q.type === 'score'
          ? { level: `integer 0-${q.criteria.length - 1}`, confidence: 'number 0-1' }
          : { probability: 'number 0-1' };
  }
  return shape;
}

function schemaFor(q: Question): z.ZodTypeAny {
  const confidence = z.number().min(0).max(1).describe('probability that this answer is correct');
  switch (q.type) {
    case 'choice': {
      const keys = Object.keys(q.criteria) as [string, ...string[]];
      return z.object({ choice: z.enum(keys), confidence });
    }
    case 'score':
      return z.object({ level: z.number().int().min(0).max(q.criteria.length - 1), confidence });
    case 'boolean':
      return z.object({ probability: z.number().min(0).max(1).describe('P(statement is true)') });
  }
}

/** Spread the self-reported confidence into a full distribution. */
function toAnswer(q: Question, raw: any): RawAnswer {
  if (q.type === 'boolean') {
    const p = clamp(raw?.probability ?? 0.5);
    return answerFromWeights(q, [1 - p, p]);
  }
  const n = q.type === 'choice' ? Object.keys(q.criteria).length : q.criteria.length;
  const index = q.type === 'choice' ? Object.keys(q.criteria).indexOf(raw?.choice) : Number(raw?.level);
  const safeIndex = index >= 0 && index < n ? index : 0;
  const selected = n === 1 ? 1 : Math.max(clamp(raw?.confidence ?? 0.5), 1 / n + 1e-6);
  const rest = n === 1 ? 0 : (1 - selected) / (n - 1);
  return answerFromWeights(q, Array.from({ length: n }, (_, i) => (i === safeIndex ? selected : rest)));
}

const clamp = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);
