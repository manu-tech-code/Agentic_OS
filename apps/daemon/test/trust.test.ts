import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ActivityItem, Platform, UndoStep } from '@nova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approvalDetail } from '../src/agents/parsers.ts';
import { loadConfig } from '../src/config.ts';
import { ActionLog } from '../src/trust/actions.ts';
import { privacyFlows } from '../src/trust/privacy.ts';
import { ruleId, TrustRules } from '../src/trust/rules.ts';
import { setupSteps } from '../src/trust/setup.ts';
import { Snapshots } from '../src/trust/snapshots.ts';
import { Undoer } from '../src/trust/undo.ts';

const exec = promisify(execFile);
const temp = (name = 'nova-trust-') => mkdtemp(join(tmpdir(), name));
// Sunday 27 September 2026, 1:43 PM.
const NOW = new Date(2026, 8, 27, 13, 43).getTime();
const DAY = 86_400_000;

let n = 0;
const item = (label: string, extra: Partial<ActivityItem> = {}): ActivityItem => ({ id: `a${++n}`, at: Date.now(), label, status: 'done', by: 'you', ...extra });

describe('the record of actions', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const log = (dir: string, undo = vi.fn(async () => ({ ok: true, message: 'Okay.' })), changed = vi.fn(), keepDays = 30) => ({
    log: new ActionLog({ dir, keepDays: () => keepDays, undo, changed }),
    undo,
    changed,
  });

  it('keeps each action with how to undo it, but windows never see how', async () => {
    const dir = await temp();
    const { log: actions } = log(dir);
    await actions.load();
    const shown = actions.add(item('Reminder: call mum'), { kind: 'reminder-cancel', id: 'r1' });
    expect(shown).toMatchObject({ label: 'Reminder: call mum', undoable: true });
    expect(shown).not.toHaveProperty('undo');
    expect(actions.history()[0]).not.toHaveProperty('undo');
    await actions.flushed();
    const file = join(dir, '2026-09-27.jsonl');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).toContain('"reminder-cancel"');
  });

  it('undoes the latest undoable action - or the latest of the one named - and only once', async () => {
    const dir = await temp();
    const { log: actions, undo, changed } = log(dir);
    await actions.load();
    const first = actions.add(item('Claude finished in site', { by: 'Claude' }), { kind: 'agent-files', project: 'site', before: 'b', after: 'a', agent: 'Claude', files: ['index.html'] });
    actions.add(item('Opened Slack'), { kind: 'app-quit', app: 'Slack' });
    actions.add(item('Told the time'));
    expect(actions.lastUndoable()?.label).toBe('Opened Slack');
    expect(actions.lastUndoable('Claude')).toMatchObject({ label: 'Claude finished in site', files: ['index.html'] });

    expect(await actions.undo(first.id)).toEqual({ ok: true, message: 'Okay.' });
    expect(undo).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agent-files' }), expect.objectContaining({ id: first.id }));
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ id: first.id, undone: NOW }));
    expect(changed.mock.calls[0]![0].undoable).toBeUndefined();
    expect(actions.lastUndoable('Claude')).toBeNull();
    expect((await actions.undo(first.id)).ok).toBe(false);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("comes back after a restart, undone ones still undone - and a failed undo doesn't count", async () => {
    const dir = await temp();
    const failing = vi.fn(async () => ({ ok: false, message: "That reminder isn't there any more." }));
    const { log: actions } = log(dir, failing);
    await actions.load();
    const a = actions.add(item('Reminder: stretch'), { kind: 'reminder-cancel', id: 'gone' });
    const b = actions.add(item('Remembered: my standup is at 10'), { kind: 'memory-forget', id: 'm1' });
    expect((await actions.undo(a.id)).ok).toBe(false);
    await actions.flushed();

    const again = log(dir);
    await again.log.load();
    expect(again.log.lastUndoable()?.id).toBe(b.id);
    await again.log.undo(b.id);
    await again.log.flushed();
    const third = log(dir);
    await third.log.load();
    expect(third.log.lastUndoable()?.id).toBe(a.id); // only the failed one is left to undo
    expect(third.log.history().find((i) => i.id === b.id)).toMatchObject({ undone: NOW });
    expect(third.log.stats()).toEqual({ days: 30, kept: 2 });
  });

  it('keeps what is left of an undo that worked in part, undoable - after a restart too', async () => {
    const dir = await temp();
    const rest: UndoStep = { kind: 'reminder-cancel', id: 'r2' };
    const partly = vi.fn(async () => ({ ok: true, message: 'I put back 1 of the 2; …', rest }));
    const { log: actions, changed } = log(dir, partly);
    await actions.load();
    const a = actions.add(item('Set two reminders'), { kind: 'batch', steps: [{ kind: 'reminder-cancel', id: 'r1' }, rest] });
    expect((await actions.undo(a.id)).ok).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    expect(actions.lastUndoable()?.id).toBe(a.id); // not undone: the rest still can be
    await actions.flushed();

    const again = log(dir);
    await again.log.load();
    expect(again.log.lastUndoable()?.id).toBe(a.id);
    await again.log.undo(a.id);
    expect(again.undo).toHaveBeenCalledWith(rest, expect.objectContaining({ id: a.id })); // only what was left
    expect(again.log.lastUndoable()).toBeNull();
  });

  it('is on disk as undone before it is undone, so stopping halfway never lets it be undone twice', async () => {
    const dir = await temp();
    let during: ActionLog | null = null;
    const undo = vi.fn(async () => {
      // Nova stops here, mid-undo: what the record says on disk.
      during = await new ActionLog({ dir, keepDays: () => 30, undo: async () => ({ ok: true, message: '' }) }).load();
      return { ok: true, message: 'Okay.' };
    });
    const { log: actions } = log(dir, undo);
    await actions.load();
    const a = actions.add(item('Quit Spotify'), { kind: 'app-open', app: 'Spotify' });
    await actions.undo(a.id);
    expect(during!.lastUndoable()).toBeNull();
  });

  it('keeps as many days as Settings says, and searches all of them', async () => {
    const dir = await temp();
    const old = (days: number, label: string) => JSON.stringify({ id: `old${days}`, at: NOW - days * DAY, label, status: 'done', by: days > 20 ? 'Codex' : 'you' });
    const day = (days: number) => {
      const d = new Date(NOW - days * DAY);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`;
    };
    await writeFile(join(dir, day(10)), `${old(10, 'Quit Spotify')}\n`);
    await writeFile(join(dir, day(25)), `${old(25, 'Codex finished in api')}\n{"id":"old25","undone":1}\n`);
    await writeFile(join(dir, day(40)), `${old(40, 'Opened Notes')}\n`);
    const { log: actions } = log(dir);
    await actions.load();
    expect(await readdir(dir)).not.toContain(day(40)); // past the 30 days kept
    expect(actions.recent(7)).toEqual([]); // ten days back isn't at hand
    expect((await actions.search('spotify')).map((i) => i.label)).toEqual(['Quit Spotify']);
    expect(await actions.search('codex undone')).toMatchObject([{ label: 'Codex finished in api', undone: 1 }]);
    expect(await actions.search('spotify', 7)).toEqual([]);
  });
});

describe('remembered permissions', () => {
  it('hold at once, are saved under an id without dots, and list what they allow', async () => {
    const saved: Record<string, unknown>[] = [];
    let settings: Record<string, { key: string; label: string; until?: string }> = {};
    const rules = new TrustRules({ rules: () => settings, save: async (c) => void saved.push(c), now: () => new Date(NOW) });
    const key = 'agent:claude:Agentic_OS:Bash:npm run test.unit';
    await rules.allow(key, 'Claude may run "npm run test.unit" in Agentic_OS');
    expect(rules.allows(key)).toBe(true);
    expect(rules.allows('agent:claude:Agentic_OS:Bash:npm run build')).toBe(false);
    const id = ruleId(key);
    expect(id).toMatch(/^r[0-9a-f]{12}$/);
    expect(saved).toEqual([{ [`trust.rules.${id}`]: { key, label: 'Claude may run "npm run test.unit" in Agentic_OS' } }]);
    settings = { [id]: { key, label: 'Claude may run "npm run test.unit" in Agentic_OS' } };
    rules.configure();
    expect(rules.list()).toEqual([{ key, label: 'Claude may run "npm run test.unit" in Agentic_OS' }]);
  });

  it('"for today" ends with the day, and is cleared out of Settings after', async () => {
    let now = new Date(NOW);
    const saved: Record<string, unknown>[] = [];
    const rules = new TrustRules({ rules: () => ({ rq: { key: 'quit_app:Spotify', label: 'Quit Spotify', until: '2026-09-27' } }), save: async (c) => void saved.push(c), now: () => now });
    expect(rules.allows('quit_app:Spotify')).toBe(true);
    await rules.prune();
    expect(saved).toEqual([]);
    now = new Date(NOW + DAY);
    expect(rules.allows('quit_app:Spotify')).toBe(false);
    expect(rules.snapshot()).toEqual([]);
    await rules.prune();
    expect(saved).toEqual([{ 'trust.rules.rq': null }]);
  });
});

describe('undoing', () => {
  const platform = (): Platform & { calls: string[] } => {
    const calls: string[] = [];
    return { calls, listApps: async () => [], openApp: async (a) => void calls.push(`open ${a}`), quitApp: async (a) => void calls.push(`quit ${a}`), now: () => new Date(NOW) };
  };
  const deps = () => {
    const memory = new Map([['m1', 'my standup is at 10:30']]);
    const reminders = new Set(['r1']);
    const routines: Record<string, unknown> = {};
    const p = platform();
    const state = { project: 'site' as string | null };
    return {
      memory,
      reminders,
      routines,
      platform: p,
      state,
      undoer: new Undoer({
        reminders: { cancel: async (id) => reminders.delete(id), add: async (r) => ({ ...r, id: 'r2' }) },
        memory: { forget: (id) => memory.delete(id), remember: (text) => memory.set('m2', text), edit: (id, text) => memory.has(id) && Boolean(memory.set(id, text)) },
        platform: p,
        project: { set: (name) => void (state.project = name) },
        saveRoutine: async (name, routine) => void (routines[name] = routine),
        snapshots: {} as never,
        now: () => NOW,
      }),
    };
  };
  const action = { id: 'x', at: NOW, label: 'x', status: 'done' as const, undoable: true };

  it('takes back exactly the one thing', async () => {
    const d = deps();
    expect(await d.undoer.run({ kind: 'reminder-cancel', id: 'r1' }, action)).toEqual({ ok: true, message: 'Okay, that reminder is cancelled.' });
    expect((await d.undoer.run({ kind: 'reminder-cancel', id: 'r1' }, action)).ok).toBe(false);
    await d.undoer.run({ kind: 'memory-edit', id: 'm1', text: 'my standup is at 10' }, action);
    expect(d.memory.get('m1')).toBe('my standup is at 10');
    await d.undoer.run({ kind: 'app-quit', app: 'Slack' }, action);
    await d.undoer.run({ kind: 'app-open', app: 'Spotify' }, action);
    expect(d.platform.calls).toEqual(['quit Slack', 'open Spotify']);
    await d.undoer.run({ kind: 'project-set', name: null }, action);
    expect(d.state.project).toBeNull();
    await d.undoer.run({ kind: 'routine-delete', name: 'start work' }, action);
    expect(d.routines).toEqual({ 'start work': null });
  });

  it('puts the text size back as it was - and says so when it has nothing to change it with', async () => {
    const d = deps();
    const set: [string, number][] = [];
    const withPrefs = new Undoer({ ...(d.undoer as unknown as { deps: ConstructorParameters<typeof Undoer>[0] }).deps, prefs: { get: () => 120, set: async (key, value) => void set.push([key, value]) } });
    expect(await withPrefs.run({ kind: 'pref-set', key: 'appearance.textSize', value: 100 }, action)).toEqual({ ok: true, message: 'Okay, the text is back to its normal size.' });
    expect(await withPrefs.run({ kind: 'pref-set', key: 'appearance.textSize', value: 140 }, action)).toEqual({ ok: true, message: 'Okay, the text is back to 140 percent.' });
    expect(set).toEqual([
      ['appearance.textSize', 100],
      ['appearance.textSize', 140],
    ]);
    await expect(d.undoer.run({ kind: 'pref-set', key: 'appearance.textSize', value: 100 }, action)).rejects.toThrow(/can't be put back/);
  });

  it("brings back a reminder only while it's still to come", async () => {
    const d = deps();
    const later = { kind: 'reminder-restore', reminder: { text: 'call mum', about: 'to', due: NOW + 3_600_000 } } as UndoStep;
    const past = { kind: 'reminder-restore', reminder: { text: 'call mum', about: 'to', due: NOW - 3_600_000 } } as UndoStep;
    expect(await d.undoer.run(later, action)).toEqual({ ok: true, message: 'Okay, the reminder is back.' });
    expect((await d.undoer.run(past, action)).ok).toBe(false);
  });

  it('says how much of a batch came back, and keeps what is left to undo', async () => {
    const d = deps();
    const batch: UndoStep = { kind: 'batch', steps: [{ kind: 'reminder-cancel', id: 'r1' }, { kind: 'reminder-cancel', id: 'nope' }, { kind: 'app-quit', app: 'Slack' }] };
    expect(await d.undoer.run(batch, action)).toEqual({
      ok: true,
      message: "I put back 2 of the 3; that reminder isn't there any more - it may have gone off already.",
      rest: { kind: 'reminder-cancel', id: 'nope' },
    });
    const none: UndoStep = { kind: 'batch', steps: [{ kind: 'reminder-cancel', id: 'nope' }] };
    expect(await d.undoer.run(none, action)).toEqual({ ok: false, message: "That reminder isn't there any more - it may have gone off already." });
  });
});

// Real git in each test: slow on a busy CI runner, so these get longer than the usual five seconds.
describe('snapshots of agents’ projects', { timeout: 30_000 }, () => {
  const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })).stdout;
  let repo: string;
  let home: string;
  const snapshots = (enabled = true) =>
    new Snapshots({ file: join(home, 'snapshots.json'), enabled: () => enabled, projectPath: (name) => (name === 'site' ? repo : name === 'plain' ? home : undefined), keepDays: () => 30 });
  const task = { id: 't1', project: 'site', label: 'Claude', task: 'tidy the styles' };

  beforeEach(async () => {
    repo = await temp('nova-repo-');
    home = await temp('nova-home-');
    await git(repo, 'init', '-q');
    await writeFile(join(repo, 'index.html'), '<h1>Hi</h1>\n');
    await writeFile(join(repo, 'style.css'), 'h1 { color: red; }\n');
    await writeFile(join(repo, '.gitignore'), 'secret.txt\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'first');
    // The user's own work in progress: one change staged, one file not yet added.
    await writeFile(join(repo, 'index.html'), '<h1>Hello</h1>\n');
    await git(repo, 'add', 'index.html');
    await writeFile(join(repo, 'notes.md'), 'todo\n');
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("puts back exactly the files the agent edited, and never the user's staging", async () => {
    const s = await snapshots().load();
    const staged = await git(repo, 'diff', '--cached', '--name-only');
    await s.before(task);
    // The agent edits and adds (its Edit/Write steps say so - absolute, or from its folder), and deletes with a command.
    await writeFile(join(repo, 'style.css'), 'h1 { color: blue; }\n');
    await writeFile(join(repo, 'new.js'), 'console.log(1)\n');
    s.edited(task.id, [join(repo, 'style.css'), 'new.js']);
    await rm(join(repo, 'notes.md'));
    await writeFile(join(repo, 'secret.txt'), 'ignored, never snapshotted\n');
    const step = await s.after(task);
    expect(step).toMatchObject({ kind: 'agent-files', project: 'site', agent: 'Claude' });
    expect(step!.files.sort()).toEqual(['new.js', 'style.css']);
    expect(await git(repo, 'for-each-ref', '--format=%(refname)', 'refs/nova/snapshots/')).toContain('refs/nova/snapshots/t1');

    const result = await s.restore(step!);
    expect(result).toMatchObject({ ok: true });
    expect(result.message).toContain('the 2 files Claude changed in site are back as they were');
    expect(result.message).toContain('notes.md changed while Claude worked, but not by its own edits - I left it, it may be yours.');
    expect(await readFile(join(repo, 'style.css'), 'utf8')).toBe('h1 { color: red; }\n');
    await expect(stat(join(repo, 'new.js'))).rejects.toThrow();
    await expect(stat(join(repo, 'notes.md'))).rejects.toThrow(); // not one of its own edits: left as it is
    expect(await readFile(join(repo, 'secret.txt'), 'utf8')).toContain('ignored'); // not the agent's to take back
    expect(await readFile(join(repo, 'index.html'), 'utf8')).toBe('<h1>Hello</h1>\n');
    expect(await git(repo, 'diff', '--cached', '--name-only')).toBe(staged);
    expect(await git(repo, 'log', '--oneline')).toMatch(/^\w+ first\n$/); // no commits of Nova's on the branch
  });

  it("leaves what the user edited while the agent worked, and says so", async () => {
    const s = await snapshots().load();
    await s.before(task);
    await writeFile(join(repo, 'style.css'), 'h1 { color: blue; }\n');
    s.edited(task.id, [join(repo, 'style.css')]);
    // Meanwhile the user goes on with their own work.
    await writeFile(join(repo, 'index.html'), '<h1>Hello, world</h1>\n');
    await writeFile(join(repo, 'todo.md'), 'ship it\n');
    const step = (await s.after(task))!;
    expect(step.files).toEqual(['style.css']);
    const result = await s.restore(step);
    expect(result.ok).toBe(true);
    expect(result.message).toBe(
      'Okay - style.css is back as it was. index.html and todo.md changed while Claude worked, but not by its own edits - I left them, they may be yours.',
    );
    expect(await readFile(join(repo, 'style.css'), 'utf8')).toBe('h1 { color: red; }\n');
    expect(await readFile(join(repo, 'index.html'), 'utf8')).toBe('<h1>Hello, world</h1>\n');
    expect(await readFile(join(repo, 'todo.md'), 'utf8')).toBe('ship it\n');
  });

  it('looks only at the project’s own folder in a monorepo', async () => {
    await mkdir(join(repo, 'app'));
    await mkdir(join(repo, 'other'));
    await writeFile(join(repo, 'app', 'a.ts'), 'a\n');
    await writeFile(join(repo, 'other', 'b.ts'), 'b\n');
    await git(repo, 'add', 'app', 'other');
    await git(repo, 'commit', '-q', '-m', 'packages');
    const s = new Snapshots({ file: join(home, 'snapshots.json'), enabled: () => true, projectPath: () => join(repo, 'app'), keepDays: () => 30 });
    const app = { ...task, project: 'app' };
    await s.before(app);
    await writeFile(join(repo, 'app', 'a.ts'), 'agent\n');
    await writeFile(join(repo, 'style.css'), 'h1 { color: blue; }\n'); // outside its folder: never taken back
    s.edited(app.id, ['a.ts', '../style.css']);
    await writeFile(join(repo, 'other', 'b.ts'), 'the user, in another package\n');
    const step = (await s.after(app))!;
    expect(step.files).toEqual(['app/a.ts']);
    const result = await s.restore(step);
    expect(result).toEqual({ ok: true, message: 'Okay - a.ts is back as it was.' });
    expect(await readFile(join(repo, 'app', 'a.ts'), 'utf8')).toBe('a\n');
    expect(await readFile(join(repo, 'other', 'b.ts'), 'utf8')).toBe('the user, in another package\n');
    expect(await readFile(join(repo, 'style.css'), 'utf8')).toBe('h1 { color: blue; }\n');
  });

  it('never deletes a file that was there before the task, ignored or not', async () => {
    await writeFile(join(repo, '.gitignore'), 'secret.txt\n.env\n');
    await git(repo, 'commit', '-q', '-am', 'ignore .env');
    await writeFile(join(repo, '.env'), 'TOKEN=mine\n');
    const s = await snapshots().load();
    await s.before(task);
    // The agent rewrites .gitignore: .env isn't ignored any more, so it's new to the snapshot after.
    await writeFile(join(repo, '.gitignore'), 'secret.txt\n');
    s.edited(task.id, ['.gitignore']);
    const step = (await s.after(task))!;
    expect(step.files).toEqual(['.gitignore']);
    const result = await s.restore(step);
    expect(result.message).toBe('Okay - .gitignore is back as it was. .env changed while Claude worked, but not by its own edits - I left it, it may be yours.');
    expect(await readFile(join(repo, '.env'), 'utf8')).toBe('TOKEN=mine\n');
    expect(await readFile(join(repo, '.gitignore'), 'utf8')).toBe('secret.txt\n.env\n');

    // Even one it wrote to itself stays: it isn't the agent's to delete.
    await s.before({ ...task, id: 't2' });
    await writeFile(join(repo, '.gitignore'), 'secret.txt\n');
    await writeFile(join(repo, '.env'), 'TOKEN=the agent\n');
    s.edited('t2', ['.gitignore', '.env']);
    const second = (await s.after({ ...task, id: 't2' }))!;
    expect(second.files.sort()).toEqual(['.env', '.gitignore']);
    const again = await s.restore(second);
    expect(again).toMatchObject({ ok: true, message: 'Okay - .gitignore is back as it was. .env was there before the task, so I left it.' });
    await expect(stat(join(repo, '.env'))).resolves.toBeTruthy();
  });

  it('puts back text that is not UTF-8 byte for byte', async () => {
    const latin1 = Buffer.from('caf\xe9 cr\xe8me\n', 'latin1');
    await writeFile(join(repo, 'menu.txt'), latin1);
    await git(repo, 'add', 'menu.txt');
    await git(repo, 'commit', '-q', '-m', 'menu');
    const s = await snapshots().load();
    await s.before(task);
    await writeFile(join(repo, 'menu.txt'), Buffer.from('th\xe9\n', 'latin1'));
    s.edited(task.id, ['menu.txt']);
    const result = await s.restore((await s.after(task))!);
    expect(result.ok).toBe(true);
    expect((await readFile(join(repo, 'menu.txt'))).equals(latin1)).toBe(true);
  });

  it('keeps big untracked binaries out of snapshots', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 1);
    big[10] = 0;
    await writeFile(join(repo, 'video.bin'), big);
    await writeFile(join(repo, 'draft.md'), 'small and new\n');
    const s = await snapshots().load();
    await s.before(task);
    const tree = await git(repo, 'ls-tree', '-r', '--name-only', 'refs/nova/snapshots/t1');
    expect(tree).toContain('draft.md');
    expect(tree).not.toContain('video.bin');
    expect(await git(repo, 'cat-file', 'commit', 'refs/nova/snapshots/t1')).toContain('"video.bin"'); // listed as there, so never deleted
  });

  it("says so when none of what changed was the agent's own editing - and changes nothing", async () => {
    const s = await snapshots().load();
    await s.before(task);
    await writeFile(join(repo, 'style.css'), 'h1 { color: blue; }\n'); // a command it ran, or the user
    const step = (await s.after(task))!;
    expect(step).toMatchObject({ kind: 'agent-files', files: [] });
    const result = await s.restore(step);
    expect(result).toEqual({
      ok: false,
      message: "None of what changed in site was Claude's own editing, so I haven't put anything back: style.css changed while it worked - it may be yours. You can still do it by hand with git.",
    });
    expect(await readFile(join(repo, 'style.css'), 'utf8')).toBe('h1 { color: blue; }\n');
  });

  it("refuses rather than overwrite what the user changed since - and changes nothing", async () => {
    const s = await snapshots().load();
    await s.before(task);
    await writeFile(join(repo, 'style.css'), 'h1 { color: blue; }\n');
    await writeFile(join(repo, 'new.js'), 'console.log(1)\n');
    s.edited(task.id, ['style.css', 'new.js']);
    const step = (await s.after(task))!;
    await writeFile(join(repo, 'style.css'), 'h1 { color: green; }\n'); // the user's own edit
    const result = await s.restore(step);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('style.css has changed since Claude finished');
    expect(await readFile(join(repo, 'style.css'), 'utf8')).toBe('h1 { color: green; }\n');
    expect(await readFile(join(repo, 'new.js'), 'utf8')).toBe('console.log(1)\n');
  });

  it("says so when there's been a commit since, and puts the files back uncommitted", async () => {
    const s = await snapshots().load();
    await s.before(task);
    await writeFile(join(repo, 'style.css'), 'h1 { color: blue; }\n');
    s.edited(task.id, ['style.css']);
    await git(repo, 'commit', '-q', '-am', "the agent's commit");
    const step = (await s.after(task))!;
    const result = await s.restore(step);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('The commit made since stays');
    expect(await readFile(join(repo, 'style.css'), 'utf8')).toBe('h1 { color: red; }\n');
  });

  it('offers nothing when nothing changed, or the project is not a git repository, or snapshots are off', async () => {
    const s = await snapshots().load();
    await s.before(task);
    expect(await s.after(task)).toBeNull();
    expect(await git(repo, 'for-each-ref', 'refs/nova/')).toBe('');
    await s.before({ ...task, id: 't2', project: 'plain' });
    expect(await s.after({ ...task, id: 't2', project: 'plain' })).toBeNull();
    const off = await snapshots(false).load();
    await off.before(task);
    await writeFile(join(repo, 'style.css'), 'changed\n');
    expect(await off.after(task)).toBeNull();
  });

  it('marks tasks that shared a project', async () => {
    const s = await snapshots().load();
    await s.before(task);
    await s.before({ ...task, id: 't2', label: 'Codex' });
    await writeFile(join(repo, 'style.css'), 'h1 { color: blue; }\n');
    s.edited(task.id, ['style.css']);
    expect(await s.after(task)).toMatchObject({ shared: true, files: ['style.css'] });
  });
});

describe('the privacy page', () => {
  const base = { reflex: true, hasJevKey: false, brain: true, integrations: [], hearing: { engine: 'apple' as const, state: 'ready' as const }, voiceInstalled: true, isLocal: (id: string) => id.startsWith('lmstudio/') };

  it("says where each thing goes, with the brain's destination for what goes with questions", () => {
    const flows = privacyFlows({ ...base, config: loadConfig({}, {}), agents: [{ name: 'claude', label: 'Claude', paired: true }, { name: 'codex', label: 'Codex', paired: false }] });
    const by = Object.fromEntries(flows.map((f) => [f.id, f]));
    expect(by.hearing).toMatchObject({ leaves: false, where: "this Mac (Apple's on-device recognizer)" });
    expect(by.decisions).toMatchObject({ leaves: false, where: 'this Mac (Reflex)' });
    expect(by.answers).toMatchObject({ leaves: true, where: 'Anthropic, through Claude - on your own plan' });
    expect(by['screen-context']).toMatchObject({ leaves: true, on: true, toggle: { key: 'screen.context', on: true, off: false } });
    expect(by['agent-claude']).toMatchObject({ on: true, toggle: { key: 'agents.enabled', on: ['claude'], off: [] } });
    expect(by['agent-codex']).toMatchObject({ on: false, toggle: { key: 'agents.enabled', on: ['claude', 'codex'], off: ['claude'] } });
    expect(by.weather).toMatchObject({ on: false }); // no town set
  });

  it('sends what is said to TypeSafe only when Jev decides - chosen, and with its key', () => {
    const jev = loadConfig({ decisions: { engine: 'jev' } }, {});
    const decisions = (input: Partial<typeof base>, config = jev) => privacyFlows({ ...base, ...input, config, agents: [] }).find((f) => f.id === 'decisions');
    expect(decisions({})).toMatchObject({ leaves: false, where: 'this Mac (Reflex)' }); // no key: Reflex decides
    expect(decisions({ hasJevKey: true })).toMatchObject({ leaves: true, where: 'TypeSafe (Jev, jev-latest), at api.typesafe.ai' });
    expect(decisions({ hasJevKey: true })?.detail).toMatch(/last three exchanges.*Reflex decides on this Mac/);
    expect(decisions({ hasJevKey: true }, loadConfig({ decisions: { engine: 'jev', fallback: 'heuristic' } }, {}))?.detail).toMatch(/the keyword matcher decides on this Mac/);
    expect(decisions({ hasJevKey: true }, loadConfig({ decisions: { engine: 'jev', fallback: 'none' } }, {}))?.detail).toMatch(/Nova says it failed/);
    expect(decisions({ hasJevKey: true }, loadConfig({}, {}))).toMatchObject({ leaves: false }); // automatic stays here
    // A decision model that isn't on the user's servers can't be reached: nothing leaves.
    expect(decisions({}, loadConfig({ decisions: { engine: 'llm', model: 'anthropic/claude-haiku-4.5' } }, {}))).toMatchObject({ leaves: false, where: 'this Mac (Reflex)' });
  });

  it('keeps it on this Mac with a local model', () => {
    const flows = privacyFlows({ ...base, config: loadConfig({ answers: { model: 'lmstudio/qwen3' } }, {}), agents: [] });
    expect(flows.find((f) => f.id === 'answers')).toMatchObject({ leaves: false, where: 'this Mac (lmstudio/qwen3)' });
    expect(flows.find((f) => f.id === 'memories')).toMatchObject({ leaves: false });
  });
});

describe('the setup checklist', () => {
  it('says what is missing, and the fix', () => {
    const steps = setupSteps({
      config: loadConfig({}, {}),
      reflex: { installed: false, learned: 0, label: 'potion-base-8M · English · 31 MB' },
      voice: { installed: false, label: 'Kokoro 82M · natural voices · 326 MB' },
      hearing: { status: { engine: 'apple', state: 'ready' }, parakeet: {} as never, smartTurn: {} as never, speech: {} as never },
      app: null,
      appInstalled: false,
      agents: [{ name: 'claude', label: 'Claude' }],
      brain: 'Claude',
      projects: [{ name: 'site', git: true }, { name: 'drafts', git: false }],
      screen: { available: true, running: false, permissions: null },
    });
    const by = Object.fromEntries(steps.map((s) => [s.id, s]));
    expect(by.reflex).toMatchObject({ done: false, fix: { install: 'reflex' } });
    expect(by.reflex!.detail).toContain('31 MB');
    expect(by.voice).toMatchObject({ done: false, fix: { command: 'npm run app' } });
    expect(by.voice!.optional).toBeUndefined(); // Nova's one voice isn't optional
    expect(by.agents).toMatchObject({ done: true });
    expect(by.projects!.detail).toContain("drafts isn't a git repository");
    expect(by.app).toMatchObject({ done: false, fix: { command: 'npm run app' } });
  });
});

describe("what an agent's yes-always covers", () => {
  it('is exactly the command, the site or the file', () => {
    expect(approvalDetail('Bash', { command: 'npm   test\n' })).toBe('npm test');
    expect(approvalDetail('WebFetch', { url: 'https://docs.github.com/en/rest?x=1' })).toBe('docs.github.com');
    expect(approvalDetail('Edit', { file_path: '/p/src/a.ts' })).toBe('/p/src/a.ts');
    expect(approvalDetail('mcp__linear__create_issue', {})).toBe('');
  });
});
