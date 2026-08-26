import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commonBinaryDirsForPlatform,
  locateBinary,
  resetTunnelLocatorCacheForTests,
  tunnelExecutableName
} from '../src/main/tunnel/locate.js';

const roots: string[] = [];
const originalPath = process.env.PATH;
const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

async function executable(file: string, contents: string): Promise<void> {
  await writeFile(file, contents);
  if (process.platform !== 'win32') await chmod(file, 0o755);
}

afterEach(async () => {
  process.env.PATH = originalPath;
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    writable: true,
    value: originalResourcesPath
  });
  resetTunnelLocatorCacheForTests();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('tunnel binary location', () => {
  it('prefers the tested bundled client over an unrelated PATH copy', async () => {
    const resources = await mkdtemp(path.join(os.tmpdir(), 'clf-tunnel-resources-'));
    const fakePath = await mkdtemp(path.join(os.tmpdir(), 'clf-tunnel-path-'));
    roots.push(resources, fakePath);
    const fileName = tunnelExecutableName('tunnel-client');
    const bundledDir = path.join(resources, 'tunnel');
    await mkdir(bundledDir, { recursive: true });
    const bundled = path.join(bundledDir, fileName);
    const stale = path.join(fakePath, fileName);
    await executable(bundled, 'bundled');
    await executable(stale, 'stale');
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      writable: true,
      value: resources
    });
    process.env.PATH = fakePath;
    resetTunnelLocatorCacheForTests();

    const resolved = locateBinary('tunnel-client');
    expect(path.normalize(resolved!)).toBe(path.normalize(bundled));
    expect(path.normalize(resolved!)).not.toBe(path.normalize(stale));
    expect(path.basename(resolved!)).toBe(fileName);
  });

  it('still lets an explicit user-selected executable override the bundle', async () => {
    const selectedRoot = await mkdtemp(path.join(os.tmpdir(), 'clf-tunnel-selected-'));
    roots.push(selectedRoot);
    const selected = path.join(selectedRoot, tunnelExecutableName('tunnel-client'));
    await executable(selected, 'selected');

    expect(path.normalize(locateBinary('tunnel-client', selected)!)).toBe(path.normalize(selected));
  });

  it('constructs native common-location fallbacks without leaking Windows paths onto POSIX', () => {
    expect(commonBinaryDirsForPlatform('darwin', { HOME: '/Users/test' }, '/Users/test')).toEqual(
      expect.arrayContaining(['/Users/test/.local/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])
    );
    expect(commonBinaryDirsForPlatform('linux', { HOME: '/home/test' }, '/home/test')).toEqual(
      expect.arrayContaining(['/home/test/.local/bin', '/usr/local/bin', '/usr/bin', '/snap/bin'])
    );
    for (const candidate of [
      ...commonBinaryDirsForPlatform('darwin', { HOME: '/Users/test' }, '/Users/test'),
      ...commonBinaryDirsForPlatform('linux', { HOME: '/home/test' }, '/home/test')
    ]) {
      expect(candidate).not.toMatch(/^[A-Za-z]:\\|\\Program Files|\\Users\\/);
    }
  });
});
