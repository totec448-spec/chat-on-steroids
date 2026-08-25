/**
 * Filesystem operations with hard output bounds.
 *
 * Every read is capped in bytes and reports whether it was truncated, so a large
 * file can never be dumped into the conversation by accident. Binary files are
 * detected and refused with a clear message instead of returning mojibake.
 */

import { createHash, randomUUID } from 'node:crypto';
import { rawCreateReadStream as createReadStream, rawPromises as fs } from './rawfs.js';
import path from 'node:path';
import { lineDelta, type LineDelta } from './diffstat.js';
import { TextMatchError, applyTextEdit } from './text-match.js';

/** Default and maximum text payload returned by one model-visible `read` section. */
export const DEFAULT_READ_BYTES = 256 * 1024;
export const MAX_READ_BYTES = 512 * 1024;
/** Above this a metadata-only line count is skipped rather than scanning the whole file. */
const MAX_LINE_COUNT_BYTES = MAX_READ_BYTES * 8;
export const MAX_WRITE_BYTES = 16 * 1024 * 1024;
/** Local images returned to the model are capped before base64 expansion. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Keeps a base64 binary-write request comfortably below the MCP server's 8 MiB body cap. */
export const MAX_BINARY_WRITE_BYTES = 5 * 1024 * 1024;
export const MAX_BINARY_BASE64_CHARS = 7_000_000;
const BINARY_SNIFF_BYTES = 8192;
const MAX_HASH_BYTES = 256 * 1024 * 1024;

export class FsOpError extends Error {}

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';
export interface TextFormat {
  encoding: TextEncoding;
  bom: boolean;
}

async function textFormat(realPath: string): Promise<TextFormat> {
  const handle = await fs.open(realPath, 'r');
  try {
    const head = Buffer.alloc(3);
    const { bytesRead } = await handle.read(head, 0, 3, 0);
    if (bytesRead >= 2 && head[0] === 0xff && head[1] === 0xfe) {
      return { encoding: 'utf-16le', bom: true };
    }
    if (bytesRead >= 2 && head[0] === 0xfe && head[1] === 0xff) {
      return { encoding: 'utf-16be', bom: true };
    }
    return {
      encoding: 'utf-8',
      bom: bytesRead >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf
    };
  } finally {
    await handle.close();
  }
}

function decodeText(data: Buffer, format: TextFormat): string {
  return stripBom(new TextDecoder(format.encoding).decode(data));
}

function encodeText(text: string, format: TextFormat, includeBom: boolean): Buffer {
  if (format.encoding === 'utf-8') {
    const body = Buffer.from(text, 'utf8');
    return includeBom && format.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
  }
  const body = Buffer.from(text, 'utf16le');
  if (format.encoding === 'utf-16be') body.swap16();
  if (!includeBom || !format.bom) return body;
  return Buffer.concat([
    format.encoding === 'utf-16le' ? Buffer.from([0xff, 0xfe]) : Buffer.from([0xfe, 0xff]),
    body
  ]);
}

/** Applies the binary sniff heuristic to bytes a caller already has in hand. */
export function sniffBinaryBytes(slice: Buffer): boolean {
  if (slice.length === 0) return false;
  // UTF-16 text contains NUL bytes by design, so detect its BOM before applying
  // the usual binary heuristic. UTF-8 BOM is harmless as well.
  if (
    (slice.length >= 2 && slice[0] === 0xff && slice[1] === 0xfe) ||
    (slice.length >= 2 && slice[0] === 0xfe && slice[1] === 0xff) ||
    (slice.length >= 3 && slice[0] === 0xef && slice[1] === 0xbb && slice[2] === 0xbf)
  ) {
    return false;
  }
  // A NUL byte in the first 8 KiB is the standard heuristic and is what git uses.
  if (slice.includes(0)) return true;
  // A high proportion of bytes that are neither printable nor common whitespace
  // catches things like compressed data that happen to avoid NUL.
  let suspicious = 0;
  for (const byte of slice) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 32 || byte === 127) suspicious++;
  }
  return suspicious / slice.length > 0.3;
}

