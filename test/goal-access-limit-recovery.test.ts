import http from 'node:http';
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
const { APP_VERSION, BRIDGE_PROTOCOL } = await import('../src/main/version.js');
const { initSecretsPath, setSecret } = await import('../src/main/secrets.js');
const {
  CHAT_SILENCE_MS,
  resetBridgeForTests,
  shutdownBridge,
  startBridge,
  sweepStaleSwarm
} = await import('../src/main/bridge.js');
const { flushDurable, initDurableStore, writeDurableSoon } = await import('../src/main/durable.js');
const { initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { resetRecorderForTests } = await import('../src/main/session/recorder.js');
const { resetGoalStateForTests, setGoalSwitchNow } = await import('../src/main/goal.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const CHAT = 'f0f00003-1111-4111-8111-111111111111';
const TURN = 'goal-access-limit-turn';
const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

let dir: string;
let base: string;
let token: string | null = null;

function request(method: string, path: string, options: { body?: unknown; auth?: string | null } = {}): Promise<{ status: number; body: any }> {
  const url = new URL(path, base);
  const payload = options.body === undefined ? null : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    origin: EXTENSION_ORIGIN,
    'x-extension-version': APP_VERSION,
    'x-extension-protocol': String(BRIDGE_PROTOCOL)
  };
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  const auth = options.auth === undefined ? token : options.auth;
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
        });
      }
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function pair(): Promise<void> {
  const reply = await request('POST', '/pair', { auth: null });
  expect(reply.status).toBe(200);
  token = reply.body.token;
}

async function events(items: unknown[]): Promise<void> {
  const reply = await request('POST', '/events', { body: { conversationId: CHAT, events: items } });
  expect(reply.status).toBe(200);
}

async function maintenance(): Promise<{ conversationId: string; token: string; reason: string } | null> {
  const reply = await request('GET', '/status');
  expect(reply.status).toBe(200);
  const repairs = reply.body.repairs ?? [];
  expect(repairs.length).toBeLessThanOrEqual(1);
  return repairs[0] ?? null;
}

beforeAll(async () => {
  dir = await makeTempDir('clf-goal-access-limit-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  const config = defaultConfig();
  await saveConfig({
    ...config,
    sessions: { ...config.sessions, record: true },
    multiAgent: { ...config.multiAgent, enabled: true, recoverAgentTabs: false }
  });
  const port = await startBridge();
  expect(port).not.toBeNull();
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await shutdownBridge();
  resetGoalStateForTests();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(async () => {
  resetGoalStateForTests();
  resetBridgeForTests();
  resetRecorderForTests();
  writeDurableSoon('bridge-commands', null);
  await flushDurable();
  await setSecret('bridgeToken', '');
  token = null;
});

describe('Goal/Loop provider access-limit recovery', () => {
  it('preserves only the existing Goal silence owner and recovers on its normal deadline', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await setGoalSwitchNow(CHAT, 'loop', true, true);
      await events([
        { kind: 'model_selection', model: 'gpt-5.6-luna', reasoningEffort: 'high', time: Date.now() },
        { kind: 'turn_start', time: Date.now(), turnId: TURN }
      ]);
      await events([{
        kind: 'chat_error',
        time: Date.now(),
        turnId: TURN,
        recoverable: false,
        blocking: true,
        text: 'Too many requests We have temporarily limited access to conversations to protect your data. Please wait a few minutes.'
      }]);

      // The dialog grants no immediate resend/reload authority.
      expect(await maintenance()).toBeNull();
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 1);
      expect(await maintenance()).toBeNull();

      // Goal/Loop reuses its one existing silence owner rather than being parked forever.
      await vi.advanceTimersByTimeAsync(2);
      await sweepStaleSwarm(Date.now());
      expect(await maintenance()).toMatchObject({ conversationId: CHAT, reason: 'silence' });
    } finally {
      vi.useRealTimers();
    }
  });
});
