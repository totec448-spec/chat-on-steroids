import { randomBytes } from 'node:crypto';
import { writeDurableNow, writeDurableSoon } from './durable.js';
import { logWarn } from './logger.js';
import { currentCall } from './mcp/call-context.js';
import { IDENTITY_EVIDENCE_MS } from './mcp/kernel.js';
import { awaitFreshCallOrigin } from './session/recorder.js';
import { findSessionByConversation, readRecentEvents } from './session/store.js';

/** Durable state for the clean-room Claude Code compatible /loop implementation. */
export const LOOPS_STATE = 'loops';

const MAX_TASKS_PER_SESSION = 50;
const MAX_PROMPT_CHARS = 12_000;
const MAX_REASON_CHARS = 500;
const LOOP_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const MIN_FIXED_INTERVAL_MS = 60_000;
const MIN_DYNAMIC_DELAY_SECONDS = 60;
const MAX_DYNAMIC_DELAY_SECONDS = 60 * 60;
const DYNAMIC_FALLBACK_MS = 20 * 60_000;
const DELIVERY_LEASE_MS = 2 * 60_000;
const RECENT_USER_MESSAGES = 48;

export type LoopMode = 'fixed' | 'dynamic';
export type LoopWakeKind = 'scheduled' | 'fallback';

export interface ParsedLoopInput {
  mode: LoopMode;
  prompt: string;
  intervalMs: number | null;
  requestedInterval: string | null;
  bare: boolean;
}

interface LoopLease {
  token: string;
  clientId: string;
  expiresAt: number;
  kind: LoopWakeKind;
  final?: boolean;
}

export interface LoopTask {
  id: string;
  sessionId: string;
  sourceSeq: number;
  mode: LoopMode;
  prompt: string;
  requestedInterval: string | null;
  intervalMs: number | null;
  createdAt: number;
  expiresAt: number;
  nextWakeAt: number | null;
  nextWakeKind: LoopWakeKind | null;
  stopAt: number | null;
  lastReason: string;
  runCount: number;
  lastRunAt: number | null;
  lease: LoopLease | null;
}

export interface LoopSnapshot {
  version: 1;
  savedAt: number;
  tasks: LoopTask[];
}

export interface LoopDelivery {
  token: string;
  conversationId: string;
  loopId: string;
  mode: LoopMode;
  prompt: string;
}

const tasksBySession = new Map<string, Map<string, LoopTask>>();

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 60 * 60_000,
  hr: 60 * 60_000,
  hrs: 60 * 60_000,
  hour: 60 * 60_000,
  hours: 60 * 60_000,
  d: 24 * 60 * 60_000,
  day: 24 * 60 * 60_000,
  days: 24 * 60 * 60_000
};

