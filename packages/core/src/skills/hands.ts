import {
  computerTask,
  parseClipboard,
  parseFiles,
  parseMedia,
  parseShortcutRequest,
  parseSystem,
  parseUi,
  parseWindow,
  type FilesRequest,
  type SystemRequest,
  type SystemSetting,
  type UiRequest,
} from '../hands.ts';
import type { UndoStep } from '../protocol.ts';
import type { FileHit, SkillContext, SkillResult, SystemState, Skill } from './types.ts';

/**
 * Nova's hands on the Mac: its settings, media, windows, files, the clipboard, the user's Shortcuts,
 * the user's own commands for the app in front, and handing a whole task to a brain that uses the
 * computer. What to do is read in code (hands.ts); the tier is declared here - reads are free, and
 * a change asks first unless the user's own words asked for exactly that kind of thing.
 */

/** What the user said (not the brain's request), when it asks for this: then it's the user's own wish. */
export const userAsked = (ctx: SkillContext, test: (said: string) => boolean) => {
  const said = (ctx.heard ?? ctx.utterance).trim();
  return said !== '' && test(said);
};

const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const NAMES: Record<SystemSetting, string> = {
  volume: 'volume',
  brightness: 'brightness',
  'dark-mode': 'dark mode',
  wifi: 'Wi-Fi',
  bluetooth: 'Bluetooth',
  focus: 'Focus',
  lock: 'screen lock',
  sleep: 'sleep',
  battery: 'battery',
};
const noHands = (what: string): SkillResult => ({ say: `I can't reach ${what} from here.`, data: `Nova's hands aren't available (${what}).`, activity: `${what}: not available` });

// ---------------------------------------------------------------------------
// System settings

function stateSaid(s: SystemState): string {
  switch (s.setting) {
    case 'volume':
      return s.muted ? 'The sound is muted.' : `The volume is at ${s.level ?? 0}%.`;
    case 'brightness':
      return `The screen's brightness is at ${s.level ?? 0}%.`;
    case 'battery':
      if (s.level === undefined) return "This Mac doesn't have a battery - it runs on power.";
      return `The battery is at ${s.level}%${s.charging ? `, charging${s.remaining ? ` - full in ${s.remaining}` : ''}` : s.remaining ? `, with ${s.remaining} left` : ''}.`;
    default:
      return s.on === undefined ? `I can't tell whether ${NAMES[s.setting]} is on.` : `${NAMES[s.setting].replace(/^./, (c) => c.toUpperCase())} is ${s.on ? 'on' : 'off'}.`;
  }
}

function changeSaid(s: SystemState): string {
  if (s.setting === 'volume') return s.muted ? 'Muted.' : `Volume at ${s.level ?? 0}%.`;
  if (s.setting === 'brightness') return `Brightness at ${s.level ?? 0}%.`;
  return `${NAMES[s.setting].replace(/^./, (c) => c.toUpperCase())} ${s.on ? 'on' : 'off'}.`;
}

function confirmSystem(req: SystemRequest | null): string {
  if (!req) return 'Change that setting?';
  if (req.setting === 'sleep') return 'Put the Mac to sleep?';
  if (req.setting === 'lock') return 'Lock the screen?';
  const name = NAMES[req.setting];
  if (req.action === 'set') return `Set the ${name} to ${req.value}%?`;
  if (req.action === 'up' || req.action === 'down') return `Turn the ${name} ${req.action}?`;
  if (req.action === 'mute') return 'Mute the sound?';
  if (req.action === 'unmute') return 'Unmute the sound?';
  return `Turn ${req.action === 'toggle' ? 'over' : req.action} ${name}?`;
}

