import { z } from 'zod';
import type {
  ControlApiAgents,
  ControlApiEvent,
  ControlApiEvents,
  ControlApiInput,
  ControlApiInputs,
  ControlApiLive,
  ControlApiLog,
  ControlApiSession,
  ControlApiSessionDetail,
  ControlApiSessionList,
  ControlApiText
} from '../shared/control-api.js';
import { positionOf } from '../shared/chronology.js';
import { normalizedToolOutcome, toolCallSummary } from '../shared/session.js';
import type { SessionEvent, SessionEventKind, SessionSummary, StoredText, SwarmState } from '../shared/session.js';
import type { LogEntry } from '../shared/types.js';
import { userPromptText } from '../shared/user-prompt.js';
import { swarmState } from './agents.js';
import { sessionControlsFor } from './bridge.js';
import type { SessionControlsView } from './bridge.js';
import { getLog, logWarn } from './logger.js';
import { redactSecretText } from './redaction.js';
import { deliveryProof, listInputs } from './session/input.js';
import type { InputEntry } from './session/input.js';
import { readSession, readSessionEvents, readSessionList, sessionListCursorSchema } from './session/read-model.js';

/**
 * The read routes of the local control API: sessions, their events, the input outbox, agents
 * and the activity log.
 *
 * Each one asks the owner that already serves the renderer and projects the answer through an
 * allowlist: a field is published only by being named below, so a field an owner grows later
 * (a token, a path, a prompt) stays private until someone decides otherwise here. Free text has
 * known credential shapes redacted and is cut to a fixed size; the stored record is untouched.
 */

export class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail?: string) {
    super(code);
  }
}

/** Caps on free text, so a page's size is bounded by its row limit. */
const TEXT_CAP = 4_000;
const TOOL_TEXT_CAP = 2_000;
const TITLE_CAP = 200;
const TASK_CAP = 1_000;
const SUMMARY_CAP = 300;
const CHANGES_CAP = 20;
const CHANGE_PATH_CAP = 200;
const MAX_EVENTS = 100;
/** A chat holds a handful of waits at once; the cap only bounds what a bad owner could hand over. */
const MAX_RECOVERY = 10;

/**
 * Event pages and live session state can read a whole journal, however small the page. A burst
 * of them must not be able to hold many journals in memory at once.
 */
const MAX_HEAVY_READS = 2;
let heavyReads = 0;

async function heavy<T>(work: () => Promise<T>): Promise<T> {
  if (heavyReads >= MAX_HEAVY_READS) throw new RequestError(503, 'busy', 'too many journal reads in flight; retry shortly');
  heavyReads += 1;
  try {
    return await work();
  } finally {
    heavyReads -= 1;
  }
}

// ------------------------------------------------------------------ text

function clip(text: string, cap: number): { text: string; clipped: boolean } {
  if (text.length <= cap) return { text, clipped: false };
  let end = cap;
  // Never end on half of a surrogate pair.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), clipped: true };
}

/** Redact first, then cut: a cut through a key must not leave a recognisable prefix behind. */
function line(value: string, cap: number): string {
  return clip(redactSecretText(value), cap).text;
}

function stored(value: StoredText, cap = TEXT_CAP): ControlApiText {
  const { text, clipped } = clip(redactSecretText(value.text), cap);
  return { text, chars: value.chars, truncated: value.truncated || clipped };
}

function plain(value: string, cap = TEXT_CAP): ControlApiText {
  const { text, clipped } = clip(redactSecretText(value), cap);
  return { text, chars: value.length, truncated: clipped };
}

// ----------------------------------------------------------------- query

const integer = (min: number, max: number) =>
  z.string().regex(/^\d{1,16}$/).transform(Number).pipe(z.number().int().min(min).max(max));

/** Unknown, repeated or malformed parameters are refused rather than ignored. */
function parseQuery<T extends z.ZodRawShape>(params: URLSearchParams, shape: T): z.infer<z.ZodObject<T>> {
  // No prototype, so a parameter named like an Object.prototype member is just an unknown name.
  const raw: Record<string, string> = Object.create(null);
  for (const [key, value] of params) {
    if (Object.hasOwn(raw, key)) throw new RequestError(400, 'invalid_query', 'a parameter was given more than once');
    raw[key] = value;
  }
  const parsed = z.object(shape).strict().safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join('.') : 'query';
    throw new RequestError(400, 'invalid_query', issue?.code === 'unrecognized_keys' ? 'unknown parameter' : where + ' is not valid');
  }
  return parsed.data;
}