/** Reads the first bytes of a file to decide whether it is binary. */
export async function sniffBinary(realPath: string): Promise<boolean> {
  const handle = await fs.open(realPath, 'r');
  try {
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buf, 0, BINARY_SNIFF_BYTES, 0);
    return sniffBinaryBytes(buf.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Above this the pre-read that makes a whole-file rewrite countable is skipped. */
const MAX_DIFF_READ_BYTES = 8 * 1024 * 1024;

/**
 * Rewrites a text file and reports how many lines that changed.
 *
 * The original is read back first purely to make the count real. That costs one read
 * of a file we are about to overwrite anyway, and it is skipped for very large files,
 * where the delta falls back to the honest approximation of "all lines replaced".
 */
export async function replaceTextFile(
  realPath: string,
  content: string
): Promise<{ bytes: number; delta: LineDelta }> {
  const format = await textFormat(realPath);
  let original: string | null = null;
  try {
    const stat = await fs.stat(realPath);
    if (stat.size <= MAX_DIFF_READ_BYTES) original = decodeText(await fs.readFile(realPath), format);
  } catch {
    // Unreadable or missing: the file is still written, only the count is coarser.
  }
  const encoded = encodeText(content, format, true);
  await fs.writeFile(realPath, encoded);
  return {
    bytes: encoded.length,
    delta:
      original === null
        ? { added: countTextLines(content), removed: 0, approximate: true }
        : lineDelta(original, content)
  };
}

function countTextLines(text: string): number {
  if (text === '') return 0;
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.split('\n').length;
}

export async function appendTextFile(realPath: string, content: string): Promise<{ bytes: number; added: number }> {
  let format: TextFormat = { encoding: 'utf-8', bom: false };
  try {
    const stat = await fs.stat(realPath);
    if (!stat.isFile()) throw new FsOpError('Not a file');
    format = await textFormat(realPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const encoded = encodeText(content, format, false);
  await fs.appendFile(realPath, encoded);
  return { bytes: encoded.length, added: countTextLines(content) };
}

export type SupportedImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export function imageMime(data: Buffer): SupportedImageMime | null {
  if (
    data.length >= 8 &&
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
    data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
  ) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6) {
    const signature = data.subarray(0, 6).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp';
  return null;
}

let pngCrcTable: Uint32Array | null = null;

function pngCrc32(data: Buffer, start: number, end: number): number {
  if (!pngCrcTable) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    pngCrcTable = table;
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = pngCrcTable[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function invalidImage(kind: string, detail: string): never {
  throw new FsOpError(`Invalid or corrupt ${kind} image: ${detail}`);
}

function validatePng(data: Buffer): void {
  if (data.length < 33) invalidImage('PNG', 'file is too short');
  let offset = 8;
  let first = true;
  let sawIend = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const crcOffset = dataStart + length;
    if (crcOffset + 4 > data.length) invalidImage('PNG', 'a chunk extends past the end of the file');
    const type = data.subarray(typeStart, dataStart).toString('ascii');
    if (first) {
      if (type !== 'IHDR' || length !== 13) invalidImage('PNG', 'IHDR is missing or malformed');
      const width = data.readUInt32BE(dataStart);
      const height = data.readUInt32BE(dataStart + 4);
      if (width === 0 || height === 0) invalidImage('PNG', 'image dimensions are zero');
      first = false;
    }
    const expectedCrc = data.readUInt32BE(crcOffset);
    const actualCrc = pngCrc32(data, typeStart, crcOffset);
    if (expectedCrc !== actualCrc) invalidImage('PNG', `CRC check failed for ${type || 'unknown'} chunk`);
    offset = crcOffset + 4;
    if (type === 'IEND') {
      if (length !== 0) invalidImage('PNG', 'IEND chunk is malformed');
      sawIend = true;
      break;
    }
  }
  if (!sawIend) invalidImage('PNG', 'IEND chunk is missing');
}

function validateJpeg(data: Buffer): void {
  if (data.length < 8 || data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) {
    invalidImage('JPEG', 'end marker is missing');
  }
  let offset = 2;
  let sawFrame = false;
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset < data.length - 2) {
    while (offset < data.length && data[offset] === 0xff) offset++;
    if (offset >= data.length) break;
    const marker = data[offset++]!;
    if (marker === 0xd9) break;
    if (marker === 0xda) break; // scan data continues until the already-validated EOI marker
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) invalidImage('JPEG', 'segment length is truncated');
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) invalidImage('JPEG', 'segment extends past the end of the file');
    if (frameMarkers.has(marker)) {
      if (length < 7) invalidImage('JPEG', 'frame header is malformed');
      const height = data.readUInt16BE(offset + 3);
      const width = data.readUInt16BE(offset + 5);
      if (width === 0 || height === 0) invalidImage('JPEG', 'image dimensions are zero');
      sawFrame = true;
    }
    offset += length;
  }
  if (!sawFrame) invalidImage('JPEG', 'frame header is missing');
}

function validateGif(data: Buffer): void {
  if (data.length < 14) invalidImage('GIF', 'file is too short');
  if (data.readUInt16LE(6) === 0 || data.readUInt16LE(8) === 0) invalidImage('GIF', 'image dimensions are zero');
  if (data[data.length - 1] !== 0x3b) invalidImage('GIF', 'trailer is missing');
}

function validateWebp(data: Buffer): void {
  if (data.length < 20) invalidImage('WebP', 'file is too short');
  if (data.readUInt32LE(4) + 8 !== data.length) invalidImage('WebP', 'RIFF size does not match the file');
  let offset = 12;
  let sawImageChunk = false;
  while (offset + 8 <= data.length) {
    const type = data.subarray(offset, offset + 4).toString('ascii');
    const length = data.readUInt32LE(offset + 4);
    const next = offset + 8 + length + (length & 1);
    if (next > data.length) invalidImage('WebP', 'a chunk extends past the end of the file');
    if (type === 'VP8 ' || type === 'VP8L' || type === 'VP8X') sawImageChunk = true;
    offset = next;
  }
  if (!sawImageChunk) invalidImage('WebP', 'image payload chunk is missing');
}

export function validateImageStructure(data: Buffer, mimeType: SupportedImageMime): void {
  if (mimeType === 'image/png') validatePng(data);
  else if (mimeType === 'image/jpeg') validateJpeg(data);
  else if (mimeType === 'image/gif') validateGif(data);
  else validateWebp(data);
}

export async function readImageFile(
  realPath: string
): Promise<{ data: string; mimeType: SupportedImageMime; bytes: number }> {
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) throw new FsOpError('Not a file');
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new FsOpError(
      `Image is too large to return (${formatBytes(stat.size)}; limit ${formatBytes(MAX_IMAGE_BYTES)})`
    );
  }
  const data = await fs.readFile(realPath);
  const mimeType = imageMime(data);
  if (!mimeType) {
    throw new FsOpError('Unsupported image format. Use PNG, JPEG, GIF or WebP.');
  }
  validateImageStructure(data, mimeType);
  return { data: data.toString('base64'), mimeType, bytes: data.length };
}

