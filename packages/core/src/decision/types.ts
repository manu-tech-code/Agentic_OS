import type {
  Experimental_EvaluationModelV4 as EvaluationModelV4,
  Experimental_EvaluationModelV4Question as Question,
  Experimental_EvaluationModelV4Answer as RawAnswer,
  Experimental_EvaluationModelV4CallOptions as CallOptions,
  Experimental_EvaluationModelV4Result as RawResult,
  Experimental_EvaluationModelV4Input as StateInput,
} from '@ai-sdk/provider';
import type { Experimental_EvaluationResult as EvaluationResult } from 'ai';

export type { EvaluationModelV4, Question, RawAnswer, CallOptions, RawResult, StateInput };

export type Questions = Record<string, Question>;

/**
 * The System 1 contract. Nova never talks to Jev directly: it talks to a
 * DecisionEngine, and any typed-decision backend (Jev, an LLM with a schema,
 * a local model, a heuristic) can sit behind it. Question/answer shapes follow
 * the AI SDK evaluation spec, which Jev implements natively.
 */
export interface DecisionEngine {
  readonly name: string;
  decide<Q extends Questions>(state: StateInput, questions: Q): Promise<Decision<Q>>;
  /** Hear which answer turned out right (the user confirmed it), for engines that learn. */
  learn?(example: DecisionExample): void;
}

/** An utterance and the answer that turned out right for one question. */
export interface DecisionExample {
  utterance: string;
  question: string;
  choice: string;
  /** How it became known: the user confirmed it, answered a follow-up, or the brain used that skill. */
  source?: 'confirmed' | 'clarified' | 'brain';
}

export interface Decision<Q extends Questions> {
  answers: EvaluationResult<Q>['answers'];
  /** Which backend actually answered (after any fallback). */
  engine: string;
  latencyMs: number;
  fellBack: boolean;
  /** TypeSafe's concentration statistic per choice/score question, when provided. */
  confidence?: Record<string, number>;
}
