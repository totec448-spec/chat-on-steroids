import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import type { RunnerDeps, ScheduledInputSnapshot } from '../src/main/scheduled-runs.js';

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
    inputs: async () => queued.map(row => ({ id: row.id as string, state: 'queued' as const,
      ...(row.scheduled ? { scheduled: row.scheduled as ScheduledInputSnapshot['scheduled'] } : {}) })),
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

it('skips runs missed while the app was closed, and says which was missed (user decision, Haz on #1826)', async () => {
  const { runs, deps, queued } = await setup();
  await runs.saveSchedule({ sessionId: SESSION, text: 'Daily', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-20T10:00:00'));
  await runs.runDueSchedules(local('2026-10-24T12:00:00'), deps);
  expect(queued).toEqual([]);
  expect(deps.log).toHaveBeenCalledWith(expect.stringMatching(/^scheduled run: 09:00 missed \(the app was closed or asleep\); not caught up \(/));
  expect((await runs.listSchedules()).find(row => row.sessionId === SESSION)).toMatchObject({ lastDueAt: local('2026-10-24T09:00:00'), missedDueAt: local('2026-10-24T09:00:00') });
  // The normal times go on, and an on-time run clears the missed mark.
  await runs.runDueSchedules(local('2026-10-25T09:00:30'), deps);
  expect(queued).toEqual([expect.objectContaining({ scheduled: expect.objectContaining({ dueAt: local('2026-10-25T09:00:00'), late: false }) })]);
  expect((await runs.listSchedules()).find(row => row.sessionId === SESSION)?.missedDueAt).toBeUndefined();
});

it('sends one late run after missed ones, labelled late, when catching up was chosen', async () => {
  const { runs, deps, queued } = await setup();
  await runs.saveSchedule({ sessionId: SESSION, text: 'Daily', repeat: { kind: 'daily', at: '09:00' }, until: null, catchUp: true }, local('2026-10-20T10:00:00'));
  await runs.runDueSchedules(local('2026-10-24T12:00:00'), deps);
  expect(queued).toEqual([expect.objectContaining({ scheduled: expect.objectContaining({ dueAt: local('2026-10-24T09:00:00'), late: true }) })]);
  expect(deps.log).toHaveBeenCalledWith(expect.stringMatching(/^scheduled run: queued for .+ \(late, was due /));
});

it('skips a time while the previous run still waits in the queue, and says so', async () => {
  const { runs, deps, queued } = await setup();
  await runs.saveSchedule({ sessionId: SESSION, text: 'Hourly', repeat: { kind: 'hours', every: 1 }, until: null }, local('2026-10-24T10:00:00'));
  await runs.runDueSchedules(local('2026-10-24T11:00:10'), deps);
  await runs.runDueSchedules(local('2026-10-24T12:00:10'), deps);
  expect(queued).toHaveLength(1);
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('skipped: the previous run still waits'));
  // It is not tried again for that time once the previous one has gone out.
  const delivered = { ...deps, inputs: async () => [] };
  await runs.runDueSchedules(local('2026-10-24T13:00:10'), delivered);
  expect(queued).toHaveLength(2);
});

it('does not enqueue again when a crash leaves the due run in the outbox before the schedule save', async () => {
  const { runs, deps, queued } = await setup();
  await runs.saveSchedule({ sessionId: SESSION, text: 'Daily', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00'));
  const durable = await import('../src/main/durable.js');
  const write = vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('disk gone'));
  await runs.runDueSchedules(local('2026-10-24T09:00:10'), deps);
  write.mockRestore();
  await runs.runDueSchedules(local('2026-10-24T09:00:40'), deps);
  expect(queued).toHaveLength(1);
  expect((await runs.listSchedules())[0]).toMatchObject({ lastDueAt: local('2026-10-24T09:00:00'), lastInputId: queued[0]!.id });
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

it('lists readable schedules, preserves an unreadable chat, and logs only confirmed orphan cleanup', async () => {
  const missing = '2026-10-24-ccccdddd';
  const unreadable = '2026-10-24-eeeeffff';
  const { runs } = await setup();
  await runs.saveSchedule({ sessionId: SESSION, text: 'Hourly', repeat: { kind: 'hours', every: 1 }, until: null }, local('2026-10-24T10:00:00'));
  await runs.saveSchedule({ sessionId: missing, text: 'Orphan', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T10:00:00'));
  await runs.saveSchedule({ sessionId: unreadable, text: 'Keep', repeat: { kind: 'daily', at: '10:00' }, until: null }, local('2026-10-24T10:00:00'));
  const log = vi.fn();
  const items = await runs.listScheduleItems(local('2026-10-24T10:30:00'), {
    session: async id => {
      if (id === unreadable) throw new Error('metadata temporarily unreadable');
      return id === SESSION ? { id, title: 'Release checks' } : null;
    },
    log
  });
  expect(items).toEqual([expect.objectContaining({
    sessionId: SESSION,
    sessionTitle: 'Release checks',
    text: 'Hourly',
    nextRunAt: local('2026-10-24T11:00:00')
  })]);
  expect((await runs.listSchedules()).map(row => row.sessionId)).toEqual([SESSION, unreadable]);
  expect(log).toHaveBeenCalledWith(expect.stringContaining(`removed: its chat no longer exists (${missing})`));
  expect(log).toHaveBeenCalledWith(expect.stringContaining(`could not be read (metadata temporarily unreadable); kept (${unreadable})`));
});

it('continues listing healthy schedules when removing a confirmed orphan fails to save', async () => {
  const missing = '2026-10-24-ccccdddd';
  const { runs } = await setup();
  await runs.saveSchedule({ sessionId: missing, text: 'Orphan', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T10:00:00'));
  await runs.saveSchedule({ sessionId: SESSION, text: 'Healthy', repeat: { kind: 'hours', every: 1 }, until: null }, local('2026-10-24T10:00:00'));
  const durable = await import('../src/main/durable.js');
  const write = vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('disk full'));
  const log = vi.fn();
  const deps = { session: async (id: string) => id === SESSION ? { id, title: 'Healthy chat' } : null, log };
  const items = await runs.listScheduleItems(local('2026-10-24T10:30:00'), deps);
  write.mockRestore();
  expect(items).toEqual([expect.objectContaining({ sessionId: SESSION, sessionTitle: 'Healthy chat' })]);
  expect((await runs.listSchedules()).map(row => row.sessionId)).toEqual([missing, SESSION]);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('could not remove the missing chat\'s schedule (disk full); will retry'));
  expect(log).not.toHaveBeenCalledWith(expect.stringContaining('removed: its chat no longer exists'));
  await runs.listScheduleItems(local('2026-10-24T10:31:00'), deps);
  expect((await runs.listSchedules()).map(row => row.sessionId)).toEqual([SESSION]);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('removed: its chat no longer exists'));
});

it('keeps an ended chat schedule visible in the global list without a future run', async () => {
  const { runs } = await setup();
  const createdAt = local('2026-10-24T10:00:00');
  const until = local('2026-10-24T12:00:00');
  await runs.saveSchedule({ sessionId: SESSION, text: 'Daily report', repeat: { kind: 'daily', at: '11:00' }, until }, createdAt);
  const items = await runs.listScheduleItems(local('2026-10-25T13:00:00'), {
    session: async id => ({ id, title: 'Ended reports' }),
    log: vi.fn()
  });
  expect(items).toEqual([expect.objectContaining({
    sessionId: SESSION, sessionTitle: 'Ended reports', paused: false, until, nextRunAt: null
  })]);
  expect(await runs.listSchedules()).toHaveLength(1);
});

it('runs a schedule now through its chat queue without moving the recurring schedule', async () => {
  const { runs, deps, queued } = await setup({ session: async id => ({ id, conversationId: 'chat-1', activeTurnId: 'turn-1' }) });
  const createdAt = local('2026-10-24T10:00:00');
  const saved = await runs.saveSchedule({ sessionId: SESSION, text: 'Hourly check', repeat: { kind: 'hours', every: 1 }, until: null }, createdAt);
  const now = local('2026-10-24T10:30:00');
  expect(await runs.runScheduleNow(SESSION, now, deps)).toBe(true);
  expect(queued).toEqual([expect.objectContaining({
    sessionId: SESSION,
    text: 'Hourly check',
    mode: 'after-turn',
    dueAt: now,
    scheduled: { scheduleId: saved.id, dueAt: now, late: false }
  })]);
  expect((await runs.listSchedules())[0]).toMatchObject({ createdAt, lastDueAt: null });
  expect((await runs.listSchedules())[0]?.lastInputId).toBe(queued[0]?.id);

  await runs.runDueSchedules(local('2026-10-24T11:00:10'), deps);
  expect(queued).toHaveLength(1);
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('previous run still waits in the queue'));
  expect((await runs.listSchedules())[0]).toMatchObject({ lastDueAt: local('2026-10-24T11:00:00'), lastInputId: queued[0]?.id });
});

it('logs why Run now did not enqueue when that chat has no schedule', async () => {
  const { runs, deps, queued } = await setup();
  expect(await runs.runScheduleNow(SESSION, local('2026-10-24T10:30:00'), deps)).toBe(false);
  expect(queued).toHaveLength(0);
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('not queued now: no schedule exists'));
});

it('replays a durable Run now intent after restart if the process stops before enqueue', async () => {
  const now = local('2026-10-24T10:30:00');
  const { runs } = await setup();
  const saved = await runs.saveSchedule({ sessionId: SESSION, text: 'Hourly check', repeat: { kind: 'hours', every: 1 }, until: null }, local('2026-10-24T10:00:00'));
  const intentId = '11111111-1111-4111-8111-111111111111';
  const durable = await import('../src/main/durable.js');
  await durable.writeDurableNow('scheduled-runs', { version: 1, schedules: [{ ...saved,
    manualRunIntent: { id: intentId, dueAt: now, text: 'Hourly check' } }] });

  vi.resetModules();
  (await import('../src/main/durable.js')).initDurableStore(dir);
  const restarted = await import('../src/main/scheduled-runs.js');
  const replayed: Array<Record<string, unknown>> = [];
  const replayDeps: RunnerDeps = {
    session: async id => ({ id, conversationId: 'chat-1', activeTurnId: null }),
    enqueue: vi.fn(async input => { replayed.push(input as never); }),
    inputs: async () => [],
    log: vi.fn()
  };
  await restarted.runDueSchedules(now + 1_000, replayDeps);
  expect(replayed).toEqual([expect.objectContaining({ id: intentId, text: 'Hourly check',
    scheduled: { scheduleId: saved.id, dueAt: now, late: false } })]);
  expect((await restarted.listSchedules())[0]).toMatchObject({ lastInputId: intentId });
  expect((await restarted.listSchedules())[0]?.manualRunIntent).toBeUndefined();
});

it('reconciles a manual Run now row already written when its enqueue acknowledgement is lost', async () => {
  const now = local('2026-10-24T10:30:00');
  const { runs, deps, queued } = await setup({ enqueue: vi.fn(async input => {
    queued.push(input as never);
    throw new Error('outbox acknowledgement lost');
  }) });
  await runs.saveSchedule({ sessionId: SESSION, text: 'Hourly check', repeat: { kind: 'hours', every: 1 }, until: null }, local('2026-10-24T10:00:00'));
  await expect(runs.runScheduleNow(SESSION, now, deps)).rejects.toThrow('outbox acknowledgement lost');
  const manualId = queued[0]!.id as string;
  expect((await runs.listSchedules())[0]?.manualRunIntent?.id).toBe(manualId);

  const retryEnqueue = vi.fn(async input => { queued.push(input as never); });
  await runs.runDueSchedules(now + 30_000, { ...deps, enqueue: retryEnqueue });
  expect(retryEnqueue).not.toHaveBeenCalled();
  expect(queued).toHaveLength(1);
  expect((await runs.listSchedules())[0]).toMatchObject({ lastInputId: manualId });
  expect((await runs.listSchedules())[0]?.manualRunIntent).toBeUndefined();
});

it('drops a new manual intent when enqueue rejects and a fresh outbox read confirms no row', async () => {
  const { runs, deps } = await setup({ enqueue: vi.fn(async () => { throw new Error('conversation id missing'); }) });
  await runs.saveSchedule({ sessionId: SESSION, text: 'Hourly check', repeat: { kind: 'hours', every: 1 }, until: null }, local('2026-10-24T10:00:00'));
  await expect(runs.runScheduleNow(SESSION, local('2026-10-24T10:30:00'), deps)).rejects.toThrow('conversation id missing');
  expect((await runs.listSchedules())[0]?.manualRunIntent).toBeUndefined();
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('outbox confirms no row, recovery intent dropped'));
});

it('drops a recovered intent when enqueue rejects and a fresh outbox read confirms no row', async () => {
  const { runs, deps } = await setup();
  const now = local('2026-10-24T10:30:00');
  const saved = await runs.saveSchedule({ sessionId: SESSION, text: 'Hourly check', repeat: { kind: 'hours', every: 1 }, until: null }, local('2026-10-24T10:00:00'));
  const intentId = '22222222-2222-4222-8222-222222222222';
  const durable = await import('../src/main/durable.js');
  await durable.writeDurableNow('scheduled-runs', { version: 1, schedules: [{ ...saved,
    manualRunIntent: { id: intentId, dueAt: now, text: 'Hourly check' } }] });
  const inputs = vi.fn(async () => []);
  const enqueue = vi.fn(async () => { throw new Error('session has no conversation id'); });

  await runs.runDueSchedules(now + 1_000, { ...deps, inputs, enqueue });
  expect(inputs).toHaveBeenCalledTimes(2);
  expect(enqueue).toHaveBeenCalledOnce();
  expect((await runs.listSchedules())[0]?.manualRunIntent).toBeUndefined();
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('outbox confirms no row, recovery intent dropped'));
});

it('treats a repeated Run now click as acknowledgement of the recovered request, not a second run', async () => {
  const now = local('2026-10-24T10:30:00');
  const rows: ScheduledInputSnapshot[] = [];
  const queued: Array<Record<string, unknown>> = [];
  let reads = 0;
  let failFirstEnqueue = true;
  const { runs, deps } = await setup({
    enqueue: vi.fn(async input => {
      if (failFirstEnqueue) { failFirstEnqueue = false; throw new Error('outbox unavailable'); }
      queued.push(input as never);
      rows.push({ id: input.id, state: 'queued', scheduled: input.scheduled });
    }),
    inputs: async () => {
      reads++;
      if (reads === 1) throw new Error('outbox read unavailable');
      return rows;
    }
  });
  await runs.saveSchedule({ sessionId: SESSION, text: 'Hourly check', repeat: { kind: 'hours', every: 1 }, until: null }, local('2026-10-24T10:00:00'));
  await expect(runs.runScheduleNow(SESSION, now, deps)).rejects.toThrow('outbox unavailable');
  const intentId = (await runs.listSchedules())[0]!.manualRunIntent!.id;
  const retryEnqueue = vi.fn(async input => {
    queued.push(input as never);
    rows.push({ id: input.id, state: 'queued', scheduled: input.scheduled });
  });
  expect(await runs.runScheduleNow(SESSION, now + 1_000, { ...deps, enqueue: retryEnqueue })).toBe(true);
  expect(retryEnqueue).toHaveBeenCalledOnce();
  expect(queued).toHaveLength(1);
  expect(queued[0]?.id).toBe(intentId);
  expect((await runs.listSchedules())[0]?.manualRunIntent).toBeUndefined();
});

it('logs a failed session read for Run now and retains the schedule', async () => {
  const { runs, deps } = await setup({ session: async () => { throw new Error('metadata unreadable'); } });
  await runs.saveSchedule({ sessionId: SESSION, text: 'Hourly check', repeat: { kind: 'hours', every: 1 }, until: null }, local('2026-10-24T10:00:00'));
  await expect(runs.runScheduleNow(SESSION, local('2026-10-24T10:30:00'), deps)).rejects.toThrow('metadata unreadable');
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('not queued now: its chat could not be read'));
  expect(await runs.listSchedules()).toHaveLength(1);
});

it('keeps an older pending scheduled run as a blocker after the newest manual run is cancelled', async () => {
  const { runs, deps, queued } = await setup();
  const saved = await runs.saveSchedule({ sessionId: SESSION, text: 'Hourly check', repeat: { kind: 'hours', every: 1 }, until: null }, local('2026-10-24T10:00:00'));
  await runs.runDueSchedules(local('2026-10-24T11:00:10'), deps);
  const automatic = queued[0]!;
  await runs.runScheduleNow(SESSION, local('2026-10-24T11:30:00'), deps);
  const manual = queued[1]!;
  const inputs: ScheduledInputSnapshot[] = [
    { id: automatic.id as string, state: 'queued', scheduled: automatic.scheduled as ScheduledInputSnapshot['scheduled'] },
    { id: manual.id as string, state: 'cancelled', scheduled: manual.scheduled as ScheduledInputSnapshot['scheduled'] }
  ];
  await runs.runDueSchedules(local('2026-10-24T12:00:10'), { ...deps, inputs: async () => inputs });
  expect(queued).toHaveLength(2);
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('previous run still waits in the queue'));
  expect((await runs.listSchedules())[0]).toMatchObject({ id: saved.id, lastInputId: automatic.id, lastDueAt: local('2026-10-24T12:00:00') });
});

it('keeps Run now repeatable and tracks the newest manual row when an automatic run is already pending', async () => {
  const { runs, deps, queued } = await setup();
  await runs.saveSchedule({ sessionId: SESSION, text: 'Hourly check', repeat: { kind: 'hours', every: 1 }, until: null }, local('2026-10-24T10:00:00'));
  await runs.runDueSchedules(local('2026-10-24T11:00:10'), deps);
  const automaticId = queued[0]!.id as string;
  expect(await runs.runScheduleNow(SESSION, local('2026-10-24T11:30:00'), deps)).toBe(true);
  const firstManualId = queued[1]!.id as string;
  expect(await runs.runScheduleNow(SESSION, local('2026-10-24T11:31:00'), deps)).toBe(true);
  const newestManualId = queued[2]!.id as string;
  expect(new Set([automaticId, firstManualId, newestManualId]).size).toBe(3);
  expect((await runs.listSchedules())[0]?.lastInputId).toBe(newestManualId);

  await runs.runDueSchedules(local('2026-10-24T12:00:10'), {
    ...deps
  });
  expect(queued).toHaveLength(3);
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('previous run still waits in the queue'));
});

