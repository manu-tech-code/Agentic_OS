import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { UndoStep } from '@nova/core';
import type { UndoResult } from './actions.ts';

const exec = promisify(execFile);

/**
 * Snapshots of a git project, so what an agent changes can be put back. Before a task, and again
 * after it, Nova records the project's files as a git tree - with a separate index, so the
 * user's staged changes, branches and history are never touched - and keeps the commit under
 * refs/nova/snapshots, out of sight. Undo puts back exactly the files the agent changed, and
 * only if nobody has changed them since.
 */

/** Untracked files bigger than this (a dataset, a video) stay out of snapshots: they're never put back either. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_UNTRACKED_BYTES = 500 * 1024 * 1024;
const REF_PREFIX = 'refs/nova/snapshots/';

type AgentFiles = Extract<UndoStep, { kind: 'agent-files' }>;

/** A task under way: where it works, the snapshot from before, and whether another task shared the project. */
interface Taken {
  root: string;
  before: string;
  shared: boolean;
}

/** Git, with Nova's own identity and nothing from the environment that points it elsewhere. */
async function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  const base: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) base[k] = v;
  // Plumbing where it matters, no hooks, no signing prompts: nothing of the user's setup runs or asks.
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
    env: {
      ...base,
      GIT_AUTHOR_NAME: 'Nova',
      GIT_AUTHOR_EMAIL: 'nova@localhost',
      GIT_COMMITTER_NAME: 'Nova',
      GIT_COMMITTER_EMAIL: 'nova@localhost',
      GIT_TERMINAL_PROMPT: '0',
      ...env,
    },
  });
  return stdout;
}

const paths = (out: string) => out.split('\0').filter(Boolean);

/** The files that differ between two snapshots (plumbing: no textconv, colour or external diff). */
const changedBetween = async (root: string, from: string, to: string) => paths(await git(root, ['diff-tree', '-r', '--name-only', '--no-renames', '-z', from, to]));
const base = (path: string) => path.split('/').pop() ?? path;
const said = (files: string[]) => (files.length === 1 ? base(files[0]!) : files.length <= 3 ? `${files.slice(0, -1).map(base).join(', ')} and ${base(files.at(-1)!)}` : `${files.length} files`);

export class Snapshots {
  private readonly taken = new Map<string, Taken>();
  /** Repositories with Nova's snapshots, so old ones can be cleared out. */
  private repos = new Set<string>();

