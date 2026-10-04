/**
 * The settings handler, exercised through the channel the renderer actually uses.
 *
 * Only the part where two subsystems have to be shut down in the right order. The rest of
 * the IPC surface is thin validation over modules that have their own tests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  },
  BrowserWindow: class {},
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })), showSaveDialog: vi.fn(async () => ({ canceled: true })) },
  shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() },
  nativeTheme: { themeSource: 'system' },
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  },
  app: { on: vi.fn(), getPath: (_name: string) => '', getLocale: () => 'en-US', getVersion: vi.fn(() => '0.0.0'), getAppPath: () => process.cwd(), isPackaged: false }
}));

// This suite owns IPC behavior, not Electron's packaged-vs-checkout path discovery.
vi.mock('../src/main/extension-path.js', () => ({ extensionDir: () => process.cwd(), shippedExtensionBuild: () => null, extensionUpdateOffer: () => null, prepareExtensionUpdate: () => null }));
vi.mock('../src/main/browser.js', () => ({ openInPreferredBrowser: vi.fn(async () => 'chrome.exe') }));

const { defaultConfig, getConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath, resetSecretsCacheForTests } = await import('../src/main/secrets.js');
const { appendEvent, createSession, getSession, initSessionStore, rebindSession, resetSessionStoreForTests, upsertMessageEvent } = await import('../src/main/session/store.js');
const { flushDurable, initDurableStore, readDurable, writeDurableNow, writeDurableSoon } = await import('../src/main/durable.js');
const { pendingCommands, resetBridgeForTests, setBrowserOpener, startBridge, stopBridge } = await import(
  '../src/main/bridge.js'
);
const {
  bindConversation,
  finishAgent,
  onRetiredWorkersPersist,
  onRetiredWorkersPersistNow,
  onSwarmPersist,
  onSwarmPersistNow,
  pauseSwarmForDisable,
  persistAgentAuthorityNow,
  pendingWorkerRevivals,
  releaseQuiescentRun,
  resetSwarm,
  restoreSwarm,
  sendMessage,
  snapshotRetiredWorkers,
  snapshotSwarm,
  spawn,
  swarmStateForCaller
} = await import('../src/main/agents.js');
const { registerIpc } = await import('../src/main/ipc.js');
const { openInPreferredBrowser } = await import('../src/main/browser.js');
const { app, nativeTheme, safeStorage, shell, dialog } = await import('electron');
const { extensionDownloadUrl } = await import('../src/main/version.js');
const { resetWorkspaces, setWorkspaceFor, workspaceEntries } = await import('../src/main/workspace.js');
const { faultGate, makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;
let currentWindow: {
  setBackgroundColor: ReturnType<typeof vi.fn>;
  setTitleBarOverlay: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
} | null = null;
/** How many times the IPC layer asked the app to quit so a staged update can be applied. */
let quitToInstallCalls = 0;

const save = (patch: unknown, base: unknown = getConfig()): Promise<any> =>
  handlers.get('settings:save')!(null, { patch, base }) as Promise<any>;
const renameRoot = (payload: unknown): Promise<any> => handlers.get('roots:rename')!(null, payload) as Promise<any>;
const removeRoot = (payload: unknown): Promise<any> => handlers.get('roots:remove')!(null, payload) as Promise<any>;
const sessionEvents = (payload: unknown): Promise<any> => handlers.get('sessions:events')!(null, payload) as Promise<any>;
const sessionList = (): Promise<any> => handlers.get('sessions:list')!(null, undefined) as Promise<any>;

it('keeps the reported interface language and the extension preferences through a Settings save', async () => {
  // Neither is part of the settings form. The save replaces the whole `ui` object, so both must be
  // carried through, or the extension would lose its language and its kept preferences.
  await handlers.get('ui:language')!(null, 'en');
  expect(getConfig().ui.language).toBe('en');
  expect(await handlers.get('ui:language')!(null, 'klingon')).toMatchObject({ ok: false });
  expect(getConfig().ui.language).toBe('en');
  await saveConfig({ ...getConfig(), ui: { ...getConfig().ui, browserPreferences: { overwrite: false, durations: true } } });
  const base = getConfig();
  expect(await save({ ...base, ui: { ...base.ui, theme: base.ui.theme === 'light' ? 'dark' : 'light' } }, base)).toMatchObject({ ok: true });
  expect(getConfig().ui.language).toBe('en');
  expect(getConfig().ui.browserPreferences).toEqual({ overwrite: false, durations: true });
});

it.each(['playfulStatus', 'followOutput'] as const)('saves the %s display switch from Settings', async key => {
  // Both are plain ui booleans saved by the general Settings save. The save schema dropped keys
  // it did not list, so a switch that was not listed reverted on the next state push.
  const base = getConfig();
  const wanted = !(base.ui[key] ?? (key === 'followOutput'));
  expect(await save({ ...base, ui: { ...base.ui, [key]: wanted } }, base)).toMatchObject({ ok: true });
  expect(getConfig().ui[key]).toBe(wanted);
  // A stale snapshot that never touched the switch keeps the saved value.
  expect(await save({ ...base, ui: { ...base.ui, theme: base.ui.theme === 'light' ? 'dark' : 'light' } }, base)).toMatchObject({ ok: true });
  expect(getConfig().ui[key]).toBe(wanted);
});

it('enabling strict chat allowlisting keeps existing chats untrusted', async () => {
  const { isChatTrusted, resetTrustedChatsForTests } = await import('../src/main/session/trusted-chats.js');
  resetTrustedChatsForTests();
  const conversationId = 'strict-existing-chat-stays-untrusted';
  await createSession({ title: 'Existing chat before strict mode', conversationId });
  const base = getConfig();
  try {
    expect(await save({ ...base, multiAgent: { ...base.multiAgent, strictChatAllowlist: true } }, base)).toMatchObject({ ok: true });
    expect(getConfig().multiAgent.strictChatAllowlist).toBe(true);
    expect(isChatTrusted(conversationId)).toBe(false);
  } finally {
    resetTrustedChatsForTests();
  }
});

it('trusts a strict CoS opening through the configured session-policy fence only after exact bind', async () => {
  const outbox = await import('../src/main/session/input.js');
  const { isChatTrusted, resetTrustedChatsForTests } = await import('../src/main/session/trusted-chats.js');
  resetTrustedChatsForTests();
  const original = await outbox.listInputs();
  await writeDurableNow('session-input', []); outbox.resetInputForTests();
  const base = getConfig();
  const id = 'f0f00015-1111-4111-8111-111111111111';
  const conversationId = 'f0f00016-1111-4111-8111-111111111111';
  try {
    expect(await save({ ...base, multiAgent: { ...base.multiAgent, strictChatAllowlist: true } }, base)).toMatchObject({ ok: true });
    const row = await outbox.enqueueInput({ id, sessionId: null, text: 'Strict composer opening', mode: 'auto',
      dueAt: Date.now(), model: null, reasoningEffort: null });
    expect(await outbox.claimBrowserInput(row.id, 'strict-ipc-opening', null, true)).not.toBeNull();
    expect(await outbox.authorizeBrowserInput(row.id, 'strict-ipc-opening', null)).toBe(true);
    expect(isChatTrusted(conversationId)).toBe(false);
    expect(await outbox.bindBrowserInputProject(row.id, 'strict-ipc-opening', conversationId)).toBe(true);
    expect(isChatTrusted(conversationId)).toBe(true);
  } finally {
    await writeDurableNow('session-input', original); outbox.resetInputForTests();
    resetTrustedChatsForTests();
  }
});

it('saves port choices, merges stale snapshots and serializes concurrent port edits', async () => {
  const ports = await import('../src/main/bridge-ports.js');
  const bridge = await import('../src/main/bridge.js');
  const selection = vi.spyOn(ports, 'bridgePortSelection').mockReturnValue({ candidates: [0], overridden: false });
  try {
    const base = getConfig();
    const results = await Promise.all([8767, 8768].map(browserBridgePort => save({ ...base, ui: { ...base.ui, browserBridgePort } }, base)));
    expect(results.every(result => result.ok)).toBe(true);
    const active = bridge.bridgePort();
    expect(await save({ ...base, ui: { ...base.ui, theme: 'light' } }, base)).toMatchObject({ ok: true });
    expect(getConfig().ui).toMatchObject({ browserBridgePort: 8768, theme: 'light' });
    expect(bridge.bridgePort()).toBe(active);
  } finally { selection.mockRestore(); }
});

it('rejects occupied port edits through Settings IPC and preserves the old bridge and disk', async () => {
  const http = await import('node:http');
  const ports = await import('../src/main/bridge-ports.js');
  const bridge = await import('../src/main/bridge.js');
  await startBridge(); const old = bridge.bridgePort();
  const blocker = http.createServer();
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const selection = vi.spyOn(ports, 'bridgePortSelection').mockReturnValue({ candidates: [(blocker.address() as { port: number }).port], overridden: false });
  try {
    const base = getConfig(); const disk = await fs.readFile(path.join(dir, 'config.json'), 'utf8');
    expect(await save({ ...base, ui: { ...base.ui, browserBridgePort: 8767 } }, base)).toMatchObject({ ok: false });
    expect(getConfig()).toBe(base); expect(bridge.bridgePort()).toBe(old);
    expect(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).toBe(disk);
  } finally { selection.mockRestore(); await new Promise<void>(resolve => blocker.close(() => resolve())); }
});

it('enforces the environment override for explicit edits while accepting unrelated saves', async () => {
  const base = getConfig();
  // vitest.config.ts supplies the real CLF_BRIDGE_PORTS=0 override.
  const result = await save({ ...base, ui: { ...base.ui, browserBridgePort: 8767 } }, base);
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining('CLF_BRIDGE_PORTS') });
  expect(getConfig().ui.browserBridgePort).toBe('auto');
  const unrelated = await save({ ...base, ui: { ...base.ui, theme: 'light' } }, base);
  expect(unrelated).toMatchObject({ ok: true, data: { bridge: { portOverridden: true } } });
});

it('persists arbitrary colors through Settings IPC and preserves concurrent per-field edits', async () => {
  const { defaultAppearance } = await import('../src/shared/appearance.js');
  const base = getConfig();
  const appearance = defaultAppearance(); appearance.dark.sidebar = '#fa89c2'; appearance.font = 'serif';
  expect(await save({ ...base, ui: { ...base.ui, appearance } }, base)).toMatchObject({ ok: true });
  const nextAppearance = defaultAppearance(); nextAppearance.dark.accent = '#4a6be2';
  expect(await save({ ...base, ui: { ...base.ui, appearance: nextAppearance } }, base)).toMatchObject({ ok: true });
  expect(getConfig().ui.appearance).toMatchObject({ font: 'serif', dark: { sidebar: '#fa89c2', accent: '#4a6be2' } });
  const current = getConfig();
  expect(await save({ ...current, ui: { ...current.ui, appearance: { ...current.ui.appearance, fontSize: 100 } } }, current)).toMatchObject({ ok: false });
  expect(getConfig().ui.appearance).toEqual(current.ui.appearance);
});

