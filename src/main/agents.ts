/**
 * The multi-agent broker.
 *
 * Experimental and disabled by default. One ChatGPT conversation is the prime agent; it
 * spawns workers, each of which is a separate ChatGPT tab the extension opens. All state
 * lives here, in this app: the browser only opens tabs and types the first message.
 *
 * ## One active run; durable history per prime conversation
 *
 * There is at most one *executing* run at a time. That is the global capacity claim: while any
 * worker is invited, active, detached or waking, another prime cannot start workers. Ownership
 * lasts longer. When the final slot-holder stops, the active incarnation is parked immediately
 * and its entire agent map becomes dormant history keyed by the exact prime conversation. That
 * history holds no global slot, so another chat may run its own workers while the original prime
 * still sees every worker it ever created and may later wake the reusable ones in their exact
 * old ChatGPT conversations once the global execution claim is free.
 *
 * A prime is established only by a successful `spawn` from a conversation this app proved made
 * the call. Its ownership key moves only through the app's authenticated Compact & Resume
 * transaction, including recovery of a durable A→B session move. Nothing infers a prime,
 * promotes one or takes one over.
 *
 * That makes every other question a lookup rather than a guess:
 *
 *   · a call from the active `primeConversationId` is that run's prime;
 *   · a call from a dormant owner may inspect only that owner's history;
 *   · a call from an active worker's bound conversation is that worker;
 *   · a dormant worker conversation remains worker-owned identity but cannot act until its own
 *     prime explicitly wakes it;
 *   · every other conversation is a stranger, and while another run exists it is told
 *     `AGENTS_BUSY` and nothing else — never another prime's history.
 *
 * ## Why spawn is atomic
 *
 * `spawn` used to create workers and then work out who the prime was, which is how a chat
 * that was not the prime ended up owning worker chats. Here the order is fixed and every
 * step that can fail happens before the first mutation: prove the caller's conversation →
 * check it is not a worker → check no other run holds the execution claim → reactivate this
 * prime's own dormant history or create a new owner → create workers. The staged durability
 * boundary can roll a reactivated history back to dormant without losing its old workers.
 *
 * ## Why nobody holds a credential
 *
 * Every agent here is identified by *where it is*, and only by that. The prime is the
 * conversation the user is sitting in; a worker is the conversation this app opened for its
 * slot and watched itself open. Making a model carry a bearer secret through every tool call
 * put a routing token in the transcript for roles that a conversation id already names, and
 * a token the model has to remember is a token it can forget, paste into the wrong chat, or
 * have stripped by ChatGPT's own harness.
 *
 * ## A worker is a worker before it speaks
 *
 * The lifecycle transition is the app's, not the model's. The extension opens the tab, learns
 * its exact `/c/<id>`, and reports it; {@link bindConversation} binds *and activates* the slot
 * in one step, before the model in that chat has said anything. So the first user message in
 * a worker chat is the task itself — there is no handshake to perform, no key to quote, and
 * nothing a worker has to do before it can start working.
 *
 * ## Workers sleep; they do not end
 *
 * A worker used to be one job in one throwaway chat. It reported, its slot became a
 * tombstone, and more work meant another `spawn` — another conversation, discarded again
 * minutes later. That is exactly the pattern ChatGPT itself pushes back on, and it threw away
 * the most valuable thing the run had: a chat that already understood the task.
 *
 * So the end of a worker's *turn* is not the end of the worker. It goes to `sleeping` in the
 * chat it already has, keeping its conversation, its transcript, its workspace and its inbox,
 * and it releases its slot while it is there. `agents action=message` to a sleeping worker is
 * a revival: the broker reserves a slot, the app reopens that exact `/c/<id>`, and the
 * extension types the prime's message into it as an ordinary user message. None of that needs
 * the tab to still be open, and none of it needs the model to remember anything.
 *
 * Three things put a worker to sleep, and they are all the app's observations rather than the
 * model's assertions: an explicit `agents action=finish`, a settled final assistant answer in
 * its chat, and silence long enough that no turn can still be running. Waking is symmetric —
 * a revival the prime asked for, or a proven tool call from a worker that turned out not to
 * have been asleep after all.
 *
 * The one thing that is genuinely terminal is the worker's own context. Past
 * {@link WORKER_CONTEXT_CEILING_TOKENS} there is nothing left to reuse, so the next time that
 * worker stops working it stops for good. Crossing the ceiling never *stops* a worker
 * mid-task: it only decides what the end of that task means.
 */

import { randomUUID } from 'node:crypto';
import type { AgentInfo, AgentMessage, AgentState, SwarmState } from '../shared/session.js';
import { getConfig } from './config.js';
import { logInfo, logWarn } from './logger.js';
import { inheritWorkspace, releasePrimeWorkspace } from './workspace.js';

export const PRIME_ID = 'prime';

/**
 * Unacknowledged messages held per agent before the broker pushes back.
 *
 * Reached only if an agent stops calling tools entirely while the other side keeps talking.
 * Dropping the oldest to make room quietly destroyed exactly the messages most likely to
 * matter while still telling the sender "Sent", so the limit is a refusal instead.
 */
const MAX_QUEUE = 200;
export const MAX_MESSAGE_CHARS = 4000;
/**
 * Maximum broker prose appended to one MCP result.
 *
 * The queue can legitimately hold 200 × 4k messages. Offering that whole backlog at once
 * makes the delivery mechanism itself an ~800k-character tool result; if the client refuses or
 * truncates it, at-least-once semantics faithfully re-offer the same impossible payload forever.
 * Deliver a bounded oldest-first slice instead. The next authenticated call acknowledges only
 * that offered slice, then the following result advances to the next one.
 */
const MAX_INBOX_OFFER_CHARS = 32_000;
/**
 * Messages one `message` call may carry.
 *
 * Sized to the run rather than to nothing in particular: the worker limit is 8, and the
 * batch that exists to redirect a whole run needs room for one message to each of them plus
 * a couple of corrections.
 */
export const MAX_BATCH_MESSAGES = 16;
const MAX_TASK_CHARS = 4000;
/**
 * A sleeping worker may satisfy an exact repeated spawn only while the original spawn result
 * could realistically still be the result being retried. Beyond this window the same task is
 * new intent: history is persistent now, so lifetime sleeper matching would make it impossible
 * to deliberately create another worker with the same brief.
 */
/**
 * The shared preamble one spawn may put in front of every worker's task.
 *
 * Its own budget rather than a share of the task's: the context is written once and the
 * tasks are written per worker, so charging one against the other would make adding a fourth
 * worker silently shrink the room for the standing instructions all four of them need.
 */
const MAX_CONTEXT_CHARS = 4000;
const MAX_LABEL_CHARS = 60;
/**
 * How long a ChatGPT model slug in a worker's `model` field may be.
 *
 * Slugs are OpenAI's vocabulary, not ours, so this is a transport bound, not a menu: anything
 * shaped like a slug passes through to the fresh-chat URL untouched, and an unknown slug
 * simply opens with the account default rather than failing the spawn.
 */
const MAX_MODEL_CHARS = 80;
const MODEL_SLUG_RE = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * How long a detached worker may make no proven tool call before the run puts it to sleep.
 *
 * The counterweight to {@link workerConversationGone} no longer being fatal. A closed tab is
 * not evidence that a worker stopped — the turn runs on OpenAI's servers — but it does remove
 * the page evidence that would otherwise report the turn ending, so silence is the only
 * ending left for a worker nobody is watching. Long enough to sit through a slow model turn
 * and a long tool call, short enough that an abandoned slot frees itself without the user
 * having to clear it.
 *
 * It is no longer a failure, because it no longer has to be: a slept worker keeps its chat and
 * the prime can wake it. Silence now costs the run a slot back, not a worker.
 */
export const DETACHED_SILENCE_MS = 4 * 60_000;

/**
 * The context a worker chat may reach before it stops being worth reviving.
 *
 * The same 400k figure the app uses for its own context ceiling, and for the same reason: it
 * is where ChatGPT has actually been observed to stop accepting more. Past it a revival would
 * reopen a chat with no room left to work in, so that worker's next stop is its last one.
 *
 * It is never a stop signal. A worker that crosses the line mid-task keeps its slot, keeps its
 * inbox and keeps working until that work is done; all the crossing changes is that the sleep
 * at the end of it is `finished` instead.
 */
export const WORKER_CONTEXT_CEILING_TOKENS = 400_000;


export class AgentError extends Error {}

/** Raised at every `agents` action reached from a conversation outside the active run. */
export class AgentsBusyError extends AgentError {
  constructor() {
    super(
      'AGENTS_BUSY: another ChatGPT conversation is already running the one sub-agent swarm this app supports. ' +
        'Nothing about that run is visible from here. Wait for it to finish, or ask the user to press Clear swarm ' +
        'in Chat On Steroids.'
    );
  }
}

/**
 * Raised when a call meant for the run could not be placed in any conversation.
 *
 * Every identity here is a conversation, so a call this app cannot place is a call it cannot
 * attribute — and the answer to that is to say so, not to accept a key the model is carrying
 * instead. In practice this is a page whose extension is not reporting, and the app's own
 * answer to that is already on its way: an unattributed call is what makes it reload the
 * chats that are working. The message says so, and asks for nothing from the user.
 */
export class IdentityLostError extends AgentError {
  constructor() {
    super(
      'WORKER_IDENTITY_LOST: Chat On Steroids could not tell which conversation this call came from, so it cannot ' +
        'act on the run from here. This usually means the extension in this tab stopped reporting; the app ' +
        'reloads the affected chat shortly because of this unattributed activity. Wait a moment and try once more.'
    );
  }
}

/**
 * An agent that will not act again, whichever way it ended.
 *
 * `finished` and `failed` differ only in what the user is told. Everything that asks "is
 * this run still going", "may this worker still be messaged", "does this worker still owe
 * us a tab" wants both.
 *
 * `detached` is deliberately *not* here. That is the state of a worker whose ChatGPT tab is
 * gone while its turn is not: it still holds its slot, still resolves for its own
 * conversation, still has an inbox, and still reports the ordinary way. Every caller of
 * this function has to keep treating it as live — that is the whole reason the state exists.
 *
 * Nor is `sleeping`. A sleeping worker is a member of the run in every sense except that it
 * is not working: it keeps its conversation, its transcript and its queue, and the prime can
 * wake it by messaging it. Terminal means *this worker will never work again*, and only the
 * context ceiling, a bootstrap that never came up, and a person clearing the row mean that.
 */
export function isOver(state: AgentState): boolean {
  return state === 'finished' || state === 'failed';
}

/**
 * Whether this state consumes one of the run's worker slots.
 *
 * The slot is capacity to be *working*, not membership of the run. `invited` and `waking` are
 * both "a chat is being opened or typed into for this worker right now", and both have to hold
 * a slot or two concurrent revivals could claim the same one. `sleeping` holds nothing: that
 * is what lets a run own more workers than it can ever run at once.
 */
export function occupiesSlot(state: AgentState): boolean {
  return state === 'invited' || state === 'active' || state === 'detached' || state === 'waking';
}

/** Whether this worker's own chat has grown past the point where reviving it buys anything. */
function ceilingCrossed(info: AgentInfo): boolean {
  return info.contextTokens >= WORKER_CONTEXT_CEILING_TOKENS;
}

/**
 * Whether this agent has stopped working, whether or not it can be started again.
 *
 * The question `finish` idempotence asks. A worker that has already reported and gone to sleep
 * must answer a repeated `finish` as the retry it is: taking the second call literally would
 * queue the prime a second copy of the same report with no way to tell that from two genuine
 * ones, which is the bug the original terminal-state check existed to prevent and which
 * sleeping would otherwise reopen.
 */
function hasStopped(state: AgentState): boolean {
  return isOver(state) || state === 'sleeping';
}

/**
 * Whether a stop observed now — a settled answer, a finish call, a chat proved quiet — may end
 * this worker's current work.
 *
 * `waking` says no. The worker is not working, so there is nothing to stop, and the wake that
 * reserved its slot ends only through its own proof (the woken chat's first call or turn) or
 * its own failure. Treating a stop as applicable while waking is how the 2026-09-02 wakes were
 * lost: the page re-reported the settled answer that had put the worker to sleep, the finish
 * landed on the `waking` row as fresh, the worker went back to `sleeping` with the wake
 * command retired as "no longer waiting" — and the message the browser had just typed ran as
 * a turn the app did not own.
 */
function canStop(state: AgentState): boolean {
  return !hasStopped(state) && state !== 'waking';
}

interface Agent {
  info: AgentInfo;
  queue: AgentMessage[];
}

/**
 * The single run, or null.
 *
 * `primeConversationId` is immutable for the lifetime of a run except through
 * {@link commitPrimeTransfer}, which is only ever reached from the commit step of the app's
 * own Compact & Resume session rebind.
 */
interface PrimeTransfer {
  from: string;
  at: number;
  frozen: boolean;
}

interface Run {
  runId: string;
  primeConversationId: string;
  startedAt: number;
  agents: Map<string, Agent>;
  /**
   * An open Compact & Resume handover, at most one.
   *
   * Bookkeeping only: the authority is the session layer's continuation transaction, and
   * this just records that the prime chat is expected to go away right now.
   *
   * It has no clock of its own. The continuation opens it, and the continuation ends it —
   * by committing the move or by cancelling it when the continuation aborts — so it lives
   * exactly as long as the transaction that owns it. An independent ten-minute deadline used
   * to run alongside that transaction, and on 2026-09-01 it won the race: an automatic
   * compaction whose handoff turn took eleven minutes reached its commit with a live
   * continuation and an expired handover, the commit was refused, and the session was left
   * stranded between chat A and chat B. Two clocks for one transaction is how that happens;
   * there is one now.
   *
   * `frozen` marks the handover as committed-to: the session layer freezes it before it
   * starts the durable write, so the run cannot be reactivated or otherwise moved out from
   * under a commit that is already on disk.
   */
  transfer: PrimeTransfer | null;
  /**
   * When the prime's ChatGPT chat was last reported gone, or null while it is there.
   *
   * Telemetry, not a deadline. There is deliberately no clock attached to it: the case this
   * whole mode now exists to serve is a prime that stops, gets feedback from the user hours
   * later, and carries on with the same workers, and any timeout at all would turn a long
   * enough pause back into the destroyed-run bug. Cleared the instant the prime chat proves
   * it exists again.
   */
  primeGoneAt: number | null;
}

let run: Run | null = null;

/**
 * A prime-owned worker family while none of its workers is currently running.
 *
 * This is deliberately separate from {@link run}. `run` is the one global execution claim:
 * while it exists, no unrelated chat may start workers. A dormant run is only durable
 * ownership. It keeps the exact worker conversations, queues, results and context accounting
 * under the prime conversation that created them, but holds no global worker/run slot at all.
 *
 * The distinction is what makes reusable workers and one-global-run compatible. When the last
 * working worker stops, the active incarnation is parked here and `run` becomes null
 * immediately. Another prime may then start its own run. The original prime can still inspect
 * this row, and once the global execution claim is free it can wake one of these exact chats;
 * that creates a fresh run incarnation so stale browser commands from the old incarnation can
 * never bind to the revived worker.
 */
interface DormantRun {
  primeConversationId: string;
  startedAt: number;
  parkedAt: number;
  agents: Map<string, Agent>;
  /** Compact & Resume may move ownership while no worker is running. */
  transfer: PrimeTransfer | null;
}

const dormantRuns = new Map<string, DormantRun>();
/**
 * How much parked history the broker keeps. Every dormant family is scanned on every
 * unattributed call and, through hasDormantWorkerLeases(), turns each such call into a
 * fifteen-second identity wait; by 2026-09-01 three days of runs had left twenty-nine
 * families on disk, so every anonymous call waited on chats nobody would ever wake again.
 * A family older than this, or beyond the newest MAX_DORMANT_RUNS, is dropped and its worker
 * chats become ordinary retired leases; its prime spawns afresh if it ever comes back.
 */
const DORMANT_RUN_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_DORMANT_RUNS = 16;

/**
 * The earliest instant this process can honestly claim to have been watching a conversation.
 *
 * `lastSeenAt` is stamped on every proven call but only written to disk when something else
 * asks for a write, so a restored run can carry a stale one. Failing a detached worker on
 * that number would end a live worker because of a write that never happened; the floor makes
 * a restart start the silence clock again instead.
 */
let livenessFloor = 0;

let spawnRequest: ((workers: WorkerSpawn[]) => void) | null = null;
const listeners = new Set<() => void>();
const endListeners = new Set<(reason: string, retired: RetiredChat[]) => void>();
let persist: (() => void) | null = null;
let persistNow: ((snapshot: SwarmSnapshot | null) => Promise<void>) | null = null;
let criticalMutationRevision = 0;
let persistedCriticalRevision = 0;
let criticalPersistFlight: Promise<boolean> | null = null;
let retiredPersist: (() => void) | null = null;
let retiredPersistNow: ((snapshot: RetiredWorkersSnapshot) => Promise<void>) | null = null;
const RETIRED_WORKER_TTL_MS = 30 * 60_000;
const retiredWorkers = new Map<string, RetiredChat>();
/** Worker objects created by a spawn whose public durable acceptance has not succeeded yet. */
const unpublishedAgents = new WeakSet<Agent>();
/** A brand-new run is itself unpublished until its staged spawn crosses the acceptance barrier. */
let unpublishedRun: Run | null = null;
interface SpawnStageState {
  run: Run;
  created: Agent[];
  becamePrime: boolean;
  /** Existing dormant history temporarily reactivated for this staged spawn, if any. */
  resumedDormant: DormantRun | null;
  /** True only when this staged spawn created a brand-new owner history. */
  createdFreshRun: boolean;
  settled: boolean;
}
/** Only one topology transaction may be open; otherwise rollback could erase dependent work. */
let activeSpawnStage: SpawnStageState | null = null;
/**
 * Messages that are present in the broker snapshot but are not visible to their recipient yet.
 *
 * `agents action=message` has a real durable acceptance barrier. The message has to be part of
 * the snapshot *before* that barrier can write it, but exposing it to offerMessages() before
 * the write succeeds lets a recipient consume work the sender was just told failed. Keep the
 * actual queue object staged until disk accepts the revision. This bit is intentionally not
 * serialized: restoring a message from a durable snapshot is itself proof that acceptance won.
 */
const unpublishedMessages = new WeakSet<AgentMessage>();
/**
 * Worker finishes waiting for their immediate durable acceptance barrier.
 *
 * Unlike a staged message, a finish changes both an AgentInfo row and the prime's queue. Keep
 * neither mutation in the live objects until disk accepts the exact projected snapshot. The
 * critical snapshot overlays these plans; ordinary/debounced snapshots, status and inbox
 * readers continue to see the pre-finish state until commit.
 */
interface FinishStageState {
  run: Run;
  agent: Agent;
  info: AgentInfo;
  report: AgentMessage;
  /**
   * Normal inbox rows whose delivery this finish observation itself proves.
   *
   * Explicit `agents finish` gets this proof later from the kernel's ordinary
   * acknowledgeOffers() call. Browser-owned finalization has no next MCP call, so its settled
   * assistant answer is the only acknowledgement point. Keep these ids in the same staged
   * durability projection as the sleeping state/report; mutating the live queue before that
   * write succeeds would silently lose work on a crash/rejected write.
   */
  acknowledgedMessageIds: string[];
  settled: boolean;
}
const activeFinishStages = new Map<Agent, FinishStageState>();

// ------------------------------------------------------------------ listeners

export function onSwarmChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type SwarmMutationDurability = 'critical' | 'telemetry';

function changed(durability: SwarmMutationDurability = 'critical'): void {
  if (durability === 'critical') criticalMutationRevision += 1;
  persist?.();
  for (const listener of listeners) listener();
}

/** The store registers here so the broker needs to know nothing about files. */
export function onSwarmPersist(handler: (() => void) | null): void {
  persist = handler;
}

/**
 * Registers the durable barrier for broker mutations whose loss changes identity, topology,
 * terminal state, or accepted messages. The existing `onSwarmPersist` callback remains the
 * cheap/debounced path for every mutation; this second hook is explicit so callers performing
 * a user-visible critical transition can await disk durability before publishing success.
 *
 * The callback receives the exact snapshot for the revision being drained. That avoids a
 * persistence adapter re-reading mutable broker state after an await and accidentally claiming
 * a different generation durable.
 */
export function onSwarmPersistNow(handler: ((snapshot: SwarmSnapshot | null) => Promise<void>) | null): void {
  persistNow = handler;
}

/**
 * Durably drains all critical broker revisions observed through the end of the write loop.
 * Returns false when the host has not wired an immediate persistence sink yet; it never
 * silently treats the debounced callback as an fsync-equivalent barrier.
 */
