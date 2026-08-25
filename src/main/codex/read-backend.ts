/**
 * `read`'s filesystem backend, rebuilt on Codex's primitives.
 *
 * Codex exposes no model-visible `read`, so this tool stays a Chat On Steroids convenience:
 * the schema, the section headers and the line numbering are unchanged. What changed is
 * everything underneath. Where the old implementation opened files itself, this module reaches the
 * disk only through `filesystem.ts` -- `getMetadata`, `readDirectory`, `readFileStream`, `walk` --
 * so `read` now inherits Codex's open gating (a path that is not a regular file is refused at the
 * handle, not after the read), its 1 MiB chunking and its bounded breadth-first walk.
 *
 * The model-visible answer has its own byte budget. That is intentionally separate from Codex's
 * 512 MiB `readFile` ceiling: this backend streams, so a small range or bounded chunk from a file
 * larger than 512 MiB is safe and does not need to materialize the whole file.
 *
 * Two consequences worth naming:
 *
 * - Codex's `FileMetadata` carries no permission bits, so `read` no longer reports
 *   `readonly: true`. Nothing else in the header changes.
 * - `getMetadata` follows symlinks (Codex stats the link, then the target), so a symlink to a file
 *   now reads as that file instead of coming back as "not a regular file".
 *
 * Decoding stays here rather than moving to Codex's `read_file_text`, which is a strict UTF-8
 * decode and would turn every UTF-16 file this connector reads today into an error.
 */

import nodePath from 'node:path';

import {
  MAX_WALK_DEPTH,
  MAX_WALK_DIRECTORIES,
  MAX_WALK_ENTRIES,
  getMetadata,
  readDirectory,
  readFileStream,
  walk
} from './filesystem.js';
import {
  DEFAULT_READ_BYTES,
  FsOpError,
  MAX_READ_BYTES,
  clamp,
  formatBytes,
  isExcludedFolderName,
  sniffBinaryBytes,
  type DirEntry,
  type FileInfo
} from '../fsops.js';

/** Bytes inspected when deciding whether a file is binary. */
const BINARY_SNIFF_BYTES = 8192;

/**
 * Above this a file is reported without a line count rather than read end to end for one.
 *
 * This budget buys a *fact* rather than more output: knowing a file's length costs a full scan,
 * and on a range or output-capped read that scan is work nobody asked for. Under the limit the
 * header can say `of 1308`; over it the header simply stops claiming a total.
 */
const MAX_LINE_COUNT_BYTES = MAX_READ_BYTES * 8;
/** A single decoded line is not allowed to become an unbounded V8 string. */
const MAX_DECODED_LINE_CHARS = 2 * 1024 * 1024;

interface TextFormat {
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be';
  bom: boolean;
}

/** The `ReadResult` shape `read` has always rendered. */
export interface ReadTextResult {
  text: string;
  /** True when the configured output byte budget stopped the read. */
  truncated: boolean;
  /** True when at least one line exists after the last line returned. */
  hasMore: boolean;
  firstLine: number;
  lastLine: number;
  totalLines: number | null;
  bytesReturned: number;
  fileBytes: number;
}

