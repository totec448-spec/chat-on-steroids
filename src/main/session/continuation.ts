/**
 * The one-time transaction that moves a local session from one ChatGPT chat to another.
 *
 * Compact & Resume is not "summarise, then start again somewhere else". The local session is
 * the durable identity — its recorded history, its title, its workspace, its handoffs, and
 * the swarm it may be coordinating all belong to it — and chats A and B are only two ChatGPT
 * frontends attached to it in turn. So there is exactly one state-transfer mechanism here,
 * the rebind, and the handoff brief is *model context only*: it exists so the model in chat
 * B knows what was happening, not so the app can reconstruct anything from it.
 *
 * ## The transaction
 *
 *   open    — the user pressed the button. The prime binding is pinned so the run does not
 *             die when chat A goes away, and nothing else has changed yet.
 *   summary — ChatGPT's final answer for that exact compaction turn arrived and was stored
 *             as the handoff. Only now is there anything worth opening a chat for.
 *   claim   — one replacement chat, and only one, takes this continuation. A second claimant
 *             is refused rather than served, which is what stops two chats from both
 *             believing they are the continuation.
 *   commit  — chat B proved it exists and accepted the handoff, so the session moves.
 *   abort   — anything went wrong. The session stays attached to chat A, which is the
 *             failure mode every step is arranged around.
 *
 * ## Why commit cannot half-happen
 *
 * The commit is three phases, in this order and for this reason:
 *
 *   preflight — everything that could *decline* is asked before anything is written, and the
 *               answers are pinned. The swarm handover is the one that matters: it is frozen
 *               here, and a session that is a run's prime with no usable handover is refused
 *               outright rather than moved without its swarm.
 *   durable   — the session rebind, the only step that can fail. It stages the change, writes
 *               it atomically, and publishes it into memory only once the write has landed, so
 *               a failure leaves chat A attached in memory *and* on disk. On failure the
 *               preflight is undone: the freeze is released and the transaction is claimable
 *               again.
 *   publish   — the live recorder mapping, the workspace key, the swarm's prime binding. Pure
 *               in-memory map work, none of it able to throw or to change its mind, running
 *               only once the durable record already says chat B.
 *
 * So there is no window in which the session is in B while the workspace or the swarm is
 * still in A. The one thing the publish phase can still find missing is the run itself, if it
 * ended while the write was in flight — and a run that no longer exists has no prime left in
 * chat A to be inconsistent with.
 *
 * The state is flipped to `committing` *synchronously*, before the first await, so two
 * replacement chats racing to commit cannot both pass the check; the loser is refused and
 * the winner's failure restores the state for a retry. Nothing else may move the state
 * backwards out of `committing` — see {@link claimContinuationNow}, which is monotonic for
 * exactly that reason.
 */

import { randomBytes } from 'node:crypto';
import type { Handoff } from '../../shared/session.js';
import { estimateTokens } from '../../shared/session.js';
import { logInfo, logWarn } from '../logger.js';
import {
  PRIME_ID,
  agentForOwnedConversation,
  beginPrimeTransfer,
  cancelPrimeTransfer,
  commitPrimeTransfer,
  freezePrimeTransfer,
  thawPrimeTransfer
} from '../agents.js';
import { clearChatWorkspace, moveChatWorkspace, workspaceForChat } from '../workspace.js';
import { clearGoalObjective, clearGoalSwitch, goalObjectiveFor, goalSwitchFor, moveGoalObjective, moveGoalSwitch } from '../goal.js';
import { writeDurableNow, writeDurableSoon } from '../durable.js';
import { prepareHandoff, resumeBootstrapMatches } from './handoff.js';
import { ensureHandoffRecorded, recordHandoff, recordNote, rebindConversation } from './recorder.js';
import { endResumeClaim, noteResumeClaim, resetResumeGate } from './resume-gate.js';
import {
  ensureCommittedResumeHandoff,
  findSessionByConversation,
  getSession,
  readEvents,
  readHandoff,
  rebindSession
} from './store.js';

/**
 * How long a continuation may stay open.
 *
 * Long enough for a slow generation plus a browser that has to be launched, short enough
 * that an abandoned one releases the prime binding and lets an unattended run end rather
 * than staying transferable indefinitely.
 */
export const CONTINUATION_TTL_MS = 10 * 60_000;

/**
 * How long an automatic handover may run once it has actually been asked for.
 *
 * An auto-compaction ticket has no clock while it is only intended: the chat may be mid-turn
 * for hours before it is safe to ask for the brief. But from the moment the brief request is
 * on its way, the source chat is refused every tool until the handover lands in the new chat,
 * so a handover the model never finishes must not fence that chat for good. Six hours is far
 * beyond any real handover (the one on 2026-09-01 took eleven minutes) and short enough that
 * the chat gets its tools back the same day; its next working turn opens a fresh ticket.
 */
export const AUTOMATIC_HANDOVER_TTL_MS = 6 * 60 * 60_000;

export type ContinuationState =
  /** Waiting for ChatGPT's final answer to the compaction turn. */
  | 'awaiting-summary'
  /** The brief is stored; waiting for a replacement chat to claim it. */
  | 'awaiting-chat'
  /** A replacement chat has claimed it and is being opened. */
  | 'claimed'
  /** The rebind is in flight. Set synchronously so two commits cannot race. */
  | 'committing'
  | 'committed'
  | 'aborted';

/**
 * The four durable positions of one prompt, in order.
 *
 * The pair in the middle is the whole point. `attempted-unresolved` is written *before* anything
 * touches the composer's Send, so it is a proof that nothing was dispatched — a document that
 * dies here left no request behind, and the claim can be handed on. `dispatched-unresolved` is
 * written *before the click* and therefore means the opposite: this may or may not have reached
 * ChatGPT, and nothing local can tell which, because the click happens first and the acceptance
 * evidence arrives seconds later. That one is never replayed.
 */
export type ContinuationSendState =
  | 'not-attempted'
  | 'attempted-unresolved'
  | 'dispatched-unresolved'
  | 'sent';

export interface ContinuationSendCheckpoint {
  state: ContinuationSendState;
  /** ChatGPT's stable server-authored user-message id, once the marked prompt is visible. */
  messageId: string | null;
}

export interface ContinuationDestinationCheckpoint extends ContinuationSendCheckpoint {
  /** Chat B, learned from the page that contains the marked bootstrap message. */
  conversationId: string | null;
}

/**
 * True while the fence still proves no prompt was submitted, so the prompt may be handed to
 * another document. Both states it covers are written before a composer is submitted; every
 * question of the form "may this text be typed again?" is this question.
 */
export const sendUnattempted = (checkpoint: ContinuationSendCheckpoint): boolean =>
  checkpoint.state === 'not-attempted' || checkpoint.state === 'attempted-unresolved';

interface Continuation {
  token: string;
  sessionId: string;
  /** Chat A: where the session is attached until the commit lands. */
  from: string;
  openedAt: number;
  touchedAt: number;
  /** Last touch already queued for durable persistence. */
  lastTouchPersistedAt: number;
  /** Auto-compaction ticket: survives page/retry clocks until commit or explicit Off/cancel. */
  automatic: boolean;
  /** When the brief request first went on its way; the automatic clock starts here. */
  askedAt: number | null;
  state: ContinuationState;
  /** The brief, once captured. Handed to whoever opens chat B, and to nothing else. */
  summary: string;
  handoffId: string | null;
  /**
   * The capture in flight, or the settled one. The single-flight lock for {@link attachSummary}.
   */
  capture: Promise<Handoff> | null;
  /**
   * The stored handoff, kept so a repeated capture can be answered with the same success.
   *
   * The connector loses tool results. If the capture's answer never arrives and the page
   * reports the same finished generation again, "null" would read as a failure and start
   * another flow; handing back the handoff that already exists is both true and idempotent.
   */
  handoff: Handoff | null;
  /** Whoever claimed it, so a second claimant is recognised as one. */
  claimedBy: string | null;
  /** Chat B while the durable commit is in flight; persisted for restart recovery. */
  to: string | null;
  sourceSend: ContinuationSendCheckpoint;
  destinationSend: ContinuationDestinationCheckpoint;
  error: string | null;
}

/** At most one continuation per session, and at most one open per prime chat. */
const byToken = new Map<string, Continuation>();
const openingBySession = new Map<string, Promise<ContinuationView>>();
const commitLocks = new Map<string, { to: string; promise: Promise<ContinuationCommitResult> }>();
const checkpointLocks = new Map<string, Promise<unknown>>();
export const CONTINUATIONS_STATE = 'continuations';
const RESUME_SHADOW_COLLISION = 'the replacement chat already belongs to another local session';

