/**
 * The renderer's `{ base, patch }` Settings save, through the real `settings:save` IPC handler.
 * Each case starts from a saved config, optionally moves the live config on after the form took
 * its snapshot (another writer), then saves. Records the request, the outcome and the file.
 */
import { afterAll, beforeAll, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { contents, record } from './record.js';

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  },
  BrowserWindow: class {},
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }), showMessageBox: async () => ({ response: 0 }) },
  shell: { openExternal: async () => undefined, openPath: async () => '', showItemInFolder: () => undefined },
  nativeTheme: { themeSource: 'system' },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  app: { on: () => undefined, once: () => undefined, getPath: () => '', getLocale: () => 'en-US', getVersion: () => '0.0.0', getAppPath: () => process.cwd(), isPackaged: false }
}));
vi.mock('../../../../src/main/extension-path.js', () => ({ extensionDir: () => process.cwd(), shippedExtensionBuild: () => null, extensionUpdateOffer: () => null, prepareExtensionUpdate: () => null }));
vi.mock('../../../../src/main/browser.js', () => ({ openInPreferredBrowser: async () => 'chrome.exe' }));

const { defaultConfig, getConfig, initConfigPath, saveConfig } = await import('../../../../src/main/config.js');
const { initSecretsPath } = await import('../../../../src/main/secrets.js');
const { initSessionStore, resetSessionStoreForTests } = await import('../../../../src/main/session/store.js');
const { flushDurable, initDurableStore } = await import('../../../../src/main/durable.js');
const { stopBridge } = await import('../../../../src/main/bridge.js');
const { registerIpc } = await import('../../../../src/main/ipc.js');
const { switchSetupProfile } = await import('../../../../src/main/setup-profiles.js');
const { bridgePortSelection } = await import('../../../../src/main/bridge-ports.js');
const { defaultAppearance } = await import('../../../../src/shared/appearance.js');
const { makeTempDir, removeTempDir } = await import('../../../../test/helpers.js');

