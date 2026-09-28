import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { AD_HOC, APPS, designatedRequirement, needsSigning, parseIdentities, signArgs, signingIdentity, signingStatus, type Run } from '../src/shell/signing.ts';
import { setupSteps } from '../src/trust/setup.ts';

// A throwaway self-made certificate shaped like an Apple Development one (team AB12CD34EF); no key comes with it.
const CERT = readFileSync(new URL('./fixtures/signing-cert.pem', import.meta.url), 'utf8');
const CERT_HASH = 'CB58A614779373F86EDC00CBAD17B659C0E02929';
const DEV = `Apple Development: test@example.com (ZZ99YY88XX)`;

const identities = (...lines: [hash: string, name: string][]) =>
  `${lines.map(([hash, name], i) => `  ${i + 1}) ${hash} "${name}"`).join('\n')}\n     ${lines.length} valid identities found\n`;

/** security and codesign as a Mac would answer, from canned output. */
function mac(opts: { identities?: string; certs?: string; codesign?: Record<string, string> } = {}) {
  const calls: string[][] = [];
  const run: Run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'security' && args[0] === 'find-identity') return { stdout: opts.identities ?? '     0 valid identities found\n', stderr: '' };
    if (command === 'security' && args[0] === 'find-certificate') return { stdout: opts.certs ?? '', stderr: '' };
    if (command === 'codesign' && args[0] === '-dvv') {
      const out = opts.codesign?.[args[1]!];
      if (out === undefined) throw new Error('code object is not signed at all');
      return { stdout: '', stderr: out };
    }
    return { stdout: '', stderr: '' };
  };
  return { run, calls };
}

describe('the identity Nova signs with', () => {
  it('reads what security lists', () => {
    expect(parseIdentities(identities([CERT_HASH, DEV], ['A'.repeat(40), 'Developer ID Application: Test (AB12CD34EF)']))).toEqual([
      { hash: CERT_HASH, name: DEV },
      { hash: 'A'.repeat(40), name: 'Developer ID Application: Test (AB12CD34EF)' },
    ]);
  });

  it("takes the user's Apple certificate, with its team and when it runs out", async () => {
    const { run } = mac({ identities: identities([CERT_HASH, DEV]), certs: CERT });
    expect(await signingIdentity({}, run)).toEqual({ sign: CERT_HASH, name: DEV, team: 'AB12CD34EF', expires: Date.parse('Sep 25 00:26:32 2036 GMT') });
  });

  it('prefers Developer ID, then Apple Development, then anything else - and NOVA_SIGN_IDENTITY picks', async () => {
    const list = identities(['B'.repeat(40), 'Self Made'], [CERT_HASH, DEV], ['C'.repeat(40), 'Developer ID Application: Test (AB12CD34EF)']);
    expect((await signingIdentity({}, mac({ identities: list }).run)).name).toBe('Developer ID Application: Test (AB12CD34EF)');
    expect((await signingIdentity({}, mac({ identities: identities(['B'.repeat(40), 'Self Made'], [CERT_HASH, DEV]) }).run)).name).toBe(DEV);
    expect((await signingIdentity({ NOVA_SIGN_IDENTITY: 'Self Made' }, mac({ identities: list }).run)).sign).toBe('B'.repeat(40));
    expect((await signingIdentity({ NOVA_SIGN_IDENTITY: CERT_HASH.toLowerCase() }, mac({ identities: list }).run)).name).toBe(DEV);
    expect(await signingIdentity({ NOVA_SIGN_IDENTITY: '-' }, mac({ identities: list }).run)).toBe(AD_HOC);
  });

  it('signs ad hoc with no certificate at all', async () => {
    expect(await signingIdentity({}, mac().run)).toBe(AD_HOC);
  });
});

