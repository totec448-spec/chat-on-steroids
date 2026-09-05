/**
 * Codex's filesystem primitives.
 *
 * Ported from `codex-rs/exec-server/src/local_file_system.rs` (`DirectFileSystem`, the
 * unsandboxed backend behind every `fs/*` JSON-RPC method), `codex-rs/exec-server/src/
 * regular_file.rs`, and the bounded walk plus its limits from `codex-rs/file-system/src/lib.rs`.
 *
 * Three substitutions, none of which changes observable behaviour:
 *
 * - Codex addresses files by `PathUri` and converts to an absolute path at every call. Here a
 *   path is already an absolute string, so `to_abs_path()` collapses away. `pathByteLength`
 *   stands in for `PathUri::to_string().len()` in the walk's response-size accounting.
 * - `reject_sandbox_context` guards a parameter this port does not carry: Codex's sandbox
 *   context is one of the systems explicitly out of scope, so there is nothing to reject.
 * - `is_disk_file` calls `GetFileType(handle) == FILE_TYPE_DISK` to reject pipes and character
 *   devices opened by path. Node has no handle-type query, but the `isFile()` check Codex pairs
 *   it with already excludes both on Windows, so only that half survives.
 *
 * Reads go through `rawPromises` so an `.asar` archive is treated as the file it is rather than
 * as the virtual directory Electron would otherwise present.
 */

import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import nodePath from 'node:path';

import { rawPromises } from '../rawfs.js';

/**
 * Codex's `MAX_READ_FILE_BYTES`, used only by the primitive that materializes a whole file.
 *
 * Keep this distinct from model-visible output budgets. `readFile` really does allocate the
 * complete byte buffer, so it keeps Codex's 512 MiB ceiling. Callers that only need part of a
 * large file use `readFileStream`, which never materializes the whole file and is bounded by the
 * caller's own output/work budget instead. Lowering this primitive to 64 MiB silently broke
 * otherwise valid Codex-style reads and every adapter built on `readFileText`.
 */
export const MAX_READ_FILE_BYTES = 512 * 1024 * 1024;
/** `FILE_READ_CHUNK_SIZE`. */
export const FILE_READ_CHUNK_SIZE = 1024 * 1024;

export const MAX_WALK_DEPTH = 64;
export const MAX_WALK_DIRECTORIES = 10_000;
export const MAX_WALK_ENTRIES = 50_000;
export const MAX_WALK_RESPONSE_BYTES = 4 * 1024 * 1024;
export const WALK_RESPONSE_ITEM_OVERHEAD_BYTES = 64;

/** `io::Error::new(ErrorKind::InvalidInput, ...)`, carrying the errno our callers expect. */
export function invalidInput(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = 'EINVAL';
  return error;
}

