/** Exclusive partial and no-overwrite publication inside a sandbox-resolved existing directory. */
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { rawPromises as fs } from '../rawfs.js';

export const ARTIFACT_PARTIAL_PREFIX = '.steroids-download-';
export const ARTIFACT_PARTIAL_SUFFIX = '.partial';
export class ArtifactTargetError extends Error {}
export interface ArtifactTargetOptions {
  /** Canonical sandbox-resolved paths, not caller spellings (for example /var aliases). */
  parentReal: string;
  rootReal: string;
  name: string;
  maxFileBytes: number;
}
export interface ArtifactTarget {
  writeAll(buffer: Buffer, position: number): Promise<void>;
  syncAndVerify(expectedSize: number): Promise<void>;
  publish(): Promise<void>;
  close(): Promise<void>;
  readonly size: number;
}
const normalized = (value: string): string => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const samePath = (a: string, b: string): boolean => normalized(a) === normalized(b);
type FileStat = Awaited<ReturnType<typeof fs.lstat>>;
const sameFile = (a: FileStat, b: FileStat): boolean => a.dev === b.dev && a.ino === b.ino;

export function assertSafeFileName(name: string): void {
  if (!name || name === '.' || name === '..' || /[/\\:\u0000-\u001f]/.test(name)) {
    throw new ArtifactTargetError('Artifact destination is invalid.');
  }
}

export async function openArtifactTarget({ parentReal, rootReal, name, maxFileBytes }: ArtifactTargetOptions): Promise<ArtifactTarget> {
  assertSafeFileName(name);
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) throw new ArtifactTargetError('Artifact file-size limit must be a positive integer.');
  const relative = path.relative(normalized(rootReal), normalized(parentReal));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ArtifactTargetError('Artifact destination escapes its approved folder.');
  }
  let parent: FileStat;
  try { parent = await fs.lstat(parentReal); }
  catch { throw new ArtifactTargetError('Artifact destination parent is not available. Create the destination folder first.'); }
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new ArtifactTargetError('Artifact destination parent must be a real directory.');

  async function verifyParent(): Promise<void> {
    const [current, canonicalParent, canonicalRoot] = await Promise.all([fs.lstat(parentReal), fs.realpath(parentReal), fs.realpath(rootReal)]);
    if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(current, parent) || !samePath(canonicalParent, parentReal) || !samePath(canonicalRoot, rootReal)) {
      throw new ArtifactTargetError('Artifact destination parent changed during the download.');
    }
  }
  await verifyParent();
  const partialPath = path.join(parentReal, `${ARTIFACT_PARTIAL_PREFIX}${randomUUID()}${ARTIFACT_PARTIAL_SUFFIX}`);
  const candidatePath = path.join(parentReal, name);
  try { await fs.lstat(candidatePath); throw new ArtifactTargetError('Artifact destination already exists.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const handle = await fs.open(partialPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  let original: FileStat;
  try { original = await handle.stat(); }
  catch (error) { await handle.close(); throw error; }
  let writtenBytes = 0, verified = false, published = false, closed = false;

  async function ownedFile(file: string): Promise<boolean> {
    const current = await fs.lstat(file).catch(() => null);
    return !!current && current.isFile() && !current.isSymbolicLink() && sameFile(current, original);
  }
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    // A foreign replacement is never ours to remove; do not sweep older calls' partials.
    try { await verifyParent(); if (await ownedFile(partialPath)) await fs.unlink(partialPath); }
    catch { /* A moved directory or foreign replacement stays untouched. */ }
    await handle.close();
  }
  async function verifyPartial(): Promise<void> {
    await verifyParent();
    const [fd, current] = await Promise.all([handle.stat(), fs.lstat(partialPath)]);
    if (!fd.isFile() || !current.isFile() || current.isSymbolicLink() || !sameFile(fd, original) || !sameFile(current, original) || fd.size !== writtenBytes || current.size !== writtenBytes) {
      throw new ArtifactTargetError('Artifact partial changed before publication.');
    }
  }
  try { await verifyPartial(); }
  catch (error) { await close().catch(() => undefined); throw error; }

  return {
    get size() { return writtenBytes; },
    async writeAll(buffer, position) {
      if (closed || verified || position !== writtenBytes) throw new ArtifactTargetError('Artifact target is not writable at that position.');
      if (writtenBytes + buffer.length > maxFileBytes) throw new ArtifactTargetError('Artifact file exceeds the configured per-file limit.');
      await verifyParent();
      let offset = 0;
      while (offset < buffer.length) {
        const result = await handle.write(buffer, offset, buffer.length - offset, position + offset);
        if (!result.bytesWritten) throw new ArtifactTargetError('Artifact write was interrupted.');
        offset += result.bytesWritten;
      }
      writtenBytes += buffer.length;
    },
    async syncAndVerify(expectedSize) {
      if (closed || writtenBytes !== expectedSize) throw new ArtifactTargetError('Artifact size did not match the downloaded content.');
      await handle.sync();
      await verifyPartial();
      verified = true;
    },
    async publish() {
      if (closed || !verified) throw new ArtifactTargetError('Artifact must be verified before publication.');
      if (published) return;
      // Validate directory and open-file identity again after a long download. Portable
      // Node path I/O cannot pin the directory across the final link syscall; this is
      // bounded revalidation, not a claim of an openat/linkat implementation.
      await verifyPartial();
      try { await fs.link(partialPath, candidatePath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ArtifactTargetError('Artifact destination already exists.');
        throw error;
      }
      await verifyParent();
      if (!await ownedFile(candidatePath)) throw new ArtifactTargetError('Artifact destination changed during publication.');
      published = true;
    },
    close
  };
}
