import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Config } from '../src/shared/types.js';

let dom: JSDOM;
let sendInputCalls: any[] = [];

function setupDom(html: string, initialCatalog: any) {
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window as any;

  sendInputCalls = [];

  const ok = (data: any) => Promise.resolve({ ok: true as const, data });
  let chatModelsListener: ((cat: any) => void) | null = null;

  const api: any = new Proxy(
    {
      getChatModels: async () => ok(initialCatalog),
      requestChatModels: async () => ok(initialCatalog),
      onChatModelsChanged: (listener: (cat: any) => void) => {
        chatModelsListener = listener;
        if (initialCatalog) listener(initialCatalog);
        return () => { chatModelsListener = null; };
      },
      listSessions: async () => ok({ sessions: [], activeId: null, pressure: [], total: 0, nextCursor: null }),
      getSession: async () => ok({ summary: null, events: [], total: 0, nextFrom: 1 }),
      getSwarm: async () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
      onSessionChanged: () => () => {},
      onTaskProgress: () => () => {},
      onSwarmChanged: () => () => {},
      sendInput: async (payload: any) => {
        sendInputCalls.push(payload);
        return ok({ id: payload.id, sessionId: payload.sessionId, state: 'queued', dueAt: Date.now() });
      }
    },
    {
      get(target, prop) {
        if (prop in target) return (target as any)[prop];
        return (..._args: any[]) => ok(null);
      }
    }
  );

  w.api = api;
  if (!w.matchMedia) {
    w.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  }
  if (!w.HTMLElement.prototype.scrollIntoView) {
    w.HTMLElement.prototype.scrollIntoView = () => {};
  }
  if (!w.HTMLElement.prototype.animate) {
    w.HTMLElement.prototype.animate = () => ({ finish: () => {} });
  }

  Object.assign(globalThis, {
    window: w,
    document: w.document,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    DocumentFragment: w.DocumentFragment,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLButtonElement: w.HTMLButtonElement,
    Event: w.Event,
    CustomEvent: w.CustomEvent
  });

  return { w, pushCatalog: (c: any) => chatModelsListener?.(c) };
}

