import { ui, t } from './i18n.js';
import type { AgentInfo, SessionSummary, SessionEvent } from '../shared/session.js';
import { workerReportedFinish } from '../shared/session-activity.js';
import { evaluateWorkerOverviewHealth } from '../shared/agent-health.js';
import { compactNumber, el, icon } from './dom.js';
import { attachWorkPanelResize } from './work-panel-resize.js';
import { workerAvatar } from './agent-communication.js';

/** A read-only second pane. Its selection never changes the main chat's composer. */
export function createAgentPanel(options: {
  host: HTMLElement;
  mount?: HTMLElement;
  toggle?: HTMLButtonElement;
  onShow?: () => void;
  onEscape?: () => void;
  load: (id: string) => Promise<{ events: SessionEvent[] } | null>;
  render: (events: SessionEvent[], id: string, current: () => boolean) => HTMLElement[];
  openMain: (id: string) => void;
  working: (summary: SessionSummary) => boolean;
  agent?: (summary: SessionSummary) => (Pick<AgentInfo, 'state' | 'task'> & { conversationId?: string | null }) | null;
}) {
  const pane = el('aside', 'agent-panel'); pane.hidden = true;
  ui(pane, 'aria-label', () => t("Sub-agents"));
  if (!options.mount) attachWorkPanelResize(options.host, pane);
  const head = el('div', 'agent-panel-header'); head.hidden = true;
  const back = el('button', 'btn btn-icon agent-back'); back.append(icon('i-back'));
  ui(back, 'title', () => t("Back to sub-agents")); back.setAttribute('type', 'button');
  ui(back, 'aria-label', () => t("Back to sub-agents"));
  const title = el('strong');
  const body = el('div', 'agent-panel-body');
  head.append(back, title); pane.append(head, body); (options.mount ?? options.host).append(pane);
  let parent: string | null = null, workers: SessionSummary[] = [], selected: string | null = null;
  let generation = 0;
  let highlighted = new Set<string>();
  function hide(): void {
    generation++; selected = null; highlighted.clear(); pane.hidden = true;
    if (!options.mount) options.host.classList.remove('has-agent-panel');
    options.toggle?.setAttribute('aria-expanded', 'false');
  }
  function show(): void {
    options.onShow?.();
    pane.hidden = false;
    if (!options.mount) options.host.classList.add('has-agent-panel');
    options.toggle?.setAttribute('aria-expanded', 'true');
  }
  function list(): void {
    generation++; selected = null; head.hidden = true; body.replaceChildren();
    const isActive = (worker: SessionSummary): boolean => {
      const state = options.agent?.(worker)?.state;
      return state ? ['invited', 'active', 'detached', 'waking'].includes(state) : options.working(worker);
    };
    for (const active of [true, false]) {
      const group = workers.filter(worker => isActive(worker) === active);
      const failed = active ? 0 : group.filter(worker => options.agent?.(worker)?.state === 'failed').length;
      body.append(el('h3', '', () =>
        `${active ? t("Active") : t("History")} · ${group.length}${failed ? ` · ${t('{0} failed', [failed])}` : ''}`));
      if (!group.length) { body.append(el('p', 'meta', () => active ? t("No active sub-agents") : t("No recorded sub-agents"))); continue; }
      for (const worker of group) {
        const row = el('button', 'agent-panel-row'); row.setAttribute('type', 'button');
        row.dataset.workerSession = worker.id;
        row.classList.toggle('is-round-worker', highlighted.has(worker.id));
        const owner = options.agent?.(worker);
        const state = owner?.state ?? (workerReportedFinish(worker) ? 'sleeping' : active ? 'working' : 'history');
        row.dataset.state = state;
        const health = evaluateWorkerOverviewHealth({
          state: owner?.state ?? null,
          exactIdentity: Boolean(owner?.conversationId && worker.conversationId &&
            owner.conversationId === worker.conversationId),
          working: options.working(worker),
          activeTurn: worker.activeTurnId !== null && worker.activeTurnId !== undefined
        });
        row.dataset.health = health.health;
        const identity = worker.origin?.agentId ?? worker.title.split(' · ')[0] ?? worker.title;
        const task = owner?.task?.trim();
        const original = worker.origin?.task || worker.title;
        // A worker still opening has no conversation yet; undefined === undefined must not read a model.
        const model = worker.selectedModel && worker.conversationId && worker.selectedModel.conversationId === worker.conversationId
          ? [worker.selectedModel.model, worker.selectedModel.reasoningEffort].filter(Boolean).join(' · ') : '';
        const elapsedMs = Math.max(0, (active ? Date.now() : worker.endedAt ?? worker.updatedAt) - worker.startedAt);
        const elapsed = elapsedMs < 60_000 ? `${Math.floor(elapsedMs / 1000)}s`
          : elapsedMs < 3_600_000 ? `${Math.floor(elapsedMs / 60_000)}m` : `${Math.floor(elapsedMs / 3_600_000)}h`;
        const avatar = workerAvatar(worker.origin?.agentId ?? '•');
        const content = el('span', 'agent-card-content');
        const heading = el('span', 'agent-card-heading');
        heading.append(el('span', 'agent-status-dot'), el('strong', 'agent-card-name', identity));
        if (model) heading.append(el('span', 'agent-card-model', model));
        const statusLabel: Record<string, string> = { working: 'Working', history: 'History', invited: 'opening', detached: 'no tab' };
        const meta = el('span', 'agent-card-meta');
        const healthText = el('span', 'agent-card-health', () => {
          if (health.health === 'healthy') return t('Healthy');
          if (health.health === 'degraded') return t('Degraded');
          return t('Unknown');
        });
        const actionMeta = t('{0} actions · {1}', [compactNumber(worker.toolCalls ?? 0), elapsed]);
        meta.append(document.createTextNode(`${t(statusLabel[state] ?? state)} · `), healthText,
          document.createTextNode(` · ${actionMeta}`));
        const activity = worker.lastToolActivity
          ? el('span', 'agent-card-activity', worker.lastToolActivity.title)
          : null;
        if (activity) activity.dataset.kind = worker.lastToolActivity!.kind;
        content.append(
          heading,
          el('span', 'agent-card-task', () => task || `${t('Original assignment')}: ${original}`),
          ...(activity ? [activity] : []),
          meta
        );
        row.append(avatar, content);
        row.title = task || original;
        row.onclick = () => void open(worker.id);
        body.append(row);
      }
    }
  }
  async function open(id: string, refresh = false): Promise<void> {
    const worker = workers.find(row => row.id === id);
    if (!worker) return;
    const preserve = refresh && selected === id && !pane.hidden;
    if (!refresh) show();
    selected = id; const request = ++generation;
    head.hidden = false; title.textContent = worker.title;
    if (!preserve) body.replaceChildren(el('p', 'meta', () => t("Loading conversation…")));
    const current = () => request === generation && selected === id && !pane.hidden;
    const detail = await options.load(id);
    if (!current()) return;
    if (!detail) { body.replaceChildren(el('p', 'meta', () => t("Conversation unavailable"))); return; }
    const openMain = el('button', 'btn', () => t("Open full chat")); openMain.setAttribute('type', 'button');
    openMain.onclick = () => { if (current()) { hide(); options.openMain(id); } };
    const position = body.scrollTop;
    const follow = !preserve || position + body.clientHeight >= body.scrollHeight - 40;
    body.replaceChildren(openMain, ...options.render(detail.events, id, current));
    body.scrollTop = follow ? body.scrollHeight : position;
  }
  back.onclick = list;
  pane.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); hide();
    if (options.onEscape) options.onEscape(); else options.toggle?.focus();
  });
  if (options.toggle) options.toggle.onclick = () => { if (pane.hidden) { show(); list(); } else hide(); };
  return {
    hide,
    show: () => { highlighted.clear(); show(); list(); },
    showWorkers(ids: string[]): void {
      highlighted = new Set(workers.filter(worker => ids.includes(worker.id)).map(worker => worker.id));
      if (!highlighted.size) return;
      show(); list();
      body.querySelector<HTMLButtonElement>('.is-round-worker')?.focus({ preventScroll: true });
    },
    open,
    update(id: string | null, next: SessionSummary[]): void {
      if (parent !== id) { hide(); parent = id; }
      const previous = workers.find(worker => worker.id === selected);
      workers = next;
      highlighted = new Set([...highlighted].filter(id => workers.some(worker => worker.id === id)));
      if (options.toggle) {
        options.toggle.hidden = id === null;
        ui(options.toggle, 'title', () => t("Sub-agents · {0} recorded", [workers.length]));
      }
      if (pane.hidden) return;
      const latest = workers.find(worker => worker.id === selected);
      if (!selected || !latest) list();
      else if (latest.updatedAt !== previous?.updatedAt) void open(latest.id, true);
    }
  };
}
