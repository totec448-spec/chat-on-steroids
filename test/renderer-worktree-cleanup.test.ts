/**
 * Worker checkout cleanup belongs to its own Settings section. The worker roster is
 * often empty after a run is cleared, but retained Git checkouts still need review.
 * jsdom cannot measure pixels, so layout checks guard the DOM and scroll owners.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { WorkerWorktreeCleanupOffer } from '../src/shared/session.js';

const html = readFileSync('src/renderer/index.html', 'utf8');
const styles = readFileSync('src/renderer/settings.css', 'utf8');
const chat = readFileSync('src/renderer/chat.ts', 'utf8');
let dom: JSDOM;
let paintWorktreeCleanupOffers: typeof import('../src/renderer/chat.js').paintWorktreeCleanupOffers;

beforeAll(async () => {
  dom = new JSDOM(html, { url: 'https://local.test/' });
  Object.defineProperty(dom.window, 'api', { value: {}, configurable: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element });
  ({ paintWorktreeCleanupOffers } = await import('../src/renderer/chat.js'));
});
afterAll(() => dom?.window.close());

function offer(changes: Partial<WorkerWorktreeCleanupOffer> = {}): WorkerWorktreeCleanupOffer {
  return { runId: 'f0ebc42e-c880-4701-971e-b1797e568883', agentId: 'worker-2',
    label: 'Review API', reason: 'completed', workspace: '/approved/managed/worker-2',
    dirty: false, ignoredFiles: false, uniqueCommits: false, changeCount: 0, ...changes };
}

it('keeps retained checkout cleanup in a separate Settings section after worker controls', () => {
  const document = new JSDOM(html).window.document;
  const workerList = document.querySelector('#swarmList')!;
  const clearWorkers = document.querySelector('#swarmReset')!;
  const cleanupHeading = [...document.querySelectorAll<HTMLElement>('.settings-section-head h2')]
    .find(node => node.textContent?.trim() === 'Worker checkouts');
  expect(cleanupHeading).toBeDefined();
  const cleanupSection = cleanupHeading!.closest('section')!;
  expect(cleanupSection.querySelector('.settings-surface')).not.toBeNull();
  expect(cleanupSection.contains(workerList)).toBe(false);
  expect(cleanupSection.contains(clearWorkers)).toBe(false);
  expect(cleanupSection.compareDocumentPosition(clearWorkers) & document.defaultView!.Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  const cleanupActions = [...cleanupSection.querySelectorAll('button')];
  expect(cleanupActions.map(button => button.id)).toContain('worktreeCleanupReview');
  expect(cleanupActions.some(button => button.textContent?.includes('Review checkouts'))).toBe(true);
  expect(cleanupSection.querySelector('#worktreeCleanupList')).not.toBeNull();
  expect(workerList.querySelector('[data-worktree-review], .worktree-cleanup-review')).toBeNull();
});

it('uses the Settings page scroller for the cleanup list without a nested scrolling pane', () => {
  const document = new JSDOM(html).window.document;
  const cleanupHeading = [...document.querySelectorAll<HTMLElement>('.settings-section-head h2')]
    .find(node => node.textContent?.trim() === 'Worker checkouts')!;
  const section = cleanupHeading.closest('section')!;
  expect(section.querySelector('[style*="overflow"], [style*="max-height"]')).toBeNull();
  // Its rows participate in normal Settings document flow. A second overflow-y:auto
  // or max-height:vh container would trap touch/wheel scrolling inside the list.
  const cleanupRules = styles.split(/(?<=\})/).filter(rule => /(?:worktree|cleanup)/i.test(rule.split('{')[0] ?? ''));
  expect(cleanupRules.join('\n')).not.toMatch(/overflow-y\s*:\s*(?:scroll|auto)/i);
  expect(cleanupRules.join('\n')).not.toMatch(/max-height\s*:\s*[^;]*(?:vh|px)/i);
});

it('renders empty state and replaces it when a retained checkout arrives', () => {
  const host = document.createElement('div');
  paintWorktreeCleanupOffers([], host);
  expect(host.querySelectorAll('.worktree-checkout-row')).toHaveLength(0);
  expect(host.textContent).toContain('No checkouts to remove');
  expect(host.textContent).toContain('Finished or cleared checkouts awaiting review will appear here.');
  paintWorktreeCleanupOffers([offer()], host);
  expect(host.querySelectorAll('.worktree-cleanup-empty')).toHaveLength(0);
  expect(host.querySelectorAll('.worktree-checkout-row')).toHaveLength(1);
});

it('shows a clean checkout with a named worker, safe state, and exact remove identity', () => {
  const host = document.createElement('div');
  paintWorktreeCleanupOffers([offer()], host);
  const row = host.querySelector<HTMLElement>('.worktree-checkout-row')!;
  expect(row.querySelector('.worktree-checkout-name')?.textContent).toBe('Review API');
  expect(row.querySelector('.worktree-checkout-name')?.getAttribute('title')).toBe('worker-2');
  expect(row.querySelector('.worktree-checkout-status')?.textContent).toBe('Finished');
  expect(row.querySelector('.worktree-clean-state')?.textContent).toBe('Nothing would be lost');
  expect(row.querySelectorAll('.worktree-risk')).toHaveLength(0);
  const remove = row.querySelector<HTMLButtonElement>('[data-worktree-remove]')!;
  expect(remove.type).toBe('button');
  expect(remove.classList.contains('btn-solid')).toBe(true);
  expect(remove.dataset.runId).toBe('f0ebc42e-c880-4701-971e-b1797e568883');
  expect(remove.dataset.agentId).toBe('worker-2');
  expect(remove.getAttribute('aria-label')).toContain('Review API');
});

it('keeps at-risk and branch-only changes distinct, and labels an older unnamed worker', () => {
  const host = document.createElement('div');
  paintWorktreeCleanupOffers([
    offer({ reason: 'failed', dirty: true, ignoredFiles: true, uniqueCommits: true, changeCount: 4 }),
    offer({ agentId: 'worker-7', label: undefined, reason: 'cleared', dirty: false, uniqueCommits: true })
  ], host);
  const [risky, committed] = host.querySelectorAll<HTMLElement>('.worktree-checkout-row');
  expect(risky).toBeDefined();
  expect(committed).toBeDefined();
  expect(risky!.querySelector('.worktree-checkout-status')?.textContent).toBe('Failed');
  expect([...risky!.querySelectorAll('.worktree-risk')].map(node => node.textContent)).toEqual(['4 uncommitted changes', 'Ignored files']);
  expect(risky!.querySelector('.worktree-commits')?.textContent).toBe('Commits only on this branch');
  expect(risky!.querySelector('.worktree-clean-state')).toBeNull();
  expect(committed!.querySelector('.worktree-checkout-name')?.textContent).toBe('Worker 7');
  expect(committed!.querySelector('.worktree-checkout-status')?.textContent).toBe('Cleared');
  expect(committed!.querySelector('.worktree-commits')?.textContent).toBe('Commits only on this branch');
  expect(committed!.querySelector('.worktree-clean-state')?.textContent).toBe('Nothing would be lost');
});

it('keeps the renderer wired to the existing cleanup IPC and main-owned confirmation', () => {
  expect(chat).toContain('api.listWorktreeCleanupOffers()');
  expect(chat).toContain('api.removeWorktreeCleanupOffer(runId, agentId)');
  expect(chat).toContain("t('Worker checkout kept.')");
  expect(chat).toContain("t('Worker checkout removed; its Git branch was preserved.')");
  // Confirmation is still in the main-process IPC handler, not a renderer-side
  // boolean that can bypass identity/approval checks.
  const ipc = readFileSync('src/main/ipc.ts', 'utf8');
  expect(ipc).toContain("handle('swarm:worktreeCleanupRemove'");
  expect(ipc).toContain('dialog.showMessageBox(');
  expect(ipc).toContain('if (response !== 1) return { removed: false, branchPreserved: true }');
});
