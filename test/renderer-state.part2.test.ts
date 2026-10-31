import { expect, it, vi } from 'vitest';
import { BROWSER_READ_TOOLS, BROWSER_WRITE_TOOLS, fs, mountChat, path, settle, waitFor } from './renderer-state.harness.js';

vi.mock('../src/renderer/workspace-terminal.js', () => ({ createWorkspaceTerminal: () => ({
  update: vi.fn(), show: vi.fn(), hide: vi.fn(), newTab: vi.fn(() => null),
  tabs: vi.fn(() => []), selectTab: vi.fn(), closeTab: vi.fn()
}) }));
// Native animation/media APIs are covered by pet DOM and real Electron tests.
vi.mock('../src/renderer/pet.js', () => ({ initPet: () => Object.assign(() => {}, { toggle: () => {}, isVisible: () => false }) }));


it('saves Auto-select Skills from Settings and restores it on state push', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const toggle = w.document.getElementById('autoSelectSkills') as HTMLInputElement;
  expect(toggle).not.toBeNull();
  expect(toggle.checked).toBe(false);
  toggle.checked = true;
  toggle.dispatchEvent(new w.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].ui.autoSelectSkills).toBe(true);
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, autoSelectSkills: false } } });
  expect(toggle.checked).toBe(false);
});

it('saves the send check address only when it is on this computer, and empty turns it off (#1794)', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const doc = w.document;
  const field = doc.getElementById('sendCheckUrl') as HTMLInputElement;
  const error = doc.getElementById('sendCheckUrlError')!;
  expect(field.value).toBe('');
  const enter = (value: string) => { field.value = value; field.dispatchEvent(new w.Event('input', { bubbles: true })); field.dispatchEvent(new w.Event('change', { bubbles: true })); };
  enter('https://example.com/check');
  expect(error.hidden).toBe(false);
  expect(field.getAttribute('aria-invalid')).toBe('true');
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(mounted.calls.some(call => call.ui?.sendCheckUrl === 'https://example.com/check')).toBe(false);
  enter(' http://127.0.0.1:8080/check ');
  expect(error.hidden).toBe(true);
  await vi.waitFor(() => expect(mounted.calls.at(-1)?.ui?.sendCheckUrl).toBe('http://127.0.0.1:8080/check'), { timeout: 5_000 });
  enter('');
  await vi.waitFor(() => expect(mounted.calls.at(-1)?.ui).not.toHaveProperty('sendCheckUrl', 'http://127.0.0.1:8080/check'), { timeout: 5_000 });
  expect(mounted.calls.at(-1)?.ui?.sendCheckUrl).toBeUndefined();
  const { collectSettings, searchSettings } = await import('../src/renderer/settings-search.js');
  expect(searchSettings(collectSettings(doc), 'automatic sends').map(entry => entry.title)).toContain('Check automatic sends');
});

it('keeps a refused send check address in the field with its error through a repaint, and shows a damaged saved one as wrong (CodeRabbit)', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const doc = w.document;
  const field = doc.getElementById('sendCheckUrl') as HTMLInputElement;
  const error = doc.getElementById('sendCheckUrlError')!;
  field.focus();
  field.value = 'https://example.com/check';
  field.dispatchEvent(new w.Event('input', { bubbles: true }));
  field.blur();
  field.dispatchEvent(new w.Event('change', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 50));
  // A state push after the (unsaved) change: the typed text and its error stay.
  mounted.push({ ...mounted.state });
  expect(field.value).toBe('https://example.com/check');
  expect(error.hidden).toBe(false);
  // Fixed by the person: the error goes with the next repaint too.
  field.value = '';
  field.dispatchEvent(new w.Event('input', { bubbles: true }));
  mounted.push({ ...mounted.state });
  expect(error.hidden).toBe(true);
  expect(field.getAttribute('aria-invalid')).toBe('false');
  // A saved value this computer would never accept is shown as wrong, not as fine.
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, sendCheckUrl: 'damaged' } } });
  expect(field.value).toBe('damaged');
  expect(error.hidden).toBe(false);
});

it('saves and restores the Code checkpoints switch on the Workspace page, and finds it in Settings search', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const doc = w.document;
  const toggle = doc.getElementById('codeCheckpoints') as HTMLInputElement;
  expect(doc.querySelector('[data-panel="home"]')!.contains(toggle)).toBe(true);
  expect(toggle.checked).toBe(false);
  toggle.checked = true;
  toggle.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1), { timeout: 5_000 });
  expect(mounted.calls[0].projects).toEqual({ codeCheckpoints: true });
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, projects: { codeCheckpoints: false } } });
  expect(toggle.checked).toBe(false);

  const { collectSettings, searchSettings } = await import('../src/renderer/settings-search.js');
  const found = searchSettings(collectSettings(doc), 'checkpoint');
  expect(found.map(entry => entry.title)).toContain("Save a checkpoint before each turn's first edit");
  expect(found.find(entry => entry.target.contains(toggle))?.tab).toBe('home');
});

it('saves and restores the global worker admission cap from Settings', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const globalWorkers = w.document.getElementById('globalMaWorkers') as HTMLInputElement;
  expect(globalWorkers.value).toBe('0');

  globalWorkers.value = '5';
  globalWorkers.dispatchEvent(new w.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls).toHaveLength(1));
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
  await waitFor(() => expect([...model.options].map(option => option.value)).toContain('gpt-5.6-sol'));
  expect(model.value).toBe(''); expect(reasoning.value).toBe('');

  model.value = 'gpt-5.6-sol'; model.dispatchEvent(new w.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].ui).toMatchObject({ defaultChatModel: 'gpt-5.6-sol' });
  expect(mounted.calls[0].ui.defaultChatReasoning).toBeUndefined();

  reasoning.value = 'xhigh'; reasoning.dispatchEvent(new w.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls).toHaveLength(2));
  expect(mounted.calls[1].ui).toMatchObject({ defaultChatModel: 'gpt-5.6-sol', defaultChatReasoning: 'xhigh' });

  model.value = ''; model.dispatchEvent(new w.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls).toHaveLength(3));
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
  await waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].commandAllowlist).toEqual({ enabled: false, mode: 'allow', rules: ['git status', 'git diff *'] });
  expect(description.textContent).toContain('Only commands matching');
  expect(label.textContent).toContain('Allowed commands');

  deny.click();
  await waitFor(() => expect(mounted.calls).toHaveLength(2));
  expect(mounted.calls[1].commandAllowlist).toEqual({ enabled: false, mode: 'deny', rules: ['git status', 'git diff *'] });
  expect(rules.value).toBe('git status\ngit diff *');
  enabled.checked = true;
  enabled.dispatchEvent(new w.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls).toHaveLength(3));
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