export async function persistCriticalSwarmNow(): Promise<boolean> {
  if (!persistNow) return false;
  if (persistedCriticalRevision >= criticalMutationRevision) return true;
  if (!criticalPersistFlight) {
    criticalPersistFlight = (async () => {
      while (persistedCriticalRevision < criticalMutationRevision) {
        const handler = persistNow;
        if (!handler) return false;
        const targetRevision = criticalMutationRevision;
        // Critical acceptance is the one persistence lane allowed to see staged messages.
        // The ordinary/debounced snapshot deliberately hides them: its write can reach disk
        // while this fsync-equivalent barrier is still waiting, and recovering an unpublished
        // message after a crash would make a send durable before the sender was told it
        // succeeded. See snapshotSwarm() and stageMessages().
        const snapshot = snapshotSwarmIncludingUnpublished();
        await handler(snapshot);
        persistedCriticalRevision = Math.max(persistedCriticalRevision, targetRevision);
      }
      return true;
    })().finally(() => {
      criticalPersistFlight = null;
    });
  }
  return criticalPersistFlight;
}

export function onRetiredWorkersPersist(handler: (() => void) | null): void {
  retiredPersist = handler;
}

/** Immediate persistence sink for the post-run worker authority fences. */
export function onRetiredWorkersPersistNow(
  handler: ((snapshot: RetiredWorkersSnapshot) => Promise<void>) | null
): void {
  retiredPersistNow = handler;
}

/**
 * Makes the current retired-worker fence set durable before a caller publishes teardown.
 *
 * A run ending creates two pieces of authority state: the active swarm disappears and every
 * bound worker conversation becomes a short-lived retired lease. Persisting only the first is
 * unsafe: after a crash the old worker chat can otherwise come back as an ordinary chat and use
 * local mutation tools. The lease file is deliberately written first; an extra/stale fence is a
 * temporary refusal, while a missing fence is unintended authority.
 */
export async function persistRetiredWorkersNow(): Promise<boolean> {
  const handler = retiredPersistNow;
  if (!handler) return false;
  await handler(snapshotRetiredWorkers());
  return true;
}

/** Durability barrier for a user-visible broker/worker-authority transition. */
export async function persistAgentAuthorityNow(): Promise<boolean> {
  if (!(await persistRetiredWorkersNow())) return false;
  return persistCriticalSwarmNow();
}

/**
 * Called when a run ends, for any reason.
 *
 * The bridge listens so worker bootstraps queued for the run that just ended are cancelled
 * in the same tick; without it the browser kept opening tabs for workers of a swarm that no
 * longer existed.
 */
export function onSwarmEnd(listener: (reason: string, retired: RetiredChat[]) => void): () => void {
  endListeners.add(listener);
  return () => endListeners.delete(listener);
}

/** A worker chat whose run ended and whose conversation must not immediately become an ordinary chat. */
export interface RetiredChat {
  id: string;
  conversationId: string;
  reason: string;
  retiredAt: number;
}

/** A worker whose chat still has to be opened. Carries no credential. */
export interface WorkerSpawn {
  id: string;
  task: string;
  /** Requested ChatGPT model slug, or null for the account default. */
  model: string | null;
}

/** Workers that exist but have not joined: their chat is still owed. */
export function pendingWorkerSpawns(): WorkerSpawn[] {
  if (!run) return [];
  return [...run.agents.values()]
    .filter(
      (agent) =>
        agent.info.role === 'worker' && agent.info.state === 'invited' && !unpublishedAgents.has(agent)
    )
    .map((agent) => ({ id: agent.info.id, task: agent.info.task, model: agent.info.model }));
}

/**
 * The bridge registers here, so the broker never has to know about HTTP or tabs.
 *
 * Registration replays whatever is already owed: startup restores the run before the bridge
 * exists, so the restore itself has nobody to ask for a tab.
 */
export function onSpawnRequest(handler: (workers: WorkerSpawn[]) => void): () => void {
  spawnRequest = handler;
  const owed = pendingWorkerSpawns();
  if (owed.length > 0) {
    handler(owed);
    logInfo(`multi-agent: ${owed.length} worker chat(s) still owed a tab`);
  }
  return () => {
    if (spawnRequest === handler) spawnRequest = null;
  };
}

// ------------------------------------------------------------------ identity

/**
 * What a caller can offer as proof of who it is. No field is ever an agent id.
 */
export interface Caller {
  /**
   * The ChatGPT conversation this call was proven to come from, and the only identity any
   * agent has.
   *
   * Only ever set from evidence gathered for the call being handled: ChatGPT's own message
   * model naming this exact tool request, in exactly one conversation. Never from anything
   * the model wrote, and never from "the chat that has been active lately".
   */
  conversationId?: string | null;
}

function requireEnabled(): void {
  if (!getConfig().multiAgent.enabled) {
    throw new AgentError('Multi-agent mode is switched off in Chat On Steroids. Ask the user to enable it.');
  }
}

/** The live agent bound to a conversation, prime included. */
function agentForConversationId(conversationId: string): Agent | null {
  if (!run) return null;
  if (conversationId === run.primeConversationId) return run.agents.get(PRIME_ID) ?? null;
  for (const agent of run.agents.values()) {
    if (agent.info.conversationId === conversationId && !isOver(agent.info.state)) return agent;
  }
  return null;
}

/** Prime-owned dormant state, addressed only by the prime conversation that owns it. */
function dormantRunForPrime(conversationId: string | null | undefined): DormantRun | null {
  if (!conversationId) return null;
  return dormantRuns.get(conversationId) ?? null;
}

/**
 * Dormant ownership lookup by exact ChatGPT conversation, prime or worker.
 *
 * Conversation ids are bound exactly once, so a duplicate across owners would indicate
 * corrupted state. Fail closed by returning null rather than choosing an arbitrary owner in
 * that impossible shape.
 */
function dormantAgentForConversation(
  conversationId: string | null | undefined
): { owner: DormantRun; agent: Agent } | null {
  if (!conversationId) return null;
  let found: { owner: DormantRun; agent: Agent } | null = null;
  for (const dormant of dormantRuns.values()) {
    if (dormant.primeConversationId === conversationId) {
      const prime = dormant.agents.get(PRIME_ID);
      if (!prime || found) return null;
      found = { owner: dormant, agent: prime };
      continue;
    }
    for (const agent of dormant.agents.values()) {
      if (agent.info.role !== 'worker' || agent.info.conversationId !== conversationId) continue;
      if (found) return null;
      found = { owner: dormant, agent };
    }
  }
  return found;
}

/**
 * Reclaims one dormant owner into the single active execution slot.
 *
 * The worker family survives; the run incarnation does not. A fresh UUID is mandatory because
 * independently durable browser commands carry the old run id as their stale-command fence.
 */
function reactivateDormantRun(dormant: DormantRun): Run | null {
  if (run) return null;
  if (dormantRuns.get(dormant.primeConversationId) !== dormant) return null;
  // A parked family with an open handover belongs to the continuation moving its prime; it
  // comes back under the new prime chat when that commits, or here once it is cancelled.
  if (dormant.transfer) return null;
  const prime = dormant.agents.get(PRIME_ID);
  if (!prime) return null;
  dormantRuns.delete(dormant.primeConversationId);
  const now = Date.now();
  prime.info.state = 'active';
  prime.info.detachedAt = null;
  prime.info.lastSeenAt = now;
  run = {
    runId: randomUUID(),
    primeConversationId: dormant.primeConversationId,
    // The browser-command fence gets a new incarnation id, but this is still the same prime's
    // worker history. Keep the original history start instead of pretending the workers were
    // created again when one of them wakes.
    startedAt: dormant.startedAt,
    agents: dormant.agents,
    transfer: dormant.transfer,
    primeGoneAt: null
  };
  logInfo(`multi-agent: reactivated workers owned by conversation ${dormant.primeConversationId} as run ${run.runId}`);
  changed();
  return run;
}

/**
 * Kernel ingress hook: a proven tool call from a parked *sleeping* worker reclaims its family
 * while the global execution slot is free, so that the noteAgentAlive() call right after it
 * can revive the worker the same way it would inside a live run.
 *
 * Inside a live run a sleeping worker that keeps calling is revived on the spot ("it never
 * actually stopped"). Parking happens the moment the last worker is thought asleep, so the
 * last worker of every run used to be refused WORKER_SLEEPING mid-turn for exactly the calls
 * that would have revived any of its siblings — on 2026-09-01 six workers hit that. Whether a
 * chat that is visibly running gets its tools must not depend on that bookkeeping accident.
 *
 * Nothing else reactivates here: a prime's ordinary calls, a finished or failed worker, or
 * a family whose prime is mid-handover leave the slot alone, and a lookup never reactivates.
 */
export function reactivateDormantRunForConversation(conversationId: string | null | undefined): boolean {
  if (run || !conversationId) return false;
  const found = dormantAgentForConversation(conversationId);
  if (!found || found.agent.info.role !== 'worker') return false;
  if (found.agent.info.state !== 'sleeping' || !found.agent.info.revivable) return false;
  return reactivateDormantRun(found.owner) !== null;
}

/**
 * Caller-scoped history state. Unlike the renderer's global `swarmState()`, this never exposes
 * another prime's workers merely because that other prime currently owns the execution slot.
 */
export function swarmStateForCaller(caller: Caller): SwarmState {
  requireEnabled();
  if (!caller.conversationId) throw new IdentityLostError();

  if (run) {
    const member = agentForConversationId(caller.conversationId);
    if (member) return stateForAgents(run.agents, true);
  }

  const dormant = dormantRunForPrime(caller.conversationId);
  if (dormant) return stateForAgents(dormant.agents, false);

  if (run) throw new AgentsBusyError();
  throw new AgentError(
    'No sub-agent history belongs to this conversation. Call agents action=spawn to start one.'
  );
}

export interface CallerSwarmStatus {
  self: AgentInfo;
  state: SwarmState;
  /** Null while this owner's history is parked and consumes no global execution claim. */
  runId: string | null;
  /** Capacity this caller can actually use now; zero while another prime owns the global run. */
  freeWorkerSlots: number;
}

/** One caller-scoped status snapshot, so no global run id/slot count can leak across owners. */
export function statusForCaller(caller: Caller): CallerSwarmStatus {
  requireEnabled();
  if (!caller.conversationId) throw new IdentityLostError();
  if (run) {
    const member = agentForConversationId(caller.conversationId);
    if (member) {
      return {
        self: { ...member.info },
        state: stateForAgents(run.agents, true),
        runId: run.runId,
        freeWorkerSlots: freeWorkerSlots()
      };
    }
  }
  const dormant = dormantRunForPrime(caller.conversationId);
  const prime = dormant?.agents.get(PRIME_ID);
  if (dormant && prime) {
    return {
      self: { ...prime.info },
      state: stateForAgents(dormant.agents, false),
      runId: null,
      freeWorkerSlots: run ? 0 : getConfig().multiAgent.maxWorkers
    };
  }
  if (run) throw new AgentsBusyError();
  throw new AgentError(
    'No sub-agent run or worker history belongs to this conversation. Call agents action=spawn to start one.'
  );
}

/**
 * Who is calling, or null.
 *
 * One lookup, because there is one identity: the conversation this call was proven to come
 * from. A call that could not be placed in a conversation belongs to nobody, and saying so
 * is what keeps an unidentified call from being filed under whichever agent was busiest.
 */
function resolve(caller: Caller): Agent | null {
  if (!run || !caller.conversationId) return null;
  return agentForConversationId(caller.conversationId);
}

/** Attribution for an ordinary tool call: only ever a binding, never a claim. */
export function agentForCaller(caller: Caller): string | null {
  if (!getConfig().multiAgent.enabled) return null;
  return resolve(caller)?.info.id ?? null;
}

/**
 * Identity for the one control call a terminal worker is allowed to retry: `agents finish`.
 *
 * Ordinary resolution deliberately hides terminal workers so an ended chat cannot keep using
 * local tools as a live member of the run. A lost `finish` result is different: the broker must
 * recognise the same conversation's tombstone so the dispatcher can re-offer anything that
 * rode on that lost result without reviving the worker or authorising another action.
 *
 * Keep this as a separate lookup rather than widening {@link agentForCaller}. The dispatcher
 * selects it only for the literal finish action; every other call retains the fail-closed live
 * membership rule.
 */
export function agentForFinishCaller(caller: Caller): string | null {
  if (!getConfig().multiAgent.enabled) return null;
  return (resolve(caller) ?? retiredAgent(caller))?.info.id ?? null;
}

/**
 * Resolves the caller to a member of the active run, or refuses in the one honest way.
 *
 * Three refusals, deliberately different. A caller with no run at all is told how to start
 * one. A chat that *was* identified and is not in the run learns only `AGENTS_BUSY` — never
 * who the prime is, how many workers there are, or what they are doing. And a call whose
 * conversation could not be established at all is a different failure entirely: it is not a
 * stranger, it is an agent whose identity this app could not read, so it is told that in
 * those words rather than being handed a credential to carry instead.
 */
function requireMember(caller: Caller): Agent {
  requireEnabled();
  if (!run) {
    throw new AgentError(
      'No sub-agent run is active. The chat that calls agents action=spawn becomes the prime agent of a new run.'
    );
  }
  if (!caller.conversationId) throw new IdentityLostError();
  const agent = resolve(caller);
  if (!agent) throw new AgentsBusyError();
  return agent;
}

/** Resolves who is calling, or refuses with something the model can act on. */
export function identify(caller: Caller): AgentInfo {
  requireEnabled();
  if (!caller.conversationId) throw new IdentityLostError();
  const active = resolve(caller);
  if (active) return { ...active.info };
  const dormant = dormantRunForPrime(caller.conversationId);
  const prime = dormant?.agents.get(PRIME_ID);
  if (prime) return { ...prime.info };
  if (run) throw new AgentsBusyError();
  throw new AgentError(
    'No sub-agent run or worker history belongs to this conversation. Call agents action=spawn to start one.'
  );
}

// -------------------------------------------------------------------- state

/**
 * The one message a worker is opened with: the run's shared context, then its own task.
 *
 * Labelled, because the two halves are addressed differently — the context is standing
 * instruction for everyone in the run, the task is this worker's job — and a worker that
 * cannot tell them apart is one that reports back on the house rules.
 */
function briefFor(context: string, task: string): string {
  if (!context) return task;
  return `Shared context for every worker in this run:
${context}

Your task:
${task}`;
}

function makeWorker(id: string, label: string, task: string, model: string | null): Agent {
  return {
    info: {
      id,
      role: 'worker',
      label,
      task,
      model,
      state: 'invited',
      createdAt: Date.now(),
      activatedAt: null,
      finishedAt: null,
      result: null,
      pending: 0,
      awaitingAck: 0,
      delivered: 0,
      conversationId: null,
      detachedAt: null,
      lastSeenAt: null,
      revivable: false,
      sleptAt: null,
      contextTokens: 0
    },
    queue: []
  };
}

function makePrime(conversationId: string): Agent {
  return {
    info: {
      id: PRIME_ID,
      role: 'prime',
      label: 'Prime',
      task: 'Coordinates the workers',
      model: null,
      state: 'active',
      createdAt: Date.now(),
      activatedAt: Date.now(),
      finishedAt: null,
      result: null,
      pending: 0,
      awaitingAck: 0,
      delivered: 0,
      conversationId,
      detachedAt: null,
      lastSeenAt: Date.now(),
      revivable: false,
      sleptAt: null,
      contextTokens: 0
    },
    queue: []
  };
}

// --------------------------------------------------------------------- slots

/** Workers currently holding one of the run's slots, awake or being woken. */
function workingWorkers(): Agent[] {
  if (!run) return [];
  return [...run.agents.values()].filter(
    (agent) => agent.info.role === 'worker' && occupiesSlot(agent.info.state) && !unpublishedAgents.has(agent)
  );
}

/**
 * How many more workers this run may have awake at once.
 *
 * Sleeping workers are deliberately not counted. A run that has spawned eight workers and put
 * seven of them to sleep has seven free slots and eight chats it can go back to, which is the
 * whole shape this mode is now built around.
 */
export function freeWorkerSlots(): number {
  return Math.max(0, getConfig().multiAgent.maxWorkers - workingWorkers().length);
}

function recount(agent: Agent): void {
  const live = agent.queue.filter((message) => message.ackedAt === null && !unpublishedMessages.has(message));
  agent.info.pending = live.length;
  agent.info.awaitingAck = live.filter((message) => message.offeredAt !== null).length;
}

function primeAgent(): Agent {
  const agent = run?.agents.get(PRIME_ID);
  if (!agent) throw new AgentError('No sub-agent run is active.');
  return agent;
}

/**
 * Ends the run: agents, queues, credentials, and — through the end listeners — any worker
 * bootstrap the browser has not opened yet.
 *
 * Half-clearing is what produced the worst observed behaviour, a browser opening tabs for
 * workers of a run that no longer had a prime to report to.
 */
function endRun(reason: string): void {
  if (!run) return;
  // The prime's tool calls switch from `agent:prime` back to its conversation identity the
  // instant this run disappears. Collapse that temporary workspace identity first so the next
  // relative path cannot revive the project the chat was using before it spawned workers.
  releasePrimeWorkspace(run.primeConversationId);
  const retired: RetiredChat[] = [...run.agents.values()]
    // Keep the conversation fence after the active-run tombstone disappears. A terminal
    // worker is still a worker chat: `finish` stops its broker role, not the ChatGPT turn or
    // document itself. Once the prime ACKs the final report, releaseQuiescentRun() destroys the
    // run, so excluding finished/failed workers here also destroyed the only identity record
    // that made endedWorkerNotice() reject their later local-tool calls. The kernel's retired
    // lease is the post-run continuation of that same boundary and therefore applies to every
    // worker conversation the run had bound, terminal or not.
    .filter((agent) => agent.info.role === 'worker' && agent.info.conversationId)
    .map((agent) => ({
      id: agent.info.id,
      conversationId: agent.info.conversationId as string,
      reason,
      retiredAt: Date.now()
    }));
  for (const worker of retired) retiredWorkers.set(worker.conversationId, worker);
  retiredPersist?.();
  const what = `${run.runId} (${[...run.agents.keys()].join(', ')})`;
  run = null;
  consecutiveWakeFailures.clear();
  logInfo(`multi-agent: ended run ${what} — ${reason}`);
  for (const listener of endListeners) listener(reason, retired);
}

/**
 * Releases only the global execution claim while preserving the prime's complete worker
 * history. No worker is retired and no browser command is cancelled here: callers may park
 * only after every slot-holder (invited/active/detached/waking) is gone.
 */
function parkRun(reason: string): boolean {
  if (!run || workingWorkers().length > 0) return false;
  const current = run;
  releasePrimeWorkspace(current.primeConversationId);
  dormantRuns.set(current.primeConversationId, {
    primeConversationId: current.primeConversationId,
    startedAt: current.startedAt,
    parkedAt: Date.now(),
    agents: current.agents,
    transfer: current.transfer
  });
  run = null;
  logInfo(
    `multi-agent: parked run ${current.runId} for conversation ${current.primeConversationId} — ${reason}`
  );
  pruneDormantRuns();
  changed();
  return true;
}

/**
 * Drops parked families past DORMANT_RUN_TTL_MS or beyond MAX_DORMANT_RUNS, oldest parked
 * first. A family whose prime is mid-handover is never dropped: the continuation owns it.
 * Evicted worker chats keep the ordinary retired-worker fence so a stale tab cannot become an
 * anonymous chat with tools the moment its history is forgotten.
 */
function pruneDormantRuns(now = Date.now()): boolean {
  const candidates = [...dormantRuns.values()]
    .filter((dormant) => !dormant.transfer)
    .sort((a, b) => a.parkedAt - b.parkedAt);
  const evict = candidates.filter(
    (dormant, index) => now - dormant.parkedAt >= DORMANT_RUN_TTL_MS || candidates.length - index > MAX_DORMANT_RUNS
  );
  if (evict.length === 0) return false;
  for (const dormant of evict) {
    dormantRuns.delete(dormant.primeConversationId);
    for (const agent of dormant.agents.values()) {
      if (agent.info.role !== 'worker' || !agent.info.conversationId) continue;
      retiredWorkers.set(agent.info.conversationId, {
        id: agent.info.id,
        conversationId: agent.info.conversationId,
        reason: 'its parked worker history was dropped',
        retiredAt: now
      });
    }
    logInfo(`multi-agent: dropped the parked worker history of conversation ${dormant.primeConversationId}`);
  }
  retiredPersist?.();
  return true;
}

function pruneRetiredWorkers(): void {
  const cutoff = Date.now() - RETIRED_WORKER_TTL_MS;
  let changed = false;
  for (const [conversationId, worker] of retiredWorkers) {
    if (worker.retiredAt >= cutoff) continue;
    retiredWorkers.delete(conversationId);
    changed = true;
  }
  if (changed) retiredPersist?.();
}

export function retiredWorkerForConversation(conversationId: string | null | undefined): RetiredChat | null {
  pruneRetiredWorkers();
  if (!conversationId) return null;
  const worker = retiredWorkers.get(conversationId);
  return worker ? { ...worker } : null;
}

export function hasRetiredWorkerLeases(): boolean {
  pruneRetiredWorkers();
  return retiredWorkers.size > 0;
}

export function forgetRetiredWorker(conversationId: string): void {
  if (retiredWorkers.delete(conversationId)) retiredPersist?.();
}

// -------------------------------------------------------------------- spawn

