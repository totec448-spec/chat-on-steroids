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

type GTab = Tab & { groupId?: number; index?: number; incognito?: boolean; active?: boolean };
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
  expect(app.create).toHaveBeenCalledWith({ url: 'https://chatgpt.com/?cos-input=a', active: true });
  expect(app.group).not.toHaveBeenCalled();
});
