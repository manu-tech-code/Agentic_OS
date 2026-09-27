/**
 * Integrations: services Nova's brains - paired agents and models alike - can use through Nova.
 * Each is an MCP server, hosted (Notion, Linear, ...) or started on this Mac. Nova connects to
 * it once and offers its tools to every brain, with its own rule on top: it asks the user out
 * loud before an action unless they said otherwise. That choice is the user's, per service and
 * per tool; a server's own labels ("read-only") only count when the user chose to trust them.
 * Dependency-free, so shells can import it.
 */
import type { RiskTier } from './protocol.ts';

/** When Nova asks first: before every action, only before changes, or never. */
export type AskPolicy = 'always' | 'changes' | 'never';
/** One tool: run it, ask first, or keep it from the brains altogether. */
export type ToolPolicy = 'allow' | 'ask' | 'block';

/** One integration in the settings file, under integrations.servers.<name>. */
export interface IntegrationEntry {
  /** A hosted server (Streamable HTTP, or the older SSE). */
  url?: string;
  /** Or one started on this Mac. */
  command?: string;
  args?: string[];
  /** Environment for a local server; values may be ${VAR}, taken from .env. */
  env?: Record<string, string>;
  /** Headers for a hosted server, e.g. { "Authorization": "Bearer ${NOVA_GITHUB_TOKEN}" }. */
  headers?: Record<string, string>;
  ask?: AskPolicy;
  /** Choices for single tools, by the tool's own name. */
  tools?: Record<string, ToolPolicy>;
  /** false: kept, but switched off. */
  enabled?: boolean;
  /** Shown instead of the name. */
  label?: string;
}

export interface IntegrationPreset {
  id: string;
  label: string;
  url: string;
  /** How it's reached: signing in with the browser, a token of the user's, or openly. */
  auth: 'oauth' | 'token' | 'none';
  description: string;
  token?: { header: string; template: string; variable: string; help: string };
}

/** Services worth one click. Their addresses and sign-in were checked against the servers themselves. */
export const INTEGRATION_PRESETS: IntegrationPreset[] = [
  { id: 'notion', label: 'Notion', url: 'https://mcp.notion.com/mcp', auth: 'oauth', description: 'Pages, databases and comments in your workspace.' },
  { id: 'linear', label: 'Linear', url: 'https://mcp.linear.app/mcp', auth: 'oauth', description: 'Issues, projects and cycles.' },
  { id: 'atlassian', label: 'Jira & Confluence', url: 'https://mcp.atlassian.com/v1/mcp', auth: 'oauth', description: 'Jira issues and Confluence pages.' },
  { id: 'sentry', label: 'Sentry', url: 'https://mcp.sentry.dev/mcp', auth: 'oauth', description: 'Errors and performance problems in your apps.' },
  { id: 'supabase', label: 'Supabase', url: 'https://mcp.supabase.com/mcp', auth: 'oauth', description: 'Databases, tables and edge functions.' },
  { id: 'vercel', label: 'Vercel', url: 'https://mcp.vercel.com', auth: 'oauth', description: 'Projects, deployments and their logs.' },
  { id: 'figma', label: 'Figma', url: 'https://mcp.figma.com/mcp', auth: 'oauth', description: 'Designs, frames and components.' },
  {
    id: 'github',
    label: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: 'token',
    description: 'Repositories, issues and pull requests.',
    token: {
      header: 'Authorization',
      template: 'Bearer ${NOVA_GITHUB_TOKEN}',
      variable: 'NOVA_GITHUB_TOKEN',
      help: 'A fine-grained personal access token: GitHub → Settings → Developer settings → Personal access tokens.',
    },
  },
  {
    id: 'stripe',
    label: 'Stripe',
    url: 'https://mcp.stripe.com',
    auth: 'token',
    description: 'Customers, payments and invoices.',
    token: { header: 'Authorization', template: 'Bearer ${NOVA_STRIPE_KEY}', variable: 'NOVA_STRIPE_KEY', help: 'A restricted API key: Stripe dashboard → Developers → API keys.' },
  },
  { id: 'huggingface', label: 'Hugging Face', url: 'https://huggingface.co/mcp', auth: 'none', description: 'Models, datasets, papers and Spaces.' },
  { id: 'cloudflare-docs', label: 'Cloudflare docs', url: 'https://docs.mcp.cloudflare.com/mcp', auth: 'none', description: "Answers from Cloudflare's documentation." },
];

