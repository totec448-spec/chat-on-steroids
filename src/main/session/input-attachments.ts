import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import sharp from 'sharp';
import { sessionsRoot } from './store.js';
import type { InputAttachment } from '../../shared/input.js';

export const MAX_ATTACHMENT_BYTES = 512 * 1024 * 1024;
export const ATTACHMENT_CHUNK_BYTES = 512 * 1024;
export const attachmentSchema = z.object({ id: z.string().uuid(), name: z.string().min(1).max(255),
  size: z.number().int().nonnegative().max(MAX_ATTACHMENT_BYTES), mimeType: z.string().max(120).regex(/^[\w.+-]+\/[\w.+-]+$/),
  preview: z.string().max(32768).regex(/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/).optional() });
function directory(): string {
  const root = sessionsRoot();
  if (!root) throw new Error('Session storage is not ready');
  return path.join(path.dirname(root), 'input-attachments');
}
function fileFor(id: string): string { return path.join(directory(), z.string().uuid().parse(id)); }
/** Only explicit file selection, drop or clipboard paste writes here; bytes never inflate the durable outbox. */
let staging: Promise<unknown> = Promise.resolve();
export type AttachmentSource = string | { text: string } | { name: string; bytes: Uint8Array };
export function stageInputAttachment(source: AttachmentSource, retained: Set<string>): Promise<InputAttachment> {
  const next = staging.then(() => stage(source, retained));
  staging = next.catch(() => undefined);
  return next;
}
async function stage(source: AttachmentSource, retained: Set<string>): Promise<InputAttachment> {
  const dir = directory();
  await fs.mkdir(dir, { recursive: true });
  let used = 0;
  for (const name of await fs.readdir(dir)) {
    if (!/^[a-f0-9-]{36}$/.test(name)) continue;
    const file = fileFor(name), stat = await fs.stat(file);
    if (!retained.has(name) && Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) {
      await fs.unlink(file); await fs.unlink(file + '.json').catch(() => undefined);
    } else used += stat.size;
  }
  const stat = typeof source === 'string' ? await fs.stat(source) : null;
  const size = typeof source === 'string' ? stat!.size : 'text' in source ? Buffer.byteLength(source.text) : source.bytes.byteLength;
  if (stat && !stat.isFile()) throw new Error('Attach files individually; folders cannot be uploaded');
  if (size > MAX_ATTACHMENT_BYTES) throw new Error('Each attachment must be 512 MB or smaller');
  if (used + size > 2 * 1024 * 1024 * 1024) throw new Error('Attachment storage is full; finish or remove pending messages first');
  const name = typeof source === 'string' ? path.basename(source) : 'text' in source ? 'Attached text.txt' : path.basename(source.name);
  const types: Record<string, string> = { '.md': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg' };
  const attachment = attachmentSchema.parse({ id: randomUUID(), name, size, mimeType: types[path.extname(name).toLowerCase()] ?? 'application/octet-stream' });
  const destination = fileFor(attachment.id);
  try {
    if (typeof source === 'string') {
      // Stream a fixed snapshot with an explicit byte ceiling even if the source grows.
      const input = await fs.open(source, 'r'), output = await fs.open(destination, 'wx');
      try {
        const buffer = Buffer.alloc(ATTACHMENT_CHUNK_BYTES);
        let offset = 0;
        while (offset < size) {
          const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
          if (!bytesRead) throw new Error('The attachment changed while being read; attach it again');
          let written = 0;
          while (written < bytesRead) written += (await output.write(buffer, written, bytesRead - written, offset + written)).bytesWritten;
          offset += bytesRead;
        }
        const after = await input.stat();
        if (after.size !== size || after.mtimeMs !== stat!.mtimeMs) throw new Error('The attachment changed while being read; attach it again');
      } finally { await input.close(); await output.close(); }
    } else await fs.writeFile(destination, 'text' in source ? source.text : source.bytes, { flag: 'wx' });
    if (attachment.mimeType.startsWith('image/') && size <= 12 * 1024 * 1024) {
      try {
        const thumbnail = await sharp(destination, { limitInputPixels: 30_000_000, animated: false }).rotate()
          .resize({ width: 160, height: 160, fit: 'inside', withoutEnlargement: true }).webp({ quality: 60 }).toBuffer();
        if (thumbnail.length <= 24000) attachment.preview = `data:image/webp;base64,${thumbnail.toString('base64')}`;
      } catch { /* Preview is presentation only; the original file remains unchanged for native validation. */ }
    }
    await fs.writeFile(destination + '.json', JSON.stringify(attachment), { flag: 'wx' });
    return attachment;
  } catch (error) { await fs.unlink(destination).catch(() => undefined); throw error; }
}
export function validateInputAttachments(attachments: InputAttachment[]): Promise<void> {
  const next = staging.then(() => validate(attachments));
  staging = next.catch(() => undefined);
  return next;
}
async function validate(attachments: InputAttachment[]): Promise<void> {
  if (attachments.length > 20 || attachments.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENT_BYTES) throw new Error('Attach up to 20 files and 512 MB per message');
  for (const attachment of attachments) {
    const file = fileFor(attachment.id);
    const stored = attachmentSchema.parse(JSON.parse(await fs.readFile(file + '.json', 'utf8')));
    if (JSON.stringify(stored) !== JSON.stringify(attachmentSchema.parse(attachment)) || (await fs.stat(file)).size !== attachment.size) throw new Error('Attachment is missing or changed; attach it again');
    // Admission renews the draft age under the same lock as pruning; a fresh
    // outbox commit cannot lose its bytes to an older concurrent cleanup snapshot.
    const now = new Date(); await fs.utimes(file, now, now);
  }
}
/** Caller must first prove exact claimed input ownership and membership. */
export async function readInputAttachmentChunk(attachment: InputAttachment, offset: number): Promise<string> {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > attachment.size || offset % ATTACHMENT_CHUNK_BYTES !== 0) throw new Error('Invalid attachment offset');
  const handle = await fs.open(fileFor(attachment.id), 'r');
  try {
    if ((await handle.stat()).size !== attachment.size) throw new Error('Attachment changed');
    const buffer = Buffer.alloc(Math.min(ATTACHMENT_CHUNK_BYTES, attachment.size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (bytesRead !== buffer.length) throw new Error('Attachment read incomplete');
    return buffer.toString('base64');
  } finally { await handle.close(); }
}
