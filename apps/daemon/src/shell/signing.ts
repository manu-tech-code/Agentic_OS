import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * How Nova's own apps are signed - Nova.app, Nova Eyes and the hearing helper - so macOS remembers what
 * the user allowed them (the microphone, the screen, Accessibility) across rebuilds. macOS keys each
 * permission to an app's designated requirement: signed "for this Mac alone" (ad hoc) that's the exact
 * build, forgotten at every rebuild; signed with the user's own Apple certificate it's the app's id
 * and the user's team, which every rebuild - and next year's renewed certificate - still meets, and no
 * one else's app can.
 */

export type Run = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
const exec: Run = promisify(execFile) as unknown as Run;

export interface SigningIdentity {
  /** What codesign signs with: the certificate's SHA-1 (unambiguous), or "-" for ad hoc. */
  sign: string;
  /** "Apple Development: you@example.com (AB12CD34EF)", or how it's signed without one. */
  name: string;
  /** The Apple team the certificate belongs to (its OU): the permissions are pinned to it. */
  team: string | null;
  /** When the certificate runs out (epoch ms). */
  expires: number | null;
}

export const AD_HOC: SigningIdentity = { sign: '-', name: 'for this Mac alone (ad hoc)', team: null, expires: null };

/** Nova's apps, by the id each is signed with - and what each declares under the hardened runtime. */
export const APPS = {
  app: { identifier: 'dev.nova.app', entitlements: fileURLToPath(new URL('../../../desktop/macos/Nova.entitlements', import.meta.url)) },
  eyes: { identifier: 'dev.nova.eyes', entitlements: fileURLToPath(new URL('../../native/eyes/Eyes.entitlements', import.meta.url)) },
  hearing: { identifier: 'dev.nova.hearing', entitlements: null },
} as const;
export type NovaApp = keyof typeof APPS;

/** One code-signing identity from `security find-identity`. */
interface Found {
  hash: string;
  name: string;
}

/** `security find-identity -v -p codesigning` lines: `  1) <SHA-1> "Apple Development: …"`. */
export function parseIdentities(out: string): Found[] {
  return [...out.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm)].map((m) => ({ hash: m[1]!, name: m[2]! }));
}

/**
 * The identity to sign with. NOVA_SIGN_IDENTITY in .env picks one (its name, part of it, or its SHA-1;
 * "-" signs ad hoc). Otherwise the best the user has: Developer ID Application, then Apple Development
 * (Xcode makes one when you sign in with an Apple ID), then any other code-signing certificate, then ad hoc.
 */
export async function signingIdentity(env: Record<string, string | undefined> = process.env, run: Run = exec): Promise<SigningIdentity> {
  const wanted = env.NOVA_SIGN_IDENTITY?.trim();
  if (wanted === '-') return AD_HOC;
  const found = parseIdentities(await run('security', ['find-identity', '-v', '-p', 'codesigning']).then((r) => r.stdout, () => ''));
  const rank = (f: Found) => (f.name.startsWith('Developer ID Application:') ? 0 : f.name.startsWith('Apple Development:') ? 1 : 2);
  const pick = wanted ? found.find((f) => f.hash === wanted.toUpperCase() || f.name === wanted) ?? found.find((f) => f.name.includes(wanted)) : [...found].sort((a, b) => rank(a) - rank(b))[0];
  if (!pick) return AD_HOC;
  const cert = await certificate(pick, run);
  return { sign: pick.hash, name: pick.name, team: cert?.team ?? null, expires: cert?.expires ?? null };
}

/** The certificate behind an identity: its team (subject OU) and when it runs out. */
async function certificate(found: Found, run: Run): Promise<{ team: string | null; expires: number } | null> {
  const pem = await run('security', ['find-certificate', '-a', '-c', found.name, '-p']).then((r) => r.stdout, () => '');
  for (const block of pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []) {
    try {
      const cert = new X509Certificate(block);
      if (cert.fingerprint.replace(/:/g, '') !== found.hash) continue;
      const team = /^OU=(.+)$/m.exec(cert.subject)?.[1]?.trim() ?? null;
      return { team, expires: Date.parse(cert.validTo) };
    } catch {
      // not one we can read
    }
  }
  return null;
}

