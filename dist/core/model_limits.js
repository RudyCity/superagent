/**
 * Pre-compiled fallback dictionary of LLM models and their context window limits.
 * Generated from OpenRouter models list on 2026-06-10.
 */
export const MODEL_LIMITS = {
    // Anthropic Claude
    "anthropic/claude-sonnet-4.5": 1000000,
    "anthropic/claude-sonnet-4": 1000000,
    "anthropic/claude-opus-4.5": 200000,
    "anthropic/claude-opus-4.1": 200000,
    "anthropic/claude-opus-4": 200000,
    "anthropic/claude-3.5-haiku": 200000,
    "anthropic/claude-haiku-4.5": 200000,
    "anthropic/claude-3.5-sonnet": 200000,
    "anthropic/claude-3-haiku": 200000,
    "anthropic/claude-3-opus": 200000,
    "anthropic/claude-3-sonnet": 200000,
    "~anthropic/claude-fable-latest": 1000000,
    "anthropic/claude-fable-5": 1000000,
    "~anthropic/claude-haiku-latest": 200000,
    "~anthropic/claude-sonnet-latest": 1000000,
    // Google Gemini & Gemma
    "google/gemini-2.5-flash": 1048576,
    "google/gemini-2.5-pro": 1048576,
    "google/gemini-2.5-pro-preview": 1048576,
    "google/gemini-2.5-pro-preview-05-06": 1048576,
    "google/gemini-2.5-flash-lite": 1048576,
    "google/gemini-2.5-flash-lite-preview-09-2025": 1048576,
    "google/gemini-3.1-flash-lite": 1048576,
    "google/gemini-3-pro-image-preview": 65536,
    "google/gemma-3-4b-it": 131072,
    "google/gemma-3-12b-it": 131072,
    "google/gemma-3-27b-it": 131072,
    "google/gemma-3-e4b-it": 32768,
    "google/gemma-2-27b-it": 8192,
    "google/gemini-2.5-flash-image": 32768,
    "~google/gemini-pro-latest": 1048576,
    "~google/gemini-flash-latest": 1048576,
    // OpenAI Models
    "openai/o1": 200000,
    "openai/o1-mini": 200000,
    "openai/o1-preview": 200000,
    "openai/o1-pro": 200000,
    "openai/o3": 200000,
    "openai/o3-mini": 200000,
    "openai/o3-mini-high": 200000,
    "openai/o3-pro": 200000,
    "openai/o3-deep-research": 200000,
    "openai/o4-mini": 200000,
    "openai/o4-mini-high": 200000,
    "openai/o4-mini-deep-research": 200000,
    "openai/gpt-4o": 128000,
    "openai/gpt-4o-mini": 128000,
    "openai/gpt-4o-2024-11-20": 128000,
    "openai/gpt-4o-2024-08-06": 128000,
    "openai/gpt-4o-2024-05-13": 128000,
    "openai/gpt-4o-mini-2024-07-18": 128000,
    "openai/gpt-4-turbo": 128000,
    "openai/gpt-4-turbo-preview": 128000,
    "openai/gpt-4": 8191,
    "openai/gpt-3.5-turbo": 16385,
    "openai/gpt-3.5-turbo-16k": 16385,
    "openai/gpt-3.5-turbo-0613": 4095,
    "openai/gpt-3.5-turbo-instruct": 4095,
    "openai/gpt-5": 400000,
    "openai/gpt-5-mini": 400000,
    "openai/gpt-5-nano": 400000,
    "openai/gpt-5-pro": 400000,
    "openai/gpt-5-chat": 128000,
    "openai/gpt-5-image": 400000,
    "openai/gpt-5-image-mini": 400000,
    "openai/gpt-5-codex": 400000,
    "openai/gpt-5.1": 400000,
    "openai/gpt-5.1-chat": 128000,
    "openai/gpt-5.1-codex": 400000,
    "openai/gpt-5.1-codex-mini": 400000,
    "openai/gpt-5.1-codex-max": 400000,
    "openai/gpt-4.1": 1047576,
    "openai/gpt-4.1-mini": 1047576,
    "openai/gpt-4.1-nano": 1047576,
    "openai/gpt-chat-latest": 400000,
    "openai/gpt-oss-120b": 131072,
    "openai/gpt-oss-20b": 131072,
    "~openai/gpt-mini-latest": 400000,
    "~openai/gpt-latest": 1050000,
    // DeepSeek Models
    "deepseek/deepseek-r1": 163840,
    "deepseek/deepseek-r1-distill-qwen-32b": 128000,
    "deepseek/deepseek-r1-distill-llama-70b": 131072,
    "deepseek/deepseek-chat": 131072,
    "deepseek/deepseek-v3.2": 131072,
    "deepseek/deepseek-v3.2-exp": 163840,
    "deepseek/deepseek-v3.1-terminus": 163840,
    "deepseek/deepseek-chat-v3.1": 163840,
    "deepseek/deepseek-chat-v3-0324": 163840,
    "deepseek/deepseek-r1-0528": 163840,
    // Meta Llama Models
    "meta-llama/llama-3.3-70b-instruct": 131072,
    "meta-llama/llama-3.2-3b-instruct": 131072,
    "meta-llama/llama-3.2-1b-instruct": 131072,
    "meta-llama/llama-3.2-11b-vision-instruct": 131072,
    "meta-llama/llama-3.1-8b-instruct": 131072,
    "meta-llama/llama-3.1-70b-instruct": 131072,
    "meta-llama/llama-3-8b-instruct": 8192,
    "meta-llama/llama-3-70b-instruct": 8192,
    "meta-llama/llama-4-maverick": 1048576,
    "meta-llama/llama-4-scout": 10000000,
    "meta-llama/llama-guard-4-12b": 163840,
    "meta-llama/llama-guard-3-8b": 131072,
    "nvidia/llama-3.3-nemotron-super-49b-v1.5": 131072,
    // Qwen Models
    "qwen/qwen3-coder": 1048576,
    "qwen/qwen3-coder-flash": 1000000,
    "qwen/qwen3-coder-plus": 1000000,
    "qwen/qwen3-max": 262144,
    "qwen/qwen3.7-max": 1000000,
    "qwen/qwen3.7-plus": 1000000,
    "qwen/qwen3.5-plus-20260420": 1000000,
    "qwen/qwen3.6-flash": 1000000,
    "qwen/qwen3.6-max-preview": 262144,
    "qwen/qwen3.6-35b-a3b": 262144,
    "qwen/qwen3.6-27b": 262144,
    "qwen/qwen-2.5-coder-32b-instruct": 128000,
    "qwen/qwen-2.5-72b-instruct": 131072,
    "qwen/qwen-2.5-7b-instruct": 131072,
    "qwen/qwen-plus": 1000000,
    "qwen/qwen-plus-2025-07-28": 1000000,
    "qwen/qwen3-vl-32b-instruct": 262144,
    "qwen/qwen3-vl-8b-thinking": 256000,
    "qwen/qwen3-vl-8b-instruct": 256000,
    "qwen/qwen3-vl-30b-a3b-thinking": 131072,
    "qwen/qwen3-vl-30b-a3b-instruct": 262144,
    "qwen/qwen3-vl-235b-a22b-thinking": 131072,
    "qwen/qwen3-vl-235b-a22b-instruct": 262144,
    "qwen/qwen3-30b-a3b-thinking-2507": 131072,
    "qwen/qwen3-coder-30b-a3b-instruct": 160000,
    "qwen/qwen3-30b-a3b-instruct-2507": 131072,
    "qwen/qwen3-235b-a22b-thinking-2507": 262144,
    "qwen/qwen3-235b-a22b-2507": 262144,
    "qwen/qwen3-30b-a3b": 131072,
    "qwen/qwen3-8b": 131072,
    "qwen/qwen3-14b": 131702,
    "qwen/qwen3-32b": 131072,
    "qwen/qwen3-235b-a22b": 131072,
    "qwen/qwen2.5-vl-72b-instruct": 131072,
    // Mistral & Codestral
    "mistralai/mistral-large-2512": 262144,
    "mistralai/mistral-large-2407": 131072,
    "mistralai/mistral-large": 128000,
    "mistralai/ministral-14b-2512": 262144,
    "mistralai/ministral-8b-2512": 262144,
    "mistralai/ministral-3b-2512": 131072,
    "mistralai/mistral-medium-3.5": 262144,
    "mistralai/mistral-medium-3.1": 131072,
    "mistralai/mistral-medium-3": 131072,
    "mistralai/mistral-small-3.2-24b-instruct": 128000,
    "mistralai/mistral-small-3.1-24b-instruct": 128000,
    "mistralai/mistral-small-24b-instruct-2501": 32768,
    "mistralai/mistral-nemo": 131072,
    "mistralai/mixtral-8x22b-instruct": 65536,
    "mistralai/codestral-2508": 256000,
    "mistralai/voxtral-small-24b-2507": 32000,
    "mistralai/mistral-saba": 32768,
    // Cohere Models
    "cohere/command-a": 256000,
    "cohere/command-r-plus-08-2024": 128000,
    "cohere/command-r-08-2024": 128000,
    "cohere/command-r7b-12-2024": 128000,
    // Perplexity Models
    "perplexity/sonar-pro-search": 200000,
    "perplexity/sonar-reasoning-pro": 128000,
    "perplexity/sonar-pro": 200000,
    "perplexity/sonar-deep-research": 128000,
    "perplexity/sonar": 127072,
    // Amazon Nova Models
    "amazon/nova-2-lite-v1": 1000000,
    "amazon/nova-premier-v1": 1000000,
    "amazon/nova-lite-v1": 300000,
    "amazon/nova-micro-v1": 128000,
    "amazon/nova-pro-v1": 300000,
    // GLM / Z-AI Models
    "z-ai/glm-4.6": 202752,
    "z-ai/glm-4.5": 131072,
    "z-ai/glm-4.5-air": 131072,
    "z-ai/glm-4.5v": 65536,
    // Moonshot / Kimi Models
    "moonshotai/kimi-k2-thinking": 262144,
    "moonshotai/kimi-k2-0905": 262144,
    "moonshotai/kimi-k2": 131072,
    "~moonshotai/kimi-latest": 262144,
    // NVIDIA models
    "nvidia/nemotron-3.5-content-safety": 128000,
    "nvidia/nemotron-3-ultra-550b-a55b": 1000000,
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": 256000,
    "nvidia/nemotron-nano-9b-v2": 131072,
    "nvidia/nemotron-nano-12b-v2-vl": 128000,
    // Other model families
    "nex-agi/nex-n2-pro": 262144,
    "minimax/minimax-m3": 1048576,
    "minimax/minimax-m2": 204800,
    "minimax/minimax-m1": 1000000,
    "minimax/minimax-01": 1000192,
    "stepfun/step-3.7-flash": 256000,
    "x-ai/grok-build-0.1": 256000,
    "x-ai/grok-4.3": 1000000,
    "openrouter/fusion": 128000,
    "perceptron/perceptron-mk1": 32768,
    "inclusionai/ring-2.6-1t": 262144,
    "ibm-granite/granite-4.1-8b": 131072,
    "ibm-granite/granite-4.0-h-micro": 131000,
    "openrouter/owl-alpha": 1048756,
    "poolside/laguna-xs.2": 262144,
    "poolside/laguna-m.1": 262144,
    "microsoft/phi-4-mini-instruct": 131072,
    "microsoft/phi-4": 16384,
    "microsoft/wizardlm-2-8x22b": 65536,
    "arcee-ai/virtuoso-large": 131072,
    "arcee-ai/coder-large": 32768,
    "arcee-ai/trinity-mini": 131072,
    "aion-labs/aion-1.0": 131072,
    "aion-labs/aion-1.0-mini": 131072,
    "aion-labs/aion-rp-llama-3.1-8b": 32768,
    "prime-intellect/intellect-3": 131072,
    "allenai/olmo-3-32b-think": 65536,
    "deepcogito/cogito-v2.1-671b": 128000,
    "essentialai/rnj-1-instruct": 32768,
    "openrouter/bodybuilder": 128000,
    "openrouter/auto": 2000000,
    // Free models (explicit)
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": 256000,
    "nvidia/nemotron-3-super-120b-a12b:free": 1000000,
    "nvidia/nemotron-3-nano-30b-a3b:free": 256000,
    "liquid/lfm-2.5-1.2b-thinking:free": 32768,
    "liquid/lfm-2.5-1.2b-instruct:free": 32768,
    "google/gemma-4-26b-a4b-it:free": 262144,
    "google/gemma-4-31b-it:free": 262144,
    "moonshotai/kimi-k2.6:free": 262144,
};
/**
 * Searches for a matched context window limit based on the model ID.
 * Supports exact match, provider-prefixed match, and generic model keyword matching.
 */
