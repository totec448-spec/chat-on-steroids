import { logWarn } from './logger.js';
import { readDurable, writeDurableNow, writeDurableSoon } from './durable.js';
import {
  FRONTIER_MANUAL_SESSION_MAX_TEXT_CLAIMS,
  FRONTIER_MANUAL_SESSION_MAX_TEXT_BYTES,
  FRONTIER_MANUAL_SESSION_MODEL,
  FRONTIER_MANUAL_SESSION_REASONING,
  type FrontierManualSessionAction,
  type FrontierManualSessionGrantV1,
  type FrontierManualSessionOperationV1,
} from './frontier-manual-session-contract.js';
import { FRONTIER_MANUAL_SESSION_AUTHORITY_CLASS } from './frontier-manual-session-authority.js';
import { isRemoteSteeringDigest, isRemoteSteeringId, isRemoteSteeringTimestamp, remoteSteeringSha256 } from './remote-steering-contract.js';
import { onSessionChange } from './session/recorder.js';
import { enqueueInput, listInputs, onInputChange, type InputEntry } from './session/input.js';
import { retryQueuedInputBrowser, sendDesktopInput } from './session/start-input.js';
import { conversationWasSuperseded, getSession } from './session/store.js';
import { isChatBlocked } from './session/blocked-chats.js';
import { goalSwitchFor } from './goal.js';

const STATE = 'frontier-manual-session-state';
const RECEIPTS_STATE = 'frontier-manual-session-receipts';
// One live Travel Parent can issue nine children. Keep one full prior-root rollover
// alongside the current root so revoke/remint does not turn replay retention into a refusal.
const MAX_GRANTS = 2 * 9;
const MAX_RECEIPTS = MAX_GRANTS * FRONTIER_MANUAL_SESSION_MAX_TEXT_CLAIMS;
const RETENTION_MS = 24 * 60 * 60_000;

type CreateDeliveryState =
  | 'reserved' | 'queued' | 'browser' | 'startup_failed' | 'recording_pending'
  | 'model_pending' | 'model_mismatch' | 'automation_on' | 'session_mismatch'
  | 'cancelled' | 'failed' | 'bound';

interface GrantRecord {
  grantId: string;
  grantDigest: string;
  projectBindingDigest: string;
  expiresAt: string;
  createInputId: string;
  createOperationDigest: string;
  createTaskSha256: string;
  createTaskLength: number;
  lastMutationSeq: number;
  lastMutationDigest: string;
  lastOperationId: string;
  lastAction: Exclude<FrontierManualSessionAction, 'SESSION_STATUS'>;
  lastInputId: string;
  lastTaskSha256: string;
  lastTaskLength: number;
  lastEffectMaterialized: boolean;
  candidateSessionId: string | null;
  modelRejected: boolean;
  sessionId: string | null;
  createDelivery: CreateDeliveryState;
}

interface StateSnapshot { version: 1; grants: GrantRecord[]; }
interface Receipt {
  operationId: string;
  operationDigest: string;
  grantId: string;
  action: FrontierManualSessionAction;
  mutationSeq: number;
  inputId: string | null;
  grantExpiresAt: string;
}
interface ReceiptSnapshot { version: 1; receipts: Receipt[]; }

export type FrontierManualSessionState =
  | 'pending_out_of_order' | 'reserved' | 'opening' | 'startup_failed' | 'recording_pending'
  | 'model_pending' | 'model_mismatch' | 'automation_on' | 'session_mismatch'
  | 'bound' | 'cancelled' | 'failed' | 'unavailable';

/** Content-blind verifier projection. Local/session/conversation/input ids never leave this module. */
export interface FrontierManualSessionView {
  readonly state: FrontierManualSessionState;
  readonly found: boolean;
  readonly activeTurn: boolean;
  readonly blocked: boolean;
  readonly superseded: boolean;
  readonly modelConfirmed: boolean;
  readonly automationOff: boolean;
  readonly pendingUserInput: boolean;
}

export type FrontierManualSessionRefusal =
  | 'FRONTIER_MANUAL_SESSION_STATE_UNAVAILABLE'
  | 'FRONTIER_MANUAL_SESSION_GRANT_CONFLICT'
  | 'FRONTIER_MANUAL_SESSION_RECEIPT_STORE_FULL'
  | 'FRONTIER_MANUAL_SESSION_OPERATION_REPLAY_ALTERED'
  | 'FRONTIER_MANUAL_SESSION_OPERATION_INDETERMINATE'
  | 'FRONTIER_MANUAL_SESSION_ALREADY_CREATED'
  | 'FRONTIER_MANUAL_SESSION_NOT_CREATED'
  | 'FRONTIER_MANUAL_SESSION_CREATE_SEQUENCE_REQUIRED'
  | 'FRONTIER_MANUAL_SESSION_MUTATION_STALE'
  | 'FRONTIER_MANUAL_SESSION_MUTATION_GAP'
  | 'FRONTIER_MANUAL_SESSION_MUTATION_ALTERED'
  | 'FRONTIER_MANUAL_SESSION_INPUT_ID_CONFLICT'
  | 'FRONTIER_MANUAL_SESSION_AUTHORITY_CHANGED'
  | 'FRONTIER_MANUAL_SESSION_NOT_READY'
  | 'FRONTIER_MANUAL_SESSION_EFFECT_REFUSED';