function cleanText(value: string, max = MAX_PROMPT_CHARS): string {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function normaliseFixedInterval(ms: number): number {
  // Claude Code's fixed scheduler is cron-backed and therefore has one-minute granularity.
  // Keep that user-visible contract even though this app uses a local interval anchor instead
  // of exposing another cron schema.
  return Math.max(MIN_FIXED_INTERVAL_MS, Math.ceil(ms / 60_000) * 60_000);
}

function parseInterval(amountText: string, unitText: string): number | null {
  const amount = Number.parseInt(amountText, 10);
  const unit = unitText.toLowerCase();
  if (!Number.isSafeInteger(amount) || amount <= 0 || !UNIT_MS[unit]) return null;
  const raw = amount * UNIT_MS[unit];
  if (!Number.isSafeInteger(raw) || raw <= 0) return null;
  return normaliseFixedInterval(raw);
}

/**
 * Parse the public /loop grammar used by current Claude Code.
 *
 * Priority is intentional: a leading compact token wins, then a trailing time-valued
 * "every" clause, otherwise the prompt is dynamic/self-paced. A bare /loop, or a fixed
 * interval with no prompt, uses the modern autonomous-maintenance task.
 */
export function parseLoopInput(rawInput: string): ParsedLoopInput {
  let input = cleanText(rawInput);
  input = input.replace(/^\/(?:loop|proactive)(?=\s|$)/i, '').trim();
  if (!input) {
    return { mode: 'dynamic', prompt: autonomousLoopPrompt(), intervalMs: null, requestedInterval: null, bare: true };
  }

  const leading = input.match(/^(\d+)([smhd])(?:\s+|$)([\s\S]*)$/i);
  if (leading) {
    const intervalMs = parseInterval(leading[1]!, leading[2]!);
    const suppliedPrompt = cleanText(leading[3] ?? '');
    if (!intervalMs) throw new Error('LOOP_BAD_INTERVAL: use a positive interval such as 5m, 2h, or 1d');
    const bare = !suppliedPrompt;
    return {
      mode: 'fixed',
      prompt: bare ? autonomousLoopPrompt() : suppliedPrompt,
      intervalMs,
      requestedInterval: `${leading[1]}${leading[2]!.toLowerCase()}`,
      bare
    };
  }

  const bareEvery = input.match(/^every\s+(\d+)\s*(seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hr|h|days?|d)\s*$/i);
  if (bareEvery) {
    const intervalMs = parseInterval(bareEvery[1]!, bareEvery[2]!);
    if (!intervalMs) throw new Error('LOOP_BAD_INTERVAL: use a positive interval such as 5m, 2h, or 1d');
    return {
      mode: 'fixed',
      prompt: autonomousLoopPrompt(),
      intervalMs,
      requestedInterval: `every ${bareEvery[1]} ${bareEvery[2]!.toLowerCase()}`,
      bare: true
    };
  }

  const trailing = input.match(/^(.*?)(?:\s+)every\s+(\d+)\s*(seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hr|h|days?|d)\s*$/i);
  if (trailing) {
    const prompt = cleanText(trailing[1] ?? '');
    const intervalMs = parseInterval(trailing[2]!, trailing[3]!);
    if (!prompt) throw new Error('LOOP_USAGE: /loop [interval] <prompt>');
    if (!intervalMs) throw new Error('LOOP_BAD_INTERVAL: use a positive interval such as 5m, 2h, or 1d');
    return {
      mode: 'fixed',
      prompt,
      intervalMs,
      requestedInterval: `${trailing[2]} ${trailing[3]!.toLowerCase()}`,
      bare: false
    };
  }

  return { mode: 'dynamic', prompt: input, intervalMs: null, requestedInterval: null, bare: false };
}

function autonomousLoopPrompt(): string {
  return (
    'Autonomous maintenance loop. First, if an approved project root contains .claude/loop.md, read it and treat its current contents as the task for this iteration. If no project-level file is available, use ~/.claude/loop.md when it is accessible through an approved root; project-level instructions win. Re-read the selected file on each iteration so edits take effect. ' +
    'Otherwise continue unfinished work already established in this conversation; if that is complete, tend the current branch or pull request by addressing concrete CI failures, review comments, or merge conflicts. ' +
    'Only when there is no such work should you perform small, reversible cleanup or maintenance. Do not invent a new project or expand scope merely to stay busy.'
  );
}

function sessionTasks(sessionId: string, create = false): Map<string, LoopTask> | null {
  let tasks = tasksBySession.get(sessionId) ?? null;
  if (!tasks && create) {
    tasks = new Map();
    tasksBySession.set(sessionId, tasks);
  }
  return tasks;
}

function snapshot(): LoopSnapshot {
  const tasks: LoopTask[] = [];
  for (const bucket of tasksBySession.values()) {
    for (const task of bucket.values()) tasks.push({ ...task, lease: null });
  }
  return { version: 1, savedAt: Date.now(), tasks };
}

function persistSoon(): void {
  writeDurableSoon(LOOPS_STATE, snapshot());
}

async function persistNow(): Promise<void> {
  await writeDurableNow(LOOPS_STATE, snapshot());
}

function validTask(value: unknown): value is LoopTask {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Partial<LoopTask>;
  return (
    typeof raw.id === 'string' && /^[0-9a-f]{8}$/i.test(raw.id) &&
    typeof raw.sessionId === 'string' && raw.sessionId.length >= 8 && raw.sessionId.length <= 64 &&
    Number.isSafeInteger(raw.sourceSeq) && (raw.sourceSeq ?? -1) >= 0 &&
    (raw.mode === 'fixed' || raw.mode === 'dynamic') &&
    typeof raw.prompt === 'string' && raw.prompt.length <= MAX_PROMPT_CHARS &&
    typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) &&
    typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt) &&
    (raw.intervalMs === null || (typeof raw.intervalMs === 'number' && Number.isFinite(raw.intervalMs) && raw.intervalMs >= MIN_FIXED_INTERVAL_MS)) &&
    (raw.nextWakeAt === null || (typeof raw.nextWakeAt === 'number' && Number.isFinite(raw.nextWakeAt))) &&
    (raw.nextWakeKind === null || raw.nextWakeKind === 'scheduled' || raw.nextWakeKind === 'fallback') &&
    (raw.stopAt === null || (typeof raw.stopAt === 'number' && Number.isFinite(raw.stopAt))) &&
    typeof raw.runCount === 'number' && Number.isSafeInteger(raw.runCount) && raw.runCount >= 0
  );
}

