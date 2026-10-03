import { expect, it } from 'vitest';
import { callChromeApi, type BrowserControl, type DebuggerTarget } from '../src/main/cos-browser/chrome-api.js';
import { TabModel, type ModelEvent, type WindowState } from '../src/main/cos-browser/tab-model.js';

/** Native side effects recorded instead of performed; navigation commits at once. */
function browser() {
  const events: ModelEvent[] = [];
  const model = new TabModel(event => events.push(event));
  const calls: string[] = [];
  const attached = new Set<number>();
  let nextTab = 100;
  const control: BrowserControl = {
    model,
    createWindow({ url, focused, state, type }) {
      const id = model.createWindow({ type, state: focused ? 'normal' : state === 'normal' ? 'minimized' : state });
      calls.push(`createWindow ${id} focused=${focused}`);
      if (url !== undefined) control.createTab(id, url, { active: true });
      if (focused) model.focusWindow(id);
      return id;
    },
    createTab(windowId, url, options) {
      const id = nextTab++;
      model.addTab(id, windowId, { url, ...options });
      calls.push(`createTab ${id} ${url}`);
      return id;
    },
    navigate(tabId, url) { calls.push(`navigate ${tabId} ${url}`); model.navigationStarted(tabId, url); model.navigationCommitted(tabId, url); },
    reload(tabId, bypassCache) { calls.push(`reload ${tabId} ${bypassCache}`); },
    activate(tabId) { model.activate(tabId); },
    closeTab(tabId) { calls.push(`closeTab ${tabId}`); model.removeTab(tabId); },
    moveTab(tabId, windowId, index) { model.move(tabId, windowId, index); },
    closeWindow(windowId) { model.removeWindow(windowId); },
    presentWindow(windowId, change) { calls.push(`present ${windowId} ${JSON.stringify(change)}`); if (change.state) model.setWindowState(windowId, change.state as WindowState); },
    async debuggerAttach(tabId) {
      if (attached.has(tabId)) throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
      attached.add(tabId);
    },
    async debuggerDetach(tabId) {
      if (!attached.delete(tabId)) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
    },
    async debuggerSend(tabId, method, params, sessionId) { return { tabId, method, params, sessionId }; },
    debuggerTargets(): DebuggerTarget[] {
      return model.query({}).map(tab => ({ type: 'page', id: String(tab.id), tabId: tab.id, title: tab.title, url: tab.url, attached: attached.has(tab.id) }));
    }
  };
  const call = async (name: string, ...args: unknown[]) => {
    const reply = await callChromeApi(control, name, args);
    if (!reply.ok) throw new Error(reply.message);
    return reply.value as any;
  };
  return { control, model, calls, events, call };
}

it('creates the companion background window hidden, then a tab in that exact window', async () => {
  const { call, calls } = browser();
  const window = await call('windows.create', { url: 'https://chatgpt.com/?cos-input=a', type: 'normal', width: 800, height: 600, focused: false });
  expect(window).toMatchObject({ focused: false, state: 'minimized', tabs: [expect.objectContaining({ pendingUrl: 'https://chatgpt.com/?cos-input=a' })] });
  const tab = await call('tabs.create', { url: 'https://chatgpt.com/c/b', windowId: window.id, active: false });
  expect(tab).toMatchObject({ windowId: window.id, index: 1, active: false });
  expect(calls).toEqual([`createWindow ${window.id} focused=false`, 'createTab 100 https://chatgpt.com/?cos-input=a', 'createTab 101 https://chatgpt.com/c/b']);
  expect((await call('windows.update', window.id, { state: 'minimized', focused: false })).state).toBe('minimized');
});

it('opens a window for a tab when no window exists', async () => {
  const { call, model } = browser();
  const tab = await call('tabs.create', { url: 'https://chatgpt.com/', active: false });
  expect(model.window(tab.windowId)).toMatchObject({ focused: false });
  expect(tab.active).toBe(true);
});

