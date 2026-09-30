import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const os = vi.hoisted(() => ({ realpath: vi.fn(), stat: vi.fn(), lstat: vi.fn() }));
vi.mock('node:path', async original => {
  const module = await original<typeof import('node:path')>();
  return { ...module.win32, default: module.win32 };
});
vi.mock('../src/main/rawfs.js', () => ({
  rawRealpathNative: os.realpath,
  rawPromises: { stat: os.stat, lstat: os.lstat }
}));

const folder = String.raw`\\wsl.localhost\Ubuntu\home\you\Project`;
const alias = folder.replace('wsl.localhost', 'wsl$');
const file = `${folder}\\File.txt`;
const distroRoot = '\\\\wsl.localhost\\Ubuntu\\';
const runnerPlatform = process.platform;
let sandbox: typeof import('../src/main/sandbox.js');

beforeAll(async () => {
  // Capture the Windows sandbox at module initialization, then immediately restore the
  // runner's process. Only OS path/filesystem boundaries are simulated; policy is real.
  vi.stubGlobal('process', new Proxy(process, {
    get: (target, property) => property === 'platform' ? 'win32' : Reflect.get(target, property)
  }));
  try { sandbox = await import('../src/main/sandbox.js'); }
  finally { vi.unstubAllGlobals(); }
});
afterAll(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
beforeEach(() => {
  expect(process.platform).toBe(runnerPlatform);
  os.realpath.mockReset().mockImplementation(async (input: string) => {
    const canonical = input.replace('wsl$', 'wsl.localhost');
    if ([folder, file, distroRoot].includes(canonical)) return canonical;
    throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
  });
  os.stat.mockReset().mockResolvedValue({ isDirectory: () => true });
  os.lstat.mockReset().mockRejectedValue(Object.assign(new Error('Not found'), { code: 'ENOENT' }));
});

it('approves a local WSL picker folder on every runner', async () => {
  expect(await sandbox.validateNewRoot(alias, [])).toBe(folder);
  await expect(sandbox.validateNewRoot(distroRoot, [])).rejects.toThrow(/entire/);
});

it('resolves approved WSL native and virtual inputs through one sandbox', async () => {
  const roots = [{ name: 'work', path: folder }];
  expect((await sandbox.resolvePath(roots, `${alias}\\File.txt`)).virtual).toBe('/work/File.txt');
  expect((await sandbox.resolvePath(roots, '/work/File.txt')).real).toBe(file);
  expect((await sandbox.resolvePath(roots, '/work/new.txt', { allowMissing: true })).real).toBe(`${folder}\\new.txt`);
});

it('retains Linux case and refuses unapproved hosts before filesystem lookup', async () => {
  const roots = [{ name: 'work', path: folder }];
  expect(sandbox.isContained(folder, folder.replace('Project', 'project'))).toBe(false);
  for (const input of [String.raw`\\server\share\file.txt`, folder.replace('Project', 'project')]) {
    os.realpath.mockClear();
    await expect(sandbox.resolvePath(roots, input, { allowMissing: true })).rejects.toThrow(/not inside/);
    expect(os.realpath).not.toHaveBeenCalled();
  }
  expect(sandbox.isContained('C:\\Work', 'c:\\work\\file.txt')).toBe(true);
});

it('keeps traversal and arbitrary UNC approval refused before lookup', async () => {
  await expect(sandbox.validateNewRoot(String.raw`\\server\share\folder`, [])).rejects.toThrow(/UNC/);
  await expect(sandbox.resolvePath([{ name: 'work', path: folder }], `${alias}\\..\\secret.txt`)).rejects.toThrow(/traversal/);
  expect(os.realpath).not.toHaveBeenCalled();
});
