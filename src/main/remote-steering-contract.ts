/**
 * `cc_remote_steering_operation_envelope_v1` — the verifier-side mirror of a wire protocol
 * this app does not own.
 *
 * Command Center is the producer. It holds an operator-local Ed25519 private key, mints one
 * immutable LEASE binding an exact run, a closed worker allowlist and a closed action set,
 * and then issues one short-lived one-shot signed OPERATION inside that live lease. The
 * resulting envelope carries no secret, so it is safe to hand to an unattributed mobile or
 * ChatGPT turn, which relays it verbatim to this app. This file is everything needed to
 * decide whether such a document is authentic and what exactly it authorizes.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS A MIRROR, NOT A DESIGN.
 *
 * Every constant, field name, key order, regex, bound and signing byte below is copied from
 * Command Center's frozen contract at commit `66f96287`:
 *
 *   apps/command-center/packages/shared/src/contracts/remote-steering.ts   (schema)
 *   apps/command-center/packages/engine/src/remote-steering.ts             (canonical bytes)
 *
 * Nothing here may be "improved". A renamed field, a reordered key, a relaxed regex, a
 * tolerated extra property, a clock skew allowance or a second spelling of the signing
 * domain is not a local style choice — it is a fork of a protocol whose whole purpose is
 * that two independently written implementations agree on one exact byte string. The
 * conformance suite (`test/remote-steering-conformance.test.ts`) verifies real CC-produced
 * canonical bytes and signatures against this file precisely so that drift is a red test
 * rather than a refusal the operator meets months later with an envelope in their hand.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO. It reads no file, holds no key, keeps no state,
 * consults no clock of its own and performs no side effect. `nowMs` is always a parameter.
 * That is what makes "the signature fails on every field mutation" a property rather than an
 * observation about one run. Pinning, receipts, refusal vocabulary and the actual broker
 * effects live in `remote-steering.ts`.
 * ---------------------------------------------------------------------------
 */

import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';

// ---------------------------------------------------------------------------
// Identity — contracts, versions, verifier.
// ---------------------------------------------------------------------------

/** The lease payload's `contract` literal. */
export const REMOTE_STEERING_LEASE_CONTRACT = 'cc_remote_steering_lease_v1';

/** The operation payload's `contract` literal. */
export const REMOTE_STEERING_OPERATION_CONTRACT = 'cc_remote_steering_operation_v1';

/** The outer envelope's `contract` literal — the only thing this verifier parses first. */
export const REMOTE_STEERING_ENVELOPE_CONTRACT = 'cc_remote_steering_operation_envelope_v1';

/**
 * The one admitted schema version.
 *
 * A document carrying any other value is refused, a HIGHER one included. "Newer" is not
 * "compatible": admitting a version this build does not implement would be guessing, which
 * is the exact failure mode the bridge exists to avoid.
 */
export const REMOTE_STEERING_SCHEMA_VERSION = 1;

/** The verifier family this app is. An envelope addressed to anything else is not ours. */
export const REMOTE_STEERING_VERIFIER_ID = 'chat-on-steroids';

/**
 * The remote-steering contract version this verifier implements.
 *
 * Distinct from the schema version on purpose: the schema describes the bytes, this
 * describes the admission/replay/refusal semantics the receiving side owes. They move
 * independently, and both travel inside the signed bytes.
 */
export const REMOTE_STEERING_VERIFIER_CONTRACT_VERSION = 1;

// ---------------------------------------------------------------------------
// Actions.
// ---------------------------------------------------------------------------

/**
 * The closed V1 action set.
 *
 * `STATUS` reads one exact run's bounded state and mutates nothing. `MESSAGE` delivers one
 * bounded text to one allowlisted worker of that run through this app's ordinary broker.
 *
 * Spawn, finish, wake-by-name, cancel, model/reasoning change, configuration change,
 * filesystem permission change, shell execution and provider execution are NOT members and
 * may not be added by widening this union alone.
 */
export type RemoteSteeringAction = 'MESSAGE' | 'STATUS';

