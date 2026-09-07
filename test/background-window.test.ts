import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

const source = readFileSync('extension/background.js', 'utf8');
const code = source.slice(source.indexOf('let backgroundWindowFlight = null;'), source.indexOf('\nasync function deliverDesktopInputs'));
type Tab = { id: number; windowId: number; url: string };
function harness(initial: Tab[], cached?: number) {
  const tabs = new Map(initial.map(tab => [tab.id, { ...tab }]));
  const windows = new Map([...new Set(initial.map(tab => tab.windowId))].map(id => [id, { id }]));
  const stored: Record<string, unknown> = cached === undefined ? {} : { chatBackgroundWindow: cached };
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
    URL, URLSearchParams, Promise, cleanConversationId: (value: unknown) => typeof value === 'string' ? value : null,
    conversationForTab: (tab: Tab) => new URL(tab.url).pathname.match(/^\/c\/(.+)$/)?.[1] ?? null,
    chrome: {
      storage: { session: {
        get: async () => ({ ...stored }),
        set: async (values: object) => { Object.assign(stored, values); },
        remove: async (key: string) => { delete stored[key]; }
      } },
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

it('serializes concurrent first tabs into one minimized unfocused window', async () => {
  const app = harness([]);
  const tabs = await Promise.all([app.createChatTab('https://chatgpt.com/?a', true), app.createChatTab('https://chatgpt.com/?b', true)]);
  expect(app.windowCreate).toHaveBeenCalledTimes(1);
  expect(app.windowCreate).toHaveBeenCalledWith(expect.objectContaining({ state: 'minimized', focused: false }));
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
