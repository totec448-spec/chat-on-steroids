import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { getConfig } from '../src/main/config.js';
import {
  automaticSendRefusal, chatsAtOnceStatus, noteChatLimit, resetChatsAtOnceForTests, restoreChatsAtOnce,
  resumeAutomaticSends, setWorkerSlotSource, WORKER_ADMISSION_HOLD_MS, setWorkingChatsSource, workerSlotsRefusal, type WorkerSlotState
} from '../src/main/chats-at-once.js';
import * as durable from '../src/main/durable.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { REVIVAL_ACTIVITY_MS } from '../src/main/bridge.js';
import { makeTempDir, removeTempDir } from './helpers.js';

// "Chats working at once" (#1694): automatic sends wait their turn; a person's own message never does.
let dir: string;
let working = new Set<string>();
beforeAll(async () => { dir = await makeTempDir('clf-chats-at-once-'); initDurableStore(dir); });
afterAll(async () => { await flushDurable(); resetDurableForTests(); await removeTempDir(dir); });
beforeEach(() => {
  resetChatsAtOnceForTests();
  working = new Set();
  setWorkingChatsSource(() => working);
  getConfig().multiAgent.chatsAtOnce = 2;
});

it('is off by default and then lets every automatic send go', () => {
  getConfig().multiAgent.chatsAtOnce = 0;
  working = new Set(['a', 'b', 'c', 'd']);
  expect(automaticSendRefusal('input:x', 'x')).toBeNull();
});

it('holds a new chat\'s automatic send while the limit is reached, and lets a working chat continue', () => {
  working = new Set(['a', 'b']);
  expect(automaticSendRefusal('input:c', 'c')).toMatch(/2 chats are working/);
  // A chat that is already working takes no new slot (its own next step, an inject).
  expect(automaticSendRefusal('input:a', 'a')).toBeNull();
  working.delete('b');
  expect(automaticSendRefusal('input:c', 'c')).toBeNull();
});

it('with a limit of 1, admits one send at a time even before the first shows as working', () => {
  getConfig().multiAgent.chatsAtOnce = 1;
  expect(automaticSendRefusal('input:a', 'a')).toBeNull();
  // Admitted but not yet reported as working: its slot is reserved.
  expect(automaticSendRefusal('input:b', 'b')).not.toBeNull();
  working = new Set(['a']);
  expect(automaticSendRefusal('input:b', 'b')).not.toBeNull();
  working = new Set();
  // The reservation ends once the admitted chat has been seen working and stopped.
  expect(automaticSendRefusal('input:b', 'b')).toBeNull();
});

it('lets waiting sends go in the order they began to wait, so a busy chat cannot starve another', () => {
  getConfig().multiAgent.chatsAtOnce = 1;
  working = new Set(['busy']);
  expect(automaticSendRefusal('input:first', 'first', 1_000)).not.toBeNull();
  expect(automaticSendRefusal('input:second', 'second', 2_000)).not.toBeNull();
  working = new Set();
  // The later one asks first, but the earlier one is still waiting: the later one stays in line.
  expect(automaticSendRefusal('input:second', 'second', 3_000)).toMatch(/in line/);
  expect(automaticSendRefusal('input:first', 'first', 3_100)).toBeNull();
  // A waiter that stopped asking for two minutes drops out of the line.
  working = new Set(['first']);
  expect(automaticSendRefusal('input:left', 'left', 4_000)).not.toBeNull();
  working = new Set();
  expect(automaticSendRefusal('input:later', 'later', 4_000 + 2 * 60_000 + 1)).toBeNull();
});

it('applies a lowered limit to new sends only, never stopping what runs', () => {
  working = new Set(['a', 'b']);
  getConfig().multiAgent.chatsAtOnce = 1;
  expect(automaticSendRefusal('input:a', 'a')).toBeNull();
  expect(automaticSendRefusal('input:c', 'c')).toMatch(/limit 1/);
  working = new Set(['a']);
  expect(automaticSendRefusal('input:c', 'c')).not.toBeNull();
  working = new Set();
  expect(automaticSendRefusal('input:c', 'c')).toBeNull();
});

it('pauses every chat\'s automatic sends only when two chats show ChatGPT\'s limit, until the time ChatGPT names', async () => {
  const now = 1_000_000;
  noteChatLimit('a', now + 20 * 60_000, now, now);
  expect(chatsAtOnceStatus(now).pauseUntil).toBeNull();
  expect(automaticSendRefusal('input:c', 'c', now)).toBeNull();
  // A second chat within ten minutes is the evidence that the limit is the account's.
  noteChatLimit('b', now + 30 * 60_000, now + 60_000, now + 60_000);
  expect(chatsAtOnceStatus(now + 60_000).pauseUntil).toBe(now + 30 * 60_000);
  expect(automaticSendRefusal('input:c', 'c', now + 61_000)).toMatch(/ChatGPT asked to slow down/);
  // Saved: a restart keeps the pause.
  await flushDurable();
  resetChatsAtOnceForTests(); setWorkingChatsSource(() => working);
  await restoreChatsAtOnce(now + 62_000);
  expect(chatsAtOnceStatus(now + 62_000).pauseUntil).toBe(now + 30 * 60_000);
  // It ends by itself at ChatGPT's time.
  expect(automaticSendRefusal('input:c', 'c', now + 31 * 60_000)).toBeNull();
});

