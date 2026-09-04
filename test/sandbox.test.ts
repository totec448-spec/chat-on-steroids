/**
 * The security core. If any test in this file stops passing, the model can reach
 * files the user never approved.
 */

import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Root } from '../src/shared/types.js';
import {
  SandboxError,
  isContained,
  normaliseRootName,
  resolvePath,
  splitVirtualPath,
  strayVirtualPath,
  toVirtualPath,
  uniqueRootName,
  validateNewRoot
} from '../src/main/sandbox.js';
import { DIR_LINK, IS_WINDOWS, makeTempDir, removeTempDir, writeTree } from './helpers.js';

let base: string;
let approved: string;
let outside: string;
let roots: Root[];

beforeAll(async () => {
  base = await makeTempDir('clf-sandbox-');
  approved = path.join(base, 'approved');
  outside = path.join(base, 'outside');
  await writeTree(approved, {
    'file.txt': 'hello',
    'sub/nested.txt': 'nested',
    'sub/deep/leaf.txt': 'leaf'
  });
  await writeTree(outside, { 'secret.txt': 'TOP SECRET' });
  roots = [{ name: 'project', path: approved }];
});

afterAll(async () => {
  await removeTempDir(base);
});

describe('virtual paths embedded in shell text', () => {
  it('finds only approved virtual roots at token boundaries', () => {
    expect(strayVirtualPath('Get-Content /project/sub/nested.txt', roots)).toBe('/project/sub/nested.txt');
    expect(strayVirtualPath("Get-Content '/project/file.txt'", roots)).toBe('/project/file.txt');
    expect(strayVirtualPath('https://host/project/file.txt', roots)).toBeNull();
    expect(strayVirtualPath('de/project/file.txt', roots)).toBeNull();
    expect(strayVirtualPath('/not-approved/file.txt', roots)).toBeNull();
  });
});

/** Asserts the call is refused, and that it is refused by the sandbox itself. */
async function expectRefused(virtualPath: string, allowMissing = false): Promise<SandboxError> {
  try {
    await resolvePath(roots, virtualPath, { allowMissing });
  } catch (err) {
    expect(err, `expected a SandboxError for ${JSON.stringify(virtualPath)}`).toBeInstanceOf(
      SandboxError
    );
    return err as SandboxError;
  }
  throw new Error(`expected ${JSON.stringify(virtualPath)} to be refused, but it resolved`);
}

describe('resolvePath — happy path', () => {
  it('resolves a file inside an approved root', async () => {
    const resolved = await resolvePath(roots, '/project/file.txt');
    expect(resolved.real).toBe(path.join(approved, 'file.txt'));
    expect(resolved.virtual).toBe('/project/file.txt');
    expect(resolved.root.name).toBe('project');
  });

  it('resolves the root itself', async () => {
    const resolved = await resolvePath(roots, '/project');
    expect(resolved.real).toBe(approved);
    expect(resolved.virtual).toBe('/project');
  });

  it.runIf(IS_WINDOWS)('accepts backslashes as separators', async () => {
    const resolved = await resolvePath(roots, '\\project\\sub\\nested.txt');
    expect(resolved.real).toBe(path.join(approved, 'sub', 'nested.txt'));
    expect(resolved.virtual).toBe('/project/sub/nested.txt');
  });

  it('accepts redundant separators', async () => {
    const resolved = await resolvePath(roots, '//project///sub//nested.txt');
    expect(resolved.virtual).toBe('/project/sub/nested.txt');
  });

  it('matches the root name case-insensitively', async () => {
    const resolved = await resolvePath(roots, '/PROJECT/file.txt');
    expect(resolved.virtual).toBe('/project/file.txt');
  });

  it('allows a path that does not exist yet only when asked', async () => {
    await expectRefused('/project/brand-new.txt');
    const resolved = await resolvePath(roots, '/project/brand-new.txt', { allowMissing: true });
    expect(resolved.real).toBe(path.join(approved, 'brand-new.txt'));
  });

  it('allows missing intermediate folders when allowMissing is set', async () => {
    const resolved = await resolvePath(roots, '/project/a/b/c.txt', { allowMissing: true });
    expect(resolved.real).toBe(path.join(approved, 'a', 'b', 'c.txt'));
    expect(resolved.virtual).toBe('/project/a/b/c.txt');
  });
});