function csv<V extends string>(allowed: readonly V[]) {
  return z
    .string()
    .transform((value) => value.split(','))
    .pipe(z.array(z.enum(allowed as [V, ...V[]])).min(1).max(allowed.length));
}

/** Each table is exhaustive by type: a new value cannot appear in an owner without a decision here. */
const EVENT_KINDS: Record<SessionEventKind, true> = {
  session_start: true, user_message: true, assistant_message: true, native_image: true, progress: true,
  page_tool: true, turn_start: true, turn_end: true, chat_error: true, tool_call: true, note: true,
  agent_message: true, handoff: true
};
/** `decision` rows are the planner's internal work and are never listed. */
const INPUT_STATES: Record<Exclude<InputEntry['state'], 'decision'>, true> = {
  queued: true, browser: true, tool: true, sent: true, cancelled: true, failed: true
};
const LOG_LEVELS: Record<LogEntry['level'], true> = { info: true, warn: true, error: true };

const keysOf = <K extends string>(table: Record<K, true>) => Object.keys(table) as K[];

// -------------------------------------------------------------- sessions

export function projectSession(summary: SessionSummary): ControlApiSession {
  return {
    id: summary.id,
    title: line(summary.title, TITLE_CAP),
    conversationId: summary.conversationId,
    projectId: summary.projectId ?? null,
    startedAt: summary.startedAt,
    updatedAt: summary.updatedAt,
    endedAt: summary.endedAt,
    events: summary.events,
    userMessages: summary.userMessages,
    toolCalls: summary.toolCalls,
    lastToolCallAt: summary.lastToolCallAt,
    lastAssistantFinalAt: summary.lastAssistantFinalAt ?? null,
    lastTurnEndAt: summary.lastTurnEndAt ?? null,
    activityExpiresAt: summary.activityExpiresAt ?? null,
    errors: summary.errors,
    toolRejected: summary.toolRejected,
    toolInternalErrors: summary.toolInternalErrors,
    processExitNonzero: summary.processExitNonzero,
    estimatedTokens: summary.estimatedTokens,
    contextTokens: summary.contextTokens,
    lastTurnOutcome: summary.lastTurnOutcome,
    activeTurnId: summary.activeTurnId ?? null,
    // A model picked in an earlier chat of this session says nothing about the attached one.
    model: summary.selectedModel?.conversationId === summary.conversationId ? summary.selectedModel?.model ?? null : null,
    agents: [...summary.agents],
    origin: summary.origin
      ? {
          kind: summary.origin.kind,
          fromSessionId: summary.origin.fromSessionId,
          agentId: summary.origin.agentId,
          task: line(summary.origin.task, TASK_CAP)
        }
      : null
  };
}

const CURSOR = /^(\d{1,16})\.([0-9a-z-]{8,64})$/;

function decodeCursor(value: string) {
  const match = CURSOR.exec(value);
  const parsed = match ? sessionListCursorSchema.safeParse({ updatedAt: Number(match[1]), id: match[2] }) : null;
  if (!parsed?.success) throw new RequestError(400, 'invalid_query', 'cursor is not valid');
  return parsed.data;
}

async function sessionList(params: URLSearchParams): Promise<ControlApiSessionList> {
  const query = parseQuery(params, { limit: integer(1, 50).optional(), cursor: z.string().min(1).max(100).optional() });
  const page = await readSessionList({ cursor: query.cursor ? decodeCursor(query.cursor) : undefined, limit: query.limit ?? 20 });
  const pressure = new Map(page.pressure.map((entry) => [entry.id, entry]));
  return {
    sessions: page.sessions.map((summary) => {
      const { level, advisory, limit } = pressure.get(summary.id)!;
      return { ...projectSession(summary), pressure: { level, advisory, limit } };
    }),
    total: page.total,
    nextCursor: page.nextCursor ? page.nextCursor.updatedAt + '.' + page.nextCursor.id : null,
    activeId: page.activeId
  };
}

/**
 * What the app is doing, or waiting for, in one chat: the same view the renderer polls, cut down
 * to the fields that are a flag, a number, the running turn's id or one of a fixed set of words.
 * Drafts, the goal's objective, the plan, and the continuation's token and ids are free text or
 * handles and stay in the app; the one message a job can carry is redacted and cut like any
 * other free text here.
 */
