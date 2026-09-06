import sharp from 'sharp';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { InputImage } from '../../shared/input.js';
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
export async function prepareInputImage(file: string): Promise<InputImage> {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw new Error('Choose an image smaller than 12 MB');
  const handle = await fs.open(file, 'r');
  let raw: Buffer;
  try { const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1); const read = await handle.read(buffer, 0, buffer.length, 0); if (read.bytesRead > MAX_SOURCE_BYTES) throw new Error('Image is too large'); raw = buffer.subarray(0, read.bytesRead); }
  finally { await handle.close(); }
  const encoded = await sharp(raw, { limitInputPixels: 30_000_000, animated: false }).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
  if (encoded.length > 384000) throw new Error('This image is too complex; choose a smaller image');
  return { name: path.basename(file).replace(/\.[^.]+$/, '').slice(0, 100) + '.webp', dataUrl: `data:image/webp;base64,${encoded.toString('base64')}` };
}
export async function validateInputImages(images: InputImage[]): Promise<void> {
  for (const image of images) {
    if (!/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(image.dataUrl) || image.dataUrl.length > 512100) throw new Error('Invalid image attachment');
    const data = Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1), 'base64');
    const decoded = sharp(data, { limitInputPixels: 2_560_000, animated: false });
    const metadata = await decoded.metadata();
    if (metadata.format !== 'webp' || !metadata.width || !metadata.height || metadata.width > 1600 || metadata.height > 1600) throw new Error('Invalid image attachment');
    await decoded.stats();
  }
}
