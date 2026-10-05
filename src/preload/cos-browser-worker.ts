/**
 * Service-worker preload for the CoS browser.
 *
 * Electron runs the companion extension unchanged, but its own `chrome.tabs` lacks the tab state
 * and events the extension orchestrates with, and it has no `chrome.windows` or
 * `chrome.debugger`. This preload replaces exactly those namespaces in the extension worker's
 * own world with calls into the app's tab model (src/main/cos-browser). Messaging, scripting,
 * storage, alarms and runtime stay Electron's.
 *
 * The session registers this preload for every service worker, including chatgpt.com's own, so
 * it acts only inside a `chrome-extension:` worker; the app also checks the caller's scope.
 */
import { contextBridge, ipcRenderer } from 'electron';

type Reply = { ok: true; value: unknown } | { ok: false; message: string };

/**
 * The app registers its handler as the worker starts; a call made by the extension's very first
 * lines can still arrive before that, so only that refusal is retried, briefly.
 */
async function invoke(name: string, args: unknown[]): Promise<Reply> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ipcRenderer.invoke('cos-browser:api', name, args) as Reply;
    } catch (error) {
      if (attempt >= 40 || !/No handler registered/i.test(error instanceof Error ? error.message : String(error))) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

// The preload's own context has no `location`; the worker's world answers for itself.
const workerProtocol: unknown = contextBridge.executeInMainWorld({ func: () => globalThis.location?.protocol });
if (workerProtocol === 'chrome-extension:') {
  const subscribers = new Set<(name: string, args: unknown[]) => void>();
  ipcRenderer.on('cos-browser:event', (_event, name: string, args: unknown[]) => {
    for (const subscriber of subscribers) subscriber(name, args);
  });
  contextBridge.exposeInMainWorld('__cosBrowserWorker', {
    call: async (name: string, args: unknown[]): Promise<unknown> => {
      const reply = await invoke(name, args);
      // Chrome's exact messages, such as "No tab with id: 7.", reach the extension unchanged.
      if (!reply.ok) throw new Error(reply.message);
      return reply.value;
    },
    subscribe: (subscriber: (name: string, args: unknown[]) => void): void => { subscribers.add(subscriber); }
  });
  contextBridge.executeInMainWorld({ func: installChromeShim, args: [process.env.COS_BROWSER_TRACE === '1'] });
}

/** Runs in the worker's own world; it is serialized, so it must not reference this module. */
function installChromeShim(trace: boolean): void {
  const bridge = (globalThis as unknown as {
    __cosBrowserWorker: { call(name: string, args: unknown[]): Promise<unknown>; subscribe(fn: (name: string, args: unknown[]) => void): void };
  }).__cosBrowserWorker;
  const chrome = (globalThis as unknown as { chrome: Record<string, Record<string, unknown>> }).chrome;
  if (!chrome?.runtime || !chrome.tabs) return;
  const tabs = chrome.tabs;

  const events = new Map<string, Set<(...args: unknown[]) => void>>();
  const event = (name: string) => {
    const listeners = new Set<(...args: unknown[]) => void>();
    events.set(name, listeners);
    return {
      addListener: (listener: (...args: unknown[]) => void) => { listeners.add(listener); },
      removeListener: (listener: (...args: unknown[]) => void) => { listeners.delete(listener); },
      hasListener: (listener: (...args: unknown[]) => void) => listeners.has(listener),
      hasListeners: () => listeners.size > 0
    };
  };
  bridge.subscribe((name, args) => {
    for (const listener of [...(events.get(name) ?? [])]) {
      try { listener(...args); } catch (error) { console.error(error); }
    }
  });

  // Promise style, plus Chrome's callback style with runtime.lastError for older call sites.
  const method = (name: string) => (...args: unknown[]) => {
    const callback = typeof args.at(-1) === 'function' ? args.pop() as (value?: unknown) => void : null;
    const result = bridge.call(name, args);
    if (!callback) return result;
    result.then(value => callback(value), (error: Error) => {
      const runtime = chrome.runtime as Record<string, unknown>;
      runtime.lastError = { message: error.message };
      try { callback(); } finally { delete runtime.lastError; }
    });
    return undefined;
  };

  // Changed in place: messaging (`sendMessage`, `connect`) and anything else native stays.
  Object.assign(tabs, {
    TAB_ID_NONE: -1,
    query: method('tabs.query'),
    get: method('tabs.get'),
    getCurrent: () => Promise.resolve(undefined),
    create: method('tabs.create'),
    update: method('tabs.update'),
    reload: method('tabs.reload'),
    move: method('tabs.move'),
    remove: method('tabs.remove'),
    onCreated: event('tabs.onCreated'),
    onUpdated: event('tabs.onUpdated'),
    onActivated: event('tabs.onActivated'),
    onMoved: event('tabs.onMoved'),
    onDetached: event('tabs.onDetached'),
    onAttached: event('tabs.onAttached'),
    onRemoved: event('tabs.onRemoved'),
    onHighlighted: event('tabs.onHighlighted'),
    onReplaced: event('tabs.onReplaced'),
    onZoomChange: event('tabs.onZoomChange')
  });
  chrome.windows = {
    WINDOW_ID_NONE: -1,
    WINDOW_ID_CURRENT: -2,
    get: method('windows.get'),
    getAll: method('windows.getAll'),
    getCurrent: method('windows.getLastFocused'),
    getLastFocused: method('windows.getLastFocused'),
    create: method('windows.create'),
    update: method('windows.update'),
    remove: method('windows.remove'),
    onCreated: event('windows.onCreated'),
    onRemoved: event('windows.onRemoved'),
    onFocusChanged: event('windows.onFocusChanged'),
    onBoundsChanged: event('windows.onBoundsChanged')
  };
  // COS_BROWSER_TRACE=1: time Electron's own async calls too, so a call that never settles shows.
  if (trace) {
    let next = 0;
    const timed = (owner: Record<string, unknown>, name: string, label: string) => {
      const original = owner[name] as ((...args: unknown[]) => unknown) | undefined;
      if (typeof original !== 'function') return;
      owner[name] = function (this: unknown, ...args: unknown[]) {
        const id = ++next;
        const started = Date.now();
        const target = args[0] && typeof args[0] === 'object' ? JSON.stringify(args[0]).slice(0, 120) : String(args[0]);
        const result = original.apply(this, args);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          const late = setTimeout(() => console.warn(`CoS trace: ${label} #${id} ${target} still pending after 10 s`), 10_000);
          (result as Promise<unknown>).then(
            () => { clearTimeout(late); console.info(`CoS trace: ${label} #${id} ${target} done in ${Date.now() - started} ms`); },
            (error: Error) => { clearTimeout(late); console.info(`CoS trace: ${label} #${id} ${target} failed in ${Date.now() - started} ms: ${error?.message}`); });
        }
        return result;
      };
    };
    timed(tabs, 'sendMessage', 'tabs.sendMessage');
    timed(chrome.scripting as Record<string, unknown>, 'executeScript', 'scripting.executeScript');
    timed(chrome.scripting as Record<string, unknown>, 'insertCSS', 'scripting.insertCSS');
  }
  // Chrome fires onStartup when the browser starts; Electron never does, so the app does.
  Object.defineProperty(chrome.runtime, 'onStartup', { value: event('runtime.onStartup'), configurable: true, writable: true });
  chrome.debugger = {
    attach: method('debugger.attach'),
    detach: method('debugger.detach'),
    sendCommand: method('debugger.sendCommand'),
    getTargets: method('debugger.getTargets'),
    onEvent: event('debugger.onEvent'),
    onDetach: event('debugger.onDetach')
  };
  // Granted means declared: the CoS browser installs the extension with its manifest permissions.
  const manifest = (chrome.runtime.getManifest as () => { permissions?: string[]; host_permissions?: string[] })();
  chrome.permissions ??= {};
  Object.assign(chrome.permissions, {
    contains: (request: { permissions?: string[]; origins?: string[] } = {}, callback?: (granted: boolean) => void) => {
      const granted = (request.permissions ?? []).every(permission => manifest.permissions?.includes(permission)) &&
        (request.origins ?? []).every(origin => manifest.host_permissions?.includes(origin));
      if (callback) { callback(granted); return undefined; }
      return Promise.resolve(granted);
    }
  });
}
