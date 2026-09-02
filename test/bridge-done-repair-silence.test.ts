/**
 * Exact regression for the 2026-09-01 Prime recovery trace.
 *
 * One semantic turn reports a recoverable assistant transport error. Chrome confirms that
 * reload, so the turn-scoped repair becomes `done`. The same turn never emits turn_end, but
 * attributed connector calls keep it alive for several minutes. When those calls stop, the
 * chat-level silence deadline must still queue a silence repair; a completed turn-scoped repair
 * is not evidence that the conversation itself recovered.
 */
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
const {
  findSessionByConversation,
  initSessionStore,
  readEvents,
  resetSessionStoreForTests
} = await import('../src/main/session/store.js');
const { recordToolCall, resetRecorderForTests } = await import('../src/main/session/recorder.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const CHAT = '6a9705af-0d44-83ed-a5e3-b7b68df77df1';
const TURN = 'g-1cn09rgnc5jts-1-1';
const ERROR_TEXT = 'Connection interrupted. Waiting for the complete answer';
const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

let dir: string;
let base: string;
let token: string | null = null;
let requestSerial = 0;

function request(
  method: string,
  path: string,
  options: { body?: unknown; auth?: string | null } = {}
): Promise<{ status: number; body: any }> {
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

async function events(items: unknown[]): Promise<any> {
  const reply = await request('POST', '/events', { body: { conversationId: CHAT, events: items } });
  expect(reply.status).toBe(200);
  return reply.body;
}

async function maintenance(
  repaired?: string,
  action?: 'reloaded' | 'reopened'
): Promise<{ conversationId: string; token: string; reason: string } | null> {
  const path = repaired
    ? `/status?repaired=${encodeURIComponent(repaired)}${action ? `&repairAction=${action}` : ''}`
    : '/status';
  const reply = await request('GET', path);
  expect(reply.status).toBe(200);
  const repairs = reply.body.repairs ?? [];
  expect(repairs.length).toBeLessThanOrEqual(1);
  return repairs[0] ?? null;
}

async function attributedCall(): Promise<void> {
  const requestId = `live_repair_trace_${++requestSerial}`;
  await events([
    {
      kind: 'tool_evidence',
      time: Date.now(),
      calls: [{ messageId: `m-${requestSerial}`, tool: 'read', order: 0, answered: false, requestId }]
    }
  ]);
  await recordToolCall({
    tool: 'read',
    args: { paths: ['/project/live-trace.ts'] },
    content: [{ type: 'text', text: 'ok' }],
    outcome: 'ok',
    durationMs: 1,
    startedAt: Date.now(),
    requestId
  });
}

beforeAll(async () => {
  dir = await makeTempDir('clf-bridge-done-repair-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  const config = defaultConfig();
  await saveConfig({
    ...config,
    sessions: { ...config.sessions, record: true },
    multiAgent: { ...config.multiAgent, enabled: true }
  });
  const port = await startBridge();
  expect(port).not.toBeNull();
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await shutdownBridge();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(async () => {
  resetBridgeForTests();
  resetRecorderForTests();
  writeDurableSoon('bridge-commands', null);
  await flushDurable();
  await setSecret('bridgeToken', '');
  token = null;
  requestSerial = 0;
});

describe('silence after a confirmed assistant-error repair', () => {
  it('still queues the silence reload when the same turn never ends', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events([{ kind: 'turn_start', time: Date.now(), turnId: TURN }]);

      // Keep the turn alive up to the transport failure, as the live Prime did with connector work.
      await vi.advanceTimersByTimeAsync(60_000);
      await attributedCall();
      await vi.advanceTimersByTimeAsync(60_000);

      await events([
        { kind: 'chat_error', time: Date.now(), text: ERROR_TEXT, turnId: TURN, recoverable: true }
      ]);
      await vi.advanceTimersByTimeAsync(17_393);
      const assistantError = await maintenance();
      expect(assistantError).toMatchObject({ conversationId: CHAT, reason: 'assistant-error' });
      expect(await maintenance(assistantError!.token, 'reloaded')).toBeNull();

      // The page remains broken but the server-side model keeps issuing attributed calls. Never
      // emit turn_end. Each call refreshes the two-minute chat silence deadline while preserving
      // the turn-scoped assistant-error repair.
      for (let index = 0; index < 6; index += 1) {
        await vi.advanceTimersByTimeAsync(index === 0 ? 5_000 : 90_000);
        await attributedCall();
      }

      const session = await findSessionByConversation(CHAT);
      expect(session).not.toBeNull();
      const beforeSilence = await readEvents(session!.id);
      expect(beforeSilence.filter((event) => event.kind === 'turn_end')).toHaveLength(0);
      expect(beforeSilence.filter((event) => event.kind === 'tool_call').length).toBeGreaterThan(1);

      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 1);
      expect(await maintenance()).toBeNull();
      await vi.advanceTimersByTimeAsync(2);
      await sweepStaleSwarm(Date.now());

      const silence = await maintenance();
      expect(silence).toMatchObject({ conversationId: CHAT, reason: 'silence' });
      // Once the chat-scoped silence action itself is confirmed, the old one-shot rule still
      // applies: without fresh activity there is no third reload.
      expect(await maintenance(silence!.token, 'reloaded')).toBeNull();
      expect(await maintenance()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
