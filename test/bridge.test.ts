/**
 * The local bridge, over real HTTP.
 *
 * This server is the one thing in the app a web page could try to reach, and it holds
 * the credential the extension authenticates with, so the tests here are mostly about
 * what it refuses: a page origin, a missing token, a superseded token.
 * The happy paths matter too, but they are the cheap half.
 */

import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_VERSION, BRIDGE_PROTOCOL } from '../src/main/version.js';
import { foldProgress, type SessionEvent } from '../src/shared/session.js';
import type { ContinuationSnapshot } from '../src/main/session/continuation.js';
import type { SwarmSnapshot } from '../src/main/agents.js';
import type { Config } from '../src/shared/types.js';

// safeStorage only exists inside a running Electron main process. The bridge stores
// its bearer token through it, so the test provides the same interface, unencrypted.
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
const { safeStorage } = await import('electron');

const { defaultConfig, getConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath, resetSecretsCacheForTests, setSecret } = await import('../src/main/secrets.js');
const {
  bridgePort,
  bridgeStatus,
  cancelResume,
  commandUrl,
  pendingCommands,
  queueResume,
  resetBridgeForTests,
  restoreCommands,
  resumeJobFor,
  setBrowserOpener,
  shutdownBridge,
  STALE_SWARM_MS,
  BROWSER_PLACEMENT_MS,
  CHAT_SILENCE_MS,
  GOAL_QUIET_MS,
  GOAL_SILENCE_LISTEN_MS,
  COMMAND_DEADLINE_MS,
  REVIVAL_ACTIVITY_MS,
  REVIVAL_DEADLINE_MS,
  WORKER_BOOTSTRAP_LIMIT_MS,
  WORKER_REDEEM_MS,
  BROWSER_RECOVERY_COOLDOWN_MS,
  DEFAULT_PORTS,
  startBridge,
  stopBridge,
  sweepStaleSwarm,
  unpair
} = await import('../src/main/bridge.js');
const { flushDurable, initDurableStore, readDurable, writeDurableNow, writeDurableSoon } = await import('../src/main/durable.js');
const {
  GOAL_OBJECTIVES_STATE,
  GOAL_REPLIES_STATE,
  GOAL_SWITCHES_STATE,
  goalDrivingMode,
  goalObjectiveFor,
  goalDraftBusy,
  goalPendingReplyFor,
  goalSwitchFor,
  humanReply,
  resetGoalStateForTests,
  setGoalObjective
} = await import('../src/main/goal.js');
const { createSession, deleteSession, findSessionByConversation, getSession, initSessionStore, readEvents, resetSessionStoreForTests } = await import(
  '../src/main/session/store.js'
);
const { closeConversation, liveConversations, noteChatOrigin, recordChatObservations, recordProgress, recordToolCall, REQUEST_ID_GRACE_MS, resetRecorderForTests } = await import('../src/main/session/recorder.js');
const { resetBlockedChatsForTests, setChatBlocked } = await import('../src/main/session/blocked-chats.js');
const {
  CONTINUATIONS_STATE,
  abortContinuation,
  attachSummary,
  claimContinuationNow,
  commitContinuation,
  continuationByToken,
  continuationForSession,
  openContinuationNow,
  setContinuationRecoveryHooks,
  restoreContinuations
} = await import('../src/main/session/continuation.js');
const {
  acknowledgeOffers,
  PRIME_ID,
  beginPrimeTransfer,
  bindConversation,
  cancelPrimeTransfer,
  finishAgent,
  currentRunId,
  DETACHED_SILENCE_MS,
  noteAgentAlive,
  noteAgentContextTokens,
  noteWorkerRevived,
  offerMessages,
  pendingWorkerRevivals,
  repairPrimeConversationAfterRecovery,
  requestWorkerBootstraps,
  requestWorkerRevivals,
  spawn,
  stageMessages,
  pendingWorkerSpawns,
  onSwarmPersistNow,
  persistCriticalSwarmNow,
  retiredWorkerForConversation,
  resetSwarm,
  restoreSwarm,
  snapshotSwarm,
  swarmState,
  swarmStateForCaller,
  WORKER_CONTEXT_CEILING_TOKENS,
  workerConversationGone
} = await import(
  '../src/main/agents.js'
);
const { makeTempDir, removeTempDir, SAMPLE_BRIEF } = await import('./helpers.js');
const { resumeBootstrapText } = await import('../src/main/session/handoff.js');
const { getLog } = await import('../src/main/logger.js');

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
/** The chat that spawns the swarm in these tests: only a proven conversation can. */
const PRIME_CHAT = 'c-prime-bridge';
/** The chat a worker lands in when its bootstrap ACK is lost and `/events` binds it instead. */
const LOST_ACK_CHAT = 'bcbcbcbc-1111-2222-3333-444444444444';

/**
 * A continuation that has already been given its brief, ready to be queued.
 *
 * `queueResume` takes the transaction's one-time token, not a handoff id: the brief the
 * fresh chat is typed lives in the transaction, and the command carries only the right to
 * claim it. So a queued resume in these tests has to be a real one.
 */
async function readyContinuation(sessionId: string, brief: string, from = 'c-compacted'): Promise<string> {
  const opened = await openContinuationNow(sessionId, from);
  // The caller's line is what its assertions look for; the rest is there because the app
  // refuses a brief too short to have carried a session across. See SAMPLE_BRIEF.
  const stored = await attachSummary(opened.token, `${brief}

${SAMPLE_BRIEF}`);
  expect(stored, 'the brief was not stored, so there is no resume to queue').not.toBeNull();
  return opened.token;
}

/**
 * A session really attached to a chat, compacted, with its brief already written.
 *
 * The commit rebinds the session from chat A to chat B, so chat A has to be a chat this
 * session is actually in — a bare `createSession` has no conversation to move away from
 * and every commit against it is refused.
 */
async function compactedSession(from: string, brief: string): Promise<{ sessionId: string; token: string }> {
  const reply = await request('POST', '/events', {
    body: {
      conversationId: from,
      events: [{ kind: 'user_message', time: Date.now(), text: 'do the work', messageId: `m-${from}` }]
    }
  });
  const sessionId = reply.body.sessionId as string;
  expect(sessionId, 'the chat was not recorded, so there is no session to compact').toBeTruthy();
  return { sessionId, token: await readyContinuation(sessionId, brief, from) };
}

/** Every URL the app asked the OS to open, in order. Stands in for Electron's shell. */
const opened: string[] = [];
let anonymousRedeemIndex = 0;

let dir: string;
let base: string;
let token: string | null = null;

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}

function request(
  method: string,
  path: string,
  options: { body?: unknown; origin?: string | null; auth?: string | null; raw?: string } = {}
): Promise<Reply> {
  const url = new URL(path, base);
  const payload = options.raw ?? (options.body === undefined ? null : JSON.stringify(options.body));
  const headers: Record<string, string> = {};
  // Every extension request carries its protocol generation. Pairing must fail closed
  // across incompatible app/extension builds instead of provisioning a token that can
  // only produce confusing downstream failures.
  headers['x-extension-version'] = APP_VERSION;
  headers['x-extension-protocol'] = String(BRIDGE_PROTOCOL);
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  // `origin: null` means "send no Origin header", which is what Chrome does for an
  // extension fetch to a host it already holds permission for.
  if (options.origin !== null) headers['origin'] = options.origin ?? EXTENSION_ORIGIN;
  const auth = options.auth === undefined ? token : options.auth;
  if (auth) headers['authorization'] = `Bearer ${auth}`;

  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: any = text;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            // Leave it as text; a non-JSON body is itself a finding.
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      }
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/**
 * Sends from the prime exactly the way the `agents` tool does.
 *
 * A message crosses its durable barrier first and is published second; only then may the
 * browser be asked to reopen anybody's chat. Doing those two steps in this order here is
 * what makes these tests exercise the real wake path rather than a shortcut into it.
 */
function wake(items: ReadonlyArray<{ to: string; text: string }>): void {
  const staged = stageMessages({ conversationId: PRIME_CHAT }, items);
  staged.commit();
  if (staged.waking.length > 0) requestWorkerRevivals(staged.waking);
}

async function waitForOpened(count = 1): Promise<void> {
  await vi.waitFor(() => expect(opened).toHaveLength(count));
}

async function waitForRevival(): Promise<{ id: string; conversationId: string }> {
  let revival: { id: string; conversationId: string } | null = null;
  await vi.waitFor(async () => {
    const status = await request('GET', '/status');
    revival = status.body.revival ?? null;
    expect(revival).toMatchObject({ id: expect.any(String), conversationId: expect.any(String) });
  });
  return revival!;
}

/**
 * The one page the app opened, redeeming the one command it was opened for.
 *
 * The only way a bootstrap reaches a browser now. There is no listing route and no poll:
 * a command is delivered to the page holding its marker, or it is not delivered at all.
 */
async function redeem(id?: string, client = 'tab-1'): Promise<any> {
  if (!id) {
    const index = anonymousRedeemIndex++;
    await vi.waitFor(() => expect(opened.length).toBeGreaterThan(index));
    id = new URL(opened[index]!).searchParams.get('clf')!;
  }
  const reply = await request('POST', '/commands/redeem', { body: { id, client } });
  expect(reply.status, `redeem ${id} failed`).toBe(200);
  return reply.body.command;
}

/** Connects the way the extension does, and remembers the token for later requests. */
/** The configuration every test starts from; see beforeAll. */
let suiteConfig: Config;

async function pair(): Promise<string> {
  const reply = await request('POST', '/pair', { auth: null });
  expect(reply.status).toBe(200);
  token = reply.body.token as string;
  return token;
}

