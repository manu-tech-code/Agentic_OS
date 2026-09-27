import { copyFile, mkdir, open, rename } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

/**
 * Nova's own files (reminders, the task board, state), written so a crash or a power cut never
 * leaves half of one: to a temporary file, synced to disk, then moved into place.
 */
export async function writeDurably(file: string, data: string) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const handle = await open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
  // The move itself on disk too: the folder's entry.
  const folder = await open(dirname(file), 'r').catch(() => null);
  await folder?.sync().catch(() => {});
  await folder?.close();
}

/**
 * A file Nova can't read (cut short, or edited by hand into something it doesn't understand) is
 * never written over: it's kept beside, as "reminders.unreadable-20260927-174300.json", and its
 * name returned - or null when even that failed, and then nothing may replace it.
 */
export async function setAside(file: string, how: 'move' | 'copy' = 'move', now = new Date()): Promise<string | null> {
  const ext = extname(file);
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const kept = join(dirname(file), `${basename(file, ext)}.unreadable-${stamp}${ext}`);
  try {
    await (how === 'move' ? rename(file, kept) : copyFile(file, kept));
    return kept;
  } catch {
    return null;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