export interface FrontierManualSessionResult {
  readonly status: 'accepted' | 'refused';
  readonly reason: FrontierManualSessionRefusal | null;
  readonly detail: string | null;
  readonly replay: boolean;
  readonly session: FrontierManualSessionView;
}
export interface FrontierManualSessionHooks {
  readonly authorityStillLive: () => boolean;
  readonly effectsAllowed?: boolean;
}

let grants = new Map<string, GrantRecord>();
let receipts = new Map<string, Receipt>();
let restored = false;
let stateHealthy = true;
let receiptStateHealthy = true;
let chain: Promise<unknown> = Promise.resolve();
let stopInputListener: (() => void) | null = null;
let stopSessionListener: (() => void) | null = null;
let reconcileScheduled = false;
let reconcileGeneration = 0;

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const work = chain.then(fn, fn);
  chain = work.then(() => undefined, () => undefined);
  return work;
}
function cloneGrant(grant: GrantRecord): GrantRecord { return { ...grant }; }
function cloneGrants(): Map<string, GrantRecord> { return new Map([...grants].map(([id, grant]) => [id, cloneGrant(grant)])); }
function stateSnapshot(source = grants): StateSnapshot { return { version: 1, grants: [...source.values()].map(cloneGrant) }; }
function receiptSnapshot(source = receipts): ReceiptSnapshot { return { version: 1, receipts: [...source.values()].map(row => ({ ...row })) }; }
function validUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function validSessionId(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-z-]{8,64}$/i.test(value); }
function validDelivery(value: unknown): value is CreateDeliveryState {
  return value === 'reserved' || value === 'queued' || value === 'browser' || value === 'startup_failed' || value === 'recording_pending' ||
    value === 'model_pending' || value === 'model_mismatch' || value === 'automation_on' || value === 'session_mismatch' ||
    value === 'cancelled' || value === 'failed' || value === 'bound';
}
function validGrantRecord(value: unknown): value is GrantRecord {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<GrantRecord>;
  return isRemoteSteeringId(row.grantId) && isRemoteSteeringDigest(row.grantDigest) && isRemoteSteeringDigest(row.projectBindingDigest) &&
    isRemoteSteeringTimestamp(row.expiresAt) && validUuid(row.createInputId) && isRemoteSteeringDigest(row.createOperationDigest) &&
    isRemoteSteeringDigest(row.createTaskSha256) && typeof row.createTaskLength === 'number' && Number.isSafeInteger(row.createTaskLength) &&
    row.createTaskLength > 0 && row.createTaskLength <= FRONTIER_MANUAL_SESSION_MAX_TEXT_BYTES &&
    typeof row.lastMutationSeq === 'number' && Number.isSafeInteger(row.lastMutationSeq) && row.lastMutationSeq >= 1 &&
    isRemoteSteeringDigest(row.lastMutationDigest) && isRemoteSteeringId(row.lastOperationId) &&
    (row.lastAction === 'SESSION_CREATE' || row.lastAction === 'SESSION_PROMPT') && validUuid(row.lastInputId) &&
    isRemoteSteeringDigest(row.lastTaskSha256) && typeof row.lastTaskLength === 'number' && Number.isSafeInteger(row.lastTaskLength) &&
    row.lastTaskLength > 0 && row.lastTaskLength <= FRONTIER_MANUAL_SESSION_MAX_TEXT_BYTES && typeof row.lastEffectMaterialized === 'boolean' &&
    (row.candidateSessionId === null || validSessionId(row.candidateSessionId)) && typeof row.modelRejected === 'boolean' &&
    (row.sessionId === null || validSessionId(row.sessionId)) && validDelivery(row.createDelivery);
}
function validReceipt(value: unknown): value is Receipt {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<Receipt>;
  return isRemoteSteeringId(row.operationId) && isRemoteSteeringDigest(row.operationDigest) && isRemoteSteeringId(row.grantId) &&
    (row.action === 'SESSION_CREATE' || row.action === 'SESSION_PROMPT') &&
    typeof row.mutationSeq === 'number' && Number.isSafeInteger(row.mutationSeq) && row.mutationSeq >= 1 &&
    validUuid(row.inputId) && isRemoteSteeringTimestamp(row.grantExpiresAt);
}
async function commitGrants(next: Map<string, GrantRecord>): Promise<void> { await writeDurableNow(STATE, stateSnapshot(next)); grants = next; }
async function commitReceipts(next: Map<string, Receipt>): Promise<void> { await writeDurableNow(RECEIPTS_STATE, receiptSnapshot(next)); receipts = next; }

