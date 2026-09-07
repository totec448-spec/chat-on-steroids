import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import { initSessionStore } from '../src/main/session/store.js';
import { stageInputAttachment, validateInputAttachments, readInputAttachmentChunk, ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENT_BYTES } from '../src/main/session/input-attachments.js';
let directory: string;
beforeEach(async () => { directory = await makeTempDir('cos-attachments-'); initSessionStore(directory); });
afterEach(async () => { await removeTempDir(directory); });
it('snapshots arbitrary file bytes across chunks without exposing the source path', async () => {
  const original = Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 19, 173);
  const source = path.join(directory, 'notes.md'); await fs.writeFile(source, original);
  const file = await stageInputAttachment(source, new Set());
  await fs.writeFile(source, 'later user edit');
  expect(file).toMatchObject({ name: 'notes.md', size: original.length, mimeType: 'text/markdown' });
  expect(JSON.stringify(file)).not.toContain(directory);
  await validateInputAttachments([file]);
  const chunks = await Promise.all([0, ATTACHMENT_CHUNK_BYTES].map(offset => readInputAttachmentChunk(file, offset)));
  expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk, 'base64')))).toEqual(original);
  await expect(readInputAttachmentChunk(file, 1)).rejects.toThrow('offset');
  await expect(validateInputAttachments([{ ...file, name: 'spoof.pdf' }])).rejects.toThrow('changed');
});
it('keeps dropped Unicode text exact and permits empty native files', async () => {
  const text = 'Text\n中文 — ä 🎈';
  const file = await stageInputAttachment({ text }, new Set());
  expect(Buffer.from(await readInputAttachmentChunk(file, 0), 'base64').toString()).toBe(text);
  const empty = await stageInputAttachment({ text: '' }, new Set());
  expect(empty.size).toBe(0); await validateInputAttachments([empty]);
});
it('rejects folders, traversal IDs, oversized files and oversized messages', async () => {
  await expect(stageInputAttachment(directory, new Set())).rejects.toThrow('folders');
  const source = path.join(directory, 'big.bin');
  const handle = await fs.open(source, 'w'); await handle.truncate(MAX_ATTACHMENT_BYTES + 1); await handle.close();
  await expect(stageInputAttachment(source, new Set())).rejects.toThrow('512 MB');
  const file = await stageInputAttachment({ text: 'x' }, new Set());
  await expect(validateInputAttachments([{ ...file, id: '../config' }])).rejects.toThrow();
  await expect(validateInputAttachments(Array(21).fill(file))).rejects.toThrow('20 files');
});
it('prunes only expired unreferenced staging while durable input members survive', async () => {
  const keep = await stageInputAttachment({ text: 'keep' }, new Set());
  const discard = await stageInputAttachment({ text: 'discard' }, new Set());
  const old = new Date(Date.now() - 48 * 3600000);
  for (const file of [keep, discard]) await fs.utimes(path.join(directory, 'input-attachments', file.id), old, old);
  await stageInputAttachment({ text: 'new' }, new Set([keep.id]));
  await validateInputAttachments([keep]);
  await expect(validateInputAttachments([discard])).rejects.toThrow();
});
