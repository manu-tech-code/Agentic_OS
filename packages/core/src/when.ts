/**
 * When something should happen, from what the user said: "in 20 minutes", "at 5", "tomorrow
 * morning", "on Friday at 3", "on the 12th", "every weekday at 8:30", "every 2 hours".
 * Dates and times are arithmetic, so they stay in code - never with a model. Dependency-free.
 */

export type Repeat =
  | { every: 'day' }
  | { every: 'weekday' }
  | { every: 'weekend' }
  /** Days of the week, 0 Sunday … 6 Saturday. */
  | { every: 'week'; days: number[] }
  | { every: 'month'; day: number }
  | { every: 'interval'; minutes: number };

/** A repeat and the time of day it comes round (an interval ignores the time). */
export type Schedule = Repeat & { hour: number; minute: number };

export interface When {
  /** When it's (first) due. */
  at: Date;
  schedule?: Schedule;
  /** A countdown ("in 20 minutes"), in ms, rather than a time on the clock. */
  inMs?: number;
  /** What's left of the words once the time is taken out: "call mum". */
  rest: string;
  /** A time of day was said (not assumed from "morning", or 9 AM). */
  timeGiven: boolean;
}

const NUMBER: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, fifteen: 15, twenty: 20, 'twenty-five': 25, thirty: 30, forty: 40, 'forty-five': 45, fifty: 50, sixty: 60,
  ninety: 90, few: 3, couple: 2,
};
const NUM = `(?:\\d+(?:\\.\\d+)?|${Object.keys(NUMBER).sort((a, b) => b.length - a.length).join('|')})`;
const HOUR_WORD: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const HOUR = `(?:1[0-2]|0?[1-9]|${Object.keys(HOUR_WORD).join('|')})`;
// No "sun", "sat" or "wed": they're everyday words too.
const WEEKDAY: Record<string, number> = {
  sunday: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6,
};
const DAY_NAME = `(?:${Object.keys(WEEKDAY).sort((a, b) => b.length - a.length).join('|')})`;
const MONTH: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
  august: 7, aug: 7, september: 8, sept: 8, sep: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
};
const MONTH_NAME = `(?:${Object.keys(MONTH).sort((a, b) => b.length - a.length).join('|')})`;
const ORDINAL = '(\\d{1,2})(?:st|nd|rd|th)?';
const PART_HOUR: Record<string, number> = { morning: 9, afternoon: 15, evening: 18, night: 20, tonight: 20 };
const UNIT_MS: Record<string, number> = { second: 1000, sec: 1000, minute: 60_000, min: 60_000, hour: 3_600_000, hr: 3_600_000, day: 86_400_000, week: 604_800_000 };
/** A clock time without am/pm is taken in the waking day, 7:00 to 22:59. */
const DAYTIME = { from: 7, to: 22 };

const num = (word: string) => (/^\d/.test(word) ? Number(word) : (NUMBER[word.toLowerCase()] ?? NaN));
const hourOf = (word: string) => (/^\d/.test(word) ? Number(word) : (HOUR_WORD[word.toLowerCase()] ?? NaN));

/** Pulls matches out of the text as it goes, so what's left is the rest of the sentence. */
class Words {
  constructor(public text: string) {}

  take(re: RegExp): RegExpExecArray | null {
    const m = re.exec(this.text);
    if (m) this.text = `${this.text.slice(0, m.index)} ${this.text.slice(m.index + m[0].length)}`;
    return m;
  }
}

const b = (source: string) => new RegExp(`(?:^|\\b)(?:${source})(?=\\b|$)`, 'i');

/** "a few minutes" is "few minutes", "a couple of hours" is "couple hours": NUMBER knows those. */
const plainly = (text: string) => text.replace(/\ba\s+few\b/gi, 'few').replace(/\b(?:a\s+)?couple\s+of\b/gi, 'couple');