interface ContinuationRecord {
  token: string;
  sessionId: string;
  from: string;
  to: string | null;
  openedAt: number;
  /** Added after v2.0.2; absent in older durable snapshots. */
  touchedAt?: number;
  /** Absent in records written before durable auto-compaction tickets existed. */
  automatic?: boolean;
  /** Absent in records written before automatic handovers had a deadline. */
  askedAt?: number | null;
  state: ContinuationState;
  summary: string;
  handoffId: string | null;
  claimedBy: string | null;
  /** Legacy only: the pre-checkpoint arm flag, read when migrating an older record. */
  armed?: boolean;
  /** Absent only in a record written before the checkpoints existed. */
  sourceSend?: ContinuationSendCheckpoint;
  destinationSend?: ContinuationDestinationCheckpoint;
  error: string | null;
}

export interface ContinuationSnapshot {
  version: 1;
  savedAt: number;
  entries: ContinuationRecord[];
}

function durableRecord(entry: Continuation): ContinuationRecord {
  return {
    token: entry.token,
    sessionId: entry.sessionId,
    from: entry.from,
    to: entry.to,
    openedAt: entry.openedAt,
    touchedAt: entry.touchedAt,
    automatic: entry.automatic,
    askedAt: entry.askedAt,
    state: entry.state,
    summary: entry.summary.slice(0, 512 * 1024),
    handoffId: entry.handoffId,
    claimedBy: entry.claimedBy,
    sourceSend: { ...entry.sourceSend },
    destinationSend: { ...entry.destinationSend },
    error: entry.error
  };
}

function snapshotWith(token?: string, replacement?: ContinuationRecord): ContinuationSnapshot {
  let replaced = false;
  const entries = [...byToken.values()].map((entry) => {
    if (entry.token === token && replacement) {
      replaced = true;
      return replacement;
    }
    return durableRecord(entry);
  });
  if (replacement && token && !replaced) entries.push(replacement);
  return {
    version: 1,
    savedAt: Date.now(),
    entries
  };
}

export function snapshotContinuations(): ContinuationSnapshot {
  return snapshotWith();
}

function changed(): void {
  writeDurableSoon(CONTINUATIONS_STATE, snapshotContinuations());
}

async function changedNow(): Promise<void> {
  await writeDurableNow(CONTINUATIONS_STATE, snapshotContinuations());
}

function publishRecord(entry: Continuation, record: ContinuationRecord): void {
  // Terminal either way, so nothing is still opening a chat for this transaction. The gate
  // self-expires regardless; releasing it here just stops an unrelated brand-new chat from
  // waiting out a window that is already over.
  if (record.state === 'committed' || record.state === 'aborted') endResumeClaim(entry.token);
  entry.to = record.to;
  const touchedAt = record.touchedAt ?? record.openedAt;
  entry.touchedAt = touchedAt;
  entry.lastTouchPersistedAt = Math.max(entry.lastTouchPersistedAt, touchedAt);
  entry.automatic = record.automatic === true;
  entry.askedAt = record.askedAt ?? null;
  entry.state = record.state;
  entry.summary = record.summary;
  entry.handoffId = record.handoffId;
  entry.claimedBy = record.claimedBy;
  // A record written before the checkpoints existed has neither; restoreContinuations
  // migrates those from the retired `armed` flag before any of them reach a transition.
  entry.sourceSend = record.sourceSend
    ? { ...record.sourceSend }
    : { state: 'not-attempted', messageId: null };
  entry.destinationSend = record.destinationSend
    ? { ...record.destinationSend }
    : { state: 'not-attempted', conversationId: null, messageId: null };
  entry.error = record.error;
  if (entry.askedAt === null && handoffAsked(entry)) {
    entry.askedAt = typeof record.askedAt === 'number' && Number.isFinite(record.askedAt) ? record.askedAt : Date.now();
  }
}

async function transitionNow(
  entry: Continuation,
  derive: (current: ContinuationRecord) => ContinuationRecord
): Promise<ContinuationRecord> {
  const current = durableRecord(entry);
  const next = derive(current);
  // Semantic forward progress renews the waiting lease too.
  next.touchedAt = Date.now();
  try {
    // Persist the proposed semantic state before publishing it into the live transaction.
    // If the durable boundary rejects, callers still see the previous state and can retry or
    // abort safely instead of inheriting a half-published `committing`/handoff transition.
    await writeDurableNow(CONTINUATIONS_STATE, snapshotWith(entry.token, next));
  } catch (err) {
    // writeDurableNow deliberately preserves a failed generation for retry. This staged
    // transaction rejected that generation, so supersede it with the still-authoritative
    // current snapshot before a background retry can publish a transition we never accepted.
    writeDurableSoon(CONTINUATIONS_STATE, snapshotContinuations());
    throw err;
  }
  publishRecord(entry, next);
  return next;
}

export type ContinuationCommitResult =
  | { status: 'committed'; conversationId: string }
  | { status: 'already-committed'; conversationId: string }
  | { status: 'retryable'; reason: string }
  | { status: 'rejected'; reason: string };

export interface ContinuationRecoveryHooks {
  /**
   * Recovery-only repair after the durable session already proves A→B landed. Normal commits
   * still use the frozen transfer guard. Prime wires this to the broker's WAL-authorised
   * repair hook; ordinary callers must never receive a model-callable adoption path.
   */
  repairPrimeTransfer?: (fromConversationId: string, toConversationId: string) => boolean;
}

let recoveryHooks: ContinuationRecoveryHooks = {};

export function setContinuationRecoveryHooks(hooks: ContinuationRecoveryHooks): void {
  recoveryHooks = { ...hooks };
}

export interface ContinuationView {
  token: string;
  sessionId: string;
  from: string;
  to: string | null;
  state: ContinuationState;
  handoffId: string | null;
  error: string | null;
  openedAt: number;
  automatic: boolean;
  /** When the brief request first went on its way, or null while it has not. */
  askedAt: number | null;
  sourceSend: ContinuationSendCheckpoint;
  destinationSend: ContinuationDestinationCheckpoint;
}

const view = (entry: Continuation): ContinuationView => ({
  token: entry.token,
  sessionId: entry.sessionId,
  from: entry.from,
  to: entry.to,
  state: entry.state,
  handoffId: entry.handoffId,
  error: entry.error,
  openedAt: entry.openedAt,
  automatic: entry.automatic,
  askedAt: entry.askedAt,
  sourceSend: { ...entry.sourceSend },
  destinationSend: { ...entry.destinationSend }
});

/** Whether the brief has been asked for: the request is on its way, went out, or was answered. */
const handoffAsked = (entry: Continuation): boolean =>
  entry.state !== 'awaiting-summary' ||
  entry.sourceSend.state === 'dispatched-unresolved' ||
  entry.sourceSend.state === 'sent';

/**
 * Whether a nonterminal continuation has outlived its wait. A manual one gets
 * CONTINUATION_TTL_MS from opening; an automatic one has no clock until it is asked for and
 * AUTOMATIC_HANDOVER_TTL_MS from then.
 */
// The manual clock reads touchedAt, not openedAt: an entry with recent activity should not
// expire out from under it merely because it was opened a while ago. The automatic clock
// deliberately does not — see the `automatic` field's own comment — so it alone reads askedAt.
const expired = (entry: Continuation, now = Date.now()): boolean =>
  entry.automatic
    ? entry.askedAt !== null && now - entry.askedAt >= AUTOMATIC_HANDOVER_TTL_MS
    : now - entry.touchedAt >= CONTINUATION_TTL_MS;

const isOpen = (entry: Continuation): boolean =>
  entry.state !== 'committed' && entry.state !== 'aborted' && !expired(entry);

function sweep(): void {
  for (const entry of [...byToken.values()]) {
    // A commit in flight is never swept. It holds a frozen prime handover and an in-flight
    // durable write, and expiring it here would let any passing lookup abort a transaction
    // that is about to land — the write would still complete, on a transaction that had been
    // declared dead and had released the very handover it was carrying. The deadline applies
    // to *waiting*, and once the durable phase starts there is nothing left to wait for.
    if (entry.state === 'committing') continue;
    if (entry.state === 'committed' || entry.state === 'aborted') {
      // Kept briefly so a repeated ack can be answered with "already done" rather than with
      // a fresh transaction, then forgotten. Measured from when it settled (touchedAt, which
      // every transition including this terminal one renews), not from when it opened - a
      // days-old automatic ticket that finally aborts must still get its own retention window,
      // not inherit however little of one its age already used up.
      if (Date.now() - entry.touchedAt > CONTINUATION_TTL_MS * 2) byToken.delete(entry.token);
      continue;
    }
    if (expired(entry)) {
      abortContinuation(
        entry.token,
        entry.automatic ? 'the handover never landed and was given up on' : 'it took too long and was given up on'
      );
    }
  }
}

/** The open continuation for a session, if there is one. */
export function continuationForSession(sessionId: string): ContinuationView | null {
  sweep();
  for (const entry of byToken.values()) {
    if (entry.sessionId === sessionId && isOpen(entry)) return view(entry);
  }
  return null;
}

