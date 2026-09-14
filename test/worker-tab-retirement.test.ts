import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'unknown'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  },
  clipboard: {},
  shell: {}
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath, setSecret } = await import('../src/main/secrets.js');
const { initDurableStore } = await import('../src/main/durable.js');
const { initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { resetRecorderForTests } = await import('../src/main/session/recorder.js');
const {
  bridgePort,
  resetBridgeForTests,
  shutdownBridge,
  startBridge
} = await import('../src/main/bridge.js');
const {
  WORKER_CONTEXT_CEILING_TOKENS,
  bindConversation,
  noteAgentContextTokens,
  onSpawnRequest,
  resetSwarm,
  spawn,
  stageFinishAgent,
  swarmState
} = await import('../src/main/agents.js');
const { APP_VERSION, BRIDGE_PROTOCOL } = await import('../src/main/version.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const PRIME = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';

let dir: string;
let bearer = '';

async function post(route: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${bridgePort()}${route}`, {
    method: 'POST',
    headers: {
      origin: EXTENSION_ORIGIN,
      'content-type': 'application/json',
      'x-extension-version': APP_VERSION,
      'x-extension-protocol': String(BRIDGE_PROTOCOL),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function pair(): Promise<void> {
  const reply = await post('/pair', {});
  expect(reply.status).toBe(200);
  bearer = reply.body.token;
}

async function status(): Promise<any> {
  const reply = await post('/status', { openConversations: [WORKER] });
  expect(reply.status).toBe(200);
  return reply.body;
}

function activeWorker(): void {
  const spawned: Array<{ id: string; task: string }> = [];
  const drop = onSpawnRequest((workers) => spawned.push(...workers));
  try {
    spawn({
      workers: [{ label: 'Worker 1', task: 'Inspect the requested subsystem.' }],
      caller: { conversationId: PRIME }
    });
    expect(spawned[0]?.id).toBe('worker-1');
    expect(bindConversation(spawned[0]!.id, WORKER)).toBe(true);
  } finally {
    drop();
  }
  expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
}

beforeAll(async () => {
  dir = await makeTempDir('clf-worker-tab-retirement-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  await saveConfig({
    ...defaultConfig(),
    multiAgent: { ...defaultConfig().multiAgent, enabled: true }
  });
  const port = await startBridge();
  expect(port).not.toBeNull();
});

afterAll(async () => {
  await shutdownBridge();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(async () => {
  resetBridgeForTests();
  resetRecorderForTests();
  resetSwarm();
  bearer = '';
  await setSecret('bridgeToken', '');
  await saveConfig({
    ...defaultConfig(),
    multiAgent: { ...defaultConfig().multiAgent, enabled: true }
  });
  await pair();
});

describe('worker tab retirement policy', () => {
  it.each([
    { terminal: false, state: 'sleeping', revivable: true },
    { terminal: true, state: 'finished', revivable: false }
  ] as const)('publishes a committed $state worker as immediately closable', async ({ terminal, state, revivable }) => {
    activeWorker();
    if (terminal) noteAgentContextTokens(WORKER, WORKER_CONTEXT_CEILING_TOKENS);

    const staged = stageFinishAgent({ conversationId: WORKER }, 'RESULT: done\nCHANGES: none\nVALIDATION: exact\nBLOCKERS: none');
    expect(staged.info).toMatchObject({ state, revivable });

    const before = await status();
    expect(before.managedConversations).toContain(WORKER);
    expect(before.closableConversations).not.toContain(WORKER);

    staged.commit();

    const after = await status();
    expect(after.closableConversations).toContain(WORKER);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state,
      revivable,
      conversationId: WORKER
    });
  });

  it('does not publish close authority when the staged finish rolls back', async () => {
    activeWorker();
    const staged = stageFinishAgent({ conversationId: WORKER }, 'RESULT: rollback fixture');

    staged.rollback();

    const after = await status();
    expect(after.closableConversations).not.toContain(WORKER);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'active',
      conversationId: WORKER
    });
  });
});
