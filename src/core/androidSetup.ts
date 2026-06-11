import fs from "fs/promises";
import path from "path";
import os from "os";
import { execa } from "execa";
import { getGlobalConfigDir } from "./config.js";

// Helper function to fetch resources with retry logic
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
      console.log(`⚠️ Connection failed. Retrying download (${i + 1}/${retries}) in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error(`Failed to fetch ${url}`);
}

export async function isAndroidCliInstalledGlobally(): Promise<boolean> {
  const isWin = process.platform === "win32";
  try {
    await execa(isWin ? "where.exe" : "which", ["android"]);
    return true;
  } catch {
    return false;
  }
}

export function getLocalAndroidCliPath(): string {
  const isWin = process.platform === "win32";
  if (isWin) {
    const userProfile = process.env.USERPROFILE || process.env.HOMEPATH || "C:\\Users\\USER";
    return path.join(userProfile, "AppData", "AndroidCLI", "android.exe");
  } else {
    const home = process.env.HOME || "";
    return path.join(home, ".android-cli", "bin", "android");
  }
}

export async function isAndroidCliInstalledLocally(): Promise<boolean> {
  try {
    await fs.access(getLocalAndroidCliPath());
    return true;
  } catch {
    return false;
  }
}

let cachedRgInstalledGlobally: boolean | null = null;
export async function isRgInstalledGlobally(): Promise<boolean> {
  if (cachedRgInstalledGlobally !== null) return cachedRgInstalledGlobally;
  const isWin = process.platform === "win32";
  try {
    await execa(isWin ? "where.exe" : "which", ["rg"]);
    cachedRgInstalledGlobally = true;
  } catch {
    cachedRgInstalledGlobally = false;
  }
  return cachedRgInstalledGlobally;
}

export function getLocalBinDir(): string {
  return path.join(getGlobalConfigDir(), "bin");
}

export function getLocalRgPath(): string {
  const isWin = process.platform === "win32";
  return path.join(getLocalBinDir(), isWin ? "rg.exe" : "rg");
}

let cachedRgInstalledLocally: boolean | null = null;
export async function isRgInstalledLocally(): Promise<boolean> {
  if (cachedRgInstalledLocally !== null) return cachedRgInstalledLocally;
  try {
    await fs.access(getLocalRgPath());
    cachedRgInstalledLocally = true;
  } catch {
    cachedRgInstalledLocally = false;
  }
  return cachedRgInstalledLocally;
}

export async function ensureRgInstalled(): Promise<void> {
  try {
    if (await isRgInstalledGlobally() || await isRgInstalledLocally()) {
      return;
    }

    const isWin = process.platform === "win32";
    const isMac = process.platform === "darwin";
    const isArm = process.arch === "arm64";

    console.log("\n⚡ [SYSTEM] ripgrep (rg) not found. Downloading and installing locally... Please wait.");
    const binDir = getLocalBinDir();
    await fs.mkdir(binDir, { recursive: true });

    let downloadUrl = "";
    let archiveName = "";
    if (isWin) {
      downloadUrl = "https://github.com/BurntSushi/ripgrep/releases/download/14.1.0/ripgrep-14.1.0-x86_64-pc-windows-msvc.zip";
      archiveName = "rg.zip";
    } else if (isMac) {
      downloadUrl = isArm
        ? "https://github.com/BurntSushi/ripgrep/releases/download/14.1.0/ripgrep-14.1.0-aarch64-apple-darwin.tar.gz"
        : "https://github.com/BurntSushi/ripgrep/releases/download/14.1.0/ripgrep-14.1.0-x86_64-apple-darwin.tar.gz";
      archiveName = "rg.tar.gz";
    } else {
      downloadUrl = "https://github.com/BurntSushi/ripgrep/releases/download/14.1.0/ripgrep-14.1.0-x86_64-unknown-linux-musl.tar.gz";
      archiveName = "rg.tar.gz";
    }

    const tempFile = path.join(os.tmpdir(), archiveName);
    const res = await fetchWithRetry(downloadUrl);
    const buffer = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(tempFile, buffer);

    const tempExtractDir = path.join(os.tmpdir(), "rg-extract");
    await fs.mkdir(tempExtractDir, { recursive: true });

    if (isWin) {
      await execa(`powershell.exe`, ["-Command", `Expand-Archive -Path '${tempFile}' -DestinationPath '${tempExtractDir}' -Force`]);
      const files = await fs.readdir(tempExtractDir, { recursive: true });
      const rgExe = files.find(f => f.endsWith("rg.exe"));
      if (rgExe) {
        const fullSrc = path.join(tempExtractDir, rgExe);
        const fullDest = getLocalRgPath();
        await fs.rename(fullSrc, fullDest);
      }
    } else {
      await execa("tar", ["-xzf", tempFile, "-C", tempExtractDir]);
      const files = await fs.readdir(tempExtractDir, { recursive: true });
      const rgBin = files.find(f => f.endsWith("rg") && !f.includes("."));
      if (rgBin) {
        const fullSrc = path.join(tempExtractDir, rgBin);
        const fullDest = getLocalRgPath();
        await fs.rename(fullSrc, fullDest);
        await fs.chmod(fullDest, 0o755);
      }
    }

    try {
      await fs.unlink(tempFile);
      await fs.rm(tempExtractDir, { recursive: true, force: true });
    } catch {}

    console.log("ripgrep (rg) installed successfully.");
  } catch (err) {
    console.error("Warning: Failed to auto-install ripgrep:", err);
  }
}

export async function isCurlInstalledGlobally(): Promise<boolean> {
  const isWin = process.platform === "win32";
  try {
    await execa(isWin ? "where.exe" : "which", ["curl"]);
    return true;
  } catch {
    return false;
  }
}

export function getLocalCurlPath(): string {
  const isWin = process.platform === "win32";
  return path.join(getLocalBinDir(), isWin ? "curl.exe" : "curl");
}

export async function isCurlInstalledLocally(): Promise<boolean> {
  try {
    await fs.access(getLocalCurlPath());
    return true;
  } catch {
    return false;
  }
}

export async function ensureCurlInstalled(): Promise<void> {
  try {
    if (await isCurlInstalledGlobally() || await isCurlInstalledLocally()) {
      return;
    }

    const isWin = process.platform === "win32";
    if (isWin) {
      console.log("\n⚡ [SYSTEM] curl not found. Downloading and installing locally... Please wait.");
      const binDir = getLocalBinDir();
      await fs.mkdir(binDir, { recursive: true });

      const downloadUrl = "https://curl.se/windows/dl-8.4.0_7/curl-8.4.0_7-win64-mingw.zip";
      const tempFile = path.join(os.tmpdir(), "curl.zip");
      const res = await fetchWithRetry(downloadUrl);
      const buffer = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(tempFile, buffer);

      const tempExtractDir = path.join(os.tmpdir(), "curl-extract");
      await fs.mkdir(tempExtractDir, { recursive: true });

      await execa(`powershell.exe`, ["-Command", `Expand-Archive -Path '${tempFile}' -DestinationPath '${tempExtractDir}' -Force`]);
      const files = await fs.readdir(tempExtractDir, { recursive: true });
      const curlExe = files.find(f => f.endsWith("curl.exe"));
      if (curlExe) {
        await fs.rename(path.join(tempExtractDir, curlExe), getLocalCurlPath());
      }

      try {
        await fs.unlink(tempFile);
        await fs.rm(tempExtractDir, { recursive: true, force: true });
      } catch {}
      console.log("curl installed successfully.");
    } else {
      console.warn("Warning: 'curl' was not found on your system. Please install it using your package manager (e.g. apt, brew).");
    }
  } catch (err) {
    console.error("Warning: Failed to check/install curl:", err);
  }
}

export async function ensureAndroidCliInstalled(): Promise<void> {
  try {
    // 1. Ensure curl and rg are installed first
    await ensureCurlInstalled();
    await ensureRgInstalled();

    // 2. Ensure Android CLI is installed
    if (await isAndroidCliInstalledGlobally() || await isAndroidCliInstalledLocally()) {
      return;
    }

    const isWin = process.platform === "win32";
    const isMac = process.platform === "darwin";
    const isArm = process.arch === "arm64";

    console.log("\n⚡ [SYSTEM] Android CLI not found. Downloading and installing locally... Please wait.");

    if (isWin) {
      const tempCmd = path.join(os.tmpdir(), "install-android-cli.cmd");
      const url = "https://dl.google.com/android/cli/latest/windows_x86_64/install.cmd";
      
      const res = await fetchWithRetry(url);
      const buffer = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(tempCmd, buffer);

      await execa(tempCmd, { shell: true });
      
      try {
        await fs.unlink(tempCmd);
      } catch {}
    } else {
      const downloadUrl = isMac
        ? (isArm 
            ? "https://dl.google.com/android/cli/latest/darwin_arm64/install.sh"
            : "https://dl.google.com/android/cli/latest/darwin_x86_64/install.sh")
        : "https://dl.google.com/android/cli/latest/linux_x86_64/install.sh";
      
      const tempSh = path.join(os.tmpdir(), "install-android-cli.sh");
      const res = await fetchWithRetry(downloadUrl);
      const text = await res.text();
      await fs.writeFile(tempSh, text, { mode: 0o755 });

      await execa(tempSh, { shell: true });

      try {
        await fs.unlink(tempSh);
      } catch {}
    }
    console.log("Android CLI installed successfully.");
  } catch (err) {
    console.error("Warning: Failed to auto-install Android CLI:", err);
  }
}
