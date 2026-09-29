import { onDay, type News, type NewsService } from '@nova/core';

/** Whether it's a good moment to speak up. */
export interface Moment {
  /** The Mac is locked, asleep, or untouched for a while. */
  away: boolean;
  /** On a call or in a meeting: a camera is on, or the calendar says so. */
  call: boolean;
  /** Nova is in the middle of something with the user (thinking, speaking). */
  busy: boolean;
}

/**
 * Nova's news - a reminder due, an agent's result, the briefing - said at a good moment. It always
 * shows at once (the orb, a notification). By the user's choice it's also said: when they're free
 * (not on a call, not away - then it waits, and "while you were away…" tells them when they're
 * back), never, or always at once.
 */
export class Deliverer implements NewsService {
  private held: { at: number; news: News }[] = [];
  private waiting: News[] = [];
  private readonly now: () => number;

  constructor(
    private readonly opts: {
      policy: () => 'free' | 'show' | 'always';
      moment: () => Moment;
      speak: (text: string) => void;
      /** Shown at once: a notification from Nova.app. */
      notify?: (news: News) => void;
      now?: () => number;
    },
  ) {
    this.now = opts.now ?? Date.now;
  }

  deliver(news: News) {
    this.opts.notify?.(news);
    const policy = this.opts.policy();
    if (policy === 'always') return this.opts.speak(news.text);
    const moment = this.opts.moment();
    if (policy === 'show' || moment.away || moment.call) return void this.held.push({ at: this.now(), news });
    if (moment.busy) return void this.waiting.push(news);
    this.opts.speak(news.text);
  }

  /** Nova has finished what it was doing with the user: what waited for that, now. */
  idle() {
    if (!this.waiting.length) return;
    const moment = this.opts.moment();
    if (moment.busy) return;
    const news = this.waiting.splice(0);
    if (moment.away || moment.call || this.opts.policy() === 'show') {
      for (const n of news) this.held.push({ at: this.now(), news: n });
      return;
    }
    this.opts.speak(news.map((n) => n.text).join(' '));
  }

  /** The user is back (unlocked, at the keyboard, off the call): what was held, in one go. */
  back() {
    if (this.opts.policy() !== 'free' || !this.held.length) return;
    const moment = this.opts.moment();
    if (moment.away || moment.call || moment.busy) return;
    const now = this.now();
    const items = this.held.splice(0);
    // Old news says when it was: "At 3 PM: it's time to call your mum."
    const said = items.map(({ at, news }) => (now - at > 10 * 60_000 ? `${capital(onDay(new Date(at), new Date(now)))}: ${lower(news.text)}` : news.text));
    this.opts.speak(items.length === 1 ? `While you were away - ${lower(said[0]!)}` : `While you were away, ${items.length} things came up. ${said.join(' ')}`);
  }

  /** What hasn't been said yet: held back, or waiting for Nova to finish. */
  missed() {
    return [...this.held.map((h) => ({ at: h.at, text: h.news.text })), ...this.waiting.map((n) => ({ at: this.now(), text: n.text }))];
  }

  heard() {
    this.held = [];
    this.waiting = [];
  }

  /** How much is being held back, for Settings. */
  get count() {
    return this.held.length + this.waiting.length;
  }
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Lower-cases the first letter unless it starts a name ("Claude finished"). */
const lower = (s: string) => (/^(?:It|Your|A|Here|Remember)\b/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
