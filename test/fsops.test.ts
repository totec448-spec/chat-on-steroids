import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  FsOpError,
  MAX_WRITE_BYTES,
  appendTextFile,
  assertWritableSize,
  clamp,
  decodeBase64Data,
  editTextFile,
  editTextFiles,
  formatBytes,
  listDirectory,
  readImageFile,
  replaceTextFile,
  sniffBinary,
  sniffBinaryBytes,
  statInfo
} from '../src/main/fsops.js';
// Reading back an edited file to check what landed. `fsops` no longer has a reader of its own —
// the second implementation it used to carry was dead — so these assertions go through the one
// the app actually reads with. Its own behaviour is covered in read-backend.test.ts.
import { readTextFile } from '../src/main/codex/read-backend.js';
import { makeTempDir, removeTempDir, writeTree } from './helpers.js';

let dir: string;
const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);

beforeAll(async () => {
  dir = await makeTempDir('clf-fsops-');
  await writeTree(dir, {
    'small.txt': 'alpha\nbeta\ngamma\n',
    'big.txt': `${lines.join('\n')}\n`,
    'crlf.txt': 'one\r\ntwo\r\nthree\r\n',
    'bom.txt': '﻿with bom\n',
    'noeol.txt': 'a\nb\nc',
    'empty.txt': '',
    'dupes.txt': 'x = 1\ny = 2\nx = 1\n',
    'tree/a.txt': 'a',
    'tree/b.txt': 'b',
    'tree/node_modules/pkg/index.js': 'noise',
    'tree/.claude-acct2/history.txt': 'profile noise',
    'tree/sub/c.txt': 'c'
  });
  await fs.writeFile(path.join(dir, 'binary.bin'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]));
  await fs.writeFile(path.join(dir, 'highbytes.bin'), Buffer.alloc(4096, 0x01));
  await fs.writeFile(
    path.join(dir, 'pixel.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  );
  await fs.writeFile(
    path.join(dir, 'utf16le.txt'),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('alpha\nbeta\n', 'utf16le')])
  );
  const utf16beBody = Buffer.from('gamma\ndelta\n', 'utf16le');
  utf16beBody.swap16();
  await fs.writeFile(
    path.join(dir, 'utf16be.txt'),
    Buffer.concat([Buffer.from([0xfe, 0xff]), utf16beBody])
  );
});

afterAll(async () => {
  await removeTempDir(dir);
});

const at = (name: string): string => path.join(dir, name);

describe('sniffBinary', () => {
  it('applies the same heuristic to bytes already read by another hot path', () => {
    expect(sniffBinaryBytes(Buffer.from('plain text\n'))).toBe(false);
    expect(sniffBinaryBytes(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]))).toBe(true);
    expect(sniffBinaryBytes(Buffer.from([0xff, 0xfe, 0x61, 0x00]))).toBe(false);
  });

  it('detects a NUL byte', async () => {
    expect(await sniffBinary(at('binary.bin'))).toBe(true);
  });

  it('detects dense non-printable content without NUL', async () => {
    expect(await sniffBinary(at('highbytes.bin'))).toBe(true);
  });

  it('accepts plain text', async () => {
    expect(await sniffBinary(at('small.txt'))).toBe(false);
  });

  it('accepts BOM-marked UTF-16 text', async () => {
    expect(await sniffBinary(at('utf16le.txt'))).toBe(false);
    expect(await sniffBinary(at('utf16be.txt'))).toBe(false);
  });

  it('accepts an empty file', async () => {
    expect(await sniffBinary(at('empty.txt'))).toBe(false);
  });
});

