/**
 * The folder a chat is working in.
 *
 * Two things are being defended here, and they pull against each other. Shorthand has to
 * work — that is the whole point, and a workspace that keeps forgetting saves nothing — but
 * it must never resolve against *another* chat's folder, because that reads or writes the
 * wrong file with no error to notice. So the tests below are mostly about isolation and
 * about what happens when identity is not available, not about the happy path.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import {
  execOwner,
  execOwnershipDenied,
  noteExecOwner,
  resetExecOwnershipForTests
} from '../src/main/codex/ownership.js';
import { resolveIn } from '../src/main/mcp/kernel.js';
import { SandboxError, resolvePath } from '../src/main/sandbox.js';
import {
  activateAgentWorkspace,
  bindAgentWorkspace,
  currentWorkspace,
  inheritWorkspace,
  moveChatWorkspace,
  parkAgentWorkspace,
  primeWorkspace,
  projectFolderOf,
  resetWorkspaces,
  setWorkspaceFor,
  workspaceEntries,
  workspaceForChat,
  workspaceKey
} from '../src/main/workspace.js';
import type { Root } from '../src/shared/types.js';
import { DIR_LINK, makeTempDir, removeTempDir, writeTree } from './helpers.js';

let base = '';
let approved = '';
let outside = '';
let roots: Root[] = [];

/** Each friendly agent in these path tests has an exact, distinct conversation. */
function asAgent(agent: string | null): CallContext {
  return {
    startedAt: Date.now(),
    transportKey: null,
    agent,
    caller: { transportKey: null, requestId: null, conversationId: agent ? `conv-${agent}` : null },
    outcome: null,
    evidence: emptyEvidence()
  } as CallContext;
}

const run = <T>(agent: string | null, fn: () => T): T => runInCallContext(asAgent(agent), fn);

function asConversation(agent: string | null, conversationId: string): CallContext {
  const context = asAgent(agent);
  context.caller.conversationId = conversationId;
  return context;
}

const runAsConversation = <T>(agent: string | null, conversationId: string, fn: () => T): T =>
  runInCallContext(asConversation(agent, conversationId), fn);

beforeAll(async () => {
  base = await makeTempDir('clf-workspace-');
  approved = path.join(base, 'approved');
  outside = path.join(base, 'outside');
  await writeTree(approved, {
    'project/.git/HEAD': 'ref: refs/heads/main\n',
    'project/package.json': '{"name":"project"}\n',
    'project/src/main/patch.ts': 'export const patch = 1;\n',
    'project/src/renderer/chat.ts': 'export const chat = 1;\n',
    'project/notes.txt': 'top level\n',
    'other/package.json': '{"name":"other"}\n',
    'other/src/index.ts': 'export const other = 1;\n',
    'loose/file.txt': 'no marker anywhere\n'
  });
  await writeTree(outside, { 'secret.txt': 'hunter2\n' });
  await fs.symlink(outside, path.join(approved, 'project', 'escape'), DIR_LINK).catch(() => undefined);
  roots = [{ name: 'workspace', path: approved }];
});

afterAll(async () => {
  await removeTempDir(base);
});

beforeEach(() => {
  resetWorkspaces();
  resetExecOwnershipForTests();
});

describe('live process ownership across chat replacement', () => {
  it('stays with the durable session while its frontend changes from A to B', () => {
    noteExecOwner(101, 'session-a-b');
    noteExecOwner(102, null);
    noteExecOwner(103, 'session-other');

    expect(execOwner(101)).toBe('session-a-b');
    expect(execOwnershipDenied(101, 'session-a-b')).toBe(false);
    expect(execOwnershipDenied(101, 'session-other')).toBe(true);

    expect(execOwner(102)).toBeNull();
    expect(execOwnershipDenied(102, null)).toBe(false);
    expect(execOwnershipDenied(102, 'session-a-b')).toBe(true);
    expect(execOwner(103)).toBe('session-other');
    expect(execOwnershipDenied(103, 'session-other')).toBe(false);
  });
});

