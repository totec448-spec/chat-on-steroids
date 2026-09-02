/**
 * The bridge between what happens and what is stored.
 *
 * Two sources feed it. The MCP server reports every tool call with the exact arguments
 * and result. The Chrome extension reports canonical ChatGPT message observations, turn
 * lifecycle, visible page-native activity, errors, and request-id evidence.
 *
 * Tool ownership has one path only: normalized HTTP x-request-id -> ChatGPT
 * message.metadata.request_id -> conversationId. The correlation registry records that
 * exact proof. ConversationId then maps to a session and, independently, to swarm role.
 * If the exact request cannot be proven, the call goes to Unattributed activity. No
 * tool-name, timing, visible-row, active-tab, generation, or agent-payload heuristic may
 * choose an owner.
 */

import { randomUUID } from 'node:crypto';
import type {
  ActivitySummary,
  AgentMessage,
  AssetRef,
  CallAttribution,
  SessionEvent,
  SessionOrigin,
  SessionSummary,
  StoredText,
  ToolCallRecord,
  ToolOutcome,
  TurnOutcome
} from '../../shared/session.js';
import { estimateTokens, originTitle } from '../../shared/session.js';
import { getConfig } from '../config.js';
import { logInfo, logWarn } from '../logger.js';
import { currentCall, emptyEvidence, type CallEvidence } from '../mcp/call-context.js';
import {
  MAX_MESSAGE_CHARS,
  MAX_TOOL_ARGS_CHARS,
  MAX_TOOL_RESULT_CHARS,
  MAX_USER_MESSAGE_CHARS,
  MAX_ASSET_BYTES,
  appendEvent,
  conversationAttachment,
  createSession,
  conversationWasSuperseded,
  deleteSession,
  endSession,
  findSessionByConversation,
  getSession,
  listAllSessions,
  readAsset,
  readEvents,
  readRecentEvents,
  renameSession,
  reopenSession,
  rewriteUnattributedToolCalls,
  setSessionOrigin,
  upsertMessageEvent,
  writeAsset,
  writeOverflowText
} from './store.js';
import {
  awaitRequestCorrelation,
  observeRequestCorrelations,
  requestCorrelation,
  resetCorrelationRegistryForTests,
} from './correlation.js';
import { resumeOpeningChat } from './resume-gate.js';
import { summarizeToolCall } from './summarize.js';

interface LiveConversation {
  conversationId: string;
  sessionId: string;
  /** Durable local turn lifecycle only. Never used as MCP ownership evidence. */
  turnStartedAt: number | null;
  turnId: string | null;
  /**
   * Turns this session's log started and has not ended.
   *
   * Only these may be closed by the reload-recovery path. A cold page reports a final
   * assistant message tagged with whatever turn id it can read, and those ids are reused
   * turn after turn, so trusting the id alone let a reload append a second completion for
   * a turn that ended long before. Seeded from the log at pickup, so it is right after an
   * app restart and not only for a page that stayed open.
   */
  openTurns: Set<string>;
  /** Every local turn boundary already made durable, so at-least-once browser replay is idempotent. */
  knownTurnStarts: Set<string>;
  knownTurnEnds: Set<string>;
  /** Newest durable turn verdict, used only to interpret post-reload final/call evidence. */
  lastTurnOutcome: TurnOutcome | null;
  /** Start of that turn, so its final may predate a later detach/end while old finals cannot. */
  lastTurnStartedAt: number | null;
  /** ChatGPT request ids — one per server turn — that called tools while the open turn ran. */
  turnRequestIds: Set<string>;
  /**
   * The newest turn the page reported completed, with the server turns it was calling under.
   *
   * A request id is minted per server turn and outlives anything the page does: a reload,
   * a lost stream, a Stop click. So a call under one of these ids that *starts* after the
   * reported end is proof the end was the page's mistake — ChatGPT is still working that
   * turn — and the recorder reopens it rather than let Goal answer a turn that has not
   * finished. See reopenFalselyEndedTurn. In-memory only: an app restart inside such a turn
   * loses the proof, and the turn stays closed as the page reported it.
   */
  endedTurn: { turnId: string; startedAt: number | null; endedAt: number; requestIds: Set<string> } | null;
  /** Visible ChatGPT-native activity rows, updated by the page's stable row identity. */
  pageTools: Map<string, ProgressRecord>;
}

interface ProgressRecord {
  /** Seq of the first record written for this item — where every reader positions it. */
  seq: number;
  /** And the time it was first seen, for the same reason. */
  time: number;
  /** Most recent observation of this logical item, used only to validate a re-parent alias. */
  updatedAt: number;
  text: string;
  /** The turn it belongs to, so a re-stamp is only ever matched within its own turn. */
  turnId?: string;
}

const conversations = new Map<string, LiveConversation>();
/** One full first-sight initialization per ChatGPT conversation at a time. */
const sessionInitializations = new Map<string, Promise<string | null>>();
/**
 * conversationId → what this app opened that chat for, until the session exists.
 *
 * The extension reports the conversation it just typed a bootstrap into before the page
 * has told the app anything about that conversation, so the origin routinely arrives
 * first. Holding it here is what lets the session be named correctly at creation rather
 * than being created under the bootstrap prompt and renamed a moment later.
 */
const pendingOrigins = new Map<string, SessionOrigin>();
const MAX_PENDING_ORIGINS = 50;
/** Calls whose exact request id never resolves to a conversation are stored here. */
let unattributedSessionId: string | null = null;
let lastActiveSessionId: string | null = null;

/**
 * How long a session must have been closed before its return is worth a log line.
 *
 * Reloads, back/forward-cache round-trips and short disconnects all close and reopen a
 * session; only an absence long enough that the user might have gone and done something
 * else is news. The reopen itself always happens — this is purely about what is said.
 */
const REOPEN_NOTICE_MS = 60_000;

const listeners = new Set<() => void>();
let notifyTimer: NodeJS.Timeout | null = null;

export function onSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyChanged(): void {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    for (const listener of listeners) listener();
  }, 400);
  notifyTimer.unref?.();
}

export function recordingEnabled(): boolean {
  return getConfig().sessions.record;
}

// ------------------------------------------------------------- sessions

/**
 * The session a conversation writes to, created on first sight.
 *
 * First sight can race: two extension batches, or an extension batch and another recorder
 * path, may reach a conversation before either has installed its live map entry. Sharing the
 * whole initialization promise prevents both callers from independently passing the disk
 * lookup and creating two durable sessions for the same chat.
 */
export async function sessionForConversation(
  conversationId: string | null,
  title?: string
): Promise<string | null> {
  if (!conversationId) return initializeSessionForConversation(conversationId, title);

  const pending = sessionInitializations.get(conversationId);
  if (pending) {
    const sessionId = await pending;
    if (sessionId) {
      // A caller that arrived while initialization was in flight may carry evidence the first
      // caller did not yet have: command origin or the first authored user title. Apply both
      // after the shared initialization rather than dropping the later evidence.
      if (pendingOrigins.has(conversationId)) await applyOrigin(sessionId, conversationId);
      await promoteGenericTitle(sessionId, title);
    }
    return sessionId;
  }

  const initializing = initializeSessionForConversation(conversationId, title);
  sessionInitializations.set(conversationId, initializing);
  try {
    const sessionId = await initializing;
    // noteChatOrigin() can race the find/create window too. Its pending entry is authoritative
    // and must be stamped before this first caller returns even if it arrived after the
    // initializer sampled pendingOrigins.
    if (sessionId) {
      if (pendingOrigins.has(conversationId)) await applyOrigin(sessionId, conversationId);
      await promoteGenericTitle(sessionId, title);
    }
    return sessionId;
  } finally {
    if (sessionInitializations.get(conversationId) === initializing) {
      sessionInitializations.delete(conversationId);
    }
  }
}

/**
 * Reattaches an already-recorded ChatGPT conversation after process-memory loss.
 *
 * A browser `/activity` poll is first-hand evidence that the page is open, but it must not
 * create a brand-new session for a conversation this app has never recorded. Check durable
 * history first, then use the ordinary reopen path so live turn/session state is rebuilt from
 * the existing log exactly as if the page had just reported an observation.
 */
export async function restoreRecordedConversation(conversationId: string): Promise<string | null> {
  if (!recordingEnabled() || !conversationId) return null;
  const existing = conversations.get(conversationId);
  if (existing) return existing.sessionId;
  const known = await findSessionByConversation(conversationId);
  if (!known) return null;
  return sessionForConversation(conversationId);
}

/**
 * How long to let a resume's commit land before recording a conversation it may be about to
 * claim. Generous next to the milliseconds a commit actually takes, and bounded because a
 * commit that never lands must not stop the chat being recorded at all.
 */
const RESUME_COMMIT_SETTLE_MS = 5_000;

async function settleResumeCommit(): Promise<void> {
  const deadline = Date.now() + RESUME_COMMIT_SETTLE_MS;
  while (resumeOpeningChat() && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 50);
      timer.unref?.();
    });
  }
}

