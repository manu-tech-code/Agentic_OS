import { topProbability } from './distribution.ts';
import type { RawAnswer, StateInput } from './types.ts';

/**
 * Below this, a skill Jev picked isn't acted on while there's a brain: the brain takes the request
 * (and can still use that skill as a tool). Chosen on the development sets (A, B, D; 565 phrasings) as
 * the best of right - 2 x wrong: acting on everything, Jev got 517 right with 45 wrong actions; at 0.8,
 * 514 right with 20 (Reflex: 503 and 20).
 */
export const JEV_DOUBT_FLOOR = 0.8;

/** Never handed on: the brain's own intents, and replies and stopping, which are Nova's to act on at once. */
const KEEP = new Set(['chat', 'other', 'none', 'stop', 'confirm_yes', 'confirm_no']);

/**
 * A doubtful decision goes to the brain rather than doing a doubtful thing - as Reflex does by itself.
 * Only with a brain to hand it to (`canThink`), only for the intent, never while Nova is waiting on an
 * answer to its own question (a doubtful "yes" is asked again, not handed on). The doubtful skill's
 * probability moves to `chat`, so the answer stays a proper distribution with `chat` on top.
 */
export function handDoubtToBrain<A extends Record<string, unknown>>(state: StateInput, answers: A, floor: number): A {
  const s = (typeof state === 'object' && state !== null && !Array.isArray(state) ? state : {}) as Record<string, unknown>;
  if (s.canThink !== true || s.awaitingConfirmationFor || s.awaitingAppFor || s.awaitingProjectFor) return answers;
  const intent = answers.intent as RawAnswer | undefined;
  if (!intent || intent.type !== 'choice' || KEEP.has(intent.choice) || !intent.probabilities || !('chat' in intent.probabilities)) return answers;
  if (topProbability(intent) >= floor) return answers;
  const probabilities = { ...intent.probabilities, chat: intent.probabilities.chat! + intent.probabilities[intent.choice]!, [intent.choice]: 0 };
  return { ...answers, intent: { type: 'choice', choice: 'chat', probabilities } };
}

/**
 * Asked "Quit Spotify?", an answer that restates the action ("yes quit it", "please do" read as
 * quit_app) is a yes - as Reflex reads it. The action's probability moves to `confirm_yes`.
 */
export function restatedYes<A extends Record<string, unknown>>(state: StateInput, answers: A): A {
  const s = (typeof state === 'object' && state !== null && !Array.isArray(state) ? state : {}) as Record<string, unknown>;
  const pending = typeof s.awaitingConfirmationFor === 'string' ? s.awaitingConfirmationFor : '';
  const intent = answers.intent as RawAnswer | undefined;
  if (!pending || !intent || intent.type !== 'choice' || intent.choice !== pending) return answers;
  if (!intent.probabilities || !('confirm_yes' in intent.probabilities)) return { ...answers, intent: { type: 'choice', choice: 'confirm_yes' } };
  const probabilities = { ...intent.probabilities, confirm_yes: intent.probabilities.confirm_yes! + intent.probabilities[pending]!, [pending]: 0 };
  return { ...answers, intent: { type: 'choice', choice: 'confirm_yes', probabilities } };
}

/** How Nova reads Jev's answers: a restated action is a yes, and a doubtful skill goes to the brain. */
export const readJev =
  (floor: number) =>
  <A extends Record<string, unknown>>(state: StateInput, answers: A): A =>
    floor > 0 ? handDoubtToBrain(state, restatedYes(state, answers), floor) : restatedYes(state, answers);
