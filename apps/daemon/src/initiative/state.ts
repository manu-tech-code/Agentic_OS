import { readFile } from 'node:fs/promises';
import type { ProjectService } from '@nova/core';
import { setAside, writeDurably } from './durable.ts';

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
  /** The file couldn't be read, nor kept aside: nothing is saved over it. */
  private broken = false;

  constructor(
    private readonly file: string,
    private readonly changed: () => void = () => {},
  ) {}

  async load() {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.broken = true; // there, but not readable: left as it is
      return this; // nothing kept yet
    }
    try {
      const parsed = JSON.parse(raw) as { project?: InitiativeState['project']; briefedOn?: string; onboarded?: boolean };
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      if (parsed.project && typeof parsed.project.name === 'string') this.project = parsed.project;
      if (typeof parsed.briefedOn === 'string') this.briefedOn = parsed.briefedOn;
      this.onboarded = parsed.onboarded ?? true;
    } catch {
      // Unreadable: kept beside, never written over.
      const kept = await setAside(this.file);
      this.broken = !kept;
      console.warn(`  [state] ${this.file} couldn't be read${kept ? `, so it's kept as ${kept}` : " - it's left as it is"}`);
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
    if (this.broken) return this.saving;
    const data = `${JSON.stringify({ project: this.project, briefedOn: this.briefedOn, onboarded: this.onboarded }, null, 2)}\n`;
    this.saving = this.saving.then(() => writeDurably(this.file, data)).catch((e) => console.warn(`  [state] can't save: ${(e as Error).message}`));
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
