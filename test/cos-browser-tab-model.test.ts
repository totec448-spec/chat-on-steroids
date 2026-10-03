import { expect, it } from 'vitest';
import { matchesPatterns } from '../src/main/cos-browser/match-pattern.js';
import { TabModel, WINDOW_ID_NONE, type ModelEvent } from '../src/main/cos-browser/tab-model.js';

function model() {
  const events: ModelEvent[] = [];
  let clock = 1000;
  const tabs = new TabModel(event => events.push(structuredClone(event)), () => clock);
  return { tabs, events, tick: (ms = 1) => { clock += ms; }, names: () => events.map(event => event.name) };
}

it('reports a created tab as pending until its first document commits', () => {
  const { tabs } = model();
  const window = tabs.createWindow();
  const created = tabs.addTab(7, window, { url: 'https://chatgpt.com/c/a', active: false });
  expect(created).toMatchObject({ id: 7, windowId: window, index: 0, url: '', pendingUrl: 'https://chatgpt.com/c/a', status: 'loading' });
  // The only tab of a window is active even when created in the background.
  expect(created.active).toBe(true);
});

it('reports a committed URL only once tab.url holds it and no navigation is pending', () => {
  const { tabs, events } = model();
  const window = tabs.createWindow();
  tabs.addTab(1, window, { url: 'https://chatgpt.com/', active: true });
  tabs.navigationCommitted(1, 'https://chatgpt.com/');
  tabs.titleChanged(1, 'ChatGPT');
  tabs.loadingStopped(1);
  events.length = 0;

  tabs.navigationStarted(1, 'https://chatgpt.com/c/next');
  expect(tabs.tab(1)).toMatchObject({ url: 'https://chatgpt.com/', pendingUrl: 'https://chatgpt.com/c/next', status: 'loading' });
  tabs.navigationCommitted(1, 'https://chatgpt.com/c/next');
  tabs.loadingStopped(1);

  const updates = events.filter(event => event.name === 'tabs.onUpdated').map(event => event.args);
  expect(updates.map(([, change]) => change)).toEqual([{ status: 'loading' }, { url: 'https://chatgpt.com/c/next' }, { status: 'complete' }]);
  const [, , atUrl] = updates[1]!;
  expect(atUrl.url).toBe('https://chatgpt.com/c/next');
  expect(atUrl.pendingUrl).toBeUndefined();
});

it('reports routing inside one document as a URL change without a loading cycle', () => {
  const { tabs, events } = model();
  const window = tabs.createWindow();
  tabs.addTab(1, window, { url: 'https://chatgpt.com/', active: true });
  tabs.navigationCommitted(1, 'https://chatgpt.com/');
  tabs.loadingStopped(1);
  events.length = 0;
  tabs.sameDocumentNavigated(1, 'https://chatgpt.com/c/routed');
  tabs.sameDocumentNavigated(1, 'https://chatgpt.com/c/routed');
  expect(events).toEqual([{ name: 'tabs.onUpdated', args: [1, { url: 'https://chatgpt.com/c/routed' }, expect.objectContaining({ url: 'https://chatgpt.com/c/routed', status: 'complete' })] }]);
  expect(tabs.tab(1)!.pendingUrl).toBeUndefined();
});

it('clears a pending navigation that stopped before it committed', () => {
  const { tabs } = model();
  const window = tabs.createWindow();
  tabs.addTab(1, window, { url: 'https://chatgpt.com/', active: true });
  tabs.navigationCommitted(1, 'https://chatgpt.com/');
  tabs.loadingStopped(1);
  tabs.navigationStarted(1, 'https://chatgpt.com/unreachable');
  tabs.loadingStopped(1);
  expect(tabs.tab(1)).toMatchObject({ url: 'https://chatgpt.com/', status: 'complete' });
  expect(tabs.tab(1)!.pendingUrl).toBeUndefined();
});

it('activates the right neighbour of a closed active tab, else the left one, and closes an emptied window', () => {
  const { tabs, events, names } = model();
  const window = tabs.createWindow();
  for (const id of [1, 2, 3]) tabs.addTab(id, window, { url: `https://chatgpt.com/c/${id}`, active: true });
  tabs.activate(2);
  events.length = 0;
  tabs.removeTab(2);
  expect(tabs.activeTab(window)).toBe(3);
  expect(names()).toEqual(['tabs.onRemoved', 'tabs.onActivated']);
  tabs.removeTab(3);
  expect(tabs.activeTab(window)).toBe(1);
  expect(tabs.tab(1)!.index).toBe(0);
  events.length = 0;
  tabs.removeTab(1);
  expect(names()).toEqual(['tabs.onRemoved', 'windows.onRemoved']);
  expect(tabs.window(window)).toBeNull();
});

it('closes every tab of a closing window as part of that window', () => {
  const { tabs, events } = model();
  const window = tabs.createWindow();
  tabs.addTab(1, window, { url: 'https://chatgpt.com/', active: true });
  tabs.addTab(2, window, { url: 'https://chatgpt.com/', active: false });
  events.length = 0;
  tabs.removeWindow(window);
  expect(events.map(event => [event.name, event.args[0], (event.args[1] as { isWindowClosing?: boolean } | undefined)?.isWindowClosing]))
    .toEqual([['tabs.onRemoved', 2, true], ['tabs.onRemoved', 1, true], ['windows.onRemoved', window, undefined]]);
});

