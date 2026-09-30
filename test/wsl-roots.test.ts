import { promises as fs, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as rawfs from '../src/main/rawfs.js';
import { isContained, resolvePath, SandboxError, validateNewRoot } from '../src/main/sandbox.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { addProject, listProjects, projectWorkspace } from '../src/main/projects.js';
import { renameProjectEntry } from '../src/main/project-files.js';
import { replaceTextFile } from '../src/main/fsops.js';
import { readTextFile } from '../src/main/codex/read-backend.js';

// Windows WSL paths have a case-insensitive server/distro prefix and case-sensitive Linux
// components. Model those OS results deterministically; no distro, SMB share or admin is needed.
const folder = String.raw`\\wsl.localhost\Ubuntu\home\you\Project`;
const alias = folder.replace('wsl.localhost', 'wsl$');
const sibling = folder.replace('Project', 'project');
const key = (input: string) => input.replace(/^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+/i, String.raw`\\wsl.localhost\ubuntu`);
const missing = () => Object.assign(new Error('Not found'), { code: 'ENOENT' });

describe.runIf(process.platform === 'win32')('Windows WSL approved folders', () => {
  let data: string;
  let entries: Map<string, { real: string; directory: boolean; backing?: string }>;
  let canonical: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    data = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-wsl-roots-'));
    entries = new Map();
    for (const directory of [path.parse(folder).root, folder, sibling, `${folder}\\sub`]) {
      entries.set(key(path.resolve(directory)), { real: path.resolve(directory), directory: true });
    }
    const backing = path.join(data, 'file.txt');
    await fs.writeFile(backing, 'hello');
    entries.set(key(`${folder}\\file.txt`), { real: `${folder}\\file.txt`, directory: false, backing });
    const realpath = rawfs.rawRealpathNative;
    canonical = vi.spyOn(rawfs, 'rawRealpathNative').mockImplementation(async target => {
      if (!path.resolve(target).startsWith('\\\\')) return realpath(target);
      const entry = entries.get(key(path.resolve(target)));
      if (!entry) throw missing();
      // Native realpath preserves the caller's WSL host/distro spelling.
      return entry.real.replace(/^\\\\[^\\]+\\[^\\]+/, target.match(/^\\\\[^\\]+\\[^\\]+/)![0]);
    });
    const stat = rawfs.rawPromises.stat;
    vi.spyOn(rawfs.rawPromises, 'stat').mockImplementation((async target => {
      if (typeof target !== 'string' || !target.startsWith('\\\\')) return stat(target);
      const entry = entries.get(key(path.resolve(target)));
      if (!entry) throw missing();
      if (entry.backing) return stat(entry.backing);
      return { isDirectory: () => entry.directory } as Stats;
    }) as typeof stat);
    const lstat = rawfs.rawPromises.lstat;
    vi.spyOn(rawfs.rawPromises, 'lstat').mockImplementation((async target => {
      if (typeof target !== 'string' || !target.startsWith('\\\\')) return lstat(target);
      // WSL's unsupported Linux directory links can fail native realpath with ENOENT,
      // but lstat with EISDIR. They are not absent directories available for creation.
      if (target === `${folder}\\unresolved-link`) throw Object.assign(new Error(`EISDIR: lstat '${target}'`), { code: 'EISDIR' });
      const entry = entries.get(key(path.resolve(target)));
      if (!entry) throw missing();
      if (entry.backing) return lstat(entry.backing);
      return { isDirectory: () => entry.directory, isFile: () => !entry.directory, isSymbolicLink: () => false } as Stats;
    }) as typeof lstat);
    initConfigPath(data); initDurableStore(data);
  });

  afterEach(async () => {
    vi.restoreAllMocks(); resetDurableForTests();
    await fs.rm(data, { recursive: true, force: true });
  });

  it('approves a WSL picker folder and resolves its native, alias, virtual and new-file paths', async () => {
    const root = { name: 'work', path: await validateNewRoot(folder, []) };
    expect(root.path).toBe(folder);
    expect(await validateNewRoot(alias, [])).toBe(alias);
    for (const native of [folder, alias, folder.replace('Ubuntu', 'UBUNTU')]) {
      expect((await resolvePath([root], `${native}\\file.txt`)).virtual).toBe('/work/file.txt');
    }
    expect((await resolvePath([root], '/work/file.txt')).real).toBe(`${folder}\\file.txt`);
    expect((await resolvePath([root], `${alias}\\sub\\new.txt`, { allowMissing: true })).real).toBe(`${folder}\\sub\\new.txt`);
    await expect(resolvePath([root], '/work/sub/new.txt')).rejects.toThrow(/Not found/);
  });

  it('opens the approved WSL project, deduplicates aliases and keeps Linux-case siblings separate', async () => {
    const approved = await validateNewRoot(folder, []);
    const second = await validateNewRoot(sibling, [{ name: 'work', path: approved }]);
    await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: approved }, { name: 'second', path: second }] });
    const project = await addProject(folder);
    expect((await addProject(alias)).id).toBe(project.id);
    const another = await addProject(sibling);
    expect(another.id).not.toBe(project.id);
    expect(await listProjects()).toHaveLength(2);
    expect(await projectWorkspace(project.id)).toEqual({ real: folder, virtual: '/work' });
  });

  it('retains exact Linux case for containment and virtual suffixes', async () => {
    expect(isContained(folder, sibling)).toBe(false);
    expect(isContained(folder, `${sibling}\\secret.txt`)).toBe(false);
    entries.set(key(`${folder}\\Sub`), { real: `${folder}\\Sub`, directory: true });
    const root = { name: 'work', path: folder };
    expect((await resolvePath([root], `${alias}\\Sub`)).virtual).toBe('/work/Sub');
    await expect(resolvePath([root], `${sibling}\\secret.txt`, { allowMissing: true })).rejects.toThrow(/not inside/);
    expect(isContained('C:\\Work', 'c:\\work\\child')).toBe(true);
  });

  it('reads and writes the resolved WSL file through the production text backends', async () => {
    const backing = entries.get(key(`${folder}\\file.txt`))!.backing!;
    const open = rawfs.rawPromises.open;
    const readFile = rawfs.rawPromises.readFile;
    const writeFile = rawfs.rawPromises.writeFile;
    const actual = (target: unknown) => {
      if (typeof target !== 'string' || !target.startsWith('\\\\')) return target;
      const matched = entries.get(key(target))?.backing;
      if (!matched) throw missing();
      return matched;
    };
    vi.spyOn(rawfs.rawPromises, 'open').mockImplementation(((target: unknown, ...args: unknown[]) =>
      (open as (...input: unknown[]) => Promise<unknown>)(actual(target), ...args)) as unknown as typeof open);
    vi.spyOn(rawfs.rawPromises, 'readFile').mockImplementation(((target: unknown, ...args: unknown[]) =>
      (readFile as (...input: unknown[]) => Promise<unknown>)(actual(target), ...args)) as unknown as typeof readFile);
    vi.spyOn(rawfs.rawPromises, 'writeFile').mockImplementation(((target: unknown, ...args: unknown[]) =>
      (writeFile as (...input: unknown[]) => Promise<unknown>)(actual(target), ...args)) as unknown as typeof writeFile);
    const root = { name: 'work', path: await validateNewRoot(folder, []) };
    const native = await resolvePath([root], `${alias}\\file.txt`);
    expect((await readTextFile(native.real)).text).toContain('hello');
    await replaceTextFile(native.real, 'updated\n');
    const virtual = await resolvePath([root], '/work/file.txt');
    expect((await readTextFile(virtual.real)).text).toContain('updated');
    expect(await fs.readFile(backing, 'utf8')).toBe('updated\n');
  });

  it('refuses to rename over a different Linux-case file in the project', async () => {
    const backing = entries.get(key(`${folder}\\file.txt`))!.backing!;
    entries.set(key(`${folder}\\File.txt`), { real: `${folder}\\File.txt`, directory: false, backing });
    await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: folder }] });
    const project = await addProject(folder);
    const rename = vi.spyOn(rawfs.rawPromises, 'rename');
    await expect(renameProjectEntry(project.id, 'File.txt', 'file.txt')).rejects.toThrow(/already exists/);
    expect(rename).not.toHaveBeenCalled();
    expect(await fs.readFile(backing, 'utf8')).toBe('hello');
  });

  it('rejects UNC hosts, other distros and unapproved WSL folders before filesystem lookup', async () => {
    const root = { name: 'work', path: folder };
    for (const candidate of [String.raw`\\server\share\folder`, String.raw`\\wsl.localhost.evil\Ubuntu\home\you\Project`, String.raw`\\wsl.localhost\Debian\home\you\Project`, sibling]) {
      canonical.mockClear();
      await expect(resolvePath([root], candidate)).rejects.toThrow(/not inside/);
      expect(canonical).not.toHaveBeenCalled();
    }
    for (const candidate of [String.raw`\\server\share\folder`, '//server/share/folder', String.raw`\\?\UNC\wsl.localhost\Ubuntu\home\you\Project`]) {
      canonical.mockClear();
      await expect(validateNewRoot(candidate, [])).rejects.toThrow(/UNC/);
      expect(canonical).not.toHaveBeenCalled();
    }
  });

  it('rejects a whole distro, overlapping aliases, traversal and invalid Windows segments', async () => {
    await expect(validateNewRoot(path.parse(folder).root, [])).rejects.toThrow(/entire/);
    await expect(validateNewRoot(alias, [{ name: 'work', path: folder }])).rejects.toThrow(/overlaps/);
    for (const suffix of ['sub\\..\\file.txt', 'sub\\.\\file.txt', 'file.txt:stream', 'nul', 'name.']) {
      canonical.mockClear();
      await expect(resolvePath([{ name: 'work', path: folder }], `${alias}\\${suffix}`)).rejects.toThrow();
      expect(canonical).not.toHaveBeenCalled();
    }
    canonical.mockClear();
    await expect(validateNewRoot(`${folder}\\..\\Project`, [])).rejects.toThrow(/traversal/);
    expect(canonical).not.toHaveBeenCalled();
  });

  it('rejects redirected and unresolved Linux links for reads and missing-file writes', async () => {
    entries.set(key(`${folder}\\escape`), { real: sibling, directory: true });
    for (const allowMissing of [false, true]) {
      await expect(resolvePath([{ name: 'work', path: folder }], '/work/escape/new.txt', { allowMissing })).rejects.toThrow(/escapes/);
      const unresolved = resolvePath([{ name: 'work', path: folder }], '/work/unresolved-link/new.txt', { allowMissing });
      await expect(unresolved).rejects.toBeInstanceOf(SandboxError);
      await expect(unresolved).rejects.toThrow('Path could not be resolved safely');
      await expect(unresolved).rejects.not.toThrow(folder);
    }
    entries.set(key(folder), { real: sibling, directory: true });
    await expect(resolvePath([{ name: 'work', path: folder }], '/work')).rejects.toThrow(/changed/);
  });
});
