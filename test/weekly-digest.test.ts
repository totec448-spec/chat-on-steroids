import { expect, it } from 'vitest';
// @ts-expect-error The digest is a plain Node script without type declarations.
import { checksState as checks, digest as build, prState as state } from '../scripts/weekly-digest.mjs';

type Row = { number: number; title: string; by?: string; state: string };
type CheckRun = { id: number; name: string; status: string; conclusion: string | null; app?: { id: number } };
const checksState = checks as (runs: CheckRun[]) => string;
const prState = state as (input: { checks: string; lastPushAt: string; lastMaintainerAt?: string }) => string | null;
const digest = build as (input: { date: string; prs: Row[]; issues: Row[] }) => string;

it('sorts contributor PRs into waiting for a review or waiting for their author', () => {
  expect(prState({ checks: 'success', lastPushAt: '2026-10-02T00:00:00Z' })).toBe('review');
  expect(prState({ checks: 'success', lastPushAt: '2026-10-02T00:00:00Z', lastMaintainerAt: '2026-10-01T00:00:00Z' })).toBe('review');
  expect(prState({ checks: 'success', lastPushAt: '2026-10-02T00:00:00Z', lastMaintainerAt: '2026-10-03T00:00:00Z' })).toBe('author');
  expect(prState({ checks: 'failure', lastPushAt: '2026-10-02T00:00:00Z' })).toBe('author');
  expect(prState({ checks: 'pending', lastPushAt: '2026-10-02T00:00:00Z' })).toBeNull();
});

it('counts only the latest run of each check', () => {
  expect(checksState([
    { id: 1, name: 'PR checklist', status: 'completed', conclusion: 'failure' },
    { id: 2, name: 'PR checklist', status: 'completed', conclusion: 'success' }
  ])).toBe('success');
  expect(checksState([
    { id: 1, name: 'PR checklist', status: 'completed', conclusion: 'success' },
    { id: 2, name: 'PR checklist', status: 'completed', conclusion: 'failure' }
  ])).toBe('failure');
  expect(checksState([
    { id: 1, name: 'PR checklist', status: 'in_progress', conclusion: null },
    { id: 2, name: 'PR checklist', status: 'completed', conclusion: 'success' }
  ])).toBe('success');
  expect(checksState([
    { id: 1, name: 'PR checklist', status: 'completed', conclusion: 'success' },
    { id: 2, name: 'build', status: 'in_progress', conclusion: null }
  ])).toBe('pending');
  expect(checksState([
    { id: 1, name: 'PR checklist', status: 'completed', conclusion: 'failure' },
    { id: 2, name: 'PR checklist', status: 'completed', conclusion: 'cancelled' }
  ])).toBe('failure');
  expect(checksState([
    { id: 1, name: 'PR checklist', status: 'completed', conclusion: 'failure' },
    { id: 2, name: 'PR checklist', status: 'completed', conclusion: 'skipped' }
  ])).toBe('success');
});

it('keeps the latest run per app when two apps report the same check name', () => {
  expect(checksState([
    { id: 1, name: 'build', status: 'completed', conclusion: 'failure', app: { id: 1 } },
    { id: 2, name: 'build', status: 'completed', conclusion: 'success', app: { id: 2 } }
  ])).toBe('failure');
});

it('writes every section, saying so when one is empty', () => {
  const text = digest({ date: '2026-10-05', prs: [{ number: 774, title: 'Live row', by: 'Haz4rdovisk', state: 'review' }],
    issues: [{ number: 820, title: 'Stream recovery polling timed out', by: 'mahadansar', state: 'unanswered' }] });
  expect(text).toContain('### Green and waiting for a review\n\n- #774 Live row (@Haz4rdovisk)');
  expect(text).toContain('### Waiting for their authors\n\nNothing right now.');
  expect(text).toContain('### New issues without an answer yet\n\n- #820 Stream recovery polling timed out (@mahadansar)');
  expect(text).toContain('### Waiting for their reporters (needs-info)\n\nNothing right now.');
});