beforeAll(async () => {
  dir = await makeTempDir('clf-bridge-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  onSwarmPersistNow((snapshot) => writeDurableNow('swarm', snapshot));
  const baseConfig = defaultConfig();
  suiteConfig = {
    ...baseConfig,
    sessions: { ...baseConfig.sessions, record: true },
    // Recovery of ordinary chats is off by default; this suite is where it is exercised.
    multiAgent: { ...baseConfig.multiAgent, enabled: true, recoverAgentTabs: true }
  };
  await saveConfig(suiteConfig);
  const port = await startBridge();
  expect(port, 'no loopback port in 8765-8769 was free').not.toBeNull();
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await stopBridge();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(async () => {
  vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
  // A test that writes its own config is not allowed to leak it into the next one.
  await saveConfig(suiteConfig);
  // The swarm goes first: ending a run queues stop notices into the chats of any workers
  // still live, and those would otherwise be dropped into the queue the bridge reset had
  // just emptied — the previous test's cleanup showing up as the next test's first command.
  resetSwarm();
  resetBridgeForTests();
  opened.length = 0;
  anonymousRedeemIndex = 0;
  // The app opens the chat itself, always: there is no queue for a tab to come and ask.
  // Tests that need the open to fail replace this with their own opener.
  setBrowserOpener(async (url) => {
    opened.push(url);
  });
  resetRecorderForTests();
  writeDurableSoon('bridge-commands', null);
  await flushDurable();
  await setSecret('bridgeToken', '');
  token = null;
});

// ------------------------------------------------------------------ origin

describe('who is allowed to talk to it', () => {
  it('binds a loopback port only', () => {
    expect(bridgePort()).toBeGreaterThan(0);
    expect(base.startsWith('http://127.0.0.1:')).toBe(true);
  });

  // The suite binds ephemeral ports so it can never collide with the installed app, so the
  // shipped range has to be asserted directly or a typo in it would ship unnoticed.
  it('ships the fixed candidate range the extension scans', () => {
    expect(DEFAULT_PORTS).toEqual([8765, 8766, 8767, 8768, 8769]);
  });

  it('identifies itself to an extension without any credential', async () => {
    const reply = await request('GET', '/hello', { auth: null });
    expect(reply.status).toBe(200);
    expect(reply.body.app).toBe('chat-on-steroids');
    // Against the constant, not a literal: what matters is that the handshake reports the
    // build's own version, and a hard-coded number here only ever fails on release day.
    expect(reply.body.version).toBe(APP_VERSION);
    expect(reply.body.bridge).toBe(BRIDGE_PROTOCOL);
    expect(reply.body.paired).toBe(false);
    // Identification must not double as a status leak.
    expect(Object.keys(reply.body)).toEqual(['app', 'version', 'bridge', 'compatible', 'paired', 'disconnected']);
    expect(reply.body.disconnected).toBe(false);
    expect(reply.body.compatible).toBe(true);
  });

  it('refuses every web page origin, chatgpt.com included', async () => {
    for (const origin of ['https://chatgpt.com', 'https://evil.example.com', 'http://localhost:3000', 'null']) {
      const reply = await request('GET', '/hello', { origin, auth: null });
      expect(reply.status, origin).toBe(403);
      expect(reply.body.error).toBe('forbidden_origin');
      expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('serves a request that carries no Origin at all', async () => {
    const reply = await request('GET', '/hello', { origin: null, auth: null });
    expect(reply.status).toBe(200);
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers an extension preflight with the private-network header Chrome needs', async () => {
    const reply = await request('OPTIONS', '/events', { auth: null });
    expect(reply.status).toBe(204);
    expect(reply.headers['access-control-allow-origin']).toBe(EXTENSION_ORIGIN);
    expect(reply.headers['access-control-allow-private-network']).toBe('true');
  });

  it('refuses a preflight that arrives without an Origin', async () => {
    const reply = await request('OPTIONS', '/events', { origin: null, auth: null });
    expect(reply.status).toBe(403);
  });
});

// -------------------------------------------------------------- provisioning

describe('provisioning', () => {
  it('issues a token to the extension with nothing for the user to type', async () => {
    const reply = await request('POST', '/pair', { auth: null });
    expect(reply.status).toBe(200);
    expect(reply.body.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const hello = await request('GET', '/hello', { auth: null });
    expect(hello.body.paired).toBe(true);
  });

  it('starts and stays usable while secure storage is unavailable, then pairs after it returns', async () => {
    await stopBridge();
    resetSecretsCacheForTests();
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);
    const restarted = await startBridge();
    expect(restarted).toBeGreaterThan(0);
    base = `http://127.0.0.1:${restarted}`;

    const hello = await request('GET', '/hello', { auth: null });
    expect(hello.status).toBe(200);
    expect(hello.body.paired).toBe(false);
    const reply = await request('POST', '/pair', { auth: null });
    expect(reply.status).toBe(503);
    expect(reply.body.error).toBe('secure_storage_unavailable');
    expect(reply.body.message).toMatch(/credential storage/i);
    expect(reply.body.token).toBeUndefined();

    // Keychain/Secret Service can become available after login/unlock without the app or bridge
    // restarting. The listener must recover in place rather than being poisoned by the first read.
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
    const paired = await request('POST', '/pair', { auth: null });
    expect(paired.status).toBe(200);
    expect(paired.body.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect((await bridgeStatus()).running).toBe(true);
  });

  it('never issues a token to a web page', async () => {
    for (const origin of ['https://chatgpt.com', 'https://evil.example.com', 'null']) {
      const silent = await request('POST', '/pair', { origin, auth: null });
      expect(silent.status, origin).toBe(403);
      expect(silent.body.error).toBe('forbidden_origin');
      expect(silent.body.token).toBeUndefined();
    }
    expect((await request('GET', '/hello', { auth: null })).body.paired).toBe(false);
  });

  it('replaces the token on a second request, so a re-provision supersedes the old one', async () => {
    const first = await pair();
    const second = await pair();
    expect(second).not.toBe(first);
    expect((await request('GET', '/status', { auth: first })).status).toBe(401);
    expect((await request('GET', '/status', { auth: second })).status).toBe(200);
  });

  it('drops the token when the user disconnects the browser', async () => {
    await pair();
    expect((await request('GET', '/status')).status).toBe(200);
    await unpair();
    expect((await request('GET', '/status')).status).toBe(401);
  });

  it('keeps an app-side disconnect latched until the browser explicitly reconnects', async () => {
    await pair();
    await unpair();
    // Drop the decrypted in-process cache. The next bridge read now has to recover the
    // disconnect marker from the encrypted file, the relevant half of an app restart.
    resetSecretsCacheForTests();

    // First-install provisioning is silent, but this browser was deliberately revoked by
    // the app. A background poll must not be able to turn that revocation into a new token.
    const silent = await request('POST', '/pair', { auth: null });
    expect(silent.status).toBe(409);
    expect(silent.body.error).toBe('browser_disconnected');
    expect((await request('GET', '/hello', { auth: null })).body).toMatchObject({
      paired: false,
      disconnected: true
    });

    // The extension popup's Connect action is the explicit counterpart. Only that intent
    // clears the durable app-side latch and mints a usable token again.
    const reconnect = await request('POST', '/pair', { auth: null, body: { reconnect: true } });
    expect(reconnect.status).toBe(200);
    token = reconnect.body.token as string;
    expect((await request('GET', '/status')).status).toBe(200);
    expect((await request('GET', '/hello', { auth: null })).body).toMatchObject({
      paired: true,
      disconnected: false
    });
  });

  it('does not treat a persisted pairing token as proof the browser is present after restart', async () => {
    await pair();
    expect(await bridgeStatus()).toMatchObject({ paired: true, present: true });

    // Pairing is durable authorization; browser presence belongs to this app process. A
    // restart keeps the token but has not seen the extension yet, so setup must not call it
    // connected merely because an old credential survived on disk.
    resetBridgeForTests();
    expect(await bridgeStatus()).toMatchObject({ paired: true, present: false, lastSeenAt: null });
  });

  it('requires a fresh browser sighting after the local bridge itself restarts', async () => {
    await pair();
    expect(await bridgeStatus()).toMatchObject({ paired: true, present: true });

    await stopBridge();
    expect(await bridgeStatus()).toMatchObject({ running: false, paired: true, present: false, lastSeenAt: null });
    const restarted = await startBridge();
    expect(restarted).not.toBeNull();
    base = `http://127.0.0.1:${restarted}`;
    expect(await bridgeStatus()).toMatchObject({ running: true, paired: true, present: false, lastSeenAt: null });

    // Authorization survived, so the first normal extension poll proves presence again.
    expect((await request('GET', '/status')).status).toBe(200);
    expect(await bridgeStatus()).toMatchObject({ paired: true, present: true });
  });
});

describe('active agent tab discard projection', () => {
  it('publishes exact Prime and Worker chat ids only while their run is live', async () => {
    await pair();
    const workerConversation = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    spawn({ workers: [{ task: 'stay live while Chrome applies the tab policy' }], caller: { conversationId: PRIME_CHAT } });

    expect((await request('GET', '/status')).body.nonDiscardableConversations).toEqual([PRIME_CHAT]);

    expect(bindConversation('worker-1', workerConversation)).toBe(true);
    expect((await request('GET', '/status')).body.nonDiscardableConversations).toEqual([
      workerConversation,
      PRIME_CHAT
    ].sort());

    finishAgent({ conversationId: workerConversation }, 'the worker is sleeping now');
    expect((await request('GET', '/status')).body.nonDiscardableConversations).toEqual([PRIME_CHAT]);
  });
});

// -------------------------------------------------------------------- auth

describe('authorisation', () => {
  it('refuses every route but /hello and /pair without a token', async () => {
    await pair();
    for (const [method, path] of [
      ['GET', '/status'],
      ['GET', '/activity?conversationId=abcdabcd'],
      ['POST', '/events'],
      ['POST', '/correlations'],
      ['POST', '/closed'],
      ['POST', '/commands/ack']
    ] as const) {
      const reply = await request(method, path, { auth: null, ...(method === 'POST' ? { body: {} } : {}) });
      expect(reply.status, path).toBe(401);
    }
  });

  it('refuses a token of the right shape but the wrong value', async () => {
    const issued = await pair();
    const forged = `${issued.slice(0, -1)}${issued.endsWith('A') ? 'B' : 'A'}`;
    expect((await request('GET', '/status', { auth: forged })).status).toBe(401);
  });

  it('has no route that reads a file or runs anything', async () => {
    await pair();
    for (const path of ['/read', '/exec', '/config', '/secrets', '/../config.json']) {
      expect((await request('GET', path)).status, path).toBe(404);
    }
  });
});

// ------------------------------------------------------------------ events

describe('observations', () => {
  it('refuses anything that is not a conversation id', async () => {
    await pair();
    for (const conversationId of ['', 'not a uuid', '../../etc', 'x'.repeat(100)]) {
      const reply = await request('POST', '/events', { body: { conversationId, events: [] } });
      expect(reply.status, String(conversationId)).toBe(400);
      expect(reply.body.error).toBe('bad_conversation_id');
    }
  });

  it('stores what the page reported and skips what it does not recognise', async () => {
    await pair();
    const conversationId = '6a805197-b090-83eb-bbd8-a32b482941da';
    const reply = await request('POST', '/events', {
      body: {
        conversationId,
        events: [
          { kind: 'user_message', time: Date.now(), text: 'first requirement', messageId: 'm1' },
          { kind: 'turn_start', time: Date.now(), turnId: 'turn-1' },
          { kind: 'assistant_message', time: Date.now(), text: 'reading files', renderedHtml: '<p><strong>reading</strong> files</p>', messageId: 'a1', state: 'streaming' },
          { kind: 'invented_kind', time: Date.now(), text: 'should be dropped' },
          { kind: 'turn_end', time: Date.now(), turnId: 'turn-1', outcome: 'not-a-real-outcome' }
        ]
      }
    });
    expect(reply.status).toBe(200);
    expect(reply.body.stored).toBe(4);

    const events = await readEvents(reply.body.sessionId);
    expect(events.map((event) => event.kind)).toEqual([
      'session_start',
      'user_message',
      'turn_start',
      'assistant_message',
      'turn_end'
    ]);
    const end = events.at(-1)!;
    // An outcome the page invented must not be believed.
    expect(end.kind === 'turn_end' && end.outcome).toBe('unknown');
  });

  it('replaces an impossible timestamp rather than storing it', async () => {
    await pair();
    const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const reply = await request('POST', '/events', {
      body: {
        conversationId,
        events: [{ kind: 'assistant_message', time: Date.now() + 10 * 24 * 3600_000, text: 'from the future', renderedHtml: '<p>from the future</p>', messageId: 'future-a', state: 'streaming' }]
      }
    });
    const events = await readEvents(reply.body.sessionId, { kinds: ['assistant_message'] });
    expect(events[0]!.time).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('preserves ChatGPT creation times from an old chat instead of moving them to reload time', async () => {
    await pair();
    const conversationId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const historical = Date.now() - 90 * 24 * 3600_000;
    const reply = await request('POST', '/events', {
      body: {
        conversationId,
        events: [{ kind: 'assistant_message', time: historical, text: 'historical answer', messageId: 'historical-a', state: 'final', final: true }]
      }
    });
    const events = await readEvents(reply.body.sessionId, { kinds: ['assistant_message'] });
    expect(events[0]!.time).toBe(historical);
  });

  it('stores a message once when a reloaded tab reports it twice', async () => {
    await pair();
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const message = { kind: 'user_message', time: Date.now(), text: 'the original task', messageId: 'msg-a' };
    const first = await request('POST', '/events', { body: { conversationId, events: [message] } });
    const second = await request('POST', '/events', { body: { conversationId, events: [message] } });
    expect(first.body.stored).toBe(1);
    expect(second.body.stored).toBe(0);
    expect(await readEvents(first.body.sessionId, { kinds: ['user_message'] })).toHaveLength(1);
  });

  it('refuses an over-sized body with an answer, not a reset connection', async () => {
    await pair();
    const reply = await request('POST', '/events', { raw: 'x'.repeat(3 * 1024 * 1024) });
    expect(reply.status).toBe(413);
    expect(reply.body.error).toBe('body_too_large');
  });
});

// ---------------------------------------------------------------- activity

describe('activity feed', () => {
  it('reopens a durable still-open chat after recorder memory is lost', async () => {
    await pair();
    const conversationId = '98989898-7777-6666-5555-444444444444';
    const opened = await request('POST', '/events', {
      body: {
        conversationId,
        events: [{ kind: 'turn_start', time: Date.now(), turnId: 'before-restart' }]
      }
    });
    const sessionId = opened.body.sessionId as string;
    expect(sessionId).toBeTruthy();

    resetRecorderForTests();
    expect(liveConversations()).toHaveLength(0);
    await recordToolCall({
      tool: 'read',
      args: { paths: ['/project/after-restart.ts'] },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: Date.now(),
      requestId: 'wfr_activity_restart',
      conversationId
    });
    // Exact request ownership can append durably without recreating the page-liveness map.
    expect(liveConversations()).toHaveLength(0);

    const reply = await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    expect(reply.status).toBe(200);
    expect(reply.body.sessionId).toBe(sessionId);
    expect(reply.body.entries).toHaveLength(1);
    expect(reply.body.entries[0]).toMatchObject({ tool: 'read', requestId: 'wfr_activity_restart' });
    expect(reply.body.pendingTools).toBe(0);
    expect(reply.body.settlingTools).toBe(0);
    expect(liveConversations().some((entry) => entry.conversationId === conversationId)).toBe(true);
  });

  it('atomically registers and verifies a live request id against its chat before the MCP call is filed', async () => {
    await pair();
    const conversationId = '13131313-3535-5757-7979-919191919191';
    const requestId = '77186fb4-bdda-4849-8cd7-879bb08a1617';
    const mapped = await request('POST', '/correlations', {
      body: {
        conversationId,
        calls: [
          {
            messageId: 'page-request-live-handshake',
            tool: 'exec_command',
            order: 0,
            answered: false,
            requestId,
            createTime: Date.now() / 1000
          }
        ]
      }
    });
    expect(mapped.status).toBe(200);
    expect(mapped.body).toMatchObject({
      ok: true,
      conversationId,
      requestIds: [requestId],
      confirmed: [requestId],
      complete: true
    });
    expect(mapped.body.sessionId).toBeTruthy();

    await recordToolCall({
      tool: 'exec_command',
      args: { command: 'echo exact' },
      content: [{ type: 'text', text: 'exact' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: Date.now(),
      requestId,
      evidence: {
        changes: [],
        assets: [],
        count: null,
        detail: null,
        exitCode: 0,
        timedOut: false,
        durationMs: null,
        running: null,
        processSessionId: null
      }
    });

    const calls = await readEvents(mapped.body.sessionId, { kinds: ['tool_call'] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind === 'tool_call' && calls[0].call).toMatchObject({
      requestId,
      conversationId,
      attribution: 'request_id',
      attributionMethod: 'request_id'
    });
  });
  it('registers a request id the page could not yet name a tool for', async () => {
    await pair();
    const conversationId = '16161616-3838-6060-8282-949494949494';
    const requestId = 'wfr-safety-check-held';
    // ChatGPT stamps `metadata.request_id` on the plain public message the moment a turn
    // issues a connector request, and materializes the `api_tool` message — the only one
    // carrying a tool path — once its safety check clears, routinely well past this app's
    // fifteen second evidence window. Requiring a tool name here meant that id was refused
    // while the page could already prove who owned it, and the call was filed under
    // Unattributed activity. The tool name takes no part in the join.
    const mapped = await request('POST', '/correlations', {
      body: {
        conversationId,
        calls: [{ messageId: 'page-message-before-tool-row', requestId, createTime: Date.now() / 1000 }]
      }
    });
    expect(mapped.status).toBe(200);
    expect(mapped.body).toMatchObject({ ok: true, conversationId, confirmed: [requestId], complete: true });

    await recordToolCall({
      tool: 'agents',
      args: { action: 'launch' },
      content: [{ type: 'text', text: 'launched' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: Date.now(),
      requestId
    });

    const calls = await readEvents(mapped.body.sessionId, { kinds: ['tool_call'] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind === 'tool_call' && calls[0].call).toMatchObject({
      requestId,
      conversationId,
      attribution: 'request_id'
    });
  });

  it('still refuses correlation evidence that names no request id at all', async () => {
    await pair();
    const refused = await request('POST', '/correlations', {
      body: {
        conversationId: '17171717-3939-6161-8383-959595959595',
        calls: [{ messageId: 'page-message-with-nothing-to-join-on', tool: 'agents', order: 0 }]
      }
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: 'bad_request_evidence' });
  });

  it('refuses a live handshake that contradicts an already-proven request owner without poisoning the original mapping', async () => {
    await pair();
    const firstConversation = '14141414-3636-5858-8080-929292929292';
    const secondConversation = '15151515-3737-5959-8181-939393939393';
    const requestId = 'wfr-live-owner-cannot-move';
    const call = {
      messageId: 'page-request-owner-fixed',
      tool: 'exec_command',
      order: 0,
      answered: false,
      requestId,
      createTime: Date.now() / 1000
    };

    const first = await request('POST', '/correlations', {
      body: { conversationId: firstConversation, calls: [call] }
    });
    expect(first.body).toMatchObject({ confirmed: [requestId], conflicts: [], complete: true });

    const second = await request('POST', '/correlations', {
      body: { conversationId: secondConversation, calls: [call] }
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ confirmed: [], conflicts: [requestId], complete: false });

    await recordToolCall({
      tool: 'exec_command',
      args: { command: 'echo owner-stays-first' },
      content: [{ type: 'text', text: 'owner-stays-first' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: Date.now(),
      requestId,
      evidence: {
        changes: [],
        assets: [],
        count: null,
        detail: null,
        exitCode: 0,
        timedOut: false,
        durationMs: null,
        running: null,
        processSessionId: null
      }
    });

    const firstCalls = await readEvents(first.body.sessionId, { kinds: ['tool_call'] });
    expect(firstCalls.some((event) =>
      event.kind === 'tool_call' && event.call.requestId === requestId && event.call.conversationId === firstConversation
    )).toBe(true);
    const secondCalls = await readEvents(second.body.sessionId, { kinds: ['tool_call'] });
    expect(secondCalls).toEqual([]);
  });

  it('hands back an app-owned render stream plus legacy tool summaries, with no raw tool I/O', async () => {
    await pair();
    const conversationId = '99999999-8888-7777-6666-555555555555';
    await request('POST', '/events', {
      body: { conversationId, events: [
          { kind: 'user_message', time: Date.now(), text: 'private user text stays out of the render anchor', messageId: 'user-anchor-42' },
          { kind: 'turn_start', time: Date.now(), turnId: 'turn-42' },
          { kind: 'page_tool', time: Date.now(), turnId: 'turn-42', text: 'Searched the web', messageId: 'native-1' },
          { kind: 'tool_block', time: Date.now(), turnId: 'turn-42', count: 1 }
        ]
      }
    });
    await recordToolCall({
      tool: 'apply_patch',
      args: { patch: '*** Begin Patch\n*** Update File: /project/src/main.ts\n*** End Patch', secretish: 'value' },
      content: [{ type: 'text', text: 'edited' }],
      outcome: 'ok',
      durationMs: 30,
      startedAt: Date.now(),
      requestId: 'wfr_bridge_patch',
      conversationId,
      evidence: {
        changes: [{ path: '/project/src/main.ts', added: 18, removed: 4, approximate: false }],
        assets: [],
        count: null,
        detail: null,
        exitCode: null,
        timedOut: false,
        durationMs: null,
        running: null,
        processSessionId: null
      }
    });

    const reply = await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    expect(reply.status).toBe(200);
    expect(reply.body.entries).toHaveLength(1);
    const entry = reply.body.entries[0];
    expect(entry.turnId).toBe('turn-42');
    expect(entry.attribution).toBe('request_id');
    expect(entry.summary.title).toBe('Edited src/main.ts');
    expect(entry.summary.metric).toBe('+18 −4');
    expect(entry.generating).toBeUndefined();
    expect(entry).not.toHaveProperty('args');
    expect(entry).not.toHaveProperty('argsTruncated');
    expect(entry).not.toHaveProperty('result');
    expect(reply.body.userAnchors).toHaveLength(1);
    expect(reply.body.userAnchors[0]).toMatchObject({ messageId: 'user-anchor-42' });
    expect(reply.body.userAnchors[0]).not.toHaveProperty('text');
    expect(reply.body.stream.map((item: any) => item.kind)).toEqual(['turn_start', 'page_tool', 'tool_call']);
    expect(reply.body.stream[1]).toMatchObject({
      turnId: 'turn-42',
      kind: 'page_tool',
      label: 'Searched the web',
      messageId: 'native-1'
    });
    expect(reply.body.stream[2]).toMatchObject({
      turnId: 'turn-42',
      tool: 'apply_patch',
      summary: { title: 'Edited src/main.ts', metric: '+18 −4' }
    });
    expect(reply.body.stream[2]).not.toHaveProperty('args');
    expect(reply.body.stream[2]).not.toHaveProperty('result');
    expect(reply.body.generating).toBe(true);
  });

  /**
   * The page folds the chat's first user message away when this says so, and that message
   * is the handoff brief or the worker bootstrap — a screenful of machinery the user did
   * not type. It is read off the session record rather than remembered in the tab, so it
   * still holds when the chat is reopened days later.
   */
  it('says whether the app opened this chat itself, and how', async () => {
    await pair();
    const worker = '66666666-3333-2222-1111-000000000000';
    const own = '77777777-3333-2222-1111-000000000000';
    await noteChatOrigin(worker, { kind: 'worker', fromSessionId: null, agentId: 'worker-1', task: 'Build it' });
    for (const conversationId of [worker, own]) {
      await request('POST', '/events', {
        body: { conversationId, events: [{ kind: 'turn_start', time: Date.now(), turnId: 'turn-1' }] }
      });
    }

    expect((await request('GET', `/activity?conversationId=${worker}`)).body.bootstrap).toBe('worker');
    // A chat the user started themselves has nothing to fold away.
    expect((await request('GET', `/activity?conversationId=${own}`)).body.bootstrap).toBeNull();
  });

  it('returns nothing for a conversation it has never seen', async () => {
    await pair();
    const reply = await request('GET', '/activity?conversationId=deadbeef-0000-0000-0000-000000000000');
    expect(reply.status).toBe(200);
    expect(reply.body.entries).toEqual([]);
    expect(reply.body.sessionId).toBeNull();
  });

  /**
   * A chat ChatGPT has only just named, which the recorder has not attached to yet.
   *
   * The feed is empty then, and it used to answer with no goal at all — so the sheet above a
   * New Chat opened on a loop read the reply as "nothing is driving this chat" the moment its
   * id landed: the slider fell to Off, the task the user had just written vanished from it,
   * and it said an API key was missing while the model that wrote the opening message was
   * still streaming. None of that is a fact about the recorder. The switch, the task and the
   * draft are keyed by conversation and durable, so they are answered from the first poll.
   */
  it('answers what drives a chat before the recorder has attached to it', async () => {
    await pair();
    const chat = 'cafe0044-0000-4000-8000-000000000044';
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: false, mode: 'goal' } });
    await writeDurableNow(GOAL_SWITCHES_STATE, null);

    // Exactly what a New Chat's opening does: the goal is bound as a loop before anything
    // this chat says has been recorded.
    const saved = await request('POST', '/goal/objective', {
      body: { conversationId: chat, text: 'one cycle stop', mode: 'loop' }
    });
    expect(saved.status).toBe(200);

    const feed = await request('GET', `/activity?conversationId=${chat}`);
    expect(feed.status).toBe(200);
    expect(feed.body.sessionId).toBeNull();
    expect(feed.body.entries).toEqual([]);
    expect(feed.body.goal).toMatchObject({
      enabled: true,
      own: true,
      mode: 'loop',
      objective: 'one cycle stop',
      blocked: ''
    });
    // The app-wide default is still off: this chat answers for itself and says so.
    expect(getConfig().goal.enabled).toBe(false);
  });

  it('pages by sequence number so the extension never re-reads what it has', async () => {
    await pair();
    const conversationId = '12121212-3434-5656-7878-909090909090';
    await request('POST', '/events', {
      body: { conversationId, events: [
          { kind: 'turn_start', time: Date.now(), turnId: 't' },
          { kind: 'tool_block', time: Date.now(), turnId: 't', count: 4 }
        ]
      }
    });
    for (let i = 0; i < 3; i++) {
      await recordToolCall({
        tool: 'read_file',
        args: { path: `/project/f${i}.ts` },
        content: [{ type: 'text', text: 'body' }],
        outcome: 'ok',
        durationMs: 2,
        startedAt: Date.now(),
        requestId: `wfr_bridge_page_${i}`,
        conversationId
      });
    }
    // A later user message is not rendered in the assistant stream, but it still advances
    // the shared sequence cursor so the browser cannot re-read it forever.
    await request('POST', '/events', {
      body: { conversationId, events: [{ kind: 'user_message', time: Date.now(), text: 'next question', messageId: 'next-q' }] }
    });
    const all = await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    expect(all.body.entries).toHaveLength(3);
    const lastSeq = all.body.entries.at(-1).seq;
    expect(all.body.nextSince).toBeGreaterThan(lastSeq + 1);
    const after = await request('GET', `/activity?conversationId=${conversationId}&since=${all.body.nextSince}`);
    expect(after.body.entries).toEqual([]);
    expect(after.body.stream).toEqual([]);
    expect(after.body.nextSince).toBe(all.body.nextSince);
  });

  it('never sends a credential argument through session history or the extension activity feed', async () => {
    await pair();
    const conversationId = '45454545-6767-8989-abab-cdcdcdcdcdcd';
    await request('POST', '/events', {
      body: { conversationId, events: [
          { kind: 'turn_start', time: Date.now(), turnId: 'secret-turn' },
          { kind: 'tool_block', time: Date.now(), turnId: 'secret-turn', count: 2 }
        ]
      }
    });
    // The credentials this app still handles all arrive the same way: a user pastes one
    // into a `secret` argument. It must not reach disk, session history or the feed.
    const secret = 'bridge-token-9f2c4d6e8a0b2c4d6e8a1f3b';
    await recordToolCall({
      tool: 'read_file',
      args: { path: '/project/secret.ts', secret },
      content: [{ type: 'text', text: 'could not read secret.ts' }],
      // Failed summaries may copy the first result line into summary.detail, so this
      // exercises the leak path that an otherwise-successful call would not touch.
      outcome: 'tool_internal_error',
      durationMs: 2,
      startedAt: Date.now(),
      requestId: 'wfr_bridge_secret',
      conversationId
    });

    const reply = await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    expect(reply.body.entries).toHaveLength(1);
    const serialised = JSON.stringify(reply.body.entries[0]);
    expect(serialised).not.toContain(secret);
    expect(reply.body.entries[0]).not.toHaveProperty('args');
    expect(reply.body.entries[0]).not.toHaveProperty('result');
    expect(JSON.stringify(reply.body.stream)).not.toContain(secret);
    const stored = JSON.stringify(await readEvents(reply.body.sessionId));
    expect(stored).not.toContain(secret);
    expect(stored).toContain('<removed>');
  });

  /**
   * There is no live worker code any more, and no sentence that hands one out.
   *
   * This used to cover the reply `agents action=join` sent a worker: a three-character
   * routing code in prose, which went to disk, to session history and to the Activity feed
   * verbatim, and which had to be cut out by matching the sentence that published it. A
   * worker is identified by the conversation it is in, so nothing is published, nothing has
   * to be cut, and the recovery key that was the last credential here is gone with it.
   */
  it('writes no credential of any kind into an agents call it recorded', async () => {
    await pair();
    const conversationId = '56565656-7878-9a9a-bcbc-dedededede00'.slice(0, 36);
    await request('POST', '/events', {
      body: {
        conversationId,
        events: [
          { kind: 'turn_start', time: Date.now(), turnId: 'agents-turn' },
          { kind: 'tool_block', time: Date.now(), turnId: 'agents-turn', count: 1 }
        ]
      }
    });
    spawn({ workers: [{ task: 'security check' }], caller: { conversationId: PRIME_CHAT } });

    await recordToolCall({
      tool: 'agents',
      args: { action: 'finish', result: 'RESULT one path can misattribute a call.' },
      content: [{ type: 'text', text: 'Reported to prime. This worker is done.' }],
      outcome: 'ok',
      durationMs: 2,
      startedAt: Date.now()
    });

    const reply = await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    const stored = JSON.stringify(await readEvents(reply.body.sessionId));
    for (const written of [JSON.stringify(reply.body), stored]) {
      expect(written).not.toMatch(/agent[_ ]?key|join[_ ]?key|recovery key/i);
    }
  });
});

// ---------------------------------------------------------------- commands

/**
 * One command, one chat, one delivery.
 *
 * The queue used to be a pull: the app parked a bootstrap and waited for some ChatGPT tab
 * to poll for it, under a lease that was renewed while a page said it was still working,
 * and re-offered when it lapsed. All of that is gone. The app opens the exact chat, the one
 * page holding the marker redeems it, and the page reports which conversation it became —
 * which for a worker is the moment that worker starts existing.
 */
/**
 * When a chat is compacted on its own.
 *
 * Two halves, deliberately kept apart. The session store knows the level — this chat is
 * over the configured threshold — and the bridge knows the thing only an open connection can
 * know: whether ChatGPT is answering right now. Both must be true, and the second is the one
 * that keeps an old, enormous chat silent when it is merely opened and read. The decision is
 * the app's: it files the durable ticket on the evidence that the chat is working, and the
 * page resumes the ticket — so a page that has frozen mid-turn is still compacted.
 */
describe('automatic compaction', () => {
  const settled = () => new Promise((resolve) => setTimeout(resolve, 25));

  const over = (): unknown[] => [
    { kind: 'user_message', time: Date.now(), text: 'x'.repeat(44_000), messageId: 'over-the-line' }
  ];

  async function withThreshold(tokens: number, run: () => Promise<void>): Promise<void> {
    const base = getConfig();
    await saveConfig({ ...base, compaction: { ...base.compaction, auto: true, autoTokens: tokens } });
    try {
      await run();
    } finally {
      await saveConfig(base);
    }
  }

  it('files the ticket itself for a working chat over the line, once, and never for a finished one', async () => {
    await pair();
    const conversationId = 'a1a1a1a1-0000-4000-8000-00000000ac01';
    await withThreshold(10_000, async () => {
      await request('POST', '/events', {
        body: {
          conversationId,
          events: [{ kind: 'turn_start', time: Date.now(), turnId: 'turn-live' }, ...over()]
        }
      });
      await settled();
      const working = await request('GET', `/activity?conversationId=${conversationId}`);
      const sessionId = working.body.sessionId as string;
      const ticket = continuationForSession(sessionId);
      expect(ticket).toMatchObject({ automatic: true, state: 'awaiting-summary', from: conversationId });
      // The page reads the ticket back as its job and resumes it; nothing else is asked of it.
      expect(working.body.job).toMatchObject({ stage: 'handoff-pending', automatic: true });

      // More work in the same turn is the same ticket.
      await request('POST', '/events', {
        body: { conversationId, events: [{ kind: 'turn_start', time: Date.now(), turnId: 'turn-live' }] }
      });
      await settled();
      expect(continuationForSession(sessionId)?.token).toBe(ticket!.token);

      // Auto Off cancels it; the chat finishing its answer does not earn another one. Still
      // far over the line, and deliberately untouched: there is nothing left to carry into a
      // fresh chat once the answer has been written.
      expect((await request('POST', '/settings', { body: { conversationId, autoCompact: false } })).status).toBe(200);
      expect((await request('POST', '/settings', { body: { conversationId, autoCompact: true } })).status).toBe(200);
      await request('POST', '/events', {
        body: {
          conversationId,
          events: [{ kind: 'turn_end', time: Date.now(), turnId: 'turn-live', outcome: 'completed' }]
        }
      });
      await settled();
      const finished = await request('GET', `/activity?conversationId=${conversationId}`);
      expect(finished.body.tokens).toBeGreaterThan(10_000);
      expect(continuationForSession(sessionId)).toBeNull();
    });
  });

  /**
   * Block is the user's stop for a chat: its tools are refused. The loop, a goal and the
   * automatic compaction are three more hands this app has on the same chat, and each one
   * would carry ChatGPT on without those tools — the loop typing the next message, a resume
   * opening a replacement chat the block does not even cover. So the block fences all of them,
   * says why on the feed, and lifts cleanly when the chat is released.
   */
  it('suspends Goal, Loop and compaction for a chat the user blocked, until it is released', async () => {
    await pair();
    const conversationId = 'b10cced0-0000-4000-8000-00000000ac05';
    await request('POST', '/goal/objective', { body: { conversationId, text: 'finish the level editor' } });
    await request('POST', '/settings', { body: { conversationId, loop: true } });
    setChatBlocked(conversationId, true);
    try {
      await withThreshold(10_000, async () => {
        await request('POST', '/events', {
          body: {
            conversationId,
            events: [{ kind: 'turn_start', time: Date.now(), turnId: 'blocked-turn-live' }, ...over()]
          }
        });
        await settled();
        const activity = await request('GET', `/activity?conversationId=${conversationId}`);
        expect(activity.body.tokens).toBeGreaterThan(10_000);
        expect(continuationForSession(activity.body.sessionId as string)).toBeNull();
        expect(activity.body.context).toMatchObject({ auto: false });
        expect(activity.body.goal).toMatchObject({ enabled: false, own: true, blocked: 'blocked', pending: null });
        expect(pendingCommands().some((command) => command.what.startsWith('resume:'))).toBe(false);

        const manual = await request('POST', '/compact', { body: { conversationId } });
        expect(manual.status).toBe(409);
        expect(manual.body.error).toBe('chat_blocked');
        const goalOn = await request('POST', '/settings', { body: { conversationId, goal: true } });
        expect(goalOn.status).toBe(409);
        expect(goalOn.body.error).toBe('chat_blocked');
        const autoOn = await request('POST', '/settings', { body: { conversationId, autoCompact: true } });
        expect(autoOn.status).toBe(409);
        expect(autoOn.body.error).toBe('chat_blocked');
        const newGoal = await request('POST', '/goal/objective', { body: { conversationId, text: 'something else' } });
        expect(newGoal.status).toBe(409);
        expect(newGoal.body.error).toBe('chat_blocked');
        // Turning things off stays the user's to do from either side.
        const loopOff = await request('POST', '/settings', { body: { conversationId, loop: false } });
        expect(loopOff.status).toBe(200);
        const draft = await request('POST', '/goal/draft', {
          body: { conversationId, turnId: 'blocked-turn-live', clientId: 'tab-1' }
        });
        expect(draft.status).toBe(409);
        expect(draft.body.error).toBe('goal_disabled');
        expect(pendingCommands().some((command) => command.what.startsWith('resume:'))).toBe(false);
      });

      // Released: the stored goal is still there and the loop is back on the chat's own terms.
      setChatBlocked(conversationId, false);
      const released = await request('GET', `/activity?conversationId=${conversationId}`);
      expect(released.body.goal).toMatchObject({ blocked: '', objective: 'finish the level editor' });
      expect(released.body.context).toMatchObject({ auto: true });
    } finally {
      resetBlockedChatsForTests();
    }
  });

  it('never compacts a worker out of the conversation that is its agent identity', async () => {
    await pair();
    const conversationId = 'a1a1a1a1-0000-4000-8000-00000000ac04';
    spawn({ workers: [{ task: 'stay in this worker chat' }], caller: { conversationId: PRIME_CHAT } });
    expect(bindConversation('worker-1', conversationId)).toBe(true);

    await withThreshold(10_000, async () => {
      await request('POST', '/events', {
        body: {
          conversationId,
          events: [{ kind: 'turn_start', time: Date.now(), turnId: 'worker-turn-live' }, ...over()]
        }
      });
      await settled();
      const activity = await request('GET', `/activity?conversationId=${conversationId}`);
      expect(activity.body.tokens).toBeGreaterThan(10_000);
      expect(continuationForSession(activity.body.sessionId as string)).toBeNull();
      expect(activity.body.context).toMatchObject({ auto: false, threshold: 10_000 });
      expect(pendingCommands().some((command) => command.what.startsWith('resume:'))).toBe(false);

      const manual = await request('POST', '/compact', { body: { conversationId } });
      expect(manual.status).toBe(409);
      expect(manual.body.error).toBe('worker_compaction_disabled');
      const settings = await request('POST', '/settings', {
        body: { conversationId, autoCompact: false }
      });
      expect(settings.status).toBe(409);
      expect(settings.body.error).toBe('worker_compaction_disabled');
      expect(getConfig().compaction.auto).toBe(true);
      // No compaction path may create the replacement-chat transport a worker is forbidden to
      // use. Its conversation remains its agent identity.
      expect(pendingCommands().some((command) => command.what.startsWith('resume:'))).toBe(false);
    });
  });

  it('files an automatic ticket before page work, cancels it on Auto Off, and does not refile on On', async () => {
    await pair();
    const conversationId = 'a1a1a1a1-0000-4000-8000-00000000ac05';
    await request('POST', '/events', {
      body: {
        conversationId,
        events: [{ kind: 'user_message', time: Date.now(), text: 'keep the long run going', messageId: 'm-auto-ticket' }]
      }
    });
    const session = await findSessionByConversation(conversationId, { requireUnique: true });
    expect(session).not.toBeNull();

    const filed = await request('POST', '/compact', {
      body: { conversationId, ticket: true, automatic: true }
    });
    expect(filed.status).toBe(202);
    expect(filed.body).toMatchObject({ filed: true, prompt: null });
    const token = filed.body.token as string;
    expect(continuationByToken(token)).toMatchObject({ automatic: true, state: 'awaiting-summary' });

    const off = await request('POST', '/settings', { body: { conversationId, autoCompact: false } });
    expect(off.status).toBe(200);
    expect(continuationByToken(token)?.state).toBe('aborted');

    expect((await request('POST', '/settings', { body: { conversationId, autoCompact: true } })).status).toBe(200);
    expect(continuationForSession(session!.id)).toBeNull();
  });

  /**
   * Before the prompt has reached ChatGPT the pickup is a two-minute clock with five raised
   * reloads, and a ticket that still has not been sent after them is abandoned: nothing was
   * fenced, and the next working turn opens a fresh one. Every pickup asks for the tab in front.
   */
  it('reloads an unsent automatic ticket in front every 2 minutes, then gives it up after five', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      const conversationId = 'a1a1a1a1-0000-4000-8000-00000000ac06';
      await request('POST', '/events', {
        body: {
          conversationId,
          events: [{ kind: 'user_message', time: Date.now(), text: 'generate the huge handoff', messageId: 'm-auto-watch' }]
        }
      });
      const filed = await request('POST', '/compact', {
        body: { conversationId, ticket: true, automatic: true }
      });
      const token = filed.body.token as string;

      const takeRepair = async (): Promise<{ conversationId: string; token: string; reason: string; focus: boolean } | null> => {
        await sweepStaleSwarm(Date.now());
        return (await request('GET', '/status')).body.repairs?.[0] ?? null;
      };
      await vi.advanceTimersByTimeAsync(2 * 60_000 - 1);
      expect(await takeRepair()).toBeNull();

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await vi.advanceTimersByTimeAsync(attempt === 0 ? 1 : 2 * 60_000);
        const handout = await takeRepair();
        expect(handout).toMatchObject({ conversationId, reason: 'compaction', focus: true });
        await request('GET', `/status?repaired=${handout!.token}&repairAction=reloaded`);
        expect(continuationByToken(token)).toMatchObject({ state: 'awaiting-summary' });
      }

      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(await takeRepair()).toBeNull();
      expect(continuationByToken(token)).toMatchObject({ state: 'aborted', error: 'handoff_never_sent' });
      expect(continuationForSession(filed.body.sessionId as string)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Once the marked prompt is with ChatGPT the pickup is a five-minute clock with three reloads,
   * so a glitched writing page costs a quarter of an hour at most rather than three of them. The
   * ticket itself is never failed by a pickup here; it stays open for the page to finish. The
   * writing phase's three are its own — the asking phase spent none of them.
   */
  it('reloads one automatic ticket at 5-minute checkpoints while the brief is being written', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      const conversationId = 'a1a1a1a1-0000-4000-8000-00000000ac07';
      await request('POST', '/events', {
        body: {
          conversationId,
          events: [{ kind: 'user_message', time: Date.now(), text: 'generate the huge handoff', messageId: 'm-auto-watch-2' }]
        }
      });
      const filed = await request('POST', '/compact', {
        body: { conversationId, ticket: true, automatic: true }
      });
      const token = filed.body.token as string;

      const takeRepair = async (): Promise<{ conversationId: string; token: string; reason: string } | null> => {
        await sweepStaleSwarm(Date.now());
        return (await request('GET', '/status')).body.repairs?.[0] ?? null;
      };
      // One asking-phase pickup spent before the page gets the prompt out.
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      const asking = await takeRepair();
      expect(asking).toMatchObject({ conversationId, reason: 'compaction' });
      await request('GET', `/status?repaired=${asking!.token}&repairAction=reloaded`);

      expect((await request('POST', '/compact', { body: { conversationId, token, sourceAttempt: true } })).body.allowed).toBe(true);
      expect((await request('POST', '/compact', { body: { conversationId, token, sourceDispatch: true } })).body.armed).toBe(true);
      expect(continuationByToken(token)?.sourceSend.state).toBe('dispatched-unresolved');

      await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
      expect(await takeRepair()).toBeNull();

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await vi.advanceTimersByTimeAsync(attempt === 0 ? 1 : 5 * 60_000);
        const handout = await takeRepair();
        expect(handout).toMatchObject({ conversationId, reason: 'compaction' });
        await request('GET', `/status?repaired=${handout!.token}&repairAction=reloaded`);
      }

      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
      expect(await takeRepair()).toBeNull();
      expect(continuationByToken(token)).toMatchObject({ automatic: true, state: 'awaiting-summary' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('delivering a bootstrap', () => {
  async function prepareExpiredDocumentOwnedRevivalRestoreFixture(options: {
    workerConversation: string;
    resumeConversation: string;
    client: string;
  }): Promise<{
    revivalId: string;
    resumeId: string;
    continuationSnapshot: ContinuationSnapshot;
    durableSwarm: SwarmSnapshot;
  }> {
    await pair();
    spawn({ workers: [{ task: 'become the stale document-owned revival' }], caller: { conversationId: PRIME_CHAT } });
    const bootstrap = await redeem();
    await request('POST', '/commands/ack', {
      body: { id: bootstrap.id, status: 'sent', conversationId: options.workerConversation, agent: 'worker-1' }
    });
    finishAgent({ conversationId: options.workerConversation }, 'sleep before restore reconciliation');
    wake([{ to: 'worker-1', text: 'this browser-owned wake will expire before restart' }]);
    const { id: revivalId } = await waitForRevival();
    expect(opened).toHaveLength(1);
    const claimed = await request('POST', '/commands/redeem', {
      body: { id: revivalId, client: options.client, conversationId: options.workerConversation }
    });
    expect(claimed.status).toBe(200);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'waking',
      revivable: false
    });

    // Queue an unrelated valid command behind the document-owned revival. Its presence is what
    // makes these tests about restore atomicity/publication rather than merely pruning one row.
    const resume = await compactedSession(options.resumeConversation, 'resume after restore reconciliation');
    const resumeCommand = queueResume(resume.sessionId, resume.token)!;
    await waitForOpened(2);
    await flushDurable();

    const continuationSnapshot = await readDurable<ContinuationSnapshot>(CONTINUATIONS_STATE);
    const durableSwarm = await readDurable<SwarmSnapshot>('swarm');
    expect(continuationSnapshot).not.toBeNull();
    expect(durableSwarm).not.toBeNull();

    await stopBridge();
    await flushDurable();
    const durableCommands = await readDurable<any>('bridge-commands');
    const revival = durableCommands?.commands?.find((entry: any) => entry?.id === revivalId);
    const resumeRow = durableCommands?.commands?.find((entry: any) => entry?.id === resumeCommand.id);
    expect(revival).toMatchObject({ phase: 'leased', owner: options.client });
    expect(resumeRow).toBeTruthy();
    const expiredAt = Date.now() - 30 * 60_000 - 5_000;
    revival.createdAt = expiredAt;
    revival.claimedAt = expiredAt;
    await writeDurableNow('bridge-commands', durableCommands);

    resetBridgeForTests();
    opened.length = 0;
    setBrowserOpener(async (url) => {
      opened.push(url);
    });
    await restoreContinuations(continuationSnapshot!);
    return {
      revivalId,
      resumeId: resumeCommand.id,
      continuationSnapshot: continuationSnapshot!,
      durableSwarm: durableSwarm!
    };
  }

  it('does not publish or deliver a bridge start after stop begins', async () => {
    // Model Cmd+Q/settings stop while a fresh bridge is between listen() and startup recovery.
    // An invited worker already exists in broker state, so registering the startup replay
    // listener is enough to queue and deliver a browser bootstrap. The old stopBridge() waited
    // for all of that to finish before stopping the socket, which opened ChatGPT after shutdown
    // had begun even though the final bridge state was correctly "stopped".
    await stopBridge();
    resetBridgeForTests();
    opened.length = 0;
    setBrowserOpener(async (url) => {
      opened.push(url);
    });
    resetSwarm();
    spawn({ workers: [{ task: 'must not open during shutdown' }], caller: { conversationId: PRIME_CHAT } });
    expect(pendingWorkerSpawns()).toHaveLength(1);

    const starting = startBridge();
    const stopping = stopBridge();
    await Promise.all([starting, stopping]);

    expect(opened).toEqual([]);
    expect(bridgePort()).toBeNull();
    expect(pendingCommands()).toEqual([]);

    // Restore the suite's ordinary live bridge without replaying the deliberately cancelled run.
    resetSwarm();
    resetBridgeForTests();
    setBrowserOpener(async (url) => {
      opened.push(url);
    });
    const restarted = await startBridge();
    expect(restarted).not.toBeNull();
    base = `http://127.0.0.1:${restarted}`;
    opened.length = 0;
  });

  it('lets a newer start win over a queued stop while the previous start is still settling', async () => {
    await stopBridge();
    resetBridgeForTests();
    resetSwarm();

    // A = start already in flight. The stop invalidates A immediately, then B expresses the
    // newest desired state before A has even finished its listen callback. The old bridgeStarting
    // design made B join A's now-cancelled promise, so both starts returned null and the bridge
    // stayed off even though the last request was "start".
    const startA = startBridge();
    const stop = stopBridge();
    const startB = startBridge();
    const [a, , b] = await Promise.all([startA, stop, startB]);

    expect(a).toBeNull();
    expect(b).not.toBeNull();
    expect(bridgePort()).toBe(b);
    base = `http://127.0.0.1:${b}`;
  });

  it('makes final app shutdown terminal even if a later settings save asks to start the bridge', async () => {
    // Ordinary stop/start deliberately uses latest intent so a rapid Settings toggle can recover.
    // Final app shutdown is different: an IPC settings handler that was already awaiting config or
    // persistence when Cmd+Q began can resume afterwards and call startBridge(). That stale runtime
    // work must not reopen localhost admission or browser delivery during bounded teardown.
    const shuttingDown = shutdownBridge();
    const staleSettingsStart = startBridge();
    const [, restarted] = await Promise.all([shuttingDown, staleSettingsStart]);

    expect(restarted).toBeNull();
    expect(bridgePort()).toBeNull();

    // Test process continues after simulating final shutdown; a real Electron process exits here.
    resetBridgeForTests();
    const restored = await startBridge();
    expect(restored).not.toBeNull();
    base = `http://127.0.0.1:${restored}`;
  });

  it('opens the chat, hands the brief to the page that redeems it, and forgets it on success', async () => {
    await pair();
    expect(pendingCommands()).toEqual([]);

    const { sessionId, token } = await compactedSession('11111111-2222-3333-4444-555555555555', 'NEXT — finish the bridge rewrite.');
    const command = queueResume(sessionId, token);
    expect(command).not.toBeNull();
    // Opened by the app after the leased command phase is durable, with nothing having asked
    // for it. The disk boundary is asynchronous even though no browser poll is involved.
    await waitForOpened(1);
    expect(opened).toEqual([commandUrl(command!.id)]);

    // The brief itself is what gets typed: there is no tool call to make and no id to quote.
    const redeemed = await redeem(command!.id);
    expect(redeemed.id).toBe(command!.id);
    expect(redeemed.kind).toBe('open-chat');
    // This is browser authority, not presentation metadata. content.js arms hidden-tab Goal
    // recovery only for a real Compact & Resume replacement after its ACK; without the wire type
    // the production bridge looked identical to a worker bootstrap here even though content-script
    // unit tests supplied a mocked `type: 'resume'`.
    expect(redeemed.type).toBe('resume');
    expect(redeemed.text).toContain('NEXT — finish the bridge rewrite.');

    const ack = await request('POST', '/commands/ack', {
      body: { id: command!.id, status: 'sent', conversationId: 'abcdef12-3456-7890-abcd-ef1234567890' }
    });
    expect(ack.status).toBe(200);
    expect(ack.body.committed).toBe(true);
    expect(pendingCommands()).toEqual([]);
  });

  it('protects a resume destination before the browser opener can record a shadow session', async () => {
    await pair();
    const from = '91919191-1111-2222-3333-444444444444';
    const destination = '92929292-1111-2222-3333-444444444444';
    const { sessionId, token: continuation } = await compactedSession(from, 'carry this session forward');
    let earlyObservation: Promise<{ sessionId: string | null; stored: number }> | null = null;

    // This is the live 2026-08-25 race: the replacement page can expose conversation B and
    // flush an already-journalled observation before B has redeemed its continuation marker.
    // Unless the bridge announces the pending replacement *before* opening the browser, the
    // recorder eagerly creates a second local session for B. The later ACK then refuses the
    // real A→B move with "the replacement chat already belongs to another local session".
    setBrowserOpener(async () => {
      earlyObservation = recordChatObservations(destination, [
        { kind: 'conversation_title', time: Date.now(), text: 'Resumed · carry this session forward' }
      ]);
    });

    const command = queueResume(sessionId, continuation)!;
    await vi.waitFor(() => expect(earlyObservation).not.toBeNull());

    const redeemed = await request('POST', '/commands/redeem', {
      body: { id: command.id, client: 'resume-tab-before-recorder' }
    });
    expect(redeemed.status).toBe(200);

    const ack = await request('POST', '/commands/ack', {
      body: {
        id: command.id,
        status: 'sent',
        conversationId: destination,
        client: 'resume-tab-before-recorder'
      }
    });
    expect(ack.status).toBe(200);
    expect(ack.body.committed).toBe(true);
    await expect(earlyObservation!).resolves.toMatchObject({ sessionId });
    expect((await getSession(sessionId))?.conversationId).toBe(destination);
  });

  /**
   * Document ownership is replaceable up to the click and never past it.
   *
   * Holding the claim is not having sent: it is written before the composer is submitted at
   * all, so a page that dies there left nothing behind and the next page may have the prompt.
   * Arming is the opposite — the click comes first and its acceptance only seconds later — so
   * from there on no page is offered this bootstrap again.
   */
  it('lets a reloaded page adopt a resume until one arms the click, and refuses every page afterwards', async () => {
    await pair();
    const { sessionId, token } = await compactedSession('99999999-8888-7777-6666-555555555555', 'the only brief');
    const command = queueResume(sessionId, token)!;

    expect((await redeem(command.id, 'tab-1')).text).toContain('the only brief');
    const second = await request('POST', '/commands/redeem', { body: { id: command.id, client: 'tab-2' } });
    expect(second.status).toBe(200);

    const claimed = await request('POST', '/compact', { body: { token, destinationAttempt: true } });
    expect(claimed.body.allowed).toBe(true);
    expect((await redeem(command.id, 'tab-3')).text).toContain('the only brief');

    const armed = await request('POST', '/compact', { body: { token, destinationDispatch: true } });
    expect(armed.body.armed).toBe(true);
    expect((await request('POST', '/commands/redeem', { body: { id: command.id, client: 'tab-3' } })).status).toBe(409);
    expect((await request('POST', '/commands/redeem', { body: { id: command.id, client: 'tab-4' } })).status).toBe(409);
  });

  it('offers the brief to a fresh chat once the page proves it lost the draft before Send', async () => {
    // 2026-09-02: the replacement chat opened, the brief landed, and the user's Escape emptied
    // the composer in the same instant. The ticket then sat armed for its six hours, the page
    // journalled nothing typed into it, and the run could not move on.
    await pair();
    const { sessionId, token } = await compactedSession('99999999-8888-7777-6666-555555555556', 'the lost brief');
    const command = queueResume(sessionId, token)!;
    expect((await redeem(command.id, 'tab-1')).text).toContain('the lost brief');
    expect((await request('POST', '/compact', { body: { token, destinationAttempt: true } })).body.allowed).toBe(true);
    expect((await request('POST', '/compact', { body: { token, destinationDispatch: true } })).body.armed).toBe(true);
    expect((await request('POST', '/commands/redeem', { body: { id: command.id, client: 'tab-2' } })).status).toBe(409);

    const before = opened.length;
    const lost = await request('POST', '/compact', { body: { token, destinationLost: true } });
    expect(lost.status).toBe(200);
    expect(lost.body.released).toBe(true);
    // The lease went with the page that lost the draft, and a fresh chat opens for the same
    // brief at once instead of waiting out the quarter-hour lease.
    expect((await request('POST', '/commands/redeem', { body: { id: command.id, client: 'tab-1' } })).status).toBe(404);
    await vi.waitFor(() => expect(opened.length).toBeGreaterThan(before));
    const reopened = new URL(opened[opened.length - 1]!).searchParams.get('clf')!;
    expect(reopened).not.toBe(command.id);
    expect((await redeem(reopened, 'tab-3')).text).toContain('the lost brief');
    expect((await request('POST', '/compact', { body: { token: 'ffffffffffffffffffffffffffffffff', destinationLost: true } })).status).toBe(409);
  });

  it('aborts a resume whose commit the session layer refused, so chat A is not left waiting on it', async () => {
    // 2026-09-01: the marked replacement message committed, the session layer refused the
    // commit, and the 409 went back with the continuation still `claimed`. Nothing retries a
    // claimed continuation, an automatic one never expires, and chat A's control reads its
    // state off that record — so A sat behind "opening the new chat" and B, never bound,
    // called tools as nobody. A refusal is final: the session stays in A and A is told.
    await pair();
    const chatA = 'a1a1a1a1-2222-4333-8444-555555555555';
    const chatB = 'b1b1b1b1-2222-4333-8444-555555555555';
    spawn({ workers: [{ task: 'keep a swarm bound to A' }], caller: { conversationId: chatA } });
    const { sessionId, token } = await compactedSession(chatA, 'the brief for the refused move');
    const command = queueResume(sessionId, token)!;
    expect((await redeem(command.id, 'tab-b')).text).toContain('the brief for the refused move');
    expect((await request('POST', '/compact', { body: { token, destinationAttempt: true } })).body.allowed).toBe(true);
    expect((await request('POST', '/compact', { body: { token, destinationDispatch: true } })).body.armed).toBe(true);
    // The handover is gone while the continuation is live: the swarm preflight will refuse.
    cancelPrimeTransfer(chatA);

    const reply = await request('POST', '/compact', {
      body: { conversationId: chatB, token, destinationMessageId: 'm-b-marked-resume' }
    });
    expect(reply.status).toBe(409);
    expect(reply.body.error).toBe('resume_commit_rejected');
    expect(continuationByToken(token)?.state).toBe('aborted');
    expect(continuationByToken(token)?.error).toMatch(/handover/);
    expect((await getSession(sessionId))?.conversationId).toBe(chatA);
    expect(pendingCommands().some((entry) => entry.id === command.id)).toBe(false);
  });

  it('arms the resumed chat the moment the session moves onto it', async () => {
    // 2026-09-02: chat B's first two calls each waited out the identity window as nobody's,
    // and the unattributed incident had no suspect to reload because B had never reported a
    // turn. From the commit on, B is expected to work: it is on the activity clock like any
    // chat with an open turn, so the incident can reload it and silence can reload it once.
    await pair();
    const chatA = 'a2a2a2a2-2222-4333-8444-555555555555';
    const chatB = 'b2b2b2b2-2222-4333-8444-555555555555';
    const { sessionId, token } = await compactedSession(chatA, 'the brief for the armed move');
    const command = queueResume(sessionId, token)!;
    expect((await redeem(command.id, 'tab-b2')).text).toContain('the brief for the armed move');
    expect((await request('POST', '/compact', { body: { token, destinationAttempt: true } })).body.allowed).toBe(true);
    expect((await request('POST', '/compact', { body: { token, destinationDispatch: true } })).body.armed).toBe(true);
    const logged = getLog().length;

    const reply = await request('POST', '/compact', {
      body: { conversationId: chatB, token, destinationMessageId: 'm-b2-marked-resume' }
    });
    expect(reply.status).toBe(200);
    expect(reply.body.committed).toBe(true);
    expect((await getSession(sessionId))?.conversationId).toBe(chatB);
    expect(
      getLog()
        .slice(logged)
        .some((entry) => entry.message.includes(`resumed chat ${chatB} armed`))
    ).toBe(true);
    expect((await request('GET', '/status')).body.recoveryMonitoring).toBe(true);

    // Idempotent re-reads of the marked message (a reloaded B) do not arm it a second time.
    const again = await request('POST', '/compact', {
      body: { conversationId: chatB, token, destinationMessageId: 'm-b2-marked-resume' }
    });
    expect(again.status).toBe(200);
    expect(
      getLog()
        .slice(logged)
        .filter((entry) => entry.message.includes(`resumed chat ${chatB} armed`))
    ).toHaveLength(1);
  });

  /**
   * The name the fresh chat ends up with.
   *
   * The bootstrap this app types is the first thing said in the chat it opened, and the
   * recorder's ordinary rule — name a session after the first thing said in it — turned
   * that into the session's name. The installed build's list was a column of rows all
   * called `Continue the previous ChatGPT ...`. The acknowledgement is the only moment
   * at which the queued command and the conversation it became are both known, so this
   * is where the name is settled.
   */
  it('names the chat it opened after the work, not after the bootstrap it typed', async () => {
    await pair();
    const source = await createSession({ title: 'Harden the MCP workflows' });
    const command = queueResume(source.id, await readyContinuation(source.id, 'carry on'))!;
    await redeem(command.id);
    const conversationId = 'cccccccc-dddd-eeee-ffff-000000000000';
    await request('POST', '/commands/ack', { body: { id: command.id, status: 'sent', conversationId } });

    const reply = await request('POST', '/events', {
      body: {
        conversationId,
        events: [
          {
            kind: 'user_message',
            time: Date.now(),
            text: 'Continue the previous Chat On Steroids session. Read the handoff below.',
            messageId: 'boot-resume'
          }
        ]
      }
    });
    const summary = await getSession(reply.body.sessionId);
    expect(summary?.title).toBe('Resumed · Harden the MCP workflows');
    expect(summary?.origin).toEqual({ kind: 'resume', fromSessionId: source.id, agentId: null, task: '' });
  });

  it('names a worker chat after the agent and the task it was given', async () => {
    await pair();
    spawn({ workers: [{ task: 'Rewrite the recorder fixture' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem();
    const conversationId = '12121212-3434-5656-7878-909090909090';
    await request('POST', '/commands/ack', {
      body: { id: command.id, status: 'sent', agent: 'worker-1', conversationId }
    });

    const reply = await request('POST', '/events', {
      body: {
        conversationId,
        events: [
          {
            kind: 'user_message',
            time: Date.now(),
            text: 'Rewrite the recorder fixture',
            messageId: 'boot-worker'
          }
        ]
      }
    });
    expect((await getSession(reply.body.sessionId))?.title).toBe('worker-1 · Rewrite the recorder fixture');
  });

  it('rebuilds a worker origin from the durable broker binding if the recorder restarts before first observation', async () => {
    await pair();
    spawn({ workers: [{ task: 'Keep durable worker attribution' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem();
    const conversationId = 'abababab-3434-5656-7878-909090909090';
    await request('POST', '/commands/ack', {
      body: { id: command.id, status: 'sent', conversationId }
    });

    // The ack retired its command after binding the worker, but the recorder had not created
    // a session yet. Losing recorder memory here used to lose SessionOrigin permanently even
    // though the swarm snapshot still held worker-1 + its task + this exact conversation.
    resetRecorderForTests();
    const reply = await request('POST', '/events', {
      body: {
        conversationId,
        events: [
          {
            kind: 'user_message',
            time: Date.now(),
            text: 'Keep durable worker attribution',
            messageId: 'boot-worker-after-recorder-restart'
          }
        ]
      }
    });
    const summary = await getSession(reply.body.sessionId);
    expect(summary?.origin).toEqual({
      kind: 'worker',
      fromSessionId: null,
      agentId: 'worker-1',
      task: 'Keep durable worker attribution'
    });
    expect(summary?.title).toBe('worker-1 · Keep durable worker attribution');
  });

  /** A bootstrap that never reached a tab has no chat to name. */
  it('does not name anything for a failed acknowledgement', async () => {
    await pair();
    const source = await createSession({ title: 'Never opened' });
    const command = queueResume(source.id, await readyContinuation(source.id, 'carry on'))!;
    await redeem(command.id);
    const conversationId = 'dddddddd-eeee-ffff-0000-111111111111';
    await request('POST', '/commands/ack', {
      body: { id: command.id, status: 'failed', error: 'tab died', conversationId }
    });

    const reply = await request('POST', '/events', {
      body: {
        conversationId,
        events: [{ kind: 'user_message', time: Date.now(), text: 'a chat the user started', messageId: 'm-own' }]
      }
    });
    const summary = await getSession(reply.body.sessionId);
    expect(summary?.title).toBe('a chat the user started');
    expect(summary?.origin).toBeNull();
  });

  /**
   * One command is one delivery, and a page that gives up ends it.
   *
   * There is no retry budget, nothing sweeping the queue behind this, and no status a page
   * can send to buy itself more time — `working` existed for exactly that and went with the
   * ticker that sent it. A bootstrap that fails fails now, and takes its continuation down
   * with it, so the session is left in the chat it is already in and the user can see that
   * and press the button again.
   */
  it('ends a failed bootstrap instead of retrying it, and has no way to postpone one', async () => {
    await pair();
    const { sessionId, token } = await compactedSession('22222222-3333-4444-5555-666666666666', 'carry on');
    const command = queueResume(sessionId, token)!;
    await redeem(command.id);

    await request('POST', '/commands/ack', { body: { id: command.id, status: 'failed', error: 'tab died' } });
    // Gone from the queue, and gone as a transaction: nothing is coming for this session.
    expect(pendingCommands()).toEqual([]);
    expect(continuationByToken(token)?.state).toBe('aborted');

    // A second press is a second command — the user's decision, not the app's timer.
    const { sessionId: againId, token: againToken } = await compactedSession(
      '33333333-4444-5555-6666-777777777777',
      'carry on'
    );
    const second = queueResume(againId, againToken)!;
    expect(pendingCommands()).toHaveLength(1);

    // An unknown legacy status is treated as the old "sent" shape. Without a conversation id
    // that is retryable, never a 2xx false-success that would retire the only transport.
    const nonsense = await request('POST', '/commands/ack', { body: { id: second.id, status: 'working' } });
    expect(nonsense.status).toBe(503);
    expect(nonsense.body).toMatchObject({ error: 'conversation_required', retryable: true });
    expect(pendingCommands()).toHaveLength(1);
    expect(continuationByToken(againToken)?.state).not.toBe('aborted');
  });

  it('types the worker its task, and nothing about joining, keys or identity', async () => {
    await pair();
    spawn({ workers: [{ task: 'Audit the compaction transaction end to end' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem();

    expect(command.agent).toBe('worker-1');
    // The task itself is the first message. That is the whole invariant: the chat this app
    // opened is already a worker, so there is nothing for the model to do about identity.
    expect(command.text.startsWith('Audit the compaction transaction end to end')).toBe(true);
    expect(command.text).not.toMatch(/join/i);
    expect(command.text).not.toMatch(/agent[_ ]key/i);
    expect(command.text).not.toContain('joinKey');
    // It still says how to report, because that is about the work rather than about who it is.
    expect(command.text).toContain('action=message');
    expect(command.text).toContain('finish');

    await flushDurable();
    const stored = await readDurable<unknown>('bridge-commands');
    expect(JSON.stringify(stored)).not.toContain('joinKey');
  });

  /**
   * Binding is the completion boundary.
   *
   * The command used to stay leased after the bootstrap was typed, "waiting for the worker
   * to join", because joining was a thing a model had to do and could be prevented from
   * doing. The extension's report *is* the worker starting, so the same acknowledgement
   * that carries the conversation id both activates the worker and finishes the command.
   */
  it('activates the worker and retires its command on the acknowledgement that names the chat', async () => {
    await pair();
    spawn({ workers: [{ task: 'audit the compaction' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem();
    const conversationId = 'abcdef12-3456-7890-abcd-ef1234567890';
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('invited');

    await request('POST', '/commands/ack', {
      // Deliberately wrong. The worker slot comes from the app-owned command id, never from
      // a page/body field that merely repeats what it was told.
      body: { id: command.id, status: 'sent', conversationId, agent: 'worker-99' }
    });

    const worker = swarmState().agents.find((agent) => agent.id === 'worker-1')!;
    expect(worker.state).toBe('active');
    expect(worker.conversationId).toBe(conversationId);
    expect(pendingCommands()).toEqual([]);
    expect(pendingWorkerSpawns()).toEqual([]);
  });

  it('keeps the worker command durable until the worker binding itself crosses its crash barrier', async () => {
    await pair();
    spawn({ workers: [{ task: 'prove ack ordering' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem(undefined, 'ordered-worker-page');
    const conversationId = 'dddddddd-3456-7890-abcd-ef1234567890';

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const bindingWriteStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    onSwarmPersistNow(async (snapshot) => {
      bindingWriteStarted.then(() => undefined);
      entered();
      await gate;
      await writeDurableNow('swarm', snapshot);
    });

    try {
      let ackSettled = false;
      const ack = request('POST', '/commands/ack', {
        body: {
          id: command.id,
          status: 'sent',
          conversationId,
          client: 'ordered-worker-page'
        }
      }).then((reply) => {
        ackSettled = true;
        return reply;
      });

      await bindingWriteStarted;
      // Binding is already published in memory, but the browser command remains the durable
      // retry point until the matching swarm generation reaches disk. A crash right here must
      // therefore restore the leased command rather than an invited worker with no command.
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
        state: 'active',
        conversationId
      });
      expect(ackSettled).toBe(false);
      const before = await readDurable<{ commands?: Array<{ id?: string }>; receipts?: Array<{ id?: string }> }>('bridge-commands');
      expect(before?.commands?.some((entry) => entry.id === command.id)).toBe(true);
      expect(before?.receipts?.some((entry) => entry.id === command.id)).toBe(false);

      release();
      const reply = await ack;
      expect(reply.status).toBe(200);
      const after = await readDurable<{ commands?: Array<{ id?: string }>; receipts?: Array<{ id?: string }> }>('bridge-commands');
      expect(after?.commands?.some((entry) => entry.id === command.id)).toBe(false);
      expect(after?.receipts?.some((entry) => entry.id === command.id)).toBe(true);
    } finally {
      release();
      onSwarmPersistNow((snapshot) => writeDurableNow('swarm', snapshot));
    }
  });

  it('restores a durable command receipt so a lost ACK response can be replayed after restart', async () => {
    await pair();
    spawn({ workers: [{ task: 'prove receipt recovery' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem(undefined, 'receipt-replay-page');
    const conversationId = 'eeeeeeee-3456-7890-abcd-ef1234567890';
    const ack = {
      id: command.id,
      status: 'sent',
      conversationId,
      client: 'receipt-replay-page'
    };

    const first = await request('POST', '/commands/ack', { body: ack });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ final: true, committed: true, conversationId });
    await flushDurable();
    const stored = await readDurable<{ version?: number; receipts?: Array<{ id?: string }> }>('bridge-commands');
    expect(stored?.version).toBe(4);
    expect(stored?.receipts?.some((entry) => entry.id === command.id)).toBe(true);

    // Simulate the main-process restart after the durable commit but before the browser got
    // the HTTP response. The service worker has its own durable ACK outbox and will replay the
    // exact ACK, so the bridge must recover the tombstone rather than answer "gone".
    resetBridgeForTests();
    await restoreCommands();
    const replay = await request('POST', '/commands/ack', { body: ack });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ final: true, committed: true, conversationId });
  });

  it('refuses an acknowledgement from a document that does not own the redeemed command', async () => {
    await pair();
    spawn({ workers: [{ task: 'ownership audit' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem(undefined, 'owner-page');
    const conversationId = 'abcdef12-3456-7890-abcd-ef1234567890';

    const stale = await request('POST', '/commands/ack', {
      body: {
        id: command.id,
        status: 'sent',
        conversationId,
        client: 'old-page'
      }
    });
    expect(stale.status).toBe(409);
    expect(pendingCommands().some((entry) => entry.id === command.id)).toBe(true);
    expect(pendingWorkerSpawns().map((worker) => worker.id)).toEqual(['worker-1']);

    const current = await request('POST', '/commands/ack', {
      body: {
        id: command.id,
        status: 'sent',
        conversationId,
        client: 'owner-page'
      }
    });
    expect(current.status).toBe(200);
    expect(pendingCommands().some((entry) => entry.id === command.id)).toBe(false);
  });

  it('does not let stale events from an old worker bind the same friendly id in a new run', async () => {
    await pair();
    spawn({ workers: [{ task: 'old run work' }], caller: { conversationId: PRIME_CHAT } });
    const oldCommand = await redeem();
    const oldConversation = 'aaaaaaaa-1111-2222-3333-444444444444';
    await request('POST', '/commands/ack', {
      body: { id: oldCommand.id, status: 'sent', conversationId: oldConversation, client: 'tab-1' }
    });
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.conversationId).toBe(oldConversation);

    // End run A, then create run B. Friendly worker ids intentionally start over at worker-1.
    resetSwarm();
    spawn({ workers: [{ task: 'new run work' }], caller: { conversationId: PRIME_CHAT } });
    const newCommand = await redeem(undefined, 'new-run-page');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('invited');

    // A delayed service-worker journal from the old page still carries `agent: worker-1`.
    // That label is not an incarnation and must never establish the new run's binding.
    const stale = await request('POST', '/events', {
      body: {
        conversationId: oldConversation,
        agent: 'worker-1',
        agentCommandId: oldCommand.id,
        events: [{ kind: 'progress', time: Date.now(), text: 'late event from run A' }]
      }
    });
    expect(stale.status).toBe(200);
    const beforeAck = swarmState().agents.find((agent) => agent.id === 'worker-1')!;
    expect(beforeAck.state).toBe('invited');
    expect(beforeAck.conversationId).toBeNull();

    const newConversation = 'bbbbbbbb-1111-2222-3333-444444444444';
    const ack = await request('POST', '/commands/ack', {
      body: {
        id: newCommand.id,
        status: 'sent',
        conversationId: newConversation,
        client: 'new-run-page'
      }
    });
    expect(ack.status).toBe(200);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.conversationId).toBe(newConversation);
  });

  it('recovers a lost worker ACK only when events carry the exact redeemed command id', async () => {
    await pair();
    spawn({ workers: [{ task: 'recover my binding' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem(undefined, 'worker-page');
    expect(command.agent).toBe('worker-1');
    const conversationId = 'cccccccc-1111-2222-3333-444444444444';

    const missingRun = await request('POST', '/events', {
      body: {
        conversationId,
        agent: 'worker-1',
        events: [{ kind: 'progress', time: Date.now(), text: 'old extension shape' }]
      }
    });
    expect(missingRun.status).toBe(200);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.conversationId).toBeNull();

    const recovered = await request('POST', '/events', {
      body: {
        conversationId,
        agent: 'worker-1',
        agentCommandId: command.id,
        events: [{ kind: 'progress', time: Date.now(), text: 'same-run recovery' }]
      }
    });
    expect(recovered.status).toBe(200);
    const worker = swarmState().agents.find((agent) => agent.id === 'worker-1')!;
    expect(worker.state).toBe('active');
    expect(worker.conversationId).toBe(conversationId);
  });

  it('detaches an active worker when the browser reports its final chat tab closed', async () => {
    await pair();
    spawn({ workers: [{ task: 'close lifecycle' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem();
    const conversationId = 'fedcba98-7654-3210-fedc-ba9876543210';
    await request('POST', '/commands/ack', {
      body: { id: command.id, status: 'sent', conversationId, agent: 'worker-1' }
    });
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');

    const closed = await request('POST', '/closed', { body: { conversationId } });
    expect(closed.body.ok).toBe(true);
    const worker = swarmState().agents.find((agent) => agent.id === 'worker-1')!;
    // The tab is not the turn. A ChatGPT turn runs on OpenAI's servers, so a closed tab
    // means this app has lost sight of the worker, not that the worker has stopped.
    expect(worker.state).toBe('detached');
    expect(swarmState().running).toBe(true);
  });

  it('keeps a retired worker tool fence after its browser tab closes', async () => {
    await pair();
    // /closed accepts only real ChatGPT conversation ids. The shared PRIME_CHAT test fixture is
    // deliberately human-readable and therefore does not cross that HTTP validation boundary;
    // using it here made the regression stop before it ever exercised retired-worker cleanup.
    const primeConversation = '11111111-2222-4333-8444-555555555555';
    spawn({ workers: [{ task: 'finish before the run closes' }], caller: { conversationId: primeConversation } });
    const workerConversation = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    expect(bindConversation('worker-1', workerConversation)).toBe(true);
    noteAgentContextTokens(workerConversation, WORKER_CONTEXT_CEILING_TOKENS);
    finishAgent({ conversationId: workerConversation }, 'worker finished before the prime went away');
    // This test is about the post-run retired-worker fence, not pending-report survival. A
    // terminal report must be delivered before the run may retire; the separate agent tests
    // cover closing the prime while that report is still owed.
    offerMessages(PRIME_ID);
    acknowledgeOffers(PRIME_ID);

    const primeClosed = await request('POST', '/closed', { body: { conversationId: primeConversation } });
    expect(primeClosed.body.ok).toBe(true);
    expect(swarmState().running).toBe(false);
    expect(retiredWorkerForConversation(workerConversation)).toMatchObject({
      id: 'worker-1',
      conversationId: workerConversation
    });

    // Closing the browser view is not evidence that OpenAI's server-side turn can no longer
    // call this connector. The post-run retired lease is therefore still required after the
    // page disappears; otherwise the same finished worker chat regains ordinary tool access.
    const workerClosed = await request('POST', '/closed', { body: { conversationId: workerConversation } });
    expect(workerClosed.body.ok).toBe(true);
    expect(retiredWorkerForConversation(workerConversation)).toMatchObject({
      id: 'worker-1',
      conversationId: workerConversation
    });
  });

  /**
   * Waking a sleeping worker, end to end over the real server.
   *
   * A revival is the one command that names a chat that already exists. Everything about it
   * is therefore fenced on that chat: the page is opened at `/c/<id>`, the redeemed command
   * names the same id back, and the browser has to say which conversation it typed into
   * before the broker will believe the worker is awake.
   */
  it("routes revival to the worker's own chat without opening a duplicate, and treats the typed message as an offer", async () => {
    await pair();
    spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
    const bootstrap = await redeem();
    const conversationId = 'cafecafe-7654-3210-fedc-ba9876543210';
    await request('POST', '/commands/ack', {
      body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
    });
    finishAgent({ conversationId }, 'the first half is done');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');

    wake([{ to: 'worker-1', text: 'now do the second half' }]);
    const revival = await waitForRevival();
    expect(revival.conversationId).toBe(conversationId);
    expect(opened).toHaveLength(1);
    const id = revival.id;

    // The page says which conversation it is showing, and only a revival for that exact
    // chat may be claimed from inside an existing conversation.
    const wrongTab = await request('POST', '/commands/redeem', {
      body: { id, client: 'tab-someone-else', conversationId: 'ffffffff-1111-4222-8333-444444444444' }
    });
    expect(wrongTab.status).toBe(409);
    expect(wrongTab.body.error).toBe('command_wrong_conversation');

    const claimed = await request('POST', '/commands/redeem', {
      body: { id, client: 'tab-worker-again', conversationId }
    });
    expect(claimed.status).toBe(200);
    expect(claimed.body.command).toMatchObject({ id, agent: 'worker-1', conversationId });
    // What gets typed is the prime's own words, as a user message in the worker's chat.
    expect(claimed.body.command.text).toContain('now do the second half');

    const ack = await request('POST', '/commands/ack', {
      body: { id, status: 'sent', conversationId, client: 'tab-worker-again' }
    });
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ committed: true, conversationId });
    let worker = swarmState().agents.find((agent) => agent.id === 'worker-1')!;
    expect(worker.state).toBe('waking');
    expect(worker.conversationId).toBe(conversationId);
    // Typed is not read. The words are in its chat; its own next authenticated call is what
    // takes them out of its inbox.
    expect(worker.pending).toBe(1);
    expect(noteAgentAlive(conversationId, 'call')?.revived).toBe(true);
    worker = swarmState().agents.find((agent) => agent.id === 'worker-1')!;
    expect(worker.state).toBe('active');
  });

  /**
   * The wake the page saw begin.
   *
   * Live 2026-09-02: the browser typed two wakes within a second and both pages reported
   * "turn started", yet both workers stayed `waking` because the broker only accepted a tool
   * call as proof — and those calls' page evidence was late, so they piled into Unattributed
   * activity until the deadline slept the workers under turns that were visibly running. In
   * the same second, the page replayed the settled answer of the turn that had put each
   * worker to sleep, and that replay was taken as a fresh finish that put the worker back to
   * `sleeping` and retired its wake command. Neither may happen: a turn beginning after the
   * delivered wake ends the wake, and a stop observed while waking is the old turn's.
   */
  it('lets the turn the page reports end a delivered wake, and ignores the old answer replayed beside it', async () => {
    await pair();
    spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
    const bootstrap = await redeem();
    const conversationId = 'abababab-7654-4210-8edc-ba9876543210';
    await request('POST', '/commands/ack', {
      body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
    });
    const workerState = () =>
      swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')!;
    const settledAt = Date.now();
    const settled = await request('POST', '/events', {
      body: {
        conversationId,
        events: [
          { kind: 'turn_start', time: settledAt - 20, turnId: 'turn-1' },
          {
            kind: 'assistant_message',
            time: settledAt - 10,
            turnId: 'turn-1',
            messageId: 'assistant:turn-1',
            text: 'the first half is done',
            final: true
          },
          { kind: 'turn_end', time: settledAt, turnId: 'turn-1', outcome: 'completed' }
        ]
      }
    });
    expect(settled.status).toBe(200);
    expect(workerState().state).toBe('sleeping');

    wake([{ to: 'worker-1', text: 'now do the second half' }]);
    const { id } = await waitForRevival();
    await request('POST', '/commands/redeem', { body: { id, client: 'tab-a', conversationId } });
    await request('POST', '/commands/ack', { body: { id, status: 'sent', conversationId, client: 'tab-a' } });
    expect(workerState().state).toBe('waking');

    // The page's next batch: the old answer again, exactly as the journal re-reports it, and
    // nothing else. The worker is not asleep again and its wake is still pending.
    const replayed = await request('POST', '/events', {
      body: {
        conversationId,
        events: [{ kind: 'turn_end', time: settledAt, turnId: 'turn-1', outcome: 'completed' }]
      }
    });
    expect(replayed.status).toBe(200);
    expect(workerState().state).toBe('waking');
    expect(pendingWorkerRevivals().map((entry) => entry.id)).toEqual(['worker-1']);

    // Then the typed message's turn begins. That is the proof; the command is spent with it.
    const started = await request('POST', '/events', {
      body: {
        conversationId,
        events: [{ kind: 'turn_start', time: Date.now() + 1, turnId: 'turn-2' }]
      }
    });
    expect(started.status).toBe(200);
    expect(workerState().state).toBe('active');
    expect(pendingWorkerRevivals()).toEqual([]);
    await flushDurable();
    const commands = (await readDurable<any>('bridge-commands'))?.commands ?? [];
    expect(commands.find((entry: any) => entry?.id === id)).toBeUndefined();
    // Typed is still not read: the worker's own next call is what takes the words out of its inbox.
    expect(workerState().pending).toBe(1);
  });

  /**
   * The same worker, woken twice inside one command's thirty seconds.
   *
   * A wake is over the moment the worker's own authenticated call answers it, and that can
   * happen seconds after the browser typed. Everything the first command accumulated on the
   * way — its lease, the page that owns it, the delivery marker on the worker — belongs to
   * that finished wake, so the second one has to arrive as its own send with its own words
   * rather than folding into a command that has already been spent.
   */
  /**
   * The broker republishing a wake it has already delivered.
   *
   * Every restart, and every staging pass that touches the run, hands the bridge the whole
   * `waking` list again. For a worker whose message the browser has already typed there is
   * nothing left to plan, and the command it is living under is the same one - so the thirty
   * seconds it is being given to call must be the thirty seconds it started with, and its tab
   * must not be opened again to type nothing into it.
   */
  it('leaves a delivered wake alone when the broker replays it, and still supersedes a real one', async () => {
    await pair();
    spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
    const bootstrap = await redeem();
    const conversationId = 'dededede-7654-4210-8edc-ba9876543210';
    await request('POST', '/commands/ack', {
      body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
    });
    finishAgent({ conversationId }, 'the first half is done');

    wake([{ to: 'worker-1', text: 'now do the second half' }]);
    const { id } = await waitForRevival();
    expect(opened).toHaveLength(1);
    await request('POST', '/commands/redeem', { body: { id, client: 'tab-a', conversationId } });
    await request('POST', '/commands/ack', { body: { id, status: 'sent', conversationId, client: 'tab-a' } });
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    await flushDurable();
    const createdAt = (await readDurable<any>('bridge-commands'))?.commands?.find((entry: any) => entry?.id === id)
      ?.createdAt as number;
    expect(createdAt).toBeGreaterThan(0);

    // The replay: exactly what a restart, or any staging pass, does with a still-waking worker.
    requestWorkerRevivals(['worker-1']);
    await flushDurable();
    expect(opened).toHaveLength(1);
    const replayed = (await readDurable<any>('bridge-commands'))?.commands?.find((entry: any) => entry?.id === id);
    expect(replayed?.createdAt, 'the wake keeps its own absolute deadline').toBe(createdAt);
    expect(replayed?.owner, 'and the page that owns it keeps owning it').toBe('tab-a');

    // A genuinely new message, still inside those thirty seconds, is a different wake and does
    // supersede — which is the thing the rule above must not have taken away.
    expect(noteAgentAlive(conversationId, 'call')?.revived).toBe(true);
    finishAgent({ conversationId }, 'the second half is done too');
    wake([{ to: 'worker-1', text: 'one more piece, please' }]);
    const replay = await waitForRevival();
    // The command row is superseded in place; its new payload/lease is the new wake episode.
    expect(replay.id).toBe(id);
    expect(opened).toHaveLength(1);
    expect(Date.now() - createdAt).toBeLessThan(30_000);
  });

  it('wakes the same worker again after it has called, well inside the first wake', async () => {
    await pair();
    spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
    const bootstrap = await redeem();
    const conversationId = 'bcbcbcbc-7654-4210-8edc-ba9876543210';
    await request('POST', '/commands/ack', {
      body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
    });
    finishAgent({ conversationId }, 'the first half is done');

    wake([{ to: 'worker-1', text: 'now do the second half' }]);
    const { id: first } = await waitForRevival();
    const firstAt = Date.now();
    expect((await request('POST', '/commands/redeem', { body: { id: first, client: 'tab-a', conversationId } })).status).toBe(200);
    await request('POST', '/commands/ack', {
      body: { id: first, status: 'sent', conversationId, client: 'tab-a' }
    });
    // The exact authenticated call: this wake has done what it existed to do.
    expect(noteAgentAlive(conversationId, 'call')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    finishAgent({ conversationId }, 'the second half is done too');

    wake([{ to: 'worker-1', text: 'one more piece, please' }]);
    const { id: second } = await waitForRevival();
    // Still inside the first command's own deadline, which is the whole point.
    expect(Date.now() - firstAt).toBeLessThan(30_000);
    expect(opened).toHaveLength(1);
    const claimed = await request('POST', '/commands/redeem', {
      body: { id: second, client: 'tab-b', conversationId }
    });
    // Not `command_already_sent`: nothing has been typed for *this* wake.
    expect(claimed.status).toBe(200);
    expect(claimed.body.command.text).toContain('one more piece, please');
    // And it carries this wake's words only, never a replay of the one already delivered.
    expect(claimed.body.command.text).not.toContain('now do the second half');
  });

  it('releases an unredeemed worker at exactly the revival deadline', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'finish, then keep rendering the final answer' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const conversationId = 'cdcdcdcd-7654-4210-8edc-ba9876543210';
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      finishAgent({ conversationId }, 'tool result is terminal but assistant prose is still streaming');
      wake([{ to: 'worker-1', text: 'continue after your final answer settles' }]);
      const { id } = await waitForRevival();
      await flushDurable();
      const durable = await readDurable<any>('bridge-commands');
      const revive = durable?.commands?.find((entry: any) => entry?.id === id);
      expect(revive).toBeTruthy();
      const remaining = REVIVAL_DEADLINE_MS - (Date.now() - revive.createdAt);
      expect(remaining).toBeGreaterThan(1);

      // Content deliberately has not redeemed: the page is still rendering the assistant turn.
      // Waking remains reserved just until the single attempt's absolute deadline.
      await vi.advanceTimersByTimeAsync(remaining - 1);
      expect(pendingCommands()).toContainEqual(expect.objectContaining({ id, what: 'revive:worker-1' }));
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({ state: 'waking' });
      expect(opened).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await vi.runAllTicks();
      const worker = swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')!;
      expect(worker).toMatchObject({ state: 'sleeping', revivable: true, pending: 1 });
      expect(pendingCommands().some((entry) => entry.id === id)).toBe(false);
      expect(opened).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets an MCP call win only before the browser redeems the sleeping-worker wake', async () => {
    await pair();
    spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
    const bootstrap = await redeem();
    const conversationId = 'abababab-7654-3210-fedc-ba9876543210';
    await request('POST', '/commands/ack', {
      body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
    });
    finishAgent({ conversationId }, 'the first half is done');
    wake([{ to: 'worker-1', text: 'one browser wake only' }]);
    const { id } = await waitForRevival();

    // Before /redeem owns the wake, a proven call is the stronger fact: the old server-side turn
    // never really stopped. It takes the worker active and receives the queued text through the
    // ordinary MCP inbox path exactly once.
    expect(noteAgentAlive(conversationId, 'call')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    expect(offerMessages('worker-1').map((message) => message.text)).toEqual(['one browser wake only']);

    // The page that arrives later no longer has authority to type the same text as a user turn.
    const stale = await request('POST', '/commands/redeem', {
      body: { id, client: 'tab-too-late', conversationId }
    });
    expect(stale.status).toBe(404);
    expect(stale.body.error).toBe('no_such_command');
  });

  it('keeps a redeemed revival browser-owned until its exact sent acknowledgement', async () => {
    await pair();
    spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
    const bootstrap = await redeem();
    const conversationId = 'acacacac-7654-3210-fedc-ba9876543210';
    await request('POST', '/commands/ack', {
      body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
    });
    finishAgent({ conversationId }, 'the first half is done');
    wake([{ to: 'worker-1', text: 'browser has the arbitration cut' }]);
    const { id } = await waitForRevival();

    const claimed = await request('POST', '/commands/redeem', {
      body: { id, client: 'tab-browser-owner', conversationId }
    });
    expect(claimed.status).toBe(200);
    expect(swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'waking',
      revivable: false
    });

    // A late old-turn MCP call is liveness, but no longer wake authority. In particular it
    // cannot get the queued prime instruction through a tool result while the page holds it.
    expect(noteAgentAlive(conversationId, 'call')?.revived).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    expect(offerMessages('worker-1')).toEqual([]);

    const ack = await request('POST', '/commands/ack', {
      body: { id, status: 'sent', conversationId, client: 'tab-browser-owner' }
    });
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ committed: true, conversationId });
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    expect(noteAgentAlive(conversationId, 'call')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    // The browser already typed this as a real user message; it is acknowledgement-only now.
    expect(offerMessages('worker-1')).toEqual([]);
  });

  it('returns no revival payload when the browser wake claim itself is not durable, then retries safely', async () => {
    await pair();
    spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
    const bootstrap = await redeem();
    const conversationId = 'adadadad-7654-3210-fedc-ba9876543210';
    await request('POST', '/commands/ack', {
      body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
    });
    finishAgent({ conversationId }, 'the first half is done');
    wake([{ to: 'worker-1', text: 'do not hand this out before the broker claim fsyncs' }]);
    const { id } = await waitForRevival();

    let failOnce = true;
    onSwarmPersistNow(async (snapshot) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('synthetic claim fsync failure');
      }
      await writeDurableNow('swarm', snapshot);
    });
    const first = await request('POST', '/commands/redeem', {
      body: { id, client: 'tab-claim-retry', conversationId }
    });
    expect(first.status).toBe(503);
    expect(first.body).toMatchObject({ error: 'worker_revival_claim_not_durable', retryable: true });
    expect(first.body.command).toBeUndefined();
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'waking',
      revivable: true
    });

    // The failed generation was superseded by the rollback snapshot, so the same page can retry
    // from the pre-cut state. Only the successful second durable claim is allowed to expose text.
    const second = await request('POST', '/commands/redeem', {
      body: { id, client: 'tab-claim-retry', conversationId }
    });
    expect(second.status).toBe(200);
    expect(second.body.command.text).toContain('do not hand this out before the broker claim fsyncs');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'waking',
      revivable: false
    });
  });

  it('replays a committed sent ACK after a crash between worker fsync and command receipt without duplicating the wake', async () => {
    await pair();
    spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
    const bootstrap = await redeem();
    const conversationId = 'aeaeaeae-7654-3210-fedc-ba9876543210';
    await request('POST', '/commands/ack', {
      body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
    });
    finishAgent({ conversationId }, 'the first half is done');
    wake([{ to: 'worker-1', text: 'this user message already reached ChatGPT' }]);
    const { id } = await waitForRevival();
    const client = 'tab-lost-ack-response';
    const redeemed = await request('POST', '/commands/redeem', {
      body: { id, client, conversationId }
    });
    expect(redeemed.status).toBe(200);

    // This is the exact middle of /commands/ack: semantic send committed in agents.ts and that
    // state fsynced, but bridge-commands still contains the leased command and no receipt yet.
    const revival = pendingWorkerRevivals()[0]!;
    expect(noteWorkerRevived('worker-1', conversationId, revival.messageIds, id)).toBe(true);
    expect(await persistCriticalSwarmNow()).toBe(true);
    await flushDurable();
    const durableSwarm = await readDurable<any>('swarm');
    const durableCommands = await readDurable<any>('bridge-commands');
    expect(durableCommands?.commands?.some((entry: any) => entry?.id === id)).toBe(true);
    expect(durableCommands?.receipts?.some((entry: any) => entry?.id === id)).toBe(false);

    // Process restart. Ordinary MCP-result offers become uncertain on restore, but a revival
    // offer remains acknowledgement-only because the browser already submitted it as user text.
    resetSwarm();
    resetBridgeForTests();
    restoreSwarm(durableSwarm);
    await restoreCommands();
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    expect(noteAgentAlive(conversationId, 'call')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    expect(offerMessages('worker-1')).toEqual([]);
    const restoredOfferedAt = snapshotSwarm()!.agents.find((entry) => entry.info.id === 'worker-1')!.queue[0]!.offeredAt!;
    expect(acknowledgeOffers('worker-1', false, restoredOfferedAt + 1)).toHaveLength(1);
    expect(offerMessages('worker-1')).toEqual([]);

    // The browser's lost HTTP response is retried against the restored leased command. The
    // durable revival offer proves the semantic send already committed, so rebuild the same
    // committed receipt instead of reporting a false terminal failure.
    const retry = await request('POST', '/commands/ack', {
      body: { id, status: 'sent', conversationId, client }
    });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ committed: true, outcome: 'committed', conversationId });
    const storedAfterRetry = await readDurable<any>('bridge-commands');
    expect(storedAfterRetry?.receipts?.some((entry: any) => entry?.id === id)).toBe(false);
    expect(storedAfterRetry?.commands?.some((entry: any) => entry?.id === id && entry?.phase === 'leased')).toBe(true);
  });

  it('puts the worker back to sleep, with its slot and its message intact, when the browser cannot wake it', async () => {
    await pair();
    spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
    const bootstrap = await redeem();
    const conversationId = 'dadadada-7654-3210-fedc-ba9876543210';
    await request('POST', '/commands/ack', {
      body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
    });
    finishAgent({ conversationId }, 'reported, waiting for more');
    wake([{ to: 'worker-1', text: 'one more thing' }]);
    const { id } = await waitForRevival();
    await request('POST', '/commands/redeem', { body: { id, client: 'tab-doomed', conversationId } });

    const primeBefore = swarmState().agents.find((agent) => agent.role === 'prime')!.pending;
    const ack = await request('POST', '/commands/ack', {
      body: { id, status: 'failed', error: 'the tab was closed', client: 'tab-doomed' }
    });
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ committed: false });

    // Nothing was typed, so nothing was delivered. The worker is exactly where it was, the
    // slot it had reserved is free again, and the prime is told rather than left waiting.
    expect(swarmState().running).toBe(false);
    const ownerState = swarmStateForCaller({ conversationId: PRIME_CHAT });
    const worker = ownerState.agents.find((agent) => agent.id === 'worker-1')!;
    expect(worker.state).toBe('sleeping');
    expect(worker.revivable).toBe(true);
    expect(worker.pending).toBe(1);
    expect(ownerState.agents.find((agent) => agent.role === 'prime')!.pending).toBe(primeBefore + 1);

    // And it can simply be tried again, into the same chat.
    wake([{ to: 'worker-1', text: 'try that again' }]);
    expect((await waitForRevival()).conversationId).toBe(conversationId);
    expect(opened).toHaveLength(1);
  });

  it('expires an owner-null revival at the revival deadline with the same worker and inbox intact', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const conversationId = 'edededed-7654-3210-fedc-ba9876543210';
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      finishAgent({ conversationId }, 'reported, waiting for more');
      wake([{ to: 'worker-1', text: 'stay queued if the page never redeems' }]);
      const { id } = await waitForRevival();

      await vi.advanceTimersByTimeAsync(REVIVAL_DEADLINE_MS);
      await vi.runAllTicks();
      const worker = swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')!;
      expect(worker).toMatchObject({ state: 'sleeping', revivable: true, pending: 1 });
      expect(pendingCommands().some((entry) => entry.id === id)).toBe(false);

    } finally {
      vi.useRealTimers();
    }
  });

  it('does not renew the absolute waking deadline when a document redeems', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const conversationId = 'dededede-7654-3210-fedc-ba9876543210';
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      finishAgent({ conversationId }, 'reported, waiting for more');
      wake([{ to: 'worker-1', text: 'document can own this only for the ACK deadline' }]);
      const { id } = await waitForRevival();

      const claimed = await request('POST', '/commands/redeem', {
        body: { id, client: 'claimed-revival-document', conversationId }
      });
      expect(claimed.status).toBe(200);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
        state: 'waking',
        revivable: false
      });

      await vi.advanceTimersByTimeAsync(REVIVAL_DEADLINE_MS);
      await vi.runAllTicks();
      const worker = swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')!;
      expect(worker.state).toBe('sleeping');
      expect(worker.revivable).toBe(true);
      expect(worker.pending).toBe(1);
      expect(pendingCommands().some((entry) => entry.id === id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives a delivered revival the silence budget of a working worker, and no more', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const conversationId = 'dfdfdfdf-7654-3210-fedc-ba9876543210';
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      finishAgent({ conversationId }, 'reported, waiting for more');
      wake([{ to: 'worker-1', text: 'prove that the model reacted' }]);
      const { id } = await waitForRevival();

      await vi.advanceTimersByTimeAsync(REVIVAL_DEADLINE_MS - 1_000);
      await request('POST', '/commands/redeem', {
        body: { id, client: 'delivered-without-liveness', conversationId }
      });
      const ack = await request('POST', '/commands/ack', {
        body: { id, status: 'sent', client: 'delivered-without-liveness', conversationId }
      });
      expect(ack.body).toMatchObject({ committed: true });
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');

      // The text is in the chat; the model reading it is what the rest of the budget is for.
      // 2026-09-01: three woken workers were still thinking when the old thirty seconds ran
      // out, and were reported unwakeable while their chats were visibly working.
      await vi.advanceTimersByTimeAsync(REVIVAL_ACTIVITY_MS - REVIVAL_DEADLINE_MS - 1_000);
      await vi.runAllTicks();
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
      expect(pendingCommands().some((entry) => entry.id === id)).toBe(true);

      await vi.advanceTimersByTimeAsync(2_000);
      await vi.runAllTicks();
      const worker = swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')!;
      expect(worker).toMatchObject({ state: 'sleeping', revivable: true, pending: 1 });
      expect(pendingCommands().some((entry) => entry.id === id)).toBe(false);

      // The accepted user message stays offered; a later explicit wake injects only genuinely
      // new prime work instead of duplicating text already present in the worker chat.
      wake([{ to: 'worker-1', text: 'genuinely new work after the silent wake' }]);
      const { id: nextId } = await waitForRevival();
      const next = await request('POST', '/commands/redeem', {
        body: { id: nextId, client: 'later-explicit-wake', conversationId }
      });
      expect(next.body.command.text).toContain('genuinely new work after the silent wake');
      expect(next.body.command.text).not.toContain('prove that the model reacted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconciles an expired owner-null revival to sleeping without opening another browser', async () => {
    await pair();
    spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
    const bootstrap = await redeem();
    const conversationId = 'eeeeeeee-7654-3210-fedc-ba9876543210';
    await request('POST', '/commands/ack', {
      body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
    });
    finishAgent({ conversationId }, 'reported, waiting for more');
    wake([{ to: 'worker-1', text: 'expire this readiness wait on restart' }]);
    await waitForRevival();
    await flushDurable();
    const durable = await readDurable<any>('bridge-commands');
    const revive = durable?.commands?.find((entry: any) => entry?.spec?.type === 'revive');
    expect(revive).toBeTruthy();
    const id = revive.id as string;
    revive.createdAt = Date.now() - REVIVAL_ACTIVITY_MS - 1;
    expect(revive.phase).toBe('queued');
    expect(revive.owner).toBeNull();
    await writeDurableNow('bridge-commands', durable);

    await stopBridge();
    resetBridgeForTests();
    opened.length = 0;
    setBrowserOpener(async (url) => {
      opened.push(url);
    });
    let brokerPersistenceCalls = 0;
    onSwarmPersistNow(async (snapshot) => {
      brokerPersistenceCalls++;
      await writeDurableNow('swarm', snapshot);
    });

    const restarted = await startBridge();
    expect(restarted).not.toBeNull();
    base = `http://127.0.0.1:${restarted}`;
    expect(brokerPersistenceCalls).toBe(1);
    expect(swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: true,
      pending: 1
    });
    expect(pendingCommands().some((entry) => entry.id === id)).toBe(false);
    expect(opened).toEqual([]);
  });

  it('fails bridge startup atomically when expired document-owned revival cleanup cannot be persisted', async () => {
    const fixture = await prepareExpiredDocumentOwnedRevivalRestoreFixture({
      workerConversation: 'f1f1f1f1-7654-4210-8edc-ba9876543210',
      resumeConversation: 'f2f2f2f2-7654-4210-8edc-ba9876543210',
      client: 'stale-owned-revival-page'
    });

    let failOnce = true;
    onSwarmPersistNow(async (snapshot) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('synthetic expired-revival cleanup fsync failure');
      }
      await writeDurableNow('swarm', snapshot);
    });

    const failed = await startBridge();
    expect(failed).toBeNull();
    expect(bridgePort()).toBeNull();
    // The plan is strictly local until broker reconciliation crosses its durability barrier.
    // In particular the valid resume beside the stale revival must not leak into live state.
    expect(pendingCommands()).toEqual([]);
    expect(opened).toEqual([]);
    const afterFailure = await readDurable<any>('bridge-commands');
    expect(afterFailure?.commands?.some((entry: any) => entry?.id === fixture.revivalId)).toBe(true);
    expect(afterFailure?.commands?.some((entry: any) => entry?.id === fixture.resumeId)).toBe(true);

    // Model the next process attempt from the still-authoritative durable broker snapshot. The
    // same rows are therefore retryable rather than having been half-pruned by the failed start.
    onSwarmPersistNow((snapshot) => writeDurableNow('swarm', snapshot));
    resetSwarm();
    restoreSwarm(fixture.durableSwarm);
    resetBridgeForTests();
    opened.length = 0;
    setBrowserOpener(async (url) => {
      opened.push(url);
    });
    await restoreContinuations(fixture.continuationSnapshot);
    const restarted = await startBridge();
    expect(restarted).not.toBeNull();
    base = `http://127.0.0.1:${restarted}`;
    expect(pendingCommands().some((entry) => entry.id === fixture.revivalId)).toBe(false);
    expect(pendingCommands().some((entry) => entry.id === fixture.resumeId)).toBe(true);
  });

  it('admits no command traffic while expired document-owned revival reconciliation is still pending', async () => {
    const fixture = await prepareExpiredDocumentOwnedRevivalRestoreFixture({
      workerConversation: 'f3f3f3f3-7654-4210-8edc-ba9876543210',
      resumeConversation: 'f4f4f4f4-7654-4210-8edc-ba9876543210',
      client: 'held-owned-revival-page'
    });

    let releasePersist!: () => void;
    let markPersistStarted!: () => void;
    const persistStarted = new Promise<void>((resolve) => {
      markPersistStarted = resolve;
    });
    const persistGate = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    onSwarmPersistNow(async (snapshot) => {
      markPersistStarted();
      await persistGate;
      await writeDurableNow('swarm', snapshot);
    });

    const starting = startBridge();
    await persistStarted;
    try {
      // listen() has succeeded, but recovery has not published its local command plan. The socket
      // is allowed to exist only behind the explicit admission fence.
      const recoveringPort = bridgePort();
      expect(recoveringPort).not.toBeNull();
      base = `http://127.0.0.1:${recoveringPort}`;
      expect(pendingCommands()).toEqual([]);
      expect(opened).toEqual([]);

      const duringRecovery = await request('POST', '/commands/redeem', {
        body: { id: fixture.resumeId, client: 'page-during-recovery' }
      });
      expect(duringRecovery.status).toBe(503);
      expect(duringRecovery.body).toMatchObject({ error: 'bridge_recovering', retryable: true });
      expect(pendingCommands()).toEqual([]);
      const durableWhileHeld = await readDurable<any>('bridge-commands');
      expect(durableWhileHeld?.commands?.some((entry: any) => entry?.id === fixture.revivalId)).toBe(true);
      expect(durableWhileHeld?.commands?.some((entry: any) => entry?.id === fixture.resumeId)).toBe(true);
    } finally {
      releasePersist();
    }

    const restarted = await starting;
    expect(restarted).not.toBeNull();
    base = `http://127.0.0.1:${restarted}`;
    expect(pendingCommands().some((entry) => entry.id === fixture.revivalId)).toBe(false);
    expect(pendingCommands().some((entry) => entry.id === fixture.resumeId)).toBe(true);
    const after = await readDurable<any>('bridge-commands');
    expect(after?.commands?.some((entry: any) => entry?.id === fixture.revivalId)).toBe(false);
    expect(after?.commands?.some((entry: any) => entry?.id === fixture.resumeId)).toBe(true);
    onSwarmPersistNow((snapshot) => writeDurableNow('swarm', snapshot));
  });

  it('does not let an older expired disk revival cancel a newer retained wake for the same worker', async () => {
    await pair();
    spawn({ workers: [{ task: 'survive a stale durable revival row' }], caller: { conversationId: PRIME_CHAT } });
    const bootstrap = await redeem();
    const conversationId = 'acacacac-1111-4222-8333-777777777777';
    await request('POST', '/commands/ack', {
      body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
    });
    finishAgent({ conversationId }, 'sleep before the first wake');

    wake([{ to: 'worker-1', text: 'old wake whose transport will remain stale on disk' }]);
    const { id: oldId } = await waitForRevival();
    const oldRedeem = await request('POST', '/commands/redeem', {
      body: { id: oldId, client: 'old-revival-page', conversationId }
    });
    expect(oldRedeem.status).toBe(200);
    await flushDurable();
    const staleDisk = await readDurable<any>('bridge-commands');
    const staleRevive = staleDisk?.commands?.find((entry: any) => entry?.id === oldId);
    expect(staleRevive).toBeTruthy();

    // Semantically settle/remove R in live state. Then manufacture the exact safe-side disk
    // failure shape: broker/live state has moved on, but the old bridge file still contains R.
    const failedOld = await request('POST', '/commands/ack', {
      body: { id: oldId, status: 'failed', error: 'synthetic old transport failure', client: 'old-revival-page' }
    });
    expect(failedOld.status).toBe(200);
    expect(swarmState().running).toBe(false);
    expect(swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((entry) => entry.id === 'worker-1')?.state).toBe('sleeping');

    const fresh = stageMessages({ conversationId: PRIME_CHAT }, [
      { to: 'worker-1', text: 'new wake must outrank the stale disk transport' }
    ]);
    fresh.commit();
    expect(fresh.waking).toEqual(['worker-1']);
    expect(requestWorkerRevivals(fresh.waking)).toBe(1);
    await vi.waitFor(() => {
      const revive = pendingCommands().find((entry) => entry.what === 'revive:worker-1');
      expect(revive).toBeTruthy();
      expect(revive!.id).not.toBe(oldId);
    });
    const newId = pendingCommands().find((entry) => entry.what === 'revive:worker-1')!.id;
    expect(swarmState().agents.find((entry) => entry.id === 'worker-1')?.state).toBe('waking');

    // Keep only the old transport on disk and make it expired. writeDurableNow supersedes the
    // fresh command's pending debounced snapshot, while the fresh command itself remains in
    // memory exactly as a settings-driven stop/start would retain it.
    staleRevive.createdAt = Date.now() - 30 * 60_000 - 5_000;
    staleDisk.commands = [staleRevive];
    staleDisk.receipts = [];
    await writeDurableNow('bridge-commands', staleDisk);
    await stopBridge();

    const port = await startBridge();
    expect(port).not.toBeNull();
    base = `http://127.0.0.1:${port}`;
    const worker = swarmState().agents.find((entry) => entry.id === 'worker-1')!;
    expect(worker.state).toBe('waking');
    expect(pendingCommands().some((entry) => entry.id === newId)).toBe(true);
    expect(pendingCommands().some((entry) => entry.id === oldId)).toBe(false);
    const rewritten = await readDurable<any>('bridge-commands');
    expect(rewritten?.commands?.some((entry: any) => entry?.id === newId)).toBe(true);
    expect(rewritten?.commands?.some((entry: any) => entry?.id === oldId)).toBe(false);
  });

  it('selects the newest durable revival before applying expiry to duplicate same-worker rows', async () => {
    await pair();
    spawn({ workers: [{ task: 'survive duplicate durable revival rows' }], caller: { conversationId: PRIME_CHAT } });
    const bootstrap = await redeem();
    const conversationId = 'adadadad-1111-4222-8333-888888888888';
    await request('POST', '/commands/ack', {
      body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
    });
    finishAgent({ conversationId }, 'sleep before duplicate-row wake');
    wake([{ to: 'worker-1', text: 'new durable wake must survive its stale duplicate' }]);
    await waitForRevival();
    await flushDurable();

    const durable = await readDurable<any>('bridge-commands');
    const newest = durable?.commands?.find((entry: any) => entry?.spec?.type === 'revive');
    expect(newest).toBeTruthy();
    const oldId = 'stale-duplicate-revival';
    const old = {
      ...newest,
      id: oldId,
      createdAt: Date.now() - 30 * 60_000 - 5_000,
      phase: 'queued',
      claimedAt: null,
      owner: null
    };
    durable.commands = [old, newest];
    await writeDurableNow('bridge-commands', durable);

    // Cold bridge-memory restart: unlike the retained-live regression above, authority now has
    // to be selected entirely from the durable file. Expiry is a property of the selected
    // transport incarnation, not of the friendly worker key shared by both rows.
    resetBridgeForTests();
    await restoreCommands();
    expect(swarmState().agents.find((entry) => entry.id === 'worker-1')?.state).toBe('waking');
    expect(pendingCommands().some((entry) => entry.id === newest.id)).toBe(true);
    expect(pendingCommands().some((entry) => entry.id === oldId)).toBe(false);
    const rewritten = await readDurable<any>('bridge-commands');
    expect(rewritten?.commands?.some((entry: any) => entry?.id === newest.id)).toBe(true);
    expect(rewritten?.commands?.some((entry: any) => entry?.id === oldId)).toBe(false);
  });

  it('refuses to believe a revival that reports a different chat, and undoes it', async () => {
    await pair();
    spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
    const bootstrap = await redeem();
    const conversationId = 'bacabaca-7654-3210-fedc-ba9876543210';
    await request('POST', '/commands/ack', {
      body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
    });
    finishAgent({ conversationId }, 'reported, waiting for more');
    wake([{ to: 'worker-1', text: 'wake up' }]);
    const { id } = await waitForRevival();
    await request('POST', '/commands/redeem', { body: { id, client: 'tab-wandered' } });

    // The page redeemed before ChatGPT had finished routing it and typed somewhere else.
    // Reporting the send is not proof of where it landed; the chat id is.
    const ack = await request('POST', '/commands/ack', {
      body: { id, status: 'sent', conversationId: 'ffffffff-1111-4222-8333-444444444444', client: 'tab-wandered' }
    });
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ committed: false });
    expect(swarmState().running).toBe(false);
    const worker = swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')!;
    expect(worker.state).toBe('sleeping');
    expect(worker.conversationId).toBe(conversationId);
  });

  it('puts a reusable worker to sleep when its settled assistant turn completes', async () => {
    await pair();
    spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem();
    const conversationId = 'beefbeef-7654-3210-fedc-ba9876543210';
    await request('POST', '/commands/ack', {
      body: { id: command.id, status: 'sent', conversationId, agent: 'worker-1' }
    });
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');

    const now = Date.now();
    const recorded = await request('POST', '/events', {
      body: {
        conversationId,
        events: [
          { kind: 'turn_start', time: now, turnId: 'g-worker-final' },
          {
            kind: 'assistant_message',
            time: now + 1,
            turnId: 'g-worker-final',
            messageId: 'assistant:g-worker-final',
            text: 'Final audit: request IDs are the authority and the slot is free now.',
            final: true
          },
          { kind: 'turn_end', time: now + 2, turnId: 'g-worker-final', outcome: 'completed' }
        ]
      }
    });
    expect(recorded.status).toBe(200);
    // The browser final is the last slot-consuming edge. The active global incarnation should
    // disappear immediately, while the owning prime still sees the exact sleeping worker in
    // its dormant history.
    expect(swarmState().running).toBe(false);
    const worker = swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')!;
    expect(worker.state).toBe('sleeping');
    expect(worker.revivable).toBe(true);
    expect(worker.result).toContain('Final audit: request IDs are the authority');
  });

  it('keeps page observations attributed to the exact dormant worker while another prime is active', async () => {
    await pair();
    spawn({ workers: [{ task: 'prime A worker' }], caller: { conversationId: PRIME_CHAT } });
    const bootstrap = await redeem();
    const workerConversation = 'cafe0024-0000-4000-8000-000000000024';
    await request('POST', '/commands/ack', {
      body: { id: bootstrap.id, status: 'sent', conversationId: workerConversation, agent: 'worker-1' }
    });
    const initial = await request('POST', '/events', {
      body: {
        conversationId: workerConversation,
        events: [{ kind: 'user_message', time: Date.now(), text: 'initial worker turn', messageId: 'worker-a-user' }]
      }
    });
    const sessionId = initial.body.sessionId as string;
    expect(sessionId).toBeTruthy();

    finishAgent({ conversationId: workerConversation }, 'A worker is dormant now');
    expect(await sweepStaleSwarm()).toBe(true);
    expect(swarmState().running).toBe(false);

    // A second owner may now reuse the same friendly worker id. An old page report from A must
    // stay in A's exact session and retain its worker attribution rather than becoming an
    // unattributed/solo row or being confused with B's worker-1.
    spawn({ workers: [{ task: 'prime B worker' }], caller: { conversationId: 'cafe0025-0000-4000-8000-000000000025' } });
    // Simulate session retention having removed A's old recorder file while its worker history
    // remains intentionally permanent. Forget recorder caches too, as a later app process would.
    await deleteSession(sessionId);
    resetRecorderForTests();

    const observed = await request('POST', '/events', {
      body: {
        conversationId: workerConversation,
        events: [
          {
            kind: 'page_tool',
            time: Date.now(),
            turnId: 'old-worker-reload',
            text: 'Dormant worker historical activity',
            messageId: 'old-worker-page-tool'
          }
        ]
      }
    });
    const rebuiltSessionId = observed.body.sessionId as string;
    expect(rebuiltSessionId).toBeTruthy();
    expect(rebuiltSessionId).not.toBe(sessionId);

    const events = await readEvents(rebuiltSessionId);
    expect(events.find((event) => event.kind === 'page_tool' && event.messageId === 'old-worker-page-tool')).toMatchObject({
      agent: 'worker-1',
      label: 'Dormant worker historical activity'
    });
    expect((await getSession(rebuiltSessionId))?.origin).toMatchObject({
      kind: 'worker',
      agentId: 'worker-1',
      task: 'prime A worker'
    });
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      task: 'prime B worker',
      state: 'invited'
    });
  });

  it('puts a reusable worker to sleep when its final assistant row and matching turn_end arrive in separate event batches', async () => {
    await pair();
    spawn({ workers: [{ task: 'finish across journal batches' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem();
    const conversationId = 'decafbad-7654-3210-fedc-ba9876543210';
    await request('POST', '/commands/ack', {
      body: { id: command.id, status: 'sent', conversationId, agent: 'worker-1' }
    });

    const now = Date.now();
    const ended = await request('POST', '/events', {
      body: {
        conversationId,
        events: [
          { kind: 'turn_start', time: now, turnId: 'g-worker-split-final' },
          { kind: 'turn_end', time: now + 1, turnId: 'g-worker-split-final', outcome: 'completed' }
        ]
      }
    });
    expect(ended.status).toBe(200);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');

    // finishGeneration() can enqueue turn_end immediately while its final Fiber refresh is
    // still awaiting the MAIN-world round trip. The service-worker journal may therefore hand
    // these two pieces of one durable turn to the bridge in different HTTP batches.
    const final = await request('POST', '/events', {
      body: {
        conversationId,
        events: [
          {
            kind: 'assistant_message',
            time: now + 2,
            turnId: 'g-worker-split-final',
            messageId: 'assistant:g-worker-split-final',
            text: 'This final answer arrived one journal flush after its turn_end.',
            final: true
          }
        ]
      }
    });
    expect(final.status).toBe(200);
    expect(swarmState().running).toBe(false);
    const worker = swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')!;
    expect(worker.state).toBe('sleeping');
    expect(worker.revivable).toBe(true);
    expect(worker.result).toContain('one journal flush after its turn_end');
  });

  it('retires a worker on its stable final answer even when no turn_end ever arrives', async () => {
    await pair();
    spawn({ workers: [{ task: 'finish without a local turn_end' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem();
    const conversationId = 'decafbad-7654-3210-fedc-ba9876543211';
    await request('POST', '/commands/ack', {
      body: { id: command.id, status: 'sent', conversationId, agent: 'worker-1' }
    });

    const now = Date.now();
    // The page detached, reloaded or simply lost its local lifecycle right after the answer
    // settled, so it never wrote the end. The stable final answer is the terminal fact on its
    // own; requiring the page's separate note about it parked a finished worker as a zombie.
    const final = await request('POST', '/events', {
      body: {
        conversationId,
        events: [
          { kind: 'turn_start', time: now, turnId: 'g-worker-no-end' },
          {
            kind: 'assistant_message',
            time: now + 2,
            turnId: 'g-worker-no-end',
            messageId: 'assistant:g-worker-no-end',
            text: 'The complete worker report, with no turn_end behind it.',
            state: 'final',
            final: true
          }
        ]
      }
    });
    expect(final.status).toBe(200);
    const worker = swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')!;
    expect(worker.state).toBe('sleeping');
    expect(worker.result).toContain('no turn_end behind it');
  });

  it('does not acknowledge a worker final observation before its final report is durable', async () => {
    await pair();
    spawn({ workers: [{ task: 'finish durably' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem();
    const conversationId = 'faceface-7654-3210-fedc-ba9876543210';
    await request('POST', '/commands/ack', {
      body: { id: command.id, status: 'sent', conversationId, agent: 'worker-1' }
    });
    const durableBefore = await readDurable<any>('swarm');
    expect(durableBefore?.agents?.find((agent: any) => agent.info?.id === 'worker-1')?.info?.state).toBe('active');

    onSwarmPersistNow(async () => {
      throw new Error('disk full at worker finish');
    });
    try {
      const now = Date.now();
      const recorded = await request('POST', '/events', {
        body: {
          conversationId,
          events: [
            { kind: 'turn_start', time: now, turnId: 'g-worker-durable-final' },
            {
              kind: 'assistant_message',
              time: now + 1,
              turnId: 'g-worker-durable-final',
              messageId: 'assistant:g-worker-durable-final',
              text: 'The exact final report that must survive the browser ACK.',
              final: true
            },
            { kind: 'turn_end', time: now + 2, turnId: 'g-worker-durable-final', outcome: 'completed' }
          ]
        }
      });

      // Before the barrier existed this was 200 even though the only durable swarm snapshot
      // still said active. A crash at that response boundary lets the extension retire its
      // journal row and loses the worker's exact result from the broker.
      expect(recorded.status).toBe(503);
      expect(recorded.body).toMatchObject({ error: 'worker_state_not_durable', retryable: true });
      const durableAfter = await readDurable<any>('swarm');
      expect(durableAfter?.agents?.find((agent: any) => agent.info?.id === 'worker-1')?.info?.state).toBe('active');
    } finally {
      onSwarmPersistNow((snapshot) => writeDurableNow('swarm', snapshot));
    }
  });

  it('keeps a worker finish and its prime report unpublished while the durable barrier is held', async () => {
    await pair();
    spawn({ workers: [{ task: 'finish without leaking before fsync' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem();
    const conversationId = 'fadedcab-7654-3210-fedc-ba9876543210';
    await request('POST', '/commands/ack', {
      body: { id: command.id, status: 'sent', conversationId, agent: 'worker-1' }
    });

    let entered!: () => void;
    const immediateEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let projected: ReturnType<typeof snapshotSwarm> = null;
    onSwarmPersistNow(async (snapshot) => {
      projected = snapshot;
      entered();
      await held;
      await writeDurableNow('swarm', snapshot);
    });

    try {
      const now = Date.now();
      const recording = request('POST', '/events', {
        body: {
          conversationId,
          events: [
            { kind: 'turn_start', time: now, turnId: 'g-worker-held-finish' },
            {
              kind: 'assistant_message',
              time: now + 1,
              turnId: 'g-worker-held-finish',
              messageId: 'assistant:g-worker-held-finish',
              text: 'Final result hidden until the acceptance write lands.',
              final: true
            },
            { kind: 'turn_end', time: now + 2, turnId: 'g-worker-held-finish', outcome: 'completed' }
          ]
        }
      });
      await immediateEntered;

      // The immediate writer must see the exact proposed terminal generation, otherwise a
      // success response could still crash back to an active worker after restart.
      // The assignment occurs inside the persistence callback. TypeScript's synchronous control
      // flow cannot infer from `immediateEntered` that the callback has run, so name the runtime
      // proof explicitly instead of letting it narrow the outer variable to its initial null.
      const projectedAfterEntry = projected as SwarmSnapshot | null;
      expect(projectedAfterEntry?.agents.find((agent) => agent.info.id === 'worker-1')?.info.state).toBe('sleeping');
      expect(projectedAfterEntry?.agents.find((agent) => agent.info.id === PRIME_ID)?.queue[0]?.text).toContain(
        'Final result hidden until the acceptance write lands.'
      );

      // But no concurrent live reader may see that proposal before fsync. Old code mutated the
      // worker and queued its report before awaiting the barrier, so both assertions failed.
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
      expect(swarmState().agents.find((agent) => agent.id === PRIME_ID)?.pending).toBe(0);
      expect(snapshotSwarm()?.agents.find((agent) => agent.info.id === 'worker-1')?.info.state).toBe('active');
      expect(snapshotSwarm()?.agents.find((agent) => agent.info.id === PRIME_ID)?.queue).toEqual([]);

      release();
      const recorded = await recording;
      expect(recorded.status).toBe(200);
      expect(swarmState().running).toBe(false);
      const ownerState = swarmStateForCaller({ conversationId: PRIME_CHAT });
      expect(ownerState.agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');
      expect(ownerState.agents.find((agent) => agent.id === PRIME_ID)?.pending).toBe(1);
    } finally {
      release();
      onSwarmPersistNow((snapshot) => writeDurableNow('swarm', snapshot));
    }
  });

  it('parks an unacknowledged terminal history immediately while preserving its prime report', async () => {
    spawn({ workers: [{ task: 'stale fallback proof' }], caller: { conversationId: PRIME_CHAT } });
    const workerConversation = 'stale-worker-terminal';
    expect(bindConversation('worker-1', workerConversation)).toBe(true);
    const now = Date.now();
    await recordChatObservations(PRIME_CHAT, [
      { kind: 'turn_start', time: now, turnId: 'g-prime-stale' },
      { kind: 'turn_end', time: now + 1, turnId: 'g-prime-stale', outcome: 'completed' }
    ], 'prime');
    await recordChatObservations(workerConversation, [
      { kind: 'turn_start', time: now, turnId: 'g-worker-stale' },
      { kind: 'turn_end', time: now + 1, turnId: 'g-worker-stale', outcome: 'completed' }
    ], 'worker-1');
    noteAgentContextTokens(workerConversation, WORKER_CONTEXT_CEILING_TOKENS);
    finishAgent({ conversationId: workerConversation }, 'worker finished, report still pending');
    expect(swarmState().running).toBe(true);
    expect(swarmState().agents.find((agent) => agent.role === 'prime')?.pending).toBe(1);

    expect(await sweepStaleSwarm(now + STALE_SWARM_MS - 1)).toBe(true);
    expect(swarmState().running).toBe(false);
    const ownerState = swarmStateForCaller({ conversationId: PRIME_CHAT });
    expect(ownerState.agents.find((agent) => agent.role === 'prime')?.pending).toBe(1);
    expect(ownerState.agents.find((agent) => agent.id === 'worker-1')?.state).toBe('finished');
  });

  /**
   * Block is the user's stop for that chat. On 2026-09-02 worker-3 was blocked, the app was
   * restarted, and the restored run carried it as `active` with no silence grant left to
   * expire: it held the swarm's slot for an hour, the next prime got AGENTS_BUSY, and the slot
   * came free only after its tab closed and the detached clock ran out. The sweep now sleeps a
   * blocked worker from the durable block alone, whatever state its slot is in.
   */
  it('sleeps a blocked worker on the next sweep, active or detached, without any silence clock', async () => {
    spawn({
      workers: [{ task: 'blocked while attached' }, { task: 'blocked while detached' }],
      caller: { conversationId: PRIME_CHAT }
    });
    expect(bindConversation('worker-1', 'blocked-attached-worker')).toBe(true);
    expect(bindConversation('worker-2', 'blocked-detached-worker')).toBe(true);
    expect(workerConversationGone('blocked-detached-worker')).toBe(true);
    const stateOf = (id: string) => swarmState().agents.find((agent) => agent.id === id)?.state;
    expect(stateOf('worker-1')).toBe('active');
    expect(stateOf('worker-2')).toBe('detached');
    try {
      setChatBlocked('blocked-attached-worker', true);
      setChatBlocked('blocked-detached-worker', true);
      // Straight away: no grant to expire, no detached silence to wait out.
      await sweepStaleSwarm(Date.now());
      const log = getLog().map((entry) => entry.message);
      expect(log.some((line) => line.includes('worker-1 is sleeping — The user blocked its chat'))).toBe(true);
      expect(log.some((line) => line.includes('worker-2 is sleeping — The user blocked its chat'))).toBe(true);
      // A sleeping worker holds no slot, so with both asleep the run parks and the next prime
      // is no longer refused with AGENTS_BUSY.
      expect(swarmState().running).toBe(false);
    } finally {
      resetBlockedChatsForTests();
    }
  });

  it('periodically sleeps a silent detached worker and wakes already-queued work without another MCP call', async () => {
    spawn({ workers: [{ task: 'detached silence maintenance' }], caller: { conversationId: PRIME_CHAT } });
    const workerConversation = 'silent-detached-worker';
    expect(bindConversation('worker-1', workerConversation)).toBe(true);
    const detachedAt = Date.now();
    expect(workerConversationGone(workerConversation)).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('detached');

    const queued = stageMessages({ conversationId: PRIME_CHAT }, [
      { to: 'worker-1', text: 'when that old turn is done, inspect the parser' }
    ]);
    expect(queued.waking).toEqual([]);
    queued.commit();

    // No page and, crucially, no later worker MCP request. The bridge's own maintenance timer
    // must eventually run the detached-only silence rule, free the slot, and reserve the queued
    // instruction as a wake in the same stored conversation.
    expect(await sweepStaleSwarm(detachedAt + DETACHED_SILENCE_MS - 1)).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('detached');
    expect(await sweepStaleSwarm(detachedAt + DETACHED_SILENCE_MS + 1_000)).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    expect(pendingWorkerRevivals()[0]).toMatchObject({ id: 'worker-1', conversationId: workerConversation });
    expect(pendingWorkerRevivals()[0]?.text).toContain('inspect the parser');
  });

  it('still releases worker capacity when the durable prime turn remains open', async () => {
    spawn({ workers: [{ task: 'open turn veto' }], caller: { conversationId: PRIME_CHAT } });
    const workerConversation = 'stale-worker-open-prime';
    expect(bindConversation('worker-1', workerConversation)).toBe(true);
    const now = Date.now();
    await recordChatObservations(PRIME_CHAT, [
      { kind: 'turn_start', time: now, turnId: 'g-prime-open' }
    ], 'prime');
    await recordChatObservations(workerConversation, [
      { kind: 'turn_start', time: now, turnId: 'g-worker-done' },
      { kind: 'turn_end', time: now + 1, turnId: 'g-worker-done', outcome: 'completed' }
    ], 'worker-1');
    noteAgentContextTokens(workerConversation, WORKER_CONTEXT_CEILING_TOKENS);
    finishAgent({ conversationId: workerConversation }, 'done while prime still works');

    expect(await sweepStaleSwarm(now + STALE_SWARM_MS + 10_000)).toBe(true);
    expect(swarmState().running).toBe(false);
    expect(swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')?.state).toBe('finished');

    await recordChatObservations(PRIME_CHAT, [
      { kind: 'turn_end', time: now + 2, turnId: 'g-prime-open', outcome: 'completed' }
    ], 'prime');
    expect(await sweepStaleSwarm(now + STALE_SWARM_MS + 20_000)).toBe(false);
  });

  it('stale-releases after page detach durably closes the exact active turn even if broker cleanup was lost', async () => {
    spawn({ workers: [{ task: 'detach crash proof' }], caller: { conversationId: PRIME_CHAT } });
    const workerConversation = 'stale-worker-prime-detached';
    expect(bindConversation('worker-1', workerConversation)).toBe(true);
    const now = Date.now();
    await recordChatObservations(PRIME_CHAT, [
      { kind: 'turn_start', time: now, turnId: 'g-prime-detached' }
    ], 'prime');
    // Simulate the crash window between the recorder persisting page detach and the bridge
    // getting far enough to call primeConversationGone(). The durable turn_end must name the
    // same turn or orphan recovery will reconstruct it as open forever after restart.
    await closeConversation(PRIME_CHAT);
    await recordChatObservations(workerConversation, [
      { kind: 'turn_start', time: now, turnId: 'g-worker-detached' },
      { kind: 'turn_end', time: now + 1, turnId: 'g-worker-detached', outcome: 'completed' }
    ], 'worker-1');
    noteAgentContextTokens(workerConversation, WORKER_CONTEXT_CEILING_TOKENS);
    finishAgent({ conversationId: workerConversation }, 'worker done before broker crash');

    expect(await sweepStaleSwarm(now + STALE_SWARM_MS + 10_000)).toBe(true);
    expect(swarmState().running).toBe(false);
  });

  it('defers stale release while Compact & Resume owns the prime transfer', async () => {
    spawn({ workers: [{ task: 'transfer veto' }], caller: { conversationId: PRIME_CHAT } });
    const workerConversation = 'stale-worker-transfer';
    expect(bindConversation('worker-1', workerConversation)).toBe(true);
    const now = Date.now();
    await recordChatObservations(PRIME_CHAT, [
      { kind: 'turn_start', time: now, turnId: 'g-prime-transfer' },
      { kind: 'turn_end', time: now + 1, turnId: 'g-prime-transfer', outcome: 'completed' }
    ], 'prime');
    await recordChatObservations(workerConversation, [
      { kind: 'turn_start', time: now, turnId: 'g-worker-transfer' },
      { kind: 'turn_end', time: now + 1, turnId: 'g-worker-transfer', outcome: 'completed' }
    ], 'worker-1');
    noteAgentContextTokens(workerConversation, WORKER_CONTEXT_CEILING_TOKENS);
    finishAgent({ conversationId: workerConversation }, 'done before transfer');
    expect(beginPrimeTransfer(PRIME_CHAT)).toBe(true);

    expect(await sweepStaleSwarm(now + STALE_SWARM_MS + 10_000)).toBe(false);
    expect(swarmState().running).toBe(true);

    cancelPrimeTransfer(PRIME_CHAT);
    expect(await sweepStaleSwarm(now + STALE_SWARM_MS + 20_000)).toBe(true);
    expect(swarmState().running).toBe(false);
  });

  /**
   * The failure the new boundary creates, and its safe ending.
   *
   * A page can type the bootstrap and still never see a conversation id — ChatGPT accepted
   * the message but the tab never showed which chat it landed in. Nothing that chat does can
   * ever reach the run, so the slot is failed outright rather than left waiting on a chat
   * that can never be found.
   */
  it('fails a worker whose page typed the task but never named its chat', async () => {
    await pair();
    spawn({ workers: [{ task: 'unnameable' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem();

    await request('POST', '/commands/ack', { body: { id: command.id, status: 'sent', agent: 'worker-1' } });

    const worker = swarmState().agents.find((agent) => agent.id === 'worker-1')!;
    expect(worker.state).toBe('failed');
    expect(worker.result).toMatch(/never said which conversation/);
    expect(pendingCommands()).toEqual([]);
  });

  it('opens one worker chat at a time, so a report can never name the wrong tab', async () => {
    await pair();
    spawn({
      workers: [{ task: 'first audit' }, { task: 'second audit' }],
      caller: { conversationId: PRIME_CHAT }
    });

    await waitForOpened(1);
    const first = await redeem();
    expect(first.agent).toBe('worker-1');
    const firstConversation = '11111111-2222-3333-4444-555555555555';
    await request('POST', '/commands/ack', {
      body: { id: first.id, status: 'sent', conversationId: firstConversation, agent: 'worker-1' }
    });

    // worker-2's chat opens only once worker-1's is bound.
    await waitForOpened(2);
    const second = await redeem();
    expect(second.agent).toBe('worker-2');
    expect(second.text.startsWith('second audit')).toBe(true);
  });

  it('brings an unfinished worker bootstrap back across an app restart, without a credential', async () => {
    await pair();
    spawn({ workers: [{ task: 'survive the restart' }], caller: { conversationId: PRIME_CHAT } });
    const offered = await redeem();
    expect(offered.agent).toBe('worker-1');
    await flushDurable();

    // Nothing in the state file can make anybody a worker: it is a list of what was pending.
    const saved = JSON.stringify(await readDurable('bridge-commands'));
    expect(saved).not.toMatch(/key/i);

    resetBridgeForTests();
    setBrowserOpener(async (url) => {
      opened.push(url);
    });
    await restoreCommands();
    expect(pendingCommands()).toEqual([{ id: offered.id, what: 'worker:worker-1', lastError: null }]);
  });

  it('never adopts a durable worker command from an older swarm incarnation', async () => {
    await pair();
    spawn({ workers: [{ task: 'run A task' }], caller: { conversationId: PRIME_CHAT } });
    const runA = currentRunId();
    const offeredA = await redeem(undefined, 'run-a-page');
    await flushDurable();
    const staleSnapshot = await readDurable('bridge-commands');
    expect(runA).toBeTruthy();
    expect(JSON.stringify(staleSnapshot)).toContain(runA!);

    // Broker run B is current, but disk still contains A's leased browser command: the exact
    // crash split-brain that used to let B fold into A's id because both were `worker-1`.
    resetSwarm();
    spawn({ workers: [{ task: 'run B task' }], caller: { conversationId: PRIME_CHAT } });
    const runB = currentRunId();
    expect(runB).toBeTruthy();
    expect(runB).not.toBe(runA);

    resetBridgeForTests();
    opened.length = 0;
    anonymousRedeemIndex = 0;
    setBrowserOpener(async (url) => {
      opened.push(url);
    });
    await writeDurableNow('bridge-commands', staleSnapshot);
    await restoreCommands();
    expect(pendingCommands(), 'run A command was resurrected into run B').toEqual([]);

    // The restored broker still owes run B a tab, so replaying that fact creates a fresh,
    // run-scoped command rather than inheriting the stale marker held by run A's old page.
    expect(requestWorkerBootstraps(['worker-1'])).toBe(1);
    await waitForOpened(1);
    const offeredB = await redeem(undefined, 'run-b-page');
    expect(offeredB.id).not.toBe(offeredA.id);
    expect(offeredB.text.startsWith('run B task')).toBe(true);
  });

  it('restores a resume when its continuation WAL is restored first', async () => {
    await pair();
    const source = await createSession({ title: 'interrupted by a restart' });
    const continuation = await readyContinuation(source.id, 'carry on');
    const command = queueResume(source.id, continuation)!;
    await waitForOpened(1);
    await flushDurable();
    const snapshot = await readDurable<ContinuationSnapshot>(CONTINUATIONS_STATE);
    expect(snapshot).not.toBeNull();

    resetBridgeForTests();
    opened.length = 0;
    setBrowserOpener(async (url) => {
      opened.push(url);
    });
    await restoreContinuations(snapshot);
    await restoreCommands();
    expect(pendingCommands()).toEqual([{ id: command.id, what: `resume:${source.id}`, lastError: null }]);
    // This snapshot is v2 and already leased to the browser-open attempt. Replaying the queue
    // request must therefore keep waiting for that exact tab instead of opening a second one.
    queueResume(source.id, continuation);
    await Promise.resolve();
    await Promise.resolve();
    expect(opened).toEqual([]);
  });

  /**
   * T-33. Overflow used to `commands.shift()`, which deletes the row and nothing else.
   * A queued worker command owns an `invited` agent slot that only ever ends when
   * something ends it, so shifting one out left that worker counting towards the limit,
   * holding the single in-flight agent bootstrap so nothing queued behind it could open,
   * keeping the run looking alive to takeover, and promising the prime a report from a
   * chat that would never exist.
   */
  it('runs the full lifecycle cleanup when the command queue overflows', async () => {
    await pair();
    spawn({ workers: [{ task: 'the worker that gets pushed out of the queue' }], caller: { conversationId: PRIME_CHAT } });
    expect(swarmState().agents.find((info) => info.id === 'worker-1')!.state).toBe('invited');
    expect(pendingWorkerSpawns().map((worker) => worker.id)).toEqual(['worker-1']);

    // MAX_COMMANDS is 20, and the worker's command is the oldest, so it is the one pushed
    // out by the twenty-first entry.
    for (let n = 0; n < 20; n++) queueResume(`overflow-session-${n}`, `overflow-handoff-${n}`);

    expect(pendingCommands().some((command) => command.what === 'worker:worker-1')).toBe(false);
    expect(pendingCommands()).toHaveLength(20);

    expect(swarmState().running).toBe(false);
    const worker = swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((info) => info.id === 'worker-1')!;
    expect(worker.state).toBe('failed');
    expect(worker.result).toMatch(/queue was full/);
    // The slot is genuinely free again rather than held by a command nobody has, so the active
    // execution claim parks immediately while the failed worker remains in the prime's history.
    expect(pendingWorkerSpawns()).toEqual([]);
    expect(swarmState().running).toBe(false);
  });

  it('keeps a dropped worker transport durable until the failed broker state is durable', async () => {
    await pair();
    spawn({ workers: [{ task: 'overflow crash-order worker' }], caller: { conversationId: PRIME_CHAT } });
    await waitForOpened(1);
    const workerCommand = pendingCommands().find((entry) => entry.what === 'worker:worker-1')!;
    expect(workerCommand).toBeTruthy();
    await flushDurable();

    let entered!: () => void;
    const immediateEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let brokerProjection: ReturnType<typeof snapshotSwarm> = null;
    onSwarmPersistNow(async (snapshot) => {
      brokerProjection = snapshot;
      entered();
      await held;
      await writeDurableNow('swarm', snapshot);
    });

    try {
      // The 21st command drops the oldest worker bootstrap. Live delivery should stop at once,
      // but disk must retain that old transport until the failed worker/dormant owner snapshot
      // held above has crossed its independent durability boundary.
      for (let n = 0; n < 20; n++) queueResume(`crash-order-session-${n}`, `crash-order-token-${n}`);
      await immediateEntered;
      expect(pendingCommands().some((entry) => entry.id === workerCommand.id)).toBe(false);
      expect(swarmState().running).toBe(false);
      expect(swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((entry) => entry.id === 'worker-1')).toMatchObject({
        state: 'failed'
      });

      await flushDurable();
      const beforeBrokerFsync = await readDurable<any>('bridge-commands');
      expect(beforeBrokerFsync?.commands?.some((entry: any) => entry?.id === workerCommand.id)).toBe(true);
      expect(
        (brokerProjection as ReturnType<typeof snapshotSwarm>)?.dormantRuns?.[0]?.agents.find(
          (entry) => entry.info.id === 'worker-1'
        )?.info.state
      ).toBe('failed');

      release();
      await Promise.resolve();
      await Promise.resolve();
      await flushDurable();
      await vi.waitFor(async () => {
        const after = await readDurable<any>('bridge-commands');
        expect(after?.commands?.some((entry: any) => entry?.id === workerCommand.id)).toBe(false);
      });
      const durableBroker = await readDurable<any>('swarm');
      expect(durableBroker?.dormantRuns?.[0]?.agents.find((entry: any) => entry?.info?.id === 'worker-1')?.info?.state).toBe(
        'failed'
      );
    } finally {
      release();
      onSwarmPersistNow((snapshot) => writeDurableNow('swarm', snapshot));
    }
  });

  it('ignores an acknowledgement for a command that does not exist', async () => {
    await pair();
    const reply = await request('POST', '/commands/ack', { body: { id: 'made-up' } });
    expect(reply.status).toBe(200);
  });

  it('rejects a current page acknowledgement after its command has gone away', async () => {
    await pair();
    const reply = await request('POST', '/commands/ack', {
      body: { id: 'expired-command', client: 'current-document', status: 'sent', conversationId: PRIME_CHAT }
    });
    expect(reply.status).toBe(404);
    expect(reply.body).toMatchObject({ error: 'no_such_command' });
  });

  /** There is no listing route left for a tab to poll, and nothing behind one. */
  it('has no queue for a tab to poll', async () => {
    await pair();
    spawn({ workers: [{ task: 'not for the taking' }], caller: { conversationId: PRIME_CHAT } });
    expect((await request('GET', '/commands')).status).toBe(404);
  });
});

// ------------------------------------------------- which browser opens chat B

/**
 * Two Chrome instances, and the one thing the operating system cannot be told.
 *
 * The user had two Chrome instances open. A chat finished in the background one, Compact &
 * Resume captured its brief, and the app asked the OS to open chat B — which resolved to the
 * foreground instance, because that is what handing `chrome.exe` a URL does. The summary was
 * typed into a chat in a browser this extension was not loaded in, so nothing redeemed the
 * command and the handoff ended up connected to nothing at all.
 *
 * Nothing on the OS side can fix it: no argument names a window, and an extension cannot say
 * which instance it is. But the capture request comes from chat A's own page, so the reply to
 * it can hand that browser the successor to open — and a tab that browser creates is in A's
 * window by construction, in a browser that has the extension by construction.
 */
describe('which browser opens the replacement chat', () => {
  const HOME = 'c0c0c0c0-1111-4222-8333-000000000b01';

  /** The real capture path: A's page files the ticket and then hands over its brief. */
  async function captureFrom(conversationId: string): Promise<Reply> {
    await request('POST', '/events', {
      body: {
        conversationId,
        events: [
          { kind: 'user_message', time: Date.now(), text: 'build the site', messageId: `m-${conversationId}` }
        ]
      }
    });
    const filed = await request('POST', '/compact', { body: { conversationId } });
    const token = filed.body.token as string;
    expect(token, 'no continuation was opened, so there is no brief to capture').toBeTruthy();
    return request('POST', '/compact', {
      body: { conversationId, token, summary: `carry on

${SAMPLE_BRIEF}` }
    });
  }

  it('answers the capture with the chat to open instead of opening it through the OS', async () => {
    await pair();
    const stored = await captureFrom(HOME);

    expect(stored.body.stored).toBe(true);
    expect(stored.body.placement).toEqual({ id: stored.body.commandId });
    // The whole point: this app did not ask the operating system where its own chat should go.
    expect(opened).toEqual([]);
    expect(pendingCommands()).toEqual([
      { id: stored.body.commandId, what: expect.stringContaining('resume:'), lastError: null }
    ]);
  });

  it('spends the placement on the reply that carries it, so one handoff is one tab', async () => {
    await pair();
    const stored = await captureFrom(HOME);
    expect(stored.body.placement).not.toBeNull();

    // A's own feed is the recovery route for a capture reply that never reached the page. It
    // must not hand out a second copy of an offer the page already has.
    const feed = await request('GET', `/activity?conversationId=${HOME}`);
    expect(feed.body.placement).toBeNull();
  });

  /**
   * A resume with no page waiting to be told still opens the way it always did.
   *
   * The automatic pickup and restart recovery both queue a resume with nothing in flight from
   * chat A — its tab may have been closed for an hour. Holding the OS opener back for those
   * would trade a wrong window for no window at all.
   */
  it('opens through the OS when no page is asking for the handoff', async () => {
    await pair();
    const { sessionId, token } = await compactedSession('c0c0c0c0-1111-4222-8333-000000000b02', 'carry on');
    const command = queueResume(sessionId, token)!;

    await waitForOpened(1);
    expect(opened).toEqual([commandUrl(command.id)]);
  });

  it('falls back to the OS when the browser it was handed to never opens the tab', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      const stored = await captureFrom(HOME);
      expect(stored.body.placement).not.toBeNull();
      expect(opened).toEqual([]);

      // The page took the offer and died before it could create the tab — a window closing, an
      // extension too old to understand the field. Nothing redeems, so the command is opened
      // the old way well inside its own ninety-second deadline rather than expiring unopened.
      await vi.advanceTimersByTimeAsync(BROWSER_PLACEMENT_MS + 1);
      expect(opened).toEqual([commandUrl(stored.body.commandId as string)]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ----------------------------------------------------------------- delivery

/**
 * The app opening the chat itself.
 *
 * Every case here is one the old pull-only delivery could not serve: it queued a command
 * and waited for a ChatGPT tab's content script to ask for it, so with no ChatGPT tab —
 * or no browser — the queue simply sat there and surfaced minutes later as tabs the user
 * had stopped expecting.
 */
describe('targeted open', () => {
  it('opens the fresh chat the instant a resume is queued, with no tab and no timer involved', async () => {
    setBrowserOpener(async (url) => {
      opened.push(url);
    });
    // Deliberately not paired and never polled: this is the "Chrome closed, no ChatGPT
    // tab, extension asleep" case, and the open has to happen anyway.
    const command = queueResume('session-open', 'handoff-open')!;

    await waitForOpened(1);
    expect(opened).toEqual([commandUrl(command.id)]);
    expect(commandUrl(command.id)).toContain(`clf=${command.id}`);
    expect(resumeJobFor('session-open')).toBeNull();
  });

  it('ends a browser-open rejection immediately rather than blocking the command queue', async () => {
    setBrowserOpener(async () => {
      throw new Error('no browser');
    });
    queueResume('session-nobrowser', 'handoff-nobrowser');
    // The lease write and opener rejection are both asynchronous.
    await vi.waitFor(() => expect(pendingCommands()).toEqual([]));

    expect(pendingCommands()).toEqual([]);
  });

  /**
   * No opener at all is an ending, not a wait.
   *
   * There used to be a poll route behind this: a command nothing could open simply sat in
   * the queue until some ChatGPT tab came and asked for it. With that gone, a queue with no
   * reader is a job that can never happen, so it fails here — the continuation aborts, the
   * session stays in the chat it is in, and nothing is left for a later sweep to find.
   */
  it('ends a command outright when this process cannot open a browser at all', async () => {
    setBrowserOpener(null);
    await pair();
    const { sessionId, token } = await compactedSession('77777777-8888-9999-aaaa-bbbbbbbbbbbb', 'carry on');
    queueResume(sessionId, token);

    expect(pendingCommands()).toEqual([]);
    expect(continuationByToken(token)?.state).toBe('aborted');
  });

  it('collapses repeated presses for one session into one job, one command and one tab', async () => {
    setBrowserOpener(async (url) => {
      opened.push(url);
    });
    const first = queueResume('session-once', 'handoff-1')!;
    const second = queueResume('session-once', 'handoff-1')!;
    const third = queueResume('session-once', 'handoff-1')!;

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(pendingCommands()).toHaveLength(1);
    // Claimed by the first open, so the repeats find nothing deliverable.
    await waitForOpened(1);
    expect(opened).toEqual([commandUrl(first.id)]);
  });

  it('supersedes a queued resume in place when the same session is compacted again', async () => {
    setBrowserOpener(async (url) => {
      opened.push(url);
    });
    await pair();
    const chat = '33333333-4444-5555-6666-777777777777';
    const older = await compactedSession(chat, 'the older brief');
    const first = queueResume(older.sessionId, older.token)!;
    const oldPage = await request('POST', '/commands/redeem', { body: { id: first.id, client: 'old-tab' } });
    expect(oldPage.body.command.text).toContain('the older brief');

    // Pressing the button again is a second compaction of the same session, with its own
    // brief and its own one-time token. The first transaction ends where it stands.
    abortContinuation(older.token, 'the user pressed the button again');
    const newerToken = await readyContinuation(older.sessionId, 'the newer brief', chat);
    const second = queueResume(older.sessionId, newerToken)!;

    // One session is one queued replacement chat, however many times it is compacted.
    expect(second.id).toBe(first.id);
    expect(pendingCommands()).toHaveLength(1);

    // The old page may finish its send after the command has been replaced in place. It no
    // longer owns this id, so its delayed ACK must not commit the newer continuation to the
    // old page's conversation.
    const stale = await request('POST', '/commands/ack', {
      body: { id: second.id, status: 'sent', conversationId: chat, client: 'old-tab' }
    });
    expect(stale.status).toBe(409);
    expect(pendingCommands()).toHaveLength(1);

    const redeemed = await request('POST', '/commands/redeem', { body: { id: second.id, client: 'tab-1' } });
    expect(redeemed.body.command.text).toContain('the newer brief');
    expect(redeemed.body.command.text).not.toContain('the older brief');
  });

  /**
   * The tab opened and then nothing happened. There is no scheduler waiting to try again.
   *
   * This is the whole failure model in one test: the app opens exactly one chat, gives that
   * page a deadline, and when the deadline passes the attempt is over. Over means the
   * continuation is aborted and the session is still attached to the chat it was already
   * in — a state the user can see and act on — rather than a queue entry that reopens a
   * tab minutes later, on its own, for something they have stopped expecting.
   */
  it('ends the continuation when the chat it opened never reports back', async () => {
    vi.useFakeTimers();
    try {
      setBrowserOpener(async (url) => {
        opened.push(url);
      });
      await pair();
      const { sessionId, token } = await compactedSession('44444444-5555-6666-7777-888888888888', 'carry on');
      const command = queueResume(sessionId, token)!;
      await waitForOpened(1);
      expect(opened).toEqual([commandUrl(command.id)]);

      // The page never redeems, never acks, never types.
      await vi.advanceTimersByTimeAsync(90_000);

      expect(pendingCommands()).toEqual([]);
      expect(continuationByToken(token)?.state).toBe('aborted');
      // And no second tab was opened for it on the way out.
      expect(opened).toEqual([commandUrl(command.id)]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('withdraws a cancelled resume so no tab opens for it afterwards', async () => {
    setBrowserOpener(async (url) => {
      opened.push(url);
    });
    await pair();
    const command = queueResume('session-cancel', 'handoff-cancel')!;
    await waitForOpened(1);

    expect(cancelResume('session-cancel')).toBe(true);
    expect(pendingCommands()).toEqual([]);

    // The tab is already open on the marker, and this is what it finds when it redeems:
    // nothing, so it types nothing. That is the whole of cancellation reaching the browser.
    expect((await request('POST', '/commands/redeem', { body: { id: command.id, client: 'tab-1' } })).status).toBe(404);
    expect(opened).toHaveLength(1);
  });

  it('hands a marked page its own command by id, once, and refuses an unknown id', async () => {
    await pair();
    const { sessionId, token } = await compactedSession('44444444-5555-6666-7777-888888888888', 'the brief itself');
    const command = queueResume(sessionId, token)!;

    const redeemed = await request('POST', '/commands/redeem', { body: { id: command.id, client: 'tab-1' } });
    expect(redeemed.status).toBe(200);
    expect(redeemed.body.command.id).toBe(command.id);
    expect(redeemed.body.command.text).toContain('the brief itself');
    // Redeeming again is fine — the page may reload — and the same page is the same
    // claimant, so it gets the same brief back rather than an empty command.
    const again = await request('POST', '/commands/redeem', { body: { id: command.id, client: 'tab-1' } });
    expect(again.body.command.text).toContain('the brief itself');
    expect(pendingCommands()).toHaveLength(1);

    expect((await request('POST', '/commands/redeem', { body: { id: 'not-a-command', client: 'tab-1' } })).status).toBe(
      404
    );
  });

  it('keeps a redeemed resume alive past the short ACK deadline without outliving its continuation', async () => {
    vi.useFakeTimers();
    try {
      setBrowserOpener(async (url) => {
        opened.push(url);
      });
      await pair();
      const sourceConversation = '44444444-5555-6666-7777-888888888888';
      const { sessionId, token } = await compactedSession(
        sourceConversation,
        'the slow-start brief'
      );
      const command = queueResume(sessionId, token)!;

      // Browser/ChatGPT startup consumes most of the original open-attempt deadline.
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await redeem(command.id, 'slow-tab')).text).toContain('the slow-start brief');

      // Hidden Chromium tabs can stretch content.js's conversation-id wait beyond 90s. The exact
      // page already owns the one-shot continuation, so the short command deadline must not abort
      // it while that existing continuation is still valid.
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(pendingCommands().map((entry) => entry.what)).toEqual([`resume:${sessionId}`]);
      expect(continuationByToken(token)?.state).toBe('claimed');

      // No new lifetime is invented: the existing 10m continuation TTL remains the outer bound.
      await vi.advanceTimersByTimeAsync(7 * 60_000);
      expect(pendingCommands()).toEqual([]);
      expect(continuationByToken(token)?.state).toBe('aborted');
      expect((await getSession(sessionId))?.conversationId).toBe(sourceConversation);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ------------------------------------------------------- worker bootstrap failure

describe('a worker chat that never opens', () => {
  it('fails the worker definitively instead of leaving it invited, and lets the next one through', async () => {
    await pair();
    spawn({ workers: [{ task: 'first audit' }, { task: 'second audit' }], caller: { conversationId: PRIME_CHAT } });
    expect(pendingWorkerSpawns().map((worker) => worker.id)).toEqual(['worker-1', 'worker-2']);

    // The page took the bootstrap and could not type it — a tab closed too early, or
    // ChatGPT refusing the message. It says so, and that is the end of this worker: the page
    // gets one attempt, so handing the same command back would only be the app disbelieving
    // it.
    const first = await redeem();
    expect(first.agent).toBe('worker-1');
    await request('POST', '/commands/ack', { body: { id: first.id, status: 'failed', error: 'tab closed' } });

    const state = swarmState();
    const worker1 = state.agents.find((agent) => agent.id === 'worker-1')!;
    expect(worker1.state).toBe('failed');
    expect(worker1.result).toContain('tab closed');
    // No zombie: it is not owed a tab, and it does not count as a live worker.
    expect(pendingWorkerSpawns().map((worker) => worker.id)).toEqual(['worker-2']);
    expect(pendingCommands().some((command) => command.what === 'worker:worker-1')).toBe(false);

    // The prime is told, rather than waiting for a report that cannot come.
    const prime = state.agents.find((agent) => agent.id === 'prime')!;
    expect(prime.pending).toBeGreaterThan(0);

    // And worker-2 is no longer stuck behind it: its chat opened the moment worker-1 ended.
    const next = await redeem();
    expect(next.agent).toBe('worker-2');
  });

  /**
   * One cold browser start at a time, because a second one is a second browser.
   *
   * Handing a URL to a browser that is already running is free. Handing one to a machine with
   * no browser running is a cold start, and a second open fired into that window does not join
   * the instance still booting — it becomes an instance of its own, with its own tabs and its
   * own memory. Delivery advances the moment a command ends, so a browser that never came back
   * was answered with one cold start per queued command, and every close the user performed was
   * answered with another. Live on 2026-09-01: eight Chrome process trees, each holding its own
   * ChatGPT tabs, together pegging the machine.
   */
  it('waits for one cold browser start rather than stacking a second', async () => {
    await pair();
    vi.useFakeTimers();
    try {
      const attempts: string[] = [];
      setBrowserOpener(async (url) => {
        attempts.push(url);
        throw new Error('the browser is still starting');
      });
      // The user closed the browser: nothing has reported for longer than presence lasts, so
      // every open from here is a cold start rather than a URL handed to a running browser.
      await vi.advanceTimersByTimeAsync(61_000);

      spawn({ workers: [{ task: 'first audit' }, { task: 'second audit' }], caller: { conversationId: PRIME_CHAT } });
      await flushDurable();
      await vi.advanceTimersByTimeAsync(10);
      await flushDurable();

      // worker-1's open failed and ended its command, so delivery advanced to worker-2 in the
      // same beat. That is the beat this guard exists for: worker-2 waits for the browser
      // worker-1 asked for instead of asking the operating system for a second one.
      expect(attempts).toHaveLength(1);
      expect(pendingCommands().some((command) => command.what === 'worker:worker-2')).toBe(true);

      // Still nothing has reported, so the launch is now one this app has stopped believing in
      // and worker-2 may have its own.
      await vi.advanceTimersByTimeAsync(60_001);
      await flushDurable();
      await vi.advanceTimersByTimeAsync(10);
      expect(attempts).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A bootstrap that ends by being *retired* has to move the line too.
   *
   * Only `drop()`'s callers advanced the queue. A worker whose page lost its ACK is bound
   * through `/events` instead, and when its command later expires it is retired rather than
   * dropped — with nothing behind it ever delivered. Observed live: `worker-3` sat `invited`
   * for nine minutes with `claimedAt: null`, holding the last free slot, while worker-1 and
   * worker-2 ran normally.
   */
  it('opens the next worker chat when a bootstrap is retired rather than dropped', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'first audit' }, { task: 'second audit' }], caller: { conversationId: PRIME_CHAT } });

      const first = await redeem();
      expect(first.agent).toBe('worker-1');
      // The page redeemed and typed, but its ACK never arrived. `/events` is the recovery path,
      // and it binds the worker without ever finishing the command.
      const reply = await request('POST', '/events', {
        body: {
          conversationId: LOST_ACK_CHAT,
          agent: 'worker-1',
          agentCommandId: first.id,
          events: [{ kind: 'turn_start', time: Date.now(), turnId: 'lost-ack-turn' }]
        }
      });
      expect(reply.status).toBe(200);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');

      // Nothing else happens in this app. The only thing left is worker-1's command running out.
      const openedBefore = opened.length;
      await vi.advanceTimersByTimeAsync(COMMAND_DEADLINE_MS + 1_000);
      await vi.waitFor(() => expect(opened.length).toBeGreaterThan(openedBefore));

      const next = await redeem(new URL(opened[openedBefore]!).searchParams.get('clf')!);
      expect(next.agent).toBe('worker-2');
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A chat that opened and never picked up its marker is opened once more, then failed.
   *
   * worker-4 on 2026-09-02: the tab loaded as an empty New chat, the bridge held its lease for
   * the full ninety seconds, and the two workers queued behind it opened only after it was
   * failed. The re-open is the same command — single-owner, so a late redeem from the first tab
   * is refused and nothing is typed twice — and it is spent once.
   */
  it('opens a worker chat once more when the first page never redeems, and fails it after the second silence', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'opens first' }, { task: 'waits behind it' }], caller: { conversationId: PRIME_CHAT } });
      await vi.waitFor(() => expect(opened).toHaveLength(1));
      const first = new URL(opened[0]!).searchParams.get('clf')!;

      await vi.advanceTimersByTimeAsync(WORKER_REDEEM_MS + 1_000);
      await vi.waitFor(() => expect(opened).toHaveLength(2));
      // The same command, not a second one: whichever page redeems first owns it.
      expect(new URL(opened[1]!).searchParams.get('clf')).toBe(first);
      expect(pendingWorkerSpawns().map((worker) => worker.id)).toEqual(['worker-1', 'worker-2']);

      const second = await redeem(first, 'tab-2');
      expect(second.agent).toBe('worker-1');
      const late = await request('POST', '/commands/redeem', { body: { id: first, client: 'tab-1' } });
      expect(late.status).toBe(409);
      // Owned now: the page's typing budget applies, and the redeem window no longer does.
      await vi.advanceTimersByTimeAsync(WORKER_REDEEM_MS + 1_000);
      expect(opened).toHaveLength(2);
      expect(pendingWorkerSpawns().map((worker) => worker.id)).toEqual(['worker-1', 'worker-2']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a worker whose reopened chat never redeems either, and moves the line on', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'opens first' }, { task: 'waits behind it' }], caller: { conversationId: PRIME_CHAT } });
      await vi.waitFor(() => expect(opened).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(WORKER_REDEEM_MS + 1_000);
      await vi.waitFor(() => expect(opened).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(WORKER_REDEEM_MS + 1_000);
      // worker-1 is failed, and worker-2's chat opens in the same beat rather than after ninety seconds.
      await vi.waitFor(() => expect(opened).toHaveLength(3));
      expect(pendingWorkerSpawns().map((worker) => worker.id)).toEqual(['worker-2']);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('failed');
      const next = await redeem(new URL(opened[2]!).searchParams.get('clf')!);
      expect(next.agent).toBe('worker-2');
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The absolute clock a still-`invited` worker lives under.
   *
   * A command still in line has no clock of its own; the limit is absolute from the invitation,
   * so no combination of a late hand-out and a fresh lease can keep the slot past two minutes.
   */
  it('stops holding a slot invited two minutes after the invitation, however late its chat opens', async () => {
    vi.useFakeTimers();
    const previous = getConfig();
    try {
      await saveConfig({ ...previous, multiAgent: { ...previous.multiAgent, maxWorkers: 3 } });
      await pair();
      spawn({
        workers: [{ task: 'opens first' }, { task: 'waits behind it' }, { task: 'waits longest' }],
        caller: { conversationId: PRIME_CHAT }
      });
      expect(pendingWorkerSpawns().map((worker) => worker.id)).toEqual(['worker-1', 'worker-2', 'worker-3']);
      // Nothing ever redeems. Each worker's chat opens, is opened once more, and fails: worker-1
      // by forty seconds, worker-2 by eighty, and worker-3's re-open lands at about a hundred.
      // Counting worker-3's clock from *there* would keep the slot invited past two minutes; the
      // limit is measured from the invitation instead.
      let elapsed = 0;
      const advance = async (ms: number): Promise<void> => {
        await vi.advanceTimersByTimeAsync(ms);
        elapsed += ms;
      };
      // Each re-open re-leases through a real durable write, which lands after the fake clock has
      // moved on, so the deadline it arms may need one more tick to fire.
      const openedSoon = async (count: number): Promise<void> => {
        try {
          await vi.waitFor(() => expect(opened).toHaveLength(count), { timeout: 300 });
        } catch {
          await advance(1_000);
          await vi.waitFor(() => expect(opened).toHaveLength(count));
        }
      };
      for (let count = 1; count <= 5; count += 1) {
        await openedSoon(count);
        // The browser keeps polling, so no re-open is mistaken for a cold browser launch.
        await request('GET', '/status');
        await advance(WORKER_REDEEM_MS + 1_000);
      }
      await openedSoon(6);
      expect(elapsed).toBeLessThan(WORKER_BOOTSTRAP_LIMIT_MS - 5_000);
      expect(pendingWorkerSpawns().map((worker) => worker.id)).toEqual(['worker-3']);

      await advance(WORKER_BOOTSTRAP_LIMIT_MS + 1_000 - elapsed);
      // No zombie slot left behind: nothing is still owed a tab, and nothing is still invited.
      await vi.waitFor(() => expect(pendingWorkerSpawns()).toEqual([]));
      expect(swarmState().agents.every((agent) => agent.state !== 'invited')).toBe(true);
    } finally {
      vi.useRealTimers();
      await saveConfig(previous);
    }
  });
});

// --------------------------------------------------- unattributed recovery

/**
 * A tool call no page claimed means one thing: something is generating and the request-id join
 * that names it is broken - normally because that document's own reporting died under it. It
 * never says which chat, and these tests exist to hold the app to that.
 *
 * So the boundary asserted here is attribution itself, not liveness. A page that keeps posting
 * turns and progress proves nothing about the join and must not call off a repair; a call that
 * lands attributed does, for that one chat. What survives that filter has to be a single chat
 * the app can prove is mid-turn, or nothing is touched at all.
 */
describe('unattributed activity recovery', () => {
  const PRIME = 'abababab-1111-2222-3333-444444444444';
  const WORKER = 'cdcdcdcd-1111-2222-3333-444444444444';
  const OTHER = 'efefefef-1111-2222-3333-444444444444';

  let requests = 0;

  /** A finished call whose request id the page never confirmed. Files under Unattributed. */
  function unattributed(requestId?: string): Promise<unknown> {
    return recordToolCall({
      tool: 'read',
      args: { paths: ['/project/whoever.ts'] },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: Date.now(),
      ...(requestId ? { requestId } : {})
    });
  }

  /** An unattributed call that names its server turn: the recorder waits out the evidence grace first. */
  async function unattributedTurn(requestId: string): Promise<void> {
    const call = unattributed(requestId);
    await vi.advanceTimersByTimeAsync(REQUEST_ID_GRACE_MS);
    await call;
  }

  function events(conversationId: string, items: unknown[]): Promise<any> {
    return request('POST', '/events', { body: { conversationId, events: items } });
  }

  /**
   * A call this chat's own message model names, which is the only thing that proves its join
   * works. The page paints the connector row before the request lands, which is one of the two
   * real orders and the one that needs no waiting.
   */
  async function attributed(conversationId: string, endsActivity = false, startedAt?: number): Promise<void> {
    const requestId = `wfr_repair_${++requests}`;
    // This describe deliberately reuses conversation ids while fake time jumps backwards between
    // tests. Keep default synthetic call starts monotonic; boundary tests pass their exact time.
    const callStartedAt = startedAt ?? Date.now() + requests * CHAT_SILENCE_MS * 4;
    await events(conversationId, [
      {
        kind: 'tool_evidence',
        time: Date.now(),
        calls: [{ messageId: `m-${requests}`, tool: 'read', order: 0, answered: false, requestId }]
      }
    ]);
    await recordToolCall({
      tool: 'read',
      args: { paths: ['/project/mine.ts'] },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: callStartedAt,
      requestId,
      endsActivity
    });
  }

  const openTurn = (turnId: string): unknown => ({ kind: 'turn_start', time: Date.now(), turnId });
  const endTurn = (turnId: string, outcome: string): unknown => ({
    kind: 'turn_end',
    time: Date.now(),
    turnId,
    outcome
  });

  /**
   * The extension's maintenance pass, which is the whole conversation about repairs.
   *
   * It reports the repair it was last handed and has carried out, and gets the next one - a
   * conversation id and nothing else. Whether that chat has a tab, and which one, is the
   * browser's own registry to answer, in test/extension.test.ts. What is held here is the
   * delivery lifecycle: exactly one chat named, and named again until it is actually repaired.
   */
  /**
   * One maintenance pass: report the handout this pass carried out, then collect the next.
   *
   * `repaired` is the token the app minted for a previous handout, never a conversation id.
   * That is the fence, and being able to quote the wrong one is what a test here needs.
   */
  async function maintenanceBatch(
    repaired?: string,
    repairAction?: 'reloaded' | 'reopened'
  ): Promise<Array<{ conversationId: string; token: string; reason: string }>> {
    const path = repaired
      ? `/status?repaired=${encodeURIComponent(repaired)}${repairAction ? `&repairAction=${repairAction}` : ''}`
      : '/status';
    const reply = await request('GET', path);
    expect(reply.status).toBe(200);
    return reply.body.repairs ?? [];
  }

  /**
   * The one chat a pass was handed, for the tests whose subject is a single failure.
   *
   * Deliberately strict about the count: a pass that names two chats where the test expects one
   * is a batching bug, and quietly returning the first would hide it behind an assertion that
   * still passes.
   */
  async function maintenance(
    repaired?: string,
    repairAction?: 'reloaded' | 'reopened'
  ): Promise<{ conversationId: string; token: string; reason: string } | null> {
    const batch = await maintenanceBatch(repaired, repairAction);
    expect(batch.length).toBeLessThanOrEqual(1);
    return batch[0] ?? null;
  }

  /** The chat a pass was told to repair. */
  const chatOf = (repair: { conversationId: string } | null): string | null => repair?.conversationId ?? null;

  /** The chat urls this app asked the browser to open, ignoring marked bootstrap commands. */
  const reopened = (conversationId: string): string[] =>
    opened.filter((url) => url === `https://chatgpt.com/c/${conversationId}`);

  it('waits fifteen seconds on a lone suspect, then hands the browser that one chat to reload', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(PRIME, [openTurn('turn-live')]);
      await unattributed();

      // One suspect is nobody to be told apart from, so the wait is not a discrimination budget
      // at all - it is the round trip the identity notice promises the model for its retry.
      await vi.advanceTimersByTimeAsync(14_999);
      expect(await maintenance()).toBeNull();

      await vi.advanceTimersByTimeAsync(1);
      const handout = await maintenance();
      expect(chatOf(handout)).toBe(PRIME);
      // Reported carried out, and that is the end of it: a reload whose effect there is any
      // point waiting to observe is never repeated.
      expect(await maintenance(handout!.token)).toBeNull();
      expect(await maintenance()).toBeNull();
      // And the app opened nothing itself: that chat has a tab, and a url open would make a
      // second one of it - the duplicate this path exists to avoid.
      expect(reopened(PRIME)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The session outlives Compact & Resume, so chat B's feed is cut from a log that also holds
   * chat A's reloads. Every other row names a turn and finds none in B; a reload notice names
   * none and was painted before B's first user message — the bootstrap — as if B had been
   * reloaded three times before it was born. The bootstrap this app typed is the durable
   * boundary: reloads before it are A's and leave the feed, reloads after it stay.
   */
  it('keeps an earlier chat’s reload notices out of the chat that resumed it', async () => {
    await pair();
    await events(PRIME, [
      { kind: 'user_message', time: Date.now(), text: 'build the level editor', messageId: 'm-a-1' }
    ]);
    const session = await findSessionByConversation(PRIME, { requireUnique: true });
    expect(session).not.toBeNull();
    expect(await recordProgress(session!.id, 'browser-repair:old', 'Reloaded chat to recover an interrupted response.')).not.toBeNull();
    await events(PRIME, [
      {
        kind: 'user_message',
        time: Date.now(),
        text: '[[CLF-RESUME:O8THi8gMTC6LvH9GLclDIQ]]\n\nContinuing a Chat On Steroids session that was compacted.',
        messageId: 'm-b-bootstrap'
      }
    ]);
    expect(await recordProgress(session!.id, 'browser-repair:new', 'Reloaded chat to recover missing connector attribution.')).not.toBeNull();

    const feed = await request('GET', `/activity?conversationId=${PRIME}`);
    expect(feed.status).toBe(200);
    const notices = feed.body.stream.filter(
      (row: { kind: string; progressId?: string }) => row.kind === 'progress' && row.progressId?.startsWith('browser-repair:')
    );
    expect(notices.map((row: { progressId: string }) => row.progressId)).toEqual(['browser-repair:new']);
    // The bootstrap itself still anchors: the surviving notice sits after it.
    const bootstrap = feed.body.userAnchors.find((anchor: { messageId: string }) => anchor.messageId === 'm-b-bootstrap');
    expect(bootstrap).toBeDefined();
    expect(notices[0].seq).toBeGreaterThan(bootstrap.seq);
  });

  it('replaces one recovery timeline row as the browser attempt fails, retries and succeeds', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(PRIME, [openTurn('turn-reload-note')]);
      await unattributed();
      await vi.advanceTimersByTimeAsync(60_000);
      const session = await findSessionByConversation(PRIME, { requireUnique: true });
      expect(session).not.toBeNull();
      const before = (await readEvents(session!.id)).reduce((seq, event) => Math.max(seq, event.seq), 0);
      const snapshots = async () => (await readEvents(session!.id, { kinds: ['progress'] })).filter(
        (event): event is Extract<SessionEvent, { kind: 'progress' }> => event.seq > before && event.kind === 'progress'
      );

      const handout = await maintenance();
      expect(chatOf(handout)).toBe(PRIME);
      expect((await snapshots()).map((event) => event.message.text)).toEqual([
        'Trying to reload chat to recover missing connector attribution…'
      ]);
      // The row names the turn it is repairing, so every reader files it inside that turn —
      // the page paints it among the turn's tool calls rather than between turns.
      expect((await snapshots()).map((event) => event.turnId)).toEqual(['turn-reload-note']);

      const failed = await request(
        'GET',
        `/status?repairFailed=${encodeURIComponent(handout!.token)}&repairAction=reloaded`
      );
      expect(failed.status).toBe(200);
      expect(failed.body.repairs).toEqual([]);
      expect(foldProgress(await snapshots()).map((event) => event.kind === 'progress' ? event.message.text : '')).toEqual([
        'Reload failed while recovering missing connector attribution; will retry.'
      ]);

      const retry = await maintenance();
      expect(chatOf(retry)).toBe(PRIME);
      expect(foldProgress(await snapshots()).map((event) => event.kind === 'progress' ? event.message.text : '')).toEqual([
        'Trying to reload chat to recover missing connector attribution…'
      ]);

      await maintenance(retry!.token, 'reloaded');
      // Replaying the same receipt is harmless: only the still-handed token can update the row.
      const recorded = (await snapshots()).length;
      await maintenance(retry!.token, 'reloaded');
      expect(await snapshots()).toHaveLength(recorded);
      expect(foldProgress(await snapshots()).map((event) => event.kind === 'progress' ? event.message.text : '')).toEqual([
        'Reloaded chat to recover missing connector attribution.'
      ]);
      // Every rewrite of the row keeps the turn the first snapshot named.
      expect((await snapshots()).every((event) => event.turnId === 'turn-reload-note')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A browser worker can disappear after collecting a handout but before reporting an action.
   * Its next plain maintenance pass is the negative acknowledgement: success would have been
   * reported in the same request, while an action-level exception uses the explicit failure
   * receipt tested above. Either path must keep the repair retryable.
   */
  it('hands the same repair out again until the browser says it carried one out', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(PRIME, [openTurn('turn-live')]);
      await unattributed();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(chatOf(await maintenance())).toBe(PRIME);
      expect(chatOf(await maintenance())).toBe(PRIME);
      const third = await maintenance();
      expect(chatOf(third)).toBe(PRIME);
      // Nothing was opened while it was being retried, either.
      expect(reopened(PRIME)).toEqual([]);

      expect(await maintenance(third!.token)).toBeNull();
      expect(await maintenance()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A repair answers one broken turn, not a chat forever.
   *
   * Nothing else retires it: the attributed call that clears a chat is exactly what a repaired
   * turn need never make, so a turn that reloads, finishes and says nothing more would leave
   * that chat permanently unrepairable - the next broken turn in it silently ignored.
   */
  it('repairs a later broken turn in a chat it has already repaired once', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(PRIME, [openTurn('turn-first')]);
      await unattributed();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await maintenance((await maintenance())!.token)).toBeNull();

      // That turn ends without ever making an attributable call, and the next one breaks too.
      await vi.advanceTimersByTimeAsync(BROWSER_RECOVERY_COOLDOWN_MS);
      await events(PRIME, [endTurn('turn-first', 'completed'), openTurn('turn-second')]);
      await unattributed();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(chatOf(await maintenance())).toBe(PRIME);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * One reload per server turn. Ten reloads prove only that the first nine did not help.
   *
   * ChatGPT is sometimes broken in a way a fresh page does not mend, and the reload itself is
   * what used to hide that: the replacement document re-observes the same generation and names
   * it a new local turn, which looked exactly like the broken turn being over. So the repair was
   * retired, the still-dead join produced the next unattributed call, and a minute later
   * the same chat was reloaded again - for as long as the turn lasted, tearing down whatever
   * work the page was doing each time.
   *
   * What an unattributed call still carries is its request id, and that is the server turn it
   * belongs to. The reload is rationed by it: the same id after the reload is the same broken
   * turn and buys nothing, however many local turns the reloaded page mints; a different id
   * is a different turn — the user's next message from the phone, say — and gets its own.
   */
  it('reloads once per unattributed request id, however the reloaded page re-labels the turn', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(PRIME, [openTurn('turn-live')]);
      await unattributedTurn('req-broken');
      await vi.advanceTimersByTimeAsync(60_000);
      const handout = await maintenance();
      expect(chatOf(handout)).toBe(PRIME);
      expect(await maintenance(handout!.token)).toBeNull();

      // The page comes back mid-generation, so it reports the turn it found under a fresh local
      // id, and the same server turn is still arriving with nothing to attribute it by.
      await events(PRIME, [openTurn('turn-after-reload')]);
      await unattributedTurn('req-broken');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await maintenance()).toBeNull();
      expect(reopened(PRIME)).toEqual([]);

      // An attributed call proves the reload worked, which is a reason not to need another one
      // - never a reason to be handed one. The same request id stays spent.
      await attributed(PRIME);
      await vi.advanceTimersByTimeAsync(BROWSER_RECOVERY_COOLDOWN_MS);
      await events(PRIME, [openTurn('turn-later')]);
      await unattributedTurn('req-broken');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await maintenance()).toBeNull();

      // A different request id is a different server turn, and the first unplaceable call of
      // it is news again: its own reload, whatever the local turn count says.
      await unattributedTurn('req-next-turn');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(chatOf(await maintenance())).toBe(PRIME);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A receipt answers one handout, not a conversation.
   *
   * The pass that carries a reload out can report it late - the app may have retired that
   * repair and raised a new one for the next broken turn of the same chat by then. Believing
   * that receipt would record the newer turn as repaired without anything having reloaded it,
   * and a turn recorded as repaired is never repaired again. So the token minted with each
   * handout is what is answered, and a receipt matching no outstanding handout closes nothing.
   */
  it('does not let a receipt from a spent repair close the repair of a later broken turn', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(PRIME, [openTurn('turn-first')]);
      await unattributed();
      await vi.advanceTimersByTimeAsync(60_000);
      const first = await maintenance();
      expect(chatOf(first)).toBe(PRIME);

      // That turn ends before the receipt for it arrives, and the next one breaks the same way.
      await events(PRIME, [endTurn('turn-first', 'completed'), openTurn('turn-second')]);
      await unattributed();
      await vi.advanceTimersByTimeAsync(60_000);
      const second = await maintenance();
      expect(chatOf(second)).toBe(PRIME);
      expect(second!.token).not.toBe(first!.token);

      // The late receipt lands. It says nothing about the second turn, which is still handed
      // out - and handed out afresh, because a pass that reported nothing is a pass that failed.
      const again = await maintenance(first!.token);
      expect(chatOf(again), 'the second turn was never reloaded').toBe(PRIME);
      expect(await maintenance(again!.token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let later unattributed calls renew the first incident', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(PRIME, [openTurn('turn-live')]);
      await unattributed();

      await vi.advanceTimersByTimeAsync(10_000);
      await unattributed();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(await maintenance()).toBeNull();

      // A rung after the *first* one, not twenty-five seconds after it or a rung after the last.
      await vi.advanceTimersByTimeAsync(1);
      expect(chatOf(await maintenance())).toBe(PRIME);
    } finally {
      vi.useRealTimers();
    }
  });

  it('calls the repair off when that chat proves an attributed call', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(PRIME, [openTurn('turn-live')]);
      await unattributed();

      await vi.advanceTimersByTimeAsync(10_000);
      await attributed(PRIME);

      await vi.advanceTimersByTimeAsync(50_000);
      expect(await maintenance()).toBeNull();
      expect(reopened(PRIME)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not accept page liveness as proof that the join recovered', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(PRIME, [openTurn('turn-live')]);
      await unattributed();

      // The document is alive and talking - a new turn, progress, everything except the one
      // thing at issue. Its request ids are still reaching nobody, so the repair stands.
      await vi.advanceTimersByTimeAsync(10_000);
      await events(PRIME, [
        { kind: 'progress', time: Date.now(), turnId: 'turn-live', text: 'still here' },
        endTurn('turn-live', 'completed'),
        openTurn('turn-next')
      ]);

      await vi.advanceTimersByTimeAsync(50_000);
      expect(chatOf(await maintenance())).toBe(PRIME);
    } finally {
      vi.useRealTimers();
    }
  });

  it('repairs every chat that could be the broken one, not only a lone candidate', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(PRIME, [openTurn('turn-prime')]);
      await events(OTHER, [openTurn('turn-other')]);
      await unattributed();

      // Two chats are generating and neither has proved its join, so both are broken until one
      // of them shows otherwise. Standing down here is what left a whole swarm that lost the
      // same evidence path at once with no repair at all.
      //
      // Two suspects is also a rung up from one: there is now somebody to be told apart from.
      await vi.advanceTimersByTimeAsync(29_999);
      expect(await maintenanceBatch()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);

      // Both in the one pass. The browser's alarm has a thirty-second floor, so handing these
      // out one per pass would put a minute between two failures that happened together.
      const handed = (await maintenanceBatch()).map((entry) => entry.conversationId).sort();
      expect(handed).toEqual([PRIME, OTHER].sort());
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a chat that proved its join out of the repair', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(PRIME, [openTurn('turn-prime')]);
      await events(OTHER, [openTurn('turn-other')]);
      await unattributed();

      // An attributed call is the one fact that says this chat's join works. It is the whole
      // difference between the chats that get reloaded and the chats that are simply busy.
      await attributed(OTHER);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(chatOf(await maintenance())).toBe(PRIME);
      // A handout the browser never confirmed comes back around; the chat that proved its join
      // is simply never among them, however many passes go by.
      expect(chatOf(await maintenance())).toBe(PRIME);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a chat that has finished its answer, or that the user stopped, alone', async () => {
    for (const outcome of ['completed', 'stopped']) {
      vi.useFakeTimers();
      try {
        resetSwarm();
        resetBridgeForTests();
        resetRecorderForTests();
        opened.length = 0;
        setBrowserOpener(async (url) => {
          opened.push(url);
        });
        await pair();
        await events(PRIME, [openTurn(`turn-${outcome}`), endTurn(`turn-${outcome}`, outcome)]);
        await unattributed();

        await vi.advanceTimersByTimeAsync(60_000);
        expect(await maintenance(), `${outcome} must not be reloaded`).toBeNull();
        expect(reopened(PRIME)).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it('hands a missing worker tab to the browser until an action receipt or that page returns', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'audit' }], caller: { conversationId: PRIME } });
      const bootstrap = await redeem();
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId: WORKER, agent: 'worker-1' }
      });
      await events(WORKER, [openTurn('turn-worker-missing-retry')]);
      await request('POST', '/closed', { body: { conversationId: WORKER } });
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('detached');

      const first = await maintenance();
      expect(chatOf(first)).toBe(WORKER);
      const retry = await maintenance();
      expect(chatOf(retry)).toBe(WORKER);
      expect(retry!.token).not.toBe(first!.token);
      // The app itself never opens recovery tabs. The extension scans Chrome immediately
      // before acting, which is the only place that can choose reload vs open without a race.
      expect(reopened(WORKER)).toEqual([]);

      await events(WORKER, [openTurn('turn-worker-back')]);
      expect(await maintenance()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives a detached prime the same exact missing-tab recovery as a worker', async () => {
    await pair();
    spawn({ workers: [{ task: 'keep this run resumable' }], caller: { conversationId: PRIME } });
    await events(PRIME, [openTurn('turn-prime-before-close')]);
    await request('POST', '/closed', { body: { conversationId: PRIME } });

    expect(swarmState().agents.find((agent) => agent.role === 'prime')?.state).toBe('detached');
    expect(chatOf(await maintenance())).toBe(PRIME);
  });

  it('keeps a completed prime detached without reopening its idle chat', async () => {
    await pair();
    spawn({ workers: [{ task: 'keep this run resumable' }], caller: { conversationId: PRIME } });
    await events(PRIME, [openTurn('turn-prime-completed'), endTurn('turn-prime-completed', 'completed')]);
    await request('POST', '/closed', { body: { conversationId: PRIME } });

    expect(swarmState().agents.find((agent) => agent.role === 'prime')?.state).toBe('detached');
    expect(await maintenance(), 'run ownership is not an open Prime turn').toBeNull();
  });

  it('reopens a closed tab once per close, immediately, with no floor between closes', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'audit' }], caller: { conversationId: PRIME } });
      const bootstrap = await redeem();
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId: WORKER, agent: 'worker-1' }
      });
      await events(WORKER, [openTurn('turn-worker-cooldown')]);
      await request('POST', '/closed', { body: { conversationId: WORKER } });
      const first = await maintenance();
      expect(chatOf(first)).toBe(WORKER);
      expect(first!.reason).toBe('no-tab');
      expect(await maintenance(first!.token, 'reopened')).toBeNull();
      // Repeated close reporting with no intervening page activity is still the same episode.
      await request('POST', '/closed', { body: { conversationId: WORKER } });
      expect(await maintenance()).toBeNull();

      // The exact page comes back and is closed again moments later. A closed tab has no page
      // the three-minute floor could be protecting, so the second close is reopened at once —
      // one close, one reopen, however close together they land.
      await events(WORKER, [openTurn('turn-worker-back')]);
      await events(WORKER, [openTurn('turn-worker-2')]);
      await vi.advanceTimersByTimeAsync(1_000);
      await request('POST', '/closed', { body: { conversationId: WORKER } });
      const second = await maintenance();
      expect(chatOf(second)).toBe(WORKER);
      expect(second!.token).not.toBe(first!.token);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The page's parting word is not the turn. A document being torn down has no Stop control,
   * so its last observation reads "completed" whatever the server is doing; on 2026-09-03
   * worker-1 reported exactly that one second before its `/closed` while its request id went on
   * calling tools. A worker slot that was working when its tab went is what the close detached,
   * and that is the fact the reopen reads.
   */
  it('reopens a worker whose page called its turn done a second before the tab closed', async () => {
    await pair();
    spawn({ workers: [{ task: 'audit' }], caller: { conversationId: PRIME } });
    const bootstrap = await redeem();
    await request('POST', '/commands/ack', {
      body: { id: bootstrap.id, status: 'sent', conversationId: WORKER, agent: 'worker-1' }
    });
    await events(WORKER, [openTurn('turn-worker-parting'), endTurn('turn-worker-parting', 'completed')]);
    await request('POST', '/closed', { body: { conversationId: WORKER } });

    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('detached');
    const handout = await maintenance();
    expect(chatOf(handout)).toBe(WORKER);
    expect(handout!.reason).toBe('no-tab');
  });

  it('reopens a prime whose page said done while its tools were still being called', async () => {
    await pair();
    spawn({ workers: [{ task: 'keep this run resumable' }], caller: { conversationId: PRIME } });
    await events(PRIME, [openTurn('turn-prime-parting'), endTurn('turn-prime-parting', 'completed')]);
    // A tool call inside the silence window is this app's own definition of a chat that is
    // working, and it outranks the page's verdict at the moment of teardown.
    await attributed(PRIME, false, Date.now());
    await request('POST', '/closed', { body: { conversationId: PRIME } });

    expect(swarmState().agents.find((agent) => agent.role === 'prime')?.state).toBe('detached');
    const handout = await maintenance();
    expect(chatOf(handout)).toBe(PRIME);
    expect(handout!.reason).toBe('no-tab');
  });

  /**
   * A turn-scoped repair is retired only by a later turn ending, so a chat whose tab dies on
   * the broken turn would hold it forever — and a held repair used to refuse the reopen. The
   * tab it wanted to reload is gone; the reopen is everything that reload would have done.
   */
  it('lets a closed tab supersede a held unattributed repair instead of waiting behind it', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'audit' }], caller: { conversationId: PRIME } });
      const bootstrap = await redeem();
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId: WORKER, agent: 'worker-1' }
      });
      await events(WORKER, [openTurn('turn-worker-unattributed')]);
      await unattributed();
      await vi.advanceTimersByTimeAsync(15_000);
      const held = await maintenance();
      expect(chatOf(held)).toBe(WORKER);
      expect(held!.reason).toBe('unattributed');

      // Handed out but never confirmed: the browser found the tab gone before it could act.
      await request('POST', '/closed', { body: { conversationId: WORKER } });
      const reopen = await maintenance();
      expect(chatOf(reopen)).toBe(WORKER);
      expect(reopen!.reason).toBe('no-tab');
      expect(reopen!.token).not.toBe(held!.token);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reloads for any error the page shows, once per user turn', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'hold the run open' }], caller: { conversationId: PRIME } });
      await events(PRIME, [openTurn('turn-prime')]);

      // A top-level banner the page could not name and did not call recoverable.
      await events(PRIME, [{
        kind: 'chat_error',
        time: Date.now(),
        text: 'Message delivery timed out. Please try again.',
        turnId: null,
        recoverable: false
      }]);
      const first = await maintenance();
      expect(chatOf(first)).toBe(PRIME);
      expect(first?.reason).toBe('assistant-error');
      expect(await maintenance(first!.token)).toBeNull();

      // The same turn, another error: its one reload is spent.
      await vi.advanceTimersByTimeAsync(BROWSER_RECOVERY_COOLDOWN_MS);
      await events(PRIME, [{
        kind: 'chat_error',
        time: Date.now(),
        text: 'Connection interrupted. Waiting for the complete answer',
        turnId: 'turn-prime',
        recoverable: true
      }]);
      expect(await maintenance()).toBeNull();

      // The user's next message is the next turn, and it brings its own reload.
      await events(PRIME, [endTurn('turn-prime', 'failed'), openTurn('turn-prime-2')]);
      await events(PRIME, [{
        kind: 'chat_error',
        time: Date.now(),
        text: 'Connection interrupted. Waiting for the complete answer',
        turnId: 'turn-prime-2',
        recoverable: true
      }]);
      expect(chatOf(await maintenance())).toBe(PRIME);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The live 2026-08-31 failure: a send that never reached a model at all.
   *
   * ChatGPT paints "Message delivery timed out" as a live region above the thread, because
   * the send died before there was an assistant turn to paint it in. The banner therefore
   * names no turn of its own - the page's live generation names it - and for a while that
   * shape was refused recovery outright. The app recorded the failure, marked the turn
   * failed, and left the chat parked on the error until a human noticed.
   */
  it('reloads a chat parked on a transport failure the banner could not name itself', async () => {
    await pair();
    await events(OTHER, [openTurn('turn-solo-delivery')]);
    await events(OTHER, [
      {
        kind: 'chat_error',
        time: Date.now(),
        text: 'Message delivery timed out. Please try again.',
        // Supplied by the page's own live generation, exactly as content.js stamps it.
        turnId: 'turn-solo-delivery',
        recoverable: true
      },
      endTurn('turn-solo-delivery', 'failed')
    ]);
    expect(chatOf(await maintenance())).toBe(OTHER);
  });

  /**
   * The live 2026-08-31 trace, and the reason nothing had ever been observed to reload.
   *
   * A worker's page lost its answer stream and printed "Connection interrupted. Waiting for the
   * complete answer", while the model went on running server-side: fifteen connector calls in the
   * four minutes that followed, every one of them attributed. Attribution proves the request-id
   * join works. It says nothing whatever about the stream the page lost, which is the only thing
   * this repair is about - so a repair filed against the broken turn must survive it.
   *
   * It did not. The repair was queued, and twenty seconds later the next tool call deleted it,
   * long before the browser's own maintenance pass could collect it. A chat sick enough to need
   * reloading is usually a chat still calling tools, so the reload was erased every time.
   */
  it('keeps a broken turn’s reload alive while that turn goes on calling tools', async () => {
    await pair();
    await events(OTHER, [openTurn('turn-interrupted')]);
    await events(OTHER, [
      {
        kind: 'chat_error',
        time: Date.now(),
        text: 'Connection interrupted. Waiting for the complete answer',
        turnId: 'turn-interrupted',
        recoverable: true
      }
    ]);
    await attributed(OTHER);
    expect(chatOf(await maintenance())).toBe(OTHER);
  });

  it('isolates a late call from a handoff source without restoring that old chat', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      const from = 'efefefef-1111-2222-3333-444444444401';
      const to = 'efefefef-1111-2222-3333-444444444402';
      const requestId = 'wfr_historical_after_handoff';
      const opened = await events(from, [
        { kind: 'user_message', time: Date.now(), text: 'audit everything', messageId: 'm-historical-source' },
        openTurn('turn-historical-source'),
        {
          kind: 'tool_evidence',
          time: Date.now(),
          calls: [{ messageId: 'call-historical-source', tool: 'read', order: 0, answered: false, requestId }]
        }
      ]);
      const sessionId = opened.body.sessionId as string;
      const continuation = await openContinuationNow(sessionId, from);
      expect(await attachSummary(continuation.token, SAMPLE_BRIEF)).not.toBeNull();
      await claimContinuationNow(continuation.token, 'historical-recovery-test');
      expect(await commitContinuation(continuation.token, to)).toBe(true);

      // Exact request proof preserves which retired frontend called; it does not grant A new
      // execution/history authority after S moved to B. The refusal is isolated and cannot
      // push either A's recovery clock or B's current-context activity forward.
      const late = await recordToolCall({
        tool: 'read',
        args: { paths: ['/project/late.ts'] },
        content: [{ type: 'text', text: 'late but exact' }],
        outcome: 'ok',
        durationMs: 1,
        startedAt: Date.now() + 1,
        requestId
      });
      expect(late).toMatchObject({
        conversationId: from,
        attribution: 'superseded',
        attributionMethod: 'superseded'
      });
      expect(await getSession(sessionId)).toMatchObject({ conversationId: to, toolCalls: 0 });

      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS * 3);
      await sweepStaleSwarm(Date.now());
      expect(await maintenance()).toBeNull();
      expect(reopened(from)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * And the half that matters to the session: after the commit, B is the chat recovery is about.
   *
   * A repair names a conversation, and Compact & Resume changes which conversation the session
   * is. Every ledger this app keeps is keyed by chat id, so the question is not academic: if the
   * old id stayed the subject, a session would come out of a compaction with its reloads pointed
   * at a page nobody is looking at, and the chat actually doing the work would have no recovery
   * at all. The recorder drops A on rebind and the store moves `conversationId` to B, so the
   * suspect set can only ever contain B - and it contains B as soon as B says it is working,
   * with no repair, no grant and no spent budget inherited from A.
   */
  it('moves recovery onto the chat a compaction resumed into', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      const from = 'efefefef-1111-2222-3333-444444444411';
      const to = 'efefefef-1111-2222-3333-444444444412';
      const opened = await events(from, [
        { kind: 'user_message', time: Date.now(), text: 'keep going', messageId: 'm-resume-recovery' },
        openTurn('turn-resume-source')
      ]);
      const sessionId = opened.body.sessionId as string;

      // A is mid-turn and unattributed, so it is a suspect right up to the commit.
      await unattributed();
      const continuation = await openContinuationNow(sessionId, from);
      expect(await attachSummary(continuation.token, SAMPLE_BRIEF)).not.toBeNull();
      await claimContinuationNow(continuation.token, 'resume-recovery-test');
      expect(await commitContinuation(continuation.token, to)).toBe(true);

      // The deadline A was waiting on arrives, and there is nothing left to serve it to. A queued
      // repair is dropped for want of authority; A's activity grant goes with it.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await maintenanceBatch()).toEqual([]);

      // B says it is working, which is the first thing about B this app has ever been told.
      await events(to, [openTurn('turn-resume-target')]);
      await unattributed();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(chatOf(await maintenance())).toBe(to);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Nor may the broken turn's own last breath count against it.
   *
   * The live worker-2 trace: "Message delivery timed out" at 01:13:00, the turn it broke ending
   * failed at 01:13:04, and then nothing for six minutes while the model behind the dead stream
   * went on calling tools. The failure and the ending arrive in separate batches, so the turn is
   * still open when the repair is filed - and a repair retired by the next turn ending was
   * retired by the ending of the very turn it was filed about, four seconds later.
   *
   * A repair for a broken turn is spent when the chat gets through a turn, not when it finishes
   * dying.
   */
  it('keeps the reload alive when the turn it was filed about ends a moment later', async () => {
    await pair();
    await events(OTHER, [openTurn('turn-timed-out')]);
    await events(OTHER, [
      {
        kind: 'chat_error',
        time: Date.now(),
        text: 'Message delivery timed out. Please try again.',
        turnId: 'turn-timed-out',
        recoverable: true
      }
    ]);
    await events(OTHER, [endTurn('turn-timed-out', 'failed')]);
    await attributed(OTHER);
    expect(chatOf(await maintenance())).toBe(OTHER);
  });

  /**
   * The reload's budget is the turn running when it lands, and nothing when none is.
   *
   * The live prime trace, 2026-09-02: "Message delivery timed out" at 11:01:04, that turn
   * ending failed at 11:01:08, the reload landing at 11:01:18 — and the budget charged against
   * the chat's count as it stood then, which already included the failed turn. The next turn,
   * started fifteen minutes later, could therefore never be released from a charge it had
   * inherited: its own "Connection interrupted" at 11:40 was refused as already spent, and the
   * chat sat on a dead stream until a human reloaded it by hand.
   */
    const FRESH = 'fafafafa-1111-2222-3333-444444444444';
  it('gives the next turn its own reload when the failure it reloaded for had already ended', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(FRESH, [openTurn('turn-timed-out')]);
      await events(FRESH, [
        {
          kind: 'chat_error',
          time: Date.now(),
          text: 'Message delivery timed out. Please try again.',
          turnId: 'turn-timed-out',
          recoverable: true
        }
      ]);
      await events(FRESH, [endTurn('turn-timed-out', 'failed')]);
      const handout = await maintenance();
      expect(chatOf(handout)).toBe(FRESH);
      // The reload lands on a chat with no turn running: there is nothing to charge it to.
      expect(await maintenance(handout!.token)).toBeNull();

      await vi.advanceTimersByTimeAsync(BROWSER_RECOVERY_COOLDOWN_MS);
      await events(FRESH, [openTurn('turn-next')]);
      await events(FRESH, [
        {
          kind: 'chat_error',
          time: Date.now(),
          text: 'Connection interrupted. Waiting for the complete answer',
          turnId: 'turn-next',
          recoverable: true
        }
      ]);
      const next = await maintenance();
      expect(chatOf(next)).toBe(FRESH);
      expect(next?.reason).toBe('assistant-error');
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A turn that ended *failed* has not stopped the chat; it has stopped the page.
   *
   * The same live prime trace, after the refused reload: the turn ended failed at 11:43:10 and
   * that ending took the chat off the two-minute silence watch, exactly as a completed answer
   * would have. Nothing was left to ask, and the model behind the dead stream — which had
   * finished its answer, as the manual reload then showed — went unreloaded for twenty minutes.
   * A failure restarts the watch instead; a completed answer still spends it.
   */
  it('keeps a chat whose turn failed on the silence watch and reloads it two minutes later', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [openTurn('turn-dead')]);
      await events(OTHER, [endTurn('turn-dead', 'failed')]);
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      const handout = await maintenance();
      expect(chatOf(handout)).toBe(OTHER);
      expect(handout?.reason).toBe('silence');
      expect(await maintenance(handout!.token)).toBeNull();

      // A completed answer is the chat stopping, and the watch ends with it.
      await events(PRIME, [openTurn('turn-fine')]);
      await events(PRIME, [endTurn('turn-fine', 'completed')]);
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      expect(await maintenance()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The reload is the chat's chance, and the verdict on it waits the same two minutes.
   *
   * The live worker-2 trace, 2026-09-02: last tool call 11:35:07, silence reload 11:37:11,
   * slept as "no durable activity after one browser reload" at 11:37:38 — twenty-seven seconds
   * later, on the very next pass — and its finished answer arriving at 11:41:12. In between the
   * prime was told to wake it and typed a wake into a chat that was still generating.
   */
  it('gives a reloaded worker the full silence window again before it is put to sleep', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'write a long answer' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId: WORKER, agent: 'worker-1' }
      });
      await events(WORKER, [openTurn('turn-long-answer')]);
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      const handout = await maintenance();
      expect(chatOf(handout)).toBe(WORKER);
      expect(handout?.reason).toBe('silence');
      expect(await maintenance(handout!.token)).toBeNull();

      // The pass right after the reload: the model may still be writing. Still a worker.
      await sweepStaleSwarm(Date.now());
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');

      // Two more minutes with nothing durable is the chat having had its chance.
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      const worker = swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1');
      expect(worker?.state).toBe('sleeping');
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * …and a repair that can never retire may not take the chat's silence watch down with it.
   *
   * The live prime trace: "Connection interrupted" at 21:40, the turn it broke ending failed at
   * 21:45, eleven further minutes of attributed calls from the model behind the dead stream,
   * and then nothing at all. The repair filed for that turn was still on file — the turn's own
   * ending is the last one that chat ever had, so no later ending could retire it — and the
   * two-minute watch read the entry as a recovery already in progress. Nothing was in progress.
   * The chat sat dead for eighteen minutes until a human reloaded it by hand.
   *
   * Silence asks whether the conversation is alive at all, which no fact about one of its turns
   * can answer, so it supersedes the entry rather than obeying it — including the browser floor
   * that entry is waiting behind, which silence has never been subject to.
   */
  /**
   * The one chat this app may never reload, however broken it looks.
   *
   * A block is the user taking the app's hands off a conversation, and a recovery is a hand
   * going back on: the two-minute silence watch is a reload, and no-tab is a whole new tab for a
   * chat whose every tool call is already being refused. Live, that is what put a rogue turn's
   * page back on screen minutes after it was blocked.
   *
   * The silence itself is still spent, not merely skipped, because a chat waiting for a reload
   * that is never coming would otherwise stay measured-silent in the ledger for good.
   */
  it('never reloads or reopens a chat the user blocked, however long it stays silent', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [openTurn('turn-blocked')]);
      setChatBlocked(OTHER, true);

      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      expect(await maintenance()).toBeNull();
      expect(reopened(OTHER)).toEqual([]);

      // And it stays that way: silence cannot re-arm what it already spent on abandoning.
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS * 5);
      await sweepStaleSwarm(Date.now());
      expect(await maintenance()).toBeNull();
      expect(reopened(OTHER)).toEqual([]);
    } finally {
      resetBlockedChatsForTests();
      vi.useRealTimers();
    }
  });

  /**
   * The queue outlives the decision that filled it, so the block has to be read at handout too:
   * a repair filed a minute before the user pressed Block would otherwise still be carried out.
   */
  it('drops a queued repair for a chat blocked after it was filed', async () => {
    await pair();
    await events(OTHER, [openTurn('turn-queued-then-blocked')]);
    await events(OTHER, [
      {
        kind: 'chat_error',
        time: Date.now(),
        text: 'Message delivery timed out. Please try again.',
        turnId: 'turn-queued-then-blocked',
        recoverable: true
      }
    ]);
    setChatBlocked(OTHER, true);
    try {
      expect(await maintenance()).toBeNull();
      expect(reopened(OTHER)).toEqual([]);
    } finally {
      resetBlockedChatsForTests();
    }
  });

  /**
   * A reload the page has not come back from yet is not answered with another. The 300k-token
   * prime of 2026-09-03 took three minutes to load, and silence reloaded it 23 seconds after an
   * unattributed reload had — every reload starting the three minutes over. The page gets the
   * recovery floor to come back; only a page that never does is reloaded when it runs out.
   */
  it('gives a freshly reloaded chat the recovery floor to come back before silence reloads it again', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [openTurn('turn-heavy')]);
      await events(OTHER, [
        {
          kind: 'chat_error',
          time: Date.now(),
          text: 'Connection interrupted. Waiting for the complete answer',
          turnId: 'turn-heavy',
          recoverable: true
        }
      ]);
      const first = await maintenance();
      expect(chatOf(first)).toBe(OTHER);
      expect(first?.reason).toBe('assistant-error');
      expect(await maintenance(first!.token, 'reloaded')).toBeNull();

      // Two minutes of nothing: the page is still loading. Silence does not pile on.
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      expect(await maintenance()).toBeNull();

      // The floor runs out with the page still gone: now silence's own reload, once.
      await vi.advanceTimersByTimeAsync(BROWSER_RECOVERY_COOLDOWN_MS - CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      const rescue = await maintenance();
      expect(chatOf(rescue)).toBe(OTHER);
      expect(rescue?.reason).toBe('silence');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reloads a silent chat over a turn repair that can no longer retire', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      // An earlier transport failure, repaired and then retired by a turn the chat got through.
      // That spends this chat's browser action and starts its three-minute floor.
      await events(OTHER, [openTurn('turn-first')]);
      await events(OTHER, [
        {
          kind: 'chat_error',
          time: Date.now(),
          text: 'Connection interrupted. Waiting for the complete answer',
          turnId: 'turn-first',
          recoverable: true
        }
      ]);
      const first = await maintenance();
      expect(chatOf(first)).toBe(OTHER);
      expect(await maintenance(first!.token, 'reloaded')).toBeNull();
      await events(OTHER, [endTurn('turn-first', 'failed')]);
      await events(OTHER, [openTurn('turn-through'), endTurn('turn-through', 'completed')]);
      expect(await maintenance()).toBeNull();

      await events(OTHER, [openTurn('turn-broken')]);
      await events(OTHER, [
        {
          kind: 'chat_error',
          time: Date.now(),
          text: 'Message delivery timed out. Please try again.',
          turnId: 'turn-broken',
          recoverable: true
        }
      ]);
      await events(OTHER, [endTurn('turn-broken', 'failed')]);
      // Filed against the turn that just died, so nothing will ever retire it, and still behind
      // the floor the reopen started. The model goes on calling tools through the dead stream.
      await attributed(OTHER);
      expect(await maintenance()).toBeNull();

      // Now the chat stops for good. It is owed its one reload whatever else is on file.
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      const rescue = await maintenance();
      expect(chatOf(rescue)).toBe(OTHER);
      expect(rescue?.reason).toBe('silence');
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Nor may the wait itself be the window in which it is forgotten.
   *
   * The exact live shape: a tab closed and reopened spends this chat's browser action, so the
   * transport failure a minute later is held behind the three-minute floor. Every tool call
   * during that wait used to erase it, which made a held repair one that could never be handed
   * out at all.
   */
  it('hands the repair out after the cooldown, however busy the chat was while it waited', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'audit' }], caller: { conversationId: PRIME } });
      const bootstrap = await redeem();
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId: WORKER, agent: 'worker-1' }
      });
      await events(WORKER, [openTurn('turn-worker-closed')]);
      await request('POST', '/closed', { body: { conversationId: WORKER } });
      const reopen = await maintenance();
      expect(chatOf(reopen)).toBe(WORKER);
      // Carried out. That spends the chat's action and starts its three-minute floor.
      expect(await maintenance(reopen!.token)).toBeNull();

      await vi.advanceTimersByTimeAsync(90_000);
      await events(WORKER, [openTurn('turn-worker-interrupted')]);
      await events(WORKER, [
        {
          kind: 'chat_error',
          time: Date.now(),
          text: 'Connection interrupted. Waiting for the complete answer',
          turnId: 'turn-worker-interrupted',
          recoverable: true
        }
      ]);
      // Still inside the floor, and the chat keeps working the whole way through it.
      for (let call = 0; call < 6; call++) {
        await vi.advanceTimersByTimeAsync(15_000);
        await attributed(WORKER);
        }
      expect(chatOf(await maintenance())).toBe(WORKER);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The turn opening is the whole arming condition.
   *
   * A turn that goes quiet the instant it opens — no interim text, no tool call, nothing the
   * request-id join could carry — is the exact stall this watch exists for, and it was the one
   * stall that never armed it: the ledger used to wait for an interim update or an attributed
   * call before it would start counting.
   */
  it('watches an open turn that produces no interim update or tool call at all', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [openTurn('turn-silent-from-the-start')]);

      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 1);
      await sweepStaleSwarm(Date.now());
      expect(await maintenance()).toBeNull();

      await vi.advanceTimersByTimeAsync(1);
      await sweepStaleSwarm(Date.now());
      expect(chatOf(await maintenance())).toBe(OTHER);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The reload has to land on the boundary, not at the next maintenance tick.
   *
   * Every other test in this block calls the sweep by hand, so none of them could see the delay
   * a user actually gets: the ledger expired at 2:00 and nothing looked at it until the 30-second
   * interval came round, with the extension's own 30-second alarm still to follow. A prime whose
   * tab was closed mid-turn was measured being reopened 2:40 after its last tool call. Advancing
   * the clock and touching nothing is the only way to pin the half this process owns.
   */
  it('queues the silence reload on the deadline without waiting for the maintenance tick', async () => {
    vi.useFakeTimers();
    try {
      // Its own chat: a conversation another test already had repaired would still be holding
      // that spent handout, and this is about arming a fresh episode on time.
      const PUNCTUAL = 'a1a1a1a1-1111-2222-3333-444444444444';
      await pair();
      await events(PUNCTUAL, [openTurn('turn-silent-punctual')]);

      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 1);
      expect(await maintenance()).toBeNull();

      // No sweepStaleSwarm() call: the deadline itself must be what wakes the app.
      await vi.advanceTimersByTimeAsync(2);
      expect(chatOf(await maintenance())).toBe(PUNCTUAL);
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes a newly started session recoverable for the full two-minute opening window', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [{
        kind: 'user_message',
        time: Date.now(),
        messageId: 'opening-user-message',
        authoredNow: true,
        text: 'start working'
      }]);

      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 1);
      await sweepStaleSwarm(Date.now());
      expect(await maintenance()).toBeNull();

      await vi.advanceTimersByTimeAsync(1);
      await sweepStaleSwarm(Date.now());
      expect(chatOf(await maintenance())).toBe(OTHER);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The live 17:41-17:54 loop: a completed chat was reloaded, its replacement document sent a
   * title plus the same historical user row, and the coarse `stored > 0` batch test treated that
   * old row as a new opening. Every reload therefore armed the next one two/three minutes later.
   * Recorder acceptance is now the boundary, and a history row never carries authoredNow.
   */
  it('does not re-arm a completed chat when reload replays its title and historical user row', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [
        {
          kind: 'user_message',
          time: Date.now(),
          messageId: 'package-opening-message',
          authoredNow: true,
          text: 'read package.json'
        },
        openTurn('turn-package')
      ]);
      await events(OTHER, [
        { kind: 'turn_end', time: Date.now(), turnId: 'turn-package', outcome: 'completed' }
      ]);

      // The replacement page changes the canonical row's local turn stamp, so the recorder
      // really does accept a write; the title is accepted too. Neither fact means the user sent
      // anything after the completed answer.
      await events(OTHER, [
        { kind: 'conversation_title', time: Date.now(), text: 'Read package name' },
        {
          kind: 'user_message',
          time: Date.now(),
          messageId: 'package-opening-message',
          turnId: 'historical-page-turn',
          text: 'read package.json'
        }
      ]);

      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS * 2);
      await sweepStaleSwarm(Date.now());
      expect(await maintenance()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('spends a confirmed reload even when its replacement page immediately rewrites historical transcript', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [
        {
          kind: 'user_message',
          time: Date.now(),
          messageId: 'android-opening-message',
          authoredNow: true,
          text: 'read the Android codebase'
        },
        openTurn('turn-android-stale')
      ]);

      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      const reload = await maintenance();
      expect(chatOf(reload)).toBe(OTHER);
      expect(await maintenance(reload!.token)).toBeNull();

      // This lands in the narrow interval after Chrome confirmed the reload but before the next
      // maintenance sweep spends the expired grant. The historical row is a real canonical
      // rewrite (new local turn stamp), but it is still not new model activity.
      await events(OTHER, [
        { kind: 'conversation_title', time: Date.now(), text: 'Read Android Codebase' },
        {
          kind: 'user_message',
          time: Date.now(),
          messageId: 'android-opening-message',
          turnId: 'replacement-document-history',
          text: 'read the Android codebase'
        }
      ]);
      await sweepStaleSwarm(Date.now());
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS * 2);
      await sweepStaleSwarm(Date.now());
      expect(await maintenance()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Browser lifetime is not evidence about the turn, on this clock either.
   *
   * The page detaching says nothing about whether the model is still working, so it may neither
   * spend the deadline nor — through the recorder's live map, which the detach empties — make
   * the chat ineligible for the recovery the deadline is about to ask for.
   */
  it('keeps watching an open turn whose page detached before the window ran out', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [openTurn('turn-silent-across-detach')]);
      await request('POST', '/closed', { body: { conversationId: OTHER } });

      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      expect(chatOf(await maintenance())).toBe(OTHER);
    } finally {
      vi.useRealTimers();
    }
  });

  /** A real terminal spends the deadline; an `unknown` end is not one. */
  it('stops watching on a real turn end but not on an uncertain one', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [openTurn('turn-ends-uncertain')]);
      await events(OTHER, [
        { kind: 'turn_end', time: Date.now(), turnId: 'turn-ends-uncertain', outcome: 'unknown' }
      ]);
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      const reload = await maintenance();
      expect(chatOf(reload)).toBe(OTHER);
      expect(await maintenance(reload!.token)).toBeNull();

      await events(PRIME, [openTurn('turn-ends-for-real')]);
      await events(PRIME, [
        { kind: 'turn_end', time: Date.now(), turnId: 'turn-ends-for-real', outcome: 'completed' }
      ]);
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS * 2);
      await sweepStaleSwarm(Date.now());
      expect(await maintenance()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Prime's own open turn is on the same silence clock as anybody else's.
   *
   * Prime is the chat a run is steered from, so it is the one whose stall nothing else is
   * watching: no worker slot depends on it and no bootstrap is waiting on it.
   */
  it('reloads Prime once when its own open turn goes two minutes silent', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'hold the run open' }], caller: { conversationId: PRIME } });
      await events(PRIME, [openTurn('turn-prime-silent')]);
      await attributed(PRIME);

      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 1);
      await sweepStaleSwarm(Date.now());
      expect(await maintenance()).toBeNull();

      await vi.advanceTimersByTimeAsync(1);
      await sweepStaleSwarm(Date.now());
      expect(chatOf(await maintenance())).toBe(PRIME);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The user's standing instruction outranks the switch. A chat the Loop is driving is brought
   * back after silence with tab recovery off, while a plain chat is left where it fell. On
   * 2026-09-02 a closed Loop prime waited for a reopen that nothing was allowed to give it.
   */
  it('always brings a Goal/Loop chat back after silence, tab recovery switch or not', async () => {
    const previous = getConfig();
    await saveConfig({
      ...previous,
      multiAgent: { ...previous.multiAgent, recoverAgentTabs: false },
      goal: { ...previous.goal, enabled: true, mode: 'loop' }
    });
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [openTurn('turn-loop-silent')]);
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      expect(await maintenance()).toMatchObject({ conversationId: OTHER, reason: 'silence' });
    } finally {
      await saveConfig(previous);
      vi.useRealTimers();
    }
  });

  /**
   * The prime stops writing with no final answer. Two minutes of silence earn the reload; the
   * fresh page shows the same dead turn; one more minute of nothing — no tool call, no page
   * change — and the loop treats it as it treats a finished answer: the chat is owed the next
   * user message, filed as the same durable obligation a finished answer files, under a turn
   * of its own. On 2026-09-02 that chat would otherwise have sat on its dead turn for good,
   * because a turn that never ends is a turn Goal never answers.
   */
  it('files a Goal ticket for a Goal/Loop chat that stays silent for a minute after its reload', async () => {
    const previous = getConfig();
    await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true, mode: 'loop' } });
    await setSecret('openRouterApiKey', 'sk-or-silence');
    resetGoalStateForTests();
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [openTurn('turn-loop-dead')]);
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      const handout = await maintenance();
      expect(handout).toMatchObject({ conversationId: OTHER, reason: 'silence' });
      expect(await maintenance(handout!.token)).toBeNull();
      expect(goalPendingReplyFor(OTHER)).toBeNull();

      // Half a minute in, nothing yet: the page is still being listened to.
      await vi.advanceTimersByTimeAsync(30_000);
      await sweepStaleSwarm(Date.now());
      expect(goalPendingReplyFor(OTHER)).toBeNull();

      await vi.advanceTimersByTimeAsync(30_000);
      await sweepStaleSwarm(Date.now());
      expect(goalPendingReplyFor(OTHER)?.turnId).toMatch(/^g-silence-/);
    } finally {
      resetGoalStateForTests();
      await setSecret('openRouterApiKey', '');
      await saveConfig(previous);
      vi.useRealTimers();
    }
  });

  it('files no Goal ticket when the reloaded Goal chat shows signs of life within the minute', async () => {
    const previous = getConfig();
    await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true, mode: 'loop' } });
    await setSecret('openRouterApiKey', 'sk-or-silence');
    resetGoalStateForTests();
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [openTurn('turn-loop-slow')]);
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      const handout = await maintenance();
      expect(handout).toMatchObject({ conversationId: OTHER, reason: 'silence' });
      expect(await maintenance(handout!.token)).toBeNull();

      // A tool call flutters in twenty seconds after the reload: the chat is working.
      await vi.advanceTimersByTimeAsync(20_000);
      await attributed(OTHER);
      await vi.advanceTimersByTimeAsync(50_000);
      await sweepStaleSwarm(Date.now());
      expect(goalPendingReplyFor(OTHER)).toBeNull();
    } finally {
      resetGoalStateForTests();
      await setSecret('openRouterApiKey', '');
      await saveConfig(previous);
      vi.useRealTimers();
    }
  });

  /**
   * The other two signs of life, so the listen window is proven against every kind of signal a
   * working chat gives off: an interim assistant row the fresh page reports, and a message the
   * user typed. Each pushes the chat back onto its two-minute clock, so a chat that stops
   * again later gets the same reload and the same minute again — the loop carries on.
   */
  for (const [what, sign] of [
    ['an interim assistant message', (turnId: string) => [{ kind: 'assistant_message', time: Date.now(), turnId, text: 'still on it', renderedHtml: '<p>still on it</p>', messageId: 'a-interim', state: 'streaming', activeNow: true }]],
    ['a user message', () => [{ kind: 'user_message', time: Date.now(), text: 'carry on', messageId: 'u-alive', authoredNow: true }]]
  ] as const) {
    it(`files no Goal ticket when ${what} arrives within the minute, and re-arms the silence clock`, async () => {
      const previous = getConfig();
      await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true, mode: 'loop' } });
      await setSecret('openRouterApiKey', 'sk-or-silence');
      resetGoalStateForTests();
      vi.useFakeTimers();
      try {
        await pair();
        const turnId = `turn-loop-${what.length}`;
        await events(OTHER, [openTurn(turnId)]);
        await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
        await sweepStaleSwarm(Date.now());
        const handout = await maintenance();
        expect(handout).toMatchObject({ conversationId: OTHER, reason: 'silence' });
        expect(await maintenance(handout!.token)).toBeNull();

        await vi.advanceTimersByTimeAsync(20_000);
        await events(OTHER, sign(turnId));
        await vi.advanceTimersByTimeAsync(50_000);
        await sweepStaleSwarm(Date.now());
        expect(goalPendingReplyFor(OTHER)).toBeNull();

        // Quiet again for the full two minutes: the same reload, the same minute, then the ticket.
        await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
        await sweepStaleSwarm(Date.now());
        const again = await maintenance();
        expect(again).toMatchObject({ conversationId: OTHER, reason: 'silence' });
        expect(await maintenance(again!.token)).toBeNull();
        await vi.advanceTimersByTimeAsync(GOAL_SILENCE_LISTEN_MS);
        await sweepStaleSwarm(Date.now());
        expect(goalPendingReplyFor(OTHER)?.turnId).toMatch(/^g-silence-/);
      } finally {
        resetGoalStateForTests();
        await setSecret('openRouterApiKey', '');
        await saveConfig(previous);
        vi.useRealTimers();
      }
    });
  }

  /**
   * The page's word that a turn ended is not enough to write on. A reloaded page reads the
   * transcript's last end_turn bit as a finished answer while the same request is still calling
   * tools, and "Message delivery timed out" closes the local turn the same way; on 2026-09-03
   * the loop drafted twenty seconds after such an end and the chat had two requests running in
   * it. A chat whose tools ran within the last minute is working, and the draft waits — filed,
   * so no page loses it — until the chat has been quiet for the minute.
   */
  it('refuses to draft for a chat whose tools ran within the last minute, then drafts once it is quiet', async () => {
    const previous = getConfig();
    await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true, mode: 'loop' } });
    await setSecret('openRouterApiKey', 'sk-or-quiet');
    resetGoalStateForTests();
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [openTurn('turn-false-end')]);
      await attributed(OTHER, false, Date.now());
      await vi.advanceTimersByTimeAsync(28_000);
      await events(OTHER, [endTurn('turn-false-end', 'completed')]);

      const early = await request('POST', '/goal/draft', {
        body: { conversationId: OTHER, turnId: 'turn-false-end', clientId: 'tab-1' }
      });
      expect(early.status).toBe(409);
      expect(early.body).toMatchObject({ error: 'chat_still_working', retryable: true });
      expect(goalPendingReplyFor(OTHER)?.turnId).toBe('turn-false-end');
      expect(goalDraftBusy(OTHER)).toBe(false);

      await vi.advanceTimersByTimeAsync(GOAL_QUIET_MS);
      const quiet = await request('POST', '/goal/draft', {
        body: { conversationId: OTHER, turnId: 'turn-false-end', clientId: 'tab-1' }
      });
      expect(quiet.status).toBe(200);
    } finally {
      resetGoalStateForTests();
      await setSecret('openRouterApiKey', '');
      await saveConfig(previous);
      vi.useRealTimers();
    }
  });

  /**
   * The record's own turn is the first thing the draft waits on. On 2026-09-03 the prime's turn
   * had been reopened by its own tool calls and never ended again — the "Message delivery timed
   * out" banner produced no turn end — yet the page asked twenty seconds later and was drafted.
   * Quiet tools alone are not enough while the app still has the turn open.
   */
  it('refuses to draft while the app still has the turn open, however quiet the tools are', async () => {
    const previous = getConfig();
    await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true, mode: 'loop' } });
    await setSecret('openRouterApiKey', 'sk-or-open');
    resetGoalStateForTests();
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [openTurn('turn-still-open')]);
      await attributed(OTHER, false, Date.now());
      await vi.advanceTimersByTimeAsync(GOAL_QUIET_MS + 5_000);

      const open = await request('POST', '/goal/draft', {
        body: { conversationId: OTHER, turnId: 'turn-still-open', clientId: 'tab-1' }
      });
      expect(open.status).toBe(409);
      expect(open.body).toMatchObject({ error: 'chat_still_working', retryable: true });
      expect(goalPendingReplyFor(OTHER)?.turnId).toBe('turn-still-open');

      await events(OTHER, [endTurn('turn-still-open', 'completed')]);
      const ended = await request('POST', '/goal/draft', {
        body: { conversationId: OTHER, turnId: 'turn-still-open', clientId: 'tab-1' }
      });
      expect(ended.status).toBe(200);
    } finally {
      resetGoalStateForTests();
      await setSecret('openRouterApiKey', '');
      await saveConfig(previous);
      vi.useRealTimers();
    }
  });

  /**
   * The silence ticket is the route a chat whose page lost its answer takes to the next message,
   * and its turn is exactly the one nobody is left to close: the reload, the minute of nothing,
   * and the ticket are the app's own finding that the answer is over. That draft is not held
   * behind the open turn.
   */
  it('drafts the silence ticket although the lost turn is still open in the record', async () => {
    const previous = getConfig();
    await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true, mode: 'loop' } });
    await setSecret('openRouterApiKey', 'sk-or-silent-open');
    resetGoalStateForTests();
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [openTurn('turn-lost')]);
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      const handout = await maintenance();
      expect(handout).toMatchObject({ conversationId: OTHER, reason: 'silence' });
      expect(await maintenance(handout!.token)).toBeNull();
      await vi.advanceTimersByTimeAsync(GOAL_SILENCE_LISTEN_MS);
      await sweepStaleSwarm(Date.now());
      const ticket = goalPendingReplyFor(OTHER);
      expect(ticket?.turnId).toMatch(/^g-silence-/);

      const drafted = await request('POST', '/goal/draft', {
        body: { conversationId: OTHER, turnId: ticket!.turnId, clientId: 'tab-1', terminalRequired: true }
      });
      expect(`${drafted.status} ${JSON.stringify(drafted.body)}`).toMatch(/^200 /);
    } finally {
      resetGoalStateForTests();
      await setSecret('openRouterApiKey', '');
      await saveConfig(previous);
      vi.useRealTimers();
    }
  });

  it('leaves a silent plain chat where it fell when tab recovery is off', async () => {
    const previous = getConfig();
    await saveConfig({
      ...previous,
      multiAgent: { ...previous.multiAgent, recoverAgentTabs: false },
      goal: { ...previous.goal, enabled: false }
    });
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [openTurn('turn-plain-silent')]);
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      expect(await maintenance()).toBeNull();
    } finally {
      await saveConfig(previous);
      vi.useRealTimers();
    }
  });

  it('can disable missing-tab and inactivity recovery without changing agent lifecycle', async () => {
    const previous = getConfig();
    expect(previous.multiAgent.recoverAgentTabs).toBe(true);
    await saveConfig({
      ...previous,
      multiAgent: { ...previous.multiAgent, recoverAgentTabs: false }
    });
    try {
      await pair();
      spawn({ workers: [{ task: 'audit' }], caller: { conversationId: PRIME } });
      const bootstrap = await redeem();
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId: WORKER, agent: 'worker-1' }
      });
      await events(WORKER, [openTurn('turn-worker-recovery-disabled')]);
      await request('POST', '/closed', { body: { conversationId: WORKER } });
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('detached');
      expect(await maintenance()).toBeNull();
    } finally {
      const latest = getConfig();
      await saveConfig({
        ...latest,
        multiAgent: { ...latest.multiAgent, recoverAgentTabs: true }
      });
      expect(getConfig().multiAgent.recoverAgentTabs).toBe(true);
    }
  });

  /**
   * The other half of "an ordinary chat is recovered exactly like Prime".
   *
   * The silence deadline already reopened this chat, but only two minutes after its last sign
   * of life. A closed tab is first-hand proof that the page is gone now, and the user watching
   * a Worker come straight back while their own chat sat there dead is the whole bug.
   */
  it('reopens an ordinary chat that uses this connector the moment its last tab closes mid-turn', async () => {
    const SOLO = 'b2b2b2b2-1111-2222-3333-444444444444';
    await pair();
    await events(SOLO, [openTurn('turn-solo-closed')]);
    // One proved call is what makes this chat the app's business at all.
    await attributed(SOLO);

    await request('POST', '/closed', { body: { conversationId: SOLO } });

    // Nothing is waited out: the close itself is the evidence.
    expect(chatOf(await maintenance())).toBe(SOLO);
  });

  /**
   * And the fence on it. A chat that has never called a tool is somebody reading a recipe with
   * this app installed; its tab is not this app's to put back, and reopening it would be the
   * connector helping itself to a window nobody asked it to keep. Its open turn stays on the
   * ordinary silence clock like any other — this is about the close, not about the turn.
   */
  it('leaves a chat that has never called a tool closed when its tab goes', async () => {
    const BROWSING = 'b3b3b3b3-1111-2222-3333-444444444444';
    await pair();
    await events(BROWSING, [openTurn('turn-browsing')]);

    await request('POST', '/closed', { body: { conversationId: BROWSING } });

    expect(await maintenance()).toBeNull();
  });

  it('gives an ordinary solo chat the same one-shot stale-turn reload as Prime', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [openTurn('turn-solo-silent')]);
      await attributed(OTHER);

      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      const reload = await maintenance();
      expect(chatOf(reload)).toBe(OTHER);

      // A receipt proves Chrome carried the reload out. With no new durable observation, the
      // next sweep abandons this open turn instead of reloading it again forever.
      expect(await maintenance(reload!.token)).toBeNull();
      // The reload is the chat's chance; the verdict on it waits the same two minutes the silence did.
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS * 2);
      await sweepStaleSwarm(Date.now());
      expect(await maintenance()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens an exact chat after calls continue while its Chrome tab is gone', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [openTurn('turn-closed-while-tools-run')]);
      await request('POST', '/closed', { body: { conversationId: OTHER } });

      // The model keeps running server-side after Chrome has gone. Exact attribution is the
      // activity authority; absence of a browser-local activeTurnId must not discard it.
      await attributed(OTHER);
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      expect(chatOf(await maintenance())).toBe(OTHER);
    } finally {
      vi.useRealTimers();
    }
  });

  it('spends recovery immediately when an attributed worker finish report is recorded', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [openTurn('turn-explicit-finish')]);
      await attributed(OTHER);
      await attributed(OTHER, true);

      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS * 2);
      await sweepStaleSwarm(Date.now());
      expect(await maintenance()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms the same chat only after real post-reload activity starts a new episode', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [openTurn('turn-reload-episode-one')]);
      await attributed(OTHER);

      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      const first = await maintenance();
      expect(chatOf(first)).toBe(OTHER);
      expect(await maintenance(first!.token)).toBeNull();
      await sweepStaleSwarm(Date.now());

      // A confirmed reload alone is spent. A new exact call is the sole fact that starts episode 2.
      await attributed(OTHER);
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 1);
      await sweepStaleSwarm(Date.now());
      expect(await maintenance()).toBeNull();

      await vi.advanceTimersByTimeAsync(1);
      await sweepStaleSwarm(Date.now());
      expect(chatOf(await maintenance())).toBe(OTHER);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a real interim assistant update after reload as a new active episode', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [openTurn('turn-reload-interim-one')]);
      await attributed(OTHER);
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      const first = await maintenance();
      expect(chatOf(first)).toBe(OTHER);
      expect(await maintenance(first!.token)).toBeNull();
      await sweepStaleSwarm(Date.now());

      await events(OTHER, [{
        kind: 'assistant_message',
        time: Date.now(),
        messageId: 'assistant-after-reload',
        text: 'Continuing after reload',
        state: 'streaming',
        final: false,
        activeNow: true
      }]);
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      expect(chatOf(await maintenance())).toBe(OTHER);
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves the stale deadline on real assistant progress and removes it on a stable final answer', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [openTurn('turn-solo-progress')]);
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 1);
      await events(OTHER, [{
        kind: 'assistant_message',
        time: Date.now(),
        messageId: 'assistant-solo-progress',
        turnId: 'turn-solo-progress',
        text: 'Still working through it',
        state: 'streaming',
        final: false,
        activeNow: true
      }]);

      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 1);
      await sweepStaleSwarm(Date.now());
      expect(await maintenance()).toBeNull();

      await events(OTHER, [{
        kind: 'assistant_message',
        time: Date.now(),
        messageId: 'assistant-solo-final',
        turnId: 'turn-solo-progress',
        text: 'Finished.',
        state: 'final',
        final: true,
        activeNow: true
      }]);
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS * 2);
      await sweepStaleSwarm(Date.now());
      expect(await maintenance()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A tool call is attributed after the final answer it belongs to is already stored.
   *
   * The recorder can spend up to REQUEST_ID_GRACE_MS proving one request id, so the page's
   * stable assistant message can reach this app before the call inside that answer is filed.
   * The call's own start time must remain before that final boundary, regardless of recorder
   * latency, or a completed answer gets reopened two minutes after the user already had it.
   */
  it('never reloads a chat whose stable final arrived before its last call was attributed', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [openTurn('turn-solo-late-join')]);
      const finalAt = Date.now();
      await events(OTHER, [{
        kind: 'assistant_message',
        time: finalAt,
        messageId: 'assistant-solo-late-final',
        turnId: 'turn-solo-late-join',
        text: 'Complete.',
        state: 'final',
        final: true
      }]);
      await attributed(OTHER, false, finalAt);

      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS * 2);
      await sweepStaleSwarm(Date.now());
      expect(await maintenance()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The reported Prime trace: the page detached mid-generation and durably ended the local
   * lifecycle as unknown. The model kept making calls whose exact request ids still proved this
   * chat. Those calls are first-hand activity, not a late join to a completed answer, so their
   * final two-minute silence must still recover the page once.
   */
  it('reloads a chat that keeps making attributed calls after its local turn ended unknown', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [openTurn('turn-lost-on-reload')]);
      await events(OTHER, [endTurn('turn-lost-on-reload', 'unknown')]);
      await attributed(OTHER);

      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      expect(chatOf(await maintenance())).toBe(OTHER);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reload an uncertain chat after its stable final answer arrives', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      await events(OTHER, [openTurn('turn-final-after-reload')]);
      await events(OTHER, [endTurn('turn-final-after-reload', 'unknown')]);
      await attributed(OTHER);
      const finalAt = Date.now();
      await events(OTHER, [{
        kind: 'assistant_message',
        time: finalAt,
        messageId: 'assistant-final-after-reload',
        text: 'The complete answer is here.',
        state: 'final',
        final: true
      }]);
      // Correlation may settle after the page final, just as it can after a normal turn_end.
      // That late exact call must not resurrect a completed answer's reload clock.
      await attributed(OTHER, false, finalAt);

      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS * 2);
      await sweepStaleSwarm(Date.now());
      expect(await maintenance()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * An unrelated unattributed incident used to cancel a confirmed stale-turn recovery.
   *
   * `repairCandidates()` pruned the activity ledger on its own clock, two minutes behind the
   * deadline it prunes. A silence recovery that Chrome had already carried out could therefore
   * lose the grant that says which chats to spend, and the verdict on that reload was never
   * reached: the Worker slot stayed occupied by a chat this app had already given up on, and
   * the repair sat in flight forever. The open turn, not a second clock, decides this now.
   */
  it('still spends a confirmed stale-turn reload after an unrelated unattributed incident', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'audit' }], caller: { conversationId: PRIME } });
      const bootstrap = await redeem();
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId: WORKER, agent: 'worker-1' }
      });
      await events(WORKER, [openTurn('turn-worker-pruned')]);
      await attributed(WORKER);

      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      const reload = await maintenance();
      expect(chatOf(reload)).toBe(WORKER);
      expect(await maintenance(reload!.token)).toBeNull();

      // The incident's own minute lands well past the silence deadline, which is exactly when
      // the old ledger prune fired. The reload above is still the outstanding verdict.
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await unattributed();
      await vi.advanceTimersByTimeAsync(60_000);

      await sweepStaleSwarm(Date.now());
      expect(swarmStateForCaller({ conversationId: PRIME }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
        state: 'sleeping',
        revivable: true
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reloads a silent joined turn once, then sleeps the Worker only if it stays dead', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'audit' }], caller: { conversationId: PRIME } });
      const bootstrap = await redeem();
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId: WORKER, agent: 'worker-1' }
      });
      await events(WORKER, [openTurn('turn-worker-silent')]);
      await attributed(WORKER);
      expect(getConfig().multiAgent.recoverAgentTabs).toBe(true);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
      expect(liveConversations().find((entry) => entry.conversationId === WORKER)).toMatchObject({ generating: true });

      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 1);
      expect(await maintenance()).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await sweepStaleSwarm(Date.now());
      const reload = await maintenance();
      expect(chatOf(reload)).toBe(WORKER);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');

      expect(await maintenance(reload!.token)).toBeNull();
      // The reload is the chat's chance; the verdict on it waits the same two minutes the silence did.
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      expect(swarmStateForCaller({ conversationId: PRIME }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
        state: 'sleeping',
        revivable: true
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('finishes a worker that outlived its activity grant and already crossed the context ceiling', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'audit at the ceiling' }], caller: { conversationId: PRIME } });
      const bootstrap = await redeem();
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId: WORKER, agent: 'worker-1' }
      });
      await events(WORKER, [openTurn('turn-worker-ceiling')]);
      await attributed(WORKER);
      noteAgentContextTokens(WORKER, WORKER_CONTEXT_CEILING_TOKENS);

      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      const reload = await maintenance();
      expect(chatOf(reload)).toBe(WORKER);
      expect(await maintenance(reload!.token)).toBeNull();
      // The reload is the chat's chance; the verdict on it waits the same two minutes the silence did.
      await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
      await sweepStaleSwarm(Date.now());
      expect(swarmStateForCaller({ conversationId: PRIME }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
        state: 'finished',
        revivable: false
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never picks a worker that is over, and repairs the chat that is still generating', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'audit' }], caller: { conversationId: PRIME } });
      await events(PRIME, [openTurn('turn-live')]);
      const bootstrap = await redeem();
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId: WORKER, agent: 'worker-1' }
      });
      // The worker was the most recently seen chat by a distance, and it is also over.
      await events(WORKER, [openTurn('turn-worker'), endTurn('turn-worker', 'completed')]);
      finishAgent({ conversationId: WORKER }, 'audit done');
      await unattributed();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(reopened(WORKER)).toEqual([]);
      expect(chatOf(await maintenance())).toBe(PRIME);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ------------------------------------------------------------- restarting

