/**
 * The single ownership join between ChatGPT's page model and an inbound MCP request.
 *
 * ChatGPT puts one opaque request id in both places:
 *   - HTTP `x-request-id` on the MCP request (normalised at ingress), and
 *   - `message.metadata.request_id` on the connector request in the page model.
 *
 * Nothing else is ownership evidence. In particular, tool names, timestamps, rendered
 * connector rows, the active tab and "the only chat generating" never enter this registry.
 *
 * Once that exact join has been proved, ownership is durable. `request_id` names one ChatGPT
 * workflow, and the MCP side may keep issuing calls after the page that originally exposed the
 * id has been reloaded, compacted or closed. Expiring the join after ten minutes was the live
 * 1.8.1 bug: the same still-running request went from correctly attributed to Unattributed
 * solely because its browser evidence aged out. A proven owner therefore has no time TTL.
 */

import { readDurable, writeDurableSoon } from '../durable.js';
import { listAllSessions, readRecentEvents } from './store.js';

export interface RequestCorrelation {
  requestId: string;
  conversationId: string;
  /** Durable local session epoch that owned this request when the page first proved it. */
  sessionId: string;
  messageId: string;
  tool: string;
  observedAt: number;
}

interface HeldCorrelation {
  value: RequestCorrelation | null;
  /** A contradiction is sticky; null alone must not look absent. */
  conflicted: boolean;
}

const MAX_CORRELATIONS = 50_000;
const CORRELATIONS_STATE = 'request-correlations';
/**
 * 4 drops only the sticky conflicts version 3 wrote while preserving its proven owners.
 *
 * Version 3 correctly stopped treating a URL/Fiber mismatch itself as a contradiction, but a
 * second path remained: the content script deliberately retained the currently-owned Fiber
 * turn across the fresh-chat provisional-client-thread race, asked `/correlations` whether its
 * request ids really belonged to the new URL, then emitted ordinary `tool_evidence` before that
 * acknowledged verdict. A stale retained turn could therefore be rejected by the safe handshake
 * and still immediately poison the registry through the transcript channel. Those v3 conflict
 * rows cannot be distinguished on disk from a real contradiction. Drop them once and let exact
 * evidence/history decide again, while retaining all non-conflicted v3 owners so migration does
 * not throw away the durable index merely to repair two bad rows.
 */
const CORRELATIONS_STATE_VERSION = 4;

const byRequest = new Map<string, HeldCorrelation>();
const waiters = new Map<string, Set<() => void>>();
let restored = false;
let restoring: Promise<void> | null = null;

interface PersistedCorrelation {
  requestId: string;
  value: RequestCorrelation | null;
  conflicted: boolean;
}

interface PersistedCorrelations {
  version: number;
  entries: PersistedCorrelation[];
}

function wake(requestId: string): void {
  const held = waiters.get(requestId);
  if (!held) return;
  waiters.delete(requestId);
  for (const resolve of held) resolve();
}

function trim(): void {
  while (byRequest.size > MAX_CORRELATIONS) {
    const first = byRequest.keys().next().value as string | undefined;
    if (!first) break;
    byRequest.delete(first);
    wake(first);
  }
}

function snapshot(): PersistedCorrelations {
  return {
    version: CORRELATIONS_STATE_VERSION,
    entries: [...byRequest].map(([requestId, held]) => ({
      requestId,
      value: held.value ? { ...held.value } : null,
      conflicted: held.conflicted
    }))
  };
}

function persist(): void {
  writeDurableSoon(CORRELATIONS_STATE, snapshot());
}

function validCorrelation(value: unknown): value is RequestCorrelation {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<RequestCorrelation>;
  return (
    typeof item.requestId === 'string' && item.requestId.length > 0 && item.requestId.length <= 200 &&
    typeof item.conversationId === 'string' && item.conversationId.length > 0 && item.conversationId.length <= 200 &&
    typeof item.sessionId === 'string' && /^[0-9a-z-]{8,64}$/i.test(item.sessionId) &&
    typeof item.messageId === 'string' && item.messageId.length > 0 && item.messageId.length <= 300 &&
    typeof item.tool === 'string' && item.tool.length > 0 && item.tool.length <= 100 &&
    typeof item.observedAt === 'number' && Number.isFinite(item.observedAt)
  );
}

