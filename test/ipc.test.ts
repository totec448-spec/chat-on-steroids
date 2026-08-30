/**
 * The settings handler, exercised through the channel the renderer actually uses.
 *
 * Only the part where two subsystems have to be shut down in the right order. The rest of
 * the IPC surface is thin validation over modules that have their own tests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  },
  BrowserWindow: class {},
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
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
const { appendEvent, createSession, initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
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
const { app, nativeTheme, safeStorage, shell } = await import('electron');
const { extensionDownloadUrl } = await import('../src/main/version.js');
const { resetWorkspaces, setWorkspaceFor, workspaceEntries } = await import('../src/main/workspace.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

let dir: string;
let currentWindow: {
  setBackgroundColor: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
} | null = null;

const save = (patch: unknown, base: unknown = getConfig()): Promise<any> =>
  handlers.get('settings:save')!(null, { patch, base }) as Promise<any>;
const renameRoot = (payload: unknown): Promise<any> => handlers.get('roots:rename')!(null, payload) as Promise<any>;
const removeRoot = (payload: unknown): Promise<any> => handlers.get('roots:remove')!(null, payload) as Promise<any>;
const sessionEvents = (payload: unknown): Promise<any> => handlers.get('sessions:events')!(null, payload) as Promise<any>;
const sessionList = (): Promise<any> => handlers.get('sessions:list')!(null, undefined) as Promise<any>;

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
  registerIpc(() => currentWindow as any);
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
      version: 5,
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

    registerIpc(() => destroyed);
    expect(() => logInfo('teardown progress written after the window went away')).not.toThrow();
    expect(touchedWebContents).toBe(false);
  });
});