/** "20 minutes", "an hour and a half", "half an hour", "2 hours 30 minutes": ms, or null. */
export function durationMs(text: string): number | null {
  let t = ` ${plainly(text).toLowerCase()} `;
  let total = 0;
  const half = /\b(?:an?\s+)?(hour|day|minute)\s+and\s+a\s+half\b/;
  let m = half.exec(t);
  if (m) {
    total += 1.5 * UNIT_MS[m[1]!]!;
    t = t.replace(half, ' ');
  }
  if (/\bhalf\s+an?\s+hour\b/.test(t)) {
    total += 30 * 60_000;
    t = t.replace(/\bhalf\s+an?\s+hour\b/g, ' ');
  }
  if (/\ba\s+quarter\s+of\s+an?\s+hour\b/.test(t)) {
    total += 15 * 60_000;
    t = t.replace(/\ba\s+quarter\s+of\s+an?\s+hour\b/g, ' ');
  }
  const re = new RegExp(`(${NUM})\\s*(?:more\\s+)?(second|sec|minute|min|hour|hr|day|week)s?\\b`, 'g');
  for (m of t.matchAll(re)) {
    const n = num(m[1]!);
    if (Number.isFinite(n)) total += n * UNIT_MS[m[2]!]!;
  }
  return total > 0 ? Math.round(total) : null;
}

const DURATION = `(?:(?:an?\\s+)?(?:hour|day|minute)\\s+and\\s+a\\s+half|half\\s+an?\\s+hour|a\\s+quarter\\s+of\\s+an?\\s+hour|${NUM}\\s*(?:second|sec|minute|min|hour|hr|day|week)s?)(?:\\s*(?:,|and)?\\s*(?:${NUM}\\s*(?:second|sec|minute|min|hour|hr)s?|a\\s+half))*`;

/** Understand when, or null if no time was said. `now` is the user's own clock. */
export function parseWhen(text: string, now: Date): When | null {
  const w = new Words(` ${plainly(text)} `);

  // Every so often: "every 2 hours", "every 30 minutes", "every hour".
  const interval = w.take(b(`every\\s+(?:(${NUM})\\s+)?(minute|min|hour|hr|half\\s+hour)s?`));
  if (interval) {
    const n = interval[1] ? num(interval[1]) : 1;
    const minutes = interval[2]!.toLowerCase().startsWith('half') ? 30 : interval[2]!.toLowerCase().startsWith('h') ? n * 60 : n;
    if (Number.isFinite(minutes) && minutes > 0) {
      const schedule: Schedule = { every: 'interval', minutes, hour: 0, minute: 0 };
      return { at: new Date(now.getTime() + minutes * 60_000), schedule, rest: tidy(w.text), timeGiven: false };
    }
  }

  // A countdown: "in 20 minutes", "20 minutes from now", "after an hour".
  const countdown = w.take(b(`(?:in|after|within)\\s+(?:about\\s+|around\\s+|another\\s+)?(${DURATION})`)) ?? w.take(b(`(${DURATION})\\s+from\\s+now`));
  if (countdown) {
    const ms = durationMs(countdown[1]!);
    if (ms) return { at: new Date(now.getTime() + ms), inMs: ms, rest: tidy(w.text), timeGiven: false };
  }

  const repeat = takeRepeat(w, now);
  const day = repeat ? null : takeDay(w, now);
  const time = takeTime(w);
  const part = time ? null : takePart(w);

  if (repeat) {
    const hour = time ? pickHour(time, null, now) : part ? PART_HOUR[part]! : repeat.every === 'weekend' ? 10 : 9;
    const schedule: Schedule = { ...repeat, hour, minute: time?.minute ?? 0 };
    return { at: nextTime(schedule, now), schedule, rest: tidy(w.text), timeGiven: Boolean(time) };
  }
  if (day) {
    const base = new Date(day.year, day.month, day.date);
    const hour = time ? pickHour(time, base, now) : part ? PART_HOUR[part]! : (day.part ?? 9);
    let at = new Date(day.year, day.month, day.date, hour, time?.minute ?? 0);
    if (at <= now && day.weekday !== undefined) at = new Date(day.year, day.month, day.date + 7, hour, time?.minute ?? 0);
    if (at <= now && day.nextYearIfPast) at = new Date(day.year + 1, day.month, day.date, hour, time?.minute ?? 0);
    return { at, rest: tidy(w.text), timeGiven: Boolean(time) };
  }
  if (time) {
    return { at: nextClock(time, now), rest: tidy(w.text), timeGiven: true };
  }
  if (part) {
    // "in the morning" said in the afternoon means tomorrow's.
    let at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), PART_HOUR[part]!, 0);
    if (at <= now) at = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1, PART_HOUR[part]!, 0);
    return { at, rest: tidy(w.text), timeGiven: false };
  }
  return null;
}

