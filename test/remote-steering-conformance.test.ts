import { describe, expect, it } from 'vitest';
import {
  REMOTE_STEERING_ENVELOPE_CONTRACT,
  REMOTE_STEERING_SCHEMA_VERSION,
  REMOTE_STEERING_VERIFIER_CONTRACT_VERSION,
  REMOTE_STEERING_VERIFIER_ID,
  canonicalLeaseBytes,
  canonicalOperationBytes,
  remoteSteeringFingerprint,
  remoteSteeringLeaseDigest,
  remoteSteeringOperationDigest,
  validateRemoteSteeringEnvelope,
  verifyRemoteSteeringSignature,
  type RemoteSteeringLeaseV1,
  type RemoteSteeringOperationEnvelopeV1,
  type RemoteSteeringOperationV1
} from '../src/main/remote-steering-contract.js';

/**
 * Frozen producer fixture generated from Command Center commit
 * 66f962872cc62b445ad2772367fd7bf4734cb44f using that commit's compiled
 * `packages/engine/src/remote-steering.ts` builders/canonicalizers and Node Ed25519 signer.
 *
 * Only the public verifier half is retained here. If either repository changes one signing
 * byte, bound, field or ordering rule without moving the governed contract, this suite turns
 * red before an operator discovers the fork by relaying a real envelope.
 */
const CC_SOURCE_COMMIT = '66f962872cc62b445ad2772367fd7bf4734cb44f';
const PUBLIC_KEY_SPKI_BASE64 = 'MCowBQYDK2VwAyEAzLeU7k8Px0CDCa+wocAa30m5x5WvXOpTGj4nYicAY6o=';
const FINGERPRINT = 'cd9fdbfc44f8bb685b8f0a01d346f2900cbbc26bc3591ff7fa332faa8c63ddec';

const LEASE: RemoteSteeringLeaseV1 = {
  contract: 'cc_remote_steering_lease_v1',
  schemaVersion: 1,
  verifierId: 'chat-on-steroids',
  verifierContractVersion: 1,
  leaseId: '00000000000000000000000000000001',
  missionId: 'cos-remote-steering',
  missionDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  runId: 'run-7',
  workerAllowlist: ['worker-a', 'worker-b'],
  allowedActions: ['MESSAGE', 'STATUS'],
  issuedAt: '2026-09-11T12:00:00.000Z',
  expiresAt: '2026-09-11T14:00:00.000Z',
  signingKeyFingerprint: FINGERPRINT,
  operatorIntentDigest: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
};

const MESSAGE: RemoteSteeringOperationV1 = {
  contract: 'cc_remote_steering_operation_v1',
  schemaVersion: 1,
  verifierId: 'chat-on-steroids',
  verifierContractVersion: 1,
  operationId: '00000000000000000000000000000002',
  leaseId: LEASE.leaseId,
  leaseDigest: '4e723b8459d73fe50d9095b939181afb81182d26a164465fc9e0644ecf78d392',
  missionDigest: LEASE.missionDigest,
  runId: LEASE.runId,
  action: 'MESSAGE',
  targetWorkerId: 'worker-a',
  messageText: 'continue with the bridge slice',
  messageSha256: '2efd74021b9f64a3d3c751a56089ff5f76d16aa988cdf2a38aa997252f6660e9',
  messageLength: 30,
  issuedAt: '2026-09-11T12:00:00.000Z',
  expiresAt: '2026-09-11T12:05:00.000Z',
  signingKeyFingerprint: FINGERPRINT
};

const STATUS: RemoteSteeringOperationV1 = {
  contract: 'cc_remote_steering_operation_v1',
  schemaVersion: 1,
  verifierId: 'chat-on-steroids',
  verifierContractVersion: 1,
  operationId: '00000000000000000000000000000003',
  leaseId: LEASE.leaseId,
  leaseDigest: MESSAGE.leaseDigest,
  missionDigest: LEASE.missionDigest,
  runId: LEASE.runId,
  action: 'STATUS',
  targetWorkerId: null,
  messageText: null,
  messageSha256: null,
  messageLength: null,
  issuedAt: '2026-09-11T12:00:30.000Z',
  expiresAt: '2026-09-11T12:05:30.000Z',
  signingKeyFingerprint: FINGERPRINT
};

const LEASE_CANONICAL = `nexora.cc.remote-steering.v1:cc_remote_steering_lease_v1
{"contract":"cc_remote_steering_lease_v1","schemaVersion":1,"verifierId":"chat-on-steroids","verifierContractVersion":1,"leaseId":"00000000000000000000000000000001","missionId":"cos-remote-steering","missionDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","runId":"run-7","workerAllowlist":["worker-a","worker-b"],"allowedActions":["MESSAGE","STATUS"],"issuedAt":"2026-09-11T12:00:00.000Z","expiresAt":"2026-09-11T14:00:00.000Z","signingKeyFingerprint":"cd9fdbfc44f8bb685b8f0a01d346f2900cbbc26bc3591ff7fa332faa8c63ddec","operatorIntentDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}`;

