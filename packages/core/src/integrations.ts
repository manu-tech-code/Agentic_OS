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

/** How Nova treats one of a server's tools: the user's choice for it, else their rule for the service. */
export function toolPolicy(entry: IntegrationEntry, tool: { name: string; readOnly?: boolean }): ToolPolicy {
  const chosen = entry.tools?.[tool.name];
  if (chosen) return chosen;
  switch (entry.ask ?? 'always') {
    case 'never':
      return 'allow';
    case 'changes':
      return tool.readOnly ? 'allow' : 'ask'; // the server's own label, trusted because the user said so
    default:
      return 'ask';
  }
}

/** The guardian tier for a policy: allowed tools run (and show in Activity), the rest are confirmed out loud. */
export const policyTier = (policy: ToolPolicy): RiskTier => (policy === 'allow' ? 1 : 2);

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

/** What a call does, in words to say out loud: `Linear: create issue "Fix the login bug"`. */
export function describeCall(label: string, tool: string, args: Record<string, unknown>, title?: string) {
  const action = (title || tool)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  const details = Object.values(args)
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 80)
    .slice(0, 2)
    .map((v) => `"${v.trim()}"`)
    .join(', ');
  return `${label}: ${action}${details ? ` ${details}` : ''}`;
}

/** ${NAME} references in a value: where secrets from .env go. */
export const secretRefs = (value: string) => [...value.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1]!);

/** Whether a header or environment value looks like a pasted secret rather than a ${NAME} from .env. */
export function looksSecret(key: string, value: string) {
  if (secretRefs(value).length) return false;
  if (/token|secret|key|password|authorization|bearer/i.test(key)) return value.trim().length > 0;
  return /^(bearer\s+)?[A-Za-z0-9_\-.]{24,}$/i.test(value.trim());
}