interface Clock {
  hour: number;
  minute: number;
  /** "pm", "am", or unknown (24-hour times are known). */
  meridiem: 'am' | 'pm' | null;
}

function takeTime(w: Words): Clock | null {
  let m = w.take(b(`(?:at\\s+)?(noon|midday|midnight)`));
  if (m) return { hour: m[1]!.toLowerCase() === 'midnight' ? 0 : 12, minute: 0, meridiem: m[1]!.toLowerCase() === 'midnight' ? 'am' : 'pm' };
  m = w.take(b(`(?:at\\s+)?half\\s+past\\s+(${HOUR})`));
  if (m) return { hour: hourOf(m[1]!), minute: 30, meridiem: meridiemAfter(w) };
  m = w.take(b(`(?:at\\s+)?(?:a\\s+)?quarter\\s+(past|to)\\s+(${HOUR})`));
  if (m) {
    const h = hourOf(m[2]!);
    return m[1]!.toLowerCase() === 'past' ? { hour: h, minute: 15, meridiem: meridiemAfter(w) } : { hour: h === 1 ? 12 : h - 1, minute: 45, meridiem: meridiemAfter(w) };
  }
  // 5pm, 5:30 pm, at 9 a.m.
  m = w.take(b(`(?:at\\s+)?(${HOUR})(?:[:.](\\d{2}))?\\s*(am|pm|a\\.m\\.?|p\\.m\\.?)`));
  if (m) return { hour: hourOf(m[1]!), minute: Number(m[2] ?? 0), meridiem: m[3]!.toLowerCase().startsWith('a') ? 'am' : 'pm' };
  // 17:30, 9:15 - a colon makes it a time.
  m = w.take(b(`(?:at\\s+)?([01]?\\d|2[0-3])[:.]([0-5]\\d)`));
  if (m) {
    const hour = Number(m[1]);
    return { hour, minute: Number(m[2]), meridiem: hour >= 13 || hour === 0 ? (hour >= 12 ? 'pm' : 'am') : meridiemAfter(w) };
  }
  // at 5, at five, at five thirty, at 5 o'clock
  m = w.take(b(`at\\s+(${HOUR})(?:\\s+(o'?clock|oh\\s+five|fifteen|thirty|forty-five|forty five))?(?!\\s*(?:minutes?|mins?|hours?|hrs?|seconds?|secs?|days?|weeks?|percent|%|people|of|times?))`));
  if (m) {
    const extra = (m[2] ?? '').toLowerCase().replace(/\s+/g, ' ');
    const minute = extra === 'fifteen' ? 15 : extra === 'thirty' ? 30 : extra.startsWith('forty') ? 45 : extra === 'oh five' ? 5 : 0;
    return { hour: hourOf(m[1]!), minute, meridiem: meridiemAfter(w) };
  }
  return null;
}

