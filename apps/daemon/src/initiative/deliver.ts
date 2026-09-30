import { onDay, type News, type NewsService, type PhoneNews } from '@nova/core';

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
 * back), never, or always at once. Away from the Mac with Nova open on their iPhone, it's said there
 * (Settings → iPhone → News on your iPhone) - and what was held comes up there when they open it, or as
 * notifications when the phone checks in by itself.
 */
export class Deliverer implements NewsService {
  /** Held back, and whether the user was away from the Mac then (only that goes to the phone). */
  private held: { id: string; at: number; news: News; away: boolean }[] = [];
  private waiting: News[] = [];
  private readonly now: () => number;
  private count_ = 0;

  constructor(
    private readonly opts: {
      policy: () => 'free' | 'show' | 'always';
      moment: () => Moment;
      speak: (text: string) => void;
      /** Shown at once: a notification from Nova.app. */
      notify?: (news: News) => void;
      /** A phone the user is using: whether it takes the news now (given whether they're away from the Mac), and saying it there. */
      phone?: { wants: (away: boolean) => boolean; speak: (text: string) => void };
      now?: () => number;
    },
  ) {
    this.now = opts.now ?? Date.now;
  }

  deliver(news: News) {
    this.opts.notify?.(news);
    const policy = this.opts.policy();
    const moment = this.opts.moment();
    if (this.onPhone(moment)) {
      if (moment.busy) return void this.waiting.push(news); // said there once Nova has finished
      return this.opts.phone!.speak(news.text);
    }
    if (policy === 'always') return this.opts.speak(news.text);
    if (policy === 'show' || moment.away || moment.call) return this.hold(news, moment.away);
    if (moment.busy) return void this.waiting.push(news);
    this.opts.speak(news.text);
  }

  /** Whether news goes to the phone the user is using: never during a call, nor when they chose never to be told unasked. */
  private onPhone(moment: Moment) {
    return this.opts.policy() !== 'show' && !moment.call && Boolean(this.opts.phone?.wants(moment.away));
  }

  /** Nova has finished what it was doing with the user: what waited for that, now. */
  idle() {
    if (!this.waiting.length) return;
    const moment = this.opts.moment();
    if (moment.busy) return;
    const news = this.waiting.splice(0);
    if (this.onPhone(moment)) return this.opts.phone!.speak(news.map((n) => n.text).join(' '));
    if (moment.away || moment.call || this.opts.policy() === 'show') {
      for (const n of news) this.hold(n, moment.away);
      return;
    }
    this.opts.speak(news.map((n) => n.text).join(' '));
  }

  /** The user is back (unlocked, at the keyboard, off the call): what was held, in one go. */
  back() {
    if (this.opts.policy() !== 'free' || !this.held.length) return;
    const moment = this.opts.moment();
    if (moment.away || moment.call || moment.busy) return;
    this.opts.speak(this.whileAway(this.held.splice(0)));
  }

  /** Nova came to the front on the user's phone, while they're away from the Mac: what was held, said there. */
  phoneBack() {
    if (this.opts.policy() !== 'free' || !this.held.length) return;
    const moment = this.opts.moment();
    if (moment.busy || !this.onPhone(moment)) return;
    this.opts.phone!.speak(this.whileAway(this.held.splice(0)));
  }

  private hold(news: News, away: boolean) {
    // Unique across restarts too: the phone keys its notifications by it.
    this.held.push({ id: `${this.now().toString(36)}-${++this.count_}`, at: this.now(), news, away });
  }

  /**
   * A phone checking in by itself - iOS woke Nova there: what was held while the user was away from the Mac, for it
   * to show as notifications. It stays held until the phone says it showed it (`shownOnPhone`).
   */
  forPhone(): PhoneNews[] {
    return this.held
      .filter((h) => h.away)
      .map(({ id, at, news }) => ({ id, kind: news.kind, title: news.title, text: news.text, at, ...(news.ref ? { ref: news.ref } : {}) }));
  }

  /** The phone showed these as notifications: they're not said again when the user is back at the Mac. */
  shownOnPhone(ids: readonly string[]) {
    const shown = new Set(ids);
    this.held = this.held.filter((h) => !shown.has(h.id));
  }

  private whileAway(items: { at: number; news: News }[]) {
    const now = this.now();
    // Old news says when it was: "At 3 PM: it's time to call your mum."
    const said = items.map(({ at, news }) => (now - at > 10 * 60_000 ? `${capital(onDay(new Date(at), new Date(now)))}: ${lower(news.text)}` : news.text));
    return items.length === 1 ? `While you were away - ${lower(said[0]!)}` : `While you were away, ${items.length} things came up. ${said.join(' ')}`;
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