export interface SpawnInput {
  workers: ReadonlyArray<{ label?: string; task: string; model?: string | null }>;
  /**
   * What every worker in this spawn needs to know, written once.
   *
   * A worker starts with none of the prime's conversation, so the repository, the house
   * rules, the branch, the things it must not touch and how to validate had to be repeated
   * inside every single task. That is the prime paying output tokens to say the same
   * paragraph four times, and it is the paragraph most likely to drift between copies.
   * Written here, this app puts it in front of each worker's own task instead.
   */
  context?: string | null;
  caller: Caller;
}

export interface SpawnResult {
  created: AgentInfo[];
  /** True on the call that established the run, so the caller can say what happened. */
  becamePrime: boolean;
  runId: string;
}

/**
 * A spawn planned in memory but not yet accepted publicly.
 *
 * The immediate persistence lane can see this topology; ordinary/debounced snapshots and
 * browser bootstrap readers cannot until commit. Rollback removes the plan and emits a newer
 * safe snapshot, exactly like staged agent messages.
 */
export interface StagedSpawn extends SpawnResult {
  commit: () => void;
  rollback: () => void;
}

interface SpawnOptions {
  /** Keep browser side effects behind an explicit durable acceptance barrier. */
  deferDelivery?: boolean;
  /** Internal half of stageSpawn(): hide new topology from ordinary publication until commit. */
  stageTopology?: boolean;
}

function settleSpawnStage(stage: SpawnStageState, accepted: boolean): void {
  if (stage.settled) return;
  stage.settled = true;
  if (activeSpawnStage === stage) activeSpawnStage = null;
  for (const agent of stage.created) unpublishedAgents.delete(agent);
  if (unpublishedRun === stage.run) unpublishedRun = null;

  if (accepted) {
    // The exact topology already crossed the immediate durable barrier. Publishing it changes
    // only live readers and the ordinary/debounced mirror, not the critical durability revision.
    if (run === stage.run) changed('telemetry');
    return;
  }

  if (run === stage.run) {
    for (const agent of stage.created) {
      if (run.agents.get(agent.info.id) === agent) run.agents.delete(agent.info.id);
    }
    // A rejected first spawn had no accepted owner state at all; a rejected spawn into dormant
    // history must instead put that exact history back where it came from. Treating both as
    // `run = null` loses every old worker of the resumed prime.
    if (stage.createdFreshRun) {
      run = null;
    } else if (stage.resumedDormant) {
      const current = run;
      releasePrimeWorkspace(current.primeConversationId);
      dormantRuns.set(stage.resumedDormant.primeConversationId, {
        ...stage.resumedDormant,
        agents: current.agents,
        transfer: current.transfer
      });
      run = null;
    }
    // A failed write generation can remain queued for retry in durable.ts. This newer public
    // snapshot supersedes it so a rejected spawn cannot resurrect after restart.
    changed();
  }
}

/**
 * Normalizes a worker's requested ChatGPT model slug: trimmed, or null for the account
 * default when omitted or blank.
 *
 * Malformed input fails the whole spawn rather than opening a worker under a model nobody
 * asked for: like every other spawn validation, this runs before the first mutation, so a
 * rejection leaves zero workers behind. A well-formed slug ChatGPT does not recognise is
 * not ours to refuse — the fresh chat simply opens with the default.
 */
function normalizeModel(index: number, value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const model = value.trim();
  if (!model) return null;
  if (!isModelSlug(model)) {
    throw new AgentError(
      `Worker ${index + 1}'s model is not a ChatGPT model slug (letters, digits, dot, underscore, hyphen; limit ${MAX_MODEL_CHARS} characters)`
    );
  }
  return model;
}

/**
 * Whether a string is shaped like a ChatGPT model slug. The single vocabulary check for
 * worker models, shared by the broker and the bridge's durable restore: slugs are OpenAI's
 * vocabulary, so anything shaped like one passes through and an unknown one simply opens
 * with the account default.
 */
export function isModelSlug(value: unknown): value is string {
  return typeof value === 'string' && MODEL_SLUG_RE.test(value);
}

/**
 * Plans a worker spawn behind the same durable acceptance boundary used by agents::message.
 *
 * Production must call persistCriticalSwarmNow(), then commit() on success or rollback() on
 * any failure, and only after commit ask the browser to open the returned worker ids.
 */
export function stageSpawn(input: SpawnInput): StagedSpawn {
  const result = spawn(input, { deferDelivery: true, stageTopology: true });
  const stage = activeSpawnStage;
  // An exact retry can match workers that were already accepted earlier. That is not a new
  // mutation and therefore needs no publication transaction.
  if (!stage) return { ...result, commit: () => undefined, rollback: () => undefined };
  return {
    ...result,
    commit: () => settleSpawnStage(stage, true),
    rollback: () => settleSpawnStage(stage, false)
  };
}

/**
 * Publishes browser bootstraps only for worker ids that are still genuinely invited.
 *
 * Production MCP spawn uses this as the second half of its transaction: broker state is
 * planned first, that exact revision is made durable, and only then are browser tabs requested.
 * A retry after a failed disk barrier is safe because already-running workers are ignored.
 */
export function requestWorkerBootstraps(ids: readonly string[]): number {
  if (!run || ids.length === 0) return 0;
  const wanted = new Set(ids);
  const owed = [...run.agents.values()]
    .filter(
      (agent) =>
        agent.info.role === 'worker' &&
        agent.info.state === 'invited' &&
        !unpublishedAgents.has(agent) &&
        wanted.has(agent.info.id)
    )
    .map((agent) => ({ id: agent.info.id, task: agent.info.task, model: agent.info.model }));
  if (owed.length === 0) return 0;
  if (spawnRequest) spawnRequest(owed);
  else logWarn('multi-agent: no browser extension is paired, so worker chats cannot be opened automatically');
  return owed.length;
}

/**
 * Claims the calling conversation as prime and creates its workers, atomically.
 *
 * Every step that can fail happens before the first mutation, in a fixed order:
 *
 *   1. the request itself is valid (all of it, not the prefix that happened to parse);
 *   2. this app has *proven* which conversation is calling;
 *   3. that conversation is not a worker of the active run;
 *   4. no other conversation holds the one swarm;
 *   5. only then is the prime bound and the workers created.
 *
 * So a spawn that fails for any reason leaves zero workers behind, and no conversation ever
 * becomes prime as a by-product of some other outcome.
 */
export function spawn(input: SpawnInput, options: SpawnOptions = {}): SpawnResult {
  requireEnabled();
  if (activeSpawnStage) {
    throw new AgentError(
      'SPAWN_IN_PROGRESS: another worker spawn is still crossing its durable acceptance barrier. Retry this spawn after that call finishes.'
    );
  }
  const max = getConfig().multiAgent.maxWorkers;
  if (input.workers.length === 0) throw new AgentError('At least one worker is required');

  const context = input.context?.trim() ?? '';
  if (context.length > MAX_CONTEXT_CHARS) {
    throw new AgentError(`The shared context is too long (limit ${MAX_CONTEXT_CHARS} characters)`);
  }

  const planned = input.workers.map((worker, index) => {
    const task = worker.task.trim();
    if (!task) throw new AgentError(`Worker ${index + 1} has no task. Every worker needs one.`);
    if (task.length > MAX_TASK_CHARS) throw new AgentError(`Worker ${index + 1}'s task is too long`);
    const label = worker.label?.trim() ?? '';
    if (label.length > MAX_LABEL_CHARS) {
      throw new AgentError(`Worker ${index + 1}'s label is too long (limit ${MAX_LABEL_CHARS} characters)`);
    }
    const model = normalizeModel(index, worker.model);
    // Composed once, here, and stored as *the* task. Everything downstream — the bootstrap
    // the browser types, the repeated-spawn match, the status table, the snapshot — then
    // sees the same single string a worker actually receives, with no second field to keep
    // in step and no way for the two halves to be delivered apart.
    return { label, task: briefFor(context, task), model };
  });

  const conversationId = input.caller.conversationId ?? null;
  if (!conversationId) {
    throw new AgentError(
      'UNIDENTIFIED_CALLER: this app could not prove which ChatGPT conversation this call came from, so it will not ' +
        'make this chat the prime agent of a run. No workers were created. The paired browser extension has to be ' +
        'connected and this conversation has to be showing its connector activity; wait a moment and call ' +
        'agents action=spawn again.'
    );
  }

  if (run) {
    const caller = resolve(input.caller);
    if (caller && caller.info.role === 'worker') {
      throw new AgentError(
        `${caller.info.id} is a worker in this run. Workers must not create workers of their own — send the prime ` +
          'agent a message instead and let it decide.'
      );
    }
    if (conversationId !== run.primeConversationId) throw new AgentsBusyError();
  }

  const becamePrime = run === null;
  let resumedDormant: DormantRun | null = null;
  let createdFreshRun = false;
  if (!run) {
    resumedDormant = dormantRunForPrime(conversationId);
    if (resumedDormant) {
      if (!reactivateDormantRun(resumedDormant)) {
        throw new AgentError(
          'PRIME_TRANSFER_IN_PROGRESS: this conversation is being compacted/resumed, so its worker history cannot start a new active incarnation until that handoff settles.'
        );
      }
    } else {
      run = {
        // This is an incarnation key, not a display id. Browser bootstrap commands persist
        // independently and quote it so a late `worker-1` from run A can never bind `worker-1`
        // in run B. Truncating a UUID to eight hex characters made that safety boundary only
        // 32 bits wide; keep the full UUID and shorten it only where a UI chooses to render it.
        runId: randomUUID(),
        primeConversationId: conversationId,
        startedAt: Date.now(),
        agents: new Map([[PRIME_ID, makePrime(conversationId)]]),
        transfer: null,
        primeGoneAt: null
      };
      createdFreshRun = true;
    }
  }
  const activeRun = run;
  if (!activeRun) throw new AgentError('The worker history could not acquire the active run slot.');

  // Slot accounting, not membership. Sleeping workers are part of the run and are not counted:
  // a run may own far more of them than it can ever have awake at once, and that is the point.
  const live = workingWorkers();
  // The same request arriving twice is one request. A tool result that never reached
  // ChatGPT leaves a model with no idea its workers exist, and the obvious thing for it to
  // do is ask again; creating a second identical set is how a user ends up with four
  // sub-agent chats they asked for twice. This fold applies only while those workers are still
  // slot-holding/in flight. Once a worker has stopped and become part of durable history,
  // `spawn` means exactly what it says: create a fresh worker. Reusing an old sleeper is an
  // explicit `message` operation, never an implicit side effect of another spawn.
  const repeat = matchExistingRequest(planned, live);
  if (repeat) {
    const runId = activeRun.runId;
    if (!options.deferDelivery) requestWorkerBootstraps(repeat.map((agent) => agent.info.id));
    logInfo(`multi-agent: repeated spawn matched ${repeat.length} existing worker(s) in run ${runId}`);
    return { created: repeat.map((agent) => ({ ...agent.info })), becamePrime, runId };
  }

  if (live.length + planned.length > max) {
    const total = live.length + planned.length;
    if (resumedDormant) parkRun('a new spawn was rejected before changing its dormant history');
    else if (createdFreshRun) run = null;
    throw new AgentError(`That would make ${total} live workers; the limit set in the app is ${max}.`);
  }

  const ids: string[] = [];
  // Historical rows are intentionally never reused or deleted merely because the worker is
  // asleep/terminal. The old fixed 64-id scan therefore became a lifetime cap on one prime,
  // even though maxWorkers is only a *concurrency* limit. The first free positive suffix is
  // bounded by history size + this request, so this loop remains finite without an artificial
  // lifetime ceiling.
  for (let n = 1; ids.length < planned.length; n++) {
    const id = `worker-${n}`;
    if (!activeRun.agents.has(id)) ids.push(id);
  }

  const created: AgentInfo[] = [];
  const createdAgents: Agent[] = [];
  for (const [index, worker] of planned.entries()) {
    const id = ids[index] as string;
    const agent = makeWorker(id, worker.label || id, worker.task, worker.model);
    activeRun.agents.set(id, agent);
    // A worker starts in the folder the prime was working in, so its first call can use the
    // same shorthand. It is a copy: a worker sent into another project overwrites its own
    // entry and never the prime's.
    inheritWorkspace(id, activeRun.primeConversationId);
    createdAgents.push(agent);
    created.push({ ...agent.info });
  }

  if (options.stageTopology) {
    const stage: SpawnStageState = {
      run: activeRun,
      created: createdAgents,
      becamePrime,
      resumedDormant,
      createdFreshRun,
      settled: false
    };
    activeSpawnStage = stage;
    for (const agent of createdAgents) unpublishedAgents.add(agent);
    if (becamePrime) unpublishedRun = activeRun;
  }

  logInfo(
    becamePrime
      ? `multi-agent: run ${activeRun.runId} started by conversation ${conversationId} with ${created.length} worker(s)`
      : `multi-agent: created ${created.length} worker(s) in run ${activeRun.runId}`
  );
  changed();
  if (!options.deferDelivery) requestWorkerBootstraps(created.map((agent) => agent.id));
  return { created, becamePrime, runId: activeRun.runId };
}

/**
 * Finds the workers a repeated spawn is really asking about.
 *
 * All or nothing, matched on the request as written. A request that asks for anything new is
 * a new request and creates everything it asks for, so a prime that genuinely wants a third
 * worker still gets one; only an exact repetition of work already under way is folded back.
 */
function matchExistingRequest(
  requested: ReadonlyArray<{ label: string; task: string; model: string | null }>,
  live: readonly Agent[]
): Agent[] | null {
  if (requested.length === 0 || live.length === 0) return null;
  // An unambiguous encoding of the (label, task, model) triple rather than a separator character.
  // Any separator is only as good as the assumption that it cannot occur in the operands, and
  // the first two are free text a model wrote; JSON removes the assumption entirely, so
  // ("a", "b c") and ("a b", "c") can never shape-collide into one match. It also keeps this
  // file plain text: the NUL that used to do this job was a literal byte, which made every
  // text tool treat the source as binary. The model rides along because a retry that asks for
  // a different model is new intent, not the same request arriving twice.
  const shape = (label: string, task: string, model: string | null): string =>
    JSON.stringify([label.trim(), task.trim(), model]);
  const taken = new Set<Agent>();
  const matched: Agent[] = [];
  for (const worker of requested) {
    // The stored label defaults to the worker id, so an unlabelled request has to match the
    // way spawn would have written it.
    const found = live.find(
      (agent) =>
        !taken.has(agent) &&
        (shape(agent.info.label, agent.info.task, agent.info.model) ===
          shape(worker.label || agent.info.id, worker.task, worker.model) ||
          shape(agent.info.label, agent.info.task, agent.info.model) ===
            shape(worker.label, worker.task, worker.model))
    );
    if (!found) return null;
    taken.add(found);
    matched.push(found);
  }
  return matched;
}

// ----------------------------------------------------------------- recovery

/**
 * The over-and-done slot a caller belongs to, if it belongs to one.
 *
 * Terminal agents are invisible to ordinary resolution on purpose — nothing in a run should
 * route to them — but a retried `finish` still has to be answered honestly. This is the one
 * lookup that can see them.
 */
function retiredAgent(caller: Caller): Agent | null {
  if (!run || !caller.conversationId) return null;
  for (const agent of run.agents.values()) {
    if (agent.info.conversationId === caller.conversationId && isOver(agent.info.state)) return agent;
  }
  return null;
}

// ------------------------------------------------------------------ routing

/**
 * Star topology, enforced.
 *
 * Two workers talking directly is the thing this mode must not allow: it is how a swarm
 * silently negotiates a plan the user never sees and the prime cannot report.
 */
function assertRoute(from: Agent, to: Agent): void {
  if (from.info.id === to.info.id) throw new AgentError('An agent cannot message itself');
  if (from.info.role === 'worker' && to.info.role !== 'prime') {
    throw new AgentError('Workers may only message the prime agent. Send it there and let the prime decide.');
  }
  if (from.info.role === 'prime' && to.info.role !== 'worker') {
    throw new AgentError('The prime agent can only message workers');
  }
}

/**
 * Adds a message to a recipient's queue, or refuses.
 *
 * Refusing is the point. Dropping the oldest waiting message to make room would throw away a
 * task or a result while still telling the sender it was sent.
 */
function assertRoom(to: Agent, incoming: number): void {
  const waiting = to.queue.filter((item) => item.ackedAt === null).length;
  if (waiting + incoming > MAX_QUEUE) {
    throw new AgentError(
      `QUEUE_FULL: ${to.info.id} already has ${waiting} unacknowledged messages, which is the limit. Nothing was sent ` +
        'and nothing was discarded. A queue this deep normally means that agent has stopped calling tools.'
    );
  }
}

function enqueue(to: Agent, message: AgentMessage): void {
  assertRoom(to, 1);
  to.queue.push(message);
  if (to.queue.length > MAX_QUEUE * 2) {
    const settled = to.queue.filter((item) => item.ackedAt !== null).slice(-MAX_QUEUE);
    to.queue = [...settled, ...to.queue.filter((item) => item.ackedAt === null)];
  }
  recount(to);
}

function newMessage(from: string, to: string, text: string): AgentMessage {
  return {
    id: randomUUID().slice(0, 8),
    from,
    to,
    time: Date.now(),
    text,
    offeredAt: null,
    offers: 0,
    offeredOnFinish: false,
    offeredViaRevival: false,
    ackedAt: null
  };
}

/**
 * Sends a message from the caller — whoever the broker says that is — to `toId`.
 *
 * There is deliberately no "from" parameter. The sender is derived from the caller's
 * binding, so the star topology cannot be sidestepped by writing someone else's id.
 */
export function sendMessage(caller: Caller, toId: string, text: string): AgentMessage {
  return sendMessages(caller, [{ to: toId, text }])[0] as AgentMessage;
}

export interface StagedAgentMessages {
  /** Stable copies for the caller to record/report after commit. */
  messages: AgentMessage[];
  /**
   * Sleeping workers this batch reserved a slot for.
   *
   * Their chats are reopened only after commit, for the same reason worker tabs are: a browser
   * side effect must never happen for a broker revision that disk went on to reject.
   */
  waking: string[];
  /** Makes the already-durable queue entries visible to the recipient. Pure in-memory publish. */
  commit: () => void;
  /** Removes an unaccepted batch and supersedes any failed durable snapshot with the safe state. */
  rollback: () => void;
}

/**
 * Sends several messages from the caller in one operation, all or nothing.
 *
 * One `agents` call is one proof of who is calling. Sending three corrections used to be
 * three MCP round trips and three separate identity resolutions — each of which can be
 * refused on its own, so a prime redirecting its whole run could get two of its three
 * messages delivered and no way to tell which.
 *
 * Everything that can be checked is checked across the whole batch before anything is
 * queued, including how much room each recipient has left, so a batch either lands complete
 * or changes nothing. Two messages to the same worker keep their written order.
 */
export function stageMessages(
  caller: Caller,
  items: ReadonlyArray<{ to: string; text: string }>
): StagedAgentMessages {
  if (items.length === 0) throw new AgentError('No messages were given');
  if (items.length > MAX_BATCH_MESSAGES) {
    throw new AgentError(`Too many messages in one call (limit ${MAX_BATCH_MESSAGES})`);
  }
  let resumedDormant = false;
  if (!run && caller.conversationId) {
    const dormant = dormantRunForPrime(caller.conversationId);
    if (dormant) {
      if (!reactivateDormantRun(dormant)) {
        throw new AgentError(
          'PRIME_TRANSFER_IN_PROGRESS: this conversation is being compacted/resumed, so its sleeping workers cannot be woken until that handoff settles.'
        );
      }
      resumedDormant = true;
    }
  }
  try {
    return stageMessagesActive(caller, items, resumedDormant);
  } catch (error) {
    if (resumedDormant) parkRun('a dormant-owner message was rejected before any worker was woken');
    throw error;
  }
}