/** "at 5 in the evening", "at 7 tonight": the part of the day that settles am or pm. */
function meridiemAfter(w: Words): 'am' | 'pm' | null {
  const m = w.take(b(`(?:in\\s+the\\s+)?(morning|afternoon|evening|night|tonight)`));
  if (!m) return null;
  return m[1]!.toLowerCase() === 'morning' ? 'am' : 'pm';
}

function takePart(w: Words): string | null {
  const m = w.take(b(`(?:in\\s+the\\s+|this\\s+)?(morning|afternoon|evening|tonight)`)) ?? w.take(b(`(?:at|to)\\s+(night)`));
  return m ? m[1]!.toLowerCase() : null;
}

interface Day {
  year: number;
  month: number;
  date: number;
  /** A named weekday that's already gone today moves on a week. */
  weekday?: number;
  nextYearIfPast?: boolean;
  /** A day part said with the day ("tomorrow morning"). */
  part?: number;
}

function takeDay(w: Words, now: Date): Day | null {
  const y = now.getFullYear();
  const mo = now.getMonth();
  const d = now.getDate();
  const partAfter = () => {
    const m = w.take(b(`(?:in\\s+the\\s+)?(morning|afternoon|evening|night)`));
    return m ? PART_HOUR[m[1]!.toLowerCase()] : undefined;
  };
  let m = w.take(b('(?:the\\s+)?day\\s+after\\s+tomorrow'));
  if (m) return { year: y, month: mo, date: d + 2, part: partAfter() };
  m = w.take(b('tomorrow'));
  if (m) return { year: y, month: mo, date: d + 1, part: partAfter() };
  m = w.take(b('tonight'));
  if (m) return { year: y, month: mo, date: d, part: 20 };
  m = w.take(b('today'));
  if (m) return { year: y, month: mo, date: d, part: partAfter() };
  m = w.take(b(`in\\s+(${NUM})\\s+days?`)) ?? w.take(b(`(${NUM})\\s+days?\\s+from\\s+now`));
  if (m) return { year: y, month: mo, date: d + num(m[1]!) };
  m = w.take(b('next\\s+week'));
  if (m) return { year: y, month: mo, date: d + ((8 - now.getDay()) % 7 || 7) }; // next Monday
  // on Friday, this Friday, next Friday, Friday morning
  m = w.take(b(`(?:on\\s+|this\\s+|next\\s+|coming\\s+|this\\s+coming\\s+)?(${DAY_NAME})`));
  if (m) {
    const target = WEEKDAY[m[1]!.toLowerCase()]!;
    let ahead = (target - now.getDay() + 7) % 7;
    if (ahead === 0 && /^\s*next/i.test(m[0])) ahead = 7;
    return { year: y, month: mo, date: d + ahead, weekday: target, part: partAfter() };
  }
  // on March 3rd, on 3 March, on the 3rd of March
  m = w.take(b(`(?:on\\s+)?(${MONTH_NAME})\\s+(?:the\\s+)?${ORDINAL}`));
  if (m) return { year: y, month: MONTH[m[1]!.toLowerCase()]!, date: Number(m[2]), nextYearIfPast: true, part: partAfter() };
  m = w.take(b(`(?:on\\s+)?(?:the\\s+)?${ORDINAL}\\s+(?:of\\s+)?(${MONTH_NAME})`));
  if (m) return { year: y, month: MONTH[m[2]!.toLowerCase()]!, date: Number(m[1]), nextYearIfPast: true, part: partAfter() };
  // on the 12th - this month's, or next month's once it's gone
  m = w.take(b(`on\\s+the\\s+${ORDINAL}`));
  if (m) {
    const date = Number(m[1]);
    if (date >= 1 && date <= 31) {
      const part = partAfter();
      const month = new Date(y, mo, date, 23, 59) < now ? mo + 1 : mo;
      return { year: y, month, date: Math.min(date, daysIn(y, month)), part };
    }
  }
  return null;
}

