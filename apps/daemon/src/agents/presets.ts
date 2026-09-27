import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { voiceSystemPrompt } from '@nova/core';
import { claudeMcpConfig, type McpServer } from './bridge.ts';

/** How to read an agent's output stream. */
export type OutputFormat = 'claude' | 'codex' | 'opencode' | 'text';

/** One command line: arguments, plus the prompt on stdin or as the final argument after "--". */
export interface Invocation {
  args: string[];
  stdin?: string;
  trailing?: string;
  /** Extra environment variables for this run. */
  env?: Record<string, string>;
}

/** Hands an agent's permission prompts to Nova (Claude Code: through an MCP tool). */
export interface ApprovalHookup {
  mcpConfig: string;
  tool: string;
}

export interface InvocationOptions {
  model?: string;
  /** The assistant's name, as the agent should know it. */
  assistant: string;
  /** Nova's tools, as an MCP server the agent's CLI can start. */
  tools?: McpServer;
}

export interface AgentPreset {
  label: string;
  bin: string;
  output: OutputFormat;
  /** Answer a question - with Nova's tools when given - saving nothing. */
  ask(prompt: string, opts: InvocationOptions): Invocation;
  /**
   * A conversation that keeps running: questions go in on stdin one per line and answers stream
   * out, so the CLI isn't started for every question. Only for CLIs that can do it.
   */
  session?(opts: InvocationOptions): Invocation;
  /** Work on a task in the current folder. */
  task(prompt: string, opts: InvocationOptions & { approvals?: ApprovalHookup }): Invocation;
  /** Can hand its permission prompts to Nova, so risky steps are asked out loud. */
  approvals?: boolean;
  /** Environment variables to drop so it bills the signed-in plan. */
  dropEnv?: RegExp;
}

/** Appended to every task, so the result comes back in a shape the assistant can speak. */
export const taskNote = (assistant: string) =>
  `You were given this task by voice through ${assistant}, the user's assistant, and you are working in the current folder. ` +
  'When you finish, end with a one or two sentence summary of what you did, written to be read aloud.';

/** What Claude may do without asking: read and search, and look at git. Edits inside the project are auto-approved. */
const CLAUDE_SAFE_TOOLS = 'Read,Glob,Grep,TodoWrite,Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(ls:*)';

const flag = (name: string, value?: string) => (value ? [name, value] : []);

// How each CLI is given Nova's tools. MCP is the common ground; only the way in differs.

/** Claude Code: only Nova's MCP server (never the user's others), its tools allowed, plus read-only web tools. */
const claudeAnswerArgs = (tools?: McpServer) => [
  '--tools', 'WebSearch,WebFetch',
  '--allowedTools', ['WebSearch', 'WebFetch', ...(tools ? [`mcp__${tools.name}`] : [])].join(','),
  '--strict-mcp-config',
  ...(tools ? ['--mcp-config', claudeMcpConfig(tools)] : []),
  '--setting-sources', '', '--no-session-persistence',
];

/** Codex: config overrides on the command line; ~/.codex/config.toml is left alone. */
const codexTools = (tools?: McpServer) =>
  tools
    ? [
        '-c', `mcp_servers.${tools.name}.command=${JSON.stringify(tools.command)}`,
        '-c', `mcp_servers.${tools.name}.args=${JSON.stringify(tools.args)}`,
        '-c', `mcp_servers.${tools.name}.env={${Object.entries(tools.env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',')}}`,
      ]
    : [];

/** OpenCode: an extra config file (OPENCODE_CONFIG), private to the user; one per tools hookup. */
const opencodeConfigs = new Map<string, string>();
function opencodeTools(tools?: McpServer): Record<string, string> | undefined {
  if (!tools) return undefined;
  const key = JSON.stringify(tools.env);
  let file = opencodeConfigs.get(key);
  if (!file) {
    file = join(mkdtempSync(join(tmpdir(), 'nova-opencode-')), 'opencode.json');
    const mcp = { [tools.name]: { type: 'local', command: [tools.command, ...tools.args], environment: tools.env, enabled: true } };
    writeFileSync(file, JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp }), { mode: 0o600 });
    opencodeConfigs.set(key, file);
  }
  return { OPENCODE_CONFIG: file };
}

/**
 * Built-in agents. Each runs its vendor's official, unmodified CLI in non-interactive
 * mode, signed in with the user's own account - Nova never handles their credentials.
 */
