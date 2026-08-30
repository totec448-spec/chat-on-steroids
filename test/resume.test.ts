/**
 * Compact & Resume, end to end through the bridge's HTTP surface.
 *
 * One session, two chats, and exactly one moment at which it moves. Every case here is a way
 * that move can go wrong — an interrupted brief, a replacement tab that never gets an id, a
 * second tab on the same marker, a restart in the middle — and the assertion is always the
 * same shape: either the session is fully in chat B, or it is still fully in chat A. There is
 * no third outcome, and in particular there is never a second replacement chat.
 *
 * The compaction *provider* is faked so its timing can be controlled. Everything else — the
 * bridge, the continuation transaction, the command queue, the session store and the browser
 * opener — is the real thing.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContinuationSnapshot } from '../src/main/session/continuation.js';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  clipboard: {},
  shell: {}
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath, setSecret } = await import('../src/main/secrets.js');
const { bridgePort, pendingCommands, resetBridgeForTests, resumeJobFor, setBrowserOpener, startBridge, stopBridge } =
  await import('../src/main/bridge.js');
const durable = await import('../src/main/durable.js');
const { flushDurable, initDurableStore, readDurable, writeDurableSoon } = durable;
const { getSession, initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { resetRecorderForTests, sessionForConversation } = await import('../src/main/session/recorder.js');
const { resetSwarm } = await import('../src/main/agents.js');
const {
  CONTINUATIONS_STATE,
  restoreContinuations
} = await import('../src/main/session/continuation.js');
const { makeTempDir, removeTempDir, SAMPLE_BRIEF } = await import('./helpers.js');
const { BRIDGE_PROTOCOL } = await import('../src/main/version.js');

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const CHAT_A = '6a805197-b090-83eb-bbd8-a32b482941da';
const CHAT_B = '7b916208-c1a1-94fc-cce9-b43c593a52eb';
const BRIEF = SAMPLE_BRIEF;

let dir: string;
let base: string;
let token: string | null = null;
/** Every URL the app asked the OS to open. */
const opened: string[] = [];

function request(
  method: string,
  path: string,
  options: { body?: unknown; auth?: string | null } = {}
): Promise<{ status: number; body: any }> {
  const url = new URL(path, base);
  const payload = options.body === undefined ? null : JSON.stringify(options.body);
  // Every route past /hello, /pair included, refuses a caller that does not declare the
  // protocol it speaks. The shipped extension always sends this; a test that omitted it was
  // failing pairing with 426 and then reading every later 401 as a bridge bug.
  const headers: Record<string, string> = {
    origin: EXTENSION_ORIGIN,
    'x-extension-protocol': String(BRIDGE_PROTOCOL)
  };
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
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
            // A non-JSON body is itself a finding.
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      }
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function connect(): Promise<void> {
  const reply = await request('POST', '/pair', { auth: null });
  token = reply.body.token as string;
}

/** Gives the bridge a recorded session for a chat, so /compact can find one. */
async function record(conversationId = CHAT_A): Promise<string> {
  const reply = await request('POST', '/events', {
    body: {
      conversationId,
      events: [{ kind: 'user_message', time: Date.now(), text: 'do the work', messageId: `m-${conversationId}` }]
    }
  });
  return reply.body.sessionId as string;
}

/** Presses the button: opens the continuation and returns its one-time token. */
async function press(conversationId = CHAT_A): Promise<{ token: string; prompt: string }> {
  const reply = await request('POST', '/compact', { body: { conversationId } });
  expect(reply.status).toBe(202);
  return { token: reply.body.token as string, prompt: reply.body.prompt as string };
}

/** Hands over the compaction turn's answer, the way the watching page does. */
function capture(token: string, summary = BRIEF, conversationId = CHAT_A) {
  return request('POST', '/compact', { body: { conversationId, token, summary } });
}

/** Redeems the queued replacement command as one page. */
function redeem(id: string, client: string) {
  return request('POST', '/commands/redeem', { body: { id, client } });
}

async function sessionHandoffCount(sessionId: string): Promise<number> {
  const entries = await fs.readdir(nodePath.join(dir, 'sessions', sessionId, 'handoffs')).catch(() => []);
  return entries.filter((name) => name.endsWith('.json')).length;
}

