import type { Skill } from './types.ts';

/** The user is talking about something on screen: then looking needs no question first. */
const ON_SCREEN = /\b(screen|look|see|seeing|showing|shown|this|that|these|those|here|read|page|window|tab|error|message|selected|highlighted|document|chart|code)\b/i;

/** Reading the screen, for brains: the window in front, or the whole screen when asked. */
export const screenSkills: Skill[] = [
  {
    id: 'look_at_screen',
    toolOnly: true,
    informs: true,
    summary:
      "See what's on the user's screen: the window in front, read as text on their Mac (and as a picture, for brains that can see). Use it when they refer to something on screen - \"this error\", \"what am I looking at\". Say \"whole screen\" in request for everything, not just the window.",
    tier: 0,
    // Looking when the user didn't mention anything on screen asks them first.
    tierFor: (ctx) => (ON_SCREEN.test(ctx.heard ?? ctx.utterance) ? 0 : 2),
    confirmPrompt: () => 'May I look at your screen?',
    examples: ['look at my screen'],
    async run(ctx) {
      if (!ctx.screen) return { say: "I can't see the screen.", data: "Nova can't see the screen right now.", activity: 'Screen: not available' };
      const whole = /\b(whole|entire|full|all|everything)\b/i.test(ctx.utterance);
      const seen = await ctx.screen.look(whole ? 'screen' : 'window');
      const where = [seen.app, seen.window].filter(Boolean).join(' - ') || (whole ? 'the whole screen' : 'the window in front');
      return {
        say: `I looked at ${where}.`,
        data: `On the user's screen (${where}), read as text:\n${seen.text.trim() || '(no text could be read)'}`,
        image: seen.image,
        activity: `Looked at ${where}`,
      };
    },
  },
];
