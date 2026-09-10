import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { WINDOWS_APPS_SCRIPT } from '../src/main/computer/windows-apps.js';

const execute = promisify(execFile);

async function run(script: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'cos-app-catalog-test-'));
  try {
    const file = path.join(directory, 'test.ps1');
    await writeFile(file, `$ErrorActionPreference='Stop'\nfunction Get-WindowRows { return @() }\n${WINDOWS_APPS_SCRIPT}\n${script}`, 'utf8');
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', file], {
      windowsHide: true, timeout: 15_000, maxBuffer: 32_768
    });
    return stdout.trim();
  } finally { await rm(directory, { recursive: true, force: true }); }
}

describe.runIf(process.platform === 'win32')('Windows installed apps', () => {
  it('returns a bounded real catalog and includes empty windows when none were observed', async () => {
    const result = JSON.parse(await run(`
$result=Get-WindowsApps @{limit=2}
@{count=$result.apps.Count;total=$result.total;truncated=$result.truncated;valid=(@($result.apps | Where-Object { !$_.id -or !$_.displayName -or !$_.ContainsKey('windows') -or $_.windows.Count -ne 0 -or $_.isRunning }).Count -eq 0)} | ConvertTo-Json -Compress
`));
    expect(result.valid).toBe(true);
    expect(result.count).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(result.total > result.count);
    const complete = JSON.parse(await run('$result=Get-WindowsApps @{}; @{count=$result.apps.Count;total=$result.total;truncated=$result.truncated} | ConvertTo-Json -Compress'));
    expect(complete.count).toBe(complete.total);
    expect(complete.truncated).toBe(false);
  });

  it('launches only an exact current item and rejects unknown or duplicate IDs before invocation', async () => {
    expect(await run(`
class AppFixtureItem {
  [string]$Path; [string]$Name; [bool]$IsFolder
  static [int]$Opened=0
  AppFixtureItem([string]$id,[string]$name,[bool]$folder) { $this.Path=$id; $this.Name=$name; $this.IsFolder=$folder }
  [void]InvokeVerb([string]$verb) { if ($verb -cne 'open') { throw 'Wrong verb' }; [AppFixtureItem]::Opened++ }
}
class AppFixtureItems {
  [object[]]$Values; [int]$Count
  AppFixtureItems([object[]]$values) { $this.Values=$values; $this.Count=$values.Count }
  [object]Item([int]$index) { return $this.Values[$index] }
}
class AppFixtureFolder {
  [AppFixtureItems]$Collection
  AppFixtureFolder([object[]]$values) { $this.Collection=[AppFixtureItems]::new($values) }
  [object]Items() { return $this.Collection }
}
function New-FixtureShell([object[]]$values) {
  $result=[pscustomobject]@{Folder=[AppFixtureFolder]::new($values)}
  $result | Add-Member -MemberType ScriptMethod -Name NameSpace -Value { param([string]$name) if ($name -cne 'shell:AppsFolder') { throw 'Wrong namespace' }; return $this.Folder }
  return $result
}
$script:fixture=New-FixtureShell @([AppFixtureItem]::new('calculator.id','Calculator',$false),[AppFixtureItem]::new('folder.id','Folder',$true))
function New-Object { param([string]$TypeName,[string]$ComObject)
  if ($ComObject) { if ($ComObject -cne 'Shell.Application') { throw 'Wrong COM class' }; return $script:fixture }
  return Microsoft.PowerShell.Utility\\New-Object -TypeName $TypeName
}
$listed=Get-WindowsApps @{match='CALC';limit=1}
if ($listed.total -ne 1 -or $listed.apps[0].id -cne 'calculator.id') { throw 'Incorrect filtered catalog' }
function Get-WindowRows { return @(@{id=11;app='calculator.id';process='Calculator'},@{id=12;app='c:\\different.exe';process='Calculator'}) }
$grouped=Get-WindowsApps @{match='CALC';limit=10}
if ($grouped.apps.Count -ne 2) { throw 'A same-name process was incorrectly joined' }
foreach ($row in $grouped.apps) {
  if ($row.windows.Count -ne 1 -or $row.windows[0].app -cne $row.id -or !$row.isRunning) { throw 'Window app identity was not preserved' }
}
$opened=Launch-WindowsApp @{app='calculator.id'}
if ($opened.status -cne 'launch_requested' -or $opened.windowConfirmed -ne $false -or [AppFixtureItem]::Opened -ne 1) { throw 'Wrong launch acknowledgement' }
foreach ($invalid in @('CALCULATOR.ID','calculator.id; command','folder.id')) {
  try { Launch-WindowsApp @{app=$invalid}; throw 'Accepted an invalid app' } catch { if ($_.Exception.Message -notmatch '^APP_NOT_FOUND:') { throw } }
}
$script:fixture=New-FixtureShell @([AppFixtureItem]::new('duplicate','One',$false),[AppFixtureItem]::new('duplicate','Two',$false))
try { Launch-WindowsApp @{app='duplicate'}; throw 'Accepted duplicate' } catch { if ($_.Exception.Message -notmatch '^APP_ID_AMBIGUOUS:') { throw } }
if ([AppFixtureItem]::Opened -ne 1) { throw 'An invalid launch invoked a shell verb' }
Write-Output 'APP_CATALOG_VERIFIED'
`)).toBe('APP_CATALOG_VERIFIED');
  });

  it('resolves and launches an owned executable by path or PATH basename without arguments', async () => {
    expect(await run(String.raw`
$executable=Join-Path $PSScriptRoot 'cos-owned-app.exe'
Add-Type -TypeDefinition 'public static class OwnedApp { public static void Main(string[] args) { System.IO.File.WriteAllText(System.IO.Path.Combine(System.AppDomain.CurrentDomain.BaseDirectory,"launched.txt"), args.Length.ToString()); } }' -OutputAssembly $executable -OutputType ConsoleApplication
if ((Resolve-AppExecutable $executable) -cne $executable) { throw 'Explicit path did not resolve' }
$env:PATH=$PSScriptRoot+';'+$env:PATH
if ((Resolve-AppExecutable 'cos-owned-app.exe') -cne $executable) { throw 'PATH executable did not resolve' }
foreach ($invalid in @('cos-owned-app.exe --flag','cos-owned-app.exe; command','.\cos-owned-app.exe','https://example.com/app.exe')) {
  if ($null -ne (Resolve-AppExecutable $invalid)) { throw 'Accepted command or URI' }
}
function New-Object { param([string]$TypeName,[string]$ComObject)
  if ($ComObject) { throw 'APP_CATALOG_UNAVAILABLE: fixture has no Shell catalog' }
  return Microsoft.PowerShell.Utility\New-Object -TypeName $TypeName
}
$result=Launch-WindowsApp @{app=$executable}
if ($result.status -ne 'launch_requested' -or $result.windowConfirmed -ne $false -or !$result.processId) { throw 'Wrong executable launch result' }
$marker=Join-Path $PSScriptRoot 'launched.txt'
for ($attempt=0;$attempt -lt 100 -and !(Test-Path -LiteralPath $marker);$attempt++) { Start-Sleep -Milliseconds 20 }
if (!(Test-Path -LiteralPath $marker) -or [IO.File]::ReadAllText($marker) -ne '0') { throw 'Owned executable did not launch with exactly zero arguments' }
$result=Launch-WindowsApp @{app='cos-owned-app.exe'}
if ($result.status -ne 'launch_requested' -or $result.windowConfirmed -ne $false -or !$result.processId) { throw 'PATH launch depended on unavailable app catalog' }
$launched=Get-Process -Id $result.processId -ErrorAction SilentlyContinue
if ($null -ne $launched) { if (!$launched.WaitForExit(3000)) { throw 'Owned PATH executable failed to finish' }; $launched.Dispose() }
Write-Output 'APP_EXECUTABLE_VERIFIED'
`)).toBe('APP_EXECUTABLE_VERIFIED');
  });
});