/** The action set in canonical (ascending) order — the order a lease must declare. */
export const REMOTE_STEERING_ACTIONS: readonly RemoteSteeringAction[] = ['MESSAGE', 'STATUS'];

// ---------------------------------------------------------------------------
// Bounds. Each is part of the contract: a document outside them is refused.
// ---------------------------------------------------------------------------

/** Lease window hard ceiling: eight hours. A longer window is refused, never clamped. */
export const REMOTE_STEERING_LEASE_MAX_TTL_SECONDS = 28_800;

/** Operation window ceiling: five minutes. A one-shot authorization is not a session. */
export const REMOTE_STEERING_OPERATION_MAX_TTL_SECONDS = 300;

/** Maximum workers a single lease may allowlist. A lease is a narrow grant, not a fleet. */
export const REMOTE_STEERING_MAX_WORKERS = 16;

/** Maximum UTF-8 bytes of a `MESSAGE` operation's text. */
export const REMOTE_STEERING_MAX_MESSAGE_BYTES = 4_000;

/** Maximum characters of an identifier field (`missionId`, `runId`, a worker id). */
export const REMOTE_STEERING_MAX_IDENTIFIER_CHARS = 128;

/** The signing-input prefix. Versioned so a future scheme cannot be confused with this one. */
export const REMOTE_STEERING_SIGNING_DOMAIN = 'nexora.cc.remote-steering.v1:';

// ---------------------------------------------------------------------------
// The documents.
// ---------------------------------------------------------------------------

export interface RemoteSteeringLeaseV1 {
  readonly contract: typeof REMOTE_STEERING_LEASE_CONTRACT;
  readonly schemaVersion: typeof REMOTE_STEERING_SCHEMA_VERSION;
  readonly verifierId: typeof REMOTE_STEERING_VERIFIER_ID;
  readonly verifierContractVersion: typeof REMOTE_STEERING_VERIFIER_CONTRACT_VERSION;
  /** 32 lowercase hex characters, minted by Command Center. */
  readonly leaseId: string;
  /** The operator's mission label. Bounded, opaque to this verifier. */
  readonly missionId: string;
  /** SHA-256 (64 lowercase hex) of the mission document's exact bytes. */
  readonly missionDigest: string;
  /** The exact run this lease steers. Never a pattern, never a list. */
  readonly runId: string;
  /** The closed worker allowlist: non-empty, unique, sorted ascending. */
  readonly workerAllowlist: readonly string[];
  /** The closed action set: non-empty, unique, sorted ascending. */
  readonly allowedActions: readonly RemoteSteeringAction[];
  /** ISO-8601 UTC with millisecond precision (`YYYY-MM-DDTHH:MM:SS.sssZ`). */
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** SHA-256 (64 lowercase hex) of the SPKI DER of the signing key's public half. */
  readonly signingKeyFingerprint: string;
  /** SHA-256 (64 lowercase hex) of the operator's recorded intent document. */
  readonly operatorIntentDigest: string;
}

export interface RemoteSteeringOperationV1 {
  readonly contract: typeof REMOTE_STEERING_OPERATION_CONTRACT;
  readonly schemaVersion: typeof REMOTE_STEERING_SCHEMA_VERSION;
  readonly verifierId: typeof REMOTE_STEERING_VERIFIER_ID;
  readonly verifierContractVersion: typeof REMOTE_STEERING_VERIFIER_CONTRACT_VERSION;
  /** 32 lowercase hex characters, unique across every operation Command Center has claimed. */
  readonly operationId: string;
  readonly leaseId: string;
  /** SHA-256 of the lease's exact canonical signing bytes — binds the BYTES, not the id. */
  readonly leaseDigest: string;
  readonly missionDigest: string;
  readonly runId: string;
  readonly action: RemoteSteeringAction;
  /** An allowlisted worker for `MESSAGE`; `null` for `STATUS`. */
  readonly targetWorkerId: string | null;
  /** The bounded message for `MESSAGE`; `null` for `STATUS`. */
  readonly messageText: string | null;
  readonly messageSha256: string | null;
  readonly messageLength: number | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signingKeyFingerprint: string;
}