async function initializeSessionForConversation(
  conversationId: string | null,
  title?: string
): Promise<string | null> {
  if (!recordingEnabled()) return null;
  if (!conversationId) return ensureUnattributedSession();
  const existing = conversations.get(conversationId);
  if (existing) {
    lastActiveSessionId = existing.sessionId;
    if (pendingOrigins.has(conversationId)) await applyOrigin(existing.sessionId, conversationId);
    await promoteGenericTitle(existing.sessionId, title);
    return existing.sessionId;
  }
  // Reuse a session already recorded for this conversation, so closing and reopening
  // the tab continues the same history instead of fragmenting it.
  let known = await findSessionByConversation(conversationId);
  if (!known && resumeOpeningChat()) {
    // A compaction is opening its replacement chat right now, and this unknown conversation
    // may be it. Creating a session here is what breaks the move: the commit that follows
    // finds its own destination owned by a session it has never heard of and refuses to
    // rebind. Waiting is cheap and lossless — the commit is already in flight and takes
    // milliseconds, after which this conversation resolves to the session that was moved
    // onto it and the batch that triggered this is recorded in the right place. See
    // resume-gate.ts for what this cost the session it was written for.
    await settleResumeCommit();
    const moved = conversations.get(conversationId);
    if (moved) {
      lastActiveSessionId = moved.sessionId;
      return moved.sessionId;
    }
    known = await findSessionByConversation(conversationId);
  }
  if (!known && (await conversationWasSuperseded(conversationId))) {
    // Compact & Resume moved this chat's session onto its replacement. Whatever the old page
    // still reports — the brief re-rendered with its HTML, a lingering turn, the user typing
    // into it — is history of that one session, never a chat of its own: on 2026-09-02 the
    // brief's late re-render minted a second session holding nothing but the summary.
    // recordChatObservationsNow() files such messages into the lineage; nothing else may
    // mint a session for a conversation this app has already replaced.
    logInfo(`conversation ${conversationId} was replaced by Compact & Resume; its late observation gets no session of its own`);
    return null;
  }
  // A chat this app opened is named for the command that opened it. The alternative —
  // the first thing said in the chat — is this app's own bootstrap prompt.
  const origin = pendingOrigins.get(conversationId) ?? null;
  const summary =
    known ??
    (await createSession({
      conversationId,
      title: origin ? await titleForOrigin(origin) : title,
      origin
    }));
  if (origin && !known) pendingOrigins.delete(conversationId);
  // Reopening a chat that was closed earlier makes its session live again. Appending
  // to a session still stamped with an end time left the UI showing a finished session
  // that was visibly still growing.
  if (known && known.endedAt !== null) {
    const closedFor = Date.now() - known.endedAt;
    await reopenSession(known.id).catch(() => undefined);
    // Only worth saying when the session was actually away. A reload, a bfcache
    // round-trip or a brief disconnect closes and reopens within seconds and changes
    // nothing the user could act on; announcing each one filled the Activity log with
    // ten identical lines in seventy seconds across five tabs.
    if (closedFor >= REOPEN_NOTICE_MS) {
      logInfo(`session ${known.id} reopened — its ChatGPT conversation is active again`);
    }
  }
  const history = known
    ? await storedHistory(summary.id)
    : {
        openTurns: new Set<string>(),
        knownTurnStarts: new Set<string>(),
        knownTurnEnds: new Set<string>(),
        lastTurnStartedAt: null,
        activeTurnId: null,
        activeTurnStartedAt: null,
        pageTools: new Map<string, ProgressRecord>()
      };

  // `storedHistory()` can take long enough for Compact & Resume to durably move this exact
  // session from chat A to chat B while first-sight initialisation of A is still in flight.
  // The lookup at the top of this function is therefore no longer authority after that await.
  // Re-check the session itself immediately before publishing the live map and returning its
  // id. If durable metadata no longer names A, this stale initializer must publish nothing and
  // return nothing; a later observation from A can then take the normal "new session" path
  // rather than resurrecting the moved session behind B's back.
  if (known) {
    const current = await getSession(summary.id);
    if (!current || current.conversationId !== conversationId) {
      logInfo(
        `session ${summary.id} moved away from conversation ${conversationId} while that conversation was being restored; discarded stale live initialization`
      );
      return null;
    }
  }
  conversations.set(conversationId, {
    conversationId,
    sessionId: summary.id,
    // A running turn survives an app/content-script restart. The durable log is the only
    // component that can still know the old document's generation id, so restore it here
    // and let /activity hand it back to the replacement content script.
    turnStartedAt: history.activeTurnStartedAt,
    turnId: history.activeTurnId,
    openTurns: history.openTurns,
    knownTurnStarts: history.knownTurnStarts,
    knownTurnEnds: history.knownTurnEnds,
    lastTurnOutcome: summary.lastTurnOutcome,
    lastTurnStartedAt: history.lastTurnStartedAt,
    turnRequestIds: new Set<string>(),
    endedTurn: null,
    pageTools: history.pageTools
  });
  if (!known) {
    await appendEvent(summary.id, {
      time: Date.now(),
      source: 'extension',
      kind: 'session_start',
      conversationId,
      title: summary.title
    });
    logInfo(`session started for a ChatGPT conversation (${summary.id})`);
  }
  if (origin && known) await applyOrigin(summary.id, conversationId);
  if (known) await promoteGenericTitle(summary.id, title);
  if (known) {
    // There are two awaited metadata niceties above. A rebind that starts after the pre-publish
    // check can therefore still commit before this initializer returns. Re-check once more and
    // retract only our own stale A→S publication if durable ownership moved in that window.
    // No await follows this check before return, so a caller can never receive S from an
    // initializer that has already observed S belonging to B.
    const current = await getSession(summary.id);
    if (!current || current.conversationId !== conversationId) {
      const published = conversations.get(conversationId);
      if (published?.sessionId === summary.id) conversations.delete(conversationId);
      logInfo(
        `session ${summary.id} moved away from conversation ${conversationId} before restore completed; retracted stale live initialization`
      );
      return null;
    }
  }
  lastActiveSessionId = summary.id;
  notifyChanged();
  return summary.id;
}

/**
 * Fills in the title of a session that had to be created before ChatGPT exposed its first
 * authored user message.
 *
 * The exact default string is the proof that nobody has named this session yet. Any app
 * origin or any other title, including a manual rename, is authoritative and is left alone.
 */
async function promoteGenericTitle(sessionId: string, title?: string): Promise<void> {
  const next = title?.trim();
  if (!next) return;
  const summary = await getSession(sessionId);
  if (!summary || summary.origin || summary.title !== 'ChatGPT session') return;
  await renameSession(sessionId, next);
  notifyChanged();
}

/**
 * Prefer ChatGPT's generated human title over either the generic placeholder or the
 * temporary first-user-message fallback, without overwriting an origin or manual rename.
 * The fallback is reconstructed from the durable first user event, so this remains correct
 * across app restarts instead of depending on an in-memory "auto titled" flag.
 */
async function promoteConversationTitle(sessionId: string, title?: string): Promise<void> {
  const next = title?.trim().slice(0, 200);
  if (!next) return;
  const summary = await getSession(sessionId);
  if (!summary || summary.origin || summary.title === next) return;
  if (summary.title === 'ChatGPT session') {
    await renameSession(sessionId, next);
    notifyChanged();
    return;
  }
  const [firstUser] = await readEvents(sessionId, { kinds: ['user_message'], limit: 1 });
  const fallback = firstUser?.kind === 'user_message' ? firstUser.message.text.trim().slice(0, 80) : '';
  if (!fallback || summary.title !== fallback) return;
  await renameSession(sessionId, next);
  notifyChanged();
}

/**
 * Records that this app opened a chat, so the session can be named for the work rather
 * than for the bootstrap prompt.
 *
 * Called from the bridge the moment the extension acknowledges having typed a command
 * into a fresh tab — the only point at which the queued command and the conversation it
 * became are both known.
 */
export async function noteChatOrigin(conversationId: string, origin: SessionOrigin): Promise<void> {
  if (!conversationId) return;
  pendingOrigins.set(conversationId, origin);
  while (pendingOrigins.size > MAX_PENDING_ORIGINS) {
    const oldest = pendingOrigins.keys().next();
    if (oldest.done) break;
    pendingOrigins.delete(oldest.value);
  }
  if (!recordingEnabled()) return;
  const live = conversations.get(conversationId);
  const sessionId =
    live?.sessionId ??
    (await findSessionByConversation(conversationId))?.id ??
    null;
  // No session yet is the common case: the ack beats the page's first observation.
  // sessionForConversation picks the origin up out of pendingOrigins when it creates one.
  if (sessionId) await applyOrigin(sessionId, conversationId);
}

/** The name for a chat this app opened, taking a resume's name from its source. */
async function titleForOrigin(origin: SessionOrigin): Promise<string> {
  const source = origin.fromSessionId ? await getSession(origin.fromSessionId) : null;
  return originTitle(origin, source?.title ?? null);
}

/** Stamps a pending origin onto an existing session, once. */
async function applyOrigin(sessionId: string, conversationId: string): Promise<void> {
  const origin = pendingOrigins.get(conversationId);
  if (!origin) return;
  pendingOrigins.delete(conversationId);
  const summary = await getSession(sessionId);
  // Already stamped: a worker's bootstrap can be acknowledged more than once, and a
  // second stamp would rename a session that has since become the user's to name.
  if (!summary || summary.origin) return;
  await setSessionOrigin(sessionId, origin, await titleForOrigin(origin)).catch((err: Error) =>
    logWarn(`could not name the ${origin.kind} session: ${err.message}`)
  );
  logInfo(`session ${sessionId} named for the ${origin.kind} chat this app opened`);
  notifyChanged();
}

/** What a session's own log already says, for a conversation being picked up again. */
interface StoredHistory {
  /** Turns this log started and never ended — the only ones a recovery may close. */
  openTurns: Set<string>;
  /** Every durable turn start, including starts whose turn has already ended. */
  knownTurnStarts: Set<string>;
  /** Every durable turn end, used to make at-least-once browser replay idempotent. */
  knownTurnEnds: Set<string>;
  /** Durable start time of the newest turn that ended in the recovered tail. */
  lastTurnStartedAt: number | null;
  /** Newest still-open local generation, so a reloaded page can adopt it after app restart. */
  activeTurnId: string | null;
  /** Durable start time of activeTurnId. */
  activeTurnStartedAt: number | null;
  /** Latest stable ChatGPT-native activity row by website thought/message identity. */
  pageTools: Map<string, ProgressRecord>;
}

/**
 * Reads what a session already contains.
 *
 * Read once when a conversation is picked up again, so both de-duplication and turn
 * recovery survive an app restart rather than only a page that was never reloaded.
 *
 * The open-turn ledger is what stops a reload from resurrecting a finished turn. A cold
 * page reports a final assistant message carrying whatever turn id the page has, and
 * those ids are reused; without knowing which turns this log actually left open, the
 * recovery path appended a second completion for a turn that had ended many turns ago.
 */
async function storedHistory(sessionId: string): Promise<StoredHistory> {
  const openTurns = new Set<string>();
  const knownTurnStarts = new Set<string>();
  const knownTurnEnds = new Set<string>();
  let lastTurnEndedAt: number | null = null;
  let lastTurnStartedAt: number | null = null;
  const turnStarts = new Map<string, number>();
  const pageTools = new Map<string, ProgressRecord>();
  try {
    const events = await readRecentEvents(sessionId, 4096, {
      kinds: ['turn_start', 'turn_end', 'page_tool'],
      maxBytes: 2 * 1024 * 1024
    });
    for (const event of events) {
      if (event.kind === 'turn_start') {
        if (event.turnId) {
          knownTurnStarts.add(event.turnId);
          openTurns.add(event.turnId);
          turnStarts.set(event.turnId, event.time);
        }
      } else if (event.kind === 'turn_end') {
        if (event.turnId) {
          knownTurnEnds.add(event.turnId);
          openTurns.delete(event.turnId);
        }
        if (lastTurnEndedAt === null || event.time >= lastTurnEndedAt) {
          lastTurnEndedAt = event.time;
          lastTurnStartedAt = event.turnId ? turnStarts.get(event.turnId) ?? null : null;
        }
      } else if (event.kind === 'page_tool' && event.messageId) {
        const held = pageTools.get(event.messageId);
        if (!held) {
          pageTools.set(event.messageId, {
            seq: event.origin ?? event.seq,
            time: event.time,
            updatedAt: event.time,
            text: event.label,
            ...(event.turnId ? { turnId: event.turnId } : {})
          });
        } else {
          held.updatedAt = Math.max(held.updatedAt, event.time);
          held.text = event.label;
          if (!held.turnId && event.turnId) held.turnId = event.turnId;
        }
      }
    }
  } catch (err) {
    logWarn(`could not read stored session history: ${(err as Error).message}`);
  }
  let activeTurnId: string | null = null;
  let activeTurnStartedAt: number | null = null;
  for (const turnId of openTurns) {
    const startedAt = turnStarts.get(turnId) ?? null;
    if (startedAt === null) continue;
    if (activeTurnStartedAt === null || startedAt > activeTurnStartedAt) {
      activeTurnId = turnId;
      activeTurnStartedAt = startedAt;
    }
  }
  return { openTurns, knownTurnStarts, knownTurnEnds, lastTurnStartedAt, activeTurnId, activeTurnStartedAt, pageTools };
}

