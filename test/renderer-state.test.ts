vi.mock('../src/renderer/workspace-terminal.js', () => ({ createWorkspaceTerminal: () => ({
  update: vi.fn(), show: vi.fn(), hide: vi.fn(), newTab: vi.fn(() => null),
  tabs: vi.fn(() => []), selectTab: vi.fn(), closeTab: vi.fn()
}) }));
// Native animation/media APIs are covered by pet DOM and real Electron tests.
vi.mock('../src/renderer/pet.js', () => ({ initPet: () => Object.assign(() => {}, { toggle: () => {}, isVisible: () => false }) }));
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_GOAL_MODEL, DEFAULT_GOAL_SYSTEM_PROMPT } from '../src/shared/goal.js';
import { DEFAULT_HANDOFF_PROMPT } from '../src/shared/handoff.js';
import { BROWSER_READ_TOOLS, BROWSER_WRITE_TOOLS } from '../src/shared/browser-control.js';

/** jsdom has no modal dialogs: enough of showModal/close for the app's dialogs, close event included. */
function installDialog(w: any): void {
  const proto = w.HTMLDialogElement.prototype;
  if (typeof proto.showModal !== 'function') proto.showModal = function (this: any) { this.open = true; };
  if (typeof proto.close !== 'function') proto.close = function (this: any) { if (!this.open) return; this.open = false; this.dispatchEvent(new w.Event('close')); };
}

/** A row's menu item: opens the row's "⋯" menu (it lives in the document body) and returns the item. */
function rowMenuItem(row: Element, action: string): HTMLButtonElement | null {
  const doc = row.ownerDocument;
  closeRowMenus(doc);
  (row.querySelector('.row-menu-button') as HTMLButtonElement).click();
  return doc.querySelector<HTMLButtonElement>(`.row-menu [data-row-action="${action}"]`);
}
/** Closes whatever row menu is open, as Escape does. */
function closeRowMenus(doc: Document): void {
  doc.querySelector('.row-menu')?.dispatchEvent(new (doc.defaultView as any).KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

let dom: JSDOM | null = null;
afterEach(() => {
  dom?.window.close();
  dom = null;
  vi.resetModules();
});

it('does not overwrite a focused dirty settings field on an unsolicited state push', async () => {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  installDialog(dom.window);
  const w = dom.window;
  w.HTMLElement.prototype.animate = vi.fn() as any;
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

  let stateListener: (state: any) => void = () => undefined;
  const baseConfig = {
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    readOnly: true,
    capabilities: {
      browse: true, search: true, read: true, metadata: true,
      create: false, edit: false, move: false, deleteFile: false, command: false,
      screen: false, control: false, clipboardRead: false, clipboardWrite: false
    },
    commandAllowlist: { enabled: false, mode: 'allow' as const, rules: [] as string[] },
    tunnel: { kind: 'openai', tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light' },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000, handoffPrompt: DEFAULT_HANDOFF_PROMPT },
    multiAgent: { enabled: false, maxWorkers: 2, globalMaxWorkers: 0, allowUnattributedCalls: false, recoverAgentTabs: true },
    goal: {
      enabled: false,
      model: 'deepseek/deepseek-v4-flash',
      reasoning: 'default' as const,
      prompt: DEFAULT_GOAL_SYSTEM_PROMPT
    }
  };
  const state = {
    config: baseConfig,
    status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
    hasApiKey: false,
    hasGoalKey: false,
    resolvedBinary: null,
    bundledTunnelVersion: null,
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.0.2', latest: null, stage: 'idle', error: null, checkedAt: null }
  };
  const ok = (data: any) => Promise.resolve({ ok: true, data });
  const api: any = new Proxy({
    getState: () => ok(state),
    getLog: () => ok([{ time: Date.UTC(2026, 9, 2, 15, 4, 5), level: 'info', message: 'usage overview sessions=1 rebuilt=1' }]),
    getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
    onStateChanged: (fn: any) => { stateListener = fn; return () => undefined; },
    onLogEntry: () => () => undefined,
    onSwarmChanged: () => () => undefined,
    onSessionChanged: () => () => undefined,
    listSessions: () => ok({ sessions: [], activeId: null, pressure: [] })
  }, { get(target, prop) { if (prop in target) return (target as any)[prop]; return (..._args: any[]) => ok(null); } });
  Object.defineProperty(w, 'api', { value: api, configurable: true });

  await import('../src/renderer/main.js');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const field = w.document.getElementById('tunnelId') as HTMLInputElement;
  expect(field.value).toBe(baseConfig.tunnel.tunnelId);
  field.focus();
  field.value = 'tunnel_USER_IS_STILL_TYPING';

  stateListener(structuredClone(state));

  expect(w.document.activeElement).toBe(field);
  expect(field.value).toBe('tunnel_USER_IS_STILL_TYPING');

  // Log lines already on screen follow a language change, not only the ones added after it.
  const clock = () => w.document.querySelector('#fullFeed time')!.textContent!;
  expect(clock()).toMatch(/AM|PM/);
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  expect(clock()).not.toMatch(/AM|PM/);
  setLanguage('en');

  const multiAgent = w.document.getElementById('homeMaEnabled') as HTMLInputElement;
  multiAgent.focus();
  multiAgent.checked = true;
  stateListener(structuredClone(state));
  expect(w.document.activeElement).toBe(multiAgent);
  expect(multiAgent.checked).toBe(true);

  const allowUnattributed = w.document.getElementById('allowUnattributedCalls') as HTMLInputElement;
  allowUnattributed.focus();
  allowUnattributed.checked = true;
  stateListener(structuredClone(state));
  expect(w.document.activeElement).toBe(allowUnattributed);
  expect(allowUnattributed.checked).toBe(true);

  // The settings sheet used to bypass the dirty-field guard used by Home. An unrelated
  // status push therefore erased this value while the user was still typing it.
  const compactionThreshold = w.document.getElementById('autoCompactTokens') as HTMLInputElement;
  compactionThreshold.focus();
  compactionThreshold.value = '355000';
  stateListener(structuredClone(state));
  expect(w.document.activeElement).toBe(compactionThreshold);
  expect(compactionThreshold.value).toBe('355000');

  compactionThreshold.blur();
  const updatedThreshold = structuredClone(state) as any;
  updatedThreshold.config.compaction.autoTokens = 320000;
  stateListener(updatedThreshold);
  expect(compactionThreshold.value).toBe('320000');

  // A value whose switch is off does nothing, so it must not look editable: the threshold
  // follows automatic compaction, and the notice lead follows Session finish.
  const finishLead = w.document.getElementById('finishLeadMinutes') as HTMLSelectElement;
  expect(compactionThreshold.disabled).toBe(false);
  expect(finishLead.disabled).toBe(true);
  const switchedOver = structuredClone(updatedThreshold) as any;
  switchedOver.config.compaction.auto = false;
  switchedOver.config.ui.finishTool = true;
  stateListener(switchedOver);
  expect(compactionThreshold.disabled).toBe(true);
  expect(finishLead.disabled).toBe(false);
  stateListener(structuredClone(updatedThreshold));
  expect(compactionThreshold.disabled).toBe(false);
  expect(finishLead.disabled).toBe(true);

  const goalPrompt = w.document.getElementById('goalPrompt') as HTMLTextAreaElement;
  goalPrompt.focus();
  goalPrompt.value = 'USER IS STILL EDITING THIS PROMPT';
  stateListener(structuredClone(state));
  expect(w.document.activeElement).toBe(goalPrompt);
  expect(goalPrompt.value).toBe('USER IS STILL EDITING THIS PROMPT');

  // The health card reports the live surface projection rather than a hand-maintained
  // denominator. Tool consolidation/additions should never leave the UI saying "of 9"
  // when nine is no longer the product's actual maximum.
  const withTools = structuredClone(state) as any;
  withTools.status.surfaces = [
    {
      id: 'core', connectorName: 'Core', description: '', cardSummary: '', optional: false,
      available: true, localUrl: null, publicUrl: null, tools: ['read', 'apply_patch'],
      state: 'off', detail: '', lastRequestAt: null, lastToolCallAt: null
    },
    {
      id: 'desktop', connectorName: 'Desktop', description: '', cardSummary: '', optional: true,
      available: true, localUrl: null, publicUrl: null, tools: ['observe'],
      state: 'off', detail: '', lastRequestAt: null, lastToolCallAt: null
    }
  ];
  stateListener(withTools);
  expect(w.document.getElementById('facts')!.textContent).toContain('Tools across Core + Desktop3 total');
  expect(w.document.getElementById('facts')!.textContent).not.toContain('of 9');

  const withMissingMacAccess = structuredClone(withTools) as any;
  withMissingMacAccess.platform = { family: 'macos', name: 'macOS', desktopAutomation: true };
  withMissingMacAccess.config.readOnly = false;
  withMissingMacAccess.config.capabilities.screen = true;
  withMissingMacAccess.config.capabilities.control = true;
  withMissingMacAccess.desktopAccess = {
    screen: 'granted',
    accessibility: 'missing',
    checkedAt: 1,
    error: null
  };
  stateListener(withMissingMacAccess);
  const accessWarning = w.document.getElementById('desktopAccess')!;
  expect(accessWarning.hidden).toBe(false);
  expect(accessWarning.textContent).toContain('Accessibility: missing');
  expect(accessWarning.textContent).toContain('live verdicts from the native backend');
  expect((w.document.getElementById('openDesktopScreen') as HTMLButtonElement).hidden).toBe(true);
  expect((w.document.getElementById('openDesktopAccessibility') as HTMLButtonElement).hidden).toBe(false);

  const withReadOnlyMacAccess = structuredClone(withMissingMacAccess) as any;
  withReadOnlyMacAccess.config.readOnly = true;
  stateListener(withReadOnlyMacAccess);
  expect(accessWarning.hidden).toBe(true);
});

it('serializes settings intent so rapid toggles and later UI changes cannot undo each other', async () => {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  installDialog(dom.window);
  const w = dom.window;
  w.HTMLElement.prototype.animate = vi.fn() as any;
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

  const baseConfig = {
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    readOnly: false,
    capabilities: {
      browse: true, search: true, read: true, metadata: true,
      create: true, edit: true, move: true, deleteFile: true, command: true,
      screen: true, control: true, clipboardRead: true, clipboardWrite: true
    },
    commandAllowlist: { enabled: false, mode: 'allow' as const, rules: [] as string[] },
    tunnel: { kind: 'openai', tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light' as 'light' | 'dark' },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000, handoffPrompt: DEFAULT_HANDOFF_PROMPT },
    multiAgent: { enabled: false, maxWorkers: 2, globalMaxWorkers: 0, allowUnattributedCalls: false, recoverAgentTabs: true },
    goal: {
      enabled: false,
      model: 'deepseek/deepseek-v4-flash',
      reasoning: 'default' as const,
      prompt: DEFAULT_GOAL_SYSTEM_PROMPT
    }
  };
  const appState = (config: typeof baseConfig) => ({
    config,
    status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
    hasApiKey: false,
    hasGoalKey: false,
    resolvedBinary: null,
    bundledTunnelVersion: null,
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.0.2', latest: null, stage: 'idle', error: null, checkedAt: null }
  });
  let current = appState(baseConfig);
  const calls: any[] = [];
  const pending: Array<(reply: any) => void> = [];
  const ok = (data: any) => Promise.resolve({ ok: true as const, data });
  const saveSettings = (patch: any) => {
    calls.push(structuredClone(patch));
    return new Promise<any>((resolve) => pending.push(resolve));
  };
  const api: any = new Proxy({
    getState: () => ok(current),
    getLog: () => ok([]),
    getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
    saveSettings,
    onStateChanged: () => () => undefined,
    onLogEntry: () => () => undefined,
    onSwarmChanged: () => () => undefined,
    onSessionChanged: () => () => undefined,
    listSessions: () => ok({ sessions: [], activeId: null, pressure: [] })
  }, { get(target, prop) { if (prop in target) return (target as any)[prop]; return (..._args: any[]) => ok(null); } });
  Object.defineProperty(w, 'api', { value: api, configurable: true });

  await import('../src/renderer/main.js');
  await new Promise((resolve) => setTimeout(resolve, 0));

  // First save toggles a value that has no form control of its own. Keep the IPC unresolved,
  // matching a real save that is waiting for bridge/tunnel lifecycle work in the main process.
  (w.document.getElementById('readOnlyBtn') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0].readOnly).toBe(true);

  // A second click before the first acknowledgement means "back off". The old handler derived
  // both clicks from state.config.readOnly=false, so both snapshots requested true and the two
  // clicks behaved like one.
  (w.document.getElementById('readOnlyBtn') as HTMLButtonElement).click();

  // While both are queued, change an unrelated checkbox. It must inherit the latest requested
  // read-only intent rather than the stale acknowledged state.
  const auto = w.document.getElementById('autoConnect') as HTMLInputElement;
  auto.checked = true;
  auto.dispatchEvent(new w.Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toHaveLength(1);

  current = appState({ ...baseConfig, readOnly: true });
  pending.shift()!({ ok: true, data: current });
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1].readOnly).toBe(false);
  // The toggle tells assistive technology which state is saved, not just its colour.
  expect(w.document.getElementById('readOnlyBtn')?.getAttribute('aria-pressed')).toBe('true');
  // The lock reads like a state; its title says what a click changes.
  expect(w.document.getElementById('readOnlyBtn')?.title).toBe('Read-only is on: ChatGPT can only look. Click to allow changes again.');
  expect(calls[1].ui.autoConnect).toBe(false);

  current = appState({ ...baseConfig, readOnly: false });
  pending.shift()!({ ok: true, data: current });
  await vi.waitFor(() => expect(calls).toHaveLength(3));
  expect(calls[2].readOnly).toBe(false);
  expect(w.document.getElementById('readOnlyBtn')?.getAttribute('aria-pressed')).toBe('false');
  expect(w.document.getElementById('readOnlyBtn')?.title).toMatch(/^Switch to read-only: ChatGPT can still look at files and the screen, but can’t create, edit, move or delete files/);
  expect(calls[2].ui.autoConnect).toBe(true);

  current = appState({ ...baseConfig, readOnly: false, ui: { ...baseConfig.ui, autoConnect: true } });
  pending.shift()!({ ok: true, data: current });
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Appearance changes must request dark then light in order,
  // even though the first dark save has not answered yet.
  const theme = w.document.getElementById('appearanceTheme') as HTMLSelectElement;
  theme.value = 'dark'; theme.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(calls).toHaveLength(4));
  expect(calls[3].ui.theme).toBe('dark');
  theme.value = 'light'; theme.dispatchEvent(new w.Event('change', { bubbles: true }));
  expect(calls).toHaveLength(4);

  current = appState({ ...baseConfig, readOnly: false, ui: { ...baseConfig.ui, autoConnect: true, theme: 'dark' } });
  pending.shift()!({ ok: true, data: current });
  await vi.waitFor(() => expect(calls).toHaveLength(5));
  expect(calls[4].ui.theme).toBe('light');

  current = appState({ ...baseConfig, readOnly: false, ui: { ...baseConfig.ui, autoConnect: true, theme: 'light' } });
  pending.shift()!({ ok: true, data: current });
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/**
 * The goal loop's settings panel.
 *
 * Three things are worth pinning here and the rest is layout: the key never travels with the
 * settings, the catalogue is only fetched when somebody asks for it, and an install with no
 * key says so in the words the extension says it in.
 */

interface GoalMount {
  window: JSDOM['window'];
  calls: any[];
  keys: Array<{ method: string; value: string }>;
  modelPages: any[];
  push(state: any): void;
  state: any;
}

async function mountChat(
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const projectSidebarFixture = () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Collapsed project', path: 'C:\\repo', createdAt: 1 };
  const session = { id: 'project-session', title: 'Project task', conversationId: 'chat-project', chatIds: ['chat-project'],
    startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastHandoffId: null, lastHandoffAt: null,
    lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null, projectId: project.id };
  return { project, session };
};

it('starts project groups collapsed and deliberately expands the project selected for a new chat', async () => {
  const { project, session } = projectSidebarFixture();
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [project] }),
    listSessions: async () => ({ ok: true, data: { sessions: [session], activeId: null, pressure: [], blocked: [] } })
  });
  const group = () => mounted.window.document.querySelector<HTMLDetailsElement>(`[data-project-id="${project.id}"]`)!;
  await vi.waitFor(() => expect(group()).not.toBeNull());
  expect(group().open).toBe(false);
  rowMenuItem(group().querySelector('.project-heading')!, 'new-chat')!.click();
  expect(group().open).toBe(true);
});

it('commits a project summary click before an immediate state repaint replaces its details node', async () => {
  const { project, session } = projectSidebarFixture();
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [project] }),
    listSessions: async () => ({ ok: true, data: { sessions: [session], activeId: null, pressure: [], blocked: [] } })
  });
  const group = () => mounted.window.document.querySelector<HTMLDetailsElement>(`[data-project-id="${project.id}"]`)!;
  await vi.waitFor(() => expect(group()).not.toBeNull());
  (group().querySelector(`[data-id="${session.id}"]`) as HTMLButtonElement).click();
  expect(group().open).toBe(true);
  const clicked = group();
  clicked.querySelector('summary')!.click();
  expect(clicked.open).toBe(false);
  mounted.push(structuredClone(mounted.state));
  expect(group()).not.toBe(clicked);
  expect(group().open).toBe(false);
  await settle();
  expect(group().open).toBe(false);

  // Native keyboard activation dispatches the same cancelable click with detail 0.
  group().querySelector('summary')!.dispatchEvent(new mounted.window.MouseEvent('click', {
    bubbles: true, cancelable: true, detail: 0
  }));
  expect(group().open).toBe(true);
  mounted.push(structuredClone(mounted.state));
  expect(group().open).toBe(true);
});