describe('resolvePath — traversal', () => {
  it('rejects ".." segments', async () => {
    const err = await expectRefused('/project/../outside/secret.txt');
    expect(err.message).toMatch(/traversal/i);
  });

  it('rejects ".." buried deeper in the path', async () => {
    await expectRefused('/project/sub/deep/../../../outside/secret.txt');
  });

  it.runIf(IS_WINDOWS)('rejects ".." written with backslashes', async () => {
    await expectRefused('\\project\\..\\outside\\secret.txt');
  });

  it('rejects ".." even when the result would stay inside the root', async () => {
    // Refusing unconditionally keeps the rule simple enough to audit.
    await expectRefused('/project/sub/../file.txt');
  });

  it('rejects ".." when creating a file', async () => {
    await expectRefused('/project/../outside/planted.txt', true);
  });

  it('rejects a bare ".."', async () => {
    await expectRefused('/..');
  });
});

describe.runIf(IS_WINDOWS)('resolvePath — Windows path tricks', () => {
  it('rejects an absolute Windows path', async () => {
    await expectRefused('C:\\Windows\\System32\\drivers\\etc\\hosts');
  });

  it('rejects a drive-relative path', async () => {
    await expectRefused('/project/C:file.txt');
  });

  it('rejects an NTFS alternate data stream', async () => {
    const err = await expectRefused('/project/file.txt:hidden');
    expect(err.message).toMatch(/":"/);
  });

  it('rejects reserved device names', async () => {
    for (const name of ['CON', 'nul', 'com1', 'LPT9', 'aux.txt', 'CONIN$']) {
      const err = await expectRefused(`/project/${name}`);
      expect(err.message, name).toMatch(/reserved Windows device name/);
    }
  });

  it('rejects a trailing dot, which Windows would strip', async () => {
    // "file.txt." addresses "file.txt" on Windows, so allowing it would let the
    // same file be reached by a name the checks above never saw.
    const err = await expectRefused('/project/file.txt.');
    expect(err.message).toMatch(/dot or space/);
  });

  it('rejects a trailing space', async () => {
    await expectRefused('/project/file.txt ');
  });

  it('rejects wildcards and other illegal characters', async () => {
    for (const bad of ['*', '?', '<a>', 'a|b', 'a"b']) {
      await expectRefused(`/project/${bad}`);
    }
  });

  it('rejects a UNC path', async () => {
    await expectRefused('\\\\server\\share\\secret.txt');
  });
});

describe('resolvePath — roots', () => {
  it('rejects a null byte on every platform', async () => {
    const err = await expectRefused('/project/file.txt\0.png');
    expect(err.message).toMatch(/null byte/);
  });

  it('rejects a control character on every platform', async () => {
    await expectRefused('/project/fi\x07le.txt');
  });

  it('rejects an unknown root and names the approved ones', async () => {
    const err = await expectRefused('/nope/file.txt');
    expect(err.message).toContain('/project');
  });

  it('rejects an empty path', async () => {
    await expectRefused('/');
  });

  it('rejects an over-long path', async () => {
    await expectRefused(`/project/${'a'.repeat(5000)}`);
  });

  it('rejects an over-long segment', async () => {
    await expectRefused(`/project/${'a'.repeat(300)}.txt`);
  });

  it('does not treat a root name as a prefix of another', async () => {
    const two: Root[] = [
      { name: 'project', path: approved },
      { name: 'project-two', path: outside }
    ];
    const resolved = await resolvePath(two, '/project-two/secret.txt');
    expect(resolved.real).toBe(path.join(outside, 'secret.txt'));
  });
});

