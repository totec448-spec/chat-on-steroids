// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { dateSection, dateSections } from '../src/renderer/date-sections.js';
import { setLanguage } from '../src/renderer/i18n.js';

afterEach(() => setLanguage('en'));

// Local times, so the test means the same on every machine's time zone.
const now = new Date(2026, 9, 31, 9, 30).getTime();
const at = (month: number, day: number, hour = 12, year = 2026) => new Date(year, month, day, hour).getTime();
const label = (time: number) => dateSection(time, now).label();

it('names today, yesterday, the last week and month, then months of this year, then years (#1919)', () => {
  expect(label(at(9, 31, 0))).toBe('Today');
  expect(label(at(9, 30, 23))).toBe('Yesterday');
  expect(label(at(9, 25))).toBe('Previous 7 days');
  expect(label(at(9, 24))).toBe('Previous 30 days');
  expect(label(at(9, 2))).toBe('Previous 30 days');
  expect(label(at(9, 1))).toBe('October');
  expect(label(at(0, 3))).toBe('January');
  expect(label(at(11, 31, 12, 2025))).toBe('2025');
  expect(label(at(5, 1, 12, 2019))).toBe('2019');
  // A time ahead of this computer's clock (another device) is today, never a future section.
  expect(label(now + 3 * 86_400_000)).toBe('Today');
});

it('counts calendar days across a daylight-saving change (#1919)', () => {
  // 25 or 23 hours apart around a change still makes exactly one day.
  const late = new Date(2026, 2, 30, 0, 30).getTime();
  expect(dateSection(new Date(2026, 2, 29, 23, 30).getTime(), late).label()).toBe('Yesterday');
  expect(dateSection(new Date(2026, 2, 28, 0, 30).getTime(), late).label()).toBe('Previous 7 days');
});

it('follows the app language for its names and months (#1919)', () => {
  setLanguage('de');
  expect(label(at(9, 31))).toBe('Heute');
  expect(label(at(1, 3))).toBe('Februar');
});

it('heads each section once, and keeps a chat the person moved up under the heading before it (#1919)', () => {
  const next = dateSections(now);
  const shown = [at(9, 31), at(9, 31), at(6, 1), at(9, 30), at(9, 20), at(3, 2, 12, 2024)].map(time => next(time)?.label() ?? null);
  // The July chat dragged above yesterday's: July's heading, then no Yesterday after it.
  expect(shown).toEqual(['Today', null, 'July', null, null, '2024']);
});