export function decodeBase64Data(input: string): Buffer {
  const clean = input.replace(/\s+/g, '');
  if (clean.length === 0) throw new FsOpError('Binary data is empty');
  if (clean.length > MAX_BINARY_BASE64_CHARS) {
    throw new FsOpError(`Base64 payload is too large (limit ${MAX_BINARY_BASE64_CHARS} characters)`);
  }
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean) || /=/.test(clean.slice(0, -2))) {
    throw new FsOpError('Binary data is not valid base64');
  }
  const standard = clean.replace(/-/g, '+').replace(/_/g, '/');
  if (standard.length % 4 === 1) throw new FsOpError('Binary data is not valid base64');
  const data = Buffer.from(standard, 'base64');
  const canonical = data.toString('base64').replace(/=+$/, '');
  if (canonical !== standard.replace(/=+$/, '')) throw new FsOpError('Binary data is not valid base64');
  if (data.length > MAX_BINARY_WRITE_BYTES) {
    throw new FsOpError(
      `Binary data is too large (${formatBytes(data.length)}; limit ${formatBytes(MAX_BINARY_WRITE_BYTES)})`
    );
  }
  return data;
}

export interface FileInfo {
  virtualPath: string;
  type: 'file' | 'directory' | 'other';
  bytes: number;
  modified: string;
  created: string;
  readOnly: boolean;
  binary: boolean | null;
  lines: number | null;
  sha256: string | null;
}

