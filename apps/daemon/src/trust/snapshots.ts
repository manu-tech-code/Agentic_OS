import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { UndoStep } from '@nova/core';
import type { UndoResult } from './actions.ts';

const exec = promisify(execFile);

/**
 * Snapshots of a git project, so what an agent changes can be put back. Before a task, and again
 * after it, Nova records the project's folder as a git tree - with a separate index, so the
 * user's staged changes, branches and history are never touched - and keeps the commit under
 * refs/nova/snapshots, out of sight. Undo puts back only the files the agent itself edited (its
 * Edit/Write steps say which), and only if nobody has changed them since. Whatever else changed
 * while it worked - the user's own edits, most likely - is left, and named.
 */

/** Untracked files bigger than this (a dataset, a video) stay out of snapshots: they're never put back either. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Untracked binaries (an image, an archive) are kept only while they're small. */
const MAX_BINARY_BYTES = 1024 * 1024;
/** What one snapshot may add of untracked files altogether - each snapshot's new content stays in .git/objects. */
const MAX_UNTRACKED_BYTES = 64 * 1024 * 1024;
/** Files that were there before a task but aren't in its snapshot (ignored, too big) are listed, up to this many. */
const MAX_KEPT = 20_000;
/** Paths per git command line. */
const CHUNK = 200;
const REF_PREFIX = 'refs/nova/snapshots/';
/** The line in a "before" snapshot's message that says how it was taken. */
const META = 'nova-snapshot: ';

type AgentFiles = Extract<UndoStep, { kind: 'agent-files' }>;

/** How a "before" snapshot was taken: what undo must know about the project as it was. */
interface Meta {
  /** The project's folder, from the top of the repository ("" when it is the top). */
  scope: string;
  /** When it was taken: a file born before this was there before the task. */
  at: number;
  /** There, but not in the snapshot - ignored (folders end in "/"), or too big to keep. Never deleted by undo. */
  kept: string[];
  /** More were left out than listed. */
  partial?: boolean;
}

/** A task under way: where it works, the snapshot from before, the files it says it edited. */
interface Taken {
  project: string;
  /** The repository's top, as git sees it (symlinks resolved). */
  root: string;
  /** The project's folder in it. */
  scope: string;
  /** The folder the agent works in, as Settings has it: its relative paths start here. */
  dir: string;
  before: string;
  shared: boolean;
  edits: Set<string>;
}

/** Git, with Nova's own identity and nothing from the environment that points it elsewhere. */
function gitEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) base[k] = v;
  return {
    ...base,
    GIT_AUTHOR_NAME: 'Nova',
    GIT_AUTHOR_EMAIL: 'nova@localhost',
    GIT_COMMITTER_NAME: 'Nova',
    GIT_COMMITTER_EMAIL: 'nova@localhost',
    GIT_TERMINAL_PROMPT: '0',
    // A file named "[id].tsx" is that file, not a pattern.
    GIT_LITERAL_PATHSPECS: '1',
    ...env,
  };
}
// Plumbing where it matters, no hooks, no signing prompts: nothing of the user's setup runs or asks.
const GIT = ['-c', 'core.hooksPath=/dev/null'];
const MAX_BUFFER = 256 * 1024 * 1024;

async function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  const { stdout } = await exec('git', [...GIT, ...args], { cwd, maxBuffer: MAX_BUFFER, env: gitEnv(env) });
  return stdout;
}

/** Git's output as it is: a patch is bytes, and text that isn't UTF-8 must come back exactly. */
async function gitBytes(cwd: string, args: string[]) {
  const { stdout } = await exec('git', [...GIT, ...args], { cwd, maxBuffer: MAX_BUFFER, env: gitEnv({}), encoding: 'buffer' });
  return stdout;
}

const paths = (out: string) => out.split('\0').filter(Boolean);
const within = (scope: string) => (scope ? ['--', scope] : []);
const chunks = <T>(list: T[]) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK));

/** The files that differ between two snapshots, in the project's folder (plumbing: no textconv, colour or external diff). */
const changedBetween = async (root: string, from: string, to: string, scope: string, filter?: 'A') =>
  paths(await git(root, ['diff-tree', '-r', '--name-only', '--no-renames', ...(filter ? [`--diff-filter=${filter}`] : []), '-z', from, to, ...within(scope)]));
