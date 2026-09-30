import { fileURLToPath } from 'node:url';
import { builtinSkills, handsSkills, memorySkills, screenSkills, skillTool, type QuestionHints, type ToolSpec } from '@nova/core';
import { afterEach, describe, expect, it } from 'vitest';
import { APPLE_LABEL, AppleBrain, appleInstructions, CALCULATOR, chooseTools, MOST_TOOLS, spoken } from '../src/apple/brain.ts';
import { calculated, evaluate, formatNumber } from '../src/apple/calculate.ts';
import { AppleModel, AppleModelError, cantRunHere, statusFrom } from '../src/apple/helper.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-apple-model.mjs', import.meta.url));
const SPECS: ToolSpec[] = [...builtinSkills, ...memorySkills, ...screenSkills, ...handsSkills].map(skillTool);
const names = (tools: ToolSpec[]) => tools.map((t) => t.name);

/** System 1's weighing, as NovaBrain passes it: the pick, and each skill's chance. */
const hints = (heard: string, intent: string, skills: [string, number][]): QuestionHints => ({ heard, intent, skills: skills.map(([id, p]) => ({ id, p })) });

describe('the calculator', () => {
  it('works out arithmetic in code', () => {
    expect(evaluate('17 * 23')).toBe(391);
    expect(evaluate('(120 - 15) / 4')).toBe(26.25);
    expect(evaluate('15% of 80')).toBe(12);
    expect(evaluate('2^3^2')).toBe(512);
    expect(evaluate('-2^2')).toBe(-4);
    expect(evaluate('2^-1')).toBe(0.5);
    expect(evaluate('1,200,000 / 3')).toBe(400_000);
    expect(evaluate('17 times 23 minus 4')).toBe(387);
    expect(evaluate('sqrt(16) + 2x3')).toBe(10);
  });

  it('says a number as it would be read, without binary noise', () => {
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatNumber(1 / 3)).toBe('0.3333333333');
    expect(formatNumber(1234567)).toBe('1,234,567');
  });

  it("answers the model in words - and says what isn't arithmetic", () => {
    expect(calculated({ expression: '23 * 19 - 4' })).toBe('23 * 19 - 4 = 433');
    expect(calculated({ expression: '10 / 0' })).toMatch(/can't divide by zero/);
    expect(calculated({ expression: '3:05' })).toMatch(/isn't arithmetic/);
    expect(calculated({ expression: 'length_of_river' })).toMatch(/isn't arithmetic/);
    expect(calculated({ expression: 'process.exit()' })).toMatch(/isn't arithmetic/);
    expect(calculated({})).toMatch(/Give me the arithmetic/);
  });
});

describe('the tools that go with a question', () => {
  it('none for plain conversation', () => {
    const chosen = chooseTools(SPECS, hints("What's the longest river in Africa?", 'chat', [['open_app', 0.0001], ['files', 0.0001]]));
    expect(chosen.tools).toEqual([]);
    expect(chosen.act).toBe(false);
  });

  it("the skill System 1 picked, and others it gave a real chance - a request to act", () => {
    const chosen = chooseTools(SPECS, hints('Remember that I take the 8:15 train', 'remember', [['remember', 0.9], ['recall', 0.05], ['files', 0.001]]));
    expect(names(chosen.tools)).toEqual(['remember', 'recall']);
    expect(chosen.act).toBe(true);
  });

  it('its first four when several things are asked, whatever their chances', () => {
    const chosen = chooseTools(SPECS, hints('Set a timer for 10 minutes and turn the volume down', 'set_timer', [['set_timer', 1], ['system_control', 0.0001], ['run_shortcut', 0.00001], ['media_control', 0.000001], ['files', 0]]));
    expect(names(chosen.tools)).toEqual(['set_timer', 'system_control', 'run_shortcut', 'media_control']);
    expect(chosen).toMatchObject({ act: true, several: true });
  });

  it('never the computer, nor the time (every question comes with it)', () => {
    const chosen = chooseTools(SPECS, hints('Open Safari and play some jazz', 'open_app', [['open_app', 1], ['computer_task', 0.001], ['tell_time', 0.001], ['media_control', 0.0001]]));
    expect(names(chosen.tools)).toEqual(['open_app', 'media_control']);
  });

  it('looks at the screen when that is what is meant', () => {
    const chosen = chooseTools(SPECS, hints('What does this error on my screen mean?', 'chat', []));
    expect(names(chosen.tools)).toEqual(['look_at_screen']);
    expect(chosen.act).toBe(true);
  });

  it("a service's tools when the user names it", () => {
    const linear = [
      { name: 'linear__create_issue', description: 'Create an issue in Linear', parameters: { type: 'object' as const, properties: {}, required: [] }, label: 'Linear' },
      { name: 'linear__list_issues', description: 'List issues', parameters: { type: 'object' as const, properties: {}, required: [] }, label: 'Linear' },
      { name: 'slack__post', description: 'Post a message', parameters: { type: 'object' as const, properties: {}, required: [] }, label: 'Slack' },
    ];
    const chosen = chooseTools([...SPECS, ...linear], hints('Create an issue in Linear about the login bug', 'other', []));
    expect(names(chosen.tools)).toEqual(['linear__create_issue', 'linear__list_issues']);
    expect(chosen.act).toBe(true);
  });

  it("the last question's tools only for a reply - acting on a yes only to what was offered", () => {
    const carried = ['set_timer'];
    expect(names(chooseTools(SPECS, hints('yes please', 'confirm_yes', []), carried, true).tools)).toEqual(['set_timer']);
    expect(chooseTools(SPECS, hints('yes please', 'confirm_yes', []), carried, true).act).toBe(true);
    expect(chooseTools(SPECS, hints('yes please', 'confirm_yes', []), carried, false).act).toBe(false);
    expect(chooseTools(SPECS, hints('Who wrote Things Fall Apart?', 'chat', []), carried).tools).toEqual([]);
    expect(chooseTools(SPECS, hints("What's my name?", 'other', []), carried).tools).toEqual([]); // short, but a question of its own
    expect(names(chooseTools(SPECS, hints('and for Chrome', 'other', []), carried).tools)).toEqual(['set_timer']);
  });

  it(`at most ${MOST_TOOLS}`, () => {
    const many = SPECS.map((s, i) => [s.name, 0.5 - i * 0.001] as [string, number]);
    expect(chooseTools(SPECS, hints('Open Safari and play jazz and dim the screen on my window', 'open_app', many), ['set_timer', 'files']).tools).toHaveLength(MOST_TOOLS);
  });
});

describe("Apple's instructions", () => {
  it('speak only of the tools it has, and of notes only when there are some', () => {
    const plain = appleInstructions('Nova', 'auto', []);
    expect(plain).toMatch(/no tools for this question/);
    expect(plain).not.toMatch(/remember|look_at_screen|calculate|\[Notes/);
    const tooled = appleInstructions('Nova', 'auto', ['remember', 'look_at_screen', 'calculate'], { notes: true, several: true });
    expect(tooled).toMatch(/call remember/);
    expect(tooled).toMatch(/call look_at_screen/);
    expect(tooled).toMatch(/with calculate/);
    expect(tooled).toMatch(/between \[Notes \.\.\.\] and \[End of notes\]/);
    expect(tooled).toMatch(/a tool for each of them/);
    expect(tooled).toMatch(/Don't end a reply by offering more/); // the user's Permissions
    expect(appleInstructions('Jarvis', 'free', ['remember'])).toMatch(/You are Jarvis.*Apple Intelligence[\s\S]*told Jarvis not to ask/);
  });
});

describe('what is said', () => {
  const pieces = async function* (...texts: string[]) {
    yield* texts;
  };
  const all = async (it: AsyncIterable<string>) => {
    let text = '';
    for await (const piece of it) text += piece;
    return text;
  };

  it("leaves out notes the model writes itself before its answer, however they arrive", async () => {
    expect(await all(spoken(pieces('[Notes: the user', ' asks about rivers.]\n', 'The Nile', ' is longest.')))).toBe('The Nile is longest.');
    expect(await all(spoken(pieces('The Nile [the longest] is ', 'in Africa.')))).toBe('The Nile [the longest] is in Africa.');
    expect(await all(spoken(pieces('  ', 'Sure.')))).toBe('  Sure.');
    expect(await all(spoken(pieces(`[${'x'.repeat(500)}`)))).toBe(`[${'x'.repeat(500)}`); // not notes after all
  });
});

describe('AppleBrain', () => {
  const fakeModel = () => {
    const asked: unknown[] = [];
    const model = { ask: (q: unknown) => (asked.push(q), (async function* () { yield 'Done.'; })()), status: async () => ({ state: 'ready' }), warm: () => {} } as unknown as AppleModel;
    return { model, asked };
  };
  const history = [
    { user: 'My name is Manuel.', nova: 'Nice to meet you, Manuel.' },
    { user: 'Open Slack.', nova: 'Opening Slack.' },
    { user: 'Set a timer for 5 minutes.', nova: 'Timer set for 5 minutes.' },
  ];

  it("asked to act: the last two turns as turns, and a tool before any answer", () => {
    const brain = new AppleBrain(fakeModel().model, { tools: { specs: () => SPECS, call: async () => 'ok' } });
    const q = brain.question('Open Safari and play some jazz', history, hints('Open Safari and play some jazz', 'open_app', [['open_app', 1], ['media_control', 0.001]]));
    expect(q.act).toBe(true);
    expect(q.history).toEqual(history.slice(-2));
    expect(q.context).toBeUndefined();
    expect(names(q.tools)).toEqual(['open_app', 'media_control']);
    expect(q.prompt).toMatch(/^\(It's .*\)\nOpen Safari and play some jazz$/);
  });

  it('otherwise the conversation as context - what it remembers best from', () => {
    const brain = new AppleBrain(fakeModel().model, { tools: { specs: () => SPECS, call: async () => 'ok' }, assistant: 'Nova' });
    const q = brain.question("What's my name?", history, hints("What's my name?", 'other', [['recall', 0.02]]));
    expect(q.act).toBe(false);
    expect(q.history).toEqual([]);
    expect(q.context?.turns[0]).toBe('User: My name is Manuel.\nNova: Nice to meet you, Manuel.');
    expect(q.context?.note).toMatch(/for context only/);
  });

  it('works out sums with the calculator, in code', async () => {
    const calls: string[] = [];
    let run: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | undefined;
    const model = { ask: (q: { tools: ToolSpec[] }, r: typeof run) => ((run = r), calls.push(...names(q.tools)), (async function* () { yield 'The result is 433.'; })()) } as unknown as AppleModel;
    const brain = new AppleBrain(model, {});
    for await (const _ of brain.stream("What's 23 times 19 minus 4?", [], undefined, hints("What's 23 times 19 minus 4?", 'chat', []))) void _;
    expect(calls).toEqual([CALCULATOR.name]);
    expect(await run!('calculate', { expression: '23 * 19 - 4' })).toBe('23 * 19 - 4 = 433');
  });

  it("says Okay to a yes or no when it asked nothing - without asking the model", async () => {
    const { model, asked } = fakeModel();
    const brain = new AppleBrain(model, {});
    let text = '';
    for await (const piece of brain.stream('yes please', history, undefined, hints('yes please', 'confirm_yes', []))) text += piece;
    expect(text).toBe('Okay.');
    expect(asked).toHaveLength(0);
    for await (const _ of brain.stream('yes please', [...history, { user: 'Remind me later', nova: 'Want me to set it for 5?' }], undefined, hints('yes please', 'confirm_yes', []))) void _;
    expect(asked).toHaveLength(1);
  });

  it("is Apple Intelligence, can't use the computer, and takes a few tools at a time", () => {
    const brain = new AppleBrain(fakeModel().model, {});
    expect(brain).toMatchObject({ name: APPLE_LABEL, usesComputer: false, fewTools: true });
  });
});

describe("the link to Apple's model", () => {
  let model: AppleModel | undefined;
  afterEach(() => model?.close());
  const start = () => {
    const changes: unknown[] = [];
    model = new AppleModel({ command: async () => ({ command: process.execPath, args: [FAKE] }), cantRun: () => null, changed: (s) => changes.push(s) });
    return { model, changes };
  };
  const question = (prompt: string, act = false) => ({ instructions: 'Be brief.', history: [], prompt, tools: [SPECS[0]!], act });
  const read = async (it: AsyncIterable<string>) => {
    let text = '';
    for await (const piece of it) text += piece;
    return text;
  };

  it('knows whether this Mac can answer, and says when that changes', async () => {
    const { model, changes } = start();
    expect(model.known.state).toBe('checking');
    expect(await model.status()).toEqual({ state: 'ready', model: 'AFM 3 Core Advanced', contextSize: 8192, vision: true });
    expect(await model.status()).toBe(model.known); // asked again only after a minute
    expect(changes).toHaveLength(1);
  });

  it("puts the Mac's reasons into Settings' words", () => {
    expect(statusFrom({ type: 'status', available: false, reason: 'off' })).toEqual({ state: 'unavailable', reason: 'off' });
    expect(statusFrom({ type: 'status', available: false, reason: 'something new' })).toMatchObject({ reason: 'failed' });
    expect(cantRunHere({ platform: 'linux', arch: 'x64', release: '6.1' })).toBe('system');
    expect(cantRunHere({ platform: 'darwin', arch: 'x64', release: '25.0.0' })).toBe('device');
    expect(cantRunHere({ platform: 'darwin', arch: 'arm64', release: '24.6.0' })).toBe('system');
    expect(cantRunHere({ platform: 'darwin', arch: 'arm64', release: '27.0.0' })).toBeNull();
  });

  it('streams an answer, one question at a time', async () => {
    const { model } = start();
    const [a, b] = await Promise.all([read(model.ask(question('hi'), async () => '')), read(model.ask(question('again', true), async () => ''))]);
    expect(a).toBe('Hello there.');
    expect(b).toBe('Hello there. (acting)');
  });

  it("runs the model's tool calls through Nova, with a picture only for a model that can see", async () => {
    const { model } = start();
    await model.status();
    const ran: string[] = [];
    const answer = await read(model.ask(question('use open_app'), async (name, args) => (ran.push(`${name} ${JSON.stringify(args)}`), { text: 'Opened Safari.', image: { data: 'aGk=', mimeType: 'image/png' } })));
    expect(ran).toEqual(['open_app {"request":"something"}']);
    expect(answer).toBe('It said: Opened Safari. (with a picture)');
  });

  it('fails in words Nova can say', async () => {
    const { model } = start();
    await expect(read(model.ask(question('fail guardrail'), async () => ''))).rejects.toThrow(/its safety rules stopped it/);
    await expect(read(model.ask(question('fail context'), async () => ''))).rejects.toBeInstanceOf(AppleModelError);
  });

  it("says why it's unavailable - and asks the Mac again, so Settings knows", async () => {
    const { model, changes } = start();
    await model.status();
    await expect(read(model.ask(question('unavailable off'), async () => ''))).rejects.toThrow(/Apple Intelligence is off - turn it on in System Settings/);
    await new Promise((r) => setTimeout(r, 100));
    expect(changes).toHaveLength(2); // asked again at once
  });

  it("fails at once on a Mac that can't run it", async () => {
    model = new AppleModel({ command: async () => ({ command: process.execPath, args: [FAKE] }), cantRun: () => 'device' });
    await expect(read(model.ask(question('hi'), async () => ''))).rejects.toThrow("This Mac can't run Apple Intelligence.");
    expect(await model.status()).toEqual({ state: 'unavailable', reason: 'device' });
  });

  it('stops a question when told, and the next one still gets its answer', async () => {
    const { model } = start();
    const stop = new AbortController();
    const hanging = read(model.ask(question('hang'), async () => '', stop.signal));
    setTimeout(() => stop.abort(), 50);
    await expect(hanging).rejects.toThrow('Stopped.');
    expect(await read(model.ask(question('hi'), async () => ''))).toBe('Hello there.');
  });

  it('ends the question when the helper stops, and starts it again for the next', async () => {
    const { model } = start();
    await expect(read(model.ask(question('quit'), async () => ''))).rejects.toThrow("Apple's model stopped.");
    expect(await read(model.ask(question('hi'), async () => ''))).toBe('Hello there.');
  });

  it("says why when the helper can't be set up", async () => {
    model = new AppleModel({ command: async () => Promise.reject(new Error('no swift')), cantRun: () => null });
    expect(await model.status()).toMatchObject({ state: 'unavailable', reason: 'build', message: 'no swift' });
    await expect(read(model.ask(question('hi'), async () => ''))).rejects.toThrow(/couldn't set up its helper/);
  });
});
