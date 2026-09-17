import { logWarn } from './logger.js';
import { readDurable, writeDurableNow, writeDurableSoon } from './durable.js';
import {
  FRONTIER_LONGRUN_PARENT_MAX_SLOTS,
  FRONTIER_LONGRUN_PARENT_MAX_TEXT_BYTES,
  FRONTIER_LONGRUN_PARENT_MODEL,
  FRONTIER_LONGRUN_PARENT_REASONING,
  type FrontierLongrunParentAction,
  type FrontierLongrunParentGrantV1,
  type FrontierLongrunParentOperationV1,
} from './frontier-longrun-parent-contract.js';
import { remoteSteeringSha256 } from './remote-steering-contract.js';
import { onSessionChange } from './session/recorder.js';
import {
  cancelInput,
  enqueueInput,
  listInputs,
  onInputChange,
  type InputEntry,
} from './session/input.js';
import { retryQueuedInputBrowser, sendDesktopInput } from './session/start-input.js';
import { FRONTIER_LONGRUN_AUTHORITY_CLASS } from './frontier-longrun-authority.js';
import { getSession } from './session/store.js';
import {
  disableLongrunSessionLoop,
  longrunSessionView,
  type LongrunSessionView,
} from './session/longrun-control.js';

const STATE = 'frontier-longrun-parent-state';
const RECEIPTS_STATE = 'frontier-longrun-parent-receipts';
const STATE_VERSION = 1;
const MAX_PARENT_GRANTS = 8;
const MAX_PARENT_RECEIPTS = 256;
const STOP_RECEIPT_RESERVE = 32;
const RETENTION_MS = 24 * 60 * 60_000;

type CreateDeliveryState = 'reserved' | 'queued' | 'browser' | 'startup_failed' | 'recording_pending' | 'model_pending' | 'model_mismatch' | 'cancelled' | 'failed' | 'bound';

interface ParentSlotRecord {
  slot: number;
  createInputId: string;
  createOperationDigest: string;
  createLongrunSha256: string;
  createLongrunLength: number;
  lastMutationSeq: number;
  lastMutationDigest: string;
  lastOperationId: string;
  lastAction: Exclude<FrontierLongrunParentAction, 'SESSION_STATUS'>;
  lastInputId: string | null;
  desiredOff: boolean;
  offApplied: boolean;
  candidateSessionId: string | null;
  modelRejected: boolean;
  sessionId: string | null;
  createDelivery: CreateDeliveryState;
}

interface ParentGrantRecord {
  grantId: string;
  grantDigest: string;
  missionDigest: string;
  expiresAt: string;
  slots: ParentSlotRecord[];
}

interface ParentStateSnapshot {
  version: 1;
  grants: ParentGrantRecord[];
}

interface ParentReceipt {
  operationId: string;
  operationDigest: string;
  grantId: string;
  slot: number;
  mutationSeq: number;
  action: Exclude<FrontierLongrunParentAction, 'SESSION_STATUS'>;
  inputId: string | null;
  grantExpiresAt: string;
}

interface ParentReceiptSnapshot {
  version: 1;
  receipts: ParentReceipt[];
}

export type FrontierLongrunParentRefusal =
  | 'FRONTIER_LONGRUN_PARENT_STATE_UNAVAILABLE'
  | 'FRONTIER_LONGRUN_PARENT_GRANT_CONFLICT'
  | 'FRONTIER_LONGRUN_PARENT_RECEIPT_STORE_FULL'
  | 'FRONTIER_LONGRUN_PARENT_OPERATION_REPLAY_ALTERED'
  | 'FRONTIER_LONGRUN_PARENT_OPERATION_INDETERMINATE'
  | 'FRONTIER_LONGRUN_PARENT_SLOT_ALREADY_USED'
  | 'FRONTIER_LONGRUN_PARENT_SLOT_UNUSED'
  | 'FRONTIER_LONGRUN_PARENT_CREATE_SEQUENCE_REQUIRED'
  | 'FRONTIER_LONGRUN_PARENT_MUTATION_STALE'
  | 'FRONTIER_LONGRUN_PARENT_MUTATION_ALTERED'
  | 'FRONTIER_LONGRUN_PARENT_INPUT_ID_CONFLICT'
  | 'FRONTIER_LONGRUN_PARENT_AUTHORITY_CHANGED'
  | 'FRONTIER_LONGRUN_PARENT_SESSION_NOT_BOUND'
  | 'FRONTIER_LONGRUN_PARENT_SESSION_NOT_READY'
  | 'FRONTIER_LONGRUN_PARENT_EFFECT_REFUSED';

export type FrontierLongrunParentSlotState =
  | 'pending_out_of_order'
  | 'reserved'
  | 'opening'
  | 'startup_failed'
  | 'recording_pending'
  | 'model_pending'
  | 'model_mismatch'
  | 'bound'
  | 'stopping'
  | 'stopped'
  | 'cancelled'
  | 'failed';