export interface RemoteSteeringSignedLeaseV1 {
  readonly payload: RemoteSteeringLeaseV1;
  /** Base64 of the 64-byte Ed25519 signature. */
  readonly signature: string;
}

export interface RemoteSteeringSignedOperationV1 {
  readonly payload: RemoteSteeringOperationV1;
  readonly signature: string;
}

/**
 * The one document that leaves Command Center.
 *
 * It carries BOTH signed halves, so this verifier needs no prior knowledge of the lease and
 * no lease-distribution channel: it pins one public key, and this envelope proves the whole
 * chain. It carries no private key, no token, no session secret, no provider credential.
 */
export interface RemoteSteeringOperationEnvelopeV1 {
  readonly contract: typeof REMOTE_STEERING_ENVELOPE_CONTRACT;
  readonly schemaVersion: typeof REMOTE_STEERING_SCHEMA_VERSION;
  readonly verifierId: typeof REMOTE_STEERING_VERIFIER_ID;
  readonly verifierContractVersion: typeof REMOTE_STEERING_VERIFIER_CONTRACT_VERSION;
  /** The signing key this verifier must already have pinned. Identity, not material. */
  readonly signingKeyFingerprint: string;
  readonly lease: RemoteSteeringSignedLeaseV1;
  readonly operation: RemoteSteeringSignedOperationV1;
}

// ---------------------------------------------------------------------------
// Frozen canonical key orders. These ARE the schemas.
//
// `JSON.stringify` emits keys in insertion order, so two objects equal as values can
// serialize to different bytes and a verifier that re-serializes a parsed payload can
// produce bytes the signature was never over. Every signed document is therefore emitted
// from the frozen order below, and validation refuses any document carrying a key that is
// not in that order. There is no "extra fields ignored" path.
// ---------------------------------------------------------------------------

const LEASE_KEYS = [
  'contract',
  'schemaVersion',
  'verifierId',
  'verifierContractVersion',
  'leaseId',
  'missionId',
  'missionDigest',
  'runId',
  'workerAllowlist',
  'allowedActions',
  'issuedAt',
  'expiresAt',
  'signingKeyFingerprint',
  'operatorIntentDigest'
] as const;

const OPERATION_KEYS = [
  'contract',
  'schemaVersion',
  'verifierId',
  'verifierContractVersion',
  'operationId',
  'leaseId',
  'leaseDigest',
  'missionDigest',
  'runId',
  'action',
  'targetWorkerId',
  'messageText',
  'messageSha256',
  'messageLength',
  'issuedAt',
  'expiresAt',
  'signingKeyFingerprint'
] as const;

const SIGNED_KEYS = ['payload', 'signature'] as const;

const ENVELOPE_KEYS = [
  'contract',
  'schemaVersion',
  'verifierId',
  'verifierContractVersion',
  'signingKeyFingerprint',
  'lease',
  'operation'
] as const;

/** Exported so a conformance test can assert what is emitted is what CC declares. */
export const REMOTE_STEERING_LEASE_KEY_ORDER: readonly string[] = LEASE_KEYS;
export const REMOTE_STEERING_OPERATION_KEY_ORDER: readonly string[] = OPERATION_KEYS;
export const REMOTE_STEERING_ENVELOPE_KEY_ORDER: readonly string[] = ENVELOPE_KEYS;

/** Raised only by a programming error — a caller canonicalizing an unvalidated record. */
export class RemoteSteeringContractError extends Error {}

// ---------------------------------------------------------------------------
// Primitive validators. Every one is total and returns a boolean, so a refusal is always a
// value the caller has to handle rather than an exception somebody may swallow.
// ---------------------------------------------------------------------------

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_32 = /^[0-9a-f]{32}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE64_STRICT = /^[A-Za-z0-9+/]+={0,2}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True iff `value` has EXACTLY the named keys — no missing member, no extra member. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  if (actual.length !== keys.length) return false;
  const expected = new Set(keys);
  for (const key of actual) if (!expected.has(key)) return false;
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) return false;
  return true;
}

/** 64 lowercase hex characters. Uppercase is refused: a digest has one spelling here. */
export function isRemoteSteeringDigest(value: unknown): value is string {
  return typeof value === 'string' && HEX_64.test(value);
}

