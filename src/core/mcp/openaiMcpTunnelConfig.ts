/**
 * Persistent configuration for the OpenAI Secure MCP Tunnel.
 *
 * Tunnel IDs are identifiers, but the runtime control-plane API key is a
 * credential and is encrypted at rest with SuperAgent's shared secret store.
 */
import fs from "fs";
import path from "path";
import { decryptSecret, encryptSecret } from "../config/secretStore.js";
import { getRootConfigDir } from "../config/paths.js";

const CONFIG_FILE = "openai-mcp-tunnel.json";

interface StoredOpenAiMcpTunnelConfig {
  version: 1;
  tunnelId?: string;
  apiKey?: string;
}

export interface OpenAiMcpTunnelConfig {
  tunnelId?: string;
  /** Decrypted in memory only. Never print or persist this value directly. */
  apiKey?: string;
}

function getConfigPath(): string {
  return path.join(getRootConfigDir(), CONFIG_FILE);
}

function readStoredConfig(): StoredOpenAiMcpTunnelConfig {
  const filePath = getConfigPath();
  if (!fs.existsSync(filePath)) return { version: 1 };

  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<StoredOpenAiMcpTunnelConfig>;
  if (!parsed || parsed.version !== 1) {
    throw new Error(`Invalid OpenAI MCP tunnel configuration in ${filePath}. Back up and repair this file before continuing.`);
  }

  return {
    version: 1,
    ...(typeof parsed.tunnelId === "string" && parsed.tunnelId.trim() ? { tunnelId: parsed.tunnelId.trim() } : {}),
    ...(typeof parsed.apiKey === "string" && parsed.apiKey ? { apiKey: parsed.apiKey } : {}),
  };
}

function writeStoredConfig(config: StoredOpenAiMcpTunnelConfig): void {
  const filePath = getConfigPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(tempPath, 0o600); } catch {}
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw error;
  }
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function isValidTunnelId(value: string): boolean {
  const clean = value.trim();
  return clean.length >= 8 && /^[a-zA-Z0-9_\-.:]+$/.test(clean);
}

export function getOpenAiMcpTunnelConfig(): OpenAiMcpTunnelConfig {
  const stored = readStoredConfig();
  const apiKey = stored.apiKey ? decryptSecret(stored.apiKey) : "";
  return {
    ...(stored.tunnelId ? { tunnelId: stored.tunnelId } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

export function getOpenAiMcpTunnelConfigStatus(): {
  tunnelId?: string;
  apiKeyConfigured: boolean;
  apiKeyHint?: string;
} {
  const config = getOpenAiMcpTunnelConfig();
  return {
    ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
    apiKeyConfigured: Boolean(config.apiKey),
    ...(config.apiKey ? { apiKeyHint: `••••${config.apiKey.slice(-4)}` } : {}),
  };
}

export function setOpenAiMcpTunnelId(value: string): string {
  const tunnelId = value.trim();
  if (!isValidTunnelId(tunnelId)) {
    throw new Error("Invalid OpenAI tunnel ID. Use at least 8 letters, numbers, _, -, . or : characters.");
  }
  const stored = readStoredConfig();
  writeStoredConfig({ ...stored, version: 1, tunnelId });
  return tunnelId;
}

export function setOpenAiMcpTunnelApiKey(value: string): void {
  const apiKey = value.replace(/[\r\n\s]+/g, "");
  if (apiKey.length < 15 || apiKey.startsWith("-")) {
    throw new Error("Invalid OpenAI runtime API key. Provide the API key with Tunnels Read + Use permission.");
  }
  const stored = readStoredConfig();
  writeStoredConfig({ ...stored, version: 1, apiKey: encryptSecret(apiKey) });
}

export function clearOpenAiMcpTunnelConfigField(field: "tunnelId" | "apiKey" | "all"): void {
  if (field === "all") {
    fs.rmSync(getConfigPath(), { force: true });
    return;
  }
  const stored = readStoredConfig();
  if (field === "tunnelId") delete stored.tunnelId;
  else delete stored.apiKey;
  if (!stored.tunnelId && !stored.apiKey) {
    fs.rmSync(getConfigPath(), { force: true });
    return;
  }
  writeStoredConfig(stored);
}
