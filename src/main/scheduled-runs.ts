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
import { SCHEDULE_ON_TIME_MS, dueRun, nextRunAfter, validSchedule, type Schedule, type ScheduledRunListItem, type ScheduleRepeat } from '../shared/schedule.js';
import { MAX_CHATGPT_MESSAGE_CHARS } from '../shared/user-prompt.js';

const STORE = 'scheduled-runs';
const MAX_SCHEDULES = 500;
const SCHEDULE_LIST_PREVIEW_CHARS = 320;
const SCHEDULE_STATE_READ_ERROR = 'Could not read scheduled-runs state';
const SCHEDULE_FUTURE_VERSION_ERROR = 'These schedules were saved by a newer version of Chat On Steroids. Update the app to change them.';

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
  /** A manual Run now accepted before its outbox write; replayed or reconciled after restart. */
  manualRunIntent: z.object({ id: z.string().uuid(), dueAt: time, text: z.string().trim().min(1).max(MAX_CHATGPT_MESSAGE_CHARS) }).strict().optional(),
  /** Send one late run after missed ones; off, a missed run is skipped (the default, Haz on #1826). */
  catchUp: z.boolean().optional(),
  /** The last run skipped as missed, shown as "Missed" until a run goes out again. */
  missedDueAt: time.optional(),
  /** The exact occurrence whose outbox commit failed transiently; retry its same ID. */
  retryDueAt: time.optional()
}).strict();
export type ScheduledRun = z.infer<typeof recordSchema>;
const storeSchema = z.object({ version: z.literal(1), schedules: z.array(recordSchema).max(MAX_SCHEDULES) }).strict();

export interface ScheduledInputSnapshot {
  id: string;
  state: 'queued' | 'browser' | 'tool' | 'sent' | 'cancelled' | 'failed' | 'decision';
  /** A late native ACK can prove delivery while the row remains cancelled. */
  deliveredAt?: number;
  /** An authorized browser Send can be cancelled before its receipt arrives. */
  sendAuthorizedAt?: number;
  /** The outbox's authoritative receipt classification, including terminal ambiguity. */
  deliveryProof?: 'sent' | 'not_sent' | 'unconfirmed' | 'pending';
  scheduled?: { scheduleId: string; dueAt: number; late: boolean };
}

/** What the runner needs from the rest of the app; injected so its rules are testable alone. */
export interface RunnerDeps {
  session(id: string): Promise<{ id: string; conversationId: string | null; activeTurnId: string | null } | null>;
  enqueue(input: { id: string; sessionId: string; text: string; mode: 'auto' | 'after-turn'; dueAt: number; model: null; reasoningEffort: null;
    scheduled: { scheduleId: string; dueAt: number; late: boolean } }, options?: { notify?: boolean }): Promise<unknown>;
  /** Existing outbox rows, including terminal receipts, so manual intents can recover exactly once. */
  inputs(): Promise<ScheduledInputSnapshot[]>;
  log(line: string): void;
  /** Notify the global schedule projection after a persisted schedule change. */
  changed?(): void;
}

export interface ScheduleListDeps {
  session(id: string): Promise<{ id: string; title: string } | null>;
  /** Existing outbox rows, including terminal receipts, so the list reflects the runner's blocker. */
  inputs(): Promise<ScheduledInputSnapshot[]>;
  log(line: string): void;
}

export type RunNowDeps = Pick<RunnerDeps, 'session' | 'enqueue' | 'inputs' | 'log' | 'changed'>;

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
  // Strict reads return null only when the file is absent. A damaged file, unknown
  // envelope or invalid row must keep the whole ledger unavailable until repaired;
  // interpreting any of them as an empty list would let the next edit erase schedules.
  const stored = await readDurable(STORE, { strict: true });
  if (stored === null) { foreign = false; return []; }
  const version = typeof stored === 'object' && stored !== null ? (stored as { version?: unknown }).version : undefined;
  foreign = typeof version === 'number' && version > 1;
  if (foreign) throw new Error(SCHEDULE_FUTURE_VERSION_ERROR);
  const raw = storeSchema.safeParse(stored);
  if (!raw.success) throw new Error(SCHEDULE_STATE_READ_ERROR);
  foreign = false;
  return raw.data.schedules;
}
const save = async (schedules: ScheduledRun[], onPersisted?: () => void) => {
  if (foreign) throw new Error('These schedules were saved by a newer version of Chat On Steroids. Update the app to change them.');
  await writeDurableNow(STORE, { version: 1, schedules }, onPersisted ? { onPersisted } : undefined);
};