export function projectLive(controls: SessionControlsView): ControlApiLive {
  const { job, goalWait } = controls;
  return {
    activeTurnId: controls.activeTurnId,
    stopPending: controls.stopPending === true,
    automation: controls.automation,
    blocked: controls.blocked,
    canSendDirectly: controls.canSendDirectly === true,
    canInject: controls.canInject === true,
    queueAtFinish: controls.queueAtFinish === true,
    finishHeld: controls.finishHeld,
    finishWaiting: controls.finishWaiting === true,
    goalWait: goalWait ? { reason: goalWait.reason, until: goalWait.until ?? null } : null,
    recovery: (controls.recovery ?? []).slice(0, MAX_RECOVERY).map((wait) => ({
      kind: wait.kind,
      deadline: wait.deadline,
      visibleAt: wait.visibleAt ?? null,
      next: wait.next ?? null,
      reload: wait.reload === true,
      generating: wait.generating === true
    })),
    job: job
      ? {
          stage: job.stage,
          startedAt: job.startedAt,
          automatic: job.automatic,
          busy: job.busy,
          sourceSend: job.sourceSend.state,
          destinationSend: job.destinationSend.state,
          error: job.error ? line(job.error, SUMMARY_CAP) : null
        }
      : null
  };
}

async function sessionDetail(id: string, params: URLSearchParams): Promise<ControlApiSessionDetail> {
  const query = parseQuery(params, { live: z.literal('1').optional() });
  return heavy(async () => {
    const summary = await readSession(id);
    if (!summary) throw new RequestError(404, 'session_not_found');
    const session = projectSession(summary);
    if (!query.live) return { session };
    // The live state comes from the same code the app runs when a chat is opened. It can load
    // the session into memory and seal a torn last line of its journal, so it is asked for
    // rather than attached to every read. A chat with nothing to describe, or one whose state
    // cannot be read right now, leaves `live` null; the session itself was already read.
    try {
      const controls = await sessionControlsFor(id);
      // A compaction can move the session to a new chat while its live state is being worked out,
      // and then the session describes one chat and part of the state another. The chat has to be
      // the one the session was read with, both before and after.
      const after = await readSession(id);
      if (controls.conversationId !== summary.conversationId || after?.conversationId !== summary.conversationId) {
        return { session, live: null };
      }
      return { session, live: projectLive(controls) };
    } catch (error) {
      if (error instanceof Error && !/^(session_not_recorded|conversation_superseded|conversation_changed)$/.test(error.message)) {
        logWarn('control API: live state unavailable for a session: ' + error.message);
      }
      return { session, live: null };
    }
  });
}

// ---------------------------------------------------------------- events

