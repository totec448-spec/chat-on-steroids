import { ui, t } from './i18n.js';
import type { AgentInfo, SessionSummary, SessionEvent, SwarmState } from '../shared/session.js';
import { el, icon } from './dom.js';
import { attachWorkPanelResize } from './work-panel-resize.js';
import { hideSlidingPanel, showSlidingPanel } from './panel-motion.js';

const LIVE_STATES = new Set<AgentInfo['state']>(['invited', 'active', 'detached', 'waking']);
const STATE_LABEL: Record<AgentInfo['state'], string> = {
  invited: 'Starting',
  active: 'active',
  detached: 'no tab',
  sleeping: 'sleeping',
  waking: 'waking',
  finished: 'finished',
  failed: 'failed'
};

interface WorkerRow {
  agent: AgentInfo | null;
  session: SessionSummary | null;
}

/** A read-only second pane. Broker lifecycle is authoritative; recordings add transcript detail. */
export function createAgentPanel(options: {
  host: HTMLElement;
  toggle: HTMLButtonElement;
  onShow?: () => void;
  load: (id: string) => Promise<{ events: SessionEvent[] } | null>;
  render: (events: SessionEvent[], id: string, current: () => boolean) => HTMLElement[];
  openMain: (id: string) => void;
}) {
  const pane = el('aside', 'agent-panel'); pane.hidden = true;
  ui(pane, 'aria-label', () => t('Sub-agents'));
  attachWorkPanelResize(options.host, pane);
  const head = el('div', 'agent-panel-header'); head.hidden = true;
  const back = el('button', 'btn'); back.append(icon('i-back')); ui(back, 'title', () => t('Back to sub-agents')); back.setAttribute('type', 'button');
  back.setAttribute('aria-label', back.title);
  const title = el('strong');
  const body = el('div', 'agent-panel-body');
  head.append(back, title); pane.append(head, body); options.host.append(pane);
  let parent: string | null = null, sessions: SessionSummary[] = [], broker: SwarmState | null = null, selected: string | null = null;
  let generation = 0;

  function rows(): WorkerRow[] {
    const remaining = new Map(sessions.map(session => [session.id, session]));
    const result: WorkerRow[] = [];
    for (const agent of broker?.agents.filter(entry => entry.role === 'worker') ?? []) {
      const session = agent.conversationId
        ? sessions.find(entry => entry.conversationId === agent.conversationId) ?? null
        : null;
      if (session) remaining.delete(session.id);
      result.push({ agent, session });
    }
    for (const session of remaining.values()) result.push({ agent: null, session });
    return result;
  }

  function hide(instant = false): void {
    generation++; hideSlidingPanel(pane, 'right', instant); selected = null;
    options.host.classList.remove('has-agent-panel'); options.toggle.setAttribute('aria-expanded', 'false');
  }
  function show(): void {
    options.onShow?.();
    if (pane.hidden) showSlidingPanel(pane, 'right');
    options.host.classList.add('has-agent-panel'); options.toggle.setAttribute('aria-expanded', 'true');
  }
  function list(): void {
    generation++; selected = null; head.hidden = true; body.replaceChildren();
    const workers = rows();
    for (const active of [true, false]) {
      const group = workers.filter(worker => worker.agent ? LIVE_STATES.has(worker.agent.state) === active : !active);
      body.append(el('h3', '', () => `${active ? t('Active') : t('History')} · ${group.length}`));
      if (!group.length) { body.append(el('p', 'meta', () => active ? t('No active sub-agents') : t('No recorded sub-agents'))); continue; }
      for (const worker of group) {
        const row = el(worker.session ? 'button' : 'div', 'agent-panel-row');
        if (worker.session) {
          row.setAttribute('type', 'button');
          row.onclick = () => void open(worker.session!.id);
        } else row.setAttribute('role', 'status');
        const identity = worker.agent?.id ?? worker.session?.origin?.agentId ?? worker.session?.title ?? 'worker';
        const avatar = el('span', 'agent-avatar'); avatar.append(icon('i-agent', 'ph-agent-avatar'));
        avatar.dataset.color = String([...identity].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6);
        avatar.setAttribute('aria-hidden', 'true');
        const copy = el('span', 'agent-panel-copy');
        const top = el('span', 'agent-panel-row-title');
        top.append(el('strong', '', worker.agent?.label || worker.session?.title || identity));
        if (worker.agent) top.append(el('span', `chip is-${worker.agent.state}`, () => t(STATE_LABEL[worker.agent!.state])));
        const task = worker.agent?.task || worker.session?.origin?.task || '';
        copy.append(top);
        if (task) copy.append(el('span', 'agent-panel-task', task));
        if (worker.agent?.state === 'failed' && worker.agent.result) copy.append(el('span', 'agent-panel-error', worker.agent.result));
        row.append(avatar, copy);
        row.title = [worker.agent?.label || worker.session?.title || identity, task, worker.agent?.result].filter(Boolean).join(' · ');
        body.append(row);
      }
    }
  }
  async function open(id: string, refresh = false): Promise<void> {
    const worker = sessions.find(row => row.id === id);
    if (!worker) return;
    const preserve = refresh && selected === id && !pane.hidden;
    show(); selected = id; const request = ++generation;
    head.hidden = false; title.textContent = worker.title;
    if (!preserve) body.replaceChildren(el('p', 'meta', () => t('Loading conversation…')));
    const current = () => request === generation && selected === id && !pane.hidden;
    const detail = await options.load(id);
    if (!current()) return;
    if (!detail) { body.replaceChildren(el('p', 'meta', () => t('Conversation unavailable'))); return; }
    const openMain = el('button', 'btn', () => t('Open full chat')); openMain.setAttribute('type', 'button');
    openMain.onclick = () => { hide(); options.openMain(id); };
    const position = body.scrollTop;
    const follow = !preserve || position + body.clientHeight >= body.scrollHeight - 40;
    body.replaceChildren(openMain, ...options.render(detail.events, id, current));
    body.scrollTop = follow ? body.scrollHeight : position;
  }
  back.onclick = list;
  pane.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); hide(); options.toggle.focus();
  });
  options.toggle.onclick = () => { if (pane.hidden) { show(); list(); } else hide(); };
  return {
    hide,
    open,
    update(id: string | null, next: SessionSummary[], state: SwarmState | null): void {
      if (parent !== id) { hide(true); parent = id; }
      const previous = sessions.find(worker => worker.id === selected);
      sessions = next; broker = state; options.toggle.hidden = id === null;
      ui(options.toggle, 'title', () => `${t('Sub-agents')} · ${rows().length}`);
      if (pane.hidden) return;
      const latest = sessions.find(worker => worker.id === selected);
      if (!selected || !latest) list();
      else if (latest.updatedAt !== previous?.updatedAt) void open(latest.id, true);
    }
  };
}
