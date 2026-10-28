/**
 * Scheduled runs (#1826): when a chat's scheduled message is due. Pure and clock-free, so the
 * main process and the renderer agree, and every rule is testable with any time zone.
 *
 * Times of day are local wall-clock times. A time the spring clock change skips runs at the first
 * minute after the change; a time the autumn change repeats runs once. "Every n hours" counts
 * real hours from when the schedule was made, so a clock change neither adds nor drops a run.
 * The latest run missed while the app was closed or asleep is reported once when it is back,
 * marked late; the runner skips it unless the schedule catches up. Past its end date nothing.
 */

export type ScheduleRepeat =
  | { kind: 'hours'; every: number }
  | { kind: 'daily'; at: string }
  | { kind: 'weekdays'; at: string }
  /** `day`: 0 Sunday … 6 Saturday, as Date#getDay. */
  | { kind: 'weekly'; day: number; at: string };

export interface Schedule {
  repeat: ScheduleRepeat;
  /** No run after this time; null runs until removed. */
  until: number | null;
  paused: boolean;
  createdAt: number;
  /** The scheduled time of the last run sent (not when it was sent); null before the first. */
  lastDueAt: number | null;
}

/** Sent within this long of its time, a run is on time; later, it is labelled late. */
export const SCHEDULE_ON_TIME_MS = 2 * 60_000;
const HOUR_MS = 3600_000;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Whether two instants fall on the same day of this computer's calendar. */
export function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

export function validSchedule(repeat: ScheduleRepeat): boolean {
  if (repeat.kind === 'hours') return Number.isInteger(repeat.every) && repeat.every >= 1 && repeat.every <= 24;
  if (!TIME.test(repeat.at)) return false;
  return repeat.kind !== 'weekly' || (Number.isInteger(repeat.day) && repeat.day >= 0 && repeat.day <= 6);
}

/** The instant of a local wall-clock time on a day, or the first minute after it when a clock change skips it. */
function localTime(year: number, month: number, day: number, hours: number, minutes: number): number {
  let time = new Date(year, month, day, hours, minutes).getTime();
  const wanted = hours * 60 + minutes;
  const clock = (instant: number) => { const d = new Date(instant); return d.getDate() === day ? d.getHours() * 60 + d.getMinutes() : -1; };
  // Inside a skipped hour the engine moves the time forward by the gap (02:30 → 03:30); walk back
  // to the first minute that exists after it (03:00). Outside a gap this loop does not run.
  if (clock(time) !== wanted) while (clock(time - 60_000) > wanted) time -= 60_000;
  return time;
}

/** The first run strictly after `after`, or null when the schedule is paused or has ended. */
export function nextRunAfter(schedule: Schedule, after: number): number | null {
  if (schedule.paused) return null;
  const { repeat } = schedule;
  let next: number | null = null;
  if (repeat.kind === 'hours') {
    const step = repeat.every * HOUR_MS;
    next = schedule.createdAt + (Math.floor(Math.max(0, after - schedule.createdAt) / step) + 1) * step;
  } else {
    const [hours, minutes] = repeat.at.split(':').map(Number) as [number, number];
    const start = new Date(after);
    for (let offset = 0; offset <= 8 && next === null; offset++) {
      const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
      const weekday = day.getDay();
      if (repeat.kind === 'weekdays' && (weekday === 0 || weekday === 6)) continue;
      if (repeat.kind === 'weekly' && weekday !== repeat.day) continue;
      const candidate = localTime(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes);
      if (candidate > after) next = candidate;
    }
  }
  return next !== null && (schedule.until === null || next <= schedule.until) ? next : null;
}

/**
 * The run due now: the latest scheduled time after the last one sent and not after `now`, once,
 * however many were missed. Null when nothing is due (also when the clock went back).
 */
export function dueRun(schedule: Schedule, now: number): { dueAt: number; late: boolean } | null {
  if (schedule.paused) return null;
  // An ended schedule sends nothing, not even a run it missed before its end: a late message for a
  // schedule the person let run out would only surprise them.
  if (schedule.until !== null && now > schedule.until + SCHEDULE_ON_TIME_MS) return null;
  let from = schedule.lastDueAt ?? schedule.createdAt;
  let latest: number | null = null;
  // A year of hourly runs is under 9,000 steps; the bound only guards against a broken clock.
  for (let step = 0; step < 100_000; step++) {
    const next = nextRunAfter(schedule, from);
    if (next === null || next > now) break;
    latest = next; from = next;
  }
  return latest === null ? null : { dueAt: latest, late: now - latest > SCHEDULE_ON_TIME_MS };
}
