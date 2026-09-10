import { ui, t } from './i18n.js';
import type { AgentPlan } from '../shared/agent-plan.js';
import { el, icon } from './dom.js';

/** One current plan above the composer queue; every model string is text, never HTML. */
export function renderAgentPlan(host: HTMLElement, sessionId: string | null, plan: AgentPlan | null): void {
  if (host.dataset.sessionId !== (sessionId ?? '')) {
    host.replaceChildren();
    host.dataset.sessionId = sessionId ?? '';
    delete host.dataset.signature;
  }
  if (!sessionId || !plan?.plan.length) {
    host.hidden = true;
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
  const complete = completed === plan.plan.length;
  // Completed documents remain durable, but only a visible unfinished plan celebrates.
  // Reopening a chat/restarting must not resurrect its completed composer card.
  const celebrate = complete && previous?.dataset.complete === 'false';
  host.hidden = complete && !celebrate;
  if (host.hidden) {
    host.replaceChildren();
    host.dataset.signature = signature;
    return;
  }
  const shell = el('details', 'agent-plan-shell') as HTMLDetailsElement;
  shell.dataset.complete = String(complete);
  shell.open = previous?.open ?? completed < plan.plan.length;
  const heading = el('summary', 'agent-plan-heading');
  heading.append(icon('i-steps'), el('span', 'agent-plan-title', () => completed === plan.plan.length ? t("Plan complete") : t("Plan")),
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
    ui(marker, 'aria-label', () => step.status === 'in_progress' ? t("In progress") : step.status === 'completed' ? t("Completed") : t("Pending"));
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
  if (celebrate) {
    const dismiss = () => {
      // A late animation completion cannot hide a newer plan or a different chat.
      if (shell.parentElement !== host) return;
      host.hidden = true;
      host.replaceChildren();
    };
    if (typeof shell.animate !== 'function') { dismiss(); return; }
    const reduced = document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const height = shell.getBoundingClientRect().height;
    const animation = shell.animate(reduced ? [
      { opacity: 1 }, { opacity: 0 }
    ] : [
      { height: `${height}px`, opacity: 1, transform: 'scale(1)', boxShadow: 'inset 0 0 0 0 transparent', offset: 0 },
      { height: `${height}px`, opacity: 1, transform: 'scale(1)', boxShadow: 'inset 0 0 28px 0 rgba(70, 210, 150, .25)', offset: .25 },
      { height: `${height}px`, opacity: 1, transform: 'scale(1)', boxShadow: 'inset 0 0 0 0 transparent', offset: .7 },
      { height: '0px', opacity: 0, transform: 'scale(.98)', boxShadow: 'inset 0 0 0 0 transparent', offset: 1 }
    ], { duration: reduced ? 150 : 1800, easing: 'ease-in-out', fill: 'forwards' });
    animation.finished.then(dismiss, () => undefined);
  }
}
