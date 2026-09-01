/**
 * Regression tests for the unpacked Chrome companion itself.
 *
 * These execute the shipped JavaScript rather than a TypeScript reimplementation. The
 * DOM adapter runs against tiny structural fakes for the ChatGPT shapes we have seen in
 * the browser, and the service worker runs in a VM with fake Chrome storage so its
 * restart/durability rules are exercised without needing a Chrome process in CI.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const { APP_VERSION, BRIDGE_PROTOCOL } = await import('../src/main/version.js');

let domSource = '';
let backgroundSource = '';

beforeAll(async () => {
  [domSource, backgroundSource] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'extension', 'chatgpt-dom.js'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'extension', 'background.js'), 'utf8')
  ]);
});

describe('extension release metadata', () => {
  it('keeps the app package, bundled extension and bridge protocol on the same release', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
    const lock = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package-lock.json'), 'utf8')) as {
      version: string;
      packages?: Record<string, { version?: string }>;
    };
    const manifest = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'extension', 'manifest.json'), 'utf8')
    ) as { version: string };
    expect(pkg.version).toBe(APP_VERSION);
    expect(lock.version).toBe(APP_VERSION);
    expect(lock.packages?.['']?.version).toBe(APP_VERSION);
    expect(manifest.version).toBe(APP_VERSION);
    expect(BRIDGE_PROTOCOL).toBe(9);
    expect(backgroundSource).toContain('const BRIDGE_PROTOCOL = 9;');
  });

  /**
   * The Fiber helper is the one piece of this extension that runs in ChatGPT's own
   * JavaScript context, and it only does so because the manifest says `"world": "MAIN"`.
   * Lose that one word and the file still loads, still finds nothing — `__reactFiber$` is
   * invisible from an isolated world — and fails closed, so every collapsed row silently
   * goes back to standing for one call. That is a regression with no symptom, which is
   * why it is pinned here.
   */
  it('runs the fiber helper in the page context, and nothing else there', async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'extension', 'manifest.json'), 'utf8')
    ) as { content_scripts: Array<{ js: string[]; world?: string }> };

    const main = manifest.content_scripts.filter((entry) => entry.world === 'MAIN');
    expect(main).toHaveLength(1);
    expect(main[0]!.js).toEqual(['fiber.js']);
    // The rest stays isolated: the page must not be able to reach the code that talks to
    // the service worker, holds the bridge token, or decides what gets recorded.
    for (const entry of manifest.content_scripts) {
      if (entry.world === 'MAIN') continue;
      expect(entry.js).not.toContain('fiber.js');
      expect(entry.world ?? 'ISOLATED').toBe('ISOLATED');
    }
  });

  /**
   * The helper's whole justification is that it reads props the page owns. What it may
   * hand back is an allowlist, and these are the two things that must never be in it: a
   * tool's arguments, which are the user's text, and the secrets observed inside them.
   */
  it('never sends tool arguments or secrets out of the page context', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'extension', 'fiber.js'), 'utf8');
    // Comments discuss the secrets by name; the code must never touch them.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/agent_key|authorization|access_token/i);
    // The payload is never turned into an object at all. It used to be parsed for its
    // `path`, which meant the arguments — the user's text, and the secrets observed inside
    // them — existed as live values in this scope, one careless line from crossing over.
    // The path is read off the front of the string instead, so `args` is never walked.
    expect(code).not.toMatch(/JSON\.parse/);
    expect(code).not.toMatch(/\bargs\b/);
    // Nor may a whole object be serialised across, which would defeat the allowlist.
    expect(code).not.toMatch(/JSON\.stringify/);
  });

  /**
   * The installed popup showed "Paired · port 8765" with a green dot and, underneath it,
   * a six-digit code field and a Pair button — a page contradicting itself about the one
   * thing it exists to report. There is nothing to type any more, so the way to keep that
   * from coming back is for the markup to have no field to type into.
   */
  it('has no pairing-code UI anywhere in the popup', async () => {
    const dir = path.join(process.cwd(), 'extension');
    const [html, js] = await Promise.all([
      fs.readFile(path.join(dir, 'popup.html'), 'utf8'),
      fs.readFile(path.join(dir, 'popup.js'), 'utf8')
    ]);
    expect(html).not.toMatch(/<form/i);
    expect(html).not.toMatch(/000000|six[- ]digit|pairing code/i);
    expect(html).not.toMatch(/type=["'](?:text|number|password)["']/i);
    expect(js).not.toMatch(/\bcode\b/);
    // The message the worker understands carries no code either.
    expect(js).not.toMatch(/type: 'pair'[^}]*code/);
  });

  it('ships Overwrite on by default and exposes one persistent toggle that refreshes immediately', async () => {
    const dir = path.join(process.cwd(), 'extension');
    const [content, html, js] = await Promise.all([
      fs.readFile(path.join(dir, 'content.js'), 'utf8'),
      fs.readFile(path.join(dir, 'popup.html'), 'utf8'),
      fs.readFile(path.join(dir, 'popup.js'), 'utf8')
    ]);
    expect(content).toContain("const RENDER_STREAM_KEY = 'renderStreamEnabled';");
    expect(content).toContain("const SHOW_TIMES_KEY = 'showStreamTimes';");
    expect(content).toContain('let RENDER_STREAM = TEST_MODE ? false : true;');
    expect(html).toContain('id="overwriteToggle"');
    expect(html).toContain('id="timeToggle"');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('id="overwriteBtn"');
    expect(js).toContain("const RENDER_STREAM_KEY = 'renderStreamEnabled';");
    expect(js).toContain("const SHOW_TIMES_KEY = 'showStreamTimes';");
    expect(js).toContain('chrome.storage.local.set');
    expect(js).toContain("type: 'overwriteNow'");
    expect(backgroundSource).toContain('async overwriteNow()');
    expect(backgroundSource).toContain("chrome.tabs.sendMessage(id, { type: 'clf-overwrite-now' })");
  });
});

// ---------------------------------------------------------------------- DOM

const TURN_SELECTOR = 'section[data-testid^="conversation-turn"]';
const TOOL_SELECTOR = 'span[class*="tool-message"]';

class FakeNode {
  textContent = '';
  innerText = '';
  className = '';
  tagName = 'DIV';
  children: FakeNode[] = [];
  private attrs = new Map<string, string>();
  private all = new Map<string, FakeNode[]>();
  private closestMatches = new Set<string>();

  constructor(attrs: Record<string, string> = {}, text = '') {
    for (const [key, value] of Object.entries(attrs)) this.attrs.set(key, value);
    this.textContent = text;
    this.innerText = text;
    this.className = attrs.class ?? '';
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  querySelectorAll(selector: string): FakeNode[] {
    return this.all.get(selector) ?? [];
  }

  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  with(selector: string, nodes: FakeNode[]): this {
    this.all.set(selector, nodes);
    return this;
  }

  under(selector: string): this {
    this.closestMatches.add(selector);
    return this;
  }

  closest(selector: string): FakeNode | null {
    return this.closestMatches.has(selector) ? this : null;
  }

  /** Flat fakes: a node only ever contains itself, which is all toolBlocks() asks. */
  contains(other: FakeNode): boolean {
    return other === this;
  }
}

/** A tool block as the live page renders it: a short header line and nothing else. */
function toolBlock(label = 'Called tool'): FakeNode {
  return new FakeNode({ class: 'pointer-events-none contents' }, label);
}

interface DomApi {
  conversationId(): string | null;
  conversationFromPath(pathname: unknown): string | null;
  turns(): Array<{ node: FakeNode; nodes: FakeNode[]; id: string | null; role: string | null }>;
  messages(): Array<{ id: string; role: string; text: string; turnId: string | null }>;
  progressLine(turn: unknown): string | null;
  interrupted(turn: unknown): boolean;
  markProgress(turn: unknown): number;
  hideProgress(turn: unknown, hidden: boolean): void;
  toolBlocks(turn: unknown): FakeNode[];
  errors(): string[];
}

function loadDom(sections: FakeNode[], pathname = '/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'): DomApi {
  const document = {
    querySelectorAll: (selector: string) => (selector === TURN_SELECTOR ? sections : []),
    querySelector: () => null
  };
  const context = vm.createContext({ document, location: { pathname } });
  vm.runInContext(domSource, context, { filename: 'chatgpt-dom.js' });
  return (context as unknown as { CLF_DOM: DomApi }).CLF_DOM;
}

function turn(role: 'user' | 'assistant', id: string): FakeNode {
  return new FakeNode({ 'data-testid': 'conversation-turn-1', 'data-turn': role, 'data-turn-id': id });
}

describe('ChatGPT DOM adapter', () => {
  const CONVERSATION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  /**
   * Project conversations are routed under the project, and everything downstream — app
   * session, ownership registry, caller attribution — is keyed on the id this returns.
   * A shared snapshot is deliberately not a conversation this document can own.
   */
  it('recognises a conversation at the site root and inside a Project, and only those', () => {
    const dom = loadDom([]);
    for (const accepted of [
      `/c/${CONVERSATION}`,
      `/c/${CONVERSATION}/`,
      `/g/g-p-68abcdef1234/c/${CONVERSATION}`,
      `/g/g-p-68abcdef1234/c/${CONVERSATION}/`,
      `/g/g-abcdef/c/${CONVERSATION}`
    ]) {
      expect(dom.conversationFromPath(accepted), accepted).toBe(CONVERSATION);
    }

    for (const rejected of [
      '/',
      '/c/short',
      `/share/c/${CONVERSATION}`,
      `/share/${CONVERSATION}`,
      `/gpts/c/${CONVERSATION}`,
      `/g/g-p-one/g/g-p-two/c/${CONVERSATION}`
    ]) {
      expect(dom.conversationFromPath(rejected), rejected).toBeNull();
    }

    expect(dom.conversationFromPath(null)).toBeNull();
    expect(dom.conversationFromPath(undefined)).toBeNull();
  });

  it('reads the live route through that same parser', () => {
    expect(loadDom([], `/g/g-p-68abcdef1234/c/${CONVERSATION}`).conversationId()).toBe(CONVERSATION);
    expect(loadDom([], `/share/c/${CONVERSATION}`).conversationId()).toBeNull();
    expect(loadDom([], '/').conversationId()).toBeNull();
  });

  it('groups split assistant sections that share one data-turn-id before counting tool blocks', () => {
    const user = turn('user', 'user-1');
    const a1 = turn('assistant', 'request-1').with(TOOL_SELECTOR, [toolBlock(), toolBlock()]);
    const a2 = turn('assistant', 'request-1').with(TOOL_SELECTOR, [toolBlock(), toolBlock(), toolBlock()]);
    const dom = loadDom([user, a1, a2]);

    const turns = dom.turns();
    expect(turns).toHaveLength(2);
    const assistant = turns[1]!;
    expect(assistant.id).toBe('request-1');
    expect(assistant.nodes).toEqual([a1, a2]);
    expect(dom.toolBlocks(assistant)).toHaveLength(5);
  });

  /**
   * `div.pointer-events-none.contents` is a layout shape ChatGPT also uses for containers
   * that hold a whole answer. Counting one of those as a tool block inflates the block
   * count of the turn, which is exactly what the relabelling has to match against.
   */
  it('refuses a display-contents container that holds prose rather than a tool label', () => {
    const prose = toolBlock('a very long assistant answer').with('.markdown', [new FakeNode({}, 'answer')]);
    const real = toolBlock();
    const assistant = turn('assistant', 'request-3').with(TOOL_SELECTOR, [prose, real]);
    const dom = loadDom([assistant]);

    expect(dom.toolBlocks(dom.turns()[0]!)).toEqual([real]);
  });

  it('does not mistake ChatGPT transport-failure markdown for a completed assistant answer', () => {
    const failure = new FakeNode({}, 'Message delivery timed out. Please try again. Retry');
    const assistant = turn('assistant', 'request-failed')
      .with('[data-message-id]', [])
      .with('.markdown', [failure])
      .with('[data-interrupted="true"]', []);
    const dom = loadDom([assistant]);

    expect(dom.messages()).toEqual([]);
    // An occurrence, not a bare string: the node is what tells one showing of this banner
    // apart from the next, and the turn is what scopes it.
    expect(dom.errors()).toMatchObject([
      { text: 'Message delivery timed out. Please try again. Retry', node: failure, turnId: 'request-failed' }
    ]);
  });

  it('records assistant prose from .markdown when ChatGPT supplies no assistant data-message-id', () => {
    const userMessage = new FakeNode(
      { 'data-message-id': 'user-message-1', 'data-message-author-role': 'user' },
      'do the thing'
    );
    const user = turn('user', 'user-1').with('[data-message-id]', [userMessage]);

    const liveProgress = new FakeNode({}, 'Reading files').under('[data-interrupted]');
    const finalA = new FakeNode({}, 'First paragraph');
    const finalB = new FakeNode({}, 'Second paragraph');
    const assistant = turn('assistant', 'request-2')
      .with('[data-message-id]', [])
      .with('.markdown', [liveProgress, finalA, finalB])
      .with('[data-interrupted="true"]', []);

    const messages = loadDom([user, assistant]).messages();
    // toMatchObject rather than toEqual: each message also carries the section it was read
    // from, which is what lets the content script tell a message left behind by a chat it
    // has navigated away from apart from one belonging to the chat it is on now.
    expect(messages).toMatchObject([
      { id: 'user-message-1', role: 'user', text: 'do the thing', turnId: 'user-1', interrupted: false, node: user },
      {
        id: 'assistant:request-2',
        role: 'assistant',
        text: 'Second paragraph',
        turnId: 'request-2',
        interrupted: false,
        node: assistant
      }
    ]);
    expect(messages).toHaveLength(2);
  });

  it('marks only the observed progress containers so the overlay can make them legible', () => {
    const firstBox = new FakeNode({ 'data-interrupted': 'true' }, 'Thinking');
    const secondBox = new FakeNode({ 'data-interrupted': 'true' }, 'Running tests');
    const a1 = turn('assistant', 'request-progress').with('[data-interrupted]', [firstBox]);
    const a2 = turn('assistant', 'request-progress').with('[data-interrupted]', [secondBox]);
    const dom = loadDom([a1, a2]);
    const logical = dom.turns()[0]!;
    expect(dom.markProgress(logical)).toBe(2);
    expect(firstBox.getAttribute('data-clf-progress')).toBe('1');
    expect(secondBox.getAttribute('data-clf-progress')).toBe('1');
    expect(dom.markProgress(logical)).toBe(0);
  });

  it('never hides a progress container that ChatGPT has put the answer inside', () => {
    // ChatGPT reparents the finished prose into a data-interrupted box on some turns.
    // Hiding by the attribute alone therefore hid the answer as well, which is what left
    // completed turns showing "Worked for 45s" over an empty gap with no way to get the
    // text back. Commentary is replaceable; the answer is not.
    const commentary = new FakeNode({ 'data-interrupted': 'false' }, 'Reading files');
    const answer = new FakeNode({ 'data-interrupted': 'false' }, 'Here is the summary');
    answer.with('.markdown', [new FakeNode({ class: 'markdown' }, 'Here is the summary')]);
    const section = turn('assistant', 'request-answer').with('[data-interrupted]', [commentary, answer]);
    const dom = loadDom([section]);
    const logical = dom.turns()[0]!;

    dom.hideProgress(logical, true);
    expect(commentary.getAttribute('data-clf-native-hidden')).toBe('1');
    expect(answer.getAttribute('data-clf-native-hidden')).toBeNull();

    dom.hideProgress(logical, false);
    expect(commentary.getAttribute('data-clf-native-hidden')).toBeNull();
  });

  it('reads every progress container of the turn, in order, rather than only the last', () => {
    const firstBox = new FakeNode({ 'data-interrupted': 'true' }, 'Thinking\nReading files');
    const secondBox = new FakeNode({ 'data-interrupted': 'true' }, 'Running tool\nRunning tests');
    const a1 = turn('assistant', 'request-3')
      .with('[data-interrupted]', [firstBox])
      .with('[data-interrupted="true"]', [firstBox]);
    const a2 = turn('assistant', 'request-3')
      .with('[data-interrupted]', [secondBox])
      .with('[data-interrupted="true"]', [secondBox]);
    const dom = loadDom([a1, a2]);
    const logical = dom.turns()[0]!;

    // Taking only the newest box made this value shrink whenever ChatGPT grew a new one,
    // and a shrink reads as new text to the delta logic, which printed it all over again.
    expect(dom.progressLine(logical)).toBe('Thinking\nReading files\nRunning tool\nRunning tests');
    expect(dom.interrupted(logical)).toBe(true);
  });
});

// --------------------------------------------------------------- service worker

class FakeStorageArea {
  data: Record<string, unknown>;
  /** Optional quota used to make writes fail the way Chrome does. */
  maxBytes: number | null = null;
  /** Deterministic transient write failure seam for durability/restart regressions. */
  failNextSets = 0;
  /**
   * Optional read latency, in milliseconds.
   *
   * Chrome answers a read from another process, so a read is not instant and two readers
   * do not advance in lockstep. The snapshot is still taken when the read is *issued* —
   * that is the whole point of modelling it: a read issued before someone else's write
   * can be answered after it, and then it carries stale data into live state.
   */
  lagMs = 0;
  /** Per-write completion delay; the snapshot is taken before waiting, like an async IPC write. */
  setDelays: number[] = [];
  private setCount = 0;

