/**
 * Chrome-shaped tab and window state for the CoS browser.
 *
 * The companion extension runs unchanged inside Electron, and it orchestrates chats through the
 * documented `chrome.tabs` / `chrome.windows` contract: `pendingUrl` while a navigation is in
 * flight, `status` moving from loading to complete, `onUpdated` reporting a URL only once
 * `tab.url` already holds it, `onRemoved` for every closed tab. Electron's own tabs API omits
 * most of that (every tab reports window 0, no `status`, no `pendingUrl`, no events). This model
 * is therefore the single owner of that state: the host feeds it native page events, and the
 * extension's API calls read and change it. Nothing here touches Electron, so every rule is
 * testable on its own.
 */
import { matchesPatterns } from './match-pattern.js';

export type TabStatus = 'loading' | 'complete';
export type WindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen';

export interface ChromeTab {
  id: number;
  index: number;
  windowId: number;
  openerTabId?: number;
  active: boolean;
  highlighted: boolean;
  pinned: boolean;
  audible: boolean;
  discarded: boolean;
  frozen: boolean;
  autoDiscardable: boolean;
  incognito: boolean;
  groupId: number;
  mutedInfo: { muted: boolean };
  url: string;
  pendingUrl?: string;
  title: string;
  status: TabStatus;
  lastAccessed: number;
}

export interface ChromeWindow {
  id: number;
  focused: boolean;
  state: WindowState;
  type: 'normal' | 'popup';
  incognito: boolean;
  alwaysOnTop: boolean;
  tabs?: ChromeTab[];
}

export type TabChange = Partial<Pick<ChromeTab, 'status' | 'url' | 'title' | 'autoDiscardable'>>;

export type ModelEvent =
  | { name: 'tabs.onCreated'; args: [ChromeTab] }
  | { name: 'tabs.onUpdated'; args: [number, TabChange, ChromeTab] }
  | { name: 'tabs.onActivated'; args: [{ tabId: number; windowId: number }] }
  | { name: 'tabs.onMoved'; args: [number, { windowId: number; fromIndex: number; toIndex: number }] }
  | { name: 'tabs.onDetached'; args: [number, { oldWindowId: number; oldPosition: number }] }
  | { name: 'tabs.onAttached'; args: [number, { newWindowId: number; newPosition: number }] }
  | { name: 'tabs.onRemoved'; args: [number, { windowId: number; isWindowClosing: boolean }] }
  | { name: 'windows.onCreated'; args: [ChromeWindow] }
  | { name: 'windows.onRemoved'; args: [number] }
  | { name: 'windows.onFocusChanged'; args: [number] };

/** `chrome.windows.WINDOW_ID_NONE`: reported focus when no CoS browser window has it. */
export const WINDOW_ID_NONE = -1;

export interface TabQuery {
  active?: boolean;
  highlighted?: boolean;
  pinned?: boolean;
  discarded?: boolean;
  autoDiscardable?: boolean;
  status?: TabStatus;
  url?: string | string[];
  title?: string;
  windowId?: number;
  index?: number;
  lastFocusedWindow?: boolean;
  currentWindow?: boolean;
}

interface WindowRecord {
  id: number;
  type: 'normal' | 'popup';
  state: WindowState;
  tabs: number[];
}

interface TabRecord {
  id: number;
  windowId: number;
  openerTabId?: number;
  active: boolean;
  autoDiscardable: boolean;
  url: string;
  pendingUrl?: string;
  title: string;
  status: TabStatus;
  lastAccessed: number;
}