/** Lets the compaction promise's continuations run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => {
  dir = await makeTempDir('clf-resume-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  const baseConfig = defaultConfig();
  await saveConfig({ ...baseConfig, sessions: { ...baseConfig.sessions, record: true } });
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
  resetBridgeForTests();
  resetRecorderForTests();
  resetSessionStoreForTests();
  // Each case models one independent app history. Reusing CHAT_A/CHAT_B while retaining
  // prior cases on disk hid duplicate-target ownership bugs and made the safe rebind check
  // reject a later test for a session that only existed in an earlier test.
  await fs.rm(nodePath.join(dir, 'sessions'), { recursive: true, force: true });
  await fs.mkdir(nodePath.join(dir, 'sessions'), { recursive: true });
  resetSwarm();
  writeDurableSoon('bridge-commands', null);
  await flushDurable();
  await setSecret('bridgeToken', '');
  token = null;
  opened.length = 0;
  setBrowserOpener(async (url) => {
    opened.push(url);
  });
});

describe('the whole move, when it works', () => {
  it('carries the same local session from chat A to chat B and only then retires A', async () => {
    await connect();
    const sessionId = await record();
    const { token: continuation, prompt } = await press();
    // The instruction asks for the brief as the answer. There is no tool for the model to
    // call, which is the point: an answer cannot be retried into three different briefs.
    expect(prompt).toMatch(/handoff brief/i);
    expect(prompt).not.toMatch(/save_handoff/);

    const stored = await capture(continuation);
    expect(stored.status).toBe(200);
    expect(stored.body.stored).toBe(true);
    const commandId = stored.body.commandId as string;
    expect(commandId).toBeTruthy();

    // Nothing has moved yet. The session is still entirely in chat A, because chat B does
    // not exist: the brief only means the app now knows what to type into it.
    expect(await sessionForConversation(CHAT_A)).toBe(sessionId);
    expect((await getSession(sessionId))?.conversationId).toBe(CHAT_A);

    const handed = await redeem(commandId, 'page-1');
    expect(handed.body.command.text).toContain(BRIEF);

    const acked = await request('POST', '/commands/ack', {
      body: { id: commandId, status: 'sent', conversationId: CHAT_B }
    });
    expect(acked.body.committed).toBe(true);

    // One session, now in B, with both chats in its lineage and its context meter reset.
    const summary = await getSession(sessionId);
    expect(summary?.conversationId).toBe(CHAT_B);
    expect(summary?.chatIds).toEqual([CHAT_A, CHAT_B]);
    expect(summary?.contextTokens).toBe(0);
    expect(await sessionForConversation(CHAT_B)).toBe(sessionId);
    // A is historical: it is in the lineage, and it no longer resolves to the live session.
    expect(await sessionForConversation(CHAT_A)).not.toBe(sessionId);
    // And exactly one brief was ever written for it.
    expect(await sessionHandoffCount(sessionId)).toBe(1);
  });

  it('opens exactly one chat, and only after a brief exists', async () => {
    await connect();
    await record();
    const { token: continuation } = await press();
    expect(pendingCommands()).toHaveLength(0);
    expect(opened).toHaveLength(0);

    await capture(continuation);
    expect(pendingCommands()).toHaveLength(1);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain('clf=');
  });
});

describe('a brief that never really arrived', () => {
  it('opens nothing when the compaction turn produced nothing', async () => {
    await connect();
    const sessionId = await record();
    const { token: continuation } = await press();
    const empty = await capture(continuation, '   ');
    expect(empty.status).toBe(409);
    expect(pendingCommands()).toHaveLength(0);
    expect(opened).toHaveLength(0);
    expect(await sessionForConversation(CHAT_A)).toBe(sessionId);
  });

  it('keeps an incomplete brief retryable until rejecting it is durably recorded', async () => {
    await connect();
    const sessionId = await record();
    const { token: continuation } = await press();
    vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('continuation abort disk full'));

    // Rejecting an empty/incomplete handoff also aborts the continuation. If that abort does
    // not cross the WAL, the page must retain the exact captured bytes and retry instead of
    // treating the semantic 409 as terminal and forgetting the only thing that can finish or
    // withdraw this transaction.
    const failed = await capture(continuation, '   ');
    expect(failed.status).toBe(503);
    expect(failed.body).toMatchObject({ error: 'resume_cancel_not_durable', retryable: true });
    expect(pendingCommands()).toHaveLength(0);
    expect(await sessionForConversation(CHAT_A)).toBe(sessionId);

    // Once the durable abort succeeds, the same captured bytes receive the terminal semantic
    // refusal and the page is free to discard them.
    const retried = await capture(continuation, '   ');
    expect(retried.status).toBe(409);
    expect(retried.body.error).toBe('brief_incomplete');
    expect(pendingCommands()).toHaveLength(0);
    expect(await sessionForConversation(CHAT_A)).toBe(sessionId);
  });

  it('opens nothing when the page cancelled instead, and lets the user start again', async () => {
    await connect();
    const sessionId = await record();
    const { token: first } = await press();
    const cancelled = await request('POST', '/compact', { body: { conversationId: CHAT_A, cancel: true } });
    expect(cancelled.body.cancelled).toBe(true);

    // The interrupted turn's text turning up late must land nowhere at all.
    const late = await capture(first, 'the brief the model was still writing');
    expect(late.status).toBe(409);
    expect(pendingCommands()).toHaveLength(0);
    expect(await sessionForConversation(CHAT_A)).toBe(sessionId);

    // And the button works again, as a new transaction with a new token.
    const { token: second } = await press();
    expect(second).not.toBe(first);
    expect((await capture(second)).status).toBe(200);
  });

  // The load-bearing refusal: a brief is only a brief because it came back with the token
  // that was issued for the turn that was asked for it.
  it('refuses text quoting no token, a wrong token, or another chat’s token', async () => {
    await connect();
    await record();
    await record(CHAT_B);
    const { token: mine } = await press();

    expect((await request('POST', '/compact', { body: { conversationId: CHAT_A, summary: BRIEF } })).status).toBe(409);
    expect((await capture('not-a-real-token')).status).toBe(409);
    // The right token, but presented from the chat it does not belong to.
    expect((await capture(mine, BRIEF, CHAT_B)).status).toBe(409);
    expect(pendingCommands()).toHaveLength(0);
  });
});

describe('one press, one transaction', () => {
  // The two crash points either side of the click, which the durable fence exists to tell
  // apart. A page that died holding the claim provably submitted nothing; a page that died
  // after arming may have submitted, and no local evidence can decide it.
  it('re-offers the prompt to a replacement document that died holding the claim', async () => {
    await connect();
    await record();
    const first = await press();
    const again = await request('POST', '/compact', { body: { conversationId: CHAT_A } });
    expect(again.status).toBe(202);
    expect(again.body.token).toBe(first.token);
    expect(again.body.started).toBe(false);
    expect(again.body.prompt).toContain(`[[CLF-HANDOFF:${first.token}]]`);

    const claimed = await request('POST', '/compact', {
      body: { conversationId: CHAT_A, token: first.token, sourceAttempt: true }
    });
    expect(claimed.body.allowed).toBe(true);
    expect(claimed.body.sourceSend.state).toBe('attempted-unresolved');

    // The document is gone here, between the claim and the click. Nothing reached ChatGPT,
    // so the same transaction is handed to the next document rather than stranded.
    const replacement = await request('POST', '/compact', { body: { conversationId: CHAT_A } });
    expect(replacement.status).toBe(202);
    expect(replacement.body.token).toBe(first.token);
    expect(replacement.body.prompt).toContain(`[[CLF-HANDOFF:${first.token}]]`);
    const reclaimed = await request('POST', '/compact', {
      body: { conversationId: CHAT_A, token: first.token, sourceAttempt: true }
    });
    expect(reclaimed.body.allowed).toBe(true);
  });

  it('never re-offers the prompt once a document armed the click', async () => {
    await connect();
    await record();
    const first = await press();
    await request('POST', '/compact', {
      body: { conversationId: CHAT_A, token: first.token, sourceAttempt: true }
    });
    const armed = await request('POST', '/compact', {
      body: { conversationId: CHAT_A, token: first.token, sourceDispatch: true }
    });
    expect(armed.status).toBe(200);
    expect(armed.body.armed).toBe(true);

    // The document is gone here, after the click was armed and before ChatGPT's acceptance
    // was ever observed. The prompt may be with ChatGPT; it is never typed a second time.
    const afterArming = await request('POST', '/compact', { body: { conversationId: CHAT_A } });
    expect(afterArming.status).toBe(200);
    expect(afterArming.body.prompt).toBeNull();
    expect(afterArming.body.sourceSend.state).toBe('dispatched-unresolved');
    const reclaim = await request('POST', '/compact', {
      body: { conversationId: CHAT_A, token: first.token, sourceAttempt: true }
    });
    expect(reclaim.body.allowed).toBe(false);
  });

  it('lets exactly one of two live documents arm the same claim', async () => {
    await connect();
    await record();
    const first = await press();
    // Both pages composed the prompt and both hold the claim: that state promises only that
    // neither has submitted yet.
    for (const _ of [0, 1]) {
      const claimed = await request('POST', '/compact', {
        body: { conversationId: CHAT_A, token: first.token, sourceAttempt: true }
      });
      expect(claimed.body.allowed).toBe(true);
    }
    const first_click = await request('POST', '/compact', {
      body: { conversationId: CHAT_A, token: first.token, sourceDispatch: true }
    });
    const second_click = await request('POST', '/compact', {
      body: { conversationId: CHAT_A, token: first.token, sourceDispatch: true }
    });
    expect(first_click.body.armed).toBe(true);
    expect(second_click.status).toBe(409);
    expect(second_click.body.error).toBe('source_send_reclaimed');
  });

  it('stores one brief for a retried capture and never a second', async () => {
    await connect();
    const sessionId = await record();
    const before = await sessionHandoffCount(sessionId);
    const { token: continuation } = await press();

    const [one, two] = await Promise.all([capture(continuation), capture(continuation)]);
    const three = await capture(continuation, 'the same brief, typed out again');
    expect(one.body.handoffId).toBe(two.body.handoffId);
    expect(three.body.handoffId).toBe(one.body.handoffId);
    expect((await sessionHandoffCount(sessionId)) - before).toBe(1);
    // And one replacement chat, not three.
    expect(pendingCommands()).toHaveLength(1);
    expect(opened).toHaveLength(1);
  });

  it('reports a rejected handoff WAL write as retryable while the continuation still awaits its brief', async () => {
    await connect();
    await record();
    const { token: continuation } = await press();
    vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('continuation state disk full'));

    const failed = await capture(continuation);
    expect(failed.status).toBe(503);
    expect(failed.body).toMatchObject({ error: 'brief_not_stored', retryable: true });
    expect(pendingCommands()).toHaveLength(0);

    const retried = await capture(continuation);
    expect(retried.status).toBe(200);
    expect(retried.body.stored).toBe(true);
    expect(pendingCommands()).toHaveLength(1);
  });
});

describe('a brief longer than the app can type', () => {
  /**
   * A brief is written TASK first and NEXT / DO NOT last, so the end of it is the part the
   * fresh chat acts on. Cutting the tail off would hand chat B pages of history with the
   * instructions for what to do about them deleted — and nothing in the text saying so.
   */
  it('keeps both ends of an over-long brief, and says where the middle went', async () => {
    await connect();
    await record();
    const { token: continuation } = await press();

    const head = 'TASK — finish the bridge rewrite.\n';
    const middle = 'FILES — src/main/bridge.ts, and a great many others.\n'.repeat(6000);
    const tail = 'NEXT — run the full suite.\nDO NOT — rebuild or reload anything.';
    const huge = head + middle + tail;
    expect(huge.length).toBeGreaterThan(256_000);

    const stored = await capture(continuation, huge);
    expect(stored.status).toBe(200);
    const commandId = stored.body.commandId as string;
    const text = (await redeem(commandId, 'page-1')).body.command.text as string;

    expect(text).toContain('TASK — finish the bridge rewrite.');
    expect(text).toContain('NEXT — run the full suite.');
    expect(text).toContain('DO NOT — rebuild or reload anything.');
    // And the cut is in the brief where the model reading it will see it, not silent.
    expect(text).toMatch(/left out/);
    expect(text.length).toBeLessThan(huge.length);
  });

  it('carries a large near-budget handoff without a hidden character-budget truncation', async () => {
    await connect();
    await record();
    const { token: continuation } = await press();
    const brief = `TASK — keep all of this.\n${'dense operational detail '.repeat(6500)}\nNEXT — continue exactly here.`;
    expect(brief.length).toBeGreaterThan(150_000);
    expect(brief.length).toBeLessThan(256_000);

    const stored = await capture(continuation, brief);
    const commandId = stored.body.commandId as string;
    const text = (await redeem(commandId, 'page-long')).body.command.text as string;

    expect(text).toContain(brief);
    expect(text).not.toMatch(/middle of this brief.*left out/);
  });
});

