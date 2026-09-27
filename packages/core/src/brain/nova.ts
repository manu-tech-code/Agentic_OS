import type { AgentHost, AgentStep, ApprovalRequest } from '../agents.ts';
import { topProbability } from '../decision/distribution.ts';
import { aliasesFor, matchName, nameTokens } from '../decision/reflex/names.ts';
import type { DecisionEngine } from '../decision/types.ts';
import { gateFor, MIN_CONFIDENCE } from '../guardian.ts';
import { mayRememberTool, toolRisk } from '../integrations.ts';
import type { ActivityItem, Card, Phase, ServerEvent, UiPrefs, UndoStep } from '../protocol.ts';
import type { HearingStatus } from '../settings.ts';
import { wakeWordsFor } from '../settings.ts';
import { agentSkills } from '../skills/agents.ts';
import { builtinSkills } from '../skills/builtin.ts';
import { initiativeSkills } from '../skills/initiative.ts';
import { memorySkills } from '../skills/memory.ts';
import { parseWhen } from '../when.ts';
import { screenSkills } from '../skills/screen.ts';
import { alwaysIn, RISKY_COMMAND, trustSkills } from '../skills/trust.ts';
import { skillTool, type IntegrationTools, type ToolHost, type ToolOutput, type ToolSpec } from '../skills/tools.ts';
import type {
  ActionService,
  AgentRef,
  BriefingService,
  MemoryService,
  News,
  NewsService,
  Platform,
  ProjectService,
  ReminderService,
  Routine,
  RoutineService,
  ScreenService,
  Skill,
  SkillContext,
  TaskRecord,
  TaskService,
  TimerService,
  TrustService,
} from '../skills/types.ts';
import { buildQuestions } from './questions.ts';
import type { ReasoningBrain, Turn } from './reasoning.ts';

export interface NovaOptions {
  /** The assistant's name (default "Nova"). Wake words default to "hey <name>", "okay <name>", "<name>". */
  name?: string;
  engine: DecisionEngine;
  platform: Platform;
  emit: (event: ServerEvent) => void;
  reasoning?: ReasoningBrain | null;
  /** Agents Nova hands questions and project tasks to (Claude Code, Codex, ...). */
  agents?: AgentHost | null;
  skills?: Skill[];
  wakeWords?: string[];
  /** How long Nova keeps listening without the wake word after it replies. */
  followUpMs?: number;
  /** false = conversation mode: no wake word needed; the addressee check filters background speech. */
  requireWakeWord?: boolean;
  /** How long an open question may take, whether a model or an agent answers it. */
  replyTimeoutMs?: number;
  /** Voice preferences passed through to shells in `hello`. */
  ui?: UiPrefs;
  /** How Nova hears (the daemon's engine, or the window's own recognition), passed through in `hello`. */
  hearing?: HearingStatus;
  /** Services the brains can use through Nova (MCP servers), each tool at the tier the user chose. */
  integrations?: IntegrationTools | null;
  /** What Nova remembers: facts the user said or agreed to, and past conversations. */
  memory?: MemoryService | null;
  /** What's on screen, for brains that look when the user asks. */
  screen?: ScreenService | null;
  /**
   * Notes that go with a question to the brain - what the user is working in, what they asked Nova
   * to remember that relates to it. Not the user's words; the brain is told so.
   */
  notes?: (utterance: string) => Promise<string | null>;
  /** Each finished turn, for the conversation history kept on disk. */
  onTurn?: (turn: Turn) => void;
  /** Reminders and timers that outlast a restart (and reach the Reminders app). */
  reminders?: ReminderService | null;
  /** The day's briefing. */
  briefing?: BriefingService | null;
  /** What was held back while the user was away. */
  news?: NewsService | null;
  /** The project the user is working on. */
  projects?: ProjectService | null;
  /** The user's routines, by phrase or schedule. */
  routines?: RoutineService | null;
  /**
   * Where Nova's own news goes - a timer, a finished agent task - so it can wait for a good moment
   * (not mid-call, not to an empty room). Without it, Nova says it at once.
   */
  deliver?: (news: News) => void;
  /** Every change to an agent task, for the task board. */
  onTask?: (task: TaskRecord) => void;
  /** Each step of an agent's task (the files an edit changes, for undoing exactly those). */
  onTaskStep?: (task: TaskRecord, step: AgentStep) => void;
  /** Agent tasks that ended, newest first (the task board keeps them). */
  taskHistory?: () => TaskRecord[];
  /** The record of what Nova did, and taking things back. */
  actions?: ActionService | null;
  /** What the user said "yes, always" to. */
  trust?: TrustService | null;
  /** Before an agent starts: a snapshot of the project, so its changes can be undone. */
  beforeTask?: (task: TaskRecord) => Promise<unknown>;
  /** After it ends: how to put the project back (if it changed), for the record. */
  afterTask?: (task: TaskRecord) => Promise<UndoStep | null>;
  clock?: () => number;
}

/** What Settings can change while Nova runs. */
export type NovaSettings = Omit<NovaOptions, 'platform' | 'emit' | 'clock'>;

const DEFAULT_UI: UiPrefs = { autoListen: true, rate: 1.05, lang: 'en-US', orb: { style: 'particles', colors: 'nova', motion: 'lively' } };

/** What System 1 resolved for the slots a skill may need. */
interface Resolved {
  app?: string;
  project?: string;
  agent?: AgentRef;
}

