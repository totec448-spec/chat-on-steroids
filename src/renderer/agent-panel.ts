import { ui, t } from './i18n.js';
import type { SessionSummary, SessionEvent } from '../shared/session.js';
import { el } from './dom.js';

/** A read-only second pane. Its selection never changes the main chat's composer. */
export function createAgentPanel(options: {
  host: HTMLElement;
  toggle: HTMLButtonElement;
  load: (id: string) => Promise<{ events: SessionEvent[] } | null>;
  render: (events: SessionEvent[], id: string, current: () => boolean) => HTMLElement[];
  openMain: (id: string) => void;
  working: (summary: SessionSummary) => boolean;
}) {
  const pane = el('aside', 'agent-panel'); pane.hidden = true;
  ui(pane, 'aria-label', () => t("Sub-agents"));
  const head = el('div', 'agent-panel-header');
  const back = el('button', 'btn', '←'); ui(back, 'title', () => t("Back to sub-agents")); back.setAttribute('type', 'button');
  back.setAttribute('aria-label', back.title);
  const title = el('strong', '', () => t("Sub-agents"));
  const close = el('button', 'btn', '×'); close.setAttribute('type', 'button'); ui(close, 'aria-label', () => t("Close sub-agents"));
  const body = el('div', 'agent-panel-body');
  head.append(back, title, close); pane.append(head, body); options.host.append(pane);
  let parent: string | null = null, workers: SessionSummary[] = [], selected: string | null = null;
  let generation = 0;
  function hide(): void {
    generation++; pane.hidden = true; selected = null;
    options.host.classList.remove('has-agent-panel'); options.toggle.setAttribute('aria-expanded', 'false');
  }
  function show(): void {
    pane.hidden = false; options.host.classList.add('has-agent-panel'); options.toggle.setAttribute('aria-expanded', 'true');
  }
  function list(): void {
    generation++; selected = null; back.hidden = true; ui(title, 'textContent', () => t("Sub-agents")); body.replaceChildren();
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
    const preserve = refresh && selected === id && !pane.hidden;
    show(); selected = id; const request = ++generation;
    back.hidden = false; title.textContent = worker.title;
    if (!preserve) body.replaceChildren(el('p', 'meta', () => t("Loading conversation…")));
    const current = () => request === generation && selected === id && !pane.hidden;
    const detail = await options.load(id);
    if (!current()) return;
    if (!detail) { body.replaceChildren(el('p', 'meta', () => t("Conversation unavailable"))); return; }
    const openMain = el('button', 'btn', () => t("Open full chat")); openMain.setAttribute('type', 'button');
    openMain.onclick = () => { hide(); options.openMain(id); };
    const position = body.scrollTop;
    const follow = !preserve || position + body.clientHeight >= body.scrollHeight - 40;
    body.replaceChildren(openMain, ...options.render(detail.events, id, current));
    body.scrollTop = follow ? body.scrollHeight : position;
  }
  back.onclick = list; close.onclick = hide;
  pane.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); hide(); options.toggle.focus();
  });
  options.toggle.onclick = () => { if (pane.hidden) { show(); list(); } else hide(); };
  return {
    open,
    update(id: string | null, next: SessionSummary[]): void {
      if (parent !== id) { hide(); parent = id; }
      const previous = workers.find(worker => worker.id === selected);
      workers = next; options.toggle.hidden = id === null;
      ui(options.toggle, 'title', () => t("Sub-agents · {0} recorded", [workers.length]));
      if (pane.hidden) return;
      const latest = workers.find(worker => worker.id === selected);
      if (!selected || !latest) list();
      else if (latest.updatedAt !== previous?.updatedAt) void open(latest.id, true);
    }
  };
}
