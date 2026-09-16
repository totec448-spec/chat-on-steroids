/**
 * `cc_remote_steering_operation_envelope_v3` — exact-session Frontier Longrun verifier mirror.
 * V3 leases may remain live for at most 72 hours; individual operations remain <=5 minutes.
 * The signed session id is CoS's durable session identity, so Compact & Resume may rebind its
 * provider conversation without widening the lease to any separately-created session.
 */

import {
  RemoteSteeringContractError,
  isRemoteSteeringDigest,
  isRemoteSteeringId,
  isRemoteSteeringIdentifier,
  isRemoteSteeringSignature,
  isRemoteSteeringTimestamp,
  remoteSteeringSha256,
  remoteSteeringWindowSeconds,
} from './remote-steering-contract.js';

export const REMOTE_STEERING_LEASE_CONTRACT_V3 = 'cc_remote_steering_lease_v3';
export const REMOTE_STEERING_OPERATION_CONTRACT_V3 = 'cc_remote_steering_operation_v3';
export const REMOTE_STEERING_ENVELOPE_CONTRACT_V3 = 'cc_remote_steering_operation_envelope_v3';
export const REMOTE_STEERING_SCHEMA_VERSION_V3 = 3;
export const REMOTE_STEERING_VERIFIER_ID_V3 = 'chat-on-steroids';
export const REMOTE_STEERING_VERIFIER_CONTRACT_VERSION_V3 = 3;
export const REMOTE_STEERING_SIGNING_DOMAIN_V3 = 'nexora.cc.remote-steering.v3:';
export type RemoteSteeringActionV3 = 'LONGRUN_START' | 'LOOP_OFF' | 'SESSION_STATUS';
export const REMOTE_STEERING_ACTIONS_V3: readonly RemoteSteeringActionV3[] = ['LONGRUN_START', 'LOOP_OFF', 'SESSION_STATUS'];
export const REMOTE_STEERING_LEASE_MAX_TTL_SECONDS_V3 = 259_200;
export const REMOTE_STEERING_OPERATION_MAX_TTL_SECONDS_V3 = 300;
export const REMOTE_STEERING_MAX_LONGRUN_BYTES_V3 = 16_000;

