import { GOAL_MARKER_INSTRUCTION } from '../src/shared/goal-templates.js';
import { currentCoreInstructions } from '../src/main/mcp/instructions.js';
import { prependUserPrompt, userPromptText } from '../src/shared/user-prompt.js';
import { finishInstruction } from '../src/shared/finish.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { addProject, assignSessionProject } from '../src/main/projects.js';
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
it('refreshes account models after an owned picker failure without authorizing another tab', async () => {
  const catalog = await import('../src/main/chat-models.js');
  catalog.resetChatModelsForTests();
  const row = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto' });
  await post('/input/claim', { id: row.id, owner: 'picker-page', conversationId: null });
  const failure = { id: row.id, owner: 'foreign-page', error: 'Requested model or reasoning could not be confirmed' };
  expect((await post('/input/fail', failure)).body.ok).toBe(false);
  expect(catalog.pendingChatModelRequest()).toBeNull();
  expect((await post('/input/fail', { ...failure, owner: 'picker-page' })).body.ok).toBe(true);
  expect(catalog.pendingChatModelRequest()).toMatchObject({ allowOpen: false });
  expect(pushed).toHaveBeenCalledWith('chatModels:changed', expect.objectContaining({ state: 'pending' }));
  expect((await input.listInputs()).find(input => input.id === row.id)?.state).toBe('failed');
  catalog.resetChatModelsForTests();
});

it.each([false, true])('collects an exact recorded helper final across document loss (final before ACK: %s)', async finalBeforeAck => {
  const controller = new AbortController();
  const helper = randomUUID();
  await createSession({ title: 'Decision helper', conversationId: helper });
  const answer = input.requestBrowserDecision('Choose the next action', controller.signal, { conversationId: helper });
  void answer.catch(() => undefined);
  try {
    const [row] = await input.listInputs();
    expect((await post('/input/claim', { id: row!.id, owner: 'lost-document', conversationId: helper })).body.input.text).toBe('Choose the next action');
    const final = () => post('/events', { conversationId: helper, events: [
      { kind: 'user_message', messageId: 'decision-user', text: 'Choose the next action', time: Date.now() },
      { kind: 'assistant_message', messageId: 'decision-final', turnId: 'decision-turn', text: '{"next":"continue"}',
        state: 'final', final: true, goalEligible: true, time: Date.now() }
    ] });
    if (finalBeforeAck) expect((await final()).status).toBe(200);
    expect((await post('/input/ack', { id: row!.id, owner: 'lost-document', conversationId: helper, messageId: 'decision-user' })).body.ok).toBe(true);
    if (!finalBeforeAck) expect((await final()).status).toBe(200);
    expect((await input.listInputs()).find(entry => entry.id === row!.id)).toMatchObject({ state: 'sent', response: '{"next":"continue"}' });
    await expect(answer).resolves.toBe('{"next":"continue"}');
    expect(await input.pendingBrowserInputs()).toEqual([]);
  } finally { controller.abort(); await answer.catch(() => undefined); }
});

it('does not pin an idle chat to tool transport because another call is unattributed', async () => {
  const { trackInFlight, emptyEvidence } = await import('../src/main/mcp/call-context.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Completed target', conversationId });
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-5.6-sol', time: Date.now() },
    { kind: 'turn_start', turnId: 'completed-before-input', time: Date.now() },
    { kind: 'turn_end', turnId: 'completed-before-input', outcome: 'completed', time: Date.now() }
  ] });
  let row!: import('../src/main/session/input.js').InputEntry;
  await trackInFlight({ startedAt: Date.now(), transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
    caller: { requestId: null, transportKey: null, conversationId: null } }, async () => {
    row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto' });
    expect(row.transportIntent).toBeUndefined();
    expect((await input.sessionInputPolicy(session.id)).canInject).toBe(false);
    expect(await input.claimBrowserInput(row.id, 'fresh-document', conversationId)).toBeNull();
  });
  expect(await input.claimBrowserInput(row.id, 'fresh-document', conversationId)).not.toBeNull();
});

