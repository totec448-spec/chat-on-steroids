import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

const source = readFileSync('extension/background.js', 'utf8');
const code = source.slice(source.indexOf('let backgroundWindowFlight = null;'), source.indexOf('\nasync function deliverDesktopInputs'));
type Tab = { id: number; windowId: number; url: string; pinned?: boolean };
function harness(initial: Tab[], cached?: number) {
  const tabs = new Map(initial.map(tab => [tab.id, { ...tab }]));
  const windows = new Map([...new Set(initial.map(tab => tab.windowId))].map(id => [id, { id }]));
  const stored: Record<string, unknown> = cached === undefined ? {} : { chatBackgroundWindow: cached };
  const local: Record<string, unknown> = {};
  let next = 100;
  const create = vi.fn(async (options: { url: string; windowId: number }) => {
    const tab = { id: next++, windowId: options.windowId, url: options.url };
    tabs.set(tab.id, tab); return tab;
  });
  const move = vi.fn(async (id: number, options: { windowId: number }) => {
    const tab = tabs.get(id)!; tab.windowId = options.windowId; return { ...tab };
  });
  const get = vi.fn(async (id: number) => ({ ...tabs.get(id)! }));
  const windowCreate = vi.fn(async (options: { url: string }) => {
    const id = next++; windows.set(id, { id });
    return { id, tabs: [await create({ url: options.url, windowId: id })] };
  });
  const windowUpdate = vi.fn(async (id: number) => ({ id }));
  const api = vm.runInNewContext(`${code}\n({ createChatTab, reconcileBackgroundWindow })`, {
    URL, URLSearchParams, Promise, isChatGptUrl: (value: string) => /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(value), cleanConversationId: (value: unknown) => typeof value === 'string' ? value : null,
    conversationForTab: (tab: Tab) => new URL(tab.url).pathname.match(/^\/c\/(.+)$/)?.[1] ?? null,
    chrome: {
      storage: {
        session: {
          get: async () => ({ ...stored }),
          set: async (values: object) => { Object.assign(stored, values); },
          remove: async (key: string) => { delete stored[key]; }
        },
        local: {
          get: async () => ({ ...local }),
          set: async (values: object) => { Object.assign(local, values); },
          remove: async (key: string) => { delete local[key]; }
        }
      },
      tabs: { query: async () => [...tabs.values()].map(tab => ({ ...tab })), create, move, get },
      windows: { create: windowCreate, update: windowUpdate, get: async (id: number) => {
        if (!windows.has(id)) throw new Error('Window closed'); return windows.get(id);
      } }
    }
  }) as { createChatTab(url: string, background: boolean, active?: boolean): Promise<Tab>; reconcileBackgroundWindow(policy: object): Promise<boolean> };
  return { ...api, tabs, stored, create, move, get, windowCreate, windowUpdate };
}
const policy = { background: true, managedConversations: ['main', 'worker'] };

it('selects a recovery tab inside the owned window without focusing or restoring the window', async () => {
  const app = harness([{ id: 1, windowId: 9, url: 'https://chatgpt.com/c/main' }], 9);
  await app.createChatTab('https://chatgpt.com/c/recovered', true, true);
  expect(app.create).toHaveBeenCalledWith({ url: 'https://chatgpt.com/c/recovered', windowId: 9, active: true });
  expect(app.windowCreate).not.toHaveBeenCalled();
  expect(app.windowUpdate).not.toHaveBeenCalled();
});

it('opens a foreground chat in the current window where the browser has no window list (Firefox for Android)', async () => {
  const app = harness([{ id: 1, windowId: 9, url: 'https://example.com/' }]);
  await app.createChatTab('https://chatgpt.com/c/shown', false, true);
  expect(app.create).toHaveBeenCalledExactlyOnceWith({ url: 'https://chatgpt.com/c/shown', active: true });
  expect(app.windowCreate).not.toHaveBeenCalled();
});

it('adopts an existing app main window after cache loss and puts planner and worker tabs beside it', async () => {
  const app = harness([{ id: 1, windowId: 9, url: 'https://chatgpt.com/c/main' }]);
  await Promise.all([
    app.reconcileBackgroundWindow(policy),
    app.createChatTab('https://chatgpt.com/?cos-input=planner', true),
    app.createChatTab('https://chatgpt.com/?clf=worker', true)
  ]);
  expect(app.windowCreate).not.toHaveBeenCalled();
  expect(app.stored.chatBackgroundWindow).toBe(9);
  expect([...app.tabs.values()].every(tab => tab.windowId === 9)).toBe(true);
  expect(app.windowUpdate).not.toHaveBeenCalled();
});

