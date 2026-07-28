import fs from "fs/promises";
import path from "path";
import os from "os";
import { execa } from "execa";
import { getGlobalConfigDir } from "../config.js";
import { DownloadProgressCallback, logSetupDebug } from "../androidSetup.js";

let cachedPythonInstalled: boolean | null = null;
let cachedPaddleOcrInstalled: boolean | null = null;

export function clearOcrCache() {
  cachedPythonInstalled = null;
  cachedPaddleOcrInstalled = null;
}

export async function isUvInstalledGlobally(): Promise<boolean> {
  const isWin = process.platform === "win32";
  try {
    await execa(isWin ? "where.exe" : "which", ["uv"]);
    return true;
  } catch {
    return false;
  }
}

export async function isUvInstalledLocally(): Promise<boolean> {
  const binDir = path.join(getGlobalConfigDir(), "bin");
  const exeName = process.platform === "win32" ? "uv.exe" : "uv";
  const localPath = path.join(binDir, exeName);
  try {
    await fs.access(localPath);
    return true;
  } catch {
    return false;
  }
}

export function getLocalUvPath(): string {
  const binDir = path.join(getGlobalConfigDir(), "bin");
  const exeName = process.platform === "win32" ? "uv.exe" : "uv";
  return path.join(binDir, exeName);
}

export async function ensureUvInstalled(onProgress?: DownloadProgressCallback): Promise<void> {
  try {
    if ((await isUvInstalledGlobally()) || (await isUvInstalledLocally())) {
      if (onProgress) onProgress(0, 0, "done");
      return;
    }

    if (onProgress) {
      onProgress(0, 0, "downloading");
    } else {
      console.log("\n⚡ [SYSTEM] uv standalone installer not found. Installing uv...");
    }

    const isWin = process.platform === "win32";
    if (isWin) {
      await execa("powershell", [
        "-ExecutionPolicy",
        "ByPass",
        "-c",
        "irm https://astral.sh/uv/install.ps1 | iex"
      ]);
    } else {
      await execa("curl", ["-sSf", "https://astral.sh/uv/install.sh", "|", "sh"], { shell: true });
    }

    if (onProgress) onProgress(0, 0, "done");
  } catch (err: any) {
    if (onProgress) onProgress(0, 0, "error");
    throw err;
  }
}

export async function isPythonInstalled(): Promise<boolean> {
  if (cachedPythonInstalled !== null) return cachedPythonInstalled;
  const isWin = process.platform === "win32";
  try {
    await execa(isWin ? "where.exe" : "which", ["python"]);
    cachedPythonInstalled = true;
    return true;
  } catch {
    try {
      await execa(isWin ? "where.exe" : "which", ["python3"]);
      cachedPythonInstalled = true;
      return true;
    } catch {
      cachedPythonInstalled = false;
      return false;
    }
  }
}

export async function ensurePythonInstalled(onProgress?: DownloadProgressCallback): Promise<void> {
  try {
    if (await isPythonInstalled()) {
      if (onProgress) onProgress(0, 0, "done");
      return;
    }

    await ensureUvInstalled(onProgress);

    if (onProgress) {
      onProgress(0, 0, "downloading");
    } else {
      console.log("\n⚡ [SYSTEM] Python not found. Installing via uv... Please wait.");
    }

    const isWin = process.platform === "win32";
    let uvCmd = "uv";
    if (await isUvInstalledLocally()) {
      uvCmd = getLocalUvPath();
    }

    await execa(uvCmd, ["python", "install"]);

    cachedPythonInstalled = true;
    if (onProgress) onProgress(0, 0, "done");
  } catch (err: any) {
    if (onProgress) onProgress(0, 0, "error");
    throw err;
  }
}

export async function isPaddleOcrAvailable(): Promise<boolean> {
  if (cachedPaddleOcrInstalled !== null) return cachedPaddleOcrInstalled;
  if (!(await isPythonInstalled())) {
    cachedPaddleOcrInstalled = false;
    return false;
  }

  const isWin = process.platform === "win32";
  const pythonCmd = isWin ? "python" : "python3";

  try {
    // Check if PaddleOCR OR PyTesseract + renderer is available
    await execa(pythonCmd, [
      "-c",
      "import sys\ntry:\n import paddleocr, pdf2image\nexcept:\n import pytesseract, pypdfium2",
    ]);
    cachedPaddleOcrInstalled = true;
    return true;
  } catch {
    cachedPaddleOcrInstalled = false;
    return false;
  }
}

export async function ensurePaddleOcrInstalled(onProgress?: DownloadProgressCallback): Promise<void> {
  try {
    if (await isPaddleOcrAvailable()) {
      if (onProgress) onProgress(0, 0, "done");
      return;
    }

    await ensurePythonInstalled(onProgress);

    if (onProgress) {
      onProgress(0, 0, "downloading");
    } else {
      console.log("\n⚡ [SYSTEM] Installing PaddleOCR and pdf2image via pip...");
    }

    const isWin = process.platform === "win32";
    const pythonCmd = isWin ? "python" : "python3";

    await execa(pythonCmd, [
      "-m",
      "pip",
      "install",
      "paddleocr",
      "pytesseract",
      "pypdfium2",
      "pdf2image",
      "pillow",
    ]);

    cachedPaddleOcrInstalled = true;
    if (onProgress) onProgress(0, 0, "done");
  } catch (err: any) {
    await logSetupDebug(`Warning: Failed to auto-install PaddleOCR: ${err?.message || err}`);
    if (onProgress) onProgress(0, 0, "done"); // Optional fallback, treat as done so startup flow continues
  }
}

import { runEnhancedPdfOcr } from "./pdfOcrEngine.js";

export async function runPaddleOcrOnPdf(filePath: string, signal?: AbortSignal): Promise<string> {
  return runEnhancedPdfOcr(filePath, signal);
}
