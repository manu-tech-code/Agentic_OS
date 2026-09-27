import { basename, dirname } from 'node:path';
import type { ActionRecord, HandsService, Platform, Reminder, Routine, Schedule, UndoStep } from '@nova/core';
import type { UndoResult } from './actions.ts';
import type { Snapshots } from './snapshots.ts';

const SETTING_SAID: Record<string, string> = { volume: 'volume', brightness: 'brightness', 'dark-mode': 'appearance', wifi: 'Wi-Fi', bluetooth: 'Bluetooth', focus: 'Focus' };

/** What undoing reaches: the stores and the Mac, never more than the one thing being taken back. */
export interface UndoDeps {
  reminders: { cancel(id: string): Promise<boolean>; add(r: Omit<Reminder, 'id'>): Promise<Reminder> };
  memory: { forget(id: string): boolean; remember(text: string, source: 'said' | 'suggested'): unknown; edit(id: string, text: string): boolean };
  platform: Platform;
  project: { set(name: string | null): void };
  /** Save a routine as it was, or delete it (null). */
  saveRoutine: (name: string, routine: Omit<Routine, 'name'> | null) => Promise<void>;
  snapshots: Snapshots;
  /** Nova's hands, for settings, music, windows, files and the clipboard put back as they were. */
  hands?: HandsService | null;
  now?: () => number;
}

/** Takes back one action, by the step kept with it in the record. */
export class Undoer {
  constructor(private readonly deps: UndoDeps) {}

  private hands(): HandsService {
    if (!this.deps.hands) throw new Error("Nova's hands aren't available here, so that can't be put back.");
    return this.deps.hands;
  }

  async run(step: UndoStep, action: ActionRecord): Promise<UndoResult> {
    const { deps } = this;
    const now = deps.now?.() ?? Date.now();
    switch (step.kind) {
      case 'reminder-cancel':
        return (await deps.reminders.cancel(step.id))
          ? { ok: true, message: 'Okay, that reminder is cancelled.' }
          : { ok: false, message: "That reminder isn't there any more - it may have gone off already." };
      case 'reminder-restore': {
        const r = step.reminder;
        if (r.due !== null && r.due < now - 60_000 && !r.schedule) return { ok: false, message: "That reminder's time has passed, so there's nothing to bring back." };
        await deps.reminders.add({ text: r.text, about: r.about, due: r.due, schedule: r.schedule as Schedule | undefined, countdown: r.countdown, ms: r.ms, apple: r.apple });
        return { ok: true, message: `Okay, the ${r.countdown ? 'timer' : 'reminder'} is back.` };
      }
      case 'memory-forget':
        return deps.memory.forget(step.id) ? { ok: true, message: "Okay, I've forgotten it again." } : { ok: false, message: "I don't have that in my memory any more." };
      case 'memory-edit':
        return deps.memory.edit(step.id, step.text) ? { ok: true, message: 'Okay, I remember it as you said it before.' } : { ok: false, message: "I don't have that in my memory any more." };
      case 'memory-restore':
        deps.memory.remember(step.text, step.source);
        return { ok: true, message: 'Okay, I remember it again.' };
      case 'routine-delete':
        await deps.saveRoutine(step.name, null);
        return { ok: true, message: `Okay, the ${step.name} routine is gone.` };
      case 'routine-restore':
        await deps.saveRoutine(step.name, step.routine);
        return { ok: true, message: `Okay, the ${step.name} routine is back as it was.` };
      case 'app-quit':
        await deps.platform.quitApp(step.app);
        return { ok: true, message: `Okay, I've quit ${step.app}.` };
      case 'app-open':
        await deps.platform.openApp(step.app);
        return { ok: true, message: `Okay, ${step.app} is open again.` };
      case 'project-set':
        deps.project.set(step.name);
        return { ok: true, message: step.name ? `Okay, you're back on ${step.name}.` : "Okay, you're not on any project now." };
      case 'agent-files':
        return deps.snapshots.restore(step);
      case 'system-set': {
        const hands = this.hands();
        await hands.system.set(step.setting, { level: step.level, on: step.on, muted: step.muted });
        return { ok: true, message: `Okay, the ${SETTING_SAID[step.setting] ?? step.setting} is back as it was.` };
      }
      case 'media':
        await this.hands().media.command(step.action);
        return { ok: true, message: step.action === 'pause' ? 'Okay, paused again.' : 'Okay, playing again.' };
      case 'windows-restore':
        await this.hands().windows.restore(step.frames);
        return { ok: true, message: step.frames.length === 1 ? `Okay, ${step.frames[0]!.app} is back where it was.` : 'Okay, your windows are back where they were.' };
      case 'file-move': {
        const files = this.hands().files;
        // A rename goes back to its old name; a move goes back to its old folder.
        const back = dirname(step.to) === dirname(step.from) ? await files.rename(step.to, basename(step.from)) : await files.move(step.to, dirname(step.from));
        return { ok: true, message: `Okay, ${basename(back)} is back ${dirname(step.to) === dirname(step.from) ? 'as it was called' : 'where it was'}.` };
      }
      case 'file-untrash':
        await this.hands().files.untrash(step.trashed, step.original);
        return { ok: true, message: `Okay, ${basename(step.original)} is out of the Trash, back in ${basename(dirname(step.original))}.` };
      case 'clipboard-set':
        await this.hands().clipboard.write(step.text);
        return { ok: true, message: 'Okay, the clipboard is back as it was.' };
      case 'batch': {
        const results: UndoResult[] = [];
        for (const s of step.steps) results.push(await this.run(s, action).catch((e: Error) => ({ ok: false, message: e.message })));
        const done = results.filter((r) => r.ok && !r.rest).length;
        if (done === results.length) return { ok: true, message: results.length === 1 ? results[0]!.message : `Okay, all ${results.length} are back.` };
        // Part of it: what's left - the steps that failed, or the part of one that did - stays to be undone.
        const left = step.steps.flatMap((s, i) => (results[i]!.ok ? (results[i]!.rest ? [results[i]!.rest!] : []) : [s]));
        const rest: UndoStep = left.length === 1 ? left[0]! : { kind: 'batch', steps: left };
        const failed = results.find((r) => !r.ok) ?? results.find((r) => r.rest)!;
        if (!results.some((r) => r.ok)) return { ok: false, message: results[0]!.message };
        return { ok: true, rest, message: `I put back ${done} of the ${results.length}; ${failed.message.replace(/^./, (c) => c.toLowerCase())}` };
      }
    }
  }
}
