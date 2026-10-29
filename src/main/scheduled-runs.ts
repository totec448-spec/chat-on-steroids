/**
 * Scheduled runs (#1826): a chat's own message, sent into that same chat at set times.
 *
 * At its time a run becomes one message in the chat's existing queue, so everything that holds
 * any automatic send (read-only mode, ChatGPT's "slow down", a missing browser) holds it too, and
 * the queue row says why. A run waits for a running turn instead of joining it. The rules for
 * when a run is due are in shared/schedule.ts: nothing twice for the same time, nothing at once
 * after saving or resuming. A run missed while the app was closed or asleep is skipped and shown
 * as missed, unless the schedule catches up, which sends one late run.
 *
 * Exactly once: the queued message's id is derived from the schedule and the run's time. A crash
 * after queueing but before the schedule is saved queues the same id again, and the queue answers
 * with the row it already has. One schedule per chat; a deleted chat's schedule goes with it.
 * Every decision writes one log line, never the message.
 */

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readDurable, writeDurableNow } from './durable.js';
import { SCHEDULE_ON_TIME_MS, dueRun, validSchedule, type Schedule, type ScheduleRepeat } from '../shared/schedule.js';
import { MAX_CHATGPT_MESSAGE_CHARS } from '../shared/user-prompt.js';

const STORE = 'scheduled-runs';
const MAX_SCHEDULES = 500;

const at = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const scheduleRepeatSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hours'), every: z.number().int().min(1).max(24) }).strict(),
  z.object({ kind: z.literal('daily'), at }).strict(),
  z.object({ kind: z.literal('weekdays'), at }).strict(),
  z.object({ kind: z.literal('weekly'), day: z.number().int().min(0).max(6), at }).strict()
]);
const time = z.number().int().nonnegative();
const recordSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().min(8).max(64),
  text: z.string().trim().min(1).max(MAX_CHATGPT_MESSAGE_CHARS),
  repeat: scheduleRepeatSchema,
  until: time.nullable(),
  paused: z.boolean(),
  createdAt: time,
  lastDueAt: time.nullable(),
  /** The message the last run queued, so the next time can tell whether it still waits. */
  lastInputId: z.string().uuid().optional(),
  /** Send one late run after missed ones; off, a missed run is skipped (the default, Haz on #1826). */
  catchUp: z.boolean().optional(),
  /** The last run skipped as missed, shown as "Missed" until a run goes out again. */
  missedDueAt: time.optional()
}).strict();
export type ScheduledRun = z.infer<typeof recordSchema>;
const storeSchema = z.object({ version: z.literal(1), schedules: z.array(z.unknown()).max(MAX_SCHEDULES) });

/** What the runner needs from the rest of the app; injected so its rules are testable alone. */
export interface RunnerDeps {
  session(id: string): Promise<{ id: string; conversationId: string | null; activeTurnId: string | null } | null>;
  enqueue(input: { id: string; sessionId: string; text: string; mode: 'auto' | 'after-turn'; dueAt: number; model: null; reasoningEffort: null;
    scheduled: { scheduleId: string; dueAt: number; late: boolean } }): Promise<unknown>;
  /** Ids of the queue's messages that have not gone out yet (queued, being sent, or sent into a turn). */
  pending(): Promise<Set<string>>;
  log(line: string): void;
}

let chain: Promise<unknown> = Promise.resolve();
/** One change at a time: a save, a pause and a run never interleave on the same file. */
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work);
  chain = next.catch(() => undefined);
  return next;
}

/** A saved file this version cannot read as its own (a newer version's): run nothing from it, and never overwrite it. */
let foreign = false;
async function load(): Promise<ScheduledRun[]> {
  // Only a damaged file reads as empty: one that could not be read right now (busy, denied) refuses the
  // change, or saving one chat's schedule would overwrite every other chat's.
  let stored: unknown;
  try {
    stored = await readDurable(STORE, { strict: true });
  } catch (error) {
    if (!(error as { damaged?: boolean }).damaged) throw error;
    stored = null;
  }
  const raw = storeSchema.safeParse(stored);
  // Only a higher version is foreign; a damaged file of this version may be replaced, or a broken file would block schedules for good.
  const version = typeof stored === 'object' && stored !== null ? (stored as { version?: unknown }).version : undefined;
  foreign = typeof version === 'number' && version > 1;
  // A damaged entry is dropped alone; the others keep running.
  return raw.success ? raw.data.schedules.flatMap(entry => { const parsed = recordSchema.safeParse(entry); return parsed.success ? [parsed.data] : []; }) : [];
}
const save = async (schedules: ScheduledRun[]) => {
  if (foreign) throw new Error('These schedules were saved by a newer version of Chat On Steroids. Update the app to change them.');
  await writeDurableNow(STORE, { version: 1, schedules });
};

const asSchedule = (run: ScheduledRun): Schedule =>
  ({ repeat: run.repeat, until: run.until, paused: run.paused, createdAt: run.createdAt, lastDueAt: run.lastDueAt });

