import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { settingsFile, type Env } from '../config.ts';

/**
 * Who may talk to the daemon. Any web page can try to reach 127.0.0.1, so an Origin check alone
 * isn't enough (every dev server on localhost:5173 looks like Nova's window). Clients also show a
 * secret that only this user can read: a file next to the settings file, readable by the user
 * alone. Nova's own windows get it from the page the daemon (or Nova's dev server) serves them;
 * Nova.app reads the file.
 *
 * The secret stays the same across restarts - windows that are open reconnect with the one their
 * page came with - and is made afresh whenever the file is missing, unreadable or not private.
 */

/** Where the connection secret is kept: <dir of the settings file>/run/ws-token. */
export const tokenFile = (settings = settingsFile()) => join(dirname(settings), 'run', 'ws-token');

const TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

const uid = () => process.getuid?.() ?? -1;

/** The token in `file`, if the file is one only this user can read. */
async function readPrivate(file: string): Promise<string | null> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || (uid() >= 0 && info.uid !== uid()) || (info.mode & 0o077) !== 0) return null;
    const token = (await readFile(file, 'utf8')).trim();
    return TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** The connection secret: the one in the file, or a new one written there (0600, in a 0700 folder). */
export async function connectionToken(file = tokenFile()): Promise<string> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || (uid() >= 0 && info.uid !== uid())) throw new Error(`${dir} isn't a folder of yours, so Nova can't keep its connection secret there.`);
  if ((info.mode & 0o777) !== 0o700) await chmod(dir, 0o700);

  const existing = await readPrivate(file);
  if (existing) return existing;
  const token = randomBytes(32).toString('base64url');
  const tmp = `${file}.${process.pid}.tmp`;
  await rm(tmp, { force: true });
  await writeFile(tmp, `${token}\n`, { mode: 0o600, flag: 'wx' });
  try {
    // Published in one step: a daemon starting at the same moment either wins or uses ours.
    await link(tmp, file);
    return token;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const theirs = await readPrivate(file);
    if (theirs) return theirs;
    await rename(tmp, file); // what's there is unusable: replace it
    return token;
  } finally {
    await rm(tmp, { force: true });
  }
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Whether a request (the WebSocket's address, `/?token=...`) carries the secret. Constant-time. */
export function carriesToken(url: string | undefined, token: string): boolean {
  let given: string | null;
  try {
    given = new URL(url ?? '/', 'http://127.0.0.1').searchParams.get('token');
  } catch {
    return false;
  }
  return given !== null && timingSafeEqual(digest(given), digest(token));
}

/** Pages on this Mac (any port). Anything else never connects. */
const LOCAL_PAGE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/**
 * Nova's own windows, by origin: the dev server's (NOVA_UI_ORIGINS in .env changes these) and the
 * one the daemon serves itself - only ever pages on this Mac.
 */
export function windowOrigins(env: Env, port: number): Set<string> {
  const listed = (env.NOVA_UI_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((s) => s.trim());
  return new Set([...listed, `http://127.0.0.1:${port}`, `http://localhost:${port}`].filter((o) => LOCAL_PAGE.test(o)));
}

/**
 * Whether a connection may be made: it carries the secret, and it comes from one of Nova's windows
 * or from a program on this Mac (which sends no Origin). Returns the HTTP status to refuse it with.
 */
export function refusal(origin: string | undefined, url: string | undefined, token: string, windows: Set<string>): 401 | 403 | null {
  if (origin !== undefined && !windows.has(origin)) return 403;
  if (!carriesToken(url, token)) return 401;
  return null;
}