it('switches setup IDs and encrypted key ownership without changing shared settings', async () => {
  const { getSecret } = await import('../src/main/secrets.js');
  const original = getConfig();
  const tunnelA = 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  await saveConfig({ ...original, tunnel: { ...original.tunnel, tunnelId: tunnelA } });
  const secret = (value: string, profileId?: string) => handlers.get('secret:set')!(null, { value, profileId }) as Promise<any>;
  const profile = (payload: unknown) => handlers.get('setup:profile')!(null, payload) as Promise<any>;
  expect(await secret('fixture-setup-a')).toMatchObject({ ok: true });
  const added = await profile({ action: 'add', name: 'Second account' });
  expect(added).toMatchObject({ ok: true, data: { hasApiKey: false } });
  const second = getConfig().tunnel.profileId!;
  expect(getConfig().tunnel.tunnelId).toBe('');
  const shared = getConfig();
  expect(shared.roots).toEqual(original.roots); expect(shared.multiAgent).toEqual(original.multiAgent);
  expect(await secret('fixture-setup-b', second)).toMatchObject({ ok: true });
  const baseB = getConfig();
  expect(await save({ ...baseB, tunnel: { ...baseB.tunnel, tunnelId: 'tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } })).toMatchObject({ ok: true });
  expect(await profile({ action: 'select', id: 'default' })).toMatchObject({ ok: true, data: { hasApiKey: true } });
  expect(getConfig().tunnel.tunnelId).toBe(tunnelA);
  expect(await getSecret('openaiApiKey')).toBe('fixture-setup-a');
  expect(await getSecret(`setup:${second}`)).toBe('fixture-setup-b');
  // A late write still names B even when A is now selected.
  await secret('fixture-setup-b-edited', second);
  expect(await getSecret('openaiApiKey')).toBe('fixture-setup-a');
  const stored = await fs.readFile(path.join(dir, 'config.json'), 'utf8');
  expect(stored).not.toContain('fixture-setup-');
  expect((await profile({ action: 'select', id: second })).data.hasApiKey).toBe(true);
  expect(getConfig().tunnel.tunnelId).toBe('tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  expect(getConfig().setupProfiles).toHaveLength(1);
});

it('removes active and inactive profiles with their exact keys, preserving the final profile', async () => {
  const { getSecret } = await import('../src/main/secrets.js');
  const profile = (payload: unknown) => handlers.get('setup:profile')!(null, payload) as Promise<any>;
  const secret = (value: string, profileId?: string) => handlers.get('secret:set')!(null, { value, profileId }) as Promise<any>;
  await secret('fixture-default-key');
  await profile({ action: 'add', name: 'Second' });
  const second = getConfig().tunnel.profileId!;
  await secret('fixture-second-key', second);
  await profile({ action: 'add', name: 'Third' });
  const third = getConfig().tunnel.profileId!;
  await secret('fixture-third-key', third);
  expect(await profile({ action: 'remove', id: second })).toMatchObject({ ok: true });
  expect(getConfig().tunnel.profileId).toBe(third);
  expect(await getSecret(`setup:${second}`)).toBeNull();
  expect(await getSecret(`setup:${third}`)).toBe('fixture-third-key');
  expect(await profile({ action: 'remove', id: third })).toMatchObject({ ok: true, data: { hasApiKey: true } });
  expect(getConfig().tunnel.profileId).toBe('default');
  expect(await getSecret(`setup:${third}`)).toBeNull();
  expect(await secret('late-key', third)).toMatchObject({ ok: false });
  expect(await profile({ action: 'select', id: third })).toMatchObject({ ok: false });
  expect(await profile({ action: 'remove', id: 'default' })).toMatchObject({ ok: false });
  expect(await getSecret('openaiApiKey')).toBe('fixture-default-key');
});

it('rejects stale profile tunnel edits after A to B to A while accepting unrelated settings', async () => {
  const base = getConfig();
  await handlers.get('setup:profile')!(null, { action: 'add', name: 'Other' });
  await handlers.get('setup:profile')!(null, { action: 'select', id: 'default' });
  expect(await save({ ...base, tunnel: { ...base.tunnel, tunnelId: 'tunnel_cccccccccccccccccccccccccccccccc' } }, base)).toMatchObject({ ok: false });
  expect(await save({ ...base, ui: { ...base.ui, theme: 'light' } }, base)).toMatchObject({ ok: true });
  expect(getConfig().tunnel.profileEpoch).toBe(2);
  expect(getConfig().setupProfiles).toHaveLength(1);
});

it.each([true, false])('forwards canonical input commitment even when a legacy writer proposes recording=%s', async recording => {
  const input = await import('../src/main/session/input.js');
  const store = await import('../src/main/session/store.js');
  const previous = await readDurable('session-input');
  const session = await createSession({ title: 'Input commitment fixture', conversationId: 'input-commitment-fixture' });
  const id = '30000000-0000-4000-8000-000000000001';
  try {
    await saveConfig({ ...getConfig(), sessions: { ...getConfig().sessions, record: recording } });
    await writeDurableNow('session-input', [{ id, sessionId: session.id, text: 'Delivered fixture', mode: 'auto', model: null,
      reasoningEffort: null, dueAt: 100, createdAt: 100, state: 'sent', owner: null, conversationId: 'input-commitment-fixture',
      messageId: `input:${id}`, offeredAt: 200, deliveredAt: 300, historyRecorded: false,
      toolImages: [{ name: 'invalid.webp', dataUrl: 'data:image/webp;base64,YQ==' }] }]);
    input.resetInputForTests();
    const result = await handlers.get('sessions:outbox')!(null, undefined) as any;
    expect(result.ok).toBe(true);
    const row = result.data[0];
    expect(getConfig().sessions).toMatchObject({ record: true, retainDays: 0 });
    expect(row.historyAnchored).toBe(true);
    expect(row.historyRecorded).not.toBe(true);
    expect((await readDurable<any[]>('session-input'))![0].historyAnchored).toBe(true);
    const canonical = (await store.readEvents(session.id)).filter(event => event.kind === 'user_message');
    expect(canonical).toHaveLength(1);
    expect(canonical[0]).toMatchObject({ inputId: id, time: 200 });
  } finally {
    await writeDurableNow('session-input', previous ?? []);
    input.resetInputForTests();
  }
});

it('validates dropped file count and stages arbitrary native file types', async () => {
  const drop = (payload: unknown) => handlers.get('sessions:dropFiles')!(null, payload) as Promise<any>;
  expect(await drop({ files: [] })).toMatchObject({ ok: false });
  expect(await drop({ files: Array(21).fill('image.png') })).toMatchObject({ ok: false });
  expect(await drop({ files: [''] })).toMatchObject({ ok: false });
  expect(await drop({ files: [path.join(process.cwd(), 'package.json')] })).toMatchObject({ ok: true, data: [expect.objectContaining({ name: 'package.json', mimeType: 'application/json' })] });
});

it('publishes Goal draft progress through the session refresh channel without a new transcript event', async () => {
  const { startGoalDraft, resetGoalStateForTests } = await import('../src/main/goal.js');
  const session = await createSession({ title: 'Goal progress', conversationId: 'ipc-goal-progress' });
  currentWindow = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(), isDestroyed: () => false, webContents: { send: vi.fn() } };
  try {
    startGoalDraft({ conversationId: session.conversationId!, sessionId: session.id, turnId: 'finished-turn', deferStart: true });
    expect(currentWindow.webContents.send).toHaveBeenCalledWith('session:changed');
  } finally {
    resetGoalStateForTests();
  }
});

it('publishes the exact transcript owners of one recorder burst and an explicit global invalidation', async () => {
  const { recordNote } = await import('../src/main/session/recorder.js');
  const first = await createSession({ title: 'Changed A', conversationId: 'ipc-changed-a' });
  const second = await createSession({ title: 'Changed B', conversationId: 'ipc-changed-b' });
  const send = vi.fn();
  currentWindow = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(), isDestroyed: () => false, webContents: { send } };
  await recordNote(first.id, 'first owner');
  await recordNote(second.id, 'second owner');
  await recordNote(first.id, 'first owner again');
  await vi.waitFor(() => expect(send.mock.calls.filter(([channel]) => channel === 'session:changed')).toHaveLength(1));
  const [, change] = send.mock.calls.find(([channel]) => channel === 'session:changed')!;
  // Earlier fixtures may share this burst; each owner is still named exactly once.
  expect(change.sessionIds).toEqual(expect.arrayContaining([first.id, second.id]));
  expect(new Set(change.sessionIds).size).toBe(change.sessionIds.length);
  send.mockClear();
  expect(await handlers.get('sessions:clearImageStorage')!(null, { mode: 'all' })).toMatchObject({ ok: true });
  expect(send).toHaveBeenCalledWith('session:changed', { allTranscripts: true });
});

it('publishes the owning session when delivered input history is revised in place', async () => {
  const input = await import('../src/main/session/input.js');
  const store = await import('../src/main/session/store.js');
  const previous = await readDurable('session-input');
  const session = await createSession({ title: 'Input revision owner', conversationId: 'input-revision-owner' });
  const id = '30000000-0000-4000-8000-000000000002';
  const send = vi.fn();
  currentWindow = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(), isDestroyed: () => false, webContents: { send } };
  const owners = () => send.mock.calls.filter(([channel, change]) => channel === 'session:changed' && change?.sessionIds?.includes(session.id));
  const row = { id, sessionId: session.id, text: 'Revised fixture', mode: 'auto', model: null, reasoningEffort: null, dueAt: 100,
    createdAt: 100, owner: 'request', conversationId: 'input-revision-owner', offeredAt: 200, historyRecorded: false };
  try {
    await writeDurableNow('session-input', [{ ...row, state: 'tool' }]);
    input.resetInputForTests();
    expect(await handlers.get('sessions:outbox')!(null, undefined)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(owners()).toHaveLength(1));
    send.mockClear();
    // Same canonical key, same anchor and count: only the delivery state changes in place.
    await writeDurableNow('session-input', [{ ...row, state: 'sent', owner: null, messageId: `input:${id}`, deliveredAt: 300 }]);
    input.resetInputForTests();
    expect(await handlers.get('sessions:outbox')!(null, undefined)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(owners()).toHaveLength(1));
    const users = (await store.readEvents(session.id)).filter(event => event.kind === 'user_message');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ inputId: id, inputDelivery: 'confirmed' });
  } finally {
    await writeDurableNow('session-input', previous ?? []);
    input.resetInputForTests();
  }
});

it('stages clipboard image bytes with a preview through the general attachment owner', async () => {
  const drop = (payload: unknown) => handlers.get('sessions:dropFiles')!(null, payload) as Promise<any>;
  expect(await drop({ files: [] })).toMatchObject({ ok: false });
  expect(await drop({ files: [{ name: 'huge.png', bytes: new Uint8Array(12 * 1024 * 1024 + 1) }] })).toMatchObject({ ok: false });
  const sharp = (await import('sharp')).default;
  const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#123456' } }).png().toBuffer();
  const pasted = await drop({ files: [{ name: 'screenshot.png', bytes: new Uint8Array(bytes) }] });
  expect(pasted).toMatchObject({ ok: true, data: [{ name: 'screenshot.png', size: bytes.length, mimeType: 'image/png', preview: expect.stringMatching(/^data:image\/webp;base64,/) }] });
  const { readInputAttachmentChunk } = await import('../src/main/session/input-attachments.js');
  expect(await readInputAttachmentChunk(pasted.data[0], 0)).toBe(bytes.toString('base64'));
});

it('does not authorize the composer Generate Goal action from an absent or stale finish wait', async () => {
  const generate = (payload: unknown) => handlers.get('sessions:generateFinishGoal')!(null, payload) as Promise<any>;
  const session = await createSession({ title: 'No finish wait', conversationId: 'finish-action-ipc-chat' });
  expect(await generate({ id: session.id })).toMatchObject({ ok: false });
  expect(await generate({ id: session.id, expectedTurnId: 'old-turn' })).toMatchObject({ ok: false });
});

it('round-trips Goal controls and cannot revive old periodic input when Off cancellation fails then On retries', async () => {
  const outbox = await import('../src/main/session/input.js');
  const durable = await import('../src/main/durable.js');
  const store = await import('../src/main/session/store.js');
  const original = await outbox.listInputs();
  await writeDurableNow('session-input', []); outbox.resetInputForTests();
  const config = (minutes: number) => ({ ...settings({ record: true, multiAgent: false }),
    ui: { ...defaultConfig().ui, finishTool: true },
    goal: { ...defaultConfig().goal, impulseMinutes: minutes, includeToolCalls: true } });
  let write: ReturnType<typeof vi.spyOn> | undefined;
  try {
    expect(await save(config(1))).toMatchObject({ ok: true });
    expect(getConfig().goal).toMatchObject({ impulseMinutes: 1, includeToolCalls: true });
    const session = await createSession({ title: 'Periodic ownership', conversationId: 'periodic-settings-chat' });
    await appendEvent(session.id, { source: 'extension', kind: 'turn_start', turnId: 'periodic-turn', time: Date.now() });
    await store.observeSessionModel(session.id, 'periodic-settings-chat', 'gpt-6-astra', Date.now());
    const row = await outbox.enqueueInput({ id: 'f0f00014-1111-4111-8111-111111111111', sessionId: session.id,
      text: 'Pending automatic instruction', mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null },
      { turnId: 'periodic-turn', periodic: false, mode: 'goal', userRequested: true });
    // Seed an old-version row; current code deliberately refuses new periodic input.
    await writeDurableNow('session-input', [{ ...row, finishOwner: { turnId: 'periodic-turn', periodic: true } }]);
    outbox.resetInputForTests();
    write = vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('Cancellation disk failure'));
    expect(await save(config(0))).toMatchObject({ ok: false });
    expect(getConfig().goal.impulseMinutes).toBe(0); // Off was published before retirement.
    write.mockRejectedValueOnce(new Error('Still cannot retire'));
    expect(await save(config(1))).toMatchObject({ ok: false });
    expect(getConfig().goal.impulseMinutes).toBe(0); // Failed retirement cannot publish On.
    write.mockRestore(); write = undefined;
    expect(await save(config(1))).toMatchObject({ ok: true });
    outbox.resetInputForTests();
    expect((await outbox.listInputs()).find(entry => entry.id === row.id)?.state).toBe('cancelled');
    expect(await outbox.offerToolInput(session.id, 'periodic-settings-chat', 'later-request', Date.now())).toEqual({ messages: [], reminder: '' });
  } finally {
    write?.mockRestore();
    await writeDurableNow('session-input', original); outbox.resetInputForTests();
  }
});

