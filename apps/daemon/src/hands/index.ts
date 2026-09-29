import { homedir } from 'node:os';
import type { HandsService, LayoutWindow, ServerEvent } from '@nova/core';
import type { Eyes } from '../screen/eyes.ts';
import { Computer } from './computer.ts';
import { filesHands } from './files.ts';
import { mediaHands } from './media.ts';
import { lines as defaultLines, run as defaultRun, type Lines, type Run } from './run.ts';
import { shortcutsHands } from './shortcuts.ts';
import { systemHands, type FocusShortcuts } from './system.ts';
import type { HandsConfig, HandsEyes } from './types.ts';
import { windowsHands } from './windows.ts';

export type { HandsConfig, HandsEyes } from './types.ts';

/**
 * Nova's hands on the Mac, put together: the Mac's settings, music, windows, files, the clipboard,
 * the user's Shortcuts, and using the computer - on the Mac's own commands and Nova Eyes. With
 * NOVA_DRY_RUN=1 everything that changes something only says what it would do; reading is real.
 */
export interface HandsOptions {
  eyes: HandsEyes | Eyes;
  config: () => HandsConfig;
  /** Save a window layout in the settings file (null deletes it). */
  saveLayout: (name: string, windows: LayoutWindow[] | null) => Promise<void>;
  /** Project folders by name. */
  projects?: () => Record<string, string>;
  /** The assistant's name, for captions on screen. */
  name?: () => string;
  broadcast?: (event: ServerEvent) => void;
  run?: Run;
  lines?: Lines;
  home?: string;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export type NovaHands = HandsService & {
  shortcuts: ReturnType<typeof shortcutsHands>;
  computer: Computer;
  /** For Settings: the Shortcuts found (as last read) and which of them turn Focus on and off. */
  status(): Promise<{ shortcuts: string[] | null; focus: FocusShortcuts }>;
};

export function createHands(o: HandsOptions): NovaHands {
  const run = o.run ?? defaultRun;
  const lines = o.lines ?? defaultLines;
  const eyes = o.eyes as HandsEyes;
  const log = o.log ?? ((line: string) => console.log(line));
  const common = { dryRun: o.dryRun, log };
  const shortcuts = shortcutsHands({ run, timeoutMs: () => o.config().shortcutTimeoutMs, ...common });
  const system = systemHands({ run, eyes, shortcuts, ...common });
  const computer = new Computer({ eyes, config: o.config, name: o.name, broadcast: o.broadcast, ...common });

  return {
    system,
    media: mediaHands({ run, eyes, player: () => o.config().player, ...common }),
    windows: windowsHands({ eyes, layouts: () => o.config().layouts, saveLayout: o.saveLayout, ...common }),
    files: filesHands({ run, lines, eyes, home: o.home ?? homedir(), projects: o.projects, ...common }),
    clipboard: {
      read: () => eyes.clipboardRead(),
      async write(text) {
        if (o.dryRun) return log(`  [dry-run] copy ${JSON.stringify(text.slice(0, 80))}`);
        await eyes.clipboardWrite(text);
      },
    },
    shortcuts,
    computer,
    pageAddress: async () => (await eyes.context().catch(() => null))?.url || null,
    async status() {
      const names = shortcuts.cached() ?? (await shortcuts.list().catch(() => null));
      return { shortcuts: names, focus: names ? await system.focus() : {} };
    },
  };
}