export function restoreLoops(saved: LoopSnapshot | null, now = Date.now()): void {
  tasksBySession.clear();
  if (!saved || saved.version !== 1 || !Array.isArray(saved.tasks)) return;
  for (const candidate of saved.tasks) {
    const expiredWithoutFinalFixedFire = candidate.expiresAt <= now && (candidate.mode !== 'fixed' || candidate.nextWakeAt === null);
    if (!validTask(candidate) || expiredWithoutFinalFixedFire || (candidate.stopAt !== null && candidate.stopAt <= now)) continue;
    const task: LoopTask = {
      ...candidate,
      prompt: cleanText(candidate.prompt),
      requestedInterval: typeof candidate.requestedInterval === 'string' ? cleanText(candidate.requestedInterval, 80) : null,
      lastReason: typeof candidate.lastReason === 'string' ? cleanText(candidate.lastReason, MAX_REASON_CHARS) : '',
      lastRunAt: typeof candidate.lastRunAt === 'number' && Number.isFinite(candidate.lastRunAt) ? candidate.lastRunAt : null,
      lease: null
    };
    sessionTasks(task.sessionId, true)!.set(task.id, task);
  }
}

export function snapshotLoops(): LoopSnapshot {
  return snapshot();
}

async function currentConversation(tool = 'session'): Promise<string> {
  const call = currentCall();
  if (!call) throw new Error('LOOP_CALLER_REQUIRED: loop control must come from a ChatGPT MCP call');
  if (call.caller.conversationId) return call.caller.conversationId;
  if (!call.caller.requestId) throw new Error('LOOP_CALLER_REQUIRED: this call has no request identity');
  const conversationId = await awaitFreshCallOrigin(tool, call.startedAt, IDENTITY_EVIDENCE_MS, {
    requestId: call.caller.requestId
  });
  if (!conversationId) throw new Error('LOOP_CALLER_REQUIRED: could not prove which ChatGPT conversation owns this loop call');
  call.caller.conversationId = conversationId;
  return conversationId;
}

async function currentSession(tool = 'session'): Promise<{ conversationId: string; sessionId: string }> {
  const conversationId = await currentConversation(tool);
  const summary = await findSessionByConversation(conversationId, { requireUnique: true });
  if (!summary) throw new Error('LOOP_SESSION_REQUIRED: this conversation has no unique recorded local session');
  return { conversationId, sessionId: summary.id };
}

async function latestLoopDirective(sessionId: string): Promise<{ seq: number; text: string } | null> {
  const events = await readRecentEvents(sessionId, RECENT_USER_MESSAGES, { kinds: ['user_message'] });
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event || event.kind !== 'user_message') continue;
    const text = event.message.text.trim();
    if (/^\/(?:loop|proactive)(?:\s|$)/i.test(text)) return { seq: event.seq, text };
  }
  return null;
}

function newLoopId(existing: Map<string, LoopTask>): string {
  for (;;) {
    const id = randomBytes(4).toString('hex');
    if (!existing.has(id)) return id;
  }
}

