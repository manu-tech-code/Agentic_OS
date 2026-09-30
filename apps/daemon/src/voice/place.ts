import type { ServerEvent } from '@nova/core';

/** How long after the last thing said into a phone - or by Nova on it - Nova still speaks there: a reminder an hour
 * later is said at the Mac. */
export const PHONE_VOICE_MS = 90_000;
/** How long Nova may think about what was said into a phone and still answer there (the longest an answer may take). */
export const PHONE_THINK_MS = 600_000;

/** One reply's voice, in the one place it's said. */
export interface VoiceStream<P> {
  /** The phone it's said on, or null: the Mac. */
  readonly to: P | null;
  /** Still heard: at the Mac, or on a phone that's still there. */
  heard(): boolean;
  say(event: ServerEvent): void;
}

/**
 * Where Nova's voice is heard - one place at a time. A reply is said where it starts: on the iPhone the user is
 * talking to Nova on (however long Nova thinks about what was said into it, and for a while after), else at the Mac.
 * All of it is said there - a phone that goes halfway doesn't hand the rest to the Mac - and whatever Nova was saying
 * anywhere else stops as it starts.
 */
export class VoicePlace<P> {
  private phone: P | null = null;
  /** When something was last said into that phone, or by Nova on it. */
  private at = 0;
  /** When Nova last had nothing to do: until then it's still at work on what was said. */
  private restedAt = 0;

  constructor(
    private readonly opts: {
      /** Everyone connected now. */
      peers(): Iterable<P>;
      connected(peer: P): boolean;
      isPhone(peer: P): boolean;
      /** Who plays Nova's voice at the Mac: its app while it's there, else every window. */
      mac(): Iterable<P>;
      send(peer: P, event: ServerEvent): void;
      now?(): number;
    },
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  /** The user spoke into this phone - or at the Mac (null). */
  talkingOn(phone: P | null) {
    this.phone = phone;
    this.at = this.now();
  }

  /** Nova has nothing to do (idle, or listening): what was said has been answered. */
  rested() {
    this.restedAt = this.now();
  }

  /** Someone went: if it was the phone the user was talking on, Nova's voice is back at the Mac. */
  gone(peer: P) {
    if (this.phone === peer) this.phone = null;
  }

  /** The phone Nova's voice goes to now, or null: the Mac. */
  get current(): P | null {
    if (this.phone === null || !this.opts.connected(this.phone)) return null;
    const since = this.now() - this.at;
    return since < PHONE_VOICE_MS || (this.restedAt < this.at && since < PHONE_THINK_MS) ? this.phone : null;
  }

  /** At the Mac, whatever the phones are doing: a preview of a voice chosen in Settings, say. */
  toMac(event: ServerEvent) {
    for (const peer of this.opts.mac()) this.opts.send(peer, event);
  }

  /** A reply starts: all of it is said where Nova's voice is now, and what it was saying anywhere else stops. */
  start(): VoiceStream<P> {
    const to = this.current;
    for (const peer of this.opts.peers()) if (to === null ? this.opts.isPhone(peer) : peer !== to) this.opts.send(peer, { type: 'barge-in' });
    const heard = () => to === null || this.opts.connected(to);
    return {
      to,
      heard,
      say: (event) => {
        if (to === null) return this.toMac(event);
        if (!heard()) return; // gone halfway: the rest isn't moved to the Mac
        if (to === this.phone) this.at = this.now(); // a long reply keeps its phone
        this.opts.send(to, event);
      },
    };
  }
}