export interface FrontierLongrunParentSlotView {
  readonly slot: number;
  readonly state: FrontierLongrunParentSlotState;
  /** Content-blind current session flags. Never contains a session or conversation id. */
  readonly session: LongrunSessionView | null;
}

export interface FrontierLongrunParentResult {
  readonly status: 'accepted' | 'refused';
  readonly reason: FrontierLongrunParentRefusal | null;
  readonly detail: string | null;
  readonly replay: boolean;
  readonly slot: FrontierLongrunParentSlotView | null;
}

export interface FrontierLongrunParentHooks {
  readonly authorityStillLive: () => boolean;
  /** False only for an exact durable replay after parent expiry; observe state, apply no effect. */
  readonly effectsAllowed?: boolean;
}

let grants = new Map<string, ParentGrantRecord>();
let receipts = new Map<string, ParentReceipt>();
let restored = false;
let stateHealthy = true;
let receiptStateHealthy = true;
let chain: Promise<unknown> = Promise.resolve();
let stopInputListener: (() => void) | null = null;
let stopSessionListener: (() => void) | null = null;
let reconcileScheduled = false;

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const work = chain.then(fn, fn);
  chain = work.then(() => undefined, () => undefined);
  return work;
}

function cloneSlot(slot: ParentSlotRecord): ParentSlotRecord { return { ...slot }; }
function cloneGrant(grant: ParentGrantRecord): ParentGrantRecord { return { ...grant, slots: grant.slots.map(cloneSlot) }; }
function cloneGrants(): Map<string, ParentGrantRecord> {
  return new Map([...grants].map(([id, grant]) => [id, cloneGrant(grant)]));
}

function stateSnapshot(source: Map<string, ParentGrantRecord> = grants): ParentStateSnapshot {
  return { version: STATE_VERSION, grants: [...source.values()].map(cloneGrant) };
}
function receiptSnapshot(source: Map<string, ParentReceipt> = receipts): ParentReceiptSnapshot {
  return { version: STATE_VERSION, receipts: [...source.values()].map(receipt => ({ ...receipt })) };
}

function validDigest(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
function validRemoteId(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value); }
function validUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
}
function validCreateDelivery(value: unknown): value is CreateDeliveryState {
  return value === 'reserved' || value === 'queued' || value === 'browser' || value === 'startup_failed' ||
    value === 'recording_pending' || value === 'model_pending' || value === 'model_mismatch' ||
    value === 'cancelled' || value === 'failed' || value === 'bound';
}
function validMutatingAction(value: unknown): value is ParentSlotRecord['lastAction'] {
  return value === 'SESSION_CREATE' || value === 'LONGRUN_PROMPT' || value === 'LOOP_OFF';
}

function validSlotRecord(value: unknown): value is ParentSlotRecord {
  if (!value || typeof value !== 'object') return false;
  const slot = value as Partial<ParentSlotRecord>;
  return typeof slot.slot === 'number' && Number.isSafeInteger(slot.slot) && slot.slot >= 1 && slot.slot <= FRONTIER_LONGRUN_PARENT_MAX_SLOTS &&
    validUuid(slot.createInputId) && validDigest(slot.createOperationDigest) && validDigest(slot.createLongrunSha256) &&
    typeof slot.createLongrunLength === 'number' && Number.isSafeInteger(slot.createLongrunLength) &&
    slot.createLongrunLength > 0 && slot.createLongrunLength <= FRONTIER_LONGRUN_PARENT_MAX_TEXT_BYTES &&
    typeof slot.lastMutationSeq === 'number' && Number.isSafeInteger(slot.lastMutationSeq) && slot.lastMutationSeq >= 1 &&
    validDigest(slot.lastMutationDigest) && validRemoteId(slot.lastOperationId) && validMutatingAction(slot.lastAction) &&
    (slot.lastInputId === null || validUuid(slot.lastInputId)) && typeof slot.desiredOff === 'boolean' && typeof slot.offApplied === 'boolean' &&
    (slot.candidateSessionId === null || (typeof slot.candidateSessionId === 'string' && /^[0-9a-z-]{8,64}$/i.test(slot.candidateSessionId))) &&
    typeof slot.modelRejected === 'boolean' &&
    (slot.sessionId === null || (typeof slot.sessionId === 'string' && /^[0-9a-z-]{8,64}$/i.test(slot.sessionId))) && validCreateDelivery(slot.createDelivery);
}

function validGrantRecord(value: unknown): value is ParentGrantRecord {
  if (!value || typeof value !== 'object') return false;
  const grant = value as Partial<ParentGrantRecord>;
  if (!validRemoteId(grant.grantId) || !validDigest(grant.grantDigest) || !validDigest(grant.missionDigest) ||
      !validTimestamp(grant.expiresAt) || !Array.isArray(grant.slots) || grant.slots.length > FRONTIER_LONGRUN_PARENT_MAX_SLOTS ||
      !grant.slots.every(validSlotRecord)) return false;
  return new Set(grant.slots.map(slot => slot.slot)).size === grant.slots.length;
}