/** Glob in `chrome.tabs.query({ title })`: `*` matches any run of characters, case-insensitively. */
function titleMatches(title: string, pattern: string): boolean {
  const glob = pattern.split('*').map(text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${glob}$`, 'i').test(title);
}

export class TabModel {
  private readonly windows = new Map<number, WindowRecord>();
  private readonly tabs = new Map<number, TabRecord>();
  private nextWindowId = 1;
  private focusedWindowId = WINDOW_ID_NONE;
  private lastFocusedWindowId = WINDOW_ID_NONE;

  constructor(
    private readonly emit: (event: ModelEvent) => void,
    private readonly now: () => number = Date.now
  ) {}

  // ---- reading -------------------------------------------------------------------------------

  tab(id: number): ChromeTab | null {
    const record = this.tabs.get(id);
    if (!record) return null;
    const window = this.windows.get(record.windowId)!;
    return {
      id: record.id,
      index: window.tabs.indexOf(record.id),
      windowId: record.windowId,
      ...(record.openerTabId === undefined ? {} : { openerTabId: record.openerTabId }),
      active: record.active,
      highlighted: record.active,
      pinned: false,
      audible: false,
      // The CoS browser never discards or freezes a page, so the extension's discard protection
      // stays correct and simply never has anything to recover.
      discarded: false,
      frozen: false,
      autoDiscardable: record.autoDiscardable,
      incognito: false,
      groupId: -1,
      mutedInfo: { muted: false },
      url: record.url,
      ...(record.pendingUrl === undefined ? {} : { pendingUrl: record.pendingUrl }),
      title: record.title,
      status: record.status,
      lastAccessed: record.lastAccessed
    };
  }

  window(id: number, populate = false): ChromeWindow | null {
    const record = this.windows.get(id);
    if (!record) return null;
    return {
      id: record.id,
      focused: this.focusedWindowId === record.id,
      state: record.state,
      type: record.type,
      incognito: false,
      alwaysOnTop: false,
      ...(populate ? { tabs: record.tabs.map(tab => this.tab(tab)!) } : {})
    };
  }

  allWindows(populate = false): ChromeWindow[] {
    return [...this.windows.keys()].map(id => this.window(id, populate)!);
  }

  hasTab(id: number): boolean {
    return this.tabs.has(id);
  }

  tabsOf(windowId: number): number[] {
    return [...(this.windows.get(windowId)?.tabs ?? [])];
  }

  activeTab(windowId: number): number | null {
    return this.windows.get(windowId)?.tabs.find(id => this.tabs.get(id)!.active) ?? null;
  }

  lastFocusedWindow(): number {
    return this.lastFocusedWindowId;
  }

  /** `chrome.tabs.query`; `currentWindow` means the last focused window, as for a service worker. */
  query(query: TabQuery): ChromeTab[] {
    const focused = query.lastFocusedWindow !== undefined || query.currentWindow !== undefined
      ? this.lastFocusedWindowId
      : null;
    const result: ChromeTab[] = [];
    for (const window of this.windows.values()) {
      if (query.windowId !== undefined && window.id !== query.windowId) continue;
      if (focused !== null) {
        const wanted = query.lastFocusedWindow ?? query.currentWindow;
        if ((window.id === focused) !== wanted) continue;
      }
      for (const id of window.tabs) {
        const tab = this.tab(id)!;
        if (query.active !== undefined && tab.active !== query.active) continue;
        if (query.highlighted !== undefined && tab.highlighted !== query.highlighted) continue;
        if (query.pinned !== undefined && tab.pinned !== query.pinned) continue;
        if (query.discarded !== undefined && tab.discarded !== query.discarded) continue;
        if (query.autoDiscardable !== undefined && tab.autoDiscardable !== query.autoDiscardable) continue;
        if (query.status !== undefined && tab.status !== query.status) continue;
        if (query.index !== undefined && tab.index !== query.index) continue;
        if (query.title !== undefined && !titleMatches(tab.title, query.title)) continue;
        if (query.url !== undefined && !matchesPatterns(tab.url, query.url)) continue;
        result.push(tab);
      }
    }
    return result;
  }

  // ---- windows -------------------------------------------------------------------------------

  createWindow(options: { type?: 'normal' | 'popup'; state?: WindowState } = {}): number {
    const id = this.nextWindowId++;
    this.windows.set(id, { id, type: options.type ?? 'normal', state: options.state ?? 'normal', tabs: [] });
    this.emit({ name: 'windows.onCreated', args: [this.window(id)!] });
    return id;
  }

  setWindowState(id: number, state: WindowState): void {
    const window = this.windows.get(id);
    if (window) window.state = state;
  }

  /** Native focus moved. `WINDOW_ID_NONE` when focus left every CoS browser window. */
  focusWindow(id: number): void {
    const next = id === WINDOW_ID_NONE || this.windows.has(id) ? id : WINDOW_ID_NONE;
    if (next === this.focusedWindowId) return;
    this.focusedWindowId = next;
    if (next !== WINDOW_ID_NONE) {
      this.lastFocusedWindowId = next;
      const active = this.activeTab(next);
      if (active !== null) this.tabs.get(active)!.lastAccessed = this.now();
    }
    this.emit({ name: 'windows.onFocusChanged', args: [next] });
  }

  /** Closing a window closes its tabs first, each reported with `isWindowClosing`. */
  removeWindow(id: number): void {
    const window = this.windows.get(id);
    if (!window) return;
    for (const tab of [...window.tabs].reverse()) this.detach(tab, true);
    this.dropWindow(id);
  }

  private dropWindow(id: number): void {
    if (!this.windows.delete(id)) return;
    if (this.focusedWindowId === id) this.focusedWindowId = WINDOW_ID_NONE;
    if (this.lastFocusedWindowId === id) {
      this.lastFocusedWindowId = [...this.windows.keys()].at(-1) ?? WINDOW_ID_NONE;
    }
    this.emit({ name: 'windows.onRemoved', args: [id] });
  }

  // ---- tabs ----------------------------------------------------------------------------------

  /**
   * A new tab whose first navigation has not committed yet: like Chrome's `tabs.create` result,
   * it reports `pendingUrl` and an empty `url` until the page commits.
   */
  addTab(id: number, windowId: number, options: { url: string; active: boolean; index?: number; openerTabId?: number }): ChromeTab {
    const window = this.windows.get(windowId);
    if (!window) throw new Error(`No window with id: ${windowId}.`);
    if (this.tabs.has(id)) throw new Error(`Tab ${id} already exists.`);
    this.tabs.set(id, {
      id, windowId, active: false, autoDiscardable: true, url: '', pendingUrl: options.url, title: '',
      status: 'loading', lastAccessed: this.now(),
      ...(options.openerTabId === undefined ? {} : { openerTabId: options.openerTabId })
    });
    window.tabs.splice(this.insertionIndex(window, options.index), 0, id);
    this.emit({ name: 'tabs.onCreated', args: [this.tab(id)!] });
    // The first tab of a window is its active tab, whatever was asked.
    if (options.active || this.activeTab(windowId) === null) this.activate(id);
    return this.tab(id)!;
  }

  activate(id: number): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.active) return;
    for (const other of this.windows.get(tab.windowId)!.tabs) this.tabs.get(other)!.active = false;
    tab.active = true;
    tab.lastAccessed = this.now();
    this.emit({ name: 'tabs.onActivated', args: [{ tabId: id, windowId: tab.windowId }] });
  }

  /** `chrome.tabs.move`; `index` -1 means the end. Returns the moved tab. */
  move(id: number, windowId: number, index: number): ChromeTab {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`No tab with id: ${id}.`);
    const target = this.windows.get(windowId);
    if (!target) throw new Error(`No window with id: ${windowId}.`);
    const source = this.windows.get(tab.windowId)!;
    const fromIndex = source.tabs.indexOf(id);
    if (source === target) {
      source.tabs.splice(fromIndex, 1);
      const toIndex = this.insertionIndex(source, index);
      source.tabs.splice(toIndex, 0, id);
      if (toIndex !== fromIndex) this.emit({ name: 'tabs.onMoved', args: [id, { windowId, fromIndex, toIndex }] });
      return this.tab(id)!;
    }
    const wasActive = tab.active;
    source.tabs.splice(fromIndex, 1);
    tab.active = false;
    this.emit({ name: 'tabs.onDetached', args: [id, { oldWindowId: source.id, oldPosition: fromIndex }] });
    if (wasActive) this.activateNeighbour(source, fromIndex);
    tab.windowId = windowId;
    const toIndex = this.insertionIndex(target, index);
    target.tabs.splice(toIndex, 0, id);
    this.emit({ name: 'tabs.onAttached', args: [id, { newWindowId: windowId, newPosition: toIndex }] });
    if (this.activeTab(windowId) === null) this.activate(id);
    // Chrome closes a window whose last tab moved away.
    if (source.tabs.length === 0) this.dropWindow(source.id);
    return this.tab(id)!;
  }

  /** The tab is gone (closed by the user, the extension or its page). Its empty window closes. */
  removeTab(id: number): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const windowId = tab.windowId;
    this.detach(id, false);
    if (this.windows.get(windowId)?.tabs.length === 0) this.dropWindow(windowId);
  }

  private detach(id: number, isWindowClosing: boolean): void {
    const tab = this.tabs.get(id)!;
    const window = this.windows.get(tab.windowId)!;
    const index = window.tabs.indexOf(id);
    window.tabs.splice(index, 1);
    this.tabs.delete(id);
    // `onRemoved` reports the removal before the next tab becomes active, as Chrome does.
    this.emit({ name: 'tabs.onRemoved', args: [id, { windowId: window.id, isWindowClosing }] });
    if (tab.active && !isWindowClosing) this.activateNeighbour(window, index);
  }

  /** Chrome activates the tab to the right of a closed active tab, else the one to its left. */
  private activateNeighbour(window: WindowRecord, index: number): void {
    const next = window.tabs[index] ?? window.tabs[index - 1];
    if (next !== undefined) this.activate(next);
  }

  private insertionIndex(window: WindowRecord, index: number | undefined): number {
    return index === undefined || index < 0 || index > window.tabs.length ? window.tabs.length : index;
  }

  setAutoDiscardable(id: number, value: boolean): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.autoDiscardable === value) return;
    tab.autoDiscardable = value;
    this.update(tab, { autoDiscardable: value });
  }

  // ---- navigation ----------------------------------------------------------------------------

  /** A main-frame document navigation started: `pendingUrl` until it commits. */
  navigationStarted(id: number, url: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.pendingUrl = url;
    if (tab.status !== 'loading') {
      tab.status = 'loading';
      this.update(tab, { status: 'loading' });
    }
  }

  /**
   * A new document committed. `tab.url` already holds the URL when `onUpdated` reports it, and
   * no `pendingUrl` remains, so the extension can tell this from routing inside one document only
   * by its own document identity, exactly as it does in Chrome.
   */
  navigationCommitted(id: number, url: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    delete tab.pendingUrl;
    const changed = tab.url !== url;
    tab.url = url;
    const change: TabChange = {};
    if (tab.status !== 'loading') { tab.status = 'loading'; change.status = 'loading'; }
    if (changed) change.url = url;
    if (Object.keys(change).length) this.update(tab, change);
  }

  /** Routing inside the committed document (history.pushState, fragments). */
  sameDocumentNavigated(id: number, url: string): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.url === url) return;
    tab.url = url;
    this.update(tab, { url });
  }

  titleChanged(id: number, title: string): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.title === title) return;
    tab.title = title;
    this.update(tab, { title });
  }

  /** Loading ended, by success, failure or abort. An uncommitted navigation leaves no pendingUrl. */
  loadingStopped(id: number): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    delete tab.pendingUrl;
    if (tab.status === 'complete') return;
    tab.status = 'complete';
    this.update(tab, { status: 'complete' });
  }

  private update(tab: TabRecord, change: TabChange): void {
    this.emit({ name: 'tabs.onUpdated', args: [tab.id, change, this.tab(tab.id)!] });
  }
}
