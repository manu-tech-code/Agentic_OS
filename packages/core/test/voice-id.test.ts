import { describe, expect, it } from 'vitest';
import { NovaBrain, type DecisionEngine, type NovaOptions, type Platform, type ServerEvent, type Skill } from '../src/index.ts';

/** Voice ID in the brain: another voice is ignored entirely; one it can't place is told how to be sure. */

const choice = (c: string, p: number, others: string[]) => ({
  type: 'choice',
  choice: c,
  probabilities: Object.fromEntries([c, ...others].map((k, i) => [k, i === 0 ? p : (1 - p) / others.length])),
});
const quitSpotify: DecisionEngine = {
  name: 'fixed',
  decide: async () => ({ answers: { intent: choice('quit_app', 0.95, ['chat', 'other']), app: choice('Spotify', 0.95, ['none']), addressed: { type: 'boolean', probability: 0.95 } } as any, engine: 'fixed', latencyMs: 0, fellBack: false }),
};

async function setup(extra: Partial<NovaOptions> = {}) {
  const events: ServerEvent[] = [];
  const quit: string[] = [];
  let now = 1_000_000;
  const platform: Platform = { listApps: async () => ['Spotify'], openApp: async () => {}, quitApp: async (a) => void quit.push(a), now: () => new Date(now) };
  const nova = new NovaBrain({ engine: quitSpotify, platform, emit: (e) => events.push(e), askFirst: false, clock: () => now, ...extra });
  await nova.init();
  const said = () => events.filter((e): e is Extract<ServerEvent, { type: 'say' }> => e.type === 'say').map((e) => e.text);
  return { nova, quit, said, events, later: (ms: number) => void (now += ms) };
}

describe('Voice ID in the brain', () => {
  it("ignores another voice entirely - even saying Nova's name, nothing opens and nothing is done", async () => {
    const t = await setup();
    await t.nova.handle('nova', 'voice', 'not-you'); // the name alone: no listening window for them
    await t.nova.handle('nova quit spotify', 'voice', 'not-you');
    expect(t.quit).toEqual([]);
    expect(t.events).toEqual([]);
    await t.nova.handle('quit spotify', 'voice', 'you'); // no name: the window never opened
    expect(t.quit).toEqual([]);
    await t.nova.handle('nova quit spotify', 'voice', 'you');
    expect(t.quit).toEqual(['Spotify']);
  });

  it("says how to be sure when it can't tell - once in a while - and does nothing", async () => {
    const t = await setup({ talkShortcut: '⌥Space' });
    await t.nova.handle('nova quit spotify', 'voice', 'unsure');
    expect(t.quit).toEqual([]);
    expect(t.said()).toEqual(["I couldn't tell that was you. Hold ⌥Space and say it again."]);
    await t.nova.handle('nova quit spotify', 'voice', 'unsure');
    expect(t.said()).toHaveLength(1); // not again straight away
    t.later(30_000);
    await t.nova.handle('nova quit spotify', 'voice', 'unsure');
    expect(t.said()).toHaveLength(2);
  });

  it("says plainly when a window's own hearing heard it - that can't be checked - rather than that it's unsure", async () => {
    const t = await setup({ talkShortcut: '⌥Space' });
    await t.nova.handle('nova quit spotify', 'voice', 'unchecked');
    expect(t.quit).toEqual([]);
    expect(t.said()).toEqual(["I can't check voices this window hears - only Nova.app's hearing can. Hold ⌥Space and say it, or type it."]);
  });

  it('counts the talk shortcut and typing as the user, whatever the voice check said', async () => {
    const t = await setup();
    await t.nova.handle('quit spotify', 'shortcut', 'not-you');
    expect(t.quit).toEqual(['Spotify']);
    await t.nova.handle('nova quit spotify', 'keyboard', 'unsure');
    expect(t.quit).toEqual(['Spotify', 'Spotify']);
  });

  it('never deletes on the word of a voice that got in with the master keyword', async () => {
    const shredded: string[] = [];
    const shred: Skill = { id: 'shred', tier: 1, examples: ['shred the notes'], destructive: () => true, run: async () => (shredded.push('notes'), { say: 'Shredded.', activity: 'Shredded the notes' }) };
    const engine: DecisionEngine = {
      name: 'fixed',
      decide: async () => ({ answers: { intent: choice('shred', 0.95, ['chat', 'other']), addressed: { type: 'boolean', probability: 0.95 } } as any, engine: 'fixed', latencyMs: 0, fellBack: false }),
    };
    const t = await setup({ engine, skills: [shred] });
    await t.nova.handle('nova shred the notes', 'voice', 'anyone');
    expect(shredded).toEqual([]);
    expect(t.said().at(-1)).toMatch(/^Not while Voice ID is off: a voice that got in with the master keyword can't delete/);
    expect(t.events.some((e) => e.type === 'activity' && e.item.status === 'cancelled' && e.item.by === 'someone, with the master keyword')).toBe(true);
    await t.nova.handle('nova shred the notes', 'voice', 'you'); // the user's own voice
    expect(shredded).toEqual(['notes']);
    await t.nova.handle('shred the notes', 'keyboard'); // or typed: someone at the Mac
    expect(shredded).toEqual(['notes', 'notes']);
  });
});