function validReceipt(value: unknown): value is ParentReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<ParentReceipt>;
  return validRemoteId(receipt.operationId) && validDigest(receipt.operationDigest) && validRemoteId(receipt.grantId) &&
    typeof receipt.slot === 'number' && Number.isSafeInteger(receipt.slot) && receipt.slot >= 1 && receipt.slot <= FRONTIER_LONGRUN_PARENT_MAX_SLOTS &&
    typeof receipt.mutationSeq === 'number' && Number.isSafeInteger(receipt.mutationSeq) && receipt.mutationSeq >= 1 &&
    validMutatingAction(receipt.action) && (receipt.inputId === null || validUuid(receipt.inputId)) && validTimestamp(receipt.grantExpiresAt);
}

async function commitGrants(next: Map<string, ParentGrantRecord>): Promise<void> {
  await writeDurableNow(STATE, stateSnapshot(next));
  grants = next;
}
async function commitReceipts(next: Map<string, ParentReceipt>): Promise<void> {
  await writeDurableNow(RECEIPTS_STATE, receiptSnapshot(next));
  receipts = next;
}

function prune(nowMs: number): void {
  let grantsChanged = false;
  let receiptsChanged = false;
  for (const [id, grant] of grants) {
    if (Date.parse(grant.expiresAt) + RETENTION_MS > nowMs) continue;
    grants.delete(id); grantsChanged = true;
  }
  for (const [id, receipt] of receipts) {
    if (Date.parse(receipt.grantExpiresAt) + RETENTION_MS > nowMs) continue;
    receipts.delete(id); receiptsChanged = true;
  }
  if (grantsChanged) writeDurableSoon(STATE, stateSnapshot());
  if (receiptsChanged) writeDurableSoon(RECEIPTS_STATE, receiptSnapshot());
}