/** What a tool's own name says it does that one spoken yes shouldn't cover for good: moving money, running code or SQL, deleting, sending as the user. */
export type ToolRisk = 'money' | 'code' | 'delete' | 'send';

/** A tool's name as words: "stripe__createRefund" → ["create", "refund"]. */
const nameWords = (name: string) =>
  (name.includes('__') ? name.slice(name.indexOf('__') + 2) : name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** A tool that starts by reading ("list refunds", "get payment") changes nothing, whatever it reads. */
const READS = new Set(['get', 'list', 'search', 'find', 'read', 'retrieve', 'fetch', 'view', 'show', 'describe', 'count', 'lookup', 'preview', 'check', 'query']);
const MONEY = /^(?:refunds?|charges?|payouts?|transfers?|payments?|pay|purchases?|buy|capture|withdraw(?:als?)?|invoices?|subscriptions?|checkout|billing|orders?|wire|remit)$/;
const CODE = /^(?:sql|execute|exec|eval|run|migrations?|migrate|shell|scripts?|commands?)$/;
const DELETES = /^(?:delete|remove|destroy|drop|purge|archive|revoke|cancel|trash|erase|wipe|clear|reset|uninstall|unpublish|unsubscribe)$/;
const SENDS = /^(?:send|reply|forward|post|publish|tweet|share|invite|notify|email|mail|sms|dm|broadcast|deploy|release|merge|push)$/;

/**
 * Read in code from the tool's own name, only ever to ask for more: a name can make a tool need
 * a tap or a yes each time, never less than the user's rule says.
 */
export function toolRisk(name: string): ToolRisk | null {
  const words = nameWords(name);
  if (!words.length || READS.has(words[0]!)) return null;
  if (words.some((w) => MONEY.test(w))) return 'money';
  if (words.some((w) => CODE.test(w))) return 'code';
  if (words.some((w) => DELETES.test(w))) return 'delete';
  if (words.some((w) => SENDS.test(w))) return 'send';
  return null;
}

/** How Nova treats one of a server's tools: the user's choice for it, else their rule for the service. */
export function toolPolicy(entry: IntegrationEntry, tool: { name: string; readOnly?: boolean }): ToolPolicy {
  const chosen = entry.tools?.[tool.name];
  if (chosen) return chosen;
  const risk = toolRisk(tool.name);
  switch (entry.ask ?? 'always') {
    case 'never':
      // A rule for the whole service doesn't reach money: that needs a tap, unless the user allowed that very tool.
      return risk === 'money' ? 'ask' : 'allow';
    case 'changes':
      // The server's own label, trusted because the user said so - but not over a name that says it runs code, deletes, sends or pays.
      return tool.readOnly && !risk ? 'allow' : 'ask';
    default:
      return 'ask';
  }
}

/**
 * The guardian tier for a policy: allowed tools run (and show in Activity), the rest are confirmed
 * out loud - and one that moves money needs a tap on screen, never a spoken yes alone.
 */
export const policyTier = (policy: ToolPolicy, name = ''): RiskTier => (policy === 'allow' ? 1 : toolRisk(name) === 'money' ? 3 : 2);

/** Whether "yes, always" may be remembered for a tool: only one the service says just reads, and whose name agrees. */
export const mayRememberTool = (tool: { name: string; readOnly?: boolean }) => tool.readOnly === true && !toolRisk(tool.name);

/** A stable hash of a string, as a few letters and digits. */
function shortHash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h.toString(36).slice(0, 6);
}

