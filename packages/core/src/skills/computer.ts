import type { ComputerAction, Skill } from './types.ts';

/**
 * Using the computer, for brains: look at the screen (a picture, and what's on it to click or type
 * in), then click, type, press keys, scroll and drag - one step at a time. Each step that changes
 * something is asked about out loud, with what's about to be clicked shown on screen, unless the
 * user said to go ahead with all of it for this task. Nova Eyes never types into password fields.
 */

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const DIRECTIONS = ['up', 'down', 'left', 'right', 'top', 'bottom'] as const;

/** A point: an element's id from computer_look, or x and y in the picture's pixels. */
const point = (v: unknown): { element?: string; x?: number; y?: number } => {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { element: str(o.element), x: num(o.x), y: num(o.y) };
};

/** The action a tool call asks for, from its arguments - checked here, whatever the caller sent. */
export function actionFrom(kind: ComputerAction['kind'], args: Record<string, unknown> = {}): ComputerAction {
  switch (kind) {
    case 'click':
      return { kind, element: str(args.element), x: num(args.x), y: num(args.y), button: args.button === 'right' ? 'right' : 'left', count: args.double === true || num(args.count) === 2 ? 2 : 1 };
    case 'type':
      return { kind, text: typeof args.text === 'string' ? args.text : '', element: str(args.element), clear: args.clear === true, submit: args.submit === true };
    case 'key':
      return { kind, keys: str(args.keys) ?? '', count: Math.min(20, Math.max(1, num(args.count) ?? 1)) };
    case 'scroll':
      return {
        kind,
        direction: (DIRECTIONS as readonly string[]).includes(String(args.direction)) ? (args.direction as 'down') : 'down',
        amount: Math.min(50, Math.max(1, num(args.amount) ?? 5)),
        element: str(args.element),
        x: num(args.x),
        y: num(args.y),
      };
    case 'drag':
      return { kind, from: point(args.from), to: point(args.to) };
    case 'wait':
      return { kind, seconds: Math.min(10, Math.max(0.2, num(args.seconds) ?? 1)) };
  }
}

const ON_SCREEN = /\b(screen|computer|mac|click|type|look|see|window|page|tab|site|website|app|browser|form|button|open|go to|use)\b/i;
const session = () => ({ key: 'computer', label: 'Use the computer for this task' });

function step(
  id: string,
  kind: ComputerAction['kind'],
  summary: string,
  properties: Record<string, unknown>,
  tier: 0 | 1 | 2,
  required: string[] = [],
): Skill {
  return {
    id,
    toolOnly: true,
    summary,
    tier,
    parameters: { properties, required },
    examples: [id.replace(/_/g, ' ')],
    session,
    preview: (ctx) => ctx.hands?.computer.preview(actionFrom(kind, ctx.args)) ?? Promise.resolve(),
    confirmPrompt: tier >= 2 ? (ctx) => `${ctx.caller ?? 'The brain'} wants to ${ctx.hands?.computer.describe(actionFrom(kind, ctx.args)) ?? kind}. Allow it?` : undefined,
    async run(ctx) {
      if (!ctx.hands) return { say: "I can't use the computer here.", data: "Nova can't use the computer right now.", activity: 'Computer: not available' };
      const action = actionFrom(kind, ctx.args);
      if (action.kind === 'type' && !action.text) return { say: 'Nothing to type.', data: 'Give the text to type in "text".', activity: 'Computer: nothing to type' };
      if (action.kind === 'key' && !action.keys) return { say: 'Which keys?', data: 'Give the keys in "keys", like "cmd+l" or "return".', activity: 'Computer: which keys' };
      const did = await ctx.hands.computer.act(action, ctx.caller ?? 'the brain');
      return { say: did, data: action.kind === 'wait' ? `${did}. Look again (computer_look).` : `${did}. Look again (computer_look) to see what changed.`, activity: did };
    },
  };
}

