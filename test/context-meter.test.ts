import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { defaultConfig } from '../src/main/config.js';
import type { SessionSummary } from '../src/shared/session.js';
import { createRendererRoot, flushReact, installRendererDom } from './renderer-react-helpers.js';

let dom: ReturnType<typeof installRendererDom>['dom'] | null = null; let root: Root | null = null;
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = null; dom?.window.close(); dom = null; });
function session(model: string, effort: 'high' | 'pro'): SessionSummary { return { id: 'session-a', title: 'A', conversationId: 'chat-a', chatIds: ['chat-a'], startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0, lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0, estimatedTokens: 0, contextTokens: 100000, lastHandoffId: null, lastHandoffAt: null, lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null, selectedModel: { conversationId: 'chat-a', model, reasoningEffort: effort, observedAt: 2 } }; }

it('keeps Pro visually static and explains that its auto-compaction is off', async () => {
  const installed = installRendererDom({}); dom = installed.dom; const { ContextMeter } = await import('../src/renderer/components/chat/context-meter.js'); root = await createRendererRoot(installed.container);
  const config = defaultConfig('win32'); config.sessions.limitTokens = 200000; config.compaction.autoTokens = 150000;
  await act(async () => { root!.render(createElement(ContextMeter, { session: session('gpt-6', 'pro'), config })); await flushReact(); });
  expect(document.querySelectorAll('circle')[1]!.getAttribute('stroke-dasharray')).toBe('0 100');
  expect(document.body.textContent).toContain('Auto-compaction off for Pro');
  expect(document.querySelector('summary')!.getAttribute('aria-label')).toContain('estimated');
});

it('uses configured context limits for ordinary models', async () => {
  const installed = installRendererDom({}); dom = installed.dom; const { ContextMeter } = await import('../src/renderer/components/chat/context-meter.js'); root = await createRendererRoot(installed.container);
  const config = defaultConfig('win32'); config.sessions.limitTokens = 200000; config.compaction.autoTokens = 150000;
  await act(async () => { root!.render(createElement(ContextMeter, { session: session('gpt-5.6-sol', 'high'), config })); await flushReact(); });
  expect(document.querySelectorAll('circle')[1]!.getAttribute('stroke-dasharray')).toBe('50 100');
  expect(document.body.textContent).toContain('50% of configured limit');
});
