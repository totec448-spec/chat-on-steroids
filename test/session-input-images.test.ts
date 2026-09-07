import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { validateInputImages } from '../src/main/session/input-images.js';
import { stageInputAttachment, readInputAttachmentChunk } from '../src/main/session/input-attachments.js';
import { initSessionStore } from '../src/main/session/store.js';

let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-input-images-')); initSessionStore(directory); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
const dataUrl = (buffer: Buffer) => `data:image/webp;base64,${buffer.toString('base64')}`;
describe('input image byte and pixel validation', () => {
  it('preserves original image bytes and creates a separate bounded thumbnail', async () => {
    const file = path.join(directory, 'example.png');
    await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#123456' } }).png().toFile(file);
    const image = await stageInputAttachment(file, new Set());
    expect(image.name).toBe('example.png');
    expect(image.preview).toMatch(/^data:image\/webp;base64,/);
    const metadata = await sharp(Buffer.from(image.preview!.split(',')[1]!, 'base64')).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: 160, height: 80 });
    expect(Buffer.from(await readInputAttachmentChunk(image, 0), 'base64')).toEqual(await fs.readFile(file));
  });

  it('rejects oversized source files and directories before staging', async () => {
    const file = path.join(directory, 'too-big.webp');
    await fs.writeFile(file, '');
    await fs.truncate(file, 512 * 1024 * 1024 + 1);
    await expect(stageInputAttachment(file, new Set())).rejects.toThrow(/512 MB/);
    await expect(stageInputAttachment(directory, new Set())).rejects.toThrow(/folders/);
  });

  it('rejects invalid source bytes and forged WebP MIME labels', async () => {
    const file = path.join(directory, 'invalid.png');
    await fs.writeFile(file, 'not an image');
    const staged = await stageInputAttachment(file, new Set());
    expect(staged.preview).toBeUndefined(); // ChatGPT, not a thumbnail decoder, decides file support.
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer();
    await expect(validateInputImages([{ name: 'forged.webp', dataUrl: dataUrl(png) }])).rejects.toThrow(/Invalid image/);
    await expect(validateInputImages([{ name: 'invalid.webp', dataUrl: dataUrl(Buffer.from('invalid')) }])).rejects.toThrow();
  });

  it('rejects attachment encoded-size and decoded-dimension overflows', async () => {
    await expect(validateInputImages([{ name: 'huge.webp', dataUrl: `data:image/webp;base64,${'A'.repeat(512100)}` }])).rejects.toThrow(/Invalid image/);
    const wide = await sharp({ create: { width: 1601, height: 1, channels: 3, background: '#fff' } }).webp().toBuffer();
    await expect(validateInputImages([{ name: 'wide.webp', dataUrl: dataUrl(wide) }])).rejects.toThrow(/Invalid image/);
  });
});
