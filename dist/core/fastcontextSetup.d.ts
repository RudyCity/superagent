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
/**
 * Check if FastContext is fully set up.
 * Returns true if both the Python binary and vendor source exist.
 */
export declare function isFastContextReady(): boolean;
/**
 * Run the FastContext setup script synchronously.
 * Prints progress to stdout so the user sees what's happening.
 */
export declare function runFastContextSetup(): void;
//# sourceMappingURL=fastcontextSetup.d.ts.map