it('offers whole-screen privacy only where a screenshot can show the whole screen (macOS)', async () => {
  const mounted = await mountChat({ platform: { family: 'windows', name: 'Windows', desktopAutomation: true } });
  const row = mounted.window.document.getElementById('privacyScreenshotsSetting')!;
  // Windows captures one window already; the switch would change nothing there.
  expect(row.hidden).toBe(true);
  mounted.push({ ...mounted.state, platform: { family: 'macos', name: 'macOS', desktopAutomation: true } });
  expect(row.hidden).toBe(false);
  mounted.push({ ...mounted.state, platform: { family: 'linux', name: 'Linux', desktopAutomation: false } });
  expect(row.hidden).toBe(true);
});

it('shows Privacy on every platform with the secrets shield on by default, and saves turning it off (#1797)', async () => {
  const mounted = await mountChat({ platform: { family: 'windows', name: 'Windows', desktopAutomation: true } });
  const doc = mounted.window.document;
  const section = doc.getElementById('privacySettings')!;
  const shield = doc.getElementById('secretsShield') as HTMLInputElement;
  expect(section.hidden).toBe(false);
  expect(doc.querySelector('[data-panel="general"]')!.contains(section)).toBe(true);
  // A config from before the shield has no field: it shows on.
  expect(mounted.state.config.ui.secretsShield).toBeUndefined();
  expect(shield.checked).toBe(true);
  expect(doc.getElementById('privacyScreenshotsSetting')!.hidden).toBe(true);
  shield.checked = false;
  shield.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls.at(-1)?.ui.secretsShield).toBe(false));
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, secretsShield: false } } });
  expect(shield.checked).toBe(false);
});

it('puts the secrets shield switch back after a save that was refused, so a later save cannot turn it off', async () => {
  let refuse = true;
  const saves: any[] = [];
  const mounted = await mountChat({}, [], { saveSettings: (patch: any) => {
    saves.push(structuredClone(patch));
    if (refuse) return Promise.resolve({ ok: false, error: 'Settings could not be saved.' });
    return Promise.resolve({ ok: true, data: mounted.state });
  } });
  const doc = mounted.window.document;
  const shield = doc.getElementById('secretsShield') as HTMLInputElement;
  shield.focus();
  shield.checked = false;
  shield.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await waitFor(() => expect(saves.at(-1)?.ui.secretsShield).toBe(false));
  // The refusal leaves the switch on, as saved, even though it still has focus.
  await waitFor(() => expect(shield.checked).toBe(true));
  refuse = false;
  const follow = doc.getElementById('followOutput') as HTMLInputElement;
  follow.checked = !follow.checked;
  follow.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await waitFor(() => expect(saves.length).toBeGreaterThan(1));
  expect(saves.at(-1).ui.secretsShield).toBe(true);
});

it('puts the Play sounds switch back after a save that was refused (#1830)', async () => {
  let refuse = true;
  const saves: any[] = [];
  const mounted = await mountChat({}, [], { saveSettings: (patch: any) => {
    saves.push(structuredClone(patch));
    if (refuse) return Promise.resolve({ ok: false, error: 'Settings could not be saved.' });
    return Promise.resolve({ ok: true, data: mounted.state });
  } });
  const doc = mounted.window.document;
  const sounds = doc.getElementById('soundCues') as HTMLInputElement;
  sounds.focus();
  sounds.checked = true;
  sounds.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await waitFor(() => expect(saves.at(-1)?.ui.sounds).toBe(true));
  await waitFor(() => expect(sounds.checked).toBe(false));
  refuse = false;
  const follow = doc.getElementById('followOutput') as HTMLInputElement;
  follow.checked = !follow.checked;
  follow.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await waitFor(() => expect(saves.length).toBeGreaterThan(1));
  expect(saves.at(-1).ui.sounds).toBe(false);
});

it('plays the sample sound when Play sounds is switched on, but not during the quiet hours (#1830)', async () => {
  const tones: number[] = [];
  const param = () => ({ value: 0, setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined });
  class FakeContext {
    state = 'running'; currentTime = 0; destination = {};
    resume = async () => undefined;
    createOscillator() { return { type: '', frequency: param(), connect: (next: unknown) => next, start: (at: number) => tones.push(at), stop: () => undefined }; }
    createGain() { return { gain: param(), connect: (next: unknown) => next }; }
  }
  vi.stubGlobal('AudioContext', FakeContext);
  try {
    const now = new Date();
    const clock = (hours: number) => `${String((now.getHours() + hours + 24) % 24).padStart(2, '0')}:00`;
    const mounted = await mountChat();
    mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, phonePush: { quietHours: { from: clock(0), to: clock(2) } } } } } as any);
    await settle();
    const doc = mounted.window.document;
    const sounds = doc.getElementById('soundCues') as HTMLInputElement;
    sounds.checked = true;
    sounds.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
    await settle();
    expect(tones).toEqual([]);
    // Outside the quiet hours the switch plays its sample.
    mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, phonePush: { quietHours: { from: clock(2), to: clock(4) } } } } } as any);
    await settle();
    sounds.checked = false; sounds.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
    sounds.checked = true; sounds.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
    await settle();
    expect(tones.length).toBeGreaterThan(0);
  } finally { vi.unstubAllGlobals(); }
});