export function getStaticModelLimit(model) {
    let m = model.toLowerCase();
    // Strip :free suffix if present to resolve to base models
    if (m.endsWith(":free")) {
        // Check direct exact match with free suffix first
        if (MODEL_LIMITS[m]) {
            return MODEL_LIMITS[m];
        }
        m = m.slice(0, -5);
    }
    // 1. Direct exact match
    if (MODEL_LIMITS[m]) {
        return MODEL_LIMITS[m];
    }
    // 2. Direct exact match without provider prefix
    // e.g. "gemini-2.5-flash" -> matches "google/gemini-2.5-flash"
    const modelNameOnly = m.includes("/") ? m.split("/").slice(1).join("/") : m;
    for (const [key, limit] of Object.entries(MODEL_LIMITS)) {
        const keyNameOnly = key.includes("/") ? key.split("/").slice(1).join("/") : key;
        if (keyNameOnly === modelNameOnly) {
            return limit;
        }
    }
    // 3. Fallback matching with keywords/substrings
    if (m.includes("gemini-2.5-flash-lite") || m.includes("gemini-3.1-flash-lite"))
        return 1048576;
    if (m.includes("gemini-2.5-flash") || m.includes("gemini-2.0-flash") || m.includes("gemini-1.5-flash"))
        return 1048576;
    if (m.includes("gemini-2.5-pro") || m.includes("gemini-2.0-pro") || m.includes("gemini-1.5-pro"))
        return 1048576;
    if (m.includes("gemini"))
        return 1048576; // Default gemini fallback
    if (m.includes("gemma-3"))
        return 131072;
    if (m.includes("gemma"))
        return 8192;
    if (m.includes("claude-3-5") || m.includes("claude-4"))
        return 200000;
    if (m.includes("claude-3") || m.includes("claude"))
        return 200000;
    if (m.includes("o1") || m.includes("o3") || m.includes("o4"))
        return 200000;
    if (m.includes("gpt-4o"))
        return 128000;
    if (m.includes("gpt-4-turbo"))
        return 128000;
    if (m.includes("gpt-4.1"))
        return 1047576;
    if (m.includes("gpt-4"))
        return 8191;
    if (m.includes("gpt-3.5-turbo"))
        return 16385;
    if (m.includes("gpt-5"))
        return 400000;
    if (m.includes("deepseek-r1"))
        return 163840;
    if (m.includes("deepseek"))
        return 131072;
    if (m.includes("llama-4"))
        return 1048576;
    if (m.includes("llama-3.3") || m.includes("llama-3.2") || m.includes("llama-3.1"))
        return 131072;
    if (m.includes("llama-3"))
        return 8192;
    if (m.includes("qwen3"))
        return 262144;
    if (m.includes("qwen2.5-coder") || m.includes("qwen-2.5-coder"))
        return 128000;
    if (m.includes("qwen"))
        return 1000000; // Qwen-Plus default is 1M
    if (m.includes("mistral-large"))
        return 128000;
    if (m.includes("codestral"))
        return 256000;
    if (m.includes("command-r"))
        return 128000;
    return null;
}
//# sourceMappingURL=model_limits.js.map