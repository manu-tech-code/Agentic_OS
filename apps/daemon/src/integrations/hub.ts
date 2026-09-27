import { randomBytes } from 'node:crypto';
import {
  describeCall,
  policyTier,
  secretRefs,
  toolName,
  toolPolicy,
  type IntegrationEntry,
  type IntegrationStatus,
  type IntegrationTool,
  type IntegrationTools,
} from '@nova/core';
import { HttpTransport, McpClient, McpError, NeedsSignIn, SseTransport, StdioTransport, type McpTool } from './mcp.ts';
import { authorizeUrl, discover, exchange, pkce, refresh, register, resourceCovers, SignIns, type SignIn } from './oauth.ts';

interface Connection {
  name: string;
  entry: IntegrationEntry;
  /** What the connection is made from: a change reconnects, a change of policy doesn't. */
  key: string;
  state: IntegrationStatus['state'];
  message?: string;
  client: McpClient | null;
  tools: McpTool[];
  /** It asked for a sign-in, and where it describes how. */
  canSignIn: boolean;
  resourceMetadata?: string;
  retries: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Bumped on every (re)connect, so a replaced connection's news is ignored. */
  generation: number;
}

/** Waits between reconnection attempts. */
const BACKOFF = [5_000, 30_000, 120_000, 600_000];
const CALL_TIMEOUT = 120_000;

const connectionPart = (e: IntegrationEntry) => JSON.stringify([e.url, e.command, e.args, e.env, e.headers, e.enabled]);

/**
 * Nova's own secrets and constants in .env, which no integration is ever given - so an entry in the
 * settings file can't send them anywhere: the AI Gateway's key, the local model servers' keys
 * (NOVA_<SERVER>_API_KEY) and Nova's settings. A service's own secret gets a name of its own, such
 * as NOVA_GITHUB_TOKEN or NOVA_STRIPE_KEY.
 */
export const NOVA_OWN_SECRET =
  /^(?:AI_GATEWAY_API_KEY|VERCEL_OIDC_TOKEN|NOVA_[A-Z0-9_]*_API_KEY|NOVA_(?:PORT|UI_ORIGINS|SETTINGS_FILE|AGENTS_FILE|MODELS_DIR|BUNDLED_MODELS|SIGN_IDENTITY|DRY_RUN|HEARING_DEBUG|BRIDGE_URL|TOOLS_TOKEN|APPROVAL_TOKEN))$/;

/** Two addresses of one server (a trailing slash aside). */
function sameServer(a: string | undefined, b: string | undefined) {
  if (!a || !b) return false;
  try {
    const clean = (u: string) => {
      const url = new URL(u);
      url.hash = '';
      return url.href.replace(/\/$/, '');
    };
    return clean(a) === clean(b);
  } catch {
    return false;
  }
}

export interface HubOptions {
  env: NodeJS.ProcessEnv;
  /** Where the browser comes back after signing in (the daemon's /oauth/callback). */
  redirectUri: () => string;
  /** Open a page in the user's browser. */
  open: (url: string) => void;
  /** Connections, tools or states changed. */
  changed: () => void;
  signIns?: SignIns;
  /** How long a service may take to say hello (a local one gets twice as long) and to list its tools, in ms. */
  timeouts?: { connect?: number; list?: number };
}

/**
 * Nova's integrations: one live connection per service, its tools offered to every brain with the
 * user's rule for each, and sign-in with the browser for services that need it.
 */
export class IntegrationHub implements IntegrationTools {
  private readonly connections = new Map<string, Connection>();
  private readonly signIns: SignIns;
  private readonly pending = new Map<string, { name: string; verifier: string; at: number }>();
  private signedIn = new Set<string>();
  /** Sign-ins being renewed, by integration: one renewal at a time, whoever needs it. */
  private readonly renewing = new Map<string, Promise<boolean>>();
  /** Tool names that came out the same for two tools, last said in the log. */
  private clashes = '';

