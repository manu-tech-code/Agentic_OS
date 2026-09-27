import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { withTime, type AgentHost, type ReasoningBrain, type TaskCallbacks, type Turn } from '@nova/core';
import type { Bridge } from './bridge.ts';
import { approvalDetail, describeAction, outputReader, tooLongToSay } from './parsers.ts';
import { customPreset, PRESETS, type AgentPreset, type CustomAgentSpec, type Invocation } from './presets.ts';
import { AgentSession } from './session.ts';
import { channel } from './stream.ts';

export interface AgentHostOptions {
  /** Agent names in order, default first; null = every known agent that is installed. */
  names: string[] | null;
  custom: Record<string, CustomAgentSpec>;
  /** Named folders, plus every folder inside projectsDir. */
  projects: Record<string, string>;
  projectsDir: string;
  /** Per agent, from Settings. */
  options: Record<string, AgentOptions>;
  /** Carries Claude's permission prompts during tasks, and Nova's tools to agents answering questions. */
  bridge: Bridge | null;
  taskTimeoutMs: number;
  /** The assistant's name, as agents should know it. */
  assistant: string;
}

/** How one agent runs: its model, extra CLI arguments, and where its CLI is when it isn't on PATH. */
export interface AgentOptions {
  model?: string;
  args: string[];
  bin?: string;
}

export type NovaAgentHost = Omit<AgentHost, 'brain'> & {
  /** An agent as a brain for open questions: with Nova's tools, streaming, kept running when its CLI allows. */
  brain(name: string): ReasoningBrain & { warm?(): void };
  /** Stop the agents kept running. */
  close(): void;
  /** Restart the agents kept running, between questions, so they see what changed (new integration tools). */
  refresh(): void;
  /** A project's folder, by name - only ever one from Settings. */
  projectPath(name: string): string | undefined;
};

interface Agent {
  name: string;
  preset: AgentPreset;
  bin: string;
  model?: string;
  extraArgs: string[];
}

/**
 * What an agent gets from Nova's environment: what a CLI needs to run and to find the user's own
 * sign-in (home, user, the CLIs' config folders, locale, proxy, SSH agent) - never a key. API keys
 * (OPENAI_API_KEY, GEMINI_API_KEY, ...), .env secrets and Nova's settings would bill an account
 * instead of the plan, or reach an agent they aren't for.
 */
const AGENT_ENV =
  /^(?:PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|TERM_PROGRAM|COLORTERM|NO_COLOR|FORCE_COLOR|__CF_USER_TEXT_ENCODING|SSH_AUTH_SOCK|XDG_[A-Z_]+|CLAUDE_CONFIG_DIR|CODEX_HOME|OPENCODE_CONFIG_DIR|GOOGLE_CLOUD_PROJECT|GOOGLE_CLOUD_LOCATION|(?:HTTPS?|ALL|NO)_PROXY|(?:https?|all|no)_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_(?:FILE|DIR))$/;

export function agentEnv(drop: RegExp | undefined, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (AGENT_ENV.test(k) && !drop?.test(k)) env[k] = v;
  return { ...env, ...extra };
}

const expand = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/** An executable on PATH, or an explicit path that exists. */
async function which(bin: string): Promise<string | null> {
  const candidates = bin.includes('/') ? [expand(bin)] : (process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, bin));
  for (const c of candidates) {
    try {
      await access(c, constants.X_OK);
      return c;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Project folders by name: every folder inside `dir`, plus named ones. */
export async function findProjects(dir: string, named: Record<string, string>): Promise<Map<string, string>> {
  const projects = new Map<string, string>();
  if (dir) {
    const root = expand(dir);
    for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory() && !e.name.startsWith('.')) projects.set(e.name, join(root, e.name));
    }
  }
  for (const [name, path] of Object.entries(named)) projects.set(name, resolve(expand(path)));
  return projects;
}

