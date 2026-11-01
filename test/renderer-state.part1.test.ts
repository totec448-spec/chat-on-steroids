import { expect, it, vi } from 'vitest';
import { DAY, DEFAULT_GOAL_MODEL, DEFAULT_GOAL_SYSTEM_PROMPT, DEFAULT_HANDOFF_PROMPT, JSDOM, closeRowMenus, fs, inboxCardIds, inboxCardState, inboxChat, inboxProjects, installDialog, listed, mountChat, mountInbox, path, projectSidebarFixture, rowMenuItem, setDom, settle, waitFor } from './renderer-state.harness.js';

vi.mock('../src/renderer/workspace-terminal.js', () => ({ createWorkspaceTerminal: () => ({
  update: vi.fn(), show: vi.fn(), hide: vi.fn(), newTab: vi.fn(() => null),
  tabs: vi.fn(() => []), selectTab: vi.fn(), closeTab: vi.fn()
}) }));
// Native animation/media APIs are covered by pet DOM and real Electron tests.
vi.mock('../src/renderer/pet.js', () => ({ initPet: () => Object.assign(() => {}, { toggle: () => {}, isVisible: () => false }) }));


it('shows a model saved under its old short label as the model it resolves to (2.1.31 release check)', async () => {
  // A Mac config kept the Goal model "6" from before full names. #1219 resolves it to GPT-6, but the
  // generic settings pass then wrote the raw "6" back into the select, which matched no option, so the
  // setting showed blank on every start and state push.
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  const booted = setDom(new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true }));
  installDialog(booted.window);
  const w = booted.window;
  w.HTMLElement.prototype.animate = vi.fn() as any;
  Object.assign(globalThis, { window: w, document: w.document, HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node,
    DocumentFragment: w.DocumentFragment, HTMLInputElement: w.HTMLInputElement, HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement, HTMLButtonElement: w.HTMLButtonElement });
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};
  let stateListener: (state: any) => void = () => undefined;
  const state = {
    config: {
      roots: [{ name: 'repo', path: 'C:\\repo' }], readOnly: true,
      capabilities: { browse: true, search: true, read: true, metadata: true, create: false, edit: false, move: false, deleteFile: false,
        command: false, screen: false, control: false, clipboardRead: false, clipboardWrite: false },
      commandAllowlist: { enabled: false, mode: 'allow' as const, rules: [] as string[] },
      tunnel: { kind: 'openai', tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', desktopTunnelId: '', binaryPath: '' },
      ui: { minimizeToTray: true, autoConnect: false, privacyScreenshots: false, theme: 'light', defaultChatModel: '5.6', defaultChatReasoning: 'high' },
      sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
      compaction: { auto: true, autoTokens: 300000, handoffPrompt: DEFAULT_HANDOFF_PROMPT },
      multiAgent: { enabled: false, maxWorkers: 2, globalMaxWorkers: 0, allowUnattributedCalls: false, recoverAgentTabs: true, defaultModel: '6', defaultReasoning: 'high' },
      goal: { enabled: false, model: 'deepseek/deepseek-v4-flash', reasoning: 'default' as const, prompt: DEFAULT_GOAL_SYSTEM_PROMPT,
        helperModel: '6', helperReasoning: 'high' }
    },
    status: { state: 'disconnected', detail: '', publicUrl: null, localUrl: null, handshakeAt: null, lastRequestAt: null, lastToolCallAt: null, health: null, surfaces: [] },
    hasApiKey: false, hasGoalKey: false, resolvedBinary: null, bundledTunnelVersion: null,
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.1.31', latest: null, stage: 'idle', error: null, checkedAt: null }
  };
  const models = [
    { id: 'gpt-6', label: 'GPT-6', efforts: ['none', 'medium', 'high', 'xhigh'], aliases: ['gpt-6', 'gpt-6-thinking'] },
    { id: 'gpt-5-6', label: 'GPT-5.6', efforts: ['none', 'medium', 'high', 'xhigh'] }];
  const ok = (data: any) => Promise.resolve({ ok: true, data });
  const api: any = new Proxy({
    getState: () => ok(state),
    getLog: () => ok([]),
    getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
    getChatModels: () => ok({ state: 'ready', requestedAt: 1, observedAt: Date.now(), models }),
    onStateChanged: (fn: any) => { stateListener = fn; return () => undefined; },
    onLogEntry: () => () => undefined,
    onSwarmChanged: () => () => undefined,
    onSessionChanged: () => () => undefined,
    listSessions: () => ok({ sessions: [], activeId: null, pressure: [] })
  }, { get(target, prop) { if (prop in target) return (target as any)[prop]; return (..._args: any[]) => ok(null); } });
  Object.defineProperty(w, 'api', { value: api, configurable: true });

  await import('../src/renderer/main.js');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const value = (id: string) => (w.document.getElementById(id) as HTMLSelectElement).value;
  const shown = () => ({ helper: value('helperModel'), worker: value('workerModel'), chat: value('defaultChatModel') });
  expect(shown()).toEqual({ helper: 'gpt-6', worker: 'gpt-6', chat: 'gpt-5-6' });
  stateListener(structuredClone(state));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(shown()).toEqual({ helper: 'gpt-6', worker: 'gpt-6', chat: 'gpt-5-6' });
  expect(value('helperReasoning')).toBe('high');
});

it('does not overwrite a focused dirty settings field on an unsolicited state push', async () => {
  const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
  const booted = setDom(new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true }));
  installDialog(booted.window);
  const w = booted.window;
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
  const booted = setDom(new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true }));
  installDialog(booted.window);
  const w = booted.window;
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
  await waitFor(() => expect(calls).toHaveLength(1));
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
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1].readOnly).toBe(false);
  // The toggle tells assistive technology which state is saved, not just its colour.
  expect(w.document.getElementById('readOnlyBtn')?.getAttribute('aria-pressed')).toBe('true');
  // The lock reads like a state; its title says what a click changes.
  expect(w.document.getElementById('readOnlyBtn')?.title).toBe('Read-only is on: ChatGPT can only look. Click to allow changes again.');
  expect(calls[1].ui.autoConnect).toBe(false);

  current = appState({ ...baseConfig, readOnly: false });
  pending.shift()!({ ok: true, data: current });
  await waitFor(() => expect(calls).toHaveLength(3));
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
  await waitFor(() => expect(calls).toHaveLength(4));
  expect(calls[3].ui.theme).toBe('dark');
  theme.value = 'light'; theme.dispatchEvent(new w.Event('change', { bubbles: true }));
  expect(calls).toHaveLength(4);

  current = appState({ ...baseConfig, readOnly: false, ui: { ...baseConfig.ui, autoConnect: true, theme: 'dark' } });
  pending.shift()!({ ok: true, data: current });
  await waitFor(() => expect(calls).toHaveLength(5));
  expect(calls[4].ui.theme).toBe('light');

  current = appState({ ...baseConfig, readOnly: false, ui: { ...baseConfig.ui, autoConnect: true, theme: 'light' } });
  pending.shift()!({ ok: true, data: current });
  await new Promise((resolve) => setTimeout(resolve, 0));
});

// #1914: Settings → Appearance → Theme offers System, which follows the operating system live.
it('offers a System theme that follows the operating system, also when it changes', async () => {
  const mounted = await mountChat({});
  const w = mounted.window;
  let dark = true;
  const changes: Array<() => void> = [];
  (w as any).matchMedia = (query: string) => ({ media: query, get matches() { return query.includes('dark') && dark; },
    addEventListener: (_type: string, listener: () => void) => changes.push(listener), removeEventListener: () => {} });
  const theme = w.document.getElementById('appearanceTheme') as HTMLSelectElement;
  expect([...theme.options].map(option => option.value)).toEqual(['light', 'dark', 'system']);
  theme.value = 'system'; theme.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  expect(mounted.calls.at(-1)?.ui.theme).toBe('system');
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, theme: 'system' } } });
  await settle();
  expect(w.document.documentElement.dataset.theme).toBe('dark');
  expect(theme.value).toBe('system');
  dark = false;
  for (const change of changes) change();
  expect(w.document.documentElement.dataset.theme).toBe('light');
  // CodeRabbit on #1917: a switch while a color is being typed waits for the edit, and an edit that
  // ends invalid (restored, not saved) still shows the system's theme afterwards.
  const hex = w.document.getElementById('appearance-accent-hex') as HTMLInputElement;
  hex.focus();
  hex.value = '#12';
  hex.dispatchEvent(new w.Event('input', { bubbles: true }));
  dark = true;
  for (const change of changes) change();
  expect(w.document.documentElement.dataset.theme).toBe('light');
  hex.dispatchEvent(new w.Event('change', { bubbles: true }));
  expect(w.document.documentElement.dataset.theme).toBe('dark');
  // The field shows the dark theme's accent, the one now in use.
  expect(hex.value).toBe(mounted.state.config.ui.appearance?.dark.accent?.toUpperCase() ?? (await import('../src/shared/appearance.js')).defaultAppearance().dark.accent.toUpperCase());
  // A fixed choice no longer follows the system.
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, theme: 'dark' } } });
  await settle();
  for (const change of changes) change();
  expect(w.document.documentElement.dataset.theme).toBe('dark');
});

it('starts project groups collapsed and deliberately expands the project selected for a new chat', async () => {
  const { project, session } = projectSidebarFixture();
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [project] }),
    listSessions: async () => ({ ok: true, data: { sessions: [session], activeId: null, pressure: [], blocked: [] } })
  });
  const group = () => mounted.window.document.querySelector<HTMLDetailsElement>(`[data-project-id="${project.id}"]`)!;
  await waitFor(() => expect(group()).not.toBeNull());
  expect(group().open).toBe(false);
  // A new chat is the row's own button, beside its menu, not an item inside it.
  expect(rowMenuItem(group().querySelector('.project-heading')!, 'new-chat')).toBeNull();
  const create = group().querySelector<HTMLButtonElement>('.project-heading > .project-new')!;
  expect(create.getAttribute('aria-label')).toBe('New chat in this project');
  expect(create.nextElementSibling?.classList.contains('project-menu')).toBe(true);
  create.click();
  expect(group().open).toBe(true);
});

it('applies line spacing and the legible font from Appearance at once, and saves them with the announcement switch', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document, root = doc.documentElement;
  const panel = doc.querySelector('[data-panel="appearance"]')!;
  const spacing = doc.getElementById('appearanceLineSpacing') as HTMLInputElement;
  expect(panel.contains(spacing)).toBe(true);
  expect([spacing.min, spacing.max, spacing.step, spacing.value]).toEqual(['100', '200', '10', '100']);
  expect(doc.getElementById('appearanceLineSpacingValue')!.textContent).toBe('1.0×');
  spacing.value = '140';
  spacing.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
  // The drag repaints before anything is saved.
  expect(root.style.getPropertyValue('--line-spacing')).toBe('1.4');
  expect(doc.getElementById('appearanceLineSpacingValue')!.textContent).toBe('1.4×');
  // A screen reader gets the shown value, not the stored 140.
  expect(spacing.getAttribute('aria-valuetext')).toBe('1.4×');
  spacing.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls.at(-1)?.ui.appearance).toMatchObject({ lineSpacing: 140 }));
  const font = doc.getElementById('appearanceFont') as HTMLSelectElement;
  font.value = 'legible';
  font.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  expect(root.style.getPropertyValue('--ui-font')).toMatch(/^"CoS Atkinson Hyperlegible Next", /);
  await waitFor(() => expect(mounted.calls.at(-1)?.ui.appearance).toMatchObject({ lineSpacing: 140, font: 'legible' }));
  // Off unless chosen; a plain ui switch, so Reset appearance leaves it alone.
  const announce = doc.getElementById('announceTurns') as HTMLInputElement;
  expect(panel.contains(announce)).toBe(true);
  expect(announce.checked).toBe(false);
  announce.checked = true;
  announce.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls.at(-1)?.ui.announceTurns).toBe(true));
  doc.getElementById('appearanceReset')!.click();
  await waitFor(() => expect(mounted.calls.at(-1)?.ui.appearance).toMatchObject({ lineSpacing: 100, font: 'system' }));
  expect(mounted.calls.at(-1)?.ui.announceTurns).toBe(true);
  expect(root.style.getPropertyValue('--line-spacing')).toBe('1');
});