  constructor(private readonly opts: HubOptions) {
    this.signIns = opts.signIns ?? new SignIns();
    void this.signIns.names().then((names) => {
      this.signedIn = new Set(names);
      opts.changed();
    });
  }

  /** Apply the settings: new services connect, removed ones close, changed ones reconnect. */
  configure(entries: Record<string, IntegrationEntry>) {
    for (const [name, c] of this.connections) {
      if (!Object.hasOwn(entries, name)) {
        this.stop(c);
        this.connections.delete(name);
      }
    }
    for (const [name, entry] of Object.entries(entries)) {
      const key = connectionPart(entry);
      const existing = this.connections.get(name);
      if (existing && existing.key === key) {
        existing.entry = entry; // a new rule for asking takes effect at once
        continue;
      }
      if (existing) this.stop(existing);
      const c: Connection = { name, entry, key, state: 'connecting', client: null, tools: [], canSignIn: false, retries: 0, generation: 0 };
      this.connections.set(name, c);
      void this.connect(c);
    }
    this.opts.changed();
  }

  // --- Tools, for NovaBrain -----------------------------------------------------------------

  /**
   * Every connected service's tools, by the one name brains know each by. Two tools whose names
   * come out the same ("a.b" and "a_b" are both "srv__a_b") are both left out: which one a call
   * meant can't be known, and they may have different rules.
   */
  private catalog(): Map<string, { c: Connection; tool: McpTool }> {
    const byName = new Map<string, { c: Connection; tool: McpTool }>();
    const clashes = new Set<string>();
    for (const c of this.connections.values()) {
      if (c.state !== 'connected') continue;
      for (const tool of c.tools) {
        const name = toolName(c.name, tool.name);
        const taken = byName.get(name);
        if (taken && !(taken.c === c && taken.tool.name === tool.name)) clashes.add(name);
        else if (!taken) byName.set(name, { c, tool });
      }
    }
    for (const name of clashes) byName.delete(name);
    const said = [...clashes].sort().join(', ');
    if (said && said !== this.clashes) console.warn(`  [integrations] left out ${said}: two tools share each of these names`);
    this.clashes = said;
    return byName;
  }

  private policy(c: Connection, tool: McpTool) {
    return toolPolicy(c.entry, { name: tool.name, readOnly: tool.annotations?.readOnlyHint === true });
  }

  specs(): IntegrationTool[] {
    const out: IntegrationTool[] = [];
    for (const [name, { c, tool }] of this.catalog()) {
      const policy = this.policy(c, tool);
      if (policy === 'block') continue;
      const label = this.label(c);
      const tier = policyTier(policy, tool.name);
      const schema = (tool.inputSchema ?? {}) as Record<string, unknown>;
      const title = tool.title ?? tool.annotations?.title;
      out.push({
        name,
        label,
        tier,
        readOnly: tool.annotations?.readOnlyHint === true,
        description: `${label}: ${(tool.description ?? title ?? tool.name).trim().slice(0, 1000)}${tier >= 2 ? ' The assistant asks the user out loud first.' : ''}`,
        parameters: {
          ...schema,
          type: 'object',
          properties: (schema.properties as Record<string, unknown>) ?? {},
          required: Array.isArray(schema.required) ? (schema.required as string[]) : [],
        },
        summary: (args) => describeCall(label, tool.name, args, title),
      });
    }
    return out;
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const found = this.catalog().get(name);
    if (!found) throw new Error(`No integration offers ${name}.`);
    const { c, tool } = found;
    // The user's rule, again: a tool blocked since the brain saw the list is still blocked.
    if (this.policy(c, tool) === 'block') throw new Error(`${this.label(c)}'s ${tool.name} is blocked in Settings.`);
    const client = c.client;
    if (!client) throw new Error(`${this.label(c)} isn't connected.`);
    const limit = AbortSignal.timeout(CALL_TIMEOUT);
    const stop = signal ? AbortSignal.any([signal, limit]) : limit;
    const token = (await this.signIns.get(c.name))?.tokens?.access_token;
    try {
      return await client.callTool(tool.name, args, stop);
    } catch (e) {
      if (!(e instanceof NeedsSignIn)) throw e;
      // The sign-in ran out mid-session: renew it once (unless another call just did), then ask the user to sign in again.
      if (await this.renew(c.name, token)) {
        try {
          return await client.callTool(tool.name, args, stop);
        } catch (again) {
          if (!(again instanceof NeedsSignIn)) throw again;
        }
      }
      c.canSignIn = true;
      this.set(c, 'sign-in', 'The sign-in ran out. Sign in again.');
      throw e;
    }
  }

