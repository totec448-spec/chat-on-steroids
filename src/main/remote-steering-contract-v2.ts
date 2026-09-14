/**
 * `cc_remote_steering_operation_envelope_v2` — verifier mirror for bounded remote SPAWN.
 *
 * V1 remains frozen in remote-steering-contract.ts. V2 is deliberately a distinct protocol:
 * different contract literals, schema/verifier version and signing domain. An old V1 signature
 * therefore cannot acquire SPAWN authority just because this build understands V2.
 *
 * V2 adds exactly one action: SPAWN one exact future worker id with one exact signed task. It
 * carries no model/reasoning override and creates no caller identity. All ordinary `agents`
 * identity rules remain outside this module and unchanged.
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

export const REMOTE_STEERING_LEASE_CONTRACT_V2 = 'cc_remote_steering_lease_v2';
export const REMOTE_STEERING_OPERATION_CONTRACT_V2 = 'cc_remote_steering_operation_v2';
export const REMOTE_STEERING_ENVELOPE_CONTRACT_V2 = 'cc_remote_steering_operation_envelope_v2';
export const REMOTE_STEERING_SCHEMA_VERSION_V2 = 2;
export const REMOTE_STEERING_VERIFIER_ID_V2 = 'chat-on-steroids';
export const REMOTE_STEERING_VERIFIER_CONTRACT_VERSION_V2 = 2;
export const REMOTE_STEERING_SIGNING_DOMAIN_V2 = 'nexora.cc.remote-steering.v2:';

export type RemoteSteeringActionV2 = 'MESSAGE' | 'SPAWN' | 'STATUS';
export const REMOTE_STEERING_ACTIONS_V2: readonly RemoteSteeringActionV2[] = ['MESSAGE', 'SPAWN', 'STATUS'];
export const REMOTE_STEERING_LEASE_MAX_TTL_SECONDS_V2 = 28_800;
export const REMOTE_STEERING_OPERATION_MAX_TTL_SECONDS_V2 = 300;
export const REMOTE_STEERING_MAX_WORKERS_V2 = 16;
export const REMOTE_STEERING_MAX_MESSAGE_BYTES_V2 = 4_000;
export const REMOTE_STEERING_MAX_SPAWN_TASK_BYTES_V2 = 4_000;

export interface RemoteSteeringLeaseV2 {
  readonly contract: typeof REMOTE_STEERING_LEASE_CONTRACT_V2;
  readonly schemaVersion: typeof REMOTE_STEERING_SCHEMA_VERSION_V2;
  readonly verifierId: typeof REMOTE_STEERING_VERIFIER_ID_V2;
  readonly verifierContractVersion: typeof REMOTE_STEERING_VERIFIER_CONTRACT_VERSION_V2;
  readonly leaseId: string;
  readonly missionId: string;
  readonly missionDigest: string;
  readonly runId: string;
  readonly workerAllowlist: readonly string[];
  readonly allowedActions: readonly RemoteSteeringActionV2[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signingKeyFingerprint: string;
  readonly operatorIntentDigest: string;
}

export interface RemoteSteeringOperationV2 {
  readonly contract: typeof REMOTE_STEERING_OPERATION_CONTRACT_V2;
  readonly schemaVersion: typeof REMOTE_STEERING_SCHEMA_VERSION_V2;
  readonly verifierId: typeof REMOTE_STEERING_VERIFIER_ID_V2;
  readonly verifierContractVersion: typeof REMOTE_STEERING_VERIFIER_CONTRACT_VERSION_V2;
  readonly operationId: string;
  readonly leaseId: string;
  readonly leaseDigest: string;
  readonly missionDigest: string;
  readonly runId: string;
  readonly action: RemoteSteeringActionV2;
  readonly targetWorkerId: string | null;
  readonly messageText: string | null;
  readonly messageSha256: string | null;
  readonly messageLength: number | null;
  readonly spawnTaskText: string | null;
  readonly spawnTaskSha256: string | null;
  readonly spawnTaskLength: number | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signingKeyFingerprint: string;
}

export interface RemoteSteeringSignedLeaseV2 {
  readonly payload: RemoteSteeringLeaseV2;
  readonly signature: string;
}

export interface RemoteSteeringSignedOperationV2 {
  readonly payload: RemoteSteeringOperationV2;
  readonly signature: string;
}

export interface RemoteSteeringOperationEnvelopeV2 {
  readonly contract: typeof REMOTE_STEERING_ENVELOPE_CONTRACT_V2;
  readonly schemaVersion: typeof REMOTE_STEERING_SCHEMA_VERSION_V2;
  readonly verifierId: typeof REMOTE_STEERING_VERIFIER_ID_V2;
  readonly verifierContractVersion: typeof REMOTE_STEERING_VERIFIER_CONTRACT_VERSION_V2;
  readonly signingKeyFingerprint: string;
  readonly lease: RemoteSteeringSignedLeaseV2;
  readonly operation: RemoteSteeringSignedOperationV2;
}

const LEASE_KEYS_V2 = [
  'contract', 'schemaVersion', 'verifierId', 'verifierContractVersion', 'leaseId',
  'missionId', 'missionDigest', 'runId', 'workerAllowlist', 'allowedActions',
  'issuedAt', 'expiresAt', 'signingKeyFingerprint', 'operatorIntentDigest'
] as const;

const OPERATION_KEYS_V2 = [
  'contract', 'schemaVersion', 'verifierId', 'verifierContractVersion', 'operationId',
  'leaseId', 'leaseDigest', 'missionDigest', 'runId', 'action', 'targetWorkerId',
  'messageText', 'messageSha256', 'messageLength', 'spawnTaskText', 'spawnTaskSha256',
  'spawnTaskLength', 'issuedAt', 'expiresAt', 'signingKeyFingerprint'
] as const;

const SIGNED_KEYS = ['payload', 'signature'] as const;
const ENVELOPE_KEYS = [
  'contract', 'schemaVersion', 'verifierId', 'verifierContractVersion',
  'signingKeyFingerprint', 'lease', 'operation'
] as const;

export const REMOTE_STEERING_LEASE_KEY_ORDER_V2: readonly string[] = LEASE_KEYS_V2;
export const REMOTE_STEERING_OPERATION_KEY_ORDER_V2: readonly string[] = OPERATION_KEYS_V2;
export const REMOTE_STEERING_ENVELOPE_KEY_ORDER_V2: readonly string[] = ENVELOPE_KEYS;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  if (actual.length !== keys.length) return false;
  const expected = new Set(keys);
  return actual.every((key) => expected.has(key)) && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function canonicalJson(value: Record<string, unknown>, keys: readonly string[]): string {
  if (!hasExactKeys(value, keys)) {
    throw new RemoteSteeringContractError('refusing to canonicalize a V2 record with an unexpected key set');
  }
  return `{${keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`).join(',')}}`;
}

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

function isActionV2(value: unknown): value is RemoteSteeringActionV2 {
  return value === 'MESSAGE' || value === 'SPAWN' || value === 'STATUS';
}

function validContentTriplet(text: unknown, digest: unknown, length: unknown, maxBytes: number): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length <= maxBytes && isRemoteSteeringDigest(digest) &&
    digest === remoteSteeringSha256(bytes) && typeof length === 'number' &&
    Number.isSafeInteger(length) && length === bytes.length;
}

export function canonicalLeaseBytesV2(lease: RemoteSteeringLeaseV2): Buffer {
  return Buffer.from(
    `${REMOTE_STEERING_SIGNING_DOMAIN_V2}${REMOTE_STEERING_LEASE_CONTRACT_V2}\n${canonicalJson(lease as unknown as Record<string, unknown>, LEASE_KEYS_V2)}`,
    'utf8'
  );
}

export function canonicalOperationBytesV2(operation: RemoteSteeringOperationV2): Buffer {
  return Buffer.from(
    `${REMOTE_STEERING_SIGNING_DOMAIN_V2}${REMOTE_STEERING_OPERATION_CONTRACT_V2}\n${canonicalJson(operation as unknown as Record<string, unknown>, OPERATION_KEYS_V2)}`,
    'utf8'
  );
}

export function remoteSteeringLeaseDigestV2(lease: RemoteSteeringLeaseV2): string {
  return remoteSteeringSha256(canonicalLeaseBytesV2(lease));
}

export function remoteSteeringOperationDigestV2(operation: RemoteSteeringOperationV2): string {
  return remoteSteeringSha256(canonicalOperationBytesV2(operation));
}

export function validateRemoteSteeringLeaseV2(value: unknown): RemoteSteeringLeaseV2 | null {
  if (!isPlainObject(value) || !hasExactKeys(value, LEASE_KEYS_V2)) return null;
  if (value['contract'] !== REMOTE_STEERING_LEASE_CONTRACT_V2 || value['schemaVersion'] !== 2 ||
      value['verifierId'] !== REMOTE_STEERING_VERIFIER_ID_V2 || value['verifierContractVersion'] !== 2 ||
      !isRemoteSteeringId(value['leaseId']) || !isRemoteSteeringIdentifier(value['missionId']) ||
      !isRemoteSteeringDigest(value['missionDigest']) || !isRemoteSteeringIdentifier(value['runId'])) return null;
  const workers = value['workerAllowlist'];
  if (!isSortedUniqueList(workers, REMOTE_STEERING_MAX_WORKERS_V2) || !workers.every(isRemoteSteeringIdentifier)) return null;
  const actions = value['allowedActions'];
  if (!isSortedUniqueList(actions, REMOTE_STEERING_ACTIONS_V2.length) || !actions.every(isActionV2)) return null;
  if (!isRemoteSteeringTimestamp(value['issuedAt']) || !isRemoteSteeringTimestamp(value['expiresAt'])) return null;
  const window = remoteSteeringWindowSeconds(value['issuedAt'] as string, value['expiresAt'] as string);
  if (!(window > 0) || window > REMOTE_STEERING_LEASE_MAX_TTL_SECONDS_V2 ||
      !isRemoteSteeringDigest(value['signingKeyFingerprint']) || !isRemoteSteeringDigest(value['operatorIntentDigest'])) return null;
  return value as unknown as RemoteSteeringLeaseV2;
}

export function validateRemoteSteeringOperationV2(value: unknown): RemoteSteeringOperationV2 | null {
  if (!isPlainObject(value) || !hasExactKeys(value, OPERATION_KEYS_V2)) return null;
  if (value['contract'] !== REMOTE_STEERING_OPERATION_CONTRACT_V2 || value['schemaVersion'] !== 2 ||
      value['verifierId'] !== REMOTE_STEERING_VERIFIER_ID_V2 || value['verifierContractVersion'] !== 2 ||
      !isRemoteSteeringId(value['operationId']) || !isRemoteSteeringId(value['leaseId']) ||
      !isRemoteSteeringDigest(value['leaseDigest']) || !isRemoteSteeringDigest(value['missionDigest']) ||
      !isRemoteSteeringIdentifier(value['runId']) || !isActionV2(value['action'])) return null;
  const action = value['action'] as RemoteSteeringActionV2;
  const target = value['targetWorkerId'];
  if (action === 'MESSAGE') {
    if (!isRemoteSteeringIdentifier(target) || !validContentTriplet(value['messageText'], value['messageSha256'], value['messageLength'], REMOTE_STEERING_MAX_MESSAGE_BYTES_V2) ||
        value['spawnTaskText'] !== null || value['spawnTaskSha256'] !== null || value['spawnTaskLength'] !== null) return null;
  } else if (action === 'SPAWN') {
    if (!isRemoteSteeringIdentifier(target) || !validContentTriplet(value['spawnTaskText'], value['spawnTaskSha256'], value['spawnTaskLength'], REMOTE_STEERING_MAX_SPAWN_TASK_BYTES_V2) ||
        value['messageText'] !== null || value['messageSha256'] !== null || value['messageLength'] !== null) return null;
  } else if (target !== null || value['messageText'] !== null || value['messageSha256'] !== null || value['messageLength'] !== null ||
             value['spawnTaskText'] !== null || value['spawnTaskSha256'] !== null || value['spawnTaskLength'] !== null) {
    return null;
  }
  if (!isRemoteSteeringTimestamp(value['issuedAt']) || !isRemoteSteeringTimestamp(value['expiresAt'])) return null;
  const window = remoteSteeringWindowSeconds(value['issuedAt'] as string, value['expiresAt'] as string);
  if (!(window > 0) || window > REMOTE_STEERING_OPERATION_MAX_TTL_SECONDS_V2 || !isRemoteSteeringDigest(value['signingKeyFingerprint'])) return null;
  return value as unknown as RemoteSteeringOperationV2;
}

export function validateRemoteSteeringSignedLeaseV2(value: unknown): RemoteSteeringSignedLeaseV2 | null {
  if (!isPlainObject(value) || !hasExactKeys(value, SIGNED_KEYS)) return null;
  const payload = validateRemoteSteeringLeaseV2(value['payload']);
  if (!payload || !isRemoteSteeringSignature(value['signature'])) return null;
  return { payload, signature: value['signature'] };
}

export function validateRemoteSteeringSignedOperationV2(value: unknown): RemoteSteeringSignedOperationV2 | null {
  if (!isPlainObject(value) || !hasExactKeys(value, SIGNED_KEYS)) return null;
  const payload = validateRemoteSteeringOperationV2(value['payload']);
  if (!payload || !isRemoteSteeringSignature(value['signature'])) return null;
  return { payload, signature: value['signature'] };
}

export function remoteSteeringOperationLeaseMismatchV2(
  operation: RemoteSteeringOperationV2,
  lease: RemoteSteeringLeaseV2
): 'REMOTE_STEERING_LEASE_MALFORMED' | 'REMOTE_STEERING_ACTION_NOT_LEASED' |
  'REMOTE_STEERING_WORKER_NOT_ALLOWLISTED' | 'REMOTE_STEERING_OPERATION_WINDOW_EXCEEDS_LEASE' | null {
  if (operation.leaseId !== lease.leaseId || operation.leaseDigest !== remoteSteeringLeaseDigestV2(lease) ||
      operation.missionDigest !== lease.missionDigest || operation.runId !== lease.runId ||
      operation.signingKeyFingerprint !== lease.signingKeyFingerprint) return 'REMOTE_STEERING_LEASE_MALFORMED';
  if (!lease.allowedActions.includes(operation.action)) return 'REMOTE_STEERING_ACTION_NOT_LEASED';
  if ((operation.action === 'MESSAGE' || operation.action === 'SPAWN') &&
      (operation.targetWorkerId === null || !lease.workerAllowlist.includes(operation.targetWorkerId))) {
    return 'REMOTE_STEERING_WORKER_NOT_ALLOWLISTED';
  }
  if (Date.parse(operation.expiresAt) > Date.parse(lease.expiresAt) ||
      Date.parse(operation.issuedAt) < Date.parse(lease.issuedAt)) return 'REMOTE_STEERING_OPERATION_WINDOW_EXCEEDS_LEASE';
  return null;
}

export function validateRemoteSteeringEnvelopeV2(value: unknown): RemoteSteeringOperationEnvelopeV2 | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ENVELOPE_KEYS)) return null;
  if (value['contract'] !== REMOTE_STEERING_ENVELOPE_CONTRACT_V2 || value['schemaVersion'] !== 2 ||
      value['verifierId'] !== REMOTE_STEERING_VERIFIER_ID_V2 || value['verifierContractVersion'] !== 2 ||
      !isRemoteSteeringDigest(value['signingKeyFingerprint'])) return null;
  const lease = validateRemoteSteeringSignedLeaseV2(value['lease']);
  const operation = validateRemoteSteeringSignedOperationV2(value['operation']);
  if (!lease || !operation || value['signingKeyFingerprint'] !== lease.payload.signingKeyFingerprint ||
      value['signingKeyFingerprint'] !== operation.payload.signingKeyFingerprint ||
      remoteSteeringOperationLeaseMismatchV2(operation.payload, lease.payload) !== null) return null;
  return value as unknown as RemoteSteeringOperationEnvelopeV2;
}
