import { GOAL_MARKER_INSTRUCTION } from '../src/shared/goal-templates.js';
import { finishInstruction } from '../src/shared/finish.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { APP_VERSION, BRIDGE_PROTOCOL } from '../src/main/version.js';
import * as browserWake from '../src/main/browser-wake.js';
type Handler = (event: unknown, payload: unknown) => Promise<any>;
const handlers = new Map<string, Handler>();
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: Handler) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) },
  BrowserWindow: class {}, clipboard: {}, dialog: {}, shell: {}, nativeTheme: { themeSource: 'system' },
  app: { getPath: () => '', getVersion: () => '0.0.0', getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (text: string) => Buffer.from(text),
    decryptStringAsync: async (data: Buffer) => ({ result: data.toString(), shouldReEncrypt: false })
  }
}));
vi.mock('../src/main/extension-path.js', () => ({ extensionDir: () => process.cwd() }));
vi.mock('../src/main/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/connection.js')>();
  return { ...actual, connect: async () => {}, getStatus: () => ({ ...actual.getStatus(), state: 'connected' }) };
});
vi.mock('../src/main/browser.js', () => ({ openInPreferredBrowser: async () => 'chrome.exe', isPreferredBrowserRunning: async () => null }));
const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath } = await import('../src/main/secrets.js');
const { initDurableStore, flushDurable, resetDurableForTests, writeDurableNow } = await import('../src/main/durable.js');
const { createSession, rebindSession, initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { registerIpc } = await import('../src/main/ipc.js');
const { bridgePort, startBridge, stopBridge } = await import('../src/main/bridge.js');
const input = await import('../src/main/session/input.js');
const goal = await import('../src/main/goal.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');
let directory: string;
let bearer: string;
const pushed = vi.fn();
async function post(route: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${bridgePort()}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-extension-version': APP_VERSION,
      'x-extension-protocol': String(BRIDGE_PROTOCOL), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as any };
}
beforeAll(async () => {
  directory = await makeTempDir('clf-input-integration-');
  initConfigPath(directory); initSecretsPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig(defaultConfig());
  registerIpc(() => ({ isDestroyed: () => false, webContents: { send: pushed } }) as never, () => undefined);
  await startBridge();
  const paired = await post('/pair', {});
  expect(paired.status).toBe(200);
  bearer = paired.body.token;
});
beforeEach(async () => {
  await writeDurableNow('session-input', []);
  await writeDurableNow('plugin-refresh', []);
  goal.resetGoalStateForTests(); input.resetInputForTests(); pushed.mockClear();
  await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: false } });
});
it('serves staged attachment bytes only to the exact unsent browser input owner', async () => {
  const { stageInputAttachment } = await import('../src/main/session/input-attachments.js');
  const file = await stageInputAttachment({ text: 'Attachment payload' }, new Set());
  const other = await stageInputAttachment({ text: 'Different input' }, new Set([file.id]));
  const row = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto', attachments: [file] });
  const request = { id: row.id, owner: 'document-one', conversationId: null, attachmentId: file.id, offset: 0 };
  expect((await post('/input/attachment', request)).status).toBe(409);
  await post('/input/claim', { id: row.id, owner: request.owner, conversationId: null, requiresAuthorization: true });
  expect((await post('/input/attachment', { ...request, owner: 'document-two' })).status).toBe(409);
  expect((await post('/input/attachment', { ...request, attachmentId: other.id })).status).toBe(409);
  expect(Buffer.from((await post('/input/attachment', request)).body.chunk, 'base64').toString()).toBe('Attachment payload');
  expect((await post('/input/claim', { ...request, authorize: true })).body.ok).toBe(true);
  expect((await post('/input/attachment', request)).status).toBe(409);
});
it('revokes a claimed send via IPC, fences pre-send authorization and records a late exact receipt', async () => {
  const row = message(null, 'goal');
  await input.enqueueInput(row as import('../src/main/session/input.js').InputArgs);
  expect((await post('/input/claim', { id: row.id, owner: 'page', conversationId: null })).body.input).toBeTruthy();
  expect((await post('/input/claim', { id: row.id, owner: 'page', conversationId: null, authorize: true })).body.ok).toBe(true);
  expect((await handlers.get('sessions:cancelInput')!(null, { id: row.id })).ok).toBe(true);
  expect((await post('/input/claim', { id: row.id, owner: 'page', conversationId: null, authorize: true })).body.ok).toBe(false);
  const conversationId = randomUUID();
  await createSession({ title: 'Late receipt', conversationId });
  expect((await post('/input/ack', { id: row.id, owner: 'page', conversationId, messageId: 'native-late' })).body.ok).toBe(true);
  expect((await input.listInputs())[0]).toMatchObject({ state: 'cancelled', historyRecorded: true, messageId: 'native-late' });
});
it('completes only an explicitly temporary planner over HTTP without inventing a conversation id', async () => {
  const controller = new AbortController();
  const answer = input.requestBrowserDecision('Transient plan context', controller.signal, { lifetime: 'temporary-planner' });
  await vi.waitFor(async () => expect(await input.pendingBrowserInputs()).toHaveLength(1));
  const row = (await input.listInputs())[0]!;
  expect((await post('/input/claim', { id: row.id, owner: 'temp-page', conversationId: null, requiresAuthorization: true })).body.input.lifetime).toBe('temporary-planner');
  expect((await post('/input/ack', { id: row.id, owner: 'temp-page', conversationId: null })).body.ok).toBe(true);
  expect((await post('/input/answer', { id: row.id, owner: 'other-page', conversationId: null, response: 'wrong' })).status).toBe(409);
  expect((await post('/input/answer', { id: row.id, owner: 'temp-page', conversationId: null, response: 'Transient plan answer' })).body.ok).toBe(true);
  expect(await answer).toBe('Transient plan answer');
  expect((await input.listInputs())[0]).toMatchObject({ conversationId: null, deliveredSessionId: null, state: 'sent' });
});
afterAll(async () => {
  await stopBridge(); await flushDurable(); resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});
