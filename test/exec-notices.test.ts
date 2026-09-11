import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const processes = vi.hoisted(() => new Map<number, number | null>());
vi.mock('../src/main/codex/manager.js', () => ({ unifiedExecManager: {
  backgroundState: (owned: Set<number>) => ({
    running: [...processes].filter(([id, exit]) => owned.has(id) && exit === null).map(([id]) => id),
    exitedUnread: [...processes].filter(([id, exit]) => owned.has(id) && exit !== null).map(([processId, exitCode]) => ({ processId, exitCode }))
  })
} }));
import {
  backgroundExecObligations, backgroundExecRecoveryNotices, forgetExecOwner, noteExecOwner, noteExecAttended,
  resetExecOwnershipForTests, UNATTENDED_EXEC_NOTICE_MS
} from '../src/main/codex/ownership.js';
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); processes.clear(); resetExecOwnershipForTests(); });
afterEach(() => { vi.useRealTimers(); });
function process(id = 10, exit: number | null = null, owner = 'session-a') {
  processes.set(id, exit); noteExecOwner(id, owner);
}
const publication = () => ({ completedAt: null as number | null, failed: false });
const notice = (response = publication(), owner = 'session-a') => backgroundExecRecoveryNotices(owner, response);
it('leaves completed output to the process delivery owner', () => {
  process(10, 7);
  expect(notice()).toEqual([]);
  expect(backgroundExecObligations('session-a').exitedUnread).toEqual([{ processId: 10, exitCode: 7 }]);
});
it('reoffers a failed response but suppresses pending and published reminders', () => {
  process();
  expect(notice()).toEqual([]);
  vi.advanceTimersByTime(UNATTENDED_EXEC_NOTICE_MS);
  const first = publication();
  const offered = notice(first);
  expect(offered).toEqual([expect.stringContaining('running unpolled')]);
  expect(notice()).toEqual([]);
  first.failed = true;
  const second = publication();
  expect(notice(second)).toEqual(offered);
  second.completedAt = Date.now();
  vi.advanceTimersByTime(100);
  expect(notice()).toEqual([]);
  noteExecAttended(10);
  expect(notice()).toEqual([]);
  vi.advanceTimersByTime(UNATTENDED_EXEC_NOTICE_MS);
  expect(notice()).toHaveLength(1);
});
it('bounds reminder batches and isolates owners, including numeric ID reuse', () => {
  for (let id = 10; id < 18; id++) process(id);
  vi.advanceTimersByTime(UNATTENDED_EXEC_NOTICE_MS);
  expect(notice(publication(), 'session-b')).toEqual([]);
  expect(notice()).toHaveLength(3);
  expect(notice()).toHaveLength(3);
  expect(notice()).toHaveLength(2);
  expect(notice()).toEqual([]);
  forgetExecOwner(10);
  process(10, null, 'session-b');
  vi.advanceTimersByTime(UNATTENDED_EXEC_NOTICE_MS);
  expect(notice()).toEqual([]);
  expect(notice(publication(), 'session-b')).toHaveLength(1);
});