it('offers eight accent presets and a High contrast switch that keeps the chosen colors underneath', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document, root = doc.documentElement;
  const { ACCENT_PRESETS, defaultAppearance } = await import('../src/shared/appearance.js');
  const swatches = [...doc.querySelectorAll<HTMLButtonElement>('#appearanceAccentPresets .appearance-swatch')];
  const theme = root.dataset.theme as 'light' | 'dark';
  expect(swatches.map(swatch => swatch.getAttribute('aria-label'))).toEqual(['Blue', 'Teal', 'Green', 'Amber', 'Orange', 'Red', 'Rose', 'Purple']);
  expect(swatches.map(swatch => swatch.getAttribute('role'))).toEqual(Array(8).fill('radio'));
  // The default accent is the first preset; exactly one is checked.
  expect(swatches.map(swatch => swatch.getAttribute('aria-checked'))).toEqual(['true', ...Array(7).fill('false')]);
  // A preset sets its own shade for both themes, so switching theme keeps the family.
  swatches[1]!.click();
  await waitFor(() => expect(mounted.calls.at(-1)?.ui.appearance).toMatchObject({
    light: { accent: ACCENT_PRESETS[1].light }, dark: { accent: ACCENT_PRESETS[1].dark } }));
  expect(swatches.map(swatch => swatch.getAttribute('aria-checked'))).toEqual(['false', 'true', ...Array(6).fill('false')]);
  expect((doc.getElementById('appearance-accent-hex') as HTMLInputElement).value).toBe(ACCENT_PRESETS[1][theme].toUpperCase());
  // Arrows move between the presets and choose the one they land on.
  swatches[1]!.focus();
  swatches[1]!.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(doc.activeElement).toBe(swatches[2]);
  expect(swatches[2]!.getAttribute('aria-checked')).toBe('true');
  expect(swatches.filter(swatch => swatch.tabIndex === 0)).toEqual([swatches[2]]);
  swatches[0]!.focus();
  swatches[0]!.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  expect(doc.activeElement).toBe(swatches[7]);
  // A hand-picked color checks no preset, in this theme or the other one: a preset is its pair.
  const hex = doc.getElementById('appearance-accent-hex') as HTMLInputElement;
  hex.value = '#123456';
  hex.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  expect(swatches.every(swatch => swatch.getAttribute('aria-checked') === 'false')).toBe(true);
  const themeSelect = doc.getElementById('appearanceTheme') as HTMLSelectElement;
  themeSelect.value = theme === 'dark' ? 'light' : 'dark';
  themeSelect.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  expect(swatches.every(swatch => swatch.getAttribute('aria-checked') === 'false')).toBe(true);
  // Still one tab stop when nothing is checked: the first swatch.
  expect(swatches.filter(swatch => swatch.tabIndex === 0)).toEqual([swatches[0]]);
  themeSelect.value = theme;
  themeSelect.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));

  const high = doc.getElementById('appearanceHighContrast') as HTMLInputElement;
  expect(high.checked).toBe(false);
  high.checked = true;
  high.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls.at(-1)?.ui.appearance).toMatchObject({ highContrast: true }));
  expect(root.dataset.highContrast).toBe('true');
  expect(root.style.getPropertyValue('--page')).toBe(theme === 'dark' ? '#000000' : '#ffffff');
  // Background, sidebar, contrast and translucency do nothing now, so they say so; the accent still works.
  for (const id of ['appearance-background', 'appearance-background-hex', 'appearance-sidebar', 'appearance-sidebar-hex', 'appearanceContrast', 'appearanceTranslucent'])
    expect((doc.getElementById(id) as HTMLInputElement).disabled, id).toBe(true);
  expect((doc.getElementById('appearance-accent-hex') as HTMLInputElement).disabled).toBe(false);
  // The colors chosen before wait underneath.
  expect(mounted.calls.at(-1)?.ui.appearance[theme].background).toBe(defaultAppearance()[theme].background);
  high.checked = false;
  high.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls.at(-1)?.ui.appearance).toMatchObject({ highContrast: false }));
  expect(root.style.getPropertyValue('--page')).toBe(defaultAppearance()[theme].background);
  expect((doc.getElementById('appearanceContrast') as HTMLInputElement).disabled).toBe(false);
  // Reset turns high contrast off too.
  high.checked = true;
  high.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  doc.getElementById('appearanceReset')!.click();
  await waitFor(() => expect(mounted.calls.at(-1)?.ui.appearance).toMatchObject({ highContrast: false }));
  expect(high.checked).toBe(false);
});

it('gives the line-spacing slider the shown value as its spoken value, from the saved setting and after a change', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const spacing = doc.getElementById('appearanceLineSpacing') as HTMLInputElement;
  const shown = () => doc.getElementById('appearanceLineSpacingValue')!.textContent;
  expect(spacing.getAttribute('aria-valuetext')).toBe(shown());
  // A saved setting arrives with a state push (start-up, another window).
  const { defaultAppearance } = await import('../src/shared/appearance.js');
  mounted.state.config = { ...mounted.state.config, ui: { ...mounted.state.config.ui, appearance: { ...defaultAppearance(), lineSpacing: 160 } } };
  mounted.push(structuredClone(mounted.state));
  expect(spacing.value).toBe('160');
  expect(spacing.getAttribute('aria-valuetext')).toBe('1.6×');
  expect(spacing.getAttribute('aria-valuetext')).toBe(shown());
  spacing.value = '200';
  spacing.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
  expect(spacing.getAttribute('aria-valuetext')).toBe('2.0×');
  expect(spacing.getAttribute('aria-valuetext')).toBe(shown());
  // The decimal mark follows the app language, in the label and in the spoken value alike, also when the language changes with the slider untouched.
  const { setLanguage } = await import('../src/renderer/i18n.js');
  try {
    spacing.value = '130';
    spacing.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
    expect(spacing.getAttribute('aria-valuetext')).toBe('1.3×');
    setLanguage('de');
    expect(shown()).toBe('1,3×');
    expect(spacing.getAttribute('aria-valuetext')).toBe('1,3×');
    spacing.value = '200';
    spacing.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
    expect(spacing.getAttribute('aria-valuetext')).toBe('2,0×');
    expect(spacing.getAttribute('aria-valuetext')).toBe(shown());
  } finally {
    setLanguage('en');
  }
});

it('draws the sidebar layout saved in Appearance, Projects by default, and repaints when it changes', async () => {
  const { project, session } = projectSidebarFixture();
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [project] }),
    listSessions: async () => ({ ok: true, data: { sessions: [session], activeId: null, pressure: [], blocked: [] } })
  });
  const doc = mounted.window.document;
  const list = doc.getElementById('sessionList')!;
  const option = (value: string) => doc.querySelector<HTMLInputElement>(`input[name="appearanceSidebarLayout"][value="${value}"]`)!;
  const chosen = () => doc.querySelector<HTMLInputElement>('input[name="appearanceSidebarLayout"]:checked')?.value;
  // A config saved before the setting existed has no appearance at all: today's project tree.
  await waitFor(() => expect(doc.querySelector(`[data-project-id="${project.id}"]`)).not.toBeNull());
  expect(list.classList.contains('is-inbox')).toBe(false);
  expect(chosen()).toBe('projects');
  // The choice lives in the app's config, so it arrives with a state push (another window, a restart).
  const { defaultAppearance } = await import('../src/shared/appearance.js');
  mounted.state.config = { ...mounted.state.config, ui: { ...mounted.state.config.ui, appearance: { ...defaultAppearance(), sidebarLayout: 'inbox' } } };
  mounted.push(structuredClone(mounted.state));
  expect(list.classList.contains('is-inbox')).toBe(true);
  expect(chosen()).toBe('inbox');
  expect(window.localStorage.getItem('chat-on-steroids.sidebar-layout')).toBeNull();
  // Choosing Projects saves through Settings with the rest of Appearance and redraws the tree.
  // A click on its picture, as a person chooses it.
  option('projects').click();
  await waitFor(() => expect(mounted.calls.find(call => call.ui?.appearance?.sidebarLayout)?.ui.appearance).toMatchObject({ sidebarLayout: 'projects', font: 'system' }), { timeout: 5000 });
  await waitFor(() => expect(list.classList.contains('is-inbox')).toBe(false), { timeout: 5000 });
  expect(doc.querySelector(`[data-project-id="${project.id}"]`)).not.toBeNull();
});

it('draws sub-agents under their parent card with one line of counts, and a busy worker keeps a quiet parent out of Settled', async () => {
  const old = Date.now() - 3 * DAY;
  const worker = (id: string, extra: Record<string, unknown> = {}) => inboxChat(id, {
    startedAt: old, updatedAt: old, origin: { kind: 'worker', fromSessionId: 'parent', agentId: id, task: '' }, ...extra
  });
  const sessions = [
    inboxChat('parent', { title: 'Parent task', startedAt: old, updatedAt: old }),
    worker('w-run-1', { activityExpiresAt: Date.now() + 60 * 60_000 }),
    worker('w-run-2', { activityExpiresAt: Date.now() + 60 * 60_000 }),
    worker('w-sleep', { lastToolCallAt: old - 1, lastFinishReportAt: old }),
    worker('w-blocked'),
    inboxChat('w-orphan', { origin: { kind: 'worker', fromSessionId: 'gone', agentId: 'w-orphan', task: '' } }),
    inboxChat('quiet', { title: 'Quiet chat', startedAt: old, updatedAt: old })
  ];
  const mounted = await mountInbox({ listSessions: async () => listed(sessions, { blocked: ['c-w-blocked'] }) });
  const doc = mounted.window.document;
  const card = () => doc.querySelector<HTMLElement>('.inbox-cards > .sess-card[data-id="parent"]');
  await waitFor(() => expect(card()).not.toBeNull());
  // Quiet for days, but its workers are running: it stays a card. A chat as quiet without them settles.
  expect(doc.querySelector('.inbox-settled .sess[data-id="parent"]')).toBeNull();
  expect(doc.querySelector('.inbox-settled .sess[data-id="quiet"]')).not.toBeNull();
  // Counts only, on the card's meta line, from the same states the workers' own rows show.
  expect(card()!.querySelector('.sess-foot .sess-workers')?.textContent).toBe('1 needs attention · 2 working · 1 sleeping');
  // Collapsed at first: the tree's own arrow, on the card.
  const toggle = () => card()!.querySelector<HTMLButtonElement>(':scope > .worker-toggle')!;
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(toggle().getAttribute('aria-label')).toBe('Expand 4 sub-agents');
  expect(doc.querySelector('.sess[data-id="w-run-1"]')).toBeNull();
  toggle().click();
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  const group = card()!.nextElementSibling as HTMLElement;
  expect(group.classList.contains('worker-group')).toBe(true);
  expect([...group.querySelectorAll<HTMLElement>(':scope > .sess')].map(row => row.dataset.id)).toEqual(['w-run-1', 'w-run-2', 'w-sleep', 'w-blocked']);
  toggle().click();
  expect(doc.querySelector('.worker-group')).toBeNull();
  // A worker whose chat is not loaded goes in the shared history disclosure at the end.
  const history = doc.querySelector<HTMLDetailsElement>('#chatList > details.session-diagnostics')!;
  expect(history.querySelector('summary')?.textContent).toBe('Sub-agent history · 1');
  expect(history.querySelector('.sess[data-id="w-orphan"]')).not.toBeNull();
  expect(doc.querySelectorAll('.sess[data-id="w-orphan"]')).toHaveLength(1);
});