/**
 * The name brains see for a server's tool, e.g. "linear__create_issue": namespaced, so two
 * services can both have "search", and within what every agent accepts (letters, digits, _ and -, at most 64).
 */
export function toolName(server: string, tool: string) {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
  const full = `${clean(server).toLowerCase()}__${clean(tool)}`;
  return full.length <= 64 ? full : `${full.slice(0, 57)}_${shortHash(full)}`;
}

/** An integration name made from a label: "Jira & Confluence" -> "jira-confluence". */
export const integrationName = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'service';

/** Keys whose text is what a call is about, best first - said right after the action, without the key. */
const TITLE_KEYS = ['title', 'name', 'subject', 'summary', 'text', 'query', 'message', 'content', 'prompt', 'question', 'body', 'description'];
const RECIPIENT_KEYS = ['to', 'cc', 'bcc', 'recipient', 'recipients'];
/** Details never left out of what's said, however many there are: amounts, who it goes to, what it acts on. */
const MATTERS = /amount|price|total|cost|fee|currency|quantity|qty|count|limit|recipient|e-?mail|phone|channel|user|assignee|owner|account|customer|member|repo|path|file|url|table|database|schema|project|branch|target|destination|(?:^|_)ids?$|[a-z]Ids?$/i;
/** Past this, less important details are counted rather than said. */
const DETAILS_MAX = 240;

const spokenList = (items: string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const spokenKey = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();

/** A value as said: short text as it is, long text cut at a word, an id or token to its start, a number with its thousands. */
function spokenValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const text = value.replace(/\s+/g, ' ').trim();
    if (!text) return null;
    if (text.length <= 60) return `"${text}"`;
    if (!text.includes(' ')) return `"${text.slice(0, 12)}…"`;
    const cut = text.slice(0, 60);
    const end = cut.lastIndexOf(' ');
    return `"${cut.slice(0, end > 30 ? end : 60).replace(/[\s,;:.-]+$/, '')}…"`;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString('en-US') : null;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return null;
}

/** One argument as said: `amount 250,000`, `to "bob@example.com" and "eve@example.com"`, `2 items`, `shipping (2 details)`. */
function argPhrase(key: string, value: unknown): string | null {
  const name = spokenKey(key);
  if (Array.isArray(value)) {
    const plain = value.map(spokenValue);
    if (value.length && plain.every((v): v is string => v !== null)) return `${name} ${spokenList([...plain.slice(0, 3), ...(value.length > 3 ? [`${value.length - 3} more`] : [])])}`;
    return value.length ? `${value.length} ${name}` : null;
  }
  if (value && typeof value === 'object') {
    const n = Object.keys(value).length;
    return n ? `${name} (${n} ${n === 1 ? 'detail' : 'details'})` : null;
  }
  const said = spokenValue(value);
  return said ? `${name} ${said}` : null;
}

/**
 * What a call does, in words to say out loud - every argument that matters, so a yes is to what
 * will happen: `Linear: create issue "Fix the login bug"`, `Stripe: create refund with payment
 * intent "pi_3N…", amount 250,000 and reason "duplicate"`, `Gmail: send message "Invoice" to "bob@…"`.
 */
export function describeCall(label: string, tool: string, args: Record<string, unknown>, title?: string) {
  const action = (title || tool)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  const entries = Object.entries(args ?? {});
  const titleKey = TITLE_KEYS.find((k) => entries.some(([key, v]) => key.toLowerCase() === k && typeof v === 'string' && v.trim()));
  const about = titleKey ? entries.find(([key]) => key.toLowerCase() === titleKey) : undefined;
  const rest = entries.filter((e) => e !== about);
  const to = rest.filter(([key]) => RECIPIENT_KEYS.includes(key.toLowerCase())).flatMap(([key, v]) => argPhrase(key, v) ?? []);
  const details: string[] = [];
  let length = 0;
  let unsaid = 0;
  for (const [key, value] of rest.filter(([key]) => !RECIPIENT_KEYS.includes(key.toLowerCase()))) {
    const phrase = argPhrase(key, value);
    if (!phrase) continue;
    if (typeof value === 'number' || typeof value === 'boolean' || MATTERS.test(key) || length + phrase.length <= DETAILS_MAX) {
      details.push(phrase);
      length += phrase.length;
    } else unsaid++;
  }
  if (unsaid) details.push(`${unsaid} more ${unsaid === 1 ? 'detail' : 'details'}`);
  return `${label}: ${action}${about ? ` ${spokenValue(about[1])}` : ''}${to.length ? ` ${to.join(', ')}` : ''}${details.length ? ` with ${spokenList(details)}` : ''}`;
}

