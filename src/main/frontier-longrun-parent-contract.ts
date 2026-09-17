/**
 * `cc_frontier_longrun_parent_operation_envelope_v1` — verifier mirror for a bounded
 * 72-hour Frontier Longrun parent grant.
 *
 * The parent grant authorizes at most eight CoS-owned slots. It never names a ChatGPT
 * conversation or local session. Mutating operations address only one slot and carry a
 * monotonically increasing supersession sequence; CoS owns the later slot -> local-session
 * binding after its native browser send is exactly acknowledged and recorded.
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

export const FRONTIER_LONGRUN_PARENT_GRANT_CONTRACT = 'cc_frontier_longrun_parent_grant_v1';
export const FRONTIER_LONGRUN_PARENT_OPERATION_CONTRACT = 'cc_frontier_longrun_parent_operation_v1';
export const FRONTIER_LONGRUN_PARENT_ENVELOPE_CONTRACT = 'cc_frontier_longrun_parent_operation_envelope_v1';
export const FRONTIER_LONGRUN_PARENT_SCHEMA_VERSION = 1;
export const FRONTIER_LONGRUN_PARENT_VERIFIER_ID = 'chat-on-steroids';
export const FRONTIER_LONGRUN_PARENT_VERIFIER_CONTRACT_VERSION = 1;
export const FRONTIER_LONGRUN_PARENT_SIGNING_DOMAIN = 'nexora.cc.frontier-longrun-parent.v1:';

export type FrontierLongrunParentAction = 'SESSION_CREATE' | 'LONGRUN_PROMPT' | 'LOOP_OFF' | 'SESSION_STATUS';
export const FRONTIER_LONGRUN_PARENT_ACTIONS: readonly FrontierLongrunParentAction[] = [
  'SESSION_CREATE', 'LONGRUN_PROMPT', 'LOOP_OFF', 'SESSION_STATUS'
];
export const FRONTIER_LONGRUN_PARENT_MAX_TTL_SECONDS = 259_200;
export const FRONTIER_LONGRUN_PARENT_OPERATION_MAX_TTL_SECONDS = 60;
export const FRONTIER_LONGRUN_PARENT_MAX_SLOTS = 8;
export const FRONTIER_LONGRUN_PARENT_MAX_TEXT_BYTES = 16_000;
export const FRONTIER_LONGRUN_PARENT_MODEL = 'gpt-6-pro';
export const FRONTIER_LONGRUN_PARENT_REASONING = 'pro' as const;

export interface FrontierLongrunParentGrantV1 {
  readonly contract: typeof FRONTIER_LONGRUN_PARENT_GRANT_CONTRACT;
  readonly schemaVersion: typeof FRONTIER_LONGRUN_PARENT_SCHEMA_VERSION;
  readonly verifierId: typeof FRONTIER_LONGRUN_PARENT_VERIFIER_ID;
  readonly verifierContractVersion: typeof FRONTIER_LONGRUN_PARENT_VERIFIER_CONTRACT_VERSION;
  readonly grantId: string;
  readonly missionId: string;
  readonly missionDigest: string;
  readonly maxSlots: typeof FRONTIER_LONGRUN_PARENT_MAX_SLOTS;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signingKeyFingerprint: string;
  readonly operatorIntentDigest: string;
}

export interface FrontierLongrunParentOperationV1 {
  readonly contract: typeof FRONTIER_LONGRUN_PARENT_OPERATION_CONTRACT;
  readonly schemaVersion: typeof FRONTIER_LONGRUN_PARENT_SCHEMA_VERSION;
  readonly verifierId: typeof FRONTIER_LONGRUN_PARENT_VERIFIER_ID;
  readonly verifierContractVersion: typeof FRONTIER_LONGRUN_PARENT_VERIFIER_CONTRACT_VERSION;
  readonly operationId: string;
  readonly grantId: string;
  readonly grantDigest: string;
  readonly missionDigest: string;
  readonly slot: number;
  readonly action: FrontierLongrunParentAction;
  /** Mutations use this as a supersession sequence. STATUS uses it as an after-sequence fence. */
  readonly mutationSeq: number;
  readonly inputId: string | null;
  readonly longrunText: string | null;
  readonly longrunSha256: string | null;
  readonly longrunLength: number | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signingKeyFingerprint: string;
}

export interface FrontierLongrunParentSignedGrantV1 {
  readonly payload: FrontierLongrunParentGrantV1;
  readonly signature: string;
}
export interface FrontierLongrunParentSignedOperationV1 {
  readonly payload: FrontierLongrunParentOperationV1;
  readonly signature: string;
}
export interface FrontierLongrunParentOperationEnvelopeV1 {
  readonly contract: typeof FRONTIER_LONGRUN_PARENT_ENVELOPE_CONTRACT;
  readonly schemaVersion: typeof FRONTIER_LONGRUN_PARENT_SCHEMA_VERSION;
  readonly verifierId: typeof FRONTIER_LONGRUN_PARENT_VERIFIER_ID;
  readonly verifierContractVersion: typeof FRONTIER_LONGRUN_PARENT_VERIFIER_CONTRACT_VERSION;
  readonly signingKeyFingerprint: string;
  readonly grant: FrontierLongrunParentSignedGrantV1;
  readonly operation: FrontierLongrunParentSignedOperationV1;
}