it('moves a tab between windows with detach and attach events and closes the emptied source', () => {
  const { tabs, events, names } = model();
  const personal = tabs.createWindow();
  const owned = tabs.createWindow();
  tabs.addTab(1, owned, { url: 'https://chatgpt.com/c/owned', active: true });
  tabs.addTab(2, personal, { url: 'https://chatgpt.com/c/chat', active: true });
  events.length = 0;
  const moved = tabs.move(2, owned, -1);
  expect(moved).toMatchObject({ windowId: owned, index: 1, active: false });
  expect(names()).toEqual(['tabs.onDetached', 'tabs.onAttached', 'windows.onRemoved']);
  expect(tabs.window(personal)).toBeNull();
  expect(() => tabs.move(2, 99, 0)).toThrow('No window with id: 99.');
});

it('reorders inside a window and reports where the tab went', () => {
  const { tabs, events } = model();
  const window = tabs.createWindow();
  for (const id of [1, 2, 3]) tabs.addTab(id, window, { url: 'https://chatgpt.com/', active: false });
  events.length = 0;
  tabs.move(1, window, -1);
  expect(tabs.tabsOf(window)).toEqual([2, 3, 1]);
  expect(events).toEqual([{ name: 'tabs.onMoved', args: [1, { windowId: window, fromIndex: 0, toIndex: 2 }] }]);
});

it('answers the queries the companion makes', () => {
  const { tabs } = model();
  const background = tabs.createWindow({ state: 'minimized' });
  const shown = tabs.createWindow();
  tabs.addTab(1, background, { url: 'https://chatgpt.com/c/a', active: true });
  tabs.navigationCommitted(1, 'https://chatgpt.com/c/a');
  tabs.addTab(2, shown, { url: 'https://example.com/', active: true });
  tabs.navigationCommitted(2, 'https://example.com/');
  tabs.focusWindow(shown);
  tabs.focusWindow(WINDOW_ID_NONE);

  const urls = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
  expect(tabs.query({ url: urls }).map(tab => tab.id)).toEqual([1]);
  expect(tabs.query({}).map(tab => tab.id)).toEqual([1, 2]);
  // A service worker has no window of its own: the last focused one answers, even after focus left.
  expect(tabs.query({ active: true, lastFocusedWindow: true }).map(tab => tab.id)).toEqual([2]);
  expect(tabs.window(background)!.state).toBe('minimized');
  expect(tabs.query({ title: '' }).map(tab => tab.id)).toEqual([1, 2]);
});

it('records discard protection and reports the change', () => {
  const { tabs, events } = model();
  const window = tabs.createWindow();
  tabs.addTab(1, window, { url: 'https://chatgpt.com/', active: true });
  events.length = 0;
  tabs.setAutoDiscardable(1, false);
  tabs.setAutoDiscardable(1, false);
  expect(tabs.tab(1)).toMatchObject({ autoDiscardable: false, discarded: false, frozen: false });
  expect(events).toHaveLength(1);
});

it('stamps lastAccessed when a tab is activated or its window gains focus', () => {
  const { tabs, tick } = model();
  const window = tabs.createWindow();
  tabs.addTab(1, window, { url: 'https://chatgpt.com/', active: true });
  tabs.addTab(2, window, { url: 'https://chatgpt.com/', active: false });
  tick(50);
  tabs.activate(2);
  expect(tabs.tab(2)!.lastAccessed).toBe(1050);
  tick(50);
  tabs.focusWindow(window);
  expect(tabs.tab(2)!.lastAccessed).toBe(1100);
  expect(tabs.tab(1)!.lastAccessed).toBe(1000);
});

it('matches Chrome match patterns used by URL queries', () => {
  expect(matchesPatterns('https://chatgpt.com/c/1?x=1', 'https://chatgpt.com/*')).toBe(true);
  expect(matchesPatterns('https://sub.chatgpt.com/', 'https://*.chatgpt.com/*')).toBe(true);
  expect(matchesPatterns('https://chatgpt.com/', 'https://*.chatgpt.com/*')).toBe(true);
  expect(matchesPatterns('https://evilchatgpt.com/', 'https://*.chatgpt.com/*')).toBe(false);
  expect(matchesPatterns('http://chatgpt.com/', 'https://chatgpt.com/*')).toBe(false);
  expect(matchesPatterns('http://chatgpt.com/', '*://chatgpt.com/*')).toBe(true);
  expect(matchesPatterns('http://127.0.0.1:8765/status', 'http://127.0.0.1/*')).toBe(true);
  expect(matchesPatterns('http://127.0.0.1:8765/status', 'http://127.0.0.1:8766/*')).toBe(false);
  expect(matchesPatterns('chrome://extensions/', '<all_urls>')).toBe(false);
  expect(matchesPatterns('', ['https://chatgpt.com/*'])).toBe(false);
  expect(matchesPatterns('https://chatgpt.com/', 'not a pattern')).toBe(false);
});
