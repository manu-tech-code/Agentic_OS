import { describe, expect, it } from 'vitest';
import {
  defaultOf,
  EvaluationDecisionEngine,
  formatShortcut,
  HeuristicEvaluationModel,
  NovaBrain,
  parseShortcut,
  settingProblem,
  shortcutFromKeyboard,
  shortcutProblem,
  TurnDetector,
  type Platform,
  type ReasoningBrain,
  type ServerEvent,
  type TurnClock,
} from '../src/index.ts';

describe('shortcuts', () => {
  it('reads them the way the settings file keeps them', () => {
    expect(parseShortcut('option+space')).toEqual({ modifiers: ['option'], key: 'space' });
    expect(parseShortcut('Cmd + Shift + K')).toEqual({ modifiers: ['shift', 'command'], key: 'k' });
    expect(parseShortcut('alt+ctrl+enter')).toEqual({ modifiers: ['control', 'option'], key: 'return' });
    expect(parseShortcut('f5')).toEqual({ modifiers: [], key: 'f5' });
    expect(parseShortcut('option+option+space')).toBeNull();
    expect(parseShortcut('hyper+space')).toBeNull();
    expect(parseShortcut('option+')).toBeNull();
    expect(parseShortcut('option+f21')).toBeNull();
  });

  it('shows them as macOS does', () => {
    expect(formatShortcut('option+space')).toBe('⌥Space');
    expect(formatShortcut('command+shift+control+n')).toBe('⌃⇧⌘N');
    expect(formatShortcut('control+option+left')).toBe('⌃⌥←');
  });

  it("refuses ones that would catch the user's typing or belong to macOS", () => {
    expect(shortcutProblem('option+space')).toBeNull();
    expect(shortcutProblem('f6')).toBeNull();
    expect(shortcutProblem('space')).toMatch(/catch your typing/);
    expect(shortcutProblem('shift+a')).toMatch(/⇧ alone/);
    expect(shortcutProblem('command+q')).toMatch(/belongs to macOS/);
    expect(shortcutProblem('command+space')).toMatch(/belongs to macOS/);
    expect(shortcutProblem('control+command+space')).toBeNull();
    expect(shortcutProblem('nonsense')).toMatch(/joined by \+/);
  });

  it('records a key press from the Settings window', () => {
    const press = (code: string, mods: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = {}) =>
      shortcutFromKeyboard({ code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });
    expect(press('Space', { altKey: true })).toBe('option+space');
    expect(press('KeyA', { altKey: true, shiftKey: true })).toBe('option+shift+a'); // ⌥A types "å", but the key is A
    expect(press('Digit3', { ctrlKey: true, metaKey: true })).toBe('control+command+3');
    expect(press('AltLeft', { altKey: true })).toBeNull(); // only a modifier so far
    expect(press('F7')).toBe('f7');
  });

  it('are checked as settings', () => {
    expect(defaultOf('presence.shortcut')).toBe('option+space');
    expect(settingProblem('presence.shortcut', 'control+option+n')).toBeNull();
    expect(settingProblem('presence.shortcut', 'n')).toMatch(/catch your typing/);
    expect(settingProblem('presence.listen', 'sometimes')).toMatch(/should be one of/);
    expect(settingProblem('presence.orbSeconds', 1)).toMatch(/at least 2/);
    expect(settingProblem('presence.daemon', 'terminal')).toBeNull();
  });

  it("sizes the orbs within their sliders' ranges", () => {
    expect(defaultOf('appearance.orbSize')).toBe(100);
    expect(defaultOf('appearance.floatingOrbSize')).toBe(100);
    expect(settingProblem('appearance.orbSize', 150)).toBeNull();
    expect(settingProblem('appearance.orbSize', 250)).toMatch(/at most 200/);
    expect(settingProblem('appearance.floatingOrbSize', 50)).toMatch(/at least 75/);
    expect(settingProblem('appearance.floatingOrbSize', '120')).toMatch(/should be a number/);
  });
});

