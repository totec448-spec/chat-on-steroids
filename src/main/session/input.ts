import { REASONING_EFFORTS, workSequence } from '../../shared/session.js';
/** User-authored input has one durable owner across browser and MCP delivery.
 * A claimed browser send is never automatically retried: losing the ACK is ambiguous.
 * Tool delivery repeats under a stable message id until a later request proves receipt.
 */
import { z } from 'zod';
import { browserInputModel, manualInput, queuedFollowup, MAX_INPUT_IMAGES, type InputImage } from '../../shared/input.js';
import type { SessionSummary } from '../../shared/session.js';
import { getConfig } from '../config.js';
import { randomUUID } from 'node:crypto';
import { userTitle } from './title.js';
import { readDurable, writeDurableNow, writeDurableSoon } from '../durable.js';
import { getSession, findSessionByConversation, createSession, deleteSession, rebindSession, conversationWasSuperseded, readRecentEvents, listUsageSessions, turnHasMcpCall, sessionDirectoryMissing, readCompletedFinal, readLatestUserMessage } from './store.js';
import { assignSessionProject, projectWorkspace, getSessionProject } from '../projects.js';
import { isChatBlocked } from './blocked-chats.js';
import { wakeBrowserWork } from '../browser-wake.js';
import { logInfo } from '../logger.js';
import { noteChatOrigin } from './recorder.js';
import { isAstraModel, isProModel } from '../../shared/chat-models.js';
import { inFlightToolCalls } from '../mcp/call-context.js';
import { automaticFinishEnabled, goalDrivingMode, consumeGoalReplyForInputNow } from '../goal.js';
import { finishInstruction } from '../../shared/finish.js';
import { attachmentSchema, validateInputAttachments, normalizeInputAttachments } from './input-attachments.js';
import { MAX_CHATGPT_MESSAGE_CHARS } from '../../shared/user-prompt.js';
import type { PromptLimits } from './prompt.js';
import { recoveryMessage, recoveryBusyMs } from '../../shared/recovery.js';

export const inputArgs = z.object({
  projectId: z.string().uuid().nullable().optional(),
  automation: z.enum(['off', 'goal', 'loop']).optional(),
  loopAfterTurn: z.boolean().optional(),
  objective: z.string().trim().max(16000).optional(),
  /** Which existing field holds the human request, before generated workflow wrapping. */
  authoredSource: z.enum(['text', 'objective', 'none']).optional(),
  stages: z.array(z.string().trim().min(1).max(16000)).max(11).optional(),
  images: z.array(z.object({ name: z.string().min(1).max(110), dataUrl: z.string().max(512100).regex(/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/) })).max(MAX_INPUT_IMAGES).optional(),
  attachments: z.array(attachmentSchema).max(20).optional(),
  /** User selected the next exact local-tool response, even before the first call. */
  delivery: z.literal('tool').optional(),
  attachmentDelivery: z.literal('tool').optional(),
  id: z.string().uuid(),
  sessionId: z.string().min(8).max(64).nullable(),
  text: z.string().trim().min(1).max(MAX_CHATGPT_MESSAGE_CHARS),
  mode: z.enum(['auto', 'after-turn', 'finish']),
  afterTurn: z.boolean().optional(),
  dueAt: z.number().int().nonnegative(),
  model: z.string().max(80).nullable(),
  reasoningEffort: z.enum(REASONING_EFFORTS).nullable()
});
export type InputArgs = z.infer<typeof inputArgs>;
const entrySchema = inputArgs.extend({
  /** This exact outbox row owns the first native send of its reserved local session. */
  opening: z.literal(true).optional(),
  /** An explicit retry can keep its unbound local chat instead of reserving another. */
  requestedSessionId: inputArgs.shape.sessionId.optional(),
  /** Frozen image projection; authored attachment IDs remain the replay identity. */
  toolImages: inputArgs.shape.images,
  /** One after-turn pickup earned by confirmed silence or settled Thinking failed. */
  silenceBoundary: z.object({ turnId: z.string().min(1).max(256), conversationId: z.string().min(1).max(256), workSeq: z.number().int().nonnegative(), acceptedAt: z.number().nonnegative().optional(), listenUntil: z.number().nonnegative().optional(), nativeBusy: z.boolean().optional() }).optional(),
  /** The active turn at admission; its final may already be waiting in the browser journal. */
  queuedTurn: z.object({ conversationId: z.string().min(1).max(256), turnId: z.string().min(1).max(256) }).optional(),
  /** Shared unfinished-response fallback belongs to this question in every mode. */
  recovery: z.object({ questionId: z.string(), episode: z.string().max(200).optional(), pro: z.boolean(), busyUntil: z.number(), phase: z.enum(['ready', 'stopping', 'reloading', 'resumed']), reloadOwner: z.string().optional() }).optional(),
  /** Exact tool-free turn this explicit browser correction may interrupt. */
  directTurn: z.object({ id: z.string().min(1).max(256), startedAt: z.number() }).optional(),
  finishOwner: z.object({ turnId: z.string().min(1).max(256), periodic: z.boolean(), mode: z.enum(['goal', 'loop']).optional(), userRequested: z.boolean().optional() }).optional(),
  requestedMode: z.enum(['auto', 'after-turn', 'finish']).optional(),
  transportIntent: z.enum(['tool', 'browser']).optional(),
  text: z.string().min(1).max(240000),
  deliveryText: z.string().min(1).max(240000).optional(),
  /** One checkpoint shares this browser send and its receipt with the user's correction. */
  companionInputId: z.string().uuid().optional(),
  purpose: z.enum(['user', 'decision']).optional(),
  lifetime: z.literal('temporary-planner').optional(),
  decisionSourceSessionId: z.string().min(8).max(64).optional(),
  response: z.string().max(16000).optional(),
  state: z.enum(['queued', 'browser', 'tool', 'sent', 'cancelled', 'failed', 'decision']),
  offeredAt: z.number().optional(),
  /** Tool-result corrections remain inside their original generation in history. */
  toolTurnId: z.string().min(1).max(256).optional(),
  sendAuthorizedAt: z.number().optional(),
  requiresAuthorization: z.boolean().optional(),
  cancelledByUser: z.literal(true).optional(),
  error: z.string().max(200).optional(),
  owner: z.string().nullable(),
  createdAt: z.number(),
  conversationId: z.string().nullable(),
  deliveredSessionId: z.string().min(8).max(64).nullable().optional(),
  messageId: z.string().min(1).max(256).optional(),
  deliveredAt: z.number().optional(),
  stagesApplied: z.boolean().optional(),
  historyRecorded: z.boolean().optional(),
  /** Canonical message exists even when optional image assets could not be saved. */
  historyAnchored: z.boolean().optional(),
  /** Store origin proving the canonical row was committed; never a wall-clock guess. */
  historySeq: z.number().int().positive().optional(),
  completedTurnId: z.string().max(256).optional(),
  queueOrder: z.number().int().nonnegative().optional()
});
export type InputEntry = z.infer<typeof entrySchema>;
/** Browser-only projection. `draftText` is the safe authored text to retain if a
 * dispatched native send remains ambiguous; it is never persisted as delivery state. */