const asSchedule = (run: ScheduledRun): Schedule =>
  ({ repeat: run.repeat, until: run.until, paused: run.paused, createdAt: run.createdAt, lastDueAt: run.lastDueAt });

/** A UUID fixed by the schedule and the run's time (version 5 layout over SHA-256). */
function runInputId(scheduleId: string, dueAt: number): string {
  const hex = createHash('sha256').update(`${scheduleId}:${dueAt}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const pendingInput = (input: ScheduledInputSnapshot): boolean => ['queued', 'browser', 'tool'].includes(input.state);
const acceptedInput = (input: ScheduledInputSnapshot): boolean =>
  pendingInput(input) || input.deliveryProof === 'sent' || input.deliveredAt !== undefined;
const SAFE_FAILURE_CODES = new Set([
  'EACCES', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EAGAIN', 'EBUSY', 'ECONNREFUSED', 'ECONNRESET', 'EEXIST',
  'EHOSTUNREACH', 'EINTR', 'EINVAL', 'EIO', 'EISDIR', 'EMFILE', 'ENAMETOOLONG', 'ENETUNREACH',
  'ENFILE', 'ENODEV', 'ENOENT', 'ENOSPC', 'ENOTDIR', 'ENOTEMPTY', 'ENOTSOCK', 'EOPNOTSUPP', 'EPIPE',
  'EPERM', 'EROFS', 'ETIMEDOUT', 'EXDEV'
]);
/** Only known admission refusals may retire an occurrence; unknown errors preserve retry intent. */
const ENQUEUE_REFUSALS = new Set([
  'One message is already awaiting delivery. Cancel it before sending another.',
  'The message queue is full',
  'The image queue is full',
  'Queued messages exceed the text limit',
  'This recording has no ChatGPT conversation',
  'Unblock this conversation before sending',
  'Message id already belongs to different input',
  'Prepared message exceeds the delivery limit; shorten the request or plan',
  'Scheduled messages cannot be attached to a finish turn'
]);
function deterministicEnqueueRefusal(error: unknown): boolean {
  return error instanceof Error && ENQUEUE_REFUSALS.has(error.message);
}
/** An unconfirmed delivery blocks another send regardless of the outbox row's terminal state. */
const uncertainInput = (input: ScheduledInputSnapshot): boolean =>
  input.deliveredAt === undefined &&
  (input.deliveryProof === 'unconfirmed' ||
    (input.deliveryProof === 'pending' && !pendingInput(input)) ||
    (input.deliveryProof === undefined &&
      (input.state === 'sent' ||
        ((input.state === 'cancelled' || input.state === 'failed') && input.sendAuthorizedAt !== undefined))));
const blocksScheduledDelivery = (input: ScheduledInputSnapshot): boolean => pendingInput(input) || uncertainInput(input);

/** Error messages can contain local paths or user identifiers; logs may include only a safe code. */
export function safeFailureReason(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && SAFE_FAILURE_CODES.has(code) ? code : 'operation failed';
}

/** A renderer notification must never turn an already-persisted schedule change into a failed run. */
function notifyScheduleChange(deps: Pick<RunnerDeps, 'changed' | 'log'>): void {
  try { deps.changed?.(); }
  catch (error) { deps.log(`scheduled run: schedule change notification failed (${safeFailureReason(error)})`); }
}

function scheduleTextPreview(text: string): string {
  if (text.length <= SCHEDULE_LIST_PREVIEW_CHARS) return text;
  let preview = text.slice(0, SCHEDULE_LIST_PREVIEW_CHARS - 1);
  const last = preview.charCodeAt(preview.length - 1);
  // Do not leave half of a UTF-16 surrogate pair at the preview boundary.
  if (last >= 0xd800 && last <= 0xdbff) preview = preview.slice(0, -1);
  return `${preview}…`;
}

/** The latest id is preferred, but any pending row for this schedule remains a blocker. */
function pendingScheduledInput(run: ScheduledRun, inputs: ScheduledInputSnapshot[]): ScheduledInputSnapshot | undefined {
  return inputs.find(input => blocksScheduledDelivery(input) && input.id === run.lastInputId)
    ?? inputs.filter(input => blocksScheduledDelivery(input) && input.scheduled?.scheduleId === run.id).at(-1);
}

function manualRunInput(run: ScheduledRun, intent: NonNullable<ScheduledRun['manualRunIntent']>, session: { activeTurnId: string | null }) {
  return {
    id: intent.id,
    sessionId: run.sessionId,
    text: intent.text,
    mode: session.activeTurnId ? 'after-turn' as const : 'auto' as const,
    dueAt: intent.dueAt,
    model: null,
    reasoningEffort: null,
    scheduled: { scheduleId: run.id, dueAt: intent.dueAt, late: false }
  };
}

/** A rejected enqueue is safe to forget only when a fresh outbox read proves its ID is absent. */
async function dropManualRunIntentIfOutboxAbsent(
  run: ScheduledRun,
  schedules: ScheduledRun[],
  deps: Pick<RunnerDeps, 'inputs'>
): Promise<{ run: ScheduledRun; schedules: ScheduledRun[] } | null> {
  const intent = run.manualRunIntent;
  if (!intent) return null;
  let after: ScheduledInputSnapshot[];
  try { after = await deps.inputs(); }
  catch { return null; }
  if (after.some(input => input.id === intent.id)) return null;
  const { manualRunIntent: _intent, ...withoutIntent } = run;
  const updated = schedules.map(row => row.id === run.id ? withoutIntent : row);
  try { await save(updated); }
  catch { return null; }
  return { run: withoutIntent, schedules: updated };
}

/** Finish a durable manual intent from its exact outbox identity, or replay that same identity. */
async function settleManualRunIntent(
  run: ScheduledRun,
  schedules: ScheduledRun[],
  session: NonNullable<Awaited<ReturnType<RunNowDeps['session']>>>,
  deps: Pick<RunnerDeps, 'enqueue' | 'inputs' | 'log' | 'changed'>,
  inputs: ScheduledInputSnapshot[]
): Promise<{ run: ScheduledRun; schedules: ScheduledRun[]; pending: boolean }> {
  const intent = run.manualRunIntent;
  if (!intent) return { run, schedules, pending: false };
  const existing = inputs.find(input => input.id === intent.id);
  if (existing) {
    if (existing.scheduled?.scheduleId !== run.id) throw new Error('The saved manual run id belongs to a different scheduled message.');
    if (uncertainInput(existing)) {
      // A cancelled browser Send may already have reached ChatGPT. Retain the
      // exact durable intent and its id until a late ACK or definitive no-send;
      // inventing a fresh manual id here can deliver the same prompt twice.
      deps.log('scheduled run: manual recovery deferred: previous delivery is unconfirmed');
      return { run, schedules, pending: true };
    }
    const pending = pendingInput(existing);
    const sent = existing.deliveryProof === 'sent' || existing.deliveredAt !== undefined;
    const { manualRunIntent: _intent, ...withoutIntent } = run;
    let next = withoutIntent;
    if (pending || sent) {
      const { missedDueAt: _missed, ...afterRun } = withoutIntent;
      next = { ...afterRun, lastInputId: intent.id };
    }
    const updated = schedules.map(row => row.id === run.id ? next : row);
    // The original enqueue committed with notify:false. Refresh the outbox/chat and
    // schedule projection after this reconciliation is durably committed, even when
    // the row is already terminal or there was no missed marker to clear.
    await save(updated, () => notifyScheduleChange(deps));
    deps.log(pending
      ? 'scheduled run: recovered manual run already pending'
      : sent
        ? 'scheduled run: recovered manual run already sent'
        : `scheduled run: manual run ended before delivery (${existing.state}); cleared its recovery intent`);
    return { run: next, schedules: updated, pending };
  }

  try { await deps.enqueue(manualRunInput(run, intent, session), { notify: false }); }
  catch (error) {
    const dropped = await dropManualRunIntentIfOutboxAbsent(run, schedules, deps);
    if (dropped) {
      deps.log(`scheduled run: manual enqueue failed (${safeFailureReason(error)}); outbox confirms no row, recovery intent dropped`);
      return { ...dropped, pending: false };
    }
    notifyScheduleChange(deps);
    throw error;
  }
  inputs.push({ id: intent.id, state: 'queued', scheduled: { scheduleId: run.id, dueAt: intent.dueAt, late: false } });
  const { manualRunIntent: _intent, missedDueAt: _missed, ...withoutIntent } = run;
  const next = { ...withoutIntent, lastInputId: intent.id };
  const updated = schedules.map(row => row.id === run.id ? next : row);
  await save(updated, () => notifyScheduleChange(deps));
  deps.log('scheduled run: recovered manual run');
  return { run: next, schedules: updated, pending: true };
}

export function listSchedules(): Promise<ScheduledRun[]> { return serial(load); }

/** All saved schedules with their current chat titles. Proven-orphaned schedules are removed here too. */
export function listScheduleItems(now: number, deps: ScheduleListDeps): Promise<ScheduledRunListItem[]> {
  return serial(async () => {
    let schedules = await load();
    // Fail closed if delivery state cannot be read. An empty fallback could hide an
    // ambiguous Send and incorrectly invite the person to queue a duplicate.
    const inputs = schedules.length ? await deps.inputs() : [];
    const items: ScheduledRunListItem[] = [];
    for (const run of [...schedules]) {
      let session: Awaited<ReturnType<ScheduleListDeps['session']>>;
      try {
        session = await deps.session(run.sessionId);
      } catch (error) {
        // A chat that cannot be read right now is not proof that it was deleted. Keep its
        // schedule and continue projecting the other chats instead of losing the whole list.
        deps.log(`scheduled run: its chat could not be read (${safeFailureReason(error)}); kept`);
        continue;
      }
      if (!session) {
        // A failed cleanup must not hide all the healthy schedules from the global page.
        // Keep this entry in memory and on disk for the next pass if persistence refuses.
        const remaining = schedules.filter(row => row.id !== run.id);
        try {
          await save(remaining);
          schedules = remaining;
          deps.log('scheduled run: removed: its chat no longer exists');
        } catch (error) {
          deps.log(`scheduled run: could not remove the missing chat's schedule (${safeFailureReason(error)}); will retry`);
        }
        continue;
      }
      const blockingInput = pendingScheduledInput(run, inputs);
      items.push({
        id: run.id,
        sessionId: run.sessionId,
        sessionTitle: session.title,
        text: scheduleTextPreview(run.text),
        repeat: run.repeat,
        until: run.until,
        paused: run.paused,
        createdAt: run.createdAt,
        lastDueAt: run.lastDueAt,
        ...(run.missedDueAt !== undefined ? { missedDueAt: run.missedDueAt } : {}),
        ...(run.retryDueAt !== undefined ? { retryDueAt: run.retryDueAt } : {}),
        ...(run.catchUp ? { catchUp: true } : {}),
        ...(blockingInput ? { deliveryBlock: uncertainInput(blockingInput) ? 'unconfirmed' as const : 'pending' as const } : {}),
        nextRunAt: nextRunAfter(asSchedule(run), Math.max(now, run.lastDueAt ?? 0))
      });
    }
    return items;
  });
}

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
      ...(prior?.lastInputId ? { lastInputId: prior.lastInputId } : {}), ...(prior?.manualRunIntent ? { manualRunIntent: prior.manualRunIntent } : {}) });
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
    // An explicit pause/resume supersedes any pending automatic retry.
    const { retryDueAt: _retry, ...withoutRetry } = prior;
    const next: ScheduledRun = { ...withoutRetry, paused, ...(paused ? {} : { lastDueAt: now }) };
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

