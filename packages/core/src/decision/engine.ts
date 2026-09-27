import { experimental_evaluate as evaluate, type LanguageModel } from 'ai';
import { HeuristicEvaluationModel } from './heuristicModel.ts';
import { JEV_DEFAULT_MODEL, JevEvaluationModel } from './jev.ts';
import { LlmEvaluationModel } from './llmEvaluationModel.ts';
import type { Decision, DecisionEngine, DecisionExample, EvaluationModelV4, Questions, StateInput } from './types.ts';

/** A model object, never a bare id: nothing is resolved behind Nova's back (no gateway, no default provider). */
export interface EngineSlot {
  name: string;
  model: EvaluationModelV4;
}

/** A language model Nova made itself (a local server's): an id string would go to the AI SDK's default provider. */
export type LocalLanguageModel = Exclude<LanguageModel, string>;

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
/** `auto`: Reflex when it's installed and isn't already deciding, otherwise the keyword matcher. */
export type FallbackKind = 'auto' | 'reflex' | 'llm' | 'heuristic' | 'none';

export interface EngineConfig {
  engine?: EngineKind;
  fallback?: FallbackKind;
  timeoutMs?: number;
  /** Jev's key (NOVA_JEV_API_KEY): without one, Jev isn't used - Reflex decides, or the keyword matcher. */
  jevApiKey?: string;
  /** jev-latest, jev-preview, or a pinned version (jev-1.13.0). */
  jevModel?: string;
  /** For tests: where Jev's requests go. */
  jevFetch?: typeof fetch;
  /** A local model server's model ("lmstudio/...") when a language model makes the decisions. */
  llmModel?: string;
  /** Turns a local model id into a model; null for anything that isn't one of the user's servers. */
  resolveModel?: (id: string) => LocalLanguageModel | null;
  /** Reflex, Nova's own local decision model, when its embedding model is installed. */
  reflex?: EvaluationModelV4;
}

export function createDecisionEngine(config: EngineConfig = {}): DecisionEngine {
  const { engine = 'auto', fallback = 'auto', timeoutMs = 1500, jevApiKey = '', jevModel = JEV_DEFAULT_MODEL, jevFetch, llmModel = '', resolveModel, reflex } = config;
  const heuristic = (why = ''): EngineSlot => ({ name: `heuristic${why ? ` (${why})` : ''}`, model: new HeuristicEvaluationModel() });
  // What stands in when the chosen one can't run: Reflex if it's there, else the keyword matcher - and why.
  const instead = (why: string): EngineSlot => (reflex ? { name: `${reflex.modelId} (${why})`, model: reflex } : heuristic(why));
  const local = llmModel ? (resolveModel?.(llmModel) ?? null) : null;

  const slot = (kind: Exclude<EngineKind, 'auto'>): EngineSlot => {
    switch (kind) {
      case 'reflex':
        return reflex ? { name: reflex.modelId, model: reflex } : heuristic('Reflex not installed');
      case 'jev':
        return jevApiKey ? { name: `jev (${jevModel})`, model: new JevEvaluationModel({ apiKey: jevApiKey, model: jevModel, fetch: jevFetch }) } : instead('no Jev key');
      case 'llm':
        if (!local) return instead(llmModel ? `${llmModel} isn't a local model server` : 'no decision model');
        return { name: `llm (${llmModel})`, model: new LlmEvaluationModel(local, llmModel) };
      case 'heuristic':
        return heuristic();
    }
  };

  // Automatic: Reflex on this machine, otherwise the keyword matcher. Jev decides only when it's chosen.
  const primaryKind: Exclude<EngineKind, 'auto'> = engine === 'auto' ? (reflex ? 'reflex' : 'heuristic') : engine;
  const primary = slot(primaryKind);
  const fallbackKind: Exclude<FallbackKind, 'auto'> = fallback === 'auto' ? (reflex && primary.model !== reflex ? 'reflex' : 'heuristic') : fallback;
  // No fallback that is the primary again (Reflex standing in for a missing Jev key needs no Reflex behind it).
  const second = fallbackKind === 'none' ? null : slot(fallbackKind);
  const fallbackSlot = second && second.model !== primary.model && !(second.model instanceof HeuristicEvaluationModel && primary.model instanceof HeuristicEvaluationModel) ? second : null;
  // LLM decisions are slower; give them room.
  const budget = primary.model instanceof LlmEvaluationModel ? Math.max(timeoutMs, 6000) : timeoutMs;
  return new EvaluationDecisionEngine(primary, fallbackSlot, budget);
}
