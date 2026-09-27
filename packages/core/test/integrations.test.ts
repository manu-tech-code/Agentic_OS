import { describe, expect, it } from 'vitest';
import {
  describeCall,
  EvaluationDecisionEngine,
  HeuristicEvaluationModel,
  NovaBrain,
  settingProblem,
  toolName,
  toolPolicy,
  type IntegrationTool,
  type IntegrationTools,
  type Platform,
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

  it('decide per tool, from what the user chose', () => {
    const tool = (name: string, readOnly = false) => ({ name, readOnly });
    expect(toolPolicy({}, tool('search', true))).toBe('ask'); // asks before everything unless told otherwise
    expect(toolPolicy({ ask: 'changes' }, tool('search', true))).toBe('allow');
    expect(toolPolicy({ ask: 'changes' }, tool('create_issue'))).toBe('ask');
    expect(toolPolicy({ ask: 'never', tools: { delete_repo: 'block' } }, tool('delete_repo'))).toBe('block');
    expect(toolName('Linear', 'create issue!')).toBe('linear__create_issue');
    expect(toolName('a'.repeat(40), 'b'.repeat(40))).toHaveLength(64);
    expect(describeCall('Linear', 'createIssue', { title: 'Fix the login bug', teamId: 'x'.repeat(90) })).toBe('Linear: create issue "Fix the login bug"');
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
});
