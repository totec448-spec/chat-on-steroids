import { expect, it } from 'vitest';
// @ts-expect-error The helper is a plain Node script without type declarations.
import { decide as decideAction } from '../scripts/waiting-prs.mjs';

type Event = { at: string; by: 'author' | 'maintainer' | 'checks' | 'reminder' };
const decide = decideAction as (events: Event[], now: number) => 'remind' | 'close' | null;
const day = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 86_400_000).toISOString();
const at = (n: number) => Date.parse(day(n));

it('reminds once after three quiet days since a review, and closes three days after the reminder', () => {
  const events: Event[] = [{ at: day(0), by: 'author' }, { at: day(1), by: 'maintainer' }];
  expect(decide(events, at(3.9))).toBeNull();
  expect(decide(events, at(4))).toBe('remind');
  events.push({ at: day(4), by: 'reminder' });
  expect(decide(events, at(6.9))).toBeNull();
  expect(decide(events, at(7))).toBe('close');
});

it('treats failed checks like a review, and any push or reply from the author as an answer', () => {
  expect(decide([{ at: day(0), by: 'author' }, { at: day(0.5), by: 'checks' }], at(3.4))).toBeNull();
  expect(decide([{ at: day(0), by: 'author' }, { at: day(0.5), by: 'checks' }], at(3.5))).toBe('remind');
  const answered: Event[] = [{ at: day(0), by: 'author' }, { at: day(1), by: 'maintainer' }, { at: day(11), by: 'reminder' }, { at: day(12), by: 'author' }];
  expect(decide(answered, at(30))).toBeNull();
});

it('leaves a PR alone that nobody has asked anything of', () => {
  expect(decide([{ at: day(0), by: 'author' }], at(60))).toBeNull();
});

it('starts over when a maintainer asks again after the reminder', () => {
  const events: Event[] = [{ at: day(0), by: 'author' }, { at: day(1), by: 'maintainer' }, { at: day(11), by: 'reminder' },
    { at: day(12), by: 'author' }, { at: day(13), by: 'maintainer' }];
  expect(decide(events, at(15.9))).toBeNull();
  expect(decide(events, at(16))).toBe('remind');
});

// A red PR the not-ready bot turned into a draft still waits on its author; other drafts do not.
// @ts-expect-error The script is plain Node without type declarations.
import { watched as isWatched } from '../scripts/waiting-prs.mjs';
const watched = isWatched as (pr: { draft: boolean; author_association: string; user: { type: string }; labels?: Array<{ name: string }> }) => boolean;

it('watches drafts the not-ready bot made, and still skips other drafts, maintainers and bots', () => {
  const pr = { draft: false, author_association: 'CONTRIBUTOR', user: { type: 'User' }, labels: [] as Array<{ name: string }> };
  expect(watched(pr)).toBe(true);
  expect(watched({ ...pr, draft: true })).toBe(false);
  expect(watched({ ...pr, draft: true, labels: [{ name: 'not-ready' }] })).toBe(true);
  expect(watched({ ...pr, author_association: 'OWNER' })).toBe(false);
  expect(watched({ ...pr, user: { type: 'Bot' } })).toBe(false);
});
