import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FRONTIER_LONGRUN_PARENT_MODEL,
  FRONTIER_LONGRUN_PARENT_REASONING,
} from '../src/main/frontier-longrun-parent-contract.js';
import {
  resetFrontierLongrunControllerForTests,
  setFrontierLongrunCommandBindingForTests,
  setFrontierLongrunCommandRunnerForTests,
} from '../src/main/frontier-longrun-controller.js';
import { emptyEvidence, runInCallContext } from '../src/main/mcp/call-context.js';
import { createRegistrar } from '../src/main/mcp/kernel.js';
import { registerCoreTools } from '../src/main/mcp/tools-core.js';
import { buildServer, type ToolContext } from '../src/main/mcp/tools.js';
import {
  resetTravelParentControllerForTests,
  runTravelParentController,
  setTravelParentCommandBindingForTests,
  setTravelParentCommandRunnerForTests,
} from '../src/main/travel-parent-controller.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
let nodePath: string;
let cliPath: string;
const digest = (char: string) => char.repeat(64);
const fixedIntent =
  'Travel Parent V1 derivative Frontier Longrun child.\n' +
  'This application-owned operator intent grants no T3 authority; no commit, push, merge, deploy, release, credentials, provider selection, model selection, shell, routing, landing, or governance authority.\n' +
  'It authorizes only the bounded Frontier Longrun child derived by Command Center from the live Travel Parent.\n';
const fixedIntentDigest = createHash('sha256').update(Buffer.from(fixedIntent, 'utf8')).digest('hex');

function parentPayload(overrides: Record<string, unknown> = {}) {
  return {
    allowedChildFamilies: ['frontier_longrun_parent', 'frontier_manual_session'],
    allowedScopes: ['command_center', 'nkb', 'vyper'],
    maxChildrenTotal: 9,
    maxChildrenPerScope: 3,
    childrenUsedTotal: 1,
    childrenUsedByScope: { command_center: 0, nkb: 0, vyper: 1 },
    issuedAt: '2026-09-18T14:00:00.000Z',
    expiresAt: '2026-09-25T14:00:00.000Z',
    signingKeyFingerprint: digest('f'),
    operatorIntentDigest: digest('a'),
    travelParentDigest: digest('b'),
    live: true,
    revoked: false,
    ...overrides,
  };
}

function childPayload(
  missionId = 'tp-vyper-vyper-gaming',
  mission = 'Ship the bounded VYPER Travel Parent child.',
  overrides: Record<string, unknown> = {}
) {
  return {
    missionId,
    missionDigest: createHash('sha256').update(Buffer.from(mission, 'utf8')).digest('hex'),
    maxSlots: 8,
    allocatedSlots: 0,
    remainingSlots: 8,
    focusSlot: null,
    textClaimsUsed: 0,
    textClaimsRemaining: 64,
    issuedAt: '2026-09-18T14:05:00.000Z',
    expiresAt: '2026-09-21T14:05:00.000Z',
    signingKeyFingerprint: digest('f'),
    operatorIntentDigest: fixedIntentDigest,
    grantDigest: digest('e'),
    model: FRONTIER_LONGRUN_PARENT_MODEL,
    reasoning: FRONTIER_LONGRUN_PARENT_REASONING,
    live: true,
    revoked: false,
    ...overrides,
  };
}

function createPayload(
  scope = 'vyper',
  missionId = `tp-${scope}-vyper-gaming`,
  mission = 'Ship the bounded VYPER Travel Parent child.',
  overrides: Record<string, unknown> = {}
) {
  return {
    command: 'cc.remote.steering.travel-parent.longrun.create',
    mode: 'issued',
    status: 'ok',
    scope,
    parent: parentPayload(),
    child: childPayload(missionId, mission),
    certificateDigest: digest('9'),
    replay: false,
    reason: null,
    warnings: [],
    ...overrides,
  };
}

function showPayload(overrides: Record<string, unknown> = {}) {
  return {
    command: 'cc.remote.steering.travel-parent.show',
    status: 'ok',
    parent: parentPayload(),
    reason: null,
    warnings: [],
    ...overrides,
  };
}

