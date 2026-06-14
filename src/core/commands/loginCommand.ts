import { registry } from "./registry.js";
import { SlashCommand, getDefaultModel } from "./types.js";
import {
  getConfiguredProviders,
  switchActiveProvider,
  fetchAndCacheModels,
  updateEnvFile,
  getContextWindowLimit,
} from "../config.js";

export const loginCommand: SlashCommand = {
  name: "login",
  description: "Login to a provider (e.g. /login openrouter sk-or-...)",
  async execute(args, ctx) {
    const now = Date.now();
    if (!args) {
      if (ctx.setActiveWizard) {
        const list = getConfiguredProviders();
        if (list.length > 0) {
          ctx.setActiveWizard({
            type: "login",
            step: 1,
            data: {},
          });
          ctx.setWizardOptions?.([
            "1. Add / Log in to a Provider",
            "2. Switch Active Provider",
            "3. List Configured Providers"
          ]);
        } else {
          ctx.setActiveWizard({
            type: "login",
            step: 2,
            data: {},
          });
          ctx.setWizardOptions?.(["1. OpenRouter (Recommended)", "2. OpenAI", "3. Anthropic", "4. Custom Endpoint"]);
        }
        ctx.setWizardSelectedIndex?.(0);
      } else {
        ctx.addLine({
          type: "system",
          content: [
            "Usage:",
            "  /login <api_key> (auto-detects OpenRouter, Anthropic, OpenAI)",
            "  /login openrouter <api_key>",
            "  /login anthropic <api_key>",
            "  /login openai <api_key>",
            "  /login custom <base_url> <api_key>",
          ].join("\n"),
          timestamp: now,
        });
      }
      return;
    }

    const parts = args.split(/\s+/);
    let provider = "";
    let apiKey = "";
    let baseUrl = "";

    if (parts[0].toLowerCase() === "custom") {
      if (parts.length < 3) {
        ctx.addLine({
          type: "error",
          content: "Error: /login custom requires <base_url> and <api_key>",
          timestamp: now,
        });
        return;
      }
      provider = "custom";
      baseUrl = parts[1];
      apiKey = parts[2];
    } else if (["openrouter", "anthropic", "openai"].includes(parts[0].toLowerCase())) {
      if (parts.length < 2) {
        ctx.addLine({
          type: "error",
          content: `Error: /login ${parts[0]} requires <api_key>`,
          timestamp: now,
        });
        return;
      }
      provider = parts[0].toLowerCase();
      apiKey = parts[1];
    } else {
      apiKey = parts[0];
      if (apiKey.startsWith("sk-or-")) {
        provider = "openrouter";
      } else if (apiKey.startsWith("sk-ant-")) {
        provider = "anthropic";
      } else {
        provider = "openai";
      }
    }

    const profileName = provider;
    const prefix = `PROVIDER_${profileName.toUpperCase()}`;
    const updates: Record<string, string> = {
      ACTIVE_PROVIDER: profileName,
      [`${prefix}_TYPE`]: provider,
      [`${prefix}_API_KEY`]: apiKey,
    };

    if (baseUrl) {
      updates[`${prefix}_BASE_URL`] = baseUrl;
    } else if (provider === "openrouter") {
      updates[`${prefix}_BASE_URL`] = "https://openrouter.ai/api/v1";
    }

    try {
      updateEnvFile(updates);
      const envPath = switchActiveProvider(profileName);
      ctx.addLine({
        type: "system",
        content: `Successfully logged in. Configured provider: ${profileName} (${provider}).\nSaved to: ${envPath}`,
        timestamp: now,
      });

      if (provider === "openrouter" && !process.env.MODEL) {
        updateEnvFile({ MODEL: "google/gemini-2.5-flash" });
        if (ctx.setActiveModel) {
          const isMulti = ctx.agent?.isMultiAgent ?? false;
          const nextActiveModel = isMulti
            ? (process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || process.env.MODEL || getDefaultModel())
            : "google/gemini-2.5-flash";
          ctx.setActiveModel(nextActiveModel);
        }
      }

      fetchAndCacheModels()
        .then(() => {
          const currentModel = process.env.MODEL || getDefaultModel();
          const limit = getContextWindowLimit(currentModel);
          if (ctx.setContextLimit) {
            ctx.setContextLimit(limit);
          }
          if (ctx.setActiveModel) {
            const isMulti = ctx.agent?.isMultiAgent ?? false;
            const nextActiveModel = isMulti
              ? (process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || process.env.MODEL || getDefaultModel())
              : currentModel;
            ctx.setActiveModel(nextActiveModel);
          }
        })
        .catch(() => {});
    } catch (err: any) {
      ctx.addLine({
        type: "error",
        content: `Failed to save login credentials: ${err.message}`,
        timestamp: now,
      });
    }
  }
};

registry.register(loginCommand);
