import type { ComputerAction, ComputerService, ComputerView, ServerEvent } from '@nova/core';
import type { EyesAction, EyesElement, EyesPoint, EyesSnapshot } from '../screen/eyes.ts';
import type { HandsConfig, HandsEyes } from './types.ts';

/**
 * Using the computer: a brain looks (a picture, and the things on screen with ids), then acts one
 * step at a time - and the user's own "click send" finds the button by name. Every step checks
 * first: nothing after "stop everything", no more than the step budget for one request, nothing
 * while the user is using the mouse or keyboard, never typing into a password field.
 */

/** Whether the user has just used the mouse or keyboard - Nova's own events aside. */
export function userBusy(idle: { idle: number; sinceNova?: number } | null, within = 1.5): boolean {
  if (!idle || idle.idle >= within) return false;
  // The latest input was Nova's own: it came a moment after Nova's last event.
  if (idle.sinceNova !== undefined && Math.abs(idle.idle - idle.sinceNova) < 0.35) return false;
  return true;
}

/** One line per thing on screen: `[e12] button "Send" at 812,44 (60×28)` - x,y its middle, in the picture's pixels. */
export function elementLine(e: EyesElement): string {
  const cx = Math.round(e.x + e.w / 2);
  const cy = Math.round(e.y + e.h / 2);
  const label = e.label ? ` "${e.label.replace(/"/g, "'")}"` : ' (no label)';
  const value = e.value ? ` = "${e.value.replace(/"/g, "'")}"` : '';
  const flags = [!e.enabled && 'disabled', e.focused && 'focused', e.secure && 'the user types this one'].filter(Boolean).join(', ');
  return `[${e.id}] ${e.role}${label}${value} at ${cx},${cy} (${Math.round(e.w)}×${Math.round(e.h)})${flags ? ` - ${flags}` : ''}`;
}

const MODIFIERS: Record<string, string> = { cmd: 'Command', command: 'Command', ctrl: 'Control', control: 'Control', alt: 'Option', option: 'Option', opt: 'Option', shift: 'Shift', fn: 'Function' };

/** "cmd+shift+t" as said: "Command Shift T". */
export const keysSaid = (keys: string) =>
  keys
    .split('+')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => MODIFIERS[k.toLowerCase()] ?? (k.length === 1 ? k.toUpperCase() : k.replace(/^./, (c) => c.toUpperCase())))
    .join(' ');