export type BrowserInputClaim = InputEntry & { draftText: string };
const STATE = 'session-input';
const TOOL_INPUT_TEXT_BYTES = 128000;
export const TOOL_INPUT_HEADER = '\n--- New instructions from the user ---\n';
export interface ToolInputBatch {
  messages: Array<{ text: string; images: InputImage[] }>;
  /** One transport instruction after the complete batch, including its images. */
  reminder: string;
}
export interface InputActivity { possible: boolean; exact: boolean; model?: 'pro' | 'other' | 'unknown'; turnId?: string }
type InputDeliveryHooks = {
  recoveryAllowed?: (sessionId: string, conversationId: string) => boolean;
  activity?: (session: SessionSummary) => InputActivity;
  wakeDecision?: (entry: Readonly<InputEntry>, signal: AbortSignal) => Promise<void>;
  bindHelper?: (conversationId: string, sourceSessionId: string | null) => Promise<void>;
  recordDelivered?: (entry: Readonly<InputEntry>, anchorCommitted: (seq: number) => void) => Promise<boolean>;
  prepareText?: (entry: Readonly<InputEntry>, limits: PromptLimits, authored: string) => string | Promise<string>;
  applyAutomation: (conversationId: string, automation: NonNullable<InputArgs['automation']>, phase: 'before-send' | 'after-send', objective?: string, loopAfterTurn?: boolean) => Promise<void>;
  changed: () => void;
};
let deliveryHooks: InputDeliveryHooks | null = null;
/** Installed once by IPC before bridge/MCP startup; avoids a Goal/input import cycle. */
export function configureInputDelivery(hooks: InputDeliveryHooks): void { deliveryHooks = hooks; }
/** One delivery policy for composer presentation, admission and the final send fence. */
export async function sessionInputPolicy(sessionId: string, observedActivity?: InputActivity): Promise<{ queueAtFinish: boolean; canInject: boolean; injectionTurnId: string | null; directTurn: InputEntry['directTurn'] | null; browserAllowed: boolean; settled: boolean }> {
  const [end] = await readRecentEvents(sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
  const session = await getSession(sessionId);
  if (!session?.conversationId || isChatBlocked(session.conversationId)) return { queueAtFinish: false, canInject: false, injectionTurnId: null, directTurn: null, browserAllowed: false, settled: false };
  const activity = observedActivity ?? deliveryHooks?.activity?.(session) ?? { possible: !!session.activeTurnId, exact: !!session.activeTurnId };
  const stopped = session.finishTurn?.released === true;
  const selection = session.selectedModel?.conversationId === session.conversationId ? session.selectedModel : null;
  // A previous turn's MCP history must not disable ordinary-chat steering. The
  // existing start and tool timestamps cover committed work; in-flight custody
  // also covers the first call before its durable recording has landed.
  const directTurn = !stopped && activity.exact && end?.kind === 'turn_start' &&
    !!end.turnId && end.turnId === session.activeTurnId && !!selection?.model &&
    activity.model !== 'pro' && activity.model !== 'unknown' &&
    !isProModel(selection.model, selection.reasoningEffort) &&
    (session.lastToolCallAt ?? -1) < end.time && inFlightToolCalls(session.conversationId) === 0
    ? { id: end.turnId, startedAt: end.time } : null;
  const canInject = !stopped && activity.exact && !directTurn;
  // The bridge's retained exact MCP grant can outlive a native UI end. Project
  // that same turn for image custody, never invent an active recorder turn.
  const injectionTurnId = canInject ? session.activeTurnId ?? (activity.turnId === end?.turnId ? activity.turnId ?? null : null) : null;
  const astra = session.origin?.kind !== 'worker' && session.origin?.kind !== 'helper' &&
    session.selectedModel?.conversationId === session.conversationId && isAstraModel(session.selectedModel.model, session.selectedModel.reasoningEffort);
  const completed = !session.activeTurnId
    ? await readCompletedFinal(sessionId, session.conversationId) : null;
  const current = await getSession(sessionId);
  if (current?.conversationId !== session.conversationId || current?.activeTurnId !== session.activeTurnId)
    return { queueAtFinish: false, canInject: false, injectionTurnId: null, directTurn: null, browserAllowed: false, settled: false };
  const terminal = end?.kind === 'turn_end' && !!end.turnId && end.outcome !== 'unknown';
  const settled = (terminal && ((end.outcome === 'completed' && !activity.possible && !activity.exact) ||
    (end.outcome === 'failed' && end.reason === 'thinking_failed'))) ||
    (!astra && !!completed && !activity.possible && !activity.exact);
  const executing = inFlightToolCalls(session.conversationId) > 0;
  return { canInject, injectionTurnId, directTurn, queueAtFinish: astra && canInject && getConfig().ui.finishTool === true,
    // An adopted idle chat may have no recorded turn boundary. Explicit input can
    // use its native composer; queued checkpoints still require `settled` below.
    browserAllowed: !session.activeTurnId && !activity.possible && !activity.exact && !executing,
    // Completion already reconciles trailing same-request calls. A separate time
    // comparison would leave the composer unsettled after the activity clock stopped.
    settled: settled && !executing && (!!completed || (session.lastToolCallAt ?? 0) <= (end?.time ?? 0)) };
}
async function browserInputAllowed(entry: InputEntry): Promise<boolean> {
  if (entry.error?.startsWith('Local chat setup failed:')) return false;
  // Authored Inject-now custody never changes transports. Its exact turn either
  // offers it from an MCP response or expires it visibly below.
  if (entry.delivery === 'tool') return false;
  if (entry.attachmentDelivery === 'tool') return false;
  if (entry.opening && entry.sessionId && !entry.deliveredAt) {
    const session = await getSession(entry.sessionId);
    if (session?.origin?.kind === 'desktop' && !session.conversationId) return true;
  }
  if (entry.mode === 'finish' && entry.sessionId && entry.afterTurn !== true) {
    const session = await getSession(entry.sessionId);
    const selection = session?.selectedModel;
    if (selection?.conversationId === session?.conversationId && isAstraModel(selection?.model, selection?.reasoningEffort)) return false;
  }
  if (!entry.sessionId) return entry.transportIntent !== 'tool';
  const session = await getSession(entry.sessionId);
  // Departure suspends already accepted delivery through the final Send check.
  // A new explicit immediate message remains a user action that may open the chat.
  if (session?.browserRecoveryDismissedAt !== undefined &&
      (!manualInput(entry) || entry.createdAt <= session.browserRecoveryDismissedAt)) return false;
  // Silence can leave the recorder's original turn open. Its durable ticket
  // proves the exact unchanged work; the native page must still be idle for Send.
  if (entry.silenceBoundary) return await eligibleStageEnd(entry) === entry.silenceBoundary.turnId;
  const policy = await sessionInputPolicy(entry.sessionId);
  if (entry.completedTurnId && await eligibleStageEnd(entry) !== entry.completedTurnId) return false;
  if (entry.directTurn) {
    const session = await getSession(entry.sessionId);
    if (!session || session.conversationId !== entry.conversationId ||
        (session.lastToolCallAt ?? -1) >= entry.directTurn.startedAt || inFlightToolCalls(session.conversationId) > 0) return false;
    if (session.activeTurnId) return policy.directTurn?.id === entry.directTurn.id;
    const [end] = await readRecentEvents(entry.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
    return policy.browserAllowed && end?.kind === 'turn_end' && end.turnId === entry.directTurn.id;
  }
  // Only a never-offered ordinary input may change routes after positive terminal evidence.
  // A tool handout or ambiguous browser claim retains its original exclusive custody.
  return policy.browserAllowed && (entry.transportIntent !== 'tool' ||
    (entry.mode === 'auto' && !entry.finishOwner && entry.purpose !== 'decision' && entry.state === 'queued' &&
      entry.owner === null && entry.offeredAt === undefined && policy.settled));
}
const inputListeners = new Set<() => void>();
export function onInputChange(listener: () => void): () => void {
  inputListeners.add(listener);
  return () => { inputListeners.delete(listener); };
}
/** Observation only: the kernel remains the sole tool-input consumer. */
export function hasEligibleToolInput(sessionId: string, finishBoundary = false): Promise<boolean> {
  return serial(async () => {
    const current = ordered(await load());
    if (current.some(row => row.sessionId === sessionId && row.state === 'browser')) return false;
    const head = current.find(row => row.sessionId === sessionId && queuedFollowup(row) && ['queued', 'tool'].includes(row.state));
    for (const row of current) {
      if (row.sessionId !== sessionId || row.dueAt > Date.now()) continue;
      if (row.attachments?.length && row.attachmentDelivery !== 'tool' && row.delivery !== 'tool') continue;
      if (row.mode === 'after-turn' || (row.mode === 'finish' && !finishBoundary)) continue;
      if (row.mode === 'finish' && row !== head) continue;
      if (row.state === 'tool') return true;
      if (row.state === 'queued') return row.mode === 'auto' || (finishBoundary && row.mode === 'finish');
    }
    return false;
  });
}
let entries: InputEntry[] | null = null;
let chain: Promise<unknown> = Promise.resolve();
// A timestamp written before the claim commit cannot prove that its response was
// available. Restart discards this evidence and repeats the stable message id.
const offered = new Map<string, number>();
const terminal = (row: InputEntry): boolean => ['sent', 'cancelled', 'failed'].includes(row.state);
const preparable = (row: InputEntry): boolean => row.state === 'queued' ||
  (row.state === 'browser' && row.requiresAuthorization === true && row.sendAuthorizedAt === undefined);
const needsHistory = (row: InputEntry): boolean => row.purpose !== 'decision' && !row.historyRecorded &&
  ((row.state === 'tool' && Number.isFinite(row.offeredAt)) || ((row.state === 'sent' || row.state === 'cancelled') && !!row.messageId));
const pendingStages = (row: InputEntry): boolean => row.state === 'sent' && !!row.stages?.length && !row.stagesApplied;
const ordered = (rows: InputEntry[]): InputEntry[] => [...rows].sort((a, b) =>
  (a.queueOrder ?? a.dueAt) - (b.queueOrder ?? b.dueAt) || a.createdAt - b.createdAt);
const companionOf = (rows: InputEntry[], row: InputEntry): InputEntry | undefined => rows.find(root => root.companionInputId === row.id);
const sameDelivery = (root: InputEntry, row: InputEntry): boolean => row.id === root.id || row.id === root.companionInputId;
function combinedInput(root: InputEntry, companion?: InputEntry): InputEntry {
  if (!companion) return root;
  const images = inputArgs.shape.images.parse([...root.images ?? [], ...companion.images ?? []]);
  const attachments = inputArgs.shape.attachments.parse([...root.attachments ?? [], ...companion.attachments ?? []]);
  return { ...root, text: `${root.text}\n\nNext queued instruction:\n${companion.text}`,
    ...(images?.length ? { images } : {}), ...(attachments?.length ? { attachments } : {}) };
}

function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = chain.then(work, work);
  chain = result.catch(() => undefined);
  return result;
}

/**
 * Versions before opening reservations left ordinary New Chat rows without a sidebar owner.
 * Recover only that original authored opening: helpers, generated finish work, checkpoints and
 * either half of a combined delivery keep their existing owners. A confirmed delivery may only
 * join an exact current conversation owner below; it never creates retrospective history.
 *
 * Undelivered rows reserve their immutable outbox UUID. Existing offer/authorization/state and
 * frozen deliveryText travel unchanged, so a browser claim remains exclusive and cannot replay.
 * A provider ownership conflict therefore gets a visible unbound local chat, never a guessed
 * provider binding; a later exact receipt must still pass bindOpening's collision checks.
 */
async function migrateLegacyOpeningOwners(current: InputEntry[]): Promise<boolean> {
  let changed = false;
  for (let index = 0; index < current.length; index++) {
    const row = current[index]!;
    const combined = !!row.companionInputId || !!companionOf(current, row);
    const ordinaryOpening = !row.opening && row.sessionId === null && row.deliveredSessionId == null &&
      row.deliveredAt === undefined && !row.messageId && !row.historyAnchored && !row.historyRecorded &&
      manualInput(row) && ['queued', 'browser', 'failed', 'cancelled'].includes(row.state) && !combined;
    if (!ordinaryOpening) continue;

    if (row.conversationId) {
      const exact = await findSessionByConversation(row.conversationId, { requireUnique: true });
      const projectCompatible = exact && (!row.projectId || !exact.projectId || exact.projectId === row.projectId);
      const ordinaryOwner = projectCompatible && exact.origin?.kind !== 'worker' && exact.origin?.kind !== 'helper';
      if (exact && ordinaryOwner) {
        try {
          if (row.projectId && !exact.projectId) await assignSessionProject(exact.id, row.projectId);
          const migrated = { ...row, opening: true as const, requestedSessionId: null, sessionId: exact.id };
          await materializeOpening(migrated);
          current[index] = migrated;
          changed = true;
          continue;
        } catch {
          // Preserve the original row and recover it through an unbound reservation below.
        }
      }
    }

    const migrated = { ...row, opening: true as const, requestedSessionId: null, sessionId: row.id };
    try {
      // Materialize before publishing the migrated row. If publication is interrupted, the
      // unchanged legacy row deterministically reuses this same reserved session on next load.
      await materializeOpening(migrated);
    } catch {
      // A partial create can still have published the exact session. Keep it visible when that
      // identity exists; otherwise leave the legacy row untouched for a later safe retry.
      const partial = await getSession(row.id);
      if (!partial || partial.origin?.kind !== 'desktop' ||
          (partial.conversationId && partial.conversationId !== row.conversationId)) continue;
    }
    current[index] = migrated;
    changed = true;
  }
  return changed;
}

async function load(): Promise<InputEntry[]> {
  if (entries) return expireQueued(entries);
  const raw = await readDurable<unknown>(STATE);
  const parsed = z.array(entrySchema).safeParse(raw ?? []);
  if (!parsed.success) throw new Error('The message outbox could not be read safely');
  entries = parsed.data;
  const legacyOpeningRepair = await migrateLegacyOpeningOwners(entries);
  // One failed/deleted project must not prevent unrelated accepted work loading.
  let openingRepair = legacyOpeningRepair;
  for (const entry of entries) if (entry.opening && !terminal(entry)) {
    try {
      await materializeOpening(entry);
      if (entry.error?.startsWith('Local chat setup failed:')) { delete entry.error; openingRepair = true; }
    } catch (error) {
      entry.error = ('Local chat setup failed: ' + (error as Error).message).slice(0, 200);
      openingRepair = true;
    }
  }
  if (openingRepair) await commit(entries);
  for (const row of entries) await removeWithdrawnOpening(row, entries);
  try { await retireRemovedSessionReceipts(entries); }
  catch (error) { entries = null; throw error; }
  // Old receipts are recovery evidence, not a reason to replay every already-stamped
  // transcript before the sidebar appears. The existing catalog proves an origin is
  // durable; only missing/ambiguous rows need the normal origin repair path below.
  const stamped = new Set<string>();
  const seen = new Set<string>();
  if (entries.some(row => row.conversationId && (row.purpose === 'decision' || (!row.sessionId && row.deliveredAt !== undefined)))) {
    for (const summary of await listUsageSessions()) {
      if (!summary.conversationId) continue;
      if (seen.has(summary.conversationId)) stamped.delete(summary.conversationId);
      else if (summary.origin) stamped.add(summary.conversationId);
      seen.add(summary.conversationId);
    }
  }
  // Durable decision receipts recover helper provenance even when recording/ACK raced
  // or this version first opens a helper recorded before origins were stamped.
  for (const row of entries) {
    // Re-project wrapped receipts once when loading the outbox, so recordings made
    // before authoredText existed recover their original visible text too. This
    // is canonical history only; it never reopens transport or resends an input.
    if (row.historyRecorded && row.deliveryText && row.deliveryText !== row.text) row.historyRecorded = false;
    if (!row.sessionId && row.purpose !== 'decision' && row.conversationId && row.deliveredAt !== undefined && !stamped.has(row.conversationId)) {
      await noteChatOrigin(row.conversationId, { kind: 'desktop', fromSessionId: null, agentId: null, task: '' });
    }
    if (row.purpose === 'decision' && row.lifetime !== 'temporary-planner' && row.conversationId && !stamped.has(row.conversationId)) await deliveryHooks?.bindHelper?.(row.conversationId, row.decisionSourceSessionId ?? null);
  }
  const recovered = entries.map((row): InputEntry => row.purpose === 'decision' && !terminal(row) && !decisionWaiters.has(row.id)
    ? { ...row, state: 'cancelled' } : row);
  if (recovered.some((row, i) => row !== entries![i])) {
    try { await commit(recovered); }
    catch (error) { entries = null; throw error; }
  }
  return expireQueued(entries);
}
/** The outbox retains delivery proof until its exact history owner is removed.
 * Run under its existing serial queue, before origin repair or checkpoint publication.
 * Unconfirmed sends and missing/corrupt metadata never establish removal. */
async function retireRemovedSessionReceipts(current: InputEntry[], pendingOnly = false): Promise<InputEntry[]> {
  const missing = new Map<string, boolean>();
  const removed = new Set<string>();
  for (const row of current) {
    const sessionId = row.sessionId ?? row.deliveredSessionId;
    if (!sessionId || row.purpose === 'decision' || !['sent', 'cancelled'].includes(row.state) ||
        !row.messageId || !Number.isFinite(row.deliveredAt) ||
        (pendingOnly && !needsHistory(row) && !pendingStages(row))) continue;
    if (!missing.has(sessionId)) missing.set(sessionId, await sessionDirectoryMissing(sessionId));
    if (missing.get(sessionId)) removed.add(row.id);
  }
  // A combined delivery keeps both originals until both can be retired together.
  for (const row of current) {
    if (row.companionInputId && removed.has(row.id) !== removed.has(row.companionInputId)) {
      removed.delete(row.id); removed.delete(row.companionInputId);
    }
  }
  if (!removed.size) return current;
  const next = current.filter(row => !removed.has(row.id));
  await commit(next);
  return next;
}
async function expireQueued(current: InputEntry[]): Promise<InputEntry[]> {
  const next = await Promise.all(current.map(async (row): Promise<InputEntry> => {
    if (companionOf(current, row)) return row;
    if (row.recovery && row.state === 'browser' && row.sendAuthorizedAt !== undefined &&
        row.sessionId && row.conversationId && row.silenceBoundary?.conversationId === row.conversationId &&
        !row.companionInputId) {
      const session = await getSession(row.sessionId);
      // A committed handoff ends this generated Continue's wait in its old chat.
      // Keep the original claim and authorization for an exact late receipt; this
      // neither proves non-delivery nor authorizes a replay. Authored queue rows
      // still follow the session, and time alone never releases an uncertain send.
      if (session?.conversationId && session.conversationId !== row.conversationId &&
          session.chatIds.includes(row.conversationId)) return { ...row, state: 'cancelled' };
    }
    if (row.recovery && !terminal(row) && row.sendAuthorizedAt === undefined) {
      const reason = await recoveryInvalidReason(row);
      if (reason) return { ...row, state: 'cancelled', error: `Automatic Continue cancelled: ${reason}.` };
    }
    if (row.finishOwner && !terminal(row) && !(await finishInputCurrent(row)))
      return { ...row, state: 'cancelled', error: 'Automatic follow-up cancelled because its active turn or setting changed.' };
    if (row.purpose === 'decision') return row;
    if (row.state === 'queued' && row.delivery === 'tool' && row.toolTurnId) {
      const session = row.sessionId ? await getSession(row.sessionId) : null;
      const activity = session ? deliveryHooks?.activity?.(session) : null;
      const observedTurn = session?.activeTurnId ?? (activity?.exact ? activity.turnId : null);
      const [boundary] = row.sessionId ? await readRecentEvents(row.sessionId, 1, { kinds: ['turn_start', 'turn_end'] }) : [];
      const targetEnded = !observedTurn && boundary?.kind === 'turn_end' && boundary.turnId === row.toolTurnId;
      const newerTurn = !!observedTurn && observedTurn !== row.toolTurnId;
      const newerBoundary = !observedTurn && !!boundary?.turnId && boundary.turnId !== row.toolTurnId;
      const ownerChanged = !session || session.conversationId !== row.conversationId;
      if (targetEnded || newerTurn || newerBoundary || ownerChanged) return { ...row, state: 'failed',
        error: 'Not injected: the selected turn ended before an eligible tool call.' };
    }
    if (row.state === 'tool') return settleToolInputFromFinal(row);
    // Only an ordinary browser attempt has an unclaimed startup deadline. Tool
    // intent survives a later terminal observation/restart; legacy bound-chat
    // rows are ambiguous and cannot safely be reclassified from today's activity.
    if (row.state === 'queued' && row.mode === 'auto' && !row.opening && !row.finishOwner && !row.silenceBoundary &&
        (row.transportIntent === 'browser' || (!row.transportIntent && !row.sessionId)) &&
        Date.now() - Math.max(row.createdAt, row.dueAt) >= 60_000)
      return { ...row, state: 'failed', error: 'Not sent: the browser did not pick up this message within 60 seconds.' };
    // Preparation can expire before Send. Once authorized, this exact claim owns
    // the uncertain outcome until receipt or explicit cancellation, regardless of
    // how long ChatGPT takes to assign its durable conversation identity.
    const companion = current.find(other => other.id === row.companionInputId);
    if (row.state === 'browser' && row.sendAuthorizedAt === undefined && row.requiresAuthorization === true &&
        Date.now() - (row.offeredAt ?? row.createdAt) >= (row.attachments?.length || companion?.attachments?.length ? 720_000 : row.images?.length || companion?.images?.length ? 120_000 : 60_000)) {
      // A never-authorized Continue still owes delivery. Retain its ticket and
      // pickup budget, but never replay a possibly consumed Stop after losing a page.
      if (row.recovery) return releaseRecoveryClaim(row);
      return { ...row, state: 'cancelled', error: row.requiresAuthorization && row.sendAuthorizedAt === undefined
        ? 'Not sent: browser preparation timed out. This attempt was cancelled.'
        : 'Stopped waiting for delivery confirmation. The message may already have been sent; it will not be resent.' };
    }
    return row;
  }));
  for (let i = 0; i < next.length; i++) {
    const root = companionOf(next, next[i]!);
    if (root && root.state !== next[i]!.state) next[i] = { ...next[i]!, state: root.state, error: root.error };
  }
  if (next.some((row, index) => row !== current[index])) {
    await commit(next);
    for (const [index, row] of next.entries()) if (row.recovery && row.state === 'cancelled' &&
      current[index]?.state !== 'cancelled')
      logInfo(`input ${row.id}: ${row.error ?? 'Automatic Continue wait retired after its session left the chat.'} conversation=${row.conversationId} turn=${row.silenceBoundary?.turnId}`);
  }
  return entries!;
}
async function commit(next: InputEntry[]): Promise<void> {
  // A temporary planner keeps only ownership metadata across restart, never its task or answer.
  const durableRows = (rows: InputEntry[]) => rows.map(row => row.lifetime === 'temporary-planner'
    ? { ...row, text: '[Temporary planner]', deliveryText: undefined, response: undefined } : row);
  try { await writeDurableNow(STATE, durableRows(next)); }
  catch (error) {
    // durable.ts retries failed generations. Never let a rejected send claim or
    // enqueue become live later behind the caller's back.
    writeDurableSoon(STATE, durableRows(entries ?? []));
    throw error;
  }
  entries = next;
  wakeBrowserWork();
  for (const listener of inputListeners) { try { listener(); } catch { /* observer only */ } }
  try { deliveryHooks?.changed(); } catch { /* a detached renderer does not undo a durable commit */ }
}
/** Reserve the attempt durably before crossing into Goal's control ledger. The failed
 * row is the crash tombstone: an ambiguous settings write is never replayed after a
 * later user Off. Only this live operation may replace it with the successful delivery.
 */
async function transition(current: InputEntry[], next: InputEntry[], automated: InputEntry[], phase: 'before-send' | 'after-send'): Promise<void> {
  if (automated.length) {
    if (!deliveryHooks) throw new Error('Input delivery is not ready');
    const reserved = new Map(automated.flatMap(entry => next.filter(row => sameDelivery(entry, row)).map(row => [row.id, row] as const)));
    await commit(current.map((entry): InputEntry => {
      const claimed = reserved.get(entry.id);
      return claimed ? { ...claimed, state: 'failed', error: phase === 'after-send'
        ? 'Message sent, but automation was not confirmed. Check its chat settings.'
        : 'Automation was not confirmed; this message was not sent. Send again to retry.' } : entry;
    }));
    for (const entry of automated) await deliveryHooks.applyAutomation(entry.conversationId!, entry.automation!, phase, entry.objective, entry.loopAfterTurn);
  }
  await commit(next);
}
/** Freeze the exact transport bytes with its durable claim, never the authored enqueue payload. */
async function prepare(entry: InputEntry, suffix = ''): Promise<InputEntry> {
  if (entry.purpose === 'decision') return entry;
  // Generated openings and plans cannot replace the user's complete request.
  // Keep the authored text intact; freeze the complete objective in the same
  // delivery claim so retries cannot reconstruct a different opening message.
  const text = entry.stages !== undefined && entry.mode !== 'finish'
    ? `Original user request:\n${entry.objective || entry.text}\n\nComplete workflow:\n${[entry.text, ...entry.stages].map((stage, index) => `${index + 1}. ${stage}`).join('\n\n')}\n\nBegin the complete implementation now. Later queued messages are verification checkpoints; do not wait for them to learn or implement requirements. Carry out and verify each received checkpoint before asking for the next one with session_finish; never call it repeatedly just to collect the queue.`
    : entry.objective && (entry.opening || !entry.sessionId)
      ? `Original user request:\n${entry.objective}\n\nOpening instruction:\n${entry.text}\n\nFollow the complete original request, including all constraints, throughout this task.`
      : entry.text;
  const mandatoryOverhead = `${TOOL_INPUT_HEADER}\n\n${finishInstruction(getConfig().ui.finishLeadMinutes)}`;
  const deliveryText = entry.deliveryText ?? await deliveryHooks?.prepareText?.({ ...entry, text: text + suffix }, {
    maxChars: MAX_CHATGPT_MESSAGE_CHARS, maxBytes: TOOL_INPUT_TEXT_BYTES - Buffer.byteLength(mandatoryOverhead)
  }, entry.authoredSource === 'none' ? '' : entry.authoredSource === 'objective' ? entry.objective ?? '' : entry.text) ?? text + suffix;
  // A single input must fit the tool envelope by itself. Aggregate batching below
  // may defer a second input, but cannot silently defer an individually impossible one.
  const envelope = `${TOOL_INPUT_HEADER}${deliveryText}\n\n${finishInstruction(getConfig().ui.finishLeadMinutes)}`;
  if (!deliveryText || deliveryText.length > MAX_CHATGPT_MESSAGE_CHARS || Buffer.byteLength(envelope) > TOOL_INPUT_TEXT_BYTES)
    throw new Error('Prepared message exceeds the delivery limit; shorten the request or plan');
  return { ...entry, deliveryText };
}
function append(current: InputEntry[], entry: InputEntry, stackDirect = false): InputEntry[] {
  if (queuedFollowup(entry)) {
    const positioned = current.filter(row => row.sessionId === entry.sessionId && queuedFollowup(row) && !terminal(row) && row.queueOrder !== undefined);
    if (positioned.length) entry = { ...entry, queueOrder: Math.max(...positioned.map(row => row.queueOrder!)) + 1 };
  }
  // Admission is per durable session. Native composer custody stays with each claim.
  if (!stackDirect && entry.purpose !== 'decision' && !queuedFollowup(entry) && current.some(row => row.sessionId === entry.sessionId && row.purpose !== 'decision' &&
      !(!entry.finishOwner && row.finishOwner && row.state === 'tool') &&
      (!queuedFollowup(row) || row.state === 'browser') && ['queued', 'browser', 'tool'].includes(row.state))) {
    throw new Error('One message is already awaiting delivery. Cancel it before sending another.');
  }
  const active = current.filter((row) => !terminal(row) || needsHistory(row) || pendingStages(row));
  const reserved = (row: InputEntry) => row.stagesApplied ? [] : row.stages ?? [];
  if ([...active, entry].reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify({ ...row, images: undefined, toolImages: undefined, stages: reserved(row) })), 0) > 1024000) {
    throw new Error('The message queue is full');
  }
  const imageBytes = (row: InputEntry): number => [...row.images ?? [], ...row.toolImages ?? []].reduce((sum, image) => sum + image.dataUrl.length, 0) +
    (row.attachments ?? []).reduce((sum, file) => sum + (file.preview?.length ?? 0), 0);
  if ([...active, entry].reduce((sum, row) => sum + imageBytes(row), 0) > 4 * 1024 * 1024) throw new Error('The image queue is full');
  const history = current.filter((row) => terminal(row) && !needsHistory(row) && !pendingStages(row)).slice(-50);
  const bytes = (row: InputEntry): number => Buffer.byteLength(row.text) + Buffer.byteLength(row.deliveryText ?? '') + Buffer.byteLength(row.response ?? '') + Buffer.byteLength(JSON.stringify(row.stages ?? [])) + imageBytes(row);
  let retainedBytes = [...history, ...active, entry].reduce((sum, row) => sum + bytes(row), 0);
  while (history.length && retainedBytes > 2048000) retainedBytes -= bytes(history.shift()!);
  // A frozen delivery needs both originals for restart/history until both can be
  // discarded together. Never retain a dangling companion id after trimming.
  const retained = new Set([...history, ...active, entry].map(row => row.id));
  return [...history.filter(row => {
    const root = companionOf(current, row);
    return (!row.companionInputId || retained.has(row.companionInputId)) && (!root || retained.has(root.id));
  }), ...active, ...current.filter(row => !retained.has(row.id) && active.some(root => sameDelivery(root, row) || root.id === row.companionInputId)), entry];
}
async function target(entry: InputEntry): Promise<string | null> {
  if (entry.purpose === 'decision') {
    if (entry.conversationId && isChatBlocked(entry.conversationId)) throw new Error('Unblock this helper conversation before sending');
    return entry.conversationId;
  }
  if (!entry.sessionId) return null;
  const session = await getSession(entry.sessionId);
  if (entry.opening && session?.origin?.kind === 'desktop' && !session.conversationId) return null;
  if (!session?.conversationId) throw new Error('This recording has no ChatGPT conversation');
  if (isChatBlocked(session.conversationId)) throw new Error('Unblock this conversation before sending');
  return session.conversationId;
}
async function finishInputCurrent(entry: InputEntry): Promise<boolean> {
  // Periodic generation was retired; persisted rows cannot regain delivery authority.
  if (!entry.finishOwner || entry.finishOwner.periodic || !entry.sessionId) return false;
  const session = await getSession(entry.sessionId), config = getConfig();
  return !!session?.conversationId && session.conversationId === entry.conversationId &&
    session.activeTurnId === entry.finishOwner.turnId && session.finishTurn?.turnId === entry.finishOwner.turnId &&
    !session.finishTurn.released && config.ui.finishTool === true && !isChatBlocked(session.conversationId) &&
    session.origin?.kind !== 'worker' && session.origin?.kind !== 'helper' &&
    // Earlier finish decisions always used Loop. A mode change cannot deliver
    // either a legacy Loop instruction or a newly drafted decision for the old mode.
    (entry.finishOwner.mode ?? 'loop') === goalDrivingMode(session.conversationId) &&
    (entry.finishOwner.userRequested === true || automaticFinishEnabled(session.conversationId));
}
/** The accepted outbox identity repairs a partially materialized session after restart. */
async function materializeOpening(entry: InputEntry): Promise<void> {
  if (!entry.opening || !entry.sessionId) return;
  const existing = await getSession(entry.sessionId);
  const recoveredExactOwner = !!existing && entry.requestedSessionId === null && !!entry.conversationId &&
    existing.conversationId === entry.conversationId &&
    existing.origin?.kind !== 'worker' && existing.origin?.kind !== 'helper';
  const session = recoveredExactOwner ? existing : await createSession({ reservedId: entry.sessionId,
    title: userTitle(entry.text, entry.text), titleSource: 'fallback',
    origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: '' } });
  if (session.conversationId && session.conversationId !== entry.conversationId)
    throw new Error('Reserved opening session belongs to another ChatGPT conversation');
  if (entry.projectId && session.projectId !== entry.projectId) await assignSessionProject(session.id, entry.projectId);
}
export function enqueueInput(raw: InputArgs, finishOwner?: InputEntry['finishOwner']): Promise<InputEntry> {
  return serial(async () => {
    const input = inputArgs.parse(raw);
    if (input.stages !== undefined && JSON.stringify([input.text, ...input.stages]).length > 12000)
      throw new Error('Keep the complete plan below 12,000 characters');
    const current = await load();
    const prior = current.find((entry) => entry.id === input.id);
    if (prior) {
      if (JSON.stringify(inputArgs.parse({ ...prior, sessionId: prior.opening ? prior.requestedSessionId ?? null : prior.sessionId, mode: prior.requestedMode ?? prior.mode })) !== JSON.stringify(input)) throw new Error('Message id already belongs to different input');
      if (!terminal(prior)) await materializeOpening(prior);
      return { ...prior };
    }
    const requestedSession = input.sessionId ? await getSession(input.sessionId) : null;
    // Explicit injection has its own recipient and can never spend a browser completion.
    const activity = requestedSession && input.delivery !== 'tool' && input.attachmentDelivery !== 'tool'
      ? deliveryHooks?.activity?.(requestedSession) : null;
    const sourceTurn = requestedSession?.activeTurnId ?? (activity?.exact ? activity.turnId : null);
    const queuedTurn = requestedSession?.conversationId && sourceTurn
      ? { conversationId: requestedSession.conversationId, turnId: sourceTurn } : undefined;
    let policy = input.sessionId ? await sessionInputPolicy(input.sessionId) : null;
    const previousOpening = [...current].reverse().find(row => row.opening && row.sessionId === input.sessionId);
    // An explicit reviewed resend may replace a proven pre-send failure in the same
    // local chat. An ambiguous native Send still owns its receipt; never replay it.
    const retryOpening = !!(input.sessionId && requestedSession?.origin?.kind === 'desktop' && !requestedSession.conversationId &&
      previousOpening && terminal(previousOpening) && previousOpening.sendAuthorizedAt === undefined &&
      (previousOpening.offeredAt === undefined || previousOpening.requiresAuthorization === true));
    const requestedMode = input.mode;
    let toolImages: InputImage[] | undefined;
    let injectionOwner: { conversationId: string; turnId: string } | undefined;
    const toolDelivery = input.delivery === 'tool' || input.attachmentDelivery === 'tool';
    if (toolDelivery) {
      const turnId = policy?.directTurn?.id ?? policy?.injectionTurnId;
      if (!input.sessionId || input.mode !== 'auto' || finishOwner || input.stages?.length || !turnId ||
          (input.images?.length ?? 0) + (input.attachments?.length ?? 0) > MAX_INPUT_IMAGES)
        throw new Error(`Inject up to ${MAX_INPUT_IMAGES} images into an active chat; otherwise use Send or After this turn`);
      const owner = await getSession(input.sessionId);
      if (!owner?.conversationId) throw new Error('Inject into an active chat');
      injectionOwner = { conversationId: owner.conversationId, turnId };
      if (input.attachments?.length) toolImages = await normalizeInputAttachments(input.attachments);
    } else if (input.attachments?.length) {
      await validateInputAttachments(input.attachments);
      // Native files belong to the next browser message, never a tool-result injection.
      if (finishOwner) throw new Error('Automatic finish messages cannot attach files');
      if (input.mode === 'finish' || (input.mode === 'auto' && (policy?.canInject || policy?.directTurn))) input.mode = 'after-turn';
    } else if (input.mode === 'after-turn' && policy?.queueAtFinish) input.mode = 'finish';
    if (input.mode === 'finish' || input.stages?.length) {
      const session = input.sessionId ? await getSession(input.sessionId) : null;
      if ((input.mode === 'finish' && !session?.conversationId) || session?.origin?.kind === 'worker') throw new Error('Queue staged tasks in a normal chat');
    }
    // Unattributed work can fence browser Send without making this chat a tool recipient.
    // Leave that input neutral until the existing serialized claim selects a safe transport.
    const transportIntent = toolDelivery ? 'tool' as const : input.attachments?.length ? 'browser' as const : input.mode === 'auto' && !finishOwner
      ? policy?.canInject ? 'tool' as const : !policy || policy.browserAllowed || policy.directTurn ? 'browser' as const : undefined : undefined;
    const directTurn = !toolDelivery && input.mode === 'auto' && !finishOwner && input.dueAt <= Date.now() ? policy?.directTurn : null;
    const entry: InputEntry = { ...input, ...(queuedTurn ? { queuedTurn } : {}), ...(toolImages ? { toolImages } : {}), ...(directTurn ? { directTurn } : {}),
      ...(injectionOwner ? { toolTurnId: injectionOwner.turnId } : {}), ...(transportIntent ? { transportIntent } : {}),
      ...(requestedMode !== input.mode ? { requestedMode } : {}), ...(finishOwner ? { finishOwner } : {}), state: 'queued', owner: null, createdAt: Date.now(), conversationId: null };
    if (input.projectId) {
      await projectWorkspace(input.projectId);
      if (input.sessionId) {
        const session = await getSession(input.sessionId);
        if (session?.projectId !== input.projectId) throw new Error('Message project does not match the session');
        await getSessionProject(input.sessionId);
      }
    }
    if (retryOpening) { entry.opening = true; entry.requestedSessionId = input.sessionId; }
    entry.conversationId = await target(entry);
    if (!input.sessionId) {
      entry.opening = true;
      entry.sessionId = input.id;
    }
    if (finishOwner && !(await finishInputCurrent(entry))) throw new Error('The automatic follow-up no longer belongs to an active turn');
    if (injectionOwner) {
      policy = await sessionInputPolicy(input.sessionId!);
      const owner = await getSession(input.sessionId!);
      const turnId = policy.directTurn?.id ?? policy.injectionTurnId;
      if (turnId !== injectionOwner.turnId || owner?.conversationId !== injectionOwner.conversationId || entry.conversationId !== injectionOwner.conversationId)
        throw new Error(input.delivery === 'tool'
          ? 'The active chat changed while preparing injection; send again'
          : 'The active chat changed while preparing images; send again');
    }
    // User input supersedes only automatic work that has never been handed out.
    // Offered tool receipts retain their identity until a later request proves receipt.
    const prioritized = !finishOwner ? current.map(row => row.sessionId === entry.sessionId &&
      ((row.finishOwner && row.state === 'queued') || (row.recovery && !terminal(row) && row.sendAuthorizedAt === undefined))
      ? { ...row, state: 'cancelled' as const, error: 'Replaced by your new instruction before delivery.' } : row) : current;
    let next = append(prioritized, entry, input.mode === 'auto' && !finishOwner && policy?.canInject === true);
    // A finish plan belongs to an existing session now. Publish every editable
    // checkpoint atomically; no composer text or first-send receipt owns its life.
    if (entry.mode === 'finish') next = materializeStages(next, entry);
    await commit(next);
    try { await materializeOpening(entry); }
    catch (error) {
      const failed = { ...entry, error: ('Local chat setup failed: ' + (error as Error).message).slice(0, 200) };
      await commit(next.map(row => row.id === entry.id ? failed : row));
      throw error;
    }
    return { ...next.find(row => row.id === entry.id)! };
  });
}
function materializeStages(current: InputEntry[], entry: InputEntry): InputEntry[] {
  const sessionId = entry.sessionId ?? entry.deliveredSessionId;
  if (!sessionId || entry.stages === undefined || entry.stagesApplied) return current;
  let next = current.map(row => row.id === entry.id ? { ...row, stagesApplied: true } : row);
  // Checkpoints inherit the current chat model, including later user selections.
  for (const [index, text] of entry.stages.entries()) next = append(next, {
    id: randomUUID(), sessionId, projectId: entry.projectId, text, authoredSource: 'none', mode: 'finish', dueAt: entry.createdAt + index,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: entry.createdAt + index, conversationId: entry.conversationId,
    ...(entry.queuedTurn ? { queuedTurn: entry.queuedTurn } : {})
  });
  return next;
}
export function listInputs(): Promise<InputEntry[]> {
  return serial(async () => {
    const current = await retireRemovedSessionReceipts(await load(), true);
    let next: InputEntry[] = [];
    for (const entry of current) {
      if (entry.purpose !== 'decision' && (entry.state === 'sent' || (entry.state === 'cancelled' && entry.deliveredAt !== undefined)) && !entry.sessionId && entry.conversationId && !entry.deliveredSessionId) {
        const session = await findSessionByConversation(entry.conversationId, { requireUnique: true });
        next.push(session ? { ...entry, deliveredSessionId: session.id } : entry);
      } else next.push(entry);
    }
    for (const entry of [...next]) {
      if (entry.state === 'sent') next = materializeStages(next, entry);
    }
    if (next.length !== current.length || next.some((entry, index) => entry !== current[index])) await commit(next);
    await publishHistory();
    return ordered(await load()).map((entry) => ({ ...entry }));
  });
}
/** A sent receipt survives a recorder failure. Existing outbox reads retry publication,
 * never transport; the stable canonical key makes a lost recording ACK idempotent. */
