import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgentPanel } from '../src/renderer/agent-panel.js';
import type { SessionSummary } from '../src/shared/session.js';
import { workerBrief } from '../src/shared/worker-brief.js';

let dom: JSDOM;
afterEach(() => dom?.window.close());

it('highlights only round workers in the existing overview and loads history on selection', async () => {
  dom = new JSDOM('<main></main>');
  Object.assign(globalThis, { document: dom.window.document });
  const load = vi.fn().mockResolvedValue({ events: [] });
  const panel = createAgentPanel({ host: document.querySelector('main')!, load, render: () => [], openMain: vi.fn(), working: () => false });
  const workers = ['one', 'two', 'three'].map(id => ({ id, title: id, updatedAt: 1 } as SessionSummary));
  panel.update('prime', workers);
  panel.showWorkers(['one', 'one', 'three', 'foreign']);
  const highlighted = () => [...document.querySelectorAll<HTMLElement>('.is-round-worker')].map(row => row.dataset.workerSession);
  expect(highlighted()).toEqual(['one', 'three']);
  expect(document.activeElement).toBe(document.querySelector('.is-round-worker'));
  expect(load).not.toHaveBeenCalled();
  panel.update('prime', [workers[1]!, workers[2]!]);
  expect(highlighted()).toEqual(['three']);
  (document.querySelector('.is-round-worker') as HTMLButtonElement).click();
  await Promise.resolve(); await Promise.resolve();
  expect(load).toHaveBeenCalledWith('three');
  (document.querySelector('.agent-back') as HTMLButtonElement).click();
  expect(highlighted()).toEqual(['three']);
  panel.update('other-prime', workers); panel.update('prime', workers); panel.show();
  expect(highlighted()).toEqual([]);
});

it.each(['hide', 'empty', 'parent'] as const)('retires pending worker history across %s and return to the same worker', async boundary => {
  dom = new JSDOM('<main></main>');
  Object.assign(globalThis, { document: dom.window.document });
  let resolve!: (value: { events: [] }) => void;
  const load = vi.fn(() => new Promise<{ events: [] }>(done => { resolve = done; })), render = vi.fn(() => []);
  const panel = createAgentPanel({ host: document.querySelector('main')!, load, render, openMain: vi.fn(), working: () => false });
  const worker = { id: 'worker', title: 'Worker', updatedAt: 1 } as SessionSummary;
  panel.update('prime', [worker]);
  const pending = panel.open('worker');
  if (boundary === 'hide') panel.hide();
  else panel.update(boundary === 'empty' ? 'prime' : 'another-prime', []);
  panel.update('prime', [worker]); panel.show();
  resolve({ events: [] }); await pending;
  expect(render).not.toHaveBeenCalled();
  expect(document.querySelectorAll('.agent-panel-row')).toHaveLength(1);
});

it('does not re-open the dock on worker refresh or allow retired full-chat navigation', async () => {
  dom = new JSDOM('<main></main>');
  Object.assign(globalThis, { document: dom.window.document });
  const worker = { id: 'worker', title: 'Worker', updatedAt: 1 } as SessionSummary;
  const onShow = vi.fn(), openMain = vi.fn();
  const panel = createAgentPanel({ host: document.querySelector('main')!, load: async () => ({ events: [] }),
    render: () => [], working: () => false, openMain, onShow });
  panel.update('prime', [worker]); await panel.open(worker.id);
  onShow.mockClear();
  panel.update('prime', [{ ...worker, updatedAt: 2 }]);
  await Promise.resolve(); await Promise.resolve();
  expect(onShow).not.toHaveBeenCalled();
  const oldFullChat = [...document.querySelectorAll('button')].find(button => button.textContent === 'Open full chat')!;
  panel.update('another-prime', []); panel.update('prime', [worker]);
  oldFullChat.click();
  expect(openMain).not.toHaveBeenCalled();
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
  // No name from the prime: "Worker 4", and its id one hover away.
  expect(card.querySelector('.agent-card-name')!.textContent).toBe('Worker 4');
  expect(card.title).toBe('worker-4 · Audit and verify the build');
  expect(card.querySelector('.agent-card-task')!.textContent).toBe('Audit and verify the build');
  expect(card.querySelector('.agent-card-model')!.textContent).toContain('gpt-5.6-sol');
  expect(card.dataset.state).toBe('working');
});