it('projects and delivers a direct correction through the real recorder, bridge claim and native receipt', async () => {
  const { sessionControlsFor } = await import('../src/main/bridge.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Tool-free correction', conversationId });
  const time = Date.now();
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-5.6-sol', reasoningEffort: 'high', time },
    { kind: 'user_message', messageId: 'plain-user', text: 'Explain the idea without tools', time },
    { kind: 'turn_start', turnId: 'plain-turn', time: time + 1 }
  ] });
  expect(await sessionControlsFor(session.id)).toMatchObject({ canInject: false, canSendDirectly: true });
  const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto' });
  expect(row.directTurn?.id).toBe('plain-turn');
  const claim = await post('/input/claim', { id: row.id, owner: 'direct-page', conversationId, requiresAuthorization: true });
  expect(claim.body.input).toMatchObject({ id: row.id, directTurn: { id: 'plain-turn' } });
  await post('/events', { conversationId, events: [
    { kind: 'turn_end', turnId: 'plain-turn', outcome: 'stopped', time: time + 2 }
  ] });
  expect((await post('/input/claim', { id: row.id, owner: 'direct-page', conversationId, authorize: true })).body.ok).toBe(true);
  expect((await post('/input/ack', { id: row.id, owner: 'direct-page', conversationId, messageId: 'direct-user' })).body.ok).toBe(true);
  expect((await input.listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'sent', messageId: 'direct-user' });
});

async function attributedMcp(conversationId: string): Promise<void> {
  const requestId = randomUUID();
  await post('/events', { conversationId, events: [{ kind: 'tool_evidence', time: Date.now(),
    calls: [{ messageId: randomUUID(), tool: 'read', order: 0, answered: false, requestId }] }] });
  const { recordToolCall } = await import('../src/main/session/recorder.js');
  await recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'Fixture result' }],
    outcome: 'ok', durationMs: 1, startedAt: Date.now(), requestId });
}

describe.each(['input', 'loop'] as const)('MCP admission for %s recovery', destination => {
  describe.each(['silence', 'thinking_failed'] as const)('%s boundary', boundary => {
    it.each(['none', 'previous-turn', 'native-tool', 'request-only', 'current-turn'] as const)(
      'requires an actual attributed call in this turn (%s)', async evidence => {
      const bridge = await import('../src/main/bridge.js');
      let now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const conversationId = randomUUID();
        const session = await createSession({ title: 'Recovery MCP admission', conversationId });
        await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, mode: 'loop', loopBackend: 'chatgpt' } });
        if (destination === 'loop') await goal.setGoalSwitchNow(conversationId, 'loop', true, true);
        if (evidence === 'previous-turn') {
          await post('/events', { conversationId, events: [{ kind: 'turn_start', turnId: 'previous-mcp-turn', time: now }] });
          await attributedMcp(conversationId);
          await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId: 'previous-mcp-turn', outcome: 'stopped', time: now }] });
          now++;
        }
        await post('/events', { conversationId, events: [
          { kind: 'model_selection', model: 'gpt-6-pro', reasoningEffort: 'pro', time: now },
          { kind: 'user_message', messageId: 'new-user', text: 'Fixture task', time: now },
          { kind: 'turn_start', turnId: 'current-turn', time: now }
        ] });
        const row = destination === 'input' ? await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' }) : null;
        if (evidence === 'current-turn') await attributedMcp(conversationId);
        if (evidence === 'native-tool') await post('/events', { conversationId, events: [
          { kind: 'page_tool', turnId: 'current-turn', messageId: 'native-tool', label: 'Used container tool', time: now }
        ] });
        if (evidence === 'request-only') await post('/events', { conversationId, events: [
          { kind: 'tool_evidence', time: now, calls: [{ messageId: 'request-sighting', tool: 'read', order: 0, answered: false, requestId: randomUUID() }] }
        ] });
        if (boundary === 'silence') {
          now += bridge.PRO_SILENCE_MS + 1;
          await bridge.sweepStaleSwarm(now);
          const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs.find((item: any) => item.conversationId === conversationId);
          expect(repair).toBeDefined(); // Reload remains allowed even without MCP.
          await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
        } else {
          now += 330_000;
          await post('/events', { conversationId, events: [
            { kind: 'turn_end', turnId: 'current-turn', outcome: 'failed', reason: 'thinking_failed', time: now }
          ] });
        }
        const eligible = evidence === 'current-turn';
        if (row) {
          input.resetInputForTests();
          expect((await input.listInputs()).find(item => item.id === row.id)?.silenceBoundary !== undefined).toBe(eligible);
          expect((await input.pendingBrowserInputs()).some(item => item.id === row.id)).toBe(eligible);
          expect(!!(await post('/input/claim', { id: row.id, owner: 'page', conversationId, requiresAuthorization: true })).body.input).toBe(eligible);
        } else {
          goal.restoreGoalReplies(goal.snapshotGoalReplies());
          expect(goal.goalPendingReplyFor(conversationId) !== null).toBe(eligible);
        }
      } finally { clock.mockRestore(); }
    });
  });
});

