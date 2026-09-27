import type { RiskTier } from '../protocol.ts';
import { clockText, describeWhen, durationMs, isCountdown, onDay, parseWhen, spokenDuration } from '../when.ts';
import { toYou } from './memory.ts';
import type { Reminder, Routine, Skill, SkillContext } from './types.ts';

/**
 * Nova's initiative: reminders it keeps (and puts in the Reminders app when asked), a briefing
 * on the day, what it held back while the user was away, what the agents are up to, the project
 * the user is working on, and routines. Times are read in code (when.ts), never by a model.
 */

const LEAD =
  /^\s*(?:(?:hey|okay|ok|so|please|nova|and|um|uh)[\s,]+)*(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|please\s+)?(?:remind\s+me|set\s+(?:me\s+)?(?:a\s+)?reminder|add\s+(?:a\s+)?reminder|create\s+(?:a\s+)?reminder|make\s+(?:a\s+)?reminder|put\s+(?:in\s+)?(?:a\s+)?reminder|i\s+(?:need|want)\s+(?:a\s+)?reminder|don'?t\s+let\s+me\s+forget)\s*(?:(to|about|that|of|for)\s+)?/i;
/** "in my Reminders", "to the Reminders app". */
const APPLE = /\s*\b(?:in|to|on|into)\s+(?:my\s+|the\s+)?(?:apple\s+)?reminders(?:\s+(?:app|list))?\b/i;
/** "add buy milk to my Reminders". */
const ADD_TO_APPLE = /^\s*(?:(?:hey|okay|ok|please|nova)[\s,]+)*(?:(?:can|could)\s+you\s+)?(?:add|put)\s+(.+?)\s+(?:to|on|in|into)\s+(?:my\s+|the\s+)?(?:apple\s+)?reminders(?:\s+(?:app|list))?\s*[.!]?\s*$/i;

const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** The words a reminder is about, from what was said: "remind me to call mum at 5" → ("to", "call mum"). */
export function reminderText(said: string): { text: string; about: 'to' | 'about' | 'that' } {
  const apple = ADD_TO_APPLE.exec(said);
  if (apple) return { text: tidy(apple[1]!), about: 'to' };
  const lead = LEAD.exec(said);
  const rest = (lead ? said.slice(lead[0].length) : said).replace(APPLE, ' ');
  const word = (lead?.[1] ?? /^\s*(to|about|that|of|for)\s/i.exec(rest)?.[1] ?? 'to').toLowerCase();
  const about = word === 'about' || word === 'for' || word === 'of' ? 'about' : word === 'that' ? 'that' : 'to';
  return { text: tidy(rest.replace(/^\s*(?:to|about|that|of|for)\s+/i, '')), about };
}

/** What Nova says when a reminder or timer is due. */
export function dueText(r: Reminder): string {
  if (!r.about) {
    const length = r.ms ? `${spokenDuration(r.ms).replace(/^an hour$/, 'one hour')} ` : '';
    return r.text ? `Your ${length}timer for ${toYou(r.text)} is done.` : `Your ${length}timer is done.`;
  }
  if (!r.text) return "Here's the reminder you asked for.";
  if (r.about === 'about') return `A reminder about ${toYou(r.text)}.`;
  if (r.about === 'that') return `Remember that ${toYou(r.text)}.`;
  return `It's time to ${toYou(r.text)}.`;
}

/** "Remind me again in 10 minutes", just after a reminder: snooze it. */
export const snoozesRecent = (ctx: SkillContext) => Boolean(ctx.reminders?.recent() && /\bagain\b|\bsnooze\b/i.test(ctx.utterance));

function tidy(text: string) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.:;-]+|[\s,.:;!?-]+$/g, '')
    .replace(/\s+(?:please|thanks|thank you)$/i, '')
    .trim();
}

/** "to call your mum", "about the dentist", "that the car needs a wash". */
const saidBack = (r: { text: string }, about = 'to') => (r.text ? `${about} ${toYou(r.text)}` : '');

/** A reminder in a list: "call your mum at 5 PM", "the rent on Friday at 9 AM". */
const inList = (r: Reminder, now: Date) =>
  `${toYou(r.text) || (r.countdown ? 'a timer' : 'a reminder')}${r.due ? ` ${r.schedule ? describeWhen({ at: new Date(r.due), schedule: r.schedule }, now) : onDay(new Date(r.due), now)}` : ''}`;

