/** Exact CoS verifier mirror for CC `frontier_manual_session` V1 signed bytes. */
import {
  RemoteSteeringContractError,
  isRemoteSteeringDigest,
  isRemoteSteeringId,
  isRemoteSteeringSignature,
  isRemoteSteeringTimestamp,
  remoteSteeringSha256,
  remoteSteeringWindowSeconds,
} from './remote-steering-contract.js';

export const FRONTIER_MANUAL_SESSION_GRANT_CONTRACT = 'cc_frontier_manual_session_grant_v1';
export const FRONTIER_MANUAL_SESSION_OPERATION_CONTRACT = 'cc_frontier_manual_session_operation_v1';
export const FRONTIER_MANUAL_SESSION_ENVELOPE_CONTRACT = 'cc_frontier_manual_session_operation_envelope_v1';
export const FRONTIER_MANUAL_SESSION_SCHEMA_VERSION = 1;
export const FRONTIER_MANUAL_SESSION_VERIFIER_ID = 'chat-on-steroids';
export const FRONTIER_MANUAL_SESSION_VERIFIER_CONTRACT_VERSION = 1;
export const FRONTIER_MANUAL_SESSION_SIGNING_DOMAIN = 'nexora.cc.frontier-manual-session.v1:';
export const FRONTIER_MANUAL_SESSION_PROJECT_BINDING_DOMAIN = 'nexora.cc.frontier-manual-session.project-binding.v1:';

export type FrontierManualSessionScope = 'command_center' | 'nkb' | 'vyper';
export type FrontierManualSessionAction = 'SESSION_CREATE' | 'SESSION_PROMPT' | 'SESSION_STATUS';
export const FRONTIER_MANUAL_SESSION_ACTIONS: readonly FrontierManualSessionAction[] = [
  'SESSION_CREATE', 'SESSION_PROMPT', 'SESSION_STATUS'
];
export const FRONTIER_MANUAL_SESSION_MAX_TTL_SECONDS = 259_200;
export const FRONTIER_MANUAL_SESSION_OPERATION_MAX_TTL_SECONDS = 60;
export const FRONTIER_MANUAL_SESSION_MAX_TEXT_BYTES = 16_000;
export const FRONTIER_MANUAL_SESSION_MAX_TEXT_CLAIMS = 64;
export const FRONTIER_MANUAL_SESSION_MODEL = 'gpt-5-6-thinking';
export const FRONTIER_MANUAL_SESSION_REASONING = 'xhigh' as const;
export const FRONTIER_MANUAL_SESSION_AUTOMATION = false as const;

export interface FrontierManualSessionGrantV1 {
  readonly contract: typeof FRONTIER_MANUAL_SESSION_GRANT_CONTRACT;
  readonly schemaVersion: typeof FRONTIER_MANUAL_SESSION_SCHEMA_VERSION;
  readonly verifierId: typeof FRONTIER_MANUAL_SESSION_VERIFIER_ID;
  readonly verifierContractVersion: typeof FRONTIER_MANUAL_SESSION_VERIFIER_CONTRACT_VERSION;
  readonly grantId: string;
  readonly travelParentId: string;
  readonly travelParentDigest: string;
  readonly scope: FrontierManualSessionScope;
  readonly projectBindingDigest: string;
  readonly allowedActions: readonly FrontierManualSessionAction[];
  readonly maxTextClaims: typeof FRONTIER_MANUAL_SESSION_MAX_TEXT_CLAIMS;
  readonly model: typeof FRONTIER_MANUAL_SESSION_MODEL;
  readonly reasoning: typeof FRONTIER_MANUAL_SESSION_REASONING;
  readonly automation: typeof FRONTIER_MANUAL_SESSION_AUTOMATION;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signingKeyFingerprint: string;
}