async function publishHistory(): Promise<void> {
  const current = await load();
  const recorded = new Set<string>();
  const anchored = new Map<string, number>();
  for (const row of current) {
    if (!needsHistory(row) || companionOf(current, row)) continue;
    const anchorCommitted = (seq: number) => {
      anchored.set(row.id, seq);
      if (row.companionInputId) anchored.set(row.companionInputId, seq);
    };
    try { if (deliveryHooks?.recordDelivered && await deliveryHooks.recordDelivered(combinedInput(row, current.find(other => other.id === row.companionInputId)), anchorCommitted)) {
      recorded.add(row.id);
      if (row.companionInputId) recorded.add(row.companionInputId);
    } }
    catch { /* delivered, retained, and still visible until canonical recording succeeds */ }
  }
  if (recorded.size || current.some(row => anchored.has(row.id) && (!row.historyAnchored || row.historySeq !== anchored.get(row.id)))) {
    try { await commit(current.map(row => recorded.has(row.id) || anchored.has(row.id)
      ? { ...row, ...(recorded.has(row.id) ? { historyRecorded: true } : {}), ...(anchored.has(row.id) ? { historyAnchored: true, historySeq: anchored.get(row.id) } : {}) } : row)); }
    catch { /* the durable delivery receipt remains; canonical retry is idempotent */ }
  }
}
export function cancelInput(id: string): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const selected = current.find((entry) => entry.id === id);
    const found = selected && (companionOf(current, selected) ?? selected);
    if (!found || !['queued', 'browser', 'failed', 'cancelled'].includes(found.state)) return false;
    await commit(current.map((entry) => sameDelivery(found, entry) ? { ...entry, state: 'cancelled', cancelledByUser: true,
      error: found.state === 'browser' ? found.requiresAuthorization && found.sendAuthorizedAt === undefined
        ? 'Not sent: this delivery was cancelled before Send was authorized.'
        : 'Cancelled locally. Delivery to ChatGPT is unconfirmed; the message may already have been sent.'
        : found.state === 'queued' ? undefined : entry.error } : entry));
    decisionWaiters.get(id)?.reject(new Error('goal_browser_cancelled'));
    decisionWaiters.delete(id);
    await removeWithdrawnOpening(entries!.find(row => row.id === found.id)!, entries!);
    return true;
  });
}

