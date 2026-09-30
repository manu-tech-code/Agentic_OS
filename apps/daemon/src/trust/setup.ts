import type { SettingsSnapshot, SetupStep, ShellStatus } from '@nova/core';
import type { Config } from '../config.ts';

/**
 * The setup checklist: each thing Nova needs (or is better with), whether it's there, and the
 * fix. The first-run walkthrough goes through the same steps.
 */

export interface SetupInput {
  config: Config;
  reflex: { installed: boolean; learned: number; label: string };
  voice: { installed: boolean; bundled?: boolean; label: string };
  hearing: SettingsSnapshot['hearing'];
  /** Nova.app as it last reported itself, and whether it's installed at all. */
  app: ShellStatus | null;
  appInstalled: boolean;
  agents: { name: string; label: string }[];
  brain: string | null;
  /** Projects agents may work in, and whether each is a git repository (so agents' changes can be undone). */
  projects: { name: string; git: boolean }[];
  screen: SettingsSnapshot['screen'];
  hands?: SettingsSnapshot['hands'];
  signing?: SettingsSnapshot['signing'];
  voiceId?: SettingsSnapshot['voiceId'];
  phone?: SettingsSnapshot['phone'];
}

const ACCESS: Record<string, string> = { granted: 'allowed', denied: 'not allowed', undetermined: 'not asked yet', restricted: 'restricted' };
const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const size = (label: string) => /(\d+ MB)/.exec(label)?.[1];

