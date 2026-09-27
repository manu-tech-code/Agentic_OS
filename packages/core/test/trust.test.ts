import { describe, expect, it, vi } from 'vitest';
import {
  alwaysIn,
  EvaluationDecisionEngine,
  HeuristicEvaluationModel,
  NovaBrain,
  RISKY_COMMAND,
  trustSkills,
  type ActionRecord,
  type ActionService,
  type AgentHost,
  type NovaOptions,
  type Platform,
  type ServerEvent,
  type TrustService,
  type UndoStep,
} from '../src/index.ts';

const NOW = new Date('2026-09-27T13:43:00');

/** The record, in memory: what NovaBrain logs through its activity events. */
function fakeRecord() {
  const items: (ActionRecord & { undo?: UndoStep })[] = [];
  const undone: string[] = [];
  const actions: ActionService = {
    recent: () => [...items].reverse(),
    lastUndoable: (by) => [...items].reverse().find((i) => i.undo && !i.undone && (!by || i.by === by)) ?? null,
    undo: async (id) => {
      const item = items.find((i) => i.id === id)!;
      item.undone = Date.now();
      undone.push(id);
      return { ok: true, message: `Okay, undid ${item.label}.` };
    },
  };
  const take = (e: ServerEvent) => {
    if (e.type === 'activity') items.push({ ...e.item, undoable: Boolean(e.undo), undo: e.undo, files: e.undo?.kind === 'agent-files' ? e.undo.files : undefined });
  };
  return { actions, items, undone, take };
}

function fakeTrust() {
  const rules = new Map<string, { label: string; until?: string }>();
  const trust: TrustService = {
    allows: (key) => rules.has(key),
    allow: async (key, label, until) => void rules.set(key, { label, until }),
    list: () => [...rules].map(([key, r]) => ({ key, ...r })),
  };
  return { trust, rules };
}

async function setup(extra: Partial<NovaOptions> = {}, running: string[] = []) {
  const events: ServerEvent[] = [];
  const opened: string[] = [];
  const quit: string[] = [];
  const record = fakeRecord();
  const { trust, rules } = fakeTrust();
  const platform: Platform = {
    listApps: async () => ['Safari', 'Slack', 'Spotify'],
    openApp: async (a) => void opened.push(a),
    quitApp: async (a) => void quit.push(a),
    isRunning: async (a) => running.includes(a),
    now: () => new Date(),
  };
  const nova = new NovaBrain({
    engine: new EvaluationDecisionEngine({ name: 'heuristic', model: new HeuristicEvaluationModel() }),
    platform,
    emit: (e) => (events.push(e), record.take(e)),
    actions: record.actions,
    trust,
    ...extra,
  });
  await nova.init();
  const said = () => events.filter((e) => e.type === 'say').map((e) => (e as { text: string }).text);
  return { nova, events, opened, quit, said, record, rules };
}