function fakeClock() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  const clock: TurnClock = {
    now: () => now,
    setTimeout: (fn, ms) => (timers.set(++id, { at: now + ms, fn }), id),
    clearTimeout: (h) => void timers.delete(h as number),
  };
  const advance = async (ms: number) => {
    for (let i = 0; i < 3; i++) await Promise.resolve();
    const until = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
      await Promise.resolve();
    }
    now = until;
  };
  return { clock, advance };
}

describe('holding the shortcut to talk', () => {
  it('keeps the turn open through pauses, and ends it the moment the key comes up', async () => {
    const { clock, advance } = fakeClock();
    const ended: number[] = [];
    const turn = new TurnDetector(() => ended.push(clock.now()), { patience: 'normal' }, clock);
    turn.hold();
    turn.speech(true);
    turn.text('open slack');
    await advance(400);
    turn.speech(false);
    await advance(3000); // a long pause while the key is still down
    expect(ended).toEqual([]);
    turn.speech(true);
    turn.text('open slack and then');
    await advance(500);
    turn.speech(false);
    await advance(200);
    turn.release(true);
    expect(ended).toEqual([clock.now()]);
    expect(turn.open).toBe(false);
  });

  it('after a tap, ends the turn the usual way when the user pauses', async () => {
    const { clock, advance } = fakeClock();
    const ended: number[] = [];
    const turn = new TurnDetector(() => ended.push(clock.now()), { patience: 'normal' }, clock);
    turn.hold();
    turn.release(false); // a tap: nothing said yet
    turn.speech(true);
    turn.text('what time is it');
    await advance(600);
    turn.speech(false);
    const stopped = clock.now();
    await advance(3000);
    expect(ended).toHaveLength(1);
    expect(ended[0]! - stopped).toBeLessThan(1500);
  });

  it('lets go of nothing when nothing was said', async () => {
    const { clock } = fakeClock();
    const ended: number[] = [];
    const turn = new TurnDetector(() => ended.push(clock.now()), {}, clock);
    turn.hold();
    turn.release(true);
    expect(ended).toEqual([]);
  });
});

describe('summoning Nova with the shortcut', () => {
  async function setup(reasoning?: ReasoningBrain) {
    const events: ServerEvent[] = [];
    const platform: Platform = { listApps: async () => ['Slack'], openApp: async () => {}, quitApp: async () => {}, now: () => new Date('2026-09-27T10:00:00') };
    let now = 1_000_000;
    const nova = new NovaBrain({
      engine: new EvaluationDecisionEngine({ name: 'heuristic', model: new HeuristicEvaluationModel() }),
      platform,
      emit: (e) => events.push(e),
      reasoning,
      clock: () => now,
    });
    await nova.init();
    const phases = () => events.filter((e): e is Extract<ServerEvent, { type: 'phase' }> => e.type === 'phase').map((e) => e.phase);
    return { nova, events, phases, later: (ms: number) => (now += ms) };
  }

  it('listens without the wake word, and treats what was said as meant for Nova', async () => {
    const asked: string[] = [];
    const { nova, phases } = await setup({ name: 'Brain', reply: async (u) => (asked.push(u), 'Sunny.') });
    await nova.handle('what is the weather like'); // no wake word, no window: background talk
    expect(asked).toEqual([]);
    nova.listenNow();
    expect(phases().at(-1)).toBe('listening');
    await nova.handle('what is the weather like', 'shortcut');
    expect(asked).toEqual(['what is the weather like']);
  });

  it('stops listening when tapped again', async () => {
    const asked: string[] = [];
    const { nova, phases } = await setup({ name: 'Brain', reply: async (u) => (asked.push(u), 'Hi.') });
    nova.listenNow();
    nova.stopListening();
    expect(phases().at(-1)).toBe('idle');
    await nova.handle('what is the weather like');
    expect(asked).toEqual([]); // the window closed: this was background talk again
  });
});
