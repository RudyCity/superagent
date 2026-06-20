/**
 * A file-lock-based shared token bucket rate limiter to prevent concurrent
 * Superagent instances from hitting LLM API rate limits.
 */
export declare class SharedRateLimiter {
    private statePath;
    private lockPath;
    constructor();
    private acquireLock;
    private releaseLock;
    private readState;
    private writeState;
    private getCapacity;
    private getRefillRatePerMs;
    /**
     * Acquires a slot from the token bucket. If empty, it pauses execution.
     */
    acquire(cost?: number): Promise<void>;
}
export declare class SharedConcurrencyLimiter {
    private lockPath;
    constructor();
    acquire(): Promise<void>;
    release(): void;
}
export declare const rateLimiter: SharedRateLimiter;
export declare const concurrencyLimiter: SharedConcurrencyLimiter;
//# sourceMappingURL=rateLimiter.d.ts.map