export function continuationByToken(token: string): ContinuationView | null {
  sweep();
  const entry = byToken.get(token);
  return entry ? view(entry) : null;
}

/**
 * Renews only an exact, already-armed handoff generation that is still actively reporting
 * from the browser. A stale token cannot resurrect itself after a full TTL of silence.
 *
 * "Armed" here is the retired boolean's meaning, not the field: the brief request has actually
 * gone out, which `handoffAsked` already answers from the checkpoint that replaced it.
 */
export function touchContinuation(token: string, sessionId: string, conversationId: string): boolean {
  const entry = byToken.get(token);
  if (
    !entry ||
    entry.sessionId !== sessionId ||
    entry.from !== conversationId ||
    entry.state !== 'awaiting-summary' ||
    !handoffAsked(entry)
  ) return false;

  const now = Date.now();
  if (now - entry.touchedAt >= CONTINUATION_TTL_MS) return false;
  entry.touchedAt = now;
  // Polling is frequent; persist at most twice a minute. The last durable touch remains
  // comfortably inside the ten-minute expiry window if the app crashes between writes.
  if (now - entry.lastTouchPersistedAt >= 30_000) {
    entry.lastTouchPersistedAt = now;
    changed();
  }
  return true;
}

/**
 * The continuation that has already asked this chat for its handoff brief, if there is one.
 *
 * From the moment the marked prompt is submitted until the durable commit lands, whatever
 * chat A does is history the brief cannot describe — the brief is being written, or is
 * written — so the kernel refuses A's local tool calls while this returns non-null, and after
 * the commit the store's `superseded` attachment takes over that refusal for good. A filed
 * ticket whose prompt has not been submitted yet does not count: the page may still be
 * stopping the turn or draining local calls, and an automatic ticket that could not proceed
 * waits on the WAL for its next pickup with the chat working normally in between.
 */
export function compactingConversation(conversationId: string | null | undefined): ContinuationView | null {
  if (!conversationId) return null;
  sweep();
  for (const entry of byToken.values()) {
    if (entry.from !== conversationId || !isOpen(entry)) continue;
    if (handoffAsked(entry)) return view(entry);
  }
  return null;
}

/** Whether any chat is currently being compacted — the cheap gate in front of the above. */
export function anyContinuationOpen(): boolean {
  for (const entry of byToken.values()) {
    if (isOpen(entry)) return true;
  }
  return false;
}

/**
 * Source chats that Compact & Resume has finished replacing.
 *
 * Once the commit is durable the old chat is history: its session lives in the replacement,
 * its calls are refused as superseded, and the tab it is still open in only costs memory.
 * Listed for as long as the committed record is retained, so the browser closes it once and
 * a chat the user reopens later on purpose is left alone.
 */
export function supersededSourceConversations(): string[] {
  sweep();
  const out = new Set<string>();
  for (const entry of byToken.values()) {
    if (entry.state === 'committed' && entry.to && entry.to !== entry.from) out.add(entry.from);
  }
  return [...out].sort();
}

/** Auto-compaction tickets still owed a real A -> B commit. */
export function pendingAutomaticContinuations(): ContinuationView[] {
  sweep();
  return [...byToken.values()].filter((entry) => entry.automatic && isOpen(entry)).map(view);
}

/**
 * Repairs the prime binding for chats already hit by the pre-redeem shadow-session race.
 *
 * Current builds prevent the race before opening the browser, but an installed build can
 * already have created B as a small `origin.kind=resume` session and then aborted the real
 * continuation with {@link RESUME_SHADOW_COLLISION}. That leaves the user in the intended
 * replacement chat while the reusable-worker run is still bound to A, so every `agents` call
 * from B gets AGENTS_BUSY.
 *
 * This is intentionally much narrower than a takeover API. The durable recorder must prove
 * that B was app-opened as a resume of source session S, S must still own A, and B's authored
 * history must contain the exact browser bootstrap generated from S's handoff. A retained
 * collision WAL additionally identifies that handoff; after the WAL ages out, only S's newest
 * still-uncommitted handoff is eligible. Only then may the missing post-commit projections move
 * A→B and the broker's recovery hook repair prime ownership. The shadow session remains B's
 * recorder history; this deliberately does not steal/delete that session or any observations
 * the user made after landing here.
 */
export async function repairPrimeFromResumeShadow(conversationId: string): Promise<boolean> {
  if (!conversationId) return false;
  // A resume shadow is prime/solo history. Even otherwise convincing old provenance must never
  // move Goal/workspace into a conversation the broker knows belongs to a worker.
  const targetOwner = agentForOwnedConversation(conversationId);
  if (targetOwner && targetOwner !== PRIME_ID) return false;
  let target;
  try {
    target = await findSessionByConversation(conversationId, { requireUnique: true });
  } catch {
    return false;
  }
  const sourceSessionId =
    target?.origin?.kind === 'resume' && typeof target.origin.fromSessionId === 'string'
      ? target.origin.fromSessionId
      : '';
  if (!target || !sourceSessionId || target.id === sourceSessionId) return false;

  const source = await getSession(sourceSessionId).catch(() => null);
  if (!source?.conversationId) return false;
  const fromConversationId = source.conversationId;
  const sourceOwner = agentForOwnedConversation(fromConversationId);
  if (sourceOwner && sourceOwner !== PRIME_ID) return false;
  // PRIME on both sides proves two separately retained/active owner records. In particular,
  // an old A run may have parked before the exact shadow/descendant C later started a fresh run
  // of its own. Do not merge A's history/projections into that independent C. When a prior
  // recovery already moved the *same* run A→C, only C remains owned and this idempotent
  // projection repair is still allowed — that is the live 2.0.1 damage pattern this exists for.
  if (targetOwner === PRIME_ID && sourceOwner === PRIME_ID) return false;
  // Once the same run's prime ownership has already reached B and A has no remaining Goal or
  // workspace projection, there is nothing left for this browser poll to repair. The broker
  // recovery hook deliberately reports an already-satisfied A→B as success, so calling it again
  // would otherwise turn every /activity poll into another "moved missing projections" warning
  // (and another exact-handoff event scan) forever on resumed chats that have no Goal.
  if (targetOwner === PRIME_ID && !workspaceForChat(fromConversationId) && !goalObjectiveFor(fromConversationId)) {
    return false;
  }
  const failed = [...byToken.values()].find(
    (entry) =>
      entry.sessionId === sourceSessionId &&
      entry.state === 'aborted' &&
      entry.error === RESUME_SHADOW_COLLISION &&
      entry.from === fromConversationId
  );
  const handoffId = failed?.handoffId ?? source.lastHandoffId;
  if (!handoffId) return false;
  if (!failed) {
    // Terminal continuation rows are intentionally swept after 2×TTL, but an installed build can
    // leave its broken replacement tab open far longer than that. Keep a positive-only legacy
    // proof for those already-stranded chats: the target must durably say this app opened it as a
    // resume from S, S must still own A, S's newest handoff must *not* be marked committed, and B
    // must have durably recorded the exact bootstrap text generated from that handoff. This is the
    // same authored-text equality used by Goal's legacy provenance migration, but stricter here
    // because the target session origin also names the exact source session.
    if (handoffId === source.lastCommittedResumeHandoffId) return false;
  }
  const handoff = await readHandoff(source.id, handoffId).catch(() => null);
  if (!handoff) return false;
  const targetUsers = await readEvents(target.id, { kinds: ['user_message'] }).catch(() => []);
  const exactBootstrap = targetUsers.some(
    (event) => event.kind === 'user_message' && !event.message.truncated && resumeBootstrapMatches(event.message.text, handoff.text)
  );
  if (!exactBootstrap) return false;
  const proof = failed ? `collision WAL + exact handoff ${handoffId}` : `exact handoff ${handoffId}`;

  // The proof above crosses filesystem awaits. Another activity poll or agents call can finish
  // the same repair while this one is reading it, so ownership captured before those awaits is
  // no longer authoritative. Re-read both sides immediately before the synchronous projection
  // mutations; no await follows until the decision has been made.
  const currentTargetOwner = agentForOwnedConversation(conversationId);
  const currentSourceOwner = agentForOwnedConversation(fromConversationId);
  if (currentTargetOwner && currentTargetOwner !== PRIME_ID) return false;
  if (currentSourceOwner && currentSourceOwner !== PRIME_ID) return false;
  if (currentTargetOwner === PRIME_ID && currentSourceOwner === PRIME_ID) return false;
  if (
    currentTargetOwner === PRIME_ID &&
    !workspaceForChat(fromConversationId) &&
    !goalObjectiveFor(fromConversationId)
  ) {
    return false;
  }

  // The durable session rebind never landed in this legacy race, so normal
  // publishCommittedProjection() never ran either. Once the exact app-created resume shadow +
  // positive proof above identifies which A→B attempt this is, repair only projections that are
  // still missing on the descendant. A descendant can have accumulated newer Goal/workspace
  // state before an upgraded build gets its first chance to heal the old collision; that newer
  // target state wins. The stale A projection is still removed so opening A later cannot keep
  // using authority that belongs to the continued chat.
  let workspaceChanged = false;
  if (workspaceForChat(conversationId)) {
    workspaceChanged = clearChatWorkspace(fromConversationId);
  } else {
    workspaceChanged = moveChatWorkspace(fromConversationId, conversationId);
  }
  let goalChanged = false;
  if (goalObjectiveFor(conversationId)) {
    if (goalObjectiveFor(fromConversationId)) {
      clearGoalObjective(fromConversationId);
      goalChanged = true;
    }
  } else {
    goalChanged = moveGoalObjective(fromConversationId, conversationId);
  }
  // The chat's own Goal/Loop switch travels with its objective. A loop that was running in A
  // is still running in B — the whole point of Compact & Resume is that the work continues —
  // and leaving the override behind would silently hand B back to the app-wide setting.
  if (goalSwitchFor(conversationId).own) clearGoalSwitch(fromConversationId);
  else if (moveGoalSwitch(fromConversationId, conversationId)) goalChanged = true;
  // The recovery hook uses success semantics: replaying an already-repaired target returns true
  // by design. Here this boolean means "changed on this call" and drives a user-visible warning,
  // so an already-owned target must not be counted as a fresh broker mutation. Missing Goal or
  // workspace projections above are still repaired normally.
  const repaired =
    currentTargetOwner === PRIME_ID
      ? false
      : (recoveryHooks.repairPrimeTransfer?.(fromConversationId, conversationId) ?? false);
  if (repaired || workspaceChanged || goalChanged) {
    logWarn(
      `resume-shadow repair (${proof}) moved missing projections into chat ${conversationId}`
    );
  }
  return repaired || workspaceChanged || goalChanged;
}

