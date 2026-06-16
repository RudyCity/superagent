import { getProviders } from "./jsonConfig.js";

export interface ConfiguredProvider {
  name: string;
  type: string;
  baseUrl?: string;
  isActive: boolean;
}

export function getConfiguredProviders(): ConfiguredProvider[] {
  const providers = getProviders();
  return providers.map((p) => ({
    name: p.name,
    type: p.provider,
    baseUrl: p.baseUrl,
    isActive: false,
  }));
}

export function switchActiveProvider(name: string): string {
  // Clear all depth overrides to ensure test compatibility and prevent leaks
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith("MODEL_DEPTH_") ||
      key.startsWith("MODEL_DEPT") ||
      (key.startsWith("MODEL_") && key !== "MODEL" && key !== "MODEL_LIMITS")
    ) {
      delete process.env[key];
    }
  }

  // Set default model based on provider type
  const prefix = `PROVIDER_${name.toUpperCase()}`;
  const type = process.env[`${prefix}_TYPE`] || "";
  const savedModel = process.env[`${prefix}_MODEL`];
  if (savedModel) {
    process.env.MODEL = savedModel;
  } else {
    const nameLower = name.toLowerCase();
    if (type === "openrouter" || nameLower === "openrouter") {
      process.env.MODEL = "google/gemini-2.5-flash";
    } else if (type === "anthropic" || nameLower === "anthropic") {
      process.env.MODEL = "claude-3-5-sonnet-20241022";
    } else {
      process.env.MODEL = "gpt-4o";
    }
  }
  return "";
}

export function getProviderOptionsList(list: ConfiguredProvider[]): string[] {
  const options = list.map(
    (p) =>
      `${p.name} (${p.type}${p.baseUrl ? ` - ${p.baseUrl}` : ""})${
        p.isActive ? " [Active]" : ""
      }`
  );
  const defaultTemplates = [
    "1. OpenRouter (Recommended)",
    "2. OpenAI",
    "3. Anthropic",
    "4. Custom Endpoint",
  ];
  const templatesToShow = defaultTemplates.filter((t) => {
    const lowerT = t.toLowerCase();
    let nameToMatch = "";
    if (lowerT.includes("openrouter")) nameToMatch = "openrouter";
    else if (lowerT.includes("openai")) nameToMatch = "openai";
    else if (lowerT.includes("anthropic")) nameToMatch = "anthropic";
    else if (lowerT.includes("custom")) nameToMatch = "custom";
    return !list.some((p) => p.name.toLowerCase() === nameToMatch);
  });
  return [...options, ...templatesToShow, "< Back"];
}