it('does not measure the Activity feeds for each log line while their pages are closed, and opens them on the newest line', async () => {
  // Idle CPU (2026-10-27): the app logs every few seconds, and each line made both hidden feeds read
  // their scroll height, which lays out the page.
  let addLine: ((entry: unknown) => void) | undefined;
  const mounted = await mountChat({}, [], { onLogEntry: (fn: (entry: unknown) => void) => { addLine = fn; return () => undefined; } });
  const doc = mounted.window.document;
  let reads = 0;
  for (const id of ['homeFeed', 'fullFeed']) {
    Object.defineProperty(doc.getElementById(id)!, 'scrollHeight', { configurable: true, get: () => { reads++; return 900; } });
  }
  expect(doc.querySelector('.panel[data-panel="activity"]')!.classList.contains('is-active')).toBe(false);
  for (let line = 0; line < 5; line++) addLine!({ time: Date.now(), level: 'info', message: `tunnel probe ${line}` });
  expect(reads).toBe(0);
  (doc.querySelector('[data-tab="activity"]') as HTMLElement).click();
  expect(doc.getElementById('fullFeed')!.scrollTop).toBe(900);
  // On screen, a new line keeps the feed on its newest line.
  doc.getElementById('fullFeed')!.scrollTop = 0;
  addLine!({ time: Date.now(), level: 'info', message: 'tunnel probe 5' });
  expect(doc.getElementById('fullFeed')!.scrollTop).toBe(900);
});