function prune(nowMs: number): void {
  let grantsChanged = false; let receiptsChanged = false;
  for (const [id, grant] of grants) if (Date.parse(grant.expiresAt) + RETENTION_MS <= nowMs) { grants.delete(id); grantsChanged = true; }
  for (const [id, receipt] of receipts) if (Date.parse(receipt.grantExpiresAt) + RETENTION_MS <= nowMs) { receipts.delete(id); receiptsChanged = true; }
  if (grantsChanged) writeDurableSoon(STATE, stateSnapshot());
  if (receiptsChanged) writeDurableSoon(RECEIPTS_STATE, receiptSnapshot());
}

/** Replay evidence is retained for 24h when space permits. Expired authority must never
 * consume capacity needed by a still-live signed grant or one of its legal text claims. */
function releaseExpiredRetentionCapacity(nowMs: number, target: 'grants' | 'receipts'): void {
  if (target === 'grants') {
    if (grants.size < MAX_GRANTS) return;
    let changed = false;
    for (const [id, grant] of grants) {
      if (Date.parse(grant.expiresAt) > nowMs) continue;
      grants.delete(id); changed = true;
    }
    if (changed) writeDurableSoon(STATE, stateSnapshot());
    return;
  }
  if (receipts.size < MAX_RECEIPTS) return;
  let changed = false;
  for (const [id, receipt] of receipts) {
    if (Date.parse(receipt.grantExpiresAt) > nowMs) continue;
    receipts.delete(id); changed = true;
  }
  if (changed) writeDurableSoon(RECEIPTS_STATE, receiptSnapshot());
}

function deliveryState(row: InputEntry | undefined, bound: boolean): CreateDeliveryState {
  if (bound) return 'bound';
  if (!row) return 'reserved';
  if (row.state === 'queued') return row.error?.startsWith('Message queued. Browser startup failed:') ? 'startup_failed' : 'queued';
  if (row.state === 'browser' || row.state === 'tool') return 'browser';
  if (row.state === 'sent' || (row.state === 'cancelled' && row.deliveredAt !== undefined)) return 'recording_pending';
  if (row.state === 'cancelled') return 'cancelled';
  return 'failed';
}
function createInputMatches(row: InputEntry, grant: GrantRecord): boolean {
  const bytes = Buffer.from(row.text, 'utf8');
  return row.id === grant.createInputId && row.sessionId === null && row.purpose !== 'decision' &&
    row.authorityClass === FRONTIER_MANUAL_SESSION_AUTHORITY_CLASS && row.automation === 'off' && row.objective === undefined &&
    row.mode === 'auto' && row.model === FRONTIER_MANUAL_SESSION_MODEL && row.reasoningEffort === FRONTIER_MANUAL_SESSION_REASONING &&
    row.transportIntent === 'browser' && !row.projectId && !row.finishOwner && !row.stages?.length && !row.images?.length && !row.attachments?.length &&
    bytes.length === grant.createTaskLength && remoteSteeringSha256(bytes) === grant.createTaskSha256;
}
function promptInputMatches(row: InputEntry, operation: FrontierManualSessionOperationV1, sessionId: string): boolean {
  const bytes = Buffer.from(row.text, 'utf8');
  return row.id === operation.inputId && row.sessionId === sessionId && row.purpose !== 'decision' &&
    row.authorityClass === FRONTIER_MANUAL_SESSION_AUTHORITY_CLASS && row.automation === 'off' && row.objective === undefined &&
    row.mode === 'auto' && row.model === null && row.reasoningEffort === null && !row.projectId && !row.finishOwner && !row.stages?.length &&
    !row.images?.length && !row.attachments?.length && bytes.length === operation.taskLength && remoteSteeringSha256(bytes) === operation.taskSha256;
}
function promptInputMatchesReservation(row: InputEntry, record: GrantRecord): boolean {
  if (!record.sessionId) return false;
  const bytes = Buffer.from(row.text, 'utf8');
  return row.id === record.lastInputId && row.sessionId === record.sessionId && row.purpose !== 'decision' &&
    row.authorityClass === FRONTIER_MANUAL_SESSION_AUTHORITY_CLASS && row.automation === 'off' && row.objective === undefined &&
    row.mode === 'auto' && row.model === null && row.reasoningEffort === null && !row.projectId && !row.finishOwner && !row.stages?.length &&
    !row.images?.length && !row.attachments?.length && bytes.length === record.lastTaskLength && remoteSteeringSha256(bytes) === record.lastTaskSha256;
}
function exactModel(session: Awaited<ReturnType<typeof getSession>>): 'confirmed' | 'pending' | 'mismatch' {
  if (!session?.conversationId) return 'pending';
  const selected = session.selectedModel?.conversationId === session.conversationId ? session.selectedModel : null;
  if (!selected) return 'pending';
  return selected.model === FRONTIER_MANUAL_SESSION_MODEL && selected.reasoningEffort === FRONTIER_MANUAL_SESSION_REASONING ? 'confirmed' : 'mismatch';
}
async function candidateVerdict(row: InputEntry, candidateSessionId: string): Promise<'confirmed' | 'pending' | 'model_mismatch' | 'automation_on' | 'session_mismatch'> {
  if (row.state !== 'sent' || !row.deliveredAt || !row.messageId || !row.conversationId || row.deliveredSessionId !== candidateSessionId) return 'pending';
  const session = await getSession(candidateSessionId);
  if (!session || session.conversationId !== row.conversationId || session.origin?.kind !== 'frontier_manual_session') return 'session_mismatch';
  const model = exactModel(session);
  if (model === 'pending') return 'pending';
  if (model === 'mismatch') return 'model_mismatch';
  if (goalSwitchFor(session.conversationId).enabled) return 'automation_on';
  return 'confirmed';
}
function scheduleReconcile(): void {
  if (reconcileScheduled) return;
  reconcileScheduled = true;
  const generation = reconcileGeneration;
  queueMicrotask(() => {
    if (generation !== reconcileGeneration) return;
    reconcileScheduled = false;
    void serial(reconcileNow).catch(error => logWarn(`frontier manual session: reconciliation failed — ${error instanceof Error ? error.message : String(error)}`));
  });
}
async function reconcileNow(): Promise<void> {
  if (!restored || !stateHealthy) return;
  const rows = await listInputs();
  let next: Map<string, GrantRecord> | null = null;
  for (const [grantId, current] of grants) {
    if (current.sessionId) continue;
    const row = rows.find(entry => entry.id === current.createInputId);
    if (row && !createInputMatches(row, current)) {
      next ??= cloneGrants(); next.get(grantId)!.createDelivery = 'failed'; continue;
    }
    let candidate = current.candidateSessionId;
    let rejected = current.modelRejected;
    let sessionId = current.sessionId;
    let delivery = deliveryState(row, false);
    if (!candidate && row?.deliveredSessionId) candidate = row.deliveredSessionId;
    if (candidate && row && !rejected) {
      const verdict = await candidateVerdict(row, candidate);
      if (verdict === 'confirmed') { sessionId = candidate; delivery = 'bound'; }
      else if (verdict === 'model_mismatch') { rejected = true; delivery = 'model_mismatch'; }
      else if (verdict === 'automation_on') delivery = 'automation_on';
      else if (verdict === 'session_mismatch') delivery = 'session_mismatch';
      else delivery = 'model_pending';
    }
    if (candidate !== current.candidateSessionId || rejected !== current.modelRejected || sessionId !== current.sessionId || delivery !== current.createDelivery) {
      next ??= cloneGrants(); Object.assign(next.get(grantId)!, { candidateSessionId: candidate, modelRejected: rejected, sessionId, createDelivery: delivery });
    }
  }
  if (next) await commitGrants(next);
}

