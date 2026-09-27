import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { outputText, type ToolHost } from '@nova/core';
import type { ApprovalHookup } from './presets.ts';

const MCP_BRIDGE = fileURLToPath(new URL('./nova-mcp.mjs', import.meta.url));

export interface PermissionPrompt {
  tool_name: string;
  input: unknown;
}

/** An MCP server any agent CLI can start: Nova's tools, reached through a small stdio bridge. */
export interface McpServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type Bridge = Awaited<ReturnType<typeof startBridge>>;
/** Older name, from when the bridge only carried permission prompts. */
export type Approvals = Bridge;

/**
 * A localhost endpoint that agents reach through nova-mcp.mjs: Claude Code's permission prompts
 * during project tasks, and Nova's tools for any agent answering open questions. Every hookup
 * gets its own token, so nothing else on the machine can call in.
 */
export async function startBridge(tools: ToolHost) {
  const approvers = new Map<string, (prompt: PermissionPrompt) => Promise<boolean>>();
  const callers = new Map<string, string>(); // token -> who is calling, e.g. "Claude"
  const server = createServer(async (req, res) => {
    const body = req.method === 'POST' ? await readJson(req) : null;
    const reply = (value: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const token = String(body?.token ?? '');
    if (req.url === '/approve' && approvers.has(token)) {
      const ok = await approvers.get(token)!({ tool_name: String(body.tool_name), input: body.input ?? {} }).catch(() => false);
      return reply(ok ? { behavior: 'allow', updatedInput: body.input ?? {} } : { behavior: 'deny', message: 'The user said no to this step (asked by voice through Nova).' });
    }
    if (req.url === '/tools' && callers.has(token)) return reply({ tools: tools.specs() });
    if (req.url === '/call' && callers.has(token)) {
      const output = await tools.call(String(body.name), body.arguments ?? {}, callers.get(token)!).catch((e) => `That didn't work: ${(e as Error).message}`);
      // A picture (a screenshot) goes along for agents that can see.
      return reply({ text: outputText(output), image: typeof output === 'object' ? output.image : undefined });
    }
    res.writeHead(403).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bridge = (env: Record<string, string>): McpServer => ({ name: 'nova', command: process.execPath, args: [MCP_BRIDGE], env: { NOVA_BRIDGE_URL: url, ...env } });

  return {
    /** Route one task's permission prompts to `ask`; close() when the task ends. */
    hookup(ask: (prompt: PermissionPrompt) => Promise<boolean>): ApprovalHookup & { close(): void } {
      const token = randomBytes(16).toString('hex');
      approvers.set(token, ask);
      const server = bridge({ NOVA_APPROVAL_TOKEN: token });
      return { mcpConfig: claudeMcpConfig(server), tool: 'mcp__nova__approve', close: () => void approvers.delete(token) };
    },
    /** Nova's tools for one agent, as an MCP server its CLI can start. */
    tools(caller: string): McpServer & { close(): void } {
      const token = randomBytes(16).toString('hex');
      callers.set(token, caller);
      return { ...bridge({ NOVA_TOOLS_TOKEN: token }), close: () => void callers.delete(token) };
    },
  };
}

/** Claude Code's --mcp-config JSON for one server. */
export const claudeMcpConfig = (server: McpServer) =>
  JSON.stringify({ mcpServers: { [server.name]: { command: server.command, args: server.args, env: server.env } } });

async function readJson(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