it('native opening cancellation aborts the exact IPC invocation and prevents a late ready result', async () => {
  const goal = await import('../src/main/goal.js');
  const requestId = 'ad3ecbf4-c3a1-4d0d-9e9f-619787bcf982';
  let signal: AbortSignal | undefined;
  const draft = vi.spyOn(goal, 'draftOpeningMessage').mockImplementation(async (_text, _mode, _progress, current) => {
    signal = current;
    return new Promise((_resolve, reject) => current!.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true }));
  });
  try {
    const opening = handlers.get('sessions:goalOpening')!(null, { text: 'Implement safely', mode: 'goal', requestId });
    const cancelled = await handlers.get('tasks:cancel')!(null, { requestId }) as any;
    expect(cancelled).toEqual({ ok: true, data: true });
    expect(signal?.aborted).toBe(true);
    expect(await opening).toMatchObject({ ok: false, error: 'task_cancelled' });
    expect(draft).toHaveBeenCalledTimes(1);
  } finally { draft.mockRestore(); }
});

it('projects exact retained worker parents without adopting same-name unrelated recordings', async () => {
  const prime = await createSession({ title: 'Parent', conversationId: 'parent-projection' });
  spawn({ workers: [{ task: 'test parent identity' }], caller: { conversationId: 'parent-projection' } });
  expect(bindConversation('worker-1', 'worker-projection')).toBe(true);
  const origin = { kind: 'worker' as const, fromSessionId: null, agentId: 'worker-1', task: 'test parent identity' };
  const child = await createSession({ title: 'Child', conversationId: 'worker-projection', origin });
  const unrelated = await createSession({ title: 'Unrelated', conversationId: 'unrelated-worker', origin });
  const result = await sessionList();
  expect(result.ok).toBe(true);
  expect(result.data.sessions.find((row: any) => row.id === child.id).origin.fromSessionId).toBe(prime.id);
  expect(result.data.sessions.find((row: any) => row.id === unrelated.id).origin.fromSessionId).toBeNull();
  restoreSwarm(null); // End this fixture without user-clear retiring it into later tests.
});

it('adds picker-selected projects, reuses containing approval, and leaves cancellation unchanged', async () => {
  currentWindow = { setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(), isDestroyed: () => false, webContents: { send: vi.fn() } };
  const folder = path.join(dir, 'picker-project');
  await fs.mkdir(path.join(folder, 'child'), { recursive: true });
  await saveConfig({ ...defaultConfig(), roots: [] });
  await writeDurableNow('projects', []);
  const add = () => handlers.get('projects:add')!(null, {}) as Promise<any>;
  expect((await add()).data).toBeNull();
  expect(getConfig().roots).toHaveLength(0);
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [folder] });
  const first = await add();
  expect(first.ok, first.error).toBe(true);
  expect(first.data.name).toBe('picker-project');
  expect(getConfig().roots).toHaveLength(1);
  expect((await add()).data.id).toBe(first.data.id);
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [path.join(folder, 'child')] });
  expect((await add()).data.name).toBe('child');
  expect(getConfig().roots).toHaveLength(1);
  const listed = await handlers.get('projects:list')!(null, {}) as any;
  expect(listed.data).toHaveLength(2);
  const colored = await handlers.get('projects:color')!(null, { id: first.data.id, color: 'blue' }) as any;
  expect(colored).toMatchObject({ ok: true, data: { id: first.data.id, color: 'blue' } });
  expect(await handlers.get('projects:color')!(null, { id: first.data.id, color: 'chartreuse' })).toMatchObject({ ok: false });
  const uncolored = await handlers.get('projects:color')!(null, { id: first.data.id, color: null }) as any;
  expect(uncolored).toMatchObject({ ok: true, data: { id: first.data.id } });
  expect(uncolored.data.color).toBeUndefined();
  const removed = await handlers.get('projects:remove')!(null, { id: first.data.id }) as any;
  expect(removed).toMatchObject({ ok: true, data: { id: first.data.id, ungrouped: true } });
  expect(getConfig().roots).toHaveLength(1);
  expect((await fs.stat(folder)).isDirectory()).toBe(true);
  expect(await handlers.get('projects:remove')!(null, { id: folder })).toMatchObject({ ok: false });
  expect(await handlers.get('projectGit:snapshot')!(null, { projectId: folder })).toMatchObject({ ok: false });
  expect(await handlers.get('projectGit:diff')!(null, { projectId: first.data.id, path: '' })).toMatchObject({ ok: false });
  expect(await handlers.get('sessions:toolEditReview')!(null, {
    sessionId: first.data.id, callId: 'not-a-uuid', changeIndex: 0
  })).toMatchObject({ ok: false });
});

it('does not install a stale Git watch after a newer Files project watch', async () => {
  const { ProjectFileWatchSet } = await import('../src/main/project-file-watcher.js');
  const { ProjectGitWatchSet } = await import('../src/main/project-git.js');
  const contents = Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: () => false });
  currentWindow = { isDestroyed: () => false, webContents: contents } as any;
  const firstId = '11111111-1111-4111-8111-111111111111';
  const secondId = '22222222-2222-4222-8222-222222222222';
  let finishFirst!: () => void, finishSecond!: () => void;
  const fileSync = vi.spyOn(ProjectFileWatchSet.prototype, 'sync').mockImplementation(projectId =>
    new Promise<void>(resolve => { if (projectId === firstId) finishFirst = resolve; else finishSecond = resolve; }));
  const gitSync = vi.spyOn(ProjectGitWatchSet.prototype, 'sync').mockResolvedValue();
  try {
    const watch = (projectId: string) => handlers.get('projectFiles:watch')!(null, { projectId, directories: [''] });
    const first = watch(firstId);
    const second = watch(secondId);
    finishSecond();
    expect(await second).toMatchObject({ ok: true, data: true });
    finishFirst();
    expect(await first).toMatchObject({ ok: true, data: false });
    expect(gitSync).toHaveBeenCalledOnce();
    expect(gitSync).toHaveBeenCalledWith(secondId);
  } finally {
    fileSync.mockRestore();
    gitSync.mockRestore();
  }
});

/** The whole settings object the renderer sends, with the parts a test cares about set. */
function settings(over: { record: boolean; multiAgent: boolean }) {
  const base = defaultConfig();
  return {
    capabilities: base.capabilities,
    readOnly: base.readOnly,
    commandAllowlist: base.commandAllowlist,
    tunnel: base.tunnel,
    ui: base.ui,
    sessions: { ...base.sessions, record: over.record },
    compaction: base.compaction,
    multiAgent: { ...base.multiAgent, enabled: over.multiAgent },
    goal: base.goal
  };
}

beforeAll(async () => {
  dir = await makeTempDir('clf-ipc-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  onSwarmPersist(() => writeDurableSoon('ipc-swarm', snapshotSwarm()));
  onSwarmPersistNow((snapshot) => writeDurableNow('ipc-swarm', snapshot));
  onRetiredWorkersPersist(() => writeDurableSoon('ipc-retired-workers', snapshotRetiredWorkers()));
  onRetiredWorkersPersistNow((snapshot) => writeDurableNow('ipc-retired-workers', snapshot));
  registerIpc(
    () => currentWindow as any,
    () => {
      quitToInstallCalls += 1;
    }
  );
});

afterAll(async () => {
  await stopBridge();
  await flushDurable();
  onSwarmPersist(null);
  onSwarmPersistNow(null);
  onRetiredWorkersPersist(null);
  onRetiredWorkersPersistNow(null);
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(async () => {
  currentWindow = null;
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] });
  nativeTheme.themeSource = 'system';
  vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
  vi.mocked(shell.openPath).mockReset().mockResolvedValue('');
  vi.mocked(shell.openExternal).mockReset().mockResolvedValue(undefined);
  vi.mocked(app.getVersion).mockReset().mockReturnValue('0.0.0');
  resetSwarm();
  resetBridgeForTests();
  resetWorkspaces();
  // The app opens the worker's chat itself; a command only exists while a page it opened
  // still has it to redeem.
  setBrowserOpener(async () => undefined);
  await saveConfig({
    ...defaultConfig(),
    sessions: { ...defaultConfig().sessions, record: true },
    multiAgent: { enabled: true, maxWorkers: 3, allowUnattributedCalls: false, recoverAgentTabs: true }
  });
});

it('keeps origin history navigation separate from live revision cursors over IPC', async () => {
  const session = await createSession({ title: 'History cursors' });
  const message = { kind: 'assistant_message' as const, source: 'extension' as const, time: 10,
    messageId: 'review', message: { text: 'Detailed review', truncated: false, chars: 15 }, final: true };
  const first = await upsertMessageEvent(session.id, message);
  await appendEvent(session.id, { kind: 'note', source: 'app', time: 20, message: { text: 'Later work', truncated: false, chars: 10 } });
  const revision = await upsertMessageEvent(session.id, { ...message, renderedHtml: { text: '<p>Detailed review</p>', truncated: false, chars: 22 } });
  const read = (options: object) => handlers.get('sessions:events')!(null, { id: session.id, ...options }) as Promise<any>;
  const tail = await read({ limit: 1 });
  expect(tail.ok).toBe(true);
  expect(tail.data.events[0].kind).toBe('note');
  const older = await read({ before: tail.data.events[0].seq, limit: 1 });
  expect(older.data.events[0]).toMatchObject({ kind: 'assistant_message', origin: first.event.seq, seq: revision.event.seq });
  const newer = await read({ after: first.event.seq, limit: 1 });
  expect(newer.data.events[0].kind).toBe('note');
  const delta = await read({ from: revision.event.seq, limit: 1 });
  expect(delta.data.events[0].messageId).toBe('review');
  expect(delta.data.nextFrom).toBe(revision.event.seq + 1);
});

describe('explicit settings replace the published tool contract', () => {
  it.each(['finish', 'command'] as const)('withdraws %s from real endpoint publication after its setting is disabled', async kind => {
    const { startMcpServer } = await import('../src/main/mcp/server.js');
    const { effectiveCapabilities } = await import('../src/main/config.js');
    const { publishPluginSurface, pluginRefreshPublications, resetPluginRefreshForTests } = await import('../src/main/plugin-refresh.js');
    const initial = getConfig();
    await saveConfig({ ...initial, ui: { ...initial.ui, finishTool: true }, capabilities: { ...initial.capabilities, read: true } });
    const endpoint = await startMcpServer(() => ({ roots: [], caps: effectiveCapabilities(getConfig()), readOnly: getConfig().readOnly }));
    const snapshot = () => {
      endpoint.publication!('core', (name, version, instructions, tools) => publishPluginSurface('core', name, version, instructions, tools));
      return pluginRefreshPublications().find(row => row.surface === 'core')!;
    };
    try {
      const before = snapshot();
      const beforeState = await handlers.get('state:get')!(null, undefined) as any;
      expect(beforeState.data.connectorSchemas.core).toBe(before.schemaId);
      const tool = kind === 'finish' ? 'session_finish' : 'exec_command';
      expect(before.tools.map(row => row.name)).toContain(tool);
      expect(before.tools.map(row => row.name)).not.toContain('session');
      const current = getConfig();
      const patch = { ...current, ...(kind === 'finish'
        ? { ui: { ...current.ui, finishTool: false } }
        : { capabilities: { ...current.capabilities, command: false } }) };
      expect((await save(patch)).ok).toBe(true);
      const after = snapshot();
      const afterState = await handlers.get('state:get')!(null, undefined) as any;
      expect(afterState.data.connectorSchemas.core).toBe(after.schemaId);
      expect(after.tools.map(row => row.name)).not.toContain(tool);
      expect(after.tools.map(row => row.name)).not.toContain('session');
      expect(after.schemaId).not.toBe(before.schemaId);
      const saved = getConfig();
      expect((await save({ ...saved, ui: { ...saved.ui, theme: 'dark' } })).ok).toBe(true);
      expect(snapshot().schemaId).toBe(after.schemaId);
    } finally { await endpoint.stop(); resetPluginRefreshForTests(); }
  });
});

describe('startup state without secure storage', () => {
  it('still returns a usable app/bridge state instead of crashing state discovery', async () => {
    resetSecretsCacheForTests();
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);

    const reply = (await handlers.get('state:get')!(null, undefined)) as any;
    expect(reply.ok).toBe(true);
    expect(reply.data.secureStorage.available).toBe(false);
    expect(reply.data.hasApiKey).toBe(false);
    expect(reply.data.hasGoalKey).toBe(false);
    expect(reply.data.bridge.paired).toBe(false);
  });
});

