import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgentPanel } from '../src/renderer/agent-panel.js';
import type { SessionSummary } from '../src/shared/session.js';

let dom: JSDOM;
afterEach(() => dom?.window.close());
const worker = (id = 'worker-session', chat = 'chat-a') => ({ id, title: 'Worker', updatedAt: 1, startedAt: 0, conversationId: chat,
  origin: { kind: 'worker', fromSessionId: 'prime', agentId: 'worker-1', task: 'Audit the build' } }) as SessionSummary;
function setup(over: Partial<Parameters<typeof createAgentPanel>[0]> = {}) {
  dom = new JSDOM('<main><section></section></main><button></button>', { url: 'https://local.test/' });
  Object.assign(globalThis, { document: dom.window.document, window: dom.window, Node: dom.window.Node });
  const host = document.querySelector('main')!, mount = document.querySelector('section')!, toggle = document.querySelector('button')!;
  const openMain = vi.fn(), render = vi.fn(() => [document.createElement('article')]);
  const panel = createAgentPanel({ host, mount, toggle, load: async () => ({ events: [] }), render, openMain, working: () => false, ...over });
  const pane = mount.querySelector<HTMLDetailsElement>('.agent-panel')!;
  return { panel, host, mount, toggle, pane, openMain, render };
}
it('keeps worker inspection inline and independent of the prime selection', async () => {
  const { panel, host, mount, pane, openMain, render } = setup();
  panel.update('prime', [worker()]); expect(mount.hidden).toBe(false); expect(pane.open).toBe(false);
  await panel.open('worker-session');
  expect(pane.open).toBe(true); expect(openMain).not.toHaveBeenCalled();
  expect(host.classList.contains('has-agent-panel')).toBe(false);
  expect(render).not.toHaveBeenCalled(); // Transcript materializes only on explicit inspection.
  const report = host.querySelector<HTMLDetailsElement>('.worker-report')!;
  report.open = true; report.dispatchEvent(new dom.window.Event('toggle'));
  expect(render).toHaveBeenCalledOnce();
  host.querySelector<HTMLButtonElement>('.agent-chat-open')!.click();
  expect(openMain).toHaveBeenCalledWith('worker-session');
});
it('fences a delayed worker read across prime A → B → A', async () => {
  let resolve!: (value: { events: [] }) => void;
  const { panel, render, pane } = setup({ load: () => new Promise(done => { resolve = done; }) });
  panel.update('prime', [worker()]); const opening = panel.open('worker-session');
  panel.update('other-prime', []); panel.update('prime', [worker()]);
  resolve({ events: [] }); await opening;
  expect(render).not.toHaveBeenCalled(); expect(pane.open).toBe(false);
  expect(pane.querySelector('.worker-report')).toBeNull();
});
it('never borrows model or broker status from a reused short worker id', () => {
  const { panel, pane } = setup();
  panel.update('prime', [{ ...worker(), selectedModel: { conversationId: 'old-chat', model: 'old-model', observedAt: 1 } }]);
  expect(pane.querySelector('.agent-card-model')!.textContent).toBe('');
  expect(pane.querySelector('.agent-panel-row')!.getAttribute('data-state')).toBe('history');
});
it('shows exact broker status and current assignment over recent session activity', () => {
  const { panel, pane } = setup({ working: () => true, agent: () => ({ state: 'failed', task: 'Verify package', conversationId: 'chat-a' }) });
  panel.update('prime', [worker()]);
  const card = pane.querySelector<HTMLElement>('.agent-panel-row')!;
  expect(card.dataset.state).toBe('failed'); expect(card.querySelector('.agent-card-task')!.textContent).toBe('Verify package');
});
it('retains worker cards and disclosure through activity repaints and removes retired workers', async () => {
  const { panel, pane, mount } = setup(); panel.update('prime', [worker()]); await panel.open('worker-session');
  const card = pane.querySelector<HTMLDetailsElement>('.agent-panel-row')!;
  panel.update('prime', [{ ...worker(), updatedAt: 2 }]); await Promise.resolve();
  expect(pane.querySelector('.agent-panel-row')).toBe(card); expect(card.open).toBe(true);
  panel.update('prime', []); expect(mount.hidden).toBe(true); expect(pane.querySelector('.agent-panel-row')).toBeNull();
});
it('collapses inline inspection with Escape and restores composer focus through its owner', async () => {
  const onEscape = vi.fn(); const { panel, pane } = setup({ onEscape });
  panel.update('prime', [worker()]); await panel.open('worker-session');
  pane.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(pane.open).toBe(false); expect(onEscape).toHaveBeenCalledOnce();
});
it('exports only a completed worker answer using its exact session and turn', async () => {
  const exportMarkdown = vi.fn(async () => ({ ok: true, data: { done: 'saved' } }));
  const events = [{ kind: 'assistant_message', seq: 1, time: 1, source: 'extension', turnId: 'turn-a', message: { text: 'Verified', chars: 8, truncated: false }, final: true },
    { kind: 'turn_end', seq: 2, time: 2, source: 'extension', turnId: 'turn-a', outcome: 'completed' }] as any;
  const { panel, pane } = setup({ load: async () => ({ events }) });
  (dom.window as any).api = { exportMarkdown };
  panel.update('prime', [worker()]); await panel.open('worker-session');
  const save = pane.querySelector<HTMLButtonElement>('button.artifact-chip')!;
  expect(save.textContent).toContain('worker-1-report.md'); save.click();
  expect(exportMarkdown).toHaveBeenCalledWith({ id: 'worker-session', turnId: 'turn-a', scope: 'answer', target: 'file' });
});
it('does not offer a report download for interim prose or a failed turn', async () => {
  const { panel, pane } = setup({ load: async () => ({ events: [{ kind: 'assistant_message', seq: 1, time: 1, source: 'extension', turnId: 'turn-a', message: { text: 'Working', chars: 7, truncated: false }, state: 'streaming', final: false },
    { kind: 'turn_end', seq: 2, time: 2, source: 'extension', turnId: 'turn-a', outcome: 'failed' }] }) });
  panel.update('prime', [worker()]); await panel.open('worker-session');
  expect(pane.querySelector('button.artifact-chip')).toBeNull();
});

it('preserves the dock visibility owner across worker repaints and shows an empty history', () => {
  const { panel, mount, pane } = setup({ inline: false });
  mount.hidden = true;
  panel.update('prime', []);
  expect(mount.hidden).toBe(true);
  panel.show();
  expect(pane.open).toBe(true);
  expect(pane.textContent).toContain('No recorded sub-agents');
  panel.update('prime', [worker()]);
  expect(mount.hidden).toBe(true);
  expect(pane.querySelector('.agent-panel-empty')).toBeNull();
  expect(pane.querySelectorAll('.agent-panel-row')).toHaveLength(1);
});
