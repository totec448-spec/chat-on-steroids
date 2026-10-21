import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

function powerShellFixture(code: string): { status: number | null; stdout: string; stderr: string } {
  const folder = mkdtempSync(path.join(tmpdir(), 'cos-owner-identity-'));
  try {
    const file = path.join(folder, 'probe.ps1');
    writeFileSync(file, code, 'utf8');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

describe.runIf(process.platform === 'win32')('owner and secondary UIA mutation identity', () => {
  it('rejects recycled popup owner incarnation before any focus/input', () => {
    const owner = 'function Assert-InputOwner([int64]$target, $owner, $targetApp, $ownerApp) {' +
      HELPER_SCRIPT.split('function Assert-InputOwner([int64]$target, $owner, $targetApp, $ownerApp) {')[1]?.split('function Assert-PhysicalHit(')[0];
    expect(owner).toContain('owner process incarnation');
    const probe = String.raw`
$ErrorActionPreference='Stop'
$script:ExpectedInputWindow=43
$script:ExpectedInputStartTime='133000000000000303'
$script:ExpectedOwnerStartTime='133000000000000101'
$script:focuses=0
function Get-WindowRow([int64]$id) {
  if ($id -eq 43) { return [pscustomobject]@{ processStartTime='133000000000000303' } }
  if ($id -eq 42) { return [pscustomobject]@{ processStartTime='133000000000000202' } }
  return $null
}
` + owner + String.raw`
try { Assert-InputOwner 43 42 $null $null; throw 'UNEXPECTED_OWNER_ACCEPTED' } catch {
  if ($_.Exception.Message -notmatch '^STALE_WINDOW: owner') { throw }
}
if ($script:focuses -ne 0) { throw 'OWNER_FOCUSED_UNSAFELY' }
Write-Output 'RECYCLED_POPUP_OWNER_REJECTED'
`;
    const result = powerShellFixture(probe);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('RECYCLED_POPUP_OWNER_REJECTED');
  });

  it('rechecks incarnation after focusable provider getter, before semantic focus mutation', () => {
    const action = 'function Invoke-UiAction($element, [string]$action,' +
      HELPER_SCRIPT.split('function Invoke-UiAction($element, [string]$action,')[1]?.split('function Get-RequestedClickCount($request) {')[0];
    expect(action).toContain('Invoke-UiAction');
    const probe = String.raw`
$ErrorActionPreference='Stop'
$script:owner='A'
$script:mutations=0
function Write-UiaStage($marker) { }
function Assert-InputOwner($id,$owner,$targetApp,$ownerApp) { if ($script:owner -ne 'A') { throw 'STALE_WINDOW: owner replaced during provider property' } }
$current=[pscustomobject]@{}
$current | Add-Member -MemberType ScriptProperty -Name IsKeyboardFocusable -Value { $script:owner='B'; return $true }
$element=[pscustomobject]@{ Current=$current }
$element | Add-Member -MemberType ScriptMethod -Name SetFocus -Value { $script:mutations++ }
` + action + String.raw`
try { Invoke-UiAction $element 'focus' 77 $null $null $null; throw 'UNEXPECTED_SEMANTIC_FOCUS' } catch {
  if ($_.Exception.Message -notmatch '^STALE_WINDOW:') { throw }
}
if ($script:mutations -ne 0) { throw 'MUTATED_AFTER_PROVIDER_REPLACEMENT' }
Write-Output 'SECONDARY_UIA_PROVIDER_REPLACEMENT_REJECTED'
`;
    const result = powerShellFixture(probe);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('SECONDARY_UIA_PROVIDER_REPLACEMENT_REJECTED');
  });
});