/** 32 lowercase hex characters — the lease/operation id shape. */
export function isRemoteSteeringId(value: unknown): value is string {
  return typeof value === 'string' && HEX_32.test(value);
}

/** A bounded opaque identifier (mission id, run id, worker id). */
export function isRemoteSteeringIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= REMOTE_STEERING_MAX_IDENTIFIER_CHARS &&
    IDENTIFIER.test(value)
  );
}

/**
 * An ISO-8601 UTC instant with millisecond precision that ROUND-TRIPS.
 *
 * The regex alone would accept `2026-02-31T00:00:00.000Z`; the round trip rejects it,
 * because `Date` normalizes an impossible date into a different string. A timestamp that
 * does not denote the instant it spells is refused rather than silently reinterpreted.
 */
export function isRemoteSteeringTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_UTC_MS.test(value)) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString() === value;
}

/** Base64 of exactly 64 bytes — the Ed25519 signature shape. */
export function isRemoteSteeringSignature(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || !BASE64_STRICT.test(value)) return false;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64');
  } catch {
    return false;
  }
  // `Buffer.from` is lenient; re-encoding proves the input was the exact canonical spelling
  // of those bytes rather than a padded or mutated variant of them.
  return decoded.length === 64 && decoded.toString('base64') === value;
}

function isAction(value: unknown): value is RemoteSteeringAction {
  return value === 'MESSAGE' || value === 'STATUS';
}

/** Ascending, unique, non-empty, bounded string list — the allowlist/action-set shape. */
function isSortedUniqueList(value: unknown, max: number): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return false;
  let previous: string | null = null;
  for (const entry of value) {
    if (typeof entry !== 'string') return false;
    if (previous !== null && !(entry > previous)) return false;
    previous = entry;
  }
  return true;
}

/** Seconds between two validated timestamps. */
export function remoteSteeringWindowSeconds(issuedAt: string, expiresAt: string): number {
  return (Date.parse(expiresAt) - Date.parse(issuedAt)) / 1000;
}

/**
 * True iff `nowMs` lies inside `[issuedAt, expiresAt)`.
 *
 * No skew allowance, deliberately. Command Center signs on the same machine this verifier
 * runs on, so there is no clock to reconcile — and a tolerance invented here would widen
 * every operation's authorized window past what the operator actually granted.
 */
export function remoteSteeringWindowLive(issuedAt: string, expiresAt: string, nowMs: number): boolean {
  return nowMs >= Date.parse(issuedAt) && nowMs < Date.parse(expiresAt);
}

// ---------------------------------------------------------------------------
// Canonical serialization.
// ---------------------------------------------------------------------------

/**
 * Emit `{"k":v,...}` in the declared key order.
 *
 * Values go through `JSON.stringify`, which is deterministic for the scalar and
 * string-array members these schemas admit. The function refuses a record whose key set is
 * not exactly `keys`, so it cannot silently drop a member it does not know about.
 */
function canonicalJson(value: Record<string, unknown>, keys: readonly string[]): string {
  if (!hasExactKeys(value, keys)) {
    throw new RemoteSteeringContractError('refusing to canonicalize a record with an unexpected key set');
  }
  const parts: string[] = [];
  for (const key of keys) parts.push(`${JSON.stringify(key)}:${JSON.stringify(value[key])}`);
  return `{${parts.join(',')}}`;
}

/**
 * The exact bytes a lease signature covers.
 *
 * Domain separated: the contract literal is both the first canonical member and part of the
 * prefix, so a lease signature cannot verify as an operation signature even if a future
 * edit reorders the members.
 */
export function canonicalLeaseBytes(lease: RemoteSteeringLeaseV1): Buffer {
  const json = canonicalJson(lease as unknown as Record<string, unknown>, LEASE_KEYS);
  return Buffer.from(`${REMOTE_STEERING_SIGNING_DOMAIN}${REMOTE_STEERING_LEASE_CONTRACT}\n${json}`, 'utf8');
}

