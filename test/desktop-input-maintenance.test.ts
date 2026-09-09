import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_PROTOCOL } from '../src/main/version.js';

const backgroundSource = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');

/*
 * background.js statically imports the browser driver, and this harness evaluates the worker as
 * a classic script, where an import statement is a parse error. Strip the statement here and,
 * where the worker actually calls the driver, supply the binding through the context instead.
 * The import is static so that a broken browser_* message fails in a real browser rather than
 * passing here; fail loudly if it stops looking the way this expects.
 */
const importPattern = /^import \* as browserDriverModule from '\.\/browser-driver\.js';$/m;
if (!importPattern.test(backgroundSource)) {
  throw new Error(
    'background.js no longer statically imports browser-driver.js as expected; ' +
      'update this harness rather than making the worker import dynamically'
  );
}
const source = backgroundSource.replace(importPattern, '');
const firstId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const secondId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

it('missing models retain the elected Work document without a New Chat or helper fallback', async () => {
  const h = await worker([]);
  const original = { id: 8, url: `https://chatgpt.com/c/${secondId}` }; h.tabs.push(original);
  await h.authorizeDocument({ tab: { id: 8 }, documentId: 'work-page', frameId: 0, url: original.url }, { navigationEpoch: 1 });
  h.sendMessage.mockImplementation(async (tabId, message): Promise<any> => {
    const tab = h.tabs.find(row => row.id === tabId)!;
    if (message.type === 'clf-model-catalog-state') return { ready: true };
    if (message.type === 'clf-model-catalog') {
      if (tabId === 8) return { ok: false, prepare: true, preSend: true, url: tab.url };
      return { ok: true };
    }
    if (message.type === 'clf-prepare-model-catalog') return { ready: false, fallback: true, preSend: true, url: tab.url };
    if (message.type === 'clf-input-reuse-state') return { safe: tabId !== 8, navigationEpoch: 1 };
    if (message.type === 'clf-prepare-desktop-input') { tab.url = `https://chatgpt.com/?cos-input=${firstId}`; return { ready: true }; }
    return { ok: true };
  });
  const request = { nonce: firstId, expiresAt: Date.now() + 60000, allowOpen: true };
  await h.inspectModels(request, true);
  await h.inspectModels(request, true);
  expect(h.saved.modelCatalogOwner).toMatchObject({ nonce: firstId, tab: 8 });
  expect(h.create).not.toHaveBeenCalled();
  expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-model-catalog')).toHaveLength(0);
  expect(original.url).toBe(`https://chatgpt.com/c/${secondId}`);
});

