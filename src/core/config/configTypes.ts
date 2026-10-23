import type { SelfDevConfig } from "../selfdev/types.js";

export interface ProviderProfile {
  id: string;
  name: string;
  provider: string; // e.g. 'openai', 'anthropic', 'openrouter', 'custom'
  apiKey: string;
  baseUrl?: string;
}

export interface TierModelConfig {
  providerProfileId: string;
  model: string;
  supportsVision?: boolean;
}

export interface PresetModelsMulti {
  master: TierModelConfig;
  superagent: TierModelConfig;
  subagentDefault: TierModelConfig;
  subagentDetails: Record<string, TierModelConfig>;
}

export interface PresetModelsSingle {
  superagent: TierModelConfig;
  subagentDefault: TierModelConfig;
  subagentDetails: Record<string, TierModelConfig>;
}

export interface JSONModelPreset<T> {
  id: string;
  name: string;
  description: string;
  models: T;
}

export interface SystemSettings {
  /** Self-development controls; absent settings inherit the default-ON configuration. */
  selfdev?: SelfDevConfig;
  concurrencyLimit: number;
  rateLimitRpm: number;
  rateLimitCapacity: number;
  disableStreaming: boolean;
  contextWindowLimit: number;
  /** Estimated token budget reserved for optional skills, memories, and runtime context. */
  promptContextBudget?: number;
  maxIterations: number;
  simpleTaskFileThreshold?: number;
  simpleTaskKeywords?: string[];
  /** Enable multi-category request classifier for token optimization (default: true) */
  classifierEnabled?: boolean;
  /** Minimum heuristic confidence to skip LLM classification phase (default: "high") */
  classifierConfidenceThreshold?: "high" | "medium" | "low";
  /** Custom keyword overrides per request category */
  classifierKeywords?: Record<string, string[]>;
  rmemoryGatewayUrl?: string;
  rmemoryGatewayApiKey?: string;
  rmemoryServiceId?: string;
  enableRmemory?: boolean;
  rmemoryPollIntervalMs?: number;
  rmemoryEmbeddingProvider?: "local" | "openai";
  rmemoryEmbeddingModel?: string;
  rmemoryEmbeddingDimensions?: number;
  maxChecklistVisible?: number;
  maxHistoryVisible?: number;
  maxProcsVisible?: number;
  forcePromptBasedToolCalling?: boolean;
  hideTimeline?: boolean;
  enableAdvisor?: boolean;
  advisorWarningThreshold?: number;
  advisorPauseThreshold?: number;
  advisorErrorThreshold?: number;
  advisorAdaptiveScaling?: boolean;
  advisorPatternMemory?: boolean;
  /** Log level for prompt logging: off | metadata (no messages) | full (all content) */
  promptLogLevel?: "off" | "metadata" | "full";
  /**
   * Force single-agent mode (suppress Master/Superagent/Subagent
   * orchestration). Previously stored in `process.env.SINGLE_AGENT_MODE`
   * — migrated to JSON config in v1.5.0 (audit finding H4).
   */
  singleAgentMode?: boolean;
  /** Offline Piper TTS binary path for Superagent Studio voiceover */
  motionPiperBin?: string;
  /** Offline Piper TTS ONNX model path for Superagent Studio voiceover */
  motionPiperModel?: string;
  /** Max concurrent renderers for Superagent Studio queue (default: 2, max: 4) */
  motionMaxRenderers?: number;
}

export interface McpServerConfigBase {
  /** Optional legacy fields used by array-shaped configurations. */
  id?: string;
  name?: string;
  disabled?: boolean;
  /** Reconnect unexpectedly lost servers (default: enabled, except OAuth unless explicitly true). */
  autoReconnect?: boolean;
}

export interface StdioMcpServerConfig extends McpServerConfigBase {
  /** Canonical stdio discriminator. Legacy configs are normalized by configSchema. */
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HttpMcpServerConfig extends McpServerConfigBase {
  transport: "http" | "streamable-http";
  /** Streamable HTTP endpoint, e.g. https://mcp.example.com/mcp */
  url: string;
  /** Header name -> environment variable name. Raw secret values should not be stored in config. */
  headersFromEnv?: Record<string, string>;
  /** Enables OAuth 2.1 browser authorization through a loopback callback. */
  oauth?: boolean | {
    enabled?: boolean;
    scopes?: string[];
    clientName?: string;
  };
}

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;

export interface GlobalModelConfig {
  providers: ProviderProfile[];
  presets: {
    multi: JSONModelPreset<PresetModelsMulti>[];
    single: JSONModelPreset<PresetModelsSingle>[];
  };
  activePresetId: {
    multi: string;
    single: string;
  };
  settings?: SystemSettings;
  trustedDirectories?: string[];
  activeHooks?: Record<string, string[]>;
  mcpServers?: Record<string, McpServerConfig>;
}