it('says why an Activity list is empty, in the app language, and drops the note once a line arrives', async () => {
  let addLine: ((entry: unknown) => void) | undefined;
  const mounted = await mountChat({}, [], { onLogEntry: (fn: (entry: unknown) => void) => { addLine = fn; return () => undefined; } });
  const doc = mounted.window.document;
  const feed = doc.getElementById('fullFeed')!;
  await waitFor(() => expect(feed.classList.contains('is-empty')).toBe(true));
  expect(feed.dataset.empty).toBe('Nothing has happened yet.');
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  expect(feed.dataset.empty).toBe('Bisher ist nichts passiert.');
  setLanguage('en');
  addLine!({ time: Date.now(), level: 'info', message: 'tunnel connected' });
  await waitFor(() => expect(feed.classList.contains('is-empty')).toBe(false));
  // Problems only, with no problem among the lines: the filter, not the log, is why it is empty.
  (doc.querySelector('#logFilter [data-filter="bad"]') as HTMLButtonElement).click();
  expect(feed.classList.contains('is-empty')).toBe(true);
  expect(feed.dataset.empty).toBe('Nothing matches this filter.');
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

it('walks the extension install in each browser\'s own words and pictures', async () => {
  const opened: Array<[string, string]> = [];
  const mounted = await mountChat({}, [], { openSetupBrowser: (browser: string, page: string) => { opened.push([browser, page]); return Promise.resolve({ ok: true, data: true }); } });
  const text = (id: string) => document.getElementById(id)!.textContent;
  const img = (id: string) => document.querySelector<HTMLImageElement>(`#${id} img`);
  const chrome = structuredClone(mounted.state);
  chrome.config.ui = { ...chrome.config.ui, chatBrowser: 'chrome' };
  mounted.push(chrome);
  expect(text('extensionStepOpen')).toBe('Open the extensions page in Chrome');
  expect(text('setupExtensionAddress')).toBe('chrome://extensions');
  expect(text('extensionStepDev')).toBe('Turn on “Developer mode”');
  expect(text('extensionStepLoad')).toBe('Click “Load unpacked” and choose the extension folder');
  expect(document.getElementById('extensionStepDevWhere')!.hidden).toBe(true);
  // Chrome's own page, with the place to click outlined where Chrome draws it.
  expect(img('extensionPictureDev')!.getAttribute('src')).toContain('chrome-en-dev');
  expect(img('extensionPictureDev')!.alt).toBe('The extensions page in Chrome, with “Developer mode” outlined');
  expect(img('extensionPictureLoad')!.getAttribute('src')).toContain('chrome-en-load');
  expect(document.querySelector<HTMLElement>('#extensionPictureDev .ext-spot')!.style.left).toBe('63.7%');

  // Edge's own page, laid out differently (the switch sits in its sidebar), with the hint for where.
  (document.querySelector('[data-external-browser="edge"]') as HTMLButtonElement).click();
  expect(text('setupExtensionAddress')).toBe('edge://extensions');
  expect(text('extensionStepOpen')).toBe('Open the extensions page in Edge');
  expect(img('extensionPictureDev')!.getAttribute('src')).toContain('edge-en-dev');
  expect(img('extensionPictureLoad')!.getAttribute('src')).toContain('edge-en-load');
  expect(img('extensionPictureLoad')!.alt).toBe('The extensions page in Edge, with “Load unpacked” outlined');
  expect(document.getElementById('extensionStepDevWhere')!.hidden).toBe(false);
  expect(text('extensionStepOpenHint')).toBe('Click the address to copy it, then paste it into the address bar in Edge and press Enter.');
  // Browsers ignore their own pages from the command line, so the app copies the address.
  (document.getElementById('openExtensionSettings') as HTMLButtonElement).click();
  await settle();
  expect(opened).toEqual([['edge', 'extensions']]);
  expect(text('extensionStepOpenHint')).toBe('Copied. Paste it into the address bar in Edge and press Enter.');

  // Brave has its own captures.
  (document.querySelector('[data-external-browser="brave"]') as HTMLButtonElement).click();
  expect(text('setupExtensionAddress')).toBe('brave://extensions');
  expect(img('extensionPictureDev')!.getAttribute('src')).toContain('brave-en-dev');
  expect(img('extensionPictureLoad')!.getAttribute('src')).toContain('brave-en-load');

  // In German, Chrome's German page and Chrome's German words, quoted the German way.
  (document.querySelector('[data-external-browser="chrome"]') as HTMLButtonElement).click();
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  expect(text('extensionStepDev')).toBe('Schalte „Entwicklermodus“ ein');
  expect(text('extensionStepLoad')).toBe('Klicke auf „Entpackte Erweiterung laden“ und wähle den Erweiterungsordner');
  expect(img('extensionPictureDev')!.getAttribute('src')).toContain('chrome-de-dev');
  // Edge words the same button differently in German.
  (document.querySelector('[data-external-browser="edge"]') as HTMLButtonElement).click();
  expect(text('extensionStepLoad')).toBe('Klicke auf „Entpackte Dateien laden“ und wähle den Erweiterungsordner');
  expect(img('extensionPictureLoad')!.getAttribute('src')).toContain('edge-de-load');
  setLanguage('en');
});

// Firefox (2.1.38) installs the signed add-on from this version's release, so its steps differ.
it('walks the Firefox add-on install, without Developer mode or a folder', async () => {
  const opened: Array<[string, string]> = [];
  const mounted = await mountChat({}, [], { openSetupBrowser: (browser: string, page: string) => { opened.push([browser, page]); return Promise.resolve({ ok: true, data: true }); } });
  const shown = (id: string) => !document.getElementById(id)!.closest('li')!.hidden;
  const chrome = structuredClone(mounted.state);
  chrome.config.ui = { ...chrome.config.ui, chatBrowser: 'chrome' };
  mounted.push(chrome);
  expect([shown('extensionStepOpen'), shown('extensionStepDev'), shown('extensionStepLoad'), shown('extensionStepAddon')]).toEqual([true, true, true, false]);
  (document.querySelector('[data-external-browser="firefox"]') as HTMLButtonElement).click();
  expect([shown('extensionStepOpen'), shown('extensionStepDev'), shown('extensionStepLoad'), shown('extensionStepAddon'), shown('extensionStepChatGpt')])
    .toEqual([false, false, false, true, true]);
  expect(document.getElementById('extensionStepAddon')!.textContent).toBe('Add the Chat On Steroids add-on to Firefox');
  expect(document.getElementById('extensionStepChatGpt')!.textContent).toBe('Open ChatGPT in Firefox');
  expect(document.querySelector<HTMLImageElement>('#setupExternalIcon')!.src).toContain('firefox');
  // The unpacked folder and its ZIP are for Chromium browsers only.
  expect(document.querySelector<HTMLElement>('#browserExtensionStage .extension-help')!.hidden).toBe(true);
  (document.getElementById('openFirefoxAddon') as HTMLButtonElement).click();
  await settle();
  expect(opened).toEqual([['firefox', 'extensions']]);
  // Back to Chrome, its steps return.
  (document.querySelector('[data-external-browser="chrome"]') as HTMLButtonElement).click();
  expect([shown('extensionStepOpen'), shown('extensionStepAddon')]).toEqual([true, false]);
  expect(document.querySelector<HTMLElement>('#browserExtensionStage .extension-help')!.hidden).toBe(false);
  expect(document.querySelector<HTMLOptionElement>('#chatBrowser option[value="firefox"]')?.textContent).toBe('Mozilla Firefox');
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
  // ChatGPT no longer has a Developer mode switch: no guide for one.
  expect(doc.querySelector('[data-setup-guide="developer"]')).toBeNull();
  expect(doc.querySelectorAll('[data-setup-guide="plugin"] img')).toHaveLength(4);
  // Each picture's places are the step's numbered moves.
  expect([...guide.querySelectorAll('.guide-move')].map(move => move.textContent)).toEqual(
    ['1Name it', '2Pick your ChatGPT workspace', '3Click “Create”', '4Copy the tunnel ID']);
  const image = guide.querySelector('img')!;
  mounted.push(structuredClone(state));
  expect(field.open).toBe(true);
  expect(guide.querySelector('img')).toBe(image);
  expect(image.src).toContain('tunnel-create-en');
  expect(mounted.calls).toEqual([]);
  mounted.push(structuredClone(state));
  expect(field.open).toBe(true);
});

it("shows ChatGPT's own screens and words in the app's language, and the Platform's English ones", async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const moves = (group: string) => [...doc.querySelectorAll(`[data-setup-guide="${group}"] .guide-move, #pluginMoves .guide-move`)]
    .filter(move => group !== 'plugin' || move.closest('#pluginMoves')).map(move => move.querySelector('.guide-move-text')!.textContent);
  const pictures = (group: string) => [...doc.querySelectorAll<HTMLImageElement>(`[data-setup-guide="${group}"] img`)].map(img => img.getAttribute('src'));
  expect(moves('plugin').slice(0, 5)).toEqual(['“Add” → “Add custom MCP server”', 'Paste the name exactly', '“Tunnel”, then your tunnel ID',
    '“No authentication”', '“I understand and want to continue”, then “Create as a plugin”']);
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  // ChatGPT's German menu and dialog, quoted the German way; rebuilt without a reload.
  expect(moves('plugin').slice(0, 5)).toEqual(['„Hinzufügen“ → „Benutzerdefinierten MCP-Server hinzufügen“', 'Den Namen exakt einfügen',
    '„Tunnel“, dann deine Tunnel-ID', '„Keine Authentifizierung“', '„Ich habe das verstanden und möchte weitermachen“, dann „Als Plugin erstellen“']);
  expect(pictures('plugin').slice(0, 2).every(src => /plugin-(add|new)-de/.test(src!))).toBe(true);
  expect(doc.querySelectorAll('#pluginMoves .guide-moves')).toHaveLength(1);
  // The OpenAI Platform is English: its pictures and labels stay English, translated around them.
  expect(moves('tunnel')).toContain('Auf „Create“ klicken');
  expect(pictures('key').every(src => /api-key-(create|tunnels)-en/.test(src!))).toBe(true);
  setLanguage('en');
});

it('judges Setup from the saved settings on the first paint, and numbers its steps as the rail does', async () => {
  // A finished setup: tunnel saved and key stored. The first paint read the tunnel field before it
  // was filled from the settings, so Setup looked unfinished and Connect was disabled until the
  // next state update.
  const mounted = await mountChat({ hasApiKey: true });
  const doc = mounted.window.document;
  expect((doc.getElementById('tunnelId') as HTMLInputElement).value).toBe('tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  expect(doc.getElementById('setupBadge')!.hidden).toBe(true);
  expect((doc.getElementById('wizConnect') as HTMLButtonElement).disabled).toBe(false);

  // The hints name the step by its place in the rail: Tunnel is 4 and API key 5 since Access joined.
  const rail = [...doc.querySelectorAll<HTMLElement>('.setup-rail [data-rail-step]')].map(button => button.dataset.railStep);
  expect(rail.indexOf('tunnel') + 1).toBe(4);
  const noTunnel = structuredClone(mounted.state);
  noTunnel.config.tunnel.tunnelId = '';
  mounted.push(noTunnel);
  (doc.getElementById('tunnelId') as HTMLInputElement).value = '';
  mounted.push(structuredClone(noTunnel));
  expect((doc.getElementById('wizConnect') as HTMLButtonElement).title).toBe('Create a tunnel and paste its ID — step 4.');
  const noKey = structuredClone(mounted.state);
  noKey.hasApiKey = false;
  mounted.push(noKey);
  expect((doc.getElementById('wizConnect') as HTMLButtonElement).title).toBe('Add a restricted API key — step 5.');
});

it("names ChatGPT's sign-in button by the label ChatGPT shows in the app's language", async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const moves = (group: string) => [...doc.querySelectorAll(`[data-setup-guide="${group}"] .guide-move-text`)].map(move => move.textContent);
  expect(moves('signin')).toContain('Click “Log in”');
  expect(moves('external-browser')).toContain('Click “Log in”');
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  // ChatGPT's German page says "Anmelden"; the step used to send people looking for "Log in".
  expect(moves('signin')).toContain('Auf „Anmelden“ klicken');
  expect(moves('external-browser')).toContain('Auf „Anmelden“ klicken');
  setLanguage('ja');
  expect(moves('signin').some(text => text!.includes('「ログイン」'))).toBe(true);
  setLanguage('en');
});

it('says a switched-off permission group is off in the app\'s language', async () => {
  const mounted = await mountChat();
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, capabilities: {
    ...mounted.state.config.capabilities, screen: false, control: false, clipboardRead: false, clipboardWrite: false
  } } });
  const doc = mounted.window.document;
  const count = (group: string) => doc.querySelector(`[data-group="${group}"] .group-count`)?.textContent;
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  // The summary of a group with nothing on was the bare English word "off" in every language.
  expect(count('desktop')).toBe('aus');
  setLanguage('en');
  expect(count('desktop')).toBe('off');
});