async function ensureUnattributedSession(): Promise<string | null> {
  if (!recordingEnabled()) return null;
  if (unattributedSessionId) return unattributedSessionId;
  const summary = await createSession({ title: 'Unattributed activity' });
  unattributedSessionId = summary.id;
  lastActiveSessionId = summary.id;
  await appendEvent(summary.id, {
    time: Date.now(),
    source: 'app',
    kind: 'session_start',
    conversationId: null,
    title: summary.title
  });
  notifyChanged();
  return summary.id;
}

/** The session the UI opens by default: whatever was written to most recently. */
export function activeSessionId(): string | null {
  return lastActiveSessionId;
}

/** The live recorded session owned by one concrete ChatGPT conversation. */
export function sessionIdForConversation(conversationId: string | null): string | null {
  if (!conversationId) return null;
  return conversations.get(conversationId)?.sessionId ?? null;
}

/** The unattributed stream, when one has been created. Shown as its own row in the UI. */
export function unattributedSession(): string | null {
  return unattributedSessionId;
}

/**
 * `activeTurnId` is the generation id of the turn this conversation currently has open, or
 * null. It exists so a reloaded content script can adopt the turn it is standing in the
 * middle of instead of minting a second one.
 *
 * The extension's turn ids are `g-<run>-<epoch>-<n>`, where `<run>` is a namespace random
 * per *document*. That is what makes them unique, and it is also why a reload cannot
 * reconstruct one: the old document's namespace died with it. So the new document sees a
 * stop button, believes it is watching a turn nobody has reported, and opens another —
 * splitting one assistant run across two local lifecycle generations. This app holds the
 * durable half of that lifecycle identity, so this is where it has to come from.
 */
export function liveConversations(): Array<{
  conversationId: string;
  sessionId: string;
  generating: boolean;
  activeTurnId: string | null;
  /**
   * How many turns of this chat have finished. Only ever goes up, for the life of the entry.
   *
   * `knownTurnEnds` is the recorder's idempotency set for turn ends, so its size is already an
   * exact count of them - including the ends recovered from a final assistant message after a
   * page reload. It answers the one question a turn id cannot: whether the turn that was live a
   * moment ago is the turn that is live now. A reload mints a fresh local id for a generation
   * that never ended, so id inequality means "or the page came back", while this counter moves
   * only when a turn is actually over.
   */
  endedTurns: number;
  /** Newest durable turn verdict; null when this chat has never reported an end. */
  lastTurnOutcome: TurnOutcome | null;
}> {
  return [...conversations.values()].map((entry) => ({
    conversationId: entry.conversationId,
    sessionId: entry.sessionId,
    generating: entry.turnStartedAt !== null,
    activeTurnId: entry.turnStartedAt !== null ? entry.turnId : null,
    endedTurns: entry.knownTurnEnds.size,
    lastTurnOutcome: entry.lastTurnOutcome
  }));
}

/**
 * Shortens the evidence waits for the test suite, and only for it.
 *
 * These windows exist because a real browser reports a request id up to several seconds
 * after the connector already answered. The suite has no browser: it hands the recorder its
 * evidence in the same process, microseconds later, or deliberately never. So every test
 * that asserts "this ends up unattributed" paid the full twenty seconds to prove a
 * negative, and a handful of them dominated the whole run.
 *
 * Never set outside the test runner, so production keeps the measured windows. The value is
 * also clamped to the production one, so this can only ever make a wait shorter.
 */
export function evidenceWindow(production: number): number {
  const raw = process.env.CLF_EVIDENCE_MS;
  if (raw === undefined) return production;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, production) : production;
}

/**
 * How long a completed MCP call may wait for its exact page-side request id observation.
 *
 * This wait is request-specific: only the identical normalized x-request-id can satisfy it.
 * Chrome-off or missing evidence ends in Unattributed activity rather than a tool, time or
 * generation guess.
 *
 * Exported because it is also the depth to which *enforcement* has to resolve identity. Any
 * rule that refuses a call by conversation — the user's chat block — must not settle for less
 * evidence than the timeline the user is looking at will settle for, or the app ends up showing
 * a call attributed to a chat whose calls it claims to be refusing. See kernel.ts.
 */
export const REQUEST_ID_GRACE_MS = evidenceWindow(20_000);

/**
 * Late exact request-id evidence can arrive after a call already fell into Unattributed.
 *
 * Correlation is deliberately durable and request-specific, so once that evidence exists
 * there is no reason to leave the old call stranded until the next app restart. Coalesce a
 * burst of page evidence into one deterministic repair pass. This never uses timestamps,
 * active tabs, tool names or turn position: `repairDeterministicAttribution()` moves only
 * calls carrying the exact request id whose owner the page has proved.
 */
let attributionRepairTimer: NodeJS.Timeout | null = null;
let attributionRepairRequested = false;
let attributionRepairChain: Promise<void> = Promise.resolve();

function startAttributionRepair(): void {
  if (!attributionRepairRequested) return;
  attributionRepairRequested = false;
  const run = attributionRepairChain.then(async () => {
    try {
      await repairDeterministicAttribution();
    } catch (err) {
      logWarn(`late request attribution repair failed: ${(err as Error).message}`);
    }
    if (attributionRepairRequested) startAttributionRepair();
  });
  attributionRepairChain = run.then(
    () => undefined,
    () => undefined
  );
}

/**
 * Queues the startup repair on the same serialized chain as late request-evidence repairs.
 * `flushRecorder()` waits this chain during shutdown, so maintenance can never escape the final
 * recorder/session flush just because startup deliberately did not block the first window on it.
 */
export function queueDeterministicAttributionRepair(): void {
  attributionRepairRequested = true;
  if (attributionRepairTimer) {
    clearTimeout(attributionRepairTimer);
    attributionRepairTimer = null;
  }
  startAttributionRepair();
}

function scheduleAttributionRepair(): void {
  attributionRepairRequested = true;
  if (attributionRepairTimer) return;
  attributionRepairTimer = setTimeout(() => {
    attributionRepairTimer = null;
    startAttributionRepair();
  }, 250);
  attributionRepairTimer.unref?.();
}

/**
 * Feeds the one request-correlation registry.
 *
 * The outer conversation id comes from the tab URL. `fiberConversationId` comes from the
 * React tree that also supplied these request messages. When both exist and disagree, none
 * of the batch is ownership evidence: choosing either side would silently cross-attribute.
 *
 * Disagreement discards the batch and nothing else. A page whose URL and React tree disagree
 * is a page caught in the middle of something, which is the common case rather than the
 * corrupt one: a chat being switched, a model still mounted from the conversation before it,
 * a fresh chat whose client-side thread id is not yet the server's. Every one of those
 * resolves a moment later, so the batch is worth nothing as evidence and worth nothing as a
 * verdict either.
 */
function noteCallEvidence(
  conversationId: string,
  sessionId: string,
  fiberConversationId: string | null | undefined,
  calls: readonly PageCallEvidence[],
  at: number
): void {
  if (fiberConversationId && fiberConversationId !== conversationId) {
    // Name the discarded ids. Without them this line says a batch was dropped but not
    // *which* calls it cost, so a chat whose every call lands in Unattributed activity
    // reads identically in the log to one that lost a single stale sighting — and the
    // 2026-08-21 outage, where this branch swallowed an entire conversation's evidence
    // because the page turn id was absent, was invisible here for exactly that reason.
    const dropped = calls.map((call) => call.requestId).filter((id): id is string => !!id);
    logWarn(
      `request attribution: ignoring ${calls.length} sighting(s) — URL conversation ${conversationId} disagrees ` +
        `with Fiber conversation ${fiberConversationId}. Later agreeing evidence can still prove these calls.` +
        (dropped.length > 0 ? ` Discarded request ids: ${dropped.join(', ')}.` : '')
    );
    return;
  }
  const observedAt = Math.min(at, Date.now());
  const evidencedCalls = calls.filter((call): call is PageCallEvidence & { requestId: string } => !!call.requestId);
  // One ChatGPT workflow request id can legitimately cover dozens of connector calls, so read
  // the owners once up front and report a refusal once per id rather than once per call.
  const priorOwners = new Map(
    evidencedCalls.map((call) => [call.requestId, requestCorrelation(call.requestId)?.conversationId ?? null] as const)
  );
  const results = observeRequestCorrelations(
    evidencedCalls.map((call) => ({
      requestId: call.requestId,
      conversationId,
      sessionId,
      messageId: call.messageId,
      tool: call.tool,
      observedAt
    }))
  );
  const refusals = new Set<string>();
  for (const [index, call] of evidencedCalls.entries()) {
    const result = results[index]!;
    if (result === 'refused') {
      // A note, not a problem. Nothing is lost when a claim is refused - the calls under this id
      // go on reaching the conversation that proved it - so this must not join the count of
      // things wrong with the run. It was a warning while a contradiction destroyed the owner,
      // which was a real fault and was worth shouting about.
      if (!refusals.has(call.requestId)) {
        refusals.add(call.requestId);
        logInfo(
          `request attribution: ${call.requestId} stays with conversation ${priorOwners.get(call.requestId)}` +
            `; conversation ${conversationId} claimed it too and was refused`
        );
      }
    } else if (result === 'stored') {
      logInfo(`request attribution: ${call.requestId} -> conversation ${conversationId}`);
      if (unattributedSessionId) scheduleAttributionRepair();
    }
  }
}

/**
 * The chat a recorded session belongs to, when exactly one live chat is writing to it.
 *
 * Used by compaction to find the workspace of the chat being compacted, which it otherwise
 * has no way to name: a compaction request identifies a session, and the mapping only runs
 * the other way. Ambiguity is answered with null rather than a pick, for the same reason it
 * is everywhere else in the workspace code.
 */
export function soleConversationForSession(sessionId: string): string | null {
  const owners = [...conversations.values()].filter((entry) => entry.sessionId === sessionId);
  return owners.length === 1 ? owners[0]!.conversationId : null;
}

export function freshCallOrigin(tool: string, after: number, requestId: string | null = null): string | null {
  void tool;
  void after;
  return requestCorrelation(requestId)?.conversationId ?? null;
}

export async function awaitFreshCallOrigin(
  tool: string,
  after: number,
  within: number,
  options: { exact?: boolean; requestId?: string | null } = {}
): Promise<string | null> {
  void tool;
  void after;
  void options.exact;
  const correlation = await awaitRequestCorrelation(options.requestId ?? null, within);
  return correlation?.conversationId ?? null;
}

