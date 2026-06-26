import { MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts";
/**
 * Gets a configured MemoryClient with a default short timeout to prevent CLI hangs.
 * @param timeoutMs The request timeout in milliseconds. Defaults to 3000ms.
 */
export declare function getTencentDBClient(timeoutMs?: number): MemoryClient;
/**
 * Generates a stable 8-character session key hash for TencentDB.
 * @param historyPath The path of the session history file.
 */
export declare function getTencentDBSessionKey(historyPath: string | null): string;
//# sourceMappingURL=tencentdbUtil.d.ts.map