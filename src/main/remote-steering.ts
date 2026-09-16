/**
 * The verifier/broker half of Nexora remote steering.
 *
 * WHAT THIS IS. Command Center, attended on this PC, mints a signed
 * V1 or V2 remote-steering operation envelope. The operator hands that envelope to an
 * unattributed mobile/ChatGPT turn, which relays it verbatim into the `remote_steering` MCP
 * tool. This module decides whether the document is authentic, what exactly it authorizes,
 * whether it has already been carried out, and carries the closed action through the existing
 * multi-agent broker. V1 remains MESSAGE/STATUS; V2 adds only one-worker SPAWN.
 *
 * WHAT THIS IS NOT. It is not a caller identity and it does not create one. The ordinary
 * `agents` surface keeps requiring the exact caller conversation; an identity-lost ordinary
 * call keeps refusing with `WORKER_IDENTITY_LOST` / `CALLER_IDENTITY_REQUIRED`; the browser
 * Origin check and the MCP path tokens are untouched. A signature proves that the operator,
 * at the PC, already authorized exactly this act against exactly this run. It never lets the
 * verifier guess an active prime, and it never widens what `agents` will do for an
 * unidentified caller. The relaying turn is handed no credential, learns nothing about any
 * other run, and gets no agent identity of its own — its call stays Unattributed.
 *
 * THE FOUR THINGS THAT MAKE IT SAFE.
 *
 *  1. **Off unless the operator turned it on and pinned one key.** `remoteSteering.enabled`
 *     is false on every fresh install and every migration, and the pin is a separate
 *     attended act. Pinning a *different* key over an existing pin is refused outright: a
 *     second key is a second authority, and silently adopting one is how a bridge that was
 *     meant to be bound to one PC starts accepting somebody else's signatures.
 *  2. **Asymmetric, one-shot, narrowing.** No secret reaches this side. A leaked envelope
 *     authorizes exactly the one bounded act it already names, once, inside its own short
 *     window, and only for a run and worker the lease already named.
 *  3. **Durable idempotent receipts.** An authenticated in-window operation is decided
 *     exactly once. Relaying the same envelope again returns the same minimized result and
 *     delivers nothing a second time; relaying an altered one is refused without looking at
 *     what changed. A crash between claiming a `MESSAGE` and completing it leaves a receipt
 *     that refuses rather than one that might deliver twice.
 *  4. **Reuse, not a second broker.** `MESSAGE` goes through the same `stageMessages()` →
 *     `persistCriticalSwarmNow()` → commit → `requestWorkerRevivals()` transaction the prime
 *     itself uses, with the same slot reservation, the same at-least-once inbox, the same
 *     revival/wake custody and the same context-ceiling remeasurement. There is no second
 *     delivery path. V2 `SPAWN` likewise uses the broker's staged spawn → durable barrier →
 *     commit → browser-bootstrap transaction, with an exact signed future worker-id fence.
 *     Nothing here can finish, change a model/reasoning setting, run a shell command or reach
 *     a provider.
 *
 * NO LISTENER. This module owns no socket, no daemon, no watcher and no poller. It is
 * reached only when the existing Core MCP surface dispatches a `remote_steering` tool call.
 *
 * The wire protocol itself is frozen by Command Center and mirrored in
 * `remote-steering-contract.ts`; nothing here may reinterpret a field it defines.
 */

import { randomUUID } from 'node:crypto';
import type { AgentState } from '../shared/session.js';
import type { RemoteSteeringPinView } from '../shared/types.js';
import {
  AgentError,
  activeRunIds,
  persistCriticalSwarmNow,
  primeConversation,
  requestWorkerBootstraps,
  requestWorkerRevivals,
  stageExpectedSpawn,
  stageMessages,
  swarmState,
  type Caller
} from './agents.js';
import { getConfig } from './config.js';
import { readDurable, writeDurableNow, writeDurableSoon } from './durable.js';
import { logInfo, logWarn } from './logger.js';
import {
  REMOTE_STEERING_ENVELOPE_CONTRACT,
  REMOTE_STEERING_VERIFIER_CONTRACT_VERSION,
  REMOTE_STEERING_VERIFIER_ID,
  canonicalLeaseBytes,
  canonicalOperationBytes,
  isRemoteSteeringDigest,
  isRemoteSteeringId,
  isRemoteSteeringPublicKey,
  isRemoteSteeringTimestamp,
  remoteSteeringFingerprint,
  remoteSteeringOperationDigest,
  remoteSteeringOperationLeaseMismatch,
  remoteSteeringWindowLive,
  validateRemoteSteeringEnvelope,
  validateRemoteSteeringSignedLease,
  validateRemoteSteeringSignedOperation,
  verifyRemoteSteeringSignature,
  type RemoteSteeringAction,
  type RemoteSteeringLeaseV1,
  type RemoteSteeringOperationEnvelopeV1,
  type RemoteSteeringOperationV1
} from './remote-steering-contract.js';
import {
  REMOTE_STEERING_ENVELOPE_CONTRACT_V2,
  REMOTE_STEERING_VERIFIER_CONTRACT_VERSION_V2,
  canonicalLeaseBytesV2,
  canonicalOperationBytesV2,
  remoteSteeringOperationDigestV2,
  remoteSteeringOperationLeaseMismatchV2,
  validateRemoteSteeringEnvelopeV2,
  validateRemoteSteeringSignedLeaseV2,
  validateRemoteSteeringSignedOperationV2,
  type RemoteSteeringActionV2,
  type RemoteSteeringLeaseV2,
  type RemoteSteeringOperationEnvelopeV2,
  type RemoteSteeringOperationV2
} from './remote-steering-contract-v2.js';
import {
  REMOTE_STEERING_ENVELOPE_CONTRACT_V3,
  REMOTE_STEERING_VERIFIER_CONTRACT_VERSION_V3,
  canonicalLeaseBytesV3,
  canonicalOperationBytesV3,
  remoteSteeringOperationDigestV3,
  remoteSteeringOperationLeaseMismatchV3,
  validateRemoteSteeringEnvelopeV3,
  validateRemoteSteeringSignedLeaseV3,
  validateRemoteSteeringSignedOperationV3,
  type RemoteSteeringActionV3,
  type RemoteSteeringLeaseV3,
  type RemoteSteeringOperationEnvelopeV3,
  type RemoteSteeringOperationV3
} from './remote-steering-contract-v3.js';
import {
  FRONTIER_LONGRUN_PARENT_ENVELOPE_CONTRACT,
  FRONTIER_LONGRUN_PARENT_VERIFIER_CONTRACT_VERSION,
  canonicalFrontierLongrunParentGrantBytes,
  canonicalFrontierLongrunParentOperationBytes,
  frontierLongrunParentGrantDigest,
  frontierLongrunParentOperationDigest,
  frontierLongrunParentOperationGrantMismatch,
  validateFrontierLongrunParentEnvelope,
  validateFrontierLongrunParentSignedGrant,
  validateFrontierLongrunParentSignedOperation,
  type FrontierLongrunParentAction,
  type FrontierLongrunParentGrantV1,
  type FrontierLongrunParentOperationEnvelopeV1,
  type FrontierLongrunParentOperationV1,
} from './frontier-longrun-parent-contract.js';
import {
  frontierLongrunParentReplayState,
  resetFrontierLongrunParentForTests,
  restoreFrontierLongrunParent,
  steerFrontierLongrunParent,
  type FrontierLongrunParentRefusal,
  type FrontierLongrunParentSlotView,
} from './frontier-longrun-parent.js';
import { recordAgentMessage } from './session/recorder.js';
import { getSession } from './session/store.js';
import { enqueueInput } from './session/input.js';
import { disableLongrunSessionLoop, longrunSessionView } from './session/longrun-control.js';

// ---------------------------------------------------------------------------
// Bounds.
// ---------------------------------------------------------------------------

/**
 * Largest envelope text this verifier will even try to parse.
 *
 * A well-formed envelope is two payloads, two 64-byte signatures and at most 4000 bytes of
 * message text. Everything past this ceiling is somebody sending something else.
 */
export const REMOTE_STEERING_MAX_ENVELOPE_CHARS = 32_000;

/**
 * How long a decided receipt is kept past its own operation's expiry.
 *
 * Replay protection only has to outlive the window in which a replay could still be
 * in-window — which is zero, since an expired operation is refused anyway. The extra day
 * exists so that an honest late relay of an envelope this app already carried out is
 * answered with *what actually happened* rather than a generic "expired", which is the
 * difference between an operator knowing their message landed and guessing.
 */
const RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Ceiling on stored receipts.
 *
 * Only ever reached by a corrupt or hostile state file: operations live five minutes and
 * are pruned a day after that. Reaching it refuses the new claim rather than evicting an
 * older one, because evicting a receipt is exactly how a delivered message becomes
 * deliverable again.
 */
const MAX_RECEIPTS = 512;
/**
 * Process-local revocation generation.
 *
 * A verified MESSAGE crosses async durability/context boundaries before it can publish a
 * broker mutation. Any attended pin/unpin or settings authority change advances this number,
 * so an in-flight call cannot coast on authority the operator revoked while it was awaiting.
 */
let authorityEpoch = 0;