it.each(['gpt-6-pro', 'gpt-5.6-sol'])('carries settled Thinking failed through HTTP, recording and one queued send (%s)', async model => {
  const { readEvents } = await import('../src/main/session/store.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Native failure queue', conversationId });
  const time = Date.now();
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model, time },
    { kind: 'turn_start', turnId: 'native-failed-turn', time }
  ] });
  const first = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn', afterTurn: true });
  const second = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn', afterTurn: true });
  await attributedMcp(conversationId);
  await post('/events', { conversationId, events: [
    { kind: 'chat_error', turnId: 'native-failed-turn', text: 'Thinking failed', recoverable: false, time: Date.now() }
  ] });
  expect(await input.pendingBrowserInputs()).toEqual([]);
  // Content-script tests prove the actual 30s + 5m boundary. This is its wire result.
  const end = { kind: 'turn_end', turnId: 'native-failed-turn', outcome: 'failed', reason: 'thinking_failed', detail: 'Thinking failed', time: Date.now() + 1 };
  expect((await post('/events', { conversationId, events: [end] })).status).toBe(200);
  expect((await readEvents(session.id, { kinds: ['turn_end'] })).at(-1)).toMatchObject({ reason: 'thinking_failed', outcome: 'failed' });
  const pro = model === 'gpt-6-pro';
  expect(await input.pendingBrowserInputs()).toEqual([{ id: first.id, conversationId, ...(pro ? { silenceTurnId: 'native-failed-turn' } : {}) }]);
  const clock = vi.spyOn(Date, 'now');
  try {
    if (pro) {
      const busyAt = Date.now();
      clock.mockReturnValue(busyAt);
      expect((await post('/input/claim', { id: first.id, owner: 'failed-turn-page', conversationId, silenceBusyTurnId: 'native-failed-turn' })).body.ok).toBe(true);
      input.resetInputForTests();
      clock.mockReturnValue(busyAt + 5 * 60_000 - 1);
      expect(await input.pendingBrowserInputs()).toEqual([]);
      expect((await post('/input/claim', { id: first.id, owner: 'failed-turn-page', conversationId, requiresAuthorization: true })).body.input).toBeNull();
      clock.mockReturnValue(busyAt + 5 * 60_000);
      expect(await input.pendingBrowserInputs()).toHaveLength(1);
    }
    const claim = await post('/input/claim', { id: first.id, owner: 'failed-turn-page', conversationId, requiresAuthorization: true });
    expect(claim.body.input).toMatchObject({ id: first.id, completedTurnId: 'native-failed-turn' });
    expect((await post('/input/claim', { id: first.id, owner: 'failed-turn-page', conversationId, authorize: true })).body.ok).toBe(true);
    expect((await post('/input/ack', { id: first.id, owner: 'failed-turn-page', conversationId, messageId: 'queued-next-user' })).body.ok).toBe(true);
    input.resetInputForTests();
    await post('/events', { conversationId, events: [end] });
    expect(await input.pendingBrowserInputs()).toEqual([]);
    expect((await input.listInputs()).find(row => row.id === second.id)?.state).toBe('queued');
  } finally { clock.mockRestore(); }
});

