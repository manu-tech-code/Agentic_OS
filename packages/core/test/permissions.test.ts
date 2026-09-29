import { describe, expect, it, vi } from 'vitest';
import {
  NovaBrain,
  outputText,
  voiceSystemPrompt,
  type AgentHost,
  type DecisionEngine,
  type HandsService,
  type NovaOptions,
  type Permissions,
  type Platform,
  type ReasoningBrain,
  type ServerEvent,
  type TrustService,
} from '../src/index.ts';

/** Permissions (Settings → Privacy & trust): how often Nova checks first, and what "yes, always" keeps. */

const choice = (c: string, p: number, others: string[]) => ({
  type: 'choice',
  choice: c,
  probabilities: Object.fromEntries([c, ...others.filter((o) => o !== c)].map((k, i) => [k, i === 0 ? p : (1 - p) / (others.length - 1)])),
});
const INTENTS = ['chat', 'other', 'quit_app', 'confirm_yes', 'confirm_no', 'stop'];

/** Decides `intent` for what's asked - and a yes or a no as one. */
const engine = (intent: string): DecisionEngine => ({
  name: 'test',
  decide: async (state) => {
    const u = String((state as { utterance?: string }).utterance ?? '').toLowerCase();
    const chosen = /^yes\b/.test(u) ? 'confirm_yes' : /^no\b/.test(u) ? 'confirm_no' : intent;
    return {
      answers: { intent: choice(chosen, 0.95, INTENTS), app: choice('Spotify', 0.95, ['none', 'Spotify', 'Slack']), addressed: { type: 'boolean', probability: 0.95 } } as never,
      engine: 'test',
      latencyMs: 0,
      fellBack: false,
    };
  },
});

function fakeTrust() {
  const rules = new Map<string, string>();
  const trust: TrustService = {
    allows: (key) => rules.has(key),
    allow: async (key, label) => void rules.set(key, label),
    list: () => [...rules].map(([key, label]) => ({ key, label })),
  };
  return { trust, rules };
}

/** Nova's hands, as far as clicking goes: what's on screen is `label`. */
function screen(label: string) {
  const clicked: string[] = [];
  const hands = {
    computer: {
      describe: () => `click “${label}” in Safari`,
      act: async () => (clicked.push(label), `Clicked “${label}” in Safari`),
      preview: async () => () => {},
      look: async () => ({ app: 'Safari', width: 100, height: 100, elements: `[e1] button "${label}" at 10,10 (20×20)` }),
      find: async () => null,
      front: async () => 'Safari',
      halt() {},
      resume() {},
      finished() {},
    },
  } as unknown as HandsService;
  return { hands, clicked };
}

/** A brain that, while answering, clicks once on the screen - on its own: the user asked it nothing of the kind. */
const clicker = (nova: () => NovaBrain): ReasoningBrain => ({
  name: 'Brain',
  reply: async () => '',
  async *stream() {
    yield outputText(await nova().call('computer_click', { element: 'e1' }, 'Brain'));
  },
});

async function setup(intent: string, permissions: Partial<Permissions> | undefined, extra: Partial<NovaOptions> = {}) {
  const events: ServerEvent[] = [];
  const quit: string[] = [];
  const { trust, rules } = fakeTrust();
  const platform: Platform = { listApps: async () => ['Safari', 'Slack', 'Spotify'], openApp: async () => {}, quitApp: async (a) => void quit.push(a), now: () => new Date() };
  const nova = new NovaBrain({
    engine: engine(intent),
    platform,
    emit: (e) => events.push(e),
    trust,
    ...(permissions ? { permissions: { mode: 'auto', stillAsk: true, alwaysForGood: true, ...permissions } } : {}),
    ...extra,
  });
  await nova.init();
  const said = () => events.filter((e): e is Extract<ServerEvent, { type: 'say' }> => e.type === 'say').map((e) => e.text);
  return { nova, quit, said, rules };
}

/** The brain clicks while answering "what's this?" - and, when it's asked, the user answers `answer`. */
async function brainClicks(label: string, permissions: Partial<Permissions>, answer?: string) {
  let nova!: NovaBrain;
  const { hands, clicked } = screen(label);
  const t = await setup('chat', permissions, { hands, reasoning: clicker(() => nova) });
  nova = t.nova;
  const answering = t.nova.handle("nova what's this");
  if (answer) {
    await vi.waitFor(() => expect(t.said().at(-1)).toMatch(/Allow it\?$/));
    await t.nova.handle(answer);
  }
  await answering;
  return { t, clicked };
}

