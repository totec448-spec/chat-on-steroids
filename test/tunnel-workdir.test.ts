import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

const fixture = vi.hoisted(() => ({
  mkdtemp: vi.fn(), getconf: vi.fn(), log: vi.fn()
}));
vi.mock('node:fs', () => ({ promises: { mkdtemp: fixture.mkdtemp } }));
vi.mock('node:child_process', () => ({ execFile: fixture.getconf }));
vi.mock('../src/main/logger.js', () => ({ logInfo: fixture.log }));
const { createTunnelWorkDir } = await import('../src/main/tunnel/workdir.js');
const originalPlatform = process.platform;
const missing = Object.assign(new Error('missing inherited temporary directory'), { code: 'ENOENT' });

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  vi.spyOn(os, 'tmpdir').mockReturnValue('/missing-installer-temp');
  fixture.mkdtemp.mockResolvedValue('/private-user-temp/cglf-unique');
  fixture.getconf.mockImplementation((_file, _args, _opts, callback) => callback(null, '/private-user-temp/\n'));
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  vi.restoreAllMocks();
});

describe('the tunnel temporary directory', () => {
  it('uses the ordinary OS directory without a subprocess when it works', async () => {
    await expect(createTunnelWorkDir()).resolves.toBe('/private-user-temp/cglf-unique');
    expect(fixture.mkdtemp).toHaveBeenCalledExactlyOnceWith(path.join('/missing-installer-temp', 'cglf-'));
    expect(fixture.getconf).not.toHaveBeenCalled();
  });
  it('recovers a deleted macOS installer TMPDIR from getconf without changing the app environment', async () => {
    const before = process.env.TMPDIR;
    fixture.mkdtemp.mockRejectedValueOnce(missing);
    await expect(createTunnelWorkDir()).resolves.toBe('/private-user-temp/cglf-unique');
    expect(fixture.getconf).toHaveBeenCalledWith('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'],
      { encoding: 'utf8', timeout: 3_000 }, expect.any(Function));
    expect(fixture.mkdtemp.mock.calls.map(call => call[0])).toEqual([
      path.join('/missing-installer-temp', 'cglf-'), path.join('/private-user-temp', 'cglf-')
    ]);
    expect(process.env.TMPDIR).toBe(before);
    expect(fixture.log).toHaveBeenCalledOnce();
    expect(fixture.log.mock.calls[0]![0]).not.toContain('/private-user-temp');
  });
  it.each(['EACCES', 'ENOSPC', 'ENOTDIR'])('preserves %s rather than trying a different directory', async code => {
    const error = Object.assign(new Error(code), { code });
    fixture.mkdtemp.mockRejectedValueOnce(error);
    await expect(createTunnelWorkDir()).rejects.toBe(error);
    expect(fixture.getconf).not.toHaveBeenCalled();
  });
  it.each(['win32', 'linux'])('keeps %s temporary-directory behavior unchanged', async platform => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    fixture.mkdtemp.mockRejectedValueOnce(missing);
    await expect(createTunnelWorkDir()).rejects.toBe(missing);
    expect(fixture.getconf).not.toHaveBeenCalled();
  });
  it.each(['', 'relative', '/one\n/two', '/one\0two'])('rejects an unusable canonical directory: %j', async output => {
    fixture.mkdtemp.mockRejectedValueOnce(missing);
    fixture.getconf.mockImplementation((_file, _args, _opts, callback) => callback(null, output));
    await expect(createTunnelWorkDir()).rejects.toThrow('no usable user temporary directory');
    expect(fixture.mkdtemp).toHaveBeenCalledOnce();
  });
  it('propagates a failed or timed-out canonical lookup without a retry loop', async () => {
    fixture.mkdtemp.mockRejectedValueOnce(missing);
    const error = new Error('getconf timeout');
    fixture.getconf.mockImplementation((_file, _args, _opts, callback) => callback(error, ''));
    await expect(createTunnelWorkDir()).rejects.toBe(error);
    expect(fixture.getconf).toHaveBeenCalledOnce();
    expect(fixture.log).not.toHaveBeenCalled();
  });
  it('does not claim recovery when the canonical directory also fails', async () => {
    fixture.mkdtemp.mockRejectedValueOnce(missing).mockRejectedValueOnce(new Error('canonical unavailable'));
    await expect(createTunnelWorkDir()).rejects.toThrow('canonical unavailable');
    expect(fixture.log).not.toHaveBeenCalled();
  });
  it('creates separate private work directories for simultaneous connectors', async () => {
    fixture.mkdtemp.mockImplementation(async () => { throw missing; });
    let count = 0;
    fixture.mkdtemp.mockImplementation(async (prefix: string) => {
      if (prefix.includes('missing-installer')) throw missing;
      return `${prefix}${++count}`;
    });
    const dirs = await Promise.all([createTunnelWorkDir(), createTunnelWorkDir()]);
    expect(new Set(dirs).size).toBe(2);
  });
});
