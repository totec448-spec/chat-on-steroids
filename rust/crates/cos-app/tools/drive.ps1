# Drives cos-app's own windows through UI Automation. Every action first proves the target belongs
# to -ProcId; nothing is sent to any other window. Keyboard input (F11 only) is sent only while the
# foreground window belongs to -ProcId (standing order 16).
# usage: powershell -File drive.ps1 -ProcId <pid> -Action <action> [-Name <text>] [-X <n> -Y <n>]
#   state                  main window: visible, bounds, foreground
#   close                  WindowPattern.Close on the main window (the caption close path)
#   invoke -Name <n>       Invoke the element of our windows whose AutomationId or Name is <n>
#   menu-pick -Name <n>    choose item <n> of our open popup menu (the tray menu)
#   normal | maximize      WindowPattern.SetWindowVisualState of the main window
#   move -X <n> -Y <n>     TransformPattern.Move of the main window
#   resize -X <w> -Y <h>   TransformPattern.Resize of the main window
#   f11 | tab              press F11 or Tab if, and only if, our window is the foreground window
#   focused                the element of our window that has keyboard focus
param([int]$ProcId, [string]$Action, [string]$Name = '', [int]$X = 0, [int]$Y = 0)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class CosDrive {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit, Size = 40)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
  public static uint OwnerOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("oleacc.dll")] public static extern int AccessibleObjectFromWindow(IntPtr h, uint id, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  public static IntPtr OurMenu(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { var sb = new System.Text.StringBuilder(16); GetClassName(h, sb, 16);
      if (OwnerOf(h) == pid && IsWindowVisible(h) && sb.ToString() == "#32768") { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static string PickMenuItem(uint pid, IntPtr menu, int index) {
    if (OwnerOf(menu) != pid) return "refused: menu window is not ours";
    SendMessage(menu, 0x1E5 /* MN_SELECTITEM */, (IntPtr)index, IntPtr.Zero);
    if (OwnerOf(menu) != pid) return "refused: menu window is not ours";
    PostMessage(menu, 0x100 /* WM_KEYDOWN */, (IntPtr)0x0D /* VK_RETURN */, IntPtr.Zero);
    return "picked item " + index;
  }
  public static string PressIfOurs(uint pid, ushort vk) {
    IntPtr fg = GetForegroundWindow();
    if (OwnerOf(fg) != pid) return "refused: foreground window belongs to pid " + OwnerOf(fg);
    var down = new INPUT { type = 1, ki = new KEYBDINPUT { wVk = vk } };
    var up = new INPUT { type = 1, ki = new KEYBDINPUT { wVk = vk, dwFlags = 2 } };
    uint sent = SendInput(2, new[] { down, up }, Marshal.SizeOf(typeof(INPUT)));
    return "sent " + sent + " events to foreground " + fg;
  }
}
"@
[CosDrive]::SetProcessDPIAware() | Out-Null
$AE = [System.Windows.Automation.AutomationElement]
$root = $AE::RootElement
$ours = New-Object System.Windows.Automation.PropertyCondition ($AE::ProcessIdProperty), $ProcId
function Main-Window {
  $cls = New-Object System.Windows.Automation.PropertyCondition ($AE::ClassNameProperty), 'Zed::Window'
  $both = New-Object System.Windows.Automation.AndCondition $ours, $cls
  $w = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $both)
  if ($null -eq $w) { throw "no main window for pid $ProcId" }
  if ($w.Current.ProcessId -ne $ProcId) { throw 'not our window' }
  return $w
}
function Find-Ours($scopeRoot, $text) {
  $byId = New-Object System.Windows.Automation.PropertyCondition ($AE::AutomationIdProperty), $text
  $byName = New-Object System.Windows.Automation.PropertyCondition ($AE::NameProperty), $text
  $either = New-Object System.Windows.Automation.OrCondition $byId, $byName
  $el = $scopeRoot.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $either)
  if ($null -eq $el) { throw "no element '$text'" }
  if ($el.Current.ProcessId -ne $ProcId) { throw "element '$text' is not ours" }
  return $el
}
switch ($Action) {
  'state' {
    $hwnds = @()
    $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $ours)
    foreach ($w in $wins) {
      $h = [IntPtr]$w.Current.NativeWindowHandle
      $r = New-Object CosDrive+RECT; [CosDrive]::GetWindowRect($h, [ref]$r) | Out-Null
      $hwnds += [ordered]@{ class = $w.Current.ClassName; name = $w.Current.Name; visible = [CosDrive]::IsWindowVisible($h); rect = "$($r.L),$($r.T),$($r.R),$($r.B)" }
    }
    $fg = [CosDrive]::GetForegroundWindow()
    [ordered]@{ windows = $hwnds; foregroundIsOurs = ([CosDrive]::OwnerOf($fg) -eq $ProcId) } | ConvertTo-Json -Compress -Depth 4
  }
  'close' {
    $w = Main-Window
    $w.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
    'closed'
  }
  'invoke' {
    $el = Find-Ours (Main-Window) $Name
    $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    "invoked $($el.Current.ControlType.ProgrammaticName) '$($el.Current.Name)'"
  }
  'menu-pick' {
    # The tray menu is a Win32 popup (#32768). Its items are read through MSAA (the managed UIA
    # client shows the popup as an empty pane); the item is selected with MN_SELECTITEM and chosen
    # with a VK_RETURN posted to that menu window only, after proving the window is ours.
    $menu = [IntPtr]::Zero
    for ($i = 0; $i -lt 50 -and $menu -eq [IntPtr]::Zero; $i++) {
      $menu = [CosDrive]::OurMenu([uint32]$ProcId)
      if ($menu -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
    }
    if ($menu -eq [IntPtr]::Zero) { throw "no popup menu of pid $ProcId" }
    $iid = [Guid]'618736E0-3C3D-11CF-810C-00AA00389B71'
    $acc = $null
    [CosDrive]::AccessibleObjectFromWindow($menu, [uint32]4294967292, [ref]$iid, [ref]$acc) | Out-Null
    $count = [System.__ComObject].InvokeMember('accChildCount', 'GetProperty', $null, $acc, $null)
    $names = @(for ($c = 1; $c -le $count; $c++) { [string][System.__ComObject].InvokeMember('accName', 'GetProperty', $null, $acc, @($c)) })
    $index = [Array]::IndexOf($names, $Name)
    if ($index -lt 0) { throw "menu has no item '$Name' (items: $($names -join ' | '))" }
    "menu items: $($names -join ' | ')"
    [CosDrive]::PickMenuItem([uint32]$ProcId, $menu, $index)
  }
  'normal' {
    (Main-Window).GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).SetWindowVisualState('Normal')
    'normal'
  }
  'maximize' {
    (Main-Window).GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).SetWindowVisualState('Maximized')
    'maximized'
  }
  'move' {
    $w = Main-Window
    $w.GetCurrentPattern([System.Windows.Automation.TransformPattern]::Pattern).Move($X, $Y)
    "moved to $X,$Y"
  }
  'resize' {
    (Main-Window).GetCurrentPattern([System.Windows.Automation.TransformPattern]::Pattern).Resize($X, $Y)
    "resized to $X x $Y"
  }
  'f11' { [CosDrive]::PressIfOurs([uint32]$ProcId, 0x7A) }
  'tab' { [CosDrive]::PressIfOurs([uint32]$ProcId, 0x09) }
  'focused' {
    $f = $AE::FocusedElement
    if ($f.Current.ProcessId -ne $ProcId) { 'focus is not ours' } else { "$($f.Current.ControlType.ProgrammaticName) '$($f.Current.Name)' id=$($f.Current.AutomationId)" }
  }
  default { throw "unknown action $Action" }
}