function detectTextFormat(head: Buffer): TextFormat {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return { encoding: 'utf-16le', bom: true };
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return { encoding: 'utf-16be', bom: true };
  return {
    encoding: 'utf-8',
    bom: head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf
  };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * One streamed pass that answers both questions the header needs: is this binary, and how many
 * lines does it have. The old implementation opened the file three times to learn that; Codex's
 * chunked read hands over the same bytes once.
 */
async function scanFile(realPath: string, wantLines: boolean): Promise<{ binary: boolean; lines: number | null }> {
  let sniffed = false;
  let lines = 0;
  let sawAny = false;
  let endsWithNewline = true;

  for await (const chunk of readFileStream(realPath)) {
    if (chunk.length === 0) continue;
    if (!sniffed) {
      sniffed = true;
      if (sniffBinaryBytes(chunk.subarray(0, Math.min(BINARY_SNIFF_BYTES, chunk.length)))) {
        return { binary: true, lines: null };
      }
      if (!wantLines) return { binary: false, lines: null };
    }
    sawAny = true;
    for (const byte of chunk) if (byte === 10) lines++;
    endsWithNewline = chunk[chunk.length - 1] === 10;
  }

  if (!wantLines) return { binary: false, lines: null };
  if (!sawAny) return { binary: false, lines: 0 };
  return { binary: false, lines: endsWithNewline ? lines : lines + 1 };
}

/**
 * `statInfo`, over `fs/getMetadata`.
 *
 * `readOnly` is always false: Codex's metadata does not carry permission bits, and adding a second
 * stat purely to recover one advisory line would put a non-Codex filesystem call back in the path
 * this port exists to remove.
 */
export async function statInfo(
  realPath: string,
  virtualPath: string,
  options: { scanContent?: boolean } = {}
): Promise<FileInfo> {
  const metadata = await getMetadata(realPath);
  const type = metadata.isDirectory ? 'directory' : metadata.isFile ? 'file' : 'other';
  const info: FileInfo = {
    virtualPath,
    type,
    bytes: metadata.size,
    modified: new Date(metadata.modifiedAtMs).toISOString(),
    created: new Date(metadata.createdAtMs).toISOString(),
    readOnly: false,
    binary: null,
    lines: null,
    sha256: null
  };
  if (type !== 'file') return info;
  if (options.scanContent === false) return info;

  const scan = await scanFile(realPath, metadata.size <= MAX_LINE_COUNT_BYTES);
  info.binary = scan.binary;
  info.lines = scan.lines;
  return info;
}

/** `listDirectory` for one level, over `fs/readDirectory` plus one `fs/getMetadata` per file. */
export async function listDirectoryLevel(
  realDir: string,
  virtualDir: string,
  maxEntries: number,
  includeFileSizes = true
): Promise<{ entries: DirEntry[]; truncated: boolean }> {
  const raw = await readDirectory(realDir);
  // Directories first, then names, which is the order `read` has always printed.
  raw.sort((left, right) => {
    const leftDir = left.isDirectory ? 0 : 1;
    const rightDir = right.isDirectory ? 0 : 1;
    return leftDir !== rightDir ? leftDir - rightDir : left.fileName.localeCompare(right.fileName);
  });

  const selected = raw.slice(0, Math.max(0, maxEntries));
  const truncated = raw.length > selected.length;
  const entries: DirEntry[] = [];
  for (const entry of selected) {
    let bytes: number | null = null;
    if (includeFileSizes && entry.isFile) {
      try {
        bytes = (await getMetadata(nodePath.join(realDir, entry.fileName))).size;
      } catch {
        bytes = null;
      }
    }
    entries.push({
      name: entry.fileName,
      virtualPath: `${virtualDir}/${entry.fileName}`,
      type: entry.isDirectory ? 'directory' : entry.isFile ? 'file' : 'other',
      bytes
    });
  }
  return { entries, truncated };
}

/** Distinguishes read's normal binary-file result from other filesystem failures. */
export class BinaryReadError extends FsOpError {}

/**
 * Every file below `realDir`, for glob expansion, over `fs/walk`.
 *
 * Codex's walk is breadth-first where the old listing was depth-first, so a `**` pattern now
 * matches shallow files before deep ones. That is the order the entry budget is spent in, and for
 * a truncated expansion it is the better of the two.
 */
export async function walkFiles(
  realDir: string,
  virtualDir: string,
  options: { maxEntries: number; exclude: readonly string[] }
): Promise<{ files: string[]; truncated: boolean }> {
  const outcome = await walk(realDir, {
    maxDepth: MAX_WALK_DEPTH,
    maxDirectories: MAX_WALK_DIRECTORIES,
    maxEntries: clamp(options.maxEntries, 1, MAX_WALK_ENTRIES),
    followDirectorySymlinks: false,
    pruneDirectory: (entry) => isExcludedFolderName(entry.fileName, options.exclude)
  });

  const prefix = realDir.endsWith(nodePath.sep) ? realDir : realDir + nodePath.sep;
  const files: string[] = [];
  for (const entry of outcome.entries) {
    if (entry.kind !== 'file') continue;
    if (!entry.path.startsWith(prefix)) continue;
    const relative = entry.path.slice(prefix.length).split(nodePath.sep).join('/');
    files.push(`${virtualDir}/${relative}`);
  }
  return { files, truncated: outcome.truncated };
}

/**
 * `readTextFile`, over `fs/readFileStream`.
 *
 * Still streamed, so reading lines 10-20 of a 2 GB file does not load the file; the chunk size is
 * now Codex's 1 MiB rather than the 64 KiB this used to ask for.
 *
 * The byte budget bounds what is returned, not what can be opened. This distinction is what makes
 * a range from a very large log useful: `readFileStream` can stop as soon as the requested/budgeted
 * lines are satisfied without ever allocating the file as one Buffer.
 */
export async function readTextFile(
  realPath: string,
  opts: { startLine?: number; endLine?: number; maxBytes?: number } = {}
): Promise<ReadTextResult> {
  const metadata = await getMetadata(realPath);
  if (!metadata.isFile) throw new FsOpError('Not a file');

  const maxBytes = clamp(opts.maxBytes ?? DEFAULT_READ_BYTES, 1, MAX_READ_BYTES);
  const startLine = opts.startLine === undefined ? 1 : Math.max(1, Math.floor(opts.startLine));
  const endLine = opts.endLine === undefined ? Infinity : Math.floor(opts.endLine);
  if (endLine < startLine) throw new FsOpError('endLine must be greater than or equal to startLine');

  // Past `endLine` the scan keeps going to learn the file's length, but only while that is
  // cheap enough to be worth a header line — see MAX_LINE_COUNT_BYTES. Over that, stop at the
  // range and leave the total unknown rather than drag a huge file through memory for a number.
  let countToEnd = metadata.size <= MAX_LINE_COUNT_BYTES;

  const out: string[] = [];
  let bytesReturned = 0;
  let lineNo = 0;
  let firstLine = 0;
  let lastLine = 0;
  let carry = '';
  let truncated = false;
  let budgetExhausted = false;
  let sawAllLines = true;
  let decoder: TextDecoder | null = null;
  let bytesScanned = 0;
  /** Set once a line beyond the requested range exists. Output-budget truncation is tracked separately. */
  let passedRange = false;

  // Returns whether the stream should keep going, which is no longer the same question as
  // whether the line was kept: past `endLine` the scan runs on to finish counting the file
  // while buffering nothing, so the header can state a total the caller can act on.
  const pushLine = (line: string): boolean => {
    lineNo++;
    if (lineNo < startLine) return true;
    if (lineNo > endLine) {
      passedRange = true;
      return countToEnd;
    }
    if (budgetExhausted) return countToEnd;
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (bytesReturned + size > maxBytes) {
      // Returning zero lines and telling the caller to resume at the same line is an infinite
      // retry loop. Make the remedy explicit when one logical line cannot fit the chosen budget.
      if (firstLine === 0) {
        throw new FsOpError(
          `Line ${lineNo} is larger than max_bytes=${maxBytes}. Increase max_bytes (up to ${MAX_READ_BYTES}) or use exec_command to transform it.`
        );
      }
      truncated = true;
      budgetExhausted = true;
      return countToEnd;
    }
    if (firstLine === 0) firstLine = lineNo;
    lastLine = lineNo;
    out.push(line);
    bytesReturned += size;
    return true;
  };

  for await (const chunk of readFileStream(realPath)) {
    bytesScanned += chunk.length;
    // The pre-open metadata is only a hint. A live log can grow after that stat, and without
    // this streamed high-water a 20-line range could keep reading gigabytes solely to compute
    // an advisory total. Once the actual read crosses the cheap-count budget, finish only the
    // range/output the caller asked for and stop claiming an EOF-derived line total.
    if (bytesScanned > MAX_LINE_COUNT_BYTES) countToEnd = false;
    if (decoder === null) {
      if (sniffBinaryBytes(chunk.subarray(0, Math.min(BINARY_SNIFF_BYTES, chunk.length)))) {
        throw new BinaryReadError(
          `This is a binary file (${formatBytes(metadata.size)}); text decoding is unavailable. Use exec_command if you need to inspect or convert it.`
        );
      }
      decoder = new TextDecoder(detectTextFormat(chunk).encoding);
    }
    carry += decoder.decode(chunk, { stream: true });
    let index = carry.indexOf('\n');
    while (index !== -1) {
      const line = carry.slice(0, index).replace(/\r$/, '');
      carry = carry.slice(index + 1);
      if (!pushLine(line)) {
        sawAllLines = false;
        carry = '';
        break;
      }
      index = carry.indexOf('\n');
    }
    if (carry.length > MAX_DECODED_LINE_CHARS) {
      throw new FsOpError(
        `A line exceeds the safe decoded-line limit (${formatBytes(MAX_DECODED_LINE_CHARS)}). Narrow or transform the file before reading it.`
      );
    }
    if (!sawAllLines) break;
  }

  if (sawAllLines && decoder !== null) {
    carry += decoder.decode();
    if (carry.length > 0) {
      if (!pushLine(carry.replace(/\r$/, ''))) sawAllLines = false;
    }
  }

  if (firstLine === 0) {
    // Nothing matched: either an empty file or a range past the end.
    firstLine = startLine;
    lastLine = startLine - 1;
  }

  return {
    text: stripBom(out.join('\n')),
    truncated,
    // A line was withheld either because the caller's range ended or because the byte budget did.
    hasMore: passedRange || truncated,
    firstLine,
    lastLine,
    // `sawAllLines` now means only "the stream reached the end of the file", which it does for
    // every whole-file read and for every ranged read under MAX_LINE_COUNT_BYTES. So a total
    // is missing in one case: a range inside a file too big to be worth counting.
    totalLines: sawAllLines ? lineNo : null,
    bytesReturned,
    fileBytes: metadata.size
  };
}
