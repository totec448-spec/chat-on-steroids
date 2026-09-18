import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import {
  FRONTIER_LONGRUN_PARENT_ENVELOPE_CONTRACT,
  FRONTIER_LONGRUN_PARENT_GRANT_CONTRACT,
  FRONTIER_LONGRUN_PARENT_MODEL,
  FRONTIER_LONGRUN_PARENT_OPERATION_CONTRACT,
  FRONTIER_LONGRUN_PARENT_REASONING,
  FRONTIER_LONGRUN_PARENT_VERIFIER_CONTRACT_VERSION,
  frontierLongrunParentGrantDigest,
  frontierLongrunParentOperationDigest,
  type FrontierLongrunParentAction,
  type FrontierLongrunParentGrantV1,
  type FrontierLongrunParentOperationEnvelopeV1,
  type FrontierLongrunParentOperationV1,
} from '../src/main/frontier-longrun-parent-contract.js';
import { remoteSteeringSha256 } from '../src/main/remote-steering-contract.js';
import {
  normalizeFrontierLongrunControllerLabel,
  resetFrontierLongrunControllerForTests,
  runFrontierLongrunController,
  setFrontierLongrunCommandBindingForTests,
  setFrontierLongrunCommandRunnerForTests,
} from '../src/main/frontier-longrun-controller.js';
import { emptyEvidence, runInCallContext } from '../src/main/mcp/call-context.js';
import { buildServer, type ToolContext } from '../src/main/mcp/tools.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';
import type { RemoteSteeringOutcome } from '../src/main/remote-steering.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
let nodePath: string;
let cliPath: string;
const fingerprint = 'f'.repeat(64);
const signature = Buffer.alloc(64).toString('base64');

function envelope(action: FrontierLongrunParentAction, text = 'controller prompt'): FrontierLongrunParentOperationEnvelopeV1 {
  const grant: FrontierLongrunParentGrantV1 = {
    contract: FRONTIER_LONGRUN_PARENT_GRANT_CONTRACT,
    schemaVersion: 1,
    verifierId: 'chat-on-steroids',
    verifierContractVersion: FRONTIER_LONGRUN_PARENT_VERIFIER_CONTRACT_VERSION,
    grantId: '11000000000000000000000000000001',
    missionId: 'frontier-controller-test',
    missionDigest: 'a'.repeat(64),
    maxSlots: 8,
    issuedAt: '2026-09-16T14:00:00.000Z',
    expiresAt: '2026-09-19T14:00:00.000Z',
    signingKeyFingerprint: fingerprint,
    operatorIntentDigest: 'b'.repeat(64),
  };
  const carries = action === 'SESSION_CREATE' || action === 'LONGRUN_PROMPT';
  const bytes = Buffer.from(text, 'utf8');
  const operation: FrontierLongrunParentOperationV1 = {
    contract: FRONTIER_LONGRUN_PARENT_OPERATION_CONTRACT,
    schemaVersion: 1,
    verifierId: 'chat-on-steroids',
    verifierContractVersion: FRONTIER_LONGRUN_PARENT_VERIFIER_CONTRACT_VERSION,
    operationId: '22000000000000000000000000000002',
    grantId: grant.grantId,
    grantDigest: frontierLongrunParentGrantDigest(grant),
    missionDigest: grant.missionDigest,
    slot: 1,
    action,
    mutationSeq: 1,
    inputId: carries ? '10000000-0000-4000-8000-000000000001' : null,
    longrunText: carries ? text : null,
    longrunSha256: carries ? remoteSteeringSha256(bytes) : null,
    longrunLength: carries ? bytes.length : null,
    issuedAt: '2026-09-16T14:00:30.000Z',
    expiresAt: '2026-09-16T14:01:30.000Z',
    signingKeyFingerprint: fingerprint,
  };
  return {
    contract: FRONTIER_LONGRUN_PARENT_ENVELOPE_CONTRACT,
    schemaVersion: 1,
    verifierId: 'chat-on-steroids',
    verifierContractVersion: FRONTIER_LONGRUN_PARENT_VERIFIER_CONTRACT_VERSION,
    signingKeyFingerprint: fingerprint,
    grant: { payload: grant, signature },
    operation: { payload: operation, signature },
  };
}