afterEach(() => {
  dom?.window.close();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('Composer Native Mode', () => {
  it('Test 1: Native mode + no model catalogue (models: []) => send allowed (model: null, reasoningEffort: null)', async () => {
    const html = await readFile('src/renderer/index.html', 'utf8');
    const catalog = { state: 'ready', requestedAt: 1, observedAt: 2, models: [] };
    setupDom(html, catalog);

    const { initChat } = await import('../src/renderer/chat.js');
    const { getComposerMode, isNativeComposerMode } = await import('../src/renderer/chat-models.js');

    const config = {
      sessions: { record: true, limitTokens: 533000 },
      compaction: { auto: true, autoTokens: 400000 },
      ui: { developerMode: true, planBackend: 'chatgpt' },
      multiAgent: {},
      goal: {}
    } as Config;

    initChat({ save: async () => {}, state: () => ({ config }) as any });
    await Promise.resolve();

    expect(getComposerMode()).toBe('native');
    expect(isNativeComposerMode()).toBe(true);

    const input = dom.window.document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = 'Hello in native mode without models';

    const form = dom.window.document.getElementById('composer') as HTMLFormElement;
    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));

    await Promise.resolve();
    await Promise.resolve();
    await new Promise(r => setTimeout(r, 20));

    expect(sendInputCalls).toHaveLength(1);
    expect(sendInputCalls[0].text).toBe('Hello in native mode without models');
    expect(sendInputCalls[0].model).toBeNull();
    expect(sendInputCalls[0].reasoningEffort).toBeNull();
  });

  it('Test 2: Native mode + picker_unavailable => send allowed', async () => {
    const html = await readFile('src/renderer/index.html', 'utf8');
    const catalog = { state: 'unavailable', requestedAt: 1, observedAt: null, models: [], error: 'picker_unavailable' };
    setupDom(html, catalog);

    const { initChat } = await import('../src/renderer/chat.js');
    const { getComposerMode } = await import('../src/renderer/chat-models.js');

    const config = {
      sessions: { record: true, limitTokens: 533000 },
      compaction: { auto: true, autoTokens: 400000 },
      ui: { developerMode: true, planBackend: 'chatgpt' },
      multiAgent: {},
      goal: {}
    } as Config;

    initChat({ save: async () => {}, state: () => ({ config }) as any });
    await Promise.resolve();

    expect(getComposerMode()).toBe('native');

    const input = dom.window.document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = 'Native send when picker is unavailable';

    const form = dom.window.document.getElementById('composer') as HTMLFormElement;
    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));

    await Promise.resolve();
    await Promise.resolve();
    await new Promise(r => setTimeout(r, 20));

    expect(sendInputCalls).toHaveLength(1);
    expect(sendInputCalls[0].text).toBe('Native send when picker is unavailable');
    expect(sendInputCalls[0].model).toBeNull();
    expect(sendInputCalls[0].reasoningEffort).toBeNull();
  });

  it('Test 3: Explicit mode + picker_unavailable => send blocked with error toast', async () => {
    const html = await readFile('src/renderer/index.html', 'utf8');
    const catalog = { state: 'unavailable', requestedAt: 1, observedAt: null, models: [], error: 'picker_unavailable' };
    setupDom(html, catalog);

    const { initChat } = await import('../src/renderer/chat.js');
    const { setComposerMode, getComposerMode } = await import('../src/renderer/chat-models.js');

    const config = {
      sessions: { record: true, limitTokens: 533000 },
      compaction: { auto: true, autoTokens: 400000 },
      ui: { developerMode: true, planBackend: 'chatgpt' },
      multiAgent: {},
      goal: {}
    } as Config;

    initChat({ save: async () => {}, state: () => ({ config }) as any });
    await Promise.resolve();

    setComposerMode('explicit');
    expect(getComposerMode()).toBe('explicit');

    const input = dom.window.document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = 'Should be blocked';

    const form = dom.window.document.getElementById('composer') as HTMLFormElement;
    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));

    await Promise.resolve();
    await Promise.resolve();
    await new Promise(r => setTimeout(r, 20));

    expect(sendInputCalls).toHaveLength(0);
    expect(input.value).toBe('Should be blocked');
  });

  it('Test 4: Explicit mode + observed model => send allowed with { model, reasoningEffort }', async () => {
    const html = await readFile('src/renderer/index.html', 'utf8');
    const catalog = {
      state: 'ready',
      requestedAt: 1,
      observedAt: 2,
      models: [{ id: 'sol', label: 'GPT-5.6 Sol', efforts: ['high', 'pro'] }]
    };
    setupDom(html, catalog);

    const { initChat } = await import('../src/renderer/chat.js');
    const { applyChatModels, setComposerMode, confirmedComposerModel } = await import('../src/renderer/chat-models.js');

    const config = {
      sessions: { record: true, limitTokens: 533000 },
      compaction: { auto: true, autoTokens: 400000 },
      ui: { developerMode: true, planBackend: 'chatgpt' },
      multiAgent: {},
      goal: {}
    } as Config;

    initChat({ save: async () => {}, state: () => ({ config }) as any });
    setComposerMode('explicit');
    applyChatModels(config);
    await Promise.resolve();

    const slider = dom.window.document.querySelector<HTMLInputElement>('#composerPowerChoices input');
    if (slider) {
      slider.value = '0';
      slider.dispatchEvent(new dom.window.Event('input'));
    }

    expect(confirmedComposerModel()).toEqual({ model: 'sol', reasoningEffort: 'high' });

    const input = dom.window.document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = 'Explicit send with confirmed model';

    const form = dom.window.document.getElementById('composer') as HTMLFormElement;
    form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));

    await Promise.resolve();
    await Promise.resolve();
    await new Promise(r => setTimeout(r, 20));

    expect(sendInputCalls).toHaveLength(1);
    expect(sendInputCalls[0].text).toBe('Explicit send with confirmed model');
    expect(sendInputCalls[0].model).toBe('sol');
    expect(sendInputCalls[0].reasoningEffort).toBe('high');
  });

  it('Test 5: Switch native <-> explicit preserves correct state and labels', async () => {
    const html = await readFile('src/renderer/index.html', 'utf8');
    const catalog = {
      state: 'ready',
      requestedAt: 1,
      observedAt: 2,
      models: [{ id: 'sol', label: 'GPT-5.6 Sol', efforts: ['high'] }]
    };
    setupDom(html, catalog);

    const { initChatModels, applyChatModels, getComposerMode } = await import('../src/renderer/chat-models.js');
    const config = { multiAgent: {}, goal: {} } as Config;

    initChatModels();
    applyChatModels(config);
    await Promise.resolve();

    const label = dom.window.document.getElementById('composerModelLabel')!;
    const defaultBtn = dom.window.document.getElementById('composerDefaultBtn') as HTMLButtonElement;

    // Initially in native mode
    expect(getComposerMode()).toBe('native');
    expect(label.textContent).toBe('ChatGPT Default');
    expect(defaultBtn.hidden).toBe(true);

    // Switch to explicit via slider selection
    const slider = dom.window.document.querySelector<HTMLInputElement>('#composerPowerChoices input')!;
    slider.dispatchEvent(new dom.window.Event('input'));

    expect(getComposerMode()).toBe('explicit');
    expect(label.textContent).toBe('GPT-5.6 Sol · High');
    expect(defaultBtn.hidden).toBe(false);

    // Switch back to native using the "Use ChatGPT Default" button
    defaultBtn.click();

    expect(getComposerMode()).toBe('native');
    expect(label.textContent).toBe('ChatGPT Default');
    expect(defaultBtn.hidden).toBe(true);
  });

  it('Test 6: Changing/reloading model catalogue does not erase Native mode', async () => {
    const html = await readFile('src/renderer/index.html', 'utf8');
    let catalog: any = { state: 'pending', requestedAt: 1, observedAt: null, models: [] };
    const { pushCatalog } = setupDom(html, catalog);

    const { initChatModels, applyChatModels, getComposerMode, isNativeComposerMode } = await import('../src/renderer/chat-models.js');
    const config = { multiAgent: {}, goal: {} } as Config;

    initChatModels();
    applyChatModels(config);
    await Promise.resolve();

    expect(getComposerMode()).toBe('native');
    expect(isNativeComposerMode()).toBe(true);
    const label = dom.window.document.getElementById('composerModelLabel')!;
    expect(label.textContent).toBe('ChatGPT Default');

    // Catalog update arrives with observed models
    catalog = {
      state: 'ready',
      requestedAt: 1,
      observedAt: 2,
      models: [{ id: 'sol', label: 'GPT-5.6 Sol', efforts: ['high', 'xhigh'] }]
    };
    pushCatalog(catalog);
    applyChatModels(config);
    await Promise.resolve();

    // Native mode MUST remain intact
    expect(getComposerMode()).toBe('native');
    expect(isNativeComposerMode()).toBe(true);
    expect(label.textContent).toBe('ChatGPT Default');
  });
});