interface Approval {
  /** The agent task asking, if one is (tool calls from an answering brain have none). */
  taskId?: string;
  /** The answer being written that asked (a brain's tool call): the question goes when that answer ends. */
  thinking?: AbortController;
  prompt: string;
  /** e.g. 'Claude to run "npm test"', for the activity log. */
  summary: string;
  /** What "yes, always" would remember, when it may. */
  remember?: { key: string; label: string };
  resolve: (ok: boolean) => void;
  /** Refused when it runs out - counted from when it was asked, even while it waits behind another question. */
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** A question of Nova's own: it runs out, like an agent's. */
type Question =
  | { kind: 'confirm'; id: string; prompt: string; skill: Skill; resolved: Resolved; utterance: string; by: string; prepared?: unknown; timer?: ReturnType<typeof setTimeout> }
  | { kind: 'slot'; id: string; prompt: string; slot: 'app' | 'project' | 'when'; skill: Skill; resolved: Resolved; utterance: string; by: string; timer?: ReturnType<typeof setTimeout> };

type Pending = Question | { kind: 'approval'; id: string; approval: Approval };

const uid = () => Math.random().toString(36).slice(2, 10);

/** An agent that asks for permission and gets no answer is told no. */
const APPROVAL_TIMEOUT_MS = 120_000;
/** However long an approval waited behind others, the user has this long to answer it once it's asked. */
const ANSWER_MIN_MS = 30_000;
/** A question of Nova's own ("Quit Spotify?", "Which app?") nobody answers is dropped - a "yes" from the TV later means nothing. */
const QUESTION_TIMEOUT_MS = 60_000;

/** A choice answer's pick when it is confident and not "none". */
const picked = (answer: any): string | undefined =>
  answer && answer.choice !== 'none' && topProbability(answer) >= 0.5 ? (answer.choice as string) : undefined;

/** The slots a skill uses, for the decision trace. */
const describe = (skill: Skill, { app, agent, project }: Resolved) => {
  const parts = [skill.needsApp && app, skill.needsAgents && agent?.label, skill.needsProject && project].filter(Boolean);
  return parts.length ? ` → ${parts.join(' · ')}` : '';
};

/** Where the last finished sentence ends, in text still being written ("Sure. Opening Sl" -> after "Sure."). */
function lastSentenceEnd(text: string) {
  let end = 0;
  for (const m of text.matchAll(/[.!?…]+["'”’)\]]*(?=\s)/g)) end = m.index + m[0].length;
  return end;
}

const COMMAND = /\b(open|launch|start|close|quit|set|remind|cancel|stop|turn|tell|ask|play|show|switch)\b/;

/** "Open Notes and set a timer": more than one thing to do - a job for the brain, which can use several tools. */
export function isCompound(utterance: string) {
  const parts = utterance.toLowerCase().split(/\b(?:and then|and also|after that|then|and)\b/);
  return parts.length > 1 && COMMAND.test(parts[0]!) && parts.slice(1).some((p) => COMMAND.test(p));
}

/** The skills a brain called while answering one utterance, and whether each worked. */
interface Lesson {
  calls: { name: string; ok: boolean }[];
}

/** The last paragraph of an agent's report, short enough to read aloud. */
function spokenSummary(text: string) {
  const last = text.trim().split(/\n\s*\n/).at(-1)?.replace(/[#*`>]/g, '').replace(/\s+/g, ' ').trim() ?? '';
  return last.length > 280 ? `${last.slice(0, 277)}…` : last;
}

/**
 * The orchestrator. Every utterance gets exactly one System 1 decision; code
 * then either runs a skill directly, asks for confirmation/clarification,
 * hands off to the System 2 reasoning brain, or gives a paired agent a task.
 */
export class NovaBrain implements ToolHost {
  apps: string[] = [];
  private history: Turn[] = [];
  private followUpUntil = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: Pending | null = null;
  private current: Phase = 'idle';
  private approvals: Approval[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly tasks = new Map<string, AbortController>();
  private skills: Skill[] = [];
  private wakeRe = /$^/;
  private followUpMs = 30_000;
  private requireWakeWord = true;
  private replyTimeoutMs = 60_000;
  /** The open question being answered, so "stop" can cut it short. */
  private thinking: AbortController | null = null;
  /** Ends the sentence being spoken, when a question has to interrupt a reply. */
  private flushReply: (() => void) | null = null;
  /** The tools the brain uses while answering something System 1 wasn't sure of: one skill, used well, is a lesson. */
  private lesson: Lesson | null = null;
  /** What the user said that the brain is answering now, for tools that depend on it. */
  private answering: string | null = null;
  /** Agent tasks running now, for the task board and "what are the agents doing". */
  private readonly running = new Map<string, TaskRecord>();
  /** A routine's steps still to do, while one of them waits for the user's answer. */
  private routineRest: { name: string; steps: string[] } | null = null;
  private readonly now: () => number;

  constructor(private opts: NovaOptions) {
    this.now = opts.clock ?? Date.now;
    this.applyOptions();
  }

  /**
   * Take new settings live: engine, brains, agents and listening options change,
   * while the conversation, pending questions and running agent tasks carry on.
   */
  reconfigure(changes: Partial<NovaSettings>) {
    this.opts = { ...this.opts, ...changes };
    this.applyOptions();
  }

  private applyOptions() {
    const { opts } = this;
    this.skills = [
      ...(opts.skills ?? builtinSkills),
      ...(opts.agents?.agents.length ? agentSkills : []),
      ...(opts.memory ? memorySkills : []),
      ...(opts.screen ? screenSkills : []),
      ...initiativeSkills.filter((s) => {
        if (['remind', 'reminders', 'cancel_reminder', 'snooze_reminder', 'reminder_done'].includes(s.id)) return Boolean(opts.reminders);
        if (s.id === 'missed') return Boolean(opts.news);
        if (s.id === 'task_status') return Boolean(opts.agents?.agents.length);
        if (s.id === 'set_project') return Boolean(opts.projects && opts.agents?.projects.length);
        if (s.id === 'create_routine') return Boolean(opts.routines);
        return true; // the briefing works with what there is
      }),
      ...trustSkills.filter((s) => (s.id === 'undo' || s.id === 'activity_report' ? Boolean(opts.actions) : s.id === 'permissions' ? Boolean(opts.trust) : true)),
    ];
    this.followUpMs = opts.followUpMs ?? 30_000;
    this.requireWakeWord = opts.requireWakeWord ?? true;
    this.replyTimeoutMs = opts.replyTimeoutMs ?? 60_000;
    const words = (opts.wakeWords ?? wakeWordsFor(this.name))
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
    this.wakeRe = words.length ? new RegExp(`\\b(?:${words.join('|')})\\b[,.!?]?`, 'i') : /$^/;
  }

  async init() {
    this.apps = await this.opts.platform.listApps().catch(() => []);
  }

  private get name() {
    return this.opts.name?.trim() || 'Nova';
  }

  hello(): ServerEvent {
    return {
      type: 'hello',
      name: this.name,
      engine: this.opts.engine.name,
      brain: this.opts.reasoning?.name ?? null,
      apps: this.apps.length,
      wakeWords: this.opts.wakeWords ?? wakeWordsFor(this.name),
      requireWakeWord: this.requireWakeWord,
      agents: this.opts.agents?.agents ?? [],
      projects: this.opts.agents?.projects ?? [],
      ui: this.opts.ui ?? DEFAULT_UI,
      hearing: this.opts.hearing ?? { engine: 'browser', state: 'ready' },
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

  /**
   * Something the user said or typed. `shortcut`: said while they held (or right after they tapped)
   * the talk shortcut, so it's meant for Nova whether or not it has the wake word.
   */
  async handle(raw: string, source: 'voice' | 'keyboard' | 'shortcut' = 'voice'): Promise<void> {
    try {
      await this.process(raw, source);
    } finally {
      // A routine waiting on an answer goes on; an agent kept waiting gets its question.
      if (!this.pending && this.routineRest) await this.continueRoutine();
      this.nextApproval();
    }
  }

  /**
   * Say something Nova brings up itself - a reminder, an agent's result - once the daemon has
   * decided it's a good moment. Nova listens for a reply after it.
   */
  tell(text: string) {
    this.announce(text);
  }

  /** Run a routine's steps in order, each as if the user had said it. A step that asks something waits for the answer. */
  async runRoutine(routine: Routine) {
    this.activity(`Routine: ${routine.name}`, 'done', undefined, { by: 'you' });
    this.routineRest = { name: routine.name, steps: [...routine.steps] };
    await this.continueRoutine();
  }

  private async continueRoutine() {
    while (this.routineRest && !this.pending) {
      const step = this.routineRest.steps.shift();
      if (step === undefined) {
        this.routineRest = null;
        return;
      }
      const by = `routine: ${this.routineRest.name}`;
      if (!this.routineRest.steps.length) this.routineRest = null;
      await this.process(step, 'routine', by);
    }
    this.nextApproval(); // an agent kept waiting through the routine gets its question
  }

  speechFinished() {
    this.openWindow();
  }

  /** The user summoned Nova (the shortcut, the menu bar): listen now, no wake word needed. */
  listenNow() {
    this.openWindow();
  }

  /** The user closed the listening window (tapped the shortcut again): wait for the wake word. */
  stopListening() {
    this.followUpUntil = 0;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.current === 'listening') this.phase('idle');
  }

  /**
   * The user talked over Nova: stop the answer being written (the shell stops the audio), and
   * listen. Unlike cancel(), a question Nova asked ("Quit Spotify?") is still waiting for its answer.
   */
  interrupt() {
    // Talking over a question the brain waits on is answering it: that answer carries on.
    const answering = this.pending?.kind === 'approval' && this.thinking !== null && this.pending.approval.thinking === this.thinking;
    if (!answering) this.stopThinking();
    this.openWindow();
  }

  cancel() {
    this.stopThinking();
    if (this.pending?.kind === 'approval') this.settleApproval(false);
    else if (this.pending) {
      this.activity(`Cancelled: ${this.pending.prompt}`, 'cancelled', this.pending.skill, { by: this.pending.by });
      this.settleQuestion(this.pending);
    }
    this.pending = null;
    this.routineRest = null; // a routine waiting on that answer ends here
    this.phase('idle');
    this.nextApproval();
  }

  // --- Tools: Nova's skills, for the agents and models that answer open questions ---------

  specs(): ToolSpec[] {
    return [...this.skills.map(skillTool), ...(this.opts.integrations?.specs() ?? [])];
  }

  /**
   * Run a skill for an agent or model. The same rules as voice apply: the risk tier comes from
   * the skill's code, never from the caller, so risky tools are confirmed out loud first.
   */
  async call(name: string, args: Record<string, unknown>, caller: string): Promise<ToolOutput> {
    const skill = this.skills.find((s) => s.id === name);
    if (!skill) return this.callIntegration(name, args, caller);
    const call = { name, ok: false };
    this.lesson?.calls.push(call);
    const arg = (key: string) => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
    // What to do comes from the request itself - never an example standing in for one left out.
    if (skill.needsRequest && !arg('request')) return `${name} needs "request": what to do, in plain words - like "${skill.examples[0]}". Nothing was done.`;
    const utterance = arg('request') || name.replace(/_/g, ' ');
    const resolved: Resolved = {};
    if (skill.needsApp) {
      resolved.app = this.findName(arg('app') || arg('request'), this.apps);
      if (!resolved.app) return `No installed app matches "${arg('app') || arg('request')}".`;
    }
    if (skill.needsProject) {
      const projects = this.opts.agents?.projects ?? [];
      resolved.project = this.findName(arg('project'), projects);
      if (!resolved.project) return `No project matches "${arg('project')}". The projects are: ${projects.join(', ')}.`;
    }
    if (skill.needsAgents) resolved.agent = this.agentRef(arg('agent')) ?? this.opts.agents?.agents[0];
    else if (skill.namesAgent && arg('agent')) {
      // "Undo what Claude did": Claude's - never the latest of anyone's instead.
      const named = arg('agent').toLowerCase();
      resolved.agent = this.opts.agents?.agents.find((a) => a.name.toLowerCase() === named || a.label.toLowerCase() === named);
      if (!resolved.agent) return `No paired agent is called "${arg('agent')}". Nothing was done.`;
    }
    // The user's words behind the call are what Nova heard while the brain answered; without a question in
    // flight (an agent working on its own) the user said nothing, and the request's own wording never counts.
    const context = this.context(utterance, resolved, this.answering ?? '');
    context.prepared = skill.prepare?.(context);
    const gate = gateFor(skill.tierFor?.(context) ?? skill.tier);
    if (gate === 'tap') return `${skill.tapPrompt?.(context) ?? 'That needs a confirmation on screen.'} It was not done.`;
    if (gate === 'confirm') {
      const remember = skill.rememberAs?.(context);
      if (!(remember && this.opts.trust?.allows(remember.key))) {
        const prompt = skill.confirmPrompt?.(context) ?? `${caller} wants to ${name.replace(/_/g, ' ')}. Allow it?`;
        const allowed = await this.approve(prompt, `${caller}: ${name.replace(/_/g, ' ')}`, { remember: remember ?? undefined, thinking: this.thinking ?? undefined });
        if (!allowed) return 'The user said no, so it was not done.';
      }
    }
    try {
      const result = await skill.run(context);
      if (result.card) this.card(result.card);
      this.activity(`${result.activity} · for ${caller}`, 'done', skill, { by: caller, undo: result.undo });
      call.ok = true;
      const text = result.data ?? result.say;
      return result.image ? { text, image: result.image } : text;
    } catch (error) {
      this.activity(`${name.replace(/_/g, ' ')} failed`, 'failed', skill);
      return `That didn't work: ${(error as Error).message}`;
    }
  }

  /**
   * A tool of an integration (Notion, Linear, ...). The tier comes from the user's choice for it,
   * never from the service or the caller: tools they didn't allow are confirmed out loud first.
   */
  private async callIntegration(name: string, args: Record<string, unknown>, caller: string): Promise<string> {
    const tool = this.opts.integrations?.specs().find((t) => t.name === name);
    if (!tool) return `There's no tool called ${name}.`;
    const call = { name, ok: false };
    this.lesson?.calls.push(call);
    // The user's choice sets the tier; a tool they didn't allow that moves money needs a tap on screen, whatever the hub said.
    const gate = gateFor(tool.tier >= 2 && toolRisk(name) === 'money' ? 3 : tool.tier);
    if (gate === 'tap') return `Moving money through ${tool.label} needs a tap on screen, never a spoken yes - so it was not done.`;
    // "Yes, always" is remembered only for a tool that just reads; the user allows any other in Settings → Integrations.
    const action = name.slice(name.indexOf('__') + 2).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
    const remember = mayRememberTool(tool) ? { key: `tool:${name}`, label: `Use ${tool.label} to ${action}` } : undefined;
    if (gate === 'confirm' && !(remember && this.opts.trust?.allows(remember.key))) {
      const allowed = await this.approve(`${caller} wants to use ${tool.summary(args)}. Allow it?`, `${caller}: ${tool.label}`, { remember, thinking: this.thinking ?? undefined });
      if (!allowed) return 'The user said no, so it was not done.';
    }
    try {
      const text = await this.opts.integrations!.call(name, args, this.thinking?.signal);
      this.activity(`${tool.summary(args)} · for ${caller}`, 'done', undefined, { by: caller, tier: tool.tier });
      call.ok = true;
      return text;
    } catch (error) {
      this.activity(`${tool.label} failed`, 'failed', undefined, { by: caller });
      return `That didn't work: ${(error as Error).message}`;
    }
  }

  /** The best match for a spoken or typed name among known ones (apps, projects). */
  private findName(query: string, names: string[]): string | undefined {
    const words = nameTokens(query);
    let best: { name: string; score: number } | undefined;
    for (const name of names) {
      const m = matchName(words, aliasesFor(name));
      if (m && m.score >= 0.6 && (!best || m.score > best.score)) best = { name, score: m.score };
    }
    return best?.name;
  }

  // ---------------------------------------------------------------------------

  private async process(raw: string, source: 'voice' | 'keyboard' | 'shortcut' | 'routine', by = 'you') {
    const text = raw.trim();
    if (!text) return;
    const wake = this.stripWake(text);
    // The question this may answer, as it stands now: an answer is only ever for it, though another may take its place while this is decided.
    const asked = this.pending;
    const inWindow = !this.requireWakeWord || this.now() < this.followUpUntil || asked !== null;
    const explicit = wake.found || source !== 'voice';

    if (!explicit && !inWindow) return; // not for us
    if (wake.found && !wake.rest) {
      this.openWindow();
      return;
    }
    const utterance = wake.found ? wake.rest : text;
    // A routine's own phrase ("start work") starts it - matched in code, like a name. Steps never start routines.
    const routine = source === 'routine' || asked ? null : this.routineFor(utterance);
    if (routine) return this.runRoutine(routine);
    this.phase('thinking');

    const pendingSlot = asked?.kind === 'slot' ? asked : null;
    let decision;
    try {
      decision = await this.opts.engine.decide(
        {
          utterance,
          wakeWordUsed: explicit,
          awaitingConfirmationFor: asked?.kind === 'confirm' ? asked.skill.id : asked?.kind === 'approval' ? 'agent_step' : null,
          awaitingAppFor: pendingSlot?.slot === 'app' ? pendingSlot.skill.id : null,
          awaitingProjectFor: pendingSlot?.slot === 'project' ? pendingSlot.skill.id : null,
          activeTasks: this.tasks.size,
          activeTimers: this.activeTimers(),
          canThink: Boolean(this.opts.reasoning),
          recentTurns: this.history.slice(-3),
        },
        buildQuestions(this.skills, this.apps, utterance, this.opts.agents, this.name),
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
    const app = picked(answers.app);
    const project = picked(answers.project);
    const named = this.agentRef(picked(answers.agent));

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

    // The question changed while this was decided (withdrawn, run out, another in its place): a yes or no is never
    // applied to one it wasn't said to - the one waiting now is asked again.
    const answer = intent === 'confirm_yes' || intent === 'confirm_no' || intent === 'stop';
    if (this.pending !== asked && answer) {
      trace('the question changed while deciding');
      const now = this.pending;
      const gone = asked ? 'Sorry, that question went away just as you answered.' : '';
      const again = now ? (now.kind === 'approval' ? now.approval.prompt : now.prompt) : '';
      return this.say(utterance, [gone, again].filter(Boolean).join(' ') || 'Okay.');
    }
    const pending = this.pending === asked ? asked : null;
    if (pending?.kind === 'approval') {
      // An agent is waiting on a yes or no. Anything else is handled normally while it keeps waiting.
      if (answer) {
        const ok = intent === 'confirm_yes';
        trace(ok ? 'allowed agent step' : 'refused agent step');
        const remembered = ok ? this.rememberYes(pending.approval.remember, utterance) : '';
        this.settleApproval(ok);
        return this.say(utterance, ok ? `Okay, go ahead.${remembered}` : 'Okay, I told it no.');
      }
    } else if (pending) {
      // Resolve what Nova asked about last turn.
      this.settleQuestion(pending);
      if (pending.kind === 'confirm') {
        if (intent === 'confirm_yes') {
          trace(`confirmed ${pending.skill.id}`);
          this.opts.engine.learn?.({ utterance: pending.utterance, question: 'intent', choice: pending.skill.id, source: 'confirmed' });
          const ctx = { ...this.context(pending.utterance, pending.resolved), prepared: pending.prepared };
          const remembered = this.rememberYes(pending.skill.rememberAs?.(ctx), utterance);
          return this.execute(pending.skill, pending.utterance, pending.resolved, utterance, pending.by, remembered, pending.prepared);
        }
        if (intent === 'confirm_no' || intent === 'stop') {
          trace(`declined ${pending.skill.id}`);
          this.activity(`Cancelled ${pending.skill.id.replace('_', ' ')}`, 'cancelled', pending.skill);
          return this.say(utterance, 'Okay, I left it.');
        }
      }
      if (pending.kind === 'slot' && pending.slot === 'when' && intent !== 'stop') {
        // "When should I remind you?" - "at 5": the first request, with its time.
        if (parseWhen(utterance, new Date(this.now()))) {
          trace(`${pending.skill.id} → ${utterance}`);
          return this.route(pending.skill, `${pending.utterance} ${utterance}`, pending.resolved, 1, pending.by);
        }
      } else if (pending.kind === 'slot' && intent !== 'stop') {
        const value = pending.slot === 'app' ? app : project;
        if (value) {
          trace(`${pending.skill.id} → ${value}`);
          // Answering "Which app?" confirms what the first request meant.
          this.opts.engine.learn?.({ utterance: pending.utterance, question: 'intent', choice: pending.skill.id, source: 'clarified' });
          return this.route(pending.skill, pending.utterance, { ...pending.resolved, [pending.slot]: value }, 1, pending.by);
        }
      }
    }

    const skill = this.skills.find((s) => s.id === intent);
    // Several things at once: the brain can do them all with its tools; one skill would do only the first.
    if (skill && !skill.wholeUtterance && this.opts.reasoning && isCompound(utterance)) {
      trace(`several steps → ${this.opts.reasoning.name}`);
      return this.think(utterance);
    }
    if (skill) {
      // No project named: the one the user is working on, for skills that take it.
      const current = skill.usesCurrentProject && !project ? (this.opts.projects?.current ?? undefined) : undefined;
      const resolved: Resolved = { app, project: project ?? current, agent: named ?? (skill.needsAgents ? this.opts.agents?.agents[0] : undefined) };
      if (skill.declines?.(this.context(utterance, resolved))) {
        trace(`not ${skill.id} → ${named?.label ?? this.opts.reasoning?.name ?? 'no brain'}`);
        return this.think(utterance, named);
      }
      trace(`${skill.id}${describe(skill, resolved)} (p=${intentP.toFixed(2)})`);
      return this.route(skill, utterance, resolved, intentP, by);
    }

    trace(named && intent === 'chat' ? `chat → ${named.label}` : intent);
    switch (intent) {
      case 'stop':
        this.thinking?.abort();
        return this.say(utterance, 'Okay.');
      case 'confirm_yes':
      case 'confirm_no':
        // Nothing of Nova's is waiting on a yes or no: it answers the brain's last question, if any.
        if (this.opts.reasoning) return this.think(utterance);
        return this.say(utterance, "There's nothing waiting for confirmation.");
      default:
        // Nothing Nova was waiting on, and no agent named: if the brain answers with one of Nova's skills, System 1 learns it.
        return this.think(utterance, named, { teach: !named && !pending });
    }
  }

  private async route(skill: Skill, utterance: string, resolved: Resolved, p: number, by = 'you') {
    const ctx = this.context(utterance, resolved);
    // What the request is about, settled now: a yes to "Undo …?" takes back that, whatever came in since.
    ctx.prepared = skill.prepare?.(ctx);
    const tier = skill.tierFor?.(ctx) ?? skill.tier;
    // A tap on screen, never a spoken yes (cancelling all the reminders): nothing is done, so saying where to do it
    // needs only a fair idea of what was meant.
    if (gateFor(tier) === 'tap' && p >= MIN_CONFIDENCE[1]) {
      return this.say(utterance, skill.tapPrompt?.(ctx) ?? 'That needs a confirmation on screen.');
    }
    if (p < MIN_CONFIDENCE[tier]) {
      return this.say(utterance, "Sorry, I'm not sure what you meant. Could you say that again?");
    }
    if (skill.needsApp && !resolved.app) {
      this.ask({ kind: 'slot', id: uid(), prompt: 'Which app?', slot: 'app', skill, resolved, utterance, by });
      return this.say(utterance, 'Which app?');
    }
    if (skill.needsProject && !resolved.project) {
      this.ask({ kind: 'slot', id: uid(), prompt: 'Which project?', slot: 'project', skill, resolved, utterance, by });
      return this.say(utterance, 'Which project?');
    }
    if (gateFor(tier) === 'confirm') {
      // Something the user said "yes, always" to: no need to ask.
      const remember = skill.rememberAs?.(ctx);
      if (remember && this.opts.trust?.allows(remember.key)) return this.execute(skill, utterance, resolved, utterance, by, '', ctx.prepared);
      const prompt = skill.confirmPrompt?.(ctx) ?? 'Are you sure?';
      const id = uid();
      this.ask({ kind: 'confirm', id, prompt, skill, resolved, utterance, by, prepared: ctx.prepared });
      this.card({ id, kind: 'confirm', title: prompt, body: remember ? 'Say "yes", "yes, always" or "no"' : 'Say "yes" or "no"' });
      this.activity(prompt, 'pending', skill, { by });
      return this.say(utterance, prompt);
    }
    return this.execute(skill, utterance, resolved, utterance, by, '', ctx.prepared);
  }

  /**
   * Run a skill for what was asked; `said` is this turn's words when they differ (the "yes" to
   * "Quit Spotify?"), `by` who asked, `also` anything to add to what Nova says, and `prepared`
   * what the skill settled when the request came in.
   */
  private async execute(skill: Skill, utterance: string, resolved: Resolved, said = utterance, by = 'you', also = '', prepared?: unknown) {
    this.phase('acting', skill.id);
    try {
      const result = await skill.run({ ...this.context(utterance, resolved), prepared });
      if (result.card) this.card(result.card);
      this.activity(result.activity, 'done', skill, { by, undo: result.undo });
      // It needs a time: the next thing said can be one ("When should I remind you?" - "at 5").
      if (result.needs === 'when') this.ask({ kind: 'slot', id: uid(), prompt: result.say, slot: 'when', skill, resolved, utterance, by });
      // A brain gives the answer, with the user's services at hand (the briefing); without one, the plain one does.
      if (result.handoff && this.opts.reasoning) return this.think(said, undefined, { question: result.handoff });
      this.say(said, `${result.say}${also}`);
    } catch (error) {
      this.activity(`${skill.id} failed`, 'failed', skill, { by });
      this.say(said, `Sorry, that didn't work. ${(error as Error).message}`);
    }
  }

  /** Hand an utterance to a brain. `question`: what to ask instead of the words themselves (history keeps the words). */
  private async think(utterance: string, agent?: AgentRef, opts: { teach?: boolean; question?: string } = {}) {
    const host = this.opts.agents;
    const brain: ReasoningBrain | null | undefined =
      agent && host ? (host.brain?.(agent.name) ?? { name: agent.label, reply: (u, h, signal) => host.ask(agent.name, u, h, signal) }) : this.opts.reasoning;
    if (!brain) {
      return this.say(utterance, "I can't answer that yet. Pair an agent, or choose who answers open questions in Settings → Answers.");
    }
    this.phase('thinking', brain.name);
    this.stopThinking();
    const thinking = (this.thinking = new AbortController());
    const signal = AbortSignal.any([thinking.signal, AbortSignal.timeout(this.replyTimeoutMs)]);
    const history = this.history.slice(-6);
    const lesson: Lesson | null = opts.teach ? (this.lesson = { calls: [] }) : null;
    this.answering = utterance;
    try {
      // Notes go with the question (what the user is in, related memories); the history keeps their own words.
      const notes = await this.notesFor(utterance);
      const asked = opts.question ?? utterance;
      const question = notes ? `${notes}\n\n${asked}` : asked;
      // A brain that streams is spoken sentence by sentence while it's still writing.
      const reply = brain.stream ? await this.speakAsWritten(brain.stream(question, history, signal)) : await brain.reply(question, history, signal);
      if (thinking.signal.aborted) return;
      // The brain did it with exactly one skill, and it worked: next time System 1 can do it straight away.
      const only = lesson?.calls.length === 1 ? lesson.calls[0]! : null;
      const skill = only && this.skills.find((s) => s.id === only.name);
      if (only?.ok && skill && !skill.informs) {
        this.opts.engine.learn?.({ utterance, question: 'intent', choice: only.name, source: 'brain' });
      }
      if (!reply) return this.say(utterance, `Sorry, ${brain.name} didn't say anything.`);
      this.card({ id: uid(), kind: 'answer', title: utterance, body: reply });
      this.activity(`Asked ${brain.name}`, 'done');
      if (brain.stream) this.remember(utterance, reply);
      else this.say(utterance, reply);
    } catch (error) {
      if (thinking.signal.aborted) return; // the user said stop
      this.activity(`${brain.name} failed`, 'failed');
      this.say(utterance, `Sorry, ${brain.name} didn't respond. ${(error as Error).message}`);
    } finally {
      if (this.thinking === thinking) this.thinking = null;
      if (this.lesson === lesson) this.lesson = null;
      if (this.answering === utterance) this.answering = null;
      // What it was still waiting to be allowed goes with it: a late yes runs nothing.
      this.withdraw((a) => a.thinking === thinking);
      this.nextApproval();
    }
  }

  /** Stop the answer being written - and withdraw what it was waiting to be allowed. */
  private stopThinking() {
    const thinking = this.thinking;
    if (!thinking) return;
    thinking.abort();
    this.withdraw((a) => a.thinking === thinking);
  }

  /** Timers running now: Nova's own, and the countdowns the reminder service keeps (which outlast a restart). */
  private activeTimers() {
    const now = this.now();
    return this.timers.size + (this.opts.reminders?.list().filter((r) => r.countdown && r.due !== null && r.due > now).length ?? 0);
  }

  /** The notes for a question, or none - never holding the answer up for long. */
  private async notesFor(utterance: string): Promise<string | null> {
    if (!this.opts.notes) return null;
    const late = new Promise<null>((resolve) => setTimeout(() => resolve(null), 700));
    return Promise.race([this.opts.notes(utterance).catch(() => null), late]);
  }

  /**
   * Speak a reply as it's written: each finished sentence goes out as the brain produces it.
   * A question that has to interrupt (a tool asking permission) ends what was said so far;
   * whatever comes after starts afresh.
   */
  private async speakAsWritten(pieces: AsyncIterable<string>): Promise<string> {
    let full = '';
    let segment: { id: string; text: string; sent: number } | null = null;
    const emit = (final: boolean) => {
      const s = segment;
      if (!s) return;
      const end = final ? s.text.length : lastSentenceEnd(s.text);
      if (end > s.sent || (final && s.sent > 0)) {
        if (s.sent === 0) {
          this.followUpUntil = this.now() + this.followUpMs;
          this.phase('speaking');
        }
        s.sent = end;
        this.emit({ type: 'say', id: s.id, text: s.text.slice(0, end).trim(), partial: !final });
      }
      if (final) segment = null;
    };
    this.flushReply = () => emit(true);
    try {
      for await (const piece of pieces) {
        full += piece;
        segment ??= { id: uid(), text: '', sent: 0 };
        segment.text += piece;
        emit(false);
      }
    } finally {
      this.flushReply = null;
    }
    emit(true);
    return full.trim();
  }

  private context(utterance: string, resolved: Resolved, heard = utterance): SkillContext {
    return {
      utterance,
      heard,
      memory: this.opts.memory ?? undefined,
      screen: this.opts.screen ?? undefined,
      reminders: this.opts.reminders ?? undefined,
      briefing: this.opts.briefing ?? undefined,
      news: this.opts.news ?? undefined,
      projects: this.opts.projects ?? undefined,
      routines: this.opts.routines ?? undefined,
      actions: this.opts.actions ?? undefined,
      trust: this.opts.trust ?? undefined,
      halt: () => this.stopEverything(),
      agents: this.opts.agents?.agents,
      ...resolved,
      platform: this.opts.platform,
      timers: this.timerService,
      tasks: this.taskService,
      shell: {
        setListening: (on) => this.emit({ type: 'listen', on }),
        openSettings: () => this.emit({ type: 'show', panel: 'settings' }),
      },
    };
  }

  /** The routine whose phrase this is: "start work" said for "when I say start work". Close wording counts, loosely. */
  private routineFor(utterance: string): Routine | null {
    const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
    const said = words(utterance).filter((w) => !['please', 'nova', 'now', 'okay', 'ok', 'hey', 'lets', "let's"].includes(w));
    if (!said.length || said.length > 8) return null;
    for (const routine of this.opts.routines?.list() ?? []) {
      if (!routine.phrase) continue;
      const phrase = words(routine.phrase);
      const shared = phrase.filter((w) => said.includes(w)).length;
      if (phrase.length && shared === phrase.length && said.length <= phrase.length + 1) return routine;
    }
    return null;
  }

  /** Nova's own news: to the daemon, which picks the moment - or said at once. */
  private news(news: News) {
    if (news.card) this.card(news.card);
    if (this.opts.deliver) return this.opts.deliver(news);
    this.announce(news.text);
  }

  private agentRef(name?: string): AgentRef | undefined {
    return name ? this.opts.agents?.agents.find((a) => a.name === name) : undefined;
  }

  /** Ask the user something new; an agent waiting for a yes or no is asked again afterwards (its time keeps running). */
  private ask(next: Question) {
    const was = this.pending;
    if (was?.kind === 'approval') {
      this.emit({ type: 'dismiss', id: was.id });
      this.approvals.unshift(was.approval);
    } else if (was) this.settleQuestion(was);
    next.timer = setTimeout(() => this.expire(next), QUESTION_TIMEOUT_MS);
    this.pending = next;
  }

  /** A question of Nova's is answered or dropped: its time stops, its card goes. */
  private settleQuestion(question: Question) {
    clearTimeout(question.timer);
    if (question.kind === 'confirm') this.emit({ type: 'dismiss', id: question.id });
    if (this.pending === question) this.pending = null;
  }

  /** Nobody answered Nova's question: it's dropped, card and all, and noted - a routine waiting on it ends there. */
  private expire(question: Question) {
    if (this.pending !== question) return;
    this.settleQuestion(question);
    this.activity(`No answer - left it: ${question.prompt}`, 'cancelled', question.skill, { by: question.by });
    if (this.routineRest && question.by === `routine: ${this.routineRest.name}`) this.routineRest = null;
    if (this.current === 'listening' && this.now() >= this.followUpUntil) this.phase('idle');
    this.nextApproval();
  }

  private readonly timerService: TimerService = {
    start: (ms, label) => {
      const id = uid();
      this.timers.set(
        id,
        setTimeout(() => {
          this.timers.delete(id);
          this.emit({ type: 'dismiss', id });
          this.activity(`Timer finished · ${label}`, 'done');
          this.news({ kind: 'timer', title: `Timer done · ${label}`, text: `Your timer for ${label} is done.`, card: { id: uid(), kind: 'timer', title: `Timer done · ${label}` } });
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

  /** Agent tasks run in the background: a live card narrates each step, and Nova speaks up when it's done. */
  private readonly taskService: TaskService = {
    start: (agent, task, project) => this.startTask(agent, task, project),
    cancelAll: () => {
      const n = this.tasks.size;
      for (const controller of this.tasks.values()) controller.abort();
      return n;
    },
    status: () => ({
      running: [...this.running.values()],
      recent: (this.opts.taskHistory?.() ?? []).filter((t) => t.status !== 'running' && !this.running.has(t.id)),
    }),
  };

  /** Stop one agent task (the task board's Stop). */
  cancelTask(id: string) {
    const controller = this.tasks.get(id);
    controller?.abort();
    return Boolean(controller);
  }

  /** Run a task again (the task board's Retry) - the user asked in so many words, so it isn't asked again. */
  retryTask(task: Pick<TaskRecord, 'agent' | 'task' | 'project'>) {
    const agent = this.agentRef(task.agent);
    if (!agent || !this.opts.agents?.projects.includes(task.project)) return null;
    return this.startTask(agent, task.task, task.project);
  }

  private startTask(agent: AgentRef, task: string, project: string) {
    const host = this.opts.agents;
    if (!host) throw new Error('No agents are paired.');
    const id = uid();
    const controller = new AbortController();
    this.tasks.set(id, controller);
    const record: TaskRecord = { id, agent: agent.name, label: agent.label, project, task, status: 'running', started: this.now() };
    this.running.set(id, record);
    const update = (changes: Partial<TaskRecord>) => {
      Object.assign(record, changes);
      this.opts.onTask?.({ ...record });
    };
    update({});
    const title = `${agent.label} · ${project}`;
    const show = (body: string) => this.card({ id, kind: 'task', title, body, agent: agent.name });
    show('Starting…');
    /** How to put the project back as it was: taken once the agent is done, whatever the outcome. */
    const undoOf = () => (this.opts.afterTask ? this.opts.afterTask({ ...record }).catch(() => null) : Promise.resolve(null));
    const stopped = async () => {
      this.emit({ type: 'dismiss', id });
      this.activity(`${agent.label} stopped in ${project}`, 'cancelled', undefined, { by: agent.label, undo: (await undoOf()) ?? undefined });
      update({ status: 'cancelled', ended: this.now() });
    };

    // Start once Nova's acknowledgement is out, so the agent's first question comes after it -
    // and once the project's snapshot is taken, so what the agent changes can be undone.
    setTimeout(async () => {
      if (controller.signal.aborted) {
        this.tasks.delete(id);
        this.running.delete(id);
        return stopped();
      }
      await this.opts.beforeTask?.({ ...record }).catch(() => {});
      host
        .run(
          agent.name,
          task,
          project,
          {
            onStep: (step) => {
              show(step.text);
              update({ step: step.text });
              this.opts.onTaskStep?.({ ...record }, step);
              if (step.kind === 'command' || step.kind === 'edit') this.activity(`${agent.label}: ${step.text}`, 'done', undefined, { by: agent.label });
            },
            approve: (request) => this.requestApproval(id, agent, project, request),
          },
          controller.signal,
        )
        .then(
          async (report) => {
            this.emit({ type: 'dismiss', id });
            this.activity(`${agent.label} finished in ${project}`, 'done', undefined, { by: agent.label, undo: (await undoOf()) ?? undefined });
            update({ status: 'done', report: report || 'Done.', ended: this.now() });
            this.news({
              kind: 'task',
              ref: id,
              title: `${agent.label} finished · ${project}`,
              text: spokenSummary(report) || `${agent.label} finished in ${project}.`,
              card: { id: uid(), kind: 'answer', title: `${agent.label} finished · ${project}`, body: report || 'Done.' },
            });
          },
          async (error) => {
            if (controller.signal.aborted) return stopped();
            this.emit({ type: 'dismiss', id });
            this.activity(`${agent.label} failed in ${project}`, 'failed', undefined, { by: agent.label, undo: (await undoOf()) ?? undefined });
            update({ status: 'failed', report: (error as Error).message, ended: this.now() });
            this.news({ kind: 'task', ref: id, title: `${agent.label} couldn't finish · ${project}`, text: `${agent.label} couldn't finish in ${project}. ${(error as Error).message}` });
          },
        )
        .finally(() => {
          this.tasks.delete(id);
          this.running.delete(id);
          this.dropApprovals(id);
        });
    }, 0);
    return id;
  }

  /**
   * An agent asks to do something. "Yes, always" remembers exactly this - this agent, this project,
   * this tool, this command - and never a risky command (deleting, force, superuser).
   */
  private requestApproval(taskId: string, agent: AgentRef, project: string, request: ApprovalRequest): Promise<boolean> {
    const detail = request.detail?.replace(/\s+/g, ' ').trim() ?? '';
    const risky = request.tool === 'Bash' && RISKY_COMMAND.test(detail);
    // Without a detail (the command, the site, the file) "always" would cover the whole tool: then it's asked each time.
    const remember = request.tool && detail && !risky ? { key: `agent:${agent.name}:${project}:${request.tool}:${detail}`, label: `${agent.label} may ${request.action} in ${project}` } : undefined;
    if (remember && this.opts.trust?.allows(remember.key)) {
      this.activity(`${agent.label}: ${request.action} (you said always)`, 'done', undefined, { by: agent.label });
      return Promise.resolve(true);
    }
    return this.approve(`${agent.label} wants to ${request.action} in ${project}. Allow it?`, `${agent.label} to ${request.action}`, { taskId, remember });
  }

  /**
   * Stop everything at once: the answer being written, what Nova is saying, agent tasks, questions
   * waiting for a yes, the routine under way - and mute the microphone. Returns the tasks stopped.
   */
  stopEverything() {
    this.stopThinking();
    this.emit({ type: 'barge-in' }); // every window, and Nova.app, stops speaking
    const tasks = this.tasks.size;
    for (const controller of this.tasks.values()) controller.abort();
    if (this.pending?.kind === 'approval') this.settleApproval(false, 'Refused - you stopped everything');
    else if (this.pending) this.settleQuestion(this.pending);
    for (const approval of this.approvals.splice(0)) {
      clearTimeout(approval.timer);
      approval.resolve(false);
    }
    this.pending = null;
    this.routineRest = null;
    this.emit({ type: 'listen', on: false });
    this.followUpUntil = 0;
    this.phase('idle');
    this.activity(`Stopped everything${tasks ? ` (${tasks === 1 ? 'one agent task' : `${tasks} agent tasks`})` : ''}`, 'done', undefined, { by: 'you' });
    return tasks;
  }

  /**
   * Ask the user a yes-or-no question out loud, queued behind any other. Its time runs from now, so it's
   * refused if nobody answers - even while another question holds it up.
   */
  private approve(prompt: string, summary: string, extra: Pick<Approval, 'taskId' | 'remember' | 'thinking'> = {}): Promise<boolean> {
    return new Promise((resolve) => {
      this.flushReply?.(); // finish the sentence being spoken first
      const approval: Approval = { ...extra, prompt, summary, resolve, deadline: this.now() + APPROVAL_TIMEOUT_MS };
      approval.timer = setTimeout(() => this.expireApproval(approval), APPROVAL_TIMEOUT_MS);
      this.approvals.push(approval);
      if (!this.pending) this.nextApproval();
    });
  }

  /** No answer in time: refused, whether it was being asked or still waiting its turn. */
  private expireApproval(approval: Approval) {
    const note = `No answer - refused ${approval.summary}`;
    if (this.pending?.kind === 'approval' && this.pending.approval === approval) {
      this.settleApproval(false, note);
      this.nextApproval();
    } else if (this.approvals.includes(approval)) {
      this.approvals = this.approvals.filter((a) => a !== approval);
      this.activity(note, 'cancelled');
      approval.resolve(false);
    }
  }

  private nextApproval() {
    if (this.pending) return;
    const approval = this.approvals.shift();
    if (!approval) return;
    // However long it waited behind others, the user has a moment to answer it.
    if (approval.deadline - this.now() < ANSWER_MIN_MS) {
      clearTimeout(approval.timer);
      approval.deadline = this.now() + ANSWER_MIN_MS;
      approval.timer = setTimeout(() => this.expireApproval(approval), ANSWER_MIN_MS);
    }
    const id = uid();
    this.pending = { kind: 'approval', id, approval };
    this.card({ id, kind: 'confirm', title: approval.prompt, body: approval.remember ? 'Say "yes", "yes, always" or "no"' : 'Say "yes" or "no"' });
    this.announce(approval.prompt);
  }

  private settleApproval(ok: boolean, note?: string) {
    const pending = this.pending;
    if (pending?.kind !== 'approval') return;
    this.pending = null;
    clearTimeout(pending.approval.timer);
    this.emit({ type: 'dismiss', id: pending.id });
    this.activity(note ?? `${ok ? 'Allowed' : 'Refused'} ${pending.approval.summary}`, ok ? 'done' : 'cancelled');
    pending.approval.resolve(ok);
  }

  /** Questions whose asker is gone (a task that ended, an answer that stopped) are withdrawn: told no. */
  private withdraw(gone: (approval: Approval) => boolean) {
    for (const a of this.approvals.filter(gone)) {
      clearTimeout(a.timer);
      a.resolve(false);
    }
    this.approvals = this.approvals.filter((a) => !gone(a));
    if (this.pending?.kind === 'approval' && gone(this.pending.approval)) this.settleApproval(false, `Withdrawn: ${this.pending.approval.summary}`);
  }

  /** A finished or stopped task's open questions are withdrawn. */
  private dropApprovals(taskId: string) {
    this.withdraw((a) => a.taskId === taskId);
    this.nextApproval();
  }

  private openWindow() {
    this.followUpUntil = this.now() + this.followUpMs;
    this.phase('listening');
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.requireWakeWord) return; // conversation mode never goes idle
    this.idleTimer = setTimeout(() => {
      // Only a quiet listening window goes idle - never mid-thought or mid-reply.
      if (this.current === 'listening' && this.now() >= this.followUpUntil && !this.pending) this.phase('idle');
    }, this.followUpMs + 50);
  }

  private say(user: string, text: string) {
    this.remember(user, text);
    this.announce(text);
  }

  private remember(user: string, text: string) {
    this.history.push({ user, nova: text });
    if (this.history.length > 20) this.history.shift();
    this.opts.onTurn?.({ user, nova: text });
  }

  /**
   * Speak without a user turn (task results, approvals). Opens the follow-up window as Nova
   * speaks, not only once the shell reports speech finished, so slow speech recognition or a
   * lost 'speech-finished' never forces the wake word.
   */
  private announce(text: string) {
    this.followUpUntil = this.now() + this.followUpMs;
    this.emit({ type: 'say', text });
    this.phase('speaking');
  }

  private card(card: Card) {
    this.emit({ type: 'card', card });
  }

  /** Something Nova did, for the timeline and the record: who asked, and how to take it back. */
  private activity(label: string, status: ActivityItem['status'], skill?: Skill, extra: { by?: string; undo?: UndoStep; tier?: ActivityItem['tier'] } = {}) {
    const item: ActivityItem = { id: uid(), at: this.now(), label, status, skill: skill?.id, tier: extra.tier ?? skill?.tier, by: extra.by, undoable: Boolean(extra.undo) || undefined };
    this.emit({ type: 'activity', item, ...(extra.undo ? { undo: extra.undo } : {}) });
  }

  /** Remember a "yes, always" (or "for today"): only for what may be remembered. */
  private rememberYes(remember: { key: string; label: string } | null | undefined, said: string) {
    const scope = alwaysIn(said);
    if (!scope || !this.opts.trust) return '';
    // Said "always" to something that must be asked every time (a risky command, a tool that changes things): say so.
    if (!remember) return " I'll still ask each time for that one.";
    const today = new Date(this.now());
    const until = scope === 'today' ? `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}` : undefined;
    this.opts.trust.allow(remember.key, remember.label, until).catch((error: Error) => {
      this.emit({ type: 'error', message: `Couldn't save "${remember.label}" to Settings: ${error.message}` });
      this.activity(`Couldn't remember: ${remember.label}`, 'failed', undefined, { by: 'you' });
    });
    this.activity(`${scope === 'today' ? 'Allowed for today' : 'Allowed from now on'}: ${remember.label}`, 'done', undefined, { by: 'you' });
    return scope === 'today' ? " And I won't ask again today." : " And I won't ask again - you can change that in Settings.";
  }

  private phase(phase: Phase, label?: string) {
    this.current = phase;
    this.emit({ type: 'phase', phase, label });
  }

  private emit(event: ServerEvent) {
    this.opts.emit(event);
  }
}