it('consolidates app tabs into the existing owner without opening another window', async () => {
  const app = harness([{ id: 1, windowId: 9, url: 'https://chatgpt.com/c/main' },
    { id: 2, windowId: 10, url: 'https://chatgpt.com/c/worker' }], 10);
  await app.reconcileBackgroundWindow(policy);
  expect(app.move).toHaveBeenCalledWith(1, { windowId: 10, index: -1 });
  expect(app.windowCreate).not.toHaveBeenCalled();
});

it('never moves a user-pinned managed tab into the background owner', async () => {
  const app = harness([{ id: 1, windowId: 9, url: 'https://chatgpt.com/c/main', pinned: true },
    { id: 2, windowId: 10, url: 'https://chatgpt.com/c/worker' }], 10);
  await app.reconcileBackgroundWindow(policy);
  expect(app.tabs.get(1)?.windowId).toBe(9);
  expect(app.move).not.toHaveBeenCalled();
});

it('rechecks pin state immediately before moving a managed tab', async () => {
  const app = harness([{ id: 1, windowId: 9, url: 'https://chatgpt.com/c/main' },
    { id: 2, windowId: 10, url: 'https://chatgpt.com/c/worker' }], 10);
  app.get.mockResolvedValueOnce({ id: 1, windowId: 9, url: 'https://chatgpt.com/c/main', pinned: true });
  await app.reconcileBackgroundWindow(policy);
  expect(app.move).not.toHaveBeenCalled();
});

it('serializes concurrent first tabs into one minimized unfocused window', async () => {
  const app = harness([]);
  const tabs = await Promise.all([app.createChatTab('https://chatgpt.com/?a', true), app.createChatTab('https://chatgpt.com/?b', true)]);
  expect(app.windowCreate).toHaveBeenCalledTimes(1);
  expect(app.windowCreate).toHaveBeenCalledWith(expect.objectContaining({ width: 800, height: 600, focused: false }));
  expect(app.windowUpdate).toHaveBeenCalledWith(tabs[0]?.windowId, { state: 'minimized', focused: false });
  expect(tabs[0]?.windowId).toBe(tabs[1]?.windowId);
});

it('recovers a closed cached owner from a live managed window', async () => {
  const app = harness([{ id: 1, windowId: 9, url: 'https://chatgpt.com/c/main' }], 99);
  await app.reconcileBackgroundWindow(policy);
  await app.createChatTab('https://chatgpt.com/?worker', true);
  expect(app.stored.chatBackgroundWindow).toBe(9);
  expect(app.windowCreate).not.toHaveBeenCalled();
});

it('does not adopt or move personal tabs in a mixed window', async () => {
  const app = harness([{ id: 1, windowId: 9, url: 'https://chatgpt.com/c/main' },
    { id: 2, windowId: 9, url: 'https://example.com/private' }]);
  expect(await app.reconcileBackgroundWindow(policy)).toBe(false);
  const worker = await app.createChatTab('https://chatgpt.com/?worker', true);
  await app.reconcileBackgroundWindow(policy);
  expect(app.tabs.get(1)?.windowId).toBe(worker.windowId);
  expect(app.tabs.get(2)?.windowId).toBe(9);
  expect(app.move).toHaveBeenCalledTimes(1);
});

it('adopts an exact pending planner startup tab before it has a conversation', async () => {
  const app = harness([{ id: 1, windowId: 9, url: 'https://chatgpt.com/?temporary-chat=true&cos-input=planner' }]);
  await app.reconcileBackgroundWindow({ background: true, inputs: [{ id: 'planner' }] });
  await app.createChatTab('https://chatgpt.com/?main', true);
  expect(app.windowCreate).not.toHaveBeenCalled();
  expect(app.stored.chatBackgroundWindow).toBe(9);
});