/**
 * Repairs every call in an old Unattributed bucket whose deterministic owner is now known.
 *
 * 1.8.1 could forget a previously-proved request id after ten minutes. A historical bucket can
 * also contain several workflows because all unknown work shared one global sink. Repair is
 * therefore per exact request id, not all-or-nothing: calls with a proven owner move to that
 * conversation, while calls that still have no proof remain in Unattributed activity. Several
 * proven owners in one bucket are split correctly; no tool name, clock or active-tab guess is
 * ever involved.
 *
 * Calls keep their original callId, so a crash after copying some rows but before rewriting the
 * old bucket is idempotent on the next launch. Assets are copied before any history is removed.
 */
export async function repairDeterministicAttribution(): Promise<{ sessions: number; calls: number }> {
  if (!recordingEnabled()) return { sessions: 0, calls: 0 };
  let repairedSessions = 0;
  let repairedCalls = 0;

  for (const summary of await listAllSessions()) {
    if (summary.conversationId !== null || summary.title !== 'Unattributed activity') continue;
    const events = await readEvents(summary.id);
    const scannedThroughSeq = events.reduce((highest, event) => Math.max(highest, event.seq), 0);
    const tools = events.filter(
      (event): event is Extract<SessionEvent, { kind: 'tool_call' }> => event.kind === 'tool_call'
    );
    if (tools.length === 0) continue;
    if (events.some((event) => event.kind !== 'session_start' && event.kind !== 'tool_call')) continue;

    const owned = new Map<
      string,
      Array<{ event: Extract<SessionEvent, { kind: 'tool_call' }>; conversationId: string }>
    >();
    const unknown: Extract<SessionEvent, { kind: 'tool_call' }>[] = [];
    for (const event of tools) {
      // A superseded request is already fully attributed and deliberately isolated here.
      // Replaying the same correlation must never turn retired execution into live history.
      if (event.call.attributionMethod === 'superseded' || event.call.attribution === 'superseded') {
        unknown.push(event);
        continue;
      }
      const requestId = event.call.requestId;
      const correlation = requestId ? requestCorrelation(requestId) : null;
      if (!correlation) {
        unknown.push(event);
        continue;
      }
      const group = owned.get(correlation.sessionId);
      const placed = { event, conversationId: correlation.conversationId };
      if (group) group.push(placed);
      else owned.set(correlation.sessionId, [placed]);
    }
    if (owned.size === 0) continue;

    // Resolve all destinations and pre-copy every referenced file before appending anything.
    // If one source asset is gone, leave the bucket untouched rather than making history less
    // complete merely to clean up its presentation.
    const destinations = new Map<string, string>();
    let assetsComplete = true;
    try {
      for (const [targetSessionId, group] of owned) {
        const target = await getSession(targetSessionId);
        if (!target || targetSessionId === summary.id) {
          assetsComplete = false;
          break;
        }
        destinations.set(targetSessionId, targetSessionId);

        const assets = new Map<string, string>();
        for (const { event } of group) {
          if (event.call.args.assetId) assets.set(event.call.args.assetId, 'text/plain');
          if (event.call.result.assetId) assets.set(event.call.result.assetId, 'text/plain');
          for (const asset of event.call.assets ?? []) assets.set(asset.id, asset.mimeType);
        }
        for (const [assetId, mimeType] of assets) {
          const data = await readAsset(summary.id, assetId);
          if (!data) {
            assetsComplete = false;
            break;
          }
          await writeAsset(targetSessionId, data, mimeType);
        }
        if (!assetsComplete) break;
      }
    } catch (err) {
      assetsComplete = false;
      logWarn(`could not repair unattributed session ${summary.id}: ${(err as Error).message}`);
    }
    if (!assetsComplete) continue;

    let firstTargetSessionId: string | null = null;
    for (const [sessionKey, group] of owned) {
      const targetSessionId = destinations.get(sessionKey)!;
      firstTargetSessionId ??= targetSessionId;
      const existingCallIds = new Set(
        (await readEvents(targetSessionId, { kinds: ['tool_call'] }))
          .filter((event): event is Extract<SessionEvent, { kind: 'tool_call' }> => event.kind === 'tool_call')
          .map((event) => event.call.callId)
      );
      for (const { event, conversationId } of group) {
        if (existingCallIds.has(event.call.callId)) continue;
        await appendEvent(targetSessionId, {
          time: event.time,
          source: 'mcp',
          kind: 'tool_call',
          call: {
            ...event.call,
            attribution: 'request_id',
            conversationId,
            attributionMethod: 'request_id'
          },
          ...(event.agent ? { agent: event.agent } : {}),
          ...(event.turnId ? { turnId: event.turnId } : {})
        });
        existingCallIds.add(event.call.callId);
        repairedCalls += 1;
      }
    }

    if (unknown.length === 0) {
      await deleteSession(summary.id);
      if (unattributedSessionId === summary.id) unattributedSessionId = null;
      if (lastActiveSessionId === summary.id) lastActiveSessionId = firstTargetSessionId;
    } else {
      await rewriteUnattributedToolCalls(summary.id, unknown, scannedThroughSeq);
      if (unattributedSessionId === null) unattributedSessionId = summary.id;
    }
    repairedSessions += 1;
    logInfo(
      `repaired ${tools.length - unknown.length} deterministically attributed call(s) from session ${summary.id}; ` +
        `${unknown.length} remain unknown`
    );
  }

  if (repairedSessions > 0) notifyChanged();
  return { sessions: repairedSessions, calls: repairedCalls };
}

// ---------------------------------------------------------------- helpers

/**
 * Stores text for one event: bounded inline, complete in an asset when it overflows.
 *
 * `truncated` means "not all of it is on this line", never "the rest is gone" — the
 * whole redacted original goes next to the log and its id travels in the event, so the
 * exact arguments of an edit or the exact output of a build stay recoverable. The one
 * case where material really is lost is text beyond even the overflow limit, and then
 * the inline note says exactly that instead of implying a complete record.
 */
async function storeText(
  sessionId: string,
  text: string,
  cap: number
): Promise<StoredText> {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (value.length <= cap) return { text: value, truncated: false, chars: value.length };
  const assetId = await writeOverflowText(sessionId, value);
  const note = assetId
    ? `\n…[${value.length - cap} more characters stored in full as ${assetId}]`
    : `\n…[${value.length - cap} more characters were too large to store and are lost]`;
  return {
    text: `${value.slice(0, cap)}${note}`,
    truncated: true,
    chars: value.length,
    ...(assetId ? { assetId } : {})
  };
}

/**
 * Fields that must never reach disk, whatever tool they arrive on.
 *
 * Nothing in the multi-agent surface carries a credential any more — an agent *is* the
 * conversation it runs in, and that id is recorded on purpose — so this is now a guard
 * against a field named like a secret arriving on some other tool, rather than a rule about
 * agent identity. Writing one into events.jsonl would publish it to session_history, to the
 * Activity feed the extension is sent, and to anything built from the raw log.
 */
const CREDENTIAL_FIELDS = new Set(['secret']);

/**
 * Removes the argument values that must never be written to disk.
 *
 * Environment overrides can carry credentials, a base64 blob is megabytes of noise,
 * and clipboard text is the one input the user may not have meant to hand over.
 * Everything else is stored verbatim: the point of the record is exact recovery.
 */
function redactArgs(tool: string, args: unknown): unknown {
  if (!args || typeof args !== 'object') return args;
  const copy: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  if (copy['env'] && typeof copy['env'] === 'object') {
    copy['env'] = Object.fromEntries(Object.keys(copy['env'] as object).map((key) => [key, '***']));
  }
  if (typeof copy['dataBase64'] === 'string') {
    copy['dataBase64'] = `<${(copy['dataBase64'] as string).length} base64 characters not stored>`;
  }
  // Clipboard text arrives inside computer's action list, so the redaction follows the
  // action rather than the tool name: the text the user copied is theirs, and one of these
  // steps buried in a batch of clicks must not be the thing that writes it to disk.
  if (tool === 'computer' && Array.isArray(copy['actions'])) {
    copy['actions'] = (copy['actions'] as unknown[]).map((action) => {
      if (!action || typeof action !== 'object') return action;
      const step = action as Record<string, unknown>;
      if (step['type'] !== 'write_clipboard' || typeof step['text'] !== 'string') return action;
      return { ...step, text: `<${(step['text'] as string).length} characters not stored>` };
    });
  }
  for (const field of Object.keys(copy)) {
    if (CREDENTIAL_FIELDS.has(field)) copy[field] = '<removed>';
  }
  return copy;
}

function redactResult(tool: string, text: string): string {
  // The other half of the clipboard rule: what was read comes back as its own line in
  // computer's reply, and only that line is dropped, so the rest of the result — which
  // actions ran, where the pointer ended up — still says what happened.
  if (tool === 'computer' && text.includes('Clipboard read ')) {
    return text
      .split('\n')
      .map((line) =>
        line.startsWith('Clipboard read ')
          ? `${line.slice(0, line.indexOf(':') + 1)} <clipboard text not stored>`
          : line
      )
      .join('\n');
  }
  return text;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 0) ?? 'null';
  } catch {
    return '"<arguments could not be serialised>"';
  }
}

// -------------------------------------------------------------- tool calls

