import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Root } from '../src/shared/types.js';
import { gitExecutable } from '../src/main/project-git.js';
import {
  allocWorkerWorkspace,
  diffWorkerWorkspace,
  finalizeWorkerWorkspace,
  inspectWorkerWorkspaceForCleanup,
  listOfferedWorkerWorktrees,
  disposeOfferedWorkerWorktree,
  lookupWorkerWorkspace,
  resetWorkerWorktreeRegistryForTests,
  restoreManagedWorktrees,
  validateWorkerWorkspaceLease
} from '../src/main/worktrees/index.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN_ID = '22222222-2222-4222-8222-222222222222';
const ACCEPTED = [{ runId: RUN_ID, agentId: 'worker-1' }] as const;

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  env['GIT_TERMINAL_PROMPT'] = '0';
  return env;
}

function git(cwd: string, args: string[]): string {
  return execFileSync(gitExecutable(), args, { cwd, env: gitEnv(), encoding: 'utf8', windowsHide: true }).replaceAll('\r', '').trim();
}

async function write(file: string, value: string): Promise<void> {
  await fs.writeFile(file, value, 'utf8');
}

async function commit(repo: string, message: string): Promise<string> {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

describe('automatic worker Git worktrees', () => {
  let temp = '';
  let approved = '';
  let repo = '';
  let roots: Root[] = [];

  beforeEach(async () => {
    resetWorkerWorktreeRegistryForTests();
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-worktrees-'));
    approved = path.join(temp, 'approved');
    repo = path.join(approved, 'repo');
    await fs.mkdir(repo, { recursive: true });
    git(repo, ['init']);
    git(repo, ['config', 'user.name', 'CoS Worktree Test']);
    git(repo, ['config', 'user.email', 'worktree-test@example.invalid']);
    git(repo, ['config', 'core.autocrlf', 'false']);
    await write(path.join(repo, 'file.txt'), 'base\n');
    await commit(repo, 'base');
    roots = [{ name: 'approved', path: approved }];
  });

  afterEach(async () => {
    resetWorkerWorktreeRegistryForTests();
    await fs.rm(temp, { recursive: true, force: true });
  });

  const allocate = () => allocWorkerWorkspace({
    runId: RUN_ID,
    agentId: 'worker-1',
    primeWorkspace: { real: repo, virtual: '/approved/repo' },
    approvedRoots: roots
  });

  it('allocates outside the source repo and preserves pre-existing dirty source changes', async () => {
    await write(path.join(repo, 'file.txt'), 'source dirty\n');
    const lease = await allocate();

    expect(lease.sourceDirty).toBe(true);
    expect(path.relative(repo, lease.worktreePath).startsWith(`..${path.sep}`)).toBe(true);
    expect(lease.workspace.virtual).toContain('/approved/.chat-on-steroids-worktrees/');
    expect(await fs.readFile(path.join(lease.workspace.real, 'file.txt'), 'utf8')).toBe('base\n');
    expect(await fs.readFile(path.join(repo, 'file.txt'), 'utf8')).toBe('source dirty\n');
    expect(lookupWorkerWorkspace({ runId: RUN_ID, agentId: 'worker-1' })?.ownershipToken).toBe(lease.ownershipToken);

    const finalized = await finalizeWorkerWorkspace({
      lease,
      reason: 'cancelled',
      discardChanges: true,
      branch: { mode: 'discard' }
    });
    expect(finalized).toMatchObject({ removed: true, branchRemoved: true });
    expect(await fs.readFile(path.join(repo, 'file.txt'), 'utf8')).toBe('source dirty\n');
    expect(git(repo, ['status', '--porcelain'])).toContain('file.txt');
  });

  it('reports fresh allocation provenance and never claims ownership of a recovered lease', async () => {
    const first = await allocate();
    expect(first.newlyCreated).toBe(true);
    const recovered = await allocate();
    expect(recovered.newlyCreated).toBe(false);
    expect(recovered.ownershipToken).toBe(first.ownershipToken);
    expect(await fs.stat(first.worktreePath).then(stat => stat.isDirectory())).toBe(true);
    await finalizeWorkerWorkspace({ lease: first, reason: 'cancelled', discardChanges: true, branch: { mode: 'discard' } });
  });

  it('allocates, validates and restores the owning root while an unrelated approved root is unavailable', async () => {
    const offlineRoot = { name: 'offline', path: path.join(temp, 'disconnected-drive') };
    roots.push(offlineRoot);
    await write(path.join(repo, 'file.txt'), 'user source edit\n');

    const lease = await allocate();
    expect(lease.newlyCreated).toBe(true);
    expect(lease.approvedRoot).toEqual({ name: 'approved', path: approved });
    await expect(validateWorkerWorkspaceLease(lease, roots)).resolves.toMatchObject({
      ownershipToken: lease.ownershipToken
    });
    expect(lookupWorkerWorkspace({ runId: RUN_ID, agentId: 'worker-1' })?.ownershipToken).toBe(lease.ownershipToken);
    expect(await fs.readFile(path.join(repo, 'file.txt'), 'utf8')).toBe('user source edit\n');
    expect(await fs.readFile(path.join(lease.worktreePath, 'file.txt'), 'utf8')).toBe('base\n');

    resetWorkerWorktreeRegistryForTests();
    const restored = await restoreManagedWorktrees(roots, ACCEPTED);
    expect(restored.rejected).toEqual([]);
    expect(restored.restored).toHaveLength(1);
    await expect(validateWorkerWorkspaceLease(restored.restored[0]!, roots)).resolves.toMatchObject({
      ownershipToken: lease.ownershipToken
    });
    await finalizeWorkerWorkspace({ lease, reason: 'cancelled', discardChanges: true, branch: { mode: 'discard' } });
    expect(await fs.readFile(path.join(repo, 'file.txt'), 'utf8')).toBe('user source edit\n');
  });

  it('accepts the originally approved filesystem alias across validation, restart and cleanup', async () => {
    // macOS tmpdirs may be spelled /var/... but have /private/var/... as their
    // realpath. Use an explicit symlink/junction to exercise that distinction
    // on Windows and Linux too.
    const alias = path.join(temp, 'approved-alias');
    await fs.symlink(approved, alias, process.platform === 'win32' ? 'junction' : 'dir');
    roots = [{ name: 'approved', path: alias }];
    const lease = await allocate();
    expect(lease.approvedRoot).toEqual({ name: 'approved', path: alias });
    expect(lease.worktreePath.startsWith(await fs.realpath(approved))).toBe(true);
    await expect(validateWorkerWorkspaceLease(lease, roots)).resolves.toMatchObject({
      ownershipToken: lease.ownershipToken
    });

    resetWorkerWorktreeRegistryForTests();
    const restored = await restoreManagedWorktrees(roots, ACCEPTED);
    expect(restored.rejected).toEqual([]);
    expect(restored.restored).toHaveLength(1);
    await expect(validateWorkerWorkspaceLease(restored.restored[0]!, roots)).resolves.toMatchObject({
      ownershipToken: lease.ownershipToken
    });

    resetWorkerWorktreeRegistryForTests();
    const offer = { runId: RUN_ID, agentId: 'worker-1', createdAt: lease.createdAt, reason: 'cleared' };
    expect(await listOfferedWorkerWorktrees(roots, [offer])).toMatchObject([{
      runId: RUN_ID, agentId: 'worker-1', canOfferRemoval: true
    }]);
    const disposed = await disposeOfferedWorkerWorktree(roots, offer, []);
    expect(disposed).toMatchObject({ removed: true, branchRemoved: false });
    expect(git(repo, ['rev-parse', lease.branchRef])).toBe(lease.baseOid);
    expect(await fs.readFile(path.join(repo, 'file.txt'), 'utf8')).toBe('base\n');
  });

  it('revokes an originally approved alias when it is repointed to another directory', async () => {
    const alias = path.join(temp, 'approved-alias');
    await fs.symlink(approved, alias, process.platform === 'win32' ? 'junction' : 'dir');
    roots = [{ name: 'approved', path: alias }];
    const lease = await allocate();
    const markerPath = path.join(path.dirname(lease.worktreePath), 'owner.json');
    const replacement = path.join(temp, 'different-folder');
    await fs.mkdir(replacement);
    await fs.unlink(alias);
    await fs.symlink(replacement, alias, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(validateWorkerWorkspaceLease(lease, roots)).rejects.toMatchObject({ code: 'WORKTREE_ROOT_CHANGED' });
    expect(lookupWorkerWorkspace(ACCEPTED[0])).toBeNull();
    resetWorkerWorktreeRegistryForTests();
    expect((await restoreManagedWorktrees(roots, ACCEPTED)).restored).toEqual([]);
    expect(await listOfferedWorkerWorktrees(roots, [{
      runId: RUN_ID, agentId: 'worker-1', createdAt: lease.createdAt, reason: 'cleared'
    }])).toEqual([]);
    expect(await fs.readFile(markerPath, 'utf8')).toContain(lease.ownershipToken);
    expect(await fs.readFile(path.join(lease.worktreePath, 'file.txt'), 'utf8')).toBe('base\n');
  });

  it('fails closed if the owning approved root goes offline while another approved root remains available', async () => {
    const otherRoot = path.join(temp, 'unrelated-approved');
    await fs.mkdir(otherRoot);
    roots.push({ name: 'other', path: otherRoot });
    const lease = await allocate();
    const approvedReal = await fs.realpath(approved);
    const markerPath = path.join(path.dirname(lease.worktreePath), 'owner.json');
    const moved = path.join(temp, 'temporarily-offline');
    const branchHead = git(repo, ['rev-parse', lease.branchRef]);

    await fs.rename(approved, moved);
    await expect(validateWorkerWorkspaceLease(lease, roots)).rejects.toMatchObject({ code: 'WORKTREE_ROOT_CHANGED' });
    expect(lookupWorkerWorkspace({ runId: RUN_ID, agentId: 'worker-1' })).toBeNull();
    expect(await fs.readFile(path.join(moved, 'repo', 'file.txt'), 'utf8')).toBe('base\n');
    expect(await fs.readFile(path.join(moved, path.relative(approvedReal, markerPath)), 'utf8')).toContain(lease.ownershipToken);
    expect(git(path.join(moved, 'repo'), ['rev-parse', lease.branchRef])).toBe(branchHead);

    await fs.rename(moved, approved);
    await finalizeWorkerWorkspace({ lease, reason: 'cancelled', discardChanges: true, branch: { mode: 'discard' } });
  });

  it('does not inherit a lease through an overlapping root after its original root approval is revoked', async () => {
    const lease = await allocate();
    const broaderRoot: Root = { name: 'broader', path: temp };
    await expect(validateWorkerWorkspaceLease(lease, [broaderRoot])).rejects.toMatchObject({
      code: 'WORKTREE_ROOT_CHANGED'
    });
    expect(lookupWorkerWorkspace({ runId: RUN_ID, agentId: 'worker-1' })).toBeNull();
    expect(git(repo, ['rev-parse', lease.branchRef])).toBe(lease.baseOid);
    expect(await fs.readFile(path.join(lease.worktreePath, 'file.txt'), 'utf8')).toBe('base\n');
    await finalizeWorkerWorkspace({ lease, reason: 'cancelled', discardChanges: true, branch: { mode: 'discard' } });
  });

  it('does not inherit an owned lease through a new symlink alias to the same approved directory', async () => {
    const lease = await allocate();
    const alias = path.join(temp, 'alternate-approved-path');
    await fs.symlink(approved, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const remappedRoots: Root[] = [{ name: 'approved', path: alias }];
    await expect(validateWorkerWorkspaceLease(lease, remappedRoots)).rejects.toMatchObject({
      code: 'WORKTREE_ROOT_CHANGED'
    });
    expect(lookupWorkerWorkspace({ runId: RUN_ID, agentId: 'worker-1' })).toBeNull();
    expect(git(repo, ['rev-parse', lease.branchRef])).toBe(lease.baseOid);
    expect(await fs.readFile(path.join(lease.worktreePath, 'file.txt'), 'utf8')).toBe('base\n');
    await fs.unlink(alias);
    await finalizeWorkerWorkspace({ lease, reason: 'cancelled', discardChanges: true, branch: { mode: 'discard' } });
  });

  it('gives only the initiating caller cleanup ownership when two allocations join one flight', async () => {
    const [created, joined] = await Promise.all([allocate(), allocate()]);
    expect(created.newlyCreated).toBe(true);
    expect(joined.newlyCreated).toBe(false);
    expect(created.ownershipToken).toBe(joined.ownershipToken);
    await finalizeWorkerWorkspace({ lease: created, reason: 'cancelled', discardChanges: true, branch: { mode: 'discard' } });
  });

  it('accepts concurrent REAL Git allocations sharing newly-created managed storage parents', async () => {
    const leases = await Promise.all(Array.from({ length: 6 }, () => allocWorkerWorkspace({
      runId: randomUUID(), agentId: 'worker-1',
      primeWorkspace: { real: repo, virtual: '/approved/repo' }, approvedRoots: roots
    })));
    expect(new Set(leases.map(lease => lease.worktreePath)).size).toBe(leases.length);
    for (const lease of leases) {
      expect(await fs.stat(lease.worktreePath).then(stat => stat.isDirectory())).toBe(true);
      expect(await fs.readFile(path.join(lease.worktreePath, 'file.txt'), 'utf8')).toBe('base\n');
    }
    for (const lease of leases) {
      await finalizeWorkerWorkspace({ lease, reason: 'cancelled', discardChanges: true, branch: { mode: 'discard' } });
    }
  });

  it('keeps a nested project cwd inside the equivalent folder of its isolated Git checkout', async () => {
    const nested = path.join('packages', 'frontend');
    await fs.mkdir(path.join(repo, nested), { recursive: true });
    await write(path.join(repo, nested, 'package.json'), '{"private":true}\n');
    await commit(repo, 'nested project');
    const lease = await allocWorkerWorkspace({
      runId: RUN_ID,
      agentId: 'worker-1',
      primeWorkspace: { real: path.join(repo, nested), virtual: '/approved/repo/packages/frontend' },
      approvedRoots: roots
    });
    expect(lease.workspace.real).toBe(path.join(lease.worktreePath, nested));
    expect(lease.workspace.virtual).toMatch(/\/packages\/frontend$/);
    expect(await fs.readFile(path.join(lease.workspace.real, 'package.json'), 'utf8')).toBe('{"private":true}\n');
    expect(await fs.readFile(path.join(repo, nested, 'package.json'), 'utf8')).toBe('{"private":true}\n');
    await finalizeWorkerWorkspace({ lease, reason: 'cancelled', discardChanges: true, branch: { mode: 'discard' } });
  });

  it.each(['untracked', 'ignored'] as const)(
    'refuses a nested workspace present only as %s files without orphaning a worker branch or worktree',
    async (sourceKind) => {
      if (sourceKind === 'ignored') {
        await write(path.join(repo, '.gitignore'), 'packages/local-project/\n');
        await commit(repo, 'ignore local project directory');
      }
      const nested = path.join('packages', 'local-project');
      await fs.mkdir(path.join(repo, nested), { recursive: true });
      const userFile = path.join(repo, nested, 'package.json');
      await write(userFile, '{"ownedBy":"user"}\n');
      const beforeHead = git(repo, ['rev-parse', 'HEAD']);
      const beforeStatus = git(repo, ['status', '--porcelain']);
      const beforeWorktrees = git(repo, ['worktree', 'list', '--porcelain']);

      await expect(allocWorkerWorkspace({
        runId: RUN_ID,
        agentId: 'worker-1',
        primeWorkspace: { real: path.join(repo, nested), virtual: '/approved/repo/packages/local-project' },
        approvedRoots: roots
      })).rejects.toMatchObject({ code: 'WORKTREE_PROJECT_NOT_IN_BASE' });

      expect(lookupWorkerWorkspace({ runId: RUN_ID, agentId: 'worker-1' })).toBeNull();
      expect(git(repo, ['worktree', 'list', '--porcelain'])).toBe(beforeWorktrees);
      expect(git(repo, ['branch', '--list', 'cos/worktrees/*'])).toBe('');
      expect(git(repo, ['rev-parse', 'HEAD'])).toBe(beforeHead);
      expect(git(repo, ['status', '--porcelain'])).toBe(beforeStatus);
      expect(await fs.readFile(userFile, 'utf8')).toBe('{"ownedBy":"user"}\n');
      // The deterministic run slot may have empty staging directories, but Git's
      // checkout destination must not exist without its marker and owner.
      const managed = path.join(approved, '.chat-on-steroids-worktrees');
      const repoSlots = await fs.readdir(managed);
      expect(repoSlots).toHaveLength(1);
      const ownerDir = path.join(managed, repoSlots[0]!, RUN_ID, 'worker-1');
      await expect(fs.stat(path.join(ownerDir, 'tree'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(path.join(ownerDir, 'owner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it('refuses cleanup by a caller without the exact ownership token', async () => {
    const lease = await allocate();
    const forged = { ...lease, ownershipToken: '22222222-2222-4222-8222-222222222222' };
    await expect(finalizeWorkerWorkspace({
      lease: forged, reason: 'cancelled', discardChanges: true, branch: { mode: 'discard' }
    })).rejects.toMatchObject({ code: 'WORKTREE_NOT_OWNED' });
    expect(await fs.stat(lease.worktreePath).then(stat => stat.isDirectory())).toBe(true);
    expect(git(repo, ['rev-parse', lease.branchRef])).toBe(lease.baseOid);
    await finalizeWorkerWorkspace({ lease, reason: 'cancelled', discardChanges: true, branch: { mode: 'discard' } });
  });

  it('validates live ownership for privileged worker IO, refusing a swapped directory without touching user bytes', async () => {
    const lease = await allocate();
    await expect(validateWorkerWorkspaceLease(lease, roots)).resolves.toMatchObject({
      worktreePath: lease.worktreePath, ownershipToken: lease.ownershipToken
    });
    const displaced = path.join(path.dirname(lease.worktreePath), 'displaced-original-tree');
    await fs.rename(lease.worktreePath, displaced);
    await fs.mkdir(lease.worktreePath);
    const personal = path.join(lease.worktreePath, 'personal.txt');
    await write(personal, 'PERSONAL USER DATA\n');
    // The old synchronous lookup still has an in-memory lease until validation.
    expect(lookupWorkerWorkspace({ runId: RUN_ID, agentId: 'worker-1' })).not.toBeNull();
    const privilegedWorkerWrite = async (): Promise<void> => {
      await validateWorkerWorkspaceLease(lease, roots);
      await write(personal, 'UNSAFE WORKER WRITE\n');
    };
    await expect(privilegedWorkerWrite()).rejects.toMatchObject({ code: 'WORKTREE_PATH_CHANGED' });
    expect(lookupWorkerWorkspace({ runId: RUN_ID, agentId: 'worker-1' })).toBeNull();
    expect(await fs.readFile(personal, 'utf8')).toBe('PERSONAL USER DATA\n');
    expect(await fs.readFile(path.join(displaced, 'file.txt'), 'utf8')).toBe('base\n');
    expect(await fs.readFile(path.join(repo, 'file.txt'), 'utf8')).toBe('base\n');
  });

  it('rejects a substituted genuine Git tree with different directory identity', async () => {
    const lease = await allocate();
    const original = path.join(path.dirname(lease.worktreePath), 'original-git-tree');
    await fs.rename(lease.worktreePath, original);
    await fs.cp(original, lease.worktreePath, { recursive: true });
    await expect(validateWorkerWorkspaceLease(lease, roots)).rejects.toMatchObject({ code: 'WORKTREE_PATH_CHANGED' });
    expect(await fs.readFile(path.join(lease.worktreePath, 'file.txt'), 'utf8')).toBe('base\n');
  });

  it('ignores repository replace objects while producing trusted worker patches', async () => {
    const lease = await allocate();
    await write(path.join(lease.workspace.real, 'file.txt'), 'real worker edit\n');
    const originalHead = await commit(lease.worktreePath, 'original worker change');
    const originalTree = git(repo, ['rev-parse', `${lease.baseOid}^{tree}`]);
    const replacementHead = git(repo, ['commit-tree', originalTree, '-m', 'forged empty replacement']);
    git(repo, ['replace', originalHead, replacementHead]);
    // Without GIT_NO_REPLACE_OBJECTS, Git resolves originalHead to replacementHead's
    // unchanged tree and silently hides the actual worker edit from the reviewed patch.
    expect(git(repo, ['diff', lease.baseOid, originalHead, '--', 'file.txt'])).toBe('');
    const observed = await diffWorkerWorkspace(lease);
    expect(observed.committedPatch).toContain('+real worker edit');
    expect(observed.committedPatch).not.toContain('forged empty replacement');
    git(repo, ['replace', '-d', originalHead]);
    await finalizeWorkerWorkspace({ lease, reason: 'cancelled', discardChanges: true, branch: { mode: 'discard' } });
  });

  it('refuses storage when the repository itself is the only approved root', async () => {
    await expect(allocWorkerWorkspace({
      runId: RUN_ID,
      agentId: 'worker-1',
      primeWorkspace: { real: repo, virtual: '/repo' },
      approvedRoots: [{ name: 'repo', path: repo }]
    })).rejects.toMatchObject({ code: 'WORKTREE_STORAGE_UNAVAILABLE' });
    expect(git(repo, ['branch', '--list', 'cos/worktrees/*'])).toBe('');
  });

  it('restores only marker-proven managed worktrees after the in-memory registry is lost', async () => {
    const lease = await allocate();
    resetWorkerWorktreeRegistryForTests();
    expect(lookupWorkerWorkspace({ runId: RUN_ID, agentId: 'worker-1' })).toBeNull();

    const restored = await restoreManagedWorktrees(roots, ACCEPTED);
    expect(restored.rejected).toEqual([]);
    expect(restored.restored).toHaveLength(1);
    expect(restored.restored[0]).toMatchObject({
      runId: lease.runId,
      agentId: lease.agentId,
      ownershipToken: lease.ownershipToken,
      worktreePath: lease.worktreePath
    });
    expect(lookupWorkerWorkspace({ runId: RUN_ID, agentId: 'worker-1' })?.ownershipToken).toBe(lease.ownershipToken);

    await finalizeWorkerWorkspace({ lease, reason: 'cancelled', discardChanges: true, branch: { mode: 'discard' } });
  });

  it('leaves an unaccepted managed checkout untouched without reading its damaged marker', async () => {
    const orphan = await allocate();
    const markerPath = path.join(path.dirname(orphan.worktreePath), 'owner.json');
    const orphanFile = path.join(orphan.worktreePath, 'worker-draft.txt');
    await write(orphanFile, 'UNACCEPTED WORKER BYTES\n');
    await write(markerPath, '{"unaccepted":true}');
    const beforeGit = git(repo, ['worktree', 'list', '--porcelain']);
    resetWorkerWorktreeRegistryForTests();

    const recovered = await restoreManagedWorktrees(roots, []);
    expect(recovered).toEqual({ restored: [], rejected: [] });
    expect(lookupWorkerWorkspace(ACCEPTED[0])).toBeNull();
    expect(await fs.readFile(markerPath, 'utf8')).toBe('{"unaccepted":true}');
    expect(await fs.readFile(orphanFile, 'utf8')).toBe('UNACCEPTED WORKER BYTES\n');
    expect(git(repo, ['worktree', 'list', '--porcelain'])).toBe(beforeGit);

    // Once the exact broker allocation is accepted, a damaged marker is diagnosed.
    const matched = await restoreManagedWorktrees(roots, ACCEPTED);
    expect(matched.restored).toEqual([]);
    expect(matched.rejected).toHaveLength(1);
    expect(matched.rejected[0]?.error).toContain('WORKTREE_OWNER_INVALID');
    expect(await fs.readFile(orphanFile, 'utf8')).toBe('UNACCEPTED WORKER BYTES\n');
  });

  it('restores the retained worker while skipping stale and mismatched worker allocation slots', async () => {
    const stale = await allocate();
    const sameRunOtherWorker = await allocWorkerWorkspace({
      runId: RUN_ID,
      agentId: 'worker-2',
      primeWorkspace: { real: repo, virtual: '/approved/repo' },
      approvedRoots: roots
    });
    const accepted = await allocWorkerWorkspace({
      runId: OTHER_RUN_ID,
      agentId: 'worker-1',
      primeWorkspace: { real: repo, virtual: '/approved/repo' },
      approvedRoots: roots
    });
    const staleMarker = path.join(path.dirname(stale.worktreePath), 'owner.json');
    const wrongWorkerMarker = path.join(path.dirname(sameRunOtherWorker.worktreePath), 'owner.json');
    await write(staleMarker, '{stale-pruned-family');
    await write(wrongWorkerMarker, '{unaccepted-worker-in-retained-family');
    const beforeGit = git(repo, ['worktree', 'list', '--porcelain']);
    resetWorkerWorktreeRegistryForTests();

    const recovered = await restoreManagedWorktrees(roots, [
      { runId: OTHER_RUN_ID, agentId: 'worker-1' },
      { runId: RUN_ID, agentId: 'worker-3' }
    ]);
    expect(recovered.rejected).toEqual([]);
    expect(recovered.restored).toHaveLength(1);
    expect(recovered.restored[0]).toMatchObject({
      runId: accepted.runId, agentId: accepted.agentId, ownershipToken: accepted.ownershipToken
    });
    expect(lookupWorkerWorkspace({ runId: RUN_ID, agentId: 'worker-1' })).toBeNull();
    expect(lookupWorkerWorkspace({ runId: RUN_ID, agentId: 'worker-2' })).toBeNull();
    expect(lookupWorkerWorkspace({ runId: OTHER_RUN_ID, agentId: 'worker-1' })?.ownershipToken).toBe(accepted.ownershipToken);
    expect(await fs.readFile(staleMarker, 'utf8')).toBe('{stale-pruned-family');
    expect(await fs.readFile(wrongWorkerMarker, 'utf8')).toBe('{unaccepted-worker-in-retained-family');
    expect(await fs.readFile(path.join(stale.worktreePath, 'file.txt'), 'utf8')).toBe('base\n');
    expect(await fs.readFile(path.join(sameRunOtherWorker.worktreePath, 'file.txt'), 'utf8')).toBe('base\n');
    expect(git(repo, ['worktree', 'list', '--porcelain'])).toBe(beforeGit);
  });

  it('refuses a tampered restart marker instead of following an arbitrary path', async () => {
    const lease = await allocate();
    const markerPath = path.join(path.dirname(lease.worktreePath), 'owner.json');
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as Record<string, unknown>;
    marker['worktreePath'] = path.join(temp, 'outside-approved-root');
    await fs.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    resetWorkerWorktreeRegistryForTests();

    const restored = await restoreManagedWorktrees(roots, ACCEPTED);
    expect(restored.restored).toEqual([]);
    expect(restored.rejected).toHaveLength(1);
    expect(restored.rejected[0]?.error).toContain('WORKTREE_OWNER_INVALID');
    expect(lookupWorkerWorkspace({ runId: RUN_ID, agentId: 'worker-1' })).toBeNull();
  });

  it('does not claim restored ownership through a renamed approved virtual root', async () => {
    const lease = await allocate();
    resetWorkerWorktreeRegistryForTests();
    const result = await restoreManagedWorktrees([{ name: 'renamed', path: approved }], ACCEPTED);
    expect(result.restored).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.error).toContain('WORKTREE_ROOT_CHANGED');
    expect(lookupWorkerWorkspace({ runId: RUN_ID, agentId: 'worker-1' })).toBeNull();
    // The original lease remains valid with its original, still-approved root.
    await finalizeWorkerWorkspace({ lease, reason: 'cancelled', discardChanges: true, branch: { mode: 'discard' } });
  });

  it('rejects tampered cleanup paths before modifying any user-owned file', async () => {
    const lease = await allocate();
    const userFile = path.join(repo, 'personal-notes.txt');
    await write(userFile, 'DO NOT DELETE\n');
    const markerPath = path.join(path.dirname(lease.worktreePath), 'owner.json');
    const original = await fs.readFile(markerPath, 'utf8');
    for (const field of ['ownerDir', 'markerPath', 'hooksPath'] as const) {
      const marker = JSON.parse(original) as Record<string, unknown>;
      marker[field] = userFile;
      await fs.writeFile(markerPath, JSON.stringify(marker));
      await expect(finalizeWorkerWorkspace({
        lease, reason: 'cancelled', discardChanges: true, branch: { mode: 'discard' }
      })).rejects.toMatchObject({ code: 'WORKTREE_OWNER_INVALID' });
      expect(await fs.readFile(userFile, 'utf8')).toBe('DO NOT DELETE\n');
      expect(await fs.stat(lease.worktreePath).then(stat => stat.isDirectory())).toBe(true);
    }
    await fs.writeFile(markerPath, original);
    await finalizeWorkerWorkspace({ lease, reason: 'cancelled', discardChanges: true, branch: { mode: 'discard' } });
    expect(await fs.readFile(userFile, 'utf8')).toBe('DO NOT DELETE\n');
  });

  it('preserves an unintegrated branch and worktree when disposal is refused', async () => {
    const lease = await allocate();
    await write(path.join(lease.worktreePath, 'file.txt'), 'worker commit\n');
    const workerHead = await commit(lease.worktreePath, 'worker commit');
    await expect(finalizeWorkerWorkspace({
      lease, reason: 'completed', branch: { mode: 'delete-if-integrated', integratedIntoOid: lease.baseOid }
    })).rejects.toMatchObject({ code: 'WORKTREE_BRANCH_UNMERGED' });
    await expect(finalizeWorkerWorkspace({
      lease, reason: 'completed', branch: { mode: 'discard' }
    })).rejects.toMatchObject({ code: 'WORKTREE_BRANCH_DISCARD_FORBIDDEN' });
    expect(git(repo, ['rev-parse', lease.branchRef])).toBe(workerHead);
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(lease.baseOid);
    expect(await fs.readFile(path.join(lease.worktreePath, 'file.txt'), 'utf8')).toBe('worker commit\n');
    await finalizeWorkerWorkspace({ lease, reason: 'cancelled', discardChanges: true, branch: { mode: 'discard' } });
  });

  it('retains dirty worker changes by default and reports them for review', async () => {
    const lease = await allocate();
    await write(path.join(lease.worktreePath, 'file.txt'), 'uncommitted worker edit\n');
    const report = await diffWorkerWorkspace(lease);
    expect(report.status).toMatchObject({ dirty: true, changes: ['file.txt'] });
    expect(report.workingPatch).toContain('+uncommitted worker edit');
    const retained = await finalizeWorkerWorkspace({ lease, reason: 'cancelled', branch: { mode: 'discard' } });
    expect(retained).toMatchObject({ removed: false, branchRemoved: false, changes: ['file.txt'] });
    expect(await fs.readFile(path.join(repo, 'file.txt'), 'utf8')).toBe('base\n');
    await finalizeWorkerWorkspace({ lease, reason: 'cancelled', discardChanges: true, branch: { mode: 'discard' } });
  });

  it('preserves ignored user files during default worktree finalization', async () => {
    await write(path.join(repo, '.gitignore'), 'private-secret.txt\n');
    await commit(repo, 'ignore private worker-local files');
    const lease = await allocate();
    const ignoredFile = path.join(lease.worktreePath, 'private-secret.txt');
    await write(ignoredFile, 'USER IMPORTANT SECRET BYTES\n');
    expect(git(lease.worktreePath, ['status', '--porcelain'])).toBe('');
    const result = await finalizeWorkerWorkspace({ lease, reason: 'completed' });
    expect(result).toMatchObject({ removed: false, branchRemoved: false });
    expect(result.changes).toContain('private-secret.txt');
    expect(await fs.readFile(ignoredFile, 'utf8')).toBe('USER IMPORTANT SECRET BYTES\n');
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(lease.baseOid);
  });

  it('does not remove a clean worktree without explicit file-discard authority', async () => {
    const lease = await allocate();
    expect(git(lease.worktreePath, ['status', '--porcelain'])).toBe('');
    const result = await finalizeWorkerWorkspace({
      lease, reason: 'failed', branch: { mode: 'discard' }
    });
    expect(result).toMatchObject({ removed: false, branchRemoved: false, changes: [] });
    expect(await fs.readFile(path.join(lease.worktreePath, 'file.txt'), 'utf8')).toBe('base\n');
    expect(git(repo, ['rev-parse', lease.branchRef])).toBe(lease.baseOid);
    await finalizeWorkerWorkspace({ lease, reason: 'failed', discardChanges: true, branch: { mode: 'discard' } });
  });

  it('offers a clean, unchanged checkout after broker Clear/restart and deletes only after explicit action', async () => {
    const lease = await allocate();
    const offered = {
      runId: lease.runId, agentId: lease.agentId, createdAt: lease.createdAt + 3_000,
      ownershipToken: lease.ownershipToken, reason: 'cleared'
    };
    const inspected = await inspectWorkerWorkspaceForCleanup(lease);
    expect(inspected).toMatchObject({
      hasWorkerCommits: false, branchIntegratedIntoSource: true,
      trackedChanges: [], untrackedFiles: [], ignoredFiles: [],
      blockers: [], canOfferRemoval: true
    });
    const markerPath = path.join(path.dirname(lease.worktreePath), 'owner.json');
    resetWorkerWorktreeRegistryForTests();
    expect(lookupWorkerWorkspace(ACCEPTED[0])).toBeNull();
    const previews = await listOfferedWorkerWorktrees(roots, [offered]);
    expect(previews).toMatchObject([{
      runId: RUN_ID, agentId: 'worker-1', reason: 'cleared',
      createdAt: offered.createdAt,
      workspace: lease.workspace.virtual, dirty: false, ignoredFiles: false,
      uniqueCommits: false, changes: [], canOfferRemoval: true
    }]);
    expect(JSON.stringify(previews)).not.toContain(lease.worktreePath);
    expect(lookupWorkerWorkspace(ACCEPTED[0])).toBeNull();
    expect(await fs.readFile(markerPath, 'utf8')).toContain(lease.ownershipToken);

    const removed = await disposeOfferedWorkerWorktree(roots, offered, []);
    expect(removed).toMatchObject({ removed: true, branchRemoved: false, changes: [] });
    await expect(fs.stat(lease.worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(git(repo, ['rev-parse', lease.branchRef])).toBe(lease.baseOid);
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(lease.baseOid);
    expect(await listOfferedWorkerWorktrees(roots, [offered])).toEqual([]);
    expect(lookupWorkerWorkspace(ACCEPTED[0])).toBeNull();
  });

  it.each(['tracked', 'untracked', 'ignored-directory'] as const)(
    'refuses confirmed removal when %s bytes change at the same path, size and mtime', async kind => {
      if (kind === 'ignored-directory') {
        await write(path.join(repo, '.gitignore'), 'private-cache/\n');
        await commit(repo, 'ignore worker private directory');
      }
      const lease = await allocate();
      const target = kind === 'tracked'
        ? path.join(lease.worktreePath, 'file.txt')
        : kind === 'untracked'
          ? path.join(lease.worktreePath, 'notes.txt')
          : path.join(lease.worktreePath, 'private-cache', 'nested', 'notes.txt');
      if (kind === 'ignored-directory') await fs.mkdir(path.dirname(target), { recursive: true });
      await write(target, 'one!\n');
      const offer = { runId: lease.runId, agentId: lease.agentId, createdAt: lease.createdAt, reason: 'cleared' };
      resetWorkerWorktreeRegistryForTests();
      const previews = await listOfferedWorkerWorktrees(roots, [offer]);
      expect(previews).toHaveLength(1);
      expect(previews[0]!.contentFingerprint).toMatch(/^[a-f0-9]{64}$/);
      if (kind === 'ignored-directory') {
        expect(previews[0]!.changes).toContain('private-cache/');
      }
      const stat = await fs.stat(target);
      await write(target, 'two!\n');
      await fs.utimes(target, stat.atime, stat.mtime);
      const changed = await fs.stat(target);
      expect(changed.size).toBe(stat.size);
      expect(Math.abs(changed.mtimeMs - stat.mtimeMs)).toBeLessThan(2);
      await expect(disposeOfferedWorkerWorktree(roots, offer, [], previews[0]!.contentFingerprint!))
        .rejects.toMatchObject({ code: 'WORKTREE_CONTENT_CHANGED' });
      expect(await fs.readFile(target, 'utf8')).toBe('two!\n');
      expect(git(repo, ['rev-parse', lease.branchRef])).toBe(lease.baseOid);
    }
  );

  it.each(['--assume-unchanged', '--skip-worktree'] as const)(
    'blocks cleanup preview when Git %s hides a tracked change with unchanged size and mtime', async flag => {
      const lease = await allocate();
      const tracked = path.join(lease.worktreePath, 'file.txt');
      const before = await fs.stat(tracked);
      const offer = { runId: lease.runId, agentId: lease.agentId, createdAt: lease.createdAt, reason: 'cleared' };
      git(lease.worktreePath, ['update-index', flag, '--', 'file.txt']);
      await write(tracked, 'edit\n');
      await fs.utimes(tracked, before.atime, before.mtime);
      expect((await fs.stat(tracked)).size).toBe(before.size);
      expect(git(lease.worktreePath, ['status', '--porcelain'])).toBe('');
      expect(git(lease.worktreePath, ['ls-files', '-v', '--', 'file.txt']).startsWith(
        flag === '--assume-unchanged' ? 'h ' : 'S '
      )).toBe(true);
      resetWorkerWorktreeRegistryForTests();

      const previews = await listOfferedWorkerWorktrees(roots, [offer]);
      expect(previews).toHaveLength(1);
      expect(previews[0]).toMatchObject({ contentFingerprint: null, canOfferRemoval: false });
      expect(await fs.readFile(tracked, 'utf8')).toBe('edit\n');
      expect(git(repo, ['rev-parse', lease.branchRef])).toBe(lease.baseOid);
    }
  );

  it.each(['--assume-unchanged', '--skip-worktree'] as const)(
    'blocks confirmed removal when Git %s is set after content approval', async flag => {
      const lease = await allocate();
      const tracked = path.join(lease.worktreePath, 'file.txt');
      const before = await fs.stat(tracked);
      const offer = { runId: lease.runId, agentId: lease.agentId, createdAt: lease.createdAt, reason: 'cleared' };
      resetWorkerWorktreeRegistryForTests();
      const previews = await listOfferedWorkerWorktrees(roots, [offer]);
      expect(previews[0]).toMatchObject({ canOfferRemoval: true });
      const fingerprint = previews[0]?.contentFingerprint;
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);

      git(lease.worktreePath, ['update-index', flag, '--', 'file.txt']);
      await write(tracked, 'edit\n');
      await fs.utimes(tracked, before.atime, before.mtime);
      expect((await fs.stat(tracked)).size).toBe(before.size);
      expect(git(lease.worktreePath, ['status', '--porcelain'])).toBe('');
      expect(git(lease.worktreePath, ['ls-files', '-v', '--', 'file.txt']).startsWith(
        flag === '--assume-unchanged' ? 'h ' : 'S '
      )).toBe(true);
      await expect(disposeOfferedWorkerWorktree(roots, offer, [], fingerprint!))
        .rejects.toMatchObject({ code: 'WORKTREE_CONTENT_CHANGED' });
      expect(await fs.readFile(tracked, 'utf8')).toBe('edit\n');
      expect(git(repo, ['rev-parse', lease.branchRef])).toBe(lease.baseOid);
    }
  );

  it('fails closed when an ignored directory exceeds bounded content fingerprint limits', async () => {
    await write(path.join(repo, '.gitignore'), 'private-cache/\n');
    await commit(repo, 'ignore large worker cache');
    const lease = await allocate();
    const cache = path.join(lease.worktreePath, 'private-cache');
    await fs.mkdir(cache);
    const target = path.join(cache, 'large.bin');
    await write(target, '');
    await fs.truncate(target, 64 * 1024 * 1024 + 1);
    const offer = { runId: lease.runId, agentId: lease.agentId, createdAt: lease.createdAt, reason: 'cleared' };
    resetWorkerWorktreeRegistryForTests();
    const previews = await listOfferedWorkerWorktrees(roots, [offer]);
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({ contentFingerprint: null, canOfferRemoval: false });
    await expect(disposeOfferedWorkerWorktree(roots, offer, [], 'a'.repeat(64)))
      .rejects.toMatchObject({ code: 'WORKTREE_CONTENT_CHANGED' });
    expect(await fs.stat(target).then(stat => stat.size)).toBe(64 * 1024 * 1024 + 1);
  });

  it('refuses confirmed removal while a background process still owns the worker checkout cwd', async () => {
    const lease = await allocate();
    const offer = { runId: lease.runId, agentId: lease.agentId, createdAt: lease.createdAt + 1000, reason: 'cleared' };
    resetWorkerWorktreeRegistryForTests();
    await expect(disposeOfferedWorkerWorktree(roots, offer, [lease.worktreePath]))
      .rejects.toMatchObject({ code: 'WORKTREE_ACTIVE_PROCESS' });
    await expect(disposeOfferedWorkerWorktree(roots, offer, [path.join(lease.worktreePath, 'nested')]))
      .rejects.toMatchObject({ code: 'WORKTREE_ACTIVE_PROCESS' });
    expect(await fs.readFile(path.join(lease.worktreePath, 'file.txt'), 'utf8')).toBe('base\n');
    expect(git(repo, ['rev-parse', lease.branchRef])).toBe(lease.baseOid);
    const removed = await disposeOfferedWorkerWorktree(roots, offer, []);
    expect(removed).toMatchObject({ removed: true, branchRemoved: false });
  });

  it('reports tracked, untracked and ignored file blockers without deleting user data', async () => {
    await write(path.join(repo, '.gitignore'), 'private-secret.txt\n');
    await commit(repo, 'ignore worker local files');
    const lease = await allocate();
    await write(path.join(lease.worktreePath, 'file.txt'), 'worker edit\n');
    await write(path.join(lease.worktreePath, 'notes.txt'), 'PRIVATE DRAFT\n');
    await write(path.join(lease.worktreePath, 'private-secret.txt'), 'PRIVATE IGNORED BYTES\n');
    const offered = { runId: RUN_ID, agentId: 'worker-1', createdAt: lease.createdAt, reason: 'failed' };
    resetWorkerWorktreeRegistryForTests();

    const previews = await listOfferedWorkerWorktrees(roots, [offered]);
    expect(previews).toMatchObject([{
      dirty: true, ignoredFiles: true, uniqueCommits: false,
      canOfferRemoval: false, blockers: ['tracked-changes', 'untracked-files', 'ignored-files']
    }]);
    expect(previews[0]?.changes).toEqual(expect.arrayContaining(['file.txt', 'notes.txt', 'private-secret.txt']));
    expect(await fs.readFile(path.join(lease.worktreePath, 'private-secret.txt'), 'utf8')).toBe('PRIVATE IGNORED BYTES\n');
    expect(await fs.readFile(path.join(lease.worktreePath, 'notes.txt'), 'utf8')).toBe('PRIVATE DRAFT\n');
    expect(git(repo, ['rev-parse', lease.branchRef])).toBe(lease.baseOid);
  });

  it('retains worker commits for review and preserves the branch after confirmed checkout disposal', async () => {
    const lease = await allocate();
    await write(path.join(lease.worktreePath, 'file.txt'), 'worker committed change\n');
    const commitOid = await commit(lease.worktreePath, 'worker produced changes');
    const offer = {
      runId: lease.runId, agentId: lease.agentId,
      createdAt: lease.createdAt, reason: 'completed', ownershipToken: lease.ownershipToken
    };
    const before = await inspectWorkerWorkspaceForCleanup(lease);
    expect(before).toMatchObject({
      headOid: commitOid, hasWorkerCommits: true, branchIntegratedIntoSource: false,
      blockers: ['unintegrated-commits'], canOfferRemoval: false
    });
    const defaultFinalize = await finalizeWorkerWorkspace({ lease, reason: 'completed' });
    expect(defaultFinalize).toMatchObject({ removed: false, branchRemoved: false });
    resetWorkerWorktreeRegistryForTests();
    expect(await listOfferedWorkerWorktrees(roots, [offer])).toMatchObject([{
      uniqueCommits: true, dirty: false, ignoredFiles: false, changes: []
    }]);
    const disposed = await disposeOfferedWorkerWorktree(roots, offer, []);
    expect(disposed).toMatchObject({ removed: true, branchRemoved: false });
    expect(git(repo, ['rev-parse', lease.branchRef])).toBe(commitOid);
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(lease.baseOid);
    expect(await fs.readFile(path.join(repo, 'file.txt'), 'utf8')).toBe('base\n');
  });

  it('refuses forged and obsolete broker offers without touching the real worker checkout', async () => {
    const lease = await allocate();
    const markerFile = path.join(path.dirname(lease.worktreePath), 'owner.json');
    const originalMarker = await fs.readFile(markerFile, 'utf8');
    const falseOffers = [
      { runId: RUN_ID, agentId: 'worker-1', createdAt: lease.createdAt - 1, reason: 'cleared' },
      { runId: RUN_ID, agentId: 'worker-1', createdAt: lease.createdAt, reason: 'cleared', ownershipToken: 'forged-token' },
      { runId: OTHER_RUN_ID, agentId: 'worker-1', createdAt: lease.createdAt, reason: 'cleared' }
    ];
    resetWorkerWorktreeRegistryForTests();
    for (const offer of falseOffers) {
      expect(await listOfferedWorkerWorktrees(roots, [offer])).toEqual([]);
      await expect(disposeOfferedWorkerWorktree(roots, offer, [])).rejects.toMatchObject({
        code: expect.stringMatching(/^WORKTREE_(NOT_OWNED|OWNER_INVALID)$/)
      });
      expect(await fs.readFile(markerFile, 'utf8')).toBe(originalMarker);
      expect(await fs.readFile(path.join(lease.worktreePath, 'file.txt'), 'utf8')).toBe('base\n');
      expect(git(repo, ['rev-parse', lease.branchRef])).toBe(lease.baseOid);
    }
    expect(await listOfferedWorkerWorktrees([], [{
      runId: RUN_ID, agentId: 'worker-1', createdAt: lease.createdAt, reason: 'cleared'
    }])).toEqual([]);
  });

});