describe('resolvePath — links and reparse points', () => {
  let escapeLink: string;
  let innerLink: string;

  beforeAll(async () => {
    escapeLink = path.join(approved, 'escape');
    innerLink = path.join(approved, 'inner');
    await fs.symlink(outside, escapeLink, DIR_LINK);
    await fs.symlink(path.join(approved, 'sub'), innerLink, DIR_LINK);
  });

  it('creates a real reparse point for the test to be meaningful', async () => {
    const stat = await fs.lstat(escapeLink);
    expect(stat.isSymbolicLink() || stat.isDirectory()).toBe(true);
    // Sanity: without canonicalisation this path really would reach the secret.
    const leaked = await fs.readFile(path.join(escapeLink, 'secret.txt'), 'utf8');
    expect(leaked).toBe('TOP SECRET');
  });

  it('rejects reading through a junction that leaves the root', async () => {
    const err = await expectRefused('/project/escape/secret.txt');
    expect(err.message).toMatch(/escapes its approved folder/);
  });

  it('rejects the junction itself', async () => {
    await expectRefused('/project/escape');
  });

  it('rejects creating a file through an escaping junction', async () => {
    await expectRefused('/project/escape/planted.txt', true);
  });

  it('still rejects an escaping link when the caller used a native path', async () => {
    const err = await expectRefused(path.join(escapeLink, 'secret.txt'));
    expect(err.message).toMatch(/escapes its approved folder/);
  });

  it('allows a junction that stays inside the root, reporting the canonical path', async () => {
    const resolved = await resolvePath(roots, '/project/inner/nested.txt');
    expect(resolved.real).toBe(path.join(approved, 'sub', 'nested.txt'));
    // The virtual path reflects where the file really is, not how it was reached.
    expect(resolved.virtual).toBe('/project/sub/nested.txt');
  });

  it('canonicalizes an internal link reached through a native path', async () => {
    const resolved = await resolvePath(roots, path.join(innerLink, 'nested.txt'));
    expect(resolved.real).toBe(path.join(approved, 'sub', 'nested.txt'));
    expect(resolved.virtual).toBe('/project/sub/nested.txt');
  });

  it.runIf(!IS_WINDOWS)('rejects a file symlink that leaves the root', async () => {
    const link = path.join(approved, 'secret-link.txt');
    await fs.symlink(path.join(outside, 'secret.txt'), link);
    await expectRefused('/project/secret-link.txt');
    await fs.unlink(link);
  });

  it.runIf(IS_WINDOWS)('does not let replacing the approved root with a junction retarget its permission', async () => {
    const original = path.join(base, 'approved-swap');
    const moved = path.join(base, 'approved-swap-moved');
    const target = path.join(base, 'unapproved-swap-target');
    await writeTree(original, { 'allowed.txt': 'allowed' });
    await writeTree(target, { 'secret.txt': 'SECRET OUTSIDE THE APPROVED ROOT' });
    const canonical = await validateNewRoot(original, []);
    const swapRoots: Root[] = [{ name: 'swap', path: canonical }];

    await fs.rename(original, moved);
    await fs.symlink(target, original, DIR_LINK);
    try {
      // Sanity: Windows itself follows the replacement junction to the unapproved target.
      await expect(fs.readFile(path.join(original, 'secret.txt'), 'utf8')).resolves.toBe('SECRET OUTSIDE THE APPROVED ROOT');
      await expect(resolvePath(swapRoots, '/swap/secret.txt')).rejects.toThrow(/root.*(?:changed|available)|approve again/i);
    } finally {
      await fs.rm(original, { recursive: true, force: true });
      await fs.rename(moved, original);
    }
  });
});

describe('isContained', () => {
  it('treats a path as containing itself', () => {
    expect(isContained('C:\\Root', 'C:\\Root')).toBe(true);
  });

  it('accepts a descendant', () => {
    expect(isContained('C:\\Root', path.join('C:\\Root', 'a', 'b'))).toBe(true);
  });

  it('rejects a sibling that shares a name prefix', () => {
    expect(isContained('C:\\Root', 'C:\\RootEvil')).toBe(false);
    expect(isContained('C:\\Root', 'C:\\Root-2\\a')).toBe(false);
  });

  it.runIf(IS_WINDOWS)('ignores case on Windows', () => {
    expect(isContained('C:\\Root', 'c:\\root\\a')).toBe(true);
  });
});

describe('splitVirtualPath', () => {
  it('splits and validates', () => {
    expect(splitVirtualPath('/a/b/c')).toEqual(['a', 'b', 'c']);
  });

  it('rejects a non-string', () => {
    expect(() => splitVirtualPath(42 as unknown as string)).toThrow(SandboxError);
  });
});

