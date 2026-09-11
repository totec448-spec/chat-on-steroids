import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

describe.runIf(process.platform === 'win32')('Windows focus attachment ownership', () => {
  it('owns only successful attachments and verifies foreground after a single activation attempt', () => {
    // Compile the actual focus method with substituted native boundaries. This never
    // focuses a user window or synthesizes input, including the exception case.
    const method = HELPER_SCRIPT.slice(HELPER_SCRIPT.indexOf('public static bool Focus(long handle)'),
      HELPER_SCRIPT.indexOf('public static long ForegroundId()'));
    const source = `using System;
using System.Collections.Generic;
public static class FocusProbe {
  public static List<string> Calls = new List<string>();
  public static bool AttachAllowed = true, ActivationAllowed = true, ThrowActivation, Arrives;
  public static int FocusChecks;
  public static uint Fore = 2;
  public static void Reset() { Calls.Clear(); AttachAllowed=true; ActivationAllowed=true; ThrowActivation=false; Fore=2; Arrives=false; FocusChecks=0; }
  public static bool InputIsFocused(long h) { FocusChecks++; return Arrives && FocusChecks>2; }
  static IntPtr InputRoot(IntPtr h) { return h; }
  static bool IsWindow(IntPtr h) { return true; }
  static bool IsIconic(IntPtr h) { return false; }
  static bool ShowWindow(IntPtr h, int command) { return true; }
  static IntPtr GetForegroundWindow() { return new IntPtr(2); }
  static uint GetWindowThreadProcessId(IntPtr h, out uint pid) { pid=10; return Fore; }
  static uint GetCurrentThreadId() { return 1; }
  static bool AttachThreadInput(uint from, uint to, bool attach) {
    if(from!=1 || to!=2) throw new Exception("wrong thread pair");
    Calls.Add(attach ? "attach" : "detach"); return AttachAllowed;
  }
  static bool SetForegroundWindow(IntPtr h) {
    Calls.Add("activate"); if(ThrowActivation) throw new Exception("native activation failure");
    return ActivationAllowed;
  }
  ${method}
}`;
    const script = `Add-Type -TypeDefinition @'\n${source}\n'@
function Check($expected) { if (([FocusProbe]::Calls -join ',') -ne $expected) { throw "unexpected calls: $([FocusProbe]::Calls -join ',')" } }
[FocusProbe]::Reset()
if (-not [FocusProbe]::Focus(3)) { throw 'activation failed' }
Check 'attach,activate,detach'
[FocusProbe]::Reset()
[FocusProbe]::AttachAllowed=$false
if (-not [FocusProbe]::Focus(3)) { throw 'direct activation rejected due to failed attachment' }
Check 'attach,activate'
[FocusProbe]::Reset()
[FocusProbe]::ActivationAllowed=$false
if ([FocusProbe]::Focus(3)) { throw 'denied activation reported success' }
Check 'attach,activate,detach'
[FocusProbe]::Reset()
[FocusProbe]::ThrowActivation=$true
try { $null=[FocusProbe]::Focus(3); throw 'activation should throw' } catch { if ($_.Exception.Message -notmatch 'native activation failure') { throw } }
Check 'attach,activate,detach'
foreach ($foreground in @(0,1)) {
  [FocusProbe]::Reset(); [FocusProbe]::Fore=$foreground
  $null=[FocusProbe]::Focus(3)
  Check 'activate'
}
[FocusProbe]::Reset()
$null=[FocusProbe]::Focus(2)
Check ''
${HELPER_SCRIPT.slice(HELPER_SCRIPT.indexOf('function Try-Focus('), HELPER_SCRIPT.indexOf('function Assert-Focused(')).replaceAll('[Clf]', '[FocusProbe]')}
[FocusProbe]::Reset()
[FocusProbe]::ActivationAllowed=$false
[FocusProbe]::Arrives=$true
if (-not (Try-Focus 3)) { throw 'late actual foreground was rejected after false activation result' }
Check 'attach,activate,detach'
[FocusProbe]::Reset()
[FocusProbe]::ActivationAllowed=$false
if (Try-Focus 3) { throw 'persistent wrong foreground was accepted' }
Check 'attach,activate,detach'
'focus ownership passed'
`;
    const directory = mkdtempSync(path.join(tmpdir(), 'cos-focus-'));
    try {
      const file = path.join(directory, 'probe.ps1');
      writeFileSync(file, script);
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', file],
        { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('focus ownership passed');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
