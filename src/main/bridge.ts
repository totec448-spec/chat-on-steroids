/**
 * The local bridge between the Chrome extension and this app.
 *
 * A second loopback server, separate from the MCP endpoint, because the two have
 * opposite requirements: the MCP endpoint refuses any browser origin on purpose,
 * while this one exists to be called by a browser extension.
 *
 * What keeps it safe:
 *   · 127.0.0.1 only, never 0.0.0.0
 *   · the only unauthenticated routes are /hello (a fixed identifying string) and
 *     /pair, which issues the token to a caller on 127.0.0.1 — see the route for what
 *     that deliberately does and does not buy
 *   · every other route needs the bearer token issued by /pair, compared in
 *     constant time, and stored encrypted rather than in config.json
 *   · the Origin must be a chrome-extension:// origin, so a web page cannot drive it
 *   · bodies are capped and requests are rate limited
 *
 * It is deliberately not a general control API. It accepts observations about a
 * ChatGPT conversation and hands back activity summaries and queued commands. It
 * cannot read a file, run anything, or change a permission.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { BridgeStatus } from '../shared/types.js';
import { CHAT_SILENCE_MS, CONTINUATION_MARKER, type SessionEvent, type SessionOrigin } from '../shared/session.js';
import { isChatBlocked } from './session/blocked-chats.js';
export { CHAT_ACTIVE_MS, CHAT_SILENCE_MS } from '../shared/session.js';
import { getConfig, updateConfig } from './config.js';
import { getSecret, secureStorageStatus, setSecret } from './secrets.js';
import {
  acceptGoalReplyNow,
  ackGoalDraftNow,
  applyGoalSwitch,
  beginGoalDraft,
  discardPreparedGoalDraft,
  draftOpeningMessage,
  goalKeyPresent,
  goalDraftBusy,
  goalArmedFor,
  goalObjectiveFor,
  goalPendingReplyFor,
  goalSwitchFor,
  goalViewFor,
  pendingGoalReplies,
  retireGoalDrafts,
  retireGoalDraftsFor,
  setGoalReplyActiveNow,
  setGoalObjectiveNow,
  setGoalSwitchNow,
  startGoalDraft
} from './goal.js';
import { logInfo, logWarn } from './logger.js';
import {
  closeConversation,
  liveConversations,
  noteChatOrigin,
  recordAgentMessage,
  recordChatObservations,
  recordProgress,
  restoreRecordedConversation,
  setCallAttributionListener,
  type ChatObservation,
  type PageCallEvidence
} from './session/recorder.js';
import {
  autoCompactionReady,
  conversationWasSuperseded,
  findSessionByConversation,
  getSession,
  readRecentEvents,
  sessionDurableModifiedAt
} from './session/store.js';
import { inFlightMcpRequests, runningToolCalls, settlingToolCalls } from './mcp/call-context.js';
import { nativeHandoffPrompt } from './session/handoff-prompt.js';
import { briefShortfall, resumeBootstrapText } from './session/handoff.js';
import {
  PRIME_ID,
  agentConversation,
  agentForConversation,
  agentInfoForOwnedConversation,
  agentForOwnedConversation,
  bindConversation,
  claimWorkerRevival,
  closableWorkerConversations,
  currentRunId,
  failAgent,
  DETACHED_SILENCE_MS,
  failWorkerRevival,
  finishWorkerConversation,
  noteWorkerRevived,
  onReviveRequest,
  onSpawnRequest,
  onSwarmEnd,
  pendingWorkerRevivals,
  pendingWorkerSpawns,
  primeConversationGone,
  requestWorkerRevivals,
  rollbackWorkerRevivalClaim,
  releaseQuiescentRun,
  retiredWorkerForConversation,
  sleepSilentDetachedWorkers,
  occupiesSlot,
  sleepWorker,
  stageQueuedWorkerRevivals,
  swarmState,
  swarmTransferActive,
  noteAgentAlive,
  noteAgentContextTokens,
  persistCriticalSwarmNow,
  stageWorkerConversationFinish,
  workerConversationGone,
  workerRevivalDeliveredSince,
  type WorkerRevival
} from './agents.js';
import {
  abortContinuation,
  abortContinuationNow,
  attachSummary,
  beginContinuationDestinationSendNow,
  beginContinuationSourceSendNow,
  bindContinuationDestinationMessageNow,
  bindContinuationSourceMessageNow,
  claimContinuationNow,
  commitContinuationResult,
  CONTINUATION_TTL_MS,
  continuationByToken,
  continuationForSession,
  pendingAutomaticContinuations,
  supersededSourceConversations,
  dispatchContinuationDestinationSendNow,
  dispatchContinuationSourceSendNow,
  openContinuationNow,
  releaseContinuationDestinationSendNow,
  repairPrimeFromResumeShadow,
  resetContinuationsForTests,
  sendUnattempted,
  type ContinuationSendState
} from './session/continuation.js';
import type { ContinuationView } from './session/continuation.js';
import { noteResumeOpening } from './session/resume-gate.js';
import { readDurable, writeDurableNow, writeDurableSoon } from './durable.js';
import { APP_VERSION, BRIDGE_PROTOCOL } from './version.js';
import { requestCorrelation } from './session/correlation.js';
import { bindAgentWorkspace } from './workspace.js';

/** Fixed candidates so the extension can find the app without being told a port. */
export const DEFAULT_PORTS = [8765, 8766, 8767, 8768, 8769];
/**
 * The shipped range is fixed on purpose, but the test suite runs many bridges in parallel
 * forks on a machine where an installed app already holds 8765. A test whose own bind lost
 * that race used to fall through to the real app's bridge: 401s at best, and at worst a
 * test POSTing observations into the user's actual history. `CLF_BRIDGE_PORTS=0` asks the
 * OS for a free port per bridge instead, so no run can collide with another or with the app.
 */
const PORTS = ((): number[] => {
  const raw = process.env.CLF_BRIDGE_PORTS;
  if (!raw) return DEFAULT_PORTS;
  const parsed = raw
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 65535);
  return parsed.length > 0 ? parsed : DEFAULT_PORTS;
})();
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Durable settled-turn orphan safety net. */
export const STALE_SWARM_MS = 2 * 60_000;
/**
 * How long an open ChatGPT turn may produce no new durable activity before one reload.
 *
 * A turn start establishes the open-turn grant. New assistant text, native activity, errors and
 * attributed tool calls move its deadline; empty page/status polling does not. A formal turn end
 * removes it. This is deliberately conversation-scoped rather than agent-scoped, so an ordinary
 * long-running chat receives the same recovery as a Prime or Worker.
 */
/** Per-conversation floor between browser reload/open actions, regardless of why they were requested. */
export const BROWSER_RECOVERY_COOLDOWN_MS = 3 * 60_000;
const STALE_SWARM_SWEEP_MS = 30_000;
/** /events batches currently between parse and durable/session+worker lifecycle completion. */
let observationWritesInFlight = 0;
/** Requests allowed per rolling minute, across all routes. */
const RATE_LIMIT = 900;

/**
 * How long the app waits for the tab it opened to do the job, before failing it.
 *
 * A deadline, not a retry interval. One command is one delivery: the app opens the exact
 * chat, and this is how long that page has to redeem the marker, type the bootstrap and
 * report which conversation it landed in. Long enough for a tab to open, ChatGPT to finish
 * loading and the composer to accept text on a slow machine. A redeemed resume may keep waiting
 * only while its existing continuation is still alive; that continuation already has its own TTL.
 *
 * What happens when it runs out is `drop()`, which is an ending rather than another go:
 * the continuation is aborted and the session stays in the chat it is already in, or the
 * worker slot is failed and the prime is told. Someone who wants to try again presses the
 * button again — one press, one chat — where a background retry loop produced tabs minutes
 * after everybody had stopped expecting them.
 */
export const COMMAND_DEADLINE_MS = 90_000;
/**
 * The two clocks a worker bootstrap lives under before it is a failure rather than a wait.
 *
 * `REDEEM` is how long the chat this app opened gets to pick up its instruction. That is the
 * browser's whole round trip — create the tab, load ChatGPT, run the content script, redeem —
 * and it takes four to six seconds when it works at all; twenty is the same allowance the
 * placement offer gives it. A page that has not redeemed by then is not slow, it is dead: a tab
 * that loaded and never ran the marker (worker-4 on 2026-09-02 sat as an empty New chat for the
 * full ninety seconds, and the two workers queued behind it opened only after it was failed).
 * So the chat is opened once more, once, and a second silence fails the slot. This is safe
 * because `/commands/redeem` is single-owner: whichever page redeems first types, the other is
 * told there is nothing for it, and the worst case is one blank tab. It is bounded because the
 * retry is spent once and `LIMIT` is absolute, measured from the moment the broker invited the
 * worker, so no combination of a late hand-out and a fresh lease keeps a slot `invited` past it
 * — which is what happened to a worker whose command sat unleased for nine minutes holding the
 * last free slot.
 *
 * Once a page owns the command the attempt is one-shot again: it has `COMMAND_DEADLINE_MS` to
 * type and name its chat, and a page that redeemed and never typed is a failure, not a prompt
 * to open another chat.
 */
export const WORKER_REDEEM_MS = 20_000;
export const WORKER_BOOTSTRAP_LIMIT_MS = 120_000;
/** A worker may occupy the broker's `waking` state for one short, absolute attempt. */
/**
 * How long the browser has to prove it typed a wake into a sleeping worker's chat.
 *
 * The browser learns about a revival on its next `/status` pass, whose alarm has a
 * thirty-second floor, then has to focus or reopen the tab and type — and several wakes
 * from one prime message go one at a time. At thirty seconds the third of three was being
 * dropped as "waiting too long" while the text was on its way into the chat.
 */
export const REVIVAL_DEADLINE_MS = COMMAND_DEADLINE_MS;
/**
 * How long a delivered wake may go without the worker's first exact tool call.
 *
 * Delivery proves the text is in the chat; it does not prove the model has read it, and a
 * worker carrying a large context routinely thinks for a minute before its first call. So a
 * delivered wake gets the same silence budget a working worker gets before it is judged
 * asleep. The old thirty seconds ran out while the woken model was still reading: the app
 * told the prime "could not be woken", put the worker back to sleep, parked the run when
 * that was the last slot, and then refused the worker's first call as a dormant chat — after
 * which the prime re-sent the work, spawned replacements, and told everyone to stop.
 */
export const REVIVAL_ACTIVITY_MS = REVIVAL_DEADLINE_MS + DETACHED_SILENCE_MS;
/**
 * Past this age an ordinary bootstrap/restored command is stale, not pending. Worker revivals
 * use the shorter deadline above because their slot is already reserved while they are waking.
 */
const COMMAND_TTL_MS = 30 * 60_000;
const MAX_COMMANDS = 20;
const MAX_COMMAND_RECEIPTS = 64;
const COMMANDS_STATE = 'bridge-commands';
/**
 * Durable explicit-disconnect marker stored in the bridge credential slot itself.
 *
 * Generated bridge tokens are base64url, so `!` can never collide with a real credential.
 * Keeping the latch in the same encrypted, serialized secret store makes revocation and
 * pairing one source of truth across app restarts instead of inventing a second state file
 * that could disagree with the token after a crash.
 */
const BROWSER_DISCONNECTED = '!browser-disconnected';

/**
 * How recently a ChatGPT tab must have talked to this app to count as open.
 *
 * Every open tab polls /activity for its own conversation every few seconds, whether or
 * not anything is happening in it, so this is a direct observation rather than an
 * inference. Generous enough to survive a throttled background tab missing a couple of
 * polls.
 */
/**
 * How recently the extension must have been heard from for "which chats are open" to
 * be a question this app can answer at all.
 *
 * Distinct from the above on purpose: silence from one conversation means that chat is
 * closed only if the browser half is otherwise talking to us. Silence from the whole
 * extension means we know nothing, and the multi-agent broker treats those two cases
 * very differently before ending somebody's run.
 */
const BROWSER_PRESENT_MS = 60_000;

/**
 * The longest native compaction brief the browser bridge will carry across.
 *
 * This used to be 24k characters, which silently forced even a model instructed to write a
 * large token-budget handoff down to roughly six thousand tokens. The model-side prompt owns
 * the semantic ceiling (30k tokens); this is deliberately *not* another token approximation.
 * It is only a generous runaway-input guard, far above a normal 30k-token operational brief.
 */
const MAX_BRIEF_CHARS = 256_000;

/**
 * Cuts an over-long brief down to what will be typed, from the middle.
 *
 * Truncating the end was worse than not truncating at all: a brief is written TASK first
 * and NEXT / DO NOT last, so cutting the tail hands the fresh chat pages of history with
 * the instructions for what to do about it deleted — and nothing in the text says so. The
 * two ends are the parts that must survive, so the middle goes instead, with a marker in
 * its place. Both halves therefore end and begin at a line boundary where one is near.
 */
function boundBrief(text: string): string {
  if (text.length <= MAX_BRIEF_CHARS) return text;
  const marker = '\n\n[… the middle of this brief was longer than the app carries across and was left out …]\n\n';
  const room = MAX_BRIEF_CHARS - marker.length;
  // The tail is the actionable half, so it gets the larger share.
  const headRoom = Math.floor(room * 0.4);
  const head = text.slice(0, headRoom);
  const tail = text.slice(text.length - (room - headRoom));
  const headBreak = head.lastIndexOf('\n');
  const tailBreak = tail.indexOf('\n');
  return (
    (headBreak > headRoom - 400 ? head.slice(0, headBreak) : head) +
    marker +
    (tailBreak >= 0 && tailBreak < 400 ? tail.slice(tailBreak + 1) : tail)
  );
}

/**
 * What the extension is asked to do: open a ChatGPT chat and type one message into it.
 *
 * Three kinds. Two of them open a *new* chat; `revive` is the one that deliberately does not.
 *
 * There used to be a general "type into an existing conversation" command, and it was removed
 * for good reasons: it was used to nudge workers the app had already given up on and to tell a
 * doomed worker its run was over, and both were ways of driving a chat the app does not own on
 * the strength of a guess about what was happening inside it. `revive` is not that. It is
 * addressed to one exact conversation this app opened itself and has kept bound to a worker
 * slot ever since; it carries the prime's own words, in a run that prime is still running; and
 * it happens only because that prime asked for it in a tool call this app authenticated. The
 * chat is reopened because the worker in it is being given more work, which is the whole of
 * what a sleeping worker is for.
 *
 * Only the *spec* is kept, never the finished text. A resume's text belongs to the
 * continuation transaction, which hands it over exactly once; a revival's is whatever that
 * worker's inbox holds at hand-out time. Building both there is what keeps that true.
 */
type CommandSpec =
  | { type: 'worker'; agent: string; task: string; runId: string }
  /**
   * Waking a sleeping worker in the chat it already has.
   *
   * `conversationId` is the target and the fence at once: the page has to already be showing
   * that exact chat before anything is typed, so a revival cannot be redirected into a fresh
   * composer, into another worker's chat, or into whatever the user happened to open. `runId`
   * stops a revival left over from a retired incarnation from ever reaching the same friendly
   * worker id in a later run.
   */
  | {
      type: 'revive';
      agent: string;
      conversationId: string;
      runId: string;
      /**
       * Which wake this is: the prime messages it exists to put into that chat.
       *
       * Without it a revive command names a worker and nothing else, and two wakes of the same
       * worker are byte-identical specs — so the second folds into the first by the dedupe
       * below and inherits a lease, an owner and a delivery marker that belong to a send that
       * already happened. A worker can be woken, call, finish and be woken again well inside
       * one command's life, and that second wake is a different piece of work every time: no
       * two wakes can carry the same messages, because `beginRevival` only ever runs on a
       * `sleeping` worker and delivery marks what it offered. So this is the identity, the
       * supersede test and the same-wake dedupe all at once.
       */
      wake: string;
    }
  /**
   * The replacement chat for a Compact & Resume.
   *
   * Carries the continuation's token rather than the brief: the transaction owns the text,
   * decides whether this command may still have it, and is the only thing that can say the
   * move happened. Keyed by session, because compacting the same chat twice is one job whose
   * brief got newer — not two fresh chats, which is what keying on the handoff produced.
   */
  | { type: 'resume'; sessionId: string; token: string };

interface Command {
  id: string;
  spec: CommandSpec;
  createdAt: number;
  /**
   * When this command was handed to a page, and so when its deadline started.
   *
   * Null means nothing is working on it. A command is not retired at the moment it is
   * handed over — the page still has to type into the chat and tell the app which chat that
   * was — so this is what `timer` counts from, and what tells a second page that one is
   * already on it.
   */
  claimedAt: number | null;
  /**
   * When a worker bootstrap's one re-open was spent, so it is spent once. Memory only.
   *
   * Not persisted: after a restart the absolute limit is still measured from the persisted
   * `createdAt`, so the worst a forgotten retry can cost is one more open of the same
   * single-owner command inside a window that ends at the same instant either way.
   */
  retriedAt: number | null;
  /**
   * The one-shot that ends this command when its deadline passes. Memory only.
   *
   * One timer per command, armed when it is claimed and cleared when it is retired. There
   * is no periodic sweep behind it: nothing about a command changes on its own except
   * running out of time, so the only clock in this file is the one that says so.
   */
  timer: NodeJS.Timeout | null;
  lastError: string | null;
  /**
   * The page that redeemed this command, while its lease holds.
   *
   * One command is one chat, so it is delivered to one page. A second page on the same
   * marker — a reload restored into a new document, a duplicated tab, "reopen closed tab" —
   * is refused rather than handed the same bootstrap to type into a second conversation.
   * Memory only: a command restored from a previous run has no page waiting for it.
   */
  owner: string | null;
}

type CommandPhase = 'queued' | 'leased';
type CommandReceiptOutcome = 'committed' | 'terminal-failure';

interface CommandReceipt {
  id: string;
  client: string | null;
  conversationId: string | null;
  outcome: CommandReceiptOutcome;
  committed: boolean;
  error: string | null;
  completedAt: number;
}

interface DurableCommandRecord {
  id: string;
  spec: CommandSpec;
  createdAt: number;
  phase: CommandPhase;
  claimedAt: number | null;
  owner: string | null;
  lastError: string | null;
}

interface DurableCommandSnapshot {
  version: 4;
  commands: DurableCommandRecord[];
  receipts: CommandReceipt[];
}

/** The wire form the extension receives. */
export interface BridgeCommand {
  id: string;
  kind: 'open-chat';
  /**
   * Why this chat is being opened.
   *
   * The content script needs this after a successful fresh-chat ACK: only a Compact & Resume
   * replacement is allowed to arm the one-turn hidden-tab Goal recovery provenance. A worker
   * bootstrap must never do that, while a revival already names an existing chat. Keep the
   * command kind explicit on the wire rather than asking the browser to infer authority from
   * nullable agent/conversation fields.
   */
  type: CommandSpec['type'];
  /** Text to type into the conversation. Short by design. */
  text: string;
  /** Agent this tab will be, when the command comes from multi-agent mode. */
  agent: string | null;
  /**
   * The conversation this command is *for*, when it is for one that already exists.
   *
   * Set only for a revival, and the page treats it as a precondition rather than a hint: it
   * types only if the chat it is looking at is this one. Null is the ordinary case and means
   * the opposite precondition — a chat with no conversation of its own yet.
   */
  conversationId: string | null;
}

let server: http.Server | null = null;
let port: number | null = null;
let lastSeenAt: number | null = null;
let browserPresenceTimer: NodeJS.Timeout | null = null;
let commands: Command[] = [];
let commandReceipts: CommandReceipt[] = [];
/**
 * Worker/revival transports already removed from live delivery but still kept in durable
 * snapshots until the broker-side failed/sleeping transition has crossed its own fsync.
 *
 * The bridge queue and swarm are separate files. Without this fence a timeout/overflow can
 * persist "command gone" first, crash, then restore the older `invited`/`waking` broker row
 * with nothing left to explain or settle it. Keeping the old transport on disk is the safe
 * crash side: restart can retry/reconcile it; only after broker durability may it disappear.
 */
const commandRetirementsAwaitingBroker = new Map<string, Command>();
const commandLeaseWrites = new Map<string, Promise<boolean>>();
/** Serializes the broker-claim + browser-lease half of one revival redeem. */
const commandRedeems = new Map<string, Promise<void>>();
let requestWindow = { start: Date.now(), count: 0 };
const listeners = new Set<() => void>();
let extensionVersion: string | null = null;
let versionWarned = false;

export function onBridgeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(): void {
  for (const listener of listeners) listener();
}

export async function bridgeStatus(): Promise<BridgeStatus> {
  const stored = await getSecret('bridgeToken');
  return {
    running: server !== null,
    port,
    paired: stored !== null && stored !== BROWSER_DISCONNECTED,
    present: browserPresent(),
    lastSeenAt,
    extensionVersion
  };
}

/**
 * Whether this app can currently see the browser at all.
 *
 * False before the extension has ever talked to this process, and again once it has
 * gone quiet — in both cases "no tab reported that conversation" means nothing.
 */
export function browserPresent(): boolean {
  return server !== null && lastSeenAt !== null && Date.now() - lastSeenAt < BROWSER_PRESENT_MS;
}

/**
 * Records one authenticated browser sighting and schedules the inverse state transition.
 *
 * Presence is process-local, unlike pairing. The extension polls frequently, so every new
 * sighting pushes this deadline out. If those polls stop because Chrome/extension went away,
 * the timer emits exactly the state change the renderer otherwise has no reason to request.
 */
function noteBrowserSeen(): boolean {
  const wasPresent = browserPresent();
  lastSeenAt = Date.now();
  if (browserPresenceTimer) clearTimeout(browserPresenceTimer);
  browserPresenceTimer = setTimeout(() => {
    browserPresenceTimer = null;
    if (!browserPresent()) changed();
  }, BROWSER_PRESENT_MS + 1);
  browserPresenceTimer.unref?.();
  return !wasPresent;
}

/**
 * Forgets the token, so the next browser to ask gets a new one.
 *
 * The only remaining manual step in the extension's lifecycle, and it is a revocation
 * rather than a setup: there is nothing to press to connect.
 */
export async function unpair(): Promise<void> {
  // Clearing the credential is ambiguous: it is also what a fresh install or repaired
  // secrets store looks like, and those are intentionally allowed to provision silently.
  // This impossible-as-a-token sentinel preserves the user's explicit intent across both
  // the extension's next poll and an app restart.
  await setSecret('bridgeToken', BROWSER_DISCONNECTED);
  logInfo('bridge: browser disconnected');
  changed();
}

// ------------------------------------------------------------------ helpers

function json(res: http.ServerResponse, status: number, body: unknown, origin: string | null): void {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store'
  };
  if (origin) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-headers'] = 'authorization, content-type';
    headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
  }
  res.writeHead(status, headers);
  res.end(payload);
}

/**
 * Decides whether a request may be served at all, and what to echo back for CORS.
 *
 * The point of the check is to keep web pages out: a page can never suppress or forge
 * its Origin, so refusing every http(s) origin means chatgpt.com itself — and any
 * other site the user has open — cannot reach this server. `Origin: null` (a sandboxed
 * frame) is web content too, and is refused with them.
 *
 * A missing Origin is allowed, because Chrome does not always attach one to an
 * extension's own fetch once the extension holds host permission for 127.0.0.1. Those
 * requests still have to present the bearer token, which is the boundary that actually
 * carries the weight here; the Origin check is only the anti-web-page layer.
 */
