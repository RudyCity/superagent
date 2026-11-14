<#
Build the opt-in UI Automation DLL exclusively from the tracked C++ source on a
trusted GitHub-hosted Windows x64 runner. Never read/copy any native/*.dll,
*.obj, *.exp, *.lib or local SHA; all compiler outputs start in a unique scratch
directory, and only the verified DLL plus receipts enter dist staging.
No host UI actions, automatic approval, service activity, install or release.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT" -or [Environment]::Is64BitOperatingSystem -ne $true -or
    $env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
  throw "Trusted Windows x64 compiler host required."
}
if ($env:GITHUB_ACTIONS -cne "true" -or $env:RUNNER_OS -cne "Windows" -or
    $env:RUNNER_ENVIRONMENT -cne "github-hosted" -or
    $env:GITHUB_SHA -cnotmatch '^[a-f0-9]{40}$' -or
    $env:GITHUB_RUN_ID -notmatch '^[0-9]+$') {
  throw "Refusing local/unknown build inputs: GitHub-hosted Windows Actions identity required."
}
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).ProviderPath
$relative = "native/desktop-live-windows-input/windowsRemoteSemantic.cpp"
$source = Join-Path $root $relative
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Tracked UIA source missing." }
$head = (& git -C $root rev-parse HEAD)
if ($LASTEXITCODE -ne 0 -or $head -cne $env:GITHUB_SHA) { throw "Runner source SHA mismatch." }
& git -C $root ls-files --error-unmatch -- $relative | Out-Null
if ($LASTEXITCODE -ne 0) { throw "UIA source must be tracked in Git." }
& git -C $root diff --exit-code -- $relative | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Refusing locally edited C++ source." }
& git -C $root diff --cached --exit-code -- $relative | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Refusing staged C++ source differing from the checked-out commit." }

$programFiles86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
if (-not $programFiles86) { throw "Windows x64 Visual Studio location unavailable." }
$vswhere = Join-Path $programFiles86 "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { throw "MSVC vswhere missing." }
$install = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if ($LASTEXITCODE -ne 0 -or -not $install) { throw "MSVC x64 tools unavailable." }
$vcvars = Join-Path $install "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path -LiteralPath $vcvars -PathType Leaf)) { throw "MSVC x64 compiler environment missing." }

$output = Join-Path $root "dist\native\desktop-live-windows-input"
if (Test-Path -LiteralPath $output) {
  throw "Refusing potentially stale dist/native input; build in a clean, new Windows CI checkout."
}
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("superagent-uia-ci-" + [Guid]::NewGuid().ToString("N"))
New-Item -Path $scratch -ItemType Directory | Out-Null
try {
  $dll = Join-Path $scratch "winremote.dll"
  $obj = Join-Path $scratch "windowsRemoteSemantic.obj"
  Push-Location $scratch
  try {
    # /Brepro makes the linker output deterministic for identical compiler inputs.
    # The upstream native/build.ps1 is deliberately NOT invoked; it writes to
    # the source directory and can pick up older untracked build outputs.
    $line = 'call "' + $vcvars + '" >nul && cl /nologo /std:c++17 /O2 /W4 /EHsc /LD /DWIN32_LEAN_AND_MEAN /DUNICODE /D_UNICODE "' +
      $source + '" /Fo:"' + $obj + '" /Fe:"' + $dll +
      '" /link /Brepro /OUT:"' + $dll +
      '" uiautomationcore.lib ole32.lib oleaut32.lib user32.lib advapi32.lib dwmapi.lib'
    & (Join-Path $env:WINDIR "System32\cmd.exe") /d /s /c $line
    if ($LASTEXITCODE -ne 0) { throw "MSVC UIA DLL source compile failed: $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
  if (-not (Test-Path -LiteralPath $dll -PathType Leaf)) { throw "Compiled DLL missing." }
  $bytes = [IO.File]::ReadAllBytes($dll)
  if ($bytes.Length -lt 8192 -or $bytes.Length -gt 4194304 -or
      [Text.Encoding]::ASCII.GetString($bytes, 0, 2) -cne "MZ") {
    throw "Compiled DLL is not a bounded PE file."
  }
  $pe = [BitConverter]::ToUInt32($bytes, 0x3c)
  if ($pe -lt 0x40 -or $pe + 26 -gt $bytes.Length -or
      [Text.Encoding]::ASCII.GetString($bytes, $pe, 4) -cne ("PE" + [char]0 + [char]0) -or
      [BitConverter]::ToUInt16($bytes, $pe + 4) -ne 0x8664 -or
      ([BitConverter]::ToUInt16($bytes, $pe + 22) -band 0x2000) -eq 0 -or
      [BitConverter]::ToUInt16($bytes, $pe + 24) -ne 0x20b) {
    throw "Compiled UIA payload must be an AMD64 PE32+ DLL."
  }
  $hash = (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant()
  $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -notmatch '^[a-f0-9]{64}$' -or $sourceHash -notmatch '^[a-f0-9]{64}$') {
    throw "Native checksum generation failed."
  }
  $record = [ordered]@{
    schemaVersion = 1
    binary = "winremote.dll"
    source = "native/desktop-live-windows-input/windowsRemoteSemantic.cpp"
    sourceSha256 = $sourceHash
    dllSha256 = $hash
    commitSha = $env:GITHUB_SHA
    workflowRunId = $env:GITHUB_RUN_ID
    runnerOS = "Windows"
    runnerEnvironment = "github-hosted"
  }
  $encoding = New-Object System.Text.UTF8Encoding($false)
  New-Item -Path $output -ItemType Directory | Out-Null
  Copy-Item -LiteralPath $dll -Destination (Join-Path $output "winremote.dll")
  [IO.File]::WriteAllText((Join-Path $output "winremote.sha256"), $hash + "`n", $encoding)
  [IO.File]::WriteAllText((Join-Path $output "winremote.provenance.json"),
    ($record | ConvertTo-Json -Depth 3) + "`n", $encoding)
  # Independent portable verifier also checks exact source+commit+CI run.
  & bun -e 'import { verifyWindowsRemoteNativePackaging, windowsNativeCiContext } from "./scripts/verify-standalone-windows.ts"; import path from "node:path"; const root=process.cwd(); const source=path.join(root,"native","desktop-live-windows-input","windowsRemoteSemantic.cpp"); const dir=path.join(root,"dist","native","desktop-live-windows-input"); console.log("UIA_CI_BUILD_INTEGRITY_PASS",verifyWindowsRemoteNativePackaging(dir,source,windowsNativeCiContext()));'
  if ($LASTEXITCODE -ne 0) { throw "Native CI verifier rejected newly built DLL." }
  Write-Output "WINDOWS_INPUT_BUILD_PASS sha256=$hash commit=$env:GITHUB_SHA run=$env:GITHUB_RUN_ID"
} finally {
  if (Test-Path -LiteralPath $scratch) {
    Remove-Item -LiteralPath $scratch -Recurse -Force
  }
}
