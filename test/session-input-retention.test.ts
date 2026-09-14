import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTempDir, removeTempDir } from './helpers.js';
import { initDurableStore, readDurable, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import { createSession, deleteSession, initSessionStore, pruneSessions, resetSessionStoreForTests, sessionDirectoryMissing } from '../src/main/session/store.js';
import { configureInputDelivery, listInputs, resetInputForTests, type InputEntry } from '../src/main/session/input.js';
import { recordDeliveredInput } from '../src/main/session/input-history.js';
import { noteChatOrigin } from '../src/main/session/recorder.js';

vi.mock('../src/main/session/recorder.js', () => ({ noteChatOrigin: vi.fn(async () => undefined) }));
let directory: string;
const record = vi.fn(recordDeliveredInput);
beforeEach(async () => {
  directory = await makeTempDir('cos-input-retention-');
  initSessionStore(directory); initDurableStore(directory); resetInputForTests();
  record.mockReset().mockImplementation(recordDeliveredInput); vi.mocked(noteChatOrigin).mockClear();
  configureInputDelivery({ changed: () => {}, applyAutomation: async () => {}, recordDelivered: record });
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetInputForTests(); resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});
it('retires receipts after actual retention removes their closed session', async () => {
  const session = await createSession({ title: 'Retention candidate' });
  await writeDurableNow('session-input', [receipt(session.id, { sessionId: session.id })]);
  resetSessionStoreForTests();
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 32 * 24 * 60 * 60_000);
  expect(await pruneSessions(30)).toBe(1);
  expect(await listInputs()).toEqual([]);
  expect(record).not.toHaveBeenCalled();
});
it.each(['ENOENT', 'EACCES'])('does not infer deletion when the history root is unavailable (%s)', async code => {
  const sessionId = randomUUID();
  const stat = fs.stat.bind(fs);
  vi.spyOn(fs, 'stat').mockImplementation((async (target, ...args) => {
    if (target === path.join(directory, 'sessions')) throw Object.assign(new Error('unavailable'), { code });
    return stat(target, ...args);
  }) as typeof fs.stat);
  expect(await sessionDirectoryMissing(sessionId)).toBe(false);
});
it('preserves a receipt when probing its exact folder is denied', async () => {
  const sessionId = randomUUID();
  await fs.mkdir(path.join(directory, 'sessions'), { recursive: true });
  const row = receipt(sessionId, { sessionId });
  await writeDurableNow('session-input', [row]);
  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, 'lstat').mockImplementation((async (target, ...args) => {
    if (target === path.join(directory, 'sessions', sessionId)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return lstat(target, ...args);
  }) as typeof fs.lstat);
  record.mockResolvedValue(false);
  expect((await listInputs()).map(item => item.id)).toEqual([row.id]);
});
it.each([false, true])('retires a combined receipt only with its confirmed companion (confirmed: %s)', async confirmed => {
  const session = await createSession({ title: 'Combined delivery' });
  const companion = receipt(session.id, { sessionId: session.id,
    ...(confirmed ? {} : { deliveredAt: undefined, messageId: undefined }) });
  const root = receipt(session.id, { sessionId: session.id, companionInputId: companion.id });
  await writeDurableNow('session-input', [root, companion]);
  await deleteSession(session.id);
  record.mockResolvedValue(false);
  expect((await listInputs()).map(row => row.id)).toEqual(confirmed ? [] : [root.id, companion.id]);
});
function receipt(sessionId: string, extra: Partial<InputEntry> = {}): InputEntry {
  return { id: randomUUID(), sessionId: null, deliveredSessionId: sessionId, conversationId: 'retained-chat',
    state: 'sent', owner: 'page', text: 'Authored task', deliveryText: 'Authored task\nTransport context',
    mode: 'auto', dueAt: 0, createdAt: 0, model: null, reasoningEffort: null,
    messageId: 'native-message', deliveredAt: 100, historyRecorded: true, ...extra };
}
it('retires deleted-session wrapped receipts before origin repair and keeps them gone across restarts', async () => {
  const session = await createSession({ title: 'Deleted', conversationId: 'retained-chat' });
  await writeDurableNow('session-input', [receipt(session.id, { stages: ['Do not resurrect a deleted task'] })]);
  await deleteSession(session.id);
  for (let restart = 0; restart < 3; restart++) {
    resetInputForTests();
    expect(await listInputs()).toEqual([]);
    expect(await readDurable('session-input')).toEqual([]);
  }
  expect(record).not.toHaveBeenCalled();
  expect(noteChatOrigin).not.toHaveBeenCalled();
  expect(await fs.readdir(path.join(directory, 'sessions'))).toEqual([]);
});
it('retires a confirmed pending history retry when the session is deleted during the same process', async () => {
  const session = await createSession({ title: 'Removed later' });
  const row = receipt(session.id, { sessionId: session.id, historyRecorded: false });
  record.mockResolvedValueOnce(false);
  await writeDurableNow('session-input', [row]);
  expect(await listInputs()).toHaveLength(1);
  await deleteSession(session.id); record.mockClear();
  expect(await listInputs()).toEqual([]);
  expect(record).not.toHaveBeenCalled();
});
it('retains corrupt history, unbound receipts and ambiguous browser sends', async () => {
  const session = await createSession({ title: 'Corrupt but recoverable' });
  resetSessionStoreForTests();
  const sessionPath = path.join(directory, 'sessions', session.id);
  for (const name of await fs.readdir(sessionPath)) await fs.rm(path.join(sessionPath, name), { recursive: true, force: true });
  await fs.writeFile(path.join(sessionPath, 'meta.json'), '{broken');
  const rows = [receipt(session.id, { sessionId: session.id }),
    receipt(session.id, { deliveredSessionId: null }),
    receipt('missing-session', { sessionId: 'missing-session', state: 'cancelled', messageId: undefined, deliveredAt: undefined })];
  await writeDurableNow('session-input', rows);
  expect((await listInputs()).map(row => row.id)).toEqual(rows.map(row => row.id));
  expect(record).toHaveBeenCalled();
  expect(await fs.readFile(path.join(sessionPath, 'meta.json'), 'utf8')).toBe('{broken');
});
