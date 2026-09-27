/**
 * Keyboard shortcuts as the settings file keeps them: "option+space", "control+shift+n", "f5".
 * Nova's Mac app registers one globally (hold it to talk, tap it to listen); this is where they're
 * read, checked and shown. The Mac app reads the same format (Shortcut.swift).
 * Dependency-free, so shells can import it.
 */

export type Modifier = 'control' | 'option' | 'shift' | 'command';

export interface Shortcut {
  /** In macOS's order: ⌃ ⌥ ⇧ ⌘. */
  modifiers: Modifier[];
  key: string;
}

const MODIFIERS: Record<string, Modifier> = {
  control: 'control',
  ctrl: 'control',
  option: 'option',
  opt: 'option',
  alt: 'option',
  shift: 'shift',
  command: 'command',
  cmd: 'command',
};
const ORDER: Modifier[] = ['control', 'option', 'shift', 'command'];
const SYMBOLS: Record<Modifier, string> = { control: '⌃', option: '⌥', shift: '⇧', command: '⌘' };

/** Keys with names, as they're shown. Letters, digits and F1-F20 are keys too. */
const NAMED: Record<string, string> = {
  space: 'Space',
  return: '↩',
  tab: '⇥',
  escape: '⎋',
  delete: '⌫',
  left: '←',
  right: '→',
  up: '↑',
  down: '↓',
  ',': ',',
  '.': '.',
  '/': '/',
  ';': ';',
  "'": "'",
  '[': '[',
  ']': ']',
  '\\': '\\',
  '-': '-',
  '=': '=',
  '`': '`',
};
const ALIASES: Record<string, string> = { enter: 'return', esc: 'escape', backspace: 'delete', comma: ',', period: '.', slash: '/', minus: '-', equals: '=' };

const isFunctionKey = (key: string) => /^f([1-9]|1\d|20)$/.test(key);
const isKey = (key: string) => /^[a-z0-9]$/.test(key) || isFunctionKey(key) || Object.hasOwn(NAMED, key);

/** "option+space" as keys, or null if it isn't a shortcut. */
export function parseShortcut(text: string): Shortcut | null {
  const parts = text
    .trim()
    .toLowerCase()
    .split(/\s*\+\s*/);
  if (parts.length === 0 || parts.some((p) => !p)) return null;
  const last = parts.pop()!;
  const key = ALIASES[last] ?? last;
  if (!isKey(key)) return null;
  const modifiers = new Set<Modifier>();
  for (const part of parts) {
    const modifier = MODIFIERS[part];
    if (!modifier || modifiers.has(modifier)) return null;
    modifiers.add(modifier);
  }
  return { modifiers: ORDER.filter((m) => modifiers.has(m)), key };
}

/** The shortcut the way the settings file keeps it: "option+space". */
export const shortcutText = (s: Shortcut) => [...s.modifiers, s.key].join('+');

/** What's wrong with a shortcut for summoning Nova from anywhere, or null if it's fine. */
export function shortcutProblem(text: string): string | null {
  const s = parseShortcut(text);
  if (!s) return 'should be keys joined by +, like "option+space"';
  const fn = isFunctionKey(s.key);
  if (!s.modifiers.length && !fn) return 'needs ⌃, ⌥ or ⌘ with the key (or a function key on its own) - a key alone would catch your typing';
  if (s.modifiers.length === 1 && s.modifiers[0] === 'shift' && !fn) return 'needs ⌃, ⌥ or ⌘ as well - with ⇧ alone it would catch your typing';
  if (s.modifiers.length === 1 && s.modifiers[0] === 'command' && ['q', 'w', 'h', 'm', 'c', 'v', 'x', 'z', 'a', 's', 'tab', 'space'].includes(s.key)) {
    return `${formatShortcut(text)} belongs to macOS or every app - add ⌃ or ⌥`;
  }
  return null;
}

/** How a shortcut is shown: "⌥Space", "⌃⇧N". */
export function formatShortcut(text: string): string {
  const s = parseShortcut(text);
  if (!s) return text;
  const key = NAMED[s.key] ?? s.key.toUpperCase();
  return `${s.modifiers.map((m) => SYMBOLS[m]).join('')}${key}`;
}

/** A browser key press as a shortcut ("option+space"), or null while only modifiers are down. */
export function shortcutFromKeyboard(e: { code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): string | null {
  // `code` names the physical key, so ⌥A is "a" and not "å".
  const code = e.code;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code.toLowerCase();
  else {
    const codes: Record<string, string> = {
      Space: 'space',
      Enter: 'return',
      Tab: 'tab',
      Escape: 'escape',
      Backspace: 'delete',
      ArrowLeft: 'left',
      ArrowRight: 'right',
      ArrowUp: 'up',
      ArrowDown: 'down',
      Comma: ',',
      Period: '.',
      Slash: '/',
      Semicolon: ';',
      Quote: "'",
      BracketLeft: '[',
      BracketRight: ']',
      Backslash: '\\',
      Minus: '-',
      Equal: '=',
      Backquote: '`',
    };
    key = codes[code] ?? null;
  }
  if (!key || !isKey(key)) return null;
  const modifiers: Modifier[] = [];
  if (e.ctrlKey) modifiers.push('control');
  if (e.altKey) modifiers.push('option');
  if (e.shiftKey) modifiers.push('shift');
  if (e.metaKey) modifiers.push('command');
  return shortcutText({ modifiers, key });
}
