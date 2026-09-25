import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { createWorkspaceDocks } from '../src/renderer/workspace-docks.js';

let dom: JSDOM;
afterEach(() => dom?.window.close());

function setup() {
  dom = new JSDOM('<div class="app"><button id="headerConnect"></button><main data-panel="chat"><article class="is-session"></article></main></div>', { pretendToBeVisual: true });
  Object.assign(globalThis, { document: dom.window.document, window: dom.window });
  const host = document.querySelector<HTMLElement>('main')!;
  return { host, docks: createWorkspaceDocks(host) };
}

it('orders expansion, bottom and right controls; toggles panels and shows expansion only while right is open', () => {
  const { host } = setup();
  const controls = [...document.querySelectorAll<HTMLButtonElement>('.header-dock-controls > button')];
  expect(controls.map(button => button.id)).toEqual(['rightDockExpand', 'terminalToggle', 'rightDockToggle']);
  const right = document.getElementById('workDockRight')!, bottom = document.getElementById('workDockBottom')!;
  expect(controls[0]!.hidden).toBe(true);
  controls[1]!.click(); expect(bottom.hidden).toBe(false);
  expect(bottom.querySelector('.work-dock-empty, .work-dock-quick, .work-dock-add')).toBeNull();
  controls[1]!.click(); expect(bottom.hidden).toBe(true);
  controls[2]!.click(); expect(right.hidden).toBe(false);
  expect(right.querySelector<HTMLElement>('.work-dock-bar')!.hidden).toBe(true);
  expect(right.querySelector<HTMLElement>('.work-dock-empty')!.hidden).toBe(false);
  expect(controls[0]!.hidden).toBe(false);
  expect(controls[0]!.querySelector('use')?.getAttribute('href')).toBe('#i-dock-expand');
  expect(right.querySelector('.work-dock-bar > .btn-icon')).toBeNull();
  host.style.setProperty('--work-panel-width', '410px');
  controls[0]!.click(); expect(host.classList.contains('is-work-dock-expanded')).toBe(true);
  expect(controls[0]!.querySelector('use')?.getAttribute('href')).toBe('#i-dock-restore');
  controls[0]!.click(); expect(host.classList.contains('is-work-dock-expanded')).toBe(false);
  expect(host.style.getPropertyValue('--work-panel-width')).toBe('410px');
  controls[2]!.click(); expect(right.hidden).toBe(true); expect(controls[0]!.hidden).toBe(true);
});

it('enables right quick actions and plus-menu entries from live scope, then opens the chosen tab', () => {
  const { docks } = setup();
  let available = false;
  const files = vi.fn(), hideFiles = vi.fn();
  docks.register('files', 'Files', 'i-folder', files, hideFiles, () => available);
  const quick = document.querySelector<HTMLButtonElement>('#workDockRight .work-dock-quick[data-view=files]')!;
  const menu = document.querySelector<HTMLButtonElement>('#workDockRight .work-dock-menu-item[data-view=files]')!;
  expect(quick.disabled).toBe(true); expect(menu.disabled).toBe(true);
  available = true; docks.sync();
  expect(quick.disabled).toBe(false); expect(menu.disabled).toBe(false);
  document.getElementById('rightDockToggle')!.click();
  quick.click(); expect(files).toHaveBeenCalledOnce();
  const right = document.getElementById('workDockRight')!;
  expect(right.querySelector<HTMLElement>('.work-dock-bar')!.hidden).toBe(false);
  expect(right.querySelectorAll('[role=tab]')).toHaveLength(1);
  expect(right.querySelector('.work-dock-tabs')?.nextElementSibling?.classList.contains('work-dock-add')).toBe(true);
  const selected = right.querySelector<HTMLButtonElement>('[role=tab]')!;
  selected.focus(); docks.sync(); expect(document.activeElement).toBe(selected);
  document.getElementById('rightDockToggle')!.click(); expect(hideFiles).toHaveBeenCalledOnce();
  document.getElementById('rightDockToggle')!.click(); expect(files).toHaveBeenCalledTimes(2);
  right.querySelector<HTMLElement>('.work-dock-add summary')!.click();
  menu.click(); expect(files).toHaveBeenCalledTimes(3);
  expect((right.querySelector('.work-dock-add') as HTMLDetailsElement).open).toBe(false);
  right.querySelector<HTMLButtonElement>('.work-dock-tab .btn:last-child')!.click();
  expect(right.querySelector<HTMLElement>('.work-dock-bar')!.hidden).toBe(true);
  expect(document.activeElement).toBe(quick);
});