export async function restoreFrontierManualSession(): Promise<void> {
  if (restored) return;
  restored = true;
  const savedState = await readDurable<StateSnapshot>(STATE);
  if (savedState) {
    if (savedState.version !== 1 || !Array.isArray(savedState.grants) || savedState.grants.length > MAX_GRANTS ||
        !savedState.grants.every(validGrantRecord) || new Set(savedState.grants.map(row => row.grantId)).size !== savedState.grants.length) {
      stateHealthy = false; logWarn('frontier manual session: stored grant/session state is malformed; signed operations are refused');
    } else grants = new Map(savedState.grants.map(row => [row.grantId, cloneGrant(row)]));
  }
  const savedReceipts = await readDurable<ReceiptSnapshot>(RECEIPTS_STATE);
  if (savedReceipts) {
    if (savedReceipts.version !== 1 || !Array.isArray(savedReceipts.receipts) || savedReceipts.receipts.length > MAX_RECEIPTS ||
        !savedReceipts.receipts.every(validReceipt) || new Set(savedReceipts.receipts.map(row => row.operationId)).size !== savedReceipts.receipts.length) {
      receiptStateHealthy = false; logWarn('frontier manual session: stored receipts are malformed; signed operations are refused');
    } else receipts = new Map(savedReceipts.receipts.map(row => [row.operationId, { ...row }]));
  }
  prune(Date.now());
  stopInputListener = onInputChange(scheduleReconcile);
  stopSessionListener = onSessionChange(scheduleReconcile);
  scheduleReconcile();
}

