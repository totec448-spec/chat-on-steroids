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

it('opens an empty right dock, presents only registered actions, and restores the original width after expansion', () => {
  const { host, docks } = setup();
  const files = vi.fn(), hideFiles = vi.fn();
  docks.register('files', 'Files', 'i-folder', files, hideFiles, () => true);
  const right = document.getElementById('workDockRight')!;
  expect(right.hidden).toBe(true);
  document.getElementById('rightDockToggle')!.click();
  expect(right.hidden).toBe(false);
  expect(right.querySelector('.work-dock-empty')!.hasAttribute('hidden')).toBe(false);
  expect(right.querySelectorAll('.work-dock-quick')).toHaveLength(1);
  right.querySelector<HTMLButtonElement>('.work-dock-quick')!.click();
  expect(files).toHaveBeenCalledOnce();
  expect(right.querySelectorAll('[role="tab"]')).toHaveLength(1);
  const selectedTab = right.querySelector<HTMLButtonElement>('[role="tab"]')!;
  selectedTab.focus(); docks.sync();
  expect(document.activeElement).toBe(selectedTab);
  host.style.setProperty('--work-panel-width', '410px');
  right.querySelectorAll<HTMLButtonElement>('.work-dock-bar > button')[0]!.click();
  expect(host.classList.contains('is-work-dock-expanded')).toBe(true);
  right.querySelectorAll<HTMLButtonElement>('.work-dock-bar > button')[0]!.click();
  expect(host.classList.contains('is-work-dock-expanded')).toBe(false);
  expect(host.style.getPropertyValue('--work-panel-width')).toBe('410px');
  document.getElementById('rightDockToggle')!.click();
  expect(hideFiles).toHaveBeenCalledOnce();
  expect(right.hidden).toBe(true);
  expect(right.querySelectorAll('[role="tab"]')).toHaveLength(1);
  document.getElementById('rightDockToggle')!.click();
  expect(files).toHaveBeenCalledTimes(2);
});

it('does not activate an unavailable view or leave a blank selected tab', () => {
  const { docks } = setup();
  let available = false;
  const files = vi.fn();
  docks.register('files', 'Files', 'i-folder', files, vi.fn(), () => available);
  const quick = document.querySelector<HTMLButtonElement>('.work-dock-quick')!;
  expect(quick.disabled).toBe(true);
  docks.activate('files');
  expect(files).not.toHaveBeenCalled();
  available = true; docks.sync();
  expect(quick.disabled).toBe(false);
  docks.activate('files');
  expect(files).toHaveBeenCalledOnce();
  available = false; docks.sync();
  expect(document.querySelector('.work-dock-empty')!.hasAttribute('hidden')).toBe(false);
});

it('moves one Files view between docks without recreating it and keeps Terminal custody when hidden', () => {
  const { docks } = setup();
  const fileNode = document.createElement('section'); fileNode.id = 'file-owner';
  const terminalNode = document.createElement('section'); terminalNode.id = 'terminal-owner';
  docks.register('files', 'Files', 'i-folder', (_side, mount) => { mount.append(fileNode); fileNode.hidden = false; },
    () => { fileNode.hidden = true; }, () => true, ['right', 'bottom']);
  docks.register('terminal', 'Terminal', 'i-terminal', (_side, mount) => { mount.append(terminalNode); terminalNode.hidden = false; },
    () => { terminalNode.hidden = true; }, () => true, ['right', 'bottom']);
  docks.activate('files', 'right'); docks.activate('terminal', 'bottom');
  expect(fileNode.parentElement).toBe(docks.body);
  expect(terminalNode.parentElement).toBe(docks.bottomBody);
  docks.activate('files', 'bottom');
  expect(fileNode.parentElement).toBe(docks.bottomBody);
  expect(docks.sideOf('files')).toBe('bottom');
  expect(terminalNode.hidden).toBe(true);
  docks.activate('terminal', 'right');
  expect(terminalNode.parentElement).toBe(docks.body);
  expect(terminalNode).toBe(document.getElementById('terminal-owner'));
});
