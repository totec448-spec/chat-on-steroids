import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dueRun, nextRunAfter, sameLocalDay, validSchedule, type Schedule } from '../src/shared/schedule.js';

/**
 * #1826: when a chat's scheduled message is due. Times are local wall-clock times; a run missed
 * while the app was closed or asleep is sent once when it is back, marked late.
 */
let zone: string | undefined;
beforeAll(() => { zone = process.env.TZ; process.env.TZ = 'Europe/Berlin'; });
afterAll(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });

const local = (text: string) => new Date(text).getTime(); // ISO without zone = local time
const at = (time: number) => {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const schedule = (repeat: Schedule['repeat'], over: Partial<Schedule> = {}): Schedule =>
  ({ repeat, until: null, paused: false, createdAt: local('2026-10-20T08:00:00'), lastDueAt: null, ...over });

describe('next run', () => {
  it('runs daily at a local time, the same day when it is still ahead', () => {
    const daily = schedule({ kind: 'daily', at: '09:00' });
    expect(at(nextRunAfter(daily, local('2026-10-24T08:59:00'))!)).toBe('2026-10-24 09:00');
    expect(at(nextRunAfter(daily, local('2026-10-24T09:00:00'))!)).toBe('2026-10-25 09:00');
  });

  it('runs on weekdays only, from Friday to Monday', () => {
    const weekdays = schedule({ kind: 'weekdays', at: '09:00' });
    expect(at(nextRunAfter(weekdays, local('2026-10-23T10:00:00'))!)).toBe('2026-10-26 09:00'); // Fri → Mon
  });

  it('runs weekly on its day', () => {
    const weekly = schedule({ kind: 'weekly', day: 3, at: '17:30' }); // Wednesday
    expect(at(nextRunAfter(weekly, local('2026-10-24T10:00:00'))!)).toBe('2026-10-28 17:30');
  });

  it('runs every n hours from when the schedule was made, whatever the clock change', () => {
    const hourly = schedule({ kind: 'hours', every: 2 }, { createdAt: local('2026-10-24T08:15:00') });
    expect(at(nextRunAfter(hourly, local('2026-10-24T09:00:00'))!)).toBe('2026-10-24 10:15');
    // Across the autumn change (03:00 back to 02:00 on 2026-10-25): two real hours, not two clock hours.
    const across = nextRunAfter(hourly, local('2026-10-25T00:20:00'))!;
    expect(across - local('2026-10-25T00:20:00')).toBeLessThanOrEqual(2 * 3600_000);
  });

  it('runs a time the spring change skips at the first minute after it', () => {
    // 2027-03-28: clocks go from 02:00 to 03:00 in Berlin; 02:30 does not exist that day.
    const night = schedule({ kind: 'daily', at: '02:30' });
    expect(at(nextRunAfter(night, local('2027-03-28T01:00:00'))!)).toBe('2027-03-28 03:00');
    expect(at(nextRunAfter(night, local('2027-03-28T03:00:00'))!)).toBe('2027-03-29 02:30');
  });

  it('finds the first real minute after a half-hour clock change too (Lord Howe Island)', () => {
    process.env.TZ = 'Australia/Lord_Howe';
    try {
      // 2026-10-04: clocks go from 02:00 to 02:30; 02:15 does not exist that day.
      const night = schedule({ kind: 'daily', at: '02:15' }, { createdAt: local('2026-10-01T08:00:00') });
      expect(at(nextRunAfter(night, local('2026-10-04T01:00:00'))!)).toBe('2026-10-04 02:30');
      expect(at(nextRunAfter(night, local('2026-10-04T03:00:00'))!)).toBe('2026-10-05 02:15');
    } finally { process.env.TZ = 'Europe/Berlin'; }
  });

  it('runs a time the autumn change repeats only once', () => {
    // 2026-10-25: 02:00–02:59 happens twice in Berlin.
    const night = schedule({ kind: 'daily', at: '02:30' });
    const first = nextRunAfter(night, local('2026-10-25T01:00:00'))!;
    expect(at(first)).toBe('2026-10-25 02:30');
    expect(at(nextRunAfter(night, first)!)).toBe('2026-10-26 02:30');
  });

  it('has no next run after its end date, or while paused', () => {
    expect(nextRunAfter(schedule({ kind: 'daily', at: '09:00' }, { until: local('2026-10-24T23:59:00') }), local('2026-10-24T10:00:00'))).toBeNull();
    expect(nextRunAfter(schedule({ kind: 'daily', at: '09:00' }, { paused: true }), local('2026-10-24T08:00:00'))).toBeNull();
  });
});

describe('due run', () => {
  it('is due at its time, on time within two minutes', () => {
    const daily = schedule({ kind: 'daily', at: '09:00' }, { lastDueAt: local('2026-10-23T09:00:00') });
    expect(dueRun(daily, local('2026-10-24T08:59:00'))).toBeNull();
    expect(dueRun(daily, local('2026-10-24T09:01:00'))).toEqual({ dueAt: local('2026-10-24T09:00:00'), late: false });
  });

  it('sends one late run for any number missed, and then keeps the normal times', () => {
    const daily = schedule({ kind: 'daily', at: '09:00' }, { lastDueAt: local('2026-10-20T09:00:00') });
    const due = dueRun(daily, local('2026-10-24T12:00:00'))!;
    expect(due).toEqual({ dueAt: local('2026-10-24T09:00:00'), late: true });
    const after = { ...daily, lastDueAt: due.dueAt };
    expect(dueRun(after, local('2026-10-24T12:00:00'))).toBeNull();
    expect(at(nextRunAfter(after, local('2026-10-24T12:00:00'))!)).toBe('2026-10-25 09:00');
  });

  it('never sends a run twice for the same time, also when the clock goes back', () => {
    const daily = schedule({ kind: 'daily', at: '09:00' }, { lastDueAt: local('2026-10-24T09:00:00') });
    expect(dueRun(daily, local('2026-10-24T08:30:00'))).toBeNull();
    expect(dueRun(daily, local('2026-10-24T09:05:00'))).toBeNull();
  });

  it('starts at its next time when it was saved, never at once', () => {
    const fresh = schedule({ kind: 'daily', at: '09:00' }, { createdAt: local('2026-10-24T10:00:00') });
    expect(dueRun(fresh, local('2026-10-24T10:00:30'))).toBeNull();
    expect(dueRun(fresh, local('2026-10-25T09:00:10'))).toEqual({ dueAt: local('2026-10-25T09:00:00'), late: false });
  });

  it('sends nothing past its end date, not even a run missed before it, nor while paused', () => {
    expect(dueRun(schedule({ kind: 'daily', at: '09:00' }, { until: local('2026-10-21T00:00:00') }), local('2026-10-24T09:00:30'))).toBeNull();
    expect(dueRun(schedule({ kind: 'daily', at: '09:00' }, { paused: true }), local('2026-10-24T09:00:30'))).toBeNull();
    // Its last run, at the end time itself, still goes out on time.
    expect(dueRun(schedule({ kind: 'daily', at: '09:00' }, { until: local('2026-10-24T09:00:00'), lastDueAt: local('2026-10-23T09:00:00') }), local('2026-10-24T09:00:40')))
      .toEqual({ dueAt: local('2026-10-24T09:00:00'), late: false });
  });
});

describe('valid schedule', () => {
  it('accepts the four kinds and refuses what cannot run', () => {
    expect(validSchedule({ kind: 'hours', every: 1 })).toBe(true);
    expect(validSchedule({ kind: 'hours', every: 0.5 })).toBe(false); // shorter than an hour
    expect(validSchedule({ kind: 'hours', every: 25 })).toBe(false);
    expect(validSchedule({ kind: 'daily', at: '24:00' })).toBe(false);
    expect(validSchedule({ kind: 'weekly', day: 7, at: '09:00' })).toBe(false);
    expect(validSchedule({ kind: 'weekdays', at: '9:00' })).toBe(false);
  });
});

it('tells whether two times fall on the same local day, so a time today needs no weekday (2.1.47 round)', () => {
  const morning = new Date(2026, 9, 28, 7, 17).getTime();
  expect(sameLocalDay(morning, new Date(2026, 9, 28, 23, 59).getTime())).toBe(true);
  expect(sameLocalDay(morning, new Date(2026, 9, 29, 0, 0).getTime())).toBe(false);
  expect(sameLocalDay(morning, new Date(2026, 9, 27, 23, 59).getTime())).toBe(false);
  // The same weekday a week later is not today.
  expect(sameLocalDay(morning, new Date(2026, 10, 4, 7, 17).getTime())).toBe(false);
});
