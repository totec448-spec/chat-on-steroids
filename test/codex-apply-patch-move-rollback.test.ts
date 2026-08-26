import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const removeFailure = vi.hoisted(() => ({ path: '', mutateDestination: '', mutateContent: '' }));

vi.mock('../src/main/codex/filesystem.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/codex/filesystem.js')>();
  const nodeFs = await import('node:fs/promises');
  return {
    ...actual,
    remove: async (target: string, options: Parameters<typeof actual.remove>[1]) => {
      if (removeFailure.path && target === removeFailure.path) {
        if (removeFailure.mutateDestination) {
          await nodeFs.writeFile(removeFailure.mutateDestination, removeFailure.mutateContent, 'utf8');
        }
        const error = new Error('sharing violation while deleting source') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return actual.remove(target, options);
    }
  };
});

import { executeApplyPatch } from '../src/main/codex/apply-patch/index.js';

const roots: string[] = [];

describe('apply_patch move rollback', () => {
  afterEach(async () => {
    removeFailure.path = '';
    removeFailure.mutateDestination = '';
    removeFailure.mutateContent = '';
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('restores an occupied destination when source deletion fails after the destination write', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'clf-patch-move-rollback-'));
    roots.push(root);
    const source = path.join(root, 'source.txt');
    const destination = path.join(root, 'destination.txt');
    await writeFile(source, 'source-before\n', 'utf8');
    await writeFile(destination, 'destination-before\n', 'utf8');
    removeFailure.path = source;

    const result = await executeApplyPatch({
      cwd: root,
      patch: `*** Begin Patch
*** Update File: source.txt
*** Move to: destination.txt
@@
-source-before
+source-after
*** End Patch`
    });

    expect(result.exitCode).toBe(1);
    await expect(readFile(source, 'utf8')).resolves.toBe('source-before\n');
    await expect(readFile(destination, 'utf8')).resolves.toBe('destination-before\n');
    expect(result.delta.changes).toEqual([]);
    expect(result.delta.exact).toBe(true);
  });

  it('does not overwrite a newer destination edit while rolling back a failed move', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'clf-patch-move-rollback-race-'));
    roots.push(root);
    const source = path.join(root, 'source.txt');
    const destination = path.join(root, 'destination.txt');
    await writeFile(source, 'source-before\n', 'utf8');
    await writeFile(destination, 'destination-before\n', 'utf8');
    removeFailure.path = source;
    removeFailure.mutateDestination = destination;
    removeFailure.mutateContent = 'external-newer-edit\n';

    const result = await executeApplyPatch({
      cwd: root,
      patch: `*** Begin Patch
*** Update File: source.txt
*** Move to: destination.txt
@@
-source-before
+source-after
*** End Patch`
    });

    expect(result.exitCode).toBe(1);
    await expect(readFile(source, 'utf8')).resolves.toBe('source-before\n');
    await expect(readFile(destination, 'utf8')).resolves.toBe('external-newer-edit\n');
    expect(result.delta.exact).toBe(false);
  });
});