function originOf(req: http.IncomingMessage): {
  ok: boolean;
  origin: string | null;
} {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return { ok: true, origin: null };
  if (origin.startsWith('chrome-extension://')) return { ok: true, origin };
  return { ok: false, origin: null };
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Records which extension build is talking, and complains once if it is the wrong one.
 *
 * An extension a release behind fails in the least helpful way possible — it connects,
 * it pairs, and then some routes quietly do nothing. One warning naming both versions
 * turns that into something the Activity log answers directly.
 */
function extensionProtocol(req: http.IncomingMessage): number | null {
  const value = Number(req.headers['x-extension-protocol'] ?? NaN);
  return Number.isSafeInteger(value) ? value : null;
}

function protocolCompatible(req: http.IncomingMessage): boolean {
  return extensionProtocol(req) === BRIDGE_PROTOCOL;
}

function noteExtensionVersion(req: http.IncomingMessage): void {
  const version = req.headers['x-extension-version'];
  const protocol = extensionProtocol(req);
  if (typeof version === 'string' && version !== extensionVersion) {
    extensionVersion = version.slice(0, 32);
    logInfo(`bridge: browser extension ${extensionVersion} connected`);
  }
  if (!versionWarned && protocol !== null && protocol !== BRIDGE_PROTOCOL) {
    versionWarned = true;
    logWarn(
      `bridge: the browser extension speaks protocol ${protocol} but this app speaks ${BRIDGE_PROTOCOL}. ` +
        `Reload the extension from the folder shipped with app ${APP_VERSION}.`
    );
  }
}

async function authorised(req: http.IncomingMessage): Promise<boolean> {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = await getSecret('bridgeToken');
  if (!token || token === BROWSER_DISCONNECTED) return false;
  return safeEqual(header.slice(7), token);
}

async function browserDisconnected(): Promise<boolean> {
  return (await getSecret('bridgeToken')) === BROWSER_DISCONNECTED;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflowed = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      // Past the cap nothing more is kept, but the stream is still consumed and
      // discarded. Destroying the socket instead would reach the extension as
      // ECONNRESET, which it cannot tell apart from the app having crashed.
      if (overflowed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflowed = true;
        chunks.length = 0;
        reject(new Error('body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Answers an over-sized body.
 *
 * A real status is worth more than a dropped connection here: the extension retries on
 * a network error and would post the same over-sized batch again forever, where a 413
 * tells it to split the batch. The rest of the body is drained by readBody, and the
 * request timeout bounds a client that never stops sending.
 */
function tooLarge(res: http.ServerResponse, origin: string | null): void {
  json(res, 413, { error: 'body_too_large' }, origin);
}

function rateLimited(): boolean {
  const now = Date.now();
  if (now - requestWindow.start > 60_000) requestWindow = { start: now, count: 0 };
  requestWindow.count += 1;
  return requestWindow.count > RATE_LIMIT;
}

// ---------------------------------------------------------------- validation

const OBSERVATION_KINDS = new Set([
  'conversation_title',
  'user_message',
  'assistant_message',
  'page_tool',
  'turn_start',
  'turn_end',
  'chat_error',
  // Not stored as transcript content. These request records populate the exact
  // requestId -> conversationId correlation registry.
  'tool_evidence'
]);
const OUTCOMES = new Set(['completed', 'failed', 'stopped', 'interrupted', 'stalled', 'unknown']);
const MAX_OBSERVATIONS = 200;
/** Connector requests accepted from one turn. Far above any real turn's call count. */
const MAX_CALL_EVIDENCE = 200;
/** The shape of a tool name we are willing to match a recorded call against. */
const TOOL_NAME = /^[a-z0-9_.-]{1,64}$/i;

/**
 * Rebuilds the per-call evidence the page reported, field by field.
 *
 * The extension read this out of ChatGPT's React state, and the page can post the same
 * message shape itself, so none of it is trusted: every field is reconstructed rather than
 * copied, the tool name is *checked* against its pattern and never trimmed to fit (trimming
 * turns a value that failed validation into one that passes), and duplicate message ids are
 * dropped on both sides rather than one of them being picked.
 *
 * What this evidence may do is bounded in the recorder, not here: it can say which
 * conversation a call this app *already ran* belongs to. It never creates a record, never
 * names an agent, and never carries an argument value.
 */
/**
 * @param untooled when true, a sighting with no tool name is kept as long as it carries a
 *   request id. Attribution and rendering want different things from this list. A tool row
 *   in the transcript is meaningless without a tool name, so `/events` still requires one;
 *   the request-id -> conversation join does not use the name at all, and requiring one
 *   there meant an id ChatGPT had already published was ignored until the `api_tool`
 *   message it belonged to cleared the safety check — routinely longer than the recorder's
 *   evidence window, so the call was filed under Unattributed activity while the page had
 *   been able to name its owner the whole time.
 */
function parseCallEvidence(input: unknown, untooled = false): PageCallEvidence[] {
  if (!Array.isArray(input)) return [];
  const out: PageCallEvidence[] = [];
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const raw of input.slice(0, MAX_CALL_EVIDENCE)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const tool = typeof item['tool'] === 'string' && TOOL_NAME.test(item['tool']) ? item['tool'] : '';
    const messageId = typeof item['messageId'] === 'string' ? item['messageId'].slice(0, 120) : '';
    const bare = untooled && typeof item['requestId'] === 'string';
    if ((!tool && !bare) || !messageId) continue;
    if (seen.has(messageId)) {
      duplicated.add(messageId);
      continue;
    }
    seen.add(messageId);
    out.push({
      messageId,
      tool,
      order: typeof item['order'] === 'number' && Number.isFinite(item['order'])
        ? Math.max(0, Math.min(MAX_CALL_EVIDENCE, Math.floor(item['order'])))
        : out.length,
      answered: item['answered'] === true,
      // Rebuilt like everything else here — an opaque id checked for shape, and a finite
      // number — so the page cannot smuggle anything through them.
      requestId:
        typeof item['requestId'] === 'string' && /^[a-z0-9_-]{1,100}$/i.test(item['requestId'])
          ? item['requestId']
          : null,
      createTime:
        typeof item['createTime'] === 'number' && Number.isFinite(item['createTime']) ? item['createTime'] : null
    });
  }
  return out.filter((call) => !duplicated.has(call.messageId));
}

/**
 * Turns whatever the extension posted into observations we are willing to store.
 *
 * The extension reads an undocumented page that can change under it, so nothing from
 * it is trusted structurally: unknown kinds are dropped, text is capped, and an impossible
 * timestamp is replaced with now. Historical transcript timestamps are valid input: opening
 * a months-old chat is exactly when we need ChatGPT's own creation time so its messages can
 * be interleaved with already-recorded MCP calls instead of all appearing at reload time.
 */
function parseObservations(input: unknown): ChatObservation[] {
  if (!Array.isArray(input)) return [];
  const now = Date.now();
  const earliestChatGpt = Date.UTC(2022, 10, 30);
  const out: ChatObservation[] = [];
  for (const raw of input.slice(0, MAX_OBSERVATIONS)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const kind = typeof item['kind'] === 'string' ? item['kind'] : '';
    if (!OBSERVATION_KINDS.has(kind)) continue;
    const time = typeof item['time'] === 'number' && Number.isFinite(item['time']) ? item['time'] : now;
    const observation: ChatObservation = {
      kind: kind as ChatObservation['kind'],
      time: time > now + 60_000 || time < earliestChatGpt ? now : time
    };
    if (item['authoredTime'] === true) observation.authoredTime = true;
    if (item['authoredNow'] === true && kind === 'user_message') observation.authoredNow = true;
    if (item['activeNow'] === true && kind === 'assistant_message') observation.activeNow = true;
    // Long final handoff-style answers are valid transcript content too. Keep this aligned
    // with the page-side assistant bound so the bridge does not silently become the next
    // truncation point after Fiber/content.js accepted the whole message.
    if (typeof item['text'] === 'string') observation.text = item['text'].slice(0, 256_000);
    if (typeof item['messageId'] === 'string') observation.messageId = item['messageId'].slice(0, 100);
    if (typeof item['turnId'] === 'string') observation.turnId = item['turnId'].slice(0, 100);
    if (typeof item['renderedHtml'] === 'string') observation.renderedHtml = item['renderedHtml'].slice(0, 120_000);
    if (item['state'] === 'streaming' || item['state'] === 'final') observation.state = item['state'];
    if (typeof item['fiberConversationId'] === 'string') {
      const fiberId = conversationId(item['fiberConversationId']);
      if (fiberId) observation.fiberConversationId = fiberId;
    }
    if (item['final'] === true) observation.final = true;
    if (typeof item['outcome'] === 'string' && OUTCOMES.has(item['outcome'])) {
      observation.outcome = item['outcome'] as ChatObservation['outcome'];
    }
    if (
      item['goalEligible'] === true &&
      kind === 'assistant_message' &&
      item['final'] === true &&
      item['state'] === 'final'
    ) {
      observation.goalEligible = true;
    }
    if (typeof item['detail'] === 'string') observation.detail = item['detail'].slice(0, 500);
    if (item['recoverable'] === true) observation.recoverable = true;
    if (Array.isArray(item['calls'])) observation.calls = parseCallEvidence(item['calls']);
    out.push(observation);
  }
  return out;
}

/**
 * Resolves a worker's terminal assistant row across the browser journal's batching boundary.
 *
 * content.js closes a generation synchronously, but its final Fiber refresh crosses a MAIN-world
 * async hop. `turn_end` can therefore reach one `/events` batch and the matching final assistant
 * row the next. Requiring both in one HTTP body turns a completed worker into a zombie even though
 * the recorder already has both facts durably.
 *
 * Only turn ids touched by *this* request are candidates, and an older candidate is rejected once
 * a later turn_start exists. That keeps a reload replaying historical assistant rows from
 * terminalising a worker that has already moved on to a newer turn.
 *
 * The stable final answer is the terminal fact here, and `turn_end` is only the page's separate
 * note that it saw the same thing. So the end is used for ordering when it exists and is not
 * required: a page that detached, reloaded or lost its local lifecycle right after the answer
 * settled never writes one, and demanding it left a worker that had visibly finished parked as a
 * zombie holding its slot.
 */
async function workerFinalAcrossBatches(
  sessionId: string,
  agent: string,
  observations: readonly ChatObservation[]
): Promise<string | null> {
  const touched = new Set<string>();
  for (const entry of observations) {
    if (!entry.turnId) continue;
    if (entry.kind === 'turn_end') touched.add(entry.turnId);
    else if (entry.kind === 'assistant_message' && entry.final === true && entry.text) touched.add(entry.turnId);
  }
  if (touched.size === 0) return null;

  const recent = await readRecentEvents(sessionId, 256, {
    kinds: ['turn_start', 'turn_end', 'assistant_message'],
    agent
  });
  let best: { at: number; text: string } | null = null;
  for (const turnId of touched) {
    const final = [...recent]
      .reverse()
      .find(
        (entry) =>
          entry.kind === 'assistant_message' &&
          entry.turnId === turnId &&
          entry.final === true &&
          Boolean(entry.message.text)
      );
    if (!final || final.kind !== 'assistant_message') continue;
    const end = [...recent]
      .reverse()
      .find((entry) => entry.kind === 'turn_end' && entry.turnId === turnId);
    const at = Math.max(final.seq, end?.seq ?? 0);
    // A replay of turn A after turn B has begun is history, not current completion evidence.
    if (recent.some((entry) => entry.kind === 'turn_start' && entry.turnId !== turnId && entry.seq > at)) continue;
    if (!best || at > best.at) best = { at, text: final.message.text };
  }
  return best?.text ?? null;
}

function conversationId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // ChatGPT conversation ids are uuid-shaped; anything else is not one.
  return /^[0-9a-f-]{8,64}$/i.test(value) ? value : null;
}

/**
 * May the goal loop write the next message in this chat?
 *
 * The switch is one setting, but it is the *prime's* setting. A spawned worker already has
 * an author for its user turns — the prime, through the agents tool — and its brief is the
 * whole of the objective it was given. Letting the loop type into it too puts two hands on
 * one wheel: the worker answers a question its prime never asked, finishes against that
 * instead, and reports back work nobody ordered. Worse, every worker in a run would be
 * spending OpenRouter credit in parallel on drafts the prime is about to override anyway.
 *
 * So: on for the prime, on for an ordinary solo chat that has never been a worker, and off for
 * every active, dormant or explicitly retired worker, whatever the global switch says. Worker
 * identity outlives the scarce active-run claim, so this check uses durable ownership/fences
 * rather than treating `run === null` as proof that a chat is solo.
 */
function goalWorkerChat(id: string): boolean {
  const agent = agentForOwnedConversation(id);
  // Active membership is not the whole worker-identity boundary anymore. Once the last worker
  // stops, its owner history parks and the exact worker chat nevertheless remains a worker
  // forever (until explicit clear). Goal must not start authoring user turns in it merely because
  // its run is dormant.
  return (agent !== null && agent !== PRIME_ID) || retiredWorkerForConversation(id) !== null;
}

/**
 * Is the loop kept out of this chat, and why?
 *
 * Two reasons, one gate. A worker chat is the prime's to write (see goalWorkerChat). A chat
 * the user **blocked** in the app is one they took this app's hands off: its tool calls are
 * refused, so a loop, a goal or an automatic compaction that kept typing into it would drive
 * ChatGPT on without the tools every one of those turns assumes — the model would answer
 * `CHAT_BLOCKED` refusals for as long as the loop kept asking. Block therefore stops the
 * loop as well as the tools, and releasing the chat is what brings the loop back: the
 * stored goal and switch are kept, only their effect is suspended. Reported to the page as
 * `goal.blocked` so the switch drawn off says why. Worker wins when both apply, because that
 * one never lifts.
 */
function goalBlockReason(id: string): 'worker' | 'blocked' | '' {
  if (goalWorkerChat(id)) return 'worker';
  if (isChatBlocked(id)) return 'blocked';
  return '';
}

/** A chat the loop may not drive — by role, or by the user's block. */
function goalFencedChat(id: string): boolean {
  return goalBlockReason(id) !== '';
}

function goalEnabledFor(id: string): boolean {
  if (goalFencedChat(id)) return false;
  return goalSwitchFor(id).enabled;
}

/**
 * Which of the two standing modes this chat's switch is in.
 *
 * Sent beside `enabled` rather than as a second boolean, because that is what makes the pair
 * mutually exclusive everywhere they are drawn: one field with one value, so no page and no
 * poll can ever paint both switches on. A chat where the loop may not act reports the mode it
 * *would* run, which the page never draws — `enabled: false` already answered the question.
 */
function goalModeFor(id?: string): 'goal' | 'loop' {
  return id ? goalSwitchFor(id).mode : getConfig().goal.mode;
}

/**
 * May the loop act in this chat at all — by the switch, or by this chat's own goal?
 *
 * The switch is the standing rule for every chat: keep going whenever ChatGPT itself says
 * something it was asked for is unfinished. A *specific goal* is one chat's own instruction,
 * given deliberately, naming the finish line; asking somebody to also find and flip a global
 * switch before the goal they just typed does anything would be asking them to say yes twice.
 * So either is enough — until this chat answers for itself, which is what goalArmedFor() adds:
 * the composer's mode slider has an Off position and Off has to mean off. The worker rule
 * overrides all of it, because there the prime is already the author of the user's turns.
 */
function goalActiveFor(id: string): boolean {
  if (goalFencedChat(id)) return false;
  return goalArmedFor(id);
}

// -------------------------------------------------------------------- routes

/**
 * Is ChatGPT working in this chat right now?
 *
 * The live half of the automatic-compaction rule, and the reason it is asked here rather
 * than remembered in the session: `generating` is a fact about the connection this process
 * is holding open, so it cannot survive a restart, a closed tab or a crash the way a
 * durable flag can — which is exactly the property that keeps a stale chat quiet. Reopening
 * a 500k conversation from last week starts no turn, so it never looks like work.
 *
 * In-flight tool calls are deliberately *not* counted. They are global to the app rather
 * than to one chat, and a worker's `exec_command` running elsewhere must not make an idle
 * chat look busy. It costs nothing: ChatGPT keeps the turn open while it waits for a tool
 * result, so mid-tool-call is already mid-turn here.
 */
function chatIsWorking(conversationId: string): boolean {
  const current = liveConversations().find((entry) => entry.conversationId === conversationId);
  return Boolean(current && (current.generating || current.activeTurnId));
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { ok: originAllowed, origin } = originOf(req);
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const route = url.pathname;

  if (req.method === 'OPTIONS') {
    // A preflight always carries an Origin, so a missing one here is not our extension.
    if (!origin) return json(res, 403, { error: 'forbidden_origin' }, null);
    res.writeHead(204, {
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'authorization, content-type, x-extension-version, x-extension-protocol',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      // Chrome asks for this before letting an extension reach a loopback address.
      'access-control-allow-private-network': 'true',
      'access-control-max-age': '600'
    });
    res.end();
    return;
  }

  if (!originAllowed) return json(res, 403, { error: 'forbidden_origin' }, null);

  noteExtensionVersion(req);

  // Identification only. Deliberately says nothing about roots, permissions or state.
  if (route === '/hello') {
    const stored = await getSecret('bridgeToken');
    return json(
      res,
      200,
      {
        app: 'chat-on-steroids',
        version: APP_VERSION,
        bridge: BRIDGE_PROTOCOL,
        compatible: protocolCompatible(req),
        paired: stored !== null && stored !== BROWSER_DISCONNECTED,
        disconnected: stored === BROWSER_DISCONNECTED
      },
      origin
    );
  }

  if (route === '/pair' && req.method === 'POST') {
    if (!protocolCompatible(req)) {
      return json(
        res,
        426,
        {
          error: 'incompatible_extension',
          bridge: BRIDGE_PROTOCOL,
          version: APP_VERSION
        },
        origin
      );
    }
    if (rateLimited()) return json(res, 429, { error: 'rate_limited' }, origin);
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const reconnect = Boolean(body && typeof body === 'object' && !Array.isArray(body) && (body as Record<string, unknown>)['reconnect'] === true);
    if ((await browserDisconnected()) && !reconnect) {
      return json(res, 409, { error: 'browser_disconnected' }, origin);
    }
    const storage = await secureStorageStatus();
    if (!storage.available) {
      return json(
        res,
        503,
        { error: 'secure_storage_unavailable', message: storage.detail ?? 'Secure credential storage is unavailable.' },
        origin
      );
    }
    // Silent provisioning on loopback.
    //
    // There used to be a six-digit code here, so the user had to be looking at the app
    // before a browser could attach. In practice both halves are the same person on the
    // same machine, installed together, and the code was a step that failed far more
    // often than it protected anything — the app was unreachable and the user was typing
    // numbers. The bearer token is still real and still required on every other route; it
    // is simply issued to whoever asks on 127.0.0.1 rather than to whoever can read the
    // window. What that gives up is stated plainly: any program already running as this
    // user can obtain the token, and with it read recorded ChatGPT activity and queue an
    // "open a fresh chat" command. It can still not read a file, run anything, or change
    // a permission — the bridge has no route that does. A web page cannot: originOf
    // refuses anything that is not a chrome-extension:// origin, above.
    const token = randomBytes(32).toString('base64url');
    await setSecret('bridgeToken', token);
    noteBrowserSeen();
    logInfo('bridge: browser extension connected and provisioned');
    changed();
    return json(res, 200, { token }, origin);
  }

  // A deliberate revocation is different from a stale credential. The extension repairs a
  // normal 401 by silently provisioning once, so naming this state on the first protected
  // request is what prevents that repair path from undoing the user's Disconnect click.
  if (await browserDisconnected()) return json(res, 401, { error: 'browser_disconnected' }, origin);
  if (!(await authorised(req))) return json(res, 401, { error: 'unauthorised' }, origin);
  if (!protocolCompatible(req)) {
    return json(
      res,
      426,
      {
        error: 'incompatible_extension',
        bridge: BRIDGE_PROTOCOL,
        version: APP_VERSION
      },
      origin
    );
  }
  // Charge only an authenticated extension. A random local process must not be able to
  // consume the browser's shared budget before failing origin/authentication.
  if (rateLimited()) return json(res, 429, { error: 'rate_limited' }, origin);
  if (noteBrowserSeen()) changed();

  if (route === '/status') {
    const live = liveConversations();
    // The extension's maintenance pass, and the whole conversation about repairs: `repaired`
    // reports the one handout it was last given and has now carried out, and `repairs` is every
    // chat now due one — the chats whose local tool calls stopped being attributable to them,
    // see `tickUnattributedIncident`. Reporting first is what makes a pass that says nothing
    // mean the last repair did not happen. Empty, which is almost always, costs one request.
    const repaired = url.searchParams.get('repaired');
    const repairFailed = url.searchParams.get('repairFailed');
    const repairAction = url.searchParams.get('repairAction');
    const action = repairAction === 'reloaded' || repairAction === 'reopened' ? repairAction : null;
    if (repaired) {
      await confirmRepair(repaired.slice(0, 64), action);
    } else if (repairFailed) {
      await failRepairAttempt(repairFailed.slice(0, 64), action);
    }
    const revival = pendingBrowserRevival();
    return json(
      res,
      200,
      {
        ok: true,
        conversations: live,
        commands: commands.length,
        revival,
        // A failure report closes this request. Reissuing the repair in the same response would
        // replace the visible failure with "Trying" before a renderer could ever observe it.
        repairs: repairFailed ? [] : await takePendingRepairs(),
        nonDiscardableConversations: nonDiscardableAgentConversations(),
        closableConversations: closableAgentConversations(),
        recoveryMonitoring: browserRecoveryMonitoring()
      },
      origin
    );
  }

  if (route === '/correlations' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const id = conversationId(body['conversationId']);
    if (!id) return json(res, 400, { error: 'bad_conversation_id' }, origin);
    const calls = parseCallEvidence(body['calls'], true).filter((call) => call.requestId !== null);
    if (calls.length === 0) return json(res, 400, { error: 'bad_request_evidence' }, origin);

    // This is the live-turn ownership handshake, deliberately separate from transcript
    // delivery. A fresh ChatGPT conversation can expose metadata.request_id before its
    // internal clientThreadId has converged on the final /c/<id>. Piggybacking ownership on
    // tool_evidence meant that harmless bootstrap mismatch could cause the recorder to throw
    // away the exact join, wait fifteen seconds, and file every call under Unattributed.
    //
    // Live 2026-08-21: conversation `6a88144a-4434-83eb-b06c-5022b77af09e` already had local
    // session `2026-08-21-e24b18f3` before its first MCP call, and every call carried normalized
    // request `77186fb4-bdda-4849-8cd7-879bb08a1617`; nevertheless that id never entered the
    // durable correlation registry and the calls accumulated in `2026-08-21-9d5892a4`
    // (Unattributed activity). The missing fact was therefore browser -> app ownership, not MCP
    // request-id parsing.
    //
    // The content script only invokes this for the *currently generating* page turn after the
    // browser route itself is concrete. The app atomically ensures/reuses that chat's session,
    // stores unresolved exact request-id correlations through the existing recorder path, then
    // reads them back before ACKing. An id already proven for another conversation is refused
    // here without feeding contradictory evidence into the sticky conflict registry. No tool
    // name, clock, active-tab or nearest-turn fallback participates.
    const requestIds = [...new Set(calls.map((call) => call.requestId).filter((value): value is string => Boolean(value)))];
    const conflicts = requestIds.filter((requestId) => {
      const held = requestCorrelation(requestId);
      return held !== null && held.conversationId !== id;
    });
    const blocked = new Set(conflicts);
    const unresolved = calls.filter((call) => call.requestId && !blocked.has(call.requestId) && requestCorrelation(call.requestId) === null);
    const observations: ChatObservation[] = unresolved.length > 0
      ? [{ kind: 'tool_evidence', time: Date.now(), calls: unresolved }]
      : [];
    // Even an already-confirmed mapping must ensure/reuse the chat session, matching /events'
    // first-observation semantics and making this one atomic operation from the page's view.
    const result = await recordChatObservations(id, observations, agentForOwnedConversation(id));
    const confirmed = requestIds.filter((requestId) => requestCorrelation(requestId)?.conversationId === id);
    return json(res, 200, {
      ok: true,
      conversationId: id,
      sessionId: result.sessionId,
      requestIds,
      confirmed,
      conflicts,
      complete: conflicts.length === 0 && confirmed.length === requestIds.length
    }, origin);
  }
  if (route === '/events' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const id = conversationId(body['conversationId']);
    if (!id) return json(res, 400, { error: 'bad_conversation_id' }, origin);
    // Normal worker binding happens on the exact command ACK. `/events` is the lost-ACK
    // recovery path, but the friendly id (`worker-1`) is reused by every later swarm and is
    // therefore not enough authority on its own. A command-opened document also carries the
    // exact random command id it redeemed; only that exact (agent, command) pair may recover a
    // still-leased worker. Old extension builds omit agentCommandId and safely lose recovery
    // rather than guess from the friendly worker label.
    const reportedAgent = typeof body['agent'] === 'string' && /^[a-z0-9-]{1,40}$/i.test(body['agent'])
      ? body['agent']
      : null;
    const reportedCommandId = typeof body['agentCommandId'] === 'string' ? body['agentCommandId'] : null;
    if (reportedAgent && reportedCommandId) {
      const pending = commands.find(
        (command) =>
          command.id === reportedCommandId &&
          command.spec.type === 'worker' &&
          command.spec.agent === reportedAgent &&
          command.spec.runId === currentRunId() &&
          command.claimedAt !== null
      );
      if (pending) bindConversation(reportedAgent, id);
    }
    // The page reporting for a conversation is the other half of first-hand liveness, and
    // the reason a worker whose tab is open is never on the silence clock at all. It also
    // takes back a worker this app gave up on while its tab was gone but its turn was not.
    const revived = noteAgentAlive(id, 'page');
    if (revived?.report) await recordAgentMessage(revived.report, 'sent');
    const observations = parseObservations(body['events']);
    // A turn beginning is the one page fact that outranks the app's own idea of this worker's
    // state. Reported here rather than inferred from `generating`, because this is the exact
    // moment the model started running and the only one that can outvote a sleep decision made
    // a second earlier on missing evidence.
    let turnStartedAt = 0;
    for (const item of observations) {
      if (item.kind === 'turn_start') {
        turnStartedAt = Math.max(turnStartedAt, item.time);
      }
    }
    if (turnStartedAt > 0) {
      const woke = noteAgentAlive(id, 'turn', turnStartedAt);
      if (woke?.report) await recordAgentMessage(woke.report, 'sent');
      // A turn that finished a wake has spent its revival command; retire it now rather than
      // on the next poll, so the prime's status and the command queue agree with the broker.
      if (woke?.revived) tidyCommands();
    }
    observationWritesInFlight += 1;
    try {
      const agent = agentForOwnedConversation(id);
      // The command acknowledgement normally supplies this origin before the worker's first
      // observation. Its pending copy lives in recorder memory until a session exists, though,
      // so an app restart in that narrow gap used to create an origin-less worker session even
      // though the broker had durably restored the exact worker binding and task. Reconstitute
      // the same origin from that authoritative binding before the recorder creates the session.
      if (agent && agent !== 'prime') {
        const worker = agentInfoForOwnedConversation(id);
        if (worker?.role === 'worker') {
          await noteChatOrigin(id, {
            kind: 'worker',
            fromSessionId: null,
            agentId: worker.id,
            task: worker.task
          });
        }
      }
      const result = await recordChatObservations(id, observations, agent);
      const superseded = await conversationWasSuperseded(id);
      // The stable assistant message, not the page-local turn id, is the exactly-once Goal
      // checkpoint. Freeze app config/key policy before 200 lets the browser retire this
      // terminal observation from its durable journal.
      try {
        for (const candidate of result.goalCandidates) {
          await acceptGoalReplyNow({
            conversationId: id,
            sessionId: result.sessionId!,
            ...candidate,
            blocked: superseded || goalFencedChat(id)
          });
        }
      } catch (err) {
        logWarn(
          `bridge: Goal reply decision for ${id} is not durable yet — ${err instanceof Error ? err.message : String(err)}`
        );
        return json(res, 503, { error: 'goal_reply_not_durable', retryable: true }, origin);
      }
      if (superseded) {
        endActivity(id);
        repairsInFlight.delete(id);
        forgetGoalWatch(id);
        compactionWatch.delete(id);
      } else {
        noteRecoveryObservations(id, result.sessionId, observations, result.activity);
      }
      // How full this chat is, measured by the app's own session record rather than by
      // anything the model said about itself, and fed in before the finish reconciliation
      // below. That ordering is the whole point: a worker that crossed the context ceiling
      // during the very turn it is now ending has to end for good, and the broker can only
      // know that if the measurement lands first. Restart re-derives it from the same place,
      // because the durable session is what carries the figure across a crash, not the
      // snapshot: the first observation batch from a restored chat puts it back before that
      // worker's next sleep or revival.
      if (agent && result.sessionId) {
        const summary = await getSession(result.sessionId).catch(() => null);
        if (summary) noteAgentContextTokens(id, summary.contextTokens);
      }
      // Workers are one-shot jobs. A settled assistant answer is first-hand page evidence that
      // the worker has completed a turn; waiting for the model to make another MCP call solely
      // to say `finish` leaves normal final answers as zombie workers forever. The browser
      // journal is allowed to split one turn's observations across adjacent HTTP batches, so
      // reconcile against the just-written durable session rather than treating one transport
      // envelope as a lifecycle boundary.
      const workerAgent = typeof agent === 'string' && agent !== PRIME_ID ? agent : null;
      let finalText: string | null = null;
      if (workerAgent !== null && result.sessionId) {
        finalText = await workerFinalAcrossBatches(result.sessionId, workerAgent, observations);
      }
      if (finalText && workerAgent) {
        const staged = stageWorkerConversationFinish(id, finalText);
        if (staged?.report) {
          // The browser treats HTTP 200 as permission to retire this final observation from
          // its durable journal. The session transcript above is already durable, but the
          // broker's terminal worker state and exact worker→prime report are a separate crash
          // boundary. A 200 before that snapshot lands can restore the worker as active after
          // restart while the browser has no observation left to replay, losing the real final
          // report. Keep the page's row retryable until the critical broker revision is durable.
          try {
            if (!(await persistCriticalSwarmNow())) {
              staged.rollback();
              return json(res, 503, { error: 'worker_state_not_durable', retryable: true }, origin);
            }
          } catch (err) {
            staged.rollback();
            logWarn(
              `bridge: final state for worker conversation ${id} is not durable yet — ${err instanceof Error ? err.message : String(err)}`
            );
            return json(res, 503, { error: 'worker_state_not_durable', retryable: true }, origin);
          }
          staged.commit();
          await recordAgentMessage(staged.report, 'sent');
          await wakeQueuedStoppedWorkers([workerAgent]);
          // Browser-owned completion has no later MCP call whose dispatcher can run the
          // ordinary quiescent-release hook. If this was the last slot-holder, release/park the
          // active incarnation here; wakeQueuedStoppedWorkers() runs first so already-accepted
          // unread work keeps the worker `waking` and therefore keeps the run active.
          releaseQuiescentRun();
        }
      }
      return json(res, 200, { sessionId: result.sessionId, stored: result.stored }, origin);
    } finally {
      observationWritesInFlight -= 1;
    }
  }

  if (route === '/closed' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const id = conversationId(body['conversationId']);
    if (id) {
      // Preserve the page's last exact turn verdict before closeConversation removes its live
      // recorder entry. Agent ownership outlives a tab; an open turn is the narrower fact that
      // authorises reopening it.
      const closedMidTurn = liveConversations().some(
        (entry) => entry.conversationId === id && (entry.generating || Boolean(entry.activeTurnId))
      );
      await closeConversation(id);
      // A browser tab closing is not evidence that the server-side ChatGPT turn has stopped.
      // In particular, after a swarm ends the retired-worker lease is the only authority fence
      // that keeps that old worker conversation from immediately becoming an ordinary chat and
      // continuing to call local mutation tools. Retired leases expire on their own TTL; a page
      // lifecycle signal must not revoke them early.
      // The extension owns this lifecycle. A swarm whose prime chat is gone has nobody to
      // report to, and workers that keep going are tabs writing files for a run nobody is
      // reading — so the run ends here, rather than the model being asked whether it is
      // done. A Compact & Resume in flight is the one case this does not apply to, and the
      // broker knows that because the continuation pinned the prime binding before the old
      // chat was replaced.
      if (primeConversationGone(id)) logInfo(`bridge: the prime chat ${id} closed, so its run ended`);
      else if (workerConversationGone(id)) {
        logInfo(`bridge: worker chat ${id} closed — its slot is detached, not ended, until it also goes quiet`);
      }
      await queueMissingTab(id, closedMidTurn);
    }
    return json(res, 200, { ok: true }, origin);
  }

  // The activity feed the extension uses to relabel ChatGPT's tool blocks. It only
  // ever returns summaries of calls this app made — never file contents.
  if (route === '/activity') {
    const id = conversationId(url.searchParams.get('conversationId'));
    const since = Number(url.searchParams.get('since') ?? 0);
    const goalClient = (url.searchParams.get('goalClient') ?? '').slice(0, 100);
    if (!id) return json(res, 400, { error: 'bad_conversation_id' }, origin);
    const retiredWorker = retiredWorkerForConversation(id);
    const superseded = await conversationWasSuperseded(id);
    /**
     * What is driving this chat, which is not a fact about the recorder.
     *
     * The switch, the saved task and the draft are all keyed by conversation and durable, so
     * they are knowable the instant ChatGPT names a chat — well before the recorder has a live
     * entry for it. Answering that moment with no goal at all is what made a New Chat opened
     * on a loop report itself as off, with the task the user had just written missing from its
     * own sheet, until the recorder happened to attach. One view, both branches: a chat is
     * never told that what is driving it is unknown.
     */
    const goalView = async () => ({
      enabled: !superseded && goalEnabledFor(id),
      // Has this chat answered for itself? The page reads the switch and the saved goal as
      // one state — see goalArmedFor() — and cannot tell an Off somebody chose here from an
      // Off merely inherited from the app-wide setting without being told which it is.
      own: superseded || goalFencedChat(id) || goalSwitchFor(id).own,
      mode: goalModeFor(id),
      hasKey: await goalKeyPresent(),
      model: getConfig().goal.model,
      // This chat's own goal, and never a worker's: the loop is off there whatever is
      // stored, and reporting one would let the page offer to drive a chat the prime owns.
      objective: superseded || goalWorkerChat(id) ? '' : goalObjectiveFor(id),
      // Why the switch is drawn off when the user did not turn it off. Without this the
      // menu says "Goal off" in a worker chat and looks like a setting that failed to save.
      // 'blocked' is the user's own block from the app, which suspends the loop with the
      // tools — see goalBlockReason.
      blocked: superseded ? 'continued' : goalBlockReason(id),
      // Stable, crash-durable reply still owed one Goal decision. A replacement content
      // script resumes this instead of manufacturing a turn from the rendered transcript.
      // A blocked chat's owed decision is withheld too, so the page cannot pick it up and
      // draft into a chat whose tools are refused.
      pending: superseded || goalFencedChat(id) ? null : goalPendingReplyFor(id),
      draft: superseded ? null : goalViewFor(id, goalClient)
    });
    // Every open ChatGPT tab polls this for its own conversation every few seconds, so
    // this is the app's primary first-hand evidence of which chats exist right now.
    let live = liveConversations().find((entry) => entry.conversationId === id);
    if (!live) {
      // `/activity` itself proves that this ChatGPT page is still open. After an app restart
      // the durable session can keep receiving exact MCP calls while the recorder's live map
      // is empty; returning an empty feed here leaves Overwrite stale forever. Reattach only
      // when a durable session already exists, so a random poll cannot manufacture history.
      await restoreRecordedConversation(id);
      live = liveConversations().find((entry) => entry.conversationId === id);
    }
    if (!live) {
      return json(
        res,
        200,
        {
          sessionId: null,
          entries: [],
          stream: [],
          userAnchors: [],
          nextSince: Number.isFinite(since) ? Math.max(0, since) : 0,
          job: null,
          goal: await goalView(),
          ...(goalFencedChat(id) || superseded
            ? {
                // Worker conversations are never Compact & Resume sources. Keep the page's
                // own auto-compaction switch projection off even when this worker has no live
                // recorder attachment yet, so a reload cannot briefly inherit the global
                // auto=true setting and manufacture a worker compaction attempt.
                context: contextView(false)
              }
            : {}),
          ...(retiredWorker ? { retiredWorker } : {})
        },
        origin
      );
    }
    // Old builds could let the recorder create replacement chat B before the resume ACK moved
    // A's durable projections. Merely opening/polling B (or a later B→C descendant) must be
    // enough to heal Goal; requiring another agents MCP call leaves Goal visibly on but inert.
    // The repair itself requires exact resume provenance and refuses worker-owned targets.
    if (!goalWorkerChat(id) && !goalObjectiveFor(id)) {
      try {
        await repairPrimeFromResumeShadow(id);
      } catch (err) {
        // Presentation polling must stay available when a historical repair cannot be read.
        // Nothing is moved unless the repair proves the exact source/target pair first.
        logWarn(`bridge: resume-shadow repair for ${id} failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const summary = await getSession(live.sessionId);
    // Worker chats and user-blocked chats alike: neither may auto-compact — see goalBlockReason.
    const workerBlocked = goalFencedChat(id);
    const requestedSince = Number.isFinite(since) ? Math.max(0, since) : 0;
    // A page reload begins at cursor zero. Never turn that into a full JSONL parse/response:
    // large audited sessions used to freeze the Electron main process here for tens of
    // seconds. The browser stream is presentation state, so send a bounded newest window and
    // explicitly tell the page to replace its local projection when its cursor predates it.
    const recent = await readRecentEvents(live.sessionId, 1200);
    const firstAvailable = recent.reduce((first, event) => Math.min(first, event.seq), Number.MAX_SAFE_INTEGER);
    const resetActivity =
      firstAvailable !== Number.MAX_SAFE_INTEGER &&
      requestedSince < firstAvailable &&
      !(requestedSince === 0 && firstAvailable === 1);
    const events = recent.filter((event) => resetActivity || event.seq >= requestedSince);
    // Where this conversation begins inside a session that has been compacted and resumed.
    //
    // The session keeps its identity across Compact & Resume, so its log carries chat A's rows
    // into chat B's feed. Every row that names a turn is placed by that turn and simply finds
    // none in B, but a browser-repair notice names no turn: the page sits it before the first
    // user message recorded after it, and in B that was the bootstrap — three "Reloaded chat"
    // rows for reloads B never had, stacked above its handoff (2026-09-02). The bootstrap is
    // the boundary, and it is durable: the app typed it with the RESUME marker at its head.
    // Repairs before the newest one belong to a chat that no longer exists on this feed. The
    // whole window is scanned, not only the events past the cursor, so a page resuming from a
    // cursor still knows a boundary it consumed earlier.
    const resumeBoundary = recent.reduce(
      (boundary, event) =>
        event.kind === 'user_message' && CONTINUATION_MARKER.exec(event.message.text)?.[1] === 'RESUME'
          ? Math.max(boundary, event.origin ?? event.seq)
          : boundary,
      0
    );
    const earlierChatRepair = (event: SessionEvent): boolean =>
      event.kind === 'progress' &&
      typeof event.progressId === 'string' &&
      event.progressId.startsWith('browser-repair:') &&
      (event.origin ?? event.seq) < resumeBoundary;
    // App-owned transcript feed. Presentation-only: raw tool I/O stays in the local
    // session store. This is the source the connected page will render chronologically.
    const stream = events.flatMap((event) => {
      if (earlierChatRepair(event)) return [];
      const base = { seq: event.seq, time: event.time, turnId: event.turnId ?? null, agent: event.agent ?? null };
      switch (event.kind) {
        case 'tool_call':
          return [{ ...base, kind: 'tool_call', tool: event.call.tool, callId: event.call.callId,
            requestId: event.call.requestId ?? null,
            attribution: event.call.attribution, outcome: event.call.outcome, durationMs: event.call.durationMs,
            summary: event.call.summary, changes: event.call.changes ?? [] }];
        case 'progress':
          // One caption, at the position it first appeared. `origin` is what makes that
          // work from a cursor: the page has usually already consumed the first record and
          // will never see it again, so the supersession has to carry the seq it replaces.
          // Keying the page's own store by that seq is then the whole of "updated in place".
          return [
            {
              ...base,
              seq: event.origin ?? event.seq,
              kind: 'progress',
              text: event.message.text,
              progressId: event.progressId ?? null
            }
          ];
        case 'page_tool':
          // Same supersession contract as `progress`, for the same reason: ChatGPT rewrites
          // an activity row's label as the step lands, and the page's store keys on the seq
          // of the first record so the rewrite updates that row instead of adding one.
          return [
            {
              ...base,
              seq: event.origin ?? event.seq,
              kind: 'page_tool',
              label: event.label,
              messageId: event.messageId
            }
          ];
        case 'assistant_message':
          return [
            {
              ...base,
              kind: 'assistant_message',
              text: event.message.text,
              renderedHtml: event.renderedHtml?.text ?? '',
              state: event.state ?? (event.final ? 'final' : 'streaming'),
              final: event.final,
              messageId: event.messageId ?? null,
              origin: event.origin ?? event.seq
            }
          ];
        case 'agent_message':
          return [
            {
              ...base,
              kind: 'agent_message',
              from: event.from,
              to: event.to,
              text: event.message.text,
              delivery: event.delivery,
              messageId: event.messageId
            }
          ];
        case 'chat_error':
          return [{ ...base, kind: 'chat_error', text: event.message.text }];
        case 'turn_start':
          return [{ ...base, kind: 'turn_start' }];
        case 'turn_end':
          return [
            {
              ...base,
              kind: 'turn_end',
              outcome: event.outcome,
              detail: event.detail ?? ''
            }
          ];
        default:
          return [];
      }
    });
    // Stable page-authored boundaries for presentation reconciliation. The extension only
    // needs identity and order here, never the user's text: a visible assistant response is
    // exactly the response after one visible user message, even when our own local
    // turn_start/turn_end lifecycle was split by a reload or a transient terminal marker.
    // Keeping anchors separate from `stream` means they can participate in the join without
    // ever becoming synthetic transcript rows.
    const userAnchors = events.flatMap((event) =>
      event.kind === 'user_message' && event.messageId
        ? [
            {
              seq: event.origin ?? event.seq,
              time: event.time,
              messageId: event.messageId
            }
          ]
        : []
    );

    // Legacy tool-only view, kept only while the old native-row relabeller is still a
    // fallback. It is derived from the same stream cursor and contains no raw args/result.
    const nextSince = events.reduce((next, event) => Math.max(next, event.seq + 1), requestedSince);

    const entries = events.flatMap((event) =>
      event.kind === 'tool_call'
        ? [
            {
              seq: event.seq,
              time: event.time,
              tool: event.call.tool,
              callId: event.call.callId,
              // The extension matches its DOM blocks against this, and refuses to
              // relabel anything when it is missing.
              turnId: event.turnId ?? null,
              // ChatGPT's own id for the connector request this call answered, from the
              // `x-request-id` it sent. `turnId` is a `data-turn-id`, which is minted per
              // page load — the same turn is `g-…` while it streams and `request-WEB:…`
              // after a refresh — so it cannot survive a reload, and without this the
              // relabeller had nothing durable left to match a reloaded transcript on.
              requestId: event.call.requestId ?? null,
              attribution: event.call.attribution,
              outcome: event.call.outcome,
              durationMs: event.call.durationMs,
              summary: event.call.summary,
              changes: event.call.changes ?? [],
              // Raw arguments stay in the local session store; browser rendering needs only the summary.


              agent: event.agent ?? null
            }
          ]
        : []
    );
    return json(
      res,
      200,
      {
        sessionId: live.sessionId,
        generating: live.generating,
        // What the *currently attached* chat is carrying, not what the local session has
        // accumulated over its whole life. A session that has been compacted keeps its
        // history and its identity across the move, so a meter reading the lifetime figure
        // would come back full the moment the replacement chat opened and compact it again.
        tokens: summary?.contextTokens ?? 0,
        // What the composer's meter fills against. Sent from here rather than worked out in the
        // page so that the bar someone is watching and the threshold that acts are the same
        // number. The trigger itself is the app's — see considerAutomaticCompaction — and the
        // page learns of it through `job`, which it resumes.
        // Automatic compaction is a prime/solo-chat policy only. A worker keeps the same
        // conversation until it stops; crossing 400k changes future revive eligibility, not
        // its conversation identity. Reporting auto=false here keeps the page's switch honest.
        // Worker identity is the conversation itself: Compact & Resume deliberately creates a
        // different conversation, while the continuation transaction only knows how to move a
        // run's prime binding, so a worker that compacted would be stranded in B while the
        // broker still authorised A.
        context: contextView(!workerBlocked && !superseded),
        // This chat was opened by the app, so its first user message is not the user's —
        // it is the handoff brief or the worker bootstrap this app typed. The page uses
        // it to fold that message away. Read off the session record rather than remembered
        // in the tab, so it still holds after a reload, days later.
        bootstrap: summary?.origin?.kind ?? null,
        // Which worker this chat is, for the page's fold of the bootstrap. From the durable
        // origin, so a reloaded worker tab — which no longer holds its command — still knows.
        bootstrapAgent: summary?.origin?.kind === 'worker' ? summary.origin.agentId ?? null : null,
        entries,
        stream,
        userAnchors,
        resetActivity,
        truncatedFrom: resetActivity ? firstAvailable : null,
        nextSince,
        // How this chat's own Compact & Resume is going, so the page can say what is
        // happening instead of spinning.
        job: resumeJobFor(live.sessionId),
        // The goal loop: whether it is on, whether it *can* be on, and whatever draft this
        // chat currently has in flight. The draft's text grows on this feed, which is what
        // the panel above the composer streams — there is no second connection to hold open.
        goal: await goalView(),
        // Local calls still executing for *this chat*. ChatGPT-native compaction waits for
        // this to reach zero after interrupting the turn, so the handoff is written about a
        // settled machine rather than one mid-edit. Recorder-only attribution settling is
        // intentionally separate below: once the handler/result have returned, waiting up to
        // REQUEST_ID_GRACE_MS to file its history cannot change the workspace and must not add
        // a cross-chat 15-second tax to the machine-settle barrier.
        pendingTools: runningToolCalls(live.conversationId),
        // Diagnostic only. A finished unattributed call is still being placed into durable
        // history; unknown ownership is conservatively projected onto every chat until that
        // attribution finishes, but this number never gates the compaction prompt.
        settlingTools: settlingToolCalls(live.conversationId),
        // The generation this chat currently has open, if it has one. A content script that
        // has just been reloaded into a turn already in flight adopts this instead of
        // minting a second id for the same run. See liveConversations().
        activeTurnId: live.activeTurnId ?? null,
        // A revival names an existing worker conversation. The extension, which alone can
        // inspect Chrome's real tab set, routes it to that tab before it considers opening one.
        // Returning the same inert id here makes a live page the fast path; /status remains the
        // service-worker/restart path. Redeem is still the exclusive ownership boundary.
        revival: pendingBrowserRevival(),
        // Recovery only. A placement is normally collected by the `/compact` reply that
        // produced it; this is where it is still found if that reply never reached the page —
        // a navigation, a dropped socket — so a lost response becomes a correctly placed tab
        // rather than an OS open in whichever window happened to have focus. Same one-shot:
        // whoever collects it first is the one that opens it.
        placement: pendingBrowserPlacement(id),
        // Browser recovery is delivered by /status, whose service-worker caller can scan every
        // actual ChatGPT tab immediately before deciding exact reload vs exact open. Keeping it
        // out of this document-local feed also lets a dead content script be recovered.
        ...(retiredWorker ? { retiredWorker } : {})
      },
      origin
    );
  }

  /**
   * Compact & Resume, all of it, in one route.
   *
   * Four shapes, because it is one button with one transaction behind it:
   *
   *   ticket  — `{conversationId, ticket:true, automatic}`: durably open the transaction
   *             before any fallible page barrier, without handing out the prompt yet.
   *   open    — `{conversationId}`: start the continuation and hand back the prompt the page
   *             injects, plus the token every later step quotes.
   *   capture — `{conversationId, token, summary}`: the page watched the compaction turn
   *             finish and is handing over the final assistant answer for *that* generation.
   *             That text is the brief; there is no tool call to make and nothing to save.
   *   cancel  — `{conversationId, cancel: true}`: give up, and stay in this chat.
   *
   * Nothing here opens a chat on its own. The replacement is queued only once a brief
   * exists, which is the whole of "an interrupted or empty compaction leaves you where you
   * were".
   */
  if (route === '/compact' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const checkpointToken = typeof body['token'] === 'string' ? body['token'] : '';
    // ChatGPT has not assigned the replacement conversation yet. Its irreversible Send fence
    // is therefore token-addressed; the exact conversation is learned later from the marked
    // server-authored message.
    if (body['destinationAttempt'] === true) {
      const result = await beginContinuationDestinationSendNow(checkpointToken);
      return result
        ? json(
            res,
            200,
            { allowed: result.allowed, destinationSend: result.checkpoint },
            origin
          )
        : json(res, 409, { error: 'destination_send_not_available' }, origin);
    }
    if (body['destinationDispatch'] === true) {
      const armed = await dispatchContinuationDestinationSendNow(checkpointToken);
      return json(
        res,
        armed ? 200 : 409,
        armed ? { armed: true } : { error: 'destination_send_reclaimed' },
        origin
      );
    }
    if (body['destinationLost'] === true) {
      // The page armed the click and then proved the brief never left it. The lease belongs to
      // that page and is retired with it, and the same brief is offered to a fresh chat at once —
      // not after the quarter-hour the lease was measured for, and for a manual Compact & Resume
      // as much as an automatic one: the ticket exists to land the brief, and Cancel is there
      // for a user who meant the Escape.
      const released = await releaseContinuationDestinationSendNow(checkpointToken);
      if (released) {
        const entry = continuationByToken(checkpointToken);
        for (const command of commands.filter(
          (candidate) => candidate.spec.type === 'resume' && candidate.spec.token === checkpointToken
        )) {
          retire(command, 'the page lost the brief before Send; nothing was sent');
        }
        if (entry) {
          queueResumeCommand(entry.sessionId, checkpointToken);
          void deliver();
        }
        logInfo(
          `bridge: the brief for ${entry?.sessionId ?? checkpointToken.slice(0, 8)} was lost before Send — offering it to a fresh chat`
        );
      }
      return json(
        res,
        released ? 200 : 409,
        released ? { released: true } : { error: 'destination_send_not_releasable' },
        origin
      );
    }
    const id = conversationId(body['conversationId']);
    if (!id) return json(res, 400, { error: 'bad_conversation_id' }, origin);
    // The last durable write before the click, quoting the claim handed out above. A false
    // answer means this document was reclaimed while it was composing and must submit nothing.
    if (body['sourceDispatch'] === true) {
      const entry = continuationByToken(checkpointToken);
      if (!entry || entry.from !== id) return json(res, 409, { error: 'no_such_continuation' }, origin);
      const armed = await dispatchContinuationSourceSendNow(checkpointToken);
      return json(res, armed ? 200 : 409, armed ? { armed: true } : { error: 'source_send_reclaimed' }, origin);
    }
    if (body['sourceAttempt'] === true) {
      const entry = continuationByToken(checkpointToken);
      if (!entry || entry.from !== id) return json(res, 409, { error: 'no_such_continuation' }, origin);
      const result = await beginContinuationSourceSendNow(checkpointToken);
      return result
        ? json(
            res,
            200,
            { allowed: result.allowed, sourceSend: result.checkpoint },
            origin
          )
        : json(res, 409, { error: 'source_send_not_available' }, origin);
    }
    if (typeof body['sourceMessageId'] === 'string') {
      const entry = continuationByToken(checkpointToken);
      if (!entry || entry.from !== id) return json(res, 409, { error: 'no_such_continuation' }, origin);
      const bound = await bindContinuationSourceMessageNow(checkpointToken, body['sourceMessageId'].slice(0, 200));
      return bound
        ? json(res, 200, { bound: true, job: resumeJobFor(entry.sessionId) }, origin)
        : json(res, 409, { error: 'source_message_conflict' }, origin);
    }
    if (typeof body['destinationMessageId'] === 'string') {
      const entry = continuationByToken(checkpointToken);
      if (!entry) return json(res, 409, { error: 'no_such_continuation' }, origin);
      const bound = await bindContinuationDestinationMessageNow(
        checkpointToken,
        id,
        body['destinationMessageId'].slice(0, 200)
      );
      if (!bound) return json(res, 409, { error: 'destination_message_conflict' }, origin);
      const result = await commitContinuationResult(checkpointToken, id);
      if (result.status === 'retryable') {
        return json(res, 503, { error: 'resume_commit_retryable', retryable: true }, origin);
      }
      if (result.status === 'rejected') {
        if (await abortRejectedResume(checkpointToken, result.reason)) {
          const refused = commands.find(
            (candidate) => candidate.spec.type === 'resume' && candidate.spec.token === checkpointToken
          );
          if (refused) retire(refused, 'the session layer refused the marked replacement message');
        }
        return json(res, 409, { error: 'resume_commit_rejected', message: result.reason }, origin);
      }
      const command = commands.find(
        (candidate) => candidate.spec.type === 'resume' && candidate.spec.token === checkpointToken
      );
      if (command) retire(command, 'the marked replacement message committed the continuation');
      if (result.status === 'committed') armResumedChat(entry.sessionId, result.conversationId);
      return json(
        res,
        200,
        {
          committed: true,
          conversationId: result.conversationId,
          commandId: command?.id ?? null
        },
        origin
      );
    }
    if (goalWorkerChat(id)) {
      return json(
        res,
        409,
        {
          error: 'worker_compaction_disabled',
          message: 'Worker chats stay in their existing conversation so the prime can revive them safely.'
        },
        origin
      );
    }
    // A blocked chat is stopped, and Compact & Resume would start it again: the replacement
    // chat is a new conversation the block does not cover, opened on a brief this app typed.
    if (isChatBlocked(id)) {
      return json(
        res,
        409,
        {
          error: 'chat_blocked',
          message: 'This chat is blocked in the app. Release it there before compacting or resuming it.'
        },
        origin
      );
    }
    const live = liveConversations().find((entry) => entry.conversationId === id);
    const known = live ? null : await findSessionByConversation(id, { requireUnique: true });
    const sessionId = live?.sessionId ?? known?.id ?? null;
    if (!sessionId) {
      return json(
        res,
        409,
        {
          error: 'session_not_recorded',
          message: 'This chat has no recorded local session to compact.'
        },
        origin
      );
    }

    if (body['cancel'] === true) {
      let cancelled = false;
      try {
        cancelled = await cancelResumeNow(sessionId);
      } catch (err) {
        logWarn(`bridge: could not durably cancel Compact & Resume for ${sessionId} — ${err instanceof Error ? err.message : String(err)}`);
        return json(res, 503, { error: 'resume_cancel_not_durable', retryable: true, sessionId }, origin);
      }
      return json(res, 200, { cancelled, sessionId, job: resumeJobFor(sessionId) }, origin);
    }

    // File the ticket before the browser interrupts or settles anything. This endpoint does
    // not hand out the prompt: a page that dies after this durable 202 leaves work to collect,
    // while a page that survives must still pass the existing stop/tool barrier below and ask
    // again. `automatic` is authority for the Off switch and for no other behaviour.
    if (body['ticket'] === true) {
      const existing = continuationForSession(sessionId);
      let opened = existing;
      if (!opened) {
        try {
          opened = await openContinuationNow(sessionId, id, body['automatic'] === true);
        } catch (err) {
          logWarn(`bridge: could not durably file Compact & Resume for ${sessionId} — ${err instanceof Error ? err.message : String(err)}`);
          return json(res, 503, { error: 'continuation_not_durable', retryable: true, sessionId }, origin);
        }
      }
      rememberToken(sessionId, opened.token);
      changed();
      return json(
        res,
        202,
        {
          started: !existing,
          filed: true,
          sessionId,
          token: opened.token,
          sourceSend: opened.sourceSend,
          prompt: null,
          job: resumeJobFor(sessionId)
        },
        origin
      );
    }

    // The capture. The page is the only party that can tell which output belongs to the
    // compaction turn, and it says so by quoting the token it was given when that turn was
    // marked. A brief for a continuation that has moved on is answered with what is already
    // stored rather than written again — see attachSummary.
    if (typeof body['summary'] === 'string') {
      const token = typeof body['token'] === 'string' ? body['token'] : '';
      const entry = continuationByToken(token);
      if (!entry || entry.sessionId !== sessionId) return json(res, 409, { error: 'no_such_continuation' }, origin);
      const brief = boundBrief(String(body['summary']));
      // Refused here rather than deeper, because this is where the reason can still be said
      // in words the page will put on screen. A brief that cannot be a brief is a failed
      // compaction, and a failed compaction leaves the session exactly where it is — which
      // is strictly better than moving it into a chat that was handed half a document and
      // has no way to know it. See briefShortfall.
      // Only the brief that would actually be stored is judged. Once a continuation holds
      // one, a retry's text is discarded in favour of it, so refusing that text would refuse
      // a capture that already succeeded.
      const source = known ?? (await getSession(sessionId));
      const shortfall = entry.handoffId ? null : briefShortfall(brief, source?.estimatedTokens ?? 0);
      if (shortfall) {
        logWarn(`bridge: refused the compaction brief for ${sessionId} — ${shortfall}`);
        try {
          await cancelResumeNow(sessionId);
        } catch (err) {
          // The semantic refusal is terminal only once its matching abort is durable. Returning
          // 409 here used to make content.js discard the generation-bound brief even though the
          // continuation was still armed in its previous state. Preserve the same retry contract
          // as an explicit cancel: the page retains these exact bytes and presents them again
          // until either the abort lands or the transaction has genuinely moved on.
          logWarn(
            `bridge: could not durably withdraw the refused compaction for ${sessionId} — ${err instanceof Error ? err.message : String(err)}`
          );
          return json(
            res,
            503,
            {
              error: 'resume_cancel_not_durable',
              retryable: true,
              message: 'The handoff was incomplete, but cancelling this compaction was not stored yet. Retrying…',
              sessionId,
              job: resumeJobFor(sessionId)
            },
            origin
          );
        }
        return json(
          res,
          409,
          {
            error: 'brief_incomplete',
            message: `${shortfall} Nothing was compacted — this chat still has its session.`,
            sessionId,
            job: resumeJobFor(sessionId)
          },
          origin
        );
      }
      const handoff = await attachSummary(token, brief);
      if (!handoff) {
        // `attachSummary` deliberately turns a rejected continuation-WAL write back into an
        // `awaiting-summary` transaction so the exact token/brief can be retried. Report that
        // state as a transport-retryable failure, not a semantic 409: the browser keeps the
        // settled brief until this boundary acknowledges it, and a 409 would make it throw
        // away the only safe retry even though the continuation is explicitly still waiting.
        const after = continuationByToken(token);
        const retryable = after?.sessionId === sessionId && after.state === 'awaiting-summary';
        return json(
          res,
          retryable ? 503 : 409,
          {
            error: 'brief_not_stored',
            ...(retryable ? { retryable: true } : {}),
            sessionId,
            job: resumeJobFor(sessionId)
          },
          origin
        );
      }
      const command = queueResumeCommand(sessionId, token);
      // This request is chat A's own page asking for the handoff it is in the middle of, so the
      // reply below can hand it the successor to open. Delivery may hold the OS opener back for
      // exactly as long as that is true — see offerPlacement.
      placementCollector = id;
      // The command's leased phase is a crash boundary: do not tell the page capture is fully
      // accepted until the attempt we are about to open is durable. This also makes the HTTP
      // response and the browser-open side effect deterministically ordered for callers.
      try {
        await deliver();
      } finally {
        placementCollector = null;
      }
      logInfo(`bridge: captured the compaction brief for ${sessionId}; opening the replacement chat`);
      return json(
        res,
        200,
        {
          stored: true,
          sessionId,
          handoffId: handoff.id,
          commandId: command?.id ?? null,
          // Chat B, for A's own browser to open in A's own window. Null whenever delivery
          // already opened it through the OS, which is every path that has no page to tell.
          placement: pendingBrowserPlacement(id),
          job: resumeJobFor(sessionId)
        },
        origin
      );
    }

    // The same press arriving again is the same transaction. The prompt remains available
    // while the fence is still on one of its two pre-submission states — neither of which any
    // page can have sent under, because both are written before the composer is submitted.
    // Once a page has armed the click, every document reconciles ChatGPT's unique marker
    // instead and no page is allowed to submit it again.
    if (await conversationWasSuperseded(id)) {
      return json(res, 409, { error: 'conversation_superseded' }, origin);
    }
    const already = continuationForSession(sessionId);
    if (already) {
      const prompt =
        already.state === 'awaiting-summary' && sendUnattempted(already.sourceSend)
          ? nativeHandoffPrompt(already.token)
          : null;
      return json(
        res,
        prompt ? 202 : 200,
        {
          started: false,
          sessionId,
          token: already.token,
          sourceSend: already.sourceSend,
          prompt,
          job: resumeJobFor(sessionId)
        },
        origin
      );
    }

    let opened;
    try {
      opened = await openContinuationNow(sessionId, id);
    } catch (err) {
      logWarn(`bridge: could not durably open Compact & Resume for ${sessionId} — ${err instanceof Error ? err.message : String(err)}`);
      return json(res, 503, { error: 'continuation_not_durable', retryable: true, sessionId }, origin);
    }
    // Remembered from the press, not from the queued chat: a transaction that fails before
    // anything is queued still has to be reportable, or the page polls a button that says
    // nothing about the compaction it just watched fail.
    rememberToken(sessionId, opened.token);
    changed();
    logInfo(`bridge: browser started Compact & Resume for ${sessionId} (${opened.token.slice(0, 8)})`);
    return json(
      res,
      202,
      {
        started: true,
        sessionId,
        token: opened.token,
        sourceSend: opened.sourceSend,
        // The prompt the page injects as the compaction turn. Its answer is the brief.
        prompt: nativeHandoffPrompt(opened.token),
        job: resumeJobFor(sessionId)
      },
      origin
    );
  }

  /**
   * The goal loop, from the page's side.
   *
   *   draft — `{conversationId, turnId}`: ChatGPT finished that generation and the page has
   *           satisfied itself that it really finished. Start the one draft for it, or hand
   *           back the one that is already running. The answer is polled off `/activity`.
   *   ack   — `{conversationId, token}`: the page has typed it, or has given up on typing it.
   *           Either way the draft is spent and can never be typed again.
   *
   * The turn id is the identity, and it is the page's own generation id — not a message id,
   * not a timestamp. That is what makes a retried POST, a second observer or a reloaded tab
   * the same draft rather than a second message into somebody's conversation.
   */
  if (route === '/goal/draft' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const id = conversationId(body['conversationId']);
    const turnId = typeof body['turnId'] === 'string' ? body['turnId'].slice(0, 200) : '';
    const terminalRequired = body['terminalRequired'] === true;
    // The page asking is the pickup the owed-reply watchdog is waiting for, whatever the
    // provider then says. On 2026-09-02 OpenRouter answered ten drafts in a row with 429 and the
    // page retried every fifteen seconds, alive the whole time; the watchdog only saw a reply
    // still owed after two minutes and reloaded the chat twice for a page that was never dead.
    // A reload cannot fix a rate limit, so each request pushes the reload out instead.
    if (id) noteGoalWatchActivity(id);
    const clientId = typeof body['clientId'] === 'string' ? body['clientId'].slice(0, 100) : '';
    if (!id) return json(res, 400, { error: 'bad_conversation_id' }, origin);
    if (!turnId) return json(res, 400, { error: 'bad_turn_id' }, origin);
    if (await conversationWasSuperseded(id)) {
      return json(res, 409, { error: 'conversation_superseded' }, origin);
    }
    if (
      terminalRequired &&
      goalPendingReplyFor(id)?.turnId !== turnId &&
      goalViewFor(id, clientId)?.turnId !== turnId
    ) {
      return json(res, 409, { error: 'goal_reply_not_pending', retryable: true }, origin);
    }
    // Checked here as well as in the page, because the page's copy of the setting is a poll
    // old and this is the request that spends somebody's OpenRouter credit.
    if (!goalActiveFor(id)) return json(res, 409, { error: 'goal_disabled' }, origin);
    if (!(await goalKeyPresent())) return json(res, 409, { error: 'no_api_key' }, origin);
    const live = liveConversations().find((entry) => entry.conversationId === id);
    const known = live ? null : await findSessionByConversation(id, { requireUnique: true });
    const sessionId = live?.sessionId ?? known?.id ?? null;
    if (!sessionId) {
      return json(
        res,
        409,
        { error: 'session_not_recorded', message: 'This chat has no recorded local session to continue from.' },
        origin
      );
    }
    if (chatStillWorking(id, turnId)) {
      // Owed, but not yet: the turn the page reported ended is still open here, or still
      // running tools. The
      // obligation is filed so a replacement page collects it; the draft itself waits for the
      // quiet minute, and the page asks again on its next pull.
      try {
        await acceptGoalReplyNow({
          conversationId: id,
          sessionId,
          replyId: `turn:${turnId}`.slice(0, 200),
          turnId,
          eventSeq: 0,
          blocked: false
        });
      } catch (err) {
        logWarn(`bridge: Goal turn ${turnId} for ${id} is not durable yet — ${err instanceof Error ? err.message : String(err)}`);
        return json(res, 503, { error: 'goal_reply_not_durable', retryable: true }, origin);
      }
      return json(
        res,
        409,
        { error: 'chat_still_working', retryable: true, message: 'This chat is still working on its answer; the app will draft once it has finished.' },
        origin
      );
    }
    let draft;
    try {
      // Reserve the browser owner synchronously, but do not let provider work begin until the
      // matching obligation below is crash-durable. This preserves the existing duplicate-tab
      // fence without leaving a failure window between OpenRouter and the state file.
      draft = startGoalDraft({
        sessionId,
        conversationId: id,
        turnId,
        clientId,
        deferStart: true
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'goal_owned_elsewhere') {
        return json(
          res,
          409,
          {
            error: 'goal_owned_elsewhere',
            message: 'Another tab is already handling Goal Mode for this chat.'
          },
          origin
        );
      }
      throw err;
    }
    // The page has crossed the semantic boundary: this exact completed ChatGPT turn is owed
    // one Goal decision. Its local id is provisional until the recorder delivers the stable
    // assistant id; a 429, app restart or page reload may discard an attempt, never this row.
    try {
      await acceptGoalReplyNow({
        conversationId: id,
        sessionId,
        replyId: `turn:${turnId}`.slice(0, 200),
        turnId,
        eventSeq: 0,
        blocked: false
      });
    } catch (err) {
      discardPreparedGoalDraft(id, draft.token);
      logWarn(`bridge: Goal turn ${turnId} for ${id} is not durable yet — ${err instanceof Error ? err.message : String(err)}`);
      return json(res, 503, { error: 'goal_reply_not_durable', retryable: true }, origin);
    }
    beginGoalDraft(id, draft.token);
    return json(res, 200, { goal: draft, sessionId }, origin);
  }

  if (route === '/goal/ack' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const id = conversationId(body['conversationId']);
    if (!id) return json(res, 400, { error: 'bad_conversation_id' }, origin);
    const token = typeof body['token'] === 'string' ? body['token'] : '';
    const clientId = typeof body['clientId'] === 'string' ? body['clientId'].slice(0, 100) : '';
    try {
      return json(res, 200, { acknowledged: await ackGoalDraftNow(id, token, clientId) }, origin);
    } catch (err) {
      logWarn(`bridge: Goal acknowledgement for ${id} is not durable yet — ${err instanceof Error ? err.message : String(err)}`);
      return json(res, 503, { error: 'goal_ack_not_durable', retryable: true }, origin);
    }
  }

  /**
   * The specific goal one chat is being driven towards.
   *
   * Set from the composer's settings sheet and persisted per conversation. Empty text clears
   * it. Reaching the goal stops that run but intentionally leaves the objective in place until
   * the user clears/replaces it, so reopening the chat still shows the finish line.
   *
   * Whatever is in flight for this chat is retired on the way through, because a draft is
   * frozen with the goal it was started under: without this, saving a new goal would still
   * type the old one's message into the chat one last time.
   *
   * A goal may name its own mode, and when it does that naming is authoritative for this
   * chat. The reason is a run that was lost: a goal written from the New Chat sheet starts
   * the chat immediately, but the mode it ran in was still read from the standing switch —
   * off, therefore Goal — so a two-hour unattended run ended at the second turn on one
   * "looks done" from the gate. The intent lives in the control the user pressed, so the
   * mode is pinned as this chat's own switch here, in the same request, before the goal
   * exists to be acted on. Clearing the goal turns that switch back off: the two were
   * written together and a bare mode left switched on would keep prompting a chat whose
   * finish line the user has just deleted.
   */
  if (route === '/goal/objective' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const id = conversationId(body['conversationId']);
    if (!id) return json(res, 400, { error: 'bad_conversation_id' }, origin);
    // A worker's user turns are the prime's to write. Refusing to *hold* a goal here, rather
    // than only refusing to act on one, keeps that rule in one place: nothing downstream has
    // to remember that this particular stored goal is one it must never use.
    if (goalWorkerChat(id)) return json(res, 409, { error: 'goal_worker_chat' }, origin);
    const text = typeof body['text'] === 'string' ? body['text'] : '';
    if (text.trim() && (await conversationWasSuperseded(id))) {
      return json(res, 409, { error: 'conversation_superseded' }, origin);
    }
    // Clearing is always allowed; giving a blocked chat something new to chase is not, for
    // the same reason the loop is off there — see goalBlockReason.
    if (text.trim() && isChatBlocked(id)) return json(res, 409, { error: 'chat_blocked' }, origin);
    const named =
      body['mode'] === 'goal' || body['mode'] === 'loop' ? (body['mode'] as 'goal' | 'loop') : null;
    let chatSwitch: { enabled: boolean; mode: 'goal' | 'loop' } | null = null;
    if (named) {
      const held = goalSwitchFor(id);
      // A goal being written names the mode; a goal being cleared ends whichever mode this
      // chat is actually running in, which is not necessarily the one whose editor cleared it.
      const on = text.trim().length > 0;
      const which = on ? named : held.enabled ? held.mode : named;
      try {
        // Before the goal, never after. A goal that exists for even one poll without the mode
        // it was written in is a goal the standing switch can answer for — the exact hole this
        // pinning closes.
        chatSwitch = await setGoalSwitchNow(id, which, on);
      } catch (err) {
        logWarn(`bridge: the ${which} switch for ${id} is not durable yet — ${err instanceof Error ? err.message : String(err)}`);
        return json(res, 503, { error: 'goal_switch_not_durable', retryable: true }, origin);
      }
    }
    const objective = await setGoalObjectiveNow(id, text);
    try {
      await setGoalReplyActiveNow(
        id,
        goalActiveFor(id) && getConfig().sessions.record && (await goalKeyPresent())
      );
      forgetGoalWatch(id);
    } catch (err) {
      logWarn(`bridge: Goal ticket for ${id} did not follow its objective — ${err instanceof Error ? err.message : String(err)}`);
      return json(res, 503, { error: 'goal_ticket_not_durable', retryable: true }, origin);
    }
    logInfo(
      objective
        ? `bridge: chat ${id} was given a specific goal${chatSwitch ? ` as ${chatSwitch.mode}` : ''}`
        : `bridge: the specific goal for chat ${id} was cleared`
    );
    return json(
      res,
      200,
      {
        objective,
        // What the chat's switch says now, so the sheet draws the mode the goal was saved in
        // rather than waiting a poll for it. Absent when the page named none.
        ...(chatSwitch ? { enabled: chatSwitch.enabled, own: true, mode: chatSwitch.mode } : {})
      },
      origin
    );
  }

  /**
   * The opening message for a chat that has no id yet.
   *
   * Everything else here is keyed by conversation, and a New Chat has none — ChatGPT assigns
   * one only when a message is sent, and the message being asked for is that one. So this
   * route holds nothing, streams nothing and is answered in place: the page waits for it,
   * types it, and comes back to /goal/objective with the real id once ChatGPT has issued it.
   *
   * The mode comes with it for the same reason it cannot be stored: there is no conversation
   * to hold a switch, so the choice the user made in the sheet is the only thing that knows
   * which instruction this opening is being written under.
   */
  if (route === '/goal/open' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const text = typeof body['text'] === 'string' ? body['text'] : '';
    if (!text.trim()) return json(res, 400, { error: 'no_objective' }, origin);
    if (!(await goalKeyPresent())) return json(res, 409, { error: 'no_api_key' }, origin);
    const opening =
      body['mode'] === 'goal' || body['mode'] === 'loop' ? (body['mode'] as 'goal' | 'loop') : null;
    const drafted = await draftOpeningMessage(text, opening);
    if ('error' in drafted) return json(res, 502, drafted, origin);
    return json(res, 200, drafted, origin);
  }

  /**
   * The two switches the composer's settings menu owns.
   *
   * Deliberately these two and nothing else. Everything else in this app's settings decides
   * what ChatGPT may reach on this machine, and a route the page can post to must never be
   * able to widen that; these are the two that only decide what the app does with a chat
   * that is already recorded.
   */
  /**
   * The same two settings, read rather than written.
   *
   * `/activity` carries them on every poll, but it is addressed by conversation and a New
   * Chat has none — and a New Chat is now somewhere a goal can be written, so the sheet
   * above that composer has to be able to say what the settings are. Nothing here is
   * conversation-scoped, so nothing here can be: no objective, no block, no draft.
   */
  if (route === '/settings' && req.method === 'GET') {
    return json(
      res,
      200,
      {
        context: contextView(),
        goal: {
          enabled: getConfig().goal.enabled,
          // The app-wide setting is nobody's own answer, by definition: it is what a chat that
          // has never said anything inherits.
          own: false,
          mode: goalModeFor(),
          hasKey: await goalKeyPresent(),
          model: getConfig().goal.model,
          objective: '',
          blocked: ''
        }
      },
      origin
    );
  }

  if (route === '/settings' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const auto = typeof body['autoCompact'] === 'boolean' ? (body['autoCompact'] as boolean) : null;
    const goal = typeof body['goal'] === 'boolean' ? (body['goal'] as boolean) : null;
    const loop = typeof body['loop'] === 'boolean' ? (body['loop'] as boolean) : null;
    const settingsConversation = conversationId(body['conversationId']);
    // One switch per request. Goal and Loop are one setting drawn as two controls, so a body
    // carrying both is a page describing a state that does not exist rather than a change.
    if (goal !== null && loop !== null) return json(res, 400, { error: 'goal_and_loop_exclusive' }, origin);
    if (auto === null && goal === null && loop === null) {
      return json(res, 400, { error: 'nothing_to_change' }, origin);
    }
    if (
      settingsConversation &&
      (auto === true || goal === true || loop === true) &&
      (await conversationWasSuperseded(settingsConversation))
    ) {
      return json(res, 409, { error: 'conversation_superseded' }, origin);
    }
    // Turning anything *on* from a blocked chat's composer is refused; turning it off is
    // still the user's to do. The block itself is lifted in the app, not here.
    if (
      settingsConversation &&
      (auto === true || goal === true || loop === true) &&
      isChatBlocked(settingsConversation)
    ) {
      return json(
        res,
        409,
        {
          error: 'chat_blocked',
          message: 'This chat is blocked in the app. Release it there before turning Goal, Loop or auto-compaction on.'
        },
        origin
      );
    }
    if (auto !== null && settingsConversation && goalWorkerChat(settingsConversation)) {
      return json(
        res,
        409,
        {
          error: 'worker_compaction_disabled',
          message: 'Worker chats never auto-compact and cannot change Compact & Resume from their composer.'
        },
        origin
      );
    }
    const which = goal !== null ? 'goal' : loop !== null ? 'loop' : null;
    // Which switch this request is actually turning. A composer always knows its own chat, so
    // a switch it sends is that chat's: the sheet is drawn beside one conversation and the
    // person flipping it is answering about that conversation, not about every chat they have
    // ever opened. Only a New Chat — no id yet, nothing to store an override against — still
    // moves the app-wide setting, which is exactly where it should be set: it is the default
    // every chat with no answer of its own inherits.
    const scoped = which !== null && settingsConversation !== null;
    // Read inside the queued update rather than before it, so a settings change racing this
    // one cannot leave the comparison below looking at a config neither request ever wrote.
    let driving: 'goal' | 'loop' | null = null;
    const before = scoped
      ? (() => {
          const held = goalSwitchFor(settingsConversation as string);
          return held.enabled ? held.mode : null;
        })()
      : null;
    const next = await updateConfig((config) => {
      driving = config.goal.enabled ? config.goal.mode : null;
      return {
        ...config,
        compaction: auto === null ? config.compaction : { ...config.compaction, auto },
        goal: scoped ? config.goal : applyGoalSwitch(config.goal, which, goal ?? loop)
      };
    });
    const chatSwitch = scoped
      ? await setGoalSwitchNow(settingsConversation as string, which as 'goal' | 'loop', (goal ?? loop) as boolean)
      : null;
    if (auto === false) {
      try {
        await cancelAutomaticResumesNow();
      } catch (err) {
        logWarn(`bridge: Auto Off could not durably cancel its compaction ticket(s) — ${err instanceof Error ? err.message : String(err)}`);
        return json(res, 503, { error: 'auto_compaction_cancel_not_durable', retryable: true }, origin);
      }
    }
    // Every change that takes authority away from work already in flight, not only switching
    // off: a draft started as a gate must not be typed after the user asked for a loop, and a
    // loop draft must not be typed after the user asked for a gate. Both are the same fact —
    // the instruction this request was made under is no longer the one in force. A chat-scoped
    // change retires that chat's draft and nobody else's, because nobody else's instruction moved.
    if (chatSwitch) {
      // `chatSwitch.mode === which` also covers retrying the same POST after the ticket write
      // failed but the separate switch file landed. The second request must repair the ticket
      // instead of deciding there is no transition left to perform.
      if (before !== (chatSwitch.enabled ? chatSwitch.mode : null) || chatSwitch.mode === which) {
        const chatId = settingsConversation as string;
        try {
          // The switch and the ticket are one user decision. Off durably closes the pickup;
          // On (including Goal <-> Loop) re-arms the latest stable final under the new mode.
          await setGoalReplyActiveNow(
            chatId,
            chatSwitch.enabled && getConfig().sessions.record && (await goalKeyPresent())
          );
          forgetGoalWatch(chatId);
        } catch (err) {
          logWarn(`bridge: Goal ticket for ${chatId} did not follow its switch — ${err instanceof Error ? err.message : String(err)}`);
          return json(res, 503, { error: 'goal_ticket_not_durable', retryable: true }, origin);
        }
      }
    } else if (driving !== (next.goal.enabled ? next.goal.mode : null)) {
      retireGoalDrafts();
    }
    // The app's own settings screen is showing these two switches as well.
    changed();
    logInfo(
      `bridge: browser set ${[
        auto === null ? '' : `automatic compaction ${auto ? 'on' : 'off'}`,
        goal === null ? '' : `Goal ${goal ? 'on' : 'off'}`,
        loop === null ? '' : `Loop ${loop ? 'on' : 'off'}`
      ]
        .filter(Boolean)
        .join(' and ')}${scoped ? ` for chat ${settingsConversation}` : ''}`
    );
    return json(
      res,
      200,
      {
        context: contextView(),
        goal: {
          // What this chat's switch now says, which is the only answer its composer can draw.
          enabled: chatSwitch ? chatSwitch.enabled : next.goal.enabled,
          // A chat-scoped write is this chat answering for itself, and the sheet must draw that
          // on the same frame — the next poll is a second away and the Off it just chose would
          // read as an inherited one until then.
          own: chatSwitch !== null,
          mode: chatSwitch ? chatSwitch.mode : next.goal.mode,
          hasKey: await goalKeyPresent(),
          model: next.goal.model
        }
      },
      origin
    );
  }

  // The targeted-open path: one page, opened by the app, redeeming the one command the
  // app opened it for. The id is not a credential — this route is behind the same bearer
  // token as everything else — it is a correlation marker, which is why a leaked URL or a
  // synced history entry is worth nothing on its own.
  if (route === '/commands/redeem' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    tidyCommands();
    const wanted = typeof body['id'] === 'string' ? body['id'] : '';
    const client = typeof body['client'] === 'string' ? body['client'].slice(0, 64) : '';
    const reportedConversation = body['conversationId'] === undefined ? null : conversationId(body['conversationId']);
    if (body['conversationId'] !== undefined && !reportedConversation) {
      return json(res, 400, { error: 'bad_conversation_id' }, origin);
    }
    const command = commands.find((entry) => entry.id === wanted);
    if (!command) {
      // Cancelled, superseded, already sent, or from a previous run of the app. The page
      // does nothing, which is the point: a stale marker must never type anything.
      return json(res, 404, { error: 'no_such_command' }, origin);
    }
    if (revivalDeliveryProven(command)) {
      // The browser send already crossed its semantic boundary. Keep the durable command only
      // as the original 30-second liveness clock; never hand its text to any document again.
      return json(res, 409, { error: 'command_already_sent', final: true }, origin);
    }
    const resumeFence = command.spec.type === 'resume' ? continuationByToken(command.spec.token) : null;
    if (command.spec.type === 'resume' && !(resumeFence && sendUnattempted(resumeFence.destinationSend))) {
      return json(res, 409, { error: 'command_already_sent', final: true }, origin);
    }
    if (command.spec.type === 'revive' && !revivalFor(command.spec.agent)) {
      // tidyCommands() above normally retires these. This is the fail-closed twin of that:
      // an empty revival has no message of the prime's to type, and a page must never be
      // handed a command that would put nothing, or scaffolding alone, into a real chat.
      return json(res, 404, { error: 'no_such_command' }, origin);
    }
    if (
      reportedConversation &&
      (command.spec.type !== 'revive' || command.spec.conversationId !== reportedConversation)
    ) {
      // An existing ChatGPT page is allowed to claim exactly one kind of command: a revival
      // naming that exact chat. This check happens before the command acquires an owner, so a
      // copied/stale worker or resume marker cannot steal the real fresh page's lease merely by
      // being opened inside some already-existing conversation.
      return json(res, 409, { error: 'command_wrong_conversation' }, origin);
    }
    // One command, one page. `client` is the page's own per-document id, and the first one
    // to redeem owns the command until its lease lapses — a second tab on the same marker
    // is told there is nothing for it, while the owner's own retries are the same owner and
    // are answered every time.
    //
    // This is what makes the marker safe to be in a URL. A marker can be reloaded, synced,
    // restored by "reopen closed tab", or opened twice by a user watching a slow tab; every
    // one of those is a second page that would otherwise be handed the same brief and send
    // it, and two replacement chats for one session is the failure the whole continuation
    // transaction exists to make impossible.
    if (!client) return json(res, 400, { error: 'bad_client' }, origin);
    // The bootstrap has provably not been typed yet, so a fresh document may take the tab's
    // place — the page that held it is gone, or was never able to type at all.
    const resumeTakeover = Boolean(resumeFence && sendUnattempted(resumeFence.destinationSend));
    if (command.owner && command.owner !== client && !resumeTakeover) {
      return json(res, 409, { error: 'command_taken' }, origin);
    }
    // Renew rather than count another attempt: the app already spent one opening this page,
    // and this is that same attempt arriving. The lease is durable *before* the bootstrap is
    // handed over, so an app restart cannot reopen the same command into a second tab.
    const claimedAt = Date.now();
    if (command.spec.type === 'revive') {
      const claimed = await persistRevivalRedeem(command, client, claimedAt);
      if (claimed === 'stale') {
        // A proven MCP call won `waking -> active` before this browser claimed the wake. No
        // payload has escaped, so the page must not type the same queued words as a second user
        // message. Retire the now-meaningless bridge command without failing the active worker.
        retire(command, 'its worker became active before the browser claimed the wake');
        return json(res, 404, { error: 'no_such_command' }, origin);
      }
      if (claimed === 'taken') return json(res, 409, { error: 'command_taken' }, origin);
      if (claimed === 'broker-not-durable') {
        return json(res, 503, { error: 'worker_revival_claim_not_durable', retryable: true }, origin);
      }
      if (claimed === 'lease-not-durable') {
        return json(res, 503, { error: 'command_lease_not_durable', retryable: true }, origin);
      }
    } else if (!(await persistCommandLease(command, client, claimedAt, resumeTakeover))) {
      if (command.owner && command.owner !== client && !resumeTakeover) {
        return json(res, 409, { error: 'command_taken' }, origin);
      }
      return json(res, 503, { error: 'command_lease_not_durable', retryable: true }, origin);
    }
    // `claim()` armed the original browser-open deadline. A page can legitimately spend a
    // large part of that window just getting Chrome/ChatGPT started before it redeems the
    // marker, and content.js then has its own bounded composer + conversation-id wait. Merely
    // moving `claimedAt` made `isLeased()` say the lease was fresh while the old timer still
    // expired it at the original wall-clock deadline. Renew both halves of the lease here.
    armDeadline(command);
    changed();
    let claimedSummary: string | undefined;
    if (command.spec.type === 'resume') {
      try {
        // The command, not one browser document, is the semantic claimant. Before the
        // destination pre-Send checkpoint a reloaded document may adopt this same command;
        // afterwards no document redeems again and the marked ChatGPT message finishes it.
        const claimed = await claimContinuationNow(command.spec.token, command.id);
        if (!claimed) return json(res, 409, { error: 'continuation_not_claimable' }, origin);
        claimedSummary = claimed.summary;
        // Replace the short page-open timer with the continuation's existing outer lifetime.
        armDeadline(command);
      } catch (err) {
        logWarn(`bridge: could not durably claim ${specKey(command.spec)} — ${err instanceof Error ? err.message : String(err)}`);
        return json(res, 503, { error: 'continuation_claim_not_durable', retryable: true }, origin);
      }
    }
    return json(res, 200, { command: describe(command, client, claimedSummary) }, origin);
  }

  if (route === '/commands/ack' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const id = typeof body['id'] === 'string' ? body['id'] : '';
    // A protocol-1 extension sends no status and only ever acknowledges a success, so
    // a missing status still means "sent".
    const raw = typeof body['status'] === 'string' ? body['status'] : 'sent';
    const status: AckStatus = raw === 'failed' ? 'failed' : 'sent';
    const error = typeof body['error'] === 'string' ? body['error'].slice(0, 200) : null;
    const client = typeof body['client'] === 'string' ? body['client'].slice(0, 64) : '';
    const conversation = conversationId(body['conversationId']);
    const priorReceipt = receiptFor(id);
    if (priorReceipt) {
      // A receipt is the final answer to an ambiguous/lost ACK response. It is replayable only
      // by the exact browser document and exact conversation that completed the command.
      if ((priorReceipt.client ?? '') !== client) {
        return json(res, 409, { error: 'receipt_client_changed' }, origin);
      }
      if ((priorReceipt.conversationId ?? null) !== conversation) {
        return json(res, 409, { error: 'receipt_conversation_changed' }, origin);
      }
      return json(res, 200, receiptReply(priorReceipt), origin);
    }
    const ownedCommand = commands.find((command) => command.id === id) ?? null;
    // Every current page echoes its per-document client. If its command has already expired,
    // been cancelled or been superseded, accepting the late ACK as success strands a real
    // tab whose model can never be bound to the worker/session it was opened for. Legacy
    // protocol pages omitted client and keep their old idempotent no-op response.
    if (!ownedCommand && client) {
      return json(res, 404, { error: 'no_such_command' }, origin);
    }
    if (!ownedCommand) {
      // Compatibility for an already-open legacy page that predates document ids: historically
      // an ACK whose command was already gone was an idempotent no-op. Current pages always
      // send `client`, so they take the receipt/404 path above and never get this ambiguous 2xx.
      return json(res, 200, { ok: true }, origin);
    }
    // The document that redeemed the marker is the only document allowed to finish it.
    // `client` is optional on the wire for compatibility with an extension already open
    // during an app upgrade, but every current page sends it. When present, fail closed if
    // the command has since been superseded/released or another document owns it: accepting
    // a delayed ACK from the old page could otherwise bind a worker or commit a continuation
    // to the wrong chat after ownership had moved.
    if (ownedCommand && client && ownedCommand.owner !== client) {
      return json(res, 409, { error: 'command_owner_changed' }, origin);
    }
    if (ownedCommand && client && ownedCommand.claimedAt === null) {
      return json(res, 409, { error: 'command_not_leased' }, origin);
    }
    const agent = ownedCommand?.spec.type === 'worker' ? ownedCommand.spec.agent : null;
    // The one moment at which the queued command and the conversation it became are
    // both in hand, and so the only chance to name that chat after the work rather
    // than after the bootstrap prompt about to be typed into it.
    const opened = status === 'sent' ? commandOrigin(id) : null;
    if (conversation && opened) {
      await noteChatOrigin(conversation, opened).catch((err: Error) =>
        logWarn(`could not record the origin of a fresh chat: ${err.message}`)
      );
    }
    // noteChatOrigin() is an awaited side operation. Cancellation, expiry, or another ACK may
    // have changed the command while we were there, so the original validation is stale now.
    const afterOriginReceipt = receiptFor(id);
    if (afterOriginReceipt) {
      if ((afterOriginReceipt.client ?? '') !== client || (afterOriginReceipt.conversationId ?? null) !== conversation) {
        return json(res, 409, { error: 'receipt_identity_changed' }, origin);
      }
      return json(res, 200, receiptReply(afterOriginReceipt), origin);
    }
    const command = commands.find((entry) => entry.id === id) ?? null;
    if (!command || command !== ownedCommand) {
      return json(res, 404, { error: 'no_such_command' }, origin);
    }
    if (client && command.owner !== client) {
      return json(res, 409, { error: 'command_owner_changed' }, origin);
    }

    let receipt: CommandReceipt;
    if (status === 'sent') {
      if (!conversation && command.spec.type !== 'worker') {
        // A successful page send without a concrete chat id is ambiguous, not terminal. Keep
        // the one leased attempt alive so the browser can retry its ACK when identity appears.
        // A revival needs it for a second reason: the chat id is the proof that what was typed
        // went into the worker's own conversation and not into some other tab.
        return json(res, 503, { error: 'conversation_required', retryable: true }, origin);
      }
      if (command.spec.type === 'revive') {
        // Narrowed above.
        if (!conversation) return json(res, 503, { error: 'conversation_required', retryable: true }, origin);
        const revive = command.spec;
        const wrongChat = conversation !== revive.conversationId;
        const staleRun = revive.runId !== currentRunId();
        const revival = wrongChat || staleRun ? null : revivalFor(revive.agent);
        const alreadySent =
          !wrongChat &&
          !staleRun &&
          command.claimedAt !== null &&
          workerRevivalDeliveredSince(revive.agent, conversation, command.id, command.claimedAt);
        // The send is an *offer*, not an acknowledgement: the words are in the worker's chat,
        // and the worker's own next authenticated call is what retires them from its inbox.
        const woke = alreadySent || (revival ? noteWorkerRevived(revive.agent, conversation, revival.messageIds, command.id) : false);
        if (woke) {
          receipt = {
            id,
            client: client || command.owner,
            conversationId: conversation,
            outcome: 'committed',
            committed: true,
            error: null,
            completedAt: Date.now()
          };
        } else {
          const why = wrongChat
            ? 'the page that was opened for it was showing a different conversation'
            : staleRun
              ? 'the worker run that owns this chat has ended'
              : 'it was no longer waiting to be woken by the time the browser answered';
          // Only the first two are this revival's to undo. A worker that stopped waking on its
          // own has already been put somewhere by whatever did that, and failWorkerRevival()
          // ignores anything that is not still `waking`, so this cannot invent a failure.
          failWorkerRevival(revive.agent, why);
          receipt = {
            id,
            client: client || command.owner,
            conversationId: conversation,
            outcome: 'terminal-failure',
            committed: false,
            error: why,
            completedAt: Date.now()
          };
        }
      } else if (command.spec.type === 'resume') {
        // Narrowed above.
        if (!conversation) return json(res, 503, { error: 'conversation_required', retryable: true }, origin);
        const result = await commitContinuationResult(command.spec.token, conversation);
        if (result.status === 'retryable') {
          logWarn(`bridge: resume commit for ${command.spec.sessionId} remains retryable — ${result.reason}`);
          return json(res, 503, { error: 'resume_commit_retryable', retryable: true }, origin);
        }
        if (result.status === 'rejected') {
          const state = continuationByToken(command.spec.token);
          if (state?.state === 'committing' || state?.state === 'committed') {
            // Once the WAL/session commit is non-abortable, a conflicting/lost ACK cannot turn
            // it into a cancellation just because this HTTP request reached a bad branch.
            return json(res, 503, { error: 'resume_commit_not_abortable', retryable: true }, origin);
          }
          try {
            const aborted = await abortContinuationNow(command.spec.token, result.reason);
            const afterAbort = continuationByToken(command.spec.token);
            if (!aborted && afterAbort?.state !== 'aborted') {
              if (afterAbort?.state === 'committing' || afterAbort?.state === 'committed') {
                return json(res, 503, { error: 'resume_commit_not_abortable', retryable: true }, origin);
              }
              return json(res, 503, { error: 'resume_abort_retryable', retryable: true }, origin);
            }
          } catch (err) {
            logWarn(`bridge: could not durably abort rejected resume ${command.spec.sessionId} — ${err instanceof Error ? err.message : String(err)}`);
            return json(res, 503, { error: 'resume_abort_not_durable', retryable: true }, origin);
          }
          receipt = {
            id,
            client: client || command.owner,
            conversationId: conversation,
            outcome: 'terminal-failure',
            committed: false,
            error: result.reason,
            completedAt: Date.now()
          };
        } else {
          if (result.status === 'committed') armResumedChat(command.spec.sessionId, result.conversationId);
          receipt = {
            id,
            client: client || command.owner,
            conversationId: result.conversationId,
            outcome: 'committed',
            committed: true,
            error: null,
            completedAt: Date.now()
          };
        }
      } else {
        if (!conversation) {
          const why = 'the chat this app opened for it never said which conversation it was';
          if (agent) failAgent(agent, why);
          receipt = {
            id,
            client: client || command.owner,
            conversationId: null,
            outcome: 'terminal-failure',
            committed: false,
            error: why,
            completedAt: Date.now()
          };
          if (!(await finalizeCommand(command, receipt))) {
            return json(res, 503, { error: 'command_receipt_not_durable', retryable: true }, origin);
          }
          logInfo(`bridge: ${specKey(command.spec)} completed with ${receipt.outcome}`);
          void deliver();
          return json(res, 200, receiptReply(receipt), origin);
        }
        if (command.spec.runId !== currentRunId()) {
          // A command id is precise, but it is not immortal. If the broker run changed while
          // this page was opening, the old command must not bind the same friendly worker id
          // in the new run. Normal run teardown removes these commands synchronously; this is
          // the last fail-closed check for a late ACK racing that teardown.
          receipt = {
            id,
            client: client || command.owner,
            conversationId: conversation,
            outcome: 'terminal-failure',
            committed: false,
            error: 'the worker run that opened this chat has ended',
            completedAt: Date.now()
          };
        } else {
        // This is where a worker starts. Do it only after the post-await command ownership
        // revalidation above; a page cancelled while noteChatOrigin ran must never bind a slot.
        if (agent && /^[a-z0-9-]{1,40}$/i.test(agent)) {
          const boundNow = bindConversation(agent, conversation);
          // The worker inherited a workspace before its chat existed, under the reusable
          // friendly id `agent:worker-N`. The browser binding is the first authoritative moment
          // that exact ChatGPT conversation is known, so migrate the staging key now even if the
          // worker never makes a local tool call before it finishes/sleeps.
          if (boundNow) bindAgentWorkspace(agent, conversation);
        }
        const bound = agent ? !pendingWorkerSpawns().some((worker) => worker.id === agent) : false;
        if (!bound) {
          const why = 'the chat this app opened for the worker could not be bound to that slot';
          if (agent) failAgent(agent, why);
          receipt = {
            id,
            client: client || command.owner,
            conversationId: conversation,
            outcome: 'terminal-failure',
            committed: false,
            error: why,
            completedAt: Date.now()
          };
        } else {
          receipt = {
            id,
            client: client || command.owner,
            conversationId: conversation,
            outcome: 'committed',
            committed: true,
            error: null,
            completedAt: Date.now()
          };
        }
        }
      }
    } else if (command.spec.type === 'resume') {
      const state = continuationByToken(command.spec.token);
      if (state?.state === 'committed') {
        receipt = {
          id,
          client: client || command.owner,
          conversationId: state.to,
          outcome: 'committed',
          committed: true,
          error: null,
          completedAt: Date.now()
        };
      } else {
        const why = error ? `the browser could not start the chat — ${error}` : 'the browser could not start the chat';
        try {
          const aborted = await abortContinuationNow(command.spec.token, why);
          const afterAbort = continuationByToken(command.spec.token);
          if (!aborted && afterAbort?.state !== 'aborted') {
            if (afterAbort?.state === 'committing' || afterAbort?.state === 'committed') {
              return json(res, 503, { error: 'resume_commit_not_abortable', retryable: true }, origin);
            }
            return json(res, 503, { error: 'resume_abort_retryable', retryable: true }, origin);
          }
        } catch (err) {
          logWarn(`bridge: could not durably abort failed resume ${command.spec.sessionId} — ${err instanceof Error ? err.message : String(err)}`);
          return json(res, 503, { error: 'resume_abort_not_durable', retryable: true }, origin);
        }
        receipt = {
          id,
          client: client || command.owner,
          conversationId: conversation,
          outcome: 'terminal-failure',
          committed: false,
          error: why,
          completedAt: Date.now()
        };
      }
    } else if (command.spec.type === 'revive') {
      const why = error
        ? `the browser could not reopen the worker's chat — ${error}`
        : "the browser could not reopen the worker's chat";
      failWorkerRevival(command.spec.agent, why);
      receipt = {
        id,
        client: client || command.owner,
        conversationId: conversation,
        outcome: 'terminal-failure',
        committed: false,
        error: why,
        completedAt: Date.now()
      };
    } else {
      const why = error ? `the browser could not start the chat — ${error}` : 'the browser could not start the chat';
      if (agent) failAgent(agent, why);
      receipt = {
        id,
        client: client || command.owner,
        conversationId: conversation,
        outcome: 'terminal-failure',
        committed: false,
        error: why,
        completedAt: Date.now()
      };
    }

    if (command.spec.type === 'worker' || command.spec.type === 'revive') {
      // The browser command and the swarm snapshot are two durable files describing one
      // transition. The receipt must be the *second* one: once bridge-commands says this
      // bootstrap is finished, restart will never redeem it again. If the worker binding /
      // failure that explains that receipt has not reached disk first, a crash restores an
      // invited worker with no command left and the broker opens a duplicate chat. Keep the
      // leased command retryable until the exact critical swarm revision is durable.
      try {
        if (!(await persistCriticalSwarmNow())) {
          return json(res, 503, { error: 'worker_state_not_durable', retryable: true }, origin);
        }
      } catch (err) {
        logWarn(`bridge: worker state for ${specKey(command.spec)} is not durable yet — ${err instanceof Error ? err.message : String(err)}`);
        return json(res, 503, { error: 'worker_state_not_durable', retryable: true }, origin);
      }
    }

    if (command.spec.type === 'revive' && receipt.committed) {
      // Delivery is not worker liveness. Leave the exact leased command (and its original
      // createdAt deadline) in place. Its durable broker offer makes retries idempotent, while
      // nextDeliverable() treats it as non-deliverable so it neither resends nor blocks siblings.
      logInfo(`bridge: ${specKey(command.spec)} was delivered; waiting for attributed worker activity`);
      changed();
      void deliver();
      return json(res, 200, receiptReply(receipt), origin);
    }

    if (!(await finalizeCommand(command, receipt))) {
      // The semantic operation may already be committed. 5xx is intentional: old browser
      // code only settles successful HTTP responses, so it must retry until the app can prove
      // the receipt itself is durable rather than treating an ambiguous local disk failure as
      // completion.
      return json(res, 503, { error: 'command_receipt_not_durable', retryable: true }, origin);
    }
    // A failed bootstrap/revival can be the transition that frees the final worker slot, and
    // unlike an MCP call there is no dispatcher epilogue after this ACK. Settle the durable
    // command first, then release/park the quiescent active incarnation if no slot is occupied.
    releaseQuiescentRun();
    logInfo(`bridge: ${specKey(command.spec)} completed with ${receipt.outcome}`);
    void deliver();
    return json(res, 200, receiptReply(receipt), origin);
  }

  return json(res, 404, { error: 'not_found' }, origin);
}

// ------------------------------------------------------------ stale swarm

interface DurableQuiescence {
  quiescent: boolean;
  ended: boolean;
  lastOutcome: string | null;
}

/**
 * Turns already-accepted, never-offered worker inbox rows into a browser revival after stop.
 *
 * The broker stages the `sleeping -> waking` reservation first; this helper owns the matching
 * durability barrier and only asks the browser after that exact revision is on disk. Failure is
 * recoverable: rollback leaves the worker sleeping with the original message still unread.
 */
async function wakeQueuedStoppedWorkers(ids: readonly string[]): Promise<void> {
  const staged = stageQueuedWorkerRevivals(ids);
  if (staged.waking.length === 0) return;
  try {
    if (!(await persistCriticalSwarmNow())) {
      staged.rollback();
      logWarn('multi-agent: queued work could not reserve a durable revival after its worker stopped');
      return;
    }
    staged.commit();
    requestWorkerRevivals(staged.waking);
  } catch (err) {
    staged.rollback();
    logWarn(
      `multi-agent: queued work could not reserve a durable revival after its worker stopped — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Durable proof that one bound ChatGPT conversation has been inactive long enough to treat
 * as orphaned. Silence by itself is never enough: a still-open turn fails this check even if
 * its last write is hours old.
 */
async function durableQuiescence(conversationId: string, now: number): Promise<DurableQuiescence> {
  const live = liveConversations().find((entry) => entry.conversationId === conversationId);
  if (live?.generating) return { quiescent: false, ended: false, lastOutcome: null };
  const summary = await findSessionByConversation(conversationId, {
    requireUnique: true
  });
  if (!summary) return { quiescent: false, ended: false, lastOutcome: null };
  const modifiedAt = await sessionDurableModifiedAt(summary.id);
  const lastDurableWrite = Math.max(summary.updatedAt, summary.endedAt ?? 0, modifiedAt ?? 0);
  if (lastDurableWrite <= 0 || now - lastDurableWrite < STALE_SWARM_MS) {
    return {
      quiescent: false,
      ended: summary.endedAt !== null,
      lastOutcome: summary.lastTurnOutcome
    };
  }

  let lastOutcome: string | null = summary.lastTurnOutcome;
  if (summary.activeTurnId) return { quiescent: false, ended: summary.endedAt !== null, lastOutcome };
  // Pre-1.8.8 metadata has no durable open-turn projection. Bound that one migration path
  // to the newest tail instead of reparsing the full lifetime on every 30-second sweep.
  if (summary.activeTurnId === undefined) {
    const openTurns = new Set<string>();
    for (const event of await readRecentEvents(summary.id, 4096, {
      kinds: ['turn_start', 'turn_end']
    })) {
      if (event.kind === 'turn_start' && event.turnId) openTurns.add(event.turnId);
      else if (event.kind === 'turn_end') {
        if (event.turnId) openTurns.delete(event.turnId);
        lastOutcome = event.outcome;
      }
    }
    if (openTurns.size > 0) return { quiescent: false, ended: summary.endedAt !== null, lastOutcome };
  }
  if (summary.endedAt !== null) return { quiescent: true, ended: true, lastOutcome };
  // A live-but-idle session needs one durable terminal turn. A session with only a bootstrap
  // message and no turn_end is not proof that ChatGPT ever finished the worker/prime turn.
  return { quiescent: lastOutcome !== null, ended: false, lastOutcome };
}

/**
 * Retires only runs that durable state proves are quiescent/orphaned.
 *
 * Immediate cleanup remains the normal path: worker Turn completed terminalises its slot,
 * and the prime's next authenticated MCP call acknowledges final reports and releases the run.
 * This sweep exists for the abandoned-tail case where no such next call arrives.
 */
export async function sweepStaleSwarm(now = Date.now()): Promise<boolean> {
  const silent = inspectSilentChats(now);
  // A Goal/Loop chat that is spent is not abandoned: the loop owes it the next message.
  await fileSilenceGoalTickets(silent.spent, now);
  // Beside the silence pass rather than inside it: they measure the same quiet from opposite
  // ends of a turn — one an answer that never arrived, one an answer that arrived and was never
  // picked up — and a chat can only ever be in one of those states.
  const goalsQueued = await inspectOwedGoals(now);
  const compactionsQueued = await inspectOwedCompactions(now);
  const silenceChanged = silent.queued || silent.spent.length > 0 || goalsQueued || compactionsQueued;
  const runId = currentRunId();
  if (swarmTransferActive() || inFlightMcpRequests() > 0 || observationWritesInFlight > 0) {
    return silent.queued || goalsQueued || compactionsQueued;
  }

  if (!runId) {
    finishSilentChats(silent.spent);
    return silenceChanged;
  }

  let state = swarmState();
  if (!state.running) {
    finishSilentChats(silent.spent);
    return silenceChanged;
  }

  // A detached worker has no browser page left to publish a turn boundary. Its dedicated
  // silence clock is therefore the only path that can eventually release the slot when the
  // server-side turn also stops calling tools. This used to run only on later MCP ingress,
  // which means the exact worker that became completely silent was never reconsidered. Run it
  // from the bridge's 30-second maintenance loop as well; attached/background workers are
  // explicitly excluded inside sleepSilentDetachedWorkers and still require durable turn proof.
  const stoppedWorkers: string[] = [];

  // Block is the user's stop for that chat, and a worker whose chat is blocked is not working
  // on this run: every tool it calls is refused and no browser recovery will ever be attempted
  // for it. It is slept here, on every pass, from the durable block alone. It used to be slept
  // only when the chat's silence grant expired — and that grant is process memory. On
  // 2026-09-02 worker-3 was blocked, the app restarted, and the restored run carried it as
  // `active` with no grant left to expire: it held the swarm's slot for an hour, the next
  // prime was refused with AGENTS_BUSY, and the slot came free only when its tab finally
  // closed and the detached clock ran out.
  for (const agent of state.agents) {
    if (agent.role !== 'worker' || !occupiesSlot(agent.state) || !agent.conversationId) continue;
    if (!isChatBlocked(agent.conversationId)) continue;
    const slept = sleepWorker(
      agent.id,
      'The user blocked its chat, so its tools are refused, no browser recovery was attempted and its open turn was abandoned.'
    );
    if (!slept) continue;
    if (slept.report) await recordAgentMessage(slept.report, 'sent');
    stoppedWorkers.push(agent.id);
    finishSilentChats([agent.conversationId]);
  }

  // Every open chat gets the same one-shot reload. Only after the browser confirms carrying it
  // out, and another maintenance pass finds no durable progress, does an active Worker release
  // its slot. Prime and ordinary chats have no worker slot to mutate; forgetting their grant is
  // their bounded abandonment and prevents a reload loop.
  for (const conversationId of silent.spent) {
    const worker = state.agents.find(
      (agent) =>
        agent.role === 'worker' && agent.state === 'active' && agent.conversationId === conversationId
    );
    if (!worker) continue;
    const slept = sleepWorker(
      worker.id,
      'Its open ChatGPT turn went silent for two minutes and no browser recovery brought it back.'
    );
    if (slept?.report) await recordAgentMessage(slept.report, 'sent');
    if (slept) stoppedWorkers.push(worker.id);
  }
  finishSilentChats(silent.spent);

  for (const slept of sleepSilentDetachedWorkers(now)) {
    if (slept.info.conversationId) repairsInFlight.delete(slept.info.conversationId);
    if (slept.report) await recordAgentMessage(slept.report, 'sent');
    stoppedWorkers.push(slept.info.id);
  }
  if (stoppedWorkers.length > 0) state = swarmState();

  // The one place a worker that never called finish is allowed to stop holding its slot, and
  // the only one entitled to say so: durable quiescence is proof that no turn is running, which
  // page heartbeats and wall-clock silence are not. Invited/unbound workers remain the bootstrap
  // timeout's responsibility; there is no conversation/session whose inactivity we can prove.
  //
  // Stopping is sleeping. Nothing observed from outside a chat can tell the difference between
  // a worker that has finished for good and one that is between tasks, so this sweep never
  // makes that call: it frees the slot, hands the prime a worker it can wake in the chat it
  // already has, and leaves the ending to the worker's own finish or to the context ceiling.
  // `sleeping`/`waking` rows are skipped because they have already stopped, or are being woken.
  for (const worker of state.agents.filter(
    (agent) => agent.role === 'worker' && (agent.state === 'active' || agent.state === 'detached')
  )) {
    if (!worker.conversationId) continue;
    const proof = await durableQuiescence(worker.conversationId, now);
    if (currentRunId() !== runId || swarmTransferActive() || inFlightMcpRequests() > 0 || observationWritesInFlight > 0) return false;
    if (!proof.quiescent) continue;

    if (proof.lastOutcome === 'completed') {
      // It answered and stopped. Its own last message is the report, exactly as if it had
      // remembered to call finish, and the worker keeps everything it knows.
      const finished = finishWorkerConversation(
        worker.conversationId,
        'Worker turn completed and remained durably inactive for the orphan grace period.'
      );
      if (finished?.report) {
        await recordAgentMessage(finished.report, 'sent');
        stoppedWorkers.push(worker.id);
      }
    } else {
      const slept = sleepWorker(
        worker.id,
        proof.ended
          ? 'Its ChatGPT chat was closed and its work has been durably quiet since.'
          : `Its last ChatGPT turn ended ${proof.lastOutcome ?? 'without a completed outcome'} and it has been durably quiet since.`
      );
      if (slept?.report) {
        await recordAgentMessage(slept.report, 'sent');
        stoppedWorkers.push(worker.id);
      }
    }
  }

  await wakeQueuedStoppedWorkers(stoppedWorkers);

  if (currentRunId() !== runId || swarmTransferActive() || inFlightMcpRequests() > 0 || observationWritesInFlight > 0) return false;
  state = swarmState();
  const workers = state.agents.filter((agent) => agent.role === 'worker');
  // New lifecycle: an active run is capacity currently being consumed, not ownership of every
  // reusable worker chat. The broker decides whether all slot-holders are gone and, when so,
  // parks the owner state while releasing the global active claim. Ask it before the legacy
  // orphan fallback below; under older/terminal-only semantics this simply returns false for a
  // sleeping worker and leaves the existing checks unchanged.
  if (releaseQuiescentRun()) return true;
  // A sleeping worker is not a finished one, and a run that owns one is not abandoned: its
  // chats are the thing the prime comes back to. Only a run whose every worker has genuinely
  // ended — finished, failed, or past the context ceiling — can be released from here at all;
  // anything else waits for the person to clear it in the app.
  if (workers.length === 0 || workers.some((agent) => !agent.revivable && agent.state !== 'finished' && agent.state !== 'failed')) return silenceChanged;
  if (workers.some((agent) => agent.revivable)) return silenceChanged;

  // Orphan fallback may discard still-pending final reports only after the prime and every
  // bound terminal worker are themselves durably quiescent for the full grace period.
  const prime = state.agents.find((agent) => agent.role === 'prime') ?? null;
  if (!prime?.conversationId) return silenceChanged;
  const primeProof = await durableQuiescence(prime.conversationId, now);
  if (!primeProof.quiescent) return silenceChanged;
  for (const worker of workers) {
    if (!worker.conversationId) continue;
    const proof = await durableQuiescence(worker.conversationId, now);
    if (!proof.quiescent) return silenceChanged;
  }
  if (currentRunId() !== runId || swarmTransferActive() || inFlightMcpRequests() > 0 || observationWritesInFlight > 0) return false;
  return releaseQuiescentRun({
    allowPendingReports: true,
    reason: 'all workers are terminal and the run remained durably quiescent past the orphan grace period'
  }) || silenceChanged;
}

// -------------------------------------------------------------------- server

/** Unsubscribes this module's swarm-end listener. Held so a restart cannot double it. */
let dropSwarmEndListener: (() => void) | null = null;
let staleSwarmTimer: NodeJS.Timeout | null = null;
/** One wake-up on the earliest live silence deadline. See armSilenceSweep(). */
let silenceTimer: NodeJS.Timeout | null = null;
let staleSweepInFlight: Promise<boolean> | null = null;
/**
 * Serializes bridge start/stop transitions while a generation marks the latest desired state.
 *
 * A stop must invalidate an in-progress start immediately so recovery cannot publish/deliver
 * browser work during shutdown. But stop -> immediate start is equally real (rapid settings
 * toggles): that later start must make the queued stop stale rather than joining the cancelled
 * promise or letting the older stop close the newer server. Desired state + epoch gives both
 * directions one arbitration rule; the queue ensures their destructive socket work never races.
 */
let bridgeLifecycleEpoch = 0;
let bridgeDesiredRunning = false;
let bridgeLifecycleQueue: Promise<void> = Promise.resolve();
let bridgeStartRequest: Promise<number | null> | null = null;
let bridgeStopRequest: Promise<void> | null = null;
/**
 * Final app shutdown is terminal; ordinary settings-driven stop/start is not.
 *
 * A renderer IPC handler can already be in flight when Electron enters `will-quit`. If that
 * handler finishes saving settings after shutdown called stopBridge(), its later startBridge()
 * must not become the newest desired state and resurrect the loopback listener during teardown.
 * Keep that one-way process-lifetime fence separate from the reversible desired-state epoch.
 */
let bridgeShutdownRequested = false;
/**
 * True while a bound socket is still reconstructing durable command state.
 *
 * Binding is not publication. Chrome can discover the localhost port the instant listen()
 * succeeds, while restoreCommands() may still be awaiting a broker fsync. No request may read
 * or mutate that half-built command state: doing so can persist a snapshot that silently prunes
 * the other half of an expired revival before its broker transition is durable.
 */
let bridgeRecovering = false;
let dropSpawnRequestListener: (() => void) | null = null;
let dropReviveRequestListener: (() => void) | null = null;

function runStaleSwarmSweep(): Promise<boolean> {
  if (staleSweepInFlight) return staleSweepInFlight;
  staleSweepInFlight = sweepStaleSwarm().finally(() => {
    staleSweepInFlight = null;
  });
  return staleSweepInFlight;
}

function enqueueBridgeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const run = bridgeLifecycleQueue.then(operation, operation);
  bridgeLifecycleQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function startBridge(): Promise<number | null> {
  if (bridgeShutdownRequested) return Promise.resolve(null);
  if (bridgeDesiredRunning) {
    if (bridgeStartRequest) return bridgeStartRequest;
    if (server) return Promise.resolve(port);
  }

  bridgeDesiredRunning = true;
  const epoch = ++bridgeLifecycleEpoch;
  const request = enqueueBridgeLifecycle(async () => {
    if (!bridgeDesiredRunning || epoch !== bridgeLifecycleEpoch) return null;
    if (server) return port;
    return startBridgeOnce(epoch);
  });
  bridgeStartRequest = request;
  const clearStartRequest = (): void => {
    if (bridgeStartRequest === request) bridgeStartRequest = null;
  };
  void request.then(clearStartRequest, clearStartRequest);
  return request;
}

async function closeCancelledBridgeStart(instance: http.Server, actual: number | null = null): Promise<null> {
  if (server === instance) server = null;
  if (actual !== null && port === actual) port = null;
  bridgeRecovering = false;
  if (instance.listening) {
    await new Promise<void>((resolve) => instance.close(() => resolve()));
  }
  return null;
}

async function startBridgeOnce(epoch: number): Promise<number | null> {
  bridgeRecovering = true;
  const instance = http.createServer((req, res) => {
    if (bridgeRecovering) {
      json(res, 503, { error: 'bridge_recovering', retryable: true }, originOf(req).origin);
      return;
    }
    handle(req, res).catch((err: Error) => {
      logWarn(`bridge request failed: ${err.message}`);
      if (!res.headersSent) json(res, 500, { error: 'internal' }, originOf(req).origin);
    });
  });
  instance.headersTimeout = 15_000;
  instance.requestTimeout = 30_000;

  for (const candidate of PORTS) {
    const bound = await new Promise<boolean>((resolve) => {
      const onError = (): void => resolve(false);
      instance.once('error', onError);
      instance.listen(candidate, '127.0.0.1', () => {
        instance.removeListener('error', onError);
        resolve(true);
      });
    });
    if (bound) {
      // Port 0 means the OS picked one; the socket knows which.
      const address = instance.address();
      const actual = typeof address === 'object' && address ? address.port : candidate;
      if (epoch !== bridgeLifecycleEpoch) return closeCancelledBridgeStart(instance, actual);
      server = instance;
      port = actual;
      instance.on('error', (err) => logWarn(`bridge server error: ${err.message}`));
      // Commands from the previous run come back first, so a bootstrap that has already
      // failed three times keeps its history. Registering the spawn handler then replays
      // any worker chat the broker is still owed — a run restored from disk at startup
      // has nobody to ask until this moment — and queue() folds a replayed worker into
      // the restored command for the same worker rather than opening a second tab.
      try {
        await restoreCommands();
      } catch (err) {
        // Recovery is part of opening the bridge, not best-effort work after it. In particular,
        // an expired revival cannot be pruned until its broker half is durably stopped. Leaving
        // the loopback server published after that barrier failed creates a half-started bridge:
        // later startBridge() calls see `server` and never retry recovery, while unrelated queue
        // writes can erase the only durable revival row. Close this socket and make the next
        // start perform recovery from the same durable files again.
        if (server === instance) server = null;
        if (port === actual) port = null;
        bridgeRecovering = false;
        await new Promise<void>((resolve) => instance.close(() => resolve()));
        logWarn(`bridge startup recovery failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
      // A stop can arrive while durable command recovery awaits disk/broker state. Recovery may
      // finish for consistency, but it must not cross the publication boundary afterwards: no
      // replay listeners, no timers, and especially no browser delivery belong to a stopped app.
      if (epoch !== bridgeLifecycleEpoch) return closeCancelledBridgeStart(instance, actual);
      // A settings-driven stop/start is not a process restart: the in-memory commands survive,
      // so restoreCommands() quite correctly skips their durable duplicates. stopBridge(),
      // however, cleared their memory-only deadline timers. Re-arm those retained leases from
      // their durable claimedAt before delivery is allowed to inspect the queue; otherwise an
      // expired lease looks queued again and can open the same bootstrap a second time, while
      // a still-live lease can sit forever with no timer to end it.
      rearmRetainedCommandDeadlines();
      dropSpawnRequestListener?.();
      dropSpawnRequestListener = onSpawnRequest((workers) => {
        for (const worker of workers) queueWorkerBootstrap(worker.id, worker.task);
      });
      // The same replay contract for waking a worker that already has a chat. A run restored
      // from disk can hold a worker left in `waking` by a crash mid-revival; registering here
      // is the first moment anything can reopen that tab for it.
      dropReviveRequestListener?.();
      dropReviveRequestListener = onReviveRequest((revivals: WorkerRevival[]) => {
        for (const revival of revivals) queueWorkerRevival(revival.id, revival.conversationId, revival.messageIds);
      });
      // When a run ends — cleared in the app, finished, or taken over by another chat —
      // its worker chats must stop existing everywhere at once. A queued bootstrap that
      // outlives its run is a tab that opens later, introduces itself as a worker of
      // something that is gone, and cannot join.
      //
      // `onSwarmEnd` keeps a set of listeners, so the disposer is held and released on
      // stop. Without that, a settings save that stops and starts the bridge left the
      // previous listener registered and the next run end cancelled commands and typed
      // stop notices once per restart the app had ever done.
      dropSwarmEndListener?.();
      dropSwarmEndListener = onSwarmEnd((reason) => {
        // Cancelling the queue stops the worker chats that have not opened yet. The ones
        // already open are not typed into: driving somebody's conversation to tell it to
        // stop is a second control channel, and the app has no business writing into a chat
        // it did not open for this. A worker whose run is gone finds that out the moment it
        // calls the connector, which is the only place it can act from anyway.
        cancelWorkerCommands(reason);
      });
      if (staleSwarmTimer) clearInterval(staleSwarmTimer);
      staleSwarmTimer = setInterval(() => {
        void runStaleSwarmSweep().catch((err: Error) => logWarn(`stale swarm sweep failed: ${err.message}`));
      }, STALE_SWARM_SWEEP_MS);
      staleSwarmTimer.unref?.();
      // The recorder decides when a call is Unattributed; this owns what that is worth.
      setCallAttributionListener(noteCallAttribution);
      // Arms the goal watchdog from here rather than from module load, so its install fence is
      // the moment this process started serving — the earliest instant an obligation can have
      // been accepted by *this* run.
      goalWatchFloor = Date.now();
      compactionWatchFloor = goalWatchFloor;
      bridgeRecovering = false;
      // Anything restored from the previous run goes out now rather than waiting for a
      // browser to come and ask.
      deliver();
      logInfo(`bridge listening on 127.0.0.1:${actual}`);
      changed();
      return actual;
    }
  }
  bridgeRecovering = false;
  logWarn(`bridge could not bind any of ports ${PORTS.join(', ')}; the browser extension will not connect`);
  return null;
}

export async function stopBridge(): Promise<void> {
  if (!bridgeDesiredRunning && bridgeStopRequest) return bridgeStopRequest;
  if (!bridgeDesiredRunning && !server && !bridgeStartRequest) return;

  // Invalidate first, before waiting in the lifecycle queue. The currently executing start sees
  // this epoch change at its next await boundary and closes itself before replay/delivery.
  bridgeDesiredRunning = false;
  const epoch = ++bridgeLifecycleEpoch;
  const request = enqueueBridgeLifecycle(async () => {
    // A newer start is the latest user/runtime intent. Do not let this older queued stop close the
    // server that request is keeping (or is about to bring) up.
    if (bridgeDesiredRunning || epoch !== bridgeLifecycleEpoch) return;
    const instance = server;
    if (!instance) return;
    if (browserPresenceTimer) clearTimeout(browserPresenceTimer);
    browserPresenceTimer = null;
    server = null;
    port = null;
    // A stopped listener cannot currently see the extension. Require one fresh authenticated
    // request after the next start rather than carrying a recent sighting across bridge lifetimes.
    lastSeenAt = null;
    for (const command of commands) {
      if (command.timer) clearTimeout(command.timer);
      command.timer = null;
    }
    dropSwarmEndListener?.();
    dropSwarmEndListener = null;
    dropSpawnRequestListener?.();
    dropSpawnRequestListener = null;
    dropReviveRequestListener?.();
    dropReviveRequestListener = null;
    if (staleSwarmTimer) clearInterval(staleSwarmTimer);
    staleSwarmTimer = null;
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = null;
    setCallAttributionListener(null);
    clearUnattributedIncident();
    await new Promise<void>((resolve) => {
      // Stop admission and drain accepted extension writes. Abruptly destroying sockets here
      // could lose an /events or /closed item after Chrome had already handed it to the app.
      // Keep shutdown bounded because a wedged localhost client must not pin Electron forever.
      let settled = false;
      const force = setTimeout(() => {
        if (settled) return;
        // Force first, report second: what breaks the deadlock must not sit behind a call that
        // can throw. See the same ordering, and the same reason, in mcp/server.ts.
        instance.closeAllConnections();
        logWarn('bridge drain timed out after 15s; forcing remaining connections closed');
      }, 15_000);
      force.unref?.();
      // One sweep is not enough. Chrome holds its keep-alive socket open between polls, so a
      // connection that is merely *between* requests when stop is called is idle a millisecond
      // later and would otherwise sit here until the 15s force. Sweeping repeatedly retires each
      // socket the moment its in-flight request finishes, which is the drain that was intended.
      const sweep = setInterval(() => instance.closeIdleConnections?.(), 100);
      sweep.unref?.();
      instance.closeIdleConnections?.();
      instance.close(() => {
        settled = true;
        clearInterval(sweep);
        clearTimeout(force);
        resolve();
      });
    });
    logInfo('bridge stopped');
    changed();
  });
  bridgeStopRequest = request;
  try {
    await request;
  } finally {
    if (bridgeStopRequest === request) bridgeStopRequest = null;
  }
}

/** Final app teardown: stop the bridge and permanently reject later starts in this process. */
export function shutdownBridge(): Promise<void> {
  bridgeShutdownRequested = true;
  return stopBridge();
}

// ------------------------------------------------------------------ commands

function specKey(spec: CommandSpec): string {
  if (spec.type === 'worker') return `worker:${spec.agent}`;
  if (spec.type === 'revive') return `revive:${spec.agent}`;
  return `resume:${spec.sessionId}`;
}

/**
 * Identity used to fold duplicate browser work.
 *
 * The display/log key above is intentionally friendly, but worker names are reused between
 * runs. Dedupe must therefore include the run incarnation or a stale `worker-1` command from
 * run A can be adopted by run B after a crash/restart and keep A's command id alive.
 */
function commandKey(spec: CommandSpec): string {
  return spec.type === 'resume' ? specKey(spec) : `${specKey(spec)}:${spec.runId}`;
}

const commandPhase = (command: Command): CommandPhase => (command.claimedAt === null ? 'queued' : 'leased');

function durableCommand(command: Command): DurableCommandRecord {
  return {
    id: command.id,
    spec: command.spec,
    createdAt: command.createdAt,
    phase: commandPhase(command),
    claimedAt: command.claimedAt,
    owner: command.owner,
    lastError: command.lastError
  };
}

function pruneReceipts(now = Date.now()): void {
  commandReceipts = commandReceipts
    .filter((receipt) => now - receipt.completedAt <= COMMAND_TTL_MS)
    .slice(-MAX_COMMAND_RECEIPTS);
}

function commandSnapshot(options: {
  commandOverride?: { command: Command; record: DurableCommandRecord };
  removeCommandId?: string;
  addReceipt?: CommandReceipt;
} = {}): DurableCommandSnapshot {
  const { commandOverride, removeCommandId, addReceipt } = options;
  const snapshotCommands = [
    ...commands,
    ...[...commandRetirementsAwaitingBroker.values()].filter(
      (held) => !commands.some((command) => command.id === held.id)
    )
  ];
  const records = snapshotCommands
    .filter((command) => command.id !== removeCommandId)
    .map((command) =>
      commandOverride?.command === command ? commandOverride.record : durableCommand(command)
    );
  let receipts = commandReceipts.filter((receipt) => Date.now() - receipt.completedAt <= COMMAND_TTL_MS);
  if (addReceipt) {
    receipts = [...receipts.filter((receipt) => receipt.id !== addReceipt.id), addReceipt];
  }
  receipts = receipts.slice(-MAX_COMMAND_RECEIPTS);
  return { version: 4, commands: records, receipts };
}

function persistCommands(): void {
  writeDurableSoon(COMMANDS_STATE, commandSnapshot());
}

async function persistCommandLease(
  command: Command,
  owner: string | null,
  claimedAt: number,
  allowOwnerTakeover = false
): Promise<boolean> {
  const earlier = commandLeaseWrites.get(command.id);
  if (earlier) {
    await earlier;
    if (!commands.includes(command)) return false;
    if (owner !== null && command.owner !== null && command.owner !== owner && !allowOwnerTakeover) return false;
    // The app-open lease may be finishing just as the marked page redeems it. The page's
    // owner-bearing renewal is a second durable transition, not a conflict with that write.
    return persistCommandLease(command, owner, claimedAt, allowOwnerTakeover);
  }
  if (!commands.includes(command)) return false;
  if (owner !== null && command.owner !== null && command.owner !== owner && !allowOwnerTakeover) return false;
  const work = (async (): Promise<boolean> => {
    const record: DurableCommandRecord = {
      ...durableCommand(command),
      phase: 'leased',
      claimedAt,
      owner
    };
    try {
      await writeDurableNow(COMMANDS_STATE, commandSnapshot({ commandOverride: { command, record } }));
    } catch (err) {
      // The staged lease did not become authoritative. Supersede durable.ts's retained failed
      // generation with the still-authoritative queued/current snapshot so a background retry
      // can never open a lease the bridge itself rejected.
      persistCommands();
      logWarn(`bridge: could not persist the lease for ${specKey(command.spec)} — ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    if (!commands.includes(command)) return false;
    command.claimedAt = claimedAt;
    command.owner = owner;
    return true;
  })();
  commandLeaseWrites.set(command.id, work);
  try {
    return await work;
  } finally {
    if (commandLeaseWrites.get(command.id) === work) commandLeaseWrites.delete(command.id);
  }
}

type RevivalRedeemResult = 'ok' | 'stale' | 'taken' | 'broker-not-durable' | 'lease-not-durable';

/**
 * Makes `/commands/redeem` the wake arbitration cut, including process crashes.
 *
 * There are two durable files in this transaction and therefore only one safe write order.
 * The broker's `waking + revivable=false` claim goes first: after it is on disk, an MCP call
 * from the old server-side turn can no longer steal the wake. Only then is this browser
 * document written as the durable command owner, and only after both writes does the route
 * return the prime's text. A crash between the writes therefore leaves a claimed broker wake
 * but no browser that has received the payload; a retry may finish leasing it safely. A crash
 * after the owner write restores both halves and only that owner can receive the payload.
 *
 * The per-command gate closes the live two-redeemer version of the same split. Without it, two
 * requests could both observe the idempotent broker claim while the first durability write was
 * in flight and race for the later command lease.
 */
async function persistRevivalRedeem(
  command: Command,
  client: string,
  claimedAt: number
): Promise<RevivalRedeemResult> {
  const earlier = commandRedeems.get(command.id);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Publish our own gate *before* waiting. A third redeemer must queue behind this request,
  // rather than observing the same predecessor and resuming beside us when it completes.
  commandRedeems.set(command.id, gate);
  try {
    if (earlier) await earlier;
    if (!commands.includes(command)) return 'stale';
    if (command.owner && command.owner !== client) return 'taken';
    if (command.spec.type !== 'revive') return 'stale';

    // Re-check after waiting for a prior redeemer. An MCP call is allowed to win only before
    // the browser-owned broker claim is installed.
    const revival = revivalFor(command.spec.agent);
    if (!revival || revival.conversationId !== command.spec.conversationId) return 'stale';
    if (!claimWorkerRevival(command.spec.agent, command.spec.conversationId)) return 'stale';

    let brokerDurable = false;
    try {
      brokerDurable = await persistCriticalSwarmNow();
    } catch (err) {
      logWarn(
        `bridge: could not persist the broker claim for ${specKey(command.spec)} — ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!brokerDurable) {
      // No browser payload has escaped. Restore the pre-claim arbitration state and supersede
      // any failed durable generation with that safe snapshot. If storage itself remains down,
      // the command is still not handed out; a later retry/restart can recover from either safe
      // durable side without duplicate injection.
      if (rollbackWorkerRevivalClaim(command.spec.agent, command.spec.conversationId)) {
        try {
          await persistCriticalSwarmNow();
        } catch (err) {
          logWarn(
            `bridge: could not persist rollback of ${specKey(command.spec)} claim — ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      return 'broker-not-durable';
    }

    if (!(await persistCommandLease(command, client, claimedAt))) {
      // Do NOT roll the broker claim back here. It is already the authoritative durable cut.
      // Keeping the worker browser-owned prevents an MCP call from taking the queued text while
      // the same page retries the owner write. If a different page already owns the lease, that
      // owner remains the only one allowed to finish the wake.
      if (command.owner && command.owner !== client) return 'taken';
      return 'lease-not-durable';
    }
    return 'ok';
  } finally {
    release();
    if (commandRedeems.get(command.id) === gate) commandRedeems.delete(command.id);
  }
}

function receiptFor(id: string): CommandReceipt | null {
  pruneReceipts();
  return commandReceipts.find((receipt) => receipt.id === id) ?? null;
}

function receiptReply(receipt: CommandReceipt): Record<string, unknown> {
  return {
    ok: true,
    final: true,
    committed: receipt.committed,
    outcome: receipt.outcome,
    conversationId: receipt.conversationId,
    error: receipt.error
  };
}

async function finalizeCommand(command: Command, receipt: CommandReceipt): Promise<boolean> {
  if (!commands.includes(command)) return receiptFor(receipt.id) !== null;
  try {
    // The receipt and command retirement are one durable state transition. Publishing either
    // side in memory first recreates the lost-response ambiguity this tombstone exists to end.
    await writeDurableNow(COMMANDS_STATE, commandSnapshot({ removeCommandId: command.id, addReceipt: receipt }));
  } catch (err) {
    logWarn(`bridge: could not persist the final receipt for ${specKey(command.spec)} — ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (command.timer) clearTimeout(command.timer);
  command.timer = null;
  commands = commands.filter((entry) => entry !== command);
  commandReceipts = [...commandReceipts.filter((entry) => entry.id !== receipt.id), receipt].slice(-MAX_COMMAND_RECEIPTS);
  changed();
  return true;
}

function queue(spec: CommandSpec): Command {
  const key = commandKey(spec);
  const existing = commands.find((command) => commandKey(command.spec) === key);
  if (existing) {
    // The same bootstrap arriving twice — a restart re-requesting a worker whose chat was
    // never bound, or the user pressing Compact & Resume again — is one job, not two tabs.
    const superseded = JSON.stringify(existing.spec) !== JSON.stringify(spec);
    if (superseded) {
      // Only a genuinely different bootstrap restarts the clock and takes the lease back.
      // An identical repeat must leave the claim alone: releasing it would let the
      // deliver() that follows open a second tab for a chat that is already opening,
      // which is precisely the storm of duplicate chats this queue exists to prevent.
      existing.createdAt = Date.now();
      existing.claimedAt = null;
      // Any page that redeemed the previous payload no longer owns the replacement. Current
      // pages echo their document client on ACK, so a late result from that old payload is
      // refused by /commands/ack rather than applied to this newer one.
      existing.owner = null;
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = null;
      // A newer handoff for the same chat replaces the older one in place. The queued job
      // stays one job — what changes is which handoff the fresh chat will be told to resume
      // — and its deadline starts again from this delivery, because this is new work.
      existing.spec = spec;
      existing.lastError = null;
    }
    changed();
    persistCommands();
    return existing;
  }
  const command: Command = {
    id: randomBytes(8).toString('hex'),
    spec,
    createdAt: Date.now(),
    claimedAt: null,
    retriedAt: null,
    timer: null,
    lastError: null,
    owner: null
  };
  commands.push(command);
  if (commands.length > MAX_COMMANDS) {
    // Through drop(), never a raw shift.
    //
    // A queued command is not just a row in an array: a worker command owns an `invited`
    // agent slot that only ever ends when something ends it, and a resume command owns a
    // job the page is sitting there waiting on. Shifting one out left both behind — the
    // worker counted towards the limit and held the single in-flight agent bootstrap so
    // nothing after it could open, and the resume job stayed `busy` with no command left
    // to finish it, which disables Compact & resume until the app restarts. Overflow is
    // rare, which is exactly why it must not be the one path that skips the cleanup.
    const oldest = commands[0];
    if (oldest) drop(oldest, 'the command queue was full and this was the oldest entry in it');
  }
  changed();
  persistCommands();
  return command;
}

// --------------------------------------------------------------- resume jobs

/**
 * One press of Compact & Resume, followed from the press to the fresh chat.
 *
 * The button used to be fire-and-forget, and the browser half guessed when it was done
 * by waiting a second and a half. A real compaction runs for minutes, so the user got an
 * enabled button back long before anything happened, pressed it again, and every press
 * became its own handoff and its own fresh tab — tabs that then arrived minutes later,
 * several at once. The job is the thing the page waits on instead of guessing: one per
 * session, from the press until the fresh chat has actually been opened, failed or been
 * cancelled.
 */
export type ResumeStage =
  /** ChatGPT was asked for the brief and has not finished writing it yet. */
  | 'handoff-pending'
  | 'opening'
  | 'waiting-for-browser'
  | 'done'
  | 'failed';

/**
 * What the page is told about a Compact & Resume in flight.
 *
 * Derived, never stored. The continuation transaction is the state — it knows whether a
 * brief exists, whether a replacement chat has claimed it and whether the move landed — and
 * this reads it, adding only the one thing the transaction cannot know: whether the browser
 * has actually been given the command yet. A job record of its own was a second copy of that
 * state, and the two could disagree about whether a session had moved.
 */
export interface ResumeJobView {
  sessionId: string;
  token: string;
  stage: ResumeStage;
  startedAt: number;
  /** True only for a threshold-triggered ticket; Auto Off may cancel only these. */
  automatic: boolean;
  /** True while the button must stay disabled. */
  busy: boolean;
  handoffId: string | null;
  sourceSend: {
    state: ContinuationSendState;
    messageId: string | null;
  };
  destinationSend: {
    state: ContinuationSendState;
    conversationId: string | null;
    messageId: string | null;
  };
  error: string | null;
}

const RUNNING_STAGES = new Set<ResumeStage>(['handoff-pending', 'opening', 'waiting-for-browser']);

/**
 * The token of the last continuation opened for a session.
 *
 * The transaction itself is the state; this is only how the bridge finds it again, and it is
 * how a *finished* one can still be reported once — `continuationForSession` answers about
 * open transactions only, which is right for everything that acts on one, but a page polling
 * every two seconds still has to be told "that finished" rather than "there is nothing".
 */
const sessionTokens = new Map<string, string>();

function rememberToken(sessionId: string, token: string): void {
  sessionTokens.set(sessionId, token);
  if (sessionTokens.size > 50) {
    const oldest = sessionTokens.keys().next();
    if (!oldest.done) sessionTokens.delete(oldest.value);
  }
}

/** The job for a session, if there is one worth telling the page about. */
export function resumeJobFor(sessionId: string): ResumeJobView | null {
  const token = sessionTokens.get(sessionId);
  const entry = (token ? continuationByToken(token) : null) ?? continuationForSession(sessionId);
  if (!entry) return null;
  const command = commands.find((cmd) => cmd.spec.type === 'resume' && cmd.spec.sessionId === sessionId);
  const stage: ResumeStage =
    entry.state === 'committed'
      ? 'done'
      : entry.state === 'aborted'
        ? 'failed'
        : entry.state === 'awaiting-summary'
          ? 'handoff-pending'
          : command && !isLeased(command) && !openInBrowser
            ? 'waiting-for-browser'
            : 'opening';
  return {
    sessionId,
    token: entry.token,
    stage,
    startedAt: entry.openedAt,
    automatic: entry.automatic,
    busy: RUNNING_STAGES.has(stage),
    handoffId: entry.handoffId,
    sourceSend: entry.sourceSend,
    destinationSend: entry.destinationSend,
    error: entry.error
  };
}

/**
 * The context-window settings the composer needs, as one object.
 *
 * Both numbers the meter can fill against, plus whether anything acts on them. `warn` and
 * `limit` are the lines the app already draws in its own session view; `threshold` is the
 * one the user set for automatic compaction, and it only means anything while `auto` is
 * on. The page decides which to show, but it is not allowed to invent any of them.
 */
function contextView(autoAllowed = true): {
  auto: boolean;
  threshold: number;
  warn: number;
  limit: number;
} {
  const config = getConfig();
  return {
    auto: autoAllowed && config.compaction.auto,
    threshold: config.compaction.autoTokens,
    warn: config.sessions.advisoryTokens,
    limit: config.sessions.limitTokens
  };
}

/**
 * Stops waiting on a session's resume and withdraws the replacement chat.
 *
 * The deliberate escape hatch: a compaction that will never finish, or a resume the user
 * changed their mind about, must not leave a tab to be opened later "when ChatGPT is next in
 * front of me" — which is exactly how the user ended up closing five chats. Aborting the
 * transaction is what makes a brief still being written land nowhere, and the session stays
 * attached to the chat it is in.
 */
export function cancelResume(sessionId: string): boolean {
  const token = sessionTokens.get(sessionId);
  const entry = token ? continuationByToken(token) : continuationForSession(sessionId);
  const aborted = entry ? abortContinuation(entry.token, 'cancelled') : false;
  const queued = commands.find((command) => command.spec.type === 'resume' && command.spec.sessionId === sessionId);
  const afterAbort = entry ? continuationByToken(entry.token) : null;
  if (!aborted && (afterAbort?.state === 'committing' || afterAbort?.state === 'committed')) {
    // The durable transaction crossed its abort boundary. Removing its transport here would
    // make the UI say "cancelled" while A→B is still landing (or already landed), and would
    // destroy the only command id a lost ACK can use to recover its final receipt.
    return false;
  }
  if (queued) {
    commands = commands.filter((command) => command !== queued);
    if (queued.timer) clearTimeout(queued.timer);
    queued.timer = null;
    persistCommands();
    logInfo(`bridge: cancelled the queued fresh chat for ${sessionId}`);
  }
  if (!aborted && !queued) return false;
  changed();
  return true;
}

/**
 * Durable cancellation used by the HTTP/UI path. The continuation abort is persisted first;
 * only then is its browser transport retired. That ordering makes a crash between the two
 * safe: restoreCommands refuses a resume whose authoritative continuation is already aborted.
 */
export async function cancelResumeNow(sessionId: string): Promise<boolean> {
  const token = sessionTokens.get(sessionId);
  const entry = token ? continuationByToken(token) : continuationForSession(sessionId);
  const queued = commands.find((command) => command.spec.type === 'resume' && command.spec.sessionId === sessionId) ?? null;

  if (entry?.state === 'committing' || entry?.state === 'committed') return false;
  let aborted = false;
  if (entry && entry.state !== 'aborted') {
    aborted = await abortContinuationNow(entry.token, 'cancelled');
    const afterAbort = continuationByToken(entry.token);
    if (!aborted && (afterAbort?.state === 'committing' || afterAbort?.state === 'committed')) return false;
  }
  if (!entry && !queued) return false;

  if (queued) {
    if (queued.timer) clearTimeout(queued.timer);
    queued.timer = null;
    try {
      await writeDurableNow(COMMANDS_STATE, commandSnapshot({ removeCommandId: queued.id }));
    } catch (err) {
      // The semantic abort already landed. Keeping the failed removal generation queued for
      // durable.ts retry is safe, and the in-memory transport must still disappear immediately.
      logWarn(`bridge: resume ${sessionId} was aborted but its command retirement will retry — ${err instanceof Error ? err.message : String(err)}`);
    }
    commands = commands.filter((command) => command !== queued);
    logInfo(`bridge: cancelled the queued fresh chat for ${sessionId}`);
  }
  if (!aborted && entry?.state !== 'aborted' && !queued) return false;
  changed();
  return true;
}

/** Auto Off owns only threshold-created tickets; manual Compact & Resume remains explicit. */
async function cancelAutomaticResumesNow(): Promise<number> {
  let cancelled = 0;
  for (const entry of pendingAutomaticContinuations()) {
    if (await cancelResumeNow(entry.sessionId)) cancelled += 1;
    compactionWatch.delete(entry.from);
    if (repairsInFlight.get(entry.from)?.reason === 'compaction') repairsInFlight.delete(entry.from);
  }
  return cancelled;
}

/**
 * Queues the bootstrap for a worker chat.
 *
 * Called by the broker through onSpawnRequest. Nothing about identity is passed in or
 * stored: the chat this opens is bound to the slot by the extension's report, and the
 * recovery key exists only if the user asks the app for one after that has failed.
 */
export function queueWorkerBootstrap(agent: string, task: string): BridgeCommand | null {
  const runId = currentRunId();
  // A worker bootstrap is authority for one concrete broker incarnation. There is no safe
  // meaning for one outside a run, and manufacturing an unscoped command here is exactly how
  // stale durable work later becomes somebody else's `worker-1`.
  if (!runId) return null;
  const command = queue({ type: 'worker', agent, task, runId });
  // Start the clock at broker admission, exactly as a revival does. A bootstrap that never
  // reaches a page is the case that has no other clock at all.
  armDeadline(command);
  deliver();
  return describe(command, null);
}

/**
 * Queues the reopening of a sleeping worker's own chat.
 *
 * Called by the broker through onReviveRequest, and carrying nothing the broker did not
 * already prove: the slot is reserved (`waking`) and the conversation is the one bound to it.
 * The prime's words are deliberately not copied in here — they are read out of that worker's
 * inbox when the page asks for them, so a revival that waits in the queue hands over what is
 * true at hand-out time rather than a stale snapshot.
 */
export function queueWorkerRevival(
  agent: string,
  conversationId: string,
  wake: readonly string[]
): BridgeCommand | null {
  const runId = currentRunId();
  // Same rule as a bootstrap: authority for one concrete broker incarnation, or nothing.
  if (!runId || !conversationId) return null;
  // An empty wake is not a wake. The broker republishes its whole `waking` list on every
  // restart and on any staging that touches it, and a worker whose words the browser has
  // already typed plans nothing further — its own call is what ends the wake, not another
  // send. Superseding the command it is already living under would restart the one absolute
  // deadline it has and open its tab a second time to type nothing.
  const carried = commands.find((entry) => entry.spec.type === 'revive' && entry.spec.agent === agent);
  if (wake.length === 0 && carried) return describe(carried, null);
  const command = queue({
    type: 'revive',
    agent,
    conversationId,
    runId,
    wake: wake.join(' ')
  });
  // Start the waking clock at broker admission, not only after a browser accepts the command.
  armDeadline(command);
  return describe(command, null);
}

/**
 * Queues the replacement chat for a continuation whose brief has been captured.
 *
 * Keyed by session, and carrying the transaction's token rather than any text: the token is
 * the single-use authority for this move, so the command cannot become a second way of
 * claiming a continuation, and a second command for the same session folds into this one.
 */
export function queueResume(sessionId: string, token: string): BridgeCommand | null {
  const command = queueResumeCommand(sessionId, token);
  void deliver();
  return describe(command, null);
}

function queueResumeCommand(sessionId: string, token: string): Command {
  rememberToken(sessionId, token);
  const command = queue({ type: 'resume', sessionId, token });
  changed();
  return command;
}

// ----------------------------------------------------------------- delivery

/**
 * Opens a URL in the user's browser. Wired to Electron's shell at startup.
 *
 * Injected rather than imported so this module stays testable without Electron, and so
 * a build with no window (or a test) simply falls back to the polling path instead of
 * having a browser-launching side effect nobody asked for.
 */
let openInBrowser: ((url: string) => Promise<void>) | null = null;

/**
 * How long one cold browser start is given to show up before another may be attempted.
 *
 * Opening a URL is cheap when a browser is already running: the launcher hands it to the
 * running instance and exits. Opening one when nothing is running is not — it is a full cold
 * start, and a second launch fired into that window does not join the instance that is still
 * booting, it becomes an instance of its own. This app can queue several browser-backed
 * commands and delivers the next one the moment the previous is dropped or expires, so a
 * browser that never came back was answered with one cold start per command, and a user who
 * closed the browser was answered with another. That is how eight Chrome process trees, each
 * holding its own pinned ChatGPT tabs, end up on one machine.
 *
 * Sixty seconds is `BROWSER_PRESENT_MS`, and deliberately the same number: presence is what
 * ends this wait early, so the wait is over exactly when this app would have stopped believing
 * in the launch anyway. A launch that worked costs nothing — the extension's first poll lands
 * within seconds of the page loading and the next command goes out immediately.
 */
const BROWSER_LAUNCH_GRACE_MS = BROWSER_PRESENT_MS;

/** When this app last cold-started a browser. Zero until it has, and reset with the bridge. */
let lastBrowserLaunchAt = 0;
/** The one deferred delivery owed to a launch still inside its grace window. */
let browserLaunchTimer: NodeJS.Timeout | null = null;

/**
 * Whether a browser this app started is still inside the window in which it might appear.
 *
 * Presence answers it first and answers it best: a browser that is talking to this process is
 * not a launch anybody is waiting on, whether or not it is the one that was started.
 */
function browserLaunchPending(now = Date.now()): boolean {
  return !browserPresent() && now < lastBrowserLaunchAt + BROWSER_LAUNCH_GRACE_MS;
}

/** Re-runs delivery once the pending launch's window closes, so nothing waits on a lost one. */
function deliverAfterLaunchWindow(now = Date.now()): void {
  if (browserLaunchTimer) return;
  browserLaunchTimer = setTimeout(() => {
    browserLaunchTimer = null;
    void deliver();
  }, Math.max(1, lastBrowserLaunchAt + BROWSER_LAUNCH_GRACE_MS - now + 1));
  browserLaunchTimer.unref?.();
}

export function setBrowserOpener(open: ((url: string) => Promise<void>) | null): void {
  openInBrowser = open;
}

/** The one place this app writes a ChatGPT conversation URL. */
export function chatUrl(conversationId: string): string {
  return `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`;
}

/** Where the app opens a fresh worker/resume chat. The marker is an id, not a credential. */
export function commandUrl(id: string): string {
  // Both a query and a fragment: ChatGPT is a single-page app that rewrites its own URL
  // during boot, and which of the two survives has changed between builds. The content
  // script accepts either, and redeeming still requires the extension's bearer token —
  // so a copied link, a history entry or a synced tab is worth nothing on its own.
  const marker = `clf=${encodeURIComponent(id)}`;
  return `https://chatgpt.com/?${marker}#${marker}`;
}

/**
 * Ends a continuation whose commit the session layer refused for good.
 *
 * The ACK route already does this; the marked-message route did not, and returned the 409
 * with the continuation left `claimed` and carrying the refusal as its error. Nothing retries
 * a claimed continuation on its own, an automatic one never expires, and chat A's control
 * reads "opening the new chat" off that record — so the 2026-09-01 refusal left A behind
 * that overlay indefinitely and B unbound, calling tools as nobody. A refusal is final: the
 * session stays in A and A is told so. Only a commit that is already durable is left alone.
 */
async function abortRejectedResume(token: string, reason: string): Promise<boolean> {
  const state = continuationByToken(token);
  if (!state || state.state === 'committing' || state.state === 'committed' || state.state === 'aborted') return false;
  try {
    return await abortContinuationNow(token, reason);
  } catch (err) {
    logWarn(`bridge: could not durably abort the refused resume ${state.sessionId} — ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** The one existing-chat command the extension may route after a fresh tab scan. */
function pendingBrowserRevival(): {
  id: string;
  conversationId: string;
} | null {
  tidyCommands();
  const command = commands.find(
    (entry) => entry.spec.type === 'revive' && entry.owner === null && !revivalDeliveryProven(entry)
  );
  return command && command.spec.type === 'revive'
    ? { id: command.id, conversationId: command.spec.conversationId }
    : null;
}

// ------------------------------------------------- where a fresh chat is opened

/**
 * The chat a queued fresh chat belongs beside.
 *
 * A resume's chat B is not a free-floating new tab. It is the second half of one A -> B
 * handoff, and A is a tab in one specific window of one specific browser. A worker's chat has
 * the same kind of home: the prime chat whose run is spawning it.
 *
 * The operating system knows none of that. `chrome.exe <url>` hands the URL to whichever
 * instance the platform resolves to, which is the one that last had focus - so on a machine
 * running two Chrome instances the successor of a chat that had just finished in the
 * background one was created in the foreground one instead. That is the whole failure the
 * user hit: the summary was typed into a chat in a browser the extension was not loaded in,
 * nothing ever redeemed the command, and the handoff died with no connection to it at all.
 *
 * So this app stops asking the OS where its own chats go whenever it can name the home.
 */
function commandHomeConversation(spec: CommandSpec): string | null {
  if (spec.type === 'resume') return continuationByToken(spec.token)?.from ?? null;
  // A revival names an existing chat and opens nothing, so it has no successor to place.
  if (spec.type === 'revive') return null;
  return agentConversation(PRIME_ID);
}

/**
 * How long a placed chat is given to redeem before the OS opener is asked after all.
 *
 * The offer is collected in the very response that produced the command, so this is not a
 * wait for a poll — it is the browser's whole round trip: create the tab, load ChatGPT, run
 * the content script, redeem. Twenty seconds is generous for that and still leaves most of
 * `COMMAND_DEADLINE_MS` for the fallback open to succeed in.
 */
export const BROWSER_PLACEMENT_MS = 20_000;

/**
 * The chat whose own request is in flight right now.
 *
 * Compact & Resume is produced by chat A's page asking for it, so at the instant the command
 * is queued there is a reply about to be written to the one browser that holds A. That, and
 * nothing weaker, is what licenses delivery to hold the OS opener back: a resume queued by
 * the auto-compaction pickup or restored after a restart has no page waiting to be told, and
 * must still be opened the way it always was rather than waiting for a poll that may be
 * thirty seconds away — or, if the tab is gone, never.
 */
let placementCollector: string | null = null;

/** The one fresh chat currently offered to its home page, and the fallback that outlives it. */
let placementOffer: { id: string; conversationId: string } | null = null;
let placementTimer: NodeJS.Timeout | null = null;

/** Drops the standing offer and its fallback. Called by every path that ends a command. */
function clearPlacementOffer(): void {
  placementOffer = null;
  if (placementTimer) clearTimeout(placementTimer);
  placementTimer = null;
}

/**
 * Offers a leased fresh chat to the page of the chat it succeeds.
 *
 * Returns false whenever this app cannot name a home chat that is asking for this command
 * right now, which is every path except a page-driven compaction. Those open through the OS
 * opener exactly as before, because there is genuinely nothing better to know about them.
 */
function offerPlacement(command: Command): boolean {
  const home = commandHomeConversation(command.spec);
  if (!home || home !== placementCollector) return false;
  clearPlacementOffer();
  placementOffer = { id: command.id, conversationId: home };
  placementTimer = setTimeout(() => {
    placementTimer = null;
    placementOffer = null;
    // Still queued and still nobody's: the home page did not open it, so ask the OS after all.
    const stale = commands.find((entry) => entry.id === command.id && entry.owner === null);
    if (stale) void openFreshChatInBrowser(stale);
  }, BROWSER_PLACEMENT_MS);
  placementTimer.unref?.();
  logInfo(`bridge: offering ${specKey(command.spec)} to ${home}'s own browser window`);
  return true;
}

/**
 * The one fresh chat this conversation's browser is being asked to open next to itself.
 *
 * Spent on handout. The page that collects it is the page that opens the tab, and a second
 * poll - from another tab of the same chat, or the same tab a moment later - must not create
 * a second one. If that page fails to act, the fallback above is what recovers it, not a
 * repeated offer.
 */
function pendingBrowserPlacement(conversationId: string): { id: string } | null {
  const offer = placementOffer;
  if (!offer || offer.conversationId !== conversationId) return null;
  if (!commands.some((entry) => entry.id === offer.id && entry.owner === null)) {
    placementOffer = null;
    return null;
  }
  placementOffer = null;
  return { id: offer.id };
}

// -------------------------------------------------------- exact browser recovery

/**
 * One silence deadline per chat with an open semantic turn.
 *
 * An entry exists for exactly as long as this app is owed an answer: it is armed by the turn
 * opening, pushed forward by every piece of evidence that the model is still working, and
 * removed by the real terminal. A deadline in the past means the open turn has been silent for
 * the whole window and has its one recovery coming.
 *
 * Two things it deliberately is not. It is not a page-liveness clock — a document can keep
 * reporting turns and progress while its request-id join is dead, which is precisely the state
 * this exists to catch. And it is not derived from browser lifetime: a reload, a navigation or a
 * tab close changes which page is watching the turn, never whether the turn is owed an answer,
 * so no lifecycle event arms, bumps or spends a deadline. That is also why nothing here
 * cross-checks the recorder's live open-turn map any more — the turn that armed this outlives
 * the page that reported it, and making the page's projection the eligibility fence is what
 * silently dropped the watch on every chat whose tab had gone.
 */
interface ActivityGrant {
  /** Durable session principal whose current frontend owned this activity when it was proven. */
  sessionId: string;
  until: number;
}

const activeUntil = new Map<string, ActivityGrant>();

/** Chats reloaded by the app whose page has given no sign of life since. */
const awaitingReturn = new Set<string>();

/** A semantic turn start arms the silence deadline; later evidence of work pushes it forward. */
function grantActivity(conversationId: string, sessionId: string, at = Date.now(), window = CHAT_SILENCE_MS): void {
  if (!sessionId) return;
  activeUntil.set(conversationId, { sessionId, until: at + window });
  awaitingReturn.delete(conversationId);
  armSilenceSweep();
  void considerAutomaticCompaction(conversationId, sessionId);
}

/** Chats whose automatic ticket is being filed right now, so one working turn files one. */
const compactionFilings = new Set<string>();

/**
 * When each chat's last local tool call was attributed to it, and the quiet a Goal draft needs.
 *
 * The page's word that a turn ended is not enough to write the next message on: a reloaded
 * page reads the transcript's last `end_turn` bit as a finished answer while the same request
 * is still calling tools, and "Message delivery timed out" closes the local turn the same way.
 * On 2026-09-03 the loop drafted twenty seconds after such an end, with the chat's last tool
 * call twenty-eight seconds old, and sent — and the chat then had two requests running in it.
 * So the app applies the facts only it has, and the draft waits on both. The recorder's own
 * turn: a turn it reopened stays open until the page reports a real end, and on 2026-09-03 the
 * page never did — its "Message delivery timed out" banner produced no turn end at all, yet the
 * page asked for the draft twenty seconds later and got it. And the chat's tools: one that ran
 * within the last minute is working, whatever the page or the record says. The obligation is
 * filed either way; a call that proves the turn is still running withdraws it (see
 * noteCallAttribution), and a turn that really has ended is drafted a minute later at most.
 *
 * The one ticket that is not gated on the open turn is silence's own (`g-silence-*`): it is
 * filed only after two minutes without a call, a reload, and a further minute in which
 * nothing arrived, which is exactly the route a chat whose page has lost its answer is meant to
 * take to the next message. Its turn may well still be open in the record — the page that
 * would have closed it is the page that broke.
 */
const lastAttributedCallAt = new Map<string, number>();
export const GOAL_QUIET_MS = 60_000;

function chatStillWorking(conversationId: string, turnId: string, now = Date.now()): boolean {
  if (runningToolCalls(conversationId) > 0) return true;
  if (!turnId.startsWith('g-silence-') && chatIsWorking(conversationId)) return true;
  const last = lastAttributedCallAt.get(conversationId);
  return last !== undefined && now >= last && now - last < GOAL_QUIET_MS;
}

/**
 * Files the automatic Compact & Resume ticket for a working chat that has crossed the line.
 *
 * The decision lives here, on the evidence that a chat is working — an attributed call, a
 * current-turn observation — because that evidence keeps arriving from a chat whose page has
 * stopped: a frozen or discarded tab makes no page decision, and until 2026-09-03 the page was
 * the only place this decision was made, so a chat that most needed compacting was the one that
 * could not ask for it. The page still does the work; it resumes the ticket on its next pull
 * (`maybeResumePendingCompaction`), and if no page does, the pickup schedule raises one.
 *
 * Still a level plus liveness, exactly as before: an idle chat over the line is never touched
 * (`chatIsWorking`), a worker or blocked chat never (`goalFencedChat`), and a session already
 * carrying a continuation is not given a second.
 */
async function considerAutomaticCompaction(conversationId: string, sessionId: string): Promise<void> {
  if (!getConfig().compaction.auto || compactionFilings.has(conversationId)) return;
  if (goalFencedChat(conversationId) || continuationForSession(sessionId) || !chatIsWorking(conversationId)) return;
  compactionFilings.add(conversationId);
  try {
    const summary = await getSession(sessionId).catch(() => null);
    if (!summary || summary.conversationId !== conversationId || !autoCompactionReady(summary)) return;
    if (await conversationWasSuperseded(conversationId)) return;
    // Re-read after the awaits: the turn may have ended, or a page may have filed by hand.
    if (!chatIsWorking(conversationId) || continuationForSession(sessionId) || goalFencedChat(conversationId)) return;
    const opened = await openContinuationNow(sessionId, conversationId, true);
    rememberToken(sessionId, opened.token);
    changed();
    logInfo(
      `bridge: ${conversationId} is working at ${summary.contextTokens} context tokens — filed auto-compaction ticket ${opened.token.slice(0, 8)}`
    );
  } catch (err) {
    logWarn(`bridge: could not file the auto-compaction ticket for ${conversationId} — ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    compactionFilings.delete(conversationId);
  }
}

/**
 * How long a Goal/Loop chat is listened to after its silence reload before the loop writes.
 *
 * Two minutes of nothing earned the reload; one more minute of nothing on the fresh page is
 * the verdict. Not less, because an answer the reload brought back sometimes flutters in a
 * few seconds late — an interim, a final, a first tool call — and a message typed under it
 * would be a message about the wrong turn.
 */
export const GOAL_SILENCE_LISTEN_MS = 60_000;

/**
 * Files the Goal ticket for a Goal/Loop chat whose silence reload brought nothing back.
 *
 * The prime stopped writing with no final answer, the reload showed the same dead turn, and a
 * minute of listening heard nothing: no tool call, no page change, no answer. The loop treats
 * that exactly as it treats a finished answer — the chat is owed the next user message — and
 * files the same crash-durable obligation a finished answer would have, under a turn of its
 * own. The page collects it on its next pull like any other pending reply (the same pickup a
 * reload restores), drafts, and sends; the reply that starts is attributed by its own request
 * id, so a prime whose page was lost for one turn carries on in the next. A stop the user
 * pressed never gets here: it ends the chat's activity, and a chat without activity is never
 * silent.
 */
async function fileSilenceGoalTickets(spent: readonly string[], now: number): Promise<void> {
  for (const conversationId of spent) {
    if (!goalActiveFor(conversationId) || goalWorkerChat(conversationId) || isChatBlocked(conversationId)) continue;
    // Only after a silence reload that was carried out and answered by nothing. A grant spent
    // for any other reason — not a chat the user wants brought back, say — earned no reload
    // and gets no ticket.
    const held = repairsInFlight.get(conversationId);
    if (held?.reason !== 'silence' || held.state !== 'done') continue;
    const session = await getSession(held.sessionId);
    if (!session || session.conversationId !== conversationId) continue;
    if (continuationForSession(session.id)) continue;
    const turnId = `g-silence-${now}`;
    try {
      await acceptGoalReplyNow({
        conversationId,
        sessionId: session.id,
        replyId: `silence:${now}`,
        turnId,
        eventSeq: session.events,
        blocked: false
      });
      logInfo(
        `bridge: ${conversationId} stayed silent after its reload — filing a Goal ticket so the loop writes the next message`
      );
    } catch (err) {
      logWarn(`bridge: could not file the Goal ticket for ${conversationId} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Puts a freshly resumed chat on the activity clock the moment the session moves onto it.
 *
 * Chat B has just been handed the brief and told to carry on, so from here it is expected to
 * work — yet nothing said so. The recorder learns of B's turn only from B's own page, and a
 * page whose reporting never gets going leaves B invisible to every recovery path: on
 * 2026-09-02 B's first two calls each waited out the identity window as nobody's, and the
 * unattributed incident had no suspect to reload because B had never reported a turn. The
 * grant a turn start would have made is what makes B a suspect the incident may reload and,
 * failing any sign of life at all, what hands it silence's one reload. B's first attributed
 * call or observed turn takes over the clock exactly as for any working chat.
 */
function armResumedChat(sessionId: string, conversationId: string): void {
  grantActivity(conversationId, sessionId);
  logInfo(`bridge: resumed chat ${conversationId} armed — expecting its first attributed call`);
}

/** A real terminal — stable final answer, explicit stop, worker finish — spends the deadline. */
function endActivity(conversationId: string): void {
  activeUntil.delete(conversationId);
  armSilenceSweep();
}

/** Drops a chat out of the activity ledger entirely, once nothing is waiting on it. */
function forgetActivity(conversationId: string): void {
  activeUntil.delete(conversationId);
  armSilenceSweep();
}

/**
 * Inspects the ledger *on* the earliest silence deadline instead of at the next 30-second tick.
 *
 * The two-minute window is a contract with the user, and the maintenance interval was quietly
 * spending a second window on top of it: a deadline that expired one second after a tick waited
 * the full thirty for the next one, and only then did the extension's own thirty-second alarm
 * start. A chat measured silent at 2:00 was reloaded at up to 3:00 — the observed 2:40 case.
 *
 * Only the app half is fixable here. Chrome's alarm floor is thirty seconds and there is no
 * channel that lets this process wake a stopped service worker, so the browser hop keeps its
 * bound; what this removes is the entire hop this side owns. Arming on the earliest deadline
 * rather than per chat keeps one timer no matter how many chats are open, and a deadline pushed
 * forward by later activity only costs one early wake-up that finds nothing expired.
 */
function armSilenceSweep(now = Date.now()): void {
  let earliest = Number.POSITIVE_INFINITY;
  for (const grant of activeUntil.values()) if (grant.until > now) earliest = Math.min(earliest, grant.until);
  if (!Number.isFinite(earliest)) {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = null;
    return;
  }
  // Always the earliest deadline across every watched chat, re-armed from scratch. Keeping an
  // already-scheduled wake-up when it happens to be early enough looks like the cheaper move and
  // is how this went wrong once already: the held handle is only as good as the clock it was
  // created on, and a stale one parks the whole ledger on a wake-up that is never coming. One
  // timer for all chats means re-arming can never delay a quiet chat behind a busy one.
  if (silenceTimer) clearTimeout(silenceTimer);
  silenceTimer = setTimeout(
    () => {
      silenceTimer = null;
      // Deliberately the ledger pass alone, not runStaleSwarmSweep(). The maintenance sweep is
      // async and de-duplicated against itself, so a tick that lands while an earlier one is still
      // reading durable state is dropped — and the punctual wake-up would be exactly the tick to
      // lose. Queueing a repair is synchronous and needs none of that; whatever the queue implies
      // for a worker's slot is the full sweep's business and is unchanged by arriving first.
      const pass = inspectSilentChats(Date.now());
      // A chat whose one repair was already carried out is the sweep's to retire, because letting
      // go of it can free a worker slot. Hand that half back rather than doing it from here.
      if (pass.spent.length > 0) {
        void runStaleSwarmSweep().catch((err: Error) => logWarn(`stale swarm sweep failed: ${err.message}`));
      }
      armSilenceSweep();
    },
    Math.max(1, earliest - now + 1)
  );
  silenceTimer.unref?.();
}

/**
 * How long a suspect is given to prove itself wrong, by how many suspects there are.
 *
 * Unattributed activity means a chat is running tools while the request-id join is broken —
 * usually because that page's content script or Fiber helper died under it. It never says which
 * chat, so nothing here guesses one, and the wait is the whole of how they are told apart: a
 * healthy chat keeps producing attributed calls and leaves the incident on its own.
 *
 * That makes the wait a discrimination budget, and the count is the only thing entitled to
 * scale it. One suspect needs no discrimination at all — there is nobody to tell it apart from
 * — so it pays the shortest rung. Three pay the longest, because the live probes in
 * docs/chatgpt-turn-signals.md show ChatGPT can sit for more than a minute on a genuinely live
 * request, and reloading a chat that was merely thinking destroys the answer it was writing.
 *
 * The shortest rung is not a discrimination figure and does not go to zero.
 * `withUnattributedNotice` tells the model that one attributed call calls the reload off, so the
 * floor has to be one model round trip wide or that is a promise the app does not keep.
 */
const UNATTRIBUTED_RUNGS = [15_000, 30_000, 60_000] as const;
/** Three suspects or more; the measured ceiling a genuinely live request can sit inside. */
const UNATTRIBUTED_CEILING_MS = UNATTRIBUTED_RUNGS[2];

function unattributedRung(suspects: number): number {
  return (
    UNATTRIBUTED_RUNGS[Math.min(Math.max(suspects, 1), UNATTRIBUTED_RUNGS.length) - 1] ??
    UNATTRIBUTED_CEILING_MS
  );
}

/**
 * Seconds until a reload, or null when nothing is going to reload anything.
 *
 * The caller is by definition a chat this app cannot name, so it cannot be told its own
 * deadline. The earliest pending one is the honest answer: it is the soonest any reload can
 * happen, and the advice hanging off it — retry now — is right under every rung. With no
 * incident open the answer is a whole rung, because the call asking this is the one about to
 * open it. With no browser in sight there is no answer at all — nothing can reload a tab this
 * app cannot see, and promising a chat a repair that will never come is worse than saying
 * nothing.
 */
export function unattributedRepairEta(now = Date.now()): number | null {
  if (!browserPresent()) return null;
  const incident = unattributedIncident;
  const suspects = pendingSuspects(incident, now);
  const rung = unattributedRung(suspects.length);
  if (!incident) return Math.round(rung / 1000);
  const due = suspects.map((entry) =>
    Math.min(
      incident.due.get(entry.conversationId) ?? Number.POSITIVE_INFINITY,
      (incident.seen.get(entry.conversationId) ?? now) + rung
    )
  );
  const earliest = due.length > 0 ? Math.min(...due) : now;
  return Math.max(0, Math.round((earliest - now) / 1000));
}

interface UnattributedIncident {
  startedAt: number;
  timer: NodeJS.Timeout | null;
  /** Chats whose calls kept being attributed while this incident was open. Not the broken one. */
  proven: Set<string>;
  /**
   * Suspects this incident has stopped waiting for, because a reload for them was refused for
   * the rest of the turn. Kept apart from `proven`, which is a statement about evidence.
   */
  dismissed: Set<string>;
  /**
   * The server turns whose calls opened or fed this incident. Once the incident has reloaded
   * anybody, these are the request ids a reload has been tried for — see
   * `unattributedReloadedRequests`.
   */
  requestIds: Set<string>;
  /**
   * When each suspect first came under suspicion, and therefore what its own deadline counts
   * from. A chat that joined the incident late has not been silent as long as one that was here
   * at the start, and judging both from `startedAt` would reload it for somebody else's silence.
   */
  seen: Map<string, number>;
  /**
   * Each suspect's own deadline, which only ever moves closer.
   *
   * Every chat is its own failure. A second suspect turning up is not a reason for the first to
   * wait longer — it has already served the time its own evidence was worth — so a rung that
   * rises with the count may not push a deadline that is already set. A rung that falls still
   * pulls it in, which is the point of re-reading the count at every wake instead of freezing it
   * when the incident opened.
   *
   * Latched per chat rather than held as one rung for the incident, because one rung cannot say
   * both things at once: the pass that lowers it for a newcomer is the same pass that would
   * raise it for everybody already waiting.
   */
  due: Map<string, number>;
}

let unattributedIncident: UnattributedIncident | null = null;

/**
 * One repair per chat, and how far along it is.
 *
 *   `queued`  decided, and waiting for the browser to collect it.
 *   `handed`  the browser has it. Nothing is known yet about whether it worked.
 *   `done`    it was carried out — that exact tab reloaded, or the chat reopened.
 *
 * Only `done` suppresses a further repair, because only `done` is an action whose effect there
 * is any point waiting to observe. An explicitly failed or unconfirmed browser action must go
 * back in the queue, or the one failure this path exists for would be recorded as handled and
 * never tried again.
 *
 * `endedTurns` is how many turns the chat had already finished when this repair was filed, and
 * one more of them is what retires the entry: the broken turn is over. Without that, this map
 * would be permanent conversation state, and one repaired turn that never makes another tool
 * call would block every later broken turn in the same chat.
 *
 * A count rather than the turn's own id, because the repair changes the id. The replacement
 * document re-observes a generation that never ended and names it something new, so a repair
 * pinned to an id looked spent seconds after its own reload landed — and while ChatGPT stayed
 * broken, the next incident reloaded the same chat again, and the one after that again. A turn
 * that has actually ended is the only thing that means the failure this repair answered is
 * over, and it says so whether or not the broken turn ever named itself.
 */
interface Repair {
  /** Stable local owner; the browser action is valid only while this session is still here. */
  sessionId: string;
  endedTurns: number;
  state: 'queued' | 'handed' | 'done';
  /** Stable identity of the failure/inactivity episode. A new activity stamp mints a new one. */
  episode: string;
  reason: 'unattributed' | 'assistant-error' | 'no-tab' | 'silence' | 'goal' | 'compaction';
  /** Cooldown boundary. The browser is never asked before this instant. */
  notBefore: number;
  /**
   * Names this exact handout, and is what a receipt has to quote to be believed.
   *
   * The conversation id is not enough to fence it. A repair is scoped to one broken turn, so
   * one chat can hold several over its life: a receipt for the turn-1 repair, delayed behind a
   * turn that ended and a turn-2 repair that took its place, would otherwise mark turn 2
   * repaired — and turn 2, still broken and now recorded as done, would never be repaired at
   * all. Minted per handout rather than per turn because a turn that names itself is not
   * something this can insist on.
   */
  token: string;
  /** One logical timeline row across every attempt and final outcome. */
  progressId: string;
  /** Durable first-snapshot anchor plus the newest text, used to avoid duplicate snapshots. */
  progress?: { sessionId: string; seq: number; time: number; text: string; turnId: string | null };
}

/**
 * Repairs that answer a question about one turn rather than about the chat.
 *
 * The distinction is what makes them retirable only by a *later* turn ending, and therefore
 * what makes them the two that can outlive every fact about them: a page that dies on the
 * broken turn never ends another one. `silence` and `no-tab` are about the conversation, are
 * cleared by ordinary activity, and are not in this set.
 */
const TURN_SCOPED_REPAIRS: ReadonlySet<Repair['reason']> = new Set(['unattributed', 'assistant-error']);

const repairsInFlight = new Map<string, Repair>();
/** Last browser action per exact chat. Error/no-tab recovery shares a cooldown; owned schedules do not. */
const lastBrowserRecoveryAt = new Map<string, number>();

/**
 * The user turn on which each chat has already spent its one error reload.
 *
 * Every message the user sends buys the chat one reload for an error ChatGPT shows during the
 * answer, and exactly one: a second reload of the same broken turn is the same repair that
 * already failed, and it costs the turn another answer to find that out again. The budget is
 * keyed to the turn itself — the running generation, or the count of finished turns when none
 * is running — so it is released by the next turn the chat starts, not by a count that the
 * failed turn's own end may already have moved past (that is how a prime went unreloaded on
 * 2026-09-02: its turn had failed ten seconds before the reload landed and the charge fell on
 * the turn that started fifteen minutes later).
 *
 * This is the error reload's budget alone. Silence answers a different question — is this chat
 * alive at all — and carries no budget beyond its own two minutes; an `unattributed` reload is
 * rationed by the request id it was tried for, see `unattributedReloadedRequests`. None of the
 * three waits on, or is refused because of, another.
 *
 * Written only once the browser confirms the action, so a handout nobody carried out spends
 * nothing.
 */
const turnRepairSpent = new Map<string, { sessionId: string; turnKey: string }>();

/** The identity of the turn a chat is on right now, for the error reload's budget. */
function turnKeyFor(live: { activeTurnId: string | null; endedTurns: number } | undefined): string {
  return live?.activeTurnId ?? `ended:${live?.endedTurns ?? 0}`;
}

/**
 * Request ids of unattributed calls that have already had their reload.
 *
 * An unattributed call is a server turn this app cannot place, and a broken join produces one
 * every few seconds for as long as that turn runs. The reload is tried once per such turn: a
 * later call carrying the same request id is the same broken turn, and a second reload for it
 * would only prove again what the first one proved. A *different* request id is a different
 * turn — a new message from the phone, say — and gets its own reload. Bounded so a day of
 * foreign turns cannot grow it without limit.
 */
const unattributedReloadedRequests = new Set<string>();
const UNATTRIBUTED_REQUEST_MEMORY = 500;

function rememberUnattributedReload(incident: UnattributedIncident): void {
  for (const requestId of incident.requestIds) {
    unattributedReloadedRequests.delete(requestId);
    unattributedReloadedRequests.add(requestId);
  }
  for (const oldest of unattributedReloadedRequests) {
    if (unattributedReloadedRequests.size <= UNATTRIBUTED_REQUEST_MEMORY) break;
    unattributedReloadedRequests.delete(oldest);
  }
}

/**
 * Queues one exact browser action for one inactivity/failure episode.
 *
 * Every trigger converges here. A second reason while an action is already pending is the same
 * recovery, not another reload. Once carried out it stays spent until new activity changes the
 * episode key; the three-minute floor then protects distinct error/no-tab failures. Silence,
 * Goal and compaction carry their own schedules and therefore bypass that unrelated floor.
 */
function queueBrowserRecovery(
  conversationId: string,
  sessionId: string,
  episode: string,
  reason: Repair['reason'],
  endedTurns = 0,
  now = Date.now()
): boolean {
  // A blocked chat is one the user took this app's hands off, and every repair here is a hand
  // going back on: a reload restarts the rogue page's turn machinery, and a reopen gives a
  // conversation whose every tool call is already being refused a brand-new tab to try from.
  // Recovery exists to get a chat working again, which is the opposite of what the user asked
  // for. Every trigger converges on this function — silence, no-tab, unattributed,
  // assistant-error, goal, compaction — so refusing here refuses all of them, and none of them
  // needs its own exemption.
  if (!sessionId || isChatBlocked(conversationId)) return false;
  // The turn's one error reload, already spent. Checked before the episode and state guards
  // below because it outlives both: those forget a repair the moment its episode changes, and
  // the whole point here is that a *new* error on the same broken turn buys nothing.
  if (reason === 'assistant-error') {
    // Read against the turn the chat is on *now*: the release in retireSpentRepairs runs on
    // the browser's pass, and an error on the next turn can arrive before that pass does.
    const spent = turnRepairSpent.get(conversationId);
    const live = liveConversations().find((entry) => entry.conversationId === conversationId);
    if (spent && turnKeyFor(live) === spent.turnKey) return false;
    if (spent) turnRepairSpent.delete(conversationId);
  }
  const held = repairsInFlight.get(conversationId);
  if (held?.episode === episode) return false;
  // Silence may take an entry away from a turn-scoped repair, and it has to be able to. Those
  // are retired by a *later* turn ending, so a chat whose page died on the broken turn keeps
  // one forever — and a permanent entry here used to mean permanent silence, because this
  // guard read it as "a recovery is already running". Nothing was running. Silence asks the
  // chat-level question instead — is this conversation alive at all — and it is the answer to
  // a stuck turn-scoped repair, not something one may mute. Its reload does everything theirs
  // would have done, so superseding loses no repair.
  //
  // Deliberately not extended to `no-tab`, which is chat-scoped like silence, is cleared by
  // ordinary activity, and therefore cannot be the stuck kind. Letting silence past that one
  // would only cancel its three-minute floor and reopen tabs faster than the floor allows.
  const supersedes = reason === 'silence' && TURN_SCOPED_REPAIRS.has(held?.reason as Repair['reason']);
  if (held && held.state !== 'done' && !supersedes) return false;
  // Silence already paid its complete two-minute inactivity boundary. Once genuine new activity
  // starts another episode, layering the unrelated browser-action floor on top delays the next
  // stuck-page recovery beyond its own contract. Error/no-tab repairs keep that shared floor.
  // `goal` is exempt for the same reason and a stronger one: it carries its own backoff, which
  // after the opening step is already longer than the shared floor, so applying both would only
  // move the user's stated schedule without changing what protects the page.
  const notBefore =
    reason === 'silence' || reason === 'goal' || reason === 'compaction'
      ? now
      : Math.max(now, (lastBrowserRecoveryAt.get(conversationId) ?? 0) + BROWSER_RECOVERY_COOLDOWN_MS);
  repairsInFlight.set(conversationId, {
    sessionId,
    endedTurns,
    state: 'queued',
    episode,
    reason,
    notBefore,
    token: '',
    progressId: `browser-repair:${randomBytes(9).toString('base64url')}`
  });
  return true;
}

/**
 * Meaningful page/call activity is the episode boundary; empty polling is intentionally absent.
 *
 * Two reasons are exempt, because neither is about whether the chat is doing something. An
 * `unattributed` repair is about a broken request-id join, and an `assistant-error` one is about
 * a specific turn whose answer the page said it lost. Both are retired by facts about that turn -
 * the browser carrying the repair out, or the chat finishing a turn since it was filed - and
 * `retireSpentRepairs` owns exactly that. Letting activity delete them instead is what made the
 * error case unreachable: the model keeps running server-side through a lost stream, so the chat
 * goes on producing activity for as long as it stays broken.
 */
function noteRecoveryActivity(conversationId: string): void {
  const held = repairsInFlight.get(conversationId);
  if (!held) return;
  if (held.reason === 'unattributed' || held.reason === 'assistant-error') return;
  repairsInFlight.delete(conversationId);
}

/** Applies one accepted observation batch to the recovery episode, after it is durable. */
function noteRecoveryObservations(
  conversationId: string,
  sessionId: string | null,
  observations: readonly ChatObservation[],
  activity: { meaningful: boolean; working: boolean; terminal: boolean }
): void {
  // The recorder owns idempotency. Raw batches may contain a historical user row or turn_start
  // beside a newly accepted title, so inferring activity from `stored > 0` re-armed completed
  // chats on every recovery reload. Only the recorder's per-event acceptance verdict may move
  // this clock. A just-authored opening row covers the narrow pre-turn_start fresh-chat window;
  // replayed/history rows explicitly do not.
  if (activity.meaningful) {
    noteRecoveryActivity(conversationId);
    noteGoalWatchActivity(conversationId);
    // A current-turn interim can push an existing deadline; historical transcript/page rows
    // never enter this verdict and therefore cannot keep a confirmed reload alive.
    if (sessionId && !activity.terminal && (activity.working || activeUntil.has(conversationId))) {
      grantActivity(conversationId, sessionId);
    }
  }
  // A turn that ended *failed* is not a chat that has stopped: the model behind the dead stream
  // is usually still running, and a reload shows the answer it has meanwhile finished. So a
  // failure restarts the two-minute watch instead of spending it — the same chat-level question
  // silence always asks, from the moment the page gave up. Ending activity here is how the
  // 2026-09-02 prime sat dead for twenty minutes: its failure had been refused the immediate
  // reload, its turn end took it off the silence clock, and nothing was left to ask.
  let lastEnd: string | null = null;
  for (const item of observations) {
    if (item.kind === 'turn_end') lastEnd = item.outcome ?? 'unknown';
  }
  if (activity.terminal) {
    if (lastEnd === 'failed' && sessionId) grantActivity(conversationId, sessionId);
    else endActivity(conversationId);
  }

  // An error rendered on the page is the page saying, in its own words, that nothing more is
  // coming: the answer it was producing is gone, or the site has stopped. That is true of any
  // chat — an ordinary conversation with no worker attached breaks the same way, and leaving it
  // parked on "message delivery timed out" until a human notices was the whole of this bug —
  // and it is true whatever the error says. Whether the DOM classifier called it recoverable,
  // and whether the page could name the turn it belongs to, decides nothing here: the page is
  // reloaded because it shows an error, once per user turn (see turnRepairSpent), and neither
  // an agent binding nor a recent attributed call may gate that.
  const now = Date.now();
  for (const item of observations) {
    if (item.kind !== 'chat_error') continue;
    // Auto-compaction owns this chat's recovery clock until its ticket commits or is cancelled.
    // A native error inside a handoff is not permission for the ordinary two-minute response
    // watchdog to cut across the compaction's own pickup schedule. The failure is still the page
    // saying its answer is gone, so the ticket's next pickup — the same reload of the same chat,
    // under the same bound — is brought forward to the next sweep instead of waiting out its five
    // minutes. That wait is how the 2026-09-02 prime showed "Connection interrupted" for nine
    // minutes while its model went on calling tools behind the dead page.
    if (pendingAutomaticContinuations().some((entry) => entry.from === conversationId)) {
      if (expediteCompactionPickup(conversationId)) {
        logInfo(`bridge: assistant transport failure — bringing the compaction pickup for ${conversationId} forward`);
      }
      break;
    }
    const episode = `assistant-error:${item.turnId ?? 'page'}:${(item.text ?? '').slice(0, 240)}`;
    // How many turns this chat will have finished once the broken turn is over. The turn that
    // just failed is still open here - its own end is the very next one to arrive - so counting
    // only the ends already in hand would have the failure retire its own repair a few seconds
    // later. Counting the open turn as spent makes the next end after it the first that means
    // anything: a turn the chat actually got through, which is the one fact that says the page
    // recovered without help.
    const live = liveConversations().find((entry) => entry.conversationId === conversationId);
    const endedTurns = (live?.endedTurns ?? 0) + (live?.activeTurnId ? 1 : 0);
    if (
      sessionId &&
      queueBrowserRecovery(conversationId, sessionId, episode, 'assistant-error', endedTurns, now)
    ) {
      logInfo(`bridge: assistant transport failure — asking the browser to recover ${conversationId}`);
    }
    break;
  }
}

/** Exact live agent conversations whose existing Chrome tabs must remain loaded. */
function nonDiscardableAgentConversations(): string[] {
  return swarmState().agents
    .filter(
      (agent) =>
        Boolean(agent.conversationId) &&
        (agent.role === 'prime'
          ? agent.state === 'active'
          : agent.state === 'active' || agent.state === 'waking' || agent.state === 'detached')
    )
    .map((agent) => agent.conversationId as string)
    .sort();
}

/**
 * Chats whose tabs the browser should close: the source chat of every finished Compact &
 * Resume, and stopped worker chats beyond the worker limit plus two — enough for the prime to
 * come back to its recent workers without keeping every chat it ever spawned resident. A
 * revival opens a closed sleeping worker's chat again, so nothing is lost by closing it; a
 * chat that is protected from discard is never on this list.
 */
function closableAgentConversations(): string[] {
  const protectedChats = new Set(nonDiscardableAgentConversations());
  const keep = getConfig().multiAgent.maxWorkers + 2;
  return [...new Set([...supersededSourceConversations(), ...closableWorkerConversations(keep)])]
    .filter((conversationId) => !protectedChats.has(conversationId))
    .sort();
}

/**
 * Whether silence or a missing tab may reopen or reload this chat at all.
 *
 * A chat the Goal or Loop switch is driving is always brought back: the loop is the user's
 * standing instruction to keep that chat going, and a closed browser is not a reason to stop
 * carrying it out. Every other chat — a worker, a prime, a plain chat that has called tools —
 * comes back only when the user has turned tab recovery on for them, and that starts off.
 */
function tabRecoveryWanted(conversationId: string): boolean {
  return goalActiveFor(conversationId) || getConfig().multiAgent.recoverAgentTabs;
}

/** The active agent chats for which the browser must keep asking the app for recovery work. */
function browserRecoveryMonitoring(): boolean {
  if (repairsInFlight.size > 0 || activeUntil.size > 0 || goalWatch.size > 0 || compactionWatch.size > 0) return true;
  return swarmState().agents.some(
    (agent) =>
      Boolean(agent.conversationId) &&
      (agent.state === 'active' || agent.state === 'waking') &&
      tabRecoveryWanted(agent.conversationId as string)
  );
}

/**
 * Turns whose two-minute silence expired either receive their sole browser action or, once that
 * exact action was confirmed, become safe to abandon. Merely handing an action to Chrome is not
 * enough: an unconfirmed handout remains retryable through the existing receipt protocol.
 *
 * Deliberately not gated on the other repair reasons. This is the only check in the app that
 * asks whether a conversation is still alive, so nothing scoped to one of its turns may switch
 * it off — see the supersede rule in `queueBrowserRecovery`.
 */
function inspectSilentChats(now: number): { queued: boolean; spent: string[] } {
  let queued = false;
  let deferred = false;
  const spent: string[] = [];
  const compacting = new Set(pendingAutomaticContinuations().map((entry) => entry.from));
  for (const [conversationId, grant] of activeUntil) {
    if (compacting.has(conversationId)) continue;
    if (grant.until > now) continue;
    // A blocked chat never gets the reload, so it can never get the confirmation this pass
    // otherwise waits for, and it would sit measured-silent in the ledger — and in the live set
    // the UI paints — for the rest of the process. Its silence is spent the moment it is
    // measured. (A blocked chat's worker slot is not this pass's business: sweepStaleSwarm
    // sleeps it from the block itself, grant or no grant.)
    if (isChatBlocked(conversationId)) {
      spent.push(conversationId);
      continue;
    }
    // Not a chat the user wants brought back: its silence is spent the same way, without the
    // reload that would otherwise be its one chance.
    if (!tabRecoveryWanted(conversationId)) {
      spent.push(conversationId);
      continue;
    }
    const held = repairsInFlight.get(conversationId);
    if (held?.state === 'done' && !TURN_SCOPED_REPAIRS.has(held.reason)) {
      spent.push(conversationId);
      continue;
    }
    // A turn-scoped repair is a different question about a different subject, and is superseded
    // below rather than obeyed here; reading one as "a recovery is already running" is what left
    // a chat that had been dead for eighteen minutes unreloaded. Everything else in flight —
    // silence's own action, or a no-tab reopen under its floor — is this path already acting.
    if (held && !TURN_SCOPED_REPAIRS.has(held.reason)) continue;
    // A reload carried out moments ago, that the page has not yet come back from, is the reload
    // silence would ask for. A large chat takes minutes to come back — three, for the 300k-token
    // prime of 2026-09-03 — and a second reload landing on a page still loading starts that wait
    // over: the silence reload landed 23 seconds after an unattributed one, and the chat froze
    // for three more minutes. The page gets the recovery floor to come back; its first sign of
    // life resets the clock as usual, and a page that never returns is reloaded when the floor
    // has run out.
    const lastReload = lastBrowserRecoveryAt.get(conversationId) ?? 0;
    if (awaitingReturn.has(conversationId) && now - lastReload < BROWSER_RECOVERY_COOLDOWN_MS) {
      grant.until = lastReload + BROWSER_RECOVERY_COOLDOWN_MS;
      deferred = true;
      continue;
    }
    if (queueBrowserRecovery(conversationId, grant.sessionId, `silence:${grant.until}`, 'silence', 0, now)) {
      queued = true;
      logInfo(
        `bridge: active chat silent for two minutes — asking the browser to reload ${conversationId} once`
      );
    }
  }
  if (deferred) armSilenceSweep(now);
  return { queued, spent };
}

/** Retires a confirmed one-shot silence recovery after the caller has handled any Worker slot. */
function finishSilentChats(conversationIds: readonly string[]): void {
  for (const conversationId of conversationIds) {
    forgetActivity(conversationId);
    repairsInFlight.delete(conversationId);
  }
}

/**
 * When a chat that owes a Goal decision is reloaded, measured from its last sign of life.
 *
 * The first number is the silence window over again, and deliberately the same one: two minutes
 * with nothing arriving is this app's standing definition of a chat that has stopped, and a
 * conversation the loop is driving does not get a different definition just because what stalled
 * was the pickup rather than the turn. The rest is the retry schedule — two, five, ten, fifteen —
 * so five reloads span a little over half an hour and then it stops for good.
 *
 * It stops for good on purpose. Every reload here is the app typing into somebody's browser
 * about a reply that is already finished and already on screen; the case it rescues is a page
 * that died between the answer and the pickup, which either comes back in the first half hour or
 * is not coming back. An unbounded watchdog on a durable ledger is how you get a chat reloading
 * itself at four in the morning.
 */
// Asserted non-empty: the opening gap is read unconditionally when a schedule is armed, and a
// schedule with no first step would be a watchdog that never starts.
const GOAL_WATCH_BACKOFF_MS = [2, 2, 5, 10, 15].map((minutes) => minutes * 60_000) as [number, ...number[]];

/**
 * One reload schedule per chat that still owes a Goal decision.
 *
 * `attempts` is spent, never refunded. Activity pushes the next attempt out — while tool calls
 * keep arriving the chat is working, not stalled, and nothing here fires — but it does not buy
 * more attempts, which is what makes the whole watchdog terminate no matter what the page does
 * with the reload. That matters more than it looks: a reload produces page events, and a
 * schedule that reset on them would be a chat reloading itself forever.
 *
 * The row is keyed to the exact `replyId` it was armed for. A newer final answer is a different
 * obligation and gets its own schedule; a discharged one takes its schedule with it.
 */
const goalWatch = new Map<string, { replyId: string; dueAt: number; attempts: number }>();

/**
 * The browser pickups an automatic ticket gets, by what the ticket is waiting for.
 *
 * Three clocks, one per phase, and the phase is read off the ticket's durable position every
 * sweep. A page holds the ticket only while it is the page doing the work; the moment it stops
 * being that page — frozen, discarded, closed, mid-reload — the app's pickup is what keeps the
 * compaction going, and each pickup raises the tab first (a background tab is a throttled one;
 * that is how the 2026-09-03 source page froze solid while its brief was being written).
 *
 * `asking` — the brief has not been asked for yet. Nothing has reached ChatGPT, so the reload
 * is free and the wait is short: every two minutes for ten minutes, the tab raised each time, and
 * the fresh page resumes the ticket the instant it reads it back. Five pickups with no send is a
 * chat that will not take the prompt — a tab that never comes back, a composer that will not
 * accept it — and the ticket is abandoned rather than left to nag: the next working turn opens
 * a fresh one. Which is also what keeps an old chat quiet: a ticket only ever opens on a working
 * chat, and one that could not be sent expires with its ten minutes.
 *
 * `writing` — the marked prompt is with ChatGPT and the brief is being generated. A reload here
 * loses nothing (the stable marker recovers a brief already generated or still generating) but
 * the answer takes as long as it takes, so the checkpoint is every five minutes and there are
 * three of them. The ticket is never failed by a pickup in this phase; it stays collectable.
 *
 * `opening` — the brief landed and the replacement chat is owed. The resume command is leased
 * for a quarter of an hour, so that is the cadence, three times.
 *
 * Page activity never pushes any of these; `since` is when the phase began (the ticket's
 * opening, the prompt's durable dispatch) or when it was last picked up. A phase change resets
 * the count — the writing phase's three do not include the two the asking phase spent.
 */
type CompactionPhase = 'asking' | 'writing' | 'opening';
const COMPACTION_PICKUPS: Record<CompactionPhase, { every: number; attempts: number }> = {
  asking: { every: 2 * 60_000, attempts: 5 },
  writing: { every: 5 * 60_000, attempts: 3 },
  opening: { every: 15 * 60_000, attempts: 3 }
};
const compactionWatch = new Map<string, { token: string; phase: CompactionPhase; since: number; attempts: number }>();

function compactionPhaseOf(entry: ContinuationView): CompactionPhase {
  if (entry.state !== 'awaiting-summary') return 'opening';
  return sendUnattempted(entry.sourceSend) ? 'asking' : 'writing';
}

/**
 * Makes a ticket's next automatic pickup due on the next sweep, within the same bound.
 *
 * The schedule is not otherwise moved by page activity, and this adds no attempts: a pickup
 * brought forward is one of the phase's own. False when there is no automatic ticket for the
 * chat, the ticket predates this process, or its pickups are exhausted.
 */
function expediteCompactionPickup(conversationId: string): boolean {
  const entry = pendingAutomaticContinuations().find((candidate) => candidate.from === conversationId);
  if (!entry || compactionWatchFloor === null || entry.openedAt < compactionWatchFloor) return false;
  const phase = compactionPhaseOf(entry);
  const watch = compactionWatch.get(conversationId);
  if (watch && watch.token === entry.token && watch.phase === phase) {
    if (watch.attempts >= COMPACTION_PICKUPS[phase].attempts) return false;
    watch.since = 0;
    return true;
  }
  compactionWatch.set(conversationId, { token: entry.token, phase, attempts: 0, since: 0 });
  return true;
}

/** A switch change retires both the schedule and any queued reload for its former ticket. */
function forgetGoalWatch(conversationId: string): void {
  goalWatch.delete(conversationId);
  if (repairsInFlight.get(conversationId)?.reason === 'goal') repairsInFlight.delete(conversationId);
}

/**
 * The instant this process began serving, and the fence under which no goal is ever revived.
 *
 * The obligation ledger is durable and keeps a row for twelve hours, which is right for the
 * page-side resume it was built for — a replacement content script asking what it still owes —
 * and quite wrong as a licence for the app to go and reload chats. Without this fence, installing
 * this version would reload every conversation that had been left owing a decision since
 * yesterday afternoon. Only work this run watched arrive is work this run acts on.
 */
let goalWatchFloor: number | null = null;
let compactionWatchFloor: number | null = null;

/** Any sign of life pushes the next reload out by the gap this chat is currently on. */
function noteGoalWatchActivity(conversationId: string): void {
  const watch = goalWatch.get(conversationId);
  if (!watch) return;
  const gap = GOAL_WATCH_BACKOFF_MS[watch.attempts];
  if (gap === undefined) return;
  watch.dueAt = Date.now() + gap;
}

/**
 * Reloads chats whose finished reply nothing ever came to collect.
 *
 * The Goal loop has exactly one trigger and it lives in the page: a content script sees a turn
 * end and asks the app for a draft. That is the right place for it — only the page knows what is
 * on screen — but it means the loop's liveness is the page's liveness, and a document that dies
 * between the final answer and the request takes the whole loop down with it silently. The
 * obligation is on file, correctly marked pending, and nobody is left alive to redeem it.
 *
 * So this is the other half: the app watching its own ledger. It asks nothing about turns and
 * nothing about drafts, only whether a decision is owed and whether the chat has gone quiet, and
 * its answer is the same reload the page would have got from any other recovery path. A reload
 * republishes `goal.pending` to the replacement script, which asks for the draft the dead one
 * never asked for — which is also why a goal that failed once retries: the next reload is a new
 * request, and the obligation was never discharged by the failure.
 */
async function inspectOwedGoals(now: number): Promise<boolean> {
  if (goalWatchFloor === null) return false;
  const owed = new Map(pendingGoalReplies(now).map((reply) => [reply.conversationId, reply]));
  // A schedule outlives neither its obligation nor its reply. Discharged, expired or superseded
  // are the same fact here — this chat is no longer owed the decision this row was armed for —
  // and the reload queued for it goes with it.
  for (const [conversationId, watch] of goalWatch) {
    if (owed.get(conversationId)?.replyId === watch.replyId) continue;
    goalWatch.delete(conversationId);
    if (repairsInFlight.get(conversationId)?.reason === 'goal') repairsInFlight.delete(conversationId);
  }
  let queued = false;
  for (const reply of owed.values()) {
    if (reply.acceptedAt < goalWatchFloor) continue;
    const session = await getSession(reply.sessionId);
    if (
      session?.conversationId !== reply.conversationId ||
      (await conversationWasSuperseded(reply.conversationId))
    ) {
      forgetGoalWatch(reply.conversationId);
      continue;
    }
    // The same three questions the page asks itself before drafting. A switch turned off, a
    // worker chat, or a chat whose objective was cleared is not a chat with a stalled pickup;
    // it is one where the loop is not entitled to act, and reloading it would be this app
    // restarting work the user stopped.
    if (!goalActiveFor(reply.conversationId)) continue;
    // Compact & Resume owns the chat while it runs: the handoff is being written, the
    // conversation is about to be replaced, and the obligation travels to the replacement with
    // everything else. Reloading mid-transaction is the one thing that could lose it.
    if (continuationForSession(reply.sessionId)) continue;
    let watch = goalWatch.get(reply.conversationId);
    if (!watch) {
      watch = {
        replyId: reply.replyId,
        attempts: 0,
        dueAt: reply.acceptedAt + GOAL_WATCH_BACKOFF_MS[0]
      };
      goalWatch.set(reply.conversationId, watch);
    }
    if (watch.attempts >= GOAL_WATCH_BACKOFF_MS.length || now < watch.dueAt) continue;
    // A draft already being written is the pickup happening. Treat it as the activity it is.
    if (goalDraftBusy(reply.conversationId)) {
      noteGoalWatchActivity(reply.conversationId);
      continue;
    }
    const held = repairsInFlight.get(reply.conversationId);
    // This watchdog's own carried-out reload is this watchdog's to retire; a spent repair filed
    // by anything else is left where it is, and `queueBrowserRecovery` takes it from there.
    if (held?.state === 'done' && held.reason === 'goal') repairsInFlight.delete(reply.conversationId);
    else if (held && held.state !== 'done') continue;
    if (
      !queueBrowserRecovery(
        reply.conversationId,
        reply.sessionId,
        `goal:${reply.replyId}:${watch.attempts}`,
        'goal',
        0,
        now
      )
    ) {
      continue;
    }
    watch.attempts += 1;
    watch.dueAt = now + (GOAL_WATCH_BACKOFF_MS[watch.attempts] ?? 0);
    queued = true;
    logInfo(
      `bridge: goal reply uncollected in ${reply.conversationId} — reload ${watch.attempts} of ${GOAL_WATCH_BACKOFF_MS.length}`
    );
  }
  return queued;
}

/**
 * Gives durable auto-compaction tickets their bounded browser pickups — see COMPACTION_PICKUPS.
 *
 * Only the asking phase has a failure verdict: a prompt that could not be sent in ten minutes
 * is abandoned. Past the send the ticket has no clock here; it remains collectable by any later
 * page until Auto Off, explicit cancel, or the marked bootstrap's durable commit in chat B.
 */
async function inspectOwedCompactions(now: number): Promise<boolean> {
  if (compactionWatchFloor === null) return false;
  const owed = new Map(pendingAutomaticContinuations().map((entry) => [entry.from, entry]));
  for (const [conversationId, watch] of compactionWatch) {
    if (owed.get(conversationId)?.token === watch.token) continue;
    compactionWatch.delete(conversationId);
    if (repairsInFlight.get(conversationId)?.reason === 'compaction') repairsInFlight.delete(conversationId);
  }

  let queued = false;
  for (const entry of owed.values()) {
    if (entry.openedAt < compactionWatchFloor) continue;
    const phase = compactionPhaseOf(entry);
    let watch = compactionWatch.get(entry.from);
    if (!watch || watch.phase !== phase) {
      // The clock starts when the phase did, not when this sweep noticed: the ticket's opening
      // for asking, the durable dispatch stamp for writing. The brief's landing has no stamp
      // of its own, and at a quarter-hour cadence the sweep's half-minute lag does not matter.
      const since = phase === 'asking' ? entry.openedAt : phase === 'writing' ? (entry.askedAt ?? now) : now;
      watch = { token: entry.token, phase, attempts: 0, since };
      compactionWatch.set(entry.from, watch);
    }
    const schedule = COMPACTION_PICKUPS[phase];
    if (now < watch.since + schedule.every) continue;
    if (watch.attempts >= schedule.attempts) {
      if (phase !== 'asking') continue;
      // Ten minutes and five raised reloads without the prompt ever reaching ChatGPT. The
      // chat's tools were never fenced (that starts at the send), so nothing is stranded by
      // letting go; what would be stranded is the chat under a ticket it can never discharge.
      compactionWatch.delete(entry.from);
      if (repairsInFlight.get(entry.from)?.reason === 'compaction') repairsInFlight.delete(entry.from);
      try {
        await abortContinuationNow(entry.token, 'handoff_never_sent');
        logWarn(
          `bridge: auto-compaction ticket ${entry.token.slice(0, 8)} for ${entry.from} was never sent after ${schedule.attempts} pickups — giving up; the next working turn opens a fresh one`
        );
        changed();
      } catch (err) {
        logWarn(`bridge: could not abandon auto-compaction ticket ${entry.token.slice(0, 8)} — ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

    let acted = false;
    if (phase === 'asking' || phase === 'writing') {
      const held = repairsInFlight.get(entry.from);
      if (held?.state === 'done' && held.reason === 'compaction') repairsInFlight.delete(entry.from);
      else if (held && held.state !== 'done') continue;
      acted = queueBrowserRecovery(
        entry.from,
        entry.sessionId,
        `compaction:${entry.token}:${phase}:${watch.attempts}`,
        'compaction',
        0,
        now
      );
    } else if (
      sendUnattempted(entry.destinationSend) &&
      !commands.some((command) => command.spec.type === 'resume' && command.spec.token === entry.token)
    ) {
      // The brief exists but its fresh-chat transport failed before Send. The destination
      // checkpoint proves opening this same ticket again cannot duplicate the bootstrap.
      queueResumeCommand(entry.sessionId, entry.token);
      void deliver();
      acted = true;
    }
    if (!acted) continue;

    watch.attempts += 1;
    watch.since = now;
    queued = true;
    logInfo(
      `bridge: auto-compaction ticket ${entry.token.slice(0, 8)} ${phase} pickup ${watch.attempts} of ${schedule.attempts}`
    );
  }
  return queued;
}

/**
 * A final-tab close during one exact open turn is one no-tab recovery episode.
 *
 * Two kinds of chat qualify, for one reason: this app is owed the end of a turn that is still
 * running on OpenAI's servers, and the page that was watching it is gone. For a Prime or Worker
 * that turn is the run's, which is what `recoverAgentTabs` is a preference about. For any other
 * chat the qualification is the one fact that makes it this app's business at all — it has
 * proved at least one MCP call, so the turn still running is running against this connector. A
 * chat that has never called a tool is the user's own browsing: closing it is not a failure, and
 * reopening it would be this app helping itself to a tab nobody asked it to keep.
 *
 * The silence deadline would eventually reopen either of them, but only two minutes after the
 * last sign of life. A closed tab is first-hand proof that the page is gone *now*, and acting on
 * it is the whole difference between a chat that comes straight back and one the user watches
 * fail to.
 *
 * The episode is stamped with the moment the page went, never with the chat's moving activity
 * deadline. A detached chat goes on calling tools server-side, so a stamp that tracked activity
 * would mint a fresh episode — and a second tab — out of the very work this repair exists to
 * keep alive.
 */
async function queueMissingTab(conversationId: string, closedMidTurn: boolean, now = Date.now()): Promise<void> {
  if (!closedMidTurn) return;
  const agent = agentInfoForOwnedConversation(conversationId);
  // Read after closeConversation() has ended the session, so `endedAt` is this exact close.
  const session = await findSessionByConversation(conversationId);
  const eligible = tabRecoveryWanted(conversationId) && (agent ? agent.state === 'detached' : (session?.toolCalls ?? 0) > 0);
  if (!eligible) return;
  const wentAt = agent?.detachedAt ?? session?.endedAt ?? now;
  if (session && queueBrowserRecovery(conversationId, session.id, `no-tab:${wentAt}`, 'no-tab', 0, now)) {
    logInfo(
      `bridge: ${agent?.id ?? conversationId} has no tab — asking the browser to open the exact chat once`
    );
  }
}

/**
 * Every live chat this app can presently prove is mid-turn.
 *
 * A conversation whose own page reports it is generating qualifies. A tab that went away
 * mid-turn already filed its exact no-tab repair at `/closed`; treating every durable `detached`
 * agent as still mid-turn made completed Prime chats reopen merely because they owned a run.
 */
function repairCandidates(
  now = Date.now()
): Array<{ conversationId: string; sessionId: string; endedTurns: number }> {
  // Deliberately read-only. `inspectSilentChats` is the ledger's sole owner and runs every
  // thirty seconds, forgetting each expired grant once its turn is closed or its one reload is
  // spent. A second expiry clock here used to delete a grant whose reload had been carried out
  // but not yet judged, which left that repair in flight forever and never released its slot.
  const live = new Map(liveConversations().map((entry) => [entry.conversationId, entry]));
  const candidates = new Set(
    [...activeUntil].filter(([, grant]) => grant.until > now).map(([conversationId]) => conversationId)
  );
  // Unattributed recovery is the one place a browser-local open turn remains useful: it narrows
  // an identity failure without itself creating a silence-reload episode. A reload-generated
  // turn_start therefore cannot re-arm ordinary recovery, while a genuinely open page can still
  // be one of the exact chats whose request-id join may have failed.
  for (const entry of live.values()) if (entry.activeTurnId) candidates.add(entry.conversationId);
  return [...candidates].flatMap((conversationId) => {
    const sessionId =
      live.get(conversationId)?.sessionId ?? activeUntil.get(conversationId)?.sessionId ?? null;
    return sessionId
      ? [
          {
            conversationId,
            sessionId,
            endedTurns: live.get(conversationId)?.endedTurns ?? 0
          }
        ]
      : [];
  });
}

/**
 * Forgets repairs whose broken turn is over.
 *
 * One rule, because one fact means what this needs: the chat has finished a turn since the
 * repair was filed. A repair answers one broken turn, so that turn ending is what spends it,
 * whether or not the browser ever carried it out and whether or not a new turn has begun since.
 *
 * Everything a turn id could have been asked here is worse. The reload this path performs mints
 * a new one for a generation that never ended, so id inequality reads a repair that is working
 * as a repair that is spent — and a join the reload did not fix goes on producing unattributed
 * calls, so the next incident reloaded the same chat again, and the one after that again, every
 * minute for as long as ChatGPT stayed broken. One reload per failure; ten reloads
 * prove only that the first nine did not help. Generation stopping is not the fact either: a
 * turn that ends and a turn that begins can reach this app in one batch, and by the time this
 * runs the chat is simply generating again.
 *
 * What ends a repair early is proof it worked: an attributed call from that chat, in
 * `noteCallAttribution`. That is the only thing that says the join this repair existed to
 * restore is restored.
 *
 * A chat with no live record at all is judged by nothing here: that is a detached worker whose
 * conversation was closed, and its reopen is retired when its replacement page reports — see
 * `repairCandidates` — or by the attributed call that proves its join.
 */
function retireSpentRepairs(): void {
  const live = new Map(liveConversations().map((entry) => [entry.conversationId, entry]));
  for (const [conversationId, repair] of repairsInFlight) {
    // Both turn-scoped reasons, and only those. `silence` and `no-tab` are about a chat rather
    // than a turn, and keep the activity-driven lifecycle above.
    if (!TURN_SCOPED_REPAIRS.has(repair.reason)) continue;
    const entry = live.get(conversationId);
    if (entry && entry.endedTurns > repair.endedTurns) repairsInFlight.delete(conversationId);
  }
  // The budget is released by the chat being on a different turn than the one it was charged
  // to — the user sent the next message — and by nothing else. Not by an attributed call: a
  // join that came back proves the reload worked, which is a reason not to need another one,
  // never a reason to be handed one.
  for (const [conversationId, spent] of turnRepairSpent) {
    const entry = live.get(conversationId);
    if (entry && turnKeyFor(entry) !== spent.turnKey) turnRepairSpent.delete(conversationId);
  }
}

/**
 * The recorder's verdict on one finished call: the conversation it proved, or null for a call
 * that finished the request-id grace with no page evidence at all.
 *
 * An attributed call is the only evidence that a chat's join works — page liveness is not, since
 * a document can keep reporting turns and progress while its request-id reporting is dead. So an
 * attributed call is what clears a chat, and an unattributed one is what opens the incident. The
 * incident opens once: a broken join produces a call every few seconds, and a deadline that
 * renewed on each of them would never fire.
 *
 * Clearing the chat's repair here is also what allows the next one. A repair that was carried
 * out is kept until exactly this line runs, so that a reload which did not help is not repeated
 * — see `retireSpentRepairs`. This call is the proof that it did help.
 */
function noteCallAttribution(
  conversationId: string | null,
  sessionId: string,
  currentConversation: boolean,
  startedAt: number,
  endsActivity = false,
  lastAssistantFinalAt: number | null = null,
  requestId: string | null = null,
  reopenedTurnId: string | null = null
): void {
  if (conversationId) {
    if (currentConversation && !endsActivity) lastAttributedCallAt.set(conversationId, Date.now());
    // The recorder has just withdrawn a completed end the page reported: the same server turn
    // went on calling tools. Whatever Goal was drafting for that end — or had filed as owed —
    // was a reply to an answer that has not been given. The real end, when the page sees it,
    // files its own obligation.
    if (reopenedTurnId && retireGoalDraftsFor(conversationId)) {
      forgetGoalWatch(conversationId);
      logInfo(`goal: withdrew the decision owed for turn ${reopenedTurnId} of ${conversationId} — the turn is still running`);
    }
    if (unattributedIncident && !unattributedIncident.proven.has(conversationId)) {
      unattributedIncident.proven.add(conversationId);
      // One suspect fewer is a shorter rung for everybody still waiting. Re-read it now instead
      // of at a wake armed for the longer queue, or the last chat standing serves out a wait
      // sized for company it no longer has. Deferred by a zero timer so the incident is never
      // decided on the recorder's own filing stack.
      armUnattributedTick(unattributedIncident, 0);
    }
    // Exact recording authority follows the durable lineage, but recovery authority does not.
    // A late request from handoff source A is still filed in the A->B session above; once that
    // session says B is current, the same request must not put A back on the silence/Goal clock.
    if (!currentConversation) {
      const grant = activeUntil.get(conversationId);
      if (grant?.sessionId === sessionId) activeUntil.delete(conversationId);
      const repair = repairsInFlight.get(conversationId);
      if (repair?.sessionId === sessionId) repairsInFlight.delete(conversationId);
      forgetGoalWatch(conversationId);
      compactionWatch.delete(conversationId);
      armSilenceSweep();
      return;
    }
    if (endsActivity) {
      endActivity(conversationId);
      repairsInFlight.delete(conversationId);
      return;
    }
    // Attribution can finish after the page has already stored the final answer. The call's own
    // start time decides which side of that durable boundary it belongs to; recorder latency may
    // never resurrect work that the model has visibly completed.
    if (lastAssistantFinalAt !== null && startedAt <= lastAssistantFinalAt) {
      if (repairsInFlight.get(conversationId)?.reason === 'unattributed') {
        repairsInFlight.delete(conversationId);
      }
      return;
    }
    // The exact call is stronger than browser lifecycle state: the model is still working even
    // when Chrome, the tab or a reload destroyed the page's local turn projection.
    grantActivity(conversationId, sessionId);
    noteRecoveryActivity(conversationId);
    noteGoalWatchActivity(conversationId);
    // Scoped to the repair this fact is evidence about. An attributed call proves the request-id
    // join, which is the whole of what an `unattributed` repair exists to restore. It proves
    // nothing about the answer stream a page lost, and the live trace is why that distinction is
    // load-bearing: fifteen attributed calls arrived while the page sat on "Connection
    // interrupted. Waiting for the complete answer", each one deleting the reload that notice had
    // just asked for. That repair is retired by its own turn ending - see `retireSpentRepairs`.
    if (repairsInFlight.get(conversationId)?.reason !== 'assistant-error') {
      repairsInFlight.delete(conversationId);
    }
    return;
  }
  // The same broken turn, already reloaded for. A reload is tried once per request id; a call
  // that carries one the app has reloaded for is the turn going on being broken, not news.
  if (requestId && unattributedReloadedRequests.has(requestId)) return;
  if (unattributedIncident) {
    if (requestId) unattributedIncident.requestIds.add(requestId);
    return;
  }
  const openedAt = Date.now();
  // Seeded now, not at the first wake. Everyone already under suspicion when the incident opens
  // has been silent since this instant, and dating them from the first tick instead would hand
  // each of them a free rung nobody was waiting through.
  const opening = pendingSuspects(null, openedAt);
  const rung = unattributedRung(opening.length);
  const incident: UnattributedIncident = {
    startedAt: openedAt,
    timer: null,
    proven: new Set(),
    dismissed: new Set(),
    requestIds: new Set(requestId ? [requestId] : []),
    seen: new Map(opening.map((entry) => [entry.conversationId, openedAt])),
    due: new Map(opening.map((entry) => [entry.conversationId, openedAt + rung]))
  };
  unattributedIncident = incident;
  armUnattributedTick(incident, rung);
}

/**
 * The chats an open incident is still deciding about.
 *
 * Exactly the set the acting pass acts on, because a count that meant anything else would size
 * the wait for a set that is not the one being judged. A chat that has proved its join, that has
 * been dismissed, or that already holds a repair is neither a suspect nor a reason for anybody
 * else to wait longer. A null incident asks the same question of a fresh one.
 */
function pendingSuspects(
  incident: UnattributedIncident | null,
  now = Date.now()
): Array<{ conversationId: string; sessionId: string; endedTurns: number }> {
  return repairCandidates(now).filter(
    (entry) =>
      !incident?.proven.has(entry.conversationId) &&
      !incident?.dismissed.has(entry.conversationId) &&
      !repairsInFlight.has(entry.conversationId)
  );
}

/** Replaces the pending wake rather than stacking a second one on top of it. */
function armUnattributedTick(incident: UnattributedIncident, delay: number): void {
  if (incident.timer) clearTimeout(incident.timer);
  incident.timer = setTimeout(tickUnattributedIncident, Math.max(0, delay));
  incident.timer.unref?.();
}

/**
 * Reattaches every chat whose own deadline has passed, and re-arms for the ones whose has not.
 *
 * Health is a per-chat fact, not a competition between chats. This used to act only when
 * exactly one candidate existed, so the case it exists for — several workers losing the same
 * evidence path at once — was the one case it refused. Two silent mid-turn chats are not an
 * ambiguity to resolve, they are two broken chats. Each is judged on its own evidence and on its
 * own clock, and a chat that proves its join with an attributed call has already left the
 * incident by here.
 *
 * The incident outlives a pass that acted, for as long as a suspect remains. That is what lets a
 * chat which came under suspicion late be judged on its own time rather than swept along by
 * somebody else's deadline, and it is why the acting decision lives here rather than in a
 * one-shot the incident cannot survive.
 */
function tickUnattributedIncident(): void {
  const incident = unattributedIncident;
  if (!incident) return;
  if (incident.timer) clearTimeout(incident.timer);
  incident.timer = null;
  const now = Date.now();
  retireSpentRepairs();
  // Acting shrinks the set, and a smaller set is worth a shorter rung. Re-read it in this same
  // pass so the chats left behind are not held to a budget sized for company they no longer
  // have. Bounded: every turn of this loop takes at least one chat out of `pendingSuspects`.
  for (;;) {
    const suspects = pendingSuspects(incident, now);
    if (suspects.length === 0) {
      closeUnattributedIncident();
      return;
    }
    const rung = unattributedRung(suspects.length);
    let next: number | null = null;
    let acted = false;
    for (const target of suspects) {
      let seenAt = incident.seen.get(target.conversationId);
      if (seenAt === undefined) {
        seenAt = now;
        incident.seen.set(target.conversationId, seenAt);
      }
      const dueAt = Math.min(
        incident.due.get(target.conversationId) ?? Number.POSITIVE_INFINITY,
        seenAt + rung
      );
      incident.due.set(target.conversationId, dueAt);
      if (dueAt > now) {
        next = next === null ? dueAt : Math.min(next, dueAt);
        continue;
      }
      acted = true;
      // The browser owns the final open-vs-reload decision for both cases. It scans actual tabs at
      // action time, so a stale close event cannot open a duplicate and an open chat is reloaded
      // rather than copied. One queue is also what prevents an unattributed incident and an agent
      // silence incident from each performing their own recovery.
      if (
        queueBrowserRecovery(
          target.conversationId,
          target.sessionId,
          `unattributed:${target.endedTurns}`,
          'unattributed',
          target.endedTurns,
          now
        )
      ) {
        logInfo(`bridge: unattributed activity — asking the browser to reload ${target.conversationId}`);
        continue;
      }
      // Refused, and it will keep being refused: the chat is blocked, or a repair is already
      // running for it. Holding the incident open for a deadline nothing will act on would keep
      // every other suspect's rung pinned to a suspect that is no longer one.
      incident.dismissed.add(target.conversationId);
      incident.seen.delete(target.conversationId);
      incident.due.delete(target.conversationId);
    }
    if (acted) {
      // Reloads went out for these request ids. What arrives under them from here is the same
      // broken turn and buys nothing; the next request id is the next turn and buys its own.
      rememberUnattributedReload(incident);
      continue;
    }
    if (next === null) closeUnattributedIncident();
    else armUnattributedTick(incident, next - now);
    return;
  }
}

/**
 * The repair for the browser to carry out now, if there is one.
 *
 * A conversation to reload and the token that names this handout. Which tab that is, whether it
 * still exists, and whether there is exactly one of it are questions only the browser's own tab
 * registry can answer, and it answers them there.
 *
 * A maintenance pass that arrives without confirming the repair it was last handed *is* the
 * verdict on it. There is nothing else to wait for — the browser reports success in the same
 * breath as asking for more work — so an unconfirmed handout goes back in the queue and is
 * handed out again here. That is what keeps a repair the browser could not carry out from
 * being filed as one that worked.
 *
 * Every due repair goes out together, because the pass they wait for is the browser's alarm and
 * that alarm has a thirty-second floor it cannot beat. Handing out one at a time turned three
 * chats broken in the same instant into three reloads a minute apart, which is a queueing
 * artefact rather than anything this app decided.
 */
async function takePendingRepairs(
  now = Date.now()
): Promise<Array<{ conversationId: string; token: string; reason: Repair['reason']; focus: boolean }>> {
  retireSpentRepairs();
  // The queue can outlive the decision that filled it: a repair queued a minute before the user
  // pressed Block would otherwise still be handed to the browser, and the block's whole promise
  // is that nothing this app does touches that chat again. Dropping it here rather than at block
  // time keeps one gate instead of two, and it covers a handout already in flight the same way —
  // its receipt names a token nothing is waiting on any more and closes nothing.
  for (const [conversationId, repair] of [...repairsInFlight]) {
    const session = await getSession(repair.sessionId);
    const superseded = await conversationWasSuperseded(conversationId);
    if (!isChatBlocked(conversationId) && !superseded && session?.conversationId === conversationId) continue;
    repairsInFlight.delete(conversationId);
    turnRepairSpent.delete(conversationId);
    const grant = activeUntil.get(conversationId);
    if (grant?.sessionId === repair.sessionId) activeUntil.delete(conversationId);
    forgetGoalWatch(conversationId);
    compactionWatch.delete(conversationId);
    armSilenceSweep();
    logInfo(
      `bridge: ${conversationId} has no current browser-recovery authority — dropping its queued repair`
    );
  }
  // A handout the browser did not confirm goes back at the *end* of the queue. Re-queueing it
  // in place let the first entry win every pass, so one repair the browser could not carry out
  // starved every other chat behind it — precisely when several chats break at once.
  for (const [conversationId, repair] of [...repairsInFlight]) {
    if (repair.state !== 'handed') continue;
    repair.state = 'queued';
    repairsInFlight.delete(conversationId);
    repairsInFlight.set(conversationId, repair);
  }
  const ready: Array<{
    conversationId: string;
    token: string;
    reason: Repair['reason'];
    /** Raise the tab (or open the chat in front) before acting: a background tab is throttled. */
    focus: boolean;
  }> = [];
  for (const [conversationId, repair] of repairsInFlight) {
    if (repair.state !== 'queued') continue;
    if (now < repair.notBefore) continue;
    repair.state = 'handed';
    // A fresh token every time it goes out. A handout that was not carried out is dead the
    // moment it is re-queued, so a receipt that arrives for it later cannot close anything.
    repair.token = randomBytes(9).toString('base64url');
    await updateRepairProgress(
      conversationId,
      repair,
      `Trying to reload chat to recover ${repairReason(repair)}…`
    );
    ready.push({ conversationId, token: repair.token, reason: repair.reason, focus: repair.reason === 'compaction' });
  }
  return ready;
}

/**
 * That repair actually happened: this exact chat's tab reloaded.
 *
 * The token, not the conversation, is what is answered here. A receipt that names a handout
 * this app is no longer waiting on - an older turn's, or one already re-queued - matches
 * nothing and closes nothing, which is the only safe reading of it.
 */
async function confirmRepair(token: string, action: 'reloaded' | 'reopened' | null): Promise<void> {
  for (const [conversationId, repair] of repairsInFlight) {
    if (repair.state === 'handed' && repair.token === token) {
      repair.state = 'done';
      lastBrowserRecoveryAt.set(conversationId, Date.now());
      awaitingReturn.add(conversationId);
      if (repair.reason === 'silence') {
        // The reload is the chat's chance, so the verdict on it waits — not the next maintenance
        // pass. A model writing a long answer makes no durable progress until the answer lands;
        // judging the reload on the pass right after it is how worker-2 was slept 27 seconds
        // after its reload on 2026-09-02, its prime told to wake it, a wake typed into a chat
        // still generating, and the answer arriving four minutes later as if nothing had
        // happened. A worker gets the full two minutes again. A Goal/Loop chat gets one: it is
        // not going to be slept but written to, and a minute of nothing after a fresh page is
        // the loop's cue to write — see fileSilenceGoalTickets.
        grantActivity(
          conversationId,
          repair.sessionId,
          Date.now(),
          goalActiveFor(conversationId) ? GOAL_SILENCE_LISTEN_MS : CHAT_SILENCE_MS
        );
      }
      if (repair.reason === 'assistant-error') {
        // Charged to the turn the chat is on when the reload lands, running or not, and
        // released when it is on another one — see turnRepairSpent.
        const live = liveConversations().find((entry) => entry.conversationId === conversationId);
        turnRepairSpent.set(conversationId, { sessionId: repair.sessionId, turnKey: turnKeyFor(live) });
      }
      await updateRepairProgress(
        conversationId,
        repair,
        `${action === 'reopened' ? 'Reopened' : 'Reloaded'} chat to recover ${repairReason(repair)}.`
      );
      return;
    }
  }
}

/** An exact browser action failed; keep the episode queued and replace its one debug row. */
async function failRepairAttempt(token: string, action: 'reloaded' | 'reopened' | null): Promise<void> {
  for (const [conversationId, repair] of repairsInFlight) {
    if (repair.state !== 'handed' || repair.token !== token) continue;
    await updateRepairProgress(
      conversationId,
      repair,
      `${action === 'reopened' ? 'Reopen' : 'Reload'} failed while recovering ${repairReason(repair)}; will retry.`
    );
    repair.state = 'queued';
    repairsInFlight.delete(conversationId);
    repairsInFlight.set(conversationId, repair);
    return;
  }
}

function repairReason(repair: Repair): string {
  return {
    unattributed: 'missing connector attribution',
    'assistant-error': 'an interrupted response',
    'no-tab': 'a missing browser tab',
    silence: 'an unresponsive open turn',
    goal: 'a goal reply nothing collected',
    compaction: 'an uncollected compaction ticket'
  }[repair.reason];
}

/** Updates the repair's one app-owned timeline row, preserving its first position. */
async function updateRepairProgress(conversationId: string, repair: Repair, text: string): Promise<void> {
  if (repair.progress?.text === text) return;
  const sessionId =
    repair.progress?.sessionId ??
    (
      await findSessionByConversation(conversationId, {
        requireUnique: true
      }).catch(() => null)
    )?.id;
  if (!sessionId) return;
  const anchor = repair.progress ? { seq: repair.progress.seq, time: repair.progress.time } : undefined;
  // The turn this reload is about, read once when the row is first written and kept for every
  // rewrite of it. A reload of an open turn — an interrupted answer, a call the app could not
  // attribute, a silent turn — is part of that turn's story, so the row names the turn and the
  // page paints it inside the turn's Overwrite list, in order, like the tool calls around it
  // (the user's ask of 2026-09-02). A reload with no turn open — a Goal reply nothing came to
  // collect, a missing tab — names none and is placed between turns.
  const turnId =
    repair.progress?.turnId ??
    liveConversations().find((entry) => entry.conversationId === conversationId)?.activeTurnId ??
    null;
  const recorded = await recordProgress(sessionId, repair.progressId, text, anchor, turnId);
  if (recorded) repair.progress = { sessionId, ...recorded, text, turnId };
}

/**
 * Ends the incident and nothing else.
 *
 * Deliberately separate from `clearUnattributedIncident`, which is a teardown: an incident that
 * has finished deciding must not take the repairs it just queued down with it.
 */
function closeUnattributedIncident(): void {
  if (unattributedIncident?.timer) clearTimeout(unattributedIncident.timer);
  unattributedIncident = null;
}

function clearUnattributedIncident(): void {
  closeUnattributedIncident();
  repairsInFlight.clear();
  lastBrowserRecoveryAt.clear();
  turnRepairSpent.clear();
}

/**
 * Sends the next queued bootstrap to the browser, now. The only way one is ever delivered.
 *
 * This is the whole answer to "the fresh chat opened five minutes late, or only once I
 * happened to open ChatGPT again". Delivery used to be pull-only: the app queued a command
 * and waited for some ChatGPT tab's content script to poll for it, which meant a browser
 * with no ChatGPT tab open — or no browser at all — was a queue that nothing drained, and
 * which tab picked the job up was whichever one happened to ask. Fresh worker/resume commands
 * still open a new composer directly. A revival is different: it names an existing conversation,
 * so the extension owns its fresh scan -> existing tab -> proven-broken/absent new tab decision.
 *
 * The poll route is gone with it, and so is the recovery it offered. One press opens one
 * chat; if that does not work, it fails and says so, rather than leaving a job in a queue
 * for a tab that may open in an hour.
 */
async function deliver(): Promise<void> {
  try {
    await deliverOne();
  } catch (err) {
    logWarn(`bridge command delivery failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function deliverOne(): Promise<void> {
  tidyCommands();
  const command = nextDeliverable();
  if (!command) return;
  if (!openInBrowser) {
    // Nothing can open a browser in this process, and nothing will come and ask. Ending it
    // here is what keeps the failure honest: the continuation stays in the chat it is in and
    // the worker slot fails, instead of a job sitting in a queue that has no reader.
    drop(command, 'this app has no way to open a browser window');
    return;
  }
  // A cold start already under way is the browser this command is going to be opened in. Asking
  // the operating system for a second one does not join it — it starts a second browser — so
  // this waits for the first rather than adding to it. Deliberately before the lease: a command
  // that has not been handed to anything must not be spending its ninety seconds here.
  if (browserLaunchPending()) {
    deliverAfterLaunchWindow();
    return;
  }
  const claimedAt = Date.now();
  if (!(await persistCommandLease(command, null, claimedAt))) return;
  armDeadline(command);
  changed();
  // The recorder can see a brand-new ChatGPT conversation before that page's content script has
  // redeemed this command. Arm the session-transfer gate before the browser gets any chance to
  // create B, otherwise that early observation invents a shadow session for B and the real A→B
  // commit quite correctly refuses to overwrite it. The later durable redeem refreshes the same
  // gate; commit/abort/drop clears it through the continuation state machine.
  if (command.spec.type === 'resume') noteResumeOpening(command.spec.token);
  // Beside the chat it succeeds, when this app can name that chat and its browser is still
  // polling. Only that browser can put the new tab in the window the old one is in, and only
  // a tab it creates itself is guaranteed to be in a browser this extension is loaded in.
  if (offerPlacement(command)) return;
  await openFreshChatInBrowser(command);
}

/**
 * Asks the operating system for a fresh ChatGPT chat, when no home page can place it.
 *
 * The original delivery path, unchanged, and still the only one available when the home chat's
 * tab is gone or the browser is closed — opening the URL is what starts a browser that is not
 * running. It is also the fallback for an offer nobody collected, which is why it is reachable
 * from the placement timer as well as from delivery.
 */
async function openFreshChatInBrowser(command: Command): Promise<void> {
  if (!openInBrowser) {
    drop(command, 'this app has no way to open a browser window');
    return;
  }
  logInfo(`bridge: opening a fresh ChatGPT chat for ${specKey(command.spec)}`);
  try {
    // Stamped whether or not a browser was already running: this process cannot tell the
    // difference, and the window it opens is only ever spent by a browser failing to appear.
    if (!browserPresent()) lastBrowserLaunchAt = Date.now();
    await openInBrowser(commandUrl(command.id));
  } catch (err) {
    // One command is one browser-open attempt. A rejected opener can never produce an ACK,
    // so leaving the row unleased merely blocks everything behind it until some unrelated
    // future action calls deliver() again. End it honestly and immediately, then advance.
    const why = `the browser could not be opened (${err instanceof Error ? err.message : String(err)})`;
    command.lastError = why;
    drop(command, why);
    await deliver();
  }
}

/**
 * Arms the one-shot that ends this command if its deadline passes.
 *
 * The whole clock of the delivery path. Unref'd, so a pending bootstrap can never hold
 * the app (or a test run) open, and disarmed by `retire()` on every path that finishes a
 * command — so a command that succeeds costs one cleared timer and nothing else.
 */
function revivalDeliveryProven(command: Command): boolean {
  return (
    command.spec.type === 'revive' &&
    command.claimedAt !== null &&
    workerRevivalDeliveredSince(
      command.spec.agent,
      command.spec.conversationId,
      command.id,
      command.claimedAt
    )
  );
}

/**
 * When this revival stops being a wake attempt. Absolute from the wake, never renewed by a
 * redeem, so a page that never types cannot keep a worker `waking` forever; a proven
 * delivery moves it to the longer budget and nothing else does.
 */
function revivalDeadlineAt(command: Command): number {
  return command.createdAt + (revivalDeliveryProven(command) ? REVIVAL_ACTIVITY_MS : REVIVAL_DEADLINE_MS);
}

function commandDeadlineDelay(command: Command, now = Date.now()): number {
  if (command.spec.type === 'revive') return revivalDeadlineAt(command) - now;
  if (command.spec.type === 'resume' && continuationByToken(command.spec.token)?.automatic) {
    // One checkpoint, not a failure trigger. Expiry releases only this browser transport;
    // the auto-compaction ticket remains and the next 15-minute pickup may open it again.
    return (command.claimedAt ?? command.createdAt) + COMPACTION_PICKUPS.opening.every - now;
  }
  if (command.spec.type === 'resume' && command.owner !== null) {
    const continuation = continuationByToken(command.spec.token);
    if (continuation?.state === 'claimed') return continuation.openedAt + CONTINUATION_TTL_MS - now;
  }
  if (command.spec.type === 'worker') {
    // Absolute, from the invitation. Whatever else this command is waiting for, the slot it
    // holds stops being `invited` by this instant. A command still in line has no clock of its
    // own: every ending of the command ahead of it calls deliver(), and this limit is the fence.
    const limit = command.createdAt + WORKER_BOOTSTRAP_LIMIT_MS;
    if (command.claimedAt === null) return limit - now;
    // Opened but not yet redeemed: the page's round trip, not its typing budget. A browser this
    // app had to start is given its launch window on top, since nothing can redeem before it is up.
    if (command.owner === null) {
      const redeemBy = Math.max(command.claimedAt + WORKER_REDEEM_MS, lastBrowserLaunchAt + BROWSER_LAUNCH_GRACE_MS);
      return Math.min(redeemBy, limit) - now;
    }
    return Math.min(command.claimedAt + COMMAND_DEADLINE_MS, limit) - now;
  }
  const claimedAt = command.claimedAt ?? now;
  return claimedAt + COMMAND_DEADLINE_MS - now;
}

function armDeadline(command: Command, delay = commandDeadlineDelay(command)): void {
  if (command.timer) clearTimeout(command.timer);
  command.timer = setTimeout(() => {
    command.timer = null;
    expire(command);
  }, Math.max(1, delay));
  command.timer.unref?.();
}

/** Re-arms leased commands whose timers were intentionally cleared by stopBridge(). */
function rearmRetainedCommandDeadlines(): void {
  const now = Date.now();
  const expired: Command[] = [];
  for (const command of commands) {
    // Worker bootstraps join revivals in being clocked before anyone claims them: their limit is
    // absolute from the invitation, so a restart must not hand a restored one an unbounded wait.
    const automaticResume =
      command.spec.type === 'resume' && continuationByToken(command.spec.token)?.automatic === true;
    if (
      (command.claimedAt === null && command.spec.type !== 'revive' && command.spec.type !== 'worker' && !automaticResume) ||
      command.timer
    )
      continue;
    const remaining = commandDeadlineDelay(command, now);
    if (remaining > 0) armDeadline(command, remaining);
    else expired.push(command);
  }
  for (const command of expired) expire(command);
}

/**
 * The deadline passed. Decide what actually happened, then end it either way.
 *
 * Two ordinary outcomes are quiet successes that simply have no acknowledgement of
 * their own: a worker whose chat was bound is done being a command, and a command already
 * gone has nothing left to end. The third is the failure this design chose over retrying —
 * the tab never redeemed, or redeemed and never typed, or typed into a chat it never named
 * — and `drop()` is what makes it safe: a manual continuation is aborted and its session stays
 * where it is, or the worker slot is failed so the prime stops waiting on a chat that does
 * not exist. An automatic continuation is the deliberate exception: only its expired browser
 * transport is released, leaving the ticket for its next 15-minute pickup.
 */
function expire(command: Command): void {
  if (!commands.includes(command)) return;
  const spec = command.spec;
  // A wake's deadline moves once when its delivery is proven, and the timer armed at the wake
  // does not know that. Re-arm for the remainder rather than end a worker that is reading.
  if (spec.type === 'revive') {
    const remaining = commandDeadlineDelay(command);
    if (remaining > 0) {
      armDeadline(command, remaining);
      return;
    }
  }
  if (spec.type === 'resume') {
    const continuation = continuationByToken(spec.token);
    if (continuation?.state === 'committed' && continuation.to) {
      const receipt: CommandReceipt = {
        id: command.id,
        client: command.owner,
        conversationId: continuation.to,
        outcome: 'committed',
        committed: true,
        error: null,
        completedAt: Date.now()
      };
      void finalizeCommand(command, receipt).then((stored) => {
        if (stored) deliver();
        else if (commands.includes(command)) armDeadline(command, 5_000);
      });
      return;
    }
    if (continuation?.state === 'committing') {
      // Deadline is a waiting-state policy, not permission to cancel a non-abortable WAL
      // commit. Recheck shortly; restore/commit will either publish committed or roll back to
      // a claimable state that a later expiry can honestly abort.
      armDeadline(command, 1_000);
      return;
    }
  }
  if (spec.type === 'worker' && !pendingWorkerSpawns().some((worker) => worker.id === spec.agent)) {
    retire(command, 'its worker is bound and running');
    return;
  }
  // The chat opened for it never redeemed the marker. Open it once more, once: the command is
  // single-owner, so the page that does redeem is the only one that ever types.
  if (
    spec.type === 'worker' &&
    command.claimedAt !== null &&
    command.owner === null &&
    command.retriedAt === null &&
    Date.now() < command.createdAt + WORKER_BOOTSTRAP_LIMIT_MS
  ) {
    command.retriedAt = Date.now();
    logWarn(`bridge: the chat opened for ${specKey(spec)} never picked up its instruction — opening it once more`);
    void reopenWorkerChat(command);
    return;
  }
  if (spec.type === 'revive' && !revivalFor(spec.agent)) {
    retire(command, 'its worker is no longer waiting to be woken');
    return;
  }
  drop(command, command.lastError ?? 'the chat this app opened did not report back in time');
  deliver();
}

/**
 * The one re-open of a worker chat that opened and never redeemed.
 *
 * A fresh lease first, so the redeem window and the durable record both restart from this
 * open; a lease that cannot be written ends the command instead, exactly as a first delivery
 * would. Straight to the OS opener rather than the placement offer: the home page already had
 * its chance to place this one.
 */
async function reopenWorkerChat(command: Command): Promise<void> {
  if (!(await persistCommandLease(command, null, Date.now()))) {
    if (commands.includes(command)) {
      drop(command, 'the chat this app opened did not report back in time');
      await deliver();
    }
    return;
  }
  armDeadline(command);
  changed();
  await openFreshChatInBrowser(command);
}

/** Finishes a command that has nothing left to do, timer and all. */
function retire(command: Command, why: string): void {
  if (command.timer) clearTimeout(command.timer);
  command.timer = null;
  // A standing placement offer belongs to this command alone. Handout already re-checks that
  // the command is still queued, so this is not what makes a retired offer inert — it is what
  // stops the fifteen-second fallback outliving the thing it was covering for.
  if (placementOffer?.id === command.id) clearPlacementOffer();
  if (!commands.includes(command)) return;
  commands = commands.filter((entry) => entry !== command);
  logInfo(`bridge: ${specKey(command.spec)} is done — ${why}`);
  changed();
  persistCommands();
  // The line has to move. Only `drop()`'s callers used to do this, so a bootstrap that ended by
  // being retired — its worker bound through the lost-ACK path in `/events`, say — left every
  // command behind it unleased and clockless until something unrelated called deliver() again.
  // A worker observed sitting `invited` for nine minutes, holding the last slot, is that bug.
  // Deferred by a microtask because `deliverOne()` tidies before it picks, so this can be
  // reached from inside a delivery that is still choosing.
  scheduleDeliver();
}

let deliverScheduled = false;

/** One deferred `deliver()`, coalesced, safe to call from anywhere that finishes a command. */
function scheduleDeliver(): void {
  if (deliverScheduled) return;
  deliverScheduled = true;
  queueMicrotask(() => {
    deliverScheduled = false;
    void deliver();
  });
}

/**
 * The text the extension types, built fresh for each attempt.
 *
 * A resume is handed the brief itself, as an ordinary first message. There is no tool call
 * to make, no handoff id to quote and no handshake to get wrong: the model in the new chat
 * reads what the model in the old chat wrote, which is the only thing the brief was ever
 * for. Everything the *app* needs to carry across — the session, its history, its workspace,
 * its swarm — travels through the rebind instead, and none of it depends on the model doing
 * anything at all.
 */
function bootstrapText(spec: CommandSpec, summary: string): string {
  if (spec.type === 'revive') {
    // Written by the broker, out of that worker's own inbox, at the moment the page asks.
    // Empty means the broker no longer considers this worker to be waking, and an empty
    // message is never typed: the redeem route turns that into a stale marker instead.
    return revivalFor(spec.agent)?.text ?? '';
  }
  if (spec.type === 'worker') {
    // The brief, then the shortest protocol that still routes: who you are, where reports go,
    // and that other workers are not reachable. Nothing about identity beyond the name,
    // because there is nothing for the model to do about it — this chat was opened for a
    // worker slot and is bound to it by the extension's report before this text is read.
    //
    // It is short on purpose, and the purpose is not tokens. This paragraph is the first user
    // message in a brand-new ChatGPT conversation, and a long block of scaffolding about
    // agents and swarms in that position is exactly the shape ChatGPT's own abuse heuristics
    // score. A model does not need five sentences to learn a two-verb protocol.
    //
    // The last word is `ultrathink`, and it is one word for the same reason. A worker is the
    // one agent here that gets a task with no conversation in front of it and no chance to
    // ask a clarifying question, so the one thing worth spending a token on is asking it to
    // think before it starts.
    return (
      `${spec.task}\n\n` +
      `(Chat On Steroids: you are ${spec.agent}, a worker. Report to prime through the agents tool — ` +
      'action=message to="prime" as you go, action=finish once at the end. Workers cannot reach each other. ' +
      'ultrathink)'
    );
  }
  return resumeBootstrapText(summary, spec.token);
}

/** The broker's current plan for waking one worker, or null once it is no longer waking. */
function revivalFor(agent: string): WorkerRevival | null {
  return pendingWorkerRevivals().find((revival) => revival.id === agent) ?? null;
}

/**
 * The wire form of a command, and — for a resume — the moment its brief is claimed.
 *
 * Claiming here rather than at queue time is what makes the transaction's one-claim rule
 * mean something: the claimant is the page that redeemed the marker, so that page's own
 * retries are the same claim while a second page is refused — by the redeem route before it
 * gets here, and by the transaction itself if it somehow does. A continuation that can no
 * longer be claimed yields no text, and the command carries nothing to type.
 */
function describe(command: Command, client: string | null, claimedSummary?: string): BridgeCommand {
  const spec = command.spec;
  // A resume's claim is persisted by /commands/redeem before this renderer is called. A
  // command shown to app/UI code without a browser document still carries no brief at all.
  const text = spec.type === 'resume'
    ? client && claimedSummary !== undefined
      ? bootstrapText(spec, claimedSummary)
      : ''
    : bootstrapText(spec, '');
  return {
    id: command.id,
    kind: 'open-chat',
    type: spec.type,
    text,
    agent: spec.type === 'resume' ? null : spec.agent,
    // The fence the page enforces before it types. Only a revival has one: the other two
    // kinds open a chat that does not exist yet, so there is nothing to compare against.
    conversationId: spec.type === 'revive' ? spec.conversationId : null
  };
}

function drop(command: Command, why: string): boolean {
  if (!commands.includes(command)) return false;
  const automaticEntry = command.spec.type === 'resume' ? continuationByToken(command.spec.token) : null;
  const automaticResume =
    automaticEntry?.automatic === true && automaticEntry.state !== 'committing' && automaticEntry.state !== 'committed';
  if (automaticResume) {
    if (command.timer) clearTimeout(command.timer);
    command.timer = null;
    commands = commands.filter((entry) => entry !== command);
    logWarn(`bridge: released ${specKey(command.spec)} browser attempt without closing its ticket — ${why}`);
    changed();
    persistCommands();
    scheduleDeliver();
    return true;
  }
  const needsBrokerFence = command.spec.type === 'worker' || command.spec.type === 'revive';
  if (needsBrokerFence) commandRetirementsAwaitingBroker.set(command.id, command);
  // A resume whose replacement chat never opened has to end its transaction too, or the
  // session sits "opening" forever with nothing coming. Aborting leaves the session
  // attached to the chat it is already in, which is the safe side of this failure.
  if (command.spec.type === 'resume') {
    const before = continuationByToken(command.spec.token);
    const aborted = before ? abortContinuation(command.spec.token, why) : false;
    const after = continuationByToken(command.spec.token);
    if (!aborted && (after?.state === 'committing' || after?.state === 'committed')) {
      logWarn(`bridge: ${specKey(command.spec)} could not be cancelled after its commit boundary — ${why}`);
      return false;
    }
  }
  if (command.timer) clearTimeout(command.timer);
  command.timer = null;
  commands = commands.filter((entry) => entry !== command);
  // Giving up on a worker's chat has to end the worker, not just the command. Deleting
  // the command alone left the slot `invited` for good: it counted towards the worker
  // limit, it held the one in-flight agent-bearing bootstrap so the next worker never
  // opened, it kept the run looking alive to takeover, and the prime went on waiting for
  // a report from a chat that does not exist.
  if (command.spec.type === 'worker') failAgent(command.spec.agent, why);
  // A revival that never happened is not a worker that failed. Nothing was typed into its
  // chat, so it goes back to sleeping with its inbox intact and its slot released, and the
  // prime is told the message it sent is still waiting to be delivered.
  if (command.spec.type === 'revive') failWorkerRevival(command.spec.agent, why);
  logWarn(`bridge: gave up on ${specKey(command.spec)} — ${why}`);
  changed();
  persistCommands();
  // A timeout is another last-slot transition with no future MCP epilogue guaranteed. Once the
  // command is no longer deliverable, let the broker release/park the active incarnation if
  // every worker is now stopped. Any sibling bootstrap/revival still in flight occupies a slot
  // and makes this a no-op.
  releaseQuiescentRun();
  if (needsBrokerFence) {
    void persistCriticalSwarmNow()
      .then((durable) => {
        if (!durable) {
          logWarn(
            `bridge: kept retired ${specKey(command.spec)} durable because its broker transition had no immediate persistence sink`
          );
          return;
        }
        if (commandRetirementsAwaitingBroker.delete(command.id)) persistCommands();
      })
      .catch((err) => {
        logWarn(
          `bridge: kept retired ${specKey(command.spec)} durable because its broker transition could not be persisted — ${err instanceof Error ? err.message : String(err)}`
        );
      });
  }
  // Deliberately no deliver() here: a drop is always either inside a deliver() already or
  // immediately followed by one (queue() overflow, whose two callers both deliver on the
  // next line), and the next command — usually the worker that was queued behind this one
  // — is picked up by the nextDeliverable() that follows the tidy pass. Calling deliver()
  // from here would reenter it mid-pass instead.
  return true;
}

/**
 * Retires and expires commands. Run before anything is handed out or delivered.
 */
function tidyCommands(): void {
  const now = Date.now();
  const runId = currentRunId();
  const pendingWorkers = new Set(pendingWorkerSpawns().map((worker) => worker.id));
  const wakingWorkers = new Set(pendingWorkerRevivals().map((revival) => revival.id));
  for (const command of [...commands]) {
    const workerAgent = command.spec.type === 'worker' ? command.spec.agent : null;
    if (command.spec.type !== 'resume' && command.spec.runId !== runId) {
      // Run turnover is an identity boundary. A command from the retired incarnation is not
      // evidence that the same friendly worker id in the current run is already opening.
      retire(command, `its worker run ${command.spec.runId} is no longer current`);
      continue;
    }
    if (command.spec.type === 'revive' && !wakingWorkers.has(command.spec.agent)) {
      // The slot stopped waking while this waited: the worker called in by itself, the prime's
      // send rolled back, or the run cleared it. Retiring rather than dropping is deliberate —
      // whatever ended the reservation has already put the worker somewhere it belongs, and
      // failWorkerRevival() on top of that would report a failure that did not happen.
      retire(command, 'its worker is no longer waiting to be woken');
      continue;
    }
    if (workerAgent && !pendingWorkers.has(workerAgent)) {
      // The slot was bound (or the run ended) since this was queued, so there is nothing
      // left for a chat to be opened for.
      retire(command, 'its worker is bound and running');
      continue;
    }
    const automaticResume =
      command.spec.type === 'resume' && continuationByToken(command.spec.token)?.automatic === true;
    const stale = command.spec.type === 'revive'
      ? now >= revivalDeadlineAt(command)
      : !automaticResume && now - command.createdAt > COMMAND_TTL_MS;
    if (stale) {
      drop(command, 'it has been waiting too long to still be what the user expects');
    }
  }
}

/** Whether a page is already working on this command, with time still on its deadline. */
const isLeased = (command: Command): boolean => {
  if (command.claimedAt === null) return false;
  if (commandDeadlineDelay(command) > 0) return true;
  if (command.spec.type !== 'resume') return false;
  const state = continuationByToken(command.spec.token)?.state;
  return state === 'committing' || state === 'committed';
};

/**
 * The one command that may go to the browser right now, or null.
 *
 * One at a time, whatever kind it is. The browser half can only be opening one tab anyway,
 * and a worker chat is identified by the extension reporting which tab it opened for which
 * slot — so two bootstraps in flight is precisely the state where that report can be made
 * about the wrong tab.
 */
function nextDeliverable(): Command | null {
  if (commandLeaseWrites.size > 0) return null;
  // Revivals never enter the app's browser opener: only the extension can know whether the exact
  // conversation is already open. They also must not block unrelated fresh worker/resume tabs.
  if (commands.some((command) => command.spec.type !== 'revive' && isLeased(command))) return null;
  return commands.find((command) => command.spec.type !== 'revive') ?? null;
}

/**
 * What a page reports about the one command it was opened for.
 *
 * Two outcomes, both final. There was a third — `working`, sent from a periodic tick while
 * the page was still typing — and it existed to push the deadline out; it is gone with the
 * ticker that sent it. A bootstrap now either lands inside its one deadline or fails, and
 * failing is an ending rather than a pause: this app opens exactly one chat per press, and
 * a chat that could not be started is reported rather than quietly retried into existence
 * minutes later.
 */
type AckStatus = 'sent' | 'failed';

/** What a queued command says the chat it opened is for. Null once the command is gone. */
function commandOrigin(id: string): SessionOrigin | null {
  const spec = commands.find((entry) => entry.id === id)?.spec;
  if (!spec) return null;
  if (spec.type === 'worker')
    return {
      kind: 'worker',
      fromSessionId: null,
      agentId: spec.agent,
      task: spec.task
    };
  // A revival opens no chat, so it names none. The conversation it lands in was recorded as a
  // worker chat when it was first opened, and rewriting that origin now would only overwrite
  // the task this worker was actually created for with whatever it is being asked next.
  if (spec.type === 'revive') return null;
  return {
    kind: 'resume',
    fromSessionId: spec.sessionId,
    agentId: null,
    task: ''
  };
}

/**
 * Withdraws queued worker chats, immediately.
 *
 * Cancellation has to reach the browser in the same beat as the app: the queue is
 * emptied here, and the next /commands poll tells the extension which ids are still
 * alive so a tab it is already holding a bootstrap for is dropped rather than opened.
 *
 * With `agent`, only that worker's bootstrap is withdrawn. Clearing one slot must not
 * take the queued tabs of its siblings with it — the whole-run form is what `onSwarmEnd`
 * uses, and pointing it at a single agent is what makes a per-worker clear safe.
 */
export function cancelWorkerCommands(reason: string, agent?: string): number {
  const doomed = commands.filter(
    (command) =>
      (command.spec.type === 'worker' || command.spec.type === 'revive') &&
      (agent === undefined || command.spec.agent === agent)
  );
  if (doomed.length === 0) return 0;
  const dead = new Set(doomed.map((command) => command.id));
  commands = commands.filter((command) => !dead.has(command.id));
  const what = agent === undefined ? 'worker chat(s)' : `worker chat(s) for ${agent}`;
  logInfo(`bridge: cancelled ${doomed.length} queued ${what} — ${reason}`);
  changed();
  persistCommands();
  // No deliver() here on purpose. drop() reaches this path from inside a delivery and
  // documents that its callers are already in one; the next poll picks up whatever was
  // queued behind the cancelled command.
  return doomed.length;
}

/** What the UI shows about work waiting on the browser. */
export function pendingCommands(): Array<{
  id: string;
  what: string;
  lastError: string | null;
}> {
  return commands.map((command) => ({
    id: command.id,
    what: specKey(command.spec),
    lastError: command.lastError
  }));
}

interface CommandRestorePlan {
  /** Complete post-recovery command set. Nothing here is published until reconciliation ends. */
  commands: Command[];
  /** Complete post-recovery receipt set, already TTL-pruned and de-duplicated. */
  receipts: CommandReceipt[];
  /** Expired durable wake halves whose separately durable broker reservation must be settled first. */
  expiredRevivals: Array<{
    id: string;
    spec: Extract<CommandSpec, { type: 'revive' }>;
  }>;
  /** Resume tokens discovered in the durable command file, published only with the plan. */
  resumeTokens: Array<{ sessionId: string; token: string }>;
  /** Number of durable commands newly reconstructed rather than retained from this process. */
  restored: number;
}

/** One durable receipt that is still useful, rebuilt field-by-field. */
function restoredReceipt(raw: Partial<CommandReceipt>, now: number): CommandReceipt | null {
  if (
    typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 64 ||
    (raw.client !== null && raw.client !== undefined && (typeof raw.client !== 'string' || raw.client.length > 64)) ||
    (raw.conversationId !== null && raw.conversationId !== undefined && typeof raw.conversationId !== 'string') ||
    (raw.outcome !== 'committed' && raw.outcome !== 'terminal-failure') ||
    typeof raw.committed !== 'boolean' ||
    !Number.isFinite(raw.completedAt) ||
    now - Number(raw.completedAt) > COMMAND_TTL_MS ||
    (raw.outcome === 'committed') !== raw.committed
  ) {
    return null;
  }
  return {
    id: raw.id,
    client: typeof raw.client === 'string' ? raw.client : null,
    conversationId: typeof raw.conversationId === 'string' ? raw.conversationId : null,
    outcome: raw.outcome,
    committed: raw.committed,
    error: typeof raw.error === 'string' ? raw.error.slice(0, 200) : null,
    completedAt: Number(raw.completedAt)
  };
}

/**
 * Rebuilds one command spec against current durable authority.
 *
 * Worker/revival rows are scoped to the exact restored run. Resume rows are scoped by the
 * continuation WAL. Returning null is therefore a retirement decision, not a parse fallback.
 */
function restoredCommandSpec(version: number, raw: Partial<CommandSpec>): CommandSpec | null {
  if (
    version >= 3 &&
    raw.type === 'worker' &&
    typeof (raw as Partial<Extract<CommandSpec, { type: 'worker' }>>).agent === 'string' &&
    /^[a-z0-9-]{1,40}$/i.test((raw as Extract<CommandSpec, { type: 'worker' }>).agent) &&
    typeof (raw as Partial<Extract<CommandSpec, { type: 'worker' }>>).task === 'string' &&
    typeof (raw as Partial<Extract<CommandSpec, { type: 'worker' }>>).runId === 'string'
  ) {
    const worker = raw as Extract<CommandSpec, { type: 'worker' }>;
    if (worker.runId !== currentRunId()) return null;
    // A retained transport may deliberately outlive its live queue entry while broker failure
    // is being fsynced. If restart sees the *newer* broker side first, a terminal/sleeping row is
    // proof this old bootstrap must not be resurrected merely because its run id still matches a
    // sibling's active incarnation. `active` remains valid for the lost-ACK case: the binding may
    // already be durable while the leased browser command is still waiting for its retry.
    const workerState = swarmState().agents.find((entry) => entry.id === worker.agent && entry.role === 'worker')?.state;
    if (workerState !== 'invited' && workerState !== 'active') return null;
    return { type: 'worker', agent: worker.agent, task: worker.task.slice(0, 512 * 1024), runId: worker.runId };
  }
  if (
    version >= 4 &&
    raw.type === 'revive' &&
    typeof (raw as Partial<Extract<CommandSpec, { type: 'revive' }>>).agent === 'string' &&
    /^[a-z0-9-]{1,40}$/i.test((raw as Extract<CommandSpec, { type: 'revive' }>).agent) &&
    typeof (raw as Partial<Extract<CommandSpec, { type: 'revive' }>>).conversationId === 'string' &&
    typeof (raw as Partial<Extract<CommandSpec, { type: 'revive' }>>).runId === 'string'
  ) {
    const revive = raw as Extract<CommandSpec, { type: 'revive' }>;
    if (revive.runId !== currentRunId()) return null;
    const revivalState = swarmState().agents.find((entry) => entry.id === revive.agent && entry.role === 'worker')?.state;
    if (revivalState !== 'waking' && revivalState !== 'active') return null;
    return {
      type: 'revive',
      agent: revive.agent,
      conversationId: revive.conversationId,
      runId: revive.runId,
      // A row written before wakes were named restores as the unnamed wake. The live broker
      // still holds the messages, so the next real wake for this worker supersedes it.
      wake: typeof revive.wake === 'string' ? revive.wake : ''
    };
  }
  if (
    raw.type === 'resume' &&
    typeof (raw as Partial<Extract<CommandSpec, { type: 'resume' }>>).sessionId === 'string' &&
    typeof (raw as Partial<Extract<CommandSpec, { type: 'resume' }>>).token === 'string'
  ) {
    const resume = raw as Extract<CommandSpec, { type: 'resume' }>;
    const continuation = continuationByToken(resume.token);
    if (!continuation || continuation.sessionId !== resume.sessionId || continuation.state === 'aborted') return null;
    return { type: 'resume', sessionId: resume.sessionId, token: resume.token };
  }
  return null;
}

/** Snapshot an explicit command set. Restore must never serialize the live globals mid-plan. */
function restoredCommandSnapshot(
  plannedCommands: readonly Command[],
  plannedReceipts: readonly CommandReceipt[],
  now: number
): DurableCommandSnapshot {
  return {
    version: 4,
    commands: plannedCommands.map(durableCommand),
    receipts: plannedReceipts
      .filter((receipt) => now - receipt.completedAt <= COMMAND_TTL_MS)
      .slice(-MAX_COMMAND_RECEIPTS)
  };
}

/**
 * Pure-with-respect-to-bridge-state reconstruction of the durable file.
 *
 * A settings stop/start deliberately retains in-memory commands; those are newer authority and
 * win every duplicate. Disk contributes only missing commands/receipts. Most importantly this
 * function never pushes into `commands`, arms a timer or publishes a receipt while later recovery
 * awaits can still fail.
 */
function planCommandRestore(
  saved: { version?: number; commands?: unknown; receipts?: unknown },
  now: number
): CommandRestorePlan | null {
  const version = saved.version;
  if (version !== 1 && version !== 2 && version !== 3 && version !== 4 || !Array.isArray(saved.commands)) return null;

  const plannedCommands = [...commands];
  const plannedReceipts = commandReceipts
    .filter((receipt) => now - receipt.completedAt <= COMMAND_TTL_MS)
    .slice(-MAX_COMMAND_RECEIPTS);
  const receiptIds = new Set(plannedReceipts.map((receipt) => receipt.id));
  if (version !== 1 && Array.isArray(saved.receipts)) {
    for (const raw of saved.receipts as Array<Partial<CommandReceipt>>) {
      const receipt = restoredReceipt(raw, now);
      if (!receipt || receiptIds.has(receipt.id)) continue;
      receiptIds.add(receipt.id);
      plannedReceipts.push(receipt);
    }
    if (plannedReceipts.length > MAX_COMMAND_RECEIPTS) {
      plannedReceipts.splice(0, plannedReceipts.length - MAX_COMMAND_RECEIPTS);
    }
  }

  const retainedKeys = new Set(plannedCommands.map((command) => commandKey(command.spec)));
  const expiredRevivals: Array<{
    id: string;
    spec: Extract<CommandSpec, { type: 'revive' }>;
  }> = [];
  const resumeTokens: Array<{ sessionId: string; token: string }> = plannedCommands
    .filter(
      (
        command
      ): command is Command & {
        spec: Extract<CommandSpec, { type: 'resume' }>;
      } => command.spec.type === 'resume'
    )
    .map((command) => ({
      sessionId: command.spec.sessionId,
      token: command.spec.token
    }));
  const durableCandidates = new Map<
    string,
    { raw: Partial<DurableCommandRecord>; spec: CommandSpec; createdAt: number }
  >();
  let restored = 0;

  for (const raw of saved.commands as Array<Partial<DurableCommandRecord>>) {
    const specRaw = raw.spec as Partial<CommandSpec> | undefined;
    if (!specRaw || typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 64) continue;
    const spec = restoredCommandSpec(version, specRaw);
    if (!spec) continue;
    const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0;
    const key = commandKey(spec);
    // In-memory state survived a settings stop/start and is newer authority than the disk
    // snapshot it produced. A stale old durable row for the same worker must never cancel or
    // replace that newer live transport merely because both have the same friendly key.
    if (retainedKeys.has(key) || receiptIds.has(raw.id)) continue;
    const prior = durableCandidates.get(key);
    // Corrupt/legacy files can contain two incarnations of one transport key. Pick authority
    // first, then apply TTL semantics to that one record only. Newer createdAt wins; a later
    // record wins a tie so reconstruction is deterministic for whole-file duplicates.
    if (!prior || createdAt >= prior.createdAt) durableCandidates.set(key, { raw, spec, createdAt });
  }

  for (const { raw, spec, createdAt } of durableCandidates.values()) {
    if (spec.type === 'resume') resumeTokens.push({ sessionId: spec.sessionId, token: spec.token });
    const persistedLeased = version !== 1 && raw.phase === 'leased';
    // The broker cannot yet say whether a restored wake was delivered, so disk rows get the
    // longer budget here; the deadline re-armed below applies the exact one.
    const stale = spec.type === 'revive'
      ? now - createdAt >= REVIVAL_ACTIVITY_MS
      : now - createdAt > COMMAND_TTL_MS;
    if (stale) {
      if (spec.type === 'revive') expiredRevivals.push({ id: raw.id!, spec });
      continue;
    }

    const continuation = spec.type === 'resume' ? continuationByToken(spec.token) : null;
    const legacyAlreadyClaimed =
      version === 1 && continuation !== null &&
      (continuation.state === 'claimed' || continuation.state === 'committing' || continuation.state === 'committed');
    const leased = persistedLeased || legacyAlreadyClaimed;
    let claimedAt = leased && typeof raw.claimedAt === 'number' && Number.isFinite(raw.claimedAt) ? raw.claimedAt : null;
    if (leased && claimedAt === null) claimedAt = now;
    if (claimedAt !== null && claimedAt > now + COMMAND_DEADLINE_MS) claimedAt = now;
    plannedCommands.push({
      id: raw.id!,
      spec,
      createdAt,
      claimedAt,
      retriedAt: null,
      timer: null,
      lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
      owner: leased && typeof raw.owner === 'string' ? raw.owner.slice(0, 64) : null
    });
    restored += 1;
  }

  // Retained commands normally win over disk, but the same absolute waking deadline still applies.
  // A newer retained revival is not touched by an older expired disk row because disk candidates
  // for its key were discarded above before expiry was considered.
  const expiredRetainedRevivalIds = new Set<string>();
  for (const command of plannedCommands) {
    if (command.spec.type !== 'revive' || now < revivalDeadlineAt(command)) continue;
    expiredRevivals.push({ id: command.id, spec: command.spec });
    expiredRetainedRevivalIds.add(command.id);
  }
  const commandsAfterExpiredRevival = plannedCommands.filter(
    (command) => !expiredRetainedRevivalIds.has(command.id)
  );

  return {
    commands: commandsAfterExpiredRevival,
    receipts: plannedReceipts.slice(-MAX_COMMAND_RECEIPTS),
    expiredRevivals,
    resumeTokens,
    restored
  };
}

/**
 * Reloads commands left over from a previous run.
 *
 * Ordinary commands older than the TTL are discarded rather than acted on: reopening the app
 * the next morning must not spray yesterday's chats across the browser. A revival is stricter:
 * after thirty seconds it releases the broker's `waking` reservation and the worker becomes
 * sleeping/revivable again. Version 2 persists the queued/leased phase and document owner; version
 * 1 is migrated conservatively, including resume commands whose continuation WAL survived.
 */
export async function restoreCommands(): Promise<void> {
  const saved = await readDurable<{
    version?: number;
    commands?: unknown;
    receipts?: unknown;
  }>(COMMANDS_STATE);
  if (!saved) return;
  const now = Date.now();
  const plan = planCommandRestore(saved, now);
  if (!plan) return;

  if (plan.expiredRevivals.length > 0) {
    let brokerRelevant = false;
    for (const expired of plan.expiredRevivals) {
      const revive = expired.spec;
      // Run id was already validated above. Check the exact conversation too so a stale command
      // for an earlier binding cannot knock down a newer wake for the same friendly worker id.
      // `brokerRelevant` deliberately survives a prior failed recovery attempt: that attempt may
      // already have moved the live worker back to sleeping while the durable swarm is still
      // waking. A later startup must fsync the *current* broker state before it may prune the old
      // command, even though pendingWorkerRevivals() no longer lists it.
      if (agentForConversation(revive.conversationId) !== revive.agent) continue;
      brokerRelevant = true;
      const owed = pendingWorkerRevivals().find(
        (entry) => entry.id === revive.agent && entry.conversationId === revive.conversationId
      );
      if (!owed) continue;
      failWorkerRevival(revive.agent, 'its durable revival expired while the app was not running');
    }

    if (brokerRelevant) {
      // Crash order is load-bearing: durable `sleeping` first, command pruning second. If the
      // command vanished first and the process died here, the next startup would restore
      // `waking` with no matching old command and recreate the fresh-TTL bug.
      let persisted = false;
      try {
        persisted = await persistCriticalSwarmNow();
      } catch (err) {
        throw new Error(
          `could not durably settle expired worker revival(s); bridge startup must retry before pruning them — ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (!persisted) {
        throw new Error('could not durably settle expired worker revival(s); bridge startup must retry before pruning them');
      }
    }

  }

  // One explicit durable rewrite from the local plan. No live bridge state participates in this
  // snapshot, so an overlapping callback/request cannot smuggle a half-restored generation onto
  // disk. If storage fails after broker reconciliation, the safe old disk row remains and
  // durable.ts retains this exact newer generation for retry; publishing the already-reconciled
  // plan in memory is safe because admission is still fenced by bridgeRecovering.
  let rewriteDurable = true;
  try {
    await writeDurableNow(COMMANDS_STATE, restoredCommandSnapshot(plan.commands, plan.receipts, now));
    rewriteDurable = false;
  } catch (err) {
    logWarn(`bridge: could not persist reconstructed command state — ${err instanceof Error ? err.message : String(err)}`);
  }

  // This is the only publication point of restore. Everything above operated on local arrays;
  // everything below may again use ordinary live command helpers and timers.
  commands = plan.commands;
  commandReceipts = plan.receipts;
  for (const token of plan.resumeTokens) rememberToken(token.sessionId, token.token);
  rearmRetainedCommandDeadlines();
  if (plan.restored > 0) {
    logInfo(`bridge: restored ${plan.restored} chat command(s) from the previous run`);
    changed();
  }
  if (rewriteDurable) persistCommands();
  // Recovery may have just turned the last expired `waking` worker back into a stopped worker.
  // Do not resurrect the old global active claim merely because no request exists yet to run
  // the usual dispatcher/stale-sweep release hook.
  releaseQuiescentRun();
}

/** Test seam. */
export function resetBridgeForTests(): void {
  for (const command of commands) if (command.timer) clearTimeout(command.timer);
  if (browserPresenceTimer) clearTimeout(browserPresenceTimer);
  browserPresenceTimer = null;
  commands = [];
  commandReceipts = [];
  commandRetirementsAwaitingBroker.clear();
  commandLeaseWrites.clear();
  commandRedeems.clear();
  bridgeRecovering = false;
  bridgeShutdownRequested = false;
  clearUnattributedIncident();
  activeUntil.clear();
  awaitingReturn.clear();
  lastAttributedCallAt.clear();
  goalWatch.clear();
  compactionWatch.clear();
  // Re-armed rather than cleared: the seam stands in for a process that has just started
  // serving, which is exactly what the fence measures. Clearing it would leave the watchdog
  // permanently off in every suite that starts the bridge once and resets between tests.
  goalWatchFloor = Date.now();
  compactionWatchFloor = goalWatchFloor;
  resetContinuationsForTests();
  sessionTokens.clear();
  openInBrowser = null;
  if (browserLaunchTimer) clearTimeout(browserLaunchTimer);
  browserLaunchTimer = null;
  lastBrowserLaunchAt = 0;
  clearPlacementOffer();
  lastSeenAt = null;
  extensionVersion = null;
  versionWarned = false;
  requestWindow = { start: Date.now(), count: 0 };
}

export function bridgePort(): number | null {
  return port;
}
