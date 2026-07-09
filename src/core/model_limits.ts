/**
 * Pre-compiled fallback dictionary of LLM models and their context window limits.
 * Generated dynamically from OpenRouter models list on 2026-06-25.
 */
export const MODEL_LIMITS: Record<string, number> = {
  // Ai21 Models
  "ai21/jamba-large-1.7": 256000,

  // Aion-labs Models
  "aion-labs/aion-1.0": 131072,
  "aion-labs/aion-1.0-mini": 131072,
  "aion-labs/aion-2.0": 131072,
  "aion-labs/aion-rp-llama-3.1-8b": 32768,

  // Allenai Models
  "allenai/olmo-3-32b-think": 65536,

  // Amazon Models
  "amazon/nova-2-lite-v1": 1000000,
  "amazon/nova-lite-v1": 300000,
  "amazon/nova-micro-v1": 128000,
  "amazon/nova-premier-v1": 1000000,
  "amazon/nova-pro-v1": 300000,

  // Anthracite-org Models
  "anthracite-org/magnum-v4-72b": 32768,

  // Anthropic Models
  "anthropic/claude-3-haiku": 200000,
  "anthropic/claude-fable-5": 1000000,
  "anthropic/claude-haiku-4.5": 200000,
  "anthropic/claude-opus-4": 200000,
  "anthropic/claude-opus-4.1": 200000,
  "anthropic/claude-opus-4.5": 200000,
  "anthropic/claude-opus-4.6": 1000000,
  "anthropic/claude-opus-4.6-fast": 1000000,
  "anthropic/claude-opus-4.7": 1000000,
  "anthropic/claude-opus-4.7-fast": 1000000,
  "anthropic/claude-opus-4.8": 1000000,
  "anthropic/claude-opus-4.8-fast": 1000000,
  "anthropic/claude-sonnet-4": 1000000,
  "anthropic/claude-sonnet-4.5": 1000000,
  "anthropic/claude-sonnet-4.5-1m": 1000000,
  "anthropic/claude-sonnet-4.6": 1000000,

  // Arcee-ai Models
  "arcee-ai/coder-large": 32768,
  "arcee-ai/trinity-large-thinking": 262144,
  "arcee-ai/trinity-mini": 131072,
  "arcee-ai/virtuoso-large": 131072,

  // Baidu Models
  "baidu/ernie-4.5-vl-424b-a47b": 131072,

  // Bytedance Models
  "bytedance/ui-tars-1.5-7b": 128000,

  // Bytedance-seed Models
  "bytedance-seed/seed-1.6": 262144,
  "bytedance-seed/seed-1.6-flash": 262144,
  "bytedance-seed/seed-2.0-lite": 262144,
  "bytedance-seed/seed-2.0-mini": 262144,

  // Cognitivecomputations Models
  "cognitivecomputations/dolphin-mistral-24b-venice-edition:free": 32768,

  // Cohere Models
  "cohere/command-a": 256000,
  "cohere/command-r-08-2024": 128000,
  "cohere/command-r-plus-08-2024": 128000,
  "cohere/command-r7b-12-2024": 128000,
  "cohere/north-mini-code:free": 256000,

  // Deepcogito Models
  "deepcogito/cogito-v2.1-671b": 128000,

  // Deepseek Models
  "deepseek/deepseek-chat": 131072,
  "deepseek/deepseek-chat-v3-0324": 163840,
  "deepseek/deepseek-chat-v3.1": 163840,
  "deepseek/deepseek-r1": 163840,
  "deepseek/deepseek-r1-0528": 163840,
  "deepseek/deepseek-r1-distill-llama-70b": 128000,
  "deepseek/deepseek-v3.1-terminus": 163840,
  "deepseek/deepseek-v3.2": 131072,
  "deepseek/deepseek-v3.2-exp": 163840,
  "deepseek/deepseek-v4-flash": 1048576,
  "deepseek/deepseek-v4-pro": 1048576,

  // Google Models
  "google/gemini-2.5-flash": 1048576,
  "google/gemini-2.5-flash-image": 32768,
  "google/gemini-2.5-flash-lite": 1048576,
  "google/gemini-2.5-flash-lite-preview-09-2025": 1048576,
  "google/gemini-2.5-pro": 1048576,
  "google/gemini-2.5-pro-preview": 1048576,
  "google/gemini-2.5-pro-preview-05-06": 1048576,
  "google/gemini-3-flash-preview": 1048576,
  "google/gemini-3-pro-image": 65536,
  "google/gemini-3-pro-image-preview": 65536,
  "google/gemini-3.1-flash-image": 131072,
  "google/gemini-3.1-flash-image-preview": 131072,
  "google/gemini-3.1-flash-lite": 1048576,
  "google/gemini-3.1-flash-lite-preview": 1048576,
  "google/gemini-3.1-pro-preview": 1048576,
  "google/gemini-3.1-pro-preview-customtools": 1048756,
  "google/gemini-3.5-flash": 1048576,
  "google/gemma-2-27b-it": 8192,
  "google/gemma-3-12b-it": 131072,
  "google/gemma-3-27b-it": 131072,
  "google/gemma-3-4b-it": 131072,
  "google/gemma-3n-e4b-it": 32768,
  "google/gemma-4-26b-a4b-it": 262144,
  "google/gemma-4-26b-a4b-it:free": 262144,
  "google/gemma-4-31b-it": 262144,
  "google/gemma-4-31b-it:free": 262144,

  // Native Google Gemini models (direct API, no google/ prefix)
  "gemini-2.5-flash": 1048576,
  "gemini-2.5-flash-preview-05-20": 1048576,
  "gemini-2.5-pro": 1048576,
  "gemini-2.5-pro-preview-05-06": 1048576,
  "gemini-2.0-flash": 1048576,
  "gemini-2.0-flash-lite": 1048576,
  "gemini-1.5-flash": 1048576,
  "gemini-1.5-flash-8b": 1048576,
  "gemini-1.5-pro": 2097152,
  "google/lyria-3-clip-preview": 1048576,
  "google/lyria-3-pro-preview": 1048576,

  // Gryphe Models
  "gryphe/mythomax-l2-13b": 4096,

  // Ibm-granite Models
  "ibm-granite/granite-4.0-h-micro": 131000,
  "ibm-granite/granite-4.1-8b": 131072,

  // Inception Models
  "inception/mercury-2": 128000,

  // Inclusionai Models
  "inclusionai/ling-2.6-1t": 262144,
  "inclusionai/ling-2.6-flash": 262144,
  "inclusionai/ring-2.6-1t": 262144,

  // Inflection Models
  "inflection/inflection-3-pi": 8000,
  "inflection/inflection-3-productivity": 8000,

  // Kwaipilot Models
  "kwaipilot/kat-coder-pro-v2": 256000,

  // Liquid Models
  "liquid/lfm-2-24b-a2b": 128000,
  "liquid/lfm-2.5-1.2b-instruct:free": 32768,
  "liquid/lfm-2.5-1.2b-thinking:free": 32768,

  // Mancer Models
  "mancer/weaver": 8000,

  // Meta-llama Models
  "meta-llama/llama-3-8b-instruct": 8192,
  "meta-llama/llama-3.1-70b-instruct": 131072,
  "meta-llama/llama-3.1-8b-instruct": 131072,
  "meta-llama/llama-3.2-11b-vision-instruct": 131072,
  "meta-llama/llama-3.2-1b-instruct": 131072,
  "meta-llama/llama-3.2-3b-instruct": 131072,
  "meta-llama/llama-3.2-3b-instruct:free": 131072,
  "meta-llama/llama-3.3-70b-instruct": 131072,
  "meta-llama/llama-3.3-70b-instruct:free": 131072,
  "meta-llama/llama-4-maverick": 1048576,
  "meta-llama/llama-4-scout": 10000000,
  "meta-llama/llama-guard-4-12b": 163840,

  // Microsoft Models
  "microsoft/phi-4": 16384,
  "microsoft/phi-4-mini-instruct": 131072,
  "microsoft/wizardlm-2-8x22b": 65536,

  // Minimax Models
  "minimax/minimax-01": 1000192,
  "minimax/minimax-m1": 1000000,
  "minimax/minimax-m2": 204800,
  "minimax/minimax-m2-her": 65536,
  "minimax/minimax-m2.1": 204800,
  "minimax/minimax-m2.5": 204800,
  "minimax/minimax-m2.7": 204800,
  "minimax/minimax-m3": 1048576,

  // Mistralai Models
  "mistralai/codestral-2508": 256000,
  "mistralai/devstral-2512": 262144,
  "mistralai/ministral-14b-2512": 262144,
  "mistralai/ministral-3b-2512": 131072,
  "mistralai/ministral-8b-2512": 262144,
  "mistralai/mistral-large": 128000,
  "mistralai/mistral-large-2407": 131072,
  "mistralai/mistral-large-2512": 262144,
  "mistralai/mistral-medium-3": 131072,
  "mistralai/mistral-medium-3-5": 262144,
  "mistralai/mistral-medium-3.1": 131072,
  "mistralai/mistral-nemo": 131072,
  "mistralai/mistral-saba": 32768,
  "mistralai/mistral-small-24b-instruct-2501": 32768,
  "mistralai/mistral-small-2603": 262144,
  "mistralai/mistral-small-3.1-24b-instruct": 128000,
  "mistralai/mistral-small-3.2-24b-instruct": 128000,
  "mistralai/mixtral-8x22b-instruct": 65536,
  "mistralai/voxtral-small-24b-2507": 32000,

  // Moonshotai Models
  "moonshotai/kimi-k2": 131072,
  "moonshotai/kimi-k2-0905": 262144,
  "moonshotai/kimi-k2-thinking": 262144,
  "moonshotai/kimi-k2.5": 262144,
  "moonshotai/kimi-k2.6": 262144,
  "moonshotai/kimi-k2.7-code": 262144,

  // Morph Models
  "morph/morph-v3-fast": 81920,
  "morph/morph-v3-large": 262144,

  // Nex-agi Models
  "nex-agi/nex-n2-pro": 262144,

  // Nousresearch Models
  "nousresearch/hermes-3-llama-3.1-405b": 131072,
  "nousresearch/hermes-3-llama-3.1-405b:free": 131072,
  "nousresearch/hermes-3-llama-3.1-70b": 131072,
  "nousresearch/hermes-4-405b": 131072,
  "nousresearch/hermes-4-70b": 131072,

  // Nvidia Models
  "nvidia/llama-3.3-nemotron-super-49b-v1.5": 131072,
  "nvidia/nemotron-3-nano-30b-a3b": 262144,
  "nvidia/nemotron-3-nano-30b-a3b:free": 256000,
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": 256000,
  "nvidia/nemotron-3-super-120b-a12b": 1000000,
  "nvidia/nemotron-3-super-120b-a12b:free": 1000000,
  "nvidia/nemotron-3-ultra-550b-a55b": 1000000,
  "nvidia/nemotron-3-ultra-550b-a55b:free": 1000000,
  "nvidia/nemotron-3.5-content-safety:free": 128000,
  "nvidia/nemotron-nano-12b-v2-vl:free": 128000,
  "nvidia/nemotron-nano-9b-v2:free": 128000,

  // Openai Models
  "openai/gpt-3.5-turbo": 16385,
  "openai/gpt-3.5-turbo-0613": 4095,
  "openai/gpt-3.5-turbo-16k": 16385,
  "openai/gpt-3.5-turbo-instruct": 4095,
  "openai/gpt-4": 8191,
  "openai/gpt-4-turbo": 128000,
  "openai/gpt-4-turbo-preview": 128000,
  "openai/gpt-4.1": 1047576,
  "openai/gpt-4.1-mini": 1047576,
  "openai/gpt-4.1-nano": 1047576,
  "openai/gpt-4o": 128000,
  "openai/gpt-4o-2024-05-13": 128000,
  "openai/gpt-4o-2024-08-06": 128000,
  "openai/gpt-4o-2024-11-20": 128000,
  "openai/gpt-4o-mini": 128000,
  "openai/gpt-4o-mini-2024-07-18": 128000,
  "openai/gpt-4o-mini-search-preview": 128000,
  "openai/gpt-4o-search-preview": 128000,
  "openai/gpt-5": 400000,
  "openai/gpt-5-chat": 128000,
  "openai/gpt-5-codex": 400000,
  "openai/gpt-5-image": 400000,
  "openai/gpt-5-image-mini": 400000,
  "openai/gpt-5-mini": 400000,
  "openai/gpt-5-nano": 400000,
  "openai/gpt-5-pro": 400000,
  "openai/gpt-5.1": 400000,
  "openai/gpt-5.1-chat": 128000,
  "openai/gpt-5.1-codex": 400000,
  "openai/gpt-5.1-codex-max": 400000,
  "openai/gpt-5.1-codex-mini": 400000,
  "openai/gpt-5.2": 400000,
  "openai/gpt-5.2-chat": 128000,
  "openai/gpt-5.2-codex": 400000,
  "openai/gpt-5.2-pro": 400000,
  "openai/gpt-5.3-chat": 128000,
  "openai/gpt-5.3-codex": 400000,
  "openai/gpt-5.4": 1050000,
  "openai/gpt-5.4-image-2": 272000,
  "openai/gpt-5.4-mini": 400000,
  "openai/gpt-5.4-nano": 400000,
  "openai/gpt-5.4-pro": 1050000,
  "openai/gpt-5.5": 1050000,
  "openai/gpt-5.5-pro": 1050000,
  "openai/gpt-audio": 128000,
  "openai/gpt-audio-mini": 128000,
  "openai/gpt-chat-latest": 400000,
  "openai/gpt-oss-120b": 131072,
  "openai/gpt-oss-120b:free": 131072,
  "openai/gpt-oss-20b": 131072,
  "openai/gpt-oss-20b:free": 131072,
  "openai/gpt-oss-safeguard-20b": 131072,
  "openai/o1": 200000,
  "openai/o1-pro": 200000,
  "openai/o3": 200000,
  "openai/o3-deep-research": 200000,
  "openai/o3-mini": 200000,
  "openai/o3-mini-high": 200000,
  "openai/o3-pro": 200000,
  "openai/o4-mini": 200000,
  "openai/o4-mini-deep-research": 200000,
  "openai/o4-mini-high": 200000,

  // Openrouter Models
  "openrouter/auto": 2000000,
  "openrouter/bodybuilder": 128000,
  "openrouter/free": 200000,
  "openrouter/fusion": 1000000,
  "openrouter/owl-alpha": 1048756,
  "openrouter/pareto-code": 2000000,

  // Perceptron Models
  "perceptron/perceptron-mk1": 32768,

  // Perplexity Models
  "perplexity/sonar": 127072,
  "perplexity/sonar-deep-research": 128000,
  "perplexity/sonar-pro": 200000,
  "perplexity/sonar-pro-search": 200000,
  "perplexity/sonar-reasoning-pro": 128000,

  // Poolside Models
  "poolside/laguna-m.1": 262144,
  "poolside/laguna-m.1:free": 262144,
  "poolside/laguna-xs.2": 262144,
  "poolside/laguna-xs.2:free": 262144,

  // Qwen Models
  "qwen/qwen-2.5-72b-instruct": 131072,
  "qwen/qwen-2.5-7b-instruct": 131072,
  "qwen/qwen-2.5-coder-32b-instruct": 128000,
  "qwen/qwen-plus": 1000000,
  "qwen/qwen-plus-2025-07-28": 1000000,
  "qwen/qwen-plus-2025-07-28:thinking": 1000000,
  "qwen/qwen2.5-vl-72b-instruct": 131072,
  "qwen/qwen3-14b": 131702,
  "qwen/qwen3-235b-a22b": 131072,
  "qwen/qwen3-235b-a22b-2507": 262144,
  "qwen/qwen3-235b-a22b-thinking-2507": 262144,
  "qwen/qwen3-30b-a3b": 131072,
  "qwen/qwen3-30b-a3b-instruct-2507": 131072,
  "qwen/qwen3-30b-a3b-thinking-2507": 131072,
  "qwen/qwen3-32b": 131072,
  "qwen/qwen3-8b": 131072,
  "qwen/qwen3-coder": 1048576,
  "qwen/qwen3-coder-30b-a3b-instruct": 160000,
  "qwen/qwen3-coder-flash": 1000000,
  "qwen/qwen3-coder-next": 262144,
  "qwen/qwen3-coder-plus": 1000000,
  "qwen/qwen3-coder:free": 1048576,
  "qwen/qwen3-max": 262144,
  "qwen/qwen3-max-thinking": 262144,
  "qwen/qwen3-next-80b-a3b-instruct": 262144,
  "qwen/qwen3-next-80b-a3b-instruct:free": 262144,
  "qwen/qwen3-next-80b-a3b-thinking": 262144,
  "qwen/qwen3-vl-235b-a22b-instruct": 262144,
  "qwen/qwen3-vl-235b-a22b-thinking": 131072,
  "qwen/qwen3-vl-30b-a3b-instruct": 262144,
  "qwen/qwen3-vl-30b-a3b-thinking": 131072,
  "qwen/qwen3-vl-32b-instruct": 262144,
  "qwen/qwen3-vl-8b-instruct": 256000,
  "qwen/qwen3-vl-8b-thinking": 256000,
  "qwen/qwen3.5-122b-a10b": 262144,
  "qwen/qwen3.5-27b": 262144,
  "qwen/qwen3.5-35b-a3b": 262144,
  "qwen/qwen3.5-397b-a17b": 256000,
  "qwen/qwen3.5-9b": 262144,
  "qwen/qwen3.5-flash-02-23": 1000000,
  "qwen/qwen3.5-plus-02-15": 1000000,
  "qwen/qwen3.5-plus-20260420": 1000000,
  "qwen/qwen3.6-27b": 262144,
  "qwen/qwen3.6-35b-a3b": 262144,
  "qwen/qwen3.6-flash": 1000000,
  "qwen/qwen3.6-max-preview": 262144,
  "qwen/qwen3.6-plus": 1000000,
  "qwen/qwen3.7-max": 1000000,
  "qwen/qwen3.7-plus": 1000000,

  // Rekaai Models
  "rekaai/reka-edge": 16384,
  "rekaai/reka-flash-3": 65536,

  // Relace Models
  "relace/relace-apply-3": 256000,
  "relace/relace-search": 256000,

  // Sakana Models
  "sakana/fugu-ultra": 1000000,

  // Sao10k Models
  "sao10k/l3-lunaris-8b": 8192,
  "sao10k/l3.1-70b-hanami-x1": 16000,
  "sao10k/l3.1-euryale-70b": 131072,
  "sao10k/l3.3-euryale-70b": 131072,

  // Stepfun Models
  "stepfun/step-3.5-flash": 262144,
  "stepfun/step-3.7-flash": 256000,

  // Switchpoint Models
  "switchpoint/router": 131072,

  // Tencent Models
  "tencent/hunyuan-a13b-instruct": 131072,
  "tencent/hy3-preview": 262144,

  // Thedrummer Models
  "thedrummer/cydonia-24b-v4.1": 131072,
  "thedrummer/rocinante-12b": 32768,
  "thedrummer/skyfall-36b-v2": 32768,
  "thedrummer/unslopnemo-12b": 32768,

  // Undi95 Models
  "undi95/remm-slerp-l2-13b": 6144,

  // Upstage Models
  "upstage/solar-pro-3": 128000,

  // Writer Models
  "writer/palmyra-x5": 1040000,

  // X-ai Models
  "x-ai/grok-4.20": 2000000,
  "x-ai/grok-4.20-multi-agent": 2000000,
  "x-ai/grok-4.3": 1000000,
  "x-ai/grok-build-0.1": 256000,

  // Xiaomi Models
  "xiaomi/mimo-v2.5": 1048576,
  "xiaomi/mimo-v2.5-pro": 1048576,

  // Z-ai Models
  "z-ai/glm-4.5": 131072,
  "z-ai/glm-4.5-air": 131072,
  "z-ai/glm-4.5v": 65536,
  "z-ai/glm-4.6": 202752,
  "z-ai/glm-4.6v": 131072,
  "z-ai/glm-4.7": 202752,
  "z-ai/glm-4.7-flash": 202752,
  "z-ai/glm-5": 202752,
  "z-ai/glm-5-turbo": 262144,
  "z-ai/glm-5.1": 202752,
  "z-ai/glm-5.2": 1048576,
  "z-ai/glm-5v-turbo": 202752,

  // ~anthropic Models
  "~anthropic/claude-fable-latest": 1000000,
  "~anthropic/claude-haiku-latest": 200000,
  "~anthropic/claude-opus-latest": 1000000,
  "~anthropic/claude-sonnet-latest": 1000000,

  // ~google Models
  "~google/gemini-flash-latest": 1048576,
  "~google/gemini-pro-latest": 1048576,

  // ~moonshotai Models
  "~moonshotai/kimi-latest": 262144,

  // ~openai Models
  "~openai/gpt-latest": 1050000,
  "~openai/gpt-mini-latest": 400000
};

