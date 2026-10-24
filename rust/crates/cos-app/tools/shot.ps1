# Captures the visible top-level windows owned by one pid through PrintWindow (PW_RENDERFULLCONTENT),
# so no other application's pixels are read.
# usage: powershell -File shot.ps1 -ProcId <pid> -Out <file.png> [-Index <n>]
param([int]$ProcId, [string]$Out, [int]$Index = -1)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class CosShot {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<IntPtr> Of(uint pid) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
}
"@
[CosShot]::SetProcessDPIAware() | Out-Null
$wins = [CosShot]::Of([uint32]$ProcId)
$i = 0
foreach ($h in $wins) {
  if ($Index -ge 0 -and $i -ne $Index) { $i++; continue }
  $r = New-Object CosShot+RECT
  [CosShot]::GetWindowRect($h, [ref]$r) | Out-Null
  $w = $r.R - $r.L; $hgt = $r.B - $r.T
  if ($w -le 0 -or $hgt -le 0) { $i++; continue }
  $bmp = New-Object System.Drawing.Bitmap $w, $hgt
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [CosShot]::PrintWindow($h, $hdc, 2) | Out-Null
  $g.ReleaseHdc($hdc); $g.Dispose()
  $path = if ($wins.Count -gt 1) { $Out -replace '\.png$', "-w$i.png" } else { $Out }
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  Write-Output "$path ${w}x${hgt} hwnd=$h"
  $i++
}
if ($wins.Count -eq 0) { Write-Output "no visible window for pid $ProcId" }
