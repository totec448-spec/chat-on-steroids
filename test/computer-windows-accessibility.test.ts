import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

// An owned, non-activating WPF window supplies real UIA providers. The test only
// invokes semantic patterns on its cached elements; no physical user input occurs.
const fixture = String.raw`
using System;
using System.Threading;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Interop;
using System.Windows.Media;
public class FixtureWindow : Window {
  public bool BrowserRoot;
  protected override AutomationPeer OnCreateAutomationPeer() { return new FixtureWindowPeer(this); }
}
public class FixtureWindowPeer : WindowAutomationPeer {
  private FixtureWindow window;
  public FixtureWindowPeer(FixtureWindow owner) : base(owner) { window = owner; }
  protected override string GetClassNameCore() { return window.BrowserRoot ? "BrowserRootView" : base.GetClassNameCore(); }
}
public static class AccessibilityFixture {
  [STAThread] public static void Main() {
    var application = new Application();
    application.ShutdownMode = ShutdownMode.OnMainWindowClose;
    var window = new FixtureWindow { Title = "COS owned accessibility fixture", Width = 400, Height = 600, Left = -10000, Top = -10000, ShowActivated = false, ShowInTaskbar = false };
    var panel = new StackPanel(); window.Content = panel;
    var button = new Button { Content = "Invoke fixture", Height = 30 }; AutomationProperties.SetAutomationId(button, "invoke"); panel.Children.Add(button);
    int invoked = 0; button.Click += delegate { invoked++; };
    var check = new CheckBox { Content = "Toggle fixture", Height = 30 }; AutomationProperties.SetAutomationId(check, "toggle"); panel.Children.Add(check);
    var list = new ListBox { Height = 70 }; AutomationProperties.SetAutomationId(list, "list");
    var first = new ListBoxItem { Content = "First" }; AutomationProperties.SetAutomationId(first, "first"); list.Items.Add(first);
    var second = new ListBoxItem { Content = "Second" }; AutomationProperties.SetAutomationId(second, "second"); list.Items.Add(second); panel.Children.Add(list);
    var expander = new Expander { Header = "Expand fixture", Content = new TextBlock { Text = "Expanded body" } }; AutomationProperties.SetAutomationId(expander, "expand"); panel.Children.Add(expander);
    var scroll = new ScrollViewer { Height = 80, Width = 180, HorizontalScrollBarVisibility = ScrollBarVisibility.Visible, VerticalScrollBarVisibility = ScrollBarVisibility.Visible };
    AutomationProperties.SetAutomationId(scroll, "scroll"); scroll.Content = new TextBlock { Width = 600, Height = 800, Text = "Scrollable fixture content" }; panel.Children.Add(scroll);
    var editor = new TextBox { Height = 80, AcceptsReturn = true, Text = "first\r\n" + new string('x', 20000) }; AutomationProperties.SetAutomationId(editor, "editor"); panel.Children.Add(editor); editor.Select(0, 5);
    var disabled = new Button { Content = "Disabled fixture", IsEnabled = false }; AutomationProperties.SetAutomationId(disabled, "disabled"); panel.Children.Add(disabled);
    var document = new RichTextBox { Height = 60, Visibility = Visibility.Collapsed };
    document.Document = new FlowDocument(new Paragraph(new Run("Page document body " + new string('d', 20000))));
    AutomationProperties.SetAutomationId(document, "document"); panel.Children.Add(document);
    window.Loaded += delegate {
      var targetHandle = new WindowInteropHelper(window).Handle;
      var popup = new HwndSource(new HwndSourceParameters("") { ParentWindow = targetHandle, WindowStyle = unchecked((int)0x90000000), ExtendedWindowStyle = 0x08000080, Width = 100, Height = 50, PositionX = -10000, PositionY = -10000 });
      popup.RootVisual = new Border { Width = 100, Height = 50, Background = Brushes.Green, Child = new TextBlock { Text = "Owned popup" } };
      var unrelated = new Window { Title = "Same process unrelated fixture", Width = 100, Height = 100, Left = -11000, Top = -11000, ShowActivated = false, ShowInTaskbar = false }; unrelated.Show();
      Console.WriteLine(targetHandle.ToInt64() + "," + popup.Handle.ToInt64() + "," + new WindowInteropHelper(unrelated).Handle.ToInt64()); Console.Out.Flush();
      var reader = new Thread(delegate() {
        string command;
        while ((command = Console.ReadLine()) != null) {
          if (command == "quit") { window.Dispatcher.Invoke(new Action(delegate { popup.Dispose(); unrelated.Close(); window.Close(); })); return; }
          window.Dispatcher.Invoke(new Action(delegate {
            if (command == "document") { document.Visibility = Visibility.Visible; window.UpdateLayout(); }
            if (command == "browser") { window.BrowserRoot = true; document.Visibility = Visibility.Collapsed; window.UpdateLayout(); }
            Console.WriteLine((check.IsChecked == true ? "1" : "0") + "|" + list.SelectedIndex + "|" + (expander.IsExpanded ? "1" : "0") + "|" + invoked + "|" + scroll.VerticalOffset + "|" + scroll.HorizontalOffset);
            Console.Out.Flush();
          }));
        }
      }); reader.IsBackground = true; reader.Start();
    };
    application.Run(window);
  }
}
`;

