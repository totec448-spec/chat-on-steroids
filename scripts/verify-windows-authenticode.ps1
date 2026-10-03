param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('x64', 'arm64')]
  [string]$Arch,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedSubject,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedThumbprint
)

$ErrorActionPreference = 'Stop'
if ($ExpectedThumbprint -notmatch '^[0-9A-Fa-f \t:-]+$') {
  throw 'ExpectedThumbprint may contain only hex digits separated by whitespace, colon, or hyphen.'
}
$normalizedThumbprint = ($ExpectedThumbprint -replace '[ \t:-]', '').ToUpperInvariant()
if ($normalizedThumbprint -notmatch '^[0-9A-F]{40}$') {
  throw 'ExpectedThumbprint must be exactly one SHA-1 certificate fingerprint (40 hex digits).'
}
if ([string]::IsNullOrWhiteSpace($ExpectedSubject) -or $ExpectedSubject -match '[\r\n]') {
  throw 'ExpectedSubject must be one non-empty certificate subject line.'
}

$unpackedDirectory = if ($Arch -eq 'arm64') { 'win-arm64-unpacked' } else { 'win-unpacked' }
$appExe = Join-Path $PWD "release/$unpackedDirectory/Chat On Steroids.exe"
$installer = Join-Path $PWD "release/Chat-On-Steroids-Setup-$Arch.exe"

function Assert-AuthenticodeSigner([string]$File) {
  if (-not (Test-Path -Path $File -PathType Leaf)) { throw "Missing Windows artifact: $File" }
  $signature = Get-AuthenticodeSignature -FilePath $File
  if ($signature.Status -ne 'Valid') {
    throw "Authenticode signature is not Valid for $File (status $($signature.Status))."
  }
  if ($null -eq $signature.SignerCertificate) { throw "Authenticode signer certificate is missing for $File." }

  $subject = $signature.SignerCertificate.Subject
  $thumbprint = ($signature.SignerCertificate.Thumbprint -replace '\s', '').ToUpperInvariant()
  if ($subject -cne $ExpectedSubject) {
    throw "Authenticode publisher mismatch for $File; expected exact configured subject."
  }
  if ($thumbprint -cne $normalizedThumbprint) {
    throw "Authenticode certificate fingerprint mismatch for $File."
  }
  return [PSCustomObject]@{ Subject = $subject; Thumbprint = $thumbprint }
}

$appSigner = Assert-AuthenticodeSigner $appExe
$installerSigner = Assert-AuthenticodeSigner $installer
if ($appSigner.Subject -cne $installerSigner.Subject -or $appSigner.Thumbprint -cne $installerSigner.Thumbprint) {
  throw 'Unpacked application and NSIS installer were not signed by the same certificate.'
}

Write-Output "windows-authenticode-ok arch=$Arch publisher=$($appSigner.Subject) thumbprint=$($appSigner.Thumbprint)"
