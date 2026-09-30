import { expect, it } from 'vitest';
// @ts-expect-error The helper is a plain Node script without type declarations.
import { decide as decideAction } from '../scripts/waiting-prs.mjs';

type Event = { at: string; by: 'author' | 'maintainer' | 'checks' | 'reminder' };
const decide = decideAction as (events: Event[], now: number) => 'remind' | 'close' | null;
const day = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 86_400_000).toISOString();
const at = (n: number) => Date.parse(day(n));

it('reminds once after ten quiet days since a review, and closes a week after the reminder', () => {
  const events: Event[] = [{ at: day(0), by: 'author' }, { at: day(1), by: 'maintainer' }];
  expect(decide(events, at(10))).toBeNull();
  expect(decide(events, at(11))).toBe('remind');
  events.push({ at: day(11), by: 'reminder' });
  expect(decide(events, at(17))).toBeNull();
  expect(decide(events, at(18))).toBe('close');
});

it('treats failed checks like a review, and any push or reply from the author as an answer', () => {
  expect(decide([{ at: day(0), by: 'author' }, { at: day(0.5), by: 'checks' }], at(11))).toBe('remind');
  const answered: Event[] = [{ at: day(0), by: 'author' }, { at: day(1), by: 'maintainer' }, { at: day(11), by: 'reminder' }, { at: day(12), by: 'author' }];
  expect(decide(answered, at(30))).toBeNull();
});

it('leaves a PR alone that nobody has asked anything of', () => {
  expect(decide([{ at: day(0), by: 'author' }], at(60))).toBeNull();
});

it('starts over when a maintainer asks again after the reminder', () => {
  const events: Event[] = [{ at: day(0), by: 'author' }, { at: day(1), by: 'maintainer' }, { at: day(11), by: 'reminder' },
    { at: day(12), by: 'author' }, { at: day(13), by: 'maintainer' }];
  expect(decide(events, at(20))).toBeNull();
  expect(decide(events, at(23))).toBe('remind');
});