/** ${NAME} references in a value: where secrets from .env go. */
export const secretRefs = (value: string) => [...value.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1]!);

/** Whether a header or environment value looks like a pasted secret rather than a ${NAME} from .env. */
export function looksSecret(key: string, value: string) {
  if (secretRefs(value).length) return false;
  if (/token|secret|key|password|authorization|bearer/i.test(key)) return value.trim().length > 0;
  return /^(bearer\s+)?[A-Za-z0-9_\-.]{24,}$/i.test(value.trim());
}

/** The shapes of well-known tokens: GitHub, OpenAI and Anthropic, Stripe, Slack, GitLab, AWS, Google. */
const TOKEN_SHAPE = /^(?:gh[pousr]_|github_pat_|sk-|sk_(?:live|test)_|rk_(?:live|test)_|xox[abprs]-|glpat-|AKIA[0-9A-Z]{12}|ya29\.|AIza)/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A flag or query key that names a secret: --token, --api-key, ?access_token=, ?key=. */
const SECRET_KEY = /(?:^|[-_.])(?:token|secret|password|passwd|apikey|api[-_]?key|key|auth|authorization|bearer|credentials?)(?:$|[-_.])/i;

/** A token on its own: a known shape, or a long unbroken run of letters and digits - not a UUID, a path or a package name. */
function tokenLike(text: string) {
  if (TOKEN_SHAPE.test(text)) return true;
  if (UUID.test(text) || !/[A-Za-z]/.test(text) || !/\d/.test(text)) return false;
  return Math.max(0, ...(text.match(/[A-Za-z0-9]+/g) ?? []).map((run) => run.length)) >= 20;
}

const pathLike = (value: string) => /^[.~/]/.test(value) || value.includes('/');
const valueSecret = (key: string, value: string) => value.trim() !== '' && !secretRefs(value).length && !pathLike(value) && (SECRET_KEY.test(key) || tokenLike(value));
const decoded = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/** A secret pasted into a local server's arguments - "--token ghp_…", "--api-key=sk_…", or a token on its own. */
export function argsSecret(args: string[]) {
  return args.some((arg, i) => {
    if (secretRefs(arg).length) return false;
    const flag = /^--?([\w.-]+)=(.*)$/s.exec(arg);
    if (flag) return valueSecret(flag[1]!, flag[2]!);
    const next = args[i + 1];
    if (/^--?[\w.-]+$/.test(arg) && next !== undefined && !next.startsWith('-') && SECRET_KEY.test(arg.replace(/^-+/, ''))) return valueSecret(arg, next);
    return tokenLike(arg);
  });
}

/** A secret pasted into a hosted server's address: a password in it, a token in its query, or one as part of its path. */
export function urlSecret(url: string) {
  if (/^https?:\/\/[^/?#@]*:[^/?#@]+@/i.test(url)) return true;
  const [address = '', query = ''] = url.split('#')[0]!.split('?');
  for (const pair of query.split('&')) {
    const [key = '', value = ''] = pair.split('=');
    if (value && valueSecret(decoded(key), decoded(value))) return true;
  }
  return address
    .replace(/^https?:\/\/[^/]*/i, '')
    .split('/')
    .some((part) => !secretRefs(part).length && tokenLike(decoded(part)));
}
