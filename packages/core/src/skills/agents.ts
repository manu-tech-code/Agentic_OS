import type { Skill } from './types.ts';

/** Skills for paired agents (Claude Code, Codex, ...). Offered only when agents are configured. */
export const agentSkills: Skill[] = [
  {
    id: 'agent_task',
    needsRequest: true,
    summary: "Hand a coding task to a paired coding agent (Claude Code, Codex, ...) to do in one of the user's project folders. Put the whole task in request.",
    tier: 2,
    needsProject: true,
    usesCurrentProject: true,
    needsAgents: true,
    examples: [
      'ask claude to fix the failing test in agentic os',
      'have codex add a readme to the website project',
      'tell claude to refactor the login page',
      'get codex to write tests for the api',
      'ask the agent to update the docs in my project',
      'can you have claude clean up this repo',
    ],
    confirmPrompt: ({ agent, project }) => `Ask ${agent?.label ?? 'the agent'} to work in ${project}? It can edit files and run commands there.`,
    rememberAs: ({ agent, project }) => (agent && project ? { key: `agent_task:${agent.name}:${project}`, label: `${agent.label} working in ${project}` } : null),
    async run({ utterance, agent, project, tasks }) {
      // The whole utterance goes to the agent: it understands "fix the failing test" better than any parse would.
      tasks.start(agent!, utterance, project!);
      return { say: `Okay, ${agent!.label} is on it.`, activity: `${agent!.label} started in ${project}` };
    },
  },
  {
    id: 'cancel_task',
    summary: 'Stop the coding agents that are working.',
    tier: 0,
    needsAgents: true,
    examples: ['stop the agent', 'cancel the agent task', 'tell the agent to stop', 'stop claude working', 'make codex stop'],
    async run({ tasks }) {
      const n = tasks.cancelAll();
      return { say: n ? (n === 1 ? 'Stopped the task.' : `Stopped ${n} tasks.`) : 'No agent is working right now.', activity: 'Stopped agent tasks' };
    },
  },
];
