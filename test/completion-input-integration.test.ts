import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { APP_VERSION, BRIDGE_PROTOCOL } from '../src/main/version.js';
type Handler = (event: unknown, payload: unknown) => Promise<any>;
const handlers = new Map<string, Handler>();
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: Handler) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name), on: vi.fn() },
  BrowserWindow: class {}, clipboard: {}, dialog: {}, shell: {}, nativeTheme: { themeSource: 'system' },
  app: { on: vi.fn(), getPath: () => '', getVersion: () => '0.0.0', getAppPath: () => process.cwd(), isPackaged: false },
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
const { initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
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
  directory = await makeTempDir('clf-completion-integration-');
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
afterAll(async () => {
  await stopBridge(); await flushDurable(); resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});

it.each([false, true])('settles the final and sends once after tools drain (owned: %s)', async owned => {
  const { recordToolCall } = await import('../src/main/session/recorder.js');
  const { trackInFlight, emptyEvidence } = await import('../src/main/mcp/call-context.js');
  const { findSessionByConversation, readEvents, getSession } = await import('../src/main/session/store.js');
  const { sessionControlsFor } = await import('../src/main/bridge.js');
  const conversationId = randomUUID(), requestId = randomUUID(), startedAt = Date.now();
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', time: startedAt, model: 'gpt-5-6-pro', reasoningEffort: 'pro' },
    { kind: 'user_message', time: startedAt, messageId: 'question', text: 'Inspect the report' },
    ...(owned ? [{ kind: 'turn_start', time: startedAt + 1, turnId: 'actual-turn' }] : []),
    { kind: 'tool_evidence', time: startedAt + 2, calls: [{ messageId: 'call', tool: 'read', order: 0, answered: false, requestId }] }
  ] });
  await recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'ok' }], outcome: 'ok', durationMs: 1, startedAt, requestId });
  const session = (await findSessionByConversation(conversationId, { requireUnique: true }))!;
  expect((await sessionControlsFor(session.id)).canInject).toBe(true);
  const row = await input.enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'Next check', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
  await trackInFlight({ startedAt, transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
    caller: { conversationId, requestId, transportKey: null } }, async () => {
    expect((await post('/events', { conversationId, events: [{ kind: 'assistant_message', time: startedAt,
      ...(owned ? { turnId: 'actual-turn' } : {}), messageId: 'final', providerMessageId: 'native-final',
      text: 'Complete.', state: 'final', final: true }] })).status).toBe(200);
    expect((await getSession(session.id))?.activeTurnId).toBeNull();
    expect(await input.claimBrowserInput(row.id, 'page', conversationId, true)).toBeNull();
    await recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'late result' }],
      outcome: 'ok', durationMs: 50, startedAt, requestId });
  });
  expect((await sessionControlsFor(session.id)).canInject).toBe(false);
  expect(await input.claimBrowserInput(row.id, 'page', conversationId, true)).not.toBeNull();
  expect(await input.authorizeBrowserInput(row.id, 'page', conversationId)).toBe(true);
  expect(await input.acknowledgeBrowserInput(row.id, 'page', conversationId, 'accepted-next')).toBe(true);
  expect(await input.claimBrowserInput(row.id, 'other-page', conversationId, true)).toBeNull();
  if (!owned) expect(await readEvents(session.id, { kinds: ['turn_end'] })).toEqual([]);
});