it('does not pause on two limits far apart, uses 15 minutes when ChatGPT names no time, and Resume now ends it', async () => {
  const now = 5_000_000;
  noteChatLimit('a', null, now, now);
  noteChatLimit('b', null, now + 11 * 60_000, now + 11 * 60_000);
  expect(chatsAtOnceStatus(now + 11 * 60_000).pauseUntil).toBeNull();
  noteChatLimit('c', null, now + 12 * 60_000, now + 12 * 60_000);
  expect(chatsAtOnceStatus(now + 12 * 60_000).pauseUntil).toBe(now + 27 * 60_000);
  expect(await resumeAutomaticSends(now + 13 * 60_000)).toBe(true);
  expect(chatsAtOnceStatus(now + 13 * 60_000).pauseUntil).toBeNull();
  expect(automaticSendRefusal('input:d', 'd', now + 13 * 60_000)).toBeNull();
});

it('never pauses while the setting is off', () => {
  getConfig().multiAgent.chatsAtOnce = 0;
  noteChatLimit('a', 9e12, 1_000, 1_000);
  noteChatLimit('b', 9e12, 2_000, 2_000);
  expect(chatsAtOnceStatus(2_000).pauseUntil).toBeNull();
  expect(automaticSendRefusal('input:c', 'c', 3_000)).toBeNull();
});

// Haz on #2051: a worker's reservation follows the worker, never a timer.
it('counts a running worker once and gives back the slot of a worker that ended, at once', () => {
  getConfig().multiAgent.chatsAtOnce = 3;
  const workers = new Map<string, WorkerSlotState>();
  setWorkerSlotSource(worker => workers.get(worker) ?? { kind: 'pending' });
  working = new Set(['prime']);
  expect(workerSlotsRefusal('prime', ['run/worker-1', 'run/worker-2'], 0)).toBeNull();
  // The prime still shows as working; both workers starting: three slots.
  expect(automaticSendRefusal('input:x', 'x', 1)).toMatch(/3 chats are working/);
  workers.set('run/worker-1', { kind: 'chat', conversationId: 'w1' });
  working = new Set(['prime', 'w1']);
  expect(automaticSendRefusal('input:x', 'x', 2)).toMatch(/3 chats are working/);
  workers.set('run/worker-2', { kind: 'over' });
  expect(automaticSendRefusal('input:x', 'x', 3)).toBeNull();
  // Two workers named the same never share one slot, and a refused spawn reserves nothing.
  expect(workerSlotsRefusal('prime', ['run/worker-3', 'run/worker-4'], 4)).toMatch(/limit is 3/);
});

// CodeRabbit on #2051: limit evidence is the page's own observation time, and Resume now wins over old notices.
it('ignores a replayed or pre-Resume limit notice, and counts a blocking notice without a retry time', async () => {
  const now = 9_000_000;
  // Two old notices replayed now: not two recent limits.
  noteChatLimit('a', now + 20 * 60_000, now - 11 * 60_000, now);
  noteChatLimit('b', now + 20 * 60_000, now - 12 * 60_000, now);
  expect(chatsAtOnceStatus(now).pauseUntil).toBeNull();
  // Two fresh blocking notices without a retry time: the 15-minute pause.
  noteChatLimit('a', null, now, now);
  noteChatLimit('b', null, now + 1_000, now + 1_000);
  expect(chatsAtOnceStatus(now + 1_000).pauseUntil).toBe(now + 1_000 + 15 * 60_000);
  expect(await resumeAutomaticSends(now + 2_000)).toBe(true);
  // Both notices replayed after Resume now (still showing on their pages): no new pause.
  noteChatLimit('a', null, now, now + 3_000);
  noteChatLimit('b', null, now + 1_000, now + 3_000);
  expect(chatsAtOnceStatus(now + 3_000).pauseUntil).toBeNull();
  // New notices after it do count.
  noteChatLimit('a', null, now + 4_000, now + 4_000);
  noteChatLimit('c', null, now + 5_000, now + 5_000);
  expect(chatsAtOnceStatus(now + 5_000).pauseUntil).toBe(now + 5_000 + 15 * 60_000);
});

it('keeps the pause when Resume now cannot be saved', async () => {
  const now = 12_000_000;
  noteChatLimit('a', null, now, now);
  noteChatLimit('b', null, now, now);
  const write = vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('disk full'));
  try {
    await expect(resumeAutomaticSends(now + 1_000)).rejects.toThrow(/could not be saved/);
  } finally { write.mockRestore(); }
  expect(chatsAtOnceStatus(now + 1_000).pauseUntil).toBe(now + 15 * 60_000);
  expect(await resumeAutomaticSends(now + 2_000)).toBe(true);
  expect(chatsAtOnceStatus(now + 2_000).pauseUntil).toBeNull();
});

it('holds a waking worker\'s slot for the whole revival window', () => {
  expect(WORKER_ADMISSION_HOLD_MS).toBeGreaterThanOrEqual(REVIVAL_ACTIVITY_MS);
  getConfig().multiAgent.chatsAtOnce = 1;
  // Waking: its chat is known but not working yet, and the run still has it.
  setWorkerSlotSource(() => ({ kind: 'chat', conversationId: 'w1' }));
  expect(workerSlotsRefusal(null, ['run/worker-1'], 0)).toBeNull();
  expect(automaticSendRefusal('input:x', 'x', 4 * 60_000)).toMatch(/1 chats are working/);
  expect(automaticSendRefusal('input:x', 'x', WORKER_ADMISSION_HOLD_MS - 1)).not.toBeNull();
  expect(automaticSendRefusal('input:x', 'x', WORKER_ADMISSION_HOLD_MS + 1)).toBeNull();
});
