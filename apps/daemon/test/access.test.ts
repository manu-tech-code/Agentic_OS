import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { carriesToken, connectionToken, refusal, tokenFile, windowOrigins } from '../src/shell/access.ts';
import { serveUi } from '../src/shell/static.ts';

const scratch = () => mkdtemp(join(tmpdir(), 'nova-access-'));

describe('the connection secret', () => {
  it('is kept next to the settings file, readable by the user alone', async () => {
    const dir = await scratch();
    const file = tokenFile(join(dir, 'settings.json'));
    expect(file).toBe(join(dir, 'run', 'ws-token'));
    const token = await connectionToken(file);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await readFile(file, 'utf8')).trim()).toBe(token);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'run'))).mode & 0o777).toBe(0o700);
    // The same one after a restart, so windows that are open reconnect with theirs.
    expect(await connectionToken(file)).toBe(token);
  });

  it('is made afresh when the file could have been read by others, or holds something else', async () => {
    const dir = await scratch();
    const file = tokenFile(join(dir, 'settings.json'));
    const first = await connectionToken(file);
    await chmod(file, 0o644);
    const second = await connectionToken(file);
    expect(second).not.toBe(first);
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    await writeFile(file, 'not a token', { mode: 0o600 });
    expect(await connectionToken(file)).not.toBe('not a token');

    const elsewhere = join(dir, 'elsewhere');
    await writeFile(elsewhere, `${first}\n`, { mode: 0o600 });
    await rm(file);
    await symlink(elsewhere, file); // a link to a file someone else chose
    expect(await connectionToken(file)).not.toBe(first);
  });

  it('tightens a folder others could look into', async () => {
    const dir = await scratch();
    await mkdir(join(dir, 'run'), { mode: 0o755 });
    await chmod(join(dir, 'run'), 0o755);
    await connectionToken(tokenFile(join(dir, 'settings.json')));
    expect((await stat(join(dir, 'run'))).mode & 0o777).toBe(0o700);
  });

  it('is checked in the address a client connects to', () => {
    const token = 'a'.repeat(43);
    expect(carriesToken(`/?token=${token}`, token)).toBe(true);
    expect(carriesToken(`/anything?x=1&token=${token}`, token)).toBe(true);
    expect(carriesToken('/', token)).toBe(false);
    expect(carriesToken('/?token=', token)).toBe(false);
    expect(carriesToken(`/?token=${'b'.repeat(43)}`, token)).toBe(false);
    expect(carriesToken(`/?token=${token}x`, token)).toBe(false);
    expect(carriesToken('//%', token)).toBe(false); // not an address at all
    expect(carriesToken(undefined, token)).toBe(false);
  });
});

describe('who may connect', () => {
  const token = 'c'.repeat(43);
  const windows = windowOrigins({}, 7878);
  const url = `/?token=${token}`;

  it("is Nova's own windows and programs on this Mac - never another page, not even one on localhost", () => {
    expect([...windows].sort()).toEqual(['http://127.0.0.1:5173', 'http://127.0.0.1:7878', 'http://localhost:5173', 'http://localhost:7878']);
    expect(refusal(undefined, url, token, windows)).toBeNull(); // Nova.app, or a script run by the user
    expect(refusal('http://localhost:5173', url, token, windows)).toBeNull();
    expect(refusal('http://127.0.0.1:7878', url, token, windows)).toBeNull();
    for (const origin of ['http://localhost:3000', 'https://evil.example', 'tauri://localhost', 'http://tauri.localhost', 'null', '']) {
      expect(refusal(origin, url, token, windows)).toBe(403);
    }
  });

  it('needs the secret, even from those', () => {
    expect(refusal(undefined, '/', token, windows)).toBe(401);
    expect(refusal('http://localhost:5173', '/?token=guess', token, windows)).toBe(401);
  });

  it('can name other windows on this Mac in NOVA_UI_ORIGINS, never a site elsewhere', () => {
    const custom = windowOrigins({ NOVA_UI_ORIGINS: ' http://localhost:4000 , https://evil.example,http://127.0.0.1:1234' }, 9000);
    expect([...custom].sort()).toEqual(['http://127.0.0.1:1234', 'http://127.0.0.1:9000', 'http://localhost:4000', 'http://localhost:9000']);
  });
});

describe('the window the daemon serves', () => {
  let server: Server;
  let port = 0;
  const token = 'd'.repeat(43);
  beforeAll(async () => {
    const root = await scratch();
    await writeFile(join(root, 'index.html'), '<!doctype html><html><head><title>Nova</title></head><body></body></html>');
    server = createServer(async (req, res) => {
      if (!(await serveUi(req, res, port, root, token))) res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  const get = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: IncomingMessage['headers']; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let body = '';
        res.on('data', (d: Buffer) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });

  it('carries the secret, for this window alone: no other site may read or frame it', async () => {
    const page = await get('/', { origin: 'http://localhost:3000' });
    expect(page.body).toContain(`<meta name="nova-token" content="${token}" />`);
    expect(page.headers['access-control-allow-origin']).toBeUndefined();
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect((await get('/index.html')).body).toContain('nova-token');
    expect((await get('/', { host: `evil.example:${port}` })).status).toBe(404); // a site pointing its name at this Mac
  });
});