export interface FrontierManualSessionOperationV1 {
  readonly contract: typeof FRONTIER_MANUAL_SESSION_OPERATION_CONTRACT;
  readonly schemaVersion: typeof FRONTIER_MANUAL_SESSION_SCHEMA_VERSION;
  readonly verifierId: typeof FRONTIER_MANUAL_SESSION_VERIFIER_ID;
  readonly verifierContractVersion: typeof FRONTIER_MANUAL_SESSION_VERIFIER_CONTRACT_VERSION;
  readonly operationId: string;
  readonly grantId: string;
  readonly grantDigest: string;
  readonly projectBindingDigest: string;
  readonly action: FrontierManualSessionAction;
  readonly mutationSeq: number;
  readonly inputId: string | null;
  readonly taskText: string | null;
  readonly taskSha256: string | null;
  readonly taskLength: number | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signingKeyFingerprint: string;
}

export interface FrontierManualSessionSignedGrantV1 { readonly payload: FrontierManualSessionGrantV1; readonly signature: string; }
export interface FrontierManualSessionSignedOperationV1 { readonly payload: FrontierManualSessionOperationV1; readonly signature: string; }
export interface FrontierManualSessionOperationEnvelopeV1 {
  readonly contract: typeof FRONTIER_MANUAL_SESSION_ENVELOPE_CONTRACT;
  readonly schemaVersion: typeof FRONTIER_MANUAL_SESSION_SCHEMA_VERSION;
  readonly verifierId: typeof FRONTIER_MANUAL_SESSION_VERIFIER_ID;
  readonly verifierContractVersion: typeof FRONTIER_MANUAL_SESSION_VERIFIER_CONTRACT_VERSION;
  readonly signingKeyFingerprint: string;
  readonly grant: FrontierManualSessionSignedGrantV1;
  readonly operation: FrontierManualSessionSignedOperationV1;
}

const GRANT_KEYS = [
  'contract','schemaVersion','verifierId','verifierContractVersion','grantId','travelParentId','travelParentDigest','scope',
  'projectBindingDigest','allowedActions','maxTextClaims','model','reasoning','automation','issuedAt','expiresAt','signingKeyFingerprint'
] as const;
const OPERATION_KEYS = [
  'contract','schemaVersion','verifierId','verifierContractVersion','operationId','grantId','grantDigest','projectBindingDigest','action',
  'mutationSeq','inputId','taskText','taskSha256','taskLength','issuedAt','expiresAt','signingKeyFingerprint'
] as const;
const SIGNED_KEYS = ['payload','signature'] as const;
const ENVELOPE_KEYS = ['contract','schemaVersion','verifierId','verifierContractVersion','signingKeyFingerprint','grant','operation'] as const;

