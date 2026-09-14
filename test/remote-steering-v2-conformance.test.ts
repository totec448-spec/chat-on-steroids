import { describe, expect, it } from 'vitest';
import type {
  RemoteSteeringLeaseV2,
  RemoteSteeringOperationEnvelopeV2,
  RemoteSteeringOperationV2
} from '../src/main/remote-steering-contract-v2.js';
import {
  REMOTE_STEERING_ENVELOPE_CONTRACT_V2,
  REMOTE_STEERING_SCHEMA_VERSION_V2,
  REMOTE_STEERING_VERIFIER_CONTRACT_VERSION_V2,
  REMOTE_STEERING_VERIFIER_ID_V2,
  canonicalLeaseBytesV2,
  canonicalOperationBytesV2,
  remoteSteeringLeaseDigestV2,
  remoteSteeringOperationDigestV2,
  validateRemoteSteeringEnvelopeV2
} from '../src/main/remote-steering-contract-v2.js';
import { verifyRemoteSteeringSignature } from '../src/main/remote-steering-contract.js';

/**
 * Frozen producer fixture generated from the reviewed Command Center V2 producer commit
 * 18500f6e01b931b925ed9214ffea7e4953d927db on
 * `slice/cc-cos-remote-spawn-v2-20260913`. Only public verifier material is retained here.
 * If either repository changes one V2 signing byte, digest, field order or domain without
 * moving the governed contract, this suite turns red before a live SPAWN is relayed.
 */
const PUBLIC_KEY_SPKI_BASE64 = 'MCowBQYDK2VwAyEAKGt2/bs6sVD667ZE4TGL9IU3UfFgLUC5lGIY+nERShY=';
const FINGERPRINT = '64da801d2b9a0d494a1ecf84a0c390d98002155a25419237b51e74dcf7830124';
const LEASE_SIGNATURE = 'wIQ8T03Az5mqrNHQwXsJCzXy7ZfMykvAnyrNsJhyN1ld1WJkGbcBH72Ku4RJBqbBOG2BAB2JdmXNpt54LUdiDw==';
const OPERATION_SIGNATURE = 'Q+NRvh0J5sL1JW1NM3NSJhoF9MbjOZxm/f7qTphvGxbE0mvZc65NEVcJWJJVznCTCjSr3y404lt6WptGZE+xAw==';

const LEASE: RemoteSteeringLeaseV2 = {
  contract: 'cc_remote_steering_lease_v2',
  schemaVersion: 2,
  verifierId: 'chat-on-steroids',
  verifierContractVersion: 2,
  leaseId: '91000000000000000000000000000001',
  missionId: 'remote-spawn-v2-conformance',
  missionDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  runId: 'run-v2-7',
  workerAllowlist: ['worker-2'],
  allowedActions: ['MESSAGE', 'SPAWN', 'STATUS'],
  issuedAt: '2026-09-13T12:00:00.000Z',
  expiresAt: '2026-09-13T14:00:00.000Z',
  signingKeyFingerprint: FINGERPRINT,
  operatorIntentDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
};

const OPERATION: RemoteSteeringOperationV2 = {
  contract: 'cc_remote_steering_operation_v2',
  schemaVersion: 2,
  verifierId: 'chat-on-steroids',
  verifierContractVersion: 2,
  operationId: '92000000000000000000000000000002',
  leaseId: LEASE.leaseId,
  leaseDigest: 'cb390867234043cd22d858b1e894ac392227adbb87f3c89c3d53987750147e2e',
  missionDigest: LEASE.missionDigest,
  runId: LEASE.runId,
  action: 'SPAWN',
  targetWorkerId: 'worker-2',
  messageText: null,
  messageSha256: null,
  messageLength: null,
  spawnTaskText: 'inspect the remote spawn bridge',
  spawnTaskSha256: '5c2c082d41d82195bd6a6adf1f3662436c08fdf785a1990db55dd7e3f5884e7f',
  spawnTaskLength: 31,
  issuedAt: '2026-09-13T12:00:30.000Z',
  expiresAt: '2026-09-13T12:05:30.000Z',
  signingKeyFingerprint: FINGERPRINT
};