async function boundView(sessionId: string): Promise<FrontierManualSessionView> {
  const session = await getSession(sessionId);
  if (!session?.conversationId || session.origin?.kind !== 'frontier_manual_session') return { state: 'unavailable', found: false, activeTurn: false, blocked: false, superseded: false, modelConfirmed: false, automationOff: false, pendingUserInput: false };
  const blocked = isChatBlocked(session.conversationId);
  const superseded = await conversationWasSuperseded(session.conversationId);
  const automationOff = !goalSwitchFor(session.conversationId).enabled;
  const modelConfirmed = exactModel(session) === 'confirmed';
  const inputs = (await listInputs()).filter(entry => entry.sessionId === sessionId && ['queued','browser','tool'].includes(entry.state));
  return { state: 'bound', found: true, activeTurn: Boolean(session.activeTurnId), blocked, superseded, modelConfirmed, automationOff, pendingUserInput: inputs.length > 0 };
}

async function view(record: GrantRecord | null, pending = false): Promise<FrontierManualSessionView> {
  if (pending || !record) return { state: 'pending_out_of_order', found: false, activeTurn: false, blocked: false, superseded: false, modelConfirmed: false, automationOff: true, pendingUserInput: false };
  if (!record.sessionId) {
    const row = (await listInputs()).find(entry => entry.id === record.createInputId);
    if (row && createInputMatches(row, record)) {
      const candidate = record.candidateSessionId ?? row.deliveredSessionId ?? null;
      if (candidate) {
        const verdict = await candidateVerdict(row, candidate);
        if (verdict === 'confirmed') return boundView(candidate);
        if (verdict === 'model_mismatch') return { state: 'model_mismatch', found: false, activeTurn: false, blocked: false, superseded: false, modelConfirmed: false, automationOff: true, pendingUserInput: false };
        if (verdict === 'automation_on') return { state: 'automation_on', found: false, activeTurn: false, blocked: false, superseded: false, modelConfirmed: true, automationOff: false, pendingUserInput: false };
        if (verdict === 'session_mismatch') return { state: 'session_mismatch', found: false, activeTurn: false, blocked: false, superseded: false, modelConfirmed: false, automationOff: false, pendingUserInput: false };
        return { state: 'model_pending', found: false, activeTurn: false, blocked: false, superseded: false, modelConfirmed: false, automationOff: true, pendingUserInput: false };
      }
    }
    const state: FrontierManualSessionState = record.createDelivery === 'queued' || record.createDelivery === 'browser' ? 'opening' : record.createDelivery;
    return { state, found: false, activeTurn: false, blocked: false, superseded: false, modelConfirmed: false, automationOff: record.createDelivery !== 'automation_on', pendingUserInput: false };
  }
  return boundView(record.sessionId);
}
function accepted(session: FrontierManualSessionView, replay = false, detail: string | null = null): FrontierManualSessionResult { return { status: 'accepted', reason: null, detail, replay, session }; }
function refused(reason: FrontierManualSessionRefusal, detail: string, replay = false, session?: FrontierManualSessionView): FrontierManualSessionResult {
  return { status: 'refused', reason, detail: detail.slice(0, 300), replay, session: session ?? { state: 'unavailable', found: false, activeTurn: false, blocked: false, superseded: false, modelConfirmed: false, automationOff: false, pendingUserInput: false } };
}

export type FrontierManualSessionReplayState = 'unseen' | 'exact' | 'altered';
export async function frontierManualSessionReplayState(operation: FrontierManualSessionOperationV1, operationDigest: string): Promise<FrontierManualSessionReplayState> {
  if (!restored) await restoreFrontierManualSession();
  return serial(async () => {
    if (!stateHealthy || !receiptStateHealthy || operation.action === 'SESSION_STATUS') return 'unseen';
    const receipt = receipts.get(operation.operationId);
    let seen = receipt?.operationDigest ?? null;
    for (const grant of grants.values()) if (grant.lastOperationId === operation.operationId) {
      if (seen !== null && seen !== grant.lastMutationDigest) return 'altered';
      seen = grant.lastMutationDigest;
    }
    return seen === null ? 'unseen' : seen === operationDigest ? 'exact' : 'altered';
  });
}
async function ensureReceipt(operation: FrontierManualSessionOperationV1, operationDigest: string, grant: FrontierManualSessionGrantV1, nowMs: number): Promise<FrontierManualSessionResult | null> {
  const existing = receipts.get(operation.operationId);
  if (existing) return existing.operationDigest === operationDigest ? null : refused('FRONTIER_MANUAL_SESSION_OPERATION_REPLAY_ALTERED', 'this manual-session operation id already belongs to different signed bytes');
  releaseExpiredRetentionCapacity(nowMs, 'receipts');
  if (receipts.size >= MAX_RECEIPTS) return refused('FRONTIER_MANUAL_SESSION_RECEIPT_STORE_FULL', `the manual-session receipt store is full (${MAX_RECEIPTS}); nothing was carried out`);
  const next = new Map(receipts);
  next.set(operation.operationId, { operationId: operation.operationId, operationDigest, grantId: operation.grantId, action: operation.action, mutationSeq: operation.mutationSeq, inputId: operation.inputId, grantExpiresAt: grant.expiresAt });
  try { await commitReceipts(next); return null; }
  catch (error) { return refused('FRONTIER_MANUAL_SESSION_EFFECT_REFUSED', `the manual-session operation receipt could not be saved; nothing was carried out (${error instanceof Error ? error.message : String(error)})`); }
}
function inputIdUsed(inputId: string): boolean {
  for (const grant of grants.values()) if (grant.createInputId === inputId || grant.lastInputId === inputId) return true;
  for (const receipt of receipts.values()) if (receipt.inputId === inputId) return true;
  return false;
}
async function inputIdExistsOutsideState(inputId: string): Promise<boolean> { return (await listInputs()).some(entry => entry.id === inputId); }
async function readyBound(record: GrantRecord): Promise<boolean> {
  if (!record.sessionId) return false;
  const session = await getSession(record.sessionId);
  if (!session?.conversationId || session.origin?.kind !== 'frontier_manual_session' || isChatBlocked(session.conversationId) ||
      await conversationWasSuperseded(session.conversationId) || exactModel(session) !== 'confirmed' || goalSwitchFor(session.conversationId).enabled) return false;
  return true;
}

