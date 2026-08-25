import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  VIEW_IMAGE_INVALID_MESSAGE,
  MAX_VIEW_IMAGE_BYTES,
  viewImage
} from '../src/main/codex/view-image.js';
import { readFile as readCodexFile } from '../src/main/codex/filesystem.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'clf-view-image-parity-'));
  roots.push(root);
  return root;
}

function pngWithoutImageData(): Buffer {
  const valid = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  const chunks: Buffer[] = [valid.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= valid.length) {
    const length = valid.readUInt32BE(offset);
    const end = offset + 12 + length;
    const type = valid.subarray(offset + 4, offset + 8).toString('ascii');
    if (type !== 'IDAT') chunks.push(valid.subarray(offset, end));
    offset = end;
  }
  return Buffer.concat(chunks);
}

function pngCrc32(data: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index++) {
    crc ^= data[index]!;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngWithCorruptDeflateAndValidChunkCrc(): Buffer {
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const crcOffset = dataStart + length;
    if (bytes.subarray(typeStart, dataStart).toString('ascii') === 'IDAT') {
      bytes.fill(0, dataStart, crcOffset);
      bytes.writeUInt32BE(pngCrc32(bytes, typeStart, crcOffset), crcOffset);
      return bytes;
    }
    offset = crcOffset + 4;
  }
  throw new Error('fixture has no IDAT');
}

/**
 * The shape that actually killed live ChatGPT turns on 2026-08-20.
 *
 * Chunk framing, chunk CRCs and the two-byte zlib header are all valid, so every structural
 * check passed and `view_image` returned a successful `image` content block. The DEFLATE
 * stream underneath is garbage — `zlib` reports `invalid block type` — and the message stream
 * died with `Error in message stream` immediately after each call on this file.
 */
function pngWithValidZlibHeaderOverGarbageDeflate(): Buffer {
  return pngWithReplacedImageData(Buffer.from([0x78, 0x9c, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
}

/** A PNG whose IDAT inflates cleanly but to fewer pixels than IHDR promises. */
function pngWithTruncatedPixelData(): Buffer {
  return pngWithReplacedImageData(deflateSync(Buffer.alloc(0)));
}

/** Tiny compressed payload with huge declared geometry: must be refused before inflation. */
function pngWithOversizedDecodedGeometry(): Buffer {
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const crcOffset = dataStart + length;
    if (bytes.subarray(typeStart, dataStart).toString('ascii') === 'IHDR') {
      bytes.writeUInt32BE(8192, dataStart);
      bytes.writeUInt32BE(8192, dataStart + 4);
      bytes.writeUInt32BE(pngCrc32(bytes, typeStart, crcOffset), crcOffset);
      return bytes;
    }
    offset = crcOffset + 4;
  }
  throw new Error('fixture has no IHDR');
}

/** The 1x1 fixture above with its single IDAT payload swapped for `payload`, CRC repaired. */
function pngWithReplacedImageData(payload: Buffer): Buffer {
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  const out: Buffer[] = [bytes.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (bytes.subarray(offset + 4, offset + 8).toString('ascii') === 'IDAT') {
      const chunk = Buffer.alloc(12 + payload.length);
      chunk.writeUInt32BE(payload.length, 0);
      chunk.write('IDAT', 4, 'ascii');
      payload.copy(chunk, 8);
      chunk.writeUInt32BE(pngCrc32(chunk, 4, 8 + payload.length), 8 + payload.length);
      out.push(chunk);
    } else {
      out.push(bytes.subarray(offset, end));
    }
    offset = end;
  }
  return Buffer.concat(out);
}

function jpegWithoutScanData(): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9
  ]);
}

function jpegWithScanHeaderButNoEntropyData(): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0xff, 0xd9
  ]);
}

function gifWithoutImageFrame(): Buffer {
  return Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    0x01, 0x00, 0x01, 0x00,
    0x00, 0x00, 0x00,
    0x3b
  ]);
}

function gifWithDescriptorButNoLzwData(): Buffer {
  return Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    0x01, 0x00, 0x01, 0x00,
    0x00, 0x00, 0x00,
    0x2c,
    0x00, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00,
    0x00,
    0x3b
  ]);
}

function webpWithoutImageBitstream(): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8X', 12, 'ascii');
  bytes.writeUInt32LE(10, 16);
  // VP8X flags/reserved bytes and 24-bit (width - 1)/(height - 1) stay zero: 1x1 canvas.
  return bytes;
}

function webpWithEmptyVp8Chunk(): Buffer {
  const bytes = Buffer.alloc(20);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(12, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8 ', 12, 'ascii');
  bytes.writeUInt32LE(0, 16);
  return bytes;
}

function webpWithGarbageVp8Payload(): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8 ', 12, 'ascii');
  bytes.writeUInt32LE(10, 16);
  // Ten zero bytes satisfy the port's current length heuristic, but they are not a VP8 frame.
  return bytes;
}

function webpWithPlausibleVp8PrefixButNoBitstream(): Buffer {
  const payload = Buffer.from([0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00]);
  const bytes = Buffer.alloc(20 + payload.length);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8 ', 12, 'ascii');
  bytes.writeUInt32LE(payload.length, 16);
  payload.copy(bytes, 20);
  return bytes;
}

