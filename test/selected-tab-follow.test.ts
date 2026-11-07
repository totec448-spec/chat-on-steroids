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

it('keeps the ten-second deadline from selection for an already-bound chat, logging expiry once', async () => {
  let now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const send = vi.fn(async () => ({ ok: true, data: false }));
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const follow = createSelectedTabFollow(send);
  follow.select(row);
  await tick();
  now += 9_999;
  follow.observe(row);
  await tick();
  now++;
  follow.observe(row);
  now += 60_000;
  follow.observe(row);
  expect(send).toHaveBeenCalledTimes(2);
  expect(info.mock.calls).toEqual([['Browser follow: pending selection expired before acceptance.']]);
});

it('keeps a never-bound chat pending without timers or repeated IPC work', async () => {
  vi.useFakeTimers();
  try {
    const send = vi.fn(async () => ({ ok: true, data: false }));
    const follow = createSelectedTabFollow(send);
    const unbound = { ...row, conversationId: null };
    const timers = vi.getTimerCount();
    follow.select(unbound);
    await tick();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    for (let i = 0; i < 50; i++) follow.observe(unbound);
    expect(send.mock.calls).toEqual([[row.id]]);
    expect(vi.getTimerCount()).toBe(timers);
    // A genuine later binding still works: inactivity did not quietly discard the intent.
    follow.observe(row);
    await tick();
    expect(send.mock.calls).toEqual([[row.id], [row.id]]);
  } finally { vi.useRealTimers(); }
});

it.each([10_000, 11_148, 60_000])('follows the still-selected chat when its first binding arrives after %i ms', async delay => {
  let now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const send = vi.fn(async () => ({ ok: true, data: false }));
  const follow = createSelectedTabFollow(send);
  follow.select({ ...row, conversationId: null });
  await tick();
  now += delay;
  send.mockResolvedValue({ ok: true, data: true });
  follow.observe(row);
  await tick();
  follow.observe(row);
  expect(send).toHaveBeenCalledTimes(2);
});

it('starts one bounded retry window at the first binding without renewing it on later observations', async () => {
  let now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const send = vi.fn(async () => ({ ok: true, data: false }));
  const follow = createSelectedTabFollow(send);
  follow.select({ ...row, conversationId: null });
  await tick();
  now += 60_000;
  follow.observe(row);
  await tick();
  now += 9_999;
  follow.observe({ ...row, conversationId: null });
  follow.observe(row);
  await tick();
  now++;
  follow.observe(row);
  expect(send).toHaveBeenCalledTimes(3);
});

it.each(['new chat', 'another chat'])('cancels a slow first-binding wait on %s', async selection => {
  let now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const send = vi.fn(async () => ({ ok: true, data: false }));
  const follow = createSelectedTabFollow(send);
  follow.select({ ...row, conversationId: null });
  await tick();
  now += 60_000;
  follow.select(selection === 'new chat' ? null : { ...row, id: 'other-session' });
  await tick();
  follow.observe(row);
  expect(send.mock.calls).toEqual([[row.id], [selection === 'new chat' ? null : 'other-session']]);
});

it('does not follow a later conversation rebind after a slow first binding', async () => {
  let now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const send = vi.fn(async () => ({ ok: true, data: false }));
  const follow = createSelectedTabFollow(send);
  follow.select({ ...row, conversationId: null });
  await tick();
  now += 11_148;
  follow.observe(row);
  await tick();
  follow.observe({ ...row, conversationId: 'native-chat-b' });
  follow.observe(row);
  expect(send).toHaveBeenCalledTimes(2);
});

it('ignores the old unbound reply while the first binding is waiting for acceptance', async () => {
  let now = 100_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  let release!: (reply: { ok: boolean; data: boolean }) => void;
  const send = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockResolvedValueOnce({ ok: true, data: false }).mockResolvedValue({ ok: true, data: true });
  const follow = createSelectedTabFollow(send);
  follow.select({ ...row, conversationId: null });
  now += 11_148;
  follow.observe(row);
  await tick();
  release({ ok: true, data: true });
  await tick();
  follow.observe(row);
  await tick();
  follow.observe(row);
  expect(send).toHaveBeenCalledTimes(3);
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