describe('turning multi-agent mode off', () => {
  /**
   * Pausing execution must withdraw queued browser work before the bridge goes away. The
   * durable worker history itself survives; only the pending transport is cancelled.
   */
  it('cancels the run’s queued worker chats before the bridge goes away', async () => {
    await startBridge();
    spawn({ workers: [{ task: 'work' }], caller: { conversationId: 'c-prime' } });
    // Opening is asynchronous, as it is in the app.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pendingCommands().length).toBe(1);

    // Recording off as well, so this really is the case where the bridge is shut down.
    await save(settings({ record: false, multiAgent: false }));

    expect(getConfig().multiAgent.enabled).toBe(false);
    expect(pendingCommands(), 'a worker chat was left queued for a run that has ended').toEqual([]);
  });

  it('does not acknowledge the toggle until the parked retained history is durable', async () => {
    const prime = '11111111-2222-4333-8444-555555555555';
    const worker = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    spawn({ workers: [{ task: 'must stay fenced after disable' }], caller: { conversationId: prime } });
    expect(bindConversation('worker-1', worker)).toBe(true);
    expect(await persistAgentAuthorityNow()).toBe(true);
    expect(await readDurable('ipc-swarm')).not.toBeNull();

    const reply = await save(settings({ record: false, multiAgent: false }));
    expect(reply.ok, reply.error).toBe(true);
    expect(await readDurable<any>('ipc-swarm')).toMatchObject({
      version: 7,
      runId: null,
      primeConversationId: null,
      agents: [],
      dormantRuns: [
        expect.objectContaining({
          primeConversationId: prime,
          agents: expect.arrayContaining([
            expect.objectContaining({
              info: expect.objectContaining({
                id: 'worker-1',
                conversationId: worker,
                state: 'sleeping',
                revivable: true
              })
            })
          ])
        })
      ]
    });
    expect(await readDurable<any>('ipc-retired-workers')).toMatchObject({ workers: [] });
  });

  it('survives a disabled restart and re-enable with the exact old worker chat still revivable', async () => {
    const prime = '22222222-3333-4444-8555-666666666666';
    const worker = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    spawn({ workers: [{ task: 'remember this exact worker' }], caller: { conversationId: prime } });
    expect(bindConversation('worker-1', worker)).toBe(true);
    expect(await persistAgentAuthorityNow()).toBe(true);

    const disabled = await save(settings({ record: false, multiAgent: false }));
    expect(disabled.ok, disabled.error).toBe(true);
    const saved = await readDurable<any>('ipc-swarm');
    expect(saved).not.toBeNull();

    // The startup path restores authority even while the feature is off, then canonicalizes
    // any leftover active incarnation into parked history. Reproduce that process boundary here.
    restoreSwarm(saved);
    pauseSwarmForDisable('multi-agent mode is disabled');
    expect(snapshotSwarm()).toMatchObject({
      runId: null,
      dormantRuns: [expect.objectContaining({ primeConversationId: prime })]
    });

    const enabled = await save(settings({ record: false, multiAgent: true }));
    expect(enabled.ok, enabled.error).toBe(true);
    expect(swarmStateForCaller({ conversationId: prime }).agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'worker-1',
          conversationId: worker,
          state: 'sleeping',
          revivable: true
        })
      ])
    );

    sendMessage({ conversationId: prime }, 'worker-1', 'continue in the exact worker chat');
    expect(pendingWorkerRevivals()).toEqual([
      expect.objectContaining({ id: 'worker-1', conversationId: worker })
    ]);
  });

  it('preserves every parked owner when disabling a different prime that is still active', async () => {
    const primeA = '33333333-4444-4555-8666-777777777777';
    const workerA = 'cccccccc-dddd-4eee-8fff-000000000001';
    spawn({ workers: [{ task: 'A retained history' }], caller: { conversationId: primeA } });
    expect(bindConversation('worker-1', workerA)).toBe(true);
    finishAgent({ conversationId: workerA }, 'A is parked already');
    expect(releaseQuiescentRun()).toBe(true);

    const primeB = '44444444-5555-4666-8777-888888888888';
    const workerB = 'dddddddd-eeee-4fff-8000-000000000002';
    spawn({ workers: [{ task: 'B is live when disabled' }], caller: { conversationId: primeB } });
    expect(bindConversation('worker-1', workerB)).toBe(true);

    const disabled = await save(settings({ record: false, multiAgent: false }));
    expect(disabled.ok, disabled.error).toBe(true);
    const saved = await readDurable<any>('ipc-swarm');
    expect(saved?.runId).toBeNull();
    expect(saved?.dormantRuns).toHaveLength(2);
    expect(saved?.dormantRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ primeConversationId: primeA }),
        expect.objectContaining({ primeConversationId: primeB })
      ])
    );

    restoreSwarm(saved);
    pauseSwarmForDisable('multi-agent mode is disabled');
    const enabled = await save(settings({ record: false, multiAgent: true }));
    expect(enabled.ok, enabled.error).toBe(true);
    expect(swarmStateForCaller({ conversationId: primeA }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      conversationId: workerA
    });
    expect(swarmStateForCaller({ conversationId: primeB }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      conversationId: workerB
    });
  });

  it('keeps disabled history until the explicit Clear swarm IPC destroys it', async () => {
    const prime = '55555555-6666-4777-8888-999999999999';
    const worker = 'eeeeeeee-ffff-4000-8111-000000000003';
    spawn({ workers: [{ task: 'survive disable until explicit clear' }], caller: { conversationId: prime } });
    expect(bindConversation('worker-1', worker)).toBe(true);

    const disabled = await save(settings({ record: false, multiAgent: false }));
    expect(disabled.ok, disabled.error).toBe(true);
    expect((await readDurable<any>('ipc-swarm'))?.dormantRuns).toHaveLength(1);

    const cleared = await handlers.get('swarm:reset')!(null, undefined) as any;
    expect(cleared.ok, cleared.error).toBe(true);
    expect(await readDurable('ipc-swarm')).toBeNull();
    expect(await readDurable<any>('ipc-retired-workers')).toMatchObject({
      workers: expect.arrayContaining([expect.objectContaining({ id: 'worker-1', conversationId: worker })])
    });
  });
});

describe('bounded IPC identities and OS launch results', () => {
  it('reports shell.openPath failure instead of claiming the extension folder opened', async () => {
    vi.mocked(shell.openPath).mockResolvedValueOnce('Access is denied');
    const reply = (await handlers.get('bridge:openExtensionFolder')!(null, undefined)) as {
      ok: boolean;
      error?: string;
    };
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/could not open.*access is denied/i);
  });

  it('opens the extension recovery ZIP from the installed app version, never releases/latest', async () => {
    vi.mocked(app.getVersion).mockReturnValueOnce('1.8.8');
    const reply = await handlers.get('bridge:downloadExtension')!(null, undefined);

    expect(reply).toEqual({ ok: true, data: true });
    expect(shell.openExternal).toHaveBeenCalledWith(extensionDownloadUrl('1.8.8'));
    expect(vi.mocked(shell.openExternal).mock.calls[0]?.[0]).not.toContain('/releases/latest/');
  });

  it('bounds and validates an agent id before it reaches the global broker', async () => {
    const clear = handlers.get('swarm:clearAgent')!;
    const oversized = (await clear(null, 'worker-' + 'x'.repeat(200_000))) as { ok: boolean; error?: string };
    expect(oversized.ok).toBe(false);
    expect(oversized.error).toMatch(/64|too big/i);

    const punctuation = (await clear(null, 'worker-1\nspoofed')) as { ok: boolean; error?: string };
    expect(punctuation.ok).toBe(false);
  });
});

describe('ChatGPT browser settings', () => {
  it('persists Edge and keeps it through an unrelated stale renderer save', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    const result = await save({ ...base, ui: { ...base.ui, chatBrowser: 'edge' } }, base);
    expect(result.ok, result.error).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).ui.chatBrowser).toBe('edge');
    const stale = await save({ ...base, ui: { ...base.ui, theme: 'light' } }, base);
    expect(stale.ok, stale.error).toBe(true);
    expect(getConfig().ui).toMatchObject({ chatBrowser: 'edge', theme: 'light' });
    const current = getConfig();
    expect((await save({ ...current, ui: { ...current.ui, chatBrowser: 'unsupported' } }, current)).ok).toBe(false);
    expect(getConfig().ui.chatBrowser).toBe('edge');
  });
});