function merge(input: RequestCorrelation): 'stored' | 'same' | 'conflict' {
  const previous = byRequest.get(input.requestId);
  if (!previous) {
    byRequest.set(input.requestId, { value: { ...input }, conflicted: false });
    trim();
    wake(input.requestId);
    return 'stored';
  }

  if (previous.conflicted || !previous.value) {
    previous.conflicted = true;
    previous.value = null;
    wake(input.requestId);
    return 'conflict';
  }

  // Live ChatGPT gives every connector request in one turn the same request_id. messageId and
  // tool identify individual calls inside that turn, so differences there are expected and
  // must not poison the ownership join. Conversation disagreement is the actual conflict.
  //
  // Session epoch is intentionally first-proof-wins for the same conversation. Compact &
  // Resume can later leave the old page model mounted while a new local session epoch exists
  // for that same old conversation id. Re-observing the same request from that stale page must
  // not move an already-proved in-flight request into the newer stale session.
  if (previous.value.conversationId === input.conversationId) {
    if (input.observedAt > previous.value.observedAt) {
      previous.value.observedAt = input.observedAt;
      // trim() uses insertion order as the bounded registry's freshness order. Updating the
      // timestamp without moving this key left a live, repeatedly observed old request at the
      // eviction head, so enough newer ids could discard it while genuinely stale ids stayed.
      // Delete+set is only for the already-proved same owner; contradictions remain sticky.
      byRequest.delete(input.requestId);
      byRequest.set(input.requestId, previous);
    }
    return 'same';
  }

  previous.conflicted = true;
  previous.value = null;
  wake(input.requestId);
  return 'conflict';
}

/**
 * Restores request ownership before the bridge starts accepting page/MCP traffic.
 *
 * 1.8.2 persists this index directly. On the first 1.8.2 launch there is no index yet, so
 * rebuild it once from already-recorded request_id-attributed tool calls. Those records are
 * themselves the result of the exact page↔HTTP join, and let an old still-running workflow
 * remain owned across the upgrade even if its original tab is already gone.
 */
export async function restoreRequestCorrelations(): Promise<void> {
  if (restored) return;
  if (restoring) return restoring;
  restoring = restoreRequestCorrelationsOnce();
  try {
    await restoring;
    restored = true;
  } finally {
    restoring = null;
  }
}

async function restoreRequestCorrelationsOnce(): Promise<void> {

  const saved = await readDurable<PersistedCorrelations>(CORRELATIONS_STATE);
  let loaded = false;
  const migrateV3 = saved?.version === 3 && Array.isArray(saved.entries);
  if ((saved?.version === CORRELATIONS_STATE_VERSION || migrateV3) && Array.isArray(saved.entries)) {
    for (const raw of saved.entries.slice(-MAX_CORRELATIONS)) {
      if (!raw || typeof raw !== 'object' || typeof raw.requestId !== 'string') continue;
      if (raw.conflicted === true) {
        // v3 cannot tell a real contradiction from the provisional-owned-turn bypass fixed in
        // v4. Forget only that verdict; recent attributed history below can immediately restore
        // the legitimate first owner. Conflicts created by v4's corrected protocol remain sticky.
        if (migrateV3) continue;
        byRequest.set(raw.requestId, { value: null, conflicted: true });
        loaded = true;
        continue;
      }
      if (!validCorrelation(raw.value) || raw.value.requestId !== raw.requestId) continue;
      merge(raw.value);
      loaded = true;
    }
    trim();
  }

  // The durable index is a debounced snapshot, while attributed tool-call JSONL is appended
  // independently. A crash can therefore leave a perfectly valid *nonempty* snapshot that is
  // merely behind the session history. Treat the snapshot as a fast baseline, not as proof that
  // history has nothing newer. Reconcile the durable request-id facts on every restore; merge()
  // is idempotent for the same conversation and still makes contradictions sticky.
  let sessions;
  try {
    sessions = await listAllSessions();
  } catch (error) {
    // A valid direct snapshot can be restored before the session store is initialized (some
    // tests and narrowly scoped consumers do exactly that). In the real app the store is ready
    // before this function runs, so stale-snapshot reconciliation still happens there. With no
    // usable snapshot, however, history is the only recovery source and the initialization
    // error must remain visible rather than silently losing ownership.
    if (loaded) return;
    throw error;
  }
  for (const session of sessions.slice(0, 100)) {
    // The persisted index is the baseline. Reconcile only a bounded newest crash window;
    // parsing every historical JSONL on every launch made startup proportional to years of
    // recorded work and could freeze the main process for a minute before the UI appeared.
    for (const event of await readRecentEvents(session.id, 1024, {
      kinds: ['tool_call'],
      maxBytes: 512 * 1024
    })) {
      if (event.kind !== 'tool_call') continue;
      const call = event.call;
      if (call.attributionMethod !== 'request_id' || !call.requestId || !call.conversationId) continue;
      merge({
        requestId: call.requestId,
        conversationId: call.conversationId,
        sessionId: session.id,
        messageId: `stored:${call.callId}`,
        tool: call.tool,
        observedAt: event.time
      });
    }
  }
  if (byRequest.size > 0 || loaded || migrateV3) persist();
}

