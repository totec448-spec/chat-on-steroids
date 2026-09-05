import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BinaryReadError, listDirectoryLevel, readTextFile, walkFiles } from '../src/main/codex/read-backend.js';
import { MAX_READ_FILE_BYTES, MAX_WALK_DEPTH, walk } from '../src/main/codex/filesystem.js';
import { FsOpError } from '../src/main/fsops.js';
import { rawPromises } from '../src/main/rawfs.js';
import { DIR_LINK, makeTempDir, removeTempDir, writeTree } from './helpers.js';

/*
 * `read-backend.readTextFile` is what every `read` call actually runs. It used to have no tests of
 * its own: the encoding and range cases below lived against `fsops.readTextFile`, a second
 * implementation of the same thing that no production path had called for some time. That copy is
 * gone, and its coverage moved here, onto the code that ships.
 *
 * The contract these lock in is that the backend streams safely, honours the model-visible byte
 * budget, and says when more content exists instead of making a bounded slice look complete.
 */

let dir: string;
const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);

beforeAll(async () => {
  dir = await makeTempDir('clf-readbackend-');
  await writeTree(dir, {
    'small.txt': 'alpha\nbeta\ngamma\n',
    'big.txt': `${lines.join('\n')}\n`,
    'crlf.txt': 'one\r\ntwo\r\nthree\r\n',
    'bom.txt': '﻿with bom\n',
    'noeol.txt': 'a\nb\nc',
    'empty.txt': '',
    'tree/a.txt': 'a'
  });
  await fs.writeFile(path.join(dir, 'binary.bin'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]));
  await fs.writeFile(
    path.join(dir, 'utf16le.txt'),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('alpha\nbeta\n', 'utf16le')])
  );
  const utf16beBody = Buffer.from('gamma\ndelta\n', 'utf16le');
  utf16beBody.swap16();
  await fs.writeFile(path.join(dir, 'utf16be.txt'), Buffer.concat([Buffer.from([0xfe, 0xff]), utf16beBody]));
});

afterAll(async () => {
  await removeTempDir(dir);
});

const at = (name: string): string => path.join(dir, name);

