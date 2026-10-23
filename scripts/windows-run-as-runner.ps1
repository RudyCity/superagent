# Launch SuperAgent under a separate standard Windows account.
# Windows owns the logon token. Credentials are prompted securely, never persisted by this script.
param(
 [Parameter(Mandatory=$true)][string]$Runner,
 [Parameter(Mandatory=$true)][string]$Workspace,
 [ValidateSet('cli','mcp')][string]$Mode='cli',
 [string]$DeniedProbePath,
 [switch]$DryRun
)
$ErrorActionPreference='Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows only' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($Runner -eq $identity -or $Runner -eq $env:USERNAME -or $Runner -match '^(Administrators|SYSTEM|Everyone|Users)$') { throw 'Dedicated runner account required' }
$account=[System.Security.Principal.NTAccount]::new($Runner)
$runnerSid=$account.Translate([System.Security.Principal.SecurityIdentifier])
$canonicalRunner=$runnerSid.Translate([System.Security.Principal.NTAccount]).Value
$resolvedWorkspace=[IO.Path]::GetFullPath($Workspace)
if (-not (Test-Path -LiteralPath $resolvedWorkspace -PathType Container)) { throw "Workspace not found: $resolvedWorkspace" }
$bun=(Get-Command bun.exe -ErrorAction Stop).Source
$entry=Join-Path $resolvedWorkspace 'src\cli.tsx'
if (-not (Test-Path -LiteralPath $entry)) { throw "SuperAgent CLI entry not found: $entry" }
if ($Mode -eq 'mcp') { throw 'Interactive MCP STDIO requires a dedicated OS-account transport; not supported by this launcher. Run the entire MCP server under the runner account using a service manager.' }
Write-Output "Executable: $bun"
Write-Output "Workspace: $resolvedWorkspace"
Write-Output "Runner: $canonicalRunner"
if ($DeniedProbePath) {
  if (-not (Test-Path -LiteralPath $DeniedProbePath -PathType Leaf)) { throw "Probe must be an existing file: $DeniedProbePath" }
  Write-Output "Denied probe: $DeniedProbePath"
}
if ($DryRun) { Write-Output 'DRY RUN: no process launched'; exit 0 }
if (-not $DeniedProbePath) { throw "-DeniedProbePath is required for strict sandbox verification" }
$credential=Get-Credential -UserName $Runner -Message 'Enter dedicated non-admin runner account credentials (not stored)'
$previous = @{
  REQUIRED=$env:SUPERAGENT_REQUIRE_OS_SANDBOX
  IDENTITY=$env:SUPERAGENT_OS_RUNNER_IDENTITY
  PROBE=$env:SUPERAGENT_OS_DENIED_PROBE_PATH
}
try {
  $env:SUPERAGENT_REQUIRE_OS_SANDBOX = '1'
  $env:SUPERAGENT_OS_RUNNER_IDENTITY = $canonicalRunner
  $env:SUPERAGENT_OS_DENIED_PROBE_PATH = [IO.Path]::GetFullPath($DeniedProbePath)
  Start-Process -FilePath $bun -ArgumentList @('run', ('"{0}"' -f $entry)) -WorkingDirectory $resolvedWorkspace -Credential $credential -LoadUserProfile -Wait
} finally {
  $env:SUPERAGENT_REQUIRE_OS_SANDBOX = $previous.REQUIRED
  $env:SUPERAGENT_OS_RUNNER_IDENTITY = $previous.IDENTITY
  $env:SUPERAGENT_OS_DENIED_PROBE_PATH = $previous.PROBE
}