let dir: string;
beforeAll(async () => {
  dir = await makeTempDir('cos-store-settings-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  registerIpc(() => null as never, () => undefined);
});
afterAll(async () => {
  await stopBridge();
  await flushDurable();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

type Config = ReturnType<typeof getConfig>;
const clone = <T>(value: T): T => structuredClone(value);
const TUNNEL = 'tunnel_0123456789abcdef0123456789abcdef';

interface Case {
  start?: (config: Config) => void;
  /** Another writer moves the live config after the form captured `base`. */
  live?: (config: Config) => Config | void;
  patch: (patch: any) => void;
  /** Replaces the whole IPC payload, for envelope checks. */
  payload?: (base: Config, patch: any) => unknown;
  /** CLF_BRIDGE_PORTS during the save. */
  env?: string;
}

const cases: Record<string, Case> = {
  'edit-theme': { patch: (p) => { p.ui.theme = 'light'; } },
  'stale-unrelated-save-keeps-live': {
    live: (c) => { c.goal.enabled = true; c.compaction.auto = false; c.capabilities.command = !c.capabilities.command; c.ui.autoConnect = true; },
    patch: (p) => { p.ui.theme = 'light'; }
  },
  'edited-field-wins-over-live': {
    live: (c) => { c.compaction.autoTokens = 500000; c.goal.mode = 'loop'; },
    patch: (p) => { p.compaction.autoTokens = 600000; p.goal.mode = 'goal'; }
  },
  'capabilities-per-key': {
    live: (c) => { c.capabilities.read = false; },
    patch: (p) => { p.capabilities.edit = false; p.readOnly = true; }
  },
  'command-rules-replace-list': {
    start: (c) => { c.commandAllowlist = { enabled: true, mode: 'allow', rules: ['git status'] }; },
    live: (c) => { c.commandAllowlist.rules = ['git status', 'git diff']; },
    patch: (p) => { p.commandAllowlist.rules = ['cargo test *']; p.commandAllowlist.mode = 'deny'; }
  },
  'command-rules-unchanged-keeps-live': {
    start: (c) => { c.commandAllowlist = { enabled: true, mode: 'allow', rules: ['git status'] }; },
    live: (c) => { c.commandAllowlist.rules = ['git status', 'git diff']; },
    patch: (p) => { p.ui.theme = 'light'; }
  },
  'appearance-three-way': {
    live: (c) => { c.ui.appearance = { ...defaultAppearance(), dark: { ...defaultAppearance().dark, accent: '#123456' } }; },
    patch: (p) => { p.ui.appearance = { ...defaultAppearance(), light: { ...defaultAppearance().light, background: '#ABCDEF' }, fontSize: 16 }; }
  },
  'appearance-absent-keeps-live': {
    live: (c) => { c.ui.appearance = { ...defaultAppearance(), font: 'serif' }; },
    patch: (p) => { p.ui.theme = 'light'; }
  },
  'control-api-actions-need-api': { patch: (p) => { p.controlApi = { enabled: false, allowActions: true }; } },
  'control-api-enable-keeps-actions': {
    start: (c) => { c.controlApi = { enabled: true, allowActions: true }; },
    patch: (p) => { p.controlApi = { enabled: true }; }
  },
  'control-api-omitted-keeps-live': {
    start: (c) => { c.controlApi = { enabled: true, allowActions: false }; },
    patch: (p) => { delete p.controlApi; p.ui.theme = 'light'; }
  },
  'connector-suffix-collapsed': { patch: (p) => { p.connectorSuffix = '  My   PC  '; } },
  'connector-suffix-rejected': { patch: (p) => { p.connectorSuffix = 'a/b'; } },
  'tunnel-edit-after-profile-switch': {
    start: (c) => { c.setupProfiles = [{ id: 'work', name: 'Work', tunnelId: '', desktopTunnelId: '', pluginsTunnelId: '' }]; },
    live: (c) => switchSetupProfile(c, 'work'),
    patch: (p) => { p.tunnel.tunnelId = TUNNEL; }
  },
  'tunnel-id-edit': { patch: (p) => { p.tunnel.tunnelId = TUNNEL; p.tunnel.pluginsTunnelId = TUNNEL; } },
  'tunnel-id-invalid': { patch: (p) => { p.tunnel.tunnelId = 'tunnel_xyz'; } },
  'envelope-extra-key': { patch: (p) => { p.ui.theme = 'light'; }, payload: (base, patch) => ({ base, patch, extra: 1 }) },
  'last-seen-version-on-save': {
    start: (c) => { c.ui.lastSeenVersion = '2.1.30'; c.ui.language = 'de'; c.ui.browserPreferences = { overwrite: true, durations: false }; },
    patch: (p) => { p.ui.theme = 'light'; }
  },
  'mcp-instructions-trimmed': { patch: (p) => { p.mcp = { instructions: '  prefer small diffs  ' }; } },
  'goal-model-shape-rejected': { patch: (p) => { p.goal.model = 'not a model'; } },
  'goal-model-custom-provider': { patch: (p) => { p.goal.provider = { kind: 'custom', baseUrl: 'http://localhost:11434/v1' }; p.goal.model = 'llama3.1'; } },
  'goal-prompt-blank-rejected': { patch: (p) => { p.goal.prompt = '   '; } },
  'goal-prompt-trimmed': { patch: (p) => { p.goal.prompt = '  Continue the brief.  '; } },
  'sessions-record-normalized': { patch: (p) => { p.sessions.record = false; p.sessions.retainDays = 7; p.sessions.advisoryTokens = 200000; } },
  'handoff-length-absent': {
    start: (c) => { c.compaction.handoffLength = 'short'; },
    patch: (p) => { delete p.compaction.handoffLength; }
  },
  'multi-agent-optional-fields': {
    patch: (p) => { p.multiAgent.defaultReasoning = ''; p.multiAgent.defaultModel = 'gpt-6'; p.multiAgent.globalMaxWorkers = 4; p.multiAgent.maxWorkers = 3; }
  },
  'ui-optional-switches': {
    patch: (p) => { p.ui.finishTool = true; p.ui.finishAction = 'goal'; p.ui.finishLeadMinutes = 4; p.ui.tabsToKeepOpen = 7; p.ui.developerMode = true; p.ui.defaultChatReasoning = 'high'; }
  },
  'ui-number-out-of-range': { patch: (p) => { p.ui.tabsToKeepOpen = 0; } },
  'bridge-port-edit': { patch: (p) => { p.ui.browserBridgePort = 8767; } },
  'bridge-port-edit-under-env': { env: '9333', patch: (p) => { p.ui.browserBridgePort = 8767; } },
  'bridge-port-edit-under-env-port-zero': { env: ' -0 ', patch: (p) => { p.ui.browserBridgePort = 8766; } },
  'bridge-port-back-to-auto-under-env': {
    start: (c) => { c.ui.browserBridgePort = 8768; },
    env: '9333,9334',
    patch: (p) => { p.ui.browserBridgePort = 'auto'; }
  },
  'bridge-port-unchanged-under-env': { env: '9333', patch: (p) => { p.ui.theme = 'light'; } },
  'bridge-port-same-as-base-under-env': {
    start: (c) => { c.ui.browserBridgePort = 8768; },
    live: (c) => { c.ui.browserBridgePort = 8769; },
    env: '9333',
    patch: (p) => { p.ui.browserBridgePort = 8768; p.ui.theme = 'light'; }
  },
  'bridge-port-edit-under-unusable-env': { env: 'off, 70000, -5, ', patch: (p) => { p.ui.browserBridgePort = 8767; } },
  'roots-in-patch-ignored': { patch: (p) => { p.roots = [{ name: 'evil', path: 'C:\\' }]; p.ui.theme = 'light'; } }
};

const save = (payload: unknown): Promise<any> => handlers.get('settings:save')!(null, payload) as Promise<any>;

it('records settings saves', async () => {
  const results: Record<string, unknown> = {};
  for (const [name, test] of Object.entries(cases)) {
    const start = clone(defaultConfig('win32'));
    test.start?.(start);
    await saveConfig(start);
    const base = clone(getConfig());
    if (test.live) {
      const live = clone(getConfig());
      await saveConfig(test.live(live) ?? live);
    }
    const current = clone(getConfig());
    const patch = clone(base) as any;
    test.patch(patch);
    const payload = test.payload ? test.payload(base, patch) : { base, patch };
    if (test.env === undefined) delete process.env.CLF_BRIDGE_PORTS;
    else process.env.CLF_BRIDGE_PORTS = test.env;
    const reply = await save(clone(payload)).finally(() => { delete process.env.CLF_BRIDGE_PORTS; });
    results[name] = {
      ...(test.env === undefined ? {} : { env: test.env }),
      current,
      payload,
      ok: reply.ok,
      config: clone(getConfig()),
      saved: contents(readFileSync(path.join(dir, 'config.json')))
    };
  }
  record('settings-save', { cases: results });
});

it('records CLF_BRIDGE_PORTS parsing', () => {
  const raws = ['', ' ', '9333', ' 9333 , 9334 ', '0', '-0', '+8765', '00008765', '8765abc', '12.9', '0x10', '1e3', '-1', '65535', '65536',
    'abc', ',,', '9333,,abc,9334', ' 9333　', '９３３３', '99999999999999999999', '-', '+'];
  const cases = raws.map(raw => {
    const selection = bridgePortSelection('auto', raw);
    return { raw, overridden: selection.overridden, ports: selection.overridden ? [...selection.candidates] : [] };
  });
  record('bridge-ports', { cases });
});