/** Only explicit withdrawal of a provably unsent opening retires its empty reservation.
 * The cancelled outbox row remains the tombstone; timeout/failure never grants deletion.
 * Runs under the input queue, which also owns initial provider binding and Send authority. */
async function removeWithdrawnOpening(row: InputEntry, current: InputEntry[]): Promise<void> {
  if (!row.opening || !row.sessionId || row.state !== 'cancelled' ||
      !(row.cancelledByUser || row.error === 'Not sent: this delivery was cancelled before Send was authorized.') ||
      row.sendAuthorizedAt !== undefined || row.deliveredAt !== undefined || row.messageId || row.conversationId ||
      (row.offeredAt !== undefined && row.requiresAuthorization !== true) ||
      current.some(other => other.id !== row.id && other.sessionId === row.sessionId && !terminal(other))) return;
  const session = await getSession(row.sessionId);
  if (!session || session.origin?.kind !== 'desktop' || session.conversationId || session.chatIds?.length !== 0 || session.events !== 0) return;
  await deleteSession(session.id);
  try { deliveryHooks?.changed(); } catch { /* deletion is already committed */ }
}

/** The last tool in a turn may be followed by a final rather than another MCP call.
 * Join that final to the recorded exact request, preserving restart proof and rejecting
 * interim prose, old finals, foreign turns and calls still publishing their response. */
async function settleToolInputFromFinal(row: InputEntry): Promise<InputEntry> {
  if (!row.sessionId || !row.conversationId || !row.owner || row.offeredAt === undefined ||
      inFlightToolCalls(row.conversationId) > 0) return row;
  const session = await getSession(row.sessionId);
  if (session?.conversationId !== row.conversationId || session.lastAssistantFinalAt == null) return row;
  const calls = await readRecentEvents(row.sessionId, 256, { kinds: ['tool_call'] });
  const call = calls.find(event => event.kind === 'tool_call' && event.source === 'mcp' && event.turnId &&
    (!row.toolTurnId || event.turnId === row.toolTurnId) &&
    event.call.attribution === 'request_id' && event.call.requestId === row.owner &&
    event.call.conversationId === row.conversationId && event.time <= row.offeredAt!);
  if (!call?.turnId) return row;
  const final = await readCompletedFinal(row.sessionId, row.conversationId, call.turnId);
  if (!final || final.completedAt <= row.offeredAt || final.contentSeq <= call.seq ||
      inFlightToolCalls(row.conversationId) > 0) return row;
  return { ...row, state: 'sent', toolTurnId: call.turnId, messageId: `input:${row.id}`, deliveredAt: final.completedAt, historyRecorded: false };
}

/** Editing is possible only before handout. Recovery shares delivery custody,
 * but its frozen message and source never belong to the authored task order. */
export function reorderQueuedInputs(sessionId: string, ids: string[]): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const queue = current.filter(row => row.sessionId === sessionId && queuedFollowup(row) && !row.recovery && row.state === 'queued');
    // A stale snapshot must not move claimed input or omit newly queued work.
    if (!ids.length || ids.length !== queue.length || new Set(ids).size !== ids.length ||
        queue.some(row => !ids.includes(row.id))) return false;
    const positions = new Map(ids.map((id, index) => [id, index]));
    const ticket = queue.find(row => row.silenceBoundary)?.silenceBoundary;
    await commit(current.map(row => positions.has(row.id) ? { ...row, queueOrder: positions.get(row.id)!,
      ...(ticket ? { silenceBoundary: row.id === ids[0] ? ticket : undefined } : {}) } : row));
    return true;
  });
}

/** Called inside the existing serialized settings transaction after publishing Off
 * and before re-enabling On (also recovering a failed earlier retirement).
 * A later On cannot revive these durable cancellations, even across restart. */
export function cancelFinishInputs(periodicOnly: boolean): Promise<void> {
  return serial(async () => {
    const current = await load();
    const next = current.map(row => row.finishOwner && (!periodicOnly || row.finishOwner.periodic) && !terminal(row)
      ? { ...row, state: 'cancelled' as const, error: 'Automatic follow-up cancelled by settings. Already offered input may have reached ChatGPT.' } : row);
    if (next.some((row, index) => row !== current[index])) await commit(next);
  });
}