it('filters the inbox with a searchable project picker, by keyboard, and reads the chosen project\'s own history', async () => {
  const { alpha, beta } = inboxProjects();
  const older = Array.from({ length: 7 }, (_, index) => inboxChat(`b-old-${index}`, {
    projectId: beta.id, startedAt: 1, updatedAt: Date.now() - 3 * DAY - index * 1000
  }));
  const listSessions = vi.fn(async (options?: { projectId?: string; cursor?: unknown }) => {
    if (options?.projectId === beta.id) return options.cursor
      ? listed(older.slice(5), { nextCursor: null })
      : listed(older.slice(0, 5), { nextCursor: { updatedAt: older[4]!.updatedAt, id: older[4]!.id } });
    return listed([inboxChat('a1', { projectId: alpha.id, updatedAt: Date.now() }), inboxChat('b1', { projectId: beta.id, updatedAt: Date.now() })]);
  });
  const mounted = await mountInbox({ listProjects: async () => ({ ok: true, data: [alpha, beta] }), listSessions });
  const doc = mounted.window.document, w = mounted.window;
  const trigger = () => doc.querySelector<HTMLButtonElement>('#chatList [data-inbox-control="picker"]')!;
  const popup = () => doc.querySelector<HTMLElement>('.inbox-project-picker:not(.is-leaving)');
  const options = () => [...popup()!.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  const search = () => popup()!.querySelector<HTMLInputElement>('input[type="search"]')!;
  const key = (target: Element, name: string) => target.dispatchEvent(new w.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  await waitFor(() => expect(doc.querySelector('.sess-card[data-id="a1"]')).not.toBeNull());
  // No sideways chips: one button saying what is shown.
  expect(doc.querySelector('.inbox-chips, .inbox-chip')).toBeNull();
  expect(trigger().textContent).toBe('All');
  expect(trigger().getAttribute('aria-expanded')).toBe('false');
  expect(trigger().getAttribute('aria-label')).toBe('Projects: All');
  trigger().focus(); trigger().click();
  expect(popup()).not.toBeNull();
  expect(trigger().getAttribute('aria-expanded')).toBe('true');
  expect(doc.activeElement).toBe(search());
  expect(popup()!.querySelector('[role="listbox"]')).not.toBeNull();
  expect(options().map(option => option.textContent)).toEqual(['All', 'Alpha', 'Bêta']);
  expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
  // The list's Search opens the chat search dialog, as the brand row's button says.
  expect(doc.querySelector('#chatList [data-inbox-control="search"]')!.getAttribute('aria-haspopup')).toBe('dialog');
  // No match: the listbox holds options only, and its empty line sits beside it.
  search().value = 'zzz'; search().dispatchEvent(new w.Event('input'));
  expect(popup()!.querySelector('[role="listbox"]')!.children).toHaveLength(0);
  const none = popup()!.querySelector<HTMLElement>('.file-branch-empty')!;
  expect(none.textContent).toBe('No projects found');
  expect(none.closest('[role="listbox"]')).toBeNull();
  // The search ignores case and accents, as the app's other searches do.
  search().value = 'BETA'; search().dispatchEvent(new w.Event('input'));
  expect(options().map(option => option.textContent)).toEqual(['Bêta']);
  key(search(), 'ArrowDown');
  expect(doc.activeElement).toBe(options()[0]);
  key(doc.activeElement!, 'Escape');
  expect(popup()).toBeNull();
  expect(doc.activeElement).toBe(trigger());
  expect(trigger().getAttribute('aria-expanded')).toBe('false');
  // Enter in the field picks the first match.
  trigger().click();
  search().value = 'bet'; search().dispatchEvent(new w.Event('input'));
  key(search(), 'Enter');
  expect(popup()).toBeNull();
  expect(trigger().textContent).toBe('Bêta');
  expect(doc.activeElement).toBe(trigger());
  expect(doc.querySelector('.sess[data-id="a1"]')).toBeNull();
  expect(doc.querySelector('.sess-card[data-id="b1"]')).not.toBeNull();
  // The project's own history, the read opening it in the tree makes.
  await waitFor(() => expect(listSessions.mock.calls.filter(([options]) => options?.projectId === beta.id)).toHaveLength(1));
  await settle();
  // As many chats as the tree's section would hold, then the tree's "Show more".
  const settledIds = () => [...doc.querySelectorAll<HTMLElement>('.inbox-settled .sess')].map(row => row.dataset.id);
  expect(settledIds()).toEqual(['b-old-0', 'b-old-1', 'b-old-2', 'b-old-3']);
  // Settled counts the lines it draws; "Show more" follows it, outside it.
  expect(doc.querySelector('.inbox-settled .inbox-count')?.textContent).toBe('4');
  const more = doc.querySelector<HTMLButtonElement>('#chatList [data-inbox-control="show-more"]')!;
  expect(more.closest('.inbox-settled')).toBeNull();
  expect(more.previousElementSibling?.classList.contains('inbox-settled')).toBe(true);
  expect(more.getAttribute('aria-label')).toBe('Show more tasks in Bêta');
  more.click();
  await waitFor(() => expect(listSessions.mock.calls.filter(([options]) => options?.projectId === beta.id)).toHaveLength(2));
  expect(listSessions.mock.calls.at(-1)?.[0]).toMatchObject({ projectId: beta.id, cursor: { id: 'b-old-4' } });
  await waitFor(() => expect(settledIds()).toHaveLength(7));
  expect(doc.querySelector('.project-show-more')).toBeNull();
  // A new chat from here opens in the chosen project.
  doc.querySelector<HTMLButtonElement>('#chatList [data-inbox-control="compose"]')!.click();
  expect((doc.getElementById('chatInput') as HTMLTextAreaElement).placeholder).toBe('Message in Bêta…');
});

it('opens the add-project menu at the inbox\'s own add button, with a folder here or on a server', async () => {
  const mounted = await mountInbox({ listSessions: async () => listed([inboxChat('a1', { updatedAt: Date.now() })]) });
  const doc = mounted.window.document;
  const add = () => doc.querySelector<HTMLButtonElement>('#chatList [data-inbox-control="add"]')!;
  await waitFor(() => expect(doc.querySelector('.sess-card[data-id="a1"]')).not.toBeNull());
  add().click();
  await waitFor(() => expect(doc.querySelector('.row-menu [data-row-action="add-ssh-project"]')).not.toBeNull());
  expect(doc.querySelector('.row-menu [data-row-action="add-local-project"]')).not.toBeNull();
  // The menu belongs to the button the person used, not the hidden Projects heading.
  expect(add().getAttribute('aria-expanded')).toBe('true');
  closeRowMenus(doc);
  expect(doc.activeElement).toBe(add());
});

it('offers the chosen project\'s own menu in the inbox: Retry ChatGPT Project for a failed link, and Remove returns to All', async () => {
  const { alpha } = inboxProjects();
  const failed = { ...alpha, chatgpt: { state: 'failed' as const, requestId: 'r1', error: 'x', updatedAt: 1 } };
  const retryChatgptProject = vi.fn(async () => ({ ok: true, data: { ...alpha, chatgpt: { state: 'creating', requestId: 'r2', owner: 'o', updatedAt: 2 } } }));
  const removeProject = vi.fn(async () => ({ ok: true, data: { ...alpha, ungrouped: true } }));
  const mounted = await mountInbox({
    listProjects: async () => ({ ok: true, data: [failed] }), retryChatgptProject, removeProject,
    listSessions: async () => listed([inboxChat('a1', { projectId: alpha.id, updatedAt: Date.now() })])
  });
  const doc = mounted.window.document, w = mounted.window;
  const trigger = () => doc.querySelector<HTMLButtonElement>('#chatList [data-inbox-control="picker"]')!;
  const menuButton = () => doc.querySelector<HTMLButtonElement>(`#chatList [data-row-menu="project:${alpha.id}"]`);
  await waitFor(() => expect(doc.querySelector('.sess-card[data-id="a1"]')).not.toBeNull());
  expect(menuButton()).toBeNull();
  trigger().click();
  const option = [...doc.querySelectorAll<HTMLButtonElement>('.inbox-project-picker [role="option"]')].find(entry => entry.textContent?.startsWith('Alpha'))!;
  // The link state shows where the project is chosen, with the line that points at Retry.
  expect(option.querySelector('.file-branch-hint')?.textContent).toBe('ChatGPT Project unavailable');
  expect(option.title).toContain("This project's ChatGPT Project isn't available. Retry it from the project's menu.");
  option.click();
  expect(trigger().title).toContain("This project's ChatGPT Project isn't available. Retry it from the project's menu.");
  expect(trigger().querySelector('.session-status.is-failed')).not.toBeNull();
  // The tree's own menu button: the same owner, popup and expanded state.
  expect(menuButton()!.getAttribute('aria-haspopup')).toBe('menu');
  menuButton()!.click();
  expect(menuButton()!.getAttribute('aria-expanded')).toBe('true');
  expect(doc.querySelector('.row-menu [data-row-action="color"]')).not.toBeNull();
  // Escape gives focus back to the button, as in the tree.
  doc.querySelector('.row-menu')!.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(doc.activeElement).toBe(menuButton());
  menuButton()!.click();
  doc.querySelector<HTMLButtonElement>('.row-menu [data-row-action="chatgpt-retry"]')!.click();
  await waitFor(() => expect(retryChatgptProject).toHaveBeenCalledWith(alpha.id));
  await waitFor(() => expect(trigger().title).toContain('Creating this project in ChatGPT…'));
  expect(trigger().querySelector('.session-status.is-active')).not.toBeNull();
  trigger().click();
  expect(doc.querySelector('.inbox-project-picker [role="option"][aria-selected="true"] .file-branch-hint')?.textContent).toBe('Creating in ChatGPT…');
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  // Removing the chosen project returns the list to All, and the keyboard to the filter.
  menuButton()!.focus(); menuButton()!.click();
  doc.querySelector<HTMLButtonElement>('.row-menu [data-row-action="remove"]')!.click();
  await waitFor(() => expect(removeProject).toHaveBeenCalledWith(alpha.id));
  await waitFor(() => expect(trigger().textContent).toBe('All'));
  expect(menuButton()).toBeNull();
  expect(doc.activeElement).toBe(trigger());
});

it('keeps keyboard focus on the same card, worker arrow or filter across a live inbox repaint, and opens a card by keyboard', async () => {
  const mounted = await mountInbox({
    listSessions: async () => listed([
      inboxChat('a1', { updatedAt: Date.now() }),
      inboxChat('w1', { origin: { kind: 'worker', fromSessionId: 'a1', agentId: 'w1', task: '' }, activityExpiresAt: Date.now() + 60 * 60_000 })
    ])
  });
  const doc = mounted.window.document, w = mounted.window;
  const cardTop = () => doc.querySelector<HTMLElement>('.sess-card[data-id="a1"] > .sess-top')!;
  await waitFor(() => expect(doc.querySelector('.sess-card[data-id="a1"]')).not.toBeNull());
  const repaint = async () => { mounted.push(structuredClone(mounted.state)); await settle(); };
  const before = cardTop();
  before.focus();
  await repaint();
  expect(cardTop()).not.toBe(before);
  expect(doc.activeElement).toBe(cardTop());
  const toggle = () => doc.querySelector<HTMLElement>('.sess-card[data-id="a1"] > .worker-toggle')!;
  toggle().focus();
  await repaint();
  expect(doc.activeElement).toBe(toggle());
  const trigger = () => doc.querySelector<HTMLElement>('#chatList [data-inbox-control="picker"]')!;
  trigger().focus();
  await repaint();
  expect(doc.activeElement).toBe(trigger());
  // Typing elsewhere is never interrupted.
  const input = doc.getElementById('chatInput') as HTMLTextAreaElement;
  input.focus();
  await repaint();
  expect(doc.activeElement).toBe(input);
  // A card opens with Enter, as a tree row does, and keeps the keyboard.
  cardTop().focus();
  cardTop().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle();
  expect(doc.querySelector('.sess-card[data-id="a1"]')!.classList.contains('is-sel')).toBe(true);
  expect(doc.activeElement).toBe(cardTop());
});

it("opens the next and previous chat in the sidebar's drawn order with Ctrl+Tab and Ctrl+Shift+Tab, wrapping at the ends", async () => {
  const { project, session } = projectSidebarFixture();
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [project] }),
    listSessions: async () => listed([session, inboxChat('c1'), inboxChat('c2'), inboxChat('c3')])
  });
  const doc = mounted.window.document, w = mounted.window;
  await waitFor(() => expect(doc.querySelector('#chatList .sess[data-id="c3"]')).not.toBeNull());
  const selected = () => doc.querySelector<HTMLElement>('#sessionList .sess.is-sel')?.dataset.id;
  const press = (shiftKey = false, target: EventTarget = doc.body, repeat = false) => {
    const event = new w.KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, shiftKey, repeat, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(selected()).toBeUndefined();
  // From a new chat: the first chat drawn. The collapsed project's chat is not on the way.
  expect(press()).toBe(true);
  expect(selected()).toBe('c1');
  press(); expect(selected()).toBe('c2');
  press(true); expect(selected()).toBe('c1');
  // The ends wrap, as a browser's tabs do; a held key does not race through the list.
  press(true); expect(selected()).toBe('c3');
  expect(press(false, doc.body, true)).toBe(true); expect(selected()).toBe('c3');
  press(); expect(selected()).toBe('c1');
  // An opened project's chat takes its place in the order, above the chats outside projects.
  doc.querySelector<HTMLElement>(`[data-project-id="${project.id}"] > .project-heading`)!.click();
  press(true); expect(selected()).toBe('project-session');
  // From a library page the step shows the chat, as a click on its row does.
  doc.getElementById('sidebarPlugins')!.click();
  expect(doc.querySelector<HTMLElement>('.app')!.dataset.screen).toBe('library');
  press(); expect(selected()).toBe('c1');
  expect(doc.querySelector<HTMLElement>('.app')!.dataset.screen).toBe('chat');
  // The terminal keeps its keys; Settings hides the list, so there is nothing to walk.
  const terminal = doc.createElement('div'); terminal.className = 'xterm'; doc.body.append(terminal);
  expect(press(false, terminal)).toBe(false); expect(selected()).toBe('c1');
  doc.getElementById('workspaceSettings')!.click();
  expect(press()).toBe(false); expect(selected()).toBe('c1');
});