it('does not move a tab that navigated away after the policy snapshot', async () => {
  const app = harness([{ id: 1, windowId: 9, url: 'https://chatgpt.com/c/main' },
    { id: 2, windowId: 10, url: 'https://chatgpt.com/c/worker' }], 10);
  app.get.mockResolvedValueOnce({ id: 1, windowId: 9, url: 'https://example.com/new-page' });
  await app.reconcileBackgroundWindow(policy);
  expect(app.move).not.toHaveBeenCalled();
});

it('reuses a surviving warm catalog helper after browser restart and a new discovery nonce', async () => {
  const app = harness([{ id: 1, windowId: 9, url: 'https://chatgpt.com/?cos-model-catalog=11111111-1111-1111-1111-111111111111' }]);
  await app.reconcileBackgroundWindow({ background: true, modelCatalogRequest: { nonce: '22222222-2222-2222-2222-222222222222' } });
  await app.createChatTab('https://chatgpt.com/?cos-input=main', true);
  expect(app.windowCreate).not.toHaveBeenCalled();
  expect(app.stored.chatBackgroundWindow).toBe(9);
});

it('does not adopt a conversation or personal page carrying a catalog-looking query', async () => {
  const app = harness([{ id: 1, windowId: 9, url: 'https://chatgpt.com/c/personal?cos-model-catalog=11111111-1111-1111-1111-111111111111' }]);
  expect(await app.reconcileBackgroundWindow({ background: true })).toBe(false);
});

