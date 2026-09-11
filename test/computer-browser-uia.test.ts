import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

describe.runIf(process.platform === 'win32')('Windows browser UI provider ownership', () => {
  it('selects the current browser provider, rejects old-tab refs and fails closed on missing or ambiguous roots', () => {
    // Execute the production selection/snapshot/resolution functions. Only the
    // UIA tree boundary is replaced; no user window is activated or modified.
    const functions = HELPER_SCRIPT.slice(HELPER_SCRIPT.indexOf('function Ui-RuntimeKey('), HELPER_SCRIPT.indexOf('$script:UiActionNames ='))
      .replaceAll('[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$id)', '(Get-TestRoot $id)')
      .replaceAll('[System.Windows.Automation.TreeWalker]::ControlViewWalker', '$script:walker');
    const script = String.raw`
$ErrorActionPreference='Stop'
function Node([int]$key,[string]$class) {
 $node=[pscustomobject]@{key=$key;Current=[pscustomobject]@{ClassName=$class;IsEnabled=$true;IsOffscreen=$false};parent=$null;children=@()}
 $node | Add-Member ScriptMethod GetRuntimeId { return @($this.key) }
 return $node
}
function Children($parent,$children) {
 $parent.children=@($children)
 foreach($child in $children){$child.parent=$parent}
}
$script:walker=[pscustomobject]@{visits=0}
$script:walker | Add-Member ScriptMethod GetFirstChild { param($node); $this.visits++; if($node.children.Count){return $node.children[0]}; return $null }
$script:walker | Add-Member ScriptMethod GetNextSibling {
 param($node); $this.visits++
 if($null -eq $node.parent){return $null}
 $siblings=$node.parent.children
 for($i=0;$i -lt $siblings.Count-1;$i++){if([object]::ReferenceEquals($siblings[$i],$node)){return $siblings[$i+1]}}
 return $null
}
$script:walker | Add-Member ScriptMethod GetParent { param($node); $this.visits++; return $node.parent }
function Get-TestRoot($id){return $script:root}
function Get-WindowRow($id){if($script:missingWindow){return $null}; return @{process=$script:processName}}
function Reject($action,[string]$pattern){
 try {& $action; throw "expected rejection matching $pattern"} catch {if($_.Exception.Message -like 'expected rejection*' -or $_.Exception.Message -notmatch $pattern){throw}}
}
` + functions + String.raw`
$script:processName='chrome'
$script:root=Node 1 'Chrome_WidgetWin_1'
$oldDocument=Node 2 'Document'
$browser=Node 3 'BrowserRootView'
$currentDocument=Node 4 'Document'
$button=Node 5 'Button'
Children $script:root @($oldDocument,$browser)
Children $browser @($currentDocument)
Children $currentDocument @($button)
if(-not [object]::ReferenceEquals((Get-UiRoot 1),$browser)){throw 'old visible legacy document won browser selection'}
$snapshot=Remember-UiSnapshot 1 (Get-UiRoot 1) @($button)
if(-not [object]::ReferenceEquals((Resolve-UiElement 1 $snapshot '5'),$button)){throw 'current element was rejected'}
# The old provider remains live after a tab switch and its flags still look usable.
Children $oldDocument @($currentDocument)
Children $browser @((Node 6 'Document'))
Reject {Resolve-UiElement 1 $snapshot '5'} 'STALE_UI_REF'
# Replacing the BrowserRootView itself also retires every ref under the old root.
Children $script:root @((Node 7 'BrowserRootView'))
Reject {Resolve-UiElement 1 $snapshot '5'} 'STALE_UI_SNAPSHOT'
Children $script:root @($oldDocument)
Reject {Get-UiRoot 1} 'UIA_FAILED'
Children $script:root @($browser,(Node 8 'BrowserRootView'))
Reject {Get-UiRoot 1} 'multiple browser UI roots'
Children $script:root (@($browser) + @(1..128 | ForEach-Object {Node (100+$_) 'Document'}))
$script:walker.visits=0
Reject {Get-UiRoot 1} 'UIA_FAILED'
if($script:walker.visits -gt 129){throw 'root selection exceeded its traversal bound'}
$script:missingWindow=$true
Reject {Get-UiRoot 1} 'disappeared'
$script:missingWindow=$false
# Chromium-based desktop apps and native dialogs keep their own root, not a
# browser provider inferred from their implementation's window class alone.
$script:processName='fixture'
if(-not [object]::ReferenceEquals((Get-UiRoot 1),$script:root)){throw 'non-browser root changed'}
$script:processName='chrome'; $script:root.Current.ClassName='#32770'
if(-not [object]::ReferenceEquals((Get-UiRoot 1),$script:root)){throw 'native dialog root changed'}
'BROWSER_UI_OWNER_OK'
`;
    const directory = mkdtempSync(path.join(tmpdir(), 'cos-browser-uia-'));
    try {
      const file = path.join(directory, 'probe.ps1');
      writeFileSync(file, script);
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', file], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain('BROWSER_UI_OWNER_OK');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