function withHistory(question: string, history: Turn[], assistant: string) {
  if (!history.length) return question;
  return `Conversation so far:\n${history.map((t) => `User: ${t.user}\n${assistant}: ${t.nova}`).join('\n')}\n\nUser: ${question}`;
}

function allPresets(custom: Record<string, CustomAgentSpec>): Record<string, AgentPreset> {
  const presets: Record<string, AgentPreset> = { ...PRESETS };
  for (const [name, spec] of Object.entries(custom)) presets[name] = customPreset(name, spec);
  return presets;
}

/** Every agent Nova knows - built in or custom - and where its CLI is installed, for Settings. */
export async function agentCandidates(custom: Record<string, CustomAgentSpec>, options: AgentHostOptions['options']) {
  return Promise.all(
    Object.entries(allPresets(custom)).map(async ([name, preset]) => {
      const bin = (Object.hasOwn(options, name) && options[name]?.bin) || preset.bin;
      return { name, label: preset.label, bin, path: await which(bin), custom: !(name in PRESETS) };
    }),
  );
}

/**
 * Pairs Nova with the agent CLIs installed on this machine. Folders come only from
 * config (named projects plus the projects directory) - never from speech or agent output.
 */
export async function createAgentHost(opts: AgentHostOptions): Promise<NovaAgentHost | null> {
  const presets = allPresets(opts.custom);

  const agents: Agent[] = [];
  for (const name of opts.names ?? Object.keys(presets)) {
    const preset = presets[name];
    if (!preset) {
      console.warn(`[agents] no agent called "${name}" - add it in Settings → Agents or nova.agents.json`);
      continue;
    }
    const options = Object.hasOwn(opts.options, name) ? opts.options[name] : undefined;
    const bin = await which(options?.bin || preset.bin);
    if (!bin) {
      if (opts.names) console.warn(`[agents] "${name}" is listed but ${preset.bin} isn't installed`);
      continue;
    }
    agents.push({ name, preset, bin, model: options?.model, extraArgs: options?.args ?? [] });
  }
  if (!agents.length) return null;

  const projects = await findProjects(opts.projectsDir, opts.projects);
  const scratch = join(tmpdir(), 'nova-agents'); // questions run here: no project, no CLAUDE.md
  await mkdir(scratch, { recursive: true });

  const find = (name: string) => {
    const agent = agents.find((a) => a.name === name);
    if (!agent) throw new Error(`No agent called ${name} is paired.`);
    return agent;
  };

  const brains = new Map<string, ReasoningBrain & { warm?(): void; close?(): void; refresh?(): void }>();

  /** A question for an agent that starts afresh each time: Nova's tools attached, the answer streamed if the CLI streams it. */
  const askOnce = (agent: Agent, tools: ReturnType<Bridge['tools']> | undefined) =>
    async function* (question: string, history: Turn[], signal?: AbortSignal): AsyncGenerator<string> {
      const out = channel<string>();
      let streamed = false;
      const invocation = agent.preset.ask(withHistory(withTime(question), history, opts.assistant), { model: agent.model, assistant: opts.assistant, tools });
      run(agent, invocation, { cwd: scratch, signal, onDelta: (piece) => ((streamed = true), out.push(piece)) }).then(
        (text) => (streamed || out.push(text), out.end()),
        (error) => out.end(error),
      );
      yield* out;
    };

  const host: AgentHost & { brain(name: string): ReasoningBrain & { warm?(): void } } = {
    agents: agents.map((a) => ({ name: a.name, label: a.preset.label })),
    projects: [...projects.keys()],
    async ask(name, question, history, signal) {
      const agent = find(name);
      return run(agent, agent.preset.ask(withHistory(question, history, opts.assistant), { model: agent.model, assistant: opts.assistant }), { cwd: scratch, signal });
    },
    brain(name) {
      let brain = brains.get(name);
      if (!brain) {
        const agent = find(name);
        const tools = opts.bridge?.tools(agent.preset.label);
        if (agent.preset.session) {
          brain = new AgentSession(agent, { cwd: scratch, assistant: opts.assistant, tools, env: (extra) => agentEnv(agent.preset.dropEnv, extra) });
        } else {
          const stream = askOnce(agent, tools);
          brain = {
            name: agent.preset.label,
            stream,
            async reply(u, h, signal) {
              let text = '';
              for await (const piece of stream(u, h, signal)) text += piece;
              return text.trim();
            },
          };
        }
        brain.close = ((close) => () => (close?.(), tools?.close()))(brain.close?.bind(brain));
        brains.set(name, brain);
      }
      return brain;
    },
    async run(name, task, project, callbacks, signal) {
      const agent = find(name);
      const cwd = projects.get(project);
      if (!cwd) throw new Error(`${project} isn't a known project.`);
      const hookup =
        agent.preset.approvals && opts.bridge
          ? opts.bridge.hookup(async (p) => {
              // What's said is exactly what's allowed: a command too long to say is sent back, not summarized.
              const unsayable = tooLongToSay(p.tool_name, p.input);
              if (unsayable) return { deny: unsayable };
              return callbacks.approve({ action: describeAction(p.tool_name, p.input, cwd), tool: p.tool_name, detail: approvalDetail(p.tool_name, p.input) });
            })
          : undefined;
      try {
        return await run(agent, agent.preset.task(task, { model: agent.model, approvals: hookup, assistant: opts.assistant }), {
          cwd,
          signal: AbortSignal.any([signal, AbortSignal.timeout(opts.taskTimeoutMs)]),
          onStep: callbacks.onStep,
          // A spoken yes can take a while; don't let the permission tool call time out first.
          env: hookup ? { MCP_TOOL_TIMEOUT: '600000' } : undefined,
        });
      } finally {
        hookup?.close();
      }
    },
  };
  return {
    ...host,
    close() {
      for (const brain of brains.values()) brain.close?.();
      brains.clear();
    },
    refresh() {
      for (const brain of brains.values()) brain.refresh?.();
    },
    projectPath: (name) => projects.get(name),
  };
}

