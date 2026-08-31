/**
 * Durable session history.
 *
 * Deliberately separate from the in-memory diagnostics log in logger.ts. That log
 * stays small, redacted and RAM-only; this one is an explicit opt-in feature that
 * writes what actually happened to disk so a five-hour session can be recovered.
 *
 * Structured activity is append-only JSONL. ChatGPT messages are different: streaming
 * changes the content of one logical message, so storing each snapshot as another event
 * creates duplicate transcript rows by construction. New writes live as one atomically
 * replaceable shard per stable logical website identity. A legacy messages.json map is read
 * as an overlay until each record is naturally rewritten, avoiding a startup-wide migration.
 * Identity is decided by the page/Fiber producer before it gets here; this store never guesses
 * that two different website ids are one message from their text, turn or timing.
 *
 *   sessions/<id>/events.jsonl    tool/turn/error/activity events, append-only
 *   sessions/<id>/messages/*.json canonical user/assistant messages, one logical id per shard
 *   sessions/<id>/messages.json   legacy canonical map, read during lazy migration
 *   sessions/<id>/meta.json       the summary, rewritten atomically
 *   sessions/<id>/assets/<id>     screenshots and other binaries
 *   sessions/<id>/handoffs/<id>.json
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  AssetRef,
  Handoff,
  NewSessionEvent,
  SessionEvent,
  SessionOrigin,
  SessionSummary,
  StoredText
} from '../../shared/session.js';
import { eventTokens, normalizedToolOutcome } from '../../shared/session.js';
import { chronological } from '../../shared/chronology.js';
import { getConfig } from '../config.js';
import { logError, logInfo, logWarn } from '../logger.js';

/**
 * Caps on how much of a value is written *inline*, into the JSONL line itself.
 *
 * These are not caps on what is kept. Anything longer is written whole, redacted, as a
 * `.txt` asset beside the log and referenced by `StoredText.assetId`, so the exact
 * arguments of an edit and the exact output of a command stay recoverable however
 * large they were — which is the entire premise of calling this history the source of
 * truth. What the caps buy is a log whose lines a reader can still parse and a summary
 * pass can still skim.
 */
// A Compact & Resume handoff becomes the next chat's opening user message. This is a wire /
// storage safety bound, not a token budget; keep it comfortably above the model's 30k-token
// handoff ceiling so the recorder does not immediately turn the carried brief into an inline
// stub plus asset reference. Truly runaway messages still spill to assets through storeText().
export const MAX_USER_MESSAGE_CHARS = 256_000;
export const MAX_MESSAGE_CHARS = 12_000;
export const MAX_TOOL_ARGS_CHARS = 8_000;
export const MAX_TOOL_RESULT_CHARS = 8_000;
/** Nothing is spilled to an overflow asset past this; a note records the shortfall. */
export const MAX_OVERFLOW_ASSET_CHARS = 8 * 1024 * 1024;
/** A single line that cannot be parsed back is dropped; this bounds the damage. */
const MAX_LINE_BYTES = 512 * 1024;
/** How many sessions the UI shows. Lookups and pruning still see every session. */
const MAX_LISTED_SESSIONS = 200;
/** Bound for legacy/model-facing full-list scans. Identity and retention use the uncapped cached catalog. */
const MAX_SCANNED_SESSIONS = 5_000;
/** Keep the uncapped authoritative scan fast without opening thousands of files at once. */
const ATTACHMENT_CATALOG_READ_CONCURRENCY = 64;

let root = '';
/**
 * Current-conversation misses already proven against this process's durable catalog.
 *
 * Browser activity polls repeatedly ask about chats this app has never recorded. Re-scanning
 * every session folder for the same negative answer is pure work. Positive ownership remains
 * sourced from metadata; this cache only remembers a miss, and every operation that can create
 * that exact current attachment invalidates its key before a later lookup may trust it.
 */
const missingCurrentConversations = new Set<string>();

interface AttachmentCatalog {
  /** Durable summary projection used for attachment identity and the renderer summary index. */
  summaries: Map<string, SessionSummary>;
  /** Durable closed-session order. Open sessions are overlaid live and excluded while paging. */
  orderedIds: string[];
  current: Map<string, Set<string>>;
  historical: Map<string, Set<string>>;
}

/**
 * Derived, rebuildable attachment index. Durable `meta.json` remains the authority.
 *
 * Some model-facing compatibility reads intentionally cap directory scans at 5,000. Conversation
 * identity and retention cannot use that cap: an arbitrary readdir prefix is not proof that an
 * older chat has no owner or is exempt from expiry. The catalog performs one uncapped,
 * crash-reconciling pass on first authoritative lookup, then normal `/activity`, renderer and
 * retention reads reuse it. Attachment mutations update it only after their durable write lands.
 */
let attachmentCatalog: AttachmentCatalog | null = null;
let attachmentCatalogLoading: Promise<AttachmentCatalog> | null = null;
/**
 * Invalidates an in-flight catalog build on ownership changes or when a live overlay retires.
 * Ordinary event/meta ticks do not touch it.
 */
let attachmentEpoch = 0;
const MAX_MISSING_CONVERSATION_CACHE = 1024;

function rememberMissingCurrentConversation(conversationId: string): void {
  missingCurrentConversations.add(conversationId);
  if (missingCurrentConversations.size <= MAX_MISSING_CONVERSATION_CACHE) return;
  const oldest = missingCurrentConversations.values().next().value as string | undefined;
  if (oldest) missingCurrentConversations.delete(oldest);
}

export function initSessionStore(userDataDir: string): void {
  root = path.join(userDataDir, 'sessions');
  sessionAssetUsage.clear();
  globalAssetUsage = null;
  missingCurrentConversations.clear();
  attachmentCatalog = null;
  attachmentCatalogLoading = null;
  attachmentEpoch = 0;
}

export function sessionsRoot(): string {
  return root;
}

/**
 * Refuses to touch the disk before somebody has said where.
 *
 * `root` starts empty, and `path.join('', id)` is a *relative* path — so an uninitialised
 * store does not fail, it writes real session folders into whatever the process's working
 * directory happens to be. That stayed invisible for as long as recording was off by
 * default; the moment it was switched on, a test run began scattering recordings through
 * the repository. In the app proper this cannot happen — `initSessionStore` is called
 * during start-up — which is exactly why it needs to be loud rather than left to chance.
 */
function assertReady(): void {
  if (root === '') {
    throw new Error('The session store was used before initSessionStore() named a directory');
  }
}

function sessionDir(id: string): string {
  assertReady();
  return path.join(root, id);
}

/** Ids are generated here and never taken from a caller, so this is a sanity check. */
function assertSessionId(id: string): void {
  if (!/^[0-9a-z-]{8,64}$/i.test(id)) throw new Error('Invalid session id');
}

// ------------------------------------------------------------------ state

interface OpenSession {
  summary: SessionSummary;
  nextSeq: number;
  /** Highest durable journal/message seq already reflected by `summary`. */
  historySeq: number;
  /** Recent durable events, so incremental /activity polls do not reread the whole JSONL. */
  tail: SessionEvent[];
  /** Serialises appends so two events can never interleave inside one line. */
  queue: Promise<void>;
  /** Canonical ChatGPT messages. A later streaming/final snapshot replaces by stable id. */
  messages: Map<string, MessageEvent>;
  metaDirty: boolean;
  metaTimer: NodeJS.Timeout | null;
}

const open = new Map<string, OpenSession>();
/** One disk reconstruction per session; direct concurrent callers must share it. */
const opening = new Map<string, Promise<OpenSession>>();
interface DurableSessionSnapshot {
  summary: SessionSummary;
  messages: Map<string, MessageEvent>;
  historySeq: number;
  reconciled: boolean;
}
/** Read-only recovery also shares one durable high-water check/rebuild per session. */
const reconciling = new Map<string, Promise<DurableSessionSnapshot | null>>();
const MAX_EVENT_TAIL = 4096;
/** Hard ceiling for a bounded recent-history disk read. */
const MAX_RECENT_READ_BYTES = 8 * 1024 * 1024;
const MAX_CANONICAL_MESSAGE_BYTES = 1024 * 1024;
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_SESSION_ASSET_BYTES = 192 * 1024 * 1024;
export const MAX_GLOBAL_ASSET_BYTES = 2 * 1024 * 1024 * 1024;

const sessionAssetUsage = new Map<string, number>();
let globalAssetUsage: number | null = null;
let assetWriteQueue = Promise.resolve();

type MessageEvent = Extract<SessionEvent, { kind: 'user_message' | 'assistant_message' }>;
type NewMessageEvent = MessageEvent extends infer Event
  ? Event extends MessageEvent
    ? Omit<Event, 'seq'>
    : never
  : never;

/** Internal checkpoint field persisted beside the public summary projection. */
const META_HISTORY_SEQ = '__historySeq';
type PersistedSummary = SessionSummary & { [META_HISTORY_SEQ]?: number };
interface MetaCheckpoint {
  summary: SessionSummary;
  /** Null means metadata written by a version that did not yet persist a history watermark. */
  historySeq: number | null;
  /** Derived migration signal; never persisted. */
  outcomeCountersMissing: boolean;
  /** Derived final-message activity boundary was added after the original summaries. */
  activityBoundaryMissing: boolean;
}

function messageKey(event: Pick<MessageEvent, 'kind' | 'messageId'>): string | null {
  return event.messageId ? `${event.kind}\u0000${event.messageId}` : null;
}

/** Exact equality for the fixed StoredText wire shape without serialising large prose. */
function storedTextEqual(left: StoredText | undefined, right: StoredText | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.text === right.text &&
    left.truncated === right.truncated &&
    left.chars === right.chars &&
    left.assetId === right.assetId &&
    left.digest === right.digest
  );
}

function emptySummary(id: string, title: string, conversationId: string | null): SessionSummary {
  const now = Date.now();
  return {
    id,
    title,
    conversationId,
    chatIds: conversationId ? [conversationId] : [],
    startedAt: now,
    updatedAt: now,
    endedAt: null,
    events: 0,
    userMessages: 0,
    toolCalls: 0,
    lastToolCallAt: null,
    lastAssistantFinalAt: null,
    processExitNonzero: 0,
    toolRejected: 0,
    toolInternalErrors: 0,
    errors: 0,
    estimatedTokens: 0,
    contextTokens: 0,
    lastHandoffId: null,
    lastHandoffAt: null,
    lastCommittedResumeHandoffId: null,
    lastTurnOutcome: null,
    activeTurnId: null,
    agents: [],
    origin: null
  };
}

/**
 * Persists one summary atomically, without any live-entry bookkeeping.
 *
 * Split out so a *staged* summary can be written before it is published into memory. That
 * ordering is what makes the compaction rebind safe to fail: see rebindSession.
 */
