import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IntegrationHub } from '../src/integrations/hub.ts';
import { McpClient, StdioTransport } from '../src/integrations/mcp.ts';
import { SignIns } from '../src/integrations/oauth.ts';

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

  it('speaks the older SSE transport too', async () => {
    const hub = new IntegrationHub({ env: {}, redirectUri: () => '', open: () => {}, changed: () => {}, signIns: new SignIns() });
    hub.configure({ old: { url: `${origin}/sse` } });
    await until(() => hub.status()[0]!.state === 'connected');
    expect(await hub.call('old__find_issues', { q: 'crash' })).toBe('3 issues about crash');
    hub.close();
  });
});
