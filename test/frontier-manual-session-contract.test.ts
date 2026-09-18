import { describe, expect, it } from 'vitest';
import {
  FRONTIER_MANUAL_SESSION_ACTIONS,
  FRONTIER_MANUAL_SESSION_AUTOMATION,
  FRONTIER_MANUAL_SESSION_ENVELOPE_KEY_ORDER,
  FRONTIER_MANUAL_SESSION_GRANT_CONTRACT,
  FRONTIER_MANUAL_SESSION_GRANT_KEY_ORDER,
  FRONTIER_MANUAL_SESSION_MAX_TEXT_CLAIMS,
  FRONTIER_MANUAL_SESSION_MODEL,
  FRONTIER_MANUAL_SESSION_OPERATION_CONTRACT,
  FRONTIER_MANUAL_SESSION_OPERATION_KEY_ORDER,
  FRONTIER_MANUAL_SESSION_REASONING,
  FRONTIER_MANUAL_SESSION_SIGNING_DOMAIN,
  canonicalFrontierManualSessionGrantBytes,
  canonicalFrontierManualSessionOperationBytes,
  frontierManualSessionGrantDigest,
  frontierManualSessionOperationGrantMismatch,
  frontierManualSessionProjectBindingDigest,
  validateFrontierManualSessionGrant,
  validateFrontierManualSessionOperation,
  type FrontierManualSessionGrantV1,
  type FrontierManualSessionOperationV1,
} from '../src/main/frontier-manual-session-contract.js';
import { remoteSteeringSha256 } from '../src/main/remote-steering-contract.js';

const fingerprint = 'f'.repeat(64);
const grant: FrontierManualSessionGrantV1 = {
  contract: FRONTIER_MANUAL_SESSION_GRANT_CONTRACT,
  schemaVersion: 1,
  verifierId: 'chat-on-steroids',
  verifierContractVersion: 1,
  grantId: '10000000000000000000000000000001',
  travelParentId: '20000000000000000000000000000002',
  travelParentDigest: 'a'.repeat(64),
  scope: 'vyper',
  projectBindingDigest: frontierManualSessionProjectBindingDigest('vyper'),
  allowedActions: FRONTIER_MANUAL_SESSION_ACTIONS,
  maxTextClaims: FRONTIER_MANUAL_SESSION_MAX_TEXT_CLAIMS,
  model: FRONTIER_MANUAL_SESSION_MODEL,
  reasoning: FRONTIER_MANUAL_SESSION_REASONING,
  automation: FRONTIER_MANUAL_SESSION_AUTOMATION,
  issuedAt: '2026-09-18T12:00:00.000Z',
  expiresAt: '2026-09-21T12:00:00.000Z',
  signingKeyFingerprint: fingerprint,
};

function operation(text = 'exact task'): FrontierManualSessionOperationV1 {
  const bytes = Buffer.from(text, 'utf8');
  return {
    contract: FRONTIER_MANUAL_SESSION_OPERATION_CONTRACT,
    schemaVersion: 1,
    verifierId: 'chat-on-steroids',
    verifierContractVersion: 1,
    operationId: '30000000000000000000000000000003',
    grantId: grant.grantId,
    grantDigest: frontierManualSessionGrantDigest(grant),
    projectBindingDigest: grant.projectBindingDigest,
    action: 'SESSION_PROMPT',
    mutationSeq: 2,
    inputId: '10000000-0000-4000-8000-000000000003',
    taskText: text,
    taskSha256: remoteSteeringSha256(bytes),
    taskLength: bytes.length,
    issuedAt: '2026-09-18T12:00:30.000Z',
    expiresAt: '2026-09-18T12:01:29.000Z',
    signingKeyFingerprint: fingerprint,
  };
}

describe('Frontier manual-session exact CC wire mirror', () => {
  it('pins exact canonical key order and signing-domain bytes', () => {
    expect(FRONTIER_MANUAL_SESSION_GRANT_KEY_ORDER).toEqual([
      'contract','schemaVersion','verifierId','verifierContractVersion','grantId','travelParentId','travelParentDigest','scope',
      'projectBindingDigest','allowedActions','maxTextClaims','model','reasoning','automation','issuedAt','expiresAt','signingKeyFingerprint'
    ]);
    expect(FRONTIER_MANUAL_SESSION_OPERATION_KEY_ORDER).toEqual([
      'contract','schemaVersion','verifierId','verifierContractVersion','operationId','grantId','grantDigest','projectBindingDigest','action',
      'mutationSeq','inputId','taskText','taskSha256','taskLength','issuedAt','expiresAt','signingKeyFingerprint'
    ]);
    expect(FRONTIER_MANUAL_SESSION_ENVELOPE_KEY_ORDER).toEqual([
      'contract','schemaVersion','verifierId','verifierContractVersion','signingKeyFingerprint','grant','operation'
    ]);
    expect(canonicalFrontierManualSessionGrantBytes(grant).toString('utf8')).toBe(
      `${FRONTIER_MANUAL_SESSION_SIGNING_DOMAIN}${FRONTIER_MANUAL_SESSION_GRANT_CONTRACT}\n${JSON.stringify(grant)}`
    );
    expect(canonicalFrontierManualSessionOperationBytes(operation()).toString('utf8')).toBe(
      `${FRONTIER_MANUAL_SESSION_SIGNING_DOMAIN}${FRONTIER_MANUAL_SESSION_OPERATION_CONTRACT}\n${JSON.stringify(operation())}`
    );
  });

  it('rejects grant profile widening or field drift', () => {
    expect(validateFrontierManualSessionGrant(grant)).toEqual(grant);
    expect(validateFrontierManualSessionGrant({ ...grant, automation: true })).toBeNull();
    expect(validateFrontierManualSessionGrant({ ...grant, model: 'other' })).toBeNull();
    expect(validateFrontierManualSessionGrant({ ...grant, allowedActions: [...FRONTIER_MANUAL_SESSION_ACTIONS, 'SPAWN'] })).toBeNull();
    expect(validateFrontierManualSessionGrant({ ...grant, extra: true })).toBeNull();
  });

  it('enforces exact task bytes and status null fields', () => {
    const prompt = operation('😀'.repeat(4_000));
    expect(Buffer.byteLength(prompt.taskText!, 'utf8')).toBe(16_000);
    expect(validateFrontierManualSessionOperation(prompt)).toEqual(prompt);
    expect(validateFrontierManualSessionOperation(operation('x'.repeat(16_001)))).toBeNull();
    expect(validateFrontierManualSessionOperation({ ...prompt, taskLength: 15_999 })).toBeNull();
    expect(validateFrontierManualSessionOperation({ ...prompt, taskSha256: '0'.repeat(64) })).toBeNull();
    expect(validateFrontierManualSessionOperation({
      ...prompt,
      action: 'SESSION_STATUS',
      inputId: null,
      taskText: null,
      taskSha256: null,
      taskLength: null,
    })).not.toBeNull();
    expect(validateFrontierManualSessionOperation({ ...prompt, action: 'SESSION_STATUS' })).toBeNull();
    expect(frontierManualSessionOperationGrantMismatch({ ...prompt, mutationSeq: 65 }, grant)).toBe('FRONTIER_MANUAL_SESSION_MALFORMED');
  });
});
