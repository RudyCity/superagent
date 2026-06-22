#!/usr/bin/env bash
# setup-fastcontext.sh — One-time setup for FastContext inside the project (Linux/macOS).
#
# Creates a fully self-contained environment:
#   bin/python/           — Standalone Python 3.12 + pip + deps
#   vendor/fastcontext/   — FastContext source code
#
# Usage:
#   bash bin/setup-fastcontext.sh
#
# After this, no system Python, uv, or external packages are needed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$PROJECT_ROOT/bin"
PYTHON_DIR="$BIN_DIR/python"
VENDOR_DIR="$PROJECT_ROOT/vendor"
FC_DIR="$VENDOR_DIR/fastcontext"

PYTHON_VER="3.12.11"
PBS_TAG="20260610"
PBS_BASE="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}"

echo ""
echo "=== FastContext Project-Local Setup (Linux/macOS) ==="
echo "Project root: $PROJECT_ROOT"
echo ""

# ── Step 1: Clone FastContext source ────────────────────────────────────────
echo "[1/4] Cloning FastContext source..."
if [ -d "$FC_DIR" ]; then
    echo "  Already exists at vendor/fastcontext/ — pulling latest..."
    git -C "$FC_DIR" pull --ff-only 2>/dev/null || echo "  Pull failed, keeping existing source."
else
    mkdir -p "$VENDOR_DIR"
    git clone https://github.com/microsoft/fastcontext.git "$FC_DIR"
fi
echo "  Done."

# ── Step 2: Download standalone Python ─────────────────────────────────────
PYTHON_BIN="$PYTHON_DIR/bin/python3"
echo "[2/4] Setting up standalone Python ${PYTHON_VER}..."
if [ -x "$PYTHON_BIN" ]; then
    echo "  Python already exists at bin/python/ — skipping download."
else
    # Detect OS and architecture
    OS="$(uname -s)"
    ARCH="$(uname -m)"

    case "$OS" in
        Linux)  PBS_OS="unknown-linux-gnu" ;;
        Darwin) PBS_OS="apple-darwin" ;;
        *)      echo "ERROR: Unsupported OS: $OS"; exit 1 ;;
    esac

    case "$ARCH" in
        x86_64|amd64)  PBS_ARCH="x86_64" ;;
        aarch64|arm64) PBS_ARCH="aarch64" ;;
        *)             echo "ERROR: Unsupported architecture: $ARCH"; exit 1 ;;
    esac

    TARBALL="cpython-${PYTHON_VER}+${PBS_TAG}-${PBS_ARCH}-${PBS_OS}-install_only.tar.gz"
    URL="${PBS_BASE}/${TARBALL}"
    TMP_TAR="/tmp/${TARBALL}"

    echo "  Downloading $TARBALL ..."
    if command -v curl &>/dev/null; then
        curl -L -o "$TMP_TAR" "$URL"
    elif command -v wget &>/dev/null; then
        wget -O "$TMP_TAR" "$URL"
    else
        echo "ERROR: Neither curl nor wget found. Install one and retry."
        exit 1
    fi

    mkdir -p "$PYTHON_DIR"
    echo "  Extracting to bin/python/ ..."
    tar xzf "$TMP_TAR" -C "$PYTHON_DIR" --strip-components=1
    rm -f "$TMP_TAR"

    # The standalone build puts Python under python/ subfolder after strip-components
    # Verify the binary exists (might be at bin/python/ or python/bin/python3)
    if [ ! -x "$PYTHON_BIN" ]; then
        # Try alternate layout
        ALT_BIN="$PYTHON_DIR/python/bin/python3"
        if [ -x "$ALT_BIN" ]; then
            # Move contents up
            mv "$PYTHON_DIR/python/"* "$PYTHON_DIR/" 2>/dev/null || true
            rm -rf "$PYTHON_DIR/python"
        fi
    fi
fi
echo "  Done."

# ── Step 3: Install pip + FastContext dependencies ─────────────────────────
echo "[3/4] Installing FastContext dependencies..."
"$PYTHON_BIN" -m ensurepip --upgrade 2>/dev/null || true
"$PYTHON_BIN" -m pip install --no-warn-script-location --quiet \
    "aiofiles>=25.1.0" \
    "asyncio>=4.0.0" \
    "azure-core>=1.39.0" \
    "azure-identity>=1.25.3" \
    "jinja2>=3.1.6" \
    "litellm>=1.74.0" \
    "openai>=2.15.0" \
    "pydantic>=2.12.5"
echo "  Done."

# ── Step 4: Verify installation ────────────────────────────────────────────
echo "[4/4] Verifying installation..."
export PYTHONPATH="$FC_DIR/src:${PYTHONPATH:-}"
VERIFY_RESULT=$("$PYTHON_BIN" -c "
import sys
sys.path.insert(0, '$FC_DIR/src')
from fastcontext.agent.agent import Agent
from fastcontext.agent.llm import LLM
from fastcontext.agent.tool.glob import GlobTool
from fastcontext.agent.tool.grep import GrepTool
from fastcontext.agent.tool.read import ReadTool
from fastcontext.agent.tool.tool import ToolSet
from fastcontext.agent.utils import load_system_prompt
print('All FastContext imports OK')
try:
    import litellm
    print(f'LiteLLM {litellm.__version__} OK')
except ImportError:
    print('LiteLLM not installed — FastContext will use OpenAI SDK only (Anthropic/custom providers may not work)')
" 2>&1) || {
    echo "  FAILED: $VERIFY_RESULT"
    exit 1
}
echo "  $VERIFY_RESULT"

# Create sentinel file to indicate successful verification
touch "$PYTHON_DIR/.verified"

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Setup Complete ==="
echo "  Python:     $PYTHON_BIN"
echo "  Source:     $FC_DIR"
echo "  Runner:     $PROJECT_ROOT/src/core/tools/fastcontext_runner.py"
echo ""
echo "FastContext is now fully self-contained in this project."
echo "No system Python, uv, or external packages required."
echo ""
