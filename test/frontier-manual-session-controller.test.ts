import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FRONTIER_MANUAL_SESSION_ACTIONS,
  FRONTIER_MANUAL_SESSION_ENVELOPE_CONTRACT,
  FRONTIER_MANUAL_SESSION_GRANT_CONTRACT,
  FRONTIER_MANUAL_SESSION_MAX_TEXT_CLAIMS,
  FRONTIER_MANUAL_SESSION_MODEL,
  FRONTIER_MANUAL_SESSION_OPERATION_CONTRACT,
  FRONTIER_MANUAL_SESSION_REASONING,
  FRONTIER_MANUAL_SESSION_VERIFIER_CONTRACT_VERSION,
  frontierManualSessionGrantDigest,
  frontierManualSessionOperationDigest,
  frontierManualSessionProjectBindingDigest,
  type FrontierManualSessionAction,
  type FrontierManualSessionGrantV1,
  type FrontierManualSessionOperationEnvelopeV1,
  type FrontierManualSessionOperationV1,
} from '../src/main/frontier-manual-session-contract.js';
import { remoteSteeringSha256 } from '../src/main/remote-steering-contract.js';
import {
  resetFrontierManualSessionControllerForTests,
  runFrontierManualSessionController,
  setFrontierManualSessionCommandBindingForTests,
  setFrontierManualSessionCommandRunnerForTests,
} from '../src/main/frontier-manual-session-controller.js';
import { emptyEvidence, runInCallContext } from '../src/main/mcp/call-context.js';
import { buildServer, type ToolContext } from '../src/main/mcp/tools.js';
import type { RemoteSteeringOutcome } from '../src/main/remote-steering.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory = '';
let nodePath = '';
let cliPath = '';
const fingerprint = 'f'.repeat(64);
const signature = Buffer.alloc(64).toString('base64');
const scope = 'vyper' as const;
const projectBindingDigest = frontierManualSessionProjectBindingDigest(scope);
const issuedAt = '2026-09-18T12:00:00.000Z';
const expiresAt = '2026-09-21T12:00:00.000Z';

function grant(): FrontierManualSessionGrantV1 {
  return {
    contract: FRONTIER_MANUAL_SESSION_GRANT_CONTRACT, schemaVersion: 1, verifierId: 'chat-on-steroids',
    verifierContractVersion: FRONTIER_MANUAL_SESSION_VERIFIER_CONTRACT_VERSION,
    grantId: '11000000000000000000000000000001', travelParentId: '22000000000000000000000000000002', travelParentDigest: 'a'.repeat(64),
    scope, projectBindingDigest, allowedActions: FRONTIER_MANUAL_SESSION_ACTIONS, maxTextClaims: FRONTIER_MANUAL_SESSION_MAX_TEXT_CLAIMS,
    model: FRONTIER_MANUAL_SESSION_MODEL, reasoning: FRONTIER_MANUAL_SESSION_REASONING, automation: false,
    issuedAt, expiresAt, signingKeyFingerprint: fingerprint,
  };
}

function envelope(action: FrontierManualSessionAction, text = 'controller prompt', mutationSeq = action === 'SESSION_STATUS' ? 1 : action === 'SESSION_CREATE' ? 1 : 2): FrontierManualSessionOperationEnvelopeV1 {
  const g = grant(); const carries = action !== 'SESSION_STATUS'; const bytes = Buffer.from(text, 'utf8');
  const operation: FrontierManualSessionOperationV1 = {
    contract: FRONTIER_MANUAL_SESSION_OPERATION_CONTRACT, schemaVersion: 1, verifierId: 'chat-on-steroids',
    verifierContractVersion: FRONTIER_MANUAL_SESSION_VERIFIER_CONTRACT_VERSION,
    operationId: action === 'SESSION_CREATE' ? '33000000000000000000000000000003' : action === 'SESSION_PROMPT' ? '44000000000000000000000000000004' : '55000000000000000000000000000005',
    grantId: g.grantId, grantDigest: frontierManualSessionGrantDigest(g), projectBindingDigest, action, mutationSeq,
    inputId: carries ? (action === 'SESSION_CREATE' ? '10000000-0000-4000-8000-000000000001' : '10000000-0000-4000-8000-000000000002') : null,
    taskText: carries ? text : null, taskSha256: carries ? remoteSteeringSha256(bytes) : null, taskLength: carries ? bytes.length : null,
    issuedAt: '2026-09-18T12:00:30.000Z', expiresAt: '2026-09-18T12:01:29.000Z', signingKeyFingerprint: fingerprint,
  };
  return {
    contract: FRONTIER_MANUAL_SESSION_ENVELOPE_CONTRACT, schemaVersion: 1, verifierId: 'chat-on-steroids',
    verifierContractVersion: FRONTIER_MANUAL_SESSION_VERIFIER_CONTRACT_VERSION, signingKeyFingerprint: fingerprint,
    grant: { payload: g, signature }, operation: { payload: operation, signature },
  };
}