type GTab = Tab & { groupId?: number; index?: number; incognito?: boolean; active?: boolean; lastAccessed?: number };
type Win = { id: number; type?: string; incognito?: boolean };
type Group = { id: number; windowId: number; title?: string; collapsed?: boolean; color?: string };
function groupHarness(options: { tabs?: GTab[]; windows?: Win[]; lastFocused?: number | null; groups?: Group[];
  session?: Record<string, unknown>; local?: Record<string, unknown>; noGroupsApi?: boolean; placement?: string } = {}) {
  const tabs = new Map((options.tabs ?? []).map(tab => [tab.id, { groupId: -1, ...tab }]));
  const windows = new Map((options.windows ?? [{ id: 1 }]).map(window => [window.id, { type: 'normal', ...window }]));
  const groups = new Map((options.groups ?? []).map(group => [group.id, { title: '', collapsed: false, color: 'grey', ...group }]));
  const session: Record<string, unknown> = { ...(options.session ?? {}) };
  const local: Record<string, unknown> = { ...(options.local ?? {}) };
  let next = 100;
  const nextIndex = (windowId: number) => [...tabs.values()].filter(tab => tab.windowId === windowId).length;
  const create = vi.fn(async (o: { url: string; windowId?: number; active?: boolean; index?: number }) => {
    const windowId = o.windowId ?? [...windows.keys()][0]!;
    if (!windows.has(windowId)) throw new Error(`No window with id: ${windowId}.`);
    const tab = { id: next++, windowId, url: o.url, groupId: -1, index: o.index ?? nextIndex(windowId), active: o.active === true };
    tabs.set(tab.id, tab);
    return { ...tab, pendingUrl: o.url };
  });
  const group = vi.fn(async (o: { tabIds: number[]; groupId?: number; createProperties?: { windowId?: number } }) => {
    let id = o.groupId;
    if (id !== undefined && !groups.has(id)) throw new Error(`No group with id: ${id}.`);
    for (const tabId of o.tabIds) if (!tabs.has(tabId)) throw new Error(`No tab with id: ${tabId}.`);
    if (id === undefined) {
      id = next++;
      groups.set(id, { id, windowId: o.createProperties?.windowId ?? tabs.get(o.tabIds[0]!)!.windowId, title: '', collapsed: false, color: 'grey' });
    }
    for (const tabId of o.tabIds) Object.assign(tabs.get(tabId)!, { groupId: id, windowId: groups.get(id)!.windowId });
    return id;
  });
  const groupGet = vi.fn(async (id: number) => {
    if (!groups.has(id)) throw new Error(`No group with id: ${id}.`);
    return { ...groups.get(id)! };
  });
  const groupUpdate = vi.fn(async (id: number, props: object) => {
    if (!groups.has(id)) throw new Error(`No group with id: ${id}.`);
    Object.assign(groups.get(id)!, props); return { ...groups.get(id)! };
  });
  const groupQuery = vi.fn(async (q: { title?: string } = {}) =>
    [...groups.values()].filter(g => q.title === undefined || g.title === q.title).map(g => ({ ...g })));
  const query = vi.fn(async (q: { groupId?: number } = {}) =>
    [...tabs.values()].filter(tab => q.groupId === undefined || tab.groupId === q.groupId).map(tab => ({ ...tab })));
  const get = vi.fn(async (id: number) => {
    if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
    return { ...tabs.get(id)! };
  });
  const move = vi.fn(async (id: number, o: { windowId: number }) => {
    Object.assign(tabs.get(id)!, { windowId: o.windowId, groupId: -1 }); return { ...tabs.get(id)! };
  });
  const update = vi.fn(async (id: number, props: object) => ({ ...tabs.get(id)!, ...props }));
  const windowCreate = vi.fn(async (o: { url?: string; tabId?: number }) => {
    if (o.tabId !== undefined && !tabs.has(o.tabId)) throw new Error(`No tab with id: ${o.tabId}.`);
    const id = next++; windows.set(id, { id, type: 'normal' });
    if (o.tabId !== undefined) {
      Object.assign(tabs.get(o.tabId)!, { windowId: id, groupId: -1 });
      return { id, tabs: [{ ...tabs.get(o.tabId)! }] };
    }
    return { id, tabs: [await create({ url: o.url!, windowId: id })] };
  });
  const windowUpdate = vi.fn(async (id: number) => ({ id }));
  const lastFocused = vi.fn(async () => {
    const id = options.lastFocused === undefined ? [...windows.keys()][0] : options.lastFocused;
    if (id === null || id === undefined || !windows.has(id)) throw new Error('No last-focused window');
    return { ...windows.get(id)! };
  });
  const getAll = vi.fn(async () => [...windows.values()].map(window => ({ ...window })));
  const area = (store: Record<string, unknown>) => ({
    get: async () => ({ ...store }),
    set: async (values: object) => { Object.assign(store, values); },
    remove: async (key: string) => { delete store[key]; }
  });
  const chrome: Record<string, unknown> = {
    storage: { session: area(session), local: area(local) },
    tabs: { query, create, move, get, update, ...(options.noGroupsApi ? {} : { group }) },
    windows: { create: windowCreate, update: windowUpdate, getLastFocused: lastFocused, getAll,
      get: async (id: number, o?: { populate?: boolean }) => {
        if (!windows.has(id)) throw new Error(`No window with id: ${id}.`);
        return { ...windows.get(id)!, ...(o?.populate ? { tabs: [...tabs.values()].filter(tab => tab.windowId === id) } : {}) };
      } }
  };
  if (!options.noGroupsApi) chrome.tabGroups = { get: groupGet, update: groupUpdate, query: groupQuery };
  const api = vm.runInNewContext(`${code}\n({ createChatTab, reconcileBackgroundWindow, setBackgroundPlacement })`, {
    URL, URLSearchParams, Promise, isChatGptUrl: (value: string) => /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(value),
    cleanConversationId: (value: unknown) => typeof value === 'string' ? value : null,
    conversationForTab: (tab: Tab) => new URL(tab.url).pathname.match(/^\/c\/(.+)$/)?.[1] ?? null,
    chrome
  }) as { createChatTab(url: string, background: boolean, active?: boolean): Promise<GTab>;
    reconcileBackgroundWindow(policy: object): Promise<boolean>; setBackgroundPlacement(value: unknown): boolean };
  api.setBackgroundPlacement(options.placement ?? 'group');
  return { ...api, tabs, windows, groups, session, local, create, group, groupGet, groupUpdate, groupQuery, query, get, move, update,
    windowCreate, windowUpdate, lastFocused, getAll };
}
const TITLE = 'Chat On Steroids';

it('4.1 creates one collapsed titled group in the last-focused window for the first background tab', async () => {
  const app = groupHarness({ windows: [{ id: 1 }, { id: 2 }], lastFocused: 2,
    tabs: [{ id: 1, windowId: 2, url: 'https://example.com/', active: true }] });
  const tab = await app.createChatTab('https://chatgpt.com/?cos-input=a', true);
  expect(app.create).toHaveBeenCalledWith({ url: 'https://chatgpt.com/?cos-input=a', windowId: 2, active: false });
  expect(app.group).toHaveBeenCalledWith({ tabIds: [tab.id], createProperties: { windowId: 2 } });
  const groupId = app.tabs.get(tab.id)!.groupId!;
  expect(app.groupUpdate).toHaveBeenCalledExactlyOnceWith(groupId, { title: TITLE, color: 'grey', collapsed: true });
  expect(app.session.chatBackgroundGroup).toBe(groupId);
  expect(app.local.chatBackgroundGroupMirror).toBe(groupId);
  expect(app.windowCreate).not.toHaveBeenCalled();
  expect(app.windowUpdate).not.toHaveBeenCalled();
  expect(app.update).not.toHaveBeenCalled();
});

