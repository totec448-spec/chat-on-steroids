import type { SessionEvent } from '../shared/session.js';
import { toolCallSummary } from '../shared/session.js';
import { positionOf } from '../shared/chronology.js';
import { el } from './dom.js';
import { renderEditCards } from './tool-artifacts.js';

/**
 * Read-only view over the SAME recorded events the chat timeline uses.
 * No local-control HTTP listener, bearer token, polling, or independent tool authority.
 * A navigation epoch prevents late reads for chat A being painted onto chat B (or A→B→A).
 */
const MAX_ROWS = 160;
type Selection = { id: string | null; generation: number };
type Filter = 'tools' | 'all' | 'changes';

export function createLiveViewerPanel(options: {
  selection: () => Selection;
  read: (id: string) => Promise<SessionEvent[] | null>;
}) {
  const pane = el('aside', 'live-viewer-panel');
  pane.hidden = true;
  pane.setAttribute('aria-label', 'Live Viewer');
  const header = el('div', 'live-viewer-header');
  header.append(el('strong', '', 'Live Viewer'), el('span', 'live-viewer-provenance', 'Recorded activity'));
  const controls = el('div', 'live-viewer-controls');
  const kinds: Array<{ value: Filter; label: string }> = [
    { value: 'tools', label: 'Tools' }, { value: 'all', label: 'All' }, { value: 'changes', label: 'Changes' }
  ];
  let filter: Filter = 'tools';
  const buttons = new Map<Filter, HTMLButtonElement>();
  const status = el('div', 'live-viewer-status');
  status.setAttribute('role', 'status');
  const list = el('div', 'live-viewer-list');
  list.setAttribute('aria-label', 'Recorded execution events');
  const foot = el('p', 'live-viewer-foot',
    'CoS-recorded events only. Not token-by-token model output or hidden reasoning.');
  pane.append(header, controls, status, list, foot);

  let visible = false;
  let owner: Selection = { id: null, generation: -1 };
  let loadRevision = 0;
  const records = new Map<number, SessionEvent>();
  const open = new Map<string, boolean>();

  const matches = (event: SessionEvent): boolean =>
    filter === 'all' || (filter === 'tools' && ['tool_call', 'page_tool'].includes(event.kind)) ||
    (filter === 'changes' && event.kind === 'tool_call' && !!event.call.changes?.length);

  const details = (caption: string, text: string, key: string, expanded: boolean): HTMLElement => {
    const item = document.createElement('details');
    item.dataset.key = key;
    item.open = open.get(key) ?? expanded;
    const summary = document.createElement('summary');
    summary.textContent = caption;
    const pre = document.createElement('pre');
    pre.textContent = text.slice(0, 32_000);
    pre.className = 'live-viewer-code';
    item.append(summary, pre);
    item.addEventListener('toggle', () => open.set(key, item.open));
    return item;
  };

  const card = (event: SessionEvent): HTMLElement => {
    const row = el('article', 'live-viewer-row');
    row.dataset.kind = event.kind;
    const heading = el('div', 'live-viewer-row-head');
    const name = event.kind === 'tool_call' ? toolCallSummary(event.call).title :
      event.kind === 'page_tool' ? event.label :
      event.kind === 'turn_start' ? 'Turn started' : event.kind === 'turn_end' ? `Turn ${event.outcome}` :
      event.kind === 'chat_error' ? 'Chat error' : event.kind.replace(/_/g, ' ');
    const title = el('strong', '', name);
    const when = el('time', '', new Date(event.time).toLocaleTimeString());
    heading.append(title, when);
    row.append(heading);

    const position = String(positionOf(event));
    if (event.kind === 'tool_call') {
      const summary = toolCallSummary(event.call);
      const meta = el('div', 'live-viewer-row-meta',
        [event.call.tool, summary.detail, event.call.outcome,
          event.call.durationMs != null ? `${event.call.durationMs} ms` : null].filter(Boolean).join(' · '));
      row.append(meta);
      // The existing recorder owns immutable per-call before/after snapshots. Reuse its
      // diff reader rather than showing a diff against today's mutable filesystem.
      if (event.call.changes?.length && owner.id) {
        const id = owner.id, generation = owner.generation;
        row.append(renderEditCards(event.call, id, () => {
          const current = options.selection();
          return visible && owner.id === id && owner.generation === generation &&
            current.id === id && current.generation === generation;
        }));
      }
      if (event.call.args.text) row.append(details('Arguments / code' + (event.call.args.truncated ? ' (excerpt)' : ''),
        event.call.args.text, `${position}:args`, false));
      if (event.call.result.text) row.append(details('Result' + (event.call.result.truncated ? ' (excerpt)' : ''),
        event.call.result.text, `${position}:result`, false));
    } else if (event.kind === 'turn_end') {
      row.append(el('div', 'live-viewer-row-meta', event.detail ?? event.reason ?? event.outcome));
    } else if ('message' in event && event.message.text) {
      row.append(details('Recorded message', event.message.text, `${position}:message`, false));
    }
    return row;
  };

  const paint = (): void => {
    if (!visible) return;
    const nearEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
    const before = list.scrollTop;
    const rows = [...records.values()].filter(matches)
      .sort((a, b) => positionOf(a) - positionOf(b));
    const next = document.createDocumentFragment();
    if (!owner.id) {
      status.textContent = 'Select a chat to inspect its recorded activity.';
    } else {
      status.textContent = `${rows.length} visible events · ${records.size} recorded events`;
    }
    if (rows.length) {
      for (const event of rows) next.append(card(event));
    } else {
      next.append(el('p', 'live-viewer-empty',
        owner.id ? 'No recorded events match this filter.' : 'Select a chat to view its execution history.'));
    }
    list.replaceChildren(next);
    list.scrollTop = nearEnd ? list.scrollHeight : before;
  };

  for (const kind of kinds) {
    const button = el('button', 'btn live-viewer-filter', kind.label) as HTMLButtonElement;
    button.type = 'button';
    button.dataset.filter = kind.value;
    button.setAttribute('aria-pressed', String(filter === kind.value));
    button.addEventListener('click', () => {
      filter = kind.value;
      for (const [value, choice] of buttons) choice.setAttribute('aria-pressed', String(value === filter));
      paint();
    });
    buttons.set(kind.value, button);
    controls.append(button);
  }

  const accept = (id: string, generation: number, incoming: readonly SessionEvent[]): void => {
    const current = options.selection();
    if (current.id !== id || current.generation !== generation ||
        owner.id !== id || owner.generation !== generation) return;
    let changed = false;
    for (const event of incoming) {
      const position = positionOf(event);
      const old = records.get(position);
      if (!old || event.seq > old.seq) { records.set(position, event); changed = true; }
    }
    // Bounded display cache; the owner's durable session journal is never pruned.
    if (records.size > MAX_ROWS) {
      const oldest = [...records.keys()].sort((a, b) => a - b).slice(0, records.size - MAX_ROWS);
      for (const key of oldest) {
        records.delete(key);
        for (const field of ['args', 'result', 'message']) open.delete(`${key}:${field}`);
      }
    }
    if (changed || records.size === 0) paint();
  };

  const selected = (id: string | null, generation: number): void => {
    owner = { id, generation };
    loadRevision++;
    records.clear();
    open.clear();
    paint();
    if (visible) void load();
  };

  const load = async (): Promise<void> => {
    const current = options.selection();
    if (!visible || !current.id) { paint(); return; }
    const revision = ++loadRevision;
    status.textContent = 'Reading recorded activity…';
    let events: SessionEvent[] | null;
    try { events = await options.read(current.id); } catch { events = null; }
    if (!visible || revision !== loadRevision ||
      options.selection().id !== current.id || options.selection().generation !== current.generation) return;
    if (!events) { status.textContent = 'Recorded activity is temporarily unavailable.'; return; }
    accept(current.id, current.generation, events);
  };

  return {
    show(mount: HTMLElement): void {
      if (pane.parentElement !== mount) mount.append(pane);
      pane.hidden = false;
      visible = true;
      const current = options.selection();
      if (owner.id !== current.id || owner.generation !== current.generation)
        selected(current.id, current.generation);
      else { paint(); void load(); }
    },
    hide(): void { visible = false; pane.hidden = true; loadRevision++; },
    selected,
    sync(id: string, generation: number, incoming: readonly SessionEvent[]): void {
      if (!visible) return;
      accept(id, generation, incoming);
    }
  };
}