export function editQueuedInput(id: string, text: string, afterTurn?: boolean): Promise<boolean> {
  return serial(async () => {
    const value = inputArgs.shape.text.parse(text);
    const current = await load();
    const row = current.find(entry => entry.id === id && entry.state === 'queued' && queuedFollowup(entry) && !entry.recovery);
    if (!row) return false;
    if (current.filter(entry => !terminal(entry)).reduce((sum, entry) => sum + Buffer.byteLength(entry === row ? value : entry.text), 0) > 1024000) throw new Error('Queued messages exceed the text limit');
    await commit(current.map(entry => entry === row ? { ...row, text: value, authoredSource: 'text', ...(afterTurn === undefined ? {} : { afterTurn }), deliveryText: undefined } : entry));
    return true;
  });
}

/** Revalidate the same durable claim immediately before sending; never hand out text again. */
export function authorizeBrowserInput(id: string, owner: string, conversationId: string | null): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const row = current.find(row => row.id === id && row.owner === owner && row.state === 'browser' && row.conversationId === conversationId);
    if (!row || row.sendAuthorizedAt !== undefined || companionOf(current, row)) return false;
    if (!(await browserInputAllowed(row)) || await target(row) !== conversationId) return false;
    if (row.companionInputId) {
      const companion = current.find(other => other.id === row.companionInputId && other.state === 'browser' && other.owner === owner && other.sessionId === row.sessionId);
      const session = row.sessionId ? await getSession(row.sessionId) : null;
      if (!companion || !session || !queuedAfterTurn({ ...companion, state: 'queued' }, session)) return false;
    }
    await commit(current.map(entry => sameDelivery(row, entry) ? { ...entry, sendAuthorizedAt: Date.now() } : entry));
    // Recorder work is serialized independently and can arrive during the durable
    // claim write. Keep the spent claim, but never publish stale Send permission.
    if (row.recovery && !await recoveryCurrent(row)) return false;
    // Recovery still has a native final veto after this await. Its browser claim
    // holds Goal until either the exact send receipt or a known pre-click abort.
    if (!row.recovery && row.completedTurnId && row.sessionId && conversationId)
      await consumeGoalReplyForInputNow(conversationId, row.sessionId, row.completedTurnId);
    return !row.recovery || await recoveryCurrent(row);
  });
}
/** The same outbox serialization owns mode changes and browser ACK. A late ACK
 * must observe Off; an ACK that won first is followed by the exact bound-chat Off. */
export function setInputAutomation(id: string, automation: NonNullable<InputArgs['automation']>, loopAfterTurn?: boolean): Promise<boolean> {
  return serial(async () => {
    const mode = z.enum(['off', 'goal', 'loop']).parse(automation);
    const delivery = z.boolean().optional().parse(loopAfterTurn);
    const current = await load();
    const entry = current.find(row => row.id === id && row.purpose !== 'decision' && ['queued', 'browser', 'sent', 'tool'].includes(row.state));
    if (!entry) return false;
    const conversationId = entry.conversationId;
    if (conversationId && await conversationWasSuperseded(conversationId)) return false;
    const sessionId = entry.sessionId ?? entry.deliveredSessionId;
    if (sessionId && (await getSession(sessionId))?.conversationId !== conversationId) return false;
    await commit(current.map(row => row === entry ? { ...row, automation: mode,
      ...(delivery === undefined ? {} : { loopAfterTurn: delivery }) } : row));
    if (conversationId && (mode === 'off' || entry.state !== 'queued')) {
      if (!deliveryHooks) throw new Error('Input delivery is not ready');
      // Mode changes preserve the chat's current objective. Only the delivery
      // transition transfers the opening text; an old outbox row must not overwrite
      // an objective the user edited after this message was delivered.
      await deliveryHooks.applyAutomation(conversationId, mode, entry.state === 'sent' ? 'after-send' : 'before-send', undefined, delivery);
    }
    return true;
  });
}
export function noteInputStartupError(id: string, error: string | null): Promise<InputEntry | null> {
  return serial(async () => {
    const current = await load();
    const row = current.find(entry => entry.id === id);
    if (!row) return null;
    if (row.state !== 'queued') return { ...row };
    // Retry session materialization through its accepted identity before releasing
    // browser delivery. A failed project write must not be hidden by a wake result.
    try { await materializeOpening(row); }
    catch (failure) { error = 'Local chat setup failed: ' + (failure as Error).message; }
    const next = { ...row, error: error ? error.slice(0, 200) : undefined };
    await commit(current.map(entry => entry === row ? next : entry));
    return { ...next };
  });
}
/** The same exact source boundary must still apply at claim and final Send authorization. */
async function eligibleStageEnd(entry: InputEntry): Promise<string | null> {
  if (!entry.sessionId) return null;
  if (entry.recovery) return await recoveryCurrent(entry) &&
    ['ready', 'resumed'].includes(entry.recovery.phase) && (entry.silenceBoundary?.listenUntil ?? 0) <= Date.now()
    ? entry.silenceBoundary!.turnId : null;
  const session = await getSession(entry.sessionId);
  if (!session || session.origin?.kind === 'worker') return null;
  const [end] = await readRecentEvents(entry.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
  // A later native final cannot erase an actual busy rejection. Keep this
  // existing delay for the exact source turn until its native retry is due.
  if (entry.silenceBoundary?.nativeBusy && (entry.silenceBoundary.listenUntil ?? 0) > Date.now()) return null;
  // Explicit corrections bypass only the failed-view wait. Ordinary silence still
  // needs its confirmed refresh, and fresh work/in-flight custody always veto Send.
  if (manualInput(entry) && !session.activeTurnId && end?.kind === 'turn_end' && end.turnId &&
      end.outcome === 'failed' && end.reason === 'thinking_failed' &&
      (session.lastToolCallAt ?? 0) <= end.time && session.conversationId &&
      !isChatBlocked(session.conversationId) && inFlightToolCalls(session.conversationId) === 0) return end.turnId;
  if (entry.silenceBoundary) {
    const boundary = entry.silenceBoundary;
    if (session.conversationId !== boundary.conversationId || isChatBlocked(boundary.conversationId) ||
        (session.activeTurnId && session.activeTurnId !== boundary.turnId) || inFlightToolCalls(boundary.conversationId) > 0) return null;
    if (end?.turnId !== boundary.turnId) return null;
    if (!(end.kind === 'turn_end' && end.outcome === 'completed') &&
        !await turnHasMcpCall(entry.sessionId, boundary.conversationId, boundary.turnId)) return null;
    if (end.kind !== 'turn_end' || end.outcome !== 'completed') {
      if ((boundary.listenUntil ?? 0) > Date.now() ||
          (end.kind === 'turn_end' && (session.lastToolCallAt ?? 0) > end.time)) return null;
      const [work] = await readRecentEvents(entry.sessionId, 1, { kinds: INPUT_WORK_KINDS });
      return work && workSequence(work) === boundary.workSeq ? boundary.turnId : null;
    }
    // A real final supersedes the silence assumption and spends the same source turn.
  }
  if (session.activeTurnId) return null;
  // A failure releases manual input immediately. Automatic follow-ups require
  // the confirmed refresh ticket above; only a real completion bypasses it.
  if (end?.kind !== 'turn_end' || end.outcome !== 'completed' || !end.turnId) return null;
  // Queue intent names the turn we were waiting for, not when Chrome reported it.
  // Other turns and legacy rows retain the later-completion rule. A rebind cannot
  // lend this reference to another frontend, even if its turn id happens to match.
  const queuedHere = entry.queuedTurn?.conversationId === session.conversationId && entry.queuedTurn?.turnId === end.turnId;
  if (!queuedHere && end.time < entry.createdAt) return null;
  if (!(await sessionInputPolicy(entry.sessionId)).settled) return null;
  return end.turnId;
}
const INPUT_WORK_KINDS: import('../../shared/session.js').SessionEvent['kind'][] =
  ['user_message', 'assistant_message', 'tool_call', 'page_tool', 'turn_start', 'turn_end'];

function queuedAfterTurn(row: InputEntry, session: SessionSummary): boolean {
  const astra = session.selectedModel?.conversationId === session.conversationId &&
    isAstraModel(session.selectedModel.model, session.selectedModel.reasoningEffort);
  return row.sessionId === session.id && (queuedFollowup(row) || (manualInput(row) && row.offeredAt === undefined)) && row.state === 'queued' && row.dueAt <= Date.now() &&
    (row.mode !== 'finish' || row.afterTurn === true || !astra);
}
export async function hasQueuedAfterTurnInput(sessionId: string): Promise<boolean> {
  const session = await getSession(sessionId);
  return !!session && (await load()).some(row => queuedAfterTurn(row, session));
}

/** Read the same visible head as claims, including its still-running listening window.
 * Historical restored tickets without an acceptance timestamp never arm browser recovery. */
export function pendingQueuedPickups(): Promise<Array<{ conversationId: string; sessionId: string; sourceTurnId: string; acceptedAt: number; listenUntil: number; pro: boolean }>> {
  return serial(async () => {
    const rows = await load();
    const result: Array<{ conversationId: string; sessionId: string; sourceTurnId: string; acceptedAt: number; listenUntil: number; pro: boolean }> = [];
    const pending = ordered(rows).filter(row => row.sessionId && row.purpose !== 'decision' && ['queued', 'browser', 'tool'].includes(row.state));
    for (const sessionId of new Set(pending.map(row => row.sessionId))) {
      const candidates = pending.filter(row => row.sessionId === sessionId);
      const row = candidates.find(row => manualInput(row) && row.silenceBoundary) ?? candidates[0]!;
      if (!row.sessionId) continue;
      if (row.state !== 'queued' || (!queuedFollowup(row) && !manualInput(row)) || row.dueAt > Date.now()) continue;
      const session = await getSession(row.sessionId);
      if (!session?.conversationId || !queuedAfterTurn(row, session)) continue;
      const probe = row.silenceBoundary ? { ...row, silenceBoundary: { ...row.silenceBoundary, listenUntil: undefined } } : row;
      const sourceTurnId = await eligibleStageEnd(probe);
      if (!sourceTurnId || rows.some(other => other.sessionId === row.sessionId &&
          (consumedTurn(other, sourceTurnId) || other.state === 'browser' || other.state === 'tool'))) continue;
      const [end] = await readRecentEvents(row.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
      const completed = end?.kind === 'turn_end' && end.outcome === 'completed';
      const acceptedAt = row.silenceBoundary?.acceptedAt ?? (!row.silenceBoundary && completed ? end.time : undefined);
      if (acceptedAt === undefined) continue;
      const selection = session.selectedModel;
      result.push({ conversationId: session.conversationId, sessionId: row.sessionId, sourceTurnId, acceptedAt,
        listenUntil: completed && !row.silenceBoundary?.nativeBusy ? 0 : row.silenceBoundary?.listenUntil ?? 0,
        pro: selection?.conversationId === session.conversationId && isProModel(selection.model, selection.reasoningEffort) });
    }
    return result;
  });
}

function consumedTurn(row: InputEntry, turnId: string): boolean {
  return row.completedTurnId === turnId &&
    (row.sendAuthorizedAt !== undefined || row.deliveredAt !== undefined || row.requiresAuthorization === false);
}

/** The visible outbox precedes automatic Goal work, including an ineligible head.
 * A spent completion also belongs to its user input after that row leaves the queue. */
export function inputBeforeGoal(sessionId: string, sourceTurnId?: string): Promise<'queued' | 'consumed' | null> {
  return serial(async () => {
    const rows = await load();
    if (rows.some(row => row.sessionId === sessionId && row.purpose !== 'decision' &&
      ['queued', 'browser', 'tool'].includes(row.state))) return 'queued';
    return sourceTurnId && rows.some(row => row.sessionId === sessionId && consumedTurn(row, sourceTurnId)) ? 'consumed' : null;
  });
}

/** A native-only queue head needs the held answer to finish before it can send. */
export function finishNeedsBrowserInput(sessionId: string): Promise<boolean> {
  return serial(async () => {
    const head = ordered(await load()).find(row => row.sessionId === sessionId && row.purpose !== 'decision' &&
      ['queued', 'browser', 'tool'].includes(row.state));
    if (!head || head.state !== 'queued' || head.dueAt > Date.now() ||
      !(head.mode === 'after-turn' || (head.attachments?.length && head.attachmentDelivery !== 'tool'))) return false;
    const session = await getSession(sessionId);
    return !!session && queuedAfterTurn(head, session);
  });
}

// Control-only turn_end observations (including our own Stop) are not renewed work.
const RECOVERY_WORK_KINDS: import('../../shared/session.js').SessionEvent['kind'][] =
  ['user_message', 'assistant_message', 'tool_call', 'page_tool', 'turn_start'];
function releaseRecoveryClaim(row: InputEntry): InputEntry {
  return { ...row, state: 'queued', owner: null, offeredAt: undefined, completedTurnId: undefined,
    recovery: { ...row.recovery!, phase: row.recovery!.phase === 'ready' ? 'ready' : 'resumed' } };
}
async function recoveryCurrent(row: InputEntry): Promise<boolean> {
  const conversationId = row.silenceBoundary?.conversationId;
  // Unassigned calls conservatively block every chat while attribution settles.
  // They cannot prove that this frozen source resumed. Hold the ticket, rechecking
  // around asynchronous validation; actual recorded work still retires it below.
  return !!conversationId && inFlightToolCalls(conversationId) === 0 &&
    await recoveryInvalidReason(row) === null && inFlightToolCalls(conversationId) === 0;
}
/** Keep the rejection on the existing outbox receipt so an audit can identify the veto. */
async function recoveryInvalidReason(row: InputEntry): Promise<string | null> {
  const boundary = row.silenceBoundary;
  if (!row.recovery || !row.sessionId || !boundary) return 'the recovery source is missing';
  if (Date.now() - row.createdAt >= 12 * 60 * 60_000) return 'the twelve-hour recovery window expired';
  const unavailable = () => isChatBlocked(boundary.conversationId) ? 'this chat is blocked' :
    deliveryHooks?.recoveryAllowed?.(row.sessionId!, boundary.conversationId) !== true ? 'automatic continuation is off or paused' : null;
  const reason = unavailable();
  if (reason) return reason;
  const session = await getSession(row.sessionId);
  if (!session || session.conversationId !== boundary.conversationId) return 'the session moved to another chat';
  if (session.browserRecoveryDismissedAt !== undefined) return 'the browser chat was closed';
  if (session.origin?.kind === 'worker' || session.origin?.kind === 'helper') return 'this task has a separate recovery owner';
  if (session.activeTurnId && session.activeTurnId !== boundary.turnId) return 'another turn started';
  if (session.finishTurn?.released) return 'the turn was released';
  const [end] = await readRecentEvents(row.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
  if (end?.turnId !== boundary.turnId) return 'the recorded turn changed';
  if (end.kind === 'turn_end' && end.outcome === 'stopped') return 'the user stopped the turn';
  if (!await turnHasMcpCall(row.sessionId, boundary.conversationId, boundary.turnId)) return 'the source has no confirmed local tool call';
  if (await readCompletedFinal(row.sessionId, boundary.conversationId)) return 'the complete answer arrived';
  const question = await readLatestUserMessage(row.sessionId, boundary.turnId);
  const [work] = await readRecentEvents(row.sessionId, 1, { kinds: RECOVERY_WORK_KINDS });
  if (question?.messageId !== row.recovery.questionId) return 'another user message arrived';
  if (!work || workSequence(work) !== boundary.workSeq) return 'the source received new work';
  const changed = unavailable();
  if (changed) return changed;
  return (await getSession(row.sessionId))?.conversationId === boundary.conversationId ? null : 'the session moved to another chat';
}

/** Shared unfinished-response ticket; mode policy belongs to the bridge hook. */
export function fileRecoveryInput(sessionId: string, conversationId: string, turnId: string, pro: boolean,
  currentOwner: () => boolean, busyUntil = Date.now() + recoveryBusyMs(pro), episode = `turn:${turnId}`): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    // Never overtake authored input, retry an ambiguous send, or reuse a spent source.
    if (current.some(row => row.sessionId === sessionId && !terminal(row))) return false;
    const question = await readLatestUserMessage(sessionId, turnId);
    const [work] = await readRecentEvents(sessionId, 1, { kinds: RECOVERY_WORK_KINDS });
    if (!question?.messageId || !work || !currentOwner()) return false;
    // Automatic withdrawal before Send did not answer the turn. It may be filed
    // again under fresh source proof; manual cancellation and failed/live rows
    // keep their existing veto. Any authorization or receipt is spent even when
    // the row later becomes cancelled, including across recovery episodes.
    if (current.some(row => row.sessionId === sessionId && row.recovery && row.silenceBoundary?.turnId === turnId &&
        (row.sendAuthorizedAt !== undefined || row.deliveredAt !== undefined || row.messageId ||
          ((!row.recovery.episode || row.recovery.episode === episode) &&
            (row.state !== 'cancelled' || row.cancelledByUser))))) return false;
    const now = Date.now();
    const row: InputEntry = { id: randomUUID(), sessionId, conversationId, owner: null, state: 'queued',
      mode: 'after-turn', dueAt: now, createdAt: now, model: null, reasoningEffort: null,
      text: recoveryMessage(),
      recovery: { questionId: question.messageId, episode, pro, busyUntil, phase: 'ready' },
      silenceBoundary: { turnId, conversationId, workSeq: workSequence(work), acceptedAt: now } };
    if (!await recoveryCurrent(row) || !currentOwner()) return false;
    await commit(append(current, row));
    return true;
  });
}

