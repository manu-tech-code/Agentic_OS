import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ScreenService } from '@nova/core';
import { settingsFile } from '../config.ts';

/**
 * Nova Eyes: a small background app (native/eyes) that tells Nova what's on screen - the app in
 * front, its window, the browser page, the selected text - and takes a screenshot to read when the
 * user asks. It's its own app to macOS, so Accessibility and Screen Recording are granted to it
 * alone, not to the terminal Nova runs in. It answers only the daemon that launched it.
 */

const run = promisify(execFile);
const PACKAGE = fileURLToPath(new URL('../../native/eyes', import.meta.url));
const BUILT = join(PACKAGE, '.build', 'release', 'nova-eyes');

/** Where the app lives: outside the repo, in one place, so macOS keeps its permissions. */
export const eyesApp = () => join(dirname(settingsFile()), 'apps', 'Nova Eyes.app');

export interface ScreenContext {
  app?: string;
  bundleId?: string;
  window?: string;
  url?: string;
  page?: string;
  selection?: string;
  /** The user was in this app just before switching to Nova's window. */
  before?: boolean;
  isNova?: boolean;
  urlError?: string;
  permissions?: Permissions;
}

export interface Permissions {
  accessibility: boolean;
  screen: boolean;
}

const mtime = (path: string) => stat(path).then((s) => s.mtimeMs, () => 0);

let building: Promise<string> | null = null;