describe('the replacement chat', () => {
  // Two pages on one marker is the shape every duplicate-tab failure takes: a reload
  // restored into a new document, "reopen closed tab", a link opened twice.
  it('can move documents until a page arms the click, and never after it', async () => {
    await connect();
    await record();
    const { token: continuation } = await press();
    const commandId = (await capture(continuation)).body.commandId as string;

    const first = await redeem(commandId, 'page-1');
    expect(first.body.command.text).toContain(BRIEF);

    const second = await redeem(commandId, 'page-2');
    expect(second.status).toBe(200);
    expect(second.body.command.text).toContain(BRIEF);

    // Claimed, then gone before the click — the same crash point as the source half, and the
    // same answer: nothing was typed under this state, so the next document may have it.
    const claimed = await request('POST', '/compact', {
      body: { token: continuation, destinationAttempt: true }
    });
    expect(claimed.body.allowed).toBe(true);
    const afterClaim = await redeem(commandId, 'page-3');
    expect(afterClaim.status).toBe(200);
    expect(afterClaim.body.command.text).toContain(BRIEF);

    // Armed. This bootstrap may exist in a chat this app cannot yet name, so it is never
    // handed to another document; only the marked message can resolve it.
    const armed = await request('POST', '/compact', {
      body: { token: continuation, destinationDispatch: true }
    });
    expect(armed.body.armed).toBe(true);
    expect((await redeem(commandId, 'page-3')).status).toBe(409);
    expect((await redeem(commandId, 'page-4')).status).toBe(409);
    expect(
      (await request('POST', '/compact', { body: { token: continuation, destinationAttempt: true } })).body.allowed
    ).toBe(false);
  });

  /**
   * A failed bootstrap ends the attempt rather than leaving it queued for another tab.
   * The page has already opened a chat and typed into it by the time it can report this,
   * so a retry would be a second fresh chat racing the first. The session stays in A and
   * the user presses again when they are ready.
   */
  it('leaves the session in chat A when the bootstrap could not be sent', async () => {
    await connect();
    const sessionId = await record();
    const { token: continuation } = await press();
    const commandId = (await capture(continuation)).body.commandId as string;
    await redeem(commandId, 'page-1');

    await request('POST', '/commands/ack', {
      body: { id: commandId, status: 'failed', error: 'the composer already holds a draft' }
    });

    expect(await sessionForConversation(CHAT_A)).toBe(sessionId);
    expect((await getSession(sessionId))?.conversationId).toBe(CHAT_A);
    expect(pendingCommands()).toHaveLength(0);
  });

  it('leaves the session in chat A when the new chat never revealed its id', async () => {
    await connect();
    const sessionId = await record();
    const { token: continuation } = await press();
    const commandId = (await capture(continuation)).body.commandId as string;
    await redeem(commandId, 'page-1');

    // Sent, but ChatGPT never gave the tab a /c/<id>. There is nothing to move the session
    // to. That is retryable rather than a terminal "success=false": the same page may learn
    // its id a moment later, and only a final durable receipt is allowed to return 2xx.
    const acked = await request('POST', '/commands/ack', {
      body: { id: commandId, status: 'sent', client: 'page-1' }
    });
    expect(acked.status).toBe(503);
    expect(acked.body).toMatchObject({ error: 'conversation_required', retryable: true });
    expect(pendingCommands()).toHaveLength(1);
    expect(await sessionForConversation(CHAT_A)).toBe(sessionId);
    expect((await getSession(sessionId))?.conversationId).toBe(CHAT_A);
  });

  it('refuses to move a session into the chat it is already in', async () => {
    await connect();
    const sessionId = await record();
    const { token: continuation } = await press();
    const commandId = (await capture(continuation)).body.commandId as string;
    await redeem(commandId, 'page-1');

    const acked = await request('POST', '/commands/ack', {
      body: { id: commandId, status: 'sent', conversationId: CHAT_A }
    });
    expect(acked.body.committed).toBe(false);
    expect((await getSession(sessionId))?.conversationId).toBe(CHAT_A);
  });

  it('commits once, so a repeated ack cannot move the session again', async () => {
    await connect();
    const sessionId = await record();
    const { token: continuation } = await press();
    const commandId = (await capture(continuation)).body.commandId as string;
    await redeem(commandId, 'page-1');
    const first = await request('POST', '/commands/ack', {
      body: { id: commandId, status: 'sent', conversationId: CHAT_B, client: 'page-1' }
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, final: true, committed: true });

    // A lost HTTP response is answered from the durable tombstone, with the exact same result.
    const repeat = await request('POST', '/commands/ack', {
      body: { id: commandId, status: 'sent', conversationId: CHAT_B, client: 'page-1' }
    });
    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({ ok: true, final: true, committed: true, conversationId: CHAT_B });

    // The receipt is bound to the document and conversation. A different chat cannot reuse it
    // to turn idempotency into a second ownership claim.
    const conflict = await request('POST', '/commands/ack', {
      body: { id: commandId, status: 'sent', conversationId: 'c-somewhere-else', client: 'page-1' }
    });
    expect(conflict.status).toBe(409);
    expect((await getSession(sessionId))?.conversationId).toBe(CHAT_B);
  });
});

