import { el, icon } from './dom.js';
import { t, ui } from './i18n.js';
import { attachWorkPanelResize } from './work-panel-resize.js';

export type DockSide = 'right' | 'bottom';
export type DockView = 'files' | 'terminal' | 'agents' | 'review';
type View = { label: string; glyph: string; allowed: DockSide[]; available: () => boolean;
  show: (side: DockSide, mount: HTMLElement) => void; hide: () => void };
type Dock = { side: DockSide; frame: HTMLElement; body: HTMLElement; tabs: HTMLElement;
  menu: HTMLElement; launch: HTMLElement; plus: HTMLElement; toggle: HTMLButtonElement;
  opened: DockView[]; active: DockView | null; open: boolean; tabSignature: string };

/** Placement and tab selection only. Each tool retains its own content and authority. */
export function createWorkspaceDocks(host: HTMLElement) {
  const app = document.querySelector<HTMLElement>('.app')!;
  const views = new Map<DockView, View>();
  const location = new Map<DockView, DockSide>();
  let expanded = false;
  const iconButton = (glyph: string, label: string): HTMLButtonElement => {
    const button = el('button', 'btn btn-icon') as HTMLButtonElement;
    button.type = 'button'; button.append(icon(glyph));
    ui(button, 'title', () => t(label)); ui(button, 'aria-label', () => t(label));
    return button;
  };
  const rightToggle = iconButton('i-panel-right', 'Toggle right panel'); rightToggle.id = 'rightDockToggle';
  const bottomToggle = iconButton('i-panel-bottom', 'Toggle bottom panel (Ctrl+`)'); bottomToggle.id = 'terminalToggle';
  document.getElementById('headerConnect')!.after(rightToggle, bottomToggle);

  const makeDock = (side: DockSide, toggle: HTMLButtonElement): Dock => {
    const frame = el(side === 'right' ? 'aside' : 'section', `work-dock work-dock-${side}`);
    frame.id = side === 'right' ? 'workDockRight' : 'workDockBottom'; frame.hidden = true;
    ui(frame, 'aria-label', () => t(side === 'right' ? 'Right panel' : 'Bottom panel'));
    toggle.setAttribute('aria-controls', frame.id);
    const bar = el('div', 'work-dock-bar');
    const tabs = el('div', 'work-dock-tabs'); tabs.setAttribute('role', 'tablist');
    const add = document.createElement('details'); add.className = 'work-dock-add';
    const plus = el('summary'); plus.append(icon('i-plus'));
    ui(plus, 'title', () => t('New tab')); ui(plus, 'aria-label', () => t('New tab'));
    const menu = el('div', 'work-dock-menu'); add.append(plus, menu);
    const launch = el('div', 'work-dock-launch');
    const empty = el('div', 'work-dock-empty'); empty.append(launch);
    const body = el('div', 'work-dock-body'); body.append(empty);
    const dock: Dock = { side, frame, body, tabs, menu, launch, plus, toggle, opened: [], active: null, open: false, tabSignature: '' };
    bar.append(tabs, add);
    if (side === 'right') {
      const expand = iconButton('i-out', 'Expand right panel');
      expand.addEventListener('click', () => {
        expanded = !expanded; host.classList.toggle('is-work-dock-expanded', expanded);
        ui(expand, 'title', () => t(expanded ? 'Restore right panel' : 'Expand right panel'));
        ui(expand, 'aria-label', () => t(expanded ? 'Restore right panel' : 'Expand right panel'));
      });
      bar.append(expand);
      attachWorkPanelResize(host, frame);
      host.append(frame);
    } else {
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
        drag = { id: event.pointerId, y: event.clientY, height: frame.offsetHeight };
        resize.setPointerCapture(event.pointerId); event.preventDefault();
      });
      resize.addEventListener('pointermove', event => {
        if (drag?.id === event.pointerId) setHeight(drag.height + drag.y - event.clientY);
      });
      resize.addEventListener('pointerup', event => {
        if (drag?.id !== event.pointerId) return;
        drag = null; setHeight(frame.offsetHeight, true);
        if (resize.hasPointerCapture(event.pointerId)) resize.releasePointerCapture(event.pointerId);
      });
      resize.addEventListener('lostpointercapture', () => { drag = null; });
      resize.addEventListener('keydown', event => {
        if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); setHeight(frame.offsetHeight + (event.key === 'ArrowUp' ? 24 : -24), true);
      });
      window.addEventListener('resize', () => setHeight(frame.offsetHeight || saved));
      frame.append(resize); app.append(frame);
    }
    const close = iconButton('i-x', side === 'right' ? 'Hide right panel' : 'Hide bottom panel');
    close.addEventListener('click', () => setOpen(side, false));
    bar.append(close); frame.append(bar, body);
    toggle.addEventListener('click', () => setOpen(side, !dock.open));
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
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !dock.opened.length) return;
      event.preventDefault();
      const index = dock.active ? dock.opened.indexOf(dock.active) : 0;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? dock.opened.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : dock.opened.length - 1)) % dock.opened.length;
      activate(dock.opened[next]!, side);
      tabs.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    });
    return dock;
  };
  const right = makeDock('right', rightToggle), bottom = makeDock('bottom', bottomToggle);
  const dockFor = (side: DockSide): Dock => side === 'right' ? right : bottom;
  const paint = (dock: Dock): void => {
    if (dock.active && !views.get(dock.active)?.available()) {
      views.get(dock.active)?.hide(); dock.active = null;
    }
    dock.frame.hidden = !dock.open;
    dock.toggle.setAttribute('aria-expanded', String(dock.open));
    dock.toggle.classList.toggle('is-active', dock.open);
    dock.body.querySelector<HTMLElement>('.work-dock-empty')!.hidden = dock.active !== null;
    const signature = `${dock.opened.join(',')}|${dock.active ?? ''}`;
    if (signature !== dock.tabSignature) {
      dock.tabSignature = signature;
      dock.tabs.replaceChildren();
      for (const kind of dock.opened) {
      const view = views.get(kind); if (!view) continue;
      const tab = el('div', `work-dock-tab${dock.active === kind ? ' is-selected' : ''}`);
      const pick = el('button', 'btn', () => t(view.label)) as HTMLButtonElement;
      pick.type = 'button'; pick.setAttribute('role', 'tab');
      pick.setAttribute('aria-selected', String(dock.active === kind));
      pick.tabIndex = dock.active === kind ? 0 : -1; pick.append(icon(view.glyph));
      pick.addEventListener('click', () => activate(kind, dock.side));
      const remove = iconButton('i-x', 'Close tab');
      remove.addEventListener('click', () => {
        view.hide(); dock.opened.splice(dock.opened.indexOf(kind), 1); location.delete(kind);
        if (dock.active === kind) {
          dock.active = null; const previous = dock.opened.at(-1);
          if (previous) activate(previous, dock.side);
        }
        paint(dock);
        (dock.tabs.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? dock.plus).focus();
      });
        tab.append(pick, remove); dock.tabs.append(tab);
      }
    }
    for (const kind of views.keys()) {
      const available = views.get(kind)!.available();
      dock.menu.querySelector<HTMLButtonElement>(`[data-view="${kind}"]`)?.toggleAttribute('disabled', !available);
      dock.launch.querySelector<HTMLButtonElement>(`[data-view="${kind}"]`)?.toggleAttribute('disabled', !available);
    }
  };
  const setOpen = (side: DockSide, value: boolean): void => {
    const dock = dockFor(side);
    if (dock.open === value) { paint(dock); return; }
    if (!value && dock.active) views.get(dock.active)?.hide();
    dock.open = value;
    if (side === 'right') {
      host.classList.toggle('has-work-dock', value);
      if (!value) { expanded = false; host.classList.remove('is-work-dock-expanded'); }
    } else app.classList.toggle('has-bottom-dock', value);
    paint(dock);
    if (value && dock.active) views.get(dock.active)?.show(side, dock.body);
  };
  const activate = (kind: DockView, side: DockSide = 'right'): void => {
    const view = views.get(kind);
    if (!view || !view.allowed.includes(side) || !view.available()) return;
    const otherSide = location.get(kind);
    if (otherSide && otherSide !== side) {
      const other = dockFor(otherSide);
      if (other.active === kind) { view.hide(); other.active = null; }
      other.opened.splice(other.opened.indexOf(kind), 1);
      const previous = other.opened.at(-1);
      if (previous && other.open) activate(previous, otherSide);
      paint(other);
    }
    const dock = dockFor(side);
    if (dock.active && dock.active !== kind) views.get(dock.active)?.hide();
    if (!dock.opened.includes(kind)) dock.opened.push(kind);
    dock.active = kind; location.set(kind, side);
    if (dock.open) view.show(side, dock.body);
    else setOpen(side, true);
    paint(dock);
  };
  const adopt = (kind: DockView, side: DockSide = location.get(kind) ?? 'right'): void => {
    const dock = dockFor(side);
    if (!dock.opened.includes(kind)) dock.opened.push(kind);
    dock.active = kind; location.set(kind, side); dock.open = true;
    if (side === 'right') host.classList.add('has-work-dock');
    else app.classList.add('has-bottom-dock');
    paint(dock);
  };
  const register = (kind: DockView, label: string, glyph: string,
    show: (side: DockSide, mount: HTMLElement) => void, hide: () => void,
    available: () => boolean, allowed: DockSide[] = ['right']): void => {
    views.set(kind, { label, glyph, show, hide, available, allowed });
    for (const side of allowed) {
      const dock = dockFor(side);
      const item = el('button', 'btn work-dock-menu-item', () => t(label)) as HTMLButtonElement;
      item.type = 'button'; item.dataset.view = kind; item.prepend(icon(glyph));
      item.addEventListener('click', () => {
        (dock.menu.parentElement as HTMLDetailsElement).open = false; activate(kind, side);
      });
      dock.menu.append(item);
      const shortcut = side === 'right' && ['review', 'terminal', 'files', 'agents'].includes(kind)
        ? `Ctrl+Shift+${['review', 'terminal', 'files', 'agents'].indexOf(kind) + 1}` : side === 'bottom' && kind === 'terminal' ? 'Ctrl+`' : '';
      const quick = el('button', 'btn work-dock-quick') as HTMLButtonElement;
      quick.type = 'button'; quick.dataset.view = kind;
      quick.append(icon(glyph), el('span', '', () => t(label)));
      if (shortcut) quick.append(el('kbd', '', shortcut));
      quick.addEventListener('click', () => activate(kind, side)); dock.launch.append(quick);
      paint(dock);
    }
  };
  document.addEventListener('keydown', event => {
    if (!event.ctrlKey || event.altKey || event.metaKey) return;
    if (!event.shiftKey && event.key === '`') {
      event.preventDefault();
      if (bottom.open && bottom.active === 'terminal') setOpen('bottom', false);
      else activate('terminal', 'bottom');
      return;
    }
    if (!event.shiftKey || !['1', '2', '3', '4'].includes(event.key)) return;
    event.preventDefault(); activate((['review', 'terminal', 'files', 'agents'] as DockView[])[Number(event.key) - 1]!, 'right');
  });
  paint(right); paint(bottom);
  const toggleBottomTerminal = (): void => {
    if (bottom.open && bottom.active === 'terminal') setOpen('bottom', false);
    else activate('terminal', 'bottom');
  };
  return { body: right.body, bottomBody: bottom.body, rightToggle, bottomToggle,
    register, activate, adopt, sideOf: (kind: DockView) => location.get(kind) ?? null,
    setOpen: (value: boolean) => setOpen('right', value), setBottomOpen: (value: boolean) => setOpen('bottom', value),
    toggleBottomTerminal,
    sync: () => { paint(right); paint(bottom); } };
}