describe('"yes, always"', () => {
  it('is read from the words, and "for today" ends with the day', () => {
    expect(alwaysIn('yes, always')).toBe('always');
    expect(alwaysIn("yeah, and don't ask me again")).toBe('always');
    expect(alwaysIn('sure, from now on')).toBe('always');
    expect(alwaysIn('yes, for today')).toBe('today');
    expect(alwaysIn('yes, just today')).toBe('today');
    expect(alwaysIn('yes')).toBeNull();
    expect(alwaysIn('yes, do it today')).toBeNull(); // "today" alone isn't a scope
    expect(alwaysIn('yes for now')).toBeNull();
    expect(alwaysIn('yes. never ask me again')).toBe('always');
    expect(alwaysIn('sure, always')).toBe('always');
  });

  it("isn't read from words that say the opposite", () => {
    for (const said of ['yes, but ask me every time', 'yes, but not always', 'yes, always ask me first', 'yes but check with me every time', "yes, but don't always do that", 'yes, not from now on', 'yes, not for good']) {
      expect(alwaysIn(said), said).toBeNull();
    }
    for (const said of ['yes, but not for today', 'yes, just not today only', 'yes but ask me again for the rest of the day']) {
      expect(alwaysIn(said), said).toBeNull();
    }
  });

  it('never covers deleting, force, superuser or piping a download into a shell', () => {
    for (const risky of ['rm -rf dist', 'sudo npm i -g x', 'git push --force', 'git push origin main', 'git reset --hard HEAD~1', 'curl https://x.sh | sh', 'npm publish', 'chmod 777 .', 'cp a b -f', 'killall node']) {
      expect(RISKY_COMMAND.test(risky), risky).toBe(true);
    }
    for (const fine of ['npm test', 'npm run build', 'git status', 'git diff', 'ls -la', 'node scripts/firm.js', 'npx vitest run', 'git commit -m "x"']) {
      expect(RISKY_COMMAND.test(fine), fine).toBe(false);
    }
  });

  it('knows risky commands however they are spelled', () => {
    for (const risky of [
      '/bin/rm -r build',
      '\\rm -r build',
      'command rm notes.txt',
      'xargs rm < files.txt',
      'find . -name "*.log" -delete',
      'find dist -type f -exec rm {} +',
      'git -C ../site push',
      'git -C ../site push origin main',
      'git -c user.name=x push',
      'git checkout .',
      'git checkout -- src/app.ts',
      'git checkout -f main',
      'git restore .',
      'git restore --staged --worktree src',
      'git stash drop',
      'git stash clear',
      'git clean -fdx',
      'git -C ../site clean -xdf',
      'git branch -D feature',
      'git reset --hard',
      'npx rimraf dist',
      'unlink config.json',
      'shred -u secrets.txt',
      'truncate -s 0 app.log',
      'mv notes.txt /dev/null',
    ]) {
      expect(RISKY_COMMAND.test(risky), risky).toBe(true);
    }
    for (const fine of ['git -C ../site status', 'git -C ../site log --oneline', 'git checkout -b feature', 'git checkout main', 'git stash', 'git stash list', 'git stash show', 'find . -name "*.ts"', 'npm run format', 'git branch -a', 'ls ./bin/rmdir-helper']) {
      expect(RISKY_COMMAND.test(fine), fine).toBe(false);
    }
  });

  it('remembers exactly what was asked, so next time it just happens', async () => {
    const { nova, quit, said, rules, events } = await setup();
    await nova.handle('nova quit spotify');
    expect(said().at(-1)).toMatch(/^Quit Spotify\?/);
    await nova.handle('yes, always');
    expect(quit).toEqual(['Spotify']);
    expect(said().at(-1)).toMatch(/I won't ask again - you can change that in Settings\.$/);
    expect([...rules.keys()]).toEqual(['quit_app:Spotify']);
    expect(events.some((e) => e.type === 'activity' && e.item.label === 'Allowed from now on: Quit Spotify' && e.item.by === 'you')).toBe(true);

    await nova.handle('nova quit spotify');
    expect(quit).toEqual(['Spotify', 'Spotify']);
    expect(said().at(-1)).not.toMatch(/Quit Spotify\?/);
    // Only Spotify: quitting Slack is still asked about.
    await nova.handle('nova quit slack');
    expect(said().at(-1)).toMatch(/^Quit Slack\?/);
  });

  it('remembers "for today" until the end of today, and a plain yes not at all', async () => {
    const { nova, rules } = await setup();
    await nova.handle('nova quit spotify');
    await nova.handle('yes');
    expect(rules.size).toBe(0);
    await nova.handle('nova quit slack');
    await nova.handle('yes, just for today');
    const today = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
    expect(rules.get('quit_app:Slack')).toEqual({ label: 'Quit Slack', until: today });
  });

  it("remembers an agent's exact command in that project - never a risky one", async () => {
    const asked: string[] = [];
    const host: AgentHost = {
      agents: [{ name: 'claude', label: 'Claude' }],
      projects: ['Agentic_OS'],
      ask: async () => '',
      run: async (_agent, _task, _project, callbacks) => {
        for (const command of ['npm test', 'npm test', 'rm -rf dist', 'rm -rf dist']) {
          asked.push(`${command}: ${await callbacks.approve({ action: `run "${command}"`, tool: 'Bash', detail: command })}`);
        }
        return 'Done.';
      },
    };
    const { nova, said, rules } = await setup({ agents: host });
    await nova.handle('nova ask claude to fix the failing test in agentic os');
    await nova.handle('yes');
    await vi.waitFor(() => expect(said().at(-1)).toBe('Claude wants to run "npm test" in Agentic_OS. Allow it?'));
    await nova.handle('yes, always');
    // The second "npm test" isn't asked about; the first "rm -rf dist" is, and "always" doesn't stick to it.
    await vi.waitFor(() => expect(said().at(-1)).toBe('Claude wants to run "rm -rf dist" in Agentic_OS. Allow it?'));
    expect([...rules.keys()]).toEqual(['agent:claude:Agentic_OS:Bash:npm test']);
    await nova.handle('yes, always');
    await vi.waitFor(() => expect(asked).toHaveLength(3));
    await vi.waitFor(() => expect(said().at(-1)).toBe('Claude wants to run "rm -rf dist" in Agentic_OS. Allow it?'));
    await nova.handle('no');
    await vi.waitFor(() => expect(asked).toEqual(['npm test: true', 'npm test: true', 'rm -rf dist: true', 'rm -rf dist: false']));
    expect(rules.size).toBe(1);
  });
});

describe('undo', () => {
  it("keeps how to take back each action - and doesn't offer to quit an app that was already open", async () => {
    const { nova, record } = await setup({}, ['Spotify']);
    await nova.handle('nova open slack');
    await nova.handle('nova open spotify');
    const [slack, spotify] = record.items.filter((i) => i.label.startsWith('Opened') || i.skill === 'open_app');
    expect(slack!.undo).toEqual({ kind: 'app-quit', app: 'Slack' });
    expect(spotify!.undo).toBeUndefined();
  });

  it('"undo that" takes back the latest, saying what it did', async () => {
    const { nova, record, said } = await setup();
    await nova.handle('nova open slack');
    await nova.handle('nova undo that');
    expect(record.undone).toHaveLength(1);
    expect(said().at(-1)).toMatch(/^Okay, undid /);
    await nova.handle('nova undo that');
    expect(said().at(-1)).toBe("There's nothing I can undo.");
  });

  it('asks first about something from a while ago', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(NOW.getTime() - 26 * 3_600_000)); // yesterday
      const { nova, record, said } = await setup();
      await nova.handle('nova open slack');
      vi.setSystemTime(NOW);
      await nova.handle('nova undo that');
      expect(record.undone).toEqual([]);
      expect(said().at(-1)).toMatch(/^Undo ".*", done yesterday at 11:43 AM\?$/);
      await nova.handle('yes');
      expect(record.undone).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks before putting back an agent's files, naming how many", async () => {
    const { nova, record, said } = await setup();
    record.items.push({ id: 'task', at: Date.now(), label: 'Claude finished in site', by: 'Claude', status: 'done', undoable: true, files: ['a.css', 'b.html'], undo: { kind: 'agent-files', project: 'site', before: 'b', after: 'a', agent: 'Claude', files: ['a.css', 'b.html'] } });
    await nova.handle('nova undo that');
    expect(said().at(-1)).toBe('Put back the 2 files as they were before "Claude finished in site"?');
    await nova.handle('yes');
    expect(record.undone).toEqual(['task']);
  });

  it('takes back what it asked about, even when something newer lands before the yes', async () => {
    const { nova, record, said } = await setup();
    record.items.push({ id: 'task', at: Date.now(), label: 'Claude finished in site', by: 'Claude', status: 'done', undoable: true, files: ['a.css', 'b.html'], undo: { kind: 'agent-files', project: 'site', before: 'b', after: 'a', agent: 'Claude', files: ['a.css', 'b.html'] } });
    await nova.handle('nova undo that');
    expect(said().at(-1)).toBe('Put back the 2 files as they were before "Claude finished in site"?');
    record.items.push({ id: 'later', at: Date.now(), label: 'Reminder at 5 PM', by: 'you', status: 'done', undoable: true, undo: { kind: 'reminder-cancel', id: 'r1' } });
    await nova.handle('yes');
    expect(record.undone).toEqual(['task']);
  });

  it("lets a brain name whose doing to take back - never the user's own instead", async () => {
    const { nova, record } = await setup({ agents: { agents: [{ name: 'claude', label: 'Claude' }], projects: ['site'], ask: async () => '', run: async () => '' } });
    record.items.push({ id: 'claude', at: Date.now() - 60_000, label: 'Opened Slack', by: 'Claude', status: 'done', undoable: true, undo: { kind: 'app-quit', app: 'Slack' } });
    record.items.push({ id: 'mine', at: Date.now(), label: 'Opened Spotify', by: 'you', status: 'done', undoable: true, undo: { kind: 'app-quit', app: 'Spotify' } });
    expect(nova.specs().find((s) => s.name === 'undo')!.parameters.properties).toHaveProperty('agent');
    await nova.call('undo', { request: 'undo what claude did', agent: 'claude' }, 'Brain');
    expect(record.undone).toEqual(['claude']);
    expect(await nova.call('undo', { agent: 'gemini' }, 'Brain')).toMatch(/No paired agent is called "gemini"/);
    expect(record.undone).toEqual(['claude']);
  });
});