function run(
  agent: Agent,
  invocation: Invocation,
  opts: { cwd: string; signal?: AbortSignal; onStep?: TaskCallbacks['onStep']; onDelta?: (piece: string) => void; env?: Record<string, string> },
): Promise<string> {
  const reader = outputReader(agent.preset.output);
  const args = [...invocation.args, ...agent.extraArgs, ...(invocation.trailing !== undefined ? ['--', invocation.trailing] : [])];
  return new Promise((resolve, reject) => {
    const child = spawn(agent.bin, args, { cwd: opts.cwd, env: agentEnv(agent.preset.dropEnv, { ...opts.env, ...invocation.env }), signal: opts.signal, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    createInterface({ input: child.stdout }).on('line', (line) => {
      const piece = opts.onDelta && reader.delta?.(line);
      if (piece) opts.onDelta!(piece);
      const step = reader.line(line);
      if (step) opts.onStep?.(step);
    });
    child.on('error', (e) => {
      if (e.name !== 'AbortError') return reject(new Error(`${agent.preset.label} couldn't start: ${e.message}`));
      reject(new Error((opts.signal?.reason as Error | undefined)?.name === 'TimeoutError' ? 'It ran out of time.' : 'Stopped.'));
    });
    child.on('close', (code) => {
      const { text, error } = reader.result();
      if (error) return reject(new Error(error));
      if (code !== 0 && !text.trim()) return reject(new Error(stderr.trim().split('\n').at(-1)?.slice(0, 300) || `${agent.preset.label} exited with code ${code}`));
      resolve(text.trim());
    });
    child.stdin.on('error', () => {}); // it may exit before reading the prompt
    child.stdin.end(invocation.stdin ?? '');
  });
}