describe('a restart in the middle', () => {
  it('restores the leased resume transport without opening a second replacement chat', async () => {
    await connect();
    const sessionId = await record();
    const { token: continuation } = await press();
    const commandId = (await capture(continuation)).body.commandId as string;
    await redeem(commandId, 'page-1');
    expect(pendingCommands()).toHaveLength(1);
    await flushDurable();
    const continuationSnapshot = await readDurable<ContinuationSnapshot>(CONTINUATIONS_STATE);
    expect(continuationSnapshot).not.toBeNull();

    const { restoreCommands } = await import('../src/main/bridge.js');
    resetBridgeForTests();
    opened.length = 0;
    setBrowserOpener(async (url) => {
      opened.push(url);
    });
    await restoreContinuations(continuationSnapshot);
    await restoreCommands();

    expect(pendingCommands()).toHaveLength(1);
    // Replaying the same queue request (what startup worker/resume reconciliation may do) must
    // find the durable lease and therefore must not spend a second browser-open attempt.
    const { queueResume } = await import('../src/main/bridge.js');
    queueResume(sessionId, continuation);
    await settle();
    expect(opened).toEqual([]);

    const acked = await request('POST', '/commands/ack', {
      body: { id: commandId, status: 'sent', conversationId: CHAT_B, client: 'page-1' }
    });
    expect(acked.status).toBe(200);
    expect(acked.body).toMatchObject({ final: true, committed: true });
    expect(pendingCommands()).toHaveLength(0);
    expect((await getSession(sessionId))?.conversationId).toBe(CHAT_B);
    expect(await sessionForConversation(CHAT_A)).not.toBe(sessionId);
  });
});

describe('the job the page polls', () => {
  it('reports the transaction stages and stops being busy once it is done', async () => {
    await connect();
    const sessionId = await record();
    const { token: continuation } = await press();
    expect(resumeJobFor(sessionId)).toMatchObject({ stage: 'handoff-pending', busy: true });

    const commandId = (await capture(continuation)).body.commandId as string;
    expect(resumeJobFor(sessionId)?.busy).toBe(true);

    await redeem(commandId, 'page-1');
    await request('POST', '/commands/ack', {
      body: { id: commandId, status: 'sent', conversationId: CHAT_B }
    });
    expect(resumeJobFor(sessionId)).toMatchObject({ stage: 'done', busy: false });
  });
});

describe('the bridge port', () => {
  // The shipped candidate range is asserted in bridge.test.ts, against the exported
  // constant. Here the only claim is the one this suite depends on: whatever port the
  // bridge took, it took it on loopback and nowhere else.
  it('is loopback only', () => {
    expect(bridgePort()).toBeGreaterThan(0);
    expect(base.startsWith('http://127.0.0.1:')).toBe(true);
  });
});