it('refuses restored recovery tickets without MCP proof but still delivers a real final', async () => {
  const { readRecentEvents } = await import('../src/main/session/store.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Restored recovery admission', conversationId });
  await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, mode: 'loop', loopBackend: 'chatgpt' } });
  await goal.setGoalSwitchNow(conversationId, 'loop', true, true);
  const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-6-pro', time: Date.now() },
    { kind: 'turn_start', turnId: 'restored-turn', time: Date.now() }
  ] });
  const [start] = await readRecentEvents(session.id, 1);
  await writeDurableNow('session-input', [{ ...row, silenceBoundary: { turnId: 'restored-turn', conversationId, workSeq: start!.seq } }]);
  input.resetInputForTests();
  goal.restoreGoalReplies({ version: 1, savedAt: Date.now(), replies: [{ conversationId, sessionId: session.id,
    replyId: 'silence:restored', turnId: 'g-silence-restored', silenceSourceTurnId: 'restored-turn', silencePro: true,
    eventSeq: start!.seq, acceptedAt: Date.now(), state: 'pending' }] });
  expect(await input.pendingBrowserInputs()).toEqual([]);
  expect((await post('/input/claim', { id: row.id, owner: 'page', conversationId, requiresAuthorization: true })).body.input).toBeNull();
  expect((await post('/goal/draft', { conversationId, turnId: 'g-silence-restored', terminalRequired: true })).status).toBe(409);
  await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId: 'restored-turn', outcome: 'completed', time: Date.now() + 1 }] });
  expect((await post('/input/claim', { id: row.id, owner: 'page', conversationId, requiresAuthorization: true })).body.input?.id).toBe(row.id);
});

it('does not turn generic failed/error prose or an unknown wire reason into queue authority', async () => {
  const { readEvents } = await import('../src/main/session/store.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Unclassified failure', conversationId });
  await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn', afterTurn: true });
  await post('/events', { conversationId, events: [
    { kind: 'turn_start', turnId: 'unclassified', time: Date.now() },
    { kind: 'turn_end', turnId: 'unclassified', outcome: 'failed', reason: 'unrecognized', detail: 'Thinking failed', time: Date.now() + 1 }
  ] });
  expect((await readEvents(session.id, { kinds: ['turn_end'] })).at(-1)).not.toHaveProperty('reason');
  expect(await input.pendingBrowserInputs()).toEqual([]);
});

it.each(['open', 'stalled', 'final-during-listen', 'failure-during-listen'])('files one durable after-turn ticket only after the silence refresh ACK (%s)', async boundary => {
  const bridge = await import('../src/main/bridge.js');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Silent Pro', conversationId });
    const first = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
    await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-6-pro', reasoningEffort: 'pro', time: now },
      { kind: 'user_message', messageId: 'silence-user', text: 'Continue the task', time: now },
      { kind: 'turn_start', turnId: 'silence-turn', time: now }
    ] });
    await attributedMcp(conversationId);
    now += bridge.PRO_SILENCE_MS - 1;
    await bridge.sweepStaleSwarm(now);
    expect(await input.pendingBrowserInputs()).toEqual([]);
    now += 2;
    if (boundary === 'stalled') await post('/events', { conversationId, events: [
      { kind: 'turn_end', turnId: 'silence-turn', outcome: 'stalled', time: now }
    ] });
    await bridge.sweepStaleSwarm(now);
    const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs.find((row: any) => row.conversationId === conversationId);
    expect(repair).toBeDefined();
    expect(await input.pendingBrowserInputs()).toEqual([]);
    await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
    expect((await input.listInputs()).find(row => row.id === first.id)?.silenceBoundary?.turnId).toBe('silence-turn');
    input.resetInputForTests();
    expect(await input.pendingBrowserInputs()).toEqual([expect.objectContaining({ id: first.id, silenceTurnId: 'silence-turn' })]);
    const claim = { id: first.id, owner: 'refreshed-page', conversationId };
    expect((await post('/input/claim', { ...claim, silenceBusyTurnId: 'silence-turn' })).body.ok).toBe(true);
    expect(await input.pendingBrowserInputs()).toEqual([]);
    if (boundary === 'final-during-listen' || boundary === 'failure-during-listen') {
      now++;
      await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId: 'silence-turn', time: now,
        ...(boundary === 'final-during-listen' ? { outcome: 'completed' } : { outcome: 'failed', reason: 'thinking_failed' }) }] });
    }
    if (boundary !== 'final-during-listen') {
      const until = (await input.listInputs()).find(row => row.id === first.id)!.silenceBoundary!.listenUntil!;
      now = until - 1;
      expect((await post('/input/claim', { ...claim, requiresAuthorization: true })).body.input).toBeNull();
      now++;
    }
    expect(await input.pendingBrowserInputs()).toHaveLength(1);
    expect((await post('/input/claim', { ...claim, requiresAuthorization: true })).body.input?.id).toBe(first.id);
    expect((await post('/input/fail', { ...claim, error: 'After-turn pickup was withdrawn before Send.' })).body.ok).toBe(true);
    input.resetInputForTests();
    expect(await input.pendingBrowserInputs()).toHaveLength(1);
    expect((await post('/input/claim', { ...claim, requiresAuthorization: true })).body.input?.id).toBe(first.id);
    expect((await post('/input/claim', { ...claim, authorize: true })).body.ok).toBe(true);
    expect((await input.listInputs()).find(row => row.id === first.id)?.state).toBe('browser');
    expect((await post('/input/ack', { ...claim, messageId: 'accepted-next' })).body.ok).toBe(true);
    input.resetInputForTests();
    expect(await input.pendingBrowserInputs()).toEqual([]);
  } finally { clock.mockRestore(); }
});