it("copies a chat's ChatGPT link from its row menu (#1107)", async () => {
  const session = {
    id: 'linked-session', title: 'Linked chat', conversationId: 'linked-chat-0001', chatIds: ['linked-chat-0001'],
    startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastHandoffId: null, lastHandoffAt: null,
    lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null
  };
  const writeClipboard = vi.fn(async () => ({ ok: true, data: true }));
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [] }),
    listSessions: async () => ({ ok: true, data: { sessions: [session], activeId: null, pressure: [], blocked: [], trusted: [] } }),
    writeClipboard
  });
  const doc = mounted.window.document;
  const row = () => doc.querySelector<HTMLElement>(`[data-id="${session.id}"]`)!;
  await vi.waitFor(() => expect(row()).not.toBeNull());
  const item = rowMenuItem(row(), 'copy-link')!;
  expect(item.textContent).toContain('Copy link');
  // It sits right after Open in browser.
  expect(item.previousElementSibling?.getAttribute('data-row-action')).toBe('open');
  item.click();
  await vi.waitFor(() => expect(writeClipboard).toHaveBeenCalledWith('https://chatgpt.com/c/linked-chat-0001'));
  await vi.waitFor(() => expect(doc.querySelector('.toast')?.textContent).toBe('Link copied'));
});

it('keeps strict chat allowlisting separate from Block and exposes explicit Trust on session rows', async () => {
  const session = {
    id: 'strict-session', title: 'Strict policy chat', conversationId: 'strict-chat-0001', chatIds: ['strict-chat-0001'],
    startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastHandoffId: null, lastHandoffAt: null,
    lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null
  };
  const workerSession = {
    ...session,
    id: 'strict-worker-session', title: 'Strict worker chat', conversationId: 'strict-worker-chat-0001',
    chatIds: ['strict-worker-chat-0001'],
    origin: { kind: 'worker' as const, fromSessionId: null, agentId: 'worker-1', task: 'owned work' }
  };
  const setSessionTrusted = vi.fn(async () => ({ ok: true, data: [session.conversationId] }));
  const setSessionBlocked = vi.fn(async () => ({ ok: true, data: [session.conversationId] }));
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [] }),
    listSessions: async () => ({ ok: true, data: {
      sessions: [session, workerSession], activeId: null, pressure: [], blocked: [], trusted: []
    } }),
    setSessionTrusted,
    setSessionBlocked
  });
  const doc = mounted.window.document;
  mounted.state.config.multiAgent.strictChatAllowlist = true;
  mounted.push(structuredClone(mounted.state));
  const primeRow = () => doc.querySelector<HTMLElement>(`[data-id="${session.id}"]`)!;
  const workerRow = () => doc.querySelector<HTMLElement>(`[data-id="${workerSession.id}"]`)!;
  await vi.waitFor(() => expect(rowMenuItem(primeRow(), 'trust')).not.toBeNull());
  closeRowMenus(doc);
  expect(rowMenuItem(workerRow(), 'trust')).toBeNull();
  expect(doc.querySelector('.row-menu [data-row-action="block"]')).not.toBeNull();
  closeRowMenus(doc);

  rowMenuItem(primeRow(), 'trust')!.click();
  await vi.waitFor(() => expect(setSessionTrusted).toHaveBeenCalledWith(session.id, session.conversationId, true));
  expect(setSessionBlocked).not.toHaveBeenCalled();

  rowMenuItem(primeRow(), 'block')!.click();
  await vi.waitFor(() => expect(setSessionBlocked).toHaveBeenCalledWith(session.id, true));
});

it('shows committed resume inheritance as trusted and revokes it through the current row', async () => {
  const source = 'strict-resume-source-0001';
  const current = 'strict-resume-current-0001';
  const session = {
    id: 'strict-resume-session', title: 'Resumed trusted chat', conversationId: current, chatIds: [source, current],
    startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastHandoffId: 'handoff-resume-0001', lastHandoffAt: 1,
    lastCommittedResumeHandoffId: 'handoff-resume-0001',
    lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null
  };
  const setSessionTrusted = vi.fn(async () => ({ ok: true, data: [] }));
  const setSessionBlocked = vi.fn(async () => ({ ok: true, data: [] }));
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [] }),
    listSessions: async () => ({ ok: true, data: {
      sessions: [session], activeId: null, pressure: [], blocked: [], trusted: [source]
    } }),
    setSessionTrusted,
    setSessionBlocked
  });
  const doc = mounted.window.document;
  mounted.state.config.multiAgent.strictChatAllowlist = true;
  mounted.push(structuredClone(mounted.state));
  const row = () => doc.querySelector<HTMLElement>(`[data-id="${session.id}"]`)!;
  await vi.waitFor(() => expect(rowMenuItem(row(), 'trust')).not.toBeNull());
  const trust = rowMenuItem(row(), 'trust')!;
  expect(trust.textContent).toBe('Untrust chat');
  expect(doc.querySelector('.row-menu [data-row-action="block"]')!.textContent).toBe('Block chat');
  trust.click();
  await vi.waitFor(() => expect(setSessionTrusted).toHaveBeenCalledWith(session.id, current, false));
});

it('offers a chat\'s actions in one menu, by kind of row, and opens it with a right click too', async () => {
  const base = { startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null };
  const chat = { ...base, id: 'menu-chat-0001', title: 'A chat', conversationId: 'menu-conversation-0001', chatIds: ['menu-conversation-0001'] };
  const loose = { ...base, id: 'menu-loose-0001', title: '', conversationId: null, chatIds: [] };
  const deleteSession = vi.fn(async () => ({ ok: true, data: true }));
  const openSessionChat = vi.fn(async () => ({ ok: true, data: true }));
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [] }),
    listSessions: async () => ({ ok: true, data: { sessions: [chat, loose], activeId: null, pressure: [], blocked: [], trusted: [] } }),
    deleteSession, openSessionChat
  });
  const doc = mounted.window.document;
  const row = (id: string) => doc.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
  await vi.waitFor(() => expect(row(chat.id)).not.toBeNull());
  // One button on the row, no loose icons.
  expect(row(chat.id).querySelectorAll('.sess-actions button').length).toBe(1);
  const actions = (): Array<string | undefined> => [...doc.querySelectorAll<HTMLElement>('.row-menu .row-menu-item')].map(item => item.dataset.rowAction);
  rowMenuItem(row(chat.id), 'rename');
  expect(actions()).toEqual(['pin', 'rename', 'open', 'copy-link', 'block', 'remove']);
  expect(doc.querySelector('.row-menu [data-row-action="remove"]')!.classList.contains('is-danger')).toBe(true);
  closeRowMenus(doc);
  // A row that is not a chat offers only what applies to it.
  await vi.waitFor(() => expect(row(loose.id)).not.toBeNull());
  rowMenuItem(row(loose.id), 'block');
  expect(actions()).toEqual(['block', 'remove']);
  closeRowMenus(doc);
  // A right click opens the same menu; its items run their action.
  row(chat.id).dispatchEvent(new mounted.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }));
  doc.querySelector<HTMLButtonElement>('.row-menu [data-row-action="open"]')!.click();
  await vi.waitFor(() => expect(openSessionChat).toHaveBeenCalledWith(chat.id));
  expect(doc.querySelector('.row-menu')).toBeNull();
});

it('names a chat in place: Enter saves, Escape keeps the old name, empty restores ChatGPT\'s title, repaints keep the field (#1107)', async () => {
  const session = {
    id: 'rename-session-0001', title: 'ChatGPT title', conversationId: 'rename-conversation-0001', chatIds: ['rename-conversation-0001'],
    startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null
  };
  const renameSession = vi.fn(async () => ({ ok: true, data: true }));
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [] }),
    listSessions: async () => ({ ok: true, data: { sessions: [session], activeId: null, pressure: [], blocked: [], trusted: [] } }),
    renameSession
  });
  const doc = mounted.window.document;
  const row = () => doc.querySelector<HTMLElement>(`[data-id="${session.id}"]`)!;
  const field = () => row().querySelector<HTMLInputElement>('.sess-rename');
  await vi.waitFor(() => expect(row().querySelector('.row-menu-button')).not.toBeNull());
  expect(field()).toBeNull();
  const press = (key: string) => field()!.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key, bubbles: true }));
  const type = (text: string) => { field()!.value = text; field()!.dispatchEvent(new mounted.window.Event('input', { bubbles: true })); };

  // Escape: nothing is saved, the title is back.
  rowMenuItem(row(), 'rename')!.click();
  await vi.waitFor(() => expect(field()).not.toBeNull());
  expect(field()!.value).toBe('ChatGPT title');
  type('Never saved');
  press('Escape');
  await vi.waitFor(() => expect(field()).toBeNull());
  expect(renameSession).not.toHaveBeenCalled();
  expect(row().querySelector('.sess-top b')!.textContent).toBe('ChatGPT title');

  // The sidebar repaints while the user types; the field and its text survive.
  rowMenuItem(row(), 'rename')!.click();
  await vi.waitFor(() => expect(field()).not.toBeNull());
  type('  Release   prep  ');
  const editing = field();
  mounted.push(structuredClone(mounted.state));
  await new Promise(resolve => setTimeout(resolve, 50));
  // The same node: an input method's composition would not survive a replaced field.
  expect(field()).toBe(editing);
  expect(field()?.value).toBe('  Release   prep  ');
  press('Enter');
  await vi.waitFor(() => expect(renameSession).toHaveBeenCalledWith(session.id, 'Release   prep'));

  // Empty asks for ChatGPT's title again.
  rowMenuItem(row(), 'rename')!.click();
  await vi.waitFor(() => expect(field()).not.toBeNull());
  type('   ');
  press('Enter');
  await vi.waitFor(() => expect(renameSession).toHaveBeenLastCalledWith(session.id, null));
});

it('searches chats in a dialog opened beside the app name: recent chats first, then marked matches (#1117)', async () => {
  const base = { conversationId: null, chatIds: [], startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null };
  const listed = { ...base, id: 'search-listed-0001', title: 'Listed chat', conversationId: 'search-listed-conversation' };
  let indexed = 1;
  const searchSessions = vi.fn(async (query: string) => ({ ok: true, data: query === 'bridge' ? {
    results: [{ id: 'search-hit-0001', title: 'Release planning', projectId: null,
      snippet: { text: '…then the bridge gets its installer.', matches: [[10, 16]] } }],
    indexed, total: 3 } : { results: [], indexed: 3, total: 3 } }));
  const getSession = vi.fn(async (id: string) => ({ ok: true, data: { summary: { ...base, id, title: 'Release planning' }, events: [], total: 0, nextFrom: 1 } }));
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [] }),
    listSessions: async () => ({ ok: true, data: { sessions: [listed], activeId: null, pressure: [], blocked: [], trusted: [] } }),
    searchSessions, getSession
  });
  const doc = mounted.window.document;
  const field = doc.getElementById('chatSearch') as HTMLInputElement;
  const results = doc.getElementById('searchResults')!;
  const lists = doc.getElementById('sessionList')!;
  const dialog = doc.getElementById('searchDialog') as HTMLDialogElement;
  await vi.waitFor(() => expect(doc.querySelector('[data-id="search-listed-0001"]')).not.toBeNull());
  // No search field in the sidebar: one icon beside the app name opens the dialog.
  expect(doc.querySelector('.sidebar #chatSearch')).toBeNull();
  expect(dialog.open).toBe(false);
  (doc.getElementById('searchChatsButton') as HTMLButtonElement).click();
  expect(dialog.open).toBe(true);
  expect(doc.activeElement).toBe(field);
  // Before anything is typed: the most recent chats.
  await vi.waitFor(() => expect(results.querySelector('.search-heading')?.textContent).toBe('Recent'));
  expect([...results.querySelectorAll('.search-result b')].map(title => title.textContent)).toEqual(['Listed chat']);

  field.value = 'bridge';
  field.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
  await vi.waitFor(() => expect(results.querySelector('.search-snippet')).not.toBeNull());
  // The chat lists keep their place behind the dialog.
  expect(lists.hidden).toBe(false);
  expect((doc.getElementById('chatSearchClear') as HTMLButtonElement).hidden).toBe(false);
  expect(results.querySelector('.search-result b')!.textContent).toBe('Release planning');
  expect([...results.querySelectorAll('.search-snippet mark')].map(mark => mark.textContent)).toEqual(['bridge']);
  // Indexing is not done yet: the result says so, and asks again until it is.
  expect(results.querySelector('.search-status')!.textContent).toContain('1 of 3');
  indexed = 3;
  await vi.waitFor(() => expect(results.querySelector('.search-status')).toBeNull());

  // Opening a result closes the dialog and opens the chat.
  (results.querySelector('.search-result') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(dialog.open).toBe(false));
  await vi.waitFor(() => expect(getSession).toHaveBeenCalledWith('search-hit-0001', expect.anything()));

  // Opened again (from the View menu), the last query is still there, selected, and the open chat is marked.
  (doc.getElementById('viewMenu') as HTMLButtonElement).click();
  (doc.querySelector('.row-menu [data-row-action="search"]') as HTMLButtonElement).click();
  expect(dialog.open).toBe(true);
  await vi.waitFor(() => expect(results.querySelector('.search-result')!.classList.contains('is-sel')).toBe(true));

  field.value = 'nothing';
  field.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
  await vi.waitFor(() => expect(results.textContent).toContain('No chats match'));

  // The clear button empties the query and brings the recent chats back.
  (doc.getElementById('chatSearchClear') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(results.querySelector('.search-heading')).not.toBeNull());
  expect(field.value).toBe('');
  // A click on the backdrop lands on the dialog itself and closes it.
  dialog.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }));
  await vi.waitFor(() => expect(dialog.open).toBe(false));
});

it.each([['Win32', 'ctrlKey', 'metaKey'], ['MacIntel', 'metaKey', 'ctrlKey']] as const)(
  'opens chat search with the primary shortcut on %s, never from the terminal, and says when results were capped', async (platform, primary, other) => {
  vi.stubGlobal('navigator', { ...globalThis.navigator, platform });
  try {
    const base = { conversationId: null, chatIds: [], startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
      lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
      estimatedTokens: 0, contextTokens: 0, lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null };
    const listed = { ...base, id: 'search-shortcut-0001', title: 'Listed chat', conversationId: 'search-shortcut-conversation' };
    const mounted = await mountChat({}, [], {
      listProjects: async () => ({ ok: true, data: [] }),
      listSessions: async () => ({ ok: true, data: { sessions: [listed], activeId: null, pressure: [], blocked: [], trusted: [] } }),
      searchSessions: async () => ({ ok: true, data: { results: [{ id: 'search-shortcut-0001', title: 'Listed chat', projectId: null }],
        indexed: 1, total: 1, limited: true } })
    });
    const doc = mounted.window.document;
    const field = doc.getElementById('chatSearch') as HTMLInputElement;
    await vi.waitFor(() => expect(doc.querySelector('[data-id="search-shortcut-0001"]')).not.toBeNull());
    const press = (target: EventTarget, modifier: string) =>
      target.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'k', [modifier]: true, bubbles: true, cancelable: true }));
    expect(press(doc.body, other)).toBe(true);
    expect(doc.activeElement).not.toBe(field);
    // Ctrl+K deletes to the end of the line in a shell; the terminal keeps it.
    const terminal = doc.createElement('div');
    terminal.className = 'xterm';
    const input = terminal.appendChild(doc.createElement('textarea'));
    doc.body.append(terminal);
    input.focus();
    expect(press(input, primary)).toBe(true);
    expect(doc.activeElement).toBe(input);
    expect(press(doc.body, primary)).toBe(false);
    expect((doc.getElementById('searchDialog') as HTMLDialogElement).open).toBe(true);
    expect(doc.activeElement).toBe(field);

    field.value = 'listed';
    field.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(doc.getElementById('searchResults')!.textContent)
      .toContain('Showing the first 1 matches. Add a word to narrow them down.'));
  } finally {
    vi.unstubAllGlobals();
  }
});

it('shows an inherited Block ahead of Trust on a committed resumed row', async () => {
  const source = 'strict-resume-blocked-source-0001';
  const current = 'strict-resume-blocked-current-0001';
  const session = {
    id: 'strict-resume-blocked-session', title: 'Resumed blocked chat', conversationId: current, chatIds: [source, current],
    startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastHandoffId: 'handoff-resume-blocked-0001', lastHandoffAt: 1,
    lastCommittedResumeHandoffId: 'handoff-resume-blocked-0001',
    lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null
  };
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [] }),
    listSessions: async () => ({ ok: true, data: {
      sessions: [session], activeId: null, pressure: [], blocked: [source], trusted: [source]
    } })
  });
  const doc = mounted.window.document;
  mounted.state.config.multiAgent.strictChatAllowlist = true;
  mounted.push(structuredClone(mounted.state));
  const row = () => doc.querySelector<HTMLElement>(`[data-id="${session.id}"]`)!;
  await vi.waitFor(() => expect(rowMenuItem(row(), 'trust')).not.toBeNull());
  expect(doc.querySelector('.row-menu [data-row-action="block"]')!.textContent).toBe('Release chat');
  expect(doc.querySelector('.row-menu [data-row-action="trust"]')!.textContent).toBe('Trust chat');
});

it('saves strict chat allowlisting and disables the unattributed switch while strict mode is on', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const strict = doc.getElementById('strictChatAllowlist') as HTMLInputElement;
  const unattributed = doc.getElementById('allowUnattributedCalls') as HTMLInputElement;
  const copy = strict.closest('.setting')!.textContent ?? '';
  expect(copy).toContain("Only chats you trust can use this computer's tools.");
  expect(copy).toContain('Existing chats start untrusted');
  expect(copy).toMatch(/sidebar.*Trust/i);
  expect(copy).not.toContain('Sessions');

  strict.checked = true;
  strict.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls.some(call => call.multiAgent?.strictChatAllowlist === true)).toBe(true));

  const next = structuredClone(mounted.state);
  next.config.multiAgent.strictChatAllowlist = true;
  mounted.push(next);
  expect(unattributed.disabled).toBe(true);
});

