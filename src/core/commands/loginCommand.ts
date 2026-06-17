import { registry } from "./registry.js";
import { SlashCommand, getDefaultModel } from "./types.js";
import {
  getConfiguredProviders,
  switchActiveProvider,
  fetchAndCacheModels,
  getContextWindowLimit,
  addProvider,
  getProviders,
  removeProvider
} from "../config.js";

export const loginCommand: SlashCommand = {
  name: "login",
  description: "Manage and authenticate provider profiles (add, list, remove)",
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
            "2. List Configured Providers"
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
            "  /login add <api_key> (auto-detects OpenRouter, Anthropic, OpenAI)",
            "  /login add <provider> <api_key>",
            "  /login add custom <base_url> <api_key>",
            "  /login list",
            "  /login remove <provider_id>",
          ].join("\n"),
          timestamp: now,
        });
      }
      return;
    }

    // Direct /login list → open provider selection wizard (step 100)
    if (args.trim() === "list") {
      if (ctx.setActiveWizard) {
        const providers = getProviders().filter(p => p.apiKey && p.apiKey.trim() !== "");
        if (providers.length === 0) {
          ctx.addLine({
            type: "system",
            content: "No providers configured yet. Use /login to add one.",
            timestamp: now,
          });
          return;
        }
        const providerOptions = providers.map(
          (p, i) => `${i + 1}. ${p.name} [${p.provider}]${p.baseUrl ? ` (${p.baseUrl})` : ""}`
        );
        ctx.setActiveWizard({
          type: "login",
          step: 100,
          data: {},
        });
        ctx.setWizardOptions?.(providerOptions);
        ctx.setWizardSelectedIndex?.(0);
      }
      return;
    }

    const parts = args.split(/\s+/);
    const actionArg = parts[0].toLowerCase();
    
    let action: "add" | "list" | "remove" | null = null;
    let shiftArgs = false;

    if (actionArg === "add") {
      action = "add";
      shiftArgs = true;
    } else if (actionArg === "list") {
      action = "list";
      shiftArgs = true;
    } else if (actionArg === "remove") {
      action = "remove";
      shiftArgs = true;
    } else {
      // Backward compatibility fallback
      if (
        ["openrouter", "anthropic", "openai", "custom"].includes(actionArg) ||
        actionArg.startsWith("sk-")
      ) {
        action = "add";
        shiftArgs = false;
        ctx.addLine({
          type: "system",
          content: `Warning: Direct use of /login is deprecated. Please use: /login add ${args}`,
          timestamp: now,
        });
      }
    }

    if (!action) {
      ctx.addLine({
        type: "error",
        content: `Error: Invalid subcommand "${parts[0]}". Supported subcommands: add, list, remove`,
        timestamp: now,
      });
      return;
    }

    const subParts = shiftArgs ? parts.slice(1) : parts;

    if (action === "list") {
      const providers = getProviders();
      if (providers.length === 0) {
        ctx.addLine({
          type: "system",
          content: "No providers configured yet.",
          timestamp: now,
        });
        return;
      }

      const lines = [
        "Configured Providers:",
        ...providers.map(p => {
          const masked = p.apiKey
            ? (p.apiKey.length <= 8 ? "*".repeat(p.apiKey.length) : `${p.apiKey.slice(0, 4)}...${p.apiKey.slice(-4)}`)
            : "None";
          const baseStr = p.baseUrl ? ` (Base URL: ${p.baseUrl})` : "";
          return `  - ${p.id} [${p.provider}] (API Key: ${masked})${baseStr}`;
        })
      ];

      ctx.addLine({
        type: "system",
        content: lines.join("\n"),
        timestamp: now,
      });
      return;
    }

    if (action === "remove") {
      if (subParts.length < 1) {
        ctx.addLine({
          type: "error",
          content: "Error: /login remove requires <provider_id>",
          timestamp: now,
        });
        return;
      }

      const targetId = subParts[0].toLowerCase();
      const providers = getProviders();
      const target = providers.find(p => p.id === targetId);

      if (!target) {
        ctx.addLine({
          type: "error",
          content: `Error: Provider with ID "${targetId}" not found.`,
          timestamp: now,
        });
        return;
      }

      try {
        removeProvider(targetId);
        ctx.addLine({
          type: "system",
          content: `Successfully removed provider: ${targetId}`,
          timestamp: now,
        });
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to remove provider: ${err.message}`,
          timestamp: now,
        });
      }
      return;
    }

    if (action === "add") {
      if (subParts.length < 1) {
        ctx.addLine({
          type: "error",
          content: "Error: /login add requires an API key, provider or custom URL",
          timestamp: now,
        });
        return;
      }

      let provider = "";
      let apiKey = "";
      let baseUrl = "";

      if (subParts[0].toLowerCase() === "custom") {
        if (subParts.length < 3) {
          ctx.addLine({
            type: "error",
            content: "Error: /login add custom requires <base_url> and <api_key>",
            timestamp: now,
          });
          return;
        }
        provider = "custom";
        baseUrl = subParts[1];
        apiKey = subParts[2];
      } else if (["openrouter", "anthropic", "openai"].includes(subParts[0].toLowerCase())) {
        if (subParts.length < 2) {
          ctx.addLine({
            type: "error",
            content: `Error: /login add ${subParts[0]} requires <api_key>`,
            timestamp: now,
          });
          return;
        }
        provider = subParts[0].toLowerCase();
        apiKey = subParts[1];
      } else {
        apiKey = subParts[0];
        if (apiKey.startsWith("sk-or-")) {
          provider = "openrouter";
        } else if (apiKey.startsWith("sk-ant-")) {
          provider = "anthropic";
        } else {
          provider = "openai";
        }
      }

      const profileId = provider.toLowerCase().replace(/[^a-z0-9_-]/g, "");

      try {
        addProvider({
          id: profileId,
          name: provider,
          provider: provider,
          apiKey: apiKey,
          baseUrl: baseUrl || (provider === "openrouter" ? "https://openrouter.ai/api/v1" : undefined),
        });

        // Switch active preset to use this provider
        switchActiveProvider(profileId);

        ctx.addLine({
          type: "system",
          content: `Successfully logged in. Configured provider: ${provider}.\nSaved to model-config.json`,
          timestamp: now,
        });

        // Set default model based on provider type
        let defaultModel = "gpt-4o";
        if (provider === "openrouter") {
          defaultModel = "google/gemini-2.5-flash";
        } else if (provider === "anthropic") {
          defaultModel = "claude-3-5-sonnet-20241022";
        }
        if (ctx.setActiveModel) {
          ctx.setActiveModel(defaultModel);
        }

        fetchAndCacheModels()
          .then(() => {
            const limit = getContextWindowLimit(defaultModel);
            if (ctx.setContextLimit) ctx.setContextLimit(limit);
            if (ctx.setActiveModel) ctx.setActiveModel(defaultModel);
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
  }
};

registry.register(loginCommand);