describe('what macOS keys the permissions to', () => {
  const yours = { sign: CERT_HASH, name: DEV, team: 'AB12CD34EF', expires: null };

  it("pins them to the app's id and the user's team - which rebuilds and renewals meet, and no one else's app can", () => {
    expect(designatedRequirement('dev.nova.app', yours)).toBe('designated => identifier "dev.nova.app" and anchor apple generic and certificate leaf[subject.OU] = "AB12CD34EF"');
    expect(designatedRequirement('dev.nova.app', AD_HOC)).toBeNull();
    expect(designatedRequirement('dev.nova.app', { ...yours, team: 'not a team"' })).toBeNull();
  });

  it('signs every app hardened, with what it declares', () => {
    const app = signArgs('/x/Nova.app', 'app', yours);
    expect(app).toEqual(expect.arrayContaining(['--options', 'runtime', '--entitlements', APPS.app.entitlements, '--identifier', 'dev.nova.app']));
    expect(app.find((a) => a.startsWith('-r='))).toContain('leaf[subject.OU] = "AB12CD34EF"');
    expect(app.at(-1)).toBe('/x/Nova.app');
    expect(signArgs('/x/Nova Eyes.app', 'eyes', yours)).toEqual(expect.arrayContaining(['--entitlements', APPS.eyes.entitlements]));
    expect(signArgs('/x/nova-hearing', 'hearing', yours)).not.toContain('--entitlements');
    expect(signArgs('/x/nova-hearing', 'hearing', AD_HOC)).toEqual(expect.arrayContaining(['--sign', '-', '--options', 'runtime']));
    expect(signArgs('/x/nova-hearing', 'hearing', AD_HOC).some((a) => a.startsWith('-r='))).toBe(false);
  });

  it('signs a built app again only when the identity changed, or it isn\'t hardened', async () => {
    const report = (team: string, flags: string) => `Executable=/x\nIdentifier=dev.nova.eyes\nCodeDirectory v=20500 size=1 flags=${flags} hashes=1+0\nAuthority=${DEV}\nTeamIdentifier=${team}\n`;
    const signed = mac({ codesign: { '/yours': report('AB12CD34EF', '0x10000(runtime)'), '/soft': report('AB12CD34EF', '0x0(none)'), '/adhoc': report('not set', '0x10002(adhoc,runtime)') } }).run;
    expect(await needsSigning('/yours', yours, signed)).toBe(false);
    expect(await needsSigning('/soft', yours, signed)).toBe(true);
    expect(await needsSigning('/adhoc', yours, signed)).toBe(true);
    expect(await needsSigning('/adhoc', AD_HOC, signed)).toBe(false);
    expect(await needsSigning('/yours', AD_HOC, signed)).toBe(true);
    expect(await needsSigning('/missing', yours, signed)).toBe(true);
    const status = await signingStatus(yours, [{ name: 'Nova.app', path: '/yours' }, { name: 'Nova Eyes', path: '/adhoc' }, { name: 'the hearing helper', path: '/missing' }], signed);
    expect(status.apps).toEqual([
      { name: 'Nova.app', signed: 'yours', hardened: true },
      { name: 'Nova Eyes', signed: 'ad hoc', hardened: true },
      { name: 'the hearing helper', signed: 'not built', hardened: false },
    ]);
  });
});

describe('the setup checklist on signing', () => {
  const base = {
    config: loadConfig({}, {}),
    reflex: { installed: true, learned: 0, label: 'potion' },
    voice: { installed: true, label: 'Kokoro' },
    hearing: { status: { engine: 'apple', state: 'ready' }, parakeet: {} as never, smartTurn: {} as never } as never,
    app: null,
    appInstalled: true,
    agents: [],
    brain: null,
    projects: [],
    screen: { available: true, running: false, permissions: null },
  };
  const step = (signing: Parameters<typeof setupSteps>[0]['signing']) => setupSteps({ ...base, signing }).find((s) => s.id === 'signing');
  const signing = { identity: `${DEV} (team AB12CD34EF)`, team: 'AB12CD34EF', expires: Date.now() + 200 * 86_400_000, adHoc: false };

  it('is done when every built app is signed with the certificate, hardened', () => {
    expect(step({ ...signing, apps: [{ name: 'Nova.app', signed: 'yours', hardened: true }, { name: 'Nova Eyes', signed: 'not built', hardened: false }] })).toMatchObject({ done: true, fix: { section: 'system' } });
  });

  it('says to run npm run app when one is behind, and to renew a certificate that runs out soon', () => {
    expect(step({ ...signing, apps: [{ name: 'Nova.app', signed: 'ad hoc', hardened: false }] })).toMatchObject({ done: false, fix: { command: 'npm run app' } });
    expect(step({ ...signing, expires: Date.now() + 5 * 86_400_000, apps: [{ name: 'Nova.app', signed: 'yours', hardened: true }] })?.detail).toMatch(/runs out soon.*Xcode/);
  });

  it('without a certificate: optional, and how to get one', () => {
    expect(step({ identity: 'ad hoc', team: null, expires: null, adHoc: true, apps: [] })).toMatchObject({ done: false, optional: true, detail: expect.stringMatching(/Sign in to Xcode/) });
  });
});