async function createEffect(operation: FrontierManualSessionOperationV1, record: GrantRecord, replay: boolean, hooks: FrontierManualSessionHooks): Promise<FrontierManualSessionResult> {
  if (record.sessionId) return accepted(await boundView(record.sessionId), replay);
  const rows = await listInputs();
  let row = rows.find(entry => entry.id === record.createInputId);
  if (row && !createInputMatches(row, record)) return refused('FRONTIER_MANUAL_SESSION_INPUT_ID_CONFLICT', 'the signed CREATE input id belongs to bytes/settings that do not match this operation', replay, await view(record));
  if (hooks.effectsAllowed === false) return row ? accepted(await view(record), true) : refused('FRONTIER_MANUAL_SESSION_OPERATION_INDETERMINATE', 'the exact CREATE was durably reserved before expiry but no delivery evidence exists; expiry cannot authorize a new send', true, await view(record));
  try {
    if (!row) {
      if (!hooks.authorityStillLive()) return refused('FRONTIER_MANUAL_SESSION_AUTHORITY_CHANGED', 'manual-session authority changed before the fresh session could be queued', replay, await view(record));
      row = await sendDesktopInput({ id: record.createInputId, sessionId: null, text: operation.taskText!, automation: 'off', authorityClass: FRONTIER_MANUAL_SESSION_AUTHORITY_CLASS, mode: 'auto', dueAt: Date.parse(operation.issuedAt), model: FRONTIER_MANUAL_SESSION_MODEL, reasoningEffort: FRONTIER_MANUAL_SESSION_REASONING });
    } else if (replay && row.state === 'queued' && row.error?.startsWith('Message queued. Browser startup failed:')) {
      if (!hooks.authorityStillLive()) return refused('FRONTIER_MANUAL_SESSION_AUTHORITY_CHANGED', 'manual-session authority changed before the exact failed browser wake could be retried', true, await view(record));
      row = await retryQueuedInputBrowser(record.createInputId) ?? row;
    }
  } catch (error) { return refused('FRONTIER_MANUAL_SESSION_EFFECT_REFUSED', `the fresh manual session could not be queued (${error instanceof Error ? error.message : String(error)})`, replay, await view(record)); }
  const current = grants.get(record.grantId) ?? record;
  const delivery = deliveryState(row, Boolean(current.sessionId));
  if (delivery !== current.createDelivery) {
    const next = cloneGrants(); next.get(record.grantId)!.createDelivery = delivery; await commitGrants(next);
  }
  await reconcileNow();
  const latest = grants.get(record.grantId) ?? record;
  return accepted(await view(latest), replay, delivery === 'startup_failed' ? 'The signed CREATE is reserved, but browser startup failed before pickup; an exact replay may retry the same input id.' : null);
}