function humanInterval(ms: number): string {
  if (ms % (24 * 60 * 60_000) === 0) return `every ${ms / (24 * 60 * 60_000)} day(s)`;
  if (ms % (60 * 60_000) === 0) return `every ${ms / (60 * 60_000)} hour(s)`;
  return `every ${ms / 60_000} minute(s)`;
}

export async function startLoopFromCurrentCall(input = ''): Promise<string> {
  const { sessionId } = await currentSession();
  const directive = await latestLoopDirective(sessionId);
  if (!directive) throw new Error('LOOP_DIRECTIVE_REQUIRED: start a loop from a user message beginning /loop or /proactive');

  const bucket = sessionTasks(sessionId, true)!;
  for (const task of bucket.values()) {
    if (task.sourceSeq === directive.seq) return loopStartedText(task, true);
  }
  if (bucket.size >= MAX_TASKS_PER_SESSION) throw new Error(`LOOP_LIMIT: this session already has ${MAX_TASKS_PER_SESSION} loop tasks`);

  // The recorder is authoritative. The optional model field is accepted only as a diagnostic
  // cross-check; it never gets to replace or broaden what the user actually typed.
  const supplied = cleanText(input);
  const recordedTail = directive.text.replace(/^\/(?:loop|proactive)(?=\s|$)/i, '').trim();
  if (supplied && supplied !== directive.text && supplied !== recordedTail) {
    throw new Error('LOOP_INPUT_MISMATCH: loop_start input does not match the latest recorded /loop user message');
  }

  const parsed = parseLoopInput(directive.text);
  const now = Date.now();
  const task: LoopTask = {
    id: newLoopId(bucket),
    sessionId,
    sourceSeq: directive.seq,
    mode: parsed.mode,
    prompt: parsed.prompt,
    requestedInterval: parsed.requestedInterval,
    intervalMs: parsed.intervalMs,
    createdAt: now,
    expiresAt: now + LOOP_LIFETIME_MS,
    nextWakeAt: parsed.mode === 'fixed' ? now + parsed.intervalMs! : now + DYNAMIC_FALLBACK_MS,
    nextWakeKind: parsed.mode === 'fixed' ? 'scheduled' : 'fallback',
    stopAt: null,
    lastReason: '',
    runCount: 0,
    lastRunAt: null,
    lease: null
  };
  bucket.set(task.id, task);
  await persistNow();
  return loopStartedText(task, false);
}

function loopStartedText(task: LoopTask, existing: boolean): string {
  const prefix = existing ? 'Loop already scheduled for this exact /loop turn.' : 'Loop scheduled.';
  if (task.mode === 'fixed') {
    return (
      `${prefix}\nloop_id: ${task.id}\nmode: fixed\ncadence: ${humanInterval(task.intervalMs!)}\nauto_expires: 7 days\n` +
      `task: ${task.prompt}\n\nExecute the task once now. Do not wait for the first scheduled fire and do not create a second loop for this same user turn.`
    );
  }
  return (
    `${prefix}\nloop_id: ${task.id}\nmode: dynamic/self-paced\nauto_expires: 7 days\ntask: ${task.prompt}\n\n` +
    `Execute the task once now. At the end of this iteration, call session action=loop_wakeup with loop_id=${task.id}, delay_seconds between 60 and 3600, and a short reason for the chosen delay. ` +
    `If no further iteration is useful, call session action=loop_stop instead. The runtime keeps one ~20 minute fallback heartbeat if an iteration forgets to do either.`
  );
}

function ownTask(bucket: Map<string, LoopTask> | null, loopId: string): LoopTask {
  const id = cleanText(loopId, 20).toLowerCase();
  const task = bucket?.get(id) ?? null;
  if (!task) throw new Error(`LOOP_NOT_FOUND: no active loop ${id || '(missing id)'} belongs to this session`);
  return task;
}

