import type { RawAnswer, StateInput } from './types.ts';

/**
 * Replies, read in code: a yes, a no or "never mind" decides whether something is done, and reading them by likeness
 * slips on exactly these - a lone "okay" sits next to "okay stop", "absolutely not" next to "absolutely". So for any
 * engine: a whole reply from these lists settles the answer; while Nova waits for one, a short reply the engine also
 * took for a reply says yes or no by its words ("wait, no, keep it open"; "yes, quit it") - a different request said
 * then ("stop everything") stays one; and a reply that says no is never taken as a yes.
 */

export type Reply = 'confirm_yes' | 'confirm_no' | 'stop';
const REPLIES = new Set<string>(['confirm_yes', 'confirm_no', 'stop']);

/** Replies that mean the same with or without a question waiting. */
const YES = [
  'yes', 'yeah', 'yea', 'ya', 'yep', 'yup', 'aye', 'yes please', 'yeah please', 'yes do it', 'yes do that', 'yes go ahead', 'yeah do it', 'yeah do that',
  'yeah go ahead', 'yep do it', 'yep go ahead', 'yup go ahead', 'sure', 'sure thing', 'sure go ahead', 'sure do it', 'sure go on', 'of course',
  'of course go ahead', 'yes of course', 'ok', 'okay', 'okay sure', 'okay yes', 'okay do it', 'okay do that', 'okay go ahead', 'ok go ahead', 'ok do it',
  'alright', 'all right', 'alright do it', 'alright go ahead', 'all right go ahead', 'alright then', 'go ahead', 'go ahead then', 'go on',
  'go on then', 'go for it', 'do it', 'do it now', 'please do', 'please do it', 'yes please do', 'correct', "that's correct", 'that is correct',
  "that's right", 'that is right', 'affirmative', 'absolutely', 'absolutely yes', 'definitely', 'certainly', 'sounds good', 'that works',
  'why not', "yes i'm sure", 'confirm', 'confirmed', 'i confirm', 'approve', 'approved', 'allow it', 'yes allow it', 'proceed', 'please proceed',
  'yes thanks', 'yes thank you', 'yeah thanks', 'okay sounds good', 'sounds good to me', 'that sounds good', 'do that', 'you can do it',
  'you can go ahead', 'yes you can', 'go right ahead',
];
const NO = [
  'no', 'nope', 'nah', 'no no', 'no thanks', 'no thank you', 'nah thanks', 'no way', 'absolutely not', 'definitely not', 'certainly not',
  'of course not', 'not at all', 'no not at all', 'i said no', 'no i said no', "don't", 'do not', "don't do it", "don't do that", 'please don\'t',
  "please don't do that", "don't do anything", "no don't", "cancel don't do it", 'hold off', 'hold off on that', 'not now', 'not yet',
  'not today', 'no not now', 'leave it', 'leave it alone', 'leave it be', 'better not', 'rather not', "i'd rather not", 'negative', 'deny',
  'decline', 'abort', 'no need', "i don't want that", "no i don't want that", 'changed my mind', 'actually no',
];
const STOP = [
  'never mind', 'nevermind', 'never mind that', 'never mind i got it', 'forget it', 'forget about it', 'forget that', 'stop', 'stop it',
  'stop that', 'cut it out', 'shut it', 'knock it off', "that's enough", 'enough', "that's fine you can stop", 'you can stop', 'okay stop',
  'hold it', 'hold it there', 'hold it right there',
];
/** Only while Nova waits for an answer: on their own, these are just talk. */
const YES_WHEN_ASKED = ['right', 'fine', "that's fine", 'fine go ahead', 'fine do it', 'exactly', 'perfect', 'great', 'good', 'yes sir', 'sure why not'];
const NO_WHEN_ASKED = ['wait', 'wait no', 'no wait', 'later', 'maybe later', 'keep it', 'keep it open', 'skip it', 'wrong', "that's wrong", 'never', 'not that', 'not that one'];

/** Words that open a yes: while Nova waits, a short reply starting with one and saying no "no" is a yes ("yes quit it", "sure, close it"). */
const YES_OPENERS = new Set(['yes', 'yeah', 'yea', 'yep', 'yup', 'sure', 'okay', 'ok', 'alright', 'absolutely', 'definitely', 'certainly']);
/** Words that say no, in a reply - and the few ways they say yes all the same. ("stop" and "cancel" open requests of their own.) */
const NEGATORS = new Set(['no', 'not', 'nope', 'nah', 'never', "don't", 'dont', "can't", 'cannot', "won't", "shouldn't"]);
const STILL_YES = ['no problem', 'no worries', 'not a problem', 'why not', 'no doubt', "don't worry"];
/** Words that open or close a reply without changing it ("um, yes please", "no thanks nova"). */
const OPENERS = new Set(['um', 'uh', 'er', 'erm', 'hmm', 'mm', 'oh', 'well', 'so', 'hey', 'nova', 'look', 'listen', 'ah']);
/** Not "thanks": "okay thanks" is how a user says that's all. */
const CLOSERS = [/ (please|nova|mate)$/];
/** Longer than this, it's more than a reply. */
const REPLY_WORDS = 6;

