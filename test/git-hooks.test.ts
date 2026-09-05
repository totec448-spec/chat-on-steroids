/**
 * The node lookup every git hook in `.githooks/` sources before it can run anything.
 *
 * This is tested because it has now been got wrong twice on the same machine. Git runs hooks
 * with a minimal PATH, a user-local Node install is therefore invisible to them, and the first
 * fix for that named `~/.local/bin` after a QA round reported a machine whose node lived under
 * `~/.local` — but that machine keeps its node in `~/.local/node-v22.23.2/bin`, one directory
 * further down, so the fix did not actually fix the case it was written for and `git commit`
 * still aborted with "node not found". A shell script nothing exercises is a shell script that
 * silently stops working, so the layouts it claims to support are asserted here directly.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

const run = promisify(execFile);
const script = path.resolve('.githooks/lib/find-node.sh');

/** A stub that is executable and identifies itself, so we can prove which one was found. */
async function installFakeNode(home: string, relativeBin: string): Promise<string> {
  const bin = path.join(home, ...relativeBin.split('/'));
  await fs.mkdir(bin, { recursive: true });
  const file = path.join(bin, 'node');
  await fs.writeFile(file, '#!/bin/sh\necho fake-node\n');
  await fs.chmod(file, 0o755);
  return file;
}

/**
 * Sources the helper the way a hook does, with a PATH that deliberately has no node on it, and
 * reports what it resolved to. `env -i` is not used because the helper needs a working shell.
 *
 * The two fixed non-$HOME candidates (Homebrew, /usr/local/bin) are pointed at a directory this
 * temp $HOME provably does not contain node in, via the helper's own override seam - otherwise a
 * machine or CI runner that genuinely has node at one of those real paths (common on Linux and
 * Intel-Homebrew installs) would resolve to it before ever reaching the $HOME-relative layout a
 * given test means to isolate, regardless of PATH.
 */
async function findNode(home: string): Promise<{ ok: boolean; resolved: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run('sh', ['-c', `. '${script}' && command -v node`], {
      env: {
        HOME: home,
        PATH: '/usr/bin:/bin',
        CLF_HOOK_HOMEBREW_BIN: path.join(home, 'no-such-homebrew-bin'),
        CLF_HOOK_USR_LOCAL_BIN: path.join(home, 'no-such-usr-local-bin')
      }
    });
    return { ok: true, resolved: stdout.trim(), stderr };
  } catch (error) {
    const failure = error as { stderr?: string };
    return { ok: false, resolved: '', stderr: failure.stderr ?? '' };
  }
}

describe.runIf(process.platform !== 'win32')('the git hooks’ node lookup', () => {
  it('finds a versioned tarball install, which is the layout that broke it', async () => {
    const home = await makeTempDir('clf-hook-home-');
    try {
      const expected = await installFakeNode(home, '.local/node-v22.23.2/bin');
      const found = await findNode(home);
      expect(found.stderr, found.stderr).not.toContain('node not found');
      expect(found.resolved).toBe(expected);
    } finally {
      await removeTempDir(home);
    }
  });

  it('still finds a plain ~/.local/bin install, and prefers it when both exist', async () => {
    const home = await makeTempDir('clf-hook-home-');
    try {
      const plain = await installFakeNode(home, '.local/bin');
      await installFakeNode(home, '.local/node-v22.23.2/bin');
      const found = await findNode(home);
      expect(found.resolved).toBe(plain);
    } finally {
      await removeTempDir(home);
    }
  });

  it('finds the per-version bin of a version manager', async () => {
    for (const layout of [
      '.nvm/versions/node/v22.23.2/bin',
      '.fnm/node-versions/v22.23.2/installation/bin',
      'n/bin'
    ]) {
      const home = await makeTempDir('clf-hook-home-');
      try {
        const expected = await installFakeNode(home, layout);
        const found = await findNode(home);
        expect(found.resolved, layout).toBe(expected);
      } finally {
        await removeTempDir(home);
      }
    }
  });

  it('fails with the recovery instruction rather than a bare shell error', async () => {
    const home = await makeTempDir('clf-hook-home-');
    try {
      const found = await findNode(home);
      expect(found.ok).toBe(false);
      expect(found.stderr).toContain('node not found on PATH or in common install locations');
      expect(found.stderr).toContain('npm run verify:privacy');
    } finally {
      await removeTempDir(home);
    }
  });
});
