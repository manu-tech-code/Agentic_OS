import { experimental_evaluate as evaluate, type Experimental_EvaluationModel as EvaluationModel, type LanguageModel } from 'ai';
import { HeuristicEvaluationModel } from './heuristicModel.ts';
import { LlmEvaluationModel } from './llmEvaluationModel.ts';
import type { Decision, DecisionEngine, DecisionExample, Questions, StateInput } from './types.ts';

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

  learn(example: DecisionExample) {
    for (const slot of [this.primary, this.fallback]) (slot?.model as { learn?: (e: DecisionExample) => void } | undefined)?.learn?.(example);
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

export type EngineKind = 'auto' | 'reflex' | 'jev' | 'llm' | 'heuristic';
export type FallbackKind = 'llm' | 'heuristic' | 'none';

export interface EngineConfig {
  engine?: EngineKind;
  fallback?: FallbackKind;
  timeoutMs?: number;
  jevModel?: string;
  /** Model id used when an LLM makes the decisions (as primary or fallback). */
  llmModel?: string;
  /** Turns a model id into an AI SDK model. Defaults to reading it as a Vercel AI Gateway id. */
  resolveModel?: (id: string) => LanguageModel;
  hasGatewayKey?: boolean;
  /** Reflex, Nova's own local decision model, when its embedding model is installed. */
  reflex?: EvaluationModel;
}

export function createDecisionEngine(config: EngineConfig = {}): DecisionEngine {
  const {
    engine = 'auto',
    fallback = 'heuristic',
    timeoutMs = 1500,
    jevModel = 'typesafe-ai/jev',
    llmModel = 'anthropic/claude-haiku-4.5',
    resolveModel = (id: string): LanguageModel => id,
    hasGatewayKey = false,
    reflex,
  } = config;

  const slot = (kind: Exclude<EngineKind, 'auto'>): EngineSlot => {
    switch (kind) {
      case 'reflex':
        if (reflex) return { name: typeof reflex === 'string' ? reflex : (reflex as { modelId: string }).modelId, model: reflex };
        return { name: 'heuristic (Reflex not installed)', model: new HeuristicEvaluationModel() };
      case 'jev':
        return { name: `jev (${jevModel})`, model: jevModel };
      case 'llm':
        return { name: `llm (${llmModel})`, model: new LlmEvaluationModel(resolveModel(llmModel), llmModel) };
      case 'heuristic':
        return { name: 'heuristic', model: new HeuristicEvaluationModel() };
    }
  };

  // Automatic: Reflex on this machine; Jev with a gateway key; otherwise keywords.
  const primaryKind: Exclude<EngineKind, 'auto'> = engine === 'auto' ? (reflex ? 'reflex' : hasGatewayKey ? 'jev' : 'heuristic') : engine;
  const fallbackSlot = fallback === 'none' || fallback === primaryKind ? null : slot(fallback);
  // LLM decisions are slower; give them room.
  const budget = primaryKind === 'llm' ? Math.max(timeoutMs, 6000) : timeoutMs;
  return new EvaluationDecisionEngine(slot(primaryKind), fallbackSlot, budget);
}