/** The exact bytes an operation signature covers. */
export function canonicalOperationBytes(operation: RemoteSteeringOperationV1): Buffer {
  const json = canonicalJson(operation as unknown as Record<string, unknown>, OPERATION_KEYS);
  return Buffer.from(`${REMOTE_STEERING_SIGNING_DOMAIN}${REMOTE_STEERING_OPERATION_CONTRACT}\n${json}`, 'utf8');
}

/** SHA-256 (lowercase hex) of arbitrary bytes. The one hashing path in this bridge. */
export function remoteSteeringSha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The digest an operation binds: SHA-256 of the lease's canonical signing bytes. */
export function remoteSteeringLeaseDigest(lease: RemoteSteeringLeaseV1): string {
  return remoteSteeringSha256(canonicalLeaseBytes(lease));
}

/** SHA-256 of the operation's canonical signing bytes — the receipt's replay key. */
export function remoteSteeringOperationDigest(operation: RemoteSteeringOperationV1): string {
  return remoteSteeringSha256(canonicalOperationBytes(operation));
}

/** The fingerprint a verifier pins: SHA-256 (lowercase hex) of the SPKI DER. */
export function remoteSteeringFingerprint(publicKeySpkiBase64: string): string {
  return remoteSteeringSha256(Buffer.from(publicKeySpkiBase64, 'base64'));
}

// ---------------------------------------------------------------------------
// Closed document validation. Each returns the typed value or `null`.
// ---------------------------------------------------------------------------

export function validateRemoteSteeringLease(value: unknown): RemoteSteeringLeaseV1 | null {
  if (!isPlainObject(value) || !hasExactKeys(value, LEASE_KEYS)) return null;
  if (value['contract'] !== REMOTE_STEERING_LEASE_CONTRACT) return null;
  if (value['schemaVersion'] !== REMOTE_STEERING_SCHEMA_VERSION) return null;
  if (value['verifierId'] !== REMOTE_STEERING_VERIFIER_ID) return null;
  if (value['verifierContractVersion'] !== REMOTE_STEERING_VERIFIER_CONTRACT_VERSION) return null;
  if (!isRemoteSteeringId(value['leaseId'])) return null;
  if (!isRemoteSteeringIdentifier(value['missionId'])) return null;
  if (!isRemoteSteeringDigest(value['missionDigest'])) return null;
  if (!isRemoteSteeringIdentifier(value['runId'])) return null;

  const workers = value['workerAllowlist'];
  if (!isSortedUniqueList(workers, REMOTE_STEERING_MAX_WORKERS)) return null;
  if (!workers.every((worker) => isRemoteSteeringIdentifier(worker))) return null;

  const actions = value['allowedActions'];
  if (!isSortedUniqueList(actions, REMOTE_STEERING_ACTIONS.length)) return null;
  if (!actions.every((action) => isAction(action))) return null;

  if (!isRemoteSteeringTimestamp(value['issuedAt'])) return null;
  if (!isRemoteSteeringTimestamp(value['expiresAt'])) return null;
  const window = remoteSteeringWindowSeconds(value['issuedAt'] as string, value['expiresAt'] as string);
  if (!(window > 0) || window > REMOTE_STEERING_LEASE_MAX_TTL_SECONDS) return null;

  if (!isRemoteSteeringDigest(value['signingKeyFingerprint'])) return null;
  if (!isRemoteSteeringDigest(value['operatorIntentDigest'])) return null;

  return value as unknown as RemoteSteeringLeaseV1;
}

/**
 * Validate an operation STANDING ALONE.
 *
 * Its relationship to a lease is a separate explicit check, so a caller cannot accidentally
 * validate the shape and believe it validated the authority.
 */