export interface ToolContentPart {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolCallInput {
  tool: string;
  args: unknown;
  content: readonly ToolContentPart[];
  outcome: ToolOutcome;
  durationMs: number;
  startedAt: number;
  evidence?: CallEvidence;
  agent?: string | null;
  /** Agent to bind to this call's conversation once it is identified. See CallContext. */
  bind?: string | null;
  /**
   * ChatGPT's id for the HTTP request that carried this call, when it sent one.
   *
   * The page's evidence for the same call carries the same id, so this places the call in
   * the conversation that issued it outright — including when two workers call one tool at
   * the same instant, which no window or ordering rule can separate. See inbound.ts.
   */
  requestId?: string | null;
  /** Exact conversation already proven for this request by the dispatcher, when available. */
  conversationId?: string | null;
  /** Durable local session principal carried by the exact request correlation, when available. */
  sessionId?: string | null;
  /** A successful worker finish report is a hard activity boundary, not fresh work. */
  endsActivity?: boolean;
}

/** Writing runs one at a time, so the log keeps call order. See recordToolCall. */
let recordChain: Promise<unknown> = Promise.resolve();

/**
 * Records one MCP tool call.
 *
 * Never throws into the caller: a broken recorder must not break the connector, so a
 * storage failure is logged and the tool result is returned to ChatGPT regardless.
 *
 * The work is queued rather than run inline. Attribution can have to wait a moment for
 * the page to report the exact request-id/message evidence that proves where the call came from, and nothing
 * ChatGPT is waiting on may wait on the browser: with sequential file and command tools
 * a second of that per call is the difference between a companion that feels immediate
 * and one that feels broken. The connector fires this and moves on; the returned promise
 * is for tests and for the flush at quit.
 *
 * The two halves are queued differently on purpose. Every call's request-specific evidence
 * window opens the moment the call lands, all of them at once, so a burst of calls costs one
 * grace period rather than one per call. Only the write is serialised, in call order, so the
 * log stays in order. There is no shared pool of rows/evidence to claim.
 *
 * The cost of not blocking the connector is a crash window: a call whose evidence has not
 * resolved yet exists only in memory, so a power loss inside those couple of seconds
 * loses it, where the old inline write would not have. Quitting flushes. That is the
 * whole of the tradeoff, and it is bounded by REQUEST_ID_GRACE_MS.
 */
export function recordToolCall(input: ToolCallInput): Promise<ToolCallRecord | null> {
  if (!recordingEnabled()) return Promise.resolve(null);
  if (input.conversationId) {
    const live = conversations.get(input.conversationId);
    const correlation = input.requestId ? requestCorrelation(input.requestId) : null;
    const target: Target = {
      conversationId: input.conversationId,
      sessionId:
        input.sessionId ??
        (correlation?.conversationId === input.conversationId ? correlation.sessionId : null),
      attribution: 'request_id',
      turnId: live?.turnId ?? null
    };
    if (input.bind) bindAgentConversation(input.bind, input.conversationId);
    // Exact attribution skips the browser wait, not the write-order/quit-flush barrier. The
    // old fast path called fileToolCall() directly, so a large first result could finish its
    // asset/text work after a tiny second call and be appended second despite being invoked
    // first; flushRecorder() also had no promise covering it. Queue the write like every other
    // call while keeping attribution itself immediate.
    const filed = recordChain.then(() => fileToolCall(input, target));
    recordChain = filed.then(
      () => undefined,
      () => undefined
    );
    return filed;
  }

  // Late browser evidence is the only wait left in attribution. It can prove this exact
  // request after the MCP handler already completed, but no different request/page state can
  // ever satisfy it. Chrome-off or unmatched modern ids therefore end in Unattributed.
  const attributing = input.requestId
    ? awaitRequestCorrelation(input.requestId, REQUEST_ID_GRACE_MS).then((correlation) => {
        const conversationId = correlation?.conversationId ?? null;
        // Say which request id gave up, not just that something did. `unattributed` is the
        // one outcome whose cause always lives in the browser half of the join, so the log
        // has to carry the id that the page never confirmed — it is the only handle anyone
        // has for matching this against what the extension believed it sent.
        if (!conversationId) {
          logWarn(
            `request attribution: no page evidence for ${input.requestId} within ` +
              `${REQUEST_ID_GRACE_MS}ms; filing ${input.tool} under Unattributed activity`
          );
        }
        if (input.bind && conversationId) bindAgentConversation(input.bind, conversationId);
        return {
          conversationId,
          sessionId: correlation?.sessionId ?? null,
          attribution: conversationId ? ('request_id' as const) : ('unattributed' as const),
          turnId: conversationId ? conversations.get(conversationId)?.turnId ?? null : null
        };
      })
    : Promise.resolve<Target>({ conversationId: null, sessionId: null, attribution: 'unattributed', turnId: null });
  const filed = recordChain.then(async () => fileToolCall(input, await attributing));
  recordChain = filed.then(
    () => undefined,
    () => undefined
  );
  return filed;
}

/** Waits for every queued tool call to be written. Called before the app quits. */
export async function flushRecorder(): Promise<void> {
  // Every call appends its eventual write to recordChain synchronously, before its attribution
  // promise resolves. One snapshot therefore already covers every call admitted before shutdown;
  // the old second await was leftover from the earlier design that queued only after attribution.
  await recordChain.catch(() => undefined);
  if (attributionRepairTimer) {
    clearTimeout(attributionRepairTimer);
    attributionRepairTimer = null;
    startAttributionRepair();
  }
  await attributionRepairChain.catch(() => undefined);
}

async function fileToolCall(input: ToolCallInput, target: Target): Promise<ToolCallRecord | null> {
  if (!recordingEnabled()) return null;
  try {
    // Exact request evidence proves who called; it does not keep a replaced frontend
    // executable. A remains part of the durable transcript after A -> B, but any *new* call
    // from A is an incident, not new history in B's live context. Preserve the proof on the
    // row while routing it to the one non-chat stream, and make that verdict terminal so the
    // ordinary late-correlation repair cannot put it back later.
    if (
      target.conversationId &&
      (await conversationAttachment(target.conversationId, target.sessionId)) === 'superseded'
    ) {
      target = { ...target, attribution: 'superseded', turnId: null };
    }
    const evidence = input.evidence ?? currentCall()?.evidence ?? emptyEvidence();
    const sessionId = await targetSession(target);
    if (!sessionId) return null;
    // A proven request can outlive the swarm object and even the worker tab that issued it.
    // Request-id correlation still recovers the exact old conversation/session in that case,
    // but the live broker can no longer answer `agentForCaller()`. Worker origin is already
    // durable first-hand evidence: the bridge stamped it when this app opened and bound the
    // worker chat. Recover only that worker id, never a guessed prime/current agent.
    let eventAgent = input.agent ?? null;
    if (target.conversationId) {
      const summary = await getSession(sessionId);
      const origin = summary?.origin;
      if (origin?.kind === 'worker' && origin.agentId && /^worker-\d+$/.test(origin.agentId)) {
        // Request/session ownership is older and stronger than whatever live broker role this
        // conversation may hold now. A stale request from worker-1 must stay worker-1 even if
        // the same ChatGPT conversation later participates in another run as prime.
        eventAgent = origin.agentId;
      }
    }

    const textParts = input.content.filter((part) => part.type === 'text').map((part) => part.text ?? '');
    // Scrub before summarisation too. A failed tool may put the first line of its
    // result into ActivitySummary.detail; scrubbing only in storeText would keep the
    // raw capability out of args/result while still leaking it through that summary to
    // events.jsonl, the renderer and the extension activity feed.
    const resultText = redactResult(input.tool, textParts.join('\n'));
    const assets: AssetRef[] = [...evidence.assets];
    for (const part of input.content) {
      if (part.type !== 'image' || !part.data) continue;
      const asset = await storeImage(sessionId, part.data, part.mimeType ?? 'image/png');
      if (asset) assets.push(asset);
    }

    const summary: ActivitySummary = summarizeToolCall({
      tool: input.tool,
      args: input.args,
      evidence,
      outcome: input.outcome,
      durationMs: input.durationMs,
      resultHead: resultText.split('\n', 1)[0] ?? ''
    });

    const call: ToolCallRecord = {
      callId: randomUUID(),
      tool: input.tool,
      attribution: target.attribution,
      requestId: input.requestId ?? null,
      conversationId: target.conversationId,
      attributionMethod:
        target.attribution === 'superseded'
          ? 'superseded'
          : target.conversationId && input.requestId
            ? 'request_id'
            : 'unattributed',
      args: await storeText(sessionId, safeJson(redactArgs(input.tool, input.args)), MAX_TOOL_ARGS_CHARS),
      result: await storeText(sessionId, resultText, MAX_TOOL_RESULT_CHARS),
      outcome: input.outcome,
      durationMs: input.durationMs,
      summary,
      ...(evidence.changes.length > 0 ? { changes: evidence.changes } : {}),
      ...(assets.length > 0 ? { assets } : {}),
      ...(input.endsActivity === true ? { endsActivity: true as const } : {})
    };

    await appendEvent(sessionId, {
      time: input.startedAt,
      source: 'mcp',
      kind: 'tool_call',
      call,
      ...(eventAgent ? { agent: eventAgent } : {}),
      ...(target.turnId ? { turnId: target.turnId } : {})
    });
    const reopenedTurnId = await reopenFalselyEndedTurn(
      sessionId,
      target.conversationId,
      input.requestId ?? null,
      input.startedAt,
      eventAgent
    );
    notifyChanged();
    try {
      const filed = await getSession(sessionId);
      const currentConversation =
        target.conversationId !== null &&
        filed?.conversationId === target.conversationId &&
        !(await conversationWasSuperseded(target.conversationId));
      attributionListener?.(
        target.conversationId,
        sessionId,
        currentConversation,
        input.startedAt,
        input.endsActivity === true,
        filed?.lastAssistantFinalAt ?? null,
        // The one thing an unattributed call still carries: the server turn it belongs to.
        input.requestId ?? null,
        reopenedTurnId
      );
    } catch (err) {
      logWarn(`call attribution listener failed: ${(err as Error).message}`);
    }
    return call;
  } catch (err) {
    logWarn(`session recorder could not store a tool call: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Files one attributed call against its conversation's turn lifecycle.
 *
 * While a turn is open the call's request id is remembered as one of the server turns that
 * turn runs under. With no turn open, the same request id calling again — starting after the
 * end the page reported — is the earliest fact that contradicts that end: ChatGPT does not
 * mint a new request id for a turn it is still working, so the turn never ended, and only the
 * page's view of it did. Live 2026-09-02: a reload mid-turn adopted the open turn and closed it
 * "completed" four seconds later from interim prose; the same request id then called tools for
 * twenty-four more minutes, and Goal typed the next message against an answer that had never
 * been given. The reopening is app-authored and durable — a second `turn_start` for the same
 * id, named as such — so the page's real end is accepted afterwards, the projection hands the
 * open id back to the next document, and Goal is told (through the attribution listener) that
 * the decision it was drafting was owed to nothing.
 *
 * Deliberately narrow: a call that *started* before the reported end is the ordinary in-flight
 * call finishing late and proves nothing; a different request id is a different server turn.
 * Returns the reopened turn id, or null when this call changed no lifecycle.
 */
async function reopenFalselyEndedTurn(
  sessionId: string,
  conversationId: string | null,
  requestId: string | null,
  startedAt: number,
  agent: string | null
): Promise<string | null> {
  if (!conversationId || !requestId) return null;
  const live = conversations.get(conversationId);
  if (!live || live.sessionId !== sessionId) return null;
  if (live.turnStartedAt !== null) {
    live.turnRequestIds.add(requestId);
    return null;
  }
  const ended = live.endedTurn;
  if (!ended || !ended.requestIds.has(requestId) || startedAt <= ended.endedAt) return null;
  await appendEvent(sessionId, {
    time: startedAt,
    source: 'app',
    kind: 'turn_start',
    turnId: ended.turnId,
    detail: 'the same ChatGPT request kept calling tools after the page reported this turn completed',
    ...(agent ? { agent } : {})
  });
  live.endedTurn = null;
  live.knownTurnEnds.delete(ended.turnId);
  live.openTurns.add(ended.turnId);
  live.turnId = ended.turnId;
  live.turnStartedAt = ended.startedAt ?? startedAt;
  live.lastTurnOutcome = null;
  live.turnRequestIds = new Set(ended.requestIds);
  logInfo(
    `session ${sessionId} reopened turn ${ended.turnId} — request ${requestId} kept calling tools after the page reported it completed`
  );
  return ended.turnId;
}

interface Target {
  conversationId: string | null;
  /** Exact durable session epoch carried by request correlation, when proven. */
  sessionId: string | null;
  attribution: CallAttribution;
  turnId: string | null;
}

/** Set by the agent broker so a worker's calls land in that worker's own session. */
let agentConversationLookup: (agent: string) => string | null = () => null;
let agentBinder: (agent: string, conversationId: string) => void = () => undefined;

export function setAgentConversationLookup(lookup: (agent: string) => string | null): void {
  agentConversationLookup = lookup;
}

/**
 * Set by the bridge. Called once per filed call with the verdict this module just reached: the
 * conversation the request-id join proved, or null for a call that finished the grace with no
 * page evidence at all. Both are already durable when it runs.
 *
 * One hook rather than two, because the two facts are one fact — which chats' reporting works
 * and which activity nobody claimed — and splitting them invites a second attribution clock
 * somewhere else. Nothing here decides what a verdict is worth; the bridge owns that.
 */
let attributionListener:
  | ((
      conversationId: string | null,
      sessionId: string,
      currentConversation: boolean,
      startedAt: number,
      endsActivity: boolean,
      lastAssistantFinalAt: number | null,
      requestId: string | null,
      reopenedTurnId: string | null
    ) => void)
  | null = null;

export function setCallAttributionListener(
  listen:
    | ((
        conversationId: string | null,
        sessionId: string,
        currentConversation: boolean,
        startedAt: number,
        endsActivity: boolean,
        lastAssistantFinalAt: number | null,
        requestId: string | null,
        /** The turn this call reopened, when it proved the page's completed end false. */
        reopenedTurnId: string | null
      ) => void)
    | null
): void {
  attributionListener = listen;
}

/** Set by the agent broker, for the deferred prime binding in recordToolCall. */
export function setAgentBinder(bind: (agent: string, conversationId: string) => void): void {
  agentBinder = bind;
}

function bindAgentConversation(agent: string, conversationId: string): void {
  try {
    agentBinder(agent, conversationId);
  } catch (err) {
    logWarn(`could not bind ${agent} to its conversation: ${(err as Error).message}`);
  }
}

function agentConversation(agent: string): string | null {
  try {
    return agentConversationLookup(agent);
  } catch {
    return null;
  }
}

/**
 * The session an event is physically written to.
 *
 * Anything that could not be tied to a conversation goes to the unattributed stream.
 * The previous behaviour — fall back to whichever session was written to last — was
 * the dangerous one: with two workers generating at once it appended one agent's calls
 * into the other's raw history, and nothing downstream could tell that had happened.
 */
async function targetSession(target: Target): Promise<string | null> {
  if (target.attribution === 'superseded') return ensureUnattributedSession();
  if (target.conversationId) {
    if (target.sessionId) {
      const exact = await getSession(target.sessionId);
      if (exact && exact.chatIds.includes(target.conversationId)) return exact.id;
      logWarn(
        `request attribution session ${target.sessionId} for conversation ${target.conversationId} is unavailable; refusing to downgrade to a newer conversation epoch`
      );
      return null;
    }
    const live = conversations.get(target.conversationId);
    if (live) return live.sessionId;
    // Request-id ownership is allowed to outlive the browser tab and a Compact & Resume
    // rebind. Append to that durable session without calling sessionForConversation(), whose
    // semantics correctly mean "the page reopened" and would clear endedAt. Historical chat
    // lineage is safe here only because target.conversationId came from exact request proof.
    const durable = await findSessionByConversation(target.conversationId, { includeHistorical: true });
    if (durable) return durable.id;
    // First ever evidence for this exact conversation can still be an MCP call. There is no
    // existing session to resurrect, so creating one through the ordinary path is correct.
    return sessionForConversation(target.conversationId);
  }
  return ensureUnattributedSession();
}

async function storeImage(sessionId: string, base64: string, mimeType: string): Promise<AssetRef | null> {
  try {
    const data = Buffer.from(base64, 'base64');
    if (data.length === 0 || data.length > MAX_ASSET_BYTES) return null;
    const asset = await writeAsset(sessionId, data, mimeType);
    return asset;
  } catch (err) {
    logWarn(`session asset not stored: ${(err as Error).message}`);
    return null;
  }
}

// ------------------------------------------------------- extension events

/** One observation from the ChatGPT page. Validated by the bridge before it lands. */
export interface ChatObservation {
  kind:
    | 'conversation_title'
    | 'user_message'
    | 'assistant_message'
    | 'page_tool'
    | 'turn_start'
    | 'turn_end'
    | 'chat_error'
    | 'tool_evidence';
  time: number;
  /** True when `time` is ChatGPT's own authored create_time, not local observation time. */
  authoredTime?: boolean;
  /** True only for the newest DOM user row that this document proved was just sent. */
  authoredNow?: boolean;
  /** True only when the current page generation owns this assistant revision now. */
  activeNow?: boolean;
  text?: string;
  /** ChatGPT's already-rendered authored markup for this same logical message. */
  renderedHtml?: string;
  messageId?: string;
  turnId?: string;
  final?: boolean;
  state?: 'streaming' | 'final';
  /** Internal React conversation id used only to cross-check the URL conversation id. */
  fiberConversationId?: string;
  outcome?: TurnOutcome;
  detail?: string;
  /** Browser terminal proof; app-owned Goal policy is applied only after this is durable. */
  goalEligible?: boolean;
  /** chat_error only: a recognised transport failure inside an assistant turn. */
  recoverable?: boolean;
  /** tool_evidence only: the connector requests this turn's message model holds. */
  calls?: PageCallEvidence[];
}

/**
 * One connector request, as the page's own message model describes it.
 *
 * Deliberately tiny. Request id is the ownership key. Tool/name/order remain diagnostics;
 * nothing here carries an argument value, result body, or other hidden request payload.
 */
export interface PageCallEvidence {
  /** ChatGPT's message id for the request, which is what makes this idempotent. */
  messageId: string;
  tool: string;
  /** Position within the turn, recorded only for diagnostics/presentation. */
  order: number;
  /** Whether the page has seen a result come back yet. Recorded for diagnosis only. */
  answered: boolean;
  /**
   * ChatGPT's own request id, and its own creation time in seconds.
   *
   * The id is what ties this request to the MCP call it issued: the connector request
   * arrives carrying the same `wfr_…`. `at` cannot do that job — it is when the extension
   * *observed* the row, a poll tick that is phase-shifted per tab, so it cannot even order
   * two workers' requests reliably, whatever it looks like it is doing.
   */
  requestId?: string | null;
  createTime?: number | null;
}

/**
 * Stores one visible ChatGPT-native activity row, superseding the record it already has.
 *
 * The same contract as `recordProgress`, for the same reason. ChatGPT rewrites an activity
 * row's label as the step finishes, and the extension used to name each row by its position
 * in the turn plus a hash of that label — so "Inspecting project files" and "Inspected
 * project files" were two different rows, and a re-layout that shifted the row's index made
 * a third. One recorded session held fifty-four `page_tool` events for what the page had
 * shown as roughly a dozen steps.
 */
async function recordPageTool(
  sessionId: string,
  live: LiveConversation | undefined,
  item: ChatObservation,
  base: { time: number; source: 'extension'; turnId?: string; agent?: string }
): Promise<boolean> {
  const id = item.messageId;
  const label = (item.text ?? '').slice(0, 300).trim();
  if (!id || !label) return false;
  if (!live) {
    await appendEvent(sessionId, { ...base, kind: 'page_tool', messageId: id, label });
    return true;
  }

  const held = live.pageTools.get(id);
  if (held && held.text === label) return false;

  const event = await appendEvent(sessionId, {
    ...base,
    time: held ? held.time : base.time,
    kind: 'page_tool',
    messageId: id,
    label,
    ...(held ? { origin: held.seq } : {})
  });
  live.pageTools.set(id, {
    seq: held ? held.seq : event.seq,
    time: held ? held.time : base.time,
    updatedAt: base.time,
    text: label
  });
  return true;
}

const observationChains = new Map<string, Promise<void>>();

export function recordChatObservations(
  conversationId: string,
  observations: readonly ChatObservation[],
  agent?: string | null
): Promise<{
  sessionId: string | null;
  stored: number;
  activity: { meaningful: boolean; working: boolean; terminal: boolean };
  goalCandidates: Array<{ replyId: string; turnId: string; eventSeq: number }>;
}> {
  const prior = observationChains.get(conversationId) ?? Promise.resolve();
  const work = prior.then(() => recordChatObservationsNow(conversationId, observations, agent));
  const tracked = work.then(
    () => undefined,
    () => undefined
  );
  observationChains.set(conversationId, tracked);
  void tracked.finally(() => {
    if (observationChains.get(conversationId) === tracked) observationChains.delete(conversationId);
  });
  return work;
}

/**
 * The session a replaced Compact & Resume source chat still writes its prose to.
 *
 * Null for every conversation that is current somewhere or unknown; those take the ordinary
 * path. Only a chat that is a past frontend of exactly one session, and current on none, has
 * a lineage to file into.
 */
async function supersededLineage(conversationId: string): Promise<string | null> {
  if (!conversationId || !(await conversationWasSuperseded(conversationId))) return null;
  if (await findSessionByConversation(conversationId)) return null;
  const lineage = await findSessionByConversation(conversationId, { includeHistorical: true });
  return lineage && lineage.conversationId !== conversationId ? lineage.id : null;
}

/**
 * What a replaced chat may still add to its session: its messages, and nothing else.
 *
 * The session's live turn, activity clock, Goal obligations and title belong to the chat
 * that replaced it, so a lingering page on the old chat records prose only — the brief's
 * final rendering arriving after the commit, or the user carrying on in the old tab — and
 * moves none of the projections the replacement now owns.
 */
async function recordSupersededMessages(
  conversationId: string,
  sessionId: string,
  observations: readonly ChatObservation[]
): Promise<number> {
  let stored = 0;
  for (const item of observations) {
    // Request evidence still joins a request to this retired chat, so its call is refused as
    // superseded — a message that names the handover — rather than waiting out the identity
    // window and being refused as nobody's.
    if (item.kind === 'tool_evidence') {
      if (item.calls && item.calls.length > 0) {
        noteCallEvidence(conversationId, sessionId, item.fiberConversationId, item.calls, item.time);
      }
      continue;
    }
    if (!item.messageId) continue;
    const base = {
      time: item.time,
      source: 'extension' as const,
      ...(item.turnId ? { turnId: item.turnId } : {})
    };
    let written: { changed: boolean } | null = null;
    if (item.kind === 'user_message') {
      written = await upsertMessageEvent(
        sessionId,
        {
          ...base,
          kind: 'user_message',
          message: await storeText(sessionId, item.text ?? '', MAX_USER_MESSAGE_CHARS),
          messageId: item.messageId
        },
        { preferTime: item.authoredTime === true }
      );
    } else if (item.kind === 'assistant_message') {
      const state = item.state ?? (item.final === true ? 'final' : 'streaming');
      written = await upsertMessageEvent(
        sessionId,
        {
          ...base,
          kind: 'assistant_message',
          message: await storeText(sessionId, item.text ?? '', 256_000),
          ...(item.renderedHtml
            ? { renderedHtml: await storeText(sessionId, item.renderedHtml, 120_000) }
            : {}),
          messageId: item.messageId,
          state,
          final: state === 'final'
        },
        { preferTime: item.authoredTime === true }
      );
    }
    if (written?.changed) stored++;
  }
  if (stored > 0) notifyChanged();
  return stored;
}

async function recordChatObservationsNow(
  conversationId: string,
  observations: readonly ChatObservation[],
  agent?: string | null
): Promise<{
  sessionId: string | null;
  stored: number;
  activity: { meaningful: boolean; working: boolean; terminal: boolean };
  goalCandidates: Array<{ replyId: string; turnId: string; eventSeq: number }>;
}> {
  const activity = { meaningful: false, working: false, terminal: false };
  if (!recordingEnabled()) return { sessionId: null, stored: 0, activity, goalCandidates: [] };
  if (!conversations.has(conversationId)) {
    const lineage = await supersededLineage(conversationId);
    if (lineage) {
      const stored = await recordSupersededMessages(conversationId, lineage, observations);
      return { sessionId: lineage, stored, activity, goalCandidates: [] };
    }
  }
  let firstUser: ChatObservation | undefined;
  let pageTitle: ChatObservation | undefined;
  const explicitEnds = new Set<string>();
  const batchTurnStarts = new Map<string, number>();
  let batchUncertainEndId: string | null = null;
  // This batch is hot while ChatGPT is streaming. Collect the three facts needed before the
  // write loop in one pass instead of find + find + filter + map (the latter two also allocated
  // an intermediate array for every batch).
  for (const item of observations) {
    if (!firstUser && item.kind === 'user_message') firstUser = item;
    if (!pageTitle && item.kind === 'conversation_title') pageTitle = item;
    if (item.kind === 'turn_start' && item.turnId) batchTurnStarts.set(item.turnId, item.time);
    if (item.kind === 'turn_end' && item.turnId) {
      explicitEnds.add(item.turnId);
      if (item.outcome !== 'completed' && item.outcome !== 'stopped') batchUncertainEndId = item.turnId;
    }
  }
  const sessionId = await sessionForConversation(
    conversationId,
    pageTitle?.text?.trim() || (firstUser?.text ? firstUser.text.slice(0, 80) : undefined)
  );
  if (!sessionId) return { sessionId: null, stored: 0, activity, goalCandidates: [] };
  const live = conversations.get(conversationId);
  let stored = 0;
  let recoveredGoalSeen = false;
  const goalCandidates: Array<{ replyId: string; turnId: string; eventSeq: number }> = [];
  // A cold/reloaded page can discover that a turn finished while the content script was
  // absent. There is then a new final assistant message but no live `generating -> false`
  // transition for content.js to report, and nothing would close the turn.
  //
  // What this must not do is invent a lifecycle event out of a page-supplied turn id. The
  // page reuses those ids, so a reload showing the whole transcript again carries a final
  // tagged with an id whose turn ended many turns ago; closing it appended a second
  // completed turn 6 in the middle of turn 11. So the recovery is state-based: it may only
  // close a turn this very log opened and never ended, which `openTurns` knows even across
  // an app restart. Everything else is backfill — historical prose, stored as prose,
  // changing no turn's lifecycle.
  let recoveredFinal: ChatObservation | undefined;
  // Find the newest recovery candidate without cloning and reversing the complete batch.
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const item = observations[index]!;
    if (
      item.kind === 'assistant_message' &&
      item.final === true &&
      item.turnId &&
      !explicitEnds.has(item.turnId) &&
      live?.openTurns.has(item.turnId) === true
    ) {
      recoveredFinal = item;
      break;
    }
  }

  for (const item of observations) {
    const base = {
      time: item.time,
      source: 'extension' as const,
      ...(item.turnId ? { turnId: item.turnId } : {}),
      ...(agent ? { agent } : {})
    };
    switch (item.kind) {
      case 'conversation_title':
        await promoteConversationTitle(sessionId, item.text);
        break;
      case 'user_message': {
        // A message with no ChatGPT identity cannot participate in the canonical transcript.
        // Dropping it is safer than minting a local id that can collide on reload.
        if (!item.messageId) continue;
        const written = await upsertMessageEvent(sessionId, {
          ...base,
          kind: 'user_message',
          message: await storeText(sessionId, item.text ?? '', MAX_USER_MESSAGE_CHARS),
          messageId: item.messageId
        }, { preferTime: item.authoredTime === true });
        if (!written.changed) continue;
        if (item.authoredNow === true) {
          activity.meaningful = true;
          activity.working = true;
        }
        break;
      }
      case 'assistant_message': {
        if (!item.messageId) continue;
        const state = item.state ?? (item.final === true ? 'final' : 'streaming');
        // A reload can destroy the document-local generation id after this recorder already
        // made the only honest lifecycle verdict it could: unknown/failed/interrupted/stalled.
        // A new stable final reply is stronger evidence about Goal than that lost id, but an
        // old final seen merely by opening an idle chat is not. The prior uncertain boundary is
        // therefore the exact fence; the stable reply id is the durable exactly-once identity.
        const batchUncertainStartedAt = batchUncertainEndId
          ? batchTurnStarts.get(batchUncertainEndId) ??
            (live?.turnId === batchUncertainEndId ? live.turnStartedAt : null)
          : null;
        const priorUncertainStartedAt =
          live?.turnStartedAt === null &&
          live.lastTurnOutcome !== null &&
          live.lastTurnOutcome !== 'completed' &&
          live.lastTurnOutcome !== 'stopped'
            ? live.lastTurnStartedAt
            : null;
        const uncertainTurnStartedAt = batchUncertainStartedAt ?? priorUncertainStartedAt;
        const terminalActivity =
          state === 'final' &&
          (item.activeNow === true ||
            item === recoveredFinal ||
            (uncertainTurnStartedAt !== null && item.time >= uncertainTurnStartedAt));
        const workingActivity = state !== 'final' && item.activeNow === true;
        const recoveredGoalEligible =
          state === 'final' &&
          !item.turnId &&
          live !== undefined &&
          uncertainTurnStartedAt !== null &&
          item.time >= uncertainTurnStartedAt;
        const goalEligible = item.goalEligible === true || recoveredGoalEligible;
        const written = await upsertMessageEvent(sessionId, {
          ...base,
          kind: 'assistant_message',
          // Keep normal 15k–20k-token handoff-style answers inline rather than making the
          // local transcript itself look truncated while the continuation carries more.
          message: await storeText(sessionId, item.text ?? '', 256_000),
          ...(item.renderedHtml
            ? { renderedHtml: await storeText(sessionId, item.renderedHtml, 120_000) }
            : {}),
          messageId: item.messageId,
          state,
          final: state === 'final',
          ...(goalEligible && state === 'final' ? { goalEligible: true } : {})
        }, { preferTime: item.authoredTime === true });
        if (
          written.event.kind === 'assistant_message' &&
          written.event.goalEligible === true &&
          state === 'final' &&
          written.event.messageId
        ) {
          goalCandidates.push({
            replyId: written.event.messageId,
            turnId: written.event.turnId ?? `reply:${written.event.messageId}`.slice(0, 200),
            eventSeq: written.event.origin ?? written.event.seq
          });
        }
        if (recoveredGoalEligible && live) {
          // This is an in-memory verdict for later call/reload decisions, not a fabricated
          // turn_end. The canonical message keeps goalEligible monotonically, so an HTTP 503
          // can still replay the same obligation even after this stronger final evidence wins.
          recoveredGoalSeen = true;
        }
        if (!written.changed && item !== recoveredFinal) continue;
        if (terminalActivity || workingActivity) activity.meaningful = true;
        if (terminalActivity) activity.terminal = true;
        if (workingActivity) activity.working = true;
        if (item === recoveredFinal && item.turnId) {
          await appendEvent(sessionId, {
            time: item.time,
            source: 'extension',
            kind: 'turn_end',
            turnId: item.turnId,
            outcome: 'completed',
            detail: 'recovered from a final assistant message after the ChatGPT page reloaded',
            ...(agent ? { agent } : {})
          });
          // The durable append is the dedupe fact. Mutating this projection first made a
          // transient disk failure suppress the service worker's at-least-once retry.
          if (live) {
            live.openTurns.delete(item.turnId);
            // Only if this is the turn the page is still holding open. A recovery for an
            // earlier turn says nothing about what is generating now.
            if (live.turnId === item.turnId) {
              live.turnStartedAt = null;
              live.turnId = null;
            }
          }
          if (live) live.knownTurnEnds.add(item.turnId);
          if (live) {
            live.lastTurnOutcome = 'completed';
          }
          stored++;
        }
        break;
      }
      case 'page_tool': {
        const written = await recordPageTool(sessionId, live, item, base);
        if (!written) continue;
        break;
      }
      case 'chat_error':
        await appendEvent(sessionId, {
          ...base,
          kind: 'chat_error',
          message: await storeText(sessionId, item.text ?? '', 2000)
        });
        activity.meaningful = true;
        break;
      case 'turn_start':
        // Lifecycle without a durable local id is not a lifecycle boundary a later reader
        // can reconcile. In particular, a reloaded page once emitted an unnamed turn_end
        // between two named generations; accepting it cleared the live turn and made the
        // next observation open a third copy of the same ChatGPT response. Modern content.js
        // always mints/adopts a local id before announcing a start, so an unnamed boundary is
        // stale/legacy noise and must fail closed here as well.
        if (!item.turnId) continue;
        // /events is intentionally at-least-once. A response can be lost after commit, so the
        // service worker may replay the exact same local lifecycle id. Never turn that transport
        // retry into a second durable boundary or reopen a turn that already ended.
        if (live?.knownTurnStarts.has(item.turnId) || live?.knownTurnEnds.has(item.turnId)) continue;
        await appendEvent(sessionId, { ...base, kind: 'turn_start' });
        // Commit before publishing the lifecycle projection. If append rejects, the same
        // browser event remains eligible for its normal at-least-once retry.
        if (live) {
          live.knownTurnStarts.add(item.turnId);
          // Turn lifecycle is presentation/recovery state only in 1.8. It is never consulted
          // for MCP ownership, so a replayed journal timestamp cannot misattribute a call.
          live.turnStartedAt = item.time;
          live.turnId = item.turnId;
          live.openTurns.add(item.turnId);
          // A page-authored start is a new send; whatever end came before it is settled.
          live.turnRequestIds = new Set<string>();
          live.endedTurn = null;
        }
        activity.meaningful = true;
        activity.working = true;
        break;
      // Also not stored, and for the same reason: this is the page describing which calls
      // it made, which is a fact about attribution rather than something that happened in
      // the chat. The calls themselves are recorded by the connector, once each.
      case 'tool_evidence':
        if (item.calls && item.calls.length > 0) {
          noteCallEvidence(conversationId, sessionId, item.fiberConversationId, item.calls, item.time);
        }
        continue;
      case 'turn_end':
        // An unnamed end closes nothing durable and, worse, used to clear whichever named
        // turn happened to be live. Ignore it. A stale named end is still useful history for
        // the turn it names, but it must not tear down a newer active generation.
        if (!item.turnId) continue;
        if (live?.knownTurnEnds.has(item.turnId)) continue;
        await appendEvent(sessionId, {
          ...base,
          kind: 'turn_end',
          outcome: item.outcome ?? 'unknown',
          ...(item.detail ? { detail: item.detail } : {})
        });
        // As above, durable journal state owns idempotency; in-memory state follows it.
        if (live) {
          const endedStartedAt = live.turnId === item.turnId ? live.turnStartedAt : null;
          live.knownTurnEnds.add(item.turnId);
          live.openTurns.delete(item.turnId);
          live.lastTurnOutcome = item.outcome ?? 'unknown';
          live.lastTurnStartedAt = endedStartedAt;
          // Only a completed end can be proven false by a later call: it is the one verdict
          // Goal acts on, and the one a reloaded page fabricates. A stop is the user's own
          // decision and the failure outcomes already belong to recovery.
          live.endedTurn =
            live.turnId === item.turnId && item.outcome === 'completed'
              ? { turnId: item.turnId, startedAt: endedStartedAt, endedAt: item.time, requestIds: live.turnRequestIds }
              : null;
          live.turnRequestIds = new Set<string>();
          if (live.turnId === item.turnId) {
            live.turnStartedAt = null;
            live.turnId = null;
          }
        }
        activity.meaningful = true;
        if (item.outcome !== 'unknown') activity.terminal = true;
        break;
    }
    stored++;
  }
  if (recoveredGoalSeen && live) live.lastTurnOutcome = 'completed';
  notifyChanged();
  return { sessionId, stored, activity, goalCandidates };
}

/** Records something the app itself decided, e.g. a saved handoff. */
export async function recordNote(sessionId: string, text: string, continuation?: string): Promise<void> {
  if (!recordingEnabled()) return;
  await appendEvent(sessionId, {
    time: Date.now(),
    source: 'app',
    kind: 'note',
    message: await storeText(sessionId, text, 4000),
    ...(continuation ? { continuation } : {})
  }).catch(() => undefined);
  notifyChanged();
}

/**
 * Records one app-owned status whose later snapshots replace its text in-place.
 *
 * The first durable snapshot owns chronology. Callers retain that anchor and reuse the
 * progress id, so a retry can move from trying to failed to successful without leaving three
 * contradictory rows in the transcript.
 */
export async function recordProgress(
  sessionId: string,
  progressId: string,
  text: string,
  anchor?: { seq: number; time: number },
  turnId?: string | null
): Promise<{ seq: number; time: number } | null> {
  if (!recordingEnabled() || !progressId) return null;
  const time = anchor?.time ?? Date.now();
  // `turnId` is the turn this row happened inside, when the caller can name one. A row that
  // names its turn is a member of that turn on every reader — the desktop transcript and the
  // page's Overwrite alike — and sits in it chronologically like a tool call; a row that names
  // none belongs to no turn and is placed between turns instead.
  const event = await appendEvent(sessionId, {
    time,
    source: 'app',
    kind: 'progress',
    progressId,
    ...(anchor ? { origin: anchor.seq } : {}),
    ...(turnId ? { turnId } : {}),
    message: await storeText(sessionId, text, 4000)
  }).catch(() => null);
  if (!event) return null;
  notifyChanged();
  return anchor ?? { seq: event.seq, time };
}

/**
 * Records a brokered message in the relevant agent's own session.
 *
 * Called twice per message and on purpose. `sent` goes into the sender's history when
 * the broker accepts it; `delivered` goes into the recipient's when the recipient
 * proves it received it. Without the second one a worker's report would live only in
 * the worker's session and the broker's volatile queue, so compacting the prime — the
 * exact thing Compact & Resume does while workers keep running — would produce a brief
 * that omits everything the workers had told it.
 *
 * A message can be offered several times before it is acknowledged; only the single
 * acknowledgement produces a `delivered` record, so retries never duplicate history.
 */
export async function recordAgentMessage(
  message: AgentMessage,
  delivery: 'sent' | 'delivered',
  ownerConversationId: string | null = null
): Promise<void> {
  if (!recordingEnabled()) return;
  const owner = delivery === 'sent' ? message.from : message.to;
  try {
    // A friendly agent id is unique only inside one active incarnation. Dormant histories are
    // intentionally allowed to each own their own `prime`/`worker-1`, so an acknowledged message
    // from an exact MCP caller must carry that conversation through instead of resolving the
    // same friendly id against whichever other prime happens to be active now.
    const conversationId = ownerConversationId ?? agentConversation(owner);
    const sessionId = conversationId ? await sessionForConversation(conversationId) : await ensureUnattributedSession();
    if (!sessionId) return;
    await appendEvent(sessionId, {
      time: delivery === 'sent' ? message.time : Date.now(),
      source: 'app',
      kind: 'agent_message',
      agent: owner,
      messageId: message.id,
      from: message.from,
      to: message.to,
      message: await storeText(sessionId, message.text, MAX_MESSAGE_CHARS),
      delivery
    });
    notifyChanged();
  } catch (err) {
    logWarn(`session recorder could not store an agent message: ${(err as Error).message}`);
  }
}

export async function recordHandoff(
  sessionId: string,
  handoffId: string,
  chars: number,
  reason: string
): Promise<void> {
  await appendEvent(sessionId, {
    time: Date.now(),
    source: 'app',
    kind: 'handoff',
    handoffId,
    chars,
    reason
  });
  notifyChanged();
}

/**
 * Repairs the narrow crash window after a continuation WAL committed its prepared handoff
 * but before the session timeline published it.
 *
 * Normal publication is one append and does not pay for a journal scan. Recovery is rare and
 * must be idempotent: blindly appending an old recovered handoff would make it the session's
 * newest handoff again even when a later compaction already exists. Search by the durable
 * handoff id first, then append only when that exact semantic event is absent.
 */
export async function ensureHandoffRecorded(
  sessionId: string,
  handoffId: string,
  chars: number,
  reason: string
): Promise<boolean> {
  const existing = await readEvents(sessionId, { kinds: ['handoff'] });
  if (existing.some((event) => event.kind === 'handoff' && event.handoffId === handoffId)) return false;
  await recordHandoff(sessionId, handoffId, chars, reason);
  return true;
}

/**
 * Called when a conversation page goes away.
 *
 * Browser lifetime owns the *binding* — which tab speaks for this conversation — and
 * nothing else. `pagehide` cannot tell a reload from a navigation from a real close, and
 * in every one of those cases ChatGPT keeps the server generation running while no page
 * is watching it. So a detach is not evidence about the turn, not even weak evidence:
 * synthesising a `turn_end` here closed the exact turn the recovery path was supposed to
 * reopen, and a closed turn can never be resolved by later real evidence. The open turn
 * stays open; the detach is recorded as a note, which the timeline shows without ending
 * anything, and recordChatObservations writes the real terminal when the chat comes back.
 */
export async function closeConversation(conversationId: string): Promise<void> {
  const live = conversations.get(conversationId);
  if (!live) return;
  if (live.turnStartedAt !== null) {
    await appendEvent(live.sessionId, {
      time: Date.now(),
      source: 'extension',
      kind: 'note',
      ...(live.turnId ? { turnId: live.turnId } : {}),
      message: await storeText(
        live.sessionId,
        'the ChatGPT page detached while this turn was still open; the turn stays open until real evidence ends it',
        4000
      )
    }).catch(() => undefined);
  }
  conversations.delete(conversationId);
  await endSession(live.sessionId).catch(() => undefined);
  notifyChanged();
}

/**
 * Points the live recorder at the ChatGPT conversation that has replaced this session's.
 *
 * The in-memory half of the Compact & Resume commit. Chat B is a different page, so
 * everything that describes the *page* starts empty — its open turns and page-native row
 * identities belong to chat A's DOM and would otherwise contaminate B's first observations.
 * Everything that describes the *session* —
 * which is to say the session id itself, and through it the whole recorded history — is
 * exactly what does not move.
 *
 * Chat A's entry is dropped outright. A stale tab still sitting on A must not go on
 * appending into a session that has moved; without the mapping its next observation starts
 * a fresh session of its own, which is the honest outcome.
 *
 * Pure map work and total, because the commit calls it only once the durable session write
 * has landed and nothing after that point is allowed to fail.
 */
export function rebindConversation(sessionId: string, fromConversationId: string, toConversationId: string): void {
  const previous = conversations.get(fromConversationId);
  if (previous?.sessionId === sessionId) conversations.delete(fromConversationId);
  conversations.set(toConversationId, {
    conversationId: toConversationId,
    sessionId,
    turnStartedAt: null,
    turnId: null,
    openTurns: new Set<string>(),
    knownTurnStarts: new Set<string>(),
    knownTurnEnds: new Set<string>(),
    lastTurnOutcome: null,
    lastTurnStartedAt: null,
    turnRequestIds: new Set<string>(),
    endedTurn: null,
    pageTools: new Map()
  });
  lastActiveSessionId = sessionId;
  notifyChanged();
}

/**
 * Detaches a session from everything still pointing at it, before it is deleted.
 *
 * Deleting a session whose ChatGPT tab is still open used to leave the conversation
 * mapped to a folder that no longer existed, so the next observation from that tab
 * appended into nothing and recording for that chat silently stopped. Forgetting the
 * mapping means the next event starts a fresh session instead, which is the only
 * outcome that keeps recording alive.
 */
export function forgetSession(sessionId: string): string[] {
  const affected: string[] = [];
  for (const [conversationId, entry] of conversations) {
    if (entry.sessionId !== sessionId) continue;
    conversations.delete(conversationId);
    affected.push(conversationId);
  }
  if (unattributedSessionId === sessionId) unattributedSessionId = null;
  if (lastActiveSessionId === sessionId) lastActiveSessionId = null;
  if (affected.length > 0) {
    logInfo(`session ${sessionId} deleted while live; ${affected.length} conversation(s) will start a new session`);
  }
  return affected;
}

/** Rough token estimate for a session, from the text actually stored. */
export async function sessionTokens(sessionId: string): Promise<number> {
  const summary = await getSession(sessionId);
  return summary?.estimatedTokens ?? 0;
}

export function estimate(text: string): number {
  return estimateTokens(text);
}

/** Test seam. */
export function resetRecorderForTests(): void {
  resetCorrelationRegistryForTests();
  conversations.clear();
  observationChains.clear();
  sessionInitializations.clear();
  pendingOrigins.clear();
  unattributedSessionId = null;
  lastActiveSessionId = null;
  if (attributionRepairTimer) {
    clearTimeout(attributionRepairTimer);
    attributionRepairTimer = null;
  }
  attributionRepairRequested = false;
  attributionRepairChain = Promise.resolve();
  agentConversationLookup = () => null;
  agentBinder = () => undefined;
  // The attribution listener is deliberately not cleared here: it belongs to the bridge's
  // start/stop lifecycle, and a recorder reset between tests must not silently unwire it.
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
}

export function markSessionActive(sessionId: string): void {
  lastActiveSessionId = sessionId;
}

export type { SessionSummary, SessionEvent };
