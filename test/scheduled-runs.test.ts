import { promises as fs } from 'node:fs';
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
  const changed = vi.fn();
  const { runs, deps, queued } = await setup({ changed });
  await runs.saveSchedule({ sessionId: SESSION, text: 'Daily', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-20T10:00:00'));
  await runs.runDueSchedules(local('2026-10-24T12:00:00'), deps);
  expect(queued).toEqual([]);
  expect(deps.log).toHaveBeenCalledWith('scheduled run: 09:00 missed (the app was closed or asleep); not caught up');
  expect(changed).toHaveBeenCalledOnce();
  expect((await runs.listSchedules()).find(row => row.sessionId === SESSION)).toMatchObject({ lastDueAt: local('2026-10-24T09:00:00'), missedDueAt: local('2026-10-24T09:00:00') });
  const projected = await runs.listScheduleItems(local('2026-10-24T12:00:00'), {
    session: async id => ({ id, title: 'Daily report' }), inputs: deps.inputs, log: vi.fn()
  });
  expect(projected[0]?.missedDueAt).toBe(local('2026-10-24T09:00:00'));
  // The normal times go on, and an on-time run clears the missed mark.
  await runs.runDueSchedules(local('2026-10-25T09:00:30'), deps);
  expect(queued).toEqual([expect.objectContaining({ scheduled: expect.objectContaining({ dueAt: local('2026-10-25T09:00:00'), late: false }) })]);
  expect(changed).toHaveBeenCalledTimes(2);
  expect((await runs.listSchedules()).find(row => row.sessionId === SESSION)?.missedDueAt).toBeUndefined();
});

