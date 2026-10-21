import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

describe.runIf(process.platform === 'win32')('native indexed-click fallback process ownership', () => {
  it('does not focus a replacement HWND owner after UIA metadata access', () => {
    const action = 'function Act-UiElement($request) {' + HELPER_SCRIPT.split('function Act-UiElement($request) {')[1]?.split('function Find-UiElements($request) {')[0];
    expect(action).toContain('Act-UiElement');
    const harness = String.raw`
$ErrorActionPreference='Stop'
$script:UiActionNames=@('invoke')
$script:processStart='A'
$script:focused=@()
$script:clicked=0
$current=[pscustomobject]@{ IsEnabled=$true; BoundingRectangle=[pscustomobject]@{ X=1; Y=1; Width=10; Height=10 } }
$current | Add-Member -MemberType ScriptProperty -Name Name -Value { $script:processStart='B'; return 'Changed owner' }
$script:element=[pscustomobject]@{ Current=$current }
function Resolve-UiElement($window,$snapshotId,$runtimeKey) { return $script:element }
function Assert-InputOwner($target,$owner,$targetApp,$ownerApp) { if ($script:processStart -ne 'A') { throw 'STALE_WINDOW: process incarnation changed' } }
function Assert-Focused([int64]$id) { $script:focused += $id }
function Write-UiaStage($marker) { }
function Get-RequestedClickCount($request) { return 1 }
`;
    const script = harness + action + String.raw`
try { $null=Act-UiElement @{ id=77; snapshotId=1; runtimeKey='before-1'; action='click'; button='right'; count=1 }; throw 'UNEXPECTED_SUCCESS' } catch {
  if ($_.Exception.Message -notmatch 'STALE_WINDOW') { throw }
}
if ($script:focused.Count -ne 0 -or $script:clicked -ne 0) { throw 'STALE_OWNER_WAS_FOCUSED_BEFORE_VALIDATION' }
Write-Output 'REPLACEMENT_AFTER_UIA_RESOLUTION_BLOCKED_BEFORE_FOCUS'
`;
    const dir = mkdtempSync(path.join(tmpdir(), 'cos-uia-focus-'));
    try {
      const file = path.join(dir, 'focus.ps1');
      writeFileSync(file, script, 'utf8');
      const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
      expect(res.status, `${res.stderr} ${res.stdout}`).toBe(0);
      expect(res.stdout).toContain('REPLACEMENT_AFTER_UIA_RESOLUTION_BLOCKED_BEFORE_FOCUS');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
