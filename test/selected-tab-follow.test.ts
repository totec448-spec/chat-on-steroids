import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSelectedTabFollow } from '../src/renderer/selected-tab-follow.js';

const KEY = 'chat-on-steroids.pending-tab-follow';
const row = { id: 'desktop-session', conversationId: 'native-chat-a',
  origin: { kind: 'desktop' as const, fromSessionId: null, agentId: null, task: '' } };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }
  } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('recovers a crash during IPC and clears the saved binding only after acceptance', async () => {
  const stalled = createSelectedTabFollow(() => new Promise(() => {}));
  stalled.select(row);
  expect(JSON.parse(values.get(KEY)!)).toMatchObject({ id: row.id, conversationId: row.conversationId });
  const send = vi.fn(async () => ({ ok: true, data: true }));
  const restarted = createSelectedTabFollow(send);
  expect(restarted.restore([row])).toBe(row.id);
  restarted.select(row);
  await tick();
  expect(send.mock.calls).toEqual([[row.id]]);
  expect(values.has(KEY)).toBe(false);
});

it('recovers a crash before binding, then follows the binding observed after restart', async () => {
  const opening = { ...row, conversationId: null };
  createSelectedTabFollow(async () => ({ ok: true, data: false })).select(opening);
  const send = vi.fn(async () => ({ ok: true, data: false }));
  const restarted = createSelectedTabFollow(send);
  expect(restarted.restore([opening])).toBe(row.id);
  restarted.select(opening);
  await tick();
  send.mockResolvedValue({ ok: true, data: true });
  restarted.observe(row);
  await tick();
  expect(send.mock.calls).toEqual([[row.id], [row.id]]);
  expect(values.has(KEY)).toBe(false);
});

it('retries a rejected request after browser reconnection without duplicating an accepted binding', async () => {
  const send = vi.fn(async () => ({ ok: true, data: false }));
  const follow = createSelectedTabFollow(send);
  follow.select(row);
  await tick();
  expect(values.has(KEY)).toBe(true);
  send.mockResolvedValue({ ok: true, data: true });
  follow.observe(row);
  await tick();
  follow.observe({ ...row, conversationId: null });
  follow.observe(row);
  expect(send).toHaveBeenCalledTimes(2);
  expect(values.has(KEY)).toBe(false);
});

it('retains a failed IPC request for retry', async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error('renderer disconnected'))
    .mockResolvedValue({ ok: true, data: true });
  const follow = createSelectedTabFollow(send);
  follow.select(row);
  await tick();
  expect(values.has(KEY)).toBe(true);
  follow.observe(row);
  await tick();
  expect(send).toHaveBeenCalledTimes(2);
  expect(values.has(KEY)).toBe(false);
});

it('does not renew the deadline when retrying a temporarily unavailable browser', async () => {
  let now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const send = vi.fn(async () => ({ ok: true, data: false }));
  const follow = createSelectedTabFollow(send);
  follow.select(row);
  await tick();
  now += 9_999;
  follow.observe(row);
  await tick();
  now++;
  follow.observe(row);
  expect(send).toHaveBeenCalledTimes(2);
  expect(values.has(KEY)).toBe(false);
});

it('cancels restart recovery when New Chat is chosen before the catalog loads', () => {
  values.set(KEY, JSON.stringify({ id: row.id, conversationId: row.conversationId, expiresAt: Date.now() + 10_000 }));
  const send = vi.fn(async () => ({ ok: true, data: true }));
  const follow = createSelectedTabFollow(send);
  follow.select(null);
  expect(follow.restore([row])).toBeNull();
  expect(send.mock.calls).toEqual([[null]]);
  expect(values.has(KEY)).toBe(false);
});

it.each(['deleted', 'rebound', 'foreign'] as const)('does not restore a %s desktop binding', kind => {
  values.set(KEY, JSON.stringify({ id: row.id, conversationId: row.conversationId, expiresAt: Date.now() + 10_000 }));
  const send = vi.fn(async () => ({ ok: true, data: true }));
  const follow = createSelectedTabFollow(send);
  const rows = kind === 'deleted' ? [] : kind === 'rebound' ? [{ ...row, conversationId: 'native-chat-b' }] : [{ ...row, origin: null }];
  expect(follow.restore(rows)).toBeNull();
  expect(send).not.toHaveBeenCalled();
  expect(values.has(KEY)).toBe(false);
});

it.each(['absent', 'damaged', 'oversized', 'expired', 'future', 'wrong types'] as const)('loads %s saved state without following a chat', kind => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const valid = { id: row.id, conversationId: row.conversationId, expiresAt: Date.now() + 10_000 };
  if (kind !== 'absent') values.set(KEY, kind === 'damaged' ? '{' : kind === 'oversized' ? 'x'.repeat(513) : JSON.stringify({
    ...valid, ...(kind === 'expired' ? { expiresAt: Date.now() - 1 } : kind === 'future' ? { expiresAt: Date.now() + 100_000 } : { conversationId: {} })
  }));
  const send = vi.fn(async () => ({ ok: true, data: true }));
  expect(createSelectedTabFollow(send).restore([row])).toBeNull();
  expect(send).not.toHaveBeenCalled();
  expect(values.has(KEY)).toBe(false);
});

it('continues following in memory when local storage is unavailable', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('window', { get localStorage() { throw new Error('storage denied'); } });
  const send = vi.fn(async () => ({ ok: true, data: true }));
  const follow = createSelectedTabFollow(send);
  follow.select(row);
  await tick();
  expect(send.mock.calls).toEqual([[row.id]]);
});
