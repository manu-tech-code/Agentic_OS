import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ProjectService } from '@nova/core';

/** How long a project the user named wins over what's on screen. */
const SAID_WINS_MS = 4 * 3_600_000;

/**
 * What Nova keeps between runs besides settings: the project the user is working on (said, or
 * seen on screen), and the day of the last morning briefing. In ~/.nova/state.json.
 */
export class InitiativeState implements ProjectService {
  private project: { name: string; source: 'said' | 'screen'; at: number } | null = null;
  /** The day (YYYY-MM-DD, local) of the last morning briefing. */
  briefedOn: string | null = null;
  /** The first-run walkthrough was done (or skipped). Nova that ran before it existed counts as set up. */
  onboarded = false;
  private saving: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly changed: () => void = () => {},
  ) {}

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as { project?: InitiativeState['project']; briefedOn?: string; onboarded?: boolean };
      if (parsed.project && typeof parsed.project.name === 'string') this.project = parsed.project;
      if (typeof parsed.briefedOn === 'string') this.briefedOn = parsed.briefedOn;
      this.onboarded = parsed.onboarded ?? true;
    } catch {
      // nothing kept yet
    }
    return this;
  }

  get current() {
    return this.project?.name ?? null;
  }

  get currentProject() {
    return this.project ? { name: this.project.name, source: this.project.source } : null;
  }

  /** The user said which project they're on (null: none). */
  set(name: string | null) {
    this.project = name ? { name, source: 'said', at: Date.now() } : null;
    this.save();
  }

  /** A project in the window the user is working in: it counts, unless they named another lately. */
  seen(name: string) {
    if (this.project?.name === name) return;
    if (this.project?.source === 'said' && Date.now() - this.project.at < SAID_WINS_MS) return;
    this.project = { name, source: 'screen', at: Date.now() };
    this.save();
  }

  briefed(day: string) {
    this.briefedOn = day;
    this.save();
  }

  setUp() {
    this.onboarded = true;
    this.save();
  }

  private save() {
    this.changed();
    const data = `${JSON.stringify({ project: this.project, briefedOn: this.briefedOn, onboarded: this.onboarded }, null, 2)}\n`;
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(`${this.file}.tmp`, data, { mode: 0o600 });
        await rename(`${this.file}.tmp`, this.file);
      })
      .catch((e) => console.warn(`  [state] can't save: ${(e as Error).message}`));
    return this.saving;
  }

  flushed() {
    return this.saving.then(() => undefined);
  }
}

/** The project a window is about: its name in the title or address ("server.ts — Agentic_OS"). */
export function projectIn(texts: (string | undefined)[], projects: string[]): string | null {
  const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const seen = squash(texts.filter(Boolean).join(' '));
  if (!seen) return null;
  // The longest name that's there, so "nova-web" beats "nova".
  const hit = [...projects].sort((a, b) => b.length - a.length).find((p) => squash(p).length >= 3 && seen.includes(squash(p)));
  return hit ?? null;
}