const message = (sessionId: string | null, automation: 'off' | 'goal' | 'loop') => ({
  id: randomUUID(), sessionId, automation, text: 'Complete this request', mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null
});
it.each(['finish', 'after-turn'] as const)('wakes browser delivery after a committed final makes %s input eligible', async mode => {
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Final-boundary wake', conversationId });
  await post('/events', { conversationId, events: [{ kind: 'turn_start', turnId: 'wake-turn', time: Date.now() }] });
  const queued = await input.enqueueInput({ ...message(session.id, 'off'), mode });
  expect(await input.pendingBrowserInputs()).toEqual([]);
  const snapshots: ReturnType<typeof input.pendingBrowserInputs>[] = [];
  const wake = vi.spyOn(browserWake, 'wakeBrowserWork').mockImplementation(() => { snapshots.push(input.pendingBrowserInputs()); });
  try {
    const complete = await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId: 'wake-turn', outcome: 'completed', time: Date.now() + 1 }] });
    expect(complete.status).toBe(200);
    expect(wake).toHaveBeenCalled();
    expect((await Promise.all(snapshots)).some(rows => rows.some(row => row.id === queued.id))).toBe(true);
    // The notification only prompts a read: it must not consume or claim input.
    expect((await input.listInputs()).find(row => row.id === queued.id)?.state).toBe('queued');
  } finally { wake.mockRestore(); }
});
describe('IPC input delivery and Goal control integration', () => {
  it.each([3, 5])('adds the shared %s-minute finish instruction to Astra opening input and excludes other models', async lead => {
    const config = defaultConfig();
    await saveConfig({ ...config, ui: { ...config.ui, finishTool: true, finishLeadMinutes: lead } });
    const request = { ...message(null, 'off'), model: 'gpt-6-pro', reasoningEffort: 'pro' };
    await input.enqueueInput(request as Parameters<typeof input.enqueueInput>[0]);
    const claimed = await input.claimBrowserInput(request.id, 'opening', null);
    expect(claimed?.text).toBe(request.text + '\n\n' + finishInstruction(lead));
    expect((await input.listInputs()).find(row => row.id === request.id)?.text).toBe(request.text);
    await saveConfig(config);
    input.resetInputForTests();
    expect((await input.listInputs()).find(row => row.id === request.id)?.deliveryText).toBe(claimed?.text);
    await input.cancelInput(request.id);

    const ordinary = message(null, 'off');
    await input.enqueueInput(ordinary as Parameters<typeof input.enqueueInput>[0]);
    expect((await input.claimBrowserInput(ordinary.id, 'disabled', null))?.text).toBe(ordinary.text);
    await input.cancelInput(ordinary.id);
    await saveConfig({ ...config, ui: { ...config.ui, finishTool: true, finishLeadMinutes: lead } });
    const sol = { ...message(null, 'off'), model: 'gpt-5.6-sol', reasoningEffort: 'high' };
    await input.enqueueInput(sol as Parameters<typeof input.enqueueInput>[0]);
    expect((await input.claimBrowserInput(sol.id, 'sol', null))?.text).toBe(sol.text);
    await input.cancelInput(sol.id);
    const chat = await createSession({ title: 'Existing native chat', conversationId: randomUUID() });
    const later = message(chat.id, 'off');
    await input.enqueueInput(later as Parameters<typeof input.enqueueInput>[0]);
    expect((await input.claimBrowserInput(later.id, 'later', chat.conversationId))?.text).toBe(later.text);
    await input.cancelInput(later.id);
  });
  it('requires an exact plugin claim and matching schema before a refresh completion', async () => {
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, autoRefreshPlugins: true } });
    const { publishPluginSurface, resetPluginRefreshForTests } = await import('../src/main/plugin-refresh.js');
    resetPluginRefreshForTests();
    const tools = [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: {} } }];
    publishPluginSurface('core', 'Chat On Steroids Core', 'test', 'Synthetic instructions', tools);
    const requests = (await post('/plugin-refresh', { action: 'pending' })).body.requests;
    expect(requests).toHaveLength(1);
    const identity = { id: requests[0].id, appId: 'asdk_app_synthetic' };
    expect((await post('/plugin-refresh', { ...identity, action: 'claim', connectorName: 'Wrong', tools })).body.ok).toBe(false);
    expect((await post('/plugin-refresh', { ...identity, action: 'claim', connectorName: 'Chat On Steroids Core', tools })).body.ok).toBe(false);
    expect((await post('/plugin-refresh', { ...identity, action: 'claim', connectorName: 'Chat On Steroids Core', tools: [{ ...tools[0], description: 'Old declaration' }] })).body.ok).toBe(true);
    expect((await post('/plugin-refresh', { ...identity, action: 'complete', tools: [] })).body.ok).toBe(false);
    expect((await post('/plugin-refresh', { ...identity, action: 'complete', tools, versionId: 'asdk_app_v_synthetic' })).body.ok).toBe(true);
    resetPluginRefreshForTests();
  });
  it('defaults automatic plugin refresh off and revokes an already offered claim without removing the backend', async () => {
    const plugin = await import('../src/main/plugin-refresh.js');
    plugin.resetPluginRefreshForTests();
    await writeDurableNow('plugin-refresh', []);
    const tools = [{ name: 'read', description: 'Current declaration', inputSchema: { type: 'object', properties: {} } }];
    plugin.publishPluginSurface('core', 'Chat On Steroids Core', 'test', '', tools);
    const saved = (await plugin.pendingPluginRefreshes())[0]!;
    expect(saved).toBeDefined();
    expect((await post('/plugin-refresh', { action: 'pending' })).body.requests).toEqual([]);
    expect((await post('/status', { openConversations: [] })).body.pluginRefreshRequests).toEqual([]);
    const configure = (enabled: boolean) => saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, autoRefreshPlugins: enabled } });
    await configure(true);
    expect((await post('/plugin-refresh', { action: 'pending' })).body.requests[0].id).toBe(saved.id);
    expect((await post('/status', { openConversations: [] })).body.pluginRefreshRequests).toHaveLength(1);
    const claim = { action: 'claim', id: saved.id, appId: 'asdk_app_off_on_test', connectorName: 'Chat On Steroids Core', tools: [{ ...tools[0], description: 'Older declaration' }] };
    await configure(false);
    expect((await post('/plugin-refresh', claim)).body).toMatchObject({ ok: false, error: 'automatic_refresh_disabled' });
    await configure(true);
    expect((await post('/plugin-refresh', claim)).body.ok).toBe(true);
    await configure(false);
    // A click already accepted while enabled may still report its real result.
    expect((await post('/plugin-refresh', { ...claim, action: 'complete', tools })).body.ok).toBe(true);
    plugin.resetPluginRefreshForTests();
  });
  it('accepts a manual plugin-refresh terminal state and removes it from browser pickup', async () => {
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, autoRefreshPlugins: true } });
    const { publishPluginSurface, resetPluginRefreshForTests } = await import('../src/main/plugin-refresh.js');
    resetPluginRefreshForTests();
    const tools = [{ name: 'read', description: 'Read current', inputSchema: { type: 'object', properties: {} } }];
    const installed = [{ ...tools[0], description: 'Read old' }];
    publishPluginSurface('core', 'Chat On Steroids Core', 'test', 'Synthetic instructions', tools);
    const request = (await post('/plugin-refresh', { action: 'pending' })).body.requests[0];
    const manual = await post('/plugin-refresh', { ...request, appId: 'asdk_app_synthetic', action: 'manual', connectorName: 'Chat On Steroids Core', tools: installed, error: 'Recreate or republish this custom app.' });
    expect(manual.body.ok).toBe(true);
    expect((await post('/plugin-refresh', { action: 'pending' })).body.requests).toEqual([]);
    resetPluginRefreshForTests();
  });
  it.each(['browser', 'tool'] as const)('records %s receipt text and pixels through the real IPC hook', async (transport) => {
    const { default: sharp } = await import('sharp');
    const { readEvents } = await import('../src/main/session/store.js');
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Receipt integration', conversationId });
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).webp({ lossless: true }).toBuffer();
    const dataUrl = `data:image/webp;base64,${bytes.toString('base64')}`;
    const authored = { ...message(session.id, 'off'), images: [{ name: 'example.webp', dataUrl }] };
    expect((await handlers.get('sessions:send')!(null, authored)).ok).toBe(true);
    expect((await readEvents(session.id)).filter(event => event.kind === 'user_message')).toHaveLength(0);
    if (transport === 'browser') {
      expect((await post('/input/claim', { id: authored.id, owner: 'exact-page', conversationId })).body.input).toBeDefined();
      expect((await post('/input/ack', { id: authored.id, owner: 'exact-page', conversationId, messageId: 'native-message' })).body.ok).toBe(true);
    } else {
      expect(await input.offerToolInput(session.id, conversationId, 'same-request', 0)).toHaveLength(1);
      await input.offerToolInput(session.id, conversationId, 'same-request', Date.now() + 1);
    }
    const rows = (await readEvents(session.id)).filter(event => event.kind === 'user_message');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inputId: authored.id, message: { text: authored.text } });
    const assetId = rows[0]!.kind === 'user_message' ? rows[0]!.assets![0]!.id : '';
    expect((await handlers.get('sessions:image')!(null, { id: session.id, assetId })).data).toBe(dataUrl);
    expect((await input.listInputs()).find(row => row.id === authored.id)?.historyRecorded).toBe(true);
  });
  it('publishes only nonce-bound catalog observations through HTTP and pushes completion', async () => {
    const { pendingChatModelRequest, resetChatModelsForTests } = await import('../src/main/chat-models.js');
    resetChatModelsForTests();
    expect((await handlers.get('chatModels:request')!(null, {})).data.state).toBe('pending');
    const nonce = pendingChatModelRequest()!.nonce;
    const models = [{ id: 'gpt-observed', label: 'GPT Observed', efforts: ['none', 'medium', 'high', 'xhigh'] }];
    expect((await post('/models', { nonce: randomUUID(), models })).status).toBe(409);
    pushed.mockClear();
    expect((await post('/models', { nonce, models })).body.ok).toBe(true);
    expect((await handlers.get('chatModels:get')!(null, {})).data.models).toEqual(models);
    expect(pushed).toHaveBeenCalledWith('state:changed', expect.anything());
    expect((await post('/models', { nonce, models })).status).toBe(409);
  });
  it('releases only the expected actual turn through IPC', async () => {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'End turn control', conversationId });
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, finishTool: true } });
    // The extension's accepted observation route owns live activity, not a durable
    // recorder row alone. Exercise that authority before asking IPC for live controls.
    const first = await post('/events', { conversationId,
      events: [{ kind: 'turn_start', turnId: 'first-held-turn', time: Date.now() }] });
    expect(first.status).toBe(200);
    expect(first.body.sessionId).toBe(session.id);
    const current = await handlers.get('sessions:controls')!(null, { id: session.id });
    expect(current.data).toMatchObject({ activeTurnId: 'first-held-turn', finishHeld: true });
    expect((await handlers.get('sessions:releaseFinish')!(null, { id: session.id, expectedTurnId: 'stale-turn' })).ok).toBe(false);
    const released = await handlers.get('sessions:releaseFinish')!(null, { id: session.id, expectedTurnId: 'first-held-turn' });
    expect(released.data.finishHeld).toBe(false);
    const second = await post('/events', { conversationId,
      events: [{ kind: 'turn_start', turnId: 'second-held-turn', time: Date.now() + 1 }] });
    expect(second.status).toBe(200);
    expect(second.body.sessionId).toBe(session.id);
    expect((await handlers.get('sessions:releaseFinish')!(null, { id: session.id, expectedTurnId: 'first-held-turn' })).ok).toBe(false);
    expect((await handlers.get('sessions:controls')!(null, { id: session.id })).data.finishHeld).toBe(true);
  });
  it('shares selected-chat objectives with the extension and projects objective-only Goal', async () => {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Objective control', conversationId });
    const call = (name: string, extra = {}) => handlers.get(name)!(null, { id: session.id, ...extra });
    await goal.setGoalObjectiveNow(conversationId, 'Legacy objective');
    expect(goal.goalSwitchFor(conversationId)).toMatchObject({ enabled: false, own: false });
    expect((await call('sessions:controls')).data).toMatchObject({ objective: 'Legacy objective', automation: 'goal' });
    const saved = await call('sessions:objective', { text: '  Follow this objective  ', mode: 'loop' });
    expect(saved.ok).toBe(true);
    expect(saved.data).toMatchObject({ objective: 'Follow this objective', automation: 'loop' });
    expect(goal.goalObjectiveFor(conversationId)).toBe('Follow this objective');
    expect(goal.goalSwitchFor(conversationId)).toMatchObject({ enabled: true, mode: 'loop', own: true });
    const extension = await post('/goal/objective', { conversationId, text: 'Updated in browser', mode: 'goal' });
    expect(extension.status).toBe(200);
    expect((await call('sessions:controls')).data).toMatchObject({ objective: 'Updated in browser', automation: 'goal' });
    const destination = randomUUID();
    expect(await rebindSession(session.id, conversationId, destination)).toBe(true);
    expect((await call('sessions:objective', { text: 'Current destination', mode: 'loop' })).data.conversationId).toBe(destination);
    expect(goal.goalObjectiveFor(conversationId)).toBe('Updated in browser');
    const { setChatBlocked } = await import('../src/main/session/blocked-chats.js');
    setChatBlocked(destination, true);
    expect((await call('sessions:objective', { text: 'Forbidden replacement', mode: 'goal' })).error).toBe('chat_blocked');
    expect(goal.goalObjectiveFor(destination)).toBe('Current destination');
    expect((await call('sessions:objective', { text: '', mode: 'goal' })).data).toMatchObject({ objective: '', automation: 'off' });
    expect(goal.goalSwitchFor(destination)).toMatchObject({ enabled: false, mode: 'loop' });
    setChatBlocked(destination, false);
    await goal.registerGoalDecisionChat(destination);
    expect((await call('sessions:objective', { text: 'Not a source', mode: 'goal' })).error).toBe('goal_worker_chat');
  });
  it('controls exact durable sessions and withdraws Goal without sending new input', async () => {
    const id = randomUUID();
    const session = await createSession({ title: 'Controls', conversationId: id });
    const call = (name: string, extra = {}) => handlers.get(name)!(null, { id: session.id, ...extra });
    const before = (await input.listInputs()).length;
    expect((await call('sessions:automation', { automation: 'goal' })).data.automation).toBe('goal');
    expect((await call('sessions:automation', { automation: 'loop' })).data.automation).toBe('loop');
    expect((await call('sessions:automation', { automation: 'off' })).data.automation).toBe('off');
    expect((await input.listInputs()).length).toBe(before);
    const destination = randomUUID();
    expect(await rebindSession(session.id, id, destination)).toBe(true);
    expect((await call('sessions:automation', { automation: 'goal' })).data.conversationId).toBe(destination);
    expect(goal.goalSwitchFor(id).enabled).toBe(false);
    for (const channel of ['sessions:controls', 'sessions:automation', 'sessions:compact', 'sessions:cancelCompaction']) {
      expect((await handlers.get(channel)!(null, { id: randomUUID(), automation: 'goal' })).ok).toBe(false);
    }
  });
  it('rejects a superseded current attachment before changing either control ledger', async () => {
    const store = await import('../src/main/session/store.js');
    const session = await createSession({ title: 'Superseded control fence', conversationId: randomUUID() });
    const proof = vi.spyOn(store, 'conversationWasSuperseded').mockResolvedValue(true);
    try {
      for (const channel of ['sessions:controls', 'sessions:automation', 'sessions:compact', 'sessions:cancelCompaction']) {
        expect((await handlers.get(channel)!(null, { id: session.id, automation: 'goal' })).error).toBe('conversation_superseded');
      }
      expect(goal.goalSwitchFor(session.conversationId!).own).toBe(false);
    } finally { proof.mockRestore(); }
  });
  it('uses one idempotent continuation ticket and permits cancellation while blocked', async () => {
    const { setChatBlocked } = await import('../src/main/session/blocked-chats.js');
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Compact controls', conversationId });
    const first = await handlers.get('sessions:compact')!(null, { id: session.id });
    expect(first.ok).toBe(true);
    expect(first.data.job.token).toBeTruthy();
    const repeated = await handlers.get('sessions:compact')!(null, { id: session.id });
    expect(repeated.data.job.token).toBe(first.data.job.token);
    setChatBlocked(conversationId, true);
    expect((await handlers.get('sessions:compact')!(null, { id: session.id })).error).toBe('chat_blocked');
    expect((await handlers.get('sessions:automation')!(null, { id: session.id, automation: 'goal' })).error).toBe('chat_blocked');
    expect((await handlers.get('sessions:automation')!(null, { id: session.id, automation: 'off' })).ok).toBe(true);
    expect((await handlers.get('sessions:cancelCompaction')!(null, { id: session.id })).ok).toBe(true);
    setChatBlocked(conversationId, false);
  });
  it('fences durable decision helpers from Goal and compaction after reload', async () => {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Decision controls', conversationId });
    await goal.registerGoalDecisionChat(conversationId);
    expect((await handlers.get('sessions:controls')!(null, { id: session.id })).data.blocked).toBe('worker');
    expect((await handlers.get('sessions:automation')!(null, { id: session.id, automation: 'loop' })).error).toBe('worker_goal_disabled');
    expect((await handlers.get('sessions:compact')!(null, { id: session.id })).error).toBe('worker_compaction_disabled');
    expect((await handlers.get('sessions:automation')!(null, { id: session.id, automation: 'off' })).ok).toBe(true);
  });
  it('prepares fresh offline Goal before global activation and preserves authored enqueue identity', async () => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: false, backend: 'templates' } });
    const request = message(null, 'goal');
    await input.enqueueInput(request as Parameters<typeof input.enqueueInput>[0]);
    const claimed = await input.claimBrowserInput(request.id, 'offline-document', null);
    expect(claimed?.text).toBe(request.text + GOAL_MARKER_INSTRUCTION);
    expect((await input.enqueueInput(request as Parameters<typeof input.enqueueInput>[0])).text).toBe(request.text);
    expect((await input.listInputs()).find(row => row.id === request.id)?.deliveryText).toBe(claimed?.text);
    await input.cancelInput(request.id);
    for (const automation of ['off', 'loop'] as const) {
      const manual = message(null, automation);
      await input.enqueueInput(manual as Parameters<typeof input.enqueueInput>[0]);
      expect((await input.claimBrowserInput(manual.id, automation, null))?.text).toBe(manual.text);
      await input.cancelInput(manual.id);
    }
  });
  it('prepares scheduled tool input with the delivery backend and freezes retries across backend changes', async () => {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Scheduled offline', conversationId });
    const request = { ...message(session.id, 'goal'), dueAt: Date.now() + 60000 };
    await input.enqueueInput(request as Parameters<typeof input.enqueueInput>[0]);
    expect(await input.offerToolInput(session.id, conversationId, 'early', 0)).toEqual([]);
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: false, backend: 'templates' } });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(request.dueAt + 1);
    try {
      const offered = await input.offerToolInput(session.id, conversationId, 'first', 0);
      expect(offered[0]?.text).toContain(request.text + GOAL_MARKER_INSTRUCTION);
      await saveConfig(defaultConfig());
      input.resetInputForTests();
      expect(await input.offerToolInput(session.id, conversationId, 'repeat', 0)).toEqual(offered);
    } finally { clock.mockRestore(); }
  });
  it('enables automation only when an existing chat receives input, retiring its old final', async () => {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Input integration', conversationId });
    await goal.setGoalSwitchNow(conversationId, 'goal', true);
    await goal.acceptGoalReplyNow({ conversationId, sessionId: session.id, replyId: 'old-final', turnId: 'old-turn', eventSeq: 1, blocked: false });
    const request = message(session.id, 'loop');
    const enqueued = await handlers.get('sessions:send')!(null, request);
    expect(enqueued.ok).toBe(true);
    expect(goal.goalSwitchFor(conversationId).mode).toBe('goal');
    expect(await input.offerToolInput(session.id, conversationId, 'tool-request', 0)).toHaveLength(1);
    expect(goal.goalSwitchFor(conversationId)).toMatchObject({ mode: 'loop', enabled: true });
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    await goal.setGoalSwitchNow(conversationId, 'loop', false);
    await input.offerToolInput(session.id, conversationId, 'overlapping-request', 0);
    expect(goal.goalSwitchFor(conversationId).enabled).toBe(false);
  });
  it('binds a new chat through HTTP ACK, applies its choice once, and pushes session change', async () => {
    const request = message(null, 'goal');
    await handlers.get('sessions:send')!(null, request);
    const claim = await post('/input/claim', { id: request.id, owner: 'document-owner', conversationId: null });
    expect(claim.body.input.automation).toBe('goal');
    const conversationId = randomUUID();
    const session = await createSession({ title: 'New input', conversationId });
    pushed.mockClear();
    const payload = { id: request.id, owner: 'document-owner', conversationId };
    expect((await post('/input/ack', payload)).body.ok).toBe(true);
    expect(goal.goalSwitchFor(conversationId)).toMatchObject({ enabled: true, mode: 'goal' });
    expect((await input.listInputs()).find(row => row.id === request.id)?.deliveredSessionId).toBe(session.id);
    expect(pushed).toHaveBeenCalledWith('session:changed');
    await goal.setGoalSwitchNow(conversationId, 'goal', false);
    expect((await post('/input/ack', payload)).body.ok).toBe(true);
    expect(goal.goalSwitchFor(conversationId).enabled).toBe(false);
    const wrong = randomUUID();
    expect((await post('/input/ack', { ...payload, conversationId: wrong })).status).toBe(409);
    expect(goal.goalSwitchFor(wrong).own).toBe(false);
  });
  it('retains the opening objective when Off wins before ACK and never overwrites later edits on a mode change', async () => {
    const objective = 'Keep this opening objective while switched off';
    const request = { ...message(null, 'goal'), objective };
    await handlers.get('sessions:send')!(null, request);
    await post('/input/claim', { id: request.id, owner: 'off-before-ack', conversationId: null });
    expect(await input.setInputAutomation(request.id, 'off')).toBe(true);
    const conversationId = randomUUID();
    await createSession({ title: 'Off before first receipt', conversationId });
    const ack = { id: request.id, owner: 'off-before-ack', conversationId };
    expect((await post('/input/ack', ack)).body.ok).toBe(true);
    expect(goal.goalObjectiveFor(conversationId)).toBe(objective);
    expect(goal.goalSwitchFor(conversationId)).toMatchObject({ own: true, enabled: false });
    expect(goal.goalArmedFor(conversationId)).toBe(false);
    const saved = await import('../src/main/durable.js');
    expect(JSON.stringify(await saved.readDurable('goal-objectives'))).toContain(objective);
    await goal.setGoalObjectiveNow(conversationId, 'Later edited objective');
    await input.setInputAutomation(request.id, 'off');
    await post('/input/ack', ack);
    expect(goal.goalObjectiveFor(conversationId)).toBe('Later edited objective');
    expect(goal.goalArmedFor(conversationId)).toBe(false);
  });
});