it('keeps project keyboard focus across activity repaint without taking composer focus or reloading on disclosure', async () => {
  const { project, session } = projectSidebarFixture();
  const listSessions = vi.fn(async () => ({ ok: true, data: { sessions: [session], activeId: null, pressure: [], blocked: [] } }));
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [project] }), listSessions
  });
  const doc = mounted.window.document;
  const heading = () => doc.querySelector<HTMLElement>(`[data-project-id="${project.id}"] > summary`)!;
  await vi.waitFor(() => expect(heading()).not.toBeNull());
  await settle();
  const reads = listSessions.mock.calls.length;
  heading().focus(); heading().click();
  await settle();
  expect(listSessions).toHaveBeenCalledTimes(reads);
  expect(doc.activeElement).toBe(heading());
  mounted.push(structuredClone(mounted.state));
  expect(doc.activeElement).toBe(heading());
  const input = doc.getElementById('chatInput') as HTMLTextAreaElement;
  input.focus(); input.value = 'Keep typing here';
  mounted.push(structuredClone(mounted.state));
  expect(doc.activeElement).toBe(input);
  expect(input.value).toBe('Keep typing here');
  const { chatVisible } = await import('../src/renderer/chat.js');
  chatVisible(false); chatVisible(true);
  await settle();
  expect(listSessions).toHaveBeenCalledTimes(reads + 1);
});

// Adapted from @Haz4rdovisk's #345: typed Setup values used to reach the app only on blur, so a
// Connect click right after typing did nothing.
it.each(['wizConnect', 'connectionPopoverToggle'])(
  'persists valid Setup drafts before %s starts the tunnel',
  async (buttonId) => {
    let live: any;
    const order: string[] = [];
    const connect = vi.fn(() => {
      order.push('connect');
      expect(live.config.tunnel.tunnelId).toBe(`tunnel_${'b'.repeat(32)}`);
      expect(live.hasApiKey).toBe(true);
      live.status.state = 'connected';
      return Promise.resolve({ ok: true as const, data: structuredClone(live) });
    });
    const mounted = await mountChat({}, [], {
      saveSettings: (patch: any) => {
        order.push('settings');
        live.config = { ...live.config, ...structuredClone(patch) };
        return Promise.resolve({ ok: true as const, data: structuredClone(live) });
      },
      setApiKey: () => {
        order.push('key');
        live.hasApiKey = true;
        return Promise.resolve({ ok: true as const, data: structuredClone(live) });
      },
      connect
    });
    live = mounted.state;
    live.config.tunnel.tunnelId = '';
    live.hasApiKey = false;
    mounted.push(structuredClone(live));

    const doc = mounted.window.document;
    const tunnel = doc.getElementById('tunnelId') as HTMLInputElement;
    const key = doc.getElementById('apiKey') as HTMLInputElement;
    expect((doc.getElementById('wizConnect') as HTMLButtonElement).disabled).toBe(true);
    tunnel.value = `tunnel_${'b'.repeat(32)}`;
    tunnel.dispatchEvent(new mounted.window.Event('input'));
    key.value = 'sk-valid-setup-draft';
    key.dispatchEvent(new mounted.window.Event('input'));

    expect((doc.getElementById(buttonId) as HTMLButtonElement).disabled).toBe(false);
    (doc.getElementById(buttonId) as HTMLButtonElement).click();
    // The Intel macOS release runner needs more than waitFor's default second for this chain.
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce(), { timeout: 10_000 });
    expect(order).toEqual(['settings', 'key', 'connect']);
  }
);

it('keeps global connection controls in a compact sidebar popover', async () => {
  const mounted = await mountChat({ hasApiKey: true });
  const doc = mounted.window.document;
  const now = Date.now();
  const connected = structuredClone(mounted.state) as any;
  connected.status = {
    state: 'connected', detail: 'Connected.', publicUrl: null, localUrl: 'http://127.0.0.1:1234',
    handshakeAt: now - 5_000, lastRequestAt: now - 3_000, lastToolCallAt: now - 2_000, health: null,
    surfaces: [{ id: 'core', connectorName: 'Core', description: '', cardSummary: '', optional: false,
      available: true, localUrl: 'http://127.0.0.1:1234', publicUrl: null, tools: ['read'], state: 'live',
      detail: '', lastRequestAt: now - 3_000, lastToolCallAt: now - 2_000 }]
  };
  connected.bridge = { running: true, port: 8765, paired: true, present: true,
    lastSeenAt: now - 1_000, extensionVersion: '2.1.13' };
  mounted.push(connected);

  const trigger = doc.getElementById('sidebarConnection') as HTMLButtonElement;
  const popover = doc.getElementById('connectionPopover') as HTMLElement;
  expect(doc.querySelector('#chatTitle')!.closest('header')!.querySelector('#connectBtn')).toBeNull();
  expect(trigger.closest('.sidebar-bottom')).not.toBeNull();
  // Connected: the quiet dot alone, its label column closed.
  expect(trigger.classList.contains('has-label')).toBe(false);
  expect(trigger.getAttribute('aria-label')).toMatch(/Connected.*verified/i);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');

  Object.defineProperty(mounted.window, 'innerWidth', { configurable: true, value: 800 });
  Object.defineProperty(mounted.window, 'innerHeight', { configurable: true, value: 760 });
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
    x: 200, y: 700, left: 200, top: 700, right: 236, bottom: 736, width: 36, height: 36,
    toJSON: () => ({})
  } as DOMRect);
  vi.spyOn(popover, 'getBoundingClientRect').mockReturnValue({ width: 160 } as DOMRect);
  trigger.click();
  expect(popover.hidden).toBe(false);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(popover.style.left).toBe('138px');
  expect(popover.parentElement).toBe(doc.body);
  expect(doc.getElementById('connectionPopoverSettings')).toBeNull();
  trigger.click(); trigger.click();
  expect(popover.hidden).toBe(false);
  expect(popover.querySelector('details')).toBeNull();
  expect(doc.getElementById('connectionPopoverConnector')!.textContent).toMatch(/Reached/i);
  expect(doc.getElementById('connectionPopoverBrowser')!.textContent).toBe('Connected');
  expect(doc.getElementById('connectionPopoverBrowser')!.parentElement!.title).toMatch(/Seen/i);
  expect(doc.getElementById('connectionPopoverBrowser')!.classList.contains('sr-only')).toBe(true);
  expect(doc.getElementById('connectionPopoverBrowser')!.parentElement!.dataset.tone).toBe('ok');
  expect(doc.getElementById('connectionPopoverVerified')).toBeNull();
  expect(doc.getElementById('connectionPopoverTitle')!.title).toMatch(/verified/i);
  expect(doc.getElementById('connectionPipeline')).toBeNull();
  expect(doc.getElementById('connectionPopoverExtension')).toBeNull();
  expect((doc.getElementById('connectionPopoverToggle') as HTMLButtonElement).textContent).toBe('Disconnect');

  doc.body.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }));
  expect(popover.hidden).toBe(true);
});

it('keeps a quick Disconnecting on screen long enough to read, then shows the real state', async () => {
  const mounted = await mountChat({ hasApiKey: true });
  const doc = mounted.window.document;
  const title = () => doc.getElementById('connectionPopoverTitle')!.textContent;
  mounted.push({ ...mounted.state, status: { ...mounted.state.status, state: 'connected' } });
  mounted.push({ ...mounted.state, status: { ...mounted.state.status, state: 'disconnecting' } });
  expect(title()).toBe('Disconnecting');
  // Over in a blink: the window still says Disconnecting for a moment.
  mounted.push({ ...mounted.state, status: { ...mounted.state.status, state: 'disconnected' } });
  expect(title()).toBe('Disconnecting');
  await vi.waitFor(() => expect(title()).toBe('Not connected'), { timeout: 2500 });
  expect(doc.getElementById('sidebarConnectionLabel')!.textContent).toBe('Connect');
});

it('keeps the Settings footer action visible while settings are open', async () => {
  const mounted = await mountChat({ hasApiKey: true });
  const doc = mounted.window.document;
  const settings = doc.getElementById('workspaceSettings') as HTMLButtonElement;

  expect(settings.hidden).toBe(false);
  settings.click();
  expect(settings.hidden).toBe(false);
  expect(settings.classList.contains('is-sel')).toBe(true);
  (doc.getElementById('backToChat') as HTMLButtonElement).click();
  expect(settings.hidden).toBe(false);
  expect(settings.classList.contains('is-sel')).toBe(false);
});

it('shows connection status once and keeps diagnostics out of the desktop popover', async () => {
  const diagnostics = vi.fn(async () => ({ ok: true, data: null }));
  const internalBrowser = vi.fn(async () => ({ ok: true, data: null }));
  const mounted = await mountChat({ hasApiKey: true }, [], {
    companionDiagnostics: diagnostics, internalBrowser
  });
  const doc = mounted.window.document;
  const popover = doc.getElementById('connectionPopover')!;
  const trigger = doc.getElementById('sidebarConnection') as HTMLButtonElement;
  const button = doc.getElementById('connectionPopoverToggle') as HTMLButtonElement;
  const label = doc.getElementById('sidebarConnectionLabel')!;
  // Disconnected, the capsule says what to do, and a click does it instead of opening the details.
  expect(trigger.classList.contains('has-label')).toBe(true);
  expect(label.textContent).toBe('Connect');
  trigger.click();
  expect(popover.hidden).toBe(true);
  // The details stay one right click away.
  trigger.dispatchEvent(new mounted.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  expect(popover.querySelector('.connection-popover-head')!.textContent?.trim()).toBe('Not connected');
  expect(popover.textContent).not.toContain('Connection is off');
  expect(popover.querySelector('details')).toBeNull();
  expect(popover.querySelectorAll('button')).toHaveLength(1);

  for (const [state, title, action, disabled, capsule] of [
    ['starting-server', 'Starting', 'Disconnect', false, 'Connecting…'],
    ['connecting-tunnel', 'Connecting', 'Disconnect', false, 'Connecting…'],
    ['connected', 'Connected', 'Disconnect', false, null],
    ['offline', 'No internet', 'Disconnect', false, 'No internet'],
    ['disconnecting', 'Disconnecting', 'Disconnecting…', true, 'Disconnecting…'],
    ['auth-failed', 'Sign-in failed', 'Connect', false, 'Failed'],
    ['tunnel-unavailable', 'Tunnel unavailable', 'Connect', false, 'Failed'],
    ['disconnected', 'Not connected', 'Connect', false, 'Connect']
  ] as const) {
    mounted.push({ ...mounted.state, status: { ...mounted.state.status, state } });
    expect(popover.querySelector('.connection-popover-head')!.textContent?.trim()).toBe(title);
    expect(button.textContent).toBe(action);
    expect(button.disabled).toBe(disabled);
    expect(popover.hidden).toBe(false);
    // The capsule: a short word while it has something to say (Disconnecting… included), the dot alone
    // once connected.
    expect(trigger.classList.contains('has-label')).toBe(capsule !== null);
    if (capsule) expect(label.textContent).toBe(capsule);
    // The details offer an action only when the capsule does not already show it.
    expect((button.parentElement as HTMLElement).hidden).toBe(state === 'disconnected' || state === 'disconnecting');
    // A state change is announced once, politely.
    expect(doc.getElementById('connectionAnnounce')!.textContent).toBe(title);
  }

  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('pt-BR');
  expect(popover.querySelector('.connection-popover-head')!.textContent?.trim()).toBe('Não conectado');
  expect(popover.textContent).not.toContain('A conexão está desativada');
  trigger.click();
  trigger.dispatchEvent(new mounted.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  doc.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(popover.hidden).toBe(true);
  expect(doc.activeElement).toBe(trigger);
  expect(diagnostics).not.toHaveBeenCalled();
  expect(internalBrowser).not.toHaveBeenCalled();
});

it('adds and selects setup profiles and rejects an older profile status response', async () => {
  const add = vi.fn(); const select = vi.fn();
  const mounted = await mountChat({}, [], { addSetupProfile: add, selectSetupProfile: select });
  const doc = mounted.window.document;
  // jsdom does not implement native dialogs/popovers; Chromium acceptance covers their UI.
  const dialog = doc.getElementById('setupProfileDialog') as HTMLDialogElement;
  dialog.showModal = vi.fn(); dialog.close = vi.fn();
  doc.getElementById('setupProfileMenu')!.hidePopover = vi.fn();
  const initial = structuredClone(mounted.state);
  const next = { ...initial, config: { ...initial.config, tunnel: { ...initial.config.tunnel,
    profileId: 'second', profileName: 'Work', profileEpoch: 1, tunnelId: '' },
    setupProfiles: [{ id: 'default', name: 'Default', tunnelId: initial.config.tunnel.tunnelId, desktopTunnelId: '', pluginsTunnelId: '' }] } };
  add.mockResolvedValue({ ok: true, data: next });
  (doc.getElementById('setupProfileAdd') as HTMLButtonElement).click();
  expect(dialog.showModal).toHaveBeenCalled();
  (doc.getElementById('setupProfileName') as HTMLInputElement).value = 'Work';
  doc.getElementById('setupProfileForm')!.dispatchEvent(new mounted.window.Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(doc.getElementById('setupProfileCurrent')!.textContent).toBe('Work'));
  expect(add).toHaveBeenCalledWith('Work');
  expect((doc.getElementById('tunnelId') as HTMLInputElement).value).toBe('');
  mounted.push(initial);
  expect(doc.querySelector('[data-profile-id="second"]')!.getAttribute('aria-pressed')).toBe('true');
  select.mockResolvedValue({ ok: true, data: { ...initial, config: { ...initial.config, tunnel: {
    ...initial.config.tunnel, profileId: 'default', profileEpoch: 2 }, setupProfiles: [] } } });
  (doc.querySelector('[data-profile-id="default"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(select).toHaveBeenCalledWith('default'));
  await vi.waitFor(() => expect((doc.getElementById('tunnelId') as HTMLInputElement).value).toBe(initial.config.tunnel.tunnelId));
});

it('asks whether an update came out when Settings open, not on every page inside them', async () => {
  const refreshUpdate = vi.fn(async () => ({ ok: true, data: true }));
  const { window: w } = await mountChat({}, [], { refreshUpdate });
  const doc = w.document;
  expect(refreshUpdate).not.toHaveBeenCalled();
  (doc.getElementById('workspaceSettings') as HTMLButtonElement).click();
  expect(refreshUpdate).toHaveBeenCalledTimes(1);
  for (const tab of ['general', 'activity', 'usage']) (doc.querySelector(`#tabs button[data-tab="${tab}"]`) as HTMLButtonElement).click();
  expect(refreshUpdate).toHaveBeenCalledTimes(1);
  (doc.getElementById('backToChat') as HTMLButtonElement).click();
  (doc.getElementById('workspaceSettings') as HTMLButtonElement).click();
  expect(refreshUpdate).toHaveBeenCalledTimes(2);
});

it('searches every settings page from the sidebar and opens the setting it finds', async () => {
  const { window: w } = await mountChat();
  const doc = w.document;
  const field = doc.getElementById('settingsFind') as HTMLInputElement;
  const box = doc.getElementById('settingsFindBox')!, pages = doc.getElementById('tabs')!, results = doc.getElementById('settingsFindResults')!;
  const frame = () => new Promise(resolve => w.requestAnimationFrame(resolve));
  const type = (text: string) => { field.value = text; field.dispatchEvent(new w.Event('input')); };
  const rows = () => [...results.querySelectorAll<HTMLButtonElement>('.search-result')];
  expect(box.hidden).toBe(true);
  (doc.getElementById('workspaceSettings') as HTMLButtonElement).click();
  expect(box.hidden).toBe(false);
  // While the field holds a query, its results take the page list's place.
  type('privacy screenshots');
  expect([pages.hidden, results.hidden]).toEqual([true, false]);
  expect(rows().map(row => [row.querySelector('b')!.textContent, row.querySelector('.search-snippet')!.textContent])).toEqual([['Privacy screenshots', 'General › Privacy']]);
  expect(rows()[0]!.querySelectorAll('mark')).toHaveLength(2);
  rows()[0]!.click(); await frame();
  // Its page opens with the list back, the setting marked and its control focused.
  expect(doc.querySelector('[data-panel="general"]')!.classList.contains('is-active')).toBe(true);
  expect([field.value, pages.hidden, results.hidden]).toEqual(['', false, true]);
  expect(doc.getElementById('privacyScreenshots')!.closest('.setting')!.classList.contains('is-found')).toBe(true);
  expect(doc.activeElement).toBe(doc.getElementById('privacyScreenshots'));
  // Enter opens the best match, here on Agents & automation.
  type('session finish');
  field.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await frame();
  expect(doc.querySelector('[data-panel="chat"]')!.classList.contains('is-active')).toBe(true);
  expect(doc.querySelector<HTMLElement>('[data-view="settings"]')!.hidden).toBe(false);
  expect(doc.activeElement).toBe(doc.getElementById('finishTool'));
  // Nothing found says so; Escape empties the field and brings the list back.
  type('no-such-setting-123');
  expect(rows()).toHaveLength(0);
  expect(results.textContent).toContain('No settings match your search.');
  field.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect([field.value, pages.hidden, results.hidden]).toEqual(['', false, true]);
  // Ctrl+F (⌘F on macOS) reaches the field only while Settings are open; leaving them hides it.
  const mac = /^Mac/.test(navigator.platform);
  const find = () => { const event = new w.KeyboardEvent('keydown', { key: 'f', ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true }); doc.body.dispatchEvent(event); return event.defaultPrevented; };
  (doc.getElementById('chatBody') as HTMLElement).focus();
  expect(find()).toBe(true);
  expect(doc.activeElement).toBe(field);
  (doc.getElementById('backToChat') as HTMLButtonElement).click();
  expect(box.hidden).toBe(true);
  expect(find()).toBe(false);
});

it('attaches pasted screenshot files with previews while preserving ordinary text paste', async () => {
  const dropFiles = vi.fn(async () => ({ ok: true, data: [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'screenshot.png', size: 4, mimeType: 'image/png', preview: 'data:image/webp;base64,AAAA' }] }));
  const mounted = await mountChat({}, [], { dropFiles });
  const w = mounted.window, input = w.document.getElementById('settingsFind') as HTMLInputElement;
  input.focus();
  const file = new w.File(['image'], 'screenshot.png', { type: 'image/png' });
  const paste = new w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [file] } });
  input.dispatchEvent(paste);
  await vi.waitFor(() => expect(dropFiles).toHaveBeenCalledWith([file]));
  expect(paste.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(w.document.querySelector('img[src="data:image/webp;base64,AAAA"]')).not.toBeNull());
  const text = new w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(text, 'clipboardData', { value: { files: [] } });
  input.dispatchEvent(text);
  expect(text.defaultPrevented).toBe(false);
  expect(w.document.activeElement).toBe(input);
  const overflow = new w.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(overflow, 'clipboardData', { value: { files: Array(20).fill(file) } });
  input.dispatchEvent(overflow);
  expect(overflow.defaultPrevented).toBe(true);
  expect(dropFiles).toHaveBeenCalledTimes(1);
});

