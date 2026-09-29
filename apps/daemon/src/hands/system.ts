import type { HandsService, SystemSetting, SystemState } from '@nova/core';
import { osascript, type Run } from './run.ts';
import type { HandsEyes } from './types.ts';

/**
 * The Mac's own settings, read and changed with its own commands: the volume (osascript), dark mode
 * (the appearance preference), Wi-Fi (networksetup), the battery (pmset); Bluetooth, the display's
 * brightness and locking the screen through Nova Eyes; Focus through the user's own Shortcuts.
 */

/** "output volume:44, input volume:75, alert volume:100, output muted:false" */
export function parseVolume(out: string): { level?: number; muted?: boolean } {
  const level = /output volume:(\d+)/.exec(out)?.[1];
  const muted = /output muted:(true|false)/.exec(out)?.[1];
  return { level: level === undefined ? undefined : Number(level), muted: muted === undefined ? undefined : muted === 'true' };
}

/** The Wi-Fi device ("en0") from `networksetup -listallhardwareports`. */
export function wifiDevice(out: string): string | null {
  return /Hardware Port: (?:Wi-Fi|AirPort)\s*\n\s*Device: (\S+)/.exec(out)?.[1] ?? null;
}

/** "Wi-Fi Power (en0): On" */
export const wifiPower = (out: string): boolean | undefined => (/:\s*On\b/i.test(out) ? true : /:\s*Off\b/i.test(out) ? false : undefined);

