import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/main/config.js';
import type { InputEntry, SessionControlsView } from '../src/preload/index.js';
import type { SessionSummary } from '../src/shared/session.js';
import type { AppState } from '../src/shared/types.js';
import { createRendererRoot, flushReact, installRendererDom, ok, setNativeValue } from './renderer-react-helpers.js';

let dom: ReturnType<typeof installRendererDom>['dom'] | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  dom?.window.close(); dom = null;
  vi.restoreAllMocks(); vi.resetModules();
});

function state(overrides: Partial<AppState['config']['ui']> = {}): AppState {
  const config = defaultConfig('win32');
  config.ui = { ...config.ui, ...overrides };
  return {
    config,
    status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
    platform: { family: 'windows', name: 'Windows', desktopAutomation: true },
    secureStorage: { available: true, detail: null },
    hasApiKey: false, hasGoalKey: false, hasCustomProviderKey: false,
    resolvedBinary: null, bundledTunnelVersion: null,
    bridge: { running: true, port: 8765, paired: true, present: true, lastSeenAt: 1, extensionVersion: '2.0.8' },
    update: { current: '2.0.8', latest: null, stage: 'idle', error: null, checkedAt: 1 },
  };
}

function summary(id = 'session-aaaaaaaa'): SessionSummary {
  return {
    id, title: 'Conversation', conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', chatIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastHandoffId: null, lastHandoffAt: null,
    lastTurnOutcome: null, activeTurnId: 'historical-turn', agents: [], origin: null,
  };
}

function controls(activeTurnId: string | null = null): SessionControlsView {
  return {
    sessionId: 'session-aaaaaaaa', conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    automation: 'off', objective: '', activeTurnId, finishHeld: false, queueAtFinish: false,
    canInject: !!activeTurnId, finishWaiting: false, stopPending: false, goalDraft: null,
    finishGoalDraft: null, blocked: '', job: null,
  };
}

it('keeps dirty settings through an unrelated authoritative push and saves against the original base', async () => {
  const first = state({ theme: 'light' });
  const pushed = state({ theme: 'dark' });
  const saveSettings = vi.fn(async (patch: any, _base: any) => ok({ ...pushed, config: { ...pushed.config, ...patch } } as AppState));
  const installed = installRendererDom({ saveSettings, removeRoot: () => ok(first), addRoot: () => ok(first) });
  dom = installed.dom;
  const { CustomizePage } = await import('../src/renderer/components/settings/customize-page.js');
  root = await createRendererRoot(installed.container);
  await act(async () => { root!.render(createElement(CustomizePage, { appState: first })); await flushReact(); });

  const readOnly = installed.container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(readOnly.getAttribute('aria-checked')).toBe('false');
  await act(async () => { readOnly.click(); await flushReact(); });
  expect(readOnly.getAttribute('aria-checked')).toBe('true');

  await act(async () => { root!.render(createElement(CustomizePage, { appState: pushed })); await flushReact(); });
  expect(installed.container.querySelector<HTMLButtonElement>('[role="switch"]')!.getAttribute('aria-checked')).toBe('true');

  const save = [...installed.container.querySelectorAll('button')].find((button) => button.textContent === 'Save changes')!;
  await act(async () => { save.click(); await flushReact(); });
  expect(saveSettings).toHaveBeenCalledTimes(1);
  expect(saveSettings.mock.calls[0]![0].readOnly).toBe(true);
  expect(saveSettings.mock.calls[0]![1].ui.theme).toBe('light');
});

