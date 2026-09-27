import { describe, expect, it } from 'vitest';
import { readClientEvent } from '../src/shell/events.ts';

const read = (event: unknown) => readClientEvent(JSON.stringify(event));

describe('what windows and Nova.app send', () => {
  it('is taken as it is when it is one Nova understands', () => {
    // As the window sends them (App.tsx, Settings) ...
    for (const event of [
      { type: 'utterance', text: 'open Slack', source: 'keyboard' },
      { type: 'utterance', text: 'hey nova what time is it', source: 'voice' },
      { type: 'audio-start', sampleRate: 16_000 },
      { type: 'audio-stop' },
      { type: 'settings-get' },
      { type: 'settings-set', values: { 'voice.rate': 1.1, name: null } },
      { type: 'hearing-install', model: 'parakeet' },
      { type: 'memory-edit', id: 'm1', text: 'my standup is at 10' },
      { type: 'screen-permission', kind: 'screen' },
      { type: 'integration-sign-in', name: 'linear' },
      { type: 'voice-preview', id: 'p1', voice: 'af_heart' },
      { type: 'shell-action', action: 'request-reminders' },
      { type: 'task-retry', id: 't1' },
      { type: 'activity-search', query: 'claude' },
      { type: 'activity-search', query: 'claude', days: 7 },
      { type: 'stop-all' },
      { type: 'setup-done' },
    ]) {
      expect(read(event), event.type).toEqual(event);
    }
    // ... and as Nova.app does (AppDelegate.swift).
    for (const event of [
      { type: 'shell-hello', kind: 'mac', version: '0.2.0' },
      {
        type: 'shell-status',
        status: {
          version: '0.2.0',
          mic: 'granted',
          listening: 'wake-word',
          loginItem: 'on',
          shortcut: { keys: 'option+space', ok: true },
          daemon: 'hosted',
          access: { calendar: 'granted', reminders: 'undetermined', notifications: 'granted' },
        },
      },
      { type: 'shell-context', context: { locked: false, camera: false, idleSeconds: 12, unlockedAt: 1_790_000_000_000 } },
      { type: 'shell-reply', id: 'r1', ok: true, result: [{ title: 'Dentist' }] },
      { type: 'shell-reply', id: 'r2', ok: false, error: "Nova.app doesn't know that." },
      { type: 'notification-action', ref: 'reminder:1', action: 'snooze' },
      { type: 'talk-start' },
      { type: 'talk-end', held: true },
      { type: 'listen-stop' },
      { type: 'speech-finished' },
    ]) {
      expect(read(event), event.type).toEqual(event);
    }
  });

  it('is dropped when it is anything else - so it never reaches Nova', () => {
    for (const raw of ['', 'not json', 'null', '42', '"utterance"', '[]', JSON.stringify([{ type: 'utterance', text: 'x', source: 'voice' }])]) {
      expect(readClientEvent(raw), raw).toBeNull();
    }
    for (const event of [
      {},
      { type: 'nope' },
      { type: 'toString' },
      { type: '__proto__' },
      { type: 'utterance' }, // no words
      { type: 'utterance', text: 42, source: 'voice' },
      { type: 'utterance', text: 'open Slack', source: 'shortcut' }, // only Nova's own hearing says that
      { type: 'utterance', text: 'open Slack' },
      { type: 'settings-set', values: null },
      { type: 'settings-set', values: ['voice.rate'] },
      { type: 'hearing-install', model: '../../etc' },
      { type: 'memory-edit', id: 'm1' },
      { type: 'screen-permission', kind: 'camera' },
      { type: 'shell-action', action: 'rm -rf' },
      { type: 'shell-hello', version: 3 },
      { type: 'shell-status', status: null },
      { type: 'shell-status', status: { version: '1' } },
      { type: 'shell-context', context: null },
      { type: 'shell-context', context: { locked: 'no', camera: false, idleSeconds: 1 } },
      { type: 'shell-context', context: { locked: false, camera: false, idleSeconds: Number.NaN } },
      { type: 'shell-reply', id: 'r1' },
      { type: 'notification-action', ref: 'x', action: 'delete' },
      { type: 'talk-end', held: 'yes' },
      { type: 'activity-search', query: 'x', days: 'all' },
      { type: 'task-cancel', id: { $gt: '' } },
    ]) {
      expect(read(event), JSON.stringify(event)).toBeNull();
    }
  });
});
