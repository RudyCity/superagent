import { MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts";
import { getSettings } from "./config.js";
import { createHash } from "crypto";

/**
 * Gets a configured MemoryClient with a default short timeout to prevent CLI hangs.
 * @param timeoutMs The request timeout in milliseconds. Defaults to 3000ms.
 */
export function getTencentDBClient(timeoutMs = 3000): MemoryClient {
  const settings = getSettings();
  const endpoint = settings.tencentdbGatewayUrl || "http://127.0.0.1:8420";
  const apiKey = settings.tencentdbGatewayApiKey || "sk-xxxx";
  const serviceId = settings.tencentdbServiceId || "default";

  return new MemoryClient({
    endpoint,
    apiKey,
    serviceId,
    timeout: timeoutMs,
  });
}

/**
 * Generates a stable 8-character session key hash for TencentDB.
 * @param historyPath The path of the session history file.
 */
export function getTencentDBSessionKey(historyPath: string | null): string {
  const keySource = historyPath || process.cwd();
  return createHash("sha1").update(keySource).digest("hex").slice(0, 8);
}

let cachedActiveStatus: { active: boolean; timestamp: number } | null = null;

/**
 * Checks if the TencentDB memory system is active.
 * It is active if it is enabled in settings AND the local gateway is reachable (online).
 * The result is cached for 15 seconds to prevent redundant network checks.
 */
export async function isTencentdbActive(forceRefresh = false): Promise<boolean> {
  const settings = getSettings();
  if (!settings.enableTencentdbMemory) {
    return false;
  }

  const now = Date.now();
  if (!forceRefresh && cachedActiveStatus && (now - cachedActiveStatus.timestamp) < 15000) {
    return cachedActiveStatus.active;
  }

  const client = getTencentDBClient(1000); // 1s timeout
  let active = false;
  try {
    await client.listScenarios({});
    active = true;
  } catch {
    active = false;
  }

  cachedActiveStatus = { active, timestamp: now };
  return active;
}

