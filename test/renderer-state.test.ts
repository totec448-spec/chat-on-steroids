import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_GOAL_SYSTEM_PROMPT } from '../src/shared/goal.js';

let dom: JSDOM | null = null;
afterEach(() => {
  dom?.window.close();
  dom = null;
  vi.resetModules();
});

it('does not overwrite a focused dirty settings field on an unsolicited state push', async () => {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
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
    tunnel: { kind: 'openai', tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light' },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000 },
    multiAgent: { enabled: false, maxWorkers: 2 },
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
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null }
  };
  const ok = (data: any) => Promise.resolve({ ok: true, data });
  const api: any = new Proxy({
    getState: () => ok(state),
    getLog: () => ok([]),
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

  const multiAgent = w.document.getElementById('homeMaEnabled') as HTMLInputElement;
  multiAgent.focus();
  multiAgent.checked = true;
  stateListener(structuredClone(state));
  expect(w.document.activeElement).toBe(multiAgent);
  expect(multiAgent.checked).toBe(true);

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
  withMissingMacAccess.config.capabilities.screen = true;
  withMissingMacAccess.config.capabilities.control = true;
  withMissingMacAccess.desktopAccess = {
    screen: 'granted',
    accessibility: 'missing',
    parentPermissions: { screen: 'granted', accessibility: 'missing' },
    backendPermissions: { screen: 'granted', accessibility: 'missing' },
    parent: { executable: 'Chat On Steroids', identifier: 'Electron', teamIdentifier: null, signingMode: 'adhoc', cdhash: 'aaaaaaaaaaaaaaaa' },
    backend: { executable: 'macos-desktop-addon.node', identifier: 'macos-desktop-addon', teamIdentifier: null, signingMode: 'adhoc', cdhash: 'bbbbbbbbbbbbbbbb' },
    rebuildMayInvalidateAuthorization: true,
    checkedAt: 1,
    error: null
  };
  stateListener(withMissingMacAccess);
  const accessWarning = w.document.getElementById('desktopAccess')!;
  expect(accessWarning.hidden).toBe(false);
  expect(accessWarning.textContent).toContain('Accessibility: missing');
  expect(accessWarning.textContent).toContain('stale enabled row after rebuilding');
  expect(accessWarning.textContent).toContain('same TCC subject');
  expect(accessWarning.textContent).toContain('Electron/adhoc#aaaaaaaaaa');
  expect((w.document.getElementById('openDesktopPrivacy') as HTMLButtonElement).hidden).toBe(false);
});

it('serializes settings intent so rapid toggles and later UI changes cannot undo each other', async () => {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
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
    tunnel: { kind: 'openai', tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light' as 'light' | 'dark' },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000 },
    multiAgent: { enabled: false, maxWorkers: 2 },
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
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null }
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
  expect(calls[1].ui.autoConnect).toBe(false);

  current = appState({ ...baseConfig, readOnly: false });
  pending.shift()!({ ok: true, data: current });
  await vi.waitFor(() => expect(calls).toHaveLength(3));
  expect(calls[2].readOnly).toBe(false);
  expect(calls[2].ui.autoConnect).toBe(true);

  current = appState({ ...baseConfig, readOnly: false, ui: { ...baseConfig.ui, autoConnect: true } });
  pending.shift()!({ ok: true, data: current });
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Theme has the same no-form-control shape. Two rapid clicks must request dark then light,
  // even though the first dark save has not answered yet.
  const theme = w.document.getElementById('themeBtn') as HTMLButtonElement;
  theme.click();
  await vi.waitFor(() => expect(calls).toHaveLength(4));
  expect(calls[3].ui.theme).toBe('dark');
  theme.click();
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
  apiOverrides: Record<string, (...args: any[]) => any> = {}
): Promise<GoalMount> {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
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
    tunnel: { kind: 'openai', tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', desktopTunnelId: '', binaryPath: '' },
    ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light' as const },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000 },
    multiAgent: { enabled: false, maxWorkers: 2 },
    goal: {
      enabled: false,
      model: 'deepseek/deepseek-v4-flash',
      reasoning: 'default' as const,
      prompt: DEFAULT_GOAL_SYSTEM_PROMPT
    }
  };
  const state: any = {
    config,
    status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
    hasApiKey: false,
    hasGoalKey: false,
    resolvedBinary: null,
    bundledTunnelVersion: null,
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null },
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
      listGoalModels: (offset: number) => {
        const page = { models: models.slice(offset, offset + 20), total: models.length, offset };
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

it('preserves native Desktop permissions when saving unrelated settings on Linux', async () => {
  const mounted = await mountChat({
    platform: { family: 'linux', name: 'Linux', desktopAutomation: false }
  });
  const w = mounted.window;

  const desktopGroup = w.document.querySelector<HTMLElement>('[data-group="desktop"]')!;
  expect(desktopGroup.hidden).toBe(true);

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
  const connect = mounted.window.document.getElementById('connectBtn') as HTMLButtonElement;
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

it('requires a live browser only when a browser-backed feature is actually enabled', async () => {
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
          available: true, localUrl: 'http://127.0.0.1:1234', publicUrl: null, tools: ['read', 'session'],
          state: 'live', detail: '', lastRequestAt: Date.now(), lastToolCallAt: Date.now()
        }
      ]
    },
    // The token survived, but this process has not heard from the extension. This is the
    // disabled/uninstalled-extension-after-app-restart repro.
    bridge: { running: true, port: 8765, paired: true, present: false, lastSeenAt: null }
  });
  const doc = mounted.window.document;
  const browserStep = doc.querySelector<HTMLElement>('[data-step="browser"]')!;

  expect(browserStep.classList.contains('is-done')).toBe(false);
  expect(browserStep.classList.contains('is-current')).toBe(true);
  expect(doc.getElementById('wizard')!.classList.contains('is-tidy')).toBe(false);
  expect(doc.getElementById('bridgeState')!.textContent).toContain('Authorized');
  expect(doc.getElementById('bridgeState')!.textContent).not.toContain('Connected.');

  const live = structuredClone(mounted.state) as any;
  live.hasApiKey = true;
  live.status = (mounted.state as any).status;
  live.bridge = { running: true, port: 8765, paired: true, present: true, lastSeenAt: Date.now() };
  mounted.push(live);
  expect(browserStep.classList.contains('is-done')).toBe(true);
  expect(doc.getElementById('bridgeState')!.textContent).toContain('Connected.');

  // Recording and multi-agent are the two independently viable bridge features. Goal is
  // browser-driven too, but it requires a recorded session and cannot run by itself when
  // recording is off, so goal.enabled alone must not keep setup blocked on an inert bridge.
  const browserFree = structuredClone(live) as any;
  browserFree.config.sessions.record = false;
  browserFree.config.multiAgent.enabled = false;
  browserFree.config.goal.enabled = true;
  browserFree.bridge = { running: false, port: null, paired: true, present: false, lastSeenAt: Date.now() };
  mounted.push(browserFree);
  expect(browserStep.hidden).toBe(true);
  expect(doc.getElementById('wizard')!.classList.contains('is-tidy')).toBe(true);
  expect(doc.getElementById('bridgeState')!.textContent).toContain('not needed');
  expect((doc.getElementById('goalEnabled') as HTMLInputElement).disabled).toBe(true);
  expect(doc.getElementById('goalHint')!.textContent).toMatch(/recording first/i);
});

/**
 * The exact sentence, because it is the same sentence the composer's settings sheet shows
 * and the two are meant to be recognisably one message rather than two paraphrases.
 */
it('says an OpenRouter key is needed before the goal loop can do anything', async () => {
  const mounted = await mountChat();
  const hint = mounted.window.document.getElementById('goalHint')!;
  expect(hint.textContent).toBe('OpenRouter API key essential for goal feature.');
  expect(hint.classList.contains('is-warn')).toBe(true);

  mounted.push({ ...mounted.state, hasGoalKey: true });
  await settle();
  expect(mounted.window.document.getElementById('goalHint')!.classList.contains('is-warn')).toBe(false);
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
