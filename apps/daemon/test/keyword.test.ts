import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Keyword, keywordProblem, normalise } from '../src/hearing/keyword.ts';

const fresh = async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'nova-keyword-')), 'voiceid-keyword.json');
  return { file, keyword: await new Keyword(file).load() };
};

describe("Voice ID's master keyword", () => {
  it('compares words as said, whatever the case, punctuation or accents', () => {
    expect(normalise('  Pineapple, Éxpress! ')).toBe('pineapple express');
    expect(normalise("Don't   stop")).toBe('dont stop');
  });

  it('is long enough never to be said by chance - never a single common word', () => {
    expect(keywordProblem('banana')).toMatch(/at least two words and eight letters/);
    expect(keywordProblem('go now')).toMatch(/at least two words/);
    expect(keywordProblem('pineapple express')).toBeNull();
  });

  it('keeps only a salted hash, readable by the user alone - never its words', async () => {
    const { file, keyword } = await fresh();
    expect(keyword.isSet).toBe(false);
    await keyword.set('Pineapple Express');
    const kept = await readFile(file, 'utf8');
    expect(kept).not.toMatch(/pineapple|express/i);
    expect(JSON.parse(kept)).toMatchObject({ version: 1, words: 2, letters: 17, iterations: 20_000 });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(keyword.set('banana')).rejects.toThrow(/two words/);
  });

  it('is found anywhere in what was heard, and gives back what came after it', async () => {
    const { keyword } = await fresh();
    await keyword.set('pineapple express');
    expect(keyword.find('Manuel, pineapple express - open Safari please')).toEqual({ rest: 'open Safari please' });
    expect(keyword.find('PINEAPPLE EXPRESS.')).toEqual({ rest: '' });
    expect(keyword.find('pineapple juice express')).toBeNull();
    expect(keyword.find('a pineapple, and an express train')).toBeNull();
    expect(keyword.find('open safari')).toBeNull();
  });

  it('keeps Voice ID off from when it was said until the user turns it back on - across a restart', async () => {
    const { file, keyword } = await fresh();
    await keyword.set('pineapple express');
    expect(keyword.overriddenAt).toBeNull();
    await keyword.override(new Date('2026-09-28T10:42:00Z'));
    expect((await new Keyword(file).load()).overriddenAt).toBe('2026-09-28T10:42:00.000Z');
    await keyword.set('mango tango sunrise'); // a new keyword keeps Voice ID as it is
    expect(keyword.overriddenAt).toBe('2026-09-28T10:42:00.000Z');
    await keyword.restore();
    expect((await new Keyword(file).load()).overriddenAt).toBeNull();
    await keyword.clear();
    await expect(stat(file)).rejects.toThrow();
    expect((await new Keyword(file).load()).isSet).toBe(false);
  });
});
