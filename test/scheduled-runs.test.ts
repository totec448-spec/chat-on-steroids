import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import type { RunnerDeps } from '../src/main/scheduled-runs.js';

/**
 * #1826: a chat's schedule puts one message into that chat's own queue at each time. Exactly once
 * per time (a crash between queueing and saving queues the same message id again, which the queue
 * answers with the row it already has), never two at once, one late run after missed ones.
 */
let zone: string | undefined;
beforeAll(() => { zone = process.env.TZ; process.env.TZ = 'Europe/Berlin'; });
afterAll(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
let dir: string;
beforeEach(async () => {
  vi.resetModules();
  dir = await makeTempDir('cos-scheduled-runs-');
  // The module instance the runner imports after the reset is the one that needs the root.
  (await import('../src/main/durable.js')).initDurableStore(dir);
});
afterEach(async () => { await removeTempDir(dir); });

const local = (text: string) => new Date(text).getTime();
const SESSION = '2026-10-24-a1b2c3d4';

async function setup(over: Partial<RunnerDeps> = {}) {
  const runs = await import('../src/main/scheduled-runs.js');
  const queued: Array<Record<string, unknown>> = [];
  const deps: RunnerDeps = {
    session: async id => id === SESSION ? { id, conversationId: 'chat-1', activeTurnId: null } : null,
    enqueue: vi.fn(async input => { queued.push(input as never); }),
    pending: async () => new Set(),
    log: vi.fn(),
    ...over
  };
  return { runs, deps, queued };
}

it('saves one schedule per chat and starts it at its next time, never at once', async () => {
  const { runs, deps, queued } = await setup();
  const saved = await runs.saveSchedule({ sessionId: SESSION, text: 'Check the open issues', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T10:00:00'));
  expect(saved).toMatchObject({ sessionId: SESSION, paused: false, lastDueAt: null });
  await runs.runDueSchedules(local('2026-10-24T10:00:30'), deps);
  expect(queued).toEqual([]);
  await runs.runDueSchedules(local('2026-10-25T09:00:20'), deps);
  expect(queued).toEqual([expect.objectContaining({ sessionId: SESSION, text: 'Check the open issues', mode: 'auto',
    scheduled: { scheduleId: saved.id, dueAt: local('2026-10-25T09:00:00'), late: false } })]);
  // The same time is never sent twice.
  await runs.runDueSchedules(local('2026-10-25T09:01:00'), deps);
  expect(queued).toHaveLength(1);
  // A second save for the chat replaces the first, keeping its id.
  const again = await runs.saveSchedule({ sessionId: SESSION, text: 'Other', repeat: { kind: 'hours', every: 3 }, until: null }, local('2026-10-25T10:00:00'));
  expect(again.id).toBe(saved.id);
  expect(await runs.listSchedules()).toHaveLength(1);
});

it('waits for a running turn instead of joining it', async () => {
  const { runs, deps, queued } = await setup({ session: async id => ({ id, conversationId: 'chat-1', activeTurnId: 'turn-1' }) });
  await runs.saveSchedule({ sessionId: SESSION, text: 'Hourly check', repeat: { kind: 'hours', every: 1 }, until: null }, local('2026-10-24T10:00:00'));
  await runs.runDueSchedules(local('2026-10-24T11:00:10'), deps);
  expect(queued[0]).toMatchObject({ mode: 'after-turn' });
});

it('sends one late run after missed ones, labelled late', async () => {
  const { runs, deps, queued } = await setup();
  await runs.saveSchedule({ sessionId: SESSION, text: 'Daily', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-20T10:00:00'));
  await runs.runDueSchedules(local('2026-10-24T12:00:00'), deps);
  expect(queued).toEqual([expect.objectContaining({ scheduled: expect.objectContaining({ dueAt: local('2026-10-24T09:00:00'), late: true }) })]);
  expect(deps.log).toHaveBeenCalledWith(expect.stringMatching(/^scheduled run: queued for .+ \(late, was due /));
});

it('skips a time while the previous run still waits in the queue, and says so', async () => {
  const { runs, deps, queued } = await setup();
  await runs.saveSchedule({ sessionId: SESSION, text: 'Hourly', repeat: { kind: 'hours', every: 1 }, until: null }, local('2026-10-24T10:00:00'));
  await runs.runDueSchedules(local('2026-10-24T11:00:10'), deps);
  const first = queued[0]!.id as string;
  await runs.runDueSchedules(local('2026-10-24T12:00:10'), { ...deps, pending: async () => new Set([first]) });
  expect(queued).toHaveLength(1);
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('skipped: the previous run still waits'));
  // It is not tried again for that time once the previous one has gone out.
  await runs.runDueSchedules(local('2026-10-24T12:30:00'), deps);
  expect(queued).toHaveLength(1);
  await runs.runDueSchedules(local('2026-10-24T13:00:10'), deps);
  expect(queued).toHaveLength(2);
});

it('queues the same message again after a crash before it saved, which the queue keeps as one', async () => {
  const { runs, deps, queued } = await setup();
  await runs.saveSchedule({ sessionId: SESSION, text: 'Daily', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00'));
  const durable = await import('../src/main/durable.js');
  const write = vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('disk gone'));
  await runs.runDueSchedules(local('2026-10-24T09:00:10'), deps);
  write.mockRestore();
  await runs.runDueSchedules(local('2026-10-24T09:00:40'), deps);
  expect(queued).toHaveLength(2);
  expect(queued[0]!.id).toBe(queued[1]!.id);
});

it('pauses and resumes, and a resumed schedule does not catch up on what passed while paused', async () => {
  const { runs, deps, queued } = await setup();
  await runs.saveSchedule({ sessionId: SESSION, text: 'Daily', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-20T08:00:00'));
  await runs.setSchedulePaused(SESSION, true, local('2026-10-20T08:30:00'));
  await runs.runDueSchedules(local('2026-10-22T09:00:10'), deps);
  expect(queued).toEqual([]);
  await runs.setSchedulePaused(SESSION, false, local('2026-10-24T12:00:00'));
  await runs.runDueSchedules(local('2026-10-24T12:00:30'), deps);
  expect(queued).toEqual([]);
  await runs.runDueSchedules(local('2026-10-25T09:00:10'), deps);
  expect(queued).toHaveLength(1);
});

it('removes the schedule of a chat that no longer exists, and refuses a schedule that cannot run', async () => {
  const { runs, deps, queued } = await setup({ session: async () => null });
  await runs.saveSchedule({ sessionId: SESSION, text: 'Daily', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00'));
  await runs.runDueSchedules(local('2026-10-24T09:00:10'), deps);
  expect(queued).toEqual([]);
  expect(await runs.listSchedules()).toEqual([]);
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('removed: its chat no longer exists'));
  await expect(runs.saveSchedule({ sessionId: SESSION, text: 'x', repeat: { kind: 'hours', every: 0 }, until: null }, 1)).rejects.toThrow('Choose a schedule that runs at least once an hour apart.');
  await expect(runs.saveSchedule({ sessionId: SESSION, text: '   ', repeat: { kind: 'daily', at: '09:00' }, until: null }, 1)).rejects.toThrow('Write the message to send.');
});

it('keeps the other schedules when one chat cannot be queued, and skips that time once', async () => {
  const other = '2026-10-24-e5f6a7b8';
  const { runs, deps, queued } = await setup({
    session: async id => ({ id, conversationId: `chat-${id}`, activeTurnId: null }),
    enqueue: vi.fn(async input => { if ((input as { sessionId: string }).sessionId === SESSION) throw new Error('queue full'); queued.push(input as never); })
  });
  await runs.saveSchedule({ sessionId: SESSION, text: 'A', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00'));
  await runs.saveSchedule({ sessionId: other, text: 'B', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00'));
  await runs.runDueSchedules(local('2026-10-24T09:00:10'), deps);
  expect(queued).toEqual([expect.objectContaining({ sessionId: other })]);
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('skipped: it could not be queued (queue full)'));
  // Skipped once, not retried and logged every check until the next time.
  await runs.runDueSchedules(local('2026-10-24T09:01:00'), deps);
  expect(vi.mocked(deps.log).mock.calls.filter(([line]) => line.includes('queue full'))).toHaveLength(1);
});

it('is accepted by the real queue, which keeps one row for the same run queued twice', async () => {
  const { initSessionStore, createSession, resetSessionStoreForTests } = await import('../src/main/session/store.js');
  const input = await import('../src/main/session/input.js');
  initSessionStore(dir); input.resetInputForTests();
  input.configureInputDelivery({ changed: () => {}, applyAutomation: async () => {}, recordDelivered: async () => undefined } as never);
  try {
    const session = await createSession({ title: 'Scheduled', conversationId: 'chat-scheduled' } as never);
    const runs = await import('../src/main/scheduled-runs.js');
    const deps: RunnerDeps = {
      session: async id => ({ id, conversationId: null, activeTurnId: null }),
      enqueue: queued => input.enqueueInput(queued), pending: async () => new Set(), log: () => {}
    };
    await runs.saveSchedule({ sessionId: session.id, text: 'Daily check', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00'));
    const durable = await import('../src/main/durable.js');
    const write = vi.spyOn(durable, 'writeDurableNow');
    write.mockImplementationOnce(async (name, value) => { if (name !== 'scheduled-runs') return durable.writeDurableNow(name, value); throw new Error('disk gone'); });
    await runs.runDueSchedules(local('2026-10-24T09:00:10'), deps);
    write.mockRestore();
    await runs.runDueSchedules(local('2026-10-24T09:00:40'), deps);
    const rows = (await input.listInputs()).filter(row => row.sessionId === session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: 'Daily check', scheduled: { dueAt: local('2026-10-24T09:00:00'), late: false } });
  } finally { input.resetInputForTests(); resetSessionStoreForTests(); }
});