export function getStaticModelLimit(model: string): number | null {
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
  if (m.includes("gemini-2.5-flash-lite") || m.includes("gemini-3.1-flash-lite")) return 1048576;
  if (m.includes("gemini-2.5-flash") || m.includes("gemini-2.0-flash") || m.includes("gemini-1.5-flash")) return 1048576;
  if (m.includes("gemini-2.5-pro") || m.includes("gemini-2.0-pro") || m.includes("gemini-1.5-pro")) return 1048576;
  if (m.includes("gemini")) return 1048576; // Default gemini fallback
  if (m.includes("gemma-3")) return 131072;
  if (m.includes("gemma")) return 8192;

  if (m.includes("claude-sonnet-4") || m.includes("claude-sonnet-latest")) return 1000000;
  if (m.includes("claude-3-5") || m.includes("claude-4")) return 200000;
  if (m.includes("claude-3") || m.includes("claude")) return 200000;

  if (m.includes("o1") || m.includes("o3") || m.includes("o4")) return 200000;
  if (m.includes("gpt-4o")) return 128000;
  if (m.includes("gpt-4-turbo")) return 128000;
  if (m.includes("gpt-4.1")) return 1047576;
  if (m.includes("gpt-4")) return 8191;
  if (m.includes("gpt-3.5-turbo")) return 16385;
  if (m.includes("gpt-5")) return 400000;

  if (m.includes("deepseek-r1")) return 163840;
  if (m.includes("deepseek")) return 131072;

  if (m.includes("llama-4")) return 1048576;
  if (m.includes("llama-3.3") || m.includes("llama-3.2") || m.includes("llama-3.1")) return 131072;
  if (m.includes("llama-3")) return 8192;

  if (m.includes("qwen3")) return 262144;
  if (m.includes("qwen2.5-coder") || m.includes("qwen-2.5-coder")) return 128000;
  if (m.includes("qwen")) return 1000000; // Qwen-Plus default is 1M

  if (m.includes("mistral-large")) return 128000;
  if (m.includes("codestral")) return 256000;

  if (m.includes("command-r")) return 128000;

  return null;
}