/**
 * Begins a continuation for the session attached to `fromConversationId`.
 *
 * Idempotent per session: pressing the button twice is one transaction, answered with the
 * one already running. That is deliberate — the previous design let each press become its
 * own handoff and its own fresh tab.
 */
function makeContinuation(sessionId: string, fromConversationId: string, automatic: boolean): Continuation {
  return {
    token: randomBytes(16).toString('base64url'),
    sessionId,
    from: fromConversationId,
    openedAt: Date.now(),
    touchedAt: Date.now(),
    lastTouchPersistedAt: Date.now(),
    automatic,
    askedAt: null,
    state: 'awaiting-summary',
    summary: '',
    handoffId: null,
    capture: null,
    handoff: null,
    claimedBy: null,
    to: null,
    sourceSend: { state: 'not-attempted', messageId: null },
    destinationSend: { state: 'not-attempted', conversationId: null, messageId: null },
    error: null
  };
}

/** Durable open used before the bridge hands the one-shot compaction prompt to a page. */
export async function openContinuationNow(
  sessionId: string,
  fromConversationId: string,
  automatic = false
): Promise<ContinuationView> {
  sweep();
  const existing = [...byToken.values()].find((entry) => entry.sessionId === sessionId && isOpen(entry));
  if (existing) return view(existing);
  const opening = openingBySession.get(sessionId);
  if (opening) return opening;

  const work = (async (): Promise<ContinuationView> => {
    const again = [...byToken.values()].find((entry) => entry.sessionId === sessionId && isOpen(entry));
    if (again) return view(again);
    const entry = makeContinuation(sessionId, fromConversationId, automatic);
    try {
      await writeDurableNow(CONTINUATIONS_STATE, snapshotWith(entry.token, durableRecord(entry)));
    } catch (err) {
      // Rejecting the staged open must supersede durable.ts's retained failed generation,
      // otherwise its retry could resurrect a token the bridge never returned to the page.
      writeDurableSoon(CONTINUATIONS_STATE, snapshotContinuations());
      throw err;
    }
    byToken.set(entry.token, entry);
    beginPrimeTransfer(fromConversationId);
    logInfo(`continuation ${entry.token.slice(0, 8)} durably opened for session ${sessionId} in chat ${fromConversationId}`);
    return view(entry);
  })();
  openingBySession.set(sessionId, work);
  try {
    return await work;
  } finally {
    if (openingBySession.get(sessionId) === work) openingBySession.delete(sessionId);
  }
}

async function withCheckpointLock<T>(token: string, work: () => Promise<T>): Promise<T> {
  const prior = checkpointLocks.get(token);
  if (prior) await prior.catch(() => undefined);
  const current = work();
  checkpointLocks.set(token, current);
  try {
    return await current;
  } finally {
    if (checkpointLocks.get(token) === current) checkpointLocks.delete(token);
  }
}

/**
 * Claims the source prompt: the durable step taken before the composer is submitted at all.
 *
 * Granted from `not-attempted`, and equally from `attempted-unresolved`, because that state is
 * written before any click and is therefore proof that no prompt was ever dispatched. Handing
 * the claim to a second document cannot produce two Sends even if the first one was not dead,
 * only slow: the dispatch below is the transition that is exclusive, and only one document can
 * take it.
 *
 * It is refused from `dispatched-unresolved` and `sent`: past that point ChatGPT may already
 * hold the message, and the only honest ends are its own marker or an explicit cancel.
 */
export async function beginContinuationSourceSendNow(
  token: string
): Promise<{ allowed: boolean; checkpoint: ContinuationSendCheckpoint } | null> {
  return withCheckpointLock(token, async () => {
    const entry = byToken.get(token);
    if (!entry || !isOpen(entry) || entry.state !== 'awaiting-summary') return null;
    if (entry.sourceSend.state === 'attempted-unresolved') {
      return { allowed: true, checkpoint: { ...entry.sourceSend } };
    }
    if (entry.sourceSend.state !== 'not-attempted') {
      return { allowed: false, checkpoint: { ...entry.sourceSend } };
    }
    await transitionNow(entry, (current) => ({
      ...current,
      sourceSend: { state: 'attempted-unresolved', messageId: null }
    }));
    return { allowed: true, checkpoint: { ...entry.sourceSend } };
  });
}

/**
 * Arms the click, and is the exclusive step: exactly one caller moves the fence off
 * `attempted-unresolved`, and only that one may submit. After it returns true the prompt may
 * have reached ChatGPT — the click happens first and acceptance is observed seconds later — so
 * this app never offers the prompt again. The transaction ends at ChatGPT's marker or a cancel.
 */
export async function dispatchContinuationSourceSendNow(token: string): Promise<boolean> {
  return withCheckpointLock(token, async () => {
    const entry = byToken.get(token);
    if (!entry || !isOpen(entry) || entry.state !== 'awaiting-summary') return false;
    if (entry.sourceSend.state !== 'attempted-unresolved') return false;
    await transitionNow(entry, (current) => ({
      ...current,
      sourceSend: { state: 'dispatched-unresolved', messageId: null }
    }));
    return true;
  });
}

/**
 * Gives up an armed source dispatch that the page proved ChatGPT never took.
 *
 * `dispatched-unresolved` is deliberately never replayed: it is written before the click, so a
 * document that dies there may or may not have left the prompt with ChatGPT, and re-sending
 * would be the double-send the whole fence exists to prevent. That is right, and this does not
 * change it — nothing here re-offers the prompt to any page.
 *
 * What was missing is the other half. The destination side has had
 * `releaseContinuationDestinationSendNow` since 2026-09-02, so a replacement chat whose click
 * never landed hands the brief back at once. The source side had no equivalent, so the same
 * event left the ticket in `dispatched-unresolved` until AUTOMATIC_HANDOVER_TTL_MS — six hours —
 * with `handoffAsked()` true, so no pickup could re-ask and the page refusing to retype it. A
 * 2026-09-04 QA run measured exactly that: three phase pickups fired and expired against a chat
 * whose composer had never received the prompt. Worse than the stall itself, the chat stays in
 * `pendingAutomaticContinuations()` the whole time, and `inspectSilentChats()` skips those — so
 * a chat that is merely wedged also loses browser recovery for the rest of the six hours.
 *
 * The evidence is the page's own `send()` returning false, which is not a bare timeout: it
 * watches five independent acceptance signals — the composer clearing, a new conversation id,
 * generation starting, the Stop control appearing, and a freshly rendered user message matching
 * the text — for three seconds. The compaction flow has already stopped generation and waited
 * for settle before it types, so a landed click flips generating/Stop within milliseconds. None
 * of the five inside three seconds is the strongest negative this page can produce.
 *
 * Aborting rather than releasing is the deliberate asymmetry with the destination half. The
 * destination can prove nothing was sent (a chat that still has no id cannot have accepted a
 * message) and so may safely re-offer the brief; here the evidence is strong but not proof, so
 * the transaction ends instead of being re-armed. Nothing is ever sent twice, and the cost of
 * being wrong is one abandoned compaction that auto-compaction re-files on the next qualifying
 * turn — against six hours of a wedged chat with no browser recovery.
 */
