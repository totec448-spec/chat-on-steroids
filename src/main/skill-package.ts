/** Whole-package import from #260, with bounded snapshots and SKILL.md published last. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rawPromises as fs, rawRealpathNative } from './rawfs.js';
import { isContained } from './sandbox.js';

const MAX_ENTRIES = 4096;
const MAX_BYTES = 32 * 1024 * 1024;
type Identity = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
const identical = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const nativeEqual = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const realpath = (file: string): Promise<string> => process.platform === 'win32' ? rawRealpathNative(file) : fs.realpath(file);

export async function publishSkillPackage(source: string, root: string, id: string, expectedSkill: Buffer): Promise<void> {
  const sourceReal = await realpath(source);
  const target = path.join(root, id);
  if (!isContained(root, target) || path.dirname(target) !== root) throw new Error('Invalid skill package destination');
  const createdFiles: Array<{ file: string; identity: Identity }> = [];
  const createdDirectories: Array<{ file: string; identity: Identity }> = [];
  let entries = 0, bytes = 0;
  const assertTarget = async (file: string): Promise<void> => {
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !nativeEqual(await realpath(root), root)) throw new Error('The Skills directory changed during import');
    const parent = path.dirname(file);
    if (!isContained(root, file) || !nativeEqual(await realpath(parent), parent)) throw new Error('The package destination was redirected');
  };
  const copyFile = async (from: string, to: string, isSkill = false): Promise<void> => {
    const handle = await fs.open(from, 'r');
    let data: Buffer;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_BYTES - bytes) throw new Error('Skill package exceeds 32 MiB');
      data = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < data.length) {
        const read = await handle.read(data, offset, data.length - offset, offset);
        if (!read.bytesRead) throw new Error('Skill resource changed during import');
        offset += read.bytesRead;
      }
      if (!identical(before, await handle.stat()) || !identical(before, await fs.lstat(from)) ||
          !isContained(sourceReal, await realpath(from))) throw new Error('Skill resource changed during import');
    } finally { await handle.close(); }
    if (isSkill && !data.equals(expectedSkill)) throw new Error('SKILL.md changed during import');
    bytes += data.length;
    await assertTarget(to);
    const output = await fs.open(to, 'wx', 0o600);
    try {
      await output.writeFile(data); await output.sync();
      createdFiles.push({ file: to, identity: await output.stat() });
    } catch (error) {
      createdFiles.push({ file: to, identity: await output.stat() });
      throw error;
    } finally { await output.close(); }
  };
  const copyDirectory = async (from: string, to: string, depth: number): Promise<void> => {
    if (depth > 16) throw new Error('Skill package nesting is too deep');
    const before = await fs.lstat(from);
    if (!before.isDirectory() || before.isSymbolicLink() || !isContained(sourceReal, await realpath(from))) throw new Error('Skill packages cannot contain linked folders');
    await assertTarget(to);
    await fs.mkdir(to, { mode: 0o700 });
    createdDirectories.push({ file: to, identity: await fs.lstat(to) });
    const directory = await fs.opendir(from);
    for await (const entry of directory) {
      if (++entries > MAX_ENTRIES) throw new Error('Skill package exceeds 4096 entries');
      if (depth === 0 && entry.name === 'SKILL.md') continue;
      const current = path.join(from, entry.name), destination = path.join(to, entry.name);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Skill packages cannot contain symbolic links or junctions');
      if (stat.isDirectory()) await copyDirectory(current, destination, depth + 1);
      else if (stat.isFile()) await copyFile(current, destination);
      else throw new Error('Skill package contains an unsupported filesystem entry');
    }
    if (!identical(before, await fs.lstat(from))) throw new Error('Skill package changed during import');
  };
  try {
    await copyDirectory(source, target, 0);
    // No catalog row exists until all resources are present. Exclusive publication never
    // replaces another tool's SKILL.md, even if it appeared while resources were copied.
    const temp = path.join(target, `.import-${randomUUID()}.tmp`);
    await copyFile(path.join(source, 'SKILL.md'), temp, true);
    await assertTarget(temp);
    const final = path.join(target, 'SKILL.md');
    await fs.link(temp, final);
    createdFiles.push({ file: final, identity: await fs.lstat(final) });
    // The catalog file is now committed. Temp cleanup cannot turn a successful
    // installation into an error that invites another import of the same package.
    await fs.unlink(temp).catch(() => undefined);
  } catch (error) {
    for (const owned of createdFiles.reverse()) {
      try {
        const current = await fs.lstat(owned.file);
        if (!current.isSymbolicLink() && identical(owned.identity, current)) await fs.unlink(owned.file);
      } catch { /* Preserve any unprovable or externally changed path. */ }
    }
    for (const owned of createdDirectories.reverse()) {
      try {
        const current = await fs.lstat(owned.file);
        if (!current.isSymbolicLink() && current.dev === owned.identity.dev && current.ino === owned.identity.ino) await fs.rmdir(owned.file);
      } catch { /* A concurrent resource remains owned by its writer. */ }
    }
    throw error;
  }
}