it.each(['passive', 'missing-receipt', 'closed', 'cancelled'])('catalog %s cannot authorize a fallback tab', async reason => {
  const h = await worker([]);
  h.tabs.push({ id: 8, url: `https://chatgpt.com/c/${secondId}` });
  await h.authorizeDocument({ tab: { id: 8 }, documentId: 'work-page', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
  h.sendMessage.mockImplementation(async (_tabId, message): Promise<any> => {
    if (message.type === 'clf-model-catalog-state') return { ready: true };
    if (message.type === 'clf-model-catalog') return { prepare: true, preSend: true, url: h.tabs[0]?.url };
    if (message.type === 'clf-prepare-model-catalog') {
      if (reason === 'closed') h.tabs.splice(0);
      if (reason === 'missing-receipt') return undefined;
      return { ready: false, fallback: reason !== 'cancelled', preSend: true, url: `https://chatgpt.com/c/${secondId}` };
    }
    return { ok: true };
  });
  const request = { nonce: firstId, expiresAt: Date.now() + 60000, allowOpen: reason !== 'passive' };
  await h.inspectModels(request, true); await h.inspectModels(request, true);
  expect(h.create).not.toHaveBeenCalled();
  expect(h.sendMessage.mock.calls.filter(([, message]) => message.type === 'clf-prepare-model-catalog')).toHaveLength(0);
});
it('waits for an existing hydrating or busy ChatGPT tab rather than opening another catalog helper', async () => {
  const h = await worker([]);
  h.tabs.push({ id: 8, url: 'https://chatgpt.com/' });
  h.sendMessage.mockResolvedValue({ ok: true, ready: false });
  await h.inspectModels({ nonce: firstId, expiresAt: Date.now() + 60000, allowOpen: true }, true);
  expect(h.create).not.toHaveBeenCalled();
});
it('elects the usable chat when an older Settings tab reports its composer hidden', async () => {
  const h = await worker([]);
  h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${firstId}#settings/Plugins` }, { id: 8, url: `https://chatgpt.com/c/${secondId}` });
  h.sendMessage.mockImplementation(async (id, message) => message.type === 'clf-model-catalog-state' ? { ok: true, ready: id === 8 } : { ok: true });
  await h.inspectModels({ nonce: firstId, expiresAt: Date.now() + 60000, allowOpen: true }, true);
  expect(h.saved.modelCatalogOwner).toMatchObject({ nonce: firstId, tab: 8 });
  expect(h.sendMessage).toHaveBeenCalledWith(8, expect.objectContaining({ type: 'clf-model-catalog' }));
  expect(h.sendMessage.mock.calls.filter(([id, message]) => id === 7 && message.type === 'clf-model-catalog')).toHaveLength(0);
  expect(h.create).not.toHaveBeenCalled();
});
it.each(['empty', 'draft', 'navigated', 'rejected', 'transport'])('terminal worker failure retires only the exact empty document (%s)', async mode => {
  const h = await worker([]);
  const source = { tab: 8, documentId: 'failed-worker', navigationEpoch: 1 };
  h.tabs.push({ id: 8, url: `https://chatgpt.com/?clf=${firstId}` });
  await h.authorizeDocument({ tab: { id: 8 }, documentId: source.documentId, frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
  h.fetch.mockImplementation(async input => ({ ok: mode !== 'transport', status: mode === 'transport' ? 503 : 200,
    json: async () => new URL(input).pathname === '/hello'
      ? { app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true }
      : { ok: true, outcome: mode === 'rejected' ? 'committed' : 'terminal-failure', committed: false } }));
  h.sendMessage.mockImplementation(async (_tabId, message): Promise<any> => {
    if (message.type === 'clf-tab-close-check') {
      if (mode === 'navigated') h.tabs[0]!.url = `https://chatgpt.com/c/${secondId}`;
      return { safe: mode !== 'draft', conversationId: null, navigationEpoch: 1 };
    }
    return { ok: true };
  });
  await (h as any).ackCommand(firstId, 'failed', 'model unavailable', null, null, 'worker-client', source);
  expect(h.remove).toHaveBeenCalledTimes(mode === 'empty' ? 1 : 0);
  if (mode === 'empty') expect(h.sendMessage).toHaveBeenCalledWith(8, { type: 'clf-tab-close-check', conversationId: null, failedCommand: { id: firstId, client: 'worker-client' } }, { documentId: source.documentId });
});
type Tab = { id: number; url?: string; pendingUrl?: string; windowId?: number; active?: boolean };
async function worker(inputs: Array<{ id: string; conversationId: string | null; supersededConversationId?: string }>, modelCatalogRequest?: { nonce: string; expiresAt: number }, priorLocal: Record<string, unknown> = {}) {
  const tabs: Tab[] = [];
  const event = { addListener: () => {} };
  const localSaved: Record<string, unknown> = { port: 8765, token: 'test-pairing', ...priorLocal };
  const local = { get: async () => ({ ...localSaved }), set: vi.fn(async (value: object) => { Object.assign(localSaved, value); }), remove: async () => {} };
  const saved: Record<string, unknown> = {};
  const session = { get: async () => ({ ...saved }), set: async (value: object) => { Object.assign(saved, value); }, remove: async (key: string) => { delete saved[key]; } };
  const create = vi.fn(async ({ url, windowId }: { url: string; windowId?: number }) => {
    const tab = { id: tabs.length + 1, pendingUrl: url, windowId }; tabs.push(tab); return tab;
  });
  const windows = {
    get: vi.fn(async (id: number) => ({ id })),
    create: vi.fn(async ({ url }: { url: string }) => ({ id: 80, tabs: [await create({ url, windowId: 80 })] })),
    update: vi.fn()
  };
  const remove = vi.fn(async (_id: number) => {});
  const sendMessage = vi.fn(async (_id: number, _message: any): Promise<{ ok: boolean; ready?: boolean }> => ({ ok: true, ready: true }));
  const update = vi.fn(async (id: number, patch: Partial<Tab>) => { const tab = tabs.find(tab => tab.id === id)!; Object.assign(tab, patch); delete tab.pendingUrl; return tab; });
  const fetch = vi.fn(async (input: string, _init?: RequestInit): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => ({
    ok: true, status: 200,
    json: async () => new URL(input).pathname === '/hello'
      ? { app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true }
      : { ok: true, inputs, background: true, modelCatalogRequest }
  }));
  const context = vm.createContext({
    chrome: {
      storage: { local, session },
      windows,
      runtime: { getManifest: () => ({ version: '2.0.5' }), onMessage: event, onInstalled: event, onStartup: event },
      tabs: { query: async () => [...tabs], get: async (id: number) => tabs.find(tab => tab.id === id), remove, create, update, sendMessage, onCreated: event, onUpdated: event, onRemoved: event },
      alarms: { onAlarm: event, create: () => {}, clear: async () => true },
      scripting: { executeScript: async () => [], insertCSS: async () => {} }
    },
    fetch, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, TextEncoder, console
  });
  vm.runInContext(`${source}\nglobalThis.testMaintenance = { load, maintain, releaseTab, serializeTab, noteTabConversation, createChatTab, authorizeDocument, ackDesktopInput, drainCommandAcks, inspectRequestedModels, desktopInput: HANDLERS.desktop_input, catalog: HANDLERS.model_catalog, events: HANDLERS.events, applyRequestedBrowserPreferences };`, context);
  const api = context.testMaintenance as { releaseTab(...args: any[]): Promise<any>; serializeTab(tab: number, operation: () => Promise<any>): Promise<any>; noteTabConversation(source: any, conversationId: string): Promise<any>; applyRequestedBrowserPreferences(request: object): Promise<void>; authorizeDocument(sender: unknown, message: unknown): Promise<any>; catalog(message: unknown, sender: unknown, source: unknown): Promise<any>; load(): Promise<void>; maintain(): Promise<void>; createChatTab(url: string, background: boolean): Promise<Tab> };
  await api.load();
  vm.runInContext('Object.assign(testMaintenance, { offerStopTurns, noteTabConversation, ackCommand })', context);
  return { ...api, update, inspectModels: (context.testMaintenance as any).inspectRequestedModels as (request: unknown, background: boolean) => Promise<void>, ackDesktopInput: (context.testMaintenance as any).ackDesktopInput as (...args: string[]) => Promise<any>, drainCommandAcks: (context.testMaintenance as any).drainCommandAcks as () => Promise<any>, desktopInput: (context.testMaintenance as any).desktopInput as (...args: any[]) => Promise<any>, events: (context.testMaintenance as any).events as (message: any, sender: any, source: any) => Promise<any>, create, sendMessage, tabs, fetch, windows, remove, local, localSaved, saved };
}

describe('one browser maintenance flight per desktop outbox publication', () => {
  it('moves a queued checkpoint to its existing compacted successor once, including legacy elections', async () => {
    const input = { id: firstId, conversationId: secondId, supersededConversationId: firstId };
    const h = await worker([input], undefined, { inputOpenings: { [firstId]: { tab: 7, stage: 'ready' } } });
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${firstId}` }, { id: 8, url: `https://chatgpt.com/c/${secondId}` });
    await h.maintain();
    expect(h.sendMessage).toHaveBeenCalledWith(8, expect.objectContaining({ type: 'clf-desktop-input', id: firstId, conversationId: secondId }));
    expect(h.create).not.toHaveBeenCalled();
    h.tabs.splice(1, 1, { id: 9, url: `https://chatgpt.com/c/${secondId}` });
    h.sendMessage.mockClear();
    await h.maintain();
    expect(h.sendMessage.mock.calls.some(([id, message]) => id === 9 && message.type === 'clf-desktop-input')).toBe(false);
    expect(h.create).not.toHaveBeenCalled();
    const restarted = await worker([input], undefined, h.localSaved);
    restarted.tabs.push({ id: 9, url: `https://chatgpt.com/c/${secondId}` });
    await restarted.maintain();
    expect(restarted.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-desktop-input')).toBe(false);
    expect(restarted.create).not.toHaveBeenCalled();
  });

  it('does not open a missing successor for an already elected checkpoint', async () => {
    const h = await worker([{ id: firstId, conversationId: secondId, supersededConversationId: firstId }], undefined,
      { inputOpenings: { [firstId]: { tab: 7, conversationId: firstId, stage: 'ready' } } });
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${firstId}` });
    await h.maintain();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-desktop-input')).toBe(false);
  });

  it.each(['closed', 'navigated'])('does not reopen an elected input tab after it is %s, including browser restart', async reason => {
    const input = { id: firstId, conversationId: null };
    const h = await worker([input]);
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
    if (reason === 'closed') h.tabs.length = 0;
    else { h.tabs[0]!.url = 'https://chatgpt.com/'; delete h.tabs[0]!.pendingUrl; }
    await h.maintain(); await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
    const restarted = await worker([input], undefined, h.localSaved);
    await restarted.maintain();
    expect(restarted.create).not.toHaveBeenCalled();
  });
  it('spends input opening authority before creation and permits a new explicit operation', async () => {
    const inputs = [{ id: firstId, conversationId: null }];
    const h = await worker(inputs);
    h.create.mockImplementationOnce(async () => { throw new Error('Chrome rejected creation'); });
    await expect(h.maintain()).rejects.toThrow('Chrome rejected creation'); await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
    inputs.splice(0, 1, { id: secondId, conversationId: null });
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(2);
  });
  it('does not create behind a failed custody write', async () => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.local.set.mockImplementation(async value => {
      if ('inputOpenings' in value) throw new Error('disk full');
      Object.assign(h.localSaved, value);
    });
    await expect(h.maintain()).rejects.toThrow('disk full'); await h.maintain();
    expect(h.create).not.toHaveBeenCalled();
  });
  it('restores the pre-create checkpoint without reopening after a crash before tab-id persistence', async () => {
    const input = { id: firstId, conversationId: null };
    const h = await worker([input], undefined, { inputOpenings: { [firstId]: { tab: null } } });
    await h.maintain();
    expect(h.create).not.toHaveBeenCalled();
    h.tabs.push({ id: 9, url: `https://chatgpt.com/?cos-input=${firstId}` });
    await h.maintain();
    expect(h.sendMessage).toHaveBeenCalledWith(9, expect.objectContaining({ type: 'clf-desktop-input', id: firstId }));
    expect(h.create).not.toHaveBeenCalled();
  });
  it('does not confuse a temporarily withheld offer with retired opening authority', async () => {
    const input = { id: firstId, conversationId: null };
    const inputs = [input];
    const h = await worker(inputs);
    await h.maintain(); h.tabs.length = 0;
    inputs.length = 0;
    await h.maintain();
    inputs.push(input);
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it('closes an explicitly retired temporary planner without requiring another work tab', async () => {
    const h = await worker([{ id: firstId, conversationId: null, owner: '7:planner:1', lifetime: 'temporary-planner', close: true, retire: true } as any]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?temporary-chat=true&cos-input=${firstId}` });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'planner', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async () => ({ safe: true } as never));
    await h.maintain();
    expect(h.remove).toHaveBeenCalledWith(7);
    expect(h.create).not.toHaveBeenCalled();
  });
  it('never opens a helper for passive model observation, including repeated maintenance', async () => {
    const h = await worker([]);
    const request = { nonce: firstId, expiresAt: Date.now() + 60000, allowOpen: false };
    await h.inspectModels(request, true); await h.inspectModels(request, true);
    expect(h.create).not.toHaveBeenCalled();
    h.tabs.push({ id: 8, url: `https://chatgpt.com/c/${secondId}` });
    await h.inspectModels(request, true);
    expect(h.sendMessage).toHaveBeenCalledWith(8, expect.objectContaining({ type: 'clf-model-catalog' }));
    expect(h.create).not.toHaveBeenCalled();
  });
  it('retains model discovery custody when a user closes its elected tab', async () => {
    const h = await worker([]);
    const request = { nonce: firstId, expiresAt: Date.now() + 60000 };
    await h.inspectModels(request, true);
    expect(h.create).toHaveBeenCalledTimes(1);
    h.tabs.length = 0;
    await h.inspectModels(request, true); await h.inspectModels(request, true);
    expect(h.create).toHaveBeenCalledTimes(1);
    // Only a new explicit request can authorize another tab.
    await h.inspectModels({ ...request, nonce: secondId }, true);
    expect(h.create).toHaveBeenCalledTimes(2);
  });
  it('does not close a temporary planner when its answer is accepted', async () => {
    const h = await worker([]);
    const url = `https://chatgpt.com/?temporary-chat=true&cos-input=${firstId}`;
    h.tabs.push({ id: 7, url });
    const sender = { tab: { id: 7 }, documentId: 'planner', frameId: 0, url };
    const owner = await h.authorizeDocument(sender, { navigationEpoch: 1 });
    expect((await h.desktopInput({ id: firstId, owner: '7:planner:1', lifetime: 'temporary-planner', response: 'Plan complete' }, sender, owner)).ok).toBe(true);
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('keeps the completed planner until a newer app-work tab exists, then closes only the planner', async () => {
    const work = { id: secondId, conversationId: null };
    const cleanup = { id: firstId, conversationId: null, owner: '7:planner:1', lifetime: 'temporary-planner', close: true, replacements: [work] };
    const inputs = [cleanup];
    const h = await worker(inputs);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?temporary-chat=true&cos-input=${firstId}` }, { id: 8, url: `https://chatgpt.com/c/${firstId}` });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'planner', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-close-temporary-planner' ? { safe: true } as never : { ok: true });
    await h.maintain(); expect(h.remove).not.toHaveBeenCalled();
    // The existing unrelated chat is not a successor. Opening the queued app input is.
    inputs.unshift(work as typeof cleanup);
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.remove.mock.calls).toEqual([[7]]);
    expect(h.create.mock.invocationCallOrder[0]).toBeLessThan(h.remove.mock.invocationCallOrder[0]!);
  });
  it.each(['draft', 'replacement-closed', 'navigation'])('keeps a retiring planner when %s prevents safe handoff', async reason => {
    const work = { id: secondId, conversationId: null };
    const h = await worker([{ id: firstId, conversationId: null, owner: '7:planner:1', lifetime: 'temporary-planner', close: true, replacements: [work] } as any]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?temporary-chat=true&cos-input=${firstId}` }, { id: 8, url: `https://chatgpt.com/?cos-input=${secondId}` });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'planner', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => {
      if (message.type !== 'clf-close-temporary-planner') return { ok: true };
      if (reason === 'replacement-closed') h.tabs.pop();
      if (reason === 'navigation') h.tabs[0]!.url = 'https://chatgpt.com/';
      return { safe: reason !== 'draft' } as never;
    });
    await h.maintain(); expect(h.remove).not.toHaveBeenCalled();
  });
  it('creates a small owned restore size, then minimizes without changing geometry again', async () => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true, ok: true, inputs: [{ id: firstId, conversationId: null }], background: true, browserWindowBounds: { left: -1510, top: 220, width: 800, height: 600 } }) });
    await h.maintain();
    expect(h.windows.create).toHaveBeenCalledWith(expect.objectContaining({ focused: false, left: -1510, top: 220, width: 800, height: 600 }));
    expect(h.windows.update).toHaveBeenCalledExactlyOnceWith(80, { state: 'minimized', focused: false });
  });
  it('reuses an idle conversation without opening or navigating a helper', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 8, url: `https://chatgpt.com/c/${secondId}` });
    await h.inspectModels({ nonce: firstId, expiresAt: Date.now() + 30000 }, true);
    expect(h.sendMessage).toHaveBeenCalledWith(8, expect.objectContaining({ type: 'clf-model-catalog', nonce: firstId }));
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('keeps catalog discovery minimized and unfocused even when foreground chats are preferred', async () => {
    const h = await worker([]);
    await h.inspectModels({ nonce: firstId, expiresAt: Date.now() + 30000 }, false);
    expect(h.windows.create).toHaveBeenCalledWith(expect.objectContaining({ focused: false, width: 800, height: 600 }));
    expect(h.windows.update).toHaveBeenCalledWith(80, { state: 'minimized', focused: false });
    expect(h.windows.update).toHaveBeenCalledTimes(1);
  });
  it('places an offered worker in its unfocused background window with discard protection', async () => {
    const h = await worker([]);
    let offered = true;
    h.fetch.mockImplementation(async (input) => ({ ok: true, status: 200, json: async () => {
      if (new URL(input).pathname === '/hello') return { app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true };
      const placement = offered ? { id: firstId, background: true, model: 'gpt-5.6-sol', reasoningEffort: 'medium' } : null;
      offered = false;
      return { ok: true, placement, inputs: [], background: true };
    } }));
    await h.maintain();
    expect(h.windows.create).toHaveBeenCalledWith(expect.objectContaining({ focused: false, width: 800, height: 600 }));
    expect(h.windows.update).toHaveBeenCalledWith(80, { state: 'minimized', focused: false });
    expect(h.windows.update).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledWith(1, { autoDiscardable: false });
    expect(String(h.create.mock.calls[0]?.[0]?.url)).toContain('model=gpt-5.6-sol&reasoning_effort=medium');
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it('retains the completed exact dedicated catalog for first-message reuse', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${firstId}` }, { id: 8, url: `https://chatgpt.com/c/${secondId}` });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'catalog', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-tab-close-check'
      ? { ok: true, safe: true, conversationId: null, navigationEpoch: 1 } as never : { ok: true, ready: true });
    h.remove.mockImplementation(async id => { h.tabs.splice(h.tabs.findIndex(tab => tab.id === id), 1); });
    const request = { nonce: secondId, expiresAt: Date.now() + 60000 };
    await h.inspectModels(request, true);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.saved.modelCatalogOwner).toEqual({ nonce: secondId, tab: 7 });
    await h.inspectModels(request, true);
    await h.inspectModels(null, true);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('retains a sole completed catalog after its draft clears', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${firstId}` });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'catalog', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    let safe = false;
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-tab-close-check'
      ? { ok: true, safe, conversationId: null, navigationEpoch: 1 } as never : { ok: true, ready: true });
    await h.inspectModels({ nonce: firstId, expiresAt: Date.now() + 60000 }, true);
    expect(h.remove).not.toHaveBeenCalled();
    safe = true;
    await h.inspectModels(null, true);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it('preserves a draft on a catalog marker and waits for unreachable old helpers instead of accumulating tabs', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${firstId}` });
    h.sendMessage.mockRejectedValueOnce(new Error('document loading'));
    await h.inspectModels({ nonce: secondId, expiresAt: Date.now() + 60000 }, true);
    expect(h.create).not.toHaveBeenCalled();
    h.sendMessage.mockResolvedValue({ ok: true, ready: false });
    await h.inspectModels(null, true);
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('hands the retained catalog to the first new input and never reopens it after the user closes it', async () => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${secondId}` });
    h.saved.modelCatalogOwner = { nonce: secondId, tab: 7 };
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'warm', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => {
      if (message.type === 'clf-input-reuse-state') return { ok: true, safe: true, navigationEpoch: 1 } as never;
      if (message.type === 'clf-prepare-desktop-input') h.tabs[0]!.url = `https://chatgpt.com/?cos-input=${firstId}#cos-input=${firstId}`;
      return { ok: true, ready: true };
    });
    await h.maintain();
    expect(h.sendMessage).toHaveBeenCalledWith(7, { type: 'clf-prepare-desktop-input', id: firstId }, { documentId: 'warm' });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled(); expect(h.remove).not.toHaveBeenCalled();
    await h.maintain();
    expect(h.sendMessage).toHaveBeenCalledWith(7, { type: 'clf-desktop-input', id: firstId, conversationId: null });
    h.tabs.splice(0);
    await h.maintain();
    await h.inspectModels({ nonce: secondId, expiresAt: Date.now() + 60000 }, true);
    expect(h.create).not.toHaveBeenCalled();
  });
  it.each(['https://chatgpt.com/', `https://chatgpt.com/c/${secondId}`])('reuses a safe unmarked idle page %s for a new input', async url => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.tabs.push({ id: 7, url, active: true });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'idle', frameId: 0, url }, { navigationEpoch: 1 });
    h.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ app: 'chat-on-steroids', bridge: BRIDGE_PROTOCOL, compatible: true, paired: true, ok: true, inputs: [{ id: firstId, conversationId: null }], reusableConversations: [secondId] }) });
    h.sendMessage.mockImplementation(async (_id, message) => {
      if (message.type === 'clf-input-reuse-state') return { ok: true, safe: true, navigationEpoch: 1 } as never;
      if (message.type === 'clf-prepare-desktop-input') h.tabs[0]!.url = `https://chatgpt.com/?cos-input=${firstId}`;
      return { ok: true, ready: true };
    });
    await h.maintain(); await h.maintain();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.sendMessage).toHaveBeenCalledWith(7, { type: 'clf-desktop-input', id: firstId, conversationId: null });
    expect((h.localSaved.inputOpenings as any)[firstId].tab).toBe(7);
  });
  it.each(['explicit-failure', 'ambiguous', 'closed'])('allows a single pre-send fallback only for %s', async reason => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.tabs.push({ id: 7, url: 'https://chatgpt.com/' });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'idle', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => {
      if (message.type === 'clf-input-reuse-state') return { ok: true, safe: true, navigationEpoch: 1 } as never;
      if (message.type === 'clf-prepare-desktop-input') {
        if (reason === 'ambiguous') throw new Error('lost response');
        if (reason === 'closed') h.tabs.length = 0;
        return { ready: false, fallback: true, preSend: true } as never;
      }
      return { ok: false };
    });
    await h.maintain(); await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(reason === 'explicit-failure' ? 1 : 0);
    h.tabs.length = 0;
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(reason === 'explicit-failure' ? 1 : 0);
  });
  it('delivers follow-up messages into an already open waiting conversation without closing or creating tabs', async () => {
    const h = await worker([{ id: firstId, conversationId: secondId }]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${secondId}` });
    await h.maintain(); await h.maintain();
    expect(h.sendMessage).toHaveBeenCalledWith(7, { type: 'clf-desktop-input', id: firstId, conversationId: secondId });
    expect(h.create).not.toHaveBeenCalled(); expect(h.remove).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
  });
  it('does not overwrite a draft to reuse a catalog document', async () => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${secondId}` });
    await h.authorizeDocument({ tab: { id: 7 }, documentId: 'draft', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-tab-close-check'
      ? { ok: true, safe: false, conversationId: null, navigationEpoch: 1 } as never : { ok: true, ready: true });
    await h.maintain();
    expect(h.update.mock.calls.some(([id, patch]) => id === 7 && 'url' in patch)).toBe(false);
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('adopts the oldest ready catalog and retires only its exact empty duplicate after restart', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 8, url: `https://chatgpt.com/?cos-model-catalog=${secondId}` }, { id: 7, url: `https://chatgpt.com/?cos-model-catalog=${firstId}` },
      { id: 9, url: `https://chatgpt.com/c/${firstId}` }, { id: 10, url: 'https://chatgpt.com/?cos-model-catalog=personal' });
    await h.authorizeDocument({ tab: { id: 8 }, documentId: 'duplicate', frameId: 0, url: h.tabs[0]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-tab-close-check'
      ? { ok: true, safe: true, conversationId: null, navigationEpoch: 1 } as never : { ok: true, ready: true });
    h.remove.mockImplementation(async id => { h.tabs.splice(h.tabs.findIndex(tab => tab.id === id), 1); });
    await h.inspectModels({ nonce: secondId, expiresAt: Date.now() + 60000 }, true);
    expect(h.sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({ type: 'clf-model-catalog' }));
    expect(h.sendMessage).toHaveBeenCalledWith(8, { type: 'clf-tab-close-check', conversationId: null }, { documentId: 'duplicate' });
    expect(h.remove.mock.calls).toEqual([[8]]);
    await h.inspectModels(null, true);
    expect(h.remove).toHaveBeenCalledTimes(1);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });
  it.each(['draft', 'navigation', 'document', 'unregistered'])('preserves a catalog duplicate with %s uncertainty', async reason => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${firstId}` }, { id: 8, url: `https://chatgpt.com/?cos-model-catalog=${secondId}` });
    const sender = { tab: { id: 8 }, documentId: 'duplicate', frameId: 0, url: h.tabs[1]!.url };
    if (reason !== 'unregistered') await h.authorizeDocument(sender, { navigationEpoch: 1 });
    h.sendMessage.mockImplementation(async (_id, message) => {
      if (message.type !== 'clf-tab-close-check') return { ok: true, ready: true };
      if (reason === 'navigation') h.tabs[1] = { id: 8, url: `https://chatgpt.com/c/${secondId}` };
      if (reason === 'document') await h.authorizeDocument({ ...sender, documentId: 'replacement' }, { navigationEpoch: 1 });
      return { ok: true, safe: reason !== 'draft', conversationId: null, navigationEpoch: 1 } as never;
    });
    await h.inspectModels(null, true);
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it('retires a newly hydrated duplicate on existing maintenance after catalog completion', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${firstId}` }, { id: 8, url: `https://chatgpt.com/?cos-model-catalog=${secondId}` });
    await h.inspectModels({ nonce: secondId, expiresAt: Date.now() + 60000 }, true);
    expect(h.remove).not.toHaveBeenCalled();
    await h.authorizeDocument({ tab: { id: 8 }, documentId: 'hydrated', frameId: 0, url: h.tabs[1]!.url }, { navigationEpoch: 1 });
    h.sendMessage.mockClear();
    h.sendMessage.mockImplementation(async (_id, message) => message.type === 'clf-tab-close-check'
      ? { ok: true, safe: true, conversationId: null, navigationEpoch: 1 } as never : { ok: true, ready: true });
    await h.inspectModels(null, true);
    expect(h.remove.mock.calls).toEqual([[8]]);
    expect(h.sendMessage.mock.calls.some(([, message]) => message.type === 'clf-model-catalog')).toBe(false);
  });
  it('durably replays an exact input ACK after HTTP loss and worker restart without sending text', async () => {
    const h = await worker([]);
    h.fetch.mockImplementation(async () => ({ ok: false, status: 503, json: async () => ({}) } as never));
    const receipt = { id: firstId, owner: '7:original-document:0', conversationId: 'conversation-a', messageId: 'native-user-a' };
    expect(await h.ackDesktopInput(receipt.id, receipt.owner, receipt.conversationId, receipt.messageId)).toMatchObject({ ok: true, queued: true });
    expect(h.localSaved.commandAckOutbox).toEqual([expect.objectContaining({ kind: 'input', ...receipt })]);
    const restarted = await worker([], undefined, JSON.parse(JSON.stringify(h.localSaved)));
    await restarted.drainCommandAcks();
    const requests = restarted.fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/input/ack');
    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(requests[0]?.[1]?.body))).toEqual(receipt);
    expect(restarted.localSaved.commandAckOutbox).toEqual([]);
    expect(restarted.create).not.toHaveBeenCalled();
    expect(restarted.sendMessage).not.toHaveBeenCalled();
  });
  it('rejects a different receipt for the same input and never acknowledges failed durable custody', async () => {
    const h = await worker([]);
    h.fetch.mockImplementation(async () => ({ ok: false, status: 503, json: async () => ({}) } as never));
    await h.ackDesktopInput(firstId, 'owner', 'conversation-a', 'native-a');
    expect(await h.ackDesktopInput(firstId, 'owner', 'conversation-b', 'native-b')).toMatchObject({ ok: false, error: 'conflicting_send_receipt' });
    h.local.set.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(h.ackDesktopInput(secondId, 'owner', 'conversation-b', 'native-b')).rejects.toThrow('storage unavailable');
  });
  it('journals only a receipt belonging to the current exact document and conversation', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${firstId}` });
    const sender = { tab: { id: 7 }, documentId: 'document-a', frameId: 0, url: h.tabs[0]!.url };
    const source = await h.authorizeDocument(sender, { navigationEpoch: 1 });
    const receipt = { id: firstId, owner: '7:document-a:0', conversationId: firstId, messageId: 'native-a', ack: true };
    h.tabs[0]!.url = `https://chatgpt.com/c/${secondId}`;
    expect(await h.desktopInput(receipt, sender, source)).toMatchObject({ ok: false, error: 'stale_send_receipt' });
    expect(h.fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/input/ack')).toHaveLength(0);
    h.tabs[0]!.url = sender.url;
    expect(await h.desktopInput(receipt, sender, source)).toMatchObject({ ok: true });
    expect(h.fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/input/ack')).toHaveLength(1);
  });
  it('binds an exact input project before publishing tool evidence and retains the batch on rejection', async () => {
    const h = await worker([]);
    const conversationId = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${conversationId}` });
    const sender = { tab: { id: 7 }, documentId: 'project-document', frameId: 0, url: h.tabs[0]!.url };
    const source = await h.authorizeDocument(sender, { navigationEpoch: 1 });
    const message = { conversationId, projectInput: { id: firstId, owner: '7:project-document:1' }, entries: [{ conversationId, event: { kind: 'tool_evidence', time: Date.now(), calls: [{ requestId: 'exact-request', tool: 'read' }] } }] };
    const original = h.fetch.getMockImplementation()!;
    let accepted = false;
    h.fetch.mockImplementation(async (url, init) => new URL(url).pathname === '/input/bind'
      ? { ok: true, status: 200, json: async () => ({ ok: accepted }) } : original(url, init));
    expect((await h.events(message, sender, source)).ok).toBe(false);
    expect(h.fetch.mock.calls.some(([url]) => new URL(url).pathname === '/events')).toBe(false);
    accepted = true;
    expect((await h.events(message, sender, source)).projectBound).toBe(firstId);
    const routes = h.fetch.mock.calls.map(([url]) => new URL(url).pathname);
    expect(routes.indexOf('/events')).toBeGreaterThan(routes.lastIndexOf('/input/bind'));
    h.fetch.mockClear();
    expect((await h.events({ ...message, projectInput: { id: firstId, owner: '7:another-document:1' } }, sender, source)).ok).toBe(false);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('acknowledges preferences without replaying a change over a newer popup value', async () => {
    const h = await worker([]);
    const request = { nonce: firstId, expiresAt: Date.now() + 60000, patch: { overwrite: false, durations: true } };
    await h.applyRequestedBrowserPreferences(request);
    expect(h.localSaved).toMatchObject({ renderStreamEnabled: false, showStreamTimes: true });
    h.localSaved.renderStreamEnabled = true;
    await h.applyRequestedBrowserPreferences(request);
    expect(h.local.set).toHaveBeenCalledTimes(1);
    expect(h.localSaved.renderStreamEnabled).toBe(true);
    const receipts = h.fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/browser/preferences').map(([, init]) => JSON.parse(String(init?.body)));
    expect(receipts).toEqual([expect.objectContaining({ nonce: firstId, values: { overwrite: false, durations: true } }), expect.objectContaining({ nonce: firstId, values: { overwrite: false, durations: true } })]);
    await h.applyRequestedBrowserPreferences({ nonce: secondId, expiresAt: Date.now() + 60000, patch: {} });
    expect(JSON.parse(String(h.fetch.mock.calls.at(-1)?.[1]?.body)).values).toEqual({ overwrite: true, durations: true });
  });
  it('does not replay a preference write interrupted after its durable reservation', async () => {
    const h = await worker([]);
    h.saved.browserPreferenceReceipt = { nonce: firstId, values: null, error: 'Write was interrupted' };
    await h.applyRequestedBrowserPreferences({ nonce: firstId, expiresAt: Date.now() + 60000, patch: { durations: true } });
    expect(h.local.set).not.toHaveBeenCalled();
    expect(JSON.parse(String(h.fetch.mock.calls.at(-1)?.[1]?.body))).toMatchObject({ values: null, error: 'Write was interrupted' });
  });
  it('accepts only a requested document observation and keeps the helper open', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 7, url: `https://chatgpt.com/?cos-model-catalog=${firstId}` });
    const sender = { tab: { id: 7 }, documentId: 'catalog-document', frameId: 0, url: h.tabs[0]!.url };
    const source = await h.authorizeDocument(sender, { navigationEpoch: 1 });
    expect(source.ok).toBe(true);
    const message = { nonce: firstId, models: null, close: true };
    expect((await h.catalog(message, sender, source)).ok).toBe(false);
    h.sendMessage.mockImplementation(async (_id: number, request: any) => {
      if (request.type === 'clf-model-catalog-state') return { ok: true, ready: true };
      expect((await h.catalog(message, sender, source)).ok).toBe(true);
      return { ok: true };
    });
    await h.inspectModels({ nonce: firstId, expiresAt: Date.now() + 60000 }, true);
    expect(h.remove).not.toHaveBeenCalled();
    h.remove.mockClear();
    h.tabs[0]!.url = 'https://chatgpt.com/c/some-user-chat';
    expect((await h.catalog(message, sender, source)).ok).toBe(false);
    expect(h.remove).not.toHaveBeenCalled();
    h.tabs[0]!.url = `https://chatgpt.com/?cos-model-catalog=${firstId}`;
    await h.authorizeDocument({ ...sender, documentId: 'replacement-document' }, { navigationEpoch: 1 });
    expect((await h.catalog(message, sender, source)).ok).toBe(false);
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('reserves initial catalog opening before Chrome acts and never retries an ambiguous failure', async () => {
    const h = await worker([]);
    const request = { nonce: firstId, expiresAt: Date.now() + 120000, allowOpen: true };
    h.windows.create.mockImplementation(async () => {
      expect(h.saved.modelCatalogOwner).toEqual({ nonce: firstId, opening: true });
      throw new Error('Chrome may already have created the window');
    });
    await h.inspectModels(request, true);
    await h.inspectModels(request, true);
    expect(h.windows.create).toHaveBeenCalledTimes(1);
    expect(h.saved.modelCatalogOwner).toEqual({ nonce: firstId, opening: true });
  });
  it('opens one owned blank catalog tab without blocking maintenance on DOM inspection', async () => {
    const request = { nonce: firstId, expiresAt: Date.now() + 120000 };
    const h = await worker([], request);
    await h.maintain();
    await vi.waitFor(() => expect(h.create).toHaveBeenCalledTimes(1));
    expect(h.tabs[0]!.pendingUrl).toBe(`https://chatgpt.com/?cos-model-catalog=${firstId}`);
    let finish!: () => void;
    h.sendMessage.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ ok: true, ready: true }); }));
    await h.maintain();
    await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalled());
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    finish();
  });
  it('reuses its own minimized window and never minimizes a user window', async () => {
    const h = await worker([]);
    h.tabs.push({ id: 90, windowId: 3, url: 'https://chatgpt.com/c/user-chat' });
    await Promise.all([h.createChatTab('https://chatgpt.com/?first', true), h.createChatTab('https://chatgpt.com/?second', true)]);
    expect(h.windows.create).toHaveBeenCalledTimes(1);
    expect(h.windows.create).toHaveBeenCalledWith(expect.objectContaining({ width: 800, height: 600, focused: false }));
    expect(h.create.mock.calls.every(([args]) => args.windowId === 80)).toBe(true);
    expect(h.windows.update).toHaveBeenCalledExactlyOnceWith(80, { state: 'minimized', focused: false });
    h.create.mockRejectedValueOnce(new Error('tab failed'));
    await expect(h.createChatTab('https://chatgpt.com/?third', true)).rejects.toThrow('tab failed');
    expect(h.windows.create).toHaveBeenCalledTimes(1);
    h.windows.get.mockRejectedValueOnce(new Error('window closed'));
    await h.createChatTab('https://chatgpt.com/?fourth', true);
    expect(h.windows.create).toHaveBeenCalledTimes(2);
  });
  it('coalesces simultaneous passes while Chrome has not returned the first created tab', async () => {
    const h = await worker([{ id: firstId, conversationId: null }, { id: secondId, conversationId: null }]);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const normalCreate = h.create.getMockImplementation()!;
    h.create.mockImplementationOnce(async (args) => { entered(); await held; return normalCreate(args); });
    const one = h.maintain();
    await reached;
    const two = h.maintain();
    expect(two).toBe(one);
    expect(h.create).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([one, two]);
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.tabs.map(tab => new URL(tab.pendingUrl!).searchParams.get('cos-input'))).toEqual([firstId, secondId]);
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('releases a failed flight without granting another opening after ambiguous Chrome failure', async () => {
    const h = await worker([{ id: firstId, conversationId: null }]);
    h.tabs.push({ id: 50, url: `https://chatgpt.com/?other=cos-input=${firstId}` });
    h.create.mockRejectedValueOnce(new Error('Chrome temporarily refused tab creation'));
    await expect(h.maintain()).rejects.toThrow('temporarily refused');
    await h.maintain();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.tabs).toHaveLength(1);
  });
});

