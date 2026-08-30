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
import type { SessionOrigin } from '../shared/session.js';
import { getConfig, updateConfig } from './config.js';
import { getSecret, secureStorageStatus, setSecret } from './secrets.js';
import {
  ackGoalDraft,
  draftOpeningMessage,
  goalKeyPresent,
  goalObjectiveFor,
  goalViewFor,
  retireGoalDrafts,
  retireGoalDraftsFor,
  setGoalObjectiveNow,
  startGoalDraft
} from './goal.js';
import { logInfo, logWarn } from './logger.js';
import {
  closeConversation,
  liveConversations,
  noteChatOrigin,
  recordAgentMessage,
  recordChatObservations,
  restoreRecordedConversation,
  setCallAttributionListener,
  type ChatObservation,
  type PageCallEvidence
} from './session/recorder.js';
import {
  autoCompactionReady,
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
  agentForConversation,
  agentInfoForOwnedConversation,
  agentForOwnedConversation,
  bindConversation,
  claimWorkerRevival,
  currentRunId,
  failAgent,
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
  armContinuationNow,
  attachSummary,
  claimContinuationNow,
  commitContinuationResult,
  CONTINUATION_TTL_MS,
  continuationByToken,
  continuationForSession,
  openContinuationNow,
  repairPrimeFromResumeShadow,
  resetContinuationsForTests
} from './session/continuation.js';
import { noteResumeOpening } from './session/resume-gate.js';
import { readDurable, writeDurableNow, writeDurableSoon } from './durable.js';
import { APP_VERSION, BRIDGE_PROTOCOL } from './version.js';
import { requestCorrelation } from './session/correlation.js';
import { bindAgentWorkspace } from './workspace.js';
import { MAX_GOAL_OBJECTIVE_CHARS } from '../shared/goal.js';

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
 * How much activity one turn start or one attributed tool call grants a chat.
 *
 * Activity is granted, not measured. A chat is active because something it did says so - its turn
 * began, or it ran a tool - and it stays active for exactly this long unless it does one of those
 * again, which simply moves the deadline. Nothing else counts. Page heartbeats and progress
 * reports kept a chat whose request-id join had already died looking permanently alive, which is
 * the failure this window exists to expose rather than hide.
 */