describe('settings writes from more than one UI', () => {
  it('validates and persists the Plugins tunnel id through Settings, including explicit clearing', async () => {
    const base = defaultConfig(); await saveConfig(base);
    const tunnelId = `tunnel_${'a'.repeat(32)}`;
    expect((await save({ ...base, tunnel: { ...base.tunnel, pluginsTunnelId: tunnelId } }, base)).ok).toBe(true);
    expect(getConfig().tunnel.pluginsTunnelId).toBe(tunnelId);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).tunnel.pluginsTunnelId).toBe(tunnelId);
    for (const invalid of ['not-a-tunnel', `tunnel_${'g'.repeat(32)}`, `tunnel_${'a'.repeat(31)}`, 'x'.repeat(129)]) {
      const current = getConfig();
      expect((await save({ ...current, tunnel: { ...current.tunnel, pluginsTunnelId: invalid } }, current)).ok).toBe(false);
      expect(getConfig().tunnel.pluginsTunnelId).toBe(tunnelId);
    }
    const current = getConfig();
    expect((await save({ ...current, tunnel: { ...current.tunnel, pluginsTunnelId: '' } }, current)).ok).toBe(true);
    expect(getConfig().tunnel.pluginsTunnelId).toBe('');
  });

  it('preserves a newer Plugins tunnel across stale and legacy renderer saves', async () => {
    const base = defaultConfig(); await saveConfig(base);
    const tunnelId = `tunnel_${'b'.repeat(32)}`;
    expect((await save({ ...base, tunnel: { ...base.tunnel, pluginsTunnelId: tunnelId } }, base)).ok).toBe(true);
    expect((await save({ ...base, ui: { ...base.ui, theme: 'light' } }, base)).ok).toBe(true);
    expect(getConfig().tunnel.pluginsTunnelId).toBe(tunnelId);
    const legacy = { ...base, tunnel: { ...base.tunnel } };
    delete legacy.tunnel.pluginsTunnelId;
    expect((await save({ ...legacy, ui: { ...legacy.ui, minimizeToTray: !legacy.ui.minimizeToTray } }, legacy)).ok).toBe(true);
    expect(getConfig().tunnel.pluginsTunnelId).toBe(tunnelId);
    expect(getConfig().ui.minimizeToTray).toBe(!legacy.ui.minimizeToTray);
  });

  it('changes login registration only on a changed preference and reports failure after other effects', async () => {
    const lifecycle = await import('../src/main/window-lifecycle.js');
    const connection = await import('../src/main/connection.js');
    const applied = vi.spyOn(connection, 'applySettings');
    const login = vi.spyOn(lifecycle, 'applyLoginStartup').mockImplementation(() => { throw new Error('login registration refused'); });
    try {
      const base = defaultConfig();
      await saveConfig(base);
      const cosmetic = await save({ ...base, ui: { ...base.ui, theme: 'light' } }, base);
      expect(cosmetic.ok, cosmetic.error).toBe(true);
      expect(login).not.toHaveBeenCalled();
      applied.mockClear();
      const current = getConfig();
      const changed = await save({ ...current, ui: { ...current.ui, theme: 'dark', startAtLogin: true } }, current);
      expect(changed.ok).toBe(false);
      expect(changed.error).toContain('login registration refused');
      expect(getConfig().ui.startAtLogin).toBe(true);
      expect(nativeTheme.themeSource).toBe('dark');
      expect(applied).toHaveBeenCalledOnce();
      expect(login).toHaveBeenCalledOnce();
      expect(applied.mock.invocationCallOrder[0]).toBeLessThan(login.mock.invocationCallOrder[0]!);
    } finally { login.mockRestore(); applied.mockRestore(); }
  });
  it('rotates only the active Goal provider and exposes key presence without the secret', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, goal: { ...base.goal, provider: { kind: 'custom', baseUrl: 'http://localhost:11434/v1' } } });
    const goal = await import('../src/main/goal.js');
    const retired = vi.spyOn(goal, 'retireGoalDrafts');
    try {
      await handlers.get('secret:set')!({}, { key: 'openRouterApiKey', value: 'synthetic-inactive-key' });
      expect(retired).not.toHaveBeenCalled();
      const response = await handlers.get('secret:set')!({}, { key: 'customProviderApiKey', value: 'synthetic-active-key' });
      expect(retired).toHaveBeenCalledTimes(1);
      expect(response).toMatchObject({ ok: true, data: { hasCustomProviderKey: true } });
      expect(JSON.stringify(response)).not.toContain('synthetic-active-key');
    } finally { retired.mockRestore(); }
  });
  it('persists connector instructions through IPC, preserves concurrent edits, and allows explicit clearing', async () => {
    const base = defaultConfig(); await saveConfig(base);
    const wanted = { ...base, mcp: { instructions: 'Use the approved project only.' }, ui: { ...base.ui, browserOnly: true } };
    expect((await save(wanted, base)).ok).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).mcp).toEqual(wanted.mcp);
    expect(getConfig().ui.browserOnly).toBe(true);
    expect((await save({ ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } }, base)).ok).toBe(true);
    expect(getConfig().mcp).toEqual(wanted.mcp);
    expect(getConfig().ui.browserOnly).toBe(true);
    const legacy = { ...base } as any; delete legacy.mcp;
    expect((await save(legacy, legacy)).ok).toBe(true);
    expect(getConfig().mcp).toEqual(wanted.mcp);
    const current = getConfig();
    expect((await save({ ...current, mcp: { instructions: '' } }, current)).ok).toBe(true);
    expect(getConfig().mcp.instructions).toBe('');
    expect((await save({ ...current, mcp: { instructions: 'x'.repeat(4001) } }, current)).ok).toBe(false);
    expect(getConfig().mcp.instructions).toBe('');
  });
  it('starts and stops the local control API only when its switch changes, and keeps it through stale saves', async () => {
    const controlApi = await import('../src/main/control-api.js');
    controlApi.initControlApiPath(dir);
    const endpoint = path.join(dir, 'control-api', 'endpoint.json');
    try {
      const base = defaultConfig(); await saveConfig(base);
      expect((await save({ ...base, controlApi: { enabled: true } }, base)).ok).toBe(true);
      expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).controlApi).toEqual({ enabled: true, allowActions: false });
      const { port } = JSON.parse(await fs.readFile(endpoint, 'utf8'));
      expect(controlApi.controlApiPort()).toBe(port);
      // A save from a form that still shows the old value, and one from a build that has no
      // such field, both leave the switch and the running listener alone.
      expect((await save({ ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } }, base)).ok).toBe(true);
      const legacy = { ...base } as Partial<typeof base>; delete legacy.controlApi;
      expect((await save(legacy, legacy)).ok).toBe(true);
      expect(getConfig().controlApi.enabled).toBe(true);
      expect(controlApi.controlApiPort()).toBe(port);
      const current = getConfig();
      expect((await save({ ...current, controlApi: { enabled: false } }, current)).ok).toBe(true);
      expect(controlApi.controlApiPort()).toBeNull();
      await expect(fs.access(endpoint)).rejects.toThrow();
      // Switched off means nothing listens any more, not merely that requests are refused.
      await expect(fetch(`http://127.0.0.1:${port}/v1/health`)).rejects.toThrow();
    } finally {
      await controlApi.stopControlApi();
    }
  });
  it('keeps message actions behind the API switch and merges the two switches independently', async () => {
    const controlApi = await import('../src/main/control-api.js');
    controlApi.initControlApiPath(dir);
    try {
      const base = defaultConfig(); await saveConfig(base);
      // Actions cannot be granted while the API is off.
      expect((await save({ ...base, controlApi: { enabled: false, allowActions: true } }, base)).ok).toBe(true);
      expect(getConfig().controlApi).toEqual({ enabled: false, allowActions: false });
      const off = getConfig();
      expect((await save({ ...off, controlApi: { enabled: true, allowActions: true } }, off)).ok).toBe(true);
      expect(getConfig().controlApi).toEqual({ enabled: true, allowActions: true });
      expect(controlApi.controlApiPort()).not.toBeNull();
      // A form from a build with no allowActions field, and a stale form still showing it off,
      // both leave a grant that was made after they were loaded.
      const granted = getConfig();
      expect((await save({ ...granted, controlApi: { enabled: true } }, granted)).ok).toBe(true);
      expect(getConfig().controlApi.allowActions).toBe(true);
      const stale = { ...granted, controlApi: { enabled: true, allowActions: false } };
      expect((await save(stale, stale)).ok).toBe(true);
      expect(getConfig().controlApi.allowActions).toBe(true);
      // Turning the API off revokes the grant and stops the listener; turning it back on does
      // not bring the grant back.
      const running = getConfig();
      expect((await save({ ...running, controlApi: { enabled: false, allowActions: true } }, running)).ok).toBe(true);
      expect(getConfig().controlApi).toEqual({ enabled: false, allowActions: false });
      expect(controlApi.controlApiPort()).toBeNull();
      const stopped = getConfig();
      expect((await save({ ...stopped, controlApi: { enabled: true } }, stopped)).ok).toBe(true);
      expect(getConfig().controlApi).toEqual({ enabled: true, allowActions: false });
      // The grant can be withdrawn on its own without stopping the listener.
      const again = getConfig();
      expect((await save({ ...again, controlApi: { enabled: true, allowActions: true } }, again)).ok).toBe(true);
      const withdraw = getConfig();
      expect((await save({ ...withdraw, controlApi: { enabled: true, allowActions: false } }, withdraw)).ok).toBe(true);
      expect(getConfig().controlApi).toEqual({ enabled: true, allowActions: false });
      expect(controlApi.controlApiPort()).not.toBeNull();
    } finally {
      await controlApi.stopControlApi();
    }
  });
  it('saves helper settings and tab retention through the renderer schema and merge boundary', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    const wanted = { ...base, ui: { ...base.ui, tabsToKeepOpen: 6 }, goal: {
      ...base.goal, helperModel: 'account-helper', helperReasoning: 'medium' as const
    } };
    const result = await save(wanted, base);
    expect(result.ok, result.error).toBe(true);
    expect(getConfig().ui.tabsToKeepOpen).toBe(6);
    expect(getConfig().goal).toMatchObject({ helperModel: 'account-helper', helperReasoning: 'medium', model: base.goal.model });
  });
  it('persists and clears ordinary new-chat defaults independently through settings merge', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    const configured = { ...base, ui: { ...base.ui, defaultChatModel: 'gpt-5.6-sol', defaultChatReasoning: 'xhigh' as const } };
    expect((await save(configured, base)).ok).toBe(true);
    expect(getConfig().ui).toMatchObject({ defaultChatModel: 'gpt-5.6-sol', defaultChatReasoning: 'xhigh' });

    const withBoth = getConfig();
    expect((await save({ ...withBoth, ui: { ...withBoth.ui, defaultChatModel: undefined } }, withBoth)).ok).toBe(true);
    expect(getConfig().ui.defaultChatModel).toBeUndefined();
    expect(getConfig().ui.defaultChatReasoning).toBe('xhigh');

    const reasoningOnly = getConfig();
    expect((await save({ ...reasoningOnly, ui: { ...reasoningOnly.ui, defaultChatReasoning: undefined } }, reasoningOnly)).ok).toBe(true);
    expect(getConfig().ui.defaultChatReasoning).toBeUndefined();
    const stored = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
    expect(stored.ui).not.toHaveProperty('defaultChatModel');
    expect(stored.ui).not.toHaveProperty('defaultChatReasoning');
  });
  it('persists the planner backend and preserves it across an unrelated stale settings save', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    const selected = await save({ ...base, ui: { ...base.ui, planBackend: 'api' } }, base);
    expect(selected.ok, selected.error).toBe(true);
    expect(getConfig().ui.planBackend).toBe('api');
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).ui.planBackend).toBe('api');
    const stale = await save({ ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } }, base);
    expect(stale.ok, stale.error).toBe(true);
    expect(getConfig().ui).toMatchObject({ planBackend: 'api', minimizeToTray: !base.ui.minimizeToTray });
    const current = getConfig();
    expect((await save({ ...current, ui: { ...current.ui, planBackend: 'chatgpt' } }, current)).ok).toBe(true);
    expect(getConfig().ui.planBackend).toBe('chatgpt');
    expect((await save({ ...current, ui: { ...current.ui, planBackend: 'unsupported' } }, current)).ok).toBe(false);
    expect(getConfig().ui.planBackend).toBe('chatgpt');
  });
  it('does not let a stale renderer snapshot undo a newer extension setting', async () => {
    currentWindow = {
      setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(),
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    };
    const original = defaultConfig();
    const base = {
      ...original,
      ui: { ...original.ui, theme: 'light' as const },
      goal: { ...original.goal, enabled: true }
    };
    await saveConfig(base);

    // The extension writes after the renderer has already captured `base` for an unrelated
    // form edit. This is exactly the race a serialized config queue cannot solve by itself.
    await saveConfig({ ...base, goal: { ...base.goal, enabled: false } });
    const wanted = { ...base, ui: { ...base.ui, theme: 'dark' as const } };
    const reply = await save(wanted, base);

    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().ui.theme).toBe('dark');
    expect(nativeTheme.themeSource).toBe('dark');
    expect(currentWindow.setBackgroundColor).toHaveBeenCalledWith('#181818');
    if (process.platform === 'win32') expect(currentWindow.setTitleBarOverlay).toHaveBeenCalledWith({
      height: 36, color: '#00000000', symbolColor: '#ffffff'
    });
    expect(getConfig().goal.enabled).toBe(false);
  });

  it('persists command policy fields independently across stale renderer saves', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    const enabled = await save({
      ...base, commandAllowlist: { enabled: true, mode: 'deny', rules: ['git status', 'git diff *'] }
    }, base);
    expect(enabled.ok, enabled.error).toBe(true);

    const stale = await save({ ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } }, base);
    expect(stale.ok, stale.error).toBe(true);
    expect(getConfig().commandAllowlist).toEqual({ enabled: true, mode: 'deny', rules: ['git status', 'git diff *'] });

    const current = getConfig();
    expect((await save({
      ...current, commandAllowlist: { ...current.commandAllowlist, enabled: false }
    }, current)).ok).toBe(true);
    expect(getConfig().commandAllowlist).toEqual({ enabled: false, mode: 'deny', rules: ['git status', 'git diff *'] });
    expect((await save({
      ...getConfig(), commandAllowlist: { enabled: true, mode: 'allow', rules: ['git status; whoami'] }
    }, getConfig())).ok).toBe(false);
  });

  it('preserves a newer unattributed-call choice across an unrelated stale renderer save', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    await saveConfig({
      ...base,
      multiAgent: { ...base.multiAgent, allowUnattributedCalls: true }
    });

    const wanted = { ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } };
    const reply = await save(wanted, base);

    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().ui.minimizeToTray).toBe(!base.ui.minimizeToTray);
    expect(getConfig().multiAgent.allowUnattributedCalls).toBe(true);
  });

  it('preserves a newer agent-tab recovery choice across an unrelated stale renderer save', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    await saveConfig({
      ...base,
      multiAgent: { ...base.multiAgent, recoverAgentTabs: false }
    });

    const wanted = { ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } };
    const reply = await save(wanted, base);

    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().ui.minimizeToTray).toBe(!base.ui.minimizeToTray);
    expect(getConfig().multiAgent.recoverAgentTabs).toBe(false);
  });
});

describe('root namespace invariants', () => {
  it('approves a dropped folder path exactly like the picker, and refuses a dropped file', async () => {
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    await saveConfig({ ...defaultConfig(), roots: [] });
    const folder = path.join(dir, 'dropped-project');
    await fs.mkdir(folder, { recursive: true });
    const file = path.join(dir, 'dropped-file.txt');
    await fs.writeFile(file, 'not a folder');
    const addPath = (payload: unknown): Promise<any> => handlers.get('roots:addPath')!(null, payload) as Promise<any>;

    const added = await addPath({ path: folder });
    expect(added.ok).toBe(true);
    expect(getConfig().roots.map((root) => root.name)).toEqual(['dropped-project']);

    // The drop zone is not a second, weaker approval path: the same validation applies.
    const refused = await addPath({ path: file });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/not a folder/i);
    expect((await addPath({ path: '' })).ok).toBe(false);
    expect(getConfig().roots).toHaveLength(1);
  });

  it('refuses a live rename into the reserved /skills namespace', async () => {
    const base = defaultConfig();
    await saveConfig({
      ...base,
      roots: [
        { name: 'project', path: 'C:\\Users\\example\\project' },
        { name: 'skills-folder', path: 'C:\\Users\\example\\skills-folder' }
      ]
    });

    const reply = await renameRoot({ name: 'project', newName: 'skills' });
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/reserved/i);
    expect(getConfig().roots.map((root) => root.name)).toEqual(['project', 'skills-folder']);
  });

  it('moves live workspace bindings with a root rename and drops them with root removal', async () => {
    const base = defaultConfig();
    await saveConfig({
      ...base,
      roots: [{ name: 'project', path: 'C:\\Users\\example\\project' }]
    });
    setWorkspaceFor('chat:conv-root-change', {
      virtual: '/project/src',
      real: 'C:\\Users\\example\\project\\src'
    });

    const renamed = await renameRoot({ name: 'project', newName: 'repo' });
    expect(renamed.ok, renamed.error).toBe(true);
    expect(workspaceEntries()).toEqual([{ key: 'chat:conv-root-change', virtual: '/repo/src' }]);

    const removed = await removeRoot({ name: 'repo' });
    expect(removed.ok, removed.error).toBe(true);
    expect(workspaceEntries()).toEqual([]);
  });

  it('refuses stale root rename/remove requests instead of reporting a no-op as success', async () => {
    await saveConfig({ ...defaultConfig(), roots: [] });
    const renamed = await renameRoot({ name: 'gone', newName: 'other' });
    expect(renamed.ok).toBe(false);
    expect(renamed.error).toMatch(/not an approved folder/i);
    const removed = await removeRoot({ name: 'gone' });
    expect(removed.ok).toBe(false);
    expect(removed.error).toMatch(/not an approved folder/i);
  });
});

