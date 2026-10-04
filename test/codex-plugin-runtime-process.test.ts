import { ChildProcess, execFile, spawn, type SpawnOptions } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listInstalledCodexPlugins } from '../src/main/codex-plugin-runtime.js';
import { deleteEnvValue, envValue, normalizeEnvironment } from '../src/main/env.js';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn()
}));

describe.runIf(process.platform === 'win32')('Windows Codex runtime launch boundary', () => {
  let directory: string;
  let script: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'cos-plugin-runtime & '));
    script = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(path.join(directory, 'codex.cmd'), '@echo fixture only');
    await writeFile(script, '// synthetic fixture; the external process boundary is mocked');
    vi.stubEnv('PATH', directory);
    vi.stubEnv('ELECTRON_RUN_AS_NODE', undefined);
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new ChildProcess(), {
        stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn()
      });
      queueMicrotask(() => {
        child.stdout.end('{"installed":[]}');
        child.emit('close', 0);
      });
      return child;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('runs the npm JavaScript entry in Node mode without a shell or parent-environment mutation', async () => {
    expect(await listInstalledCodexPlugins(directory, directory)).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [file, args, options] = vi.mocked(spawn).mock.calls[0] as [string, string[], SpawnOptions];
    expect(file).toBe(process.execPath);
    expect(args).toEqual([script, 'plugin', 'list', '--json']);
    expect(options).toMatchObject({ cwd: directory, shell: false, windowsHide: true });
    expect(envValue(options.env!, 'CODEX_HOME')).toBe(directory);
    expect(envValue(options.env!, 'ELECTRON_RUN_AS_NODE')).toBe('1');
    expect(envValue(process.env, 'ELECTRON_RUN_AS_NODE')).toBeUndefined();
  });

  it('prefers a native executable and does not inject Node mode into it', async () => {
    const native = path.join(directory, 'codex.exe');
    await writeFile(native, 'synthetic fixture; never executed');
    expect(await listInstalledCodexPlugins(directory, directory)).toEqual([]);
    const [file, args, options] = vi.mocked(spawn).mock.calls[0] as [string, string[], SpawnOptions];
    expect(file).toBe(native);
    expect(args).toEqual(['plugin', 'list', '--json']);
    expect(options.shell).toBe(false);
    expect(envValue(options.env!, 'ELECTRON_RUN_AS_NODE')).toBeUndefined();
  });

  it('does not turn a relative PATH entry into runtime authority', async () => {
    vi.stubEnv('PATH', '.');
    await expect(listInstalledCodexPlugins(directory, directory)).rejects.toThrow('inherited PATH');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('executes the real production launch path from Electron with an inert npm fixture', async () => {
    // No installed app or Codex service is started. Strip types from the production modules
    // into a private fixture, then exercise their real filesystem and child_process boundaries.
    const runtime = path.join(directory, 'runtime');
    await mkdir(runtime);
    await writeFile(path.join(runtime, 'package.json'), '{"type":"module"}');
    for (const name of ['env', 'ripgrep', 'exec', 'codex-plugin-runtime']) {
      const source = await readFile(new URL(`../src/main/${name}.ts`, import.meta.url), 'utf8');
      await writeFile(path.join(runtime, `${name}.js`), stripTypeScriptTypes(source));
    }
    await writeFile(script, `
      if (process.type === 'browser') require('electron').app.exit(42);
      else if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['plugin', 'list', '--json'])) process.exit(43);
      else process.stdout.write(JSON.stringify({ installed: [{
        pluginId: 'fixture@local-market', name: 'fixture', marketplaceName: 'local-market',
        version: '1.0.0', installed: true, enabled: true, source: { source: 'local' }
      }] }));
    `);
    const parent = path.join(runtime, 'parent.cjs');
    await writeFile(parent, `
      const path = require('node:path');
      const { app } = require('electron');
      const root = path.dirname(__dirname);
      app.setPath('userData', path.join(root, 'user-data'));
      app.disableHardwareAcceleration();
      app.whenReady().then(async () => {
        const { setEnvValue } = await import('./env.js');
        setEnvValue(process.env, 'PATH', root);
        const { listInstalledCodexPlugins } = await import('./codex-plugin-runtime.js');
        const plugins = await listInstalledCodexPlugins(root, root);
        if (plugins.length !== 1 || plugins[0].pluginId !== 'fixture@local-market') throw new Error('Wrong fixture snapshot');
        process.stdout.write('CODEX_NODE_LAUNCH_VERIFIED');
        app.exit(0);
      }).catch(error => { process.stderr.write(String(error)); app.exit(1); });
    `);
    const environment = normalizeEnvironment();
    deleteEnvValue(environment, 'ELECTRON_RUN_AS_NODE');
    const electron = createRequire(import.meta.url)('electron') as string;
    const result = await promisify(execFile)(electron, [parent], {
      env: environment, cwd: directory, windowsHide: true, timeout: 25_000, maxBuffer: 32_768
    });
    expect(result.stdout).toContain('CODEX_NODE_LAUNCH_VERIFIED');
  }, 35_000);
});

describe('Codex runtime environment', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'cos-plugin-env-'));
    const native = path.join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
    await writeFile(native, 'synthetic fixture; never executed', { mode: 0o755 });
    vi.stubEnv('PATH', directory);
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-must-not-reach-codex');
    vi.stubEnv('CLOUDFLARED_TUNNEL_TOKEN', 'tunnel-token-must-not-reach-codex');
    vi.stubEnv('COS_HARMLESS_SETTING', 'kept');
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new ChildProcess(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      queueMicrotask(() => { child.stdout.end('{"installed":[]}'); child.emit('close', 0); });
      return child;
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('never hands connector or tunnel secrets to whatever codex is first on PATH', async () => {
    expect(await listInstalledCodexPlugins(directory, directory)).toEqual([]);
    const [, , options] = vi.mocked(spawn).mock.calls[0] as [string, string[], SpawnOptions];
    expect(envValue(options.env!, 'OPENAI_API_KEY')).toBeUndefined();
    expect(envValue(options.env!, 'CLOUDFLARED_TUNNEL_TOKEN')).toBeUndefined();
    expect(envValue(options.env!, 'COS_HARMLESS_SETTING')).toBe('kept');
    expect(envValue(options.env!, 'CODEX_HOME')).toBe(directory);
  });
});