function stageMessagesActive(
  caller: Caller,
  items: ReadonlyArray<{ to: string; text: string }>,
  resumedDormant: boolean
): StagedAgentMessages {
  const from = requireMember(caller);
  if (activeFinishStages.has(from)) {
    throw new AgentError(
      `FINISH_IN_PROGRESS: ${from.info.id} is still crossing its durable finish barrier and cannot send another message yet.`
    );
  }
  // A finished worker keeps its conversation so a lost finish result can be recognised as a
  // retry. Without this guard that same binding let it go on queueing work for the prime
  // after it had reported and stopped.
  if (isOver(from.info.state)) {
    throw new AgentError(
      `${from.info.id} has ${from.info.state === 'failed' ? 'failed' : 'finished'} and cannot send messages.`
    );
  }

  const planned: Array<{ to: Agent; message: AgentMessage }> = [];
  const perRecipient = new Map<string, number>();
  /** Sleeping recipients this batch is about to wake, and therefore about to take a slot for. */
  const reserved = new Set<Agent>();
  for (const [index, item] of items.entries()) {
    const where = items.length > 1 ? ` (message ${index + 1} of ${items.length})` : '';
    const trimmed = item.text?.trim() ?? '';
    if (!trimmed) throw new AgentError(`The message is empty${where}`);
    if (trimmed.length > MAX_MESSAGE_CHARS) {
      throw new AgentError(`Message is too long (limit ${MAX_MESSAGE_CHARS} characters)${where}`);
    }
    const toId = item.to?.trim() ?? '';
    const to = toId ? run?.agents.get(toId) : undefined;
    if (!to) {
      throw new AgentError(`Unknown agent "${toId}"${where}. Call agents action=status to see who exists.`);
    }
    if (unpublishedAgents.has(to)) {
      throw new AgentError(
        `SPAWN_IN_PROGRESS: ${toId} has not crossed its durable spawn acceptance barrier yet${where}. Retry after the spawn call finishes.`
      );
    }
    if (activeFinishStages.has(to)) {
      throw new AgentError(
        `FINISH_IN_PROGRESS: ${toId} is still crossing its durable finish barrier${where}. Retry after that finish call settles.`
      );
    }
    assertRoute(from, to);
    if (isOver(to.info.state)) {
      throw new AgentError(
        to.info.state === 'failed'
          ? `${toId} has failed and is no longer listening${where}`
          : `${toId} is finished for good — its own chat reached the context limit, so it cannot be woken` +
            `${where}. Spawn a new worker for this work.`
      );
    }
    // A revival already crossing the browser is its own in-flight transaction, exactly like a
    // spawn or a finish, and for the same reason: this call's `waking` list is what causes the
    // browser to be asked for anything at all. A second message would see the worker already
    // reserved, report nothing to wake, and be durably queued behind a revival that may yet
    // roll back to `sleeping` — leaving the prime's words in a chat nothing is going to open.
    if (to.info.state === 'waking') {
      throw new AgentError(
        `REVIVE_IN_PROGRESS: ${toId} is being woken right now${where}. Nothing was sent; send this again once it is ` +
          'awake, or once you are told the revival failed.'
      );
    }
    if (to.info.state === 'sleeping') {
      if (!to.info.conversationId) {
        throw new AgentError(
          `${toId} is asleep but this app never learned which chat it is in, so it cannot be woken${where}.`
        );
      }
      // Waking is the one send that needs capacity, because the recipient is not running. The
      // slot is reserved here, synchronously, so two messages to two sleeping workers cannot
      // both be told the same last slot is theirs. Refused rather than queued: a message that
      // sits unread in a chat nobody is going to open is worse than being told to wait.
      if (!reserved.has(to) && freeWorkerSlots() - reserved.size <= 0) {
        throw new AgentError(
          `NO_FREE_SLOT: ${toId} is asleep and all ${getConfig().multiAgent.maxWorkers} worker slots are busy, so it ` +
            `cannot be woken right now${where}. Nothing was sent. Wait for a worker to report and try again.`
        );
      }
      reserved.add(to);
    }
    // Counted per recipient across the batch: three messages to one worker with two slots
    // left has to be refused here, not half-delivered and then refused by enqueue.
    const already = perRecipient.get(to.info.id) ?? 0;
    assertRoom(to, already + 1);
    perRecipient.set(to.info.id, already + 1);
    planned.push({ to, message: newMessage(from.info.id, to.info.id, trimmed) });
  }

  for (const { to, message } of planned) {
    unpublishedMessages.add(message);
    enqueue(to, message);
  }
  // Reservation is part of the same all-or-nothing plan as the queue entries: every check
  // above has passed by now, so no recipient can still turn out to be unreachable.
  for (const agent of reserved) beginRevival(agent);
  changed();
  const messages = planned.map(({ message }) => ({ ...message }));
  let settled = false;
  const recipients = [...new Set(planned.map(({ to }) => to))];
  return {
    messages,
    waking: [...reserved].map((agent) => agent.info.id),
    commit: () => {
      if (settled) return;
      settled = true;
      for (const { message } of planned) unpublishedMessages.delete(message);
      for (const recipient of recipients) recount(recipient);
      // No new durable fact: the exact queue entries were already in the snapshot that crossed
      // the acceptance barrier. This only publishes them to live inbox readers and the UI.
      changed('telemetry');
    },
    rollback: () => {
      if (settled) return;
      settled = true;
      for (const { to, message } of planned) {
        unpublishedMessages.delete(message);
        const index = to.queue.indexOf(message);
        if (index >= 0) to.queue.splice(index, 1);
      }
      // The slot goes back with the message it was reserved for. A rejected write must not
      // leave a worker `waking` with nothing on its way to wake it.
      for (const agent of reserved) {
        if (agent.info.state !== 'waking') continue;
        returnWakingWorkerToStopped(
          agent,
          Date.now(),
          'Its pending revival was rolled back before any new work was accepted.'
        );
      }
      for (const recipient of recipients) recount(recipient);
      // writeDurableNow deliberately retains a failed generation for retry. Queue a *newer*
      // safe snapshot immediately so that failed generation can never later persist a message
      // whose tool call reported failure.
      changed();
      if (resumedDormant) parkRun('a dormant-owner message rolled back before its worker was woken');
    }
  };
}

/** Immediate broker API used by internal/unit callers that do not expose a durable-acceptance result. */
export function sendMessages(
  caller: Caller,
  items: ReadonlyArray<{ to: string; text: string }>
): AgentMessage[] {
  const staged = stageMessages(caller, items);
  staged.commit();
  return staged.messages;
}

/**
 * Messages to put in this agent's next tool result, including anything already offered but
 * not yet acknowledged.
 *
 * That is the deliberate at-least-once trade: if the previous result never reached ChatGPT —
 * the connector dropping mid-turn is a failure this project has reproduced — the message
 * comes round again instead of vanishing. `offers > 1` lets the caller label a repeat.
 *
 * `onFinish` records that this offer rode on a `finish` result, the one result whose loss is
 * answered by an identical retry and whose acknowledgement therefore proves nothing.
 */
export function offerMessages(id: string, onFinish = false): AgentMessage[] {
  const agent = run?.agents.get(id);
  if (!agent) return [];
  return offerAgentMessages(agent, onFinish);
}

function offerAgentMessages(agent: Agent, onFinish = false): AgentMessage[] {
  // Once the browser owns a wake, its queued text has exactly one delivery path: the real user
  // message the content script is about to submit. Letting an MCP result carry the same inbox
  // while `waking` would duplicate that instruction before the browser ACK. And after the ACK,
  // `offeredViaRevival` is stronger evidence than an ordinary result offer: that text was
  // already accepted by ChatGPT and must never be injected into a tool result again.
  const browserOwnsWake = agent.info.role === 'worker' && agent.info.state === 'waking' && !agent.info.revivable;
  if (browserOwnsWake) return [];
  const waiting: AgentMessage[] = [];
  let offeredChars = 0;
  for (const message of agent.queue) {
    if (message.ackedAt !== null || message.offeredViaRevival || unpublishedMessages.has(message)) continue;
    if (waiting.length > 0 && offeredChars + message.text.length > MAX_INBOX_OFFER_CHARS) break;
    waiting.push(message);
    offeredChars += message.text.length;
  }
  if (waiting.length === 0) return [];
  const now = Date.now();
  for (const message of waiting) {
    message.offeredAt = now;
    message.offers += 1;
    message.offeredOnFinish = onFinish;
  }
  recount(agent);
  changed('telemetry');
  return waiting.map((message) => ({ ...message }));
}

/** Caller-scoped inbox offer that remains safe when another owner has an active worker-1. */
export function offerMessagesForConversation(
  conversationId: string | null | undefined,
  onFinish = false,
  allowDormantWorkerFinishRetry = false
): { agentId: string; messages: AgentMessage[] } | null {
  if (!conversationId) return null;
  const active = boundAgent(conversationId);
  if (active) return { agentId: active.info.id, messages: offerAgentMessages(active, onFinish) };
  const dormant = dormantAgentForConversation(conversationId);
  if (!dormant) return null;
  // A dormant worker is stopped and must never receive ordinary broker work through an MCP
  // result. The sole exception is an exact retry of its own finish call after the first finish
  // result was lost: rows offered on that finish result must be re-offered rather than silently
  // abandoned merely because the same finish also parked the run.
  if (dormant.agent.info.role === 'worker') {
    if (!allowDormantWorkerFinishRetry || !onFinish || !hasStopped(dormant.agent.info.state)) return null;
    return { agentId: dormant.agent.info.id, messages: offerAgentMessages(dormant.agent, true) };
  }
  return { agentId: PRIME_ID, messages: offerAgentMessages(dormant.agent, onFinish) };
}

/**
 * Retires everything previously offered to this agent, except what this call cannot honestly
 * be said to have proven.
 *
 * Called at the start of that agent's next authenticated call, because that call is the best
 * evidence available that the previous tool result made it back into the conversation.
 * Evidence, not proof — so a message offered on a `finish` result is not retired by another
 * `finish`, which would otherwise let a worker's own retry count an unread message as
 * delivered and then terminalise it.
 */
export function acknowledgeOffers(id: string, byFinish = false, callStartedAt = Number.POSITIVE_INFINITY): AgentMessage[] {
  const agent = run?.agents.get(id);
  if (!agent) return [];
  return acknowledgeAgentOffers(agent, byFinish, callStartedAt);
}

function acknowledgeAgentOffers(
  agent: Agent,
  byFinish = false,
  callStartedAt = Number.POSITIVE_INFINITY
): AgentMessage[] {
  const offered = agent.queue.filter(
    (message) =>
      message.ackedAt === null &&
      message.offeredAt !== null &&
      // A call proves only what was already delivered before that call began. This matters for
      // revival ACKs because the browser can submit the user message while an older MCP handler
      // is still running. Letting that older call retire the newly offered row would make a
      // post-crash retry indistinguishable from successful acknowledgement. Strictly earlier,
      // rather than <=, also closes the same-millisecond ordering ambiguity.
      message.offeredAt < callStartedAt &&
      !(byFinish && message.offeredOnFinish)
  );
  if (offered.length === 0) return [];
  const now = Date.now();
  for (const message of offered) message.ackedAt = now;
  agent.info.delivered += offered.length;
  recount(agent);
  changed('telemetry');
  return offered.map((message) => ({ ...message }));
}

/** Caller-scoped acknowledgement counterpart to {@link offerMessagesForConversation}. */
export function acknowledgeOffersForConversation(
  conversationId: string | null | undefined,
  byFinish = false,
  callStartedAt = Number.POSITIVE_INFINITY,
  allowDormantWorkerFinishRetry = false
): { agentId: string; messages: AgentMessage[] } | null {
  if (!conversationId) return null;
  const active = boundAgent(conversationId);
  if (active) {
    return { agentId: active.info.id, messages: acknowledgeAgentOffers(active, byFinish, callStartedAt) };
  }
  const dormant = dormantAgentForConversation(conversationId);
  if (!dormant) return null;
  if (dormant.agent.info.role === 'worker') {
    if (!allowDormantWorkerFinishRetry || !byFinish || !hasStopped(dormant.agent.info.state)) return null;
    return {
      agentId: dormant.agent.info.id,
      messages: acknowledgeAgentOffers(dormant.agent, true, callStartedAt)
    };
  }
  return { agentId: PRIME_ID, messages: acknowledgeAgentOffers(dormant.agent, byFinish, callStartedAt) };
}

export function pendingCount(id: string): number {
  return run?.agents.get(id)?.info.pending ?? 0;
}

/**
 * Releases the single global execution claim once no worker consumes a slot.
 *
 * Ownership and execution are intentionally different lifetimes. Prime reports, sleeping
 * workers, terminal rows and their exact conversation bindings all remain in the caller's
 * dormant history. What disappears is only the active incarnation, so another ChatGPT
 * conversation may start its own workers immediately.
 *
 * The legacy options remain in the signature for bridge callers compiled against the previous
 * terminal-only release policy; pending reports are never discarded now.
 */
export function releaseQuiescentRun(options: { allowPendingReports?: boolean; reason?: string } = {}): boolean {
  if (!run) return false;
  if (activeSpawnStage?.run === run) return false;
  // `pending` intentionally hides messages that are still behind an immediate durability
  // barrier. That visibility rule must not make them look nonexistent to lifecycle teardown:
  // a parallel worker finish + prime ACK can otherwise make pending=0 and destroy the run while
  // another agents::message call is still staged. Its later commit would then report success
  // into an Agent object no longer reachable from the broker. A staged queue entry is therefore
  // outstanding work even though it is not yet an offerable inbox item.
  if ([...run.agents.values()].some((agent) => agent.queue.some((message) => unpublishedMessages.has(message)))) {
    return false;
  }
  if (workingWorkers().length > 0) return false;
  return parkRun(options.reason ?? 'no worker is currently running');
}

// ------------------------------------------------------------------- finish

export interface FinishResult {
  info: AgentInfo;
  /** The report produced for the prime, so the caller can record it durably after acceptance. */
  report: AgentMessage | null;
  /** This call found the agent already terminal and changed nothing. */
  repeat: boolean;
}

/** A finish planned for the critical persistence lane but not yet published to live readers. */
export interface StagedFinish extends FinishResult {
  commit: () => void;
  rollback: () => void;
}

function finishTarget(caller: Caller): Agent {
  requireEnabled();
  if (!caller.conversationId) throw new IdentityLostError();
  // The one call that also answers from a conversation whose slot has already ended: this
  // connector loses tool results, so a retry of *this* call is exactly what that looks like,
  // and telling the chat that had genuinely finished that it was a stranger was worse than
  // useless.
  const agent = resolve(caller) ?? retiredAgent(caller);
  if (agent) {
    if (agent.info.role !== 'worker') {
      throw new AgentError(
        'The prime agent does not finish: the run ends when its workers have reported and the user is done with it.'
      );
    }
    return agent;
  }

  const dormant = dormantAgentForConversation(caller.conversationId)?.agent ?? null;
  // A dormant worker may only be here as a retry of a finish that already stopped it. Never
  // treat an unexpected dormant worker call as authority to resume or mutate its history.
  if (dormant?.info.role === 'worker' && hasStopped(dormant.info.state)) return dormant;
  if (run) throw new AgentsBusyError();
  if (!dormant) throw new AgentError('No sub-agent run or worker history belongs to this conversation.');
  if (dormant.info.role !== 'worker') {
    throw new AgentError(
      'The prime agent does not finish: the run ends when its workers have reported and the user is done with it.'
    );
  }
  throw new AgentError(`${dormant.info.id} is dormant but has not finished, so finish cannot be retried from this state.`);
}

function planFinish(agent: Agent, result: string): { info: AgentInfo; report: AgentMessage } {
  // What the prime told this worker and cannot be shown to have reached it. Taken before
  // terminalisation and said out loud, because this app cannot prove a tool result arrived —
  // the guarantee it can keep is "either the worker got it or you are told it may not have".
  // This finish call is itself the acknowledgement for anything that was offered on the
  // worker's preceding *ordinary* tool result. Kernel retires those rows immediately after the
  // handler returns; counting them here produces a final report that says "never confirmed"
  // about the very messages this call confirms. A row never offered is still uncertain, and a
  // row offered on an earlier finish result is deliberately still uncertain because this may be
  // the retry of that lost finish result (see acknowledgeOffers(byFinish=true)).
  const unconfirmed = agent.queue
    .filter(
      (message) =>
        message.ackedAt === null && (message.offeredAt === null || message.offeredOnFinish)
    )
    .map((message) => message.id);
  // A finish is evidence that this piece of work is over, and nothing more than that. The
  // worker's chat is still there, still holds everything it learned, and is still the cheapest
  // place to put the next piece of work — so it sleeps rather than ends, unless its own context
  // has grown past the point where reopening it would achieve anything.
  const terminal = ceilingCrossed(agent.info);
  const now = Date.now();
  const info: AgentInfo = {
    ...agent.info,
    state: terminal ? 'finished' : 'sleeping',
    finishedAt: terminal ? now : null,
    sleptAt: now,
    detachedAt: null,
    result: result.slice(0, MAX_MESSAGE_CHARS),
    revivable: !terminal
  };
  const caveat =
    unconfirmed.length > 0
      ? `\n(${agent.info.id} ended without ever confirming ${unconfirmed.length} message(s) you sent it — ` +
        `${unconfirmed.slice(0, 5).join(', ')}${unconfirmed.length > 5 ? ', …' : ''}. ` +
        'Assume it may not have read them and check the result against what you asked for.)'
      : '';
  // A worker that stops is a freed slot, and the prime is the only party that can use it —
  // but nothing in the final report ever said so. The recorded runs show the consequence: a
  // prime that has just been told a worker ended sits on remaining work rather than putting
  // that capacity back to use, because "finished" reads as an ending rather than as capacity
  // coming back. Counting is done against the workers that outlive this one, since `agent`
  // still holds its slot at plan time.
  const max = getConfig().multiAgent.maxWorkers;
  const stillWorking = run
    ? [...run.agents.values()].filter(
        (other) =>
          other.info.role === 'worker' &&
          other.info.id !== agent.info.id &&
          occupiesSlot(other.info.state)
      ).length
    : 0;
  const free = Math.max(0, max - stillWorking);
  const slots =
    free > 0
      ? `${free} of ${max} worker slot${max === 1 ? '' : 's'} ${free === 1 ? 'is' : 'are'} free. `
      : '';
  // The one line in this whole file the prime reliably acts on, so it says the thing that
  // changed: this worker is reusable. Spawning a replacement for work its own chat already
  // understands is both the expensive answer and the one that fills ChatGPT with abandoned
  // conversations, which is the behaviour reusable workers exist to stop.
  const capacity = terminal
    ? `
(${agent.info.id} is finished for good: its own chat has reached the context limit, so it cannot be woken again. ` +
      `${slots}Spawn a new worker for any remaining work.)`
    : `
(${agent.info.id} is sleeping, not gone. ${slots}It keeps this chat and everything it has already worked out. For ` +
      `related follow-up work, reuse it first with agents action=message to="${agent.info.id}" — that wakes it up where ` +
      'it left off. Use action=spawn only when no sleeping worker is suitable or true parallel capacity is needed.)';
  const report = newMessage(
    agent.info.id,
    PRIME_ID,
    `[${agent.info.id} ${terminal ? 'finished' : 'reported'}] ${info.result}${caveat}${capacity}`
  );
  return { info, report };
}

/**
 * Upgrades a finish that is still behind its immediate durability barrier when session
 * accounting proves the worker crossed the 400k ceiling in the meantime.
 *
 * The live Agent intentionally stays active until commit, so the staged overlay is the state
 * that is about to become authoritative. Leaving that overlay at sleeping/revivable=true while
 * writing contextTokens>=400k creates a crash snapshot that revives a worker which should be
 * terminal. Keep the staged report identity stable and update only its projected authority and
 * wording.
 */
function upgradeStagedFinishAtCeiling(agent: Agent): boolean {
  const stage = activeFinishStages.get(agent);
  if (
    !stage ||
    stage.settled ||
    !runProjectionStillOwned(stage.run) ||
    stage.info.state === 'finished' ||
    !ceilingCrossed(agent.info)
  ) {
    return false;
  }
  const terminal = planFinish(agent, stage.info.result ?? '');
  stage.info.state = 'finished';
  stage.info.finishedAt = stage.info.sleptAt ?? terminal.info.finishedAt ?? Date.now();
  stage.info.revivable = false;
  stage.info.contextTokens = agent.info.contextTokens;
  stage.report.text = terminal.report.text;
  return true;
}

function publishFinish(agent: Agent, info: AgentInfo, report: AgentMessage, durability: SwarmMutationDurability): void {
  // Only the authority fields are committed from the plan. Liveness/detach telemetry may
  // legitimately have advanced while an immediate disk write was awaiting I/O and must not be
  // rewound to the copy captured before that await.
  agent.info.state = info.state;
  agent.info.finishedAt = info.finishedAt;
  agent.info.sleptAt = info.sleptAt;
  agent.info.detachedAt = null;
  agent.info.result = info.result;
  agent.info.revivable = info.revivable;
  // The conversation is kept either way, and for two reasons now: a retried finish from that
  // same chat is recognised as the retry it is, and — while the worker is only sleeping — that
  // id is the whole of what a later revival needs to reopen the chat and type into it.
  const prime = primeForOwnedAgent(agent);
  if (!prime) throw new AgentError(`Cannot find the prime that owns ${agent.info.id}.`);
  // Over the queue limit on purpose: the worker is about to stop calling tools and has no way
  // to retry its own report.
  prime.queue.push(report);
  recount(prime);
  logInfo(`multi-agent: ${agent.info.id} ${info.state === 'finished' ? 'finished for good' : 'is sleeping'}`);
  changed(durability);
}

/** Whether this exact run object still owns its agent map, active or parked. */
function runProjectionStillOwned(owner: Run): boolean {
  if (run === owner) return true;
  return [...dormantRuns.values()].some((history) => history.agents === owner.agents);
}

