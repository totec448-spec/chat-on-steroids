import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import { initSessionStore } from '../src/main/session/store.js';
import { getLog, resetLoggerForTests } from '../src/main/logger.js';
import { stageInputAttachment, stageInputAttachments, validateInputAttachments, readInputAttachmentChunk, listRecentAttachments, reuseInputAttachments, ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENT_BYTES } from '../src/main/session/input-attachments.js';
let directory: string;
beforeEach(async () => { directory = await makeTempDir('cos-attachments-'); initSessionStore(directory); resetLoggerForTests(); });
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
it('prunes and measures staging once for a multi-file batch', async () => {
  const read = vi.spyOn(fs, 'readdir');
  try {
    const files = await stageInputAttachments([
      { text: 'first' },
      { text: 'second' },
      { name: 'third.bin', bytes: new Uint8Array([1, 2, 3]) }
    ], new Set());
    expect(files).toHaveLength(3);
    expect(read).toHaveBeenCalledTimes(1);
    await validateInputAttachments(files);
  } finally {
    read.mockRestore();
  }
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
it('releases thumbnail source files so expired image originals can be pruned immediately', async () => {
  const bytes = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#437b79' } }).webp().toBuffer();
  const cachedFiles = sharp.cache().files.current;
  const image = await stageInputAttachment({ name: 'reference.webp', bytes }, new Set());
  expect(image.preview).toMatch(/^data:image\/webp;base64,/);
  expect(sharp.cache().files.current).toBe(cachedFiles);
  expect(Buffer.from(await readInputAttachmentChunk(image, 0), 'base64')).toEqual(bytes);
  const original = path.join(directory, 'input-attachments', image.id);
  const old = new Date(Date.now() - 48 * 3600000);
  await fs.utimes(original, old, old);
  await stageInputAttachment({ text: 'next draft' }, new Set());
  await expect(fs.stat(original)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.stat(original + '.json')).rejects.toMatchObject({ code: 'ENOENT' });
});
it('lists staged files most recently used first and reattaches one by id with a renewed age', async () => {
  expect(await listRecentAttachments(new Set())).toEqual([]);
  const report = await stageInputAttachment({ name: 'report.pdf', bytes: new Uint8Array([37, 80, 68, 70]) }, new Set());
  const notes = await stageInputAttachment({ text: 'notes' }, new Set());
  const expired = await stageInputAttachment({ text: 'old draft' }, new Set());
  const held = await stageInputAttachment({ text: 'queued message' }, new Set());
  const staged = (id: string) => path.join(directory, 'input-attachments', id);
  const at = (hours: number) => new Date(Date.now() - hours * 3600000);
  await fs.utimes(staged(report.id), at(3), at(3)); await fs.utimes(staged(notes.id), at(1), at(1));
  await fs.utimes(staged(expired.id), at(30), at(30)); await fs.utimes(staged(held.id), at(40), at(40));
  await fs.writeFile(staged(randomUUID()), 'no sidecar');
  const listed = await listRecentAttachments(new Set([held.id]));
  expect(listed).toEqual([notes, report, held]);
  expect(JSON.stringify(listed)).not.toContain(directory);
  // A pick renews the original's age under the prune lock, so the next staging keeps it.
  await fs.utimes(staged(report.id), at(23.9), at(23.9));
  expect(await reuseInputAttachments([report.id], new Set())).toEqual([report]);
  await fs.utimes(staged(notes.id), at(25), at(25));
  await stageInputAttachment({ text: 'next draft' }, new Set());
  await validateInputAttachments([report]);
  await expect(reuseInputAttachments([notes.id], new Set())).rejects.toThrow('attach it again');
  await expect(reuseInputAttachments(['../config'], new Set())).rejects.toThrow();
});
it('refuses to revive an expired original the list already showed, unless a pending message holds it', async () => {
  const shown = await stageInputAttachment({ text: 'listed an hour ago' }, new Set());
  const held = await stageInputAttachment({ text: 'queued' }, new Set());
  expect(await listRecentAttachments(new Set())).toHaveLength(2);
  // The list stayed open past the 24-hour mark; no prune ran in between.
  const old = new Date(Date.now() - 25 * 3600000);
  for (const file of [shown, held]) await fs.utimes(path.join(directory, 'input-attachments', file.id), old, old);
  await expect(reuseInputAttachments([shown.id], new Set([held.id]))).rejects.toThrow('attach it again');
  expect(await reuseInputAttachments([held.id], new Set([held.id]))).toEqual([held]);
});
it('skips staged files with an old, damaged or mismatched record, one log line each, and still lists the rest', async () => {
  const staged = (id: string) => path.join(directory, 'input-attachments', id);
  const good = await stageInputAttachment({ text: 'still fine' }, new Set());
  // A record written before previews existed has no preview field, and still lists.
  const older = await stageInputAttachment({ text: 'saved by an older version' }, new Set());
  const { preview: _preview, ...oldRecord } = older as typeof older & { preview?: string };
  await fs.writeFile(staged(older.id) + '.json', JSON.stringify(oldRecord));
  const damaged = await stageInputAttachment({ text: 'record cut off' }, new Set());
  await fs.writeFile(staged(damaged.id) + '.json', '{"id":"');
  const foreign = await stageInputAttachment({ text: 'record from a newer version' }, new Set());
  await fs.writeFile(staged(foreign.id) + '.json', JSON.stringify({ id: foreign.id, name: 5 }));
  const resized = await stageInputAttachment({ text: 'bytes changed' }, new Set());
  await fs.appendFile(staged(resized.id), 'more');
  const moved = await stageInputAttachment({ text: 'original deleted' }, new Set());
  await fs.unlink(staged(moved.id));
  const listed = await listRecentAttachments(new Set());
  expect(listed.map(file => file.id).sort()).toEqual([good.id, older.id].sort());
  const lines = getLog().filter(entry => entry.message.startsWith('Recent files:'));
  expect(lines.map(entry => entry.level)).toEqual(['warn', 'warn', 'warn']);
  for (const file of [damaged, foreign, resized]) expect(lines.filter(entry => entry.message.includes(file.id))).toHaveLength(1);
  // Picking an original that has gone since the list was shown is refused and says so, and the menu keeps working.
  await expect(reuseInputAttachments([moved.id], new Set())).rejects.toThrow('attach it again');
  expect(getLog().filter(entry => entry.message.includes(`refused to attach staged file ${moved.id}`))).toHaveLength(1);
  expect(await listRecentAttachments(new Set())).toHaveLength(2);
  expect(JSON.stringify(getLog())).not.toContain(directory);
});
it('reports an unreadable staging folder as a failure, not as an empty list', async () => {
  expect(await listRecentAttachments(new Set())).toEqual([]);
  const denied = Object.assign(new Error(`EACCES: permission denied, scandir '${directory}'`), { code: 'EACCES' });
  const read = vi.spyOn(fs, 'readdir').mockRejectedValueOnce(denied);
  await expect(listRecentAttachments(new Set())).rejects.toThrow('Recent files could not be read (EACCES)');
  const lines = getLog().filter(entry => entry.message.startsWith('Recent files:'));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ level: 'warn' });
  expect(JSON.stringify(getLog())).not.toContain(directory);
  read.mockRestore();
  // The failure does not wedge the staging lock.
  const next = await stageInputAttachment({ text: 'after' }, new Set());
  expect(await listRecentAttachments(new Set())).toEqual([next]);
});
it('skips a malformed staging name or an unreadable original instead of failing the whole list, saying why', async () => {
  const valid = await stageInputAttachment({ text: 'kept' }, new Set());
  const unreadable = await stageInputAttachment({ text: 'locked' }, new Set());
  // Passes the name filter (36 hex or hyphen characters) but is not a UUID.
  const malformed = 'a'.repeat(36);
  await fs.writeFile(path.join(directory, 'input-attachments', malformed), 'stray');
  const realStat = fs.stat.bind(fs);
  const stat = vi.spyOn(fs, 'stat').mockImplementation(async (target, ...rest) => {
    if (String(target).endsWith(unreadable.id)) throw Object.assign(new Error(`EACCES: permission denied, stat '${String(target)}'`), { code: 'EACCES' });
    return realStat(target, ...rest);
  });
  try { expect(await listRecentAttachments(new Set())).toEqual([valid]); } finally { stat.mockRestore(); }
  const lines = getLog().filter(entry => entry.message.startsWith('Recent files:')).map(entry => entry.message);
  expect(lines).toHaveLength(2);
  expect(lines).toContain(`Recent files: left out staged entry ${malformed}, its name is not a valid id`);
  expect(lines).toContain(`Recent files: left out staged file ${unreadable.id}, the original could not be read (EACCES)`);
  expect(JSON.stringify(getLog())).not.toContain(directory);
});
