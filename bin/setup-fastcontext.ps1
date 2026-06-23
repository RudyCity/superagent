# setup-fastcontext.ps1 - One-time setup for FastContext inside the project.
#
# Creates a fully self-contained environment:
#   bin/python/           - Portable Python 3.12 (embeddable) + pip + deps
#   vendor/fastcontext/   - FastContext source code
#
# Usage:
#   .\bin\setup-fastcontext.ps1
#
# After this, no external Python, uv, or system packages are needed.

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$BinDir = Join-Path $ProjectRoot "bin"
$PythonDir = Join-Path $BinDir "python"
$VendorDir = Join-Path $ProjectRoot "vendor"
$FastContextDir = Join-Path $VendorDir "fastcontext"

Write-Host ""
Write-Host "=== FastContext Project-Local Setup ===" -ForegroundColor Cyan
Write-Host "Project root: $ProjectRoot"
Write-Host ""

# == Step 1: Clone FastContext source ========================================
Write-Host "[1/5] Cloning FastContext source..." -ForegroundColor Yellow
if (Test-Path $FastContextDir) {
    Write-Host "  Already exists at vendor/fastcontext/ - pulling latest..."
    git -C $FastContextDir pull --ff-only 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Pull failed, keeping existing source." -ForegroundColor DarkYellow
    }
} else {
    New-Item -ItemType Directory -Path $VendorDir -Force | Out-Null
    git clone https://github.com/microsoft/fastcontext.git $FastContextDir
    if ($LASTEXITCODE -ne 0) { throw "Failed to clone FastContext" }
}
Write-Host "  Done." -ForegroundColor Green

# == Step 2: Download portable Python =======================================
$PythonExe = Join-Path $PythonDir "python.exe"
Write-Host "[2/5] Setting up portable Python 3.12..." -ForegroundColor Yellow
if (Test-Path $PythonExe) {
    Write-Host "  Python already exists at bin/python/ - skipping download."
} else {
    $PythonVersion = "3.12.10"
    $PythonUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
    $ZipPath = Join-Path $env:TEMP "python-$PythonVersion-embed.zip"

    Write-Host "  Downloading from $PythonUrl ..."
    Invoke-WebRequest -Uri $PythonUrl -OutFile $ZipPath -UseBasicParsing

    New-Item -ItemType Directory -Path $PythonDir -Force | Out-Null
    Write-Host "  Extracting to bin/python/ ..."
    Expand-Archive -Path $ZipPath -DestinationPath $PythonDir -Force
    Remove-Item $ZipPath -Force
}
Write-Host "  Done." -ForegroundColor Green

# == Step 3: Enable pip support ==============================================
Write-Host "[3/5] Enabling pip support..." -ForegroundColor Yellow
$PthFile = Join-Path $PythonDir "python312._pth"
$PthContent = @(
    "python312.zip",
    ".",
    "Lib\site-packages",
    "../../vendor/fastcontext/src",
    "",
    "# Uncomment to run site.main() automatically",
    "import site"
) -join [Environment]::NewLine
Set-Content -Path $PthFile -Value $PthContent -Encoding ASCII

# Install pip if not present
$OldEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$PipCheck = & $PythonExe -m pip --version 2>&1
$ErrorActionPreference = $OldEAP
if ($LASTEXITCODE -ne 0) {
    $GetPipUrl = "https://bootstrap.pypa.io/get-pip.py"
    $GetPipPath = Join-Path $env:TEMP "get-pip.py"
    Write-Host "  Downloading get-pip.py ..."
    Invoke-WebRequest -Uri $GetPipUrl -OutFile $GetPipPath -UseBasicParsing
    Write-Host "  Installing pip ..."
    $OldEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $PythonExe $GetPipPath --no-warn-script-location 2>&1 | Out-Null
    $ErrorActionPreference = $OldEAP
    Remove-Item $GetPipPath -Force
} else {
    Write-Host "  pip already installed."
}
Write-Host "  Done." -ForegroundColor Green

# == Step 4: Install FastContext dependencies ================================
Write-Host "[4/5] Installing FastContext dependencies..." -ForegroundColor Yellow
$LocalSitePackages = Join-Path $PythonDir "Lib\site-packages"
$OldEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $PythonExe -m pip install --no-warn-script-location --upgrade --target "$LocalSitePackages" --quiet `
    "aiofiles>=25.1.0" `
    "asyncio>=4.0.0" `
    "azure-core>=1.39.0" `
    "azure-identity>=1.25.3" `
    "jinja2>=3.1.6" `
    "litellm>=1.74.0" `
    "openai>=2.15.0" `
    "pydantic>=2.12.5" 2>&1
$ErrorActionPreference = $OldEAP
if ($LASTEXITCODE -ne 0) { throw "Failed to install dependencies" }
Write-Host "  Done." -ForegroundColor Green

# == Step 5: Verify installation ============================================
Write-Host "[5/5] Verifying installation..." -ForegroundColor Yellow
$VerifyScript = @(
    "from fastcontext.agent.agent import Agent",
    "from fastcontext.agent.llm import LLM",
    "from fastcontext.agent.tool.glob import GlobTool",
    "from fastcontext.agent.tool.grep import GrepTool",
    "from fastcontext.agent.tool.read import ReadTool",
    "from fastcontext.agent.tool.tool import ToolSet",
    "from fastcontext.agent.utils import load_system_prompt",
    "print('All FastContext imports OK')",
    "try:",
    "    import litellm",
    "    import importlib.metadata",
    "    print(f'LiteLLM {importlib.metadata.version('litellm')} OK')",
    "except ImportError:",
    "    print('LiteLLM not installed - FastContext will use OpenAI SDK only (Anthropic/custom providers may not work)')"
) -join [Environment]::NewLine
$OldEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$VerifyResult = & $PythonExe -c $VerifyScript 2>&1
$ErrorActionPreference = $OldEAP
if ($LASTEXITCODE -ne 0) {
    Write-Host "  FAILED: $VerifyResult" -ForegroundColor Red
    throw "FastContext verification failed"
}
Write-Host "  $VerifyResult" -ForegroundColor Green

# Create sentinel file to indicate successful verification
$SentinelFile = Join-Path $PythonDir ".verified"
Set-Content -Path $SentinelFile -Value "verified" -Encoding ASCII

# == Summary =================================================================
Write-Host ""
Write-Host "=== Setup Complete ===" -ForegroundColor Cyan
Write-Host "  Python:     $PythonExe"
Write-Host "  Source:     $FastContextDir"
Write-Host "  Runner:     $(Join-Path $ProjectRoot 'src\core\tools\fastcontext_runner.py')"
Write-Host ""
Write-Host "FastContext is now fully self-contained in this project."
Write-Host "No system Python, uv, or external packages required."
Write-Host ""