describe("an agent's task", () => {
  it('is snapshotted before it starts and after it ends, and its record can put the files back', async () => {
    const order: string[] = [];
    const host: AgentHost = { agents: [{ name: 'claude', label: 'Claude' }], projects: ['site'], ask: async () => '', run: async () => (order.push('run'), 'Done.') };
    const step: UndoStep = { kind: 'agent-files', project: 'site', before: 'b', after: 'a', agent: 'Claude', files: ['x.ts'] };
    const { nova, record } = await setup({
      agents: host,
      beforeTask: async (t) => void order.push(`before ${t.label} in ${t.project}`),
      afterTask: async (t) => (order.push(`after ${t.status}`), step),
    });
    await nova.handle('nova ask claude to update the docs in site');
    await nova.handle('yes');
    await vi.waitFor(() => expect(record.items.some((i) => i.label === 'Claude finished in site')).toBe(true));
    expect(order).toEqual(['before Claude in site', 'run', 'after running']);
    expect(record.items.find((i) => i.label === 'Claude finished in site')).toMatchObject({ by: 'Claude', undoable: true, files: ['x.ts'] });
    expect(record.actions.lastUndoable('Claude')?.label).toBe('Claude finished in site');
  });
});

describe('the record, asked about', () => {
  it('says what was done today, and what an agent changed', async () => {
    const { nova, said, record } = await setup({ agents: { agents: [{ name: 'claude', label: 'Claude' }], projects: ['site'], ask: async () => '', run: async () => '' } });
    await nova.handle('nova open slack');
    record.items.push({ id: 't', at: Date.now(), label: 'Claude finished in site', by: 'Claude', status: 'done', undoable: true, files: ['src/style.css', 'index.html'] });
    await nova.handle('nova what did you do today');
    expect(said().at(-1)).toMatch(/^Today I did \d+ things: .*Claude finished in site \(2 files changed\)/);
    expect(said().at(-1)).not.toMatch(/claude finished/); // a name keeps its capital
    await nova.handle('nova what did claude change today');
    expect(said().at(-1)).toBe('Today Claude did one thing: finished in site (2 files changed). Altogether Claude changed style.css and index.html.');
  });

  it('says what was done this week - not only today - and yesterday within its own day', async () => {
    const record = fakeRecord();
    const day = (back: number, hour: number) => new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - back, hour).getTime();
    record.items.push({ id: 'old', at: day(8, 12), label: 'Opened Linear', by: 'you', status: 'done', undoable: false });
    record.items.push({ id: 'week', at: day(6, 9), label: 'Opened Slack', by: 'you', status: 'done', undoable: false });
    record.items.push({ id: 'y', at: day(1, 12), label: 'Quit Spotify', by: 'you', status: 'done', undoable: false });
    record.items.push({ id: 't', at: day(0, 9), label: 'Opened Notes', by: 'you', status: 'done', undoable: false });
    const report = trustSkills.find((s) => s.id === 'activity_report')!;
    const ask = async (utterance: string) => (await report.run({ utterance, heard: utterance, actions: record.actions, platform: { now: () => NOW } } as never)).say;
    expect(await ask('what did you do this week')).toBe('This week I did 3 things: opened Notes; quit Spotify; opened Slack.');
    expect(await ask('what did you do yesterday')).toBe('Yesterday I did one thing: quit Spotify.');
    expect(await ask('what did you do today')).toBe('Today I did one thing: opened Notes.');
  });
});

