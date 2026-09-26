import type { Card, RiskTier } from '../protocol.ts';

/** OS capabilities a shell/daemon provides. Keeps core platform-agnostic. */
export interface Platform {
  listApps(): Promise<string[]>;
  openApp(name: string): Promise<void>;
  quitApp(name: string): Promise<void>;
  now(): Date;
}

export interface SkillContext {
  utterance: string;
  /** App resolved by the decision engine, when the skill needs one. */
  app?: string;
  platform: Platform;
  timers: TimerService;
}

export interface SkillResult {
  say: string;
  card?: Card;
  activity: string;
}

export interface Skill {
  id: string;
  /** Example phrasings - passed to Jev as the Choice criteria description. */
  examples: string[];
  tier: RiskTier;
  needsApp?: boolean;
  /** Spoken confirmation prompt for tier >= 2. */
  confirmPrompt?: (ctx: SkillContext) => string;
  run(ctx: SkillContext): Promise<SkillResult>;
}

export interface TimerService {
  start(ms: number, label: string): string;
  cancelAll(): number;
}