it.each(['queued', 'claimed', 'tool', 'settled-failure'])('withdraws a silence ticket on new work and rearms refresh (%s)', async change => {
  const bridge = await import('../src/main/bridge.js');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Resumed Pro', conversationId });
    const first = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-6-pro', time: now },
      { kind: 'user_message', messageId: 'resume-user', text: 'Continue', time: now },
      { kind: 'turn_start', turnId: 'resume-turn', time: now }
    ] });
    await attributedMcp(conversationId);
    now += bridge.PRO_SILENCE_MS + 1;
    await bridge.sweepStaleSwarm(now);
    const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs.find((row: any) => row.conversationId === conversationId);
    expect(repair).toBeDefined();
    await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
    const claim = { id: first.id, owner: 'resume-page', conversationId };
    if (change === 'claimed' || change === 'tool') expect((await post('/input/claim', { ...claim, requiresAuthorization: true })).body.input?.id).toBe(first.id);
    if (change === 'settled-failure') await post('/events', { conversationId, events: [
      { kind: 'turn_end', turnId: 'resume-turn', outcome: 'failed', reason: 'thinking_failed', time: now }
    ] });
    now += 1_000;
    if (change === 'tool') {
      const { recordToolCall } = await import('../src/main/session/recorder.js');
      await recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'Read complete' }],
        outcome: 'ok', durationMs: 1, startedAt: now, requestId: 'silence-resumed-call', conversationId });
    } else await post('/events', { conversationId, events: [
      { kind: 'assistant_message', turnId: 'resume-turn', messageId: 'new-interim', text: 'Still working', state: 'streaming', activeNow: true, time: now }
    ] });
    expect((await input.listInputs()).find(row => row.id === first.id)).toMatchObject({ state: 'queued', owner: null });
    expect((await input.listInputs()).find(row => row.id === first.id)?.silenceBoundary).toBeUndefined();
    expect((await post('/input/claim', { ...claim, authorize: true })).body.ok).toBe(false);
    expect(await input.pendingBrowserInputs()).toEqual([]);
    now += bridge.PRO_SILENCE_MS - 1;
    await bridge.sweepStaleSwarm(now);
    expect((await post('/status', { openConversations: [conversationId] })).body.repairs.filter((row: any) => row.conversationId === conversationId)).toEqual([]);
    now += 2;
    await bridge.sweepStaleSwarm(now);
    expect((await post('/status', { openConversations: [conversationId] })).body.repairs.some((row: any) => row.conversationId === conversationId)).toBe(true);
  } finally { clock.mockRestore(); }
});

it.each(['different-user', 'streaming', 'cancelled', 'different-chat'])(
  'refuses a recorded helper result with %s evidence', async condition => {
    const controller = new AbortController();
    const helper = randomUUID();
    await createSession({ title: 'Exact helper', conversationId: helper });
    const answer = input.requestBrowserDecision('Choose the next action', controller.signal, { conversationId: helper });
    void answer.catch(() => undefined);
    try {
      const [row] = await input.listInputs();
      await post('/input/claim', { id: row!.id, owner: 'original-document', conversationId: helper });
      await post('/input/ack', { id: row!.id, owner: 'original-document', conversationId: helper, messageId: 'accepted-user' });
      if (condition === 'cancelled') { controller.abort(); await answer.catch(() => undefined); }
      const conversationId = condition === 'different-chat' ? randomUUID() : helper;
      await post('/events', { conversationId, events: [
        { kind: 'user_message', messageId: condition === 'different-user' ? 'foreign-user' : 'accepted-user', text: 'Choose the next action', time: Date.now() },
        { kind: 'assistant_message', messageId: 'candidate-final', turnId: 'candidate-turn', text: 'candidate',
          state: condition === 'streaming' ? 'streaming' : 'final', final: condition !== 'streaming', time: Date.now() }
      ] });
      expect((await input.listInputs()).find(entry => entry.id === row!.id)?.state).toBe(condition === 'cancelled' ? 'cancelled' : 'decision');
    } finally { controller.abort(); await answer.catch(() => undefined); }
  });