  constructor(initial: Record<string, unknown> = {}) {
    this.data = structuredClone(initial);
  }

  async get(keys: string[] | string): Promise<Record<string, unknown>> {
    const wanted = Array.isArray(keys) ? keys : [keys];
    const snapshot = Object.fromEntries(
      wanted.filter((key) => key in this.data).map((key) => [key, structuredClone(this.data[key])])
    );
    if (this.lagMs > 0) await new Promise((resolve) => setTimeout(resolve, this.lagMs));
    return snapshot;
  }

  async set(values: Record<string, unknown>): Promise<void> {
    if (this.failNextSets > 0) {
      this.failNextSets--;
      throw new Error('synthetic storage write failure');
    }
    const next = { ...this.data, ...structuredClone(values) };
    if (this.maxBytes !== null && Buffer.byteLength(JSON.stringify(next), 'utf8') > this.maxBytes) {
      throw new Error('QUOTA_BYTES exceeded');
    }
    const delay = this.setDelays[this.setCount++] ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    this.data = next;
  }
}

interface WorkerHarness {
  send(message: Record<string, unknown>, tabId?: number, documentId?: string): Promise<any>;
  /** Fires Chrome's real tab-close lifecycle event. */
  closeTab(tabId: number): Promise<void>;
  /** Fires only Chrome's navigation-start signal, without inventing a replacement document. */
  startTabNavigation(tabId: number, url?: string): Promise<void>;
  /** Fires Chrome's tab URL-change lifecycle event. */
  navigateTab(tabId: number, url: string): Promise<void>;
  /** Fires the extension install/update lifecycle event. */
  installed(reason?: string): Promise<void>;
  /** Registers the browser document that owns subsequent tab-scoped messages. */
  registerTab(tabId: number, documentId?: string): Promise<any>;
  /** Fires Chrome's tab-created lifecycle event, the way opening a link in a new tab does. */
  createTab(tab: { id: number; url?: string; pendingUrl?: string }): Promise<void>;
  tabsCreate: ReturnType<typeof vi.fn>;
  tabsQuery: ReturnType<typeof vi.fn>;
  tabsUpdate: ReturnType<typeof vi.fn>;
  tabsSendMessage: ReturnType<typeof vi.fn>;
  tabsRemove: ReturnType<typeof vi.fn>;
  windowsUpdate: ReturnType<typeof vi.fn>;
  scriptingExecuteScript: ReturnType<typeof vi.fn>;
  scriptingInsertCSS: ReturnType<typeof vi.fn>;
  alarmCreate: ReturnType<typeof vi.fn>;
  alarmClear: ReturnType<typeof vi.fn>;
}

function response(status: number, data: unknown) {
  const body =
    data && typeof data === 'object' && (data as Record<string, unknown>).app === 'chat-on-steroids'
      ? { bridge: BRIDGE_PROTOCOL, compatible: true, ...structuredClone(data as Record<string, unknown>) }
      : structuredClone(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(body);
    }
  };
}

