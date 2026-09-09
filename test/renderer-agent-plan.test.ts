import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderAgentPlan } from '../src/renderer/agent-plan.js';
import type { AgentPlan } from '../src/shared/agent-plan.js';

let dom: JSDOM, host: HTMLElement;
const plan: AgentPlan = { updatedAt: 1, explanation: 'Verify the change', plan: [
  { step: 'Inspect the source', status: 'completed', details: 'Read the current callers.' },
  { step: 'Repair ownership', status: 'in_progress', details: '<img src=x onerror=alert(1)>\nKeep the same session.' },
  { step: 'Verify behavior', status: 'pending' }
] };
beforeEach(() => { dom = new JSDOM('<section id="plan"></section>'); vi.stubGlobal('document', dom.window.document); host = document.getElementById('plan')!; });
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });

it('shows headlines, safely expands details, and retains disclosure state across status updates', () => {
  renderAgentPlan(host, 'a', plan);
  expect(host.hidden).toBe(false);
  expect(host.querySelector('.agent-plan-count')?.textContent).toBe('1 / 3');
  expect(host.querySelector('img')).toBeNull();
  const row = host.querySelectorAll<HTMLDetailsElement>('[data-step]')[1]!;
  expect(row.open).toBe(false);
  row.open = true;
  renderAgentPlan(host, 'a', { ...plan, updatedAt: 2, plan: plan.plan.map(step => ({ ...step, status: 'completed' })) });
  expect(host.querySelectorAll<HTMLDetailsElement>('[data-step]')[1]!.open).toBe(true);
  expect(host.querySelector('.agent-plan-title')?.textContent).toBe('Plan complete');
  expect(host.querySelectorAll('.agent-plan-details')[1]?.textContent).toContain('<img src=x');
});

it('clears other chats immediately and does not inherit their expanded state', () => {
  renderAgentPlan(host, 'a', plan);
  host.querySelector<HTMLDetailsElement>('[data-step]')!.open = true;
  renderAgentPlan(host, 'b', null);
  expect(host.hidden).toBe(true);
  expect(host.childElementCount).toBe(0);
  renderAgentPlan(host, 'b', plan);
  expect(host.querySelector<HTMLDetailsElement>('[data-step]')!.open).toBe(false);
  renderAgentPlan(host, 'b', { updatedAt: 2, plan: [] });
  expect(host.hidden).toBe(true);
});
