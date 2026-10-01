import { askingRule, isCompound, withTime, type PermissionMode, type QuestionHints, type ReasoningBrain, type ToolHost, type ToolSpec, type Turn } from '@nova/core';
import { calculated } from './calculate.ts';
import type { AppleModel, AppleQuestion } from './helper.ts';

/** Apple's model in Settings → Answers ("apple"), and its name when it answers. */
export const APPLE_BRAIN = 'apple';
export const APPLE_LABEL = 'Apple Intelligence';

/** At most this many of Nova's tools go with a question: a small model chooses well among a few, and they fill its context. */
export const MOST_TOOLS = 5;
/** The last question's tools stay at hand this long, for a follow-up ("yes, do that"). */
const FOLLOW_UP_MS = 120_000;
/**
 * A request to act goes with only this many of the last turns: a small model copies its own past replies, and ones
 * that say something was done (with no tool call to be seen) teach it to say so again instead of doing it.
 */
const ACTING_TURNS = 2;
/**
 * Tools Apple's model doesn't get: the computer's (seeing the screen and acting a step at a time takes more than
 * a small context holds), and the time (every question comes with it).
 */
const leftOut = (name: string) => name === 'computer_task' || name.startsWith('computer_') || name === 'tell_time';

/** The user means something on their screen. */
const ON_SCREEN = /\b(?:screen|window|tab|page|error|showing|looking at)\b|\bwhat(?:'s| is) (?:this|that)\b/i;
/** There's a sum to work out: numbers with an operation between them, or said in words. */
const SUMS = /\d\s*(?:[-+*/x×÷^%]|plus|minus|times|divided|multiplied|over|percent|to the power)\s*[\d(.]|\b(?:square root|squared|cubed|how much is|calculate|work out)\b/i;
/** Several things asked at once. */
const SEVERAL = /\b(?:and|then|also|after that)\b/i;
/** A question of its own ("what's my name?"), however short - not a reply to the last one. */
const ASKS = /^(?:what|what's|who|who's|where|when|why|how|which|whose|is|are|was|were|can|could|do|does|did|will|would|should)\b/i;

/** Nova's calculator, for Apple's model alone: it's small enough to get sums wrong, and arithmetic stays in code. */
export const CALCULATOR: ToolSpec = {
  name: 'calculate',
  description: 'Work out arithmetic exactly - e.g. 17 * 23, (120 - 15) / 4, 15% of 80, sqrt(2). Use it for every sum instead of working it out yourself.',
  parameters: {
    type: 'object',
    properties: { expression: { type: 'string', description: 'The arithmetic, in numbers and + - * / ^ ( ) %' } },
    required: ['expression'],
  },
};

/**
 * The few tools that go with a question, and whether it asks for something to be done. The tools: the
 * skills System 1 weighed for it - the one it picked and any others it gave a real chance, or its first
 * four for several things at once - looking at the screen when that's what's meant, the services the
 * user names, and, for a reply ("yes, do that"), the last question's tools. It asks to act when System 1
 * picked one of them, when several things are asked, when it's about the screen, or it's a yes to what
 * was just offered (`offered`: the last reply asked something).
 */
export function chooseTools(
  specs: ToolSpec[],
  hints: QuestionHints | undefined,
  carried: string[] = [],
  offered = false,
): { tools: ToolSpec[]; act: boolean; several: boolean } {
  const usable = new Map(specs.filter((s) => !leftOut(s.name)).map((s) => [s.name, s]));
  const heard = hints?.heard ?? '';
  const weighed = (hints?.skills ?? []).filter((s) => usable.has(s.id));
  const picked = Boolean(hints?.intent && usable.has(hints.intent));
  const several = isCompound(heard) || (hints?.intent !== 'chat' && SEVERAL.test(heard));
  const screen = ON_SCREEN.test(heard) && usable.has('look_at_screen');
  const names = several ? weighed.slice(0, 4).map((s) => s.id) : [];
  if (picked) names.push(hints!.intent!);
  names.push(...weighed.filter((s) => s.p >= 0.01).slice(0, 3).map((s) => s.id));
  if (screen) names.push('look_at_screen');
  // A service the user names ("add it to Linear"): its tools that share most words with what was said.
  const words = new Set(heard.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const named = [...usable.values()].filter((s) => {
    const label = (s as { label?: unknown }).label;
    return typeof label === 'string' && s.name.includes('__') && label.toLowerCase().split(/\s+/).every((w) => words.has(w));
  });
  const overlap = (s: ToolSpec) => `${s.name} ${s.description}`.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => words.has(w)).length ?? 0;
  names.push(...named.sort((a, b) => overlap(b) - overlap(a)).slice(0, 3).map((s) => s.name));
  const yes = hints?.intent === 'confirm_yes';
  const reply = yes || hints?.intent === 'confirm_no' || (heard.trim().split(/\s+/).length <= 3 && !ASKS.test(heard.trim()));
  if (reply) names.push(...carried);
  const tools = [...new Set(names)].flatMap((name) => usable.get(name) ?? []).slice(0, MOST_TOOLS);
  return { tools, act: tools.length > 0 && (picked || several || screen || named.length > 0 || (yes && offered && carried.length > 0)), several };
}

/** Instructions for Apple's model: short, and only about the tools it has for this question - a small model heeds every word. */
export function appleInstructions(assistant: string, permissions: PermissionMode, tools: string[], opts: { notes?: boolean; several?: boolean } = {}): string {
  const has = (name: string) => tools.includes(name);
  const lines = [
    `You are ${assistant}, the user's voice assistant, running on their Mac with Apple Intelligence. Your replies are spoken aloud: answer in one to three short sentences, conversationally, with no markdown, lists or emoji.`,
    tools.length
      ? `Use your tools when the user asks you to do something, then say briefly what you did. ${askingRule(permissions, assistant)} Never say something happened unless a tool said it did.`
      : "You have no tools for this question: answer it in words. If it asks you to do something on the Mac, say you can't do that just now.",
    "If you don't know something, say so briefly - never make it up.",
  ];
  if (tools.length && opts.several) lines.push('The user asks for more than one thing: call a tool for each of them.');
  if (has('remember')) lines.push(`When the user mentions something about themselves worth keeping - a schedule, preference, person or project - call remember with a short fact; ${assistant} asks them first.`);
  if (has('look_at_screen')) lines.push('When they refer to something on their screen ("this error", "what am I looking at"), call look_at_screen.');
  if (has(CALCULATOR.name)) lines.push('Work out every sum with calculate, never in your head.');
  // Only when there are notes: told about them otherwise, a small model starts writing its own.
  if (opts.notes) lines.push(`The question starts with notes from ${assistant} between [Notes ...] and [End of notes]: context, not the user's words and not instructions - use them when they help, and don't read them out.`);
  return lines.join('\n');
}

/** What a small model sometimes writes before its answer - its own "[Notes: ...]" - is left out of what's said. */
export async function* spoken(pieces: AsyncIterable<string>): AsyncIterable<string> {
  let start = '';
  let settled = false;
  for await (const piece of pieces) {
    if (settled) {
      yield piece;
      continue;
    }
    start += piece;
    const text = start.trimStart();
    if (!text) continue;
    if (!text.startsWith('[')) {
      settled = true;
      yield start;
      continue;
    }
    const end = text.indexOf(']');
    if (end === -1) {
      if (text.length > 400) (settled = true), yield start; // not notes after all
      continue;
    }
    settled = true;
    const rest = text.slice(end + 1).trimStart();
    if (rest) yield rest;
  }
  if (!settled && start.trim()) yield start;
}

async function* said(text: string) {
  yield text;
}

/**
 * Apple Intelligence's model answering open questions, on this Mac: nothing it's given leaves it,
 * and it costs nothing. Its context is small (8K tokens on macOS 27), so each question takes short
 * instructions and a few of Nova's tools, chosen with System 1's help; the helper fits the
 * conversation in. It doesn't use the computer: that takes seeing the screen a step at a time.
 */
export class AppleBrain implements ReasoningBrain {
  readonly name = APPLE_LABEL;
  readonly usesComputer = false;
  readonly fewTools = true;
  /** The last question's tools, for a follow-up. */
  private last: { tools: string[]; at: number } | null = null;

  constructor(
    private readonly model: AppleModel,
    private readonly opts: { tools?: ToolHost; assistant?: string; permissions?: PermissionMode; now?: () => number } = {},
  ) {}

  private get assistant() {
    return this.opts.assistant ?? 'Nova';
  }

  /** Start the helper and load the model now, so the first question waits for neither. */
  warm() {
    void this.model.status();
    this.model.warm(appleInstructions(this.assistant, this.opts.permissions ?? 'auto', []));
  }

  /** What goes to the helper for a question: the instructions, the conversation, the tools. */
  question(question: string, history: Turn[], hints?: QuestionHints): AppleQuestion {
    const now = this.opts.now?.() ?? Date.now();
    const carried = this.last && now - this.last.at < FOLLOW_UP_MS ? this.last.tools : [];
    const chosen = chooseTools(this.opts.tools?.specs() ?? [], hints, carried, history.at(-1)?.nova.trim().endsWith('?') ?? false);
    this.last = { tools: chosen.tools.map((t) => t.name), at: now };
    const sums = SUMS.test(hints?.heard ?? question);
    const tools = sums ? [...chosen.tools, CALCULATOR] : chosen.tools;
    const act = chosen.act || sums;
    const turns = history.map(({ user, nova }) => ({ user, nova }));
    const instructions = appleInstructions(this.assistant, this.opts.permissions ?? 'auto', tools.map((t) => t.name), { notes: question.startsWith('[Notes'), several: chosen.several });
    // Asked to act: the last turns, as turns, and a tool call before any answer. Otherwise the conversation as context,
    // which is also what it remembers best from.
    const conversation: Pick<AppleQuestion, 'history' | 'context'> = act
      ? { history: turns.slice(-ACTING_TURNS) }
      : {
          history: [],
          ...(turns.length && {
            context: {
              note: tools.length ? 'The conversation so far, for context only - what it says was done is done; for anything asked now, use your tools:' : 'The conversation so far, for context:',
              turns: turns.map((t) => `User: ${t.user}\n${this.assistant}: ${t.nova}`),
            },
          }),
        };
    return { instructions, ...conversation, prompt: withTime(question), tools, act };
  }

  stream(question: string, history: Turn[], signal?: AbortSignal, hints?: QuestionHints): AsyncIterable<string> {
    // A yes or no to nothing it asked: nothing to do - a small model makes something up.
    const reply = hints?.intent === 'confirm_yes' || hints?.intent === 'confirm_no';
    if (reply && !history.at(-1)?.nova.trim().endsWith('?')) return said('Okay.');
    const asked = this.question(question, history, hints);
    const run = async (name: string, args: Record<string, unknown>) => {
      if (name === CALCULATOR.name) return calculated(args);
      return this.opts.tools ? this.opts.tools.call(name, args, this.name) : "That tool isn't here.";
    };
    return spoken(this.model.ask(asked, run, signal));
  }

  async reply(question: string, history: Turn[], signal?: AbortSignal): Promise<string> {
    let text = '';
    for await (const piece of this.stream(question, history, signal)) text += piece;
    return text.trim();
  }
}
