<#
Read-only verification of the actual compressed NSIS Windows x64 package
for the Desktop Live WGC helper. No installation, restart, or publication.
#>
param(
  # Optional audit of an existing earlier local NSIS; CI always omits this.
  [string]$InstallerPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") { throw "Windows x64 required for NSIS verification." }
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).ProviderPath
$version = (Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw "Unexpected package version." }
$archiveDir = Join-Path $root "apps\superagent-tray\src-tauri\target\release\bundle\nsis"
$filename = "SuperAgent_" + $version + "_x64-setup.exe"
$installer = Join-Path $archiveDir $filename
if ($InstallerPath) {
  $installer = (Resolve-Path -LiteralPath $InstallerPath -ErrorAction Stop).ProviderPath
  if ((Split-Path -Parent $installer) -ine $archiveDir) {
    throw "Audit installer must belong to the fixed local NSIS artifact directory."
  }
}
if ((Split-Path -Leaf $installer) -notmatch '^SuperAgent_([0-9]+\.[0-9]+\.[0-9]+)_x64-setup\.exe$') {
  throw "Unexpected Windows NSIS installer filename."
}
$bundleVersion = $Matches[1]
$stage = Join-Path $root "apps\superagent-tray\src-tauri\resources\standalone\dist\native\desktop-live-wgc"

$sevenZip = Join-Path $env:ProgramFiles "7-Zip\7z.exe"
if (-not (Test-Path -LiteralPath $sevenZip -PathType Leaf)) {
  $resolved = Get-Command "7z.exe" -ErrorAction SilentlyContinue
  if (-not $resolved) { throw "7-Zip executable is required for NSIS verification." }
  $sevenZip = $resolved.Source
}
foreach ($required in @($installer, (Join-Path $stage "wgc.exe"), (Join-Path $stage "wgc.sha256"))) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Missing NSIS verification input: $required"
  }
}
$installerSize = (Get-Item -LiteralPath $installer).Length
if ($installerSize -lt 20000000 -or $installerSize -gt 2000000000) {
  throw "NSIS installer has unexpected size."
}

$scratch = Join-Path ([IO.Path]::GetTempPath()) ("superagent-wgc-nsis-check-" + [Guid]::NewGuid().ToString("N"))
New-Item -Path $scratch -ItemType Directory | Out-Null
try {
  & $sevenZip t -bb0 -bd $installer | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "NSIS archive integrity test failed." }
  $member = "standalone\dist\native\desktop-live-wgc"
  & $sevenZip x -y -bb0 -bd ("-o" + $scratch) $installer "$member\wgc.exe" "$member\wgc.sha256" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not extract pinned NSIS WGC members." }
  $extracted = Join-Path $scratch $member
  $binary = Join-Path $extracted "wgc.exe"
  $receipt = Join-Path $extracted "wgc.sha256"
  foreach ($required in @($binary, $receipt)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "NSIS missing pinned WGC member: $required"
    }
    if ((Get-Item -LiteralPath $required).Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "NSIS WGC payload must not be a reparse-point."
    }
  }
  $size = (Get-Item -LiteralPath $binary).Length
  if ($size -lt 65536 -or $size -gt 2097152) { throw "NSIS WGC helper size invalid." }
  $expected = [IO.File]::ReadAllText($receipt, [Text.Encoding]::ASCII).Trim()
  if ($expected -cnotmatch '^[a-f0-9]{64}$') { throw "Extracted WGC SHA-256 receipt invalid." }
  $actual = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
  $stageHash = (Get-FileHash -LiteralPath (Join-Path $stage "wgc.exe") -Algorithm SHA256).Hash.ToLowerInvariant()
  $stageReceipt = [IO.File]::ReadAllText((Join-Path $stage "wgc.sha256"), [Text.Encoding]::ASCII).Trim()
  if ($expected -cne $actual -or $expected -cne $stageHash -or $expected -cne $stageReceipt) {
    throw "NSIS WGC differs from checksum-pinned standalone staging."
  }
  $installerDigest = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-Output ("NSIS_WGC_ARCHIVE_VERIFIED version=" + $bundleVersion +
    " helperBytes=" + $size + " helperSha256=" + $actual +
    " installerBytes=" + $installerSize + " installerSha256=" + $installerDigest)
} finally {
  if (Test-Path -LiteralPath $scratch) {
    Remove-Item -LiteralPath $scratch -Recurse -Force
  }
}