it('deduplicates rapid React submits and sends the exact observed model/reasoning pair', async () => {
  let release!: (value: { ok: true; data: InputEntry }) => void;
  const sendInput = vi.fn((args: any) => new Promise<{ ok: true; data: InputEntry }>((resolve) => {
    release = resolve;
    void args;
  }));
  const catalog = { state: 'ready' as const, requestedAt: 1, observedAt: 2, models: [{ id: 'gpt-6', label: 'GPT-6', efforts: ['high' as const] }] };
  const installed = installRendererDom({
    getChatModels: () => ok(catalog), requestChatModels: () => ok(catalog), onChatModelsChanged: () => () => undefined,
    chooseFiles: () => ok([]), dropFiles: () => ok([]), sendInput, cancelTaskRequest: () => ok(false),
  });
  dom = installed.dom;
  const { Composer } = await import('../src/renderer/components/chat/composer.js');
  root = await createRendererRoot(installed.container);
  await act(async () => {
    root!.render(createElement(Composer, {
      session: null, projects: [], draftProjectId: null, controls: null,
      onProjectSelected: vi.fn(), onSent: vi.fn(), onControlsChanged: vi.fn(), onDraftChanged: vi.fn(),
      onOpenCustomize: vi.fn(), planBackend: 'chatgpt',
    }));
    await flushReact();
  });
  const input = installed.container.querySelector<HTMLTextAreaElement>('#chatInput')!;
  await act(async () => {
    setNativeValue(input, 'Ship this once');
    await flushReact();
  });
  const form = installed.container.querySelector<HTMLFormElement>('#composer')!;
  act(() => {
    form.dispatchEvent(new dom!.window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new dom!.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(sendInput).toHaveBeenCalledTimes(1);
  expect(sendInput.mock.calls[0]![0]).toMatchObject({ text: 'Ship this once', model: 'gpt-6', reasoningEffort: 'high' });
  const args = sendInput.mock.calls[0]![0];
  release({ ok: true, data: { ...args, state: 'queued', owner: null, createdAt: Date.now(), conversationId: null } });
  await act(async () => { await flushReact(); });
});

it('only stops an active turn from an explicit Stop control activation, never an empty form submit', async () => {
  const catalog = { state: 'ready' as const, requestedAt: 1, observedAt: 2, models: [{ id: 'gpt-6', label: 'GPT-6', efforts: ['high' as const] }] };
  const active = controls('turn-live');
  const stopSessionTurn = vi.fn(() => ok({ ...active, stopPending: true }));
  const installed = installRendererDom({
    getChatModels: () => ok(catalog), requestChatModels: () => ok(catalog), onChatModelsChanged: () => () => undefined,
    cancelTaskRequest: () => ok(false), stopSessionTurn,
  });
  dom = installed.dom;
  const { Composer } = await import('../src/renderer/components/chat/composer.js');
  root = await createRendererRoot(installed.container);
  await act(async () => {
    root!.render(createElement(Composer, {
      session: summary(), projects: [], draftProjectId: null, controls: active,
      onProjectSelected: vi.fn(), onSent: vi.fn(), onControlsChanged: vi.fn(), onDraftChanged: vi.fn(),
      onOpenCustomize: vi.fn(), planBackend: 'chatgpt',
    }));
    await flushReact();
  });

  const form = installed.container.querySelector<HTMLFormElement>('#composer')!;
  await act(async () => {
    form.dispatchEvent(new dom!.window.Event('submit', { bubbles: true, cancelable: true }));
    await flushReact();
  });
  expect(stopSessionTurn).not.toHaveBeenCalled();

  const stop = installed.container.querySelector<HTMLButtonElement>('#chatSend')!;
  expect(stop.getAttribute('aria-label')).toBe('Stop turn');
  await act(async () => { stop.click(); await flushReact(); });
  expect(stopSessionTurn).toHaveBeenCalledOnce();
  expect(stopSessionTurn).toHaveBeenCalledWith('session-aaaaaaaa', 'turn-live');
});

it('compacts the composer only after a conversation exists and keeps the new-chat composer roomy', async () => {
  const catalog = { state: 'ready' as const, requestedAt: 1, observedAt: 2, models: [{ id: 'gpt-6', label: 'GPT-6', efforts: ['high' as const] }] };
  const installed = installRendererDom({ getChatModels: () => ok(catalog), requestChatModels: () => ok(catalog), onChatModelsChanged: () => () => undefined, cancelTaskRequest: () => ok(false) });
  dom = installed.dom;
  const { Composer } = await import('../src/renderer/components/chat/composer.js');
  root = await createRendererRoot(installed.container);
  const common = { projects: [], draftProjectId: null, controls: null, onProjectSelected: vi.fn(), onSent: vi.fn(), onControlsChanged: vi.fn(), onDraftChanged: vi.fn(), onOpenCustomize: vi.fn(), planBackend: 'chatgpt' as const };

  await act(async () => { root!.render(createElement(Composer, { ...common, session: null })); await flushReact(); });
  expect(installed.container.querySelector<HTMLTextAreaElement>('#chatInput')!.rows).toBe(3);
  expect(installed.container.textContent).toContain('Plan New Idea');
  expect(installed.container.querySelector<HTMLFormElement>('#composer')!.className).not.toContain('shadow');

  await act(async () => { root!.render(createElement(Composer, { ...common, session: summary(), controls: controls(null) })); await flushReact(); });
  expect(installed.container.querySelector<HTMLTextAreaElement>('#chatInput')!.rows).toBe(1);
  expect(installed.container.textContent).not.toContain('Plan New Idea');
  expect(installed.container.textContent).not.toContain('New chat');
});

it('groups worker chats under a blue primary row and collapses repository conversations without losing them', async () => {
  const installed = installRendererDom({});
  dom = installed.dom;
  const { AppSidebar } = await import('../src/renderer/components/layout/app-sidebar.js');
  root = await createRendererRoot(installed.container);
  const project = { id: 'project-one', name: 'alpha', path: 'C:\\work\\alpha', createdAt: 1 };
  const prime: SessionSummary = { ...summary('prime-session'), title: 'Primary conversation', projectId: project.id, agents: ['prime', 'worker-1'] };
  const worker: SessionSummary = {
    ...summary('worker-session'),
    title: 'Inspect renderer',
    projectId: project.id,
    agents: ['worker-1'],
    origin: { kind: 'worker', fromSessionId: prime.id, agentId: 'worker-1', task: 'Inspect renderer' },
  };
  const props = {
    open: true,
    page: 'chat' as const,
    sessions: [prime, worker],
    projects: [project],
    selectedId: prime.id,
    onPage: vi.fn(),
    onSelectSession: vi.fn(),
    onNewChat: vi.fn(),
    onAddProject: vi.fn(),
    onRemoveProject: vi.fn(),
    onDeleteSession: vi.fn(),
    onLoadMore: vi.fn(),
    hasMore: false,
  };
  await act(async () => { root!.render(createElement(AppSidebar, props)); await flushReact(); });

  const scrollContent = installed.container.querySelector<HTMLElement>('#sessionList')!.parentElement!;
  expect(scrollContent.getAttribute('role')).toBe('presentation');
  expect(scrollContent.style.minWidth).toBe('0px');
  expect(scrollContent.style.width).toBe('100%');

  const primaryRow = installed.container.querySelector<HTMLElement>('[data-session-id="prime-session"]')!;
  const workerRow = installed.container.querySelector<HTMLElement>('[data-session-id="worker-session"]')!;
  expect(primaryRow.dataset.sessionRole).toBe('primary');
  expect(primaryRow.className).toContain('text-brand');
  expect(primaryRow.textContent).toContain('primary');
  expect(workerRow.dataset.sessionRole).toBe('worker');
  expect(workerRow.className).toContain('ml-3');
  const projectHeader = installed.container.querySelector<HTMLElement>('[data-project-header="project-one"]')!;
  const newConversation = projectHeader.querySelector<HTMLButtonElement>('button[aria-label="New conversation in alpha"]')!;
  expect(newConversation).not.toBeNull();
  expect(installed.container.querySelector('#project-sessions-project-one')?.textContent).not.toContain('New conversation');
  await act(async () => { newConversation.click(); await flushReact(); });
  expect(props.onNewChat).toHaveBeenCalledWith(project.id);

  expect(primaryRow.querySelector('button[aria-label="Actions for Primary conversation"]')).toBeNull();
  const deleteButton = primaryRow.querySelector<HTMLButtonElement>('button[aria-label="Delete Primary conversation"]')!;
  expect(deleteButton).not.toBeNull();
  await act(async () => { deleteButton.click(); await flushReact(); });
  expect(props.onDeleteSession).toHaveBeenCalledWith(prime.id);
  expect(document.body.textContent).not.toContain('Delete chat?');

  const collapse = installed.container.querySelector<HTMLButtonElement>('button[aria-label="Collapse alpha"]')!;
  expect(collapse.getAttribute('aria-expanded')).toBe('true');
  await act(async () => { collapse.click(); await flushReact(); });
  expect(installed.container.querySelector('[data-session-id="prime-session"]')).toBeNull();
  expect(installed.container.querySelector('[data-session-id="worker-session"]')).toBeNull();
  const expand = installed.container.querySelector<HTMLButtonElement>('button[aria-label="Expand alpha"]')!;
  expect(expand.getAttribute('aria-expanded')).toBe('false');
  await act(async () => { expand.click(); await flushReact(); });
  expect(installed.container.querySelector('[data-session-id="prime-session"]')).not.toBeNull();
  expect(installed.container.querySelector('[data-session-id="worker-session"]')).not.toBeNull();
});

it('stages pasted files through preload while leaving ordinary text paste untouched', async () => {
  const attachment = { id: 'file-1', name: 'shot.png', mimeType: 'image/png', size: 10, preview: 'data:image/png;base64,AA==' };
  const dropFiles = vi.fn(() => ok([attachment]));
  const catalog = { state: 'ready' as const, requestedAt: 1, observedAt: 2, models: [{ id: 'gpt-6', label: 'GPT-6', efforts: ['high' as const] }] };
  const installed = installRendererDom({ getChatModels: () => ok(catalog), requestChatModels: () => ok(catalog), onChatModelsChanged: () => () => undefined, dropFiles, chooseFiles: () => ok([]), cancelTaskRequest: () => ok(false) });
  dom = installed.dom;
  const { Composer } = await import('../src/renderer/components/chat/composer.js');
  root = await createRendererRoot(installed.container);
  await act(async () => { root!.render(createElement(Composer, { session: null, projects: [], draftProjectId: null, controls: null, onProjectSelected: vi.fn(), onSent: vi.fn(), onControlsChanged: vi.fn(), onDraftChanged: vi.fn(), onOpenCustomize: vi.fn(), planBackend: 'chatgpt' })); await flushReact(); });
  const input = installed.container.querySelector<HTMLTextAreaElement>('#chatInput')!;
  const ordinary = new dom.window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ordinary, 'clipboardData', { value: { files: [] } });
  expect(input.dispatchEvent(ordinary)).toBe(true);
  expect(dropFiles).not.toHaveBeenCalled();
  const imagePaste = new dom.window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(imagePaste, 'clipboardData', { value: { files: [{ name: 'shot.png' }] } });
  await act(async () => { input.dispatchEvent(imagePaste); await flushReact(); });
  expect(dropFiles).toHaveBeenCalledTimes(1);
  expect(installed.container.querySelector('img[alt="shot.png"]')).not.toBeNull();
});

it('offers Stop only from authoritative current-turn controls and captures that exact turn id', async () => {
  const stopSessionTurn = vi.fn((_id: string, expectedTurnId: string) => ok(controls(expectedTurnId)));
  const catalog = { state: 'ready' as const, requestedAt: 1, observedAt: 2, models: [{ id: 'gpt-6', label: 'GPT-6', efforts: ['high' as const] }] };
  const installed = installRendererDom({ getChatModels: () => ok(catalog), requestChatModels: () => ok(catalog), onChatModelsChanged: () => () => undefined, stopSessionTurn, cancelTaskRequest: () => ok(false) });
  dom = installed.dom;
  const { Composer } = await import('../src/renderer/components/chat/composer.js');
  root = await createRendererRoot(installed.container);
  const props = { session: summary(), projects: [], draftProjectId: null, onProjectSelected: vi.fn(), onSent: vi.fn(), onControlsChanged: vi.fn(), onDraftChanged: vi.fn(), onOpenCustomize: vi.fn(), planBackend: 'chatgpt' as const };
  await act(async () => { root!.render(createElement(Composer, { ...props, controls: controls(null) })); await flushReact(); });
  expect(installed.container.querySelector<HTMLButtonElement>('#chatSend')!.disabled).toBe(true);
  await act(async () => { root!.render(createElement(Composer, { ...props, controls: controls('live-turn-42') })); await flushReact(); });
  const send = installed.container.querySelector<HTMLButtonElement>('#chatSend')!;
  expect(send.getAttribute('aria-label')).toBe('Stop turn');
  await act(async () => { send.click(); await flushReact(); });
  expect(stopSessionTurn).toHaveBeenCalledWith('session-aaaaaaaa', 'live-turn-42');
});
