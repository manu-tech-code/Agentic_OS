import type { RiskTier } from './protocol.ts';

/**
 * Risk tiers decide how much ceremony an action needs. The tier is declared by
 * the skill in code - never inferred by a model from untrusted content.
 *   T0 read-only / trivial        -> just do it
 *   T1 reversible                 -> do it and announce (undo window later)
 *   T2 external or hard to undo   -> spoken confirmation
 *   T3 money, credentials, mass delete -> on-screen tap only, never voice alone
 */
export type Gate = 'run' | 'announce' | 'confirm' | 'tap';

export function gateFor(tier: RiskTier): Gate {
  return (['run', 'announce', 'confirm', 'tap'] as const)[tier];
}

/** Confidence the decision needs before Nova acts without asking, per tier. */
export const MIN_CONFIDENCE: Record<RiskTier, number> = { 0: 0.5, 1: 0.6, 2: 0.75, 3: 1.01 };
