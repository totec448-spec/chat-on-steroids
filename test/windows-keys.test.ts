import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { WINDOWS_KEYS_SOURCE } from '../src/main/computer/windows-keys.js';

describe.runIf(process.platform === 'win32')('Windows native key resolution', () => {
  it('resolves target-layout punctuation and extended keypad keys before input', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cos-key-resolution-'));
    try {
      const file = path.join(directory, 'keys.ps1');
      await writeFile(file, `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
${WINDOWS_KEYS_SOURCE}
'@
$layout=[Func[char,IntPtr,int16]] { param($character,$keyboard)
  if ($character -eq '>') { if ($keyboard.ToInt64() -eq 1) { return 0x1BE }; return 0x1E2 }
  if ($character -eq '@') { return 0x651 }
  if ($character -eq '.') { return 0xBE }
  return -1
}
$us=[CosWindowsKeys]::ResolveForLayout(@('Control_L','greater'),[IntPtr]1,$layout)
$german=[CosWindowsKeys]::ResolveForLayout(@('Control_L','greater'),[IntPtr]2,$layout)
$altgr=[CosWindowsKeys]::ResolveForLayout(@('Control_R','at'),[IntPtr]2,$layout)
$numpad=[CosWindowsKeys]::ResolveForLayout(@('Numpad_Enter'),[IntPtr]1,$layout)
$enter=[CosWindowsKeys]::ResolveForLayout(@('Return'),[IntPtr]1,$layout)
$physical=[CosWindowsKeys]::ResolveForLayout(@('Shift_R','z'),[IntPtr]2,$layout)
$keys=[CosWindowsKeys]::ResolveForLayout(@('KP_0','F24'),[IntPtr]2,$layout)
$failures=0
foreach ($name in @('imaginary','☃')) {
  try { [CosWindowsKeys]::ResolveForLayout(@($name),[IntPtr]1,$layout); throw 'Accepted unsupported key' }
  catch { if ($_.Exception.GetBaseException().Message -notmatch '^BAD_KEY:') { throw }; $failures++ }
}
@{us=@($us);german=@($german);altgr=@($altgr);numpad=@($numpad);enter=@($enter);physical=@($physical);keys=@($keys);failures=$failures} | ConvertTo-Json -Compress
`, 'utf8');
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', file], {
        windowsHide: true, timeout: 15_000, maxBuffer: 32_768
      });
      const result = JSON.parse(stdout.trim());
      expect(result.us).toEqual([0xA2, 0x10, 0xBE]);
      expect(result.german).toEqual([0xA2, 0x10, 0xE2]);
      expect(result.altgr).toEqual([0x10000 | 0xA3, 0x12, 0x51]);
      expect(result.numpad).toEqual([0x10000 | 0x0D]);
      expect(result.enter).toEqual([0x0D]);
      expect(result.physical).toEqual([0xA1, 0x5A]);
      expect(result.keys).toEqual([0x60, 0x87]);
      expect(result.failures).toBe(2);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