export async function statInfo(
  realPath: string,
  virtualPath: string,
  opts: { hash?: boolean } = {}
): Promise<FileInfo> {
  const stat = await fs.lstat(realPath);
  const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
  const info: FileInfo = {
    virtualPath,
    type,
    bytes: stat.size,
    modified: stat.mtime.toISOString(),
    created: stat.birthtime.toISOString(),
    // 0o200 is the owner-write bit; Node maps the Windows read-only attribute onto it.
    readOnly: (stat.mode & 0o200) === 0,
    binary: null,
    lines: null,
    sha256: null
  };
  if (type !== 'file') return info;

  info.binary = await sniffBinary(realPath);
  if (!info.binary && stat.size <= MAX_LINE_COUNT_BYTES) {
    info.lines = await countLines(realPath);
  }
  if (opts.hash) {
    if (stat.size > MAX_HASH_BYTES) {
      throw new FsOpError(`File is too large to hash (${formatBytes(stat.size)})`);
    }
    info.sha256 = await hashFile(realPath);
  }
  return info;
}

async function countLines(realPath: string): Promise<number> {
  let count = 0;
  let sawAny = false;
  let endsWithNewline = true;
  const stream = createReadStream(realPath);
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    if (buf.length === 0) continue;
    sawAny = true;
    for (const byte of buf) if (byte === 10) count++;
    endsWithNewline = buf[buf.length - 1] === 10;
  }
  if (!sawAny) return 0;
  return endsWithNewline ? count : count + 1;
}

async function hashFile(realPath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(realPath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function isExcludedFolderName(name: string, patterns: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return patterns.some((raw) => {
    const pattern = raw.toLowerCase();
    return pattern.endsWith('*') ? lower.startsWith(pattern.slice(0, -1)) : lower === pattern;
  });
}

export interface DirEntry {
  name: string;
  virtualPath: string;
  type: 'file' | 'directory' | 'other';
  bytes: number | null;
}

/** Lists a directory, optionally recursing, always bounded by maxEntries. */
export async function listDirectory(
  realDir: string,
  virtualDir: string,
  opts: { recursive?: boolean; maxEntries: number; exclude: readonly string[] }
): Promise<{ entries: DirEntry[]; truncated: boolean }> {
  const entries: DirEntry[] = [];
  let truncated = false;

  const walk = async (dir: string, virt: string, depth: number): Promise<void> => {
    if (truncated) return;
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (depth === 0) throw err;
      return; // Unreadable subdirectory: skip rather than fail the whole listing.
    }
    dirents.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
    });
    for (const dirent of dirents) {
      if (entries.length >= opts.maxEntries) {
        truncated = true;
        return;
      }
      const isDir = dirent.isDirectory();
      if (isDir && opts.recursive && isExcludedFolderName(dirent.name, opts.exclude)) continue;
      const childVirtual = `${virt}/${dirent.name}`;
      let bytes: number | null = null;
      if (dirent.isFile()) {
        try {
          bytes = (await fs.stat(path.join(dir, dirent.name))).size;
        } catch {
          bytes = null;
        }
      }
      entries.push({
        name: dirent.name,
        virtualPath: childVirtual,
        type: isDir ? 'directory' : dirent.isFile() ? 'file' : 'other',
        bytes
      });
      if (isDir && opts.recursive) {
        await walk(path.join(dir, dirent.name), childVirtual, depth + 1);
      }
    }
  };

  await walk(realDir, virtualDir, 0);
  return { entries, truncated };
}