it.each(['auto', 'finish'] as const)('adds one short reminder to every later Astra %s browser send without changing authored text', async mode => {
  const config = defaultConfig();
  await saveConfig({ ...config, ui: { ...config.ui, finishTool: true, finishLeadMinutes: 3 } });
  const conversationId = randomUUID();
  const chat = await createSession({ title: 'Later Astra delivery', conversationId });
  const t = Date.now();
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-6-pro', reasoningEffort: 'pro', time: t },
    { kind: 'turn_start', turnId: 'previous-astra', time: t },
    { kind: 'turn_end', turnId: 'previous-astra', outcome: 'completed', time: t + 1000 }
  ] });
  const request = { ...message(chat.id, 'off'), mode, afterTurn: true } as Parameters<typeof input.enqueueInput>[0];
  await input.enqueueInput(request);
  const claimed = await input.claimBrowserInput(request.id, 'later-page', conversationId, true);
  expect(claimed?.text).toBe(request.text + '\n\n' + finishInstruction(3));
  expect(claimed?.text).not.toContain('The user just sent');
  input.resetInputForTests();
  const restored = (await input.listInputs()).find(row => row.id === request.id)!;
  expect(restored.text).toBe(request.text);
  expect(restored.deliveryText).toBe(claimed?.text);
  expect(restored.deliveryText?.split(finishInstruction(3))).toHaveLength(2);
  await input.cancelInput(request.id);
  await saveConfig(config);
});

