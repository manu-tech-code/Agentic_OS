import { describe, expect, it } from 'vitest';
import { describeWhen, durationMs, nextTime, parseWhen, spokenDuration, type Schedule } from '../src/when.ts';

// Sunday 27 September 2026, 1:43 PM.
const NOW = new Date(2026, 8, 27, 13, 43);
const at = (text: string) => parseWhen(text, NOW);
const local = (d: Date | undefined) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : 'none');
const when = (text: string) => local(at(text)?.at);

describe('countdowns', () => {
  it('reads how long from now', () => {
    expect(when('remind me in 20 minutes to check the oven')).toBe('2026-09-27 14:03');
    expect(when('in an hour and a half')).toBe('2026-09-27 15:13');
    expect(when('in half an hour')).toBe('2026-09-27 14:13');
    expect(when('in 2 hours 30 minutes')).toBe('2026-09-27 16:13');
    expect(when('in a few minutes')).toBe('2026-09-27 13:46');
    expect(when('ten minutes from now')).toBe('2026-09-27 13:53');
    expect(at('remind me in 20 minutes to check the oven')?.rest).toBe('remind me to check the oven');
    expect(at('in 20 minutes')?.inMs).toBe(20 * 60_000);
  });

  it('adds up durations', () => {
    expect(durationMs('an hour and a half')).toBe(90 * 60_000);
    expect(durationMs('a couple of hours')).toBe(2 * 3_600_000);
    expect(durationMs('45 seconds')).toBe(45_000);
    expect(durationMs('nothing here')).toBeNull();
  });

  it('reads a half either side of the unit', () => {
    expect(durationMs('2 hours and a half')).toBe(150 * 60_000);
    expect(durationMs('two and a half hours')).toBe(150 * 60_000);
    expect(durationMs('a day and a half')).toBe(36 * 3_600_000);
    expect(when('in 2 hours and a half')).toBe('2026-09-27 16:13');
    expect(when('in two and a half hours')).toBe('2026-09-27 16:13');
    expect(at('remind me in two and a half hours to stretch')?.rest).toBe('remind me to stretch');
  });

  it('takes days and weeks from now as a day - at the time said, or this time of day', () => {
    expect(when('in 2 days at 5pm')).toBe('2026-09-29 17:00');
    expect(at('remind me in 2 days at 5pm to call mum')?.rest).toBe('remind me to call mum');
    expect(when('in 2 days in the morning')).toBe('2026-09-29 09:00');
    expect(when('in 3 weeks')).toBe('2026-10-18 13:43');
    expect(when('a week from now at 10am')).toBe('2026-10-04 10:00');
    // A day away isn't a countdown: cancelling the timers leaves it alone.
    expect(at('remind me in 3 weeks to renew my passport')?.inMs).toBeUndefined();
    expect(at('in 1 day and 3 hours')?.inMs).toBe(27 * 3_600_000);
  });
});

describe('times of day', () => {
  it('takes a time without am or pm in the waking day, and the next one to come', () => {
    expect(when('at 5')).toBe('2026-09-27 17:00');
    expect(when('at 9')).toBe('2026-09-27 21:00'); // 9 AM has gone; 9 PM is still today
    expect(when('at 11')).toBe('2026-09-28 11:00'); // 11 PM is past the waking day: tomorrow morning
    expect(when('at 1')).toBe('2026-09-28 13:00'); // not 1 in the night
    expect(when('at half past four')).toBe('2026-09-27 16:30');
    expect(when('at quarter to five')).toBe('2026-09-27 16:45');
    expect(when('at five thirty')).toBe('2026-09-27 17:30');
  });

  it('takes am, pm and 24-hour times as said', () => {
    expect(when('at 9am')).toBe('2026-09-28 09:00');
    expect(when('5:30 pm')).toBe('2026-09-27 17:30');
    expect(when('at 17:30')).toBe('2026-09-27 17:30');
    expect(when('at noon')).toBe('2026-09-28 12:00');
    expect(when('at midnight')).toBe('2026-09-28 00:00');
    expect(when('at 7 in the morning')).toBe('2026-09-28 07:00');
    expect(when('at 7 in the evening')).toBe('2026-09-27 19:00');
  });

  it('reads parts of the day', () => {
    expect(when('this evening')).toBe('2026-09-27 18:00');
    expect(when('tonight')).toBe('2026-09-27 20:00');
    expect(when('in the morning')).toBe('2026-09-28 09:00');
    expect(when('tonight at 8')).toBe('2026-09-27 20:00');
  });

  it("doesn't take numbers that aren't times", () => {
    expect(at('remind me to buy 5 apples')).toBeNull();
    expect(at('at 5 people')).toBeNull();
    expect(at('the sun is out and i sat down')).toBeNull();
    // A dot makes a clock time only after "at", or with am or pm: on its own, 12.50 is a price.
    expect(at('pay the 12.50 bill')).toBeNull();
    expect(when('pay the 12.50 bill tomorrow')).toBe('2026-09-28 09:00');
    expect(at('pay the 12.50 bill tomorrow')?.rest).toBe('pay the 12.50 bill');
    expect(when('at 5.30')).toBe('2026-09-27 17:30');
    expect(when('5.30 pm')).toBe('2026-09-27 17:30');
  });

  it('lets the part of the day said with the day settle am or pm', () => {
    expect(when('tomorrow evening at 8')).toBe('2026-09-28 20:00');
    expect(when('tomorrow morning at 5')).toBe('2026-09-28 05:00');
    expect(when('on friday evening at 7')).toBe('2026-10-02 19:00');
    expect(when('tomorrow at 8 in the evening')).toBe('2026-09-28 20:00');
    expect(when('tomorrow afternoon at 3')).toBe('2026-09-28 15:00');
    expect(when('tomorrow evening at 8am')).toBe('2026-09-28 08:00'); // said: as said
    expect(local(parseWhen('at 7 tonight', new Date(2026, 8, 27, 6, 30))?.at)).toBe('2026-09-27 19:00');
    expect(local(parseWhen('tonight at 9', new Date(2026, 8, 27, 6, 30))?.at)).toBe('2026-09-27 21:00');
  });
});

