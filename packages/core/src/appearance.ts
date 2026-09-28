/**
 * Nova's own looks, said aloud: "make the text bigger", "text size 150 percent", "the text back to normal". Parsed
 * here, in code; the text_size skill applies the result through the few preferences a skill may change.
 */

/** What the text size can be, as a percent of normal - the slider in Settings → Appearance. */
export const TEXT_SIZE = { min: 75, max: 200, step: 5, normal: 100 } as const;
/** One "bigger" or "smaller"; "a bit" is half that, "a lot" twice. */
export const TEXT_STEP = 20;

export type TextSizeRequest =
  | { action: 'bigger' | 'smaller'; by: number }
  | { action: 'set'; value: number }
  | { action: 'reset' }
  | { action: 'query' };

/** The text Nova shows: what "the text" can be called. */
const TEXT = String.raw`\b(?:text|texts|font|fonts|typeface|words|writing|letters|captions|subtitles|transcript)\b`;
/** Words that ask for a size change by themselves. */
const BIGGER = String.raw`\b(?:bigger|larger|enlarge|increase|increased|grow|zoom in|blow up|blow it up|scale up|more readable|easier to read)\b`;
const SMALLER = String.raw`\b(?:smaller|decrease|decreased|reduce|shrink|zoom out|scale down)\b`;
/** Plain sizes count only after "make", "set" or "turn" ("make the text big"), never in "the big text file". */
const MADE = String.raw`\b(?:make|makes|making|set|turn|put|change|get)\b`;
const BIG = String.raw`\b(?:big|large|huge)\b`;
const SMALL = String.raw`\b(?:small|tiny)\b`;
/** "Up" and "down" count only with a size or a turn of it: "text size up", "turn the text down" - not "look up the text". */
const UP_DOWN_OK = String.raw`\b(?:size|turn|bring|crank|knock|push|put|scale)\b`;
/** Said about how the text is now, which asks for the other way: it's too small, so bigger. */
const TOO_SMALL = String.raw`\b(?:too small|too tiny|so small|can'?t read|cannot read|hard to read|struggling to read|can'?t see)\b`;
const TOO_BIG = String.raw`\b(?:too big|too large|too huge|so big|so large|massive)\b`;
const RESET = String.raw`\b(?:reset|normal|default|original|regular|usual|standard|back to how it was|back where it (?:was|started)|back to the start|the way it was|like it was)\b`;
const QUERY = String.raw`^(?:\w+\s+){0,3}?(?:what(?:'s| is)|how (?:big|large|small) is|what size is|which size is)\b`;

/** Sizes said in words, 75 to 200: "seventy five", "a hundred and twenty", "one hundred and fifty", "two hundred". */
const WORD_NUMBERS: Record<string, number> = (() => {
  const tens: Record<string, number> = { ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
  const under: [string, number][] = [];
  for (const [word, n] of Object.entries(tens)) {
    under.push([word, n]);
    if (n >= 20) under.push([`${word} five`, n + 5]);
  }
  under.push(['five', 5], ['fifteen', 15], ['twelve', 12]);
  const out: Record<string, number> = { 'a hundred': 100, 'one hundred': 100, hundred: 100, 'two hundred': 200 };
  for (const [word, n] of under) {
    if (n >= 70) out[word] = n;
    out[`a hundred and ${word}`] = 100 + n;
    out[`one hundred and ${word}`] = 100 + n;
  }
  return out;
})();

/** "150 percent", "150%", "to 150", "text 150", "1.5 times", "one and a half times", "double", "twice as big" - a percent, or null. */
function sizeSaid(text: string): number | null {
  const times = /\b(\d+(?:\.\d+)?)\s*(?:x|times)\b/.exec(text);
  if (times) return Math.round(Number(times[1]) * 100);
  if (/\b(?:one and a half|1 and a half) times\b/.test(text)) return 150;
  if (/\b(?:double|twice)\b/.test(text)) return 200;
  const percent =
    /\b(\d{2,3})\s*(?:%|percent|per cent|pc)/.exec(text) ?? /\b(?:to|at|be)\s+(\d{2,3})\b/.exec(text) ?? new RegExp(`${TEXT}\\s+(?:size\\s+)?(\\d{2,3})\\b`).exec(text);
  if (percent) return Number(percent[1]);
  const words = Object.keys(WORD_NUMBERS)
    .sort((a, b) => b.length - a.length)
    .find((w) => new RegExp(`\\b${w}\\s*(?:%|percent|per cent)`).test(text));
  return words ? WORD_NUMBERS[words]! : null;
}

const at = (text: string, pattern: string) => [...text.matchAll(new RegExp(pattern, 'g'))].map((m) => m.index!);

/** What was asked of the text size - null when it isn't about Nova's text, or says nothing about its size. */
export function parseTextSize(raw: string): TextSizeRequest | null {
  const text = raw
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^\w%'. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!new RegExp(TEXT).test(text)) return null;
  if (new RegExp(QUERY).test(text) && !new RegExp(`${BIGGER}|${SMALLER}|${RESET}`).test(text)) return { action: 'query' };
  const value = sizeSaid(text);
  if (value !== null) return { action: 'set', value };
  if (new RegExp(RESET).test(text)) return { action: 'reset' };
  const by = /\b(?:a bit|a little|a tad|slightly|a touch|a notch)\b/.test(text) ? TEXT_STEP / 2 : /\b(?:a lot|much|way|loads|really)\b/.test(text) ? TEXT_STEP * 2 : TEXT_STEP;
  if (new RegExp(TOO_SMALL).test(text)) return { action: 'bigger', by };
  if (new RegExp(TOO_BIG).test(text)) return { action: 'smaller', by };
  const made = new RegExp(MADE).test(text);
  const turned = new RegExp(UP_DOWN_OK).test(text);
  const up = [...at(text, BIGGER), ...(made ? at(text, BIG) : []), ...(turned ? at(text, String.raw`\bup\b`) : [])];
  const down = [...at(text, SMALLER), ...(made ? at(text, SMALL) : []), ...(turned ? at(text, String.raw`\bdown\b`) : [])];
  if (!up.length && !down.length) return null;
  // Whichever is said last: "not smaller, bigger" is bigger.
  return Math.max(-1, ...up) > Math.max(-1, ...down) ? { action: 'bigger', by } : { action: 'smaller', by };
}

/** The size after a request: within the range, on its steps. */
export function textSizeAfter(now: number, req: TextSizeRequest): number {
  const snap = (v: number) => Math.min(TEXT_SIZE.max, Math.max(TEXT_SIZE.min, Math.round(v / TEXT_SIZE.step) * TEXT_SIZE.step));
  switch (req.action) {
    case 'bigger':
      return snap(now + req.by);
    case 'smaller':
      return snap(now - req.by);
    case 'set':
      return snap(req.value);
    case 'reset':
      return TEXT_SIZE.normal;
    case 'query':
      return now;
  }
}
