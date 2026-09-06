<#
.SYNOPSIS
Opens the installed companion's owned popup. Click Reload companion there.
.DESCRIPTION
Requires the extension ID already observed in Chrome. Does not inspect Chrome
profiles, extract credentials, or automate browser management pages.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId,
  [string]$ChromePath
)

$ErrorActionPreference = 'Stop'
if (-not $ChromePath) {
  $taskCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
  )
  if (${env:ProgramFiles(x86)}) {
    $taskCandidates += Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'
  }
  $ChromePath = $taskCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $ChromePath -or -not (Test-Path -LiteralPath $ChromePath -PathType Leaf)) {
  throw 'Chrome was not found. Supply its executable with -ChromePath.'
}
$taskPopupUrl = "chrome-extension://$ExtensionId/popup.html"
Start-Process -FilePath $ChromePath -ArgumentList @('--new-tab', $taskPopupUrl) -WindowStyle Hidden
Write-Output "Opened $taskPopupUrl"
Write-Output 'Click Reload companion. Reopen the popup afterward and check its connection; opening the page alone does not reload anything.'
