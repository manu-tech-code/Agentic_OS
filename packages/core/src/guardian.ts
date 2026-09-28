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

/** What a request to do something starts with: doing, on the Mac or for the user - not asking about something. */
const ACT_VERBS = [
  'click', 'tap', 'press', 'hit', 'type', 'write', 'enter', 'fill', 'scroll', 'swipe', 'drag', 'drop', 'select', 'choose', 'pick',
  'tick', 'untick', 'uncheck', 'open', 'close', 'quit', 'exit', 'launch', 'start', 'stop', 'pause', 'play', 'resume', 'skip', 'go',
  'navigate', 'visit', 'search', 'put', 'move', 'send', 'reply', 'forward', 'trash', 'delete', 'remove', 'rename', 'copy', 'paste',
  'save', 'download', 'upload', 'book', 'submit', 'accept', 'allow', 'decline', 'dismiss', 'mute', 'unmute', 'turn', 'switch', 'set',
  'change', 'make', 'create', 'add', 'schedule', 'run', 'use', 'install', 'update', 'refresh', 'reload', 'maximize', 'maximise',
  'minimize', 'minimise', 'zoom', 'lock', 'restart', 'share', 'join', 'leave', 'mark', 'archive', 'star', 'like', 'follow', 'print',
  'take', 'arrange', 'tile', 'hide', 'clear', 'empty', 'sort', 'bring', 'show', 'watch', 'listen', 'next', 'previous', 'undo', 'redo',
  'do', 'finish', 'complete', 'check', 'sign', 'log', 'record', 'call', 'text', 'message', 'email', 'reorder', 'order', 'buy',
];
const LEAD = String.raw`(?:(?:please|nova|hey nova|okay|ok|so|um|uh|er|alright|right|now|just|then|and|kindly|yes|yeah)\s+)*`;
const POLITE = String.raw`(?:(?:can|could|would|will) you (?:please |just )?|(?:i want|i need|i'd like|i would like) you to |go ahead and |(?:please )?help me )?`;
const ASKS_TO_ACT = new RegExp(String.raw`^${LEAD}${POLITE}(?:${ACT_VERBS.join('|')})\b`);

/**
 * Whether what the user said asks Nova to do something ("click send", "can you open Slack", "swipe to
 * the next one") - rather than to tell them something ("what's on my screen?"). Read in code, from the
 * user's own words: then what the brain does for it is what they asked for.
 */
export function asksToAct(said: string): boolean {
  const s = said
    .toLowerCase()
    .replace(/[,.!?;:"“”]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ASKS_TO_ACT.test(s);
}

/**
 * Asked about even when the user said to do it: spending or moving money, and what can't be taken back.
 * It only ever adds a question - so text on a page can make Nova ask, never make it skip one.
 */
const WEIGHTY = /\b(?:buy(?: now)?|purchase|pay(?:ment)?|pay now|checkout|check out|place (?:the |your |my )?order|order now|complete (?:the |your )?(?:order|purchase)|confirm (?:the |your )?(?:order|purchase|payment|booking|transfer)|send money|transfer|donate|subscribe|upgrade|delete (?:the |my |your )?account|close (?:the |my |your )?account|delete (?:forever|permanently)|withdraw)\b/i;

export const weighty = (described: string) => WEIGHTY.test(described);
