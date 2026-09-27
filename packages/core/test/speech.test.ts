import { afterEach, describe, expect, it, vi } from 'vitest';
import { isBargeIn, isEcho, soundsUnfinished, SpeechActivity, TurnDetector, UtteranceAssembler, type TurnClock } from '../src/speech.ts';

describe('whole utterances from pieces of speech', () => {
  afterEach(() => vi.useRealTimers());

  it('knows when speech sounds cut off', () => {
    expect(soundsUnfinished('Okay in my current project right I want to let')).toBe(true);
    expect(soundsUnfinished('open slack and')).toBe(true);
    expect(soundsUnfinished('okay so')).toBe(true);
    expect(soundsUnfinished('what time is it')).toBe(false);
    expect(soundsUnfinished('how are you')).toBe(false);
    expect(soundsUnfinished('open slack please')).toBe(false);
    expect(soundsUnfinished('yes I can')).toBe(false);
    expect(soundsUnfinished('open Figma.')).toBe(false);
  });

  it('joins pieces that follow each other, waiting longer while a sentence is unfinished', () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const joiner = new UtteranceAssembler((t) => sent.push(t));
    joiner.final('okay in my current project');
    vi.advanceTimersByTime(300);
    joiner.interim(); // still talking
    vi.advanceTimersByTime(1000);
    joiner.final('I want to let');
    vi.advanceTimersByTime(1500); // unfinished: keeps waiting
    expect(sent).toEqual([]);
    joiner.final('Claude fix the build');
    vi.advanceTimersByTime(600);
    expect(sent).toEqual(['okay in my current project I want to let Claude fix the build']);
  });

  it('sends a finished sentence after a short pause', () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const joiner = new UtteranceAssembler((t) => sent.push(t));
    joiner.final('open slack');
    vi.advanceTimersByTime(600);
    expect(sent).toEqual(['open slack']);
  });
});

/** A clock the test moves by hand. */
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
    for (let i = 0; i < 3; i++) await Promise.resolve(); // verdicts already on their way arrive first
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
    await Promise.resolve();
  };
  return { clock, advance };
}

describe('hearing on the Mac', () => {
  const tone = (ms: number, amplitude: number) => Int16Array.from({ length: ms * 16 }, (_, i) => Math.round(amplitude * Math.sin(i / 3)));

  it('finds speech by loudness against the room, and waits out short gaps', () => {
    const vad = new SpeechActivity();
    expect(vad.push(tone(500, 20))).toBe(null); // a quiet room
    expect(vad.push(tone(200, 8000))).toBe('start');
    expect(vad.push(tone(100, 20))).toBe(null); // a gap between words
    expect(vad.push(tone(200, 8000))).toBe(null);
    expect(vad.push(tone(400, 20))).toBe('end');
    expect(vad.active).toBe(false);
  });

  it('ends a turn soon after a finished sentence, and waits when it trails off', async () => {
    const { clock, advance } = fakeClock();
    const ended: number[] = [];
    const turn = new TurnDetector(() => ended.push(clock.now()), { patience: 'normal' }, clock);
    turn.speech(true);
    turn.text('open slack please');
    turn.speech(false);
    await advance(399);
    expect(ended).toEqual([]);
    await advance(1);
    expect(ended).toEqual([400]);

    turn.reset();
    turn.speech(true);
    turn.text('in my current project I want to');
    turn.speech(false);
    await advance(1000);
    expect(ended).toHaveLength(1); // still waiting for the rest
    turn.speech(true); // ...and it comes: the same turn
    turn.text('in my current project I want to set a timer');
    turn.speech(false);
    await advance(400);
    expect(ended).toHaveLength(2);
  });

  it("lets Smart Turn's ear for tone end the wait early, or stretch it", async () => {
    const { clock, advance } = fakeClock();
    let verdict = 0.97;
    const ended: number[] = [];
    const turn = new TurnDetector(() => ended.push(clock.now()), { patience: 'normal', judge: async () => verdict }, clock);
    turn.speech(true);
    turn.text('open slack');
    turn.speech(false);
    await advance(150);
    expect(ended).toEqual([150]); // it heard a finished sentence

    turn.reset();
    verdict = 0.05;
    turn.speech(true);
    turn.text('open slack'); // the words look complete, but the voice says more is coming
    turn.speech(false);
    await advance(1000);
    expect(ended).toHaveLength(1);
    await advance(700);
    expect(ended).toHaveLength(2);
  });

  it("knows Nova's own voice from the user talking over it", () => {
    const said = 'Opening Figma now. It should be on your screen in a moment.';
    expect(isEcho('it should be on your screen', said)).toBe(true);
    expect(isEcho('open slack instead', said)).toBe(false);
    expect(isBargeIn('stop', said)).toBe(true);
    expect(isBargeIn('nova wait', said)).toBe(true);
    expect(isBargeIn('actually open slack', said)).toBe(true);
    expect(isBargeIn('on your screen', said)).toBe(false); // echo
    expect(isBargeIn('okay', said)).toBe(false); // one word that isn't "stop"
  });

  it("isn't stopped by its own voice saying a stop word, and answers to the name it was given", () => {
    expect(isBargeIn('no', 'No timers are running.')).toBe(false); // Nova's own "No…", heard back
    expect(isBargeIn('stop', 'Stop everything? Say yes or no.')).toBe(false);
    expect(isBargeIn('no', 'Quit Spotify? Unsaved work could be lost.')).toBe(true);
    expect(isBargeIn('no stop', 'No timers are running.')).toBe(true); // more than the echo
    const jarvis = ['hey jarvis', 'okay jarvis', 'jarvis'];
    const said = 'Opening Figma now. It should be on your screen in a moment.';
    expect(isBargeIn('jarvis', said, jarvis)).toBe(true);
    expect(isBargeIn('nova', said, jarvis)).toBe(false); // not its name any more
    expect(isBargeIn('okay', said, jarvis)).toBe(false); // half a wake word
  });
});
