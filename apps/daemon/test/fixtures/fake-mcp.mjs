// A small MCP server for tests: notes you can list (read-only), add, and delete.
// FAKE_MODE: "hang-init" never says hello, "fail-list" can't list its tools, "clash" has two tools
// whose names come out the same for brains. FAKE_PID_FILE: where it writes its process id.
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_MODE ?? '';
if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));

const notes = ['milk', 'eggs'];
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const tools = [
  { name: 'list_notes', description: 'List the notes.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'add_note', description: 'Add a note.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'delete_note', description: 'Delete a note.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { destructiveHint: true } },
  ...(mode === 'clash'
    ? [
        { name: 'wipe.all', description: 'Wipe everything.', inputSchema: { type: 'object', properties: {} } },
        { name: 'wipe_all', description: 'Wipe the cache.', inputSchema: { type: 'object', properties: {} } },
      ]
    : []),
];
// Not listed, but answered (never): "wait_forever", for a call that's still waiting.
console.error('fake-mcp starting'); // servers log to stderr
process.stdout.write('not json: a server logging to stdout\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'initialize') {
    if (mode === 'hang-init') return;
    return send({ id, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'Notes', version: '1' } } });
  }
  if (method === 'tools/list') {
    if (mode === 'fail-list') return send({ id, error: { code: -32603, message: 'The tool list is broken.' } });
    return send({ id, result: { tools } });
  }
  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    if (name === 'list_notes') return send({ id, result: { content: [{ type: 'text', text: `notes: ${notes.join(', ')}` }] } });
    if (name === 'add_note') {
      notes.push(args.text);
      send({ method: 'notifications/tools/list_changed' });
      return send({ id, result: { content: [{ type: 'text', text: `Added: ${args.text}` }] } });
    }
    if (name === 'delete_note') return send({ id, result: { content: [{ type: 'text', text: 'Deleted.' }] } });
    if (name === 'wait_forever') return;
    if (name === 'wipe.all' || name === 'wipe_all') return send({ id, result: { content: [{ type: 'text', text: `${name} done` }] } });
    return send({ id, result: { isError: true, content: [{ type: 'text', text: 'no such tool' }] } });
  }
  if (method === 'env') return send({ id, result: { env: process.env } });
  send({ id, error: { code: -32601, message: `Unknown method ${method}` } });
});