describe('Permissions: how often Nova asks', () => {
  it('Ask first: even what the user said to do waits for a yes; Do what I ask and Don\'t ask just do it', async () => {
    const ask = await setup('quit_app', { mode: 'ask' });
    await ask.nova.handle('nova quit spotify');
    expect(ask.quit).toEqual([]);
    expect(ask.said().at(-1)).toMatch(/Quit Spotify\?/);
    for (const mode of ['auto', 'free'] as const) {
      const t = await setup('quit_app', { mode });
      await t.nova.handle('nova quit spotify');
      expect(t.quit, mode).toEqual(['Spotify']);
    }
  });

  it("Don't ask: a brain's own step needs no yes - one that spends money still does, unless nothing is kept back", async () => {
    const auto = await brainClicks('Apple TV', { mode: 'auto' }, 'no');
    expect(auto.clicked).toEqual([]); // its own idea: asked, and refused
    const free = await brainClicks('Apple TV', { mode: 'free' });
    expect(free.clicked).toEqual(['Apple TV']);
    expect(free.t.said().join(' ')).not.toMatch(/Allow it\?/);
    const kept = await brainClicks('Place order', { mode: 'free' }, 'no');
    expect(kept.clicked).toEqual([]); // paying: still asked
    const none = await brainClicks('Place order', { mode: 'free', stillAsk: false });
    expect(none.clicked).toEqual(['Place order']);
  });

  it('keeps "yes, always" to a step on the screen for good - after a restart too - or, with that off, for the task', async () => {
    const { t, clicked } = await brainClicks('Apple TV', { mode: 'auto' }, 'yes, always');
    expect(clicked).toEqual(['Apple TV']);
    expect([...t.rules.keys()]).toEqual(['computer']);
    expect(t.rules.get('computer')).toBe('Use the computer');
    await t.nova.handle("nova what's this"); // the brain clicks again: not asked
    expect(clicked).toEqual(['Apple TV', 'Apple TV']);
    expect(t.said().filter((s) => /Allow it\?$/.test(s))).toHaveLength(1);
    // A click that spends money is still asked about, "always" or not - while that's kept back.
    let payer!: NovaBrain;
    const place = screen('Place order');
    const money = await setup('chat', { mode: 'auto' }, { hands: place.hands, reasoning: clicker(() => payer) });
    payer = money.nova;
    money.rules.set('computer', 'Use the computer');
    const paying = money.nova.handle("nova what's this");
    await vi.waitFor(() => expect(money.said().at(-1)).toMatch(/Place order.*Allow it\?$/));
    await money.nova.handle('no');
    await paying;
    expect(place.clicked).toEqual([]);

    const task = await brainClicks('Apple TV', { mode: 'auto', alwaysForGood: false }, 'yes, always');
    expect(task.clicked).toEqual(['Apple TV']);
    expect(task.t.rules.size).toBe(0);
    expect(task.t.said().join(' ')).toMatch(/during this task - to be asked never again, turn on Remember "yes, always" for good/);
  });
});

describe("Permissions: an agent's commands", () => {
  /** An agent whose task asks each of `asks` in turn (a command, or "" for a whole tool), keeping the answers. */
  function asking(asks: string[]) {
    const answers: boolean[] = [];
    const host: AgentHost = {
      agents: [{ name: 'claude', label: 'Claude' }],
      projects: ['site'],
      ask: async () => '',
      run: async (_agent, _task, _project, callbacks) => {
        for (const detail of asks) answers.push(await callbacks.approve({ action: detail ? `run "${detail}"` : 'use Linear to create an issue', tool: detail ? 'Bash' : 'mcp__linear__create_issue', detail }));
        return 'Done.';
      },
    };
    return { host, answers };
  }
  const start = (nova: NovaBrain) => nova.retryTask({ agent: 'claude', task: 'work on it', project: 'site' });

  it("Don't ask: the agent goes ahead - a risky command is still asked while that's kept back", async () => {
    const a = asking(['npm test', 'rm -rf dist']);
    const t = await setup('chat', { mode: 'free' }, { agents: a.host });
    start(t.nova);
    await vi.waitFor(() => expect(t.said().at(-1)).toBe('Claude wants to run "rm -rf dist" in site. Allow it?'));
    expect(a.answers).toEqual([true]); // npm test: never asked
    await t.nova.handle('no');
    await vi.waitFor(() => expect(a.answers).toEqual([true, false]));

    const b = asking(['npm test', 'rm -rf dist']);
    const u = await setup('chat', { mode: 'free', stillAsk: false }, { agents: b.host });
    start(u.nova);
    await vi.waitFor(() => expect(b.answers).toEqual([true, true]));
    expect(u.said().join(' ')).not.toMatch(/Allow it\?/);
  });

  it('keeps "yes, always" to a whole tool for good - and to a risky command, though that one is still asked while kept back', async () => {
    const a = asking(['', '']);
    const t = await setup('chat', { mode: 'auto' }, { agents: a.host });
    start(t.nova);
    await vi.waitFor(() => expect(t.said().at(-1)).toMatch(/Allow it\?$/));
    await t.nova.handle('yes, always');
    await vi.waitFor(() => expect(a.answers).toEqual([true, true])); // the second: not asked
    expect([...t.rules.values()]).toEqual(['Claude may use mcp__linear__create_issue in site']);

    const b = asking(['rm -rf dist', 'rm -rf dist']);
    const u = await setup('chat', { mode: 'auto' }, { agents: b.host });
    start(u.nova);
    await vi.waitFor(() => expect(u.said().at(-1)).toMatch(/Allow it\?$/));
    await u.nova.handle('yes, always');
    expect(u.rules.size).toBe(1); // kept...
    await vi.waitFor(() => expect(u.said().at(-1)).toMatch(/Allow it\?$/)); // ...but a risky one is asked again
    await u.nova.handle('no');
    await vi.waitFor(() => expect(b.answers).toEqual([true, false]));
  });
});

describe("Permissions: the brain's instructions", () => {
  it('tells the brain what to do about asking', () => {
    expect(voiceSystemPrompt('Manuel', 'free')).toMatch(/told Manuel not to ask: act on your own/);
    expect(voiceSystemPrompt('Manuel', 'auto')).toMatch(/Don't end a reply by offering more/);
    expect(voiceSystemPrompt('Manuel', 'ask')).toMatch(/wants to be asked before changes/);
    expect(voiceSystemPrompt('Manuel')).toBe(voiceSystemPrompt('Manuel', 'auto'));
  });
});
