import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import { ensureManagedUv, extractUvFromTar, initUvRuntime, managedUvDirectory, uvAsset, UV_VERSION } from '../src/main/plugins/uv-runtime.js';
import { pluginEnvironment } from '../src/main/plugins/installer.js';

let root: string;
beforeEach(async () => { root = await makeTempDir('cos-uv-'); initUvRuntime(root); });
afterEach(async () => { await removeTempDir(root); });

it('pins a checksummed official release for every supported desktop platform', () => {
  for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64'], ['win32', 'arm64']] as const) {
    const asset = uvAsset(platform, arch)!;
    expect(asset.url).toBe(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset.file}`);
    expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
  expect(uvAsset('freebsd', 'x64')).toBeNull();
});

it('keeps only the top-level uv and uvx executables from the archive', async () => {
  const source = path.join(root, 'src', 'uv-aarch64-apple-darwin');
  await fs.mkdir(path.join(source, 'nested'), { recursive: true });
  await fs.writeFile(path.join(source, 'uv'), 'UV'); await fs.writeFile(path.join(source, 'uvx'), 'UVX');
  await fs.writeFile(path.join(source, 'README'), 'ignored'); await fs.writeFile(path.join(source, 'nested', 'uv'), 'nested');
  const tar = execFileSync('tar', ['-cf', '-', '-C', path.join(root, 'src'), 'uv-aarch64-apple-darwin']);
  const files = extractUvFromTar(tar);
  expect([...files.keys()].sort()).toEqual(['uv', 'uvx']);
  expect(files.get('uv')!.toString()).toBe('UV');
});

it('installs nothing when the download does not match its published checksum', async () => {
  const fetcher = (async () => new Response(new Uint8Array(1024))) as unknown as typeof fetch;
  await expect(ensureManagedUv(fetcher, 'darwin', 'arm64')).rejects.toThrow('did not match its published checksum');
  await expect(fs.stat(managedUvDirectory()!)).rejects.toThrow();
});

// A simulated POSIX PATH cannot hold a real Windows temp path (it contains "C:"), so this case runs on POSIX hosts.
it.skipIf(process.platform === 'win32')('puts the managed uv folder last on the plugin PATH, after a user install', () => {
  const env = pluginEnvironment({ PATH: '/usr/bin', HOME: '/home/me' }, 'linux');
  const entries = env.PATH!.split(':');
  expect(entries.at(-1)).toBe(managedUvDirectory());
  expect(entries.indexOf('/home/me/.local/bin')).toBeLessThan(entries.length - 1);
});

it.runIf(process.platform === 'win32')('adds the managed uv folder to the Windows plugin PATH', () => {
  const env = pluginEnvironment({ PATH: 'C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\me' }, 'win32');
  expect((env.PATH ?? env.Path)!.split(';')).toContain(managedUvDirectory());
});
