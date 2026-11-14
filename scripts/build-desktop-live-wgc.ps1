<#
Build the optional local-only Desktop Live Windows Graphics Capture helper
using installed MSVC and Windows SDK; no downloads, service installs,
Core/Tray restarts, or runtime permission changes.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") { throw "Windows x64 build host required." }
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$source = Join-Path $root "native\desktop-live-wgc\windowsCapture.cpp"
$pf32 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
# Windows CI images may provide Enterprise rather than Community or BuildTools.
# Query the installed MSVC toolset through Microsoft's own installer first.
$vcCandidates = @()
$vswhere = Join-Path $pf32 "Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
  $installations = @(& $vswhere -all -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
  if ($LASTEXITCODE -eq 0) {
    foreach ($installation in $installations) {
      if ($installation) { $vcCandidates += Join-Path $installation "VC\Auxiliary\Build\vcvars64.bat" }
    }
  }
}
$vcCandidates += Join-Path $pf32 "Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
$vcCandidates += Join-Path $env:ProgramFiles "Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
$vcVars = $vcCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $vcVars) { throw "MSVC x64 toolchain missing; no runtime compiler fallback." }
$includes = Join-Path $pf32 "Windows Kits\10\Include"
$versions = @(Get-ChildItem -LiteralPath $includes -Directory | Sort-Object Name -Descending)
$sdk = $versions | Where-Object {
  Test-Path -LiteralPath (Join-Path $_.FullName "cppwinrt\winrt\Windows.Graphics.Capture.h")
} | Select-Object -First 1
if (-not $sdk) { throw "Windows SDK C++/WinRT headers are missing." }
$cppwinrt = Join-Path $sdk.FullName "cppwinrt"
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Expected fixed WGC source missing." }

$buildDir = Join-Path ([System.IO.Path]::GetTempPath()) ("superagent-wgc-build-" + [guid]::NewGuid().ToString("N"))
New-Item -Path $buildDir -ItemType Directory -Force | Out-Null
try {
  $exe = Join-Path $buildDir "wgc.exe"
  $obj = Join-Path $buildDir "wgc.obj"
  $command = 'call "' + $vcVars + '" >nul && cl /nologo /std:c++17 /EHsc /O2 /utf-8 /I "' +
    $cppwinrt + '" "' + $source + '" /Fo:"' + $obj +
    '" /Fe:"' + $exe + '" /link user32.lib d3d11.lib dwmapi.lib windowsapp.lib windowscodecs.lib crypt32.lib ole32.lib'
  & (Join-Path $env:WINDIR "System32\cmd.exe") /d /s /c $command
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "WGC native compilation failed."
  }
  $digest = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($digest -notmatch '^[a-f0-9]{64}$') { throw "WGC digest unavailable." }
  $destination = Join-Path $root "dist\native\desktop-live-wgc"
  New-Item -Path $destination -ItemType Directory -Force | Out-Null
  Copy-Item -LiteralPath $exe -Destination (Join-Path $destination "wgc.exe") -Force
  [System.IO.File]::WriteAllText(
    (Join-Path $destination "wgc.sha256"), $digest + [Environment]::NewLine,
    [System.Text.Encoding]::ASCII
  )
  Write-Output ("WGC_BUILD_PASS sha256=" + $digest + " output=" + $destination)
} finally {
  # Only remove the new scratch folder allocated by this invocation.
  if (Test-Path -LiteralPath $buildDir) {
    Remove-Item -LiteralPath $buildDir -Recurse -Force
  }
}