const normal = (s: string) => s.toLowerCase().replace(/[“”"'’`.,:;!?()[\]{}…]/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s: string) => normal(s).split(' ').filter(Boolean);

/**
 * What the user named ("send", "the reply button"), among the things in the window: one that fits,
 * several that fit equally, or none. Exact names win; then names that hold every word said.
 */
export function match(target: string, elements: EyesElement[]): { one: EyesElement } | { several: EyesElement[] } | null {
  const said = normal(target.replace(/^(?:the|a|an)\s+/i, ''));
  if (!said) return null;
  const usable = elements.filter((e) => e.label && !e.secure);
  const rank = (e: EyesElement) => (e.enabled ? 0 : 2) + (['button', 'link', 'menu item', 'tab', 'checkbox'].includes(e.role) ? 0 : 1);
  const exact = usable.filter((e) => normal(e.label) === said).sort((a, b) => rank(a) - rank(b));
  // The same name twice (a toolbar button and a menu item): the first in reading order that can be used.
  if (exact.length) return { one: exact[0]! };
  const want = words(said);
  const scored = usable
    .map((e) => {
      const have = words(e.label);
      const hits = want.filter((w) => have.includes(w) || have.some((h) => h.startsWith(w) && w.length >= 3)).length;
      let score = hits / Math.max(want.length, 1);
      if (hits === want.length) score = 0.8 + 0.2 * (want.length / Math.max(have.length, 1)); // everything said is in the name
      if (normal(e.label).startsWith(said)) score = Math.max(score, 0.9);
      return { e, score: score - rank(e) * 0.02 };
    })
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  const best = scored[0]!;
  const close = scored.filter((x) => x.score >= best.score - 0.1);
  if (best.score >= 0.8 && close.length === 1) return { one: best.e };
  const labels = new Set<string>();
  const several = close.filter((x) => !labels.has(normal(x.e.label)) && labels.add(normal(x.e.label))).map((x) => x.e);
  return several.length === 1 && best.score >= 0.7 ? { one: several[0]! } : { several: several.slice(0, 5) };
}

const quote = (s: string, max = 60) => `“${s.length > max ? `${s.slice(0, max - 1)}…` : s}”`;

export interface ComputerOptions {
  eyes: HandsEyes;
  config: () => HandsConfig;
  /** The assistant's name, for the caption ("Nova will click “Send”"). */
  name?: () => string;
  broadcast?: (event: ServerEvent) => void;
  dryRun?: boolean;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** How long after its last step the computer counts as no longer in use. */
const ACTIVE_MS = 20_000;

export class Computer implements ComputerService {
  private halted = false;
  private steps = 0;
  /** The latest look, for acting on its ids and saying what a step will do. */
  private last: EyesSnapshot | null = null;
  private active: { caller?: string; app?: string } | null = null;
  private quiet: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly o: ComputerOptions) {}

  private get log() {
    return this.o.log ?? ((line: string) => console.log(line));
  }

  /** Right now: in use, stopped, and how many steps this request has taken. */
  status() {
    return { active: this.active !== null, halted: this.halted, steps: this.steps };
  }

  async look(opts: { scope?: 'screen' | 'window'; caller?: string } = {}): Promise<ComputerView> {
    const shot = await this.o.eyes.snapshot(opts.scope ?? 'screen', { image: true });
    this.last = shot;
    if (opts.caller) this.show(opts.caller);
    if (!shot.image && !shot.elements.length) {
      throw new Error(shot.permissions && !shot.permissions.screen ? 'Nova Eyes needs Screen Recording to see the screen: Settings → Hands → Allow.' : "Nothing could be seen on screen.");
    }
    const lines = shot.elements.map(elementLine);
    if (shot.truncated) lines.push('(there is more on screen than listed - scroll, or look at just the window)');
    const focused = shot.elements.find((e) => e.id === shot.focused);
    return {
      app: shot.app,
      window: shot.window || undefined,
      ...(shot.image ? { image: { data: shot.image, mimeType: shot.mimeType ?? 'image/jpeg' } } : {}),
      width: shot.width,
      height: shot.height,
      elements: lines.join('\n'),
      ...(focused ? { focused: elementLine(focused) } : {}),
    };
  }

  private element(id?: string) {
    return id ? this.last?.elements.find((e) => e.id === id) : undefined;
  }

  /** The thing an action is on, as said: “Send”, or a place. */
  private target(p: EyesPoint): string {
    const e = this.element(p.element);
    if (e) return e.label ? `${quote(e.label)}` : `the ${e.role}`;
    if (p.element) return `${p.element}`;
    return p.x !== undefined && p.y !== undefined ? `the point ${Math.round(p.x)},${Math.round(p.y)}` : 'there';
  }

  private where() {
    return this.last?.app ? ` in ${this.last.app}` : '';
  }

  describe(action: ComputerAction): string {
    switch (action.kind) {
      case 'click': {
        const verb = action.button === 'right' ? 'right-click' : action.count === 2 ? 'double-click' : 'click';
        return `${verb} ${this.target(action)}${this.where()}`;
      }
      case 'type': {
        const into = action.element ? this.target(action) : this.element(this.last?.focused)?.label ? quote(this.element(this.last?.focused)!.label) : '';
        return `type ${quote(action.text, 80)}${into ? ` into ${into}` : ''}${this.where()}${action.clear ? ', replacing what is there' : ''}${action.submit ? ', then press Return' : ''}`;
      }
      case 'key':
        return `press ${keysSaid(action.keys)}${(action.count ?? 1) > 1 ? ` ${action.count} times` : ''}${this.where()}`;
      case 'scroll':
        return `scroll ${action.direction === 'top' || action.direction === 'bottom' ? `to the ${action.direction}` : action.direction}${this.where()}`;
      case 'drag':
        return `drag ${this.target(action.from)} to ${this.target(action.to)}${this.where()}`;
      case 'wait':
        return `wait ${action.seconds} seconds`;
    }
  }

  async preview(action: ComputerAction): Promise<() => void> {
    const none = () => {};
    if (!this.o.config().showTarget || !this.last) return none;
    const point: EyesPoint | undefined =
      action.kind === 'click' || action.kind === 'scroll' ? action : action.kind === 'type' ? (action.element ? action : this.last.focused ? { element: this.last.focused } : undefined) : action.kind === 'drag' ? action.from : undefined;
    if (!point || (!point.element && (point.x === undefined || point.y === undefined))) return none;
    const verb = action.kind === 'click' ? (action.button === 'right' ? 'right-click' : action.count === 2 ? 'double-click' : 'click') : action.kind === 'type' ? 'type here' : action.kind === 'drag' ? 'drag this' : 'scroll here';
    const label = `${this.o.name?.() ?? 'Nova'} will ${verb}${action.kind === 'click' ? ` ${this.target(point)}` : ''}`;
    try {
      await this.o.eyes.highlight({ ...point, snapshot: this.last.snapshot }, label);
      return () => void this.o.eyes.unhighlight();
    } catch {
      return none;
    }
  }

  async act(action: ComputerAction, caller?: string): Promise<string> {
    if (this.halted) throw new Error('Stopped: the user said to stop everything. Nothing more is done until they ask again.');
    if (action.kind === 'wait') {
      await (this.o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(action.seconds * 1000);
      return `Waited ${action.seconds} ${action.seconds === 1 ? 'second' : 'seconds'}`;
    }
    const config = this.o.config();
    if (this.steps >= config.maxSteps) {
      throw new Error(`That's ${config.maxSteps} steps for this one request - stop here, and tell the user what's done and what's left.`);
    }
    // A brain waits while the user uses the mouse or keyboard; the user's own commands don't.
    if (caller && config.pauseOnInput && userBusy(await this.o.eyes.idle())) {
      this.show(caller, true);
      throw new Error('The user is using the mouse or keyboard right now, so nothing was done. Wait a moment (computer_wait), look again, then carry on - or ask them.');
    }
    const id = action.kind === 'drag' ? undefined : 'element' in action ? action.element : undefined;
    if (id && this.last && !this.element(id)) throw new Error(`There's no ${id} in the last look - look again (computer_look).`);
    if (action.kind === 'type') {
      const into = action.element ? this.element(action.element) : this.element(this.last?.focused);
      if (into?.secure) throw new Error("That's a password field - Nova never types into those. Ask the user to type it themselves.");
    }
    const did = this.describe(action);
    const step = this.request(action);
    if (this.o.dryRun) this.log(`  [dry-run] ${did} (${JSON.stringify(step)})`);
    else await this.o.eyes.act({ ...step, ...(this.last ? { snapshot: this.last.snapshot } : {}) });
    this.steps++;
    // A brain or agent at work is shown (the user's own "click send" needs no banner).
    if (caller) this.show(caller);
    return did.replace(/^(right-click|double-click|click|type|press|scroll|drag)\b/, (verb) => PAST[verb] ?? verb);
  }

  /** What Nova Eyes is asked to do. */
  private request(action: Exclude<ComputerAction, { kind: 'wait' }>): EyesAction {
    switch (action.kind) {
      case 'click':
        return { action: 'click', element: action.element, x: action.x, y: action.y, button: action.button, count: action.count };
      case 'type':
        return { action: 'type', text: action.text, element: action.element, clear: action.clear, submit: action.submit };
      case 'key':
        return { action: 'key', keys: action.keys, count: action.count };
      case 'scroll':
        return { action: 'scroll', direction: action.direction, amount: action.amount, element: action.element, x: action.x, y: action.y };
      case 'drag':
        return { action: 'drag', from: action.from, to: action.to };
    }
  }

  async find(target: string) {
    const shot = await this.o.eyes.snapshot('window', { image: false });
    this.last = shot;
    const found = match(target, shot.elements);
    if (!found) return null;
    if ('one' in found) return { element: found.one.id, label: found.one.label, app: shot.app };
    return { several: found.several.map((e) => e.label), app: shot.app };
  }

  async front() {
    return (await this.o.eyes.context().catch(() => null))?.app ?? this.last?.app ?? null;
  }

  halt() {
    this.halted = true;
    this.steps = 0;
    void this.o.eyes.unhighlight().catch(() => {});
    this.hide();
  }

  resume() {
    this.halted = false;
    this.steps = 0;
  }

  finished() {
    this.hide();
  }

  /** Tell the windows and the orb: Nova's hands are on the computer (or waiting for the user). */
  private show(caller?: string, paused = false) {
    this.active = { caller, app: this.last?.app };
    this.o.broadcast?.({ type: 'computer', active: true, ...(caller ? { caller } : {}), ...(this.last?.app ? { app: this.last.app } : {}), ...(paused ? { paused } : {}), steps: this.steps });
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = setTimeout(() => this.hide(), ACTIVE_MS);
    this.quiet.unref?.();
  }

  private hide() {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
    if (!this.active) return;
    this.active = null;
    this.o.broadcast?.({ type: 'computer', active: false });
  }
}

const PAST: Record<string, string> = {
  click: 'Clicked',
  'right-click': 'Right-clicked',
  'double-click': 'Double-clicked',
  type: 'Typed',
  press: 'Pressed',
  scroll: 'Scrolled',
  drag: 'Dragged',
};
