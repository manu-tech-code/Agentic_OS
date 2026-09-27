import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { settingsFile } from '../config.ts';
import { USER_AGENT } from './mcp.ts';

/**
 * Signing in to hosted integrations, as the MCP authorization spec describes: find the service's
 * sign-in server (RFC 9728, RFC 8414), register Nova with it (RFC 7591), and sign in with the
 * browser (OAuth 2.1 with PKCE). The user signs in themselves; Nova only keeps the tokens.
 */

export interface AuthServer {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

export interface SignIn {
  authServer: AuthServer;
  /** The server the tokens are for (the `resource` of every request). */
  resource: string;
  scope?: string;
  client: { client_id: string; client_secret?: string; redirect_uri: string };
  tokens?: { access_token: string; refresh_token?: string; expires_at?: number; token_type?: string; scope?: string };
}

/** Where sign-ins are kept: next to the settings file, readable by the user only. */
export const tokensFile = () => join(dirname(settingsFile()), 'integration-tokens.json');

/** The sign-ins Nova holds, by integration name. */
export class SignIns {
  private cache: Record<string, SignIn> | null = null;
  private saving: Promise<unknown> = Promise.resolve();

  private async load() {
    if (!this.cache) {
      try {
        this.cache = JSON.parse(await readFile(tokensFile(), 'utf8')) as Record<string, SignIn>;
      } catch {
        this.cache = {};
      }
    }
    return this.cache;
  }

  async get(name: string): Promise<SignIn | undefined> {
    return (await this.load())[name];
  }

  async names() {
    return Object.keys(await this.load());
  }

  async set(name: string, signIn: SignIn) {
    (await this.load())[name] = signIn;
    return this.save();
  }

  async delete(name: string) {
    delete (await this.load())[name];
    return this.save();
  }

  private save() {
    const data = JSON.stringify(this.cache ?? {}, null, 2);
    this.saving = this.saving.then(async () => {
      const file = tokensFile();
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, `${data}\n`, { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    });
    return this.saving;
  }
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

async function firstJson(urls: string[]) {
  for (const url of urls) {
    try {
      return await getJson(url);
    } catch {
      // try the next place
    }
  }
  return null;
}

/** Where and how to sign in for an MCP server. */
export async function discover(serverUrl: string, resourceMetadata?: string): Promise<Pick<SignIn, 'authServer' | 'resource' | 'scope'>> {
  const server = new URL(serverUrl);
  const path = server.pathname.replace(/\/$/, '');
  const resource = await firstJson(
    resourceMetadata ? [resourceMetadata] : [`${server.origin}/.well-known/oauth-protected-resource${path}`, `${server.origin}/.well-known/oauth-protected-resource`],
  );
  const issuer = new URL(resource?.authorization_servers?.[0] ?? server.origin);
  const issuerPath = issuer.pathname.replace(/\/$/, '');
  const auth = await firstJson([
    `${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`,
    `${issuer.origin}/.well-known/openid-configuration${issuerPath}`,
    ...(issuerPath ? [`${issuer.origin}${issuerPath}/.well-known/openid-configuration`] : []),
  ]);
  if (!auth?.authorization_endpoint || !auth?.token_endpoint) throw new Error("It doesn't describe how to sign in.");
  return {
    authServer: auth,
    resource: typeof resource?.resource === 'string' ? resource.resource : serverUrl,
    scope: Array.isArray(resource?.scopes_supported) && resource.scopes_supported.length ? resource.scopes_supported.join(' ') : undefined,
  };
}

/** Register Nova with a sign-in server, for one redirect address. */
export async function register(authServer: AuthServer, redirectUri: string): Promise<SignIn['client']> {
  if (!authServer.registration_endpoint) throw new Error("It doesn't let apps like Nova register themselves, so it can't sign in this way. Use a token instead.");
  const res = await fetch(authServer.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({
      client_name: 'Nova',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || typeof body.client_id !== 'string') throw new Error(`Registering Nova failed (${res.status}${body.error ? `: ${body.error}` : ''}).`);
  return { client_id: body.client_id, client_secret: typeof body.client_secret === 'string' ? body.client_secret : undefined, redirect_uri: redirectUri };
}

/** A PKCE pair: the verifier Nova keeps, and its challenge for the sign-in page. */
export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** The sign-in page to open in the browser. */
export function authorizeUrl(signIn: SignIn, state: string, challenge: string) {
  const url = new URL(signIn.authServer.authorization_endpoint);
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: signIn.client.client_id,
    redirect_uri: signIn.client.redirect_uri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource: signIn.resource,
  };
  if (signIn.scope) params.scope = signIn.scope;
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

async function tokenRequest(signIn: SignIn, params: Record<string, string>): Promise<NonNullable<SignIn['tokens']>> {
  const body = new URLSearchParams({
    ...params,
    client_id: signIn.client.client_id,
    resource: signIn.resource,
    ...(signIn.client.client_secret ? { client_secret: signIn.client.client_secret } : {}),
  });
  const res = await fetch(signIn.authServer.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': USER_AGENT },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || typeof json.access_token !== 'string') throw new Error(json.error_description ?? json.error ?? `Signing in failed (${res.status}).`);
  return {
    access_token: json.access_token,
    refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : signIn.tokens?.refresh_token,
    token_type: json.token_type,
    scope: json.scope,
    expires_at: typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : undefined,
  };
}

/** Swap the code the browser brought back for tokens. */
export const exchange = (signIn: SignIn, code: string, verifier: string) =>
  tokenRequest(signIn, { grant_type: 'authorization_code', code, redirect_uri: signIn.client.redirect_uri, code_verifier: verifier });

/** New tokens from the refresh token, before the old ones run out. */
export function refresh(signIn: SignIn) {
  if (!signIn.tokens?.refresh_token) return Promise.reject(new Error('There is no refresh token.'));
  return tokenRequest(signIn, { grant_type: 'refresh_token', refresh_token: signIn.tokens.refresh_token });
}