it('keeps a persisted schedule change when notifying the renderer fails', async () => {
  const changed = vi.fn(() => { throw new Error('/private/user-data/window-destroyed'); });
  const { runs, deps } = await setup({ changed });
  await runs.saveSchedule({ sessionId: SESSION, text: 'Daily', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-20T10:00:00'));

  await runs.runDueSchedules(local('2026-10-24T12:00:00'), deps);
  expect((await runs.listSchedules())[0]?.missedDueAt).toBe(local('2026-10-24T09:00:00'));
  expect(deps.log).toHaveBeenCalledWith('scheduled run: schedule change notification failed (operation failed)');
  expect(vi.mocked(deps.log).mock.calls.flat().join('\n')).not.toContain('/private/user-data');
});

it('notifies the global list only after a failed automatic schedule save is durably retried', async () => {
  const changed = vi.fn();
  const { runs, deps } = await setup({ changed });
  await runs.saveSchedule({ sessionId: SESSION, text: 'Daily', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-20T10:00:00'));
  const durable = await import('../src/main/durable.js');
  const failure = Object.assign(new Error('injected rename failure'), { code: 'EIO' });
  const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(failure);

  await runs.runDueSchedules(local('2026-10-24T12:00:00'), deps);
  expect(changed).not.toHaveBeenCalled();
  expect((await runs.listSchedules())[0]?.missedDueAt).toBeUndefined();

  rename.mockRestore();
  await durable.flushDurable();

  expect(changed).toHaveBeenCalledOnce();
  expect((await runs.listSchedules())[0]?.missedDueAt).toBe(local('2026-10-24T09:00:00'));
});

it('notifies after the schedule save following a confirmed enqueue is durably retried', async () => {
  const changed = vi.fn();
  const { initSessionStore, createSession, resetSessionStoreForTests } = await import('../src/main/session/store.js');
  const input = await import('../src/main/session/input.js');
  initSessionStore(dir); input.resetInputForTests();
  input.configureInputDelivery({ changed: () => {}, applyAutomation: async () => {}, recordDelivered: async () => undefined } as never);
  try {
    const session = await createSession({ title: 'Scheduled retry notification', conversationId: 'chat-scheduled-notify' } as never);
    const runs = await import('../src/main/scheduled-runs.js');
    const deps: RunnerDeps = {
      session: async id => ({ id, conversationId: 'chat-scheduled-notify', activeTurnId: null }),
      enqueue: (queued, options) => input.enqueueInput(queued, undefined, options),
      inputs: async () => (await input.listInputs()).map(({ id, state, deliveredAt, scheduled }) => ({ id, state, deliveredAt, scheduled })),
      log: vi.fn(),
      changed
    };
    await runs.saveSchedule({ sessionId: session.id, text: 'Daily check', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-23T10:00:00'));
    const realRename = fs.rename.bind(fs);
    const failure = Object.assign(new Error('injected schedule rename failure'), { code: 'EIO' });
    let failScheduleSave = true;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (failScheduleSave && String(to).endsWith('scheduled-runs.json')) {
        failScheduleSave = false;
        throw failure;
      }
      return realRename(from, to);
    });

    await runs.runDueSchedules(local('2026-10-24T09:00:10'), deps);
    expect((await input.listInputs()).filter(row => row.sessionId === session.id)).toHaveLength(1);
    expect(changed).not.toHaveBeenCalled();
    expect((await runs.listSchedules())[0]?.lastInputId).toBeUndefined();

    rename.mockRestore();
    await (await import('../src/main/durable.js')).flushDurable();

    expect(changed).toHaveBeenCalledOnce();
    expect((await runs.listSchedules())[0]).toMatchObject({
      lastDueAt: local('2026-10-24T09:00:00'),
      lastInputId: (await input.listInputs()).find(row => row.sessionId === session.id)?.id
    });
  } finally { input.resetInputForTests(); resetSessionStoreForTests(); }
});

it('sends one late run after missed ones, labelled late, when catching up was chosen', async () => {
  const { runs, deps, queued } = await setup();
  await runs.saveSchedule({ sessionId: SESSION, text: 'Daily', repeat: { kind: 'daily', at: '09:00' }, until: null, catchUp: true }, local('2026-10-20T10:00:00'));
  await runs.runDueSchedules(local('2026-10-24T12:00:00'), deps);
  expect(queued).toEqual([expect.objectContaining({ scheduled: expect.objectContaining({ dueAt: local('2026-10-24T09:00:00'), late: true }) })]);
  expect(deps.log).toHaveBeenCalledWith('scheduled run: queued (late, was due 09:00)');
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
    inputs: async () => [],
    log
  });
  expect(items).toEqual([expect.objectContaining({
    sessionId: SESSION,
    sessionTitle: 'Release checks',
    text: 'Hourly',
    nextRunAt: local('2026-10-24T11:00:00')
  })]);
  expect((await runs.listSchedules()).map(row => row.sessionId)).toEqual([SESSION, unreadable]);
  expect(log).toHaveBeenCalledWith('scheduled run: removed: its chat no longer exists');
  expect(log).toHaveBeenCalledWith('scheduled run: its chat could not be read (operation failed); kept');
  expect(vi.mocked(log).mock.calls.flat().join('\n')).not.toContain(unreadable);
});

it('continues listing healthy schedules when removing a confirmed orphan fails to save', async () => {
  const missing = '2026-10-24-ccccdddd';
  const { runs } = await setup();
  await runs.saveSchedule({ sessionId: missing, text: 'Orphan', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T10:00:00'));
  await runs.saveSchedule({ sessionId: SESSION, text: 'Healthy', repeat: { kind: 'hours', every: 1 }, until: null }, local('2026-10-24T10:00:00'));
  const durable = await import('../src/main/durable.js');
  const write = vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('disk full'));
  const log = vi.fn();
  const deps = { session: async (id: string) => id === SESSION ? { id, title: 'Healthy chat' } : null, inputs: async () => [], log };
  const items = await runs.listScheduleItems(local('2026-10-24T10:30:00'), deps);
  write.mockRestore();
  expect(items).toEqual([expect.objectContaining({ sessionId: SESSION, sessionTitle: 'Healthy chat' })]);
  expect((await runs.listSchedules()).map(row => row.sessionId)).toEqual([missing, SESSION]);
  expect(log).toHaveBeenCalledWith('scheduled run: could not remove the missing chat\'s schedule (operation failed); will retry');
  expect(log).not.toHaveBeenCalledWith(expect.stringContaining('removed: its chat no longer exists'));
  await runs.listScheduleItems(local('2026-10-24T10:31:00'), deps);
  expect((await runs.listSchedules()).map(row => row.sessionId)).toEqual([SESSION]);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('removed: its chat no longer exists'));
});

it('keeps an old cancelled scheduled send blocked until its delivery receipt is recorded', async () => {
  const dueAt = local('2026-10-24T09:00:00');
  const oldInput: ScheduledInputSnapshot = {
    id: 'old-cancelled-scheduled-input',
    state: 'cancelled',
    sendAuthorizedAt: dueAt,
    deliveryProof: 'unconfirmed',
    scheduled: { scheduleId: '00000000-0000-4000-8000-000000000001', dueAt, late: false }
  };
  let outbox: ScheduledInputSnapshot[] = [oldInput];
  const { runs } = await setup({ inputs: async () => outbox });
  const saved = await runs.saveSchedule({
    sessionId: SESSION, text: 'Do not duplicate', repeat: { kind: 'hours', every: 1 }, until: null
  }, dueAt - 60 * 60_000);
  outbox = [{ ...oldInput, scheduled: { ...oldInput.scheduled!, scheduleId: saved.id } }];
  const deps = {
    session: async (id: string) => ({ id, title: 'Scheduled chat' }),
    inputs: async () => outbox,
    log: vi.fn()
  };

  const oldProjection = await runs.listScheduleItems(dueAt + 7 * 24 * 60 * 60_000, deps);
  expect(oldProjection[0]).toMatchObject({ deliveryBlock: 'unconfirmed' });
  // Even much later, elapsed time is not evidence that an authorized Send was not delivered.
  const stillUnconfirmed = await runs.listScheduleItems(dueAt + 30 * 24 * 60 * 60_000, deps);
  expect(stillUnconfirmed[0]).toMatchObject({ deliveryBlock: 'unconfirmed' });

  outbox = [{ ...outbox[0]!, deliveredAt: dueAt + 1, deliveryProof: 'sent' }];
  const confirmed = await runs.listScheduleItems(dueAt + 30 * 24 * 60 * 60_000, deps);
  expect(confirmed[0]).not.toHaveProperty('deliveryBlock');
});

it('does not report a missing-chat schedule removed until its durable deletion succeeds', async () => {
  const changed = vi.fn();
  const { runs, deps } = await setup({ session: async () => null, changed });
  await runs.saveSchedule({ sessionId: SESSION, text: 'Orphan', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T10:00:00'));
  const durable = await import('../src/main/durable.js');
  const write = vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('disk full'));

  await runs.runDueSchedules(local('2026-10-24T10:30:00'), deps);
  write.mockRestore();
  expect(deps.log).toHaveBeenCalledWith('scheduled run: could not remove the missing chat\'s schedule (operation failed); will retry');
  expect(deps.log).not.toHaveBeenCalledWith('scheduled run: removed: its chat no longer exists');
  expect(changed).not.toHaveBeenCalled();
  expect(await runs.listSchedules()).toHaveLength(1);

  await runs.runDueSchedules(local('2026-10-24T10:31:00'), deps);
  expect(deps.log).toHaveBeenCalledWith('scheduled run: removed: its chat no longer exists');
  expect(changed).toHaveBeenCalledOnce();
  expect(await runs.listSchedules()).toEqual([]);
});

it('does not carry a failed orphan deletion into a later schedule save', async () => {
  const orphan = '2026-10-24-ccccdddd';
  const changed = vi.fn();
  const { runs, deps, queued } = await setup({
    session: async id => id === SESSION ? { id, conversationId: 'chat-1', activeTurnId: null } : null,
    changed
  });
  await runs.saveSchedule({ sessionId: orphan, text: 'Orphan', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00'));
  await runs.saveSchedule({ sessionId: SESSION, text: 'Healthy', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00'));
  const durable = await import('../src/main/durable.js');
  const originalWrite = durable.writeDurableNow;
  let failOrphanRemoval = true;
  const write = vi.spyOn(durable, 'writeDurableNow').mockImplementation(async (name, value, options) => {
    if (name === 'scheduled-runs' && failOrphanRemoval) {
      failOrphanRemoval = false;
      throw new Error('disk full');
    }
    return originalWrite(name, value, options);
  });

  await runs.runDueSchedules(local('2026-10-24T09:00:10'), deps);
  write.mockRestore();

  expect(deps.log).toHaveBeenCalledWith('scheduled run: could not remove the missing chat\'s schedule (operation failed); will retry');
  expect(deps.log).not.toHaveBeenCalledWith('scheduled run: removed: its chat no longer exists');
  expect(queued).toHaveLength(1);
  expect((await runs.listSchedules()).map(row => row.sessionId)).toEqual([orphan, SESSION]);
  expect((await runs.listSchedules())[1]).toMatchObject({ lastDueAt: local('2026-10-24T09:00:00'), lastInputId: queued[0]?.id });
  expect(changed).toHaveBeenCalledOnce();
});

it('keeps an ended chat schedule visible in the global list without a future run', async () => {
  const { runs } = await setup();
  const createdAt = local('2026-10-24T10:00:00');
  const until = local('2026-10-24T12:00:00');
  await runs.saveSchedule({ sessionId: SESSION, text: 'Daily report', repeat: { kind: 'daily', at: '11:00' }, until }, createdAt);
  const items = await runs.listScheduleItems(local('2026-10-25T13:00:00'), {
    session: async id => ({ id, title: 'Ended reports' }),
    inputs: async () => [],
    log: vi.fn()
  });
  expect(items).toEqual([expect.objectContaining({
    sessionId: SESSION, sessionTitle: 'Ended reports', paused: false, until, nextRunAt: null
  })]);
  expect(await runs.listSchedules()).toHaveLength(1);
});

it('bounds the global list text preview without truncating the saved message', async () => {
  const { runs } = await setup();
  const text = '🙂'.repeat(500);
  await runs.saveSchedule({ sessionId: SESSION, text, repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00'));
  const items = await runs.listScheduleItems(local('2026-10-24T08:30:00'), {
    session: async id => ({ id, title: 'Long schedule' }),
    inputs: async () => [],
    log: vi.fn()
  });
  expect(items[0]?.text.length).toBeLessThanOrEqual(320);
  expect(items[0]?.text.endsWith('…')).toBe(true);
  expect((await runs.listSchedules())[0]?.text).toBe(text);
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

it('clears a missed marker when a manual Run now is successfully queued without advancing recurrence', async () => {
  const changed = vi.fn();
  const { runs, deps, queued } = await setup({ changed });
  const saved = await runs.saveSchedule({ sessionId: SESSION, text: 'Daily check', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-20T10:00:00'));
  await runs.runDueSchedules(local('2026-10-24T12:00:00'), deps);
  const missed = (await runs.listSchedules())[0]!;
  expect(missed.missedDueAt).toBe(local('2026-10-24T09:00:00'));
  changed.mockClear();

  expect(await runs.runScheduleNow(SESSION, local('2026-10-24T12:30:00'), deps)).toBe(true);
  const after = (await runs.listSchedules())[0]!;
  expect(after.id).toBe(saved.id);
  expect(after.lastDueAt).toBe(missed.lastDueAt);
  expect(after.missedDueAt).toBeUndefined();
  expect(queued).toHaveLength(1);
  expect(deps.enqueue).toHaveBeenCalledWith(expect.objectContaining({ scheduled: expect.objectContaining({ scheduleId: saved.id }) }), { notify: false });
  expect(changed).toHaveBeenCalledOnce();
});

it('logs why Run now did not enqueue when that chat has no schedule', async () => {
  const { runs, deps, queued } = await setup();
  expect(await runs.runScheduleNow(SESSION, local('2026-10-24T10:30:00'), deps)).toBe(false);
  expect(queued).toHaveLength(0);
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('not queued now: no schedule exists'));
});

it('supersedes a failed manual-intent write with the prior snapshot before returning', async () => {
  const { runs, deps } = await setup();
  await runs.saveSchedule({ sessionId: SESSION, text: 'Hourly check', repeat: { kind: 'hours', every: 1 }, until: null }, local('2026-10-24T10:00:00'));
  const durable = await import('../src/main/durable.js');
  const failRename = async () => { throw Object.assign(new Error('/private/state/scheduled-runs.json'), { code: 'EIO' }); };
  const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(failRename).mockImplementationOnce(failRename);
  await expect(runs.runScheduleNow(SESSION, local('2026-10-24T10:30:00'), deps)).rejects.toThrow('/private/state/scheduled-runs.json');
  rename.mockRestore();

  expect(deps.enqueue).not.toHaveBeenCalled();
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('EIO'));
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('previous snapshot queued for recovery'));
  const logs = vi.mocked(deps.log).mock.calls.map(([line]) => line).join('\n');
  expect(logs).not.toContain('/private/state/scheduled-runs.json');
  expect(logs).not.toContain(SESSION);
  // Shutdown flushes the latest durable generation. It must be the old schedule, not the
  // rejected intent left behind by the first failed rename.
  await durable.flushDurable();
  expect((await runs.listSchedules())[0]?.manualRunIntent).toBeUndefined();
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

it('does not log local paths or chat ids when a manual enqueue fails', async () => {
  const privatePath = '/Users/private/Library/Application Support/Chat On Steroids/state/scheduled-runs.json';
  const { runs, deps } = await setup({ enqueue: vi.fn(async () => { throw new Error(privatePath); }) });
  await runs.saveSchedule({ sessionId: SESSION, text: 'Hourly check', repeat: { kind: 'hours', every: 1 }, until: null }, local('2026-10-24T10:00:00'));
  await expect(runs.runScheduleNow(SESSION, local('2026-10-24T10:30:00'), deps)).rejects.toThrow(privatePath);
  const logs = vi.mocked(deps.log).mock.calls.map(([line]) => line).join('\n');
  expect(logs).toContain('operation failed');
  expect(logs).not.toContain(privatePath);
  expect(logs).not.toContain(SESSION);
  expect(runs.safeFailureReason(Object.assign(new Error(privatePath), { code: 'PRIVATE_CHAT_ID' }))).toBe('operation failed');
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

it('does not log a chat id when a recovered manual intent has already failed', async () => {
  const { runs, deps } = await setup();
  const saved = await runs.saveSchedule({ sessionId: SESSION, text: 'Hourly check', repeat: { kind: 'hours', every: 1 }, until: null }, local('2026-10-24T10:00:00'));
  const intentId = '55555555-5555-4555-8555-555555555555';
  const durable = await import('../src/main/durable.js');
  await durable.writeDurableNow('scheduled-runs', { version: 1, schedules: [{ ...saved,
    manualRunIntent: { id: intentId, dueAt: local('2026-10-24T10:15:00'), text: saved.text } }] });
  const inputs: ScheduledInputSnapshot[] = [{ id: intentId, state: 'failed', scheduled: {
    scheduleId: saved.id, dueAt: local('2026-10-24T10:15:00'), late: false
  } }];

  await runs.runDueSchedules(local('2026-10-24T10:30:00'), { ...deps, inputs: async () => inputs });
  expect(deps.log).toHaveBeenCalledWith('scheduled run: manual run ended before delivery (failed); cleared its recovery intent');
  expect(vi.mocked(deps.log).mock.calls.flat().join('\n')).not.toContain(SESSION);
  expect((await runs.listSchedules())[0]?.manualRunIntent).toBeUndefined();
});

it('notifies the global list when background recovery clears a missed marker from a pending manual run', async () => {
  const changed = vi.fn();
  const { runs, deps } = await setup({ changed });
  const saved = await runs.saveSchedule({ sessionId: SESSION, text: 'Daily check', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-20T10:00:00'));
  await runs.runDueSchedules(local('2026-10-24T12:00:00'), deps);
  expect((await runs.listSchedules())[0]?.missedDueAt).toBe(local('2026-10-24T09:00:00'));

  const intentId = '66666666-6666-4666-8666-666666666666';
  const dueAt = local('2026-10-24T12:15:00');
  const durable = await import('../src/main/durable.js');
  const current = (await runs.listSchedules())[0]!;
  await durable.writeDurableNow('scheduled-runs', { version: 1, schedules: [{ ...current,
    manualRunIntent: { id: intentId, dueAt, text: saved.text } }] });
  changed.mockClear();
  const inputs: ScheduledInputSnapshot[] = [{ id: intentId, state: 'queued', scheduled: { scheduleId: saved.id, dueAt, late: false } }];

  await runs.runDueSchedules(local('2026-10-24T12:16:00'), { ...deps, inputs: async () => inputs });
  expect((await runs.listSchedules())[0]?.missedDueAt).toBeUndefined();
  expect(changed).toHaveBeenCalledOnce();
});

it('notifies after durable recovery of a notify-false manual outbox row without a missed marker', async () => {
  const changed = vi.fn();
  const outboxChanged = vi.fn();
  const { initSessionStore, createSession, getSession, resetSessionStoreForTests } = await import('../src/main/session/store.js');
  const input = await import('../src/main/session/input.js');
  initSessionStore(dir); input.resetInputForTests();
  input.configureInputDelivery({ changed: outboxChanged, applyAutomation: async () => {}, recordDelivered: async () => undefined } as never);
  try {
    const session = await createSession({ title: 'Manual recovery without missed state', conversationId: 'chat-scheduled-manual-no-missed' } as never);
    const runs = await import('../src/main/scheduled-runs.js');
    const saved = await runs.saveSchedule({ sessionId: session.id, text: 'Manual recovery', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00'));
    const intentId = 'abababab-abab-4bab-8bab-abababababab';
    const dueAt = local('2026-10-24T08:30:00');
    const durable = await import('../src/main/durable.js');
    await durable.writeDurableNow('scheduled-runs', { version: 1, schedules: [{ ...saved,
      manualRunIntent: { id: intentId, dueAt, text: saved.text } }] });
    await input.enqueueInput({ id: intentId, sessionId: session.id, text: saved.text, mode: 'auto', dueAt,
      model: null, reasoningEffort: null, scheduled: { scheduleId: saved.id, dueAt, late: false } }, undefined, { notify: false });
    expect(outboxChanged).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();

    await runs.runDueSchedules(local('2026-10-24T08:31:00'), {
      session: async id => {
        const current = await getSession(id);
        return current ? { id, conversationId: current.conversationId ?? null, activeTurnId: current.activeTurnId ?? null } : null;
      },
      enqueue: vi.fn(),
      inputs: async () => (await input.listInputs()).map(({ id, state, deliveredAt, scheduled }) => ({ id, state, deliveredAt, scheduled })),
      log: vi.fn(),
      changed
    });

    expect(changed).toHaveBeenCalledOnce();
    expect(outboxChanged).not.toHaveBeenCalled();
    expect((await runs.listSchedules())[0]).toMatchObject({ lastInputId: intentId });
    expect((await runs.listSchedules())[0]?.manualRunIntent).toBeUndefined();
  } finally { input.resetInputForTests(); resetSessionStoreForTests(); }
});

it('treats a cancelled manual outbox row with a late delivery ACK as sent during recovery', async () => {
  const changed = vi.fn();
  const { runs, deps } = await setup({ changed });
  const saved = await runs.saveSchedule({ sessionId: SESSION, text: 'Daily check', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-20T10:00:00'));
  await runs.runDueSchedules(local('2026-10-24T12:00:00'), deps);
  expect((await runs.listSchedules())[0]?.missedDueAt).toBe(local('2026-10-24T09:00:00'));

  const intentId = '99999999-9999-4999-8999-999999999999';
  const dueAt = local('2026-10-24T12:15:00');
  const durable = await import('../src/main/durable.js');
  const current = (await runs.listSchedules())[0]!;
  await durable.writeDurableNow('scheduled-runs', { version: 1, schedules: [{ ...current,
    manualRunIntent: { id: intentId, dueAt, text: saved.text } }] });
  changed.mockClear();
  const inputs: ScheduledInputSnapshot[] = [{ id: intentId, state: 'cancelled', deliveredAt: dueAt + 1,
    scheduled: { scheduleId: saved.id, dueAt, late: false } }];

  await runs.runDueSchedules(local('2026-10-24T12:16:00'), { ...deps, inputs: async () => inputs });
  const recovered = (await runs.listSchedules())[0]!;
  expect(recovered.manualRunIntent).toBeUndefined();
  expect(recovered.lastInputId).toBe(intentId);
  expect(recovered.missedDueAt).toBeUndefined();
  expect(deps.enqueue).not.toHaveBeenCalled();
  expect(deps.log).toHaveBeenCalledWith('scheduled run: recovered manual run already sent');
  expect(changed).toHaveBeenCalledOnce();
});

it('never creates a second manual input id while a cancelled authorized Send is unconfirmed', async () => {
  const { runs, deps } = await setup();
  const now = local('2026-10-24T10:30:00');
  const saved = await runs.saveSchedule({
    sessionId: SESSION, text: 'No duplicate after uncertain Send',
    repeat: { kind: 'hours', every: 1 }, until: null
  }, local('2026-10-24T10:00:00'));
  const intentId = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
  const durable = await import('../src/main/durable.js');
  await durable.writeDurableNow('scheduled-runs', { version: 1, schedules: [{
    ...saved, manualRunIntent: { id: intentId, dueAt: now, text: saved.text }
  }] });
  const inputs: ScheduledInputSnapshot[] = [{
    id: intentId, state: 'cancelled', sendAuthorizedAt: now,
    deliveryProof: 'unconfirmed',
    scheduled: { scheduleId: saved.id, dueAt: now, late: false }
  }];
  const recoveredDeps: RunnerDeps = { ...deps, inputs: async () => inputs };
  await runs.runDueSchedules(now + 30_000, recoveredDeps);
  expect((await runs.listSchedules())[0]?.manualRunIntent?.id).toBe(intentId);
  expect(deps.enqueue).not.toHaveBeenCalled();
  expect(await runs.runScheduleNow(SESSION, now + 31_000, recoveredDeps)).toBe(false);
  expect(deps.enqueue).not.toHaveBeenCalled();

  // Even if the original intent was already cleared before the user cancelled
  // its authorized browser claim, its lastInputId remains a duplicate barrier.
  await durable.writeDurableNow('scheduled-runs', { version: 1, schedules: [{
    ...saved, lastInputId: intentId
  }] });
  expect(await runs.runScheduleNow(SESSION, now + 32_000, recoveredDeps)).toBe(false);
  expect(deps.enqueue).not.toHaveBeenCalled();

  inputs[0] = { ...inputs[0]!, deliveredAt: now + 33_000, deliveryProof: 'sent' };
  expect(await runs.runScheduleNow(SESSION, now + 34_000, recoveredDeps)).toBe(true);
});

it('keeps a sent manual intent until its missing delivery receipt is resolved', async () => {
  const { runs, deps } = await setup();
  const now = local('2026-10-24T10:30:00');
  const saved = await runs.saveSchedule({
    sessionId: SESSION, text: 'Do not duplicate an unconfirmed sent row',
    repeat: { kind: 'hours', every: 1 }, until: null
  }, local('2026-10-24T10:00:00'));
  const intentId = 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2';
  const durable = await import('../src/main/durable.js');
  await durable.writeDurableNow('scheduled-runs', { version: 1, schedules: [{
    ...saved, manualRunIntent: { id: intentId, dueAt: now, text: saved.text }
  }] });
  const inputs: ScheduledInputSnapshot[] = [{
    id: intentId, state: 'sent', deliveryProof: 'unconfirmed',
    scheduled: { scheduleId: saved.id, dueAt: now, late: false }
  }];
  const recoveredDeps: RunnerDeps = { ...deps, inputs: async () => inputs };

  await runs.runDueSchedules(now + 30_000, recoveredDeps);
  expect((await runs.listSchedules())[0]?.manualRunIntent?.id).toBe(intentId);
  expect(deps.enqueue).not.toHaveBeenCalled();
  expect(await runs.runScheduleNow(SESSION, now + 31_000, recoveredDeps)).toBe(false);
  expect(deps.enqueue).not.toHaveBeenCalled();

  inputs[0] = { ...inputs[0]!, deliveredAt: now + 33_000, deliveryProof: 'sent' };
  await runs.runDueSchedules(now + 34_000, recoveredDeps);
  expect((await runs.listSchedules())[0]).toMatchObject({ lastInputId: intentId });
  expect((await runs.listSchedules())[0]?.manualRunIntent).toBeUndefined();
  expect(deps.enqueue).not.toHaveBeenCalled();
});

it('refuses to recover a manual intent whose outbox id belongs to another schedule', async () => {
  const { runs, deps } = await setup();
  const saved = await runs.saveSchedule({ sessionId: SESSION, text: 'Hourly check', repeat: { kind: 'hours', every: 1 }, until: null }, local('2026-10-24T10:00:00'));
  const intentId = '77777777-7777-4777-8777-777777777777';
  const durable = await import('../src/main/durable.js');
  await durable.writeDurableNow('scheduled-runs', { version: 1, schedules: [{ ...saved,
    manualRunIntent: { id: intentId, dueAt: local('2026-10-24T10:15:00'), text: saved.text } }] });
  const inputs: ScheduledInputSnapshot[] = [{ id: intentId, state: 'queued', scheduled: {
    scheduleId: '88888888-8888-4888-8888-888888888888', dueAt: local('2026-10-24T10:15:00'), late: false
  } }];

  await expect(runs.runScheduleNow(SESSION, local('2026-10-24T10:30:00'), { ...deps, inputs: async () => inputs }))
    .rejects.toThrow('The saved manual run id belongs to a different scheduled message.');
  expect((await runs.listSchedules())[0]?.manualRunIntent?.id).toBe(intentId);
  expect(deps.enqueue).not.toHaveBeenCalled();
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
      if (reads === 2) throw new Error('outbox read unavailable');
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
  expect(await runs.runScheduleNow(SESSION, local('2026-10-24T11:30:00'), deps)).toBe(false);
  const manualId = '44444444-4444-4444-8444-444444444444';
  const durable = await import('../src/main/durable.js');
  const current = (await runs.listSchedules())[0]!;
  // Model a legacy state created before Run now began refusing a second pending message.
  await durable.writeDurableNow('scheduled-runs', { version: 1, schedules: [{ ...current, lastInputId: manualId }] });
  const inputs: ScheduledInputSnapshot[] = [
    { id: automatic.id as string, state: 'queued', scheduled: automatic.scheduled as ScheduledInputSnapshot['scheduled'] },
    { id: manualId, state: 'cancelled', scheduled: { scheduleId: saved.id, dueAt: local('2026-10-24T11:30:00'), late: false } }
  ];
  await runs.runDueSchedules(local('2026-10-24T12:00:10'), { ...deps, inputs: async () => inputs });
  expect(queued).toHaveLength(1);
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('previous run still waits in the queue'));
  expect((await runs.listSchedules())[0]).toMatchObject({ id: saved.id, lastInputId: automatic.id, lastDueAt: local('2026-10-24T12:00:00') });
});

it('refuses Run now while an automatic run is still waiting in the queue', async () => {
  const { runs, deps, queued } = await setup();
  const saved = await runs.saveSchedule({ sessionId: SESSION, text: 'Hourly check', repeat: { kind: 'hours', every: 1 }, until: null }, local('2026-10-24T10:00:00'));
  await runs.runDueSchedules(local('2026-10-24T11:00:10'), deps);
  const automaticId = queued[0]!.id as string;
  expect(await runs.runScheduleNow(SESSION, local('2026-10-24T11:30:00'), deps)).toBe(false);
  expect(queued).toHaveLength(1);
  expect((await runs.listSchedules())[0]).toMatchObject({ id: saved.id, lastInputId: automaticId });
  expect(deps.log).toHaveBeenCalledWith('scheduled run: not queued now: a previous run is already waiting');
});

it('keeps Run now blocked by an automatic sent row until the outbox proves it was not sent', async () => {
  const { runs, deps, queued } = await setup();
  await runs.saveSchedule({ sessionId: SESSION, text: 'Hourly check', repeat: { kind: 'hours', every: 1 }, until: null }, local('2026-10-24T10:00:00'));
  await runs.runDueSchedules(local('2026-10-24T11:00:10'), deps);
  const automatic = queued[0]!;
  const inputs: ScheduledInputSnapshot[] = [{
    id: automatic.id as string,
    state: 'sent',
    sendAuthorizedAt: local('2026-10-24T11:00:05'),
    deliveryProof: 'unconfirmed',
    scheduled: automatic.scheduled as ScheduledInputSnapshot['scheduled']
  }];
  const enqueue = vi.fn(async input => { queued.push(input as never); });
  const recoveredDeps: RunnerDeps = { ...deps, enqueue, inputs: async () => inputs };

  expect(await runs.runScheduleNow(SESSION, local('2026-10-24T11:30:00'), recoveredDeps)).toBe(false);
  expect(enqueue).not.toHaveBeenCalled();
  expect(queued).toHaveLength(1);

  // A definitive not-sent receipt releases the barrier; a new manual ID is now safe.
  inputs[0] = { ...inputs[0]!, state: 'cancelled', deliveryProof: 'not_sent' };
  expect(await runs.runScheduleNow(SESSION, local('2026-10-24T11:31:00'), recoveredDeps)).toBe(true);
  expect(enqueue).toHaveBeenCalledOnce();
  expect(enqueue.mock.calls[0]?.[0].id).not.toBe(automatic.id);
  expect(queued).toHaveLength(2);
});

it('defers recovery of a manual intent while a different scheduled message is still pending', async () => {
  const { runs, deps, queued } = await setup();
  const saved = await runs.saveSchedule({ sessionId: SESSION, text: 'Hourly check', repeat: { kind: 'hours', every: 1 }, until: null }, local('2026-10-24T10:00:00'));
  await runs.runDueSchedules(local('2026-10-24T11:00:10'), deps);
  const automatic = queued[0]!;
  const intentId = '33333333-3333-4333-8333-333333333333';
  const durable = await import('../src/main/durable.js');
  const current = (await runs.listSchedules())[0]!;
  await durable.writeDurableNow('scheduled-runs', { version: 1, schedules: [{ ...current,
    manualRunIntent: { id: intentId, dueAt: local('2026-10-24T11:30:00'), text: saved.text } }] });

  await runs.runDueSchedules(local('2026-10-24T11:00:20'), deps);
  expect(queued).toHaveLength(1);
  expect((await runs.listSchedules())[0]?.manualRunIntent?.id).toBe(intentId);
  expect(deps.log).toHaveBeenCalledWith('scheduled run: manual recovery deferred: a previous run is already waiting');

  await runs.runDueSchedules(local('2026-10-24T11:00:30'), { ...deps, inputs: async () => [{
    id: automatic.id as string,
    state: 'sent',
    deliveredAt: local('2026-10-24T11:00:25'),
    deliveryProof: 'sent',
    scheduled: automatic.scheduled as ScheduledInputSnapshot['scheduled']
  }] });
  expect(queued).toHaveLength(2);
  expect(queued[1]).toMatchObject({ id: intentId, text: saved.text });
  expect((await runs.listSchedules())[0]?.manualRunIntent).toBeUndefined();
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

it('blocks the next recurrence while the previous sent row has no delivery receipt', async () => {
  const { runs, deps, queued } = await setup();
  await runs.saveSchedule({
    sessionId: SESSION, text: 'Do not repeat an unconfirmed sent run',
    repeat: { kind: 'hours', every: 1 }, until: null
  }, local('2026-10-24T10:00:00'));
  await runs.runDueSchedules(local('2026-10-24T11:00:10'), deps);
  expect(queued).toHaveLength(1);
  const first = queued[0]!;
  const inputs: ScheduledInputSnapshot[] = [{
    id: first.id as string, state: 'sent', deliveryProof: 'unconfirmed',
    scheduled: first.scheduled as ScheduledInputSnapshot['scheduled']
  }];
  const enqueue = vi.fn(async (_input: Parameters<RunnerDeps['enqueue']>[0]) => {});
  const recoveredDeps: RunnerDeps = { ...deps, enqueue, inputs: async () => inputs };

  await runs.runDueSchedules(local('2026-10-24T12:00:10'), recoveredDeps);
  expect(enqueue).not.toHaveBeenCalled();
  expect((await runs.listSchedules())[0]).toMatchObject({
    lastDueAt: local('2026-10-24T12:00:00'), lastInputId: first.id
  });
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('previous run still waits in the queue'));

  inputs[0] = { ...inputs[0]!, deliveredAt: local('2026-10-24T12:05:00'), deliveryProof: 'sent' };
  await runs.runDueSchedules(local('2026-10-24T13:00:10'), recoveredDeps);
  expect(enqueue).toHaveBeenCalledOnce();
  expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
    scheduled: { dueAt: local('2026-10-24T13:00:00') }
  });
});

it('Run now removes a schedule whose chat is proven gone', async () => {
  const { runs, deps, queued } = await setup({ session: async () => null });
  await runs.saveSchedule({ sessionId: SESSION, text: 'Daily', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00'));
  expect(await runs.runScheduleNow(SESSION, local('2026-10-24T08:30:00'), deps)).toBe(false);
  expect(queued).toEqual([]);
  expect(await runs.listSchedules()).toEqual([]);
  expect(deps.log).toHaveBeenCalledWith('scheduled run: removed: its chat no longer exists');
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
    enqueue: vi.fn(async input => { if ((input as { sessionId: string }).sessionId === SESSION) throw new Error('The message queue is full'); queued.push(input as never); })
  });
  await runs.saveSchedule({ sessionId: SESSION, text: 'A', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00'));
  await runs.saveSchedule({ sessionId: other, text: 'B', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00'));
  await runs.runDueSchedules(local('2026-10-24T09:00:10'), deps);
  expect(queued).toEqual([expect.objectContaining({ sessionId: other })]);
  expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('skipped: it could not be queued (operation failed)'));
  // Skipped once, not retried and logged every check until the next time.
  await runs.runDueSchedules(local('2026-10-24T09:01:00'), deps);
  expect(vi.mocked(deps.log).mock.calls.filter(([line]) => line.includes('operation failed'))).toHaveLength(1);
});

it('durably retries the exact due occurrence after an outbox EIO, even beyond the missed-run window', async () => {
  const dueAt = local('2026-10-24T09:00:00');
  const queued: Array<Parameters<RunnerDeps['enqueue']>[0]> = [];
  let failFirst = true;
  const { runs, deps } = await setup({
    enqueue: vi.fn(async input => {
      if (failFirst) {
        failFirst = false;
        throw Object.assign(new Error('outbox rename refused'), { code: 'EIO' });
      }
      queued.push(input);
    }),
    inputs: async () => queued.map(row => ({ id: row.id, state: 'queued' as const, scheduled: row.scheduled }))
  });
  await runs.saveSchedule({
    sessionId: SESSION, text: 'Retain on EIO',
    repeat: { kind: 'daily', at: '09:00' }, until: null
  }, local('2026-10-24T08:00:00'));
  await runs.runDueSchedules(dueAt + 10_000, deps);
  expect(queued).toHaveLength(0);
  expect((await runs.listSchedules())[0]).toMatchObject({ lastDueAt: null, retryDueAt: dueAt });
  const retryProjection = await runs.listScheduleItems(dueAt + 20_000, {
    session: async id => ({ id, title: 'Retrying report' }), inputs: deps.inputs, log: vi.fn()
  });
  expect(retryProjection[0]?.retryDueAt).toBe(dueAt);
  expect(await runs.runScheduleNow(SESSION, dueAt + 20_000, deps)).toBe(false);
  expect(queued).toHaveLength(0);

  // A restart preserves the original due time instead of treating it as a
  // missed-on-startup run. Reenqueue must derive the same deterministic ID.
  vi.resetModules();
  (await import('../src/main/durable.js')).initDurableStore(dir);
  const restarted = await import('../src/main/scheduled-runs.js');
  await restarted.runDueSchedules(dueAt + 5 * 60_000, deps);
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({
    dueAt, scheduled: { dueAt, late: true }, text: 'Retain on EIO'
  });
  const recovered = (await restarted.listSchedules())[0]!;
  expect(recovered.retryDueAt).toBeUndefined();
  expect(recovered.lastDueAt).toBe(dueAt);
  expect(recovered.lastInputId).toBe(queued[0]?.id);
  const projected = await restarted.listScheduleItems(dueAt + 5 * 60_000, {
    session: async id => ({ id, title: 'Retrying report' }), inputs: deps.inputs, log: vi.fn()
  });
  expect(projected[0]?.retryDueAt).toBeUndefined();
  await restarted.runDueSchedules(dueAt + 6 * 60_000, deps);
  expect(queued).toHaveLength(1);
});

it('preserves one schedule retry when its save fails but a later schedule commits in the same pass', async () => {
  const other = '2026-10-24-e5f6a7b8';
  const dueAt = local('2026-10-24T09:00:00');
  const queued: Array<Parameters<RunnerDeps['enqueue']>[0]> = [];
  const { runs, deps } = await setup({
    session: async id => ({ id, conversationId: `chat-${id}`, activeTurnId: null }),
    enqueue: vi.fn(async input => {
      if (input.sessionId === SESSION)
        throw Object.assign(new Error('outbox rename refused'), { code: 'EIO' });
      queued.push(input);
    })
  });
  await runs.saveSchedule({ sessionId: SESSION, text: 'Retry A', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00'));
  await runs.saveSchedule({ sessionId: other, text: 'Queue B', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00'));

  const realRename = fs.rename.bind(fs);
  let failFirstScheduleSave = true;
  const write = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (failFirstScheduleSave && String(to).endsWith('scheduled-runs.json')) {
      failFirstScheduleSave = false;
      throw Object.assign(new Error('injected schedule rename failure'), { code: 'EIO' });
    }
    return realRename(from, to);
  });

  try {
    await runs.runDueSchedules(dueAt + 10_000, deps);
  } finally {
    write.mockRestore();
  }

  expect(queued).toHaveLength(1);
  expect(queued[0]?.sessionId).toBe(other);
  const saved = await runs.listSchedules();
  expect(saved.find(row => row.sessionId === SESSION)).toMatchObject({ lastDueAt: null, retryDueAt: dueAt });
  expect(saved.find(row => row.sessionId === other)).toMatchObject({ lastDueAt: dueAt, lastInputId: queued[0]?.id });
});

it('retires a retry once its outbox row has reached a terminal no-send receipt', async () => {
  const dueAt = local('2026-10-24T09:00:00');
  const id = 'aaaaaaaa-1111-4111-8111-111111111111';
  const row: ScheduledInputSnapshot = {
    id, state: 'failed', deliveryProof: 'not_sent',
    scheduled: { scheduleId: '', dueAt, late: false }
  };
  const { runs, deps } = await setup({ inputs: async () => [row] });
  const saved = await runs.saveSchedule({
    sessionId: SESSION, text: 'Retain later recurrences',
    repeat: { kind: 'daily', at: '09:00' }, until: null
  }, local('2026-10-24T08:00:00'));
  row.scheduled!.scheduleId = saved.id;
  // Build a persisted retry that had previously committed this exact outbox id.
  // The real derived id is taken from the first enqueue attempt below.
  const probe = vi.fn(async (input: Parameters<RunnerDeps['enqueue']>[0]) => {
    row.id = input.id;
    throw Object.assign(new Error('transient outbox disk failure'), { code: 'EIO' });
  });
  await runs.runDueSchedules(dueAt + 10_000, { ...deps, inputs: async () => [], enqueue: probe });
  expect((await runs.listSchedules())[0]?.retryDueAt).toBe(dueAt);
  await runs.runDueSchedules(dueAt + 30_000, deps);
  const after = (await runs.listSchedules())[0]!;
  expect(after.retryDueAt).toBeUndefined();
  expect(after.lastDueAt).toBe(dueAt);
  expect(after.lastInputId).toBe(row.id);
  // A subsequent day's recurrence can still be enqueued and is not held at
  // the prior terminal id.
  const enqueue = vi.fn(async (_input: Parameters<RunnerDeps['enqueue']>[0]) => {});
  await runs.runDueSchedules(local('2026-10-25T09:00:10'), {
    ...deps, enqueue, inputs: async () => [row]
  });
  expect(enqueue).toHaveBeenCalledOnce();
  expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
    scheduled: { dueAt: local('2026-10-25T09:00:00') }
  });
});

it('keeps scheduled inputs out of active turns and tool delivery across the runner/enqueue race', async () => {
  const { initSessionStore, createSession, getSession, appendEvent, observeSessionModel, resetSessionStoreForTests } = await import('../src/main/session/store.js');
  const input = await import('../src/main/session/input.js');
  initSessionStore(dir); input.resetInputForTests();
  const active = new Set<string>();
  input.configureInputDelivery({
    changed: () => {},
    activity: (session: { id: string }) => active.has(session.id)
      ? { possible: true, exact: true, model: 'other', turnId: 'scheduled-active-turn' }
      : { possible: false, exact: false },
    applyAutomation: async () => {},
    recordDelivered: async () => undefined
  } as never);
  try {
    const session = await createSession({ title: 'Scheduled active-turn isolation', conversationId: 'chat-scheduled-isolation' } as never);
    await observeSessionModel(session.id, 'chat-scheduled-isolation', 'gpt-5.6-sol', Date.now());
    const runs = await import('../src/main/scheduled-runs.js');
    let runnerPayload: Parameters<RunnerDeps['enqueue']>[0] | undefined;
    const deps: RunnerDeps = {
      session: async id => {
        const current = await getSession(id);
        return current ? { id, conversationId: current.conversationId ?? null, activeTurnId: current.activeTurnId ?? null } : null;
      },
      enqueue: async (queued, options) => {
        // The runner already read activeTurnId=null. Exact browser activity starts
        // before the real enqueue sees the same input.
        runnerPayload = queued;
        active.add(session.id);
        return input.enqueueInput(queued, undefined, options);
      },
      inputs: async () => (await input.listInputs()).map(({ id, state, deliveredAt, scheduled }) => ({ id, state, deliveredAt, scheduled })),
      log: vi.fn()
    };
    await runs.saveSchedule({ sessionId: session.id, text: 'Wait for the active turn', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00'));
    await runs.runDueSchedules(local('2026-10-24T09:00:10'), deps);

    expect(runnerPayload?.mode).toBe('auto');
    const row = (await input.listInputs()).find(entry => entry.sessionId === session.id)!;
    // Bridge-only activity cannot establish a recorder completion boundary;
    // auto remains browser-only and the live idle fence holds its Send.
    expect(row).toMatchObject({ state: 'queued', mode: 'auto', transportIntent: 'browser' });
    expect(row.directTurn).toBeUndefined();
    expect(row.queuedTurn).toBeUndefined();
    expect(row.toolTurnId).toBeUndefined();
    expect(row.delivery).toBeUndefined();
    expect(row.attachmentDelivery).toBeUndefined();

    // A crash/retry may rebuild the same schedule input with a different mode hint.
    // The durable outbox identity remains authoritative and must return the same row.
    const replay = await input.enqueueInput({ ...runnerPayload!, mode: 'after-turn' }, undefined, { notify: false });
    expect(replay.id).toBe(row.id);
    expect((await input.listInputs()).filter(entry => entry.sessionId === session.id)).toHaveLength(1);

    await appendEvent(session.id, { kind: 'turn_start', time: Date.now(), source: 'extension', turnId: 'scheduled-active-turn' });
    expect(await input.sessionInputPolicy(session.id)).toMatchObject({ directTurn: { id: 'scheduled-active-turn' } });
    expect(await input.sendQueuedInputNow(row.id)).toBe(false);
    expect((await input.offerToolInput(session.id, 'chat-scheduled-isolation', 'active-tool', Date.now())).messages).toEqual([]);
    expect(await input.pendingBrowserInputs()).toEqual([]);

    // An input admitted while idle can become due during a later active turn. The
    // tool-delivery boundary must still refuse it even though its mode is `auto`.
    const idle = await createSession({ title: 'Scheduled tool isolation', conversationId: 'chat-scheduled-tool-isolation' } as never);
    const idleDueAt = Date.now();
    const idleRow = await input.enqueueInput({
      id: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd', sessionId: idle.id, text: 'Do not inject this', mode: 'auto',
      dueAt: idleDueAt, model: null, reasoningEffort: null,
      delivery: 'tool', attachmentDelivery: 'tool',
      scheduled: { scheduleId: 'dededede-dede-4ede-8ede-dededededede', dueAt: idleDueAt, late: false }
    });
    expect(idleRow).toMatchObject({ mode: 'auto', transportIntent: 'browser' });
    expect(idleRow.delivery).toBeUndefined();
    expect(idleRow.attachmentDelivery).toBeUndefined();
    active.add(idle.id);
    expect((await input.offerToolInput(idle.id, 'chat-scheduled-tool-isolation', 'active-tool', Date.now())).messages).toEqual([]);
    expect((await input.listInputs()).find(entry => entry.id === idleRow.id)?.state).toBe('queued');
    expect(await input.claimBrowserInput(idleRow.id, 'scheduled-page', 'chat-scheduled-tool-isolation', true)).toBeNull();

    // Upgrade a pre-fix queued row that still carries active-turn/tool routing.
    // It was never handed out, so migration keeps its id and waits for that turn.
    const durable = await import('../src/main/durable.js');
    const legacy = {
      ...idleRow,
      id: 'efefefef-efef-4fef-8fef-efefefefefef',
      mode: 'auto' as const,
      requestedMode: 'auto' as const,
      directTurn: { id: 'legacy-scheduled-turn', startedAt: Date.now() },
      queuedTurn: { conversationId: 'chat-scheduled-tool-isolation', turnId: 'legacy-scheduled-turn' },
      delivery: 'tool' as const,
      transportIntent: 'tool' as const,
      toolTurnId: 'legacy-scheduled-turn'
    };
    await durable.writeDurableNow('session-input', [...await input.listInputs(), legacy]);
    input.resetInputForTests();
    const migrated = (await input.listInputs()).find(entry => entry.id === legacy.id)!;
    expect(migrated).toMatchObject({ state: 'queued', mode: 'after-turn', transportIntent: 'browser',
      queuedTurn: { conversationId: 'chat-scheduled-tool-isolation', turnId: 'legacy-scheduled-turn' } });
    expect(migrated.directTurn).toBeUndefined();
    expect(migrated.delivery).toBeUndefined();
    expect(migrated.toolTurnId).toBeUndefined();
    expect((await input.offerToolInput(idle.id, 'chat-scheduled-tool-isolation', 'active-tool', Date.now())).messages).toEqual([]);
    // Older Astra builds transformed scheduled after-turn rows into finish
    // checkpoints. Such unoffered rows must now leave finish/tool custody.
    const legacyFinish = {
      ...idleRow,
      id: 'abababab-abab-4bab-8bab-abababababab',
      mode: 'finish' as const,
      requestedMode: 'after-turn' as const,
      queuedTurn: { conversationId: 'chat-scheduled-tool-isolation', turnId: 'legacy-astra-turn' }
    };
    await durable.writeDurableNow('session-input', [...await input.listInputs(), legacyFinish]);
    input.resetInputForTests();
    const migratedFinish = (await input.listInputs()).find(entry => entry.id === legacyFinish.id)!;
    expect(migratedFinish).toMatchObject({
      id: legacyFinish.id, state: 'queued', mode: 'after-turn',
      transportIntent: 'browser', queuedTurn: legacyFinish.queuedTurn
    });
    expect((await input.offerToolInput(idle.id, 'chat-scheduled-tool-isolation', 'active-tool', Date.now())).messages).toEqual([]);
  } finally { input.resetInputForTests(); resetSessionStoreForTests(); }
});

it('reconciles a cancelled real-queue row with a late delivery ACK after the first schedule save fails', async () => {
  const { initSessionStore, createSession, resetSessionStoreForTests } = await import('../src/main/session/store.js');
  const input = await import('../src/main/session/input.js');
  initSessionStore(dir); input.resetInputForTests();
  input.configureInputDelivery({ changed: () => {}, applyAutomation: async () => {}, recordDelivered: async () => undefined } as never);
  try {
    const session = await createSession({ title: 'Scheduled', conversationId: 'chat-scheduled' } as never);
    const runs = await import('../src/main/scheduled-runs.js');
    let activeTurnId: string | null = null;
    const enqueue = vi.fn((queued: Parameters<RunnerDeps['enqueue']>[0]) => input.enqueueInput(queued));
    const deps: RunnerDeps = {
      session: async id => ({ id, conversationId: 'chat-scheduled', activeTurnId }),
      enqueue,
      inputs: async () => (await input.listInputs()).map(({ id, state, deliveredAt, scheduled }) => ({ id, state, deliveredAt, scheduled })),
      log: vi.fn()
    };
    await runs.saveSchedule({ sessionId: session.id, text: 'Daily check', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00'));
    // Preserve a missed marker so the retry must clear it when reconciling the accepted run.
    await runs.runDueSchedules(local('2026-10-24T12:00:00'), deps);
    expect((await runs.listSchedules())[0]?.missedDueAt).toBe(local('2026-10-24T09:00:00'));
    const durable = await import('../src/main/durable.js');
    const originalWrite = durable.writeDurableNow;
    let failFirstScheduleSave = true;
    const write = vi.spyOn(durable, 'writeDurableNow').mockImplementation(async (name, value, options) => {
      if (name === 'scheduled-runs' && failFirstScheduleSave) {
        failFirstScheduleSave = false;
        throw new Error('disk gone');
      }
      return originalWrite(name, value, options);
    });
    await runs.runDueSchedules(local('2026-10-25T09:00:10'), deps);
    write.mockRestore();
    const afterFailedSave = (await runs.listSchedules())[0]!;
    expect(afterFailedSave).toMatchObject({ lastDueAt: local('2026-10-24T09:00:00'), missedDueAt: local('2026-10-24T09:00:00') });
    expect(afterFailedSave.lastInputId).toBeUndefined();
    const queuedRow = (await input.listInputs()).find(row => row.sessionId === session.id)!;
    expect(queuedRow).toMatchObject({ state: 'queued', dueAt: local('2026-10-25T09:00:00'),
      scheduled: { dueAt: local('2026-10-25T09:00:00'), late: false } });
    const claim = await input.claimBrowserInput(queuedRow.id, 'scheduled-run-test-page', 'chat-scheduled');
    expect(claim).not.toBeNull();
    expect(await input.cancelInput(queuedRow.id)).toBe(true);
    expect((await input.listInputs()).find(row => row.id === queuedRow.id)?.state).toBe('cancelled');
    expect(await input.acknowledgeBrowserInput(queuedRow.id, 'scheduled-run-test-page', 'chat-scheduled', 'native-message')).toBe(true);
    expect((await input.listInputs()).find(row => row.id === queuedRow.id)).toMatchObject({ state: 'cancelled', deliveredAt: expect.any(Number) });
    // The original attempt chose auto mode. A turn starts before the retry, so rebuilding the
    // payload would also change mode; reconciliation must use the exact row already in the outbox.
    activeTurnId = 'turn-started-after-enqueue';

    await runs.runDueSchedules(local('2026-10-25T09:00:40'), deps);
    const rows = (await input.listInputs()).filter(row => row.sessionId === session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: queuedRow.id, state: 'cancelled', deliveredAt: expect.any(Number), text: 'Daily check',
      scheduled: { dueAt: local('2026-10-25T09:00:00'), late: false } });
    const saved = (await runs.listSchedules())[0]!;
    expect(saved).toMatchObject({ lastInputId: rows[0]!.id, lastDueAt: local('2026-10-25T09:00:00') });
    expect(saved.missedDueAt).toBeUndefined();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith('scheduled run: reconciled existing outbox row');
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
      inputs: async () => (await input.listInputs()).map(({ id, state, deliveredAt, scheduled }) => ({ id, state, deliveredAt, scheduled })),
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

it('starts empty only when the schedule file is absent and preserves malformed envelopes and rows', async () => {
  const { runs } = await setup();
  expect(await runs.listSchedules()).toEqual([]);
  const durable = await import('../src/main/durable.js');
  const listDeps = { session: async (id: string) => ({ id, title: 'Schedule' }), inputs: async () => [], log: vi.fn() };
  const malformed = { version: 1, schedules: 'broken' };
  await durable.writeDurableNow('scheduled-runs', malformed);
  await expect(runs.listSchedules()).rejects.toThrow('Could not read scheduled-runs state');
  await expect(runs.listScheduleItems(local('2026-10-24T09:00:00'), listDeps)).rejects.toThrow('Could not read scheduled-runs state');
  await expect(runs.saveSchedule({ sessionId: SESSION, text: 'Do not overwrite', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00')))
    .rejects.toThrow('Could not read scheduled-runs state');
  expect(await durable.readDurable('scheduled-runs')).toEqual(malformed);

  const good = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', sessionId: SESSION, text: 'Daily', repeat: { kind: 'daily', at: '09:00' },
    until: null, paused: false, createdAt: local('2026-10-24T08:00:00'), lastDueAt: null };
  const invalidEntry = { version: 1, schedules: [good, { ...good, id: 'not-a-uuid' }] };
  await durable.writeDurableNow('scheduled-runs', invalidEntry);
  await expect(runs.listSchedules()).rejects.toThrow('Could not read scheduled-runs state');
  await expect(runs.saveSchedule({ sessionId: SESSION, text: 'Do not drop the invalid row', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00')))
    .rejects.toThrow('Could not read scheduled-runs state');
  expect(await durable.readDurable('scheduled-runs')).toEqual(invalidEntry);

  const invalidRecord = { version: 1, schedules: [{ ...good, repeat: { kind: 'hours', every: 0 } }] };
  await durable.writeDurableNow('scheduled-runs', invalidRecord);
  await expect(runs.listScheduleItems(local('2026-10-24T09:00:00'), listDeps)).rejects.toThrow('Could not read scheduled-runs state');
  expect(await durable.readDurable('scheduled-runs')).toEqual(invalidRecord);

  const unknownEnvelopeField = { version: 1, schedules: [], futureField: true };
  await durable.writeDurableNow('scheduled-runs', unknownEnvelopeField);
  await expect(runs.listSchedules()).rejects.toThrow('Could not read scheduled-runs state');
  expect(await durable.readDurable('scheduled-runs')).toEqual(unknownEnvelopeField);
});

it('reports a future schedule version through both list paths and never overwrites it', async () => {
  const { runs } = await setup();
  const durable = await import('../src/main/durable.js');
  const future = { version: 2, schedules: 'future-format' };
  await durable.writeDurableNow('scheduled-runs', future);
  const message = 'These schedules were saved by a newer version of Chat On Steroids. Update the app to change them.';
  await expect(runs.listSchedules()).rejects.toThrow(message);
  await expect(runs.listScheduleItems(local('2026-10-24T09:00:00'), {
    session: async id => ({ id, title: 'Schedule' }), inputs: async () => [], log: vi.fn()
  }))
    .rejects.toThrow(message);
  await expect(runs.saveSchedule({ sessionId: SESSION, text: 'Do not overwrite', repeat: { kind: 'daily', at: '09:00' }, until: null }, local('2026-10-24T08:00:00')))
    .rejects.toThrow(message);
  expect(await durable.readDurable('scheduled-runs')).toEqual(future);
});

it('preserves malformed schedule JSON bytes and refuses every subsequent edit', async () => {
  const { runs } = await setup();
  const file = `${dir}/state/scheduled-runs.json`;
  await fs.mkdir(`${dir}/state`, { recursive: true });
  const original = '{"version":1,"schedules":[';
  await fs.writeFile(file, original, 'utf8');
  await expect(runs.listSchedules()).rejects.toThrow('Could not read scheduled-runs state');
  await expect(runs.deleteSchedule(SESSION)).rejects.toThrow('Could not read scheduled-runs state');
  expect(await fs.readFile(file, 'utf8')).toBe(original);
});

it('refuses a change rather than overwrite schedules it could not read (CodeRabbit)', async () => {
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
  expect(deps.log).toHaveBeenCalledWith('scheduled run: 09:00 not sent: the schedule ended before it could run');
  expect((await runs.listSchedules()).find(row => row.sessionId === SESSION)).toMatchObject({ lastDueAt: local('2026-10-22T09:00:00'), missedDueAt: local('2026-10-22T09:00:00') });
  await runs.runDueSchedules(local('2026-10-25T12:00:00'), deps);
  expect(deps.log).toHaveBeenCalledTimes(1);
});

