import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

// The daemon itself, started as `npm run dev` starts it - on a port of its own, with a settings
// folder of its own and a dry-run Mac (it opens and quits nothing), nothing to download.
const DAEMON = fileURLToPath(new URL('..', import.meta.url));
const TSX = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url));

let daemon: ChildProcess;
let home = '';
let port = 0;
let token = '';
let output = '';
let exited: Promise<number | null>;

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'nova-daemon-'));
  await writeFile(
    join(home, 'settings.json'),
    JSON.stringify({ decisions: { engine: 'heuristic' }, hearing: { engine: 'browser', smartTurn: false }, screen: { context: false }, agents: { enabled: [] } }),
  );
  port = await freePort();
  daemon = spawn(process.execPath, [TSX, 'src/server.ts'], {
    cwd: DAEMON,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      NOVA_PORT: String(port),
      NOVA_SETTINGS_FILE: join(home, 'settings.json'),
      NOVA_AGENTS_FILE: join(home, 'agents.json'),
      NOVA_MODELS_DIR: join(home, 'models'),
      NOVA_BUNDLED_MODELS: join(home, 'models'),
      NOVA_DRY_RUN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stdout!.on('data', (d) => (output += d));
  daemon.stderr!.on('data', (d) => (output += d));
  exited = new Promise((resolve) => daemon.once('exit', (code) => resolve(code)));
  for (let t = 0; t < 60_000 && !output.includes('Nova daemon'); t += 100) {
    if (daemon.exitCode !== null) throw new Error(`The daemon stopped: ${output}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(output).toContain('Nova daemon');
  token = (await readFile(join(home, 'run', 'ws-token'), 'utf8')).trim();
}, 70_000);

afterAll(async () => {
  if (daemon?.exitCode === null) {
    daemon.kill('SIGTERM');
    await exited;
  }
});

/** Connect as a client would: what the daemon answered, and the events it sent. */
function connect(query: string, origin?: string) {
  return new Promise<{ status?: number; ws?: WebSocket; events: any[] }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`, origin ? { origin } : {});
    const events: any[] = [];
    ws.on('message', (m) => events.push(JSON.parse(String(m))));
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode, events }));
    ws.on('error', () => resolve({ events }));
    ws.on('open', () => resolve({ ws, events }));
  });
}

const until = async (check: () => boolean, ms = 10_000) => {
  for (let t = 0; t < ms && !check(); t += 25) await new Promise((r) => setTimeout(r, 25));
  return check();
};

const get = (path: string) =>
  new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });

describe('the daemon', () => {
  it('lets in only clients that show its connection secret', async () => {
    expect((await connect('')).status).toBe(401);
    expect((await connect('?token=guess')).status).toBe(401);
    // Another page on this Mac, even with the secret, never gets in.
    expect((await connect(`?token=${token}`, 'http://localhost:3000')).status).toBe(403);
    expect((await connect(`?token=${token}`, 'tauri://localhost')).status).toBe(403);

    const app = await connect(`?token=${token}`);
    expect(app.ws).toBeDefined();
    expect(await until(() => app.events.some((e) => e.type === 'hello'))).toBe(true);
    app.ws!.close();
  });

  it('lives through requests and messages that make no sense', async () => {
    expect(await get('//%')).toBe(400); // not an address: it used to take the daemon down
    const client = await connect(`?token=${token}`);
    for (const raw of ['{"type":"utterance"}', '{"type":"utterance","text":5,"source":"voice"}', 'garbage', '{"type":"settings-set"}', '{"type":"shell-status","status":null}']) {
      client.ws!.send(raw);
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(daemon.exitCode).toBeNull();

    // And it still answers.
    client.ws!.send(JSON.stringify({ type: 'utterance', text: 'what time is it', source: 'keyboard' }));
    expect(await until(() => client.events.some((e) => e.type === 'say'))).toBe(true);
    expect(await get('/nothing-here')).toBe(404);
    client.ws!.close();
  });

  it("keeps Nova.app's part for Nova.app: a page can't take over its microphone and voice", async () => {
    const page = await connect(`?token=${token}`, `http://127.0.0.1:${port}`);
    page.ws!.send(JSON.stringify({ type: 'shell-hello', kind: 'mac', version: '9' }));
    expect(await until(() => page.events.some((e) => e.type === 'error'))).toBe(true);
    expect(page.events.find((e) => e.type === 'error').message).toMatch(/Only Nova.app/);
    expect(page.events.some((e) => e.type === 'shell-config')).toBe(false);
    page.ws!.close();
  });

  it('says so when a "yes, always" can\'t be saved, and carries on', async () => {
    const client = await connect(`?token=${token}`);
    client.ws!.send(JSON.stringify({ type: 'utterance', text: 'quit Spotify', source: 'keyboard' }));
    expect(await until(() => client.events.some((e) => e.type === 'say' && /spotify/i.test(e.text)))).toBe(true);
    await chmod(home, 0o500); // the settings file can't be written now
    try {
      client.ws!.send(JSON.stringify({ type: 'utterance', text: 'yes, always', source: 'keyboard' }));
      expect(await until(() => client.events.some((e) => e.type === 'error'))).toBe(true);
      expect(client.events.find((e) => e.type === 'error').message).toMatch(/Couldn't save that to Settings/);
    } finally {
      await chmod(home, 0o700);
    }
    expect(daemon.exitCode).toBeNull();
    client.ws!.close();
  });

  it('stops cleanly when asked', async () => {
    daemon.kill('SIGTERM');
    expect(await exited).toBe(0);
  });
});
