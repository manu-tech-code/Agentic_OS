import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HandsService } from '@nova/core';
import type { Run } from './run.ts';

/**
 * The user's own Shortcuts, run with macOS's `shortcuts` command: listed (and kept a few minutes),
 * and run by name - only a name from that list - with text to give it, and what it gives back.
 */

const LIST_MS = 3 * 60_000;

export interface ShortcutsOptions {
  run: Run;
  timeoutMs: () => number;
  dryRun?: boolean;
  log?: (line: string) => void;
  now?: () => number;
}

export function shortcutsHands(o: ShortcutsOptions): HandsService['shortcuts'] & { cached(): string[] | null; forget(): void } {
  const now = o.now ?? Date.now;
  let known: { at: number; names: string[] } | null = null;
  let listing: Promise<string[]> | null = null;

  async function list(): Promise<string[]> {
    if (known && now() - known.at < LIST_MS) return known.names;
    listing ??= o
      .run('shortcuts', ['list'], { timeoutMs: 15_000 })
      .then((r) => {
        const names = [...new Set(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean))];
        known = { at: now(), names };
        return names;
      })
      .finally(() => (listing = null));
    return listing;
  }

  return {
    list,
    /** The list as last read, without reading it again (for Settings). */
    cached: () => known?.names ?? null,
    forget: () => void (known = null),
    async run(name, input) {
      const names = await list();
      // Only ever one of the user's own, by its exact name.
      const exact = names.find((n) => n === name) ?? names.find((n) => n.toLowerCase() === name.toLowerCase());
      if (!exact) throw new Error(`You don't have a shortcut called "${name}".`);
      if (o.dryRun) {
        (o.log ?? console.log)(`  [dry-run] shortcuts run "${exact}"${input ? ` with "${input}"` : ''}`);
        return {};
      }
      const dir = await mkdtemp(join(tmpdir(), 'nova-shortcut-'));
      try {
        const out = join(dir, 'output.txt');
        const args = ['run', exact, '--output-path', out, '--output-type', 'public.plain-text'];
        if (input !== undefined && input !== '') {
          const file = join(dir, 'input.txt');
          await writeFile(file, input, { mode: 0o600 });
          args.push('--input-path', file);
        }
        await o.run('shortcuts', args, { timeoutMs: o.timeoutMs() }).catch((e: Error) => {
          throw new Error(/took too long/.test(e.message) ? `The "${exact}" shortcut was still running, so I stopped it.` : `The "${exact}" shortcut didn't finish: ${e.message}`);
        });
        const output = await readFile(out, 'utf8').catch(() => '');
        return output.trim() ? { output: output.trim().slice(0, 4000) } : {};
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