it('keeps keyboard focus with the chat Ctrl+Tab opens in the Inbox, and leaves the keys to the open project picker', async () => {
  const mounted = await mountInbox({ listSessions: async () => listed(['c1', 'c2', 'c3'].map(id => inboxChat(id, { updatedAt: Date.now() }))) });
  const doc = mounted.window.document, w = mounted.window;
  await waitFor(() => expect(inboxCardIds(doc)).toHaveLength(3));
  const [first, second] = inboxCardIds(doc);
  const top = (id: string) => doc.querySelector<HTMLElement>(`#sessionList .sess[data-id="${id}"] > .sess-top`)!;
  const selected = () => doc.querySelector<HTMLElement>('#sessionList .sess.is-sel')?.dataset.id;
  const press = (target: EventTarget) => {
    const event = new w.KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  top(first!).click(); top(first!).focus();
  expect(press(doc.activeElement!)).toBe(true);
  expect(selected()).toBe(second);
  // Focus follows the chat that opened, so Enter does not reopen the one before it.
  expect(doc.activeElement).toBe(top(second!));
  // The picker is a popup, not a native dialog: its search field keeps Ctrl+Tab.
  doc.querySelector<HTMLButtonElement>('#chatList [data-inbox-control="picker"]')!.click();
  const search = doc.querySelector<HTMLInputElement>('.inbox-project-picker input')!;
  expect(doc.activeElement).toBe(search);
  expect(press(search)).toBe(false);
  expect(selected()).toBe(second);
});

it('ranks the inbox by what each chat needs: approval, stopped recovery, blocked, failed, then working, a new reply and the rest', async () => {
  const now = Date.now();
  // Newest last-touched first would be the reverse of the ranking: recency alone must not decide it.
  const sessions = [
    inboxChat('rest', { updatedAt: now }),
    inboxChat('unseen', { updatedAt: now - 1000, lastTurnOutcome: 'completed', lastTurnEndAt: now + 60_000 }),
    inboxChat('working', { updatedAt: now - 2000, activityExpiresAt: now + 60 * 60_000 }),
    inboxChat('failed', { updatedAt: now - 3000, lastTurnOutcome: 'failed' }),
    inboxChat('stalled', { updatedAt: now - 3500, lastTurnOutcome: 'stalled' }),
    inboxChat('blocked', { updatedAt: now - 4000 }),
    inboxChat('recovery', { updatedAt: now - 5000 }),
    // Waiting on an approval card while its turn is still open: what it needs outranks that it works.
    inboxChat('approval', { updatedAt: now - 6000, activeTurnId: 'turn-1', activityExpiresAt: now + 60 * 60_000 })
  ];
  const mounted = await mountInbox({
    listSessions: async () => listed(sessions, { blocked: ['c-blocked'], approval: ['c-approval'], recoveryStopped: ['c-recovery'] })
  });
  const doc = mounted.window.document;
  await waitFor(() => expect(inboxCardIds(doc)).toHaveLength(8));
  expect(inboxCardIds(doc)).toEqual(['approval', 'recovery', 'blocked', 'failed', 'stalled', 'working', 'unseen', 'rest']);
  // Each state in one word or two on the meta line, with its own glyph, the title and the button's own text saying it too.
  const expected: Array<[string, string, string]> = [
    ['approval', 'Needs approval', 'ph-lock-key'], ['recovery', 'Recovery slowed', 'ph-arrow-clockwise'],
    ['blocked', 'Blocked', 'ph-prohibit'], ['failed', 'Failed', 'ph-warning'], ['stalled', 'Failed', 'ph-warning']
  ];
  for (const [id, label, glyph] of expected) {
    const { card, state, top } = inboxCardState(doc, id);
    expect(state.textContent, id).toBe(label);
    expect(state.classList.contains('is-attention'), id).toBe(true);
    expect(state.querySelector(`.ico.${glyph}`), id).not.toBeNull();
    // The title says it in the row badge's own word ("blocked"), the meta line as a label.
    expect(card.title.toLowerCase(), id).toContain(label.toLowerCase());
    expect(top.textContent, id).toContain(label);
  }
  expect(inboxCardState(doc, 'working').state.textContent).toBe('Working');
  expect(inboxCardState(doc, 'unseen').state.textContent).toBe('New response');
  expect(inboxCardState(doc, 'rest').state.classList.contains('is-attention')).toBe(false);
  // The Projects tree's own status dot says the same for a chat waiting on approval or a stopped recovery, as it does for a block.
  expect(inboxCardState(doc, 'approval').card.title).toMatch(/^approval · Needs approval · /);
});

it('keeps Draft in the title of an inbox card and a settled row that say Failed', async () => {
  const old = Date.now() - 3 * DAY;
  const sessions = [
    inboxChat('rest', { updatedAt: Date.now() }),
    inboxChat('failed', { updatedAt: Date.now() - 3000, lastTurnOutcome: 'failed' }),
    inboxChat('settled', { startedAt: old, updatedAt: old, lastTurnOutcome: 'failed' })
  ];
  const mounted = await mountInbox({ listSessions: async () => listed(sessions) });
  const doc = mounted.window.document;
  const row = (id: string) => doc.querySelector<HTMLElement>(`#sessionList .sess[data-id="${id}"]`)!;
  await vi.waitFor(() => expect(row('settled')).not.toBeNull(), { timeout: 5000 });
  expect(row('settled').classList.contains('sess-settled')).toBe(true);
  expect(row('failed').classList.contains('sess-card')).toBe(true);
  const input = doc.getElementById('chatInput') as HTMLTextAreaElement;
  for (const id of ['failed', 'settled']) {
    row(id).querySelector<HTMLElement>('[data-session-select]')!.click(); await settle();
    input.value = `Unsent ${id}`; input.dispatchEvent(new mounted.window.Event('input'));
  }
  row('rest').querySelector<HTMLElement>('[data-session-select]')!.click(); await settle();
  for (const id of ['failed', 'settled']) {
    expect(row(id).querySelector('.sess-draft-mark'), id).not.toBeNull();
    expect(row(id).title, id).toContain('Failed');
    expect(row(id).title, id).toContain('Draft');
  }
});

it('calls an unread reply a New response on its card, the word its row badge already uses', async () => {
  const now = Date.now();
  const mounted = await mountInbox({
    listSessions: async () => listed([inboxChat('unseen', { updatedAt: now, lastTurnOutcome: 'completed', lastTurnEndAt: now + 60_000 })])
  });
  const doc = mounted.window.document;
  await waitFor(() => expect(inboxCardIds(doc)).toEqual(['unseen']));
  const { state, card } = inboxCardState(doc, 'unseen');
  expect(state.textContent).toBe('New response');
  expect(state.querySelector('.ico.ph-check-circle')).not.toBeNull();
  expect(card.title).toContain('New response');
  expect(card.textContent).not.toContain('Done');
});

it('writes a card and a settled line age in the app language', async () => {
  const now = Date.now();
  const mounted = await mountInbox({ listSessions: async () => listed([
    inboxChat('recent', { updatedAt: now - 5 * 60 * 60_000 }),
    inboxChat('quiet', { startedAt: now - 2 * DAY, updatedAt: now - 2 * DAY })
  ]) });
  const doc = mounted.window.document;
  await waitFor(() => expect(inboxCardIds(doc)).toEqual(['recent']));
  const cardAge = () => inboxCardState(doc, 'recent').state.querySelector('.sess-age')!.textContent;
  const settledAge = () => doc.querySelector('.inbox-settled > .sess[data-id="quiet"] .sess-age')!.textContent;
  expect([cardAge(), settledAge()]).toEqual(['5h', '2d']);
  const { setLanguage } = await import('../src/renderer/i18n.js');
  try {
    // The catalogs' compact tokens (2.1.47 round): the platform's narrow units wrote four months as
    // "4m" beside four minutes in English, Spanish and Japanese, and Latin letters in Japanese.
    setLanguage('ru');
    expect(cardAge()).toBe('5 ч');
    setLanguage('de');
    expect(settledAge()).toBe('2 T.');
  } finally {
    setLanguage('en');
  }
});

// CodeRabbit on #1904: a time that is not a number said "now", as if the chat had just been active.
it('shows no age for a chat whose time is not a number, rather than "now"', async () => {
  const now = Date.now();
  const mounted = await mountInbox({ listSessions: async () => listed([inboxChat('broken', { updatedAt: Number.NaN }), inboxChat('fresh', { updatedAt: now })]) });
  const doc = mounted.window.document;
  const ageOf = (id: string) => doc.querySelector(`.sess[data-id="${id}"] .sess-age`)?.textContent;
  // The fresh chat's age is drawn by now, so the broken one's is too.
  await waitFor(() => expect(ageOf('fresh')).toBe('now'));
  expect([ageOf('broken'), ageOf('fresh')]).toEqual(['', 'now']);
});

it('says No project on the card of a chat outside every project', async () => {
  const now = Date.now();
  const mounted = await mountInbox({ listSessions: async () => listed([inboxChat('loose', { updatedAt: now })]) });
  const doc = mounted.window.document;
  await waitFor(() => expect(inboxCardIds(doc)).toEqual(['loose']));
  const project = inboxCardState(doc, 'loose').card.querySelector<HTMLElement>('.sess-meta > .sess-project')!;
  expect(project.textContent).toBe('No project');
  expect(project.querySelector('.ico.ph-chat-circle, .ico.project-mark')).not.toBeNull();
});

it('never settles a chat waiting on approval, a stopped recovery or a block, nor a parent whose worker does; a failed one settles after a day and still says so', async () => {
  const old = Date.now() - 3 * DAY;
  const worker = (id: string, parent: string) => inboxChat(id, {
    startedAt: old, updatedAt: old, origin: { kind: 'worker', fromSessionId: parent, agentId: id, task: '' }
  });
  const sessions = [
    inboxChat('approval', { startedAt: old, updatedAt: old }),
    inboxChat('recovery', { startedAt: old, updatedAt: old }),
    inboxChat('blocked', { startedAt: old, updatedAt: old }),
    inboxChat('failed', { startedAt: old, updatedAt: old, lastTurnOutcome: 'failed' }),
    inboxChat('stalled', { startedAt: old, updatedAt: old, lastTurnOutcome: 'stalled' }),
    inboxChat('parent-approval', { startedAt: old, updatedAt: old }), worker('w-approval', 'parent-approval'),
    inboxChat('parent-recovery', { startedAt: old, updatedAt: old }), worker('w-recovery', 'parent-recovery'),
    inboxChat('plain', { startedAt: old, updatedAt: old }),
    // A failed turn that something followed is over: the newer turn is open.
    inboxChat('failed-then-more', { startedAt: old, updatedAt: old - 1, lastTurnOutcome: 'interrupted' })
  ];
  const mounted = await mountInbox({ listSessions: async () => listed(sessions, {
    blocked: ['c-blocked'], approval: ['c-approval', 'c-w-approval'], recoveryStopped: ['c-recovery', 'c-w-recovery']
  }) });
  const doc = mounted.window.document;
  await waitFor(() => expect(doc.querySelector('.inbox-settled')).not.toBeNull());
  const settled = [...doc.querySelectorAll<HTMLElement>('.inbox-settled > .sess')].map(row => row.dataset.id);
  // Settled chats order by recency alone: a failed turn three days old is no longer a reason to lead.
  expect(settled).toEqual(['failed', 'stalled', 'plain', 'failed-then-more']);
  expect(inboxCardIds(doc)).toEqual(['approval', 'parent-approval', 'recovery', 'parent-recovery', 'blocked']);
  // A settled line that failed still says so, with the card's own glyph and word, in its title too.
  for (const id of ['failed', 'stalled']) {
    const row = doc.querySelector<HTMLElement>(`.inbox-settled > .sess[data-id="${id}"]`)!;
    const state = row.querySelector<HTMLElement>('.sess-top > .sess-state.is-attention')!;
    expect(state.querySelector('.ico.ph-warning'), id).not.toBeNull();
    expect(state.textContent, id).toContain('Failed');
    expect(row.title, id).toMatch(new RegExp(`^${id} · Failed · `));
  }
  expect(doc.querySelector('.inbox-settled > .sess[data-id="plain"] .sess-state')).toBeNull();
  // One tooltip at a time (#1862): while the app's own shows, the row hands it its title, so the browser
  // shows no second one; the title comes back when the pointer leaves.
  const plain = doc.querySelector<HTMLElement>('.inbox-settled > .sess[data-id="plain"]')!;
  const said = plain.title;
  plain.dispatchEvent(new mounted.window.Event('pointerenter'));
  expect(plain.hasAttribute('title')).toBe(false);
  expect(doc.getElementById('sessionTooltip')!.textContent).toBe(said);
  plain.dispatchEvent(new mounted.window.Event('pointerleave'));
  expect(plain.title).toBe(said);
  expect(doc.getElementById('sessionTooltip')).toBeNull();
  // Opening the row's menu puts the tooltip away and gives the row its title back at once.
  plain.dispatchEvent(new mounted.window.Event('pointerenter'));
  plain.dispatchEvent(new mounted.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  expect(doc.getElementById('sessionTooltip')).toBeNull();
  expect(plain.title).toBe(said);
  doc.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  plain.dispatchEvent(new mounted.window.Event('pointerleave'));
  // The parent's line counts the worker that needs the person.
  expect(inboxCardState(doc, 'parent-approval').card.querySelector('.sess-workers')?.textContent).toBe('1 needs attention');
  expect(inboxCardState(doc, 'parent-recovery').card.querySelector('.sess-workers')?.textContent).toBe('1 needs attention');
});

it('limits a chosen project\'s inbox to its tree page across cards and settled lines, never hiding the selected chat or one that needs the person', async () => {
  const { alpha } = inboxProjects();
  const now = Date.now(), old = now - 3 * DAY;
  const recent = Array.from({ length: 7 }, (_, index) => inboxChat(`p${index}`, { projectId: alpha.id, updatedAt: now - index * 1000 }));
  const sessions = [
    ...recent,
    inboxChat('needs', { projectId: alpha.id, startedAt: old, updatedAt: old }),
    inboxChat('sel', { projectId: alpha.id, startedAt: old, updatedAt: old - 1000 }),
    inboxChat('quiet', { projectId: alpha.id, startedAt: old, updatedAt: old - 2000 })
  ];
  const mounted = await mountInbox({
    listProjects: async () => ({ ok: true, data: [alpha] }),
    listSessions: async () => listed(sessions, { blocked: ['c-needs'] })
  });
  const doc = mounted.window.document;
  const row = (id: string) => doc.querySelector<HTMLElement>(`#chatList .sess[data-id="${id}"]`);
  const settledIds = () => [...doc.querySelectorAll<HTMLElement>('.inbox-settled > .sess')].map(entry => entry.dataset.id);
  await waitFor(() => expect(row('sel')).not.toBeNull());
  row('sel')!.querySelector<HTMLElement>('.sess-top')!.click();
  await settle();
  // Five pinned chats lead the list, so the blocked one comes after a whole page of them.
  for (const id of ['p0', 'p1', 'p2', 'p3', 'p4']) rowMenuItem(row(id)!, 'pin')!.click();
  expect(inboxCardIds(doc).slice(0, 6)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'needs']);
  doc.querySelector<HTMLButtonElement>('#chatList [data-inbox-control="picker"]')!.click();
  [...doc.querySelectorAll<HTMLButtonElement>('.inbox-project-picker [role="option"]')].find(option => option.textContent === 'Alpha')!.click();
  await settle();
  // A page of five, cards first; the blocked chat and the selected one stay beyond it.
  expect(inboxCardIds(doc)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'needs']);
  expect(settledIds()).toEqual(['sel']);
  // The count is the one line drawn, not the two settled chats.
  const count = () => doc.querySelector('.inbox-settled .inbox-count')?.textContent;
  expect(count()).toBe('1');
  // "Show more" reads on the whole list, so a closed Settled does not hide it.
  const box = doc.querySelector<HTMLDetailsElement>('.inbox-settled')!;
  box.open = false; box.dispatchEvent(new mounted.window.Event('toggle'));
  const more = doc.querySelector<HTMLButtonElement>('#chatList > [data-inbox-control="show-more"]')!;
  expect(more).not.toBeNull();
  expect(more.closest('.inbox-settled')).toBeNull();
  expect(more.previousElementSibling).toBe(box);
  more.click();
  await settle();
  expect(inboxCardIds(doc)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'needs', 'p5', 'p6']);
  expect(doc.querySelector<HTMLDetailsElement>('.inbox-settled')!.open).toBe(false);
  expect(settledIds()).toEqual(['sel', 'quiet']);
  expect(count()).toBe('2');
  expect(doc.querySelector('#chatList [data-inbox-control="show-more"]')).toBeNull();
});

