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
    // The retry is the same run, so the schedule records it as sent and the next time can see it waiting (CodeRabbit).
    expect((await runs.listSchedules())[0]).toMatchObject({ lastInputId: rows[0]!.id, lastDueAt: local('2026-10-24T09:00:00') });
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

