import type { HearingStatus, IntegrationStatus, PrivacyFlow, SettingValue } from '@nova/core';
import type { Config } from '../config.ts';

/**
 * The privacy page: everything that leaves this Mac, where it goes and when - and what stays.
 * Worked out from the settings in effect, so it's always what Nova actually does now.
 */

export interface PrivacyInput {
  config: Config;
  /** Reflex is installed and deciding. */
  reflex: boolean;
  /** NOVA_JEV_API_KEY is set, so Jev decides when it's chosen. */
  hasJevKey: boolean;
  /** Agents installed on this Mac, the paired ones first (default first); a switched-off one isn't paired. */
  agents: { name: string; label: string; paired: boolean }[];
  /** Whether open questions have someone to answer them now. */
  brain: boolean;
  integrations: IntegrationStatus[];
  hearing: HearingStatus;
  voiceInstalled: boolean;
  isLocal: (id: string) => boolean;
  /** The user's voiceprint (Voice ID) is on this Mac. */
  voiceprint?: boolean;
}

const VENDORS: Record<string, string> = { claude: 'Anthropic', codex: 'OpenAI', gemini: 'Google' };
const THIS_MAC = 'this Mac';

/** Where a brain or agent sends what it's given. */
function destination(id: string, input: PrivacyInput): { where: string; leaves: boolean } {
  const agent = input.agents.find((a) => a.name === id);
  if (agent) {
    const model = input.config.agentOptions[agent.name]?.model;
    if (model && input.isLocal(model)) return { where: `${THIS_MAC} (${agent.label}, with ${model})`, leaves: false };
    if (agent.name === 'opencode') return { where: `the model provider OpenCode is set to use${model ? ` (${model})` : ''}`, leaves: true };
    const vendor = VENDORS[agent.name];
    return vendor ? { where: `${vendor}, through ${agent.label} - on your own plan`, leaves: true } : { where: `wherever ${agent.label} sends it`, leaves: true };
  }
  if (input.isLocal(id)) return { where: `${THIS_MAC} (${id})`, leaves: false };
  // Not one of the user's servers: Nova has no way to reach it, so nothing is sent anywhere.
  return { where: `nowhere - ${id} isn't a model on one of your servers`, leaves: false };
}

const hostOf = (where: string) => {
  try {
    return new URL(where).hostname;
  } catch {
    return null;
  }
};