it('freezes image injection from staged originals with replay, receipt, and browser isolation', async () => {
  const { default: sharp } = await import('sharp');
  const { stageInputAttachment } = await import('../src/main/session/input-attachments.js');
  const { readEvents } = await import('../src/main/session/store.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Staged image injection', conversationId });
  const bytes = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#123456' } }).png().toBuffer();
  const attachment = await stageInputAttachment({ name: 'full-resolution.png', bytes }, new Set());
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-6-astra', time: Date.now() },
    { kind: 'turn_start', turnId: 'image-turn', time: Date.now() }
  ] });
  const authored = { ...message(session.id, 'off'), mode: 'auto' as const, attachments: [attachment], attachmentDelivery: 'tool' as const };
  const result = await handlers.get('sessions:send')!(null, authored);
  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({ attachments: [attachment], attachmentDelivery: 'tool', transportIntent: 'tool' });
  const dataUrl = result.data.toolImages[0].dataUrl;
  expect(await sharp(Buffer.from(dataUrl.split(',')[1], 'base64')).metadata()).toMatchObject({ width: 1600, height: 800 });
  input.resetInputForTests();
  expect((await handlers.get('sessions:send')!(null, authored)).data.toolImages[0].dataUrl).toBe(dataUrl);
  expect(await input.pendingBrowserInputs()).toEqual([]);
  expect(await input.claimBrowserInput(authored.id, 'page', conversationId)).toBeNull();
  expect((await input.offerToolInput(session.id, randomUUID(), 'wrong', 0)).messages).toEqual([]);
  expect(await input.hasEligibleToolInput(session.id)).toBe(true);
  const offered = await input.offerToolInput(session.id, conversationId, 'request', 0);
  expect(offered.messages[0]!.images[0]!.dataUrl).toBe(dataUrl);
  expect(await input.offerToolInput(session.id, conversationId, 'same-concurrent-request', 0)).toEqual(offered);
  await input.acknowledgeToolInput(session.id, conversationId, 'later-request', Date.now() + 1);
  expect((await input.listInputs())[0]!.state).toBe('sent');
  const history = (await readEvents(session.id)).filter(event => event.kind === 'user_message');
  expect(history).toHaveLength(1);
  expect(history[0]!.attachments).toBeUndefined();
  expect(history[0]!.assets).toHaveLength(1);
  // Explicit Inject never silently converts into a separate native message on final.
  const second = await input.enqueueInput({ ...authored, id: randomUUID() });
  await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId: 'image-turn', outcome: 'completed', time: Date.now() + 2 }] });
  expect(await input.pendingBrowserInputs()).toEqual([]);
  expect(await input.claimBrowserInput(second.id, 'page', conversationId)).toBeNull();
  await expect(input.enqueueInput({ ...authored, id: randomUUID() })).rejects.toThrow('active chat');
});