it('4.2 adds later tabs right after the group without re-collapsing a group the user expanded', async () => {
  const app = groupHarness({ windows: [{ id: 1 }], tabs: [{ id: 1, windowId: 1, url: 'https://example.com/', index: 0 }] });
  const first = await app.createChatTab('https://chatgpt.com/?cos-input=a', true);
  const groupId = app.tabs.get(first.id)!.groupId!;
  app.groups.get(groupId)!.collapsed = false; // the user expanded it and is reading
  const second = await app.createChatTab('https://chatgpt.com/?cos-input=b', true);
  expect(app.create).toHaveBeenLastCalledWith({ url: 'https://chatgpt.com/?cos-input=b', windowId: 1, active: false,
    index: app.tabs.get(first.id)!.index! + 1 });
  expect(app.group).toHaveBeenLastCalledWith({ groupId, tabIds: [second.id] });
  expect(app.groupUpdate).toHaveBeenCalledTimes(1);
  expect(app.groups.get(groupId)!.collapsed).toBe(false);
});

it('4.3 never creates an active tab in group mode, even when a caller asks for one', async () => {
  const app = groupHarness();
  await app.createChatTab('https://chatgpt.com/c/recovered', true, true);
  expect(app.create).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
  expect(app.update).not.toHaveBeenCalled();
});

it.each([
  ['the background window', 5],
  ['an incognito window', 6]
])('4.4 never places the group in %s', async (_name, focused) => {
  const app = groupHarness({ windows: [{ id: 5 }, { id: 6, incognito: true }, { id: 7 }], lastFocused: focused,
    session: { chatBackgroundWindow: 5 } });
  await app.createChatTab('https://chatgpt.com/?cos-input=a', true);
  expect(app.create).toHaveBeenCalledWith(expect.objectContaining({ windowId: 7 }));
  expect(app.group).toHaveBeenCalledWith(expect.objectContaining({ createProperties: { windowId: 7 } }));
});

it('4.4b falls back to the window whose tab was used most recently, not the lowest id', async () => {
  // Measured on the Mac (2026-10-11): Chrome named the app's own background window last-focused.
  const app = groupHarness({ windows: [{ id: 5 }, { id: 6 }, { id: 7 }], lastFocused: 5, session: { chatBackgroundWindow: 5 },
    tabs: [{ id: 1, windowId: 6, url: 'https://example.com/a', lastAccessed: 100 },
      { id: 2, windowId: 7, url: 'https://example.com/b', lastAccessed: 900 },
      { id: 3, windowId: 5, url: 'https://chatgpt.com/c/main', lastAccessed: 2000 }] });
  await app.createChatTab('https://chatgpt.com/?cos-input=a', true);
  expect(app.create).toHaveBeenCalledWith(expect.objectContaining({ windowId: 7 }));
});

it('4.5 uses the background window when it is the only normal window', async () => {
  const app = groupHarness({ windows: [{ id: 5 }], lastFocused: 5, session: { chatBackgroundWindow: 5 } });
  await app.createChatTab('https://chatgpt.com/?cos-input=a', true);
  expect(app.create).toHaveBeenCalledWith({ url: 'https://chatgpt.com/?cos-input=a', windowId: 5, active: false });
  expect(app.group).not.toHaveBeenCalled();
  expect(app.groupUpdate).not.toHaveBeenCalled();
});

