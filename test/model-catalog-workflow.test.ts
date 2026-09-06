import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
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
  const context = vm.createContext({ URL, Date, setTimeout, clearTimeout, document: dom.window.document,
    MutationObserver: dom.window.MutationObserver, alive: true, epoch: 1, conversationId: null,
    generating: false, desktopInputBusy: false, modelCatalogBusy: false,
    location: { pathname: '/', href: `https://chatgpt.com/?cos-model-catalog=${nonce}` }, ask,
    CLF_DOM: { composer: () => dom.window.document.querySelector('textarea'), generating: () => false,
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
    CLF_DOM: { composer: () => composer, generating: () => false, turns: () => [], hasComposerAttachments: () => false, clearPromptExact: clear, inspectModelSettings: inspect } });
  vm.runInContext(`${section}\nglobalThis.run = inspectAppModelCatalog;`, context);
  return { composer, ask, clear, inspect, run: () => (context.run as Function)({ nonce, expiresAt: Date.now() + 10000 }) };
}
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
it('does not clear existing conversations or publish over text edited during discovery', async () => {
  const existing = fixture('keep', false, 'existing-chat');
  expect(await existing.run()).toBe(false); expect(existing.clear).not.toHaveBeenCalled();
  const edited = fixture('', true);
  expect(await edited.run()).toBe(false); expect(edited.ask).not.toHaveBeenCalled();
  expect(edited.composer.textContent).toBe('new user text');
});