function stageFinish(agent: Agent, result: string, acknowledgedMessageIds: readonly string[] = []): StagedFinish {
  if (!canStop(agent.info.state)) {
    logInfo(`multi-agent: ${agent.info.id} called finish again after it had already stopped (${agent.info.state})`);
    return {
      info: { ...agent.info },
      report: null,
      repeat: true,
      commit: () => undefined,
      rollback: () => undefined
    };
  }
  if (activeFinishStages.has(agent)) {
    throw new AgentError(
      `FINISH_IN_PROGRESS: ${agent.info.id} is already crossing its durable finish barrier. Retry the same finish after that call settles.`
    );
  }
  if (!run) throw new AgentError('No sub-agent run is active.');
  const planned = planFinish(agent, result);
  const stage: FinishStageState = {
    run,
    agent,
    ...planned,
    acknowledgedMessageIds: [...new Set(acknowledgedMessageIds)],
    settled: false
  };
  activeFinishStages.set(agent, stage);
  // This critical revision is represented only as an overlay in the immediate snapshot. Live
  // status/inbox readers and the ordinary debounce still see the active worker until commit.
  changed();

  const settle = (accepted: boolean): void => {
    if (stage.settled) return;
    stage.settled = true;
    if (activeFinishStages.get(agent) === stage) activeFinishStages.delete(agent);
    if (!runProjectionStillOwned(stage.run) || stage.run.agents.get(agent.info.id) !== agent) return;
    if (accepted) {
      // The exact projected terminal row + report already crossed the immediate durable barrier.
      // Publishing those same facts changes only live readers and the debounced mirror.
      if (stage.acknowledgedMessageIds.length > 0) {
        const acked = new Set(stage.acknowledgedMessageIds);
        const now = Date.now();
        let delivered = 0;
        for (const message of agent.queue) {
          if (message.ackedAt !== null || !acked.has(message.id)) continue;
          message.ackedAt = now;
          delivered += 1;
        }
        agent.info.delivered += delivered;
        recount(agent);
      }
      // Feature-disable parking may already have put the live row into `sleeping`. The staged
      // finish is still the accepted authority projection and carries the worker's real result
      // plus its prime report, so publish it into the same parked owner map rather than dropping
      // it merely because the active incarnation was released while the fsync was in flight.
      publishFinish(agent, stage.info, stage.report, 'telemetry');
      return;
    }
    // A failed write generation can remain queued for durable.ts retry. Emit a newer safe
    // pre-finish snapshot after removing the overlay so the rejected finish cannot resurrect.
    changed();
  };
  return {
    // These are the staged authority objects themselves. A session measurement may cross the
    // context ceiling while the fsync is in flight; upgradeStagedFinishAtCeiling() then updates
    // these same objects so both the durable snapshot and the eventual tool/bridge result say
    // what actually committed.
    info: stage.info,
    report: stage.report,
    repeat: false,
    commit: () => settle(true),
    rollback: () => settle(false)
  };
}

/** Plans an explicit worker finish behind its durable acceptance barrier. */
export function stageFinishAgent(caller: Caller, result: string): StagedFinish {
  return stageFinish(finishTarget(caller), result);
}

/**
 * Finishes the calling worker. An agent can only ever finish itself.
 *
 * Finishing twice is one finish. This connector loses tool results, so a worker whose result
 * never came back simply calls again, usually with slightly different wording. Taking the
 * second call literally rewrote `finishedAt` and queued a *second* final report, so the
 * prime was told the same thing twice with no way to tell that from two genuine reports.
 */
export function finishAgent(caller: Caller, result: string): FinishResult {
  const agent = finishTarget(caller);
  if (!canStop(agent.info.state)) {
    logInfo(`multi-agent: ${agent.info.id} called finish again after it had already stopped (${agent.info.state})`);
    return { info: { ...agent.info }, report: null, repeat: true };
  }
  const planned = planFinish(agent, result);
  publishFinish(agent, planned.info, planned.report, 'critical');
  return { info: { ...agent.info }, report: { ...planned.report }, repeat: false };
}

/**
 * App-owned terminal cleanup for a worker whose ChatGPT turn produced a settled answer.
 *
 * Broker messages ride on later tool results, so a worker that simply answers and then goes
 * idle has no future execution point at which an explicit `agents finish` can be required.
 * Leaving that worker `active` permanently consumed a slot and made the UI promise a worker
 * was still working when its chat had plainly finished. Treat workers as one-shot jobs: the
 * browser's settled assistant answer releases the slot, while an explicit finish remains the
 * same idempotent path when the model does call it first.
 */
export function finishWorkerConversation(conversationId: string, result: string): FinishResult | null {
  if (!run || !conversationId) return null;
  const agent = agentForConversationId(conversationId);
  if (!agent || agent.info.role !== 'worker' || !canStop(agent.info.state)) return null;
  return finishAgent({ conversationId }, result);
}

/** Browser-owned counterpart to stageFinishAgent(), resolved from the worker's bound chat. */
export function stageWorkerConversationFinish(conversationId: string, result: string): StagedFinish | null {
  if (!run || !conversationId) return null;
  const agent = agentForConversationId(conversationId);
  if (!agent || agent.info.role !== 'worker' || !canStop(agent.info.state)) return null;
  // A settled browser answer is evidence the worker got past the preceding ordinary tool
  // result. Those are exactly the rows the next authenticated MCP call would retire. There is
  // no such next call when the worker simply answers and stops, so stage their retirement with
  // the browser-owned finish itself. Rows offered by a finish result remain excluded for the
  // same lost-result retry reason as acknowledgeOffers(byFinish=true).
  const acknowledged = agent.queue
    .filter((message) => message.ackedAt === null && message.offeredAt !== null && !message.offeredOnFinish)
    .map((message) => message.id);
  return stageFinish(agent, result, acknowledged);
}

/**
 * Ends a worker that never got off the ground, definitively.
 *
 * Called by whoever owns the bootstrap once it has run out of retries or time. Before this
 * existed, giving up only deleted the queued command: the worker stayed `invited`, still
 * counted towards the worker limit, still blocked the next bootstrap, and still promised the
 * prime a report that could never arrive.
 */
export function failAgent(
  id: string,
  reason: string,
  note?: string,
  options: { revivable?: boolean } = {}
): FinishResult | null {
  const agent = run?.agents.get(id);
  if (!run || !agent || agent.info.role !== 'worker' || isOver(agent.info.state)) return null;
  // A final answer/explicit finish is stronger evidence than a concurrent timeout/cleanup.
  // The callers that can legitimately race this path are themselves retryable after the
  // in-flight acceptance barrier settles, so never publish two incompatible terminal reports.
  if (activeFinishStages.has(agent)) return null;
  agent.info.state = 'failed';
  agent.info.finishedAt = Date.now();
  agent.info.detachedAt = null;
  agent.info.result = reason.slice(0, MAX_MESSAGE_CHARS);
  // Only a failure that says nothing about the turn itself may be undone by the turn proving
  // otherwise. A tab that never opened, a worker a person cleared, and a bootstrap that ran
  // out of retries are all verdicts about the work; a chat that was closed is not.
  agent.info.revivable = options.revivable === true;
  // A revivable failure keeps whatever the prime said to it. If the worker comes back, those
  // messages are still the instructions it never acknowledged; throwing them away here and
  // then reviving the worker would silently drop them.
  if (!agent.info.revivable) agent.queue = [];
  recount(agent);

  const report = newMessage(
    id,
    PRIME_ID,
    note ??
      `[${id} failed] Its ChatGPT tab never came up: ${agent.info.result}. It will not report. Do that part of the ` +
        'work yourself or spawn a replacement worker.'
  );
  const prime = primeAgent();
  prime.queue.push(report);
  recount(prime);
  logWarn(`multi-agent: ${id} failed — ${reason}`);
  changed();
  return { info: { ...agent.info }, report: { ...report }, repeat: false };
}

// -------------------------------------------------------------- sleep / wake

/**
 * Puts a worker to sleep on evidence that it stopped working, without ending it.
 *
 * The app-owned half of the lifecycle, and the reason a run can outlive any individual piece
 * of work. Every caller here is an observation rather than a verdict — a settled final answer,
 * a chat that went quiet with its tab gone, a durably quiescent turn — so none of them may
 * throw anything away. The conversation, the transcript, the workspace and the unacknowledged
 * queue all survive, because the next thing that happens to this worker is most likely the
 * prime waking it up in that same chat.
 *
 * The context ceiling is the one thing that makes a stop final, and it is read here rather
 * than enforced anywhere earlier: a worker that crossed it mid-task was never interrupted, it
 * simply has no room left for another task once this one ends.
 */
function sleepAgent(agent: Agent, reason: string): FinishResult | null {
  if (!run || agent.info.role !== 'worker') return null;
  if (!canStop(agent.info.state)) return null;
  // A finish crossing its own durable acceptance barrier is the stronger, more specific
  // statement about the same transition. Never publish two of them.
  if (activeFinishStages.has(agent)) return null;
  const terminal = ceilingCrossed(agent.info);
  const now = Date.now();
  agent.info.state = terminal ? 'finished' : 'sleeping';
  agent.info.sleptAt = now;
  agent.info.finishedAt = terminal ? now : null;
  agent.info.detachedAt = null;
  agent.info.revivable = !terminal;
  recount(agent);
  const report = newMessage(
    agent.info.id,
    PRIME_ID,
    terminal
      ? `[${agent.info.id} finished] ${reason} Its chat has also reached the context limit, so it cannot be woken ` +
        'again. Its worker slot is free; spawn a new worker if that work still matters.'
      : `[${agent.info.id} is sleeping] ${reason} Its worker slot is free and its chat is intact — wake it with ` +
        `agents action=message to="${agent.info.id}" when you have more for it, rather than spawning a new worker.`
  );
  const prime = primeAgent();
  prime.queue.push(report);
  recount(prime);
  logInfo(`multi-agent: ${agent.info.id} ${terminal ? 'finished for good' : 'is sleeping'} — ${reason}`);
  changed();
  return { info: { ...agent.info }, report: { ...report }, repeat: false };
}

/**
 * Sleeps a worker the browser proved has stopped, addressed by its own chat.
 *
 * The counterpart of {@link finishWorkerConversation} for the paths that have an observation
 * but no result text of the worker's own.
 */
export function sleepWorkerConversation(conversationId: string, reason: string): FinishResult | null {
  if (!run || !conversationId) return null;
  const agent = agentForConversationId(conversationId);
  if (!agent || agent.info.role !== 'worker') return null;
  return sleepAgent(agent, reason);
}

/** Sleeps a worker by slot id. Used by sweeps that already know which row they proved quiet. */
export function sleepWorker(id: string, reason: string): FinishResult | null {
  const agent = run?.agents.get(id);
  if (!agent) return null;
  return sleepAgent(agent, reason);
}

/**
 * What the app has to do in the browser to wake one worker, and which messages ride on it.
 *
 * Carries the conversation because that *is* the worker: reviving is reopening one exact
 * `/c/<id>` and typing into it. Carries the ids as well as the text so that acceptance can
 * mark exactly the messages that were typed as offered, rather than whatever happened to be
 * queued by the time the browser answered — a message marked offered but never delivered is
 * retired by the worker's next call and lost.
 */
export interface WorkerRevival {
  id: string;
  conversationId: string;
  runId: string;
  text: string;
  messageIds: string[];
}

let reviveRequest: ((revivals: WorkerRevival[]) => void) | null = null;

/**
 * The bridge registers here, exactly as it does for spawn bootstraps.
 *
 * Registration replays whatever is already owed, for the same reason: a restart restores the
 * run before the bridge exists, so a worker left mid-revival has nobody to ask for a tab.
 */
export function onReviveRequest(handler: (revivals: WorkerRevival[]) => void): () => void {
  reviveRequest = handler;
  const owed = pendingWorkerRevivals();
  if (owed.length > 0) {
    handler(owed);
    logInfo(`multi-agent: ${owed.length} worker chat(s) still owed a revival`);
  }
  return () => {
    if (reviveRequest === handler) reviveRequest = null;
  };
}

/** Workers whose slot is reserved and whose chat has not been typed into yet. */
export function pendingWorkerRevivals(): WorkerRevival[] {
  if (!run) return [];
  const out: WorkerRevival[] = [];
  for (const agent of run.agents.values()) {
    if (agent.info.state !== 'waking' || !agent.info.conversationId) continue;
    const plan = planRevivalText(agent);
    out.push({
      id: agent.info.id,
      conversationId: agent.info.conversationId,
      runId: run.runId,
      text: plan.text,
      messageIds: plan.messageIds
    });
  }
  return out;
}

/**
 * Gives the browser exclusive ownership of an in-flight wake before it receives the text.
 *
 * `waking + revivable=true` is the arbitration window: a late MCP call from the old server-side
 * turn may still prove that worker never really stopped and take it back to `active`. Once the
 * exact revival command has been durably redeemed, however, that same late call must not steal
 * the transaction after the browser already owns its payload. Reuse `revivable=false` only while
 * state is `waking`; every other state already gives that bit its ordinary meaning.
 *
 * The bridge makes this mutation durable before returning the command body. If that barrier
 * fails it calls {@link rollbackWorkerRevivalClaim}, restoring the pre-claim arbitration state.
 */
export function claimWorkerRevival(id: string, conversationId: string): boolean {
  const agent = run?.agents.get(id);
  if (!agent || agent.info.state !== 'waking' || agent.info.conversationId !== conversationId) return false;
  if (!agent.info.revivable) return true;
  agent.info.revivable = false;
  changed('critical');
  return true;
}

/** Rolls back only the browser-claim marker while the wake is otherwise still untouched. */
export function rollbackWorkerRevivalClaim(id: string, conversationId: string): boolean {
  const agent = run?.agents.get(id);
  if (!agent || agent.info.state !== 'waking' || agent.info.conversationId !== conversationId || agent.info.revivable) {
    return false;
  }
  agent.info.revivable = true;
  changed('critical');
  return true;
}

/** True only while a browser-owned wake is between durable redeem and sent/failed ACK. */
export function workerRevivalClaimed(conversationId: string | null | undefined): boolean {
  if (!run || !conversationId) return false;
  const agent = boundAgent(conversationId);
  return Boolean(agent?.info.role === 'worker' && agent.info.state === 'waking' &&
    !agent.info.revivable && !agent.info.lastRevivalCommandId);
}

/**
 * Durable evidence that a browser-owned wake already crossed its semantic send boundary.
 *
 * `/commands/ack` writes the worker snapshot before it writes the bridge receipt. A crash in
 * between therefore restores the leased command but may restore the worker as active/sleeping
 * rather than `waking`. The browser must be able to retry that ACK without the bridge turning a
 * successful send into a terminal failure. A revival-offer stamped no earlier than this
 * command's owner lease is the exact broker-side evidence of that prior send; acknowledged rows
 * count too, because the worker may have made its next call before the browser's HTTP retry.
 */
export function workerRevivalDeliveredSince(
  id: string,
  conversationId: string,
  commandId: string,
  claimedAt: number
): boolean {
  const agent = run?.agents.get(id);
  if (!agent || !conversationId || agent.info.conversationId !== conversationId) return false;
  if (commandId && agent.info.lastRevivalCommandId === commandId) return true;
  // Backward-compatible evidence for a snapshot written between introduction of durable
  // revival offers and the exact command-id marker. New sends always take the exact branch.
  //
  // Unread is part of that evidence, not decoration. An offer the worker has already answered
  // belongs to a wake that is over, and reading it as proof of delivery is what refused a
  // later, legitimate wake as `command_already_sent`. This is the same reading of "a revival
  // was delivered" that noteAgentAlive() uses.
  return agent.queue.some(
    (message) =>
      message.ackedAt === null &&
      message.offeredViaRevival === true &&
      message.offeredAt !== null &&
      message.offeredAt >= claimedAt
  );
}

/**
 * The user message the extension types into a woken worker's chat.
 *
 * The prime's own words, delivered the way a person would deliver them, because that is what
 * they are: this app is not asking the worker to go and fetch something, it is handing it the
 * instruction. The short parenthetical afterwards exists only because the worker's last turn
 * ended with it being told to stop — without it, a well-behaved worker reads a new user turn
 * and still believes it is finished.
 */
function planRevivalText(agent: Agent): { text: string; messageIds: string[] } {
  const waiting: AgentMessage[] = [];
  let chars = 0;
  for (const message of agent.queue) {
    // A browser `sent` ACK is stronger than an ordinary MCP offer: ChatGPT already accepted
    // this row as a real user message in the worker chat. It remains in the queue only until
    // the worker's next authenticated call proves receipt, but it must never be typed again by
    // a later revival in the meantime. This matters especially across feature-disable parking:
    // an active revived worker can be put back to sleep before it makes another tool call.
    if (message.ackedAt !== null || message.offeredViaRevival || unpublishedMessages.has(message)) continue;
    if (waiting.length > 0 && chars + message.text.length > MAX_INBOX_OFFER_CHARS) break;
    waiting.push(message);
    chars += message.text.length;
  }
  const body = waiting.map((message) => message.text).join('\n\n');
  const text =
    (body || 'The prime agent has more work for you; check your inbox on the next tool result.') +
    `\n\n(Chat On Steroids: you are still ${agent.info.id} in the same run, and this is the prime agent talking to ` +
    'you again in the chat you already know. Pick up from what you did here before rather than starting over. ' +
    'Report with agents action=message to="prime" as you go and action=finish when this piece is done.)';
  return { text, messageIds: waiting.map((message) => message.id) };
}

/**
 * Reserves a slot for a sleeping worker and asks the browser to wake it, or refuses.
 *
 * Slot reservation is the whole reason this is a state transition rather than a side effect.
 * Two messages to two sleeping workers arriving at once must not both see the same last free
 * slot, so the transition into `waking` — which {@link occupiesSlot} counts — happens here,
 * synchronously, before anything touches the browser.
 */
function beginRevival(agent: Agent): void {
  agent.info.state = 'waking';
  // `sleptAt` stays: the worker is still stopped while waking, and that timestamp is what tells
  // a turn the page reports *now* apart from the page replaying the turn that ended before the
  // sleep. It is cleared by the revival's own proof, in noteAgentAlive().
  agent.info.detachedAt = null;
  // True only for the pre-claim arbitration window. A proven tool call may still show that the
  // old server-side turn never stopped and take the worker active; `/commands/redeem` flips this
  // false durably before it returns any payload, after which the browser owns the wake instead.
  agent.info.revivable = true;
  agent.info.lastRevivalCommandId = null;
  logInfo(`multi-agent: ${agent.info.id} is being woken in conversation ${agent.info.conversationId}`);
}

/**
 * Reserves workers that have stopped with prime work which was never offered to them.
 *
 * A message sent while a worker is `detached` cannot safely be injected immediately: its
 * server-side turn may still be running. Once that worker is later proved stopped, however,
 * leaving the already-accepted message in a sleeping inbox strands it until the prime happens
 * to send a *second* message. This stages the missing handoff from "stopped" to "waking".
 *
 * No browser side effect happens here. The caller must persist this critical revision, commit
 * it, and only then call requestWorkerRevivals(). That keeps the same durable-before-publish
 * boundary as an ordinary message-to-sleeping-worker revival.
 */
export function stageQueuedWorkerRevivals(ids: readonly string[]): {
  waking: string[];
  commit: () => void;
  rollback: () => void;
} {
  if (!run || ids.length === 0) return { waking: [], commit: () => undefined, rollback: () => undefined };
  const wanted = new Set(ids);
  const reserved: Array<{ agent: Agent; sleptAt: number | null }> = [];
  for (const agent of run.agents.values()) {
    if (
      agent.info.role !== 'worker' ||
      !wanted.has(agent.info.id) ||
      agent.info.state !== 'sleeping' ||
      !agent.info.revivable ||
      !agent.info.conversationId ||
      ceilingCrossed(agent.info)
    ) {
      continue;
    }
    const hasUnseen = agent.queue.some(
      (message) =>
        message.ackedAt === null &&
        message.offeredAt === null &&
        !unpublishedMessages.has(message)
    );
    if (!hasUnseen || freeWorkerSlots() <= 0) continue;
    const sleptAt = agent.info.sleptAt;
    beginRevival(agent);
    reserved.push({ agent, sleptAt });
  }
  if (reserved.length === 0) return { waking: [], commit: () => undefined, rollback: () => undefined };
  changed();
  let settled = false;
  return {
    waking: reserved.map(({ agent }) => agent.info.id),
    commit: () => {
      if (settled) return;
      settled = true;
      changed('telemetry');
    },
    rollback: () => {
      if (settled) return;
      settled = true;
      for (const { agent, sleptAt } of reserved) {
        if (agent.info.state !== 'waking') continue;
        returnWakingWorkerToStopped(
          agent,
          sleptAt ?? Date.now(),
          'Its queued-work revival was rolled back before the browser could safely deliver it.'
        );
      }
      changed();
    }
  };
}

/**
 * Publishes revival bootstraps for workers that are still genuinely waking.
 *
 * The second half of the `message` transaction, mirroring {@link requestWorkerBootstraps}: the
 * broker plans and reserves first, that revision is made durable, and only then is a browser
 * asked to open anything. A retry after a failed disk barrier is safe because a worker that is
 * already awake is skipped.
 */
export function requestWorkerRevivals(ids: readonly string[]): number {
  if (!run || ids.length === 0) return 0;
  const wanted = new Set(ids);
  const owed = pendingWorkerRevivals().filter((revival) => wanted.has(revival.id));
  if (owed.length === 0) return 0;
  if (reviveRequest) reviveRequest(owed);
  else logWarn('multi-agent: no browser extension is paired, so sleeping worker chats cannot be reopened');
  return owed.length;
}

/**
 * The browser proved it typed the prime's message into the worker's own chat.
 *
 * Delivery is recorded as an offer, not liveness. The worker stays `waking` until an exact
 * authenticated call proves the model reacted; a different conversation never counts.
 */