it('preserves the selected OpenRouter model through an unchanged custom-provider round trip', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const original = 'z-ai/glm-5.3-flash';
  mounted.state.config.goal = { ...mounted.state.config.goal, model: original, provider: { kind: 'openrouter', baseUrl: '' } };
  mounted.push(mounted.state);
  const provider = w.document.getElementById('goalProvider') as HTMLSelectElement;
  provider.value = 'custom'; provider.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1));
  // Repainting custom settings must not replace the hidden OpenRouter picker's model.
  mounted.push({ ...mounted.state, hasCustomProviderKey: false });
  provider.value = 'openrouter'; provider.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(2));
  expect(mounted.calls[1].goal).toMatchObject({ provider: { kind: 'openrouter' }, model: original });
  expect(w.document.getElementById('goalModelName')!.textContent).toBe(original);
});

it('uses the OpenRouter default when opened directly on an unrelated custom deployment', async () => {
  const mounted = await mountChat({}, [], {}, { model: 'llama3.1', provider: { kind: 'custom', baseUrl: 'http://localhost:8000/v1' } });
  const provider = mounted.window.document.getElementById('goalProvider') as HTMLSelectElement;
  provider.value = 'openrouter';
  provider.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].goal).toMatchObject({ provider: { kind: 'openrouter' }, model: DEFAULT_GOAL_MODEL });
});

it('saves a custom deployment id and returns to the known OpenRouter model', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const provider = w.document.getElementById('goalProvider') as HTMLSelectElement;
  provider.value = 'custom';
  provider.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].goal.provider.kind).toBe('custom');
  expect(w.document.getElementById('goalCustomPanel')?.hidden).toBe(false);
  const model = w.document.getElementById('goalCustomModel') as HTMLInputElement;
  model.value = 'llama3.1';
  model.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(2));
  expect(mounted.calls[1].goal.model).toBe('llama3.1');
  provider.value = 'openrouter';
  provider.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(3));
  expect(mounted.calls[2].goal).toMatchObject({ provider: { kind: 'openrouter' }, model: 'deepseek/deepseek-v4-flash' });
});

it('offers all six bridge ports, saves numbers, and distinguishes saved choice from the override listener', async () => {
  const mounted = await mountChat(); const w = mounted.window;
  const select = w.document.getElementById('browserBridgePort') as HTMLSelectElement;
  expect([...select.options].map(option => option.value)).toEqual(['auto', '8765', '8766', '8767', '8768', '8769']);
  expect(select.value).toBe('auto');
  for (const value of ['8765', '8766', '8767', '8768', '8769', 'auto']) {
    select.value = value; select.dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle();
    expect(mounted.calls.at(-1).ui.browserBridgePort).toBe(value === 'auto' ? 'auto' : Number(value));
  }
  mounted.push({ ...mounted.state, bridge: { ...mounted.state.bridge, port: 12345, portOverridden: true } });
  expect(select.disabled).toBe(true); expect(select.value).toBe('auto');
  expect(w.document.getElementById('browserBridgePortHint')!.textContent).toContain('CLF_BRIDGE_PORTS');
});

it('shows startup bind errors in the existing Setup status and clears them after recovery', async () => {
  const mounted = await mountChat({ bridge: { running: false, error: 'port 8767: EADDRINUSE' } });
  const status = mounted.window.document.getElementById('bridgeState')!;
  expect(status.textContent).toContain('Browser bridge could not start: port 8767: EADDRINUSE');
  mounted.push({ ...mounted.state, bridge: { running: true, port: 8768, paired: false, present: false, error: null } });
  expect(status.textContent).toContain('8768'); expect(status.textContent).not.toContain('EADDRINUSE');
});

it('restores a rejected focused port and prevents an unrelated queued save from retrying it', async () => {
  let release!: (result: any) => void; const calls: any[] = [];
  const mounted = await mountChat({}, [], { saveSettings: (patch: any, base: any) => {
    calls.push({ patch: structuredClone(patch), base: structuredClone(base) });
    if (calls.length === 1) return new Promise(resolve => { release = resolve; });
    // Match main's three-way port merge: an inherited failed value is not an explicit edit.
    const browserBridgePort = patch.ui.browserBridgePort === base.ui.browserBridgePort ? 'auto' : patch.ui.browserBridgePort;
    return Promise.resolve({ ok: true, data: { ...mounted.state,
      config: { ...mounted.state.config, ...patch, ui: { ...patch.ui, browserBridgePort } } } });
  } });
  const w = mounted.window; const select = w.document.getElementById('browserBridgePort') as HTMLSelectElement;
  select.focus(); select.value = '8767'; select.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  const background = w.document.getElementById('backgroundChats') as HTMLInputElement;
  background.checked = true; background.dispatchEvent(new w.Event('change', { bubbles: true }));
  release({ ok: false, error: 'Port 8767: EADDRINUSE' });
  await vi.waitFor(() => expect(calls).toHaveLength(2)); await settle();
  expect(calls[1].patch.ui.browserBridgePort).toBe(calls[1].base.ui.browserBridgePort);
  expect(select.value).toBe('auto'); expect(background.checked).toBe(true);
});

it('saves the ChatGPT browser choice from its settings control and restores it on state push', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const browser = w.document.getElementById('chatBrowser') as HTMLSelectElement;
  expect(browser.value).toBe('chrome'); // older config has no field
  browser.value = 'edge';
  browser.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].ui.chatBrowser).toBe('edge');
  expect(browser.value).toBe('edge');
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, chatBrowser: 'chrome' } } });
  expect(browser.value).toBe('chrome');
});

it('saves Auto-select Skills from Settings and restores it on state push', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const toggle = w.document.getElementById('autoSelectSkills') as HTMLInputElement;
  expect(toggle).not.toBeNull();
  expect(toggle.checked).toBe(false);
  toggle.checked = true;
  toggle.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].ui.autoSelectSkills).toBe(true);
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, autoSelectSkills: false } } });
  expect(toggle.checked).toBe(false);
});

it('saves and restores the global worker admission cap from Settings', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const globalWorkers = w.document.getElementById('globalMaWorkers') as HTMLInputElement;
  expect(globalWorkers.value).toBe('0');

  globalWorkers.value = '5';
  globalWorkers.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].multiAgent.globalMaxWorkers).toBe(5);

  mounted.push({
    ...mounted.state,
    config: {
      ...mounted.state.config,
      multiAgent: { ...mounted.state.config.multiAgent, globalMaxWorkers: 7 }
    }
  });
  expect(globalWorkers.value).toBe('7');
});

it('saves and clears ordinary new-chat model defaults from either selector independently', async () => {
  const catalog = {
    state: 'ready', requestedAt: 1, observedAt: 2,
    models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['high', 'xhigh'] }]
  };
  const mounted = await mountChat({}, [], { getChatModels: () => Promise.resolve({ ok: true, data: catalog }) });
  const w = mounted.window;
  const model = w.document.getElementById('defaultChatModel') as HTMLSelectElement;
  const reasoning = w.document.getElementById('defaultChatReasoning') as HTMLSelectElement;
  await vi.waitFor(() => expect([...model.options].map(option => option.value)).toContain('gpt-5.6-sol'));
  expect(model.value).toBe(''); expect(reasoning.value).toBe('');

  model.value = 'gpt-5.6-sol'; model.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].ui).toMatchObject({ defaultChatModel: 'gpt-5.6-sol' });
  expect(mounted.calls[0].ui.defaultChatReasoning).toBeUndefined();

  reasoning.value = 'xhigh'; reasoning.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(2));
  expect(mounted.calls[1].ui).toMatchObject({ defaultChatModel: 'gpt-5.6-sol', defaultChatReasoning: 'xhigh' });

  model.value = ''; model.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(3));
  expect(mounted.calls[2].ui.defaultChatModel).toBeUndefined();
  expect(mounted.calls[2].ui.defaultChatReasoning).toBeUndefined();
});

it('loads, explains and saves both command policy modes without losing rules', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const rules = w.document.getElementById('commandAllowlistRules') as HTMLTextAreaElement;
  const enabled = w.document.getElementById('commandAllowlistEnabled') as HTMLInputElement;
  const allow = w.document.getElementById('commandPolicyAllow') as HTMLButtonElement;
  const deny = w.document.getElementById('commandPolicyDeny') as HTMLButtonElement;
  const description = w.document.getElementById('commandPolicyDescription')!;
  const label = w.document.getElementById('commandPolicyRulesLabel')!;
  const error = w.document.getElementById('commandAllowlistError')!;

  mounted.state.config.commandAllowlist = { enabled: false, mode: 'deny', rules: ['dotnet *'] };
  mounted.push(structuredClone(mounted.state));
  expect(deny.getAttribute('aria-checked')).toBe('true');
  expect(rules.value).toBe('dotnet *');
  expect(description.textContent).toContain('may not start');
  expect(label.textContent).toContain('Blocked commands');

  rules.value = 'git status; whoami';
  rules.dispatchEvent(new w.Event('input', { bubbles: true }));
  rules.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  expect(error.hidden).toBe(false);
  expect(error.textContent).toContain('Line 1');
  expect(mounted.calls).toHaveLength(0);

  rules.value = 'git status\ngit diff *';
  rules.dispatchEvent(new w.Event('input', { bubbles: true }));
  allow.click();
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].commandAllowlist).toEqual({ enabled: false, mode: 'allow', rules: ['git status', 'git diff *'] });
  expect(description.textContent).toContain('Only commands matching');
  expect(label.textContent).toContain('Allowed commands');

  deny.click();
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(2));
  expect(mounted.calls[1].commandAllowlist).toEqual({ enabled: false, mode: 'deny', rules: ['git status', 'git diff *'] });
  expect(rules.value).toBe('git status\ngit diff *');
  enabled.checked = true;
  enabled.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(3));
  expect(mounted.calls[2].commandAllowlist).toEqual({ enabled: true, mode: 'deny', rules: ['git status', 'git diff *'] });
  expect(error.hidden).toBe(true);
});

it('shows the current host Desktop tools without rebuilding permission controls on state pushes', async () => {
  const mounted = await mountChat({
    platform: { family: 'windows', name: 'Windows', desktopAutomation: true }
  });
  const doc = mounted.window.document;
  const names = () => Array.from(doc.querySelectorAll('[data-group="desktop"] .tool-names code'), node => node.textContent);
  const control = doc.querySelector<HTMLInputElement>('[data-cap="control"]')!;
  const windowsNames = [...BROWSER_READ_TOOLS, 'list_windows', 'get_window', 'list_apps', 'get_window_state', ...BROWSER_WRITE_TOOLS,
    'launch_app', 'click', 'press_key', 'type_text', 'scroll', 'set_value', 'drag',
    'perform_secondary_action', 'activate_window', 'read_clipboard', 'write_clipboard', 'exec'];
  expect(names()).toEqual(windowsNames);
  mounted.push({ ...mounted.state, platform: { family: 'macos', name: 'macOS', desktopAutomation: true } });
  expect(names()).toEqual([...BROWSER_READ_TOOLS, 'observe', ...BROWSER_WRITE_TOOLS, 'computer', 'exec']);
  expect(doc.querySelector('[data-cap="control"]')).toBe(control);
  mounted.push(mounted.state);
  expect(names()).toEqual(windowsNames);
  expect(mounted.calls).toHaveLength(0);
});

it('preserves native Desktop permissions when saving unrelated settings on Linux', async () => {
  const mounted = await mountChat({
    platform: { family: 'linux', name: 'Linux', desktopAutomation: false }
  });
  const w = mounted.window;

  const desktopGroup = w.document.querySelector<HTMLElement>('[data-group="desktop"]')!;
  expect(desktopGroup.hidden).toBe(false);
  expect(w.document.querySelector<HTMLInputElement>('[data-cap="control"]')!.disabled).toBe(false);
  expect(w.document.querySelector<HTMLInputElement>('[data-cap="clipboardWrite"]')!.disabled).toBe(true);

  const autoConnect = w.document.getElementById('autoConnect') as HTMLInputElement;
  autoConnect.checked = true;
  autoConnect.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();

  expect(mounted.calls).toHaveLength(1);
  expect(mounted.calls[0].ui.autoConnect).toBe(true);
  expect(mounted.calls[0].capabilities).toMatchObject({
    screen: true,
    control: true,
    clipboardRead: true,
    clipboardWrite: true
  });
});

it('uses native menu-bar/Dock wording on macOS instead of Windows tray copy', async () => {
  const mounted = await mountChat({
    platform: { family: 'macos', name: 'macOS', desktopAutomation: true }
  });
  const doc = mounted.window.document;

  expect(doc.getElementById('backgroundRunningCopy')!.textContent).toContain('menu bar and Dock');
  expect(doc.getElementById('backgroundRunningCopy')!.textContent).not.toContain('tray');
  expect(doc.getElementById('minimizeToTrayCopy')!.textContent).toBe('Hide the window to the menu bar when closed');
});

it('surfaces the existing root rename API in the folder row', async () => {
  const renames: Array<[string, string]> = [];
  const mounted = await mountChat({}, [], {
    renameRoot: (name: string, newName: string) => {
      renames.push([name, newName]);
      return Promise.resolve({ ok: false, error: 'test stops before mutation' });
    }
  });
  const doc = mounted.window.document;
  const button = doc.querySelector<HTMLButtonElement>('.root button[title="Rename /repo"]');
  expect(button).not.toBeNull();

  button!.click();
  const input = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  input.value = 'New-Repo';
  input.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();

  expect(renames).toEqual([['repo', 'new-repo']]);
});

it('preserves an in-progress root rename across unrelated state pushes and cancels it if the root disappears', async () => {
  const renames: Array<[string, string]> = [];
  const mounted = await mountChat({}, [], {
    renameRoot: (name: string, newName: string) => {
      renames.push([name, newName]);
      return Promise.resolve({ ok: false, error: 'rename failed for retry test' });
    }
  });
  const doc = mounted.window.document;
  doc.querySelector<HTMLButtonElement>('.root button[title="Rename /repo"]')!.click();

  const original = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  original.value = 'new-name';
  original.setSelectionRange(3, 7);

  const unrelated = structuredClone(mounted.state) as any;
  unrelated.status.detail = 'unrelated live status push';
  mounted.push(unrelated);

  const preserved = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  expect(preserved).not.toBeNull();
  expect(doc.activeElement).toBe(preserved);
  expect(preserved.value).toBe('new-name');
  expect(preserved.selectionStart).toBe(3);
  expect(preserved.selectionEnd).toBe(7);

  preserved.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  expect(renames).toEqual([['repo', 'new-name']]);
  const retry = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  expect(retry.value).toBe('new-name');
  retry.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  expect(renames).toEqual([['repo', 'new-name'], ['repo', 'new-name']]);

  const escape = doc.querySelector<HTMLInputElement>('.root .root-rename')!;
  escape.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(doc.querySelector('.root-rename')).toBeNull();

  doc.querySelector<HTMLButtonElement>('.root button[title="Rename /repo"]')!.click();
  expect(doc.querySelector('.root-rename')).not.toBeNull();

  const removed = structuredClone(unrelated) as any;
  removed.config.roots = [];
  mounted.push(removed);
  expect(doc.querySelector('.root-rename')).toBeNull();
  expect(doc.querySelector('.root')).toBeNull();
});

/** Fake OpenRouter catalogue, already in the order the app is expected to keep. */
const catalogue = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `vendor${index}/model-${index}`,
    name: `Model ${index}`,
    created: 1_800_000_000 - index * 86_400,
    contextLength: 128_000
  }));