/** Queues this schedule once immediately without advancing or otherwise changing its recurrence. */
export function runScheduleNow(sessionId: string, now: number, deps: RunNowDeps): Promise<boolean> {
  return serial(async () => {
    let schedules = await load();
    let run = schedules.find(row => row.sessionId === sessionId);
    if (!run) {
      deps.log('scheduled run: not queued now: no schedule exists');
      return false;
    }
    if (run.retryDueAt !== undefined) {
      // A failed automatic outbox commit owns this occurrence's deterministic
      // identity. A new random Run now id would duplicate it after recovery.
      deps.log('scheduled run: not queued now: an automatic run is awaiting durable retry');
      return false;
    }
    const runId = run.id;
    let session: Awaited<ReturnType<RunNowDeps['session']>>;
    try { session = await deps.session(run.sessionId); }
    catch (error) {
      deps.log(`scheduled run: not queued now: its chat could not be read (${safeFailureReason(error)}); schedule kept`);
      throw error;
    }
    if (!session) {
      try {
        await save(schedules.filter(row => row.id !== runId));
        deps.log('scheduled run: removed: its chat no longer exists');
      } catch (error) {
        deps.log(`scheduled run: could not remove the missing chat's schedule (${safeFailureReason(error)}); will retry`);
        throw error;
      }
      return false;
    }
    if (!session.conversationId) {
      deps.log('scheduled run: not queued now: its chat has no ChatGPT conversation');
      return false;
    }

    let inputs: ScheduledInputSnapshot[];
    try { inputs = await deps.inputs(); }
    catch (error) {
      deps.log(`scheduled run: not queued now: the input outbox could not be read (${safeFailureReason(error)})`);
      throw error;
    }

    // Do not add a manual message while any message for this schedule is still waiting.
    // An older durable intent is retained and recovered after the existing message leaves.
    const pendingBeforeRecovery = pendingScheduledInput(run, inputs);
    if (pendingBeforeRecovery && pendingBeforeRecovery.id !== run.manualRunIntent?.id) {
      deps.log('scheduled run: not queued now: a previous run is already waiting');
      return false;
    }

    // A prior click may have stopped between its durable intent and outbox acknowledgement.
    // Settle that exact id before accepting another click; never overwrite an unrecovered intent.
    if (run.manualRunIntent) {
      const previousIntentId = run.manualRunIntent.id;
      const existingIntent = inputs.find(input => input.id === previousIntentId);
      try {
        const recovered = await settleManualRunIntent(run, schedules, session, deps, inputs);
        schedules = recovered.schedules;
        run = recovered.run;
        if (existingIntent && blocksScheduledDelivery(existingIntent)) {
          deps.log('scheduled run: not queued now: a previous run is already waiting');
          return false;
        }
        // A repeated click that completes the prior accepted intent is its acknowledgement, not
        // a second manual run. A terminal failed/cancelled row has no lastInputId and may retry.
        if (run.lastInputId === previousIntentId) return true;
      } catch (error) {
        deps.log(`scheduled run: could not recover the previous manual run (${safeFailureReason(error)}); intent kept`);
        throw error;
      }
    }

    const blockingPendingInput = pendingScheduledInput(run, inputs);
    if (blockingPendingInput) {
      deps.log('scheduled run: not queued now: a previous run is already waiting');
      return false;
    }

    const intent = { id: randomUUID(), dueAt: now, text: run.text };
    const prepared: ScheduledRun = { ...run, manualRunIntent: intent };
    const withIntent = schedules.map(row => row.id === run!.id ? prepared : row);
    try { await save(withIntent); }
    catch (error) {
      // writeDurableNow retains a failed generation for retry/shutdown. Supersede that
      // generation with the prior snapshot so this refused click can never become a hidden send.
      let rollback = 'previous snapshot retained';
      if (!foreign) {
        try {
          await save(schedules);
          rollback = 'previous snapshot restored';
        } catch {
          // The durable writer now retains the safe prior snapshot as the newest retry generation.
          rollback = 'previous snapshot queued for recovery';
        }
      }
      deps.log(`scheduled run: not queued now: could not save its recovery intent (${safeFailureReason(error)}); no message queued; ${rollback}`);
      throw error;
    }

    let enqueued = false;
    try {
      await deps.enqueue(manualRunInput(prepared, intent, session), { notify: false });
      enqueued = true;
      const { manualRunIntent: _intent, missedDueAt: _missed, ...withoutIntent } = prepared;
      const completed: ScheduledRun = { ...withoutIntent, lastInputId: intent.id };
      await save(withIntent.map(row => row.id === run!.id ? completed : row), () => notifyScheduleChange(deps));
    } catch (error) {
      const dropped = !enqueued && await dropManualRunIntentIfOutboxAbsent(prepared, withIntent, deps);
      // An ambiguous enqueue may already have committed an outbox row. A schedule-save
      // failure after a confirmed enqueue is instead notified by that save's onPersisted
      // callback when its retained durable generation actually reaches disk.
      if (!enqueued && !dropped) notifyScheduleChange(deps);
      deps.log(enqueued
        ? `scheduled run: manual run was queued but its recovery intent could not be cleared (${safeFailureReason(error)}); intent kept`
        : dropped
          ? `scheduled run: manual enqueue failed (${safeFailureReason(error)}); outbox confirms no row, recovery intent dropped`
          : `scheduled run: manual enqueue failed (${safeFailureReason(error)}); recovery intent kept`);
      throw error;
    }
    deps.log('scheduled run: queued now');
    return true;
  });
}