function fileTooLargeError(limitBytes: number = MAX_READ_FILE_BYTES): NodeJS.ErrnoException {
  return invalidInput(`file is too large to read: limit is ${limitBytes} bytes`);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `FileMetadata`. */
export interface FileMetadata {
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  /** Size in bytes. */
  size: number;
  createdAtMs: number;
  modifiedAtMs: number;
}

/** `ReadDirectoryEntry`. */
export interface ReadDirectoryEntry {
  fileName: string;
  isDirectory: boolean;
  isFile: boolean;
  /** From the `Dirent` itself — no extra stat. A symlink always has `isDirectory`/`isFile` false. */
  isSymlink: boolean;
}

/** `CreateDirectoryOptions`. */
export interface CreateDirectoryOptions {
  recursive: boolean;
}

/** `RemoveOptions`. */
export interface RemoveOptions {
  recursive: boolean;
  force: boolean;
}

/** `WalkOptions`: bounds for a recursive filesystem walk. */
export interface WalkOptions {
  /** Maximum directory depth below the root that may be traversed. */
  maxDepth: number;
  /** Maximum number of directories that may be traversed, including the root. */
  maxDirectories: number;
  /** Maximum number of directory entries that may be examined. */
  maxEntries: number;
  /** Whether directory symlinks should be followed. */
  followDirectorySymlinks: boolean;
  /** Whether directories whose names start with `.` should be returned but not traversed. */
  pruneHiddenDirectories?: boolean;
  /**
   * Returns true for a directory that should be reported but not descended into.
   *
   * The one addition to Codex's `WalkOptions`. Codex only ever walks with a specific job in
   * mind, so it never needed a general skip list; `read` has always skipped build and
   * dependency folders when expanding a glob, and without this the entry budget would be spent
   * inside `node_modules` before reaching the files the caller asked for.
   */
  pruneDirectory?: (entry: ReadDirectoryEntry, path: string) => boolean;
}

export type WalkEntryKind = 'directory' | 'file';

/** `WalkEntry`. */
export interface WalkEntry {
  path: string;
  kind: WalkEntryKind;
}

/** `WalkError`: a descendant that could not be inspected during a walk. */
export interface WalkError {
  path: string;
  message: string;
}

/** `WalkOutcome`: entries and recoverable errors collected by a bounded walk. */
export interface WalkOutcome {
  entries: WalkEntry[];
  errors: WalkError[];
  truncated: boolean;
}

/** `system_time_to_unix_ms`, including its "unrepresentable means zero" fallback. */
function systemTimeToUnixMs(milliseconds: number): number {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 0;
  return Math.trunc(milliseconds);
}

/** `PathUri::to_string().len()`, measured the way Rust measures a `String`. */
function pathByteLength(path: string): number {
  return Buffer.byteLength(path, 'utf8');
}

/** `regular_file::open`: opens a path for reading and refuses anything that is not a real file. */
async function openFileForRead(path: string): Promise<{ handle: FileHandle; stats: Stats }> {
  const handle = await rawPromises.open(path, 'r');
  let stats: Stats;
  try {
    stats = await handle.stat();
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
  if (!stats.isFile()) {
    await handle.close().catch(() => {});
    throw invalidInput(`path \`${path}\` is not a file`);
  }
  return { handle, stats };
}

/** `DirectFileSystem::canonicalize`. */
export async function canonicalize(path: string): Promise<string> {
  return await rawPromises.realpath(path);
}

/**
 * `DirectFileSystem::read_file`, with the same size check on both sides of the read.
 *
 * `maxBytes` lets a narrower transport impose its own ceiling on the *opened handle* instead of
 * doing a racy metadata check and then falling back to this primitive's much larger 512 MiB cap.
 */
export async function readFile(path: string, maxBytes: number = MAX_READ_FILE_BYTES): Promise<Buffer> {
  const limitBytes = Number.isFinite(maxBytes)
    ? Math.max(1, Math.min(MAX_READ_FILE_BYTES, Math.floor(maxBytes)))
    : MAX_READ_FILE_BYTES;
  const { handle, stats } = await openFileForRead(path);
  try {
    if (stats.size > limitBytes) throw fileTooLargeError(limitBytes);
    // `take(MAX + 1)`: one byte past the cap is read so a file that grew since the stat is
    // caught by the second check rather than silently truncated.
    const limit = limitBytes + 1;
    const buffer = Buffer.allocUnsafe(Math.min(FILE_READ_CHUNK_SIZE, limit));
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const remaining = limit - total;
      if (remaining <= 0) break;
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      total += bytesRead;
    }
    const bytes = Buffer.concat(chunks, total);
    if (bytes.length > limitBytes) throw fileTooLargeError(limitBytes);
    return bytes;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * `DirectFileSystem::read_file_stream`: the same gated open, delivered in bounded chunks.
 *
 * This is the primitive for reading part of a file. `readFile` has no partial form -- it reads
 * to the end or fails -- so anything with a byte budget streams instead and stops when it is
 * spent.
 */
export async function* readFileStream(path: string): AsyncGenerator<Buffer, void, undefined> {
  const { handle } = await openFileForRead(path);
  try {
    const buffer = Buffer.allocUnsafe(FILE_READ_CHUNK_SIZE);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return;
      yield Buffer.from(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

/** `ExecutorFileSystem::read_file_text`: `read_file` plus a strict UTF-8 decode. */
export async function readFileText(path: string): Promise<string> {
  const bytes = await readFile(path);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const error = new Error('stream did not contain valid UTF-8') as NodeJS.ErrnoException;
    error.code = 'EILSEQ';
    throw error;
  }
}

/** `DirectFileSystem::write_file`. */
export async function writeFile(path: string, contents: Buffer | string): Promise<void> {
  await rawPromises.writeFile(path, contents);
}

/** `DirectFileSystem::create_directory`. */
export async function createDirectory(path: string, options: CreateDirectoryOptions): Promise<void> {
  await rawPromises.mkdir(path, { recursive: options.recursive });
}

/** `DirectFileSystem::get_metadata`: stats the link itself, then follows it when it is one. */
export async function getMetadata(path: string): Promise<FileMetadata> {
  const symlinkMetadata = await rawPromises.lstat(path);
  const isSymlink = symlinkMetadata.isSymbolicLink();
  const metadata = isSymlink ? await rawPromises.stat(path) : symlinkMetadata;
  return {
    isDirectory: metadata.isDirectory(),
    isFile: metadata.isFile(),
    isSymlink,
    size: metadata.size,
    createdAtMs: systemTimeToUnixMs(metadata.birthtimeMs),
    modifiedAtMs: systemTimeToUnixMs(metadata.mtimeMs)
  };
}

/**
 * `DirectFileSystem::read_directory`, with one sandbox-facing hardening at the directory edge.
 *
 * The parent path has already been authorised by the caller, but its children have not. Following
 * a child symlink here merely to classify it lets a directory listing learn metadata about a target
 * outside the approved root before that child ever passes through resolvePath(). Keep links opaque
 * at enumeration time; explicit access to one is canonicalised and containment-checked separately.
 */
export async function readDirectory(path: string): Promise<ReadDirectoryEntry[]> {
  const dirents = await rawPromises.readdir(path, { withFileTypes: true });
  const entries: ReadDirectoryEntry[] = [];
  for (const dirent of dirents) {
    const isLink = dirent.isSymbolicLink();
    const isDirectory = !isLink && dirent.isDirectory();
    const isFile = !isLink && dirent.isFile();
    entries.push({ fileName: dirent.name, isDirectory, isFile, isSymlink: isLink });
  }
  return entries;
}

/** `DirectFileSystem::remove`. */
export async function remove(path: string, options: RemoveOptions): Promise<void> {
  let metadata: Stats;
  try {
    metadata = await rawPromises.lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT' && options.force) return;
    throw error;
  }
  if (metadata.isDirectory()) {
    if (options.recursive) await rawPromises.rm(path, { recursive: true });
    else await rawPromises.rmdir(path);
    return;
  }
  await rawPromises.unlink(path);
}

/** `reserve_walk_response_bytes`. */
function reserveWalkResponseBytes(
  outcome: WalkOutcome,
  state: { responseBytes: number },
  contentBytes: number
): boolean {
  const totalBytes = state.responseBytes + contentBytes + WALK_RESPONSE_ITEM_OVERHEAD_BYTES;
  if (totalBytes > MAX_WALK_RESPONSE_BYTES) {
    outcome.truncated = true;
    return false;
  }
  state.responseBytes = totalBytes;
  return true;
}

/** `push_walk_error`. */
function pushWalkError(
  outcome: WalkOutcome,
  state: { responseBytes: number },
  path: string,
  message: string
): boolean {
  const itemBytes = pathByteLength(path) + Buffer.byteLength(message, 'utf8');
  if (!reserveWalkResponseBytes(outcome, state, itemBytes)) return false;
  outcome.errors.push({ path, message });
  return true;
}

/**
 * `walk_via_directory_reads`: a breadth-first walk built only from `read_directory`,
 * `get_metadata` and `canonicalize`.
 *
 * Every limit is a stopping condition rather than an error. Hitting one sets `truncated` and
 * returns what was collected so far, so a caller always gets a usable partial answer.
 */
export async function walk(root: string, options: WalkOptions): Promise<WalkOutcome> {
  if (options.maxDirectories === 0 || options.maxEntries === 0) {
    throw invalidInput('filesystem walk limits must be greater than zero');
  }
  if (
    options.maxDepth > MAX_WALK_DEPTH ||
    options.maxDirectories > MAX_WALK_DIRECTORIES ||
    options.maxEntries > MAX_WALK_ENTRIES
  ) {
    throw invalidInput(
      `filesystem walk limits exceed maximums: depth=${MAX_WALK_DEPTH}, directories=${MAX_WALK_DIRECTORIES}, entries=${MAX_WALK_ENTRIES}`
    );
  }

  const rootMetadata = await getMetadata(root);
  if (!rootMetadata.isDirectory || (rootMetadata.isSymlink && !options.followDirectorySymlinks)) {
    return { entries: [], errors: [], truncated: false };
  }

  const rootIdentity = options.followDirectorySymlinks ? await canonicalize(root) : root;
  const outcome: WalkOutcome = { entries: [], errors: [], truncated: false };
  const queue: Array<[string, number]> = [[root, 0]];
  let queueHead = 0;
  const visitedDirectories = new Set<string>([rootIdentity]);
  const state = { responseBytes: 0 };
  let directoryCount = 1;
  let entryCount = 0;

  for (;;) {
    const next = queue[queueHead++];
    if (next === undefined) break;
    const [directory, depth] = next;

    let entries: ReadDirectoryEntry[];
    try {
      entries = await readDirectory(directory);
    } catch (error) {
      if (!pushWalkError(outcome, state, directory, errorMessage(error))) return outcome;
      continue;
    }
    entries.sort((left, right) => (left.fileName < right.fileName ? -1 : left.fileName > right.fileName ? 1 : 0));

    for (const entry of entries) {
      if (entryCount === options.maxEntries) {
        outcome.truncated = true;
        return outcome;
      }
      entryCount += 1;

      const path = nodePath.join(directory, entry.fileName);
      // A symlink not being followed is skipped without ever touching its target: readDirectory()
      // deliberately kept it opaque (see its docstring), and re-statting it here merely to
      // classify something we are about to discard would leak the same metadata that opacity was
      // for. When it is a directory symlink being followed, a stat is genuinely required to know
      // whether the target is a directory at all. Everything else — the overwhelming majority of
      // entries in an ordinary walk — is already classified by the Dirent readDirectory() read,
      // so no per-entry stat is needed at all.
      let isDirectory: boolean;
      let isFile: boolean;
      if (entry.isSymlink) {
        if (!options.followDirectorySymlinks) continue;
        let metadata: FileMetadata;
        try {
          metadata = await getMetadata(path);
        } catch (error) {
          if (!pushWalkError(outcome, state, path, errorMessage(error))) return outcome;
          continue;
        }
        if (!metadata.isDirectory) continue;
        isDirectory = true;
        isFile = false;
      } else {
        isDirectory = entry.isDirectory;
        isFile = entry.isFile;
      }

      let kind: WalkEntryKind;
      if (isDirectory) kind = 'directory';
      else if (isFile) kind = 'file';
      else continue;

      if (!reserveWalkResponseBytes(outcome, state, pathByteLength(path))) return outcome;
      outcome.entries.push({ path, kind });

      if (kind === 'directory') {
        if (options.pruneHiddenDirectories === true && entry.fileName.startsWith('.')) continue;
        if (options.pruneDirectory?.(entry, path) === true) continue;
        // The directory itself is a valid result at the depth boundary, but its children were
        // deliberately not inspected. Returning truncated=false here made recursive `read` globs
        // silently claim "no matches" for files deeper than MAX_WALK_DEPTH. We cannot know that
        // the skipped subtree is empty without traversing it, so reaching the boundary is a
        // conservative truncation signal.
        if (depth >= options.maxDepth) {
          outcome.truncated = true;
          continue;
        }
        let directoryIdentity: string;
        if (options.followDirectorySymlinks) {
          try {
            directoryIdentity = await canonicalize(path);
          } catch (error) {
            if (!pushWalkError(outcome, state, path, errorMessage(error))) return outcome;
            continue;
          }
        } else {
          directoryIdentity = path;
        }
        if (visitedDirectories.has(directoryIdentity)) continue;
        visitedDirectories.add(directoryIdentity);
        if (directoryCount === options.maxDirectories) {
          outcome.truncated = true;
        } else {
          directoryCount += 1;
          queue.push([path, depth + 1]);
        }
      }
    }
  }

  return outcome;
}