async function writeSummary(summary: SessionSummary, historySeq: number): Promise<void> {
  const dir = sessionDir(summary.id);
  const target = path.join(dir, 'meta.json');
  const backup = path.join(dir, 'meta.backup.json');
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const persisted: PersistedSummary = { ...summary, [META_HISTORY_SEQ]: historySeq };
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(tmp, JSON.stringify(persisted, null, 2), 'utf8');
    // Preserve the last validated checkpoint. Never copy arbitrary corrupt bytes over the
    // backup: parse/id validation is what makes this a recovery source rather than a second
    // name for the same damage.
    try {
      const current = JSON.parse(await fs.readFile(target, 'utf8')) as SessionSummary;
      if (current?.id === summary.id) {
        const backupTmp = `${backup}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(backupTmp, JSON.stringify(current, null, 2), 'utf8');
          await fs.rename(backupTmp, backup);
        } finally {
          await fs.rm(backupTmp, { force: true }).catch(() => undefined);
        }
      }
    } catch {
      // First write, or an already damaged primary. Keep any existing valid backup.
    }
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function writeMeta(entry: OpenSession): Promise<void> {
  await writeSummary(entry.summary, entry.historySeq);
  // The attachment catalog is also the process-lifetime summary index used by the paged UI.
  // Ordinary event ticks stay in `open` and are overlaid live, but once metadata is actually
  // written keep the cached durable projection current too. Do not rebuild attachment maps:
  // rename/end/token changes do not change conversation ownership.
  publishCachedSummary(entry.summary, false);
  entry.metaDirty = false;
}

function enqueueSessionOperation<T>(entry: OpenSession, label: string, operation: () => Promise<T>): Promise<T> {
  const work = entry.queue.then(operation);
  entry.queue = work.then(
    () => undefined,
    (err: Error) => logError(`session ${label} failed: ${err.message}`)
  );
  return work;
}

/**
 * The summary is rewritten on a short delay rather than on every event. A long agent
 * session appends thousands of events; rewriting the summary for each one would turn
 * an append-only log into a write-amplified one for no benefit.
 */
function scheduleMeta(entry: OpenSession): void {
  entry.metaDirty = true;
  if (entry.metaTimer) return;
  entry.metaTimer = setTimeout(() => {
    entry.metaTimer = null;
    void enqueueSessionOperation(entry, 'meta write', async () => {
      if (entry.metaDirty) await writeMeta(entry);
    });
  }, 1500);
  entry.metaTimer.unref?.();
}

/** Flushes any pending summary write. Called before the app quits and before reads. */
export async function flushSessions(): Promise<void> {
  for (const entry of open.values()) {
    await flushSessionEntry(entry);
  }
}

/**
 * Waits only for mutations that belong to one session, then makes its summary current on disk.
 *
 * A read of session A must not become a global write barrier for every other open session.
 * Besides the avoidable latency, the old `flushSessions()` call meant polling one chat could
 * force metadata churn for dozens of unrelated generating chats. The per-session queue already
 * is the serialization boundary, so joining that target queue is both sufficient and stronger:
 * it also waits for an in-flight reconstruction of this exact session before deciding whether
 * there is anything live to flush.
 */
async function flushSession(sessionId: string): Promise<void> {
  let entry = open.get(sessionId);
  if (!entry) {
    const reconstructing = opening.get(sessionId);
    if (reconstructing) entry = await reconstructing;
  }
  if (entry) await flushSessionEntry(entry);
}

async function flushSessionEntry(entry: OpenSession): Promise<void> {
  if (entry.metaTimer) {
    clearTimeout(entry.metaTimer);
    entry.metaTimer = null;
  }
  await enqueueSessionOperation(entry, 'meta flush', async () => {
    if (entry.metaDirty) await writeMeta(entry);
  }).catch(() => undefined);
}

// ----------------------------------------------------------------- create

export async function createSession(options: {
  title?: string;
  conversationId?: string | null;
  origin?: SessionOrigin | null;
}): Promise<SessionSummary> {
  const id = `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const summary = emptySummary(id, options.title?.trim() || 'ChatGPT session', options.conversationId ?? null);
  summary.origin = options.origin ?? null;
  // Invalidate before exposing the in-flight live entry. A cached miss must never hide a
  // session that this process has started creating, even while its first durable write awaits.
  if (summary.conversationId) missingCurrentConversations.delete(summary.conversationId);
  const entry: OpenSession = {
    summary,
    nextSeq: 1,
    historySeq: 0,
    tail: [],
    queue: Promise.resolve(),
    messages: new Map(),
    metaDirty: false,
    metaTimer: null
  };
  open.set(id, entry);
  try {
    await fs.mkdir(sessionDir(id), { recursive: true });
    await fs.writeFile(path.join(sessionDir(id), 'events.jsonl'), '', { flag: 'a' });
    await fs.writeFile(path.join(sessionDir(id), 'messages.json'), '{}', { flag: 'a' });
    await writeMeta(entry);
    publishAttachmentSummary(entry.summary);
  } catch (error) {
    if (open.get(id) === entry) open.delete(id);
    throw error;
  }
  return { ...summary };
}

// ----------------------------------------------------------------- append

/** Reads the highest seq already on disk, so a restart never reuses a number. */
async function lastSeqOnDisk(id: string): Promise<number> {
  try {
    const file = path.join(sessionDir(id), 'events.jsonl');
    const stat = await fs.stat(file);
    // One valid event line may be almost MAX_LINE_BYTES and a crash can leave another
    // almost-full torn line after it. Read enough for both, otherwise the only parseable
    // predecessor can sit outside the tail window and restart would reuse sequence 1.
    const from = Math.max(0, stat.size - (MAX_LINE_BYTES * 2 + 2));
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - from);
      await handle.read(buffer, 0, buffer.length, from);
      const lines = buffer.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as SessionEvent;
          if (typeof parsed.seq === 'number') return parsed.seq;
        } catch {
          // A torn final line is expected after a crash; keep looking backwards.
        }
      }
    } finally {
      await handle.close();
    }
  } catch {
    // No file yet, or unreadable: start from zero and let the append recreate it.
  }
  return 0;
}

/**
 * Closes off a torn last line before anything is appended after it.
 *
 * A crash mid-append leaves a line with no newline. Appending straight onto it would
 * glue a perfectly good new event onto the wreckage and lose that one too, so the
 * damage is sealed with a newline first: one event lost, which is the promise.
 */
async function sealTornTail(id: string): Promise<void> {
  const file = path.join(sessionDir(id), 'events.jsonl');
  try {
    const stat = await fs.stat(file);
    if (stat.size === 0) return;
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(1);
      await handle.read(buffer, 0, 1, stat.size - 1);
      if (buffer[0] === 0x0a) return;
    } finally {
      await handle.close();
    }
    await fs.appendFile(file, '\n', 'utf8');
    logWarn(`session ${id}: sealed an unterminated final line before appending`);
  } catch {
    // No file yet, or unreadable: the append will recreate it.
  }
}

