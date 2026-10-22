import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
const project = vi.hoisted(() => vi.fn());
vi.mock('../src/main/projects.js', () => ({ getSessionProject: project }));
const swarm = vi.hoisted(() => ({ running: false, managed: false, orphanedWorker: false, members: null as Set<string> | null }));
const leaseLookup = vi.hoisted(() => vi.fn());
const leaseValidate = vi.hoisted(() => vi.fn());
vi.mock('../src/main/worktrees/index.js', () => ({ lookupWorkerWorkspace: leaseLookup, validateWorkerWorkspaceLease: leaseValidate }));
vi.mock('../src/main/agents.js', async (original) => ({
  ...(await original<typeof import('../src/main/agents.js')>()),
  swarmRunning: () => swarm.running,
  // The run a chat belongs to: every chat while `members` is unset, else only those listed.
  currentRunId: (conversationId?: string) => swarm.running && (!swarm.members || (conversationId && swarm.members.has(conversationId))) ? 'run-1' : null,
  managedWorkerWorktreeRequired: () => swarm.managed,
  managedWorkerIsolationRequired: () => swarm.managed || swarm.orphanedWorker,
  managedWorkerAllocationIdentity: () => swarm.managed ? { runId: 'owner-allocation', agentId: 'worker-1' } : null
}));
import { resolveCwd, resolveIn } from '../src/main/mcp/kernel.js';
import { emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import { resetWorkspaces, setWorkspaceFor } from '../src/main/workspace.js';
import { defaultConfig } from '../src/main/config.js';
import { makeTempDir, removeTempDir, writeTree } from './helpers.js';
let base = '';
beforeAll(async () => { base = await makeTempDir(); await writeTree(base, { 'a/file.txt': 'a', 'b/file.txt': 'b' }); });
afterAll(async () => { await removeTempDir(base); });
beforeEach(() => {
  resetWorkspaces(); project.mockReset(); leaseLookup.mockReset(); leaseValidate.mockReset();
  leaseValidate.mockImplementation(async lease => lease);
  swarm.running = false; swarm.managed = false; swarm.orphanedWorker = false; swarm.members = null;
});
function run<T>(id: string, fn: () => T): T {
  const context: CallContext = { startedAt: Date.now(), transportKey: null, agent: 'prime', caller: { transportKey: null, requestId: null, conversationId: `chat-${id}`, sessionId: id }, outcome: null, evidence: emptyEvidence() };
  return runInCallContext(context, fn);
}
function workerRun<T>(id: string, fn: () => T): T {
  const context: CallContext = { startedAt: Date.now(), transportKey: null, agent: 'worker-1', caller: { transportKey: null, requestId: null, conversationId: `chat-${id}`, sessionId: id }, outcome: null, evidence: emptyEvidence() };
  return runInCallContext(context, fn);
}
const roots = () => [{ name: 'work', path: base }];
it('initializes simultaneous Prime cwd from each exact durable session project', async () => {
  project.mockImplementation(async (id) => ({ virtual: `/work/${id}`, real: path.join(base, id) }));
  const [a, b] = await Promise.all(['a', 'b'].map(id => run(id, () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, undefined))));
  expect(a?.virtual).toBe('/work/a'); expect(b?.virtual).toBe('/work/b');
  expect((await run('a', () => resolveIn(roots(), 'file.txt'))).real).toBe(path.join(base, 'a', 'file.txt'));
});
it('keeps the explicit project authoritative over learned cwd and revalidates it', async () => {
  project.mockResolvedValue({ virtual: '/work/a', real: path.join(base, 'a') });
  setWorkspaceFor('chat:chat-a', { virtual: '/work/b', real: path.join(base, 'b') });
  expect((await run('a', () => resolveIn(roots(), 'file.txt'))).virtual).toBe('/work/a/file.txt');
  project.mockRejectedValue(new Error('The session project is unavailable'));
  await expect(run('a', () => resolveIn(roots(), '/work/b/file.txt'))).rejects.toThrow('project is unavailable');
  await expect(run('a', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, undefined))).rejects.toThrow('project is unavailable');
});
it('retains the selected project after an absolute path learns a different directory', async () => {
  project.mockResolvedValue({ virtual: '/work/a', real: path.join(base, 'a') });
  await run('a', () => resolveIn(roots(), '/work/b/file.txt'));
  expect((await run('a', () => resolveIn(roots(), 'file.txt'))).real).toBe(path.join(base, 'a', 'file.txt'));
  expect((await run('a', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, undefined))).virtual).toBe('/work/a');
});
it('keeps learned cwd for unfiled chats and permits an explicit per-command workdir', async () => {
  project.mockResolvedValue(null);
  await run('a', () => resolveIn(roots(), '/work/b/file.txt'));
  expect((await run('a', () => resolveIn(roots(), 'file.txt'))).virtual).toBe('/work/b/file.txt');
  project.mockResolvedValue({ virtual: '/work/a', real: path.join(base, 'a') });
  expect((await run('a', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, '/work/b'))).virtual).toBe('/work/b');
  expect((await run('a', () => resolveIn(roots(), 'file.txt'))).virtual).toBe('/work/a/file.txt');
});
it('drops a learned cwd whose folder was deleted instead of failing the next command', async () => {
  project.mockResolvedValue(null);
  await writeTree(base, { 'gone/file.txt': 'g' });
  await run('a', () => resolveIn(roots(), '/work/gone/file.txt'));
  expect((await run('a', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, undefined))).virtual).toBe('/work/gone');
  await removeTempDir(path.join(base, 'gone'));
  const cwd = await run('a', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, undefined));
  expect(cwd).toMatchObject({ virtual: '/work', defaulted: true });
  // An explicit workdir afterwards is learned as the new cwd as usual.
  expect((await run('a', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, '/work/a'))).virtual).toBe('/work/a');
});
it('tells a multi-agent chat its learned cwd was deleted instead of guessing a folder', async () => {
  project.mockResolvedValue(null);
  await writeTree(base, { 'gone2/file.txt': 'g' });
  await run('w', () => resolveIn(roots(), '/work/gone2/file.txt'));
  await removeTempDir(path.join(base, 'gone2'));
  swarm.running = true;
  await expect(run('w', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, undefined)))
    .rejects.toThrow('WORKSPACE_REQUIRED: the folder this chat was working in (/work/gone2) no longer exists');
  // Once forgotten, the next call gets the ordinary refusal, and an explicit workdir works.
  await expect(run('w', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, undefined)))
    .rejects.toThrow('has no proven workspace');
  expect((await run('w', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, '/work/b'))).virtual).toBe('/work/b');
});

