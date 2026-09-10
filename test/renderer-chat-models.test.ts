import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChatModelCatalog } from '../src/shared/chat-models.js';
import type { SessionSummary } from '../src/shared/session.js';
import { createRendererRoot, flushReact, installRendererDom, ok } from './renderer-react-helpers.js';

let dom: ReturnType<typeof installRendererDom>['dom'] | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  dom?.window.close();
  dom = null;
  vi.restoreAllMocks();
  vi.resetModules();
});

function summary(id: string, selectedModel: SessionSummary['selectedModel'] = undefined): SessionSummary {
  return {
    id, title: id, conversationId: `conversation-${id}`, chatIds: [`conversation-${id}`],
    startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastHandoffId: null, lastHandoffAt: null,
    lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null, selectedModel,
  };
}

it('uses only observed supported composer choices and preserves an exact user selection across A-B-A', async () => {
  const catalog: ChatModelCatalog = { state: 'ready', requestedAt: 1, observedAt: 2, models: [
    { id: 'old', label: 'GPT-5.5', efforts: ['high', 'pro'] },
    { id: 'six', label: 'GPT-6', efforts: ['medium', 'high'] },
    { id: 'sol', label: 'GPT-5.6 Sol', efforts: ['high', 'xhigh'] },
  ] };
  const installed = installRendererDom({
    getChatModels: () => ok(catalog),
    requestChatModels: () => ok(catalog),
    onChatModelsChanged: () => () => undefined,
  });
  dom = installed.dom;
  const { useChatModels } = await import('../src/renderer/state/chat-models.js');
  let view: ReturnType<typeof useChatModels> | null = null;
  function Harness({ session }: { session: SessionSummary | null }) { view = useChatModels(session); return null; }
  root = await createRendererRoot(installed.container);

  await act(async () => { root!.render(createElement(Harness, { session: summary('A') })); await flushReact(); });
  expect(view!.models.map((row) => row.id)).toEqual(['six', 'sol']);
  expect(view!.selected).toMatchObject({ model: 'six', effort: 'high' });
  act(() => view!.choose('sol', 'xhigh'));
  expect(view!.selected).toMatchObject({ model: 'sol', effort: 'xhigh' });

  await act(async () => { root!.render(createElement(Harness, { session: summary('B', { model: 'six', reasoningEffort: 'medium', observedAt: 3, conversationId: 'conversation-B' }) })); await flushReact(); });
  expect(view!.selected).toMatchObject({ model: 'six', effort: 'medium' });
  await act(async () => { root!.render(createElement(Harness, { session: summary('A') })); await flushReact(); });
  expect(view!.selected).toMatchObject({ model: 'sol', effort: 'xhigh' });
});

it('maps a session model alias to its exact observed family and effort', async () => {
  const catalog: ChatModelCatalog = { state: 'ready', requestedAt: 1, observedAt: 2, models: [
    { id: 'sol', label: 'GPT-5.6 Sol', efforts: ['high', 'pro'], aliases: ['gpt-5-6-thinking', 'gpt-5-6-pro'] },
  ] };
  const installed = installRendererDom({ getChatModels: () => ok(catalog), requestChatModels: () => ok(catalog), onChatModelsChanged: () => () => undefined });
  dom = installed.dom;
  const { useChatModels } = await import('../src/renderer/state/chat-models.js');
  let selected: ReturnType<typeof useChatModels>['selected'] = null;
  function Harness() {
    selected = useChatModels(summary('A', { model: 'gpt-5-6-pro', reasoningEffort: 'pro', observedAt: 4, conversationId: 'conversation-A' })).selected;
    return null;
  }
  root = await createRendererRoot(installed.container);
  await act(async () => { root!.render(createElement(Harness)); await flushReact(); });
  expect(selected).toMatchObject({ model: 'sol', effort: 'pro' });
});

it('ignores a late startup catalog read after a newer catalog push', async () => {
  let resolveStartup!: (reply: ReturnType<typeof ok<ChatModelCatalog>> extends Promise<infer T> ? T : never) => void;
  let push!: (catalog: ChatModelCatalog) => void;
  const getChatModels = vi.fn(() => new Promise<Awaited<ReturnType<typeof ok<ChatModelCatalog>>>>((resolve) => { resolveStartup = resolve; }));
  const installed = installRendererDom({
    getChatModels,
    requestChatModels: () => ok({ state: 'pending', requestedAt: 2, observedAt: null, models: [] } satisfies ChatModelCatalog),
    onChatModelsChanged: (listener: (catalog: ChatModelCatalog) => void) => { push = listener; return () => undefined; },
  });
  dom = installed.dom;
  const { useChatModels } = await import('../src/renderer/state/chat-models.js');
  let view: ReturnType<typeof useChatModels> | null = null;
  function Harness() { view = useChatModels(null); return null; }
  root = await createRendererRoot(installed.container);
  await act(async () => { root!.render(createElement(Harness)); await flushReact(); });

  const pushed: ChatModelCatalog = { state: 'ready', requestedAt: 1, observedAt: 5, models: [{ id: 'six', label: 'GPT-6', efforts: ['high'] }] };
  act(() => push(pushed));
  resolveStartup({ ok: true, data: { state: 'pending', requestedAt: 1, observedAt: null, models: [] } });
  await act(async () => { await flushReact(); });
  expect(getChatModels).toHaveBeenCalledTimes(1);
  expect(view!.catalog).toEqual(pushed);
  expect(view!.selected).toMatchObject({ model: 'six', effort: 'high' });
});
