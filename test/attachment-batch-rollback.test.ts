import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { stageInputAttachment, stageInputAttachments, validateInputAttachments } from '../src/main/session/input-attachments.js';

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-audit-attachments-'));
  initSessionStore(directory);
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetSessionStoreForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

it('does not retain undisclosed staged bytes after a multi-file selection fails', async () => {
  await expect(stageInputAttachments([
    { name: 'valid.txt', bytes: Buffer.from('synthetic first file') },
    path.join(directory, 'file-that-disappeared.txt')
  ], new Set())).rejects.toMatchObject({ code: 'ENOENT' });
  const leftovers = await fs.readdir(path.join(directory, 'input-attachments'));
  expect(leftovers).toEqual([]);
});

it('rolls back a quota-refused batch without removing earlier draft or outbox attachments', async () => {
  const existing = await stageInputAttachment({ text: 'previous draft' }, new Set());
  const existingPath = path.join(directory, 'input-attachments', existing.id);
  const stat = fs.stat.bind(fs);
  vi.spyOn(fs, 'stat').mockImplementation(async (target, ...args) => {
    const found = await (stat as (...values: unknown[]) => Promise<Awaited<ReturnType<typeof fs.stat>>>)(target, ...args);
    if (String(target) === existingPath) Object.defineProperty(found, 'size', { value: 2 * 1024 ** 3 - 10 });
    return found;
  });
  await expect(stageInputAttachments([{ text: 'first' }, { text: 'too big for the remaining bytes' }], new Set([existing.id])))
    .rejects.toThrow('Attachment storage is full');
  vi.restoreAllMocks();
  expect((await fs.readdir(path.dirname(existingPath))).sort()).toEqual([existing.id, existing.id + '.json']);
  await validateInputAttachments([existing]);
  const next = await stageInputAttachment({ text: 'next batch still works' }, new Set([existing.id]));
  await validateInputAttachments([next]);
});