const GRANT_KEYS = [
  'contract', 'schemaVersion', 'verifierId', 'verifierContractVersion', 'grantId',
  'missionId', 'missionDigest', 'maxSlots', 'issuedAt', 'expiresAt',
  'signingKeyFingerprint', 'operatorIntentDigest'
] as const;
const OPERATION_KEYS = [
  'contract', 'schemaVersion', 'verifierId', 'verifierContractVersion', 'operationId',
  'grantId', 'grantDigest', 'missionDigest', 'slot', 'action', 'mutationSeq', 'inputId',
  'longrunText', 'longrunSha256', 'longrunLength', 'issuedAt', 'expiresAt',
  'signingKeyFingerprint'
] as const;
const SIGNED_KEYS = ['payload', 'signature'] as const;
const ENVELOPE_KEYS = [
  'contract', 'schemaVersion', 'verifierId', 'verifierContractVersion',
  'signingKeyFingerprint', 'grant', 'operation'
] as const;

export const FRONTIER_LONGRUN_PARENT_GRANT_KEY_ORDER: readonly string[] = GRANT_KEYS;
export const FRONTIER_LONGRUN_PARENT_OPERATION_KEY_ORDER: readonly string[] = OPERATION_KEYS;
export const FRONTIER_LONGRUN_PARENT_ENVELOPE_KEY_ORDER: readonly string[] = ENVELOPE_KEYS;

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
    throw new RemoteSteeringContractError('refusing to canonicalize a Frontier Longrun parent record with an unexpected key set');
  }
  return `{${keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`).join(',')}}`;
}

function isAction(value: unknown): value is FrontierLongrunParentAction {
  return value === 'SESSION_CREATE' || value === 'LONGRUN_PROMPT' || value === 'LOOP_OFF' || value === 'SESSION_STATUS';
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validContent(text: unknown, digest: unknown, length: unknown): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length <= FRONTIER_LONGRUN_PARENT_MAX_TEXT_BYTES && isRemoteSteeringDigest(digest) &&
    digest === remoteSteeringSha256(bytes) && typeof length === 'number' &&
    Number.isSafeInteger(length) && length === bytes.length;
}

export function canonicalFrontierLongrunParentGrantBytes(grant: FrontierLongrunParentGrantV1): Buffer {
  return Buffer.from(
    `${FRONTIER_LONGRUN_PARENT_SIGNING_DOMAIN}${FRONTIER_LONGRUN_PARENT_GRANT_CONTRACT}\n${canonicalJson(grant as unknown as Record<string, unknown>, GRANT_KEYS)}`,
    'utf8'
  );
}

export function canonicalFrontierLongrunParentOperationBytes(operation: FrontierLongrunParentOperationV1): Buffer {
  return Buffer.from(
    `${FRONTIER_LONGRUN_PARENT_SIGNING_DOMAIN}${FRONTIER_LONGRUN_PARENT_OPERATION_CONTRACT}\n${canonicalJson(operation as unknown as Record<string, unknown>, OPERATION_KEYS)}`,
    'utf8'
  );
}

export function frontierLongrunParentGrantDigest(grant: FrontierLongrunParentGrantV1): string {
  return remoteSteeringSha256(canonicalFrontierLongrunParentGrantBytes(grant));
}

export function frontierLongrunParentOperationDigest(operation: FrontierLongrunParentOperationV1): string {
  return remoteSteeringSha256(canonicalFrontierLongrunParentOperationBytes(operation));
}

export function validateFrontierLongrunParentGrant(value: unknown): FrontierLongrunParentGrantV1 | null {
  if (!isPlainObject(value) || !hasExactKeys(value, GRANT_KEYS)) return null;
  if (value['contract'] !== FRONTIER_LONGRUN_PARENT_GRANT_CONTRACT || value['schemaVersion'] !== 1 ||
      value['verifierId'] !== FRONTIER_LONGRUN_PARENT_VERIFIER_ID || value['verifierContractVersion'] !== 1 ||
      !isRemoteSteeringId(value['grantId']) || !isRemoteSteeringIdentifier(value['missionId']) ||
      !isRemoteSteeringDigest(value['missionDigest']) || value['maxSlots'] !== FRONTIER_LONGRUN_PARENT_MAX_SLOTS ||
      !isRemoteSteeringTimestamp(value['issuedAt']) || !isRemoteSteeringTimestamp(value['expiresAt']) ||
      !isRemoteSteeringDigest(value['signingKeyFingerprint']) || !isRemoteSteeringDigest(value['operatorIntentDigest'])) return null;
  const window = remoteSteeringWindowSeconds(value['issuedAt'] as string, value['expiresAt'] as string);
  return window > 0 && window <= FRONTIER_LONGRUN_PARENT_MAX_TTL_SECONDS
    ? value as unknown as FrontierLongrunParentGrantV1 : null;
}

export function validateFrontierLongrunParentOperation(value: unknown): FrontierLongrunParentOperationV1 | null {
  if (!isPlainObject(value) || !hasExactKeys(value, OPERATION_KEYS)) return null;
  if (value['contract'] !== FRONTIER_LONGRUN_PARENT_OPERATION_CONTRACT || value['schemaVersion'] !== 1 ||
      value['verifierId'] !== FRONTIER_LONGRUN_PARENT_VERIFIER_ID || value['verifierContractVersion'] !== 1 ||
      !isRemoteSteeringId(value['operationId']) || !isRemoteSteeringId(value['grantId']) ||
      !isRemoteSteeringDigest(value['grantDigest']) || !isRemoteSteeringDigest(value['missionDigest']) ||
      typeof value['slot'] !== 'number' || !Number.isSafeInteger(value['slot']) || value['slot'] < 1 || value['slot'] > FRONTIER_LONGRUN_PARENT_MAX_SLOTS ||
      !isAction(value['action']) || typeof value['mutationSeq'] !== 'number' || !Number.isSafeInteger(value['mutationSeq']) || value['mutationSeq'] <= 0 ||
      !isRemoteSteeringTimestamp(value['issuedAt']) || !isRemoteSteeringTimestamp(value['expiresAt']) ||
      !isRemoteSteeringDigest(value['signingKeyFingerprint'])) return null;

  if (value['action'] === 'SESSION_CREATE' || value['action'] === 'LONGRUN_PROMPT') {
    if (!isUuid(value['inputId']) || !validContent(value['longrunText'], value['longrunSha256'], value['longrunLength'])) return null;
  } else if (value['inputId'] !== null || value['longrunText'] !== null || value['longrunSha256'] !== null || value['longrunLength'] !== null) {
    return null;
  }
  const window = remoteSteeringWindowSeconds(value['issuedAt'] as string, value['expiresAt'] as string);
  return window > 0 && window <= FRONTIER_LONGRUN_PARENT_OPERATION_MAX_TTL_SECONDS
    ? value as unknown as FrontierLongrunParentOperationV1 : null;
}

export function validateFrontierLongrunParentSignedGrant(value: unknown): FrontierLongrunParentSignedGrantV1 | null {
  if (!isPlainObject(value) || !hasExactKeys(value, SIGNED_KEYS)) return null;
  const payload = validateFrontierLongrunParentGrant(value['payload']);
  return payload && isRemoteSteeringSignature(value['signature'])
    ? { payload, signature: value['signature'] } : null;
}

export function validateFrontierLongrunParentSignedOperation(value: unknown): FrontierLongrunParentSignedOperationV1 | null {
  if (!isPlainObject(value) || !hasExactKeys(value, SIGNED_KEYS)) return null;
  const payload = validateFrontierLongrunParentOperation(value['payload']);
  return payload && isRemoteSteeringSignature(value['signature'])
    ? { payload, signature: value['signature'] } : null;
}

export function frontierLongrunParentOperationGrantMismatch(
  operation: FrontierLongrunParentOperationV1,
  grant: FrontierLongrunParentGrantV1
): 'FRONTIER_LONGRUN_PARENT_GRANT_MALFORMED' | 'FRONTIER_LONGRUN_PARENT_OPERATION_WINDOW_EXCEEDS_GRANT' | null {
  if (operation.grantId !== grant.grantId || operation.grantDigest !== frontierLongrunParentGrantDigest(grant) ||
      operation.missionDigest !== grant.missionDigest || operation.signingKeyFingerprint !== grant.signingKeyFingerprint ||
      operation.slot > grant.maxSlots) return 'FRONTIER_LONGRUN_PARENT_GRANT_MALFORMED';
  if (Date.parse(operation.expiresAt) > Date.parse(grant.expiresAt) || Date.parse(operation.issuedAt) < Date.parse(grant.issuedAt)) {
    return 'FRONTIER_LONGRUN_PARENT_OPERATION_WINDOW_EXCEEDS_GRANT';
  }
  return null;
}

export function validateFrontierLongrunParentEnvelope(value: unknown): FrontierLongrunParentOperationEnvelopeV1 | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ENVELOPE_KEYS)) return null;
  if (value['contract'] !== FRONTIER_LONGRUN_PARENT_ENVELOPE_CONTRACT || value['schemaVersion'] !== 1 ||
      value['verifierId'] !== FRONTIER_LONGRUN_PARENT_VERIFIER_ID || value['verifierContractVersion'] !== 1 ||
      !isRemoteSteeringDigest(value['signingKeyFingerprint'])) return null;
  const grant = validateFrontierLongrunParentSignedGrant(value['grant']);
  const operation = validateFrontierLongrunParentSignedOperation(value['operation']);
  if (!grant || !operation || value['signingKeyFingerprint'] !== grant.payload.signingKeyFingerprint ||
      value['signingKeyFingerprint'] !== operation.payload.signingKeyFingerprint ||
      frontierLongrunParentOperationGrantMismatch(operation.payload, grant.payload) !== null) return null;
  return value as unknown as FrontierLongrunParentOperationEnvelopeV1;
}