/**
 * Switching multi-agent mode or recording off and on again restarts this module, and the
 * listener it registers on the swarm has to come off when it does. It did not: every
 * restart added another, so a run ending afterwards was handled once per start the app had
 * ever done — including by handlers belonging to a bridge that no longer exists.
 */
describe('restarting the bridge', () => {
  it('coalesces concurrent starts into one listener', async () => {
    await stopBridge();
    const [first, second] = await Promise.all([startBridge(), startBridge()]);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    base = `http://127.0.0.1:${first}`;
    await pair();
    expect((await request('GET', '/hello', { auth: null })).status).toBe(200);
  });

  it('cancels an ended run’s queued worker chats exactly once, however often it has restarted', async () => {
    for (let restart = 0; restart < 2; restart++) {
      await stopBridge();
      const port = await startBridge();
      expect(port).not.toBeNull();
      base = `http://127.0.0.1:${port}`;
    }
    await pair();

    spawn({ workers: [{ task: 'work' }], caller: { conversationId: PRIME_CHAT } });
    expect(pendingCommands().map((command) => command.what)).toEqual(['worker:worker-1']);

    // A worker chat that has not opened yet must not open for a run that is over.
    resetSwarm();
    expect(pendingCommands()).toEqual([]);
  });

  it('stops listening to the swarm while it is down', async () => {
    await pair();
    spawn({ workers: [{ task: 'work' }], caller: { conversationId: PRIME_CHAT } });
    expect(pendingCommands()).toHaveLength(1);

    await stopBridge();
    // With the bridge down there is nobody to hear this, which is the point: the listener
    // came off with the module. A stale one would be reaching into the queue of a bridge
    // that is not running.
    resetSwarm();
    expect(pendingCommands()).toHaveLength(1);

    const port = await startBridge();
    expect(port).not.toBeNull();
    base = `http://127.0.0.1:${port}`;
    await pair();
    // And the command is not handed out on the way back up either: its worker belongs to a
    // run that no longer exists, so startup's ordinary tidy pass retires it before delivery.
    expect(pendingCommands()).toEqual([]);
  });

  it('does not queue or open a newly spawned worker through a stale bridge callback while stopped', async () => {
    await stopBridge();
    opened.length = 0;

    // onSpawnRequest/onReviveRequest are singleton broker callbacks, not part of the HTTP
    // server object. Before they had disposers, stopBridge() removed only the swarm-end listener,
    // so a new worker created while the bridge was down still called queueWorkerBootstrap() and
    // could even launch Chrome through the stale opener. Nothing transport-facing may happen
    // until the next start registers a fresh callback and replays broker-owned work.
    spawn({ workers: [{ task: 'must wait for bridge restart' }], caller: { conversationId: PRIME_CHAT } });
    expect(pendingCommands()).toEqual([]);
    expect(opened).toEqual([]);

    const port = await startBridge();
    expect(port).not.toBeNull();
    base = `http://127.0.0.1:${port}`;
    await waitForOpened(1);
    expect(pendingCommands().map((command) => command.what)).toEqual(['worker:worker-1']);
  });

  it('does not queue or reopen a sleeping worker through a stale revival callback while stopped', async () => {
    await pair();
    spawn({ workers: [{ task: 'be reusable across a bridge restart' }], caller: { conversationId: PRIME_CHAT } });
    const bootstrap = await redeem();
    const conversationId = 'abababab-1111-4222-8333-666666666666';
    await request('POST', '/commands/ack', {
      body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
    });
    finishAgent({ conversationId }, 'sleeping before bridge stop');
    expect(swarmState().agents.find((entry) => entry.id === 'worker-1')?.state).toBe('sleeping');

    await stopBridge();
    opened.length = 0;
    const staged = stageMessages({ conversationId: PRIME_CHAT }, [
      { to: 'worker-1', text: 'this must wait until the bridge is started again' }
    ]);
    staged.commit();
    expect(staged.waking).toEqual(['worker-1']);
    expect(requestWorkerRevivals(staged.waking)).toBe(1);
    // The broker owns a durable waking reservation, but the stopped bridge owns no callback and
    // therefore creates neither a transport row nor a browser side effect yet.
    expect(pendingCommands()).toEqual([]);
    expect(opened).toEqual([]);

    const port = await startBridge();
    expect(port).not.toBeNull();
    base = `http://127.0.0.1:${port}`;
    expect((await waitForRevival()).conversationId).toBe(conversationId);
    expect(opened).toEqual([]);
    expect(pendingCommands().map((command) => command.what)).toEqual(['revive:worker-1']);
  });

  it('re-arms an in-memory leased command instead of reopening it after stop/start', async () => {
    await pair();
    spawn({ workers: [{ task: 'work' }], caller: { conversationId: PRIME_CHAT } });
    await waitForOpened(1);
    const leased = await redeem();
    expect(leased.agent).toBe('worker-1');

    const realNow = Date.now;
    const leasedAt = realNow();
    await stopBridge();
    try {
      // The old deadline timer is gone because stopBridge deliberately cleared it. Advance
      // only the clock: on restart an implementation that forgets to re-arm/expire the
      // retained lease sees it as deliverable and opens the exact same bootstrap again.
      Date.now = () => leasedAt + 91_000;
      const port = await startBridge();
      expect(port).not.toBeNull();
      base = `http://127.0.0.1:${port}`;
      expect(opened).toHaveLength(1);
      expect(pendingCommands()).toEqual([]);
      expect(swarmState().running).toBe(false);
      expect(swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((entry) => entry.id === 'worker-1')?.state).toBe('failed');
    } finally {
      Date.now = realNow;
    }
  });
});