export interface EditOp {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export const MAX_BATCH_EDIT_FILES = 20;
export const MAX_BATCH_EDIT_OPS = 128;
export const MAX_BATCH_EDIT_BYTES = 32 * 1024 * 1024;

interface PreparedTextEdit {
  realPath: string;
  virtualPath: string;
  originalBytes: Buffer;
  nextBytes: Buffer;
  replacements: number;
  delta: LineDelta;
}

export interface BatchTextEditInput {
  realPath: string;
  virtualPath: string;
  edits: readonly EditOp[];
}

export interface BatchTextEditResult {
  virtualPath: string;
  replacements: number;
  bytes: number;
  delta: LineDelta;
}

async function prepareTextEdit(
  realPath: string,
  virtualPath: string,
  edits: readonly EditOp[]
): Promise<PreparedTextEdit> {
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) throw new FsOpError(`${virtualPath}: not a file`);
  if (stat.size > MAX_WRITE_BYTES) {
    throw new FsOpError(`${virtualPath}: file is too large to edit (${formatBytes(stat.size)})`);
  }
  if (await sniffBinary(realPath)) throw new FsOpError(`${virtualPath}: cannot edit a binary file`);

  const format = await textFormat(realPath);
  const originalBytes = await fs.readFile(realPath);
  const original = decodeText(originalBytes, format);
  let content = original;
  let replacements = 0;

  for (const [index, edit] of edits.entries()) {
    if (typeof edit.oldText !== 'string' || edit.oldText.length === 0) {
      throw new FsOpError(`${virtualPath}, edit ${index + 1}: oldText must be a non-empty string`);
    }
    if (typeof edit.newText !== 'string') {
      throw new FsOpError(`${virtualPath}, edit ${index + 1}: newText must be a string`);
    }
    // One matching engine for every mutation tool. read_file returns logical LF-separated
    // lines on every platform, so a snippet copied out of it has to remain a valid edit
    // input for a CRLF or mixed-ending file; applyTextEdit is where that is guaranteed.
    try {
      const applied = applyTextEdit(content, edit);
      content = applied.text;
      replacements += applied.replacements;
    } catch (error) {
      if (error instanceof TextMatchError) {
        throw new FsOpError(`${virtualPath}, edit ${index + 1}: ${error.message}`);
      }
      throw error;
    }
  }

  if (content === original) throw new FsOpError(`${virtualPath}: edits produced no change`);
  const nextBytes = encodeText(content, format, true);
  return { realPath, virtualPath, originalBytes, nextBytes, replacements, delta: lineDelta(original, content) };
}

/**
 * Applies exact-text replacements. Line numbers are deliberately not used as an edit
 * primitive: they drift the moment an earlier edit lands, and models get them wrong.
 * A non-unique oldText is an error rather than a guess.
 */
export async function editTextFile(
  realPath: string,
  edits: readonly EditOp[]
): Promise<{ replacements: number; bytes: number; delta: LineDelta }> {
  const prepared = await prepareTextEdit(realPath, 'file', edits);
  await fs.writeFile(realPath, prepared.nextBytes);
  return { replacements: prepared.replacements, bytes: prepared.nextBytes.length, delta: prepared.delta };
}

/**
 * Preflights every file before touching any of them, stages complete replacements in
 * sibling temp files, then commits by rename. A commit-time failure triggers a
 * best-effort reverse rollback using the exact original bytes. This cannot provide a
 * filesystem-wide ACID transaction across unrelated NTFS files, but ordinary stale
 * snippets, path failures and validation errors are guaranteed to make zero changes.
 */