it('keeps right and bottom Terminal actions in their own dock', () => {
  const { docks } = setup();
  const rightShow = vi.fn(), rightHide = vi.fn(), bottomShow = vi.fn(), bottomHide = vi.fn();
  const terminalTabs: { id: string; title: string; exited: boolean }[] = [];
  const rightNewTab = vi.fn(() => {
    const id = `pty-${terminalTabs.length + 1}`;
    terminalTabs.push({ id, title: `project · powershell ${id}`, exited: false }); return id;
  });
  const rightCloseTab = vi.fn((id: string) => terminalTabs.splice(terminalTabs.findIndex(tab => tab.id === id), 1));
  const rightSelectTab = vi.fn();
  docks.registerTerminal({ show: rightShow, hide: rightHide, canCreate: () => true, newTab: rightNewTab,
    tabs: () => terminalTabs, selectTab: rightSelectTab, closeTab: rightCloseTab },
    { show: bottomShow, hide: bottomHide });
  const right = document.getElementById('workDockRight')!, bottom = document.getElementById('workDockBottom')!;
  document.getElementById('rightDockToggle')!.click();
  right.querySelector<HTMLElement>('.work-dock-add summary')!.click();
  right.querySelector<HTMLButtonElement>('.work-dock-menu-item[data-view=terminal]')!.click();
  expect(right.hidden).toBe(false); expect(bottom.hidden).toBe(true);
  expect(rightShow).toHaveBeenCalledWith(docks.body, false);
  expect(right.querySelectorAll('[role=tab]')).toHaveLength(1);
  expect(right.querySelector('[data-terminal-id=pty-1] [role=tab]')?.textContent).toContain('powershell');
  right.querySelector<HTMLButtonElement>('.work-dock-quick[data-view=terminal]')!.click();
  expect(rightShow).toHaveBeenCalledTimes(2);
  right.querySelector<HTMLElement>('.work-dock-add summary')!.click();
  right.querySelector<HTMLButtonElement>('.work-dock-menu-item[data-view=terminal]')!.click();
  expect(rightNewTab).toHaveBeenCalledTimes(2); expect(bottom.hidden).toBe(true);
  expect(right.querySelectorAll('[role=tab]')).toHaveLength(2);
  right.querySelector<HTMLButtonElement>('[data-terminal-id=pty-2] .btn:last-child')!.click();
  expect(rightCloseTab).toHaveBeenCalledWith('pty-2');
  expect(right.querySelectorAll('[role=tab]')).toHaveLength(1);
  document.getElementById('rightDockToggle')!.click(); expect(rightHide).toHaveBeenCalled();
  document.getElementById('rightDockToggle')!.click(); expect(rightSelectTab).toHaveBeenLastCalledWith('pty-1');
  document.getElementById('terminalToggle')!.click(); expect(bottom.hidden).toBe(false);
  expect(bottomShow).toHaveBeenCalledWith(docks.bottomBody, true);
  document.getElementById('terminalToggle')!.click(); expect(bottom.hidden).toBe(true); expect(bottomHide).toHaveBeenCalledOnce();
  expect(bottom.querySelector('.work-dock-bar, .work-dock-launch')).toBeNull();
  right.querySelector<HTMLButtonElement>('[data-terminal-id=pty-1] .btn:last-child')!.click();
  expect(rightCloseTab).toHaveBeenLastCalledWith('pty-1');
  expect(right.querySelector<HTMLElement>('.work-dock-bar')!.hidden).toBe(true);
  expect(right.querySelector<HTMLElement>('.work-dock-empty')!.hidden).toBe(false);
  expect(rightHide).toHaveBeenCalled();
});