it.each([
  ['no normal window at all', { windows: [], lastFocused: null }],
  ['no tab-group API', { noGroupsApi: true }],
  ['the window placement', { placement: 'window' }],
  ['an unknown placement', { placement: 'sidebar' }]
])('4.6 opens the minimized background window with %s', async (_name, options) => {
  const app = groupHarness(options as Parameters<typeof groupHarness>[0]);
  const tab = await app.createChatTab('https://chatgpt.com/?cos-input=a', true);
  expect(app.windowCreate).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://chatgpt.com/?cos-input=a', focused: false }));
  expect(app.windowUpdate).toHaveBeenCalledWith(tab.windowId, { state: 'minimized', focused: false });
  expect(app.group).not.toHaveBeenCalled();
});

it('4.7 serializes concurrent first tabs into one group', async () => {
  const app = groupHarness();
  const [a, b] = await Promise.all([app.createChatTab('https://chatgpt.com/?a', true), app.createChatTab('https://chatgpt.com/?b', true)]);
  expect(app.group.mock.calls.filter(([o]) => o.createProperties)).toHaveLength(1);
  expect(app.tabs.get(a.id)!.groupId).toBe(app.tabs.get(b.id)!.groupId);
  expect(app.groupUpdate).toHaveBeenCalledTimes(1);
});

it('4.8 follows the group to the window the user dragged it to', async () => {
  const app = groupHarness({ windows: [{ id: 1 }, { id: 3 }], lastFocused: 1 });
  const first = await app.createChatTab('https://chatgpt.com/?a', true);
  const groupId = app.tabs.get(first.id)!.groupId!;
  app.groups.get(groupId)!.windowId = 3; app.tabs.get(first.id)!.windowId = 3;
  await app.createChatTab('https://chatgpt.com/?b', true);
  expect(app.create).toHaveBeenLastCalledWith(expect.objectContaining({ windowId: 3 }));
  expect(app.group).toHaveBeenLastCalledWith(expect.objectContaining({ groupId }));
});

it('4.9 leaves foreground tabs alone in group mode', async () => {
  const app = groupHarness();
  await app.createChatTab('https://chatgpt.com/?cos-input=a', false, true);
  expect(app.create).toHaveBeenCalledWith({ url: 'https://chatgpt.com/?cos-input=a', windowId: 1, active: true });
  expect(app.group).not.toHaveBeenCalled();
});

// #1524: with the extension allowed in incognito, a chat opened while an incognito window was in
// front landed there, where ChatGPT is signed out, and failed over and over.
it.each([['group', undefined], ['window', 'window']])('4.10 never opens a foreground chat in an incognito window (%s mode)', async (_mode, placement) => {
  const app = groupHarness({ windows: [{ id: 6, incognito: true }, { id: 7 }], lastFocused: 6, placement });
  await app.createChatTab('https://chatgpt.com/?clf=successor', false, true);
  expect(app.create).toHaveBeenCalledExactlyOnceWith({ url: 'https://chatgpt.com/?clf=successor', windowId: 7, active: true });
  expect(app.windowCreate).not.toHaveBeenCalled();
});

it('4.11 opens a regular window for a foreground chat when only incognito windows are open', async () => {
  const app = groupHarness({ windows: [{ id: 6, incognito: true }], lastFocused: 6 });
  const tab = await app.createChatTab('https://chatgpt.com/?clf=successor', false, true);
  expect(app.windowCreate).toHaveBeenCalledExactlyOnceWith({ url: 'https://chatgpt.com/?clf=successor', type: 'normal', incognito: false, focused: true });
  expect(app.windows.get(tab.windowId)?.incognito).not.toBe(true);
});

it('5.1 starts a fresh group once when the stored group vanished mid-placement', async () => {
  const app = groupHarness({ windows: [{ id: 1 }], groups: [{ id: 50, windowId: 1, title: TITLE }],
    session: { chatBackgroundGroup: 50 }, local: { chatBackgroundGroupMirror: 50 } });
  app.group.mockImplementationOnce(async () => { app.groups.delete(50); throw new Error('No group with id: 50.'); });
  const tab = await app.createChatTab('https://chatgpt.com/?a', true);
  expect(app.group.mock.calls.map(([o]) => o.groupId ?? 'new')).toEqual([50, 'new']);
  const fresh = app.tabs.get(tab.id)!.groupId!;
  expect(fresh).not.toBe(50);
  expect(app.session.chatBackgroundGroup).toBe(fresh);
  expect(app.local.chatBackgroundGroupMirror).toBe(fresh);
  expect(app.groups.get(fresh)).toMatchObject({ title: TITLE, collapsed: true });
});