export const PRESETS: Record<string, AgentPreset> = {
  claude: {
    label: 'Claude',
    bin: 'claude',
    output: 'claude',
    approvals: true,
    dropEnv: /^ANTHROPIC_/, // bill the signed-in Claude plan, never an API key
    ask: (prompt, { model, assistant, tools }) => ({
      args: [
        '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--system-prompt', voiceSystemPrompt(assistant),
        ...claudeAnswerArgs(tools),
        ...flag('--model', model),
      ],
      stdin: prompt,
    }),
    session: ({ model, assistant, tools }) => ({
      args: [
        '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--system-prompt', voiceSystemPrompt(assistant),
        ...claudeAnswerArgs(tools),
        ...flag('--model', model),
      ],
    }),
    task: (prompt, { model, approvals, assistant }) => ({
      args: [
        '-p', '--output-format', 'stream-json', '--verbose',
        '--append-system-prompt', taskNote(assistant),
        // The project's own Claude settings apply, user-level ones don't: those can reroute Claude
        // through an API gateway (e.g. ANTHROPIC_BASE_URL), and tasks should run on the signed-in plan.
        '--setting-sources', 'project,local',
        '--permission-mode', 'acceptEdits',
        '--allowedTools', CLAUDE_SAFE_TOOLS,
        '--strict-mcp-config',
        // Everything else Claude wants to do (shell commands, web) is asked out loud through Nova.
        ...(approvals ? ['--mcp-config', approvals.mcpConfig, '--permission-prompt-tool', approvals.tool] : ['--permission-prompts', 'none']),
        ...flag('--model', model),
      ],
      stdin: prompt,
    }),
  },
  codex: {
    label: 'Codex',
    bin: 'codex',
    output: 'codex',
    ask: (prompt, { model, assistant, tools }) => ({
      args: ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', ...codexTools(tools), ...flag('-m', model)],
      stdin: `${voiceSystemPrompt(assistant)}\n\n${prompt}`,
    }),
    // Non-interactive Codex can't hand approvals over; its workspace sandbox keeps writes inside the project.
    task: (prompt, { model, assistant }) => ({
      args: ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--color', 'never', ...flag('-m', model)],
      stdin: `${prompt}\n\n${taskNote(assistant)}`,
    }),
  },
  opencode: {
    label: 'OpenCode',
    bin: 'opencode',
    output: 'opencode',
    ask: (prompt, { model, assistant, tools }) => ({
      args: ['run', '--format', 'json', '--agent', 'plan', ...flag('-m', model)],
      trailing: `${voiceSystemPrompt(assistant)}\n\n${prompt}`,
      env: opencodeTools(tools),
    }),
    task: (prompt, { model, assistant }) => ({ args: ['run', '--format', 'json', ...flag('-m', model)], trailing: `${prompt}\n\n${taskNote(assistant)}` }),
  },
  gemini: {
    label: 'Gemini',
    bin: 'gemini',
    output: 'text',
    ask: (prompt, { model, assistant }) => ({ args: [...flag('-m', model)], stdin: `${voiceSystemPrompt(assistant)}\n\n${prompt}` }),
    task: (prompt, { model, assistant }) => ({ args: ['--approval-mode', 'auto_edit', ...flag('-m', model)], stdin: `${prompt}\n\n${taskNote(assistant)}` }),
  },
};

/** A custom agent from nova.agents.json or Settings. */
export interface CustomAgentSpec {
  label?: string;
  command: string;
  /** Arguments for questions and for tasks. "{prompt}" is filled in (without it the prompt goes to stdin); an argument containing "{model}" is dropped when no model is set. */
  ask: string[];
  task: string[];
  output?: OutputFormat;
  /** Arguments that give it Nova's tools, when its CLI takes an MCP config: "{mcpConfig}" becomes Claude-style MCP JSON. */
  mcp?: string[];
}

export function customPreset(name: string, spec: CustomAgentSpec): AgentPreset {
  const fill = (args: string[], prompt: string, model?: string): Invocation => ({
    args: args.flatMap((a) => (a.includes('{model}') && !model ? [] : [a.replaceAll('{prompt}', prompt).replaceAll('{model}', model ?? '')])),
    stdin: args.some((a) => a.includes('{prompt}')) ? undefined : prompt,
  });
  return {
    label: spec.label ?? name,
    bin: spec.command,
    output: spec.output ?? 'text',
    ask: (prompt, { model, assistant, tools }) => {
      const invocation = fill(spec.ask, `${voiceSystemPrompt(assistant)}\n\n${prompt}`, model);
      if (tools && spec.mcp) invocation.args = [...spec.mcp.map((a) => a.replaceAll('{mcpConfig}', claudeMcpConfig(tools))), ...invocation.args];
      return invocation;
    },
    task: (prompt, { model, assistant }) => fill(spec.task, `${prompt}\n\n${taskNote(assistant)}`, model),
  };
}
