/**
 * Update runtime config: syncs updates to process.env (in-memory) and
 * persists relevant changes to model-config.json (synchronous).
 *
 * .env file is NO LONGER used — all persistent config lives in model-config.json.
 */
export declare function updateEnvFile(updates: Record<string, string>): string;
//# sourceMappingURL=env.d.ts.map