async function promptEffect(
  operation: FrontierManualSessionOperationV1,
  record: GrantRecord,
  replay: boolean,
  hooks: FrontierManualSessionHooks
): Promise<FrontierManualSessionResult> {
  if (!record.sessionId) return refused('FRONTIER_MANUAL_SESSION_NOT_READY', 'the manual-session child has no locally bound session', replay, await view(record));
  const row = (await listInputs()).find(entry => entry.id === operation.inputId);
  if (row && !promptInputMatches(row, operation, record.sessionId)) return refused('FRONTIER_MANUAL_SESSION_INPUT_ID_CONFLICT', 'the signed PROMPT input id belongs to bytes/settings/session that do not match this operation', replay, await view(record));
  if (row) {
    if (!record.lastEffectMaterialized) {
      const next = cloneGrants(); next.get(record.grantId)!.lastEffectMaterialized = true; await commitGrants(next);
      record = grants.get(record.grantId)!;
    }
    return accepted(await view(record), true);
  }
  if (record.lastEffectMaterialized) return refused('FRONTIER_MANUAL_SESSION_OPERATION_INDETERMINATE', 'the signed PROMPT was durably materialized but its exact queued input is missing; it will not be reconstructed or resent', true, await view(record));
  if (hooks.effectsAllowed === false) return refused('FRONTIER_MANUAL_SESSION_OPERATION_INDETERMINATE', 'the exact PROMPT was durably reserved before expiry but no delivery evidence exists; expiry cannot authorize a new enqueue', true, await view(record));
  if (!await readyBound(record)) return refused('FRONTIER_MANUAL_SESSION_NOT_READY', 'the bound manual session is not an ordinary live session on the fixed profile with automation off', replay, await view(record));
  if (!hooks.authorityStillLive()) return refused('FRONTIER_MANUAL_SESSION_AUTHORITY_CHANGED', 'manual-session authority changed before the signed prompt could be queued', replay, await view(record));
  try {
    await enqueueInput({ id: operation.inputId!, sessionId: record.sessionId, text: operation.taskText!, automation: 'off', authorityClass: FRONTIER_MANUAL_SESSION_AUTHORITY_CLASS, mode: 'auto', dueAt: Date.parse(operation.issuedAt), model: null, reasoningEffort: null });
  } catch (error) { return refused('FRONTIER_MANUAL_SESSION_EFFECT_REFUSED', `the signed manual-session prompt could not be queued (${error instanceof Error ? error.message : String(error)})`, replay, await view(record)); }
  const next = cloneGrants(); next.get(record.grantId)!.lastEffectMaterialized = true; await commitGrants(next);
  return accepted(await view(grants.get(record.grantId)!), replay);
}

