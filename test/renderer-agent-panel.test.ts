import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../src/shared/session.js';
import { createRendererRoot, flushReact, installRendererDom, ok } from './renderer-react-helpers.js';

let dom: ReturnType<typeof installRendererDom>['dom'] | null = null; let root: Root | null = null;
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = null; dom?.window.close(); dom = null; vi.restoreAllMocks(); vi.resetModules(); });
function worker(id = 'worker-session'): SessionSummary { return { id, title: 'Worker', conversationId: `chat-${id}`, chatIds: [`chat-${id}`], startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0, lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0, estimatedTokens: 0, contextTokens: 0, lastHandoffId: null, lastHandoffAt: null, lastTurnOutcome: null, activeTurnId: null, agents: [], origin: { kind: 'worker', fromSessionId: 'prime-a', agentId: 'worker-1', task: 'Inspect the renderer' } }; }

it('rejects a late worker transcript after parent conversation navigation', async () => {
  let release!: (value: any) => void;
  const getSession = vi.fn(() => new Promise(resolve => { release = resolve; }));
  const installed = installRendererDom({ getSession }); dom = installed.dom;
  const { AgentPanel } = await import('../src/renderer/components/chat/agent-panel.js'); root = await createRendererRoot(installed.container);
  const openMain = vi.fn(), onOpenChange = vi.fn();
  await act(async () => { root!.render(createElement(AgentPanel, { parentSessionId: 'prime-a', workers: [worker()], open: true, onOpenChange, onOpenMain: openMain })); await flushReact(); });
  const row = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Inspect the renderer'))!;
  await act(async () => { row.click(); await flushReact(); });
  await act(async () => { root!.render(createElement(AgentPanel, { parentSessionId: 'prime-b', workers: [], open: true, onOpenChange, onOpenMain: openMain })); await flushReact(); });
  release({ ok: true, data: { summary: worker(), events: [], total: 0, nextFrom: 1 } });
  await act(async () => { await flushReact(); });
  expect(document.body.textContent).toContain('No sub-agents recorded');
  expect(document.body.textContent).not.toContain('Loading conversation');
});

it('opens the selected worker only through explicit full-chat navigation', async () => {
  const installed = installRendererDom({ getSession: () => ok({ summary: worker(), events: [], total: 0, nextFrom: 1 }) }); dom = installed.dom;
  const { AgentPanel } = await import('../src/renderer/components/chat/agent-panel.js'); root = await createRendererRoot(installed.container);
  const openMain = vi.fn(), onOpenChange = vi.fn();
  await act(async () => { root!.render(createElement(AgentPanel, { parentSessionId: 'prime-a', workers: [worker()], open: true, onOpenChange, onOpenMain: openMain })); await flushReact(); });
  const row = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Inspect the renderer'))!;
  await act(async () => { row.click(); await flushReact(); });
  const open = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Open full chat')!;
  expect(openMain).not.toHaveBeenCalled();
  await act(async () => { open.click(); await flushReact(); });
  expect(openMain).toHaveBeenCalledWith('worker-session');
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