export function validateRemoteSteeringOperation(value: unknown): RemoteSteeringOperationV1 | null {
  if (!isPlainObject(value) || !hasExactKeys(value, OPERATION_KEYS)) return null;
  if (value['contract'] !== REMOTE_STEERING_OPERATION_CONTRACT) return null;
  if (value['schemaVersion'] !== REMOTE_STEERING_SCHEMA_VERSION) return null;
  if (value['verifierId'] !== REMOTE_STEERING_VERIFIER_ID) return null;
  if (value['verifierContractVersion'] !== REMOTE_STEERING_VERIFIER_CONTRACT_VERSION) return null;
  if (!isRemoteSteeringId(value['operationId'])) return null;
  if (!isRemoteSteeringId(value['leaseId'])) return null;
  if (!isRemoteSteeringDigest(value['leaseDigest'])) return null;
  if (!isRemoteSteeringDigest(value['missionDigest'])) return null;
  if (!isRemoteSteeringIdentifier(value['runId'])) return null;

  const action = value['action'];
  if (!isAction(action)) return null;

  const target = value['targetWorkerId'];
  const text = value['messageText'];
  const digest = value['messageSha256'];
  const length = value['messageLength'];

  if (action === 'MESSAGE') {
    // Every message member is present together, or the document is not a message. There is
    // no partially-specified message.
    if (!isRemoteSteeringIdentifier(target)) return null;
    if (typeof text !== 'string' || text.length === 0) return null;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > REMOTE_STEERING_MAX_MESSAGE_BYTES) return null;
    if (!isRemoteSteeringDigest(digest)) return null;
    if (digest !== remoteSteeringSha256(Buffer.from(text, 'utf8'))) return null;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length !== bytes) return null;
  } else {
    // STATUS reads; it carries no target and no text. `null` is required, not merely
    // tolerated — an absent key already failed the exact-key check.
    if (target !== null || text !== null || digest !== null || length !== null) return null;
  }

  if (!isRemoteSteeringTimestamp(value['issuedAt'])) return null;
  if (!isRemoteSteeringTimestamp(value['expiresAt'])) return null;
  const window = remoteSteeringWindowSeconds(value['issuedAt'] as string, value['expiresAt'] as string);
  if (!(window > 0) || window > REMOTE_STEERING_OPERATION_MAX_TTL_SECONDS) return null;

  if (!isRemoteSteeringDigest(value['signingKeyFingerprint'])) return null;

  return value as unknown as RemoteSteeringOperationV1;
}

export function validateRemoteSteeringSignedLease(value: unknown): RemoteSteeringSignedLeaseV1 | null {
  if (!isPlainObject(value) || !hasExactKeys(value, SIGNED_KEYS)) return null;
  const payload = validateRemoteSteeringLease(value['payload']);
  if (payload === null) return null;
  const signature = value['signature'];
  if (!isRemoteSteeringSignature(signature)) return null;
  return { payload, signature };
}

export function validateRemoteSteeringSignedOperation(value: unknown): RemoteSteeringSignedOperationV1 | null {
  if (!isPlainObject(value) || !hasExactKeys(value, SIGNED_KEYS)) return null;
  const payload = validateRemoteSteeringOperation(value['payload']);
  if (payload === null) return null;
  const signature = value['signature'];
  if (!isRemoteSteeringSignature(signature)) return null;
  return { payload, signature };
}

/**
 * Validate the outer envelope's SHAPE and its internal cross-bindings.
 *
 * This does NOT verify a signature — that needs a pinned key, which this pure module
 * deliberately cannot reach. It proves the document is internally coherent so that the
 * signature check upstream is over bytes whose relationships already hold.
 */
export function validateRemoteSteeringEnvelope(value: unknown): RemoteSteeringOperationEnvelopeV1 | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ENVELOPE_KEYS)) return null;
  if (value['contract'] !== REMOTE_STEERING_ENVELOPE_CONTRACT) return null;
  if (value['schemaVersion'] !== REMOTE_STEERING_SCHEMA_VERSION) return null;
  if (value['verifierId'] !== REMOTE_STEERING_VERIFIER_ID) return null;
  if (value['verifierContractVersion'] !== REMOTE_STEERING_VERIFIER_CONTRACT_VERSION) return null;
  if (!isRemoteSteeringDigest(value['signingKeyFingerprint'])) return null;

  const lease = validateRemoteSteeringSignedLease(value['lease']);
  if (lease === null) return null;
  const operation = validateRemoteSteeringSignedOperation(value['operation']);
  if (operation === null) return null;

  // One fingerprint, three places. A mismatch would let a reader pin the outer value while
  // the signatures were made by another key.
  if (value['signingKeyFingerprint'] !== lease.payload.signingKeyFingerprint) return null;
  if (value['signingKeyFingerprint'] !== operation.payload.signingKeyFingerprint) return null;

  if (remoteSteeringOperationLeaseMismatch(operation.payload, lease.payload) !== null) return null;

  return value as unknown as RemoteSteeringOperationEnvelopeV1;
}