it('guides rootless setup from the capabilities that actually need a filesystem root', async () => {
  const mounted = await mountChat({ hasApiKey: true });
  const mixed = structuredClone(mounted.state) as any;
  mixed.hasApiKey = true;
  mixed.config.roots = [];
  mixed.config.readOnly = false;
  // ChatGPT's browser is Setup's first step; connected here so the folder step is the one judged.
  mixed.bridge = { ...mixed.bridge, present: true, paired: true, externalExtension: { present: true, version: mixed.update.current, lastSeenAt: Date.now(), signedIn: true } };
  for (const capability of Object.keys(mixed.config.capabilities)) mixed.config.capabilities[capability] = false;
  mixed.config.capabilities.browse = true;
  mixed.config.capabilities.screen = true;
  mixed.status.surfaces = [
    {
      id: 'core', connectorName: 'Core', description: '', cardSummary: '', optional: false,
      available: true, localUrl: null, publicUrl: null, tools: ['read'], state: 'off', detail: '',
      lastRequestAt: null, lastToolCallAt: null
    },
    {
      id: 'desktop', connectorName: 'Desktop', description: '', cardSummary: '', optional: true,
      available: true, localUrl: null, publicUrl: null, tools: ['observe'], state: 'off', detail: '',
      lastRequestAt: null, lastToolCallAt: null
    }
  ];

  mounted.push(mixed);
  mounted.window.document.getElementById('browserContinue')!.click();
  const connect = mounted.window.document.getElementById('connectionPopoverToggle') as HTMLButtonElement;
  expect(connect.disabled).toBe(true);
  expect(connect.title).toContain('Choose a folder');
  expect(mounted.window.document.querySelector('[data-step="folder"]')?.classList.contains('is-current')).toBe(true);

  const commandAndDesktop = structuredClone(mixed) as any;
  commandAndDesktop.config.capabilities.browse = false;
  commandAndDesktop.config.capabilities.command = true;
  mounted.push(commandAndDesktop);
  expect(connect.disabled).toBe(true);
  expect(connect.title).toContain('Choose a folder');

  const desktopOnly = structuredClone(mixed) as any;
  desktopOnly.config.capabilities.browse = false;
  mounted.push(desktopOnly);
  expect(connect.disabled).toBe(false);
  expect(connect.title).toBe('');

  const clipboardOnly = structuredClone(desktopOnly) as any;
  clipboardOnly.config.capabilities.screen = false;
  clipboardOnly.config.capabilities.clipboardRead = true;
  clipboardOnly.status.surfaces[1].tools = ['computer'];
  mounted.push(clipboardOnly);
  expect(connect.disabled).toBe(false);
});

it('fills an empty folder list with a place to choose one, not a blank', async () => {
  const pick = vi.fn(() => Promise.resolve({ ok: true, data: null }));
  const mounted = await mountChat({}, [], { addRoot: pick });
  const empty = structuredClone(mounted.state);
  empty.config.roots = [];
  mounted.push(empty);
  const doc = mounted.window.document;
  const invite = doc.querySelector<HTMLButtonElement>('#wizFolders .folder-empty')!;
  expect(invite.textContent).toBe('No folder shared yet. Choose one to start.');
  invite.click();
  await settle();
  expect(pick).toHaveBeenCalled();
  // With a folder shared, the list shows it instead.
  mounted.push(structuredClone(mounted.state));
  expect(doc.querySelector('#wizFolders .folder-empty')).toBeNull();
  expect(doc.getElementById('wizFolders')!.textContent).toBe('/repo');
});

it('ends Setup on Ready, which names what is still open and leads back to it', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  doc.querySelector<HTMLButtonElement>('[data-rail-step="ready"]')!.click();
  expect(doc.querySelector('[data-step="ready"]')!.classList.contains('is-open')).toBe(true);
  expect(doc.getElementById('readyTitle')!.textContent).toBe('Almost there');
  expect(doc.getElementById('readyStart')!.hidden).toBe(true);
  const pending = [...doc.querySelectorAll<HTMLButtonElement>('#readyChecks .ready-go')];
  expect(pending.length).toBeGreaterThan(0);
  expect(pending.map(button => button.textContent)).toContain('Step 5API key stored');
  pending.find(button => button.textContent!.includes('API key'))!.click();
  expect(doc.querySelector('[data-step="key"]')!.classList.contains('is-open')).toBe(true);
});

it('asks what ChatGPT can do in Setup, and read-only keeps it open with the reason', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const access = doc.querySelector<HTMLElement>('[data-step="access"]')!;
  const choice = (level: string) => doc.querySelector<HTMLButtonElement>(`[data-access="${level}"]`)!;

  // The fixture shares a folder with every permission on: the step is done, on Full access.
  expect(access.classList.contains('is-done')).toBe(true);
  expect(choice('full').getAttribute('aria-checked')).toBe('true');
  expect(doc.getElementById('accessNote')!.hidden).toBe(true);

  // Read-only, as an older install or a recovered settings file leaves it: the step is done (setup
  // can still end on all set), but it says why, and Ready says what is limited and how to change it.
  const readOnly = structuredClone(mounted.state);
  readOnly.config.readOnly = true;
  readOnly.settingsRecovered = true;
  mounted.push(readOnly);
  expect(access.classList.contains('is-done')).toBe(true);
  expect(choice('read').getAttribute('aria-checked')).toBe('true');
  expect(doc.getElementById('accessRecovered')!.hidden).toBe(false);
  expect(doc.getElementById('accessNote')!.classList.contains('is-warn')).toBe(true);
  expect(doc.getElementById('readyLimited')!.hidden).toBe(false);
  expect(doc.querySelector('#readyChecks .ready-check.is-passed.is-limited')!.textContent).toBe('ChatGPT can only read files');
  doc.getElementById('readyChangeAccess')!.click();
  expect(access.classList.contains('is-open')).toBe(true);

  // Files and terminal turns read-only off and Desktop off in one save.
  choice('files').click();
  await settle();
  const saved = mounted.calls.at(-1);
  expect(saved.readOnly).toBe(false);
  for (const cap of ['create', 'edit', 'move', 'deleteFile', 'command']) expect(saved.capabilities[cap], cap).toBe(true);
  for (const cap of ['screen', 'control', 'clipboardRead', 'clipboardWrite']) expect(saved.capabilities[cap], cap).toBe(false);

  // An unpublished Desktop card leads to the same step, not to Settings.
  const noDesktop = structuredClone(mounted.state);
  noDesktop.status.surfaces = [{ id: 'desktop', connectorName: 'Chat On Steroids Desktop', state: 'off', available: false, optional: true,
    detail: 'Turn on a Desktop permission.', cardSummary: 'Browser and desktop apps.', tools: [], lastRequestAt: null, lastToolCallAt: null }];
  mounted.push(noDesktop);
  [...doc.querySelectorAll<HTMLButtonElement>('#connectorCards .btn')].find(button => button.textContent === 'Change access')!.click();
  expect(access.classList.contains('is-open')).toBe(true);

  // A mix from Workspace without commands is custom, and named as what keeps ChatGPT from working.
  const custom = structuredClone(mounted.state);
  custom.config.capabilities.command = false;
  mounted.push(custom);
  for (const level of ['full', 'files', 'read']) expect(choice(level).getAttribute('aria-checked')).toBe('false');
  expect(doc.getElementById('readyLimited')!.hidden).toBe(false);
  expect(doc.getElementById('accessNote')!.textContent).toMatch(/^These permissions keep ChatGPT from editing files or running commands/);
});

it('requires external installation before choosing the built-in browser and signing in', async () => {
  const shown: unknown[] = [];
  const opened: Array<[string, unknown]> = [];
  const mounted = await mountChat({}, [], {
    showCosBrowser: () => { shown.push(true); return Promise.resolve({ ok: true, data: true }); },
    openChatGpt: () => { shown.push('external'); return Promise.resolve({ ok: true, data: true }); },
    signOutChatGpt: () => { shown.push('sign-out'); return Promise.resolve({ ok: true, data: true }); },
    openLink: (url: string, options: unknown) => { opened.push([url, options]); return Promise.resolve({ ok: true, data: true }); }
  });
  const document = mounted.window.document;
  const browserStep = document.querySelector<HTMLElement>('[data-step="browser"]')!;
  const visible = (variant: string) => [...browserStep.querySelectorAll<HTMLElement>(`[data-browser-variant="${variant}"]`)]
    .every(node => !node.hidden);
  expect(document.querySelector('#wizard > li.step')).toBe(browserStep);
  const checked = () => [...browserStep.querySelectorAll<HTMLElement>('[data-browser-choice]')]
    .filter(option => option.getAttribute('aria-checked') === 'true').map(option => option.dataset.browserChoice);
  // Two equal choices; with Chrome saved, the built-in browser is offered, not preselected.
  expect(checked()).toEqual(['extension']);

  const cos = structuredClone(mounted.state);
  cos.config.ui = { ...cos.config.ui, chatBrowser: 'cos' };
  cos.cosBrowserSignedIn = false;
  mounted.push(cos);
  expect(visible('cos')).toBe(true);
  expect(visible('extension')).toBe(false);
  expect(checked()).toEqual(['cos']);
  expect(browserStep.classList.contains('is-current')).toBe(true);
  expect(document.getElementById('cosBrowserState')!.textContent).toBe('Not signed in yet.');
  (document.getElementById('showCosBrowser') as HTMLButtonElement).click();
  expect(shown).toHaveLength(1);
  // Every page Setup opens in the built-in browser also offers the system's own browser.
  const others = [...document.querySelectorAll<HTMLButtonElement>('#wizard [data-link-external]')];
  expect(others.map(button => button.dataset.linkExternal)).toEqual([
    'https://platform.openai.com/settings/organization/tunnels',
    'https://platform.openai.com/settings/organization/api-keys',
    'https://chatgpt.com/plugins'
  ]);
  for (const other of others) {
    expect(other.hidden).toBe(false);
    expect(other.previousElementSibling?.getAttribute('data-link')).toBe(other.dataset.linkExternal);
  }
  others[0]!.click();
  expect(opened).toEqual([['https://platform.openai.com/settings/organization/tunnels', { external: true }]]);

  // Signed in is the user's part; the step is done once the companion has checked in too.
  mounted.push({ ...cos, cosBrowserSignedIn: true });
  expect(browserStep.classList.contains('is-done')).toBe(false);
  mounted.push({ ...cos, cosBrowserSignedIn: true, bridge: { ...cos.bridge, present: true } });
  expect(browserStep.classList.contains('is-done')).toBe(false);
  expect((document.getElementById('browserContinue') as HTMLButtonElement).disabled).toBe(true);
  const externalReady = { ...cos, cosBrowserSignedIn: true, bridge: { ...cos.bridge, present: true, paired: true,
    externalExtension: { present: true, version: cos.update.current, lastSeenAt: Date.now() } } };
  // The extension connecting moves the step on by itself; nobody has to find Continue.
  mounted.push(externalReady);
  expect((document.getElementById('browserLocationStage') as HTMLElement).hidden).toBe(false);
  // Chrome's extension answering is not the CoS browser's own copy reaching the app.
  expect(browserStep.classList.contains('is-done')).toBe(false);
  expect(document.getElementById('cosBrowserState')!.textContent).toBe('Signed in. Connecting to ChatGPT…');
  mounted.push({ ...externalReady, bridge: { ...externalReady.bridge, cosExtension: { present: true } } });
  expect(browserStep.classList.contains('is-done')).toBe(true);
  expect(document.getElementById('cosBrowserState')!.textContent).toBe('Signed in. ChatGPT is connected.');
  // Surely signed in, the same button signs out instead.
  const cosButton = document.getElementById('showCosBrowser') as HTMLButtonElement;
  expect(cosButton.textContent).toBe('Sign out of ChatGPT');
  expect(cosButton.classList.contains('btn-solid')).toBe(true);
  expect(cosButton.querySelector('i')!.className).toBe('ico ph ph-sign-out');
  cosButton.click();
  expect(shown.at(-1)).toBe('sign-out');

  // Chrome, Edge and Brave keep the extension instructions, and a way back to the built-in browser.
  const chrome = structuredClone(mounted.state);
  chrome.config.ui = { ...chrome.config.ui, chatBrowser: 'chrome' };
  mounted.push(chrome);
  expect(visible('extension')).toBe(true);
  expect(visible('cos')).toBe(false);
  expect([...document.querySelectorAll<HTMLElement>('#wizard [data-link-external]')].every(button => button.hidden)).toBe(true);
  expect(checked()).toEqual(['extension']);
  // Open ChatGPT opens it where the person chose: their own browser on this path. Being signed in
  // to the built-in browser does not make this one a sign-out.
  const externalButton = document.getElementById('openSelectedChatGpt') as HTMLButtonElement;
  expect(externalButton.textContent).toBe('Sign in to ChatGPT');
  expect(externalButton.classList.contains('btn-solid')).toBe(true);
  externalButton.click();
  expect(shown.at(-1)).toBe('external');
  // Only a certain answer from that browser turns it into a sign-out.
  mounted.push({ ...chrome, bridge: { ...chrome.bridge, externalExtension: { present: true, version: chrome.update.current, lastSeenAt: Date.now(), signedIn: true } } });
  expect(externalButton.textContent).toBe('Sign out of ChatGPT');
  externalButton.click();
  expect(shown.at(-1)).toBe('sign-out');
  mounted.push(chrome);
  expect(externalButton.textContent).toBe('Sign in to ChatGPT');
  (document.getElementById('useCosBrowser') as HTMLButtonElement).click();
  await settle();
  expect(mounted.calls.at(-1)?.ui?.chatBrowser).toBe('cos');

  // Installation choice is local until the person explicitly chooses where to run ChatGPT.
  mounted.push(cos);
  const savesBeforeInstallChoice = mounted.calls.length;
  (document.querySelector('[data-external-browser="edge"]') as HTMLButtonElement).click();
  await settle();
  expect(mounted.calls).toHaveLength(savesBeforeInstallChoice);
  mounted.push(cos);
  (document.getElementById('useExtensionBrowser') as HTMLButtonElement).click();
  await settle();
  expect(mounted.calls.at(-1)?.ui?.chatBrowser).toBe('edge');
});

it('preserves optional Desktop disclosures and inline screenshots across status pushes', async () => {
  const mounted = await mountChat();
  const state = structuredClone(mounted.state) as any;
  state.status.surfaces = [{
    id: 'desktop', connectorName: 'Desktop', description: 'Desktop control', cardSummary: '', optional: true,
    available: true, localUrl: null, publicUrl: null, tools: ['observe'], state: 'off', detail: '',
    lastRequestAt: null, lastToolCallAt: null
  }];
  mounted.push(state);
  const doc = mounted.window.document;
  const field = doc.getElementById('desktopTunnelField') as HTMLDetailsElement;
  expect(field.hidden).toBe(false);
  expect(field.open).toBe(false);
  // Desktop is shown like Core, never folded: its name and description are there to copy.
  expect(doc.querySelectorAll('#connectorCards details')).toHaveLength(0);
  expect(doc.querySelector('#connectorCards')!.textContent).toContain('Desktop');
  field.querySelector('summary')!.click();
  const guide = doc.querySelector('[data-setup-guide="tunnel"]')!;
  expect(guide.querySelectorAll('img')).toHaveLength(2);
  expect(doc.querySelectorAll('[data-setup-guide="developer"] img')).toHaveLength(1);
  expect(doc.querySelectorAll('[data-setup-guide="plugin"] img')).toHaveLength(4);
  // Each picture's places are the step's numbered moves.
  expect([...guide.querySelectorAll('.guide-move')].map(move => move.textContent)).toEqual(
    ['1Name it', '2Pick your ChatGPT workspace', '3Click Create', '4Copy the tunnel ID']);
  const image = guide.querySelector('img')!;
  mounted.push(structuredClone(state));
  expect(field.open).toBe(true);
  expect(guide.querySelector('img')).toBe(image);
  expect(image.src).toContain('tunnel-create.png');
  expect(mounted.calls).toEqual([]);
  mounted.push(structuredClone(state));
  expect(field.open).toBe(true);
});

it('highlights missing required setup fields while respecting drafts and a stored API key', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const tunnel = doc.getElementById('tunnelId') as HTMLInputElement;
  const key = doc.getElementById('apiKey') as HTMLInputElement;
  expect(tunnel.classList.contains('is-empty')).toBe(false);
  expect(key.classList.contains('is-empty')).toBe(true);
  expect(doc.getElementById('desktopTunnelId')!.classList.contains('setup-required')).toBe(false);

  tunnel.focus();
  tunnel.value = '  ';
  tunnel.dispatchEvent(new mounted.window.Event('input'));
  expect(tunnel.classList.contains('is-empty')).toBe(true);
  mounted.push(structuredClone(mounted.state));
  expect(tunnel.value).toBe('  ');
  expect(tunnel.classList.contains('is-empty')).toBe(true);
  tunnel.value = 'tunnel_draft';
  tunnel.dispatchEvent(new mounted.window.Event('input'));
  expect(tunnel.classList.contains('is-empty')).toBe(false);

  key.value = 'example-draft';
  key.dispatchEvent(new mounted.window.Event('input'));
  expect(key.classList.contains('is-empty')).toBe(false);
  key.value = '';
  key.dispatchEvent(new mounted.window.Event('input'));
  expect(key.classList.contains('is-empty')).toBe(true);
  mounted.push({ ...structuredClone(mounted.state), hasApiKey: true });
  expect(key.classList.contains('is-empty')).toBe(false);
  expect(key.getAttribute('aria-required')).toBe('false');
  mounted.push({ ...structuredClone(mounted.state), hasApiKey: false });
  expect(key.classList.contains('is-empty')).toBe(true);
  expect(mounted.keys).toEqual([]);
  expect(mounted.calls).toEqual([]);
});

it('names every connector ChatGPT never called, joined in the UI language', async () => {
  const mounted = await mountChat({ hasApiKey: true });
  const doc = mounted.window.document;
  const surface = (id: string, connectorName: string, optional: boolean, called: boolean) => ({
    id, connectorName, description: '', cardSummary: '', optional, available: true, localUrl: null, publicUrl: null, tools: ['read'],
    state: 'live', detail: '', lastRequestAt: called ? Date.now() - 60_000 : null, lastToolCallAt: called ? Date.now() - 60_000 : null, proof: null
  });
  const state = structuredClone(mounted.state);
  state.status.state = 'connected';
  state.status.lastRequestAt = Date.now() - 60_000;
  state.status.lastToolCallAt = Date.now() - 60_000;
  state.status.surfaces = [surface('core', 'Core', false, true), surface('desktop', 'Desktop', true, false), surface('plugins', 'Plugins', true, false)];
  mounted.push(state);
  const note = () => doc.getElementById('wizChatgpt')!.textContent!;
  expect(note()).toContain('“Desktop” and “Plugins” have never been called — create them in ChatGPT');
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  try {
    // One language throughout: no English "and", and the plural grammar.
    expect(note()).toContain('“Desktop” und “Plugins” wurden noch nie aufgerufen – lege sie in ChatGPT an');
  } finally { setLanguage('en'); }
  const single = structuredClone(state);
  single.status.surfaces = [surface('core', 'Core', false, true), surface('desktop', 'Desktop', true, false)];
  mounted.push(single);
  expect(note()).toContain('“Desktop” has never been called — create it in ChatGPT');
});

