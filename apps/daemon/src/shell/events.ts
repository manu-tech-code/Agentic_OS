import type { ClientEvent, ShellAction } from '@nova/core';

/**
 * What a window or Nova.app sends, checked before anything uses it: a known type with fields of
 * the right types. Anything else is dropped - a bad message never reaches Nova (or takes the
 * daemon down).
 */

type Kind = 'string' | 'number' | 'boolean' | 'object' | 'any';
/** A field: its kind, one of a few strings, or a nested shape; `?` at the end of the name = optional. */
type Field = Kind | readonly string[] | Shape;
interface Shape {
  [field: string]: Field;
}

const SHELL_ACTIONS: readonly ShellAction[] = [
  'request-mic',
  'open-mic-settings',
  'open-login-items',
  'restart-daemon',
  'request-calendar',
  'request-reminders',
  'request-notifications',
  'open-privacy-settings',
];

const SHAPES: { [T in ClientEvent['type']]: Shape } = {
  utterance: { text: 'string', source: ['voice', 'keyboard', 'phone'] },
  'audio-start': { 'sampleRate?': 'number' },
  'audio-stop': {},
  'speech-finished': {},
  cancel: {},
  'settings-get': {},
  'settings-set': { values: 'object' },
  'reflex-install': {},
  'reflex-forget': {},
  'hearing-install': { model: ['parakeet', 'smart-turn', 'speech'] },
  'memory-edit': { id: 'string', text: 'string' },
  'memory-delete': { id: 'string' },
  'memory-clear': {},
  'conversations-clear': {},
  'screen-permission': { kind: ['accessibility', 'screen'] },
  'screen-restart': {},
  'screen-preview': {},
  'hands-refresh': {},
  voiceid: { action: ['install', 'enroll', 'improve', 'test', 'cancel', 'forget', 'keyword-set', 'keyword-clear', 'override-end'], 'keyword?': 'string' },
  'integration-sign-in': { name: 'string' },
  'integration-sign-out': { name: 'string' },
  'integration-retry': { name: 'string' },
  'voice-preview': { id: 'string', voice: 'string' },
  'shell-hello': { kind: ['mac'], version: 'string' },
  // What the app says about itself is shown in Settings: strings, whatever a newer app calls them.
  'shell-status': {
    status: {
      version: 'string',
      mic: 'string',
      listening: 'string',
      loginItem: 'string',
      'loginItemMessage?': 'string',
      shortcut: { keys: 'string', ok: 'boolean', 'message?': 'string' },
      daemon: 'string',
      'access?': { calendar: 'string', reminders: 'string', notifications: 'string' },
    },
  },
  'talk-start': {},
  'talk-end': { held: 'boolean' },
  'listen-stop': {},
  'shell-action': { action: SHELL_ACTIONS },
  'shell-reply': { id: 'string', ok: 'boolean', 'result?': 'any', 'error?': 'string' },
  'shell-context': { context: { locked: 'boolean', camera: 'boolean', idleSeconds: 'number', 'unlockedAt?': 'number' } },
  'notification-action': { ref: 'string', action: ['snooze', 'done', 'open'] },
  'task-cancel': { id: 'string' },
  'task-retry': { id: 'string' },
  'reminder-cancel': { id: 'string' },
  'activity-undo': { id: 'string' },
  'activity-search': { query: 'string', 'days?': 'number' },
  'stop-all': {},
  'phone-state': { active: 'boolean' },
  'tap-answer': { id: 'string', yes: 'boolean' },
  'phone-pair': { action: ['start', 'stop'] },
  'phone-forget': { id: 'string' },
  'setup-done': {},
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function fits(value: unknown, field: Field): boolean {
  if (Array.isArray(field)) return typeof value === 'string' && field.includes(value);
  if (typeof field === 'object') return isObject(value) && matches(value, field as Shape);
  switch (field) {
    case 'any':
      return true;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'object':
      return isObject(value);
    default:
      return typeof value === field;
  }
}

function matches(value: Record<string, unknown>, shape: Shape): boolean {
  for (const [key, field] of Object.entries(shape)) {
    const optional = key.endsWith('?');
    const name = optional ? key.slice(0, -1) : key;
    const v = Object.hasOwn(value, name) ? value[name] : undefined;
    if (v === undefined) {
      if (!optional) return false;
    } else if (!fits(v, field)) return false;
  }
  return true;
}

/** A message from a client, if it's one Nova understands; null for anything else. */
export function readClientEvent(raw: string): ClientEvent | null {
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(event) || typeof event.type !== 'string' || !Object.hasOwn(SHAPES, event.type)) return null;
  return matches(event, SHAPES[event.type as ClientEvent['type']]) ? (event as ClientEvent) : null;
}