/** Called by the settings owner whenever the remote-steering enable bit changes. */
export function noteRemoteSteeringAuthorityConfigChanged(): void {
  authorityEpoch += 1;
}

const PIN_STATE = 'remote-steering-pin';
const RECEIPTS_STATE = 'remote-steering-receipts';
const STATE_VERSION = 1;

// ---------------------------------------------------------------------------
// The closed refusal vocabulary.
// ---------------------------------------------------------------------------

/**
 * Every way this verifier can decline, and nothing else.
 *
 * The first block is verifier state or an inauthentic document: nothing was authorized, so
 * nothing is recorded and the operator may fix the cause and relay the same envelope again.
 * The second block is an authentic, in-window, lease-authorized operation that this app then
 * could not carry out — those are recorded, because a one-shot authorization that was
 * genuinely attempted is spent.
 */
export type RemoteSteeringRefusal =
  // --- not authorized; never recorded ---
  | 'REMOTE_STEERING_DISABLED'
  | 'REMOTE_STEERING_MULTI_AGENT_DISABLED'
  | 'REMOTE_STEERING_KEY_NOT_PINNED'
  | 'REMOTE_STEERING_KEY_MISMATCH'
  | 'REMOTE_STEERING_ENVELOPE_UNREADABLE'
  | 'REMOTE_STEERING_ENVELOPE_MALFORMED'
  | 'REMOTE_STEERING_LEASE_MALFORMED'
  | 'REMOTE_STEERING_LEASE_SIGNATURE_INVALID'
  | 'REMOTE_STEERING_OPERATION_SIGNATURE_INVALID'
  | 'REMOTE_STEERING_ACTION_NOT_LEASED'
  | 'REMOTE_STEERING_WORKER_NOT_ALLOWLISTED'
  | 'REMOTE_STEERING_OPERATION_WINDOW_EXCEEDS_LEASE'
  | 'REMOTE_STEERING_LEASE_NOT_LIVE'
  | 'REMOTE_STEERING_OPERATION_NOT_LIVE'
  | 'REMOTE_STEERING_OPERATION_REPLAY_ALTERED'
  | 'REMOTE_STEERING_OPERATION_INDETERMINATE'
  | 'FRONTIER_LONGRUN_PARENT_GRANT_MALFORMED'
  | 'FRONTIER_LONGRUN_PARENT_GRANT_SIGNATURE_INVALID'
  | 'FRONTIER_LONGRUN_PARENT_OPERATION_SIGNATURE_INVALID'
  | 'FRONTIER_LONGRUN_PARENT_OPERATION_WINDOW_EXCEEDS_GRANT'
  | 'FRONTIER_LONGRUN_PARENT_GRANT_NOT_LIVE'
  | 'FRONTIER_LONGRUN_PARENT_OPERATION_NOT_LIVE'
  // --- authorized and attempted; recorded once ---
  | 'REMOTE_STEERING_RUN_NOT_FOUND'
  | 'REMOTE_STEERING_SESSION_NOT_FOUND'
  | 'REMOTE_STEERING_SESSION_NOT_READY'
  | 'REMOTE_STEERING_ASTRA_REQUIRED'
  | 'REMOTE_STEERING_FINISH_HOLD_REQUIRED'
  | 'REMOTE_STEERING_LONGRUN_REFUSED'
  | 'REMOTE_STEERING_LOOP_CONTROL_REFUSED'
  | 'REMOTE_STEERING_WORKER_NOT_IN_RUN'
  | 'REMOTE_STEERING_DELIVERY_REFUSED'
  | 'REMOTE_STEERING_SPAWN_REFUSED'
  | 'REMOTE_STEERING_RECEIPT_WRITE_FAILED'
  | 'REMOTE_STEERING_RECEIPT_STORE_FULL'
  | FrontierLongrunParentRefusal;

// ---------------------------------------------------------------------------
// The minimized result.
// ---------------------------------------------------------------------------

/** One worker of the signed run, as ids, states and counts — never as free text. */
export interface RemoteSteeringAgentView {
  readonly id: string;
  readonly role: 'prime' | 'worker';
  readonly state: AgentState;
  readonly revivable: boolean;
  readonly waiting: number;
}

/**
 * `STATUS`'s whole answer.
 *
 * Deliberately content-blind. The reply travels back out through the same unattributed
 * relay the envelope came in on, so it carries what an operator needs to choose a recipient
 * — who exists, what state they are in, whether a wake would fit — and no label, task,
 * result text, conversation id or model.
 */
export interface RemoteSteeringRunView {
  readonly runId: string;
  readonly agents: readonly RemoteSteeringAgentView[];
}

/** `MESSAGE`'s whole answer. The text is identified by digest and length, never repeated. */
export interface RemoteSteeringDeliveryView {
  readonly targetWorkerId: string;
  readonly messageId: string;
  readonly messageSha256: string;
  readonly messageLength: number;
  /** True when the recipient was asleep and this message reserved a slot to wake it. */
  readonly waking: boolean;
}

/** `SPAWN`'s content-blind answer. The task is identified, never repeated. */
export interface RemoteSteeringSpawnView {
  readonly workerId: string;
  readonly state: AgentState;
  readonly taskSha256: string;
  readonly taskLength: number;
}

/** V3 session projection. No title, transcript, conversation id, objective text or model id leaves CoS. */
export interface RemoteSteeringSessionView {
  readonly sessionId: string;
  readonly found: boolean;
  readonly activeTurn: boolean;
  readonly blocked: boolean;
  readonly superseded: boolean;
  readonly modelClass: 'astra' | 'other' | 'unknown';
  readonly loopEnabled: boolean;
  readonly loopMode: 'goal' | 'loop';
  readonly objectivePresent: boolean;
  readonly finishToolEnabled: boolean;
  readonly pendingUserInput: boolean;
  readonly pendingLongrunStart: boolean;
}

/** LONGRUN_START's content-blind queue receipt. */
export interface RemoteSteeringLongrunView {
  readonly inputId: string;
  readonly longrunSha256: string;
  readonly longrunLength: number;
  readonly automation: 'loop';
}

type RemoteSteeringActionAny = RemoteSteeringAction | RemoteSteeringActionV2 | RemoteSteeringActionV3 | FrontierLongrunParentAction;
type RemoteSteeringLeaseAny = RemoteSteeringLeaseV1 | RemoteSteeringLeaseV2 | RemoteSteeringLeaseV3;
type RemoteSteeringOperationAny = RemoteSteeringOperationV1 | RemoteSteeringOperationV2 | RemoteSteeringOperationV3;
type RemoteSteeringEnvelopeAny = RemoteSteeringOperationEnvelopeV1 | RemoteSteeringOperationEnvelopeV2 | RemoteSteeringOperationEnvelopeV3;

export interface RemoteSteeringOutcome {
  readonly verifierId: typeof REMOTE_STEERING_VERIFIER_ID;
  readonly verifierContractVersion:
    | typeof REMOTE_STEERING_VERIFIER_CONTRACT_VERSION
    | typeof REMOTE_STEERING_VERIFIER_CONTRACT_VERSION_V2
    | typeof REMOTE_STEERING_VERIFIER_CONTRACT_VERSION_V3;
  readonly status: 'accepted' | 'refused';
  readonly reason: RemoteSteeringRefusal | null;
  /** Bounded broker/verifier explanation. Never carries the message text. */
  readonly detail: string | null;
  /** Null only when the document never parsed far enough to name an operation. */
  readonly operationId: string | null;
  readonly operationDigest: string | null;
  readonly action: RemoteSteeringActionAny | null;
  readonly runId: string | null;
  readonly sessionId: string | null;
  /** True when this exact operation had already been decided and nothing was repeated. */
  readonly replay: boolean;
  readonly decidedAt: string;
  readonly delivered: RemoteSteeringDeliveryView | null;
  readonly spawned: RemoteSteeringSpawnView | null;
  readonly run: RemoteSteeringRunView | null;
  readonly session: RemoteSteeringSessionView | null;
  readonly longrun: RemoteSteeringLongrunView | null;
  /** Parent-slot projection. Contains no session id, conversation id, prompt text or input id. */
  readonly frontier: FrontierLongrunParentSlotView | null;
}

