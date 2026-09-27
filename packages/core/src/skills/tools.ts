import type { RiskTier } from '../protocol.ts';
import type { Skill } from './types.ts';

/** One of Nova's abilities as a tool any agent or model can call, described by a JSON schema. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[]; [keyword: string]: unknown };
}

/** A tool from an integration (an MCP server), with the tier the user's choice gives it. */
export interface IntegrationTool extends ToolSpec {
  /** "Linear", for Activity and spoken prompts. */
  label: string;
  tier: RiskTier;
  /**
   * The service labels it read-only. "Yes, always" is remembered only for such a tool (and never
   * for one whose name says it moves money, runs code, deletes or sends); the user allows others in Settings.
   */
  readOnly?: boolean;
  /** What a call would do, to say out loud: `Linear: create issue "Fix the login bug"`. */
  summary(args: Record<string, unknown>): string;
}

/** The integrations' tools, and where their calls go (the daemon's connections). */
export interface IntegrationTools {
  specs(): IntegrationTool[];
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

/** A tool's result: words, and sometimes a picture (a screenshot) for brains that can see. */
export type ToolOutput = string | { text: string; image?: { data: string; mimeType: string } };

export const outputText = (output: ToolOutput) => (typeof output === 'string' ? output : output.text);

/**
 * Where agents' and models' tool calls go. NovaBrain is the host, so every agent - Claude,
 * Codex, a local model - acts through the same skills and the same risk rules as the user's voice.
 */
export interface ToolHost {
  specs(): ToolSpec[];
  /** Runs a tool; resolves with what happened, in words (and a picture, for looking), for the caller to relay. */
  call(name: string, args: Record<string, unknown>, caller: string): Promise<ToolOutput>;
}

export function skillTool(skill: Skill): ToolSpec {
  const properties: Record<string, unknown> = {
    request: { type: 'string', description: 'What to do, in plain words - e.g. "10 minutes" for a timer, or the whole task for an agent.' },
  };
  const required: string[] = skill.needsRequest ? ['request'] : [];
  if (skill.needsApp) (properties.app = { type: 'string', description: 'The app, e.g. "Spotify".' }), required.push('app');
  if (skill.needsProject) (properties.project = { type: 'string', description: "The project folder's name." }), required.push('project');
  if (skill.needsAgents) properties.agent = { type: 'string', description: 'Which paired agent, e.g. "claude". Leave out for the default one.' };
  else if (skill.namesAgent) properties.agent = { type: 'string', description: 'Whose doing it is about, e.g. "claude". Leave out for anyone\'s.' };
  const what = skill.summary ?? `For requests like: ${skill.examples.slice(0, 3).join('; ')}.`;
  return {
    name: skill.id,
    description: skill.tier >= 2 ? `${what} The assistant asks the user out loud first.` : what,
    parameters: { type: 'object', properties, required },
  };
}
