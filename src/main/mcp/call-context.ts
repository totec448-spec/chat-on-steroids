/**
 * Per-tool-call context.
 *
 * Two problems are solved by the same small store. Tool handlers know things the
 * generic recorder cannot infer — which files changed by how many lines, what a
 * command exited with, how many matches a search found — and the recorder wants that
 * evidence without every handler growing an extra parameter. And in multi-agent mode
 * every log line and every recorded call has to be attributed to the agent that made
 * it, which is decided once per request rather than at each call site.
 *
 * AsyncLocalStorage keeps this correct while several tool calls are in flight: each
 * call sees its own store, and code running outside a call sees nothing at all.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { AssetRef, FileChange, ToolOutcome } from '../../shared/session.js';

export interface CallEvidence {
  changes: FileChange[];
  assets: AssetRef[];
  /** Result count for searches and listings. */
  count: number | null;
  /** Free-form qualifier the summariser may use, e.g. "lines 200-420". */
  detail: string | null;
  exitCode: number | null;
  timedOut: boolean;
  /** Child/process lifetime when the command surface measured it itself. */
  durationMs: number | null;
  /** Explicit child state; null for non-process tools and older call sites. */
  running: boolean | null;
  /** Managed-process id when the command continues beyond one MCP response. */
  processSessionId: string | null;
}

/**
 * What this call was proven to be, rather than what it claimed.
 *
 * Kept in the call context rather than threaded through every handler. There is nothing
 * secret in it: identity here is a conversation id gathered from page evidence, which the
 * recorder writes down on purpose.
 */
export interface CallCaller {
  transportKey: string | null;
  /**
   * ChatGPT's own id for this request, from the `x-request-id` header the connector
   * arrives with, trimmed to the part before the `/`.
   *
   * This is the join. ChatGPT stamps the same id on the request in its own message model,
   * the extension reports it, and the two meet here — so a call names the conversation
   * that issued it outright, rather than being placed by when it happened to arrive.
   * Measured live on 2026-08-18: header `wfr_01a014bdd7cd7a15b6b533d3ce2b42f2/yqy1`
   * against page evidence `read#wfr_01a014bdd7cd7a15b6b533d3ce2b42f2`.
   */
  requestId: string | null;
  /**
   * The ChatGPT conversation this call was proven to come from, when this call's own
   * evidence named one. Never anything the model wrote.
   */
  conversationId: string | null;
}

export interface CallContext {
  /** Wall-clock start of this MCP request, shared by identity-sensitive handlers. */
  startedAt: number;
  /** Stable per-conversation key when the transport offers one, else null. */
  transportKey: string | null;
  /** Resolved agent id in multi-agent mode, else null. */
  agent: string | null;
  /** Who this call was proven to be, for the broker tools to route by. */
  caller: CallCaller;
  /**
   * Set by the tool guard, which is the only code that can tell a refusal apart from
   * a genuine failure — both come back to the model as an error result.
   */
  outcome: ToolOutcome | null;
  evidence: CallEvidence;
  /**
   * An agent whose chat this call would identify, if the recorder can place the call.
   *
   * Only `agents action=spawn` sets it, and only for the prime: the prime's chat is the user's
   * own, so nothing opened it on the app's behalf and there is no report to bind it from.
   * The binding therefore waits for the same evidence the record itself waits for —
   * resolved after the call, because the page renders the block for a call while it is
   * still running and reports it on its own tick, which is usually after the answer.
   */
  bindOnAttribution?: string;
}

const storage = new AsyncLocalStorage<CallContext>();

export function emptyEvidence(): CallEvidence {
  return {
    changes: [],
    assets: [],
    count: null,
    detail: null,
    exitCode: null,
    timedOut: false,
    durationMs: null,
    running: null,
    processSessionId: null
  };
}

