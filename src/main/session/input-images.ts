import sharp from 'sharp';
import type { InputImage } from '../../shared/input.js';
/** Validation for existing normalized-image outbox rows and their recorded assets. */
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
