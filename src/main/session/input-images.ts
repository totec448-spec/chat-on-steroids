import sharp from 'sharp';
import type { InputImage } from '../../shared/input.js';
/** One normalized representation for tool injection and its recorded assets. */
export async function normalizeInputImage(data: Buffer, name: string): Promise<InputImage> {
  if (data.length > 12 * 1024 * 1024) throw new Error('Images for injection must be 12 MB or smaller');
  const decoder = sharp(data, { limitInputPixels: 30_000_000, animated: false });
  const metadata = await decoder.metadata();
  if (!['png', 'jpeg', 'webp', 'gif'].includes(metadata.format ?? '')) throw new Error('Inject PNG, JPEG, WebP or GIF images');
  const bytes = await decoder.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 }).toBuffer();
  if (bytes.length > 384_000) throw new Error('Image exceeds the injection size limit; use After this turn to upload the original');
  const image = { name: name.slice(0, 110), dataUrl: `data:image/webp;base64,${bytes.toString('base64')}` };
  await validateInputImages([image]);
  return image;
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