function relayOutcome(action: FrontierLongrunParentAction): RemoteSteeringOutcome {
  return {
    verifierId: 'chat-on-steroids', verifierContractVersion: FRONTIER_LONGRUN_PARENT_VERIFIER_CONTRACT_VERSION, status: 'accepted', reason: null, detail: null,
    operationId: null, operationDigest: null, action, runId: null, sessionId: null, replay: false,
    decidedAt: new Date().toISOString(), delivered: null, spawned: null, run: null, session: null, longrun: null,
    frontier: {
      slot: 1, state: action === 'LOOP_OFF' ? 'stopped' : 'bound',
      session: { found: true, activeTurn: false, blocked: false, superseded: false, modelClass: 'other', loopEnabled: action !== 'LOOP_OFF', loopMode: 'loop', objectivePresent: true, finishToolEnabled: true, pendingUserInput: false, pendingLongrunStart: false }
    }
  };
}

function intentPayload(intent: 'start' | 'continue' | 'status' | 'stop', signed = envelope(intent === 'start' ? 'SESSION_CREATE' : intent === 'continue' ? 'LONGRUN_PROMPT' : intent === 'status' ? 'SESSION_STATUS' : 'LOOP_OFF')) {
  return {
    command: 'cc.remote.steering.longrun.intent', mode: 'issued', status: 'ok', intent,
    slot: { slot: 1, label: 'vyper-gaming-production', lastMutationSeq: 1, textClaimsUsed: 1, focused: true },
    operation: { slot: 1, action: signed.operation.payload.action, mutationSeq: 1, inputId: signed.operation.payload.inputId,
      longrunSha256: signed.operation.payload.longrunSha256, longrunLength: signed.operation.payload.longrunLength,
      issuedAt: signed.operation.payload.issuedAt, expiresAt: signed.operation.payload.expiresAt,
      operationDigest: frontierLongrunParentOperationDigest(signed.operation.payload) },
    envelope: signed, reason: null, warnings: []
  };
}

function showPayload(
  model: string = FRONTIER_LONGRUN_PARENT_MODEL,
  reasoning: string = FRONTIER_LONGRUN_PARENT_REASONING
) {
  return {
    command: 'cc.remote.steering.longrun.show', status: 'ok',
    parent: {
      missionId: 'frontier-weekend', missionDigest: 'a'.repeat(64), maxSlots: 8, allocatedSlots: 2, remainingSlots: 6,
      focusSlot: 2, textClaimsUsed: 4, textClaimsRemaining: 60, issuedAt: '2026-09-16T14:00:00.000Z', expiresAt: '2026-09-19T14:00:00.000Z',
      signingKeyFingerprint: fingerprint, operatorIntentDigest: 'b'.repeat(64), grantDigest: 'c'.repeat(64), model, reasoning, live: true, revoked: false,
    },
    slots: [
      { slot: 1, label: 'nkb-review', lastMutationSeq: 2, textClaimsUsed: 1, focused: false },
      { slot: 2, label: 'vyper-gaming-production', lastMutationSeq: 5, textClaimsUsed: 3, focused: true },
    ],
    reason: null, warnings: []
  };
}

function withControllerRequest<T>(work: () => T, requestId = 'wfr_frontier_controller_fixture'): T {
  return runInCallContext({
    startedAt: Date.now(), transportKey: null, agent: null,
    caller: { transportKey: null, requestId, conversationId: null, sessionId: null },
    outcome: null, evidence: emptyEvidence()
  }, work);
}

