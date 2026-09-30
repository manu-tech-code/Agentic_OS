/**
 * Arithmetic, worked out in code - for Apple's model, which is small enough to get sums wrong: numbers
 * with + - * / ^ ( ), a percent ("15%", "15% of 80") and sqrt(...). Nothing is evaluated as code.
 */

const WORDS: [RegExp, string][] = [
  [/\bto the power of\b/gi, '^'],
  [/\bsquare root of\b/gi, 'sqrt '],
  [/\bdivided by\b|\bover\b/gi, '/'],
  [/\bmultiplied by\b|\btimes\b/gi, '*'],
  [/\bplus\b/gi, '+'],
  [/\bminus\b/gi, '-'],
  [/\bpercent\b|\bper cent\b/gi, '%'],
  [/[×x](?=\s*[\d(.])/g, '*'],
  [/÷/g, '/'],
  [/−/g, '-'],
];

type Token = { kind: 'number'; value: number } | { kind: 'op'; value: string };

function tokenize(text: string): Token[] {
  let s = text.toLowerCase();
  for (const [pattern, to] of WORDS) s = s.replace(pattern, to);
  s = s.replace(/(\d),(?=\d{3}\b)/g, '$1'); // 1,200 is twelve hundred
  const tokens: Token[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?|\.\d+)|(sqrt|of)|([-+*/^()%]))/y;
  let at = 0;
  while (at < s.length) {
    if (/^\s*$/.test(s.slice(at))) break;
    re.lastIndex = at;
    const m = re.exec(s);
    if (!m) throw new Error(`"${s.slice(at).trim().split(/\s+/)[0]}" isn't arithmetic`);
    at = re.lastIndex;
    if (m[1] !== undefined) tokens.push({ kind: 'number', value: Number(m[1]) });
    else tokens.push({ kind: 'op', value: m[2] ?? m[3]! });
  }
  return tokens;
}

/** What an expression comes to; throws with the reason when it isn't one. */
export function evaluate(expression: string): number {
  if (expression.length > 200) throw new Error('that is too long');
  const tokens = tokenize(expression);
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (value: string) => peek()?.kind === 'op' && peek()!.value === value;
  const expect = (value: string) => {
    if (!isOp(value)) throw new Error(`expected "${value}"`);
    i++;
  };

  // expression := term (("+" | "-") term)*
  function sum(): number {
    let value = product();
    while (isOp('+') || isOp('-')) value = tokens[i++]!.value === '+' ? value + product() : value - product();
    return value;
  }
  // term := unary (("*" | "/") unary)*
  function product(): number {
    let value = unary();
    while (isOp('*') || isOp('/')) {
      const op = tokens[i++]!.value;
      const right = unary();
      if (op === '/' && right === 0) throw new Error("you can't divide by zero");
      value = op === '*' ? value * right : value / right;
    }
    return value;
  }
  // unary := ("-" | "+") unary | power   (-2^2 is -4)
  function unary(): number {
    if (isOp('-')) return i++, -unary();
    if (isOp('+')) return i++, unary();
    return power();
  }
  // power := percent ("^" unary)?   (2^3^2 is 2^9, 2^-1 is 0.5)
  function power(): number {
    const base = percent();
    if (!isOp('^')) return base;
    i++;
    return base ** unary();
  }
  // percent := primary ("%" ("of" unary)?)?
  function percent(): number {
    const value = primary();
    if (!isOp('%')) return value;
    i++;
    if (!isOp('of')) return value / 100;
    i++;
    return (value / 100) * unary();
  }
  // primary := number | "(" expression ")" | "sqrt" primary
  function primary(): number {
    const token = peek();
    if (!token) throw new Error('it ends too soon');
    if (token.kind === 'number') return i++, token.value;
    if (token.value === 'sqrt') {
      i++;
      const value = primary();
      if (value < 0) throw new Error("negative numbers have no square root here");
      return Math.sqrt(value);
    }
    if (token.value === '(') {
      i++;
      const value = sum();
      expect(')');
      return value;
    }
    throw new Error(`"${token.value}" is in the wrong place`);
  }

  const value = sum();
  if (i < tokens.length) throw new Error(`"${(tokens[i] as Token).value}" is in the wrong place`);
  if (!Number.isFinite(value)) throw new Error('the answer is too big');
  return value;
}

/** A number as it's said: at most ten decimals, no binary noise (0.1 + 0.2 is 0.3), and thousands grouped. */
export function formatNumber(value: number): string {
  const clean = Number(value.toPrecision(12));
  return clean.toLocaleString('en-US', { maximumFractionDigits: 10 });
}

/** The calculator tool's answer, in words for the model. */
export function calculated(args: Record<string, unknown>): string {
  const expression = String(args.expression ?? args.request ?? '').trim();
  if (!expression) return 'Give me the arithmetic to work out, e.g. 17 * 23.';
  try {
    return `${expression} = ${formatNumber(evaluate(expression))}`;
  } catch (e) {
    return `I couldn't work out "${expression}": ${(e as Error).message}.`;
  }
}