export function noteWorkerRevived(
  id: string,
  conversationId: string,
  messageIds: readonly string[],
  commandId: string | null = null
): boolean {
  const agent = run?.agents.get(id);
  if (!agent || agent.info.state !== 'waking') return false;
  if (!conversationId || agent.info.conversationId !== conversationId) {
    logWarn(`multi-agent: refused a revival ack for ${id} naming conversation ${conversationId}`);
    return false;
  }
  const now = Date.now();
  agent.info.revivable = false;
  agent.info.finishedAt = null;
  agent.info.result = null;
  if (commandId) agent.info.lastRevivalCommandId = commandId;
  const offered = new Set(messageIds);
  for (const message of agent.queue) {
    if (message.ackedAt !== null || !offered.has(message.id)) continue;
    message.offeredAt = now;
    message.offers += 1;
    message.offeredOnFinish = false;
    message.offeredViaRevival = true;
  }
  recount(agent);
  logInfo(`multi-agent: revival message reached ${id} in conversation ${conversationId}; waiting for worker liveness`);
  changed('critical');
  return true;
}

/**
 * Permanently closes a worker that is already stopped and is now known to be at the context
 * ceiling. This can happen after it was first reported sleeping, or while a wake transaction
 * is being rolled back.
 *
 * Messages never offered to the worker cannot ever be consumed once this state is terminal.
 * Remove those rows and tell the prime exactly what became undeliverable rather than leaving a
 * finished worker with a permanently nonzero inbox. Already-offered rows stay for the existing
 * lost-result retry semantics: they may genuinely have reached the worker.
 */
function finishStoppedWorkerAtCeiling(agent: Agent, reason: string, sleptAt = Date.now()): AgentMessage {
  const now = Date.now();
  const neverOffered = agent.queue.filter(
    (message) => message.ackedAt === null && message.offeredAt === null && !unpublishedMessages.has(message)
  );
  if (neverOffered.length > 0) {
    const doomed = new Set(neverOffered);
    agent.queue = agent.queue.filter((message) => !doomed.has(message));
  }

  agent.info.state = 'finished';
  agent.info.sleptAt = sleptAt;
  agent.info.finishedAt = now;
  agent.info.detachedAt = null;
  agent.info.revivable = false;
  recount(agent);

  const missed =
    neverOffered.length > 0
      ? ` ${neverOffered.length} queued message${neverOffered.length === 1 ? '' : 's'} could not be delivered before that limit` +
        ` (${neverOffered
          .slice(0, 3)
          .map((message) => `“${message.text.slice(0, 180)}”`)
          .join(', ')}${neverOffered.length > 3 ? ', …' : ''}). Those instructions are no longer queued.`
      : '';
  const report = newMessage(
    agent.info.id,
    PRIME_ID,
    `[${agent.info.id} finished for good] ${reason} Its chat has reached the context limit, so it cannot be woken again.` +
      `${missed} Its worker slot is free; spawn a new worker for any remaining work.`
  );
  const prime = primeForOwnedAgent(agent);
  if (!prime) throw new AgentError(`Cannot find the prime that owns ${agent.info.id}.`);
  prime.queue.push(report);
  recount(prime);
  return report;
}

/** Finds the prime row that owns this exact Agent object, active or dormant. */
function primeForOwnedAgent(agent: Agent): Agent | null {
  if (run && [...run.agents.values()].includes(agent)) return run.agents.get(PRIME_ID) ?? null;
  for (const dormant of dormantRuns.values()) {
    if ([...dormant.agents.values()].includes(agent)) return dormant.agents.get(PRIME_ID) ?? null;
  }
  return null;
}

/** Returns a failed/rolled-back wake to the only stopped state its current context permits. */
function returnWakingWorkerToStopped(agent: Agent, sleptAt: number, reason: string): AgentMessage | null {
  if (ceilingCrossed(agent.info)) return finishStoppedWorkerAtCeiling(agent, reason, sleptAt);
  agent.info.state = 'sleeping';
  agent.info.sleptAt = sleptAt;
  agent.info.finishedAt = null;
  agent.info.detachedAt = null;
  agent.info.revivable = true;
  recount(agent);
  return null;
}

/** Consecutive failed wakes, with no sign of life from the chat between them, that end a worker. */
export const WAKE_FAILURES_BEFORE_GIVING_UP = 2;
/** Failed wakes per worker conversation since that chat last proved alive. Memory-only: a restart forgives one. */
const consecutiveWakeFailures = new Map<string, number>();

/**
 * The browser could not wake this worker, so the slot it was holding goes back.
 *
 * Deliberately not a failure of the worker. Nothing was typed into its chat, its queue is
 * untouched and still unacknowledged, and the chat itself is exactly as reusable as it was a
 * moment ago — so it returns to `sleeping` and the prime can try again. The prime is told,
 * because it is holding a message it believes was delivered.
 */
export function failWorkerRevival(id: string, why: string): AgentMessage | null {
  const agent = run?.agents.get(id);
  if (!agent || agent.info.state !== 'waking') return null;
  const chat = agent.info.conversationId ?? id;
  const strikes = (consecutiveWakeFailures.get(chat) ?? 0) + 1;
  consecutiveWakeFailures.set(chat, strikes);
  if (strikes >= WAKE_FAILURES_BEFORE_GIVING_UP && !ceilingCrossed(agent.info)) {
    // The second failed wake with nothing heard from the chat in between is the verdict on the
    // chat, not on the browser. On 2026-09-03 worker-7's ChatGPT conversation answered every
    // load with "This content is unavailable"; four wakes each waited out their deadline and
    // each told the prime "try once more", which it did — thirty minutes and four prime turns
    // before it spawned the replacement it could have spawned after the first repeat. A
    // revivable failure keeps its inbox: the chat calling again brings it back as usual.
    const failed = failAgent(
      id,
      `its chat did not answer ${strikes} revivals in a row (${why})`,
      `[${id} failed] Its chat did not answer ${strikes} revivals in a row: ${why} Treat it as gone — do not try to ` +
        'wake it again. Do that part of the work yourself or spawn a replacement worker. Should its chat ever call ' +
        'in again, you will be told it is back.',
      { revivable: true }
    );
    if (failed) {
      consecutiveWakeFailures.delete(chat);
      return failed.report;
    }
  }
  const terminal = returnWakingWorkerToStopped(
    agent,
    Date.now(),
    `The browser could not complete its revival: ${why}`
  );
  if (terminal) {
    consecutiveWakeFailures.delete(chat);
    logWarn(`multi-agent: could not wake ${id}; the chat crossed its context ceiling while revival was in flight`);
    changed();
    return terminal;
  }
  const report = newMessage(
    id,
    PRIME_ID,
    `[${id} could not be woken] ${why} It is still asleep and still holds everything it knew. Any revival text ChatGPT ` +
      'accepted remains offered but was not proven read, so it will not be injected twice. Its slot is free again: try agents action=message to="' +
      id +
      '" once more, or do that work another way.'
  );
  const prime = primeAgent();
  prime.queue.push(report);
  recount(prime);
  logWarn(`multi-agent: could not wake ${id} — ${why}`);
  changed();
  return report;
}

/**
 * What the local session store measured this agent's own chat to be carrying.
 *
 * Fed from the durable session that records this exact conversation, never from anything a
 * model said about itself. Monotonic within a run: a conversation's context only grows, and a
 * transient read of a half-rebuilt summary must not be able to un-cross the ceiling and make a
 * worker revivable again after the prime was told it was finished.
 */
export function noteAgentContextTokens(conversationId: string | null | undefined, tokens: number): void {
  if (!conversationId || !Number.isFinite(tokens) || tokens < 0) return;
  const agent = boundAgent(conversationId) ?? dormantAgentForConversation(conversationId)?.agent ?? null;
  if (!agent || agent.info.contextTokens >= tokens) return;
  const crossed = !ceilingCrossed(agent.info) && tokens >= WORKER_CONTEXT_CEILING_TOKENS;
  agent.info.contextTokens = tokens;
  // Crossing never stops anything. A worker in the middle of a task keeps its slot, its inbox
  // and its right to report; all that changes is that it can no longer be woken afterwards,
  // which is only decided the next time it stops.
  if (crossed && agent.info.role === 'worker') {
    const staged = upgradeStagedFinishAtCeiling(agent);
    if (!staged && agent.info.state === 'sleeping') {
      finishStoppedWorkerAtCeiling(
        agent,
        'A late measurement crossed the context ceiling after this worker had already stopped.'
      );
    } else if (hasStopped(agent.info.state)) {
      agent.info.revivable = false;
    }
    logInfo(
      `multi-agent: ${agent.info.id} passed the ${WORKER_CONTEXT_CEILING_TOKENS} token ceiling; it keeps working but cannot be woken again`
    );
    // The crossing can revoke wake authority or rewrite a staged finish projection. That is a
    // critical state edge, not optional telemetry: crash recovery must never resurrect the old
    // revivable state after this process has already measured the terminal ceiling.
    changed('critical');
    return;
  }
  changed('telemetry');
}

// -------------------------------------------------------- prime lifecycle

/** Whether a run exists at all. */
export function swarmRunning(): boolean {
  return run !== null;
}

/** The conversation the prime is bound to, or null when there is no run. */
export function primeConversation(): string | null {
  return run?.primeConversationId ?? null;
}

/** The run identifier, or null. Names the run in logs, transfers and tool results. */
export function currentRunId(): string | null {
  return run?.runId ?? null;
}

/** Whether Compact & Resume currently owns the prime binding transition. */
export function swarmTransferActive(): boolean {
  return Boolean(run?.transfer);
}

/**
 * The prime chat's tab has gone.
 *
 * Called by the bridge when the prime's tab reports that it closed or navigated away with no
 * transfer open. It used to end the run on the spot, and with one-shot workers that was right:
 * a swarm whose coordinator is gone has nobody to report to, and workers that keep going are
 * tabs writing files for a run nobody is reading.
 *
 * Reusable workers change what a closed prime tab means. The run's whole value is now the
 * chats it has accumulated — workers that already understand the task, asleep and waiting for
 * the next thing to do — and the user's own loop is *the prime stops, I read something else, I
 * come back and give it feedback*. Closing that tab in between is a pause, not a decision, and
 * ending the run over it destroyed every sleeping worker in it. There is deliberately no
 * timeout on the pause either: a run that is worth resuming after ten minutes is worth
 * resuming the next morning, and any clock here would only move the same bug further out.
 *
 * So the prime detaches, exactly as a worker does, and the run waits. It ends here only when
 * there is genuinely nothing left to come back to — no worker still working and none that
 * could be woken — which is the same condition the run would have ended on anyway. Otherwise
 * the user's escape hatch is the explicit one: Clear swarm in the app.
 */
export function primeConversationGone(conversationId: string): boolean {
  if (!run || run.primeConversationId !== conversationId) return false;
  // A handover in flight is the one case where the prime chat is *supposed* to go away.
  if (run.transfer) return false;
  const prime = run.agents.get(PRIME_ID);
  // A terminal worker report is still part of the run until the prime has actually received
  // and acknowledged it. Ending the run merely because every worker is now terminal destroys
  // exactly the result their terminalisation produced. A closed prime tab therefore remains a
  // pause while any prime inbox row is outstanding; reopening the same chat can collect it and
  // ordinary releaseQuiescentRun() retires the run once delivery is safe.
  const pendingPrimeReport = Boolean(prime?.queue.some((message) => message.ackedAt === null));
  const reusable = [...run.agents.values()].some(
    (agent) => agent.info.role === 'worker' && (occupiesSlot(agent.info.state) || canBeRevived(agent.info))
  );
  if (!reusable && !pendingPrimeReport) {
    endRun('the prime conversation was closed and no worker was left to come back to');
    changed();
    return true;
  }
  if (prime && prime.info.state !== 'detached') {
    prime.info.state = 'detached';
    prime.info.detachedAt = Date.now();
  }
  if (run.primeGoneAt === null) {
    run.primeGoneAt = Date.now();
    logInfo(
      `multi-agent: the prime chat ${conversationId} closed, but its run keeps ${pendingPrimeReport ? 'its undelivered reports' : 'its workers'} until the user returns or clears it`
    );
  }
  changed();
  return false;
}

/** Whether the prime may wake this agent by messaging it. */
function canBeRevived(info: AgentInfo): boolean {
  return info.role === 'worker' && info.state === 'sleeping' && info.revivable;
}

/**
 * Detaches a bound worker when the browser reports its final tab closed.
 *
 * **A closed tab is not a finished worker.** The turn belongs to OpenAI's servers, not to the
 * page: a worker whose chat is closed mid-task keeps thinking, keeps calling this connector,
 * and its calls keep arriving stamped with the same `x-request-id` workflow that
 * correlation.ts has already proved belongs to this exact conversation. Terminalising the
 * slot here was reading the browser's lifecycle as if it were the turn's — the run declared a
 * failure, told the prime to do that work itself, and freed a slot belonging to a worker that
 * was at that moment still writing files.
 *
 * So the browser event is recorded as what it actually is: the view went away. The worker
 * keeps its slot, its binding, its inbox and its right to `finish`, and it ends only when
 * something says something about the *work* — a `finish`, a durably completed turn, a person
 * clearing the row, or {@link failSilentDetachedWorkers} once the calls stop too.
 */
export function workerConversationGone(conversationId: string): boolean {
  if (!run || !conversationId) return false;
  const worker = [...run.agents.values()].find(
    (agent) =>
      agent.info.role === 'worker' &&
      agent.info.conversationId === conversationId &&
      occupiesSlot(agent.info.state)
  );
  // A sleeping worker's tab closing is not an event: it was not working, it holds no slot, and
  // the chat is reopened from its id the next time the prime wants it.
  if (!worker || worker.info.state === 'detached' || worker.info.state === 'waking') return false;
  worker.info.state = 'detached';
  worker.info.detachedAt = Date.now();
  worker.info.revivable = true;
  // Nothing is queued for the prime here on purpose. The prime cannot act on "a tab closed",
  // and it is told the one thing it can act on either way: the worker's result when it
  // finishes, or the failure report when it goes quiet. `status` shows `detached` meanwhile.
  logInfo(`multi-agent: ${worker.info.id} detached — its chat was closed while its turn may still be running`);
  changed();
  return true;
}

/** What one piece of first-hand liveness evidence did to the agent it names. */
export interface AliveResult {
  agentId: string;
  /** True only on the call that brought a given-up-on agent back. */
  revived: boolean;
  /** Queued for the prime when the prime had already been told this worker was gone. */
  report: AgentMessage | null;
}

/**
 * First-hand liveness, and the revival it can justify.
 *
 * Fed by the two things that prove a conversation still exists, and by nothing else: an MCP
 * call this app *proved* came from it (the request-id join), and its own page reporting to
 * the bridge. Both mean the same thing here, which is why there is one clock rather than a
 * browser one and a connector one that disagree — a worker whose tab is open is never on the
 * silence clock at all, because its page keeps stamping this.
 *
 * Two things follow from that evidence:
 *
 *   - the agent bound to that conversation was alive at this instant, which is the clock
 *     {@link failSilentDetachedWorkers} measures; and
 *   - if that agent had been given up on *because its chat went away*, this is direct
 *     evidence that giving up was wrong, so it is taken back.
 *
 * Revival is deliberately never something a model can ask for. It is the same evidence that
 * routes every other call — a stored request id, or the extension's own report — arriving at
 * a slot that was closed underneath a turn which never stopped.
 *
 * A revival can put a run one worker over the configured limit, when the prime spawned a
 * replacement in the meantime. That is the honest reading: the worker *is* running, the limit
 * governs how many chats this app will start, and refusing to recognise one that is already
 * working would only make its calls unattributable.
 */
export function noteAgentAlive(
  conversationId: string | null | undefined,
  source: 'call' | 'page' | 'turn' = 'call',
  at = Date.now()
): AliveResult | null {
  if (!run || !conversationId) return null;
  const agent = boundAgent(conversationId);
  if (!agent) return null;
  // Any first-hand word from the chat — a call, a turn, or its page — means it can be reached,
  // so the count of wakes it has failed in a row starts over.
  consecutiveWakeFailures.delete(conversationId);
  const now = Date.now();
  if (agent.info.role === 'prime') {
    agent.info.lastSeenAt = now;
    // The prime chat is back. Whether it was closed and reopened or merely lost its extension
    // for a moment, the run is attended again and nothing about it is abandoned.
    const returned = run.primeGoneAt !== null || agent.info.state === 'detached';
    if (returned) {
      run.primeGoneAt = null;
      agent.info.state = 'active';
      agent.info.detachedAt = null;
      logInfo(`multi-agent: the prime chat ${conversationId} is back, so its run carries on`);
      changed();
    }
    return { agentId: agent.info.id, revived: returned, report: null };
  }
  // A sleeping worker's *page* is not evidence that it is working. Its tab stays open after
  // its turn settles and keeps reporting the same transcript, so waking on that would undo
  // every sleep the moment it happened and hand the slot straight back. A proven tool call is
  // different: the model in that chat is running, whatever the app decided a moment ago.
  //
  // So is a turn that *started after this app put the worker to sleep*. That is not the old
  // transcript being re-reported, it is a new generation beginning, and it is the model running
  // just as much as a call is. Refusing it made a worker whose request-id path broke unwakeable
  // by construction: its calls arrive with no conversation to wake, so `call` never fires, and
  // every page fact was refused here — the app then slept a worker that was visibly generating
  // and spent the next revival deadline typing at a chat it had already given up on.
  const sleeping = agent.info.state === 'sleeping' || agent.info.state === 'waking';
  const staleTurn = source === 'turn' && at <= (agent.info.sleptAt ?? 0);
  if (sleeping && (source === 'page' || staleTurn)) {
    agent.info.lastSeenAt = now;
    return { agentId: agent.info.id, revived: false, report: null };
  }
  // A model turn can keep making connector calls after its browser tab was closed. That call
  // proves the server-side worker is still alive, but it does not prove a page exists again.
  // Keeping `detached` preserves the silence-based escape hatch for a turn whose final call is
  // the last thing this app ever sees; a real page observation below is what clears detachment.
  if (agent.info.state === 'detached' && source === 'call') {
    agent.info.lastSeenAt = now;
    return { agentId: agent.info.id, revived: false, report: null };
  }
  const ended =
    agent.info.state !== 'active' && agent.info.state !== 'invited';
  // A worker that was ended on the work's own evidence stays ended: its chat calling again is
  // a model that has not stopped, not a slot to reopen.
  // Redeem makes `revivable=false`; only a delivery marker followed by this exact call, or a
  // turn beginning after that delivery, may finish the wake. Before redeem, a late old-turn
  // call or turn may still prove the wake was unnecessary. Between the two — the browser owns
  // the payload but has not typed it — nothing does, so the page cannot be raced into typing
  // the same words twice.
  //
  // A turn counts because it is the earlier of the two proofs and the one that never depends
  // on the request-id join: the woken model routinely reads for a minute before its first
  // call, and when that call's page evidence is late the worker used to sit in `waking` while
  // its calls piled into Unattributed activity, until the deadline slept it as "could not be
  // woken" under a turn that was visibly running.
  const hasDeliveredRevival =
    Boolean(agent.info.lastRevivalCommandId) ||
    agent.queue.some((message) => message.ackedAt === null && message.offeredViaRevival && message.offeredAt !== null);
  const provedDeliveredWake =
    agent.info.state === 'waking' &&
    source !== 'page' &&
    (agent.info.revivable || hasDeliveredRevival);
  if (!ended || (!provedDeliveredWake && agent.info.state !== 'detached' && !agent.info.revivable)) {
    agent.info.lastSeenAt = now;
    return { agentId: agent.info.id, revived: false, report: null };
  }
  const was = agent.info.state;
  agent.info.state = 'active';
  agent.info.detachedAt = null;
  agent.info.finishedAt = null;
  agent.info.sleptAt = null;
  agent.info.revivable = false;
  agent.info.lastSeenAt = now;
  if (was === 'failed') agent.info.result = null;
  if (!agent.info.activatedAt) agent.info.activatedAt = now;
  // Two revivals need saying, and both for the same reason: the prime was told something
  // about this worker that has just stopped being true, and left standing it is how the same
  // work gets done twice or a slot gets counted free while somebody is using it. A worker
  // coming back from `detached` needs nothing said — the prime was never told it had gone.
  let report: AgentMessage | null = null;
  if (was === 'failed' || was === 'sleeping') {
    const how =
      source === 'page' ? 'reappeared in the browser' : source === 'turn' ? 'started another turn' : 'made another tool call';
    report = newMessage(
      agent.info.id,
      PRIME_ID,
      was === 'failed'
        ? `[${agent.info.id} is back] It was reported gone, but it is working again — it just ${how}. ` +
          'Ignore that earlier report: do not redo its work, and expect its result normally.'
        : `[${agent.info.id} is awake again] It was reported asleep with its slot free, but it never actually ` +
          `stopped — it just ${how}. It is working, it holds its slot again, and its result will arrive the ` +
          'ordinary way. You do not need to wake it.'
    );
    const prime = primeAgent();
    prime.queue.push(report);
    recount(prime);
  }
  logInfo(`multi-agent: ${agent.info.id} revived from ${was} — conversation ${conversationId} is still alive (${source})`);
  changed();
  return { agentId: agent.info.id, revived: true, report };
}