function loadWorker(options: {
  local: FakeStorageArea;
  session: FakeStorageArea;
  fetch?: (input: string, init?: Record<string, unknown>) => Promise<ReturnType<typeof response>>;
  tabsGet?: (tabId: number) => Promise<{ id?: number; url?: string; pendingUrl?: string; status?: string }>;
  tabsQuery?: () => Promise<Array<{ id?: number; windowId?: number; url?: string; pendingUrl?: string }>>;
  tabsSendMessage?: (tabId: number, message: Record<string, unknown>) => Promise<unknown>;
}): WorkerHarness {
  let listener: ((message: any, sender: any, sendResponse: (value: any) => void) => boolean) | null = null;
  const tabRemovedListeners: Array<(tabId: number) => void> = [];
  const tabCreatedListeners: Array<(tab: { id?: number; url?: string; pendingUrl?: string }) => void> = [];
  const tabUpdatedListeners: Array<(tabId: number, changeInfo: { url?: string; status?: string }) => void> = [];
  const installedListeners: Array<(details: { reason: string }) => void> = [];
  const tabsCreate = vi.fn(async () => ({ id: 99 }));
  const tabsQuery = vi.fn(options.tabsQuery ?? (async () => []));
  const tabsUpdate = vi.fn(async (id: number) => ({ id, windowId: 7 }));
  const tabsSendMessage = vi.fn(options.tabsSendMessage ?? (async () => ({ ok: true })));
  const tabsRemove = vi.fn(async () => undefined);
  const scriptingExecuteScript = vi.fn(async () => []);
  const scriptingInsertCSS = vi.fn(async () => undefined);
  const alarmCreate = vi.fn(() => undefined);
  const alarmClear = vi.fn(async () => true);
  const windowsUpdate = vi.fn(async () => ({ id: 7 }));
  const documentNumbers = new Map<number, number>();
  const currentDocuments = new Map<number, string>();
  const documentFor = (tabId: number): string => {
    const current = currentDocuments.get(tabId);
    if (current) return current;
    const created = `document-${tabId}-0`;
    currentDocuments.set(tabId, created);
    documentNumbers.set(tabId, 0);
    return created;
  };
  const event = () => ({ addListener: () => undefined });
  const chrome = {
    storage: { local: options.local, session: options.session },
    runtime: {
      getManifest: () => ({ version: '1.6.0' }),
      onMessage: {
        addListener(fn: typeof listener) {
          listener = fn;
        }
      },
      onInstalled: {
        addListener(fn: (details: { reason: string }) => void) {
          installedListeners.push(fn);
        }
      },
      onStartup: event()
    },
    windows: { update: windowsUpdate },
    scripting: {
      executeScript: scriptingExecuteScript,
      insertCSS: scriptingInsertCSS
    },
    alarms: {
      create: alarmCreate,
      clear: alarmClear,
      onAlarm: event()
    },
    tabs: {
      create: tabsCreate,
      query: tabsQuery,
      update: tabsUpdate,
      get: options.tabsGet ?? vi.fn(async () => {
        throw new Error('tab state unavailable in this harness');
      }),
      sendMessage: tabsSendMessage,
      remove: tabsRemove,
      onCreated: {
        addListener(fn: (tab: { id?: number; url?: string; pendingUrl?: string }) => void) {
          tabCreatedListeners.push(fn);
        }
      },
      onRemoved: {
        addListener(fn: (tabId: number) => void) {
          tabRemovedListeners.push(fn);
        }
      },
      onUpdated: {
        addListener(fn: (tabId: number, changeInfo: { url?: string; status?: string }) => void) {
          tabUpdatedListeners.push(fn);
        }
      }
    }
  };
  const fetch = options.fetch ?? (async () => response(503, {}));
  vm.runInNewContext(backgroundSource, {
    chrome,
    fetch,
    AbortController,
    setTimeout,
    clearTimeout,
    URL,
    TextEncoder,
    console
  }, { filename: 'background.js' });
  if (!listener) throw new Error('background.js did not register a message listener');

  return {
    tabsCreate,
    tabsQuery,
    tabsUpdate,
    tabsSendMessage,
    tabsRemove,
    windowsUpdate,
    scriptingExecuteScript,
    scriptingInsertCSS,
    alarmCreate,
    alarmClear,
    async installed(reason = 'update') {
      for (const fn of installedListeners) fn({ reason });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async createTab(tab: { id: number; url?: string; pendingUrl?: string }) {
      for (const fn of tabCreatedListeners) fn(tab);
      for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async closeTab(tabId: number) {
      for (const fn of tabRemovedListeners) fn(tabId);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async startTabNavigation(tabId: number, url?: string) {
      for (const fn of tabUpdatedListeners) fn(tabId, { ...(url ? { url } : {}), status: 'loading' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    registerTab(tabId, documentId = documentFor(tabId)) {
      return new Promise((resolve, reject) => {
        try {
          const keep = listener!(
            { type: 'register_document' },
            { tab: { id: tabId }, documentId, frameId: 0 },
            resolve
          );
          if (keep !== true) reject(new Error('listener did not keep the response channel open'));
        } catch (err) {
          reject(err);
        }
      });
    },
    async navigateTab(tabId: number, url: string) {
      const chatGpt = /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)(?:\/|$)/i.test(url);
      for (const fn of tabUpdatedListeners) fn(tabId, { url, ...(chatGpt ? { status: 'loading' } : {}) });
      let newDocument: string | null = null;
      if (chatGpt) {
        const next = (documentNumbers.get(tabId) ?? 0) + 1;
        documentNumbers.set(tabId, next);
        newDocument = `document-${tabId}-${next}`;
        currentDocuments.set(tabId, newDocument);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Static content injection registers the new ChatGPT document before its normal page
      // traffic. Model that handshake here rather than letting a later bind implicitly clear
      // a terminal lease.
      if (newDocument) {
        await new Promise((resolve, reject) => {
          try {
            const keep = listener!(
              { type: 'register_document' },
              { tab: { id: tabId }, documentId: newDocument, frameId: 0 },
              resolve
            );
            if (keep !== true) reject(new Error('listener did not keep the response channel open'));
          } catch (err) {
            reject(err);
          }
        });
      }
    },
    send(message, tabId = 1, documentId = documentFor(tabId)) {
      return new Promise((resolve, reject) => {
        try {
          const keep = listener!(message, { tab: { id: tabId }, documentId, frameId: 0 }, resolve);
          if (keep !== true) reject(new Error('listener did not keep the response channel open'));
        } catch (err) {
          reject(err);
        }
      });
    }
  };
}

function journalOf(session: FakeStorageArea): any[] {
  const value = session.data.journal;
  return Array.isArray(value) ? value : [];
}

describe('worker settings authority', () => {
  const paired = { port: 8765, token: 'paired-token' };
  const CHAT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  it('forwards auto-compaction writes with the source tab conversation so the app can reject worker authority', async () => {
    const posted: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/settings' && init.method === 'POST') {
        posted.push(JSON.parse(String(init.body || '{}')));
        return response(409, { error: 'worker_compaction_disabled' });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(42);
    await worker.send({ type: 'bind', conversationId: CHAT }, 42);

    const reply = await worker.send({ type: 'settings_set', conversationId: CHAT, autoCompact: false }, 42);
    expect(reply).toMatchObject({ ok: false, status: 409, data: { error: 'worker_compaction_disabled' } });
    expect(posted).toEqual([{ autoCompact: false, conversationId: CHAT }]);
  });

  it('refuses a settings write that names a different conversation than the source tab owns', async () => {
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      return response(200, {});
    });
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch });
    await worker.registerTab(43);
    await worker.send({ type: 'bind', conversationId: CHAT }, 43);
    const other = '11111111-2222-4333-8444-555555555555';

    expect(await worker.send({ type: 'settings_set', conversationId: other, autoCompact: true }, 43)).toMatchObject({
      ok: false,
      error: 'stale_conversation'
    });
    expect(fetch.mock.calls.some(([input]) => new URL(String(input)).pathname === '/settings')).toBe(false);
  });
});

// ------------------------------------------------------------ command delivery

/**
 * The half of delivery that lives in the browser.
 *
 * The app opens the marked chat itself, so what is tested here is what the extension
 * does with a marker once a page has it, and the recovery path for commands the app
 * could not open — which is the only thing that runs while no ChatGPT page exists.
 */
describe('extension command delivery', () => {
  const paired = { port: 8765, token: 'paired-token' };

  it('redeems only the command id the page was opened for', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/redeem') {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        if (body.id !== 'cmd-1') return response(404, { error: 'gone' });
        return response(200, { command: { id: 'cmd-1', kind: 'open-chat', text: 'do the thing', agent: null } });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    const mine = await worker.send({ type: 'redeem', id: 'cmd-1', client: 'page-1' });
    expect(mine).toMatchObject({ ok: true, command: { id: 'cmd-1', text: 'do the thing' } });

    // A marker for a command that has been cancelled, superseded or already sent gets
    // nothing, so a stale URL in history types nothing into a chat.
    const stale = await worker.send({ type: 'redeem', id: 'cmd-gone', client: 'page-1' });
    expect(stale).toMatchObject({ ok: true, command: null, gone: true });
    // The page identifies itself, because a command belongs to one page: a second tab on
    // the same marker is a different claimant and the app refuses it.
    expect(bodies).toEqual([
      { id: 'cmd-1', client: 'page-1' },
      { id: 'cmd-gone', client: 'page-1' }
    ]);
  });

  it('never redeems a command this browser already delivered', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea({ settled: ['cmd-done'] });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      return response(200, { command: { id: 'cmd-done', text: 'again?' } });
    });
    const worker = loadWorker({ local, session, fetch });

    expect(await worker.send({ type: 'redeem', id: 'cmd-done' })).toMatchObject({ ok: true, command: null });
    expect(fetch.mock.calls.some(([input]) => String(input).includes('/commands/redeem'))).toBe(false);
  });

  /**
   * The extension does not go looking for work, and cannot open a chat of its own accord.
   *
   * This replaces the whole recovery-alarm path. A command used to be a thing the browser
   * fetched: a half-minute `chrome.alarms` tick pulled `GET /commands`, opened a marked tab
   * per unopened command, and persisted an `opened` list so a restarted service worker would
   * not open a second chat for the same job. Every part of that could act on a run the app
   * had already finished with, and every part of it was a clock. The app opens the chat now,
   * in the same transaction that creates the command, so the extension has nothing to poll
   * and nothing to remember. The only alarm now is a delivery retry for observations and
   * close notices already accepted into durable session storage; it never discovers work
   * and never opens a tab.
   */
  it('opens no tabs and holds no alarm of its own', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    // Starting up is not a reason to open anything, and neither is asking how things are.
    await worker.send({ type: 'status' });
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(worker.tabsUpdate).not.toHaveBeenCalled();
    expect(session.data.opened).toBeUndefined();

    // There is no listing route left to ask, so nothing here ever asks for one.
    expect(fetch.mock.calls.every(([input]) => new URL(String(input)).pathname !== '/commands')).toBe(true);
    expect(backgroundSource).toContain("const RETRY_ALARM = 'clf-bridge-drain'");
    expect(backgroundSource).not.toContain("call('/commands'");
  });

  it('re-injects the recorder into already-open ChatGPT tabs after an extension reload', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    worker.tabsQuery.mockResolvedValueOnce([{ id: 41 }, { id: 42 }]);

    await worker.installed('update');

    expect(worker.tabsQuery).toHaveBeenCalledWith({
      url: ['https://chatgpt.com/*', 'https://chat.openai.com/*']
    });
    expect(worker.scriptingExecuteScript.mock.calls).toEqual([
      [{ target: { tabId: 41 }, files: ['chatgpt-dom.js'] }],
      [{ target: { tabId: 41 }, world: 'MAIN', files: ['fiber.js'] }],
      [{ target: { tabId: 41 }, files: ['content.js'] }],
      [{ target: { tabId: 42 }, files: ['chatgpt-dom.js'] }],
      [{ target: { tabId: 42 }, world: 'MAIN', files: ['fiber.js'] }],
      [{ target: { tabId: 42 }, files: ['content.js'] }]
    ]);
    expect(worker.scriptingInsertCSS.mock.calls).toEqual([
      [{ target: { tabId: 41 }, files: ['overlay.css'] }],
      [{ target: { tabId: 42 }, files: ['overlay.css'] }]
    ]);
  });

  it('keeps a live recorder but revalidates the idempotent MAIN-world Fiber helper', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    worker.tabsQuery.mockResolvedValueOnce([{ id: 41 }]);
    worker.tabsSendMessage.mockResolvedValueOnce({ ok: true, recorderVersion: 10 });

    await worker.installed('update');

    expect(worker.tabsSendMessage).toHaveBeenCalledWith(41, { type: 'clf-recorder-ping' });
    expect(worker.scriptingExecuteScript.mock.calls).toEqual([
      [{ target: { tabId: 41 }, world: 'MAIN', files: ['fiber.js'] }]
    ]);
    expect(worker.scriptingInsertCSS).not.toHaveBeenCalled();
  });

  it('repairs a missing MAIN-world Fiber helper on demand for the sending tab only', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });

    const repaired = await worker.send({ type: 'repair_fiber' }, 73);

    expect(repaired).toMatchObject({ ok: true });
    expect(worker.scriptingExecuteScript).toHaveBeenCalledWith({
      target: { tabId: 73, documentIds: ['document-73-0'] },
      world: 'MAIN',
      files: ['fiber.js']
    });

    await worker.navigateTab(73, 'https://example.com/left');
    expect(await worker.send({ type: 'repair_fiber' }, 73)).toMatchObject({ ok: false, error: 'tab_closed' });
  });

  it('has no way to ask the app for work at all', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    // The old poll message, from a stale content script that was never reloaded. It is not
    // a route any more, so it is answered as the unknown message it is rather than
    // reopening a path the app has stopped serving.
    const reply = await worker.send({ type: 'poll' });
    expect(reply?.ok).not.toBe(true);
    expect(fetch.mock.calls.every(([input]) => new URL(String(input)).pathname !== '/commands')).toBe(true);
  });

  it('provisions itself silently on the first call and retries with the new token', async () => {
    const local = new FakeStorageArea({ port: 8765 });
    const session = new FakeStorageArea();
    const seen: Array<{ path: string; auth: unknown }> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      const headers = (init.headers ?? {}) as Record<string, string>;
      seen.push({ path: url.pathname, auth: headers.authorization });
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: false });
      if (url.pathname === '/pair') return response(200, { token: 'fresh-token' });
      if (url.pathname === '/commands/redeem') return response(200, { command: null });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    const status = await worker.send({ type: 'status' });
    expect(status).toMatchObject({ connected: true, paired: true });
    expect(seen.some((call) => call.path === '/pair')).toBe(true);
    expect(local.data.token).toBe('fresh-token');

    await worker.send({ type: 'redeem', id: 'cmd-1', client: 'page-1' });
    expect(seen.find((call) => call.path === '/commands/redeem')?.auth).toBe('Bearer fresh-token');
    // Nothing anywhere asked for a code.
    expect(fetch.mock.calls.some(([, init]) => String((init as any)?.body ?? '').includes('code'))).toBe(false);
  });

  it('re-provisions once when the app no longer recognises the stored token', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'stale-token' });
    const session = new FakeStorageArea();
    const tokens: Array<unknown> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      const headers = (init.headers ?? {}) as Record<string, string>;
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/pair') return response(200, { token: 'second-token' });
      if (url.pathname === '/commands/redeem') {
        tokens.push(headers.authorization);
        return headers.authorization === 'Bearer second-token'
          ? response(200, { command: null })
          : response(401, { error: 'unauthorised' });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    const result = await worker.send({ type: 'redeem', id: 'cmd-1', client: 'page-1' });
    expect(result.ok).toBe(true);
    expect(tokens).toEqual(['Bearer stale-token', 'Bearer second-token']);
    expect(local.data.token).toBe('second-token');
  });
});

/**
 * Waking a worker happens in the chat that worker already has.
 *
 * The app cannot reach into the browser, so it opens `/c/<id>?clf=<command>` and lets the
 * page redeem the marker. That is right when the chat is closed and wrong when it is not:
 * ChatGPT is a single-page app, and a second tab on the same conversation is exactly the
 * duplicate this whole feature exists to avoid. The service worker sees the tab being
 * created, notices the conversation is already open somewhere, and hands the job over to
 * that document instead.
 */
