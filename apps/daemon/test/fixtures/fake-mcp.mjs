// A small MCP server for tests: notes you can list (read-only), add, and delete.
import { createInterface } from 'node:readline';

const notes = ['milk', 'eggs'];
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const tools = [
  { name: 'list_notes', description: 'List the notes.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'add_note', description: 'Add a note.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'delete_note', description: 'Delete a note.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { destructiveHint: true } },
];
console.error('fake-mcp starting'); // servers log to stderr
process.stdout.write('not json: a server logging to stdout\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'initialize') return send({ id, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'Notes', version: '1' } } });
  if (method === 'tools/list') return send({ id, result: { tools } });
  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    if (name === 'list_notes') return send({ id, result: { content: [{ type: 'text', text: `notes: ${notes.join(', ')}` }] } });
    if (name === 'add_note') {
      notes.push(args.text);
      send({ method: 'notifications/tools/list_changed' });
      return send({ id, result: { content: [{ type: 'text', text: `Added: ${args.text}` }] } });
    }
    if (name === 'delete_note') return send({ id, result: { content: [{ type: 'text', text: 'Deleted.' }] } });
    return send({ id, result: { isError: true, content: [{ type: 'text', text: 'no such tool' }] } });
  }
  if (method === 'env') return send({ id, result: { env: process.env } });
  send({ id, error: { code: -32601, message: `Unknown method ${method}` } });
});
