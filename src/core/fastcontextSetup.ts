/**
 * fastcontextSetup.ts — Auto-detect and install FastContext on startup.
 *
 * Checks if the project-local Python + FastContext environment is set up.
 * If not, runs the platform-appropriate setup script automatically.
 *
 * Called from cli.tsx at startup. Non-blocking: if setup fails, a warning
 * is printed and Superagent continues — the fastcontext tool will report
 * the missing environment when actually invoked.
 */

import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Project root: go up from dist/core/ or src/core/ */
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

/** Expected Python binary path per platform. */
const PYTHON_BIN = process.platform === "win32"
  ? path.join(PROJECT_ROOT, "bin", "python", "python.exe")
  : path.join(PROJECT_ROOT, "bin", "python", "bin", "python3");

/** Setup script per platform. */
const SETUP_SCRIPT = process.platform === "win32"
  ? path.join(PROJECT_ROOT, "bin", "setup-fastcontext.ps1")
  : path.join(PROJECT_ROOT, "bin", "setup-fastcontext.sh");

/** Vendor source directory (must also exist). */
const VENDOR_SRC = path.join(PROJECT_ROOT, "vendor", "fastcontext", "src");

/**
 * Check if FastContext is fully set up.
 * Returns true if both the Python binary and vendor source exist.
 */
export function isFastContextReady(): boolean {
  return existsSync(PYTHON_BIN) && existsSync(VENDOR_SRC);
}

/**
 * Run the FastContext setup script synchronously.
 * Prints progress to stdout so the user sees what's happening.
 */
export function runFastContextSetup(): void {
  if (isFastContextReady()) {
    return;
  }

  if (!existsSync(SETUP_SCRIPT)) {
    console.log(
      "[FastContext] Setup script not found. FastContext tool will be unavailable.\n" +
      `  Expected: ${SETUP_SCRIPT}`
    );
    return;
  }

  console.log("");
  console.log("  ╔═══════════════════════════════════════════════════╗");
  console.log("  ║  FastContext — First-time setup                   ║");
  console.log("  ║  Installing portable Python + code explorer...    ║");
  console.log("  ╚═══════════════════════════════════════════════════╝");
  console.log("");

  try {
    if (process.platform === "win32") {
      // PowerShell: bypass execution policy for this invocation
      execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${SETUP_SCRIPT}"`,
        {
          cwd: PROJECT_ROOT,
          stdio: "inherit",
          timeout: 300_000, // 5 minute timeout
        }
      );
    } else {
      // Linux/macOS: run bash script
      execSync(`bash "${SETUP_SCRIPT}"`, {
        cwd: PROJECT_ROOT,
        stdio: "inherit",
        timeout: 300_000,
      });
    }

    // Verify after setup
    if (isFastContextReady()) {
      console.log("");
      console.log("  ✔ FastContext setup complete.");
      console.log("");
    } else {
      console.log("");
      console.log("  ⚠ FastContext setup finished but verification failed.");
      console.log("    The fastcontext tool may not work until manually fixed.");
      console.log("");
    }
  } catch (err: any) {
    console.log("");
    console.log(`  ⚠ FastContext setup failed: ${err.message || err}`);
    console.log("    The fastcontext tool will be unavailable until setup succeeds.");
    console.log("    You can retry manually:");
    if (process.platform === "win32") {
      console.log("      .\\bin\\setup-fastcontext.ps1");
    } else {
      console.log("      bash bin/setup-fastcontext.sh");
    }
    console.log("");
  }
}
