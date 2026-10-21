/**
 * #1402 through the real bridge: an attributed tool result in a turn that has run past
 * `ui.rotateTurnMinutes` files exactly one automatic continue into that turn; a younger turn,
 * a Pro turn and the result of a Goal/Loop hold tool get none.
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
const { resetBridgeForTests, setRotationHoldForTests, shutdownBridge, startBridge, sessionInputActivity } = await import('../src/main/bridge.js');
const { getSession } = await import('../src/main/session/store.js');
const { flushDurable, initDurableStore, writeDurableSoon } = await import('../src/main/durable.js');
const { findSessionByConversation, initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { recordToolCall, resetRecorderForTests } = await import('../src/main/session/recorder.js');
const { listInputs, resetInputForTests } = await import('../src/main/session/input.js');
const { resetTurnRotationForTests } = await import('../src/main/turn-rotation.js');
const { openCallHold, resetCallHoldsForTests } = await import('../src/main/rotation-hold.js');
const logger = await import('../src/main/logger.js');
const { setGoalSwitchNow, resetGoalStateForTests } = await import('../src/main/goal.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const MINUTE = 60_000;

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

async function events(chat: string, items: unknown[]): Promise<any> {
  const reply = await request('POST', '/events', { body: { conversationId: chat, events: items } });
  expect(reply.status).toBe(200);
  return reply.body;
}

/**
 * One attributed call as the MCP kernel answers it: recorded while its answer is still held, then
 * answered. Returns the answer's release, which waits for any continue the call was held for.
 */
async function heldCall(chat: string, hold = true, tool = 'read'): Promise<() => Promise<void>> {
  const requestId = `rotation_trace_${++requestSerial}`;
  await events(chat, [{ kind: 'tool_evidence', time: Date.now(),
    calls: [{ messageId: `m-${requestSerial}`, tool, order: 0, answered: false, requestId }] }]);
  const close = hold ? openCallHold(chat) : async () => undefined;
  await recordToolCall({ tool, args: { paths: ['/project/a.ts'] }, content: [{ type: 'text', text: 'ok' }],
    outcome: 'ok', durationMs: 1, startedAt: Date.now(), requestId });
  return close;
}

async function attributedCall(chat: string, tool = 'read'): Promise<void> {
  const answer = (await heldCall(chat, true, tool))();
  // The page takes no continue in these tests: the held answer goes out once the wait gives up.
  await answer;
}

async function turnFor(chat: string, turnId: string, ageMinutes: number, model = 'GPT-6 Sol'): Promise<string> {
  await events(chat, [
    { kind: 'model_selection', model, reasoningEffort: 'high', time: Date.now() - ageMinutes * MINUTE },
    { kind: 'turn_start', time: Date.now() - ageMinutes * MINUTE, turnId }
  ]);
  const session = await findSessionByConversation(chat);
  expect(session?.activeTurnId).toBe(turnId);
  return session!.id;
}

/** The fire-and-forget rotation settles within the serial outbox; give it a few ticks. */
async function rotationsFor(sessionId: string): Promise<Array<{ turnId?: string; text: string }>> {
  await new Promise(resolve => setTimeout(resolve, 150));
  return (await listInputs()).filter(row => row.sessionId === sessionId && row.purpose === 'rotation')
    .map(row => ({ turnId: row.queuedTurn?.turnId, text: row.text }));
}

