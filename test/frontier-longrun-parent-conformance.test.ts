import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FRONTIER_LONGRUN_PARENT_ENVELOPE_CONTRACT,
  FRONTIER_LONGRUN_PARENT_GRANT_CONTRACT,
  FRONTIER_LONGRUN_PARENT_GRANT_KEY_ORDER,
  FRONTIER_LONGRUN_PARENT_MAX_SLOTS,
  FRONTIER_LONGRUN_PARENT_OPERATION_CONTRACT,
  FRONTIER_LONGRUN_PARENT_OPERATION_KEY_ORDER,
  canonicalFrontierLongrunParentGrantBytes,
  canonicalFrontierLongrunParentOperationBytes,
  frontierLongrunParentGrantDigest,
  validateFrontierLongrunParentEnvelope,
  validateFrontierLongrunParentGrant,
  validateFrontierLongrunParentOperation,
  type FrontierLongrunParentGrantV1,
  type FrontierLongrunParentOperationEnvelopeV1,
  type FrontierLongrunParentOperationV1,
} from '../src/main/frontier-longrun-parent-contract.js';
import { remoteSteeringSha256 } from '../src/main/remote-steering-contract.js';

const FINGERPRINT = 'f'.repeat(64);
const MISSION_DIGEST = 'a'.repeat(64);
const TEXT = 'Frontier parent exact canonical fixture';
const TEXT_BYTES = Buffer.from(TEXT, 'utf8');

const GRANT: FrontierLongrunParentGrantV1 = {
  contract: FRONTIER_LONGRUN_PARENT_GRANT_CONTRACT,
  schemaVersion: 1,
  verifierId: 'chat-on-steroids',
  verifierContractVersion: 1,
  grantId: 'a1000000000000000000000000000001',
  missionId: 'frontier-parent-conformance',
  missionDigest: MISSION_DIGEST,
  maxSlots: FRONTIER_LONGRUN_PARENT_MAX_SLOTS,
  issuedAt: '2026-09-16T14:00:00.000Z',
  expiresAt: '2026-09-19T14:00:00.000Z',
  signingKeyFingerprint: FINGERPRINT,
  operatorIntentDigest: 'b'.repeat(64),
};

const OPERATION: FrontierLongrunParentOperationV1 = {
  contract: FRONTIER_LONGRUN_PARENT_OPERATION_CONTRACT,
  schemaVersion: 1,
  verifierId: 'chat-on-steroids',
  verifierContractVersion: 1,
  operationId: 'a2000000000000000000000000000002',
  grantId: GRANT.grantId,
  grantDigest: frontierLongrunParentGrantDigest(GRANT),
  missionDigest: MISSION_DIGEST,
  slot: 3,
  action: 'LONGRUN_PROMPT',
  mutationSeq: 7,
  inputId: '10000000-0000-4000-8000-000000000007',
  longrunText: TEXT,
  longrunSha256: remoteSteeringSha256(TEXT_BYTES),
  longrunLength: TEXT_BYTES.length,
  issuedAt: '2026-09-16T14:00:30.000Z',
  expiresAt: '2026-09-16T14:01:30.000Z',
  signingKeyFingerprint: FINGERPRINT,
};

const GRANT_CANONICAL = `nexora.cc.frontier-longrun-parent.v1:cc_frontier_longrun_parent_grant_v1
{"contract":"cc_frontier_longrun_parent_grant_v1","schemaVersion":1,"verifierId":"chat-on-steroids","verifierContractVersion":1,"grantId":"a1000000000000000000000000000001","missionId":"frontier-parent-conformance","missionDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","maxSlots":8,"issuedAt":"2026-09-16T14:00:00.000Z","expiresAt":"2026-09-19T14:00:00.000Z","signingKeyFingerprint":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","operatorIntentDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`;

const OPERATION_CANONICAL = `nexora.cc.frontier-longrun-parent.v1:cc_frontier_longrun_parent_operation_v1
{"contract":"cc_frontier_longrun_parent_operation_v1","schemaVersion":1,"verifierId":"chat-on-steroids","verifierContractVersion":1,"operationId":"a2000000000000000000000000000002","grantId":"a1000000000000000000000000000001","grantDigest":"${frontierLongrunParentGrantDigest(GRANT)}","missionDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","slot":3,"action":"LONGRUN_PROMPT","mutationSeq":7,"inputId":"10000000-0000-4000-8000-000000000007","longrunText":"Frontier parent exact canonical fixture","longrunSha256":"${remoteSteeringSha256(TEXT_BYTES)}","longrunLength":39,"issuedAt":"2026-09-16T14:00:30.000Z","expiresAt":"2026-09-16T14:01:30.000Z","signingKeyFingerprint":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}`;

