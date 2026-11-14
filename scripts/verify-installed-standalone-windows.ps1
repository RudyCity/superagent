# Smoke-test the actual NSIS install on a disposable GitHub Windows runner.
# Intentionally NOT invoked by local builds: this writes the current user's installer state.
$ErrorActionPreference = "Stop"
if (-not $env:RUNNER_TEMP) { throw "Installed-E2E gate is reserved for disposable GitHub runners" }
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$setup = (Resolve-Path "apps/superagent-tray/src-tauri/target/release/bundle/nsis/SuperAgent_${version}_x64-setup.exe").Path
$destination = Join-Path $env:RUNNER_TEMP "superagent-standalone-$version"
if (Test-Path $destination) { throw "Refusing to reuse nonempty install destination: $destination" }

Write-Output "Installing release candidate into isolated disposable runner location..."
$installed = Start-Process -FilePath $setup -ArgumentList @("/S", "/D=$destination") -Wait -PassThru
if ($installed.ExitCode -ne 0) { throw "Installer exit code: $($installed.ExitCode)" }
$cli = Join-Path $destination "superagent.exe"
$runtime = Join-Path $destination "bun.exe"
$entry = Join-Path $destination "standalone/dist/cli.js"
$deps = Join-Path $destination "standalone/node_modules/ink"
foreach ($required in @($cli, $runtime, $entry, $deps)) {
  if (!(Test-Path $required)) { throw "Missing installed payload: $required" }
}
# Verify the installed module/binary/receipt using the installed Bun, not
# source checkout paths. This also runs independently on temporary fixtures.
& (Join-Path $PSScriptRoot "verify-installed-wgc.ps1") -InstallRoot $destination
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $cli
$psi.Arguments = "--version"
$psi.WorkingDirectory = $destination
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$psi.Environment["PATH"] = "$env:SystemRoot\System32"
foreach ($key in @("BUN_EXECUTABLE","SUPERAGENT_CLI_PATH","SUPERAGENT_EXECUTABLE","NODE_PATH")) {
  $psi.Environment.Remove($key) | Out-Null
}
$process = [System.Diagnostics.Process]::Start($psi)
try {
  if (!$process.WaitForExit(60000)) {
    $process.Kill()
    throw "Installed CLI failed to return within 60 seconds"
  }
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  if ($process.ExitCode -ne 0 -or !$stdout.Contains($version)) {
    throw "Installed CLI failed: code=$($process.ExitCode); output=$stdout stderr=$stderr"
  }
  Write-Output "Installed portable CLI PASS, version $version, no global runtime."
} finally {
  $process.Dispose()
}
$uninstaller = Join-Path $destination "uninstall.exe"
if (Test-Path $uninstaller) {
  $removed = Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait -PassThru
  if ($removed.ExitCode -ne 0) { throw "Uninstaller returned $($removed.ExitCode)" }
  Write-Output "NSIS uninstaller PASS."
}
