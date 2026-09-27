import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { PresenceConfig, ServerEvent, ShellStatus } from '@nova/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Presence } from '../src/shell/presence.ts';
import { serveUi } from '../src/shell/static.ts';

const CONFIG: PresenceConfig = {
  shortcut: 'option+space',
  listen: 'always',
  pauseWhenLocked: true,
  orb: 'bottom-right',
  orbSeconds: 6,
  sounds: true,
  launchAtLogin: true,
  daemon: 'app',
};
const STATUS: ShellStatus = {
  version: '0.5',
  mic: 'granted',
  listening: 'wake-word',
  loginItem: 'on',
  shortcut: { keys: 'option+space', ok: true },
  daemon: 'external',
};

function setup() {
  const sent: [string, ServerEvent][] = [];
  const changes: boolean[] = [];
  const presence = new Presence<string>({ send: (peer, event) => sent.push([peer, event]), changed: (app) => changes.push(app) });
  return { presence, sent, changes };
}

describe("Nova's Mac app", () => {
  it('takes over listening and speaking while it is connected, and hands them back when it goes', () => {
    const { presence, sent, changes } = setup();
    const windows = ['safari', 'hud'];
    expect(presence.voice(windows)).toEqual(windows);
    expect(presence.mayListen('safari')).toBe(true);

    presence.attach('app', '0.5', CONFIG);
    expect(sent).toEqual([['app', { type: 'shell-config', presence: CONFIG }]]);
    expect(changes).toEqual([true]);
    expect(presence.voice(['safari', 'hud', 'app'])).toEqual(['app']); // reply audio: the app alone
    expect(presence.mayListen('safari')).toBe(false);
    expect(presence.mayListen('app')).toBe(true);

    expect(presence.detach('safari')).toBe(false); // a window closing changes nothing
    expect(presence.detach('app')).toBe(true);
    expect(changes).toEqual([true, false]);
    expect(presence.voice(windows)).toEqual(windows);
    expect(presence.mayListen('safari')).toBe(true);
  });

  it('keeps only its own report, and forgets it when it goes', () => {
    const { presence } = setup();
    expect(presence.report('app', STATUS)).toBe(false); // not the app yet
    presence.attach('app', '0.5', CONFIG);
    expect(presence.report('safari', { ...STATUS, mic: 'denied' })).toBe(false);
    expect(presence.report('app', STATUS)).toBe(true);
    expect(presence.status).toEqual(STATUS);
    presence.detach('app');
    expect(presence.status).toBeNull();
  });

  it('gets new settings, and passes on what Settings asks of it', () => {
    const { presence, sent } = setup();
    expect(presence.action('request-mic')).toBe(false); // no app to ask
    presence.attach('app', '0.5', CONFIG);
    presence.configure({ ...CONFIG, shortcut: 'control+option+n' });
    expect(presence.action('open-login-items')).toBe(true);
    expect(sent.slice(1)).toEqual([
      ['app', { type: 'shell-config', presence: { ...CONFIG, shortcut: 'control+option+n' } }],
      ['app', { type: 'shell-action', action: 'open-login-items' }],
    ]);
  });

  it('is replaced by a newer connection when it restarts', () => {
    const { presence, changes } = setup();
    presence.attach('app-1', '0.5', CONFIG);
    presence.attach('app-2', '0.5', CONFIG);
    expect(changes).toEqual([true]); // still one app
    expect(presence.detach('app-1')).toBe(false);
    expect(presence.isApp('app-2')).toBe(true);
  });
});

describe("the window, served from the daemon's own address", () => {
  let server: Server;
  let port = 0;
  let root = '';
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'nova-ui-'));
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), '<!doctype html><html><head><title>Nova</title></head><body></body></html>');
    await writeFile(join(root, 'assets', 'index-abc123.js'), 'console.log(1)');
    await writeFile(join(root, 'capture-worklet.js'), 'class X {}');
    await writeFile(join(root, '..', 'secret.txt'), 'not for you');
    server = createServer(async (req, res) => {
      if (!(await serveUi(req, res, port, root))) res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());

  const get = (path: string, host = `127.0.0.1:${port}`) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res: IncomingMessage) => {
        let body = '';
        res.on('data', (d: Buffer) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });

  it('serves the page, telling it that it came from the daemon, and never inside a frame', async () => {
    const page = await get('/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.body).toContain('<meta name="nova-daemon" content="1" />');
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['cache-control']).toBe('no-cache');
    expect((await get('/?view=hud&shell=mac')).status).toBe(200);
  });

  it('caches the hashed files, and serves the others fresh', async () => {
    const asset = await get('/assets/index-abc123.js');
    expect(asset.headers['content-type']).toMatch(/javascript/);
    expect(asset.headers['cache-control']).toMatch(/immutable/);
    expect((await get('/capture-worklet.js')).headers['cache-control']).toBe('no-cache');
  });

  it('serves nothing outside the build, or to another name for this Mac', async () => {
    expect((await get('/../secret.txt')).status).toBe(404);
    expect((await get('/%2e%2e/secret.txt')).status).toBe(404);
    expect((await get('/assets/%00x')).status).toBe(404);
    expect((await get('/missing.js')).status).toBe(404);
    expect((await get('/', `evil.example:${port}`)).status).toBe(404); // a site pointing its name at this Mac
    expect((await get('/', `localhost:${port}`)).status).toBe(200);
  });
});

const APP = fileURLToPath(new URL('../../desktop/macos/.build/release/Nova', import.meta.url));
describe.skipIf(platform() !== 'darwin' || !existsSync(APP))("Nova.app's own checks", () => {
  it('reads shortcuts, turns the microphone into 16 kHz PCM, and decodes Nova\'s voice', { timeout: 30_000 }, async () => {
    const { stdout } = await promisify(execFile)(APP, ['--selftest'], { timeout: 25_000 });
    expect(stdout).toContain('selftest passed');
    expect(stdout).not.toContain('FAIL');
  });
});
