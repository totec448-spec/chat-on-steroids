import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { checkLinuxDesktopVersion, linuxDesktopArgs, runLinuxDesktop } from '../src/main/computer/linux-agent-desktop.js';
import { MAX_LINUX_DESKTOP_REF_LENGTH, validLinuxDesktopRef } from '../src/main/computer/linux-desktop-ref.js';

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

describe('Linux desktop subprocess boundary', () => {
  it('uses a display target for screenshots and rejects invalid indices', () => {
    expect(linuxDesktopArgs({ kind: 'screenshot', display: 0 })).toEqual(['screenshot', '--screen', '0']);
    expect(() => linuxDesktopArgs({ kind: 'screenshot', display: -1 })).toThrow();
  });

  it('keeps text as a positional argument and rejects invalid references', () => {
    const value = '--headed; touch /tmp/example';
    expect(linuxDesktopArgs({ kind: 'setValue', session: 'session-1', ref: '@s123:e1', value }))
      .toEqual(['set-value', '--session', 'session-1', '--', '@s123:e1', value]);
    expect(() => linuxDesktopArgs({ kind: 'click', session: 'session-1', ref: '@e1' })).toThrow();
  });

  it('bounds accessibility refs before constructing subprocess arguments', () => {
    const maxRef = `@s${'a'.repeat(MAX_LINUX_DESKTOP_REF_LENGTH - 5)}:e1`;
    const tooLong = `${maxRef}0`;
    expect(maxRef.length).toBe(MAX_LINUX_DESKTOP_REF_LENGTH);
    expect(validLinuxDesktopRef(maxRef)).toBe(true);
    expect(validLinuxDesktopRef(tooLong)).toBe(false);
    expect(linuxDesktopArgs({ kind: 'click', session: 'session-1', ref: maxRef })).toContain(maxRef);
    expect(() => linuxDesktopArgs({ kind: 'click', session: 'session-1', ref: tooLong })).toThrow('Invalid accessibility reference');
  });

  // These fixtures are POSIX shell scripts. Win32 cannot execute a shebang;
  // the adapter remains Linux-only at the MCP registration boundary.
  it.skipIf(process.platform === 'win32')('retains backend delivery information even when the executable exits unsuccessfully', async () => {
    directory = await mkdtemp(join(tmpdir(), 'cos-linux-desktop-'));
    const binary = join(directory, 'backend');
    await writeFile(binary, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":false,"command":"click","error":{"code":"STALE_REF","disposition":{"delivery":"not_delivered","retry":"safe"}}}\'\nexit 1\n');
    await chmod(binary, 0o700);
    const result = await runLinuxDesktop({ kind: 'click', session: 'session-1', ref: '@s123:e1' }, binary);
    expect(result).toMatchObject({ ok: false, error: { code: 'STALE_REF', disposition: { retry: 'safe' } } });
  });

  it.skipIf(process.platform === 'win32')('accepts only the verified Linux backend version', async () => {
    directory = await mkdtemp(join(tmpdir(), 'cos-linux-desktop-'));
    const binary = join(directory, 'backend');
    await writeFile(binary, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"command":"version","data":{"os":"linux","version":"1.0.2"}}\'\n');
    await chmod(binary, 0o700);
    await expect(checkLinuxDesktopVersion(binary)).resolves.toBeUndefined();
    await writeFile(binary, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"command":"version","data":{"os":"linux","version":"1.1.0"}}\'\n');
    await expect(checkLinuxDesktopVersion(binary)).rejects.toThrow('Unsupported agent-desktop');
    await writeFile(binary, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"command":"status","data":{"os":"linux","version":"1.0.2"}}\'\n');
    await expect(checkLinuxDesktopVersion(binary)).rejects.toThrow('Unsupported agent-desktop');
  });
});
