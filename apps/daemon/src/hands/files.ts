import { constants } from 'node:fs';
import { access, lstat, mkdir, open, realpath, rename, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { KNOWN_FOLDERS, type FileHit, type FileKind, type HandsService } from '@nova/core';
import type { Lines, Run } from './run.ts';
import type { HandsEyes } from './types.ts';

/**
 * The user's files: found with Spotlight (a query built here, in code), in their home folder only -
 * never ~/Library, hidden folders, keychains or code dependencies. Opening and showing in Finder use
 * `open`; moving and renaming never overwrite and never leave home; the Trash is undoable, and
 * nothing is ever deleted for good. Reading a file gives its text to whoever asked.
 */

/** Spotlight's content types for each kind of file. */
export const KIND_TYPES: Record<FileKind, string[]> = {
  pdf: ['com.adobe.pdf'],
  image: ['public.image'],
  document: ['com.microsoft.word.doc', 'org.openxmlformats.wordprocessingml.document', 'com.apple.iwork.pages.sffpages', 'com.apple.iwork.pages.pages', 'public.rtf', 'com.apple.rtfd', 'org.oasis-open.opendocument.text'],
  spreadsheet: ['public.spreadsheet', 'public.comma-separated-values-text', 'com.microsoft.excel.xls', 'org.openxmlformats.spreadsheetml.sheet', 'com.apple.iwork.numbers.sffnumbers'],
  presentation: ['public.presentation', 'com.microsoft.powerpoint.ppt', 'org.openxmlformats.presentationml.presentation', 'com.apple.iwork.keynote.sffkey'],
  folder: ['public.folder'],
  video: ['public.movie'],
  audio: ['public.audio'],
  code: ['public.source-code'],
  text: ['public.plain-text'],
  archive: ['public.archive'],
};

/** A value inside a Spotlight query's quotes: its own quotes, backslashes and wildcards can't break out. */
const quoted = (value: string) => value.replace(/[\\"*]/g, (c) => `\\${c}`);

/** The words to look for in a file's name (at least two letters each). */
export const nameWords = (query?: string) => (query ?? '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._'-]*/gu)?.filter((w) => w.length > 1).slice(0, 6) ?? [];

/**
 * The Spotlight query for what was asked: every word in the name, the kind, how recent. `content`
 * looks in what the files say, not their names. Null when there's nothing to look for.
 */
export function spotlightQuery(q: { query?: string; kind?: FileKind; days?: number; added?: boolean; content?: boolean }): string | null {
  const clauses: string[] = [];
  const words = nameWords(q.query);
  const field = q.content ? 'kMDItemTextContent' : 'kMDItemDisplayName';
  for (const w of words) clauses.push(`${field} == "*${quoted(w)}*"cd`);
  if (q.kind) clauses.push(`(${KIND_TYPES[q.kind].map((t) => `kMDItemContentTypeTree == "${t}"`).join(' || ')})`);
  if (q.days) {
    const since = `$time.today(-${Math.max(0, Math.round(q.days) - 1)})`;
    clauses.push(q.added ? `kMDItemDateAdded >= ${since}` : `(kMDItemLastUsedDate >= ${since} || kMDItemFSContentChangeDate >= ${since})`);
  }
  if (!clauses.length) return null;
  // Recent files are files, not folders.
  if (!q.kind && !words.length) clauses.push('kMDItemContentType != "public.folder"');
  return clauses.join(' && ');
}

/** iCloud Drive lives under ~/Library - the one part of it that holds the user's own files. */
const ICLOUD = join('Library', 'Mobile Documents', 'com~apple~CloudDocs');

/** Whether Nova may touch a path: inside home, not hidden, not ~/Library (bar iCloud Drive), not a keychain, dependency or package inside. */
export function allowed(path: string, home: string): boolean {
  const full = resolve(path);
  if (full === home || !full.startsWith(home + sep)) return false;
  const rel = relative(home, full);
  const parts = rel.split(sep);
  if (parts.some((p) => p.startsWith('.') || p === 'node_modules' || p === '__pycache__')) return false;
  if (parts[0] === 'Library' && !rel.startsWith(ICLOUD + sep) && rel !== ICLOUD) return false;
  if (/\.keychain(?:-db)?$/i.test(full)) return false;
  // Not inside app bundles or libraries (a Photos library, an app's contents).
  if (parts.slice(0, -1).some((p) => /\.(?:app|photoslibrary|musiclibrary|tvlibrary|photolibrary|framework|bundle|xcarchive)$/i.test(p))) return false;
  return true;
}

/** A name a file can be renamed to: one name, no path, not hidden. */
export function nameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return 'What should it be called?';
  if (n.includes('/') || n.includes(':') || n === '.' || n === '..') return "A file's name can't have a slash or colon in it.";
  if (n.startsWith('.')) return "I won't give it a hidden name.";
  if (Buffer.byteLength(n) > 255) return 'That name is too long.';
  return null;
}

/** The folder it's in, as said: "Downloads", "Documents/Taxes", "iCloud Drive/Notes". */
export function folderSaid(path: string, home: string) {
  const rel = relative(home, dirname(path));
  if (rel.startsWith(ICLOUD)) return `iCloud Drive${rel.slice(ICLOUD.length)}`.replace(/\/$/, '');
  return rel;
}

const KIND_OF: Record<string, string> = {
  pdf: 'PDF', doc: 'Word document', docx: 'Word document', pages: 'Pages document', rtf: 'document', txt: 'text file', md: 'text file',
  xls: 'spreadsheet', xlsx: 'spreadsheet', numbers: 'spreadsheet', csv: 'spreadsheet', key: 'presentation', ppt: 'presentation', pptx: 'presentation',
  png: 'image', jpg: 'image', jpeg: 'image', heic: 'image', gif: 'image', webp: 'image', mov: 'video', mp4: 'video', m4v: 'video',
  mp3: 'audio', m4a: 'audio', wav: 'audio', zip: 'archive', dmg: 'disk image',
};

/** Words for "what's in it" that textutil reads; plain text is read directly; PDFs through Nova Eyes. */
const TEXTUTIL = new Set(['.doc', '.docx', '.rtf', '.rtfd', '.odt', '.html', '.htm', '.webarchive', '.wordml']);
const PLAIN = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.log', '.ini', '.toml', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.py',
  '.rb', '.go', '.rs', '.swift', '.java', '.kt', '.c', '.h', '.cpp', '.cs', '.css', '.scss', '.sql', '.sh', '.tex', '.srt', '.vtt', '.org', '.text',
]);