function longrunParentPayload(overrides: Record<string, unknown> = {}) {
  return {
    missionId: 'existing-longrun',
    missionDigest: digest('1'),
    maxSlots: 8,
    allocatedSlots: 0,
    remainingSlots: 8,
    focusSlot: null,
    textClaimsUsed: 0,
    textClaimsRemaining: 64,
    issuedAt: '2026-09-18T14:00:00.000Z',
    expiresAt: '2026-09-21T14:00:00.000Z',
    signingKeyFingerprint: digest('2'),
    operatorIntentDigest: digest('3'),
    grantDigest: digest('4'),
    model: FRONTIER_LONGRUN_PARENT_MODEL,
    reasoning: FRONTIER_LONGRUN_PARENT_REASONING,
    live: true,
    revoked: false,
    ...overrides,
  };
}

function longrunShowPayload(overrides: Record<string, unknown> = {}) {
  return {
    command: 'cc.remote.steering.longrun.show',
    status: 'ok',
    parent: longrunParentPayload(),
    slots: [],
    reason: null,
    warnings: [],
    ...overrides,
  };
}

function longrunAbsentPayload() {
  return {
    command: 'cc.remote.steering.longrun.show',
    status: 'refused',
    parent: null,
    slots: [],
    reason: 'FRONTIER_LONGRUN_PARENT_ABSENT',
    warnings: ['absent'],
  };
}

function revokePayload(replay = false, overrides: Record<string, unknown> = {}) {
  return {
    command: 'cc.remote.steering.travel-parent.revoke',
    mode: 'revoked',
    status: 'ok',
    parent: parentPayload({ live: false, revoked: true }),
    replay,
    reason: null,
    warnings: [],
    ...overrides,
  };
}

function withRequest<T>(work: () => T, requestId = 'wfr_travel_parent_fixture'): T {
  return runInCallContext({
    startedAt: Date.now(),
    transportKey: null,
    agent: null,
    caller: { transportKey: null, requestId, conversationId: null, sessionId: null },
    outcome: null,
    evidence: emptyEvidence(),
  }, work);
}

function argAfter(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) throw new Error(`missing ${flag}`);
  return args[index + 1]!;
}

async function travelTempFiles(): Promise<string[]> {
  return (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('cos-travel-parent-')).sort();
}

beforeEach(async () => {
  directory = await makeTempDir('cos-travel-parent-controller-');
  nodePath = path.join(directory, 'node.exe');
  cliPath = path.join(directory, 'main.js');
  await fs.writeFile(nodePath, 'fixture');
  await fs.writeFile(cliPath, 'fixture');
  setTravelParentCommandBindingForTests({ nodePath, cliPath, cwd: directory });
  setFrontierLongrunCommandBindingForTests({ nodePath, cliPath, cwd: directory });
  setFrontierLongrunCommandRunnerForTests(async () => ({
    exitCode: 0,
    stdout: JSON.stringify(longrunAbsentPayload()),
    stderr: '', truncated: false, timedOut: false, durationMs: 1
  }));
});

afterEach(async () => {
  resetTravelParentControllerForTests();
  resetFrontierLongrunControllerForTests();
  vi.useRealTimers();
  await removeTempDir(directory);
});

