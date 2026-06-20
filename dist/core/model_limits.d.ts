/**
 * Pre-compiled fallback dictionary of LLM models and their context window limits.
 * Generated from OpenRouter models list on 2026-06-10.
 */
export declare const MODEL_LIMITS: Record<string, number>;
/**
 * Searches for a matched context window limit based on the model ID.
 * Supports exact match, provider-prefixed match, and generic model keyword matching.
 */
export declare function getStaticModelLimit(model: string): number | null;
//# sourceMappingURL=model_limits.d.ts.map