export async function wakeLoopFromCurrentCall(loopId: string, delaySeconds: number, reason = ''): Promise<string> {
  const { sessionId } = await currentSession();
  const task = ownTask(sessionTasks(sessionId), loopId);
  if (task.mode !== 'dynamic') throw new Error('LOOP_FIXED_CADENCE: fixed loops are paced by their interval; use loop_cancel to end one');
  if (!Number.isInteger(delaySeconds) || delaySeconds < MIN_DYNAMIC_DELAY_SECONDS || delaySeconds > MAX_DYNAMIC_DELAY_SECONDS) {
    throw new Error('LOOP_BAD_DELAY: dynamic wakeups must be 60 to 3600 seconds in the future');
  }
  const now = Date.now();
  task.nextWakeAt = now + delaySeconds * 1000;
  task.nextWakeKind = 'scheduled';
  task.stopAt = null;
  task.lastReason = cleanText(reason, MAX_REASON_CHARS);
  task.lease = null;
  await persistNow();
  return `Loop ${task.id} will wake in ${delaySeconds} seconds.${task.lastReason ? ` Reason: ${task.lastReason}` : ''}`;
}

export async function stopLoopFromCurrentCall(loopId: string): Promise<string> {
  const { sessionId } = await currentSession();
  const bucket = sessionTasks(sessionId);
  const task = ownTask(bucket, loopId);
  bucket!.delete(task.id);
  if (bucket!.size === 0) tasksBySession.delete(sessionId);
  await persistNow();
  return `Loop ${task.id} stopped.`;
}

export async function cancelLoopFromCurrentCall(loopId: string): Promise<string> {
  return stopLoopFromCurrentCall(loopId);
}