/** What the ordinary `agents message` path owes a wake, supplied by its owner in tools-core. */
export interface RemoteSteeringBrokerHooks {
  /**
   * Re-reads the signed target sleeping worker's real recorded context and makes any
   * resulting revocation durable before a wake may be authorized. Remote Steering is a
   * one-worker grant; measuring another worker would itself be a broker mutation outside
   * the lease even if that mutation were safety-derived.
   *
   * Injected rather than reimplemented: `tools-core.ts::measureSleepingWorkers()` is the one
   * owner of that check for `agents action=message`, and remote steering must not be able to
   * wake a worker under a weaker ceiling than the prime itself faces. Passing it in also
   * keeps the whole verify → authorize → claim → deliver ordering inside one function here,
   * instead of asking every caller to get that sequence right.
   */
  readonly measureSleepingWorkers: (caller: Caller, targetWorkerId: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// The pinned key — attended, single, conflict-refusing.
// ---------------------------------------------------------------------------

interface PersistedPin {
  version: number;
  publicKeySpkiBase64: string;
  fingerprint: string;
  pinnedAt: string;
}

let pin: PersistedPin | null = null;

interface PersistedReceipts {
  version: number;
  entries: RemoteSteeringReceipt[];
}

/**
 * One operation id's durable decision.
 *
 * `claimed` exists for exactly one reason: a `MESSAGE` has a real side effect, so the claim
 * has to be on disk *before* the broker is asked for anything. A process that dies in that
 * window leaves a receipt that cannot prove whether the message was delivered, and the only
 * honest answer to a replay of it is a refusal. `STATUS` has no side effect and is therefore
 * claimed and decided in one write, so it has no indeterminate window at all.
 */
interface RemoteSteeringReceipt {
  operationId: string;
  operationDigest: string;
  phase: 'claimed' | 'decided';
  /** The operation's own expiry, which is what drives pruning. */
  expiresAt: string;
  outcome: RemoteSteeringOutcome | null;
}

const receipts = new Map<string, RemoteSteeringReceipt>();
let restored = false;

// ---------------------------------------------------------------------------
// Restore.
// ---------------------------------------------------------------------------

/**
 * Loads the pin and the receipts before the MCP endpoint can accept a call.
 *
 * Both have to be in memory before the first `remote_steering` dispatch, for opposite
 * reasons: without the pin an authentic envelope is refused, and without the receipts a
 * `MESSAGE` this app already delivered before the restart would be delivered again.
 */
export async function restoreRemoteSteering(): Promise<void> {
  if (restored) return;
  restored = true;

  const savedPin = await readDurable<PersistedPin>(PIN_STATE);
  if (
    savedPin &&
    savedPin.version === STATE_VERSION &&
    isRemoteSteeringPublicKey(savedPin.publicKeySpkiBase64) &&
    isRemoteSteeringDigest(savedPin.fingerprint) &&
    savedPin.fingerprint === remoteSteeringFingerprint(savedPin.publicKeySpkiBase64) &&
    isRemoteSteeringTimestamp(savedPin.pinnedAt)
  ) {
    pin = {
      version: STATE_VERSION,
      publicKeySpkiBase64: savedPin.publicKeySpkiBase64,
      fingerprint: savedPin.fingerprint,
      pinnedAt: savedPin.pinnedAt
    };
  } else if (savedPin) {
    // Withheld rather than repaired. A pin file that does not say what it claims to say is
    // not a key this app may verify against, and quietly deriving a fingerprint from
    // whatever bytes survived would be exactly the silent authority swap the pin prevents.
    logWarn('remote steering: the stored key pin was unreadable and has been ignored; re-pin it in Settings');
  }

  const savedReceipts = await readDurable<PersistedReceipts>(RECEIPTS_STATE);
  if (savedReceipts && savedReceipts.version === STATE_VERSION && Array.isArray(savedReceipts.entries)) {
    for (const entry of savedReceipts.entries.slice(0, MAX_RECEIPTS)) {
      if (!entry || typeof entry !== 'object') continue;
      if (!isRemoteSteeringId(entry.operationId) || !isRemoteSteeringDigest(entry.operationDigest)) continue;
      if (entry.phase !== 'claimed' && entry.phase !== 'decided') continue;
      if (!isRemoteSteeringTimestamp(entry.expiresAt)) continue;
      receipts.set(entry.operationId, {
        operationId: entry.operationId,
        operationDigest: entry.operationDigest,
        phase: entry.phase,
        expiresAt: entry.expiresAt,
        outcome: entry.phase === 'decided' ? (entry.outcome ?? null) : null
      });
    }
  }
  pruneReceipts(Date.now());
  await restoreFrontierLongrunParent();
}

function receiptSnapshot(): PersistedReceipts {
  return { version: STATE_VERSION, entries: [...receipts.values()] };
}

/** Drops receipts whose operation expired long enough ago that no replay can be in-window. */
function pruneReceipts(nowMs: number): void {
  let dropped = false;
  for (const [id, entry] of receipts) {
    if (Date.parse(entry.expiresAt) + RECEIPT_RETENTION_MS > nowMs) continue;
    receipts.delete(id);
    dropped = true;
  }
  if (dropped) writeDurableSoon(RECEIPTS_STATE, receiptSnapshot());
}

// ---------------------------------------------------------------------------
// Attended pin / unpin.
// ---------------------------------------------------------------------------

export function remoteSteeringPin(): RemoteSteeringPinView {
  return {
    pinned: pin !== null,
    fingerprint: pin?.fingerprint ?? null,
    publicKeySpkiBase64: pin?.publicKeySpkiBase64 ?? null,
    pinnedAt: pin?.pinnedAt ?? null
  };
}

/**
 * What pinning this pasted key *would* mean, without pinning it.
 *
 * The preview half of preview-then-confirm: the operator compares the fingerprint shown
 * here against the one Command Center shows them, and only then presses the button that
 * changes anything. Nothing is stored, so a mistyped paste costs a glance.
 */
export function previewRemoteSteeringPin(publicKeySpkiBase64: unknown): {
  fingerprint: string;
  matchesExistingPin: boolean;
} {
  if (!isRemoteSteeringPublicKey(publicKeySpkiBase64)) {
    throw new Error('That is not a base64 Ed25519 SPKI public key. Copy the key exactly as Command Center shows it.');
  }
  const fingerprint = remoteSteeringFingerprint(publicKeySpkiBase64);
  return { fingerprint, matchesExistingPin: pin?.fingerprint === fingerprint };
}

/**
 * Pins one Ed25519 public key, attended.
 *
 * Re-pinning the identical key is idempotent and costs nothing. Pinning a *different* one is
 * REFUSED while a pin exists — not merged, not replaced, not "the newest wins". A second key
 * is a second authority over this machine's workers, and adopting one silently is precisely
 * how a bridge bound to one attended PC starts honouring somebody else's signatures. The
 * operator unpins deliberately first, which is a decision with its own button and its own
 * consequence: every envelope already minted under the old key stops verifying.
 */
export async function pinRemoteSteeringKey(publicKeySpkiBase64: unknown): Promise<RemoteSteeringPinView> {
  if (!isRemoteSteeringPublicKey(publicKeySpkiBase64)) {
    throw new Error('That is not a base64 Ed25519 SPKI public key. Copy the key exactly as Command Center shows it.');
  }
  const fingerprint = remoteSteeringFingerprint(publicKeySpkiBase64);
  if (pin && pin.fingerprint !== fingerprint) {
    throw new Error(
      `A different remote-steering key is already pinned (${pin.fingerprint.slice(0, 16)}…). ` +
        'Unpin it first if you really mean to trust another Command Center key; ' +
        'every envelope minted under the current key stops verifying when you do.'
    );
  }
  if (pin) return remoteSteeringPin();

  const next: PersistedPin = {
    version: STATE_VERSION,
    publicKeySpkiBase64,
    fingerprint,
    pinnedAt: new Date().toISOString()
  };
  // Durable before it is live: a pin the operator was told had landed must survive the
  // restart they are about to do, and a failed write must leave nothing verifying.
  await writeDurableNow(PIN_STATE, next);
  pin = next;
  authorityEpoch += 1;
  logInfo(`remote steering: pinned signing key ${fingerprint}`);
  return remoteSteeringPin();
}

/**
 * Forgets the pinned key.
 *
 * Receipts are deliberately kept. They are about operations that already happened, and
 * dropping them would make a replayed envelope from the old key deliverable again the moment
 * that key were ever re-pinned.
 */
export async function unpinRemoteSteeringKey(): Promise<RemoteSteeringPinView> {
  if (!pin) return remoteSteeringPin();
  const previous = pin.fingerprint;
  // Revoke in-flight work at click time, not after the storage await. If that write fails the
  // old pin remains installed, but aborting an in-flight operation is the safe failure mode.
  authorityEpoch += 1;
  await writeDurableNow(PIN_STATE, null);
  pin = null;
  logInfo(`remote steering: unpinned signing key ${previous}; no envelope verifies until a key is pinned again`);
  return remoteSteeringPin();
}

// ---------------------------------------------------------------------------
// Verification.
// ---------------------------------------------------------------------------

function isV2Operation(operation: RemoteSteeringOperationAny): operation is RemoteSteeringOperationV2 {
  return operation.contract === 'cc_remote_steering_operation_v2';
}

function isV2Lease(lease: RemoteSteeringLeaseAny): lease is RemoteSteeringLeaseV2 {
  return lease.contract === 'cc_remote_steering_lease_v2';
}

function isV3Operation(operation: RemoteSteeringOperationAny): operation is RemoteSteeringOperationV3 {
  return operation.contract === 'cc_remote_steering_operation_v3';
}

function isV3Lease(lease: RemoteSteeringLeaseAny): lease is RemoteSteeringLeaseV3 {
  return lease.contract === 'cc_remote_steering_lease_v3';
}

function operationDigestAny(operation: RemoteSteeringOperationAny): string {
  return isV3Operation(operation)
    ? remoteSteeringOperationDigestV3(operation)
    : isV2Operation(operation)
    ? remoteSteeringOperationDigestV2(operation)
    : remoteSteeringOperationDigest(operation);
}

function canonicalLeaseBytesAny(lease: RemoteSteeringLeaseAny): Buffer {
  return isV3Lease(lease) ? canonicalLeaseBytesV3(lease) : isV2Lease(lease) ? canonicalLeaseBytesV2(lease) : canonicalLeaseBytes(lease);
}

function canonicalOperationBytesAny(operation: RemoteSteeringOperationAny): Buffer {
  return isV3Operation(operation) ? canonicalOperationBytesV3(operation) : isV2Operation(operation) ? canonicalOperationBytesV2(operation) : canonicalOperationBytes(operation);
}

function runIdOf(operation: RemoteSteeringOperationAny): string | null {
  return isV3Operation(operation) ? null : operation.runId;
}

function sessionIdOf(operation: RemoteSteeringOperationAny): string | null {
  return isV3Operation(operation) ? operation.sessionId : null;
}

function outcome(partial: Partial<RemoteSteeringOutcome> & { status: 'accepted' | 'refused' }): RemoteSteeringOutcome {
  return {
    verifierId: REMOTE_STEERING_VERIFIER_ID,
    verifierContractVersion: REMOTE_STEERING_VERIFIER_CONTRACT_VERSION,
    reason: null,
    detail: null,
    operationId: null,
    operationDigest: null,
    action: null,
    runId: null,
    sessionId: null,
    replay: false,
    decidedAt: new Date().toISOString(),
    delivered: null,
    spawned: null,
    run: null,
    session: null,
    longrun: null,
    frontier: null,
    ...partial
  };
}

function refuse(
  reason: RemoteSteeringRefusal,
  detail: string | null,
  operation?: RemoteSteeringOperationAny
): RemoteSteeringOutcome {
  return outcome({
    status: 'refused',
    verifierContractVersion: operation?.verifierContractVersion ?? REMOTE_STEERING_VERIFIER_CONTRACT_VERSION,
    reason,
    detail,
    operationId: operation?.operationId ?? null,
    operationDigest: operation ? operationDigestAny(operation) : null,
    action: operation?.action ?? null,
    runId: operation ? runIdOf(operation) : null,
    sessionId: operation ? sessionIdOf(operation) : null
  });
}

function refuseParent(
  reason: RemoteSteeringRefusal,
  detail: string | null,
  operation?: FrontierLongrunParentOperationV1
): RemoteSteeringOutcome {
  return outcome({
    status: 'refused',
    verifierContractVersion: FRONTIER_LONGRUN_PARENT_VERIFIER_CONTRACT_VERSION,
    reason,
    detail,
    operationId: operation?.operationId ?? null,
    operationDigest: operation ? frontierLongrunParentOperationDigest(operation) : null,
    action: operation?.action ?? null,
    runId: null,
    sessionId: null
  });
}

/**
 * Turns an unreadable envelope into the most specific refusal the contract allows.
 *
 * `validateRemoteSteeringEnvelope` is the authority and is still what admits the document —
 * it is re-run over the untouched parsed value at the end, so this narrowing can only ever
 * produce a better error message, never a wider admission. Running the halves separately
 * first is what lets an operator be told "that action is not in your lease" instead of
 * "malformed", which for a document they cannot edit is the whole difference between fixing
 * it and being stuck.
 */
function diagnose(
  parsed: unknown
): { envelope: RemoteSteeringEnvelopeAny } | { reason: RemoteSteeringRefusal; detail: string | null } {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { reason: 'REMOTE_STEERING_ENVELOPE_MALFORMED', detail: 'the envelope is not a JSON object' };
  }
  const record = parsed as Record<string, unknown>;
  const contract = record['contract'];
  const v3 = contract === REMOTE_STEERING_ENVELOPE_CONTRACT_V3;
  const v2 = contract === REMOTE_STEERING_ENVELOPE_CONTRACT_V2;
  if (contract !== REMOTE_STEERING_ENVELOPE_CONTRACT && !v2 && !v3) {
    return { reason: 'REMOTE_STEERING_ENVELOPE_MALFORMED', detail: 'the envelope contract/version is not supported' };
  }
  const lease = v3
    ? validateRemoteSteeringSignedLeaseV3(record['lease'])
    : v2
      ? validateRemoteSteeringSignedLeaseV2(record['lease'])
      : validateRemoteSteeringSignedLease(record['lease']);
  if (lease === null) {
    return { reason: 'REMOTE_STEERING_LEASE_MALFORMED', detail: 'the signed lease failed closed-schema validation' };
  }
  const operation = v3
    ? validateRemoteSteeringSignedOperationV3(record['operation'])
    : v2
      ? validateRemoteSteeringSignedOperationV2(record['operation'])
      : validateRemoteSteeringSignedOperation(record['operation']);
  if (operation === null) {
    return {
      reason: 'REMOTE_STEERING_ENVELOPE_MALFORMED',
      detail: 'the signed operation failed closed-schema validation'
    };
  }
  const mismatch = v3
    ? remoteSteeringOperationLeaseMismatchV3(
        operation.payload as RemoteSteeringOperationV3,
        lease.payload as RemoteSteeringLeaseV3
      )
    : v2
      ? remoteSteeringOperationLeaseMismatchV2(
        operation.payload as RemoteSteeringOperationV2,
        lease.payload as RemoteSteeringLeaseV2
      )
      : remoteSteeringOperationLeaseMismatch(
        operation.payload as RemoteSteeringOperationV1,
        lease.payload as RemoteSteeringLeaseV1
      );
  if (mismatch !== null) return { reason: mismatch, detail: 'the operation is not authorized by its own lease' };

  const envelope = v3 ? validateRemoteSteeringEnvelopeV3(parsed) : v2 ? validateRemoteSteeringEnvelopeV2(parsed) : validateRemoteSteeringEnvelope(parsed);
  if (envelope === null) {
    return {
      reason: 'REMOTE_STEERING_ENVELOPE_MALFORMED',
      detail: 'the envelope wrapper failed closed-schema validation'
    };
  }
  return { envelope };
}

interface VerifiedEnvelope {
  readonly envelope: RemoteSteeringEnvelopeAny;
  readonly lease: RemoteSteeringLeaseAny;
  readonly operation: RemoteSteeringOperationAny;
  readonly operationDigest: string;
  readonly authorityEpoch: number;
}

interface VerifiedParentEnvelope {
  readonly envelope: FrontierLongrunParentOperationEnvelopeV1;
  readonly grant: FrontierLongrunParentGrantV1;
  readonly operation: FrontierLongrunParentOperationV1;
  readonly grantDigest: string;
  readonly operationDigest: string;
  readonly authorityEpoch: number;
}

/**
 * Everything that must hold before a single byte of this app's state may be touched.
 *
 * Ordered so that the cheapest and least revealing checks come first: an install with the
 * feature off never parses an envelope at all, and an envelope for a key this app does not
 * pin is refused before either signature is verified.
 */
function verify(envelopeText: string): { verified: VerifiedEnvelope } | { parent: VerifiedParentEnvelope } | { refusal: RemoteSteeringOutcome } {
  if (!getConfig().remoteSteering.enabled) {
    return {
      refusal: refuse(
        'REMOTE_STEERING_DISABLED',
        'Remote steering is switched off in Chat On Steroids. The user enables it in Settings.'
      )
    };
  }
  // V3 exact-session control and the Frontier parent protocol deliberately do not depend on the
  // worker broker. Preserve V1/V2's old refusal ordering when multi-agent is off: only one of
  // those structurally recognizable session-control wrappers may pass this gate.
  let preparsed: unknown = undefined;
  if (!getConfig().multiAgent.enabled) {
    if (envelopeText.length <= REMOTE_STEERING_MAX_ENVELOPE_CHARS) {
      try { preparsed = JSON.parse(envelopeText); } catch { /* preserve the worker-run refusal */ }
    }
    const contract = typeof preparsed === 'object' && preparsed !== null && !Array.isArray(preparsed)
      ? (preparsed as Record<string, unknown>)['contract'] : null;
    const sessionControl = contract === REMOTE_STEERING_ENVELOPE_CONTRACT_V3 || contract === FRONTIER_LONGRUN_PARENT_ENVELOPE_CONTRACT;
    if (!sessionControl) {
      return {
        refusal: refuse(
          'REMOTE_STEERING_MULTI_AGENT_DISABLED',
          'Multi-agent mode is switched off, so there is no worker run to steer.'
        )
      };
    }
  }
  const pinned = pin;
  if (!pinned) {
    return {
      refusal: refuse(
        'REMOTE_STEERING_KEY_NOT_PINNED',
        'No Command Center signing key is pinned. The user pins one in Settings, attended, before any envelope verifies.'
      )
    };
  }
  if (envelopeText.length > REMOTE_STEERING_MAX_ENVELOPE_CHARS) {
    return { refusal: refuse('REMOTE_STEERING_ENVELOPE_UNREADABLE', 'the envelope exceeds the accepted size') };
  }

  let parsed: unknown = preparsed;
  if (parsed === undefined) {
    try {
      parsed = JSON.parse(envelopeText);
    } catch {
      return { refusal: refuse('REMOTE_STEERING_ENVELOPE_UNREADABLE', 'the envelope is not valid JSON') };
    }
  }

  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>)['contract'] === FRONTIER_LONGRUN_PARENT_ENVELOPE_CONTRACT) {
    const record = parsed as Record<string, unknown>;
    const signedGrant = validateFrontierLongrunParentSignedGrant(record['grant']);
    if (!signedGrant) {
      return { refusal: refuseParent('FRONTIER_LONGRUN_PARENT_GRANT_MALFORMED', 'the signed parent grant failed closed-schema validation') };
    }
    const signedOperation = validateFrontierLongrunParentSignedOperation(record['operation']);
    if (!signedOperation) {
      return { refusal: refuseParent('REMOTE_STEERING_ENVELOPE_MALFORMED', 'the signed parent operation failed closed-schema validation') };
    }
    const mismatch = frontierLongrunParentOperationGrantMismatch(signedOperation.payload, signedGrant.payload);
    if (mismatch) {
      return { refusal: refuseParent(mismatch, 'the parent operation is not authorized by its own grant', signedOperation.payload) };
    }
    const envelope = validateFrontierLongrunParentEnvelope(parsed);
    if (!envelope) {
      return { refusal: refuseParent('REMOTE_STEERING_ENVELOPE_MALFORMED', 'the parent envelope wrapper failed closed-schema validation', signedOperation.payload) };
    }
    if (envelope.signingKeyFingerprint !== pinned.fingerprint) {
      return { refusal: refuseParent('REMOTE_STEERING_KEY_MISMATCH', 'the parent envelope names a signing key this app has not pinned', signedOperation.payload) };
    }
    if (!verifyRemoteSteeringSignature(canonicalFrontierLongrunParentGrantBytes(signedGrant.payload), signedGrant.signature, pinned.publicKeySpkiBase64)) {
      return { refusal: refuseParent('FRONTIER_LONGRUN_PARENT_GRANT_SIGNATURE_INVALID', null, signedOperation.payload) };
    }
    if (!verifyRemoteSteeringSignature(canonicalFrontierLongrunParentOperationBytes(signedOperation.payload), signedOperation.signature, pinned.publicKeySpkiBase64)) {
      return { refusal: refuseParent('FRONTIER_LONGRUN_PARENT_OPERATION_SIGNATURE_INVALID', null, signedOperation.payload) };
    }
    return {
      parent: {
        envelope,
        grant: signedGrant.payload,
        operation: signedOperation.payload,
        grantDigest: frontierLongrunParentGrantDigest(signedGrant.payload),
        operationDigest: frontierLongrunParentOperationDigest(signedOperation.payload),
        authorityEpoch
      }
    };
  }

  const diagnosed = diagnose(parsed);
  if ('reason' in diagnosed) return { refusal: refuse(diagnosed.reason, diagnosed.detail) };
  const { envelope } = diagnosed;
  const lease = envelope.lease.payload;
  const operation = envelope.operation.payload;

  // The pin is the whole trust anchor. Comparing the fingerprint first means an envelope
  // from an unknown key never reaches the signature verifier at all.
  if (envelope.signingKeyFingerprint !== pinned.fingerprint) {
    return {
      refusal: refuse(
        'REMOTE_STEERING_KEY_MISMATCH',
        'the envelope names a signing key this app has not pinned',
        operation
      )
    };
  }
  if (!verifyRemoteSteeringSignature(canonicalLeaseBytesAny(lease), envelope.lease.signature, pinned.publicKeySpkiBase64)) {
    return { refusal: refuse('REMOTE_STEERING_LEASE_SIGNATURE_INVALID', null, operation) };
  }
  if (
    !verifyRemoteSteeringSignature(
      canonicalOperationBytesAny(operation),
      envelope.operation.signature,
      pinned.publicKeySpkiBase64
    )
  ) {
    return { refusal: refuse('REMOTE_STEERING_OPERATION_SIGNATURE_INVALID', null, operation) };
  }

  return {
    verified: {
      envelope,
      lease,
      operation,
      operationDigest: operationDigestAny(operation),
      authorityEpoch
    }
  };
}