it('a manual Run now pending in the input outbox prevents a duplicate at the next scheduled time', async () => {
  const { runs, deps, queued } = await setup();
  const createdAt = local('2026-10-24T10:00:00');
  await runs.saveSchedule({ sessionId: SESSION, text: 'Hourly check', repeat: { kind: 'hours', every: 1 }, until: null }, createdAt);
  const now = local('2026-10-24T10:30:00');
  expect(await runs.runScheduleNow(SESSION, now, deps)).toBe(true);
  const manualId = queued[0]?.id as string;
  await runs.runDueSchedules(local('2026-10-24T11:00:10'), deps);
  expect(queued).toHaveLength(1);
  expect((await runs.listSchedules())[0]).toMatchObject({ lastDueAt: local('2026-10-24T11:00:00'), lastInputId: manualId });
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('previous run still waits in the queue'));
});

it('Run now removes a schedule whose chat is proven gone', async () => {
  const { runs, deps, queued } = await setup({ session: async () => null });
  await runs.saveSchedule({ sessionId: SESSION, text: 'Daily', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00'));
  expect(await runs.runScheduleNow(SESSION, local('2026-10-24T08:30:00'), deps)).toBe(false);
  expect(queued).toEqual([]);
  expect(await runs.listSchedules()).toEqual([]);
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('removed: its chat no longer exists'));
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
      enqueue: queued => input.enqueueInput(queued),
      inputs: async () => (await input.listInputs()).map(({ id, state, scheduled }) => ({ id, state, scheduled })),
      log: () => {}
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
    // The retry is the same run, so the schedule records it as sent and the next time can see it waiting (CodeRabbit).
    expect((await runs.listSchedules())[0]).toMatchObject({ lastInputId: rows[0]!.id, lastDueAt: local('2026-10-24T09:00:00') });
  } finally { input.resetInputForTests(); resetSessionStoreForTests(); }
});