describe('Codex view_image runtime parity', () => {
  it('budgets the native MCP base64 image inside the connector wire envelope', () => {
    const encodedChars = 4 * Math.ceil(MAX_VIEW_IMAGE_BYTES / 3);
    expect(encodedChars + 64 * 1024).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('lets image callers impose a smaller hard read ceiling than the generic 512 MiB primitive', async () => {
    const root = await tempRoot();
    const file = path.join(root, 'bounded.bin');
    await writeFile(file, Buffer.alloc(4097, 0x61));

    // `view_image` has a much smaller wire budget than generic Codex file reads. The read
    // primitive must enforce that caller-specific ceiling on the opened handle, including a file
    // that grows after an earlier metadata check.
    await expect(readCodexFile(file, 4096)).rejects.toThrow(/too large|4096/i);
  });

  it('rejects a structurally framed PNG that cannot be decoded', async () => {
    const root = await tempRoot();
    const image = path.join(root, 'missing-idat.png');
    await writeFile(image, pngWithoutImageData());

    await expect(viewImage(image, null)).rejects.toThrow(VIEW_IMAGE_INVALID_MESSAGE);
  });

  it('rejects PNG IDAT bytes with a valid chunk CRC but invalid deflate stream', async () => {
    const root = await tempRoot();
    const image = path.join(root, 'corrupt-deflate.png');
    await writeFile(image, pngWithCorruptDeflateAndValidChunkCrc());

    await expect(viewImage(image, null)).rejects.toThrow(VIEW_IMAGE_INVALID_MESSAGE);
  });

  it('rejects the live corrupt PNG that broke the ChatGPT message stream', async () => {
    const root = await tempRoot();
    const image = path.join(root, 'audit-deep-corrupt.png');
    await writeFile(image, pngWithValidZlibHeaderOverGarbageDeflate());

    await expect(viewImage(image, null)).rejects.toThrow(VIEW_IMAGE_INVALID_MESSAGE);
  });

  it('rejects a PNG whose image data inflates to fewer pixels than its header promises', async () => {
    const root = await tempRoot();
    const image = path.join(root, 'truncated-pixels.png');
    await writeFile(image, pngWithTruncatedPixelData());

    await expect(viewImage(image, null)).rejects.toThrow(VIEW_IMAGE_INVALID_MESSAGE);
  });

  it('rejects PNG geometry whose decoded scanlines exceed the main-process memory budget', async () => {
    const root = await tempRoot();
    const image = path.join(root, 'oversized-decoded.png');
    await writeFile(image, pngWithOversizedDecodedGeometry());

    await expect(viewImage(image, null)).rejects.toThrow(VIEW_IMAGE_INVALID_MESSAGE);
  });

  it.each([
    ['JPEG without scan data', 'missing-scan.jpg', jpegWithoutScanData()],
    ['JPEG with a scan header but no entropy data', 'empty-scan.jpg', jpegWithScanHeaderButNoEntropyData()],
    ['GIF without an image frame', 'missing-frame.gif', gifWithoutImageFrame()],
    ['GIF with an image descriptor but no LZW data', 'empty-frame.gif', gifWithDescriptorButNoLzwData()],
    ['WebP with only a VP8X canvas header', 'missing-bitstream.webp', webpWithoutImageBitstream()],
    ['WebP with an empty VP8 bitstream chunk', 'empty-vp8.webp', webpWithEmptyVp8Chunk()],
    ['WebP with a garbage VP8 bitstream', 'garbage-vp8.webp', webpWithGarbageVp8Payload()],
    ['WebP with a plausible VP8 prefix but no decodable bitstream', 'plausible-vp8.webp', webpWithPlausibleVp8PrefixButNoBitstream()]
  ])('rejects %s instead of returning undecodable bytes', async (_label, fileName, bytes) => {
    const root = await tempRoot();
    const image = path.join(root, fileName);
    await writeFile(image, bytes);

    await expect(viewImage(image, null)).rejects.toThrow(VIEW_IMAGE_INVALID_MESSAGE);
  });

  it('keeps Codex octet-stream image_url while preserving the concrete MCP MIME', async () => {
    const root = await tempRoot();
    const image = path.join(root, 'pixel.png');
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    );
    await writeFile(image, bytes);

    const result = await viewImage(image, null);
    expect(result.imageUrl).toBe(`data:application/octet-stream;base64,${bytes.toString('base64')}`);
    expect(result.mimeType).toBe('image/png');
    expect(result.detail).toBe('high');
  });

  it('only returns original detail when the model is allowed to request it', async () => {
    const root = await tempRoot();
    const image = path.join(root, 'pixel.png');
    await writeFile(
      image,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      )
    );

    await expect(viewImage(image, 'original')).resolves.toMatchObject({ detail: 'high' });
    await expect(
      viewImage(image, 'original', { canRequestOriginalImageDetail: true })
    ).resolves.toMatchObject({ detail: 'original' });
  });
});