export function runInCallContext<T>(context: CallContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * Tool-call lifetime state, split by what is still capable of changing the machine.
 *
 * `running` is the request that has not returned from dispatch yet. This is the count the
 * ChatGPT-native compaction barrier cares about: interrupting the ChatGPT turn does not stop
 * a command/edit already inside this process, and a handoff written while that work is still
 * live can describe a machine state that changes underneath the fresh chat.
 *
 * `settling` is deliberately different. It is a handler that has already returned and whose
 * MCP result has been released, but whose durable session record is still waiting for late
 * browser attribution. The recorder can spend REQUEST_ID_GRACE_MS there. Keeping that state
 * observable is useful for diagnostics and shutdown/orphan accounting, but it is bookkeeping:
 * it must not make every chat wait ~15 seconds before a compaction may describe an otherwise
 * settled machine.
 *
 * Both states are charged per conversation. An unproven owner is conservatively visible to
 * every chat until attribution lands; a proven worker never blocks an unrelated prime.
 */
const running = new Set<CallContext>();
const settling = new Set<CallContext>();
let inFlightRequests = 0;

function countFor(calls: Iterable<CallContext>, conversationId: string | null): number {
  let count = 0;
  for (const call of calls) {
    const owner = call.caller.conversationId;
    if (conversationId === null || owner === null || owner === conversationId) count += 1;
  }
  return count;
}

/** Requests still inside dispatch, and therefore still potentially doing tool work. */
export function runningToolCalls(conversationId: string | null = null): number {
  return countFor(running, conversationId);
}

/** Finished tool work whose unattributed durable record is still landing. */
export function settlingToolCalls(conversationId: string | null = null): number {
  return countFor(settling, conversationId);
}

/**
 * Conservative total used by diagnostics/tests that mean "not fully accounted for yet".
 * A context can briefly appear in both sets during the handoff to recorder settling, so count
 * the union rather than summing the two public projections.
 */
export function inFlightToolCalls(conversationId: string | null = null): number {
  const seen = new Set<CallContext>();
  for (const call of running) seen.add(call);
  for (const call of settling) seen.add(call);
  return countFor(seen, conversationId);
}

/**
 * Keeps a finished call observable while its record is still being written.
 *
 * The unidentified path does not await its own recorder: the append may still spend a grace
 * window waiting for the page to name the conversation, and the model must not wait for
 * that. But the call is not settled either, and dropping it the moment the handler returned
 * left a window in which every chat read zero while an unattributed call was still landing —
 * an attribution/recorder diagnostic would otherwise show a false zero. It is intentionally
 * not part of `runningToolCalls()`: the handler has returned, so recorder bookkeeping cannot
 * mutate the workspace the compaction barrier is trying to freeze.
 */
export function holdWhileSettling(context: CallContext, work: Promise<unknown>): void {
  settling.add(context);
  void work.then(
    () => settling.delete(context),
    () => settling.delete(context)
  );
}

/**
 * MCP requests that have entered dispatch, including time spent waiting for exact browser
 * request-id evidence and the durable recorder append after the handler itself returns.
 * Orphan cleanup needs this wider counter so those gaps can never look like global idleness.
 */
export function inFlightMcpRequests(): number {
  return inFlightRequests;
}

export async function trackMcpRequest<T>(fn: () => Promise<T>): Promise<T> {
  inFlightRequests += 1;
  try {
    return await fn();
  } finally {
    inFlightRequests -= 1;
  }
}

/**
 * Counts one call for as long as it runs, however it ends.
 *
 * Takes the context rather than reading the async store, because it wraps `runInCallContext`
 * rather than running inside it — and holding the object means a conversation identified
 * part-way through the call is charged correctly from that moment on.
 */
export async function trackInFlight<T>(context: CallContext, fn: () => Promise<T>): Promise<T> {
  running.add(context);
  try {
    return await fn();
  } finally {
    running.delete(context);
  }
}

export function currentCall(): CallContext | null {
  return storage.getStore() ?? null;
}

/** Agent id for the call currently running, or null outside one. */
export function currentAgent(): string | null {
  return storage.getStore()?.agent ?? null;
}

/** Who the running call was proven to be. Empty outside a call. */
export function currentCaller(): CallCaller {
  return storage.getStore()?.caller ?? { transportKey: null, requestId: null, conversationId: null };
}

/** Asks for `agent` to be bound to this call's conversation once it can be identified. */
export function bindOnAttribution(agent: string): void {
  const context = storage.getStore();
  if (context) context.bindOnAttribution = agent;
}

export function noteOutcome(outcome: ToolOutcome): void {
  const store = storage.getStore();
  if (!store) return;
  // Keep a wrapper's generic result from overwriting a more specific tool outcome.
  const rank: Record<ToolOutcome, number> = {
    ok: 0,
    process_exit_nonzero: 1,
    tool_rejected: 2,
    tool_internal_error: 3
  };
  if (store.outcome === null || rank[outcome] > rank[store.outcome]) store.outcome = outcome;
}

export function noteChange(change: FileChange): void {
  storage.getStore()?.evidence.changes.push(change);
}

export function noteChanges(changes: readonly FileChange[]): void {
  const store = storage.getStore();
  if (store) store.evidence.changes.push(...changes);
}

export function noteAsset(asset: AssetRef): void {
  storage.getStore()?.evidence.assets.push(asset);
}

export function noteCount(count: number): void {
  const store = storage.getStore();
  if (store) store.evidence.count = count;
}

export function noteDetail(detail: string): void {
  const store = storage.getStore();
  if (store) store.evidence.detail = detail;
}

export function noteProcess(result: {
  id?: string;
  running?: boolean;
  exitCode: number | null;
  durationMs?: number;
}): void {
  const store = storage.getStore();
  if (!store) return;
  store.evidence.exitCode = result.exitCode;
  if (typeof result.running === 'boolean') store.evidence.running = result.running;
  if (typeof result.id === 'string' && result.id) store.evidence.processSessionId = result.id;
  if (typeof result.durationMs === 'number') store.evidence.durationMs = result.durationMs;
}

export function noteExec(result: {
  id?: string;
  running?: boolean;
  exitCode: number | null;
  timedOut?: boolean;
  durationMs?: number;
  /**
   * The caller has proven this non-zero exit is a reported result, not a failure. Only
   * `exec_command` can know this, because only it has the command line.
   */
  benignExit?: boolean;
}): void {
  const store = storage.getStore();
  if (!store) return;
  noteProcess(result);
  store.evidence.timedOut = result.timedOut === true;
  // A timeout is our failure and outranks a child status; benign child statuses are exempt.
  const exempt = result.benignExit === true;
  if (result.exitCode !== null && result.exitCode !== 0 && !exempt) {
    noteOutcome('process_exit_nonzero');
  }
  if (result.timedOut === true) noteOutcome('tool_internal_error');
}
