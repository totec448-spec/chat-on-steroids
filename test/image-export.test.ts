import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { makeTempDir, removeTempDir } from './helpers.js';
import {
  completeImageExport, exportFileName, exportImage, ImageExportError, pendingImageExports, resetImageExportsForTests
} from '../src/main/image-export.js';

let dir: string;
const image = { conversationId: '6ac32a38-2b08-83eb-baad-d1a51fa3c2e1', messageId: 'message-1', assetId: 'file_00000000565c' };
const png = (): Promise<Buffer> => sharp({ create: { width: 12, height: 8, channels: 3, background: '#c00' } }).png().toBuffer();
const target = (name: string) => ({ real: path.join(dir, name), virtual: `/workspace/${name}` });

beforeEach(async () => { dir = await makeTempDir('cos-image-export-'); });
afterEach(async () => { resetImageExportsForTests(); await removeTempDir(dir); });

it('saves the original the page delivers, and only the nonce, chat and image ever reach the browser', async () => {
  const saved = exportImage(image, target('apple'));
  const [job] = pendingImageExports();
  expect(job).toEqual({ nonce: expect.any(String), ...image });
  expect(JSON.stringify(pendingImageExports())).not.toContain(dir);
  const bytes = await png();
  expect(await completeImageExport({ nonce: job!.nonce, data: bytes.toString('base64') })).toBe(true);
  // The extension comes from the image itself when the name has none.
  await expect(saved).resolves.toEqual({ virtual: '/workspace/apple.png', format: 'png', width: 12, height: 8, bytes: bytes.length });
  expect(await fs.readFile(path.join(dir, 'apple.png'))).toEqual(bytes);
  expect((await fs.readdir(dir)).filter(name => name.endsWith('.part'))).toEqual([]);
  // A late or repeated delivery changes nothing.
  expect(await completeImageExport({ nonce: job!.nonce, data: bytes.toString('base64') })).toBe(false);
  expect(pendingImageExports()).toEqual([]);
});

it('never replaces a file, even one created while the image was on its way', async () => {
  const saved = exportImage(image, target('taken.png'));
  await fs.writeFile(path.join(dir, 'taken.png'), 'mine');
  const [job] = pendingImageExports();
  await completeImageExport({ nonce: job!.nonce, data: (await png()).toString('base64') });
  await expect(saved).rejects.toThrow('/workspace/taken.png already exists');
  expect(await fs.readFile(path.join(dir, 'taken.png'), 'utf8')).toBe('mine');
  expect(await fs.readdir(dir)).toEqual(['taken.png']);
});

it('refuses bytes that are not a whole image, and says why the page could not deliver', async () => {
  const broken = exportImage(image, target('broken.png'));
  const [first] = pendingImageExports();
  await completeImageExport({ nonce: first!.nonce, data: (await png()).subarray(0, 40).toString('base64') });
  await expect(broken).rejects.toThrow('not a readable image');

  const hidden = exportImage(image, target('hidden.png'));
  const [second] = pendingImageExports();
  await completeImageExport({ nonce: second!.nonce, error: 'not_rendered' });
  await expect(hidden).rejects.toThrow('not shown on the chat\'s page');
  expect(await fs.readdir(dir)).toEqual([]);
});

it('keeps a matching extension and refuses one that names another format', () => {
  expect(exportFileName('/w/a.PNG', 'png')).toBe('/w/a.PNG');
  expect(exportFileName('/w/a.jpeg', 'jpeg')).toBe('/w/a.jpeg');
  expect(exportFileName('/w/a', 'webp')).toBe('/w/a.webp');
  expect(() => exportFileName('/w/a.jpg', 'png')).toThrow(ImageExportError);
  expect(() => exportFileName('/w/a.txt', 'png')).toThrow('.png');
  expect(() => exportFileName('/w/a', 'gif')).toThrow('unsupported');
});

it('gives up with a clear reason when no browser delivers in time', async () => {
  await expect(exportImage(image, target('late.png'), 20)).rejects.toThrow('did not deliver the image in time');
  expect(pendingImageExports()).toEqual([]);
});
