import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

describe('Windows snapshot and frame ownership boundaries', () => {
  it('re-reads native owner after capture and UI traversal before returning a snapshot', () => {
    const snapshot = HELPER_SCRIPT.split("'snapshot' {")[1]?.split("'focus' {")[0] ?? '';
    expect(snapshot).toMatch(/Get-WindowRow \$id[\s\S]*Capture-Target[\s\S]*Get-WindowRow \$id/);
    expect(snapshot.match(/Assert-SnapshotOwner \$window \(Get-WindowRow \$id\)/g)?.length).toBe(2);
    expect(HELPER_SCRIPT).toMatch(/function Assert-SnapshotOwner[\s\S]*STALE_WINDOW: process owner changed/);
  });
  it('checks process incarnation in coordinate frame before and after focus', () => {
    const frame = HELPER_SCRIPT.split('function Assert-CoordinateFrame($frame, [bool]$noFocus = $false) {')[1]?.split('function Handle-Request')[0] ?? '';
    expect(frame).toContain('processStartTime');
    expect(frame).toContain('STALE_FRAME');
    expect(frame).toContain('Assert-Focused');
  });
});



describe.runIf(process.platform === 'win32')('real PowerShell snapshot and frame owner revalidation', () => {
  function probe(source: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'cos-owner-boundary-'));
    try {
      const file = path.join(dir, 'probe.ps1');
      writeFileSync(file, source, 'utf8');
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
        { encoding: 'utf8', timeout: 20_000, windowsHide: true });
      expect(result.status, `${result.stderr} ${result.stdout}`).toBe(0);
      return result.stdout;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('rejects a replaced process from the real snapshot dispatcher after native capture', () => {
    const compare = 'function Assert-SnapshotOwner($original, $current) {' +
      HELPER_SCRIPT.split('function Assert-SnapshotOwner($original, $current) {')[1]!.split('function Handle-Request($request) {')[0]!;
    const nativeCase = "'snapshot' {" + HELPER_SCRIPT.split("'snapshot' {")[1]!.split("'focus' {")[0]!;
    const setup = String.raw`
$ErrorActionPreference='Stop'
$script:phase=0
function Get-WindowRow([int64]$id) {
  return @{ id=$id; app='fixture.exe'; processId=1001; processPath='fixture.exe'; processStartTime=$(if ($script:phase) {'133000000000000202'} else {'133000000000000101'}) }
}
function Capture-Target($request, $id) { $script:phase=1; return @{ captureMode='window' } }
`;
    const script = setup + compare + String.raw`
$request=@{ id=77; includeScreenshot=$true; includeUi=$false; includeRelated=$false }
$result=@{}
try { switch ('snapshot') { ` + nativeCase + String.raw` } ; throw 'MISSING_REJECTION' }
catch { if ($_.Exception.Message -notmatch 'STALE_WINDOW: process owner changed') { throw }; Write-Output 'OWNER_REPLACEMENT_REJECTED' }
`;
    expect(probe(script)).toContain('OWNER_REPLACEMENT_REJECTED');
  });

  it('rejects stale native coordinate frame before focus or any OS input', () => {
    const frame = 'function Assert-CoordinateFrame($frame, [bool]$noFocus = $false) {' +
      HELPER_SCRIPT.split('function Assert-CoordinateFrame($frame, [bool]$noFocus = $false) {')[1]!.split('${WINDOWS_APPS_SCRIPT}')[0]!;
    const setup = String.raw`
$ErrorActionPreference='Stop'
function Assert-InputOwner($target, $owner, $targetApp, $ownerApp) { }
function Get-WindowRow([int64]$id) { return @{ id=$id; state='foreground'; x=0; y=0; width=640; height=480; processStartTime='133000000000000202' } }
function Assert-Focused([int64]$id) { throw 'FOCUS_MUST_NOT_RUN' }
`;
    const script = setup + frame + String.raw`
$frame=@{ id=1; window=77; processStartTime='133000000000000101'; region=@{x=0;y=0;width=640;height=480}; windowGeometry=@{x=0;y=0;width=640;height=480} }
try { Assert-CoordinateFrame $frame; throw 'MISSING_REJECTION' }
catch { if ($_.Exception.Message -notmatch 'STALE_FRAME: target process incarnation changed') { throw }; Write-Output 'STALE_NATIVE_FRAME_REJECTED' }
`;
    expect(probe(script)).toContain('STALE_NATIVE_FRAME_REJECTED');
  });
});