/** Which reminders a question is about: today's, tomorrow's, this week's - or everything to come. */
function inRange(said: string, now: Date) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = 86_400_000;
  if (/\btoday\b|\btonight\b|\bthis (?:morning|afternoon|evening)\b/i.test(said)) return { from: 0, to: start.getTime() + day, label: 'today' };
  if (/\btomorrow\b/i.test(said)) return { from: start.getTime() + day, to: start.getTime() + 2 * day, label: 'tomorrow' };
  if (/\bthis week\b/i.test(said)) return { from: 0, to: start.getTime() + 7 * day, label: 'this week' };
  return { from: 0, to: Infinity, label: '' };
}

/** "Cancel all my reminders", "delete every reminder" - never "every" or "each" in what a reminder says. */
const ALL = /\b(?:all|every\s+one)\s+(?:of\s+)?(?:my\s+|the\s+|your\s+)?reminders\b|\bevery\s+(?:single\s+)?reminder\b|\ball\s+of\s+them\b/i;

/** Made in the Reminders app, not by Nova: once cancelled, it can't be brought back. */
export const appleOnly = (r: Reminder) => Boolean(r.appleOnly) || r.id.startsWith('apple-');

/** The reminder a "cancel" means: one about those words, one at that time - or all of Nova's own. */
export function cancelling(ctx: SkillContext): { all: boolean; items: Reminder[] } {
  const items = (ctx.reminders?.list() ?? []).filter((r) => !r.countdown || r.text);
  // Everything at once takes only Nova's own: what the user keeps in the Reminders app stays there.
  if (ALL.test(ctx.utterance)) return { all: true, items: items.filter((r) => !appleOnly(r)) };
  const target = ctx.utterance
    .replace(/^\s*(?:(?:hey|okay|ok|please|nova)[\s,]+)*(?:(?:can|could)\s+you\s+)?(?:cancel|delete|remove|clear|drop|forget|stop|scrap|get rid of|turn off|call off)\s+/i, '')
    .replace(/\b(?:the|my|that|this|reminders?|to|about|for|please|one)\b/gi, ' ');
  const when = parseWhen(target, ctx.platform.now());
  const words = new Set((when?.rest ?? target).toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) ?? []);
  const scored = items
    .map((r) => {
      const own = (r.text.toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) ?? []).filter((x) => words.has(x)).length;
      const sameTime = when && r.due && Math.abs(r.due - when.at.getTime()) < 60_000 ? 2 : 0;
      return { r, score: own + sameTime };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return { all: false, items: scored.length && (scored.length === 1 || scored[0]!.score > scored[1]!.score) ? [scored[0]!.r] : [] };
}

/**
 * How much a cancel needs: one reminder is confirmed out loud; several at once is a mass delete,
 * which needs a tap on screen - never a spoken yes alone. Nothing to cancel needs nothing.
 */
export function cancelTier(ctx: SkillContext): RiskTier {
  const { all, items } = cancelling(ctx);
  return !items.length ? 0 : all && items.length > 1 ? 3 : 2;
}

/** "Cancel the reminder to call your mum tomorrow at 9 AM?" */
export function cancelPrompt(ctx: SkillContext) {
  const { all, items } = cancelling(ctx);
  const now = ctx.platform.now();
  if (all && items.length > 1) return `Cancel all ${items.length} of your reminders?`;
  const first = items[0];
  const what = first ? `${saidBack(first, first.about)} ${first.due ? onDay(new Date(first.due), now) : ''}`.trim() : '';
  return `Cancel the reminder${what ? ` ${what}` : ''}?${first && appleOnly(first) ? " It's in your Reminders app, and I can't bring it back." : ''}`;
}

/** Where to cancel them all instead: by hand, in Settings - or one at a time by voice. */
export const cancelOnScreen = (ctx: SkillContext) =>
  `Cancelling all ${cancelling(ctx).items.length} of your reminders at once needs a tap on screen - they're in Settings → Reminders & routines. Or tell me one at a time.`;

export async function cancelReminders(ctx: SkillContext) {
  const { all, items } = cancelling(ctx);
  if (!items.length || !ctx.reminders) return { say: "I couldn't find that reminder. Ask me what your reminders are to hear them.", activity: 'Reminder: none to cancel' };
  for (const r of items) await ctx.reminders.cancel(r.id);
  // Undone by putting them back as they were (a reminder only in the Reminders app is gone from there for good).
  const steps = items.filter((r) => !appleOnly(r)).map(({ id: _id, appleOnly: _only, ...reminder }) => ({ kind: 'reminder-restore' as const, reminder }));
  return {
    say: all && items.length > 1 ? `Done, all ${items.length} of your reminders are cancelled.` : 'Done, that reminder is cancelled.',
    activity: all && items.length > 1 ? `Cancelled all ${items.length} reminders` : `Cancelled a reminder: ${items[0]!.text}`,
    undo: steps.length ? (steps.length === 1 ? steps[0] : { kind: 'batch' as const, steps }) : undefined,
  };
}

