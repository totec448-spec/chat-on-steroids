import { expect, it } from 'vitest';
import { ageOf, countdownClock, elapsedText } from '../src/shared/age.js';

/**
 * 2.1.47 round (the user): "389h ago". Every age, duration and countdown the app shows reads
 * naturally at every size, from seconds to years, and never runs one unit up into the hundreds.
 */
const minute = 60, hour = 3600, day = 86_400;

it('rounds an age to one natural unit at every size', () => {
  const now = 2_000_000_000_000;
  const at = (seconds: number) => ageOf(now - seconds * 1000, now);
  expect(at(1)).toBeNull();
  expect(at(-60)).toBeNull();
  expect(at(45)).toEqual({ unit: 'second', value: 45 });
  expect(at(89 * minute)).toEqual({ unit: 'minute', value: 89 });
  expect(at(23 * hour)).toEqual({ unit: 'hour', value: 23 });
  expect(at(day)).toEqual({ unit: 'day', value: 1 });
  expect(at(389 * hour)).toEqual({ unit: 'week', value: 2 });
  expect(at(45 * day)).toEqual({ unit: 'month', value: 1 });
  expect(at(360 * day)).toEqual({ unit: 'year', value: 1 });
  expect(at(900 * day)).toEqual({ unit: 'year', value: 2 });
});

it('says a duration in at most two units, from seconds to days', () => {
  expect(elapsedText(0, 2)).toBe('0s');
  expect(elapsedText(45, 2)).toBe('45s');
  expect(elapsedText(4 * minute + 5, 2)).toBe('4m 5s');
  expect(elapsedText(6 * hour + 12 * minute + 3, 2)).toBe('6h 12m');
  expect(elapsedText(3 * day + 4 * hour + 59 * minute, 2)).toBe('3d 4h');
  expect(elapsedText(400 * day, 2)).toBe('400d 0h');
  // One unit: the largest that fits, never "50h".
  expect([45, 4 * minute + 5, 6 * hour + 59 * minute, 50 * hour].map(seconds => elapsedText(seconds, 1))).toEqual(['45s', '4m', '6h', '2d']);
  // A bad clock never reads as a negative or broken duration.
  expect(elapsedText(-5, 2)).toBe('0s');
  expect(elapsedText(Number.NaN, 1)).toBe('0s');
});

it('counts down in minutes and seconds, and adds the hours from an hour on', () => {
  expect(countdownClock(0)).toBe('0:00');
  expect(countdownClock(125)).toBe('2:05');
  expect(countdownClock(59 * minute + 59)).toBe('59:59');
  expect(countdownClock(hour)).toBe('1:00:00');
  expect(countdownClock(2 * hour + 5 * minute + 30)).toBe('2:05:30');
  expect(countdownClock(-3)).toBe('0:00');
});

it('says ages and durations in plain English for Diagnostics and the model, up to years and days', async () => {
  const { spokenAge, spokenDuration } = await import('../src/shared/age.js');
  const now = 2_000_000_000_000, ago = (seconds: number) => spokenAge(now - seconds * 1000, now);
  expect([ago(5), ago(60), ago(7 * minute), ago(3 * hour), ago(2 * day), ago(389 * hour), ago(120 * day), ago(800 * day)])
    .toEqual(['just now', '1 min ago', '7 min ago', '3 h ago', '2 d ago', '2 wk ago', '4 mo ago', '2 yr ago']);
  expect([spokenDuration(45), spokenDuration(3 * hour + 2 * minute), spokenDuration(2 * day + 3 * hour + 40 * minute)])
    .toEqual(['45 s', '3 h 2 min', '2 d 3 h']);
});