describe('Frontier Longrun parent V1 conformance', () => {
  it('freezes the exact canonical field orders and signing bytes', () => {
    expect(FRONTIER_LONGRUN_PARENT_GRANT_KEY_ORDER).toEqual([
      'contract','schemaVersion','verifierId','verifierContractVersion','grantId','missionId','missionDigest','maxSlots',
      'issuedAt','expiresAt','signingKeyFingerprint','operatorIntentDigest'
    ]);
    expect(FRONTIER_LONGRUN_PARENT_OPERATION_KEY_ORDER).toEqual([
      'contract','schemaVersion','verifierId','verifierContractVersion','operationId','grantId','grantDigest','missionDigest',
      'slot','action','mutationSeq','inputId','longrunText','longrunSha256','longrunLength','issuedAt','expiresAt','signingKeyFingerprint'
    ]);
    expect(canonicalFrontierLongrunParentGrantBytes(GRANT).toString('utf8')).toBe(GRANT_CANONICAL);
    expect(canonicalFrontierLongrunParentOperationBytes(OPERATION).toString('utf8')).toBe(OPERATION_CANONICAL);
  });

  it('accepts independently signed canonical bytes and rejects every wrapper/key-set drift', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicDer = publicKey.export({ format: 'der', type: 'spki' });
    const fingerprint = createHash('sha256').update(publicDer).digest('hex');
    const grant = { ...GRANT, signingKeyFingerprint: fingerprint };
    const operation = {
      ...OPERATION,
      grantDigest: frontierLongrunParentGrantDigest(grant),
      signingKeyFingerprint: fingerprint,
    };
    const envelope: FrontierLongrunParentOperationEnvelopeV1 = {
      contract: FRONTIER_LONGRUN_PARENT_ENVELOPE_CONTRACT,
      schemaVersion: 1,
      verifierId: 'chat-on-steroids',
      verifierContractVersion: 1,
      signingKeyFingerprint: fingerprint,
      grant: { payload: grant, signature: sign(null, canonicalFrontierLongrunParentGrantBytes(grant), privateKey).toString('base64') },
      operation: { payload: operation, signature: sign(null, canonicalFrontierLongrunParentOperationBytes(operation), privateKey).toString('base64') },
    };
    expect(validateFrontierLongrunParentEnvelope(envelope)).not.toBeNull();
    expect(validateFrontierLongrunParentEnvelope({ ...envelope, extra: true })).toBeNull();
    expect(validateFrontierLongrunParentGrant({ ...grant, maxSlots: 7 })).toBeNull();
    expect(validateFrontierLongrunParentOperation({ ...operation, slot: 9 })).toBeNull();
  });

  it('enforces content/null shapes, positive sequencing, 72-hour parent and 60-second operation ceilings', () => {
    expect(validateFrontierLongrunParentOperation({ ...OPERATION, mutationSeq: 0 })).toBeNull();
    expect(validateFrontierLongrunParentOperation({ ...OPERATION, inputId: null })).toBeNull();
    expect(validateFrontierLongrunParentOperation({ ...OPERATION, longrunLength: TEXT_BYTES.length + 1 })).toBeNull();
    expect(validateFrontierLongrunParentOperation({ ...OPERATION, action: 'SESSION_STATUS', inputId: null, longrunText: null, longrunSha256: null, longrunLength: null })).not.toBeNull();
    expect(validateFrontierLongrunParentOperation({ ...OPERATION, action: 'LOOP_OFF', inputId: null, longrunText: null, longrunSha256: null, longrunLength: null })).not.toBeNull();
    expect(validateFrontierLongrunParentGrant({ ...GRANT, expiresAt: '2026-09-19T14:00:00.001Z' })).toBeNull();
    expect(validateFrontierLongrunParentOperation({ ...OPERATION, expiresAt: '2026-09-16T14:01:30.001Z' })).toBeNull();
  });
});