/** What a routine's steps start with. */
const STEP_VERBS = ['open', 'launch', 'start', 'quit', 'close', 'brief', 'tell', 'read', 'remind', 'set', 'ask', 'play', 'show', 'turn', 'mute', 'check', 'give', 'stop', 'switch', 'run', 'pause'];
/** A step's verb, also as "opens", "launches" ("a routine that opens my email"). */
const STEP_VERB = new RegExp(`^(${STEP_VERBS.join('|')})(?:e?s)?$`, 'i');

/** "opens my email" → "open my email": a step as the user would say it to Nova. */
function imperative(step: string) {
  const [first = '', ...rest] = step.split(' ');
  const verb = STEP_VERB.exec(first)?.[1];
  return verb ? [verb.toLowerCase(), ...rest].join(' ') : step;
}

/** Steps said one after another: "open Slack, then Linear and brief me" → each its own request. */
export function splitSteps(text: string): string[] {
  return text
    .split(new RegExp(`\\s*[,;]\\s*(?:and\\s+|then\\s+|and\\s+then\\s+)?|\\s+(?:and\\s+)?then\\s+|\\s+and\\s+(?=(?:${[...STEP_VERBS, 'what'].join('|')})(?:e?s)?\\b)`, 'i'))
    .map((s) => imperative(tidy(s.replace(/^(?:and|then|please)\s+/i, ''))))
    .filter(Boolean);
}

/** A routine's name in Settings (routines.<name>): letters, digits, spaces, - and _ - "im home", "every weekday at 8-30 am". */
export const entryName = (text: string) =>
  text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/(\p{N}):(\p{N})/gu, '$1-$2')
    .replace(/[^\p{L}\p{N}_ -]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s_-]+|[\s_-]+$/g, '') || 'routine';

/** "Make a routine (called focus) that…": the rest says the steps, and when. */
const MAKE =
  /^(?:make|create|add|set\s+up)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:new\s+)?routine\b(?:\s+(?:called|named)\s+(?:["“'‘]([^"”'’]+)["”'’]|(.+?)(?=\s+(?:that|which|where|to|when(?:ever)?|if|every|each|on)\b|\s*[:,]|\s*$)))?/i;
const I_SAY = String.raw`(?:when(?:ever)?|if)\s+i\s+say\s+`;

