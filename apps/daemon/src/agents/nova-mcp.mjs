// A minimal MCP stdio server that agent CLIs start to reach the Nova daemon:
//  - Nova's tools (open apps, timers, ...) for an agent answering open questions (NOVA_TOOLS_TOKEN);
//  - `approve`, Claude Code's permission prompt tool during project tasks (NOVA_APPROVAL_TOKEN),
//    which Nova answers by asking the user out loud.
import { createInterface } from 'node:readline';

const base = process.env.NOVA_BRIDGE_URL;
const toolsToken = process.env.NOVA_TOOLS_TOKEN;
const approvalToken = process.env.NOVA_APPROVAL_TOKEN;
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

const APPROVE = {
  name: 'approve',
  description: 'Ask the user, by voice through Nova, whether a tool call may run.',
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    required: ['tool_name', 'input'],
  },
};

async function post(path, body) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Nova answered ${res.status}`);
  return res;
}

async function tools() {
  const list = approvalToken ? [APPROVE] : [];
  if (toolsToken) {
    try {
      const { tools } = await (await post('/tools', { token: toolsToken })).json();
      for (const t of tools) list.push({ name: t.name, description: t.description, inputSchema: t.parameters });
    } catch (e) {
      // Nova isn't reachable, or doesn't know this session's token: no tools to offer - said where the
      // agent CLI keeps its MCP logs, so an agent without Nova's tools is never a mystery.
      process.stderr.write(`nova-mcp: no tools from Nova (${e.message})\n`);
    }
  }
  return list;
}

async function call(name, args) {
  if (name === 'approve' && approvalToken) {
    try {
      return await (await post('/approve', { token: approvalToken, ...args })).text();
    } catch {
      return JSON.stringify({ behavior: 'deny', message: 'Nova could not ask the user, so this step was not allowed.' });
    }
  }
  try {
    const { text, image } = await (await post('/call', { token: toolsToken, name, arguments: args })).json();
    return image ? { text, image } : text;
  } catch (e) {
    return `Nova couldn't do that: ${e.message}`;
  }
}

/** A tool's answer as MCP content: its words, and a picture when there is one. */
const content = (answer) =>
  typeof answer === 'string' ? [{ type: 'text', text: answer }] : [{ type: 'text', text: answer.text }, { type: 'image', data: answer.image.data, mimeType: answer.image.mimeType }];

createInterface({ input: process.stdin }).on('line', async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (id === undefined) return; // notifications need no reply
  switch (method) {
    case 'initialize':
      return send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'nova', version: '0.2.0' } } });
    case 'ping':
      return send({ id, result: {} });
    case 'tools/list':
      return send({ id, result: { tools: await tools() } });
    case 'tools/call':
      return send({ id, result: { content: content(await call(params?.name, params?.arguments ?? {})) } });
    default:
      return send({ id, error: { code: -32601, message: `Unknown method ${method}` } });
  }
});