const systemSkill: Skill = {
  id: 'system_control',
  summary:
    "The Mac's own settings: the volume (up, down, to a level, mute), the screen's brightness, dark mode, Wi-Fi, Bluetooth, Focus (Do Not Disturb), locking the screen, sleeping the Mac, and how the battery is. Put what to do in request, e.g. \"volume to 30\" or \"is wifi on\".",
  tier: 1,
  tierFor(ctx) {
    const req = parseSystem(ctx.utterance);
    if (!req || req.action === 'query') return 0;
    if (req.setting === 'sleep') return 2; // Nova stops hearing: asked, whoever says it
    return userAsked(ctx, (said) => parseSystem(said)?.setting === req.setting) ? 1 : 2;
  },
  confirmPrompt: (ctx) => confirmSystem(parseSystem(ctx.utterance)),
  rememberAs(ctx) {
    const req = parseSystem(ctx.utterance);
    return req && req.setting !== 'sleep' && req.action !== 'query' ? { key: `system:${req.setting}`, label: `Change the ${NAMES[req.setting]}` } : null;
  },
  examples: ['turn the volume up', 'set the volume to 30', 'dim the screen', 'turn on dark mode', 'turn off wifi', 'lock my screen', 'how much battery do i have'],
  async run(ctx) {
    const hands = ctx.hands;
    if (!hands) return noHands("the Mac's settings");
    const req = parseSystem(ctx.utterance);
    if (!req) return { say: 'Which setting? The volume, brightness, dark mode, Wi-Fi, Bluetooth or Focus.', activity: 'Settings: which one' };
    if (req.setting === 'lock') {
      await hands.system.lock();
      return { say: 'Locked.', activity: 'Locked the screen' };
    }
    if (req.setting === 'sleep') {
      await hands.system.sleep();
      return { say: 'Good night.', activity: 'Put the Mac to sleep' };
    }
    const before = await hands.system.get(req.setting);
    if (req.action === 'query' || req.setting === 'battery') return { say: stateSaid(before), data: stateSaid(before), activity: `Checked the ${NAMES[req.setting]}` };
    const change: { level?: number; on?: boolean; muted?: boolean } = {};
    const now = before.level ?? 0;
    if (req.action === 'set') change.level = req.value;
    else if (req.action === 'up') change.level = Math.min(100, now + (req.value ?? 10));
    else if (req.action === 'down') change.level = Math.max(0, now - (req.value ?? 10));
    else if (req.action === 'mute') change.muted = true;
    else if (req.action === 'unmute') change.muted = false;
    else change.on = req.action === 'on' ? true : req.action === 'off' ? false : !before.on;
    // Turning the volume up means hearing it: unmute too.
    if (req.setting === 'volume' && change.level !== undefined && before.muted && req.action !== 'down') change.muted = false;
    const after = await hands.system.set(req.setting, change);
    const undo: UndoStep = { kind: 'system-set', setting: req.setting as 'volume', level: before.level, on: before.on, muted: before.muted };
    return { say: changeSaid(after), data: stateSaid(after), activity: changeSaid(after).replace(/\.$/, ''), undo };
  },
};

// ---------------------------------------------------------------------------
// Media

const mediaSkill: Skill = {
  id: 'media_control',
  summary: 'Music and other media on the Mac: play, pause, next, previous, what\'s playing, or play something from the Music library ("play some jazz"). Put it in request.',
  tier: 1,
  tierFor(ctx) {
    const req = parseMedia(ctx.utterance);
    if (!req || req.action === 'now-playing') return 0;
    return userAsked(ctx, (said) => parseMedia(said) !== null) ? 1 : 2;
  },
  confirmPrompt: (ctx) => {
    const req = parseMedia(ctx.utterance);
    return req?.action === 'play-query' ? `Play ${req.query}?` : `${(req?.action ?? 'change').replace(/^./, (c) => c.toUpperCase())} the music?`;
  },
  examples: ['pause the music', 'next song', "what's playing", 'play some jazz', 'resume the music', 'previous track'],
  async run(ctx) {
    const hands = ctx.hands;
    if (!hands) return noHands('the music');
    const req = parseMedia(ctx.utterance) ?? { action: 'toggle' as const };
    if (req.action === 'now-playing') {
      const now = await hands.media.nowPlaying();
      if (!now) return { say: "Nothing's playing.", data: 'Nothing is playing.', activity: 'Checked what is playing' };
      const what = `“${now.title}”${now.artist ? ` by ${now.artist}` : ''}`;
      return { say: `${now.playing ? "It's" : 'Paused on'} ${what}, in ${now.app}.`, data: `${now.playing ? 'Playing' : 'Paused'}: ${what}${now.album ? ` (${now.album})` : ''} in ${now.app}.`, activity: `Now playing: ${now.title}` };
    }
    if (req.action === 'play-query') {
      const started = await hands.media.play(req.query!, req.app);
      if (!started) return { say: `I couldn't find ${req.query} in your music${req.app === 'Spotify' ? ' - Spotify only plays what it has open' : ''}.`, activity: `Music: no ${req.query}` };
      return { say: `Playing ${started.what}.`, activity: `Played ${started.what} in ${started.app}`, undo: { kind: 'media', action: 'pause' } };
    }
    const done = await hands.media.command(req.action, req.app);
    const said = { play: 'Playing.', pause: 'Paused.', toggle: 'Done.', next: 'Next.', previous: 'Back one.' }[req.action];
    const undo: UndoStep | undefined = req.action === 'pause' ? { kind: 'media', action: 'play' } : req.action === 'play' ? { kind: 'media', action: 'pause' } : undefined;
    return { say: done.app ? said : "There's nothing playing to control.", activity: `Media: ${req.action}${done.app ? ` in ${done.app}` : ''}`, undo: done.app ? undo : undefined };
  },
};