it('recovers a managed worker checkout even when its session still names the prime project', async () => {
  swarm.managed = true;
  project.mockResolvedValue({ virtual: '/work/a', real: path.join(base, 'a') });
  leaseLookup.mockReturnValue({ workspace: { virtual: '/work/b', real: path.join(base, 'b') } });
  expect((await workerRun('managed', () => resolveIn(roots(), 'file.txt'))).real).toBe(path.join(base, 'b', 'file.txt'));
  const cwd = await workerRun('managed', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, undefined));
  expect(cwd?.virtual).toBe('/work/b');
  expect(leaseLookup).toHaveBeenCalledWith({ runId: 'owner-allocation', agentId: 'worker-1' });
});

it('keeps an unmanaged legacy worker on its inherited project without requiring a worktree', async () => {
  project.mockResolvedValue({ virtual: '/work/a', real: path.join(base, 'a') });
  expect((await workerRun('legacy', () => resolveIn(roots(), 'file.txt'))).real).toBe(path.join(base, 'a', 'file.txt'));
  expect((await workerRun('legacy', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, undefined)))?.virtual).toBe('/work/a');
  expect(leaseLookup).not.toHaveBeenCalled();
});

it('refuses a required worker checkout when its marker cannot be recovered, even with cached prime cwd', async () => {
  swarm.managed = true;
  project.mockResolvedValue({ virtual: '/work/a', real: path.join(base, 'a') });
  setWorkspaceFor('chat:chat-managed', { virtual: '/work/a', real: path.join(base, 'a') });
  leaseLookup.mockReturnValue(null);
  await expect(workerRun('managed', () => resolveIn(roots(), 'file.txt'))).rejects.toThrow(/WORKTREE_OWNER_UNAVAILABLE/);
  await expect(workerRun('managed', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, undefined))).rejects.toThrow(/WORKTREE_OWNER_UNAVAILABLE/);
});

