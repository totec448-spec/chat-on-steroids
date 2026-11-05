import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { el, icon, toast } from './dom.js';
import { t, ui } from './i18n.js';
import { onAppearanceChanged } from './appearance.js';
import { enableTabReorder, reorderKey } from './tab-reorder.js';
import { rememberedTerminals, rememberTerminals, type RememberedTerminal } from './terminal-memory.js';
import { isMac, primaryShiftShortcut } from './shortcuts.js';
import type { LocalProject } from '../shared/projects.js';

type Tab = { id: string; projectId: string | null; cwd: string; title: string; node: HTMLElement; term: Terminal; fit: FitAddon;
  ready: boolean; exited: boolean; previous: boolean; queued: number; writes: Promise<void>;
  /** An agent's running command, shown read-only (#1920): never a shell of the person's. */
  agent?: AgentCommand };
/** A command an agent started, as the running-command row knows it. */
export type AgentCommand = { sessionId: string; processId: number; incarnation: number; command: string };
export type WorkspaceTerminalTab = { id: string; title: string; exited: boolean; previous: boolean };

/** A hidden panel retains its shells; each dock owns only the tabs it created, and remembers them for the next launch. */
export function createWorkspaceTerminal(onToggleBottom: () => void, initialMount: HTMLElement,
  options: { id?: string; onEmpty?: () => void; onClosePanel?: () => void;
    dockedTabs?: boolean; onTabsChanged?: () => void;
    /** Adds selected terminal text to the composer; false when nothing was added. */
    onSendSelection?: (text: string) => boolean } = {}) {
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
  /** The person's own shells, which the eight-tab limit counts; agents' tabs have their own eight. */
  const shells = (): number => [...tabs.values()].filter(tab => !tab.agent).length;
  /** Agents' tabs after the person's own, so the two never mix (#1920). */
  const agentsLast = (): void => {
    const order = [...tabs.values()].sort((a, b) => Number(!!a.agent) - Number(!!b.agent));
    tabs.clear(); for (const entry of order) tabs.set(entry.id, entry);
  };
  // Over the selected shell while it has a selection: adds that text to the composer, never sends.
  const send = el('button', 'btn terminal-send') as HTMLButtonElement; send.type = 'button'; send.hidden = true;
  send.append(icon('i-chat'), el('span', '', () => t('Send to chat')));
  ui(send, 'title', () => `${t('Send to chat')} (${primaryShiftShortcut('Enter')})`);
  send.setAttribute('aria-keyshortcuts', isMac() ? 'Meta+Shift+Enter' : 'Control+Shift+Enter');
  if (options.onSendSelection) body.append(send);
  const paintSend = (): void => {
    const tab = selected ? tabs.get(selected) : null;
    send.hidden = !options.onSendSelection || !tab || !tab.term.hasSelection();
  };
  const sendSelection = (tab: Tab): void => {
    if (options.onSendSelection?.(tab.term.getSelection())) { tab.term.clearSelection(); paintSend(); }
  };
  send.addEventListener('click', () => { const tab = selected ? tabs.get(selected) : null; if (tab) sendSelection(tab); });
  const terminalTheme = () => {
    const colors = getComputedStyle(app);
    const background = colors.getPropertyValue('--page').trim(), foreground = colors.getPropertyValue('--ink').trim();
    return { background, foreground, cursor: foreground, cursorAccent: background };
  };
  const stopAppearance = onAppearanceChanged(() => {
    const theme = terminalTheme(), colors = JSON.stringify(theme);
    // The same colors again would only make xterm clear its width cache and measure every character.
    for (const tab of tabs.values()) if (JSON.stringify(tab.term.options.theme) !== colors) tab.term.options.theme = theme;
  });
  let project: LocalProject | null = null, selected: string | null = null, open = false;
  const fit = (): void => {
    const tab = selected ? tabs.get(selected) : null;
    if (!tab || !open || !tab.node.getBoundingClientRect().height) return;
    tab.fit.fit();
    if (tab.ready && !tab.exited && !tab.agent) void window.api.terminalResize(tab.id, Math.min(500, tab.term.cols), Math.min(200, tab.term.rows));
  };
  // xterm keeps Tab as shell input, so a previous-session tab focuses its Start button instead.
  const focusTab = (tab: Tab | undefined): void => {
    if (tab?.previous) tab.node.querySelector<HTMLButtonElement>('.terminal-previous .btn')?.focus(); else tab?.term.focus();
  };
  const setOpen = (value: boolean): void => {
    open = value; panel.hidden = !value;
    if (value) requestAnimationFrame(() => { fit(); if (selected) focusTab(tabs.get(selected)); });
  };
  // Started and previous-session tabs come back after a restart; an exited or failed shell does not,
  // and neither does an agent's command, which does not outlive the app.
  const remember = (): void => rememberTerminals(panel.id, [...tabs.values()]
    .filter(tab => !tab.agent && (tab.previous || (tab.ready && !tab.exited)))
    .map(tab => ({ projectId: tab.projectId, title: tab.title, cwd: tab.cwd })));
  const closeTab = (id: string): void => {
    const tab = tabs.get(id); if (!tab) return;
    tabs.delete(id); tab.term.dispose(); tab.node.remove();
    // Closing an agent's tab only stops watching; the command goes on (Stop is its own button).
    // An older preload may not offer agent output; closing its tab must still work (CodeRabbit on #2052).
    if (tab.agent) void window.api.agentOutputClose?.(id)?.catch(() => undefined); else void window.api.terminalClose(id);
    if (selected === id) selected = [...tabs.keys()].at(-1) ?? null;
    remember(); paint(); fit();
    if (!tabs.size) options.onEmpty?.();
  };
  let tabSignature = '';
  const paint = (): void => {
    for (const tab of tabs.values()) tab.node.hidden = tab.id !== selected;
    // Selection alone updates the pills in place; only a change of tabs, order or titles rebuilds.
    const signature = [...tabs.values()].map(tab => `${tab.id}:${tab.title}:${tab.exited}:${tab.previous}`).join(',');
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
      pick.append(icon('i-terminal'));
      if (tab.agent) pick.append(el('span', 'terminal-agent-badge', () => t('Agent')));
      pick.append(el('span', 'tab-label', () => `${tab.title}${tab.exited ? ` · ${t('exited')}`
        : tab.previous ? ` · ${t('previous session')}` : ''}`));
      pick.type = 'button'; pick.title = tab.agent ? tab.agent.command : tab.title;
      pick.setAttribute('aria-pressed', String(tab.id === selected));
      pick.addEventListener('click', () => { selected = tab.id; paint(); fit(); focusTab(tab); });
      wrapper.append(pick);
      if (tab.agent && !tab.exited) {
        // Stop in the tab itself (#1920), the same action as Stop in the running-command row.
        const agent = tab.agent;
        const stop = button('i-power', 'Stop background process');
        stop.classList.add('terminal-agent-stop');
        stop.addEventListener('click', () => void (async () => {
          stop.disabled = true;
          const reply = await window.api.stopProcess(agent.sessionId, agent.processId, agent.incarnation);
          if (!reply.ok) { stop.disabled = false; toast(t(reply.error)); }
        })());
        wrapper.append(stop);
      }
      const close = button('i-x', tab.agent ? 'Close output' : 'Close terminal');
      close.addEventListener('click', () => closeTab(tab.id));
      wrapper.append(close); tabsHost.append(wrapper);
    }
    empty.hidden = options.dockedTabs || tabs.size > 0; add.disabled = shells() >= 8; paintSend();
    ui(empty, 'textContent', () => project ? t('Open a terminal in this project') : t('New terminal'));
  };
  /** A remembered tab opens inert: its shell starts only from "Start shell here", in its own project. */
  const create = (restored?: RememberedTerminal): string | null => {
    const scope = project; if (shells() >= 8) return null;
    const id = crypto.randomUUID();
    const node = el('div', 'terminal-screen'); body.append(node);
    const term = new Terminal({ theme: terminalTheme(), cursorBlink: true, fontSize: 13, fontFamily: 'Cascadia Code, Consolas, monospace', scrollback: 5000, allowProposedApi: false });
    const addon = new FitAddon(); term.loadAddon(addon); term.open(node);
    const tab: Tab = { id, projectId: restored ? restored.projectId : scope?.id ?? null, cwd: restored?.cwd ?? '',
      title: restored?.title ?? scope?.name ?? t('Terminal'), node, term, fit: addon, ready: false, exited: false,
      previous: !!restored, queued: 0, writes: Promise.resolve() };
    tabs.set(id, tab); selected = id; agentsLast();
    if (!options.dockedTabs && !restored) setOpen(true);
    paint(); fit();
    term.onSelectionChange(() => { if (selected === id) paintSend(); });
    term.onData(data => {
      if (tab.exited || !tab.ready) return;
      if (tab.queued + data.length > 262_144) { toast(t('Terminal input is busy. Try a smaller paste.')); return; }
      tab.queued += data.length;
      // Preserve paste/key order even while main is validating project access.
      for (let at = 0; at < data.length; at += 16_384) {
        const chunk = data.slice(at, at + 16_384);
        tab.writes = tab.writes.then(async () => {
          if (!tabs.has(id) || tab.exited) return;
          const result = await window.api.terminalWrite(id, chunk); if (!result.ok) toast(t(result.error));
        }).catch(error => toast(String(error))).finally(() => { tab.queued -= chunk.length; });
      }
    });
    term.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown' && event.ctrlKey && event.key === '`') { onToggleBottom(); return false; }
      // Keep ordinary Ctrl+C as SIGINT; copy selection using Ctrl+Shift+C.
      if (event.type === 'keydown' && event.ctrlKey && event.code === 'KeyC' && (event.shiftKey || term.hasSelection())) {
        void window.api.writeClipboard(term.getSelection()); return false;
      }
      // Cmd/Ctrl+Shift+Enter does what Send to chat does; without a selection the shell gets the key.
      if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey && (event.ctrlKey || event.metaKey)
        && !event.isComposing && options.onSendSelection && term.hasSelection()) {
        // The composer takes focus within this keydown: its Enter must not land there as a new line.
        event.preventDefault(); sendSelection(tab); return false;
      }
      return true;
    });
    const start = async (): Promise<void> => {
      const result = await window.api.terminalCreate(id, tab.projectId, Math.min(500, term.cols), Math.min(200, term.rows));
      if (!tabs.has(id)) { void window.api.terminalClose(id); return; }
      if (!result.ok) { tab.exited = true; term.writeln(`\r\n${t(result.error)}`); }
      else {
        tab.ready = true; tab.cwd = result.data.cwd; node.title = result.data.cwd;
        if (!restored) tab.title = scope ? `${scope.name} · ${result.data.shell}` : result.data.shell;
      }
      remember(); paint(); fit(); options.onTabsChanged?.(); if (open && selected === id) term.focus();
    };
    if (!restored) { void start(); return id; }
    node.title = restored.cwd;
    const notice = el('div', 'terminal-previous'), resume = el('button', 'btn', () => t('Start shell here')) as HTMLButtonElement;
    resume.type = 'button';
    notice.append(el('strong', '', () => t('Previous session')), el('span', 'terminal-previous-cwd', restored.cwd), resume);
    node.append(notice);
    resume.addEventListener('click', () => {
      if (!tab.previous || !tabs.has(id)) return;
      tab.previous = false; notice.remove(); paint(); fit(); options.onTabsChanged?.(); void start();
    });
    return id;
  };
  /**
   * An agent's command, read-only (#1920): its output so far, then live, then how it ended. Typing does
   * nothing; the tab says so. Opening the same command again selects its tab.
   */
  const openAgent = (agent: AgentCommand): string | null => {
    // No tab for a view this app cannot open (an older preload or a fixture, CodeRabbit on #2052).
    if (typeof window.api.agentOutputOpen !== 'function') return null;
    const existing = [...tabs.values()].find(tab => tab.agent?.processId === agent.processId && tab.agent.incarnation === agent.incarnation);
    if (existing) { selected = existing.id; if (!options.dockedTabs) setOpen(true); paint(); fit(); return existing.id; }
    if (tabs.size - shells() >= 8) { toast(t('Close an agent output tab first')); return null; }
    const id = crypto.randomUUID();
    const node = el('div', 'terminal-screen is-agent'); body.append(node);
    const term = new Terminal({ theme: terminalTheme(), cursorBlink: false, disableStdin: true, fontSize: 13,
      fontFamily: 'Cascadia Code, Consolas, monospace', scrollback: 2000, allowProposedApi: false });
    const addon = new FitAddon(); term.loadAddon(addon); term.open(node);
    const label = agent.command.replace(/\s+/g, ' ').trim();
    const tab: Tab = { id, projectId: null, cwd: '', title: label.length > 48 ? `${label.slice(0, 47)}…` : label, node, term, fit: addon,
      ready: true, exited: false, previous: false, queued: 0, writes: Promise.resolve(), agent };
    tabs.set(id, tab); selected = id; agentsLast();
    // No cursor: nothing can be typed here, and a blinking block said otherwise (polish pass, 2.1.51).
    term.write('\x1b[?25l');
    term.writeln(`\x1b[2m${t("Read-only: the agent's command. Typing here does nothing.")}\x1b[0m`);
    term.onSelectionChange(() => { if (selected === id) paintSend(); });
    term.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown' && event.ctrlKey && event.key === '`') { onToggleBottom(); return false; }
      if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && event.code === 'KeyC' && term.hasSelection()) {
        void window.api.writeClipboard(term.getSelection()); return false;
      }
      if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey && (event.ctrlKey || event.metaKey)
        && !event.isComposing && options.onSendSelection && term.hasSelection()) { event.preventDefault(); sendSelection(tab); return false; }
      return true;
    });
    if (!options.dockedTabs) setOpen(true);
    paint(); fit(); options.onTabsChanged?.();
    const failed = (message: string): void => {
      if (!tabs.has(id)) return;
      tab.exited = true; term.writeln(message); paint(); options.onTabsChanged?.();
    };
    void window.api.agentOutputOpen(id, agent.sessionId, agent.processId, agent.incarnation).then(
      reply => { if (!reply.ok) failed(t(reply.error)); },
      // A rejected call says so in its tab instead of leaving it empty (CodeRabbit on #2052).
      () => failed(t('The window is unavailable')));
    return id;
  };
  // An older preload, or a fixture, may not offer agent output: the person's own shells still work.
  const stopAgentEvents = window.api.onAgentOutput?.(event => {
    const tab = tabs.get(event.id); if (!tab?.agent) return;
    if ('data' in event) { tab.term.write(event.data.replace(/\r?\n/g, '\r\n')); return; }
    tab.exited = true;
    const minutes = Math.floor(event.exit.seconds / 60), seconds = event.exit.seconds % 60;
    const after = minutes ? `${t('{0}m', [minutes])} ${t('{0}s', [seconds])}` : t('{0}s', [seconds]);
    tab.term.write(`\r\n\x1b[2m${event.exit.exitCode === null ? t('Ended after {0}', [after]) : t('Exited with {0} after {1}', [event.exit.exitCode, after])}\x1b[0m\r\n`);
    paint(); options.onTabsChanged?.();
  }) ?? (() => undefined);
  const stopEvents = window.api.onTerminalEvent(event => {
    const tab = tabs.get(event.id); if (!tab) return;
    if ('data' in event) tab.term.write(event.data, () => { void window.api.terminalAck(event.id, event.data.length); });
    else { tab.exited = true; tab.term.write(`\r\n[${t('Process exited: {0}', [event.exitCode])}]\r\n`); remember(); paint(); options.onTabsChanged?.(); }
  });
  // Tab order is the map's insertion order; moving a tab rebuilds it in the new order.
  const moveTab = (id: string, index: number): void => {
    const order = [...tabs.values()], from = order.findIndex(tab => tab.id === id); if (from < 0) return;
    const [tab] = order.splice(from, 1); order.splice(Math.max(0, Math.min(order.length, index)), 0, tab!);
    tabs.clear(); for (const entry of order) tabs.set(entry.id, entry);
    remember(); paint(); options.onTabsChanged?.();
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
  window.addEventListener('beforeunload', () => { observer.disconnect(); stopEvents(); stopAgentEvents(); stopAppearance(); for (const tab of tabs.values()) tab.term.dispose(); }, { once: true });
  for (const saved of rememberedTerminals(panel.id)) create(saved);
  paint();
  return {
    update(value: LocalProject | null): void { project = value; paint(); },
    show(mount: HTMLElement, createIfEmpty = true): void {
      if (panel.parentElement !== mount) mount.append(panel);
      setOpen(true);
      if (createIfEmpty && !tabs.size) void create();
    },
    newTab(): string | null { return create(); },
    openAgentOutput: openAgent,
    tabs(): WorkspaceTerminalTab[] { return [...tabs.values()].map(tab => ({ id: tab.id, title: tab.title, exited: tab.exited, previous: tab.previous })); },
    selectTab(id: string): void { if (!tabs.has(id)) return; selected = id; paint(); fit(); if (open) focusTab(tabs.get(id)); },
    closeTab,
    /** Moves a tab among this dock's terminals; the right dock calls it when a terminal tab is dragged past tools. */
    moveTab,
    hide(): void { setOpen(false); },
    visible(): boolean { return open; },
    hasTabs(): boolean { return tabs.size > 0; }
  };
}
