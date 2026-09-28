import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setPath } from '@nova/core';
import { fromLegacy, loadConfig, migrateSettings, readSettings, settingsInEnv } from '../src/config.ts';
import { settingValues, validateChanges } from '../src/snapshot.ts';

const scratchFile = () => join(mkdtempSync(join(tmpdir(), 'nova-settings-')), 'settings.json');

describe('config: the settings file, plus constants from .env', () => {
  it('uses defaults when nothing is set', () => {
    const c = loadConfig({}, {});
    expect(c.port).toBe(7878);
    expect(c.wakeWords).toEqual(['hey nova', 'okay nova', 'nova']);
    expect(c.followUpMs).toBe(30_000);
    expect(c.agents).toBeNull(); // every installed agent
    expect(c.ui).toEqual({ autoListen: true, rate: 1.05, lang: 'en-US', orb: { style: 'particles', colors: 'nova', motion: 'lively', size: 100, floatingSize: 100 }, textSize: 100, cardSeconds: 8 });
    expect(c.warnings).toEqual([]);
  });

  it("keeps a reply's cards for as long as chosen - or until they are closed", () => {
    expect(loadConfig({ appearance: { cardsClose: '15' } }, {}).ui.cardSeconds).toBe(15);
    // Permissions: Do what I ask, "yes, always" kept for good, paying and risky commands still asked - until changed.
    expect(loadConfig({}, {}).permissions).toEqual({ mode: 'auto', stillAsk: true, alwaysForGood: true });
    expect(loadConfig({ trust: { mode: 'free', stillAsk: false, alwaysForGood: false } }, {}).permissions).toEqual({ mode: 'free', stillAsk: false, alwaysForGood: false });
    // Set before Permissions existed: "Ask before doing what you asked for" on is Ask first - unless a mode is set.
    expect(loadConfig({ trust: { askFirst: true } }, {}).permissions.mode).toBe('ask');
    expect(loadConfig({ trust: { askFirst: false } }, {}).permissions.mode).toBe('auto');
    expect(loadConfig({ trust: { askFirst: true, mode: 'free' } }, {}).permissions.mode).toBe('free');
    const bad = loadConfig({ trust: { mode: 'always' } }, {});
    expect(bad.permissions.mode).toBe('auto');
    expect(bad.warnings.join(' ')).toMatch(/trust\.mode/);
    expect(loadConfig({ trust: { askFirst: true } }, {}).warnings).toEqual([]);
    expect(loadConfig({ appearance: { cardsClose: 'never' } }, {}).ui.cardSeconds).toBe(0);
  });

  it('reads nested settings in friendly units, and secrets from the environment', () => {
    const c = loadConfig(
      {
        name: 'Jarvis',
        voice: { followUpSeconds: 10, rate: 1.2 },
        answers: { model: 'claude', timeoutSeconds: 90 },
        agents: { enabled: ['codex', 'claude'], options: { claude: { model: 'sonnet', args: '--verbose  --x' } }, taskTimeoutMinutes: 5 },
        models: { servers: { jan: { url: 'http://localhost:1337/v1' }, lmstudio: { structuredOutputs: false } } },
        projects: { named: { site: '~/site' } },
      },
      { NOVA_JAN_API_KEY: 'k', NOVA_PORT: '9000' },
    );
    expect(c).toMatchObject({
      name: 'Jarvis',
      wakeWords: ['hey jarvis', 'okay jarvis', 'jarvis'],
      followUpMs: 10_000,
      replyTimeoutMs: 90_000,
      agentTaskTimeoutMs: 300_000,
      brainModel: 'claude',
      agents: ['codex', 'claude'],
      projects: { site: '~/site' },
      port: 9000,
    });
    expect(c.agentOptions.claude).toEqual({ model: 'sonnet', bin: undefined, args: ['--verbose', '--x'] });
    expect(c.localProviders.jan).toEqual({ url: 'http://localhost:1337/v1', apiKey: 'k', structuredOutputs: true });
    expect(c.localProviders.lmstudio).toEqual({ url: 'http://localhost:1234/v1', apiKey: undefined, structuredOutputs: false });
  });

  it("reads Jev's model as TypeSafe names it, whatever the gateway days left in the file", () => {
    expect(loadConfig({}, {}).jevModel).toBe('jev-latest');
    expect(loadConfig({ decisions: { jevModel: 'typesafe-ai/jev' } }, {}).jevModel).toBe('jev-latest');
    expect(loadConfig({ decisions: { jevModel: 'jev-1.13.0' } }, {}).jevModel).toBe('jev-1.13.0');
  });

  it('ignores settings left in .env - only constants and secrets come from there', () => {
    const c = loadConfig({}, { NOVA_NAME: 'Jarvis', NOVA_BRAIN_MODEL: 'claude', NOVA_AGENTS: '', NOVA_JEV_API_KEY: 'jk' });
    expect(c).toMatchObject({ name: 'Nova', brainModel: '', agents: null, jevKey: 'jk' });
    expect(settingsInEnv({ NOVA_NAME: 'x', NOVA_CLAUDE_MODEL: 'y', NOVA_PORT: '1', NOVA_OMLX_API_KEY: 'z', PATH: '/bin' })).toEqual(['NOVA_CLAUDE_MODEL', 'NOVA_NAME']);
  });

  it('falls back to the default for anything unusable, and says why', () => {
    const c = loadConfig(
      {
        voice: { rate: 'fast', requireWakeWord: 'no' },
        decisions: { engine: 'magic' },
        models: { servers: { nourl: {}, jan: { url: 'http://jan:1337/v1' } } },
        agents: { enabled: 'claude' },
      },
      { NOVA_PORT: 'abc' },
    );
    expect(c.ui.rate).toBe(1.05);
    expect(c.requireWakeWord).toBe(true);
    expect(c.engine).toBe('auto');
    expect(c.localProviders).not.toHaveProperty('nourl');
    expect(c.localProviders.jan?.url).toBe('http://jan:1337/v1');
    expect(c.agents).toBeNull();
    expect(c.port).toBe(7878);
    expect(c.warnings).toHaveLength(5);
    expect(c.warnings).toContainEqual(expect.stringMatching(/^voice\.requireWakeWord should be true or false/));
  });

  it('treats an empty agent list as no agents and blank wake words as following the name', () => {
    expect(loadConfig({ agents: { enabled: [] } }, {}).agents).toEqual([]);
    expect(loadConfig({ name: '  ', voice: { wakeWords: [' ', ''] } }, {})).toMatchObject({ name: 'Nova', wakeWords: ['hey nova', 'okay nova', 'nova'] });
    expect(loadConfig({ name: 'Jarvis', voice: { wakeWords: ['computer'] } }, {}).wakeWords).toEqual(['computer']);
    expect(loadConfig({ projects: { scan: false } }, {}).projectsDir).toBe('');
  });
});