const MESSAGE_CANONICAL = `nexora.cc.remote-steering.v1:cc_remote_steering_operation_v1
{"contract":"cc_remote_steering_operation_v1","schemaVersion":1,"verifierId":"chat-on-steroids","verifierContractVersion":1,"operationId":"00000000000000000000000000000002","leaseId":"00000000000000000000000000000001","leaseDigest":"4e723b8459d73fe50d9095b939181afb81182d26a164465fc9e0644ecf78d392","missionDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","runId":"run-7","action":"MESSAGE","targetWorkerId":"worker-a","messageText":"continue with the bridge slice","messageSha256":"2efd74021b9f64a3d3c751a56089ff5f76d16aa988cdf2a38aa997252f6660e9","messageLength":30,"issuedAt":"2026-09-11T12:00:00.000Z","expiresAt":"2026-09-11T12:05:00.000Z","signingKeyFingerprint":"cd9fdbfc44f8bb685b8f0a01d346f2900cbbc26bc3591ff7fa332faa8c63ddec"}`;

const STATUS_CANONICAL = `nexora.cc.remote-steering.v1:cc_remote_steering_operation_v1
{"contract":"cc_remote_steering_operation_v1","schemaVersion":1,"verifierId":"chat-on-steroids","verifierContractVersion":1,"operationId":"00000000000000000000000000000003","leaseId":"00000000000000000000000000000001","leaseDigest":"4e723b8459d73fe50d9095b939181afb81182d26a164465fc9e0644ecf78d392","missionDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","runId":"run-7","action":"STATUS","targetWorkerId":null,"messageText":null,"messageSha256":null,"messageLength":null,"issuedAt":"2026-09-11T12:00:30.000Z","expiresAt":"2026-09-11T12:05:30.000Z","signingKeyFingerprint":"cd9fdbfc44f8bb685b8f0a01d346f2900cbbc26bc3591ff7fa332faa8c63ddec"}`;

const LEASE_DIGEST = '4e723b8459d73fe50d9095b939181afb81182d26a164465fc9e0644ecf78d392';
const MESSAGE_DIGEST = '643cd9dfeed430da0becd25797c2f6fd22c47f80d42429172e24fff6de529c74';
const STATUS_DIGEST = '36a29d6c3dd89230eb30f4a16d381e2a738a117e1a41572639808a1af9468113';
const LEASE_SIGNATURE = 'ZRZKmhfpPp4NNhaLi/GIkHQx2nAKm3bbJYKrVjz83EEZreuxsizJO8IUWSD3YxfnYMD/3iD2JUavnh2hFI+6Dw==';
const MESSAGE_SIGNATURE = 'Jju/0WtHxiSvI/cgqbZLWVtLET68V757Fy/Qea9gj7UwCVRQN5nf0TKBHuMNbqKkoToF/y8nCY3mDatlBQBEAg==';
const STATUS_SIGNATURE = 'LilZGBqhJl0IO4gcXLlWMG0CGR07NFa2ZeaAbSUW9VoReZy01fMpx1s2TJ3QLiWxyiX8OJ6im3w+rVnMguBuBA==';

function envelope(operation: RemoteSteeringOperationV1, signature: string): RemoteSteeringOperationEnvelopeV1 {
  return {
    contract: REMOTE_STEERING_ENVELOPE_CONTRACT,
    schemaVersion: REMOTE_STEERING_SCHEMA_VERSION,
    verifierId: REMOTE_STEERING_VERIFIER_ID,
    verifierContractVersion: REMOTE_STEERING_VERIFIER_CONTRACT_VERSION,
    signingKeyFingerprint: FINGERPRINT,
    lease: { payload: LEASE, signature: LEASE_SIGNATURE },
    operation: { payload: operation, signature }
  };
}

describe(`remote steering conformance with CC ${CC_SOURCE_COMMIT.slice(0, 8)}`, () => {
  it('matches CC canonical lease bytes, digest, fingerprint and signature exactly', () => {
    const bytes = canonicalLeaseBytes(LEASE);
    expect(bytes.toString('utf8')).toBe(LEASE_CANONICAL);
    expect(remoteSteeringLeaseDigest(LEASE)).toBe(LEASE_DIGEST);
    expect(remoteSteeringFingerprint(PUBLIC_KEY_SPKI_BASE64)).toBe(FINGERPRINT);
    expect(verifyRemoteSteeringSignature(bytes, LEASE_SIGNATURE, PUBLIC_KEY_SPKI_BASE64)).toBe(true);
  });

  it.each([
    ['MESSAGE', MESSAGE, MESSAGE_CANONICAL, MESSAGE_DIGEST, MESSAGE_SIGNATURE],
    ['STATUS', STATUS, STATUS_CANONICAL, STATUS_DIGEST, STATUS_SIGNATURE]
  ] as const)('matches CC %s canonical bytes, digest, signature and envelope', (_action, operation, canonical, digest, signature) => {
    const bytes = canonicalOperationBytes(operation);
    expect(bytes.toString('utf8')).toBe(canonical);
    expect(remoteSteeringOperationDigest(operation)).toBe(digest);
    expect(verifyRemoteSteeringSignature(bytes, signature, PUBLIC_KEY_SPKI_BASE64)).toBe(true);
    expect(validateRemoteSteeringEnvelope(envelope(operation, signature))).not.toBeNull();
  });
});