function child(sessionCreated: boolean, mutationSeq: number, claims: number) {
  return {
    scope, projectBindingDigest, allowedActions: [...FRONTIER_MANUAL_SESSION_ACTIONS], maxTextClaims: 64,
    textClaimsUsed: claims, textClaimsRemaining: 64 - claims, sessionCreated, lastMutationSeq: mutationSeq,
    model: FRONTIER_MANUAL_SESSION_MODEL, reasoning: FRONTIER_MANUAL_SESSION_REASONING, automation: false,
    issuedAt, expiresAt, signingKeyFingerprint: fingerprint, grantDigest: frontierManualSessionGrantDigest(grant()), live: true,
  };
}

function parent() {
  return {
    allowedChildFamilies: ['frontier_longrun_parent','frontier_manual_session'], allowedScopes: ['command_center','nkb','vyper'],
    maxChildrenTotal: 9, maxChildrenPerScope: 3, childrenUsedTotal: 1, childrenUsedByScope: { command_center: 0, nkb: 0, vyper: 1 },
    issuedAt: '2026-09-18T10:00:00.000Z', expiresAt: '2026-09-25T10:00:00.000Z', signingKeyFingerprint: fingerprint,
    operatorIntentDigest: 'b'.repeat(64), travelParentDigest: 'c'.repeat(64), live: true, revoked: false,
  };
}

function createPayload(replay = false) {
  return { command: 'cc.remote.steering.travel-parent.manual-session.create', mode: 'issued', status: 'ok', scope, label: 'vyper-manual', parent: parent(), child: child(replay, replay ? 1 : 0, replay ? 1 : 0), certificateDigest: 'd'.repeat(64), replay, reason: null, warnings: [] };
}

function intentPayload(intent: 'start' | 'send' | 'status', text = 'controller prompt') {
  const signed = envelope(intent === 'start' ? 'SESSION_CREATE' : intent === 'send' ? 'SESSION_PROMPT' : 'SESSION_STATUS', text);
  const operation = signed.operation.payload;
  const claims = intent === 'status' ? 1 : operation.mutationSeq;
  return {
    command: 'cc.remote.steering.manual-session.intent', status: 'ok', intent, scope, label: 'vyper-manual',
    child: child(true, operation.mutationSeq, claims),
    operation: { action: operation.action, mutationSeq: operation.mutationSeq, inputId: operation.inputId, taskSha256: operation.taskSha256,
      taskLength: operation.taskLength, issuedAt: operation.issuedAt, expiresAt: operation.expiresAt, operationDigest: frontierManualSessionOperationDigest(operation) },
    envelope: signed, reason: null, warnings: [],
  };
}

function relayOutcome(action: FrontierManualSessionAction): RemoteSteeringOutcome {
  return {
    verifierId: 'chat-on-steroids', verifierContractVersion: 1, status: 'accepted', reason: null, detail: null,
    operationId: null, operationDigest: null, action, runId: null, sessionId: null, replay: false, decidedAt: new Date().toISOString(),
    delivered: null, spawned: null, run: null, session: null, longrun: null, frontier: null,
    manualSession: { state: 'bound', found: true, activeTurn: false, blocked: false, superseded: false, modelConfirmed: true, automationOff: true, pendingUserInput: false },
  };
}

