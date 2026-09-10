import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { InputEntry, SessionControlsView } from '../src/preload/index.js';
import type { SessionEvent, SessionSummary } from '../src/shared/session.js';
import { createRendererRoot, flushReact, installRendererDom, ok, setNativeValue } from './renderer-react-helpers.js';

let dom: ReturnType<typeof installRendererDom>['dom'] | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  dom?.window.close(); dom = null;
  vi.restoreAllMocks(); vi.resetModules();
});

const text = (value: string) => ({ text: value, chars: value.length, truncated: false as const });
const note = (seq: number): SessionEvent => ({ seq, time: seq, source: 'app', kind: 'note', message: text(`note-${seq}`) });

function summary(id: string): SessionSummary {
  return {
    id, title: id, conversationId: `conversation-${id}`, chatIds: [`conversation-${id}`], startedAt: 1, updatedAt: 2,
    endedAt: null, events: 320, userMessages: 0, toolCalls: 0, lastToolCallAt: null,
    processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0, estimatedTokens: 0,
    contextTokens: 0, lastHandoffId: null, lastHandoffAt: null, lastTurnOutcome: null,
    activeTurnId: null, agents: [], origin: null,
  };
}

function controls(objective = 'Server objective'): SessionControlsView {
  return {
    sessionId: 'session-aaaaaaaa', conversationId: 'conversation-session-aaaaaaaa', automation: 'goal', objective,
    activeTurnId: 'turn-1', finishHeld: true, queueAtFinish: true, canInject: true, finishWaiting: false,
    stopPending: false, goalDraft: null, finishGoalDraft: null, blocked: '', job: null,
  };
}

function queued(id: string, body: string): InputEntry {
  return {
    id, sessionId: 'session-aaaaaaaa', projectId: null, text: body, mode: 'finish', dueAt: 1,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 1,
    conversationId: 'conversation-session-aaaaaaaa',
  };
}