it('5.2 moves the tab into a new minimized window when grouping fails twice', async () => {
  const app = groupHarness({ windows: [{ id: 1 }] });
  app.group.mockRejectedValue(new Error('Grouping is not supported in this window.'));
  const tab = await app.createChatTab('https://chatgpt.com/?a', true);
  expect(app.windowCreate).toHaveBeenCalledWith({ tabId: tab.id, type: 'normal', width: 800, height: 600, focused: false });
  expect(app.windowUpdate).toHaveBeenCalledWith(tab.windowId, { state: 'minimized', focused: false });
  expect(app.tabs.get(tab.id)!.windowId).toBe(tab.windowId);
  expect(tab.windowId).not.toBe(1);
  expect(app.session.chatBackgroundWindow).toBe(tab.windowId);
  expect(app.session.chatBackgroundGroup).toBeUndefined();
});

it('5.3 moves the tab into the existing background window when grouping fails twice', async () => {
  const app = groupHarness({ windows: [{ id: 1 }, { id: 5 }], lastFocused: 1, session: { chatBackgroundWindow: 5 } });
  app.group.mockRejectedValue(new Error('Grouping is not supported in this window.'));
  const tab = await app.createChatTab('https://chatgpt.com/?a', true);
  expect(app.move).toHaveBeenCalledWith(tab.id, { windowId: 5, index: -1 });
  expect(app.windowCreate).not.toHaveBeenCalled();
  expect(app.windowUpdate).not.toHaveBeenCalled();
});

it('5.4 reports a tab that vanished before it could be placed', async () => {
  const app = groupHarness({ windows: [{ id: 1 }] });
  app.group.mockImplementation(async ({ tabIds }) => { app.tabs.delete(tabIds[0]!); throw new Error(`No tab with id: ${tabIds[0]}.`); });
  await expect(app.createChatTab('https://chatgpt.com/?a', true)).rejects.toThrow(/No tab with id/);
});

it('5.5 recovers from a failed title update by starting a fresh group in the same window', async () => {
  const app = groupHarness({ windows: [{ id: 1 }] });
  app.groupUpdate.mockImplementationOnce(async (id: number) => { app.groups.delete(id); throw new Error(`No group with id: ${id}.`); });
  const tab = await app.createChatTab('https://chatgpt.com/?a', true);
  const groupId = app.tabs.get(tab.id)!.groupId!;
  expect(app.groups.get(groupId)).toMatchObject({ title: TITLE, collapsed: true });
  expect(app.session.chatBackgroundGroup).toBe(groupId);
});

it('5.6 forgets a stored group that refused a tab, so the next placement does not retry it', async () => {
  const app = groupHarness({ windows: [{ id: 1 }], groups: [{ id: 50, windowId: 1, title: TITLE }],
    session: { chatBackgroundGroup: 50 }, local: { chatBackgroundGroupMirror: 50 } });
  app.group.mockRejectedValue(new Error('Grouping is not supported in this window.'));
  await app.createChatTab('https://chatgpt.com/?a', true);
  expect(app.session.chatBackgroundGroup).toBeUndefined();
  expect(app.local.chatBackgroundGroupMirror).toBeUndefined();
});

const MAIN = 'https://chatgpt.com/c/main';
it('6.1 keeps using a mirrored group after an extension reload while it carries the title', async () => {
  const app = groupHarness({ windows: [{ id: 1 }], groups: [{ id: 50, windowId: 1, title: TITLE }],
    tabs: [{ id: 1, windowId: 1, url: MAIN, groupId: 50, index: 0 }], local: { chatBackgroundGroupMirror: 50 } });
  await app.createChatTab('https://chatgpt.com/?a', true);
  expect(app.group).toHaveBeenCalledWith({ groupId: 50, tabIds: [expect.any(Number)] });
  expect(app.session.chatBackgroundGroup).toBe(50);
});

it('6.2 lets go of a mirrored group the user renamed and starts its own', async () => {
  const app = groupHarness({ windows: [{ id: 1 }], groups: [{ id: 50, windowId: 1, title: 'Research' }],
    tabs: [{ id: 1, windowId: 1, url: MAIN, groupId: 50, index: 0 }], local: { chatBackgroundGroupMirror: 50 } });
  const tab = await app.createChatTab('https://chatgpt.com/?a', true);
  expect(app.tabs.get(tab.id)!.groupId).not.toBe(50);
  expect(app.groups.get(50)!.title).toBe('Research');
  expect(app.local.chatBackgroundGroupMirror).toBe(app.tabs.get(tab.id)!.groupId);
});