it('moves a card live when the session list reports a new state, keeping keyboard focus on it', async () => {
  const now = Date.now();
  let approval: string[] = [];
  let changed: () => void = () => undefined;
  const mounted = await mountInbox({
    listSessions: async () => listed([inboxChat('a1', { updatedAt: now - 1000 }), inboxChat('a2', { updatedAt: now })], { approval }),
    onSessionChanged: (fn: () => void) => { changed = fn; return () => undefined; }
  });
  const doc = mounted.window.document;
  await waitFor(() => expect(inboxCardIds(doc)).toEqual(['a2', 'a1']));
  inboxCardState(doc, 'a1').top.focus();
  approval = ['c-a1'];
  changed();
  await waitFor(() => expect(inboxCardIds(doc)).toEqual(['a1', 'a2']));
  expect(inboxCardState(doc, 'a1').state.textContent).toBe('Needs approval');
  expect(doc.activeElement).toBe(inboxCardState(doc, 'a1').top);
  // Approved: the card goes back to its place by recency, the keyboard still on it.
  approval = [];
  changed();
  await waitFor(() => expect(inboxCardIds(doc)).toEqual(['a2', 'a1']));
  expect(inboxCardState(doc, 'a1').state.classList.contains('is-attention')).toBe(false);
  expect(doc.activeElement).toBe(inboxCardState(doc, 'a1').top);
});

it('shows unattributed activity at the end of the inbox, as the tree does, with its Allow/Block switch', async () => {
  const loose = inboxChat('loose', { title: 'Unattributed activity', conversationId: null, chatIds: [] });
  let rows: unknown[] = [loose];
  let changed: () => void = () => undefined;
  const mounted = await mountInbox({
    listSessions: async () => listed(rows),
    onSessionChanged: (fn: () => void) => { changed = fn; return () => undefined; }
  });
  const doc = mounted.window.document;
  const list = doc.getElementById('chatList')!;
  const box = () => list.querySelector<HTMLDetailsElement>(':scope > details.session-diagnostics');
  await waitFor(() => expect(box()).not.toBeNull());
  expect(box()!.querySelector('summary')?.textContent).toBe('Unattributed activity · 1');
  // Only unattributed rows: the list is not empty, and does not say so.
  expect(list.querySelector('.empty')).toBeNull();
  expect(list.lastElementChild).toBe(box());
  expect(rowMenuItem(box()!.querySelector('.sess[data-id="loose"]')!, 'block')?.textContent).toContain('Allow unattributed calls');
  closeRowMenus(doc);
  // With a chat beside it, the disclosure is still the last thing in the list, and never a card.
  rows = [inboxChat('a1', { updatedAt: Date.now() }), loose];
  changed();
  await waitFor(() => expect(inboxCardIds(doc)).toEqual(['a1']));
  expect(list.lastElementChild).toBe(box());
  expect(doc.querySelectorAll('.sess[data-id="loose"]')).toHaveLength(1);
  // A live repaint keeps the keyboard on the disclosure it was on.
  const before = box()!.querySelector<HTMLElement>('summary')!;
  before.focus();
  rows = [inboxChat('a1', { updatedAt: Date.now() + 1 }), loose];
  changed();
  await waitFor(() => expect(box()!.querySelector('summary')).not.toBe(before));
  expect(doc.activeElement).toBe(box()!.querySelector('summary'));
});

it('marks a collapsed chat whose sub-agent needs you, over its own spinner, in the project tree', async () => {
  // VM, 2026-10-20: a worker waited on ChatGPT's approval card for half an hour; its chat's row in
  // the tree showed only the arrow, so nothing said it needed anyone until the row was opened.
  const old = Date.now() - 3 * DAY;
  const sessions = [
    inboxChat('parent', { title: 'Parent task', startedAt: old, updatedAt: old, activityExpiresAt: Date.now() + 60 * 60_000 }),
    inboxChat('w-needs', { startedAt: old, updatedAt: old, origin: { kind: 'worker', fromSessionId: 'parent', agentId: 'worker-1', task: '' } }),
    inboxChat('w-runs', { startedAt: old, updatedAt: old, activityExpiresAt: Date.now() + 60 * 60_000,
      origin: { kind: 'worker', fromSessionId: 'parent', agentId: 'worker-2', task: '' } }),
    inboxChat('calm', { title: 'Calm parent', startedAt: old, updatedAt: old }),
    inboxChat('w-calm', { startedAt: old, updatedAt: old, activityExpiresAt: Date.now() + 60 * 60_000,
      origin: { kind: 'worker', fromSessionId: 'calm', agentId: 'worker-3', task: '' } })
  ];
  const mounted = await mountChat({}, [], { listSessions: async () => listed(sessions, { approval: ['c-w-needs'] }) });
  const doc = mounted.window.document;
  const row = (id: string) => doc.querySelector<HTMLElement>(`#chatList .sess[data-id="${id}"]`);
  await waitFor(() => expect(row('parent')).not.toBeNull());
  const marks = (id: string) => [...row(id)!.querySelectorAll<HTMLElement>('.sess-top .session-status')];
  // One mark, the sub-agent's need, in place of the chat's own spinner, and the row's title says it.
  expect(marks('parent').map(mark => [mark.className, mark.getAttribute('aria-label')]))
    .toEqual([['session-status is-failed', '1 sub-agent needs attention']]);
  expect(row('parent')!.title).toContain('1 sub-agent needs attention');
  // Workers that only run leave their chat as it is.
  expect(marks('calm').map(mark => mark.className)).toEqual([]);
  // Opened, the worker's own row carries the mark, and the chat shows its own state again.
  row('parent')!.querySelector<HTMLButtonElement>('.worker-toggle')!.click();
  await waitFor(() => expect(row('w-needs')).not.toBeNull());
  expect(marks('w-needs').map(mark => mark.className)).toEqual(['session-status is-failed']);
  expect(marks('parent').map(mark => mark.className)).toEqual(['session-status is-active']);
});

it('keeps a number setting as it was when its field is left empty', async () => {
  // Number('') is 0: an emptied threshold field was saved as its 10,000-token minimum, so every
  // chat would compact almost at once, and an emptied worker limit fell to 1.
  const mounted = await mountChat();
  await settle();
  const doc = mounted.window.document;
  const before = structuredClone(mounted.state.config);
  for (const id of ['autoCompactTokens', 'maWorkers', 'globalMaWorkers']) {
    const field = doc.getElementById(id) as HTMLInputElement;
    field.value = '   ';
    field.dispatchEvent(new mounted.window.Event('change'));
  }
  await waitFor(() => expect(mounted.calls.length).toBeGreaterThan(0));
  await settle();
  const last = mounted.calls.at(-1);
  expect(last.compaction.autoTokens).toBe(before.compaction.autoTokens);
  expect(last.multiAgent.maxWorkers).toBe(before.multiAgent.maxWorkers);
  expect(last.multiAgent.globalMaxWorkers ?? 0).toBe(before.multiAgent.globalMaxWorkers ?? 0);
  // The field shows the kept value again, not an empty box.
  expect((doc.getElementById('autoCompactTokens') as HTMLInputElement).value).toBe(String(before.compaction.autoTokens));
});