it('counts a plugin ChatGPT used in an earlier run, so a restart does not reopen Setup', async () => {
  const mounted = await mountChat({ hasApiKey: true });
  const doc = mounted.window.document;
  const core = {
    id: 'core', connectorName: 'Core', description: '', cardSummary: '', optional: false,
    available: true, localUrl: null, publicUrl: null, tools: ['read'], state: 'live', detail: '',
    lastRequestAt: null, lastToolCallAt: null, proof: null as null | { requestAt: number; toolCallAt: number }
  };
  // Just restarted: connected, but ChatGPT has not called again yet in this run.
  const restarted = structuredClone(mounted.state);
  restarted.status.state = 'connected';
  restarted.status.lastRequestAt = null;
  restarted.bridge = { ...restarted.bridge, present: true, paired: true, externalExtension: { present: true, version: restarted.update.current, lastSeenAt: Date.now(), signedIn: true } };
  restarted.status.surfaces = [core];
  mounted.push(restarted);
  const chatgpt = doc.querySelector('[data-step="chatgpt"]')!;
  expect(chatgpt.classList.contains('is-done')).toBe(false);
  expect(doc.getElementById('readyTitle')!.textContent).toBe('Almost there');

  const yesterday = Date.now() - 86_400_000;
  const proven = structuredClone(restarted);
  proven.status.surfaces = [{ ...core, proof: { requestAt: yesterday, toolCallAt: yesterday } }];
  mounted.push(proven);
  expect(chatgpt.classList.contains('is-done')).toBe(true);
  expect(doc.getElementById('readyTitle')!.textContent).toBe('You’re all set!');
  expect(doc.getElementById('wizChatgpt')!.textContent).toMatch(/whole chain works/);

  // ChatGPT listing the plugin is enough: Setup does not ask for a test message.
  const listed = structuredClone(restarted);
  listed.status.surfaces = [{ ...core, proof: { requestAt: null, toolCallAt: null, installedAt: yesterday } as any }];
  mounted.push(listed);
  expect(chatgpt.classList.contains('is-done')).toBe(true);
  expect(doc.getElementById('readyTitle')!.textContent).toBe('You’re all set!');
  expect(doc.getElementById('wizChatgpt')!.textContent).toMatch(/plugin is in your ChatGPT/);

  // Deleted in ChatGPT: the plugins list no longer names it, the proof goes and the step reopens.
  mounted.push(structuredClone(restarted));
  expect(chatgpt.classList.contains('is-done')).toBe(false);
});

// Mounts the whole app many times over; under a fully parallel suite that alone can pass 30 s.
it('recognizes a finished first step after a restart from live or lasting evidence, without a click', async () => {
  type External = { present: boolean; version: string | null; lastSeenAt: number | null; signedIn?: boolean | null;
    proof?: { version: string; signedIn: boolean } | null };
  // Each scenario is a fresh launch: main.ts binds to the window it is first imported into.
  const launch = async (overrides: Record<string, unknown> = {}) => { vi.resetModules(); return mountChat(overrides, []); };
  const scenario = async (browser: 'chrome' | 'cos', external: External | null, extra: Record<string, unknown> = {}) => {
    const mounted = await launch();
    const state = structuredClone(mounted.state);
    state.config.ui = { ...state.config.ui, chatBrowser: browser };
    state.bridge = { ...state.bridge, running: true, paired: true, present: true, externalExtension: external, ...extra };
    mounted.push(state);
    const doc = mounted.window.document;
    return {
      done: doc.querySelector('[data-step="browser"]')!.classList.contains('is-done'),
      choosing: !(doc.getElementById('browserLocationStage') as HTMLElement).hidden,
      status: doc.getElementById('extensionStatus')!.textContent,
      version: state.update.current
    };
  };
  const now = Date.now();
  const app = (await launch()).state.update.current as string;
  const old = '0.0.1';

  // Chrome closed, but this browser had the extension and ChatGPT answered signed in there.
  let result = await scenario('chrome', { present: false, version: null, lastSeenAt: null, signedIn: null, proof: { version: app, signedIn: true } });
  expect(result).toMatchObject({ done: true, choosing: true, status: 'Extension installed and up to date' });
  // Chrome open with no ChatGPT tab: no live answer, the lasting one stands.
  result = await scenario('chrome', { present: true, version: app, lastSeenAt: now, signedIn: null, proof: { version: app, signedIn: true } });
  expect(result).toMatchObject({ done: true, status: 'Extension connected and up to date' });
  // A live signed-out answer wins over the lasting one.
  result = await scenario('chrome', { present: true, version: app, lastSeenAt: now, signedIn: false, proof: { version: app, signedIn: true } });
  expect(result.done).toBe(false);
  // Never signed in there.
  result = await scenario('chrome', { present: true, version: app, lastSeenAt: now, signedIn: null, proof: { version: app, signedIn: false } });
  expect(result.done).toBe(false);
  // An old extension, live or remembered, asks to update and opens on the install part.
  result = await scenario('chrome', { present: true, version: old, lastSeenAt: now, signedIn: true, proof: { version: app, signedIn: true } });
  expect(result).toMatchObject({ done: false, choosing: false, status: 'Update your extension' });
  result = await scenario('chrome', { present: false, version: null, lastSeenAt: null, proof: { version: old, signedIn: true } });
  expect(result).toMatchObject({ done: false, choosing: false, status: 'Update your extension' });
  // No extension ever: the install part, waiting.
  result = await scenario('chrome', null);
  expect(result).toMatchObject({ done: false, choosing: false, status: 'Waiting for the browser extension' });

  // Built-in: the extension proven, signed in in its own jar, and its own copy reaching the app.
  const proven = { present: false, version: null, lastSeenAt: null, proof: { version: app, signedIn: true } };
  result = await scenario('cos', proven, { cosBrowserSignedIn: undefined, cosExtension: { present: true } });
  expect(result.done).toBe(false);
  const cos = async (signedIn: boolean | null, cosPresent: boolean) => {
    const mounted = await launch({ cosBrowserSignedIn: signedIn });
    const state = structuredClone(mounted.state);
    state.config.ui = { ...state.config.ui, chatBrowser: 'cos' };
    state.cosBrowserSignedIn = signedIn;
    state.bridge = { ...state.bridge, running: true, paired: true, present: true, externalExtension: proven, cosExtension: { present: cosPresent } };
    mounted.push(state);
    return mounted.window.document.querySelector('[data-step="browser"]')!.classList.contains('is-done');
  };
  expect(await cos(true, true)).toBe(true);
  expect(await cos(true, false)).toBe(false);
  expect(await cos(false, true)).toBe(false);
}, 60_000);

// Mounts the whole app many times over; under a fully parallel suite that alone can pass 30 s.
it('reports each path’s own sign-in, whatever the other browser says, and keeps a logout a logout', async () => {
  vi.resetModules();
  const mounted = await mountChat({}, []);
  const doc = mounted.window.document;
  const app = mounted.state.update.current as string;
  const step = doc.querySelector('[data-step="browser"]')!;
  type Answer = boolean | null;
  const paint = (where: 'cos' | 'chrome', cos: { signedIn: Answer; connected: boolean },
    external: { live: boolean; answer: Answer; proof: Answer }) => {
    const state = structuredClone(mounted.state);
    state.config.ui = { ...state.config.ui, chatBrowser: where };
    state.cosBrowserSignedIn = cos.signedIn;
    state.bridge = { ...state.bridge, running: true, paired: true, present: true, cosExtension: { present: cos.connected },
      externalExtension: { present: external.live, version: external.live ? app : null, lastSeenAt: external.live ? Date.now() : null,
        signedIn: external.answer, proof: { version: app, signedIn: external.proof } } };
    mounted.push(state);
    const status = doc.getElementById(where === 'cos' ? 'cosBrowserState' : 'externalBrowserState')!;
    return { done: step.classList.contains('is-done'), text: status.textContent, tone: status.dataset.tone };
  };
  const anyExternal = [
    { live: true, answer: true, proof: true }, { live: true, answer: false, proof: false },
    { live: true, answer: null, proof: null }, { live: false, answer: null, proof: null }
  ];
  // Built-in: only its own jar and its own companion count; Chrome's sign-in changes nothing.
  for (const external of anyExternal) {
    expect(paint('cos', { signedIn: true, connected: true }, external)).toEqual({ done: true, text: 'Signed in. ChatGPT is connected.', tone: 'ok' });
    expect(paint('cos', { signedIn: true, connected: false }, external)).toEqual({ done: false, text: 'Signed in. Connecting to ChatGPT…', tone: 'wait' });
    expect(paint('cos', { signedIn: false, connected: true }, external)).toEqual({ done: false, text: 'Not signed in yet.', tone: 'wait' });
    expect(paint('cos', { signedIn: null, connected: true }, external)).toEqual({ done: false, text: 'Starting the built-in browser…', tone: 'wait' });
  }
  // Your browser: only ChatGPT's answer there counts; the built-in browser's sign-in changes nothing.
  for (const cos of [{ signedIn: true, connected: true }, { signedIn: false, connected: false }, { signedIn: null, connected: false }]) {
    expect(paint('chrome', cos, { live: true, answer: true, proof: true })).toEqual({ done: true, text: 'Signed in. ChatGPT is connected.', tone: 'ok' });
    expect(paint('chrome', cos, { live: true, answer: false, proof: false })).toEqual({ done: false, text: 'Not signed in to ChatGPT in Chrome.', tone: 'wait' });
    // A live logout wins over an older sign-in.
    expect(paint('chrome', cos, { live: true, answer: false, proof: true }).done).toBe(false);
    // No tab open: the last answer stands, whichever it was.
    expect(paint('chrome', cos, { live: true, answer: null, proof: true })).toEqual({ done: true, text: 'Signed in. ChatGPT is connected.', tone: 'ok' });
    expect(paint('chrome', cos, { live: true, answer: null, proof: false })).toEqual({ done: false, text: 'Not signed in to ChatGPT in Chrome.', tone: 'wait' });
    expect(paint('chrome', cos, { live: true, answer: null, proof: null })).toEqual({ done: false, text: 'Open ChatGPT in Chrome to check the sign-in.', tone: 'wait' });
    // Browser closed: the same answers, without claiming a live connection.
    expect(paint('chrome', cos, { live: false, answer: null, proof: true })).toEqual({ done: true, text: 'Signed in.', tone: 'ok' });
    expect(paint('chrome', cos, { live: false, answer: null, proof: false })).toEqual({ done: false, text: 'Not signed in to ChatGPT in Chrome.', tone: 'wait' });
    expect(paint('chrome', cos, { live: false, answer: null, proof: null })).toEqual({ done: false, text: 'Open ChatGPT in Chrome to check the sign-in.', tone: 'wait' });
  }
}, 60_000);

it('keeps folder access discoverable after setup and navigates without granting access', async () => {
  const addRoot = vi.fn();
  const mounted = await mountChat({ hasApiKey: true }, [], { addRoot });
  const connected = structuredClone(mounted.state);
  connected.status.state = 'connected';
  connected.status.lastRequestAt = Date.now();
  connected.bridge = { ...connected.bridge, present: true, paired: true, externalExtension: { present: true, version: connected.update.current, lastSeenAt: Date.now(), signedIn: true } };
  mounted.push(connected);
  mounted.window.document.getElementById('browserContinue')!.click();
  mounted.window.document.querySelector<HTMLButtonElement>('[data-rail-step=ready]')!.click();
  const doc = mounted.window.document;
  const styles = doc.createElement('style');
  styles.textContent = await fs.readFile(path.join(process.cwd(), 'src/renderer/styles.css'), 'utf8');
  doc.head.append(styles);
  doc.querySelector<HTMLButtonElement>('[data-tab="setup"]')!.click();

  // A finished setup opens on its proof: every check passed, and the way into a chat. There is
  // no guide to hide any more; each step stays one click away on the rail.
  expect(doc.getElementById('wizExpand')).toBeNull();
  expect(doc.querySelector('[data-step="ready"]')!.classList.contains('is-open')).toBe(true);
  // A finished setup leads with its proof: every check passed, and the way into a chat.
  expect(doc.getElementById('readyTitle')!.textContent).toBe('You’re all set!');
  expect(doc.getElementById('readyStart')!.hidden).toBe(false);
  expect(doc.querySelectorAll('#readyChecks .ready-check.is-passed')).toHaveLength(7);
  expect(mounted.window.getComputedStyle(doc.getElementById('readyChecks')!).display).not.toBe('none');
  doc.querySelector<HTMLButtonElement>('[data-rail-step="folder"]')!.click();
  const manage = doc.getElementById('wizManageFolders')!;
  expect(mounted.window.getComputedStyle(manage.parentElement!).display).not.toBe('none');
  expect(doc.getElementById('wizFolders')!.textContent).toBe('/repo');
  manage.click();

  expect(doc.querySelector('.panel.is-active')?.getAttribute('data-panel')).toBe('home');
  expect(doc.activeElement).toBe(doc.getElementById('addFolder'));
  expect(doc.getElementById('rootList')!.textContent).toContain('/repo');
  expect(addRoot).not.toHaveBeenCalled();
  expect(mounted.calls).toEqual([]);
});

it('keeps the app-wide options on the General page, not in Setup, and saves them from there', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const general = doc.querySelector('[data-panel="general"]')!;
  const setup = doc.querySelector('[data-panel="setup"]')!;
  for (const id of ['followOutput', 'playfulStatus', 'mentionCore', 'privacyScreenshots', 'developerMode', 'controlApiEnabled', 'controlApiAllowActions']) {
    expect(general.contains(doc.getElementById(id)), id).toBe(true);
    expect(setup.contains(doc.getElementById(id)), id).toBe(false);
  }
  doc.querySelector<HTMLButtonElement>('#tabs [data-tab="general"]')!.click();
  expect(doc.querySelector('.panel.is-active')?.getAttribute('data-panel')).toBe('general');
  expect(doc.querySelector('#tabs [data-tab="general"]')!.classList.contains('is-sel')).toBe(true);
  // Allow actions needs the control API first.
  expect(doc.getElementById('controlApiAllowActions')!.hasAttribute('disabled')).toBe(true);
  const follow = doc.getElementById('followOutput') as HTMLInputElement;
  expect(follow.checked).toBe(true);
  follow.checked = false;
  follow.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls.at(-1)?.ui.followOutput).toBe(false));
});