export async function releaseContinuationSourceSendNow(token: string, reason: string): Promise<boolean> {
  const entry = byToken.get(token);
  if (!entry || !isOpen(entry) || entry.state !== 'awaiting-summary') return false;
  // Only the armed-but-unproven state. `sent` has ChatGPT's own marker behind it and is not in
  // doubt; the earlier states were never dispatched and are reclaimable without this.
  if (entry.sourceSend.state !== 'dispatched-unresolved') return false;
  return abortContinuation(token, reason);
}

/** Binds the marked source prompt to ChatGPT's stable user-message identity. */
export async function bindContinuationSourceMessageNow(token: string, messageId: string): Promise<boolean> {
  if (!messageId || messageId.length > 200) return false;
  return withCheckpointLock(token, async () => {
    const entry = byToken.get(token);
    if (!entry || !isOpen(entry) || entry.state !== 'awaiting-summary') return false;
    if (entry.sourceSend.state === 'sent') return entry.sourceSend.messageId === messageId;
    if (entry.sourceSend.state !== 'dispatched-unresolved') return false;
    await transitionNow(entry, (current) => ({
      ...current,
      sourceSend: { state: 'sent', messageId }
    }));
    return true;
  });
}

/**
 * Claims the replacement bootstrap, before its composer is submitted at all.
 *
 * The same two steps as the source half, for the same reason, and it matters more here: the
 * replacement tab is opened by this app and is routinely reloaded or retargeted while it is
 * still typing. `attempted-unresolved` is reclaimable because nothing was dispatched under it.
 */
export async function beginContinuationDestinationSendNow(
  token: string
): Promise<{ allowed: boolean; checkpoint: ContinuationDestinationCheckpoint } | null> {
  return withCheckpointLock(token, async () => {
    const entry = byToken.get(token);
    if (!entry || !isOpen(entry) || !entry.handoffId || entry.state === 'awaiting-summary') return null;
    if (entry.destinationSend.state === 'attempted-unresolved') {
      return { allowed: true, checkpoint: { ...entry.destinationSend } };
    }
    if (entry.destinationSend.state !== 'not-attempted') {
      return { allowed: false, checkpoint: { ...entry.destinationSend } };
    }
    await transitionNow(entry, (current) => ({
      ...current,
      destinationSend: { state: 'attempted-unresolved', conversationId: null, messageId: null }
    }));
    return { allowed: true, checkpoint: { ...entry.destinationSend } };
  });
}

/**
 * Arms the replacement's click, exclusively. Past this the bootstrap may exist server-side in a
 * chat this app cannot yet name, so it is never retyped; only the marked message resolves it.
 */
export async function dispatchContinuationDestinationSendNow(token: string): Promise<boolean> {
  return withCheckpointLock(token, async () => {
    const entry = byToken.get(token);
    if (!entry || !isOpen(entry) || !entry.handoffId || entry.state === 'awaiting-summary') return false;
    if (entry.destinationSend.state !== 'attempted-unresolved') return false;
    await transitionNow(entry, (current) => ({
      ...current,
      destinationSend: { state: 'dispatched-unresolved', conversationId: null, messageId: null }
    }));
    return true;
  });
}

/**
 * Takes an armed replacement dispatch back, on the one proof that nothing left the page: the
 * composer no longer held the brief in a chat that still had no id, so the click had nothing
 * to submit and ChatGPT nothing to accept. The user pressing Escape as the brief lands is that
 * case. A composer still holding the text is the ambiguous one and stays armed; only the marked
 * message or a cancel resolves it. Released, the brief may be offered to a fresh chat again.
 */
export async function releaseContinuationDestinationSendNow(token: string): Promise<boolean> {
  return withCheckpointLock(token, async () => {
    const entry = byToken.get(token);
    if (!entry || !isOpen(entry) || !entry.handoffId || entry.state === 'awaiting-summary') return false;
    if (entry.destinationSend.state === 'sent') return false;
    if (entry.destinationSend.state === 'not-attempted' && entry.claimedBy === null) return true;
    // The claim goes with the dispatch. It named the one command whose page was to send the
    // brief; that page has sent nothing and its command is retired, so the next command — a
    // fresh id — must be able to claim, or the released brief could never be offered again.
    await transitionNow(entry, (current) => ({
      ...current,
      state: current.state === 'claimed' ? 'awaiting-chat' : current.state,
      claimedBy: null,
      destinationSend: { state: 'not-attempted', conversationId: null, messageId: null }
    }));
    return true;
  });
}

/** Binds the marked bootstrap to its exact ChatGPT conversation and user-message identity. */
export async function bindContinuationDestinationMessageNow(
  token: string,
  conversationId: string,
  messageId: string
): Promise<boolean> {
  if (!conversationId || !messageId || conversationId.length > 256 || messageId.length > 200) return false;
  return withCheckpointLock(token, async () => {
    const entry = byToken.get(token);
    if (!entry || !entry.handoffId || conversationId === entry.from) return false;
    // Exact destination identity remains a proof after the transaction commits. A content
    // script can reload after B was durably attached but before it correlated the first tool
    // request; making `isOpen()` the first gate turned that harmless reload into an identity
    // dead-end even though the WAL still holds the exact B + message id pair. Re-reading the
    // already-sent checkpoint is idempotent and cannot move or reopen anything.
    if (entry.destinationSend.state === 'sent') {
      return (
        entry.destinationSend.conversationId === conversationId &&
        entry.destinationSend.messageId === messageId
      );
    }
    if (!isOpen(entry)) return false;
    if (entry.destinationSend.state !== 'dispatched-unresolved') return false;
    await transitionNow(entry, (current) => ({
      ...current,
      destinationSend: { state: 'sent', conversationId, messageId }
    }));
    return true;
  });
}

/**
 * Stores ChatGPT's final answer for the compaction turn as this session's handoff.
 *
 * The caller is responsible for having captured the answer belonging to that exact
 * generation; this refuses only what it can see is wrong — an empty brief, or one arriving
 * for a continuation that is no longer waiting for it. An empty or interrupted answer leaves
 * the transaction where it was, so the session stays in chat A and nothing is opened.
 *
 * Exactly one handoff is written per continuation. A capture arriving after that one exists
 * is answered with it — the same id, reported as the success it is — because the alternative
 * is a lost tool result looking like a failure and driving a second flow. That holds whether
 * the retry carries the identical text or a re-observed variant of it: there is one brief for
 * this compaction, and it is the one already stored.
 */
export async function attachSummary(token: string, text: string): Promise<Handoff | null> {
  const brief = text.trim();
  if (!brief) return null;
  return capture(token, brief, async (entry) =>
    prepareHandoff({
      sessionId: entry.sessionId,
      text: brief
    })
  );
}

/**
 * The one path a brief becomes this continuation's.
 *
 * Single-flight, and the lock is taken before the first await. Two captures of the same
 * finished generation — the page reporting it twice, or a retried report racing the original
 * — would otherwise both see `awaiting-summary`, both produce a handoff, and both store: two
 * briefs for one compaction, of which the second silently wins. Duplicates wait on the first
 * attempt and are answered with its result.
 */
