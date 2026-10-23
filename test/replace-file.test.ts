import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, chmod, stat } from 'node:fs/promises';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock('../src/main/logger.js', () => logger);

const { replaceFile } = await import('../src/main/replace-file.js');

let dir: string;
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  dir = await mkdtemp(path.join(os.tmpdir(), 'cos-replace-file-'));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it('replaces a file whole and leaves no temporary file beside it', async () => {
  const target = path.join(dir, 'chat.html');
  await writeFile(target, 'old');
  await replaceFile(target, 'new', 'HTML export');
  expect(await readFile(target, 'utf8')).toBe('new');
  expect(await readdir(dir)).toEqual(['chat.html']);
});

it('keeps the old file when the replacement cannot be put in place, and logs why', async () => {
  // A folder cannot be renamed over by a file, so the write fails after the temporary file exists.
  const target = path.join(dir, 'taken');
  await mkdir(target);
  await writeFile(path.join(target, 'inside.txt'), 'kept');
  await expect(replaceFile(target, 'new', 'HTML export')).rejects.toThrow();
  expect(await readFile(path.join(target, 'inside.txt'), 'utf8')).toBe('kept');
  expect(await readdir(dir)).toEqual(['taken']);
  expect(logger.logWarn).toHaveBeenCalledWith(expect.stringMatching(/^HTML export: refused, the file could not be written or replaced \(\w+\)$/));
});

it('reports the write error, and logs it, when removing the temporary file fails too', async () => {
  // Windows can refuse the removal (EBUSY) while an antivirus scan holds the temporary file.
  const target = path.join(dir, 'taken');
  await mkdir(target);
  const remove = fsp.rm.bind(fsp);
  const rm = vi.spyOn(fsp, 'rm').mockImplementation(async (file, options) => {
    if (String(file).endsWith('.tmp')) throw Object.assign(new Error('held by another program'), { code: 'EBUSY' });
    return remove(file, options);
  });
  const failure = await replaceFile(target, 'new', 'HTML export').catch((error: NodeJS.ErrnoException) => error);
  rm.mockRestore();
  expect(failure).toBeInstanceOf(Error);
  expect((failure as NodeJS.ErrnoException).code).not.toBe('EBUSY');
  expect(logger.logWarn.mock.calls.map(([line]) => line)).toEqual([
    expect.stringMatching(/^HTML export: refused, the file could not be written or replaced \((?!EBUSY)\w+\)$/),
    'HTML export: the temporary file beside the chosen file could not be removed (EBUSY)'
  ]);
});

it.skipIf(process.platform === 'win32')('writes through a chosen symlink instead of replacing the link', async () => {
  const real = path.join(dir, 'real.html');
  const link = path.join(dir, 'link.html');
  await writeFile(real, 'old');
  await symlink(real, link);
  await replaceFile(link, 'new', 'HTML export');
  expect((await stat(link)).isFile()).toBe(true);
  expect(await readFile(real, 'utf8')).toBe('new');
  expect(await readdir(dir)).toEqual(['link.html', 'real.html']);
});

it.skipIf(process.platform === 'win32')('stops at a chosen symlink that points at nothing, and logs why', async () => {
  const link = path.join(dir, 'dangling.html');
  await symlink(path.join(dir, 'missing.html'), link);
  await expect(replaceFile(link, 'new', 'HTML export')).rejects.toThrow();
  expect(await readdir(dir)).toEqual(['dangling.html']);
  expect(logger.logWarn).toHaveBeenCalledWith('HTML export: refused, the chosen file could not be resolved (ENOENT)');
});

it.skipIf(process.platform === 'win32')('keeps the replaced file\'s permissions', async () => {
  const target = path.join(dir, 'run.sh');
  await writeFile(target, 'old');
  await chmod(target, 0o750);
  await replaceFile(target, 'new', 'code save');
  expect((await stat(target)).mode & 0o777).toBe(0o750);
});