function scheduleReconcile(): void {
  if (reconcileScheduled) return;
  reconcileScheduled = true;
  queueMicrotask(() => {
    reconcileScheduled = false;
    void serial(reconcileNow).catch(error => logWarn(`frontier parent: reconciliation failed — ${error instanceof Error ? error.message : String(error)}`));
  });
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

/** A reserved slot may recover only the exact sessionless create input that its signed CREATE authored. */
function createInputMatchesSlot(row: InputEntry, slot: ParentSlotRecord): boolean {
  const bytes = Buffer.from(row.text, 'utf8');
  return row.id === slot.createInputId && row.sessionId === null && row.purpose !== 'decision' &&
    row.authorityClass === FRONTIER_LONGRUN_AUTHORITY_CLASS &&
    row.automation === 'loop' && row.objective === row.text && row.mode === 'auto' &&
    row.model === FRONTIER_LONGRUN_PARENT_MODEL && row.reasoningEffort === FRONTIER_LONGRUN_PARENT_REASONING &&
    row.transportIntent === 'browser' && !row.projectId && !row.finishOwner && !row.stages?.length &&
    !row.images?.length && !row.attachments?.length &&
    bytes.length === slot.createLongrunLength && remoteSteeringSha256(bytes) === slot.createLongrunSha256;
}

function exactParentModel(session: Awaited<ReturnType<typeof getSession>>): 'confirmed' | 'pending' | 'mismatch' {
  if (!session?.conversationId) return 'pending';
  const selected = session.selectedModel?.conversationId === session.conversationId ? session.selectedModel : null;
  if (!selected) return 'pending';
  return selected.model.trim().toLowerCase() === FRONTIER_LONGRUN_PARENT_MODEL && selected.reasoningEffort === FRONTIER_LONGRUN_PARENT_REASONING
    ? 'confirmed' : 'mismatch';
}

async function reconcileNow(): Promise<void> {
  if (!restored || !stateHealthy) return;
  const rows = await listInputs();
  let next: Map<string, ParentGrantRecord> | null = null;
  const pendingOff: Array<{ grantId: string; slot: number; sessionId: string }> = [];

  for (const [grantId, currentGrant] of grants) {
    for (const currentSlot of currentGrant.slots) {
      const row = rows.find(entry => entry.id === currentSlot.createInputId);
      if (!currentSlot.sessionId && row && !createInputMatchesSlot(row, currentSlot)) {
        next ??= cloneGrants();
        const grant = next.get(grantId)!;
        const index = grant.slots.findIndex(slot => slot.slot === currentSlot.slot);
        grant.slots[index] = { ...grant.slots[index]!, candidateSessionId: null, modelRejected: false, createDelivery: 'failed' };
        continue;
      }
      let sessionId = currentSlot.sessionId;
      let candidateSessionId = currentSlot.candidateSessionId;
      let modelRejected = currentSlot.modelRejected;
      if (!candidateSessionId && row?.deliveredSessionId) candidateSessionId = row.deliveredSessionId;
      if (!sessionId && candidateSessionId && !modelRejected) {
        const session = await getSession(candidateSessionId);
        const model = exactParentModel(session);
        if (model === 'confirmed') sessionId = candidateSessionId;
        else if (model === 'mismatch') modelRejected = true;
      }
      const nextDelivery = sessionId ? 'bound' : modelRejected ? 'model_mismatch' : candidateSessionId ? 'model_pending' : deliveryState(row, false);
      if (sessionId !== currentSlot.sessionId || candidateSessionId !== currentSlot.candidateSessionId || modelRejected !== currentSlot.modelRejected || nextDelivery !== currentSlot.createDelivery) {
        next ??= cloneGrants();
        const grant = next.get(grantId)!;
        const index = grant.slots.findIndex(slot => slot.slot === currentSlot.slot);
        grant.slots[index] = { ...grant.slots[index]!, sessionId, candidateSessionId, modelRejected, createDelivery: nextDelivery };
      }
      const effective = next?.get(grantId)?.slots.find(slot => slot.slot === currentSlot.slot) ?? currentSlot;
      if (effective.sessionId && effective.desiredOff && !effective.offApplied) {
        pendingOff.push({ grantId, slot: effective.slot, sessionId: effective.sessionId });
      }
    }
  }

  if (next) await commitGrants(next);
  for (const target of pendingOff) {
    if (!await disableLongrunSessionLoop(target.sessionId)) continue;
    const after = cloneGrants();
    const grant = after.get(target.grantId);
    const slot = grant?.slots.find(item => item.slot === target.slot);
    if (!slot || slot.sessionId !== target.sessionId || !slot.desiredOff || slot.offApplied) continue;
    slot.offApplied = true;
    await commitGrants(after);
  }
}

export async function restoreFrontierLongrunParent(): Promise<void> {
  if (restored) return;
  restored = true;
  const savedState = await readDurable<ParentStateSnapshot>(STATE);
  if (savedState) {
    if (savedState.version !== STATE_VERSION || !Array.isArray(savedState.grants) || savedState.grants.length > MAX_PARENT_GRANTS ||
        !savedState.grants.every(validGrantRecord) || new Set(savedState.grants.map(grant => grant.grantId)).size !== savedState.grants.length) {
      stateHealthy = false;
      logWarn('frontier parent: stored slot state is malformed; signed parent operations are refused until the state is repaired');
    } else {
      grants = new Map(savedState.grants.map(grant => [grant.grantId, cloneGrant(grant)]));
    }
  }
  const savedReceipts = await readDurable<ParentReceiptSnapshot>(RECEIPTS_STATE);
  if (savedReceipts) {
    if (savedReceipts.version !== STATE_VERSION || !Array.isArray(savedReceipts.receipts) || savedReceipts.receipts.length > MAX_PARENT_RECEIPTS ||
        !savedReceipts.receipts.every(validReceipt) || new Set(savedReceipts.receipts.map(receipt => receipt.operationId)).size !== savedReceipts.receipts.length) {
      receiptStateHealthy = false;
      logWarn('frontier parent: stored operation receipts are malformed; signed parent mutations are refused until the state is repaired');
    } else {
      receipts = new Map(savedReceipts.receipts.map(receipt => [receipt.operationId, { ...receipt }]));
    }
  }
  prune(Date.now());
  stopInputListener = onInputChange(scheduleReconcile);
  stopSessionListener = onSessionChange(scheduleReconcile);
  scheduleReconcile();
}

export type FrontierLongrunParentReplayState = 'unseen' | 'exact' | 'altered';

/**
 * Durable replay lookup used before live-window admission.
 *
 * Slot high-water is consulted as well as the receipt store because a crash may land the
 * durable mutation reservation immediately before its receipt. STATUS is intentionally absent:
 * it has no receipt/high-water identity and therefore always needs a fresh live operation.
 */
export async function frontierLongrunParentReplayState(
  operation: FrontierLongrunParentOperationV1,
  operationDigest: string
): Promise<FrontierLongrunParentReplayState> {
  if (!restored) await restoreFrontierLongrunParent();
  return serial(async () => {
    if (!stateHealthy || !receiptStateHealthy || operation.action === 'SESSION_STATUS') return 'unseen';
    const receipt = receipts.get(operation.operationId);
    let seenDigest = receipt?.operationDigest ?? null;
    for (const grant of grants.values()) {
      const slot = grant.slots.find(item => item.lastOperationId === operation.operationId);
      if (!slot) continue;
      if (seenDigest !== null && seenDigest !== slot.lastMutationDigest) return 'altered';
      seenDigest = slot.lastMutationDigest;
    }
    if (seenDigest === null) return 'unseen';
    return seenDigest === operationDigest ? 'exact' : 'altered';
  });
}

function accepted(slot: FrontierLongrunParentSlotView, replay = false, detail: string | null = null): FrontierLongrunParentResult {
  return { status: 'accepted', reason: null, detail, replay, slot };
}
function refused(reason: FrontierLongrunParentRefusal, detail: string, replay = false, slot: FrontierLongrunParentSlotView | null = null): FrontierLongrunParentResult {
  return { status: 'refused', reason, detail: detail.slice(0, 300), replay, slot };
}

async function slotView(slot: ParentSlotRecord): Promise<FrontierLongrunParentSlotView> {
  if (slot.sessionId) {
    const session = await longrunSessionView(slot.sessionId);
    return {
      slot: slot.slot,
      state: slot.desiredOff ? slot.offApplied ? 'stopped' : 'stopping' : 'bound',
      session
    };
  }
  const state: FrontierLongrunParentSlotState = slot.desiredOff
    ? 'stopping'
    : slot.createDelivery === 'startup_failed' ? 'startup_failed'
    : slot.createDelivery === 'recording_pending' ? 'recording_pending'
    : slot.createDelivery === 'model_pending' ? 'model_pending'
    : slot.createDelivery === 'model_mismatch' ? 'model_mismatch'
    : slot.createDelivery === 'cancelled' ? 'cancelled'
    : slot.createDelivery === 'failed' ? 'failed'
    : slot.createDelivery === 'reserved' ? 'reserved' : 'opening';
  return { slot: slot.slot, state, session: null };
}

function grantRecordFor(grant: FrontierLongrunParentGrantV1, grantDigest: string): ParentGrantRecord | null {
  const current = grants.get(grant.grantId);
  if (!current) return null;
  return current.grantDigest === grantDigest && current.missionDigest === grant.missionDigest && current.expiresAt === grant.expiresAt
    ? current : null;
}

function inputIdUsed(inputId: string): boolean {
  for (const grant of grants.values()) {
    for (const slot of grant.slots) if (slot.createInputId === inputId || slot.lastInputId === inputId) return true;
  }
  for (const receipt of receipts.values()) if (receipt.inputId === inputId) return true;
  return false;
}

function receiptCapacity(action: Exclude<FrontierLongrunParentAction, 'SESSION_STATUS'>): number {
  return action === 'LOOP_OFF' ? MAX_PARENT_RECEIPTS : MAX_PARENT_RECEIPTS - STOP_RECEIPT_RESERVE;
}

async function inputIdExistsOutsideParent(inputId: string): Promise<boolean> {
  return (await listInputs()).some(entry => entry.id === inputId);
}

async function ensureMutationReceipt(
  operation: Exclude<FrontierLongrunParentOperationV1, { action: 'SESSION_STATUS' }> | FrontierLongrunParentOperationV1,
  operationDigest: string,
  grant: FrontierLongrunParentGrantV1
): Promise<FrontierLongrunParentResult | null> {
  const existing = receipts.get(operation.operationId);
  if (existing) {
    return existing.operationDigest === operationDigest ? null
      : refused('FRONTIER_LONGRUN_PARENT_OPERATION_REPLAY_ALTERED', 'this parent operation id was already used for different signed bytes');
  }
  const capacity = receiptCapacity(operation.action as Exclude<FrontierLongrunParentAction, 'SESSION_STATUS'>);
  if (receipts.size >= capacity) {
    return refused('FRONTIER_LONGRUN_PARENT_RECEIPT_STORE_FULL', `the Frontier parent receipt store is full (${MAX_PARENT_RECEIPTS}); nothing was carried out`);
  }
  const next = new Map(receipts);
  next.set(operation.operationId, {
    operationId: operation.operationId,
    operationDigest,
    grantId: operation.grantId,
    slot: operation.slot,
    mutationSeq: operation.mutationSeq,
    action: operation.action as Exclude<FrontierLongrunParentAction, 'SESSION_STATUS'>,
    inputId: operation.inputId,
    grantExpiresAt: grant.expiresAt
  });
  try { await commitReceipts(next); }
  catch (error) {
    return refused('FRONTIER_LONGRUN_PARENT_EFFECT_REFUSED', `the parent mutation receipt could not be saved; nothing was carried out (${error instanceof Error ? error.message : String(error)})`);
  }
  return null;
}

function mutationVerdict(slot: ParentSlotRecord, operation: FrontierLongrunParentOperationV1, operationDigest: string): 'newer' | 'replay' | FrontierLongrunParentResult {
  if (operation.mutationSeq < slot.lastMutationSeq) {
    return refused('FRONTIER_LONGRUN_PARENT_MUTATION_STALE', `slot ${slot.slot} has already accepted a higher mutation sequence`);
  }
  if (operation.mutationSeq === slot.lastMutationSeq) {
    return operationDigest === slot.lastMutationDigest ? 'replay'
      : refused('FRONTIER_LONGRUN_PARENT_MUTATION_ALTERED', `slot ${slot.slot} already assigned this mutation sequence to different signed bytes`);
  }
  return 'newer';
}

async function createEffect(
  operation: FrontierLongrunParentOperationV1,
  grantId: string,
  replay: boolean,
  hooks: FrontierLongrunParentHooks
): Promise<FrontierLongrunParentResult> {
  const currentGrant = grants.get(grantId)!;
  let slot = currentGrant.slots.find(item => item.slot === operation.slot)!;
  const rows = await listInputs();
  let row = rows.find(entry => entry.id === slot.createInputId);
  if (row && !createInputMatchesSlot(row, slot)) {
    return refused('FRONTIER_LONGRUN_PARENT_INPUT_ID_CONFLICT', 'the reserved create input id belongs to bytes/settings that do not match the signed CREATE', replay, await slotView(slot));
  }
  if (hooks.effectsAllowed === false) {
    return row
      ? accepted(await slotView(slot), true)
      : refused(
          'FRONTIER_LONGRUN_PARENT_OPERATION_INDETERMINATE',
          'the exact CREATE was durably reserved before expiry, but no input delivery evidence exists; expiry cannot authorize a new send',
          true,
          await slotView(slot)
        );
  }
  try {
    if (!row) {
      if (!hooks.authorityStillLive()) return refused('FRONTIER_LONGRUN_PARENT_AUTHORITY_CHANGED', 'parent authority changed before the fresh session could be queued', replay, await slotView(slot));
      row = await sendDesktopInput({
        id: slot.createInputId,
        sessionId: null,
        text: operation.longrunText!,
        automation: 'loop',
        objective: operation.longrunText!,
        authorityClass: FRONTIER_LONGRUN_AUTHORITY_CLASS,
        mode: 'auto',
        dueAt: Date.parse(operation.issuedAt),
        model: FRONTIER_LONGRUN_PARENT_MODEL,
        reasoningEffort: FRONTIER_LONGRUN_PARENT_REASONING
      });
    } else if (replay && row.state === 'queued' && row.error?.startsWith('Message queued. Browser startup failed:')) {
      if (!hooks.authorityStillLive()) return refused('FRONTIER_LONGRUN_PARENT_AUTHORITY_CHANGED', 'parent authority changed before the exact failed browser wake could be retried', true, await slotView(slot));
      row = await retryQueuedInputBrowser(slot.createInputId) ?? row;
    }
  } catch (error) {
    return refused('FRONTIER_LONGRUN_PARENT_EFFECT_REFUSED', `the fresh Longrun session could not be queued (${error instanceof Error ? error.message : String(error)})`, replay, await slotView(slot));
  }
  const delivery = deliveryState(row, Boolean(slot.sessionId));
  if (delivery !== slot.createDelivery) {
    const next = cloneGrants();
    const target = next.get(grantId)!.slots.find(item => item.slot === slot.slot)!;
    target.createDelivery = delivery;
    await commitGrants(next);
    slot = target;
  }
  await reconcileNow();
  slot = grants.get(grantId)?.slots.find(item => item.slot === operation.slot) ?? slot;
  return accepted(await slotView(slot), replay,
    delivery === 'startup_failed' ? 'The signed session create is reserved, but browser startup failed before pickup. Relaying this exact signed CREATE may retry that same input id once the browser path is available.' : null);
}

async function promptEffect(
  operation: FrontierLongrunParentOperationV1,
  slot: ParentSlotRecord,
  replay: boolean,
  hooks: FrontierLongrunParentHooks
): Promise<FrontierLongrunParentResult> {
  if (hooks.effectsAllowed === false) {
    const row = operation.inputId ? (await listInputs()).find(entry => entry.id === operation.inputId) : undefined;
    return row
      ? accepted(await slotView(slot), true)
      : refused(
          'FRONTIER_LONGRUN_PARENT_OPERATION_INDETERMINATE',
          'the exact PROMPT was durably reserved before expiry, but no input delivery evidence exists; expiry cannot authorize a new enqueue',
          true,
          await slotView(slot)
        );
  }
  if (!slot.sessionId) return refused('FRONTIER_LONGRUN_PARENT_SESSION_NOT_BOUND', 'the slot has not acquired its exact local session yet', replay, await slotView(slot));
  const session = await getSession(slot.sessionId);
  const view = await longrunSessionView(slot.sessionId);
  if (!session?.conversationId || session.origin?.kind === 'worker' || session.origin?.kind === 'helper' || view.blocked || view.superseded ||
      view.modelClass !== 'astra' || exactParentModel(session) !== 'confirmed' || !view.finishToolEnabled) {
    return refused('FRONTIER_LONGRUN_PARENT_SESSION_NOT_READY', 'the bound slot is not an ordinary live Astra session eligible for Longrun control', replay, await slotView(slot));
  }
  if (!hooks.authorityStillLive()) return refused('FRONTIER_LONGRUN_PARENT_AUTHORITY_CHANGED', 'parent authority changed before the Longrun prompt could be queued', replay, await slotView(slot));
  try {
    await enqueueInput({
      id: operation.inputId!,
      sessionId: slot.sessionId,
      text: operation.longrunText!,
      authorityClass: FRONTIER_LONGRUN_AUTHORITY_CLASS,
      automation: 'loop',
      mode: 'auto',
      dueAt: Date.parse(operation.issuedAt),
      model: null,
      reasoningEffort: null
    });
  } catch (error) {
    return refused('FRONTIER_LONGRUN_PARENT_EFFECT_REFUSED', `the signed Longrun prompt could not be queued (${error instanceof Error ? error.message : String(error)})`, replay, await slotView(slot));
  }
  return accepted(await slotView(slot), replay);
}

async function stopEffect(
  slot: ParentSlotRecord,
  grantId: string,
  replay: boolean,
  hooks: FrontierLongrunParentHooks
): Promise<FrontierLongrunParentResult> {
  // desiredOff is itself the durable safety intent. Reconciliation is owned by the standing
  // slot state/listeners; an expired replay observes it but does not mint a fresh mutation.
  if (hooks.effectsAllowed === false) return accepted(await slotView(slot), true);
  if (!hooks.authorityStillLive()) return refused('FRONTIER_LONGRUN_PARENT_AUTHORITY_CHANGED', 'parent authority changed before Loop could be disabled', replay, await slotView(slot));
  if (!slot.sessionId) {
    await cancelInput(slot.createInputId).catch(() => false);
    return accepted(await slotView(slot), replay);
  }
  try {
    if (!slot.offApplied) {
      if (!await disableLongrunSessionLoop(slot.sessionId)) return refused('FRONTIER_LONGRUN_PARENT_SESSION_NOT_READY', 'the bound slot lost its current conversation before Loop could be disabled', replay, await slotView(slot));
      const next = cloneGrants();
      const target = next.get(grantId)!.slots.find(item => item.slot === slot.slot)!;
      target.offApplied = true;
      await commitGrants(next);
      slot = target;
    }
  } catch (error) {
    return refused('FRONTIER_LONGRUN_PARENT_EFFECT_REFUSED', `Loop-Off could not be completed (${error instanceof Error ? error.message : String(error)})`, replay, await slotView(slot));
  }
  return accepted(await slotView(slot), replay);
}

/**
 * Carries one already-authenticated parent operation. Signature/window/pin checks remain owned
 * by remote-steering.ts; this module owns only durable grant/slot sequencing and local effects.
 */
export async function steerFrontierLongrunParent(
  operation: FrontierLongrunParentOperationV1,
  grant: FrontierLongrunParentGrantV1,
  grantDigest: string,
  operationDigest: string,
  hooks: FrontierLongrunParentHooks,
  nowMs: number = Date.now()
): Promise<FrontierLongrunParentResult> {
  if (!restored) await restoreFrontierLongrunParent();
  return serial(async () => {
    prune(nowMs);
    if (!stateHealthy || !receiptStateHealthy) {
      return refused('FRONTIER_LONGRUN_PARENT_STATE_UNAVAILABLE', 'the durable Frontier parent state is unavailable or malformed; no slot authority was changed');
    }
    const storedGrant = grants.get(grant.grantId);
    if (storedGrant && !grantRecordFor(grant, grantDigest)) {
      return refused('FRONTIER_LONGRUN_PARENT_GRANT_CONFLICT', 'this grant id is already bound to different parent bytes');
    }
    const priorReceipt = receipts.get(operation.operationId);
    if (priorReceipt && priorReceipt.operationDigest !== operationDigest) {
      return refused('FRONTIER_LONGRUN_PARENT_OPERATION_REPLAY_ALTERED', 'this parent operation id was already used for different signed bytes');
    }

    let slot = storedGrant?.slots.find(item => item.slot === operation.slot) ?? null;
    if (operation.action === 'SESSION_STATUS') {
      if (!slot || slot.lastMutationSeq < operation.mutationSeq) {
        return accepted({ slot: operation.slot, state: 'pending_out_of_order', session: null });
      }
      return accepted(await slotView(slot));
    }

    if (operation.action === 'SESSION_CREATE') {
      if (slot) {
        const verdict = mutationVerdict(slot, operation, operationDigest);
        if (verdict !== 'replay') {
          if (verdict === 'newer') return refused('FRONTIER_LONGRUN_PARENT_SLOT_ALREADY_USED', `slot ${operation.slot} is already assigned and cannot create a second session`);
          return verdict;
        }
        const receiptFailure = priorReceipt ? null : await ensureMutationReceipt(operation, operationDigest, grant);
        if (receiptFailure) return receiptFailure;
        return createEffect(operation, grant.grantId, true, hooks);
      }
      if (operation.mutationSeq !== 1) {
        return refused('FRONTIER_LONGRUN_PARENT_CREATE_SEQUENCE_REQUIRED', 'SESSION_CREATE must be mutation sequence 1 on an unused slot');
      }
      if (grants.size >= MAX_PARENT_GRANTS && !storedGrant) {
        return refused('FRONTIER_LONGRUN_PARENT_EFFECT_REFUSED', `the active Frontier parent grant store is full (${MAX_PARENT_GRANTS})`);
      }
      if (receipts.size >= receiptCapacity('SESSION_CREATE')) {
        return refused('FRONTIER_LONGRUN_PARENT_RECEIPT_STORE_FULL', `the Frontier parent receipt store is full (${MAX_PARENT_RECEIPTS}); nothing was carried out`);
      }
      if (inputIdUsed(operation.inputId!) || await inputIdExistsOutsideParent(operation.inputId!)) {
        return refused('FRONTIER_LONGRUN_PARENT_INPUT_ID_CONFLICT', 'the signed create input id already exists; the slot was not reserved');
      }
      if (!hooks.authorityStillLive()) return refused('FRONTIER_LONGRUN_PARENT_AUTHORITY_CHANGED', 'parent authority changed before the slot could be reserved');
      const next = cloneGrants();
      const grantRecord = next.get(grant.grantId) ?? {
        grantId: grant.grantId,
        grantDigest,
        missionDigest: grant.missionDigest,
        expiresAt: grant.expiresAt,
        slots: []
      };
      grantRecord.slots.push({
        slot: operation.slot,
        createInputId: operation.inputId!,
        createOperationDigest: operationDigest,
        createLongrunSha256: operation.longrunSha256!,
        createLongrunLength: operation.longrunLength!,
        lastMutationSeq: 1,
        lastMutationDigest: operationDigest,
        lastOperationId: operation.operationId,
        lastAction: 'SESSION_CREATE',
        lastInputId: operation.inputId!,
        desiredOff: false,
        offApplied: false,
        candidateSessionId: null,
        modelRejected: false,
        sessionId: null,
        createDelivery: 'reserved'
      });
      grantRecord.slots.sort((left, right) => left.slot - right.slot);
      next.set(grant.grantId, grantRecord);
      try { await commitGrants(next); }
      catch (error) {
        return refused('FRONTIER_LONGRUN_PARENT_EFFECT_REFUSED', `the slot reservation could not be saved; nothing was carried out (${error instanceof Error ? error.message : String(error)})`);
      }
      const receiptFailure = await ensureMutationReceipt(operation, operationDigest, grant);
      if (receiptFailure) return receiptFailure;
      return createEffect(operation, grant.grantId, false, hooks);
    }

    if (!slot) return refused('FRONTIER_LONGRUN_PARENT_SLOT_UNUSED', `slot ${operation.slot} has not been created`);
    const mutation = mutationVerdict(slot, operation, operationDigest);
    if (mutation !== 'newer' && mutation !== 'replay') return mutation;
    const replay = mutation === 'replay' || Boolean(priorReceipt);

    if (mutation === 'newer') {
      if (!priorReceipt && receipts.size >= receiptCapacity(operation.action)) {
        return refused('FRONTIER_LONGRUN_PARENT_RECEIPT_STORE_FULL', `the Frontier parent receipt store is full for ${operation.action}; reserved Loop-Off receipt capacity was not consumed`);
      }
      if (operation.action === 'LONGRUN_PROMPT') {
        // Give exact recorder/input ACK evidence one chance to publish the local binding before
        // refusing a prompt that arrived immediately after the fresh-chat send.
        await reconcileNow();
        slot = grants.get(grant.grantId)?.slots.find(item => item.slot === operation.slot) ?? slot;
        if (!slot.sessionId) return refused('FRONTIER_LONGRUN_PARENT_SESSION_NOT_BOUND', 'the slot has not acquired its exact local session yet', false, await slotView(slot));
        if (inputIdUsed(operation.inputId!) || await inputIdExistsOutsideParent(operation.inputId!)) {
          return refused('FRONTIER_LONGRUN_PARENT_INPUT_ID_CONFLICT', 'the signed prompt input id already exists; the slot sequence was not advanced');
        }
      }
      if (!hooks.authorityStillLive()) return refused('FRONTIER_LONGRUN_PARENT_AUTHORITY_CHANGED', 'parent authority changed before the slot mutation could be reserved', false, await slotView(slot));
      const next = cloneGrants();
      const target = next.get(grant.grantId)!.slots.find(item => item.slot === operation.slot)!;
      target.lastMutationSeq = operation.mutationSeq;
      target.lastMutationDigest = operationDigest;
      target.lastOperationId = operation.operationId;
      target.lastAction = operation.action;
      target.lastInputId = operation.inputId;
      if (operation.action === 'LOOP_OFF') {
        target.desiredOff = true;
        target.offApplied = false;
      } else {
        target.desiredOff = false;
        target.offApplied = false;
      }
      try { await commitGrants(next); }
      catch (error) {
        return refused('FRONTIER_LONGRUN_PARENT_EFFECT_REFUSED', `the slot mutation could not be saved; nothing was carried out (${error instanceof Error ? error.message : String(error)})`, false, await slotView(slot));
      }
      slot = target;
    }
    const receiptFailure = priorReceipt ? null : await ensureMutationReceipt(operation, operationDigest, grant);
    if (receiptFailure) return receiptFailure;
    if (operation.action === 'LONGRUN_PROMPT') return promptEffect(operation, slot, replay, hooks);
    return stopEffect(slot, grant.grantId, replay, hooks);
  });
}

/** Test seam only. Durable files are intentionally untouched. */
export function resetFrontierLongrunParentForTests(): void {
  stopInputListener?.(); stopSessionListener?.();
  stopInputListener = null; stopSessionListener = null;
  grants.clear(); receipts.clear();
  restored = false; stateHealthy = true; receiptStateHealthy = true;
  chain = Promise.resolve(); reconcileScheduled = false;
}

export const frontierLongrunParentStateNamesForTests = { state: STATE, receipts: RECEIPTS_STATE } as const;