/** The app, built and signed on this Mac - again only after its sources change. */
export function ensureEyes(): Promise<string> {
  building ??= (async () => {
    if (platform() !== 'darwin') throw new Error("Seeing the screen needs macOS.");
    const app = eyesApp();
    const binary = join(app, 'Contents', 'MacOS', 'nova-eyes');
    const sources = [join(PACKAGE, 'Package.swift'), join(PACKAGE, 'Info.plist'), ...(await readdir(join(PACKAGE, 'Sources'))).map((f) => join(PACKAGE, 'Sources', f))];
    const newest = Math.max(...(await Promise.all(sources.map(mtime))));
    if ((await mtime(binary)) >= newest) return app;
    await new Promise<void>((resolve, reject) => {
      const child = spawn('swift', ['build', '-c', 'release', '--package-path', PACKAGE], { stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      child.stdout.on('data', (d) => (log = (log + d).slice(-3000)));
      child.stderr.on('data', (d) => (log = (log + d).slice(-3000)));
      child.on('error', (e) => reject(new Error(`Couldn't run swift (install Xcode or its Command Line Tools): ${e.message}`)));
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Building Nova Eyes failed:\n${log.split('\n').slice(-10).join('\n')}`))));
    });
    await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
    await copyFile(join(PACKAGE, 'Info.plist'), join(app, 'Contents', 'Info.plist'));
    await copyFile(BUILT, binary);
    // Signed on this Mac, so it has a stable identity for macOS to grant permissions to.
    await run('codesign', ['--force', '--sign', '-', '--identifier', 'dev.nova.eyes', app]);
    return app;
  })().finally(() => (building = null));
  return building;
}

/** The daemon's link to Nova Eyes: started on first use, and again if it quits. */
export class Eyes implements ScreenService {
  private socket: Socket | null = null;
  private connecting: Promise<Socket> | null = null;
  private readonly waiting = new Map<number, (answer: any) => void>();
  private seq = 0;
  private failedAt = 0;
  /** Why it couldn't start, if it couldn't. */
  problem: string | null = null;
  /** What macOS allows it, as it last said. */
  known: Permissions | null = null;

  constructor(private readonly opts: { skipTitles: () => string[]; images: () => boolean; onChange?: () => void }) {}

  get running() {
    return this.socket !== null;
  }

  /** Start it in the background (building it the first time), so the first question has context. */
  warm() {
    if (!this.socket) this.permissions().catch(() => {});
  }

  /** How it is, without starting it or waiting for it: Settings shows this. */
  async status() {
    if (this.socket) await this.permissions();
    return { running: this.running, starting: this.connecting !== null, permissions: this.known, problem: this.problem };
  }

  private async open(): Promise<Socket> {
    if (this.socket) return this.socket;
    // After a failed start, wait a minute before trying (and building) again - or until Restart.
    if (this.problem && Date.now() - this.failedAt < 60_000) throw new Error(this.problem);
    this.connecting ??= (async () => {
      const app = await ensureEyes();
      const dir = join(dirname(settingsFile()), 'run');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `eyes-${process.pid}.sock`);
      await rm(path, { force: true });
      // Through LaunchServices, so it's Nova Eyes to macOS: hidden, in the background, a fresh instance.
      await run('open', ['-g', '-j', '-n', '-a', app, '--args', '--socket', path, '--parent', String(process.pid)]);
      for (let i = 0; i < 100 && !(await mtime(path)); i++) await new Promise((r) => setTimeout(r, 50));
      const socket = await new Promise<Socket>((resolve, reject) => {
        const s = connect(path, () => resolve(s));
        s.once('error', reject);
      });
      createInterface({ input: socket }).on('line', (line) => {
        try {
          const answer = JSON.parse(line);
          this.waiting.get(answer.id)?.(answer);
          this.waiting.delete(answer.id);
        } catch {
          // not an answer
        }
      });
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null;
        for (const done of this.waiting.values()) done({ error: 'Nova Eyes stopped.' });
        this.waiting.clear();
      });
      socket.on('error', () => {});
      this.socket = socket;
      this.problem = null;
      return socket;
    })()
      .catch((e: Error) => {
        this.problem = e.message;
        this.failedAt = Date.now();
        this.opts.onChange?.();
        throw e;
      })
      .finally(() => (this.connecting = null));
    return this.connecting;
  }

  private remember(permissions: unknown) {
    if (!permissions || typeof permissions !== 'object') return;
    const p = permissions as Record<string, unknown>;
    const next = { accessibility: Boolean(p.accessibility), screen: Boolean(p.screen) };
    const changed = next.accessibility !== this.known?.accessibility || next.screen !== this.known?.screen;
    this.known = next;
    if (changed) this.opts.onChange?.();
  }

  private async ask(request: Record<string, unknown>, timeoutMs: number): Promise<any> {
    const socket = await this.open();
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => (this.waiting.delete(id), resolve({ error: 'Nova Eyes took too long.' })), timeoutMs);
      this.waiting.set(id, (answer) => (clearTimeout(timer), resolve(answer)));
      socket.write(`${JSON.stringify({ ...request, id, skipTitles: this.opts.skipTitles() })}\n`);
    });
  }

  /** What the user is working in right now (or just before switching to Nova), or null if it can't tell. */
  async context(): Promise<ScreenContext | null> {
    const answer = await this.ask({ type: 'context' }, 1500).catch(() => null);
    if (!answer || answer.error) return null;
    this.remember(answer.permissions);
    return answer as ScreenContext;
  }

  async look(scope: 'window' | 'screen') {
    const answer = await this.ask({ type: 'look', scope, image: this.opts.images() }, 15_000);
    if (answer.error === 'screen-permission') throw new Error('Nova Eyes needs Screen Recording: Settings → Screen → Allow.');
    if (answer.error) throw new Error(String(answer.error));
    return {
      app: answer.app || undefined,
      window: answer.window || undefined,
      text: String(answer.text ?? ''),
      image: answer.image ? { data: String(answer.image), mimeType: String(answer.mimeType ?? 'image/jpeg') } : undefined,
    };
  }

  /** Which permissions Nova Eyes has; asking for some shows macOS's own prompts. */
  async permissions(request: ('accessibility' | 'screen')[] = []): Promise<Permissions | null> {
    const answer = await this.ask({ type: 'permissions', request }, 5000).catch(() => null);
    if (!answer || answer.error) return null;
    this.remember(answer);
    return this.known;
  }

  /** Quit it and start it again - macOS applies a new Screen Recording permission only then. */
  restart() {
    this.close();
    this.problem = null;
    this.warm();
  }

  close() {
    this.socket?.write(`${JSON.stringify({ type: 'quit' })}\n`);
    this.socket?.destroy();
    this.socket = null;
  }
}

/** macOS's own screens - locked, the screensaver, a password prompt: nothing the user is working in. */
const SYSTEM_SCREENS = new Set([
  'com.apple.loginwindow',
  'com.apple.ScreenSaver.Engine',
  'com.apple.SecurityAgent',
  'com.apple.UserNotificationCenter',
  'com.apple.dock',
  'com.apple.controlcenter',
  'com.apple.notificationcenterui',
]);

/** The notes about what the user is working in, for a question to the brain. */
export function describeContext(c: ScreenContext | null, assistant = 'Nova'): string | null {
  if (!c?.app || (c.isNova && !c.before) || (c.bundleId && SYSTEM_SCREENS.has(c.bundleId))) return null;
  const title = c.page || c.window;
  const where = `${c.app}${title ? `, "${title}"` : ''}${c.url ? ` (${c.url})` : ''}`;
  const lines = [`${c.before ? `Just before switching to ${assistant}, the user was working in` : 'The user is working in'} ${where}.`];
  if (c.selection) lines.push(`Text they have selected:\n"""\n${c.selection.slice(0, 1500)}\n"""`);
  return lines.join('\n');
}
