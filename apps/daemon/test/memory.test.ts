import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { dayName, Journal, MemoryStore } from '../src/memory/store.ts';
import { describeContext, Eyes, sweepEyesSockets } from '../src/screen/eyes.ts';

const temp = () => mkdtemp(join(tmpdir(), 'nova-memory-'));
/** Local noon, some days back: never on the wrong side of midnight or a clock change. */
const daysBack = (n: number) => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n, 12).getTime();
};

async function store(dir: string, keepDays: number | null = 90) {
  return new MemoryStore(join(dir, 'memory.json'), () => null, new Journal(join(dir, 'conversations'), () => keepDays)).load();
}

describe('the memory store', () => {
  it('keeps memories in a file only the user can read, and reads them back', async () => {
    const dir = await temp();
    const memory = await store(dir);
    memory.remember('my standup is at 10', 'said');
    memory.remember("I'm vegetarian", 'suggested');
    memory.remember('My standup is at 10', 'said'); // the same again: the newer wording replaces it
    await memory.flushed();
    expect(memory.list().map((m) => m.text)).toEqual(['My standup is at 10', "I'm vegetarian"]);
    const file = join(dir, 'memory.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const again = await store(dir);
    expect(again.list().map((m) => [m.text, m.source])).toEqual([
      ['My standup is at 10', 'said'],
      ["I'm vegetarian", 'suggested'],
    ]);
    expect(again.list()[0]!.updated).toBeGreaterThanOrEqual(again.list()[0]!.created);
  });

  it('offers all memories when there are few, and only related ones when there are many', async () => {
    const memory = await store(await temp());
    memory.remember('my standup is at 10', 'said');
    memory.remember('my car is a blue toyota', 'said');
    expect(memory.recall('when is my standup')[0]!.text).toBe('my standup is at 10');
    expect(memory.recall('when is my standup')).toHaveLength(2);
    for (const fact of ['my sister lives in kumasi', 'the wifi is called home five', 'i like my coffee black', 'my gym days are monday and thursday', 'the office is on the third floor', 'my flight is on tuesday', 'the deadline is friday'])
      memory.remember(fact, 'said');
    expect(memory.recall('when is my standup').map((m) => m.text)).toEqual(['my standup is at 10']);
    expect(memory.relevant('what should I wear to the gym').map((m) => m.text)).toEqual(['my gym days are monday and thursday']);
  });

  it('edits, forgets and clears', async () => {
    const dir = await temp();
    const memory = await store(dir);
    const { id } = memory.remember('my standup is at 10', 'said');
    const car = memory.remember('my car is blue', 'said');
    expect(memory.edit(id, 'my standup is at 11')).toBe(true);
    expect(memory.edit('nope', 'x')).toBe(false);
    expect(memory.forget(car.id)).toBe(true);
    expect(memory.forget(car.id)).toBe(false);
    await memory.flushed();
    expect((await store(dir)).list().map((m) => m.text)).toEqual(['my standup is at 11']);
    await memory.clear();
    expect((await store(dir)).list()).toEqual([]);
  });

  it('reads a file edited by hand, skipping what it cannot use', async () => {
    const dir = await temp();
    await writeFile(join(dir, 'memory.json'), JSON.stringify([{ id: 'a', text: 'my car is blue', created: 1, source: 'said' }, { text: 'no id' }, 'junk']));
    expect((await store(dir)).list().map((m) => m.text)).toEqual(['my car is blue']);
    await writeFile(join(dir, 'memory.json'), '{ not json');
    expect((await store(dir)).list()).toEqual([]);
  });

  it('says what a memory said before when saying it again rewords it, so undoing puts those words back', async () => {
    const memory = await store(await temp());
    const first = memory.remember('my standup is at 10', 'said');
    expect(first.replaced).toBeUndefined();
    const again = memory.remember('My standup is at 10', 'said');
    expect(again).toEqual({ id: first.id, text: 'My standup is at 10', replaced: 'my standup is at 10' });
    expect(memory.edit(again.id, again.replaced!)).toBe(true); // what undo does with it
    expect(memory.list().map((m) => m.text)).toEqual(['my standup is at 10']);
  });

  it("keeps a file it can't read beside, and never writes over it", async () => {
    const dir = await temp();
    const file = join(dir, 'memory.json');
    await writeFile(file, '{ "memories": [ { "id": "a", "text": "my car is bl');
    const memory = await store(dir);
    memory.remember('my standup is at 10', 'said');
    await memory.flushed();
    const kept = (await readdir(dir)).find((n) => /^memory\.unreadable-\d{8}-\d{6}\.json$/.test(n));
    expect(await readFile(join(dir, kept!), 'utf8')).toContain('my car is bl');
    expect(JSON.parse(await readFile(file, 'utf8')).memories.map((m: { text: string }) => m.text)).toEqual(['my standup is at 10']);

    // One it can't even read, nor move: left alone, nothing saved over it.
    const locked = await temp();
    await writeFile(join(locked, 'memory.json'), '[]');
    await chmod(join(locked, 'memory.json'), 0o000);
    const blind = await store(locked);
    blind.remember('my car is blue', 'said');
    await blind.flushed();
    await chmod(join(locked, 'memory.json'), 0o600);
    expect(await readFile(join(locked, 'memory.json'), 'utf8')).toBe('[]');
  });

  it('keeps what was edited by hand while Nova ran, with its own changes on top', async () => {
    const dir = await temp();
    const file = join(dir, 'memory.json');
    const memory = await store(dir);
    const standup = memory.remember('my standup is at 10', 'said');
    const car = memory.remember('my car is blue', 'said');
    await memory.flushed();
    // By hand: one reworded, one deleted, one added.
    const byHand = JSON.parse(await readFile(file, 'utf8')) as { memories: { id: string; text: string }[] };
    byHand.memories = [{ ...byHand.memories.find((m) => m.id === standup.id)!, text: 'my standup is at 9:30' }, { id: 'hand', text: 'my gym days are monday and thursday', created: 1, source: 'said' } as never];
    await new Promise((r) => setTimeout(r, 20)); // a different modification time
    await writeFile(file, JSON.stringify(byHand));
    memory.remember('i like my coffee black', 'said');
    await memory.flushed();
    expect(JSON.parse(await readFile(file, 'utf8')).memories.map((m: { text: string }) => m.text)).toEqual(['my standup is at 9:30', 'my gym days are monday and thursday', 'i like my coffee black']);
    expect(memory.list().some((m) => m.id === car.id)).toBe(false);
  });
});

describe('past conversations', () => {
  it("keeps each day's turns in a private file named by the user's own calendar day", async () => {
    const dir = await temp();
    const journal = new Journal(join(dir, 'conversations'), () => 90);
    await journal.append({ user: 'open slack', nova: 'Opening Slack.' }, daysBack(1));
    await journal.append({ user: 'what time is it', nova: "It's nine." }, daysBack(1) + 60_000);
    await journal.append({ user: 'tell me a joke about penguins', nova: 'Why did the penguin cross the road?' }, daysBack(0));
    expect((await readdir(join(dir, 'conversations'))).sort()).toEqual([`${dayName(daysBack(1))}.jsonl`, `${dayName(daysBack(0))}.jsonl`]);
    expect((await stat(join(dir, 'conversations', `${dayName(daysBack(0))}.jsonl`))).mode & 0o777).toBe(0o600);
    expect(await journal.stats()).toEqual({ days: 2, turns: 3 });

    const none = () => undefined;
    const yesterday = await journal.search('what did I ask you yesterday', 365, none);
    expect(yesterday.map((t) => t.user)).toEqual(['what time is it', 'open slack']); // newest first
    expect((await journal.search('what did we say about penguins', 365, none)).map((t) => t.user)).toEqual(['tell me a joke about penguins']);
    expect(await journal.search('what did we say about volcanoes', 365, none)).toEqual([]);
  });

  it('forgets days older than the user keeps, and clears on request', async () => {
    const dir = await temp();
    let keep: number | null = 7;
    const journal = new Journal(join(dir, 'conversations'), () => keep);
    await journal.append({ user: 'old', nova: 'old' }, daysBack(10));
    await journal.append({ user: 'recent', nova: 'recent' }, daysBack(3));
    await journal.prune();
    expect((await journal.search('what did i ask', 365, () => undefined)).map((t) => t.user)).toEqual(['recent']);
    keep = null; // forever
    await journal.append({ user: 'older', nova: 'older' }, daysBack(400));
    await journal.prune();
    expect((await journal.stats()).days).toBe(2);
    await journal.clear();
    expect(await journal.stats()).toEqual({ days: 0, turns: 0 });
  });

  it('is searched through the store', async () => {
    const dir = await temp();
    const memory = await store(dir);
    await memory.journal.append({ user: 'set a timer for pasta', nova: 'Timer set.' }, daysBack(2));
    expect((await memory.searchConversations('did i ask about pasta')).map((t) => t.user)).toEqual(['set a timer for pasta']);
  });
});

describe('what Nova is told about the screen', () => {
  it('describes the app, page and selection', () => {
    expect(describeContext({ app: 'Safari', page: 'Pull request 12', url: 'https://github.com/nova/pull/12', selection: 'const x = 1' })).toBe(
      'The user is working in Safari, "Pull request 12" (https://github.com/nova/pull/12).\nText they have selected:\n"""\nconst x = 1\n"""',
    );
    expect(describeContext({ app: 'Xcode', window: 'Nova — Build' })).toBe('The user is working in Xcode, "Nova — Build".');
    expect(describeContext({ app: 'Finder' })).toBe('The user is working in Finder.');
  });

  it("says nothing of Nova's own window, but tells what was in front before it", () => {
    expect(describeContext({ app: 'Nova', isNova: true })).toBeNull();
    expect(describeContext(null)).toBeNull();
    // A locked screen or a password prompt isn't work.
    expect(describeContext({ app: 'loginwindow', bundleId: 'com.apple.loginwindow' })).toBeNull();
    expect(describeContext({ app: 'SecurityAgent', bundleId: 'com.apple.SecurityAgent' })).toBeNull();
    expect(describeContext({ app: 'Xcode', window: 'Build failed', before: true, isNova: false }, 'Jarvis')).toBe(
      'Just before switching to Jarvis, the user was working in Xcode, "Build failed".',
    );
  });

  it('keeps a long selection short', () => {
    const text = describeContext({ app: 'Notes', selection: 'x'.repeat(5000) })!;
    expect(text.length).toBeLessThan(1600);
  });
});

const EYES = fileURLToPath(new URL('../native/eyes/.build/release/nova-eyes', import.meta.url));
describe.skipIf(platform() !== 'darwin' || !existsSync(EYES))('Nova Eyes', () => {
  it('reads text on this Mac', { timeout: 90_000 }, async () => {
    const { stdout } = await promisify(execFile)(EYES, ['--ocr-selftest', 'Nova can read this'], { timeout: 85_000 });
    expect(JSON.parse(stdout).text).toBe('Nova can read this');
  });

  it('says which permissions it has', async () => {
    const { stdout } = await promisify(execFile)(EYES, ['--permissions'], { timeout: 10_000 });
    expect(Object.keys(JSON.parse(stdout)).sort()).toEqual(['accessibility', 'screen']);
  });
});

describe("Nova Eyes' sockets", () => {
  /** A socket file as a killed process leaves it: bound, then gone before it could remove it. */
  const strand = (path: string) =>
    spawnSync(process.execPath, ['-e', "require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))", path]);

  it("are swept once their daemon is gone, never a live process's, and nothing else in the folder is touched", async () => {
    const dir = await temp();
    const dead = spawnSync(process.execPath, ['-e', '']).pid; // processes that have come and gone
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    try {
      // pid 1 is launchd: alive, though not this user's to signal (EPERM).
      const kept = [live.pid, process.pid, 1].map((pid) => `eyes-${pid}.sock`);
      for (const name of [`eyes-${dead}.sock`, ...kept]) strand(join(dir, name));
      await writeFile(join(dir, 'ws-token'), 'secret\n', { mode: 0o600 });
      await writeFile(join(dir, `eyes-${gone}.sock`), ''); // named like one, but not a socket
      await writeFile(join(dir, `eyes-${dead}.sock.old`), '');

      expect(await sweepEyesSockets(dir)).toEqual([`eyes-${dead}.sock`]);
      expect((await readdir(dir)).sort()).toEqual([...kept, `eyes-${gone}.sock`, `eyes-${dead}.sock.old`, 'ws-token'].sort());
      for (const name of kept) expect((await lstat(join(dir, name))).isSocket()).toBe(true);
      expect(await readFile(join(dir, 'ws-token'), 'utf8')).toBe('secret\n');
      expect(await sweepEyesSockets(dir)).toEqual([]);
      expect(await sweepEyesSockets(join(dir, 'missing'))).toEqual([]);
    } finally {
      live.kill();
    }
  });

  it('go when the daemon closes Nova Eyes', async () => {
    const dir = await temp();
    vi.stubEnv('NOVA_SETTINGS_FILE', join(dir, 'settings.json'));
    try {
      const path = join(dir, 'run', `eyes-${process.pid}.sock`);
      await mkdir(join(dir, 'run'));
      strand(path);
      expect(existsSync(path)).toBe(true);
      new Eyes({ skipTitles: () => [], images: () => false }).close();
      expect(existsSync(path)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

it('keeps conversation files readable as plain JSON lines', async () => {
  const dir = await temp();
  const journal = new Journal(dir, () => 90);
  await journal.append({ user: 'hi', nova: 'Hello.' }, daysBack(0));
  const line = JSON.parse((await readFile(join(dir, `${dayName(daysBack(0))}.jsonl`), 'utf8')).trim());
  expect(line).toMatchObject({ user: 'hi', nova: 'Hello.' });
});