export interface FilesOptions {
  run: Run;
  lines: Lines;
  eyes: HandsEyes | null;
  home: string;
  /** Project folders by name (for "move it to the website project"). */
  projects?: () => Record<string, string>;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export function filesHands(o: FilesOptions): HandsService['files'] {
  const home = resolve(o.home);
  const log = o.log ?? ((line: string) => console.log(line));
  /** Trying Nova out (NOVA_DRY_RUN=1): say what would happen, and answer as if it had. */
  const pretend = <T>(what: string, answer: T): T => (log(`  [dry-run] ${what}`), answer);
  const check = (path: string) => {
    if (!allowed(path, home)) throw new Error('Nova only touches files in your home folder - not hidden ones, or ~/Library.');
  };
  /** A real path that stays allowed once links are followed. */
  const real = async (path: string) => {
    check(path);
    const full = await realpath(path).catch(() => {
      throw new Error("That file isn't there any more.");
    });
    check(full);
    return full;
  };
  const eyes = () => {
    if (!o.eyes) throw new Error('That needs Nova Eyes, on a Mac.');
    return o.eyes;
  };

  /** The user's own folders, where "recent" looks: the usual ones, and iCloud Drive when there is one. */
  const roots = async () => {
    const all = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies', 'Music', ICLOUD].map((d) => join(home, d));
    return (await Promise.all(all.map(async (d) => ((await exists(d)) ? d : null)))).filter((d): d is string => d !== null);
  };

  async function hits(paths: string[], limit: number): Promise<FileHit[]> {
    const safe = [...new Set(paths)].filter((p) => allowed(p, home)).slice(0, 80);
    const seen = await Promise.all(
      safe.map(async (path) => {
        const s = await stat(path).catch(() => null);
        if (!s) return null;
        // Last used or changed, whichever is later (Spotlight's last-used date is read in one go below).
        return { path, name: basename(path), folder: folderSaid(path, home), modified: Math.max(s.mtimeMs, s.birthtimeMs || 0), kind: s.isDirectory() ? 'folder' : (KIND_OF[extname(path).slice(1).toLowerCase()] ?? undefined) } as FileHit;
      }),
    );
    const found = seen.filter((h): h is FileHit => h !== null);
    // When each was last opened, from Spotlight, for all of them at once.
    if (found.length) {
      const out = await o.run('mdls', ['-raw', '-name', 'kMDItemLastUsedDate', ...found.map((h) => h.path)], { timeoutMs: 5000 }).catch(() => null);
      out?.stdout.split('\0').forEach((value, i) => {
        const at = Date.parse(value.trim().replace(' +0000', 'Z').replace(' ', 'T'));
        if (found[i] && Number.isFinite(at)) found[i]!.modified = Math.max(found[i]!.modified, at);
      });
    }
    return found.sort((a, b) => b.modified - a.modified).slice(0, limit);
  }

  async function search(query: string, where: string[], max = 300) {
    return o.lines('mdfind', [...where.flatMap((d) => ['-onlyin', d]), query], max, 8000).catch(() => [] as string[]);
  }

  async function folder(name: string): Promise<string | null> {
    const said = name.toLowerCase().replace(/\s+folder$/, '').replace(/^(?:my|the)\s+/, '').trim();
    if (Object.hasOwn(KNOWN_FOLDERS, said)) {
      const known = KNOWN_FOLDERS[said]!;
      return known ? join(home, known) : null; // home itself isn't somewhere to move things into
    }
    if (said === 'icloud' || said === 'icloud drive') return join(home, ICLOUD);
    const projects = o.projects?.() ?? {};
    const project = Object.keys(projects).find((p) => p.toLowerCase() === said) ?? findProject(said, Object.keys(projects));
    if (project && allowed(projects[project]!, home)) return resolve(projects[project]!);
    // A folder of that name somewhere in home: the most recently used.
    const words = nameWords(said);
    if (!words.length) return null;
    const exact = `kMDItemContentType == "public.folder" && kMDItemDisplayName == "${quoted(said)}"cd`;
    let found = await hits(await search(exact, [home], 40), 5);
    if (!found.length) found = await hits(await search(`kMDItemContentType == "public.folder" && ${words.map((w) => `kMDItemDisplayName == "*${quoted(w)}*"cd`).join(' && ')}`, [home], 40), 5);
    return found[0]?.path ?? null;
  }

  return {
    async find(q, limit = 8) {
      const where = q.folder ? await folder(q.folder) : home;
      if (!where) return [];
      const query = spotlightQuery({ query: q.query, kind: q.kind, days: q.days });
      if (!query) return [];
      let found = await hits(await search(query, [where]), limit);
      // Nothing by name: what the files say.
      if (!found.length && q.query && nameWords(q.query).length) {
        const content = spotlightQuery({ query: q.query, kind: q.kind, days: q.days, content: true });
        if (content) found = await hits(await search(content, [where], 100), limit);
      }
      return found;
    },

    async recent(q, limit = 8) {
      const downloads = q.folder && /download/.test(q.folder);
      const where = q.folder ? await folder(q.folder) : null;
      if (q.folder && !where) return [];
      const query = spotlightQuery({ kind: q.kind, days: q.days, added: Boolean(downloads) })!;
      return hits(await search(query, where ? [where] : await roots(), 400), limit);
    },

    async open(path) {
      const full = await real(path);
      if (o.dryRun) return pretend(`open ${full}`, undefined);
      await o.run('open', [full]);
    },

    async reveal(path) {
      const full = await real(path);
      if (o.dryRun) return pretend(`open -R ${full}`, undefined);
      await o.run('open', ['-R', full]);
    },

    folder,

    async move(path, toFolder) {
      const from = await real(path);
      const dest = await real(toFolder);
      if (!(await stat(dest)).isDirectory()) throw new Error(`${basename(dest)} isn't a folder.`);
      if (dirname(from) === dest) throw new Error(`It's already in ${basename(dest)}.`);
      if (dest === from || dest.startsWith(from + sep)) throw new Error("A folder can't go inside itself.");
      const to = join(dest, basename(from));
      if (await exists(to)) throw new Error(`There's already a ${basename(from)} in ${basename(dest)}, so I left it where it is.`);
      if (o.dryRun) return pretend(`move ${from} → ${to}`, to);
      await rename(from, to).catch((e: NodeJS.ErrnoException) => {
        throw new Error(e.code === 'EXDEV' ? "That's on another disk - I only move files within one." : e.message);
      });
      return to;
    },

    async rename(path, name) {
      const from = await real(path);
      const problem = nameProblem(name);
      if (problem) throw new Error(problem);
      const to = join(dirname(from), name.trim());
      if (to === from) return to;
      // A different name only in capitals is the same file on a Mac's disk: that's fine.
      if (to.toLowerCase() !== from.toLowerCase() && (await exists(to))) throw new Error(`There's already a file called ${name.trim()} there, so I left it.`);
      if (o.dryRun) return pretend(`rename ${from} → ${to}`, to);
      await rename(from, to);
      return to;
    },

    async trash(path) {
      const full = await real(path);
      if (o.dryRun) return pretend(`trash ${full}`, join(home, '.Trash', basename(full)));
      return eyes().trash(full);
    },

    async untrash(trashed, original) {
      check(original);
      if (!resolve(trashed).startsWith(join(home, '.Trash') + sep)) throw new Error("That isn't in the Trash.");
      if (await exists(original)) throw new Error(`There's a new ${basename(original)} where it was, so I left it in the Trash.`);
      if (o.dryRun) return pretend(`put back ${trashed} → ${original}`, undefined);
      await mkdir(dirname(original), { recursive: true });
      await eyes().untrash(trashed, original);
    },

    async read(path, max = 20_000) {
      const full = await real(path);
      const ext = extname(full).toLowerCase();
      const s = await lstat(full);
      if (s.isDirectory()) throw new Error("That's a folder - I can list what's in it, but not read it.");
      if (ext === '.pdf') return (await eyes().pdfText(full, max)).trim();
      if (TEXTUTIL.has(ext)) return (await o.run('textutil', ['-convert', 'txt', '-stdout', full], { timeoutMs: 20_000 })).stdout.slice(0, max).trim();
      if (PLAIN.has(ext) || !ext) {
        const file = await open(full, 'r');
        try {
          const buffer = Buffer.alloc(Math.min(s.size, Math.max(max * 4, 4096), 4_000_000));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          const text = buffer.subarray(0, bytesRead).toString('utf8');
          if (/\u0000/.test(text.slice(0, 2000))) throw new Error("That isn't a text file.");
          return text.slice(0, max).trim();
        } finally {
          await file.close();
        }
      }
      throw new Error(`I can't read ${KIND_OF[ext.slice(1)] ? `${KIND_OF[ext.slice(1)]}s` : `${ext} files`} yet - open it instead, and I can look at the screen.`);
    },
  };
}

const exists = (path: string) => access(path, constants.F_OK).then(() => true, () => false);

/** A project named loosely ("the website"): the one whose name holds every word. */
function findProject(said: string, names: string[]) {
  const words = said.split(/\s+/).filter((w) => w.length > 1 && !['project', 'the', 'my'].includes(w));
  if (!words.length) return undefined;
  return names.find((n) => words.every((w) => n.toLowerCase().includes(w)));
}
