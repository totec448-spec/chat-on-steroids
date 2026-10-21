import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { WINDOWS_APPS_SCRIPT } from '../src/main/computer/windows-apps.js';

const execute = promisify(execFile);

async function run(script: string, timeoutMs = 15_000): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'cos-app-catalog-test-'));
  try {
    const file = path.join(directory, 'test.ps1');
    await writeFile(file, `$ErrorActionPreference='Stop'\nfunction Get-WindowRows { return @() }\n${WINDOWS_APPS_SCRIPT}\n${script}`, 'utf8');
    const { stdout, stderr } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', file], {
      windowsHide: true, timeout: timeoutMs, maxBuffer: 32_768
    });
    if (stderr.includes('CHILD_STDERR_MUST_NOT_LEAK')) throw new Error('Launched app inherited the helper stderr');
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

  it('keeps an AppsFolder item whose shell identifier is not a valid path (#1590)', async () => {
    // Windows PowerShell 5.1 throws from IsPathRooted on "<" and other invalid path characters,
    // and one such item used to abort the whole list_apps catalog.
    const result = JSON.parse(await run(`
function Fake-Item([string]$path) { $item = [pscustomobject]@{ Path = $path; Name = 'Shell item' }; $item | Add-Member ScriptMethod ExtendedProperty { param($name) $null }; $item }
@(@(Fake-Item 'zn=shell<id'), @(Fake-Item 'C:\\Tools\\bad<name.exe'), @(Fake-Item 'C:\\Windows\\notepad.exe')) | ForEach-Object { $identity = Get-AppCatalogIdentity $_; @{ id = $identity.id; processPath = $identity.processPath } } | ConvertTo-Json -Compress
`));
    expect(result).toEqual([
      { id: 'zn=shell<id', processPath: '' },
      { id: 'C:\\Tools\\bad<name.exe', processPath: '' },
      { id: 'c:\\windows\\notepad.exe', processPath: 'C:\\Windows\\notepad.exe' }
    ]);
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
Add-Type -TypeDefinition 'using System; using System.IO; using System.Diagnostics; using System.Runtime.InteropServices; public static class OwnedApp { [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow(); [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind); [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr handle, out uint mode); [DllImport("kernel32.dll")] static extern bool GetHandleInformation(IntPtr handle, out uint flags); public static void Main(string[] args) { Console.WriteLine("CHILD_STDOUT_MUST_NOT_LEAK"); Console.Error.WriteLine("CHILD_STDERR_MUST_NOT_LEAK"); uint mode, flags; bool hasOwnConsole = GetConsoleWindow() != IntPtr.Zero && GetConsoleMode(GetStdHandle(-10), out mode) && GetConsoleMode(GetStdHandle(-11), out mode) && GetConsoleMode(GetStdHandle(-12), out mode); long parentHandle=long.Parse(File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"inheritable-parent-stdout.txt"))); bool leakedParentPipe=GetHandleInformation(new IntPtr(parentHandle),out flags); string marker=Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launched-" + Process.GetCurrentProcess().Id + ".txt"); string staged=marker+".pending"; File.WriteAllText(staged, args.Length + "|" + hasOwnConsole + "|" + leakedParentPipe); File.Move(staged,marker); } }' -OutputAssembly $executable -OutputType ConsoleApplication
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ParentStdoutProbe { [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess(); [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind); [DllImport("kernel32.dll")] static extern uint GetFileType(IntPtr handle); [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inheritable,uint options); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle); public static IntPtr InheritableStdout() { IntPtr stdout=GetStdHandle(-11); if(GetFileType(stdout)!=3) throw new Exception("Parent stdout was not a transport pipe"); IntPtr copy; if(!DuplicateHandle(GetCurrentProcess(),stdout,GetCurrentProcess(),out copy,0,true,2)) throw new Exception("Could not create inheritable transport handle"); return copy; } }'
$inheritable=[ParentStdoutProbe]::InheritableStdout()
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'inheritable-parent-stdout.txt'),$inheritable.ToInt64().ToString())
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
$marker=Join-Path $PSScriptRoot ('launched-'+$result.processId+'.txt')
for ($attempt=0;$attempt -lt 200 -and !(Test-Path -LiteralPath $marker);$attempt++) { Start-Sleep -Milliseconds 25 }
if (!(Test-Path -LiteralPath $marker) -or [IO.File]::ReadAllText($marker) -ne '0|True|False') { throw 'Owned console must have zero arguments and independent stdio, without inheriting an explicitly inheritable helper stdout pipe' }
$result=Launch-WindowsApp @{app='cos-owned-app.exe'}
if ($result.status -ne 'launch_requested' -or $result.windowConfirmed -ne $false -or !$result.processId) { throw 'PATH launch depended on unavailable app catalog' }
$marker=Join-Path $PSScriptRoot ('launched-'+$result.processId+'.txt')
for ($attempt=0;$attempt -lt 200 -and !(Test-Path -LiteralPath $marker);$attempt++) { Start-Sleep -Milliseconds 25 }
if (!(Test-Path -LiteralPath $marker) -or [IO.File]::ReadAllText($marker) -ne '0|True|False') { throw 'PATH launch did not preserve console, zero-argument and pipe-isolation semantics' }
$launched=Get-Process -Id $result.processId -ErrorAction SilentlyContinue
if ($null -ne $launched) { if (!$launched.WaitForExit(3000)) { throw 'Owned PATH executable failed to finish' }; $launched.Dispose() }
$null=[ParentStdoutProbe]::CloseHandle($inheritable)
Write-Output 'APP_EXECUTABLE_VERIFIED'
`)).toBe('APP_EXECUTABLE_VERIFIED');
  });

  it('keeps an exact-path GUI executable visible without adding arguments or a console', async () => {
    expect(await run(String.raw`