it('interleaves individual terminal sessions with tools and keeps one selected dock tab', () => {
  const { docks } = setup();
  const terminalTabs: { id: string; title: string; exited: boolean }[] = [];
  const closeTerminal = vi.fn((id: string) => terminalTabs.splice(terminalTabs.findIndex(tab => tab.id === id), 1));
  const selectTerminal = vi.fn(), showFiles = vi.fn(), hideFiles = vi.fn();
  docks.registerTerminal({ show: vi.fn(), hide: vi.fn(), canCreate: () => true,
    newTab: () => { const id = `pty-${terminalTabs.length + 1}`; terminalTabs.push({ id, title: `Shell ${id}`, exited: false }); return id; },
    tabs: () => terminalTabs, selectTab: selectTerminal, closeTab: closeTerminal },
    { show: vi.fn(), hide: vi.fn() });
  docks.register('files', 'Files', 'i-folder', showFiles, hideFiles, () => true);
  const right = document.getElementById('workDockRight')!;
  docks.activate('terminal'); docks.activate('files');
  right.querySelector<HTMLButtonElement>('.work-dock-menu-item[data-view=terminal]')!.click();
  expect([...right.querySelectorAll<HTMLElement>('.work-dock-tab')].map(tab => tab.dataset.terminalId ?? 'files'))
    .toEqual(['pty-1', 'files', 'pty-2']);
  expect(right.querySelectorAll('[role=tab][aria-selected=true]')).toHaveLength(1);
  right.querySelector<HTMLButtonElement>('[data-terminal-id=pty-1] [role=tab]')!.click();
  expect(selectTerminal).toHaveBeenLastCalledWith('pty-1');
  right.querySelector<HTMLButtonElement>('[data-terminal-id=pty-1] [role=tab]')!.focus();
  terminalTabs[0]!.title = 'Renamed shell'; terminalTabs[0]!.exited = true; docks.sync();
  expect(right.querySelector('[data-terminal-id=pty-1]')?.textContent).toContain('Renamed shell');
  expect(document.activeElement).toBe(right.querySelector('[data-terminal-id=pty-1] [role=tab]'));
  right.querySelector<HTMLButtonElement>('[data-terminal-id=pty-1] .btn:last-child')!.click();
  expect(closeTerminal).toHaveBeenCalledWith('pty-1');
  expect(right.querySelectorAll('[role=tab]')).toHaveLength(2);
  expect(right.querySelector('.work-dock-tab:not([data-terminal-id])')).not.toBeNull();
});

it('hides the old right view when a recorded edit directly adopts Review', () => {
  const { docks } = setup();
  const hideFiles = vi.fn();
  docks.register('files', 'Files', 'i-folder', vi.fn(), hideFiles, () => true);
  docks.register('review', 'Review', 'i-git-diff', vi.fn(), vi.fn(), () => true);
  docks.activate('files'); docks.adopt('review');
  expect(hideFiles).toHaveBeenCalledOnce();
  expect(document.querySelector('#workDockRight [role=tab][aria-selected=true]')?.textContent).toContain('Review');
});

it('keeps Ctrl+backtick for bottom visibility and Ctrl+Shift+1–4 for scoped actions', () => {
  const { docks } = setup();
  const review = vi.fn(), files = vi.fn(), agents = vi.fn(), rightTerminal = vi.fn(), bottomTerminal = vi.fn();
  docks.register('review', 'Review', 'i-git-diff', review, vi.fn(), () => true);
  const terminalTabs: { id: string; title: string; exited: boolean }[] = [];
  docks.registerTerminal({ show: rightTerminal, hide: vi.fn(), canCreate: () => true,
    newTab: () => { terminalTabs.push({ id: 'pty-1', title: 'powershell', exited: false }); return 'pty-1'; },
    tabs: () => terminalTabs, selectTab: vi.fn(), closeTab: vi.fn() },
    { show: bottomTerminal, hide: vi.fn() });
  docks.register('files', 'Files', 'i-folder', files, vi.fn(), () => true);
  docks.register('agents', 'Sub-agents', 'i-agents', agents, vi.fn(), () => true);
  const key = (value: string, shiftKey = false) => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, ctrlKey: true, shiftKey, bubbles: true }));
  key('`'); expect(document.getElementById('workDockBottom')!.hidden).toBe(false);
  key('`'); expect(document.getElementById('workDockBottom')!.hidden).toBe(true);
  for (const number of ['1', '2', '3', '4']) key(number, true);
  expect(review).toHaveBeenCalledOnce(); expect(rightTerminal).toHaveBeenCalledOnce();
  expect(bottomTerminal).toHaveBeenCalledOnce();
  expect(files).toHaveBeenCalledOnce(); expect(agents).toHaveBeenCalledOnce();
});