it('reconciles a Run now intent against the real outbox after enqueue commits but its acknowledgement is lost', async () => {
  const { initSessionStore, createSession, resetSessionStoreForTests } = await import('../src/main/session/store.js');
  const input = await import('../src/main/session/input.js');
  initSessionStore(dir); input.resetInputForTests();
  input.configureInputDelivery({ changed: () => {}, applyAutomation: async () => {}, recordDelivered: async () => undefined } as never);
  try {
    const session = await createSession({ title: 'Scheduled manual recovery', conversationId: 'chat-scheduled-manual' } as never);
    const runs = await import('../src/main/scheduled-runs.js');
    let loseAcknowledgement = true;
    const deps: RunnerDeps = {
      session: async id => ({ id, conversationId: 'chat-scheduled-manual', activeTurnId: null }),
      enqueue: async queued => {
        const row = await input.enqueueInput(queued);
        if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('outbox acknowledgement lost'); }
        return row;
      },
      inputs: async () => (await input.listInputs()).map(({ id, state, scheduled }) => ({ id, state, scheduled })),
      log: vi.fn()
    };
    await runs.saveSchedule({ sessionId: session.id, text: 'Manual recovery', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00'));
    await expect(runs.runScheduleNow(session.id, local('2026-10-24T08:30:00'), deps)).rejects.toThrow('outbox acknowledgement lost');
    const intentId = (await runs.listSchedules())[0]!.manualRunIntent!.id;
    expect((await input.listInputs()).filter(row => row.sessionId === session.id)).toHaveLength(1);

    await runs.runDueSchedules(local('2026-10-24T08:31:00'), deps);
    const rows = (await input.listInputs()).filter(row => row.sessionId === session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: intentId, text: 'Manual recovery', scheduled: { scheduleId: (await runs.listSchedules())[0]!.id, late: false } });
    expect((await runs.listSchedules())[0]?.manualRunIntent).toBeUndefined();
  } finally { input.resetInputForTests(); resetSessionStoreForTests(); }
});

