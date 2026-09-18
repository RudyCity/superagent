import type { GlobalModelConfig } from "./configTypes.js";

export const DEFAULT_CONFIG: GlobalModelConfig = {
  settings: {
    concurrencyLimit: 0,
    rateLimitRpm: 60,
    rateLimitCapacity: 60,
    disableStreaming: false,
    contextWindowLimit: 0,
    promptContextBudget: 8000,
    maxIterations: 500,
    simpleTaskFileThreshold: 3,
    simpleTaskKeywords: ['lanjut', 'coba', 'go ahead', 'proceed', 'try', 'run', 'execute', 'ok', 'yes', 'y'],
    maxChecklistVisible: 3,
    maxHistoryVisible: 3,
    maxProcsVisible: 3,
    forcePromptBasedToolCalling: false,
    enableRmemory: false,
    rmemoryEmbeddingProvider: "local",
    rmemoryEmbeddingModel: "Xenova/all-MiniLM-L6-v2",
    rmemoryEmbeddingDimensions: 384,
    enableAdvisor: true,
    advisorWarningThreshold: 3,
    advisorPauseThreshold: 5,
    advisorErrorThreshold: 5,
    advisorAdaptiveScaling: true,
    advisorPatternMemory: true,
  },
  trustedDirectories: [],
  providers: [
    {
      id: "default-anthropic",
      name: "Default Anthropic",
      provider: "anthropic",
      apiKey: "",
      baseUrl: "",
    },
    {
      id: "default-openai",
      name: "Default OpenAI",
      provider: "openai",
      apiKey: "",
      baseUrl: "",
    }
  ],
  presets: {
    multi: [
      {
        id: "default-multi",
        name: "Default Multi-Agent Setup",
        description: "Standard configuration using Claude Sonnet and GPT-4o-mini",
        models: {
          master: {
            providerProfileId: "default-anthropic",
            model: "claude-3-5-sonnet-20241022",
          },
          superagent: {
            providerProfileId: "default-anthropic",
            model: "claude-3-5-sonnet-20241022",
          },
          subagentDefault: {
            providerProfileId: "default-openai",
            model: "gpt-4o-mini",
          },
          subagentDetails: {},
        },
      },
    ],
    single: [
      {
        id: "default-single",
        name: "Default Single-Agent Setup",
        description: "Standard single-agent setup using Claude Sonnet and GPT-4o-mini",
        models: {
          superagent: {
            providerProfileId: "default-anthropic",
            model: "claude-3-5-sonnet-20241022",
          },
          subagentDefault: {
            providerProfileId: "default-openai",
            model: "gpt-4o-mini",
          },
          subagentDetails: {},
        },
      },
    ],
  },
  activePresetId: {
    multi: "default-multi",
    single: "default-single",
  },
};
