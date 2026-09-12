import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
it.each([
  { pluginRefreshBusy: false, pendingTools: 0 },
  { pluginRefreshBusy: true, pendingTools: 0 },
  { pluginRefreshBusy: false, pendingTools: 1 }
])('tab retirement preserves active plugin refresh or local tools (%j)', async ({ pluginRefreshBusy, pendingTools }) => {
  const start = source.indexOf("      if (message.type === 'clf-tab-close-check')");
  const section = source.slice(start, source.indexOf("      if (message.type === 'clf-close-temporary-planner')", start));
  let resolve!: (value: any) => void;
  const response = new Promise<any>(done => { resolve = done; });
  const context = vm.createContext({ message: { type: 'clf-tab-close-check', conversationId: null }, sendResponse: resolve,
    startupCommandId: null, RUN_ID: 'document', OPENED_CONVERSATION: null, conversationId: null, commandsHandled: new Set(),
    alive: true, epoch: 1, desktopDecision: null, fiberTerminalMessageId: null, generating: false, pendingTools,
    desktopInputBusy: false, modelCatalogBusy: false, pluginRefreshBusy, commandAttempt: null, commandJournalGate: false,
    queue: [], flushWork: null, CLF_DOM: { conversationId: () => null, generating: () => false, composer: () => ({ textContent: '' }), hasComposerAttachments: () => false }
  });
  vm.runInContext(`(function () { ${section} })()`, context);
  expect(await response).toMatchObject({ safe: !pluginRefreshBusy && pendingTools === 0 });
});
it('defers desktop delivery while catalog inspection owns the provider picker', async () => {
  const context = vm.createContext({ desktopInputBusy: false, modelCatalogBusy: true });
  const accept = source.slice(source.indexOf('  async function acceptDesktopInput('), source.indexOf('  let modelCatalogBusy ='));
  vm.runInContext(`${accept}\nglobalThis.accept = acceptDesktopInput;`, context);
  expect(await (context.accept as Function)({ conversationId: 'existing-chat' })).toBe(false);
  expect(context.desktopInputBusy).toBe(false);
});
const section = source.slice(source.indexOf('  function catalogPageReady('), source.indexOf('  /** Popup commands target this tab'));
const nonce = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
it.each([false, true])('holds cold discovery until composer hydration without a maintenance poll (navigation=%s)', async navigated => {
  const dom = new JSDOM('<html><body></body></html>');
  const ask = vi.fn(async () => ({ ok: true }));
  const clear = vi.fn(() => true);
  const context = vm.createContext({ URL, Date, setTimeout, clearTimeout, pageViewChecks: new Set(), document: dom.window.document,
    MutationObserver: dom.window.MutationObserver, alive: true, epoch: 1, conversationId: null,
    generating: false, desktopInputBusy: false, modelCatalogBusy: false,
    location: { pathname: '/', href: `https://chatgpt.com/?cos-model-catalog=${nonce}` }, ask,
    CLF_DOM: { prepareChatModelSurface: async () => true, composerVisible: () => !!dom.window.document.querySelector('textarea'), composer: () => dom.window.document.querySelector('textarea'), generating: () => false,
      turns: () => [], hasComposerAttachments: () => false, clearPromptExact: clear, inspectModelSettings: async () => [{ id: 'observed', label: 'Observed', efforts: ['high'] }] }
  });
  const wait = source.slice(source.indexOf('  function waitPageView('), source.indexOf('  async function refreshManagedPlugin('));
  vm.runInContext(`${wait}\n${section}\nglobalThis.run = inspectAppModelCatalog;`, context);
  const pending = (context.run as Function)({ nonce, expiresAt: Date.now() + 5000 });
  expect(ask).not.toHaveBeenCalled();
  if (navigated) context.epoch = 2;
  const composer = dom.window.document.createElement('textarea');
  if (navigated) composer.textContent = 'new user draft on replacement page';
  dom.window.document.body.append(composer);
  expect(await pending).toBe(!navigated);
  expect(ask).toHaveBeenCalledTimes(navigated ? 0 : 1);
  expect(context.pageViewChecks.size).toBe(0);
  expect(clear).not.toHaveBeenCalled();
  dom.window.close();
});
function fixture(text = '', changed = false, conversationId: string | null = null) {
  const composer = { textContent: text };
  const ask = vi.fn(async () => ({ ok: true }));
  const clear = vi.fn((expected: string) => { if (composer.textContent !== expected) return false; composer.textContent = ''; return true; });
  const inspect = vi.fn(async (current: () => boolean) => { if (changed) composer.textContent = 'new user text'; return current() ? [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['high'] }] : null; });
  const context = vm.createContext({ URL, Date, alive: true, epoch: 1, conversationId, generating: false, desktopInputBusy: false, modelCatalogBusy: false,
    location: { pathname: '/', href: `https://chatgpt.com/?cos-model-catalog=${nonce}` }, ask,
    CLF_DOM: { prepareChatModelSurface: async () => true, composerVisible: () => true, composer: () => composer, generating: () => false, turns: () => [], hasComposerAttachments: () => false, clearPromptExact: clear, inspectModelSettings: inspect } });
  vm.runInContext(`${section}\nglobalThis.run = inspectAppModelCatalog;`, context);
  return { composer, ask, clear, inspect, run: (allowPrepare = false) => (context.run as Function)({ nonce, expiresAt: Date.now() + 10000, allowPrepare }) };
}
it('reports missing picker on the elected document without granting New Chat preparation', async () => {
  const f = fixture('', false, 'existing-chat');
  f.inspect.mockImplementation(async (_current: () => boolean, failure?: (reason: string) => void) => { failure?.('picker_unavailable'); return null as never; });
  expect(await f.run(true)).toBe(true);
  expect(f.ask).toHaveBeenCalledWith(expect.objectContaining({ models: null, error: 'picker_unavailable' }));
  expect(await f.run(false)).toBe(true);
  expect(f.ask).toHaveBeenCalledWith(expect.objectContaining({ models: null, error: 'picker_unavailable' }));
});
it('clears restored home text and publishes the observed catalog', async () => {
  const f = fixture('hey\nOld finish instruction');
  expect(await f.run()).toBe(true);
  expect(f.clear).toHaveBeenCalledWith('hey\nOld finish instruction');
  expect(f.composer.textContent).toBe('');
  expect(f.ask).toHaveBeenCalledWith(expect.objectContaining({ type: 'model_catalog', nonce, models: expect.any(Array) }));
});
it('inspects an idle existing conversation without clearing or sending its composer', async () => {
  const f = fixture('', false, 'existing-chat');
  expect(await f.run()).toBe(true);
  expect(f.clear).not.toHaveBeenCalled();
  expect(f.ask).toHaveBeenCalledWith(expect.objectContaining({ type: 'model_catalog' }));
});
it('reads a running Pro tab passively without clearing its draft or opening the picker', async () => {
  const composer = { textContent: 'Unsent follow-up' };
  const models = [{ id: '6', label: 'GPT-6 Pro', efforts: ['pro'], aliases: ['gpt-6-pro'] }];
  const ask = vi.fn(async () => ({ ok: true })), prepare = vi.fn(), inspect = vi.fn(), clear = vi.fn();
  const context = vm.createContext({ URL, Date, alive: true, epoch: 1, conversationId: 'existing-chat', generating: true,
    desktopInputBusy: false, modelCatalogBusy: false, location: { pathname: '/c/existing-chat', href: 'https://chatgpt.com/c/existing-chat' }, ask,
    CLF_DOM: { composerVisible: () => true, composer: () => composer, generating: () => true, hasComposerAttachments: () => false,
      inspectVisibleModelSettings: async (current: () => boolean) => current() ? models : null,
      prepareChatModelSurface: prepare, inspectModelSettings: inspect, clearPromptExact: clear }
  });
  vm.runInContext(`${section}\nglobalThis.run = inspectAppModelCatalog;`, context);
  expect(await (context.run as Function)({ nonce, expiresAt: Date.now() + 10000 })).toBe(true);
  expect(ask).toHaveBeenCalledWith({ type: 'model_catalog', nonce, models });
  expect(prepare).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
  expect(composer.textContent).toBe('Unsent follow-up');
});

