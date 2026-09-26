/**
 * Wire protocol between the Nova daemon (brain) and any shell (desktop, web, IDE).
 * Dependency-free so UIs can import it without pulling in model SDKs.
 */

export type Phase = 'idle' | 'listening' | 'thinking' | 'acting' | 'speaking';

export type RiskTier = 0 | 1 | 2 | 3;

export interface Card {
  id: string;
  kind: 'app' | 'time' | 'timer' | 'info' | 'confirm' | 'error' | 'answer';
  title: string;
  body?: string;
  /** epoch ms, for countdown cards */
  endsAt?: number;
  icon?: string;
}

export interface ActivityItem {
  id: string;
  at: number;
  label: string;
  status: 'done' | 'failed' | 'pending' | 'cancelled';
  skill?: string;
  tier?: RiskTier;
}

export interface DecisionTrace {
  utterance: string;
  engine: string;
  latencyMs: number;
  fellBack: boolean;
  answers: Record<string, unknown>;
  outcome: string;
}

/** daemon -> shell */
export type ServerEvent =
  | { type: 'hello'; engine: string; brain: string | null; apps: number; wakeWords: string[] }
  | { type: 'phase'; phase: Phase; label?: string }
  | { type: 'say'; text: string }
  | { type: 'card'; card: Card }
  | { type: 'dismiss'; id: string }
  | { type: 'activity'; item: ActivityItem }
  | { type: 'decision'; trace: DecisionTrace }
  | { type: 'error'; message: string };

/** shell -> daemon */
export type ClientEvent =
  | { type: 'utterance'; text: string; source: 'voice' | 'keyboard' }
  | { type: 'speech-finished' }
  | { type: 'cancel' };