it('6.3 adopts a restored all-app titled group after a browser restart', async () => {
  const app = groupHarness({ windows: [{ id: 1 }], groups: [{ id: 60, windowId: 1, title: TITLE }],
    tabs: [{ id: 1, windowId: 1, url: MAIN, groupId: 60, index: 0 }, { id: 2, windowId: 1, url: 'https://example.com/', index: 1 }] });
  expect(await app.reconcileBackgroundWindow(policy)).toBe(true);
  expect(app.session.chatBackgroundGroup).toBe(60);
  await app.createChatTab('https://chatgpt.com/?a', true);
  expect(app.group).toHaveBeenCalledExactlyOnceWith({ groupId: 60, tabIds: [expect.any(Number)] });
});

it.each([
  ['holds a personal tab', [{ id: 1, windowId: 1, url: MAIN, groupId: 60 }, { id: 2, windowId: 1, url: 'https://example.com/', groupId: 60 }], TITLE],
  ['carries another title', [{ id: 1, windowId: 1, url: MAIN, groupId: 60 }], 'Chat On Steroids (2)'],
  ['is empty', [], TITLE]
])('6.4 never adopts a group that %s', async (_name, tabs, title) => {
  const app = groupHarness({ windows: [{ id: 1 }], groups: [{ id: 60, windowId: 1, title }], tabs: tabs as GTab[] });
  expect(await app.reconcileBackgroundWindow(policy)).toBe(false);
  expect(app.session.chatBackgroundGroup).toBeUndefined();
});

it('6.5 never moves or regroups tabs in group mode, even with an old background window around', async () => {
  const app = groupHarness({ windows: [{ id: 1 }, { id: 9 }], lastFocused: 1, groups: [{ id: 60, windowId: 1, title: TITLE }],
    session: { chatBackgroundWindow: 9, chatBackgroundGroup: 60 },
    tabs: [{ id: 1, windowId: 1, url: MAIN, groupId: 60 }, { id: 2, windowId: 9, url: 'https://chatgpt.com/c/worker' },
      { id: 3, windowId: 1, url: 'https://chatgpt.com/c/worker' }] });
  expect(await app.reconcileBackgroundWindow(policy)).toBe(true);
  expect(app.move).not.toHaveBeenCalled();
  expect(app.group).not.toHaveBeenCalled();
});

it('6.6 adopts in group mode even with Background chats off, so helper tabs reuse the group', async () => {
  const app = groupHarness({ windows: [{ id: 1 }], groups: [{ id: 60, windowId: 1, title: TITLE }],
    tabs: [{ id: 1, windowId: 1, url: 'https://chatgpt.com/?cos-model-catalog=11111111-1111-1111-1111-111111111111', groupId: 60 }] });
  expect(await app.reconcileBackgroundWindow({ background: false })).toBe(true);
  expect(app.session.chatBackgroundGroup).toBe(60);
});

it('6.7 adopts the lowest of two qualifying groups', async () => {
  const app = groupHarness({ windows: [{ id: 1 }], groups: [{ id: 61, windowId: 1, title: TITLE }, { id: 60, windowId: 1, title: TITLE }],
    tabs: [{ id: 1, windowId: 1, url: MAIN, groupId: 61 }, { id: 2, windowId: 1, url: 'https://chatgpt.com/c/worker', groupId: 60 }] });
  await app.reconcileBackgroundWindow(policy);
  expect(app.session.chatBackgroundGroup).toBe(60);
});

it('6.8 keeps today\'s window reconcile with the window placement', async () => {
  const app = groupHarness({ placement: 'window', windows: [{ id: 9 }, { id: 10 }], session: { chatBackgroundWindow: 10 },
    tabs: [{ id: 1, windowId: 9, url: MAIN }, { id: 2, windowId: 10, url: 'https://chatgpt.com/c/worker' }] });
  await app.reconcileBackgroundWindow(policy);
  expect(app.move).toHaveBeenCalledWith(1, { windowId: 10, index: -1 });
  expect(app.groupQuery).not.toHaveBeenCalled();
});
