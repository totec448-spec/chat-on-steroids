/**
 * Shared setup for the renderer-state.*.test.ts files: the helpers that used to sit between the tests
 * of renderer-state.test.ts. The tests were split into parts so vitest can run them in parallel.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, vi } from 'vitest';
import { DEFAULT_GOAL_MODEL, DEFAULT_GOAL_SYSTEM_PROMPT } from '../src/shared/goal.js';
import { DEFAULT_HANDOFF_PROMPT } from '../src/shared/handoff.js';
import { BROWSER_READ_TOOLS, BROWSER_WRITE_TOOLS } from '../src/shared/browser-control.js';


/**
 * `vi.waitFor` with room for the slow release runners. Its default second ran out on the Intel
 * macOS publish runner while a freshly mounted renderer was still saving (2.1.42, 2.1.44 publish);
 * a condition that holds still returns at once.
 */
export const waitFor = <T>(check: () => T | Promise<T>, options: { timeout?: number; interval?: number } = {}) =>
  vi.waitFor(check, { timeout: 10_000, ...options });

/** jsdom has no modal dialogs: enough of showModal/close for the app's dialogs, close event included. */
export function installDialog(w: any): void {
  const proto = w.HTMLDialogElement.prototype;
  if (typeof proto.showModal !== 'function') proto.showModal = function (this: any) { this.open = true; };
  if (typeof proto.close !== 'function') proto.close = function (this: any) { if (!this.open) return; this.open = false; this.dispatchEvent(new w.Event('close')); };
}

/** A row's menu item: opens the row's "⋯" menu (it lives in the document body) and returns the item. */
export function rowMenuItem(row: Element, action: string): HTMLButtonElement | null {
  const doc = row.ownerDocument;
  closeRowMenus(doc);
  (row.querySelector('[data-row-menu]') as HTMLButtonElement).click();
  return doc.querySelector<HTMLButtonElement>(`.row-menu [data-row-action="${action}"]`);
}
/** Closes whatever row menu is open, as Escape does. */
export function closeRowMenus(doc: Document): void {
  doc.querySelector('.row-menu')?.dispatchEvent(new (doc.defaultView as any).KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

export let dom: JSDOM | null = null;
/** Keeps a window a test booted itself, so the shared cleanup closes it. */
export function setDom(next: JSDOM): JSDOM {
  dom = next;
  return next;
}
afterEach(() => {
  dom?.window.close();
  dom = null;
  vi.resetModules();
});

/**
 * The goal loop's settings panel.
 *
 * Three things are worth pinning here and the rest is layout: the key never travels with the
 * settings, the catalogue is only fetched when somebody asks for it, and an install with no
 * key says so in the words the extension says it in.
 */

export interface GoalMount {
  window: JSDOM['window'];
  calls: any[];
  keys: Array<{ method: string; value: string }>;
  modelPages: any[];
  push(state: any): void;
  state: any;
}

export async function mountChat(
  overrides: Record<string, unknown> = {},
  models: any[] = [],
  apiOverrides: Record<string, (...args: any[]) => any> = {},
  initialGoal: Record<string, unknown> = {}
): Promise<GoalMount> {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  installDialog(dom.window);
  const w = dom.window;
  w.HTMLElement.prototype.animate = vi.fn() as any;
  Object.assign(globalThis, { Event: w.Event });
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
    HTMLButtonElement: w.HTMLButtonElement
  });
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};

  const config = {
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    readOnly: false,
    capabilities: {
      browse: true, search: true, read: true, metadata: true,
      create: true, edit: true, move: true, deleteFile: true, command: true,
      screen: true, control: true, clipboardRead: true, clipboardWrite: true
    },
    commandAllowlist: { enabled: false, mode: 'allow' as const, rules: [] as string[] },
    tunnel: { kind: 'openai', tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light' as const },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000, handoffPrompt: DEFAULT_HANDOFF_PROMPT },
    multiAgent: { enabled: false, maxWorkers: 2, globalMaxWorkers: 0, allowUnattributedCalls: false, recoverAgentTabs: true },
    goal: {
      enabled: false,
      model: 'deepseek/deepseek-v4-flash',
      reasoning: 'default' as const,
      prompt: DEFAULT_GOAL_SYSTEM_PROMPT,
      ...initialGoal
    }
  };
  const state: any = {
    config,
    status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
    hasApiKey: false,
    hasGoalKey: false,
    resolvedBinary: null,
    bundledTunnelVersion: null,
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.0.2', latest: null, stage: 'idle', error: null, checkedAt: null },
    ...overrides
  };
  let listener: (next: any) => void = () => undefined;
  const calls: any[] = [];
  const keys: Array<{ method: string; value: string }> = [];
  const modelPages: any[] = [];
  const ok = (data: any) => Promise.resolve({ ok: true as const, data });
  const api: any = new Proxy(
    {
      getState: () => ok(state),
      getLog: () => ok([]),
      getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
      onStateChanged: (fn: any) => {
        listener = fn;
        return () => undefined;
      },
      onLogEntry: () => () => undefined,
      onSwarmChanged: () => () => undefined,
      onSessionChanged: () => () => undefined,
      listSessions: () => ok({ sessions: [], activeId: null, pressure: [] }),
      // Answers with the config it just stored, the way the real handler does. The panel
      // paints from the app's answer rather than from what it just clicked, so a fake that
      // replied with the old config would be testing a revert.
      saveSettings: (patch: any) => {
        calls.push(structuredClone(patch));
        state.config = { ...state.config, ...structuredClone(patch) };
        return ok(state);
      },
      setGoalKey: (value: string) => {
        keys.push({ method: 'setGoalKey', value });
        return ok({ ...state, hasGoalKey: value !== '' });
      },
      setApiKey: (value: string) => {
        keys.push({ method: 'setApiKey', value });
        return ok(state);
      },
      listGoalModels: (offset: number, query = '') => {
        const needle = query.trim().toLowerCase();
        const matches = needle
          ? models.filter(model => String(model.id).toLowerCase().includes(needle) || String(model.name).toLowerCase().includes(needle))
          : models;
        const page = { models: matches.slice(offset, offset + 20), total: matches.length, offset, query };
        modelPages.push(page);
        return ok(page);
      },
      ...apiOverrides
    },
    {
      get(target, prop) {
        if (prop in target) return (target as any)[prop];
        return (..._args: any[]) => ok(null);
      }
    }
  );
  Object.defineProperty(w, 'api', { value: api, configurable: true });
  await import('../src/renderer/main.js');
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { window: w, calls, keys, modelPages, state, push: (next) => listener(next) };
}