export const CHAT_ACTIVE_MS = 3 * 60_000;
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
const COMMAND_DEADLINE_MS = 90_000;
/** A worker may occupy the broker's `waking` state for one short, absolute attempt. */
const REVIVAL_DEADLINE_MS = 30_000;
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
function originOf(req: http.IncomingMessage): { ok: boolean; origin: string | null } {
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
  let best: { endSeq: number; text: string } | null = null;
  for (const turnId of touched) {
    const end = [...recent]
      .reverse()
      .find((entry) => entry.kind === 'turn_end' && entry.turnId === turnId);
    if (!end) continue;
    // A replay of turn A after turn B has begun is history, not current completion evidence.
    if (recent.some((entry) => entry.kind === 'turn_start' && entry.turnId !== turnId && entry.seq > end.seq)) continue;
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
    if (!best || end.seq > best.endSeq) best = { endSeq: end.seq, text: final.message.text };
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

function goalEnabledFor(id: string): boolean {
  if (goalWorkerChat(id)) return false;
  return getConfig().goal.enabled;
}

/**
 * May the loop act in this chat at all — by the switch, or by this chat's own goal?
 *
 * The switch is the standing rule for every chat: keep going whenever ChatGPT itself says
 * something it was asked for is unfinished. A *specific goal* is one chat's own instruction,
 * given deliberately, naming the finish line; asking somebody to also find and flip a global
 * switch before the goal they just typed does anything would be asking them to say yes twice.
 * So either is enough — and the worker rule still overrides both, because there the prime is
 * already the author of the user's turns.
 */
function goalActiveFor(id: string): boolean {
  if (goalWorkerChat(id)) return false;
  return getConfig().goal.enabled || goalObjectiveFor(id) !== '';
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
      return json(res, 426, { error: 'incompatible_extension', bridge: BRIDGE_PROTOCOL, version: APP_VERSION }, origin);
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
    return json(res, 426, { error: 'incompatible_extension', bridge: BRIDGE_PROTOCOL, version: APP_VERSION }, origin);
  }
  // Charge only an authenticated extension. A random local process must not be able to
  // consume the browser's shared budget before failing origin/authentication.
  if (rateLimited()) return json(res, 429, { error: 'rate_limited' }, origin);
  if (noteBrowserSeen()) changed();

  if (route === '/status') {
    const live = liveConversations();
    // The extension's maintenance pass, and the whole conversation about repairs: `repaired`
    // reports the one it was last handed and has now carried out, and `repair` is the next one
    // for it — the chat whose local tool calls stopped being attributable to it, see
    // repairUnattributedChat. Reporting first is what makes a pass that says nothing mean the
    // last repair did not happen. Null, which is almost always, costs this pass one request.
    const repaired = url.searchParams.get('repaired');
    if (repaired) confirmRepair(repaired.slice(0, 64));
    return json(
      res,
      200,
      {
        ok: true,
        conversations: live,
        commands: commands.length,
        repair: takePendingRepair(),
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
    let edge = 0;
    let spends = false;
    for (const item of observations) {
      if (item.kind === 'turn_start') {
        edge = Math.max(edge, item.time);
        spends = false;
      } else if (item.kind === 'turn_end') {
        edge = Math.max(edge, item.time);
        spends = true;
      }
    }
    if (edge > 0 && spends) endActivity(id, edge);
    else if (edge > 0) {
      grantActivity(id, edge);
      const woke = noteAgentAlive(id, 'turn', edge);
      if (woke?.report) await recordAgentMessage(woke.report, 'sent');
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
      noteRecoveryObservations(id, observations);
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
      // Workers are one-shot jobs. A settled assistant answer plus its matching turn_end is
      // first-hand page evidence that the worker has completed a turn; waiting for the model
      // to make another MCP call solely to say `finish` leaves normal final answers as zombie
      // workers forever. The browser journal is allowed to split those two observations across
      // adjacent HTTP batches, so reconcile against the just-written durable session rather
      // than treating one transport envelope as a lifecycle boundary.
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
      queueMissingAgentTab(id, closedMidTurn);
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
      const workerBlocked = goalWorkerChat(id);
      return json(res, 200, {
        sessionId: null,
        entries: [],
        stream: [],
        userAnchors: [],
        nextSince: Number.isFinite(since) ? Math.max(0, since) : 0,
        job: null,
        ...(workerBlocked
          ? {
              // Worker conversations are never Compact & Resume sources. Keep the page's
              // own auto-compaction switch projection off even when this worker has no live
              // recorder attachment yet, so a reload cannot briefly inherit the global
              // auto=true setting and manufacture a worker compaction attempt.
              context: contextView(false),
              autoCompactReady: false,
              goal: {
                enabled: false,
                hasKey: await goalKeyPresent(),
                model: getConfig().goal.model,
                objective: '',
                blocked: 'worker',
                draft: null
              }
            }
          : {}),
        ...(retiredWorker ? { retiredWorker } : {})
      }, origin);
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
    const workerBlocked = goalWorkerChat(id);
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
    // App-owned transcript feed. Presentation-only: raw tool I/O stays in the local
    // session store. This is the source the connected page will render chronologically.
    const stream = events.flatMap((event) => {
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
          return [{
            ...base,
            kind: 'assistant_message',
            text: event.message.text,
            renderedHtml: event.renderedHtml?.text ?? '',
            state: event.state ?? (event.final ? 'final' : 'streaming'),
            final: event.final,
            messageId: event.messageId ?? null,
            origin: event.origin ?? event.seq
          }];
        case 'agent_message':
          return [{ ...base, kind: 'agent_message', from: event.from, to: event.to, text: event.message.text,
            delivery: event.delivery, messageId: event.messageId }];
        case 'chat_error':
          return [{ ...base, kind: 'chat_error', text: event.message.text }];
        case 'turn_start':
          return [{ ...base, kind: 'turn_start' }];
        case 'turn_end':
          return [{ ...base, kind: 'turn_end', outcome: event.outcome, detail: event.detail ?? '' }];
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
        ? [{ seq: event.origin ?? event.seq, time: event.time, messageId: event.messageId }]
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
        // Over the line *and* mid-turn. Both halves matter: the level is what makes it
        // fire at all, and the liveness is what keeps it off a stale chat that is merely
        // being opened — see chatIsWorking.
        // Worker identity is the conversation itself. Compact & Resume deliberately creates a
        // different conversation, while the continuation transaction only knows how to move a
        // run's prime binding. Letting a worker auto-compact therefore strands the worker in B
        // while the broker still authorises A. Workers stay in their chat until the 400k reuse
        // ceiling makes their next stop terminal.
        autoCompactReady:
          !workerBlocked && autoCompactionReady(summary) && chatIsWorking(live.conversationId),
        // What the composer's meter fills against, and what its automatic trigger fires
        // on. Sent from here rather than worked out in the page so that the bar someone
        // is watching and the threshold that acts are the same number: a meter that
        // filled against a figure of its own would show a full bar and do nothing, or
        // compact a conversation that still looked half empty.
        // Automatic compaction is a prime/solo-chat policy only. A worker keeps the same
        // conversation until it stops; crossing 400k changes future revive eligibility, not
        // its conversation identity. Reporting auto=false here prevents the content script
        // from ever arming its automatic compaction path for a worker in the first place.
        context: contextView(!workerBlocked),
        // This chat was opened by the app, so its first user message is not the user's —
        // it is the handoff brief or the worker bootstrap this app typed. The page uses
        // it to fold that message away. Read off the session record rather than remembered
        // in the tab, so it still holds after a reload, days later.
        bootstrap: summary?.origin?.kind ?? null,
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
        goal: {
          enabled: goalEnabledFor(id),
          hasKey: await goalKeyPresent(),
          model: getConfig().goal.model,
          // This chat's own goal, and never a worker's: the loop is off there whatever is
          // stored, and reporting one would let the page offer to drive a chat the prime owns.
          objective: workerBlocked ? '' : goalObjectiveFor(id),
          // Why the switch is drawn off when the user did not turn it off. Without this the
          // menu says "Goal off" in a worker chat and looks like a setting that failed to save.
          blocked: workerBlocked ? 'worker' : '',
          draft: goalViewFor(id, goalClient)
        },
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
   * Three shapes, because it is one button with one transaction behind it:
   *
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
    const id = conversationId(body['conversationId']);
    if (!id) return json(res, 400, { error: 'bad_conversation_id' }, origin);
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
    const live = liveConversations().find((entry) => entry.conversationId === id);
    const known = live ? null : await findSessionByConversation(id, { requireUnique: true });
    const sessionId = live?.sessionId ?? known?.id ?? null;
    if (!sessionId) {
      return json(
        res,
        409,
        { error: 'session_not_recorded', message: 'This chat has no recorded local session to compact.' },
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
      // The command's leased phase is a crash boundary: do not tell the page capture is fully
      // accepted until the attempt we are about to open is durable. This also makes the HTTP
      // response and the browser-open side effect deterministically ordered for callers.
      await deliver();
      logInfo(`bridge: captured the compaction brief for ${sessionId}; opening the replacement chat`);
      return json(
        res,
        200,
        { stored: true, sessionId, handoffId: handoff.id, commandId: command?.id ?? null, job: resumeJobFor(sessionId) },
        origin
      );
    }

    // The same press arriving again — an impatient second click, a retried request — is the
    // same transaction, answered with itself. That idempotency lives in openContinuationNow.
    const already = continuationForSession(sessionId);
    if (already && already.state !== 'awaiting-summary') {
      return json(res, 200, { started: false, sessionId, token: already.token, job: resumeJobFor(sessionId) }, origin);
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
    // The instruction leaves this route once per transaction. A second request for the same
    // continuation — a retried POST whose answer was lost, a reloaded tab, an impatient
    // second press — is answered with the token and nothing to submit, because submitting it
    // again would start a second compaction turn for one transaction and leave two answers
    // each claiming to be the brief. A page that already armed one is watching it; a page
    // that did not can only wait or cancel.
    let armed = false;
    try {
      armed = await armContinuationNow(opened.token);
    } catch (err) {
      logWarn(`bridge: could not durably arm Compact & Resume for ${sessionId} — ${err instanceof Error ? err.message : String(err)}`);
      return json(res, 503, { error: 'continuation_arm_not_durable', retryable: true, sessionId }, origin);
    }
    logInfo(
      armed
        ? `bridge: browser started Compact & Resume for ${sessionId} (${opened.token.slice(0, 8)})`
        : `bridge: browser asked again for a compaction already under way for ${sessionId}`
    );
    return json(
      res,
      armed ? 202 : 200,
      {
        started: armed,
        armed: !armed,
        sessionId,
        token: opened.token,
        // The prompt the page injects as the compaction turn. Its answer is the brief.
        prompt: armed ? nativeHandoffPrompt() : null,
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
    const clientId = typeof body['clientId'] === 'string' ? body['clientId'].slice(0, 100) : '';
    if (!id) return json(res, 400, { error: 'bad_conversation_id' }, origin);
    if (!turnId) return json(res, 400, { error: 'bad_turn_id' }, origin);
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
    let draft;
    try {
      draft = startGoalDraft({ sessionId, conversationId: id, turnId, clientId });
    } catch (err) {
      if (err instanceof Error && err.message === 'goal_owned_elsewhere') {
        return json(
          res,
          409,
          { error: 'goal_owned_elsewhere', message: 'Another tab is already handling Goal Mode for this chat.' },
          origin
        );
      }
      throw err;
    }
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
    return json(res, 200, { acknowledged: ackGoalDraft(id, token, clientId) }, origin);
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
    if (text.length > MAX_GOAL_OBJECTIVE_CHARS * 2) return tooLarge(res, origin);
    const objective = await setGoalObjectiveNow(id, text);
    retireGoalDraftsFor(id);
    logInfo(objective ? `bridge: chat ${id} was given a specific goal` : `bridge: the specific goal for chat ${id} was cleared`);
    return json(res, 200, { objective }, origin);
  }

  /**
   * The opening message for a chat that has no id yet.
   *
   * Everything else here is keyed by conversation, and a New Chat has none — ChatGPT assigns
   * one only when a message is sent, and the message being asked for is that one. So this
   * route holds nothing, streams nothing and is answered in place: the page waits for it,
   * types it, and comes back to /goal/objective with the real id once ChatGPT has issued it.
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
    if (text.length > MAX_GOAL_OBJECTIVE_CHARS * 2) return tooLarge(res, origin);
    if (!text.trim()) return json(res, 400, { error: 'no_objective' }, origin);
    if (!(await goalKeyPresent())) return json(res, 409, { error: 'no_api_key' }, origin);
    const drafted = await draftOpeningMessage(text);
    if ('error' in drafted) return json(res, 502, { error: drafted.error }, origin);
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
    const settingsConversation = conversationId(body['conversationId']);
    if (auto === null && goal === null) return json(res, 400, { error: 'nothing_to_change' }, origin);
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
    const next = await updateConfig((config) => ({
      ...config,
      compaction: auto === null ? config.compaction : { ...config.compaction, auto },
      goal: goal === null ? config.goal : { ...config.goal, enabled: goal }
    }));
    if (goal === false) retireGoalDrafts();
    // The app's own settings screen is showing these two switches as well.
    changed();
    logInfo(
      `bridge: browser set ${[auto === null ? '' : `automatic compaction ${auto ? 'on' : 'off'}`, goal === null ? '' : `the goal loop ${goal ? 'on' : 'off'}`]
        .filter(Boolean)
        .join(' and ')}`
    );
    return json(
      res,
      200,
      { context: contextView(), goal: { enabled: next.goal.enabled, hasKey: await goalKeyPresent(), model: next.goal.model } },
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
    if (command.owner && command.owner !== client) {
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
    } else if (!(await persistCommandLease(command, client, claimedAt))) {
      if (command.owner && command.owner !== client) {
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
        const claimed = await claimContinuationNow(command.spec.token, `${command.id}:${client}`);
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
  const summary = await findSessionByConversation(conversationId, { requireUnique: true });
  if (!summary) return { quiescent: false, ended: false, lastOutcome: null };
  const modifiedAt = await sessionDurableModifiedAt(summary.id);
  const lastDurableWrite = Math.max(summary.updatedAt, summary.endedAt ?? 0, modifiedAt ?? 0);
  if (lastDurableWrite <= 0 || now - lastDurableWrite < STALE_SWARM_MS) {
    return { quiescent: false, ended: summary.endedAt !== null, lastOutcome: summary.lastTurnOutcome };
  }

  let lastOutcome: string | null = summary.lastTurnOutcome;
  if (summary.activeTurnId) return { quiescent: false, ended: summary.endedAt !== null, lastOutcome };
  // Pre-1.8.8 metadata has no durable open-turn projection. Bound that one migration path
  // to the newest tail instead of reparsing the full lifetime on every 30-second sweep.
  if (summary.activeTurnId === undefined) {
    const openTurns = new Set<string>();
    for (const event of await readRecentEvents(summary.id, 4096, { kinds: ['turn_start', 'turn_end'] })) {
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
  const runId = currentRunId();
  if (!runId || swarmTransferActive() || inFlightMcpRequests() > 0 || observationWritesInFlight > 0) return false;

  let state = swarmState();
  if (!state.running) return false;

  // A detached worker has no browser page left to publish a turn boundary. Its dedicated
  // silence clock is therefore the only path that can eventually release the slot when the
  // server-side turn also stops calling tools. This used to run only on later MCP ingress,
  // which means the exact worker that became completely silent was never reconsidered. Run it
  // from the bridge's 30-second maintenance loop as well; attached/background workers are
  // explicitly excluded inside sleepSilentDetachedWorkers and still require durable turn proof.
  const stoppedWorkers: string[] = [];

  // One bounded rescue, then release the slot if the same *open* turn remains completely
  // silent. The first browser action is tracked by the activity episode and cannot repeat;
  // sleeping at four minutes uses the broker's existing context-ceiling decision, so a worker
  // at 400k becomes finished while every other worker remains reusable.
  for (const worker of state.agents.filter((agent) => agent.role === 'worker' && agent.state === 'active')) {
    if (!worker.conversationId) continue;
    // The granted window is the whole test. A worker that has never started a turn and never
    // called a tool has nothing to expire and is left to the paths that own it; one whose window
    // ran out has produced nothing this app can attribute for three minutes, whatever its page
    // still says about itself.
    const granted = activityEndsAt(worker.conversationId);
    if (granted === null || granted > now) continue;
    const slept = sleepWorker(
      worker.id,
      'Its ChatGPT turn started but produced no tool call for three minutes.'
    );
    forgetActivity(worker.conversationId);
    repairsInFlight.delete(worker.conversationId);
    if (slept?.report) await recordAgentMessage(slept.report, 'sent');
    if (slept) stoppedWorkers.push(worker.id);
  }

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
  if (workers.length === 0 || workers.some((agent) => !agent.revivable && agent.state !== 'finished' && agent.state !== 'failed')) return false;
  if (workers.some((agent) => agent.revivable)) return false;

  // Orphan fallback may discard still-pending final reports only after the prime and every
  // bound terminal worker are themselves durably quiescent for the full grace period.
  const prime = state.agents.find((agent) => agent.role === 'prime') ?? null;
  if (!prime?.conversationId) return false;
  const primeProof = await durableQuiescence(prime.conversationId, now);
  if (!primeProof.quiescent) return false;
  for (const worker of workers) {
    if (!worker.conversationId) continue;
    const proof = await durableQuiescence(worker.conversationId, now);
    if (!proof.quiescent) return false;
  }
  if (currentRunId() !== runId || swarmTransferActive() || inFlightMcpRequests() > 0 || observationWritesInFlight > 0) return false;
  return releaseQuiescentRun({
    allowPendingReports: true,
    reason: 'all workers are terminal and the run remained durably quiescent past the orphan grace period'
  });
}

// -------------------------------------------------------------------- server

/** Unsubscribes this module's swarm-end listener. Held so a restart cannot double it. */
let dropSwarmEndListener: (() => void) | null = null;
let staleSwarmTimer: NodeJS.Timeout | null = null;
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
  claimedAt: number
): Promise<boolean> {
  const earlier = commandLeaseWrites.get(command.id);
  if (earlier) {
    await earlier;
    if (!commands.includes(command)) return false;
    if (owner !== null && command.owner !== null && command.owner !== owner) return false;
    // The app-open lease may be finishing just as the marked page redeems it. The page's
    // owner-bearing renewal is a second durable transition, not a conflict with that write.
    return persistCommandLease(command, owner, claimedAt);
  }
  if (!commands.includes(command)) return false;
  if (owner !== null && command.owner !== null && command.owner !== owner) return false;
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
  stage: ResumeStage;
  startedAt: number;
  /** True while the button must stay disabled. */
  busy: boolean;
  handoffId: string | null;
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
    stage,
    startedAt: entry.openedAt,
    busy: RUNNING_STAGES.has(stage),
    handoffId: entry.handoffId,
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
function contextView(autoAllowed = true): { auto: boolean; threshold: number; warn: number; limit: number } {
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
  const command = queue({ type: 'revive', agent, conversationId, runId, wake: wake.join(' ') });
  // Start the waking clock at broker admission, not only after a browser accepts the command.
  armDeadline(command);
  deliver();
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

export function setBrowserOpener(open: ((url: string) => Promise<void>) | null): void {
  openInBrowser = open;
}

/** The one place this app writes a ChatGPT conversation URL. */
export function chatUrl(conversationId: string): string {
  return `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`;
}

/** Where the app sends the browser. The marker is an id, not a credential. */
export function commandUrl(id: string, conversationId?: string | null): string {
  // Both a query and a fragment: ChatGPT is a single-page app that rewrites its own URL
  // during boot, and which of the two survives has changed between builds. The content
  // script accepts either, and redeeming still requires the extension's bearer token —
  // so a copied link, a history entry or a synced tab is worth nothing on its own.
  const marker = `clf=${encodeURIComponent(id)}`;
  // A continuation opens the worker's own conversation rather than a new one. The page
  // still has to redeem the marker, and the command it gets back names this same
  // conversation, so the two have to agree before anything is typed.
  const base = conversationId ? chatUrl(conversationId) : 'https://chatgpt.com/';
  return `${base}?${marker}#${marker}`;
}

// -------------------------------------------------------- exact browser recovery

/**
 * Every chat that has been granted activity, and the instant that grant runs out.
 *
 * One number per chat is the entire notion of "active" in this file. A value in the future means
 * the chat is active; a value in the past means its grant ran out; no entry at all means the chat
 * has never done anything that grants one. That third case is deliberately distinct from the
 * second - a chat that never started is not a chat that stopped, and only the latter is something
 * to act on.
 *
 * This replaced a pair of clocks that disagreed: an agent's `lastSeenAt`, which any page report
 * refreshed, and the recorder's open-turn flags, which stayed true for as long as the DOM kept
 * spinning. Both read a page that was still moving as a chat that was still working, and a chat
 * whose request-id join has broken is exactly a page that is still moving while the app hears
 * nothing from it.
 */
const activeUntil = new Map<string, number>();

/** A turn start or an attributed tool call. Grants CHAT_ACTIVE_MS from the moment it happened. */
function grantActivity(conversationId: string, at = Date.now()): void {
  activeUntil.set(conversationId, at + CHAT_ACTIVE_MS);
}

/**
 * A turn end. Spends the grant now rather than dropping it, because "stopped" and "never started"
 * are different answers and the sleep sweep acts on only one of them. A later call grants again.
 */
function endActivity(conversationId: string, at = Date.now()): void {
  if (activeUntil.has(conversationId)) activeUntil.set(conversationId, at);
}

/** The instant this chat's grant runs out, or null if it was never granted one. */
function activityEndsAt(conversationId: string): number | null {
  return activeUntil.get(conversationId) ?? null;
}

/** Drops a chat out of the activity ledger entirely, once nothing is waiting on it. */
function forgetActivity(conversationId: string): void {
  activeUntil.delete(conversationId);
}

/**
 * How long one Unattributed incident is given to prove itself wrong.
 *
 * Unattributed activity means a chat is running tools while the request-id join is broken —
 * usually because that page's content script or Fiber helper died under it. It never says
 * which chat, so nothing here guesses one. It is deliberately slow to arm: the live probes in
 * docs/chatgpt-turn-signals.md show ChatGPT can sit for more than a minute on a genuinely live
 * request, and reloading a chat that was merely thinking destroys the answer it was writing. A
 * whole minute of every other chat carrying on normally is what makes the silent ones stand out.
 * Only the recorder's own post-grace Unattributed verdict starts this clock, and only the
 * recorder's attributed verdicts end it.
 */
const UNATTRIBUTED_REPAIR_MS = 60_000;

/**
 * Seconds until the open incident acts, or null when nothing is going to act.
 *
 * With no incident open the answer is the whole window rather than a placeholder: the call
 * asking this is an unattributed one, so it is the call that opens the incident. With no
 * browser in sight there is no answer at all — nothing can reload a tab this app cannot see,
 * and promising a chat a repair that will never come is worse than saying nothing.
 */
export function unattributedRepairEta(now = Date.now()): number | null {
  if (!browserPresent()) return null;
  const startedAt = unattributedIncident?.startedAt ?? now;
  return Math.max(0, Math.round((startedAt + UNATTRIBUTED_REPAIR_MS - now) / 1000));
}

interface UnattributedIncident {
  startedAt: number;
  timer: NodeJS.Timeout;
  /** Chats whose calls kept being attributed while this incident was open. Not the broken one. */
  proven: Set<string>;
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
 * is any point waiting to observe. A repair the browser could not carry out — no tab of that
 * chat, two of them, a reload that threw — must go back in the queue, or the one failure this
 * whole path exists for would be recorded as handled and never tried again.
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
  endedTurns: number;
  state: 'queued' | 'handed' | 'done';
  /** Stable identity of the failure/inactivity episode. A new activity stamp mints a new one. */
  episode: string;
  reason: 'unattributed' | 'assistant-error' | 'no-tab';
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
}

const repairsInFlight = new Map<string, Repair>();
/** Last browser action per exact chat. One cooldown covers errors, silence and missing tabs. */
const lastBrowserRecoveryAt = new Map<string, number>();

function recoveryAgent(conversationId: string) {
  const info = agentInfoForOwnedConversation(conversationId);
  if (!info) return null;
  return info.state === 'active' || info.state === 'detached' || info.state === 'waking' ? info : null;
}

/**
 * Queues one exact browser action for one inactivity/failure episode.
 *
 * Every trigger converges here. A second reason while an action is already pending is the same
 * recovery, not another reload. Once carried out it stays spent until new activity changes the
 * episode key; the three-minute floor then protects even two genuinely distinct failures.
 */
function queueBrowserRecovery(
  conversationId: string,
  episode: string,
  reason: Repair['reason'],
  endedTurns = 0,
  now = Date.now()
): boolean {
  if (!getConfig().multiAgent.recoverAgentTabs && reason !== 'unattributed' && reason !== 'assistant-error')
    return false;
  const held = repairsInFlight.get(conversationId);
  if (held?.episode === episode) return false;
  if (held && held.state !== 'done') return false;
  const notBefore = Math.max(now, (lastBrowserRecoveryAt.get(conversationId) ?? 0) + BROWSER_RECOVERY_COOLDOWN_MS);
  repairsInFlight.set(conversationId, {
    endedTurns,
    state: 'queued',
    episode,
    reason,
    notBefore,
    token: ''
  });
  return true;
}

/** Meaningful page/call activity is the episode boundary; empty polling is intentionally absent. */
function noteRecoveryActivity(conversationId: string): void {
  const held = repairsInFlight.get(conversationId);
  if (held && held.reason !== 'unattributed') repairsInFlight.delete(conversationId);
}

const MEANINGFUL_RECOVERY_ACTIVITY = new Set<ChatObservation['kind']>([
  'user_message',
  'assistant_message',
  'page_tool',
  'turn_start',
  'turn_end',
  'tool_evidence'
]);

/** Applies one accepted observation batch to the recovery episode, after it is durable. */
function noteRecoveryObservations(conversationId: string, observations: readonly ChatObservation[]): void {
  if (observations.some((item) => MEANINGFUL_RECOVERY_ACTIVITY.has(item.kind))) noteRecoveryActivity(conversationId);

  // A transport failure rendered inside an assistant turn is the page saying, in its own words,
  // that the answer it was producing is gone. That is true of any chat: an ordinary conversation
  // with no worker attached breaks the same way, and leaving it parked on "message delivery
  // timed out" until a human notices was the whole of this bug. Neither an agent binding nor a
  // recent attributed call is evidence about that failure, so neither may gate the repair.
  const now = Date.now();
  for (const item of observations) {
    // This is the role fence. Top-level alerts and anything rendered under a user message are
    // still recorded, but only the DOM adapter's assistant-turn classifier may set this bit.
    if (item.kind !== 'chat_error' || item.recoverable !== true || !item.turnId) continue;
    const episode = `assistant-error:${item.turnId}:${(item.text ?? '').slice(0, 240)}`;
    if (queueBrowserRecovery(conversationId, episode, 'assistant-error', 0, now)) {
      logInfo(`bridge: assistant transport failure — asking the browser to recover ${conversationId}`);
    }
    break;
  }
}

/** The active agent chats for which the browser must keep asking the app for recovery work. */
function browserRecoveryMonitoring(): boolean {
  if (repairsInFlight.size > 0) return true;
  if (!getConfig().multiAgent.recoverAgentTabs) return false;
  return swarmState().agents.some(
    (agent) =>
      Boolean(agent.conversationId) &&
      (agent.state === 'active' || agent.state === 'waking')
  );
}

/** A final-tab close during one exact open turn is one no-tab recovery episode. */
function queueMissingAgentTab(conversationId: string, closedMidTurn: boolean, now = Date.now()): void {
  if (!closedMidTurn || !getConfig().multiAgent.recoverAgentTabs) return;
  const agent = recoveryAgent(conversationId);
  if (!agent || agent.state !== 'detached') return;
  const detachedAt = agent.detachedAt ?? now;
  if (queueBrowserRecovery(conversationId, `no-tab:${detachedAt}`, 'no-tab', 0, now)) {
    logInfo(`multi-agent: ${agent.id} has no tab — asking the browser to open the exact chat once`);
  }
}

/**
 * Every live chat this app can presently prove is mid-turn.
 *
 * A conversation whose own page reports it is generating qualifies. A tab that went away
 * mid-turn already filed its exact no-tab repair at `/closed`; treating every durable `detached`
 * agent as still mid-turn made completed Prime chats reopen merely because they owned a run.
 */
function repairCandidates(now = Date.now()): Array<{ conversationId: string; endedTurns: number }> {
  // A grant that ran out a whole window ago is behind every decision that reads it: the sleep
  // sweep runs every thirty seconds and has long since had its say. Forgetting it here is what
  // keeps the ledger the size of the chats in play rather than the size of the session.
  for (const [conversationId, until] of activeUntil) {
    if (until + CHAT_ACTIVE_MS < now) activeUntil.delete(conversationId);
  }
  const live = new Map(liveConversations().map((entry) => [entry.conversationId, entry]));
  return [...activeUntil]
    .filter(([, until]) => until > now)
    .map(([conversationId]) => ({
      conversationId,
      endedTurns: live.get(conversationId)?.endedTurns ?? 0
    }));
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
    if (repair.reason !== 'unattributed') continue;
    const entry = live.get(conversationId);
    if (entry && entry.endedTurns > repair.endedTurns) repairsInFlight.delete(conversationId);
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
function noteCallAttribution(conversationId: string | null): void {
  if (conversationId) {
    grantActivity(conversationId);
    noteRecoveryActivity(conversationId);
    unattributedIncident?.proven.add(conversationId);
    repairsInFlight.delete(conversationId);
    return;
  }
  if (unattributedIncident) return;
  const timer = setTimeout(repairUnattributedChat, UNATTRIBUTED_REPAIR_MS);
  timer.unref?.();
  unattributedIncident = { startedAt: Date.now(), timer, proven: new Set() };
}

/**
 * Reattaches every chat that has gone quiet on attribution.
 *
 * Health is a per-chat fact, not a competition between chats. This used to act only when
 * exactly one candidate existed, so the case it exists for — several workers losing the same
 * evidence path at once — was the one case it refused. Two silent mid-turn chats are not an
 * ambiguity to resolve, they are two broken chats. Each is judged on its own evidence, and a
 * chat that proves its join with an attributed call has already left the incident by here.
 */
function repairUnattributedChat(): void {
  const incident = unattributedIncident;
  unattributedIncident = null;
  if (!incident) return;
  retireSpentRepairs();
  const candidates = repairCandidates().filter(
    (entry) => !incident.proven.has(entry.conversationId) && !repairsInFlight.has(entry.conversationId)
  );
  // The browser owns the final open-vs-reload decision for both cases. It scans actual tabs at
  // action time, so a stale close event cannot open a duplicate and an open chat is reloaded
  // rather than copied. One queue is also what prevents an unattributed incident and an agent
  // silence incident from each performing their own recovery.
  for (const target of candidates) {
    if (
      queueBrowserRecovery(
        target.conversationId,
        `unattributed:${target.endedTurns}`,
        'unattributed',
        target.endedTurns
      )
    ) {
      logInfo(`bridge: unattributed activity — asking the browser to reload ${target.conversationId}`);
    }
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
 */
function takePendingRepair(now = Date.now()): { conversationId: string; token: string; reason: Repair['reason'] } | null {
  retireSpentRepairs();
  // A handout the browser did not confirm goes back at the *end* of the queue. Re-queueing it
  // in place let the first entry win every pass, so one repair the browser could not carry out
  // starved every other chat behind it — precisely when several chats break at once.
  for (const [conversationId, repair] of [...repairsInFlight]) {
    if (repair.state !== 'handed') continue;
    repair.state = 'queued';
    repairsInFlight.delete(conversationId);
    repairsInFlight.set(conversationId, repair);
  }
  for (const [conversationId, repair] of repairsInFlight) {
    if (repair.state !== 'queued') continue;
    if (now < repair.notBefore) continue;
    repair.state = 'handed';
    // A fresh token every time it goes out. A handout that was not carried out is dead the
    // moment it is re-queued, so a receipt that arrives for it later cannot close anything.
    repair.token = randomBytes(9).toString('base64url');
    return { conversationId, token: repair.token, reason: repair.reason };
  }
  return null;
}

/**
 * That repair actually happened: this exact chat's tab reloaded.
 *
 * The token, not the conversation, is what is answered here. A receipt that names a handout
 * this app is no longer waiting on - an older turn's, or one already re-queued - matches
 * nothing and closes nothing, which is the only safe reading of it.
 */
function confirmRepair(token: string): void {
  for (const [conversationId, repair] of repairsInFlight) {
    if (repair.state === 'handed' && repair.token === token) {
      repair.state = 'done';
      lastBrowserRecoveryAt.set(conversationId, Date.now());
      return;
    }
  }
}

function clearUnattributedIncident(): void {
  if (unattributedIncident) clearTimeout(unattributedIncident.timer);
  unattributedIncident = null;
  repairsInFlight.clear();
  lastBrowserRecoveryAt.clear();
}

/**
 * Sends the next queued bootstrap to the browser, now. The only way one is ever delivered.
 *
 * This is the whole answer to "the fresh chat opened five minutes late, or only once I
 * happened to open ChatGPT again". Delivery used to be pull-only: the app queued a command
 * and waited for some ChatGPT tab's content script to poll for it, which meant a browser
 * with no ChatGPT tab open — or no browser at all — was a queue that nothing drained, and
 * which tab picked the job up was whichever one happened to ask. Opening the target chat
 * directly makes the app the active party: it launches the browser if it is closed, creates
 * the tab if there is none, and the marker in the URL tells that one page which command it
 * is for, so no other tab and no global pending slot is involved.
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
  const claimedAt = Date.now();
  if (!(await persistCommandLease(command, null, claimedAt))) return;
  armDeadline(command);
  changed();
  // A revival is the one command that must not open a fresh composer: it names the chat the
  // worker already has, so the page lands on it and the marker it redeems names it back.
  const url = commandUrl(command.id, command.spec.type === 'revive' ? command.spec.conversationId : null);
  // The recorder can see a brand-new ChatGPT conversation before that page's content script has
  // redeemed this command. Arm the session-transfer gate before the browser gets any chance to
  // create B, otherwise that early observation invents a shadow session for B and the real A→B
  // commit quite correctly refuses to overwrite it. The later durable redeem refreshes the same
  // gate; commit/abort/drop clears it through the continuation state machine.
  if (command.spec.type === 'resume') noteResumeOpening(command.spec.token);
  logInfo(
    command.spec.type === 'revive'
      ? `bridge: reopening the ChatGPT chat of ${specKey(command.spec)}`
      : `bridge: opening a fresh ChatGPT chat for ${specKey(command.spec)}`
  );
  try {
    await openInBrowser(url);
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
function waitingForRevivalReadiness(command: Command): boolean {
  return command.spec.type === 'revive' && command.claimedAt !== null && command.owner === null;
}

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

const revivalNotDeliverable = (command: Command): boolean =>
  waitingForRevivalReadiness(command) || revivalDeliveryProven(command);

function commandDeadlineDelay(command: Command, now = Date.now()): number {
  // Revival is one absolute waking attempt. Redeeming the marked page must not renew it and leave
  // a worker occupying `waking` indefinitely when the page never sends or reports valid activity.
  if (command.spec.type === 'revive') return command.createdAt + REVIVAL_DEADLINE_MS - now;
  if (command.spec.type === 'resume' && command.owner !== null) {
    const continuation = continuationByToken(command.spec.token);
    if (continuation?.state === 'claimed') return continuation.openedAt + CONTINUATION_TTL_MS - now;
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
    if ((command.claimedAt === null && command.spec.type !== 'revive') || command.timer) continue;
    const remaining = commandDeadlineDelay(command, now);
    if (remaining > 0) armDeadline(command, remaining);
    else expired.push(command);
  }
  for (const command of expired) expire(command);
}

/**
 * The deadline passed. Decide what actually happened, then end it either way.
 *
 * Two of the three outcomes are quiet successes that simply have no acknowledgement of
 * their own: a worker whose chat was bound is done being a command, and a command already
 * gone has nothing left to end. The third is the failure this design chose over retrying —
 * the tab never redeemed, or redeemed and never typed, or typed into a chat it never named
 * — and `drop()` is what makes it safe: the continuation is aborted and its session stays
 * where it is, or the worker slot is failed so the prime stops waiting on a chat that does
 * not exist. Nothing is left pending for a later sweep to find.
 */
function expire(command: Command): void {
  if (!commands.includes(command)) return;
  const spec = command.spec;
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
  if (spec.type === 'revive' && !revivalFor(spec.agent)) {
    retire(command, 'its worker is no longer waiting to be woken');
    return;
  }
  drop(command, command.lastError ?? 'the chat this app opened did not report back in time');
  deliver();
}

/** Finishes a command that has nothing left to do, timer and all. */
function retire(command: Command, why: string): void {
  if (command.timer) clearTimeout(command.timer);
  command.timer = null;
  if (!commands.includes(command)) return;
  commands = commands.filter((entry) => entry !== command);
  logInfo(`bridge: ${specKey(command.spec)} is done — ${why}`);
  changed();
  persistCommands();
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
  return resumeBootstrapText(summary);
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
    const stale = command.spec.type === 'revive'
      ? now - command.createdAt >= REVIVAL_DEADLINE_MS
      : now - command.createdAt > COMMAND_TTL_MS;
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
  // A revival whose exact target page is still finishing its prior turn already had its browser
  // open attempt. It must stay durable without monopolising the global browser-delivery slot:
  // unrelated workers/resumes can still open their own marker-addressed pages while this one
  // waits. A document-owned lease remains exclusive and still blocks the next irreversible send.
  if (commands.some((command) => isLeased(command) && !revivalNotDeliverable(command))) return null;
  return commands.find((command) => !revivalNotDeliverable(command)) ?? null;
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
  if (spec.type === 'worker') return { kind: 'worker', fromSessionId: null, agentId: spec.agent, task: spec.task };
  // A revival opens no chat, so it names none. The conversation it lands in was recorded as a
  // worker chat when it was first opened, and rewriting that origin now would only overwrite
  // the task this worker was actually created for with whatever it is being asked next.
  if (spec.type === 'revive') return null;
  return { kind: 'resume', fromSessionId: spec.sessionId, agentId: null, task: '' };
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
export function pendingCommands(): Array<{ id: string; what: string; lastError: string | null }> {
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
  expiredRevivals: Array<{ id: string; spec: Extract<CommandSpec, { type: 'revive' }> }>;
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
  const expiredRevivals: Array<{ id: string; spec: Extract<CommandSpec, { type: 'revive' }> }> = [];
  const resumeTokens: Array<{ sessionId: string; token: string }> = plannedCommands
    .filter((command): command is Command & { spec: Extract<CommandSpec, { type: 'resume' }> } => command.spec.type === 'resume')
    .map((command) => ({ sessionId: command.spec.sessionId, token: command.spec.token }));
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
    const stale = spec.type === 'revive'
      ? now - createdAt >= REVIVAL_DEADLINE_MS
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
    if (
      command.spec.type !== 'revive' ||
      now - command.createdAt < REVIVAL_DEADLINE_MS
    ) continue;
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
  const saved = await readDurable<{ version?: number; commands?: unknown; receipts?: unknown }>(COMMANDS_STATE);
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
  resetContinuationsForTests();
  sessionTokens.clear();
  openInBrowser = null;
  lastSeenAt = null;
  extensionVersion = null;
  versionWarned = false;
  requestWindow = { start: Date.now(), count: 0 };
}

export function bridgePort(): number | null {
  return port;
}
