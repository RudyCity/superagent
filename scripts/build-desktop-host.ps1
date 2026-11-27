<#
Build the single native Desktop UI host (scoped PrintWindow capture +
UIAutomation inspection) with the .NET Framework C# compiler.

Offline and repeatable: no downloads, no MSBuild project, no elevation, no
package restore, deterministic source order and compiler flags. The legacy
.NET Framework csc.exe (C# 5, VS2013-era) does not implement /deterministic and
injects a per-build module version id, so bit-identical PE images are not
available from this toolchain; reproducibility is instead pinned by the
desktop-host.sha256 sidecar plus hard output invariants (PE x64, size bounds)
that the runtime verifier re-checks before every spawn.

The script fails loudly (non-zero exit, no output artifact written) when the
toolchain, source set, PE architecture or size bounds fail.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$sourceDir = Join-Path $root "native\desktop-host"
$frameworkDir = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319"
$csc = Join-Path $frameworkDir "csc.exe"
$destination = Join-Path $root "dist\native\desktop-host"

if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) {
  throw "Desktop host build requires the .NET Framework x64 C# compiler at $csc."
}
$sources = @(Get-ChildItem -LiteralPath $sourceDir -Filter "*.cs" -File | Sort-Object Name | ForEach-Object { $_.FullName })
if ($sources.Count -eq 0) {
  throw "Desktop host source set is empty: $sourceDir"
}

# System assemblies that ship with every Windows .NET Framework 4.x install.
$frameworkReferences = @(
  (Join-Path $frameworkDir "System.dll"),
  (Join-Path $frameworkDir "System.Core.dll"),
  (Join-Path $frameworkDir "System.Drawing.dll"),
  (Join-Path $frameworkDir "System.Windows.Forms.dll")
)
foreach ($reference in $frameworkReferences) {
  if (-not (Test-Path -LiteralPath $reference -PathType Leaf)) {
    throw "Desktop host build requires the framework assembly $reference."
  }
}

# UIAutomation ships in the GAC, not in the framework directory. Resolve each
# by exact file name over one fixed GAC root; never search the whole disk.
$gacRoot = Join-Path $env:WINDIR "Microsoft.NET\assembly\GAC_MSIL"
$gacReferences = @()
foreach ($assemblyName in @("UIAutomationClient.dll", "UIAutomationTypes.dll", "WindowsBase.dll")) {
  $assemblyRoot = Join-Path $gacRoot ([System.IO.Path]::GetFileNameWithoutExtension($assemblyName))
  $candidates = @()
  if (Test-Path -LiteralPath $assemblyRoot -PathType Container) {
    $candidates = @(Get-ChildItem -LiteralPath $assemblyRoot -Recurse -File |
      Where-Object { $_.Name -eq $assemblyName } |
      Sort-Object FullName |
      ForEach-Object { $_.FullName })
  }
  if ($candidates.Count -eq 0) {
    throw "Desktop host build requires $assemblyName from the .NET Framework GAC."
  }
  $gacReferences += $candidates[0]
}

$compilerArguments = @(
  "/nologo",
  "/target:winexe",
  "/platform:x64",
  "/optimize+",
  "/debug-",
  "/warn:4",
  "/warnaserror+",
  "/langversion:5",
  "/utf8output",
  "/unsafe-"
)
foreach ($reference in ($frameworkReferences + $gacReferences)) {
  $compilerArguments += "/r:$reference"
}

function Invoke-HostCompile([string]$outputPath) {
  $arguments = @($compilerArguments) + @("/out:$outputPath") + $sources
  $compilerOutput = @(& $csc @arguments 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw ("Desktop host compilation failed with exit code " + $LASTEXITCODE + ":`n" + ($compilerOutput -join "`n"))
  }
  if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
    throw "Desktop host compilation produced no executable."
  }
}

function Assert-HostImage([string]$path) {
  $info = Get-Item -LiteralPath $path
  # The legacy .NET Framework compiler emits a real image around 28 KB. The
  # floor only has to catch truncated/empty replacements; the exact byte pin is
  # the sha256 sidecar checked by desktopHostArtifact.ts before every spawn.
  if ($info.Length -lt 16KB -or $info.Length -gt 2MB) {
    throw "Desktop host image size $($info.Length) bytes is outside 16KB..2MB."
  }
  $bytes = [System.IO.File]::ReadAllBytes($path)
  if ($bytes.Length -lt 0x100) { throw "Desktop host image is truncated." }
  if ([System.Text.Encoding]::ASCII.GetString($bytes, 0, 2) -ne "MZ") {
    throw "Desktop host image lacks the MZ signature."
  }
  $peOffset = [System.BitConverter]::ToInt32($bytes, 0x3c)
  if ($peOffset -lt 0x40 -or $peOffset -gt ($bytes.Length - 26)) {
    throw "Desktop host image has an invalid PE header offset."
  }
  if ([System.Text.Encoding]::ASCII.GetString($bytes, $peOffset, 4) -ne "PE`0`0") {
    throw "Desktop host image lacks the PE signature."
  }
  $machine = [System.BitConverter]::ToUInt16($bytes, $peOffset + 4)
  $optionalMagic = [System.BitConverter]::ToUInt16($bytes, $peOffset + 24)
  if ($machine -ne 0x8664 -or $optionalMagic -ne 0x20b) {
    throw ("Desktop host image is not a Windows x64 executable (machine=0x{0:x4} magic=0x{1:x4})." -f $machine, $optionalMagic)
  }
  return $info.Length
}

$buildDir = Join-Path ([System.IO.Path]::GetTempPath()) ("superagent-desktop-host-build-" + [guid]::NewGuid().ToString("N"))
New-Item -Path $buildDir -ItemType Directory -Force | Out-Null
try {
  $exe = Join-Path $buildDir "desktop-host.exe"
  Invoke-HostCompile $exe
  $imageSize = Assert-HostImage $exe
  $digest = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($digest -notmatch '^[a-f0-9]{64}$') {
    throw "Desktop host digest is unavailable."
  }

  New-Item -Path $destination -ItemType Directory -Force | Out-Null
  Copy-Item -LiteralPath $exe -Destination (Join-Path $destination "desktop-host.exe") -Force
  [System.IO.File]::WriteAllText(
    (Join-Path $destination "desktop-host.sha256"),
    $digest + [Environment]::NewLine,
    [System.Text.Encoding]::ASCII
  )
  Write-Output ("DESKTOP_HOST_BUILD_PASS sha256=" + $digest + " size=" + $imageSize + " output=" + $destination)
} finally {
  # Only remove the scratch folder allocated by this invocation.
  if (Test-Path -LiteralPath $buildDir) {
    Remove-Item -LiteralPath $buildDir -Recurse -Force
  }
}