export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

export const projectSidebarFixture = () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Collapsed project', path: 'C:\\repo', createdAt: 1 };
  const session = { id: 'project-session', title: 'Project task', conversationId: 'chat-project', chatIds: ['chat-project'],
    startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastHandoffId: null, lastHandoffAt: null,
    lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null, projectId: project.id };
  return { project, session };
};

export const DAY = 24 * 60 * 60_000;
/** A recorded chat for the inbox, outside every project unless told otherwise. */
export const inboxChat = (id: string, extra: Record<string, unknown> = {}) => ({
  ...projectSidebarFixture().session, id, title: id, conversationId: `c-${id}`, chatIds: [`c-${id}`], projectId: null, ...extra
});
export const listed = (sessions: unknown[], extra: Record<string, unknown> = {}) =>
  ({ ok: true as const, data: { sessions, activeId: null, pressure: [], blocked: [], ...extra } });
/** Mounts the chat with the Inbox layout saved in Appearance. */
export async function mountInbox(apiOverrides: Record<string, (...args: any[]) => any>): Promise<GoalMount> {
  const mounted = await mountChat({}, [], apiOverrides);
  const { defaultAppearance } = await import('../src/shared/appearance.js');
  mounted.state.config = { ...mounted.state.config, ui: { ...mounted.state.config.ui, appearance: { ...defaultAppearance(), sidebarLayout: 'inbox' } } };
  mounted.push(structuredClone(mounted.state));
  await settle();
  return mounted;
}
export const inboxProjects = () => ({
  alpha: { id: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001', name: 'Alpha', path: 'C:\\alpha', createdAt: 1, color: 'teal' as const },
  beta: { id: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002', name: 'Bêta', path: 'C:\\beta', createdAt: 2 }
});

/** The inbox's cards, top to bottom, by session id. */
export const inboxCardIds = (doc: Document) => [...doc.querySelectorAll<HTMLElement>('.inbox-cards > .sess-card')].map(row => row.dataset.id);
/** One card's state on its meta line: its words, and the card itself for its title and accessible text. */
export const inboxCardState = (doc: Document, id: string) => {
  const card = doc.querySelector<HTMLElement>(`.inbox-cards > .sess-card[data-id="${id}"]`)!;
  return { card, state: card.querySelector<HTMLElement>('.sess-meta > .sess-state')!, top: card.querySelector<HTMLElement>(':scope > .sess-top')! };
};

/** Fake OpenRouter catalogue, already in the order the app is expected to keep. */
export const catalogue = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `vendor${index}/model-${index}`,
    name: `Model ${index}`,
    created: 1_800_000_000 - index * 86_400,
    contextLength: 128_000
  }));

export { fs, path, JSDOM, DEFAULT_GOAL_MODEL, DEFAULT_GOAL_SYSTEM_PROMPT, DEFAULT_HANDOFF_PROMPT, BROWSER_READ_TOOLS, BROWSER_WRITE_TOOLS };