describe('Stop uses an existing exact registered browser document', () => {
  it('targets only the registered conversation document, never opens a tab, and ignores navigation', async () => {
    const h = await worker([]) as any;
    h.tabs.push({ id: 7, url: `https://chatgpt.com/c/${firstId}` });
    h.tabs.push({ id: 8, url: `https://chatgpt.com/c/${secondId}` });
    const source = await h.authorizeDocument({ tab: { id: 7 }, documentId: 'stop-document', frameId: 0, url: h.tabs[0].url }, { navigationEpoch: 1 });
    await h.noteTabConversation(source, firstId);
    const command = { id: '1122334455667788', conversationId: firstId, turnId: 'exact-turn' };
    h.offerStopTurns([command]);
    await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledWith(7, { type: 'clf-stop-turn', ...command }, { documentId: 'stop-document' }));
    expect(h.create).not.toHaveBeenCalled();
    h.sendMessage.mockClear(); h.tabs[0].url = `https://chatgpt.com/c/${secondId}`;
    h.offerStopTurns([{ ...command, id: '1122334455667799' }]);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it('retains exact turn identity in the existing ACK journal across restart', async () => {
    const h = await worker([]) as any;
    h.fetch.mockImplementation(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await h.ackCommand('1122334455667788', 'sent', null, firstId, null, 'stop-document', null, 'exact-turn');
    expect(h.localSaved.commandAckOutbox[0]).toMatchObject({ turnId: 'exact-turn', conversationId: firstId });
    const restarted = await worker([], undefined, JSON.parse(JSON.stringify(h.localSaved)));
    await restarted.drainCommandAcks();
    const ack = restarted.fetch.mock.calls.find(([url]) => new URL(url).pathname === '/commands/ack');
    expect(JSON.parse(String(ack?.[1]?.body))).toMatchObject({ turnId: 'exact-turn', conversationId: firstId, client: 'stop-document' });
    expect(restarted.sendMessage).not.toHaveBeenCalled();
  });
});

it('releases departed-chat ownership so input claims and model discovery cannot deadlock each other', async () => {
  const inputs: Array<{ id: string; conversationId: string | null }> = [];
  const h = await worker(inputs, { nonce: firstId, expiresAt: Date.now() + 60000 });
  const tab = { id: 7, url: `https://chatgpt.com/c/${secondId}` }; h.tabs.push(tab);
  const sender = { tab: { id: 7 }, documentId: 'reused-document', frameId: 0 };
  const source = await h.authorizeDocument(sender, { navigationEpoch: 1 });
  await h.noteTabConversation(source, secondId);
  // Chrome reports A's departure as New Chat prepares B in the elected tab.
  tab.url = `https://chatgpt.com/?cos-input=${firstId}#cos-input=${firstId}`;
  inputs.push({ id: firstId, conversationId: null });
  let claimed = false, catalogObserved = false;
  h.sendMessage.mockImplementation(async (id, message) => {
    if (message.type === 'clf-model-catalog-state') return { ok: true, ready: true };
    if (message.type === 'clf-model-catalog') {
      await h.serializeTab(id, async () => {
        const current = await h.authorizeDocument(sender, { navigationEpoch: 1 });
        const result = await h.catalog({ nonce: firstId, models: [{ id: 'observed-model', label: 'Observed model', efforts: ['high'] }] }, sender, current);
        catalogObserved = result.ok;
      });
    }
    if (message.type === 'clf-desktop-input') {
      // Real desktop_input IPC uses the same serializeTab queue as releaseTab.
      await h.serializeTab(id, async () => {
        const current = await h.authorizeDocument(sender, { navigationEpoch: 1 });
        const result = await h.desktopInput({ id: firstId, conversationId: null, requiresAuthorization: true }, sender, current);
        claimed = result.ok;
      });
    }
    return { ok: true };
  });
  let released = false;
  const departure = h.serializeTab(7, () => h.releaseTab(7, secondId, sender.documentId, 1))
    .then(() => { released = true; });
  // A bounded observation exposes the circular wait in the old implementation.
  await vi.waitFor(() => { expect(released).toBe(true); expect(claimed).toBe(true); expect(catalogObserved).toBe(true); });
  await departure; await h.maintain();
  expect(h.fetch.mock.calls.some(([url]) => new URL(url).pathname === '/closed')).toBe(true);
  expect(h.fetch.mock.calls.some(([url]) => new URL(url).pathname === '/input/claim')).toBe(true);
  expect(h.fetch.mock.calls.some(([url]) => new URL(url).pathname === '/models')).toBe(true);
  expect(h.localSaved.inputOpenings).toMatchObject({ [firstId]: { tab: 7, stage: 'ready' } });
  expect(h.create).not.toHaveBeenCalled();
});
