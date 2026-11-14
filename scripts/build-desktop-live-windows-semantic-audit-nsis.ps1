<#
Read-only inspection of compressed Windows NSIS payload. Verifies exactly one
UIA x64 DLL with its matching receipt and provenance at the native loader's
fixed installed path. Does not execute the DLL or install the NSIS package.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT" -or $env:GITHUB_ACTIONS -cne "true" -or
    $env:RUNNER_OS -cne "Windows" -or $env:RUNNER_ENVIRONMENT -cne "github-hosted") {
  throw "Compressed UIA NSIS audit must run on trusted Windows GitHub CI."
}
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).ProviderPath
$version = (Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw "Unexpected version." }
$installer = Join-Path $root ("apps\superagent-tray\src-tauri\target\release\bundle\nsis\SuperAgent_" + $version + "_x64-setup.exe")
if (-not (Test-Path -LiteralPath $installer -PathType Leaf) -or
    (Get-Item -LiteralPath $installer).Length -lt 20000000) {
  throw "New Windows NSIS installer missing or truncated."
}
$stage = Join-Path $root "apps\superagent-tray\src-tauri\resources\standalone\native\desktop-live-windows-input"
foreach ($name in @("winremote.dll", "winremote.sha256", "winremote.provenance.json")) {
  if (-not (Test-Path -LiteralPath (Join-Path $stage $name) -PathType Leaf)) {
    throw "Native UIA staging incomplete: $name"
  }
}
$sevenZip = Join-Path $env:ProgramFiles "7-Zip\7z.exe"
if (-not (Test-Path -LiteralPath $sevenZip -PathType Leaf)) {
  $found = Get-Command "7z.exe" -ErrorAction SilentlyContinue
  if (-not $found) { throw "7-Zip required for compressed NSIS proof." }
  $sevenZip = $found.Source
}
& $sevenZip t -bb0 -bd $installer | Out-Null
if ($LASTEXITCODE -ne 0) { throw "NSIS archive failed integrity test." }
$listing = @(& $sevenZip l -slt $installer)
if ($LASTEXITCODE -ne 0) { throw "Cannot list NSIS entries." }
$prefix = "standalone/native/desktop-live-windows-input/"
$expected = @(
  ($prefix + "winremote.dll"),
  ($prefix + "winremote.sha256"),
  ($prefix + "winremote.provenance.json")
)
$members = @($listing | Where-Object { $_ -match '^Path = ' } |
  ForEach-Object { ($_ -replace '^Path = ', '') -replace '\\', '/' })
foreach ($name in $expected) {
  if (@($members | Where-Object { $_ -ceq $name }).Count -ne 1) {
    throw "NSIS must contain exactly one pinned native member: $name"
  }
}
$unexpected = @($members | Where-Object {
  ($_ -match '(?i)(^|/)winremote(\.|/)' -and $_ -cnotin $expected) -or
  ($_ -match '(?i)^standalone/(dist/)?native/desktop-live-windows-input/.+')
    -and $_ -cnotin $expected
})
if ($unexpected.Count -gt 0) {
  throw ("NSIS contains unexpected native UIA or compile outputs: " + ($unexpected -join ", "))
}
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("superagent-uia-nsis-check-" + [Guid]::NewGuid().ToString("N"))
New-Item -Path $scratch -ItemType Directory | Out-Null
try {
  $member = "standalone\native\desktop-live-windows-input"
  & $sevenZip x -y -bb0 -bd ("-o" + $scratch) $installer "$member\winremote.dll" "$member\winremote.sha256" "$member\winremote.provenance.json" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "NSIS native UIA extraction failed." }
  $extracted = Join-Path $scratch $member
  foreach ($name in @("winremote.dll", "winremote.sha256", "winremote.provenance.json")) {
    $file = Join-Path $extracted $name
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
      throw "NSIS member absent after extraction: $name"
    }
    if ((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "NSIS native UIA payload may not be a reparse point."
    }
    $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    $expectedHash = (Get-FileHash -LiteralPath (Join-Path $stage $name) -Algorithm SHA256).Hash
    if ($actual -cne $expectedHash) { throw "Extracted NSIS native file differs from verified staging: $name" }
  }
  $env:WINDOWS_UIA_VERIFY_DIR = $extracted
  try {
    & bun -e 'import { verifyWindowsRemoteNativePackaging, windowsNativeCiContext } from "./scripts/verify-standalone-windows.ts"; import path from "node:path"; const dir=process.env.WINDOWS_UIA_VERIFY_DIR; if (!dir) throw Error("Missing extracted root"); const source=path.join(process.cwd(),"native","desktop-live-windows-input","windowsRemoteSemantic.cpp"); console.log("WINDOWS_INPUT_NSIS_ARCHIVE_VERIFIED",verifyWindowsRemoteNativePackaging(dir,source,windowsNativeCiContext()));'
    if ($LASTEXITCODE -ne 0) { throw "Extracted NSIS native UIA integrity rejected." }
  } finally {
    Remove-Item Env:WINDOWS_UIA_VERIFY_DIR -ErrorAction SilentlyContinue
  }
} finally {
  if (Test-Path -LiteralPath $scratch) {
    Remove-Item -LiteralPath $scratch -Recurse -Force
  }
}