beforeEach(async () => {
  directory = await makeTempDir('cos-frontier-controller-');
  nodePath = path.join(directory, 'node.exe');
  cliPath = path.join(directory, 'main.js');
  await fs.writeFile(nodePath, 'fixture');
  await fs.writeFile(cliPath, 'fixture');
  setFrontierLongrunCommandBindingForTests({ nodePath, cliPath, cwd: directory });
});

afterEach(async () => {
  resetFrontierLongrunControllerForTests();
  await removeTempDir(directory);
});

describe('frontier_longrun controller adapter', () => {
  it('uses only the pinned absolute command/cwd, keeps prompt out of argv, cleans the private temp file, and relays one envelope', async () => {
    const prompt = 'Ship the VYPER Gaming production slice without losing the long-run loop.';
    let promptFile = '';
    let argv: readonly string[] = [];
    setFrontierLongrunCommandRunnerForTests(async (command, args, cwd) => {
      expect(command).toBe(nodePath); expect(cwd).toBe(directory);
      argv = args;
      promptFile = args[args.indexOf('--longrun-file') + 1]!;
      expect(await fs.readFile(promptFile, 'utf8')).toBe(prompt);
      return { exitCode: 0, stdout: JSON.stringify(intentPayload('start')), stderr: '', truncated: false, timedOut: false, durationMs: 1 };
    });
    const relay = vi.fn(async () => relayOutcome('SESSION_CREATE'));
    const result = await withControllerRequest(() => runFrontierLongrunController({ action: 'start', prompt, label: 'VYPER Gaming Production' }, relay));
    expect(result).toMatchObject({ kind: 'intent', action: 'start', label: 'vyper-gaming-production' });
    expect(argv[0]).toBe(cliPath);
    expect(argv.slice(1)).toEqual(expect.arrayContaining(['cc.remote.steering.longrun.intent', '--intent', 'start', '--label', 'vyper-gaming-production', '--longrun-file', promptFile, '--controller-request-id']));
    expect(argv.join(' ')).not.toContain(prompt);
    expect(argv).not.toContain('--slot');
    expect(argv).not.toContain('--session-id');
    expect(argv).not.toContain('--grant-id');
    expect(argv).not.toContain('--lease-id');
    await expect(fs.lstat(promptFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(relay).toHaveBeenCalledTimes(1);
    expect(relay).toHaveBeenCalledWith(intentPayload('start').envelope);
  });

  it('derives the hidden controller request id deterministically from exact MCP request id and never exposes it in the result', async () => {
    const ids: string[] = [];
    setFrontierLongrunCommandRunnerForTests(async (_command, args) => {
      ids.push(args[args.indexOf('--controller-request-id') + 1]!);
      return { exitCode: 0, stdout: JSON.stringify(intentPayload('status')), stderr: '', truncated: false, timedOut: false, durationMs: 1 };
    });
    const call = () => runInCallContext({
      startedAt: Date.now(), transportKey: null, agent: null,
      caller: { transportKey: null, requestId: 'wfr_same_phone_request', conversationId: null, sessionId: null },
      outcome: null, evidence: emptyEvidence()
    }, () => runFrontierLongrunController({ action: 'status', label: 'VYPER Gaming Production' }, async () => relayOutcome('SESSION_STATUS')));
    const first = await call(); const second = await call();
    expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]); expect(ids[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(first)).not.toContain(ids[0]!); expect(JSON.stringify(second)).not.toContain(ids[0]!);
  });

  it('fails closed before child execution when exact ChatGPT request identity is absent', async () => {
    const runner = vi.fn();
    setFrontierLongrunCommandRunnerForTests(runner as never);
    await expect(runFrontierLongrunController(
      { action: 'status', label: 'VYPER Gaming Production' },
      async () => relayOutcome('SESSION_STATUS')
    )).rejects.toThrow('requires ChatGPT request identity');
    expect(runner).not.toHaveBeenCalled();
  });

  it('keeps different semantic tool calls distinct even when ChatGPT reuses one MCP request id for the turn', async () => {
    const ids: string[] = [];
    setFrontierLongrunCommandRunnerForTests(async (_command, args) => {
      ids.push(args[args.indexOf('--controller-request-id') + 1]!);
      const intent = args[args.indexOf('--intent') + 1] as 'status' | 'stop';
      return { exitCode: 0, stdout: JSON.stringify(intentPayload(intent)), stderr: '', truncated: false, timedOut: false, durationMs: 1 };
    });
    const context = () => ({
      startedAt: Date.now(), transportKey: null, agent: null,
      caller: { transportKey: null, requestId: 'wfr_reused_turn_request', conversationId: null, sessionId: null },
      outcome: null, evidence: emptyEvidence()
    });
    await runInCallContext(context(), () => runFrontierLongrunController(
      { action: 'status', label: 'VYPER Gaming Production' }, async () => relayOutcome('SESSION_STATUS')));
    await runInCallContext(context(), () => runFrontierLongrunController(
      { action: 'stop', label: 'VYPER Gaming Production' }, async () => relayOutcome('LOOP_OFF')));
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids.every(id => /^[0-9a-f]{32}$/.test(id))).toBe(true);
  });
  it('rejects malicious/path-like labels before child execution and never accepts controller paths or ids from input', async () => {
    const runner = vi.fn(); setFrontierLongrunCommandRunnerForTests(runner as never);
    expect(normalizeFrontierLongrunControllerLabel('../../other --slot 8')).toBeNull();
    await expect(runFrontierLongrunController({ action: 'status', label: '../../other --slot 8' }, async () => relayOutcome('SESSION_STATUS')))
      .rejects.toThrow('label must normalize');
    expect(runner).not.toHaveBeenCalled();
    await expect(runFrontierLongrunController({ action: 'show', prompt: 'hidden' } as never, async () => relayOutcome('SESSION_STATUS')))
      .rejects.toThrow('show does not accept a prompt');
  });

  it('fails closed on malformed JSON, malformed envelope, action mismatch, or custody loss with zero relay calls', async () => {
    const relay = vi.fn(async () => relayOutcome('SESSION_CREATE'));
    setFrontierLongrunCommandRunnerForTests(async () => ({ exitCode: 0, stdout: '{broken', stderr: '', truncated: false, timedOut: false, durationMs: 1 }));
    await expect(withControllerRequest(() => runFrontierLongrunController({ action: 'start', prompt: 'go', label: 'fixture' }, relay))).rejects.toThrow('malformed JSON');
    expect(relay).not.toHaveBeenCalled();

    const malformed = intentPayload('start'); (malformed.envelope as any).operation.payload.slot = 99;
    setFrontierLongrunCommandRunnerForTests(async () => ({ exitCode: 0, stdout: JSON.stringify(malformed), stderr: '', truncated: false, timedOut: false, durationMs: 1 }));
    await expect(withControllerRequest(() => runFrontierLongrunController({ action: 'start', prompt: 'go', label: 'fixture' }, relay))).rejects.toThrow('malformed signed Longrun envelope');
    expect(relay).not.toHaveBeenCalled();

    const oldVersion = intentPayload('start');
    (oldVersion.envelope as any).verifierContractVersion = 1;
    (oldVersion.envelope.grant.payload as any).verifierContractVersion = 1;
    (oldVersion.envelope.operation.payload as any).verifierContractVersion = 1;
    setFrontierLongrunCommandRunnerForTests(async () => ({ exitCode: 0, stdout: JSON.stringify(oldVersion), stderr: '', truncated: false, timedOut: false, durationMs: 1 }));
    await expect(withControllerRequest(() => runFrontierLongrunController({ action: 'start', prompt: 'go', label: 'fixture' }, relay)))
      .rejects.toThrow('malformed signed Longrun envelope');
    expect(relay).not.toHaveBeenCalled();

    setFrontierLongrunCommandRunnerForTests(async () => ({ exitCode: 0, stdout: JSON.stringify(intentPayload('continue')), stderr: '', truncated: false, timedOut: false, durationMs: 1 }));
    await expect(withControllerRequest(() => runFrontierLongrunController({ action: 'start', prompt: 'go', label: 'fixture' }, relay))).rejects.toThrow('unexpected Longrun intent payload');
    expect(relay).not.toHaveBeenCalled();

    await fs.unlink(cliPath);
    await expect(withControllerRequest(() => runFrontierLongrunController({ action: 'start', prompt: 'go', label: 'fixture' }, relay))).rejects.toThrow('Command Center CLI binding is unavailable');
    expect(relay).not.toHaveBeenCalled();
  });

  it('show invokes only the bounded show command, never relays, and hides grant/fingerprint/slot-number authority', async () => {
    let args: readonly string[] = [];
    setFrontierLongrunCommandRunnerForTests(async (_command, childArgs) => {
      args = childArgs;
      return { exitCode: 0, stdout: JSON.stringify(showPayload()), stderr: '', truncated: false, timedOut: false, durationMs: 1 };
    });
    const relay = vi.fn();
    const result = await withControllerRequest(() => runFrontierLongrunController({ action: 'show' }, relay as never));
    expect(args.slice(0, 2)).toEqual([cliPath, 'cc.remote.steering.longrun.show']);
    expect(args).not.toContain('--intent'); expect(args).not.toContain('--slot');
    expect(relay).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'show', show: { parent: { mission: 'frontier-weekend', focus: 'vyper-gaming-production', allocated: 2, remaining: 6 } } });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('grantDigest'); expect(serialized).not.toContain(fingerprint); expect(serialized).not.toContain('"slot"');
  });

  it.each([
    ['gpt-6-pro', 'pro'],
    ['5.6', 'xhigh'],
    ['gpt-5-6-thinking', 'high'],
  ] as const)('rejects Command Center parent metadata on non-fixed profile %s/%s', async (model, reasoning) => {
    const payload = showPayload(model, reasoning);
    setFrontierLongrunCommandRunnerForTests(async () => ({
      exitCode: 0, stdout: JSON.stringify(payload), stderr: '', truncated: false, timedOut: false, durationMs: 1
    }));
    await expect(withControllerRequest(() => runFrontierLongrunController({ action: 'show' }, vi.fn() as never)))
      .rejects.toThrow('malformed Longrun parent metadata');
  });

  it('keeps frontier_longrun exposed under Remote Steering when command capability is off and read-only is on', async () => {
    const published: Array<{ name: string; inputSchema: Record<string, any> }> = [];
    const ctx: ToolContext = {
      roots: [], caps: { ...DEFAULT_CAPABILITIES, command: false }, exposedCaps: { ...DEFAULT_CAPABILITIES, command: false },
      readOnly: true, sessionTools: false, agentTools: false, remoteSteeringTools: true, exposedRemoteSteeringTools: true,
      exposedFinishTool: false
    };
    const server = buildServer(ctx, 'core', (_name, _version, _instructions, tools) => published.push(...tools as typeof published));
    await server.close();
    const names = published.map(tool => tool.name);
    expect(names).toContain('frontier_longrun');
    expect(names).toContain('remote_steering');
    expect(names).not.toContain('exec_command');
    const schema = published.find(tool => tool.name === 'frontier_longrun')!.inputSchema;
    const schemaText = JSON.stringify(schema);
    for (const forbidden of ['grantId','grant_id','leaseId','lease_id','sessionId','session_id','slot','cwd','ttl','model','reasoning','argv','executable']) {
      expect(schemaText).not.toContain(`"${forbidden}"`);
    }
    const variants = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])] as Array<Record<string, any>>;
    const start = variants.find(branch => branch.properties?.action?.const === 'start' || branch.properties?.action?.enum?.includes('start'));
    expect(start?.required).toEqual(expect.arrayContaining(['action', 'prompt', 'label']));
  });
});