describe('statInfo', () => {
  it('describes a text file', async () => {
    const info = await statInfo(at('small.txt'), '/root/small.txt');
    expect(info.type).toBe('file');
    expect(info.binary).toBe(false);
    expect(info.lines).toBe(3);
    expect(info.bytes).toBe(17);
    expect(info.sha256).toBeNull();
  });

  it('hashes on request', async () => {
    const info = await statInfo(at('small.txt'), '/root/small.txt', { hash: true });
    expect(info.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('describes a directory without counting lines', async () => {
    const info = await statInfo(at('tree'), '/root/tree');
    expect(info.type).toBe('directory');
    expect(info.lines).toBeNull();
    expect(info.binary).toBeNull();
  });

  it('flags a binary file instead of counting its lines', async () => {
    const info = await statInfo(at('binary.bin'), '/root/binary.bin');
    expect(info.binary).toBe(true);
    expect(info.lines).toBeNull();
  });
});

describe('listDirectory', () => {
  it('lists directories before files, alphabetically', async () => {
    const { entries } = await listDirectory(at('tree'), '/root/tree', {
      maxEntries: 100,
      exclude: []
    });
    const names = entries.map((e) => e.name);
    expect(names).toEqual(['.claude-acct2', 'node_modules', 'sub', 'a.txt', 'b.txt']);
    expect(entries[0]?.type).toBe('directory');
    expect(entries.find((e) => e.name === 'a.txt')?.bytes).toBe(1);
  });

  it('builds virtual paths for children', async () => {
    const { entries } = await listDirectory(at('tree'), '/root/tree', {
      maxEntries: 100,
      exclude: []
    });
    expect(entries.find((e) => e.name === 'a.txt')?.virtualPath).toBe('/root/tree/a.txt');
  });

  it('stops at maxEntries and reports truncation', async () => {
    const { entries, truncated } = await listDirectory(at('tree'), '/root/tree', {
      maxEntries: 2,
      exclude: []
    });
    expect(entries).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it('skips excluded folders when recursing, including trailing-star prefix patterns', async () => {
    const { entries } = await listDirectory(at('tree'), '/root/tree', {
      recursive: true,
      maxEntries: 100,
      exclude: ['node_modules', '.claude-*']
    });
    const names = entries.map((e) => e.name);
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('.claude-acct2');
    expect(names).not.toContain('history.txt');
    expect(names).toContain('c.txt');
  });

  it('recurses into everything when nothing is excluded', async () => {
    const { entries } = await listDirectory(at('tree'), '/root/tree', {
      recursive: true,
      maxEntries: 100,
      exclude: []
    });
    expect(entries.map((e) => e.name)).toContain('index.js');
  });

  it('fails loudly when the top-level directory is unreadable', async () => {
    await expect(
      listDirectory(at('does-not-exist'), '/root/x', { maxEntries: 10, exclude: [] })
    ).rejects.toThrow();
  });
});

describe('editTextFile', () => {
  async function scratch(name: string, content: string): Promise<string> {
    const file = at(name);
    await fs.writeFile(file, content, 'utf8');
    return file;
  }

  it('replaces a unique snippet', async () => {
    const file = await scratch('edit1.txt', 'const a = 1;\nconst b = 2;\n');
    const result = await editTextFile(file, [{ oldText: 'const b = 2;', newText: 'const b = 99;' }]);
    expect(result.replacements).toBe(1);
    expect(await fs.readFile(file, 'utf8')).toBe('const a = 1;\nconst b = 99;\n');
  });

  it('applies several edits in order', async () => {
    const file = await scratch('edit2.txt', 'one\ntwo\nthree\n');
    await editTextFile(file, [
      { oldText: 'one', newText: '1' },
      { oldText: 'three', newText: '3' }
    ]);
    expect(await fs.readFile(file, 'utf8')).toBe('1\ntwo\n3\n');
  });

  it('accepts an LF snippet copied from read_file when the real file is CRLF', async () => {
    const file = await scratch('edit-crlf.txt', 'one\r\ntwo\r\nthree\r\n');
    await editTextFile(file, [{ oldText: 'one\ntwo', newText: 'ONE\nTWO' }]);
    expect(await fs.readFile(file, 'utf8')).toBe('ONE\r\nTWO\r\nthree\r\n');
  });

  it('refuses an ambiguous snippet rather than guessing', async () => {
    const file = await scratch('edit3.txt', 'x = 1\ny = 2\nx = 1\n');
    await expect(editTextFile(file, [{ oldText: 'x = 1', newText: 'x = 9' }])).rejects.toThrow(
      /occurs 2 times, at lines 1, 3/
    );
    // The file must be untouched after a refusal.
    expect(await fs.readFile(file, 'utf8')).toBe('x = 1\ny = 2\nx = 1\n');
  });

  it('replaces every occurrence when asked', async () => {
    const file = await scratch('edit4.txt', 'x = 1\ny = 2\nx = 1\n');
    const result = await editTextFile(file, [
      { oldText: 'x = 1', newText: 'x = 9', replaceAll: true }
    ]);
    expect(result.replacements).toBe(2);
    expect(await fs.readFile(file, 'utf8')).toBe('x = 9\ny = 2\nx = 9\n');
  });

  it('refuses a snippet that is not present', async () => {
    const file = await scratch('edit5.txt', 'hello\n');
    await expect(editTextFile(file, [{ oldText: 'nope', newText: 'x' }])).rejects.toThrow(
      /was not found/
    );
  });

  it('refuses an edit that changes nothing', async () => {
    const file = await scratch('edit6.txt', 'hello\n');
    await expect(editTextFile(file, [{ oldText: 'hello', newText: 'hello' }])).rejects.toThrow(
      /no change/
    );
  });

  it('refuses an empty oldText', async () => {
    const file = await scratch('edit7.txt', 'hello\n');
    await expect(editTextFile(file, [{ oldText: '', newText: 'x' }])).rejects.toThrow(/non-empty/);
  });

  it('preserves UTF-16LE encoding and BOM while editing', async () => {
    const file = at('utf16-edit.txt');
    await fs.writeFile(
      file,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('alpha\nbeta\n', 'utf16le')])
    );
    await editTextFile(file, [{ oldText: 'beta', newText: 'gamma' }]);
    const bytes = await fs.readFile(file);
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect((await readTextFile(file)).text).toBe('alpha\ngamma');
  });

  it('preserves UTF-16 encoding for whole-file writes and appends', async () => {
    const file = at('utf16-write.txt');
    await fs.writeFile(
      file,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('one\n', 'utf16le')])
    );
    await replaceTextFile(file, 'two\n');
    await appendTextFile(file, 'three\n');
    const bytes = await fs.readFile(file);
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect((await readTextFile(file)).text).toBe('two\nthree');
  });

  it('refuses to edit a binary file', async () => {
    await expect(
      editTextFile(at('binary.bin'), [{ oldText: 'PK', newText: 'ZZ' }])
    ).rejects.toThrow(/binary/);
  });

  it('leaves the file untouched when a later edit fails', async () => {
    const file = await scratch('edit8.txt', 'one\ntwo\n');
    await expect(
      editTextFile(file, [
        { oldText: 'one', newText: '1' },
        { oldText: 'missing', newText: 'x' }
      ])
    ).rejects.toThrow(/was not found/);
    expect(await fs.readFile(file, 'utf8')).toBe('one\ntwo\n');
  });

  it('preflights every file before a cross-file batch changes anything', async () => {
    const first = await scratch('batch-preflight-a.txt', 'alpha\n');
    const second = await scratch('batch-preflight-b.txt', 'beta\n');
    await expect(
      editTextFiles([
        {
          realPath: first,
          virtualPath: '/root/a.txt',
          edits: [{ oldText: 'alpha', newText: 'ALPHA' }]
        },
        {
          realPath: second,
          virtualPath: '/root/b.txt',
          edits: [{ oldText: 'missing', newText: 'BETA' }]
        }
      ])
    ).rejects.toThrow(/was not found/);
    expect(await fs.readFile(first, 'utf8')).toBe('alpha\n');
    expect(await fs.readFile(second, 'utf8')).toBe('beta\n');
  });

  it('edits multiple files and preserves UTF-16 BOM/encoding in the batch', async () => {
    const utf8 = await scratch('batch-ok-a.txt', 'alpha\n');
    const utf16 = at('batch-ok-b.txt');
    await fs.writeFile(
      utf16,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('beta\n', 'utf16le')])
    );

    const result = await editTextFiles([
      {
        realPath: utf8,
        virtualPath: '/root/a.txt',
        edits: [{ oldText: 'alpha', newText: 'ALPHA' }]
      },
      {
        realPath: utf16,
        virtualPath: '/root/b.txt',
        edits: [{ oldText: 'beta', newText: 'BETA' }]
      }
    ]);

    expect(result).toHaveLength(2);
    expect(await fs.readFile(utf8, 'utf8')).toBe('ALPHA\n');
    const bytes = await fs.readFile(utf16);
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect((await readTextFile(utf16)).text).toBe('BETA');
  });

  it('rolls back an earlier file when a later staged commit fails', async () => {
    const first = await scratch('batch-rollback-a.txt', 'alpha\n');
    const second = await scratch('batch-rollback-b.txt', 'beta\n');
    const originalRename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from).includes('.clf-stage-') && String(to) === second) {
        const error = new Error('simulated commit failure') as NodeJS.ErrnoException;
        error.code = 'EBUSY';
        throw error;
      }
      return originalRename(from, to);
    });

    try {
      await expect(
        editTextFiles([
          {
            realPath: first,
            virtualPath: '/root/a.txt',
            edits: [{ oldText: 'alpha', newText: 'ALPHA' }]
          },
          {
            realPath: second,
            virtualPath: '/root/b.txt',
            edits: [{ oldText: 'beta', newText: 'BETA' }]
          }
        ])
      ).rejects.toThrow(/simulated commit failure/);
    } finally {
      spy.mockRestore();
    }

    expect(await fs.readFile(first, 'utf8')).toBe('alpha\n');
    expect(await fs.readFile(second, 'utf8')).toBe('beta\n');
    expect((await fs.readdir(dir)).some((name) => name.startsWith('.clf-'))).toBe(false);
  });

  it('refuses the same file twice in one batch', async () => {
    const file = await scratch('batch-duplicate.txt', 'alpha\n');
    await expect(
      editTextFiles([
        { realPath: file, virtualPath: '/root/a.txt', edits: [{ oldText: 'alpha', newText: 'A' }] },
        { realPath: file, virtualPath: '/root/a.txt', edits: [{ oldText: 'alpha', newText: 'B' }] }
      ])
    ).rejects.toThrow(/same file appears more than once/);
    expect(await fs.readFile(file, 'utf8')).toBe('alpha\n');
  });
});

