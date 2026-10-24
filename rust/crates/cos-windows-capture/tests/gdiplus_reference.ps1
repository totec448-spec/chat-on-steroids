param(
  [Parameter(Mandatory=$true)][string]$InputPng,
  [Parameter(Mandatory=$true)][string]$OutputPng,
  [Parameter(Mandatory=$true)][int]$Width,
  [Parameter(Mandatory=$true)][int]$Height,
  [switch]$ScreenMode
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$original = [System.Drawing.Bitmap]::FromFile($InputPng)
try {
  $scaled = New-Object System.Drawing.Bitmap($Width,$Height)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($scaled)
    try {
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      if ($ScreenMode) {
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      }
      $graphics.DrawImage($original, [System.Drawing.Rectangle]::new(0,0,$Width,$Height))
      $scaled.Save($OutputPng,[System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose() }
  } finally { $scaled.Dispose() }
} finally { $original.Dispose() }
