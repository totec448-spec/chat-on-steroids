/** One unit of a relative age, the way a person would round it. */
export type AgeUnit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

/**
 * How long ago `atMs` was, as one unit and a whole number: seconds under 90, minutes under 90,
 * hours under a day, then days, weeks, months and years, never hundreds of hours (2.1.47 round).
 * `null` means just now (under 3 s); a clock skew into the future also reads as just now.
 */
export function ageOf(atMs: number, nowMs: number): { unit: AgeUnit; value: number } | null {
  // A time that is missing or not a number has no age; callers say "never" (it used to read "NaNh ago").
  if (!Number.isFinite(atMs) || !Number.isFinite(nowMs)) return null;
  const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (seconds < 3) return null;
  if (seconds < 90) return { unit: 'second', value: seconds };
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return { unit: 'minute', value: minutes };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { unit: 'hour', value: hours };
  const days = Math.round(hours / 24);
  if (days < 7) return { unit: 'day', value: days };
  if (days < 30) return { unit: 'week', value: Math.round(days / 7) };
  const months = Math.round(days / 30.44);
  if (months < 12) return { unit: 'month', value: months };
  return { unit: 'year', value: Math.max(1, Math.round(days / 365.25)) };
}

/** The compact English token for an age: "8s", "2m", "5h", "3d", "2w", "4mo", "1y". */
export const AGE_SUFFIX: Record<AgeUnit, string> = { second: 's', minute: 'm', hour: 'h', day: 'd', week: 'w', month: 'mo', year: 'y' };
