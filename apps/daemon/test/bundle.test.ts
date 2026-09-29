import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateSettings, settingsInEnv } from '../src/config.ts';
import { isInstalled, KOKORO_MODEL, MODELS, whereInstalled } from '../src/models/files.ts';

const temp = () => mkdtemp(join(tmpdir(), 'nova-bundle-'));
const saved = { models: process.env.NOVA_MODELS_DIR, bundled: process.env.NOVA_BUNDLED_MODELS };
afterEach(() => {
  for (const [k, v] of [['NOVA_MODELS_DIR', saved.models], ['NOVA_BUNDLED_MODELS', saved.bundled]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A model's files at their listed sizes (sparse: they take no space). */
async function lay(dir: string, name: string) {
  for (const [file, check] of Object.entries(MODELS[name]!.files)) {
    const path = join(dir, name, file);
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, 'w');
    await handle.truncate(check.size);
    await handle.close();
  }
}

describe("Nova's voice, inside Nova.app", () => {
  it('is found in the app when it was never downloaded', async () => {
    process.env.NOVA_MODELS_DIR = await temp();
    process.env.NOVA_BUNDLED_MODELS = await temp();
    expect(await whereInstalled(KOKORO_MODEL)).toBeNull();
    await lay(process.env.NOVA_BUNDLED_MODELS, KOKORO_MODEL);
    expect(await whereInstalled(KOKORO_MODEL)).toEqual({ dir: process.env.NOVA_BUNDLED_MODELS, bundled: true });
    expect(await isInstalled(KOKORO_MODEL)).toBe(true);
    // Only the models Nova.app is built with are looked for there.
    await lay(process.env.NOVA_BUNDLED_MODELS, 'smart-turn-v3.2');
    expect(await isInstalled('smart-turn-v3.2')).toBe(false);
  });

  it('prefers the one in ~/.nova/models', async () => {
    process.env.NOVA_MODELS_DIR = await temp();
    process.env.NOVA_BUNDLED_MODELS = await temp();
    await lay(process.env.NOVA_MODELS_DIR, KOKORO_MODEL);
    await lay(process.env.NOVA_BUNDLED_MODELS, KOKORO_MODEL);
    expect(await whereInstalled(KOKORO_MODEL)).toEqual({ dir: process.env.NOVA_MODELS_DIR, bundled: false });
  });
});

describe('the settings Nova no longer has', () => {
  it('takes the voice engine and system voice out of the settings file, and keeps the rest', async () => {
    const file = join(await temp(), 'settings.json');
    await writeFile(file, JSON.stringify({ name: 'Manuel', voice: { engine: 'system', speaker: 'Samantha', rate: 1.2 } }));
    expect(await migrateSettings({}, file)).toMatchObject({ retired: ['voice.engine', 'voice.speaker'] });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ name: 'Manuel', voice: { rate: 1.2 } });
    expect(await migrateSettings({}, file)).toBeNull(); // nothing more to do
    expect(settingsInEnv({ NOVA_VOICE: 'Samantha' })).toEqual(['NOVA_VOICE']);
  });
});