export function projectEvent(event: SessionEvent): ControlApiEvent {
  const base: ControlApiEvent = {
    seq: event.seq,
    // Where the row sits in history. A revised message keeps its first position but carries its
    // newest seq, so `before` and `after` take this, not `seq`.
    position: positionOf(event),
    time: event.time,
    kind: event.kind,
    source: event.source,
    agent: event.agent,
    turnId: event.turnId,
    model: event.model
  };
  switch (event.kind) {
    case 'session_start':
      return { ...base, conversationId: event.conversationId, title: line(event.title, TITLE_CAP) };
    case 'user_message': {
      // What the user wrote, not the text the app delivered: an app-sent message is framed with
      // instructions and skills that can be far longer than the request itself.
      const authored = event.authoredText ?? userPromptText(event.message.text);
      return {
        ...base,
        message: authored === null || authored === undefined ? stored(event.message) : plain(authored),
        messageId: event.messageId,
        inputId: event.inputId,
        inputDelivery: event.inputDelivery,
        attachments: event.attachments?.length ?? 0,
        images: event.assets?.length ?? 0
      };
    }
    case 'assistant_message':
      return { ...base, message: stored(event.message), messageId: event.messageId, final: event.final, state: event.state, resolvedModel: event.resolvedModel };
    case 'native_image':
      return { ...base, previewStatus: event.previewStatus, width: event.width, height: event.height };
    case 'progress':
    case 'note':
      return { ...base, message: stored(event.message) };
    case 'page_tool':
      return { ...base, label: line(event.label, SUMMARY_CAP) };
    case 'turn_start':
      return { ...base, detail: event.detail && line(event.detail, SUMMARY_CAP) };
    case 'turn_end':
      return { ...base, outcome: event.outcome, detail: event.detail && line(event.detail, SUMMARY_CAP), reason: event.reason };
    case 'chat_error':
      return { ...base, message: stored(event.message), recoverable: event.recoverable, blocking: event.blocking, reason: event.reason };
    case 'tool_call': {
      const call = event.call;
      const summary = toolCallSummary(call);
      return {
        ...base,
        tool: {
          callId: call.callId,
          name: line(call.tool, TITLE_CAP),
          outcome: normalizedToolOutcome(call) ?? String(call.outcome),
          durationMs: call.durationMs,
          attribution: call.attribution,
          summary: {
            title: line(summary.title, SUMMARY_CAP),
            detail: summary.detail && line(summary.detail, SUMMARY_CAP),
            metric: summary.metric && line(summary.metric, SUMMARY_CAP),
            tone: summary.tone,
            kind: summary.kind
          },
          args: stored(call.args, TOOL_TEXT_CAP),
          result: stored(call.result, TOOL_TEXT_CAP),
          changes: (call.changes ?? []).slice(0, CHANGES_CAP).map((change) => ({
            path: line(change.path, CHANGE_PATH_CAP),
            added: change.added,
            removed: change.removed
          }))
        }
      };
    }
    case 'agent_message':
      return { ...base, messageId: event.messageId, from: event.from, to: event.to, message: stored(event.message), delivery: event.delivery };
    case 'handoff':
      return { ...base, handoffId: event.handoffId, chars: event.chars, reason: line(event.reason, SUMMARY_CAP) };
    default:
      // A kind added after this projection was written is named, not described.
      return base;
  }
}

/** One row that cannot be read must not take the rest of the page with it. */
export function projectReadableEvent(event: SessionEvent): ControlApiEvent {
  try {
    return projectEvent(event);
  } catch {
    return { seq: event.seq, position: event.seq, time: event.time, kind: event.kind, source: event.source, unreadable: true };
  }
}

async function sessionEvents(id: string, params: URLSearchParams): Promise<ControlApiEvents> {
  const query = parseQuery(params, {
    from: integer(0, 10_000_000).optional(),
    before: integer(1, 10_000_000).optional(),
    after: integer(0, 10_000_000).optional(),
    limit: integer(1, MAX_EVENTS).optional(),
    kinds: csv(keysOf(EVENT_KINDS)).optional()
  });
  // `from` follows live revisions; `before` and `after` page through history. They are two
  // cursors over different orders, and mixing them would silently ignore one.
  if (query.from !== undefined && (query.before !== undefined || query.after !== undefined)) {
    throw new RequestError(400, 'invalid_query', 'from cannot be combined with before or after');
  }
  return heavy(async () => {
    const page = await readSessionEvents(id, { ...query, limit: query.limit ?? 50 });
    if (!page) throw new RequestError(404, 'session_not_found');
    return { events: page.events.map(projectReadableEvent), total: page.total, nextFrom: page.nextFrom };
  });
}

// ---------------------------------------------------------------- inputs

export function projectInput(entry: InputEntry): ControlApiInput {
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    deliveredSessionId: entry.deliveredSessionId ?? null,
    conversationId: entry.conversationId,
    state: entry.state,
    // What the row proves about delivery, from the one owner of that rule.
    delivery: deliveryProof(entry),
    mode: entry.mode,
    transportIntent: entry.transportIntent ?? null,
    // Filed by the app itself (a recovery pickup or an automatic follow-up), not typed by anyone.
    // A silence boundary alone is not that: it can ride a message a person typed.
    automatic: !!(entry.recovery || entry.finishOwner),
    purpose: entry.purpose ?? null,
    createdAt: entry.createdAt,
    dueAt: entry.dueAt,
    offeredAt: entry.offeredAt ?? null,
    deliveredAt: entry.deliveredAt ?? null,
    sendAuthorizedAt: entry.sendAuthorizedAt ?? null,
    requiresAuthorization: entry.requiresAuthorization === true,
    cancelledByUser: entry.cancelledByUser === true,
    queueOrder: entry.queueOrder ?? null,
    model: entry.model,
    reasoningEffort: entry.reasoningEffort,
    messageId: entry.messageId ?? null,
    error: entry.error ? line(entry.error, SUMMARY_CAP) : null,
    text: plain(entry.text),
    attachments: entry.attachments?.length ?? 0,
    images: entry.images?.length ?? 0
  };
}

