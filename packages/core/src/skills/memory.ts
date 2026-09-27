import { describeWhen, isCountdown, parseWhen } from '../when.ts';
import type { MemoryItem, Skill, SkillContext } from './types.ts';

/** The user asked for it to be remembered, in so many words. */
const EXPLICIT = /\b(remember|don'?t forget|make a note|note (?:that|this|down)|keep in mind|save (?:that|this)|memori[sz]e)\b/i;
const REMEMBER_LEAD =
  /^\s*(?:(?:hey|okay|ok|so|please|nova)[\s,]+)*(?:(?:can you|could you|would you|please)\s+)?(?:remember|don'?t forget|make a note|note down|note|keep in mind|save|memori[sz]e)(?:\s+(?:that|this))?[\s:,]+/i;
const FORGET_LEAD = /^\s*(?:(?:hey|okay|ok|so|please|nova)[\s,]+)*(?:(?:can you|could you|please)\s+)?(?:forget|delete|remove|erase)(?:\s+(?:that|the (?:memory|note)(?: (?:that|about))?|what i (?:told|said to) you about|about|my note about))?[\s:,]+/i;

/** The fact in "remember that my standup is at 10": "my standup is at 10". */
export const factFrom = (utterance: string) => utterance.replace(REMEMBER_LEAD, '').replace(/[.!\s]+$/, '').trim();
/** "I can't remember where my keys are" is talk about memory, not a request to save something. */
const TALKS_ABOUT =
  /\b(?:i|we|he|she|they)\s+(?:(?:can'?t|cannot|couldn'?t|don'?t|didn'?t|do|did|still|just|vaguely|barely|always|never|might|may|will|won'?t|should|to|totally|completely)\s+)*(?:remember|recall|forget|forgot)\b/i;
const explicitly = (ctx: SkillContext) => {
  const said = ctx.heard ?? ctx.utterance;
  return EXPLICIT.test(said) && !TALKS_ABOUT.test(said) && !asksBack(said);
};
/** "Do you remember when my dentist appointment is?" asks for a memory; it isn't one to save. */
const asksBack = (text: string) =>
  /^\s*(?:(?:hey|okay|ok|so|nova)[\s,]+)*(?:do|did|does|can|could|would|will)\s+(?:you|i)\s+(?:remember|recall|know|tell you|say)\b/i.test(text) ||
  /^\s*(?:(?:hey|okay|ok|so|nova)[\s,]+)*(?:what|when|where|who|which|how)\b/i.test(text) ||
  text.trim().endsWith('?');

/** A question about what was said before: "what did I ask you yesterday?" */
const ABOUT_TALK =
  /\b(?:(?:did|have|had)\s+(?:i|we)\s+(?:ask|tell|say|mention|talk|discuss|speak)|(?:i|we)\s+(?:asked|told|said|talked|spoke|discussed|mentioned)|our (?:last )?(?:conversation|chat)|yesterday|last (?:week|night|time)|earlier today|this morning)\b/i;

const REPLY = /^\s*(?:yes|yeah|yep|sure|ok|okay|no|nope|nah|stop|cancel|thanks|thank you|go ahead|do it)[\s.!,]*(?:please|thanks)?[.!]*\s*$/i;
const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** The saved memory "forget that my standup is at 10" means, if one is close enough. */
function forgetting(ctx: SkillContext): MemoryItem | undefined {
  const target = ctx.utterance.replace(FORGET_LEAD, '').replace(/[.!\s]+$/, '').trim();
  const best = target ? ctx.memory?.recall(target, 1)[0] : undefined;
  return best && (best.score ?? 1) >= 0.45 ? best : undefined;
}

/** A fact in the user's words, as Nova says it back: "my standup is at 10" -> "your standup is at 10". */
export function toYou(text: string) {
  const swaps: [RegExp, string][] = [
    [/\bI'?m\b/gi, "you're"],
    [/\bI am\b/gi, 'you are'],
    [/\bI was\b/gi, 'you were'],
    [/\bI'?ve\b/gi, "you've"],
    [/\bI'll\b/gi, "you'll"],
    [/\bI'd\b/gi, "you'd"],
    [/\bmyself\b/gi, 'yourself'],
    [/\bmine\b/gi, 'yours'],
    [/\bmy\b/gi, 'your'],
    [/\bme\b/gi, 'you'],
    [/\bI\b/g, 'you'],
  ];
  return swaps.reduce((out, [from, to]) => out.replace(from, to), text);
}

const when = (at: number) => new Date(at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * Nova's memory: what the user says to remember is saved at once; what a brain suggests is saved
 * only after the user says yes ("Want me to remember that...?"). Nothing is saved silently.
 */
export const memorySkills: Skill[] = [
  {
    id: 'remember',
    needsRequest: true,
    summary:
      "Save a short fact about the user for later - a schedule, preference, person or project. When they didn't ask for it to be remembered, Nova asks them first. Put the fact in request, in the user's own words.",
    tier: 1,
    // Asked in so many words: saved at once. Otherwise the user is asked - or, with suggestions off, nothing happens.
    tierFor: (ctx) => (explicitly(ctx) || asksBack(ctx.utterance) || ctx.memory?.suggestions === false ? 1 : 2),
    examples: ['remember that my standup is at 10', "don't forget that I'm vegetarian", 'note that the api key rotates monthly', 'keep in mind that I like short answers'],
    // "I can't remember where my keys are" sounds like it, but isn't a request.
    declines: (ctx) => !REMEMBER_LEAD.test(ctx.utterance) && TALKS_ABOUT.test(ctx.utterance),
    confirmPrompt: (ctx) => `Want me to remember that ${toYou(factFrom(ctx.utterance))}?`,
    async run(ctx) {
      // A question about what's remembered, heard as "remember": answer it instead of saving it.
      if (asksBack(ctx.utterance)) return memorySkills[1]!.run(ctx);
      const fact = factFrom(ctx.utterance);
      if (!ctx.memory || !fact) return { say: "I didn't catch what to remember.", activity: 'Memory: nothing to save' };
      if (!explicitly(ctx) && ctx.memory.suggestions === false) {
        return { say: 'Okay.', data: 'Not saved: the user has turned off suggestions to remember things.', activity: 'Memory: not suggested' };
      }
      // "Remember to call mum tomorrow" is a reminder: at a time, it's kept as one.
      const task = /^to\s/i.test(fact);
      const when = task && ctx.reminders ? parseWhen(fact, ctx.platform.now()) : null;
      if (when && ctx.reminders && explicitly(ctx)) {
        const text = when.rest.replace(/^to\s+/i, '').trim();
        const item = await ctx.reminders.add({ text, about: 'to', due: when.at.getTime(), schedule: when.schedule, countdown: isCountdown(when) });
        return { say: `Okay, I'll remind you to ${toYou(text)} ${describeWhen(when, ctx.platform.now())}.`, data: `Reminder set: ${text}`, activity: `Reminder: ${text}`, undo: { kind: 'reminder-cancel', id: item.id } };
      }
      const saved = ctx.memory.remember(fact, explicitly(ctx) ? 'said' : 'suggested');
      return {
        undo: saved.replaced !== undefined ? { kind: 'memory-edit', id: saved.id, text: saved.replaced } : { kind: 'memory-forget', id: saved.id },
        say: task ? "Noted - it's in my memory. Tell me when, and I'll remind you." : "Okay, I'll remember that.",
        data: `Saved to memory: ${fact}`,
        activity: `Remembered: ${fact}`,
      };
    },
  },
  {
    id: 'recall',
    needsRequest: true,
    summary: 'What the user asked Nova to remember that relates to a question. Put the question in request.',
    tier: 0,
    informs: true,
    examples: ['what do you remember about me', 'what do you know about my schedule', 'do you remember my standup time'],
    async run(ctx) {
      const question = ctx.utterance;
      // "What did I ask you yesterday?" is about past conversations: those answer it, with only closely related memories.
      const talk = ABOUT_TALK.test(question) && ctx.memory ? await ctx.memory.searchConversations(question, 365) : [];
      const found = (ctx.memory?.recall(question, 5) ?? []).filter((m) => !ABOUT_TALK.test(question) || (m.score ?? 0) >= 0.35);
      // What they asked, not their yes or no to Nova's questions.
      const asked = [...new Set(talk.map((t) => t.user))].filter((u) => !REPLY.test(u));
      if (!found.length && !asked.length) return { say: "I don't have anything saved about that.", data: 'Nothing in memory or past conversations about that.', activity: 'Memory: nothing found' };
      const said = asked.length ? `${asked.length === 1 ? 'You asked' : `You asked ${asked.length} things, like`} ${list(asked.slice(0, 3).map((u) => `"${u}"`))}.` : '';
      return {
        say: [said, found.length ? `Here's what I remember: ${found.map((m) => toYou(m.text)).join('; ')}.` : ''].filter(Boolean).join(' '),
        data: [
          ...(found.length ? ['Saved memories:', ...found.map((m) => `- ${m.text}`)] : []),
          ...(talk.length ? ['Past conversations:', ...talk.map((t) => `${when(t.at)} - the user: "${t.user}" - Nova: "${t.nova}"`)] : []),
        ].join('\n'),
        activity: talk.length ? 'Searched conversations' : `Recalled ${found.length} ${found.length === 1 ? 'memory' : 'memories'}`,
      };
    },
  },
  {
    id: 'forget',
    needsRequest: true,
    summary: 'Forget one thing the user asked Nova to remember. Put what to forget in request.',
    tier: 2,
    tierFor: (ctx) => (forgetting(ctx) ? 2 : 0),
    examples: ['forget that my standup is at 10', 'forget what I told you about the api key', 'delete that memory'],
    confirmPrompt: (ctx) => `Forget "${forgetting(ctx)?.text}"?`,
    async run(ctx) {
      const memory = forgetting(ctx);
      if (!memory || !ctx.memory) return { say: "I don't have anything like that saved.", activity: 'Memory: nothing to forget' };
      ctx.memory.forget(memory.id);
      return { say: "Done, I've forgotten that.", activity: `Forgot: ${memory.text}`, undo: { kind: 'memory-restore', text: memory.text, source: 'said' } };
    },
  },
  {
    id: 'search_conversations',
    needsRequest: true,
    toolOnly: true,
    informs: true,
    summary: 'Search past conversations with the user - what they asked and what Nova said, with when. Put what to look for in request.',
    tier: 0,
    examples: ['what did I ask you yesterday'],
    async run(ctx) {
      const found = (await ctx.memory?.searchConversations(ctx.utterance, 365)) ?? [];
      if (!found.length) return { say: 'I found nothing like that in our past conversations.', data: 'No past conversations match.', activity: 'Searched conversations' };
      return {
        say: `I found ${found.length} past ${found.length === 1 ? 'conversation' : 'conversations'}.`,
        data: found.map((t) => `${when(t.at)} - the user: "${t.user}" - Nova: "${t.nova}"`).join('\n'),
        activity: 'Searched conversations',
      };
    },
  },
];