it('answers missing tabs and windows with Chrome messages the companion recognises', async () => {
  const { call } = browser();
  await expect(call('tabs.get', 7)).rejects.toThrow(/^No tab with id: 7\.$/);
  await expect(call('tabs.update', 7, { autoDiscardable: false })).rejects.toThrow('No tab with id: 7.');
  await expect(call('windows.get', 3)).rejects.toThrow('No window with id: 3.');
  await expect(call('debugger.attach', { tabId: 7 }, '1.3')).rejects.toThrow('No tab with given id 7.');
  await expect(call('tabs.get', 'x')).rejects.toThrow('Error in invocation: tabId must be an integer.');
  await expect(call('tabs.discard', 1)).rejects.toThrow('tabs.discard is not available in the CoS browser.');
});

it('updates by explicit id, by an undefined id, and on the active tab when the id is omitted', async () => {
  const { call } = browser();
  const window = await call('windows.create', { url: 'https://chatgpt.com/', focused: true });
  const id = window.tabs[0].id;
  expect((await call('tabs.update', id, { autoDiscardable: false })).autoDiscardable).toBe(false);
  expect((await call('tabs.update', undefined, { autoDiscardable: true })).autoDiscardable).toBe(true);
  expect((await call('tabs.update', { url: 'https://chatgpt.com/c/x' })).url).toBe('https://chatgpt.com/c/x');
});

it('validates every id before removing any tab', async () => {
  const { call, calls } = browser();
  const window = await call('windows.create', { url: 'https://chatgpt.com/', focused: false });
  const id = window.tabs[0].id;
  await expect(call('tabs.remove', [id, 999])).rejects.toThrow('No tab with id: 999.');
  expect(calls.some(line => line.startsWith('closeTab'))).toBe(false);
  await call('tabs.remove', id);
  await expect(call('tabs.get', id)).rejects.toThrow(`No tab with id: ${id}.`);
});

it('moves a tab into the owned window and returns the same shape Chrome does', async () => {
  const { call } = browser();
  const owned = await call('windows.create', { url: 'https://chatgpt.com/c/owned', focused: false });
  const other = await call('windows.create', { url: 'https://chatgpt.com/c/stray', focused: false });
  const stray = other.tabs[0].id;
  const moved = await call('tabs.move', stray, { windowId: owned.id, index: -1 });
  expect(moved).toMatchObject({ id: stray, windowId: owned.id, index: 1 });
  expect(Array.isArray(await call('tabs.move', [stray], { index: 0 }))).toBe(true);
  await expect(call('windows.get', other.id)).rejects.toThrow(`No window with id: ${other.id}.`);
});

it('refuses a minimized window that also asks for focus, as Chrome does', async () => {
  const { call } = browser();
  await expect(call('windows.create', { url: 'https://chatgpt.com/', state: 'minimized', focused: true })).rejects.toThrow('Invalid value for state');
  await expect(call('windows.create', { state: 'sideways' })).rejects.toThrow('Invalid value for state: sideways');
});

it('routes debugger commands to the exact tab and reports attachment in getTargets', async () => {
  const { call } = browser();
  const window = await call('windows.create', { url: 'https://chatgpt.com/', focused: false });
  const tabId = window.tabs[0].id;
  await call('debugger.attach', { tabId }, '1.3');
  await expect(call('debugger.attach', { tabId }, '1.3')).rejects.toThrow(`Another debugger is already attached to the tab with id: ${tabId}.`);
  expect(await call('debugger.getTargets')).toEqual([expect.objectContaining({ tabId, attached: true })]);
  expect(await call('debugger.sendCommand', { tabId, sessionId: 's1' }, 'Emulation.setFocusEmulationEnabled', { enabled: true }))
    .toEqual({ tabId, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true }, sessionId: 's1' });
  await call('debugger.detach', { tabId });
  await expect(call('debugger.detach', { tabId })).rejects.toThrow(`Debugger is not attached to the tab with id: ${tabId}.`);
});

it('reloads the given tab, bypassing the cache only when asked', async () => {
  const { call, calls } = browser();
  const window = await call('windows.create', { url: 'https://chatgpt.com/', focused: true });
  await call('tabs.reload', window.tabs[0].id);
  await call('tabs.reload', { bypassCache: true });
  expect(calls.filter(line => line.startsWith('reload'))).toEqual([`reload ${window.tabs[0].id} false`, `reload ${window.tabs[0].id} true`]);
});
