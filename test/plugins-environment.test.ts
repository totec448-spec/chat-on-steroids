import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { pluginEnvironment, runInstaller } from '../src/main/plugins/installer.js';

describe('Windows plugin runtime discovery', () => {
  it('finds a standard per-user uv install after the app started, preserving inherited precedence', () => {
    const inherited = { PATH: 'C:\\tools;C:\\Windows', USERPROFILE: 'C:\\Users\\example' };
    const env = pluginEnvironment(inherited, 'win32');
    expect(env.PATH).toBe('C:\\tools;C:\\Windows;C:\\Users\\example\\.local\\bin');
    expect(inherited.PATH).toBe('C:\\tools;C:\\Windows');
    expect(pluginEnvironment(env, 'win32')).toEqual(env);
  });

  it('does not add a relative search directory when the user profile is unavailable', () => {
    expect(pluginEnvironment({ PATH: 'C:\\tools' }, 'win32')).toEqual({ PATH: 'C:\\tools' });
    expect(pluginEnvironment({ PATH: 'C:\\tools', USERPROFILE: 'relative' }, 'win32').PATH).toBe('C:\\tools');
  });

  it.skipIf(process.platform !== 'win32')('launches the newly installed executable through the real installer environment', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-plugin-path-'));
    try {
      const bin = path.join(root, '.local', 'bin');
      await fs.mkdir(bin, { recursive: true });
      // Stand in for uv without installing packages or relying on the host's uv.
      await fs.copyFile(process.execPath, path.join(bin, 'uv.exe'));
      vi.stubEnv('USERPROFILE', root);
      vi.stubEnv('PATH', path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'));
      await runInstaller('uv', ['-e', 'require("node:fs").writeFileSync("receipt.txt", "launched")'], root);
      expect(await fs.readFile(path.join(root, 'receipt.txt'), 'utf8')).toBe('launched');
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