it('names the model as the composer does, says only what matters, and glows the round once', () => {
  dom = new JSDOM('<main></main><button></button>');
  Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!, toggle = document.querySelector('button')!;
  const now = Date.now();
  const modelLabel = vi.fn((model: string, effort: string | undefined) => `${model === 'gpt-6-sol' ? 'GPT-6 Sol' : model} · ${effort === 'none' ? 'Instant' : effort}`);
  const panel = createAgentPanel({ host, toggle, load: async () => ({ events: [] }), render: () => [], openMain: vi.fn(),
    working: worker => worker.id === 'busy', modelLabel,
    // The prime named the first; the second carries its id as its label, as a reused worker does.
    agent: worker => worker.id === 'busy' ? { state: 'active', label: 'Tests', task: workerBrief('Repo: cos. Run the checks.', 'Run the tests'), conversationId: 'chat-busy' }
      : { state: 'sleeping', label: 'worker-2', task: workerBrief('Repo: cos. Run the checks.', 'Review the layout'), conversationId: 'chat-done' } });
  const worker = (id: string, agentId: string, extra: Partial<SessionSummary>) => ({ id, title: agentId, conversationId: `chat-${id === 'busy' ? 'busy' : 'done'}`,
    startedAt: now - 120_000, updatedAt: now, toolCalls: 16, lastToolCallAt: now, lastToolActivity: { kind: 'run', title: 'Ran npm test' },
    origin: { kind: 'worker', fromSessionId: 'prime', agentId, task: 'Original' }, ...extra }) as SessionSummary;
  panel.update('prime', [
    worker('busy', 'worker-1', { selectedModel: { conversationId: 'chat-busy', model: 'gpt-6-sol', reasoningEffort: 'none', observedAt: now } }),
    worker('done', 'worker-2', { endedAt: now })
  ]);
  panel.showWorkers(['busy', 'done']);
  const card = (id: string) => host.querySelector<HTMLElement>(`[data-worker-session="${id}"]`)!;
  // Named for its job when the prime named it, else "Worker 2"; each with its own task, the run's
  // shared context left out.
  expect([card('busy'), card('done')].map(row => row.querySelector('.agent-card-name')!.textContent)).toEqual(['Tests', 'Worker 2']);
  expect([card('busy'), card('done')].map(row => row.querySelector('.agent-card-task')!.textContent)).toEqual(['Run the tests', 'Review the layout']);
  // A thinking-free model is Instant, by its catalog name; never "none".
  expect(card('busy').querySelector('.agent-card-model')!.textContent).toBe('GPT-6 Sol · Instant');
  expect(modelLabel).toHaveBeenCalledWith('gpt-6-sol', 'none');
  // Working: its current action and state; a finished worker shows neither its last action nor its health.
  expect(card('busy').querySelector('.agent-card-activity')!.textContent).toBe('Ran npm test');
  expect(card('busy').querySelector('.agent-card-state')!.textContent).toBe('Working');
  expect(card('done').querySelector('.agent-card-activity')).toBeNull();
  expect(card('done').querySelector('.agent-card-state')!.textContent).toBe('Idle');
  expect(host.querySelector('.agent-card-health')).toBeNull();
  expect(card('done').querySelector('.agent-card-meta')!.textContent).toBe('Idle·16 actions');
  expect(card('busy').querySelector('.agent-card-time')!.textContent).toBe('2m');
  // The round's workers glow as the panel opens on them, and not again on the repaints after.
  expect(host.querySelectorAll('.is-arriving')).toHaveLength(2);
  panel.update('prime', [
    worker('busy', 'worker-1', { updatedAt: now + 1 }),
    worker('done', 'worker-2', { endedAt: now })
  ]);
  expect(host.querySelectorAll('.is-arriving')).toHaveLength(0);
  expect(host.querySelectorAll('.is-round-worker')).toHaveLength(2);
});

