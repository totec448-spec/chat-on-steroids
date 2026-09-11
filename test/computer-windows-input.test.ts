import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

describe.runIf(process.platform === 'win32')('compiled Windows input failure recovery', () => {
  it('releases partial input, distinguishes extended keys, and rechecks each coordinate action', () => {
    // Compile the real embedded C# and execute the real PowerShell dispatcher, replacing
    // only OS input/system-metric entry points. No input reaches any user window.
    const nativeSend = /\[DllImport\("user32.dll", SetLastError = true\)\]\s*static extern uint SendInput\(uint n, INPUT\[\] inputs, int size\);/;
    expect(HELPER_SCRIPT).toMatch(nativeSend);
    const script = HELPER_SCRIPT.slice(0, HELPER_SCRIPT.indexOf('while (($line = [Console]::In.ReadLine())'))
      .replace(nativeSend, `
  public static List<string> TestEvents = new List<string>();
  public static List<string> TestMoves = new List<string>();
  public static List<int> TestWheels = new List<int>();
  public static int TestFailCall, TestCalls;
  public static void TestReset(int failCall) { TestEvents.Clear(); TestMoves.Clear(); TestWheels.Clear(); TestCalls = 0; TestFailCall = failCall; }
  static uint SendInput(uint n, INPUT[] inputs, int size) {
    TestCalls++;
    foreach (INPUT i in inputs) TestEvents.Add(i.type == INPUT_MOUSE ? "mouse:" + i.u.mi.dwFlags : (i.u.ki.dwFlags & 4) != 0 ? "text:" + i.u.ki.wScan + ":" + i.u.ki.dwFlags : "key:" + i.u.ki.wVk + ":" + i.u.ki.dwFlags);
    foreach (INPUT i in inputs) if (i.type == INPUT_MOUSE && (i.u.mi.dwFlags & 1) != 0) TestMoves.Add(i.u.mi.dx + "," + i.u.mi.dy);
    foreach (INPUT i in inputs) if (i.type == INPUT_MOUSE && (i.u.mi.dwFlags & 0x1800) != 0) TestWheels.Add(unchecked((int)i.u.mi.mouseData));
    return TestCalls == TestFailCall ? n - 1 : n;
  }`)
      .replace('[DllImport("user32.dll")] static extern int GetSystemMetrics(int index);',
        'static int GetSystemMetrics(int index) { return index == 78 || index == 79 ? 1000 : 0; }');
    const assertions = String.raw`
[Clf]::TestReset(3)
try { [Clf]::Drag([int[]]@(1,2), [int[]]@(1,2), 'left'); throw 'drag unexpectedly succeeded' } catch {
  if ($_.Exception.Message -notmatch 'SendInput was blocked') { throw }
}
if ([Clf]::TestEvents[[Clf]::TestEvents.Count - 1] -ne 'mouse:4') { throw 'drag did not release after move failure' }
[Clf]::TestReset(0)
[Clf]::Drag([int[]]@(0,999), [int[]]@(0,999), 'left', 50)
if ([Clf]::TestMoves.Count -le 2 -or [Clf]::TestMoves[0] -ne '0,0' -or [Clf]::TestMoves[[Clf]::TestMoves.Count - 1] -ne '65535,65535' -or [Clf]::TestEvents[[Clf]::TestEvents.Count - 1] -ne 'mouse:4') { throw 'two-point drag did not interpolate to exact endpoint and release' }
[Clf]::TestReset(0)
[Clf]::Click(1,1,'left',3)
if (@([Clf]::TestEvents | Where-Object { $_ -eq 'mouse:2' }).Count -ne 3 -or @([Clf]::TestEvents | Where-Object { $_ -eq 'mouse:4' }).Count -ne 3) { throw 'triple click did not emit three pairs' }
[Clf]::TestReset(1)
try { [Clf]::Press([int[]]@(17,83)); throw 'chord unexpectedly succeeded' } catch {
  if ($_.Exception.Message -notmatch 'SendInput was blocked') { throw }
}
if (([Clf]::TestEvents -join ',') -ne 'key:17:0,key:83:0,key:83:2,key:17:2') { throw 'partial chord not released in reverse order' }
[Clf]::TestReset(2)
try { [Clf]::Click(1,1,'left',1); throw 'click unexpectedly succeeded' } catch {
  if ($_.Exception.Message -notmatch 'SendInput was blocked') { throw }
}
if ([Clf]::TestEvents[[Clf]::TestEvents.Count - 1] -ne 'mouse:4') { throw 'partial click not released' }
[Clf]::TestReset(0)
[Clf]::Press([int[]]@(17,65573))
if (([Clf]::TestEvents -join ',') -ne 'key:17:0,key:37:1,key:37:3,key:17:2') { throw 'extended key flags wrong' }
[Clf]::TestReset(0)
[Clf]::Scroll(1,1,2,-3,$true)
if (([Clf]::TestWheels -join ',') -ne '3,2') { throw 'raw wheel units changed' }
[Clf]::TestReset(0)
[Clf]::Scroll(1,1,2,-3)
if (([Clf]::TestWheels -join ',') -ne '360,240') { throw 'detent wheel units changed' }
[Clf]::TestReset(0)
try { [Clf]::Type("a\nb\r\nc".Replace('\r', [string][char]13).Replace('\n', [string][char]10)); throw 'multiline unexpectedly accepted' } catch {
  if ($_.Exception.Message -notmatch 'MULTILINE_REQUIRES_PASTE') { throw }
}
if ([Clf]::TestCalls -ne 0) { throw 'multiline rejection applied partial text' }
[Clf]::Type('ab')
if (([Clf]::TestEvents -join ',') -ne 'text:97:4,text:97:6,text:98:4,text:98:6') { throw 'single line Unicode typing failed' }
[Clf]::TestReset(1)
try { [Clf]::Type('ab'); throw 'partial text unexpectedly succeeded' } catch {
  if ($_.Exception.Message -notmatch 'SendInput was blocked') { throw }
}
if (([Clf]::TestEvents -join ',') -ne 'text:97:4,text:97:6,text:98:4,text:98:6,text:97:6,text:98:6') { throw 'partial Unicode packets not released' }
$script:checks = 0
$script:focuses = @()
function Assert-Focused([int64]$id) { $script:focuses += $id }
function Assert-CoordinateFrame($frame) {
  if ($script:focuses.Count -ne ($script:checks + 1)) { throw 'frame checked before targeted focus' }
  $script:checks++
  if ($script:checks -eq 2) { throw 'STALE_FRAME: changed after first action' }
}
[Clf]::TestReset(0)
$request = '{"op":"act","targetWindow":42,"frame":{"id":1},"actions":[{"type":"move","x":1,"y":1},{"type":"move","x":2,"y":2}]}' | ConvertFrom-Json
$result = Handle-Request $request
if ($result.ok -ne $false -or $result.completed_count -ne 1 -or $result.failed_index -ne 1 -or $result.error_code -ne 'STALE_FRAME' -or [Clf]::TestCalls -ne 1) {
  throw 'per-action stale frame did not preserve exact partial result'
}
if (($script:focuses -join ',') -ne '42,42') { throw 'target not focused before every physical action' }
[Clf]::TestReset(0)
$request = '{"op":"act","frame":{"id":1},"actions":[{"type":"move","x":1,"y":1},{"type":"keypress","keys":["not-a-key"]}]}' | ConvertFrom-Json
try { $null = Handle-Request $request; throw 'invalid key unexpectedly accepted' } catch {
  if ($_.Exception.Message -notmatch 'BAD_KEY') { throw }
}
if ([Clf]::TestCalls -ne 0) { throw 'invalid key applied earlier actions' }
$aliases = [CosWindowsKeys]::ResolveForLayout([string[]]@('Control_L','Control_R','Prior','KP_5'), [IntPtr]::Zero, [Func[char,IntPtr,int16]]{ param($char, $layout) return 0 })
if (($aliases -join ',') -ne '162,65699,65569,101') { throw ('keysym normalization failed: ' + ($aliases -join ',')) }
function Get-WindowRow([int64]$id) { return @{ id = $id; title = 'Owned fixture' } }
function Capture-Target($request, $forcedWindow) { return @{ width = 10; height = 10; captureMode = 'window' } }
function Find-UiElements($request) { throw 'UIA_FAILED: fixture provider unavailable' }
$request = '{"op":"snapshot","id":42,"includeScreenshot":true,"includeUi":true}' | ConvertFrom-Json
$result = Handle-Request $request
if ($result.ok -ne $true -or $result.width -ne 10 -or $result.uiUnavailable.code -ne 'UIA_FAILED') { throw 'accessibility failure discarded screenshot' }
Write-Output 'WINDOWS_INPUT_PROBE_OK'
`;
    const dir = mkdtempSync(path.join(tmpdir(), 'cos-input-test-'));
    try {
      const file = path.join(dir, 'probe.ps1');
      writeFileSync(file, script + assertions, 'utf8');
      const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
        encoding: 'utf8', timeout: 25_000, windowsHide: true
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain('WINDOWS_INPUT_PROBE_OK');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