/** Canonical message snapshot file. Unknown/legacy shapes are ignored, never guessed. */
async function readCanonicalMessages(id: string): Promise<Map<string, MessageEvent>> {
  const out = new Map<string, MessageEvent>();
  try {
    const raw = await fs.readFile(path.join(sessionDir(id), 'messages.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue;
      const event = value as MessageEvent;
      if ((event.kind !== 'user_message' && event.kind !== 'assistant_message') || typeof event.seq !== 'number') continue;
      const expected = messageKey(event);
      if (!expected || expected !== key) continue;
      out.set(key, event);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logWarn(`session ${id}: canonical message file unreadable; legacy event log remains available`);
    }
  }
  // Incremental shards overlay the legacy whole-map snapshot. This makes migration lazy:
  // the first post-upgrade revision writes only its own logical message, while untouched
  // history remains readable from messages.json.
  const shards = path.join(sessionDir(id), 'messages');
  try {
    const names = await fs.readdir(shards);
    for (const name of names) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      try {
        const raw = await fs.readFile(path.join(shards, name), 'utf8');
        if (Buffer.byteLength(raw, 'utf8') > MAX_CANONICAL_MESSAGE_BYTES) continue;
        const event = JSON.parse(raw) as MessageEvent;
        const key = messageKey(event);
        if (!key) continue;
        const expectedName = `${createHash('sha256').update(key).digest('hex')}.json`;
        if (expectedName !== name) continue;
        out.set(key, event);
      } catch {
        logWarn(`session ${id}: ignored unreadable canonical message shard ${name}`);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logWarn(`session ${id}: canonical message shards unreadable`);
  }
  return out;
}

async function writeCanonicalMessage(id: string, key: string, event: MessageEvent): Promise<void> {
  const dir = path.join(sessionDir(id), 'messages');
  await fs.mkdir(dir, { recursive: true });
  const name = `${createHash('sha256').update(key).digest('hex')}.json`;
  const target = path.join(dir, name);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const text = JSON.stringify(event);
  if (Buffer.byteLength(text, 'utf8') > MAX_CANONICAL_MESSAGE_BYTES) {
    throw new Error('Canonical message is too large');
  }
  try {
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * Explicit slow-path reconstruction from the durable journal plus canonical message shards.
 *
 * A stale metadata checkpoint cannot be patched incrementally for canonical revisions: the
 * shard contains only the newest body, so the token weight of the superseded revision is gone.
 * Rebuild the history-derived projection exactly, then preserve metadata-only facts (title,
 * attachment lineage, compaction latch, close state) from the last valid checkpoint.
 */
async function rebuildSummaryFromHistory(
  id: string,
  messages: Map<string, MessageEvent>,
  checkpoint: SessionSummary | null,
  historySeq: number
): Promise<SessionSummary> {
  const rebuilt = emptySummary(id, 'Recovered session', null);
  let sawProjected = false;
  const canonicalKeys = new Set(messages.keys());
  let carry = Buffer.alloc(0);
  const handle = await fs.open(path.join(sessionDir(id), 'events.jsonl'), 'r').catch(() => null);
  const accept = (line: Buffer): void => {
    if (line.length === 0 || line.length > MAX_LINE_BYTES) return;
    try {
      const event = JSON.parse(line.toString('utf8')) as SessionEvent;
      if (!event || typeof event.seq !== 'number' || typeof event.kind !== 'string') return;
      // Once a stable website message has a canonical shard, any old append-only snapshot with
      // the same identity is legacy storage for that same logical event, not another event.
      if (
        (event.kind === 'user_message' || event.kind === 'assistant_message') &&
        messageKey(event) &&
        canonicalKeys.has(messageKey(event)!)
      ) {
        return;
      }
      if (!sawProjected) {
        rebuilt.startedAt = event.time;
        rebuilt.updatedAt = event.time;
      }
      if (!sawProjected && event.kind === 'session_start') rebuilt.title = event.title || rebuilt.title;
      const eventConversation = 'conversationId' in event && typeof event.conversationId === 'string' ? event.conversationId : null;
      if (eventConversation) {
        rebuilt.conversationId = eventConversation;
        if (!rebuilt.chatIds.includes(eventConversation)) rebuilt.chatIds.push(eventConversation);
      }
      applyToSummary(rebuilt, event);
      sawProjected = true;
    } catch {
      // A torn or corrupt line costs that line, not the complete session projection.
    }
  };
  try {
    if (handle) {
      const chunk = Buffer.alloc(64 * 1024);
      let position = 0;
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        let joined = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        let start = 0;
        for (;;) {
          const newline = joined.indexOf(0x0a, start);
          if (newline < 0) break;
          accept(joined.subarray(start, newline));
          start = newline + 1;
        }
        carry = joined.subarray(start);
        if (carry.length > MAX_LINE_BYTES) carry = Buffer.alloc(0);
      }
      accept(carry);
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
  for (const message of [...messages.values()].sort((left, right) => left.seq - right.seq)) {
    if (!sawProjected) {
      rebuilt.startedAt = message.time;
      rebuilt.updatedAt = message.time;
    }
    applyToSummary(rebuilt, message);
    sawProjected = true;
  }
  if (!sawProjected) {
    throw new Error(`Session ${id} has no recoverable metadata or history`);
  }

  const summary = checkpoint
    ? {
        ...checkpoint,
        updatedAt: Math.max(checkpoint.updatedAt, rebuilt.updatedAt),
        events: rebuilt.events,
        userMessages: rebuilt.userMessages,
        toolCalls: rebuilt.toolCalls,
        lastToolCallAt: rebuilt.lastToolCallAt,
        lastAssistantFinalAt: rebuilt.lastAssistantFinalAt,
        processExitNonzero: rebuilt.processExitNonzero,
        toolRejected: rebuilt.toolRejected,
        toolInternalErrors: rebuilt.toolInternalErrors,
        errors: rebuilt.errors,
        estimatedTokens: rebuilt.estimatedTokens,
        // `contextTokens` may have been reset by a durable rebind, which is metadata-only and
        // therefore cannot be reconstructed from the event log. Every history mutation changes
        // lifetime/context token totals by the same delta, so applying the rebuilt lifetime delta
        // to the checkpoint preserves that reset while still recovering message revisions exactly.
        contextTokens: Math.max(0, checkpoint.contextTokens + (rebuilt.estimatedTokens - checkpoint.estimatedTokens)),
        lastHandoffId: rebuilt.lastHandoffId,
        lastHandoffAt: rebuilt.lastHandoffAt,
        lastTurnOutcome: rebuilt.lastTurnOutcome,
        activeTurnId: rebuilt.activeTurnId ?? null,
        agents: [...new Set([...checkpoint.agents, ...rebuilt.agents])]
      }
    : rebuilt;
  logWarn(`session ${id}: rebuilt metadata from durable event/message history`);
  await writeSummary(summary, historySeq);
  return summary;
}

/**
 * Reads the durable source of truth without making the session live.
 *
 * `meta.json` is a projection and can legitimately lag the journal or a canonical message
 * shard after a crash. Read-only callers still need the repaired projection, but routing them
 * through `ensureOpen()` would change lifetime semantics: merely viewing old history would put
 * it in `open` and make retention skip it. This helper performs the same high-water recovery
 * while leaving `open` untouched.
 */
async function readDurableSnapshot(id: string): Promise<DurableSessionSnapshot | null> {
  assertSessionId(id);
  const existing = reconciling.get(id);
  if (existing) return existing;
  const work = (async () => {
    const messages = await readCanonicalMessages(id);
    let messageSeq = 0;
    for (const event of messages.values()) messageSeq = Math.max(messageSeq, event.seq);
    const journalSeq = await lastSeqOnDisk(id);
    const historySeq = Math.max(journalSeq, messageSeq);
    const checkpoint = await readMetaCheckpoint(id);

    // A pre-taxonomy checkpoint can have a current watermark but stale outcome classification.
    if (
      checkpoint?.historySeq === historySeq &&
      !checkpoint.outcomeCountersMissing &&
      !checkpoint.activityBoundaryMissing
    ) {
      return { summary: checkpoint.summary, messages, historySeq, reconciled: false };
    }
    if (checkpoint && historySeq === 0) {
      // Nothing to replay: stamp the empty legacy projection in place.
      const summary = {
        ...checkpoint.summary,
        ...(checkpoint.outcomeCountersMissing ? { errors: 0 } : {}),
        lastToolCallAt: null,
        lastAssistantFinalAt: null
      };
      await writeSummary(summary, 0);
      return { summary, messages, historySeq: 0, reconciled: true };
    }
    if (!checkpoint && historySeq === 0) return null;

    const summary = await rebuildSummaryFromHistory(id, messages, checkpoint?.summary ?? null, historySeq);
    return { summary, messages, historySeq, reconciled: true };
  })();
  reconciling.set(id, work);
  try {
    return await work;
  } finally {
    if (reconciling.get(id) === work) reconciling.delete(id);
  }
}

async function readAuthoritativeSummary(id: string): Promise<SessionSummary | null> {
  const live = open.get(id);
  if (live) return live.summary;
  const becomingLive = opening.get(id);
  if (becomingLive) return (await becomingLive).summary;
  const snapshot = await readDurableSnapshot(id);
  if (!snapshot) return null;
  // If a process-lifetime catalog already exists, or one is concurrently being built and may
  // already have passed this row, invalidate/update it after a recovery write. The catalog's own
  // build calls readDurableSnapshot directly, so its normal stale-row repairs do not self-loop.
  if (snapshot.reconciled && (attachmentCatalog || attachmentCatalogLoading)) {
    publishAttachmentSummary(snapshot.summary);
  }
  return snapshot.summary;
}

async function ensureOpen(id: string): Promise<OpenSession> {
  assertSessionId(id);
  const existing = open.get(id);
  if (existing) return existing;
  const inFlight = opening.get(id);
  if (inFlight) return inFlight;
  const reconstruction = (async () => {
    await sealTornTail(id);
    const snapshot = await readDurableSnapshot(id);
    if (!snapshot) throw new Error(`Session ${id} has no recoverable metadata or history`);
    const entry: OpenSession = {
      summary: snapshot.summary,
      nextSeq: snapshot.historySeq + 1,
      historySeq: snapshot.historySeq,
      tail: [],
      queue: Promise.resolve(),
      messages: snapshot.messages,
      metaDirty: false,
      metaTimer: null
    };
    open.set(id, entry);
    if (snapshot.reconciled && (attachmentCatalog || attachmentCatalogLoading)) {
      publishAttachmentSummary(entry.summary);
    }
    return entry;
  })();
  opening.set(id, reconstruction);
  try {
    return await reconstruction;
  } finally {
    if (opening.get(id) === reconstruction) opening.delete(id);
  }
}

function applyToSummary(summary: SessionSummary, event: SessionEvent): void {
  summary.events += 1;
  // Never backwards. A tool call is written once the app knows which chat it belongs to,
  // which can be after the page has already reported the end of the turn it ran in, and
  // the call carries the time it started. Taking that literally would age a session back
  // to before its own last event and drop it down a list sorted by recency.
  summary.updatedAt = Math.max(summary.updatedAt, event.time);
  const tokens = eventTokens(event);
  summary.estimatedTokens += tokens;
  // What the attached chat is carrying. Reset by a compaction rebind; see rebindSession.
  summary.contextTokens += tokens;
  if (event.kind === 'user_message') summary.userMessages += 1;
  if (event.kind === 'tool_call') {
    summary.toolCalls += 1;
    summary.lastToolCallAt = Math.max(summary.lastToolCallAt ?? 0, event.time);
    const outcome = normalizedToolOutcome(event.call);
    if (outcome === 'process_exit_nonzero') summary.processExitNonzero += 1;
    if (outcome === 'tool_rejected') summary.toolRejected += 1;
    if (outcome === 'tool_internal_error') {
      summary.toolInternalErrors += 1;
      summary.errors += 1;
    }
  }
  if (event.kind === 'assistant_message' && (event.final === true || event.state === 'final')) {
    summary.lastAssistantFinalAt = Math.max(summary.lastAssistantFinalAt ?? 0, event.time);
  }
  if (event.kind === 'chat_error') summary.errors += 1;
  if (event.kind === 'turn_end') summary.lastTurnOutcome = event.outcome;
  if (event.kind === 'turn_start') summary.activeTurnId = event.turnId ?? `seq-${event.seq}`;
  if (event.kind === 'turn_end' && (!event.turnId || summary.activeTurnId === event.turnId)) summary.activeTurnId = null;
  if (event.kind === 'handoff') {
    summary.lastHandoffId = event.handoffId;
    summary.lastHandoffAt = event.time;
  }
  if (event.agent && !summary.agents.includes(event.agent)) summary.agents.push(event.agent);
}

/**
 * Whether this chat is over its automatic-compaction line.
 *
 * A level, and deliberately not the edge this used to be. The edge version armed on the
 * below-to-above crossing and then waited for that turn to end cleanly, which had two
 * consequences the design never wanted: a single interrupted turn destroyed the trigger
 * forever (a counter that only grows never crosses the same line twice), and every
 * compaction it did manage to fire landed *after* the model had finished answering — the
 * one moment where a handoff is pointless, because the work it would carry across is
 * already done.
 *
 * So this half of the rule is just "over the line". The other half — that
 * the model is working *right now* — is a fact about the open browser connection rather
 * than about the recording, so it is asked at the point of use, in bridge.ts. That is what
 * keeps a stale 500k chat quiet when it is merely opened: it is over the line all day, and
 * nothing is running in it. The existing continuation transaction is the durable authority
 * once a stopped/settled chat asks for its handoff prompt; pre-barrier refusal owns no durable
 * state and may be attempted by a later generation.
 */
export function autoCompactionReady(summary: SessionSummary | null | undefined): boolean {
  if (!summary) return false;
  const config = getConfig().compaction;
  return config.auto && config.autoTokens > 0 && summary.contextTokens >= config.autoTokens;
}

/**
 * Appends one event and returns it with its assigned sequence number.
 *
 * The sequence number, not the timestamp, defines order: the extension and the MCP
 * server both feed this store and their clocks are the same clock, but events can
 * arrive out of order when the browser batches its observations.
 */
export function appendEvent(sessionId: string, event: NewSessionEvent): Promise<SessionEvent> {
  return ensureOpen(sessionId).then((entry) => {
    // Sequence assignment, durable append and projection update are one serial operation.
    // The previous implementation incremented nextSeq and mutated the summary *before* the
    // append succeeded. A disk failure therefore created a permanent seq gap and could even
    // persist meta.json claiming events/tool calls/tokens that never existed in events.jsonl.
    // Keep the append-only journal authoritative: nothing in memory advances until the line
    // is on disk.
    const write = entry.queue.then(async () => {
      const full = { ...event, seq: entry.nextSeq } as SessionEvent;
      const line = `${JSON.stringify(full)}\n`;
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        throw new Error('Session event is too large to store');
      }
      try {
        await fs.appendFile(path.join(sessionDir(sessionId), 'events.jsonl'), line, 'utf8');
      } catch (error) {
        // Windows/filesystem errors are allowed to be uncertain commits: the write may have
        // reached disk before the promise rejected. Reconcile the authoritative tail before
        // another queued writer is admitted. A complete line is treated as committed; a torn
        // line is sealed and the normal browser/MCP retry may safely reuse that absent seq.
        await sealTornTail(sessionId);
        const durableSeq = await lastSeqOnDisk(sessionId);
        if (durableSeq < full.seq) {
          entry.nextSeq = Math.max(entry.nextSeq, durableSeq + 1);
          throw error;
        }
        logWarn(`session ${sessionId}: append reported an error after sequence ${full.seq} was already durable`);
      }
      entry.nextSeq += 1;
      entry.tail.push(full);
      if (entry.tail.length > MAX_EVENT_TAIL) entry.tail.splice(0, entry.tail.length - MAX_EVENT_TAIL);
      applyToSummary(entry.summary, full);
      entry.historySeq = full.seq;
      scheduleMeta(entry);
      return full;
    });
    entry.queue = write.then(
      () => undefined,
      (err: Error) => {
        logError(`session append failed: ${err.message}`);
      }
    );
    return write;
  });
}

/**
 * Creates or revises one canonical ChatGPT message by its own stable id.
 *
 * `seq` is the revision/cursor sequence so an incremental reader notices an update. `origin`
 * preserves the sequence/time position where that stable website message first appeared, so
 * revisions cannot move either a user response boundary or assistant prose through later work.
 */
export function upsertMessageEvent(
  sessionId: string,
  event: NewMessageEvent,
  options: { preferTime?: boolean } = {}
): Promise<{ event: MessageEvent; changed: boolean }> {
  const directKey = messageKey(event as MessageEvent);
  if (!directKey) throw new Error('Canonical message update requires ChatGPT messageId');
  return ensureOpen(sessionId).then((entry) => {
    const write = entry.queue.then(async () => {
      const key = directKey;
      const previous = entry.messages.get(key);
      // Final is terminal for one canonical ChatGPT message. The page can briefly re-report
      // an older streaming DOM snapshot after settling/remounting; accepting that snapshot
      // would turn a completed answer back into a partial one and could replace its text.
      if (
        previous?.kind === 'assistant_message' &&
        event.kind === 'assistant_message' &&
        (previous.final === true || previous.state === 'final') &&
        event.final !== true &&
        event.state !== 'final'
      ) {
        return { event: previous, changed: false };
      }

      // Message bodies can be hundreds of kilobytes. The old path JSON.stringify-compared the
      // same StoredText pair once while preserving rendered HTML and then again while deciding
      // whether the observation changed at all. StoredText has a fixed five-field shape, so a
      // direct comparison is exact and avoids repeated full-string serialisation/allocation on
      // every streaming observation.
      const sameMessage =
        previous?.kind === event.kind && storedTextEqual(previous.message, event.message);

      const nextEvent: NewMessageEvent =
        previous?.kind === 'assistant_message' && event.kind === 'assistant_message'
          ? {
              ...event,
              // The producer already supplied the stable website identity. Keep that exact
              // identity through every revision; a different id is a different logical row.
              messageId: previous.messageId,
              // `final` is a compatibility mirror of state, not an independent truth.
              state: event.state === 'final' || event.final === true ? 'final' : 'streaming',
              final: event.state === 'final' || event.final === true,
              // Goal eligibility is an accepted fact about this stable reply, not a property a
              // later sparse page snapshot may retract. This is what makes a 503/reload replay
              // re-offer the same durable obligation instead of silently dropping it.
              ...(previous.goalEligible === true ? { goalEligible: true } : {}),
              // A sparse re-observation of the same prose must not throw away the richer
              // representation we already captured. If the prose itself changed, omitting
              // HTML deliberately falls back to the new plain text instead of showing stale
              // markup for different content.
              ...(event.renderedHtml === undefined && sameMessage
                ? { renderedHtml: previous.renderedHtml }
                : {})
            }
          : event;
      // A canonical assistant message belongs to exactly one generation permanently. Ownership
      // may still be *promoted* from "not known yet" to a durable generation id when the
      // recorder learns it late, but a settled assistant answer may never move to another turn.
      // User messages are different: their page-side turn marker is a boundary hint and can be
      // revised as ChatGPT re-homes the same stable user object, so preserve that existing
      // behaviour instead of freezing it under the first marker we happened to observe.
      //
      // Live 2026-08-21, session `ce135bff`: ChatGPT re-mounted its stop control for two
      // seconds well after a page load, the extension minted generation `g-11kz85q585v4s-0-1`
      // for it, and the re-observation of the already finished 08:40:34 answer re-filed that
      // answer under a turn that started at 08:45:22. The consequences are not cosmetic — the
      // answer is torn away from the eight tool calls that produced it, so the extension can
      // no longer prove its reconstruction of that turn complete and drops the whole response
      // back to ChatGPT's native rendering, and the desktop timeline draws an empty turn with
      // a five-minute-old message inside it.
      const settledTurnId =
        previous?.kind === 'assistant_message' && nextEvent.kind === 'assistant_message'
          ? previous.turnId ?? nextEvent.turnId ?? undefined
          : nextEvent.turnId ?? undefined;
      if (
        previous &&
        previous.kind === nextEvent.kind &&
        sameMessage &&
        (previous.kind !== 'assistant_message' ||
          (nextEvent.kind === 'assistant_message' &&
            storedTextEqual(previous.renderedHtml, nextEvent.renderedHtml) &&
            previous.state === nextEvent.state &&
            previous.final === nextEvent.final &&
            previous.goalEligible === nextEvent.goalEligible)) &&
        (previous.turnId ?? undefined) === settledTurnId &&
        (nextEvent.agent === undefined || previous.agent === nextEvent.agent) &&
        (!options.preferTime || previous.time === nextEvent.time)
      ) {
        return { event: previous, changed: false };
      }
      const full = {
        ...nextEvent,
        // First appearance is chronology; current seq is delivery cursor/revision.
        // A page-model authored timestamp is stronger than a DOM first-sight timestamp. The
        // recorder opts into that correction explicitly; ordinary revisions still keep the
        // original first-seen time forever.
        time: options.preferTime ? nextEvent.time : previous?.time ?? nextEvent.time,
        ...(settledTurnId === undefined ? {} : { turnId: settledTurnId }),
        ...(previous?.agent && !nextEvent.agent ? { agent: previous.agent } : {}),
        ...(nextEvent.kind === 'assistant_message' || nextEvent.kind === 'user_message'
          ? { origin: previous?.kind === nextEvent.kind ? previous.origin ?? previous.seq : entry.nextSeq }
          : {}),
        seq: entry.nextSeq
      } as MessageEvent;

      await writeCanonicalMessage(sessionId, key, full);

      entry.nextSeq += 1;
      entry.messages.set(key, full);
      if (!previous) {
        applyToSummary(entry.summary, full);
      } else {
        // A revision is not another logical event. Only its text/token weight and recency
        // replace what the previous snapshot contributed to the session projection.
        const delta = eventTokens(full) - eventTokens(previous);
        entry.summary.estimatedTokens = Math.max(0, entry.summary.estimatedTokens + delta);
        entry.summary.contextTokens = Math.max(0, entry.summary.contextTokens + delta);
        entry.summary.updatedAt = Math.max(entry.summary.updatedAt, nextEvent.time);
        if (full.kind === 'assistant_message' && (full.final === true || full.state === 'final')) {
          entry.summary.lastAssistantFinalAt = Math.max(
            entry.summary.lastAssistantFinalAt ?? 0,
            nextEvent.time
          );
        }
        if (full.agent && !entry.summary.agents.includes(full.agent)) entry.summary.agents.push(full.agent);
      }
      entry.historySeq = full.seq;
      scheduleMeta(entry);
      return { event: full, changed: true };
    });
    entry.queue = write.then(
      () => undefined,
      (err: Error) => logError(`session message upsert failed: ${err.message}`)
    );
    return write;
  });
}

// ------------------------------------------------------------------- read

export interface ReadOptions {
  /** First sequence number to return, inclusive. */
  from?: number;
  limit?: number;
  kinds?: readonly SessionEvent['kind'][];
  agent?: string;
}

/**
 * Reads events back.
 *
 * A malformed line is skipped and counted rather than throwing: the whole point of
 * an append-only log is that a half-written final line costs one event, not the
 * session. Reading the file in one go is fine at the sizes the caps allow.
 */
export async function readEvents(sessionId: string, options: ReadOptions = {}): Promise<SessionEvent[]> {
  assertSessionId(sessionId);
  await flushSession(sessionId);
  const from = options.from ?? 0;
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;

  // /activity is an incremental feed. Canonical messages use their latest revision seq for
  // the cursor while preserving their first-appearance time/origin for chronology.
  const active = open.get(sessionId);
  if (options.from !== undefined && active) {
    if (from >= active.nextSeq) return [];
    const cacheFloor = Math.max(1, active.nextSeq - MAX_EVENT_TAIL);
    if (from >= cacheFloor) {
      const cached: SessionEvent[] = [...active.tail, ...active.messages.values()].filter((parsed) => {
        if (parsed.seq < from) return false;
        if (options.kinds && !options.kinds.includes(parsed.kind)) return false;
        if (options.agent && parsed.agent !== options.agent) return false;
        return true;
      });
      // `from` is a sequence cursor. Page in sequence order first and only then apply the
      // presentation chronology inside that bounded page; otherwise chronology may move a later
      // row ahead of an earlier seq at the slice boundary and advancing the cursor would skip it.
      const page = cached.sort((left, right) => left.seq - right.seq).slice(0, limit);
      return chronological(page);
    }
  }
  let raw: string;
  try {
    raw = await fs.readFile(path.join(sessionDir(sessionId), 'events.jsonl'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') raw = '';
    else throw err;
  }
  const messages = active?.messages ?? (await readCanonicalMessages(sessionId));
  const canonicalKeys = new Set(messages.keys());
  const out: SessionEvent[] = [];
  let damaged = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: SessionEvent;
    try {
      parsed = JSON.parse(line) as SessionEvent;
    } catch {
      damaged++;
      continue;
    }
    if (typeof parsed?.seq !== 'number' || typeof parsed?.kind !== 'string') {
      damaged++;
      continue;
    }
    if (parsed.seq < from) continue;
    if (options.kinds && !options.kinds.includes(parsed.kind)) continue;
    if (options.agent && parsed.agent !== options.agent) continue;
    // Once a message has a canonical record, a pre-1.8 append-only snapshot with the same
    // ChatGPT identity is legacy journal history, not another transcript item.
    if ((parsed.kind === 'user_message' || parsed.kind === 'assistant_message') && messageKey(parsed) && canonicalKeys.has(messageKey(parsed)!)) {
      continue;
    }
    out.push(parsed);
  }
  for (const message of messages.values()) {
    if (message.seq < from) continue;
    if (options.kinds && !options.kinds.includes(message.kind)) continue;
    if (options.agent && message.agent !== options.agent) continue;
    out.push(message);
  }
  if (damaged > 0) logWarn(`session ${sessionId}: skipped ${damaged} unreadable event line(s)`);
  // `seq` is the immutable cursor domain; logical chronology is only allowed to reorder a
  // bounded turn whose `turn_start` is present in this read window. Global time sorting used
  // to move unrelated/replayed page history across turn boundaries and disagreed with the
  // extension renderer, which already used the shared rule. One function now defines the
  // transcript order everywhere.
  if (options.from !== undefined) {
    const page = out.sort((left, right) => left.seq - right.seq).slice(0, limit);
    return chronological(page);
  }
  return chronological(out).slice(0, limit);
}

/**
 * Reads only the newest matching presentation window without materialising the whole JSONL journal.
 *
 * This exists for UI/default-history tails. Full-text search, call expansion and explicit old
 * cursors still use `readEvents()` because they genuinely need older rows. The scan walks the
 * journal backwards and stops once it has enough matching rows (or reaches the bounded byte
 * budget), so `limit: 1` cannot turn into a 40 MB read. Canonical messages are merged by seq.
 */
export async function readRecentEvents(
  sessionId: string,
  limit: number,
  options: Pick<ReadOptions, 'kinds' | 'agent'> & { maxBytes?: number } = {}
): Promise<SessionEvent[]> {
  assertSessionId(sessionId);
  await flushSession(sessionId);
  const cap = Math.max(1, Math.min(MAX_EVENT_TAIL, Math.floor(limit)));
  const active = open.get(sessionId);
  const needsMessages =
    !options.kinds || options.kinds.includes('user_message') || options.kinds.includes('assistant_message');
  const messages = needsMessages ? active?.messages ?? (await readCanonicalMessages(sessionId)) : new Map<string, MessageEvent>();
  const canonicalKeys = new Set(messages.keys());
  // Pre-canonical sessions could append every streaming revision of one stable website
  // message to events.jsonl. This reader builds a *presentation* tail, so those revisions are
  // one logical row here just as a canonical message is one row today. Because the journal is
  // scanned newest-first, the first key seen is the latest revision; duplicates must not spend
  // the row cap or a long old answer can hide every earlier user turn from Goal/history tails.
  const legacyMessageKeys = new Set<string>();
  const rawTail: SessionEvent[] = [];
  let damaged = 0;
  const readBudget = Math.max(64 * 1024, Math.min(MAX_RECENT_READ_BYTES, options.maxBytes ?? MAX_RECENT_READ_BYTES));

  const accept = (line: Buffer): void => {
    if (rawTail.length >= cap || line.length === 0) return;
    if (line.length > MAX_LINE_BYTES) {
      damaged += 1;
      return;
    }
    let parsed: SessionEvent;
    try {
      parsed = JSON.parse(line.toString('utf8')) as SessionEvent;
    } catch {
      damaged += 1;
      return;
    }
    if (typeof parsed?.seq !== 'number' || typeof parsed?.kind !== 'string') {
      damaged += 1;
      return;
    }
    if (options.kinds && !options.kinds.includes(parsed.kind)) return;
    if (options.agent && parsed.agent !== options.agent) return;
    if (parsed.kind === 'user_message' || parsed.kind === 'assistant_message') {
      const key = messageKey(parsed);
      if (key) {
        if (canonicalKeys.has(key) || legacyMessageKeys.has(key)) return;
        legacyMessageKeys.add(key);
      }
    }
    rawTail.push(parsed);
  };

  const file = path.join(sessionDir(sessionId), 'events.jsonl');
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(file, 'r');
    let cursor = (await handle.stat()).size;
    let bytes = 0;
    let carry = Buffer.alloc(0);
    while (cursor > 0 && rawTail.length < cap && bytes < readBudget) {
      const wanted = Math.min(64 * 1024, cursor, readBudget - bytes);
      if (wanted <= 0) break;
      cursor -= wanted;
      const buffer = Buffer.allocUnsafe(wanted);
      const { bytesRead } = await handle.read(buffer, 0, wanted, cursor);
      const joined = Buffer.concat([buffer.subarray(0, bytesRead), carry]);
      bytes += bytesRead;
      const firstNewline = joined.indexOf(0x0a);
      if (firstNewline < 0) {
        // A corrupt/no-newline tail used to repeatedly copy the complete 8 MiB budget:
        // 64 KiB + 128 KiB + ... . Retain only one maximum event while seeking a boundary.
        if (joined.length > MAX_LINE_BYTES + 1) damaged += 1;
        carry = joined.subarray(0, Math.min(joined.length, MAX_LINE_BYTES + 1));
        continue;
      }
      carry = joined.subarray(0, firstNewline);
      const complete = joined.subarray(firstNewline + 1);
      let endAt = complete.length;
      for (let at = complete.length - 1; at >= 0 && rawTail.length < cap; at--) {
        if (complete[at] !== 0x0a) continue;
        const line = complete.subarray(at + 1, endAt);
        if (line.length > 0) accept(line);
        endAt = at;
      }
      if (rawTail.length < cap && endAt > 0) accept(complete.subarray(0, endAt));
    }
    if (cursor === 0 && rawTail.length < cap && carry.length > 0) accept(carry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }

  const candidates: SessionEvent[] = [...rawTail];
  for (const message of messages.values()) {
    if (options.kinds && !options.kinds.includes(message.kind)) continue;
    if (options.agent && message.agent !== options.agent) continue;
    candidates.push(message);
  }
  candidates.sort((left, right) => left.seq - right.seq);
  const selected = candidates.slice(Math.max(0, candidates.length - cap));
  if (damaged > 0) logWarn(`session ${sessionId}: skipped ${damaged} unreadable recent event line(s)`);
  return chronological(selected);
}

/**
 * Atomically keeps only the supplied tool calls in an Unattributed activity session.
 *
 * This is deliberately not a general history editor. 1.8.2 uses it for one deterministic
 * migration: calls whose exact request-id owner is now known are copied to that owner's
 * session, then removed from the legacy Unattributed bucket. Unknown calls remain under the
 * same local session id. Re-sequencing is safe here because this bucket has no ChatGPT
 * conversation, canonical messages, or turn lifecycle: it is only a holding area for calls.
 */
export async function rewriteUnattributedToolCalls(
  sessionId: string,
  calls: readonly Extract<SessionEvent, { kind: 'tool_call' }>[],
  scannedThroughSeq: number
): Promise<void> {
  assertSessionId(sessionId);
  const entry = await ensureOpen(sessionId);
  const rewrite = entry.queue.then(async () => {
    if (entry.summary.conversationId !== null || entry.summary.title !== 'Unattributed activity') {
      throw new Error(`Session ${sessionId} is not an Unattributed activity bucket`);
    }

    // `calls` is the repairer's snapshot of rows that were still unattributed. New MCP calls can
    // append to this same holding bucket while the repair is pre-copying assets/destinations. The
    // session queue orders those appends before this rewrite, but blindly writing only the old
    // snapshot would then erase them. Read the now-serialized journal and retain every tool call
    // that appeared after the snapshot's high-water seq. Appends that arrive after this operation
    // has been queued naturally run after the rewrite and receive fresh sequence numbers.
    const concurrentCalls: Extract<SessionEvent, { kind: 'tool_call' }>[] = [];
    try {
      const raw = await fs.readFile(path.join(sessionDir(sessionId), 'events.jsonl'), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as SessionEvent;
          if (event.kind === 'tool_call' && event.seq > scannedThroughSeq) concurrentCalls.push(event);
        } catch {
          // Legacy damaged rows were already excluded by the deterministic repair snapshot. The
          // general reader reports those separately; do not make this narrowly-scoped migration
          // fail after all destination copies succeeded because of an unrelated torn legacy line.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const start: SessionEvent = {
      seq: 1,
      time: entry.summary.startedAt,
      source: 'app',
      kind: 'session_start',
      conversationId: null,
      title: entry.summary.title
    };
    const retainedCalls = [...calls, ...concurrentCalls].sort((left, right) => left.seq - right.seq);
    const kept: SessionEvent[] = [start, ...retainedCalls.map((event, index) => ({ ...event, seq: index + 2 }))];

    const target = path.join(sessionDir(sessionId), 'events.jsonl');
    const tmp = `${target}.repair-${process.pid}-${Date.now()}.tmp`;
    await fs.writeFile(tmp, kept.map((event) => `${JSON.stringify(event)}\n`).join(''), 'utf8');
    await fs.rename(tmp, target);

    const staged: SessionSummary = {
      ...entry.summary,
      updatedAt: entry.summary.startedAt,
      events: 0,
      userMessages: 0,
      toolCalls: 0,
      lastToolCallAt: null,
      lastAssistantFinalAt: null,
      processExitNonzero: 0,
      toolRejected: 0,
      toolInternalErrors: 0,
      errors: 0,
      estimatedTokens: 0,
      contextTokens: 0,
      lastHandoffId: null,
      lastHandoffAt: null,
      lastCommittedResumeHandoffId: null,
      lastTurnOutcome: null,
      agents: []
    };
    for (const event of kept) applyToSummary(staged, event);
    const rewrittenHistorySeq = kept.at(-1)?.seq ?? 0;
    await writeSummary(staged, rewrittenHistorySeq);

    Object.assign(entry.summary, staged);
    entry.nextSeq = kept.length + 1;
    entry.historySeq = rewrittenHistorySeq;
    entry.tail = kept.slice(-MAX_EVENT_TAIL);
    entry.metaDirty = false;
  });
  entry.queue = rewrite.then(
    () => undefined,
    (err: Error) => logError(`session unattributed repair failed: ${err.message}`)
  );
  await rewrite;
}

function normalizeSummary(id: string, raw: string): MetaCheckpoint | null {
  try {
    const parsed = JSON.parse(raw) as PersistedSummary;
    if (parsed?.id !== id) return null;
    const historySeq =
      Number.isSafeInteger(parsed[META_HISTORY_SEQ]) && (parsed[META_HISTORY_SEQ] as number) >= 0
        ? (parsed[META_HISTORY_SEQ] as number)
        : null;
    const { [META_HISTORY_SEQ]: _historySeq, ...publicFields } = parsed;
    const publicSummary = publicFields as SessionSummary;
    // A meta.json written before agents, app-opened chats or the session lineage existed
    // has no such field. A session recorded before the lineage was a single chat by
    // definition, and everything it holds was in that chat's context, so both defaults are
    // the truth rather than a placeholder.
    const outcomeCountersMissing =
      typeof publicSummary.processExitNonzero !== 'number' ||
      typeof publicSummary.toolRejected !== 'number' ||
      typeof publicSummary.toolInternalErrors !== 'number';
    const activityBoundaryMissing = !Object.prototype.hasOwnProperty.call(publicSummary, 'lastAssistantFinalAt');
    return {
      historySeq,
      outcomeCountersMissing,
      activityBoundaryMissing,
      summary: {
        ...publicSummary,
        // Keep in-place increments numeric until the forced rebuild supplies the real values.
        processExitNonzero: publicSummary.processExitNonzero ?? 0,
        toolRejected: publicSummary.toolRejected ?? 0,
        toolInternalErrors: publicSummary.toolInternalErrors ?? 0,
        // A three-minute display clock is not worth replaying every legacy session during the
        // attachment-catalog scan. The next real tool call sets the exact value immediately.
        lastToolCallAt:
          typeof publicSummary.lastToolCallAt === 'number' && Number.isFinite(publicSummary.lastToolCallAt)
            ? publicSummary.lastToolCallAt
            : null,
        lastAssistantFinalAt:
          typeof publicSummary.lastAssistantFinalAt === 'number' && Number.isFinite(publicSummary.lastAssistantFinalAt)
            ? publicSummary.lastAssistantFinalAt
            : null,
        agents: Array.isArray(publicSummary.agents) ? publicSummary.agents : [],
        origin: publicSummary.origin ?? null,
        chatIds: Array.isArray(publicSummary.chatIds)
          ? publicSummary.chatIds
          : publicSummary.conversationId
            ? [publicSummary.conversationId]
            : [],
        contextTokens:
          typeof publicSummary.contextTokens === 'number' ? publicSummary.contextTokens : publicSummary.estimatedTokens,
        // Older summaries predate successful-resume provenance. Missing means unknown, never
        // "use lastHandoffId": capture publication happens before the continuation rebind.
        lastCommittedResumeHandoffId:
          typeof publicSummary.lastCommittedResumeHandoffId === 'string' &&
          /^[0-9a-z-]{8,64}$/i.test(publicSummary.lastCommittedResumeHandoffId)
            ? publicSummary.lastCommittedResumeHandoffId
            : null
      }
    };
  } catch {
    return null;
  }
}

async function readMetaCheckpoint(id: string): Promise<MetaCheckpoint | null> {
  const dir = sessionDir(id);
  try {
    const primary = normalizeSummary(id, await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
    if (primary) return primary;
  } catch {
    // Try the last validated checkpoint below.
  }
  try {
    const backup = normalizeSummary(id, await fs.readFile(path.join(dir, 'meta.backup.json'), 'utf8'));
    if (backup) {
      logWarn(`session ${id}: primary meta.json unreadable; using the last validated checkpoint`);
      return backup;
    }
  } catch {
    // No recovery checkpoint.
  }
  logWarn(`session ${id}: no valid metadata projection; refusing to treat it as an empty session`);
  return null;
}

async function readMeta(id: string): Promise<SessionSummary | null> {
  return (await readMetaCheckpoint(id))?.summary ?? null;
}

function addAttachment(map: Map<string, Set<string>>, conversationId: string, sessionId: string): void {
  if (!conversationId) return;
  const ids = map.get(conversationId) ?? new Set<string>();
  ids.add(sessionId);
  map.set(conversationId, ids);
}

function removeAttachment(map: Map<string, Set<string>>, conversationId: string, sessionId: string): void {
  if (!conversationId) return;
  const ids = map.get(conversationId);
  if (!ids) return;
  ids.delete(sessionId);
  if (ids.size === 0) map.delete(conversationId);
}

function indexSummary(catalog: AttachmentCatalog, summary: SessionSummary): void {
  catalog.summaries.set(summary.id, { ...summary, chatIds: [...summary.chatIds], agents: [...summary.agents] });
  if (summary.conversationId) addAttachment(catalog.current, summary.conversationId, summary.id);
  for (const chatId of summary.chatIds) addAttachment(catalog.historical, chatId, summary.id);
}

function unindexSummary(catalog: AttachmentCatalog, summary: SessionSummary): void {
  catalog.summaries.delete(summary.id);
  const orderedAt = catalog.orderedIds.indexOf(summary.id);
  if (orderedAt >= 0) catalog.orderedIds.splice(orderedAt, 1);
  if (summary.conversationId) removeAttachment(catalog.current, summary.conversationId, summary.id);
  for (const chatId of summary.chatIds) removeAttachment(catalog.historical, chatId, summary.id);
}

function insertSummaryOrder(catalog: AttachmentCatalog, summary: SessionSummary): void {
  let low = 0;
  let high = catalog.orderedIds.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const other = catalog.summaries.get(catalog.orderedIds[middle]!);
    if (!other || compareSummariesNewestFirst(summary, other) < 0) high = middle;
    else low = middle + 1;
  }
  catalog.orderedIds.splice(low, 0, summary.id);
}

/** Refreshes only the summary projection; attachment ownership is unchanged. */
function publishCachedSummary(summary: SessionSummary, reorder: boolean): void {
  const catalog = attachmentCatalog;
  if (!catalog) return;
  const clone = { ...summary, chatIds: [...summary.chatIds], agents: [...summary.agents] };
  catalog.summaries.set(summary.id, clone);
  if (!reorder) return;
  const orderedAt = catalog.orderedIds.indexOf(summary.id);
  if (orderedAt >= 0) catalog.orderedIds.splice(orderedAt, 1);
  insertSummaryOrder(catalog, clone);
}

/** Update the derived index only after an attachment mutation is durable. */
function publishAttachmentSummary(summary: SessionSummary): void {
  attachmentEpoch += 1;
  missingCurrentConversations.delete(summary.conversationId ?? '');
  const catalog = attachmentCatalog;
  if (!catalog) return;
  const previous = catalog.summaries.get(summary.id);
  if (previous) unindexSummary(catalog, previous);
  indexSummary(catalog, summary);
  insertSummaryOrder(catalog, catalog.summaries.get(summary.id)!);
}

/** Remove one durable session from the derived ownership index. */
function publishAttachmentRemoval(sessionId: string): void {
  attachmentEpoch += 1;
  const catalog = attachmentCatalog;
  if (!catalog) return;
  const previous = catalog.summaries.get(sessionId);
  if (previous) unindexSummary(catalog, previous);
}

/** A closing live session must become the durable ordered row before its live overlay vanishes. */
function publishClosedSummary(summary: SessionSummary): void {
  // If the first catalog pass already read this row before close, force that in-flight snapshot
  // to retry. Once a catalog exists, this is just one binary-positioned row update.
  attachmentEpoch += 1;
  publishCachedSummary(summary, true);
}

function newAttachmentCatalog(): AttachmentCatalog {
  return { summaries: new Map(), orderedIds: [], current: new Map(), historical: new Map() };
}

/**
 * Builds the identity catalog from every valid session metadata folder, without the UI's
 * 5,000-session cap. If create/rebind/delete lands while the pass is reading disk, its epoch
 * change invalidates the pass and it is repeated, so a completed catalog is never a snapshot
 * that silently predates a concurrent ownership mutation.
 */
async function ensureAttachmentCatalog(): Promise<AttachmentCatalog> {
  if (attachmentCatalog) return attachmentCatalog;
  if (attachmentCatalogLoading) return attachmentCatalogLoading;
  const loading = (async () => {
    for (;;) {
      assertReady();
      const epoch = attachmentEpoch;
      let names: string[];
      try {
        names = await fs.readdir(root);
      } catch (error) {
        // A fresh install legitimately has no sessions directory yet. Any other failure is not
        // evidence that the durable catalog is empty. Caching EBUSY/EACCES/IO errors here poisons
        // every ownership, retention and latest-handoff lookup for the rest of the process.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = [];
        else throw error;
      }
      const catalog = newAttachmentCatalog();
      const candidates = names.filter((name) => /^[0-9a-z-]{8,64}$/i.test(name));
      for (let offset = 0; offset < candidates.length; offset += ATTACHMENT_CATALOG_READ_CONCURRENCY) {
        const summaries = await Promise.all(
          candidates.slice(offset, offset + ATTACHMENT_CATALOG_READ_CONCURRENCY).map(async (name) => {
            const live = open.get(name);
            const snapshot = live ? null : await readDurableSnapshot(name).catch(() => null);
            return live?.summary ?? snapshot?.summary ?? null;
          })
        );
        for (const summary of summaries) if (summary) indexSummary(catalog, summary);
      }
      catalog.orderedIds = [...catalog.summaries.values()]
        .sort(compareSummariesNewestFirst)
        .map((summary) => summary.id);
      if (attachmentEpoch !== epoch) continue;
      attachmentCatalog = catalog;
      return catalog;
    }
  })();
  attachmentCatalogLoading = loading;
  try {
    return await loading;
  } finally {
    if (attachmentCatalogLoading === loading) attachmentCatalogLoading = null;
  }
}

/**
 * Every readable session, newest first. Live summaries win over what is on disk.
 *
 * Legacy/model-facing bounded list. Do not use this for correctness properties that promise
 * to see every retained session; identity, latest-handoff recovery and retention use the
 * uncapped process catalog instead.
 */
async function readAllSummaries(): Promise<SessionSummary[]> {
  assertReady();
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const summaries: SessionSummary[] = [];
  let scanned = 0;
  for (const name of names) {
    if (!/^[0-9a-z-]{8,64}$/i.test(name)) continue;
    if (++scanned > MAX_SCANNED_SESSIONS) {
      logWarn(`session store: more than ${MAX_SCANNED_SESSIONS} session folders; older ones were not scanned`);
      break;
    }
    const live = open.get(name);
    const summary = live ? live.summary : await readMeta(name);
    if (summary) summaries.push({ ...summary });
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}

/**
 * Every valid session summary, with no maintenance/UI scan cap.
 *
 * Most callers deliberately stop after 5,000 folders so a pathological history cannot make a
 * routine UI refresh unbounded. `latestHandoff()` is different: its answer is a recovery
 * authority. Missing the newest resumable handoff because `readdir()` happened to return that
 * folder after an arbitrary cap can resume the wrong work. Keep the expensive path explicit
 * and use it only where "every session" is part of the contract.
 */
async function readEverySummary(): Promise<SessionSummary[]> {
  const catalog = await ensureAttachmentCatalog();
  const summaries = new Map<string, SessionSummary>();
  for (const summary of catalog.summaries.values()) summaries.set(summary.id, summary);
  // Live projections are authoritative between debounced meta writes.
  for (const entry of open.values()) summaries.set(entry.summary.id, entry.summary);
  return [...summaries.values()].map((summary) => ({ ...summary })).sort(compareSummariesNewestFirst);
}

export interface SessionListCursor {
  updatedAt: number;
  id: string;
}

export interface SessionPage {
  sessions: SessionSummary[];
  total: number;
  nextCursor: SessionListCursor | null;
}

function compareSummariesNewestFirst(left: SessionSummary, right: SessionSummary): number {
  if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
}

function comesAfterCursor(summary: SessionSummary, cursor: SessionListCursor): boolean {
  return summary.updatedAt < cursor.updatedAt || (summary.updatedAt === cursor.updatedAt && summary.id < cursor.id);
}

/**
 * One bounded UI page from a process-lifetime summary index.
 *
 * The first call pays the one metadata discovery pass that identity already needs. Every hot
 * refresh after that is memory-only in the number of retained summaries plus the tiny live
 * overlay; no coalesced recorder tick rereads thousands of meta.json files. The cursor is the
 * last visible sort key rather than an offset, so a live session moving to the front cannot make
 * history pagination duplicate/skip the boundary it already crossed.
 */
export async function listSessionPage(options: {
  limit?: number;
  cursor?: SessionListCursor;
} = {}): Promise<SessionPage> {
  const catalog = await ensureAttachmentCatalog();
  const limit = Math.max(1, Math.min(MAX_LISTED_SESSIONS, Math.floor(options.limit ?? MAX_LISTED_SESSIONS)));
  const openIds = new Set(open.keys());
  const candidates: SessionSummary[] = [];

  // Open summaries are authoritative between debounced metadata writes. There are normally one
  // or a handful, so overlay them explicitly instead of rebuilding/sorting every retained row.
  for (const entry of open.values()) {
    if (options.cursor && !comesAfterCursor(entry.summary, options.cursor)) continue;
    candidates.push({ ...entry.summary, chatIds: [...entry.summary.chatIds], agents: [...entry.summary.agents] });
  }

  // The durable order is already maintained incrementally. Collect only one page plus one
  // sentinel; a hot first-page refresh therefore stays O(page + open sessions), even with
  // thousands of retained sessions. Deep pages scan to their cursor only when the user asks.
  let durableEligible = 0;
  let durableHasMore = false;
  for (const id of catalog.orderedIds) {
    if (openIds.has(id)) continue;
    const summary = catalog.summaries.get(id);
    if (!summary || (options.cursor && !comesAfterCursor(summary, options.cursor))) continue;
    if (durableEligible > limit) {
      durableHasMore = true;
      break;
    }
    candidates.push({ ...summary, chatIds: [...summary.chatIds], agents: [...summary.agents] });
    durableEligible += 1;
  }

  candidates.sort(compareSummariesNewestFirst);
  const sessions = candidates.slice(0, limit);
  const last = sessions.at(-1);
  const hasMore = durableHasMore || candidates.length > sessions.length;
  const nextCursor = hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null;
  let total = catalog.summaries.size;
  for (const id of openIds) if (!catalog.summaries.has(id)) total += 1;
  return { sessions, total, nextCursor };
}

/** Newest first, capped for older internal/UI callers. */
export async function listSessions(): Promise<SessionSummary[]> {
  return (await listSessionPage({ limit: MAX_LISTED_SESSIONS })).sessions;
}

/** Full bounded compatibility/model-facing view. Never use it for retention or identity. */
export async function listAllSessions(): Promise<SessionSummary[]> {
  return readAllSummaries();
}

/**
 * Finds the durable session that owns one ChatGPT conversation id.
 *
 * `listSessions()` is intentionally capped for the UI and therefore must never be used as an
 * ownership index: once a chat falls outside the UI's current display cap, doing so silently turns "not in
 * the list" into "never existed" and can fork a second session for the same conversation.
 *
 * Page/browser reopen paths use the default current-only lookup. A proven late MCP request may
 * opt into `includeHistorical` so a conversation that was superseded by Compact & Resume still
 * resolves to the durable session whose `chatIds` lineage contains it. Ambiguity fails closed.
 */
export async function findSessionByConversation(
  conversationId: string,
  options: { includeHistorical?: boolean; requireUnique?: boolean } = {}
): Promise<SessionSummary | null> {
  if (!conversationId) return null;
  if (options.includeHistorical !== true && missingCurrentConversations.has(conversationId)) return null;
  const catalog = await ensureAttachmentCatalog();
  const currentIds = new Set(catalog.current.get(conversationId) ?? []);
  // A create is deliberately visible to this process from the moment its live entry exists.
  // That prevents a concurrent recorder batch from manufacturing a second session while the
  // first session's initial files are still being written. Rebinds never expose B here early:
  // they mutate the live summary only after durable meta says B.
  for (const [id, entry] of open) {
    if (entry.summary.conversationId === conversationId) currentIds.add(id);
  }
  const current = (
    await Promise.all(
      [...currentIds].map((id) => getSession(id).catch(() => null))
    )
  )
    .filter((summary): summary is SessionSummary => summary?.conversationId === conversationId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (current.length === 1) return current[0] ?? null;
  if (current.length > 1) {
    if (options.requireUnique === true) {
      logWarn(`session store: conversation ${conversationId} is current on ${current.length} sessions; refusing safety-sensitive lookup`);
      return null;
    }
    // Browser/page reopen semantics historically used the newest current session. Keep that
    // deterministic choice rather than manufacturing a third session. Safety-sensitive
    // callers (orphan retirement) opt into requireUnique above.
    return current[0] ?? null;
  }
  if (options.includeHistorical !== true) {
    rememberMissingCurrentConversation(conversationId);
    return null;
  }
  const historicalIds = new Set(catalog.historical.get(conversationId) ?? []);
  for (const [id, entry] of open) {
    if (entry.summary.chatIds.includes(conversationId)) historicalIds.add(id);
  }
  const historical = (
    await Promise.all(
      [...historicalIds].map((id) => getSession(id).catch(() => null))
    )
  )
    .filter((summary): summary is SessionSummary => summary?.chatIds.includes(conversationId) === true)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (historical.length === 1) return historical[0] ?? null;
  if (historical.length > 1) {
    logWarn(`session store: conversation ${conversationId} appears in ${historical.length} session lineages; refusing to guess`);
  }
  return null;
}

/**
 * Filesystem time of the newest durable mutation belonging to a session.
 *
 * Session event timestamps describe when an action happened, not when it finally reached
 * disk. A five-minute MCP call therefore appends today with a `startedAt` from five minutes
 * ago. Stale/orphan cleanup must not look only at that semantic clock and immediately retire
 * work that was just written. The max mtime of the three mutable session projections is the
 * durable inactivity clock it needs.
 */
export async function sessionDurableModifiedAt(id: string): Promise<number | null> {
  assertSessionId(id);
  let newest = 0;
  for (const name of ['events.jsonl', 'messages.json', 'messages', 'meta.json']) {
    try {
      const stat = await fs.stat(path.join(sessionDir(id), name));
      newest = Math.max(newest, stat.mtimeMs);
    } catch {
      // A session can legitimately predate messages.json or have no structured events yet.
    }
  }
  return newest > 0 ? newest : null;
}

export async function getSession(id: string): Promise<SessionSummary | null> {
  assertSessionId(id);
  const summary = await readAuthoritativeSummary(id);
  return summary ? { ...summary } : null;
}

export async function endSession(id: string): Promise<void> {
  const entry = open.get(id);
  if (!entry) return;
  if (entry.metaTimer) {
    clearTimeout(entry.metaTimer);
    entry.metaTimer = null;
  }
  await enqueueSessionOperation(entry, 'end', async () => {
    entry.summary.endedAt = Date.now();
    await writeMeta(entry);
    publishClosedSummary(entry.summary);
  });
  if (open.get(id) === entry) open.delete(id);
}

/**
 * Marks a session live again.
 *
 * Closing a ChatGPT tab ends its session, and reopening the same conversation
 * continues it — deliberately, so a chat is one history rather than a fragment per
 * visit. Without this the reopened session kept the `endedAt` from the close, and
 * everything after it was appended to a session the UI still drew as finished.
 */
export async function reopenSession(id: string): Promise<void> {
  const entry = await ensureOpen(id);
  await enqueueSessionOperation(entry, 'reopen', async () => {
    if (entry.summary.endedAt === null) return;
    entry.summary.endedAt = null;
    entry.summary.updatedAt = Date.now();
    await writeMeta(entry);
  });
}

export async function renameSession(id: string, title: string): Promise<void> {
  const entry = await ensureOpen(id);
  await enqueueSessionOperation(entry, 'rename', async () => {
    entry.summary.title = title.slice(0, 120);
    await writeMeta(entry);
  });
}

/**
 * Records that this app opened the chat, and names the session accordingly.
 *
 * One write rather than a rename followed by a stamp, because the two are the same
 * fact: the origin is where the name came from, and a session that carried one without
 * the other would either show the bootstrap prompt as its name or claim a role the
 * name contradicts.
 */
export async function setSessionOrigin(id: string, origin: SessionOrigin, title: string): Promise<void> {
  const entry = await ensureOpen(id);
  await enqueueSessionOperation(entry, 'origin write', async () => {
    entry.summary.origin = origin;
    entry.summary.title = title.slice(0, 120);
    await writeMeta(entry);
  });
}

/**
 * Attaches this durable session to a different ChatGPT conversation.
 *
 * The single canonical session-transfer primitive: Compact & Resume does not create a
 * second session and copy state into it, it moves the one session's frontend from chat A
 * to chat B. Everything the session owns — its recorded history, its title, its origin, its
 * handoffs, and by extension the workspace and swarm binding keyed off it — follows for
 * free, precisely because none of it was ever keyed on the ChatGPT conversation.
 *
 * `contextTokens` is the one figure that resets, and it is not an exception to that rule:
 * it measures what the *attached chat* is carrying, and chat B is carrying only the
 * handoff. `estimatedTokens` keeps counting the session's whole life.
 *
 * Refuses rather than guesses when the session is not attached where the caller thinks it
 * is. That check is what makes the commit safe to retry and impossible to apply twice.
 *
 * ## Commit on success, never before
 *
 * The move is staged on a *clone* and only published into the live summary once the durable
 * write has actually landed. Mutating the live summary first and writing afterwards looked
 * equivalent and was not: a failed `writeMeta` returned false while memory already said
 * chat B, and the next scheduled flush then wrote that state to disk anyway — so a commit
 * that reported failure completed itself a second later. The requirement is absolute in the
 * other direction: a failed A→B commit leaves the session attached to A, in memory and on
 * disk alike. Publishing is a field-by-field copy into the existing object, because callers
 * hold that reference.
 */
export async function rebindSession(
  id: string,
  fromConversationId: string,
  toConversationId: string,
  committedResumeHandoffId?: string
): Promise<boolean> {
  if (!toConversationId || fromConversationId === toConversationId) return false;
  if (committedResumeHandoffId !== undefined && !/^[0-9a-z-]{8,64}$/i.test(committedResumeHandoffId)) return false;
  // Same rule as createSession: once a mutation may attach B, no pre-existing cached miss for
  // B is authoritative. Clearing it early is safe even if the move later refuses or fails.
  missingCurrentConversations.delete(toConversationId);
  const entry = await ensureOpen(id);
  return enqueueSessionOperation(entry, 'rebind', async () => {
    if (entry.summary.conversationId !== fromConversationId) return false;
    // Browser conversation ids are UUID-like. A handful of store unit tests deliberately
    // use short symbolic ids and reuse them across retained temp sessions; ownership safety
    // applies to the real identity domain rather than manufacturing a test-only collision.
    if (/^[0-9a-f-]{8,64}$/i.test(toConversationId)) {
      const target = await findSessionByConversation(toConversationId, { requireUnique: true });
      if (target && target.id !== id) {
        logWarn(`session ${id} cannot move to ${toConversationId}: that chat already belongs to ${target.id}`);
        return false;
      }
    }
    const staged: SessionSummary = {
      ...entry.summary,
      conversationId: toConversationId,
      chatIds: entry.summary.chatIds.includes(toConversationId)
        ? [...entry.summary.chatIds]
        : [...entry.summary.chatIds, toConversationId],
      contextTokens: 0,
      activeTurnId: null,
      ...(committedResumeHandoffId !== undefined
        ? { lastCommittedResumeHandoffId: committedResumeHandoffId }
        : {}),
      updatedAt: Date.now(),
      // A session whose chat was closed during the handover is live again the moment its new
      // chat is attached; leaving `endedAt` set would draw a visibly growing session as over.
      endedAt: null
    };

    try {
      await writeSummary(staged, entry.historySeq);
    } catch (err) {
      logWarn(`session ${id} could not be moved to ${toConversationId}: ${(err as Error).message}`);
      return false;
    }

    // Past this point nothing can fail: the durable record already says chat B.
    Object.assign(entry.summary, staged);
    entry.metaDirty = false;
    missingCurrentConversations.delete(toConversationId);
    publishAttachmentSummary(entry.summary);
    logInfo(`session ${id} moved from ChatGPT conversation ${fromConversationId} to ${toConversationId}`);
    return true;
  });
}

/**
 * Repairs successful-resume provenance after recovery proves the A→B session move already landed.
 *
 * Normal continuation commit writes this id atomically inside {@link rebindSession}. A crash can
 * leave the continuation WAL in `committing` after that metadata write, and older builds could
 * move the session before this field existed. In either case, the durable continuation's handoff
 * id plus the session already being attached to B authorises this one-field repair. Any other
 * current attachment is refused rather than inferred.
 */
export async function ensureCommittedResumeHandoff(
  id: string,
  conversationId: string,
  handoffId: string
): Promise<boolean> {
  if (!conversationId || !/^[0-9a-z-]{8,64}$/i.test(handoffId)) return false;
  const entry = await ensureOpen(id);
  return enqueueSessionOperation(entry, 'committed resume provenance repair', async () => {
    if (entry.summary.conversationId !== conversationId) return false;
    if (entry.summary.lastCommittedResumeHandoffId === handoffId) return true;
    const staged: SessionSummary = {
      ...entry.summary,
      // This is recovery of an already-landed semantic move, not new user/session activity.
      // Preserve the original recency rather than making an app restart reorder old sessions.
      lastCommittedResumeHandoffId: handoffId
    };
    await writeSummary(staged, entry.historySeq);
    Object.assign(entry.summary, staged);
    entry.metaDirty = false;
    publishCachedSummary(entry.summary, false);
    return true;
  });
}

// ----------------------------------------------------------------- assets

/**
 * Stores a binary beside the log and returns a reference.
 *
 * Content-addressed, so a screenshot taken twice costs one file. This is the whole
 * reason the log stays readable: a 300 KB PNG never becomes a 400 KB base64 string
 * inside a line that a summary pass then has to skip over.
 */
export async function writeAsset(
  sessionId: string,
  data: Buffer,
  mimeType: string
): Promise<AssetRef> {
  assertSessionId(sessionId);
  if (data.length === 0 || data.length > MAX_ASSET_BYTES) throw new Error('Session asset exceeds the per-asset limit');
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 32);
  const extension =
    mimeType === 'image/png'
      ? '.png'
      : mimeType === 'image/jpeg'
        ? '.jpg'
        : mimeType === 'text/plain'
          ? '.txt'
          : '.bin';
  const id = `${hash}${extension}`;
  const write = assetWriteQueue.then(async () => {
    const dir = path.join(sessionDir(sessionId), 'assets');
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, id);
    try {
      await fs.stat(target);
      return { id, mimeType, bytes: data.length };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const used = await sessionAssetBytesOnDisk(sessionId);
    const globalUsed = await globalAssetBytesOnDisk();
    if (used + data.length > MAX_SESSION_ASSET_BYTES) throw new Error('Session asset quota exceeded');
    if (globalUsed + data.length > MAX_GLOBAL_ASSET_BYTES) throw new Error('Global session asset quota exceeded');
    try {
      await fs.writeFile(target, data, { flag: 'wx' });
      sessionAssetUsage.set(sessionId, used + data.length);
      globalAssetUsage = globalUsed + data.length;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    return { id, mimeType, bytes: data.length };
  });
  assetWriteQueue = write.then(
    () => undefined,
    () => undefined
  );
  return write;
}

async function directoryFileBytes(dir: string): Promise<number> {
  let total = 0;
  let handle: Awaited<ReturnType<typeof fs.opendir>> | null = null;
  try {
    handle = await fs.opendir(dir);
    for await (const entry of handle) {
      if (!entry.isFile()) continue;
      try {
        total += (await fs.stat(path.join(dir, entry.name))).size;
      } catch {
        // A concurrent delete simply removes it from the durable total.
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return total;
}

async function sessionAssetBytesOnDisk(sessionId: string): Promise<number> {
  const cached = sessionAssetUsage.get(sessionId);
  if (cached !== undefined) return cached;
  const used = await directoryFileBytes(path.join(sessionDir(sessionId), 'assets'));
  sessionAssetUsage.set(sessionId, used);
  return used;
}

async function globalAssetBytesOnDisk(): Promise<number> {
  if (globalAssetUsage !== null) return globalAssetUsage;
  let total = 0;
  let handle: Awaited<ReturnType<typeof fs.opendir>> | null = null;
  try {
    handle = await fs.opendir(root);
    for await (const entry of handle) {
      if (!entry.isDirectory() || !/^[0-9a-z-]{8,64}$/i.test(entry.name)) continue;
      total += await sessionAssetBytesOnDisk(entry.name);
      if (total > MAX_GLOBAL_ASSET_BYTES) break;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  globalAssetUsage = total;
  return total;
}

function invalidateAssetUsage(sessionId: string): void {
  sessionAssetUsage.delete(sessionId);
  globalAssetUsage = null;
}

export async function readAsset(sessionId: string, assetId: string): Promise<Buffer | null> {
  assertSessionId(sessionId);
  if (!/^[0-9a-f]{8,64}\.(png|jpg|txt|bin)$/.test(assetId)) return null;
  try {
    return await fs.readFile(path.join(sessionDir(sessionId), 'assets', assetId));
  } catch {
    return null;
  }
}

/**
 * Stores text too long to sit inline, and returns the reference to put in the event.
 *
 * Content-addressed like any other asset, so a command run twice with the same enormous
 * output costs one file. Returns null only when the text is beyond even this — at which
 * point the event says so rather than pretending the record is complete.
 */
export async function writeOverflowText(sessionId: string, text: string): Promise<string | null> {
  if (text.length > MAX_OVERFLOW_ASSET_CHARS) return null;
  try {
    const asset = await writeAsset(sessionId, Buffer.from(text, 'utf8'), 'text/plain');
    return asset.id;
  } catch (err) {
    logWarn(`session ${sessionId}: overflow text not stored: ${(err as Error).message}`);
    return null;
  }
}

/** Reads back text spilled by writeOverflowText. */
export async function readOverflowText(sessionId: string, assetId: string): Promise<string | null> {
  const data = await readAsset(sessionId, assetId);
  return data ? data.toString('utf8') : null;
}

// --------------------------------------------------------------- handoffs

export async function saveHandoff(handoff: Handoff): Promise<void> {
  assertSessionId(handoff.sessionId);
  const dir = path.join(sessionDir(handoff.sessionId), 'handoffs');
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${handoff.id}.json`);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(handoff, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

export async function readHandoff(sessionId: string, handoffId: string): Promise<Handoff | null> {
  assertSessionId(sessionId);
  if (!/^[0-9a-z-]{8,64}$/i.test(handoffId)) return null;
  try {
    const raw = await fs.readFile(path.join(sessionDir(sessionId), 'handoffs', `${handoffId}.json`), 'utf8');
    const parsed = JSON.parse(raw) as Handoff;
    return typeof parsed?.text === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The newest handoff across every session — what a fresh chat asks for by default.
 *
 * Deliberately over every session rather than the capped UI list: the point of "the last
 * handoff" is that it is the last one, and "unless you happen to have more than two
 * hundred sessions" is not a property worth shipping.
 */
export async function latestHandoff(): Promise<Handoff | null> {
  const sessions = await readEverySummary();
  let best: Handoff | null = null;
  for (const summary of sessions) {
    if (!summary.lastHandoffId) continue;
    const handoff = await readHandoff(summary.id, summary.lastHandoffId);
    if (handoff && (!best || handoff.createdAt > best.createdAt)) best = handoff;
  }
  return best;
}

// ------------------------------------------------------------------ prune

/**
 * Deletes sessions older than the retention window.
 *
 * A session that holds the newest handoff is kept regardless: deleting the thing a
 * fresh conversation is about to resume from would be the one unrecoverable mistake
 * this store can make.
 */
export async function pruneSessions(retainDays: number): Promise<number> {
  if (retainDays <= 0) return 0;
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  // Retention is a completeness contract, not a UI query. Reuse the uncapped process-lifetime
  // catalog so an arbitrary `readdir()` prefix can never make session 5,001 immortal.
  const sessions = await readEverySummary();
  const newestHandoff = await latestHandoff();
  let removed = 0;
  for (const summary of sessions) {
    if (summary.updatedAt >= cutoff) continue;
    if (open.has(summary.id)) continue;
    if (newestHandoff && newestHandoff.sessionId === summary.id) continue;
    try {
      await fs.rm(sessionDir(summary.id), { recursive: true, force: true });
      invalidateAssetUsage(summary.id);
      publishAttachmentRemoval(summary.id);
      removed++;
    } catch (err) {
      logWarn(`could not remove old session ${summary.id}: ${(err as Error).message}`);
    }
  }
  return removed;
}

export async function deleteSession(id: string): Promise<void> {
  assertSessionId(id);
  const entry = open.get(id);
  if (entry) {
    if (entry.metaTimer) clearTimeout(entry.metaTimer);
    await entry.queue.catch(() => undefined);
    open.delete(id);
  }
  await fs.rm(sessionDir(id), { recursive: true, force: true });
  invalidateAssetUsage(id);
  publishAttachmentRemoval(id);
}

/** Test seam: forgets in-memory state without touching the files. */
export function resetSessionStoreForTests(): void {
  for (const entry of open.values()) if (entry.metaTimer) clearTimeout(entry.metaTimer);
  open.clear();
  opening.clear();
  reconciling.clear();
  sessionAssetUsage.clear();
  globalAssetUsage = null;
  missingCurrentConversations.clear();
  attachmentCatalog = null;
  attachmentCatalogLoading = null;
  attachmentEpoch = 0;
}

/** Test seam: puts the store back to never having been told where to write. */
export function unsetSessionRootForTests(): void {
  root = '';
  sessionAssetUsage.clear();
  globalAssetUsage = null;
  missingCurrentConversations.clear();
  attachmentCatalog = null;
  attachmentCatalogLoading = null;
  attachmentEpoch = 0;
}