  // --- Status, for Settings -----------------------------------------------------------------

  status(): IntegrationStatus[] {
    return [...this.connections.values()].map((c) => {
      const readOnly = (t: McpTool) => t.annotations?.readOnlyHint === true;
      return {
        name: c.name,
        label: this.label(c),
        kind: c.entry.command ? 'local' : 'hosted',
        where: c.entry.command ? [c.entry.command, ...(c.entry.args ?? [])].join(' ') : (c.entry.url ?? ''),
        state: c.state,
        message: c.message,
        canSignIn: c.canSignIn || this.signedIn.has(c.name),
        signedIn: this.signedIn.has(c.name),
        ask: c.entry.ask ?? 'always',
        tools: c.tools.map((t) => ({
          name: t.name,
          title: t.title ?? t.annotations?.title,
          description: (t.description ?? '').trim().slice(0, 300),
          readOnly: readOnly(t),
          policy: toolPolicy(c.entry, { name: t.name, readOnly: readOnly(t) }),
          chosen: Boolean(c.entry.tools?.[t.name]),
        })),
        secrets: this.secretNames(c.entry).map((name) => ({ name, set: Boolean(this.opts.env[name]) })),
      };
    });
  }

  // --- Signing in ---------------------------------------------------------------------------

  /** Start signing in: the browser opens the service's sign-in page. Resolves with its address. */
  async signIn(name: string): Promise<string> {
    const c = this.connections.get(name);
    if (!c?.entry.url) throw new Error('Only hosted integrations sign in with the browser.');
    const server = c.entry.url;
    const found = await discover(server, c.resourceMetadata);
    const redirect = this.opts.redirectUri();
    const stored = await this.signIns.get(name);
    const known = stored && this.boundTo(stored, server) ? stored : undefined; // one for another address is no use here
    const client =
      known && known.client.redirect_uri === redirect && known.authServer.token_endpoint === found.authServer.token_endpoint
        ? known.client
        : await register(found.authServer, redirect);
    await this.signIns.set(name, { ...found, server, client, tokens: known?.tokens });
    const { verifier, challenge } = pkce();
    const state = randomBytes(24).toString('base64url');
    for (const [s, p] of this.pending) if (Date.now() - p.at > 15 * 60_000) this.pending.delete(s);
    this.pending.set(state, { name, verifier, at: Date.now() });
    const url = authorizeUrl({ ...found, client }, state, challenge);
    this.opts.open(url);
    return url;
  }