  constructor(
    private readonly opts: {
      /** Where the list of repositories with snapshots is kept (~/.nova/snapshots.json). */
      file: string;
      /** Whether Settings wants them. */
      enabled: () => boolean;
      /** A project's folder, by name - only ever one from Settings. */
      projectPath: (name: string) => string | undefined;
      keepDays: () => number;
    },
  ) {}

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.opts.file, 'utf8')) as { repos?: string[] };
      this.repos = new Set((parsed.repos ?? []).filter((r) => typeof r === 'string'));
    } catch {
      // none yet
    }
    return this;
  }

  /** The repository a project is in, or null when it isn't in one. */
  async rootOf(project: string): Promise<string | null> {
    const path = this.opts.projectPath(project);
    if (!path) return null;
    try {
      return resolve(path, (await git(path, ['rev-parse', '--show-toplevel'])).trim());
    } catch {
      return null;
    }
  }

  /** Before an agent starts in a project. */
  async before(task: { id: string; project: string; label: string; task: string }) {
    if (!this.opts.enabled()) return;
    const root = await this.rootOf(task.project);
    if (!root) return;
    const commit = await this.commit(root, `Nova snapshot: before ${task.label}'s task`);
    await git(root, ['update-ref', `${REF_PREFIX}${task.id}`, commit]);
    // Two tasks in one project at once: each one's changes hold some of the other's.
    const shared = [...this.taken.values()].filter((t) => t.root === root);
    for (const t of shared) t.shared = true;
    this.taken.set(task.id, { root, before: commit, shared: shared.length > 0 });
    if (!this.repos.has(root)) {
      this.repos.add(root);
      void this.saveRepos();
    }
  }

  /** After it ends, whatever the outcome: how to put back what it changed, or null if it changed nothing. */
  async after(task: { id: string; project: string; label: string }): Promise<AgentFiles | null> {
    const taken = this.taken.get(task.id);
    if (!taken) return null;
    this.taken.delete(task.id);
    const { root, before } = taken;
    const after = await this.commit(root, `Nova snapshot: after ${task.label}'s task`, before);
    const files = await changedBetween(root, before, after);
    if (!files.length) {
      await git(root, ['update-ref', '-d', `${REF_PREFIX}${task.id}`]).catch(() => {});
      return null;
    }
    await git(root, ['update-ref', `${REF_PREFIX}${task.id}`, after]); // it has the one before as its parent
    return { kind: 'agent-files', project: task.project, before, after, agent: task.label, files, ...(taken.shared || this.sharing(root) ? { shared: true } : {}) };
  }

  /**
   * Put back the files an agent changed - if they're as the agent left them. Anything changed
   * since (by the user, most likely) is never overwritten: then nothing is put back.
   */
  async restore(step: AgentFiles): Promise<UndoResult> {
    const root = await this.rootOf(step.project);
    if (!root) return { ok: false, message: `I can't find ${step.project} as a git project any more.` };
    for (const commit of [step.before, step.after]) {
      if (!(await git(root, ['cat-file', '-e', `${commit}^{commit}`]).then(() => true, () => false))) {
        return { ok: false, message: `The snapshot of ${step.project} from before ${step.agent}'s task is gone, so I can't put its files back.` };
      }
    }
    const now = await this.commit(root, 'Nova snapshot: before an undo', step.after);
    const since = new Set(await changedBetween(root, step.after, now));
    const agentFiles = await changedBetween(root, step.before, step.after);
    const edited = agentFiles.filter((f) => since.has(f));
    if (edited.length) {
      return {
        ok: false,
        message: `${said(edited)} ${edited.length === 1 ? 'has' : 'have'} changed since ${step.agent} finished, so I haven't put anything back - that would undo your own edits. You can still do it by hand with git.`,
      };
    }
    const dir = await mkdtemp(join(tmpdir(), 'nova-undo-'));
    try {
      const patch = join(dir, 'undo.patch');
      await writeFile(patch, await git(root, ['diff-tree', '-r', '-p', '--binary', '--full-index', '--no-renames', step.after, step.before]));
      await git(root, ['apply', '--whitespace=nowarn', patch]);
    } catch (e) {
      return { ok: false, message: `I couldn't put back ${step.project}'s files: ${((e as Error).message.split('\n').find((l) => /error|fatal/i.test(l)) ?? (e as Error).message).slice(0, 200)}` };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // Kept a while longer: what was just put back, in case the user wants the agent's version after all.
    await git(root, ['update-ref', `${REF_PREFIX}undo-${Date.now().toString(36)}`, now]).catch(() => {});
    const parent = await git(root, ['rev-parse', '-q', '--verify', `${step.before}^`]).then((s) => s.trim(), () => '');
    const head = await git(root, ['rev-parse', '-q', '--verify', 'HEAD']).then((s) => s.trim(), () => '');
    const n = agentFiles.length;
    return {
      ok: true,
      message:
        `Okay - ${n === 1 ? `${base(agentFiles[0]!)} is` : `the ${n} files ${step.agent} changed in ${step.project} are`} back as ${n === 1 ? 'it was' : 'they were'}.` +
        (head !== parent ? ' The commit made since stays, so what I put back shows as uncommitted changes.' : '') +
        (step.shared ? ' That includes what another task changed there at the same time.' : ''),
    };
  }

  /** Snapshots older than the record are cleared out. */
  async prune() {
    const cutoff = Date.now() / 1000 - this.opts.keepDays() * 86_400;
    for (const root of [...this.repos]) {
      try {
        await stat(root);
      } catch {
        this.repos.delete(root); // the project is gone
        continue;
      }
      const refs = await git(root, ['for-each-ref', '--format=%(refname) %(creatordate:unix)', REF_PREFIX]).catch(() => '');
      for (const line of refs.split('\n').filter(Boolean)) {
        const [ref, at] = line.split(' ');
        if (ref?.startsWith(REF_PREFIX) && Number(at) < cutoff) await git(root, ['update-ref', '-d', ref]).catch(() => {});
      }
    }
    await this.saveRepos();
  }

  /** Whether a task is under way in this repository. */
  private sharing(root: string) {
    return [...this.taken.values()].some((t) => t.root === root);
  }

  /**
   * The project's files as a commit: tracked files as they are now, plus untracked ones that
   * aren't ignored (big ones left out). A separate index, started from the user's, so theirs is
   * never changed and unchanged files aren't read again.
   */
  private async commit(root: string, message: string, parent?: string) {
    const dir = await mkdtemp(join(tmpdir(), 'nova-snapshot-'));
    const index = join(dir, 'index');
    const env = { GIT_INDEX_FILE: index };
    try {
      const own = resolve(root, (await git(root, ['rev-parse', '--git-path', 'index'])).trim());
      await copyFile(own, index).catch(() => {}); // a repository with nothing staged yet has none
      await git(root, ['add', '-u', '--', '.'], env);
      // Untracked files, not ignored: the small ones, up to a total.
      const untracked = paths(await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).filter((f) => !f.endsWith('/'));
      const chosen: string[] = [];
      let total = 0;
      for (const f of untracked) {
        const size = await stat(join(root, f)).then((s) => (s.isFile() || s.isSymbolicLink() ? s.size : -1), () => -1);
        if (size < 0 || size > MAX_FILE_BYTES || total + size > MAX_UNTRACKED_BYTES) continue;
        total += size;
        chosen.push(f);
      }
      if (chosen.length) {
        const list = join(dir, 'untracked');
        await writeFile(list, `${chosen.join('\0')}\0`);
        await git(root, ['add', `--pathspec-from-file=${list}`, '--pathspec-file-nul'], env);
      }
      const tree = (await git(root, ['write-tree'], env)).trim();
      const head = parent ?? (await git(root, ['rev-parse', '-q', '--verify', 'HEAD']).then((s) => s.trim(), () => ''));
      return (await git(root, ['commit-tree', '--no-gpg-sign', tree, ...(head ? ['-p', head] : []), '-m', message])).trim();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async saveRepos() {
    try {
      await mkdir(dirname(this.opts.file), { recursive: true });
      await writeFile(`${this.opts.file}.tmp`, `${JSON.stringify({ repos: [...this.repos] }, null, 2)}\n`, { mode: 0o600 });
      await rename(`${this.opts.file}.tmp`, this.opts.file);
    } catch (e) {
      console.warn(`  [snapshots] can't save ${this.opts.file}: ${(e as Error).message}`);
    }
  }
}
