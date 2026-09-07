import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/main/session/store.js', () => ({ sessionsRoot: () => storage.root }));
import { stageInputAttachment } from '../src/main/session/input-attachments.js';

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-attachment-audit-'));
  storage.root = path.join(directory, 'sessions');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

it('applies the staging quota atomically across concurrent picker/drop calls', async () => {
  const staged = path.join(directory, 'input-attachments');
  await fs.mkdir(staged);
  const sentinel = path.join(staged, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  await fs.writeFile(sentinel, 'quota fixture');
  // Simulate a nearly full store without allocating gigabytes on the test host.
  const stat = fs.stat.bind(fs);
  vi.spyOn(fs, 'stat').mockImplementation((async (file: any, options?: any) => {
    const result = await stat(file, options);
    if (String(file) === sentinel) return Object.assign(result, { size: 2 * 1024 * 1024 * 1024 - 10 });
    return result;
  }) as typeof fs.stat);
  const outcomes = await Promise.allSettled([
    stageInputAttachment({ text: '0123456789' }, new Set()),
    stageInputAttachment({ text: 'abcdefghij' }, new Set())
  ]);
  expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter(row => row.status === 'rejected')).toHaveLength(1);
});