/** Where the phrase ends: at the quote that closes it, a comma or a colon - or where the first step begins. */
function triggerEnd(tail: string): { trigger: string; steps: string } | null {
  // A quote closes only the one that opened it; an apostrophe inside a word ("I'm home") is no quote.
  const quoted = /^["“'‘]\s*(.+?)\s*["”'’](?!\p{L})\s*[,:]?\s*(.*)$/su.exec(tail);
  if (quoted) return { trigger: quoted[1]!, steps: quoted[2]! };
  const comma = /\s*[,:]\s*/.exec(tail);
  if (comma && comma.index > 0) return { trigger: tail.slice(0, comma.index), steps: tail.slice(comma.index + comma[0].length) };
  const words = tail.split(/\s+/);
  const at = words.findIndex((word, i) => i > 0 && STEP_VERB.test(word));
  return at < 1 ? null : { trigger: words.slice(0, at).join(' '), steps: words.slice(at).join(' ') };
}

function phraseRoutine(trigger: string, steps: string, named?: string): Routine | null {
  const phrase = tidy(trigger).toLowerCase();
  const list = splitSteps(steps.replace(/^(?:you\s+should\s+|please\s+|i\s+want\s+you\s+to\s+)/i, ''));
  return phrase && list.length ? { name: entryName(named ?? phrase), phrase, steps: list } : null;
}

/**
 * A routine from what was said: "when I say start work, open Slack and brief me", "make a routine
 * that opens my email when I say good morning", or "every weekday at 9, open Slack".
 */
export function routineFrom(said: string, now: Date): Routine | null {
  let text = said.replace(/^\s*(?:(?:hey|okay|ok|so|nova)[\s,]+)*/i, '').trim();
  let named: string | undefined;
  const make = MAKE.exec(text);
  if (make) {
    named = (make[1] ?? make[2])?.trim() || undefined;
    text = text.slice(make[0].length).replace(/^[\s:,]*(?:(?:that|which|where|to|so\s+that)\s+)?/i, '');
  }
  // The phrase first: "when I say start work, open Slack".
  const first = new RegExp(`^${I_SAY}(.+)$`, 'is').exec(text);
  if (first) {
    const cut = triggerEnd(first[1]!);
    return cut ? phraseRoutine(cut.trigger, cut.steps, named) : null;
  }
  // The steps first: "open my email when I say good morning".
  const last = new RegExp(`^(.+?)[,\\s]+${I_SAY}["“'‘]?(.+?)["”'’]?[.!]?$`, 'is').exec(text);
  if (last) return phraseRoutine(last[2]!, last[1]!, named);
  const when = parseWhen(text, now);
  if (when?.schedule && when.schedule.every !== 'interval') {
    const steps = splitSteps(when.rest);
    if (!steps.length || steps.some((s) => /\bremind me\b/i.test(s))) return null; // that's a reminder
    const schedule = describeWhen(when, now);
    return { name: entryName(named ?? schedule), schedule, steps };
  }
  return null;
}

export const initiativeSkills: Skill[] = [
  {
    id: 'remind',
    wholeUtterance: true,
    summary:
      'Remind the user at a time: once ("at 5", "tomorrow at 9", "on Friday") or repeating ("every weekday at 8:30"). Put what and when in request, as said. "In my Reminders" also puts it in the Reminders app.',
    tier: 1,
    examples: ['remind me to call mum at 5', 'remind me tomorrow morning about the dentist', 'every weekday at 9 remind me to stand up', 'add buy milk to my reminders', 'set a reminder for friday at 3 to pay the rent'],
    async run(ctx) {
      const service = ctx.reminders;
      if (!service) return { say: "I can't keep reminders here.", activity: 'Reminders: not available' };
      const now = ctx.platform.now();
      // "Remind me again in 10 minutes", just after a reminder: that's a snooze.
      if (snoozesRecent(ctx)) return snoozeReminder(ctx, service.recent()!);
      const when = parseWhen(ctx.utterance, now);
      const { text, about } = reminderText(when?.rest ?? ctx.utterance);
      const toApple = ADD_TO_APPLE.test(ctx.utterance) || APPLE.test(ctx.utterance) || service.apple === 'always';
      const appleOk = service.apple !== 'unavailable';
      if (!when) {
        if (toApple && appleOk && text) {
          await service.add({ text, about, due: null, apple: true });
          return { say: `Added ${toYou(text)} to your Reminders.`, data: `Added to the Reminders app: ${text}`, activity: `Reminders app: ${text}` };
        }
        if (!text) return { say: 'What should I remind you about?', activity: 'Reminder: what?' };
        return { say: 'When should I remind you?', needs: 'when', activity: 'Reminder: when?' };
      }
      // Only a short wait is a countdown: "cancel the timer" never takes "in 3 weeks, renew my passport" with it.
      const item = await service.add({ text, about, due: when.at.getTime(), schedule: when.schedule, countdown: isCountdown(when), apple: toApple && appleOk });
      const spoken = describeWhen(when, now);
      const what = saidBack(item, about);
      const also = item.apple ? " It's in your Reminders too." : toApple ? (appleOk ? " I couldn't add it to the Reminders app, so it's only with me." : " (Nova.app isn't running, so it's only with me for now.)") : '';
      return {
        say: when.schedule ? `Okay, ${spoken} I'll remind you${what ? ` ${what}` : ''}.${also}` : `Okay, I'll remind you${what ? ` ${what}` : ''} ${spoken}.${also}`,
        data: `Reminder set ${spoken}: ${text || '(no text)'}`,
        activity: `Reminder ${spoken}${text ? `: ${text}` : ''}`,
        card: { id: item.id, kind: 'reminder', title: text || 'Reminder', body: spoken, endsAt: when.inMs ? when.at.getTime() : undefined },
        undo: { kind: 'reminder-cancel', id: item.id },
      };
    },
  },
  {
    id: 'reminders',
    summary: "The user's reminders to come - today's, tomorrow's, or all. Put the question in request.",
    tier: 0,
    informs: true,
    examples: ['what are my reminders', 'what reminders do i have today', 'do i have any reminders tomorrow', 'what am i supposed to remember today', "what's coming up"],
    async run(ctx) {
      const now = ctx.platform.now();
      const range = inRange(ctx.utterance, now);
      const items = (ctx.reminders?.list() ?? []).filter((r) => r.due !== null && r.due >= range.from && r.due < range.to);
      const undated = range.label ? [] : (ctx.reminders?.list() ?? []).filter((r) => r.due === null);
      if (!items.length && !undated.length) return { say: `You have no reminders${range.label ? ` ${range.label}` : ' coming up'}.`, data: 'No reminders.', activity: 'Read your reminders' };
      const spoken = items.slice(0, 5).map((r) => inList(r, now));
      const more = items.length > 5 ? `, and ${items.length - 5} more` : '';
      const head = items.length ? `You have ${items.length === 1 ? 'one reminder' : `${items.length} reminders`}${range.label ? ` ${range.label}` : ''}: ${list(spoken)}${more}.` : '';
      const tail = undated.length ? ` On your list: ${list(undated.slice(0, 3).map((r) => toYou(r.text)))}${undated.length > 3 ? ` and ${undated.length - 3} more` : ''}.` : '';
      return {
        say: `${head}${tail}`.trim(),
        data: [...items, ...undated].map((r) => `- ${r.text || '(timer)'}${r.due ? ` · ${new Date(r.due).toString()}` : ' · no time'}${r.schedule ? ` · repeats (${describeWhen({ at: new Date(r.due!), schedule: r.schedule }, now)})` : ''}${r.apple ? ' · Reminders app' : ''}`).join('\n'),
        activity: 'Read your reminders',
      };
    },
  },
  {
    id: 'cancel_reminder',
    summary: 'Cancel a reminder the user names (by what it is about, or its time). Cancelling all of them at once needs the user to tap on screen. Put which one in request.',
    tier: 2,
    tierFor: (ctx) => cancelTier(ctx),
    examples: ['cancel the reminder to call mum', 'delete my reminder about the dentist', 'remove the 5pm reminder', 'cancel all my reminders'],
    confirmPrompt: (ctx) => cancelPrompt(ctx),
    tapPrompt: (ctx) => cancelOnScreen(ctx),
    run: (ctx) => cancelReminders(ctx),
  },
  {
    id: 'snooze_reminder',
    summary: 'Snooze the reminder Nova just gave: remind again in a while (10 minutes unless said).',
    tier: 0,
    examples: ['snooze', 'snooze it', 'remind me again in 10 minutes', 'snooze that for an hour', 'ask me again later'],
    async run(ctx) {
      const recent = ctx.reminders?.recent();
      if (!recent) return { say: "There's nothing to snooze.", activity: 'Snooze: nothing' };
      return snoozeReminder(ctx, recent);
    },
  },
  {
    id: 'reminder_done',
    summary: 'The user did what Nova just reminded them of: mark it done (in the Reminders app too).',
    tier: 0,
    examples: ['mark it done', "i've done it", 'tick it off', 'mark that reminder as done', 'complete that reminder'],
    async run(ctx) {
      const recent = ctx.reminders?.recent();
      if (!recent || !ctx.reminders) return { say: "There's no reminder to mark done.", activity: 'Done: nothing' };
      await ctx.reminders.done(recent.id);
      return { say: recent.schedule ? "Great - I'll remind you next time." : 'Great, marked done.', activity: `Done: ${recent.text}` };
    },
  },
  {
    id: 'brief',
    summary: "A spoken briefing on the user's day: the date, weather, calendar, reminders and what the agents did.",
    tier: 0,
    informs: true,
    examples: ['brief me', 'good morning', "what's my day like", "what's on today", 'give me my briefing', 'catch me up on today'],
    async run(ctx) {
      if (!ctx.briefing) {
        const now = ctx.platform.now();
        return { say: `It's ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}, ${clockText(now)}.`, activity: 'Briefed you' };
      }
      const briefing = await ctx.briefing.compose();
      return { say: briefing.spoken, data: briefing.facts.join('\n'), handoff: briefing.ask, activity: 'Briefed you' };
    },
  },
  {
    id: 'missed',
    summary: 'What Nova held back while the user was away or on a call: reminders, finished agent tasks.',
    tier: 0,
    informs: true,
    examples: ['what did i miss', 'anything while i was away', 'any news', 'what happened while i was gone', 'did anything come up'],
    async run(ctx) {
      const missed = ctx.news?.missed() ?? [];
      ctx.news?.heard();
      if (!missed.length) return { say: 'Nothing - you missed nothing.', data: 'Nothing was held back.', activity: 'Nothing missed' };
      const now = ctx.platform.now();
      return {
        say: `While you were away: ${list(missed.map((n) => n.text.replace(/[.!]$/, '')))}.`,
        data: missed.map((n) => `${onDay(new Date(n.at), now)}: ${n.text}`).join('\n'),
        activity: `Told you what you missed (${missed.length})`,
      };
    },
  },
  {
    id: 'task_status',
    summary: 'What the paired agents are working on now, and what they finished lately.',
    tier: 0,
    informs: true,
    needsAgents: true,
    examples: ['what are the agents doing', "how's claude getting on", 'is claude done yet', 'what did codex say', 'any update from the agents'],
    async run(ctx) {
      const { running, recent } = ctx.tasks.status();
      if (!running.length && !recent.length) return { say: 'No agent is working on anything.', data: 'No agent tasks.', activity: 'Agent status' };
      const now = ctx.platform.now().getTime();
      const busy = running.map((t) => `${t.label} is working in ${t.project}${t.step ? `: ${t.step.replace(/[.!]$/, '')}` : ''}`);
      const done = recent
        .filter((t) => now - (t.ended ?? now) < 24 * 3_600_000)
        .slice(0, 3)
        .map((t) => `${t.label} ${t.status === 'done' ? 'finished' : t.status === 'failed' ? "couldn't finish" : 'stopped'} ${t.task.length < 60 ? `"${t.task}"` : 'a task'} in ${t.project}`);
      return {
        say: `${list([...busy, ...done])}.`,
        data: [...running, ...recent].map((t) => `${t.label} · ${t.project} · ${t.status}${t.step ? ` · now: ${t.step}` : ''}${t.report ? ` · said: ${t.report}` : ''}`).join('\n'),
        activity: 'Agent status',
      };
    },
  },
  {
    id: 'set_project',
    summary: 'The project the user is working on now: agents work there when no project is named.',
    tier: 0,
    needsProject: true,
    examples: ["i'm working on agentic os", 'switch to the website project', 'my current project is the api', "we're working on the website today"],
    async run(ctx) {
      if (!ctx.projects || !ctx.project) return { say: "I can't keep track of projects here.", activity: 'Project: not available' };
      const before = ctx.projects.current;
      ctx.projects.set(ctx.project);
      return { say: `Okay, you're working on ${ctx.project}. Agents will work there unless you name another project.`, activity: `Working on ${ctx.project}`, undo: { kind: 'project-set', name: before } };
    },
  },
  {
    id: 'create_routine',
    summary: 'Make a routine: a phrase the user will say, or a schedule, and the steps Nova then takes ("when I say start work, open Slack and brief me").',
    tier: 1,
    wholeUtterance: true,
    examples: ['when i say start work open slack and brief me', 'every weekday at 9 open linear and brief me', 'make a routine that opens my email when i say good morning', 'when i say good night mute yourself'],
    async run(ctx) {
      if (!ctx.routines) return { say: "I can't keep routines here.", activity: 'Routine: not available' };
      const routine = routineFrom(ctx.heard ?? ctx.utterance, ctx.platform.now());
      if (!routine) return { say: 'Tell me like this: "when I say start work, open Slack and brief me" - or "every weekday at 9, brief me".', activity: 'Routine: not understood' };
      const replaced = ctx.routines.list().find((r) => r.name === routine.name);
      await ctx.routines.save(routine);
      const steps = list(routine.steps.map((s) => toYou(s)));
      return {
        say: routine.phrase ? `Okay: when you say "${routine.phrase}", I'll ${steps}.` : `Okay: ${routine.schedule}, I'll ${steps}.`,
        activity: `Routine: ${routine.name}`,
        undo: replaced
          ? { kind: 'routine-restore', name: routine.name, routine: { phrase: replaced.phrase, schedule: replaced.schedule, steps: replaced.steps } }
          : { kind: 'routine-delete', name: routine.name },
      };
    },
  },
];

export async function snoozeReminder(ctx: SkillContext, recent: Reminder) {
  const ms = durationMs(ctx.utterance) ?? 10 * 60_000;
  await ctx.reminders!.snooze(recent.id, ms);
  return { say: `Okay, I'll remind you again in ${spokenDuration(ms)}.`, activity: `Snoozed ${spokenDuration(ms)}: ${recent.text}` };
}