function takeRepeat(w: Words, now: Date): Repeat | null {
  let m = w.take(b(`(?:every|each)\\s+(?:single\\s+)?(?:work\\s+day|weekday|week\\s+day)s?`)) ?? w.take(b('(?:on\\s+)?weekdays'));
  if (m) return { every: 'weekday' };
  m = w.take(b('(?:every|each)\\s+weekends?')) ?? w.take(b('(?:on\\s+)?weekends'));
  if (m) return { every: 'weekend' };
  // every Monday and Thursday, on Tuesdays and Fridays
  const days = `${DAY_NAME}s?(?:\\s*(?:,|and|&|or)\\s*(?:on\\s+)?${DAY_NAME}s?)*`;
  m = w.take(b(`(?:every|each)\\s+(${days})`)) ?? w.take(b(`(?:on\\s+)?(${DAY_NAME}s(?:\\s*(?:,|and|&)\\s*${DAY_NAME}s)*)`));
  if (m) {
    const picked = [...new Set(m[1]!.toLowerCase().match(new RegExp(DAY_NAME, 'g'))!.map((n) => WEEKDAY[n]!))].sort();
    return { every: 'week', days: picked };
  }
  // on the 1st of every month, every month on the 15th, monthly on the 3rd
  m = w.take(b(`(?:on\\s+)?the\\s+${ORDINAL}\\s+of\\s+(?:every|each)\\s+month`)) ?? w.take(b(`(?:every\\s+month|monthly)\\s+on\\s+the\\s+${ORDINAL}`));
  if (m) return { every: 'month', day: Math.min(31, Math.max(1, Number(m[1]))) };
  m = w.take(b('(?:every|each)\\s+month|monthly'));
  if (m) return { every: 'month', day: now.getDate() };
  m = w.take(b('(?:every|each)\\s+week|weekly'));
  if (m) {
    const on = w.take(b(`on\\s+(${DAY_NAME})`));
    return { every: 'week', days: [on ? WEEKDAY[on[1]!.toLowerCase()]! : now.getDay()] };
  }
  m = w.take(b('(?:every|each)\\s+(?:single\\s+)?(day|morning|afternoon|evening|night)|daily'));
  if (m) {
    const part = m[1]?.toLowerCase();
    if (part && part !== 'day') w.text = `${w.text} ${part === 'night' ? 'at night' : `in the ${part}`}`; // the part sets the time
    return { every: 'day' };
  }
  return null;
}

const daysIn = (year: number, month: number) => new Date(year, month + 1, 0).getDate();

/** The hour for a clock time on a day: said am/pm as said; otherwise the waking-day reading. */
function pickHour(time: Clock, day: Date | null, now: Date): number {
  if (time.meridiem === 'pm') return time.hour === 12 ? 12 : time.hour + (time.hour < 12 ? 12 : 0);
  if (time.meridiem === 'am') return time.hour === 12 ? 0 : time.hour;
  if (time.hour > 12) return time.hour;
  const candidates = [time.hour % 12, (time.hour % 12) + 12].filter((h) => h >= DAYTIME.from && h <= DAYTIME.to);
  if (!candidates.length) return time.hour;
  // Today: the first reading still to come. Another day: the earlier one.
  if (day && day.toDateString() === now.toDateString()) {
    const ahead = candidates.find((h) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, time.minute) > now);
    return ahead ?? candidates[candidates.length - 1]!;
  }
  return candidates[0]!;
}

/** The next time the clock shows this: today if it's still to come, else tomorrow. */
function nextClock(time: Clock, now: Date): Date {
  for (let ahead = 0; ahead < 2; ahead++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead);
    const hours =
      time.meridiem || time.hour > 12
        ? [pickHour(time, day, now)]
        : [time.hour % 12, (time.hour % 12) + 12].filter((h) => h >= DAYTIME.from && h <= DAYTIME.to);
    for (const hour of hours.length ? hours : [time.hour]) {
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, time.minute);
      if (at > now) return at;
    }
  }
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, pickHour(time, null, now), time.minute);
}

