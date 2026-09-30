import { describe, expect, it } from 'vitest';
import {
  describeCall,
  EvaluationDecisionEngine,
  HeuristicEvaluationModel,
  NovaBrain,
  settingProblem,
  toolName,
  policyTier,
  toolPolicy,
  toolRisk,
  type IntegrationTool,
  type IntegrationTools,
  type Platform,
  type TrustService,
  type ReasoningBrain,
  type ServerEvent,
} from '../src/index.ts';

describe('integration settings', () => {
  it('take a hosted url or a local command, and keep secrets in .env', () => {
    expect(settingProblem('integrations.servers.linear', { url: 'https://mcp.linear.app/mcp' })).toBeNull();
    expect(settingProblem('integrations.servers.notes', { command: 'npx', args: ['-y', 'notes-mcp'], env: { TOKEN: '${NOVA_NOTES_TOKEN}' } })).toBeNull();
    expect(settingProblem('integrations.servers.both', { url: 'https://x.dev/mcp', command: 'npx' })).toMatch(/either a url or a command/);
    expect(settingProblem('integrations.servers.Bad Name', { url: 'https://x.dev/mcp' })).toMatch(/lower-case/);
    expect(settingProblem('integrations.servers.gh', { url: 'https://x.dev/mcp', headers: { Authorization: 'Bearer ghp_abcdefghijklmnopqrstuvwxyz123456' } })).toMatch(/secret.*\.env/);
    expect(settingProblem('integrations.servers.gh', { url: 'https://x.dev/mcp', headers: { Authorization: 'Bearer ${NOVA_GITHUB_TOKEN}' } })).toBeNull();
    expect(settingProblem('integrations.servers.gh', { url: 'https://x.dev/mcp', ask: 'sometimes' })).toMatch(/always, changes, never/);
    expect(settingProblem('integrations.servers.gh', { url: 'https://x.dev/mcp', tools: { delete_repo: 'block', search: 'allow' } })).toBeNull();
  });

  it('keep pasted secrets out of args and the url too', () => {
    const local = (args: string[]) => settingProblem('integrations.servers.x', { command: 'npx', args });
    const hosted = (url: string) => settingProblem('integrations.servers.x', { url });
    expect(local(['-y', 'some-server', '--token', 'ghp_abcdefghijklmnopqrstuvwxyz123456'])).toMatch(/secret in args.*\.env/);
    expect(local(['--api-key=sk_live_51abcdefghijklmnop'])).toMatch(/secret in args/);
    expect(local(['-y', 'server', 'sk-ant-abc123def456ghi789'])).toMatch(/secret in args/);
    expect(local(['-y', 'server', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'])).toMatch(/secret in args/);
    for (const fine of [
      ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me/dev'],
      ['-y', 'mcp-server-sequential-thinking'],
      ['--token', '${NOVA_NOTES_TOKEN}'],
      ['--key-file', './keys/service.json'],
      ['--project-id', '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b'],
      ['--port', '3000'],
    ]) {
      expect(local(fine), fine.join(' ')).toBeNull();
    }
    expect(hosted('https://mcp.example.com/mcp?api_key=abc123def456')).toMatch(/secret in the url.*header/);
    expect(hosted('https://me:hunter2@mcp.example.com/mcp')).toMatch(/secret in the url/);
    expect(hosted('https://mcp.zapier.com/api/mcp/s/NmQyYjk5ZTQtOGM0Zi00ZmI2LWIzNzAtZjU0ZDg2ZWFkMTQ5OjE3/mcp')).toMatch(/secret in the url/);
    for (const fine of ['https://mcp.notion.com/mcp', 'https://api.githubcopilot.com/mcp/', 'https://mcp.example.com/mcp?workspace=acme&format=json', 'https://mcp.example.com/v1/3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b/mcp']) {
      expect(hosted(fine), fine).toBeNull();
    }
  });

  it('decide per tool, from what the user chose', () => {
    const tool = (name: string, readOnly = false) => ({ name, readOnly });
    expect(toolPolicy({}, tool('search', true))).toBe('ask'); // asks before everything unless told otherwise
    expect(toolPolicy({ ask: 'changes' }, tool('search', true))).toBe('allow');
    expect(toolPolicy({ ask: 'changes' }, tool('create_issue'))).toBe('ask');
    expect(toolPolicy({ ask: 'never', tools: { delete_repo: 'block' } }, tool('delete_repo'))).toBe('block');
    expect(toolName('Linear', 'create issue!')).toBe('linear__create_issue');
    expect(toolName('a'.repeat(40), 'b'.repeat(40))).toHaveLength(64);
  });

  it('keep money behind a tap, and a blanket rule never covers it', () => {
    const tool = (name: string, readOnly = false) => ({ name, readOnly });
    expect(policyTier('ask', 'create_refund')).toBe(3);
    expect(policyTier('ask', 'stripe__finalize_invoice')).toBe(3);
    expect(policyTier('ask', 'list_refunds')).toBe(2); // reading them moves nothing
    expect(policyTier('ask', 'create_issue')).toBe(2);
    expect(policyTier('allow', 'create_refund')).toBe(1); // the user allowed that very tool
    expect(policyTier('ask')).toBe(2);
    expect(toolPolicy({ ask: 'never' }, tool('create_refund'))).toBe('ask');
    expect(toolPolicy({ ask: 'never', tools: { create_refund: 'allow' } }, tool('create_refund'))).toBe('allow');
    expect(toolPolicy({ ask: 'never' }, tool('create_issue'))).toBe('allow');
    // A read-only label counts under "changes" - unless the tool's own name says it runs SQL, sends or moves money.
    expect(toolPolicy({ ask: 'changes' }, tool('execute_sql', true))).toBe('ask');
    expect(toolPolicy({ ask: 'changes' }, tool('send_message', true))).toBe('ask');
    expect(toolPolicy({ ask: 'changes' }, tool('search_issues', true))).toBe('allow');
    expect([toolRisk('stripe__create_refund'), toolRisk('supabase__execute_sql'), toolRisk('gmail__send_message'), toolRisk('gmail__trash_message'), toolRisk('linear__find_issues')]).toEqual([
      'money',
      'code',
      'send',
      'delete',
      null,
    ]);
  });
});

describe('what a call does, said out loud', () => {
  it('says every argument that matters - amounts, recipients, targets - and sums up long ones', () => {
    expect(describeCall('Linear', 'createIssue', { title: 'Fix the login bug', teamId: 'x'.repeat(90) })).toBe('Linear: create issue "Fix the login bug" with team id "xxxxxxxxxxxx…"');
    expect(describeCall('Notes', 'add_note', { text: 'bread' })).toBe('Notes: add note "bread"');
    expect(describeCall('Stripe', 'create_refund', { payment_intent: 'pi_3NqLx2', amount: 250000, reason: 'requested_by_customer' })).toBe(
      'Stripe: create refund with payment intent "pi_3NqLx2", amount 250,000 and reason "requested_by_customer"',
    );
    expect(
      describeCall('Gmail', 'send_message', {
        body: 'Hi Bob, please find the invoice attached. Let me know if you have any questions about it at all.',
        to: ['bob@example.com', 'eve@example.com'],
        subject: 'Invoice',
        draft: false,
      }),
    ).toBe('Gmail: send message "Invoice" to "bob@example.com" and "eve@example.com" with body "Hi Bob, please find the invoice attached. Let me know if…" and draft no');
    expect(describeCall('Supabase', 'execute_sql', { query: 'DELETE FROM users WHERE created_at < now()', project_id: 'abc' })).toBe(
      'Supabase: execute sql "DELETE FROM users WHERE created_at < now()" with project id "abc"',
    );
    expect(describeCall('Shop', 'create_order', { items: [{ sku: 'a' }, { sku: 'b' }], shipping: { city: 'Accra', street: 'Oxford St' } })).toBe('Shop: create order with 2 items and shipping (2 details)');
  });
});

describe('integration tools in the brain', () => {
  it("are offered to every brain, and the ones the user didn't allow are confirmed out loud first", async () => {
    const events: ServerEvent[] = [];
    const calls: string[] = [];
    const tool = (name: string, tier: 1 | 2): IntegrationTool => ({
      name,
      label: 'Linear',
      tier,
      description: `Linear: ${name}`,
      parameters: { type: 'object', properties: { title: { type: 'string' } }, required: [] },
      summary: (args) => describeCall('Linear', name.split('__')[1]!, args),
    });
    const integrations: IntegrationTools = {
      specs: () => [tool('linear__find_issues', 1), tool('linear__create_issue', 2)],
      call: async (name, args) => (calls.push(`${name} ${JSON.stringify(args)}`), 'Done.'),
    };
    const platform: Platform = { listApps: async () => [], openApp: async () => {}, quitApp: async () => {}, now: () => new Date() };
    const brain: ReasoningBrain = { name: 'Brain', reply: async () => 'ok' };
    const engine = new EvaluationDecisionEngine({ name: 'heuristic', model: new HeuristicEvaluationModel() });
    const nova = new NovaBrain({ engine, platform, emit: (e) => events.push(e), reasoning: brain, integrations });
    await nova.init();
    expect(nova.specs().map((t) => t.name)).toEqual(expect.arrayContaining(['open_app', 'linear__find_issues', 'linear__create_issue']));

    expect(await nova.call('linear__find_issues', { title: 'login' }, 'Claude')).toBe('Done.'); // allowed: no question
    const asking = nova.call('linear__create_issue', { title: 'Fix the login bug' }, 'Codex');
    await new Promise((r) => setTimeout(r, 0));
    const said = events.filter((e): e is Extract<ServerEvent, { type: 'say' }> => e.type === 'say').at(-1);
    expect(said?.text).toBe('Codex wants to use Linear: create issue "Fix the login bug". Allow it?');
    await nova.handle('no');
    expect(await asking).toMatch(/said no/);
    expect(calls).toEqual(['linear__find_issues {"title":"login"}']);
    expect(await nova.call('linear__delete_everything', {}, 'Claude')).toMatch(/no tool/);
  });

  it('never moves money on a spoken yes, and keeps "yes, always" for tools that only read', async () => {
    const events: ServerEvent[] = [];
    const calls: string[] = [];
    const rules = new Map<string, string>();
    const tool = (name: string, readOnly = false): IntegrationTool => ({
      name,
      label: name.startsWith('stripe') ? 'Stripe' : 'Linear',
      tier: 2, // as a hub that doesn't know about money sets it
      readOnly,
      description: name,
      parameters: { type: 'object', properties: {}, required: [] },
      summary: (args) => describeCall(name.startsWith('stripe') ? 'Stripe' : 'Linear', name.split('__')[1]!, args),
    });
    const integrations: IntegrationTools = {
      specs: () => [tool('linear__find_issues', true), tool('linear__create_issue'), tool('stripe__create_refund'), tool('stripe__list_refunds', true)],
      call: async (name) => (calls.push(name), 'Done.'),
    };
    const trust: TrustService = { allows: (key) => rules.has(key), allow: async (key, label) => void rules.set(key, label), list: () => [] };
    const platform: Platform = { listApps: async () => [], openApp: async () => {}, quitApp: async () => {}, now: () => new Date() };
    const engine = new EvaluationDecisionEngine({ name: 'heuristic', model: new HeuristicEvaluationModel() });
    const nova = new NovaBrain({ engine, platform, emit: (e) => events.push(e), reasoning: { name: 'Brain', reply: async () => 'ok' }, integrations, trust });
    await nova.init();
    const said = () => events.filter((e): e is Extract<ServerEvent, { type: 'say' }> => e.type === 'say').at(-1)?.text;
    const tick = () => new Promise((r) => setTimeout(r, 0));

    // Moving money needs a tap - on the Mac's screen, or Face ID on the iPhone - however the tool was set up; a spoken
    // yes never does it.
    const paying = nova.call('stripe__create_refund', { amount: 250000 }, 'Claude');
    await tick();
    const tap = events.filter((e): e is Extract<ServerEvent, { type: 'card' }> => e.type === 'card').at(-1)!.card;
    expect(tap).toMatchObject({ kind: 'confirm', tap: true });
    expect(said()).toMatch(/Stripe.*needs a tap/);
    await nova.handle('yes');
    expect(said()).toMatch(/needs a tap/);
    expect(calls).toEqual([]);
    expect(nova.tapAnswer(tap.id, true)).toBe(true);
    expect(await paying).toBe('Done.');

    // A tool that only reads: "yes, always" sticks.
    let asking = nova.call('linear__find_issues', { query: 'login' }, 'Claude');
    await tick();
    expect(said()).toBe('Claude wants to use Linear: find issues "login". Allow it?');
    await nova.handle('yes, always');
    expect(await asking).toBe('Done.');
    expect([...rules.keys()]).toEqual(['tool:linear__find_issues']);
    expect(await nova.call('linear__find_issues', { query: 'signup' }, 'Claude')).toBe('Done.'); // not asked again

    // One that changes something: allowed this once, and Nova says it will ask again.
    asking = nova.call('linear__create_issue', { title: 'Fix the login bug' }, 'Claude');
    await tick();
    await nova.handle('yes, always');
    expect(await asking).toBe('Done.');
    expect(said()).toMatch(/still ask/);
    expect([...rules.keys()]).toEqual(['tool:linear__find_issues']);
    expect(calls).toEqual(['stripe__create_refund', 'linear__find_issues', 'linear__find_issues', 'linear__create_issue']);
  });
});