describe.runIf(process.platform === 'win32')('Windows semantic accessibility actions', () => {
  it('executes only supported native patterns and returns bounded observation context', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cos-uia-test-'));
    try {
      writeFileSync(path.join(dir, 'fixture.cs'), fixture, 'utf8');
      const helper = HELPER_SCRIPT.slice(0, HELPER_SCRIPT.indexOf('while (($line = [Console]::In.ReadLine())'));
      const probe = String.raw`
$runtime = [System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
$wpf = Join-Path $runtime 'WPF'
$refs = @('System.dll', (Join-Path $runtime 'System.Xaml.dll'), (Join-Path $wpf 'PresentationFramework.dll'), (Join-Path $wpf 'PresentationCore.dll'), (Join-Path $wpf 'WindowsBase.dll'))
$exe = Join-Path $PSScriptRoot 'fixture.exe'
Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'fixture.cs'))) -ReferencedAssemblies $refs -OutputAssembly $exe -OutputType WindowsApplication
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = $exe; $info.UseShellExecute = $false; $info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true; $info.RedirectStandardInput = $true
$owned = [System.Diagnostics.Process]::Start($info)
try {
  $handles = $owned.StandardOutput.ReadLine() -split ','
  $id = [int64]$handles[0]; $popupId = [int64]$handles[1]; $unrelatedId = [int64]$handles[2]
  $snapshot = Handle-Request @{ op = 'snapshot'; id = $id; includeScreenshot = $false; includeUi = $true; includeRelated = $true; maxResults = 100 }
  $relatedIds = @($snapshot.relatedWindows | ForEach-Object { $_.id })
  if ($popupId -notin $relatedIds -or $unrelatedId -in $relatedIds -or $relatedIds.Count -gt 3) { throw ('related popup ownership failed: ' + ($relatedIds -join ',')) }
  if (-not [Clf]::IsRelatedWindow($popupId, $id) -or [Clf]::IsRelatedWindow($unrelatedId, $id)) { throw 'exact related ownership proof failed' }
  if ($null -eq (Get-WindowRow $popupId)) { throw 'exact empty-title popup lookup failed' }
  $nativeWindow = Get-WindowRow $id
  if (!$nativeWindow.app -or !$nativeWindow.processId -or !$nativeWindow.processPath -or $nativeWindow.dpi -lt 96) { throw 'native window identity or DPI missing' }
  $apps = Get-WindowsApps @{limit=100}
  $app = @($apps.apps | Where-Object { $_.id -ceq $nativeWindow.app })
  if ($app.Count -ne 1 -or $id -notin @($app[0].windows | ForEach-Object { $_.id })) { throw 'real window did not join its native app identity' }
  try {
    $null = Capture-Target @{ id = $unrelatedId; ownerWindow = $id; file = (Join-Path $PSScriptRoot 'must-not-exist.png') } $null
    throw 'unrelated capture unexpectedly accepted'
  } catch { if ($_.Exception.Message -notmatch 'RELATED_WINDOW_GONE') { throw } }
  if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'must-not-exist.png')) { throw 'unrelated window captured before ownership rejection' }
  if ($snapshot.uiUnavailable) { throw ('UIA unavailable: ' + $snapshot.uiUnavailable.message) }
  $rows = @{}; foreach ($row in $snapshot.elements) { if ($row.automationId) { $rows[$row.automationId] = $row } }
  foreach ($key in @('invoke','toggle','second','expand','scroll','editor','disabled')) {
    if (-not $rows.ContainsKey($key)) { throw ('missing fixture element ' + $key + ': ' + ($snapshot | ConvertTo-Json -Depth 8 -Compress)) }
  }
  if ('invoke' -notin $rows.invoke.actions -or 'toggle' -notin $rows.toggle.actions -or 'select' -notin $rows.second.actions -or 'expand' -notin $rows.expand.actions -or 'scroll_down' -notin $rows.scroll.actions) { throw 'supported semantic actions not projected' }
  if ($rows.second.depth -le $rows.list.depth) { throw 'hierarchy depth not retained' }
  if ($snapshot.document_text -notmatch 'first' -or $snapshot.selected_text -ne 'first') { throw ('text context missing: ' + ($snapshot | ConvertTo-Json -Depth 8 -Compress)) }
  if (($snapshot.document_text.Length + $snapshot.selected_text.Length) -ne 8000) { throw 'long document text was not bounded to the shared budget' }
  function Act([string]$key, [string]$action) {
    $row = $rows[$key]
    return Handle-Request @{ op = 'act'; actions = @(@{ type = 'ui_action'; window = $id; snapshotId = $snapshot.snapshotId; runtimeKey = $row.runtimeKey; action = $action }) }
  }
  function Read-State {
    $owned.StandardInput.WriteLine('state'); $owned.StandardInput.Flush()
    return ($owned.StandardOutput.ReadLine() -split '\|')
  }
  foreach ($pair in @(@('invoke','invoke'), @('toggle','toggle'), @('second','select'), @('expand','expand'), @('scroll','scroll_down'), @('scroll','scroll_right'))) {
    $result = Act $pair[0] $pair[1]
    if ($result.ok -ne $true -or $result.completed_count -ne 1 -or $result.routes[0] -ne 'uia') { throw ('semantic action failed: ' + ($result | ConvertTo-Json -Compress)) }
  }
  $state = Read-State
  if ($state[0] -ne '1' -or $state[1] -ne '1' -or $state[2] -ne '1' -or $state[3] -ne '1' -or [double]$state[4] -le 0 -or [double]$state[5] -le 0) { throw ('native patterns did not change controls: ' + ($state -join '|')) }
  $result = Act 'invoke' 'toggle'
  if ($result.ok -ne $false -or $result.error_code -ne 'UI_ACTION_UNSUPPORTED' -or $result.completed_count -ne 0) { throw 'unsupported action did not reject without effects' }
  $result = Act 'disabled' 'invoke'
  if ($result.ok -ne $false -or $result.error_code -ne 'UI_ELEMENT_DISABLED') { throw 'disabled control was not rejected' }
  if (((Read-State) -join '|') -ne ($state -join '|')) { throw 'rejected actions changed fixture' }
  $result = Handle-Request @{ op = 'act'; ownerWindow = $unrelatedId; actions = @(@{ type = 'ui_action'; window = $id; snapshotId = $snapshot.snapshotId; runtimeKey = $rows.invoke.runtimeKey; action = 'invoke' }) }
  if ($result.ok -ne $false -or $result.error_code -ne 'RELATED_WINDOW_GONE' -or $result.completed_count -ne 0) { throw 'unrelated owner permitted input' }
  if (((Read-State) -join '|') -ne ($state -join '|')) { throw 'owner rejection changed fixture' }
  foreach ($identity in @(@{targetApp='wrong.app'},@{ownerWindow=$id;ownerApp='wrong.owner.app'})) {
    $request = @{ op = 'act'; targetApp=$identity.targetApp; ownerWindow=$identity.ownerWindow; ownerApp=$identity.ownerApp; actions = @(@{ type = 'ui_action'; window = $id; snapshotId = $snapshot.snapshotId; runtimeKey = $rows.invoke.runtimeKey; action = 'invoke' }) }
    $result = Handle-Request $request
    if ($result.ok -ne $false -or $result.error_code -ne 'WINDOW_APP_MISMATCH' -or $result.completed_count -ne 0) { throw 'wrong native application identity permitted input' }
    if (((Read-State) -join '|') -ne ($state -join '|')) { throw 'application identity rejection changed fixture' }
  }
  try {
    $null = Handle-Request @{ op = 'act'; actions = @(
      @{ type = 'ui_action'; window = $id; snapshotId = $snapshot.snapshotId; runtimeKey = $rows.invoke.runtimeKey; action = 'invoke' },
      @{ type = 'ui_action'; window = $id; snapshotId = $snapshot.snapshotId; runtimeKey = $rows.invoke.runtimeKey; action = 'invented' }
    ) }
    throw 'unknown semantic action accepted'
  } catch { if ($_.Exception.Message -notmatch 'BAD_ACTION') { throw } }
  if (((Read-State) -join '|') -ne ($state -join '|')) { throw 'invalid later action performed earlier effects' }
  $result = Act 'second' 'scroll_into_view'; if (-not $result.ok -or $result.routes[0] -ne 'uia') { throw 'scroll into view failed' }
  $result = Act 'expand' 'collapse'; if (-not $result.ok) { throw 'collapse failed' }
  $result = Act 'scroll' 'scroll_up'; if (-not $result.ok) { throw 'scroll up failed' }
  $result = Act 'scroll' 'scroll_left'; if (-not $result.ok) { throw 'scroll left failed' }
  $state = Read-State
  if ($state[2] -ne '0' -or [double]$state[4] -ne 0 -or [double]$state[5] -ne 0) { throw 'reverse actions failed' }
  # click_ref on a checkbox should use its TogglePattern without physical input.
  $row = $rows.toggle
  $result = Handle-Request @{ op = 'act'; actions = @(@{ type = 'click_ui'; window = $id; snapshotId = $snapshot.snapshotId; runtimeKey = $row.runtimeKey }) }
  if (-not $result.ok -or $result.routes[0] -ne 'uia' -or (Read-State)[0] -ne '0') { throw 'click_ref did not use native toggle' }
  $fresh = Handle-Request @{ op = 'snapshot'; id = $id; includeScreenshot = $false; includeUi = $true; maxResults = 100 }
  $selected = @($fresh.elements | Where-Object { $_.automationId -eq 'second' })[0]
  if ($selected.selected -ne $true) { throw 'selection state not projected' }
  # Like a browser toolbar editor preceding its page, an earlier TextPattern
  # must not claim document_text before the actual Document is visited.
  $owned.StandardInput.WriteLine('document'); $owned.StandardInput.Flush(); $null = $owned.StandardOutput.ReadLine()
  $page = Handle-Request @{ op = 'snapshot'; id = $id; includeScreenshot = $false; includeUi = $true; maxResults = 100 }
  if (-not @($page.elements | Where-Object { $_.automationId -eq 'document' -and $_.role -eq 'Document' }).Count) { throw 'document fixture provider missing' }
  if ($page.document_text -notmatch '^Page document body') { throw 'earlier editor displaced the page document text' }
  if (($page.document_text.Length + $page.selected_text.Length) -gt 8000) { throw 'document text exceeded shared budget' }
  # A browser without an observed page must not label its toolbar editor as
  # document text. The same real UIA editor remains available in the tree.
  $owned.StandardInput.WriteLine('browser'); $owned.StandardInput.Flush(); $null = $owned.StandardOutput.ReadLine()
  $browser = Find-UiElements @{ id = $id; maxResults = 100 }
  if ((Get-UiRoot $id).Current.ClassName -ne 'BrowserRootView') { throw 'browser root fixture missing' }
  if (-not @($browser.elements | Where-Object { $_.automationId -eq 'editor' }).Count) { throw 'browser editor missing from indexed controls' }
  if ($null -ne $browser.document_text -or $null -ne $browser.selected_text) { throw 'browser toolbar text presented as page content' }
  $owned.StandardInput.WriteLine('document'); $owned.StandardInput.Flush(); $null = $owned.StandardOutput.ReadLine()
  $browser = Find-UiElements @{ id = $id; maxResults = 100 }
  if ($browser.document_text -notmatch '^Page document body') { throw 'browser page document text missing' }
  Write-Output 'WINDOWS_ACCESSIBILITY_PROBE_OK'
} finally {
  if (-not $owned.HasExited) {
    $owned.StandardInput.WriteLine('quit'); $owned.StandardInput.Flush()
    if (-not $owned.WaitForExit(3000)) { $owned.Kill() }
  }
  $owned.Dispose()
}
`;
      const file = path.join(dir, 'probe.ps1');
      writeFileSync(file, helper + probe, 'utf8');
      const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
        encoding: 'utf8', timeout: 35_000, windowsHide: true
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain('WINDOWS_ACCESSIBILITY_PROBE_OK');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});