export interface RemoteSteeringLeaseV3 {
  readonly contract: typeof REMOTE_STEERING_LEASE_CONTRACT_V3;
  readonly schemaVersion: typeof REMOTE_STEERING_SCHEMA_VERSION_V3;
  readonly verifierId: typeof REMOTE_STEERING_VERIFIER_ID_V3;
  readonly verifierContractVersion: typeof REMOTE_STEERING_VERIFIER_CONTRACT_VERSION_V3;
  readonly leaseId: string;
  readonly missionId: string;
  readonly missionDigest: string;
  readonly sessionId: string;
  readonly allowedActions: readonly RemoteSteeringActionV3[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signingKeyFingerprint: string;
  readonly operatorIntentDigest: string;
}

export interface RemoteSteeringOperationV3 {
  readonly contract: typeof REMOTE_STEERING_OPERATION_CONTRACT_V3;
  readonly schemaVersion: typeof REMOTE_STEERING_SCHEMA_VERSION_V3;
  readonly verifierId: typeof REMOTE_STEERING_VERIFIER_ID_V3;
  readonly verifierContractVersion: typeof REMOTE_STEERING_VERIFIER_CONTRACT_VERSION_V3;
  readonly operationId: string;
  readonly leaseId: string;
  readonly leaseDigest: string;
  readonly missionDigest: string;
  readonly sessionId: string;
  readonly action: RemoteSteeringActionV3;
  readonly longrunText: string | null;
  readonly longrunSha256: string | null;
  readonly longrunLength: number | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signingKeyFingerprint: string;
}

export interface RemoteSteeringSignedLeaseV3 { readonly payload: RemoteSteeringLeaseV3; readonly signature: string; }
export interface RemoteSteeringSignedOperationV3 { readonly payload: RemoteSteeringOperationV3; readonly signature: string; }
export interface RemoteSteeringOperationEnvelopeV3 {
  readonly contract: typeof REMOTE_STEERING_ENVELOPE_CONTRACT_V3;
  readonly schemaVersion: typeof REMOTE_STEERING_SCHEMA_VERSION_V3;
  readonly verifierId: typeof REMOTE_STEERING_VERIFIER_ID_V3;
  readonly verifierContractVersion: typeof REMOTE_STEERING_VERIFIER_CONTRACT_VERSION_V3;
  readonly signingKeyFingerprint: string;
  readonly lease: RemoteSteeringSignedLeaseV3;
  readonly operation: RemoteSteeringSignedOperationV3;
}

const LEASE_KEYS = ['contract','schemaVersion','verifierId','verifierContractVersion','leaseId','missionId','missionDigest','sessionId','allowedActions','issuedAt','expiresAt','signingKeyFingerprint','operatorIntentDigest'] as const;
const OPERATION_KEYS = ['contract','schemaVersion','verifierId','verifierContractVersion','operationId','leaseId','leaseDigest','missionDigest','sessionId','action','longrunText','longrunSha256','longrunLength','issuedAt','expiresAt','signingKeyFingerprint'] as const;
const SIGNED_KEYS = ['payload','signature'] as const;
const ENVELOPE_KEYS = ['contract','schemaVersion','verifierId','verifierContractVersion','signingKeyFingerprint','lease','operation'] as const;

export const REMOTE_STEERING_LEASE_KEY_ORDER_V3: readonly string[] = LEASE_KEYS;
export const REMOTE_STEERING_OPERATION_KEY_ORDER_V3: readonly string[] = OPERATION_KEYS;
export const REMOTE_STEERING_ENVELOPE_KEY_ORDER_V3: readonly string[] = ENVELOPE_KEYS;

function isPlainObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value); if (actual.length !== keys.length) return false;
  const expected = new Set(keys); return actual.every(key => expected.has(key)) && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function canonicalJson(value: Record<string, unknown>, keys: readonly string[]): string {
  if (!hasExactKeys(value, keys)) throw new RemoteSteeringContractError('refusing to canonicalize a V3 record with an unexpected key set');
  return `{${keys.map(key => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`).join(',')}}`;
}
function isAction(value: unknown): value is RemoteSteeringActionV3 { return value === 'LONGRUN_START' || value === 'LOOP_OFF' || value === 'SESSION_STATUS'; }
function isSortedUniqueActions(value: unknown): value is readonly RemoteSteeringActionV3[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > REMOTE_STEERING_ACTIONS_V3.length) return false;
  let previous: string | null = null;
  for (const entry of value) {
    if (typeof entry !== 'string' || !isAction(entry) || (previous !== null && !(entry > previous))) return false;
    previous = entry;
  }
  return true;
}
function validLongrun(text: unknown, digest: unknown, length: unknown): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length <= REMOTE_STEERING_MAX_LONGRUN_BYTES_V3 && isRemoteSteeringDigest(digest) &&
    digest === remoteSteeringSha256(bytes) && typeof length === 'number' && Number.isSafeInteger(length) && length === bytes.length;
}

export function canonicalLeaseBytesV3(lease: RemoteSteeringLeaseV3): Buffer {
  return Buffer.from(`${REMOTE_STEERING_SIGNING_DOMAIN_V3}${REMOTE_STEERING_LEASE_CONTRACT_V3}\n${canonicalJson(lease as unknown as Record<string, unknown>, LEASE_KEYS)}`, 'utf8');
}
export function canonicalOperationBytesV3(operation: RemoteSteeringOperationV3): Buffer {
  return Buffer.from(`${REMOTE_STEERING_SIGNING_DOMAIN_V3}${REMOTE_STEERING_OPERATION_CONTRACT_V3}\n${canonicalJson(operation as unknown as Record<string, unknown>, OPERATION_KEYS)}`, 'utf8');
}
export function remoteSteeringLeaseDigestV3(lease: RemoteSteeringLeaseV3): string { return remoteSteeringSha256(canonicalLeaseBytesV3(lease)); }
export function remoteSteeringOperationDigestV3(operation: RemoteSteeringOperationV3): string { return remoteSteeringSha256(canonicalOperationBytesV3(operation)); }

export function validateRemoteSteeringLeaseV3(value: unknown): RemoteSteeringLeaseV3 | null {
  if (!isPlainObject(value) || !hasExactKeys(value, LEASE_KEYS)) return null;
  if (value.contract !== REMOTE_STEERING_LEASE_CONTRACT_V3 || value.schemaVersion !== 3 || value.verifierId !== REMOTE_STEERING_VERIFIER_ID_V3 ||
      value.verifierContractVersion !== 3 || !isRemoteSteeringId(value.leaseId) || !isRemoteSteeringIdentifier(value.missionId) ||
      !isRemoteSteeringDigest(value.missionDigest) || !isRemoteSteeringIdentifier(value.sessionId) || !isSortedUniqueActions(value.allowedActions) ||
      !isRemoteSteeringTimestamp(value.issuedAt) || !isRemoteSteeringTimestamp(value.expiresAt) || !isRemoteSteeringDigest(value.signingKeyFingerprint) ||
      !isRemoteSteeringDigest(value.operatorIntentDigest)) return null;
  const window = remoteSteeringWindowSeconds(value.issuedAt as string, value.expiresAt as string);
  return window > 0 && window <= REMOTE_STEERING_LEASE_MAX_TTL_SECONDS_V3 ? value as unknown as RemoteSteeringLeaseV3 : null;
}

export function validateRemoteSteeringOperationV3(value: unknown): RemoteSteeringOperationV3 | null {
  if (!isPlainObject(value) || !hasExactKeys(value, OPERATION_KEYS)) return null;
  if (value.contract !== REMOTE_STEERING_OPERATION_CONTRACT_V3 || value.schemaVersion !== 3 || value.verifierId !== REMOTE_STEERING_VERIFIER_ID_V3 ||
      value.verifierContractVersion !== 3 || !isRemoteSteeringId(value.operationId) || !isRemoteSteeringId(value.leaseId) ||
      !isRemoteSteeringDigest(value.leaseDigest) || !isRemoteSteeringDigest(value.missionDigest) || !isRemoteSteeringIdentifier(value.sessionId) ||
      !isAction(value.action) || !isRemoteSteeringTimestamp(value.issuedAt) || !isRemoteSteeringTimestamp(value.expiresAt) || !isRemoteSteeringDigest(value.signingKeyFingerprint)) return null;
  if (value.action === 'LONGRUN_START') {
    if (!validLongrun(value.longrunText, value.longrunSha256, value.longrunLength)) return null;
  } else if (value.longrunText !== null || value.longrunSha256 !== null || value.longrunLength !== null) return null;
  const window = remoteSteeringWindowSeconds(value.issuedAt as string, value.expiresAt as string);
  return window > 0 && window <= REMOTE_STEERING_OPERATION_MAX_TTL_SECONDS_V3 ? value as unknown as RemoteSteeringOperationV3 : null;
}

export function validateRemoteSteeringSignedLeaseV3(value: unknown): RemoteSteeringSignedLeaseV3 | null {
  if (!isPlainObject(value) || !hasExactKeys(value, SIGNED_KEYS)) return null;
  const payload = validateRemoteSteeringLeaseV3(value.payload); return payload && isRemoteSteeringSignature(value.signature) ? { payload, signature: value.signature } : null;
}
export function validateRemoteSteeringSignedOperationV3(value: unknown): RemoteSteeringSignedOperationV3 | null {
  if (!isPlainObject(value) || !hasExactKeys(value, SIGNED_KEYS)) return null;
  const payload = validateRemoteSteeringOperationV3(value.payload); return payload && isRemoteSteeringSignature(value.signature) ? { payload, signature: value.signature } : null;
}
export function remoteSteeringOperationLeaseMismatchV3(operation: RemoteSteeringOperationV3, lease: RemoteSteeringLeaseV3):
  'REMOTE_STEERING_LEASE_MALFORMED' | 'REMOTE_STEERING_ACTION_NOT_LEASED' | 'REMOTE_STEERING_OPERATION_WINDOW_EXCEEDS_LEASE' | null {
  if (operation.leaseId !== lease.leaseId || operation.leaseDigest !== remoteSteeringLeaseDigestV3(lease) || operation.missionDigest !== lease.missionDigest ||
      operation.sessionId !== lease.sessionId || operation.signingKeyFingerprint !== lease.signingKeyFingerprint) return 'REMOTE_STEERING_LEASE_MALFORMED';
  if (!lease.allowedActions.includes(operation.action)) return 'REMOTE_STEERING_ACTION_NOT_LEASED';
  if (Date.parse(operation.expiresAt) > Date.parse(lease.expiresAt) || Date.parse(operation.issuedAt) < Date.parse(lease.issuedAt)) return 'REMOTE_STEERING_OPERATION_WINDOW_EXCEEDS_LEASE';
  return null;
}
export function validateRemoteSteeringEnvelopeV3(value: unknown): RemoteSteeringOperationEnvelopeV3 | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ENVELOPE_KEYS)) return null;
  if (value.contract !== REMOTE_STEERING_ENVELOPE_CONTRACT_V3 || value.schemaVersion !== 3 || value.verifierId !== REMOTE_STEERING_VERIFIER_ID_V3 ||
      value.verifierContractVersion !== 3 || !isRemoteSteeringDigest(value.signingKeyFingerprint)) return null;
  const lease = validateRemoteSteeringSignedLeaseV3(value.lease); const operation = validateRemoteSteeringSignedOperationV3(value.operation);
  if (!lease || !operation || value.signingKeyFingerprint !== lease.payload.signingKeyFingerprint || value.signingKeyFingerprint !== operation.payload.signingKeyFingerprint ||
      remoteSteeringOperationLeaseMismatchV3(operation.payload, lease.payload) !== null) return null;
  return value as unknown as RemoteSteeringOperationEnvelopeV3;
}