describe('extension revival delivery', () => {
  const paired = { port: 8765, token: 'paired-token' };
  const CHAT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const REVIVAL_URL = `https://chatgpt.com/c/${CHAT}?clf=cmd-wake#clf=cmd-wake`;

  const quiet = () =>
    vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/revivals/pending') {
        const body = JSON.parse(String(init.body || '{}')) as { entries?: Array<{ id?: string }> };
        return response(200, {
          pending: (Array.isArray(body.entries) ? body.entries : [])
            .map((entry) => entry?.id)
            .filter((id): id is string => typeof id === 'string')
        });
      }
      return response(404, {});
    });

  it('gives revival to the already-open worker without focusing it, and closes the duplicate only after claim', async () => {
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch: quiet() });
    worker.tabsQuery.mockResolvedValue([
      { id: 4, windowId: 7, url: `https://chatgpt.com/c/${CHAT}` },
      { id: 5, windowId: 7, url: 'https://chatgpt.com/c/99999999-1111-4222-8333-444444444444' }
    ]);
    const order: string[] = [];
    worker.tabsRemove.mockImplementation(async (id: number) => {
      order.push(`remove:${id}`);
    });
    worker.tabsSendMessage.mockImplementation(async (id: number, message: { type: string }) => {
      order.push(`${message.type}:${id}`);
      return message.type === 'clf-recorder-ping'
        ? { ok: true, recorderVersion: 10 }
        : { ok: true, claimed: true };
    });

    await worker.createTab({ id: 12, pendingUrl: REVIVAL_URL });

    // Handed to the open document, with the conversation named so it can refuse anything
    // that is not the chat the command is for.
    expect(worker.tabsSendMessage).toHaveBeenCalledWith(4, {
      type: 'clf-run-command',
      id: 'cmd-wake',
      conversationId: CHAT
    });
    // The existing page must own the durable lease before the fallback disappears. While both
    // documents exist the bridge's single-owner lease prevents duplicate delivery; closing the
    // fallback before this claim is the race that used to destroy the actual winning owner.
    expect(order).toEqual(['clf-recorder-ping:4', 'clf-run-command:4', 'remove:12']);
    expect(worker.tabsUpdate).not.toHaveBeenCalled();
    expect(worker.windowsUpdate).not.toHaveBeenCalled();
  });

  it('does not close a fresh revival tab that already won the durable command lease', async () => {
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch: quiet() });
    worker.tabsQuery.mockResolvedValue([{ id: 4, windowId: 7, url: `https://chatgpt.com/c/${CHAT}` }]);
    worker.tabsSendMessage.mockImplementation(async (_id: number, message: { type: string }) => {
      if (message.type === 'clf-recorder-ping') return { ok: true, recorderVersion: 10 };
      // The app-opened fallback loaded faster and redeemed while background was pinging this
      // existing tab. The existing document truthfully reports that it did not get the lease.
      return { ok: true, claimed: false };
    });

    await worker.createTab({ id: 12, pendingUrl: REVIVAL_URL });

    expect(worker.tabsSendMessage).toHaveBeenCalledWith(4, {
      type: 'clf-run-command',
      id: 'cmd-wake',
      conversationId: CHAT
    });
    // The fresh tab is the winning owner. Killing it here strands the wake until the bridge
    // deadline even though a viable document already owns the command.
    expect(worker.tabsRemove).not.toHaveBeenCalledWith(12);
  });

  it('lets the app open the chat when it is not on screen anywhere', async () => {
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch: quiet() });
    // Another worker's chat and a fresh tab are not this conversation. A closed chat is
    // reopened by the URL the app already opened, which is the exact `/c/<id>` of it.
    worker.tabsQuery.mockResolvedValue([
      { id: 4, windowId: 7, url: 'https://chatgpt.com/c/99999999-1111-4222-8333-444444444444' },
      { id: 6, windowId: 7, url: 'https://chatgpt.com/' }
    ]);

    await worker.createTab({ id: 12, pendingUrl: REVIVAL_URL });

    expect(worker.tabsRemove).not.toHaveBeenCalled();
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
  });

  it('keeps the opened tab when the chat that is open cannot answer for itself', async () => {
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch: quiet() });
    worker.tabsQuery.mockResolvedValue([{ id: 4, windowId: 7, url: `https://chatgpt.com/c/${CHAT}` }]);
    // A ChatGPT tab left open from before this extension was installed or updated has no
    // live content script. Closing the app's tab in favour of it would strand the command.
    worker.tabsSendMessage.mockRejectedValue(new Error('Could not establish connection'));

    await worker.createTab({ id: 12, pendingUrl: REVIVAL_URL });

    expect(worker.tabsRemove).not.toHaveBeenCalled();
    expect(worker.tabsSendMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps the fresh revival tab when the existing chat has a stale recorder version', async () => {
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch: quiet() });
    worker.tabsQuery.mockResolvedValue([{ id: 4, windowId: 7, url: `https://chatgpt.com/c/${CHAT}` }]);
    worker.tabsSendMessage.mockResolvedValue({ ok: true, recorderVersion: 8 });

    await worker.createTab({ id: 12, pendingUrl: REVIVAL_URL });

    expect(worker.tabsSendMessage).toHaveBeenCalledWith(4, { type: 'clf-recorder-ping' });
    expect(worker.tabsRemove).not.toHaveBeenCalled();
    expect(
      worker.tabsSendMessage.mock.calls.filter(([, message]) => (message as { type?: string })?.type === 'clf-run-command')
    ).toEqual([]);
  });

  it('skips a dead first copy of the worker chat and reuses a healthy second copy', async () => {
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch: quiet() });
    worker.tabsQuery.mockResolvedValue([
      { id: 4, windowId: 7, url: `https://chatgpt.com/c/${CHAT}` },
      { id: 5, windowId: 8, url: `https://chatgpt.com/c/${CHAT}` }
    ]);
    worker.tabsSendMessage.mockImplementation(async (id: number, message: { type: string }) => {
      if (id === 4) throw new Error('stale recorder');
      return message.type === 'clf-recorder-ping'
        ? { ok: true, recorderVersion: 10 }
        : { ok: true, claimed: true };
    });

    await worker.createTab({ id: 12, pendingUrl: REVIVAL_URL });

    expect(worker.tabsSendMessage).toHaveBeenCalledWith(5, { type: 'clf-recorder-ping' });
    expect(worker.tabsSendMessage).toHaveBeenCalledWith(5, {
      type: 'clf-run-command',
      id: 'cmd-wake',
      conversationId: CHAT
    });
    expect(worker.tabsRemove).toHaveBeenCalledWith(12);
    expect(worker.tabsUpdate).not.toHaveBeenCalled();
    expect(worker.windowsUpdate).not.toHaveBeenCalled();
  });

  it('reuses a supported legacy chat.openai.com worker tab', async () => {
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch: quiet() });
    worker.tabsQuery.mockResolvedValue([{ id: 4, windowId: 7, url: `https://chat.openai.com/c/${CHAT}` }]);
    worker.tabsSendMessage.mockImplementation(async (_id: number, message: { type: string }) =>
      message.type === 'clf-recorder-ping'
        ? { ok: true, recorderVersion: 10 }
        : { ok: true, claimed: true }
    );

    await worker.createTab({ id: 12, pendingUrl: REVIVAL_URL });

    expect(worker.tabsSendMessage).toHaveBeenCalledWith(4, {
      type: 'clf-run-command',
      id: 'cmd-wake',
      conversationId: CHAT
    });
    expect(worker.tabsRemove).toHaveBeenCalledWith(12);
  });

  it('reuses the existing worker chat when Chrome publishes the revival URL only onUpdated', async () => {
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch: quiet() });
    worker.tabsQuery.mockResolvedValue([{ id: 4, windowId: 7, url: `https://chatgpt.com/c/${CHAT}` }]);
    worker.tabsSendMessage.mockImplementation(async (_id: number, message: { type: string }) =>
      message.type === 'clf-recorder-ping'
        ? { ok: true, recorderVersion: 10 }
        : { ok: true, claimed: true }
    );

    // Chrome documents that onCreated may arrive before url/pendingUrl is populated. The URL
    // then appears on onUpdated. Missing that second chance leaks one duplicate worker tab per
    // wake even though the original chat was already open.
    await worker.createTab({ id: 12 });
    expect(worker.tabsRemove).not.toHaveBeenCalled();
    await worker.startTabNavigation(12, REVIVAL_URL);

    expect(worker.tabsRemove).toHaveBeenCalledWith(12);
    expect(worker.tabsSendMessage).toHaveBeenCalledWith(4, {
      type: 'clf-run-command',
      id: 'cmd-wake',
      conversationId: CHAT
    });
  });

  it('does not acknowledge deferred-revival custody until local persistence succeeds, then restores it after browser restart', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea();
    const first = loadWorker({ local, session, fetch: quiet() });
    await first.registerTab(4, 'document-4-live');

    local.failNextSets = 1;
    const failed = await first.send(
      { type: 'defer_revival', id: 'cmd-persisted-wake', conversationId: CHAT },
      4,
      'document-4-live'
    );
    expect(failed).toMatchObject({ ok: false });
    expect(local.data.deferredRevivals ?? []).toEqual([]);

    const retried = await first.send(
      { type: 'defer_revival', id: 'cmd-persisted-wake', conversationId: CHAT },
      4,
      'document-4-live'
    );
    expect(retried).toEqual({ ok: true, deferred: true });
    expect(local.data.deferredRevivals).toMatchObject([
      { id: 'cmd-persisted-wake', conversationId: CHAT }
    ]);

    // Full browser restart: storage.session is gone, but the small inert recovery marker is in
    // storage.local. With no surviving ChatGPT tab, recovery recreates exactly the marked target.
    const restartFetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/revivals/pending') {
        return response(200, { pending: ['cmd-persisted-wake'] });
      }
      return response(404, {});
    });
    const restarted = loadWorker({
      local,
      session: new FakeStorageArea(),
      fetch: restartFetch,
      tabsQuery: async () => []
    });
    await vi.waitFor(() => expect(restarted.tabsCreate).toHaveBeenCalledTimes(1));
    const created = String(restarted.tabsCreate.mock.calls[0]?.[0]?.url || '');
    expect(created).toContain(`/c/${CHAT}`);
    expect(created).toContain('clf=cmd-persisted-wake');
  });

  it('prunes a stale deferred revival before browser startup can recreate its ChatGPT tab', async () => {
    const local = new FakeStorageArea({
      ...paired,
      deferredRevivals: [{ id: 'cmd-dead-after-restart', conversationId: CHAT, queuedAt: Date.now() }]
    });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/revivals/pending') return response(200, { pending: [] });
      return response(404, {});
    });

    const restarted = loadWorker({ local, session: new FakeStorageArea(), fetch, tabsQuery: async () => [] });
    await vi.waitFor(() => expect(fetch.mock.calls.some(([input]) => new URL(String(input)).pathname === '/commands/revivals/pending')).toBe(true));

    expect(restarted.tabsCreate).not.toHaveBeenCalled();
    expect(local.data.deferredRevivals).toEqual([]);
  });

  it('fails closed when deferred-revival validation is unavailable instead of opening an unproven tab', async () => {
    const marker = { id: 'cmd-validation-unavailable', conversationId: CHAT, queuedAt: Date.now() };
    const local = new FakeStorageArea({ ...paired, deferredRevivals: [marker] });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/revivals/pending') return response(503, { error: 'bridge_recovering' });
      return response(404, {});
    });

    const restarted = loadWorker({ local, session: new FakeStorageArea(), fetch, tabsQuery: async () => [] });
    await vi.waitFor(() => expect(fetch.mock.calls.some(([input]) => new URL(String(input)).pathname === '/commands/revivals/pending')).toBe(true));

    expect(restarted.tabsCreate).not.toHaveBeenCalled();
    expect(local.data.deferredRevivals).toMatchObject([marker]);
  });

  it('replaces an older deferred marker for the same worker chat when a newer wake reaches browser custody', async () => {
    const oldId = 'cmd-old-deferred-worker-wake';
    const currentId = 'cmd-new-worker-wake';
    const local = new FakeStorageArea({
      ...paired,
      deferredRevivals: [{ id: oldId, conversationId: CHAT, queuedAt: 1 }]
    });
    const session = new FakeStorageArea({
      revivalPreferences: {
        [oldId]: { conversationId: CHAT, fallbackTabId: 12, preferredTabId: 4 }
      }
    });
    const worker = loadWorker({ local, session });
    await worker.registerTab(4, 'document-4-current');

    const custody = await worker.send(
      { type: 'defer_revival', id: currentId, conversationId: CHAT },
      4,
      'document-4-current'
    );

    expect(custody).toEqual({ ok: true, deferred: true });
    expect(local.data.deferredRevivals).toMatchObject([{ id: currentId, conversationId: CHAT }]);
    expect((local.data.deferredRevivals as Array<{ id: string }>).some((entry) => entry.id === oldId)).toBe(false);
    expect((session.data.revivalPreferences as Record<string, unknown> | undefined)?.[oldId]).toBeUndefined();
  });

  it('treats a registered exact worker tab as present while its recorder is temporarily unready, then reuses it exactly once', async () => {
    const local = new FakeStorageArea({
      ...paired,
      deferredRevivals: [{ id: 'cmd-recover-existing', conversationId: CHAT, queuedAt: Date.now() }]
    });
    const session = new FakeStorageArea({
      tabConversations: { '4': CHAT },
      tabDocuments: { '4': 'document-4-old' },
      tabEpochs: { '4': 0 }
    });
    let recorderReady = false;
    const worker = loadWorker({
      local,
      session,
      fetch: quiet(),
      // During ChatGPT reload/startup the concrete /c/<id> can temporarily collapse to root.
      // The durable tab registry is the identity proof that must prevent a duplicate create.
      tabsQuery: async () => [{ id: 4, windowId: 7, url: 'https://chatgpt.com/' }],
      tabsSendMessage: async (_tabId, message) => {
        if (message.type === 'clf-recorder-ping') {
          if (!recorderReady) throw new Error('receiver not ready yet');
          return { ok: true, recorderVersion: 10 };
        }
        if (message.type === 'clf-run-command') return { ok: true, claimed: true };
        return { ok: true };
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(
      worker.tabsSendMessage.mock.calls.filter(([, message]) => (message as { type?: string })?.type === 'clf-run-command')
    ).toHaveLength(0);

    recorderReady = true;
    // The replacement document's registration is the natural retry signal. Recovery must target
    // the same numeric tab, issue one command only after its current recorder answers, and never
    // manufacture another worker tab.
    await worker.registerTab(4, 'document-4-new');
    await vi.waitFor(() =>
      expect(
        worker.tabsSendMessage.mock.calls.filter(([, message]) => (message as { type?: string })?.type === 'clf-run-command')
      ).toHaveLength(1)
    );
    expect(worker.tabsSendMessage).toHaveBeenCalledWith(4, {
      type: 'clf-run-command',
      id: 'cmd-recover-existing',
      conversationId: CHAT,
      deferredRecovery: true
    });
    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('fences the app-opened fallback while the original exact worker tab is temporarily unready, then claims on the original and removes the fallback', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea({
      tabConversations: { '4': CHAT },
      tabDocuments: { '4': 'document-4-old' },
      tabEpochs: { '4': 0 }
    });
    let fallbackCreated = false;
    let recorderReady = false;
    const worker = loadWorker({
      local,
      session,
      fetch: quiet(),
      tabsQuery: async () => [
        { id: 4, windowId: 7, url: 'https://chatgpt.com/' },
        ...(fallbackCreated ? [{ id: 12, windowId: 7, url: REVIVAL_URL }] : [])
      ],
      tabsSendMessage: async (tabId, message) => {
        if (message.type === 'clf-recorder-ping') {
          if (tabId === 4 && !recorderReady) throw new Error('original recorder is still starting');
          return { ok: true, recorderVersion: 10 };
        }
        if (message.type === 'clf-run-command') {
          if (tabId !== 4) throw new Error('fallback must never receive the revival command');
          return { ok: true, claimed: true };
        }
        return { ok: true };
      }
    });

    fallbackCreated = true;
    await worker.createTab({ id: 12, pendingUrl: REVIVAL_URL });
    // onCreated saw the already-registered worker tab and persisted the preference before the
    // recorder probe failed. The fallback remains visible only as a safe marker carrier.
    expect(worker.tabsRemove).not.toHaveBeenCalledWith(12);
    expect(local.data.deferredRevivals).toMatchObject([{ id: 'cmd-wake', conversationId: CHAT }]);
    expect(
      worker.tabsSendMessage.mock.calls.filter(([, message]) => (message as { type?: string })?.type === 'clf-run-command')
    ).toHaveLength(0);

    await worker.registerTab(12, 'document-12-fallback');
    const fallbackCustody = await worker.send(
      { type: 'defer_revival', id: 'cmd-wake', conversationId: CHAT },
      12,
      'document-12-fallback'
    );
    expect(fallbackCustody).toMatchObject({ ok: true, deferred: true, preferredElsewhere: true });
    expect(worker.tabsCreate).not.toHaveBeenCalled();
    expect(
      worker.tabsSendMessage.mock.calls.filter(([, message]) => (message as { type?: string })?.type === 'clf-run-command')
    ).toHaveLength(0);

    recorderReady = true;
    await worker.registerTab(4, 'document-4-new');
    await vi.waitFor(() =>
      expect(
        worker.tabsSendMessage.mock.calls.filter(([, message]) => (message as { type?: string })?.type === 'clf-run-command')
      ).toHaveLength(1)
    );

    expect(worker.tabsSendMessage).toHaveBeenCalledWith(4, {
      type: 'clf-run-command',
      id: 'cmd-wake',
      conversationId: CHAT,
      deferredRecovery: true
    });
    await vi.waitFor(() => expect(worker.tabsRemove).toHaveBeenCalledWith(12));
    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('does not let a prior revival marker make the surviving exact worker tab impersonate the next fallback', async () => {
    const local = new FakeStorageArea(paired);
    const session = new FakeStorageArea({
      tabConversations: { '4': CHAT },
      tabDocuments: { '4': 'document-4-live' },
      tabEpochs: { '4': 0 }
    });
    const firstCommand = 'cmd-prior-wake';
    const secondCommand = 'cmd-current-wake';
    const firstUrl = `https://chatgpt.com/c/${CHAT}?clf=${firstCommand}#clf=${firstCommand}`;
    const secondUrl = `https://chatgpt.com/c/${CHAT}?clf=${secondCommand}#clf=${secondCommand}`;
    let secondWake = false;
    const worker = loadWorker({
      local,
      session,
      fetch: quiet(),
      tabsQuery: async () =>
        secondWake
          ? [
              { id: 4, windowId: 7, url: `https://chatgpt.com/c/${CHAT}` },
              { id: 12, windowId: 7, url: secondUrl }
            ]
          : [],
      tabsSendMessage: async (tabId, message) => {
        if (message.type === 'clf-recorder-ping') {
          if (tabId === 4) throw new Error('surviving worker recorder is remounting');
          return { ok: true, recorderVersion: 10 };
        }
        if (message.type === 'clf-run-command') {
          if (tabId !== 4) throw new Error('the current fallback must never steal this wake');
          return { ok: true, claimed: true };
        }
        return { ok: true };
      }
    });

    // This exact numeric tab was itself the app-opened revival tab on an earlier wake and then
    // survived as the worker's ordinary open chat. That old routing fact must not say anything
    // about which tab is the fallback for a later command.
    await worker.createTab({ id: 4, pendingUrl: firstUrl });

    secondWake = true;
    await worker.createTab({ id: 12, pendingUrl: secondUrl });
    expect(session.data.revivalPreferences).toMatchObject({
      [secondCommand]: { conversationId: CHAT, fallbackTabId: 12, preferredTabId: 4 }
    });

    // The original exact document is alive but not submit-ready yet. Its custody request for the
    // *new* command must be accepted locally. A stale prior-wake marker used to misclassify tab 4
    // as this command's fallback, invert preference to 4 -> 12, and start the 1s two-tab custody
    // ping-pong seen in the live LevelDB state.
    const custody = await worker.send(
      { type: 'defer_revival', id: secondCommand, conversationId: CHAT },
      4,
      'document-4-live'
    );
    expect(custody).toEqual({ ok: true, deferred: true });
    expect(session.data.revivalPreferences).toMatchObject({
      [secondCommand]: { conversationId: CHAT, fallbackTabId: 12, preferredTabId: 4 }
    });

    const fallbackCustody = await worker.send(
      { type: 'defer_revival', id: secondCommand, conversationId: CHAT },
      12,
      'document-12-current'
    );
    expect(fallbackCustody).toMatchObject({ ok: true, deferred: true, preferredElsewhere: true });
    expect(session.data.revivalPreferences).toMatchObject({
      [secondCommand]: { conversationId: CHAT, fallbackTabId: 12, preferredTabId: 4 }
    });
    expect(
      worker.tabsSendMessage.mock.calls.filter(
        ([tabId, message]) => tabId === 12 && (message as { type?: string })?.type === 'clf-run-command'
      )
    ).toHaveLength(0);
  });

  it('ignores tabs that are not a marked revival at all', async () => {
    const worker = loadWorker({ local: new FakeStorageArea(paired), session: new FakeStorageArea(), fetch: quiet() });
    worker.tabsQuery.mockResolvedValue([{ id: 4, windowId: 7, url: `https://chatgpt.com/c/${CHAT}` }]);

    // A chat opened by hand carries no command, and the two chat-opening commands name no
    // conversation. Neither may be handed to an existing document.
    await worker.createTab({ id: 12, pendingUrl: `https://chatgpt.com/c/${CHAT}` });
    await worker.createTab({ id: 13, pendingUrl: 'https://chatgpt.com/?clf=cmd-fresh#clf=cmd-fresh' });
    await worker.createTab({ id: 14, pendingUrl: 'https://example.com/c/whatever?clf=cmd-wake' });

    const handovers = worker.tabsSendMessage.mock.calls.filter(
      ([, message]) => (message as { type?: string })?.type === 'clf-run-command'
    );
    expect(handovers).toEqual([]);
    expect(worker.tabsRemove).not.toHaveBeenCalled();
  });
});

describe('extension observation journal', () => {
  it('does not permanently settle a worker command merely because its bootstrap message was sent', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/ack') return response(200, { ok: true });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    await worker.send({ type: 'ack', id: 'worker-command', status: 'sent', agent: 'worker-1' });
    expect(session.data.settled ?? []).toEqual([]);

    await worker.send({ type: 'ack', id: 'resume-command', status: 'sent' });
    expect(session.data.settled).toEqual(['resume-command']);
  });

  it('preserves the observation journal on a 426 protocol mismatch', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/events') return response(426, { error: 'upgrade_required' });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const conversationId = '11111111-2222-3333-4444-555555555555';

    const result = await worker.send({
      type: 'events',
      conversationId,
      entries: [
        { conversationId, event: { kind: 'user_message', time: 1_700_000_000_000, text: 'must survive upgrade skew' } }
      ]
    });

    expect(result).toMatchObject({ ok: true, pending: 1, durable: true });
    expect(journalOf(session)).toEqual([
      expect.objectContaining({
        conversationId,
        event: expect.objectContaining({ kind: 'user_message', text: 'must survive upgrade skew' })
      })
    ]);
    expect(JSON.stringify(journalOf(session))).not.toContain('rejected by the local bridge');
  });

  it('keeps one retry alarm while durable work remains instead of resetting it on every failure', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let healthy = false;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/events') return healthy ? response(200, { ok: true }) : response(503, { error: 'retry' });
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const conversationId = '12121212-3434-5656-7878-909090909090';
    const event = (text: string) => ({ conversationId, event: { kind: 'progress', time: 1, text } });

    await worker.send({ type: 'events', conversationId, entries: [event('first')] });
    await worker.send({ type: 'events', conversationId, entries: [event('second')] });
    expect(worker.alarmCreate).toHaveBeenCalledTimes(1);
    expect(worker.alarmCreate).toHaveBeenCalledWith('clf-bridge-drain', { delayInMinutes: 0.25, periodInMinutes: 1 });
    expect(journalOf(session)).toHaveLength(2);

    healthy = true;
    await worker.send({ type: 'events', conversationId, entries: [event('third')] });
    expect(journalOf(session)).toEqual([]);
    expect(worker.alarmClear).toHaveBeenCalledWith('clf-bridge-drain');
  });

  it('durably retries a lost command ACK after the service worker restarts', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const firstFetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/ack') return response(503, { error: 'temporarily_unavailable' });
      return response(404, {});
    });
    const first = loadWorker({ local, session, fetch: firstFetch });
    const conversationId = '22222222-3333-4444-5555-666666666666';

    const attempted = await first.send({
      type: 'ack',
      id: 'resume-retry',
      status: 'sent',
      conversationId,
      client: 'page-one'
    });
    expect(attempted.ok).toBe(false);
    expect(session.data.commandAckOutbox).toMatchObject([
      { id: 'resume-retry', status: 'sent', conversationId, client: 'page-one' }
    ]);
    expect(session.data.settled ?? []).toEqual([]);

    const bodies: Array<Record<string, unknown>> = [];
    const secondFetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/ack') {
        bodies.push(JSON.parse(String(init.body)));
        return response(200, { ok: true, committed: true });
      }
      return response(404, {});
    });
    const restarted = loadWorker({ local, session, fetch: secondFetch });
    await restarted.send({ type: 'status' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(bodies).toEqual([
      { id: 'resume-retry', status: 'sent', conversationId, client: 'page-one' }
    ]);
    expect(session.data.commandAckOutbox).toEqual([]);
    expect(session.data.settled).toEqual(['resume-retry']);
  });

  it('keeps a fresh command page journal behind its pending ACK after the route gets an id', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let ackHealthy = false;
    const postedEvents: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/commands/ack') {
        return ackHealthy ? response(200, { ok: true, committed: true }) : response(503, { error: 'retry' });
      }
      if (url.pathname === '/events') {
        postedEvents.push(JSON.parse(String(init.body)));
        return response(200, { sessionId: 'session', stored: 1 });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const tabId = 42;
    const documentId = 'command-document';
    const conversationId = '33333333-4444-5555-6666-777777777777';
    await worker.registerTab(tabId, documentId);

    await worker.send(
      { type: 'ack', id: 'cmd-gate', status: 'sent', client: 'command-page' },
      tabId,
      documentId
    );
    expect(session.data.commandAckOutbox).toMatchObject([
      { id: 'cmd-gate', conversationId: undefined, provisional: `tab-${tabId}:${documentId}` }
    ]);

    // The command result and its id-less observations may both survive a real fresh-chat
    // reload. They must migrate to the replacement document together or the later /c/<id>
    // bind would gate only the journal and let it overtake the still-pending command ACK.
    await worker.navigateTab(tabId, 'https://chatgpt.com/');
    const replacementDocument = `document-${tabId}-1`;
    expect(session.data.commandAckOutbox).toMatchObject([
      { id: 'cmd-gate', conversationId: undefined, provisional: `tab-${tabId}:${replacementDocument}` }
    ]);

    await worker.send(
      {
        type: 'events',
        conversationId,
        entries: [{ conversationId, event: { kind: 'user_message', time: 10, text: 'command bootstrap' } }]
      },
      tabId,
      replacementDocument
    );
    expect(postedEvents).toEqual([]);
    expect(session.data.commandAckOutbox).toMatchObject([{ id: 'cmd-gate', conversationId }]);
    expect(journalOf(session)).toHaveLength(1);

    ackHealthy = true;
    await worker.send({ type: 'status' }, tabId, replacementDocument);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(postedEvents).toEqual([
      { conversationId, events: [expect.objectContaining({ kind: 'user_message', text: 'command bootstrap' })] }
    ]);
    expect(session.data.commandAckOutbox).toEqual([]);
    expect(journalOf(session)).toEqual([]);
  });

  it('keeps pre-conversation observations across page/service-worker reload and binds them when /c/<id> exists', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const first = loadWorker({ local, session });
    await first.send(
      {
        type: 'events',
        entries: [
          {
            conversationId: null,
            agent: null,
            event: { kind: 'user_message', time: Date.now(), text: 'opening requirement' }
          }
        ]
      },
      42
    );

    expect(journalOf(session)).toMatchObject([
      {
        conversationId: null,
        provisional: 'tab-42:document-42-0',
        event: { kind: 'user_message', text: 'opening requirement' }
      }
    ]);

    // Same Chrome tab after the page and service worker have both been recreated.
    const reloaded = loadWorker({ local, session });
    const bound = await reloaded.send(
      { type: 'bind', conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
      42
    );
    expect(bound).toMatchObject({ ok: true, bound: 1 });
    expect(journalOf(session)).toMatchObject([
      {
        conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        provisional: null,
        event: { kind: 'user_message', text: 'opening requirement' }
      }
    ]);
  });

  it('keeps a fresh chat provisional journal through a real ChatGPT page reload', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    await worker.send(
      {
        type: 'events',
        entries: [{ conversationId: null, event: { kind: 'user_message', time: Date.now(), text: 'fresh prompt' } }]
      },
      42
    );
    expect(journalOf(session)[0]).toMatchObject({ provisional: 'tab-42:document-42-0', conversationId: null });

    await worker.navigateTab(42, 'https://chatgpt.com/');
    expect(journalOf(session)[0]).toMatchObject({ provisional: 'tab-42:document-42-1', conversationId: null });

    const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const bound = await worker.send({ type: 'bind', conversationId }, 42);
    expect(bound).toMatchObject({ ok: true, bound: 1 });
    expect(journalOf(session)[0]).toMatchObject({ provisional: null, conversationId });
  });

  it('does not lose an observation when two tabs wake a cold service worker at once', async () => {
    // Chrome shuts the worker down after seconds of idling, so two tabs reporting at the
    // same moment after that is ordinary, not exotic. Both handlers used to walk the cold
    // load path concurrently, and the second one assigned the journal it had read — before
    // the first one's write — straight over the global, discarding an entry the first tab
    // had already been told was durable.
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    local.lagMs = 40;
    session.lagMs = 40;
    const worker = loadWorker({ local, session });
    const conversationId = '11111111-2222-3333-4444-555555555555';

    // Tab one starts the cold load. Tab two arrives while that load is still in flight, so
    // its own reads are issued before tab one's journal write and answered after it.
    const first = worker.send(
      { type: 'events', entries: [{ conversationId, event: { kind: 'user_message', time: 1, text: 'from tab one' } }] },
      1
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = worker.send(
      { type: 'events', entries: [{ conversationId, event: { kind: 'user_message', time: 2, text: 'from tab two' } }] },
      2
    );
    const answers = await Promise.all([first, second]);

    for (const answer of answers) expect(answer).toMatchObject({ ok: true, durable: true });
    expect(journalOf(session).map((entry) => entry.event.text)).toEqual(['from tab one', 'from tab two']);
  });

  it('serializes durable journal snapshots so an older slow write cannot erase a newer event', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    session.setDelays = [60, 0];
    const worker = loadWorker({ local, session });

    const first = worker.send(
      { type: 'events', entries: [{ conversationId: null, event: { kind: 'user_message', time: 1, text: 'A' } }] },
      1
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = worker.send(
      { type: 'events', entries: [{ conversationId: null, event: { kind: 'user_message', time: 2, text: 'B' } }] },
      2
    );
    const replies = await Promise.all([first, second]);

    for (const reply of replies) expect(reply).toMatchObject({ ok: true, durable: true });
    expect(journalOf(session).map((entry) => entry.event.text)).toEqual(['A', 'B']);
  });

  it('serializes live tab snapshots so a slow older write cannot forget a newer tab owner', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    session.setDelays = [60, 0];
    const worker = loadWorker({ local, session });
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    const first = worker.send({ type: 'activity', conversationId: a, since: 0 }, 10);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = worker.send({ type: 'activity', conversationId: b, since: 0 }, 11);
    await Promise.all([first, second]);

    expect(session.data.tabConversations).toEqual({ '10': a, '11': b });
  });

  it('drains each conversation separately so navigation cannot file chat A observations into chat B', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const posted: Array<{ conversationId: string; events: Array<{ text?: string }> }> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/events') {
        posted.push(JSON.parse(String(init.body)));
        return response(200, { sessionId: 'session', stored: 1 });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    await worker.send({
      type: 'events',
      entries: [
        { conversationId: a, event: { kind: 'progress', time: Date.now(), text: 'A1' } },
        { conversationId: b, event: { kind: 'progress', time: Date.now(), text: 'B1' } },
        { conversationId: a, event: { kind: 'progress', time: Date.now(), text: 'A2' } }
      ]
    });

    expect(posted).toEqual([
      { conversationId: a, events: [{ kind: 'progress', time: expect.any(Number), text: 'A1' }, { kind: 'progress', time: expect.any(Number), text: 'A2' }] },
      { conversationId: b, events: [{ kind: 'progress', time: expect.any(Number), text: 'B1' }] }
    ]);
    expect(journalOf(session)).toEqual([]);
  });

  it('delivers the triggering conversation journal before asking the app for a Goal draft', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let acceptEvents = false;
    const order: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/events') {
        order.push('/events');
        return acceptEvents
          ? response(200, { sessionId: 'session', stored: 1 })
          : response(503, { error: 'temporarily_unavailable' });
      }
      if (url.pathname === '/goal/draft') {
        order.push('/goal/draft');
        return response(200, { goal: { stage: 'drafting' } });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    // The page handed the final assistant row to the service worker, but the app was briefly
    // unavailable, so the row is durable only in the worker journal when Goal asks for its
    // continuation. Drafting before retrying /events would omit the very answer that triggered
    // the Goal turn from conversationMessages().
    await worker.send(
      {
        type: 'events',
        conversationId,
        entries: [
          {
            conversationId,
            event: {
              kind: 'assistant_message',
              time: Date.now(),
              text: 'the answer Goal must continue from',
              messageId: 'assistant-final',
              final: true,
              state: 'final'
            }
          }
        ]
      },
      61
    );
    expect(journalOf(session)).toHaveLength(1);

    order.length = 0;
    acceptEvents = true;
    const drafted = await worker.send(
      { type: 'goal_draft', conversationId, turnId: 'generation-final' },
      61
    );

    expect(drafted).toMatchObject({ ok: true });
    expect(order).toEqual(['/events', '/goal/draft']);
    expect(journalOf(session)).toEqual([]);
  });

  it('carries the browser tab identity through Goal activity, draft and acknowledgement', async () => {
    const conversationId = '22222222-3333-4444-5555-666666666666';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const seen: Array<{ route: string; client: string | null }> = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/activity') {
        seen.push({ route: url.pathname, client: url.searchParams.get('goalClient') });
        return response(200, { sessionId: 'session', entries: [], stream: [], nextSince: 0 });
      }
      if (url.pathname === '/goal/draft' || url.pathname === '/goal/ack') {
        const body = JSON.parse(String(init.body || '{}'));
        seen.push({ route: url.pathname, client: typeof body.clientId === 'string' ? body.clientId : null });
        return response(200, url.pathname.endsWith('/draft') ? { goal: { stage: 'drafting' } } : { acknowledged: true });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    await worker.send({ type: 'activity', conversationId, since: 0 }, 73);
    await worker.send({ type: 'goal_draft', conversationId, turnId: 'generation-owned' }, 73);
    await worker.send({ type: 'goal_ack', conversationId, token: 'goal-token' }, 73);

    expect(seen).toEqual([
      { route: '/activity', client: '73' },
      { route: '/goal/draft', client: '73' },
      { route: '/goal/ack', client: '73' }
    ]);
  });

  it('raises only the exact owned Goal tab and never opens a duplicate', async () => {
    const conversationId = '22222222-3333-4444-5555-666666666666';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });

    await worker.registerTab(73);
    await worker.send({ type: 'bind', conversationId }, 73);

    expect(await worker.send({ type: 'goal_focus', conversationId, turnId: 'generation-owned' }, 73)).toMatchObject({
      ok: true,
      focused: true
    });
    expect(worker.tabsUpdate).toHaveBeenCalledTimes(1);
    expect(worker.tabsUpdate).toHaveBeenCalledWith(73, { active: true });
    expect(worker.windowsUpdate).toHaveBeenCalledTimes(1);
    expect(worker.windowsUpdate).toHaveBeenCalledWith(7, { focused: true });
    expect(worker.tabsCreate).not.toHaveBeenCalled();

    const other = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    expect(await worker.send({ type: 'goal_focus', conversationId: other, turnId: 'wrong-chat' }, 73)).toMatchObject({
      ok: false,
      error: 'stale_conversation'
    });
    expect(worker.tabsUpdate).toHaveBeenCalledTimes(1);
    expect(worker.windowsUpdate).toHaveBeenCalledTimes(1);
    expect(worker.tabsCreate).not.toHaveBeenCalled();
  });

  it('refuses a Goal draft while the triggering transcript is still not deliverable', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    let drafts = 0;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/events') return response(503, { error: 'temporarily_unavailable' });
      if (url.pathname === '/goal/draft') {
        drafts += 1;
        return response(200, { goal: { stage: 'drafting' } });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });

    await worker.send(
      {
        type: 'events',
        conversationId,
        entries: [
          {
            conversationId,
            event: {
              kind: 'assistant_message',
              time: Date.now(),
              text: 'still only in the browser journal',
              messageId: 'assistant-undelivered',
              final: true,
              state: 'final'
            }
          }
        ]
      },
      62
    );
    expect(journalOf(session)).toHaveLength(1);

    const drafted = await worker.send(
      { type: 'goal_draft', conversationId, turnId: 'generation-undelivered' },
      62
    );

    expect(drafted).toMatchObject({
      ok: false,
      status: 503,
      error: 'transcript_not_delivered',
      retryable: true
    });
    expect(drafts).toBe(0);
    expect(journalOf(session)).toHaveLength(1);
  });

  it('closes a conversation only when its final browser tab is actually gone', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const closed: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/events') return response(200, { sessionId: 'session', stored: 1 });
      if (url.pathname === '/closed') {
        closed.push(JSON.parse(String(init.body)).conversationId);
        return response(200, { ok: true });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const conversationId = '11111111-2222-3333-4444-555555555555';

    for (const tabId of [10, 11]) {
      await worker.send(
        {
          type: 'events',
          conversationId,
          entries: [{ conversationId, event: { kind: 'progress', time: Date.now(), text: `tab ${tabId}` } }]
        },
        tabId
      );
    }

    await worker.closeTab(10);
    expect(closed).toEqual([]);
    await worker.closeTab(11);
    expect(closed).toEqual([conversationId]);
  });

  it('closes a conversation when its tab survives but navigates away from ChatGPT', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const closed: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/events') return response(200, { sessionId: 'session', stored: 1 });
      if (url.pathname === '/closed') {
        closed.push(JSON.parse(String(init.body)).conversationId);
        return response(200, { ok: true });
      }
      return response(404, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const conversationId = '11111111-2222-3333-4444-555555555555';

    await worker.send(
      {
        type: 'events',
        conversationId,
        entries: [{ conversationId, event: { kind: 'progress', time: Date.now(), text: 'still here' } }]
      },
      12
    );
    await worker.navigateTab(12, 'https://example.com/elsewhere');

    expect(closed).toEqual([conversationId]);
    expect(session.data.tabConversations).toEqual({});
  });

  it('lets terminal navigation beat a delayed message from the dying document', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea({ tabConversations: { '12': conversationId } });
    // Force both handlers through the same cold-worker load window. The browser event is
    // delivered first; stale content IPC arrives while storage is still resolving.
    session.lagMs = 40;
    const closed: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/closed') {
        closed.push(JSON.parse(String(init.body)).conversationId);
        return response(200, { ok: true });
      }
      if (url.pathname === '/activity') return response(200, { sessionId: 'should-not-be-called', stream: [] });
      return response(200, {});
    });
    const worker = loadWorker({ local, session, fetch });

    const leaving = worker.navigateTab(12, 'https://example.com/elsewhere');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stale = await worker.send({ type: 'activity', conversationId, since: 0 }, 12);
    await leaving;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(stale).toMatchObject({ ok: false, error: 'tab_closed' });
    expect(closed).toEqual([conversationId]);
    expect(session.data.tabConversations).toEqual({});
    expect(fetch.mock.calls.some(([input]) => new URL(String(input)).pathname === '/activity')).toBe(false);
  });

  it('rejects the old document after an external round trip and lets only the new document own the tab', async () => {
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const closed: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/closed') {
        closed.push(JSON.parse(String(init.body)).conversationId);
        return response(200, { ok: true });
      }
      if (url.pathname === '/activity') return response(200, { sessionId: 'session', stream: [] });
      return response(200, {});
    });
    const worker = loadWorker({ local, session, fetch });
    const oldDocument = 'document-12-0';

    await worker.send({ type: 'bind', conversationId: a }, 12, oldDocument);
    await worker.navigateTab(12, 'https://example.com/away');
    await worker.navigateTab(12, `https://chatgpt.com/c/${b}`);

    expect(await worker.send({ type: 'activity', conversationId: a, since: 0 }, 12, oldDocument)).toMatchObject({
      ok: false,
      error: 'stale_document'
    });
    expect(await worker.send({ type: 'bind', conversationId: b }, 12)).toMatchObject({ ok: true });
    expect(session.data.tabConversations).toEqual({ '12': b });
    expect(closed).toEqual([a]);
  });

  it('tombstones a direct ChatGPT document navigation before the replacement document registers', async () => {
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      calls.push(url.pathname);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/activity') return response(200, { sessionId: 'session', stream: [] });
      return response(200, { ok: true });
    });
    const worker = loadWorker({ local, session, fetch });
    const oldDocument = 'document-19-0';

    await worker.send(
      {
        type: 'events',
        conversationId: null,
        entries: [{ conversationId: null, event: { kind: 'user_message', time: 1, text: 'belongs only to A' } }]
      },
      19,
      oldDocument
    );
    await worker.send({ type: 'bind', conversationId: a }, 19, oldDocument);

    const navigating = worker.navigateTab(19, `https://chatgpt.com/c/${b}`);
    const dying = await worker.send({ type: 'activity', conversationId: a, since: 0 }, 19, oldDocument);
    await navigating;

    expect(dying).toMatchObject({ ok: false, error: 'tab_closed' });
    expect(calls).not.toContain('/activity');
    expect(await worker.send({ type: 'bind', conversationId: b }, 19)).toMatchObject({ ok: true, bound: 0 });
    expect(journalOf(session)).toEqual([]);
    expect(session.data.tabConversations).toEqual({ '19': b });
    expect(calls).toContain('/closed');
  });

  it('does not let the dying document revoke its terminal lease while Chrome is still navigating', async () => {
    const a = '11111111-2222-3333-4444-555555555555';
    const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const calls: string[] = [];
    const target = `https://chatgpt.com/c/${b}`;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      calls.push(url.pathname);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/activity') return response(200, { sessionId: 'session', stream: [] });
      return response(200, { ok: true });
    });
    const worker = loadWorker({
      local,
      session,
      fetch,
      // During a real navigation Chrome can still deliver IPC from the old document while
      // tabs.get already describes the destination. That message is not evidence the
      // navigation was a false-positive terminal prediction.
      tabsGet: vi.fn(async (tabId) => ({ id: tabId, url: target, pendingUrl: target, status: 'loading' }))
    });
    const oldDocument = 'document-31-0';

    await worker.send({ type: 'bind', conversationId: a }, 31, oldDocument);
    const navigating = worker.navigateTab(31, target);
    const dying = await worker.send({ type: 'activity', conversationId: a, since: 0 }, 31, oldDocument);
    await navigating;

    expect(dying).toMatchObject({ ok: false, error: 'tab_closed' });
    expect(calls).not.toContain('/activity');
    expect(await worker.send({ type: 'bind', conversationId: b }, 31)).toMatchObject({ ok: true });
  });

  it('reopens a speculative terminal lease once Chrome proves the original document is settled', async () => {
    const a = '11111111-2222-3333-4444-555555555555';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      calls.push(url.pathname);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/activity') return response(200, { sessionId: 'session', stream: [] });
      return response(200, { ok: true });
    });
    const worker = loadWorker({
      local,
      session,
      fetch,
      tabsGet: vi.fn(async (tabId) => ({ id: tabId, url: `https://chatgpt.com/c/${a}`, status: 'complete' }))
    });
    const documentId = 'document-32-0';

    await worker.send({ type: 'bind', conversationId: a }, 32, documentId);
    // Chrome emitted a speculative loading transition but the navigation was cancelled or
    // otherwise never replaced this document. Once tabs.get reports the page settled again,
    // its next message is the evidence that should reopen the lease.
    await worker.startTabNavigation(32, `https://chatgpt.com/c/${a}`);
    const recovered = await worker.send({ type: 'activity', conversationId: a, since: 0 }, 32, documentId);

    expect(recovered).toMatchObject({ ok: true });
    expect(calls).toContain('/activity');
  });

  it('blocks the dying reload document without closing the same conversation', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const closed: string[] = [];
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/closed') closed.push(JSON.parse(String(init.body)).conversationId);
      return response(200, { ok: true });
    });
    const worker = loadWorker({ local, session, fetch });
    const oldDocument = 'document-27-0';

    await worker.send({ type: 'bind', conversationId }, 27, oldDocument);
    const reloading = worker.navigateTab(27, `https://chatgpt.com/c/${conversationId}`);
    const dying = await worker.send({ type: 'activity', conversationId, since: 0 }, 27, oldDocument);
    await reloading;
    expect(dying).toMatchObject({ ok: false, error: 'tab_closed' });

    expect(await worker.send({ type: 'bind', conversationId }, 27)).toMatchObject({ ok: true });
    expect(session.data.tabConversations).toEqual({ '27': conversationId });
    expect(closed).toEqual([]);
  });

  it('keeps a terminal document tombstone across service-worker restart', async () => {
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const oldDocument = 'document-44-old';
    const first = loadWorker({ local, session });
    await first.send({ type: 'bind', conversationId }, 44, oldDocument);
    await first.navigateTab(44, 'https://example.com/away');

    const restarted = loadWorker({ local, session });
    expect(
      await restarted.send({ type: 'compact', conversationId, resume: true }, 44, oldDocument)
    ).toMatchObject({ ok: false, error: 'tab_closed' });

    const newDocument = 'document-44-new';
    expect(await restarted.registerTab(44, newDocument)).toMatchObject({ ok: true });
    expect(await restarted.send({ type: 'bind', conversationId }, 44, newDocument)).toMatchObject({ ok: true });
  });

  it('does not bind an abandoned fresh chat into a later chat that reuses the tab', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });

    await worker.send(
      {
        type: 'events',
        entries: [{ conversationId: null, event: { kind: 'user_message', time: Date.now(), text: 'chat A opening' } }]
      },
      12
    );
    expect(journalOf(session)).toHaveLength(1);

    await worker.navigateTab(12, 'https://example.com/abandoned');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(journalOf(session)).toEqual([]);

    // A later real ChatGPT navigation is a new document and clears the terminal tombstone.
    await worker.navigateTab(12, 'https://chatgpt.com/');
    const bound = await worker.send({ type: 'bind', conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, 12);
    expect(bound).toMatchObject({ ok: true, bound: 0 });
    expect(journalOf(session)).toEqual([]);
  });

  it('stays inside the count budget and leaves an explicit gap when progress has to be discarded', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const entries = Array.from({ length: 4200 }, (_, index) => ({
      conversationId,
      event: { kind: 'progress', time: Date.now(), text: `progress ${index}` }
    }));

    await worker.send({ type: 'events', entries });
    const journal = journalOf(session);
    expect(journal.length).toBeLessThanOrEqual(4000);
    expect(journal.some((entry) => entry.gap === true && /progress line\(s\).*dropped/.test(entry.event.text))).toBe(true);
  });

  it('keeps queue-pressure gap evidence scoped to every affected chat and provisional route', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    const chatA = 'aaaaaaaa-1111-2222-3333-444444444444';
    const chatB = 'bbbbbbbb-1111-2222-3333-444444444444';
    const tabId = 42;
    const provisional = `tab-${tabId}:document-${tabId}-0`;
    const entries = Array.from({ length: 4200 }, (_, index) => ({
      conversationId: index % 3 === 0 ? chatA : index % 3 === 1 ? chatB : null,
      event: { kind: 'progress', time: Date.now(), text: `progress ${index}` }
    }));

    await worker.send({ type: 'events', entries }, tabId);
    let journal = journalOf(session);
    const gaps = journal.filter((entry) => entry.gap === true);
    expect(gaps.some((entry) => entry.conversationId === chatA && /progress line\(s\).*dropped/.test(entry.event.text))).toBe(true);
    expect(gaps.some((entry) => entry.conversationId === chatB && /progress line\(s\).*dropped/.test(entry.event.text))).toBe(true);
    expect(gaps.some((entry) => entry.conversationId === null && entry.provisional === provisional)).toBe(true);

    const freshChat = 'cccccccc-1111-2222-3333-444444444444';
    await worker.send({ type: 'bind', conversationId: freshChat }, tabId);
    journal = journalOf(session);
    expect(journal.some((entry) => entry.gap === true && entry.conversationId === freshChat && entry.provisional === null)).toBe(true);
    expect(journal.some((entry) => entry.gap === true && entry.conversationId === null && entry.provisional === provisional)).toBe(false);
  });

  it('keeps essential-loss markers scoped to each affected conversation', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    const chatA = 'dddddddd-1111-2222-3333-444444444444';
    const chatB = 'eeeeeeee-1111-2222-3333-444444444444';
    const entries = Array.from({ length: 4200 }, (_, index) => ({
      conversationId: index % 2 === 0 ? chatA : chatB,
      event: { kind: 'user_message', time: Date.now(), text: `essential ${index}` }
    }));

    await worker.send({ type: 'events', entries });
    const gaps = journalOf(session).filter((entry) => entry.gap === true && entry.event.kind === 'chat_error');
    expect(gaps.some((entry) => entry.conversationId === chatA && /observation\(s\).*lost/.test(entry.event.text))).toBe(true);
    expect(gaps.some((entry) => entry.conversationId === chatB && /observation\(s\).*lost/.test(entry.event.text))).toBe(true);
  });

  it('stays inside the journal byte budget under large observations', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    const conversationId = '99999999-8888-7777-6666-555555555555';
    // Four UTF-8 bytes but only two UTF-16 code units each. The old string-length budget
    // undercounted this journal by half and could acknowledge more than Chrome could store.
    const blob = '🧠'.repeat(2500);
    const entries = Array.from({ length: 1200 }, (_, index) => ({
      conversationId,
      event: { kind: 'progress', time: Date.now(), text: `${index}:${blob}` }
    }));

    await worker.send({ type: 'events', entries });
    const journal = journalOf(session);
    expect(Buffer.byteLength(JSON.stringify(journal), 'utf8')).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(journal.some((entry) => entry.gap === true)).toBe(true);
  });

  it('replaces a single unhalvable 413 observation with an explicit durable gap', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const session = new FakeStorageArea();
    const received: any[] = [];
    let rejected = false;
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/events') {
        const body = JSON.parse(String(init.body));
        if (!rejected) {
          rejected = true;
          return response(413, { error: 'body_too_large' });
        }
        received.push(...body.events);
        return response(200, { ok: true });
      }
      return response(200, {});
    });
    const worker = loadWorker({ local, session, fetch });

    await worker.send({
      type: 'events',
      conversationId: '11111111-2222-3333-4444-555555555555',
      entries: [{
        conversationId: '11111111-2222-3333-4444-555555555555',
        event: { kind: 'assistant_message', time: 1, text: 'x'.repeat(600_000) }
      }]
    });

    expect(journalOf(session)).toEqual([]);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ kind: 'chat_error' });
    expect(received[0].text).toMatch(/too large.*explicit gap/i);
  });

  it('tightens and retries when Chrome rejects a session-storage write', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    // Below the journal's normal 4 MiB target but above its tightened 3 MiB target,
    // purely to force the "write rejected → compact harder → retry" path.
    session.maxBytes = 3_500_000;
    const worker = loadWorker({ local, session });
    const conversationId = 'abababab-cdcd-efef-1212-343434343434';
    const entries = Array.from({ length: 3200 }, (_, index) => ({
      conversationId,
      event: { kind: 'progress', time: Date.now(), text: `${index}:${'y'.repeat(1500)}` }
    }));

    const reply = await worker.send({ type: 'events', entries });
    expect(reply.durable).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(session.data), 'utf8')).toBeLessThanOrEqual(3_500_000);
  });
});

