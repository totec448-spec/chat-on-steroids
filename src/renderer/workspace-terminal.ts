import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { el, icon, toast } from './dom.js';
import { t, ui } from './i18n.js';
import { onAppearanceChanged } from './appearance.js';
import { enableTabReorder, reorderKey } from './tab-reorder.js';
import type { LocalProject } from '../shared/projects.js';

type Tab = { id: string; title: string; node: HTMLElement; term: Terminal; fit: FitAddon; ready: boolean; exited: boolean; queued: number; writes: Promise<void> };
export type WorkspaceTerminalTab = { id: string; title: string; exited: boolean };

/** A hidden panel retains its shells; each dock owns only the tabs it created. */
export function createWorkspaceTerminal(onToggleBottom: () => void, initialMount: HTMLElement,
  options: { id?: string; onEmpty?: () => void; onClosePanel?: () => void;
    dockedTabs?: boolean; onTabsChanged?: () => void } = {}) {
  const app = document.querySelector<HTMLElement>('.app')!;
  const panel = el('section', 'workspace-terminal'); panel.id = options.id ?? 'workspaceTerminal'; panel.hidden = true;
  ui(panel, 'aria-label', () => t('Terminal'));
  const bar = el('div', 'terminal-bar'), tabsHost = el('div', 'terminal-tabs'), body = el('div', 'terminal-body');
  const button = (glyph: string, label: string): HTMLButtonElement => {
    const node = el('button', 'btn btn-icon') as HTMLButtonElement; node.type = 'button'; node.append(icon(glyph));
    ui(node, 'title', () => t(label)); ui(node, 'aria-label', () => t(label)); return node;
  };
  const add = button('i-plus', 'New terminal');
  add.id = panel.id === 'workspaceTerminal' ? 'terminalNew' : `${panel.id}New`;
  const addMenu = el('details', 'work-dock-add') as HTMLDetailsElement;
  const addTrigger = el('summary'); addTrigger.append(icon('i-plus'));
  ui(addTrigger, 'title', () => t('New tab')); ui(addTrigger, 'aria-label', () => t('New tab'));
  const addChoices = el('div', 'work-dock-menu');
  add.className = 'btn work-dock-menu-item'; add.replaceChildren(icon('i-terminal'));
  add.append(el('span', '', () => t('Terminal')));
  addChoices.append(add); addMenu.append(addTrigger, addChoices);
  const empty = el('button', 'btn terminal-empty', () => t('Open a terminal in this project')) as HTMLButtonElement;
  empty.type = 'button'; body.append(empty); bar.append(tabsHost, addMenu);
  if (options.onClosePanel) {
    const closePanel = button('i-x', 'Hide bottom panel');
    closePanel.classList.add('terminal-panel-close');
    closePanel.addEventListener('click', options.onClosePanel);
    bar.append(closePanel);
  }
  if (!options.dockedTabs) panel.append(bar);
  panel.append(body); initialMount.append(panel);
  const tabs = new Map<string, Tab>();
  const terminalTheme = () => {
    const colors = getComputedStyle(app);
    const background = colors.getPropertyValue('--page').trim(), foreground = colors.getPropertyValue('--ink').trim();
    return { background, foreground, cursor: foreground, cursorAccent: background };
  };
  const stopAppearance = onAppearanceChanged(() => {
    const theme = terminalTheme();
    for (const tab of tabs.values()) tab.term.options.theme = theme;
  });
  let project: LocalProject | null = null, selected: string | null = null, open = false;
  const fit = (): void => {
    const tab = selected ? tabs.get(selected) : null;
    if (!tab || !open || !tab.node.getBoundingClientRect().height) return;
    tab.fit.fit();
    if (tab.ready && !tab.exited) void window.api.terminalResize(tab.id, Math.min(500, tab.term.cols), Math.min(200, tab.term.rows));
  };
  const setOpen = (value: boolean): void => {
    open = value; panel.hidden = !value;
    if (value) requestAnimationFrame(() => { fit(); if (selected) tabs.get(selected)?.term.focus(); });
  };
  const closeTab = (id: string): void => {
    const tab = tabs.get(id); if (!tab) return;
    tabs.delete(id); tab.term.dispose(); tab.node.remove(); void window.api.terminalClose(id);
    if (selected === id) selected = [...tabs.keys()].at(-1) ?? null;
    paint(); fit();
    if (!tabs.size) options.onEmpty?.();
  };
  let tabSignature = '';
  const paint = (): void => {
    for (const tab of tabs.values()) tab.node.hidden = tab.id !== selected;
    // Selection alone updates the pills in place; only a change of tabs, order or titles rebuilds.
    const signature = [...tabs.values()].map(tab => `${tab.id}:${tab.title}:${tab.exited}`).join(',');
    if (!options.dockedTabs && signature === tabSignature) {
      for (const wrapper of tabsHost.children as HTMLCollectionOf<HTMLElement>) {
        const current = wrapper.dataset.id === selected;
        wrapper.classList.toggle('is-selected', current);
        wrapper.querySelector('.btn')!.setAttribute('aria-pressed', String(current));
      }
    } else if (!options.dockedTabs) { tabSignature = signature; tabsHost.replaceChildren(); }
    for (const tab of tabs.values()) {
      if (options.dockedTabs || tabsHost.childElementCount === tabs.size) continue;
      const wrapper = el('div', `terminal-tab${tab.id === selected ? ' is-selected' : ''}`); wrapper.dataset.id = tab.id;
      const pick = el('button', 'btn') as HTMLButtonElement;
      pick.append(icon('i-terminal'), el('span', 'tab-label', () => `${tab.title}${tab.exited ? ` · ${t('exited')}` : ''}`));
      pick.type = 'button'; pick.title = tab.title;
      pick.setAttribute('aria-pressed', String(tab.id === selected));
      pick.addEventListener('click', () => { selected = tab.id; paint(); fit(); tab.term.focus(); });
      const close = button('i-x', 'Close terminal');
      close.addEventListener('click', () => closeTab(tab.id));
      wrapper.append(pick, close); tabsHost.append(wrapper);
    }
    empty.hidden = options.dockedTabs || tabs.size > 0; add.disabled = tabs.size >= 8;
    ui(empty, 'textContent', () => project ? t('Open a terminal in this project') : t('New terminal'));
  };
  const create = (): string | null => {
    const scope = project; if (tabs.size >= 8) return null;
    const id = crypto.randomUUID();
    const node = el('div', 'terminal-screen'); body.append(node);
    const term = new Terminal({ theme: terminalTheme(), cursorBlink: true, fontSize: 13, fontFamily: 'Cascadia Code, Consolas, monospace', scrollback: 5000, allowProposedApi: false });
    const addon = new FitAddon(); term.loadAddon(addon); term.open(node);
    const tab: Tab = { id, title: scope?.name ?? t('Terminal'), node, term, fit: addon, ready: false, exited: false, queued: 0, writes: Promise.resolve() };
    tabs.set(id, tab); selected = id;
    if (!options.dockedTabs) setOpen(true);
    paint(); fit();
    term.onData(data => {
      if (tab.exited || !tab.ready) return;
      if (tab.queued + data.length > 262_144) { toast(t('Terminal input is busy. Try a smaller paste.')); return; }
      tab.queued += data.length;
      // Preserve paste/key order even while main is validating project access.
      for (let at = 0; at < data.length; at += 16_384) {
        const chunk = data.slice(at, at + 16_384);
        tab.writes = tab.writes.then(async () => {
          if (!tabs.has(id) || tab.exited) return;
          const result = await window.api.terminalWrite(id, chunk); if (!result.ok) toast(result.error);
        }).catch(error => toast(String(error))).finally(() => { tab.queued -= chunk.length; });
      }
    });
    term.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown' && event.ctrlKey && event.key === '`') { onToggleBottom(); return false; }
      // Keep ordinary Ctrl+C as SIGINT; copy selection using Ctrl+Shift+C.
      if (event.type === 'keydown' && event.ctrlKey && event.code === 'KeyC' && (event.shiftKey || term.hasSelection())) {
        void window.api.writeClipboard(term.getSelection()); return false;
      }
      return true;
    });
    void (async () => {
      const result = await window.api.terminalCreate(id, scope?.id ?? null, Math.min(500, term.cols), Math.min(200, term.rows));
      if (!tabs.has(id)) { void window.api.terminalClose(id); return; }
      if (!result.ok) { tab.exited = true; term.writeln(`\r\n${result.error}`); }
      else { tab.ready = true; tab.title = scope ? `${scope.name} · ${result.data.shell}` : result.data.shell; node.title = result.data.cwd; }
      paint(); fit(); options.onTabsChanged?.(); if (open && selected === id) term.focus();
    })();
    return id;
  };
  const stopEvents = window.api.onTerminalEvent(event => {
    const tab = tabs.get(event.id); if (!tab) return;
    if ('data' in event) tab.term.write(event.data, () => { void window.api.terminalAck(event.id, event.data.length); });
    else { tab.exited = true; tab.term.write(`\r\n[${t('Process exited: {0}', [event.exitCode])}]\r\n`); paint(); options.onTabsChanged?.(); }
  });
  // Tab order is the map's insertion order; moving a tab rebuilds it in the new order.
  const moveTab = (id: string, index: number): void => {
    const order = [...tabs.values()], from = order.findIndex(tab => tab.id === id); if (from < 0) return;
    const [tab] = order.splice(from, 1); order.splice(Math.max(0, Math.min(order.length, index)), 0, tab!);
    tabs.clear(); for (const entry of order) tabs.set(entry.id, entry);
    paint(); options.onTabsChanged?.();
  };
  if (!options.dockedTabs) {
    enableTabReorder(tabsHost, { item: '.terminal-tab', key: node => node.dataset.id, move: moveTab });
    tabsHost.addEventListener('keydown', event => {
      const step = reorderKey(event); if (!step || !selected || tabs.size < 2) return;
      event.preventDefault(); event.stopPropagation();
      moveTab(selected, [...tabs.keys()].indexOf(selected) + step);
      tabsHost.querySelector<HTMLButtonElement>('.terminal-tab.is-selected > .btn:first-child')?.focus();
    });
  }
  add.addEventListener('click', () => { addMenu.open = false; void create(); }); empty.addEventListener('click', () => void create());
  addMenu.addEventListener('keydown', event => { if (event.key === 'Escape') { addMenu.open = false; addTrigger.focus(); } });
  document.addEventListener('click', event => { if (addMenu.open && !addMenu.contains(event.target as Node)) addMenu.open = false; });
  const observer = new ResizeObserver(fit); observer.observe(body);
  window.addEventListener('beforeunload', () => { observer.disconnect(); stopEvents(); stopAppearance(); for (const tab of tabs.values()) tab.term.dispose(); }, { once: true });
  paint();
  return {
    update(value: LocalProject | null): void { project = value; paint(); },
    show(mount: HTMLElement, createIfEmpty = true): void {
      if (panel.parentElement !== mount) mount.append(panel);
      setOpen(true);
      if (createIfEmpty && !tabs.size) void create();
    },
    newTab(): string | null { return create(); },
    tabs(): WorkspaceTerminalTab[] { return [...tabs.values()].map(tab => ({ id: tab.id, title: tab.title, exited: tab.exited })); },
    selectTab(id: string): void { if (!tabs.has(id)) return; selected = id; paint(); fit(); if (open) tabs.get(id)?.term.focus(); },
    closeTab,
    hide(): void { setOpen(false); },
    visible(): boolean { return open; },
    hasTabs(): boolean { return tabs.size > 0; }
  };
}