describe('travel_parent controller adapter', () => {
  it('uses exact pinned argv, app-owned 0600 temp inputs, fixed operator intent, and cleans both files', async () => {
    const mission = 'Ship the bounded VYPER Travel Parent child.';
    let argv: readonly string[] = [];
    let missionFile = '';
    let intentFile = '';
    setTravelParentCommandRunnerForTests(async (command, args, cwd) => {
      expect(command).toBe(nodePath);
      expect(cwd).toBe(directory);
      argv = args;
      missionFile = argAfter(args, '--mission-file');
      intentFile = argAfter(args, '--operator-intent-file');
      expect(await fs.readFile(missionFile, 'utf8')).toBe(mission);
      const intent = await fs.readFile(intentFile, 'utf8');
      expect(intent).toBe(fixedIntent);
      for (const denied of ['T3', 'commit', 'push', 'merge', 'deploy', 'release', 'credentials', 'provider selection', 'model selection', 'shell', 'routing', 'landing', 'governance']) {
        expect(intent).toContain(denied);
      }
      const missionMode = (await fs.stat(missionFile)).mode & 0o777;
      const intentMode = (await fs.stat(intentFile)).mode & 0o777;
      if (process.platform !== 'win32') {
        expect(missionMode).toBe(0o600);
        expect(intentMode).toBe(0o600);
      }
      return { exitCode: 0, stdout: JSON.stringify(createPayload()), stderr: '', truncated: false, timedOut: false, durationMs: 1 };
    });

    const result = await withRequest(() => runTravelParentController({
      action: 'create_longrun', scope: 'vyper', mission, label: 'VYPER Gaming'
    }));

    const requestId = argAfter(argv, '--travel-parent-request-id');
    expect(argv).toEqual([
      cliPath,
      'cc.remote.steering.travel-parent.longrun.create',
      '--scope', 'vyper',
      '--travel-parent-request-id', requestId,
      '--mission-id', 'tp-vyper-vyper-gaming',
      '--mission-file', missionFile,
      '--operator-intent-file', intentFile,
      '--ttl-seconds', '259200',
      '--confirm',
    ]);
    expect(requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(argv.join(' ')).not.toContain(mission);
    for (const forbidden of ['--cwd','--argv','--root','--grant-id','--session-id','--slot','--model','--reasoning','--provider']) {
      expect(argv).not.toContain(forbidden);
    }
    expect(JSON.stringify(result)).not.toContain(requestId);
    expect(JSON.stringify(result)).not.toContain(digest('9'));
    expect(JSON.stringify(result)).not.toContain(digest('f'));
    await expect(fs.lstat(missionFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(intentFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('blocks a live singleton Longrun before temp files or Travel Parent child issuance', async () => {
    const travelRunner = vi.fn();
    setTravelParentCommandRunnerForTests(travelRunner as never);
    setFrontierLongrunCommandRunnerForTests(async (_command, args) => {
      expect(args.slice(0, 2)).toEqual([cliPath, 'cc.remote.steering.longrun.show']);
      expect(args).toContain('--controller-request-id');
      return {
        exitCode: 0,
        stdout: JSON.stringify(longrunShowPayload()),
        stderr: '', truncated: false, timedOut: false, durationMs: 1
      };
    });
    const before = await travelTempFiles();

    const result = await withRequest(() => runTravelParentController({
      action: 'create_longrun', scope: 'vyper', mission: 'new mission', label: 'new-mission'
    }));

    expect(result).toEqual({
      kind: 'create_longrun_blocked',
      scope: 'vyper',
      label: 'new-mission',
      reason: 'frontier_longrun_parent_live',
      nextAction: 'frontier_longrun',
      existing: { mission: 'existing-longrun', expiresAt: '2026-09-21T14:00:00.000Z', focus: null },
      guidance: expect.stringContaining('requested mission was not attached'),
    });
    expect(travelRunner).not.toHaveBeenCalled();
    expect(await travelTempFiles()).toEqual(before);
  });

  it.each([
    ['absent', longrunAbsentPayload()],
    ['expired', longrunShowPayload({ parent: longrunParentPayload({ live: false, revoked: false }) })],
    ['revoked', longrunShowPayload({ parent: longrunParentPayload({ live: false, revoked: true }) })],
  ] as const)('permits create when the singleton Longrun is %s', async (_state, preflightPayload) => {
    setFrontierLongrunCommandRunnerForTests(async () => ({
      exitCode: 0,
      stdout: JSON.stringify(preflightPayload),
      stderr: '', truncated: false, timedOut: false, durationMs: 1
    }));
    const travelRunner = vi.fn(async (_command: string, args: readonly string[]) => {
      const missionId = argAfter(args, '--mission-id');
      const mission = await fs.readFile(argAfter(args, '--mission-file'), 'utf8');
      return {
        exitCode: 0,
        stdout: JSON.stringify(createPayload('vyper', missionId, mission)),
        stderr: '', truncated: false, timedOut: false, durationMs: 1
      };
    });
    setTravelParentCommandRunnerForTests(travelRunner as never);

    await expect(withRequest(() => runTravelParentController({
      action: 'create_longrun', scope: 'vyper', mission: 'mission', label: 'fixture'
    }))).resolves.toMatchObject({ kind: 'create_longrun', scope: 'vyper', label: 'fixture' });
    expect(travelRunner).toHaveBeenCalledTimes(1);
    expect(travelRunner.mock.calls[0]![1][1]).toBe('cc.remote.steering.travel-parent.longrun.create');
  });

  it.each([
    ['malformed parent', longrunShowPayload({ parent: { broken: true } })],
    ['indeterminate absence', longrunShowPayload({ parent: null })],
    ['refused state', { ...longrunAbsentPayload(), reason: 'FRONTIER_LONGRUN_PARENT_REVOKED' }],
  ] as const)('fails closed on %s before temp files or Travel Parent child issuance', async (_case, preflightPayload) => {
    setFrontierLongrunCommandRunnerForTests(async () => ({
      exitCode: 0,
      stdout: JSON.stringify(preflightPayload),
      stderr: '', truncated: false, timedOut: false, durationMs: 1
    }));
    const travelRunner = vi.fn();
    setTravelParentCommandRunnerForTests(travelRunner as never);
    const before = await travelTempFiles();

    await expect(withRequest(() => runTravelParentController({
      action: 'create_longrun', scope: 'vyper', mission: 'mission', label: 'fixture'
    }))).rejects.toThrow(/preflight (failed closed|returned indeterminate)/);
    expect(travelRunner).not.toHaveBeenCalled();
    expect(await travelTempFiles()).toEqual(before);
  });

  it('keeps exact retries on one hidden request id and changes it when semantic inputs change', async () => {
    const ids: string[] = [];
    setTravelParentCommandRunnerForTests(async (_command, args) => {
      ids.push(argAfter(args, '--travel-parent-request-id'));
      const scope = argAfter(args, '--scope');
      const missionId = argAfter(args, '--mission-id');
      const mission = await fs.readFile(argAfter(args, '--mission-file'), 'utf8');
      const ttlSeconds = Number(argAfter(args, '--ttl-seconds'));
      const issuedAt = '2026-09-18T14:05:00.000Z';
      const expiresAt = new Date(Date.parse(issuedAt) + ttlSeconds * 1000).toISOString();
      return {
        exitCode: 0,
        stdout: JSON.stringify(createPayload(scope, missionId, mission, {
          child: childPayload(missionId, mission, { issuedAt, expiresAt })
        })),
        stderr: '', truncated: false, timedOut: false, durationMs: 1
      };
    });
    const input = { action: 'create_longrun' as const, scope: 'vyper' as const, mission: 'same exact mission', label: 'same-label', ttl_hours: 12 };
    await withRequest(() => runTravelParentController(input), 'wfr_same_tp_request');
    await withRequest(() => runTravelParentController(input), 'wfr_same_tp_request');
    await withRequest(() => runTravelParentController({ ...input, ttl_hours: 13 }), 'wfr_same_tp_request');
    await withRequest(() => runTravelParentController({ ...input, mission: 'changed mission' }), 'wfr_same_tp_request');
    await withRequest(() => runTravelParentController({ ...input, label: 'changed-label' }), 'wfr_same_tp_request');
    await withRequest(() => runTravelParentController({ ...input, scope: 'nkb' }), 'wfr_same_tp_request');
    expect(ids).toHaveLength(6);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(ids[3]).not.toBe(ids[0]);
    expect(ids[4]).not.toBe(ids[0]);
    expect(ids[5]).not.toBe(ids[0]);
    expect(new Set(ids).size).toBe(5);
    expect(ids.every(id => /^[0-9a-f]{32}$/.test(id))).toBe(true);
  });

  it('accepts a bounded delayed replay view after the derived Longrun child has been used', async () => {
    setTravelParentCommandRunnerForTests(async (_command, args) => {
      const missionId = argAfter(args, '--mission-id');
      return {
        exitCode: 0,
        stdout: JSON.stringify(createPayload('vyper', missionId, 'same exact mission', {
          replay: true,
          child: childPayload(missionId, 'same exact mission', {
            allocatedSlots: 3,
            remainingSlots: 5,
            focusSlot: 2,
            textClaimsUsed: 11,
            textClaimsRemaining: 53,
            expiresAt: '2026-09-19T02:05:00.000Z',
          }),
        })),
        stderr: '', truncated: false, timedOut: false, durationMs: 1
      };
    });
    await expect(withRequest(() => runTravelParentController({
      action: 'create_longrun', scope: 'vyper', mission: 'same exact mission', label: 'same-label', ttl_hours: 12
    }), 'wfr_delayed_replay')).resolves.toMatchObject({ kind: 'create_longrun', replay: true });
  });

  it('refuses missing exact request identity before runner or temp-file creation', async () => {
    const runner = vi.fn();
    setTravelParentCommandRunnerForTests(runner as never);
    const before = await travelTempFiles();
    await expect(runTravelParentController({
      action: 'create_longrun', scope: 'vyper', mission: 'mission', label: 'fixture'
    })).rejects.toThrow('requires ChatGPT request identity');
    const after = await travelTempFiles();
    expect(after).toEqual(before);
    expect(runner).not.toHaveBeenCalled();
  });

  it('cleans temp files when CC output is malformed or explicitly refused', async () => {
    const files: string[] = [];
    setTravelParentCommandRunnerForTests(async (_command, args) => {
      files.push(argAfter(args, '--mission-file'), argAfter(args, '--operator-intent-file'));
      return { exitCode: 0, stdout: '{broken', stderr: '', truncated: false, timedOut: false, durationMs: 1 };
    });
    await expect(withRequest(() => runTravelParentController({
      action: 'create_longrun', scope: 'vyper', mission: 'mission', label: 'fixture'
    }))).rejects.toThrow('malformed JSON');
    for (const file of files) await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });

    files.length = 0;
    setTravelParentCommandRunnerForTests(async (_command, args) => {
      files.push(argAfter(args, '--mission-file'), argAfter(args, '--operator-intent-file'));
      return {
        exitCode: 0,
        stdout: JSON.stringify(createPayload('vyper', 'tp-vyper-fixture', 'mission', {
          status: 'refused', parent: parentPayload(), child: null, certificateDigest: null,
          replay: false, reason: 'TRAVEL_PARENT_CAPACITY_EXHAUSTED', warnings: ['full']
        })),
        stderr: '', truncated: false, timedOut: false, durationMs: 1
      };
    });
    await expect(withRequest(() => runTravelParentController({
      action: 'create_longrun', scope: 'vyper', mission: 'mission', label: 'fixture'
    }))).rejects.toThrow('TRAVEL_PARENT_CAPACITY_EXHAUSTED');
    for (const file of files) await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('binds successful CC output back to the exact mission, fixed intent, and requested TTL', async () => {
    const cases = [
      { child: childPayload('tp-vyper-fixture', 'different mission'), expected: 'mission digest' },
      { child: childPayload('tp-vyper-fixture', 'mission', { operatorIntentDigest: digest('7') }), expected: 'operator-intent digest' },
      { child: childPayload('tp-vyper-fixture', 'mission', { expiresAt: '2026-09-20T14:05:00.000Z' }), expected: 'signed window' },
    ];
    for (const fixture of cases) {
      setTravelParentCommandRunnerForTests(async () => ({
        exitCode: 0,
        stdout: JSON.stringify(createPayload('vyper', 'tp-vyper-fixture', 'mission', { child: fixture.child })),
        stderr: '', truncated: false, timedOut: false, durationMs: 1
      }));
      await expect(withRequest(() => runTravelParentController({
        action: 'create_longrun', scope: 'vyper', mission: 'mission', label: 'fixture', ttl_hours: 72
      }))).rejects.toThrow(fixture.expected);
    }
  });

  it('uses only pinned show/revoke commands, accepts no conversation identity, and strictly projects bounded metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T14:00:00.000Z'));
    const calls: readonly string[][] = [] as unknown as string[][];
    setTravelParentCommandRunnerForTests(async (_command, args) => {
      (calls as string[][]).push([...args]);
      const payload = args[1] === 'cc.remote.steering.travel-parent.show' ? showPayload() : revokePayload(false);
      return { exitCode: 0, stdout: JSON.stringify(payload), stderr: '', truncated: false, timedOut: false, durationMs: 1 };
    });
    const show = await runTravelParentController({ action: 'show' });
    const revoke = await runTravelParentController({ action: 'revoke' });
    expect(calls).toEqual([
      [cliPath, 'cc.remote.steering.travel-parent.show'],
      [cliPath, 'cc.remote.steering.travel-parent.revoke', '--confirm'],
    ]);
    expect(show).toMatchObject({
      kind: 'show',
      parent: {
        childrenUsedTotal: 1,
        remainingChildrenTotal: 8,
        remainingChildrenByScope: { command_center: 3, nkb: 3, vyper: 2 },
        live: true,
        revoked: false,
      },
      renewal: { state: 'not_due', attendedPcRequired: false },
    });
    expect(revoke).toMatchObject({ kind: 'revoke', replay: false, parent: { live: false, revoked: true } });
    const serialized = JSON.stringify({ show, revoke });
    for (const hidden of ['signingKeyFingerprint','operatorIntentDigest','travelParentDigest','certificateDigest','grantDigest']) {
      expect(serialized).not.toContain(hidden);
    }
  });

  it('projects zero capacity for disallowed scopes and warns at the exact 24-hour attended-renewal boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T14:00:00.000Z'));
    let expiresAt = '2026-09-19T14:00:00.000Z';
    setTravelParentCommandRunnerForTests(async () => ({
      exitCode: 0,
      stdout: JSON.stringify(showPayload({
        parent: parentPayload({
          allowedScopes: ['command_center', 'vyper'],
          childrenUsedTotal: 3,
          childrenUsedByScope: { command_center: 1, nkb: 0, vyper: 2 },
          expiresAt,
        })
      })),
      stderr: '', truncated: false, timedOut: false, durationMs: 1
    }));

    await expect(runTravelParentController({ action: 'show' })).resolves.toMatchObject({
      parent: {
        remainingChildrenTotal: 3,
        remainingChildrenByScope: { command_center: 2, nkb: 0, vyper: 1 },
      },
      renewal: { state: 'due_within_24h', attendedPcRequired: true },
    });

    vi.setSystemTime(new Date('2026-09-18T13:59:59.999Z'));
    await expect(runTravelParentController({ action: 'show' })).resolves.toMatchObject({
      renewal: { state: 'not_due', attendedPcRequired: false },
    });
  });

  it('refuses malformed/refused show and revoke payloads instead of projecting them', async () => {
    setTravelParentCommandRunnerForTests(async () => ({
      exitCode: 0,
      stdout: JSON.stringify(showPayload({ status: 'refused', parent: null, reason: 'TRAVEL_PARENT_ABSENT', warnings: ['absent'] })),
      stderr: '', truncated: false, timedOut: false, durationMs: 1
    }));
    await expect(runTravelParentController({ action: 'show' })).rejects.toThrow('TRAVEL_PARENT_ABSENT');

    setTravelParentCommandRunnerForTests(async () => ({
      exitCode: 0,
      stdout: JSON.stringify(revokePayload(false, { parent: parentPayload({ live: true, revoked: false }) })),
      stderr: '', truncated: false, timedOut: false, durationMs: 1
    }));
    await expect(runTravelParentController({ action: 'revoke' })).rejects.toThrow('non-revoked parent');
  });

  it('requires the exact canonical Travel Parent child-family list', async () => {
    for (const allowedChildFamilies of [
      ['frontier_longrun_parent'],
      ['frontier_manual_session', 'frontier_longrun_parent'],
      ['frontier_longrun_parent', 'frontier_manual_session', 'unexpected_family'],
    ]) {
      setTravelParentCommandRunnerForTests(async () => ({
        exitCode: 0,
        stdout: JSON.stringify(showPayload({ parent: parentPayload({ allowedChildFamilies }) })),
        stderr: '', truncated: false, timedOut: false, durationMs: 1
      }));
      await expect(runTravelParentController({ action: 'show' })).rejects.toThrow('child-family metadata');
    }
  });

  it('publishes a closed schema with no caller path, authority, session, or model selectors', async () => {
    const published: Array<{ name: string; description?: string; inputSchema: Record<string, any>; annotations?: { destructiveHint?: boolean } }> = [];
    const ctx: ToolContext = {
      roots: [],
      caps: { ...DEFAULT_CAPABILITIES, command: false },
      exposedCaps: { ...DEFAULT_CAPABILITIES, command: false },
      readOnly: true,
      sessionTools: false,
      agentTools: false,
      remoteSteeringTools: true,
      exposedRemoteSteeringTools: true,
      exposedFinishTool: false,
    };
    const server = buildServer(ctx, 'core', (_name, _version, _instructions, tools) => published.push(...tools as typeof published));
    await server.close();
    const travelTool = published.find(tool => tool.name === 'travel_parent')!;
    expect(travelTool.annotations?.destructiveHint).toBe(true);
    expect(travelTool.description).toContain('callers MUST use frontier_longrun show');
    expect(travelTool.description).toContain('permission prompts are separate from Travel Parent expiry/recertification');
    const schema = travelTool.inputSchema;
    const schemaText = JSON.stringify(schema);
    for (const forbidden of [
      'path','cwd','argv','executable','root','rootId','root_id','grant','grantId','grant_id','session','sessionId','session_id',
      'slot','model','reasoning','provider','operator_intent','operatorIntent','travel_parent_request_id','travel-parent-request-id'
    ]) {
      expect(schemaText).not.toContain(`\"${forbidden}\"`);
    }
    const variants = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])] as Array<Record<string, any>>;
    expect(variants).toHaveLength(3);
    for (const branch of variants) expect(branch.additionalProperties).toBe(false);
    const create = variants.find(branch => branch.properties?.action?.const === 'create_longrun' || branch.properties?.action?.enum?.includes('create_longrun'));
    expect(create?.required).toEqual(expect.arrayContaining(['action', 'scope', 'mission', 'label']));
    expect(create?.properties?.ttl_hours).toBeDefined();

    let liveSchema: import('zod').ZodType | undefined;
    const registrar = createRegistrar(null, ctx, 'core', (name, config) => {
      if (name === 'travel_parent') liveSchema = config.inputSchema;
    });
    registerCoreTools(registrar);
    expect(liveSchema).toBeDefined();
    const baseline = { action: 'create_longrun', scope: 'vyper', mission: 'bounded mission', label: 'fixture' };
    for (const extra of [
      { path: 'C:\\secret' },
      { model: 'gpt-6-pro' },
      { root: 'root-id' },
      { session: 'session-id' },
      { operator_intent: 'caller supplied' },
      { 'travel-parent-request-id': 'a'.repeat(32) },
    ]) {
      expect((await liveSchema!.safeParseAsync({ ...baseline, ...extra })).success).toBe(false);
    }
    expect((await liveSchema!.safeParseAsync({ action: 'show', path: 'C:\\secret' })).success).toBe(false);
    expect((await liveSchema!.safeParseAsync({ action: 'revoke', model: 'gpt-6-pro' })).success).toBe(false);
    expect((await liveSchema!.safeParseAsync({ action: 'create', scope: 'vyper', mission: 'x', label: 'x' })).success).toBe(false);
    expect((await liveSchema!.safeParseAsync({ action: 'create_root' })).success).toBe(false);
  });
});
