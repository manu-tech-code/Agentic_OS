import type { ReasoningBrain, Turn } from './brain/reasoning.ts';

/** Something an agent is doing, for narration and its live task card. */
export interface AgentStep {
  kind: 'command' | 'edit' | 'read' | 'search' | 'message' | 'other';
  /** Short and human, e.g. "running npm test" or "editing App.tsx". */
  text: string;
}

/** A step an agent wants permission for; Nova asks the user out loud. */
export interface ApprovalRequest {
  /** What it wants to do, phrased to follow "wants to", e.g. 'run "npm test"'. */
  action: string;
  /** The agent's own tool ("Bash", "WebFetch") and exactly what with (the command, the site) - what "yes, always" remembers. */
  tool?: string;
  detail?: string;
}

export interface TaskCallbacks {
  onStep(step: AgentStep): void;
  /** Resolves true on the user's spoken yes. Used by agents that hand permission prompts to Nova. */
  approve(request: ApprovalRequest): Promise<boolean>;
}

/**
 * The agents Nova pairs with (Claude Code, Codex, OpenCode, ...). The host owns
 * the command lines and folder paths - speech only ever picks names from these lists.
 */
export interface AgentHost {
  /** Paired agents, default first. */
  readonly agents: { name: string; label: string }[];
  /** Folders agents may work in, by name. */
  readonly projects: string[];
  /** Answer a question with no tools. */
  ask(agent: string, question: string, history: Turn[], signal?: AbortSignal): Promise<string>;
  /** An agent as a brain for open questions: streaming, with Nova's tools, kept running when it can be. */
  brain?(agent: string): ReasoningBrain;
  /** Work on a task inside a project; resolves with the agent's final message. */
  run(agent: string, task: string, project: string, callbacks: TaskCallbacks, signal: AbortSignal): Promise<string>;
}
