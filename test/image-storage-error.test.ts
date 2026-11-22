import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearImageStorage, createSession, getImageStorage, initSessionStore, resetSessionStoreForTests, writeAsset } from '../src/main/session/store.js';

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-audit-cleanup-'));
  initSessionStore(directory);
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetSessionStoreForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

it('returns a handled cleanup error when a recorded-assets folder is unreadable', async () => {
  const session = await createSession({ title: 'Synthetic recordings' });
  await writeAsset(session.id, Buffer.from('synthetic text'), 'text/plain');
  const opendir = fs.opendir.bind(fs);
  vi.spyOn(fs, 'opendir').mockImplementation(async (target, ...args) => {
    if (String(target).endsWith(path.join(session.id, 'assets'))) {
      throw Object.assign(new Error('synthetic asset directory is unreadable'), { code: 'EACCES' });
    }
    return (opendir as (...values: unknown[]) => Promise<Awaited<ReturnType<typeof fs.opendir>>>)(target, ...args);
  });
  await expect(clearImageStorage('session-texts', session.id)).rejects.toThrow('synthetic asset directory is unreadable');
  // Give Node its ordinary unhandled-rejection checkpoint; a handled failure must not leak one.
  await new Promise<void>(resolve => setImmediate(resolve));
  vi.restoreAllMocks();
  // A failed inventory must also release the queue so the person can retry.
  const cleared = await clearImageStorage('session-texts', session.id);
  expect(cleared.removedFiles).toBe(1);
  expect((await getImageStorage(session.id)).session?.usedBytes).toBe(0);
});