/** Present-tense authority for an already-authenticated operation after an async boundary. */
function authorityStillLive(verifiedEpoch: number, signingKeyFingerprint: string, requiresMultiAgent = true): boolean {
  const config = getConfig();
  return (
    authorityEpoch === verifiedEpoch &&
    config.remoteSteering.enabled &&
    (!requiresMultiAgent || config.multiAgent.enabled) &&
    pin?.fingerprint === signingKeyFingerprint
  );
}

// ---------------------------------------------------------------------------
// Receipts.
// ---------------------------------------------------------------------------

/** The already-decided answer for this exact operation, or the reason a replay is refused. */
function replayVerdict(verified: VerifiedEnvelope): RemoteSteeringOutcome | null {
  const existing = receipts.get(verified.operation.operationId);
  if (!existing) return null;
  if (existing.operationDigest !== verified.operationDigest) {
    // Same id, different bytes. There is nothing to compare and nothing to merge: an
    // operation id is claimed exactly once, so a second document wearing it is refused
    // without inspecting what it changed.
    return refuse(
      'REMOTE_STEERING_OPERATION_REPLAY_ALTERED',
      'this operation id was already used for a different signed operation',
      verified.operation
    );
  }
  if (existing.phase === 'claimed' || !existing.outcome) {
    return refuse(
      'REMOTE_STEERING_OPERATION_INDETERMINATE',
      'this operation was claimed but its result never settled, so it cannot be replayed safely. Issue a new operation.',
      verified.operation
    );
  }
  // The stored decision verbatim, including the moment it was made. Only the replay flag is
  // added, because "when this app decided" is part of the answer and inventing a fresh
  // timestamp would make a replay look like a second execution.
  return {
    ...existing.outcome,
    spawned: existing.outcome.spawned ?? null,
    sessionId: existing.outcome.sessionId ?? null,
    session: existing.outcome.session ?? null,
    longrun: existing.outcome.longrun ?? null,
    frontier: existing.outcome.frontier ?? null,
    replay: true
  };
}

