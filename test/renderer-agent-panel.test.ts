import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgentPanel } from '../src/renderer/agent-panel.js';
import type { SessionSummary } from '../src/shared/session.js';

let dom: JSDOM;
afterEach(() => dom?.window.close());

it('keeps inline disclosure and dock selections independent and loads only requested worker history', async () => {
  dom = new JSDOM('<main><section></section><aside></aside></main>');
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!, load = vi.fn().mockResolvedValue({ events: [] });
  const options = { host, load, render: () => {
    const p = document.createElement('p'); p.textContent = 'Recorded worker response'; return [p];
  }, openMain: vi.fn(), working: () => false };
  const inline = createAgentPanel({ ...options, mount: document.querySelector('section')!, inline: true });
  const dock = createAgentPanel({ ...options, mount: document.querySelector('aside')! });
  const worker = { id: 'worker', title: 'Worker', updatedAt: 1 } as SessionSummary;
  inline.update('prime', [worker]); dock.update('prime', [worker]);
  const card = host.querySelector<HTMLDetailsElement>('details')!;
  expect(card.hidden).toBe(false); expect(card.open).toBe(false);
  expect(card.querySelector('summary')!.textContent).toContain('Sub-agents · 1');
  expect(load).not.toHaveBeenCalled();
  card.open = true; card.dispatchEvent(new dom.window.Event('toggle'));
  expect(card.querySelectorAll('.agent-panel-row')).toHaveLength(1);
  await inline.open('worker'); dock.show();
  expect(card.textContent).toContain('Recorded worker response');
  expect(document.querySelector('aside .agent-panel-row')).not.toBeNull();
  expect(options.openMain).not.toHaveBeenCalled();
  inline.update('another-prime', []);
  expect(card.hidden).toBe(true); expect(card.open).toBe(false);
});

it.each(['collapse', 'empty', 'parent'] as const)('retires pending inline history across a %s and return to the same worker', async boundary => {
  dom = new JSDOM('<main><section></section></main>');
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!;
  let resolve!: (value: { events: [] }) => void;
  const load = vi.fn(() => new Promise<{ events: [] }>(done => { resolve = done; })), render = vi.fn(() => []);
  const panel = createAgentPanel({ host, mount: document.querySelector('section')!, inline: true, load, render, openMain: vi.fn(), working: () => false });
  const worker = { id: 'worker', title: 'Worker', updatedAt: 1 } as SessionSummary;
  panel.update('prime', [worker]);
  const pending = panel.open('worker');
  const card = host.querySelector<HTMLDetailsElement>('details')!;
  if (boundary === 'collapse') { card.open = false; card.dispatchEvent(new dom.window.Event('toggle')); }
  else panel.update(boundary === 'empty' ? 'prime' : 'another-prime', []);
  panel.update('prime', [worker]); card.open = true; card.dispatchEvent(new dom.window.Event('toggle'));
  resolve({ events: [] }); await pending;
  expect(render).not.toHaveBeenCalled();
  expect(card.querySelectorAll('.agent-panel-row')).toHaveLength(1);
});
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
  expect(host.textContent).not.toContain('0 failed');
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

