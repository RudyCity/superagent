# Windows wrapper for the cross-platform effect-guard audit.
# The audit itself is Bun/TypeScript so CI (Linux/macOS/Windows) runs one code
# path; this wrapper only exists for operators who prefer PowerShell.
$ErrorActionPreference = "Stop"

$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) {
  Write-Error "Bun is required to run the effect-guard audit."
  exit 2
}

& $bun (Join-Path $PSScriptRoot "audit-effect-guards.ts") @args
exit $LASTEXITCODE