export async function steerFrontierManualSession(
  operation: FrontierManualSessionOperationV1,
  grant: FrontierManualSessionGrantV1,
  grantDigest: string,
  operationDigest: string,
  hooks: FrontierManualSessionHooks,
  nowMs = Date.now()
): Promise<FrontierManualSessionResult> {
  if (!restored) await restoreFrontierManualSession();
  return serial(async () => {
    prune(nowMs);
    if (!stateHealthy || !receiptStateHealthy) return refused('FRONTIER_MANUAL_SESSION_STATE_UNAVAILABLE', 'durable manual-session state is unavailable or malformed; no effect was applied');
    const priorReceipt = receipts.get(operation.operationId);
    if (priorReceipt && priorReceipt.operationDigest !== operationDigest) return refused('FRONTIER_MANUAL_SESSION_OPERATION_REPLAY_ALTERED', 'this manual-session operation id already belongs to different signed bytes');
    let existing = grants.get(grant.grantId);
    if (existing && (existing.grantDigest !== grantDigest || existing.projectBindingDigest !== grant.projectBindingDigest || existing.expiresAt !== grant.expiresAt)) return refused('FRONTIER_MANUAL_SESSION_GRANT_CONFLICT', 'this manual-session grant id is already bound to different grant bytes');

    if (operation.action === 'SESSION_STATUS') {
      const current = grants.get(grant.grantId) ?? null;
      return accepted(await view(current, !current || operation.mutationSeq > current.lastMutationSeq));
    }

    if (operation.action === 'SESSION_CREATE') {
      if (existing) {
        if (existing.lastOperationId === operation.operationId && existing.lastMutationDigest === operationDigest) return createEffect(operation, existing, true, hooks);
        return refused('FRONTIER_MANUAL_SESSION_ALREADY_CREATED', 'this grant already reserved its one SESSION_CREATE authority', false, await view(existing));
      }
      if (operation.mutationSeq !== 1) return refused('FRONTIER_MANUAL_SESSION_CREATE_SEQUENCE_REQUIRED', 'SESSION_CREATE must be mutation sequence 1');
      releaseExpiredRetentionCapacity(nowMs, 'grants');
      if (grants.size >= MAX_GRANTS) return refused('FRONTIER_MANUAL_SESSION_EFFECT_REFUSED', `the active manual-session grant store is full (${MAX_GRANTS})`);
      if (inputIdUsed(operation.inputId!) || await inputIdExistsOutsideState(operation.inputId!)) return refused('FRONTIER_MANUAL_SESSION_INPUT_ID_CONFLICT', 'the signed CREATE input id already exists; the grant was not reserved');
      if (!hooks.authorityStillLive()) return refused('FRONTIER_MANUAL_SESSION_AUTHORITY_CHANGED', 'manual-session authority changed before CREATE could be reserved');
      const next = cloneGrants();
      const record: GrantRecord = { grantId: grant.grantId, grantDigest, projectBindingDigest: grant.projectBindingDigest, expiresAt: grant.expiresAt,
        createInputId: operation.inputId!, createOperationDigest: operationDigest, createTaskSha256: operation.taskSha256!, createTaskLength: operation.taskLength!,
        lastMutationSeq: 1, lastMutationDigest: operationDigest, lastOperationId: operation.operationId, lastAction: 'SESSION_CREATE', lastInputId: operation.inputId!,
        lastTaskSha256: operation.taskSha256!, lastTaskLength: operation.taskLength!, lastEffectMaterialized: true,
        candidateSessionId: null, modelRejected: false, sessionId: null, createDelivery: 'reserved' };
      next.set(grant.grantId, record);
      try { await commitGrants(next); }
      catch (error) { return refused('FRONTIER_MANUAL_SESSION_EFFECT_REFUSED', `the manual-session CREATE reservation could not be saved; nothing was sent (${error instanceof Error ? error.message : String(error)})`); }
      const receiptFailure = await ensureReceipt(operation, operationDigest, grant, nowMs);
      if (receiptFailure) return receiptFailure;
      return createEffect(operation, grants.get(grant.grantId)!, false, hooks);
    }

    await reconcileNow();
    existing = grants.get(grant.grantId) ?? existing;
    if (!existing) return refused('FRONTIER_MANUAL_SESSION_NOT_CREATED', 'this manual-session grant has not accepted SESSION_CREATE');
    if (operation.mutationSeq < existing.lastMutationSeq) return refused('FRONTIER_MANUAL_SESSION_MUTATION_STALE', 'the bound session already accepted a higher mutation sequence', false, await view(existing));
    if (operation.mutationSeq === existing.lastMutationSeq) {
      if (existing.lastOperationId !== operation.operationId || existing.lastMutationDigest !== operationDigest) {
        return refused('FRONTIER_MANUAL_SESSION_MUTATION_ALTERED', 'this mutation sequence is already assigned to different signed bytes', false, await view(existing));
      }
      const receiptFailure = await ensureReceipt(operation, operationDigest, grant, nowMs);
      if (receiptFailure) return receiptFailure;
      return promptEffect(operation, existing, true, hooks);
    }
    if (operation.mutationSeq !== existing.lastMutationSeq + 1) return refused('FRONTIER_MANUAL_SESSION_MUTATION_GAP', 'PROMPT must advance the mutation fence by exactly one', false, await view(existing));
    if (priorReceipt) return refused('FRONTIER_MANUAL_SESSION_OPERATION_INDETERMINATE', 'this operation receipt is ahead of the durable manual-session mutation fence; it will not be replayed or re-ordered', true, await view(existing));
    if (existing.lastAction === 'SESSION_PROMPT') {
      const priorRow = (await listInputs()).find(entry => entry.id === existing.lastInputId);
      if (!existing.lastEffectMaterialized || !priorRow || !promptInputMatchesReservation(priorRow, existing) || priorRow.state !== 'sent') {
        return refused('FRONTIER_MANUAL_SESSION_OPERATION_INDETERMINATE', 'the current manual-session PROMPT has not reached confirmed delivery on its exact bound input; a later mutation cannot overtake it', false, await view(existing));
      }
    }
    if (!existing.sessionId || !await readyBound(existing)) return refused('FRONTIER_MANUAL_SESSION_NOT_READY', 'the exact bound ordinary session is not ready on the fixed profile with automation off', false, await view(existing));
    if (inputIdUsed(operation.inputId!) || await inputIdExistsOutsideState(operation.inputId!)) return refused('FRONTIER_MANUAL_SESSION_INPUT_ID_CONFLICT', 'the signed PROMPT input id already exists; the mutation fence was not advanced', false, await view(existing));
    if (!hooks.authorityStillLive()) return refused('FRONTIER_MANUAL_SESSION_AUTHORITY_CHANGED', 'manual-session authority changed before PROMPT could be reserved', false, await view(existing));
    const next = cloneGrants(); const target = next.get(grant.grantId)!;
    Object.assign(target, {
      lastMutationSeq: operation.mutationSeq,
      lastMutationDigest: operationDigest,
      lastOperationId: operation.operationId,
      lastAction: 'SESSION_PROMPT',
      lastInputId: operation.inputId!,
      lastTaskSha256: operation.taskSha256!,
      lastTaskLength: operation.taskLength!,
      lastEffectMaterialized: false,
    });
    try { await commitGrants(next); }
    catch (error) { return refused('FRONTIER_MANUAL_SESSION_EFFECT_REFUSED', `the manual-session PROMPT reservation could not be saved; nothing was queued (${error instanceof Error ? error.message : String(error)})`, false, await view(existing)); }
    const receiptFailure = await ensureReceipt(operation, operationDigest, grant, nowMs);
    if (receiptFailure) return receiptFailure;
    return promptEffect(operation, grants.get(grant.grantId)!, false, hooks);
  });
}

export function resetFrontierManualSessionForTests(): void {
  stopInputListener?.(); stopSessionListener?.(); stopInputListener = null; stopSessionListener = null;
  reconcileGeneration += 1;
  grants.clear(); receipts.clear(); restored = false; stateHealthy = true; receiptStateHealthy = true; chain = Promise.resolve(); reconcileScheduled = false;
}
export const frontierManualSessionStateNamesForTests = { state: STATE, receipts: RECEIPTS_STATE } as const;