describe('days', () => {
  it('reads tomorrow, weekdays and dates', () => {
    expect(when('tomorrow')).toBe('2026-09-28 09:00');
    expect(when('tomorrow at 5')).toBe('2026-09-28 17:00');
    expect(when('tomorrow at 8')).toBe('2026-09-28 08:00');
    expect(when('tomorrow evening')).toBe('2026-09-28 18:00');
    expect(when('the day after tomorrow at 10am')).toBe('2026-09-29 10:00');
    expect(when('on friday at 3')).toBe('2026-10-02 15:00');
    expect(when('next tuesday')).toBe('2026-09-29 09:00');
    expect(when('sunday at 9pm')).toBe('2026-09-27 21:00'); // today, still to come
    expect(when('sunday at 9am')).toBe('2026-10-04 09:00'); // today's has gone: next week's
    expect(when('on the 12th')).toBe('2026-10-12 09:00');
    expect(when('on the 30th at 2pm')).toBe('2026-09-30 14:00');
    expect(when('on march 3rd')).toBe('2027-03-03 09:00');
    expect(when('on the 15th of october at 6pm')).toBe('2026-10-15 18:00');
    expect(when('in 3 days')).toBe('2026-09-30 13:43');
    expect(when('next week')).toBe('2026-09-28 09:00');
    expect(at('remind me to call mum at 5 tomorrow')?.rest).toBe('remind me to call mum');
  });
});

describe('repeats', () => {
  const schedule = (text: string) => at(text)?.schedule;
  it('reads every day, weekdays, weekends, days of the week and months', () => {
    expect(schedule('every day at 9')).toMatchObject({ every: 'day', hour: 9, minute: 0 });
    expect(when('every day at 9')).toBe('2026-09-28 09:00');
    expect(schedule('every morning')).toMatchObject({ every: 'day', hour: 9 });
    expect(schedule('every evening at 7')).toMatchObject({ every: 'day', hour: 19 });
    expect(schedule('every weekday at 8:30')).toMatchObject({ every: 'weekday', hour: 8, minute: 30 });
    expect(when('every weekday at 8:30')).toBe('2026-09-28 08:30');
    expect(schedule('on weekends')).toMatchObject({ every: 'weekend', hour: 10 });
    expect(schedule('every monday and thursday at 7')).toMatchObject({ every: 'week', days: [1, 4], hour: 7 });
    expect(when('every monday and thursday at 7')).toBe('2026-09-28 07:00');
    expect(schedule('on fridays at 5pm')).toMatchObject({ every: 'week', days: [5], hour: 17 });
    expect(schedule('on the 1st of every month')).toMatchObject({ every: 'month', day: 1, hour: 9 });
    expect(when('on the 1st of every month')).toBe('2026-10-01 09:00');
    expect(schedule('every 2 hours')).toMatchObject({ every: 'interval', minutes: 120 });
    expect(when('every 30 minutes')).toBe('2026-09-27 14:13');
    expect(at('every friday at 5 remind me to file my hours')?.rest).toBe('remind me to file my hours');
  });

  it('comes round again', () => {
    const weekdays: Schedule = { every: 'weekday', hour: 8, minute: 30 };
    expect(local(nextTime(weekdays, new Date(2026, 9, 2, 9, 0)))).toBe('2026-10-05 08:30'); // Friday → Monday
    const monthly: Schedule = { every: 'month', day: 31, hour: 9, minute: 0 };
    expect(local(nextTime(monthly, new Date(2026, 9, 31, 10, 0)))).toBe('2026-11-30 09:00'); // no 31st in November
    expect(local(nextTime({ every: 'interval', minutes: 90, hour: 0, minute: 0 }, NOW))).toBe('2026-09-27 15:13');
  });
});

describe('saying it back', () => {
  const say = (text: string) => describeWhen(at(text)!, NOW);
  it('reads naturally', () => {
    expect(say('at 5')).toBe('at 5 PM');
    expect(say('tomorrow at 8:30')).toBe('tomorrow at 8:30 AM');
    expect(say('on friday at 3')).toBe('on Friday at 3 PM');
    expect(say('on the 12th')).toBe('on October 12 at 9 AM');
    expect(say('on march 3rd')).toBe('on March 3, 2027 at 9 AM');
    expect(say('in 20 minutes')).toBe('in 20 minutes');
    expect(say('in an hour and a half')).toBe('in an hour and 30 minutes');
    expect(say('every weekday at 8:30')).toBe('every weekday at 8:30 AM');
    expect(say('every monday and thursday at 7')).toBe('every Monday and Thursday at 7 AM');
    expect(say('on the 1st of every month')).toBe('on the 1st of every month at 9 AM');
    expect(say('every 2 hours')).toBe('every 2 hours');
    expect(spokenDuration(61 * 60_000)).toBe('an hour and 1 minute');
  });
});
