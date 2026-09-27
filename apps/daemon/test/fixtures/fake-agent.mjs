// Speaks Claude Code's stream-json protocol, so Nova's agent sessions can be tested without a real agent.
import { createInterface } from 'node:readline';

let turn = 0;
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  const text = String(JSON.parse(line).message?.content ?? '');
  turn++;
  if (text.includes('hang')) return; // never answers: for stopping mid-answer
  const reply = `Turn ${turn}: ${text.includes('Conversation so far') ? 'I remember. ' : ''}hello there.`;
  out({ type: 'system', subtype: 'init' });
  for (const word of reply.split(/(?<= )/)) out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: word } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: reply });
});
