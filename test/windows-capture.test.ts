import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { WINDOWS_CAPTURE_BOOTSTRAP } from '../src/main/computer/windows-capture.js';

const execute = promisify(execFile);

describe.runIf(process.platform === 'win32')('Windows capture runtime', () => {
  it('compiles against installed Windows metadata once and rejects a missing window', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cos-wgc-test-'));
    try {
      const script = path.join(directory, 'capture.ps1');
      await writeFile(script, `$ErrorActionPreference = 'Stop'
${WINDOWS_CAPTURE_BOOTSTRAP}
Initialize-WindowsCapture
$initialAssembly = [CosWindowsCapture].Assembly
Initialize-WindowsCapture
if ([CosWindowsCapture].Assembly -ne $initialAssembly) { throw 'Capture compiled twice' }
try {
  [CosWindowsCapture]::Capture(0, 320, 'unused.png')
  throw 'Missing window was accepted'
} catch {
  if ($_.Exception.ToString() -notmatch 'CAPTURE_FAILED: (target window is closed or minimized|Windows.Graphics.Capture is unavailable)') { throw }
}
Write-Output 'CAPTURE_RUNTIME_VERIFIED'
`, 'utf8');
      // Add-Type compiles C# in a cold PowerShell. Alone that takes seconds; under the full CI
      // suite on a Windows runner it has taken longer than 15 s, and the kill then read only as
      // "Command failed". Correctness is under test here, not speed.
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], {
        windowsHide: true,
        timeout: 90_000,
        maxBuffer: 32_768
      }).catch((error: NodeJS.ErrnoException & { killed?: boolean; signal?: string; stderr?: string }) => {
        throw new Error(`capture probe ${error.killed ? `was killed after the timeout (${error.signal})` : 'failed'}: ${error.stderr || error.message}`);
      });
      expect(stdout.trim()).toBe('CAPTURE_RUNTIME_VERIFIED');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 100_000);
});
