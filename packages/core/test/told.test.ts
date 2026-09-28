import { describe, expect, it, vi } from 'vitest';
import { asksToAct, NovaBrain, outputText, weighty, type DecisionEngine, type HandsService, type NovaOptions, type Platform, type ReasoningBrain, type ServerEvent } from '../src/index.ts';

/** Doing what the user says, without a yes - and still asking about what nobody asked for, and about money. */

const choice = (c: string, p: number, others: string[]) => ({
  type: 'choice',
  choice: c,
  probabilities: Object.fromEntries([c, ...others].map((k, i) => [k, i === 0 ? p : (1 - p) / others.length])),
});

/** A decision engine that always decides the same. */
const fixed = (answers: Record<string, unknown>): DecisionEngine => ({ name: 'fixed', decide: async () => ({ answers: answers as any, engine: 'fixed', latencyMs: 0, fellBack: false }) });
const quitSpotify = (p: number) => fixed({ intent: choice('quit_app', p, ['chat', 'other', 'open_app']), app: choice('Spotify', 0.95, ['none', 'Slack']), addressed: { type: 'boolean', probability: 0.95 } });
const toTheBrain = fixed({ intent: choice('chat', 0.95, ['other', 'quit_app']), addressed: { type: 'boolean', probability: 0.95 } });

async function setup(engine: DecisionEngine, extra: Partial<NovaOptions> = {}) {
  const events: ServerEvent[] = [];
  const quit: string[] = [];
  const platform: Platform = { listApps: async () => ['Safari', 'Slack', 'Spotify'], openApp: async () => {}, quitApp: async (a) => void quit.push(a), now: () => new Date() };
  const nova = new NovaBrain({ engine, platform, emit: (e) => events.push(e), ...extra });
  await nova.init();
  const said = () => events.filter((e): e is Extract<ServerEvent, { type: 'say' }> => e.type === 'say').map((e) => e.text);
  return { nova, quit, said, events };
}

/** A brain that, while answering, uses one of Nova's tools and says what came of it. */
function toolUser(tool: string, args: Record<string, unknown>, nova: () => NovaBrain): ReasoningBrain {
  return {
    name: 'Brain',
    reply: async () => '',
    async *stream() {
      yield outputText(await nova().call(tool, args, 'Brain'));
    },
  };
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

describe('what counts as being told to do something', () => {
  it('reads a request to act from the user\'s own words - not a question', () => {
    for (const said of ['Click on the, uh, Apple TV widget.', 'Swipe to the next screen and yes.', 'can you open slack', 'please quit spotify', 'go ahead and close this window', 'I want you to play the next episode', 'nova, type see you at five'])
      expect(asksToAct(said), said).toBe(true);
    for (const said of ['What do you see on the screen right now?', "What's the video?", 'can you see my screen', 'why is my mac slow', 'is wifi on', "tell me what's on screen", ''])
      expect(asksToAct(said), said).toBe(false);
  });

  it('holds back only for money and what can\'t be taken back', () => {
    for (const d of ['click “Place order” in Safari', 'click “Pay now” in Safari', 'click “Buy now” in Safari', 'click “Confirm payment” in Chrome', 'click “Delete account” in Safari', 'click “Transfer” in Bank'])
      expect(weighty(d), d).toBe(true);
    for (const d of ['click “Send” in Mail', 'click “Apple TV” in TV', 'type “hello” in Messages', 'press return']) expect(weighty(d), d).toBe(false);
  });
});

describe('doing what the user says', () => {
  it('quits Spotify when told, without "Quit Spotify?"', async () => {
    const t = await setup(quitSpotify(0.95), { askFirst: false });
    await t.nova.handle('nova quit spotify');
    expect(t.quit).toEqual(['Spotify']);
    expect(t.said().join(' ')).not.toMatch(/Quit Spotify\?/);
  });

  it('asks first when set to - and does by default', async () => {
    for (const askFirst of [true, undefined]) {
      const t = await setup(quitSpotify(0.95), { askFirst });
      await t.nova.handle('nova quit spotify');
      expect(t.quit).toEqual([]);
      expect(t.said().at(-1)).toMatch(/Quit Spotify\?/);
    }
  });

  it('never acts on a command it isn\'t sure it heard', async () => {
    const t = await setup(quitSpotify(0.65), { askFirst: false });
    await t.nova.handle('nova quit spotify');
    expect(t.quit).toEqual([]);
    expect(t.said().at(-1)).toMatch(/not sure/);
  });

  it("does the brain's steps for what the user said to do", async () => {
    let nova!: NovaBrain;
    const t = await setup(toTheBrain, { askFirst: false, reasoning: toolUser('quit_app', { app: 'Spotify' }, () => nova) });
    nova = t.nova;
    await t.nova.handle('nova please close spotify and then open slack');
    expect(t.quit).toEqual(['Spotify']);
  });

  it("still asks about what the user didn't ask for: the brain's own idea, or an agent working on its own", async () => {
    let nova!: NovaBrain;
    const t = await setup(toTheBrain, { askFirst: false, reasoning: toolUser('quit_app', { app: 'Spotify' }, () => nova) });
    nova = t.nova;
    const answering = t.nova.handle('nova why is my mac so slow');
    await vi.waitFor(() => expect(t.said().join(' ')).toMatch(/Quit Spotify\?/));
    t.nova.cancel();
    await answering;
    expect(t.quit).toEqual([]);

    const agent = t.nova.call('quit_app', { app: 'Spotify' }, 'Claude', { task: 'task-1' });
    await vi.waitFor(() => expect(t.events.filter((e) => e.type === 'card').length).toBeGreaterThan(1));
    t.nova.cancel();
    expect(outputText(await agent)).toMatch(/said no/);
    expect(t.quit).toEqual([]);
  });

  it('clicks what it was told to - but asks before a click that spends money', async () => {
    for (const [label, asked] of [['Apple TV', false], ['Place order', true]] as const) {
      let nova!: NovaBrain;
      const { hands, clicked } = screen(label);
      const t = await setup(toTheBrain, { askFirst: false, hands, reasoning: toolUser('computer_click', { element: 'e1' }, () => nova) });
      nova = t.nova;
      const answering = t.nova.handle(`nova click ${label.toLowerCase()}`);
      if (asked) {
        await vi.waitFor(() => expect(t.said().join(' ')).toMatch(/Place order/));
        t.nova.cancel();
      }
      await answering;
      expect(clicked).toEqual(asked ? [] : [label]);
    }
  });
});
