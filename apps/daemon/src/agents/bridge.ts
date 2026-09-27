import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { outputText, type ToolHost } from '@nova/core';
import type { ApprovalHookup } from './presets.ts';

const MCP_BRIDGE = fileURLToPath(new URL('./nova-mcp.mjs', import.meta.url));

export interface PermissionPrompt {
  tool_name: string;
  input: unknown;
}

/** Whether a step may run: yes, no, or no with a word to the agent on what to do instead. */
export type Approver = (prompt: PermissionPrompt) => Promise<boolean | { deny: string }>;

/** An MCP server any agent CLI can start: Nova's tools, reached through a small stdio bridge. */
export interface McpServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** What one project task is given: Nova's MCP server, and - for Claude - how its permission prompts reach Nova. */
export interface TaskHookup {
  /** One server for both: the approval tool (when asked for) and Nova's tools (when given). */
  server: McpServer;
  approvals?: ApprovalHookup;
  close(): void;
}

export type Bridge = Awaited<ReturnType<typeof startBridge>>;
/** Older name, from when the bridge only carried permission prompts. */
export type Approvals = Bridge;

/**
 * A localhost endpoint that agents reach through nova-mcp.mjs: Claude Code's permission prompts
 * during project tasks, and Nova's tools - for agents answering open questions, and for agents at
 * work on a task (through the task's own host, so its questions are the task's). Every hookup gets
 * its own token, so nothing else on the machine can call in.
 */
export async function startBridge(tools: ToolHost) {
  const approvers = new Map<string, Approver>();
  /** Token -> who is calling (e.g. "Claude") and where their calls go. */
  const callers = new Map<string, { caller: string; host: ToolHost }>();
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const body = req.method === 'POST' ? await readJson(req) : null;
    if (res.destroyed) return; // the agent went away mid-request
    const reply = (value: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const token = String(body?.token ?? '');
    if (req.url === '/approve' && approvers.has(token)) {
      const answer = await approvers.get(token)!({ tool_name: String(body.tool_name), input: body.input ?? {} }).catch(() => false as const);
      if (answer === true) return reply({ behavior: 'allow', updatedInput: body.input ?? {} });
      return reply({ behavior: 'deny', message: typeof answer === 'object' ? answer.deny : 'The user said no to this step (asked by voice through Nova).' });
    }
    const hooked = callers.get(token);
    if (req.url === '/tools' && hooked) return reply({ tools: hooked.host.specs() });
    if (req.url === '/call' && hooked) {
      const output = await hooked.host.call(String(body.name), body.arguments ?? {}, hooked.caller).catch((e) => `That didn't work: ${(e as Error).message}`);
      // A picture (a screenshot) goes along for agents that can see.
      return reply({ text: outputText(output), image: typeof output === 'object' ? output.image : undefined });
    }
    res.writeHead(403).end();
  };
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.warn(`  [bridge] ${(e as Error).message}`);
      if (!res.headersSent && !res.destroyed) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bridge = (env: Record<string, string>): McpServer => ({ name: 'nova', command: process.execPath, args: [MCP_BRIDGE], env: { NOVA_BRIDGE_URL: url, ...env } });
  const token = () => randomBytes(16).toString('hex');

    /**
   * One project task's hookup: its permission prompts go to `approve` (Claude), and `host` is Nova's
   * tools for the agent at work - one nova-mcp server with both tokens. close() when the task ends.
   */
  const task = (opts: { caller: string; approve?: Approver; host?: ToolHost }): TaskHookup => {
    const env: Record<string, string> = {};
    const approval = opts.approve ? token() : null;
    const toolsToken = opts.host ? token() : null;
    if (approval) {
      approvers.set(approval, opts.approve!);
      env.NOVA_APPROVAL_TOKEN = approval;
    }
    if (toolsToken) {
      callers.set(toolsToken, { caller: opts.caller, host: opts.host! });
      env.NOVA_TOOLS_TOKEN = toolsToken;
    }
    const server = bridge(env);
    return {
      server,
      ...(approval ? { approvals: { mcpConfig: claudeMcpConfig(server), tool: 'mcp__nova__approve' } } : {}),
      close: () => {
        if (approval) approvers.delete(approval);
        if (toolsToken) callers.delete(toolsToken);
      },
    };
  };

  return {
    task,
    /** Route one task's permission prompts to `ask`; close() when the task ends. */
    hookup(ask: Approver): ApprovalHookup & { close(): void } {
      const hooked = task({ caller: '', approve: ask });
      return { ...hooked.approvals!, close: hooked.close };
    },
    /** Nova's tools for one agent, as an MCP server its CLI can start. */
    tools(caller: string): McpServer & { close(): void } {
      const t = token();
      callers.set(t, { caller, host: tools });
      return { ...bridge({ NOVA_TOOLS_TOKEN: t }), close: () => void callers.delete(t) };
    },
  };
}

/** Claude Code's --mcp-config JSON for one server. */
export const claudeMcpConfig = (server: McpServer) =>
  JSON.stringify({ mcpServers: { [server.name]: { command: server.command, args: server.args, env: server.env } } });

/** A request's JSON body; null when it isn't JSON, is too big, or the request was cut off. */
async function readJson(req: IncomingMessage): Promise<any> {
  let raw = '';
  try {
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1_000_000) return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
