/**
 * The single ownership join between ChatGPT's page model and an inbound MCP request.
 *
 * ChatGPT puts one opaque request id in both places:
 *   - HTTP `x-request-id` on the MCP request (normalised at ingress), and
 *   - `message.metadata.request_id` on the connector request in the page model.
 *
 * The host's documented openai/session metadata can extend one native proof to later
 * requests, scoped by Setup, connector surface and subject. Its keys are learned only
 * from native proof; tool names, timestamps, active tabs and generation guesses never bind them.
 *
 * Once a native join has been proved it is permanent. `request_id` names one ChatGPT
 * workflow, and the MCP side may keep issuing calls after the page that originally exposed the
 * id has been reloaded, compacted or closed. Expiring the join after ten minutes was the live
 * 1.8.1 bug: the same still-running request went from correctly attributed to Unattributed
 * solely because its browser evidence aged out. A proven owner therefore has no time TTL - and
 * no later observation can move or erase it either.
 *
 * A second conversation claiming a proven id is a page that is wrong about itself: a React tree
 * still mounted from the chat before it, a fresh chat whose client-side thread id has not yet
 * become the server's, an id the site reused. The answer to a page that is wrong is to refuse
 * the claimant, not to disown a request whose calls are still arriving. Disowning it was the
 * visible failure: one contradicting sighting nulled the owner for good, and from then on every
 * call under that id waited fifteen seconds for evidence that could no longer be accepted and
 * landed in Unattributed activity. First proof wins, and it keeps winning.
 */

import { readDurable, writeDurableNow, writeDurableSnapshotSoon } from '../durable.js';
import { logInfo, logWarn } from '../logger.js';
import { indexedSessions, readRecentEvents } from './store.js';
import { attachRequestPlan, reconcileRequestPlans } from './request-plans.js';
import { reconcileAgentRequestOwners } from '../agents.js';

export interface RequestCorrelation {
  requestId: string;
  conversationId: string;
  /** Durable local session epoch that owned this request when the page first proved it. */
  sessionId: string;
  messageId: string;
  tool: string;
  observedAt: number;
  /** Hashes of host conversation metadata learned only from this native page proof. */
  providerSessionKeys?: string[];
  /** A provider-session proof retains the actual native request that established it. */
  providerSessionAnchor?: string;
  providerSessionKey?: string;
}

const MAX_CORRELATIONS = 50_000;
const CORRELATIONS_STATE = 'request-correlations';
/**
 * 5 stores owners and nothing else; 6 also records that browser acknowledgements wait for
 * the snapshot, allowing startup to trust it without replaying canonical history. Version 7
 * retains hashed provider-session bindings and the native anchor of derived request owners.
 *
 * Versions 3 and 4 wrapped each row in a sticky `conflicted` flag, so a row could exist purely
 * to record that its id was unusable. Those rows say nothing this registry can act on any more:
 * read the owner out of the wrapper when one is there, and let a forgotten id be proved again
 * by exact evidence or by the recorded history reconciled below.
 */
const CORRELATIONS_STATE_VERSION = 7;

const byRequest = new Map<string, RequestCorrelation>();
// Derived indexes, never independent ownership: every binding points to a native proof.
const byProviderSession = new Map<string, string | null>();
const pendingProviderSessions = new Map<string, { requestId: string; keys: Set<string> }>();
const uncommittedProviderRequests = new Set<string>();
const MAX_PENDING_PROVIDER_REQUESTS = 2_000;
const MAX_PROVIDER_KEYS_PER_REQUEST = 16;
const PROVIDER_KEY = /^[a-f0-9]{64}$/;
const waiters = new Map<string, Set<() => void>>();
// `ownership.ts` subscribes while the existing correlation -> agents -> kernel -> ownership
// module cycle is still being instantiated. A top-level `const` is in its TDZ at that moment.
// `var` is initialized to undefined during module instantiation, so this lazy set is safe to
// touch from that early subscription without moving correlation ownership into another module.
var correlationListeners: Set<(owner: RequestCorrelation) => void> | undefined;
/**
 * Evidence grace belongs to the request, not each tool call in its workflow. All callers
 * measure their allowance from its first wait, so sequential and overlapping calls cannot
 * restart the clock. Keep the start rather than a spent flag: the recorder's longer grace
 * must remain available after a shorter identity lookup expires. This is only wait accounting,
 * never a negative ownership verdict; exact evidence always wins, even after every deadline.
 * Process-local and bounded: a restart or eviction may grant fresh grace, never an owner.
 */