beforeAll(async () => {
  dir = await makeTempDir('clf-bridge-rotation-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  const config = defaultConfig();
  await saveConfig({ ...config, sessions: { ...config.sessions, record: true } });
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
  resetInputForTests();
  resetTurnRotationForTests();
  resetCallHoldsForTests();
  setRotationHoldForTests(200);
  resetGoalStateForTests();
  writeDurableSoon('bridge-commands', null);
  await flushDurable();
  await setSecret('bridgeToken', '');
  token = null;
  await pair();
});

describe('turn rotation (#1402)', () => {
  it('files one automatic continue into a turn older than 30 minutes, after its tool result', async () => {
    const chat = 'f0f00003-1111-4111-8111-000000000001';
    const sessionId = await turnFor(chat, 'g-rot-old-1', 31);
    await attributedCall(chat);
    const rows = await rotationsFor(sessionId);
    expect(rows).toEqual([{ turnId: 'g-rot-old-1', text: expect.stringContaining('Continue the task from where you are.') }]);
    await attributedCall(chat);
    expect(await rotationsFor(sessionId)).toHaveLength(1);
  });

  it('leaves a younger turn alone', async () => {
    const chat = 'f0f00003-1111-4111-8111-000000000002';
    const sessionId = await turnFor(chat, 'g-rot-young-1', 10);
    await attributedCall(chat);
    expect(await rotationsFor(sessionId)).toEqual([]);
  });

  it('leaves Pro turns alone, which think long on purpose', async () => {
    const chat = 'f0f00003-1111-4111-8111-000000000003';
    const sessionId = await turnFor(chat, 'g-rot-pro-1', 45, 'GPT-6 Pro');
    await attributedCall(chat);
    expect(await rotationsFor(sessionId)).toEqual([]);
  });

  // 2.1.43 (user, 2026-10-19): a long step of a Goal or Loop run breaks like any other long turn.
  // A rotated turn ends without a final answer, so Goal and Loop decide only at the fresh turn's end.
  it.each(['goal', 'loop'] as const)('continues a long turn of a chat with %s on in a fresh turn too', async (which) => {
    const chat = `f0f00003-1111-4111-8111-00000000000${which === 'goal' ? 4 : 6}`;
    const sessionId = await turnFor(chat, `g-rot-${which}-1`, 31);
    await setGoalSwitchNow(chat, which, true);
    await attributedCall(chat);
    expect(await rotationsFor(sessionId)).toEqual([{ turnId: `g-rot-${which}-1`, text: expect.stringContaining('Continue the task from where you are.') }]);
  });

  // Loop's Session Finish answers with the next instruction: a continue after it would be a second one.
  it.each(['session_finish', 'keep_astra_on_forever'])('never rotates at the result of the hold tool %s', async (tool) => {
    const chat = `f0f00003-1111-4111-8111-0000000000${tool === 'session_finish' ? 21 : 22}`;
    const sessionId = await turnFor(chat, `g-rot-hold-${tool}`, 31);
    await setGoalSwitchNow(chat, 'loop', true);
    await attributedCall(chat, tool);
    expect(await rotationsFor(sessionId)).toEqual([]);
  });

  it('lets the next message go once the fresh turn after a rotation answers', async () => {
    // The page reports a rotation as one batch: the rotated turn's end, the fresh turn's start
    // and the continue. A batch with an end never moved the activity grant to the new turn, and
    // the fresh turn's later work renewed it under the rotated turn's id. The fresh turn's final
    // then spent nothing, so the chat looked busy and a message typed after the answer was held
    // behind the rotated turn for 163 s (2.1.40 release round, Windows).
    const chat = 'f0f00003-1111-4111-8111-000000000007';
    const sessionId = await turnFor(chat, 'g-rot-follow-0-1', 31);
    await attributedCall(chat);
    const at = Date.now();
    await events(chat, [
      { kind: 'turn_end', time: at, turnId: 'g-rot-follow-0-1', outcome: 'interrupted' },
      { kind: 'turn_start', time: at + 1, turnId: 'g-rot-follow-0-2' },
      { kind: 'user_message', time: at + 2, turnId: 'g-rot-follow-0-2', messageId: 'rot-follow-continue', text: 'Continue the task from where you are.' }
    ]);
    await events(chat, [{ kind: 'page_tool', time: at + 3, turnId: 'g-rot-follow-0-2', label: 'Read file', messageId: 'rot-follow-tool' }]);
    await events(chat, [{ kind: 'assistant_message', time: at + 4, turnId: 'g-rot-follow-0-2', messageId: 'rot-follow-final', text: 'All steps are done.', state: 'final', final: true }]);
    await events(chat, [{ kind: 'turn_end', time: at + 5, turnId: 'g-rot-follow-0-2', outcome: 'completed' }]);
    await new Promise(resolve => setTimeout(resolve, 50));
    // Before the fix this still read as exact work on the rotated turn g-rot-follow-0-1.
    expect(sessionInputActivity((await getSession(sessionId))!)).toMatchObject({ exact: false, possible: false });
  });

  // #1662: sent into the gap after a call's result, ChatGPT sometimes queued the continue behind its
  // answer and never answered it. The continue now goes in only while the call it is due at is still
  // being answered: the app holds that call's answer until the page has sent the continue.
  it('holds the due call\'s answer until the page has sent the continue into the turn', async () => {
    setRotationHoldForTests(5_000);
    const chat = 'f0f00003-1111-4111-8111-000000000201';
    const sessionId = await turnFor(chat, 'g-rot-hold-1', 31);
    let answered = false;
    const answer = (await heldCall(chat))().then(() => { answered = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    const row = (await listInputs()).find(entry => entry.sessionId === sessionId && entry.purpose === 'rotation')!;
    expect(row).toBeDefined();
    expect(answered).toBe(false);
    const page = { id: row.id, owner: 'rotation-page', conversationId: chat };
    expect((await request('POST', '/input/claim', { body: { ...page, requiresAuthorization: true } })).body.input).toMatchObject({ id: row.id });
    expect((await request('POST', '/input/claim', { body: { ...page, authorize: true } })).body).toEqual({ ok: true });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(answered).toBe(false);
    expect((await request('POST', '/input/ack', { body: { ...page, messageId: 'rotation-continue-1' } })).body).toEqual({ ok: true });
    await answer;
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('sent');
  });

  it('answers the call and withdraws the continue without a notice when the page does not take it in time', async () => {
    const chat = 'f0f00003-1111-4111-8111-000000000202';
    const sessionId = await turnFor(chat, 'g-rot-hold-2', 31);
    const started = Date.now();
    await (await heldCall(chat))();
    expect(Date.now() - started).toBeLessThan(2_000);
    const row = (await listInputs()).find(entry => entry.sessionId === sessionId && entry.purpose === 'rotation')!;
    expect(row.state).toBe('cancelled');
    expect(row.error).toBeUndefined();
    // A page that claims it now is refused: it would send into the gap after the call's result.
    expect((await request('POST', '/input/claim', { body: { id: row.id, owner: 'late-page', conversationId: chat, requiresAuthorization: true } })).body.input).toBeNull();
  });

  // 2026-10-21, Loop chats on Windows: twice a continue was withdrawn with only "the page did not
  // send it". Whether the page never picked it up (its browser worker had stopped answering) or
  // picked it up and never reached Send are different faults; the log line now says which.
  it('says in the log that the page never picked the continue up, and whether the browser was connected', async () => {
    const logged = vi.spyOn(logger, 'logInfo');
    try {
      const chat = 'f0f00003-1111-4111-8111-000000000205';
      await turnFor(chat, 'g-rot-hold-5', 31);
      await (await heldCall(chat))();
      const lines = logged.mock.calls.map(([line]) => String(line)).filter(line => line.includes(chat) && line.includes('within'));
      expect(lines).toEqual([expect.stringContaining('the page did not pick up the continue within 0 s (the browser is not connected)')]);
    } finally { logged.mockRestore(); }
  });

  it('says in the log that the page picked the continue up but did not reach Send', async () => {
    setRotationHoldForTests(400);
    const logged = vi.spyOn(logger, 'logInfo');
    try {
      const chat = 'f0f00003-1111-4111-8111-000000000206';
      const sessionId = await turnFor(chat, 'g-rot-hold-6', 31);
      const answer = (await heldCall(chat))();
      await new Promise(resolve => setTimeout(resolve, 100));
      const row = (await listInputs()).find(entry => entry.sessionId === sessionId && entry.purpose === 'rotation')!;
      expect((await request('POST', '/input/claim', { body: { id: row.id, owner: 'slow-page', conversationId: chat, requiresAuthorization: true } })).body.input).toMatchObject({ id: row.id });
      await answer;
      const lines = logged.mock.calls.map(([line]) => String(line)).filter(line => line.includes(chat) && line.includes('within'));
      expect(lines).toEqual([expect.stringContaining('the page picked up the continue but did not reach Send within 0 s')]);
    } finally { logged.mockRestore(); }
  });

  // 2026-10-20: when ChatGPT shows Stop it offers no Send for the continue; the page says so at
  // once instead of the call's answer waiting out the hold.
  it('answers the call at once when the page declines the continue for want of Send', async () => {
    setRotationHoldForTests(5_000);
    const chat = 'f0f00003-1111-4111-8111-000000000204';
    const sessionId = await turnFor(chat, 'g-rot-hold-4', 31);
    let answered = false;
    const answer = (await heldCall(chat))().then(() => { answered = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    const row = (await listInputs()).find(entry => entry.sessionId === sessionId && entry.purpose === 'rotation')!;
    const page = { id: row.id, owner: 'rotation-page', conversationId: chat };
    expect((await request('POST', '/input/claim', { body: { ...page, requiresAuthorization: true } })).body.input).toMatchObject({ id: row.id });
    const started = Date.now();
    expect((await request('POST', '/input/fail', { body: { ...page, error: 'Fresh-turn continue declined: no Send while ChatGPT works.', detail: 'no-send' } })).body).toEqual({ ok: true });
    await answer;
    expect(answered).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_500);
    // Cancelled like one that timed out, with no error: the chat shows nothing for it.
    const declined = (await listInputs()).find(entry => entry.id === row.id)!;
    expect(declined.state).toBe('cancelled');
    expect(declined.error).toBeUndefined();
  });

  it('files no continue for a call whose answer has already gone out', async () => {
    const chat = 'f0f00003-1111-4111-8111-000000000203';
    const sessionId = await turnFor(chat, 'g-rot-hold-3', 31);
    await (await heldCall(chat, false))();
    expect(await rotationsFor(sessionId)).toEqual([]);
  });

  it('is off at 0 minutes', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, sessions: { ...config.sessions, record: true }, ui: { ...config.ui, rotateTurnMinutes: 0 } });
    try {
      const chat = 'f0f00003-1111-4111-8111-000000000005';
      const sessionId = await turnFor(chat, 'g-rot-off-1', 90);
      await attributedCall(chat);
      expect(await rotationsFor(sessionId)).toEqual([]);
    } finally {
      await saveConfig({ ...config, sessions: { ...config.sessions, record: true } });
    }
  });
});

/**
 * Opt-in fallback (user, 2026-10-20): where ChatGPT offers no Send for the continue at a tool
 * result (it shows only Stop there), the app stops the turn right after a result instead and sends
 * the continue as an ordinary message once the stop shows. Loop stays on, and a call that arrives
 * while the stop lands is refused rather than run, so no command can run twice.
 */
const { armRotationFence, rotationFenced } = await import('../src/main/rotation-fence.js');
const { goalSwitchFor } = await import('../src/main/goal.js');
const { rotationMessage } = await import('../src/shared/recovery.js');
describe('stop fallback for fresh turns', () => {

  async function declineTwice(chat: string, sessionId: string, clock: { now: number }): Promise<void> {
    for (let round = 0; round < 2; round += 1) {
      const answer = (await heldCall(chat))();
      await new Promise(resolve => setTimeout(resolve, 150));
      const row = (await listInputs()).find(entry => entry.sessionId === sessionId && entry.purpose === 'rotation' && entry.state === 'queued')!;
      const page = { id: row.id, owner: 'rotation-page', conversationId: chat };
      expect((await request('POST', '/input/claim', { body: { ...page, requiresAuthorization: true } })).body.input).toMatchObject({ id: row.id });
      await request('POST', '/input/fail', { body: { ...page, error: 'Fresh-turn continue declined: no Send while ChatGPT works.', detail: 'no-send' } });
      await answer;
      clock.now += 61_000;
    }
  }

  it('stops after a result once ChatGPT offered no Send twice, keeps Loop on, and continues after the stopped end', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, sessions: { ...config.sessions, record: true }, ui: { ...config.ui, rotateStopFallback: true } });
    setRotationHoldForTests(5_000);
    const clock = { now: Date.now() };
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    try {
      const chat = 'f0f00003-1111-4111-8111-000000000401', turn = 'g-stopfb-0-1';
      const sessionId = await turnFor(chat, turn, 31);
      await setGoalSwitchNow(chat, 'loop', true);
      await declineTwice(chat, sessionId, clock);
      const before = (await listInputs()).filter(entry => entry.sessionId === sessionId && entry.purpose === 'rotation').length;
      await (await heldCall(chat))();
      await new Promise(resolve => setTimeout(resolve, 900));
      // No third continue into the turn: a Stop for exactly this turn instead, and Loop still on.
      expect((await listInputs()).filter(entry => entry.sessionId === sessionId && entry.purpose === 'rotation').length).toBe(before);
      expect((await request('GET', '/status')).body.stopTurns).toEqual([expect.objectContaining({ conversationId: chat, turnId: turn })]);
      expect(rotationFenced(chat)).toBe(true);
      expect(goalSwitchFor(chat)).toMatchObject({ enabled: true, mode: 'loop' });
      // ChatGPT shows the turn stopped: the continue goes as an ordinary message, at once.
      await events(chat, [{ kind: 'turn_end', time: clock.now, turnId: turn, outcome: 'stopped' }]);
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(rotationFenced(chat)).toBe(false);
      const next = (await listInputs()).find(entry => entry.sessionId === sessionId && entry.purpose === 'rotation' && entry.afterStop === true)!;
      expect(next).toMatchObject({ state: 'queued', text: rotationMessage() });
      expect(next).not.toHaveProperty('directTurn');
      expect((await request('GET', '/status')).body.inputs.map((input: { id: string }) => input.id)).toContain(next.id);
    } finally { spy.mockRestore(); setRotationHoldForTests(15_000); await saveConfig({ ...config, sessions: { ...config.sessions, record: true } }); }
  });

  it('does none of it with the setting off', async () => {
    setRotationHoldForTests(1_000);
    const clock = { now: Date.now() };
    // Ticking, so the ordinary continue's hold can run out.
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => (clock.now += 5));
    try {
      const chat = 'f0f00003-1111-4111-8111-000000000402', turn = 'g-stopfb-0-2';
      const sessionId = await turnFor(chat, turn, 31);
      await declineTwice(chat, sessionId, clock);
      await (await heldCall(chat))();
      await new Promise(resolve => setTimeout(resolve, 900));
      expect((await request('GET', '/status')).body.stopTurns ?? []).toEqual([]);
      expect(rotationFenced(chat)).toBe(false);
    } finally { spy.mockRestore(); setRotationHoldForTests(15_000); }
  });

  it('gives the turn back when ChatGPT never shows the stop', async () => {
    vi.useFakeTimers();
    try {
      armRotationFence('f0f00003-1111-4111-8111-000000000403', 'g-stopfb-0-3');
      expect(rotationFenced('f0f00003-1111-4111-8111-000000000403')).toBe(true);
      vi.advanceTimersByTime(60_001);
      expect(rotationFenced('f0f00003-1111-4111-8111-000000000403')).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});
