/**
 * Nova's hands, read from what was said - in code, like times in when.ts: which setting and how
 * much, which window goes where, which keys, which file. Reflex decides the kind of request; these
 * work out its details. Dependency-free.
 */

import { aliasesFor, matchName, nameTokens } from './decision/reflex/names.ts';

// ---------------------------------------------------------------------------
// Numbers and names

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, half: 50, once: 1, twice: 2, thrice: 3,
};

/** "30", "thirty", "thirty five", "a hundred", "half" - the first number in the text, or null. */
export function numberIn(text: string): number | null {
  const digits = /(\d+(?:\.\d+)?)/.exec(text);
  if (digits) return Number(digits[1]);
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  for (let i = 0; i < words.length; i++) {
    const n = NUMBER_WORDS[words[i]!];
    if (n === undefined || (words[i] === 'one' && /\b(?:this|that|which|the)\s+one\b/i.test(text))) continue;
    if (n === 100 && (words[i - 1] === 'a' || words[i - 1] === 'one')) return 100;
    const next = NUMBER_WORDS[words[i + 1] ?? ''];
    if (n >= 20 && n < 100 && next !== undefined && next < 10) return n + next;
    return n;
  }
  return null;
}

/** The best of `names` that the text names (an app, a shortcut), as NovaBrain matches apps. */
export function findNamed(text: string, names: readonly string[], min = 0.6): string | null {
  const words = nameTokens(text);
  let best: { name: string; score: number } | null = null;
  for (const name of names) {
    const m = matchName(words, aliasesFor(name));
    if (m && m.score >= min && (!best || m.score > best.score || (m.score === best.score && name.length > best.name.length))) best = { name, score: m.score };
  }
  return best?.name ?? null;
}

