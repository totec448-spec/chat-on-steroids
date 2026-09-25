import { el, icon } from './dom.js';
import { t, ui } from './i18n.js';
import { attachWorkPanelResize } from './work-panel-resize.js';

export type DockView = 'review' | 'files' | 'agents' | 'terminal';
type AdoptableView = Exclude<DockView, 'terminal'>;
type DockTab = AdoptableView | `terminal:${string}`;
type View = { label: string; glyph: string; available: () => boolean;
  show: (mount: HTMLElement) => void; hide: () => void };
type TerminalView = { show: (mount: HTMLElement, createIfEmpty: boolean) => void;
  hide: () => void; canCreate: () => boolean; newTab: () => string | null;
  tabs: () => { id: string; title: string; exited: boolean }[];
  selectTab: (id: string) => void; closeTab: (id: string) => void };
type BottomTerminalView = Pick<TerminalView, 'show' | 'hide'>;

/** The right dock owns tool selection; the bottom dock owns its own terminal view. */
export function createWorkspaceDocks(host: HTMLElement) {
  const app = document.querySelector<HTMLElement>('.app')!;
  const views = new Map<AdoptableView, View>();
  let rightTerminal: TerminalView | null = null, bottomTerminal: BottomTerminalView | null = null;
  let rightOpen = false, bottomOpen = false, expanded = false;
  let opened: DockTab[] = [], active: DockTab | null = null, tabSignature = '';
  const terminalId = (key: DockTab): string | null => key.startsWith('terminal:') ? key.slice('terminal:'.length) : null;
  const terminalKey = (id: string): DockTab => `terminal:${id}`;
  const iconButton = (glyph: string, label: string): HTMLButtonElement => {
    const button = el('button', 'btn btn-icon') as HTMLButtonElement;
    button.type = 'button'; button.append(icon(glyph));
    ui(button, 'title', () => t(label)); ui(button, 'aria-label', () => t(label));
    return button;
  };

  const bottomToggle = iconButton('i-panel-bottom', 'Toggle bottom panel (Ctrl+`)'); bottomToggle.id = 'terminalToggle';
  const rightToggle = iconButton('i-panel-right', 'Toggle right panel'); rightToggle.id = 'rightDockToggle';
  const expandToggle = el('button', 'btn btn-icon') as HTMLButtonElement;
  expandToggle.id = 'rightDockExpand'; expandToggle.type = 'button'; expandToggle.append(icon('i-dock-expand'));
  ui(expandToggle, 'title', () => t(expanded ? 'Restore right panel' : 'Expand right panel'));
  ui(expandToggle, 'aria-label', () => t(expanded ? 'Restore right panel' : 'Expand right panel'));
  expandToggle.hidden = true;
  const controls = el('div', 'header-dock-controls'); controls.append(expandToggle, bottomToggle, rightToggle);
  document.getElementById('headerConnect')!.after(controls);

  const right = el('aside', 'work-dock work-dock-right'); right.id = 'workDockRight'; right.hidden = true;
  ui(right, 'aria-label', () => t('Right panel'));
  rightToggle.setAttribute('aria-controls', right.id);
  const bar = el('div', 'work-dock-bar');
  const tabs = el('div', 'work-dock-tabs'); tabs.setAttribute('role', 'tablist');
  const add = document.createElement('details'); add.className = 'work-dock-add';
  const plus = el('summary'); plus.append(icon('i-plus'));
  ui(plus, 'title', () => t('New tab')); ui(plus, 'aria-label', () => t('New tab'));
  const menu = el('div', 'work-dock-menu'); add.append(plus, menu);
  const launch = el('div', 'work-dock-launch');
  const empty = el('div', 'work-dock-empty'); empty.append(launch);
  const body = el('div', 'work-dock-body'); body.append(empty);
  bar.append(tabs, add); right.append(bar, body);
  attachWorkPanelResize(host, right); host.append(right);

  const bottom = el('section', 'work-dock work-dock-bottom'); bottom.id = 'workDockBottom'; bottom.hidden = true;
  ui(bottom, 'aria-label', () => t('Bottom panel'));
  bottomToggle.setAttribute('aria-controls', bottom.id);
  const resize = el('div', 'terminal-resize');
  resize.tabIndex = 0; resize.setAttribute('role', 'separator');
  resize.setAttribute('aria-orientation', 'horizontal');
  ui(resize, 'aria-label', () => t('Terminal height'));
  const heightKey = 'chat-on-steroids.bottom-panel-height';
  const setHeight = (height: number, save = false): void => {
    const next = Math.round(Math.max(130, Math.min(window.innerHeight * .65, height)));
    app.style.setProperty('--terminal-height', `${next}px`);
    resize.setAttribute('aria-valuenow', String(next));
    if (save) try { localStorage.setItem(heightKey, String(next)); } catch { /* optional */ }
  };
  let saved = 250;
  try { saved = Number(localStorage.getItem(heightKey)) || 250; } catch { /* optional */ }
  setHeight(saved);
  let drag: { id: number; y: number; height: number } | null = null;
  resize.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    drag = { id: event.pointerId, y: event.clientY, height: bottom.offsetHeight };
    resize.setPointerCapture(event.pointerId); event.preventDefault();
  });
  resize.addEventListener('pointermove', event => {
    if (drag?.id === event.pointerId) setHeight(drag.height + drag.y - event.clientY);
  });
  resize.addEventListener('pointerup', event => {
    if (drag?.id !== event.pointerId) return;
    drag = null; setHeight(bottom.offsetHeight, true);
    if (resize.hasPointerCapture(event.pointerId)) resize.releasePointerCapture(event.pointerId);
  });
  resize.addEventListener('lostpointercapture', () => { drag = null; });
  resize.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); setHeight(bottom.offsetHeight + (event.key === 'ArrowUp' ? 24 : -24), true);
  });
  window.addEventListener('resize', () => setHeight(bottom.offsetHeight || saved));
  const bottomBody = el('div', 'work-dock-body'); bottom.append(resize, bottomBody); app.append(bottom);

  const available = (key: DockTab): boolean => {
    const id = terminalId(key);
    return id ? rightTerminal?.tabs().some(tab => tab.id === id) ?? false : views.get(key as AdoptableView)?.available() ?? false;
  };
  const hideView = (key: DockTab): void => {
    if (terminalId(key)) rightTerminal?.hide(); else views.get(key as AdoptableView)?.hide();
  };
  const showView = (key: DockTab): void => {
    const id = terminalId(key);
    if (id) { rightTerminal?.selectTab(id); rightTerminal?.show(body, false); }
    else views.get(key as AdoptableView)?.show(body);
  };
  const refreshControls = (): void => {
    for (const kind of ['review', 'terminal', 'files', 'agents'] as DockView[]) {
      const enabled = kind === 'terminal' ? rightTerminal?.canCreate() ?? false : views.get(kind)?.available() ?? false;
      menu.querySelector<HTMLButtonElement>(`[data-view="${kind}"]`)?.toggleAttribute('disabled', !enabled);
      launch.querySelector<HTMLButtonElement>(`[data-view="${kind}"]`)?.toggleAttribute('disabled', !enabled);
    }
  };
  const paint = (): void => {
    if (active && !available(active)) { hideView(active); active = null; }
    right.hidden = !rightOpen;
    rightToggle.setAttribute('aria-expanded', String(rightOpen)); rightToggle.classList.toggle('is-active', rightOpen);
    expandToggle.hidden = !rightOpen;
    expandToggle.setAttribute('aria-pressed', String(expanded));
    expandToggle.title = t(expanded ? 'Restore right panel' : 'Expand right panel');
    expandToggle.setAttribute('aria-label', expandToggle.title);
    expandToggle.querySelector('use')?.setAttribute('href', expanded ? '#i-dock-restore' : '#i-dock-expand');
    bottom.hidden = !bottomOpen;
    bottomToggle.setAttribute('aria-expanded', String(bottomOpen)); bottomToggle.classList.toggle('is-active', bottomOpen);
    empty.hidden = active !== null;
    bar.hidden = opened.length === 0;
    if (bar.hidden) add.open = false;
    const terminalTabs = rightTerminal?.tabs() ?? [];
    const signature = `${opened.join(',')}|${active ?? ''}|${terminalTabs.map(tab => `${tab.id}:${tab.title}:${tab.exited}`).join(',')}`;
    if (signature !== tabSignature) {
      const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.work-dock-tab');
      const focusedKey = focused && tabs.contains(focused) ? focused.dataset.key : null;
      const focusedClose = focusedKey && (document.activeElement as HTMLElement).classList.contains('btn-icon');
      tabSignature = signature; tabs.replaceChildren();
      for (const key of opened) {
        const id = terminalId(key), terminal = id ? terminalTabs.find(entry => entry.id === id) : null;
        const view = id ? null : views.get(key as AdoptableView);
        if (!terminal && !view) continue;
        const tab = el('div', `work-dock-tab${active === key ? ' is-selected' : ''}`);
        tab.dataset.key = key;
        if (id) tab.dataset.terminalId = id;
        const pick = el('button', 'btn', () => terminal
          ? `${terminal.title}${terminal.exited ? ` · ${t('exited')}` : ''}` : t(view!.label)) as HTMLButtonElement;
        pick.type = 'button'; pick.setAttribute('role', 'tab'); pick.prepend(icon(id ? 'i-terminal' : view!.glyph));
        if (terminal) pick.title = terminal.title;
        pick.setAttribute('aria-selected', String(active === key)); pick.tabIndex = active === key ? 0 : -1;
        pick.addEventListener('click', () => activateKey(key));
        const remove = iconButton('i-x', id ? 'Close terminal' : 'Close tab');
        remove.addEventListener('click', () => {
          if (id) { rightTerminal?.closeTab(id); if (active === key) rightTerminal?.hide(); }
          else view?.hide();
          opened = opened.filter(entry => entry !== key);
          if (active === key) {
            active = null;
            const previous = [...opened].reverse().find(available);
            if (previous) activateKey(previous);
          }
          paint();
          (tabs.querySelector<HTMLButtonElement>('[aria-selected="true"]')
            ?? (bar.hidden ? launch.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? rightToggle : plus)).focus();
        });
        tab.append(pick, remove); tabs.append(tab);
      }
      if (focusedKey) {
        const replacement = [...tabs.children].find(node => (node as HTMLElement).dataset.key === focusedKey);
        (replacement?.querySelector<HTMLButtonElement>(focusedClose ? '.btn:last-child' : '[role=tab]'))?.focus();
      }
    }
    refreshControls();
  };
  const setRightOpen = (value: boolean): void => {
    if (rightOpen === value) { paint(); return; }
    if (!value && active) hideView(active);
    rightOpen = value; host.classList.toggle('has-work-dock', value);
    if (!value) { expanded = false; host.classList.remove('is-work-dock-expanded'); add.open = false; }
    paint();
    if (value && active) showView(active);
  };
  const setBottomOpen = (value: boolean, createIfEmpty = true): void => {
    if (bottomOpen === value) return;
    bottomOpen = value; app.classList.toggle('has-bottom-dock', value); paint();
    if (value) bottomTerminal?.show(bottomBody, createIfEmpty); else bottomTerminal?.hide();
  };
  const activateKey = (key: DockTab): void => {
    if (!available(key)) return;
    if (active && active !== key) hideView(active);
    if (!opened.includes(key)) opened.push(key);
    active = key;
    if (!rightOpen) { rightOpen = true; host.classList.add('has-work-dock'); }
    paint();
    showView(key);
  };
  const newRightTerminal = (): void => {
    if (!rightTerminal?.canCreate()) return;
    const id = rightTerminal.newTab(); if (!id) return;
    activateKey(terminalKey(id));
  };
  const activate = (kind: DockView): void => {
    if (kind === 'terminal') {
      const previous = [...opened].reverse().find(key => terminalId(key) !== null);
      if (previous) activateKey(previous); else newRightTerminal();
    } else activateKey(kind);
  };
  const adopt = (kind: AdoptableView): void => {
    if (active && active !== kind) hideView(active);
    if (!opened.includes(kind)) opened.push(kind);
    active = kind; rightOpen = true; host.classList.add('has-work-dock'); paint();
  };
  const addAction = (kind: DockView, label: string, glyph: string): void => {
    const item = el('button', 'btn work-dock-menu-item', () => t(label)) as HTMLButtonElement;
    item.type = 'button'; item.dataset.view = kind; item.prepend(icon(glyph));
    item.addEventListener('click', () => {
      add.open = false;
      if (kind === 'terminal') newRightTerminal(); else activate(kind);
    }); menu.append(item);
    const quick = el('button', 'btn work-dock-quick') as HTMLButtonElement;
    quick.type = 'button'; quick.dataset.view = kind;
    quick.append(icon(glyph), el('span', '', () => t(label)));
    quick.append(el('kbd', '', `Ctrl+Shift+${['review', 'terminal', 'files', 'agents'].indexOf(kind) + 1}`));
    quick.addEventListener('click', () => activate(kind)); launch.append(quick);
    refreshControls();
  };
  const register = (kind: AdoptableView, label: string, glyph: string,
    show: (mount: HTMLElement) => void, hide: () => void, available: () => boolean): void => {
    views.set(kind, { label, glyph, show, hide, available }); addAction(kind, label, glyph); paint();
  };
  const registerTerminal = (right: TerminalView, bottom: BottomTerminalView): void => {
    rightTerminal = right; bottomTerminal = bottom;
    addAction('terminal', 'Terminal', 'i-terminal'); paint();
  };

  rightToggle.addEventListener('click', () => setRightOpen(!rightOpen));
  bottomToggle.addEventListener('click', () => setBottomOpen(!bottomOpen));
  expandToggle.addEventListener('click', () => {
    if (!rightOpen) return;
    expanded = !expanded; host.classList.toggle('is-work-dock-expanded', expanded);
    paint();
  });
  add.addEventListener('keydown', event => {
    if (event.key === 'Escape') { add.open = false; plus.focus(); return; }
    if (!add.open || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]!.focus();
  });
  document.addEventListener('click', event => { if (add.open && !add.contains(event.target as Node)) add.open = false; });
  tabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !opened.length) return;
    event.preventDefault();
    const index = active ? opened.indexOf(active) : 0;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? opened.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : opened.length - 1)) % opened.length;
    activateKey(opened[next]!); tabs.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  });
  document.addEventListener('keydown', event => {
    if (!event.ctrlKey || event.altKey || event.metaKey) return;
    if (!event.shiftKey && event.key === '`') { event.preventDefault(); setBottomOpen(!bottomOpen); return; }
    if (!event.shiftKey || !['1', '2', '3', '4'].includes(event.key)) return;
    event.preventDefault(); activate((['review', 'terminal', 'files', 'agents'] as DockView[])[Number(event.key) - 1]!);
  });
  paint();
  return { body, bottomBody, rightToggle, bottomToggle, register, registerTerminal, activate, adopt,
    setOpen: setRightOpen, setBottomOpen, toggleBottomTerminal: () => setBottomOpen(!bottomOpen), sync: paint };
}