/** A reply as it compares: lower case, curly apostrophes straight, punctuation gone, and its openers and closers off. */
export function replyWords(text: string): string {
  let t = text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (;;) {
    const words = t.split(' ');
    if (words.length > 1 && OPENERS.has(words[0]!)) t = words.slice(1).join(' ');
    else break;
  }
  for (let again = true; again; ) {
    again = false;
    for (const re of CLOSERS) {
      const next = t.replace(re, '');
      if (next !== t && next.trim()) (t = next.trim()), (again = true);
    }
  }
  return t;
}

const index = (lists: [Reply, string[]][]) => new Map(lists.flatMap(([reply, list]) => list.map((p) => [replyWords(p), reply] as const)));
const ALWAYS = index([['confirm_yes', YES], ['confirm_no', NO], ['stop', STOP]]);
const ASKED = index([['confirm_yes', YES_WHEN_ASKED], ['confirm_no', NO_WHEN_ASKED]]);

/** Whether what was said says no ("absolutely not", "don't", "wait no") - not the ways a no still says yes ("no problem"). */
export function saysNo(text: string): boolean {
  const t = replyWords(text);
  if (STILL_YES.some((p) => ` ${t} `.includes(` ${p} `))) return false;
  return t.split(' ').some((w) => NEGATORS.has(w));
}

/**
 * The reply this is, when it's one for sure: a whole reply from the lists - and while Nova waits for an answer
 * (`asked`), also those that only mean yes or no then ("right", "wait").
 */
export function readReply(text: string, asked: boolean): Reply | null {
  const t = replyWords(text);
  if (!t) return null;
  return ALWAYS.get(t) ?? (asked ? ASKED.get(t) : undefined) ?? null;
}

/** A short reply's yes or no by its words: no when it says no, yes when it opens with a yes and doesn't - or null. */
export function replySays(text: string): 'confirm_yes' | 'confirm_no' | null {
  const t = replyWords(text);
  const words = t.split(' ');
  if (!t || words.length > REPLY_WORDS) return null;
  if (saysNo(t)) return 'confirm_no';
  return YES_OPENERS.has(words[0]!) ? 'confirm_yes' : null;
}

const stateOf = (state: StateInput) => (typeof state === 'object' && state !== null && !Array.isArray(state) ? state : { utterance: String(state ?? '') }) as Record<string, unknown>;

/** The intent answer with `choice` on top - nearly certain, the rest of the distribution kept in proportion. */
function settle(intent: RawAnswer & { type: 'choice' }, choice: Reply, p = 0.97): RawAnswer {
  const probabilities = intent.probabilities;
  if (!probabilities) return { type: 'choice', choice };
  const rest = Object.entries(probabilities).filter(([k]) => k !== choice);
  const restSum = rest.reduce((s, [, v]) => s + v, 0);
  return {
    type: 'choice',
    choice,
    probabilities: { ...Object.fromEntries(rest.map(([k, v]) => [k, restSum > 0 ? ((1 - p) * v) / restSum : (1 - p) / rest.length])), [choice]: p },
  };
}

/**
 * Any engine's answers, with replies read in code: a reply for sure settles the intent (when the question offers it),
 * and a yes that says no ("sure... no, not now") is a no. Nothing changes when an app or a project is being asked for
 * - "notes" there is an answer, not a reply.
 */
export function settleReplies<A extends Record<string, unknown>>(state: StateInput, answers: A): A {
  const s = stateOf(state);
  const intent = answers.intent as RawAnswer | undefined;
  if (!intent || intent.type !== 'choice' || s.awaitingAppFor || s.awaitingProjectFor) return answers;
  const text = typeof s.utterance === 'string' ? s.utterance : '';
  const offered = (choice: string) => !intent.probabilities || choice in intent.probabilities;
  const pending = typeof s.awaitingConfirmationFor === 'string' ? s.awaitingConfirmationFor : '';
  const settled = (reply: Reply, p?: number) => (intent.choice === reply && topOf(intent) >= (p ?? 0.97) ? answers : { ...answers, intent: settle(intent, reply, p) });
  const reply = readReply(text, Boolean(pending));
  if (reply && offered(reply)) return settled(reply);
  // Waiting for an answer, and the engine heard one (or the action said again): its words say which.
  const heardReply = REPLIES.has(intent.choice) || (pending !== '' && intent.choice === pending);
  const says = pending && heardReply ? replySays(text) : null;
  if (says && offered(says)) return settled(says);
  if (intent.choice === 'confirm_yes' && offered('confirm_no') && saysNo(text)) return settled('confirm_no', Math.max(topOf(intent), 0.6));
  return answers;
}

const topOf = (a: RawAnswer & { type: 'choice' }) => a.probabilities?.[a.choice] ?? 1;
