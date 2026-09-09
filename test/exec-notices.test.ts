import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const processes = vi.hoisted(() => new Map<number, number | null>());
vi.mock('../src/main/codex/manager.js', () => ({ unifiedExecManager: {
  backgroundState: (owned: Set<number>) => ({
    running: [...processes].filter(([id, exit]) => owned.has(id) && exit === null).map(([id]) => id),
    exitedUnread: [...processes].filter(([id, exit]) => owned.has(id) && exit !== null).map(([processId, exitCode]) => ({ processId, exitCode }))
  })
} }));
import {
  backgroundExecObligations, backgroundExecRecoveryNotices, forgetExecOwner, noteExecOwner,
  resetExecOwnershipForTests, UNATTENDED_EXEC_NOTICE_MS
} from '../src/main/codex/ownership.js';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); processes.clear(); resetExecOwnershipForTests(); });
afterEach(() => { vi.useRealTimers(); });
function process(id = 10, exit: number | null = 0, owner = 'session-a') {
  processes.set(id, exit); noteExecOwner(id, owner);
}
function notice(requestId: string | null, startedAt = Date.now(), owner = 'session-a') {
  return backgroundExecRecoveryNotices(owner, requestId, startedAt);
}

it('acknowledges one completed-state notice without consuming its unread output', () => {
  process();
  expect(notice('first')).toEqual([expect.stringContaining('session 10 finished with exit code 0')]);
  vi.advanceTimersByTime(1);
  expect(notice('next')).toEqual([]);
  expect(backgroundExecObligations('session-a').exitedUnread).toEqual([{ processId: 10, exitCode: 0 }]);
  expect(notice('later')).toEqual([]);
});

it('reoffers a lost result on the same request and does not accept an older concurrent call as receipt', () => {
  process();
  const oldStart = Date.now();
  vi.advanceTimersByTime(10);
  const offered = notice('first');
  vi.advanceTimersByTime(10);
  expect(notice('first')).toEqual(offered);
  expect(notice('concurrent', oldStart)).toEqual(offered);
  expect(notice('confirmed')).toEqual([]);
});

it('requires a distinct later request from the same durable session', () => {
  process();
  const offered = notice('first');
  expect(notice('same-millisecond')).toEqual(offered);
  vi.advanceTimersByTime(1);
  expect(notice('other-chat', Date.now(), 'session-b')).toEqual([]);
  expect(notice(null)).toEqual(offered);
  expect(notice('first')).toEqual(offered);
  expect(notice('new-after-resume')).toEqual([]);
});

it('offers the exit transition even when the live-session reminder was already acknowledged', () => {
  process(10, null);
  expect(notice('early')).toEqual([]);
  vi.advanceTimersByTime(UNATTENDED_EXEC_NOTICE_MS);
  expect(notice('running')).toEqual([expect.stringContaining('running unpolled')]);
  vi.advanceTimersByTime(1);
  expect(notice('attended')).toEqual([]);
  processes.set(10, 7);
  expect(notice('finished')).toEqual([expect.stringContaining('exit code 7')]);
  vi.advanceTimersByTime(1);
  expect(notice('finished')).toEqual([expect.stringContaining('exit code 7')]);
  expect(notice('exit-received')).toEqual([]);
});

it('advances through bounded notice batches while all unread results stay pending', () => {
  for (let id = 10; id < 18; id++) process(id);
  expect(notice('first')).toHaveLength(3);
  vi.advanceTimersByTime(1);
  expect(notice('second')).toHaveLength(3);
  vi.advanceTimersByTime(1);
  expect(notice('third')).toHaveLength(2);
  vi.advanceTimersByTime(1);
  expect(notice('fourth')).toEqual([]);
  expect(backgroundExecObligations('session-a').exitedUnread).toHaveLength(8);
});

it('forgets notice receipts at process retirement before the numeric ID can be reused', () => {
  process(); notice('first'); vi.advanceTimersByTime(1); expect(notice('next')).toEqual([]);
  forgetExecOwner(10);
  process(10, 2, 'session-b');
  expect(notice('old-owner')).toEqual([]);
  expect(notice('new-owner', Date.now(), 'session-b')).toEqual([expect.stringContaining('exit code 2')]);
});
