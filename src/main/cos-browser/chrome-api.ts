/**
 * The extension's `chrome.tabs`, `chrome.windows` and `chrome.debugger` calls, answered with
 * Chrome's documented semantics and Chrome's exact error messages (the companion matches some of
 * them, such as "No tab with id"). The model owns the state; `BrowserControl` performs the
 * native side effects that change it.
 */
import type { ChromeTab, TabModel, TabQuery, WindowState } from './tab-model.js';

export interface DebuggerTarget {
  type: 'page';
  id: string;
  tabId: number;
  title: string;
  url: string;
  attached: boolean;
}

export interface BrowserControl {
  readonly model: TabModel;
  /** A window, with a first tab when `url` is given; hidden unless `focused` or a visible state. */
  createWindow(options: { url?: string; focused: boolean; state: WindowState; type: 'normal' | 'popup' }): number;
  createTab(windowId: number, url: string, options: { active: boolean; index?: number; openerTabId?: number }): number;
  navigate(tabId: number, url: string): void;
  reload(tabId: number, bypassCache: boolean): void;
  activate(tabId: number): void;
  closeTab(tabId: number): void;
  moveTab(tabId: number, windowId: number, index: number): void;
  closeWindow(windowId: number): void;
  presentWindow(windowId: number, change: { state?: WindowState; focused?: boolean }): void;
  debuggerAttach(tabId: number, version: string): Promise<void>;
  debuggerDetach(tabId: number): Promise<void>;
  debuggerSend(tabId: number, method: string, params: object | undefined, sessionId: string | undefined): Promise<unknown>;
  debuggerTargets(): DebuggerTarget[];
}

const WINDOW_ID_CURRENT = -2;
const NEW_TAB_URL = 'about:blank';
const WINDOW_STATES = new Set<WindowState>(['normal', 'minimized', 'maximized', 'fullscreen']);

type Args = unknown[];
type Handler = (browser: BrowserControl, args: Args) => unknown;

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`Error in invocation: ${name} must be an object.`);
  return value as Record<string, unknown>;
}