it('rejects image admission when the session changes during normalization', async () => {
  const attachments = await import('../src/main/session/input-attachments.js');
  const { default: sharp } = await import('sharp');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Image preparation race', conversationId });
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-6-astra', time: Date.now() },
    { kind: 'turn_start', turnId: 'image-race-turn', time: Date.now() }
  ] });
  const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#123456' } }).png().toBuffer();
  const file = await attachments.stageInputAttachment({ name: 'race.png', bytes }, new Set());
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const normalize = attachments.normalizeInputAttachments;
  const held = vi.spyOn(attachments, 'normalizeInputAttachments').mockImplementation(async files => { await gate; return normalize(files); });
  try {
    const pending = input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto', attachments: [file], attachmentDelivery: 'tool' });
    const rejected = expect(pending).rejects.toThrow('active chat changed');
    await vi.waitFor(() => expect(held).toHaveBeenCalled());
    await rebindSession(session.id, conversationId, randomUUID());
    release(); await rejected;
    expect(await input.listInputs()).toEqual([]);
  } finally { release(); held.mockRestore(); }
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
  expect((await post('/input/claim', { id: row.id, owner: 'temp-page', conversationId: null, requiresAuthorization: true })).body.input.text).toBe('Transient plan context');
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
it('freezes the complete current prompt for each new chat and leaves the authored input intact', async () => {
  const config = defaultConfig();
  const standing = 'ä 🐱 Complete standing guidance\n'.repeat(100) + 'FINAL_STANDING_MARKER';
  await saveConfig({ ...config, mcp: { ...config.mcp, instructions: standing } });
  const first = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto', text: 'First request' });
  const canonical = await currentCoreInstructions();
  const claim = await input.claimBrowserInput(first.id, 'exact-document', null, true);
  expect(claim?.text).toBe(prependUserPrompt('First request', canonical));
  expect(claim?.text).toContain(standing);
  expect((await input.listInputs()).find(row => row.id === first.id)?.text).toBe('First request');
  await saveConfig({ ...config, mcp: { ...config.mcp, instructions: 'Updated standing guidance' } });
  expect((await input.claimBrowserInput(first.id, 'exact-document', null, true))?.text).toBe(claim?.text);
  await input.cancelInput(first.id);
  const second = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto', text: 'Second request' });
  const next = await input.claimBrowserInput(second.id, 'next-document', null, true);
  expect(next?.text).toBe(prependUserPrompt('Second request', await currentCoreInstructions()));
  expect(userPromptText(next!.text)).toBe('Second request');
});

it.each(['off', 'goal', 'loop'] as const)('does not repeat setup in an existing chat with %s enabled', async automation => {
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Existing executor', conversationId });
  const row = await input.enqueueInput({ ...message(session.id, automation), mode: 'auto', text: 'Continue the original work' });
  const claim = await input.claimBrowserInput(row.id, 'followup-page', conversationId, true);
  expect(claim?.text).toBe('Continue the original work');
  input.resetInputForTests();
  expect((await input.claimBrowserInput(row.id, 'followup-page', conversationId, true))?.text).toBe(claim?.text);
});

