import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

describe.runIf(process.platform === 'win32')('native physical hit receiver validation', () => {
  it('accepts the target\'s own popups and menus but rejects every other receiver', () => {
    // Compile the production ownership and hit-test methods against a deterministic
    // window table; no windows, focus or OS input are touched. WindowFromPoint returns
    // the handle named by x, and the foreground thread's capture is [Clf]::Capture.
    const methods = '  static bool OwnedBy(' +
      HELPER_SCRIPT.split('  static bool OwnedBy(')[1]?.split('  public static bool InputIsFocused(')[0];
    expect(methods).toContain('public static bool HitTargetsWindow(long handle, int x, int y)');
    const fixture = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class Clf {
  public struct POINT { public int X, Y; }
  public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  struct GUITHREADINFO {
    public uint cbSize, flags;
    public IntPtr active, focus, capture, menuOwner, moveSize, caret;
    public RECT caretRect;
  }
  const long NOACTIVATE = 0x08000000, FRAME = 0x00CF0000, CHILD = 0x44000000, POPUP = 0x80800000, DIALOG = 0x80C80000;
  // handle -> GA_ROOT, GW_OWNER, style, extended style, process, GUI thread. Popup
  // shapes follow a live Windows 11 probe of real menus, dropdown lists and autocomplete.
  static Dictionary<long, long[]> W = new Dictionary<long, long[]>();
  static Dictionary<long, string> Class = new Dictionary<long, string>();
  public static long Capture = 0;
  public static long MenuOwner = 100;
  static void Add(long h, long root, long owner, long style, long ex, string cls, long pid, long tid) {
    W[h] = new long[] { root, owner, style, ex, pid, tid }; Class[h] = cls;
  }
  static Clf() {
    Add(100, 100, 0, FRAME, 0, "AppWindow", 10, 1);             // the target A
    Add(110, 100, 0, CHILD, 0, "Button", 10, 1);                // a child control of A
    Add(120, 120, 0, FRAME, 0, "AppWindow", 10, 1);             // another window of A's thread
    Add(201, 201, 100, POPUP, NOACTIVATE, "Popup", 10, 1);      // A's own no-activate dropdown
    Add(202, 202, 0, POPUP, 0x189, "#32768", 10, 1);            // ownerless context menu of A's thread
    Add(203, 203, 100, POPUP, 0x189, "#32768", 10, 1);          // context menu owned by A
    Add(204, 204, 100, POPUP, NOACTIVATE, "Popup", 10, 1);      // a sibling of 201
    Add(205, 205, 0, CHILD, 0x88, "ComboLBox", 10, 1);          // dropdown list: a desktop child
    Add(206, 206, 0, POPUP, 0x8C, "Auto-Suggest Dropdown", 10, 1); // unowned autocomplete popup
    Add(207, 207, 100, POPUP, 0x10008, "ToolStripDropDown", 10, 1); // toolkit menu owned by A
    Add(208, 208, 120, POPUP, 0x10008, "ToolStripDropDown", 10, 1); // menu of A's sibling window
    Add(209, 209, 100, POPUP, 0, "FramelessOwned", 10, 1);      // activatable borderless owned app window
    Add(301, 301, 0, POPUP, NOACTIVATE, "Overlay", 30, 3);      // another app's overlay
    Add(302, 302, 100, POPUP, NOACTIVATE, "Overlay", 30, 3);    // another app's overlay owned by A
    Add(303, 303, 100, DIALOG, 0, "#32770", 10, 1);             // A's activatable owned dialog
    Add(304, 304, 0, POPUP, 0x189, "#32768", 10, 2);            // ownerless menu of another thread
    Add(305, 305, 0, POPUP, 0x189, "#32768", 30, 3);            // another app's ownerless menu
    Add(306, 100, 0, CHILD, 0, "ForeignChild", 30, 3);          // foreign embedded child under A's GA_ROOT
    Add(400, 400, 0, FRAME, 0, "HostFrame", 40, 4);              // unrelated new top-level host
    Add(130, 400, 0, CHILD, 0, "AppWindow", 10, 1);             // A target reparented into foreign host
    Add(401, 400, 0, CHILD, 0, "HostChild", 40, 4);             // foreign host's own receiver
  }
  static IntPtr WindowFromPoint(POINT p) { return new IntPtr(p.X); }
  static bool IsWindow(IntPtr h) { return W.ContainsKey(h.ToInt64()); }
  static bool IsWindowVisible(IntPtr h) { return IsWindow(h); }
  static bool IsIconic(IntPtr h) { return false; }
  static IntPtr GetAncestor(IntPtr h, uint kind) {
    long[] w;
    if (!W.TryGetValue(h.ToInt64(), out w)) return IntPtr.Zero;
    long root = w[0];
    if (kind == 3) while (W[root][1] != 0) root = W[root][1]; // GA_ROOTOWNER
    return new IntPtr(root);
  }
  static IntPtr GetWindow(IntPtr h, uint command) {
    long[] w;
    return command == 4 && W.TryGetValue(h.ToInt64(), out w) ? new IntPtr(w[1]) : IntPtr.Zero;
  }
  static int GetWindowLong(IntPtr h, int index) {
    long[] w;
    if (!W.TryGetValue(h.ToInt64(), out w)) return 0;
    return index == -16 ? unchecked((int)w[2]) : index == -20 ? unchecked((int)w[3]) : 0;
  }
  static int GetClassNameW(IntPtr h, StringBuilder value, int count) {
    string name;
    if (!Class.TryGetValue(h.ToInt64(), out name)) return 0;
    value.Append(name); return name.Length;
  }
  static uint GetWindowThreadProcessId(IntPtr h, out uint pid) {
    long[] w;
    if (!W.TryGetValue(h.ToInt64(), out w)) { pid = 0; return 0; }
    pid = (uint)w[4]; return (uint)w[5];
  }
  static bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info) {
    if (thread == 0) thread = 1; // A's thread is the foreground thread
    info.menuOwner = thread == 1 ? new IntPtr(MenuOwner) : thread == 3 ? new IntPtr(302) : IntPtr.Zero;
    info.capture = thread == 1 ? new IntPtr(Capture) : IntPtr.Zero;
    return true;
  }
` + methods + String.raw`
}
"@
$failures = @()
function Expect-Hit([long]$target, [long]$hit, [bool]$allowed, [string]$name) {
  if ([Clf]::HitTargetsWindow($target, [int]$hit, 0) -ne $allowed) { $script:failures += $name }
}
Expect-Hit 100 100 $true 'TARGET_REJECTED'
Expect-Hit 100 110 $true 'CHILD_CONTROL_REJECTED'
Expect-Hit 100 201 $true 'OWNED_NOACTIVATE_POPUP_REJECTED'
Expect-Hit 100 202 $true 'OWNERLESS_THREAD_MENU_REJECTED'
Expect-Hit 100 203 $true 'OWNED_MENU_REJECTED'
Expect-Hit 100 205 $true 'COMBOBOX_LIST_REJECTED'
Expect-Hit 100 206 $true 'AUTOCOMPLETE_REJECTED'
Expect-Hit 100 207 $true 'OWNED_TOOLKIT_MENU_REJECTED'
Expect-Hit 201 201 $true 'POPUP_FRAME_SELF_REJECTED'
Expect-Hit 202 202 $true 'MENU_FRAME_SELF_REJECTED'
Expect-Hit 100 301 $false 'FOREIGN_OVERLAY_ACCEPTED'
Expect-Hit 100 302 $false 'FOREIGN_PROCESS_OWNED_OVERLAY_ACCEPTED'
Expect-Hit 100 303 $false 'ACTIVATABLE_OWNED_DIALOG_ACCEPTED'
Expect-Hit 201 100 $false 'POPUP_FRAME_HIT_OWNER_ACCEPTED'
Expect-Hit 201 204 $false 'POPUP_FRAME_HIT_SIBLING_ACCEPTED'
Expect-Hit 100 208 $false 'OTHER_WINDOW_MENU_ACCEPTED'
Expect-Hit 100 209 $false 'ACTIVATABLE_FRAMELESS_OWNED_ACCEPTED'
Expect-Hit 100 304 $false 'OTHER_THREAD_MENU_ACCEPTED'
Expect-Hit 100 305 $false 'FOREIGN_MENU_ACCEPTED'
Expect-Hit 100 306 $false 'FOREIGN_CHILD_ACCEPTED'
Expect-Hit 130 400 $false 'REPARENTED_TARGET_FOREIGN_ROOT_ACCEPTED'
Expect-Hit 130 401 $false 'REPARENTED_TARGET_FOREIGN_CHILD_ACCEPTED'
Expect-Hit 130 130 $false 'REPARENTED_TARGET_SELF_ACCEPTED'
Expect-Hit 100 0 $false 'NULL_HIT_ACCEPTED'
# A sibling window on the SAME GUI thread can open an ownerless menu; the GUI
# thread by itself is insufficient evidence that this popup belongs to A.
[Clf]::MenuOwner = 120; Expect-Hit 100 202 $false 'SIBLING_OWNERLESS_MENU_ACCEPTED'
[Clf]::MenuOwner = 100; Expect-Hit 100 202 $true 'OWN_OWNERLESS_MENU_REJECTED_AFTER_SIBLING'
# Mouse capture on the foreground thread overrides WindowFromPoint.
[Clf]::Capture = 301; Expect-Hit 100 100 $false 'FOREIGN_CAPTURE_ACCEPTED'
[Clf]::Capture = 306; Expect-Hit 100 100 $false 'FOREIGN_CHILD_CAPTURE_ACCEPTED'
[Clf]::Capture = 110; Expect-Hit 100 100 $true 'TARGET_CAPTURE_REJECTED'
[Clf]::Capture = 205; Expect-Hit 100 205 $true 'DROPPED_LIST_CAPTURE_REJECTED'
[Clf]::Capture = 0
if ($failures.Count) { throw ('HIT_MATRIX_FAILED: ' + ($failures -join ',')) }
Write-Output 'OWNED_POPUP_ALLOWED_FOREIGN_OVERLAY_DENIED'
`;
    const dir = mkdtempSync(path.join(tmpdir(), 'cos-owner-hit-'));
    try {
      const script = path.join(dir, 'owner-hit.ps1');
      writeFileSync(script, fixture, 'utf8');
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        encoding: 'utf8', windowsHide: true, timeout: 25_000
      });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain('OWNED_POPUP_ALLOWED_FOREIGN_OVERLAY_DENIED');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rechecks the physical receiver after movement and before every click, wheel or drag down', () => {
    const source = HELPER_SCRIPT.split('  public static void Click(int x, int y, string button, int times, long target) {')[1]?.split('  static INPUT Key(')[0] ?? '';
    expect(source).toMatch(/Move\(x, y\);[\s\S]*?GuardPointerReceiver\(target, x, y\);[\s\S]*?Send\(batch\.ToArray\(\)\)/);
    expect(source).toMatch(/public static void Scroll\([\s\S]*?Move\(x, y\);[\s\S]*?GuardPointerReceiver\(target, x, y\);[\s\S]*?Send\(batch\.ToArray\(\)\)/);
    expect(source).toMatch(/Move\(xs\[0\], ys\[0\]\);[\s\S]*?GuardPointerReceiver\(target, xs\[0\], ys\[0\]\);[\s\S]*?Mouse\(down/);
    expect(HELPER_SCRIPT).toContain('[Clf]::Click([int]$a.x, [int]$a.y, $a.button, (Get-RequestedClickCount $a), $actionTarget, $postMove)');
    expect(HELPER_SCRIPT).toContain('[Clf]::Scroll([int]$a.x, [int]$a.y, [int]$a.scroll_x, [int]$a.scroll_y, [bool]$a.rawWheel, $actionTarget, $postMove)');
  });

  it('rejects an overlay before physical indexed-click sends any OS input', () => {
    const hit = 'function Assert-PhysicalHit([int64]$id, [int]$x, [int]$y) {' +
      HELPER_SCRIPT.split('function Assert-PhysicalHit([int64]$id, [int]$x, [int]$y) {')[1]?.split('function Assert-CoordinateFrame(')[0];
    const action = 'function Act-UiElement($request) {' + HELPER_SCRIPT.split('function Act-UiElement($request) {')[1]?.split('function Find-UiElements($request) {')[0];
    expect(hit).toContain('HitTargetsWindow');
    const source = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
public static class Clf {
  public static int Clicks=0;
  public static bool TestHitAllowed = false;
  public static bool InNativeCallback = false;
  public static bool InputIsFocused(long id) { return true; }
  public static bool HitTargetsWindow(long id, int x, int y) { return TestHitAllowed; }
  public static void Click(int x, int y, string button, int times, long target, System.Action afterMove) {
    InNativeCallback = true;
    afterMove();
    Clicks++;
  }
}
"@
$script:UiActionNames=@('invoke')
$current=[pscustomobject]@{ IsEnabled=$true; Name='Blocked'; BoundingRectangle=[pscustomobject]@{ X=10; Y=10; Width=10; Height=10 } }
$script:element=[pscustomobject]@{ Current=$current }
function Resolve-UiElement($window,$snapshotId,$runtimeKey) { return $script:element }
function Assert-InputOwner($target,$owner,$targetApp,$ownerApp) {
  if ([Clf]::InNativeCallback) { throw 'STALE_WINDOW: owner changed after cursor movement' }
}
function Assert-Focused($id) { }
function Write-UiaStage($marker) { }
function Get-RequestedClickCount($request) { return 1 }
` + hit + action + String.raw`
try { $null=Act-UiElement @{ id=77; snapshotId=1; runtimeKey='occluded'; action='click'; button='right'; count=1 }; throw 'UNEXPECTED_CLICK' } catch {
  if ($_.Exception.Message -notmatch '^OCCLUDED_TARGET:') { throw }
}
if ([Clf]::Clicks -ne 0) { throw 'OCCLUDED_PIXEL_RECEIVED_SENDINPUT' }
[Clf]::TestHitAllowed = $true
try { $null=Act-UiElement @{ id=77; snapshotId=1; runtimeKey='replaced'; action='click'; button='right'; count=1 }; throw 'UNEXPECTED_POSTMOVE_CLICK' } catch {
  if ($_.Exception.GetBaseException().Message -notmatch '^STALE_WINDOW:') { throw }
}
if ([Clf]::Clicks -ne 0 -or -not [Clf]::InNativeCallback) { throw 'POSTMOVE_OWNER_SWAP_WAS_ACCEPTED' }
Write-Output 'OCCLUSION_FAILS_CLOSED_BEFORE_POINTER_DOWN'
`;
    const dir = mkdtempSync(path.join(tmpdir(), 'cos-hit-guard-'));
    try {
      const script = path.join(dir, 'occlusion.ps1');
      writeFileSync(script, source, 'utf8');
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain('OCCLUSION_FAILS_CLOSED_BEFORE_POINTER_DOWN');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('preserves the native uncertainty code through the standalone UI action transport catch', () => {
    expect(HELPER_SCRIPT).toContain("'act_ui' {");
    const loopStart = HELPER_SCRIPT.indexOf('while (($line = [Console]::In.ReadLine()) -ne $null) {');
    expect(loopStart).toBeGreaterThan(0);
    const protocolLoop = HELPER_SCRIPT.slice(loopStart);
    const source = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
public static class Clf {
  public static void ThrowUncertain() { throw new System.InvalidOperationException("INPUT_EFFECT_UNCONFIRMED: synthetic accepted native down"); }
}
"@
function Handle-Request($request) { [Clf]::ThrowUncertain(); return @{ ok = $true } }
` + protocolLoop;
    const dir = mkdtempSync(path.join(tmpdir(), 'cos-actui-error-'));
    try {
      const script = path.join(dir, 'actui-error.ps1');
      writeFileSync(script, source, 'utf8');
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        input: '{"op":"act_ui"}\n', encoding: 'utf8', windowsHide: true, timeout: 20_000
      });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({ ok: false, error_code: 'INPUT_EFFECT_UNCONFIRMED' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
