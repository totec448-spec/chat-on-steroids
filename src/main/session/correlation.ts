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
 * Once that exact join has been proved it is permanent. `request_id` names one ChatGPT
 * workflow, and the MCP side may keep issuing calls after the page that originally exposed the
 * id has been reloaded, compacted or closed. Expiring the join after ten minutes was the live
 * 1.8.1 bug: the same still-running request went from correctly attributed to Unattributed
 * solely because its browser evidence aged out. A proven owner therefore has no time TTL - and
 * no later observation can move or erase it either.
 *
 * One bound remains, and it is a memory bound rather than a lifetime one: the in-memory registry
 * holds MAX_CORRELATIONS ids, and past that the least recently used one is dropped. "Used" means
 * observed by the page *or* looked up by an arriving call, so an id is only ever a candidate once
 * nothing has touched it for 50,000 other request ids — which no workflow that is still running
 * can be. An id dropped that way is not necessarily gone either: restore rebuilds owners from
 * request_id-attributed tool calls in recorded history, which is where the join was written
 * down.
 *
 * A second conversation claiming a proven id is a page that is wrong about itself: a React tree
 * still mounted from the chat before it, a fresh chat whose client-side thread id has not yet
 * become the server's, an id the site reused. The answer to a page that is wrong is to refuse
 * the claimant, not to disown a request whose calls are still arriving. Disowning it was the
 * visible failure: one contradicting sighting nulled the owner for good, and from then on every
 * call under that id waited fifteen seconds for evidence that could no longer be accepted and
 * landed in Unattributed activity. First proof wins, and it keeps winning.
 */

import { readDurable, writeDurableSoon } from '../durable.js';
import { readEverySummary, readRecentEvents } from './store.js';

export interface RequestCorrelation {
  requestId: string;
  conversationId: string;
  /** Durable local session epoch that owned this request when the page first proved it. */
  sessionId: string;
  messageId: string;
  tool: string;
  observedAt: number;
}

const MAX_CORRELATIONS = 50_000;
const CORRELATIONS_STATE = 'request-correlations';
/**
 * 5 stores owners and nothing else, because an owner is now the only verdict there is.
 *
 * Versions 3 and 4 wrapped each row in a sticky `conflicted` flag, so a row could exist purely
 * to record that its id was unusable. Those rows say nothing this registry can act on any more:
 * read the owner out of the wrapper when one is there, and let a forgotten id be proved again
 * by exact evidence or by the recorded history reconciled below.
 */
const CORRELATIONS_STATE_VERSION = 5;

const byRequest = new Map<string, RequestCorrelation>();
const waiters = new Map<string, Set<() => void>>();
let restored = false;
let restoring: Promise<void> | null = null;

interface PersistedCorrelations {
  version: number;
  entries: RequestCorrelation[];
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
    entries: [...byRequest.values()].map((owner) => ({ ...owner }))
  };
}

function persist(): void {
  writeDurableSoon(CORRELATIONS_STATE, snapshot());
}

/**
 * Whether a persisted row still carries everything an owner needs to be restored.
 *
 * The bar is exactly what this registry answers with: a request id, the conversation that
 * proved it, the session epoch that owned it, and when. `tool` is a diagnostic label, kept so
 * a stored row can be read by a human; no caller reads it, and the header above says why it
 * could not be evidence even if one did. Demanding a nonempty one here was therefore a bar the
 * registry itself does not have - and it silently deleted the rows that need restoring most.
 *
 * A request id is published on `message.metadata.request_id` before the `api_tool` message
 * naming the tool exists, so the page proves ownership first and names the tool later. Those
 * early sightings are stored with an empty tool on purpose - the join does not use the name,
 * and waiting for it is what used to file the call under Unattributed activity. Every one of
 * them then failed this check on the next launch, so a workflow whose calls were still arriving
 * lost its proven owner to a restart: the same permanence bug the header describes, arriving
 * through the door marked valid.
 */
function validCorrelation(value: unknown): value is RequestCorrelation {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<RequestCorrelation>;
  return (
    typeof item.requestId === 'string' && item.requestId.length > 0 && item.requestId.length <= 200 &&
    typeof item.conversationId === 'string' && item.conversationId.length > 0 && item.conversationId.length <= 200 &&
    typeof item.sessionId === 'string' && /^[0-9a-z-]{8,64}$/i.test(item.sessionId) &&
    typeof item.messageId === 'string' && item.messageId.length > 0 && item.messageId.length <= 300 &&
    typeof item.tool === 'string' && item.tool.length <= 100 &&
    typeof item.observedAt === 'number' && Number.isFinite(item.observedAt)
  );
}

/**
 * The owner in a persisted row, whatever shape the version that wrote it used.
 *
 * Versions 3 and 4 wrapped it as `{ requestId, value, conflicted }`, where a row with no value
 * was a sticky contradiction. Version 5 stores the owner itself. A wrapper with no usable value
 * carries no owner and is simply dropped, which is all that forgetting an old conflict takes.
 */
function storedOwner(raw: unknown): RequestCorrelation | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = 'value' in (raw as Record<string, unknown>) ? (raw as { value: unknown }).value : raw;
  return validCorrelation(value) ? { ...value } : null;
}

