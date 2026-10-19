import { execa } from "execa";
import { findTunnelClientBinary } from "../mcp/openaiTunnelClient.js";
import { getSystemCheckCache, updateSystemCheckCache } from "../config/systemCache.js";
import { DownloadProgressCallback, logSetupDebug } from "../androidSetup.js";

let cachedTunnelClientAvailable: boolean | null = null;

export function clearTunnelClientCache(): void {
  cachedTunnelClientAvailable = null;
}

export async function isTunnelClientAvailable(): Promise<boolean> {
  if (cachedTunnelClientAvailable !== null) return cachedTunnelClientAvailable;
  const sysCache = getSystemCheckCache();
  if (sysCache?.openaiTunnelClient !== undefined) {
    cachedTunnelClientAvailable = sysCache.openaiTunnelClient;
    return cachedTunnelClientAvailable;
  }
  const binary = findTunnelClientBinary();
  cachedTunnelClientAvailable = Boolean(binary);
  updateSystemCheckCache({ openaiTunnelClient: cachedTunnelClientAvailable });
  return cachedTunnelClientAvailable;
}

export async function ensureTunnelClientInstalled(onProgress?: DownloadProgressCallback): Promise<void> {
  try {
    await logSetupDebug("Starting OpenAI Tunnel Client installation check...");
    if (await isTunnelClientAvailable()) {
      await logSetupDebug("OpenAI tunnel-client is already installed.");
      if (onProgress) onProgress(0, 0, "done");
      return;
    }

    await logSetupDebug("tunnel-client not found. Attempting automatic installation via npm install -g @openai/tunnel-client...");
    if (onProgress) {
      onProgress(0, 0, "downloading");
    }

    try {
      await execa("npm", ["install", "-g", "@openai/tunnel-client"], {
        stdio: "ignore",
        timeout: 45000,
      });
    } catch (npmErr: any) {
      await logSetupDebug(`npm install -g @openai/tunnel-client exited with: ${npmErr?.message || npmErr}`);
    }

    clearTunnelClientCache();
    const found = Boolean(findTunnelClientBinary());
    cachedTunnelClientAvailable = found;
    updateSystemCheckCache({ openaiTunnelClient: found });

    if (found) {
      await logSetupDebug("tunnel-client installed successfully.");
    } else {
      await logSetupDebug("tunnel-client was not found after install attempt; continuing gracefully.");
    }

    if (onProgress) onProgress(0, 0, "done");
  } catch (err: any) {
    await logSetupDebug(`Warning: Failed to ensure tunnel-client installed: ${err?.message || err}`);
    if (onProgress) onProgress(0, 0, "done");
  }
}
