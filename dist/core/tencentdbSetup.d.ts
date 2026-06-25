/**
 * tencentdbSetup.ts — Auto-detect and run TencentDB Memory Gateway on startup.
 *
 * Checks if the TencentDB Memory Gateway is enabled in settings and running.
 * If enabled but offline, automatically clones, installs, and starts the
 * gateway in the background.
 *
 * Called from cli.tsx at startup. Fully asynchronous and non-blocking to ensure
 * instant CLI startup.
 */
/**
 * Spawns the TencentDB Memory Gateway process completely silently in the background.
 */
export declare function spawnTencentdbGateway(options: {
    gatewayDir: string;
    globalDataDir: string;
    llmApiKey: string;
    llmBaseUrl: string;
    llmModel: string;
    outLog: number;
    errLog: number;
}): any;
/**
 * Check and start the TencentDB Memory Gateway if enabled and offline.
 * Non-blocking: runs asynchronously in the background.
 */
export declare function runTencentdbSetup(): Promise<void>;
//# sourceMappingURL=tencentdbSetup.d.ts.map