import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeApplyPatch } from '../src/main/codex/apply-patch/index.js';

const roots: string[] = [];
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'cos-apply-patch-bom-'));
  roots.push(root);
  return root;
}

// Windows PowerShell 5.1 reads a script without a byte-order mark as ANSI, so a .ps1 with any
// non-ASCII text needs its mark; C# and CSV files for Excel commonly carry one too. The strict
// decoder dropped it, and the rewritten file came back without it.
describe('apply_patch and a UTF-8 byte-order mark', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('keeps the mark when it updates a later line', async () => {
    const root = await tempRoot();
    const file = path.join(root, 'greet.ps1');
    await writeFile(file, Buffer.concat([BOM, Buffer.from('$name = "Zoë"\nWrite-Host "Hi $name"\n')]));

    const result = await executeApplyPatch({ cwd: root, patch: `*** Begin Patch
*** Update File: greet.ps1
@@
-Write-Host "Hi $name"
+Write-Host "Hello $name"
*** End Patch` });

    expect(result.exitCode).toBe(0);
    expect(await readFile(file)).toEqual(Buffer.concat([BOM, Buffer.from('$name = "Zoë"\nWrite-Host "Hello $name"\n')]));
  });

  it('keeps the mark when it updates the first line, which the model sees without it', async () => {
    const root = await tempRoot();
    const file = path.join(root, 'Program.cs');
    await writeFile(file, Buffer.concat([BOM, Buffer.from('using System;\nclass Program {}\n')]));

    const result = await executeApplyPatch({ cwd: root, patch: `*** Begin Patch
*** Update File: Program.cs
@@
-using System;
+using System.Text;
 class Program {}
*** End Patch` });

    expect(result.exitCode).toBe(0);
    expect(await readFile(file)).toEqual(Buffer.concat([BOM, Buffer.from('using System.Text;\nclass Program {}\n')]));
  });

  it('adds no mark to a file that has none', async () => {
    const root = await tempRoot();
    const file = path.join(root, 'plain.txt');
    await writeFile(file, 'one\ntwo\n');

    const result = await executeApplyPatch({ cwd: root, patch: `*** Begin Patch
*** Update File: plain.txt
@@
-two
+three
*** End Patch` });

    expect(result.exitCode).toBe(0);
    expect(await readFile(file)).toEqual(Buffer.from('one\nthree\n'));
  });
});