/** A UUID fixed by the schedule and the run's time (version 5 layout over SHA-256). */
function runInputId(scheduleId: string, dueAt: number): string {
  const hex = createHash('sha256').update(`${scheduleId}:${dueAt}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function listSchedules(): Promise<ScheduledRun[]> { return serial(load); }

/** Creates or replaces a chat's schedule. It starts at its next time, never at once. */
export function saveSchedule(input: { sessionId: string; text: string; repeat: ScheduleRepeat; until: number | null; catchUp?: boolean }, now = Date.now()): Promise<ScheduledRun> {
  return serial(async () => {
    if (!input.text.trim()) throw new Error('Write the message to send.');
    if (!validSchedule(input.repeat)) throw new Error('Choose a schedule that runs at least once an hour apart.');
    if (input.until !== null && input.until <= now) throw new Error('Choose an end date in the future.');
    const schedules = await load();
    const prior = schedules.find(row => row.sessionId === input.sessionId);
    if (!prior && schedules.length >= MAX_SCHEDULES) throw new Error('There are too many scheduled chats. Remove one first.');
    const record = recordSchema.parse({ id: prior?.id ?? randomUUID(), sessionId: input.sessionId, text: input.text.trim(),
      repeat: input.repeat, until: input.until, paused: false, createdAt: now, lastDueAt: null, ...(input.catchUp ? { catchUp: true } : {}),
      ...(prior?.lastInputId ? { lastInputId: prior.lastInputId } : {}) });
    await save([...schedules.filter(row => row.sessionId !== input.sessionId), record]);
    return record;
  });
}

/** Pausing keeps the schedule; resuming starts from now, without the runs that passed meanwhile. */
export function setSchedulePaused(sessionId: string, paused: boolean, now = Date.now()): Promise<ScheduledRun | null> {
  return serial(async () => {
    const schedules = await load();
    const prior = schedules.find(row => row.sessionId === sessionId);
    if (!prior) return null;
    const next: ScheduledRun = { ...prior, paused, ...(paused ? {} : { lastDueAt: now }) };
    await save(schedules.map(row => row.sessionId === sessionId ? next : row));
    return next;
  });
}

export function deleteSchedule(sessionId: string): Promise<boolean> {
  return serial(async () => {
    const schedules = await load();
    if (!schedules.some(row => row.sessionId === sessionId)) return false;
    await save(schedules.filter(row => row.sessionId !== sessionId));
    return true;
  });
}

const clock = (instant: number) => { const d = new Date(instant); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** Queues every run that is due now. One chat's failure never stops the others. */
export function runDueSchedules(now: number, deps: RunnerDeps): Promise<void> {
  return serial(async () => {
    let schedules = await load();
    for (const run of [...schedules]) {
      const replace = async (next: ScheduledRun | null) => {
        schedules = next ? schedules.map(row => row.id === run.id ? next : row) : schedules.filter(row => row.id !== run.id);
        await save(schedules);
      };
      // The chat first, for every schedule: a deleted chat's schedule goes with it even while paused or ended.
      let session: Awaited<ReturnType<RunnerDeps['session']>>;
      try {
        session = await deps.session(run.sessionId);
        if (!session) {
          deps.log(`scheduled run: removed: its chat no longer exists (${run.sessionId})`);
          await replace(null);
          continue;
        }
      } catch (error) {
        // Not readable right now is not gone: kept, and checked again in 30 s.
        deps.log(`scheduled run: its chat could not be read (${error instanceof Error ? error.message : String(error)}); checked again in 30 s (${run.sessionId})`);
        continue;
      }
      const due = dueRun(asSchedule(run), now);
      if (!due) {
        // An ended schedule sends nothing; a run it missed before its end date is said once, and kept as "Missed".
        if (run.until !== null && !run.paused && now > run.until + SCHEDULE_ON_TIME_MS) {
          const missed = dueRun({ ...asSchedule(run), until: null }, run.until);
          if (missed) {
            try {
              await replace({ ...run, lastDueAt: missed.dueAt, missedDueAt: missed.dueAt });
              deps.log(`scheduled run: ${clock(missed.dueAt)} not sent: the schedule ended before it could run (${run.sessionId})`);
            } catch (error) {
              deps.log(`scheduled run: ${clock(missed.dueAt)} not recorded yet (${error instanceof Error ? error.message : String(error)}); checked again in 30 s (${run.sessionId})`);
            }
          }
        }
        continue;
      }
      try {
        if (run.lastInputId && (await deps.pending()).has(run.lastInputId)) {
          deps.log(`scheduled run: ${clock(due.dueAt)} skipped: the previous run still waits in the queue (${run.sessionId})`);
          await replace({ ...run, lastDueAt: due.dueAt });
          continue;
        }
        // Missed while the app was closed or asleep: skipped unless catching up was chosen, since a
        // stale run can be unexpected or expensive. It is kept as "Missed" until a run goes out again.
        if (due.late && !run.catchUp) {
          deps.log(`scheduled run: ${clock(due.dueAt)} missed (the app was closed or asleep); not caught up (${run.sessionId})`);
          await replace({ ...run, lastDueAt: due.dueAt, missedDueAt: due.dueAt });
          continue;
        }
        const id = runInputId(run.id, due.dueAt);
        try {
          await deps.enqueue({ id, sessionId: run.sessionId, text: run.text, mode: session.activeTurnId ? 'after-turn' : 'auto',
            dueAt: now, model: null, reasoningEffort: null, scheduled: { scheduleId: run.id, dueAt: due.dueAt, late: due.late } });
        } catch (error) {
          // That time is skipped, once, so a chat the queue refuses is not retried (and logged)
          // every 30 s; the next time tries again.
          deps.log(`scheduled run: ${clock(due.dueAt)} skipped: it could not be queued (${error instanceof Error ? error.message : String(error)}) (${run.sessionId})`);
          await replace({ ...run, lastDueAt: due.dueAt });
          continue;
        }
        deps.log(`scheduled run: queued for ${run.sessionId}${due.late ? ` (late, was due ${clock(due.dueAt)})` : ''}`);
        // If this save fails, the next check queues the same message id again, and the queue keeps one row.
        const { missedDueAt: _cleared, ...sent } = run;
        await replace({ ...sent, lastDueAt: due.dueAt, lastInputId: id });
      } catch (error) {
        deps.log(`scheduled run: ${clock(due.dueAt)} not recorded yet (${error instanceof Error ? error.message : String(error)}); checked again in 30 s (${run.sessionId})`);
      }
    }
  });
}