/** Stop consumes an exact durable claim once; the same document then sends.
 * Only the shared pickup schedule may reload a ticket that remains uncollected. */
export function advanceRecoveryInput(id: string, owner: string, conversationId: string,
  action: 'stop' | 'stopped' | 'reloaded'): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const row = current.find(entry => entry.id === id && entry.state === 'browser' && entry.owner === owner &&
      entry.conversationId === conversationId && entry.sendAuthorizedAt === undefined);
    if (!row?.recovery || !await recoveryCurrent(row)) return false;
    const phase = row.recovery.phase;
    if (action === 'stop' && (phase !== 'ready' || !row.silenceBoundary?.nativeBusy ||
        (row.silenceBoundary.listenUntil ?? Infinity) > Date.now())) return false;
    if (action === 'stopped' && phase !== 'stopping') return false;
    if (action === 'reloaded' && phase !== 'reloading') return false;
    const next: InputEntry = action === 'reloaded'
      ? { ...row, state: 'queued', owner: null, offeredAt: undefined, completedTurnId: undefined,
          deliveryText: undefined, recovery: { ...row.recovery, phase: 'resumed', reloadOwner: owner } }
      : { ...row, recovery: { ...row.recovery, phase: action === 'stop' ? 'stopping' : 'resumed' } };
    await commit(current.map(entry => entry === row ? next : entry));
    // Recording can accept resumed work while this write is pending. A written
    // Stop claim is spent even when its permission was revoked before publication.
    return recoveryCurrent(next);
  });
}

/** File on the existing outbox row, never in a parallel retry/ticket ledger. */
export function fileSilenceInput(sessionId: string, conversationId: string, turnId: string, currentOwner: () => boolean, listenUntil?: number): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const session = await getSession(sessionId);
    if (!currentOwner() || !session || session.conversationId !== conversationId || isChatBlocked(conversationId) ||
        session.origin?.kind === 'worker' || session.origin?.kind === 'helper' || inFlightToolCalls(conversationId) > 0) return false;
    const [boundary] = await readRecentEvents(sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
    // The producer's exact MCP grant and elapsed silence window own this pickup;
    // a provider-authored end may already have closed the recorder's projection.
    if (!boundary || boundary.turnId !== turnId || (boundary.kind !== 'turn_start' && boundary.kind !== 'turn_end')) return false;
    if (!await turnHasMcpCall(sessionId, conversationId, turnId) || !currentOwner()) return false;
    if (current.some(row => row.sessionId === sessionId &&
      (consumedTurn(row, turnId) || (row.silenceBoundary?.turnId === turnId && row.state === 'browser')))) return true;
    if (current.some(row => row.sessionId === sessionId && (row.state === 'browser' || row.state === 'tool'))) return false;
    const candidates = ordered(current).filter(row => row.sessionId === sessionId && row.state === 'queued');
    const row = candidates.find(row => manualInput(row) && row.offeredAt === undefined && row.dueAt <= Date.now()) ?? candidates.find(queuedFollowup);
    if (!row || !queuedAfterTurn(row, session)) return false;
    if (row.recovery) return true; // Its frozen source and conditional busy deadline belong to the outbox.
    const [work] = await readRecentEvents(sessionId, 1, { kinds: INPUT_WORK_KINDS });
    if (!work || !currentOwner()) return false;
    const previous = current.find(entry => entry.sessionId === sessionId && entry.silenceBoundary?.turnId === turnId)?.silenceBoundary;
    const listening = Math.max(listenUntil ?? 0, previous?.listenUntil ?? 0);
    if (row.silenceBoundary?.turnId === turnId && row.silenceBoundary.workSeq === workSequence(work) &&
        (row.silenceBoundary.listenUntil ?? 0) === listening) return true;
    await commit(current.map(entry => entry === row ? { ...entry,
      silenceBoundary: { turnId, conversationId, workSeq: workSequence(work), acceptedAt: previous ? previous.acceptedAt : Date.now(), ...(listening ? { listenUntil: listening } : {}), ...(previous?.nativeBusy ? { nativeBusy: true } : {}) } }
      : entry.sessionId === sessionId && entry.state === 'queued' && entry.silenceBoundary?.turnId === turnId ? { ...entry, silenceBoundary: undefined } : entry));
    return true;
  });
}

/** Native Stop after refresh or settled failure extends listening, never Send authority. */
export function deferSilenceInput(id: string, conversationId: string, turnId: string): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const row = current.find(entry => entry.id === id && entry.state === 'queued' && entry.offeredAt === undefined);
    const session = row?.sessionId ? await getSession(row.sessionId) : null;
    if (!row?.sessionId || session?.conversationId !== conversationId || await eligibleStageEnd(row) !== turnId) return false;
    let boundary = row.silenceBoundary;
    if (!boundary) {
      // A manual failed-view send can be offered before automatic refresh. Its
      // first real busy rejection owns the same per-input delay, without MCP debt.
      const [end] = await readRecentEvents(row.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
      if (!manualInput(row) || end?.kind !== 'turn_end' || end.turnId !== turnId || end.outcome !== 'failed' || end.reason !== 'thinking_failed') return false;
      const [work] = await readRecentEvents(row.sessionId, 1, { kinds: INPUT_WORK_KINDS });
      if (!work) return false;
      boundary = { conversationId, turnId, workSeq: workSequence(work), acceptedAt: Date.now() };
    }
    if (boundary.conversationId !== conversationId || boundary.turnId !== turnId) return false;
    if (row.recovery && boundary.nativeBusy) return false; // One half-window, never a rolling extension.
    await commit(current.map(entry => entry === row ? { ...row,
      silenceBoundary: { ...boundary!, listenUntil: row.recovery
        ? row.recovery.busyUntil
        : Date.now() + recoveryBusyMs(session.selectedModel?.conversationId === conversationId &&
            isProModel(session.selectedModel.model, session.selectedModel.reasoningEffort)), nativeBusy: true } } : entry));
    return true;
  });
}

function withoutSilenceClaim(row: InputEntry, preserveBoundary = false): InputEntry {
  if (row.recovery) return { ...row, state: 'cancelled', error: 'Automatic Continue cancelled by new activity.' };
  return { ...row, state: 'queued', owner: null, silenceBoundary: preserveBoundary ? row.silenceBoundary : undefined, completedTurnId: undefined,
    ...(manualInput(row) ? { transportIntent: 'tool' } : {}),
    companionInputId: undefined, offeredAt: undefined, sendAuthorizedAt: undefined, requiresAuthorization: undefined, deliveryText: undefined, error: undefined };
}
/** New work revokes an unspent ticket. Authorized sends retain custody until their exact receipt/failure. */
export function revokeSilenceInputs(sessionId: string): Promise<void> {
  return serial(async () => {
    const current = await load();
    const next = current.map(row => row.sessionId === sessionId && (row.silenceBoundary || row.completedTurnId) &&
      (row.state === 'queued' || (row.state === 'browser' && row.sendAuthorizedAt === undefined)) ? withoutSilenceClaim(row) : row);
    if (next.some((row, index) => row !== current[index])) await commit(next);
  });
}

