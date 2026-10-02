import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { createComposerContext } from '../src/renderer/composer-context.js';
import type { LocalProject } from '../src/shared/projects.js';
let dom: JSDOM;
afterEach(() => dom?.window.close());
function setup() {
  dom = new JSDOM('<div id="composerContext"><span id="composerWorkspaceName"></span><span id="composerBranch"></span><span id="composerGitStats"></span><button id="composerReview"></button><button id="composerContextDismiss"></button></div><button id="composerWorkspace"></button>');
  Object.assign(globalThis, { document: dom.window.document, window: dom.window });
  const requests: Array<(value: unknown) => void> = [];
  const getProjectGitSnapshot = vi.fn(() => new Promise(done => { requests.push(done); }));
  (dom.window as any).api = { getProjectGitSnapshot };
  const review = vi.fn(); return { context: createComposerContext(review), requests, review, getProjectGitSnapshot };
}
const project = (id: string) => ({ id, name: id, path: `/root/${id}` }) as LocalProject;
const reply = (id: string, branch: string, changes: any[] = [], truncated = false) => ({ ok: true, data: { projectId: id, state: 'ready', currentBranch: branch, changes, truncated } });
it('fences Git reads across A → B → A and never paints the old branch in a new owner', async () => {
  const { context, requests } = setup();
  context.update(project('a'), '1'); context.update(project('b'), '2'); context.update(project('a'), '3');
  requests[2]!(reply('a', 'latest')); await Promise.resolve();
  requests[0]!(reply('a', 'stale')); requests[1]!(reply('b', 'wrong')); await Promise.resolve();
  expect(document.getElementById('composerBranch')!.textContent).toBe('latest');
});
it('shows accurate Git deltas, keeps context dismissal local and opens the real Review action', async () => {
  const { context, requests, review } = setup(); context.update(project('a'), '1');
  requests[0]!(reply('a', 'main', [{ additions: 4, deletions: 2 }])); await Promise.resolve();
  expect(document.getElementById('composerGitStats')!.textContent).toBe('+4−2');
  document.getElementById('composerReview')!.click(); expect(review).toHaveBeenCalledOnce();
  document.getElementById('composerContextDismiss')!.click(); expect(document.getElementById('composerContext')!.hidden).toBe(true);
  context.update(project('b'), '2'); expect(document.getElementById('composerContext')!.hidden).toBe(false);
});
it('never labels partial or binary Git counts as exact line totals and hides projectless context', async () => {
  const { context, requests } = setup(); context.update(project('a'), '1');
  requests[0]!(reply('a', 'main', [{ additions: null, deletions: null }], true)); await Promise.resolve();
  expect(document.getElementById('composerGitStats')!.textContent).toBe('1+ changed files');
  context.update(null, '2'); expect(document.getElementById('composerContext')!.hidden).toBe(true);
  expect(document.getElementById('composerBranch')!.textContent).toBe('');
});