it('always requires the live browser because recording is an invariant', async () => {
  const mounted = await mountChat({
    hasApiKey: true,
    status: {
      state: 'connected',
      detail: 'Connected.',
      publicUrl: null,
      localUrl: 'http://127.0.0.1:1234',
      handshakeAt: Date.now(),
      lastRequestAt: Date.now(),
      lastToolCallAt: Date.now(),
      health: null,
      surfaces: [
        {
          id: 'core', connectorName: 'Core', description: '', cardSummary: '', optional: false,
          available: true, localUrl: 'http://127.0.0.1:1234', publicUrl: null, tools: ['read', 'update_plan'],
          state: 'live', detail: '', lastRequestAt: Date.now(), lastToolCallAt: Date.now()
        }
      ]
    },
    // The token survived, but this process has not heard from the extension. This is the
    // disabled/uninstalled-extension-after-app-restart repro.
    bridge: { running: true, port: 8765, paired: true, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.0.2', latest: null, stage: 'idle', error: null, checkedAt: null }
  });
  const doc = mounted.window.document;
  const browserStep = doc.querySelector<HTMLElement>('[data-step="browser"]')!;

  expect(browserStep.classList.contains('is-done')).toBe(false);
  expect(browserStep.classList.contains('is-current')).toBe(true);
  expect(doc.getElementById('bridgeState')!.textContent).toContain('Authorized');
  expect(doc.getElementById('bridgeState')!.textContent).not.toContain('Connected.');

  const live = structuredClone(mounted.state) as any;
  live.hasApiKey = true;
  live.status = (mounted.state as any).status;
  live.bridge = { running: true, port: 8765, paired: true, present: true, lastSeenAt: Date.now(), externalExtension: { present: true, version: live.update.current, lastSeenAt: Date.now(), signedIn: true } };
  mounted.push(live);
  doc.getElementById('browserContinue')!.click();
  expect(browserStep.classList.contains('is-done')).toBe(true);
  expect(doc.getElementById('bridgeState')!.textContent).toContain('Connected.');

  // Even a legacy/hand-built renderer snapshot cannot turn recording off. Main normalizes this
  // shape before publication; the renderer's setup predicate still fails closed if it sees one.
  const browserFree = structuredClone(live) as any;
  browserFree.config.sessions.record = false;
  browserFree.config.multiAgent.enabled = false;
  browserFree.config.capabilities.screen = false;
  browserFree.config.capabilities.control = false;
  browserFree.config.goal.enabled = true;
  browserFree.bridge = { running: false, port: null, paired: true, present: false, lastSeenAt: Date.now() };
  mounted.push(browserFree);
  expect(browserStep.hidden).toBe(false);
  expect(browserStep.classList.contains('is-current')).toBe(true);
  expect(doc.getElementById('bridgeState')!.textContent).not.toContain('not needed');
  expect((doc.getElementById('chatAutomation') as HTMLSelectElement).disabled).toBe(false);
  expect(doc.getElementById('chatAutomation')!.title).toContain('Continue');
});

/**
 * "Up to date" is a claim, and a claim needs somebody to have checked.
 *
 * Before GitHub answers, `{latest: null, stage: 'idle'}` means only that nothing has been
 * established - the same record a check that never ran would leave - so the Activity line stays
 * empty and no notification is shown. The timestamp is what turns that silence into an answer.
 */
it('says nothing about being current until the check has actually answered', async () => {
  const mounted = await mountChat({
    bridge: { running: true, port: 8765, paired: true, present: true, lastSeenAt: Date.now(), extensionVersion: '2.0.2' }
  });
  const doc = mounted.window.document;
  const line = doc.getElementById('updateLine')!;
  expect(line.hidden).toBe(true);
  expect(doc.querySelector('.toast')).toBeNull();

  const checked = structuredClone(mounted.state) as any;
  checked.update.checkedAt = Date.now();
  mounted.push(checked);

  // Green, both versions, and the same sentence as the one notification this window shows.
  expect(line.hidden).toBe(false);
  expect(line.className).toBe('upline is-ok');
  expect(line.textContent).toBe('Up to date! Chat On Steroids 2.0.2 · extension 2.0.2');
  expect(doc.querySelector('.toast')!.textContent).toBe(line.textContent);
  // Nothing to act on, so the header bar stays out of the way.
  expect(doc.getElementById('updateNotice')!.hidden).toBe(true);

  // The news is told once. A later push of the same fact repaints the line and nothing else.
  doc.querySelector('.toast')!.remove();
  mounted.push(structuredClone(checked) as any);
  expect(doc.querySelector('.toast')).toBeNull();
  expect(line.textContent).toBe('Up to date! Chat On Steroids 2.0.2 · extension 2.0.2');
});

/**
 * A staged update is not "up to date", and it is not a failure either.
 */
it('reports a staged update in the Activity line and the header bar', async () => {
  const mounted = await mountChat();
  const staged = structuredClone(mounted.state) as any;
  staged.update = { current: '2.0.2', latest: '2.0.3', stage: 'ready', error: null, checkedAt: Date.now() };
  mounted.push(staged);

  const doc = mounted.window.document;
  const line = doc.getElementById('updateLine')!;
  expect(line.className).toBe('upline');
  expect(line.textContent).toContain('2.0.3 is downloaded and ready');
  expect(doc.getElementById('updateNotice')!.hidden).toBe(false);
  // There is nothing to fetch by hand once it is on disk.
  expect((doc.getElementById('updateGet') as HTMLButtonElement).hidden).toBe(true);
  // ...and this is the one state in which there is something to install. Both buttons show,
  // because a tray app closed to the tray may not see the header for days.
  expect((doc.getElementById('updateInstall') as HTMLButtonElement).hidden).toBe(false);
  expect((doc.getElementById('installUpdate') as HTMLButtonElement).hidden).toBe(false);

  const checking = structuredClone(staged) as any;
  checking.update.stage = 'checking';
  mounted.push(checking);
  expect(line.textContent).toContain('Checking for the latest update');
  expect(line.textContent).not.toContain('by hand');
  expect((doc.getElementById('updateGet') as HTMLButtonElement).hidden).toBe(true);
  expect((doc.getElementById('updateInstall') as HTMLButtonElement).hidden).toBe(true);
  // Still downloading is not yet installable: there is no verified file to hand over.
  const downloading = structuredClone(staged) as any;
  downloading.update = { ...downloading.update, stage: 'downloading' };
  mounted.push(downloading);
  expect((doc.getElementById('updateInstall') as HTMLButtonElement).hidden).toBe(true);
  expect((doc.getElementById('installUpdate') as HTMLButtonElement).hidden).toBe(true);

  const broken = structuredClone(staged) as any;
  broken.update = { current: '2.0.2', latest: null, stage: 'failed', error: 'latest answered 503', checkedAt: null };
  mounted.push(broken);
  expect(line.className).toBe('upline is-bad');
  expect(line.textContent).toContain('503');
  // A check that could not reach GitHub is a diagnostic, not something the user can act on.
  expect(doc.getElementById('updateNotice')!.hidden).toBe(true);
  expect((doc.getElementById('installUpdate') as HTMLButtonElement).hidden).toBe(true);
});

/**
 * The version difference has a direction, and only one of them is the user's to act on.
 *
 * An extension newer than the app is the ordinary state while an app update is downloading, and
 * the bundled folder is then the older copy: "load the extension folder again" would talk that
 * user into downgrading a working extension. The app-update line already owns being behind.
 */
it('asks for an extension reload only when the extension is older than this app', async () => {
  const mounted = await mountChat({
    bridge: {
      running: true, port: 8765, paired: true, present: true, lastSeenAt: Date.now(), extensionVersion: '2.0.1'
    }
  });
  const doc = mounted.window.document;
  const notice = doc.getElementById('updateNotice')!;
  expect(notice.hidden).toBe(false);
  expect(doc.getElementById('updateText')!.textContent).toContain('2.0.1');
  const action = doc.getElementById('updateExtension') as HTMLButtonElement;
  expect(action.hidden).toBe(false);
  action.click();
  expect(doc.querySelector('[data-panel="setup"]')!.classList.contains('is-active')).toBe(true);
  const rejected = structuredClone(mounted.state) as any;
  rejected.bridge.present = false;
  mounted.push(rejected);
  expect(notice.hidden, 'an old companion rejected by the protocol gate still needs an update').toBe(false);

  const ahead = structuredClone(mounted.state) as any;
  ahead.bridge.extensionVersion = '2.0.3';
  mounted.push(ahead);
  expect(notice.hidden, 'a newer extension is not a downgrade prompt').toBe(true);
  expect(action.hidden).toBe(true);
});

it('shows a missing-extension reminder while connected and clears it after the companion reports in', async () => {
  const mounted = await mountChat();
  const connected = structuredClone(mounted.state) as any;
  connected.status.state = 'connected'; connected.bridge.running = true; connected.bridge.present = false;
  mounted.push(connected);
  const doc = mounted.window.document;
  expect(doc.getElementById('updateText')!.textContent).toContain('Browser extension not connected');
  expect(doc.getElementById('updateExtension')!.hidden).toBe(false);
  connected.bridge.present = true; connected.bridge.extensionVersion = connected.update.current;
  mounted.push(connected);
  expect(doc.getElementById('updateNotice')!.hidden).toBe(true);
});

it('keeps plugin connection controls out of general Setup and preserves its tunnel during unrelated saves', async () => {
  const mounted = await mountChat(); const doc = mounted.window.document;
  const next = structuredClone(mounted.state); next.config.tunnel.pluginsTunnelId = 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  mounted.push(next);
  expect(doc.querySelector('[data-panel="setup"] #pluginsTunnelId')).toBeNull();
  const input = doc.getElementById('tunnelId') as HTMLInputElement;
  input.value = 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  input.dispatchEvent(new mounted.window.Event('change')); await settle();
  expect(mounted.calls.at(-1).tunnel.pluginsTunnelId).toBe(next.config.tunnel.pluginsTunnelId);
  expect(doc.querySelector('[data-panel="setup"] [data-link="https://chatgpt.com/plugins"]')).not.toBeNull();
});

/**
 * The exact sentence, because it is the same sentence the composer's settings sheet shows
 * and the two are meant to be recognisably one message rather than two paraphrases.
 */
it('reports stored API credentials without exposing app-wide Goal switches', async () => {
  const mounted = await mountChat();
  expect(mounted.window.document.getElementById('goalEnabled')).toBeNull();
  expect((mounted.window.document.getElementById('goalKeyRemove') as HTMLButtonElement).disabled).toBe(true);

  mounted.push({ ...mounted.state, hasGoalKey: true });
  await settle();
  expect(mounted.window.document.getElementById('goalKeyState')!.textContent).toContain('A key is stored');
  expect((mounted.window.document.getElementById('goalKeyRemove') as HTMLButtonElement).disabled).toBe(false);
});

/**
 * The key goes to the one channel that encrypts it and never to the settings file. This is
 * the whole reason the goal request is made by the app and not by the extension, so it is
 * worth an assertion rather than a comment.
 */
it('sends the key to the secret store and never into the settings patch', async () => {
  const mounted = await mountChat();
  const field = mounted.window.document.getElementById('goalKey') as HTMLInputElement;
  field.value = 'sk-or-v1-not-a-real-key';
  field.dispatchEvent(new mounted.window.Event('blur'));
  await settle();

  expect(mounted.keys).toEqual([{ method: 'setGoalKey', value: 'sk-or-v1-not-a-real-key' }]);
  // Cleared from the input as well: a stored key has no reason to stay on screen.
  expect(field.value).toBe('');
  expect(JSON.stringify(mounted.calls)).not.toContain('sk-or-v1');
});

it('keeps secret-key input on secure-storage failure', async () => {
  const failed = await mountChat({}, [], {
    setGoalKey: () => Promise.resolve({ ok: false, error: 'safeStorage unavailable' }),
    setApiKey: () => Promise.resolve({ ok: false, error: 'safeStorage unavailable' })
  });
  const goalFailed = failed.window.document.getElementById('goalKey') as HTMLInputElement;
  goalFailed.value = 'sk-or-v1-retry-me';
  goalFailed.dispatchEvent(new failed.window.Event('blur'));
  const apiFailed = failed.window.document.getElementById('apiKey') as HTMLInputElement;
  apiFailed.value = 'sk-retry-me';
  apiFailed.dispatchEvent(new failed.window.Event('blur'));
  await settle();
  expect(goalFailed.value).toBe('sk-or-v1-retry-me');
  expect(apiFailed.value).toBe('sk-retry-me');
});

it('never lets an older secret save erase a newer value typed while IPC is in flight', async () => {
  let releaseGoal!: (value: any) => void;
  let releaseApi!: (value: any) => void;
  const deferred = await mountChat({}, [], {
    setGoalKey: () => new Promise((resolve) => (releaseGoal = resolve)),
    setApiKey: () => new Promise((resolve) => (releaseApi = resolve))
  });
  const goal = deferred.window.document.getElementById('goalKey') as HTMLInputElement;
  goal.value = 'sk-or-v1-old';
  goal.dispatchEvent(new deferred.window.Event('blur'));
  goal.value = 'sk-or-v1-new';
  const api = deferred.window.document.getElementById('apiKey') as HTMLInputElement;
  api.value = 'sk-old';
  api.dispatchEvent(new deferred.window.Event('blur'));
  api.value = 'sk-new';

  releaseGoal({ ok: true, data: { ...deferred.state, hasGoalKey: true } });
  releaseApi({ ok: true, data: { ...deferred.state, hasApiKey: true } });
  await settle();
  await settle();
  expect(goal.value).toBe('sk-or-v1-new');
  expect(api.value).toBe('sk-new');
});

it('does not turn whitespace in the OpenRouter key field into a remove-key request', async () => {
  const mounted = await mountChat({ hasGoalKey: true });
  const field = mounted.window.document.getElementById('goalKey') as HTMLInputElement;
  field.value = '   ';
  field.dispatchEvent(new mounted.window.Event('blur'));
  await settle();
  expect(mounted.keys).toEqual([]);
  expect(field.value).toBe('   ');
});

it('opens, saves and restores the editable goal prompt', async () => {
  const mounted = await mountChat({ hasGoalKey: true });
  const doc = mounted.window.document;
  const panel = doc.getElementById('goalPromptPanel')!;
  const edit = doc.getElementById('goalPromptEdit') as HTMLButtonElement;
  const prompt = doc.getElementById('goalPrompt') as HTMLTextAreaElement;

  expect(panel.hidden).toBe(true);
  edit.click();
  expect(panel.hidden).toBe(false);
  expect(prompt.value).toBe(DEFAULT_GOAL_SYSTEM_PROMPT);

  prompt.value = 'custom gate: continue only explicit missing work. otherwise NO_REPLY.';
  prompt.dispatchEvent(new mounted.window.Event('change'));
  await settle();
  await settle();
  expect(mounted.calls.at(-1)?.goal.prompt).toBe(prompt.value);

  (doc.getElementById('goalPromptReset') as HTMLButtonElement).click();
  await settle();
  await settle();
  expect(prompt.value).toBe(DEFAULT_GOAL_SYSTEM_PROMPT);
  expect(mounted.calls.at(-1)?.goal.prompt).toBe(DEFAULT_GOAL_SYSTEM_PROMPT);
});

it('asks before Clear workers ends running workers and removes their histories', async () => {
  const resetSwarm = vi.fn(async () => ({ ok: true as const, data: { running: false, agents: [], retainedHistory: false } }));
  const mounted = await mountChat({ hasGoalKey: true }, [], { resetSwarm });
  const w = mounted.window;
  const button = w.document.getElementById('swarmReset') as HTMLButtonElement;
  button.disabled = false;
  const confirm = vi.fn(() => false);
  w.confirm = confirm;
  button.click();
  await settle();
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('removed for good'));
  expect(resetSwarm).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  button.click();
  await settle();
  expect(resetSwarm).toHaveBeenCalledTimes(1);
});

it('opens, saves and restores the editable handoff prompt', async () => {
  const mounted = await mountChat({ hasGoalKey: true });
  const doc = mounted.window.document;
  const panel = doc.getElementById('handoffPromptPanel')!;
  const edit = doc.getElementById('handoffPromptEdit') as HTMLButtonElement;
  const prompt = doc.getElementById('handoffPrompt') as HTMLTextAreaElement;

  expect(panel.hidden).toBe(true);
  edit.click();
  expect(panel.hidden).toBe(false);
  expect(prompt.value).toBe(DEFAULT_HANDOFF_PROMPT);

  prompt.value = 'Keep only continuation-critical state and the exact next action.';
  prompt.dispatchEvent(new mounted.window.Event('change'));
  await settle();
  await settle();
  expect(mounted.calls.at(-1)?.compaction.handoffPrompt).toBe(prompt.value);

  (doc.getElementById('handoffPromptReset') as HTMLButtonElement).click();
  await settle();
  await settle();
  expect(prompt.value).toBe(DEFAULT_HANDOFF_PROMPT);
  expect(mounted.calls.at(-1)?.compaction.handoffPrompt).toBe(DEFAULT_HANDOFF_PROMPT);
});

it('offers the handoff length, starting at the thorough default, and saves a shorter choice', async () => {
  const mounted = await mountChat({ hasGoalKey: true });
  const length = mounted.window.document.getElementById('handoffLength') as HTMLSelectElement;
  expect(length.value).toBe('thorough');
  expect([...length.options].map(option => option.value)).toEqual(['thorough', 'standard', 'short']);
  length.value = 'short';
  length.dispatchEvent(new mounted.window.Event('change'));
  await settle();
  await settle();
  expect(mounted.calls.at(-1)?.compaction.handoffLength).toBe('short');
  expect(mounted.calls.at(-1)?.compaction.handoffPrompt).toBe(DEFAULT_HANDOFF_PROMPT);
});

/**
 * The catalogue is a network request to somebody else's service, so it happens when a person
 * asks for it and not when the settings tab is opened.
 */
it('loads the model catalogue only when the picker is opened, twenty at a time', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(45));
  const doc = mounted.window.document;
  expect(mounted.modelPages).toEqual([]);

  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(mounted.modelPages).toHaveLength(1);
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);
  // Newest first, which is the whole point of the ordering.
  expect((doc.querySelector('.goal-model .goal-model-name') as HTMLElement).textContent).toBe('Model 0');
  expect(doc.getElementById('goalModelsState')!.textContent).toContain('45');

  (doc.getElementById('goalMore') as HTMLButtonElement).click();
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(40);
  (doc.getElementById('goalMore') as HTMLButtonElement).click();
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(45);
  // Nothing left to page, so the control stops offering.
  expect((doc.getElementById('goalMore') as HTMLButtonElement).hidden).toBe(true);
});

/**
 * "Load 20 more" is the deliberate way to ask for the next page. Scrolling to the bottom of
 * the list is the way people actually ask, and it did nothing at all: the list simply ended
 * at twenty with four hundred still to come and no sign that there was a button below it.
 *
 * The repaint is the other half. The list is rebuilt whole on every page, and emptying an
 * element scrolls it back to the top — so even once it paged, the reader was thrown back to
 * the newest model, which is the one they had just scrolled away from.
 */
it('pages the catalogue in as the list is scrolled, without losing the reader\'s place', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(45));
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);

  // jsdom does no layout, so the box has to be described: a 260px window onto a list whose
  // height follows the number of rows actually in it, the way the real one does.
  const list = doc.getElementById('goalModelList')!;
  Object.defineProperty(list, 'clientHeight', { value: 260, configurable: true });
  Object.defineProperty(list, 'scrollHeight', {
    get: () => list.querySelectorAll('.goal-model').length * 50,
    configurable: true
  });
  Object.defineProperty(list, 'scrollTop', { value: 0, writable: true, configurable: true });
  const scroll = (top: number): void => {
    (list as unknown as { scrollTop: number }).scrollTop = top;
    list.dispatchEvent(new mounted.window.Event('scroll'));
  };

  // Halfway down twenty rows: nothing is asked for.
  scroll(300);
  await settle();
  expect(mounted.modelPages).toHaveLength(1);
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);

  // At the end of them: the next twenty arrive without the button being touched.
  scroll(740);
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(40);
  // And the list is still where it was left, not back at the newest model.
  expect(list.scrollTop).toBe(740);

  // Forty rows is 2000px now, so arriving at the end again pages in the last five.
  scroll(1740);
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(45);
  expect((doc.getElementById('goalMore') as HTMLButtonElement).hidden).toBe(true);

  // Nothing left to page: scrolling on does not ask OpenRouter again.
  const spent = mounted.modelPages.length;
  scroll(2200);
  await settle();
  expect(mounted.modelPages).toHaveLength(spent);
});