it("keeps a worker's delivery line in the app's language when the language changes", async () => {
  const worker = { id: 'worker-1', role: 'worker', label: 'Docs', task: 'Update the docs', jobTitle: 'Docs', runId: 'run-1', reasoningEffort: null, model: null, state: 'active',
    createdAt: 1, activatedAt: 2, finishedAt: null, result: null, pending: 0, awaitingAck: 0, delivered: 1, conversationId: 'worker-chat', primeConversationId: 'prime-chat', detachedAt: null };
  const mounted = await mountChat({}, [], { getSwarm: async () => ({ ok: true, data: { enabled: true, running: true, runId: 'run-1', agents: [worker], maxWorkers: 2, pendingReports: 0 } }) });
  const line = () => mounted.window.document.querySelector('#swarmList .model-sub')?.textContent;
  await waitFor(() => expect(line()).toBe('0 pending · 1 delivered'));
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  // The line was joined once when the list was painted, so it stayed English.
  expect(line()).toBe('0 ausstehend · 1 zugestellt');
  setLanguage('en');
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
    proof?: { version: string; signedIn: boolean } | null; chatgptAccess?: boolean };
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
  // Connected, but the browser keeps it off chatgpt.com: nothing could run on a ChatGPT page.
  result = await scenario('chrome', { present: true, version: app, lastSeenAt: now, signedIn: null, proof: { version: app, signedIn: true }, chatgptAccess: false });
  expect(result).toMatchObject({ done: false, choosing: false, status: 'The extension may not open ChatGPT' });
  expect(document.getElementById('extensionSetupDetail')!.textContent).toContain('chatgpt.com');
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
  for (const id of ['followOutput', 'playfulStatus', 'playfulContinue', 'mentionCore', 'privacyScreenshots', 'developerMode', 'controlApiEnabled', 'controlApiAllowActions']) {
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
  await waitFor(() => expect(mounted.calls.at(-1)?.ui.followOutput).toBe(false));
});

// Message times (user request 2026-10-30): each chat row always carried its time, hidden. A General
// switch, off unless chosen, shows it beside every message.
it('shows message times only once the General switch is on, and hides them again when it is off', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const box = doc.getElementById('showMessageTimes') as HTMLInputElement;
  expect(doc.querySelector('[data-panel="general"]')!.contains(box)).toBe(true);
  expect(box.checked).toBe(false);
  expect(doc.documentElement.classList.contains('show-message-times')).toBe(false);
  box.checked = true;
  box.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls.at(-1)?.ui.showMessageTimes).toBe(true));
  await waitFor(() => expect(doc.documentElement.classList.contains('show-message-times')).toBe(true));
  box.checked = false;
  box.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls.at(-1)?.ui.showMessageTimes).toBe(false));
  await waitFor(() => expect(doc.documentElement.classList.contains('show-message-times')).toBe(false));
});