/** Exercise the real IPC policy for both Settings buttons and authored chat links. */
describe('every link the window offers', () => {
  it('is one link:open will actually open', async () => {
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    const html = await fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');

    const offered = [...html.matchAll(/data-link="([^"]+)"/g)].map((match) => match[1]!);
    expect(offered.length, 'the markup offers no links at all — has data-link been renamed?').toBeGreaterThan(0);

    for (const url of offered) expect(await handlers.get('link:open')!(null, { url })).toEqual({ ok: true, data: true });
  });

  it('opens the OpenRouter key page the goal loop sends people to', async () => {
    const open = handlers.get('link:open')!;
    expect(await open(null, { url: 'https://openrouter.ai/settings/keys' })).toEqual({ ok: true, data: true });
    expect(await open(null, { url: 'https://example.com/reference#section' })).toEqual({ ok: true, data: true });
  });

  it.each(['https://example.com/path?q=hello', 'http://localhost:3000/', 'mailto:person@example.com?subject=Hello'])(
    'opens an authored external link: %s', async url => {
      expect(await handlers.get('link:open')!(null, { url })).toEqual({ ok: true, data: true });
      expect(shell.openExternal).toHaveBeenLastCalledWith(url);
    }
  );
  it.each(['javascript:alert(1)', 'data:text/html,hi', 'file:///C:/secret', 'ms-settings:privacy',
    'x-apple.systempreferences:unapproved', 'https://user:password@example.com/', '//example.com/',
    'https:example.com', 'https://example.com/\nfoo', 'mailto:a@example.com?body=%0Ainjected', 'https://example.com/\\path'])(
    'refuses unsafe authored link: %s', async url => {
    const before = vi.mocked(shell.openExternal).mock.calls.length;
    const refused = (await handlers.get('link:open')!(null, { url })) as { ok: boolean; error: string };
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/not allowed/i);
    expect(vi.mocked(shell.openExternal).mock.calls.length).toBe(before);
  });

  it('serializes non-Error throws into a real IPC error string', async () => {
    vi.mocked(shell.openExternal).mockRejectedValueOnce('Windows shell refused the request');
    const reply = (await handlers.get('link:open')!(null, {
      url: 'https://openrouter.ai/settings/keys'
    })) as { ok: boolean; error?: string };
    expect(reply).toEqual({ ok: false, error: 'Windows shell refused the request' });
  });
});

/**
 * The Install button, from the renderer's side of the wire.
 *
 * There is one thing to be sure of here: a press with nothing staged must not quit the app. The
 * button exists because this app is closed to the tray and a quit is rare and deliberate, so a
 * press that closed the window and installed nothing would be worse than no button at all.
 */
describe('installing a downloaded update on request', () => {
  it('refuses, and does not quit, when nothing has been downloaded', async () => {
    const before = quitToInstallCalls;
    const reply = (await handlers.get('update:install')!(null, undefined)) as { ok: boolean; error: string };
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/no downloaded update/i);
    expect(quitToInstallCalls).toBe(before);
  });
});

/**
 * OpenRouter publishes twelve ids that begin with `~` — `~deepseek/deepseek-v4-flash-latest`
 * and its siblings — and they are aliases that always resolve to the newest model in a
 * family. The picker lists them because the catalogue does, so a validator that refused the
 * `~` made the one kind of entry most worth choosing the one kind that could not be saved:
 * the click reported an error and the model in use silently stayed where it was.
 */
describe('the goal model id', () => {
  const withModel = (model: string) => ({ ...settings({ record: false, multiAgent: false }), goal: { ...defaultConfig().goal, model } });

  it('accepts the family aliases OpenRouter marks with a tilde', async () => {
    const reply = await save(withModel('~z-ai/glm-latest'));
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.model).toBe('~z-ai/glm-latest');
  });

  it('still accepts an ordinary pinned id, with or without a variant suffix', async () => {
    expect((await save(withModel('deepseek/deepseek-v4-flash-0731'))).ok).toBe(true);
    expect((await save(withModel('openai/gpt-5.2-mini:nitro'))).ok).toBe(true);
  });

  it('refuses something that is not a model id at all', async () => {
    const reply = await save(withModel('not a model'));
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/vendor\/model/);
  });

  /** The shipped default is one of those aliases, so it has to survive its own validator. */
  it('accepts the default this app ships with', async () => {
    const reply = await save(settings({ record: false, multiAgent: false }));
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.model).toBe(defaultConfig().goal.model);
  });

  it('accepts a bare endpoint id while custom and stores the base URL verbatim', async () => {
    const patch = {
      ...settings({ record: false, multiAgent: false }),
      goal: {
        ...defaultConfig().goal,
        provider: { kind: 'custom' as const, baseUrl: 'http://localhost:11434/v1/' },
        model: 'llama3.1'
      }
    };
    const reply = await save(patch);
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.provider).toEqual({ kind: 'custom', baseUrl: 'http://localhost:11434/v1/' });
    expect(getConfig().goal.model).toBe('llama3.1');
  });

  it('still refuses a bare id while on OpenRouter, and an unknown provider kind', async () => {
    const custom = {
      ...settings({ record: false, multiAgent: false }),
      goal: {
        ...defaultConfig().goal,
        provider: { kind: 'custom' as const, baseUrl: 'http://localhost:11434/v1' },
        model: 'llama3.1'
      }
    };
    // Same model, OpenRouter provider: the vendor/model shape still applies.
    const openrouter = {
      ...custom,
      goal: { ...custom.goal, provider: { kind: 'openrouter' as const, baseUrl: '' } }
    };
    expect((await save(openrouter)).ok).toBe(false);
    const unknown = {
      ...custom,
      goal: { ...custom.goal, provider: { kind: 'own' as never, baseUrl: '' } }
    };
    expect((await save(unknown)).ok).toBe(false);
  });
});

describe('the custom provider key slot', () => {
  const storeSecret = (payload: unknown): Promise<any> =>
    handlers.get('secret:set')!(null, payload) as Promise<any>;

  it('stores a custom key in its own slot and refuses an unnamed one', async () => {
    const prior = await handlers.get('state:get')!(null, undefined) as any;
    const stored = await storeSecret({ value: 'sk-custom-1', key: 'customProviderApiKey' });
    expect(stored.ok, stored.error).toBe(true);
    expect(stored.data.hasCustomProviderKey).toBe(true);
    // The OpenRouter slot is untouched: naming is exact, never a shared bucket.
    expect(stored.data.hasGoalKey).toBe(prior.data.hasGoalKey);
    const cleared = await storeSecret({ value: '', key: 'customProviderApiKey' });
    expect(cleared.ok).toBe(true);
    expect(cleared.data.hasCustomProviderKey).toBe(false);
    const refused = await storeSecret({ value: 'x', key: 'nobodyDefinedThis' });
    expect(refused.ok).toBe(false);
  });
});

describe('the editable goal system prompt', () => {
  it('stores a deliberate custom prompt', async () => {
    const prompt = 'Only continue explicit missing work. Return NO_REPLY when ChatGPT says done.';
    const base = settings({ record: false, multiAgent: false });
    const reply = await save({ ...base, goal: { ...base.goal, prompt } });
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.prompt).toBe(prompt);
  });

  it('refuses blank and unbounded prompts at the renderer boundary', async () => {
    const base = settings({ record: false, multiAgent: false });
    expect((await save({ ...base, goal: { ...base.goal, prompt: '   ' } })).ok).toBe(false);
    expect((await save({ ...base, goal: { ...base.goal, prompt: 'x'.repeat(20_001) } })).ok).toBe(false);
  });

  /**
   * The driver prompt crosses the same boundary as the gate, so it needs the same guards.
   * It used to be a source constant no renderer could reach; now that it is editable, a
   * blank or unbounded value has to be refused here rather than reaching the goal loop.
   */
  it('stores the goal driver prompt and holds it to the same bounds', async () => {
    const objectivePrompt = 'Drive to the goal. NO_REPLY once it is reached.';
    const base = settings({ record: false, multiAgent: false });
    const reply = await save({ ...base, goal: { ...base.goal, objectivePrompt } });
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.objectivePrompt).toBe(objectivePrompt);

    expect((await save({ ...base, goal: { ...base.goal, objectivePrompt: '   ' } })).ok).toBe(false);
    expect(
      (await save({ ...base, goal: { ...base.goal, objectivePrompt: 'x'.repeat(20_001) } })).ok
    ).toBe(false);
  });
});

