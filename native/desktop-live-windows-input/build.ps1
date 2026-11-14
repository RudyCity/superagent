# Build only the fixed local UI Automation input helper.
# No downloads/install, service start, live user-app control or deployment.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$programFiles86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
$vswhere = Join-Path $programFiles86 "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere)) { throw "MSVC Build Tools missing." }
$install = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if (-not $install) { throw "Windows x64 compiler unavailable." }
$vcvars = Join-Path $install "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path -LiteralPath $vcvars)) { throw "VC x64 environment missing." }
Push-Location $here
try {
  $line = 'call "' + $vcvars + '" >nul && cl /nologo /std:c++17 /O2 /W4 /EHsc /LD /DWIN32_LEAN_AND_MEAN /DUNICODE /D_UNICODE windowsRemoteSemantic.cpp /link /OUT:winremote.dll uiautomationcore.lib ole32.lib oleaut32.lib user32.lib advapi32.lib dwmapi.lib'
  cmd.exe /d /s /c $line
  if ($LASTEXITCODE -ne 0) { throw "Native x64 compile failed: $LASTEXITCODE" }
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $here 'winremote.dll')).Hash.ToLowerInvariant()
  [System.IO.File]::WriteAllText((Join-Path $here 'winremote.sha256'), $hash + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
  Write-Output "Native DLL and SHA-256 receipt created; NOT installed or enabled."
} finally { Pop-Location }