it('draws the inbox when the layout changes before any chat is loaded, and the tree again when it changes back', async () => {
  const mounted = await mountChat();
  await settle();
  const doc = mounted.window.document;
  const { defaultAppearance } = await import('../src/shared/appearance.js');
  const layout = (sidebarLayout: 'inbox' | 'projects') => {
    mounted.state.config = { ...mounted.state.config, ui: { ...mounted.state.config.ui, appearance: { ...defaultAppearance(), sidebarLayout } } };
    mounted.push(structuredClone(mounted.state));
  };
  expect(doc.querySelector('#chatList .inbox-top')).toBeNull();
  layout('inbox');
  expect(doc.getElementById('sessionList')!.classList.contains('is-inbox')).toBe(true);
  expect(doc.querySelector('#chatList .inbox-top [data-inbox-control="picker"]')).not.toBeNull();
  expect(doc.querySelector('#chatList > .empty')?.textContent).toBe('No chats yet.');
  layout('projects');
  expect(doc.getElementById('sessionList')!.classList.contains('is-inbox')).toBe(false);
  expect(doc.querySelector('#chatList .inbox-top')).toBeNull();
});

it('says a chosen project\'s chats are loading while its history is read, and offers Retry after a failed read', async () => {
  const { alpha } = inboxProjects();
  const reads: Array<(reply: unknown) => void> = [];
  // One chat outside every project, so the list under All is drawn and not empty.
  const listSessions = vi.fn((options?: { projectId?: string }) => options?.projectId
    ? new Promise(resolve => reads.push(resolve)) : Promise.resolve(listed([inboxChat('loose', { updatedAt: Date.now() })])));
  const mounted = await mountInbox({ listProjects: async () => ({ ok: true, data: [alpha] }), listSessions });
  const doc = mounted.window.document;
  const empty = () => doc.querySelector<HTMLElement>('#chatList > .empty');
  await waitFor(() => expect(inboxCardIds(doc)).toEqual(['loose']));
  doc.querySelector<HTMLButtonElement>('#chatList [data-inbox-control="picker"]')!.click();
  [...doc.querySelectorAll<HTMLButtonElement>('.inbox-project-picker [role="option"]')].find(option => option.textContent === 'Alpha')!.click();
  // Not known to be empty yet.
  expect(empty()?.textContent).toBe('Loading chats…');
  expect(empty()?.getAttribute('role')).toBe('status');
  await waitFor(() => expect(reads).toHaveLength(1));
  reads[0]!({ ok: false, error: 'boom' });
  await waitFor(() => expect(doc.querySelector('#chatList [data-inbox-control="retry"]')).not.toBeNull());
  expect(empty()?.textContent).toContain("Could not load this project's chats.");
  expect(empty()?.textContent).not.toContain('No chats yet.');
  const retry = doc.querySelector<HTMLButtonElement>('#chatList [data-inbox-control="retry"]')!;
  expect(retry.textContent).toBe('Retry');
  retry.click();
  expect(empty()?.textContent).toBe('Loading chats…');
  await waitFor(() => expect(reads).toHaveLength(2));
  expect(listSessions.mock.calls.at(-1)?.[0]).toMatchObject({ projectId: alpha.id });
  reads[1]!(listed([inboxChat('a1', { projectId: alpha.id, updatedAt: Date.now() })], { nextCursor: null }));
  await waitFor(() => expect(inboxCardIds(doc)).toEqual(['a1']));
  expect(empty()).toBeNull();
});

it('says No chats yet. once a chosen project\'s history is read and holds none', async () => {
  const { alpha } = inboxProjects();
  const mounted = await mountInbox({
    listProjects: async () => ({ ok: true, data: [alpha] }),
    listSessions: async (options?: { projectId?: string }) =>
      listed(options?.projectId ? [] : [inboxChat('loose', { updatedAt: Date.now() })], { nextCursor: null })
  });
  const doc = mounted.window.document;
  const empty = () => doc.querySelector<HTMLElement>('#chatList > .empty');
  await waitFor(() => expect(inboxCardIds(doc)).toEqual(['loose']));
  doc.querySelector<HTMLButtonElement>('#chatList [data-inbox-control="picker"]')!.click();
  [...doc.querySelectorAll<HTMLButtonElement>('.inbox-project-picker [role="option"]')].find(option => option.textContent === 'Alpha')!.click();
  await waitFor(() => expect(empty()?.textContent).toBe('No chats yet.'));
});

it('commits a project summary click before an immediate state repaint replaces its details node', async () => {
  const { project, session } = projectSidebarFixture();
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [project] }),
    listSessions: async () => ({ ok: true, data: { sessions: [session], activeId: null, pressure: [], blocked: [] } })
  });
  const group = () => mounted.window.document.querySelector<HTMLDetailsElement>(`[data-project-id="${project.id}"]`)!;
  await waitFor(() => expect(group()).not.toBeNull());
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
  await waitFor(() => expect(row()).not.toBeNull());
  const item = rowMenuItem(row(), 'copy-link')!;
  expect(item.textContent).toContain('Copy link');
  // It sits right after Open in browser.
  expect(item.previousElementSibling?.getAttribute('data-row-action')).toBe('open');
  item.click();
  await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith('https://chatgpt.com/c/linked-chat-0001'));
  await waitFor(() => expect(doc.querySelector('.toast')?.textContent).toBe('Link copied'));
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
  await waitFor(() => expect(rowMenuItem(primeRow(), 'trust')).not.toBeNull());
  closeRowMenus(doc);
  expect(rowMenuItem(workerRow(), 'trust')).toBeNull();
  expect(doc.querySelector('.row-menu [data-row-action="block"]')).not.toBeNull();
  closeRowMenus(doc);

  rowMenuItem(primeRow(), 'trust')!.click();
  await waitFor(() => expect(setSessionTrusted).toHaveBeenCalledWith(session.id, session.conversationId, true));
  expect(setSessionBlocked).not.toHaveBeenCalled();

  rowMenuItem(primeRow(), 'block')!.click();
  await waitFor(() => expect(setSessionBlocked).toHaveBeenCalledWith(session.id, true));
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
  await waitFor(() => expect(rowMenuItem(row(), 'trust')).not.toBeNull());
  const trust = rowMenuItem(row(), 'trust')!;
  expect(trust.textContent).toBe('Untrust chat');
  expect(doc.querySelector('.row-menu [data-row-action="block"]')!.textContent).toBe('Block chat');
  trust.click();
  await waitFor(() => expect(setSessionTrusted).toHaveBeenCalledWith(session.id, current, false));
});

it('offers a chat\'s actions in one menu, by kind of row, and opens it with a right click too', async () => {
  const base = { startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null };
  const chat = { ...base, id: 'menu-chat-0001', title: 'A chat', conversationId: 'menu-conversation-0001', chatIds: ['menu-conversation-0001'] };
  const loose = { ...base, id: 'menu-loose-0001', title: 'Unattributed activity', conversationId: null, chatIds: [] };
  // #1759: a new chat whose first message is still held (its ChatGPT Project is being created, or
  // could not be) has no conversation yet either, but it is a chat, not the unattributed bucket.
  const projectId = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
  const pending = { ...base, id: 'menu-pending-0001', title: 'Buenas!', conversationId: null, chatIds: [], projectId };
  // Renamed to the bucket's own title, a waiting chat is still a chat: only the bucket has no origin.
  const renamed = { ...base, id: 'menu-pending-0002', title: 'Unattributed activity', conversationId: null, chatIds: [], projectId,
    origin: { kind: 'desktop' as const, fromSessionId: null, agentId: null, task: '' } };
  const deleteSession = vi.fn(async () => ({ ok: true, data: true }));
  const openSessionChat = vi.fn(async () => ({ ok: true, data: true }));
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [{ id: projectId, name: 'Website', path: '/work/website', createdAt: 1 }] }),
    listSessions: async () => ({ ok: true, data: { sessions: [chat, loose, pending, renamed], activeId: null, pressure: [], blocked: [], trusted: [] } }),
    deleteSession, openSessionChat
  });
  const doc = mounted.window.document;
  const row = (id: string) => doc.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
  await waitFor(() => expect(row(chat.id)).not.toBeNull());
  // One button on the row, no loose icons.
  expect(row(chat.id).querySelectorAll('.sess-actions button').length).toBe(1);
  const actions = (): Array<string | undefined> => [...doc.querySelectorAll<HTMLElement>('.row-menu .row-menu-item')].map(item => item.dataset.rowAction);
  rowMenuItem(row(chat.id), 'rename');
  // Schedule… (#1826) sits with the chat's own actions.
  expect(actions()).toEqual(['pin', 'rename', 'open', 'copy-link', 'share', 'schedule', 'block', 'remove']);
  expect(doc.querySelector('.row-menu [data-row-action="remove"]')!.classList.contains('is-danger')).toBe(true);
  closeRowMenus(doc);
  // A row that is not a chat offers only what applies to it.
  await waitFor(() => expect(row(loose.id)).not.toBeNull());
  rowMenuItem(row(loose.id), 'block');
  expect(actions()).toEqual(['block', 'remove']);
  closeRowMenus(doc);
  const shown = (id: string) => `${row(id).textContent} ${[...row(id).querySelectorAll<HTMLElement>('[title]'), row(id)].map(node => node.getAttribute('title') ?? '').join(' ')}`;
  expect(shown(loose.id)).toContain('not a chat');
  // A chat still waiting for its ChatGPT conversation: no "not a chat", no unattributed switch,
  // and nothing that needs a ChatGPT link yet (open, copy link, block).
  await waitFor(() => expect(row(pending.id)).not.toBeNull());
  expect(shown(pending.id)).not.toContain('not a chat');
  expect(shown(pending.id)).not.toContain('blocked');
  // It is listed with the chats, not under "Unattributed activity" (which still holds the bucket).
  expect(row(pending.id).closest('.session-diagnostics')).toBeNull();
  expect(row(loose.id).closest('.session-diagnostics')).not.toBeNull();
  // Groups are kept by the chat's own id, so it can be sorted into one of its project's groups already.
  rowMenuItem(row(pending.id), 'rename');
  expect(actions()).toEqual(['rename', 'move-to-group', 'remove']);
  closeRowMenus(doc);
  expect(row(renamed.id).closest('.session-diagnostics')).toBeNull();
  expect(shown(renamed.id)).not.toContain('not a chat');
  rowMenuItem(row(renamed.id), 'rename');
  expect(actions()).toEqual(['rename', 'move-to-group', 'remove']);
  closeRowMenus(doc);
  // A right click opens the same menu; its items run their action.
  row(chat.id).dispatchEvent(new mounted.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }));
  doc.querySelector<HTMLButtonElement>('.row-menu [data-row-action="open"]')!.click();
  await waitFor(() => expect(openSessionChat).toHaveBeenCalledWith(chat.id));
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
  await waitFor(() => expect(row().querySelector('.row-menu-button')).not.toBeNull());
  expect(field()).toBeNull();
  const press = (key: string) => field()!.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key, bubbles: true }));
  const type = (text: string) => { field()!.value = text; field()!.dispatchEvent(new mounted.window.Event('input', { bubbles: true })); };

  // Escape: nothing is saved, the title is back.
  rowMenuItem(row(), 'rename')!.click();
  await waitFor(() => expect(field()).not.toBeNull());
  expect(field()!.value).toBe('ChatGPT title');
  type('Never saved');
  press('Escape');
  await waitFor(() => expect(field()).toBeNull());
  expect(renameSession).not.toHaveBeenCalled();
  expect(row().querySelector('.sess-top b')!.textContent).toBe('ChatGPT title');

  // The sidebar repaints while the user types; the field and its text survive.
  rowMenuItem(row(), 'rename')!.click();
  await waitFor(() => expect(field()).not.toBeNull());
  type('  Release   prep  ');
  const editing = field();
  mounted.push(structuredClone(mounted.state));
  await new Promise(resolve => setTimeout(resolve, 50));
  // The same node: an input method's composition would not survive a replaced field.
  expect(field()).toBe(editing);
  expect(field()?.value).toBe('  Release   prep  ');
  press('Enter');
  await waitFor(() => expect(renameSession).toHaveBeenCalledWith(session.id, 'Release   prep'));

  // Empty asks for ChatGPT's title again.
  rowMenuItem(row(), 'rename')!.click();
  await waitFor(() => expect(field()).not.toBeNull());
  type('   ');
  press('Enter');
  await waitFor(() => expect(renameSession).toHaveBeenLastCalledWith(session.id, null));
});