describe('session IPC contracts', () => {
  it('projects absent live activity without persisting the runtime deadline', async () => {
    const { observeSessionModel, getSession } = await import('../src/main/session/store.js');
    const pro = await createSession({ title: 'Idle Pro', conversationId: 'idle-pro-projection' });
    const sol = await createSession({ title: 'Idle Sol', conversationId: 'idle-sol-projection' });
    await observeSessionModel(pro.id, pro.conversationId!, 'gpt-6', Date.now(), 'pro');
    await observeSessionModel(sol.id, sol.conversationId!, 'gpt-5.6', Date.now(), 'medium');
    const reply = await sessionList();
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.data.sessions.find((row: any) => row.id === pro.id).activityExpiresAt).toBeNull();
    expect(reply.data.sessions.find((row: any) => row.id === sol.id).activityExpiresAt).toBeNull();
    expect(await getSession(pro.id)).not.toHaveProperty('activityExpiresAt');
  });

  it('keeps total as the whole session size on an explicit event page', async () => {
    const session = await createSession({ title: 'paged IPC total', conversationId: null });
    for (let index = 0; index < 5; index++) {
      await appendEvent(session.id, {
        time: 10_000 + index,
        source: 'app',
        kind: 'note',
        message: { text: `note-${index}`, truncated: false, chars: 6 }
      });
    }

    const reply = await sessionEvents({ id: session.id, from: 3, limit: 2 });
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.data.events).toHaveLength(2);
    expect(reply.data.total).toBe(5);
  });

  it('does not send pressure rows for sessions it already omitted from the capped list', async () => {
    for (let index = 0; index < 61; index++) {
      await createSession({ title: `list cap ${index}`, conversationId: null });
    }
    const reply = await sessionList();
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.data.sessions).toHaveLength(60);
    expect(reply.data.pressure).toHaveLength(60);
    expect(new Set(reply.data.pressure.map((entry: { id: string }) => entry.id))).toEqual(
      new Set(reply.data.sessions.map((entry: { id: string }) => entry.id))
    );
  });

  it('projects compaction pressure from the current chat context, not session lifetime history', async () => {
    const chatA = 'aaaaaaaa-1111-2222-3333-444444444444';
    const chatB = 'bbbbbbbb-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'reset context pressure', conversationId: chatA });
    await appendEvent(session.id, {
      time: Date.now(),
      source: 'app',
      kind: 'note',
      message: { text: 'x'.repeat(8_000), truncated: false, chars: 8_000 }
    });
    expect(await rebindSession(session.id, chatA, chatB)).toBe(true);

    const reply = await sessionList();
    const listed = reply.data.sessions.find((entry: { id: string }) => entry.id === session.id);
    const pressure = reply.data.pressure.find((entry: { id: string }) => entry.id === session.id);
    expect(listed.estimatedTokens).toBeGreaterThan(0);
    expect(listed.contextTokens).toBe(0);
    expect(pressure.estimated).toBe(0);
    expect(pressure.level).toBe('ok');
  });

  it('blocks and releases the stored conversation, and never a renderer-supplied one', async () => {
    const { isChatBlocked, resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
    resetBlockedChatsForTests();
    const conversationId = 'aaaaaaaa-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'rogue chat', conversationId });

    const blocked = (await handlers.get('sessions:block')!(null, { id: session.id, blocked: true })) as any;
    expect(blocked.ok, blocked.error).toBe(true);
    expect(blocked.data).toEqual([conversationId]);
    expect(isChatBlocked(conversationId)).toBe(true);

    const released = (await handlers.get('sessions:block')!(null, { id: session.id, blocked: false })) as any;
    expect(released.ok, released.error).toBe(true);
    expect(released.data).toEqual([]);
    expect(isChatBlocked(conversationId)).toBe(false);

    // The renderer names a session; it can neither name a conversation nor block a session
    // that has none — the same boundary `sessions:openChat` holds.
    const unattributed = await createSession({ title: 'no conversation', conversationId: null });
    const refused = (await handlers.get('sessions:block')!(null, { id: unattributed.id, blocked: true })) as any;
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/no valid ChatGPT conversation/i);
    resetBlockedChatsForTests();
  });

  it('trusts and untrusts only the stored conversation for strict allowlisting', async () => {
    const { isChatTrusted, resetTrustedChatsForTests } = await import('../src/main/session/trusted-chats.js');
    resetTrustedChatsForTests();
    const conversationId = 'dddddddd-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'trusted chat', conversationId });

    const trusted = (await handlers.get('sessions:trust')!(null, {
      id: session.id, expectedConversationId: conversationId, trusted: true
    })) as any;
    expect(trusted.ok, trusted.error).toBe(true);
    expect(trusted.data).toEqual([conversationId]);
    expect(isChatTrusted(conversationId)).toBe(true);

    const untrusted = (await handlers.get('sessions:trust')!(null, {
      id: session.id, expectedConversationId: conversationId, trusted: false
    })) as any;
    expect(untrusted.ok, untrusted.error).toBe(true);
    expect(untrusted.data).toEqual([]);
    expect(isChatTrusted(conversationId)).toBe(false);

    const unattributed = await createSession({ title: 'no conversation to trust', conversationId: null });
    const refused = (await handlers.get('sessions:trust')!(null, {
      id: unattributed.id, expectedConversationId: conversationId, trusted: true
    })) as any;
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/no valid ChatGPT conversation/i);
    resetTrustedChatsForTests();
  });

  it('refuses direct worker Trust while allowing its prime and stale worker Untrust cleanup', async () => {
    const { isChatTrusted, resetTrustedChatsForTests, setChatTrusted } = await import('../src/main/session/trusted-chats.js');
    resetTrustedChatsForTests();
    const primeConversationId = 'strict-prime-ipc-owner';
    const workerConversationId = 'strict-worker-ipc-owned';
    const primeSession = await createSession({ title: 'strict prime owner', conversationId: primeConversationId });
    const run = spawn({ caller: { conversationId: primeConversationId }, workers: [{ task: 'owned work' }] });
    expect(bindConversation('worker-1', workerConversationId, run.runId)).toBe(true);
    const workerSession = await createSession({
      title: 'strict owned worker',
      conversationId: workerConversationId,
      origin: { kind: 'worker', fromSessionId: primeSession.id, agentId: 'worker-1', task: 'owned work' }
    });

    try {
      const workerTrust = (await handlers.get('sessions:trust')!(null, {
        id: workerSession.id, expectedConversationId: workerConversationId, trusted: true
      })) as any;
      expect(workerTrust.ok).toBe(false);
      expect(workerTrust.error).toMatch(/worker chats cannot be trusted directly/i);
      expect(isChatTrusted(workerConversationId)).toBe(false);

      const primeTrust = (await handlers.get('sessions:trust')!(null, {
        id: primeSession.id, expectedConversationId: primeConversationId, trusted: true
      })) as any;
      expect(primeTrust.ok, primeTrust.error).toBe(true);
      expect(isChatTrusted(primeConversationId)).toBe(true);

      // A pre-fix durable worker bit is not authority anymore, but Untrust must remain usable to
      // clean it up rather than trapping stale state behind the new guard.
      await setChatTrusted(workerConversationId, true);
      const cleanup = (await handlers.get('sessions:trust')!(null, {
        id: workerSession.id, expectedConversationId: workerConversationId, trusted: false
      })) as any;
      expect(cleanup.ok, cleanup.error).toBe(true);
      expect(isChatTrusted(workerConversationId)).toBe(false);
    } finally {
      resetTrustedChatsForTests();
    }
  });

  it('refuses direct Trust for durable worker identity after broker ownership is gone', async () => {
    const { isChatTrusted, resetTrustedChatsForTests } = await import('../src/main/session/trusted-chats.js');
    resetTrustedChatsForTests();
    const workerConversationId = 'strict-worker-durable-only';
    const workerSession = await createSession({
      title: 'durable worker without retained broker owner',
      conversationId: workerConversationId,
      origin: { kind: 'worker', fromSessionId: null, agentId: 'worker-7', task: 'old retained work' }
    });

    const refused = (await handlers.get('sessions:trust')!(null, {
      id: workerSession.id, expectedConversationId: workerConversationId, trusted: true
    })) as any;
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/worker chats cannot be trusted directly/i);
    expect(isChatTrusted(workerConversationId)).toBe(false);
    resetTrustedChatsForTests();
  });

  it('refuses stale trust intent after Compact & Resume rebinds the same session to a new chat', async () => {
    const { isChatTrusted, resetTrustedChatsForTests } = await import('../src/main/session/trusted-chats.js');
    resetTrustedChatsForTests();
    const chatA = '11111111-aaaa-bbbb-cccc-111111111111';
    const chatB = '22222222-aaaa-bbbb-cccc-222222222222';
    const session = await createSession({ title: 'rebound trust', conversationId: chatA });
    expect(await rebindSession(session.id, chatA, chatB)).toBe(true);

    const stale = (await handlers.get('sessions:trust')!(null, {
      id: session.id, expectedConversationId: chatA, trusted: true
    })) as any;
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/moved to another ChatGPT conversation/i);
    expect(isChatTrusted(chatA)).toBe(false);
    expect(isChatTrusted(chatB)).toBe(false);

    const current = (await handlers.get('sessions:trust')!(null, {
      id: session.id, expectedConversationId: chatB, trusted: true
    })) as any;
    expect(current.ok, current.error).toBe(true);
    expect(isChatTrusted(chatB)).toBe(true);
    resetTrustedChatsForTests();
  });

  it('serializes Trust with Compact & Resume so an in-flight stale A action cannot authorize B', async () => {
    const { isChatTrusted, resetTrustedChatsForTests } = await import('../src/main/session/trusted-chats.js');
    resetTrustedChatsForTests();
    const chatA = '12121212-aaaa-bbbb-cccc-121212121212';
    const chatB = '34343434-aaaa-bbbb-cccc-343434343434';
    const session = await createSession({ title: 'trust raced with resume', conversationId: chatA });
    const gate = faultGate();
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args: Parameters<typeof fs.rename>) => {
      await gate.hold();
      return originalRename(...args);
    });
    try {
      const moving = rebindSession(session.id, chatA, chatB, 'handoff-trust-race-0001');
      await gate.entered;
      let trustSettled = false;
      const trusting = (handlers.get('sessions:trust')!(null, {
        id: session.id, expectedConversationId: chatA, trusted: true
      }) as Promise<any>).then((result) => { trustSettled = true; return result; });
      await Promise.resolve();
      expect(trustSettled).toBe(false);

      gate.release();
      expect(await moving).toBe(true);
      const stale = await trusting;
      expect(stale.ok).toBe(false);
      expect(stale.error).toMatch(/moved to another ChatGPT conversation/i);
      expect(isChatTrusted(chatA)).toBe(false);
      expect(isChatTrusted(chatB)).toBe(false);
    } finally {
      gate.release();
      rename.mockRestore();
      resetTrustedChatsForTests();
    }
  });

  it('Untrust on the current resumed row revokes the explicit source instead of leaving inherited authority', async () => {
    const { isChatTrusted, resetTrustedChatsForTests } = await import('../src/main/session/trusted-chats.js');
    const { conversationAccessRefusal } = await import('../src/main/session/conversation-access.js');
    resetTrustedChatsForTests();
    const chatA = '33333333-aaaa-bbbb-cccc-333333333333';
    const chatB = '44444444-aaaa-bbbb-cccc-444444444444';
    const session = await createSession({ title: 'inherited resumed trust', conversationId: chatA });
    getConfig().multiAgent.strictChatAllowlist = true;
    try {
      const trustA = (await handlers.get('sessions:trust')!(null, {
        id: session.id, expectedConversationId: chatA, trusted: true
      })) as any;
      expect(trustA.ok, trustA.error).toBe(true);
      expect(await rebindSession(session.id, chatA, chatB, 'handoff-resume-trust-0001')).toBe(true);
      expect(await conversationAccessRefusal(chatB)).toBeNull();
      expect(isChatTrusted(chatA)).toBe(true);
      expect(isChatTrusted(chatB)).toBe(false);

      const untrustB = (await handlers.get('sessions:trust')!(null, {
        id: session.id, expectedConversationId: chatB, trusted: false
      })) as any;
      expect(untrustB.ok, untrustB.error).toBe(true);
      expect(untrustB.data).toEqual([]);
      expect(isChatTrusted(chatA)).toBe(false);
      expect(isChatTrusted(chatB)).toBe(false);
      expect(await conversationAccessRefusal(chatB)).toMatch(/^CHAT_NOT_TRUSTED:/);
    } finally {
      getConfig().multiAgent.strictChatAllowlist = false;
      resetTrustedChatsForTests();
    }
  });

  it('Release on the current resumed row clears a blocking source without removing its Trust', async () => {
    const { isChatBlocked, resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
    const { isChatTrusted, resetTrustedChatsForTests } = await import('../src/main/session/trusted-chats.js');
    const { conversationAccessRefusal } = await import('../src/main/session/conversation-access.js');
    resetBlockedChatsForTests();
    resetTrustedChatsForTests();
    const chatA = '77777777-aaaa-bbbb-cccc-777777777777';
    const chatB = '88888888-aaaa-bbbb-cccc-888888888888';
    const session = await createSession({ title: 'blocked resumed source', conversationId: chatA });
    getConfig().multiAgent.strictChatAllowlist = true;
    try {
      expect(((await handlers.get('sessions:trust')!(null, {
        id: session.id, expectedConversationId: chatA, trusted: true
      })) as any).ok).toBe(true);
      expect(((await handlers.get('sessions:block')!(null, { id: session.id, blocked: true })) as any).ok).toBe(true);
      expect(await rebindSession(session.id, chatA, chatB, 'handoff-release-block-0001')).toBe(true);
      expect(await conversationAccessRefusal(chatB)).toMatch(/^CHAT_NOT_TRUSTED:/);

      const released = (await handlers.get('sessions:block')!(null, { id: session.id, blocked: false })) as any;
      expect(released.ok, released.error).toBe(true);
      expect(isChatBlocked(chatA)).toBe(false);
      expect(isChatBlocked(chatB)).toBe(false);
      expect(isChatTrusted(chatA)).toBe(true);
      expect(await conversationAccessRefusal(chatB)).toBeNull();
    } finally {
      getConfig().multiAgent.strictChatAllowlist = false;
      resetBlockedChatsForTests();
      resetTrustedChatsForTests();
    }
  });

  it('releases a block when the row that carries its button is deleted', async () => {
    const { isChatBlocked, resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
    resetBlockedChatsForTests();
    const conversationId = 'bbbbbbbb-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'blocked then deleted', conversationId });
    await handlers.get('sessions:block')!(null, { id: session.id, blocked: true });
    expect(isChatBlocked(conversationId)).toBe(true);

    const deleted = (await handlers.get('sessions:delete')!(null, { id: session.id })) as any;
    expect(deleted.ok, deleted.error).toBe(true);
    // Otherwise the conversation stays refused with nothing left in the app to release it.
    expect(isChatBlocked(conversationId)).toBe(false);
  });

  it('removes trust when the row that carries its button is deleted', async () => {
    const { isChatTrusted, resetTrustedChatsForTests } = await import('../src/main/session/trusted-chats.js');
    resetTrustedChatsForTests();
    const conversationId = 'eeeeeeee-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'trusted then deleted', conversationId });
    await handlers.get('sessions:trust')!(null, {
      id: session.id, expectedConversationId: conversationId, trusted: true
    });
    expect(isChatTrusted(conversationId)).toBe(true);

    const deleted = (await handlers.get('sessions:delete')!(null, { id: session.id })) as any;
    expect(deleted.ok, deleted.error).toBe(true);
    expect(isChatTrusted(conversationId)).toBe(false);
    resetTrustedChatsForTests();
  });

  it('deleting a resumed row atomically revokes hidden explicit source trust', async () => {
    const { isChatTrusted, resetTrustedChatsForTests } = await import('../src/main/session/trusted-chats.js');
    const { conversationAccessRefusal } = await import('../src/main/session/conversation-access.js');
    resetTrustedChatsForTests();
    const chatA = '55555555-aaaa-bbbb-cccc-555555555555';
    const chatB = '66666666-aaaa-bbbb-cccc-666666666666';
    const session = await createSession({ title: 'resumed trust deleted', conversationId: chatA });
    getConfig().multiAgent.strictChatAllowlist = true;
    try {
      const trusted = (await handlers.get('sessions:trust')!(null, {
        id: session.id, expectedConversationId: chatA, trusted: true
      })) as any;
      expect(trusted.ok, trusted.error).toBe(true);
      expect(await rebindSession(session.id, chatA, chatB, 'handoff-delete-trust-0001')).toBe(true);
      expect(await conversationAccessRefusal(chatB)).toBeNull();

      const deleted = (await handlers.get('sessions:delete')!(null, { id: session.id })) as any;
      expect(deleted.ok, deleted.error).toBe(true);
      expect(isChatTrusted(chatA)).toBe(false);
      expect(isChatTrusted(chatB)).toBe(false);

      await createSession({ title: 'old source returned', conversationId: chatA });
      expect(await conversationAccessRefusal(chatA)).toMatch(/^CHAT_NOT_TRUSTED:/);
    } finally {
      getConfig().multiAgent.strictChatAllowlist = false;
      resetTrustedChatsForTests();
    }
  });

  it('deleting a resumed row releases a hidden committed source Block', async () => {
    const { isChatBlocked, resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
    resetBlockedChatsForTests();
    const chatA = '99999999-aaaa-bbbb-cccc-999999999999';
    const chatB = 'aaaaaaaa-aaaa-bbbb-cccc-aaaaaaaaaaaa';
    const session = await createSession({ title: 'resumed source block deleted', conversationId: chatA });
    try {
      expect(((await handlers.get('sessions:block')!(null, { id: session.id, blocked: true })) as any).ok).toBe(true);
      expect(isChatBlocked(chatA)).toBe(true);
      expect(await rebindSession(session.id, chatA, chatB, 'handoff-delete-block-0001')).toBe(true);

      const deleted = (await handlers.get('sessions:delete')!(null, { id: session.id })) as any;
      expect(deleted.ok, deleted.error).toBe(true);
      expect(isChatBlocked(chatA)).toBe(false);
      expect(isChatBlocked(chatB)).toBe(false);
    } finally {
      resetBlockedChatsForTests();
    }
  });

  it('preserves the session, Block and Trust when durable trust revocation fails during delete', async () => {
    const { isChatBlocked, resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
    const { isChatTrusted, resetTrustedChatsForTests } = await import('../src/main/session/trusted-chats.js');
    resetBlockedChatsForTests();
    resetTrustedChatsForTests();
    const conversationId = 'abababab-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'policy survives failed delete', conversationId });
    await handlers.get('sessions:trust')!(null, {
      id: session.id, expectedConversationId: conversationId, trusted: true
    });
    await handlers.get('sessions:block')!(null, { id: session.id, blocked: true });
    expect(isChatTrusted(conversationId)).toBe(true);
    expect(isChatBlocked(conversationId)).toBe(true);

    // Block saves on a short delay. Settle it first, and fail only the trust file's save: a
    // one-shot failure on whatever renames next went to a late Block save on slow runners.
    await flushDurable();
    const realRename = fs.rename.bind(fs);
    let failed = false;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!failed && String(to).includes('trusted-chats')) {
        failed = true;
        throw Object.assign(new Error('simulated trust revoke failure'), { code: 'EIO' });
      }
      return realRename(from, to);
    });
    try {
      const deleted = (await handlers.get('sessions:delete')!(null, { id: session.id })) as any;
      expect(deleted.ok).toBe(false);
      expect(deleted.error).toMatch(/simulated trust revoke failure/i);
      expect(isChatTrusted(conversationId)).toBe(true);
      expect(isChatBlocked(conversationId)).toBe(true);
      expect(await getSession(session.id)).not.toBeNull();
      await flushDurable();
    } finally {
      rename.mockRestore();
      resetBlockedChatsForTests();
      resetTrustedChatsForTests();
    }
  });

  it('fences concurrent Trust while session deletion is waiting on its durable revoke', async () => {
    const { isChatTrusted, resetTrustedChatsForTests } = await import('../src/main/session/trusted-chats.js');
    resetTrustedChatsForTests();
    const conversationId = 'cdcdcdcd-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'trust raced with delete', conversationId });
    await handlers.get('sessions:trust')!(null, {
      id: session.id, expectedConversationId: conversationId, trusted: true
    });
    expect(isChatTrusted(conversationId)).toBe(true);

    const gate = faultGate();
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args: Parameters<typeof fs.rename>) => {
      await gate.hold();
      return originalRename(...args);
    });
    try {
      const deleting = handlers.get('sessions:delete')!(null, { id: session.id }) as Promise<any>;
      await gate.entered;

      const racedTrust = (await handlers.get('sessions:trust')!(null, {
        id: session.id, expectedConversationId: conversationId, trusted: true
      })) as any;
      expect(racedTrust.ok).toBe(false);
      expect(racedTrust.error).toMatch(/being deleted/i);

      gate.release();
      const deleted = await deleting;
      expect(deleted.ok, deleted.error).toBe(true);
      expect(await getSession(session.id)).toBeNull();
      expect(isChatTrusted(conversationId)).toBe(false);
    } finally {
      gate.release();
      rename.mockRestore();
      resetTrustedChatsForTests();
    }
  });

  it('fences concurrent Block while session deletion is waiting on filesystem removal', async () => {
    const { isChatBlocked, resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
    resetBlockedChatsForTests();
    const conversationId = 'efefefef-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'block raced with delete', conversationId });
    await handlers.get('sessions:block')!(null, { id: session.id, blocked: true });
    expect(isChatBlocked(conversationId)).toBe(true);

    const gate = faultGate();
    const originalRm = fs.rm.bind(fs);
    const rm = vi.spyOn(fs, 'rm').mockImplementationOnce(async (...args: Parameters<typeof fs.rm>) => {
      await gate.hold();
      return originalRm(...args);
    });
    try {
      const deleting = handlers.get('sessions:delete')!(null, { id: session.id }) as Promise<any>;
      await gate.entered;
      expect(isChatBlocked(conversationId)).toBe(false);

      const racedBlock = (await handlers.get('sessions:block')!(null, {
        id: session.id, blocked: true
      })) as any;
      expect(racedBlock.ok).toBe(false);
      expect(racedBlock.error).toMatch(/being deleted/i);

      gate.release();
      const deleted = await deleting;
      expect(deleted.ok, deleted.error).toBe(true);
      expect(await getSession(session.id)).toBeNull();
      expect(isChatBlocked(conversationId)).toBe(false);
    } finally {
      gate.release();
      rm.mockRestore();
      resetBlockedChatsForTests();
    }
  });

  it('reports the blocked set with every session list, so one paint marks every row', async () => {
    const { resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
    resetBlockedChatsForTests();
    const conversationId = 'cccccccc-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'listed while blocked', conversationId });

    expect((await sessionList()).data.blocked).toEqual([]);
    await handlers.get('sessions:block')!(null, { id: session.id, blocked: true });
    expect((await sessionList()).data.blocked).toEqual([conversationId]);
    resetBlockedChatsForTests();
  });

  it('reports the trusted set with every session list as live access policy', async () => {
    const { resetTrustedChatsForTests } = await import('../src/main/session/trusted-chats.js');
    resetTrustedChatsForTests();
    const conversationId = 'ffffffff-1111-2222-3333-444444444444';
    const session = await createSession({ title: 'listed while trusted', conversationId });

    expect((await sessionList()).data.trusted).toEqual([]);
    await handlers.get('sessions:trust')!(null, {
      id: session.id, expectedConversationId: conversationId, trusted: true
    });
    expect((await sessionList()).data.trusted).toEqual([conversationId]);
    resetTrustedChatsForTests();
  });

  it('opens only the stored conversation URL in Chrome', async () => {
    const session = await createSession({
      title: 'open me',
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    });
    const reply = await handlers.get('sessions:openChat')!(null, { id: session.id }) as any;
    expect(reply.ok, reply.error).toBe(true);
    expect(openInPreferredBrowser).toHaveBeenCalledWith(
      'https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    );

    const unattributed = await createSession({ title: 'no conversation', conversationId: null });
    const refused = await handlers.get('sessions:openChat')!(null, { id: unattributed.id }) as any;
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/no valid ChatGPT conversation/i);
  });
});