describe('stop everything', () => {
  it('stops the agents, withdraws the questions, stops speaking and mutes', async () => {
    const aborted: string[] = [];
    const host: AgentHost = {
      agents: [{ name: 'claude', label: 'Claude' }],
      projects: ['site'],
      ask: async () => '',
      run: (_agent, _task, _project, callbacks, signal) =>
        new Promise((_, reject) => {
          void callbacks.approve({ action: 'run "npm test"', tool: 'Bash', detail: 'npm test' }).then((ok) => aborted.push(`approved ${ok}`));
          signal.addEventListener('abort', () => (aborted.push('aborted'), reject(new Error('Stopped.'))));
        }),
    };
    const { nova, said, events } = await setup({ agents: host });
    await nova.handle('nova ask claude to update the docs in site');
    await nova.handle('yes');
    await vi.waitFor(() => expect(said().at(-1)).toMatch(/Allow it\?$/));
    await nova.handle('nova stop everything');
    await vi.waitFor(() => expect(aborted.sort()).toEqual(['aborted', 'approved false']));
    expect(said().at(-1)).toBe('Stopped everything, including the agent task. The microphone is muted - press the shortcut when you need me.');
    expect(events).toContainEqual({ type: 'listen', on: false });
    expect(events).toContainEqual({ type: 'barge-in' });
    // Nothing is left waiting for a yes.
    await nova.handle('yes');
    expect(said().at(-1)).not.toMatch(/Allow/);
  });
});