// -------------------------------------------------------------------- goal loop

/**
 * The three routes the goal loop adds, and the refusals that matter most.
 *
 * The page decides *when* a turn is over; everything after that is the app's, because the
 * OpenRouter key is a real credential and never crosses into a browser. So these routes are
 * where somebody's credit gets spent, and each of them is checked before it spends any.
 */
describe('the goal loop over the bridge', () => {
  beforeEach(async () => {
    await saveConfig({
      ...defaultConfig(),
      sessions: { ...defaultConfig().sessions, record: true },
      goal: { ...defaultConfig().goal, enabled: true, model: 'deepseek/deepseek-v4-flash', reasoning: 'default' }
    });
    await setSecret('openRouterApiKey', 'sk-or-bridge');
    resetGoalStateForTests();
  });

  it('retires a handoff source from Goal and Loop, including the app watchdog', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      const from = 'cafe0091-0000-4000-8000-000000000091';
      const to = 'cafe0092-0000-4000-8000-000000000092';
      const recorded = await request('POST', '/events', {
        body: {
          conversationId: from,
          events: [
            { kind: 'user_message', time: Date.now(), text: 'continue until done', messageId: 'm-retired-goal' },
            { kind: 'turn_start', time: Date.now(), turnId: 'g-retired-goal' },
            { kind: 'turn_end', time: Date.now(), turnId: 'g-retired-goal', outcome: 'completed' },
            {
              kind: 'assistant_message',
              time: Date.now(),
              messageId: 'a-retired-goal',
              text: 'Ready to continue.',
              state: 'final',
              final: true,
              goalEligible: true,
              activeNow: true
            }
          ]
        }
      });
      const sessionId = recorded.body.sessionId as string;
      const continuation = await openContinuationNow(sessionId, from);
      expect(await attachSummary(continuation.token, SAMPLE_BRIEF)).not.toBeNull();
      await claimContinuationNow(continuation.token, 'retired-goal-test');
      expect(await commitContinuation(continuation.token, to)).toBe(true);

      const oldFeed = await request('GET', `/activity?conversationId=${from}`);
      expect(oldFeed.body.goal).toMatchObject({ enabled: false, own: true, blocked: 'continued', pending: null });
      expect((await request('POST', '/goal/draft', {
        body: { conversationId: from, turnId: 'g-retired-goal', terminalRequired: true, clientId: 'old-page' }
      })).body.error).toBe('conversation_superseded');
      expect((await request('POST', '/settings', {
        body: { conversationId: from, loop: true }
      })).body.error).toBe('conversation_superseded');

      await vi.advanceTimersByTimeAsync(40 * 60_000);
      await sweepStaleSwarm(Date.now());
      expect((await request('GET', '/status')).body.repairs).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('repairs Goal onto the exact pre-fix resume-shadow chat and can draft there', async () => {
    await pair();
    const from = 'cafe0031-0000-4000-8000-000000000031';
    const to = 'cafe0032-0000-4000-8000-000000000032';
    const source = await createSession({ title: 'prime before resume-shadow collision', conversationId: from });
    spawn({ workers: [{ task: 'keep one worker alive across the broken resume' }], caller: { conversationId: from } });
    setGoalObjective(from, 'finish the release from the resumed prime chat');

    const openedContinuation = await openContinuationNow(source.id, from);
    const handoff = await attachSummary(openedContinuation.token, SAMPLE_BRIEF);
    expect(handoff).not.toBeNull();
    await claimContinuationNow(openedContinuation.token, 'resume-shadow-owner');
    const shadow = await createSession({
      title: 'Resumed · prime before resume-shadow collision',
      conversationId: to,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
    });
    await recordChatObservations(to, [
      {
        kind: 'user_message',
        time: Date.now(),
        text: resumeBootstrapText(handoff!.text).replace('previous chat', `previous\u00c2\u00a0chat`),
        messageId: 'm-shadow-resume'
      },
      {
        kind: 'assistant_message',
        time: Date.now() + 1,
        text: 'The release is still unfinished.',
        messageId: 'a-shadow-resume',
        state: 'final',
        final: true
      }
    ]);
    expect(await commitContinuation(openedContinuation.token, to)).toBe(false);
    abortContinuation(openedContinuation.token, 'the replacement chat already belongs to another local session');
    expect(goalObjectiveFor(from)).toBe('finish the release from the resumed prime chat');
    expect(goalObjectiveFor(to)).toBe('');

    setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });

    // `/activity` must not turn a plausible-looking resume origin into takeover authority. The
    // exact bootstrap is the second half of the proof and this chat deliberately does not have it.
    const unrelated = 'cafe0033-0000-4000-8000-000000000033';
    await createSession({
      title: 'resume-looking but unrelated',
      conversationId: unrelated,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
    });
    await recordChatObservations(unrelated, [
      { kind: 'user_message', time: Date.now(), text: 'a different bootstrap', messageId: 'm-unrelated-shadow' }
    ]);
    const unrelatedFeed = await request('GET', `/activity?conversationId=${unrelated}`);
    expect(unrelatedFeed.status).toBe(200);
    expect(unrelatedFeed.body.goal.objective).toBe('');
    expect(goalObjectiveFor(from)).toBe('finish the release from the resumed prime chat');
    expect(goalObjectiveFor(unrelated)).toBe('');

    // No agents/tool call performs the repair. The Goal activity poll itself must heal A→B.
    const feed = await request('GET', `/activity?conversationId=${to}`);
    expect(feed.status).toBe(200);
    expect(feed.body.sessionId).toBe(shadow.id);
    expect(feed.body.goal).toMatchObject({ enabled: true, objective: 'finish the release from the resumed prime chat' });
    expect(goalObjectiveFor(from)).toBe('');
    expect(goalObjectiveFor(to)).toBe('finish the release from the resumed prime chat');

    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({
        choices: [{ message: { content: JSON.stringify({ action: 'continue', reply: 'keep going from B' }) } }]
      });
    }) as never;
    try {
      const drafted = await request('POST', '/goal/draft', {
        body: { conversationId: to, turnId: 'g-shadow-repaired', clientId: 'shadow-goal-tab' }
      });
      expect(drafted.status).toBe(200);
      expect(drafted.body.sessionId).toBe(shadow.id);
      expect(drafted.body.goal.turnId).toBe('g-shadow-repaired');
      await vi.waitFor(() => expect(calls).toBe(1));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('does not report the same no-Goal resume-shadow repair on every activity poll', async () => {
    await pair();
    const from = 'cafe0041-0000-4000-8000-000000000041';
    const to = 'cafe0042-0000-4000-8000-000000000042';
    const source = await createSession({ title: 'prime before no-goal resume-shadow collision', conversationId: from });
    spawn({ workers: [{ task: 'keep reusable ownership across the broken resume' }], caller: { conversationId: from } });

    const openedContinuation = await openContinuationNow(source.id, from);
    const handoff = await attachSummary(openedContinuation.token, SAMPLE_BRIEF);
    expect(handoff).not.toBeNull();
    await claimContinuationNow(openedContinuation.token, 'no-goal-shadow-owner');
    await createSession({
      title: 'Resumed · prime before no-goal resume-shadow collision',
      conversationId: to,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
    });
    await recordChatObservations(to, [
      {
        kind: 'user_message',
        time: Date.now(),
        text: resumeBootstrapText(handoff!.text),
        messageId: 'm-no-goal-shadow-resume'
      }
    ]);
    expect(await commitContinuation(openedContinuation.token, to)).toBe(false);
    abortContinuation(openedContinuation.token, 'the replacement chat already belongs to another local session');
    setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });

    const repairWarnings = (): number =>
      getLog().filter(
        (entry) =>
          entry.level === 'warn' &&
          entry.message.includes('resume-shadow repair (') &&
          entry.message.endsWith(`moved missing projections into chat ${to}`)
      ).length;
    const warningsBefore = repairWarnings();

    const first = await request('GET', `/activity?conversationId=${to}`);
    expect(first.status).toBe(200);
    expect(snapshotSwarm()?.primeConversationId).toBe(to);
    expect(first.body.goal.objective).toBe('');
    expect(repairWarnings()).toBe(warningsBefore + 1);

    const second = await request('GET', `/activity?conversationId=${to}`);
    expect(second.status).toBe(200);
    expect(second.body.goal.objective).toBe('');
    expect(repairWarnings()).toBe(warningsBefore + 1);
  });

  /** The page needs to know three things, and it gets them on the feed it already polls. */
  it('reports the settings on the activity feed', async () => {
    await pair();
    await request('POST', '/events', {
      body: {
        conversationId: 'cafe0001-0000-4000-8000-000000000001',
        events: [{ kind: 'user_message', time: Date.now(), text: 'do the work', messageId: 'm-goal-1' }]
      }
    });

    const reply = await request('GET', '/activity?conversationId=cafe0001-0000-4000-8000-000000000001');
    expect(reply.status).toBe(200);
    expect(reply.body.goal).toMatchObject({
      enabled: true,
      hasKey: true,
      model: 'deepseek/deepseek-v4-flash',
      draft: null
    });
  });

  it('makes an accepted Goal turn durable before the provider can fail or the page can reload', async () => {
    await pair();
    const chat = 'cafe0050-0000-4000-8000-000000000050';
    const turnId = 'g-provider-failed-before-reload';
    await request('POST', '/events', {
      body: {
        conversationId: chat,
        events: [{ kind: 'user_message', time: Date.now(), text: 'continue until done', messageId: 'm-durable-goal' }]
      }
    });

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json(
      { error: { message: 'Provider returned error' } },
      { status: 429 }
    )) as never;
    try {
      const started = await request('POST', '/goal/draft', {
        body: { conversationId: chat, turnId, clientId: 'page-before-reload' }
      });
      expect(started.status).toBe(200);
      await vi.waitFor(async () => {
        const draft = (await request('GET', `/activity?conversationId=${chat}&goalClient=page-before-reload`)).body.goal.draft;
        expect(draft).toMatchObject({ stage: 'failed', turnId, retryable: true });
      });

      const failed = (await request('GET', `/activity?conversationId=${chat}&goalClient=page-before-reload`)).body.goal;
      expect(failed.pending).toEqual({
        replyId: `turn:${turnId}`,
        turnId,
        eventSeq: 0,
        acceptedAt: expect.any(Number)
      });
      expect((await request('POST', '/goal/ack', {
        body: { conversationId: chat, token: failed.draft.token, clientId: 'page-before-reload' }
      })).body.acknowledged).toBe(true);

      // A failed attempt is not an answer. Once its transient payload is acknowledged, a
      // replacement document still receives the durable obligation and can ask again.
      const afterReload = (await request('GET', `/activity?conversationId=${chat}&goalClient=page-after-reload`)).body.goal;
      expect(afterReload.draft).toBeNull();
      expect(afterReload.pending).toEqual({
        replyId: `turn:${turnId}`,
        turnId,
        eventSeq: 0,
        acceptedAt: expect.any(Number)
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('turns a post-reload stable final answer into one durable Goal model call', async () => {
    await pair();
    const chat = 'cafe0051-0000-4000-8000-000000000051';
    await request('POST', '/events', {
      body: {
        conversationId: chat,
        events: [
          { kind: 'user_message', time: Date.now(), text: 'finish the release', messageId: 'm-reload-goal' },
          { kind: 'turn_start', time: Date.now(), turnId: 'g-before-page-reload' },
          { kind: 'turn_end', time: Date.now(), turnId: 'g-before-page-reload', outcome: 'unknown' }
        ]
      }
    });

    const replyId = 'assistant-final-seen-after-reload';
    const terminal = await request('POST', '/events', {
      body: {
        conversationId: chat,
        events: [{
          kind: 'assistant_message',
          time: Date.now(),
          messageId: replyId,
          text: 'The requested release work is complete.',
          state: 'final',
          final: true
        }]
      }
    });
    expect(terminal.status).toBe(200);

    const pending = (await request('GET', `/activity?conversationId=${chat}`)).body.goal.pending;
    expect(pending).toEqual({
      replyId,
      turnId: `reply:${replyId}`,
      eventSeq: expect.any(Number),
      acceptedAt: expect.any(Number)
    });

    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({
        choices: [{ message: { content: JSON.stringify({ action: 'stop', reply: '' }) } }]
      });
    }) as never;
    try {
      const drafted = await request('POST', '/goal/draft', {
        body: {
          conversationId: chat,
          turnId: pending.turnId,
          terminalRequired: true,
          clientId: 'reloaded-goal-page'
        }
      });
      expect(drafted.status).toBe(200);
      await vi.waitFor(() => expect(calls).toBe(1));
      const decided = (await request('GET', `/activity?conversationId=${chat}&goalClient=reloaded-goal-page`)).body.goal.draft;
      expect(decided).toMatchObject({ stage: 'no-reply', turnId: pending.turnId });
      expect((await request('POST', '/goal/ack', {
        body: { conversationId: chat, token: decided.token, clientId: 'reloaded-goal-page' }
      })).body.acknowledged).toBe(true);

      // At-least-once page delivery of the same stable reply cannot mint another obligation.
      expect((await request('POST', '/events', {
        body: {
          conversationId: chat,
          events: [{
            kind: 'assistant_message',
            time: Date.now(),
            messageId: replyId,
            text: 'The requested release work is complete.',
            state: 'final',
            final: true
          }]
        }
      })).status).toBe(200);
      expect((await request('GET', `/activity?conversationId=${chat}`)).body.goal.pending).toBeNull();
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  /**
   * Checked here as well as in the page, because the page's copy of the setting is a poll
   * old and this is the request that spends money.
   */
  /**
   * The switch is the prime's, not the run's.
   *
   * A spawned worker already has an author for its user turns — the prime, through the
   * agents tool — and the brief it was handed is the whole of its objective. A second model
   * typing into it as well is two hands on one wheel: the worker answers a question its
   * prime never asked and finishes against that instead. And with the loop armed run-wide,
   * every worker would be spending OpenRouter credit in parallel on drafts the prime is
   * about to override. So the worker is off whatever the global setting says, and a chat
   * that is no part of the run is untouched.
   */
  it('leaves the loop on for the prime and off for every worker it spawns', async () => {
    await pair();
    spawn({ workers: [{ task: 'Audit the settings sheet' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem();
    const worker = 'cafe0011-0000-4000-8000-000000000011';
    await request('POST', '/commands/ack', {
      body: { id: command.id, status: 'sent', agent: 'worker-1', conversationId: worker }
    });

    const solo = 'cafe0012-0000-4000-8000-000000000012';
    for (const conversationId of [worker, solo]) {
      await request('POST', '/events', {
        body: {
          conversationId,
          events: [{ kind: 'user_message', time: Date.now(), text: 'go', messageId: `m-${conversationId}` }]
        }
      });
    }

    // The feed is what arms the loop in the page, so the refusal has to be visible there
    // rather than only at the moment the draft would be paid for.
    expect((await request('GET', `/activity?conversationId=${worker}`)).body.goal.enabled).toBe(false);
    // A chat that belongs to no agent in the run is an ordinary chat and keeps the loop.
    expect((await request('GET', `/activity?conversationId=${solo}`)).body.goal.enabled).toBe(true);

    // And the route refuses independently, because the page's copy is always a poll old.
    const drafted = await request('POST', '/goal/draft', { body: { conversationId: worker, turnId: 'g-worker' } });
    expect(drafted.status).toBe(409);
    expect(drafted.body.error).toBe('goal_disabled');

    // The setting itself is untouched: this is a rule about who may spend it, not a write.
    expect(getConfig().goal.enabled).toBe(true);
  });

  it('refuses to draft when the loop is off or has no key', async () => {
    await pair();
    await request('POST', '/events', {
      body: {
        conversationId: 'cafe0002-0000-4000-8000-000000000002',
        events: [{ kind: 'user_message', time: Date.now(), text: 'go', messageId: 'm-goal-2' }]
      }
    });

    await saveConfig({
      ...defaultConfig(),
      sessions: { ...defaultConfig().sessions, record: true },
      goal: { ...defaultConfig().goal, enabled: false }
    });
    const off = await request('POST', '/goal/draft', { body: { conversationId: 'cafe0002-0000-4000-8000-000000000002', turnId: 'g-1' } });
    expect(off.status).toBe(409);
    expect(off.body.error).toBe('goal_disabled');

    await saveConfig({
      ...defaultConfig(),
      sessions: { ...defaultConfig().sessions, record: true },
      goal: { ...defaultConfig().goal, enabled: true }
    });
    await setSecret('openRouterApiKey', '');
    const keyless = await request('POST', '/goal/draft', { body: { conversationId: 'cafe0002-0000-4000-8000-000000000002', turnId: 'g-1' } });
    expect(keyless.status).toBe(409);
    expect(keyless.body.error).toBe('no_api_key');
  });

  /** A generation is the draft's identity, so it has to be given one. */
  it('refuses a draft with no generation to answer', async () => {
    await pair();
    const reply = await request('POST', '/goal/draft', { body: { conversationId: 'cafe0001-0000-4000-8000-000000000001' } });
    expect(reply.status).toBe(400);
    expect(reply.body.error).toBe('bad_turn_id');
  });

  /** Nothing to continue from is not the same as a failure to continue. */
  it('refuses a chat this app has never recorded', async () => {
    await pair();
    const reply = await request('POST', '/goal/draft', {
      body: { conversationId: 'cafe0004-0000-4000-8000-000000000004', turnId: 'g-1' }
    });
    expect(reply.status).toBe(409);
    expect(reply.body.error).toBe('session_not_recorded');
  });

  it('finds an older recorded chat through the durable ownership index, not the capped UI list', async () => {
    await pair();
    await saveConfig({
      ...defaultConfig(),
      sessions: { ...defaultConfig().sessions, record: true },
      goal: { ...defaultConfig().goal, enabled: true }
    });
    await setSecret('openRouterApiKey', 'sk-or-test');
    const conversationId = 'cafe0099-0000-4000-8000-000000000099';
    await createSession({ title: 'older but still owned', conversationId });
    for (let index = 0; index < 65; index++) {
      await createSession({ title: `newer session ${index}`, conversationId: null });
    }

    const reply = await request('POST', '/goal/draft', {
      body: { conversationId, turnId: 'g-old-recording' }
    });
    expect(reply.status).toBe(200);
    expect(reply.body.error).not.toBe('session_not_recorded');
  });

  /**
   * The whole round trip: the draft starts, the structured answer arrives, the page
   * acknowledges it once, and the next poll no longer offers a message to type.
   */
  it('drafts once, hands the message over once, and forgets it on acknowledgement', async () => {
    await pair();
    await request('POST', '/events', {
      body: {
        conversationId: 'cafe0003-0000-4000-8000-000000000003',
        events: [{ kind: 'user_message', time: Date.now(), text: 'write the parser', messageId: 'm-goal-3' }]
      }
    });

    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({ action: 'continue', reply: 'what about the tests' })
            }
          }
        ]
      });
    }) as never;

    try {
      const started = await request('POST', '/goal/draft', {
        body: { conversationId: 'cafe0003-0000-4000-8000-000000000003', turnId: 'g-1' }
      });
      expect(started.status).toBe(200);
      expect(started.body.goal.turnId).toBe('g-1');

      // A retried POST is the same draft, not a second message into somebody's chat.
      const again = await request('POST', '/goal/draft', {
        body: { conversationId: 'cafe0003-0000-4000-8000-000000000003', turnId: 'g-1' }
      });
      expect(again.body.goal.token).toBe(started.body.goal.token);

      let feed: any = null;
      for (let attempt = 0; attempt < 200; attempt++) {
        feed = await request('GET', '/activity?conversationId=cafe0003-0000-4000-8000-000000000003');
        if (feed.body.goal?.draft?.stage === 'ready') break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(calls).toBe(1);
      expect(feed.body.goal.draft.reply).toBe(humanReply('what about the tests'));

      const acked = await request('POST', '/goal/ack', {
        body: { conversationId: 'cafe0003-0000-4000-8000-000000000003', token: started.body.goal.token }
      });
      expect(acked.body.acknowledged).toBe(true);

      const after = await request('GET', '/activity?conversationId=cafe0003-0000-4000-8000-000000000003');
      expect(after.body.goal.draft).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  /**
   * The composer's settings sheet writes through here, and it may write exactly two things.
   * Everything else in this app's settings decides what ChatGPT can reach on this machine,
   * and a route a web page can post to must never be able to widen that.
   */
  it('lets the page set the two switches it owns, and nothing else', async () => {
    await pair();
    const reply = await request('POST', '/settings', { body: { autoCompact: true, goal: false } });
    expect(reply.status).toBe(200);
    expect(getConfig().compaction.auto).toBe(true);
    expect(getConfig().goal.enabled).toBe(false);
    expect(reply.body.context.auto).toBe(true);
    expect(reply.body.goal).toMatchObject({ enabled: false, hasKey: true });

    const readOnly = getConfig().readOnly;
    const capabilities = { ...getConfig().capabilities };
    const rejected = await request('POST', '/settings', {
      body: { readOnly: false, capabilities: { command: true }, roots: [{ name: 'c', path: 'C:' }] }
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe('nothing_to_change');
    expect(getConfig().readOnly).toBe(readOnly);
    expect(getConfig().capabilities).toEqual(capabilities);
  });

  /**
   * Goal and Loop are one setting drawn as two switches, and this is where that is enforced.
   *
   * Mutual exclusion is not kept in step here, it is structural: there is a single mode with a
   * single value, so turning either switch on is the same write with a different word in it and
   * there is no state where both are on. What the route still has to get right is the other
   * direction — switching one off only means something while it is the one that is running.
   */
  it('runs Goal or Loop but never both, and keeps the mode when a switch goes off', async () => {
    await pair();

    const loop = await request('POST', '/settings', { body: { loop: true } });
    expect(loop.status).toBe(200);
    expect(getConfig().goal).toMatchObject({ enabled: true, mode: 'loop' });
    expect(loop.body.goal).toMatchObject({ enabled: true, mode: 'loop' });
    // The page is told the mode as well, which is the whole reason it can never draw both on.
    expect((await request('GET', '/settings')).body.goal).toMatchObject({ enabled: true, mode: 'loop' });

    // Turning Goal on is what turns Loop off. One write, not two.
    expect((await request('POST', '/settings', { body: { goal: true } })).status).toBe(200);
    expect(getConfig().goal).toMatchObject({ enabled: true, mode: 'goal' });

    // Switching off the mode that is *not* running changes nothing at all.
    expect((await request('POST', '/settings', { body: { loop: false } })).status).toBe(200);
    expect(getConfig().goal).toMatchObject({ enabled: true, mode: 'goal' });

    // Switching off the one that is leaves the mode where it was: it is a preference, not a
    // state, so switching it back on gives back what was switched off.
    expect((await request('POST', '/settings', { body: { goal: false } })).status).toBe(200);
    expect(getConfig().goal).toMatchObject({ enabled: false, mode: 'goal' });

    // A body carrying both switches describes a state that does not exist.
    const both = await request('POST', '/settings', { body: { goal: true, loop: true } });
    expect(both.status).toBe(400);
    expect(both.body.error).toBe('goal_and_loop_exclusive');
    expect(getConfig().goal.enabled).toBe(false);
  });

  /**
   * A chat given its own goal, which is the other way into the same loop.
   *
   * The standing switch answers "should this app write my next message in general". A goal
   * answers "here is where this chat has to get to" — which is a stronger statement, made
   * about one chat, at the moment it is made. So it arms the loop on its own: somebody who
   * has just written down the finish line should not then have to find a second switch.
   */
  it('arms the loop for one chat from its own goal, with the standing switch off', async () => {
    await pair();
    const chat = 'cafe0021-0000-4000-8000-000000000021';
    await saveConfig({
      ...defaultConfig(),
      sessions: { ...defaultConfig().sessions, record: true },
      goal: { ...defaultConfig().goal, enabled: false }
    });
    await request('POST', '/events', {
      body: {
        conversationId: chat,
        events: [{ kind: 'user_message', time: Date.now(), text: 'start the port', messageId: 'm-goal-obj' }]
      }
    });

    // A successful save is a durable state transition, not merely an in-memory UI update. Start
    // from an explicitly empty disk row so reading it immediately after the HTTP response catches
    // any regression back to the ordinary 300 ms debounce.
    await writeDurableNow(GOAL_OBJECTIVES_STATE, null);

    const saved = await request('POST', '/goal/objective', {
      body: { conversationId: chat, text: '  port the module and make the suite green  ' }
    });
    expect(saved.status).toBe(200);
    // Stored as it will be prompted with, and reported back rather than assumed, because the
    // page draws its own summary line from this answer.
    expect(saved.body.objective).toBe('port the module and make the suite green');
    expect(await readDurable<{ objectives: Array<{ conversationId: string; objective: string }> }>(GOAL_OBJECTIVES_STATE)).toMatchObject({
      objectives: [
        expect.objectContaining({
          conversationId: chat,
          objective: 'port the module and make the suite green'
        })
      ]
    });

    const feed = await request('GET', `/activity?conversationId=${chat}`);
    expect(feed.body.goal).toMatchObject({
      enabled: false,
      objective: 'port the module and make the suite green',
      blocked: ''
    });

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        choices: [{ message: { content: JSON.stringify({ action: 'continue', reply: 'the tests are still red' }) } }]
      })) as never;
    try {
      // The switch is still off, and the draft is still allowed — the goal is what allows it.
      const drafted = await request('POST', '/goal/draft', { body: { conversationId: chat, turnId: 'g-obj' } });
      expect(drafted.status).toBe(200);
      expect(getConfig().goal.enabled).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }

    // Cleared the same way it was set, and the loop goes back to following the switch.
    const cleared = await request('POST', '/goal/objective', { body: { conversationId: chat, text: '   ' } });
    expect(cleared.body.objective).toBe('');
    expect((await request('GET', `/activity?conversationId=${chat}`)).body.goal.objective).toBe('');
  });

  /**
   * The other half of that rule, and the reason the composer can offer an Off at all.
   *
   * A goal speaks for a chat that has never answered for itself. It does not outrank the chat's
   * own answer: the sheet's mode slider has an Off stop, and an Off that left the loop running
   * because a goal was still written down would be a control that says it stopped something it
   * did not. The goal itself is kept — Off is a mode, not a delete — so moving back to Goal or
   * Loop resumes the same sentence.
   */
  it('stops a chat that switched itself off, and keeps its goal for when it starts again', async () => {
    await pair();
    const chat = 'cafe0023-0000-4000-8000-000000000023';
    await saveConfig({
      ...defaultConfig(),
      sessions: { ...defaultConfig().sessions, record: true },
      goal: { ...defaultConfig().goal, enabled: false }
    });
    await request('POST', '/events', {
      body: {
        conversationId: chat,
        events: [{ kind: 'user_message', time: Date.now(), text: 'start the port', messageId: 'm-goal-off' }]
      }
    });
    await request('POST', '/goal/objective', { body: { conversationId: chat, text: 'port the module' } });

    // Nothing has been said about this chat's own switch yet, so its goal still speaks for it.
    const inherited = await request('GET', `/activity?conversationId=${chat}`);
    expect(inherited.body.goal).toMatchObject({ enabled: false, own: false, objective: 'port the module' });

    // Off, chosen here. The write is chat-scoped, which is what makes it this chat's own answer.
    const off = await request('POST', '/settings', { body: { conversationId: chat, goal: false } });
    expect(off.status).toBe(200);
    expect(off.body.goal).toMatchObject({ enabled: false, own: true });
    const stopped = await request('GET', `/activity?conversationId=${chat}`);
    expect(stopped.body.goal).toMatchObject({ enabled: false, own: true, objective: 'port the module' });

    const drafted = await request('POST', '/goal/draft', { body: { conversationId: chat, turnId: 'g-off' } });
    expect(drafted.status).toBe(409);
    expect(drafted.body.error).toBe('goal_disabled');

    // And back on, into the same goal, without retyping it.
    const on = await request('POST', '/settings', { body: { conversationId: chat, loop: true } });
    expect(on.body.goal).toMatchObject({ enabled: true, own: true, mode: 'loop' });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        choices: [{ message: { content: JSON.stringify({ action: 'continue', reply: 'still red' }) } }]
      })) as never;
    try {
      const again = await request('POST', '/goal/draft', { body: { conversationId: chat, turnId: 'g-on' } });
      expect(again.status).toBe(200);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  /**
   * The run that was lost, and the reason the goal now carries its mode.
   *
   * A goal saved from the sheet armed the loop but said nothing about *which* loop, so the
   * mode was read from the standing switch — off, therefore Goal, therefore allowed to stop.
   * An unattended run started that way ended at its second turn on one "looks done" from the
   * gate, two minutes after an identical chat with the Loop switch on had been started by
   * hand. The mode the goal was written in is now pinned as that chat's own switch, in the
   * same request, so nothing between the save and the first draft can answer it differently.
   */
  it('pins the mode a goal was written in as that chat’s own switch', async () => {
    await pair();
    const chat = 'cafe0022-0000-4000-8000-000000000022';
    await saveConfig({
      ...defaultConfig(),
      sessions: { ...defaultConfig().sessions, record: true },
      // The exact configuration the lost run had: switched off, with `loop` sitting there as a
      // remembered preference that nothing reads while `enabled` is false.
      goal: { ...defaultConfig().goal, enabled: false, mode: 'loop' }
    });
    await request('POST', '/events', {
      body: {
        conversationId: chat,
        events: [{ kind: 'user_message', time: Date.now(), text: 'build the sandbox', messageId: 'm-goal-mode' }]
      }
    });
    await writeDurableNow(GOAL_SWITCHES_STATE, null);

    // Without a mode, nothing changes: the standing switch still decides, and it says Goal.
    await request('POST', '/goal/objective', { body: { conversationId: chat, text: 'build the voxel sandbox' } });
    expect(goalSwitchFor(chat).own).toBe(false);
    expect(goalDrivingMode(chat)).toBe('goal');

    const looped = await request('POST', '/goal/objective', {
      body: { conversationId: chat, text: 'build the voxel sandbox', mode: 'loop' }
    });
    expect(looped.status).toBe(200);
    // Answered back rather than assumed, because the sheet draws the mode from this reply.
    expect(looped.body).toMatchObject({ objective: 'build the voxel sandbox', enabled: true, mode: 'loop' });
    expect(goalDrivingMode(chat)).toBe('loop');
    // Durable before the response was written, on the same terms as the goal itself: a mode
    // that survives only in memory is a mode a restart turns back into a Goal that may stop.
    expect(
      await readDurable<{ switches: Array<{ conversationId: string; enabled: boolean; mode: string }> }>(GOAL_SWITCHES_STATE)
    ).toMatchObject({
      switches: [expect.objectContaining({ conversationId: chat, enabled: true, mode: 'loop' })]
    });
    // The app-wide default is untouched: this was one chat's decision, made in one chat's sheet.
    expect(getConfig().goal.enabled).toBe(false);

    // The same request is how a mode is changed, without going near the switches.
    const backToGoal = await request('POST', '/goal/objective', {
      body: { conversationId: chat, text: 'build the voxel sandbox', mode: 'goal' }
    });
    expect(backToGoal.body).toMatchObject({ enabled: true, mode: 'goal' });
    expect(goalDrivingMode(chat)).toBe('goal');

    // And clearing the goal ends the run it named. Writing the goal is what switched this
    // chat on, so deleting it has to switch it back off — otherwise the chat keeps being
    // prompted with no finish line left to say what for.
    const cleared = await request('POST', '/goal/objective', {
      body: { conversationId: chat, text: '', mode: 'goal' }
    });
    expect(cleared.body).toMatchObject({ objective: '', enabled: false });
    expect(goalSwitchFor(chat)).toMatchObject({ enabled: false, own: true });
  });

  /**
   * The switch belongs to the chat it was flipped in.
   *
   * It used to be one app-wide setting reachable from every composer, which is the wrong shape
   * for what people do with it: leave a loop running in one conversation while the rest stay
   * conversations. Turning it off to stop one runaway chat stopped all of them. A chat with no
   * answer of its own still follows the app-wide setting, so nothing that has never been touched
   * changes behaviour — and that inheritance is what retires an old chat safely: turn Goal off
   * where it pops up, and no later app-wide change can revive that one.
   */
  it('stores the Goal switch against the chat whose composer sent it', async () => {
    await pair();
    const driven = 'cafe0071-0000-4000-8000-000000000071';
    const other = 'cafe0072-0000-4000-8000-000000000072';
    for (const chat of [driven, other]) {
      await request('POST', '/events', {
        body: {
          conversationId: chat,
          events: [{ kind: 'user_message', time: Date.now(), text: 'hello', messageId: `m-switch-${chat}` }]
        }
      });
    }
    // Both inherit the app-wide setting until one of them says otherwise.
    expect((await request('GET', `/activity?conversationId=${driven}`)).body.goal.enabled).toBe(true);
    expect((await request('GET', `/activity?conversationId=${other}`)).body.goal.enabled).toBe(true);

    const off = await request('POST', '/settings', { body: { conversationId: driven, goal: false } });
    expect(off.status).toBe(200);
    expect(off.body.goal).toMatchObject({ enabled: false });
    expect((await request('GET', `/activity?conversationId=${driven}`)).body.goal.enabled).toBe(false);
    // The chat that said nothing is untouched, and so is the app-wide default it follows.
    expect((await request('GET', `/activity?conversationId=${other}`)).body.goal.enabled).toBe(true);
    expect(getConfig().goal.enabled).toBe(true);
    expect((await request('GET', '/settings')).body.goal.enabled).toBe(true);

    // Loop in one chat is Loop in that chat. The other keeps answering `goal`, which is what
    // makes the two switches mutually exclusive per conversation rather than across the app.
    const loop = await request('POST', '/settings', { body: { conversationId: other, loop: true } });
    expect(loop.body.goal).toMatchObject({ enabled: true, mode: 'loop' });
    expect((await request('GET', `/activity?conversationId=${other}`)).body.goal).toMatchObject({
      enabled: true,
      mode: 'loop'
    });
    expect((await request('GET', `/activity?conversationId=${driven}`)).body.goal).toMatchObject({
      enabled: false,
      mode: 'goal'
    });
    expect(getConfig().goal.mode).toBe('goal');

    // A saved switch is durable before the page is told it saved, exactly like a saved goal.
    expect(
      await readDurable<{ switches: Array<{ conversationId: string; enabled: boolean; mode: string }> }>('goal-switches')
    ).toMatchObject({
      switches: expect.arrayContaining([
        expect.objectContaining({ conversationId: driven, enabled: false }),
        expect.objectContaining({ conversationId: other, enabled: true, mode: 'loop' })
      ])
    });
  });

  it('makes Goal Off a durable ticket cancel and On a fresh pickup of the same final', async () => {
    await pair();
    const chat = 'cafe0076-0000-4000-8000-000000000076';
    await request('POST', '/events', {
      body: {
        conversationId: chat,
        events: [
          { kind: 'user_message', time: Date.now(), text: 'keep going', messageId: 'm-switch-ticket' },
          {
            kind: 'assistant_message',
            time: Date.now(),
            messageId: 'a-switch-ticket',
            text: 'Finished this pass.',
            state: 'final',
            final: true,
            goalEligible: true,
            activeNow: true
          }
        ]
      }
    });
    expect((await request('GET', `/activity?conversationId=${chat}`)).body.goal.pending).toMatchObject({
      replyId: 'a-switch-ticket'
    });

    expect((await request('POST', '/settings', { body: { conversationId: chat, goal: false } })).status).toBe(200);
    expect((await request('GET', `/activity?conversationId=${chat}`)).body.goal.pending).toBeNull();
    expect(await readDurable<{ replies: Array<{ conversationId: string; state: string }> }>(GOAL_REPLIES_STATE)).toMatchObject({
      replies: expect.arrayContaining([expect.objectContaining({ conversationId: chat, state: 'handled' })])
    });

    expect((await request('POST', '/settings', { body: { conversationId: chat, goal: true } })).status).toBe(200);
    expect((await request('GET', `/activity?conversationId=${chat}`)).body.goal.pending).toMatchObject({
      replyId: 'a-switch-ticket'
    });
  });

  /**
   * The app watching its own ledger, because the loop's only trigger lives in the page.
   *
   * A content script sees a turn end and asks for a draft. That is the right place for the
   * trigger and the wrong place for the *guarantee*: a document that dies between the final
   * answer and that request takes the loop down with it silently, leaving an obligation
   * correctly marked pending and nobody alive to redeem it. This is what the live prime trace
   * was — the reply landed at 21:56:46 and the app first heard a Goal was owed at 22:00:33,
   * when a human reloaded the page by hand.
   *
   * So the schedule is the silence rule's two minutes, and then two, five, ten, fifteen. Five
   * reloads, a little over half an hour, and then it stops for good: every one of them is this
   * app typing into somebody's browser about an answer already on screen, and a page that has
   * not come back inside half an hour is not coming back.
   */
  it('reloads a chat whose finished reply nothing ever came to collect, then stops', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      const chat = 'cafe0073-0000-4000-8000-000000000073';
      await request('POST', '/events', {
        body: {
          conversationId: chat,
          events: [
            { kind: 'user_message', time: Date.now(), text: 'keep going', messageId: 'm-watchdog' },
            { kind: 'turn_start', time: Date.now(), turnId: 'g-watchdog' },
            { kind: 'turn_end', time: Date.now(), turnId: 'g-watchdog', outcome: 'completed' }
          ]
        }
      });
      await request('POST', '/events', {
        body: {
          conversationId: chat,
          events: [{
            kind: 'assistant_message',
            time: Date.now(),
            messageId: 'a-watchdog',
            text: 'Done with that part.',
            state: 'final',
            final: true,
            // What the page says when it has just watched this exact answer settle. It is the
            // page's verdict that mints the obligation, and the whole point of the watchdog is
            // that the page can die between minting it and coming back to redeem it.
            goalEligible: true,
            activeNow: true
          }]
        }
      });
      expect((await request('GET', `/activity?conversationId=${chat}`)).body.goal.pending).not.toBeNull();

      const takeRepair = async (): Promise<{ conversationId: string; token: string; reason: string } | null> => {
        await sweepStaleSwarm(Date.now());
        return (await request('GET', '/status')).body.repairs?.[0] ?? null;
      };

      // The page owns the first two minutes. Nothing is wrong with a chat whose script is
      // simply taking a moment to ask.
      await vi.advanceTimersByTimeAsync(2 * 60_000 - 1_000);
      expect(await takeRepair()).toBeNull();

      // Two minutes, then 2 / 5 / 10 / 15 between the retries. Each reload is confirmed the way
      // the extension confirms it, so what is measured here is the schedule and not a handout
      // being retried because nobody said it worked.
      const gaps = [1_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000];
      for (const [index, gap] of gaps.entries()) {
        await vi.advanceTimersByTimeAsync(gap);
        const handout = await takeRepair();
        expect(handout, `reload ${index + 1} of ${gaps.length}`).toMatchObject({
          conversationId: chat,
          reason: 'goal'
        });
        expect((await request('GET', `/status?repaired=${handout!.token}&repairAction=reloaded`)).status).toBe(200);
        // And never twice for the same step: the next one is owed only after its own gap.
        expect(await takeRepair()).toBeNull();
      }

      // Five is all it gets. The obligation is still on file — it stays there for the page to
      // redeem if it ever comes back — but this app has stopped asking.
      await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
      expect(await takeRepair()).toBeNull();
      expect((await request('GET', `/activity?conversationId=${chat}`)).body.goal.pending).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Collected is collected, and only collecting counts.
   *
   * A finished response is not a pickup — the whole failure this watches for happens *after*
   * the response is finished. The obligation is discharged by the page acknowledging a terminal
   * decision, and that is the exact moment the schedule ends.
   */
  it('stops watching a goal the page comes and collects', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      const chat = 'cafe0074-0000-4000-8000-000000000074';
      await request('POST', '/events', {
        body: {
          conversationId: chat,
          events: [
            { kind: 'user_message', time: Date.now(), text: 'keep going', messageId: 'm-collected' },
            {
              kind: 'assistant_message',
              time: Date.now(),
              messageId: 'a-collected',
              text: 'All done.',
              state: 'final',
              final: true,
              goalEligible: true,
              activeNow: true
            }
          ]
        }
      });
      const pending = (await request('GET', `/activity?conversationId=${chat}`)).body.goal.pending;
      expect(pending).not.toBeNull();

      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        Response.json({
          choices: [{ message: { content: JSON.stringify({ action: 'stop', reply: '' }) } }]
        })) as never;
      try {
        const drafted = await request('POST', '/goal/draft', {
          body: { conversationId: chat, turnId: pending.turnId, terminalRequired: true, clientId: 'collector' }
        });
        expect(drafted.status).toBe(200);
        await vi.waitFor(async () => {
          const view = (await request('GET', `/activity?conversationId=${chat}&goalClient=collector`)).body.goal.draft;
          expect(view?.stage).toBe('no-reply');
        });
        const decided = (await request('GET', `/activity?conversationId=${chat}&goalClient=collector`)).body.goal.draft;
        expect((await request('POST', '/goal/ack', {
          body: { conversationId: chat, token: decided.token, clientId: 'collector' }
        })).body.acknowledged).toBe(true);
      } finally {
        globalThis.fetch = realFetch;
      }

      await vi.advanceTimersByTimeAsync(40 * 60_000);
      await sweepStaleSwarm(Date.now());
      expect((await request('GET', '/status')).body.repairs).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The worker rule, applied to the goal as well as to the draft.
   *
   * Refusing to *hold* a goal for a worker, rather than only refusing to act on one, keeps
   * the rule in one place — nothing downstream has to remember that this particular stored
   * goal is one it must never use. The feed says why, because a switch drawn off for a
   * reason nobody stated reads as a setting that failed to save.
   */
  it('refuses to hold a goal for a worker chat, and says so on the feed', async () => {
    await pair();
    spawn({ workers: [{ task: 'Audit the settings sheet' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem();
    const worker = 'cafe0022-0000-4000-8000-000000000022';
    await request('POST', '/commands/ack', {
      body: { id: command.id, status: 'sent', agent: 'worker-1', conversationId: worker }
    });

    await request('POST', '/events', {
      body: {
        conversationId: worker,
        events: [{ kind: 'user_message', time: Date.now(), text: 'go', messageId: 'm-goal-worker' }]
      }
    });

    const refused = await request('POST', '/goal/objective', {
      body: { conversationId: worker, text: 'finish the audit' }
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('goal_worker_chat');

    const feed = await request('GET', `/activity?conversationId=${worker}`);
    expect(feed.body.goal).toMatchObject({ enabled: false, objective: '', blocked: 'worker' });
  });

  it('keeps the worker Goal fence after its owner parks', async () => {
    await pair();
    spawn({ workers: [{ task: 'Audit the settings sheet' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem();
    const worker = 'cafe0023-0000-4000-8000-000000000023';
    await request('POST', '/commands/ack', {
      body: { id: command.id, status: 'sent', agent: 'worker-1', conversationId: worker }
    });

    finishAgent({ conversationId: worker }, 'audit complete for now');
    expect(swarmState().running).toBe(true);
    expect(await sweepStaleSwarm()).toBe(true);
    expect(swarmState().running).toBe(false);
    expect(swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      conversationId: worker
    });

    const refused = await request('POST', '/goal/objective', {
      body: { conversationId: worker, text: 'keep doing extra work after you stopped' }
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('goal_worker_chat');
    const feed = await request('GET', `/activity?conversationId=${worker}`);
    expect(feed.body.goal).toMatchObject({ enabled: false, objective: '', blocked: 'worker' });
  });

  it('keeps the Goal fence on an explicitly retired worker conversation', async () => {
    await pair();
    spawn({ workers: [{ task: 'temporary worker' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem();
    const worker = 'cafe0026-0000-4000-8000-000000000026';
    await request('POST', '/commands/ack', {
      body: { id: command.id, status: 'sent', agent: 'worker-1', conversationId: worker }
    });
    resetSwarm();
    expect(retiredWorkerForConversation(worker)).toMatchObject({ id: 'worker-1', conversationId: worker });

    const refused = await request('POST', '/goal/objective', {
      body: { conversationId: worker, text: 'restart this cleared worker as a Goal chat' }
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('goal_worker_chat');
    expect((await request('GET', `/activity?conversationId=${worker}`)).body.goal).toMatchObject({
      objective: '',
      blocked: 'worker'
    });
  });

  it('keeps the worker Goal fence after explicit swarm clear retires its conversation', async () => {
    await pair();
    spawn({ workers: [{ task: 'Audit the settings sheet' }], caller: { conversationId: PRIME_CHAT } });
    const command = await redeem();
    const worker = 'cafe0024-0000-4000-8000-000000000024';
    await request('POST', '/commands/ack', {
      body: { id: command.id, status: 'sent', agent: 'worker-1', conversationId: worker }
    });

    resetSwarm();
    expect(retiredWorkerForConversation(worker)).toMatchObject({ id: 'worker-1', conversationId: worker });

    const refused = await request('POST', '/goal/objective', {
      body: { conversationId: worker, text: 'keep doing extra work after explicit clear' }
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('goal_worker_chat');

    const feed = await request('GET', `/activity?conversationId=${worker}`);
    expect(feed.body.goal).toMatchObject({ enabled: false, objective: '', blocked: 'worker' });
    expect(feed.body.retiredWorker).toMatchObject({ id: 'worker-1', conversationId: worker });
  });

  /**
   * The one goal message that cannot be keyed by conversation, because sending it is what
   * makes ChatGPT issue the conversation.
   */
  it('writes the opening message of a chat that does not exist yet', async () => {
    await pair();
    let seen: Array<{ role: string; content: string }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen = (JSON.parse(String(init.body)) as { messages: typeof seen }).messages;
      return Response.json({
        choices: [{ message: { content: JSON.stringify({ action: 'continue', reply: 'rewrite the parser in rust' }) } }]
      });
    }) as never;

    try {
      const opened = await request('POST', '/goal/open', { body: { text: 'rewrite the parser in rust' } });
      expect(opened.status).toBe(200);
      expect(opened.body).toEqual({
        reply: humanReply('rewrite the parser in rust'),
        model: 'deepseek/deepseek-v4-flash'
      });
      // The opening turn is the last *conversation* message; the closing reminder the goal
      // loop appends after the transcript is a system message and sits behind it.
      expect(seen.filter((message) => message.role !== 'system').at(-1)!.content).toContain(
        'has not started yet'
      );

      // Nothing to open with is a bad request, not an empty message typed into somebody's chat.
      const blank = await request('POST', '/goal/open', { body: { text: '   ' } });
      expect(blank.status).toBe(400);
      expect(blank.body.error).toBe('no_objective');

      await setSecret('openRouterApiKey', '');
      const keyless = await request('POST', '/goal/open', { body: { text: 'ship it' } });
      expect(keyless.status).toBe(409);
      expect(keyless.body.error).toBe('no_api_key');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('marks a rate-limited New Chat opening as retryable', async () => {
    await pair();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({ error: { message: 'Provider returned error' } }, { status: 429 })) as never;

    try {
      const opened = await request('POST', '/goal/open', { body: { text: 'rewrite the parser in rust' } });
      expect(opened.status).toBe(502);
      expect(opened.body).toEqual({
        error: 'rate_limited: Provider returned error',
        retryable: true
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  /**
   * The settings, read by a composer that is in no chat yet.
   *
   * `/activity` carries the same two switches, and it is addressed by conversation — which a
   * New Chat has none of, and a New Chat is where a goal writes the first message. Nothing
   * conversation-scoped may appear here, because there is no conversation to scope it to.
   */
  it('reports the settings without a conversation to report them for', async () => {
    await pair();
    const reply = await request('GET', '/settings');
    expect(reply.status).toBe(200);
    expect(reply.body.goal).toEqual({
      enabled: true,
      // The app-wide setting belongs to no chat, so it is nobody's own answer: this is what a
      // chat that has never moved its own switch inherits.
      own: false,
      mode: 'goal',
      hasKey: true,
      model: 'deepseek/deepseek-v4-flash',
      objective: '',
      blocked: ''
    });
    expect(reply.body.context).toMatchObject({ auto: expect.any(Boolean) });

    // Read-only: the switches still change through the POST and nowhere else.
    await saveConfig({
      ...defaultConfig(),
      sessions: { ...defaultConfig().sessions, record: true },
      goal: { ...defaultConfig().goal, enabled: false }
    });
    expect((await request('GET', '/settings')).body.goal.enabled).toBe(false);
    expect((await request('GET', '/settings', { auth: null })).status).toBe(401);
  });

  /** Same credential rule as everywhere else on this server. */
  it('refuses every goal route without the bearer token', async () => {
    await pair();
    const routes: Array<[string, Record<string, unknown>]> = [
      ['/goal/draft', { conversationId: 'cafe0003-0000-4000-8000-000000000003', turnId: 'g-1' }],
      ['/goal/ack', { conversationId: 'cafe0003-0000-4000-8000-000000000003', token: 'x' }],
      ['/goal/objective', { conversationId: 'cafe0003-0000-4000-8000-000000000003', text: 'finish it' }],
      ['/goal/open', { text: 'finish it' }],
      ['/settings', { goal: true }]
    ];
    for (const [route, body] of routes) {
      const reply = await request('POST', route, { body, auth: null });
      expect(reply.status, route).toBe(401);
    }
  });
});

// ------------------------------------------------------------------ shutdown

describe('shutting the listener down', () => {
  it('drains a request that was still in flight instead of waiting out the force timeout', async () => {
    // Node hands `close()` the connections it already has and waits for them to end. A
    // request that is *mid-flight* at that moment is not idle, so the one
    // `closeIdleConnections()` sweep at stop time cannot see it — and once its response
    // finishes the socket goes back to keep-alive idle, where nothing looks again. The
    // extension polls constantly, so on a real quit that socket was almost always mid-request,
    // and every quit sat for the full 15s force: long enough to look like the app has hung.
    await pair();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const payload = Buffer.from(JSON.stringify({ conversationId: 'cafe0009-0000-4000-8000-000000000009', events: [] }), 'utf8');

    const answered = new Promise<number>((resolve, reject) => {
      const req = http.request(
        `${base}/events`,
        {
          method: 'POST',
          agent,
          headers: {
            origin: EXTENSION_ORIGIN,
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'x-extension-protocol': String(BRIDGE_PROTOCOL),
            'content-length': String(payload.length)
          }
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        }
      );
      req.on('error', reject);
      // Headers and half the body only: the handler is now parked inside readBody.
      req.write(payload.subarray(0, payload.length - 1));
      setTimeout(() => req.end(payload.subarray(payload.length - 1)), 150);
    });

    // Give the server time to accept the connection and start reading.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    await stopBridge();
    const elapsed = Date.now() - started;

    expect(await answered).toBe(200);
    agent.destroy();
    // The drain is real — it waited for the request — but it ends with the request, not with
    // the force timer 15s later.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(3_000);

    const restarted = await startBridge();
    expect(restarted).not.toBeNull();
    base = `http://127.0.0.1:${restarted}`;
  });
});