// ---------------------------------------------------------------- connecting

/**
 * How this browser gets, keeps and gives up a credential.
 *
 * All three of these were the same shape of bug: a decision taken once being quietly
 * retaken a couple of seconds later by a poll that runs in every open tab.
 */
describe('extension connection', () => {
  /** Records every request the worker makes, and answers them the way the app would. */
  function app(): {
    calls: string[];
    fetch: (input: string, init?: Record<string, unknown>) => Promise<any>;
    tokens: number;
  } {
    const state = {
      calls: [] as string[],
      tokens: 0,
      async fetch(input: string) {
        state.calls.push(input);
        if (input.endsWith('/hello')) return response(200, { app: 'chat-on-steroids', paired: true });
        if (input.endsWith('/pair')) {
          state.tokens++;
          return response(200, { token: `token-${state.tokens}` });
        }
        return response(200, {});
      }
    };
    return state;
  }

  /**
   * `/pair` mints a fresh credential and invalidates the one before it, so two callers
   * arriving together do not get two tokens — they get one working token and one that
   * has already been revoked, and then each 401 provisions again.
   */
  it('mints one token however many callers ask at once', async () => {
    const server = app();
    const worker = loadWorker({ local: new FakeStorageArea(), session: new FakeStorageArea(), fetch: server.fetch });

    await Promise.all([
      worker.send({ type: 'status' }),
      worker.send({ type: 'status' }),
      worker.send({ type: 'status' }),
      worker.send({ type: 'status' })
    ]);
    expect(server.tokens).toBe(1);
  });

  /**
   * A `/hello` in front of every authenticated request doubled the traffic of a poll that
   * already runs every two seconds in every open tab, against a 900/min budget.
   */
  it('forwards an exact live request ownership handshake and returns the app read-back', async () => {
    const conversationId = 'abababab-cdcd-efef-1212-343434343434';
    const requestId = '77186fb4-bdda-4849-8cd7-879bb08a1617';
    let body: any = null;
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/correlations') {
        body = JSON.parse(String(init.body));
        return response(200, {
          ok: true,
          conversationId,
          sessionId: '2026-08-21-live',
          requestIds: [requestId],
          confirmed: [requestId],
          complete: true
        });
      }
      return response(404, {});
    });
    const worker = loadWorker({
      local: new FakeStorageArea({ port: 8765, token: 'paired-token' }),
      session: new FakeStorageArea(),
      fetch
    });

    const reply = await worker.send({
      type: 'correlate',
      conversationId,
      calls: [{ messageId: 'request-message', tool: 'exec_command', order: 0, answered: false, requestId }]
    });

    expect(body).toMatchObject({
      conversationId,
      calls: [expect.objectContaining({ requestId, messageId: 'request-message' })]
    });
    expect(reply).toMatchObject({
      ok: true,
      status: 200,
      data: { conversationId, confirmed: [requestId], complete: true }
    });
  });

  it('does not re-ask where the app is before every single request', async () => {
    const server = app();
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch: server.fetch });

    for (let n = 0; n < 5; n++) {
      await worker.send({ type: 'activity', conversationId: 'abababab-cdcd-efef-1212-343434343434', since: 0 });
    }
    const hellos = server.calls.filter((url) => url.endsWith('/hello'));
    expect(hellos.length).toBeLessThanOrEqual(1);
    expect(server.calls.filter((url) => url.includes('/activity'))).toHaveLength(5);
  });

  it('stays disconnected once it has been disconnected', async () => {
    const server = app();
    const local = new FakeStorageArea();
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch: server.fetch });

    await worker.send({ type: 'status' });
    expect(server.tokens).toBe(1);

    await worker.send({ type: 'unpair' });
    expect(local.data.disconnected).toBe(true);

    // The two things that used to undo it: the next poll from a tab, and opening the
    // popup to check. Neither is a request to connect.
    const activity = await worker.send({
      type: 'activity',
      conversationId: 'abababab-cdcd-efef-1212-343434343434',
      since: 0
    });
    expect(activity.ok).toBe(false);
    expect(activity.error).toBe('disconnected');
    const status = await worker.send({ type: 'status' });
    expect(status.paired).toBe(false);
    expect(status.disconnected).toBe(true);
    expect(server.tokens).toBe(1);
  });

  it('does not silently re-pair after the app explicitly disconnects this browser', async () => {
    let pairCalls = 0;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: true });
      if (url.pathname === '/pair') {
        pairCalls++;
        return response(200, { token: 'should-never-be-minted' });
      }
      if (url.pathname === '/activity') return response(401, { error: 'browser_disconnected' });
      return response(404, {});
    });
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });

    const activity = await worker.send({
      type: 'activity',
      conversationId: 'abababab-cdcd-efef-1212-343434343434',
      since: 0
    });

    expect(activity).toMatchObject({ ok: false, status: 401, error: 'disconnected' });
    expect(local.data.token).toBeNull();
    expect(local.data.disconnected).toBe(true);
    expect(pairCalls).toBe(0);

    // Opening the popup after the failed poll is observation, not reconnect intent.
    expect(await worker.send({ type: 'status' })).toMatchObject({ paired: false, disconnected: true });
    expect(pairCalls).toBe(0);
  });

  it('mirrors an app-side disconnect from hello before the popup can report a stale pair', async () => {
    let pairCalls = 0;
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') {
        return response(200, { app: 'chat-on-steroids', paired: false, disconnected: true });
      }
      if (url.pathname === '/pair') {
        pairCalls++;
        return response(200, { token: 'must-not-auto-pair' });
      }
      return response(404, {});
    });
    const local = new FakeStorageArea({ port: 8765, token: 'old-token' });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });

    expect(await worker.send({ type: 'status' })).toMatchObject({
      connected: true,
      paired: false,
      disconnected: true
    });
    expect(local.data.token).toBeNull();
    expect(local.data.disconnected).toBe(true);
    expect(pairCalls).toBe(0);
  });

  it('does not let an older in-flight connect undo a later Disconnect', async () => {
    let releasePair!: () => void;
    let pairStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      pairStarted = resolve;
    });
    const pairGate = new Promise<void>((resolve) => {
      releasePair = resolve;
    });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/hello') return response(200, { app: 'chat-on-steroids', paired: false });
      if (url.pathname === '/pair') {
        pairStarted();
        await pairGate;
        return response(200, { token: 'late-token' });
      }
      return response(200, {});
    });
    const local = new FakeStorageArea();
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });

    // Status auto-connects a never-paired browser. Disconnect wins when the user clicks it
    // after that request has already left, even if the old /pair answer arrives afterwards.
    const connecting = worker.send({ type: 'status' });
    await started;
    expect(await worker.send({ type: 'unpair' })).toMatchObject({ ok: true });
    expect(local.data.disconnected).toBe(true);
    releasePair();
    await connecting;

    expect(local.data.token).toBeNull();
    expect(local.data.disconnected).toBe(true);
    expect(await worker.send({ type: 'status' })).toMatchObject({ paired: false, disconnected: true });
  });

  /** Persisted in `local`, not `session`: a choice a restart undoes is not a choice. */
  it('is still disconnected after the worker has been shut down and restarted', async () => {
    const server = app();
    const local = new FakeStorageArea();
    const first = loadWorker({ local, session: new FakeStorageArea(), fetch: server.fetch });
    await first.send({ type: 'status' });
    await first.send({ type: 'unpair' });

    const second = loadWorker({ local, session: new FakeStorageArea(), fetch: server.fetch });
    expect((await second.send({ type: 'status' })).disconnected).toBe(true);
    expect(server.tokens).toBe(1);
  });

  it('connects again when the user asks it to, and only then', async () => {
    const pairBodies: unknown[] = [];
    const server = app();
    const fetch = vi.fn(async (input: string, init: Record<string, unknown> = {}) => {
      if (input.endsWith('/pair')) pairBodies.push(JSON.parse(String(init.body ?? '{}')));
      return server.fetch(input, init);
    });
    const local = new FakeStorageArea();
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch });
    await worker.send({ type: 'status' });
    await worker.send({ type: 'unpair' });

    expect(await worker.send({ type: 'pair' })).toMatchObject({ ok: true });
    const status = await worker.send({ type: 'status' });
    expect(status.paired).toBe(true);
    expect(status.disconnected).toBe(false);
    expect(local.data.disconnected).toBe(false);
    expect(pairBodies).toEqual([{}, { reconnect: true }]);
  });

  it('forces an immediate overwrite in known and newly discovered ChatGPT tabs', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired-token' });
    const worker = loadWorker({ local, session: new FakeStorageArea(), fetch: app().fetch });
    await worker.send({ type: 'bind', conversationId: '11111111-2222-3333-4444-555555555555' }, 11);
    await worker.send({ type: 'bind', conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, 12);
    worker.tabsQuery.mockResolvedValueOnce([{ id: 12 }, { id: 13 }]);

    const result = await worker.send({ type: 'overwriteNow' });

    expect(result).toMatchObject({ ok: true, tabs: 3, attempted: 3 });
    expect(worker.tabsSendMessage).toHaveBeenCalledTimes(3);
    expect(worker.tabsSendMessage).toHaveBeenCalledWith(11, { type: 'clf-overwrite-now' });
    expect(worker.tabsSendMessage).toHaveBeenCalledWith(12, { type: 'clf-overwrite-now' });
    expect(worker.tabsSendMessage).toHaveBeenCalledWith(13, { type: 'clf-overwrite-now' });
  });
});

/**
 * A CSS `animation` naming keyframes nobody wrote is not an error. The declaration parses,
 * the name resolves to nothing, and the element simply appears — which is how the settings
 * menu and the hover bubble both shipped with `clf-pop-in` on them and no fade at all,
 * beside a page whose own popovers fade. Nothing in the browser will ever say so, so this
 * asks the stylesheet the question instead: everything it animates, it defines.
 */
describe('the overlay stylesheet', () => {
  it('defines every animation it asks for', async () => {
    const css = await fs.readFile(path.join(process.cwd(), 'extension', 'overlay.css'), 'utf8');
    const defined = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1]!));
    // Every animation this stylesheet owns is namespaced, so the name is the one token in
    // the shorthand that starts with `clf-`; durations, easings and `none` are not.
    const used = new Set(
      [...css.matchAll(/^[ 	]*animation(?:-name)?[ 	]*:([^;]+);/gm)]
        .flatMap((match) => match[1]!.split(/[\s,]+/))
        .filter((token) => token.startsWith('clf-'))
    );

    expect(used.size, 'the stylesheet animates nothing — has the namespace changed?').toBeGreaterThan(0);
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });
});
