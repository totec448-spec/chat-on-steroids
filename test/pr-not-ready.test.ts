import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
// @ts-expect-error The bot is a plain Node script without type declarations.
import { NOT_READY_LABEL, NOT_READY_SINCE, notReadyDecision as decide, NOT_READY_COMMENT, NOT_READY_COMMENT_UNDRAFTED, applyNotReady as apply } from '../scripts/pr-not-ready.mjs';

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

type Call = { path: string; init?: { method?: string; body?: string } };
const applyNotReady = apply as (request: (path: string, init?: Call['init']) => Promise<unknown>, input: { repository: string; sha: string; pr: { number: number; node_id: string }; decision: string }) => Promise<string>;
const fake = (replies: Record<string, unknown>) => {
  const calls: Call[] = [];
  const request = async (path: string, init?: Call['init']) => { calls.push({ path, init }); return replies[path] ?? null; };
  return { calls, request };
};
const input = (decision: string) => ({ repository: 'o/r', sha: 'abc', pr: { number: 7, node_id: 'PR_7' }, decision });

// Live 2026-10-15/16, #1548: GraphQL answers HTTP 200 with an \`errors\` list when the conversion is
// refused, and the bot still said "this PR is a draft again" on a PR that never became one.
it('says draft only when GitHub confirms the conversion, and reports a refused one', async () => {
  const done = fake({ '/graphql': { data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } } });
  expect(await applyNotReady(done.request, input('draft'))).toBe('draft');
  expect(done.calls.map(call => call.path)).toEqual(['/graphql', '/repos/o/r/issues/7/labels', '/repos/o/r/issues/7/comments']);
  expect(JSON.parse(done.calls[2]!.init!.body!).body).toBe(NOT_READY_COMMENT);

  const refused = fake({ '/graphql': { data: { convertPullRequestToDraft: null }, errors: [{ message: 'Resource not accessible by integration' }] } });
  expect(await applyNotReady(refused.request, input('draft'))).toBe('labeled (draft refused: Resource not accessible by integration)');
  const comment = JSON.parse(refused.calls.at(-1)!.init!.body!).body as string;
  expect(comment).toBe(NOT_READY_COMMENT_UNDRAFTED);
  // It does not claim the PR is a draft already; the maintainer's job converts it shortly after.
  expect(comment).not.toMatch(/is a draft|draft again/i);
  expect(comment).toContain('Ready for review');
});

// Live: CI turned green while the checklist was still red, and the label came off.
it('keeps the label while any check on the same commit still fails', async () => {
  const red = fake({ '/repos/o/r/commits/abc/check-runs?per_page=100': { check_runs: [{ name: 'CI', conclusion: 'success' }, { name: 'PR checklist', conclusion: 'failure' }] } });
  expect(await applyNotReady(red.request, input('clear'))).toBe('kept (PR checklist still failing)');
  expect(red.calls.some(call => call.init?.method === 'DELETE')).toBe(false);
  const green = fake({ '/repos/o/r/commits/abc/check-runs?per_page=100': { check_runs: [{ name: 'CI', conclusion: 'success' }, { name: 'PR checklist', conclusion: 'success' }] } });
  expect(await applyNotReady(green.request, input('clear'))).toBe('clear');
  expect(green.calls.at(-1)).toMatchObject({ path: `/repos/o/r/issues/7/labels/${NOT_READY_LABEL}`, init: { method: 'DELETE' } });
});

it('converts with the optional draft token, since the workflow token never may', async () => {
  const labels = fake({});
  const drafts = fake({ '/graphql': { data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } } });
  expect(await (apply as any)(labels.request, input('draft'), drafts.request)).toBe('draft');
  expect(drafts.calls.map(call => call.path)).toEqual(['/graphql']);
  expect(labels.calls.map(call => call.path)).toEqual(['/repos/o/r/issues/7/labels', '/repos/o/r/issues/7/comments']);
  const workflow = readFileSync('.github/workflows/pr-not-ready.yml', 'utf8');
  expect(workflow).toContain('DRAFT_TOKEN: ${{ secrets.PR_DRAFT_TOKEN }}');
  expect(workflow).not.toMatch(/contents:\s*write/);
});

// Live 2026-10-16, #1558: CI and the checklist failed one after the other, each run reached the
// bot before the PR was a draft, and the author got the same comment twice.
it('comments once: a second failure on a labeled PR only retries the conversion', async () => {
  const labeled = pr({ labels: [{ name: NOT_READY_LABEL }] });
  expect(notReadyDecision(labeled, 'failure')).toBe('redraft');
  const drafts = fake({ '/graphql': { data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } } });
  expect(await applyNotReady(drafts.request, input('redraft'))).toBe('draft');
  expect(drafts.calls.map(call => call.path)).toEqual(['/graphql']);
  const refused = fake({ '/graphql': { errors: [{ message: 'Resource not accessible by integration' }] } });
  expect(await applyNotReady(refused.request, input('redraft'))).toBe('labeled (draft refused: Resource not accessible by integration)');
  expect(refused.calls.map(call => call.path)).toEqual(['/graphql']);
});
