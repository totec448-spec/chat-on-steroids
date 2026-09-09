import type { AgentPlan } from '../shared/agent-plan.js';
import { el, icon } from './dom.js';

/** One current plan above the composer queue; every model string is text, never HTML. */
export function renderAgentPlan(host: HTMLElement, sessionId: string | null, plan: AgentPlan | null): void {
  if (host.dataset.sessionId !== (sessionId ?? '')) {
    host.replaceChildren();
    host.dataset.sessionId = sessionId ?? '';
    delete host.dataset.signature;
  }
  host.hidden = !sessionId || !plan?.plan.length;
  if (host.hidden || !plan) {
    host.replaceChildren();
    delete host.dataset.signature;
    return;
  }
  const signature = JSON.stringify([plan.plan, plan.explanation]);
  if (host.dataset.signature === signature) return;
  const previous = host.querySelector<HTMLDetailsElement>('.agent-plan-shell');
  const expanded = new Map([...host.querySelectorAll<HTMLDetailsElement>('[data-step]')].map(row => [row.dataset.step, row.open]));
  const focused = (document.activeElement?.closest('[data-step]') as HTMLElement | null)?.dataset.step;
  const completed = plan.plan.filter(step => step.status === 'completed').length;
  const shell = el('details', 'agent-plan-shell') as HTMLDetailsElement;
  shell.open = previous?.open ?? completed < plan.plan.length;
  const heading = el('summary', 'agent-plan-heading');
  heading.append(icon('i-steps'), el('span', 'agent-plan-title', completed === plan.plan.length ? 'Plan complete' : 'Plan'),
    el('span', 'agent-plan-count', `${completed} / ${plan.plan.length}`));
  shell.append(heading);
  const body = el('div', 'agent-plan-body');
  if (plan.explanation) body.append(el('p', 'agent-plan-explanation', plan.explanation));
  for (const [index, step] of plan.plan.entries()) {
    const row = el('details', 'agent-plan-step') as HTMLDetailsElement;
    row.dataset.step = step.step;
    row.dataset.status = step.status;
    row.open = expanded.get(step.step) ?? false;
    const summary = el('summary', 'agent-plan-step-heading');
    const marker = el('span', 'agent-plan-marker', step.status === 'completed' ? '✓' : String(index + 1));
    marker.setAttribute('aria-label', step.status === 'in_progress' ? 'In progress' : step.status === 'completed' ? 'Completed' : 'Pending');
    summary.append(marker, el('span', 'agent-plan-step-title', step.step));
    if (!step.details) summary.addEventListener('click', event => event.preventDefault());
    row.append(summary);
    if (step.details) row.append(el('div', 'agent-plan-details', step.details));
    body.append(row);
    if (focused === step.step) queueMicrotask(() => { if (row.isConnected) summary.focus(); });
  }
  shell.append(body);
  host.replaceChildren(shell);
  host.dataset.signature = signature;
}