describe('image and binary helpers', () => {
  it('returns supported images as native-ready base64 plus the detected MIME type', async () => {
    const image = await readImageFile(at('pixel.png'));
    expect(image.mimeType).toBe('image/png');
    expect(Buffer.from(image.data, 'base64').subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('rejects a non-image passed to the image reader', async () => {
    await expect(readImageFile(at('binary.bin'))).rejects.toThrow(/unsupported image/i);
  });

  it('rejects a corrupt image that only has a valid PNG signature', async () => {
    const valid = await fs.readFile(at('pixel.png'));
    const corrupt = Buffer.from(valid);
    const corruptIndex = corrupt.length - 5;
    corrupt[corruptIndex] = corrupt[corruptIndex]! ^ 0xff;
    const target = at('corrupt.png');
    await fs.writeFile(target, corrupt);
    await expect(readImageFile(target)).rejects.toThrow(/invalid or corrupt PNG/i);
  });

  it('decodes standard and URL-safe base64 strictly', () => {
    expect(decodeBase64Data(Buffer.from('hello').toString('base64')).toString()).toBe('hello');
    expect(decodeBase64Data('aGVsbG8')).toEqual(Buffer.from('hello'));
    expect(() => decodeBase64Data('not@@base64')).toThrow(/valid base64/i);
  });
});

describe('bounds helpers', () => {
  it('rejects oversized content', () => {
    expect(() => assertWritableSize('a'.repeat(MAX_WRITE_BYTES + 1))).toThrow(FsOpError);
    expect(() => assertWritableSize('a'.repeat(1000))).not.toThrow();
  });

  it('counts multi-byte characters against the limit', () => {
    // "€" is 3 bytes, so a string of MAX/2 of them is over the byte budget.
    expect(() => assertWritableSize('€'.repeat(MAX_WRITE_BYTES / 2))).toThrow(FsOpError);
  });

  it('clamps out-of-range and non-finite numbers', () => {
    expect(clamp(5, 1, 10)).toBe(5);
    expect(clamp(-3, 1, 10)).toBe(1);
    expect(clamp(99, 1, 10)).toBe(10);
    expect(clamp(Number.NaN, 1, 10)).toBe(1);
    expect(clamp(Number.POSITIVE_INFINITY, 1, 10)).toBe(1);
  });

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

it('formatBytes never shows 1024.0 of a unit when the next unit is meant', () => {
  expect(formatBytes(1023)).toBe('1023 B');
  expect(formatBytes(1024 * 1024 - 1)).toBe('1.0 MB');
  expect(formatBytes(1024 * 1024 * 1024 - 1)).toBe('1.00 GB');
  expect(formatBytes(1024 * 1024 - 100)).toBe('1023.9 KB');
});