it('translates the optional failed suffix in the History heading', async () => {
  dom = new JSDOM('<main></main><button></button>', { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
  const host = document.querySelector('main')!, toggle = document.querySelector('button')!;
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  const panel = createAgentPanel({
    host,
    toggle,
    load: async () => ({ events: [] }),
    render: () => [],
    openMain: vi.fn(),
    working: () => true,
    agent: () => ({ state: 'failed', task: 'Placeholder failure', conversationId: 'placeholder-failed' })
  });
  panel.update('prime', [{
    id: 'worker',
    title: 'worker-1',
    conversationId: 'placeholder-failed',
    startedAt: 1,
    updatedAt: 2,
    origin: { kind: 'worker', fromSessionId: 'prime', agentId: 'worker-1', task: 'Placeholder failure' }
  } as SessionSummary]);
  toggle.click();
  expect(host.textContent).toContain('Verlauf · 1 · 1 fehlgeschlagen');
  setLanguage('en');
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

it('shows latest recorded worker activity and action count without loading worker history', () => {
  dom = new JSDOM('<main></main><button></button>');
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!, toggle = document.querySelector('button')!;
  const load = vi.fn(async () => ({ events: [] }));
  const now = Date.now();
  const panel = createAgentPanel({
    host,
    toggle,
    load,
    render: () => [],
    openMain: vi.fn(),
    working: () => true
  });
  const worker = {
    id: 'worker',
    title: 'worker-2',
    conversationId: 'chat-worker',
    startedAt: now - 90_000,
    updatedAt: now,
    toolCalls: 1_200,
    lastToolCallAt: now - 1_000,
    lastToolActivity: { kind: 'read', title: 'Read src/main/agents.ts' },
    origin: { kind: 'worker', fromSessionId: 'prime', agentId: 'worker-2', task: 'Inspect activity' }
  } as SessionSummary;

  panel.update('prime', [worker]);
  toggle.click();
  expect(load).not.toHaveBeenCalled();
  expect(host.querySelector('.agent-card-activity')?.textContent).toBe('Read src/main/agents.ts');
  expect((host.querySelector('.agent-card-activity') as HTMLElement)?.dataset.kind).toBe('read');
  expect(host.querySelector('.agent-card-meta')?.textContent).toContain('1.2k actions');

  panel.update('prime', [{
    ...worker,
    updatedAt: now + 1,
    toolCalls: 1_201,
    lastToolCallAt: now + 1,
    lastToolActivity: { kind: 'run', title: 'Ran npm test' }
  }]);
  expect(load).not.toHaveBeenCalled();
  expect(host.querySelector('.agent-card-activity')?.textContent).toBe('Ran npm test');
  expect(host.querySelector('.agent-card-meta')?.textContent).toContain('1.2k actions');
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
  expect(host.textContent).toContain('History · 1 · 1 failed');
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
  expect(host.textContent).toContain('History · 1 · 1 failed');
});

it('adds failures to the existing History heading without a standalone summary row', () => {
  dom = new JSDOM('<main></main><button></button>');
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!, toggle = document.querySelector('button')!;
  const panel = createAgentPanel({
    host,
    toggle,
    load: async () => ({ events: [] }),
    render: () => [],
    openMain: vi.fn(),
    working: worker => worker.id === 'fallback-running',
    agent: worker => worker.id === 'active' ? { state: 'active', task: 'Run tests', conversationId: 'chat-active' }
      : worker.id === 'done' ? { state: 'sleeping', task: 'Review code', conversationId: 'chat-done' }
        : worker.id === 'failed' ? { state: 'failed', task: 'Check build', conversationId: 'chat-failed' }
          : null
  });
  panel.update('prime', [
    { id: 'active', title: 'worker-1', conversationId: 'chat-active', startedAt: 1, updatedAt: 2,
      origin: { kind: 'worker', fromSessionId: 'prime', agentId: 'worker-1', task: 'Run tests' } },
    { id: 'fallback-running', title: 'worker-2', conversationId: 'chat-fallback', startedAt: 1, updatedAt: 2,
      origin: { kind: 'worker', fromSessionId: 'prime', agentId: 'worker-2', task: 'Inspect current work' } },
    { id: 'done', title: 'worker-3', conversationId: 'chat-done', startedAt: 1, updatedAt: 2,
      origin: { kind: 'worker', fromSessionId: 'prime', agentId: 'worker-3', task: 'Review code' } },
    { id: 'failed', title: 'worker-4', conversationId: 'chat-failed', startedAt: 1, updatedAt: 2,
      origin: { kind: 'worker', fromSessionId: 'prime', agentId: 'worker-4', task: 'Check build' } }
  ] as SessionSummary[]);
  toggle.click();
  expect(host.querySelector('.agent-panel-summary')).toBeNull();
  expect(host.textContent).toContain('Active · 2');
  expect(host.textContent).toContain('History · 2 · 1 failed');
  expect(host.textContent).not.toContain('4 workers · 2 running · 1 done · 1 failed');
});


it('shows bounded worker health in the overview without changing lifecycle ownership', () => {
  dom = new JSDOM('<main></main><button></button>');
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!, toggle = document.querySelector('button')!;
  const panel = createAgentPanel({
    host,
    toggle,
    load: async () => ({ events: [] }),
    render: () => [],
    openMain: vi.fn(),
    working: () => false,
    agent: () => ({ state: 'detached', task: 'Inspect the build', conversationId: 'chat-worker' })
  });
  panel.update('prime', [{
    id: 'worker',
    title: 'worker-1 · Inspect the build',
    conversationId: 'chat-worker',
    startedAt: Date.now() - 5_000,
    updatedAt: Date.now(),
    activeTurnId: null,
    origin: { kind: 'worker', fromSessionId: 'prime', agentId: 'worker-1', task: 'Inspect the build' }
  } as SessionSummary]);
  toggle.click();
  const card = host.querySelector<HTMLElement>('.agent-panel-row')!;
  expect(card.dataset.health).toBe('degraded');
  expect(card.querySelector('.agent-card-health')?.textContent).toBe('Degraded');
  expect(card.querySelector<HTMLElement>('.agent-card-health')?.getAttribute('title')).toBeNull();
});