export async function editTextFiles(
  files: readonly BatchTextEditInput[]
): Promise<BatchTextEditResult[]> {
  if (files.length === 0) throw new FsOpError('At least one file is required');
  if (files.length > MAX_BATCH_EDIT_FILES) {
    throw new FsOpError(`Too many files in one batch (limit ${MAX_BATCH_EDIT_FILES})`);
  }
  const totalOps = files.reduce((sum, file) => sum + file.edits.length, 0);
  if (totalOps > MAX_BATCH_EDIT_OPS) {
    throw new FsOpError(`Too many edits in one batch (limit ${MAX_BATCH_EDIT_OPS})`);
  }

  const seen = new Set<string>();
  for (const file of files) {
    const key = process.platform === 'win32' ? file.realPath.toLowerCase() : file.realPath;
    if (seen.has(key)) throw new FsOpError(`${file.virtualPath}: the same file appears more than once in the batch`);
    seen.add(key);
  }

  const prepared: PreparedTextEdit[] = [];
  let totalBytes = 0;
  for (const file of files) {
    if (file.edits.length === 0) throw new FsOpError(`${file.virtualPath}: at least one edit is required`);
    const item = await prepareTextEdit(file.realPath, file.virtualPath, file.edits);
    totalBytes += Math.max(item.originalBytes.length, item.nextBytes.length);
    if (totalBytes > MAX_BATCH_EDIT_BYTES) {
      throw new FsOpError(`Batch is too large to edit safely (limit ${formatBytes(MAX_BATCH_EDIT_BYTES)})`);
    }
    prepared.push(item);
  }

  const staged = new Map<string, string>();
  const committed: PreparedTextEdit[] = [];
  const makeTemp = (target: string, kind: 'stage' | 'rollback'): string =>
    path.join(path.dirname(target), `.clf-${kind}-${process.pid}-${randomUUID()}.tmp`);
  const writeTemp = async (temp: string, data: Buffer): Promise<void> => {
    try {
      const handle = await fs.open(temp, 'wx');
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (err) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw err;
    }
  };

  try {
    // Stage every complete new file first. Same-directory temps keep the final rename
    // on one volume and avoid exposing partially written target files.
    for (const item of prepared) {
      const temp = makeTemp(item.realPath, 'stage');
      await writeTemp(temp, item.nextBytes);
      staged.set(item.realPath, temp);
    }

    for (const item of prepared) {
      // Refuse to clobber a file another process changed after our preflight.
      const current = await fs.readFile(item.realPath);
      if (!current.equals(item.originalBytes)) {
        throw new FsOpError(`${item.virtualPath}: file changed after preflight; batch was aborted`);
      }
      const temp = staged.get(item.realPath);
      if (!temp) throw new FsOpError(`${item.virtualPath}: internal staging file is missing`);
      await fs.rename(temp, item.realPath);
      staged.delete(item.realPath);
      committed.push(item);
    }
  } catch (err) {
    const rollbackProblems: string[] = [];
    for (const item of [...committed].reverse()) {
      try {
        const current = await fs.readFile(item.realPath);
        if (!current.equals(item.nextBytes)) {
          rollbackProblems.push(`${item.virtualPath} changed again before rollback`);
          continue;
        }
        const rollbackTemp = makeTemp(item.realPath, 'rollback');
        await writeTemp(rollbackTemp, item.originalBytes);
        try {
          await fs.rename(rollbackTemp, item.realPath);
        } finally {
          await fs.rm(rollbackTemp, { force: true }).catch(() => undefined);
        }
      } catch (rollbackErr) {
        rollbackProblems.push(`${item.virtualPath}: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
      }
    }
    for (const temp of staged.values()) await fs.rm(temp, { force: true }).catch(() => undefined);

    const reason = err instanceof Error ? err.message : String(err);
    if (rollbackProblems.length > 0) {
      throw new FsOpError(
        `${reason}. Rollback could not safely restore every committed file: ${rollbackProblems.join('; ')}`
      );
    }
    throw err;
  }

  return prepared.map((item) => ({
    virtualPath: item.virtualPath,
    replacements: item.replacements,
    bytes: item.nextBytes.length,
    delta: item.delta
  }));
}

export function assertWritableSize(content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_WRITE_BYTES) {
    throw new FsOpError(`Content is too large to write (${formatBytes(bytes)})`);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