// #924 / #1401: stable connector URLs for a tunnel of one's own, opt-in, only with secure storage.
it('saves the stable connector URL option from For developers, and only with secure storage', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const box = doc.getElementById('mcpPersistentUrls') as HTMLInputElement;
  expect(doc.querySelector('[data-panel="general"]')!.contains(box)).toBe(true);
  expect(box.checked).toBe(false);
  const instructions = mounted.state.config.mcp?.instructions ?? '';
  box.checked = true;
  box.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  await waitFor(() => expect(mounted.calls.at(-1)?.mcp).toEqual({ instructions, persistentUrls: true }));
  const unavailable = structuredClone(mounted.state) as any;
  unavailable.secureStorage = { available: false };
  unavailable.config.mcp = { instructions, persistentUrls: false };
  mounted.push(unavailable);
  expect(box.disabled).toBe(true);
  // Already on without the store: it stays usable, so it can always be turned off.
  unavailable.config.mcp = { instructions, persistentUrls: true };
  mounted.push(structuredClone(unavailable));
  expect(box.disabled).toBe(false);
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
it('keeps update readiness actions stable and does not start update or connection work on pushes', async () => {
  const installUpdate = vi.fn(), connect = vi.fn(), refreshUpdate = vi.fn(), updateAll = vi.fn();
  const { window: w, state, push } = await mountChat({}, [], { installUpdate, connect, refreshUpdate, updateAll });
  const button = w.document.getElementById('updateReviewSetup') as HTMLButtonElement;
  expect(button).not.toBeNull();
  button.focus(); push(structuredClone(state));
  expect(w.document.activeElement).toBe(button);
  expect(installUpdate).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled(); expect(refreshUpdate).not.toHaveBeenCalled();
  expect(updateAll).not.toHaveBeenCalled();
  button.click();
  expect(w.document.querySelector('[data-panel="setup"]')!.classList.contains('is-active')).toBe(true);
});

it('draws the Update status disclosures with the app\'s own chevron', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  // Every other disclosure in the app uses the chevron icon; these used a text "▸" and the
  // browser's own ▼ marker.
  expect(doc.querySelector('#updateReadinessToggle .disclosure-chevron')).not.toBeNull();
  expect(doc.querySelector('#updateReadinessDetails > summary .disclosure-chevron.details-chevron')).not.toBeNull();
  expect(doc.getElementById('updateReadinessToggle')!.textContent).not.toContain('▸');
});

it('shows update failure causes and next steps without using stale connector diagnostics', async () => {
  const { window: w, state, push } = await mountChat();
  const next = structuredClone(state) as any;
  const core = { id: 'core', connectorName: 'Core', description: 'Core', cardSummary: 'Files and terminal',
    optional: false, available: true, state: 'live', detail: '', tools: ['read'], localUrl: null,
    publicUrl: null, lastRequestAt: null, lastToolCallAt: null };
  next.update = { ...next.update, stage: 'failed', error: 'GitHub returned 503' };
  next.bridge = { ...next.bridge, running: true, paired: true, present: false, extensionVersion: '0.0.1' };
  next.status = { ...next.status, state: 'offline', detail: 'Network unavailable',
    surfaces: [{ ...core, state: 'error', detail: 'Network unavailable' }] };
  const row = (id: string) => w.document.querySelector(`[data-update-part="${id}"]`)!.textContent!;
  push(next);
  expect(row('app')).toContain('GitHub returned 503');
  expect(row('app')).toContain('current app');
  expect(row('extension')).toContain('active chats');
  expect(row('core')).toContain('Network unavailable');
  expect(row('core')).toContain('Review setup');
  next.status.surfaces = []; push(next);
  expect(row('core')).toContain('Network unavailable');
  expect(w.document.querySelector('[data-update-part="core"]')!.classList.contains('is-bad')).toBe(true);
  next.status.detail = ''; push(next);
  expect(row('core')).toContain('Review setup');
  next.status.surfaces = [{ ...core }];
  next.status.state = 'connected'; next.status.surfaces[0].state = 'live';
  next.connectorSchemas = { core: 'current' };
  next.connectorRefresh = { core: { schemaId: 'current', state: 'failed', failure: 'inspection' } };
  push(next);
  expect(row('core')).toContain('Could not inspect');
  expect(row('core')).toContain('Plugin check failed');
  expect(row('core')).toContain("settings in ChatGPT");
  expect(row('core')).toContain('Diagnostics report');
  next.connectorRefresh.core.failure = 'confirmation'; push(next);
  expect(row('core')).toContain('Could not confirm');
  next.connectorRefresh.core = { schemaId: 'current', state: 'failed', failure: 'migration', responding: true }; push(next);
  expect(row('core')).toContain('Plugin check failed');
  expect(row('core')).toContain('saved plugin');
  expect(row('core')).toContain('refresh this existing plugin');
  expect(row('core')).not.toContain('recreate');
  expect(w.document.querySelector('[data-update-part="core"]')!.classList.contains('is-bad')).toBe(true);
  expect(w.document.getElementById('updateReadinessSummary')!.dataset.ready).toBe('false');
  next.connectorRefresh.core.failure = 'confirmation';
  next.connectorRefresh.core.schemaId = 'old'; push(next);
  expect(row('core')).not.toContain('Could not confirm');
  next.connectorRefresh.core = { schemaId: 'current', state: 'manual' }; push(next);
  expect(row('core')).toContain("ChatGPT's plugin settings");
  expect(row('core')).toContain('refresh or recreate');
  expect(row('core')).toContain('Update all to recheck');
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('ja');
  expect(row('core')).toContain('更新または作り直し');
  expect(row('core')).toContain('まとめて更新');
  setLanguage('en');
});

