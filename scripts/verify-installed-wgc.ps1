<#
Verify the installed Windows x64 WGC payload through the actual bundled Bun
and compiled Core module. No service launch, capture, permissions or install.
Works on a disposable extracted/installed standalone layout.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$InstallRoot
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = (Resolve-Path -LiteralPath $InstallRoot -ErrorAction Stop).ProviderPath
$runtime = Join-Path $root "bun.exe"
$module = Join-Path $root "standalone/dist/core/desktopUi/adapters/windowsWgcArtifact.js"
$errorsModule = Join-Path $root "standalone/dist/core/desktopUi/errors.js"
$helper = Join-Path $root "standalone/dist/native/desktop-live-wgc/wgc.exe"
$receipt = Join-Path $root "standalone/dist/native/desktop-live-wgc/wgc.sha256"
foreach ($required in @($runtime, $module, $errorsModule, $helper, $receipt)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Installed WGC verification missing payload: $required"
  }
}

# No inline eval: Windows PowerShell 5 strips nested quotes in Bun -e.
# A fixed checked-in script imports the installed compiled Core module using
# a file URL. Checks PE/x64, checksum and fixed path. This is an integrity
# receipt, not an OS publisher signature.
$script = Join-Path $PSScriptRoot "verify-installed-wgc.mjs"
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
  throw "Missing checked-in installed WGC verifier script"
}
& $runtime $script $root
if ($LASTEXITCODE -ne 0) {
  throw "Installed WGC helper verification failed (exit $LASTEXITCODE)"
}
