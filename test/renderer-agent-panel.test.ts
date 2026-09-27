import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgentPanel } from '../src/renderer/agent-panel.js';
import type { SessionSummary } from '../src/shared/session.js';

let dom: JSDOM;
afterEach(() => dom?.window.close());
it('keeps Prime selection independent and rejects late results after parent navigation', async () => {
  dom = new JSDOM('<main></main><button></button>');
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!;
  const toggle = document.querySelector('button')!;
  let resolve!: (value: { events: [] }) => void;
  const load = vi.fn(() => new Promise<{ events: [] }>(done => { resolve = done; }));
  const render = vi.fn(() => [document.createElement('article')]);
  const openMain = vi.fn();
  const panel = createAgentPanel({ host, toggle, load, render, openMain, working: () => false });
  const worker = { id: 'worker-session', title: 'Worker', updatedAt: 1 } as SessionSummary;
  panel.update('prime-session', [worker]); toggle.click();
  expect(host.textContent).toContain('History · 1');
  // A worker with no conversation or model yet still gets its row (undefined === undefined once threw here).
  expect(host.querySelectorAll('.agent-panel-row')).toHaveLength(1);
  const opening = panel.open(worker.id);
  expect(openMain).not.toHaveBeenCalled();
  panel.update('another-prime', []);
  resolve({ events: [] }); await opening;
  expect(render).not.toHaveBeenCalled();
  expect(host.querySelector('aside')!.hidden).toBe(true);
  await panel.open(worker.id);
  expect(load).toHaveBeenCalledTimes(1);
});

it('renders a selected worker and offers an explicit full-chat navigation', async () => {
  dom = new JSDOM('<main></main><button></button>');
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!, toggle = document.querySelector('button')!;
  const openMain = vi.fn();
  const panel = createAgentPanel({ host, toggle, load: async () => ({ events: [] }),
    render: () => { const p = document.createElement('p'); p.textContent = 'Recorded response'; return [p]; }, openMain, working: () => true });
  panel.update('prime', [{ id: 'worker', title: 'Worker', updatedAt: 1 } as SessionSummary]);
  await panel.open('worker');
  expect(host.textContent).toContain('Recorded response');
  expect(openMain).not.toHaveBeenCalled();
  [...host.querySelectorAll('button')].find(button => button.textContent === 'Open full chat')!.click();
  expect(openMain).toHaveBeenCalledWith('worker');
  expect(host.querySelector('aside')!.hidden).toBe(true);
});

it('keeps the back button title and accessible label synchronized with language changes', async () => {
  dom = new JSDOM('<main></main><button></button>', { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
  const host = document.querySelector('main')!, toggle = document.querySelector('button')!;
  createAgentPanel({ host, toggle, load: async () => ({ events: [] }), render: () => [], openMain: vi.fn(), working: () => false });
  const back = host.querySelector<HTMLButtonElement>('.agent-panel-header button')!;
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('tr');
  expect(back.title).toBe('Yardımcı ajanlara dön');
  expect(back.getAttribute('aria-label')).toBe('Yardımcı ajanlara dön');
  setLanguage('fr');
  expect(back.title).toBe('Retour aux sous-agents');
  expect(back.getAttribute('aria-label')).toBe('Retour aux sous-agents');
  setLanguage('en');
});

it('preserves a readers scroll position during refresh and Escape returns focus', async () => {
  dom = new JSDOM('<main></main><button></button>', { pretendToBeVisual: true });
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!, toggle = document.querySelector('button')!;
  let resolve!: (value: { events: [] }) => void;
  const load = vi.fn().mockResolvedValueOnce({ events: [] }).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const panel = createAgentPanel({ host, toggle, load, render: () => [document.createElement('article')], openMain: vi.fn(), working: () => false });
  const worker = { id: 'worker', title: 'Worker', updatedAt: 1 } as SessionSummary;
  panel.update('prime', [worker]); await panel.open(worker.id);
  const body = host.querySelector<HTMLElement>('.agent-panel-body')!;
  Object.defineProperties(body, { scrollHeight: { value: 1000 }, clientHeight: { value: 100 } });
  body.scrollTop = 250;
  const article = body.querySelector('article');
  panel.update('prime', [{ ...worker, updatedAt: 2 }]);
  expect(body.querySelector('article')).toBe(article);
  resolve({ events: [] }); await Promise.resolve(); await Promise.resolve();
  expect(body.scrollTop).toBe(250);
  body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(host.querySelector('aside')!.hidden).toBe(true);
  expect(document.activeElement).toBe(toggle);
});

it('shows the worker task and only a model observed for its current conversation', () => {
  dom = new JSDOM('<main></main><button></button>');
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!, toggle = document.querySelector('button')!;
  const panel = createAgentPanel({ host, toggle, load: async () => ({ events: [] }), render: () => [], openMain: vi.fn(), working: () => true });
  panel.update('prime', [{ id: 'worker', title: 'worker-4 · Shared context…', conversationId: 'chat-b',
    startedAt: Date.now() - 90_000, updatedAt: Date.now(), origin: { kind: 'worker', fromSessionId: 'prime', agentId: 'worker-4', task: 'Audit and verify the build' },
    selectedModel: { conversationId: 'chat-b', model: 'gpt-5.6-sol', reasoningEffort: 'high', observedAt: Date.now() } } as SessionSummary]);
  toggle.click();
  const card = host.querySelector<HTMLElement>('.agent-panel-row')!;
  expect(card.querySelector('.agent-card-name')!.textContent).toBe('worker-4');
  expect(card.querySelector('.agent-card-task')!.textContent).toBe('Original assignment: Audit and verify the build');
  expect(card.querySelector('.agent-card-model')!.textContent).toContain('gpt-5.6-sol');
  expect(card.dataset.state).toBe('working');
});

it('uses the exact broker worker state and reused assignment over stale session metadata', () => {
  dom = new JSDOM('<main></main><button></button>');
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!, toggle = document.querySelector('button')!;
  const panel = createAgentPanel({ host, toggle, load: async () => ({ events: [] }), render: () => [], openMain: vi.fn(),
    working: () => false, agent: () => ({ state: 'failed', task: 'Review the final package' }) });
  panel.update('prime', [{ id: 'worker', title: 'worker-2 · Original work', conversationId: 'chat',
    startedAt: Date.now() - 30_000, updatedAt: Date.now(), endedAt: null,
    origin: { kind: 'worker', fromSessionId: 'prime', agentId: 'worker-2', task: 'Original work' } } as SessionSummary]);
  toggle.click();
  const card = host.querySelector<HTMLElement>('.agent-panel-row')!;
  expect(card.dataset.state).toBe('failed');
  expect(card.querySelector('.agent-card-task')!.textContent).toBe('Review the final package');
  expect(host.textContent).toContain('History · 1');
});

it('groups a failed broker worker under History even with recent session activity', () => {
  dom = new JSDOM('<main></main><button></button>');
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!, toggle = document.querySelector('button')!;
  const panel = createAgentPanel({ host, toggle, load: async () => ({ events: [] }), render: () => [], openMain: vi.fn(),
    working: () => true, agent: () => ({ state: 'failed', task: 'Review the final package' }) });
  panel.update('prime', [{ id: 'worker', title: 'worker-2', conversationId: 'chat', startedAt: Date.now() - 1000,
    updatedAt: Date.now(), origin: { kind: 'worker', fromSessionId: 'prime', agentId: 'worker-2', task: 'Review' } } as SessionSummary]);
  toggle.click();
  expect(host.textContent).toContain('Active · 0');
  expect(host.textContent).toContain('History · 1');
});