it('starts empty without a saved file, keeps the good schedules of a damaged one, and never overwrites a newer version\'s', async () => {
  const { runs, deps, queued } = await setup();
  expect(await runs.listSchedules()).toEqual([]);
  const durable = await import('../src/main/durable.js');
  const good = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', sessionId: SESSION, text: 'Daily', repeat: { kind: 'daily', at: '09:00' },
    until: null, paused: false, createdAt: local('2026-10-24T08:00:00'), lastDueAt: null };
  await durable.writeDurableNow('scheduled-runs', { version: 1, schedules: [good, { ...good, id: 'not-a-uuid' }, { ...good, repeat: { kind: 'hours', every: 0 } }, 'garbage'] });
  expect((await runs.listSchedules()).map(row => row.id)).toEqual([good.id]);
  await runs.runDueSchedules(local('2026-10-24T09:00:10'), deps);
  expect(queued).toHaveLength(1);
  // A broken file of this version reads as none and may be replaced.
  await durable.writeDurableNow('scheduled-runs', { version: 1, schedules: 'broken' });
  expect(await runs.listSchedules()).toEqual([]);
  await runs.saveSchedule({ sessionId: SESSION, text: 'Again', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-25T08:00:00'));
  expect(await runs.listSchedules()).toHaveLength(1);
  // A newer version's file reads as none here, and is never overwritten by this version.
  await durable.writeDurableNow('scheduled-runs', { version: 2, schedules: 'x' });
  expect(await runs.listSchedules()).toEqual([]);
  await expect(runs.saveSchedule({ sessionId: SESSION, text: 'x', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-25T08:00:00')))
    .rejects.toThrow('These schedules were saved by a newer version of Chat On Steroids. Update the app to change them.');
  expect(await durable.readDurable('scheduled-runs')).toEqual({ version: 2, schedules: 'x' });
});

it('refuses a change rather than overwrite schedules it could not read, and treats only a damaged file as empty (CodeRabbit)', async () => {
  const { runs } = await setup();
  await runs.saveSchedule({ sessionId: SESSION, text: 'Keep me', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00'));
  const durable = await import('../src/main/durable.js');
  // As the real reader does on EBUSY/EACCES: null unless asked to be strict, then an error that is not "damaged".
  const read = vi.spyOn(durable, 'readDurable').mockImplementationOnce(async (_name, options) => {
    if (options?.strict) throw new Error('Could not read scheduled-runs state');
    return null;
  });
  await expect(runs.saveSchedule({ sessionId: '2026-10-24-ffffffff', text: 'Other', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00')))
    .rejects.toThrow(/Could not read/);
  read.mockRestore();
  expect((await runs.listSchedules()).map(row => row.text)).toEqual(['Keep me']);
});

it('removes a deleted chat\'s schedule even while it is paused, and keeps one whose chat could not be read (CodeRabbit)', async () => {
  let gone = false, unreadable = false;
  const { runs, deps } = await setup({ session: async id => {
    if (unreadable) throw new Error('metadata could not be read');
    return id === SESSION && !gone ? { id, conversationId: 'chat-1', activeTurnId: null } : null;
  } });
  await runs.saveSchedule({ sessionId: SESSION, text: 'Paused one', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00'));
  await runs.setSchedulePaused(SESSION, true, local('2026-10-24T08:10:00'));
  unreadable = true;
  await runs.runDueSchedules(local('2026-10-24T08:20:00'), deps);
  expect(await runs.listSchedules()).toHaveLength(1);
  unreadable = false; gone = true;
  await runs.runDueSchedules(local('2026-10-24T08:20:30'), deps);
  expect(await runs.listSchedules()).toEqual([]);
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('removed: its chat no longer exists'));
});

// CodeRabbit on #1835: a run missed before the end date is never sent, and that is now said once.
it('says once that a run missed before the end date is not sent, and stays quiet while waiting or paused', async () => {
  const { runs, deps, queued } = await setup();
  await runs.saveSchedule({ sessionId: SESSION, text: 'Daily', repeat: { kind: 'daily', at: '09:00' }, until: local('2026-10-22T23:00:00') }, local('2026-10-20T10:00:00'));
  await runs.runDueSchedules(local('2026-10-20T12:00:00'), deps);
  expect(deps.log).not.toHaveBeenCalled();
  await runs.runDueSchedules(local('2026-10-24T12:00:00'), deps);
  expect(queued).toEqual([]);
  expect(deps.log).toHaveBeenCalledTimes(1);
  expect(deps.log).toHaveBeenCalledWith(expect.stringMatching(/^scheduled run: 09:00 not sent: the schedule ended before it could run \(/));
  expect((await runs.listSchedules()).find(row => row.sessionId === SESSION)).toMatchObject({ lastDueAt: local('2026-10-22T09:00:00'), missedDueAt: local('2026-10-22T09:00:00') });
  await runs.runDueSchedules(local('2026-10-25T12:00:00'), deps);
  expect(deps.log).toHaveBeenCalledTimes(1);
});