export async function listLoopsForCurrentCall(now = Date.now()): Promise<string> {
  const { sessionId } = await currentSession();
  cleanupSession(sessionId, now);
  const bucket = sessionTasks(sessionId);
  if (!bucket || bucket.size === 0) return 'No active loop tasks in this session.';
  return [...bucket.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((task) => {
      const next = task.nextWakeAt === null ? 'none' : new Date(task.nextWakeAt).toISOString();
      return `${task.id}  ${task.mode}  next=${next}  runs=${task.runCount}  task=${task.prompt.slice(0, 180)}`;
    })
    .join('\n');
}

function cleanupSession(sessionId: string, now: number): void {
  const bucket = sessionTasks(sessionId);
  if (!bucket) return;
  let changed = false;
  for (const [id, task] of bucket) {
    const expiredWithoutFinalFixedFire = task.expiresAt <= now && (task.mode !== 'fixed' || task.nextWakeAt === null);
    if (expiredWithoutFinalFixedFire || (task.stopAt !== null && task.stopAt <= now)) {
      bucket.delete(id);
      changed = true;
      continue;
    }
    if (task.lease && task.lease.expiresAt <= now) {
      task.lease = null;
      changed = true;
    }
  }
  if (bucket.size === 0) tasksBySession.delete(sessionId);
  if (changed) persistSoon();
}

function dueTask(sessionId: string, now: number): LoopTask | null {
  cleanupSession(sessionId, now);
  const bucket = sessionTasks(sessionId);
  if (!bucket) return null;
  let due: LoopTask | null = null;
  for (const task of bucket.values()) {
    if (task.lease || task.nextWakeAt === null || task.nextWakeAt > now) continue;
    if (!due || task.nextWakeAt < due.nextWakeAt!) due = task;
  }
  return due;
}

function iterationPrompt(task: LoopTask, kind: LoopWakeKind): string {
  const head = `[Chat On Steroids /loop iteration ${task.id}]`;
  if (task.mode === 'fixed') {
    return `${head}\nRe-run the scheduled task now. This is an existing loop iteration; do not create another loop.\n\nTask:\n${task.prompt}`;
  }
  const fallback = kind === 'fallback' ? ' This wake is the runtime fallback because the previous iteration did not explicitly schedule its next wake.' : '';
  return (
    `${head}\nRun the self-paced task again.${fallback}\n\nTask:\n${task.prompt}\n\n` +
    `Before this iteration ends, call session action=loop_wakeup with loop_id=${task.id}, delay_seconds from 60 to 3600 and a short reason, or call session action=loop_stop if the loop should end. ` +
    'Choose the delay from the observed state; do not spin rapidly just to poll.'
  );
}

export async function claimDueLoop(conversationId: string, clientId: string, now = Date.now()): Promise<LoopDelivery | null> {
  const summary = await findSessionByConversation(conversationId, { requireUnique: true });
  if (!summary) return null;
  const task = dueTask(summary.id, now);
  if (!task) return null;
  const kind = task.nextWakeKind ?? 'scheduled';
  const token = randomBytes(16).toString('hex');
  task.lease = {
    token,
    clientId: cleanText(clientId, 100),
    expiresAt: now + DELIVERY_LEASE_MS,
    kind,
    final: task.mode === 'fixed' && task.expiresAt <= now
  };
  persistSoon();
  return {
    token,
    conversationId,
    loopId: task.id,
    mode: task.mode,
    prompt: iterationPrompt(task, kind)
  };
}

function nextFixedWake(task: LoopTask, now: number): number {
  const interval = task.intervalMs!;
  const elapsed = Math.max(0, now - task.createdAt);
  return task.createdAt + (Math.floor(elapsed / interval) + 1) * interval;
}

export async function ackLoopDelivery(conversationId: string, token: string, sent: boolean, now = Date.now()): Promise<boolean> {
  const summary = await findSessionByConversation(conversationId, { requireUnique: true });
  if (!summary) return false;
  const bucket = sessionTasks(summary.id);
  if (!bucket) return false;
  for (const task of bucket.values()) {
    if (!task.lease || task.lease.token !== token) continue;
    const kind = task.lease.kind;
    const final = task.lease.final === true;
    task.lease = null;
    if (!sent) {
      await persistNow();
      return true;
    }
    task.runCount += 1;
    task.lastRunAt = now;
    if (task.mode === 'fixed') {
      if (final) {
        bucket.delete(task.id);
        if (bucket.size === 0) tasksBySession.delete(summary.id);
        await persistNow();
        return true;
      }
      // Advance directly to the first future anchor. Missed periods collapse into this one fire;
      // there is deliberately no catch-up burst.
      task.nextWakeAt = nextFixedWake(task, now);
      task.nextWakeKind = 'scheduled';
    } else if (kind === 'fallback') {
      // The fallback gets exactly one chance to remind the model to self-pace. If that iteration
      // still does not call loop_wakeup/loop_stop, retire it after the same quiet window rather
      // than creating a permanent 20-minute accidental poller.
      task.nextWakeAt = null;
      task.nextWakeKind = null;
      task.stopAt = now + DYNAMIC_FALLBACK_MS;
    } else {
      task.nextWakeAt = now + DYNAMIC_FALLBACK_MS;
      task.nextWakeKind = 'fallback';
      task.stopAt = null;
    }
    await persistNow();
    return true;
  }
  return false;
}

/** Escape while a dynamic /loop is waiting clears its pending wake; fixed cron-style loops remain. */
export async function cancelDynamicWakeups(conversationId: string): Promise<number> {
  const summary = await findSessionByConversation(conversationId, { requireUnique: true });
  if (!summary) return 0;
  const bucket = sessionTasks(summary.id);
  if (!bucket) return 0;
  let removed = 0;
  for (const [id, task] of bucket) {
    if (task.mode !== 'dynamic') continue;
    bucket.delete(id);
    removed += 1;
  }
  if (bucket.size === 0) tasksBySession.delete(summary.id);
  if (removed > 0) await persistNow();
  return removed;
}

export function resetLoopsForTests(): void {
  tasksBySession.clear();
}

/** Test-only deterministic insertion that exercises due/no-catch-up behavior without MCP identity. */
export function putLoopForTests(task: LoopTask): void {
  sessionTasks(task.sessionId, true)!.set(task.id, { ...task, lease: task.lease ? { ...task.lease } : null });
}

export function loopForTests(sessionId: string, id: string): LoopTask | null {
  return sessionTasks(sessionId)?.get(id) ?? null;
}

export function warnLoopPersistence(error: unknown): void {
  logWarn(`loop: could not persist scheduler state: ${(error as Error).message}`);
}
