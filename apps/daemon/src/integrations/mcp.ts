import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * A small MCP client: just what Nova needs from an integration - connect, list its tools, call
 * them. Local servers speak over stdio; hosted ones over Streamable HTTP, or the older SSE.
 */

export const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'Nova', version: '0.3.0' };
export const USER_AGENT = 'Nova/0.3 (MCP client)';
/** Longest tool result handed to a brain; the rest is cut, and it's told so. */
const MAX_RESULT = 24_000;

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean };
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** The server wants a sign-in (HTTP 401); `resourceMetadata` says where it describes how. */
export class NeedsSignIn extends Error {
  constructor(readonly resourceMetadata?: string) {
    super('It needs you to sign in.');
  }
}

export interface Transport {
  request(method: string, params: unknown, signal?: AbortSignal): Promise<any>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): void;
  /** Notifications from the server, e.g. its tools changed. */
  onNotification?: (method: string, params: unknown) => void;
  /** The connection went away (the process exited, the stream ended). */
  onClose?: (why: string) => void;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** A reply to a request the server makes of Nova: pings answered, nothing else offered. */
function answerServer(method: string) {
  if (method === 'ping') return { result: {} };
  if (method === 'roots/list') return { result: { roots: [] } };
  return { error: { code: -32601, message: `Nova doesn't offer ${method}.` } };
}

function settle(pending: Map<number, Pending>, message: any) {
  const waiting = pending.get(message.id);
  if (!waiting) return;
  pending.delete(message.id);
  if (message.error) waiting.reject(new McpError(String(message.error.message ?? 'The service returned an error.'), message.error.code));
  else waiting.resolve(message.result);
}

// --- stdio -----------------------------------------------------------------------------------

/** What a local server gets from Nova's environment: enough to run, none of Nova's keys. */
const PASSED_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL'];

export class StdioTransport implements Transport {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  private stderr = '';
  private closed = false;
  onNotification?: (method: string, params: unknown) => void;
  onClose?: (why: string) => void;

