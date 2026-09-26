import { experimental_evaluate as evaluate, type Experimental_EvaluationModel as EvaluationModel } from 'ai';
import { HeuristicEvaluationModel } from './heuristicModel.ts';
import { LlmEvaluationModel } from './llmEvaluationModel.ts';
import type { Decision, DecisionEngine, Questions, StateInput } from './types.ts';

export interface EngineSlot {
  name: string;
  model: EvaluationModel;
}

/**
 * Runs typed questions through a primary evaluation model with a hard latency
 * budget, falling back to a second model on error or timeout. Voice UX needs a
 * bounded answer time more than it needs the best possible answer.
 */
export class EvaluationDecisionEngine implements DecisionEngine {
  constructor(
    private readonly primary: EngineSlot,
    private readonly fallback: EngineSlot | null = null,
    private readonly timeoutMs = 1500,
    private readonly gatewayOptions: Record<string, unknown> = { zeroDataRetention: true },
  ) {}

  get name() {
    return this.fallback ? `${this.primary.name} → ${this.fallback.name}` : this.primary.name;
  }

  async decide<Q extends Questions>(state: StateInput, questions: Q): Promise<Decision<Q>> {
    const started = performance.now();
    try {
      return await this.run(this.primary, state, questions, started, false);
    } catch (error) {
      if (!this.fallback) throw error;
      return this.run(this.fallback, state, questions, started, true);
    }
  }

  private async run<Q extends Questions>(
    slot: EngineSlot,
    state: StateInput,
    questions: Q,
    started: number,
    fellBack: boolean,
  ): Promise<Decision<Q>> {
    const result = await evaluate({
      model: slot.model,
      state,
      questions,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(this.timeoutMs),
      providerOptions: typeof slot.model === 'string' ? { gateway: this.gatewayOptions as any } : undefined,
    });
    const confidence = (result.providerMetadata as any)?.typesafe?.confidence as Record<string, number> | undefined;
    return {
      answers: result.answers,
      engine: slot.name,
      latencyMs: Math.round(performance.now() - started),
      fellBack,
      confidence,
    };
  }
}

export type EngineKind = 'auto' | 'jev' | 'llm' | 'heuristic';
export type FallbackKind = 'llm' | 'heuristic' | 'none';

export interface EngineConfig {
  engine?: EngineKind;
  fallback?: FallbackKind;
  timeoutMs?: number;
  jevModel?: string;
  /** Gateway model id used when an LLM acts as the decision engine. */
  llmModel?: string;
  hasGatewayKey?: boolean;
}

export function createDecisionEngine(config: EngineConfig = {}): DecisionEngine {
  const {
    engine = 'auto',
    fallback = 'heuristic',
    timeoutMs = 1500,
    jevModel = 'typesafe-ai/jev',
    llmModel = 'anthropic/claude-haiku-4.5',
    hasGatewayKey = false,
  } = config;

  const slot = (kind: Exclude<EngineKind, 'auto'>): EngineSlot => {
    switch (kind) {
      case 'jev':
        return { name: `jev (${jevModel})`, model: jevModel };
      case 'llm':
        return { name: `llm (${llmModel})`, model: new LlmEvaluationModel(llmModel) };
      case 'heuristic':
        return { name: 'heuristic', model: new HeuristicEvaluationModel() };
    }
  };

  const primaryKind: Exclude<EngineKind, 'auto'> = engine === 'auto' ? (hasGatewayKey ? 'jev' : 'heuristic') : engine;
  const fallbackSlot = fallback === 'none' || fallback === primaryKind ? null : slot(fallback);
  // LLM decisions are slower; give them room.
  const budget = primaryKind === 'llm' ? Math.max(timeoutMs, 6000) : timeoutMs;
  return new EvaluationDecisionEngine(slot(primaryKind), fallbackSlot, budget);
}