const clock = (instant: number) => { const d = new Date(instant); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** Queues every run that is due now. One chat's failure never stops the others. */
export function runDueSchedules(now: number, deps: RunnerDeps): Promise<void> {
  return serial(async () => {
    let schedules = await load();
    let inputs: ScheduledInputSnapshot[];
    try { inputs = await deps.inputs(); }
    catch (error) {
      deps.log(`scheduled run: the input outbox could not be read (${safeFailureReason(error)}); no runs were queued; checked again in 30 s`);
      return;
    }
    for (const original of [...schedules]) {
      let run = schedules.find(row => row.id === original.id);
      if (!run) continue;
      const runId = run.id;
      const replace = async (next: ScheduledRun | null) => {
        const nextSchedules = next ? schedules.map(row => row.id === runId ? next : row) : schedules.filter(row => row.id !== runId);
        // Keep failed state updates in the in-memory whole-file snapshot so a
        // later schedule can commit them in a newer generation. A failed
        // deletion is different: keep the row until its own removal persists.
        if (next) schedules = nextSchedules;
        await save(nextSchedules, () => notifyScheduleChange(deps));
        schedules = nextSchedules;
      };
      // The chat first, for every schedule: a deleted chat's schedule goes with it even while paused or ended.
      let session: Awaited<ReturnType<RunnerDeps['session']>>;
      try {
        session = await deps.session(run.sessionId);
      } catch (error) {
        // Not readable right now is not gone: kept, and checked again in 30 s.
        deps.log(`scheduled run: its chat could not be read (${safeFailureReason(error)}); checked again in 30 s`);
        continue;
      }
      if (!session) {
        try {
          await replace(null);
          deps.log('scheduled run: removed: its chat no longer exists');
        } catch (error) {
          deps.log(`scheduled run: could not remove the missing chat's schedule (${safeFailureReason(error)}); will retry`);
        }
        continue;
      }
      if (!session.conversationId) {
        deps.log('scheduled run: its chat has no ChatGPT conversation yet; schedule kept');
        continue;
      }

      if (run.manualRunIntent) {
        const blockingInput = pendingScheduledInput(run, inputs);
        if (blockingInput && blockingInput.id !== run.manualRunIntent.id) {
          deps.log('scheduled run: manual recovery deferred: a previous run is already waiting');
          continue;
        }
        try {
          const recovered = await settleManualRunIntent(run, schedules, session, deps, inputs);
          schedules = recovered.schedules;
          run = recovered.run;
          if (recovered.pending) continue;
        } catch (error) {
          deps.log(`scheduled run: manual run recovery failed (${safeFailureReason(error)}); intent kept`);
          continue;
        }
      }

      // An outbox read/write failure must not turn an on-time occurrence into
      // an ordinary missed run two minutes later. Its durable retry keeps the
      // same derived outbox ID, even after a process restart.
      const retrying = run.retryDueAt !== undefined;
      if (retrying && run.until !== null && now > run.until + SCHEDULE_ON_TIME_MS) {
        const { retryDueAt: _retry, ...withoutRetry } = run;
        try {
          await replace({ ...withoutRetry, lastDueAt: run.retryDueAt!, missedDueAt: run.retryDueAt! });
        } catch (error) {
          deps.log(`scheduled run: could not record the ended retry (${safeFailureReason(error)})`);
        }
        continue;
      }
      const due = retrying && !run.paused
        ? (now >= run.retryDueAt! ? { dueAt: run.retryDueAt!, late: now - run.retryDueAt! > SCHEDULE_ON_TIME_MS } : null)
        : dueRun(asSchedule(run), now);
      if (!due) {
        // An ended schedule sends nothing; a run it missed before its end date is said once, and kept as "Missed".
        if (run.until !== null && !run.paused && now > run.until + SCHEDULE_ON_TIME_MS) {
          const missed = dueRun({ ...asSchedule(run), until: null }, run.until);
          if (missed) {
            try {
              await replace({ ...run, lastDueAt: missed.dueAt, missedDueAt: missed.dueAt });
              deps.log(`scheduled run: ${clock(missed.dueAt)} not sent: the schedule ended before it could run`);
            } catch (error) {
              deps.log(`scheduled run: ${clock(missed.dueAt)} not recorded yet (${safeFailureReason(error)}); checked again in 30 s`);
            }
          }
        }
        continue;
      }
      try {
        const id = runInputId(run.id, due.dueAt);
        const existing = inputs.find(input => input.id === id);
        if (existing) {
          // A prior enqueue may have reached the outbox even though saving this schedule failed.
          // Reconcile that exact occurrence instead of rebuilding a payload whose mode or dueAt
          // may have changed since the original enqueue.
          if (existing.scheduled?.scheduleId !== run.id || existing.scheduled.dueAt !== due.dueAt) {
            throw new Error('Scheduled outbox identity mismatch');
          }
          const wasAccepted = acceptedInput(existing);
          const { missedDueAt: _cleared, ...withoutMissed } = run;
          // Existing terminal rows are authoritative too: an already-failed
          // occurrence cannot be re-enqueued under the same id. Retaining its
          // retryDueAt here would trap every later recurrence in this branch.
          // Unknown authorized delivery remains a blocker via lastInputId.
          const reconciled = wasAccepted ? withoutMissed : run;
          const { retryDueAt: _retry, ...withoutRetry } = reconciled;
          await replace({ ...withoutRetry, lastDueAt: due.dueAt, lastInputId: id });
          deps.log('scheduled run: reconciled existing outbox row');
          continue;
        }
        const blockingInput = pendingScheduledInput(run, inputs);
        if (blockingInput) {
          deps.log(`scheduled run: ${clock(due.dueAt)} skipped: the previous run still waits in the queue`);
          const { retryDueAt: _retry, ...withoutRetry } = run;
          await replace({ ...withoutRetry, lastDueAt: due.dueAt, lastInputId: blockingInput.id });
          continue;
        }
        // Missed while the app was closed or asleep: skipped unless catching up was chosen, since a
        // stale run can be unexpected or expensive. It is kept as "Missed" until a run goes out again.
        if (!retrying && due.late && !run.catchUp) {
          deps.log(`scheduled run: ${clock(due.dueAt)} missed (the app was closed or asleep); not caught up`);
          await replace({ ...run, lastDueAt: due.dueAt, missedDueAt: due.dueAt });
          continue;
        }
        try {
          await deps.enqueue({ id, sessionId: run.sessionId, text: run.text, mode: session.activeTurnId ? 'after-turn' : 'auto',
            dueAt: due.dueAt, model: null, reasoningEffort: null, scheduled: { scheduleId: run.id, dueAt: due.dueAt, late: due.late } }, { notify: false });
          inputs.push({ id, state: 'queued', scheduled: { scheduleId: run.id, dueAt: due.dueAt, late: due.late } });
        } catch (error) {
          if (!deterministicEnqueueRefusal(error)) {
            // The outbox may have failed to read or commit. Save the occurrence
            // as a retry, never advance lastDueAt, and reconcile the same row id
            // if its commit actually reached disk before the error.
            deps.log(`scheduled run: ${clock(due.dueAt)} outbox unavailable (${safeFailureReason(error)}); will retry the same occurrence`);
            if (!retrying) await replace({ ...run, retryDueAt: due.dueAt });
            continue;
          }
          // A deterministic admission refusal still skips that time once.
          deps.log(`scheduled run: ${clock(due.dueAt)} skipped: it could not be queued (${safeFailureReason(error)})`);
          const { retryDueAt: _retry, ...withoutRetry } = run;
          await replace({ ...withoutRetry, lastDueAt: due.dueAt });
          continue;
        }
        deps.log(`scheduled run: queued${due.late ? ` (late, was due ${clock(due.dueAt)})` : ''}`);
        // If this save fails, the next check reconciles the exact durable outbox row by id.
        const { missedDueAt: _cleared, retryDueAt: _retry, ...sent } = run;
        await replace({ ...sent, lastDueAt: due.dueAt, lastInputId: id });
      } catch (error) {
        deps.log(`scheduled run: ${clock(due.dueAt)} not recorded yet (${safeFailureReason(error)}); checked again in 30 s`);
      }
    }
  });
}
