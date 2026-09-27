import { join } from 'node:path';
import type { ActivityItem, NovaOptions, ServerEvent, SettingsSnapshot, TaskRecord } from '@nova/core';
import type { Config } from '../config.ts';
import { ActionLog } from './actions.ts';
import { TrustRules, type Rule } from './rules.ts';
import { Snapshots } from './snapshots.ts';
import { Undoer, type UndoDeps } from './undo.ts';

export { privacyFlows } from './privacy.ts';
export { setupSteps } from './setup.ts';

/**
 * Trust, put together: the record of what Nova did (and taking it back), snapshots that make
 * agents' changes undoable, and what the user lets Nova do without asking.
 */
export class Trust {
  readonly actions: ActionLog;
  readonly rules: TrustRules;
  readonly snapshots: Snapshots;
  private undoer: Undoer | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly opts: {
      home: string;
      config: () => Config;
      broadcast: (event: ServerEvent) => void;
      /** Save to the settings file (and apply it). */
      save: (changes: Record<string, unknown>) => Promise<void>;
      /** A project's folder, by name. */
      projectPath: (name: string) => string | undefined;
    },
  ) {
    const { home, config } = opts;
    this.actions = new ActionLog({
      dir: join(home, 'activity'),
      keepDays: () => config().trust.keepDays,
      undo: (step, action) => (this.undoer ? this.undoer.run(step, action) : Promise.resolve({ ok: false, message: 'Nova is still starting.' })),
      changed: (item) => opts.broadcast({ type: 'activity-update', item }),
    });
    this.rules = new TrustRules({ rules: () => config().trust.rules as Record<string, Rule>, save: opts.save });
    this.snapshots = new Snapshots({
      file: join(home, 'snapshots.json'),
      enabled: () => config().trust.snapshots,
      projectPath: opts.projectPath,
      keepDays: () => config().trust.keepDays,
    });
  }

  /** What undoing reaches, once the stores exist. */
  wire(deps: Omit<UndoDeps, 'snapshots'>) {
    this.undoer = new Undoer({ ...deps, snapshots: this.snapshots });
  }

  async load() {
    await Promise.all([this.actions.load(), this.snapshots.load()]);
    return this;
  }

  /** Once Nova is up (tidying may save Settings): now, and every few hours. */
  start() {
    void this.tidy();
    this.timer = setInterval(() => void this.tidy(), 6 * 3_600_000);
  }

  /**
   * What NovaBrain gets. `onTaskStep` takes each step of an agent's task: the files an Edit/Write
   * step names (`step.files`) are the only ones undoing that task puts back.
   */
  get options(): Pick<NovaOptions, 'actions' | 'trust' | 'beforeTask' | 'afterTask'> & { onTaskStep: (task: TaskRecord, step: { files?: readonly string[] }) => void } {
    return {
      actions: this.actions,
      trust: this.rules,
      beforeTask: (task: TaskRecord) => this.snapshots.before(task).catch((e) => console.warn(`  [snapshots] before ${task.label}'s task in ${task.project}: ${(e as Error).message}`)),
      afterTask: (task: TaskRecord) =>
        this.snapshots.after(task).catch((e) => {
          console.warn(`  [snapshots] after ${task.label}'s task in ${task.project}: ${(e as Error).message}`);
          return null;
        }),
      onTaskStep: (task: TaskRecord, step: { files?: readonly string[] }) => {
        if (step.files?.length) this.snapshots.edited(task.id, step.files);
      },
    };
  }

  /** Something Nova did, into the record: what windows get back has no undo details. */
  record(item: ActivityItem, undo?: Parameters<ActionLog['add']>[1]) {
    return this.actions.add(item, undo);
  }

  /** Settings changed. */
  configure() {
    this.rules.configure();
  }

  snapshot(): SettingsSnapshot['trust'] {
    return { rules: this.rules.snapshot(), activity: this.actions.stats() };
  }

  close() {
    clearInterval(this.timer);
  }

  flushed() {
    return this.actions.flushed();
  }

  /** Old days of the record, old snapshots, and "for today" permissions from before today go. */
  private async tidy() {
    await this.actions.prune().catch((e) => console.warn(`  [activity] ${(e as Error).message}`));
    await this.snapshots.prune().catch((e) => console.warn(`  [snapshots] ${(e as Error).message}`));
    await this.rules.prune().catch((e) => console.warn(`  [trust] ${(e as Error).message}`));
  }
}
