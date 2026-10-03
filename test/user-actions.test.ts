import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSession,
  deleteSession,
  initSessionStore,
  rebindSession,
  resetSessionStoreForTests,
  sessionsRoot
} from '../src/main/session/store.js';
import {
  MAX_USER_ACTIONS,
  MAX_USER_ACTION_LEDGER_BYTES,
  createUserActionRequest,
  listUserActionRequests,
  recordUserActionReceipt,
  resetUserActionsForTests
} from '../src/main/session/user-actions.js';
import { rawPromises } from '../src/main/rawfs.js';

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-user-actions-'));
  initSessionStore(directory);
  resetUserActionsForTests();
});

afterEach(async () => {
  resetUserActionsForTests();
  resetSessionStoreForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

const request = (suffix = '') => ({
  command: `npm test ${suffix}`.trim(),
  shell: 'powershell',
  cwd: 'C:\\workspace',
  purpose: 'Run the locally authorized verification step',
  reportedProviderReason: 'The provider did not dispatch this tool call',
  reportedRiskNote: 'Reporter says this is a local test command',
  constraints: ['Do not rerun after a successful receipt'],
  expectedEvidence: ['Save the exit code and test summary']
});

it('persists requests and reporter-only receipts across restart and Compact & Resume', async () => {
  const session = await createSession({ title: 'Human handoff', conversationId: 'chat-a' });
  const created = await createUserActionRequest(session.id, request());
  expect(created.id).toEqual(expect.any(String));
  expect(created.receipt).toBeUndefined();
  expect(created).not.toHaveProperty('verified');
  expect(created).not.toHaveProperty('completed');

  const receipt = await recordUserActionReceipt(session.id, created.id, {
    outcome: 'reported_executed', note: 'I ran it once', evidence: ['exit=0']
  });
  expect(receipt.receipt).toMatchObject({ outcome: 'reported_executed', reportedAt: expect.any(Number) });
  expect(receipt).not.toHaveProperty('verified');
  expect(receipt).not.toHaveProperty('completed');

  expect(await rebindSession(session.id, 'chat-a', 'chat-b')).toBe(true);
  resetSessionStoreForTests();
  initSessionStore(directory);
  expect(await listUserActionRequests(session.id)).toEqual([receipt]);
});

it('serializes concurrent creates and makes an identical receipt retry idempotent', async () => {
  const session = await createSession({ title: 'Concurrent human handoff' });
  const rows = await Promise.all(Array.from({ length: 8 }, (_, index) => createUserActionRequest(session.id, request(String(index)))));
  expect(new Set(rows.map(row => row.id)).size).toBe(8);
  expect(await listUserActionRequests(session.id)).toHaveLength(8);

  const input = { outcome: 'reported_failed' as const, note: 'Command failed', evidence: ['exit=2'] };
  const [first, retry] = await Promise.all([
    recordUserActionReceipt(session.id, rows[0]!.id, input),
    recordUserActionReceipt(session.id, rows[0]!.id, input)
  ]);
  expect(retry).toEqual(first);
  await expect(recordUserActionReceipt(session.id, rows[0]!.id, { ...input, note: 'Different report' }))
    .rejects.toThrow(/already has a different receipt/i);
});

it('fails closed for corrupt or oversized ledgers', async () => {
  const session = await createSession({ title: 'Damaged handoff' });
  await createUserActionRequest(session.id, request());
  const file = path.join(sessionsRoot(), session.id, 'user-actions.json');
  await fs.writeFile(file, '{broken', 'utf8');
  await expect(listUserActionRequests(session.id)).rejects.toThrow(/invalid|corrupt/i);
  await fs.writeFile(file, 'x'.repeat(MAX_USER_ACTION_LEDGER_BYTES + 1), 'utf8');
  await expect(listUserActionRequests(session.id)).rejects.toThrow(/storage budget/i);
});

it('rejects a 65th row without pruning earlier unresolved requests', async () => {
  const session = await createSession({ title: 'Bounded handoff' });
  for (let index = 0; index < MAX_USER_ACTIONS; index++) {
    await createUserActionRequest(session.id, request(String(index)));
  }
  await expect(createUserActionRequest(session.id, request('overflow'))).rejects.toThrow(/limit/i);
  const rows = await listUserActionRequests(session.id);
  expect(rows).toHaveLength(MAX_USER_ACTIONS);
  expect(rows[0]!.command).toBe('npm test 0');
});

it('cannot recreate a deleted session directory with a late mutation', async () => {
  const session = await createSession({ title: 'Deleted handoff' });
  const row = await createUserActionRequest(session.id, request());
  await deleteSession(session.id);
  await expect(recordUserActionReceipt(session.id, row.id, { outcome: 'cancelled', note: 'No longer needed' }))
    .rejects.toThrow(/session.*not found/i);
  await expect(createUserActionRequest(session.id, request('late'))).rejects.toThrow(/session.*not found/i);
  await expect(fs.access(path.join(sessionsRoot(), session.id))).rejects.toThrow();
});

it('lets session deletion win while a ledger publication is paused before rename', async () => {
  const session = await createSession({ title: 'Delete race' });
  let entered!: () => void;
  let release!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const rename = rawPromises.rename.bind(rawPromises);
  const spy = vi.spyOn(rawPromises, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith(`${path.sep}user-actions.json`)) {
      entered();
      await gate;
    }
    return rename(from, to);
  });
  try {
    const writing = createUserActionRequest(session.id, request('race'));
    await paused;
    await deleteSession(session.id);
    release();
    await expect(writing).rejects.toThrow();
    await expect(fs.access(path.join(sessionsRoot(), session.id))).rejects.toThrow();
  } finally {
    release();
    spy.mockRestore();
  }
});

it('refuses unknown requests and sessions', async () => {
  const session = await createSession({ title: 'Unknown receipt' });
  await expect(recordUserActionReceipt(session.id, '00000000-0000-4000-8000-000000000000', { outcome: 'cancelled' }))
    .rejects.toThrow(/request not found/i);
  await expect(listUserActionRequests('2026-01-01-deadbeef')).rejects.toThrow(/session.*not found/i);
});