describe('renderer pushes after the window is gone', () => {
  it('does not touch a destroyed BrowserWindow, whose members all throw', async () => {
    // Electron keeps the object after the window is destroyed, so the existing `?.` on
    // `getWindow()` never fires: the reference is truthy and reading `.webContents` throws.
    // The log push is the one that matters, because `onLog` listeners run synchronously on
    // the writer's stack — during a quit that turned every teardown log line into a throw
    // inside the teardown step that wrote it.
    const { logInfo } = await import('../src/main/logger.js');
    let touchedWebContents = false;
    const destroyed = {
      isDestroyed: () => true,
      get webContents() {
        touchedWebContents = true;
        throw new Error('Object has been destroyed');
      }
    } as unknown as import('electron').BrowserWindow;

    registerIpc(
      () => destroyed,
      () => {}
    );
    expect(() => logInfo('teardown progress written after the window went away')).not.toThrow();
    expect(touchedWebContents).toBe(false);
  });
});

describe('Stop IPC exact session and turn authority', () => {
  it('requires an explicit current turn and cannot stop a replacement conversation', async () => {
    const invoke = (payload: unknown) => handlers.get('sessions:stopTurn')!(null, payload) as Promise<any>;
    const conversationId = 'f1111111-aaaa-4bbb-8ccc-111111111111';
    const session = await createSession({ title: 'Stop IPC', conversationId });
    await appendEvent(session.id, { time: Date.now(), source: 'app', kind: 'turn_start', turnId: 'ipc-stop-one' });
    expect((await invoke({ id: session.id })).ok).toBe(false);
    expect(await invoke({ id: session.id, expectedTurnId: 'other-turn' })).toMatchObject({ ok: false, error: 'active_turn_changed' });
    // A stored historical start alone cannot authorize stopping a browser turn.
    expect(await invoke({ id: session.id, expectedTurnId: 'ipc-stop-one' })).toMatchObject({ ok: false, error: 'active_turn_changed' });
    await rebindSession(session.id, conversationId, 'f2222222-aaaa-4bbb-8ccc-111111111111');
    expect((await invoke({ id: session.id, expectedTurnId: 'ipc-stop-one' })).ok).toBe(false);
    const missing = await createSession({ title: 'No browser ownership', conversationId: null });
    expect(await invoke({ id: missing.id, expectedTurnId: 'ipc-stop-one' })).toMatchObject({ ok: false, error: 'session_not_recorded' });
  });
});

it('saves a diagnostics report through the renderer channel without personal details', async () => {
  const { flushLogFile, initLogFile, logInfo } = await import('../src/main/logger.js');
  const home = path.join(dir, 'home-jane');
  const clients = path.join(home, 'Acme Clients');
  await fs.mkdir(clients, { recursive: true });
  initLogFile(path.join(dir, 'app.log'));
  logInfo(`tool read rejected: ENOENT, open '${path.join(clients, 'invoice 7.xlsx')}' for jane@example.com`);
  logInfo('bridge: gave up on worker:run-1:worker-2 — the chat this app opened did not report back in time');
  await flushLogFile();
  await createSession({ title: 'Quarterly tax return draft', conversationId: 'diagnostics-report-session' });
  const getPath = app.getPath;
  const target = path.join(dir, 'report.txt');
  (app as { getPath: (name: string) => string }).getPath = (name: string) => name === 'home' ? home : dir;
  vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: target } as never);
  try {
    expect(await handlers.get('diagnostics:saveReport')!(null, undefined)).toEqual({ ok: true, data: { saved: true, name: 'report.txt' } });
  } finally {
    (app as { getPath: typeof getPath }).getPath = getPath;
  }
  const report = await fs.readFile(target, 'utf8');
  expect(report).toContain('# Chat On Steroids diagnostics report');
  expect(report).toContain('did not report back in time');
  expect(report).toMatch(/open '~[\\/]<p:[0-9a-f]{4}>[\\/]<p:[0-9a-f]{4}>\.xlsx'/);
  for (const personal of ['home-jane', 'Acme', 'invoice', 'jane@example.com', 'Quarterly tax return']) expect(report).not.toContain(personal);
  expect(shell.showItemInFolder).toHaveBeenCalledWith(target);
});