describe('toVirtualPath', () => {
  const root: Root = { name: 'docs', path: 'C:\\Docs' };

  it('maps the root itself', () => {
    expect(toVirtualPath(root, 'C:\\Docs', 'C:\\Docs')).toBe('/docs');
  });

  it('uses forward slashes', () => {
    expect(toVirtualPath(root, 'C:\\Docs', path.join('C:\\Docs', 'a', 'b.txt'))).toBe('/docs/a/b.txt');
  });
});

describe('root names', () => {
  it('normalises to a safe slug', () => {
    expect(normaliseRootName('My Documents')).toBe('my-documents');
    expect(normaliseRootName('C++ Projects!')).toBe('c-projects');
    expect(normaliseRootName('...')).toBe('folder');
    expect(normaliseRootName('')).toBe('folder');
    expect(normaliseRootName('a'.repeat(80)).length).toBe(32);
  });

  it('avoids collisions', () => {
    const existing: Root[] = [
      { name: 'src', path: path.join(path.parse(process.cwd()).root, 'a') },
      { name: 'src-2', path: path.join(path.parse(process.cwd()).root, 'b') }
    ];
    expect(uniqueRootName(path.join(path.parse(process.cwd()).root, 'x', 'src'), existing)).toBe('src-3');
    expect(uniqueRootName(path.join(path.parse(process.cwd()).root, 'x', 'other'), existing)).toBe('other');
  });
});

describe('validateNewRoot', () => {
  it('accepts a normal folder', async () => {
    expect(await validateNewRoot(approved, [])).toBe(approved);
  });

  it('rejects a relative path', async () => {
    await expect(validateNewRoot(path.join('relative', 'path'), [])).rejects.toBeInstanceOf(SandboxError);
  });

  it.runIf(IS_WINDOWS)('rejects a UNC path', async () => {
    await expect(validateNewRoot('\\\\server\\share', [])).rejects.toThrow(/UNC/);
  });

  it.runIf(IS_WINDOWS)('rejects a whole drive', async () => {
    await expect(validateNewRoot(path.parse(base).root, [])).rejects.toThrow(/entire drive/);
  });

  it.runIf(!IS_WINDOWS)('rejects the whole filesystem root', async () => {
    await expect(validateNewRoot(path.parse(base).root, [])).rejects.toThrow(/entire filesystem root/);
  });

  it('rejects a file', async () => {
    await expect(validateNewRoot(path.join(approved, 'file.txt'), [])).rejects.toThrow(/not a folder/);
  });

  it('rejects a folder inside an existing root', async () => {
    await expect(
      validateNewRoot(path.join(approved, 'sub'), [{ name: 'project', path: approved }])
    ).rejects.toThrow(/overlaps/);
  });

  it('rejects a folder that contains an existing root', async () => {
    await expect(
      validateNewRoot(base, [{ name: 'project', path: approved }])
    ).rejects.toThrow(/overlaps/);
  });

  it('accepts a sibling folder', async () => {
    expect(await validateNewRoot(outside, [{ name: 'project', path: approved }])).toBe(outside);
  });
});

