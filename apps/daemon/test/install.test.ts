import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { swapIn } from '../src/shell/install.ts';

const temp = () => mkdtemp(join(tmpdir(), 'nova-install-'));

/** A tiny "app bundle": just enough of a directory tree to tell one build from another. */
async function layBundle(dir: string, marker: string) {
  await mkdir(join(dir, 'Contents', 'MacOS'), { recursive: true });
  await writeFile(join(dir, 'Contents', 'MacOS', 'Nova'), marker);
}

describe('swapIn - putting a finished build where Nova.app lives', () => {
  it('puts a fresh build in place when nothing is there yet', async () => {
    const root = await temp();
    const staging = join(root, 'Nova.app.new');
    const target = join(root, 'Nova.app');
    await layBundle(staging, 'build-1');

    await swapIn(target, staging);

    expect(await readFile(join(target, 'Contents', 'MacOS', 'Nova'), 'utf8')).toBe('build-1');
    expect(existsSync(staging)).toBe(false);
  });

  it('replaces an older build without ever leaving the target missing or half-written', async () => {
    const root = await temp();
    const staging = join(root, 'Nova.app.new');
    const target = join(root, 'Nova.app');
    await layBundle(target, 'build-1');
    await layBundle(staging, 'build-2');

    await swapIn(target, staging);

    expect(await readFile(join(target, 'Contents', 'MacOS', 'Nova'), 'utf8')).toBe('build-2');
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(`${target}.old`)).toBe(false); // no leftover once the swap is done
  });

  it('cleans up a leftover from a swap that was interrupted before, rather than failing', async () => {
    const root = await temp();
    const staging = join(root, 'Nova.app.new');
    const target = join(root, 'Nova.app');
    await layBundle(target, 'build-1');
    await layBundle(staging, 'build-2');
    await layBundle(`${target}.old`, 'stale-leftover'); // as if a previous run stopped mid-swap

    await swapIn(target, staging);

    expect(await readFile(join(target, 'Contents', 'MacOS', 'Nova'), 'utf8')).toBe('build-2');
    expect(existsSync(`${target}.old`)).toBe(false);
  });
});