const evidenceWindowStarts = new Map<string, number>();
const MAX_EVIDENCE_WINDOWS = 2_000;
let restored = false;
let restoring: Promise<void> | null = null;
let providerAdmission: Promise<unknown> = Promise.resolve();

interface PersistedCorrelations {
  version: number;
  /** Version 6 snapshots crossed the browser acknowledgement durability barrier. */
  complete?: boolean;
  entries: RequestCorrelation[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The key a request id is joined on. ChatGPT sometimes sends a tool call's request id with another
 * UUID version digit than the page's message holds (live, #1752: the page had 93ff44d2-cfea-4f32-…,
 * the calls came as 93ff44d2-cfea-9f32-…), and every such call went unattributed. The other 31 hex
 * digits are random, so they still name exactly one request. Any other id is joined as written.
 */
function joinKey(requestId: string): string {
  // Prefixed apart, so an exact-match id can never share a key with a UUID spelled like it.
  return UUID.test(requestId) ? `uuid:${requestId.slice(0, 14)}${requestId.slice(15)}`.toLowerCase() : `id:${requestId}`;
}

/** Wakes the waiters of one key (see joinKey). */
function wake(key: string): void {
  const held = waiters.get(key);
  if (!held) return;
  waiters.delete(key);
  for (const resolve of held) resolve();
}

function trim(): void {
  while (byRequest.size > MAX_CORRELATIONS) {
    const first = byRequest.keys().next().value as string | undefined;
    if (!first) break;
    const evicted = byRequest.get(first);
    byRequest.delete(first);
    for (const providerKey of evicted?.providerSessionKeys ?? []) {
      if (byProviderSession.get(providerKey) === first) byProviderSession.delete(providerKey);
    }
    wake(first);
  }
}

function snapshot(): PersistedCorrelations {
  return {
    version: CORRELATIONS_STATE_VERSION,
    complete: true,
    entries: [...byRequest.values()].map((owner) => ({ ...owner,
      ...(owner.providerSessionKeys ? { providerSessionKeys: [...owner.providerSessionKeys] } : {}) }))
  };
}

function persist(): void {
  writeDurableSnapshotSoon(CORRELATIONS_STATE, snapshot);
}

/**
 * A same-owner re-sighting only moves a request later in the eviction order. Page scans repeat
 * them constantly, and each used to rewrite the whole registry (about 1 MB after a few months,
 * up to 50,000 rows): 15 rewrites in 4 minutes with 14 changing one timestamp (#2133). They are
 * saved in batches instead; a new owner still saves at once and pulls this save forward, and
 * quitting saves it too. A crash can lose a few minutes of order, never an owner.
 */
const FRESHNESS_SAVE_MS = 5 * 60_000;
function persistFreshness(): void {
  writeDurableSnapshotSoon(CORRELATIONS_STATE, snapshot, FRESHNESS_SAVE_MS);
}

/**
 * Subscribe to newly proved request ownership.
 *
 * Consumers that temporarily key state by request id (for example background exec custody)
 * can promote that state to the durable local session the instant exact browser evidence lands.
 * Listeners are synchronous on purpose: the in-memory ownership projection must be coherent
 * before the renderer or a later tool call rereads it.
 */
export function onRequestCorrelation(listener: (owner: RequestCorrelation) => void): () => void {
  (correlationListeners ??= new Set()).add(listener);
  return () => { correlationListeners?.delete(listener); };
}

function publishCorrelation(owner: RequestCorrelation): void {
  for (const listener of correlationListeners ?? []) {
    try { listener({ ...owner }); } catch (error) {
      logWarn(`request correlation listener failed for ${owner.requestId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
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
    && (item.providerSessionKeys === undefined || Array.isArray(item.providerSessionKeys) &&
      item.providerSessionKeys.length <= MAX_PROVIDER_KEYS_PER_REQUEST && item.providerSessionKeys.every(key => typeof key === 'string' && PROVIDER_KEY.test(key)))
    && (item.providerSessionAnchor === undefined && item.providerSessionKey === undefined ||
      typeof item.providerSessionAnchor === 'string' && item.providerSessionAnchor.length > 0 && item.providerSessionAnchor.length <= 200 &&
      typeof item.providerSessionKey === 'string' && PROVIDER_KEY.test(item.providerSessionKey) && item.providerSessionKeys === undefined)
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
  let value = 'value' in (raw as Record<string, unknown>) ? (raw as { value: unknown }).value : raw;
  if (value && typeof value === 'object') {
    const candidate = { ...value } as Partial<RequestCorrelation>;
    // Damaged auxiliary bindings must not discard independently valid native ownership.
    // A damaged derivation, in contrast, must never be reinterpreted as native proof.
    if (candidate.providerSessionAnchor === undefined && candidate.providerSessionKey === undefined &&
      candidate.providerSessionKeys !== undefined && (!Array.isArray(candidate.providerSessionKeys) ||
        candidate.providerSessionKeys.length > MAX_PROVIDER_KEYS_PER_REQUEST ||
        !candidate.providerSessionKeys.every(key => typeof key === 'string' && PROVIDER_KEY.test(key)))) {
      delete candidate.providerSessionKeys;
    }
    value = candidate;
  }
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
  const key = joinKey(input.requestId);
  const previous = byRequest.get(key);
  // Native request evidence supersedes a provider-session derivation. Preserve its key
  // as an independently observed binding so a contradictory owner disables that alias.
  if (previous?.providerSessionAnchor && !input.providerSessionAnchor) {
    byRequest.set(key, { ...input, providerSessionKeys:
      [...new Set([...(input.providerSessionKeys ?? []), previous.providerSessionKey!])].slice(0, MAX_PROVIDER_KEYS_PER_REQUEST) });
    evidenceWindowStarts.delete(key);
    wake(key);
    return 'stored';
  }
  if (!previous) {
    byRequest.set(key, { ...input });
    evidenceWindowStarts.delete(key);
    trim();
    if (!uncommittedProviderRequests.has(key) || !input.providerSessionAnchor) wake(key);
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
    byRequest.delete(key);
    byRequest.set(key, previous);
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
    await reconcileRequestPlans(requestCorrelation).catch(error => {
      logWarn(`request plan reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    restored = true;
  } finally {
    restoring = null;
  }
}

async function restoreRequestCorrelationsOnce(): Promise<void> {

  const saved = await readDurable<PersistedCorrelations>(CORRELATIONS_STATE);
  let loaded = false;
  const complete = (saved?.version === 6 || saved?.version === CORRELATIONS_STATE_VERSION) && saved.complete === true &&
    Array.isArray(saved.entries) && saved.entries.every((raw) => storedOwner(raw) !== null);
  if (saved && saved.version >= 3 && saved.version <= CORRELATIONS_STATE_VERSION && Array.isArray(saved.entries)) {
    for (const raw of saved.entries.slice(-MAX_CORRELATIONS)) {
      const owner = storedOwner(raw);
      if (!owner) continue;
      merge(owner);
      loaded = true;
    }
    trim();
    for (const owner of byRequest.values()) if (!owner.providerSessionAnchor) indexProviderOwner(owner);
  }

  // Version 6 is committed before the browser receives correlation confirmation. It is the
  // complete owner ledger, so replaying every canonical message shard would add no evidence.
  // Older snapshots were debounced and require one migration scan to close their crash window.
  if (complete) return;

  // The durable index is a debounced snapshot, while attributed tool-call JSONL is appended
  // independently. A crash can therefore leave a perfectly valid *nonempty* snapshot that is
  // merely behind the session history. Treat the snapshot as a fast baseline, not as proof that
  // history has nothing newer. Reconcile the durable request-id facts on every restore; merge()
  // is idempotent for the same conversation and still makes contradictions sticky.
  let sessions;
  try {
    sessions = await indexedSessions();
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
      if (call.attributionMethod !== 'request_id' || call.providerSessionAnchor || !call.requestId || !call.conversationId) continue;
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
  // Publish the migration boundary before startup admits browser/MCP traffic. Every later new
  // owner crosses the same barrier in commitRequestCorrelations().
  await writeDurableNow(CORRELATIONS_STATE, snapshot());
}

/**
 * Durable browser-ack boundary for newly proved request owners.
 *
 * The synchronous registry remains immediately readable by in-flight MCP calls, while the
 * browser waits for this exact snapshot before retiring its correlation evidence. This removes
 * the crash window that previously forced every startup to rescan canonical session history.
 */
export async function commitRequestCorrelations(): Promise<void> {
  await writeDurableNow(CORRELATIONS_STATE, snapshot());
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
  let changed = false, fresher = false;
  const results = inputs.map((input) => {
    const previousObservedAt = byRequest.get(joinKey(input.requestId))?.observedAt;
    const result = merge(input);
    const owner = byRequest.get(joinKey(input.requestId));
    if (result !== 'refused' && owner && !owner.providerSessionAnchor) {
      if (learnProviderKeys(owner)) changed = true;
      indexProviderOwner(owner);
    }
    // A same-owner observation can still advance durable freshness/order. Persist that too so
    // an app restart cannot resurrect the pre-refresh eviction order. A refusal changes nothing
    // and therefore writes nothing.
    if (result === 'stored') changed = true;
    else if (result === 'same' && previousObservedAt !== undefined && input.observedAt > previousObservedAt) fresher = true;
    return result;
  });
  if (changed) persist();
  else if (fresher) persistFreshness();
  const attaching = new Set<string>();
  for (let index = 0; index < inputs.length; index++) {
    if (results[index] === 'refused') continue;
    const requestId = inputs[index]!.requestId;
    if (attaching.has(requestId)) continue;
    attaching.add(requestId);
    const owner = byRequest.get(joinKey(requestId));
    if (!owner) continue;
    if (results[index] === 'stored') publishCorrelation(owner);
    void attachRequestPlan(owner).catch(error => {
      logWarn(`request plan attachment failed for ${requestId}: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (!owner.providerSessionAnchor) for (const providerKey of owner.providerSessionKeys ?? []) publishProviderRequests(providerKey);
  }
  if (attaching.size) void reconcileAgentRequestOwners().catch(error => {
    logWarn(`request worker ownership reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return results;
}

/** Exact request-id lookup. An id no page has proved yet resolves to null. */
export function requestCorrelation(requestId: string | null | undefined): RequestCorrelation | null {
  if (!requestId) return null;
  const held = byRequest.get(joinKey(requestId));
  if (held?.providerSessionAnchor) {
    if (uncommittedProviderRequests.has(joinKey(requestId))) return null;
    const anchor = byRequest.get(joinKey(held.providerSessionAnchor));
    const indexed = byProviderSession.get(held.providerSessionKey!);
    const owner = indexed ? byRequest.get(indexed) : null;
    if (!anchor || anchor.providerSessionAnchor || !owner || owner.providerSessionAnchor ||
      anchor.sessionId !== held.sessionId || anchor.conversationId !== held.conversationId ||
      owner.sessionId !== held.sessionId || owner.conversationId !== held.conversationId ||
      !anchor.providerSessionKeys?.includes(held.providerSessionKey!)) return null;
  }
  return held ? { ...held, ...(held.providerSessionKeys ? { providerSessionKeys: [...held.providerSessionKeys] } : {}) } : null;
}

function indexProviderOwner(owner: RequestCorrelation): void {
  for (const key of owner.providerSessionKeys ?? []) {
    const previousKey = byProviderSession.get(key);
    const previous = previousKey ? byRequest.get(previousKey) : undefined;
    if (previousKey === null) continue;
    if (previous && (previous.conversationId !== owner.conversationId || previous.sessionId !== owner.sessionId)) {
      byProviderSession.set(key, null);
      logWarn(`provider session binding ignored: conflicting native owners for ${key.slice(0, 16)}; dispatch uses existing request identity`);
    } else {
      byProviderSession.set(key, joinKey(owner.requestId));
      if (previousKey === undefined) logInfo(`provider session correlation established ${key.slice(0, 16)} -> conversation ${owner.conversationId}; native request ${owner.requestId}`);
    }
  }
  while (byProviderSession.size > MAX_CORRELATIONS) byProviderSession.delete(byProviderSession.keys().next().value!);
}

function learnProviderKeys(owner: RequestCorrelation): boolean {
  const keys = new Set(owner.providerSessionKeys ?? []);
  const before = keys.size;
  for (const key of pendingProviderSessions.get(joinKey(owner.requestId))?.keys ?? []) {
    if (keys.size < MAX_PROVIDER_KEYS_PER_REQUEST) keys.add(key);
  }
  if (keys.size === before) return false;
  owner.providerSessionKeys = [...keys];
  return true;
}

/** Register one validated host conversation reference before dispatch. New aliases are
 * learned only from native request proof; an unknown request cannot teach another alias.
 * 'refused' rejects only this binding, never tool dispatch or independent native proof. */
export function observeProviderSessionRequest(requestId: string, providerKey: string): Promise<'known' | 'unbound' | 'refused'> {
  if (!requestId || requestId.length > 200 || !PROVIDER_KEY.test(providerKey)) return Promise.resolve('unbound');
  const direct = byRequest.get(joinKey(requestId));
  // Native ownership is independent of provider storage. Reusing an already learned
  // key changes no bookkeeping and must not wait for another chat's durable commit.
  if (direct && !direct.providerSessionAnchor && direct.providerSessionKeys?.includes(providerKey)) return Promise.resolve('known');
  const work = providerAdmission.then(() => observeProviderSessionRequestNow(requestId, providerKey));
  providerAdmission = work.catch(() => undefined);
  return work;
}

async function observeProviderSessionRequestNow(requestId: string, providerKey: string): Promise<'known' | 'unbound' | 'refused'> {
  const key = joinKey(requestId);
  const candidates = pendingProviderSessions.get(key) ?? { requestId, keys: new Set<string>() };
  const alreadyObserved = candidates.keys.has(providerKey);
  if (candidates.keys.size < MAX_PROVIDER_KEYS_PER_REQUEST) candidates.keys.add(providerKey);
  pendingProviderSessions.delete(key);
  pendingProviderSessions.set(key, candidates);
  while (pendingProviderSessions.size > MAX_PENDING_PROVIDER_REQUESTS) pendingProviderSessions.delete(pendingProviderSessions.keys().next().value!);
  const direct = byRequest.get(key);
  if (direct && !direct.providerSessionAnchor) {
    if (learnProviderKeys(direct)) {
      indexProviderOwner(direct);
      await commitRequestCorrelations();
      publishProviderRequests(providerKey);
    }
    return 'known';
  }
  const anchorKey = byProviderSession.get(providerKey);
  const anchor = anchorKey ? byRequest.get(anchorKey) : undefined;
  if (!anchor || anchor.providerSessionAnchor) return anchorKey === null ? 'refused' : 'unbound';
  if (direct && (direct.sessionId !== anchor.sessionId || direct.conversationId !== anchor.conversationId)) {
    if (!alreadyObserved) logWarn(`provider session binding ignored for request ${requestId}; existing request owner disagrees with native anchor; dispatch uses existing request identity`);
    return 'refused';
  }
  if (!direct) {
    const { providerSessionKeys: _keys, ...proof } = anchor;
    const derived = { ...proof, requestId, observedAt: Date.now(),
      providerSessionAnchor: anchor.requestId, providerSessionKey: providerKey };
    // Keep this owner unreadable and its waiters asleep until the durable commit. Native
    // evidence may replace it during disk IO and always wins at publication.
    uncommittedProviderRequests.add(key);
    merge(derived);
    const installed = byRequest.get(key);
    try {
      await commitRequestCorrelations();
    } catch (error) {
      if (byRequest.get(key) === installed) byRequest.delete(key);
      persist();
      throw error;
    } finally {
      uncommittedProviderRequests.delete(key);
    }
    const current = byRequest.get(key);
    const latestAnchorKey = byProviderSession.get(providerKey);
    const latestAnchor = latestAnchorKey ? byRequest.get(latestAnchorKey) : undefined;
    if (!latestAnchor || latestAnchor.sessionId !== anchor.sessionId || latestAnchor.conversationId !== anchor.conversationId) { wake(key); return 'refused'; }
    if (current !== installed) { wake(key); return current?.sessionId === anchor.sessionId && current?.conversationId === anchor.conversationId ? 'known' : 'refused'; }
    wake(key);
    publishCorrelation(derived);
    void attachRequestPlan(derived).catch(error => {
      logWarn(`request plan attachment failed for ${requestId}: ${error instanceof Error ? error.message : String(error)}`);
    });
    void reconcileAgentRequestOwners().catch(error => {
      logWarn(`request worker ownership reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    logInfo(`request attribution: ${requestId} -> conversation ${derived.conversationId}; verified provider session anchored by ${anchor.requestId}`);
  }
  return 'known';
}

function publishProviderRequests(providerKey: string): void {
  const anchorKey = byProviderSession.get(providerKey);
  if (!anchorKey) return;
  for (const [requestKey, candidate] of pendingProviderSessions) {
    if (!candidate.keys.has(providerKey) || byRequest.has(requestKey)) continue;
    void observeProviderSessionRequest(candidate.requestId, providerKey).catch(error =>
      logWarn(`provider session correlation could not be committed: ${error instanceof Error ? error.message : String(error)}`));
  }
}


/**
 * Waits only for this exact id. Late Fiber evidence is allowed; no other request or page
 * state can wake this into a successful ownership decision.
 */
export async function awaitRequestCorrelation(requestId: string | null | undefined, timeoutMs: number): Promise<RequestCorrelation | null> {
  if (!requestId) return null;
  const immediate = requestCorrelation(requestId);
  if (immediate || timeoutMs <= 0) return immediate;

  const now = performance.now();
  const key = joinKey(requestId);
  const startedAt = evidenceWindowStarts.get(key) ?? now;
  if (!evidenceWindowStarts.has(key)) {
    evidenceWindowStarts.set(key, startedAt);
    if (evidenceWindowStarts.size > MAX_EVIDENCE_WINDOWS) {
      evidenceWindowStarts.delete(evidenceWindowStarts.keys().next().value!);
    }
  }
  const remainingMs = timeoutMs - (now - startedAt);
  if (remainingMs <= 0) return null;

  let timer: NodeJS.Timeout | null = null;
  await new Promise<void>((resolve) => {
    const set = waiters.get(key) ?? new Set<() => void>();
    set.add(resolve);
    waiters.set(key, set);
    timer = setTimeout(() => {
      set.delete(resolve);
      if (set.size === 0) waiters.delete(key);
      resolve();
    }, remainingMs);
    timer.unref?.();
  });
  if (timer) clearTimeout(timer);
  return requestCorrelation(requestId);
}

/** A conversation being closed cannot invalidate an already issued request. */
export function resetCorrelationRegistryForTests(): void {
  byRequest.clear();
  byProviderSession.clear();
  pendingProviderSessions.clear();
  uncommittedProviderRequests.clear();
  providerAdmission = Promise.resolve();
  evidenceWindowStarts.clear();
  restored = false;
  restoring = null;
  for (const key of [...waiters.keys()]) wake(key);
}