describe('who a workspace belongs to', () => {
  it('keys on the exact conversation rather than its reusable friendly id', () => {
    expect(run('worker-1', workspaceKey)).toBe('chat:conv-worker-1');
  });

  it('has no key at all when nothing identifies the caller', () => {
    // Neither an agent nor a single generating chat. The whole safety argument rests on
    // this returning null rather than picking somebody: an unidentified call must not be
    // able to reach another chat's folder, and it cannot leave one behind either.
    expect(run(null, workspaceKey)).toBeNull();
  });

  it('learns nothing when it does not know who is asking', async () => {
    await run(null, () => resolveIn(roots, '/workspace/project/src/main/patch.ts'));
    expect(workspaceEntries()).toEqual([]);
  });
});

describe('learning a folder from the paths a call already uses', () => {
  it('takes the project, not the folder the file happens to sit in', async () => {
    await run('worker-1', () => resolveIn(roots, '/workspace/project/src/main/patch.ts'));
    // `src/main` would be technically true and useless: the next call would have to write
    // `../renderer/chat.ts` and nothing would have been saved.
    expect(run('worker-1', currentWorkspace)?.virtual).toBe('/workspace/project');
  });

  it('lets the next call write the path short', async () => {
    await run('worker-1', () => resolveIn(roots, '/workspace/project/src/main/patch.ts'));
    const resolved = await run('worker-1', () => resolveIn(roots, 'src/renderer/chat.ts'));
    expect(resolved.virtual).toBe('/workspace/project/src/renderer/chat.ts');
    expect(resolved.real).toBe(path.join(approved, 'project', 'src', 'renderer', 'chat.ts'));
  });

  it('does not learn from a relative path', async () => {
    await run('worker-1', () => resolveIn(roots, '/workspace/project/notes.txt'));
    await run('worker-1', () => resolveIn(roots, 'src/main/patch.ts'));
    // Still the project. If shorthand could redefine the base, one loose resolution would
    // decide where the next loose resolution points, and the folder would drift downwards
    // one call at a time.
    expect(run('worker-1', currentWorkspace)?.virtual).toBe('/workspace/project');
  });

  it('follows the chat into another project when it moves', async () => {
    await run('worker-1', () => resolveIn(roots, '/workspace/project/notes.txt'));
    await run('worker-1', () => resolveIn(roots, '/workspace/other/src/index.ts'));
    expect(run('worker-1', currentWorkspace)?.virtual).toBe('/workspace/other');
    const resolved = await run('worker-1', () => resolveIn(roots, 'src/index.ts'));
    expect(resolved.virtual).toBe('/workspace/other/src/index.ts');
  });

  it('falls back to the containing folder where no project marker exists', async () => {
    await run('worker-1', () => resolveIn(roots, '/workspace/loose/file.txt'));
    expect(run('worker-1', currentWorkspace)?.virtual).toBe('/workspace/loose');
  });

  it('never walks above the approved root looking for a marker', async () => {
    // `approved` itself has no marker, and neither should the search be allowed to leave it
    // even if a parent on the real disk did: containment is the boundary here as everywhere.
    const folder = await projectFolderOf(
      { real: path.join(approved, 'loose', 'file.txt'), virtual: '/workspace/loose/file.txt' },
      approved
    );
    expect(folder.virtual).toBe('/workspace/loose');
  });
});

describe("one chat's folder is not another's", () => {
  it('keeps two callers apart', async () => {
    await run('worker-1', () => resolveIn(roots, '/workspace/project/notes.txt'));
    await run('worker-2', () => resolveIn(roots, '/workspace/other/src/index.ts'));
    expect(run('worker-1', currentWorkspace)?.virtual).toBe('/workspace/project');
    expect(run('worker-2', currentWorkspace)?.virtual).toBe('/workspace/other');
  });

  it('resolves the same shorthand to different files for different callers', async () => {
    await run('worker-1', () => resolveIn(roots, '/workspace/project/package.json'));
    await run('worker-2', () => resolveIn(roots, '/workspace/other/package.json'));
    const one = await run('worker-1', () => resolveIn(roots, 'package.json'));
    const two = await run('worker-2', () => resolveIn(roots, 'package.json'));
    expect(one.virtual).toBe('/workspace/project/package.json');
    expect(two.virtual).toBe('/workspace/other/package.json');
  });

  it('refuses shorthand from a caller that has not worked anywhere yet', async () => {
    await run('worker-1', () => resolveIn(roots, '/workspace/project/notes.txt'));
    await expect(run('worker-2', () => resolveIn(roots, 'notes.txt'))).rejects.toThrow(SandboxError);
  });

  it('says what to write instead, rather than complaining about an unknown root', async () => {
    const error = await run('worker-2', () => resolveIn(roots, 'src/main/patch.ts')).catch((e: Error) => e);
    expect(String((error as Error).message)).toContain('/workspace');
    expect(String((error as Error).message)).not.toContain('Unknown root');
  });
});