/** Every agent bound to a conversation, terminal ones included. Revival has to see those. */
function boundAgent(conversationId: string): Agent | null {
  if (!run) return null;
  if (conversationId === run.primeConversationId) return run.agents.get(PRIME_ID) ?? null;
  for (const agent of run.agents.values()) {
    if (agent.info.conversationId === conversationId) return agent;
  }
  return null;
}

/**
 * The verdict an ordinary tool call from a bound worker's chat deserves, if it deserves one.
 *
 * A worker that is genuinely over used to learn nothing: its slot was a tombstone, its calls
 * were attributed to nobody, and the file writes went through as if some unrelated chat had
 * made them. So the chat kept working — the one thing nobody wanted — and the user watched a
 * worker it had ended carry on. This is the sentence that tells it, on its own next call.
 *
 * `null` for everything else, including a `detached` worker (still working, still welcome), a
 * revivable one (about to be revived by this very call instead) and a sleeping one — a call
 * from a sleeping worker's chat means it was not asleep, and {@link noteAgentAlive} has
 * already taken its slot back by the time this is asked.
 */
export function endedWorkerNotice(conversationId: string | null | undefined): string | null {
  if (!conversationId) return null;
  const agent = boundAgent(conversationId) ?? dormantAgentForConversation(conversationId)?.agent ?? null;
  if (!agent || agent.info.role !== 'worker' || !isOver(agent.info.state) || agent.info.revivable) return null;
  return (
    `WORKER_ENDED: ${agent.info.id} has already ${agent.info.state === 'finished' ? 'finished' : 'ended'} in this run` +
    `${agent.info.result ? ` (${agent.info.result.slice(0, 200)})` : ''}. Nothing was run. Stop working and stop ` +
    'calling tools: the prime agent is not waiting for anything else from this chat, and anything you do here now is ' +
    'work nobody asked for.'
  );
}

/**
 * Sleeps detached workers that have also stopped being seen.
 *
 * The other half of "a closed tab is not a finished worker": with the tab gone, page evidence
 * can no longer report the turn ending, so silence is the only ending left. Nothing here is a
 * heartbeat lease — the clock is the last moment this app had first-hand evidence of that
 * conversation, and a restart restarts it rather than inheriting an unpersisted one, so a
 * worker is never stopped on the strength of a number that was merely never written down.
 *
 * It sleeps rather than fails, which is what makes being wrong here cheap. A worker that was
 * quiet for six minutes and then calls again was evidently still working, and its own call
 * takes the slot straight back; a worker that really had stopped is exactly as reusable as one
 * that reported properly. Nothing is thrown away either way.
 *
 * This is the one silence clock left in the broker, and it exists only because a detached
 * worker has no page to prove anything about its turn. An *attached* worker is never slept on
 * silence here: its tab can sit open reporting nothing while a long tool-free generation runs,
 * so freeing that slot needs durable proof that no turn is open — which lives with the session
 * store, in the bridge's quiescence sweep, not here.
 */
export function sleepSilentDetachedWorkers(now = Date.now()): FinishResult[] {
  if (!run) return [];
  const out: FinishResult[] = [];
  for (const agent of [...run.agents.values()]) {
    if (agent.info.role !== 'worker' || agent.info.state !== 'detached') continue;
    const since = Math.max(agent.info.detachedAt ?? 0, agent.info.lastSeenAt ?? 0, livenessFloor);
    if (now - since < DETACHED_SILENCE_MS) continue;
    const outcome = sleepAgent(
      agent,
      'Its ChatGPT chat was closed and it has neither called a tool nor reappeared since, so this app can no longer ' +
        'see what it is doing.'
    );
    if (outcome) out.push(outcome);
  }
  return out;
}

/**
 * Notes that the app's own Compact & Resume is moving this session to a new chat.
 *
 * Deliberately *not* a second one-time-token system. The single continuation transaction
 * lives in the session layer, which owns the durable local session and its one-time token;
 * the swarm binding is one of the things that transaction moves, alongside the workspace and
 * the recorded history. All this flag does is stop {@link primeConversationGone} from
 * killing the run while chat A is being replaced, which is the one moment the prime chat is
 * *supposed* to disappear.
 */
export function beginPrimeTransfer(conversationId: string): boolean {
  if (run?.primeConversationId === conversationId) {
    run.transfer = { from: conversationId, at: Date.now(), frozen: false };
    return true;
  }
  const dormant = dormantRunForPrime(conversationId);
  if (!dormant) return false;
  dormant.transfer = { from: conversationId, at: Date.now(), frozen: false };
  return true;
}

/** Abandons an open handover, so the prime stays where it is. */
export function cancelPrimeTransfer(conversationId: string): void {
  if (run?.transfer?.from === conversationId) run.transfer = null;
  const dormant = dormantRunForPrime(conversationId);
  if (dormant?.transfer?.from === conversationId) dormant.transfer = null;
}

/**
 * What the session layer must know *before* it starts writing, and the point of no expiry.
 *
 * The commit is a fallible durable write followed by moves that have to be total, and the
 * swarm move is the one that used to be neither: it re-checked its own deadline inside the
 * total phase, so a commit that preflighted fine, then spent a second on disk, could leave
 * the durable session in chat B with the swarm still bound to chat A. So the decision is
 * taken here, once, before the write:
 *
 *   `absent`      — this chat is not the prime of any run. There is nothing to move, and the
 *                   session rebind is free to proceed.
 *   `unavailable` — it *is* the prime, but no usable handover is open. The caller must refuse
 *                   the whole commit; a session that moved without its swarm is the split this
 *                   exists to prevent.
 *   `frozen`      — the handover is now pinned and {@link commitPrimeTransfer} will succeed
 *                   for this pair unless the run itself ends in the meantime, which is a
 *                   terminal state rather than a half-commit: there is no prime left in chat A
 *                   to be inconsistent with.
 *
 * A freeze whose commit does not happen is released with {@link thawPrimeTransfer}, which
 * leaves the handover open, so a retry is still possible.
 */
export function freezePrimeTransfer(fromConversationId: string): 'absent' | 'unavailable' | 'frozen' {
  const owner =
    run?.primeConversationId === fromConversationId
      ? run
      : dormantRunForPrime(fromConversationId);
  if (!owner) return 'absent';
  const transfer = owner.transfer;
  if (!transfer || transfer.from !== fromConversationId) return 'unavailable';
  if (!owner.agents.has(PRIME_ID)) return 'unavailable';
  transfer.frozen = true;
  return 'frozen';
}

/** Undoes a freeze whose commit did not happen, leaving the handover open. */
export function thawPrimeTransfer(fromConversationId: string): void {
  if (run?.transfer?.from === fromConversationId) {
    run.transfer.frozen = false;
    return;
  }
  const dormant = dormantRunForPrime(fromConversationId);
  if (!dormant?.transfer || dormant.transfer.from !== fromConversationId) return;
  dormant.transfer.frozen = false;
}

/**
 * Moves the prime binding as part of the session rebind commit.
 *
 * Called only from the commit step of the session continuation transaction, after
 * {@link freezePrimeTransfer} authorised it and after that transaction has proven chat B is
 * real and usable. Deliberately has no deadline of its own — the freeze is the deadline — so
 * the only way this can now decline is that the run ended entirely while the write was in
 * flight, and a run that no longer exists cannot be left behind in chat A.
 *
 * Returns false, changing nothing, when there is no handover open from that exact
 * conversation, which is what stops a stray chat from inheriting a swarm.
 */
export function commitPrimeTransfer(fromConversationId: string, toConversationId: string): boolean {
  if (!fromConversationId || !toConversationId || fromConversationId === toConversationId) return false;
  if (run?.primeConversationId === fromConversationId && run.transfer?.from === fromConversationId) {
    const prime = run.agents.get(PRIME_ID);
    if (!prime || conversationOwnedOutside(run.agents, fromConversationId, toConversationId)) return false;
    run.primeConversationId = toConversationId;
    prime.info.conversationId = toConversationId;
    run.transfer = null;
    logInfo(`multi-agent: prime moved from conversation ${fromConversationId} to ${toConversationId}`);
    changed();
    return true;
  }

  const dormant = dormantRunForPrime(fromConversationId);
  if (!dormant?.transfer || dormant.transfer.from !== fromConversationId) return false;
  const prime = dormant.agents.get(PRIME_ID);
  if (!prime || conversationOwnedOutside(dormant.agents, fromConversationId, toConversationId)) return false;
  dormantRuns.delete(fromConversationId);
  dormant.primeConversationId = toConversationId;
  prime.info.conversationId = toConversationId;
  dormant.transfer = null;
  dormantRuns.set(toConversationId, dormant);
  logInfo(`multi-agent: dormant worker history moved from conversation ${fromConversationId} to ${toConversationId}`);
  changed();
  return true;
}

/** No prime transfer may land on a worker conversation or another prime owner's history. */
function conversationOwnedOutside(ownerAgents: Map<string, Agent>, fromConversationId: string, toConversationId: string): boolean {
  if (toConversationId === fromConversationId) return false;
  if (run && run.agents !== ownerAgents) {
    if (run.primeConversationId === toConversationId) return true;
    if ([...run.agents.values()].some((agent) => agent.info.conversationId === toConversationId)) return true;
  }
  const existingDormant = dormantRuns.get(toConversationId);
  if (existingDormant && existingDormant.agents !== ownerAgents) return true;
  for (const dormant of dormantRuns.values()) {
    if (dormant.agents === ownerAgents) continue;
    if ([...dormant.agents.values()].some((agent) => agent.info.conversationId === toConversationId)) return true;
  }
  return [...ownerAgents.values()].some(
    (agent) => agent.info.id !== PRIME_ID && agent.info.conversationId === toConversationId
  );
}

/**
 * A stopped-but-reusable worker in dormant history is still a worker conversation, not an
 * ordinary chat. Kernel integration uses this to fail closed if that old tab unexpectedly calls
 * a local tool while another prime owns the single active execution slot.
 */
export function dormantWorkerNotice(conversationId: string | null | undefined): string | null {
  const found = dormantAgentForConversation(conversationId);
  const agent = found?.agent ?? null;
  if (!agent || agent.info.role !== 'worker') return null;
  if (isOver(agent.info.state)) {
    return (
      `WORKER_ENDED: ${agent.info.id} remains part of its prime's dormant worker history but is ${agent.info.state} and cannot act again. ` +
      'Nothing was run. Stop working and return to the prime conversation.'
    );
  }
  if (agent.info.state !== 'sleeping' || !agent.info.revivable) return null;
  return (
    `WORKER_SLEEPING: ${agent.info.id} belongs to the dormant worker history owned by its prime conversation. ` +
    'Nothing was run. Stay stopped until that prime sends a new agents message into this exact chat.'
  );
}

/**
 * Worker chats whose tabs the browser may close, oldest first.
 *
 * A worker that has stopped — asleep, finished or failed — holds no slot and needs no page:
 * a sleeping one is woken by opening its chat again, and a terminal one is never opened
 * again. Its tab is pure cost, and by the end of a long run that cost is the machine: on
 * 2026-09-01 thirteen workers left Chrome at thirty-four processes and five gigabytes with
 * the prime still working. So all but the `keep` most recently used stopped worker chats
 * are handed to the browser to close, across the active run and every parked family.
 * Recency is the last thing that happened to the worker, so a chat the prime keeps coming
 * back to stays open while ones it has moved on from go.
 */
export function closableWorkerConversations(keep: number): string[] {
  const stopped: Array<{ conversationId: string; usedAt: number }> = [];
  const families = run ? [run.agents, ...[...dormantRuns.values()].map((dormant) => dormant.agents)] : [...dormantRuns.values()].map((dormant) => dormant.agents);
  for (const agents of families) {
    for (const agent of agents.values()) {
      const info = agent.info;
      if (info.role !== 'worker' || !info.conversationId || unpublishedAgents.has(agent)) continue;
      if (info.state !== 'sleeping' && info.state !== 'finished' && info.state !== 'failed') continue;
      stopped.push({
        conversationId: info.conversationId,
        usedAt: Math.max(info.activatedAt ?? 0, info.sleptAt ?? 0, info.finishedAt ?? 0, info.lastSeenAt ?? 0)
      });
    }
  }
  stopped.sort((a, b) => a.usedAt - b.usedAt);
  const surplus = Math.max(0, stopped.length - Math.max(0, keep));
  return stopped.slice(0, surplus).map((entry) => entry.conversationId);
}