/**
 * The rows a caller may see: everything the renderer's outbox lists, optionally in some states,
 * oldest first, keeping the newest `limit`. Ordered by creation, not by the queue's own order:
 * a reordered row sorts ahead of every other, and a cut would then drop the newest last.
 */
export function selectInputs(rows: readonly InputEntry[], query: { state?: readonly string[]; limit: number }) {
  const matching = rows
    .filter((row) => row.purpose !== 'decision' && (!query.state || query.state.includes(row.state)))
    .sort((a, b) => a.createdAt - b.createdAt);
  return { rows: matching.slice(-query.limit), total: matching.length };
}

async function inputs(params: URLSearchParams): Promise<ControlApiInputs> {
  const query = parseQuery(params, { state: csv(keysOf(INPUT_STATES)).optional(), limit: integer(1, 500).optional() });
  const selected = selectInputs(await listInputs(), { state: query.state, limit: query.limit ?? 100 });
  return { inputs: selected.rows.map(projectInput), total: selected.total };
}

// ---------------------------------------------------------------- agents

export function projectAgents(swarm: SwarmState): ControlApiAgents {
  return {
    enabled: swarm.enabled,
    running: swarm.running,
    retainedHistory: swarm.retainedHistory === true,
    agents: swarm.agents.map((agent) => ({
      runId: agent.runId ?? null,
      id: agent.id,
      role: agent.role,
      label: line(agent.label, TITLE_CAP),
      task: plain(agent.task, TASK_CAP),
      state: agent.state,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      conversationId: agent.conversationId,
      createdAt: agent.createdAt,
      activatedAt: agent.activatedAt,
      finishedAt: agent.finishedAt,
      detachedAt: agent.detachedAt,
      sleptAt: agent.sleptAt,
      lastSeenAt: agent.lastSeenAt,
      revivable: agent.revivable,
      pending: agent.pending,
      awaitingAck: agent.awaitingAck,
      delivered: agent.delivered,
      contextTokens: agent.contextTokens,
      result: agent.result === null ? null : plain(agent.result)
    }))
  };
}

// ------------------------------------------------------------------- log

export function projectLog(entries: readonly LogEntry[]): ControlApiLog['entries'] {
  return entries.map((entry) => {
    const { text, clipped } = clip(redactSecretText(entry.message), TEXT_CAP);
    return {
      time: entry.time,
      level: entry.level,
      message: text,
      ...(entry.agent ? { agent: line(entry.agent, TITLE_CAP) } : {}),
      ...(clipped ? { truncated: true as const } : {})
    };
  });
}

function activityLog(params: URLSearchParams): ControlApiLog {
  const query = parseQuery(params, {
    limit: integer(1, 500).optional(),
    since: integer(0, Number.MAX_SAFE_INTEGER).optional(),
    level: csv(keysOf(LOG_LEVELS)).optional()
  });
  const levels: readonly string[] | undefined = query.level;
  const ring = getLog();
  // Inclusive: lines share a millisecond, so a caller that passes the newest time it has seen
  // gets that line again, and drops it, rather than losing one written just after.
  const matching = ring.filter((entry) => (query.since === undefined || entry.time >= query.since) && (!levels || levels.includes(entry.level)));
  return { entries: projectLog(matching.slice(-(query.limit ?? 200))), ringSize: ring.length };
}

// ---------------------------------------------------------------- routes

const SESSION_ROUTE = /^\/v1\/sessions\/([0-9a-z-]{8,64})(\/events)?$/;

/**
 * Undefined when the path is not one of these routes. Ids are generated lowercase, and a
 * case-insensitive match would let a differently cased spelling reach the store on filesystems
 * that ignore case, so only the exact spelling is a route.
 */
export async function serveRead(route: string, params: URLSearchParams): Promise<unknown | undefined> {
  if (route === '/v1/sessions') return sessionList(params);
  if (route === '/v1/inputs') return inputs(params);
  if (route === '/v1/agents') {
    parseQuery(params, {});
    return projectAgents(swarmState());
  }
  if (route === '/v1/log') return activityLog(params);
  const session = SESSION_ROUTE.exec(route);
  if (session) return session[2] ? sessionEvents(session[1]!, params) : sessionDetail(session[1]!, params);
  return undefined;
}