it('renders sanitized ChatGPT HTML and loads recorded image assets only for the exact session', async () => {
  const getSessionImage = vi.fn((_sessionId: string, _assetId: string) => ok('data:image/png;base64,AA=='));
  const installed = installRendererDom({ getSessionImage }); dom = installed.dom;
  const { Timeline } = await import('../src/renderer/components/chat/timeline.js');
  const events: SessionEvent[] = [
    { seq: 1, time: 1, source: 'extension', kind: 'user_message', message: text('See image'), assets: [{ id: 'asset-1', mimeType: 'image/png', bytes: 2, width: 10, height: 10 }] },
    { seq: 2, time: 2, source: 'extension', kind: 'assistant_message', message: text('Safe answer'), renderedHtml: text('<p onclick="evil()">Safe <a href="javascript:evil()">link</a></p><script>evil()</script><img src=x onerror="evil()">'), final: true },
  ];
  root = await createRendererRoot(installed.container);
  await act(async () => { root!.render(createElement(Timeline, { sessionId: 'session-exact', events, loading: false, developerMode: false })); await flushReact(); });
  expect(installed.container.textContent).toContain('Safe');
  expect(installed.container.querySelector('script')).toBeNull();
  expect(installed.container.querySelector('[onclick]')).toBeNull();
  expect(installed.container.querySelector('[onerror]')).toBeNull();
  const href = installed.container.querySelector('a')?.getAttribute('href') ?? null;
  expect(href === null || !/^javascript:/i.test(href)).toBe(true);
  expect(getSessionImage).toHaveBeenCalledWith('session-exact', 'asset-1');
  expect(installed.container.querySelector('img[alt="Attached image"]')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
});

it('keeps a bounded 160-event window while paging deliberately backward and forward to the live tail', async () => {
  const calls: Array<{ id: string; options: any }> = [];
  const api = {
    getSession: (id: string, options: any = {}) => {
      calls.push({ id, options });
      if (options.before === 161) return ok({ summary: summary(id), events: Array.from({ length: 80 }, (_, index) => note(81 + index)), total: 320, nextFrom: 321 });
      if (options.from === 241) return ok({ summary: summary(id), events: Array.from({ length: 80 }, (_, index) => note(241 + index)), total: 320, nextFrom: 321 });
      if (options.from === 321) return ok({ summary: summary(id), events: [], total: 320, nextFrom: 321 });
      return ok({ summary: summary(id), events: Array.from({ length: 160 }, (_, index) => note(161 + index)), total: 320, nextFrom: 321 });
    },
    onSessionChanged: () => () => undefined,
  };
  const installed = installRendererDom(api); dom = installed.dom;
  const { useSessionDetail } = await import('../src/renderer/state/session-store.js');
  let view: ReturnType<typeof useSessionDetail> | null = null;
  function Harness() { view = useSessionDetail('session-page'); return null; }
  root = await createRendererRoot(installed.container);
  await act(async () => { root!.render(createElement(Harness)); await flushReact(); });
  expect(view!.events).toHaveLength(160);
  expect(view!.events[0]!.seq).toBe(161);

  await act(async () => { expect(await view!.loadOlder()).toBe(true); await flushReact(); });
  expect(view!.events).toHaveLength(160);
  expect(view!.events[0]!.seq).toBe(81);
  expect(view!.atLatest).toBe(false);

  await act(async () => { expect(await view!.loadNewer()).toBe(true); await flushReact(); });
  expect(view!.events).toHaveLength(160);
  expect(view!.events.at(-1)!.seq).toBe(320);
  expect(view!.atLatest).toBe(false);
  await act(async () => { expect(await view!.loadNewer()).toBe(true); await flushReact(); });
  expect(view!.atLatest).toBe(true);
  expect(calls.map((call) => call.options)).toEqual([{ limit: 160 }, { before: 161, limit: 80 }, { from: 241, limit: 80 }, { from: 321, limit: 80 }]);
});

it('generation-fences a late session detail response after selection changes', async () => {
  let resolveA!: (value: ReturnType<typeof ok<any>> extends Promise<infer T> ? T : never) => void;
  const api = {
    getSession: (id: string) => id === 'A'
      ? new Promise<Awaited<ReturnType<typeof ok<any>>>>((resolve) => { resolveA = resolve; })
      : ok({ summary: summary('B'), events: [note(20)], total: 1, nextFrom: 21 }),
    onSessionChanged: () => () => undefined,
  };
  const installed = installRendererDom(api); dom = installed.dom;
  const { useSessionDetail } = await import('../src/renderer/state/session-store.js');
  let view: ReturnType<typeof useSessionDetail> | null = null;
  function Harness({ id }: { id: string }) { view = useSessionDetail(id); return null; }
  root = await createRendererRoot(installed.container);
  await act(async () => { root!.render(createElement(Harness, { id: 'A' })); await flushReact(); });
  await act(async () => { root!.render(createElement(Harness, { id: 'B' })); await flushReact(); });
  expect(view!.summary?.id).toBe('B');
  resolveA({ ok: true, data: { summary: summary('A'), events: [note(10)], total: 1, nextFrom: 11 } });
  await act(async () => { await flushReact(); });
  expect(view!.summary?.id).toBe('B');
  expect(view!.events.map((event) => event.seq)).toEqual([20]);
});

it('keeps an unsaved Goal draft through unrelated control pushes and delegates queue edits/reordering to durable APIs', async () => {
  const setSessionObjective = vi.fn((_id: string, objective: string) => ok(controls(objective)));
  const reorderQueuedInputs = vi.fn(() => ok(true));
  const editQueuedInput = vi.fn(() => ok(true));
  const cancelInput = vi.fn(() => ok(true));
  const installed = installRendererDom({ setSessionObjective, reorderQueuedInputs, editQueuedInput, cancelInput, setSessionAutomation: () => ok(controls()), cancelSessionCompaction: () => ok(controls()), generateFinishGoal: () => ok('draft'), retryHelper: () => ok(true) });
  dom = installed.dom;
  const { TaskDock } = await import('../src/renderer/components/chat/task-dock.js');
  root = await createRendererRoot(installed.container);
  const props = {
    session: summary('session-aaaaaaaa'), rows: [queued('11111111-1111-4111-8111-111111111111', 'First'), queued('22222222-2222-4222-8222-222222222222', 'Second')],
    pausedHelpers: [], loading: false, error: '', onRefresh: vi.fn(), onControlsChanged: vi.fn(),
  };
  await act(async () => { root!.render(createElement(TaskDock, { ...props, controls: controls('Server objective') })); await flushReact(); });
  const objective = installed.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Conversation objective"]')!;
  await act(async () => { setNativeValue(objective, 'Local unsaved objective'); await flushReact(); });
  await act(async () => { root!.render(createElement(TaskDock, { ...props, controls: controls('Unrelated server push') })); await flushReact(); });
  expect(installed.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Conversation objective"]')!.value).toBe('Local unsaved objective');

  const save = [...installed.container.querySelectorAll('button')].find((button) => button.textContent === 'Save task')!;
  await act(async () => { save.click(); await flushReact(); });
  expect(setSessionObjective).toHaveBeenCalledWith('session-aaaaaaaa', 'Local unsaved objective', 'goal');

  const moveDown = installed.container.querySelector<HTMLButtonElement>('button[aria-label="Move queued message down"]')!;
  await act(async () => { moveDown.click(); await flushReact(); });
  expect(reorderQueuedInputs).toHaveBeenCalledWith('session-aaaaaaaa', ['22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111']);

  const edit = installed.container.querySelector<HTMLButtonElement>('button[aria-label="Edit queued message"]')!;
  await act(async () => { edit.click(); await flushReact(); });
  const queuedDraft = installed.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit queued message"]')!;
  await act(async () => { setNativeValue(queuedDraft, 'Edited first'); await flushReact(); });
  const saveQueued = [...installed.container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!;
  await act(async () => { saveQueued.click(); await flushReact(); });
  expect(editQueuedInput).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 'Edited first', undefined);
});