/** Any dormant worker conversation remains an identity fence, reusable or terminal. */
export function hasDormantWorkerLeases(): boolean {
  for (const dormant of dormantRuns.values()) {
    if (
      [...dormant.agents.values()].some(
        (agent) => agent.info.role === 'worker' && Boolean(agent.info.conversationId)
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Recovery-only repair for the one crash ordering normal transfer cannot represent.
 *
 * Compact & Resume durably moves session S from chat A to chat B before publishing the
 * in-memory swarm move. If the process dies between those two steps, restore intentionally
 * brings the swarm back without its volatile transfer flag, so {@link commitPrimeTransfer}
 * must (and does) refuse. Continuation recovery can nevertheless prove from its WAL plus the
 * durable session metadata that A→B already committed. This hook lets that recovery authority
 * repair the projection without inventing a new transfer.
 *
 * It is deliberately not a general takeover API and is never exposed to MCP. The caller must
 * already have durable proof of this exact A→B transition. We additionally fail closed if B is
 * bound to any worker in the restored run. Repeating the same proven repair is idempotent.
 */
export function repairPrimeConversationAfterRecovery(
  fromConversationId: string,
  toConversationId: string
): boolean {
  if (!fromConversationId || !toConversationId || fromConversationId === toConversationId) return false;

  if (run) {
    const prime = run.agents.get(PRIME_ID);
    if (prime && run.primeConversationId === toConversationId && prime.info.conversationId === toConversationId) return true;
    if (prime && run.primeConversationId === fromConversationId && prime.info.conversationId === fromConversationId) {
      if (conversationOwnedOutside(run.agents, fromConversationId, toConversationId)) return false;
      run.primeConversationId = toConversationId;
      prime.info.conversationId = toConversationId;
      if (run.transfer?.from === fromConversationId) run.transfer = null;
      logInfo(
        `multi-agent: recovery repaired prime from conversation ${fromConversationId} to ${toConversationId} after durable session commit`
      );
      changed();
      return true;
    }
  }

  const already = dormantRunForPrime(toConversationId);
  if (already?.agents.get(PRIME_ID)?.info.conversationId === toConversationId) return true;
  const dormant = dormantRunForPrime(fromConversationId);
  const prime = dormant?.agents.get(PRIME_ID);
  if (!dormant || !prime || prime.info.conversationId !== fromConversationId) return false;
  if (conversationOwnedOutside(dormant.agents, fromConversationId, toConversationId)) return false;
  dormantRuns.delete(fromConversationId);
  dormant.primeConversationId = toConversationId;
  prime.info.conversationId = toConversationId;
  dormant.transfer = null;
  dormantRuns.set(toConversationId, dormant);
  logInfo(
    `multi-agent: recovery repaired dormant worker ownership from conversation ${fromConversationId} to ${toConversationId}`
  );
  changed();
  return true;
}

// -------------------------------------------------------------------- state

function stateForAgents(agents: Map<string, Agent>, running: boolean, retainedHistory = !running): SwarmState {
  const list = [...agents.values()]
    .filter((agent) => !unpublishedAgents.has(agent))
    .map((agent) => ({ ...agent.info }));
  list.sort((a, b) => (a.role === b.role ? a.id.localeCompare(b.id) : a.role === 'prime' ? -1 : 1));
  return {
    enabled: getConfig().multiAgent.enabled,
    running,
    retainedHistory,
    agents: list
  };
}

export function swarmState(): SwarmState {
  // Presentation follows publication, not merely in-memory planning. A stage exists so the
  // immediate writer can persist exactly what is about to be accepted; surfacing that plan in
  // status/UI before commit would tell a concurrent caller that workers exist even if the
  // acceptance barrier is about to fail and roll them back.
  const visibleRun = run && unpublishedRun !== run ? run : null;
  return visibleRun
    ? stateForAgents(visibleRun.agents, true, dormantRuns.size > 0)
    : {
        enabled: getConfig().multiAgent.enabled,
        running: false,
        retainedHistory: dormantRuns.size > 0,
        agents: []
      };
}

export function agentConversation(id: string): string | null {
  return run?.agents.get(id)?.info.conversationId ?? null;
}

/** Reverse lookup used to file a recorded event into the right session. */
export function agentForConversation(conversationId: string): string | null {
  if (!run) return null;
  if (conversationId === run.primeConversationId) return PRIME_ID;
  for (const agent of run.agents.values()) {
    if (agent.info.conversationId === conversationId) return agent.info.id;
  }
  return null;
}

/**
 * Exact conversation ownership for durable recording/presentation, active or dormant.
 *
 * This deliberately does not reactivate anything and is not a command-authority lookup. A
 * sleeping/terminal worker keeps the same recorder identity after its active run parks, while
 * independently durable browser commands continue to use {@link agentForConversation} plus the
 * current run-id fence so old transport rows can never attach to dormant history.
 */
export function agentForOwnedConversation(conversationId: string): string | null {
  return agentInfoForOwnedConversation(conversationId)?.id ?? null;
}

/** Read-only exact owner metadata for recorder/origin reconstruction across parked histories. */
export function agentInfoForOwnedConversation(conversationId: string): AgentInfo | null {
  if (run) {
    const active = agentForConversationId(conversationId);
    if (active) return { ...active.info };
  }
  const dormant = dormantAgentForConversation(conversationId)?.agent ?? null;
  return dormant ? { ...dormant.info } : null;
}

/**
 * Whether this conversation is a worker chat this app opened — in any state, ever.
 *
 * The owner lookups above answer "who is working here", and deliberately skip a worker that
 * is over: a finished chat calling tools is not a slot. This answers the other question, the
 * one the Goal and compaction fences ask: is this a chat the loop may author in, or that a
 * Compact & Resume may be typed into? A worker chat never becomes an ordinary chat by
 * finishing. On 2026-09-03 two workers crossed the context ceiling, went terminal, and were
 * from that moment invisible to `agentForOwnedConversation()`; the auto-compaction fence read
 * them as plain chats over the line, filed tickets a worker page can never discharge, and
 * reloaded each working page five times before giving up.
 */
export function isWorkerConversation(conversationId: string): boolean {
  if (!conversationId) return false;
  const owns = (agents: Map<string, Agent>): boolean =>
    [...agents.values()].some((agent) => agent.info.role === 'worker' && agent.info.conversationId === conversationId);
  if (run && owns(run.agents)) return true;
  for (const dormant of dormantRuns.values()) if (owns(dormant.agents)) return true;
  return false;
}

/**
 * Binds a worker to the ChatGPT conversation it is running in, and starts it.
 *
 * This *is* the worker lifecycle transition. Called by the bridge when the extension
 * acknowledges the tab it opened — the one party that knows the mapping first-hand, and knows
 * it before the model in that tab has said anything — so by the time the worker reads its task
 * it is already an active member of the run and its later calls route by conversation alone.
 * Nothing is asked of the model to make that true.
 *
 * It can never move the prime: that binding is set once by `spawn` and moved only by an
 * authenticated transfer. It can never move a worker either — see
 * {@link bindWorkerConversation} for why one binding per slot and one slot per conversation
 * is an invariant rather than a preference.
 */
export function bindConversation(id: string, conversationId: string): boolean {
  const agent = run?.agents.get(id);
  if (!agent || agent.info.role !== 'worker' || hasStopped(agent.info.state)) return false;
  return activateWorker(agent, conversationId);
}

/**
 * Binds a worker to its conversation and makes it active, in one indivisible step.
 *
 * One step on purpose. A slot that is bound but not yet active is a state nothing can act
 * on and everything has to special-case: the bridge cannot tell whether its bootstrap
 * succeeded, `pendingWorkerSpawns` still owes it a tab, and the prime waits on a worker that
 * is, in every sense that matters, already running. Activation on binding is what makes
 * "the app opened this chat for this slot" and "this worker is running" the same fact.
 */
function activateWorker(agent: Agent, conversationId: string): boolean {
  const wasBound = agent.info.conversationId !== null;
  if (!bindWorkerConversation(agent, conversationId)) return false;
  let mutated = !wasBound;
  if (agent.info.state === 'invited') {
    agent.info.state = 'active';
    agent.info.activatedAt = Date.now();
    logInfo(`multi-agent: ${agent.info.id} is active in conversation ${conversationId}`);
    mutated = true;
  }
  // Binding and activation are one durable state transition. Persisting from
  // bindWorkerConversation used to expose an impossible intermediate snapshot — a worker with
  // a conversation while still `invited`. A crash after that first snapshot made restart open
  // a second tab for the already-bound worker and then fail the slot when the new chat could
  // not steal its binding.
  if (mutated) changed();
  return true;
}

/**
 * The one place a worker's conversation is ever set. Exactly once, and to a free chat.
 *
 * Two invariants, both load-bearing for identity:
 *
 *   *One binding per slot.* A worker already running in a conversation stays there. Every
 *   later report of a different chat is either a mistake or someone else's tab, and honouring
 *   it would point the worker's messages, its recorded events and its workspace at a chat
 *   that is not doing the work — while the chat that *is* doing it stops being recognised at
 *   all. A binding is only re-set to the identical value, which is a no-op.
 *
 *   *One slot per conversation.* A conversation already holding the prime or another live
 *   worker cannot be bound again, or one chat would answer to two identities and
 *   {@link agentForConversation} would file its work under whichever it found first.
 *
 * The second check counts finished workers too. Their chats are tombstones: still readable,
 * never re-usable, and a new worker inheriting one would make the transcript of a worker that
 * is over look like the transcript of the one that replaced it.
 */
function bindWorkerConversation(agent: Agent, conversationId: string): boolean {
  if (!conversationId) return false;
  if (agent.info.conversationId === conversationId) return true;
  if (agent.info.conversationId) {
    logWarn(
      `multi-agent: refused to move ${agent.info.id} from conversation ${agent.info.conversationId} to ${conversationId}`
    );
    return false;
  }
  const taken = run ? agentForConversation(conversationId) : null;
  if (taken && taken !== agent.info.id) {
    logWarn(`multi-agent: refused to bind ${agent.info.id} to conversation ${conversationId}, already held by ${taken}`);
    return false;
  }
  const dormantTaken = dormantAgentForConversation(conversationId);
  if (dormantTaken) {
    logWarn(
      `multi-agent: refused to bind ${agent.info.id} to conversation ${conversationId}, already owned by dormant ${dormantTaken.agent.info.id}`
    );
    return false;
  }
  agent.info.conversationId = conversationId;
  return true;
}

/** Explicit destructive clear. Feature-off uses pauseSwarmForDisable() and preserves histories. */
export function resetSwarm(): void {
  const reason = 'the run was cleared in the app';
  endRun(reason);
  consecutiveWakeFailures.clear();
  const retiredAt = Date.now();
  let retiredDormant = false;
  for (const dormant of dormantRuns.values()) {
    for (const agent of dormant.agents.values()) {
      if (agent.info.role !== 'worker' || !agent.info.conversationId) continue;
      retiredWorkers.set(agent.info.conversationId, {
        id: agent.info.id,
        conversationId: agent.info.conversationId,
        reason,
        retiredAt
      });
      retiredDormant = true;
    }
  }
  dormantRuns.clear();
  if (retiredDormant) retiredPersist?.();
  changed();
}

/**
 * Turns live multi-agent execution off without deleting the prime-owned worker histories.
 *
 * A feature toggle is not the destructive "Clear swarm" action. Bound workers become stopped
 * but reusable (or terminal if their exact chat is already full); a bootstrap that never got a
 * conversation becomes a terminal historical row. The whole owner map then parks normally, so
 * stale worker tabs remain fenced while the feature is off and the same exact chats can be
 * resumed after re-enable/restart.
 *
 * An unpublished spawn has not been accepted/launched yet, so cancel that topology transaction
 * first rather than preserving rows ChatGPT was never told existed.
 */
export function pauseSwarmForDisable(reason = 'multi-agent mode was turned off'): boolean {
  const spawnStage = activeSpawnStage;
  if (spawnStage?.run === run) settleSpawnStage(spawnStage, false);
  if (!run) {
    changed();
    return false;
  }

  const now = Date.now();
  for (const agent of run.agents.values()) {
    if (agent.info.role !== 'worker' || hasStopped(agent.info.state)) continue;
    if (!agent.info.conversationId) {
      agent.info.state = 'failed';
      agent.info.finishedAt = now;
      agent.info.sleptAt = null;
      agent.info.detachedAt = null;
      agent.info.revivable = false;
      agent.info.result = reason.slice(0, MAX_MESSAGE_CHARS);
      agent.queue = [];
      recount(agent);
      continue;
    }

    const terminal = ceilingCrossed(agent.info);
    agent.info.state = terminal ? 'finished' : 'sleeping';
    agent.info.sleptAt = now;
    agent.info.finishedAt = terminal ? now : null;
    agent.info.detachedAt = null;
    agent.info.revivable = !terminal;
    recount(agent);
  }

  return parkRun(reason);
}

/** What a clear actually did, so the UI can say it rather than guess. */
export interface ClearResult {
  cleared: 'run' | 'worker' | 'none';
  report: AgentMessage | null;
  reason: string;
}

/**
 * The user clearing one row in the app.
 *
 * The prime *is* the run, so clearing it ends everything — there is no such thing as a run
 * whose prime was removed but whose workers continue. A worker is one slot: it is
 * terminalised, never deleted, so the row stays visible and honestly labelled as over while
 * its queued bootstrap is retired and the slot frees up.
 */
export function clearAgent(id: string): ClearResult {
  if (id === PRIME_ID) {
    if (!run) return { cleared: 'none', report: null, reason: 'there is no run to clear' };
    // Row-level clear is scoped to the active owner the row belongs to. `resetSwarm()` is the
    // explicit global "Clear swarm" operation and intentionally destroys every dormant owner
    // history too; using it here would let clearing Prime B's visible row erase parked Prime A
    // workers that are not even present in this renderer list.
    const reason = 'the run was cleared in the app';
    endRun(reason);
    changed();
    return { cleared: 'run', report: null, reason };
  }
  const agent = run?.agents.get(id);
  if (!agent) return { cleared: 'none', report: null, reason: `${id} is not part of this run` };
  if (isOver(agent.info.state)) return { cleared: 'none', report: null, reason: `${id} has already ended` };
  // Clearing a sleeping worker is the user saying they are done with that chat for good. It is
  // still a terminalisation, so it goes through failAgent like any other; what makes it worth
  // saying separately is that the row was not costing the run a slot.

  const reason = 'the user cleared this worker in the app';
  const outcome = failAgent(
    id,
    reason,
    `[${id} cleared] The user ended this worker from the app. It will not report and cannot be messaged. Carry on ` +
      'without it, or spawn a replacement worker if the work still needs doing.'
  );
  return { cleared: 'worker', report: outcome?.report ?? null, reason };
}

// -------------------------------------------------------------- persistence

export interface RetiredWorkersSnapshot {
  version: 1;
  savedAt: number;
  workers: RetiredChat[];
}

export function snapshotRetiredWorkers(): RetiredWorkersSnapshot {
  pruneRetiredWorkers();
  return { version: 1, savedAt: Date.now(), workers: [...retiredWorkers.values()].map((worker) => ({ ...worker })) };
}

export function restoreRetiredWorkers(snapshot: RetiredWorkersSnapshot | null): void {
  retiredWorkers.clear();
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.workers)) return;
  const cutoff = Date.now() - RETIRED_WORKER_TTL_MS;
  // Every still-live lease is authority state. The old `slice(-64)` matched the previous
  // lifetime worker-id ceiling, but histories are now intentionally unbounded; after explicit
  // clear a long-lived prime can retire more than 64 worker conversations at once. Dropping the
  // oldest rows on restart would let those still-open worker chats become ordinary callers.
  for (const worker of snapshot.workers) {
    if (
      !worker ||
      typeof worker.id !== 'string' ||
      typeof worker.conversationId !== 'string' ||
      !worker.conversationId ||
      typeof worker.reason !== 'string' ||
      !Number.isFinite(worker.retiredAt) ||
      worker.retiredAt < cutoff
    ) {
      continue;
    }
    retiredWorkers.set(worker.conversationId, { ...worker });
  }
}

/**
 * What survives a restart.
 *
 * Agent state and unacknowledged messages are the parts that cannot be reconstructed: the
 * session log is the audit trail, but it does not know which messages were still in flight.
 * Nothing here is a credential: an agent is the conversation it runs in, and that id is
 * recorded on purpose.
 */
interface SerializedAgent {
  info: AgentInfo;
  queue: AgentMessage[];
}

interface DormantRunSnapshot {
  primeConversationId: string;
  startedAt: number;
  parkedAt: number;
  agents: SerializedAgent[];
}

export interface SwarmSnapshot {
  /**
   * 5 = one optional active incarnation plus every durable dormant prime-owned history.
   * Version 4 is accepted on restore and migrated as a single active incarnation; versions
   * before 4 are discarded because their worker identity depended on routing codes this build
   * cannot honour.
   */
  version: 4 | 5;
  savedAt: number;
  /** Top-level fields are the active incarnation; all are null/empty while only history remains. */
  runId: string | null;
  primeConversationId: string | null;
  startedAt: number | null;
  agents: SerializedAgent[];
  dormantRuns?: DormantRunSnapshot[];
}

export function snapshotSwarm(): SwarmSnapshot | null {
  return buildSwarmSnapshot(false);
}

/**
 * Snapshot used only by the explicit critical acceptance barrier.
 *
 * A staged agent message has to be present in exactly the generation whose successful
 * immediate write publishes acceptance. It must be absent from every ordinary/debounced
 * generation, because those can reach disk before the immediate writer succeeds. Keeping
 * this helper private makes that distinction structural rather than a convention callers can
 * accidentally bypass.
 */
function snapshotSwarmIncludingUnpublished(): SwarmSnapshot | null {
  return buildSwarmSnapshot(true);
}

function buildSwarmSnapshot(includeUnpublished: boolean): SwarmSnapshot | null {
  const active = run && (includeUnpublished || unpublishedRun !== run) ? run : null;
  const dormant = [...dormantRuns.values()];
  if (!active && dormant.length === 0) return null;
  return {
    version: 5,
    savedAt: Date.now(),
    runId: active?.runId ?? null,
    primeConversationId: active?.primeConversationId ?? null,
    startedAt: active?.startedAt ?? null,
    agents: active ? serializeAgents(active.agents, includeUnpublished) : [],
    dormantRuns: dormant.map((history) => ({
      primeConversationId: history.primeConversationId,
      startedAt: history.startedAt,
      parkedAt: history.parkedAt,
      // Critical acceptance can race with feature-toggle parking. Staged finishes/messages still
      // belong to this exact agent map after it moves from `run` to dormant history, so the
      // immediate snapshot must carry them; ordinary/debounced snapshots must still hide them.
      agents: serializeAgents(history.agents, includeUnpublished)
    }))
  };
}

function serializeAgents(agents: Map<string, Agent>, includeUnpublished: boolean): SerializedAgent[] {
  const stagedFinishes =
    includeUnpublished
      ? [...activeFinishStages.values()].filter((stage) => !stage.settled && stage.run.agents === agents)
      : [];
  return [...agents.values()]
    .filter((agent) => includeUnpublished || !unpublishedAgents.has(agent))
    .map((agent) => {
      const finish = includeUnpublished ? activeFinishStages.get(agent) : undefined;
      const info =
        finish && !finish.settled && finish.run.agents === agents
          ? {
              ...agent.info,
              state: finish.info.state,
              finishedAt: finish.info.finishedAt,
              sleptAt: finish.info.sleptAt,
              result: finish.info.result,
              revivable: finish.info.revivable
            }
          : { ...agent.info };
      const finishAcknowledged =
        includeUnpublished && finish && !finish.settled && finish.run.agents === agents
          ? new Set(finish.acknowledgedMessageIds)
          : null;
      if (finishAcknowledged && finishAcknowledged.size > 0) {
        const newlyDelivered = agent.queue.filter(
          (message) => message.ackedAt === null && finishAcknowledged.has(message.id)
        ).length;
        info.delivered += newlyDelivered;
      }
      const queue = agent.queue
        .filter(
          (message) =>
            message.ackedAt === null &&
            (!finishAcknowledged || !finishAcknowledged.has(message.id)) &&
            (includeUnpublished || !unpublishedMessages.has(message))
        )
        .map((message) => ({ ...message }));
      if (finishAcknowledged) {
        info.pending = queue.length;
        info.awaitingAck = queue.filter((message) => message.offeredAt !== null).length;
      }
      if (includeUnpublished && agent.info.id === PRIME_ID) {
        queue.push(...stagedFinishes.map((stage) => ({ ...stage.report })));
      }
      return { info, queue };
    });
}

/**
 * Restores a run from disk.
 *
 * Messages that were in an ordinary MCP result come back unoffered rather than delivered: the
 * app cannot know whether that result ever arrived, and offering one twice is the recoverable
 * half of that uncertainty. A browser revival is different: its `sent` ACK proves ChatGPT
 * accepted the prime's words as a real user message, so that row keeps its offer marker and is
 * acknowledgement-only after restart. An open transfer is deliberately not restored — a
 * handover interrupted by a restart is abandoned, and the prime stays where it was.
 */
export function restoreSwarm(snapshot: SwarmSnapshot | null): void {
  run = null;
  dormantRuns.clear();
  unpublishedRun = null;
  activeSpawnStage = null;
  activeFinishStages.clear();
  criticalMutationRevision = 0;
  persistedCriticalRevision = 0;
  criticalPersistFlight = null;
  if (!snapshot || !Array.isArray(snapshot.agents)) return;
  if (snapshot.version !== 4 && snapshot.version !== 5) {
    logInfo('multi-agent: discarded a run saved by an older build — spawn again to start a new one.');
    return;
  }
  let repaired = false;
  const occupiedConversations = new Set<string>();

  const acceptOwner = (primeConversationId: string, agents: Map<string, Agent>): boolean => {
    const prime = agents.get(PRIME_ID);
    if (!prime || prime.info.role !== 'prime' || prime.info.conversationId !== primeConversationId) return false;
    const local = new Set<string>([primeConversationId]);
    for (const agent of agents.values()) {
      if (agent.info.id === PRIME_ID || !agent.info.conversationId) continue;
      if (local.has(agent.info.conversationId) || occupiedConversations.has(agent.info.conversationId)) return false;
      local.add(agent.info.conversationId);
    }
    if (occupiedConversations.has(primeConversationId)) return false;
    for (const conversationId of local) occupiedConversations.add(conversationId);
    return true;
  };

  if (snapshot.version === 5 && Array.isArray(snapshot.dormantRuns)) {
    for (const saved of snapshot.dormantRuns) {
      if (!saved || typeof saved.primeConversationId !== 'string' || !saved.primeConversationId || !Array.isArray(saved.agents)) {
        repaired = true;
        continue;
      }
      const restored = deserializeAgents(saved.agents, snapshot.savedAt);
      repaired ||= restored.repaired;
      // A dormant history can never contain a slot-holder. If disk says otherwise, choosing to
      // run it beside another owner or silently sleeping live work would both be guesses.
      if ([...restored.agents.values()].some((agent) => agent.info.role === 'worker' && occupiesSlot(agent.info.state))) {
        repaired = true;
        logWarn(`multi-agent: discarded invalid dormant history for ${saved.primeConversationId} with a live worker`);
        continue;
      }
      if (!acceptOwner(saved.primeConversationId, restored.agents)) {
        repaired = true;
        logWarn(`multi-agent: discarded conflicting dormant history for ${saved.primeConversationId}`);
        continue;
      }
      dormantRuns.set(saved.primeConversationId, {
        primeConversationId: saved.primeConversationId,
        startedAt: Number.isFinite(saved.startedAt) ? saved.startedAt : snapshot.savedAt || Date.now(),
        parkedAt: Number.isFinite(saved.parkedAt) ? saved.parkedAt : snapshot.savedAt || Date.now(),
        agents: restored.agents,
        transfer: null
      });
    }
    // Disk is the one place old history accumulates unchecked between parkings.
    if (pruneDormantRuns()) repaired = true;
  }

  const hasActive =
    typeof snapshot.primeConversationId === 'string' &&
    Boolean(snapshot.primeConversationId) &&
    typeof snapshot.runId === 'string' &&
    Boolean(snapshot.runId) &&
    Array.isArray(snapshot.agents);
  if (snapshot.version === 4 && !hasActive) {
    logInfo('multi-agent: discarded a version-4 run with no usable prime binding');
    return;
  }
  if (hasActive) {
    const primeConversationId = snapshot.primeConversationId as string;
    const restored = deserializeAgents(snapshot.agents, snapshot.savedAt);
    repaired ||= restored.repaired;
    if (!acceptOwner(primeConversationId, restored.agents)) {
      logWarn(`multi-agent: discarded active run for ${primeConversationId} because its conversation ownership conflicted`);
      repaired = true;
    } else {
      const restoredRunId =
        typeof snapshot.runId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(snapshot.runId)
          ? snapshot.runId
          : randomUUID();
      if (restoredRunId !== snapshot.runId) {
        repaired = true;
        logWarn('multi-agent: re-keyed a restored run whose legacy incarnation id was not a full UUID');
      }
      run = {
        runId: restoredRunId,
        primeConversationId,
        startedAt: Number.isFinite(snapshot.startedAt) ? (snapshot.startedAt as number) : snapshot.savedAt || Date.now(),
        agents: restored.agents,
        transfer: null,
        primeGoneAt: null
      };
    }
  }

  // This process has been watching for exactly no time. Every `lastSeenAt` that came back
  // from disk predates the restart and cannot be evidence of silence since it.
  livenessFloor = Date.now();

  // A crash can land after the final worker's sleeping snapshot but before the cheap parking
  // write. Reconstruct ownership first, then complete that lifecycle edge deterministically.
  const restoredActiveId = run?.runId ?? null;
  if (run && workingWorkers().length === 0) {
    parkRun('restart recovered an active incarnation with no slot-holding workers');
    repaired = true;
  } else if (repaired) {
    changed();
  }

  // A worker that was invited but whose chat was never bound needs it opened again. If the
  // bridge is not registered yet — at startup it is not, because the run is restored first —
  // this is replayed by onSpawnRequest the moment it registers.
  const stranded = pendingWorkerSpawns();
  if (stranded.length > 0 && spawnRequest) {
    spawnRequest(stranded);
    logInfo(`multi-agent: re-requested ${stranded.length} worker chat(s) that were unbound at the restart`);
  }
  const activeAgents = run ? [...run.agents.values()] : [];
  const pending = activeAgents.reduce((sum, agent) => sum + agent.info.pending, 0);
  logInfo(
    `multi-agent: restored ${restoredActiveId ? `active run ${restoredActiveId}` : 'no active run'} with ${dormantRuns.size} dormant owner histor${dormantRuns.size === 1 ? 'y' : 'ies'} and ${pending} active undelivered message(s)`
  );
}

function deserializeAgents(entries: readonly SerializedAgent[], savedAt: number): { agents: Map<string, Agent>; repaired: boolean } {
  const agents = new Map<string, Agent>();
  let repaired = false;
  for (const entry of entries) {
    if (!entry?.info?.id || agents.has(entry.info.id)) {
      repaired = true;
      continue;
    }
    const agent: Agent = {
      info: {
        ...entry.info,
        model: isModelSlug(entry.info.model) ? entry.info.model : null,
        sleptAt: typeof entry.info.sleptAt === 'number' ? entry.info.sleptAt : null,
        contextTokens: Number.isFinite(entry.info.contextTokens) ? entry.info.contextTokens : 0,
        lastRevivalCommandId:
          typeof entry.info.lastRevivalCommandId === 'string' && entry.info.lastRevivalCommandId
            ? entry.info.lastRevivalCommandId
            : null
      },
      queue: (Array.isArray(entry.queue) ? entry.queue : []).map((message) => ({
        ...message,
        offeredAt:
          message.offeredViaRevival === true && typeof message.offeredAt === 'number' && Number.isFinite(message.offeredAt)
            ? message.offeredAt
            : null,
        offeredOnFinish: message.offeredOnFinish ?? false,
        offeredViaRevival: message.offeredViaRevival === true
      }))
    };
    if (agent.info.role === 'worker') {
      if (agent.info.state === 'invited' && agent.info.conversationId) {
        agent.info.state = 'active';
        agent.info.activatedAt ??= savedAt || Date.now();
        agent.info.revivable = false;
        repaired = true;
        logWarn(`multi-agent: repaired restored ${agent.info.id} from bound/invited to active`);
      }
      if (agent.info.state === 'finished' && agent.info.revivable) {
        agent.info.revivable = false;
        repaired = true;
      }
      if (agent.info.state === 'waking' && !agent.info.conversationId) {
        agent.info.state = 'sleeping';
        agent.info.sleptAt ??= savedAt || Date.now();
        agent.info.revivable = false;
        repaired = true;
        logWarn(`multi-agent: restored ${agent.info.id} out of waking; it has no chat to be woken in`);
      }
      if (agent.info.state === 'sleeping' && (!agent.info.revivable || !agent.info.conversationId)) {
        agent.info.state = 'finished';
        agent.info.finishedAt ??= agent.info.sleptAt ?? (savedAt || Date.now());
        agent.info.revivable = false;
        repaired = true;
      }
    }
    recount(agent);
    agents.set(entry.info.id, agent);
  }
  return { agents, repaired };
}

/** Test seam: forgets everything without touching disk. */
export function resetAgentsForTests(): void {
  run = null;
  dormantRuns.clear();
  consecutiveWakeFailures.clear();
  unpublishedRun = null;
  activeSpawnStage = null;
  activeFinishStages.clear();
  retiredWorkers.clear();
  livenessFloor = 0;
  spawnRequest = null;
  reviveRequest = null;
  persist = null;
  persistNow = null;
  criticalMutationRevision = 0;
  persistedCriticalRevision = 0;
  criticalPersistFlight = null;
  retiredPersist = null;
  retiredPersistNow = null;
  listeners.clear();
  endListeners.clear();
}