it('adds a few matching actions and settings under the chats while typing in ⌘K, and none before (#1884, Haz)', async () => {
  const searchSessions = vi.fn(async (query: string) => ({ ok: true, data: { results: query === 'new' ? [{ id: 'search-new-0001', title: 'New notes', projectId: null }] : [], indexed: 1, total: 1 } }));
  const mounted = await mountChat({}, [], { searchSessions });
  const doc = mounted.window.document;
  const field = doc.getElementById('chatSearch') as HTMLInputElement;
  const results = doc.getElementById('searchResults')!;
  const dialog = doc.getElementById('searchDialog') as HTMLDialogElement;
  const type = async (text: string) => { field.value = text; field.dispatchEvent(new mounted.window.Event('input', { bubbles: true })); await waitFor(() => expect(searchSessions).toHaveBeenLastCalledWith(text)); await settle(); };
  (doc.getElementById('searchChatsButton') as HTMLButtonElement).click();
  await settle();
  // Nothing typed: as before, no actions and no settings.
  expect(results.querySelector('.is-action, .is-setting')).toBeNull();
  await type('new');
  const headings = () => [...results.querySelectorAll('.search-heading')].map(node => node.textContent);
  // The chat comes first; the action after it, with the shortcut the shortcuts dialog shows.
  const rows = [...results.querySelectorAll<HTMLElement>('.search-result')];
  expect(rows[0]!.dataset.searchId).toBe('search-new-0001');
  expect(headings()).toContain('Actions');
  const action = results.querySelector<HTMLElement>('.is-action')!;
  expect(action.querySelector('b')!.textContent).toBe('New chat');
  // As the shortcuts dialog prints it on this system (⌘N on macOS, Ctrl+N elsewhere).
  expect([...action.querySelectorAll('kbd')].map(key => key.textContent)).toEqual([expect.stringMatching(/^(⌘|Ctrl\+)N$/)]);
  // A word matching no chat: no "No chats match" when an action or a setting matches.
  await type('keyboard shortcuts');
  expect(results.querySelector('.empty.search-status')).toBeNull();
  (results.querySelector('.is-action') as HTMLButtonElement).click();
  await waitFor(() => expect(dialog.open).toBe(false));
  expect((doc.getElementById('shortcutsDialog') as HTMLDialogElement).open).toBe(true);
  (doc.getElementById('shortcutsDialog') as HTMLDialogElement).close();
  // A setting by its name opens its page and marks it, as Settings' own search does.
  (doc.getElementById('searchChatsButton') as HTMLButtonElement).click();
  await type('writing style');
  expect(headings()).toContain('Settings');
  const setting = results.querySelector<HTMLElement>('.is-setting')!;
  expect(setting.querySelector('b')!.textContent).toBe('Writing style');
  setting.click();
  await waitFor(() => expect(dialog.open).toBe(false));
  await waitFor(() => expect(doc.querySelector('.is-found')).not.toBeNull());
  // Typing something nothing matches still says so.
  (doc.getElementById('searchChatsButton') as HTMLButtonElement).click();
  await type('zzqx');
  expect(results.querySelector('.empty.search-status')?.textContent).toBe('No chats match');  // A chat search that fails still leaves the actions to pick from.
  searchSessions.mockImplementationOnce(async () => ({ ok: false, error: 'busy' }) as never);
  await type('terminal');
  expect(results.querySelector('.is-action b')?.textContent).toBe('Terminal');
  // CodeRabbit on #1890: an action and a setting are buttons to screen readers, not list items.
  expect(results.querySelector('.is-action')!.getAttribute('role')).toBeNull();
  expect(results.querySelector('.is-action')!.closest('[role="list"]')).toBeNull();
  // From Plugins, an action for the chat goes back to the chat first, so it is not done out of sight.
  (doc.getElementById('searchChatsButton') as HTMLButtonElement).click();
  (doc.getElementById('sidebarPlugins') as HTMLButtonElement).click();
  expect(doc.querySelector<HTMLElement>('.app')!.dataset.screen).toBe('library');
  (doc.getElementById('searchChatsButton') as HTMLButtonElement).click();
  await type('terminal');
  (results.querySelector('.is-action') as HTMLButtonElement).click();
  await waitFor(() => expect(dialog.open).toBe(false));
  await waitFor(() => expect(doc.querySelector<HTMLElement>('.app')!.dataset.screen).toBe('chat'));
});

it('offers in ⌘K only actions that can run now, walks every group by keyboard, and focuses a setting once the dialog has closed (CodeRabbit)', async () => {
  const searchSessions = vi.fn(async (query: string) => ({ ok: true, data: { results: query === 'style' ? [{ id: 'search-style-0001', title: 'Style notes', projectId: null }] : [], indexed: 1, total: 1 } }));
  const mounted = await mountChat({}, [], { searchSessions });
  const w = mounted.window, doc = w.document;
  const field = doc.getElementById('chatSearch') as HTMLInputElement;
  const results = doc.getElementById('searchResults')!;
  const dialog = doc.getElementById('searchDialog') as HTMLDialogElement;
  const type = async (text: string) => { field.value = text; field.dispatchEvent(new w.Event('input', { bubbles: true })); await waitFor(() => expect(searchSessions).toHaveBeenLastCalledWith(text)); await settle(); };
  const actions = () => [...results.querySelectorAll('.is-action b')].map(node => node.textContent);
  (doc.getElementById('searchChatsButton') as HTMLButtonElement).click();
  await settle();
  // No chat and no project chosen: Find in chat, Review, Files and Sub-agents could not open, so they aren't offered.
  for (const [typed, name] of [['find', 'Find in chat'], ['review', 'Review'], ['files', 'Files'], ['sub', 'Sub-agents']] as const) {
    await type(typed);
    expect(actions()).not.toContain(name);
  }
  // Arrow keys walk the chats, then the actions, then the settings, and back up to the field.
  await type('style');
  const rows = [...results.querySelectorAll<HTMLElement>('.search-result')];
  expect(rows.map(row => row.classList.contains('is-setting') ? 'setting' : row.classList.contains('is-action') ? 'action' : 'chat')[0]).toBe('chat');
  expect(rows.some(row => row.classList.contains('is-setting'))).toBe(true);
  const key = (target: Element, name: string) => target.dispatchEvent(new w.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  key(field, 'ArrowDown');
  for (const row of rows.slice(1)) { key(doc.activeElement!, 'ArrowDown'); expect(doc.activeElement).toBe(row); }
  for (let at = rows.length - 1; at > 0; at--) key(doc.activeElement!, 'ArrowUp');
  expect(doc.activeElement).toBe(rows[0]);
  key(doc.activeElement!, 'ArrowUp');
  expect(doc.activeElement).toBe(field);
  // The dialog fades out while it is still modal: the setting's control takes focus only after it has closed.
  const style = w.getComputedStyle.bind(w);
  w.getComputedStyle = ((node: Element, pseudo?: string | null) => node === dialog
    ? ({ ...style(node, pseudo), animationName: 'search-out' }) as CSSStyleDeclaration : style(node, pseudo)) as typeof w.getComputedStyle;
  const focusedWhileOpen: boolean[] = [];
  doc.addEventListener('focusin', event => { if (!dialog.contains(event.target as Node)) focusedWhileOpen.push(dialog.open); });
  (results.querySelector('.is-setting') as HTMLButtonElement).click();
  await waitFor(() => expect(doc.querySelector('.is-found')).not.toBeNull());
  await waitFor(() => expect(focusedWhileOpen.length).toBeGreaterThan(0));
  expect(focusedWhileOpen).not.toContain(true);
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
  await waitFor(() => expect(doc.querySelector('[data-id="search-listed-0001"]')).not.toBeNull());
  // No search field in the sidebar: one icon beside the app name opens the dialog.
  expect(doc.querySelector('.sidebar #chatSearch')).toBeNull();
  expect(dialog.open).toBe(false);
  (doc.getElementById('searchChatsButton') as HTMLButtonElement).click();
  expect(dialog.open).toBe(true);
  expect(doc.activeElement).toBe(field);
  // Before anything is typed: the most recent chats.
  await waitFor(() => expect(results.querySelector('.search-heading')?.textContent).toBe('Recent'));
  expect([...results.querySelectorAll('.search-result b')].map(title => title.textContent)).toEqual(['Listed chat']);

  field.value = 'bridge';
  field.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
  await waitFor(() => expect(results.querySelector('.search-snippet')).not.toBeNull());
  // The chat lists keep their place behind the dialog.
  expect(lists.hidden).toBe(false);
  expect((doc.getElementById('chatSearchClear') as HTMLButtonElement).hidden).toBe(false);
  expect(results.querySelector('.search-result b')!.textContent).toBe('Release planning');
  expect([...results.querySelectorAll('.search-snippet mark')].map(mark => mark.textContent)).toEqual(['bridge']);
  // Indexing is not done yet: the result says so, and asks again until it is.
  expect(results.querySelector('.search-status')!.textContent).toContain('1 of 3');
  indexed = 3;
  await waitFor(() => expect(results.querySelector('.search-status')).toBeNull());

  // Opening a result closes the dialog and opens the chat.
  (results.querySelector('.search-result') as HTMLButtonElement).click();
  await waitFor(() => expect(dialog.open).toBe(false));
  await waitFor(() => expect(getSession).toHaveBeenCalledWith('search-hit-0001', expect.anything()));

  // Opened again (from the View menu), the last query is still there, selected, and the open chat is marked.
  (doc.getElementById('viewMenu') as HTMLButtonElement).click();
  (doc.querySelector('.row-menu [data-row-action="search"]') as HTMLButtonElement).click();
  expect(dialog.open).toBe(true);
  await waitFor(() => expect(results.querySelector('.search-result')!.classList.contains('is-sel')).toBe(true));

  field.value = 'nothing';
  field.dispatchEvent(new mounted.window.Event('input', { bubbles: true }));
  await waitFor(() => expect(results.textContent).toContain('No chats match'));

  // The clear button empties the query and brings the recent chats back.
  (doc.getElementById('chatSearchClear') as HTMLButtonElement).click();
  await waitFor(() => expect(results.querySelector('.search-heading')).not.toBeNull());
  expect(field.value).toBe('');
  // A click on the backdrop lands on the dialog itself and closes it.
  dialog.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => expect(dialog.open).toBe(false));
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
    await waitFor(() => expect(doc.querySelector('[data-id="search-shortcut-0001"]')).not.toBeNull());
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
    await waitFor(() => expect(doc.getElementById('searchResults')!.textContent)
      .toContain('Showing the first 1 match. Add a word to narrow it down.'));
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
  await waitFor(() => expect(rowMenuItem(row(), 'trust')).not.toBeNull());
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
  await waitFor(() => expect(mounted.calls.some(call => call.multiAgent?.strictChatAllowlist === true)).toBe(true));

  const next = structuredClone(mounted.state);
  next.config.multiAgent.strictChatAllowlist = true;
  mounted.push(next);
  expect(unattributed.disabled).toBe(true);
});