/** When a schedule next comes round after a moment. */
export function nextTime(schedule: Schedule, after: Date): Date {
  if (schedule.every === 'interval') return new Date(after.getTime() + schedule.minutes * 60_000);
  if (schedule.every === 'month') {
    for (let k = 0; k < 24; k++) {
      const year = after.getFullYear();
      const month = after.getMonth() + k;
      const at = new Date(year, month, Math.min(schedule.day, daysIn(year, month)), schedule.hour, schedule.minute);
      if (at > after) return at;
    }
  }
  for (let k = 0; k < 15; k++) {
    const at = new Date(after.getFullYear(), after.getMonth(), after.getDate() + k, schedule.hour, schedule.minute);
    const day = at.getDay();
    const fits =
      schedule.every === 'day' ||
      (schedule.every === 'weekday' && day >= 1 && day <= 5) ||
      (schedule.every === 'weekend' && (day === 0 || day === 6)) ||
      (schedule.every === 'week' && schedule.days.includes(day));
    if (fits && at > after) return at;
  }
  return new Date(after.getTime() + 86_400_000);
}

/** "5 PM", "8:30 AM". */
export function clockText(at: Date) {
  const h = at.getHours();
  const m = at.getMinutes();
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ordinal = (n: number) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** When, said back: "at 5 PM", "tomorrow at 9 AM", "on Friday at 3 PM", "every weekday at 8:30 AM". */
export function describeWhen(when: Pick<When, 'at' | 'schedule' | 'inMs'>, now: Date): string {
  const { at, schedule } = when;
  if (schedule) {
    const time = clockText(at);
    switch (schedule.every) {
      case 'interval':
        return schedule.minutes % 60 === 0 ? `every ${schedule.minutes === 60 ? 'hour' : `${schedule.minutes / 60} hours`}` : `every ${schedule.minutes} minutes`;
      case 'day':
        return `every day at ${time}`;
      case 'weekday':
        return `every weekday at ${time}`;
      case 'weekend':
        return `every weekend at ${time}`;
      case 'week':
        return `every ${list(schedule.days.map((d) => DAY_NAMES[d]!))} at ${time}`;
      case 'month':
        return `on the ${ordinal(schedule.day)} of every month at ${time}`;
    }
  }
  if (when.inMs && when.inMs < 3 * 3_600_000) return `in ${spokenDuration(when.inMs)}`;
  return onDay(at, now);
}

/** A moment as a day and a time: "at 5 PM", "tomorrow at 9 AM", "on Friday at 3 PM", "on October 12 at 9 AM". */
export function onDay(at: Date, now: Date): string {
  const days = Math.round((new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  const time = clockText(at);
  if (days === 0) return `at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days === -1) return `yesterday at ${time}`;
  if (Math.abs(days) < 7) return `on ${DAY_NAMES[at.getDay()]} at ${time}`;
  return `on ${MONTH_NAMES[at.getMonth()]} ${at.getDate()}${at.getFullYear() !== now.getFullYear() ? `, ${at.getFullYear()}` : ''} at ${time}`;
}

/** "20 minutes", "an hour and 15 minutes". */
export function spokenDuration(ms: number) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))} seconds`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = h === 1 ? 'an hour' : `${h} hours`;
  return h ? (m ? `${hours} and ${m} minute${m === 1 ? '' : 's'}` : hours) : `${m} minute${m === 1 ? '' : 's'}`;
}

/** What's left once the time is out: connecting words and stray punctuation go too. */
function tidy(text: string) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/^[\s,.:;-]+|[\s,.:;!?-]+$/g, '')
    .replace(/\b(?:at|on|for|by|in|from)\s*$/i, '')
    .replace(/^(?:at|on|for|by)\s+/i, '')
    .trim();
}