// ---------------------------------------------------------------------------
// Windows

const POSITION_SAID: Record<string, string> = {
  left: 'on the left', right: 'on the right', top: 'on top', bottom: 'at the bottom', 'top-left': 'top left', 'top-right': 'top right',
  'bottom-left': 'bottom left', 'bottom-right': 'bottom right', 'left-third': 'in the left third', 'center-third': 'in the middle third',
  'right-third': 'in the right third', 'left-two-thirds': 'in the left two thirds', 'right-two-thirds': 'in the right two thirds',
  maximize: 'filling the screen', center: 'in the middle', 'almost-maximize': 'almost filling the screen',
};

const windowSkill: Skill = {
  id: 'window_control',
  summary:
    'Windows on the Mac: put them in place ("Safari on the left, Slack on the right", "maximize this"), move one to the other display, minimize, full screen, hide an app, list what\'s open - and saved layouts ("save this layout as work", "work layout"). Put it in request.',
  tier: 1,
  tierFor(ctx) {
    const req = parseWindow(ctx.utterance, []);
    if (req?.action === 'list') return 0;
    return userAsked(ctx, (said) => parseWindow(said, []) !== null) ? 1 : 2;
  },
  confirmPrompt: () => 'Move your windows?',
  rememberAs: () => ({ key: 'hands:windows', label: 'Arrange your windows' }),
  examples: ['put safari on the left', 'maximize this window', 'safari on the left and slack on the right', 'minimize slack', 'save this layout as work', 'my work layout'],
  async run(ctx) {
    const hands = ctx.hands;
    if (!hands) return noHands('your windows');
    const req = parseWindow(ctx.utterance, await hands.windows.apps());
    if (!req) return { say: 'Where should it go? Say something like "Safari on the left".', activity: 'Windows: where' };
    if (req.action === 'list') {
      const open = await hands.windows.list();
      const said = open.map((a) => (a.windows.length > 1 ? `${a.app} (${a.windows.length} windows)` : a.app));
      return { say: open.length ? `Open: ${list(said)}.` : 'No windows are open.', data: open.map((a) => `${a.app}: ${a.windows.join(' | ')}`).join('\n'), activity: 'Listed windows' };
    }
    if (req.action === 'save-layout') {
      const saved = await hands.windows.saveLayout(req.layout!);
      return { say: `Saved your ${req.layout} layout - ${saved.windows === 1 ? 'one window' : `${saved.windows} windows`}. Say "${req.layout} layout" to set it up again.`, activity: `Saved the ${req.layout} layout` };
    }
    if (req.action === 'layout') {
      const done = await hands.windows.layout(req.layout!);
      if (!done) {
        const known = hands.windows.layouts();
        return { say: `There's no ${req.layout} layout${known.length ? ` - you have ${list(known)}` : ''}. Arrange your windows and say "save this layout as ${req.layout}".`, activity: `No ${req.layout} layout` };
      }
      const missing = done.missing.length ? ` ${list(done.missing)} ${done.missing.length === 1 ? "isn't" : "aren't"} open.` : '';
      return { say: `Your ${req.layout} layout is set.${missing}`, activity: `Set the ${req.layout} layout`, undo: { kind: 'windows-restore', frames: done.before } };
    }
    if (req.action === 'place') {
      const done = await hands.windows.place(req.placements!);
      const said = req.placements!.map((p, i) => `${p.app ?? done.moved[i] ?? 'the window'} ${POSITION_SAID[p.position] ?? p.position}`);
      return { say: `Done - ${list(said)}.`, activity: `Windows: ${list(said)}`, undo: { kind: 'windows-restore', frames: done.before } };
    }
    const done = await hands.windows.act(req.action, req.app);
    const said = {
      minimize: `Minimized ${done.app}.`,
      fullscreen: `${done.app} is full screen.`,
      'exit-fullscreen': `${done.app} is out of full screen.`,
      hide: `Hid ${done.app}.`,
      'other-display': `Moved ${done.app} to the other display.`,
      'show-all': 'Everything is showing.',
    }[req.action];
    return { say: said, activity: said.replace(/\.$/, ''), undo: done.before.length ? { kind: 'windows-restore', frames: done.before } : undefined };
  },
};