  constructor(command: string, args: string[], env: Record<string, string>, base: NodeJS.ProcessEnv = process.env) {
    const inherited = Object.fromEntries(PASSED_ENV.filter((k) => base[k]).map((k) => [k, base[k]!]));
    this.child = spawn(command, args, { env: { ...inherited, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr!.on('data', (d: Buffer) => (this.stderr = (this.stderr + String(d)).slice(-2000)));
    this.child.stdin!.on('error', () => {});
    createInterface({ input: this.child.stdout! }).on('line', (line) => this.receive(line));
    const end = (why: string) => {
      if (this.closed) return;
      this.closed = true;
      this.fail(why);
      this.onClose?.(why);
    };
    this.child.on('error', (e) => end(`Couldn't start ${command}: ${e.message}`));
    this.child.on('exit', (code) => end(`It stopped (${code ?? 'signal'})${this.stderr.trim() ? `: ${this.stderr.trim().split('\n').at(-1)}` : ''}`));
  }

  /** Every request still waiting gets `why`: nothing is left hanging. */
  private fail(why: string) {
    for (const p of this.pending.values()) p.reject(new McpError(why));
    this.pending.clear();
  }

  private receive(line: string) {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return; // a server logging to stdout
    }
    if (message.method && message.id !== undefined) return this.write({ jsonrpc: '2.0', id: message.id, ...answerServer(message.method) });
    if (message.method) return this.onNotification?.(message.method, message.params);
    settle(this.pending, message);
  }

  private write(message: unknown) {
    if (!this.closed) this.child.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: unknown, signal?: AbortSignal) {
    if (this.closed) return Promise.reject(new McpError('It is not running.'));
    const id = ++this.seq;
    return new Promise<any>((resolve, reject) => {
      const onAbort = () => (this.pending.delete(id), reject(new McpError('Stopped.')));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => (signal?.removeEventListener('abort', onAbort), resolve(v)),
        reject: (e) => (signal?.removeEventListener('abort', onAbort), reject(e)),
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async notify(method: string, params?: unknown) {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  close() {
    this.closed = true;
    this.fail('It was closed.');
    this.child.stdin!.end();
    this.child.kill();
  }
}

// --- Server-sent events ----------------------------------------------------------------------

/** Events from a text/event-stream body: { event, data } each. */
async function* sseEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const stop = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', stop, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
    }
  } finally {
    signal?.removeEventListener('abort', stop);
    stop();
  }
}

const resourceMetadataOf = (header: string | null) => header?.match(/resource_metadata="([^"]+)"/)?.[1];

/** An answer Nova won't read: let its connection go. */
const discard = (res: Response) => void res.body?.cancel().catch(() => {});

// --- Streamable HTTP -------------------------------------------------------------------------

export class HttpTransport implements Transport {
  private session: string | undefined;
  private protocol: string | undefined;
  private seq = 0;
  /** Closing stops the requests still on their way. */
  private readonly stop = new AbortController();
  onNotification?: (method: string, params: unknown) => void;
  onClose?: (why: string) => void;

  /** `headers` is asked before every request, so a sign-in can be refreshed in between. */
  constructor(
    private readonly url: string,
    private readonly headers: () => Promise<Record<string, string>>,
  ) {}

  private async post(message: unknown, signal?: AbortSignal) {
    if (this.stop.signal.aborted) throw new McpError('It was closed.');
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'user-agent': USER_AGENT,
        ...(this.session ? { 'mcp-session-id': this.session } : {}),
        ...(this.protocol ? { 'mcp-protocol-version': this.protocol } : {}),
        ...(await this.headers()),
      },
      body: JSON.stringify(message),
      signal: AbortSignal.any([this.stop.signal, AbortSignal.timeout(90_000), ...(signal ? [signal] : [])]),
    });
    if (res.status === 401) {
      discard(res);
      throw new NeedsSignIn(resourceMetadataOf(res.headers.get('www-authenticate')));
    }
    if (res.status === 404 && this.session) {
      discard(res);
      this.session = undefined;
      this.onClose?.('The session ended.');
      throw new McpError('The session ended.', 404);
    }
    if (!res.ok && res.status !== 202) throw new McpError(`It answered ${res.status}${(await res.text().catch(() => '')).slice(0, 160).replace(/^/, ': ')}`, res.status);
    const session = res.headers.get('mcp-session-id');
    if (session) this.session = session;
    return res;
  }

  async request(method: string, params: unknown, signal?: AbortSignal) {
    const id = ++this.seq;
    const res = await this.post({ jsonrpc: '2.0', id, method, params }, signal);
    const type = res.headers.get('content-type') ?? '';
    let result: any;
    let found = false;
    const consider = async (message: any) => {
      if (message?.method && message.id !== undefined) {
        await this.post({ jsonrpc: '2.0', id: message.id, ...answerServer(message.method) }).catch(() => {});
      } else if (message?.method) this.onNotification?.(message.method, message.params);
      else if (message?.id === id) {
        if (message.error) throw new McpError(String(message.error.message ?? 'The service returned an error.'), message.error.code);
        result = message.result;
        found = true;
      }
    };
    if (type.includes('text/event-stream') && res.body) {
      const stop = new AbortController();
      for await (const { data } of sseEvents(res.body, AbortSignal.any([stop.signal, ...(signal ? [signal] : [])]))) {
        let message: any;
        try {
          message = JSON.parse(data);
        } catch {
          continue;
        }
        await consider(message);
        if (found) {
          stop.abort();
          break;
        }
      }
    } else {
      const body = await res.json().catch(() => null);
      for (const message of Array.isArray(body) ? body : [body]) await consider(message);
    }
    if (!found) throw new McpError(`No answer to ${method}.`);
    if (method === 'initialize' && typeof result?.protocolVersion === 'string') this.protocol = result.protocolVersion;
    return result;
  }

  async notify(method: string, params?: unknown) {
    await this.post({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  close() {
    this.stop.abort();
    if (!this.session) return;
    const session = this.session;
    this.session = undefined;
    void this.headers()
      .then((h) => fetch(this.url, { method: 'DELETE', headers: { 'mcp-session-id': session, 'user-agent': USER_AGENT, ...h }, signal: AbortSignal.timeout(5000) }))
      .catch(() => {});
  }
}

// --- The older HTTP+SSE transport ------------------------------------------------------------

export class SseTransport implements Transport {
  private endpoint: string | null = null;
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  private readonly stop = new AbortController();
  onNotification?: (method: string, params: unknown) => void;
  onClose?: (why: string) => void;

  constructor(
    private readonly url: string,
    private readonly headers: () => Promise<Record<string, string>>,
  ) {}

  /** Open the event stream and wait for the address to post messages to. If it can't be opened (in time), nothing is left open. */
  async open(signal?: AbortSignal) {
    const giveUp = () => this.stop.abort();
    signal?.addEventListener('abort', giveUp, { once: true });
    try {
      await this.connect();
    } catch (e) {
      this.close();
      throw signal?.aborted ? new McpError('It took too long to answer.') : e;
    } finally {
      signal?.removeEventListener('abort', giveUp);
    }
  }

  private async connect() {
    const res = await fetch(this.url, { headers: { accept: 'text/event-stream', 'user-agent': USER_AGENT, ...(await this.headers()) }, signal: this.stop.signal });
    if (res.status === 401) {
      discard(res);
      throw new NeedsSignIn(resourceMetadataOf(res.headers.get('www-authenticate')));
    }
    if (!res.ok || !res.body) {
      discard(res);
      throw new McpError(`It answered ${res.status}`, res.status);
    }
    const events = sseEvents(res.body, this.stop.signal);
    const first = await events.next();
    if (first.done || first.value.event !== 'endpoint') throw new McpError("It didn't say where to send messages.");
    // Messages carry the sign-in: they go to the server's own site, never where it points elsewhere.
    let endpoint: URL;
    try {
      endpoint = new URL(first.value.data.trim(), this.url);
    } catch {
      throw new McpError("It didn't say where to send messages.");
    }
    if (endpoint.origin !== new URL(this.url).origin) throw new McpError(`It asked for messages to go to another site (${endpoint.origin}), so Nova didn't connect.`);
    this.endpoint = endpoint.toString();
    void (async () => {
      try {
        for await (const { data } of events) {
          let message: any;
          try {
            message = JSON.parse(data);
          } catch {
            continue;
          }
          if (message.method && message.id !== undefined) void this.send({ jsonrpc: '2.0', id: message.id, ...answerServer(message.method) }).catch(() => {});
          else if (message.method) this.onNotification?.(message.method, message.params);
          else settle(this.pending, message);
        }
      } catch {
        // closed
      }
      for (const p of this.pending.values()) p.reject(new McpError('The connection closed.'));
      this.pending.clear();
      if (!this.stop.signal.aborted) this.onClose?.('The connection closed.');
    })();
  }

  private async send(message: unknown, signal?: AbortSignal) {
    if (this.stop.signal.aborted || !this.endpoint) throw new McpError('It is not connected.');
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT, ...(await this.headers()) },
      body: JSON.stringify(message),
      signal: AbortSignal.any([this.stop.signal, ...(signal ? [signal] : [])]),
    });
    discard(res); // the answer comes on the event stream
    if (res.status === 401) throw new NeedsSignIn(resourceMetadataOf(res.headers.get('www-authenticate')));
    if (!res.ok && res.status !== 202) throw new McpError(`It answered ${res.status}`, res.status);
  }

  request(method: string, params: unknown, signal?: AbortSignal) {
    const id = ++this.seq;
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params }, signal).catch((e) => (this.pending.delete(id), reject(e)));
      signal?.addEventListener('abort', () => (this.pending.delete(id), reject(new McpError('Stopped.'))), { once: true });
    });
  }

  async notify(method: string, params?: unknown) {
    await this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  close() {
    this.stop.abort();
    for (const p of this.pending.values()) p.reject(new McpError('It was closed.'));
    this.pending.clear();
  }
}