it('keeps project keyboard focus across activity repaint without taking composer focus or reloading on disclosure', async () => {
  const { project, session } = projectSidebarFixture();
  const listSessions = vi.fn(async (_options?: { projectId?: string }) => ({ ok: true, data: { sessions: [session], activeId: null, pressure: [], blocked: [] } }));
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [project] }), listSessions
  });
  const doc = mounted.window.document;
  const heading = () => doc.querySelector<HTMLElement>(`[data-project-id="${project.id}"] > summary`)!;
  await waitFor(() => expect(heading()).not.toBeNull());
  await settle();
  // Reads of the whole list. Opening a project reads one page of that project itself (#1190),
  // which is not a reload of the sidebar.
  const wholeListReads = () => listSessions.mock.calls.filter(([options]) => !options?.projectId).length;
  const reads = wholeListReads();
  heading().focus(); heading().click();
  await settle();
  expect(wholeListReads()).toBe(reads);
  expect(listSessions.mock.calls.filter(([options]) => options?.projectId === project.id)).toHaveLength(1);
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
  expect(wholeListReads()).toBe(reads + 1);
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
    await waitFor(() => expect(connect).toHaveBeenCalledOnce(), { timeout: 10_000 });
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
  await waitFor(() => expect(title()).toBe('Not connected'), { timeout: 2500 });
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

  // 2026-10-15: OpenAI's tunnel service answered with 503/504 for hours while the internet worked;
  // "No internet" sent people to check their network for nothing.
  mounted.push({ ...mounted.state, status: { ...mounted.state.status, state: 'offline', offlineCause: 'service' } });
  expect(popover.querySelector('.connection-popover-head')!.textContent?.trim()).toBe('OpenAI outage');
  expect(label.textContent).toBe('OpenAI outage');
  expect(doc.getElementById('connectionAnnounce')!.textContent).toBe('OpenAI outage');
  mounted.push({ ...mounted.state, status: { ...mounted.state.status, state: 'disconnected', offlineCause: null } });

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
  await waitFor(() => expect(doc.getElementById('setupProfileCurrent')!.textContent).toBe('Work'));
  expect(add).toHaveBeenCalledWith('Work');
  expect((doc.getElementById('tunnelId') as HTMLInputElement).value).toBe('');
  mounted.push(initial);
  expect(doc.querySelector('[data-profile-id="second"]')!.getAttribute('aria-pressed')).toBe('true');
  select.mockResolvedValue({ ok: true, data: { ...initial, config: { ...initial.config, tunnel: {
    ...initial.config.tunnel, profileId: 'default', profileEpoch: 2 }, setupProfiles: [] } } });
  (doc.querySelector('[data-profile-id="default"]') as HTMLButtonElement).click();
  await waitFor(() => expect(select).toHaveBeenCalledWith('default'));
  await waitFor(() => expect((doc.getElementById('tunnelId') as HTMLInputElement).value).toBe(initial.config.tunnel.tunnelId));
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
  type('developer mode');
  expect([pages.hidden, results.hidden]).toEqual([true, false]);
  expect(rows().map(row => [row.querySelector('b')!.textContent, row.querySelector('.search-snippet')!.textContent])).toEqual([['Developer mode', 'General › For developers']]);
  expect(rows()[0]!.querySelectorAll('mark')).toHaveLength(2);
  rows()[0]!.click(); await frame();
  // Its page opens with the list back, the setting marked and its control focused.
  expect(doc.querySelector('[data-panel="general"]')!.classList.contains('is-active')).toBe(true);
  expect([field.value, pages.hidden, results.hidden]).toEqual(['', false, true]);
  expect(doc.getElementById('developerMode')!.closest('.setting')!.classList.contains('is-found')).toBe(true);
  expect(doc.activeElement).toBe(doc.getElementById('developerMode'));
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

it('highlights the composer while files are dragged over the window, with a one-line hint, and nowhere else (#1884, Haz)', async () => {
  const dropFiles = vi.fn(async () => ({ ok: true, data: [] }));
  const mounted = await mountChat({}, [], { dropFiles });
  const w = mounted.window, doc = w.document, composer = doc.getElementById('composer')!;
  const drag = (type: string, target: Element, kinds: string[]) => {
    const event = new w.MouseEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: kinds, files: [], dropEffect: '', getData: () => '' } });
    target.dispatchEvent(event);
    return event;
  };
  const input = doc.getElementById('chatInput') as HTMLTextAreaElement, placeholder = input.placeholder;
  expect(composer.classList.contains('is-file-drop')).toBe(false);
  drag('dragover', doc.querySelector('.timeline') ?? doc.body, ['Files']);
  expect(composer.classList.contains('is-file-drop')).toBe(true);
  expect(input.placeholder).toBe('Drop to attach, up to 20 files');
  // A folder dropped on the Folders card stays the card's: the composer doesn't claim it.
  drag('dragover', doc.getElementById('foldersCard')!, ['Files']);
  expect(composer.classList.contains('is-file-drop')).toBe(false);
  // Text dragged around (a selection, a link) changes nothing.
  drag('dragover', doc.body, ['text/plain']);
  expect(composer.classList.contains('is-file-drop')).toBe(false);
  // The drag leaves the window or ends: the highlight goes at once.
  drag('dragover', doc.body, ['Files']);
  expect(composer.classList.contains('is-file-drop')).toBe(true);
  drag('drop', doc.body, ['Files']);
  expect(composer.classList.contains('is-file-drop')).toBe(false);
  expect(input.placeholder).toBe(placeholder);
  drag('dragover', doc.body, ['Files']);
  const leave = new w.MouseEvent('dragleave', { bubbles: true, relatedTarget: null });
  doc.documentElement.dispatchEvent(leave);
  expect(composer.classList.contains('is-file-drop')).toBe(false);
  expect(input.placeholder).toBe(placeholder);
});

it('keeps the drop hint through a slow drag and a repaint, ends with the current placeholder, and refuses more than 20 files (CodeRabbit)', async () => {
  const dropFiles = vi.fn(async () => ({ ok: true, data: [] }));
  const mounted = await mountChat({}, [], { dropFiles });
  const w = mounted.window, doc = w.document, composer = doc.getElementById('composer')!;
  const drag = (type: string, files: unknown[] = []) => {
    const event = new w.MouseEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files, dropEffect: '', getData: () => '' } });
    doc.body.dispatchEvent(event);
  };
  const input = doc.getElementById('chatInput') as HTMLTextAreaElement;
  const { setLanguage } = await import('../src/renderer/i18n.js');
  try {
    drag('dragover');
    // Chromium repeats dragover about every 350 ms (±200) while the pointer rests: no flicker in between.
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(composer.classList.contains('is-file-drop')).toBe(true);
    // The placeholder's owner repaints during the drag (here: the language changes). The hint stays,
    // and the drop leaves the owner's current text, not the one from before the drag.
    setLanguage('de');
    expect(input.placeholder).toBe('Zum Anhängen loslassen, bis zu 20 Dateien');
    drag('drop');
    expect(input.placeholder).toBe('Frag irgendetwas …');
  } finally { setLanguage('en'); }
  // More than 20 files: nothing is attached, and the person is told the limit.
  drag('dragover');
  drag('drop', Array.from({ length: 21 }, (_, index) => ({ name: `file-${index}.txt`, size: 1, type: 'text/plain' })));
  await settle();
  expect(dropFiles).not.toHaveBeenCalled();
  expect(doc.body.textContent).toContain('Attach up to 20 files per message');
  expect(composer.classList.contains('is-file-drop')).toBe(false);
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
  await waitFor(() => expect(dropFiles).toHaveBeenCalledWith([file]));
  expect(paste.defaultPrevented).toBe(true);
  await waitFor(() => expect(w.document.querySelector('img[src="data:image/webp;base64,AAAA"]')).not.toBeNull());
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
  await waitFor(() => expect(mounted.calls).toHaveLength(1));
  // Repainting custom settings must not replace the hidden OpenRouter picker's model.
  mounted.push({ ...mounted.state, hasCustomProviderKey: false });
  provider.value = 'openrouter'; provider.dispatchEvent(new w.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls).toHaveLength(2));
  expect(mounted.calls[1].goal).toMatchObject({ provider: { kind: 'openrouter' }, model: original });
  expect(w.document.getElementById('goalModelName')!.textContent).toBe(original);
});

it('uses the OpenRouter default when opened directly on an unrelated custom deployment', async () => {
  const mounted = await mountChat({}, [], {}, { model: 'llama3.1', provider: { kind: 'custom', baseUrl: 'http://localhost:8000/v1' } });
  const provider = mounted.window.document.getElementById('goalProvider') as HTMLSelectElement;
  provider.value = 'openrouter';
  provider.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].goal).toMatchObject({ provider: { kind: 'openrouter' }, model: DEFAULT_GOAL_MODEL });
});

it('saves a custom deployment id and returns to the known OpenRouter model', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const provider = w.document.getElementById('goalProvider') as HTMLSelectElement;
  provider.value = 'custom';
  provider.dispatchEvent(new w.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].goal.provider.kind).toBe('custom');
  expect(w.document.getElementById('goalCustomPanel')?.hidden).toBe(false);
  const model = w.document.getElementById('goalCustomModel') as HTMLInputElement;
  model.value = 'llama3.1';
  model.dispatchEvent(new w.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls).toHaveLength(2));
  expect(mounted.calls[1].goal.model).toBe('llama3.1');
  provider.value = 'openrouter';
  provider.dispatchEvent(new w.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls).toHaveLength(3));
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

it('keeps a switch the person changed while its save is pending, even after focus moved and an older state arrived', async () => {
  // CodeRabbit on #1443: an older state push used to reset the switch once focus had left it,
  // and the next save then read the reset value and undid the person's choice.
  let release!: (result: any) => void; const calls: any[] = [];
  const mounted = await mountChat({}, [], { saveSettings: (patch: any) => {
    calls.push(structuredClone(patch));
    const answer = { ok: true, data: { ...mounted.state, config: { ...mounted.state.config, ...structuredClone(patch) } } };
    if (calls.length === 1) return new Promise(resolve => { release = () => resolve(answer); });
    return Promise.resolve(answer);
  } });
  const w = mounted.window;
  const developer = w.document.getElementById('developerMode') as HTMLInputElement;
  const background = w.document.getElementById('backgroundChats') as HTMLInputElement;
  // As the app's own config always does, the stored state names the switch's value.
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, developerMode: false } } });
  expect(developer.checked).toBe(false);
  developer.focus(); developer.checked = true; developer.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  developer.blur(); background.focus();
  // A state push from before the save (it still says off) lands while the save is pending.
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, developerMode: false } } });
  expect(developer.checked).toBe(true);
  background.checked = true; background.dispatchEvent(new w.Event('change', { bubbles: true }));
  release(undefined);
  await waitFor(() => expect(calls).toHaveLength(2)); await settle();
  expect(calls[1].ui.developerMode).toBe(true);
  expect(developer.checked).toBe(true);
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
  await waitFor(() => expect(calls).toHaveLength(2)); await settle();
  expect(calls[1].patch.ui.browserBridgePort).toBe(calls[1].base.ui.browserBridgePort);
  expect(select.value).toBe('auto'); expect(background.checked).toBe(true);
});

// CodeRabbit on #1938: a box shown off while the saved value is still on would misstate what the
// desktop tools allow, and the next unrelated save would carry the unsaved value.
it('restores desktop control without a known chat after its save fails, though the box kept the focus', async () => {
  const mounted = await mountChat({}, [], { saveSettings: async () => ({ ok: false, error: 'Settings could not be saved.' }) });
  const w = mounted.window;
  // Saved on in the app; the failed save below reads this state back.
  mounted.state.config.ui.desktopUnattributed = true;
  mounted.push(mounted.state);
  await settle();
  const box = w.document.getElementById('desktopUnattributed') as HTMLInputElement;
  expect(box.checked).toBe(true);
  box.focus(); box.checked = false; box.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(); await settle();
  expect(box.checked).toBe(true);
});

// CodeRabbit on #1948: a switch left on after a failed save would show times the saved setting hides.
it('restores Show message times after its save fails, though the box kept the focus', async () => {
  const mounted = await mountChat({}, [], { saveSettings: async () => ({ ok: false, error: 'Settings could not be saved.' }) });
  const w = mounted.window;
  const box = w.document.getElementById('showMessageTimes') as HTMLInputElement;
  expect(box.checked).toBe(false);
  box.focus(); box.checked = true; box.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(); await settle();
  expect(box.checked).toBe(false);
  expect(w.document.documentElement.classList.contains('show-message-times')).toBe(false);
});

it('saves the background placement from its settings control and restores it on state push', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const placement = w.document.getElementById('backgroundPlacement') as HTMLSelectElement;
  expect(placement.value).toBe('window'); // older config has no field
  expect([...placement.options].map(option => option.value)).toEqual(['window', 'group']);
  placement.value = 'group';
  placement.dispatchEvent(new w.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].ui.backgroundPlacement).toBe('group');
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, backgroundPlacement: 'window' } } });
  expect(placement.value).toBe('window');
});

it('saves the ChatGPT browser choice from its settings control and restores it on state push', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const browser = w.document.getElementById('chatBrowser') as HTMLSelectElement;
  expect(browser.value).toBe('chrome'); // older config has no field
  browser.value = 'edge';
  browser.dispatchEvent(new w.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].ui.chatBrowser).toBe('edge');
  expect(browser.value).toBe('edge');
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, chatBrowser: 'chrome' } } });
  expect(browser.value).toBe('chrome');
});