it('asks in the app\'s own dialog before Update all restarts, with Keep working first', async () => {
  // 2026-10-15: the question was a bare system message box, unlike anything else in the app.
  const updateAll = vi.fn()
    .mockResolvedValueOnce({ ok: true, data: 'confirm' })
    .mockResolvedValueOnce({ ok: true, data: 'confirm' })
    .mockResolvedValueOnce({ ok: true, data: 'restarting' });
  const { window: w, state, push } = await mountChat({}, [], { updateAll });
  const next = structuredClone(state) as any;
  next.update = { ...next.update, latest: '2.1.99', stage: 'ready' };
  push(next);
  const button = w.document.getElementById('updateAll') as HTMLButtonElement;
  const dialog = () => w.document.getElementById('updateRestartDialog') as HTMLDialogElement | null;
  button.click();
  await waitFor(() => expect(dialog()?.open).toBe(true));
  expect(updateAll).toHaveBeenNthCalledWith(1);
  expect(dialog()!.classList.contains('whats-new-dialog')).toBe(true);
  expect(dialog()!.textContent).toContain('2.1.99');
  expect(w.document.activeElement?.textContent).toBe('Keep working');
  (w.document.activeElement as HTMLButtonElement).click();
  await waitFor(() => expect(dialog()).toBeNull());
  expect(updateAll).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(button.disabled).toBe(false));
  button.click();
  await waitFor(() => expect(dialog()?.open).toBe(true));
  const restart = [...dialog()!.querySelectorAll('button')].find(item => item.textContent === 'Restart and install')!;
  restart.click();
  await waitFor(() => expect(updateAll).toHaveBeenCalledTimes(3));
  expect(updateAll).toHaveBeenLastCalledWith('2.1.99');
  await waitFor(() => expect(dialog()).toBeNull());
});

it.each(['reply', 'transport'])('keeps an Update all %s failure visible across pushes until explicit retry', async kind => {
  let resolve!: (reply: any) => void;
  const updateAll = vi.fn().mockImplementationOnce(() => kind === 'reply'
    ? Promise.resolve({ ok: false, error: 'Network unavailable' }) : Promise.reject(new Error('Network unavailable')))
    .mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const { window: w, state, push } = await mountChat({}, [], { updateAll });
  const button = w.document.getElementById('updateAll') as HTMLButtonElement;
  const details = w.document.getElementById('updateReadinessDetails') as HTMLDetailsElement;
  details.open = false;
  button.click();
  await waitFor(() => expect(button.disabled).toBe(false));
  const error = w.document.getElementById('updateAllError')!;
  expect(error.hidden).toBe(false);
  expect(error.textContent).toContain('Network unavailable');
  expect(error.textContent).toContain('Update all to retry');
  expect(details.open).toBe(true);
  details.open = false; // A new failure asks for attention; the person can still collapse it.
  expect(details.open).toBe(false);
  expect(details.contains(error)).toBe(false);
  expect(details.contains(w.document.getElementById('updateAllNotice'))).toBe(false);
  push(structuredClone(state));
  expect(error.hidden).toBe(false);
  expect(details.open).toBe(false);
  expect(updateAll).toHaveBeenCalledTimes(1);
  button.click();
  expect(error.hidden).toBe(true);
  resolve({ ok: true, data: 'checking-connectors' });
  await waitFor(() => expect(button.disabled).toBe(false));
  expect(error.hidden).toBe(true);
});

// One test per language: all 13 in one test took 6 s here and ran past the 30 s limit on the
// slower macOS x64 release runner (2.1.38 publish, 2026-10-15).
it.each(['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW'] as const)(
  'localizes updater network failures in the card, both banner paths and retained errors (%s)', async locale => {
  const updateAll = vi.fn().mockResolvedValue({ ok: false, error: 'GitHub could not be reached' });
  const { window: w, state, push } = await mountChat({}, [], { updateAll });
  const { setLanguage, t } = await import('../src/renderer/i18n.js');
  const button = w.document.getElementById('updateAll') as HTMLButtonElement;
  const error = w.document.getElementById('updateAllError')!;
  setLanguage(locale);
  try {
    const next = structuredClone(state);
    next.update.stage = 'failed'; next.update.error = 'GitHub could not be reached';
    const reason = t('GitHub could not be reached. Check your connection');
    for (const latest of [null, '99.0.0']) {
      next.update.latest = latest; push(structuredClone(next));
      expect(w.document.querySelector('[data-update-part="app"]')!.textContent).toContain(reason);
      for (const id of ['updateText', 'updateLine']) expect(w.document.getElementById(id)!.textContent).toContain(reason);
    }
    button.click(); await waitFor(() => expect(button.disabled).toBe(false));
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain(reason);
    expect(error.textContent).toContain(t('Choose Update all to retry.'));
    push(structuredClone(next));
    expect(error.hidden).toBe(false);
    expect(updateAll).toHaveBeenCalledTimes(1);
    updateAll.mockResolvedValueOnce({ ok: true, data: 'checking-connectors' });
    button.click(); await waitFor(() => expect(button.disabled).toBe(false));
    expect(error.hidden).toBe(true);
  } finally { setLanguage('en'); }
});

it('translates updater reasons and retained recovery guidance when the language changes', async () => {
  const updateAll = vi.fn().mockResolvedValue({ ok: false, error: 'Could not read plugin-refresh state' });
  const { window: w, state, push } = await mountChat({}, [], { updateAll });
  const { setLanguage, t } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  const next = structuredClone(state);
  next.update.stage = 'failed'; next.update.error = 'Update check failed';
  push(next);
  expect(w.document.querySelector('[data-update-part="app"] .is-warn')!.textContent).toBe(t('Update check failed'));
  const button = w.document.getElementById('updateAll') as HTMLButtonElement;
  button.click(); await waitFor(() => expect(button.disabled).toBe(false));
  const error = w.document.getElementById('updateAllError')!;
  expect(error.textContent).not.toContain('Could not read plugin-refresh state');
  expect(error.textContent).toContain(t('Save a Diagnostics report from Activity for help with recovery. The saved state has been kept.'));
  setLanguage('ja');
  expect(error.textContent).toContain('診断レポート');
  expect(w.document.querySelector('[data-update-part="app"] .is-warn')!.textContent).toBe('更新の確認に失敗しました');
  push(next);
  expect(updateAll).toHaveBeenCalledTimes(1);
  expect(error.hidden).toBe(false);
  setLanguage('en');
});