// --- The client ------------------------------------------------------------------------------

/** A tool result as text for a brain: text parts in order, other parts named, long results cut. */
export function resultText(result: any): string {
  const parts: string[] = [];
  for (const c of Array.isArray(result?.content) ? result.content : []) {
    if (c?.type === 'text') parts.push(String(c.text ?? ''));
    else if (c?.type === 'resource') parts.push(c.resource?.text ?? `[${c.resource?.mimeType ?? 'file'} ${c.resource?.uri ?? ''}]`);
    else if (c?.type === 'resource_link') parts.push(`[${c.name ?? 'link'}: ${c.uri}]`);
    else if (c?.type) parts.push(`[${c.type}${c.mimeType ? ` ${c.mimeType}` : ''}]`);
  }
  if (!parts.length && result?.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  let text = parts.join('\n').trim() || '(nothing came back)';
  if (text.length > MAX_RESULT) text = `${text.slice(0, MAX_RESULT)}\n… (cut: ${text.length - MAX_RESULT} more characters)`;
  return result?.isError ? `The service reported a problem: ${text}` : text;
}

export class McpClient {
  /** What the server said about itself. */
  server: { name?: string; version?: string; instructions?: string } = {};

  constructor(readonly transport: Transport) {}

  async connect(signal?: AbortSignal) {
    const init = await this.transport.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, signal);
    this.server = { ...(init?.serverInfo ?? {}), instructions: init?.instructions };
    await this.transport.notify('notifications/initialized');
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.transport.request('tools/list', cursor ? { cursor } : {}, signal);
      tools.push(...(Array.isArray(result?.tools) ? result.tools : []));
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return tools.filter((t) => typeof t?.name === 'string');
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    return resultText(await this.transport.request('tools/call', { name, arguments: args }, signal));
  }

  close() {
    this.transport.close();
  }
}
