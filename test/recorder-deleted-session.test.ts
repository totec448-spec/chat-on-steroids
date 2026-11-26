import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { observeRequestCorrelation, resetCorrelationRegistryForTests } from '../src/main/session/correlation.js';
import { flushRecorder, forgetSession, recordToolCall, resetRecorderForTests, sessionForConversation } from '../src/main/session/recorder.js';
import { deleteSession, findSessionByConversation, flushSessions, initSessionStore, readEvents, resetSessionStoreForTests, unsetSessionRootForTests } from '../src/main/session/store.js';
import { getLog } from '../src/main/logger.js';

let dir = '';
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-deleted-session-'));
  initConfigPath(dir); initSessionStore(dir); initDurableStore(dir);
  await saveConfig(defaultConfig());
});
afterEach(async () => {
  vi.restoreAllMocks();
  await flushRecorder(); await flushSessions(); await flushDurable();
  resetRecorderForTests(); resetCorrelationRegistryForTests(); resetSessionStoreForTests();
  unsetSessionRootForTests(); resetDurableForTests();
  await fs.rm(dir, { recursive: true, force: true });
});

const call = (requestId: string, conversationId: string) => recordToolCall({
  tool: 'read', args: {}, content: [{ type: 'text', text: 'ok' }], outcome: 'ok', durationMs: 1,
  startedAt: Date.now(), requestId, conversationId
});

// #2298 (diagnostics, 2026-11-25 14:59): a person deleted a chat's session while its turn was still running.
// The request already proved to belong to that session, so each further call of the same request was
// refused "to avoid a newer conversation epoch" and left out of the record: 18 calls over six minutes.
// A session that no longer exists is not a newer epoch; the chat starts a new one and the call is filed there.
it('files a running request\'s next call in the chat\'s new session after its session was deleted', async () => {
  const first = (await sessionForConversation('deleted-live-chat'))!;
  observeRequestCorrelation({ requestId: 'long-request', sessionId: first, conversationId: 'deleted-live-chat',
    messageId: 'long-request', tool: 'read', observedAt: Date.now() });
  forgetSession(first);
  await deleteSession(first);
  const recorded = await call('long-request', 'deleted-live-chat');
  expect(recorded).not.toBeNull();
  const next = await findSessionByConversation('deleted-live-chat');
  expect(next?.id).toBeTruthy();
  expect(next?.id).not.toBe(first);
  expect((await readEvents(next!.id, { kinds: ['tool_call'] })).length).toBe(1);
  expect(getLog().some(entry => entry.message.includes('refusing to downgrade'))).toBe(false);
});

it('still refuses a call pinned to a session that exists but no longer holds the chat', async () => {
  const other = (await sessionForConversation('other-chat'))!;
  observeRequestCorrelation({ requestId: 'moved-request', sessionId: other, conversationId: 'moved-chat',
    messageId: 'moved-request', tool: 'read', observedAt: Date.now() });
  expect(await call('moved-request', 'moved-chat')).toBeNull();
  expect(getLog().some(entry => entry.message.includes('refusing to downgrade'))).toBe(true);
});