export function privacyFlows(input: PrivacyInput): PrivacyFlow[] {
  const { config } = input;
  const flows: PrivacyFlow[] = [];
  const toggle = (key: string, on: SettingValue = true, off: SettingValue = false) => ({ key, on, off });

  // What the microphone hears.
  const hearing = input.hearing.engine;
  flows.push({
    id: 'hearing',
    what: 'What the microphone hears',
    where: hearing === 'browser' ? "your browser's speech recognition (Safari's goes to Apple)" : `${THIS_MAC} (${hearing === 'parakeet' ? 'Parakeet' : "Apple's on-device recognizer"})`,
    detail: 'Audio is never kept. What you say to Nova is kept as text in your conversation history, on this Mac.',
    leaves: hearing === 'browser',
    on: true,
    section: 'hearing',
  });
  flows.push({
    id: 'voice',
    what: 'What Nova says, spoken aloud',
    where: input.voiceInstalled ? `${THIS_MAC} (Kokoro)` : "nowhere yet - Kokoro, Nova's voice, comes with Nova.app",
    leaves: false,
    on: input.voiceInstalled,
    section: 'voice',
  });
  flows.push({
    id: 'voiceprint',
    what: 'Your voiceprint (Voice ID), to know your voice from others',
    where: `${THIS_MAC} (~/.nova/voiceprint.json, readable by you alone)`,
    detail: 'Made on this Mac from what you said when setting it up; it never leaves it. The master keyword, if you set one, is kept only as a hash. Settings → Voice forgets them.',
    leaves: false,
    on: Boolean(input.voiceprint),
    section: 'voice',
  });
  flows.push({
    id: 'voice-recordings',
    what: 'Recordings of the turns Voice ID checks (yours, and other voices it hears), with what was heard and what it made of each - only when you keep them',
    where: `${THIS_MAC} (~/.nova/voice-recordings, readable by you alone)`,
    detail: "For checking and tuning Voice ID on your own voice. Kept 7 days, then deleted; switching this off deletes them all at once. They never leave this Mac.",
    leaves: false,
    on: config.voiceId.keepRecordings,
    toggle: toggle('voiceId.keepRecordings'),
    section: 'voice',
  });

  // System 1: what each thing said means.
  // As the engine decides it: Jev only when chosen and its key is set; a language model only on the user's own servers.
  const onMac = input.reflex ? `${THIS_MAC} (Reflex)` : `${THIS_MAC} (the keyword matcher)`;
  const jev = config.engine === 'jev' && input.hasJevKey;
  const local = config.engine === 'llm' && config.decisionModel && input.isLocal(config.decisionModel) ? `${THIS_MAC} (${config.decisionModel})` : null;
  // Who decides when Jev can't in time - always here: Reflex, the keyword matcher, or a model on the user's server.
  const backup =
    config.fallback === 'none'
      ? 'Nova says it failed'
      : config.fallback === 'llm' && config.decisionModel && input.isLocal(config.decisionModel)
        ? `${config.decisionModel} decides on this Mac`
        : input.reflex && config.fallback !== 'heuristic'
          ? 'Reflex decides on this Mac'
          : 'the keyword matcher decides on this Mac';
  flows.push({
    id: 'decisions',
    what: 'Each thing you say, to decide what it means',
    where: jev ? `TypeSafe (Jev, ${config.jevModel}), at api.typesafe.ai` : config.engine === 'heuristic' ? `${THIS_MAC} (the keyword matcher)` : (local ?? onMac),
    detail: jev
      ? `With it go your last three exchanges with Nova and the choices it weighs - its skills and your apps', agents' and projects' names. TypeSafe says it doesn't train Jev on requests. When Jev can't answer in time, ${backup}.`
      : 'Nothing else goes with it.',
    leaves: jev,
    on: true,
    section: 'decisions',
  });

  // System 2: open questions, and what goes with them.
  const paired = input.agents.filter((a) => a.paired).map((a) => a.name);
  const brainId = config.brainModel === 'off' ? '' : config.brainModel || paired[0] || '';
  const brain = input.brain && brainId ? destination(brainId, input) : null;
  const toBrain = brain ?? { where: 'no one - open questions are off', leaves: false };
  flows.push({
    id: 'answers',
    what: 'Open questions, with the last few turns of the conversation',
    where: toBrain.where,
    detail: brain ? "Whoever answers can use Nova's tools; each one that changes something is asked about first." : undefined,
    leaves: toBrain.leaves,
    on: Boolean(brain),
    section: 'answers',
  });
  flows.push({
    id: 'screen-context',
    what: "What you're working in - the app, window title and page address - with each open question",
    where: toBrain.where,
    leaves: toBrain.leaves,
    on: Boolean(brain) && config.screen.context,
    toggle: toggle('screen.context'),
  });
  flows.push({
    id: 'screen-images',
    what: 'A picture of your screen, when you ask Nova to look',
    where: toBrain.where,
    leaves: toBrain.leaves,
    on: Boolean(brain) && config.screen.images,
    toggle: toggle('screen.images'),
  });
  flows.push({
    id: 'computer-use',
    what: "A picture of your screen and what's on it, while a brain uses the computer for you",
    where: toBrain.where,
    detail: 'Only while it does something you asked for; each click and each thing it types is asked about first, unless you say "go ahead with all of it".',
    leaves: toBrain.leaves,
    on: Boolean(brain) && config.hands.computerUse,
    toggle: toggle('hands.computerUse'),
  });
  flows.push({
    id: 'files-read',
    what: 'Files a brain reads for you ("summarize the contract"), and what is on your clipboard when it asks',
    where: toBrain.where,
    detail: 'Only when you asked for it in so many words - otherwise Nova asks you first, naming the file.',
    leaves: toBrain.leaves,
    on: Boolean(brain),
    section: 'hands',
  });
  flows.push({
    id: 'memories',
    what: 'Memories related to each open question',
    where: toBrain.where,
    leaves: toBrain.leaves,
    on: Boolean(brain) && config.memory.useInAnswers,
    toggle: toggle('memory.useInAnswers'),
  });
  flows.push({
    id: 'briefing-services',
    what: 'The morning briefing, which asks the brain to check your services',
    where: toBrain.where,
    leaves: toBrain.leaves,
    on: Boolean(brain) && config.initiative.briefing !== 'off' && config.initiative.briefingBrain,
    toggle: toggle('initiative.briefingBrain'),
  });

  // Agents: tasks, and the files they read. Switching one off unpairs it; on again pairs it last.
  for (const agent of input.agents) {
    const to = destination(agent.name, input);
    flows.push({
      id: `agent-${agent.name}`,
      what: `${agent.label}: the questions and tasks you give it, and the project files it reads`,
      where: to.where,
      detail: `${agent.label} runs its own app, signed in with your account - Nova never holds its keys.`,
      leaves: to.leaves,
      on: agent.paired,
      toggle: toggle('agents.enabled', agent.paired ? paired : [...paired, agent.name], paired.filter((n) => n !== agent.name)),
    });
  }

  // Services, through integrations.
  for (const service of input.integrations) {
    const entry = config.integrations?.[service.name];
    const host = hostOf(service.where);
    flows.push({
      id: `integration-${service.name}`,
      what: `${service.label}: what the brain looks up and creates there`,
      where: service.kind === 'hosted' ? (host ?? service.where) : `a program on this Mac (${service.where}), which may reach its own service`,
      detail: 'Each call that changes something is asked about first, unless you said otherwise for that service.',
      leaves: service.kind === 'hosted',
      on: service.state !== 'off',
      ...(entry ? { toggle: toggle(`integrations.servers.${service.name}`, { ...entry, enabled: true }, { ...entry, enabled: false }) } : { section: 'integrations' as const }),
    });
  }

  // The briefing's weather, and model downloads.
  flows.push({
    id: 'weather',
    what: 'Your town, for the weather in the briefing',
    where: 'open-meteo.com',
    detail: 'Only the town you set; no account.',
    leaves: true,
    on: config.initiative.briefing !== 'off' && Boolean(config.initiative.town.trim()),
    section: 'initiative',
  });
  flows.push({
    id: 'calendar',
    what: "Today's events, for the briefing and to stay quiet in meetings",
    where: `${THIS_MAC} (read through Nova.app)`,
    leaves: false,
    on: config.initiative.calendar,
    toggle: toggle('initiative.calendar'),
  });
  flows.push({
    id: 'reminders-app',
    what: 'Reminders you want on your iPhone',
    where: 'the Reminders app - and iCloud, if your reminders sync there',
    leaves: false,
    on: config.initiative.appleReminders !== 'never',
    toggle: toggle('initiative.appleReminders', config.initiative.appleReminders === 'never' ? 'when-asked' : config.initiative.appleReminders, 'never'),
  });
  flows.push({
    id: 'downloads',
    what: 'Model downloads - Reflex, Kokoro, Parakeet, Smart Turn, Voice ID',
    where: 'huggingface.co, only when you install one',
    detail: 'Nothing about you goes with them; each file is checked against a pinned checksum.',
    leaves: true,
    on: true,
  });
  flows.push({
    id: 'kept',
    what: 'Memories, conversations, reminders and the record of actions',
    where: `${THIS_MAC} (~/.nova, readable only by you)`,
    leaves: false,
    on: true,
    section: 'memory',
  });
  flows.push({
    id: 'snapshots',
    what: "Snapshots of your projects, so agents' changes can be undone",
    where: 'each git project itself (refs/nova/snapshots - never pushed unless you push everything)',
    leaves: false,
    on: config.trust.snapshots,
    toggle: toggle('trust.snapshots'),
  });
  return flows;
}