// ---------------------------------------------------------------------------
// Files

interface FilesPrepared {
  req: FilesRequest | null;
  hits: FileHit[];
  /** For moving: the folder it goes to. */
  destination?: string | null;
}

const ago = (at: number, now: Date) => {
  const days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(new Date(at).getFullYear(), new Date(at).getMonth(), new Date(at).getDate()).getTime()) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 7 ? `${days} days ago` : new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
const prepared = (ctx: SkillContext) => (ctx.prepared ?? { req: parseFiles(ctx.utterance), hits: [] }) as FilesPrepared;
const hitSaid = (h: FileHit) => `${h.name}${h.folder ? ` in ${h.folder}` : ''}`;
const withExtension = (name: string, from: string) => (/\.[a-z0-9]{1,6}$/i.test(name) ? name : `${name}${/(\.[a-z0-9]{1,6})$/i.exec(from)?.[1] ?? ''}`);

const filesSkill: Skill = {
  id: 'files',
  summary:
    "The user's files: find them (by name or kind, e.g. \"budget spreadsheet\", \"pdfs from last week\"), recent ones, open one, show it in Finder, read what's in it, move it to a folder, rename it, or put it in the Trash (never deleted for good). Put it in request.",
  tier: 1,
  async prepare(ctx) {
    const req = parseFiles(ctx.utterance);
    const hands = ctx.hands;
    if (!req || !hands) return { req, hits: [] } satisfies FilesPrepared;
    const hits =
      req.action === 'recent'
        ? await hands.files.recent({ kind: req.kind, folder: req.folder, days: req.days ?? 7 }, 8)
        : req.query || req.kind || req.folder
          ? await hands.files.find({ query: req.query, kind: req.kind, folder: req.folder, days: req.days }, 8)
          : [];
    const destination = req.action === 'move' && req.destination ? await hands.files.folder(req.destination) : undefined;
    return { req, hits, destination } satisfies FilesPrepared;
  },
  destructive: (ctx) => prepared(ctx).req?.action === 'trash',
  tierFor(ctx) {
    const { req } = prepared(ctx);
    if (!req) return 0;
    if (req.action === 'move' || req.action === 'rename' || req.action === 'trash') return 2;
    const asked = userAsked(ctx, (said) => parseFiles(said)?.action === req.action);
    if (req.action === 'find' || req.action === 'recent') return asked ? 0 : 1;
    if (req.action === 'read') return asked ? 0 : 2;
    return asked ? 1 : 2;
  },
  confirmPrompt(ctx) {
    const { req, hits, destination } = prepared(ctx);
    const hit = hits[0];
    if (!req || !hit) return 'Go ahead with that?';
    if (req.action === 'move') return `Move ${hit.name} from ${hit.folder || 'your home folder'} to ${destination ? destination.split('/').pop() : req.destination}?`;
    if (req.action === 'rename') return `Rename ${hit.name} to ${withExtension(req.newName!, hit.name)}?`;
    if (req.action === 'trash') return `Put ${hitSaid(hit)} in the Trash?`;
    if (req.action === 'read') return `${ctx.caller ?? 'The brain'} wants to read ${hit.name}. Allow it?`;
    return `Open ${hit.name}?`;
  },
  examples: ['find my resume', 'open the budget spreadsheet', 'show me my recent downloads', 'move the invoice to documents', 'rename report.pdf to final report', 'trash the screenshot on my desktop'],
  async run(ctx) {
    const hands = ctx.hands;
    if (!hands) return noHands('your files');
    const { req, hits, destination } = prepared(ctx);
    if (!req) return { say: 'Which file?', activity: 'Files: which' };
    const now = ctx.platform.now();
    const lines = (all: FileHit[]) => all.map((h) => `${h.path} (${h.kind ?? 'file'}, changed ${ago(h.modified, now)})`).join('\n');
    if (req.action === 'find' || req.action === 'recent') {
      if (!hits.length) return { say: `I couldn't find ${req.action === 'recent' ? 'anything recent' : `anything like ${req.query ?? req.kind ?? 'that'}`}.`, data: 'No files found.', activity: 'Files: nothing found' };
      const said = hits.slice(0, 3).map((h) => `${hitSaid(h)}, ${ago(h.modified, now)}`);
      return {
        say: `${hits.length === 1 ? 'I found one' : `I found ${hits.length}${hits.length > 3 ? ' - the latest' : ''}`}: ${said.join('; ')}.`,
        data: lines(hits),
        card: { id: `files-${Date.now()}`, kind: 'answer', title: req.action === 'recent' ? 'Recent files' : `Files like “${req.query ?? req.kind ?? ''}”`, body: hits.map((h) => `${h.name} · ${h.folder || '~'} · ${ago(h.modified, now)}`).join('\n') },
        activity: `Found ${hits.length} ${hits.length === 1 ? 'file' : 'files'}`,
      };
    }
    const hit = hits[0];
    if (!hit) return { say: `I couldn't find ${req.query ?? req.kind ?? 'that file'}.`, data: 'No such file.', activity: 'Files: not found' };
    switch (req.action) {
      case 'open':
        await hands.files.open(hit.path);
        return { say: `Opening ${hit.name}.`, activity: `Opened ${hit.name}` };
      case 'reveal':
        await hands.files.reveal(hit.path);
        return { say: `Here's ${hit.name} in Finder.`, activity: `Showed ${hit.name} in Finder` };
      case 'read': {
        const text = await hands.files.read(hit.path, 20_000);
        return {
          say: `I read ${hit.name}.`,
          data: `The text of ${hit.path}:\n"""\n${text}\n"""`,
          handoff: `The user asked: "${ctx.heard ?? ctx.utterance}". Here is the text of their file ${hit.name}, to answer from:\n"""\n${text.slice(0, 12_000)}\n"""`,
          activity: `Read ${hit.name}`,
        };
      }
      case 'move': {
        if (!destination) return { say: `I don't know a folder called ${req.destination}.`, activity: `Files: no folder ${req.destination}` };
        const to = await hands.files.move(hit.path, destination);
        return { say: `Moved ${hit.name} to ${destination.split('/').pop()}.`, activity: `Moved ${hit.name} to ${destination.split('/').pop()}`, undo: { kind: 'file-move', from: hit.path, to } };
      }
      case 'rename': {
        const to = await hands.files.rename(hit.path, withExtension(req.newName!, hit.name));
        return { say: `Renamed it ${to.split('/').pop()}.`, activity: `Renamed ${hit.name} to ${to.split('/').pop()}`, undo: { kind: 'file-move', from: hit.path, to } };
      }
      case 'trash': {
        const trashed = await hands.files.trash(hit.path);
        return { say: `${hit.name} is in the Trash - say "undo that" to bring it back.`, activity: `Put ${hit.name} in the Trash`, undo: { kind: 'file-untrash', trashed, original: hit.path } };
      }
    }
    return { say: 'Done.', activity: 'Files' };
  },
};