it('lets the round glow go once it has played, so no later layout change can replay it', () => {
  vi.useFakeTimers();
  try {
    dom = new JSDOM('<main></main><button></button>');
    Object.assign(globalThis, { document: dom.window.document });
    const host = document.querySelector('main')!, toggle = document.querySelector('button')!;
    const panel = createAgentPanel({ host, toggle, load: async () => ({ events: [] }), render: () => [], openMain: vi.fn(), working: () => false });
    panel.update('prime', [{ id: 'w', title: 'worker-1', conversationId: 'c', startedAt: Date.now(), updatedAt: Date.now(),
      origin: { kind: 'worker', fromSessionId: 'prime', agentId: 'worker-1', task: 'Review' } } as SessionSummary]);
    panel.showWorkers(['w'], false);
    expect(host.querySelectorAll('.is-arriving')).toHaveLength(1);
    // Nothing repaints the list (closing the sidebar only moves it): the class still leaves.
    vi.advanceTimersByTime(1600);
    expect(host.querySelectorAll('.is-arriving')).toHaveLength(0);
    expect(host.querySelectorAll('.is-round-worker')).toHaveLength(1);
  } finally { vi.useRealTimers(); }
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

it('keeps archived names and assignments after broker eviction, fenced by exact identity', () => {
  dom = new JSDOM('<main></main>'); Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!;
  const panel = createAgentPanel({ host, load: async () => ({ events: [] }), render: () => [], openMain: vi.fn(), working: () => false });
  const worker = { id: 'local', title: 'worker-2', conversationId: 'chat', startedAt: 1, updatedAt: 2,
    origin: { kind: 'worker', fromSessionId: 'prime', agentId: 'worker-2', task: 'Original task' },
    workerAssignment: { conversationId: 'chat', agentId: 'worker-2', label: 'Divisao', task: '144/12', recordedAt: 2 }
  } as SessionSummary;
  panel.update('prime', [worker]); panel.show();
  expect(host.querySelector('.agent-card-name')?.textContent).toBe('Divisao');
  expect(host.querySelector('.agent-card-task')?.textContent).toBe('144/12');
  panel.update('prime', [{ ...worker, conversationId: 'different-chat' }]);
  expect(host.querySelector('.agent-card-name')?.textContent).toBe('Worker 2');
  expect(host.querySelector('.agent-card-task')?.textContent).toBe('Original task');
});

it('hides prior finish and prior-turn activity when a worker starts its next assignment', () => {
  dom = new JSDOM('<main></main>'); Object.assign(globalThis, { document: dom.window.document });
  const host = document.querySelector('main')!;
  const panel = createAgentPanel({ host, load: async () => ({ events: [] }), render: () => [], openMain: vi.fn(), working: () => true });
  const worker = { id: 'local', title: 'worker-1', startedAt: 1, updatedAt: 20,
    lastToolCallAt: 10, lastFinishReportAt: 10, lastToolActivity: { kind: 'agent', title: 'Reported the finished task' }
  } as SessionSummary;
  panel.update('prime', [worker]); panel.show();
  expect(host.querySelector('.agent-card-activity')).toBeNull();
  panel.update('prime', [{ ...worker, lastFinishReportAt: null, lastTurnEndAt: 15 }]);
  expect(host.querySelector('.agent-card-activity')).toBeNull();
  panel.update('prime', [{ ...worker, lastToolCallAt: 21, lastToolActivity: { kind: 'run', title: 'Ran 4+4' } }]);
  expect(host.querySelector('.agent-card-activity')?.textContent).toBe('Ran 4+4');
});