/**
 * Puts one receipt in the map and on disk.
 *
 * Returns whether the durable write landed. The two failure directions are deliberately not
 * collapsed, because the caller's obligation differs: before an effect, a failed write means
 * nothing may happen; after one, the decision is already a fact and the caller must say so
 * rather than claim the operation was refused.
 */
async function persistReceipt(
  operation: RemoteSteeringOperationAny,
  digest: string,
  phase: 'claimed' | 'decided',
  decided: RemoteSteeringOutcome | null,
  nowMs: number
): Promise<{ stored: boolean; full: boolean; detail: string | null }> {
  pruneReceipts(nowMs);
  if (!receipts.has(operation.operationId) && receipts.size >= MAX_RECEIPTS) {
    return { stored: false, full: true, detail: `the remote-steering receipt store is full (${MAX_RECEIPTS})` };
  }
  receipts.set(operation.operationId, {
    operationId: operation.operationId,
    operationDigest: digest,
    phase,
    expiresAt: operation.expiresAt,
    outcome: decided
  });
  try {
    await writeDurableNow(RECEIPTS_STATE, receiptSnapshot());
    return { stored: true, full: false, detail: null };
  } catch (error) {
    return { stored: false, full: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Claims the operation id durably, BEFORE anything can happen.
 *
 * A failed claim is a refusal with nothing behind it: the map is put back exactly as it was
 * and a newer safe snapshot is queued, so `durable.ts`'s retry of the failed generation can
 * never resurrect a claim the caller was told had failed.
 */
async function claimReceipt(
  operation: RemoteSteeringOperationAny,
  digest: string,
  nowMs: number
): Promise<RemoteSteeringOutcome | null> {
  const previous = receipts.get(operation.operationId) ?? null;
  // Re-check at the actual claim boundary. Two relays can both pass the earlier replay
  // check and then await context remeasurement before either reaches this function. The
  // first claimant inserts its receipt synchronously inside persistReceipt() before that
  // function awaits disk. Without this guard, the second claimant would overwrite that
  // in-flight claim and both calls could proceed to the broker, violating one-shot MESSAGE
  // semantics. At the claim boundary, an existing operation id is already owned.
  if (previous) {
    if (previous.operationDigest !== digest) {
      return refuse(
        'REMOTE_STEERING_OPERATION_REPLAY_ALTERED',
        'this operation id was already claimed for a different signed operation',
        operation
      );
    }
    if (previous.phase === 'claimed' || !previous.outcome) {
      return refuse(
        'REMOTE_STEERING_OPERATION_INDETERMINATE',
        'this operation is already being carried out or was claimed without a settled result; it cannot be executed again',
        operation
      );
    }
    return {
      ...previous.outcome,
      spawned: previous.outcome.spawned ?? null,
      sessionId: previous.outcome.sessionId ?? null,
      session: previous.outcome.session ?? null,
      longrun: previous.outcome.longrun ?? null,
      frontier: previous.outcome.frontier ?? null,
      replay: true
    };
  }
  const result = await persistReceipt(operation, digest, 'claimed', null, nowMs);
  if (result.stored) return null;
  if (previous) receipts.set(operation.operationId, previous);
  else receipts.delete(operation.operationId);
  writeDurableSoon(RECEIPTS_STATE, receiptSnapshot());
  return result.full
    ? refuse('REMOTE_STEERING_RECEIPT_STORE_FULL', `${result.detail}; nothing was carried out`, operation)
    : refuse(
        'REMOTE_STEERING_RECEIPT_WRITE_FAILED',
        `the operation receipt could not be claimed, so nothing was carried out (${result.detail})`,
        operation
      );
}

/**
 * Records the terminal decision for an operation that has NOT changed anything.
 *
 * The verdict only stands if it is durable: a refusal nobody can prove was made would let
 * the same envelope be attempted again after a restart, which is the opposite of one-shot.
 */
async function settleWithoutEffect(
  operation: RemoteSteeringOperationAny,
  digest: string,
  verdict: RemoteSteeringOutcome,
  nowMs: number
): Promise<RemoteSteeringOutcome> {
  const previous = receipts.get(operation.operationId) ?? null;
  const result = await persistReceipt(operation, digest, 'decided', verdict, nowMs);
  if (result.stored) return verdict;
  if (previous) receipts.set(operation.operationId, previous);
  else receipts.delete(operation.operationId);
  writeDurableSoon(RECEIPTS_STATE, receiptSnapshot());
  return result.full
    ? refuse('REMOTE_STEERING_RECEIPT_STORE_FULL', `${result.detail}; nothing was carried out`, operation)
    : refuse(
        'REMOTE_STEERING_RECEIPT_WRITE_FAILED',
        `the operation receipt could not be recorded, so nothing was carried out (${result.detail})`,
        operation
      );
}

/**
 * Records the terminal decision for an operation whose effect has already landed.
 *
 * The message is delivered; saying otherwise would be a lie the operator would act on. The
 * decided receipt therefore stays in memory — which is what a replay in this process reads —
 * and its write is retried in the background. If the app dies before that retry, the receipt
 * on disk is still the claim, so a replay after the restart refuses as indeterminate rather
 * than delivering a second time.
 */
async function settleAfterEffect(
  operation: RemoteSteeringOperationAny,
  digest: string,
  verdict: RemoteSteeringOutcome,
  nowMs: number
): Promise<RemoteSteeringOutcome> {
  const result = await persistReceipt(operation, digest, 'decided', verdict, nowMs);
  if (result.stored) return verdict;
  writeDurableSoon(RECEIPTS_STATE, receiptSnapshot());
  logWarn(
    `remote steering: operation ${operation.operationId} was carried out but its receipt could not be written (${result.detail})`
  );
  return {
    ...verdict,
    detail: 'the operation was carried out, but its receipt is not yet durable; do not relay this envelope again'
  };
}

// ---------------------------------------------------------------------------
// The bounded state a signed STATUS may read.
// ---------------------------------------------------------------------------

function runView(runId: string, workerAllowlist: readonly string[]): RemoteSteeringRunView {
  return {
    runId,
    agents: swarmState(runId).agents
      .filter((info) => info.role === 'worker' && workerAllowlist.includes(info.id))
      .map((info) => ({
        id: info.id,
        role: info.role,
        state: info.state,
        revivable: info.revivable,
        waiting: info.pending
      }))
  };
}

/** Content-blind exact-session status used only by signed V3 operations. */
async function sessionView(sessionId: string): Promise<RemoteSteeringSessionView> {
  return { sessionId, ...await longrunSessionView(sessionId) };
}

/** V3 uses no worker identity. Its lease names the exact session and every act stays inside it. */
async function steerSessionRemotely(
  operation: RemoteSteeringOperationV3,
  lease: RemoteSteeringLeaseV3,
  operationDigest: string,
  verifiedEpoch: number,
  nowMs: number
): Promise<RemoteSteeringOutcome> {
  const view = await sessionView(operation.sessionId);
  if (!view.found) {
    return settleWithoutEffect(operation, operationDigest,
      refuse('REMOTE_STEERING_SESSION_NOT_FOUND', 'the exact session named by the V3 lease is not recorded on this machine', operation), nowMs);
  }

  if (operation.action === 'SESSION_STATUS') {
    const accepted = outcome({
      status: 'accepted', verifierContractVersion: operation.verifierContractVersion,
      operationId: operation.operationId, operationDigest, action: operation.action,
      sessionId: operation.sessionId, session: view
    });
    return settleWithoutEffect(operation, operationDigest, accepted, nowMs);
  }

  const session = await getSession(operation.sessionId);
  const conversationId = session?.conversationId ?? null;
  if (!session || !conversationId || session.origin?.kind === 'worker' || session.origin?.kind === 'helper' || view.blocked || view.superseded) {
    return settleWithoutEffect(operation, operationDigest,
      refuse('REMOTE_STEERING_SESSION_NOT_READY', 'the exact session is not an ordinary live prime/solo chat eligible for Longrun control', operation), nowMs);
  }

  if (operation.action === 'LOOP_OFF') {
    const claim = await claimReceipt(operation, operationDigest, nowMs);
    if (claim) return claim;
    if (!authorityStillLive(verifiedEpoch, operation.signingKeyFingerprint, false)) {
      return settleWithoutEffect(operation, operationDigest,
        refuse('REMOTE_STEERING_LOOP_CONTROL_REFUSED', 'remote-steering authority changed before Loop could be disabled', operation), nowMs);
    }
    // Safety-first stop through the same exact-session mutation the parent-slot protocol reuses.
    await disableLongrunSessionLoop(operation.sessionId);
    const accepted = outcome({
      status: 'accepted', verifierContractVersion: operation.verifierContractVersion,
      operationId: operation.operationId, operationDigest, action: operation.action,
      sessionId: operation.sessionId, session: await sessionView(operation.sessionId)
    });
    return settleAfterEffect(operation, operationDigest, accepted, nowMs);
  }

  if (!getConfig().sessions.record || view.activeTurn || view.pendingUserInput) {
    return settleWithoutEffect(operation, operationDigest,
      refuse('REMOTE_STEERING_SESSION_NOT_READY', 'Longrun starts only from an idle recorded session with no pending user input', operation), nowMs);
  }
  if (!view.finishToolEnabled) {
    return settleWithoutEffect(operation, operationDigest,
      refuse('REMOTE_STEERING_FINISH_HOLD_REQUIRED', 'Session finish is disabled; Longrun requires the same-turn finish/continuation seam', operation), nowMs);
  }
  if (view.modelClass !== 'astra') {
    return settleWithoutEffect(operation, operationDigest,
      refuse('REMOTE_STEERING_ASTRA_REQUIRED', 'the exact session is not currently recorded as GPT-6 Pro/Astra; V3 never selects a model for the user', operation), nowMs);
  }
  if (operation.longrunText === null || operation.longrunSha256 === null || operation.longrunLength === null ||
      !lease.allowedActions.includes('LONGRUN_START')) {
    return settleWithoutEffect(operation, operationDigest,
      refuse('REMOTE_STEERING_LONGRUN_REFUSED', 'the signed V3 start does not contain one authorized Longrun mission', operation), nowMs);
  }

  const claim = await claimReceipt(operation, operationDigest, nowMs);
  if (claim) return claim;
  if (!authorityStillLive(verifiedEpoch, operation.signingKeyFingerprint, false)) {
    return settleWithoutEffect(operation, operationDigest,
      refuse('REMOTE_STEERING_LONGRUN_REFUSED', 'remote-steering authority changed before the Longrun mission could be queued', operation), nowMs);
  }
  // Recheck the state at the actual mutation boundary. No model is selected or changed here:
  // the session must already be Astra, and the queue inherits that user-selected model.
  const latest = await sessionView(operation.sessionId);
  if (!latest.found || latest.activeTurn || latest.pendingUserInput || latest.blocked || latest.superseded ||
      latest.modelClass !== 'astra' || !latest.finishToolEnabled) {
    return settleWithoutEffect(operation, operationDigest,
      refuse('REMOTE_STEERING_SESSION_NOT_READY', 'the exact session changed before the Longrun queue boundary', operation), nowMs);
  }
  const input = await enqueueInput({
    id: randomUUID(),
    sessionId: operation.sessionId,
    text: operation.longrunText,
    automation: 'loop',
    objective: operation.longrunText,
    mode: 'auto',
    dueAt: Date.now(),
    model: null,
    reasoningEffort: null
  });
  const accepted = outcome({
    status: 'accepted', verifierContractVersion: operation.verifierContractVersion,
    operationId: operation.operationId, operationDigest, action: operation.action,
    sessionId: operation.sessionId,
    longrun: {
      inputId: input.id,
      longrunSha256: operation.longrunSha256,
      longrunLength: operation.longrunLength,
      automation: 'loop'
    },
    session: await sessionView(operation.sessionId)
  });
  logInfo(`remote steering: operation ${operation.operationId} queued one V3 Longrun mission for exact session ${operation.sessionId}`);
  return settleAfterEffect(operation, operationDigest, accepted, nowMs);
}

// ---------------------------------------------------------------------------
// The one entry point.
// ---------------------------------------------------------------------------

/**
 * Verify one relayed envelope and, if it authorizes one, carry out exactly that act.
 *
 * The ordering is the contract and is why this lives in one function:
 *
 *   verify (feature, pin, schema, signatures)
 *     → replay (a decided operation is answered, never repeated, even after expiry)
 *       → live windows (only a never-seen operation needs present-tense authority)
 *       → authorize against the LIVE run (exact run, exact worker)
 *         → remeasure the context ceiling, exactly as `agents message` does
 *           → claim the receipt durably
 *             → the broker transaction
 *               → decide the receipt durably
 *
 * Every refusal before the claim leaves this app unchanged and may be relayed again once the
 * operator has fixed its cause. Every refusal after it is a spent one-shot authorization and
 * is recorded, so relaying it again returns that same answer rather than trying a second time.
 */
export async function steerRemotely(
  envelopeText: string,
  hooks: RemoteSteeringBrokerHooks,
  nowMs: number = Date.now()
): Promise<RemoteSteeringOutcome> {
  const checked = verify(envelopeText);
  if ('refusal' in checked) return checked.refusal;
  if ('parent' in checked) {
    const verified = checked.parent;
    const { grant, operation, grantDigest, operationDigest } = verified;
    const replayState = await frontierLongrunParentReplayState(operation, operationDigest);
    if (replayState === 'altered') {
      return refuseParent(
        'FRONTIER_LONGRUN_PARENT_OPERATION_REPLAY_ALTERED',
        'this parent operation id was already durably assigned to different signed bytes',
        operation
      );
    }
    const grantLive = remoteSteeringWindowLive(grant.issuedAt, grant.expiresAt, nowMs);
    const operationLive = remoteSteeringWindowLive(operation.issuedAt, operation.expiresAt, nowMs);
    if (replayState === 'unseen' && !grantLive) {
      return refuseParent(
        'FRONTIER_LONGRUN_PARENT_GRANT_NOT_LIVE',
        `the parent grant window is ${grant.issuedAt} → ${grant.expiresAt}`,
        operation
      );
    }
    if (replayState === 'unseen' && !operationLive) {
      return refuseParent(
        'FRONTIER_LONGRUN_PARENT_OPERATION_NOT_LIVE',
        `the parent operation window is ${operation.issuedAt} → ${operation.expiresAt}`,
        operation
      );
    }
    const result = await steerFrontierLongrunParent(
      operation,
      grant,
      grantDigest,
      operationDigest,
      {
        authorityStillLive: () => authorityStillLive(verified.authorityEpoch, operation.signingKeyFingerprint, false),
        effectsAllowed: grantLive && operationLive
      },
      nowMs
    );
    return outcome({
      status: result.status,
      verifierContractVersion: FRONTIER_LONGRUN_PARENT_VERIFIER_CONTRACT_VERSION,
      reason: result.reason,
      detail: result.detail,
      operationId: operation.operationId,
      operationDigest,
      action: operation.action,
      runId: null,
      sessionId: null,
      replay: result.replay,
      frontier: result.slot
    });
  }
  const verified = checked.verified;
  const { lease, operation, operationDigest } = verified;

  const replay = replayVerdict(verified);
  if (replay) return replay;

  // Windows are checked only after authenticating the exact signed bytes and consulting the
  // one-shot receipt. That lets a late relay learn the already-durable result without turning
  // expiry into permission to forget that the operation already happened. A never-seen
  // operation still needs both windows live before it can claim or mutate anything.
  if (!remoteSteeringWindowLive(lease.issuedAt, lease.expiresAt, nowMs)) {
    return refuse(
      'REMOTE_STEERING_LEASE_NOT_LIVE',
      `the lease window is ${lease.issuedAt} → ${lease.expiresAt}`,
      operation
    );
  }
  if (!remoteSteeringWindowLive(operation.issuedAt, operation.expiresAt, nowMs)) {
    return refuse(
      'REMOTE_STEERING_OPERATION_NOT_LIVE',
      `the operation window is ${operation.issuedAt} → ${operation.expiresAt}`,
      operation
    );
  }

  if (isV3Operation(operation)) {
    if (!isV3Lease(lease)) {
      return settleWithoutEffect(
        operation,
        operationDigest,
        refuse('REMOTE_STEERING_LEASE_MALFORMED', 'a V3 session operation requires a V3 session lease', operation),
        nowMs
      );
    }
    return steerSessionRemotely(operation, lease, operationDigest, verified.authorityEpoch, nowMs);
  }
  if (isV3Lease(lease)) {
    return settleWithoutEffect(
      operation,
      operationDigest,
      refuse('REMOTE_STEERING_LEASE_MALFORMED', 'a V1/V2 worker operation cannot be carried by a V3 session lease', operation),
      nowMs
    );
  }

  // The lease names a run; this app decides whether that exact incarnation is live. A run id
  // is never guessed at, never matched by prefix and never resolved to "the only run there
  // is": a lease minted against a run that has since parked or been replaced authorizes
  // nothing, which is the whole reason the id is inside the signed bytes.
  if (!activeRunIds().includes(operation.runId)) {
    return settleWithoutEffect(
      operation,
      operationDigest,
      refuse(
        'REMOTE_STEERING_RUN_NOT_FOUND',
        'no live run has that id; the run this lease was minted for is no longer executing',
        operation
      ),
      nowMs
    );
  }
  const primeConversationId = primeConversation(operation.runId);
  if (!primeConversationId) {
    return settleWithoutEffect(
      operation,
      operationDigest,
      refuse('REMOTE_STEERING_RUN_NOT_FOUND', 'that run has no prime conversation bound', operation),
      nowMs
    );
  }

  if (operation.action === 'STATUS') {
    // No side effect, so the claim and the decision are one write and there is no window in
    // which a crash could make a replay indeterminate.
    const accepted = outcome({
      status: 'accepted',
      verifierContractVersion: operation.verifierContractVersion,
      operationId: operation.operationId,
      operationDigest,
      action: 'STATUS',
      runId: operation.runId,
      run: runView(operation.runId, lease.workerAllowlist)
    });
    return settleWithoutEffect(operation, operationDigest, accepted, nowMs);
  }

  if (operation.action === 'SPAWN') {
    if (!isV2Operation(operation) || !isV2Lease(lease)) {
      return settleWithoutEffect(
        operation,
        operationDigest,
        refuse('REMOTE_STEERING_SPAWN_REFUSED', 'SPAWN is valid only inside the V2 signed protocol', operation),
        nowMs
      );
    }
    return spawnRemotely(
      operation,
      lease,
      operationDigest,
      primeConversationId,
      verified.authorityEpoch,
      nowMs
    );
  }

  return deliver(
    operation,
    lease,
    operationDigest,
    primeConversationId,
    verified.authorityEpoch,
    hooks,
    nowMs
  );
}

/**
 * `MESSAGE` — external prime authority over one allowlisted worker of one exact run.
 *
 * It is the prime's own path, not a shortcut past it. The signed operation resolves to the
 * run's real prime conversation and the message is staged through `stageMessages()`, so the
 * star topology, the route check, the per-recipient queue bound, the free-slot reservation
 * for a sleeping recipient, the durable acceptance barrier, the rollback on a failed write,
 * the browser revival custody and the at-least-once inbox all apply unchanged. What this
 * cannot do is anything that is not that one delivery: V2 SPAWN has its own separately-signed
 * branch below; MESSAGE cannot finish, clear, wake by any other means, change a model or a
 * setting, run a command or reach a provider.
 */
async function deliver(
  operation: RemoteSteeringOperationV1 | RemoteSteeringOperationV2,
  lease: RemoteSteeringLeaseV1 | RemoteSteeringLeaseV2,
  digest: string,
  primeConversationId: string,
  verifiedAuthorityEpoch: number,
  hooks: RemoteSteeringBrokerHooks,
  nowMs: number
): Promise<RemoteSteeringOutcome> {
  const target = operation.targetWorkerId;
  const text = operation.messageText;
  // Already guaranteed by the closed operation schema and the lease-authority check; asserted
  // here so a future edit to either cannot quietly hand `stageMessages` a null recipient.
  if (target === null || text === null || !lease.workerAllowlist.includes(target)) {
    return settleWithoutEffect(
      operation,
      digest,
      refuse('REMOTE_STEERING_WORKER_NOT_ALLOWLISTED', 'the operation names no allowlisted recipient', operation),
      nowMs
    );
  }

  const caller: Caller = { conversationId: primeConversationId };
  const present = swarmState(operation.runId).agents.find((info) => info.id === target);
  if (!present || present.role !== 'worker') {
    return settleWithoutEffect(
      operation,
      digest,
      refuse('REMOTE_STEERING_WORKER_NOT_IN_RUN', `${target} is not a worker of that run`, operation),
      nowMs
    );
  }

  // Before any slot is reserved, and for the same reason the prime's own message path does
  // it: a sleeping worker whose chat has since crossed the context ceiling is not revivable,
  // and this is the call that would otherwise wake it.
  try {
    await hooks.measureSleepingWorkers(caller, target);
  } catch (error) {
    return settleWithoutEffect(
      operation,
      digest,
      refuse(
        'REMOTE_STEERING_DELIVERY_REFUSED',
        detailOf(error, 'worker context state could not cross its durable barrier'),
        operation
      ),
      nowMs
    );
  }

  if (!authorityStillLive(verifiedAuthorityEpoch, operation.signingKeyFingerprint)) {
    return refuse(
      'REMOTE_STEERING_DISABLED',
      'remote-steering authority changed while this operation was being checked; nothing was carried out',
      operation
    );
  }

  // The claim is the last thing before the broker is asked for anything. From here on, a
  // crash is answered with a refusal rather than a second delivery.
  const claimFailure = await claimReceipt(operation, digest, nowMs);
  if (claimFailure) return claimFailure;

  if (!authorityStillLive(verifiedAuthorityEpoch, operation.signingKeyFingerprint)) {
    return settleWithoutEffect(
      operation,
      digest,
      refuse(
        'REMOTE_STEERING_DISABLED',
        'remote-steering authority was revoked before the broker mutation; nothing was carried out',
        operation
      ),
      nowMs
    );
  }

  let staged: ReturnType<typeof stageMessages>;
  try {
    staged = stageMessages(caller, [{ to: target, text }], {
      expectedRunId: operation.runId,
      preserveText: true
    });
  } catch (error) {
    // Nothing was queued: `stageMessages` validates the whole batch before it enqueues
    // anything. The claim becomes a terminal refusal rather than staying indeterminate.
    return settleWithoutEffect(
      operation,
      digest,
      refuse('REMOTE_STEERING_DELIVERY_REFUSED', detailOf(error, 'the broker refused the message'), operation),
      nowMs
    );
  }

  let durable = false;
  let barrierError: unknown = null;
  try {
    durable = await persistCriticalSwarmNow();
  } catch (error) {
    barrierError = error;
  }
  if (!durable) {
    staged.rollback();
    return settleWithoutEffect(
      operation,
      digest,
      refuse(
        'REMOTE_STEERING_DELIVERY_REFUSED',
        barrierError
          ? detailOf(barrierError, 'the message could not cross its durable acceptance barrier; nothing was queued')
          : 'the message could not cross its durable acceptance barrier; nothing was queued',
        operation
      ),
      nowMs
    );
  }

  if (!authorityStillLive(verifiedAuthorityEpoch, operation.signingKeyFingerprint)) {
    staged.rollback();
    let rollbackDurable = false;
    try {
      rollbackDurable = await persistCriticalSwarmNow();
    } catch {
      rollbackDurable = false;
    }
    if (!rollbackDurable) {
      // Keep the claimed receipt indeterminate. The staged generation crossed durability and
      // its rollback did not, so claiming a clean refusal would permit a dangerous retry.
      return refuse(
        'REMOTE_STEERING_OPERATION_INDETERMINATE',
        'remote-steering authority was revoked during the durable broker barrier and the rollback could not be proven durable; do not retry this operation id',
        operation
      );
    }
    return settleWithoutEffect(
      operation,
      digest,
      refuse(
        'REMOTE_STEERING_DISABLED',
        'remote-steering authority was revoked before publication; the staged message was rolled back durably',
        operation
      ),
      nowMs
    );
  }
  staged.commit();

  // Browser side effects only after the broker revision that reserved the slot is durable —
  // exactly as a prime's own wake does. Nothing has been typed into that chat yet.
  if (staged.waking.length > 0) requestWorkerRevivals(staged.waking, operation.runId);
  for (const message of staged.messages) await recordAgentMessage(message, 'sent', primeConversationId);

  const message = staged.messages[0];
  const accepted = outcome({
    status: 'accepted',
    verifierContractVersion: operation.verifierContractVersion,
    operationId: operation.operationId,
    operationDigest: digest,
    action: 'MESSAGE',
    runId: operation.runId,
    delivered: {
      targetWorkerId: target,
      messageId: message?.id ?? '',
      messageSha256: operation.messageSha256 ?? '',
      messageLength: operation.messageLength ?? 0,
      waking: staged.waking.includes(target)
    }
  });
  logInfo(
    `remote steering: operation ${operation.operationId} delivered one message to ${target} in run ${operation.runId}`
  );
  return settleAfterEffect(operation, digest, accepted, nowMs);
}

/**
 * V2 `SPAWN` — external representation of one exact prime spawn already authorized by the
 * attended V2 lease and narrowed again by one signed operation.
 *
 * No remote chat becomes the prime. The signed run resolves to its real prime conversation,
 * then the ordinary broker stages exactly one worker using that caller. The expected-id fence
 * additionally requires the broker's own next deterministic worker id to equal the signed id;
 * a stale or already-consumed authorization therefore cannot slide onto another slot.
 *
 * Publication follows the same safety ordering as local spawn: topology plan → critical durable
 * barrier → commit → browser bootstrap. The operation receipt is claimed before the topology
 * plan, so a crash can never make the same signed spawn safe to execute twice.
 */
async function spawnRemotely(
  operation: RemoteSteeringOperationV2,
  lease: RemoteSteeringLeaseV2,
  digest: string,
  primeConversationId: string,
  verifiedAuthorityEpoch: number,
  nowMs: number
): Promise<RemoteSteeringOutcome> {
  const target = operation.targetWorkerId;
  const task = operation.spawnTaskText;
  if (target === null || task === null || !lease.workerAllowlist.includes(target)) {
    return settleWithoutEffect(
      operation,
      digest,
      refuse('REMOTE_STEERING_WORKER_NOT_ALLOWLISTED', 'the V2 SPAWN names no allowlisted future worker', operation),
      nowMs
    );
  }

  const present = swarmState(operation.runId).agents.find((info) => info.id === target);
  if (present) {
    return settleWithoutEffect(
      operation,
      digest,
      refuse(
        'REMOTE_STEERING_SPAWN_REFUSED',
        `${target} already exists in that run; a signed spawn never replaces, revives or retasks an existing worker`,
        operation
      ),
      nowMs
    );
  }

  if (!authorityStillLive(verifiedAuthorityEpoch, operation.signingKeyFingerprint)) {
    return refuse(
      'REMOTE_STEERING_DISABLED',
      'remote-steering authority changed while this spawn was being checked; nothing was carried out',
      operation
    );
  }

  const claimFailure = await claimReceipt(operation, digest, nowMs);
  if (claimFailure) return claimFailure;

  if (!authorityStillLive(verifiedAuthorityEpoch, operation.signingKeyFingerprint)) {
    return settleWithoutEffect(
      operation,
      digest,
      refuse(
        'REMOTE_STEERING_DISABLED',
        'remote-steering authority was revoked before the spawn broker mutation; nothing was carried out',
        operation
      ),
      nowMs
    );
  }

  const caller: Caller = { conversationId: primeConversationId };
  let staged: ReturnType<typeof stageExpectedSpawn>;
  try {
    staged = stageExpectedSpawn(
      { caller, workers: [{ task }] },
      target,
      operation.runId
    );
  } catch (error) {
    return settleWithoutEffect(
      operation,
      digest,
      refuse('REMOTE_STEERING_SPAWN_REFUSED', detailOf(error, 'the broker refused the signed spawn'), operation),
      nowMs
    );
  }

  let durable = false;
  let barrierError: unknown = null;
  try {
    durable = await persistCriticalSwarmNow();
  } catch (error) {
    barrierError = error;
  }
  if (!durable) {
    staged.rollback();
    return settleWithoutEffect(
      operation,
      digest,
      refuse(
        'REMOTE_STEERING_SPAWN_REFUSED',
        barrierError
          ? detailOf(barrierError, 'the spawn could not cross its durable acceptance barrier; no worker was published')
          : 'the spawn could not cross its durable acceptance barrier; no worker was published',
        operation
      ),
      nowMs
    );
  }

  if (!authorityStillLive(verifiedAuthorityEpoch, operation.signingKeyFingerprint)) {
    staged.rollback();
    let rollbackDurable = false;
    try {
      rollbackDurable = await persistCriticalSwarmNow();
    } catch {
      rollbackDurable = false;
    }
    if (!rollbackDurable) {
      return refuse(
        'REMOTE_STEERING_OPERATION_INDETERMINATE',
        'remote-steering authority was revoked during the durable spawn barrier and the rollback could not be proven durable; do not retry this operation id',
        operation
      );
    }
    return settleWithoutEffect(
      operation,
      digest,
      refuse(
        'REMOTE_STEERING_DISABLED',
        'remote-steering authority was revoked before spawn publication; the staged worker was rolled back durably',
        operation
      ),
      nowMs
    );
  }

  staged.commit();
  requestWorkerBootstraps(staged.created.map((worker) => worker.id), operation.runId);
  const created = staged.created[0];
  const accepted = outcome({
    status: 'accepted',
    verifierContractVersion: operation.verifierContractVersion,
    operationId: operation.operationId,
    operationDigest: digest,
    action: 'SPAWN',
    runId: operation.runId,
    spawned: {
      workerId: target,
      state: created?.state ?? 'invited',
      taskSha256: operation.spawnTaskSha256 ?? '',
      taskLength: operation.spawnTaskLength ?? 0
    }
  });
  logInfo(`remote steering: operation ${operation.operationId} spawned ${target} in run ${operation.runId}`);
  return settleAfterEffect(operation, digest, accepted, nowMs);
}

/** Bounded, text-free-ish explanation. Broker refusals name ids and counts, never content. */
function detailOf(error: unknown, fallback: string): string {
  const message = error instanceof AgentError || error instanceof Error ? error.message : String(error);
  return (message || fallback).slice(0, 300);
}

/** Test seam: drops in-memory pin/receipt state without touching disk. */
export function resetRemoteSteeringForTests(): void {
  pin = null;
  receipts.clear();
  restored = false;
  resetFrontierLongrunParentForTests();
}
