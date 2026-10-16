import path from 'node:path';

import * as local from '../codex/filesystem.js';
import type {
  CreateDirectoryOptions, FileMetadata, ReadDirectoryEntry, RemoveOptions, WalkOptions, WalkOutcome
} from '../codex/filesystem.js';
import type { RemoteFolder, Root } from '../../shared/types.js';
import { SftpError, type SftpClient, type SftpStats } from './sftp.js';
import { sftpFor } from './ssh.js';

/**
 * The file system the tools work on (#1469): this computer's, or a server's over SFTP. Both take
 * the real paths `resolvePath` returns and behave alike, errors included (`ENOENT`, `EEXIST`,
 * `EINVAL` …), so a tool written against one works on the other.
 */
export interface ProjectFs {
  /** How paths are spelled there: this computer's own rules, or POSIX on a server. */
  readonly path: path.PlatformPath;
  getMetadata(path: string): Promise<FileMetadata>;
  readDirectory(path: string): Promise<ReadDirectoryEntry[]>;
  readFileStream(path: string): AsyncGenerator<Buffer, void, undefined>;
  readFile(path: string, maxBytes?: number): Promise<Buffer>;
  /** `readFile` plus the strict UTF-8 decode, byte-order mark kept. */
  readFileText(path: string): Promise<string>;
  writeFile(path: string, contents: Buffer | string): Promise<void>;
  createDirectory(path: string, options: CreateDirectoryOptions): Promise<void>;
  remove(path: string, options: RemoveOptions): Promise<void>;
  walk(root: string, options: WalkOptions): Promise<WalkOutcome>;
}

/**
 * This computer's file system. Each call looks its function up when it runs, as the direct imports
 * did, so a test that replaces one of them still sees every call.
 */
export const localFs: ProjectFs = {
  path,
  getMetadata: target => local.getMetadata(target),
  readDirectory: target => local.readDirectory(target),
  readFileStream: target => local.readFileStream(target),
  readFile: (target, maxBytes) => local.readFile(target, maxBytes),
  readFileText: target => local.readFileText(target),
  writeFile: (target, contents) => local.writeFile(target, contents),
  createDirectory: (target, options) => local.createDirectory(target, options),
  remove: (target, options) => local.remove(target, options),
  walk: (root, options) => local.walk(root, options)
};

export function fsForRoot(root: Root): ProjectFs {
  return root.remote ? sftpFs(root.remote) : localFs;
}

const failure = (code: string, message: string, target: string) => new SftpError(code, message, target);
const exists = (client: SftpClient, target: string) =>
  client.lstat(target).then(stats => stats, (error: SftpError) => { if (error.code === 'ENOENT') return null; throw error; });

function metadataOf(link: SftpStats, target: SftpStats): FileMetadata {
  // SFTP version 3 carries no creation time; Codex reports an unknown time as zero.
  return {
    isDirectory: target.isDirectory, isFile: target.isFile, isSymlink: link.isSymbolicLink,
    size: target.size, createdAtMs: 0, modifiedAtMs: target.mtimeMs
  };
}

/** Removes a tree without following links: a link is removed, never what it points to. */
async function removeTree(client: SftpClient, target: string): Promise<void> {
  for (const entry of await client.readdir(target)) {
    const child = path.posix.join(target, entry.name);
    if (entry.isDirectory && !entry.isSymbolicLink) await removeTree(client, child);
    else await client.remove(child);
  }
  await client.rmdir(target);
}

/** The server folder's file system, over the address's shared SFTP session. */
export function sftpFs(remote: RemoteFolder): ProjectFs {
  /**
   * Runs one operation, and once more on a new session when the connection dropped under it. Every
   * operation here is safe to repeat: a write replaces the file whole, a folder that now exists
   * is what was asked for, and a removal that already happened is checked again.
   */
  const withClient = async <T>(operation: (client: SftpClient) => Promise<T>): Promise<T> => {
    const client = await sftpFor(remote);
    try {
      return await operation(client);
    } catch (error) {
      if (!client.closed) throw error;
      return await operation(await sftpFor(remote));
    }
  };

  const getMetadata = (target: string) => withClient(async client => {
    const link = await client.lstat(target);
    return metadataOf(link, link.isSymbolicLink ? await client.stat(target) : link);
  });
  // Entries carry the link's own attributes: a link stays opaque, as in a local listing.
  const readDirectory = (target: string) => withClient(async client => (await client.readdir(target)).map(entry => ({
    fileName: entry.name,
    isDirectory: !entry.isSymbolicLink && entry.isDirectory,
    isFile: !entry.isSymbolicLink && entry.isFile
  })));

  const readFile = (target: string, maxBytes: number = local.MAX_READ_FILE_BYTES) => withClient(async client => {
    const limit = Number.isFinite(maxBytes) ? Math.max(1, Math.min(local.MAX_READ_FILE_BYTES, Math.floor(maxBytes))) : local.MAX_READ_FILE_BYTES;
    const tooLarge = () => local.invalidInput(`file is too large to read: limit is ${limit} bytes`);
    if ((await client.stat(target)).size > limit) throw tooLarge();
    // One byte past the limit shows a file that grew since the size was read.
    const bytes = await client.readFile(target, { maxBytes: limit + 1 });
    if (bytes.length > limit) throw tooLarge();
    return bytes;
  });

  return {
    path: path.posix,
    getMetadata,
    readDirectory,
    readFile,
    readFileText: async target => local.decodeFileText(await readFile(target)),

    async *readFileStream(target) {
      yield* (await sftpFor(remote)).readStream(target);
    },

    writeFile: (target, contents) => withClient(async client => {
      // A local write goes through a link to its target; the SFTP write replaces whatever is at
      // the path, so it is given the link's target instead.
      const at = (await exists(client, target))?.isSymbolicLink ? await client.realpath(target) : target;
      await client.writeFile(at, typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents);
    }),

    createDirectory: (target, options) => withClient(async client => {
      const make = async (folder: string, existingIsFine: boolean) => {
        const before = await exists(client, folder);
        if (before) {
          if (before.isDirectory || (before.isSymbolicLink && (await client.stat(folder).catch(() => null))?.isDirectory)) {
            if (existingIsFine) return;
            throw failure('EEXIST', 'File exists', folder);
          }
          throw failure(existingIsFine ? 'ENOTDIR' : 'EEXIST', existingIsFine ? 'Not a directory' : 'File exists', folder);
        }
        try { await client.mkdir(folder); }
        catch (error) {
          // A folder made meanwhile by someone else is still the folder that was asked for.
          if (existingIsFine && (await client.stat(folder).catch(() => null))?.isDirectory) return;
          throw error;
        }
      };
      if (!options.recursive) return await make(target, false);
      const parts = target.split('/').filter(Boolean);
      for (let index = 1; index <= parts.length; index++) await make(`/${parts.slice(0, index).join('/')}`, true);
    }),

    remove: (target, options) => withClient(async client => {
      const stats = await exists(client, target);
      if (!stats) {
        if (options.force) return;
        throw failure('ENOENT', 'No such file', target);
      }
      if (!stats.isDirectory) return await client.remove(target);
      if (options.recursive) return await removeTree(client, target);
      try { await client.rmdir(target); }
      catch (error) {
        if ((await client.readdir(target).catch(() => [])).length) throw failure('ENOTEMPTY', 'Directory not empty', target);
        throw error;
      }
    }),

    walk: (root, options) => local.walkWith({
      getMetadata, readDirectory,
      canonicalize: target => withClient(client => client.realpath(target)),
      join: path.posix.join
    }, root, options)
  };
}
