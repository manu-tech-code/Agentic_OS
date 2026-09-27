/**
 * Finds which of a list of names (apps, projects, agents) an utterance mentions. Pure code:
 * exact words first, then run-together or split words ("fig ma" -> Figma, "x code" -> Xcode),
 * then near misses from speech recognition ("spotfy" -> Spotify).
 */

export interface NameMatch {
  /** 0..1: 1 for the exact name, lower for partial or approximate matches. */
  score: number;
  /** The mentioned words, as token positions in the utterance: [start, end). */
  start: number;
  end: number;
}

/** Lower-case words, splitting names like "zoom.us", "Agentic_OS" and "nova-verify". */
export const nameTokens = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

const VENDORS = new Set(['google', 'microsoft', 'adobe', 'apple', 'jetbrains', 'mozilla', 'the']);
const SUFFIXES = new Set(['us', 'app', 'desktop', 'client', 'browser', 'beta', 'player', 'pro']);
/** What people call some apps besides their name. */
const KNOWN_ALIASES: Record<string, string[]> = {
  'visual studio code': ['vs code', 'vscode'],
  'system settings': ['system preferences'],
};

/** The ways a name might be said: in full, without a vendor or a suffix, and known nicknames. */
export function aliasesFor(name: string, label?: string | null): string[][] {
  const out = new Map<string, string[]>();
  const add = (tokens: string[]) => tokens.length && out.set(tokens.join(' '), tokens);
  for (const source of [name, label ?? '']) {
    const full = nameTokens(source);
    add(full);
    let trimmed = full.filter((t) => !/^(19|20)\d\d$/.test(t) && !/^v?\d+(\.\d+)*$/.test(t)); // "Photoshop 2025", "App 2.1"
    while (trimmed.length > 1 && VENDORS.has(trimmed[0]!)) trimmed = trimmed.slice(1);
    while (trimmed.length > 1 && SUFFIXES.has(trimmed.at(-1)!)) trimmed = trimmed.slice(0, -1);
    add(trimmed);
    for (const alias of KNOWN_ALIASES[full.join(' ')] ?? []) add(nameTokens(alias));
  }
  return [...out.values()];
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** Words too common to count as naming something on their own. */
const COMMON = new Set('a an the my me to of for and or in on at it is this that please app apps application new open'.split(' '));

/** How well one alias matches the utterance's words, and where. */
function matchAlias(words: string[], alias: string[]): NameMatch | null {
  const k = alias.length;
  const joined = alias.join('');
  let best: NameMatch | null = null;
  const consider = (score: number, start: number, end: number) => {
    if (!best || score > best.score || (score === best.score && end - start > best.end - best.start)) best = { score, start, end };
  };
  for (let start = 0; start < words.length; start++) {
    for (let len = 1; len <= Math.min(k + 2, words.length - start); len++) {
      const span = words.slice(start, start + len);
      const spanJoined = span.join('');
      if (len === k && span.every((w, i) => w === alias[i])) consider(1, start, start + len);
      else if (spanJoined === joined && joined.length >= 3) consider(0.97, start, start + len);
      else if (joined.length >= 5 && Math.abs(spanJoined.length - joined.length) <= 2 && !span.every((w) => COMMON.has(w))) {
        const similarity = 1 - levenshtein(spanJoined, joined) / Math.max(spanJoined.length, joined.length);
        if (similarity >= 0.8) consider(0.9 * similarity, start, start + len);
      }
    }
  }
  // Most of a longer name: "visual studio" for Visual Studio Code.
  if (k >= 2) {
    const hits = alias.map((t) => words.indexOf(t)).filter((i) => i >= 0 && !COMMON.has(words[i]!));
    if (hits.length >= 2 && hits.length / k >= 0.6) consider(0.55 + 0.35 * (hits.length / k), Math.min(...hits), Math.max(...hits) + 1);
  }
  return best;
}

/** The best match of a name in the utterance, if any. */
export function matchName(words: string[], aliases: string[][]): NameMatch | null {
  let best: NameMatch | null = null;
  for (const alias of aliases) {
    const m = matchAlias(words, alias);
    if (m && (!best || m.score > best.score)) best = m;
  }
  return best;
}
