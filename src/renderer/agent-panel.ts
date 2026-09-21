import { ui, t } from './i18n.js';
import type { SessionSummary, SessionEvent } from '../shared/session.js';
import { el } from './dom.js';
import { attachWorkPanelResize } from './work-panel-resize.js';
import { slideTransition } from './slide-transition.js';

/** A read-only second pane. Its selection never changes the main chat's composer. */
export function createAgentPanel(options: {
  host: HTMLElement;
  toggle: HTMLButtonElement;
  onShow?: () => void;
  load: (id: string) => Promise<{ events: SessionEvent[] } | null>;
  render: (events: SessionEvent[], id: string, current: () => boolean) => HTMLElement[];
  openMain: (id: string) => void;
  working: (summary: SessionSummary) => boolean;
}) {
  const pane = el('aside', 'agent-panel'); pane.hidden = true; pane.inert = true;
  ui(pane, 'aria-label', () => t("Sub-agents"));
  attachWorkPanelResize(options.host, pane);
  const head = el('div', 'agent-panel-header'); head.hidden = true;
  const back = el('button', 'btn', '←'); ui(back, 'title', () => t("Back to sub-agents")); back.setAttribute('type', 'button');
  back.setAttribute('aria-label', back.title);
  const title = el('strong');
  const body = el('div', 'agent-panel-body');
  head.append(back, title); pane.append(head, body); options.host.append(pane);
  let parent: string | null = null, workers: SessionSummary[] = [], selected: string | null = null;
  let generation = 0, openState = false, transition: Animation | null = null;
  function hide(immediate = false): void {
    generation++; selected = null;
    const wasOpen = openState; openState = false; pane.inert = true;
    options.toggle.setAttribute('aria-expanded', 'false');
    transition?.cancel(); transition = null;
    const finish = () => {
      if (openState) return;
      pane.hidden = true;
      options.host.classList.remove('has-agent-panel');
      transition = null;
    };
    if (immediate || pane.hidden || !wasOpen) { finish(); return; }
    transition = slideTransition(pane, 'right', false, finish);
  }
  function show(): void {
    const entering = !openState;
    if (entering) options.onShow?.();
    openState = true; pane.hidden = false; pane.inert = false;
    options.host.classList.add('has-agent-panel'); options.toggle.setAttribute('aria-expanded', 'true');
    if (!entering) return;
    transition?.cancel(); transition = null;
    transition = slideTransition(pane, 'right', true, () => { if (openState) transition = null; });
  }
  function list(): void {
    generation++; selected = null; head.hidden = true; body.replaceChildren();
    for (const active of [true, false]) {
      const group = workers.filter(worker => options.working(worker) === active);
      body.append(el('h3', '', () => `${active ? t("Active") : t("History")} · ${group.length}`));
      if (!group.length) { body.append(el('p', 'meta', () => active ? t("No active sub-agents") : t("No recorded sub-agents"))); continue; }
      for (const worker of group) {
        const row = el('button', 'agent-panel-row'); row.setAttribute('type', 'button');
        row.append(el('span', 'agent-avatar', worker.origin?.agentId?.replace(/^worker-/, '') ?? '•'), el('span', '', worker.title));
        row.title = worker.origin?.task || worker.title;
        row.onclick = () => void open(worker.id); body.append(row);
      }
    }
  }
  async function open(id: string, refresh = false): Promise<void> {
    const worker = workers.find(row => row.id === id);
    if (!worker) return;
    const preserve = refresh && selected === id && openState;
    show(); selected = id; const request = ++generation;
    head.hidden = false; title.textContent = worker.title;
    if (!preserve) body.replaceChildren(el('p', 'meta', () => t("Loading conversation…")));
    const current = () => request === generation && selected === id && openState;
    const detail = await options.load(id);
    if (!current()) return;
    if (!detail) { body.replaceChildren(el('p', 'meta', () => t("Conversation unavailable"))); return; }
    const openMain = el('button', 'btn', () => t("Open full chat")); openMain.setAttribute('type', 'button');
    openMain.onclick = () => { hide(true); options.openMain(id); };
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
  options.toggle.onclick = () => { if (!openState) { show(); list(); } else hide(); };
  return {
    hide,
    open,
    update(id: string | null, next: SessionSummary[]): void {
      if (parent !== id) { hide(true); parent = id; }
      const previous = workers.find(worker => worker.id === selected);
      workers = next; options.toggle.hidden = id === null;
      ui(options.toggle, 'title', () => t("Sub-agents · {0} recorded", [workers.length]));
      if (!openState) return;
      const latest = workers.find(worker => worker.id === selected);
      if (!selected || !latest) list();
      else if (latest.updatedAt !== previous?.updatedAt) void open(latest.id, true);
    }
  };
}