const base = (path: string) => path.split('/').pop() ?? path;
const said = (files: string[]) => (files.length === 1 ? base(files[0]!) : files.length <= 3 ? `${files.slice(0, -1).map(base).join(', ')} and ${base(files.at(-1)!)}` : `${files.length} files`);
/** JSON with nothing but ASCII, for a commit message. */
const ascii = (json: string) => json.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** A path as it is on disk - symlinks resolved, and the letters' case as the disk has it - even once it's deleted. */
async function onDisk(path: string): Promise<string> {
  const rest: string[] = [];
  for (let at = path; ; ) {
    try {
      return join(await realpath(at), ...rest);
    } catch {
      const up = dirname(at);
      if (up === at) return path;
      rest.unshift(basename(at));
      at = up;
    }
  }
}

/** A file's size, or -1 when it isn't a file (gone already, a folder). Symlinks are kept as links. */
const sizeOf = (path: string) => lstat(path).then((s) => (s.isFile() ? s.size : s.isSymbolicLink() ? 0 : -1), () => -1);

/** Binary, the way git decides it: a zero byte near the start. */
async function binary(path: string) {
  const file = await open(path, 'r').catch(() => null);
  if (!file) return true;
  try {
    const head = Buffer.alloc(8000);
    const { bytesRead } = await file.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead).includes(0);
  } finally {
    await file.close();
  }
}

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
    return (await this.whereIs(project))?.root ?? null;
  }

  /** Before an agent starts in a project. */
  async before(task: { id: string; project: string; label: string; task: string }) {
    if (!this.opts.enabled()) return;
    const where = await this.whereIs(task.project);
    if (!where) return;
    const { root, scope, dir } = where;
    const commit = await this.commit(root, scope, `Nova snapshot: before ${task.label}'s task`, { record: true });
    await git(root, ['update-ref', `${REF_PREFIX}${task.id}`, commit]);
    // Two tasks in one project at once: each one's changes hold some of the other's.
    const shared = [...this.taken.values()].filter((t) => t.root === root);
    for (const t of shared) t.shared = true;
    this.taken.set(task.id, { project: task.project, root, scope, dir, before: commit, shared: shared.length > 0, edits: new Set() });
    if (!this.repos.has(root)) {
      this.repos.add(root);
      void this.saveRepos();
    }
  }

  /**
   * An agent says it edited these files (its Edit/Write steps, as absolute paths or from its
   * folder): the only ones undoing its task puts back. Files it changed any other way - a command
   * it ran - can't be told from the user's own edits, so undo leaves them.
   */
  edited(task: string, files: readonly string[]) {
    const taken = this.taken.get(task);
    if (!taken) return;
    for (const f of files) if (typeof f === 'string' && f.trim()) taken.edits.add(resolve(taken.dir, f.trim()));
  }

  /** After it ends, whatever the outcome: how to put back what it changed, or null if nothing changed. */
  async after(task: { id: string; project: string; label: string }): Promise<AgentFiles | null> {
    const taken = this.taken.get(task.id);
    if (!taken) return null;
    this.taken.delete(task.id);
    const { root, scope, before } = taken;
    const after = await this.commit(root, scope, `Nova snapshot: after ${task.label}'s task`, { parent: before });
    const changed = await changedBetween(root, before, after, scope);
    if (!changed.length) {
      await git(root, ['update-ref', '-d', `${REF_PREFIX}${task.id}`]).catch(() => {});
      return null;
    }
    await git(root, ['update-ref', `${REF_PREFIX}${task.id}`, after]); // it has the one before as its parent
    // What it said it edited, as the repository names it (by the disk's own case, should the agent differ).
    const mine = new Set<string>();
    for (const edit of taken.edits) {
      const rel = relative(root, await onDisk(edit));
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) mine.add(rel.split(sep).join('/').toLowerCase());
    }
    const files = changed.filter((f) => mine.has(f.toLowerCase()));
    // Even when none of it was the agent's own editing, the record keeps the task's snapshot: undo then says what it left.
    return { kind: 'agent-files', project: task.project, before, after, agent: task.label, files, ...(taken.shared || this.sharing(root) ? { shared: true } : {}) };
  }

  /**
   * Put back the files an agent edited - if they're as the agent left them. Anything changed
   * since (by the user, most likely) is never overwritten: then nothing is put back. Files that
   * changed while it worked but weren't its own edits are left and named, and a file that was
   * there before the task is never deleted.
   */
  async restore(step: AgentFiles): Promise<UndoResult> {
    const where = await this.whereIs(step.project);
    if (!where) return { ok: false, message: `I can't find ${step.project} as a git project any more.` };
    const { root } = where;
    for (const commit of [step.before, step.after]) {
      if (!(await git(root, ['cat-file', '-e', `${commit}^{commit}`]).then(() => true, () => false))) {
        return { ok: false, message: `The snapshot of ${step.project} from before ${step.agent}'s task is gone, so I can't put its files back.` };
      }
    }
    const meta = await this.meta(root, step.before);
    const scope = meta?.scope ?? where.scope;
    const changed = await changedBetween(root, step.before, step.after, scope);
    const theirs = new Set(step.files);
    const agentFiles = changed.filter((f) => theirs.has(f));
    const others = changed.filter((f) => !theirs.has(f));
    // Made by the agent, as far as the snapshots know - but a file that was there before (ignored then, or too big to keep) stays.
    const added = new Set(await changedBetween(root, step.before, step.after, scope, 'A'));
    const kept: string[] = [];
    for (const f of agentFiles) if (added.has(f) && (await this.wasThere(root, f, meta, step.before))) kept.push(f);
    const back = agentFiles.filter((f) => !kept.includes(f));
    const now = back.length ? await this.commit(root, scope, 'Nova snapshot: before an undo', { parent: step.after }) : '';
    const since = now ? new Set(await changedBetween(root, step.after, now, scope)) : new Set<string>();
    const edited = back.filter((f) => since.has(f));
    if (edited.length) {
      return {
        ok: false,
        message: `${said(edited)} ${edited.length === 1 ? 'has' : 'have'} changed since ${step.agent} finished, so I haven't put anything back - that would undo your own edits. You can still do it by hand with git.`,
      };
    }
    const one = (files: string[], it: string, them: string) => (files.length === 1 ? it : them);
    const left = [
      ...(kept.length ? [`${said(kept)} ${one(kept, 'was', 'were')} there before the task, so I left ${one(kept, 'it', 'them')}.`] : []),
      ...(others.length ? [`${said(others)} changed while ${step.agent} worked, but not by its own edits - I left ${one(others, 'it, it may be yours', 'them, they may be yours')}.`] : []),
    ];
    if (!back.length) {
      if (!changed.length) return { ok: false, message: `Nothing ${step.agent} changed in ${step.project} is left to put back.` };
      if (agentFiles.length) return { ok: false, message: `${left.join(' ')} There's nothing else of ${step.agent}'s to put back.` };
      return {
        ok: false,
        message: `None of what changed in ${step.project} was ${step.agent}'s own editing, so I haven't put anything back: ${said(others)} changed while it worked - ${one(others, 'it', 'they')} may be yours. You can still do it by hand with git.`,
      };
    }
    const dir = await mkdtemp(join(tmpdir(), 'nova-undo-'));
    try {
      const patch = join(dir, 'undo.patch');
      const pieces: Buffer[] = [];
      for (const part of chunks(back)) pieces.push(await gitBytes(root, ['diff-tree', '-r', '-p', '--binary', '--full-index', '--no-renames', step.after, step.before, '--', ...part]));
      await writeFile(patch, Buffer.concat(pieces));
      await git(root, ['apply', '--whitespace=nowarn', patch]); // all or nothing
    } catch (e) {
      return { ok: false, message: `I couldn't put back ${step.project}'s files: ${((e as Error).message.split('\n').find((l) => /error|fatal/i.test(l)) ?? (e as Error).message).slice(0, 200)}` };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // Kept a while longer: what was just put back, in case the user wants the agent's version after all.
    await git(root, ['update-ref', `${REF_PREFIX}undo-${Date.now().toString(36)}`, now]).catch(() => {});
    const parent = await git(root, ['rev-parse', '-q', '--verify', `${step.before}^`]).then((s) => s.trim(), () => '');
    const head = await git(root, ['rev-parse', '-q', '--verify', 'HEAD']).then((s) => s.trim(), () => '');
    const n = back.length;
    return {
      ok: true,
      message: [
        `Okay - ${n === 1 ? `${base(back[0]!)} is` : `the ${n} files ${step.agent} changed in ${step.project} are`} back as ${n === 1 ? 'it was' : 'they were'}.`,
        ...(head !== parent ? ['The commit made since stays, so what I put back shows as uncommitted changes.'] : []),
        ...(step.shared ? ['That includes what another task changed there at the same time.'] : []),
        ...left,
      ].join(' '),
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

  /** Where a project is: its repository's top, its folder in it, and the folder as Settings has it - or null outside git. */
  private async whereIs(project: string): Promise<{ root: string; scope: string; dir: string } | null> {
    const dir = this.opts.projectPath(project);
    if (!dir) return null;
    try {
      const top = resolve(dir, (await git(dir, ['rev-parse', '--show-toplevel'])).trim());
      const root = await realpath(top).catch(() => top);
      const scope = (await git(dir, ['rev-parse', '--show-prefix'])).trim().replace(/\/+$/, '');
      return { root, scope, dir };
    } catch {
      return null;
    }
  }

  /** How a "before" snapshot was taken, from its message - null for one without (from before Nova wrote it). */
  private async meta(root: string, commit: string): Promise<Meta | null> {
    const raw = await git(root, ['cat-file', 'commit', commit]).catch(() => '');
    const line = raw.split('\n').find((l) => l.startsWith(META));
    if (!line) return null;
    try {
      const m = JSON.parse(line.slice(META.length)) as Partial<Meta>;
      if (typeof m.scope !== 'string' || typeof m.at !== 'number' || !Array.isArray(m.kept)) return null;
      return { scope: m.scope, at: m.at, kept: m.kept.filter((k): k is string => typeof k === 'string'), partial: m.partial === true };
    } catch {
      return null;
    }
  }

  /** Whether a file missing from the "before" snapshot was there all the same: listed as left out, or born before the task. */
  private async wasThere(root: string, file: string, meta: Meta | null, before: string) {
    if (meta?.kept.some((k) => (k.endsWith('/') ? file.startsWith(k) : file === k))) return true;
    const since = meta?.at ?? Number(await git(root, ['show', '-s', '--format=%ct', before]).catch(() => '0')) * 1000;
    const born = await stat(join(root, file)).then((s) => s.birthtimeMs, () => Infinity);
    return born < since;
  }

  /** Whether a task is under way in this repository. */
  private sharing(root: string) {
    return [...this.taken.values()].some((t) => t.root === root);
  }

  /**
   * The project's folder as a commit: tracked files as they are now, plus untracked ones that
   * aren't ignored (big ones, and big binaries, left out). Outside the folder - the rest of a
   * monorepo - it's as the user's index has it, and never compared. A separate index, started
   * from the user's, so theirs is never changed and unchanged files aren't read again. `record`:
   * what's there but left out (ignored, too big) goes in the message, so undo never deletes it.
   */
  private async commit(root: string, scope: string, message: string, opts: { parent?: string; record?: boolean } = {}) {
    const at = Date.now();
    const dir = await mkdtemp(join(tmpdir(), 'nova-snapshot-'));
    const index = join(dir, 'index');
    const env = { GIT_INDEX_FILE: index };
    try {
      const own = resolve(root, (await git(root, ['rev-parse', '--git-path', 'index'])).trim());
      await copyFile(own, index).catch(() => {}); // a repository with nothing staged yet has none
      await git(root, ['add', '-u', ...within(scope)], env);
      // Untracked files, not ignored: the small ones, up to a total.
      const untracked = paths(await git(root, ['ls-files', '--others', '--exclude-standard', '-z', ...within(scope)])).filter((f) => !f.endsWith('/'));
      const chosen: string[] = [];
      const left: string[] = [];
      let total = 0;
      for (const f of untracked) {
        const size = await sizeOf(join(root, f));
        if (size < 0) continue;
        if (size > MAX_FILE_BYTES || total + size > MAX_UNTRACKED_BYTES || (size > MAX_BINARY_BYTES && (await binary(join(root, f))))) {
          left.push(f);
          continue;
        }
        total += size;
        chosen.push(f);
      }
      if (chosen.length) {
        const list = join(dir, 'untracked');
        await writeFile(list, `${chosen.join('\0')}\0`);
        await git(root, ['add', `--pathspec-from-file=${list}`, '--pathspec-file-nul'], env);
      }
      const tree = (await git(root, ['write-tree'], env)).trim();
      let body = `${message}\n`;
      if (opts.record) {
        const ignored = paths(await git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z', ...within(scope)]));
        const kept = [...left, ...ignored];
        const meta: Meta = { scope, at, kept: kept.slice(0, MAX_KEPT), ...(kept.length > MAX_KEPT ? { partial: true } : {}) };
        body += `\n${META}${ascii(JSON.stringify(meta))}\n`;
      }
      const text = join(dir, 'message');
      await writeFile(text, body);
      const head = opts.parent ?? (await git(root, ['rev-parse', '-q', '--verify', 'HEAD']).then((s) => s.trim(), () => ''));
      return (await git(root, ['commit-tree', '--no-gpg-sign', tree, ...(head ? ['-p', head] : []), '-F', text])).trim();
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