/**
 * Adds page evidence. `request_id` is a turn/workflow ownership key, not a per-tool-call id:
 * one ChatGPT turn can legitimately report several message ids/tools under the same key.
 * Re-reporting that key from the same conversation is therefore idempotent; only a different
 * conversation is contradictory and makes the key permanently unresolved for this TTL.
 */
export function observeRequestCorrelation(input: RequestCorrelation): 'stored' | 'same' | 'conflict' {
  return observeRequestCorrelations([input])[0]!;
}

/**
 * Adds one page evidence batch while snapshotting the durable registry at most once.
 *
 * Fiber commonly reports several connector calls from one turn together. Feeding them through
 * the single-item API one by one cloned the complete (up to 50k-entry) registry after every new
 * request id, although `writeDurableSoon()` could only keep the newest pending snapshot. Merge
 * the complete synchronous batch first, then queue exactly one snapshot. Individual callers
 * keep the API above, so the durable queue boundary stays synchronous everywhere.
 */
export function observeRequestCorrelations(
  inputs: readonly RequestCorrelation[]
): Array<'stored' | 'same' | 'conflict'> {
  let changed = false;
  const results = inputs.map((input) => {
    const previousObservedAt = byRequest.get(input.requestId)?.value?.observedAt;
    const result = merge(input);
    // A same-owner observation can still advance durable freshness/order. Persist that too so
    // an app restart cannot resurrect the pre-refresh eviction order.
    if (result !== 'same' || (previousObservedAt !== undefined && input.observedAt > previousObservedAt)) changed = true;
    return result;
  });
  if (changed) persist();
  return results;
}

/** Exact request-id lookup. A contradiction and an absent request both resolve to null. */
export function requestCorrelation(requestId: string | null | undefined): RequestCorrelation | null {
  if (!requestId) return null;
  const held = byRequest.get(requestId);
  return held && !held.conflicted && held.value ? { ...held.value } : null;
}

/** Whether this id has contradictory page evidence. Useful only for diagnosis/tests. */
export function requestCorrelationConflicted(requestId: string): boolean {
  return byRequest.get(requestId)?.conflicted === true;
}

/**
 * Waits only for this exact id. Late Fiber evidence is allowed; no other request or page
 * state can wake this into a successful ownership decision.
 */
export async function awaitRequestCorrelation(requestId: string | null | undefined, timeoutMs: number): Promise<RequestCorrelation | null> {
  if (!requestId) return null;
  const immediate = requestCorrelation(requestId);
  if (immediate || requestCorrelationConflicted(requestId) || timeoutMs <= 0) return immediate;

  let timer: NodeJS.Timeout | null = null;
  await new Promise<void>((resolve) => {
    const set = waiters.get(requestId) ?? new Set<() => void>();
    set.add(resolve);
    waiters.set(requestId, set);
    timer = setTimeout(() => {
      set.delete(resolve);
      if (set.size === 0) waiters.delete(requestId);
      resolve();
    }, timeoutMs);
    timer.unref?.();
  });
  if (timer) clearTimeout(timer);
  return requestCorrelation(requestId);
}

/** A conversation being closed cannot invalidate an already issued request. */
export function resetCorrelationRegistryForTests(): void {
  byRequest.clear();
  restored = false;
  restoring = null;
  for (const requestId of [...waiters.keys()]) wake(requestId);
}
