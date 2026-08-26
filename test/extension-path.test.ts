import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

let base: string | null = null;
const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock('electron');
  if (base) await removeTempDir(base);
  base = null;
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    writable: true,
    value: originalResourcesPath
  });
});

it('materializes a packaged extension into a stable per-user folder', async () => {
  base = await makeTempDir('clf-extension-path-');
  const resources = path.join(base, 'ephemeral-appimage-mount', 'resources');
  const bundled = path.join(resources, 'extension');
  const userData = path.join(base, 'user-data');
  await fs.mkdir(path.join(bundled, 'icons'), { recursive: true });
  await fs.writeFile(path.join(bundled, 'manifest.json'), JSON.stringify({ version: '9.9.9' }));
  await fs.writeFile(path.join(bundled, 'background.js'), 'current package');
  await fs.writeFile(path.join(bundled, 'icons', 'icon128.png'), 'icon');

  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    writable: true,
    value: resources
  });
  vi.doMock('electron', () => ({
    app: {
      isPackaged: true,
      getPath: (name: string) => (name === 'userData' ? userData : ''),
      getAppPath: () => path.join(base!, 'not-used')
    }
  }));

  const { extensionDir } = await import('../src/main/extension-path.js');
  const first = extensionDir();
  expect(first).toBe(path.join(userData, 'extension'));
  expect(first).not.toContain('ephemeral-appimage-mount');
  expect(await fs.readFile(path.join(first!, 'background.js'), 'utf8')).toBe('current package');
  expect(await fs.readFile(path.join(first!, 'icons', 'icon128.png'), 'utf8')).toBe('icon');

  // An app update refreshes files at the same Chrome-visible path rather than asking the user
  // to Load unpacked again from a new versioned directory.
  await fs.writeFile(path.join(bundled, 'background.js'), 'updated package');
  expect(extensionDir()).toBe(first);
  expect(await fs.readFile(path.join(first!, 'background.js'), 'utf8')).toBe('updated package');

  // Once a complete stable copy exists, later package damage must not make the Finder/Chrome
  // path disappear. The source is used to refresh; the stable copy is what the user loaded.
  await fs.rm(path.join(bundled, 'manifest.json'));
  expect(extensionDir()).toBe(first);
  expect(await fs.readFile(path.join(first!, 'background.js'), 'utf8')).toBe('updated package');
});

it('repairs a stale destination shape with a complete staged extension instead of failing mid-copy', async () => {
  base = await makeTempDir('clf-extension-repair-');
  const resources = path.join(base, 'resources');
  const bundled = path.join(resources, 'extension');
  const userData = path.join(base, 'user-data');
  const stable = path.join(userData, 'extension');
  await fs.mkdir(path.join(bundled, 'icons'), { recursive: true });
  await fs.writeFile(path.join(bundled, 'manifest.json'), JSON.stringify({ version: '2.0.2' }));
  await fs.writeFile(path.join(bundled, 'background.js'), 'new background');
  await fs.writeFile(path.join(bundled, 'icons', 'icon128.png'), 'new icon');

  // This is a deterministic failure for the previous direct `cpSync(bundled, stable)` design:
  // the destination has `icons` as a file while the package has it as a directory. A fresh staged
  // tree has no such type collision and replaces the old copy only after the whole copy succeeds.
  await fs.mkdir(stable, { recursive: true });
  await fs.writeFile(path.join(stable, 'manifest.json'), JSON.stringify({ version: '1.0.0' }));
  await fs.writeFile(path.join(stable, 'background.js'), 'old background');
  await fs.writeFile(path.join(stable, 'icons'), 'stale file where a directory belongs');

  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    writable: true,
    value: resources
  });
  vi.doMock('electron', () => ({
    app: {
      isPackaged: true,
      getPath: (name: string) => (name === 'userData' ? userData : ''),
      getAppPath: () => path.join(base!, 'not-used')
    }
  }));

  const { extensionDir } = await import('../src/main/extension-path.js');
  expect(extensionDir()).toBe(stable);
  expect(await fs.readFile(path.join(stable, 'background.js'), 'utf8')).toBe('new background');
  expect(await fs.readFile(path.join(stable, 'icons', 'icon128.png'), 'utf8')).toBe('new icon');
  await expect(fs.access(`${stable}.new`)).rejects.toBeDefined();
  await expect(fs.access(`${stable}.old`)).rejects.toBeDefined();
});

it('recovers an interrupted promotion from the valid old copy before trusting stale new or package data', async () => {
  base = await makeTempDir('clf-extension-crash-recovery-');
  const resources = path.join(base, 'resources');
  const bundled = path.join(resources, 'extension');
  const userData = path.join(base, 'user-data');
  const stable = path.join(userData, 'extension');
  const backup = `${stable}.old`;
  const stage = `${stable}.new`;

  // Model a crash after the previous good directory was renamed to `.old`: `stable` has since
  // become a corrupt/incomplete directory, `.old` is the only known-good published copy and
  // `.new` is stale staging. Also damage the package source so recovery cannot rely on a recopy.
  await fs.mkdir(bundled, { recursive: true });
  await fs.writeFile(path.join(bundled, 'background.js'), 'package without manifest');
  await fs.mkdir(stable, { recursive: true });
  await fs.writeFile(path.join(stable, 'background.js'), 'corrupt stable');
  await fs.mkdir(backup, { recursive: true });
  await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify({ version: '1.9.9' }));
  await fs.writeFile(path.join(backup, 'background.js'), 'last known good');
  await fs.mkdir(stage, { recursive: true });
  await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify({ version: '2.0.2' }));
  await fs.writeFile(path.join(stage, 'background.js'), 'uncommitted staging');

  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    writable: true,
    value: resources
  });
  vi.doMock('electron', () => ({
    app: {
      isPackaged: true,
      getPath: (name: string) => (name === 'userData' ? userData : ''),
      getAppPath: () => path.join(base!, 'not-used')
    }
  }));

  const { extensionDir } = await import('../src/main/extension-path.js');
  expect(extensionDir()).toBe(stable);
  expect(await fs.readFile(path.join(stable, 'background.js'), 'utf8')).toBe('last known good');
  expect(JSON.parse(await fs.readFile(path.join(stable, 'manifest.json'), 'utf8'))).toEqual({ version: '1.9.9' });
  await expect(fs.access(backup)).rejects.toBeDefined();
  await expect(fs.access(stage)).rejects.toBeDefined();
});
