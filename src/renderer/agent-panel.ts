import { ui, t } from './i18n.js';
import type { AgentInfo, SessionSummary, SessionEvent } from '../shared/session.js';
import { workerReportedFinish } from '../shared/session-activity.js';
import { evaluateWorkerOverviewHealth } from '../shared/agent-health.js';
import { completedTurnIds } from '../shared/markdown-export.js';
import { disclosureChevron, el, icon, run } from './dom.js';

/** Read-only worker execution in the timeline or work dock. Local session ids own cards. */
export function createAgentPanel(options: {
  host: HTMLElement;
  mount?: HTMLElement;
  inline?: boolean;
  toggle?: HTMLButtonElement;
  onShow?: () => void;
  onEscape?: () => void;
  load: (id: string) => Promise<{ events: SessionEvent[] } | null>;
  render: (events: SessionEvent[], id: string, current: () => boolean) => HTMLElement[];
  openMain: (id: string) => void;
  working: (summary: SessionSummary) => boolean;
  agent?: (summary: SessionSummary) => (Pick<AgentInfo, 'state' | 'task'> & { conversationId?: string | null }) | null;
}) {
  const pane = document.createElement('details'); pane.className = 'agent-panel'; pane.hidden = true;
  const summary = el('summary', 'agent-panel-header');
  const title = el('strong'); summary.append(icon('i-agents'), title, disclosureChevron('activity-chevron'));
  const body = el('div', 'agent-panel-body'); pane.append(summary, body); (options.mount ?? options.host).append(pane);
  let parent: string | null = null, workers: SessionSummary[] = [], generation = 0;
  const cards = new Map<string, { card: HTMLDetailsElement; heading: HTMLElement; content: HTMLElement; revision: number; request: number }>();
  function hide(): void { pane.open = false; options.toggle?.setAttribute('aria-expanded', 'false'); }
  function show(): void { if (!parent || (!workers.length && options.inline !== false)) return; options.onShow?.(); pane.open = true; options.toggle?.setAttribute('aria-expanded', 'true'); }
  async function loadWorker(id: string): Promise<void> {
    const entry = cards.get(id); if (!entry) return;
    const epoch = generation, request = ++entry.request;
    const current = () => epoch === generation && cards.get(id) === entry && request === entry.request && entry.card.isConnected;
    if (!entry.content.childElementCount) entry.content.append(el('p', 'meta', () => t('Loading conversation…')));
    const detail = await options.load(id);
    if (!current()) return;
    if (!detail) { entry.content.replaceChildren(el('p', 'meta', () => t('Conversation unavailable'))); return; }
    const openMain = el('button', 'btn agent-chat-open', () => t('Open full chat')) as HTMLButtonElement;
    openMain.type = 'button'; openMain.onclick = () => options.openMain(id);
    const completed = completedTurnIds(detail.events);
    const answer = detail.events.findLast(event => event.kind === 'assistant_message' && event.final && event.turnId && completed.has(event.turnId));
    const report = document.createElement('details'); report.className = 'worker-report';
    const reportTitle = el('summary', 'artifact-chip');
    reportTitle.append(icon('i-file-text'), el('span', '', () => t('Inspect conversation')));
    report.append(reportTitle);
    let rendered = false;
    report.addEventListener('toggle', () => {
      if (!report.open || rendered || !current()) return;
      rendered = true; report.append(...options.render(detail.events, id, current));
    });
    entry.content.replaceChildren(openMain);
    if (answer?.kind === 'assistant_message' && answer.turnId) {
      const download = el('button', 'artifact-chip') as HTMLButtonElement; download.type = 'button';
      const name = `${workers.find(worker => worker.id === id)?.origin?.agentId ?? 'worker'}-report.md`;
      download.append(el('span', 'artifact-type', 'MD'), el('span', '', name),
        el('span', 'meta', `${(new TextEncoder().encode(answer.message.text).length / 1024).toFixed(1)} KB`), icon('i-export'));
      ui(download, 'title', () => t('Save report as Markdown'));
      download.onclick = () => void run(window.api.exportMarkdown({ id, scope: 'answer', turnId: answer.turnId!, target: 'file' }));
      entry.content.append(download);
    }
    entry.content.append(report);
  }
  function paintWorker(worker: SessionSummary): void {
    let entry = cards.get(worker.id);
    if (!entry) {
      const card = document.createElement('details'); card.className = 'agent-panel-row'; card.dataset.sessionId = worker.id;
      const heading = el('summary', 'agent-card-heading');
      const content = el('div', 'agent-worker-content'); card.append(heading, content);
      entry = { card, heading, content, revision: worker.updatedAt, request: 0 }; cards.set(worker.id, entry);
      card.addEventListener('toggle', () => { if (card.open && !content.childElementCount) void loadWorker(worker.id); });
    }
    const owner = options.agent?.(worker), working = options.working(worker);
    const state = owner?.state ?? (workerReportedFinish(worker) ? 'sleeping' : working ? 'working' : 'history');
    entry.card.dataset.state = state;
    const health = evaluateWorkerOverviewHealth({ state: owner?.state ?? null,
      exactIdentity: Boolean(owner?.conversationId && worker.conversationId && owner.conversationId === worker.conversationId),
      working, activeTurn: worker.activeTurnId != null });
    entry.card.dataset.health = health.health;
    const model = worker.selectedModel && worker.conversationId && worker.selectedModel.conversationId === worker.conversationId
      ? [worker.selectedModel.model, worker.selectedModel.reasoningEffort].filter(Boolean).join(' · ') : '';
    const identity = worker.origin?.agentId ?? worker.title;
    const statusLabel: Record<string, string> = { working: 'Working', history: 'History', invited: 'opening', detached: 'no tab' };
    const healthLabel = () => health.health === 'healthy' ? t('Healthy') : health.health === 'degraded' ? t('Degraded') : t('Unknown');
    entry.heading.replaceChildren(el('span', 'agent-status-dot'), el('strong', 'agent-card-name', identity),
      el('span', 'agent-card-state', () => t(statusLabel[state] ?? state)),
      el('span', 'agent-card-task', owner?.task?.trim() || worker.origin?.task || worker.title),
      el('span', 'agent-card-model', model), el('span', 'agent-card-health', healthLabel), disclosureChevron('activity-chevron'));
    entry.card.title = owner?.task?.trim() || worker.origin?.task || worker.title;
    if (entry.revision !== worker.updatedAt && entry.card.open) void loadWorker(worker.id);
    entry.revision = worker.updatedAt;
    body.append(entry.card);
  }
  pane.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); hide(); if (options.onEscape) options.onEscape(); else options.toggle?.focus();
  });
  if (options.toggle) options.toggle.onclick = () => pane.open ? hide() : show();
  return {
    hide, show,
    async open(id: string): Promise<void> {
      const entry = cards.get(id); if (!entry) return;
      show(); entry.card.open = true; await loadWorker(id); entry.card.scrollIntoView?.({ block: 'nearest' });
    },
    update(id: string | null, next: SessionSummary[]): void {
      if (parent !== id) { generation++; hide(); cards.clear(); body.replaceChildren(); parent = id; }
      workers = next;
      const keep = new Set(next.map(worker => worker.id));
      for (const [key, entry] of cards) if (!keep.has(key)) { entry.card.remove(); cards.delete(key); }
      body.querySelector('.agent-panel-empty')?.remove();
      if (!next.length && options.inline === false) body.append(el('p', 'meta agent-panel-empty', () => t('No recorded sub-agents')));
      for (const worker of next) paintWorker(worker);
      ui(title, 'textContent', () => t('Sub-agents · {0} recorded', [workers.length]));
      pane.hidden = !id || (options.inline !== false && !next.length);
      if (options.mount && options.inline !== false) options.mount.hidden = pane.hidden;
      if (options.toggle) options.toggle.hidden = pane.hidden;
    }
  };
}
