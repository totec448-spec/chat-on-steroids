import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { gitExecutable } from '../src/main/project-git.js';
import { allocWorkerWorkspace, finalizeWorkerWorkspace, resetWorkerWorktreeRegistryForTests } from '../src/main/worktrees/index.js';

/**
 * `git worktree add` reads every other worktree's admin folder, so one created at the same moment,
 * still without its `commondir`, failed a worker's allocation ("failed to read
 * .git/worktrees/tree/commondir", seen in the concurrent-allocation test on 2026-10-14). The app
 * now changes one repository's worktrees one Git process at a time.
 */
const running = new Map<string, number>();
let overlap = 0;
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawn: ((command: string, args: readonly string[], options: { cwd?: string }) => {
      const child = original.spawn(command, args as string[], options as never);
      const at = args.indexOf('worktree');
      // `list` reads every worktree's admin folder too, and failed with "Invalid path
      // .git/worktrees" when a removal emptied that folder underneath it (full suite, 2026-10-17).
      if (at >= 0 && ['add', 'remove', 'list'].includes(args[at + 1]!)) {
        const key = String(options?.cwd);
        const now = (running.get(key) ?? 0) + 1;
        running.set(key, now);
        overlap = Math.max(overlap, now);
        child.once('close', () => running.set(key, (running.get(key) ?? 1) - 1));
      }
      return child;
    }) as typeof original.spawn
  };
});

let temp = '';
beforeEach(async () => { resetWorkerWorktreeRegistryForTests(); overlap = 0; running.clear(); temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-wt-serial-')); });
afterEach(async () => { resetWorkerWorktreeRegistryForTests(); await fs.rm(temp, { recursive: true, force: true }); });

it('never runs two worktree changes or a listing beside a change in one repository at the same time', async () => {
  const approved = path.join(temp, 'approved');
  const repo = path.join(approved, 'repo');
  await fs.mkdir(repo, { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  const git = (args: string[]) => execFileSync(gitExecutable(), args, { cwd: repo, env, windowsHide: true });
  git(['init']); git(['config', 'user.name', 'CoS']); git(['config', 'user.email', 'cos@example.invalid']);
  await fs.writeFile(path.join(repo, 'file.txt'), 'base\n');
  git(['add', '-A']); git(['commit', '-m', 'base']);
  const leases = await Promise.all(Array.from({ length: 6 }, () => allocWorkerWorkspace({
    runId: randomUUID(), agentId: 'worker-1',
    primeWorkspace: { real: repo, virtual: '/approved/repo' }, approvedRoots: [{ name: 'approved', path: approved }]
  })));
  expect(new Set(leases.map(lease => lease.worktreePath)).size).toBe(6);
  await Promise.all(leases.map(lease => finalizeWorkerWorkspace({ lease, reason: 'cancelled', discardChanges: true, branch: { mode: 'discard' } })));
  expect(overlap).toBe(1);
});
