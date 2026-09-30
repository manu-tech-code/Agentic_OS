// Speaks the Apple model helper's protocol (native/apple-model), so Nova's link to it can be tested
// without Apple Intelligence. What it does depends on the prompt:
//   "use <tool>"  calls that tool with {"request": ...} and says what it said
//   "hang"        never answers (for stopping mid-answer)
//   "fail <code>" fails with that code
//   "unavailable <reason>" fails as the helper does when the model isn't available
//   "quit"        exits mid-answer
// anything else  answers "Hello there." in two pieces
import { createInterface } from 'node:readline';

const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const waiting = new Map();
let calls = 0;
let asked = 0;
// Asked again, it answers a little differently - so a test can tell it was asked.
const status = () => ({ type: 'status', available: true, model: `AFM 3 Core Advanced${++asked > 1 ? ` (${asked})` : ''}`, contextSize: 8192, vision: true, language: true });

createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line);
  if (command.type === 'status') return out(status());
  if (command.type === 'tool-result') return waiting.get(command.call)?.(command);
  if (command.type === 'cancel') return out({ type: 'cancelled', id: command.id });
  if (command.type !== 'ask') return;
  const { id, prompt } = command;
  const use = /use (\w+)/.exec(prompt);
  if (prompt.includes('hang')) return;
  if (prompt.includes('quit')) return process.exit(3);
  const fail = /fail (\w+)/.exec(prompt);
  if (fail) return out({ type: 'error', id, code: fail[1], detail: 'as asked' });
  const unavailable = /unavailable (\w+)/.exec(prompt);
  if (unavailable) return out({ type: 'error', id, code: 'unavailable', detail: unavailable[1] });
  if (use) {
    const call = `c${++calls}`;
    waiting.set(call, (result) => {
      out({ type: 'text', id, text: `It said: ${result.text}${result.image ? ' (with a picture)' : ''}` });
      out({ type: 'done', id });
    });
    return out({ type: 'tool-call', id, call, name: use[1], arguments: { request: 'something' } });
  }
  out({ type: 'text', id, text: 'Hello ' });
  out({ type: 'text', id, text: `there.${command.act ? ' (acting)' : ''}` });
  out({ type: 'done', id });
});
