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
import { authorizeUrl, discover, exchange, pkce, refresh, register, SignIns, type SignIn } from './oauth.ts';

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

export interface HubOptions {
  env: NodeJS.ProcessEnv;
  /** Where the browser comes back after signing in (the daemon's /oauth/callback). */
  redirectUri: () => string;
  /** Open a page in the user's browser. */
  open: (url: string) => void;
  /** Connections, tools or states changed. */
  changed: () => void;
  signIns?: SignIns;
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

  specs(): IntegrationTool[] {
    const out: IntegrationTool[] = [];
    for (const c of this.connections.values()) {
      if (c.state !== 'connected') continue;
      const label = this.label(c);
      for (const tool of c.tools) {
        const policy = toolPolicy(c.entry, { name: tool.name, readOnly: tool.annotations?.readOnlyHint === true });
        if (policy === 'block') continue;
        const tier = policyTier(policy);
        const schema = (tool.inputSchema ?? {}) as Record<string, unknown>;
        const title = tool.title ?? tool.annotations?.title;
        out.push({
          name: toolName(c.name, tool.name),
          label,
          tier,
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
    }
    return out;
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    for (const c of this.connections.values()) {
      const tool = c.tools.find((t) => toolName(c.name, t.name) === name);
      if (!tool) continue;
      if (!c.client || c.state !== 'connected') throw new Error(`${this.label(c)} isn't connected.`);
      const limit = AbortSignal.timeout(CALL_TIMEOUT);
      const stop = signal ? AbortSignal.any([signal, limit]) : limit;
      try {
        return await c.client.callTool(tool.name, args, stop);
      } catch (e) {
        if (e instanceof NeedsSignIn) {
          // The sign-in ran out mid-session: renew it once, then ask the user to sign in again.
          if (await this.renew(c.name)) return c.client.callTool(tool.name, args, stop);
          c.canSignIn = true;
          this.set(c, 'sign-in', 'The sign-in ran out. Sign in again.');
        }
        throw e;
      }
    }
    throw new Error(`No integration offers ${name}.`);
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
    const found = await discover(c.entry.url, c.resourceMetadata);
    const redirect = this.opts.redirectUri();
    const known = await this.signIns.get(name);
    const client =
      known && known.client.redirect_uri === redirect && known.authServer.token_endpoint === found.authServer.token_endpoint
        ? known.client
        : await register(found.authServer, redirect);
    await this.signIns.set(name, { ...found, client, tokens: known?.tokens });
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

  /** Values with their ${NAME}s filled in from .env. */
  private resolve(map: Record<string, string> | undefined) {
    return Object.fromEntries(Object.entries(map ?? {}).map(([k, v]) => [k, v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => this.opts.env[name] ?? '')]));
  }

  private async headersFor(c: Connection): Promise<Record<string, string>> {
    const headers = this.resolve(c.entry.headers);
    const signIn = await this.signIns.get(c.name);
    if (!signIn?.tokens) return headers;
    if (signIn.tokens.expires_at && signIn.tokens.expires_at - Date.now() < 60_000) await this.renew(c.name, signIn);
    const current = await this.signIns.get(c.name);
    return current?.tokens ? { ...headers, authorization: `Bearer ${current.tokens.access_token}` } : headers;
  }

  /** Renew a sign-in with its refresh token; false if it can't be. */
  private async renew(name: string, known?: SignIn) {
    const signIn = known ?? (await this.signIns.get(name));
    if (!signIn?.tokens?.refresh_token) return false;
    try {
      await this.signIns.set(name, { ...signIn, tokens: await refresh(signIn) });
      return true;
    } catch {
      return false;
    }
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

  private async open(c: Connection): Promise<McpClient> {
    const e = c.entry;
    if (e.command) {
      const client = new McpClient(new StdioTransport(e.command, e.args ?? [], this.resolve(e.env), this.opts.env));
      await client.connect(AbortSignal.timeout(60_000));
      return client;
    }
    const headers = () => this.headersFor(c);
    // Streamable HTTP first; a server that only speaks the older SSE transport says so by refusing the POST.
    if (!/\/sse\/?$/.test(new URL(e.url!).pathname)) {
      const client = new McpClient(new HttpTransport(e.url!, headers));
      try {
        await client.connect(AbortSignal.timeout(30_000));
        return client;
      } catch (err) {
        if (!(err instanceof McpError) || ![400, 404, 405].includes(err.code ?? 0)) throw err;
      }
    }
    const sse = new SseTransport(e.url!, headers);
    await sse.open();
    const client = new McpClient(sse);
    await client.connect(AbortSignal.timeout(30_000));
    return client;
  }

  private async connect(c: Connection) {
    this.stop(c);
    const generation = c.generation;
    if (c.entry.enabled === false) return this.set(c, 'off');
    const missing = this.secretNames(c.entry).filter((name) => !this.opts.env[name]);
    if (missing.length) return this.set(c, 'error', `Add ${missing.join(' and ')} to .env, then press Retry.`);
    this.set(c, 'connecting');
    try {
      const client = await this.open(c);
      if (generation !== c.generation) return client.close();
      const tools = await client.listTools(AbortSignal.timeout(30_000));
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
