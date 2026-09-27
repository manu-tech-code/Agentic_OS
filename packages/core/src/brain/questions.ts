import type { AgentHost } from '../agents.ts';
import { tokens } from '../decision/heuristicModel.ts';
import type { Question } from '../decision/types.ts';
import type { Skill } from '../skills/types.ts';

/** Intents the brain handles itself, alongside the registered skills. */
export const META_INTENTS: Record<string, string[]> = {
  stop: ['stop', 'never mind', 'cancel that', 'be quiet', 'shut up', 'forget it'],
  confirm_yes: ['yes', 'yeah do it', 'go ahead', 'confirm', 'sure', 'okay do it'],
  confirm_no: ['no', "don't", 'no thanks', 'leave it', 'abort'],
  chat: ['a general question', 'explain something', 'tell me about', 'what is', 'how do I', 'write', 'summarise', 'help me think'],
  other: ['anything else that does not match the other options'],
};

export const JEV_CHOICE_LIMIT = 255;

/**
 * One System 1 call per utterance, asking everything at once (speculative
 * fan-out): extra questions cost tokens, not latency.
 */
export function buildQuestions(skills: Skill[], apps: string[], utterance: string, agents?: AgentHost | null, assistant = 'Nova') {
  const intentCriteria: Record<string, string[]> = {};
  for (const s of skills) if (!s.toolOnly) intentCriteria[s.id] = s.examples;
  Object.assign(intentCriteria, META_INTENTS);

  const questions: Record<string, Question> = {
    intent: {
      type: 'choice',
      instructions: `What does the user want ${assistant} to do with this utterance?`,
      criteria: intentCriteria,
    },
    addressed: {
      type: 'boolean',
      instructions: `The utterance is directed at the voice assistant ${assistant}, not background speech.`,
      criteria: {
        true: 'A command, request or question meant for the assistant, or a reply to its last question.',
        false: 'Background noise, TV or video audio, or the user talking to another person.',
      },
    },
  };

  const candidates = shortlistApps(apps, utterance, JEV_CHOICE_LIMIT - 1);
  if (candidates.length) {
    const appCriteria: Record<string, string | null> = { none: 'No application is mentioned' };
    for (const a of candidates) appCriteria[a] = null;
    questions.app = { type: 'choice', instructions: 'Which installed application does the user refer to?', criteria: appCriteria };
  }

  if (agents?.agents.length) {
    const agentCriteria: Record<string, string> = { none: 'No AI agent is named' };
    for (const a of agents.agents) agentCriteria[a.name] = a.label;
    questions.agent = { type: 'choice', instructions: 'Which AI agent does the user name, to ask a question or give a task?', criteria: agentCriteria };
  }
  const projects = shortlistApps(agents?.projects ?? [], utterance, JEV_CHOICE_LIMIT - 1);
  if (projects.length) {
    const projectCriteria: Record<string, string | null> = { none: 'No project or folder is mentioned' };
    for (const p of projects) projectCriteria[p] = null;
    questions.project = { type: 'choice', instructions: 'Which project folder does the user refer to?', criteria: projectCriteria };
  }
  return questions;
}

/** Jev takes at most 255 options; rank in code when there are more apps. */
export function shortlistApps(apps: string[], utterance: string, limit: number): string[] {
  if (apps.length <= limit) return apps;
  const u = new Set(tokens(utterance));
  return [...apps]
    .map((a) => ({ a, s: tokens(a).filter((t) => u.has(t)).length }))
    .sort((x, y) => y.s - x.s)
    .slice(0, limit)
    .map((x) => x.a);
}