  /** The browser came back from the sign-in page. */
  async completeSignIn(state: string, code: string | null, error: string | null): Promise<{ ok: boolean; message: string }> {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || Date.now() - pending.at > 15 * 60_000) return { ok: false, message: 'This sign-in has expired. Start it again from Nova’s Settings.' };
    const c = this.connections.get(pending.name);
    const label = c ? this.label(c) : pending.name;
    if (error || !code) return { ok: false, message: `Signing in to ${label} was cancelled${error ? ` (${error})` : ''}.` };
    const signIn = await this.signIns.get(pending.name);
    if (!signIn) return { ok: false, message: 'Nova lost track of this sign-in. Start it again from Settings.' };
    try {
      await this.signIns.set(pending.name, { ...signIn, tokens: await exchange(signIn, code, pending.verifier) });
    } catch (e) {
      return { ok: false, message: `Signing in to ${label} failed: ${(e as Error).message}` };
    }
    this.signedIn.add(pending.name);
    if (c) {
      c.retries = 0;
      void this.connect(c);
    }
    return { ok: true, message: `Nova is connected to ${label}. You can close this tab.` };
  }

  /** Forget the sign-in (Nova's own copy of the tokens) and reconnect without it. */
  async signOut(name: string) {
    await this.signIns.delete(name);
    this.signedIn.delete(name);
    const c = this.connections.get(name);
    if (c) void this.connect(c);
    else this.opts.changed();
  }

  retry(name: string) {
    const c = this.connections.get(name);
    if (!c) return;
    c.retries = 0;
    void this.connect(c);
  }

  close() {
    for (const c of this.connections.values()) this.stop(c);
    this.connections.clear();
  }

  // --- Connections --------------------------------------------------------------------------

  private label(c: Connection) {
    return c.entry.label || c.client?.server.name || c.name;
  }

  private secretNames(entry: IntegrationEntry) {
    return [...new Set([...Object.values(entry.env ?? {}), ...Object.values(entry.headers ?? {})].flatMap(secretRefs))];
  }

  /** Values with their ${NAME}s filled in from .env - never with one of Nova's own secrets. */
  private resolve(map: Record<string, string> | undefined) {
    return Object.fromEntries(
      Object.entries(map ?? {}).map(([k, v]) => [k, v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => (NOVA_OWN_SECRET.test(name) ? '' : (this.opts.env[name] ?? '')))]),
    );
  }

  /** Whether a sign-in's tokens are for this address: the one signed in to (older sign-ins: the resource they're for). */
  private boundTo(signIn: SignIn, url: string) {
    return signIn.server ? sameServer(signIn.server, url) : resourceCovers(signIn.resource, url);
  }

  private async headersFor(c: Connection): Promise<Record<string, string>> {
    const headers = this.resolve(c.entry.headers);
    const signIn = await this.signIns.get(c.name);
    if (!signIn?.tokens) return headers;
    // The address changed since signing in: that service's tokens never go to the new one.
    if (!c.entry.url || !this.boundTo(signIn, c.entry.url)) {
      await this.signIns.delete(c.name);
      this.signedIn.delete(c.name);
      console.warn(`  [integrations] ${c.name}'s address changed since signing in, so Nova forgot that sign-in`);
      return headers;
    }
    if (signIn.tokens.expires_at && signIn.tokens.expires_at - Date.now() < 60_000) await this.renew(c.name, signIn.tokens.access_token);
    const current = await this.signIns.get(c.name);
    return current?.tokens ? { ...headers, authorization: `Bearer ${current.tokens.access_token}` } : headers;
  }

  /**
   * Renew a sign-in with its refresh token; false if it can't be. One renewal at a time per
   * integration - calls that need it at once share it (a refresh token often works only once) - and
   * none when another call already renewed the tokens `stale` was the access token of.
   */
  private renew(name: string, stale?: string): Promise<boolean> {
    const running = this.renewing.get(name);
    if (running) return running;
    const renewal = (async () => {
      const signIn = await this.signIns.get(name);
      if (!signIn?.tokens?.refresh_token) return false;
      if (stale !== undefined && signIn.tokens.access_token !== stale) return true; // renewed meanwhile
      try {
        await this.signIns.set(name, { ...signIn, tokens: await refresh(signIn) });
        return true;
      } catch {
        return false;
      }
    })().finally(() => this.renewing.delete(name));
    this.renewing.set(name, renewal);
    return renewal;
  }

  private set(c: Connection, state: IntegrationStatus['state'], message?: string) {
    c.state = state;
    c.message = message;
    this.opts.changed();
  }

  private stop(c: Connection) {
    c.generation++;
    clearTimeout(c.timer);
    c.client?.close();
    c.client = null;
    c.tools = [];
  }

  /** A client that has said hello - or, if it couldn't, closed again (its process stopped, its streams let go). */
  private async greeted(client: McpClient, ms: number): Promise<McpClient> {
    try {
      await client.connect(AbortSignal.timeout(ms));
      return client;
    } catch (e) {
      client.close();
      throw e;
    }
  }

  private async open(c: Connection): Promise<McpClient> {
    const e = c.entry;
    if (e.command) return this.greeted(new McpClient(new StdioTransport(e.command, e.args ?? [], this.resolve(e.env), this.opts.env)), this.timeouts.connect * 2);
    const headers = () => this.headersFor(c);
    // Streamable HTTP first; a server that only speaks the older SSE transport says so by refusing the POST.
    if (!/\/sse\/?$/.test(new URL(e.url!).pathname)) {
      try {
        return await this.greeted(new McpClient(new HttpTransport(e.url!, headers)), this.timeouts.connect);
      } catch (err) {
        if (!(err instanceof McpError) || ![400, 404, 405].includes(err.code ?? 0)) throw err;
      }
    }
    const sse = new SseTransport(e.url!, headers);
    await sse.open(AbortSignal.timeout(this.timeouts.connect));
    return this.greeted(new McpClient(sse), this.timeouts.connect);
  }

  private get timeouts() {
    return { connect: 30_000, list: 30_000, ...this.opts.timeouts };
  }

  private async connect(c: Connection) {
    this.stop(c);
    const generation = c.generation;
    if (c.entry.enabled === false) return this.set(c, 'off');
    const names = this.secretNames(c.entry);
    const own = names.filter((name) => NOVA_OWN_SECRET.test(name));
    if (own.length) return this.set(c, 'error', `${own.join(' and ')} ${own.length > 1 ? 'are' : 'is'} Nova's own - give this service a secret of its own in .env (for example NOVA_${c.name.toUpperCase().replace(/\W/g, '_')}_TOKEN).`);
    const missing = names.filter((name) => !this.opts.env[name]);
    if (missing.length) return this.set(c, 'error', `Add ${missing.join(' and ')} to .env, then press Retry.`);
    this.set(c, 'connecting');
    let client: McpClient | undefined;
    try {
      client = await this.open(c);
      if (generation !== c.generation) return client.close();
      const tools = await client.listTools(AbortSignal.timeout(this.timeouts.list));
      if (generation !== c.generation) return client.close();
      c.client = client;
      c.tools = tools;
      c.retries = 0;
      client.transport.onNotification = (method) => {
        if (method === 'notifications/tools/list_changed' && generation === c.generation) void this.relist(c, generation);
      };
      client.transport.onClose = (why) => generation === c.generation && this.lost(c, why);
      this.set(c, 'connected');
    } catch (e) {
      if (client !== c.client) client?.close(); // it said hello but couldn't list its tools: it goes
      if (generation !== c.generation) return;
      if (e instanceof NeedsSignIn) {
        c.canSignIn = true;
        c.resourceMetadata = e.resourceMetadata ?? c.resourceMetadata;
        return this.set(c, 'sign-in', this.signedIn.has(c.name) ? 'The sign-in ran out. Sign in again.' : 'Sign in to connect.');
      }
      this.lost(c, (e as Error).message);
    }
  }

  private async relist(c: Connection, generation: number) {
    try {
      const tools = await c.client!.listTools(AbortSignal.timeout(30_000));
      if (generation !== c.generation) return;
      c.tools = tools;
      this.opts.changed();
    } catch {
      // the old list stays until the next change
    }
  }

  /** The connection failed or dropped: say why, and try again after a while. */
  private lost(c: Connection, why: string) {
    c.client?.close();
    c.client = null;
    c.tools = [];
    const wait = BACKOFF[Math.min(c.retries, BACKOFF.length - 1)]!;
    c.retries++;
    this.set(c, 'error', why);
    const generation = c.generation;
    c.timer = setTimeout(() => generation === c.generation && void this.connect(c), wait);
    c.timer.unref?.();
  }
}
