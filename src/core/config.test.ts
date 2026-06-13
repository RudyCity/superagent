import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { getGlobalConfigDir, getContextWindowLimit, getConfig, fetchAndCacheModels, listHistorySessions, getModelInstanceForTier, getModelInstanceForString } from "./config.js";

describe("config", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Back up process.env to avoid side effects
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore process.env
    process.env = originalEnv;
  });

  it("should get global config directory containing expected name", () => {
    const dir = getGlobalConfigDir();
    expect(dir).toContain(".superagent-r");
  });

  it("should return correct context window limits based on model name", () => {
    expect(getContextWindowLimit("claude-3-5-sonnet")).toBe(200000);
    expect(getContextWindowLimit("gpt-4o")).toBe(128000);
    expect(getContextWindowLimit("o1-preview")).toBe(200000);
    expect(getContextWindowLimit("unknown-model")).toBe(256000);
  });

  it("should read context window limits from models_cache.json if present", () => {
    const cachePath = path.join(getGlobalConfigDir(), "models_cache.json");
    
    // Save existing cache file if it exists
    let existingContent: string | null = null;
    if (fs.existsSync(cachePath)) {
      existingContent = fs.readFileSync(cachePath, "utf-8");
    }

    try {
      // Ensure dir exists
      fs.mkdirSync(getGlobalConfigDir(), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify({ "my-special-cached-model": 999999 }), "utf-8");
      
      expect(getContextWindowLimit("my-special-cached-model")).toBe(999999);
    } finally {
      // Clean up
      if (existingContent !== null) {
        fs.writeFileSync(cachePath, existingContent, "utf-8");
      } else {
        try {
          fs.unlinkSync(cachePath);
        } catch {}
      }
    }
  });

  it("should fallback to rich static lookups if not cached", () => {
    expect(getContextWindowLimit("google/gemini-2.5-flash")).toBe(1048576);
    expect(getContextWindowLimit("deepseek-chat")).toBe(131072);
    expect(getContextWindowLimit("meta-llama/llama-3.3-70b-instruct")).toBe(131072);
    
    // Explicit and dynamic free models
    expect(getContextWindowLimit("google/gemma-4-26b-a4b-it:free")).toBe(262144);
    expect(getContextWindowLimit("meta-llama/llama-3.3-70b-instruct:free")).toBe(131072);
    expect(getContextWindowLimit("qwen/qwen3-coder:free")).toBe(1048576);
  });

  it("should fetch and cache models from provider correctly", async () => {
    // Mock global fetch
    const mockResponseData = {
      data: [
        { id: "fetched-model-1", context_length: 50000 },
        { id: "fetched-model-2", metadata: { max_model_len: 60000 } }
      ]
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(() => 
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockResponseData)
      } as Response)
    );

    // Mock active provider env override to test OpenAI/custom provider path
    process.env.ACTIVE_PROVIDER = "custom";
    process.env.CUSTOM_BASE_URL = "http://localhost:8080/v1";
    process.env.CUSTOM_API_KEY = "test-key";

    const cachePath = path.join(getGlobalConfigDir(), "models_cache.json");
    let existingContent: string | null = null;
    if (fs.existsSync(cachePath)) {
      existingContent = fs.readFileSync(cachePath, "utf-8");
    }

    try {
      await fetchAndCacheModels();
      
      expect(getContextWindowLimit("fetched-model-1")).toBe(50000);
      expect(getContextWindowLimit("fetched-model-2")).toBe(60000);
    } finally {
      // Restore
      globalThis.fetch = originalFetch;
      if (existingContent !== null) {
        fs.writeFileSync(cachePath, existingContent, "utf-8");
      } else {
        try {
          fs.unlinkSync(cachePath);
        } catch {}
      }
    }
  });

  it("should resolve config using active provider env overrides", () => {
    process.env.ACTIVE_PROVIDER = "anthropic";
    process.env.PROVIDER_ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.MODEL = "claude-3-5-sonnet";

    const config = getConfig();
    expect(config.provider).toBe("anthropic");
  });

  it("should fallback config provider appropriately", () => {
    // Clean up env keys
    delete process.env.ACTIVE_PROVIDER;
    delete process.env.CUSTOM_BASE_URL;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.MODEL = "my-custom-model";

    const config = getConfig();
    expect(config.provider).toBe("anthropic");
    expect(config.apiKey).toBe("sk-ant-test");
    expect(config.model).toBe("my-custom-model");
  });

  describe("listHistorySessions", () => {
    it("should only return history sessions matching the current active project path or its subdirectories", () => {
      const historyDirSingle = path.join(getGlobalConfigDir(), "history", "single");

      const mockCwd = "D:\\projects\\my-awesome-project";
      const spyCwd = vi.spyOn(process, "cwd").mockReturnValue(mockCwd);

      const spyExistsSync = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const pathStr = typeof p === "string" ? p : p.toString();
        if (pathStr.includes("history")) return true;
        return false;
      });

      const mockDirs = [
        "D__projects_my_awesome_project_123",
        "d__projects_my_awesome_project_src_456",
        "D__projects_another_project_789",
      ];
      const spyReaddirSync = vi.spyOn(fs, "readdirSync").mockReturnValue(mockDirs as any);

      const spyStatSync = vi.spyOn(fs, "statSync").mockReturnValue({
        mtime: new Date(),
      } as any);

      const spyReadFileSync = vi.spyOn(fs, "readFileSync").mockImplementation((p) => {
        const filePath = typeof p === "string" ? p : p.toString();
        if (filePath.includes("my_awesome_project_src")) {
          // Object format
          return JSON.stringify({
            messages: [
              { role: "user", content: "hello from object" },
              { role: "assistant", content: "hi from object" }
            ],
            planState: "IDLE"
          });
        }
        // Legacy array format
        return JSON.stringify([
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" }
        ]);
      });

      try {
        const sessions = listHistorySessions();
        // Should only match:
        // - "D__projects_my_awesome_project_123"
        // - "d__projects_my_awesome_project_src_456"
        expect(sessions.length).toBe(2);
        expect(sessions[0].filePath).toContain("my_awesome_project");
        expect(sessions[0].messageCount).toBe(2);
        expect(sessions[0].preview).toBe("hello");

        expect(sessions[0].displayName).toBe("hello");

        expect(sessions[1].filePath).toContain("my_awesome_project_src");
        expect(sessions[1].messageCount).toBe(2);
        expect(sessions[1].preview).toBe("hello from object");
        expect(sessions[1].displayName).toBe("hello from object");
      } finally {
        spyCwd.mockRestore();
        spyExistsSync.mockRestore();
        spyReaddirSync.mockRestore();
        spyStatSync.mockRestore();
        spyReadFileSync.mockRestore();
      }
    });

    it("should filter between single-agent and multi-agent sessions when isMulti flag is provided", () => {
      const mockCwd = "D:\\projects\\my-awesome-project";
      const spyCwd = vi.spyOn(process, "cwd").mockReturnValue(mockCwd);

      const spyExistsSync = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const pathStr = typeof p === "string" ? p : p.toString();
        if (pathStr.includes("history")) return true;
        return false;
      });

      const spyReaddirSync = vi.spyOn(fs, "readdirSync").mockImplementation((p) => {
        const pathStr = typeof p === "string" ? p : p.toString();
        if (pathStr.includes("single")) {
          return ["D__projects_my_awesome_project_123"] as any;
        }
        if (pathStr.includes("multi")) {
          return ["D__projects_my_awesome_project_456"] as any;
        }
        return [] as any;
      });

      const spyStatSync = vi.spyOn(fs, "statSync").mockReturnValue({
        mtime: new Date(),
      } as any);

      const spyReadFileSync = vi.spyOn(fs, "readFileSync").mockReturnValue(
        JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        })
      );

      try {
        const singleSessions = listHistorySessions(false);
        expect(singleSessions.length).toBe(1);
        expect(singleSessions[0].filePath).toContain("my_awesome_project_123");

        const multiSessions = listHistorySessions(true);
        expect(multiSessions.length).toBe(1);
        expect(multiSessions[0].filePath).toContain("my_awesome_project_456");
      } finally {
        spyCwd.mockRestore();
        spyExistsSync.mockRestore();
        spyReaddirSync.mockRestore();
        spyStatSync.mockRestore();
        spyReadFileSync.mockRestore();
      }
    });
  });

  it("should namespace getGlobalConfigDir if process.env.SUPERAGENT_SESSION_ID is set", () => {
    process.env.SUPERAGENT_SESSION_ID = "session-123456";
    const dir = getGlobalConfigDir();
    expect(dir).toContain(path.join(".superagent-r", "sessions", "session-123456"));
  });

  describe("getModelInstanceForTier", () => {
    beforeEach(() => {
      process.env.OPENAI_API_KEY = "dummy-openai-key";
      process.env.ANTHROPIC_API_KEY = "dummy-anthropic-key";
      process.env.CUSTOM_API_KEY = "dummy-custom-key";
      process.env.CUSTOM_BASE_URL = "http://localhost:11434/v1";
    });

    it("should resolve specific model per agent tier using MODEL_DEPTH_x or MODEL_DEPTx", () => {
      process.env.MODEL_DEPTH_0 = "openai:gpt-4o-mini";
      process.env.MODEL_DEPT1 = "anthropic:claude-3-5-sonnet";
      process.env.MODEL_DEPTH_2 = "custom:local-llama";

      const masterModel: any = getModelInstanceForTier("master", 0);
      expect(masterModel.modelId).toBe("gpt-4o-mini");

      const superagentModel: any = getModelInstanceForTier("superagent", 1);
      expect(superagentModel.modelId).toBe("claude-3-5-sonnet");

      const subagentModel: any = getModelInstanceForTier("subagent", 2);
      expect(subagentModel.modelId).toBe("local-llama");
    });

    it("should resolve subagent-specific model override (MODEL_SUBAGENT_<TYPE> or MODEL_<TYPE>)", () => {
      process.env.MODEL_DEPTH_2 = "custom:general-subagent-model";
      process.env.MODEL_SUBAGENT_RESEARCHER = "openai:gpt-4-turbo";
      process.env.MODEL_CODER = "anthropic:claude-3-5-haiku";

      const researcherModel: any = getModelInstanceForTier("subagent", 2, "researcher");
      expect(researcherModel.modelId).toBe("gpt-4-turbo");

      const coderModel: any = getModelInstanceForTier("subagent", 2, "coder");
      expect(coderModel.modelId).toBe("claude-3-5-haiku");

      const reviewerModel: any = getModelInstanceForTier("subagent", 2, "reviewer");
      expect(reviewerModel.modelId).toBe("general-subagent-model");
    });

    it("should fallback to default config model if tier-specific environments are not set", () => {
      delete process.env.MODEL_DEPTH_0;
      delete process.env.MODEL_DEPT0;
      process.env.MODEL = "openai:gpt-4o";

      const masterModel: any = getModelInstanceForTier("master", 0);
      expect(masterModel.modelId).toBe("gpt-4o");
    });
  });
});
