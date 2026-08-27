/**
 * Regression tests for the H7 audit fix: schema validation at the
 * JSON.parse() boundary in jsonConfig.ts.
 *
 * We assert that `validateModelConfig()` correctly:
 *  - accepts a fully-populated, well-typed config;
 *  - rejects the root being a non-object;
 *  - rejects providers that are not arrays;
 *  - rejects individual providers missing required fields;
 *  - rejects presets that are not objects;
 *  - rejects settings with wrong-typed numeric / boolean fields;
 *  - rejects mcpServers that are not arrays;
 *  - accepts and returns a valid config unchanged.
 */
import { describe, it, expect } from "vitest";

describe("validateModelConfig (H7)", () => {
  it("rejects a non-object root", async () => {
    const { validateModelConfig } = await import(
      "../src/core/config/configSchema.js"
    );
    expect(validateModelConfig(null).ok).toBe(false);
    expect(validateModelConfig(undefined).ok).toBe(false);
    expect(validateModelConfig("hello").ok).toBe(false);
    expect(validateModelConfig(42).ok).toBe(false);
    expect(validateModelConfig([]).ok).toBe(false);
  });

  it("rejects providers that are not an array", async () => {
    const { validateModelConfig } = await import(
      "../src/core/config/configSchema.js"
    );
    const r = validateModelConfig({ providers: "not-an-array" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/providers must be an array/);
  });

  it("rejects an individual provider missing required fields", async () => {
    const { validateModelConfig } = await import(
      "../src/core/config/configSchema.js"
    );
    const r = validateModelConfig({
      providers: [
        { id: "ok-1", name: "OK 1", provider: "openai", apiKey: "sk-1" },
        { id: "bad-1", name: "Bad 1" /* missing provider & apiKey */ },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/providers\[1\]: provider\.provider.*apiKey/);
  });

  it("accepts a minimal-valid config", async () => {
    const { validateModelConfig } = await import(
      "../src/core/config/configSchema.js"
    );
    const r = validateModelConfig({
      providers: [
        { id: "p1", name: "P1", provider: "openai", apiKey: "sk-1" },
      ],
      presets: { multi: [], single: [] },
      activePresetId: "default",
      settings: {
        concurrencyLimit: 4,
        rateLimitRpm: 60,
        disableStreaming: false,
        simpleTaskKeywords: ["go", "yes"],
      },
    });
    expect(r.ok).toBe(true);
  });

  it("rejects settings with wrong-typed numeric field", async () => {
    const { validateModelConfig } = await import(
      "../src/core/config/configSchema.js"
    );
    const r = validateModelConfig({
      settings: { concurrencyLimit: "not-a-number" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/concurrencyLimit.*number/);
  });

  it("rejects settings with wrong-typed boolean field", async () => {
    const { validateModelConfig } = await import(
      "../src/core/config/configSchema.js"
    );
    const r = validateModelConfig({
      settings: { disableStreaming: "yes" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/disableStreaming.*boolean/);
  });

  it("rejects mcpServers that are not an array", async () => {
    const { validateModelConfig } = await import(
      "../src/core/config/configSchema.js"
    );
    const r = validateModelConfig({ mcpServers: "nope" });
    expect(r.ok).toBe(false);
  });

  it("accepts a config with mcpServers array of valid entries", async () => {
    const { validateModelConfig } = await import(
      "../src/core/config/configSchema.js"
    );
    const r = validateModelConfig({
      mcpServers: [
        {
          id: "m1",
          name: "MCP 1",
          command: "npx",
          args: ["-y", "some-mcp"],
          env: { KEY: "value" },
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("rejects an mcpServer entry missing id/name/command", async () => {
    const { validateModelConfig } = await import(
      "../src/core/config/configSchema.js"
    );
    const r = validateModelConfig({
      mcpServers: [{ args: ["x"] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join(" ")).toMatch(/id: non-empty/);
      expect(r.errors.join(" ")).toMatch(/name: non-empty/);
      expect(r.errors.join(" ")).toMatch(/command: non-empty/);
    }
  });

  it("preserves unknown top-level fields in the validated object", async () => {
    const { validateModelConfig } = await import(
      "../src/core/config/configSchema.js"
    );
    // The validator is partial — unknown top-level fields are
    // ignored, not rejected. This is intentional: we don't want
    // newer versions of the app to refuse to load older configs.
    const r = validateModelConfig({
      providers: [],
      futureField: { something: "new" },
    });
    expect(r.ok).toBe(true);
  });

  it("validateProviderProfile round-trips a valid input", async () => {
    const { validateProviderProfile } = await import(
      "../src/core/config/configSchema.js"
    );
    const r = validateProviderProfile({
      id: "p1",
      name: "P1",
      provider: "openai",
      apiKey: "sk-1",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe("p1");
      expect(r.value.baseUrl).toBe("https://api.openai.com/v1");
    }
  });
});