/** Metadata only. Text is disclosed to one document only after an exclusive durable claim. */
async function completedStageBoundary(entry: InputEntry, current: InputEntry[]): Promise<string | null> {
  if (!entry.sessionId || !queuedFollowup(entry)) return null;
  // Match the displayed order. A finish-only/file/delayed head cannot be silently
  // skipped by a later after-turn row just because that transport is ready first.
  const first = ordered(current).find(row => row.sessionId === entry.sessionId && queuedFollowup(row) && row.state === 'queued');
  if (first?.id !== entry.id || first.dueAt > Date.now() || !await browserInputAllowed(first)) return null;
  const turnId = await eligibleStageEnd(entry);
  if (!turnId) return null;
  // A deferred ticket still owns this boundary. Later queue rows cannot overtake it.
  if (current.some(row => row !== entry && row.sessionId === entry.sessionId && row.state === 'queued' &&
      row.silenceBoundary?.turnId === turnId)) return null;
  if (current.some(row => row.sessionId === entry.sessionId && (consumedTurn(row, turnId) || row.state === 'tool' || row.state === 'browser'))) return null;
  if (current.some(row => row.sessionId === entry.sessionId && !queuedFollowup(row) && row.purpose !== 'decision' &&
      row.dueAt <= Date.now() && ['queued', 'browser', 'tool'].includes(row.state))) return null;
  return turnId;
}
export function pendingBrowserInputs(): Promise<Array<{ id: string; conversationId: string | null; recovery?: { questionId: string; stop: boolean }; silenceTurnId?: string; directTurn?: InputEntry['directTurn']; supersededConversationId?: string; lifetime?: 'temporary-planner' }>> {
  return serial(async () => {
    const result: Array<{ id: string; conversationId: string | null; recovery?: { questionId: string; stop: boolean }; silenceTurnId?: string; directTurn?: InputEntry['directTurn']; supersededConversationId?: string; lifetime?: 'temporary-planner' }> = [];
    const current = await load();
    for (const entry of ordered(current)) {
      if (companionOf(current, entry)) continue;
      if (!preparable(entry) || entry.dueAt > Date.now()) continue;
      if (queuedFollowup(entry) && !(entry.state === 'browser' && entry.completedTurnId) && !(await completedStageBoundary(entry, current))) continue;
      if (!(await browserInputAllowed(entry))) continue;
      try {
        const conversationId = await target(entry);
        const [end] = !entry.silenceBoundary && manualInput(entry) && entry.sessionId
          ? await readRecentEvents(entry.sessionId, 1, { kinds: ['turn_start', 'turn_end'] }) : [];
        const silenceTurnId = entry.silenceBoundary?.turnId ?? (end?.kind === 'turn_end' && end.outcome === 'failed' &&
          end.reason === 'thinking_failed' && end.turnId && await eligibleStageEnd(entry) === end.turnId ? end.turnId : undefined);
        result.push({ id: entry.id, conversationId,
          ...(entry.recovery ? { recovery: { questionId: entry.recovery.questionId, stop: entry.silenceBoundary?.nativeBusy === true && entry.recovery.phase === 'ready' } } : {}),
          ...(silenceTurnId ? { silenceTurnId } : {}),
          ...(entry.directTurn ? { directTurn: entry.directTurn } : {}),
          ...(entry.state === 'queued' && entry.purpose !== 'decision' && entry.sessionId && entry.conversationId && entry.conversationId !== conversationId
            ? { supersededConversationId: entry.conversationId } : {}),
          ...(entry.lifetime ? { lifetime: entry.lifetime } : {}) });
      } catch { /* blocked/deleted stays user-visible */ }
    }
    return result;
  });
}
export function claimBrowserInput(id: string, owner: string, conversationId: string | null, requiresAuthorization = false): Promise<BrowserInputClaim | null> {
  return serial(async () => {
    const current = await load();
    const entry = current.find((row) => row.id === id);
    if (!entry || !preparable(entry) || (entry.state === 'browser' && !requiresAuthorization) || entry.dueAt > Date.now() || !owner) return null;
    if (entry.recovery && entry.state === 'browser' && entry.owner !== owner) return null;
    if (entry.recovery?.reloadOwner === owner) return null;
    if (companionOf(current, entry)) return null;
    const completedTurnId = entry.state === 'browser' ? entry.completedTurnId : queuedFollowup(entry)
      ? await completedStageBoundary(entry, current) : manualInput(entry) ? await eligibleStageEnd(entry) : undefined;
    if (queuedFollowup(entry) && !completedTurnId) return null;
    if (await target(entry) !== conversationId) return null;
    if (!(await browserInputAllowed(entry))) return null;
    if (entry.purpose === 'decision' && !decisionWaiters.has(id)) return null;
    if (entry.projectId) await projectWorkspace(entry.projectId);
    if (entry.sessionId) {
      if (current.some((row) => !sameDelivery(entry, row) && row.sessionId === entry.sessionId && ['browser', 'tool'].includes(row.state))) return null;
      const first = ordered(current).find((row) => row.sessionId === entry.sessionId && row.state === 'queued' && queuedFollowup(row) === queuedFollowup(entry) && row.dueAt <= Date.now());
      // Follow-ups were already elected by completedStageBoundary with live
      // transport eligibility. Direct messages retain their separate FIFO.
      if (entry.state === 'queued' && !queuedFollowup(entry) && first !== entry) return null;
    }
    // The completion appendix is mandatory text too: budget it before optional AGENTS.md,
    // then freeze the complete message once. A repeated claim keeps those exact bytes.
    const session = entry.sessionId ? await getSession(entry.sessionId) : null;
    // Freeze at most the visible next checkpoint into the same exclusive browser
    // claim. Both authored rows remain intact and share one acceptance receipt.
    const queueHead = session && manualInput(entry) && entry.silenceBoundary && (entry.silenceBoundary.listenUntil ?? 0) <= Date.now() && entry.state === 'queued' &&
      await turnHasMcpCall(session.id, entry.silenceBoundary.conversationId, entry.silenceBoundary.turnId)
      ? ordered(current).find(row => row.sessionId === entry.sessionId && queuedFollowup(row) && row.state === 'queued') : undefined;
    let companion = entry.companionInputId ? current.find(row => row.id === entry.companionInputId)
      : queueHead && session && queuedAfterTurn(queueHead, session) && !queueHead.finishOwner && queueHead.purpose !== 'decision' && queueHead.attachmentDelivery !== 'tool' ? queueHead : undefined;
    if (entry.companionInputId && (!companion || companion.state !== 'browser' || companion.owner !== entry.owner || companion.sessionId !== entry.sessionId)) return null;
    // An optional checkpoint cannot make an otherwise deliverable correction too
    // large. Leave that exact head queued; never skip it to collect a later one.
    if (companion && !entry.companionInputId &&
        (!inputArgs.shape.images.safeParse([...entry.images ?? [], ...companion.images ?? []]).success ||
         !inputArgs.shape.attachments.safeParse([...entry.attachments ?? [], ...companion.attachments ?? []]).success)) companion = undefined;
    const observed = session?.selectedModel?.conversationId === conversationId ? session?.selectedModel : null;
    const selection = browserInputModel(entry);
    const settings = getConfig().ui;
    const instruction = settings.finishTool && entry.purpose !== 'decision' && session?.origin?.kind !== 'worker' && session?.origin?.kind !== 'helper' &&
      isAstraModel(selection.model ?? observed?.model, selection.model ? selection.reasoningEffort ?? undefined : observed?.reasoningEffort)
      ? finishInstruction(settings.finishLeadMinutes) : '';
    const suffix = instruction && !entry.text.includes(instruction) ? '\n\n' + instruction : '';
    let claimed: InputEntry;
    const prepareClaim = (checkpoint?: InputEntry) => prepare({ ...combinedInput(entry, checkpoint), ...(checkpoint ? { companionInputId: checkpoint.id } : {}), ...(completedTurnId ? { completedTurnId } : {}),
      ...(entry.transportIntent === 'tool' ? { transportIntent: 'browser' } : {}),
      state: 'browser', owner, conversationId, offeredAt: entry.offeredAt ?? Date.now(), requiresAuthorization }, suffix);
    try {
      try { claimed = await prepareClaim(companion); }
      catch (error) {
        if (!companion || entry.companionInputId || !(error instanceof Error) || !error.message.includes('Prepared message exceeds the delivery limit')) throw error;
        companion = undefined;
        claimed = await prepareClaim();
      }
      claimed = { ...claimed, text: entry.text, images: entry.images, attachments: entry.attachments };
    }
    catch (error) {
      // A never-handed-out oversized legacy row needs a visible terminal result,
      // not an endless series of browser claims. Existing claims keep their receipt.
      if (entry.state === 'queued') await commit(current.map(row => row === entry
        ? { ...entry, state: 'failed', error: (error as Error).message.slice(0, 200) } : row));
      throw error;
    }
    await transition(current, current.map((row) => row === entry ? claimed : row === companion ? { ...row,
      state: 'browser', owner, conversationId, offeredAt: claimed.offeredAt, requiresAuthorization, completedTurnId: claimed.completedTurnId } : row),
      entry.state === 'queued' && entry.automation && conversationId && entry.purpose !== 'decision' ? [claimed] : [], 'before-send');
    if (!requiresAuthorization && completedTurnId && entry.sessionId && conversationId)
      await consumeGoalReplyForInputNow(conversationId, entry.sessionId, completedTurnId);
    logInfo(`input ${id}: browser claimed after ${Math.max(0, Date.now() - entry.createdAt)} ms`);
    return {
      ...combinedInput(claimed, companion),
      ...selection,
      text: claimed.deliveryText ?? claimed.text,
      // The extension must never retain the prepared transport frame in ChatGPT's
      // user-editable composer after an ambiguous click. Only a human-authored
      // immediate input has a draft worth restoring.
      draftText: manualInput(entry) ? entry.text : ''
    };
  });
}
/** Initial provider binding uses the same reserved session as local admission. */
async function bindOpening(entry: InputEntry, conversationId: string): Promise<boolean> {
  if (!entry.opening || !entry.sessionId) return false;
  if (entry.conversationId && entry.conversationId !== conversationId) return false;
  if (await conversationWasSuperseded(conversationId)) return false;
  await materializeOpening(entry);
  const session = await getSession(entry.sessionId);
  if (!session || (session.conversationId && session.conversationId !== conversationId)) return false;
  if (!session.conversationId && !await rebindSession(session.id, null, conversationId)) return false;
  return true;
}
/** Bind exact opening/project ownership before the document publishes request evidence. */
export function bindBrowserInputProject(id: string, owner: string, conversationId: string): Promise<boolean> {
  return serial(async () => {
    if (!owner || !/^[0-9a-z-]{8,256}$/i.test(conversationId)) return false;
    const current = await load();
    const entry = current.find(row => row.id === id && row.owner === owner);
    if (!entry || !['browser', 'sent'].includes(entry.state) || (!entry.opening && !entry.projectId) || entry.purpose === 'decision') return false;
    if (entry.requiresAuthorization && entry.sendAuthorizedAt === undefined) return false;
    if (entry.conversationId && entry.conversationId !== conversationId) return false;
    if (await conversationWasSuperseded(conversationId)) return false;
    const bound = { ...entry, conversationId };
    if (!entry.conversationId) await commit(current.map(row => row === entry ? bound : row));
    if (entry.opening) return bindOpening(bound, conversationId);
    // Legacy pre-reservation project inputs keep their exact receipt binding.
    const heldSessionId = entry.sessionId ?? entry.deliveredSessionId;
    const session = heldSessionId ? await getSession(heldSessionId) :
      await findSessionByConversation(conversationId, { requireUnique: true }) ?? await createSession({ conversationId, title: userTitle(entry.text, entry.text), titleSource: 'fallback' });
    if (!session || session.conversationId !== conversationId) return false;
    await assignSessionProject(session.id, entry.projectId!);
    const latest = await load();
    await commit(latest.map(row => row.id === id ? { ...row, deliveredSessionId: session.id } : row));
    return true;
  });
}
export function acknowledgeBrowserInput(id: string, owner: string, conversationId?: string | null, messageId?: string): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const entry = current.find((row) => row.id === id && row.owner === owner);
    if (entry && companionOf(current, entry)) return false;
    if (!owner || !entry || !['browser', 'sent', 'decision', 'cancelled'].includes(entry.state) ||
      (entry.state === 'cancelled' && entry.purpose === 'decision')) return false;
    if (conversationId !== undefined && !(entry.lifetime === 'temporary-planner' && conversationId === null) && (!conversationId || !/^[0-9a-z-]{8,256}$/i.test(conversationId))) return false;
    if (conversationId && entry.conversationId && entry.conversationId !== conversationId) return false;
    // A fresh user send is not complete until ChatGPT assigns its exact conversation.
    // Keep the authored sessionId unchanged so retrying the original enqueue is idempotent.
    if ((entry.opening || !entry.sessionId) && entry.purpose !== 'decision' && !conversationId && !entry.conversationId) return false;
    if (messageId !== undefined && (!messageId || messageId.length > 256)) return false;
    if ((entry.state !== 'browser' && entry.state !== 'cancelled') || (entry.state === 'cancelled' && entry.deliveredAt !== undefined)) { await publishHistory(); return true; }
    const deliveredConversation = conversationId ?? entry.conversationId;
    if (entry.opening && deliveredConversation) {
      if (entry.state === 'cancelled' && entry.requiresAuthorization && entry.sendAuthorizedAt === undefined) return false;
      if (!await bindOpening(entry, deliveredConversation)) return false;
    }
    if (!entry.sessionId && entry.purpose !== 'decision' && deliveredConversation) {
      await noteChatOrigin(deliveredConversation, { kind: 'desktop', fromSessionId: null, agentId: null, task: '' });
    }
    const delivered = entry.sessionId ? await getSession(entry.sessionId) : deliveredConversation
      ? await findSessionByConversation(deliveredConversation, { requireUnique: true }) : null;
    if (entry.purpose === 'decision' && entry.lifetime !== 'temporary-planner' && deliveredConversation) await deliveryHooks?.bindHelper?.(deliveredConversation, entry.decisionSourceSessionId ?? null);
    const acknowledged: InputEntry = { ...entry, conversationId: deliveredConversation,
      deliveredSessionId: delivered?.id ?? null, state: entry.state === 'cancelled' ? 'cancelled' : entry.purpose === 'decision' ? 'decision' : 'sent',
      ...(entry.state === 'cancelled' ? { error: 'Cancelled locally; delivery was later confirmed in ChatGPT.' } : {}),
      ...(messageId ? { messageId } : {}), deliveredAt: Date.now() };
    await transition(current, current.map((row) => row === entry ? acknowledged : row.id === entry.companionInputId ? { ...row,
      state: acknowledged.state, error: acknowledged.error, deliveredSessionId: acknowledged.deliveredSessionId,
      messageId: acknowledged.messageId, deliveredAt: acknowledged.deliveredAt } : row),
      entry.state !== 'cancelled' && (entry.opening || !entry.sessionId) && entry.automation && deliveredConversation && entry.purpose !== 'decision' ? [acknowledged] : [], 'after-send');
    if (entry.completedTurnId && entry.sessionId && deliveredConversation)
      await consumeGoalReplyForInputNow(deliveredConversation, entry.sessionId, entry.completedTurnId);
    logInfo(`input ${id}: browser acknowledged after ${Math.max(0, Date.now() - entry.createdAt)} ms`);
    await publishHistory();
    return true;
  });
}
/** A later exact call proves receipt of an earlier tool response, never of a queued task. */
function toolInputReceipt(entry: InputEntry, sessionId: string, conversationId: string, startedAt: number): InputEntry {
  const deliveredAt = offered.get(entry.id);
  return entry.sessionId === sessionId && entry.conversationId === conversationId && entry.state === 'tool' &&
    deliveredAt !== undefined && startedAt > deliveredAt
    ? { ...entry, state: 'sent', messageId: `input:${entry.id}`, deliveredAt, historyRecorded: false } : entry;
}
/** Commit incoming receipt evidence before a handler decides whether user work remains. */
export function acknowledgeToolInput(sessionId: string | null | undefined, conversationId: string | null | undefined, requestId: string | null | undefined, startedAt: number): Promise<void> {
  return serial(async () => {
    if (!sessionId || !conversationId || !requestId || isChatBlocked(conversationId)) return;
    if ((await getSession(sessionId))?.conversationId !== conversationId) return;
    const current = await load();
    const next = current.map(entry => toolInputReceipt(entry, sessionId, conversationId, startedAt));
    if (!next.some((entry, index) => entry !== current[index])) return;
    await commit(next);
    for (const entry of next) if (terminal(entry)) offered.delete(entry.id);
    await publishHistory();
  });
}