// ---------------------------------------------------------------------------
// Clipboard

const clipboardSkill: Skill = {
  id: 'clipboard',
  summary: "The clipboard: what's copied (never what a password manager hides), or copy something - the last answer, the page's address, or given text. Put it in request.",
  tier: 1,
  tierFor(ctx) {
    const req = parseClipboard(ctx.utterance);
    const asked = userAsked(ctx, (said) => parseClipboard(said) !== null);
    if (!req || req.action === 'read') return asked ? 0 : 2; // what's copied can be private
    return asked ? 1 : 2;
  },
  confirmPrompt: (ctx) => (parseClipboard(ctx.utterance)?.action === 'read' ? `${ctx.caller ?? 'The brain'} wants to read your clipboard. Allow it?` : 'Copy that to the clipboard?'),
  examples: ["what's on my clipboard", 'copy that', 'copy your answer', 'copy the link', 'what did i copy'],
  async run(ctx) {
    const hands = ctx.hands;
    if (!hands) return noHands('the clipboard');
    const req = parseClipboard(ctx.utterance) ?? { action: 'read' as const };
    if (req.action === 'read') {
      const got = await hands.clipboard.read();
      if (got.concealed) return { say: "That's marked private - a password, most likely - so I won't read it.", data: 'The clipboard holds something marked concealed (a password manager); not read.', activity: 'Clipboard: private' };
      if (got.files?.length) return { say: `You copied ${got.files.length === 1 ? 'a file' : `${got.files.length} files`}: ${list(got.files.slice(0, 3).map((f) => f.split('/').pop()!))}.`, data: got.files.join('\n'), activity: 'Read the clipboard' };
      if (!got.text) return { say: got.image ? 'You copied a picture.' : 'The clipboard is empty.', activity: 'Read the clipboard' };
      const text = got.text.trim();
      return {
        say: text.length > 240 ? `You copied ${text.split(/\s+/).length} words, starting “${text.slice(0, 120)}…”` : `You copied: “${text}”`,
        data: `The clipboard:\n"""\n${text.slice(0, 20_000)}\n"""`,
        card: { id: `clip-${Date.now()}`, kind: 'answer', title: 'Clipboard', body: text.slice(0, 4000) },
        activity: 'Read the clipboard',
      };
    }
    const text = req.action === 'copy-text' ? req.text : req.action === 'copy-page' ? await hands.pageAddress?.() : ctx.lastReply;
    if (!text) return { say: req.action === 'copy-page' ? "I can't see a page address in front." : "There's nothing to copy yet.", activity: 'Clipboard: nothing to copy' };
    const before = await hands.clipboard.read().catch(() => ({}) as { text?: string; concealed?: boolean });
    await hands.clipboard.write(text);
    return {
      say: req.action === 'copy-page' ? 'Copied the link.' : 'Copied.',
      activity: req.action === 'copy-page' ? 'Copied the page address' : 'Copied to the clipboard',
      undo: before.text && !before.concealed ? { kind: 'clipboard-set', text: before.text } : undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// Shortcuts

interface ShortcutsPrepared {
  names: string[];
}

const shortcutSkill: Skill = {
  id: 'run_shortcut',
  summary: 'Run one of the user\'s own Shortcuts (the Shortcuts app) by name, with text to give it if it takes some ("run translate with good morning"), or list them. Put it in request.',
  tier: 2,
  prepare: async (ctx) => ({ names: (await ctx.hands?.shortcuts.list().catch(() => [])) ?? [] }) satisfies ShortcutsPrepared,
  tierFor(ctx) {
    const req = parseShortcutRequest(ctx.utterance, (ctx.prepared as ShortcutsPrepared | undefined)?.names ?? []);
    return !req || req.action === 'list' || !req.name ? 0 : 2;
  },
  confirmPrompt(ctx) {
    const req = parseShortcutRequest(ctx.utterance, (ctx.prepared as ShortcutsPrepared | undefined)?.names ?? []);
    return `Run your “${req?.name ?? 'that'}” shortcut${req?.input ? ` with “${req.input}”` : ''}?`;
  },
  rememberAs(ctx) {
    const req = parseShortcutRequest(ctx.utterance, (ctx.prepared as ShortcutsPrepared | undefined)?.names ?? []);
    return req?.name ? { key: `shortcut:${req.name}`, label: `Run the “${req.name}” shortcut` } : null;
  },
  examples: ['run my log water shortcut', 'run the morning shortcut', 'what shortcuts do i have', 'run translate with good morning'],
  async run(ctx) {
    const hands = ctx.hands;
    if (!hands) return noHands('your Shortcuts');
    const names = (ctx.prepared as ShortcutsPrepared | undefined)?.names ?? (await hands.shortcuts.list());
    const req = parseShortcutRequest(ctx.utterance, names);
    if (!names.length) return { say: "You don't have any Shortcuts yet - make them in the Shortcuts app, and I can run them by name.", activity: 'Shortcuts: none' };
    if (!req || req.action === 'list' || !req.name) {
      const said = req?.action === 'run' ? `I couldn't find that shortcut. You have ${names.length}, like ${list(names.slice(0, 4))}.` : `You have ${names.length === 1 ? 'one shortcut' : `${names.length} shortcuts`}: ${list(names.slice(0, 6))}${names.length > 6 ? ', and more' : ''}.`;
      return { say: said, data: names.join('\n'), activity: 'Listed Shortcuts' };
    }
    const done = await hands.shortcuts.run(req.name, req.input);
    const output = done.output?.trim();
    return {
      say: output ? (output.length > 300 ? `${output.slice(0, 300)}…` : output) : `Done - “${req.name}” ran.`,
      data: output ? `The "${req.name}" shortcut ran and gave back:\n${output}` : `The "${req.name}" shortcut ran.`,
      activity: `Ran the “${req.name}” shortcut`,
    };
  },
};

// ---------------------------------------------------------------------------
// The user's own commands for the app in front, and whole tasks on the computer

const keysSaid = (keys: string) =>
  keys
    .split('+')
    .map((k) => ({ cmd: 'command', ctrl: 'control', alt: 'option', shift: 'shift', fn: 'function' })[k] ?? (k.length === 1 ? k.toUpperCase() : k))
    .join(' ');

interface UiPrepared {
  req: UiRequest | null;
  found?: Awaited<ReturnType<NonNullable<SkillContext['hands']>['computer']['find']>>;
  /** Why the window couldn't be read (Nova Eyes without Accessibility). */
  problem?: string;
}

const clicks = (req: UiRequest | null) => Boolean(req && (req.action === 'click' || req.action === 'double-click' || req.action === 'right-click') && req.target);

const uiSkill: Skill = {
  id: 'ui_control',
  summary: "The user's own commands for the app in front: click something by name (\"click send\"), type text, press keys (\"command s\"), scroll. Brains use the computer_ tools instead.",
  tier: 1,
  async prepare(ctx) {
    const req = parseUi(ctx.utterance);
    if (!clicks(req) || !ctx.hands) return { req } satisfies UiPrepared;
    try {
      return { req, found: await ctx.hands.computer.find(req!.target!) } satisfies UiPrepared;
    } catch (e) {
      return { req, problem: (e as Error).message } satisfies UiPrepared;
    }
  },
  tierFor: (ctx) => (userAsked(ctx, (said) => parseUi(said) !== null) ? 1 : 2),
  confirmPrompt: (ctx) => `${ctx.caller ?? 'The brain'} wants to ${ctx.utterance}. Allow it?`,
  // A brain asking to click something by name: the button is framed on screen while the user is asked.
  preview: async (ctx) => {
    const found = (ctx.prepared as UiPrepared | undefined)?.found;
    if (found && 'element' in found) return ctx.hands?.computer.preview({ kind: 'click', element: found.element });
  },
  examples: ['click send', 'type hello world', 'press command s', 'scroll down', 'press enter', 'double click the report'],
  async run(ctx) {
    const hands = ctx.hands;
    if (!hands) return noHands('the screen');
    const { req, found, problem } = (ctx.prepared ?? { req: parseUi(ctx.utterance) }) as UiPrepared;
    if (!req) return { say: 'What should I click or type?', activity: 'Screen: what' };
    if (problem) return { say: problem, data: problem, activity: `Couldn't look for “${req.target}”` };
    const computer = hands.computer;
    const by = ctx.caller; // the user's own command has no caller: it never waits for them to stop typing
    switch (req.action) {
      case 'click':
      case 'double-click':
      case 'right-click': {
        if (found && 'element' in found) {
          await computer.act({ kind: 'click', element: found.element, count: req.action === 'double-click' ? 2 : 1, button: req.action === 'right-click' ? 'right' : 'left' }, by);
          return { say: `${req.action === 'double-click' ? 'Double-clicked' : req.action === 'right-click' ? 'Right-clicked' : 'Clicked'} “${found.label}”.`, activity: `Clicked “${found.label}” in ${found.app}` };
        }
        if (found && 'several' in found) return { say: `I see several: ${list(found.several.slice(0, 4).map((l) => `“${l}”`))}. Which one?`, activity: `Several like “${req.target}”` };
        // Not by name: a brain can look at the screen for it (and asks before clicking).
        return {
          say: `I can't find “${req.target}” in ${(await computer.front()) ?? 'the window in front'}.`,
          handoff: `On the user's screen, ${req.action.replace('-', ' ')} “${req.target}” (they said: "${ctx.heard ?? ctx.utterance}"). Use computer_look to find it, then computer_click. Say briefly what you did.`,
          activity: `Looked for “${req.target}”`,
        };
      }
      case 'type':
        await computer.act({ kind: 'type', text: req.text!, submit: req.submit }, by);
        return { say: 'Typed it.', activity: `Typed in ${(await computer.front()) ?? 'the window in front'}` };
      case 'key':
        await computer.act({ kind: 'key', keys: req.keys!, count: req.count }, by);
        return { say: `Pressed ${keysSaid(req.keys!)}${(req.count ?? 1) > 1 ? ` ${req.count} times` : ''}.`, activity: `Pressed ${keysSaid(req.keys!)}` };
      case 'select-all':
        await computer.act({ kind: 'key', keys: 'cmd+a' }, by);
        return { say: 'Selected everything.', activity: 'Selected all' };
      case 'scroll':
        await computer.act({ kind: 'scroll', direction: req.direction!, amount: req.amount }, by);
        return { say: req.direction === 'top' || req.direction === 'bottom' ? `At the ${req.direction}.` : `Scrolled ${req.direction}.`, activity: `Scrolled ${req.direction}` };
    }
  },
};

/** What a brain is told when it's given a task to do on the computer. */
export const computerBrief = (task: string, said: string) =>
  `Do this for the user on their Mac, by using the computer: ${task}\n(They said: "${said}".)\n\n` +
  'Use computer_look to see the screen - a picture, and the things on it to click or type in, each with an id. Then act one step at a time with ' +
  'computer_click, computer_type, computer_key and computer_scroll (open_app brings an app forward), and look again after each step to see what changed. ' +
  'Nova checks with the user where it needs to (anything that spends money, for one). Never type passwords, card numbers or other ' +
  'secrets - stop and ask the user to do that part themselves. If a page asks for something you do not know, ask the user. When you are done, say in one ' +
  'or two sentences what you did.';

const computerTaskSkill: Skill = {
  id: 'computer_task',
  summary: 'Do a whole task on the computer for the user - a brain looks at the screen and clicks and types, one step at a time.',
  tier: 2,
  session: () => ({ key: 'computer', label: 'Use the computer for this task' }),
  confirmPrompt: (ctx) => `Use the computer to ${computerTask(ctx.utterance) || 'do that'}? I'll ask before each click and anything I type - or say "go ahead with all of it".`,
  examples: ['use the computer to book a table', 'take over and fill in this form', 'use my mac to order more coffee pods', 'do it for me on the screen'],
  async run(ctx) {
    if (!ctx.hands) return noHands('the screen');
    const task = computerTask(ctx.utterance) || ctx.utterance;
    return { say: `I can't use the computer without a brain - pair Claude, or choose one in Settings → Answers.`, handoff: computerBrief(task, ctx.heard ?? ctx.utterance), activity: `Computer task: ${task}` };
  },
};

export const handsSkills: Skill[] = [systemSkill, mediaSkill, windowSkill, filesSkill, clipboardSkill, shortcutSkill, uiSkill, computerTaskSkill];
