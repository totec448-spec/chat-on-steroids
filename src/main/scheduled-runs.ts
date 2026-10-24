/**
 * Scheduled runs (#1826): a chat's own message, sent into that same chat at set times.
 *
 * At its time a run becomes one message in the chat's existing queue, so everything that holds
 * any automatic send (read-only mode, ChatGPT's "slow down", a missing browser) holds it too, and
 * the queue row says why. A run waits for a running turn instead of joining it. The rules for
 * when a run is due are in shared/schedule.ts: one late run after missed ones, nothing twice for
 * the same time, nothing at once after saving or resuming.
 *
 * Exactly once: the queued message's id is derived from the schedule and the run's time. A crash
 * after queueing but before the schedule is saved queues the same id again, and the queue answers
 * with the row it already has. One schedule per chat; a deleted chat's schedule goes with it.
 * Every decision writes one log line, never the message.
 */

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readDurable, writeDurableNow } from './durable.js';
import { dueRun, validSchedule, type Schedule, type ScheduleRepeat } from '../shared/schedule.js';
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
  lastInputId: z.string().uuid().optional()
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

async function load(): Promise<ScheduledRun[]> {
  const raw = storeSchema.safeParse(await readDurable(STORE));
  // A damaged entry is dropped alone; the others keep running.
  return raw.success ? raw.data.schedules.flatMap(entry => { const parsed = recordSchema.safeParse(entry); return parsed.success ? [parsed.data] : []; }) : [];
}
const save = (schedules: ScheduledRun[]) => writeDurableNow(STORE, { version: 1, schedules });

const asSchedule = (run: ScheduledRun): Schedule =>
  ({ repeat: run.repeat, until: run.until, paused: run.paused, createdAt: run.createdAt, lastDueAt: run.lastDueAt });

/** A UUID fixed by the schedule and the run's time (version 5 layout over SHA-256). */
function runInputId(scheduleId: string, dueAt: number): string {
  const hex = createHash('sha256').update(`${scheduleId}:${dueAt}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function listSchedules(): Promise<ScheduledRun[]> { return serial(load); }

/** Creates or replaces a chat's schedule. It starts at its next time, never at once. */
export function saveSchedule(input: { sessionId: string; text: string; repeat: ScheduleRepeat; until: number | null }, now = Date.now()): Promise<ScheduledRun> {
  return serial(async () => {
    if (!input.text.trim()) throw new Error('Write the message to send.');
    if (!validSchedule(input.repeat)) throw new Error('Choose a schedule that runs at least once an hour apart.');
    if (input.until !== null && input.until <= now) throw new Error('Choose an end date in the future.');
    const schedules = await load();
    const prior = schedules.find(row => row.sessionId === input.sessionId);
    if (!prior && schedules.length >= MAX_SCHEDULES) throw new Error('There are too many scheduled chats. Remove one first.');
    const record = recordSchema.parse({ id: prior?.id ?? randomUUID(), sessionId: input.sessionId, text: input.text.trim(),
      repeat: input.repeat, until: input.until, paused: false, createdAt: now, lastDueAt: null,
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
      const due = dueRun(asSchedule(run), now);
      if (!due) continue;
      const replace = async (next: ScheduledRun | null) => {
        schedules = next ? schedules.map(row => row.id === run.id ? next : row) : schedules.filter(row => row.id !== run.id);
        await save(schedules);
      };
      try {
        const session = await deps.session(run.sessionId);
        if (!session) {
          deps.log(`scheduled run: removed: its chat no longer exists (${run.sessionId})`);
          await replace(null);
          continue;
        }
        if (run.lastInputId && (await deps.pending()).has(run.lastInputId)) {
          deps.log(`scheduled run: ${clock(due.dueAt)} skipped: the previous run still waits in the queue (${run.sessionId})`);
          await replace({ ...run, lastDueAt: due.dueAt });
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
        await replace({ ...run, lastDueAt: due.dueAt, lastInputId: id });
      } catch (error) {
        deps.log(`scheduled run: ${clock(due.dueAt)} not recorded yet (${error instanceof Error ? error.message : String(error)}); checked again in 30 s (${run.sessionId})`);
      }
    }
  });
}
