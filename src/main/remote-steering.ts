/**
 * The verifier/broker half of Nexora remote steering.
 *
 * WHAT THIS IS. Command Center, attended on this PC, mints a signed
 * `cc_remote_steering_operation_envelope_v1`. The operator hands that envelope to an
 * unattributed mobile/ChatGPT turn, which relays it verbatim into the `remote_steering` MCP
 * tool. This module decides whether the document is authentic, what exactly it authorizes,
 * whether it has already been carried out, and — for the two actions in the closed V1 set —
 * carries it out against the existing multi-agent broker.
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
 *     delivery path, and nothing here can spawn, finish, change a model or configuration,
 *     run a shell command or reach a provider.
 *
 * NO LISTENER. This module owns no socket, no daemon, no watcher and no poller. It is
 * reached only when the existing Core MCP surface dispatches a `remote_steering` tool call.
 *
 * The wire protocol itself is frozen by Command Center and mirrored in
 * `remote-steering-contract.ts`; nothing here may reinterpret a field it defines.
 */

import type { AgentState } from '../shared/session.js';
import type { RemoteSteeringPinView } from '../shared/types.js';
import {
  AgentError,
  activeRunIds,
  persistCriticalSwarmNow,
  primeConversation,
  requestWorkerRevivals,
  stageMessages,
  swarmState,
  type Caller
} from './agents.js';
import { getConfig } from './config.js';
import { readDurable, writeDurableNow, writeDurableSoon } from './durable.js';
import { logInfo, logWarn } from './logger.js';
import {
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
import { recordAgentMessage } from './session/recorder.js';

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
  // --- authorized and attempted; recorded once ---
  | 'REMOTE_STEERING_RUN_NOT_FOUND'
  | 'REMOTE_STEERING_WORKER_NOT_IN_RUN'
  | 'REMOTE_STEERING_DELIVERY_REFUSED'
  | 'REMOTE_STEERING_RECEIPT_WRITE_FAILED'
  | 'REMOTE_STEERING_RECEIPT_STORE_FULL';

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

export interface RemoteSteeringOutcome {
  readonly verifierId: typeof REMOTE_STEERING_VERIFIER_ID;
  readonly verifierContractVersion: typeof REMOTE_STEERING_VERIFIER_CONTRACT_VERSION;
  readonly status: 'accepted' | 'refused';
  readonly reason: RemoteSteeringRefusal | null;
  /** Bounded broker/verifier explanation. Never carries the message text. */
  readonly detail: string | null;
  /** Null only when the document never parsed far enough to name an operation. */
  readonly operationId: string | null;
  readonly operationDigest: string | null;
  readonly action: RemoteSteeringAction | null;
  readonly runId: string | null;
  /** True when this exact operation had already been decided and nothing was repeated. */
  readonly replay: boolean;
  readonly decidedAt: string;
  readonly delivered: RemoteSteeringDeliveryView | null;
  readonly run: RemoteSteeringRunView | null;
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
    replay: false,
    decidedAt: new Date().toISOString(),
    delivered: null,
    run: null,
    ...partial
  };
}

function refuse(
  reason: RemoteSteeringRefusal,
  detail: string | null,
  operation?: RemoteSteeringOperationV1
): RemoteSteeringOutcome {
  return outcome({
    status: 'refused',
    reason,
    detail,
    operationId: operation?.operationId ?? null,
    operationDigest: operation ? remoteSteeringOperationDigest(operation) : null,
    action: operation?.action ?? null,
    runId: operation?.runId ?? null
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
): { envelope: RemoteSteeringOperationEnvelopeV1 } | { reason: RemoteSteeringRefusal; detail: string | null } {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { reason: 'REMOTE_STEERING_ENVELOPE_MALFORMED', detail: 'the envelope is not a JSON object' };
  }
  const record = parsed as Record<string, unknown>;
  const lease = validateRemoteSteeringSignedLease(record['lease']);
  if (lease === null) {
    return { reason: 'REMOTE_STEERING_LEASE_MALFORMED', detail: 'the signed lease failed closed-schema validation' };
  }
  const operation = validateRemoteSteeringSignedOperation(record['operation']);
  if (operation === null) {
    return {
      reason: 'REMOTE_STEERING_ENVELOPE_MALFORMED',
      detail: 'the signed operation failed closed-schema validation'
    };
  }
  const mismatch = remoteSteeringOperationLeaseMismatch(operation.payload, lease.payload);
  if (mismatch !== null) return { reason: mismatch, detail: 'the operation is not authorized by its own lease' };

  const envelope = validateRemoteSteeringEnvelope(parsed);
  if (envelope === null) {
    return {
      reason: 'REMOTE_STEERING_ENVELOPE_MALFORMED',
      detail: 'the envelope wrapper failed closed-schema validation'
    };
  }
  return { envelope };
}

interface VerifiedEnvelope {
  readonly envelope: RemoteSteeringOperationEnvelopeV1;
  readonly lease: RemoteSteeringLeaseV1;
  readonly operation: RemoteSteeringOperationV1;
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
function verify(envelopeText: string): { verified: VerifiedEnvelope } | { refusal: RemoteSteeringOutcome } {
  if (!getConfig().remoteSteering.enabled) {
    return {
      refusal: refuse(
        'REMOTE_STEERING_DISABLED',
        'Remote steering is switched off in Chat On Steroids. The user enables it in Settings.'
      )
    };
  }
  if (!getConfig().multiAgent.enabled) {
    return {
      refusal: refuse(
        'REMOTE_STEERING_MULTI_AGENT_DISABLED',
        'Multi-agent mode is switched off, so there is no run to steer.'
      )
    };
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(envelopeText);
  } catch {
    return { refusal: refuse('REMOTE_STEERING_ENVELOPE_UNREADABLE', 'the envelope is not valid JSON') };
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
  if (!verifyRemoteSteeringSignature(canonicalLeaseBytes(lease), envelope.lease.signature, pinned.publicKeySpkiBase64)) {
    return { refusal: refuse('REMOTE_STEERING_LEASE_SIGNATURE_INVALID', null, operation) };
  }
  if (
    !verifyRemoteSteeringSignature(
      canonicalOperationBytes(operation),
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
      operationDigest: remoteSteeringOperationDigest(operation),
      authorityEpoch
    }
  };
}

/** Present-tense authority for an already-authenticated operation after an async boundary. */
function authorityStillLive(verifiedEpoch: number, signingKeyFingerprint: string): boolean {
  const config = getConfig();
  return (
    authorityEpoch === verifiedEpoch &&
    config.remoteSteering.enabled &&
    config.multiAgent.enabled &&
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
  return { ...existing.outcome, replay: true };
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
  operation: RemoteSteeringOperationV1,
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
  operation: RemoteSteeringOperationV1,
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
    return { ...previous.outcome, replay: true };
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
  operation: RemoteSteeringOperationV1,
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
  operation: RemoteSteeringOperationV1,
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
      operationId: operation.operationId,
      operationDigest,
      action: 'STATUS',
      runId: operation.runId,
      run: runView(operation.runId, lease.workerAllowlist)
    });
    return settleWithoutEffect(operation, operationDigest, accepted, nowMs);
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
 * cannot do is anything that is not that one delivery: it cannot spawn, finish, clear, wake
 * by any other means, change a model or a setting, run a command or reach a provider,
 * because there is no code path here that calls one.
 */
async function deliver(
  operation: RemoteSteeringOperationV1,
  lease: RemoteSteeringLeaseV1,
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
}
