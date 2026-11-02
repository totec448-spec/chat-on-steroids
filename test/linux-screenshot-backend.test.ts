import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkLinuxScreenshotVersion, linuxScreenshotArgs, runLinuxScreenshot } from '../src/main/computer/linux-screenshot-backend.js';
import { logInfo } from '../src/main/logger.js';

vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn() }));

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

describe('Linux screenshot backend is read only', () => {
  it('admits only version and an explicit display screenshot; never native input', () => {
    expect(linuxScreenshotArgs({ kind: 'version' })).toEqual(['version']);
    expect(linuxScreenshotArgs({ kind: 'screenshot', display: 0 })).toEqual(['screenshot', '--screen', '0']);
    expect(() => linuxScreenshotArgs({ kind: 'screenshot', display: -1 })).toThrow();
    expect(() => linuxScreenshotArgs({ kind: 'screenshot', display: 33 })).toThrow();
    expect(() => linuxScreenshotArgs({ kind: 'click' } as never)).toThrow();
  });

  it.skipIf(process.platform === 'win32')('requires the verified Linux agent-desktop 1.0.2', async () => {
    directory = await mkdtemp(join(tmpdir(), 'cos-linux-shot-'));
    const binary = join(directory, 'backend');
    await writeFile(binary, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"command":"version","data":{"os":"linux","version":"1.0.2"}}\'\n');
    await chmod(binary, 0o700);
    await expect(checkLinuxScreenshotVersion(binary)).resolves.toBeUndefined();
    await writeFile(binary, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"command":"version","data":{"os":"linux","version":"1.1.0"}}\'\n');
    await expect(checkLinuxScreenshotVersion(binary)).rejects.toThrow('Unsupported Linux screenshot backend');
  });

  it.skipIf(process.platform === 'win32')('keeps a backend consent refusal as a result, never retries or logs screen text', async () => {
    directory = await mkdtemp(join(tmpdir(), 'cos-linux-shot-'));
    const binary = join(directory, 'backend');
    await writeFile(binary, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":false,"command":"screenshot","error":{"code":"PERM_DENIED","message":"screen private"}}\'\n');
    await chmod(binary, 0o700);
    expect(await runLinuxScreenshot({ kind: 'screenshot', display: 0 }, binary))
      .toMatchObject({ ok: false, error: { code: 'PERM_DENIED' } });
  });

  it.skipIf(process.platform === 'win32')('rejects a backend envelope for a different requested command', async () => {
    vi.mocked(logInfo).mockClear();
    directory = await mkdtemp(join(tmpdir(), 'cos-linux-shot-'));
    const binary = join(directory, 'backend');
    await writeFile(binary, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"command":"version","data":{"secret":"private screen title"}}\'\n');
    await chmod(binary, 0o700);
    await expect(runLinuxScreenshot({ kind: 'screenshot', display: 0 }, binary))
      .rejects.toThrow('Linux screenshot backend returned an invalid response');
    await writeFile(binary, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"command":"screenshot","data":{"secret":"private screen title"}}\'\n');
    await expect(checkLinuxScreenshotVersion(binary))
      .rejects.toThrow('Linux screenshot backend returned an invalid response');
    expect(logInfo).toHaveBeenCalledTimes(2);
    for (const [message] of vi.mocked(logInfo).mock.calls) {
      expect(message).toBe('linux screenshot backend: refused because the response command did not match the requested command');
      expect(message).not.toContain('private screen title');
    }
  });
});
