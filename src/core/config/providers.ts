import { getProviders, loadModelConfig, getActivePreset, savePreset } from "./jsonConfig.js";

export interface ConfiguredProvider {
  name: string;
  type: string;
  baseUrl?: string;
  isActive: boolean;
}

export function getConfiguredProviders(): ConfiguredProvider[] {
  const providers = getProviders();
  const config = loadModelConfig();

  // Determine active provider profile ID from current preset
  const isMulti = process.argv.includes("--multi") || process.env.SUPERAGENT_MULTI === "true";
  const mode = isMulti ? "multi" : "single";
  const activePreset = getActivePreset<any>(mode);
  const tierConfig = mode === "multi" ? activePreset.models.master : activePreset.models.superagent;
  const activeProfileId = tierConfig?.providerProfileId || "";

  const list = providers
    .filter((p) => p.apiKey && p.apiKey.trim() !== "")
    .map((p) => ({
      name: p.name,
      type: p.provider,
      baseUrl: p.baseUrl,
      isActive: p.id === activeProfileId,
    }));

  return list;
}

export function switchActiveProvider(name: string): void {
  const config = loadModelConfig();
  const provider = config.providers.find(
    (p) => p.id === name || p.name.toLowerCase() === name.toLowerCase()
  );
  if (!provider) return;

  // Determine default model based on provider type
  let defaultModel = "gpt-4o";
  const type = provider.provider.toLowerCase();
  if (type === "openrouter") {
    defaultModel = "google/gemini-2.5-flash";
  } else if (type === "anthropic") {
    defaultModel = "claude-3-5-sonnet-20241022";
  }

  // Update active preset tiers to use this provider
  const isMulti = process.argv.includes("--multi") || process.env.SUPERAGENT_MULTI === "true";
  const mode = isMulti ? "multi" : "single";
  const activePreset = getActivePreset<any>(mode);

  const tierUpdate = { providerProfileId: provider.id, model: defaultModel };
  if (mode === "multi") {
    activePreset.models.master = { ...activePreset.models.master, ...tierUpdate };
  }
  activePreset.models.superagent = { ...activePreset.models.superagent, ...tierUpdate };

  savePreset(mode, activePreset);
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
