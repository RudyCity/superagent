# Windows ACL isolation helper for a DEDICATED non-admin runner identity.
# Dry-run by default. Does not launch or impersonate the runner account.
param(
  [Parameter(Mandatory=$true)][ValidateSet('Block','Unblock','Status')][string]$Action,
  [Parameter(Mandatory=$true)][string]$Path,
  [Parameter(Mandatory=$true)][string]$Runner,
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -and $env:OS -ne 'Windows_NT') { throw 'Windows required.' }
$target = [System.IO.Path]::GetFullPath($Path)
if (-not (Test-Path -LiteralPath $target)) { throw "Target does not exist: $target" }
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($Runner.Trim() -eq '' -or $Runner -eq $identity -or $Runner -eq $env:USERNAME -or
    $Runner -match '^(Everyone|BUILTIN\\Users|Users|Authenticated Users|SYSTEM|Administrators|BUILTIN\\Administrators)$') {
  throw 'Runner must be a dedicated account distinct from current user and broad/system groups.'
}
if ([System.IO.Path]::GetPathRoot($target) -eq $target) {
  throw 'Drive-root ACL changes are prohibited by this helper. Restrict selected folders or use a dedicated VM/volume.'
}
try { $account = [System.Security.Principal.NTAccount]::new($Runner)
  $null = $account.Translate([System.Security.Principal.SecurityIdentifier])
} catch { throw "Runner Windows account does not resolve: $Runner" }
if ($Action -eq 'Status') {
  & icacls.exe $target
  exit $LASTEXITCODE
}
$argv = if ($Action -eq 'Block') { @($target, '/deny', ('{0}:(OI)(CI)F' -f $Runner)) }
        else { @($target, '/remove:d', $Runner) }
Write-Output "Action: $Action; Target: $target; Identity: $Runner"
Write-Output "Command: icacls.exe $($argv -join ' ')"
if (-not $Apply) { Write-Output 'DRY RUN ONLY. Re-run with -Apply after reviewing ACLs, user membership, and backups.'; exit 0 }
$backup = Join-Path $env:TEMP ('superagent-acl-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
$parent = Split-Path -Parent $target
$leaf = Split-Path -Leaf $target
Push-Location $parent
try {
  & icacls.exe $leaf /save $backup /T
  if ($LASTEXITCODE -ne 0) { throw 'ACL backup failed; refusing changes.' }
} finally { Pop-Location }
Write-Output "ACL backup: $backup"
& icacls.exe @argv
if ($LASTEXITCODE -ne 0) { throw "ACL change failed with exit code $LASTEXITCODE" }
Write-Output 'ACL changed. Verify with the runner identity and separately test rollback before production.'