it('never uses inherited Prime project after the managed worker broker history was evicted', async () => {
  // The durable exact-session worker origin outlives the broker's finite history.
  // It is a refusal fence only, not proof that the disappeared lease can be recovered.
  swarm.orphanedWorker = true;
  project.mockResolvedValue({ virtual: '/work/a', real: path.join(base, 'a') });
  setWorkspaceFor('chat:chat-orphan', { virtual: '/work/a', real: path.join(base, 'a') });
  leaseLookup.mockReturnValue(null);
  await expect(workerRun('orphan', () => resolveIn(roots(), 'file.txt'))).rejects.toThrow(/WORKTREE_OWNER_UNAVAILABLE/);
  await expect(workerRun('orphan', () => resolveIn(roots(), '/work/a/file.txt'))).rejects.toThrow(/WORKTREE_OWNER_UNAVAILABLE/);
  await expect(workerRun('orphan', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, '/work/a')))
    .rejects.toThrow(/WORKTREE_OWNER_UNAVAILABLE/);
  expect(project).not.toHaveBeenCalled();
});

it('blocks a worker relative write and command after its checked-out directory is replaced', async () => {
  swarm.managed = true;
  project.mockResolvedValue({ virtual: '/work/a', real: path.join(base, 'a') });
  const parent = path.join(base, 'swapped-owner-test');
  const original = path.join(parent, 'owned');
  const relocated = path.join(parent, 'old-worktree');
  await fs.mkdir(original, { recursive: true });
  const identity = await fs.stat(original);
  const lease = { workspace: { virtual: '/work/swapped-owner-test/owned', real: original } };
  leaseLookup.mockReturnValue(lease);
  // Simulate the manager's checked inode lease. The real validator additionally checks the
  // marker, Git common-dir, branch and approved root; this tests that the kernel awaits it.
  leaseValidate.mockImplementation(async current => {
    const now = await fs.stat(current.workspace.real);
    if (now.ino !== identity.ino || now.dev !== identity.dev) throw new Error('WORKTREE_PATH_CHANGED');
    return current;
  });
  await fs.rename(original, relocated);
  await fs.mkdir(original);
  const notes = path.join(original, 'notes.txt');
  await fs.writeFile(notes, 'USER-OWNED NOTES - KEEP');
  await expect(workerRun('managed', async () => {
    const target = await resolveIn(roots(), 'notes.txt', { allowMissing: true });
    await fs.writeFile(target.real, 'UNAUTHORIZED');
  })).rejects.toThrow(/WORKTREE_PATH_CHANGED/);
  await expect(workerRun('managed', () => resolveCwd({ roots: roots(), caps: defaultConfig().capabilities, readOnly: false }, undefined)))
    .rejects.toThrow(/WORKTREE_PATH_CHANGED/);
  expect(await fs.readFile(notes, 'utf8')).toBe('USER-OWNED NOTES - KEEP');
  expect(leaseValidate).toHaveBeenCalledTimes(2);
});

// 2026-10-21 (VM): while one chat had a sub-agent run, every other chat outside a project had its
// first command refused with WORKSPACE_REQUIRED, because the check asked whether any run existed.
it('asks only a chat that belongs to a run for an explicit folder', async () => {
  project.mockResolvedValue(null);
  swarm.running = true; swarm.members = new Set(['chat-prime']);
  const ctx = { roots: roots(), caps: defaultConfig().capabilities, readOnly: false };
  expect(await run('other', () => resolveCwd(ctx, undefined))).toMatchObject({ virtual: '/work', defaulted: true });
  await expect(run('prime', () => resolveCwd(ctx, undefined))).rejects.toThrow('has no proven workspace');
});