// ---------------------------------------------------------------------------
// Authority — an operation against its lease.
// ---------------------------------------------------------------------------

/** Why an operation is not authorized by its lease, or `null` when it is. */
export function remoteSteeringOperationLeaseMismatch(
  operation: RemoteSteeringOperationV1,
  lease: RemoteSteeringLeaseV1
):
  | 'REMOTE_STEERING_LEASE_MALFORMED'
  | 'REMOTE_STEERING_ACTION_NOT_LEASED'
  | 'REMOTE_STEERING_WORKER_NOT_ALLOWLISTED'
  | 'REMOTE_STEERING_OPERATION_WINDOW_EXCEEDS_LEASE'
  | null {
  if (operation.leaseId !== lease.leaseId) return 'REMOTE_STEERING_LEASE_MALFORMED';
  if (operation.leaseDigest !== remoteSteeringLeaseDigest(lease)) return 'REMOTE_STEERING_LEASE_MALFORMED';
  if (operation.missionDigest !== lease.missionDigest) return 'REMOTE_STEERING_LEASE_MALFORMED';
  if (operation.runId !== lease.runId) return 'REMOTE_STEERING_LEASE_MALFORMED';
  if (operation.signingKeyFingerprint !== lease.signingKeyFingerprint) return 'REMOTE_STEERING_LEASE_MALFORMED';
  if (!lease.allowedActions.includes(operation.action)) return 'REMOTE_STEERING_ACTION_NOT_LEASED';
  if (operation.action === 'MESSAGE') {
    if (operation.targetWorkerId === null || !lease.workerAllowlist.includes(operation.targetWorkerId)) {
      return 'REMOTE_STEERING_WORKER_NOT_ALLOWLISTED';
    }
  }
  // An operation may narrow its lease. It may never outlive it.
  if (Date.parse(operation.expiresAt) > Date.parse(lease.expiresAt)) {
    return 'REMOTE_STEERING_OPERATION_WINDOW_EXCEEDS_LEASE';
  }
  if (Date.parse(operation.issuedAt) < Date.parse(lease.issuedAt)) {
    return 'REMOTE_STEERING_OPERATION_WINDOW_EXCEEDS_LEASE';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Signature verification.
// ---------------------------------------------------------------------------

/**
 * Verify a base64 Ed25519 signature over canonical bytes with a base64 SPKI public key.
 *
 * A pure function of its three arguments: no file, no store, no ambient key. The
 * `{ key, format, type }` object form is required — handed a bare Buffer,
 * `createPublicKey` assumes PEM and throws on DER bytes.
 */
export function verifyRemoteSteeringSignature(
  bytes: Buffer,
  signatureBase64: string,
  publicKeySpkiBase64: string
): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeySpkiBase64, 'base64'),
      format: 'der',
      type: 'spki'
    });
    if (publicKey.asymmetricKeyType !== 'ed25519') return false;
    return edVerify(null, bytes, publicKey, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}

/** Whether a pasted string is a usable Ed25519 SPKI public key, for the attended pin. */
export function isRemoteSteeringPublicKey(publicKeySpkiBase64: unknown): publicKeySpkiBase64 is string {
  if (typeof publicKeySpkiBase64 !== 'string' || !BASE64_STRICT.test(publicKeySpkiBase64)) return false;
  try {
    const der = Buffer.from(publicKeySpkiBase64, 'base64');
    // Re-encoding proves the operator pasted the exact canonical spelling of those bytes,
    // so the fingerprint they confirm is the fingerprint every later envelope must carry.
    if (der.toString('base64') !== publicKeySpkiBase64) return false;
    return createPublicKey({ key: der, format: 'der', type: 'spki' }).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}
