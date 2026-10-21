import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

describe.runIf(process.platform === 'win32')('semantic UI completion after a self-removing control', () => {
  it('does not downgrade completed Invoke to failure when metadata vanishes afterward', () => {
    const action = 'function Act-UiElement($request) {' + HELPER_SCRIPT.split('function Act-UiElement($request) {')[1]?.split('function Find-UiElements($request) {')[0];
    expect(action).toContain('Act-UiElement');
    const harness = String.raw`
$ErrorActionPreference='Stop'
$script:UiActionNames=@('invoke')
$script:mutated=$false
$current=[pscustomobject]@{ IsEnabled=$true }
$current | Add-Member -MemberType ScriptProperty -Name Name -Value { if ($script:mutated) { throw 'ELEMENT_VANISHED_AFTER_INVOKE' }; return 'Close dialog' }
$script:element=[pscustomobject]@{ Current=$current }
function Resolve-UiElement($window,$snapshotId,$runtimeKey) { return $script:element }
function Assert-InputOwner($target,$owner,$targetApp,$ownerApp) { }
function Write-UiaStage($marker) { }
function Ui-RuntimeKey($element) { return 'native-before-1' }
function Invoke-UiAction($element,[string]$action) { $script:mutated=$true }
`;
    const script = harness + action + String.raw`
$result=Act-UiElement @{ id=77; snapshotId=1; runtimeKey='native-before-1'; action='invoke' }
if (!$script:mutated -or $result.route -cne 'uia' -or $result.name -cne 'Close dialog') { throw 'MISSING_COMPLETED_ACTION_RECEIPT' }
Write-Output 'POST_MUTATION_PROVIDER_REMOVAL_PRESERVES_COMPLETION'
`;
    const dir = mkdtempSync(path.join(tmpdir(), 'cos-uia-receipt-'));
    try {
      const file = path.join(dir, 'receipt.ps1');
      writeFileSync(file, script, 'utf8');
      const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      expect(res.status, `${res.stderr} ${res.stdout}`).toBe(0);
      expect(res.stdout).toContain('POST_MUTATION_PROVIDER_REMOVAL_PRESERVES_COMPLETION');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