/**
 * What macOS keys the app's permissions to. With a team: the app's id and certificates Apple issued to
 * that team, which rebuilds and renewals meet and nobody else's app can. Without one, codesign's own
 * (the exact certificate, or for ad hoc the exact build).
 */
export function designatedRequirement(identifier: string, identity: SigningIdentity): string | null {
  if (!identity.team || !/^[A-Z0-9]{10}$/.test(identity.team)) return null;
  return `designated => identifier "${identifier}" and anchor apple generic and certificate leaf[subject.OU] = "${identity.team}"`;
}

/** codesign's arguments for one of Nova's apps: the hardened runtime, its entitlements, the pinned requirement. */
export function signArgs(path: string, app: NovaApp, identity: SigningIdentity): string[] {
  const { identifier, entitlements } = APPS[app];
  const requirement = designatedRequirement(identifier, identity);
  return [
    '--force',
    '--sign',
    identity.sign,
    '--identifier',
    identifier,
    // Hardened: no code injected into it to borrow its permissions, and only what it declares.
    '--options',
    'runtime',
    '--timestamp=none',
    ...(entitlements ? ['--entitlements', entitlements] : []),
    ...(requirement ? [`-r=${requirement}`] : []),
    path,
  ];
}

/** Sign one of Nova's apps (a bundle or a bare binary). */
export async function signApp(path: string, app: NovaApp, identity: SigningIdentity, run: Run = exec): Promise<void> {
  await run('codesign', signArgs(path, app, identity));
}

/** Who a built app is signed by now: its team (none for ad hoc) and whether it runs hardened. */
export async function signedBy(path: string, run: Run = exec): Promise<{ team: string | null; authority: string | null; hardened: boolean } | null> {
  // codesign -dvv writes its report to stderr.
  const out = await run('codesign', ['-dvv', path]).then(
    (r) => `${r.stdout}\n${r.stderr}`,
    () => null,
  );
  if (out === null) return null;
  const team = /^TeamIdentifier=(.+)$/m.exec(out)?.[1]?.trim();
  return {
    team: team && team !== 'not set' ? team : null,
    authority: /^Authority=(.+)$/m.exec(out)?.[1]?.trim() ?? null,
    hardened: /flags=0x[0-9a-f]+\([^)]*\bruntime\b/.test(out),
  };
}

/** Whether a built app needs signing again: not by this identity, or not hardened. */
export async function needsSigning(path: string, identity: SigningIdentity, run: Run = exec): Promise<boolean> {
  const now = await signedBy(path, run);
  if (!now || !now.hardened) return true;
  return identity.team ? now.team !== identity.team || now.authority !== identity.name : now.team !== null;
}

/** "Apple Development: … (team AB12CD34EF), until 17 September 2027" - or the ad hoc warning. */
export function describeIdentity(identity: SigningIdentity): string {
  if (identity.sign === '-') return 'for this Mac alone (ad hoc) - macOS asks for its permissions again after every rebuild';
  const until = identity.expires ? `, until ${new Date(identity.expires).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}` : '';
  return `${identity.name}${identity.team ? ` (team ${identity.team})` : ''}${until}`;
}

export type SigningStatus = {
  identity: string;
  team: string | null;
  expires: number | null;
  adHoc: boolean;
  apps: { name: string; signed: 'yours' | 'ad hoc' | 'other' | 'not built'; hardened: boolean }[];
};

/** How each of Nova's apps is signed, against the identity it should be: for Settings and the setup checklist. */
export async function signingStatus(identity: SigningIdentity, apps: { name: string; path: string }[], run: Run = exec): Promise<SigningStatus> {
  const each = await Promise.all(
    apps.map(async ({ name, path }) => {
      const now = await signedBy(path, run);
      const signed: SigningStatus['apps'][number]['signed'] = !now ? 'not built' : !now.team ? 'ad hoc' : identity.team && now.team === identity.team ? 'yours' : 'other';
      return { name, signed, hardened: now?.hardened ?? false };
    }),
  );
  return { identity: describeIdentity(identity), team: identity.team, expires: identity.expires, adHoc: identity.sign === '-', apps: each };
}

let cached: Promise<SigningIdentity> | null = null;
/** The identity, found once per process (asking the keychain every time is slow). */
export const currentIdentity = () => (cached ??= signingIdentity().catch(() => AD_HOC));