it.each(['cancelled', 'failed', 'transport'])('offers the existing diagnostics action after an unreadable-state failure and keeps a %s report from retrying updates', async outcome => {
  let finish!: (reply: any) => void;
  let reject!: (error: Error) => void;
  const saveDiagnosticsReport = vi.fn(() => new Promise((done, fail) => { finish = done; reject = fail; }));
  const updateAll = vi.fn().mockResolvedValueOnce({ ok: false, error: 'Could not read plugin-refresh state' })
    .mockResolvedValueOnce({ ok: true, data: 'checking-connectors' });
  const { window: w, state, push } = await mountChat({}, [], { updateAll, saveDiagnosticsReport });
  const update = w.document.getElementById('updateAll') as HTMLButtonElement;
  const shortcut = w.document.getElementById('updateDiagnosticsReport') as HTMLButtonElement;
  const original = w.document.getElementById('saveDiagnosticsReport') as HTMLButtonElement;
  expect(shortcut.hidden).toBe(true);
  update.click(); await waitFor(() => expect(update.disabled).toBe(false));
  expect(shortcut.hidden).toBe(false);
  shortcut.click(); original.click();
  expect(saveDiagnosticsReport).toHaveBeenCalledTimes(1);
  expect(shortcut.disabled).toBe(true); expect(original.disabled).toBe(true);
  push(structuredClone(state));
  expect(shortcut.disabled).toBe(true);
  if (outcome === 'transport') reject(new Error('Fixture report transport error'));
  else finish(outcome === 'cancelled' ? { ok: true, data: { saved: false } } : { ok: false, error: 'Fixture report error' });
  await waitFor(() => expect(shortcut.disabled).toBe(false));
  expect(original.disabled).toBe(false);
  expect(w.document.getElementById('updateAllError')!.hidden).toBe(false);
  expect(updateAll).toHaveBeenCalledTimes(1);
  update.click(); await waitFor(() => expect(update.disabled).toBe(false));
  expect(shortcut.hidden).toBe(true);
  expect(saveDiagnosticsReport).toHaveBeenCalledTimes(1);
});

it('runs Update all once on explicit click and keeps it busy across state pushes, then allows retry', async () => {
  let resolve!: (reply: any) => void;
  const updateAll = vi.fn(() => new Promise<any>(done => { resolve = done; }));
  const { window: w, state, push } = await mountChat({}, [], { updateAll });
  const button = w.document.getElementById('updateAll') as HTMLButtonElement;
  expect(button).not.toBeNull();
  expect(w.document.querySelector('.update-readiness')!.textContent).toContain('asked before the app restarts');
  expect(button.getAttribute('aria-describedby')).toBe('updateAllNotice');
  button.click(); button.click(); push(structuredClone(state));
  expect(updateAll).toHaveBeenCalledTimes(1); expect(button.disabled).toBe(true);
  expect(button.textContent).toBe('Updating…'); expect(button.getAttribute('aria-busy')).toBe('true');
  resolve({ ok: false, error: 'Network unavailable' });
  await waitFor(() => expect(button.disabled).toBe(false));
  expect(button.textContent).toBe('Update all');
  button.click(); expect(updateAll).toHaveBeenCalledTimes(2);
  resolve({ ok: true, data: 'manual' });
  await waitFor(() => expect(button.disabled).toBe(false));
  expect(w.document.body.textContent).toContain('Download link opened. Install the app to continue');
  button.click(); resolve({ ok: true, data: 'checking-connectors' });
  await waitFor(() => expect(button.disabled).toBe(false));
  expect(w.document.querySelector('.toast')!.textContent).toContain(w.document.getElementById('updateReadinessCard') ? 'Update status' : 'Checking…');
});

it.each(['reply', 'transport', 'read-state'])('localizes and retains the update command %s error across state pushes', async kind => {
  const source = kind === 'read-state' ? 'Could not read plugin-refresh state' : 'latest answered 503';
  const updateAll = vi.fn(() => kind === 'transport' ? Promise.reject(new Error(source)) : Promise.resolve({ ok: false, error: source }));
  const { window: w, state, push } = await mountChat({}, [], { updateAll });
  w.document.querySelector<HTMLButtonElement>('[data-language="ja"]')!.click();
  const button = w.document.getElementById('updateAll') as HTMLButtonElement;
  button.click(); await waitFor(() => expect(button.disabled).toBe(false));
  push(structuredClone(state));
  expect(w.document.getElementById('updateAllError')!.hidden).toBe(false);
  expect(w.document.getElementById('updateAllError')!.textContent).toContain(kind === 'read-state' ? '診断レポート' : '503');
  expect(w.document.body.textContent).not.toContain(source);
  expect(updateAll).toHaveBeenCalledTimes(1);
});

// #1490: a silently failed installer left the next start on the old version with nothing said.
it('says when the last update did not install, in place of the ready line', async () => {
  const mounted = await mountChat();
  const state = structuredClone(mounted.state) as any;
  state.update = { current: '2.0.2', latest: '2.0.3', stage: 'ready', error: null, checkedAt: Date.now(), notInstalled: '2.0.3' };
  mounted.push(state);
  const line = mounted.window.document.getElementById('updateLine')!;
  expect(line.textContent).toContain('Chat On Steroids 2.0.3 did not install; this is still 2.0.2.');
  // The same version ready again: the notice already says to choose Install, once.
  expect(line.textContent).not.toContain('is downloaded and ready');
  expect(line.className).toContain('bad');
  // Before the next check has found it again: never "Up to date" over a failed install.
  mounted.push({ ...structuredClone(state), update: { ...state.update, latest: null, stage: 'idle' } });
  expect(line.textContent).toContain('did not install');
  expect(line.textContent).not.toContain('Up to date');
});

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
