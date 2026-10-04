import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { WINDOWS_CAPTURE_BOOTSTRAP } from '../src/main/computer/windows-capture.js';

const execute = promisify(execFile);

describe.runIf(process.platform === 'win32')('Windows capture runtime', () => {
  it('compiles once, copies only validated frame content and rejects invalid geometry or a missing window', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cos-wgc-test-'));
    try {
      const script = path.join(directory, 'capture.ps1');
      await writeFile(script, `$ErrorActionPreference = 'Stop'
${WINDOWS_CAPTURE_BOOTSTRAP}
Initialize-WindowsCapture
$initialAssembly = [CosWindowsCapture].Assembly
Initialize-WindowsCapture
if ([CosWindowsCapture].Assembly -ne $initialAssembly) { throw 'Capture compiled twice' }
$flags = [System.Reflection.BindingFlags]'Static,NonPublic'
$validate = [CosWindowsCapture].GetMethod('ValidateContentSize', $flags)
$copy = [CosWindowsCapture].GetMethod('ContentBitmap', $flags)
if ($null -eq $validate -or $null -eq $copy) { throw 'Content-size validation and bounded row copy are missing' }
# These are the actual compiled production routines, not a TypeScript geometry mirror.
$null = $validate.Invoke($null, [object[]]@(4,3,2,2,2,2))
$null = $validate.Invoke($null, [object[]]@(2,2,2,2,2,2))
foreach ($case in @(@(1,2,2,2,2,2), @(4,3,2,2,3,2), @(4,3,2,2,1,2), @(4,3,2,2,2,1), @(0,3,2,2,2,2), @(40000,40000,2,2,2,2))) {
  $rejected = $false
  try { $null = $validate.Invoke($null, [object[]]$case) }
  catch {
    $rejected = $_.Exception.GetBaseException().Message -match '^(STALE_FRAME|CAPTURE_FAILED):'
    if (-not $rejected) { throw }
  }
  if (-not $rejected) { throw 'Invalid/clipped/stale content size was accepted' }
}
# Four valid pixels live at the top-left of a larger surface. Every unused byte is poison.
$pixels = [byte[]]::new(4*3*4)
for ($i=0; $i -lt $pixels.Length; $i++) { $pixels[$i] = 213 }
for ($y=0; $y -lt 2; $y++) { for ($x=0; $x -lt 2; $x++) {
  $offset = ($y*4+$x)*4
  $pixels[$offset] = 30+$x; $pixels[$offset+1] = 20+$y; $pixels[$offset+2] = 10+$x+$y; $pixels[$offset+3] = 255
} }
$copyArgs = [object[]]@($null,4,3,2,2)
$copyArgs[0] = $pixels.PSObject.BaseObject
$bitmap = $copy.Invoke($null, $copyArgs)
try {
  if ($bitmap.Width -ne 2 -or $bitmap.Height -ne 2) { throw 'Undefined surface capacity leaked into output dimensions' }
  for ($y=0; $y -lt 2; $y++) { for ($x=0; $x -lt 2; $x++) {
    $pixel = $bitmap.GetPixel($x,$y)
    if ($pixel.R -ne 10+$x+$y -or $pixel.G -ne 20+$y -or $pixel.B -ne 30+$x -or $pixel.A -ne 255) { throw 'Surface padding leaked into content pixels' }
  } }
} finally { $bitmap.Dispose() }
$rejected = $false
try { $copyArgs[0] = [byte[]]::new(3); $unexpected = $copy.Invoke($null, $copyArgs); $unexpected.Dispose() }
catch { $rejected = $_.Exception.GetBaseException().Message -match '^STALE_FRAME:'; if (-not $rejected) { throw } }
if (-not $rejected) { throw 'An incomplete pixel buffer was accepted' }
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