export function offerToolInput(sessionId: string | null | undefined, conversationId: string | null | undefined, requestId: string | null | undefined, startedAt: number, finishBoundary = false): Promise<ToolInputBatch> {
  return serial(async () => {
    const batch: ToolInputBatch = { messages: [], reminder: '' };
    if (!sessionId || !conversationId || !requestId || isChatBlocked(conversationId)) return batch;
    const session = await getSession(sessionId);
    if (session?.conversationId !== conversationId) return batch;
    const finishSettings = getConfig().ui;
    finishBoundary = finishBoundary && finishSettings.finishTool === true && session.origin?.kind !== 'worker';
    const finishReminder = finishSettings.finishTool === true && !session.finishTurn?.released &&
      session.origin?.kind !== 'worker' && session.origin?.kind !== 'helper' &&
      session.selectedModel?.conversationId === conversationId && isAstraModel(session.selectedModel.model, session.selectedModel.reasoningEffort)
      ? finishInstruction(finishSettings.finishLeadMinutes) : '';
    const current = await load();
    // A claimed browser send owns this session until its send outcome is known.
    if (current.some((entry) => entry.sessionId === sessionId && entry.state === 'browser')) return batch;
    const head = ordered(current).find(row => row.sessionId === sessionId && queuedFollowup(row) &&
      ['queued', 'tool'].includes(row.state) && !terminal(toolInputReceipt(row, sessionId, conversationId, startedAt)));
    const delivered: string[] = [];
    let inputTaken = false;
    let payloadBytes = Buffer.byteLength(TOOL_INPUT_HEADER);
    let payloadImages = 0;
    let payloadFull = false;
    const observedActivity = deliveryHooks?.activity?.(session);
    const activeToolTurn = session.activeTurnId ?? (observedActivity?.exact ? observedActivity.turnId : undefined);
    const prepareEntry = async (entry: InputEntry): Promise<InputEntry> => {
      if (entry.sessionId !== sessionId || entry.dueAt > Date.now()) return entry;
      if (entry.attachments?.length && entry.attachmentDelivery !== 'tool' && entry.delivery !== 'tool') return entry;
      if (entry.delivery === 'tool' && entry.toolTurnId !== activeToolTurn) return entry;
      if (entry.directTurn && entry.state === 'queued' && session.activeTurnId !== entry.directTurn.id) return entry;
      // ChatGPT may reuse one request id for the whole server turn. Receipt follows
      // the actual invocation start, never a change in that grouping id.
      const received = toolInputReceipt(entry, sessionId, conversationId, startedAt);
      if (received !== entry) return received;
      if (payloadFull || (inputTaken && (entry.mode === 'finish' || entry.finishOwner)) || (entry.finishOwner && entry.createdAt >= startedAt)) return entry;
      if (entry.mode === 'finish' && !finishBoundary) return entry;
      if (entry.mode === 'finish' && entry !== head) return entry;
      // After-turn tasks own a future browser turn; they cannot block an explicit
      // Inject now message from the current tool response. Their own FIFO is unchanged.
      if ((entry.state === 'queued' && (entry.mode === 'finish' || entry.mode === 'auto')) || entry.state === 'tool') {
        let prepared: InputEntry;
        try { prepared = await prepare({ ...entry, conversationId }); }
        catch (error) { return { ...entry, state: 'failed', error: (error as Error).message.slice(0, 200) }; }
        const message = prepared.deliveryText ?? prepared.text;
        const reminder = finishReminder || batch.reminder || (entry.mode === 'finish' ? 'Work on this user task now.' : '');
        const messageBytes = Buffer.byteLength(message) + (inputTaken ? 2 : 0);
        const reminderBytes = reminder ? Buffer.byteLength(reminder) + 2 : 0;
        const images = [...entry.images ?? [], ...entry.toolImages ?? []];
        if (payloadBytes + messageBytes + reminderBytes > TOOL_INPUT_TEXT_BYTES || payloadImages + images.length > MAX_INPUT_IMAGES) { payloadFull = true; return entry; }
        payloadBytes += messageBytes;
        payloadImages += images.length;
        inputTaken = true;
        batch.messages.push({ text: message, images });
        batch.reminder = reminder;
        delivered.push(entry.id);
        return { ...prepared, state: 'tool', toolTurnId: entry.toolTurnId ?? session.activeTurnId ?? deliveryHooks?.activity?.(session).turnId,
          offeredAt: entry.offeredAt ?? Date.now(), owner: entry.state === 'tool' ? entry.owner : requestId, conversationId };
      }
      return entry;
    };
    const next: InputEntry[] = [];
    for (const entry of ordered(current).sort((a, b) => Number(a.mode === 'finish' || !!a.finishOwner) - Number(b.mode === 'finish' || !!b.finishOwner))) next.push(await prepareEntry(entry));
    if (next.some((entry, index) => entry !== current[index])) {
      const automated = next.filter((entry) => entry.state === 'tool' && entry.automation && current.some((row) => row.id === entry.id && row.state === 'queued'));
      await transition(current, next, automated, 'before-send');
    }
    for (const id of delivered) if (!offered.has(id)) offered.set(id, Date.now());
    for (const entry of next) if (terminal(entry)) offered.delete(entry.id);
    await publishHistory();
    return batch;
  });
}

export function resetInputForTests(): void { entries = null; chain = Promise.resolve(); offered.clear(); decisionWaiters.clear(); }

export async function pausedBrowserHelpers(): Promise<Array<{ id: string; sourceSessionId: string }>> {
  return (await listInputs()).filter(row => row.purpose === 'decision' && row.state === 'cancelled' && !row.conversationId && row.decisionSourceSessionId)
    .map(row => ({ id: row.id, sourceSessionId: row.decisionSourceSessionId! }));
}

/** A deliberate user action withdraws exactly one ambiguous attempt's retry fence.
 * Its old owner remains terminal forever; this never replays the previous send. */
export function authorizeBrowserHelperRetry(id: string, sourceSessionId: string): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const row = current.find(entry => entry.id === id && entry.decisionSourceSessionId === sourceSessionId
      && entry.purpose === 'decision' && entry.state === 'cancelled' && !entry.conversationId);
    if (!row || current.some(entry => entry.decisionSourceSessionId === sourceSessionId && !terminal(entry))) return false;
    await commit(current.map(entry => entry === row ? { ...entry, state: 'failed', error: 'User authorized a new helper' } : entry));
    return true;
  });
}

/** Only a pre-send failure can be declared failed. An ambiguous click stays claimed. */
export function failBrowserInput(id: string, owner: string, error: string): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const entry = current.find((row) => row.id === id && row.owner === owner && row.state === 'browser');
    if (!entry || companionOf(current, entry)) return false;
    if (entry.recovery && entry.requiresAuthorization === true && entry.sendAuthorizedAt === undefined) {
      await commit(current.map(row => row === entry ? releaseRecoveryClaim(row) : row));
      return true;
    }
    // The document reports this only while its native Send has never been attempted.
    // A final can arrive after authorization and veto that click. Retain the spent
    // claim, but do not let an unsent Continue consume the final's Goal/Loop decision.
    if (entry.recovery && entry.requiresAuthorization === true && error === 'After-turn pickup was withdrawn before Send.') {
      await commit(current.map(row => row === entry
        ? { ...row, state: 'failed', completedTurnId: undefined, error } : row));
      return true;
    }
    // A generic transport failure supplies no proof that native Send was skipped.
    if (entry.recovery && entry.sendAuthorizedAt !== undefined) return false;
    const pickupCancelled = !!(entry.silenceBoundary || entry.completedTurnId) && entry.requiresAuthorization === true &&
      entry.sendAuthorizedAt === undefined && error === 'After-turn pickup was withdrawn before Send.';
    // Losing a document before Send does not lose a still-valid refresh ticket.
    // Real work revokes its source proof independently and must earn a new window.
    const preserveBoundary = pickupCancelled && await eligibleStageEnd(entry) === entry.completedTurnId;
    await commit(current.map((row) => sameDelivery(entry, row) ? pickupCancelled
      ? withoutSilenceClaim(row, row === entry && preserveBoundary)
      : { ...row, state: entry.companionInputId ? 'cancelled' : 'failed', error: error.slice(0, 200) } : row));
    decisionWaiters.get(id)?.reject(new Error('goal_browser_send_failed: ' + error.slice(0, 200)));
    decisionWaiters.delete(id);
    return true;
  });
}

// The browser is an alternative decision transport, using this same exclusive outbox.
// A timeout cancels authority; late answers cannot become messages in the source chat.
const decisionWaiters = new Map<string, { resolve: (text: string) => void; reject: (reason: unknown) => void; publish?: (text: string) => void }>();
/** Presentation only, fenced by the same exact decision claim as its eventual answer. */
export async function publishBrowserDecision(id: string, owner: string, conversationId: string | null, text: string): Promise<boolean> {
  if (text.length > 8000) return false;
  const entry = (await load()).find(row => row.id === id && row.owner === owner && row.purpose === 'decision' &&
    row.conversationId === conversationId && ['browser', 'decision'].includes(row.state));
  const waiter = decisionWaiters.get(id);
  if (!entry || !waiter) return false;
  waiter.publish?.(text); return true;
}
export async function requestBrowserDecision(text: string, signal: AbortSignal, options: {
  lifetime?: 'temporary-planner';
  sourceSessionId?: string; conversationId?: string | null; model?: string;
  reasoningEffort?: InputArgs['reasoningEffort'];
  publish?: (text: string) => void;
} = {}): Promise<string> {
  if (!text.trim() || text.length > MAX_CHATGPT_MESSAGE_CHARS) throw new Error('goal_context_too_large');
  signal.throwIfAborted();
  const id = randomUUID();
  let resolveAnswer!: (text: string) => void;
  let rejectAnswer!: (reason: unknown) => void;
  const answer = new Promise<string>((resolve, reject) => { resolveAnswer = resolve; rejectAnswer = reject; });
  void answer.catch(() => undefined);
  decisionWaiters.set(id, { resolve: resolveAnswer, reject: rejectAnswer, publish: options.publish });
  const cancel = () => {
    decisionWaiters.delete(id);
    rejectAnswer(new Error('goal_browser_cancelled'));
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const queued = await serial(async () => {
      signal.throwIfAborted();
      const current = await load();
      if (current.filter((row) => row.purpose === 'decision' && ['queued', 'browser', 'decision'].includes(row.state)).length >= 4) throw new Error('goal_browser_busy');
      if (options.sourceSessionId && current.some(row => row.decisionSourceSessionId === options.sourceSessionId && !terminal(row))) throw new Error('goal_browser_busy');
      if (options.sourceSessionId && !options.conversationId && current.some(row => row.decisionSourceSessionId === options.sourceSessionId && row.state === 'cancelled' && !row.conversationId)) {
        throw new Error('goal_browser_send_unconfirmed');
      }
      const entry = entrySchema.parse({ id, sessionId: null, text, mode: 'after-turn', dueAt: Date.now(),
        model: options.model ?? 'gpt-5.6-sol', reasoningEffort: options.reasoningEffort ?? 'high',
        decisionSourceSessionId: options.sourceSessionId, lifetime: options.lifetime, purpose: 'decision', state: 'queued', owner: null,
        createdAt: Date.now(), conversationId: options.conversationId ?? null });
      await commit(append(current, entry));
      return entry;
    });
    signal.throwIfAborted();
    await deliveryHooks?.wakeDecision?.(queued, signal);
    signal.throwIfAborted();
    return await answer;
  } finally {
    decisionWaiters.delete(id);
    signal.removeEventListener('abort', cancel);
    // Catch an abort that raced enqueue before the answer was awaited.
    void answer.catch(() => undefined);
    await serial(async () => {
      const current = await load();
      if (current.some((row) => row.id === id && !terminal(row))) {
        await commit(current.map((row) => row.id === id && !terminal(row) ? { ...row, state: 'cancelled' } : row));
      }
    });
  }
}
export function completeBrowserDecision(id: string, owner: string, response: string, conversationId?: string | null): Promise<boolean> {
  return serial(async () => {
    if (!response.trim() || response.length > 16000) return false;
    const current = await load();
    if (current.some((entry) => entry.id === id && entry.owner === owner && entry.purpose === 'decision' && entry.state === 'sent' && entry.response === response)) return true;
    if (!decisionWaiters.has(id)) return false;
    const row = current.find((entry) => entry.id === id && entry.owner === owner && entry.purpose === 'decision' && ['browser', 'decision'].includes(entry.state));
    if (!row) return false;
    if (conversationId && row.conversationId && conversationId !== row.conversationId) return false;
    await commit(current.map((entry) => entry === row ? { ...entry, conversationId: conversationId ?? row.conversationId, state: 'sent', response } : entry));
    const waiter = decisionWaiters.get(id);
    if (!waiter) await commit((await load()).map((entry) => entry.id === id ? { ...entry, state: 'cancelled', response: undefined } : entry));
    waiter?.resolve(response);
    return !!waiter;
  });
}

/** The outbox's exact native-send receipt survives losing the helper document.
 * Collect through the existing completion transaction when the recorder carries that
 * user's final answer. This grants no new browser claim and never resubmits a prompt.
 */
export async function collectRecordedBrowserDecision(conversationId: string): Promise<void> {
  const pending = (await listInputs()).filter(row => row.purpose === 'decision' && row.state === 'decision' &&
    row.conversationId === conversationId && row.messageId && row.owner && decisionWaiters.has(row.id));
  if (pending.length !== 1 || isChatBlocked(conversationId) || await conversationWasSuperseded(conversationId)) return;
  const row = pending[0]!;
  const session = await findSessionByConversation(conversationId, { requireUnique: true });
  if (!session || (row.deliveredSessionId && session.id !== row.deliveredSessionId)) return;
  const events = await readRecentEvents(session.id, 32, { kinds: ['user_message', 'assistant_message'], maxBytes: 1_048_576 });
  const user = events.findLastIndex(event => event.kind === 'user_message');
  const prompt = events[user];
  const final = events.at(-1);
  if (user < 0 || prompt?.kind !== 'user_message' || prompt.messageId !== row.messageId ||
      final?.kind !== 'assistant_message' || !final.final || final.state !== 'final' || !final.messageId ||
      final.message.truncated || final.message.text.length > 16000) return;
  await completeBrowserDecision(row.id, row.owner!, final.message.text, conversationId);
}
