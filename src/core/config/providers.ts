import { ensureGlobalConfigDir } from "./paths.js";
import { updateEnvFile } from "./env.js";

export interface ConfiguredProvider {
  name: string;
  type: string;
  baseUrl?: string;
  isActive: boolean;
}

export function getConfiguredProviders(): ConfiguredProvider[] {
  const providers: ConfiguredProvider[] = [];
  const active = process.env.ACTIVE_PROVIDER || "";

  // Add defaults if they are set in env directly (legacy)
  if (process.env.ANTHROPIC_API_KEY && !process.env.PROVIDER_ANTHROPIC_API_KEY) {
    providers.push({ name: "anthropic", type: "anthropic", isActive: !active || active.toLowerCase() === "anthropic" });
  }
  if (process.env.OPENAI_API_KEY && !process.env.PROVIDER_OPENAI_API_KEY) {
    providers.push({ name: "openai", type: "openai", isActive: !active || active.toLowerCase() === "openai" });
  }
  if (process.env.CUSTOM_BASE_URL && !process.env.PROVIDER_CUSTOM_API_KEY) {
    providers.push({ name: "custom", type: "custom", baseUrl: process.env.CUSTOM_BASE_URL, isActive: active.toLowerCase() === "custom" });
  }

  // Scan for PROVIDER_<NAME>_*
  const seen = new Set<string>(providers.map(p => p.name.toLowerCase()));
  for (const key of Object.keys(process.env)) {
    const match = key.match(/^PROVIDER_([A-Z0-9_]+)_API_KEY$/);
    if (match) {
      const name = match[1].toLowerCase();
      if (!seen.has(name)) {
        seen.add(name);
        const type = process.env[`PROVIDER_${match[1]}_TYPE`] || (name === "anthropic" ? "anthropic" : name === "openai" ? "openai" : name === "openrouter" ? "custom" : "custom");
        const baseUrl = process.env[`PROVIDER_${match[1]}_BASE_URL`];
        providers.push({
          name,
          type,
          baseUrl,
          isActive: active.toLowerCase() === name
        });
      }
    }
  }

  return providers;
}

export function switchActiveProvider(name: string): string {
  const prefix = `PROVIDER_${name.toUpperCase()}`;
  const type = process.env[`${prefix}_TYPE`] || "";
  const apiKey = process.env[`${prefix}_API_KEY`] || "";
  const baseUrl = process.env[`${prefix}_BASE_URL`] || "";

  const updates: Record<string, string> = {
    ACTIVE_PROVIDER: name,
  };

  // Reset all tier and subagent specific model overrides to avoid provider mismatch/dead models
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MODEL_DEPTH_") || key.startsWith("MODEL_DEPT") || 
        (key.startsWith("MODEL_") && key !== "MODEL" && key !== "MODEL_LIMITS")) {
      updates[key] = "";
      delete process.env[key];
    }
  }

  const savedModel = process.env[`${prefix}_MODEL`];
  if (savedModel) {
    updates["MODEL"] = savedModel;
  } else {
    const typeLower = (type || "").toLowerCase();
    const nameLower = name.toLowerCase();
    if (typeLower === "openrouter" || nameLower === "openrouter") {
      updates["MODEL"] = "google/gemini-2.5-flash";
    } else if (typeLower === "anthropic" || nameLower === "anthropic") {
      updates["MODEL"] = "claude-3-5-sonnet-20241022";
    } else if (typeLower === "openai" || nameLower === "openai") {
      updates["MODEL"] = "gpt-4o";
    } else {
      updates["MODEL"] = "gpt-4o";
    }
  }

  if (type === "openrouter" || name.toLowerCase() === "openrouter") {
    updates["CUSTOM_BASE_URL"] = "https://openrouter.ai/api/v1";
    updates["CUSTOM_API_KEY"] = apiKey;
    updates["ANTHROPIC_API_KEY"] = "";
    updates["OPENAI_API_KEY"] = "";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  } else if (type === "anthropic" || name.toLowerCase() === "anthropic") {
    updates["ANTHROPIC_API_KEY"] = apiKey;
    updates["CUSTOM_BASE_URL"] = "";
    updates["CUSTOM_API_KEY"] = "";
    updates["OPENAI_API_KEY"] = "";
    delete process.env.CUSTOM_BASE_URL;
    delete process.env.CUSTOM_API_KEY;
    delete process.env.OPENAI_API_KEY;
  } else if (type === "openai" || name.toLowerCase() === "openai") {
    updates["OPENAI_API_KEY"] = apiKey;
    updates["CUSTOM_BASE_URL"] = "";
    updates["CUSTOM_API_KEY"] = "";
    updates["ANTHROPIC_API_KEY"] = "";
    delete process.env.CUSTOM_BASE_URL;
    delete process.env.CUSTOM_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    updates["CUSTOM_BASE_URL"] = baseUrl;
    updates["CUSTOM_API_KEY"] = apiKey;
    updates["ANTHROPIC_API_KEY"] = "";
    updates["OPENAI_API_KEY"] = "";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  }

  return updateEnvFile(updates);
}