$executable=Join-Path $PSScriptRoot 'owned gui & app.exe'
$source=@'
using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
public static class OwnedGuiApp {
  [STAThread] public static void Main(string[] args) {
    Application.EnableVisualStyles();
    using (var form = new Form { Text = "CoS owned GUI launch fixture", Width = 250, Height = 110, StartPosition = FormStartPosition.Manual, Left = 60, Top = 60 }) {
      var timer = new Timer { Interval = 2000 };
      timer.Tick += (sender, eventArgs) => { timer.Stop(); form.Close(); };
      form.Shown += (sender, eventArgs) => {
        var marker = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "gui-" + Process.GetCurrentProcess().Id + ".txt");
        var staged = marker + ".pending";
        File.WriteAllText(staged, args.Length.ToString());
        File.Move(staged, marker);
        timer.Start();
      };
      Application.Run(form);
    }
  }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies @('System.dll','System.Windows.Forms.dll','System.Drawing.dll') -OutputAssembly $executable -OutputType WindowsApplication
$reply=Launch-WindowsApp @{app=$executable}
if ($reply.status -cne 'launch_requested' -or $reply.windowConfirmed -ne $false -or !$reply.processId) { throw 'GUI launch acknowledgment changed' }
$child=Get-Process -Id $reply.processId -ErrorAction Stop
try {
  $marker=Join-Path $PSScriptRoot ('gui-'+$reply.processId+'.txt')
  for ($attempt=0;$attempt -lt 200 -and !(Test-Path -LiteralPath $marker);$attempt++) { Start-Sleep -Milliseconds 30 }
  if (!(Test-Path -LiteralPath $marker) -or [IO.File]::ReadAllText($marker) -ne '0') { throw 'GUI fixture did not start with zero arguments' }
  $child.Refresh()
  if (![string]::Equals($child.Path,$executable,[StringComparison]::OrdinalIgnoreCase) -or $child.MainWindowHandle -eq 0) { throw 'Exact GUI executable did not create its own window' }
  $exited=$child.WaitForExit(5000)
  if (!$exited) { throw 'Owned GUI fixture did not exit within its bounded deadline' }
} finally {
  if (!$child.HasExited -and [string]::Equals($child.Path,$executable,[StringComparison]::OrdinalIgnoreCase)) { $child.Kill(); $null=$child.WaitForExit(2000) }
  $child.Dispose()
}
Write-Output 'APP_GUI_VERIFIED'
  `, 30_000)).toBe('APP_GUI_VERIFIED');
  });
});