describe('readTextFile', () => {
  it('keeps Codex\'s 512 MiB full-file primitive ceiling instead of regressing it to 64 MiB', () => {
    expect(MAX_READ_FILE_BYTES).toBe(512 * 1024 * 1024);
  });

  it('reads a whole small file', async () => {
    const result = await readTextFile(at('small.txt'));
    expect(result.text).toBe('alpha\nbeta\ngamma');
    expect(result.firstLine).toBe(1);
    expect(result.lastLine).toBe(3);
    expect(result.totalLines).toBe(3);
    expect(result.hasMore).toBe(false);
  });

  it('reads an inclusive line range', async () => {
    const result = await readTextFile(at('big.txt'), { startLine: 5, endLine: 7 });
    expect(result.text).toBe('line 5\nline 6\nline 7');
    expect(result.firstLine).toBe(5);
    expect(result.lastLine).toBe(7);
  });

  /*
   * The header's whole job is to say how long the file is, and this is the case that used to get
   * it wrong: a range stopped the scan at `end_line`, so the total was unknown and the header read
   * `lines 5-7` with no denominator. A caller could not tell 3 lines out of 200 from a whole file.
   * The scan now runs on past the range to finish counting, buffering nothing.
   */
  it('reports the file total on a ranged read, not just the range', async () => {
    const result = await readTextFile(at('big.txt'), { startLine: 5, endLine: 7 });
    expect(result.totalLines).toBe(200);
    expect(result.hasMore).toBe(true);
  });

  it('reads to the end of the file when only a start is given', async () => {
    const result = await readTextFile(at('big.txt'), { startLine: 198 });
    expect(result.text).toBe('line 198\nline 199\nline 200');
    expect(result.totalLines).toBe(200);
    expect(result.hasMore).toBe(false);
  });

  it('reports no more lines when the range ends exactly at the last line', async () => {
    const result = await readTextFile(at('big.txt'), { startLine: 199, endLine: 200 });
    expect(result.lastLine).toBe(200);
    expect(result.hasMore).toBe(false);
    expect(result.totalLines).toBe(200);
  });

  it('returns an empty slice for a range past the end, and still says how long the file is', async () => {
    const result = await readTextFile(at('big.txt'), { startLine: 500, endLine: 510 });
    expect(result.text).toBe('');
    expect(result.lastLine).toBeLessThan(result.firstLine);
    expect(result.totalLines).toBe(200);
  });

  it('rejects an inverted range', async () => {
    await expect(readTextFile(at('big.txt'), { startLine: 10, endLine: 2 })).rejects.toBeInstanceOf(FsOpError);
  });

  it('honours the output byte budget while leaving the underlying file readable', async () => {
    // `maxBytes` is deliberately tiny so this catches the dangerous implementation that accepted
    // the option at the tool boundary but then silently ignored it in the streaming backend.
    const result = await readTextFile(at('big.txt'), { maxBytes: 64 });
    expect(result.text).toContain('line 1');
    expect(result.text).not.toContain('line 200');
    expect(result.truncated).toBe(true);
    expect(result.hasMore).toBe(true);
    expect(result.bytesReturned).toBeLessThanOrEqual(64);
  });

  it('does not scan a file to EOF for an advisory line count after it grows past the count budget', async () => {
    const target = at('growing-after-stat.txt');
    await fs.writeFile(target, 'first\n', 'utf8');
    const realLstat = rawPromises.lstat.bind(rawPromises);
    const lstat = vi.spyOn(rawPromises, 'lstat').mockImplementationOnce(async (candidate, options?: any) => {
      const small = await realLstat(candidate as any, options);
      if (String(candidate) === target) {
        // Grow only after the metadata snapshot exists. readTextFile therefore sees the exact
        // stale-size shape a concurrently written log creates in production.
        await fs.writeFile(target, `first\n${'later\n'.repeat(900_000)}`, 'utf8');
      }
      return small as any;
    });
    try {
      const result = await readTextFile(target, { startLine: 1, endLine: 1, maxBytes: 64 });
      expect(result.text).toBe('first');
      expect(result.hasMore).toBe(true);
      expect(result.totalLines).toBeNull();
    } finally {
      lstat.mockRestore();
      await fs.rm(target, { force: true });
    }
  });

  it('strips CR from CRLF files', async () => {
    const result = await readTextFile(at('crlf.txt'));
    expect(result.text).toBe('one\ntwo\nthree');
  });

  it('strips a UTF-8 BOM', async () => {
    const result = await readTextFile(at('bom.txt'));
    expect(result.text).toBe('with bom');
  });

  it('reads UTF-16LE text instead of misclassifying its NUL bytes as binary', async () => {
    const result = await readTextFile(at('utf16le.txt'));
    expect(result.text).toBe('alpha\nbeta');
  });

  it('reads UTF-16BE text', async () => {
    const result = await readTextFile(at('utf16be.txt'));
    expect(result.text).toBe('gamma\ndelta');
  });

  it('handles a file with no trailing newline', async () => {
    const result = await readTextFile(at('noeol.txt'));
    expect(result.text).toBe('a\nb\nc');
    expect(result.totalLines).toBe(3);
  });

  it('handles an empty file', async () => {
    const result = await readTextFile(at('empty.txt'));
    expect(result.text).toBe('');
    expect(result.hasMore).toBe(false);
  });

  it('refuses a binary file without pointing at the retired file_info tool', async () => {
    await expect(readTextFile(at('binary.bin'))).rejects.toBeInstanceOf(BinaryReadError);
    await expect(readTextFile(at('binary.bin'))).rejects.toThrow(/binary file/i);
    await expect(readTextFile(at('binary.bin'))).rejects.not.toThrow(/file_info/i);
  });

  it('reports a recursive walk as truncated when a subtree lies beyond the depth ceiling', async () => {
    let nested = path.join(dir, 'deep-walk');
    await fs.mkdir(nested);
    for (let depth = 0; depth <= MAX_WALK_DEPTH; depth++) {
      nested = path.join(nested, `d${depth}`);
      await fs.mkdir(nested);
    }
    await fs.writeFile(path.join(nested, 'needle.ts'), 'export const deep = true;\n');

    const result = await walkFiles(path.join(dir, 'deep-walk'), '/deep-walk', {
      maxEntries: 5_000,
      exclude: []
    });

    expect(result.files.some((file) => file.endsWith('/needle.ts'))).toBe(false);
    expect(result.truncated).toBe(true);
  });

  it('does not follow a directory link outside the listed root just to classify the child', async () => {
    const listedRoot = at('tree');
    const outsideTarget = at('outside-list-target');
    const escape = path.join(listedRoot, 'escape-dir');
    await fs.mkdir(outsideTarget);
    await fs.symlink(outsideTarget, escape, DIR_LINK);
    try {
      const result = await listDirectoryLevel(listedRoot, '/tree', 50);
      expect(result.entries.find((entry) => entry.name === 'escape-dir')).toMatchObject({
        type: 'other',
        bytes: null
      });
    } finally {
      await fs.rm(escape, { recursive: true, force: true });
      await fs.rm(outsideTarget, { recursive: true, force: true });
    }
  });

  it('never touches an unfollowed directory symlink target, even one that would throw if statted', async () => {
    // A broken link: the target does not exist, so a stat of it always throws ENOENT. If
    // walk(...followDirectorySymlinks:false) ever called getMetadata() on this path to classify
    // it before skipping — the exact boundary readDirectory()'s own docstring says to keep opaque
    // — that throw would surface as a recorded WalkError. Opacity means it never happens at all.
    const listedRoot = at('tree');
    const escape = path.join(listedRoot, 'escape-broken-link');
    await fs.symlink(path.join(listedRoot, 'does-not-exist'), escape, DIR_LINK);
    try {
      const outcome = await walk(listedRoot, {
        maxDepth: MAX_WALK_DEPTH,
        maxDirectories: 100,
        maxEntries: 100,
        followDirectorySymlinks: false
      });
      expect(outcome.errors).toEqual([]);
      expect(outcome.entries.some((entry) => entry.path === escape)).toBe(false);
    } finally {
      await fs.rm(escape, { recursive: true, force: true });
    }
  });

  it('refuses a directory', async () => {
    await expect(readTextFile(at('tree'))).rejects.toThrow(/Not a file/);
  });
});