export function setupSteps(input: SetupInput): SetupStep[] {
  const { config, app } = input;
  const steps: SetupStep[] = [];
  const wake = config.wakeWords[0] ?? `hey ${config.name.toLowerCase()}`;

  steps.push({ id: 'name', label: 'Name', done: true, detail: `Called ${config.name} - say "${wake}", or press the shortcut.`, fix: { section: 'general' } });
  steps.push({
    id: 'voice',
    label: "Nova's voice",
    done: input.voice.installed,
    detail: input.voice.installed
      ? `Kokoro, as ${config.voice.kokoroVoice}${input.voice.bundled ? ' - built into Nova.app' : ''}.`
      : "Kokoro comes inside Nova.app: install the app and Nova speaks - there's nothing else to download. Until then its replies are shown, not spoken.",
    fix: input.voice.installed ? { section: 'voice' } : { command: 'npm run app', section: 'voice' },
  });

  // Hearing: the recognizer, and the microphone the app hears with.
  const hearing = input.hearing.status;
  const micDenied = app && app.mic !== 'granted';
  steps.push({
    id: 'hearing',
    label: 'Microphone and hearing',
    done: hearing.state === 'ready' && !micDenied,
    detail: micDenied
      ? app!.mic === 'undetermined'
        ? 'Nova.app will ask for the microphone the first time it listens.'
        : "Nova.app isn't allowed the microphone: turn it on in System Settings → Privacy & Security → Microphone."
      : hearing.state === 'ready'
        ? `${hearing.engine === 'parakeet' ? 'Parakeet' : hearing.engine === 'browser' ? "The browser's recognizer" : "Apple's on-device recognizer"} is listening${app ? ` (${app.listening === 'muted' ? 'muted for now' : app.listening === 'shortcut' ? 'when you press the shortcut' : 'for the wake word'})` : ''}.`
        : (hearing.message ?? (hearing.state === 'starting' ? 'Getting ready…' : "Nova can't hear yet.")),
    fix: { section: 'hearing' },
  });

  steps.push({
    id: 'reflex',
    label: "Reflex, Nova's own decision model",
    done: input.reflex.installed,
    detail: input.reflex.installed
      ? `Installed - deciding on this Mac in about a millisecond${input.reflex.learned ? `, with ${input.reflex.learned} things learned from you` : ''}.`
      : `Not installed: Nova goes by keywords, which misses more. It's a small download (${size(input.reflex.label) ?? 'a few MB'}).`,
    fix: input.reflex.installed ? { section: 'decisions' } : { install: 'reflex', section: 'decisions' },
  });

  steps.push({
    id: 'agents',
    label: 'Agents on this Mac',
    done: input.agents.length > 0,
    detail: input.agents.length
      ? `${list(input.agents.map((a) => a.label))} - each signed in with your own account.`
      : 'None found. Install Claude Code, Codex, OpenCode or Gemini CLI and sign in - Nova finds them by itself.',
    fix: { section: 'agents' },
  });
  steps.push({
    id: 'answers',
    label: 'Who answers open questions',
    done: Boolean(input.brain),
    detail: input.brain ? `${input.brain}, with Nova's tools.` : config.brainModel === 'off' ? 'Open questions are off.' : 'No one yet: pair an agent, or choose Apple Intelligence or a local model.',
    fix: { section: 'answers' },
  });

  const notGit = input.projects.filter((p) => !p.git);
  steps.push({
    id: 'projects',
    label: 'Projects agents may work in',
    done: input.projects.length > 0,
    optional: true,
    detail: input.projects.length
      ? `${input.projects.length === 1 ? 'One project' : `${input.projects.length} projects`}${config.projectsDir ? ` in ${config.projectsDir}` : ''}.${notGit.length ? ` ${notGit.length === 1 ? `${notGit[0]!.name} isn't a git repository` : `${notGit.length} aren't git repositories`}, so agents' changes there can't be undone.` : ''}`
      : 'None yet: choose a projects folder, or name project folders.',
    fix: { section: 'projects' },
  });

  steps.push({
    id: 'app',
    label: 'Nova.app in the menu bar',
    done: Boolean(app),
    detail: app
      ? `Running${app.loginItem === 'on' ? ', and opens at login' : ''}. Shortcut: ${app.shortcut.keys}${app.shortcut.ok ? '' : ` (${app.shortcut.message ?? 'another app has it'})`}.`
      : input.appInstalled
        ? 'Installed, but not running: open Nova from Applications.'
        : 'Not installed. It listens with echo cancellation, has the orb and the shortcut, and opens at login.',
    fix: app || input.appInstalled ? { section: 'presence' } : { command: 'npm run app', section: 'presence' },
  });
  const signing = input.signing;
  if (signing) {
    // Built but not signed with the user's certificate (or not hardened): the next build signs it.
    const behind = signing.apps.filter((a) => a.signed !== 'not built' && (a.signed !== 'yours' || !a.hardened));
    const soon = signing.expires !== null && signing.expires - Date.now() < 30 * 86_400_000;
    steps.push({
      id: 'signing',
      label: 'Permissions that survive rebuilds',
      done: !signing.adHoc && behind.length === 0 && !soon,
      optional: signing.adHoc,
      detail: signing.adHoc
        ? 'Nova is signed for this Mac alone, so macOS asks for the microphone, the screen and Accessibility again after every rebuild. Sign in to Xcode (Settings → Accounts) - it makes a free Apple Development certificate - then run npm run app.'
        : behind.length
          ? `Your certificate is here (${signing.identity}), but ${list(behind.map((a) => a.name))} ${behind.length === 1 ? "isn't" : "aren't"} signed with it yet: run npm run app - Nova Eyes and the hearing helper follow by themselves. macOS asks for each permission one last time.`
          : soon
            ? `${signing.identity} - it runs out soon: renew it in Xcode (Settings → Accounts), then run npm run app. What macOS allows Nova stays.`
            : `Signed as ${signing.identity}, hardened: what macOS allows Nova survives rebuilds, and Nova Eyes answers only the daemon Nova.app runs.`,
      fix: signing.adHoc || behind.length || soon ? { command: 'npm run app', section: 'system' } : { section: 'system' },
    });
  }
  const voice = input.voiceId;
  if (voice) {
    steps.push({
      id: 'voice-id',
      label: 'Voice ID',
      done: voice.on,
      optional: true,
      detail: voice.on
        ? `On: Nova answers your voice alone${voice.learned ? ` (learned from ${voice.learned} of your turns)` : ''}.`
        : voice.enrolled
          ? 'Your voice is learned, but Voice ID is off: anyone Nova hears can ask it things.'
          : 'Off: anyone Nova hears can ask it things - a TV too. Set it up to have Nova answer your voice alone.',
      fix: { section: 'voice' },
    });
  }
  const access = app?.access;
  steps.push({
    id: 'permissions',
    label: 'What macOS lets Nova.app do',
    done: Boolean(app && app.mic === 'granted' && access?.notifications === 'granted'),
    optional: !app,
    detail: app
      ? `Microphone: ${ACCESS[app.mic]} · Notifications: ${ACCESS[access?.notifications ?? 'undetermined']} · Calendar: ${ACCESS[access?.calendar ?? 'undetermined']} · Reminders: ${ACCESS[access?.reminders ?? 'undetermined']}.`
      : 'Open Nova.app to see.',
    fix: { section: 'presence' },
  });

  const screen = input.screen;
  steps.push({
    id: 'screen',
    label: "Nova Eyes - what you're working in",
    done: Boolean(screen.available && screen.permissions?.accessibility && screen.permissions.screen),
    optional: true,
    detail: !screen.available
      ? (screen.message ?? 'Needs macOS.')
      : screen.permissions
        ? `Accessibility: ${screen.permissions.accessibility ? 'allowed' : 'not allowed'} · Screen Recording: ${screen.permissions.screen ? 'allowed' : 'not allowed'}.`
        : (screen.message ?? 'Starts when Nova first needs it.'),
    fix: { section: 'screen' },
  });

  // Nova's hands: Accessibility to click, type and move windows - and Screen Recording for brains to see what they use.
  const hands = input.hands;
  if (hands?.available) {
    const p = hands.permissions;
    const seeing = config.hands.computerUse;
    const missing = [!p?.accessibility && 'Accessibility (to click, type and move windows)', seeing && !p?.screen && 'Screen Recording (for brains to see the screen they use)'].filter(Boolean) as string[];
    steps.push({
      id: 'hands',
      label: "Nova's hands - clicking, typing and windows",
      done: Boolean(p) && missing.length === 0,
      optional: true,
      detail: !p
        ? 'Nova Eyes starts when Nova first needs it; then this shows what macOS lets it do.'
        : missing.length
          ? `Nova Eyes needs ${list(missing)}: Settings → Hands → Allow.`
          : `Ready: Nova can change settings, arrange windows and use the computer when you say so${hands.shortcuts?.length ? `, and run your ${hands.shortcuts.length} Shortcuts` : ''}.`,
      fix: { section: 'hands' },
    });
  }

  const phone = input.phone;
  if (phone) {
    const paired = phone.devices.length;
    steps.push({
      id: 'phone',
      label: 'Nova on your iPhone',
      done: paired > 0 && config.phone.enabled,
      optional: true,
      detail: !paired
        ? 'Not paired: pair your iPhone in Settings → iPhone to talk to Nova from anywhere on your Wi-Fi.'
        : !config.phone.enabled
          ? `${paired === 1 ? 'One iPhone is' : `${paired} iPhones are`} paired, but they can't connect: turn on "Let your iPhone connect".`
          : `${paired === 1 ? 'One iPhone' : `${paired} iPhones`} paired${phone.message ? ` - ${phone.message}` : ''}.`,
      fix: { section: 'phone' },
    });
  }

  steps.push({ id: 'privacy', label: 'What leaves this Mac', done: true, optional: true, detail: 'Each thing that goes anywhere, where to, and its switch.', fix: { section: 'privacy' } });
  return steps;
}