/**
 * A closed picker measures zero in every direction, which reads as "scrolled to the end".
 * Left unguarded, every repaint of the settings sheet would page the whole catalogue in
 * behind a panel nobody has open — hundreds of models, on somebody else's service.
 */
it('never pages the catalogue while the picker is closed', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(45));
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(mounted.modelPages).toHaveLength(1);

  // Close it again, then push a fresh state through: applyGoal repaints the list.
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  expect(doc.getElementById('goalModels')!.hidden).toBe(true);
  mounted.push({ ...mounted.state, hasGoalKey: true });
  await settle();

  expect(mounted.modelPages).toHaveLength(1);
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);
});

it('searches the whole OpenRouter catalogue and clearing restores newest-first paging', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(45));
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);

  const search = doc.getElementById('goalModelSearch') as HTMLInputElement | null;
  expect(search).not.toBeNull();
  // It says what it does: it searches the whole catalogue, not a model field.
  expect([search!.placeholder, search!.getAttribute('aria-label')]).toEqual(['Search models', 'Search models']);
  search!.value = 'model-44';
  search!.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
  await settle(); await settle();

  expect(mounted.modelPages.at(-1)?.query).toBe('model-44');
  expect([...doc.querySelectorAll<HTMLElement>('.goal-model')].map(row => row.dataset.model)).toEqual(['vendor44/model-44']);

  search!.value = '';
  search!.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
  await settle(); await settle();

  expect(mounted.modelPages.at(-1)?.query).toBe('');
  expect(doc.querySelectorAll('.goal-model')).toHaveLength(20);
  expect((doc.querySelector('.goal-model .goal-model-name') as HTMLElement).textContent).toBe('Model 0');
  expect((doc.getElementById('goalMore') as HTMLButtonElement).hidden).toBe(false);
});

/** Choosing one stores it verbatim: the id is what OpenRouter wants, not a display name. */
it('saves the chosen model id', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(3));
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  (doc.querySelectorAll('.goal-model')[1] as HTMLButtonElement).click();
  await settle();

  expect(doc.getElementById('goalModelName')!.textContent).toBe('vendor1/model-1');
  expect(mounted.calls.at(-1)?.goal).toMatchObject({ model: 'vendor1/model-1' });
});

it('saves GLM High and Max from catalogue-specific options and drops unsupported levels on model selection', async () => {
  const glm = { id: 'z-ai/glm-5.3', name: 'GLM 5.3', created: 100, contextLength: 200000,
    reasoning: { supportedEfforts: ['max', 'high', 'low'], defaultEffort: 'max', mandatory: true } };
  const plain = { id: 'plain/model', name: 'Plain', created: 1, contextLength: 1000 };
  const mounted = await mountChat({ hasGoalKey: true }, [glm, plain]);
  const doc = mounted.window.document;
  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  (doc.querySelector('[data-model="z-ai/glm-5.3"]') as HTMLButtonElement).click();
  await settle();
  const select = doc.getElementById('goalReasoning') as HTMLSelectElement;
  expect([...select.options].filter(option => !option.disabled).map(option => option.value)).toEqual(['default', 'max', 'high', 'low']);
  for (const reasoning of ['high', 'max']) {
    select.value = reasoning;
    select.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
    await settle();
    expect(mounted.calls.at(-1)?.goal).toMatchObject({ model: glm.id, reasoning });
  }
  (doc.querySelector('[data-model="plain/model"]') as HTMLButtonElement).click();
  await settle();
  expect([...select.options].map(option => option.value)).toEqual(['default']);
  expect(mounted.calls.at(-1)?.goal).toMatchObject({ model: plain.id, reasoning: 'default' });
});

it('loads supported levels for the saved model without paging to its catalogue row', async () => {
  const selectedModel = { id: 'saved/model', name: 'Saved', created: 1, contextLength: 200000,
    reasoning: { supportedEfforts: ['max', 'high', 'low'], defaultEffort: 'max', mandatory: true } };
  const mounted = await mountChat({}, [], {
    listGoalModels: async () => ({ ok: true, data: { models: [], total: 500, selectedModel } })
  }, { model: selectedModel.id, reasoning: 'high' });
  const select = mounted.window.document.getElementById('goalReasoning') as HTMLSelectElement;
  select.focus();
  await settle();
  expect(select.value).toBe('high');
  expect(select.selectedOptions[0]?.disabled).toBe(false);
  expect([...select.options].map(option => option.value)).toEqual(['default', 'max', 'high', 'low']);
  expect(mounted.calls).toHaveLength(0);
});

/** A provider that cannot be reached says so and changes nothing about what is in use. */
it('keeps the model in use when OpenRouter cannot be reached', async () => {
  const mounted = await mountChat({ hasGoalKey: true }, catalogue(2));
  const doc = mounted.window.document;
  (mounted.window as any).api.listGoalModels = () => Promise.resolve({ ok: false, error: 'offline' });

  (doc.getElementById('goalPick') as HTMLButtonElement).click();
  await settle();
  expect(doc.getElementById('goalModelsState')!.textContent).toContain('unchanged');
  expect(doc.getElementById('goalModelName')!.textContent).toBe('deepseek/deepseek-v4-flash');
});

it('retains a fresh Goal and first message when rejected sends return to New Chat', async () => {
  const sendInput = vi.fn(async () => ({ ok: false, error: 'test delivery stopped' }));
  const mounted = await mountChat({}, [], { sendInput,
    getChatModels: async () => ({ ok: true, data: { state: 'ready', requestedAt: 1, observedAt: Date.now(), models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['none', 'high'] }] } }),
    draftGoalOpening: async () => ({ ok: true, data: { reply: 'Generated opening', model: 'fixture' } })
  });
  const w = mounted.window, doc = w.document;
  (doc.getElementById('newChat') as HTMLButtonElement).click();
  await settle();
  expect(doc.getElementById('sessionControls')!.hidden).toBe(false);
  (doc.querySelector('[data-mode="goal"]') as HTMLButtonElement).click();
  const objective = doc.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Build and verify the requested feature';
  objective.dispatchEvent(new w.Event('input', { bubbles: true }));
  (doc.getElementById('saveSessionObjective') as HTMLButtonElement).click();
  await settle();
  expect(sendInput).toHaveBeenCalledWith(expect.objectContaining({ text: 'Generated opening', sessionId: null, automation: 'goal', objective: 'Build and verify the requested feature' }));
  const input = doc.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Start with the existing code';
  doc.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(sendInput).toHaveBeenCalledWith(expect.objectContaining({ sessionId: null, automation: 'goal', objective: 'Build and verify the requested feature' }));
  (doc.getElementById('newChat') as HTMLButtonElement).click();
  await settle();
  expect(objective.value).toBe('Build and verify the requested feature');
  expect(input.value).toBe('Start with the existing code');
  expect((doc.getElementById('chatAutomation') as HTMLSelectElement).value).toBe('goal');
});


it('gives twenty rapid New Chat sends independent visible local chats before any provider receipt', async () => {
  const rows: any[] = [], summaries: any[] = [];
  const ok = (data: any) => ({ ok: true, data });
  const sendInput = vi.fn(async (request: any) => {
    const row = { ...request, sessionId: request.id, opening: true, state: 'queued', owner: null, createdAt: Date.now(), conversationId: null };
    rows.push(row);
    summaries.push({ id: row.sessionId, title: row.text, conversationId: null, origin: { kind: 'desktop' }, createdAt: row.createdAt, updatedAt: row.createdAt, eventCount: 0, projectId: null, selectedModel: null, usage: {} });
    return ok(row);
  });
  const setInputAutomation = vi.fn(async (id: string, automation: string, loopAfterTurn?: boolean) => {
    const row = rows.find(row => row.id === id); row.automation = automation; if (loopAfterTurn !== undefined) row.loopAfterTurn = loopAfterTurn; return ok(true);
  });
  const setSessionAutomation = vi.fn();
  const mounted = await mountChat({}, [], { sendInput, setInputAutomation, setSessionAutomation,
    getChatModels: async () => ok({ state: 'ready', requestedAt: 1, observedAt: Date.now(), models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['high'] }] }),
    listInputs: async () => ok([...rows]), runningTools: async () => ok([]), livePreview: async () => ok(null), listPausedHelpers: async () => ok([]),
    listSessions: async () => ok({ sessions: [...summaries], activeId: null, pressure: [] }),
    getSession: async (id: string) => ok({ summary: summaries.find(row => row.id === id), events: [], nextCursor: null })
  });
  const w = mounted.window, doc = w.document, field = doc.getElementById('chatInput') as HTMLTextAreaElement;
  for (let index = 0; index < 20; index++) {
    (doc.getElementById('newChat') as HTMLButtonElement).click(); await settle();
    field.value = `Independent opening ${index}`;
    doc.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(index + 1));
    await vi.waitFor(() => expect(doc.querySelector(`.sess.is-sel[data-id="${rows[index]!.sessionId}"]`)).not.toBeNull());
    expect(doc.querySelector(`[data-input-id="${rows[index]!.id}"]`)?.textContent).toContain(rows[index]!.text);
    expect((doc.getElementById('composerModel') as HTMLSelectElement).value).toBe('gpt-5.6-sol');
  }
  (doc.querySelector('[data-mode=loop]') as HTMLButtonElement).click(); await settle();
  const loop = doc.getElementById('loopDelivery') as HTMLSelectElement; loop.value = 'after-turn'; loop.dispatchEvent(new w.Event('change')); await settle();
  expect(setInputAutomation).toHaveBeenLastCalledWith(rows[19]!.id, 'loop', true);
  expect(setSessionAutomation).not.toHaveBeenCalled();
  expect(rows[19]).toMatchObject({ automation: 'loop', loopAfterTurn: true });
  expect(rows.slice(0, 19).every(row => row.automation !== 'loop')).toBe(true);
  expect(new Set(rows.map(row => row.sessionId)).size).toBe(20);
  expect(rows.every(row => row.state === 'queued' && row.deliveredAt === undefined)).toBe(true);
  expect(sendInput.mock.calls.every(([request]) => request.sessionId === null)).toBe(true);
});

it('shows the frozen Auto-selected Skill receipt for an accepted ordinary send', async () => {
  const rows: any[] = [], summaries: any[] = [];
  const ok = (data: any) => ({ ok: true, data });
  const sendInput = vi.fn(async (request: any) => {
    const row = {
      ...request,
      sessionId: request.id,
      opening: true,
      autoSkills: [{ id: 'code-review', revision: 'a'.repeat(64) }],
      state: 'queued',
      owner: null,
      createdAt: Date.now(),
      conversationId: null
    };
    rows.push(row);
    summaries.push({
      id: row.sessionId,
      title: row.text,
      conversationId: null,
      origin: { kind: 'desktop' },
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
      eventCount: 0,
      projectId: null,
      selectedModel: null,
      usage: {}
    });
    return ok(row);
  });
  const mounted = await mountChat({}, [], {
    sendInput,
    getChatModels: async () => ok({ state: 'ready', requestedAt: 1, observedAt: Date.now(), models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['high'] }] }),
    listInputs: async () => ok([...rows]),
    runningTools: async () => ok([]),
    livePreview: async () => ok(null),
    listPausedHelpers: async () => ok([]),
    listSessions: async () => ok({ sessions: [...summaries], activeId: null, pressure: [] }),
    getSession: async (id: string) => ok({ summary: summaries.find(row => row.id === id), events: [], nextCursor: null })
  });
  const w = mounted.window, doc = w.document, field = doc.getElementById('chatInput') as HTMLTextAreaElement;
  (doc.getElementById('newChat') as HTMLButtonElement).click();
  await settle();
  field.value = 'Review this source code change for correctness.';
  doc.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(doc.querySelector('.toast')?.textContent).toContain('Auto-selected Skill: /code-review'));
});

it('does not steal a newer New Chat draft when an older admission response arrives', async () => {
  let release!: (value: any) => void;
  const rows: any[] = [], summaries: any[] = [];
  const ok = (data: any) => ({ ok: true, data });
  const sendInput = vi.fn((request: any) => new Promise(resolve => { release = () => {
    const row = { ...request, sessionId: request.id, opening: true, state: 'queued', owner: null, createdAt: Date.now(), conversationId: null };
    rows.push(row); summaries.push({ id: row.sessionId, title: row.text, conversationId: null, origin: { kind: 'desktop' }, createdAt: row.createdAt, updatedAt: row.createdAt, eventCount: 0, projectId: null, usage: {} });
    resolve(ok(row));
  }; }));
  const mounted = await mountChat({}, [], { sendInput,
    getChatModels: async () => ok({ state: 'ready', requestedAt: 1, observedAt: Date.now(), models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['high'] }] }),
    listInputs: async () => ok([...rows]), runningTools: async () => ok([]), livePreview: async () => ok(null), listPausedHelpers: async () => ok([]),
    listSessions: async () => ok({ sessions: [...summaries], activeId: null, pressure: [] }),
    getSession: async (id: string) => ok({ summary: summaries.find(row => row.id === id), events: [], nextCursor: null })
  });
  const w = mounted.window, doc = w.document, field = doc.getElementById('chatInput') as HTMLTextAreaElement;
  (doc.getElementById('newChat') as HTMLButtonElement).click(); await settle();
  field.value = 'Old admission'; doc.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));
  (doc.getElementById('newChat') as HTMLButtonElement).click(); field.value = 'Keep this newer draft';
  field.dispatchEvent(new w.Event('input', { bubbles: true })); release(undefined); await settle(); await settle();
  expect(field.value).toBe('Keep this newer draft');
  expect(doc.querySelector('.sess.is-sel')).toBeNull();
  expect(doc.getElementById('chatTitle')!.textContent).toBe('New chat');
});

it('shows each startup log line once and in order when lines arrive while the log is loading', async () => {
  // Seen on Windows: the Activity page listed "session catalog ready" and "renderer state ready"
  // both before "app started" and again after it. Those lines arrived live while the page was
  // still loading the log, and the loaded log contained them too.
  let live: (entry: any) => void = () => undefined;
  let release!: (reply: any) => void;
  const line = (time: number, message: string) => ({ time, level: 'info', message });
  const mounted = await mountChat({}, [], {
    getLog: () => new Promise(resolve => { release = resolve; }),
    onLogEntry: (fn: any) => { live = fn; return () => undefined; }
  });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  live(line(2, 'session catalog ready'));
  live(line(3, 'renderer state ready'));
  release({ ok: true, data: [line(1, 'app started'), line(2, 'session catalog ready'), line(3, 'renderer state ready')] });
  await settle(); await settle();
  live(line(4, 'window loaded'));
  // A row shows the line's source and text in separate cells; compare without the spacing.
  const rows = () => [...mounted.window.document.querySelectorAll('#fullFeed > *')].map(row => (row.textContent ?? '').replace(/\s/g, ''));
  await vi.waitFor(() => expect(rows()).toHaveLength(4));
  expect(rows().map(text => ['app started', 'session catalog ready', 'renderer state ready', 'window loaded'].find(m => text.includes(m.replace(/\s/g, '')))))
    .toEqual(['app started', 'session catalog ready', 'renderer state ready', 'window loaded']);
});

it.each(['.project-menu'])('keeps keyboard focus on a project row button (%s) across an activity repaint', async selector => {
  // Seen live on Windows: after picking a project color, focus went back to the color button and
  // the next sidebar repaint dropped it to the page. Only the project heading kept its focus.
  const { project, session } = projectSidebarFixture();
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [project] }),
    listSessions: async () => ({ ok: true, data: { sessions: [session], activeId: null, pressure: [], blocked: [] } })
  });
  const doc = mounted.window.document;
  const control = () => doc.querySelector<HTMLElement>(`[data-project-id="${project.id}"] ${selector}`)!;
  await vi.waitFor(() => expect(control()).not.toBeNull());
  await settle();
  const before = control();
  before.focus();
  expect(doc.activeElement).toBe(before);
  mounted.push(structuredClone(mounted.state));
  await settle();
  expect(control()).not.toBe(before); // the repaint really replaced the row
  expect(doc.activeElement).toBe(control());
});

it('saves this computer\'s connector name, and keeps the saved one while the typed one is invalid', async () => {
  const mounted = await mountChat();
  const w = mounted.window, doc = w.document;
  const field = doc.getElementById('connectorSuffix') as HTMLInputElement;
  const error = doc.getElementById('connectorSuffixError')!;
  const details = doc.getElementById('connectorSuffixField') as HTMLDetailsElement;
  expect(field.value).toBe('');
  expect(details.open).toBe(false);
  expect(error.hidden).toBe(true);

  field.value = '  Windows   VM ';
  field.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls.at(-1)?.connectorSuffix).toBe('Windows VM'));

  // An invalid name says why at once, and a save it rides in keeps the saved name.
  field.value = 'Win/VM';
  field.dispatchEvent(new w.Event('input', { bubbles: true }));
  expect(error.hidden).toBe(false);
  expect(field.getAttribute('aria-invalid')).toBe('true');
  const saves = mounted.calls.length;
  field.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls.length).toBe(saves + 1));
  expect(mounted.calls.at(-1)?.connectorSuffix).toBe('Windows VM');
  field.value = 'Mac';
  field.dispatchEvent(new w.Event('input', { bubbles: true }));
  expect(error.hidden).toBe(true);
  expect(field.getAttribute('aria-invalid')).toBe('false');
});

it('shows a computer name set elsewhere and opens its section, so the suffixed card names are explained', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, connectorSuffix: 'Windows' } });
  await settle();
  expect((doc.getElementById('connectorSuffix') as HTMLInputElement).value).toBe('Windows');
  expect((doc.getElementById('connectorSuffixField') as HTMLDetailsElement).open).toBe(true);
});
