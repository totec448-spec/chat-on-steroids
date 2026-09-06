/**
 * The settings handler, exercised through the channel the renderer actually uses.
 *
 * Only the part where two subsystems have to be shut down in the right order. The rest of
 * the IPC surface is thin validation over modules that have their own tests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  },
  BrowserWindow: class {},
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })) },
  shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => '') },
  nativeTheme: { themeSource: 'system' },
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  },
  app: { getPath: () => '', getVersion: vi.fn(() => '0.0.0'), getAppPath: () => process.cwd(), isPackaged: false }
}));

// This suite owns IPC behavior, not Electron's packaged-vs-checkout path discovery.
vi.mock('../src/main/extension-path.js', () => ({ extensionDir: () => process.cwd() }));
vi.mock('../src/main/browser.js', () => ({ openInPreferredBrowser: vi.fn(async () => 'chrome.exe') }));

const { defaultConfig, getConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath, resetSecretsCacheForTests } = await import('../src/main/secrets.js');
const { appendEvent, createSession, initSessionStore, rebindSession, resetSessionStoreForTests } = await import('../src/main/session/store.js');
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
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;
let currentWindow: {
  setBackgroundColor: ReturnType<typeof vi.fn>;
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

it('validates dropped image count and decodes bytes through the existing image authority', async () => {
  const drop = (payload: unknown) => handlers.get('sessions:dropImages')!(null, payload) as Promise<any>;
  expect(await drop({ paths: [] })).toMatchObject({ ok: false });
  expect(await drop({ paths: Array(5).fill('image.png') })).toMatchObject({ ok: false });
  expect(await drop({ paths: [''] })).toMatchObject({ ok: false });
  expect(await drop({ paths: [path.join(process.cwd(), 'package.json')] })).toMatchObject({ ok: false });
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
    const row = await outbox.enqueueInput({ id: '949091a5-e895-4b57-b090-925ef3d14f7a', sessionId: session.id,
      text: 'Pending automatic instruction', mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null },
      { turnId: 'periodic-turn', periodic: false, userRequested: true });
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
    expect(await outbox.offerToolInput(session.id, 'periodic-settings-chat', 'later-request', Date.now())).toEqual([]);
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
  currentWindow = { setBackgroundColor: vi.fn(), isDestroyed: () => false, webContents: { send: vi.fn() } };
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
});

/** The whole settings object the renderer sends, with the parts a test cares about set. */
function settings(over: { record: boolean; multiAgent: boolean }) {
  const base = defaultConfig();
  return {
    capabilities: base.capabilities,
    readOnly: base.readOnly,
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

describe('explicit settings replace the published tool contract', () => {
  it.each(['finish', 'command', 'session'] as const)('withdraws %s from real endpoint publication after its setting is disabled', async kind => {
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
      const tool = kind === 'finish' ? 'session_finish' : kind === 'command' ? 'exec_command' : kind;
      expect(before.tools.map(row => row.name)).toContain(tool);
      const current = getConfig();
      const patch = { ...current, ...(kind === 'finish' ? { ui: { ...current.ui, finishTool: false } } : kind === 'command' ? { capabilities: { ...current.capabilities, command: false } } : { sessions: { ...current.sessions, record: false } }) };
      expect((await save(patch)).ok).toBe(true);
      const after = snapshot();
      expect(after.tools.map(row => row.name)).not.toContain(tool);
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
      version: 6,
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

describe('settings writes from more than one UI', () => {
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
      setBackgroundColor: vi.fn(),
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
    expect(currentWindow.setBackgroundColor).toHaveBeenCalledWith('#0e0e11');
    expect(getConfig().goal.enabled).toBe(false);
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

/**
 * `link:open` is an allowlist, which means a button whose URL was never added to it does
 * not open a slightly wrong page — it throws, in a handler nobody is watching, and the
 * button does nothing at all. That is how "Open OpenRouter keys" shipped dead beside the
 * key field it exists to go and fetch.
 *
 * So the test is not "is this one URL present". It is: every link the window can offer is
 * a link the main process will open. The markup is the source of truth for the first half
 * and `ALLOWED_LINKS` for the second, and they have to agree.
 */
describe('every link the window offers', () => {
  it('is one link:open will actually open', async () => {
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    const [html, ipcSource] = await Promise.all([
      fs.readFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'src', 'main', 'ipc.ts'), 'utf8')
    ]);

    const offered = [...html.matchAll(/data-link="([^"]+)"/g)].map((match) => match[1]!);
    expect(offered.length, 'the markup offers no links at all — has data-link been renamed?').toBeGreaterThan(0);

    const block = /const ALLOWED_LINKS = new Set\(\[([\s\S]*?)\]\);/.exec(ipcSource);
    expect(block, 'ALLOWED_LINKS is gone or renamed').not.toBeNull();
    // Comment lines go first: prose above an entry is free to contain an apostrophe, and
    // one stray apostrophe would otherwise re-pair every quote below it. Anchored to the
    // start of a line, because every URL in the list contains a `//` of its own.
    const entries = block![1]!.replace(/^[ \t]*\/\/[^\n]*$/gm, '');
    const allowed = new Set([...entries.matchAll(/'([^']+)'/g)].map((match) => match[1]!));

    expect(offered.filter((url) => !allowed.has(url))).toEqual([]);
  });

  it('opens the OpenRouter key page the goal loop sends people to', async () => {
    const open = handlers.get('link:open')!;
    expect(await open(null, { url: 'https://openrouter.ai/settings/keys' })).toEqual({ ok: true, data: true });
    const refused = (await open(null, { url: 'https://example.com/' })) as { ok: boolean; error: string };
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/not allowed/i);
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