const clean = (s: string) => s.replace(/^[\s,.:;"'“”]+|[\s,.!?;"'“”]+$/g, '').trim();
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

// ---------------------------------------------------------------------------
// System settings

export type SystemSetting = 'volume' | 'brightness' | 'dark-mode' | 'wifi' | 'bluetooth' | 'focus' | 'lock' | 'sleep' | 'battery';

export interface SystemRequest {
  setting: SystemSetting;
  /** query: say how it is. up/down: by `value` (a step when none was said). set: to `value` (0-100). */
  action: 'query' | 'set' | 'up' | 'down' | 'on' | 'off' | 'toggle' | 'mute' | 'unmute' | 'now';
  value?: number;
}

const QUESTION = /^(?:what(?:'s| is)|how(?:'s| is| much| high| loud| bright)|is|are|am i|do i have|tell me|check)\b|\?\s*$/i;

/** How much "a bit" or "a lot" is, for the volume and brightness. */
function step(text: string) {
  if (/\b(?:a (?:little )?bit|slightly|a (?:little|touch|tad|notch)|little)\b/i.test(text)) return 5;
  if (/\b(?:a lot|way|much|loads)\b/i.test(text)) return 25;
  return 10;
}

function level(text: string, setting: 'volume' | 'brightness'): SystemRequest | null {
  const n = numberIn(text);
  const percent = n !== null && /\bhalf\b/i.test(text) && !/\d/.test(text) ? 50 : n;
  if (/\b(?:unmute|un-mute)\b/i.test(text) && setting === 'volume') return { setting, action: 'unmute' };
  if (/\bmute\b|\bsilen(?:t|ce)\b/i.test(text) && setting === 'volume') return { setting, action: 'mute' };
  if (/\b(?:max(?:imum)?|full(?:y)?|all the way up|highest|100 ?%)\b/i.test(text) && !/\bby\b/i.test(text)) return { setting, action: 'set', value: 100 };
  if (/\b(?:min(?:imum)?|lowest|all the way down)\b/i.test(text)) return { setting, action: 'set', value: setting === 'volume' ? 0 : 5 };
  const up = /\b(?:up|higher|louder|increase|raise|boost|brighter|more|turn it up)\b/i.test(text);
  const down = /\b(?:down|lower|quieter|softer|decrease|reduce|dim(?:mer)?|darker|less|turn it down)\b/i.test(text);
  if (percent !== null && /\bby\b/i.test(text) && (up || down)) return { setting, action: up && !down ? 'up' : 'down', value: clamp(percent) };
  if (percent !== null && (/\b(?:to|at)\b/i.test(text) || /%|percent/i.test(text) || !(up || down))) return { setting, action: 'set', value: clamp(percent) };
  if (up && !down) return { setting, action: 'up', value: step(text) };
  if (down && !up) return { setting, action: 'down', value: step(text) };
  if (QUESTION.test(text.trim())) return { setting, action: 'query' };
  return null;
}

function toggle(text: string, setting: SystemSetting): SystemRequest {
  if (QUESTION.test(text.trim()) && !/\b(?:turn|switch|put|set|make|enable|disable|toggle)\b/i.test(text)) return { setting, action: 'query' };
  if (/\btoggle\b/i.test(text)) return { setting, action: 'toggle' };
  if (/\b(?:off|disable|disconnect|stop|deactivate|end|leave|exit|no more|without)\b/i.test(text)) return { setting, action: 'off' };
  if (/\b(?:on|enable|connect|start|activate|turn it on|enter|go into)\b/i.test(text)) return { setting, action: 'on' };
  return { setting, action: 'toggle' };
}

/**
 * The volume, the screen's brightness, dark mode, Wi-Fi, Bluetooth, Focus, locking or sleeping the
 * Mac, the battery - and what to do with it. Null when the text is about none of them.
 */
export function parseSystem(text: string): SystemRequest | null {
  const t = text.toLowerCase();
  if (/\b(?:battery|charg(?:e|ed|ing)|power left|plugged in)\b/.test(t)) return { setting: 'battery', action: 'query' };
  if (/\block\b.*\b(?:screen|mac|computer|laptop|macbook|it|up)\b|\block (?:the|my) (?:screen|mac|computer)\b|^lock(?: it)?(?: please)?$/.test(t)) {
    return { setting: 'lock', action: 'now' };
  }
  // "Go to sleep" is Nova's microphone (stop listening); sleep here is the Mac itself.
  if (/\b(?:(?:put|send) (?:the |my |this )?(?:mac|computer|laptop|macbook)(?: to| into)? sleep|sleep (?:the |my )?(?:mac|computer|laptop|macbook)|(?:mac|computer|laptop|macbook) (?:go )?to sleep)\b/.test(t)) {
    return { setting: 'sleep', action: 'now' };
  }
  if (/\b(?:dark mode|light mode|dark theme|light theme|dark appearance|night mode)\b/.test(t)) {
    if (/\blight (?:mode|theme)\b/.test(t) && !QUESTION.test(t.trim())) return { setting: 'dark-mode', action: /\b(?:off|disable)\b/.test(t) ? 'on' : 'off' };
    return toggle(t, 'dark-mode');
  }
  if (/\bwi-?fi\b|\bwireless\b|\binternet connection\b/.test(t)) return toggle(t, 'wifi');
  if (/\bbluetooth\b/.test(t)) return toggle(t, 'bluetooth');
  if (/\b(?:do not disturb|don'?t disturb|dnd|focus(?: mode)?|quiet mode|notifications? (?:off|on))\b/.test(t) && !/\bfocus (?:on )?(?:the |my )?(?:window|app)\b/.test(t)) {
    if (/\bnotifications? off\b/.test(t)) return { setting: 'focus', action: 'on' };
    if (/\bnotifications? on\b/.test(t)) return { setting: 'focus', action: 'off' };
    return toggle(t, 'focus');
  }
  if (/\b(?:bright(?:ness|er)?|dim(?:mer)?|display light|screen light)\b/.test(t) || (/\bdarker\b/.test(t) && /\bscreen\b/.test(t))) return level(t, 'brightness') ?? { setting: 'brightness', action: 'query' };
  if (/\b(?:volume|sound|audio|loud(?:er|ness)?|quieter|softer|mute|unmute|speakers?)\b/.test(t) || /^turn it (?:up|down)\b/.test(t)) return level(t, 'volume');
  return null;
}

// ---------------------------------------------------------------------------
// Media

export interface MediaRequest {
  action: 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'now-playing' | 'play-query';
  /** What to play: a song, an artist, an album or a playlist. */
  query?: string;
  /** The player named, if one was. */
  app?: 'Music' | 'Spotify';
}

/** Play, pause, skip, what's playing - or "play some jazz" (from the Music library). */
export function parseMedia(text: string): MediaRequest | null {
  const t = text.toLowerCase().trim();
  const app = /\bspotify\b/.test(t) ? 'Spotify' : /\b(?:apple music|itunes|the music app)\b/.test(t) ? 'Music' : undefined;
  const said = (req: MediaRequest): MediaRequest => (app ? { ...req, app } : req);
  if (/\b(?:what(?:'s| is)(?: this| that)? (?:song|track|playing|on)|what song|which song|who(?:'s| is) (?:this|singing|playing)|name (?:of )?this song|now playing)\b/.test(t)) return said({ action: 'now-playing' });
  if (/\b(?:next|skip)\b/.test(t) && !/\bprevious\b/.test(t)) return said({ action: 'next' });
  if (/\b(?:previous|last (?:song|track)|go back (?:a|one) (?:song|track)|back a (?:song|track)|replay|start (?:this|the) (?:song|track) (?:again|over))\b/.test(t)) return said({ action: 'previous' });
  if (/\b(?:pause|hold)\b/.test(t) && !/\bmicrophone|\bmic\b|\blistening\b/.test(t)) return said({ action: 'pause' });
  if (/\b(?:stop|turn off|kill)\b.*\b(?:music|song|track|playback|spotify|podcast|audio)\b/.test(t)) return said({ action: 'pause' });
  if (/\b(?:resume|unpause|keep playing|continue playing|carry on playing)\b/.test(t)) return said({ action: 'play' });
  const play = /^(?:please |can you |could you |hey )?(?:play|put on|queue up|shuffle|listen to)\b\s*(.*)$/.exec(t);
  if (play) {
    const rest = clean(play[1]!.replace(/\b(?:on|in|from|using) (?:spotify|apple music|itunes|the music app|music)\b/g, '').replace(/\b(?:for me|please|now|again)\b/g, ''));
    if (!rest || /^(?:it|the music|music|something|a song|some music|the song|that|this)$/.test(rest)) return said({ action: 'play' });
    return said({ action: 'play-query', query: rest.replace(/^(?:some|a little|the|my)\s+/, '').replace(/\s+(?:music|songs)$/, '') || rest });
  }
  if (/^(?:music|the music|playback|play pause|toggle (?:the )?music)$/.test(t)) return said({ action: 'toggle' });
  return null;
}

// ---------------------------------------------------------------------------
// Windows

export type WindowPosition =
  | 'left' | 'right' | 'top' | 'bottom'
  | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  | 'left-third' | 'center-third' | 'right-third' | 'left-two-thirds' | 'right-two-thirds'
  | 'maximize' | 'center' | 'almost-maximize';

export interface WindowPlacement {
  /** The app whose window it is; none for the window in front. */
  app?: string;
  position: WindowPosition;
}

export interface WindowRequest {
  action: 'place' | 'other-display' | 'minimize' | 'fullscreen' | 'exit-fullscreen' | 'hide' | 'show-all' | 'save-layout' | 'layout' | 'list';
  /** For place: one window or several ("Safari on the left and Slack on the right"). */
  placements?: WindowPlacement[];
  app?: string;
  /** A saved layout's name. */
  layout?: string;
}

const POSITIONS: [RegExp, WindowPosition][] = [
  [/\b(?:top|upper)[- ]left\b|\bleft top\b/, 'top-left'],
  [/\b(?:top|upper)[- ]right\b|\bright top\b/, 'top-right'],
  [/\b(?:bottom|lower)[- ]left\b|\bleft bottom\b/, 'bottom-left'],
  [/\b(?:bottom|lower)[- ]right\b|\bright bottom\b/, 'bottom-right'],
  [/\bleft two[- ]thirds\b|\btwo[- ]thirds (?:on the )?left\b/, 'left-two-thirds'],
  [/\bright two[- ]thirds\b|\btwo[- ]thirds (?:on the )?right\b/, 'right-two-thirds'],
  [/\bleft third\b|\bthird (?:on the )?left\b/, 'left-third'],
  [/\bright third\b|\bthird (?:on the )?right\b/, 'right-third'],
  [/\b(?:middle|center|centre) third\b/, 'center-third'],
  [/\balmost (?:maximi[sz]ed?|full)\b/, 'almost-maximize'],
  [/\b(?:maximi[sz]e[ds]?|fill the screen|full size|as big as possible|biggest|whole screen|take up the (?:whole|entire) screen|bigger|make (?:it|this) big)\b/, 'maximize'],
  [/\b(?:center|centre|middle)\b/, 'center'],
  [/\bleft\b/, 'left'],
  [/\bright\b/, 'right'],
  [/\b(?:top|upper) half\b|\bto the top\b|\bon top\b/, 'top'],
  [/\b(?:bottom|lower) half\b|\bto the bottom\b/, 'bottom'],
];

const positionIn = (text: string): WindowPosition | null => POSITIONS.find(([re]) => re.test(text))?.[1] ?? null;

/**
 * Where windows go ("Safari on the left", "maximize this", "Slack left, Mail right"), sending one
 * to the other display, minimizing, full screen, hiding - and saved layouts ("save this as my work
 * layout", "my work layout"). `apps` are the ones running, to recognise names.
 */
export function parseWindow(text: string, apps: readonly string[] = []): WindowRequest | null {
  const t = text.toLowerCase().trim();
  const save = /\bsave (?:this|the|my|these|current)?\s*(?:window )?(?:layout|arrangement|setup|windows)(?: as| called)? (?:my |the )?(.+?)(?: layout| arrangement| setup)?$/.exec(t) ??
    /\bsave (?:this|these windows) as (?:my |the )?(.+?)(?: layout)?$/.exec(t) ??
    /\bremember (?:this|these|my) (?:window )?(?:layout|arrangement|windows) as (?:my |the )?(.+?)(?: layout)?$/.exec(t);
  if (save) return { action: 'save-layout', layout: clean(save[1]!) };
  const recall = /^(?:(?:set up|arrange|restore|load|use|go to|switch to|open|apply|back to|bring back)\s+(?:my|the)\s+)(.+?)\s+(?:layout|arrangement|setup|windows)$/.exec(t) ??
    /^(?:my\s+)?(.+?)\s+layout(?: please)?$/.exec(t) ??
    /\b(?:set up|arrange) (?:my|the) windows for (.+)$/.exec(t);
  if (recall && !/\b(?:save|remember)\b/.test(t)) return { action: 'layout', layout: clean(recall[1]!) };
  if (/\b(?:what|which) (?:windows|apps) (?:are|do i have)(?: open)?\b|\blist (?:my |the )?windows\b/.test(t)) return { action: 'list' };

  const app = (part: string) => {
    const named = findNamed(part, apps);
    return named && !/^(?:this|the|my)\s+window$/.test(part) ? named : undefined;
  };
  if (/\b(?:other|next|second|external|main|built-?in) (?:screen|display|monitor)\b|\b(?:screen|display|monitor) (?:two|2|one|1)\b/.test(t) && /\b(?:move|put|send|throw|take|drag|bring)\b/.test(t)) {
    return { action: 'other-display', app: app(t) };
  }
  if (/\b(?:exit|leave|get out of|stop|turn off|no more|un-?)\s*full[- ]?screen\b/.test(t)) return { action: 'exit-fullscreen', app: app(t) };
  if (/\bfull[- ]?screen\b/.test(t)) return { action: 'fullscreen', app: app(t) };
  if (/\bminimi[sz]e\b|\bto the dock\b/.test(t)) return { action: 'minimize', app: app(t) };
  if (/\bshow (?:all|every)(?:thing| windows| apps)?\b|\bunhide\b/.test(t)) return { action: 'show-all' };
  if (/^(?:please )?hide\b/.test(t) && !/\bhide and seek\b/.test(t)) return { action: 'hide', app: app(t) };

  // One or several windows, each to its place: "Safari on the left and Slack on the right".
  const parts = t.split(/\s*(?:,|\band\b|\bthen\b|;)\s*/).filter(Boolean);
  const placements: WindowPlacement[] = [];
  for (const part of parts) {
    const position = positionIn(part);
    if (!position) continue;
    placements.push({ app: app(part), position });
  }
  const aboutWindows = placements.some((p) => p.app) || /\b(?:put|move|snap|tile|place|split|make|maximi[sz]e|center|centre|window|windows|screen|half|side|corner|third|arrange)\b/.test(t);
  if (placements.length && aboutWindows) return { action: 'place', placements };
  return null;
}

// ---------------------------------------------------------------------------
// Keys, clicks, typing, scrolling - the user's own commands for the app in front

const KEY_NAMES: Record<string, string> = {
  enter: 'return', return: 'return', 'new line': 'return', tab: 'tab', escape: 'escape', esc: 'escape', space: 'space', 'space bar': 'space', spacebar: 'space',
  backspace: 'delete', delete: 'delete', 'forward delete': 'forwarddelete', up: 'up', down: 'down', left: 'left', right: 'right',
  'up arrow': 'up', 'down arrow': 'down', 'left arrow': 'left', 'right arrow': 'right', home: 'home', end: 'end', 'page up': 'pageup', 'page down': 'pagedown',
  comma: ',', period: '.', 'full stop': '.', dot: '.', slash: '/', minus: '-', dash: '-', plus: '=', equals: '=', 'left bracket': '[', 'right bracket': ']',
  semicolon: ';', quote: "'", backtick: '`', backslash: '\\',
};
const MODIFIER_NAMES: Record<string, string> = { command: 'cmd', cmd: 'cmd', control: 'ctrl', ctrl: 'ctrl', option: 'alt', alt: 'alt', shift: 'shift', function: 'fn', fn: 'fn' };

/** "command shift t", "hit enter twice", "control c" as a combo Nova Eyes presses: { keys: "cmd+shift+t", count }. */
export function parseKeys(text: string): { keys: string; count: number } | null {
  let t = ` ${text.toLowerCase().replace(/[+,]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  t = t.replace(/^ (?:please )?(?:press|hit|tap|type|push|do|use|send)(?: the)? /, ' ').replace(/ (?:key|keys|button)(?= |$)/g, ' ');
  const count = /\b(?:twice|two times)\b/.test(t) ? 2 : /\b(?:three times|thrice)\b/.test(t) ? 3 : (() => {
    const m = /\b(\d+|two|three|four|five|six|seven|eight|nine|ten) times\b/.exec(t);
    return m ? (numberIn(m[1]!) ?? 1) : 1;
  })();
  t = t.replace(/\b(?:twice|thrice|\w+ times)\b/g, ' ');
  const mods: string[] = [];
  for (const [name, mod] of Object.entries(MODIFIER_NAMES)) {
    const re = new RegExp(` ${name} `, 'g');
    if (re.test(t)) {
      if (!mods.includes(mod)) mods.push(mod);
      t = t.replace(re, ' ');
    }
  }
  const rest = t.trim();
  let key: string | undefined = KEY_NAMES[rest];
  if (!key && /^[a-z0-9]$/.test(rest)) key = rest;
  if (!key && /^f(\d{1,2})$/.test(rest)) key = rest;
  if (!key) return null;
  const order = ['ctrl', 'alt', 'shift', 'cmd', 'fn'];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { keys: [...mods, key].join('+'), count: Math.min(count, 20) };
}

export interface UiRequest {
  action: 'click' | 'double-click' | 'right-click' | 'type' | 'key' | 'scroll' | 'select-all';
  /** What to click, as said: "send", "the reply button". */
  target?: string;
  text?: string;
  keys?: string;
  count?: number;
  direction?: 'up' | 'down' | 'left' | 'right' | 'top' | 'bottom';
  /** How far to scroll, in steps. */
  amount?: number;
  /** "Type … and press enter". */
  submit?: boolean;
}

/** The user's own commands for the app in front: "click send", "type hello", "press command s", "scroll down". */
export function parseUi(text: string): UiRequest | null {
  const raw = text.trim().replace(/[.!]+$/, '');
  const t = raw.toLowerCase();
  const scroll = /^(?:please )?(?:scroll|page|go|jump|move)\s*(up|down|left|right|to the top|to the bottom|back to the top|all the way (?:up|down)|top|bottom)?\b(.*)$/.exec(t);
  if (scroll && (/^(?:please )?scroll\b/.test(t) || /\b(?:top|bottom) of (?:the )?(?:page|document|list)\b/.test(t) || /^(?:page) (?:up|down)$/.test(t))) {
    const where = `${scroll[1] ?? ''} ${scroll[2] ?? ''}`;
    const direction = /top|all the way up/.test(where) ? 'top' : /bottom|all the way down/.test(where) ? 'bottom' : /up/.test(where) ? 'up' : /left/.test(where) ? 'left' : /right/.test(where) ? 'right' : 'down';
    const amount = /\b(?:a (?:little )?bit|slightly|a little)\b/.test(t) ? 2 : /\b(?:a lot|way|much|far)\b/.test(t) ? 15 : (numberIn(where) ?? 6);
    return { action: 'scroll', direction, amount: Math.min(amount, 50) };
  }
  if (/^(?:please )?select all\b/.test(t)) return { action: 'select-all' };
  const submitted = /\s*,?\s*(?:and|then) (?:press|hit) (?:enter|return)$/i;
  const type = /^(?:please )?(?:type|write|enter|input|put in|fill in)\s+(?:in |out )?(?:the (?:words?|text) )?(.+)$/i.exec(raw.replace(submitted, ''));
  if (type && !/^(?:press|hit)\b/.test(t)) {
    const words = type[1]!
      .replace(/\s+(?:in|into) (?:the|this) (?:box|field|search(?: bar| box| field)?|text ?box)$/i, '')
      .replace(/^["“](.*)["”]$/, '$1');
    if (words.trim()) return { action: 'type', text: words.trim(), ...(submitted.test(raw) ? { submit: true } : {}) };
  }
  if (/^(?:please )?(?:press|hit|tap|push)\b/.test(t) && !/\b(?:button|link|icon|tab|menu)\b/.test(t)) {
    const keys = parseKeys(t);
    if (keys) return { action: 'key', keys: keys.keys, count: keys.count };
  }
  const plainKeys = /^(?:command|cmd|control|ctrl|option|alt|shift)\b/.test(t) ? parseKeys(t) : null;
  if (plainKeys) return { action: 'key', keys: plainKeys.keys, count: plainKeys.count };
  const click = /^(?:please )?(double[- ]?click|right[- ]?click|control[- ]click|click|tap|press|hit|select|choose|push)\s+(?:on\s+)?(.+)$/.exec(t);
  if (click) {
    const kind = /^double/.test(click[1]!) ? 'double-click' : /^(?:right|control)/.test(click[1]!) ? 'right-click' : 'click';
    const target = clean(click[2]!.replace(/^(?:the|a|an|that|this)\s+/, '').replace(/\s+(?:button|link|icon|tab|menu item|option|checkbox|box|field)$/, ''));
    if (target) return { action: kind, target };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Files

export type FileKind = 'pdf' | 'image' | 'document' | 'spreadsheet' | 'presentation' | 'folder' | 'video' | 'audio' | 'code' | 'text' | 'archive';

export interface FilesRequest {
  action: 'find' | 'open' | 'recent' | 'reveal' | 'move' | 'rename' | 'trash' | 'read';
  /** The file, as described: "budget", "the invoice from march". */
  query?: string;
  kind?: FileKind;
  /** Where to look, or where to move it: a folder name ("downloads", "desktop", a project). */
  folder?: string;
  destination?: string;
  newName?: string;
  /** How far back, in days, for recent files and "from yesterday". */
  days?: number;
}

const KINDS: [RegExp, FileKind][] = [
  [/\bpdfs?\b/, 'pdf'],
  [/\b(?:images?|photos?|pictures?|screenshots?|pngs?|jpe?gs?)\b/, 'image'],
  [/\b(?:spreadsheets?|excel|numbers file|csvs?|sheets?)\b/, 'spreadsheet'],
  [/\b(?:presentations?|slides?|decks?|keynotes?|powerpoints?)\b/, 'presentation'],
  [/\b(?:documents?|docs?|word files?|pages files?|letters?)\b/, 'document'],
  [/\b(?:folders?|directories|directory)\b/, 'folder'],
  [/\b(?:videos?|movies?|recordings?|mp4s?|screen recordings?)\b/, 'video'],
  [/\b(?:songs?|audio|mp3s?|voice memos?|podcasts?)\b/, 'audio'],
  [/\b(?:zips?|archives?)\b/, 'archive'],
  [/\b(?:text files?|notes? files?|markdown)\b/, 'text'],
];

export const KNOWN_FOLDERS: Record<string, string> = {
  desktop: 'Desktop', documents: 'Documents', downloads: 'Downloads', pictures: 'Pictures', photos: 'Pictures', music: 'Music',
  movies: 'Movies', videos: 'Movies', home: '', 'home folder': '', applications: 'Applications',
};

function daysIn(t: string): number | undefined {
  if (/\btoday\b/.test(t)) return 1;
  if (/\byesterday\b/.test(t)) return 2;
  if (/\b(?:this|past|last) week\b|\blately\b|\brecent(?:ly)?\b/.test(t)) return 7;
  if (/\b(?:this|past|last) month\b/.test(t)) return 31;
  return undefined;
}

const FILE_NOISE =
  /\b(?:my|the|a|an|some|that|this|file|files|called|named|please|for me|from (?:today|yesterday|this week|last week|last month|this month)|(?:today|yesterday)|last week|this week|last month|this month|on my|in my|in the|from my|on the|recent(?:ly)?|latest|newest|last)\b/g;

/** Words that say a file is meant (so "open the invoice" is a file, "open Slack" isn't). */
const FILE_WORDS = /\b(?:files?|pdfs?|documents?|docs?|spreadsheets?|presentations?|slides|folders?|photos?|pictures?|images?|screenshots?|videos?|recordings?|invoices?|reports?|resumes?|cvs?|downloads?|notes?|txt|csv|receipts?|contracts?|statements?)\b/;
/** A file named with its extension: "report.pdf". */
const FILENAME = /\w\.[a-z0-9]{2,5}\b/;

function describeFile(part: string) {
  let q = part.replace(new RegExp(`\\b(?:in|on|from|inside|under) (?:my |the )?(?:${Object.keys(KNOWN_FOLDERS).join('|')})(?: folder)?\\b`, 'g'), ' ');
  // A name with its extension ("report.pdf") is the name; its kind is in it.
  if (FILENAME.test(q)) return { kind: undefined, query: clean(q.replace(FILE_NOISE, ' ').replace(/\s+/g, ' ')) || undefined };
  const kind = KINDS.find(([re]) => re.test(q))?.[1];
  for (const [re] of KINDS) q = q.replace(re, ' ');
  q = q.replace(FILE_NOISE, ' ').replace(/\s+/g, ' ');
  return { kind, query: clean(q) || undefined };
}

function folderIn(t: string): string | undefined {
  const m = /\b(?:in|on|from|inside|under) (?:my |the )?([a-z0-9 _-]+?)(?: folder)?$/.exec(t);
  const name = m?.[1]?.trim();
  if (name && (Object.hasOwn(KNOWN_FOLDERS, name) || /\bfolder\b/.test(t))) return name;
  return undefined;
}

/** Finding, opening, moving, renaming and trashing files - read from what was said. */
export function parseFiles(text: string): FilesRequest | null {
  const t = text.toLowerCase().trim().replace(/[?.!]+$/, '');
  const days = daysIn(t);
  const rename = /\brename\s+(.+?)\s+(?:to|as)\s+(.+)$/.exec(t);
  if (rename) return { action: 'rename', ...describeFile(rename[1]!), newName: clean(rename[2]!.replace(/^["“]|["”]$/g, '')) };
  const move = /\b(?:move|put|file|drop|send)\s+(.+?)\s+(?:to|into|in|onto)\s+(?:my |the )?(.+?)(?: folder)?$/.exec(t);
  if (move && !/\b(?:screen|display|monitor|left|right|top|bottom|corner)\b/.test(move[2]!)) return { action: 'move', ...describeFile(move[1]!), destination: clean(move[2]!) };
  const trash = /\b(?:trash|delete|remove|bin|throw away|get rid of|throw out)\s+(.+)$/.exec(t);
  if (trash && !/\b(?:memory|reminder|routine|timer|alarm)\b/.test(t)) {
    const described = describeFile(trash[1]!.replace(/\s+(?:to|in|into) the (?:trash|bin)$/, ''));
    return { action: 'trash', ...described, folder: folderIn(trash[1]!), days };
  }
  const reveal = /\b(?:reveal|show)\s+(.+?)\s+in (?:the )?finder\b|\bwhere (?:is|are|did i (?:put|save))\s+(.+)$/.exec(t);
  if (reveal) return { action: /^where/.test(t) ? 'find' : 'reveal', ...describeFile(reveal[1] ?? reveal[2]!) };
  if (/\b(?:recent|latest|last)\s+(?:files?|downloads?|documents?|screenshots?)\b|\bwhat (?:did i|have i) (?:download|work on|save|edit)(?:ed)?\b|\bfiles? (?:i|i've) (?:worked on|opened|edited|saved|downloaded)\b/.test(t)) {
    const kind = KINDS.find(([re]) => re.test(t.replace(/\b(?:files?|documents?)\b/g, '')))?.[1];
    return { action: 'recent', kind, folder: /\bdownload/.test(t) ? 'downloads' : folderIn(t), days: days ?? 7 };
  }
  const read = /\b(?:read|summari[sz]e|what(?:'s| is) in|tell me what(?:'s| is) in|go through)\s+(.+)$/.exec(t);
  if (read && FILE_WORDS.test(read[1]!)) return { action: 'read', ...describeFile(read[1]!), folder: folderIn(read[1]!) };
  const open = /^(?:please )?(?:open|open up|pull up|bring up|show me|load)\s+(.+)$/.exec(t);
  if (open && (FILE_WORDS.test(open[1]!) || FILENAME.test(open[1]!))) {
    return { action: 'open', ...describeFile(open[1]!), folder: folderIn(open[1]!), days };
  }
  const find = /\b(?:find|search (?:for|my \w+ for)?|look for|locate|where(?:'s| is| are)|get me|show me)\s+(.+)$/.exec(t);
  if (find && (FILE_WORDS.test(find[1]!) || FILENAME.test(find[1]!))) {
    return { action: 'find', ...describeFile(find[1]!), folder: folderIn(find[1]!), days };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Clipboard and shortcuts

export interface ClipboardRequest {
  action: 'read' | 'copy-reply' | 'copy-page' | 'copy-text';
  text?: string;
}

export function parseClipboard(text: string): ClipboardRequest | null {
  const t = text.toLowerCase().trim();
  const copy = /\bcopy\s+["“](.+)["”]/i.exec(text);
  if (copy) return { action: 'copy-text', text: copy[1]! };
  if (/\bcopy\b.*\b(?:link|url|address|page)\b/.test(t)) return { action: 'copy-page' };
  if (/\bcopy\b.*\b(?:that|it|this|your answer|what you said|the answer|your reply|the reply|the last answer)\b/.test(t)) return { action: 'copy-reply' };
  if (/\b(?:clipboard|pasteboard|what did i copy|what have i copied|what(?:'s| is) copied|paste it here|read (?:me )?what i copied)\b/.test(t)) return { action: 'read' };
  return null;
}

export interface ShortcutRequest {
  action: 'run' | 'list';
  /** The shortcut, from the user's own. */
  name?: string;
  /** What to give it: "run translate with hello". */
  input?: string;
}

/** Running one of the user's Shortcuts by name ("run my log water shortcut"), or listing them. */
export function parseShortcutRequest(text: string, names: readonly string[]): ShortcutRequest | null {
  const t = text.toLowerCase().trim().replace(/[?.!]+$/, '');
  if (/\b(?:what|which) shortcuts\b|\blist (?:my |the )?shortcuts\b|\bshortcuts (?:do i have|are there)\b/.test(t)) return { action: 'list' };
  const withInput = /^(.*?)\s+(?:with|on|for|using)\s+["“]?(.+?)["”]?$/.exec(t);
  const said = (withInput ? withInput[1]! : t).replace(/\b(?:please|run|start|do|trigger|launch|my|the|shortcut(?:s)?|called|named|app)\b/g, ' ');
  const name = findNamed(said, names, 0.7) ?? findNamed(t, names, 0.8);
  if (!name) return /\bshortcut\b/.test(t) ? { action: 'run' } : null;
  const input = withInput && !findNamed(withInput[2]!, [name], 0.7) ? clean(withInput[2]!) : undefined;
  return { action: 'run', name, ...(input ? { input } : {}) };
}

/** "Use the computer to book a table" → "book a table": the task itself. */
export function computerTask(text: string): string {
  return clean(
    text
      .replace(/^(?:hey |okay |ok )?(?:can you |could you |would you |please |i want you to |i need you to )*/i, '')
      .replace(/^(?:use|take over|control|drive|operate) (?:the |my )?(?:computer|mac|screen|mouse|keyboard)(?: and| to| for me to| for me and)?\s*/i, '')
      .replace(/^take over(?: here)?(?: and| to)?\s+/i, '')
      .replace(/^(?:on (?:the |my )?(?:computer|mac|screen)[, ]*)/i, '')
      .replace(/\s+(?:on|using|with) (?:the |my )?(?:computer|mac|screen)(?: for me)?$/i, '')
      .replace(/\s+for me$/i, ''),
  );
}