const target = {
  element: { type: 'string', description: 'The id of the thing on screen, from computer_look - e.g. "e12". Best when there is one.' },
  x: { type: 'number', description: "Or where: x in the picture's pixels, from the left." },
  y: { type: 'number', description: "And y in the picture's pixels, from the top." },
};

export const computerSkills: Skill[] = [
  {
    id: 'computer_look',
    toolOnly: true,
    informs: true,
    summary:
      'See the screen, to use the computer: a picture of it, and a list of the things on it you can click or type in - each with an id (e12), its kind, its name and where it is. Look before acting and again after each step. scope "window" is just the window in front.',
    tier: 0,
    parameters: { properties: { scope: { type: 'string', enum: ['screen', 'window'], description: 'The whole screen (the default) or just the window in front.' } }, required: [] },
    // Looking when the user said nothing about the screen or the computer asks first (as reading it does).
    tierFor: (ctx) => (ON_SCREEN.test(ctx.heard ?? ctx.utterance) ? 0 : 2),
    session,
    confirmPrompt: (ctx) => `${ctx.caller ?? 'The brain'} wants to look at your screen. Allow it?`,
    examples: ['look at the screen to use the computer'],
    async run(ctx) {
      if (!ctx.hands) return { say: "I can't see the screen here.", data: "Nova can't see the screen right now.", activity: 'Computer: not available' };
      const view = await ctx.hands.computer.look({ scope: ctx.args?.scope === 'window' ? 'window' : 'screen', caller: ctx.caller ?? 'the brain' });
      const where = [view.app, view.window].filter(Boolean).join(' - ');
      return {
        say: `I looked at ${where || 'the screen'}.`,
        data:
          `The screen now (${where || 'no window in front'}), a ${view.width}×${view.height} picture. ` +
          `Things you can click or type in (id, kind, name, x,y of the centre, size):\n${view.elements || '(none found - use x and y from the picture)'}` +
          `${view.focused ? `\nThe keyboard is in ${view.focused}.` : ''}`,
        image: view.image,
        activity: `Looked at ${where || 'the screen'}`,
      };
    },
  },
  step(
    'computer_click',
    'click',
    'Click something on screen - by its id from computer_look (best), or x and y in the picture. double: true double-clicks; button "right" right-clicks. The user is asked first.',
    { ...target, double: { type: 'boolean' }, button: { type: 'string', enum: ['left', 'right'] } },
    2,
  ),
  step(
    'computer_type',
    'type',
    'Type text into the field with the keyboard focus, or into the field with this id. clear: true replaces what is there; submit: true presses Return after. Never passwords or card numbers - Nova refuses those fields; ask the user to type them. The user is asked first.',
    { text: { type: 'string', description: 'What to type.' }, element: target.element, clear: { type: 'boolean' }, submit: { type: 'boolean' } },
    2,
    ['text'],
  ),
  step(
    'computer_key',
    'key',
    'Press keys: "return", "tab", "escape", "cmd+l", "cmd+shift+t", "down", "space". count repeats them. The user is asked first.',
    { keys: { type: 'string', description: 'Keys joined by +, e.g. "cmd+s".' }, count: { type: 'number' } },
    2,
    ['keys'],
  ),
  step(
    'computer_scroll',
    'scroll',
    'Scroll the page or list: direction up, down, left, right, top or bottom; amount in steps (5 by default); at an element or x,y (else the middle of the window in front).',
    { direction: { type: 'string', enum: ['up', 'down', 'left', 'right', 'top', 'bottom'] }, amount: { type: 'number' }, ...target },
    1,
    ['direction'],
  ),
  step(
    'computer_drag',
    'drag',
    'Drag from one place to another (a slider, a file, a window edge): from and to are each { element } or { x, y }. The user is asked first.',
    { from: { type: 'object', properties: target }, to: { type: 'object', properties: target } },
    2,
    ['from', 'to'],
  ),
  step('computer_wait', 'wait', 'Wait a moment - up to 10 seconds - for a page or app to catch up, then look again.', { seconds: { type: 'number' } }, 0),
];
