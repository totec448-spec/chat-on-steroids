import { expect, it } from 'vitest';
// @ts-expect-error The drafter is a plain Node script without type declarations.
import { draftReleaseNotes as draft, releaseNoteFor as noteFor } from '../scripts/draft-release-notes.mjs';

type Pr = { number: number; title: string; body?: string; closed_at: string; user: { login: string } };
const releaseNoteFor = noteFor as (pr: Pr) => string | null;
const draftReleaseNotes = draft as (input: { since: string; prs: Pr[] }) => string;
const pr = (number: number, title: string, body = '', login = 'someone', closed_at = `2026-10-0${number % 9 + 1}T00:00:00Z`): Pr =>
  ({ number, title, body, closed_at, user: { login } });

it('uses the optional Release note line, else the title, and leaves out "none"', () => {
  expect(releaseNoteFor(pr(1, 'Fix race in resume', 'Fixes #9\n\nRelease note: Compact & resume no longer stalls.\n'))).toBe('Compact & resume no longer stalls.');
  expect(releaseNoteFor(pr(2, 'Show the live activity row'))).toBe('Show the live activity row');
  expect(releaseNoteFor(pr(3, 'Refactor tests', 'release note: none'))).toBeNull();
});

it('drafts one line per merged PR, oldest first, without bots', () => {
  const text = draftReleaseNotes({ since: 'v2.1.21', prs: [
    pr(5, 'Second', '', 'lavalava45', '2026-10-05T00:00:00Z'),
    pr(4, 'First', 'Release note: The first thing users notice.', 'Haz4rdovisk', '2026-10-02T00:00:00Z'),
    pr(6, 'Bump deps', '', 'dependabot[bot]', '2026-10-03T00:00:00Z')
  ] });
  expect(text).toContain('## Draft: changes since v2.1.21');
  expect(text.split('\n').filter(line => line.startsWith('- '))).toEqual([
    '- The first thing users notice. (#4, @Haz4rdovisk)',
    '- Second (#5, @lavalava45)'
  ]);
});
