import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { startBridge } from '../src/agents/bridge.ts';
import { agentEnv } from '../src/agents/host.ts';
import { describeAction, tooLongToSay } from '../src/agents/parsers.ts';
import { customPreset, PRESETS, type AgentPreset } from '../src/agents/presets.ts';
import { AgentSession } from '../src/agents/session.ts';

const FAKE_AGENT = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

/** Talk JSON-RPC to an MCP stdio server. */
function rpcClient(child: ReturnType<typeof spawn>) {
  let id = 0;
  const waiting = new Map<number, (result: any) => void>();
  createInterface({ input: child.stdout! }).on('line', (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg.result ?? msg.error);
  });
  return (method: string, params: unknown = {}) =>
    new Promise<any>((resolve) => {
      waiting.set(++id, resolve);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
}

describe("Nova's tools, for any agent", () => {
  it('reach agents through the MCP bridge, and only with a live token', async () => {
    const calls: unknown[][] = [];
    const bridge = await startBridge({
      specs: () => [{ name: 'open_app', description: 'Open an app', parameters: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] } }],
      call: async (name, args, caller) => (calls.push([name, args, caller]), 'Opening Slack.'),
    });
    const server = bridge.tools('Codex');
    const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env } });
    const rpc = rpcClient(child);
    await rpc('initialize', { protocolVersion: '2025-06-18' });
    const { tools } = await rpc('tools/list');
    expect(tools.map((t: any) => [t.name, t.inputSchema.required])).toEqual([['open_app', ['app']]]);
    const result = await rpc('tools/call', { name: 'open_app', arguments: { app: 'Slack' } });
    expect(result.content[0].text).toBe('Opening Slack.');
    expect(calls).toEqual([['open_app', { app: 'Slack' }, 'Codex']]);
    server.close();
    const refused = await rpc('tools/call', { name: 'open_app', arguments: { app: 'Slack' } });
    expect(refused.content[0].text).toMatch(/couldn't/);
    child.kill();
  });

  it('hand agents a picture along with the words, when a tool has one', async () => {
    const bridge = await startBridge({
      specs: () => [{ name: 'look_at_screen', description: 'Look', parameters: { type: 'object', properties: { request: { type: 'string' } }, required: [] } }],
      call: async () => ({ text: 'npm ERR! missing script', image: { data: 'QUJD', mimeType: 'image/jpeg' } }),
    });
    const server = bridge.tools('Claude');
    const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env } });
    const rpc = rpcClient(child);
    await rpc('initialize', { protocolVersion: '2025-06-18' });
    const result = await rpc('tools/call', { name: 'look_at_screen', arguments: { request: 'the error' } });
    expect(result.content).toEqual([
      { type: 'text', text: 'npm ERR! missing script' },
      { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' },
    ]);
    server.close();
    child.kill();
  });

  it('keep answering after a request is cut off halfway', async () => {
    const bridge = await startBridge({ specs: () => [], call: async () => 'ok' });
    const server = bridge.tools('Codex');
    const url = new URL(server.env.NOVA_BRIDGE_URL!);
    await new Promise<void>((resolve) => {
      const socket = connect(Number(url.port), '127.0.0.1', () => {
        socket.write('POST /call HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"token":');
        setTimeout(() => (socket.destroy(), resolve()), 50);
      });
    });
    await new Promise((r) => setTimeout(r, 100));
    const res = await fetch(`${url.origin}/tools`, { method: 'POST', body: JSON.stringify({ token: server.env.NOVA_TOOLS_TOKEN }) });
    expect(await res.json()).toEqual({ tools: [] });
    server.close();
  });

  it('are attached the way each CLI takes them', () => {
    const tools = { name: 'nova', command: '/usr/bin/node', args: ['/x/nova-mcp.mjs'], env: { NOVA_BRIDGE_URL: 'http://127.0.0.1:1', NOVA_TOOLS_TOKEN: 't' } };
    const claude = PRESETS.claude!.ask('hi', { assistant: 'Nova', tools }).args;
    expect(JSON.parse(claude[claude.indexOf('--mcp-config') + 1]!).mcpServers.nova.env.NOVA_TOOLS_TOKEN).toBe('t');
    expect(claude[claude.indexOf('--allowedTools') + 1]).toBe('WebSearch,WebFetch,mcp__nova');
    expect(PRESETS.claude!.session!({ assistant: 'Nova', tools }).args).toContain('--input-format');

    const codex = PRESETS.codex!.ask('hi', { assistant: 'Nova', tools }).args;
    expect(codex).toContain('mcp_servers.nova.command="/usr/bin/node"');
    expect(codex).toContain('mcp_servers.nova.env={NOVA_BRIDGE_URL="http://127.0.0.1:1",NOVA_TOOLS_TOKEN="t"}');

    const opencode = PRESETS.opencode!.ask('hi', { assistant: 'Nova', tools });
    const config = JSON.parse(readFileSync(opencode.env!.OPENCODE_CONFIG!, 'utf8'));
    expect(config.mcp.nova).toMatchObject({ type: 'local', command: ['/usr/bin/node', '/x/nova-mcp.mjs'], environment: tools.env });

    const aider = customPreset('aider', { command: 'aider', ask: ['--message', '{prompt}'], task: [], mcp: ['--mcp-config', '{mcpConfig}'] }).ask('hi', { assistant: 'Nova', tools });
    expect(aider.args[0]).toBe('--mcp-config');
    expect(PRESETS.codex!.ask('hi', { assistant: 'Nova' }).args.some((a) => a.includes('mcp_servers'))).toBe(false);
  });
});