it('retires an unowned Pro final immediately across reloads without requiring a later tool result', async () => {
  const { recordToolCall } = await import('../src/main/session/recorder.js');
  const { findSessionByConversation, readEvents } = await import('../src/main/session/store.js');
  const { sessionControlsFor } = await import('../src/main/bridge.js');
  const conversationId = randomUUID(), requestId = randomUUID(), at = Date.now();
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', time: at, model: 'gpt-5-6-pro', reasoningEffort: 'pro' },
    { kind: 'user_message', time: at, messageId: 'report-question', text: 'Prepare the report' },
    { kind: 'tool_evidence', time: at, calls: [{ messageId: 'report-call', tool: 'read', order: 0, answered: false, requestId }] }
  ] });
  await recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'Report material' }],
    outcome: 'ok', durationMs: 1, startedAt: at, requestId });
  const session = (await findSessionByConversation(conversationId, { requireUnique: true }))!;
  expect((await sessionControlsFor(session.id)).canInject).toBe(true);
  const final = { kind: 'assistant_message', time: at + 1, messageId: 'report-final',
    text: 'The report is complete.', state: 'final', final: true };
  for (let reload = 0; reload < 3; reload++) {
    expect((await post('/events', { conversationId, events: [final] })).status).toBe(200);
    expect((await sessionControlsFor(session.id)).canInject).toBe(false);
  }
  expect(await readEvents(session.id, { kinds: ['turn_start', 'turn_end'] })).toEqual([]);
  // A later authored generation must not be consumed by a replay of the old final.
  await post('/events', { conversationId, events: [
    { kind: 'user_message', time: at + 2, messageId: 'next-question', text: 'Now check the next report', authoredNow: true },
    { kind: 'turn_start', time: at + 3, turnId: 'next-generation' }
  ] });
  await post('/events', { conversationId, events: [final] });
  expect((await sessionControlsFor(session.id)).activeTurnId).toBe('next-generation');
});

it.each([false, true])('settles the last injected message from its exact final across restart and admits a new browser message (legacy=%s)', async legacy => {
  const { recordToolCall } = await import('../src/main/session/recorder.js');
  const { trackInFlight, emptyEvidence } = await import('../src/main/mcp/call-context.js');
  const { findSessionByConversation, upsertMessageEvent } = await import('../src/main/session/store.js');
  const conversationId = randomUUID(), requestId = randomUUID(), at = Date.now();
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', time: at, model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    { kind: 'user_message', time: at, messageId: 'question', text: 'Inspect this' },
    { kind: 'turn_start', time: at + 1, turnId: 'injected-turn' },
    { kind: 'tool_evidence', time: at + 2, calls: [{ messageId: 'last-call', tool: 'read', order: 0, answered: false, requestId }] }
  ] });
  const session = (await findSessionByConversation(conversationId, { requireUnique: true }))!;
  const row = await input.enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'One correction', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
  await input.offerToolInput(session.id, conversationId, requestId, at);
  if (legacy) {
    const rows = await input.listInputs();
    const offered = rows.find(entry => entry.id === row.id)!;
    await writeDurableNow('session-input', rows.map(entry => ({ ...entry, toolTurnId: undefined })));
    input.resetInputForTests();
    await upsertMessageEvent(session.id, { kind: 'user_message', source: 'app', time: offered.offeredAt!,
      messageId: `input:${row.id}`, inputId: row.id, inputDelivery: 'offered', message: { text: row.text, chars: row.text.length, truncated: false } });
  }
  await recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'Result with correction' }], outcome: 'ok', durationMs: 1, startedAt: at, requestId });
  expect((await input.listInputs()).find(entry => entry.id === row.id)?.state).toBe('tool');
  await post('/events', { conversationId, events: [{ kind: 'assistant_message', time: Date.now(), turnId: 'injected-turn', messageId: 'interim', text: 'Working on it', final: false }] });
  expect((await input.listInputs()).find(entry => entry.id === row.id)?.state).toBe('tool');
  await trackInFlight({ startedAt: at, transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
    caller: { conversationId, requestId, transportKey: null } }, async () => {
    await post('/events', { conversationId, events: [
      { kind: 'assistant_message', time: Date.now(), turnId: 'injected-turn', messageId: 'final', text: 'Finished.', state: 'final', final: true },
      { kind: 'turn_end', time: Date.now(), turnId: 'injected-turn', outcome: 'completed' }
    ] });
    expect((await input.listInputs()).find(entry => entry.id === row.id)?.state).toBe('tool');
  });
  input.resetInputForTests();
  expect((await input.listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'sent', messageId: `input:${row.id}` });
  const followup = await input.enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'Next task', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
  expect(await input.claimBrowserInput(followup.id, 'page', conversationId, true)).not.toBeNull();
});
