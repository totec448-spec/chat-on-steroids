import { expect, it } from 'vitest';
// @ts-expect-error The finder is a plain Node script without type declarations.
import { commentFor as comment, similarIssues as similar, similarity as score } from '../scripts/similar-issues.mjs';

type Issue = { number: number; title: string; state?: string; pull_request?: object };
const similarity = score as (a: string, b: string) => number;
const similarIssues = similar as (issue: Issue, candidates: Issue[]) => Issue[];
const commentFor = comment as (matches: Issue[]) => string;

it('finds a real duplicate from real 2026 titles and ignores issues that only share a topic', () => {
  const issue = { number: 900, title: 'Compact & Resume shows the source chat\'s reload note above the first message' };
  const candidates: Issue[] = [
    { number: 805, title: 'Compact & resume shows the source chat\'s reload note above the new chat\'s first message', state: 'closed' },
    { number: 787, title: 'Compact & Resume can miss a remounted completed handoff and stay awaiting-summary' },
    { number: 339, title: 'Chrome companion 2.1.14 never connects: 127.0.0.1:8765 listening but no browser authorization' },
    { number: 900, title: 'itself' },
    { number: 806, title: 'Keep a source chat\'s reload note out of the chat Compact & resume opens', pull_request: {} }
  ];
  expect(similarIssues(issue, candidates).map(match => match.number)).toEqual([805]);
});

it('does not match titles that only share filler words or versions', () => {
  expect(similarity('[2.1.20] The chat is not working', '[2.1.14] The app is not working again')).toBe(0);
  expect(similarity('Goal says why it stopped', 'Goal says why it stopped')).toBe(1);
});

it('writes a gentle note that marks closed matches', () => {
  const text = commentFor([{ number: 805, title: 'Reload note in the new chat', state: 'closed' }]);
  expect(text).toContain('- #805 Reload note in the new chat (closed)');
  expect(text).toContain('just ignore this note');
});