describe('an agent kept running as the brain', () => {
  const preset: AgentPreset = {
    label: 'Fake',
    bin: process.execPath,
    output: 'claude',
    ask: () => ({ args: [] }),
    task: () => ({ args: [] }),
    session: () => ({ args: [FAKE_AGENT] }),
  };
  const collect = async (pieces: AsyncIterable<string>) => {
    const out: string[] = [];
    for await (const piece of pieces) out.push(piece);
    return out;
  };

  it('streams answers, remembers the conversation, and restarts after being stopped', async () => {
    const session = new AgentSession({ preset, bin: process.execPath, extraArgs: [] }, { cwd: tmpdir(), assistant: 'Nova', env: () => process.env });
    const first = await collect(session.stream('hi', []));
    expect(first.length).toBeGreaterThan(1);
    expect(first.join('')).toBe('Turn 1: hello there.');
    expect(await session.reply('again', [])).toBe('Turn 2: hello there.'); // the same process

    const stop = new AbortController();
    const hanging = collect(session.stream('hang on', [], stop.signal));
    await new Promise((r) => setTimeout(r, 50));
    stop.abort();
    await expect(hanging).rejects.toThrow(/Stopped/);
    // A new process, told what was said before.
    expect(await session.reply('after', [{ user: 'hi', nova: 'Turn 1: hello there.' }])).toBe('Turn 1: I remember. hello there.');
    session.close();
  });

  it("isn't cut off by the process a refresh replaced", async () => {
    const session = new AgentSession({ preset, bin: process.execPath, extraArgs: [] }, { cwd: tmpdir(), assistant: 'Nova', env: () => process.env });
    session.warm();
    session.refresh(); // the old process exits while the new one answers
    expect(await session.reply('hi', [])).toBe('Turn 1: hello there.');
    session.close();
  });

  it("says so when its CLI can't start, instead of taking Nova down", async () => {
    const session = new AgentSession({ preset, bin: '/nonexistent/claude', extraArgs: [] }, { cwd: tmpdir(), assistant: 'Nova', env: () => process.env });
    await expect(session.reply('hi', [])).rejects.toThrow(/couldn't start/);
    session.close();
  });
});

describe('what agents are given', () => {
  it('an environment without keys, but with what finds their own sign-in', () => {
    const saved = { ...process.env };
    Object.assign(process.env, { OPENAI_API_KEY: 'k', CODEX_API_KEY: 'k', GEMINI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', NOVA_GITHUB_TOKEN: 't', AI_GATEWAY_API_KEY: 'g', CLAUDECODE: '1', CODEX_HOME: '/c', XDG_CONFIG_HOME: '/x' });
    try {
      const env = agentEnv(undefined, { OPENCODE_CONFIG: '/o.json' });
      for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'NOVA_GITHUB_TOKEN', 'AI_GATEWAY_API_KEY', 'CLAUDECODE']) expect(env[key], key).toBeUndefined();
      expect(env).toMatchObject({ PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: '/c', XDG_CONFIG_HOME: '/x', OPENCODE_CONFIG: '/o.json' });
    } finally {
      process.env = saved;
    }
  });

  it("Claude's tasks without the project's committed settings, which could skip asking", () => {
    const args = PRESETS.claude!.task('fix it', { assistant: 'Nova', approvals: { mcpConfig: '{}', tool: 'mcp__nova__approve' } }).args;
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('local');
    expect(args).toContain('--permission-prompt-tool');
  });

  it('permission prompts that say exactly what is allowed', () => {
    const long = `npm run build && ${'echo step && '.repeat(30)}echo done`;
    expect(describeAction('Bash', { command: long })).toBe(`run "${long}"`); // all of it
    expect(tooLongToSay('Bash', { command: long })).toMatch(/too long.*shorter commands/);
    expect(tooLongToSay('Bash', { command: 'npm test' })).toBeNull();
    const project = join(homedir(), 'dev', 'site');
    expect(describeAction('Edit', { file_path: join(project, 'src', 'app.ts') }, project)).toBe(`edit ${join('src', 'app.ts')}`);
    expect(describeAction('Write', { file_path: join(homedir(), 'Library', 'LaunchAgents', 'x.plist') }, project)).toBe('write ~/Library/LaunchAgents/x.plist, outside the project');
    expect(describeAction('Edit', { file_path: '../other/secret.ts' }, project)).toBe('edit ~/dev/other/secret.ts, outside the project');
  });
});