async function capture(
  token: string,
  text: string,
  produce: (entry: Continuation) => Promise<Handoff>
): Promise<Handoff | null> {
  sweep();
  const entry = byToken.get(token);
  if (!entry) return null;
  // Deliberately ahead of the liveness check: a handoff that was written stays answerable
  // even once the transaction it belonged to has expired or been abandoned. The brief is on
  // disk either way, and telling a retry "no such thing" would be a lie about durable state.
  if (entry.handoff) {
    if (entry.handoff.text.trim() !== text.trim()) {
      logWarn(`continuation ${entry.token.slice(0, 8)} re-captured a different brief; keeping handoff ${entry.handoffId}`);
    }
    try {
      await ensureHandoffRecorded(
        entry.sessionId,
        entry.handoff.id,
        entry.handoff.text.length,
        'compact and resume'
      );
    } catch (err) {
      // The WAL already committed this handoff. A retry is another chance to repair the
      // session projection, but failure here still cannot make the committed capture false.
      logWarn(
        `continuation ${entry.token.slice(0, 8)} could not repair handoff event ${entry.handoff.id} on retry — ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return entry.handoff;
  }
  if (entry.capture) return settle(entry, entry.capture);
  if (!isOpen(entry)) return null;
  if (entry.state !== 'awaiting-summary') return null;
  entry.capture = (async () => {
    const handoff = await produce(entry);
    await transitionNow(entry, (current) => ({
      ...current,
      summary: handoff.text,
      handoffId: handoff.id,
      state: 'awaiting-chat',
      error: null
    }));
    // The handoff file was written before the continuation WAL record, but it is deliberately
    // *not* in the session timeline yet. The WAL is the semantic commit for this capture: only
    // after it lands may `lastHandoffId` advertise the brief to unrelated recovery callers.
    // This closes the old inverse ordering where a rejected WAL transition had already made
    // its handoff discoverable and the retry produced a second handoff.
    entry.handoff = handoff;
    try {
      await recordHandoff(entry.sessionId, handoff.id, handoff.text.length, 'compact and resume');
    } catch (err) {
      // The continuation is already durable and can safely proceed. Recovery has the handoff
      // id in that WAL and repairs this presentation/discovery event idempotently on restart.
      logWarn(
        `continuation ${entry.token.slice(0, 8)} committed handoff ${handoff.id} but could not publish its session event — ${err instanceof Error ? err.message : String(err)}`
      );
    }
    logInfo(`continuation ${entry.token.slice(0, 8)} captured handoff ${handoff.id}`);
    return handoff;
  })();
  return settle(entry, entry.capture);
}

/**
 * Awaits one capture attempt on behalf of every caller waiting on it.
 *
 * Both the caller that started the write and the duplicates that joined it come through
 * here, so a failure is the same answer for all of them: null, meaning "not stored, ask
 * again" — rather than a resolved null for one and a rejected promise for the others, which
 * would surface to a retrying page as a tool error for a step that merely has to be redone.
 */
async function settle(entry: Continuation, capture: Promise<Handoff>): Promise<Handoff | null> {
  try {
    return await capture;
  } catch (err) {
    // The handoff file may have been created, but its continuation transition was never
    // published unless the WAL write succeeded. Clearing the single-flight lock therefore
    // makes the semantic step retryable without pretending the continuation advanced.
    if (entry.capture === capture) entry.capture = null;
    logWarn(`continuation ${entry.token.slice(0, 8)} could not store the brief — ${(err as Error).message}`);
    return null;
  }
}

/**
 * Takes this continuation for one replacement chat, and returns the brief to send.
 *
 * One claim, ever. A second claimant — a duplicate command, a second tab redeeming the same
 * marker — is refused, which is the whole of "never allow two replacement chats to claim the
 * same continuation". Re-claiming with the *same* claimant is allowed, because that is a
 * retry of one attempt rather than a second attempt.
 *
 * The state machine only ever moves forwards here. A retry that arrives while the commit is
 * already in flight is answered with the brief — that is all a retrying claimant wants — but
 * must not put the state back to `claimed`, because `committing` is the lock that stops a
 * second {@link commitContinuation} from entering while the first is still awaiting its
 * durable write. Writing the state back was that lock's one escape hatch.
 */
/**
 * Durable claim used by the command redeem route. The brief is not handed to a browser
 * document until the WAL records which claimant owns it.
 */
export async function claimContinuationNow(token: string, claimant: string): Promise<{ summary: string } | null> {
  sweep();
  const entry = byToken.get(token);
  if (!entry || !isOpen(entry)) return null;
  if (entry.state === 'awaiting-summary') return null;
  if (entry.claimedBy !== null && entry.claimedBy !== claimant) return null;
  if (entry.state === 'awaiting-chat') {
    await transitionNow(entry, (current) => ({ ...current, claimedBy: claimant, state: 'claimed' }));
  } else if (entry.state === 'claimed' && entry.claimedBy === null) {
    await transitionNow(entry, (current) => ({ ...current, claimedBy: claimant }));
  }
  // After the transition, never before it. A throw here leaves nothing claimed, and arming
  // first would have made every unrelated new chat wait out the window for a claim that
  // does not exist.
  if (entry.state === 'claimed') noteResumeClaim(entry.token);
  // A same-owner redeem racing a commit is read-only. `committing` remains monotonic.
  return { summary: entry.summary };
}

function publishCommittedProjection(
  entry: Continuation,
  toConversationId: string,
  swarm: 'absent' | 'frozen' | 'recovery'
): void {
  rebindConversation(entry.sessionId, entry.from, toConversationId);
  moveChatWorkspace(entry.from, toConversationId);
  moveGoalObjective(entry.from, toConversationId);
  moveGoalSwitch(entry.from, toConversationId);
  if (swarm === 'frozen') {
    if (!commitPrimeTransfer(entry.from, toConversationId)) {
      // The frozen handover cannot expire. A miss here means the run ended outright while
      // the session write was in flight; there is no live prime left in A to split from.
      logWarn(`continuation ${entry.token.slice(0, 8)} committed after its run ended; no prime to move`);
    }
  } else if (swarm === 'recovery') {
    // Normal commitPrimeTransfer intentionally requires the ephemeral frozen transfer. After
    // restart that lock is gone, so only a recovery hook explicitly authorised by the durable
    // continuation WAL may repair the broker's derived A→B prime projection.
    const repaired = recoveryHooks.repairPrimeTransfer?.(entry.from, toConversationId) ?? false;
    if (!repaired && !commitPrimeTransfer(entry.from, toConversationId)) {
      logWarn(`continuation ${entry.token.slice(0, 8)} recovered without a broker prime repair hook`);
    }
  }
}

async function rollbackCommitting(
  entry: Continuation,
  error: string
): Promise<boolean> {
  try {
    await transitionNow(entry, (current) => ({
      ...current,
      state: entry.claimedBy ? 'claimed' : 'awaiting-chat',
      to: null,
      error
    }));
    return true;
  } catch (err) {
    logWarn(
      `continuation ${entry.token.slice(0, 8)} could not persist its retry state — ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

async function finishCommittedRecord(entry: Continuation, toConversationId: string): Promise<void> {
  try {
    await transitionNow(entry, (current) => ({
      ...current,
      state: 'committed',
      to: toConversationId,
      error: null
    }));
  } catch (err) {
    // The authoritative session already says B and cannot be rolled back. Keeping the WAL in
    // `committing` is intentional: restart/retry can prove B from session meta and finish the
    // idempotent repair. Never report the semantic move as failed after that boundary landed.
    logWarn(
      `continuation ${entry.token.slice(0, 8)} moved its session but could not persist the completion record — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function reconcileCommitting(entry: Continuation, toConversationId: string): Promise<ContinuationCommitResult> {
  let session;
  try {
    session = await getSession(entry.sessionId);
  } catch (err) {
    return { status: 'retryable', reason: `the local session could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!session) return { status: 'rejected', reason: 'the local session no longer exists' };

  if (session.conversationId === toConversationId) {
    if (entry.handoffId) {
      try {
        if (!(await ensureCommittedResumeHandoff(entry.sessionId, toConversationId, entry.handoffId))) {
          return { status: 'retryable', reason: 'the committed resume handoff provenance could not be repaired' };
        }
      } catch (err) {
        return {
          status: 'retryable',
          reason: `the committed resume handoff provenance could not be repaired: ${err instanceof Error ? err.message : String(err)}`
        };
      }
    }
    publishCommittedProjection(entry, toConversationId, 'recovery');
    await finishCommittedRecord(entry, toConversationId);
    return { status: 'already-committed', conversationId: toConversationId };
  }
  if (session.conversationId !== entry.from) {
    const reason = 'the local session is attached to an unexpected chat, so recovery refused to guess';
    try {
      await transitionNow(entry, (current) => ({ ...current, state: 'aborted', error: reason }));
    } catch {
      return { status: 'retryable', reason };
    }
    cancelPrimeTransfer(entry.from);
    return { status: 'rejected', reason };
  }

  if (/^[0-9a-f-]{8,64}$/i.test(toConversationId)) {
    let target;
    try {
      target = await findSessionByConversation(toConversationId, { requireUnique: true });
    } catch (err) {
      return { status: 'retryable', reason: `the destination chat ownership could not be checked: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (target && target.id !== entry.sessionId) {
      const reason = RESUME_SHADOW_COLLISION;
      const rolledBack = await rollbackCommitting(entry, reason);
      return rolledBack ? { status: 'rejected', reason } : { status: 'retryable', reason };
    }
  }

  const swarm = freezePrimeTransfer(entry.from);
  if (swarm === 'unavailable') {
    const reason = 'no swarm handover is open for this chat, so the session stayed in the current chat';
    const rolledBack = await rollbackCommitting(entry, reason);
    if (rolledBack) {
      logWarn(`continuation ${entry.token.slice(0, 8)} refused: no usable prime handover from ${entry.from}`);
      return { status: 'rejected', reason };
    }
    return { status: 'retryable', reason };
  }

  let moved = false;
  try {
    moved = await rebindSession(
      entry.sessionId,
      entry.from,
      toConversationId,
      entry.handoffId ?? undefined,
      // The brief B is opened on. It is B's starting context and none of it is B's own work,
      // so the compaction threshold has to discount it — see resumeBaselineTokens.
      estimateTokens(entry.summary)
    );
  } catch (err) {
    logWarn(`continuation ${entry.token.slice(0, 8)} rebind threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!moved) {
    let after = null;
    try {
      after = await getSession(entry.sessionId);
    } catch {
      // The result stays retryable below; the frozen handover is released first.
    }
    if (after?.conversationId === toConversationId) {
      if (entry.handoffId) {
        try {
          if (!(await ensureCommittedResumeHandoff(entry.sessionId, toConversationId, entry.handoffId))) {
            return { status: 'retryable', reason: 'the committed resume handoff provenance could not be repaired' };
          }
        } catch (err) {
          return {
            status: 'retryable',
            reason: `the committed resume handoff provenance could not be repaired: ${err instanceof Error ? err.message : String(err)}`
          };
        }
      }
      publishCommittedProjection(entry, toConversationId, swarm === 'frozen' ? 'frozen' : 'absent');
      await finishCommittedRecord(entry, toConversationId);
      return { status: 'committed', conversationId: toConversationId };
    }
    if (swarm === 'frozen') thawPrimeTransfer(entry.from);
    if (after && after.conversationId !== entry.from) {
      const reason = 'the local session changed ownership while the continuation was committing';
      try {
        await transitionNow(entry, (current) => ({ ...current, state: 'aborted', error: reason }));
      } catch {
        return { status: 'retryable', reason };
      }
      cancelPrimeTransfer(entry.from);
      return { status: 'rejected', reason };
    }
    const reason = 'the local session could not be moved to the new chat';
    await rollbackCommitting(entry, reason);
    logWarn(`continuation ${entry.token.slice(0, 8)} could not rebind session ${entry.sessionId}`);
    return { status: 'retryable', reason };
  }

  // --- publish. Total map work only, after the authoritative durable attachment says B.
  publishCommittedProjection(entry, toConversationId, swarm === 'frozen' ? 'frozen' : 'absent');
  await finishCommittedRecord(entry, toConversationId);
  logInfo(
    `continuation ${entry.token.slice(0, 8)} committed: session ${entry.sessionId} is now chat ${toConversationId}`
  );
  return { status: 'committed', conversationId: toConversationId };
}

/**
 * Moves the session to chat B, with a result that distinguishes retryable local failures from
 * terminal safety refusals and idempotent success. The boolean wrapper below remains for older
 * callers/tests; bridge transport uses this richer result to decide whether a command survives.
 */
async function commitContinuationUnlocked(
  entry: Continuation,
  toConversationId: string
): Promise<ContinuationCommitResult> {
  if (!toConversationId || toConversationId === entry.from) {
    return { status: 'rejected', reason: 'the replacement chat is not a distinct conversation' };
  }
  if (entry.state === 'committed') {
    if (entry.to && entry.to !== toConversationId) {
      return { status: 'rejected', reason: 'the continuation already committed to a different chat' };
    }
    const committedTo = entry.to ?? toConversationId;
    if (entry.handoffId) {
      try {
        if (!(await ensureCommittedResumeHandoff(entry.sessionId, committedTo, entry.handoffId))) {
          return { status: 'retryable', reason: 'the committed resume handoff provenance could not be repaired' };
        }
      } catch (err) {
        return {
          status: 'retryable',
          reason: `the committed resume handoff provenance could not be repaired: ${err instanceof Error ? err.message : String(err)}`
        };
      }
    }
    return { status: 'already-committed', conversationId: committedTo };
  }
  if (entry.state === 'committing') {
    if (entry.to !== toConversationId) {
      return { status: 'rejected', reason: 'another replacement chat already owns the commit' };
    }
    return reconcileCommitting(entry, toConversationId);
  }
  if (!isOpen(entry) || (entry.state !== 'awaiting-chat' && entry.state !== 'claimed')) {
    return { status: 'rejected', reason: 'the continuation is not ready to commit' };
  }

  try {
    await transitionNow(entry, (current) => ({
      ...current,
      state: 'committing',
      to: toConversationId,
      error: null
    }));
  } catch (err) {
    return {
      status: 'retryable',
      reason: `the continuation intent could not be persisted: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  return reconcileCommitting(entry, toConversationId);
}

export async function commitContinuationResult(
  token: string,
  toConversationId: string
): Promise<ContinuationCommitResult> {
  sweep();
  const entry = byToken.get(token);
  if (!entry) return { status: 'rejected', reason: 'the continuation no longer exists' };
  const locked = commitLocks.get(token);
  if (locked) {
    if (locked.to !== toConversationId) {
      return { status: 'rejected', reason: 'another replacement chat already owns the commit' };
    }
    return locked.promise;
  }

  // Ephemeral single-flight lock, separate from the durable record. Staged WAL persistence
  // deliberately does not publish `committing` before its write succeeds, so this lock is what
  // closes the tiny concurrent-ACK window without reintroducing mutation-before-await.
  const work = commitContinuationUnlocked(entry, toConversationId);
  commitLocks.set(token, { to: toConversationId, promise: work });
  try {
    return await work;
  } finally {
    if (commitLocks.get(token)?.promise === work) commitLocks.delete(token);
  }
}

export async function commitContinuation(token: string, toConversationId: string): Promise<boolean> {
  const result = await commitContinuationResult(token, toConversationId);
  return result.status === 'committed' || result.status === 'already-committed';
}

/**
 * Gives up, leaving the session attached to chat A.
 *
 * Refuses once the durable phase has started. `committing` is the commit's lock, and an
 * abort that could clear it would cancel the frozen prime handover under a write that is
 * still going to land — the session would move on disk while the swarm stayed behind. The
 * commit either succeeds, or restores a claimable state itself and can be aborted then.
 */
export function abortContinuation(token: string, reason: string): boolean {
  const entry = byToken.get(token);
  if (!entry || entry.state === 'committing') return false;
  if (entry.state === 'committed' || entry.state === 'aborted') return false;
  entry.state = 'aborted';
  entry.error = reason;
  // Settling is forward progress like any other transition: sweep()'s own terminal-retention
  // window is measured from here, not from when the transaction opened, so an automatic ticket
  // that sat waiting for hours does not read as already-ancient the instant it finally expires.
  entry.touchedAt = Date.now();
  endResumeClaim(entry.token);
  cancelPrimeTransfer(entry.from);
  changed();
  logWarn(`continuation ${entry.token.slice(0, 8)} abandoned — ${reason}`);
  noteAbandoned(entry, reason);
  return true;
}

/**
 * Puts the reason a Compact & Resume died into the session it was compacting, so the
 * timeline's one row for it can say what went wrong instead of only that nothing came.
 * The log line above is operational and RAM-only; this is the durable, user-facing record.
 */
function noteAbandoned(entry: Continuation, reason: string): void {
  void recordNote(entry.sessionId, `Compact & Resume abandoned — ${reason}`, entry.token);
}

/** Durable abort for user-visible cancellation paths. */
export async function abortContinuationNow(token: string, reason: string): Promise<boolean> {
  const entry = byToken.get(token);
  if (!entry || entry.state === 'committing') return false;
  if (entry.state === 'committed' || entry.state === 'aborted') return false;
  await transitionNow(entry, (current) => ({ ...current, state: 'aborted', error: reason }));
  cancelPrimeTransfer(entry.from);
  logWarn(`continuation ${entry.token.slice(0, 8)} durably abandoned — ${reason}`);
  noteAbandoned(entry, reason);
  return true;
}

const SEND_STATES = new Set<ContinuationSendState>([
  'not-attempted',
  'attempted-unresolved',
  'dispatched-unresolved',
  'sent'
]);


/**
 * Restores open continuation transactions after the agent/session projections are loaded.
 *
 * A persisted `committing` record is resolved from the authoritative session meta: if it
 * already names chat B, the durable commit landed and publication is completed; if it still
 * names A, the move did not land and the transaction becomes claimable again. Any third
 * identity is quarantined as aborted rather than guessed across chats.
 */
export async function restoreContinuations(snapshot: ContinuationSnapshot | null): Promise<void> {
  byToken.clear();
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.entries)) return;
  const now = Date.now();
  const validStates = new Set<ContinuationState>([
    'awaiting-summary',
    'awaiting-chat',
    'claimed',
    'committing',
    'committed',
    'aborted'
  ]);
  for (const raw of snapshot.entries.slice(0, 32)) {
    if (
      !raw ||
      !/^[A-Za-z0-9_-]{16,64}$/.test(raw.token) ||
      !/^[0-9a-z-]{8,64}$/i.test(raw.sessionId) ||
      typeof raw.from !== 'string' ||
      raw.from.length === 0 || raw.from.length > 256 ||
      !validStates.has(raw.state) ||
      !Number.isFinite(raw.openedAt) ||
      // Terminal records prune by touchedAt-if-known, matching the live sweep()'s own
      // terminal-retention window - measured from when the record settled, not from when it
      // opened. A non-automatic open record prunes the same way, same reasoning as expired()
      // below. An automatic open record is deliberately exempt from age-pruning here — it
      // survives page/retry clocks by design — and is judged instead by expired() once restored.
      ((raw.state === 'committed' || raw.state === 'aborted') &&
        now -
          (typeof raw.touchedAt === 'number' && Number.isFinite(raw.touchedAt) ? raw.touchedAt : raw.openedAt) >=
          CONTINUATION_TTL_MS * 2) ||
      (raw.automatic !== true &&
        now -
          (typeof raw.touchedAt === 'number' && Number.isFinite(raw.touchedAt) ? raw.touchedAt : raw.openedAt) >=
          CONTINUATION_TTL_MS * 2)
    ) {
      continue;
    }
    const entry: Continuation = {
      token: raw.token,
      sessionId: raw.sessionId,
      from: raw.from,
      to: typeof raw.to === 'string' && raw.to ? raw.to : null,
      openedAt: raw.openedAt,
      touchedAt: typeof raw.touchedAt === 'number' && Number.isFinite(raw.touchedAt) ? raw.touchedAt : raw.openedAt,
      lastTouchPersistedAt:
        typeof raw.touchedAt === 'number' && Number.isFinite(raw.touchedAt) ? raw.touchedAt : raw.openedAt,
      automatic: raw.automatic === true,
      askedAt: null,
      state: raw.state,
      summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 512 * 1024) : '',
      handoffId: typeof raw.handoffId === 'string' ? raw.handoffId : null,
      capture: null,
      handoff: null,
      claimedBy: typeof raw.claimedBy === 'string' ? raw.claimedBy : null,
      sourceSend:
        raw.sourceSend && SEND_STATES.has(raw.sourceSend.state as ContinuationSendState)
          ? {
              state: raw.sourceSend.state as ContinuationSendState,
              messageId:
                typeof raw.sourceSend.messageId === 'string' ? raw.sourceSend.messageId.slice(0, 200) : null
            }
          : {
              // The retired `armed` flag was raised around the click, not before it, so it
              // cannot promise the prompt was never dispatched. It migrates to the ambiguous
              // state, which is exactly what it always meant.
              state: raw.armed === true ? 'dispatched-unresolved' : 'not-attempted',
              messageId: null
            },
      destinationSend:
        raw.destinationSend && SEND_STATES.has(raw.destinationSend.state as ContinuationSendState)
          ? {
              state: raw.destinationSend.state as ContinuationSendState,
              conversationId:
                typeof raw.destinationSend.conversationId === 'string'
                  ? raw.destinationSend.conversationId.slice(0, 256)
                  : null,
              messageId:
                typeof raw.destinationSend.messageId === 'string'
                  ? raw.destinationSend.messageId.slice(0, 200)
                  : null
            }
          : { state: 'not-attempted', conversationId: null, messageId: null },
      error: typeof raw.error === 'string' ? raw.error : null
    };
    if (handoffAsked(entry)) {
      // A record from before the automatic deadline existed starts its clock at this
      // restart: this process has watched the handover for exactly no time.
      entry.askedAt = typeof raw.askedAt === 'number' && Number.isFinite(raw.askedAt) ? raw.askedAt : now;
    }
    const waitingExpired = entry.state !== 'committed' && entry.state !== 'aborted' && expired(entry, now);
    if (entry.handoffId) {
      try {
        entry.handoff = await readHandoff(entry.sessionId, entry.handoffId);
      } catch (err) {
        logWarn(`continuation ${entry.token.slice(0, 8)} handoff recovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (entry.handoff && entry.state !== 'awaiting-summary') {
      try {
        await ensureHandoffRecorded(
          entry.sessionId,
          entry.handoff.id,
          entry.handoff.text.length,
          'compact and resume'
        );
      } catch (err) {
        // A missing timeline event is recoverable presentation metadata. The continuation WAL
        // and handoff file still agree, so never abort an otherwise safe transaction for this;
        // the next app start gets another idempotent repair attempt.
        logWarn(
          `continuation ${entry.token.slice(0, 8)} could not repair handoff event ${entry.handoff.id} — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (entry.state === 'committing' || entry.state === 'committed') {
      let session = null;
      try {
        session = await getSession(entry.sessionId);
      } catch (err) {
        logWarn(`continuation ${entry.token.slice(0, 8)} session recovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (session && entry.to && session.conversationId === entry.to) {
        if (entry.handoffId) {
          try {
            await ensureCommittedResumeHandoff(entry.sessionId, entry.to, entry.handoffId);
          } catch (err) {
            // The continuation/session already prove the move. Keep the durable WAL record so
            // the next startup retries this metadata-only repair rather than inventing a rollback.
            logWarn(
              `continuation ${entry.token.slice(0, 8)} could not repair committed resume provenance — ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        rebindConversation(entry.sessionId, entry.from, entry.to);
        moveChatWorkspace(entry.from, entry.to);
        moveGoalObjective(entry.from, entry.to);
        moveGoalSwitch(entry.from, entry.to);
        const repaired = recoveryHooks.repairPrimeTransfer?.(entry.from, entry.to) ?? false;
        if (!repaired) commitPrimeTransfer(entry.from, entry.to);
        entry.state = 'committed';
        entry.error = null;
        // Same reasoning as abortContinuation(): this is the moment the record actually settled,
        // even though the underlying durable commit happened before the crash this is repairing.
        entry.touchedAt = Date.now();
        logInfo(`continuation ${entry.token.slice(0, 8)} recovered after durable commit`);
      } else if (entry.state === 'committing' && session && session.conversationId === entry.from) {
        if (waitingExpired) {
          // The WAL proves the durable session move never landed. Restart must not turn an
          // already-expired ten-minute transaction into a fresh one merely because its
          // ephemeral transfer lock disappeared with the process.
          entry.state = 'aborted';
          entry.to = null;
          entry.error = 'Recovery found the continuation had already expired before the durable session move.';
          cancelPrimeTransfer(entry.from);
        } else {
          thawPrimeTransfer(entry.from);
          entry.state = entry.claimedBy ? 'claimed' : 'awaiting-chat';
          entry.to = null;
          entry.error = 'Recovered before the durable session move; the continuation can be retried.';
          beginPrimeTransfer(entry.from);
        }
      } else if (entry.state === 'committed') {
        // The commit landed durably before this restart; the session has since moved on
        // again (a later handover out of chat B), which does not make the first move less
        // real. Keep the record so the source chat stays superseded instead of aborting a
        // finished transaction and cancelling a transfer that had already committed.
        logInfo(`continuation ${entry.token.slice(0, 8)} stays committed although its session moved on again`);
      } else {
        entry.state = 'aborted';
        entry.error = 'Recovery found an unexpected session attachment and refused to guess a chat.';
        cancelPrimeTransfer(entry.from);
      }
    } else if (entry.state !== 'aborted') {
      if (waitingExpired) {
        // Terminal records are retained up to 2× TTL so duplicate/replayed acknowledgements can
        // still be answered consistently, but a nonterminal wait gets only the actual 10-minute
        // lifetime. In particular, never mint a fresh prime-transfer lease on restart.
        entry.state = 'aborted';
        entry.error = 'Recovery found the continuation had already expired.';
        cancelPrimeTransfer(entry.from);
      // A stored brief is required for every post-capture state. Missing/corrupt durable
      // handoff data is not an empty valid brief and must not be typed into a new chat.
      } else if (entry.state !== 'awaiting-summary' && !entry.handoff) {
        entry.state = 'aborted';
        entry.error = 'The saved handoff could not be recovered.';
        cancelPrimeTransfer(entry.from);
      } else {
        beginPrimeTransfer(entry.from);
      }
    }
    // A continuation recovered still holding its claim is a move that has not landed yet, and
    // the replacement chat may be sitting in a tab about to report in. Nothing re-arms the
    // gate on its own — the claim that armed it happened in a process that is gone — so the
    // collision it exists to prevent would be wide open for exactly the restart that is most
    // likely to hit it. Re-armed from now rather than from the original claim, because what
    // matters is how long from *here* that chat still has to appear.
    if (entry.state === 'claimed') noteResumeClaim(entry.token);
    byToken.set(entry.token, entry);
  }
  try {
    await changedNow();
  } catch (err) {
    // Broken recovery state must not prevent the whole app from opening. New commits still
    // require an immediate durable write and therefore continue to fail closed.
    logWarn(`continuation recovery could not persist its repaired snapshot: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Test seam. */
export function resetContinuationsForTests(): void {
  byToken.clear();
  openingBySession.clear();
  commitLocks.clear();
  checkpointLocks.clear();
  recoveryHooks = {};
  // The gate is part of this module's state even though it lives next door, and a claim
  // outlives a cleared transaction by RESUME_CLAIM_WINDOW_MS. Left behind, it makes the
  // *next* test's unrelated new chat wait for a replacement that will never come.
  resetResumeGate();
  changed();
}