/**
 * Files one sighting against the permanent owner of its request id.
 *
 * Live ChatGPT gives every connector request in one turn the same request_id. messageId and
 * tool identify individual calls inside that turn, so differences there are expected and change
 * nothing. Only the conversation is ownership, and only the first proof of it counts.
 *
 * The session epoch is first-proof-wins for the same conversation as well. Compact & Resume can
 * leave the old page model mounted while a newer local session epoch exists for that same old
 * conversation id, and re-observing the request from that stale page must not drag an in-flight
 * request into the newer epoch.
 */
function merge(input: RequestCorrelation): 'stored' | 'same' | 'refused' {
  const previous = byRequest.get(input.requestId);
  if (!previous) {
    byRequest.set(input.requestId, { ...input });
    trim();
    wake(input.requestId);
    return 'stored';
  }

  // Refused, and nothing else: the entry does not change and no waiter is woken, because a
  // claim this registry does not believe is not an answer for anybody waiting on the id.
  if (previous.conversationId !== input.conversationId) return 'refused';

  if (input.observedAt > previous.observedAt) {
    previous.observedAt = input.observedAt;
    // trim() uses insertion order as the bounded registry's freshness order. Updating the
    // timestamp without moving this key left a live, repeatedly observed old request at the
    // eviction head, so enough newer ids could discard it while genuinely stale ids stayed.
    byRequest.delete(input.requestId);
    byRequest.set(input.requestId, previous);
  }
  return 'same';
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
  if (saved && saved.version >= 3 && saved.version <= CORRELATIONS_STATE_VERSION && Array.isArray(saved.entries)) {
    for (const raw of saved.entries.slice(-MAX_CORRELATIONS)) {
      const owner = storedOwner(raw);
      if (!owner) continue;
      merge(owner);
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
    sessions = await readEverySummary();
  } catch (error) {
    // A valid direct snapshot can be restored before the session store is initialized (some
    // tests and narrowly scoped consumers do exactly that). In the real app the store is ready
    // before this function runs, so stale-snapshot reconciliation still happens there. With no
    // usable snapshot, however, history is the only recovery source and the initialization
    // error must remain visible rather than silently losing ownership.
    if (loaded) return;
    throw error;
  }
  // Oldest first. History is the one source that can disagree with itself here, because it
  // replays proofs this process did not watch happen, and the owner is whichever proof came
  // first. Sessions arrive newest-first, which would have made it whichever one came last.
  for (const session of sessions.slice(0, 100).reverse()) {
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
  // Also when the snapshot on disk is an older version that held nothing usable: rewriting it
  // is what actually removes its conflict rows, and leaving them there would make every
  // later launch re-read a verdict this registry no longer has.
  if (byRequest.size > 0 || loaded || (saved?.version ?? CORRELATIONS_STATE_VERSION) !== CORRELATIONS_STATE_VERSION) persist();
}

/**
 * Adds page evidence. `request_id` is a turn/workflow ownership key, not a per-tool-call id:
 * one ChatGPT turn can legitimately report several message ids/tools under the same key.
 * Re-reporting that key from the same conversation is therefore idempotent, and reporting it
 * from a different one is refused: the owner an id already has is the owner it keeps.
 */
export function observeRequestCorrelation(input: RequestCorrelation): 'stored' | 'same' | 'refused' {
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
): Array<'stored' | 'same' | 'refused'> {
  let changed = false;
  const results = inputs.map((input) => {
    const previousObservedAt = byRequest.get(input.requestId)?.observedAt;
    const result = merge(input);
    // A same-owner observation can still advance durable freshness/order. Persist that too so
    // an app restart cannot resurrect the pre-refresh eviction order. A refusal changes nothing
    // and therefore writes nothing.
    if (result === 'stored' || (result === 'same' && previousObservedAt !== undefined && input.observedAt > previousObservedAt)) {
      changed = true;
    }
    return result;
  });
  if (changed) persist();
  return results;
}

/**
 * Exact request-id lookup. An id no page has proved yet resolves to null.
 *
 * A hit also refreshes the id's place in the eviction order, because being called under is this
 * registry's other liveness signal and the more reliable one. `merge()` already moves a
 * re-observed id out of the eviction head; without the same treatment here, the workflow the
 * header is actually written for — one whose calls keep arriving after the page that proved it
 * was reloaded, compacted or closed — is the workflow that can never refresh itself again, and
 * so the first one a full registry discards. Eviction now follows use rather than page chatter.
 *
 * In memory only, deliberately. Below the cap the order is invisible: the durable snapshot keeps
 * every row and restore reconciles it against recorded history regardless. Persisting a
 * reordering on every lookup would clone the whole registry through the write debounce on the
 * hottest path there is, to record something nothing reads.
 */
export function requestCorrelation(requestId: string | null | undefined): RequestCorrelation | null {
  if (!requestId) return null;
  const held = byRequest.get(requestId);
  if (!held) return null;
  byRequest.delete(requestId);
  byRequest.set(requestId, held);
  return { ...held };
}

/**
 * Waits only for this exact id. Late Fiber evidence is allowed; no other request or page
 * state can wake this into a successful ownership decision.
 */
export async function awaitRequestCorrelation(requestId: string | null | undefined, timeoutMs: number): Promise<RequestCorrelation | null> {
  if (!requestId) return null;
  const immediate = requestCorrelation(requestId);
  if (immediate || timeoutMs <= 0) return immediate;

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