it('retires a late-confirmed cancelled desktop send after two minutes even as the only managed chat', async () => {
  const conversationId = randomUUID();
  const row = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto' });
  expect((await post('/input/claim', { id: row.id, owner: 'cancelled-send-document', conversationId: null })).status).toBe(200);
  await input.cancelInput(row.id);
  expect((await post('/input/ack', { id: row.id, owner: 'cancelled-send-document', conversationId })).status).toBe(200);
  expect((await input.listInputs()).find(item => item.id === row.id)).toMatchObject({ state: 'cancelled', conversationId, deliveredAt: expect.any(Number) });
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 119_000);
  try {
    const before = (await post('/status', { openConversations: [conversationId] })).body;
    expect(before.managedConversations).toContain(conversationId);
    expect(before.retiredConversations).not.toContain(conversationId);
    clock.mockReturnValue(now + 120_001);
    const after = (await post('/status', { openConversations: [conversationId] })).body;
    expect(after.retiredConversations).toContain(conversationId);
    expect(after.closableConversations).toContain(conversationId);
    const session = await createSession({ conversationId, title: 'Resumed conversation' });
    const previous = (await input.listInputs()).find(item => item.id === row.id)!;
    await writeDurableNow('session-input', [previous, { ...previous, id: randomUUID(), sessionId: session.id,
      state: 'sent', createdAt: now + 121_000, deliveredAt: now + 121_000, historyRecorded: true }]);
    input.resetInputForTests(); clock.mockReturnValue(now + 242_001);
    const resumed = (await post('/status', { openConversations: [conversationId] })).body;
    expect(resumed.retiredConversations).not.toContain(conversationId);
    expect(resumed.closableConversations).not.toContain(conversationId);
  } finally { clock.mockRestore(); }
});