export const FRONTIER_MANUAL_SESSION_GRANT_KEY_ORDER: readonly string[] = GRANT_KEYS;
export const FRONTIER_MANUAL_SESSION_OPERATION_KEY_ORDER: readonly string[] = OPERATION_KEYS;
export const FRONTIER_MANUAL_SESSION_ENVELOPE_KEY_ORDER: readonly string[] = ENVELOPE_KEYS;

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value); const expected = new Set(keys);
  return actual.length === keys.length && actual.every(key => expected.has(key)) && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function canonicalJson(value: Record<string, unknown>, keys: readonly string[]): string {
  if (!exactKeys(value, keys)) throw new RemoteSteeringContractError('refusing to canonicalize a Frontier manual-session record with an unexpected key set');
  return `{${keys.map(key => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`).join(',')}}`;
}
function isScope(value: unknown): value is FrontierManualSessionScope { return value === 'command_center' || value === 'nkb' || value === 'vyper'; }
function isAction(value: unknown): value is FrontierManualSessionAction { return value === 'SESSION_CREATE' || value === 'SESSION_PROMPT' || value === 'SESSION_STATUS'; }
function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function validTask(text: unknown, digest: unknown, length: unknown): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length <= FRONTIER_MANUAL_SESSION_MAX_TEXT_BYTES && isRemoteSteeringDigest(digest) && digest === remoteSteeringSha256(bytes) &&
    typeof length === 'number' && Number.isSafeInteger(length) && length === bytes.length;
}

export function frontierManualSessionProjectBindingDigest(scope: FrontierManualSessionScope): string {
  return remoteSteeringSha256(Buffer.from(`${FRONTIER_MANUAL_SESSION_PROJECT_BINDING_DOMAIN}${scope}`, 'utf8'));
}
export function canonicalFrontierManualSessionGrantBytes(grant: FrontierManualSessionGrantV1): Buffer {
  return Buffer.from(`${FRONTIER_MANUAL_SESSION_SIGNING_DOMAIN}${FRONTIER_MANUAL_SESSION_GRANT_CONTRACT}\n${canonicalJson(grant as unknown as Record<string, unknown>, GRANT_KEYS)}`, 'utf8');
}
export function canonicalFrontierManualSessionOperationBytes(operation: FrontierManualSessionOperationV1): Buffer {
  return Buffer.from(`${FRONTIER_MANUAL_SESSION_SIGNING_DOMAIN}${FRONTIER_MANUAL_SESSION_OPERATION_CONTRACT}\n${canonicalJson(operation as unknown as Record<string, unknown>, OPERATION_KEYS)}`, 'utf8');
}
export function frontierManualSessionGrantDigest(grant: FrontierManualSessionGrantV1): string { return remoteSteeringSha256(canonicalFrontierManualSessionGrantBytes(grant)); }
export function frontierManualSessionOperationDigest(operation: FrontierManualSessionOperationV1): string { return remoteSteeringSha256(canonicalFrontierManualSessionOperationBytes(operation)); }

export function validateFrontierManualSessionGrant(value: unknown): FrontierManualSessionGrantV1 | null {
  if (!object(value) || !exactKeys(value, GRANT_KEYS)) return null;
  if (value.contract !== FRONTIER_MANUAL_SESSION_GRANT_CONTRACT || value.schemaVersion !== 1 || value.verifierId !== FRONTIER_MANUAL_SESSION_VERIFIER_ID ||
      value.verifierContractVersion !== FRONTIER_MANUAL_SESSION_VERIFIER_CONTRACT_VERSION || !isRemoteSteeringId(value.grantId) ||
      !isRemoteSteeringId(value.travelParentId) || !isRemoteSteeringDigest(value.travelParentDigest) || !isScope(value.scope) ||
      !isRemoteSteeringDigest(value.projectBindingDigest) || value.projectBindingDigest !== frontierManualSessionProjectBindingDigest(value.scope) ||
      !Array.isArray(value.allowedActions) || value.allowedActions.length !== FRONTIER_MANUAL_SESSION_ACTIONS.length ||
      value.allowedActions.some((action, i) => action !== FRONTIER_MANUAL_SESSION_ACTIONS[i]) || value.maxTextClaims !== FRONTIER_MANUAL_SESSION_MAX_TEXT_CLAIMS ||
      value.model !== FRONTIER_MANUAL_SESSION_MODEL || value.reasoning !== FRONTIER_MANUAL_SESSION_REASONING || value.automation !== false ||
      !isRemoteSteeringTimestamp(value.issuedAt) || !isRemoteSteeringTimestamp(value.expiresAt) || !isRemoteSteeringDigest(value.signingKeyFingerprint)) return null;
  const window = remoteSteeringWindowSeconds(value.issuedAt as string, value.expiresAt as string);
  return window > 0 && window <= FRONTIER_MANUAL_SESSION_MAX_TTL_SECONDS ? value as unknown as FrontierManualSessionGrantV1 : null;
}

export function validateFrontierManualSessionOperation(value: unknown): FrontierManualSessionOperationV1 | null {
  if (!object(value) || !exactKeys(value, OPERATION_KEYS)) return null;
  if (value.contract !== FRONTIER_MANUAL_SESSION_OPERATION_CONTRACT || value.schemaVersion !== 1 || value.verifierId !== FRONTIER_MANUAL_SESSION_VERIFIER_ID ||
      value.verifierContractVersion !== FRONTIER_MANUAL_SESSION_VERIFIER_CONTRACT_VERSION || !isRemoteSteeringId(value.operationId) || !isRemoteSteeringId(value.grantId) ||
      !isRemoteSteeringDigest(value.grantDigest) || !isRemoteSteeringDigest(value.projectBindingDigest) || !isAction(value.action) ||
      typeof value.mutationSeq !== 'number' || !Number.isSafeInteger(value.mutationSeq) || value.mutationSeq < 1 ||
      !isRemoteSteeringTimestamp(value.issuedAt) || !isRemoteSteeringTimestamp(value.expiresAt) || !isRemoteSteeringDigest(value.signingKeyFingerprint)) return null;
  if (value.action === 'SESSION_CREATE' || value.action === 'SESSION_PROMPT') {
    if (!isUuid(value.inputId) || !validTask(value.taskText, value.taskSha256, value.taskLength)) return null;
  } else if (value.inputId !== null || value.taskText !== null || value.taskSha256 !== null || value.taskLength !== null) return null;
  const window = remoteSteeringWindowSeconds(value.issuedAt as string, value.expiresAt as string);
  return window > 0 && window <= FRONTIER_MANUAL_SESSION_OPERATION_MAX_TTL_SECONDS ? value as unknown as FrontierManualSessionOperationV1 : null;
}
export function validateFrontierManualSessionSignedGrant(value: unknown): FrontierManualSessionSignedGrantV1 | null {
  if (!object(value) || !exactKeys(value, SIGNED_KEYS)) return null;
  const payload = validateFrontierManualSessionGrant(value.payload);
  return payload && isRemoteSteeringSignature(value.signature) ? { payload, signature: value.signature } : null;
}
export function validateFrontierManualSessionSignedOperation(value: unknown): FrontierManualSessionSignedOperationV1 | null {
  if (!object(value) || !exactKeys(value, SIGNED_KEYS)) return null;
  const payload = validateFrontierManualSessionOperation(value.payload);
  return payload && isRemoteSteeringSignature(value.signature) ? { payload, signature: value.signature } : null;
}
export function frontierManualSessionOperationGrantMismatch(operation: FrontierManualSessionOperationV1, grant: FrontierManualSessionGrantV1): 'FRONTIER_MANUAL_SESSION_MALFORMED' | 'FRONTIER_MANUAL_SESSION_EXPIRED' | null {
  if (operation.grantId !== grant.grantId || operation.grantDigest !== frontierManualSessionGrantDigest(grant) || operation.projectBindingDigest !== grant.projectBindingDigest ||
      operation.signingKeyFingerprint !== grant.signingKeyFingerprint || !grant.allowedActions.includes(operation.action) ||
      operation.mutationSeq > grant.maxTextClaims) return 'FRONTIER_MANUAL_SESSION_MALFORMED';
  if (Date.parse(operation.expiresAt) > Date.parse(grant.expiresAt) || Date.parse(operation.issuedAt) < Date.parse(grant.issuedAt)) return 'FRONTIER_MANUAL_SESSION_EXPIRED';
  return null;
}
export function validateFrontierManualSessionEnvelope(value: unknown): FrontierManualSessionOperationEnvelopeV1 | null {
  if (!object(value) || !exactKeys(value, ENVELOPE_KEYS) || value.contract !== FRONTIER_MANUAL_SESSION_ENVELOPE_CONTRACT || value.schemaVersion !== 1 ||
      value.verifierId !== FRONTIER_MANUAL_SESSION_VERIFIER_ID || value.verifierContractVersion !== FRONTIER_MANUAL_SESSION_VERIFIER_CONTRACT_VERSION ||
      !isRemoteSteeringDigest(value.signingKeyFingerprint)) return null;
  const grant = validateFrontierManualSessionSignedGrant(value.grant);
  const operation = validateFrontierManualSessionSignedOperation(value.operation);
  if (!grant || !operation || value.signingKeyFingerprint !== grant.payload.signingKeyFingerprint || value.signingKeyFingerprint !== operation.payload.signingKeyFingerprint ||
      frontierManualSessionOperationGrantMismatch(operation.payload, grant.payload) !== null) return null;
  return value as unknown as FrontierManualSessionOperationEnvelopeV1;
}
