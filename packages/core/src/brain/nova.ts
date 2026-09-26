import { topProbability } from '../decision/distribution.ts';
import type { DecisionEngine } from '../decision/types.ts';
import { gateFor, MIN_CONFIDENCE } from '../guardian.ts';
import type { ActivityItem, Card, ServerEvent } from '../protocol.ts';
import { builtinSkills } from '../skills/builtin.ts';
import type { Platform, Skill, TimerService } from '../skills/types.ts';
import { buildQuestions } from './questions.ts';
import type { ReasoningBrain, Turn } from './reasoning.ts';

export interface NovaOptions {
  engine: DecisionEngine;
  platform: Platform;
  emit: (event: ServerEvent) => void;
  reasoning?: ReasoningBrain | null;
  skills?: Skill[];
  wakeWords?: string[];
  /** How long Nova keeps listening without the wake word after it speaks. */
  followUpMs?: number;
  clock?: () => number;
}

type Pending =
  | { kind: 'confirm'; skill: Skill; app?: string; utterance: string; cardId: string }
  | { kind: 'slot'; skill: Skill; utterance: string };

const uid = () => Math.random().toString(36).slice(2, 10);

/**
 * The orchestrator. Every utterance gets exactly one System 1 decision; code
 * then either runs a skill directly, asks for confirmation/clarification, or
 * hands off to the System 2 reasoning brain.
 */