const LEASE_CANONICAL = `nexora.cc.remote-steering.v2:cc_remote_steering_lease_v2
{"contract":"cc_remote_steering_lease_v2","schemaVersion":2,"verifierId":"chat-on-steroids","verifierContractVersion":2,"leaseId":"91000000000000000000000000000001","missionId":"remote-spawn-v2-conformance","missionDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","runId":"run-v2-7","workerAllowlist":["worker-2"],"allowedActions":["MESSAGE","SPAWN","STATUS"],"issuedAt":"2026-09-13T12:00:00.000Z","expiresAt":"2026-09-13T14:00:00.000Z","signingKeyFingerprint":"64da801d2b9a0d494a1ecf84a0c390d98002155a25419237b51e74dcf7830124","operatorIntentDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`;

const OPERATION_CANONICAL = `nexora.cc.remote-steering.v2:cc_remote_steering_operation_v2
{"contract":"cc_remote_steering_operation_v2","schemaVersion":2,"verifierId":"chat-on-steroids","verifierContractVersion":2,"operationId":"92000000000000000000000000000002","leaseId":"91000000000000000000000000000001","leaseDigest":"cb390867234043cd22d858b1e894ac392227adbb87f3c89c3d53987750147e2e","missionDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","runId":"run-v2-7","action":"SPAWN","targetWorkerId":"worker-2","messageText":null,"messageSha256":null,"messageLength":null,"spawnTaskText":"inspect the remote spawn bridge","spawnTaskSha256":"5c2c082d41d82195bd6a6adf1f3662436c08fdf785a1990db55dd7e3f5884e7f","spawnTaskLength":31,"issuedAt":"2026-09-13T12:00:30.000Z","expiresAt":"2026-09-13T12:05:30.000Z","signingKeyFingerprint":"64da801d2b9a0d494a1ecf84a0c390d98002155a25419237b51e74dcf7830124"}`;

const ENVELOPE: RemoteSteeringOperationEnvelopeV2 = {
  contract: REMOTE_STEERING_ENVELOPE_CONTRACT_V2,
  schemaVersion: REMOTE_STEERING_SCHEMA_VERSION_V2,
  verifierId: REMOTE_STEERING_VERIFIER_ID_V2,
  verifierContractVersion: REMOTE_STEERING_VERIFIER_CONTRACT_VERSION_V2,
  signingKeyFingerprint: FINGERPRINT,
  lease: { payload: LEASE, signature: LEASE_SIGNATURE },
  operation: { payload: OPERATION, signature: OPERATION_SIGNATURE }
};

describe('remote steering V2 conformance with Command Center producer', () => {
  it('matches CC V2 canonical lease bytes, digest and signature exactly', () => {
    const bytes = canonicalLeaseBytesV2(LEASE);
    expect(bytes.toString('utf8')).toBe(LEASE_CANONICAL);
    expect(remoteSteeringLeaseDigestV2(LEASE)).toBe(OPERATION.leaseDigest);
    expect(verifyRemoteSteeringSignature(bytes, LEASE_SIGNATURE, PUBLIC_KEY_SPKI_BASE64)).toBe(true);
  });

  it('matches CC V2 SPAWN canonical bytes, digest, signature and envelope exactly', () => {
    const bytes = canonicalOperationBytesV2(OPERATION);
    expect(bytes.toString('utf8')).toBe(OPERATION_CANONICAL);
    expect(remoteSteeringOperationDigestV2(OPERATION)).toBe('53e4f6621bd24e8ede1d12da95d6a0faf1b91ac0882037c8b33d5b7eee260b06');
    expect(verifyRemoteSteeringSignature(bytes, OPERATION_SIGNATURE, PUBLIC_KEY_SPKI_BASE64)).toBe(true);
    expect(validateRemoteSteeringEnvelopeV2(ENVELOPE)).not.toBeNull();
  });
});