function integer(value: unknown, name: string): number {
  if (!Number.isInteger(value)) throw new Error(`Error in invocation: ${name} must be an integer.`);
  return value as number;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`Error in invocation: ${name} must be a boolean.`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Error in invocation: ${name} must be a string.`);
  return value;
}

function tabOf(browser: BrowserControl, id: unknown): ChromeTab {
  const tabId = integer(id, 'tabId');
  const tab = browser.model.tab(tabId);
  if (!tab) throw new Error(`No tab with id: ${tabId}.`);
  return tab;
}

function windowIdOf(browser: BrowserControl, id: unknown): number {
  const windowId = integer(id, 'windowId');
  const resolved = windowId === WINDOW_ID_CURRENT ? browser.model.lastFocusedWindow() : windowId;
  if (!browser.model.window(resolved)) throw new Error(`No window with id: ${windowId}.`);
  return resolved;
}

/** Tab APIs without an id act on the active tab of the last focused window. */
function defaultTab(browser: BrowserControl): ChromeTab {
  const windowId = browser.model.lastFocusedWindow();
  const active = browser.model.activeTab(windowId);
  if (active === null) throw new Error('No current tab.');
  return browser.model.tab(active)!;
}

/** `(tabId?, properties?)` as Chrome reads it: a leading id is optional, `undefined` included. */
function tabAndProperties(browser: BrowserControl, [first, second]: Args, name: string): [ChromeTab, Record<string, unknown>] {
  if (first === undefined || first === null) return [defaultTab(browser), record(second, name)];
  if (typeof first === 'object') return [defaultTab(browser), record(first, name)];
  return [tabOf(browser, first), record(second, name)];
}

function populate(options: unknown): boolean {
  return record(options, 'queryOptions').populate === true;
}

/** A window for a new tab: the last focused one, else a new hidden window owned by the request. */
function targetWindow(browser: BrowserControl, windowId: unknown): number | null {
  if (windowId !== undefined) return windowIdOf(browser, windowId);
  const focused = browser.model.lastFocusedWindow();
  return browser.model.window(focused) ? focused : null;
}

function state(value: unknown): WindowState | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !WINDOW_STATES.has(value as WindowState)) throw new Error(`Invalid value for state: ${String(value)}`);
  return value as WindowState;
}

const handlers: Record<string, Handler> = {
  'tabs.query': (browser, [query]) => browser.model.query(record(query, 'queryInfo') as TabQuery),

  'tabs.get': (browser, [id]) => tabOf(browser, id),

  'tabs.create': (browser, [properties]) => {
    const props = record(properties, 'createProperties');
    const url = optionalString(props.url, 'url') ?? NEW_TAB_URL;
    const active = optionalBoolean(props.active, 'active') ?? optionalBoolean(props.selected, 'selected') ?? true;
    const index = props.index === undefined ? undefined : integer(props.index, 'index');
    const openerTabId = props.openerTabId === undefined ? undefined : tabOf(browser, props.openerTabId).id;
    const windowId = targetWindow(browser, props.windowId);
    if (windowId === null) {
      // Chrome opens a window for a tab when none exists. Unfocused unless the tab is active.
      const created = browser.createWindow({ url, focused: active, state: 'normal', type: 'normal' });
      return browser.model.tab(browser.model.tabsOf(created)[0]!)!;
    }
    const id = browser.createTab(windowId, url, { active, ...(index === undefined ? {} : { index }), ...(openerTabId === undefined ? {} : { openerTabId }) });
    return browser.model.tab(id)!;
  },

  'tabs.update': (browser, args) => {
    const [tab, props] = tabAndProperties(browser, args, 'updateProperties');
    const url = optionalString(props.url, 'url');
    const active = optionalBoolean(props.active, 'active') ?? optionalBoolean(props.highlighted, 'highlighted');
    const autoDiscardable = optionalBoolean(props.autoDiscardable, 'autoDiscardable');
    optionalBoolean(props.pinned, 'pinned');
    optionalBoolean(props.muted, 'muted');
    if (autoDiscardable !== undefined) browser.model.setAutoDiscardable(tab.id, autoDiscardable);
    if (url !== undefined) browser.navigate(tab.id, url);
    if (active === true) browser.activate(tab.id);
    return browser.model.tab(tab.id);
  },

  'tabs.reload': (browser, args) => {
    const [tab, props] = tabAndProperties(browser, args, 'reloadProperties');
    browser.reload(tab.id, optionalBoolean(props.bypassCache, 'bypassCache') === true);
  },

  'tabs.move': (browser, [ids, properties]) => {
    const props = record(properties, 'moveProperties');
    const index = integer(props.index, 'index');
    const list = Array.isArray(ids) ? ids : [ids];
    const tabs = list.map(id => tabOf(browser, id));
    const moved = tabs.map((tab, offset) => {
      const windowId = props.windowId === undefined ? tab.windowId : windowIdOf(browser, props.windowId);
      browser.moveTab(tab.id, windowId, index === -1 ? -1 : index + offset);
      return browser.model.tab(tab.id)!;
    });
    return Array.isArray(ids) ? moved : moved[0];
  },

  'tabs.remove': (browser, [ids]) => {
    const list = Array.isArray(ids) ? ids : [ids];
    // Chrome validates every id before closing any.
    for (const id of list) tabOf(browser, id);
    for (const id of list) browser.closeTab(id as number);
  },

  'windows.get': (browser, [id, options]) => browser.model.window(windowIdOf(browser, id), populate(options)),

  'windows.getAll': (browser, [options]) => browser.model.allWindows(populate(options)),

  'windows.getLastFocused': (browser, [options]) => {
    const window = browser.model.window(browser.model.lastFocusedWindow(), populate(options));
    if (!window) throw new Error('No last-focused window');
    return window;
  },

  'windows.create': (browser, [data]) => {
    const props = record(data, 'createData');
    const urls = props.url === undefined ? [] : Array.isArray(props.url) ? props.url : [props.url];
    for (const url of urls) optionalString(url, 'url');
    const wanted = state(props.state);
    const focused = optionalBoolean(props.focused, 'focused');
    if (wanted === 'minimized' && focused === true) throw new Error('Invalid value for state');
    const type = props.type === 'popup' ? 'popup' : 'normal';
    const moving = props.tabId === undefined ? null : tabOf(browser, props.tabId);
    const id = browser.createWindow({
      ...(moving || urls.length === 0 ? {} : { url: urls[0] as string }),
      focused: focused ?? wanted !== 'minimized',
      state: wanted ?? 'normal',
      type
    });
    if (moving) browser.moveTab(moving.id, id, -1);
    else if (urls.length === 0) browser.createTab(id, NEW_TAB_URL, { active: true });
    for (const url of urls.slice(1)) browser.createTab(id, url as string, { active: false });
    return browser.model.window(id, true);
  },

  'windows.update': (browser, [id, info]) => {
    const windowId = windowIdOf(browser, id);
    const props = record(info, 'updateInfo');
    const wanted = state(props.state);
    const focused = optionalBoolean(props.focused, 'focused');
    if (wanted === 'minimized' && focused === true) throw new Error('Invalid value for state');
    browser.presentWindow(windowId, { ...(wanted ? { state: wanted } : {}), ...(focused === undefined ? {} : { focused }) });
    return browser.model.window(windowId);
  },

  'windows.remove': (browser, [id]) => { browser.closeWindow(windowIdOf(browser, id)); },

  'debugger.attach': async (browser, [target, version]) => {
    const tabId = debuggerTab(browser, target);
    await browser.debuggerAttach(tabId, optionalString(version, 'requiredVersion') ?? '1.3');
  },

  'debugger.detach': async (browser, [target]) => { await browser.debuggerDetach(debuggerTab(browser, target)); },

  'debugger.sendCommand': (browser, [target, method, params]) => {
    const source = record(target, 'target');
    return browser.debuggerSend(debuggerTab(browser, target), optionalString(method, 'method') ?? '',
      params === undefined ? undefined : record(params, 'commandParams'), optionalString(source.sessionId, 'sessionId'));
  },

  'debugger.getTargets': browser => browser.debuggerTargets()
};

function debuggerTab(browser: BrowserControl, target: unknown): number {
  const source = record(target, 'target');
  if (source.tabId === undefined) throw new Error('Either tab id or extension id must be specified.');
  const tabId = integer(source.tabId, 'tabId');
  if (!browser.model.hasTab(tabId)) throw new Error(`No tab with given id ${tabId}.`);
  return tabId;
}

export type ChromeApiReply = { ok: true; value: unknown } | { ok: false; message: string };

/** One worker call. Unknown names are refused rather than silently answered. */
export async function callChromeApi(browser: BrowserControl, name: string, args: unknown): Promise<ChromeApiReply> {
  const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
  if (!handler) return { ok: false, message: `${name} is not available in the CoS browser.` };
  try {
    return { ok: true, value: await handler(browser, Array.isArray(args) ? args : []) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
