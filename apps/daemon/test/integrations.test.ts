import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IntegrationHub } from '../src/integrations/hub.ts';
import { McpClient, StdioTransport } from '../src/integrations/mcp.ts';
import { authorizeUrl, resourceCovers, secureAddress, SignIns } from '../src/integrations/oauth.ts';

process.env.NOVA_SETTINGS_FILE = join(mkdtempSync(join(tmpdir(), 'nova-integrations-')), 'settings.json'); // sign-ins go next to it
const FAKE = fileURLToPath(new URL('./fixtures/fake-mcp.mjs', import.meta.url));
const until = async (check: () => boolean, ms = 10_000) => {
  for (let t = 0; t < ms && !check(); t += 25) await new Promise((r) => setTimeout(r, 25));
  expect(check()).toBe(true);
};

describe('a local integration', () => {
  it('connects over stdio with a clean environment, and calls its tools', async () => {
    const client = new McpClient(new StdioTransport(process.execPath, [FAKE], { NOTES: 'on' }, { PATH: process.env.PATH, HOME: '/tmp', AI_GATEWAY_API_KEY: 'secret' }));
    await client.connect();
    expect(client.server.name).toBe('Notes');
    expect((await client.listTools()).map((t) => t.name)).toEqual(['list_notes', 'add_note', 'delete_note']);
    expect(await client.callTool('list_notes', {})).toBe('notes: milk, eggs');
    const { env } = await client.transport.request('env', {});
    expect(env.NOTES).toBe('on');
    expect(env.AI_GATEWAY_API_KEY).toBeUndefined(); // Nova's own keys never reach a service
    client.close();
  });

  it("offers its tools to the brains with the user's rule for asking", async () => {
    const hub = new IntegrationHub({ env: process.env, redirectUri: () => '', open: () => {}, changed: () => {}, signIns: new SignIns() });
    hub.configure({ notes: { command: process.execPath, args: [FAKE] } });
    await until(() => hub.specs().length === 3);
    const tier = (name: string) => hub.specs().find((t) => t.name === name)?.tier;
    expect(hub.specs().map((t) => t.name)).toEqual(['notes__list_notes', 'notes__add_note', 'notes__delete_note']);
    expect([tier('notes__list_notes'), tier('notes__add_note')]).toEqual([2, 2]); // asks before everything by default
    expect(hub.specs()[0]!.description).toMatch(/^Notes: List the notes\..*asks the user out loud first/);

    // "Only before changes": the service's read-only label counts, because the user said so. Rules apply at once.
    hub.configure({ notes: { command: process.execPath, args: [FAKE], ask: 'changes', tools: { delete_note: 'block' } } });
    expect([tier('notes__list_notes'), tier('notes__add_note'), tier('notes__delete_note')]).toEqual([1, 2, undefined]);
    expect(hub.status()[0]).toMatchObject({ state: 'connected', ask: 'changes', kind: 'local' });

    expect(await hub.call('notes__add_note', { text: 'bread' })).toBe('Added: bread');
    expect(await hub.call('notes__list_notes', {})).toBe('notes: milk, eggs, bread');
    expect(hub.specs().find((t) => t.name === 'notes__add_note')!.summary({ text: 'bread' })).toBe('Notes: add note "bread"');
    hub.close();
  });

  it("is never given Nova's own secrets", async () => {
    const env = { ...process.env, AI_GATEWAY_API_KEY: 'gateway-secret', NOVA_OMLX_API_KEY: 'server-secret' };
    const hub = new IntegrationHub({ env, redirectUri: () => '', open: () => {}, changed: () => {}, signIns: new SignIns() });
    hub.configure({
      local: { command: process.execPath, args: [FAKE], env: { KEY: '${AI_GATEWAY_API_KEY}' } },
      hosted: { url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer ${NOVA_OMLX_API_KEY}' } },
    });
    await until(() => hub.status().every((s) => s.state === 'error'));
    expect(hub.status().map((s) => s.message)).toEqual([expect.stringMatching(/AI_GATEWAY_API_KEY is Nova's own/), expect.stringMatching(/NOVA_OMLX_API_KEY is Nova's own/)]);
    hub.close();
  });

  it('leaves no process running when a server fails to start properly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-fake-'));
    const alive = (pid: number) => {
      try {
        return process.kill(pid, 0);
      } catch {
        return false;
      }
    };
    for (const mode of ['fail-list', 'hang-init']) {
      const pidFile = join(dir, `${mode}.pid`);
      const hub = new IntegrationHub({ env: process.env, redirectUri: () => '', open: () => {}, changed: () => {}, signIns: new SignIns(), timeouts: { connect: 300, list: 300 } });
      hub.configure({ broken: { command: process.execPath, args: [FAKE], env: { FAKE_MODE: mode, FAKE_PID_FILE: pidFile } } });
      await until(() => hub.status()[0]!.state === 'error');
      const pid = Number(readFileSync(pidFile, 'utf8'));
      await until(() => !alive(pid));
      hub.close();
    }
  });

  it('ends a call that is waiting when the server is closed', async () => {
    const client = new McpClient(new StdioTransport(process.execPath, [FAKE], {}, { PATH: process.env.PATH }));
    await client.connect();
    const waiting = client.callTool('wait_forever', {});
    client.close();
    await expect(waiting).rejects.toThrow(/closed/);
  });

  it('leaves out tools whose names come out the same, and checks the rule again when one is called', async () => {
    const hub = new IntegrationHub({ env: process.env, redirectUri: () => '', open: () => {}, changed: () => {}, signIns: new SignIns() });
    hub.configure({ notes: { command: process.execPath, args: [FAKE], env: { FAKE_MODE: 'clash' }, tools: { add_note: 'allow' } } });
    await until(() => hub.specs().length > 0);
    expect(hub.specs().map((t) => t.name)).not.toContain('notes__wipe_all'); // "wipe.all" and "wipe_all": which one?
    await expect(hub.call('notes__wipe_all', {})).rejects.toThrow(/No integration offers/);
    // Blocked after the brain saw the list: still blocked.
    hub.configure({ notes: { command: process.execPath, args: [FAKE], env: { FAKE_MODE: 'clash' }, tools: { add_note: 'block' } } });
    await expect(hub.call('notes__add_note', { text: 'x' })).rejects.toThrow(/blocked/);
    hub.close();
  });

  it('says what it needs from .env, and connects nothing without it', async () => {
    const hub = new IntegrationHub({ env: {}, redirectUri: () => '', open: () => {}, changed: () => {}, signIns: new SignIns() });
    hub.configure({ gh: { url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer ${NOVA_GITHUB_TOKEN}' } } });
    await until(() => hub.status()[0]!.state === 'error');
    expect(hub.status()[0]).toMatchObject({ message: expect.stringMatching(/NOVA_GITHUB_TOKEN/), secrets: [{ name: 'NOVA_GITHUB_TOKEN', set: false }] });
    hub.close();
  });
});

// A hosted service: Streamable HTTP (answers as JSON or as a stream of events), behind an OAuth sign-in.
let server: Server;
let origin = '';
let challenge = '';
const sseClients = new Map<string, (data: unknown) => void>();
// A service that rotates its refresh tokens: each works once, and reusing one is caught.
const rotation = { refresh: 'rot-r1', access: new Set<string>(), refreshes: 0, reused: false };

function mcpAnswer(message: any) {
  if (message.method === 'initialize') return { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'Tracker', version: '1' } };
  if (message.method === 'tools/list') return { tools: [{ name: 'find_issues', description: 'Find issues.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }] };
  if (message.method === 'tools/call') return { content: [{ type: 'text', text: `3 issues about ${message.params.arguments.q}` }] };
  return {};
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, origin);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/rot/mcp') {
      if (!rotation.access.has(String(req.headers.authorization).replace('Bearer ', ''))) return res.writeHead(401).end();
      const message = JSON.parse(raw);
      if (message.id === undefined) return res.writeHead(202).end();
      return json(200, { jsonrpc: '2.0', id: message.id, result: mcpAnswer(message) });
    }
    if (url.pathname === '/mismatch/mcp') {
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/mismatch/meta"` });
      return res.end();
    }
    if (url.pathname === '/mismatch/meta') return json(200, { resource: 'https://elsewhere.example/mcp', authorization_servers: [origin] });
    if (url.pathname === '/far/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.write(`event: endpoint\ndata: ${origin.replace('127.0.0.1', 'localhost')}/messages?session=b\n\n`); // another site
    }
    if (url.pathname === '/mcp') {
      if (req.headers.authorization !== 'Bearer good-token') {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
        return res.end();
      }
      const message = JSON.parse(raw);
      if (message.id === undefined) return res.writeHead(202).end();
      const answer = { jsonrpc: '2.0', id: message.id, result: mcpAnswer(message) };
      if (message.method === 'tools/list') {
        // As a stream of events, with a notification first.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} })}\n\n`);
        return res.end(`event: message\ndata: ${JSON.stringify(answer)}\n\n`);
      }
      return json(200, answer, { 'mcp-session-id': 'session-1' });
    }
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register` });
    }
    if (url.pathname === '/register') return json(201, { client_id: 'nova-test', redirect_uris: JSON.parse(raw).redirect_uris });
    if (url.pathname === '/authorize') {
      // The user signs in; the service sends the browser back with a code.
      challenge = url.searchParams.get('code_challenge')!;
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'the-code');
      back.searchParams.set('state', url.searchParams.get('state')!);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/token' && new URLSearchParams(raw).get('grant_type') === 'refresh_token') {
      const given = new URLSearchParams(raw).get('refresh_token');
      if (given !== rotation.refresh) {
        rotation.reused = true;
        return json(400, { error: 'invalid_grant' });
      }
      rotation.refreshes++;
      const access = `rot-a${rotation.refreshes}`;
      rotation.access.add(access);
      rotation.refresh = `rot-r${rotation.refreshes + 1}`;
      await new Promise((r) => setTimeout(r, 50)); // slow enough for calls to overlap
      return json(200, { access_token: access, refresh_token: rotation.refresh, expires_in: 30, token_type: 'Bearer' });
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(raw);
      const verified = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === challenge;
      if (form.get('code') !== 'the-code' || !verified || form.get('resource') !== `${origin}/mcp`) return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: 'good-token', refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer' });
    }
    // The older transport: an event stream, and an address to post to.
    if (url.pathname === '/sse' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: endpoint\ndata: /messages?session=a\n\n`);
      sseClients.set('a', (data) => res.write(`event: message\ndata: ${JSON.stringify(data)}\n\n`));
      return;
    }
    if (url.pathname === '/messages') {
      const message = JSON.parse(raw);
      res.writeHead(202).end();
      if (message.id !== undefined) sseClients.get('a')?.({ jsonrpc: '2.0', id: message.id, result: mcpAnswer(message) });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('a hosted integration', () => {
  it('signs in with the browser (discovery, registration, PKCE), then connects and calls', async () => {
    let signInPage = '';
    const signIns = new SignIns();
    const hub = new IntegrationHub({ env: {}, redirectUri: () => 'http://127.0.0.1:7878/oauth/callback', open: (u) => (signInPage = u), changed: () => {}, signIns });
    hub.configure({ tracker: { url: `${origin}/mcp`, label: 'Tracker' } });
    await until(() => hub.status()[0]!.state === 'sign-in');
    expect(hub.status()[0]!.canSignIn).toBe(true);

    await hub.signIn('tracker');
    const page = new URL(signInPage);
    expect(page.pathname).toBe('/authorize');
    expect(page.searchParams.get('client_id')).toBe('nova-test');
    expect(page.searchParams.get('code_challenge_method')).toBe('S256');
    expect(page.searchParams.get('resource')).toBe(`${origin}/mcp`);
    // The "browser": the service redirects back to Nova with a code.
    const back = new URL((await fetch(signInPage, { redirect: 'manual' })).headers.get('location')!);
    expect(await hub.completeSignIn('forged-state', 'the-code', null)).toMatchObject({ ok: false });
    expect(await hub.completeSignIn(back.searchParams.get('state')!, back.searchParams.get('code'), null)).toMatchObject({ ok: true });

    await until(() => hub.status()[0]!.state === 'connected');
    expect(hub.status()[0]).toMatchObject({ signedIn: true, label: 'Tracker' });
    expect(hub.specs().map((t) => t.name)).toEqual(['tracker__find_issues']);
    expect(await hub.call('tracker__find_issues', { q: 'login' })).toBe('3 issues about login');
    expect((await signIns.get('tracker'))?.tokens?.access_token).toBe('good-token');

    await hub.signOut('tracker');
    await until(() => hub.status()[0]!.state === 'sign-in');
    hub.close();
  });

  it('speaks the older SSE transport too - posting only to its own site', async () => {
    const hub = new IntegrationHub({ env: {}, redirectUri: () => '', open: () => {}, changed: () => {}, signIns: new SignIns() });
    hub.configure({ old: { url: `${origin}/sse` }, far: { url: `${origin}/far/sse` } });
    await until(() => hub.status()[0]!.state === 'connected' && hub.status()[1]!.state === 'error');
    expect(await hub.call('old__find_issues', { q: 'crash' })).toBe('3 issues about crash');
    expect(hub.status()[1]!.message).toMatch(/another site/);
    hub.close();
  });

  it('renews a sign-in once for calls that need it at the same time', async () => {
    const signIns = new SignIns();
    rotation.access.add('rot-a0');
    await signIns.set('rot', {
      authServer: { authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token` },
      resource: `${origin}/rot/mcp`,
      server: `${origin}/rot/mcp`,
      client: { client_id: 'nova-test', redirect_uri: 'http://127.0.0.1:7878/oauth/callback' },
      tokens: { access_token: 'rot-a0', refresh_token: 'rot-r1', expires_at: Date.now() + 30_000 },
    });
    const hub = new IntegrationHub({ env: {}, redirectUri: () => '', open: () => {}, changed: () => {}, signIns });
    hub.configure({ rot: { url: `${origin}/rot/mcp` } });
    await until(() => hub.status()[0]!.state === 'connected');
    const before = rotation.refreshes;
    // Near expiry, three calls at once: one renewal between them, and no refresh token used twice.
    expect(await Promise.all([1, 2, 3].map((n) => hub.call('rot__find_issues', { q: `bug ${n}` })))).toEqual(['3 issues about bug 1', '3 issues about bug 2', '3 issues about bug 3']);
    expect(rotation.refreshes - before).toBe(1);
    expect(rotation.reused).toBe(false);

    // The address changed: that service's tokens don't go to the new one.
    hub.configure({ rot: { url: `${origin}/mcp` } });
    await until(() => hub.status()[0]!.state === 'sign-in');
    expect(await signIns.get('rot')).toBeUndefined();
    hub.close();
  });

  it("won't use a sign-in description that is about another server", async () => {
    let opened = '';
    const hub = new IntegrationHub({ env: {}, redirectUri: () => 'http://127.0.0.1:7878/oauth/callback', open: (u) => (opened = u), changed: () => {}, signIns: new SignIns() });
    hub.configure({ mismatch: { url: `${origin}/mismatch/mcp` } });
    await until(() => hub.status()[0]!.state === 'sign-in');
    await expect(hub.signIn('mismatch')).rejects.toThrow(/elsewhere\.example/);
    expect(opened).toBe('');
    hub.close();
  });
});

describe('signing in', () => {
  it('only ever opens a web page, and sends codes and tokens only over https (or to this Mac)', () => {
    expect(secureAddress('https://auth.example/authorize')).toBe(true);
    expect(secureAddress('http://127.0.0.1:9000/authorize')).toBe(true);
    for (const url of ['http://auth.example/authorize', 'file:///Applications/Calculator.app', 'x-apple.systempreferences:', 'javascript:alert(1)', 42]) {
      expect(secureAddress(url), String(url)).toBe(false);
    }
    const signIn = { authServer: { authorization_endpoint: 'file:///etc/passwd', token_endpoint: 'https://a/t' }, resource: 'https://a/mcp', client: { client_id: 'x', redirect_uri: 'http://127.0.0.1:1/cb' } };
    expect(() => authorizeUrl(signIn, 's', 'c')).toThrow(/won't open/);
  });

  it("uses a server's description of itself only when it's about that server", () => {
    expect(resourceCovers('https://mcp.example/mcp', 'https://mcp.example/mcp')).toBe(true);
    expect(resourceCovers('https://mcp.example', 'https://mcp.example/mcp')).toBe(true); // the whole site
    expect(resourceCovers('https://mcp.example/mcp', 'https://mcp.example/mcp/')).toBe(true);
    expect(resourceCovers('https://mcp.example/mc', 'https://mcp.example/mcp')).toBe(false);
    expect(resourceCovers('https://evil.example/mcp', 'https://mcp.example/mcp')).toBe(false);
    expect(resourceCovers('http://mcp.example/mcp', 'https://mcp.example/mcp')).toBe(false);
  });
});