describe('moving settings out of .env', () => {
  it('maps the old keys, leaving out defaults', () => {
    expect(
      fromLegacy({
        NOVA_NAME: 'Jarvis',
        NOVA_WAKE_WORDS: 'hey nova,okay nova,nova', // stock words keep following the name
        NOVA_FOLLOW_UP_MS: '30000',
        NOVA_REPLY_TIMEOUT_MS: '90000',
        NOVA_DECISION_ENGINE: 'auto',
        NOVA_BRAIN_MODEL: 'lmstudio/google/gemma-4-e4b',
        NOVA_AGENTS: 'claude,codex',
        NOVA_CLAUDE_MODEL: 'sonnet',
        NOVA_LOCAL_PROVIDERS: 'omlx=http://localhost:8000/v1,lmstudio=http://localhost:1234/v1',
        NOVA_LMSTUDIO_STRUCTURED_OUTPUTS: 'false',
        NOVA_JAN_STRUCTURED_OUTPUTS: 'false', // a server with no address: dropped
        NOVA_OMLX_API_KEY: 'secret',
        NOVA_PROJECTS: 'site=~/site',
        NOVA_PROJECTS_DIR: '',
        NOVA_PORT: '7878',
      }),
    ).toEqual({
      name: 'Jarvis',
      answers: { model: 'lmstudio/google/gemma-4-e4b', timeoutSeconds: 90 },
      agents: { enabled: ['claude', 'codex'], options: { claude: { model: 'sonnet' } } },
      models: { servers: { omlx: { url: 'http://localhost:8000/v1' }, lmstudio: { structuredOutputs: false } } },
      projects: { named: { site: '~/site' }, scan: false },
    });
    expect(fromLegacy({ NOVA_AGENTS: '' })).toEqual({ agents: { enabled: [] } });
  });

  it('writes the settings file once, and leaves it alone after that', async () => {
    const file = scratchFile();
    expect(await migrateSettings({ NOVA_NAME: 'Jarvis', NOVA_PORT: '7878' }, file)).toMatchObject({ moved: ['name'] });
    expect(await readSettings(file)).toEqual({ name: 'Jarvis' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await migrateSettings({ NOVA_NAME: 'Friday' }, file)).toBeNull();
    expect(await readSettings(file)).toEqual({ name: 'Jarvis' });
  });

  it('converts an early flat settings file, keeping a copy and leaving secrets out', async () => {
    const file = scratchFile();
    writeFileSync(file, JSON.stringify({ NOVA_BRAIN_MODEL: 'claude', NOVA_JEV_API_KEY: 'k' }));
    expect(await migrateSettings({ NOVA_BRAIN_MODEL: 'codex', NOVA_NAME: 'Jarvis' }, file)).toMatchObject({ secrets: ['NOVA_JEV_API_KEY'] });
    expect(await readSettings(file)).toEqual({ name: 'Jarvis', answers: { model: 'claude' } });
    expect(existsSync(`${file}.bak`)).toBe(true);
  });

  it('never replaces a settings file it cannot read', async () => {
    const file = scratchFile();
    writeFileSync(file, '{ "name": ');
    expect(await migrateSettings({ NOVA_NAME: 'Jarvis' }, file)).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe('{ "name": ');
    await expect(readSettings(file)).rejects.toThrow(/isn't valid JSON/);
  });
});

describe('settings snapshot and changes', () => {
  it('says which values are saved and never includes a secret', () => {
    const settings = { answers: { model: 'claude' } };
    const env = { NOVA_JEV_API_KEY: 'secret-one', NOVA_OMLX_API_KEY: 'secret-two' };
    const { values, saved, secrets } = settingValues(settings, loadConfig(settings, env), env);
    expect(saved).toMatchObject({ 'answers.model': true, 'voice.rate': false });
    expect(values).toMatchObject({ 'answers.model': 'claude', 'voice.wakeWords': ['hey nova', 'okay nova', 'nova'], 'voice.followUpSeconds': 30 });
    expect(secrets).toMatchObject({ NOVA_JEV_API_KEY: true, NOVA_OMLX_API_KEY: true, NOVA_OLLAMA_API_KEY: false });
    expect(JSON.stringify({ values, saved, secrets })).not.toContain('secret-');
  });

  it('rejects changes it cannot accept', () => {
    expect(() => validateChanges({ PATH: '/tmp' })).toThrow(/can't be changed/);
    expect(() => validateChanges({ NOVA_JEV_API_KEY: 'k' })).toThrow(/can't be changed/);
    expect(() => validateChanges({ toString: 1 })).toThrow(/can't be changed/);
    expect(() => validateChanges(JSON.parse('{"__proto__": {"x": 1}}'))).toThrow(/can't be changed/);
    expect(() => validateChanges({ 'voice.rate': '1.1' })).toThrow(/should be a number/);
    expect(() => validateChanges({ 'voice.rate': 9 })).toThrow(/at most 2/);
    expect(() => validateChanges({ 'decisions.engine': 'magic' })).toThrow(/one of/);
    expect(() => validateChanges({ 'models.servers.jan': {} })).toThrow(/needs a url/);
    expect(() => validateChanges({ 'agents.custom': { aider: { command: 'aider' } } })).toThrow(/needs "command", "ask" and "task"/);
    expect(() => validateChanges({ 'projects.named.__proto__': '~/x' })).toThrow(/name/);
    expect(() =>
      validateChanges({ name: 'Jarvis', 'voice.wakeWords': ['computer'], 'agents.options.claude': { model: 'sonnet' }, 'models.servers.lmstudio': null }),
    ).not.toThrow();
  });

  it('saves by path and tidies up what a reset leaves empty', () => {
    const s: Record<string, unknown> = { voice: { rate: 1.2 } };
    setPath(s, 'models.servers.jan', { url: 'http://jan:1337/v1' });
    expect(s).toEqual({ voice: { rate: 1.2 }, models: { servers: { jan: { url: 'http://jan:1337/v1' } } } });
    setPath(s, 'models.servers.jan', undefined);
    setPath(s, 'voice.rate', undefined);
    setPath(s, 'answers.model', undefined);
    expect(s).toEqual({});
  });
});