export class NovaBrain {
  apps: string[] = [];
  private history: Turn[] = [];
  private followUpUntil = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: Pending | null = null;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly skills: Skill[];
  private readonly wakeRe: RegExp;
  private readonly followUpMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: NovaOptions) {
    this.skills = opts.skills ?? builtinSkills;
    this.followUpMs = opts.followUpMs ?? 8000;
    this.now = opts.clock ?? Date.now;
    const words = (opts.wakeWords ?? ['hey nova', 'okay nova', 'nova'])
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
    this.wakeRe = new RegExp(`\\b(?:${words.join('|')})\\b[,.!?]?`, 'i');
  }

  async init() {
    this.apps = await this.opts.platform.listApps().catch(() => []);
  }

  hello(): ServerEvent {
    return {
      type: 'hello',
      engine: this.opts.engine.name,
      brain: this.opts.reasoning?.name ?? null,
      apps: this.apps.length,
      wakeWords: this.opts.wakeWords ?? ['hey nova', 'okay nova', 'nova'],
    };
  }

  /** Split an utterance around the wake word. Speech before it is treated as background. */
  stripWake(text: string): { found: boolean; rest: string } {
    const m = this.wakeRe.exec(text);
    if (!m) return { found: false, rest: text.trim() };
    const after = text.slice(m.index + m[0].length).trim();
    const before = text.slice(0, m.index).trim();
    return { found: true, rest: after || before };
  }

  async handle(raw: string, source: 'voice' | 'keyboard' = 'voice'): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    const wake = this.stripWake(text);
    const inWindow = this.now() < this.followUpUntil || this.pending !== null;
    const explicit = wake.found || source === 'keyboard';

    if (!explicit && !inWindow) return; // not for us
    if (wake.found && !wake.rest) {
      this.openWindow();
      return;
    }
    const utterance = wake.found ? wake.rest : text;
    this.phase('thinking');

    let decision;
    try {
      decision = await this.opts.engine.decide(
        {
          utterance,
          wakeWordUsed: explicit,
          awaitingConfirmationFor: this.pending?.kind === 'confirm' ? this.pending.skill.id : null,
          awaitingAppFor: this.pending?.kind === 'slot' ? this.pending.skill.id : null,
          recentTurns: this.history.slice(-3),
        },
        buildQuestions(this.skills, this.apps, utterance),
      );
    } catch (error) {
      this.emit({ type: 'error', message: `Decision engine failed: ${(error as Error).message}` });
      this.say(utterance, "Sorry, my decision engine isn't reachable right now.");
      return;
    }

    const answers = decision.answers as Record<string, any>;
    const intent: string = answers.intent.choice;
    const intentP = topProbability(answers.intent);
    const addressedP = answers.addressed.probability as number;
    const appAnswer = answers.app;
    const app = appAnswer && appAnswer.choice !== 'none' && topProbability(appAnswer) >= 0.5 ? (appAnswer.choice as string) : undefined;

    const trace = (outcome: string) =>
      this.emit({
        type: 'decision',
        trace: { utterance, engine: decision.engine, latencyMs: decision.latencyMs, fellBack: decision.fellBack, answers, outcome },
      });

    // Follow-ups without the wake word must pass the addressee check.
    if (!explicit && addressedP < 0.5) {
      trace(`ignored (addressed ${addressedP.toFixed(2)})`);
      this.phase(this.now() < this.followUpUntil ? 'listening' : 'idle');
      return;
    }

    // Resolve anything Nova asked about last turn.
    const pending = this.pending;
    this.pending = null;
    if (pending?.kind === 'confirm') {
      this.emit({ type: 'dismiss', id: pending.cardId });
      if (intent === 'confirm_yes') {
        trace(`confirmed ${pending.skill.id}`);
        return this.execute(pending.skill, pending.utterance, pending.app);
      }
      if (intent === 'confirm_no' || intent === 'stop') {
        trace(`declined ${pending.skill.id}`);
        this.activity(`Cancelled ${pending.skill.id.replace('_', ' ')}`, 'cancelled', pending.skill);
        return this.say(utterance, 'Okay, I left it.');
      }
    }
    if (pending?.kind === 'slot' && app && intent !== 'stop') {
      trace(`${pending.skill.id} → ${app}`);
      return this.route(pending.skill, pending.utterance, app, 1);
    }

    const skill = this.skills.find((s) => s.id === intent);
    if (skill) {
      trace(`${skill.id}${app ? ` → ${app}` : ''} (p=${intentP.toFixed(2)})`);
      return this.route(skill, utterance, app, intentP);
    }

    trace(intent);
    switch (intent) {
      case 'stop':
        return this.say(utterance, 'Okay.');
      case 'confirm_yes':
      case 'confirm_no':
        return this.say(utterance, "There's nothing waiting for confirmation.");
      default:
        return this.think(utterance);
    }
  }

  speechFinished() {
    this.openWindow();
  }

  cancel() {
    this.pending = null;
    this.phase('idle');
  }

  // ---------------------------------------------------------------------------

  private async route(skill: Skill, utterance: string, app: string | undefined, p: number) {
    if (p < MIN_CONFIDENCE[skill.tier]) {
      return this.say(utterance, "Sorry, I'm not sure what you meant. Could you say that again?");
    }
    if (skill.needsApp && !app) {
      this.pending = { kind: 'slot', skill, utterance };
      return this.say(utterance, 'Which app?');
    }
    const gate = gateFor(skill.tier);
    if (gate === 'tap') {
      return this.say(utterance, 'That needs a confirmation on screen.');
    }
    if (gate === 'confirm') {
      const ctx = this.context(utterance, app);
      const prompt = skill.confirmPrompt?.(ctx) ?? 'Are you sure?';
      const cardId = uid();
      this.pending = { kind: 'confirm', skill, app, utterance, cardId };
      this.card({ id: cardId, kind: 'confirm', title: prompt, body: 'Say "yes" or "no"' });
      this.activity(prompt, 'pending', skill);
      return this.say(utterance, prompt);
    }
    return this.execute(skill, utterance, app);
  }

  private async execute(skill: Skill, utterance: string, app?: string) {
    this.phase('acting', skill.id);
    try {
      const result = await skill.run(this.context(utterance, app));
      if (result.card) this.card(result.card);
      this.activity(result.activity, 'done', skill);
      this.say(utterance, result.say);
    } catch (error) {
      this.activity(`${skill.id} failed`, 'failed', skill);
      this.say(utterance, `Sorry, that didn't work. ${(error as Error).message}`);
    }
  }

  private async think(utterance: string) {
    const brain = this.opts.reasoning;
    if (!brain) {
      return this.say(utterance, "I can't do that yet. Connect a reasoning model to let me handle open questions.");
    }
    this.phase('thinking', brain.name);
    try {
      const reply = await brain.reply(utterance, this.history.slice(-6), AbortSignal.timeout(30_000));
      this.card({ id: uid(), kind: 'answer', title: utterance, body: reply });
      this.activity(`Asked ${brain.name}`, 'done');
      this.say(utterance, reply);
    } catch (error) {
      this.activity(`${brain.name} failed`, 'failed');
      this.say(utterance, `Sorry, ${brain.name} didn't respond. ${(error as Error).message}`);
    }
  }

  private context(utterance: string, app?: string) {
    return { utterance, app, platform: this.opts.platform, timers: this.timerService };
  }

  private readonly timerService: TimerService = {
    start: (ms, label) => {
      const id = uid();
      this.timers.set(
        id,
        setTimeout(() => {
          this.timers.delete(id);
          this.emit({ type: 'dismiss', id });
          this.card({ id: uid(), kind: 'timer', title: `Timer done · ${label}` });
          this.activity(`Timer finished · ${label}`, 'done');
          this.emit({ type: 'say', text: `Your timer for ${label} is done.` });
          this.phase('speaking');
        }, ms),
      );
      return id;
    },
    cancelAll: () => {
      const n = this.timers.size;
      for (const [id, t] of this.timers) {
        clearTimeout(t);
        this.emit({ type: 'dismiss', id });
      }
      this.timers.clear();
      return n;
    },
  };

  private openWindow() {
    this.followUpUntil = this.now() + this.followUpMs;
    this.phase('listening');
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.now() >= this.followUpUntil && !this.pending) this.phase('idle');
    }, this.followUpMs + 50);
  }

  private say(user: string, text: string) {
    this.history.push({ user, nova: text });
    if (this.history.length > 20) this.history.shift();
    this.emit({ type: 'say', text });
    this.phase('speaking');
  }

  private card(card: Card) {
    this.emit({ type: 'card', card });
  }

  private activity(label: string, status: ActivityItem['status'], skill?: Skill) {
    this.emit({ type: 'activity', item: { id: uid(), at: this.now(), label, status, skill: skill?.id, tier: skill?.tier } });
  }

  private phase(phase: 'idle' | 'listening' | 'thinking' | 'acting' | 'speaking', label?: string) {
    this.emit({ type: 'phase', phase, label });
  }

  private emit(event: ServerEvent) {
    this.opts.emit(event);
  }
}
