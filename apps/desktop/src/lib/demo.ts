import type { ServerEvent } from '@nova/core/protocol';

/** Scripted session for design work without the daemon: open http://localhost:5173/#demo */
const probs = (keys: string[], pick: string, p: number) =>
  Object.fromEntries(keys.map((k) => [k, k === pick ? p : (1 - p) / (keys.length - 1)]));
const intents = ['open_app', 'quit_app', 'tell_time', 'set_timer', 'cancel_timer', 'stop', 'confirm_yes', 'confirm_no', 'chat', 'other'];
const apps = ['none', 'Safari', 'Slack', 'Spotify', 'Figma', 'Visual Studio Code'];

export const demoScript: Array<[number, ServerEvent]> = [
  [0, { type: 'hello', engine: 'jev (typesafe-ai/jev) → heuristic', brain: 'anthropic/claude-sonnet-5', apps: 142, wakeWords: ['hey nova', 'nova'] }],
  [1200, { type: 'phase', phase: 'listening' }],
  [2400, { type: 'phase', phase: 'thinking' }],
  [2640, {
    type: 'decision',
    trace: {
      utterance: 'open figma and set a timer for 25 minutes',
      engine: 'jev (typesafe-ai/jev)',
      latencyMs: 212,
      fellBack: false,
      outcome: 'open_app → Figma (p=0.93)',
      answers: {
        intent: { type: 'choice', choice: 'open_app', probabilities: probs(intents, 'open_app', 0.93) },
        app: { type: 'choice', choice: 'Figma', probabilities: probs(apps, 'Figma', 0.97) },
        addressed: { type: 'boolean', probability: 0.99 },
      },
    },
  }],
  [2700, { type: 'phase', phase: 'acting', label: 'open_app' }],
  [2900, { type: 'card', card: { id: 'c1', kind: 'app', title: 'Figma', body: 'Opened' } }],
  [2950, { type: 'activity', item: { id: 'a1', at: Date.now(), label: 'Opened Figma', status: 'done', skill: 'open_app', tier: 0 } }],
  [3000, { type: 'say', text: 'Opening Figma.' }],
  [3000, { type: 'phase', phase: 'speaking' }],
  [4200, { type: 'card', card: { id: 'c2', kind: 'timer', title: 'Timer · 25 minutes', endsAt: Date.now() + 25 * 60_000 } }],
  [4250, { type: 'activity', item: { id: 'a2', at: Date.now(), label: 'Timer 25 minutes', status: 'done', skill: 'set_timer', tier: 1 } }],
  [5200, { type: 'card', card: { id: 'c3', kind: 'confirm', title: 'Quit Spotify? Unsaved work could be lost.', body: 'Say "yes" or "no"' } }],
  [5250, { type: 'activity', item: { id: 'a3', at: Date.now(), label: 'Quit Spotify? (awaiting confirmation)', status: 'pending', skill: 'quit_app', tier: 2 } }],
  [5300, { type: 'phase', phase: 'listening' }],
];
