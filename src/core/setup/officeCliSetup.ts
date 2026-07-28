import fs from "fs/promises";
import path from "path";
import os from "os";
import { execa } from "execa";
import { getGlobalConfigDir } from "../config.js";
import { DownloadProgressCallback, logSetupDebug } from "../androidSetup.js";

let cachedOfficeCliInstalledLocally: boolean | null = null;

export function clearOfficeCliCache() {
  cachedOfficeCliInstalledLocally = null;
}

export function getLocalBinDir(): string {
  return path.join(getGlobalConfigDir(), "bin");
}

export function getLocalOfficeCliPath(): string {
  const binDir = getLocalBinDir();
  const exeName = process.platform === "win32" ? "officecli.exe" : "officecli";
  return path.join(binDir, exeName);
}

export async function isOfficeCliInstalledLocally(): Promise<boolean> {
  if (cachedOfficeCliInstalledLocally !== null) {
    return cachedOfficeCliInstalledLocally;
  }
  const localPath = getLocalOfficeCliPath();
  try {
    await fs.access(localPath);
    cachedOfficeCliInstalledLocally = true;
    return true;
  } catch {
    cachedOfficeCliInstalledLocally = false;
    return false;
  }
}

export async function isOfficeCliInstalledGlobally(): Promise<boolean> {
  const isWin = process.platform === "win32";
  try {
    await execa(isWin ? "where.exe" : "which", ["officecli"]);
    return true;
  } catch {
    return false;
  }
}

export async function isOfficeCliAvailable(): Promise<boolean> {
  return (await isOfficeCliInstalledLocally()) || (await isOfficeCliInstalledGlobally());
}

function getOfficeCliBinaryName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32") {
    return arch === "arm64" ? "officecli-win-arm64.exe" : "officecli-win-x64.exe";
  } else if (platform === "darwin") {
    return arch === "arm64" ? "officecli-darwin-arm64" : "officecli-darwin-x64";
  } else {
    return arch === "arm64" ? "officecli-linux-arm64" : "officecli-linux-x64";
  }
}

async function fetchWithRetry(url: string, retries = 3, delay = 2000): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP status ${res.status}`);
      }
      return res;
    } catch (err: any) {
      if (i === retries - 1) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("Failed to fetch after max retries");
}

export async function ensureOfficeCliInstalled(onProgress?: DownloadProgressCallback): Promise<void> {
  try {
    await logSetupDebug("Starting Office CLI installation check...");
    if ((await isOfficeCliInstalledLocally()) || (await isOfficeCliInstalledGlobally())) {
      await logSetupDebug("Office CLI is already installed locally or globally.");
      if (onProgress) onProgress(0, 0, "done");
      return;
    }

    await logSetupDebug("Office CLI not found. Initiating direct binary download...");
    if (onProgress) {
      onProgress(0, 0, "downloading");
    } else {
      console.log("\n⚡ [SYSTEM] officecli not found. Downloading binary... Please wait.");
    }

    const binName = getOfficeCliBinaryName();
    const url = `https://d.officecli.ai/releases/latest/download/${binName}`;
    await logSetupDebug(`Downloading Office CLI binary from ${url}...`);

    const res = await fetchWithRetry(url);
    if (!res.ok) throw new Error(`Failed to download Office CLI binary: HTTP ${res.status}`);

    const totalStr = res.headers.get("content-length");
    const totalBytes = totalStr ? parseInt(totalStr, 10) : 0;
    let downloadedBytes = 0;

    const binDir = getLocalBinDir();
    await fs.mkdir(binDir, { recursive: true });

    const localPath = getLocalOfficeCliPath();
    const tempPath = `${localPath}.tmp`;

    if (!res.body) throw new Error("ReadableStream not supported by fetch response body");

    const reader = (res.body as any).getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        downloadedBytes += value.length;
        if (onProgress) {
          onProgress(downloadedBytes, totalBytes, "downloading");
        }
      }
    }

    const totalBuffer = Buffer.concat(chunks);
    await fs.writeFile(tempPath, totalBuffer);

    if (process.platform !== "win32") {
      await fs.chmod(tempPath, 0o755);
    }

    await fs.rename(tempPath, localPath);

    if (process.platform !== "win32") {
      await fs.chmod(localPath, 0o755);
    }

    cachedOfficeCliInstalledLocally = true;

    await logSetupDebug(`Office CLI downloaded and installed successfully at ${localPath}`);
    if (onProgress) {
      onProgress(downloadedBytes, totalBytes, "done");
    } else {
      console.log("officecli installed successfully.");
    }
  } catch (err: any) {
    await logSetupDebug(`Warning: Failed to auto-install officecli: ${err?.message || err}`);
    console.error("Warning: Failed to auto-install officecli:", err);
    if (onProgress) onProgress(0, 0, "error");
    throw err;
  }
}
