import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
// @ts-expect-error The bot is a plain Node script without type declarations.
import { NOT_READY_LABEL, NOT_READY_SINCE, notReadyDecision as decide, NOT_READY_COMMENT } from '../scripts/pr-not-ready.mjs';

type Pr = { draft: boolean; author_association: string; created_at: string; user: { type: string }; labels: Array<{ name: string }> };
const notReadyDecision = decide as (pr: Pr, conclusion: string) => 'draft' | 'clear' | 'none';
const pr = (extra: Partial<Pr> = {}): Pr =>
  ({ draft: false, author_association: 'CONTRIBUTOR', created_at: '2026-10-16T09:00:00Z', user: { type: 'User' }, labels: [], ...extra });

// 2026-10-15, user: a contributor PR whose CI or checklist fails goes back to draft, so no review
// is spent on it until the author makes it green and marks it ready again.
it('turns a new contributor PR with a failed run into a draft', () => {
  expect(Date.parse(NOT_READY_SINCE)).toBeLessThan(Date.parse('2026-10-16T09:00:00Z'));
  expect(notReadyDecision(pr(), 'failure')).toBe('draft');
  expect(notReadyDecision(pr(), 'success')).toBe('none');
  expect(notReadyDecision(pr(), 'cancelled')).toBe('none');
});

it('leaves drafts, maintainers, bots and PRs opened earlier alone', () => {
  expect(notReadyDecision(pr({ draft: true }), 'failure')).toBe('none');
  expect(notReadyDecision(pr({ author_association: 'COLLABORATOR' }), 'failure')).toBe('none');
  expect(notReadyDecision(pr({ user: { type: 'Bot' } }), 'failure')).toBe('none');
  expect(notReadyDecision(pr({ created_at: '2026-10-14T09:00:00Z' }), 'failure')).toBe('none');
});

it('drops its label once the author marked the PR ready and it passed', () => {
  expect(notReadyDecision(pr({ labels: [{ name: NOT_READY_LABEL }] }), 'success')).toBe('clear');
  expect(notReadyDecision(pr({ draft: true, labels: [{ name: NOT_READY_LABEL }] }), 'success')).toBe('none');
});

it('tells the author what to do and runs only from the base repository after CI and the checklist', () => {
  expect(NOT_READY_COMMENT).toContain('Ready for review');
  const workflow = readFileSync('.github/workflows/pr-not-ready.yml', 'utf8');
  expect(workflow).toContain('workflow_run');
  expect(workflow).toContain('workflows: [CI, PR checklist]');
  // Never runs the PR's own code with a write token.
  expect(workflow).not.toMatch(/ref:\s*\$\{\{\s*github\.event\.workflow_run\.head/);
});
