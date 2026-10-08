import type { TurnTrace } from '../shared/turn-trace.js';
import { ui, t } from './i18n.js';
import type { AgentInfo, SessionSummary, SessionEvent } from '../shared/session.js';
import { workerReportedFinish } from '../shared/session-activity.js';
import { evaluateWorkerOverviewHealth } from '../shared/agent-health.js';
import { workerOwnTask } from '../shared/worker-brief.js';
import { compactNumber, el, icon } from './dom.js';
import { attachWorkPanelResize } from './work-panel-resize.js';
import { workerAvatar } from './agent-communication.js';

/**
 * What to call a worker: the name the prime gave it for this job ("Security review"), else
 * "Worker 2". Its id (worker-2) is what the prime and the chat address it by; a label equal to it,
 * which is what a worker reused for new work carries, is no name.
 */
export function workerName(id: string, label: string | undefined): string {
  const given = label?.trim();
  if (given && given !== id) return given;
  const number = /^worker-(\d+)$/.exec(id)?.[1];
  return number ? t('Worker {0}', [number]) : id;
}

/** How long a round's workers glow as the panel opens on them (`agent-arrive` in styles.css). */
const ARRIVAL_MS = 1600;

/** A read-only second pane. Its selection never changes the main chat's composer. */
export function createAgentPanel(options: {
  host: HTMLElement;
  mount?: HTMLElement;
  toggle?: HTMLButtonElement;
  onShow?: () => void;
  onEscape?: () => void;
  load: (id: string) => Promise<{ events: SessionEvent[]; traces?: Record<string, TurnTrace> } | null>;
  render: (events: SessionEvent[], id: string, current: () => boolean, traces: Record<string, TurnTrace>) => HTMLElement[];
  openMain: (id: string) => void;
  working: (summary: SessionSummary) => boolean;
  agent?: (summary: SessionSummary) => (Pick<AgentInfo, 'state' | 'task'> & Partial<Pick<AgentInfo, 'label'>> & { conversationId?: string | null }) | null;
  /** The model as the composer names it ("GPT-6 Sol · Instant"); the raw id without a catalog. */
  modelLabel?: (model: string, reasoningEffort: string | undefined) => string;
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
  // The round's workers glow once as the panel opens on them, not on every repaint after.
  let arriving = false;
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
        if (arriving && highlighted.has(worker.id)) {
          // The glow plays once: the class leaves with it, so a later layout change (closing the
          // sidebar, the dock showing again) has nothing to replay. Reduced motion shows it as
          // still, for the same time.
          row.classList.add('is-arriving');
          const settle = (): void => { row.classList.remove('is-arriving'); };
          row.addEventListener('animationend', settle, { once: true });
          setTimeout(settle, ARRIVAL_MS);
        }
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
        // The worker's own task: the run's shared context, the same for every worker, left out.
        const saved = worker.workerAssignment?.agentId === identity && worker.workerAssignment.conversationId === worker.conversationId
          ? worker.workerAssignment : null;
        const task = workerOwnTask(owner?.task?.trim() || saved?.task || worker.origin?.task || worker.title);
        const name = workerName(identity, owner?.label ?? saved?.label);
        // A worker still opening has no conversation yet; undefined === undefined must not read a model.
        const observed = worker.selectedModel && worker.conversationId && worker.selectedModel.conversationId === worker.conversationId
          ? worker.selectedModel : null;
        const elapsedMs = Math.max(0, (active ? Date.now() : worker.endedAt ?? worker.updatedAt) - worker.startedAt);
        const elapsed = elapsedMs < 60_000 ? `${Math.floor(elapsedMs / 1000)}s`
          : elapsedMs < 3_600_000 ? `${Math.floor(elapsedMs / 60_000)}m` : `${Math.floor(elapsedMs / 3_600_000)}h`;
        const working = state === 'working' || state === 'active';
        // The avatar carries the state: a dot of presence, and while working the app's traveling
        // light around it (the connection capsule's). Its phase follows the clock, so the many
        // repaints of a working list never restart it.
        const portrait = el('span', 'agent-card-avatar');
        portrait.append(workerAvatar(worker.origin?.agentId ?? '•'), el('span', 'agent-card-presence'));
        if (working) portrait.style.setProperty('--phase', `${-(Date.now() % 2400)}ms`);
        const content = el('span', 'agent-card-content');
        const heading = el('span', 'agent-card-heading');
        heading.append(el('strong', 'agent-card-name', name), el('span', 'agent-card-time', elapsed));
        const statusLabel: Record<string, string> = {
          working: 'Working', active: 'Working', invited: 'Opening', waking: 'Waking', detached: 'No tab',
          sleeping: 'Idle', failed: 'Failed', history: 'Finished'
        };
        const meta = el('span', 'agent-card-meta');
        const part = (className: string, text: string | (() => string)): void => {
          if (meta.childElementCount) meta.append(el('span', 'agent-card-sep', '·'));
          meta.append(el('span', className, text));
        };
        part('agent-card-state', () => t(statusLabel[state] ?? state));
        if (observed) part('agent-card-model', () => options.modelLabel?.(observed.model, observed.reasoningEffort)
          ?? [observed.model, observed.reasoningEffort === 'none' ? t('Instant') : observed.reasoningEffort].filter(Boolean).join(' · '));
        // A worker still opening has done nothing yet: no count until there is one.
        if (worker.toolCalls) part('agent-card-actions', () => t('{0} actions', [compactNumber(worker.toolCalls ?? 0)]));
        // Only a problem is worth a word; a healthy or unknown worker says nothing about it, and a
        // failed one has already said it.
        if (health.health === 'degraded' && state !== 'failed') part('agent-card-health', () => t('Degraded'));
        const activityBoundary = Math.max(worker.lastFinishReportAt ?? 0, worker.lastTurnEndAt ?? 0);
        const currentActivity = worker.lastToolCallAt != null && worker.lastToolCallAt > activityBoundary &&
          worker.lastToolCallAt >= (worker.finishTurn?.startedAt ?? 0);
        const activity = working && currentActivity && worker.lastToolActivity ? el('span', 'agent-card-activity', worker.lastToolActivity.title) : null;
        if (activity) {
          activity.dataset.kind = worker.lastToolActivity!.kind;
          activity.style.setProperty('--phase', `${-(Date.now() % 1800)}ms`);
        }
        content.append(heading, el('span', 'agent-card-task', task), ...(activity ? [activity] : []), meta);
        row.append(portrait, content);
        // The id the prime and the chat use for it (worker-2) stays one hover away, and in its avatar.
        row.title = `${identity} · ${task}`;
        row.onclick = () => void open(worker.id);
        body.append(row);
      }
    }
    arriving = false;
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
    body.replaceChildren(openMain, ...options.render(detail.events, id, current, detail.traces ?? {}));
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
    /** Opens the list on a round's workers; `focus` (the keyboard's way in) moves focus to the first. */
    showWorkers(ids: string[], focus = true): void {
      highlighted = new Set(workers.filter(worker => ids.includes(worker.id)).map(worker => worker.id));
      if (!highlighted.size) return;
      arriving = true;
      show(); list();
      if (focus) body.querySelector<HTMLButtonElement>('.is-round-worker')?.focus({ preventScroll: true });
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