it('binds discovery to the Chat composer after Work replaces its composer', async () => {
  let composer = { textContent: '' };
  const old = composer, ask = vi.fn(async () => ({ ok: true }));
  const prepare = vi.fn(async (current: () => boolean) => {
    expect(current()).toBe(true); composer = { textContent: '' }; return current();
  });
  const context = vm.createContext({ URL, Date, alive: true, epoch: 1, conversationId: null, generating: false, desktopInputBusy: false, modelCatalogBusy: false,
    location: { pathname: '/', href: 'https://chatgpt.com/' }, ask,
    CLF_DOM: { prepareChatModelSurface: prepare, composerVisible: () => true, composer: () => composer, generating: () => false, turns: () => [], hasComposerAttachments: () => false,
      inspectModelSettings: async (current: () => boolean) => { expect(composer).not.toBe(old); expect(current()).toBe(true); return [{ id: 'observed', label: 'Observed', efforts: ['high'] }]; } }
  });
  vm.runInContext(`${section}\nglobalThis.run = inspectAppModelCatalog;`, context);
  expect(await (context.run as Function)({ nonce, expiresAt: Date.now() + 10000 })).toBe(true);
  expect(prepare).toHaveBeenCalledTimes(1); expect(ask).toHaveBeenCalledTimes(1);
});
it('does not clear existing conversations or publish over text edited during discovery', async () => {
  const existing = fixture('keep', false, 'existing-chat');
  expect(await existing.run()).toBe(false); expect(existing.clear).not.toHaveBeenCalled();
  const edited = fixture('', true);
  expect(await edited.run()).toBe(false); expect(edited.ask).not.toHaveBeenCalled();
  expect(edited.composer.textContent).toBe('new user text');
});