describe.runIf(!IS_WINDOWS)('a native POSIX path', () => {
  it('resolves an absolute shell path inside an approved root', async () => {
    const resolved = await resolvePath(roots, path.join(approved, 'sub', 'nested.txt'));
    expect(resolved.real).toBe(path.join(approved, 'sub', 'nested.txt'));
    expect(resolved.virtual).toBe('/project/sub/nested.txt');
  });

  it('resolves the approved root itself', async () => {
    const resolved = await resolvePath(roots, approved);
    expect(resolved.real).toBe(approved);
    expect(resolved.virtual).toBe('/project');
  });

  it('rejects native dot-dot before normalization can erase it', async () => {
    const error = await expectRefused(`${approved}/sub/../file.txt`);
    expect(error.message).toMatch(/traversal/i);
  });

  it('refuses an absolute path outside every approved root', async () => {
    const error = await expectRefused(path.join(outside, 'secret.txt'));
    expect(error.message).toContain('not inside an approved folder');
    expect(error.message).toContain('/project');
    expect(error.message).not.toContain('If you meant');
  });

  it('suggests the approved spelling when a refused path names a root by folder name', async () => {
    // Nearly every refused path in the recorded sessions was a real file under a root, spelled
    // from a guessed drive or one folder too high. The refusal now carries the spelling to try;
    // it resolves nothing itself.
    const native = await expectRefused(IS_WINDOWS ? 'D:\\project\\sub\\nested.txt' : '/elsewhere/project/sub/nested.txt');
    expect(native.message).toContain('If you meant the approved folder, its path is /project/sub/nested.txt.');
    const nested = await expectRefused('/home/me/Project/sub/nested.txt');
    expect(nested.message).toContain('not inside an approved folder');
    expect(nested.message).toContain('If you meant the approved folder, its path is /project/sub/nested.txt.');
    const root = await expectRefused('/home/me/project');
    expect(root.message).toContain('its path is /project.');
  });

  it('allows POSIX filenames that Windows reserves', async () => {
    for (const name of ['CON', 'name:with-colon', 'trailing.']) {
      await fs.writeFile(path.join(approved, name), name);
      const resolved = await resolvePath(roots, `/project/${name}`);
      expect(resolved.real).toBe(path.join(approved, name));
    }
  });

  it('treats a backslash as a filename character rather than a separator', async () => {
    const name = 'back\\slash.txt';
    await fs.writeFile(path.join(approved, name), 'backslash');
    const resolved = await resolvePath(roots, `/project/${name}`);
    expect(resolved.real).toBe(path.join(approved, name));
    expect(resolved.virtual).toBe(`/project/${name}`);

    const relative = await resolvePath(roots, name, { base: '/project' });
    expect(relative.real).toBe(path.join(approved, name));
    expect(relative.virtual).toBe(`/project/${name}`);
  });

  it('keeps an approved virtual root unambiguous with native / paths', async () => {
    const resolved = await resolvePath(roots, '/project/sub/nested.txt');
    expect(resolved.virtual).toBe('/project/sub/nested.txt');
  });
});

/** Native drive paths copied from command output are normalized back into the virtual sandbox. */
describe.runIf(IS_WINDOWS)('a native Windows path', () => {
  it('accepts the DOS 8.3 spelling of an approved file as the same native path', async () => {
    const long = path.join(approved, 'sub', 'nested.txt');
    const short = execFileSync(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', `for %I in ("${long}") do @echo %~sI`],
      { encoding: 'utf8' }
    ).trim();
    // Some volumes disable 8.3 aliases. The regression is meaningful only when Windows
    // actually supplies a distinct short spelling for the file.
    if (!short.includes('~') || short.toLowerCase() === long.toLowerCase()) return;

    const resolved = await resolvePath(roots, short);
    expect(resolved.real).toBe(long);
    expect(resolved.virtual).toBe('/project/sub/nested.txt');
  });

  it('resolves a file inside an approved root', async () => {
    const resolved = await resolvePath(roots, path.join(approved, 'sub', 'nested.txt'));
    expect(resolved.real).toBe(path.join(approved, 'sub', 'nested.txt'));
    expect(resolved.virtual).toBe('/project/sub/nested.txt');
  });

  it('resolves the approved root itself', async () => {
    const resolved = await resolvePath(roots, approved);
    expect(resolved.real).toBe(approved);
    expect(resolved.virtual).toBe('/project');
  });

  it('rejects native dot-dot before Windows normalization can erase it', async () => {
    const error = await expectRefused(`${approved}\\sub\\..\\file.txt`);
    expect(error.message).toMatch(/traversal/i);
  });

  it('says it is outside the approved folders when it is, and lists them', async () => {
    const error = await expectRefused(path.join(outside, 'secret.txt'));
    expect(error.message).toContain('not inside an approved folder');
    expect(error.message).toContain('/project');
    expect(error.message).not.toContain('/project/');
  });

  it('refuses a UNC path without pretending to know a virtual path for it', async () => {
    const error = await expectRefused(String.raw`\\server\share\file.txt`);
    expect(error.message).toContain('not inside an approved folder');
  });

  it('still resolves a virtual path that merely looks similar', async () => {
    // "project" is a root name, not a drive letter: the guard must not catch it.
    const resolved = await resolvePath(roots, '/project/sub/nested.txt');
    expect(resolved.virtual).toBe('/project/sub/nested.txt');
  });
});
