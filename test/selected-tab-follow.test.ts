import { afterEach, expect, it, vi } from 'vitest';
import { createSelectedTabFollow } from '../src/renderer/selected-tab-follow.js';

const row = { id: 'desktop-session', conversationId: 'native-chat-a',
  origin: { kind: 'desktop' as const, fromSessionId: null, agentId: null, task: '' } };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
afterEach(() => { vi.restoreAllMocks(); });

it('retries a rejected request after browser reconnection without duplicating an accepted binding', async () => {
  const send = vi.fn(async () => ({ ok: true, data: false }));
  const follow = createSelectedTabFollow(send);
  follow.select(row);
  await tick();
  send.mockResolvedValue({ ok: true, data: true });
  follow.observe(row);
  await tick();
  follow.observe({ ...row, conversationId: null });
  follow.observe(row);
  expect(send).toHaveBeenCalledTimes(2);
});

it('retains a failed IPC request for retry', async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error('renderer disconnected'))
    .mockResolvedValue({ ok: true, data: true });
  const follow = createSelectedTabFollow(send);
  follow.select(row);
  await tick();
  follow.observe(row);
  await tick();
  follow.observe(row);
  expect(send).toHaveBeenCalledTimes(2);
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
});

it('does not follow a first binding arriving after the original selection deadline', async () => {
  let now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const send = vi.fn(async () => ({ ok: true, data: false }));
  const follow = createSelectedTabFollow(send);
  follow.select({ ...row, conversationId: null });
  await tick();
  now += 10_000;
  follow.observe(row);
  expect(send).toHaveBeenCalledTimes(1);
});

it('does not renew the original selection deadline when its first binding arrives', async () => {
  let now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const send = vi.fn(async () => ({ ok: true, data: false }));
  const follow = createSelectedTabFollow(send);
  follow.select({ ...row, conversationId: null });
  await tick();
  now += 9_000;
  follow.observe(row);
  await tick();
  now += 1_000;
  follow.observe(row);
  expect(send).toHaveBeenCalledTimes(2);
});

it('follows an unbound selection once its first binding is observed', async () => {
  const send = vi.fn(async () => ({ ok: true, data: true }));
  const follow = createSelectedTabFollow(send);
  follow.select({ ...row, conversationId: null });
  await tick();
  follow.observe(row);
  await tick();
  follow.observe(row);
  expect(send.mock.calls).toEqual([[row.id], [row.id]]);
});

it('cancels the pending binding when New Chat is selected', async () => {
  const send = vi.fn(async () => ({ ok: true, data: false }));
  const follow = createSelectedTabFollow(send);
  follow.select({ ...row, conversationId: null });
  await tick();
  follow.select(null);
  follow.observe(row);
  expect(send.mock.calls).toEqual([[row.id], [null]]);
});

it('never retries a previously selected chat after another selection', async () => {
  const send = vi.fn(async () => ({ ok: true, data: false }));
  const follow = createSelectedTabFollow(send);
  const other = { ...row, id: 'other-session' };
  follow.select(row);
  await tick();
  follow.select(other);
  await tick();
  follow.observe(row);
  expect(send.mock.calls).toEqual([[row.id], [other.id]]);
  follow.observe(other);
  expect(send.mock.calls).toEqual([[row.id], [other.id], [other.id]]);
});

it('does not duplicate a follow while its acceptance is still in flight', async () => {
  let release!: (reply: { ok: boolean; data: boolean }) => void;
  const send = vi.fn(() => new Promise<{ ok: boolean; data: boolean }>(resolve => { release = resolve; }));
  const follow = createSelectedTabFollow(send);
  follow.select(row);
  follow.observe(row);
  follow.observe(row);
  expect(send).toHaveBeenCalledTimes(1);
  release({ ok: true, data: false });
  await tick();
  follow.observe(row);
  expect(send).toHaveBeenCalledTimes(2);
  release({ ok: true, data: true });
  await tick();
});
