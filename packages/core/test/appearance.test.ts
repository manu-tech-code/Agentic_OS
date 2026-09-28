import { describe, expect, it } from 'vitest';
import { builtinSkills, parseTextSize, settingProblem, TEXT_SIZE, textSizeAfter, type PrefKey, type SkillContext } from '../src/index.ts';

describe('the text size, said aloud', () => {
  it('reads bigger and smaller - and how much, from "a bit" to "a lot"', () => {
    expect(parseTextSize('make the text bigger')).toEqual({ action: 'bigger', by: 20 });
    expect(parseTextSize('increase the font size')).toEqual({ action: 'bigger', by: 20 });
    expect(parseTextSize('make the text a little smaller')).toEqual({ action: 'smaller', by: 10 });
    expect(parseTextSize('can you make the text a lot bigger')).toEqual({ action: 'bigger', by: 40 });
    expect(parseTextSize('turn the text size up')).toEqual({ action: 'bigger', by: 20 });
    expect(parseTextSize('your words are huge, bring them down')).toEqual({ action: 'smaller', by: 20 });
    expect(parseTextSize('zoom in on the text')).toEqual({ action: 'bigger', by: 20 });
  });

  it('hears what the text is like now as asking for the other way', () => {
    expect(parseTextSize('the text is too small')).toMatchObject({ action: 'bigger' });
    expect(parseTextSize("i can't read the captions")).toMatchObject({ action: 'bigger' });
    expect(parseTextSize('the font is way too big')).toMatchObject({ action: 'smaller' });
  });

  it('reads sizes in numbers and in words', () => {
    expect(parseTextSize('text size 150 percent')).toEqual({ action: 'set', value: 150 });
    expect(parseTextSize('set the font to 120%')).toEqual({ action: 'set', value: 120 });
    expect(parseTextSize('make the text 130')).toEqual({ action: 'set', value: 130 });
    expect(parseTextSize('go to one hundred and twenty percent on the text')).toEqual({ action: 'set', value: 120 });
    expect(parseTextSize('set the text to seventy five percent')).toEqual({ action: 'set', value: 75 });
    expect(parseTextSize('make the text one and a half times bigger')).toEqual({ action: 'set', value: 150 });
    expect(parseTextSize('double the text size')).toEqual({ action: 'set', value: 200 });
    expect(parseTextSize('1.5x text')).toEqual({ action: 'set', value: 150 });
  });

  it('reads going back to normal, and asking how big it is', () => {
    expect(parseTextSize('reset the text size')).toEqual({ action: 'reset' });
    expect(parseTextSize('put the font size back where it started')).toEqual({ action: 'reset' });
    expect(parseTextSize("what's the text size")).toEqual({ action: 'query' });
    expect(parseTextSize('how large is the font set at the moment')).toEqual({ action: 'query' });
  });

  it("isn't fooled by text that isn't about Nova's text, or by sizes that aren't asked for", () => {
    for (const said of ['make it bigger', 'send a text to mum', 'text mum that i am running late', 'copy the text', 'look up the text of the constitution', 'open the big text file', 'read me the small print']) {
      expect(parseTextSize(said), said).toBeNull();
    }
  });

  it('keeps the size within its range, on its steps', () => {
    expect(textSizeAfter(100, { action: 'bigger', by: 20 })).toBe(120);
    expect(textSizeAfter(190, { action: 'bigger', by: 20 })).toBe(TEXT_SIZE.max);
    expect(textSizeAfter(80, { action: 'smaller', by: 20 })).toBe(TEXT_SIZE.min);
    expect(textSizeAfter(100, { action: 'set', value: 133 })).toBe(135);
    expect(textSizeAfter(100, { action: 'set', value: 500 })).toBe(200);
    expect(textSizeAfter(150, { action: 'reset' })).toBe(100);
    // The same range as the slider in Settings → Appearance.
    expect(settingProblem('appearance.textSize', TEXT_SIZE.max)).toBeNull();
    expect(settingProblem('appearance.textSize', TEXT_SIZE.max + 5)).toMatch(/at most 200/);
    expect(settingProblem('appearance.textSize', TEXT_SIZE.min - 5)).toMatch(/at least 75/);
  });
});

describe('the text_size skill', () => {
  const skill = builtinSkills.find((s) => s.id === 'text_size')!;
  function prefsAt(size: number) {
    const saved: { key: PrefKey; value: number }[] = [];
    let now = size;
    return {
      saved,
      prefs: {
        get: () => now,
        set: async (key: PrefKey, value: number) => void (saved.push({ key, value }), (now = value)),
      },
    };
  }
  const run = (utterance: string, prefs?: ReturnType<typeof prefsAt>['prefs']) => skill.run({ utterance, heard: utterance, prefs } as unknown as SkillContext);

  it('changes the text size, says how big it is now, and can be undone', async () => {
    const { prefs, saved } = prefsAt(100);
    const bigger = await run('make the text bigger', prefs);
    expect(bigger.say).toBe('The text is at 120 percent now.');
    expect(bigger.undo).toEqual({ kind: 'pref-set', key: 'appearance.textSize', value: 100 });
    expect(saved).toEqual([{ key: 'appearance.textSize', value: 120 }]);
    expect((await run('reset the text size', prefs)).say).toBe('The text is back to its normal size.');
    expect(skill.tier).toBe(0); // harmless, and undone in a word
  });

  it("says so at the ends of the range, answers how big it is, and asks when it can't tell", async () => {
    const top = prefsAt(200);
    expect((await run('make the text bigger', top.prefs)).say).toMatch(/already at 200 percent - that's as big as it goes/);
    expect(top.saved).toEqual([]);
    expect((await run("what's the text size", prefsAt(100).prefs)).say).toBe('The text is at its normal size.');
    expect((await run('text size', prefsAt(100).prefs)).say).toMatch(/Bigger, smaller, or a size like 150 percent/);
    expect((await run('make the text bigger')).say).toMatch(/Settings → Appearance can/); // nothing to change it with here
  });
});