function withRequest<T>(work: () => T, requestId = 'wfr_manual_controller_fixture'): T {
  return runInCallContext({ startedAt: Date.now(), transportKey: null, agent: null,
    caller: { transportKey: null, requestId, conversationId: null, sessionId: null }, outcome: null, evidence: emptyEvidence() }, work);
}

beforeEach(async () => {
  directory = await makeTempDir('cos-frontier-manual-controller-');
  nodePath = path.join(directory, 'node.exe'); cliPath = path.join(directory, 'main.js');
  await fs.writeFile(nodePath, 'fixture'); await fs.writeFile(cliPath, 'fixture');
  setFrontierManualSessionCommandBindingForTests({ nodePath, cliPath, cwd: directory });
});

afterEach(async () => {
  resetFrontierManualSessionControllerForTests();
  if (directory) await removeTempDir(directory);
});

describe('frontier_session semantic controller', () => {
  it('runs exact child-create then start-intent, keeps prompt out of argv, cleans the 0600 temp file, and hides hidden ids', async () => {
    const prompt = 'controller prompt'; const calls: readonly string[][] = []; const mutableCalls = calls as string[][]; let taskFile = '';
    setFrontierManualSessionCommandRunnerForTests(async (command, args, cwd) => {
      expect(command).toBe(nodePath); expect(cwd).toBe(directory); mutableCalls.push([...args]);
      if (args[1] === 'cc.remote.steering.travel-parent.manual-session.create') return { exitCode: 0, stdout: JSON.stringify(createPayload()), stderr: '', truncated: false, timedOut: false, durationMs: 1 };
      taskFile = args[args.indexOf('--task-file') + 1]!; expect(await fs.readFile(taskFile, 'utf8')).toBe(prompt);
      return { exitCode: 0, stdout: JSON.stringify(intentPayload('start', prompt)), stderr: '', truncated: false, timedOut: false, durationMs: 1 };
    });
    const relay = vi.fn(async () => relayOutcome('SESSION_CREATE'));
    const result = await withRequest(() => runFrontierManualSessionController({ action: 'start', scope, label: 'VYPER Manual', prompt }, relay));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(expect.arrayContaining([cliPath,'cc.remote.steering.travel-parent.manual-session.create','--scope',scope,'--label','vyper-manual','--ttl-seconds','259200','--confirm']));
    expect(calls[1]).toEqual(expect.arrayContaining([cliPath,'cc.remote.steering.manual-session.intent','--intent','start','--task-file',taskFile]));
    expect(calls.flat().join(' ')).not.toContain(prompt);
    const childId = calls[0]![calls[0]!.indexOf('--travel-parent-request-id') + 1]!;
    const controllerId = calls[1]![calls[1]!.indexOf('--controller-request-id') + 1]!;
    expect(childId).toMatch(/^[0-9a-f]{32}$/); expect(controllerId).toMatch(/^[0-9a-f]{32}$/); expect(childId).not.toBe(controllerId);
    expect(JSON.stringify(result)).not.toContain(childId); expect(JSON.stringify(result)).not.toContain(controllerId);
    await expect(fs.lstat(taskFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(relay).toHaveBeenCalledExactlyOnceWith(intentPayload('start', prompt).envelope);
  });

  it('reuses identical hidden ids and task bytes when child creation succeeds but intent issuance must be retried', async () => {
    const prompt = 'retry the exact two-phase controller request';
    const childIds: string[] = []; const controllerIds: string[] = []; const taskBytes: Buffer[] = [];
    let createCalls = 0; let intentCalls = 0;
    setFrontierManualSessionCommandRunnerForTests(async (_command, args) => {
      if (args[1] === 'cc.remote.steering.travel-parent.manual-session.create') {
        createCalls += 1;
        childIds.push(args[args.indexOf('--travel-parent-request-id') + 1]!);
        if (createCalls === 1) return { exitCode: 0, stdout: JSON.stringify(createPayload(false)), stderr: '', truncated: false, timedOut: false, durationMs: 1 };
        const replayed = createPayload(true); replayed.child = child(false, 0, 0);
        return { exitCode: 0, stdout: JSON.stringify(replayed), stderr: '', truncated: false, timedOut: false, durationMs: 1 };
      }
      intentCalls += 1;
      controllerIds.push(args[args.indexOf('--controller-request-id') + 1]!);
      const taskFile = args[args.indexOf('--task-file') + 1]!;
      taskBytes.push(await fs.readFile(taskFile));
      if (intentCalls === 1) return { exitCode: 1, stdout: '', stderr: 'intent failed', truncated: false, timedOut: false, durationMs: 1 };
      return { exitCode: 0, stdout: JSON.stringify(intentPayload('start', prompt)), stderr: '', truncated: false, timedOut: false, durationMs: 1 };
    });
    const relay = vi.fn(async () => relayOutcome('SESSION_CREATE'));
    const run = () => withRequest(() => runFrontierManualSessionController({ action: 'start', scope, label: 'VYPER Manual', prompt }, relay), 'same-two-phase-request');
    await expect(run()).rejects.toThrow('Command Center manual-session command failed: intent failed');
    expect(relay).not.toHaveBeenCalled();
    const recovered = await run();
    expect(recovered.childReplay).toBe(true);
    expect(childIds).toHaveLength(2); expect(childIds[0]).toBe(childIds[1]);
    expect(controllerIds).toHaveLength(2); expect(controllerIds[0]).toBe(controllerIds[1]);
    expect(taskBytes).toHaveLength(2); expect(taskBytes[0]).toEqual(Buffer.from(prompt)); expect(taskBytes[1]).toEqual(taskBytes[0]);
    expect(relay).toHaveBeenCalledExactlyOnceWith(intentPayload('start', prompt).envelope);
  });

  it('derives a stable hidden intent id from exact MCP request identity and semantic input', async () => {
    const ids: string[] = [];
    setFrontierManualSessionCommandRunnerForTests(async (_command, args) => {
      ids.push(args[args.indexOf('--controller-request-id') + 1]!);
      return { exitCode: 0, stdout: JSON.stringify(intentPayload('status')), stderr: '', truncated: false, timedOut: false, durationMs: 1 };
    });
    const run = () => withRequest(() => runFrontierManualSessionController({ action: 'status', scope, label: 'VYPER Manual' }, async () => relayOutcome('SESSION_STATUS')), 'same-request');
    const first = await run(); const second = await run();
    expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]); expect(JSON.stringify(first)).not.toContain(ids[0]!); expect(JSON.stringify(second)).not.toContain(ids[0]!);
  });

  it('refuses missing identity and >16k prompt before any temp file or Command Center call', async () => {
    const runner = vi.fn(); setFrontierManualSessionCommandRunnerForTests(runner as never);
    await expect(runFrontierManualSessionController({ action: 'status', scope, label: 'vyper-manual' }, async () => relayOutcome('SESSION_STATUS'))).rejects.toThrow('requires ChatGPT request identity');
    await expect(withRequest(() => runFrontierManualSessionController({ action: 'start', scope, label: 'vyper-manual', prompt: 'x'.repeat(16_001) }, async () => relayOutcome('SESSION_CREATE')))).rejects.toThrow('16000 UTF-8 bytes');
    expect(runner).not.toHaveBeenCalled();
  });

  it('publishes a direct semantic-only frontier_session schema without authority or execution selectors', async () => {
    const published: Array<{ name: string; inputSchema: Record<string, any> }> = [];
    const ctx: ToolContext = { roots: [], caps: { ...DEFAULT_CAPABILITIES, command: false }, exposedCaps: { ...DEFAULT_CAPABILITIES, command: false },
      readOnly: true, sessionTools: false, agentTools: false, remoteSteeringTools: true, exposedRemoteSteeringTools: true, exposedFinishTool: false };
    const server = buildServer(ctx, 'core', (_name, _version, _instructions, tools) => published.push(...tools as typeof published));
    await server.close();
    const schema = published.find(tool => tool.name === 'frontier_session')!.inputSchema;
    const text = JSON.stringify(schema);
    for (const forbidden of ['executable','cwd','path','root','grant','certificate','sessionId','session_id','slot','model','reasoning','provider','argv','controller-request-id']) expect(text).not.toContain(forbidden);
    expect(text).toContain('ttl_hours'); expect(text).toContain('command_center'); expect(text).toContain('nkb'); expect(text).toContain('vyper');
  });
});
