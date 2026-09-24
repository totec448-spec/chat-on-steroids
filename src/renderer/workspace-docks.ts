import { el, icon } from './dom.js';
import { t, ui } from './i18n.js';
import { attachWorkPanelResize } from './work-panel-resize.js';

export type RightView = 'files' | 'agents';

/** Owns only workspace placement. File, agent and terminal data remain with their existing owners. */
export function createWorkspaceDocks(host: HTMLElement) {
  const right = el('aside', 'work-dock work-dock-right');
  right.id = 'workDockRight'; right.hidden = true;
  ui(right, 'aria-label', () => t('Right panel'));
  const bar = el('div', 'work-dock-bar');
  const tabs = el('div', 'work-dock-tabs'); tabs.setAttribute('role', 'tablist');
  const add = document.createElement('details'); add.className = 'work-dock-add';
  const plus = document.createElement('summary'); plus.append(icon('i-plus'));
  ui(plus, 'title', () => t('New tab')); ui(plus, 'aria-label', () => t('New tab'));
  const choices = el('div', 'work-dock-menu');
  add.append(plus, choices);
  const expand = el('button', 'btn btn-icon') as HTMLButtonElement;
  expand.type = 'button'; expand.append(icon('i-out'));
  const close = el('button', 'btn btn-icon') as HTMLButtonElement;
  close.type = 'button'; close.append(icon('i-x'));
  ui(close, 'title', () => t('Hide right panel')); ui(close, 'aria-label', () => t('Hide right panel'));
  const body = el('div', 'work-dock-body');
  const empty = el('div', 'work-dock-empty');
  const launch = el('div', 'work-dock-launch');
  empty.append(launch); body.append(empty);
  bar.append(tabs, add, expand, close); right.append(bar, body);
  attachWorkPanelResize(host, right);
  host.append(right);

  const rightToggle = el('button', 'btn btn-icon') as HTMLButtonElement;
  rightToggle.id = 'rightDockToggle'; rightToggle.type = 'button'; rightToggle.append(icon('i-panel-right'));
  ui(rightToggle, 'title', () => t('Toggle right panel')); ui(rightToggle, 'aria-label', () => t('Toggle right panel'));
  rightToggle.setAttribute('aria-controls', right.id);
  const bottomToggle = el('button', 'btn btn-icon') as HTMLButtonElement;
  bottomToggle.id = 'terminalToggle'; bottomToggle.type = 'button'; bottomToggle.append(icon('i-panel-bottom'));
  ui(bottomToggle, 'title', () => t('Toggle bottom panel (Ctrl+`)'));
  ui(bottomToggle, 'aria-label', () => t('Toggle bottom panel'));
  document.getElementById('headerConnect')!.after(rightToggle, bottomToggle);

  const views = new Map<RightView, { label: string; glyph: string; open: () => void; hide: () => void; available: () => boolean }>();
  const opened: RightView[] = [];
  let active: RightView | null = null;
  let expanded = false;
  const paint = (): void => {
    if (active && !views.get(active)?.available()) active = null;
    right.hidden = !host.classList.contains('has-work-dock');
    rightToggle.setAttribute('aria-expanded', String(!right.hidden));
    rightToggle.classList.toggle('is-active', !right.hidden);
    empty.hidden = active !== null;
    tabs.replaceChildren();
    for (const kind of opened) {
      const view = views.get(kind); if (!view) continue;
      const tab = el('div', `work-dock-tab${active === kind ? ' is-selected' : ''}`);
      const pick = el('button', 'btn', () => t(view.label)) as HTMLButtonElement;
      pick.type = 'button'; pick.setAttribute('role', 'tab');
      pick.setAttribute('aria-selected', String(active === kind));
      pick.tabIndex = active === kind ? 0 : -1;
      pick.append(icon(view.glyph));
      pick.addEventListener('click', () => activate(kind));
      const remove = el('button', 'btn btn-icon') as HTMLButtonElement;
      remove.type = 'button'; remove.append(icon('i-x'));
      ui(remove, 'aria-label', () => t('Close tab'));
      remove.addEventListener('click', () => {
        view.hide(); opened.splice(opened.indexOf(kind), 1);
        if (active === kind) { active = null; const previous = opened.at(-1); if (previous) activate(previous); }
        paint();
        (tabs.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? plus).focus();
      });
      tab.append(pick, remove); tabs.append(tab);
    }
    expand.disabled = right.hidden;
    for (const kind of views.keys()) {
      const available = views.get(kind)!.available();
      choices.querySelector<HTMLButtonElement>(`[data-view="${kind}"]`)!.disabled = !available;
      launch.querySelector<HTMLButtonElement>(`[data-view="${kind}"]`)!.disabled = !available;
    }
    ui(expand, 'title', () => t(expanded ? 'Restore right panel' : 'Expand right panel'));
    ui(expand, 'aria-label', () => t(expanded ? 'Restore right panel' : 'Expand right panel'));
  };
  const setOpen = (value: boolean): void => {
    const wasOpen = host.classList.contains('has-work-dock');
    if (wasOpen === value) { paint(); return; }
    if (!value && active) views.get(active)?.hide();
    host.classList.toggle('has-work-dock', value);
    if (!value) { expanded = false; host.classList.remove('is-work-dock-expanded'); }
    paint();
    if (value && active) views.get(active)?.open();
  };
  const activate = (kind: RightView): void => {
    const view = views.get(kind); if (!view || !view.available()) return;
    if (!opened.includes(kind)) opened.push(kind);
    active = kind;
    if (host.classList.contains('has-work-dock')) view.open();
    else setOpen(true);
    paint();
  };
  const adopt = (kind: RightView): void => {
    if (!opened.includes(kind)) opened.push(kind);
    active = kind; host.classList.add('has-work-dock'); paint();
  };
  const register = (kind: RightView, label: string, glyph: string, open: () => void, hide: () => void, available: () => boolean): void => {
    views.set(kind, { label, glyph, open, hide, available });
    const item = el('button', 'btn work-dock-menu-item', () => t(label)) as HTMLButtonElement;
    item.type = 'button'; item.dataset.view = kind; item.prepend(icon(glyph));
    item.addEventListener('click', () => { add.open = false; activate(kind); });
    choices.append(item);
    const shortcut = kind === 'files' ? 'Ctrl+Shift+3' : 'Ctrl+Shift+4';
    const quick = el('button', 'btn work-dock-quick') as HTMLButtonElement;
    quick.type = 'button'; quick.dataset.view = kind; quick.append(icon(glyph), el('span', '', () => t(label)), el('kbd', '', shortcut));
    quick.addEventListener('click', () => activate(kind)); launch.append(quick);
    paint();
  };
  rightToggle.addEventListener('click', () => setOpen(right.hidden === true));
  close.addEventListener('click', () => setOpen(false));
  expand.addEventListener('click', () => {
    expanded = !expanded; host.classList.toggle('is-work-dock-expanded', expanded); paint();
  });
  document.addEventListener('keydown', event => {
    if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || !['3', '4'].includes(event.key)) return;
    event.preventDefault(); activate(event.key === '3' ? 'files' : 'agents');
  });
  document.addEventListener('click', event => { if (add.open && !add.contains(event.target as Node)) add.open = false; });
  tabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !opened.length) return;
    event.preventDefault();
    const index = active ? opened.indexOf(active) : 0;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? opened.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : opened.length - 1)) % opened.length;
    activate(opened[next]!);
    tabs.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  });
  add.addEventListener('keydown', event => {
    if (event.key === 'Escape') { add.open = false; plus.focus(); return; }
    if (!add.open || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const items = [...choices.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]!.focus();
  });
  paint();
  return { body, bottomToggle, register, activate, adopt, setOpen, sync: paint };
}