describe('run-scoped worker inheritance', () => {
  it('isolates two simultaneous worker-1 bootstraps and their exact bound chats', () => {
    setWorkspaceFor('chat:prime-a', { virtual: '/workspace/project', real: path.join(approved, 'project') });
    setWorkspaceFor('chat:prime-b', { virtual: '/workspace/other', real: path.join(approved, 'other') });
    expect(inheritWorkspace('worker-1', 'prime-a', 'run-a')).toBe(true);
    expect(inheritWorkspace('worker-1', 'prime-b', 'run-b')).toBe(true);
    expect(bindAgentWorkspace('worker-1', 'worker-a', 'run-a')).toBe(true);
    expect(bindAgentWorkspace('worker-1', 'worker-b', 'run-b')).toBe(true);
    expect(runAsConversation('worker-1', 'worker-a', currentWorkspace)?.virtual).toBe('/workspace/project');
    expect(runAsConversation('worker-1', 'worker-b', currentWorkspace)?.virtual).toBe('/workspace/other');
    expect(workspaceEntries().filter(row => row.key.startsWith('agent:'))).toEqual([]);
  });
  it('never gives an unproven friendly identity another run workspace', () => {
    setWorkspaceFor('agent:worker-1', { virtual: '/workspace/other', real: path.join(approved, 'other') });
    const context = asAgent('worker-1'); context.caller.conversationId = null;
    expect(runInCallContext(context, workspaceKey)).toBeNull();
    expect(runInCallContext(context, currentWorkspace)).toBeNull();
    expect(inheritWorkspace('worker-1', 'prime-a')).toBe(false);
    expect(bindAgentWorkspace('worker-1', 'worker-a')).toBe(false);
  });
  it('does not borrow a different prime cwd and clears only its own failed inheritance', () => {
    setWorkspaceFor('agent:prime', { virtual: '/workspace/other', real: path.join(approved, 'other') });
    setWorkspaceFor('agent:run-a:worker-1', { virtual: '/workspace/project', real: path.join(approved, 'project') });
    setWorkspaceFor('agent:run-b:worker-1', { virtual: '/workspace/other', real: path.join(approved, 'other') });
    expect(inheritWorkspace('worker-1', 'unknown-prime', 'run-a')).toBe(false);
    expect(primeWorkspace('unknown-prime')).toBeNull();
    expect(bindAgentWorkspace('worker-1', 'worker-a', 'run-a')).toBe(false);
    expect(bindAgentWorkspace('worker-1', 'worker-b', 'run-b')).toBe(true);
    expect(workspaceForChat('worker-b')?.virtual).toBe('/workspace/other');
  });
  it('never replaces work already learned by a bound conversation with stale inheritance', () => {
    setWorkspaceFor('chat:worker-a', { virtual: '/workspace/other', real: path.join(approved, 'other') });
    setWorkspaceFor('agent:run-a:worker-1', { virtual: '/workspace/project', real: path.join(approved, 'project') });
    expect(parkAgentWorkspace('worker-1', 'worker-a', 'run-a')).toBe(true);
    expect(workspaceForChat('worker-a')?.virtual).toBe('/workspace/other');
    expect(activateAgentWorkspace('worker-1', 'missing-chat', 'run-a')).toBe(false);
  });
});

