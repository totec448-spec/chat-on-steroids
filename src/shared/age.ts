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

/**
 * A duration in the largest units that fit, at most `parts` of them, with the compact English
 * letters the app shows beside a clock: "45s", "4m 5s", "6h 12m", "3d 4h" (two parts) or "2d"
 * (one). Hours stop at a day, so a long run never reads "50h". A bad clock reads "0s".
 */
export function elapsedText(totalSeconds: number, parts: 1 | 2): string {
  const TOKEN: Record<AgeUnit, string> = { second: 's', minute: 'm', hour: 'h', day: 'd', week: 'w', month: 'mo', year: 'y' };
  return elapsedParts(totalSeconds, parts).map(([value, unit]) => `${value}${TOKEN[unit]}`).join(' ');
}

/** The units of an elapsed time, largest first ("3d 4h" is [[3, 'day'], [4, 'hour']]); the renderer words them. */
export function elapsedParts(totalSeconds: number, parts: 1 | 2): Array<[number, AgeUnit]> {
  const seconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const units: Array<[number, AgeUnit]> = [[Math.floor(seconds / 86_400), 'day'], [Math.floor(seconds / 3600) % 24, 'hour'],
    [Math.floor(seconds / 60) % 60, 'minute'], [seconds % 60, 'second']];
  const first = units.findIndex(([value]) => value > 0);
  return first === -1 ? [[0, 'second']] : units.slice(first, first + parts);
}

/** A countdown as a clock: "2:05", and from an hour on "2:05:30" (never "125:30"). */
export function countdownClock(totalSeconds: number): string {
  const seconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.ceil(totalSeconds)) : 0;
  const hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60), rest = String(seconds % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

const SPOKEN: Record<AgeUnit, string> = { second: 's', minute: 'min', hour: 'h', day: 'd', week: 'wk', month: 'mo', year: 'yr' };

/**
 * An age in plain English with spaced units, for Diagnostics and the texts the model reads:
 * "just now", "1 min ago", "7 min ago", "3 h ago", "2 d ago", "3 wk ago", "4 mo ago", "2 yr ago".
 */
export function spokenAge(atMs: number, nowMs: number): string {
  const age = ageOf(atMs, nowMs);
  if (!age || (age.unit === 'second' && age.value < 30)) return 'just now';
  return age.unit === 'second' ? '1 min ago' : `${age.value} ${SPOKEN[age.unit]} ago`;
}

/** A duration in plain English with spaced units, at most two: "45 s", "3 h 2 min", "2 d 3 h". */
export function spokenDuration(totalSeconds: number): string {
  return elapsedText(totalSeconds, 2).replace(/(\d+)([dhms])\b/g, (_, value: string, unit: string) =>
    `${value} ${({ d: 'd', h: 'h', m: 'min', s: 's' } as Record<string, string>)[unit]}`);
}

/** One decimal under ten, whole numbers up to the next unit, then that unit: never "1000k". */
function scaled(value: number, base: number, units: readonly string[], separator: string): string {
  let index = 0, scaledValue = value;
  for (;;) {
    const shown = scaledValue < 9.95 ? scaledValue.toFixed(1) : String(Math.round(scaledValue));
    if (Number(shown) < base || index === units.length - 1) return `${shown}${separator}${units[index]}`;
    scaledValue /= base; index++;
  }
}

/** A count in a few characters: "999", "1.0k", "12k", "1.3M", "2.0B"; anything not a count reads "0". */
export function compactCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0';
  if (value < 1000) return String(Math.round(value));
  return scaled(value / 1000, 1000, ['k', 'M', 'B', 'T'], '');
}

/** A file size: "1023 B", "1.0 KB", "10 KB", "1.0 MB", "2.0 GB", "3.0 TB"; anything not a size reads "0 B". */
export function byteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  return scaled(bytes / 1024, 1024, ['KB', 'MB', 'GB', 'TB'], ' ');
}
