import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { homedir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Platform } from '@nova/core';

const run = promisify(execFile);

const MAC_APP_DIRS = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', join(homedir(), 'Applications')];

async function scanApps(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.app')).map((f) => f.slice(0, -4));
  } catch {
    return [];
  }
}

/** macOS implementation. Other OSes - or NOVA_DRY_RUN=1, for trying Nova out safely - get a dry-run platform. */
export function createPlatform(): Platform {
  if (osPlatform() !== 'darwin' || process.env.NOVA_DRY_RUN === '1') return dryRunPlatform();

  let known = new Set<string>();
  // Only ever pass names we discovered ourselves to `open`/AppleScript.
  const assertKnown = (name: string) => {
    if (!known.has(name)) throw new Error(`Unknown app "${name}"`);
  };

  return {
    async listApps() {
      const all = (await Promise.all(MAC_APP_DIRS.map(scanApps))).flat();
      known = new Set(all);
      return [...known].sort((a, b) => a.localeCompare(b));
    },
    async openApp(name) {
      assertKnown(name);
      await run('open', ['-a', name]);
    },
    async quitApp(name) {
      assertKnown(name);
      await run('osascript', ['-e', `tell application ${JSON.stringify(name)} to quit`]);
    },
    // Asking doesn't start it.
    async isRunning(name) {
      assertKnown(name);
      const { stdout } = await run('osascript', ['-e', `application ${JSON.stringify(name)} is running`]);
      return stdout.trim() === 'true';
    },
    now: () => new Date(),
  };
}

function dryRunPlatform(): Platform {
  const apps = ['Safari', 'Slack', 'Spotify', 'Visual Studio Code', 'Terminal', 'Figma', 'Notes'];
  return {
    listApps: async () => apps,
    openApp: async (name) => console.log(`[dry-run] open ${name}`),
    quitApp: async (name) => console.log(`[dry-run] quit ${name}`),
    isRunning: async () => false,
    now: () => new Date(),
  };
}