it('delivers only the selected project AGENTS.md, freezes claims across restart, and budgets the Astra appendix before cutting', async () => {
  const folder = path.join(directory, 'project-' + randomUUID());
  await fs.mkdir(folder);
  const file = path.join(folder, 'AGENTS.md');
  await fs.writeFile(file, 'PROJECT_HEAD\n' + 'project instructions\n'.repeat(30000) + '\nPROJECT_TAIL');
  const config = defaultConfig();
  await saveConfig({ ...config, roots: [{ name: 'project', path: folder }], ui: { ...config.ui, finishTool: true } });
  const project = await addProject(folder);
  const request = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto', projectId: project.id,
    model: 'gpt-6-pro', reasoningEffort: 'pro' });
  const claim = await input.claimBrowserInput(request.id, 'project-document', null, true);
  expect(claim!.text.length).toBeLessThanOrEqual(96000);
  expect(claim!.text).toContain(await currentCoreInstructions());
  expect(claim!.text).toContain('PROJECT_HEAD');
  expect(claim!.text).not.toContain('PROJECT_TAIL');
  expect(claim!.text).toContain('Read AGENTS.md yourself');
  expect(userPromptText(claim!.text)).toBe(request.text + '\n\n' + finishInstruction());
  expect((await input.listInputs()).find(row => row.id === request.id)!.text).toBe(request.text);
  await fs.writeFile(file, 'PROJECT_CHANGED');
  input.resetInputForTests();
  expect((await input.claimBrowserInput(request.id, 'project-document', null, true))!.text).toBe(claim!.text);
  await input.cancelInput(request.id);
  const normal = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto' });
  const ordinary = await input.claimBrowserInput(normal.id, 'ordinary-document', null);
  expect(ordinary!.text).not.toMatch(/PROJECT_HEAD|PROJECT_CHANGED|# AGENTS.md instructions for/);
  await input.cancelInput(normal.id);
  const session = await createSession({ title: 'Project follow-up', conversationId: 'project-followup-chat' });
  await assignSessionProject(session.id, project.id);
  const followup = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto' });
  const tool = await input.offerToolInput(session.id, session.conversationId, 'project-tool-call', Date.now());
  expect(tool.messages).toHaveLength(1);
  expect(tool.messages[0]!.text).not.toMatch(/PROJECT_CHANGED|COS_CONTEXT/);
  expect((await input.listInputs()).find(row => row.id === followup.id)!.deliveryText).toBe(followup.text);
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
    const claim = await input.claimBrowserInput(queued.id, 'checkpoint-page', conversationId, true);
    expect(claim?.text).toBe(queued.text);
  } finally { wake.mockRestore(); }
});
describe('IPC input delivery and Goal control integration', () => {
  it.each([3, 5])('adds the shared %s-minute finish instruction to Astra opening input and excludes other models', async lead => {
    const config = defaultConfig();
    await saveConfig({ ...config, ui: { ...config.ui, finishTool: true, finishLeadMinutes: lead } });
    const request = { ...message(null, 'off'), model: 'gpt-6-pro', reasoningEffort: 'pro' };
    await input.enqueueInput(request as Parameters<typeof input.enqueueInput>[0]);
    const claimed = await input.claimBrowserInput(request.id, 'opening', null);
    expect(userPromptText(claimed!.text)).toBe(request.text + '\n\n' + finishInstruction(lead));
    expect((await input.listInputs()).find(row => row.id === request.id)?.text).toBe(request.text);
    await saveConfig(config);
    input.resetInputForTests();
    expect((await input.listInputs()).find(row => row.id === request.id)?.deliveryText).toBe(claimed?.text);
    await input.cancelInput(request.id);

    const ordinary = message(null, 'off');
    await input.enqueueInput(ordinary as Parameters<typeof input.enqueueInput>[0]);
    expect(userPromptText((await input.claimBrowserInput(ordinary.id, 'disabled', null))!.text)).toBe(ordinary.text);
    await input.cancelInput(ordinary.id);
    await saveConfig({ ...config, ui: { ...config.ui, finishTool: true, finishLeadMinutes: lead } });
    const sol = { ...message(null, 'off'), model: 'gpt-5.6-sol', reasoningEffort: 'high' };
    await input.enqueueInput(sol as Parameters<typeof input.enqueueInput>[0]);
    expect(userPromptText((await input.claimBrowserInput(sol.id, 'sol', null))!.text)).toBe(sol.text);
    await input.cancelInput(sol.id);
    const chat = await createSession({ title: 'Existing native chat', conversationId: randomUUID() });
    const later = message(chat.id, 'off');
    await input.enqueueInput(later as Parameters<typeof input.enqueueInput>[0]);
    expect((await input.claimBrowserInput(later.id, 'later', chat.conversationId))!.text).toBe(later.text);
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
      expect((await input.offerToolInput(session.id, conversationId, 'same-request', 0)).messages).toHaveLength(1);
      await input.offerToolInput(session.id, conversationId, 'same-request', Date.now() + 1);
    }
    const rows = (await readEvents(session.id)).filter(event => event.kind === 'user_message');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inputId: authored.id, authoredText: authored.text, message: { text: authored.text } });
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
    expect(userPromptText(claimed!.text)).toBe(request.text + GOAL_MARKER_INSTRUCTION);
    expect((await input.enqueueInput(request as Parameters<typeof input.enqueueInput>[0])).text).toBe(request.text);
    expect((await input.listInputs()).find(row => row.id === request.id)?.deliveryText).toBe(claimed?.text);
    await input.cancelInput(request.id);
    for (const automation of ['off', 'loop'] as const) {
      const manual = message(null, automation);
      await input.enqueueInput(manual as Parameters<typeof input.enqueueInput>[0]);
      expect(userPromptText((await input.claimBrowserInput(manual.id, automation, null))!.text)).toBe(manual.text);
      await input.cancelInput(manual.id);
    }
  });
  it('prepares scheduled tool input with the delivery backend and freezes retries across backend changes', async () => {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Scheduled offline', conversationId });
    const request = { ...message(session.id, 'goal'), dueAt: Date.now() + 60000 };
    await input.enqueueInput(request as Parameters<typeof input.enqueueInput>[0]);
    expect(await input.offerToolInput(session.id, conversationId, 'early', 0)).toEqual({ messages: [], reminder: '' });
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: false, backend: 'templates' } });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(request.dueAt + 1);
    try {
      const offered = await input.offerToolInput(session.id, conversationId, 'first', 0);
      expect(offered.messages[0]?.text).toContain(request.text + GOAL_MARKER_INSTRUCTION);
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
    expect((await input.offerToolInput(session.id, conversationId, 'tool-request', 0)).messages).toHaveLength(1);
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
  expect(claimed!.text).toBe(request.text + '\n\n' + finishInstruction(3));
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