describe('carrying the folder across a compaction', () => {
  // The folder is not written into the brief and re-adopted by the model. It belongs to the
  // durable local session, so it moves with the session's rebind: one map move inside the
  // commit, after the durable write has landed, and therefore not allowed to fail.
  it('moves the compacted chat’s folder to the chat replacing it', () => {
    setWorkspaceFor('chat:conv-a', { virtual: '/workspace/project', real: path.join(approved, 'project') });
    expect(moveChatWorkspace('conv-a', 'conv-b')).toBe(true);
    expect(workspaceForChat('conv-b')?.virtual).toBe('/workspace/project');
  });

  it('leaves nothing behind on the compacted chat', () => {
    // A stale tab still open on chat A must not go on resolving relative paths against a
    // workspace the session has moved on from.
    setWorkspaceFor('chat:conv-a', { virtual: '/workspace/project', real: path.join(approved, 'project') });
    moveChatWorkspace('conv-a', 'conv-b');
    expect(workspaceForChat('conv-a')).toBeNull();
    expect(workspaceEntries().map((entry) => entry.key)).toEqual(['chat:conv-b']);
  });

  it('carries the real folder over, not just the virtual name it is known by', () => {
    // The replacement chat resolves relative paths through this entry, so a move that kept
    // only the virtual path would point the fresh chat at nothing on disk.
    const real = path.join(approved, 'project');
    setWorkspaceFor('chat:conv-a', { virtual: '/workspace/project', real });
    moveChatWorkspace('conv-a', 'conv-b');
    expect(workspaceForChat('conv-b')?.real).toBe(real);
  });

  it('moves nothing when the compacted chat never learned a folder', () => {
    expect(moveChatWorkspace('conv-a', 'conv-b')).toBe(false);
    expect(workspaceEntries()).toEqual([]);
  });

  it('refuses a move that has no two ends to it', () => {
    setWorkspaceFor('chat:conv-a', { virtual: '/workspace/project', real: path.join(approved, 'project') });
    expect(moveChatWorkspace('conv-a', '')).toBe(false);
    expect(moveChatWorkspace('', 'conv-b')).toBe(false);
    expect(moveChatWorkspace('conv-a', 'conv-a')).toBe(false);
    expect(workspaceForChat('conv-a')?.virtual).toBe('/workspace/project');
  });

  it('overwrites whatever the replacement chat had picked up on its own', () => {
    setWorkspaceFor('chat:conv-a', { virtual: '/workspace/project', real: path.join(approved, 'project') });
    setWorkspaceFor('chat:conv-b', { virtual: '/workspace/other', real: path.join(approved, 'other') });
    expect(moveChatWorkspace('conv-a', 'conv-b')).toBe(true);
    expect(workspaceForChat('conv-b')?.virtual).toBe('/workspace/project');
  });
});

describe('the sandbox is still the boundary', () => {
  beforeEach(async () => {
    resetWorkspaces();
    await run('worker-1', () => resolveIn(roots, '/workspace/project/src/main/patch.ts'));
  });

  it('refuses shorthand that climbs out of the workspace', async () => {
    // The point of prefixing before validation rather than joining and normalising: the
    // `..` is still there when checkSegment sees it. `posix.normalize` would have turned
    // this into a clean-looking path with nothing left to refuse.
    await expect(run('worker-1', () => resolveIn(roots, '../other/src/index.ts'))).rejects.toThrow(SandboxError);
  });

  it('refuses shorthand that climbs out of the root', async () => {
    await expect(run('worker-1', () => resolveIn(roots, '../../outside/secret.txt'))).rejects.toThrow(SandboxError);
    await expect(run('worker-1', () => resolveIn(roots, '..\\..\\outside\\secret.txt'))).rejects.toThrow(SandboxError);
  });

  it('refuses a symlink out of the root reached by shorthand', async () => {
    await expect(run('worker-1', () => resolveIn(roots, 'escape/secret.txt'))).rejects.toThrow(SandboxError);
  });

  it('refuses a native drive path even with a workspace set', async () => {
    await expect(run('worker-1', () => resolveIn(roots, path.join(outside, 'secret.txt')))).rejects.toThrow(
      SandboxError
    );
  });

  it('leaves absolute virtual paths meaning exactly what they always meant', async () => {
    const resolved = await run('worker-1', () => resolveIn(roots, '/workspace/other/src/index.ts'));
    expect(resolved.virtual).toBe('/workspace/other/src/index.ts');
    // And the same path resolves identically with no workspace and no call context at all,
    // which is what makes every existing caller and every stored path still correct.
    const legacy = await resolvePath(roots, '/workspace/other/src/index.ts');
    expect(legacy.virtual).toBe(resolved.virtual);
    expect(legacy.real).toBe(resolved.real);
  });

  it('refuses an absolute path that traverses, instead of normalising it away', async () => {
    await expect(run('worker-1', () => resolveIn(roots, '/workspace/project/../../outside/secret.txt'))).rejects.toThrow(
      SandboxError
    );
  });
});