/** "3:12" as said: "3 hours 12 minutes". */
export function spokenTime(hm: string): string | undefined {
  const m = /^(\d+):(\d{2})$/.exec(hm.trim());
  if (!m) return undefined;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (!hours && !minutes) return undefined;
  const h = hours ? `${hours} ${hours === 1 ? 'hour' : 'hours'}` : '';
  const min = minutes ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` : '';
  return [h, min].filter(Boolean).join(' ');
}

/** `pmset -g batt`: " -InternalBattery-0 (id=…)	87%; discharging; 4:12 remaining present: true" - nothing on a Mac with no battery. */
export function parseBattery(out: string): SystemState {
  const m = /(\d+)%;\s*([^;]+);\s*([^\n]*)/.exec(out);
  if (!m) return { setting: 'battery' };
  const state = m[2]!.trim().toLowerCase();
  const charging = state === 'charging' || state === 'finishing charge';
  const time = /(\d+:\d{2}) remaining/.exec(m[3]!)?.[1];
  const remaining = time && !/\(no estimate\)/.test(m[3]!) ? spokenTime(time) : undefined;
  return { setting: 'battery', level: Number(m[1]), charging, ...(remaining ? { remaining } : {}) };
}

/** The user's own shortcuts for Focus - "Focus On", "Turn Off Do Not Disturb", "Toggle Focus", "Current Focus". */
export interface FocusShortcuts {
  on?: string;
  off?: string;
  toggle?: string;
  /** One that says which Focus is on (the Get Current Focus action). */
  status?: string;
}

export function focusShortcuts(names: readonly string[]): FocusShortcuts {
  const found: FocusShortcuts = {};
  for (const name of names) {
    const n = ` ${name.toLowerCase().replace(/[^a-z]+/g, ' ').trim()} `;
    if (!/ (?:focus|do not disturb|dont disturb|don t disturb|dnd) /.test(n)) continue;
    if (/ (?:toggle|switch) /.test(n) && !/ (?:on|off) /.test(n)) found.toggle ??= name;
    else if (/ (?:current|status|state|get|which|what) /.test(n)) found.status ??= name;
    else if (/ (?:on|start|enable|begin|activate) /.test(n)) found.on ??= name;
    else if (/ (?:off|stop|disable|end|deactivate) /.test(n)) found.off ??= name;
  }
  return found;
}

/** Whether a Focus is on, from what a "current focus" shortcut gave back. */
export const focusOn = (output: string) => !/^(?:|none|off|no|false|no focus|nothing|not set|0)$/i.test(output.trim());

const FOCUS_HELP =
  'To let me turn Focus on and off, make two shortcuts in the Shortcuts app with the Set Focus action - one named "Focus On" and one named "Focus Off" - and I can run them.';

export interface SystemOptions {
  run: Run;
  eyes: HandsEyes | null;
  /** The user's Shortcuts, for Focus. */
  shortcuts: Pick<HandsService['shortcuts'], 'list' | 'run'>;
  dryRun?: boolean;
  log?: (line: string) => void;
  /** When to do something a moment from now (sleep waits for "Good night" to be said). */
  later?: (fn: () => void, ms: number) => void;
}

export function systemHands(o: SystemOptions): HandsService['system'] & { focus(): Promise<FocusShortcuts> } {
  const log = o.log ?? ((line: string) => console.log(line));
  const later = o.later ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));
  let wifi: string | null | undefined;
  /** Trying Nova out (NOVA_DRY_RUN=1): say what would change, and answer as if it had. */
  const pretend = <T>(what: string, state?: T): T => {
    log(`  [dry-run] ${what}`);
    return state as T;
  };
  const eyes = () => {
    if (!o.eyes) throw new Error('That needs Nova Eyes, on a Mac.');
    return o.eyes;
  };

  async function wifiName() {
    if (wifi !== undefined) return wifi;
    wifi = wifiDevice((await o.run('networksetup', ['-listallhardwareports'])).stdout);
    return wifi;
  }

  async function focus(): Promise<FocusShortcuts> {
    return focusShortcuts(await o.shortcuts.list().catch(() => []));
  }

  async function get(setting: SystemSetting): Promise<SystemState> {
    switch (setting) {
      case 'volume':
        return { setting, ...parseVolume(await osascript(o.run, ['get volume settings'])) };
      case 'brightness':
        return { setting, level: await eyes().brightness() };
      case 'dark-mode': {
        // The appearance preference: "Dark" when dark, and no value at all when light.
        const dark = await o.run('defaults', ['read', '-g', 'AppleInterfaceStyle']).then(
          (r) => /dark/i.test(r.stdout),
          () => false,
        );
        return { setting, on: dark };
      }
      case 'wifi': {
        const device = await wifiName();
        if (!device) throw new Error("This Mac doesn't have Wi-Fi.");
        return { setting, on: wifiPower((await o.run('networksetup', ['-getairportpower', device])).stdout) };
      }
      case 'bluetooth':
        return { setting, on: await eyes().bluetooth() };
      case 'focus': {
        const status = (await focus()).status;
        if (!status) return { setting };
        const out = await o.shortcuts.run(status).catch(() => ({ output: undefined }));
        return out.output === undefined ? { setting } : { setting, on: focusOn(out.output) };
      }
      case 'battery':
        return parseBattery((await o.run('pmset', ['-g', 'batt'])).stdout);
      default:
        return { setting };
    }
  }

  async function set(setting: SystemSetting, change: { level?: number; on?: boolean; muted?: boolean }): Promise<SystemState> {
    const level = change.level === undefined ? undefined : Math.max(0, Math.min(100, Math.round(change.level)));
    switch (setting) {
      case 'volume': {
        const lines = [...(level !== undefined ? [`set volume output volume ${level}`] : []), ...(change.muted !== undefined ? [`set volume output muted ${change.muted}`] : [])];
        if (!lines.length) return get(setting);
        if (o.dryRun) return pretend(lines.join('; '), { setting, ...(level !== undefined ? { level } : {}), ...(change.muted !== undefined ? { muted: change.muted } : {}) });
        await osascript(o.run, lines);
        const now = await get(setting);
        if (level !== undefined && now.level === undefined) throw new Error("This sound output doesn't let me change its volume.");
        return now;
      }
      case 'brightness':
        if (level === undefined) return get(setting);
        if (o.dryRun) return pretend(`brightness ${level}%`, { setting, level } as SystemState);
        return { setting, level: await eyes().brightness(level) };
      case 'dark-mode':
        if (change.on === undefined) return get(setting);
        if (o.dryRun) return pretend(`dark mode ${change.on ? 'on' : 'off'}`, { setting, on: change.on } as SystemState);
        await osascript(o.run, [`tell application "System Events" to tell appearance preferences to set dark mode to ${change.on}`]);
        return { setting, on: change.on };
      case 'wifi': {
        if (change.on === undefined) return get(setting);
        const device = await wifiName();
        if (!device) throw new Error("This Mac doesn't have Wi-Fi.");
        if (o.dryRun) return pretend(`networksetup -setairportpower ${device} ${change.on ? 'on' : 'off'}`, { setting, on: change.on } as SystemState);
        await o.run('networksetup', ['-setairportpower', device, change.on ? 'on' : 'off']);
        return get(setting);
      }
      case 'bluetooth':
        if (change.on === undefined) return get(setting);
        if (o.dryRun) return pretend(`bluetooth ${change.on ? 'on' : 'off'}`, { setting, on: change.on } as SystemState);
        return { setting, on: await eyes().bluetooth(change.on) };
      case 'focus': {
        if (change.on === undefined) return get(setting);
        const found = await focus();
        const name = change.on ? found.on : found.off;
        const chosen = name ?? found.toggle;
        if (!chosen) throw new Error(FOCUS_HELP);
        if (o.dryRun) return pretend(`shortcuts run "${chosen}"`, { setting, on: change.on } as SystemState);
        await o.shortcuts.run(chosen);
        return { setting, on: change.on };
      }
      default:
        throw new Error("That setting can't be changed.");
    }
  }

  return {
    get,
    set,
    focus,
    async lock() {
      if (o.dryRun) return pretend('lock the screen');
      await eyes().lock();
    },
    async sleep() {
      if (o.dryRun) return pretend('pmset sleepnow (in 2 seconds)');
      // A moment first, so "Good night" is said before the Mac goes to sleep.
      later(() => void o.run('pmset', ['sleepnow']).catch((e) => log(`  [hands] couldn't sleep: ${(e as Error).message}`)), 2500);
    },
  };
}
