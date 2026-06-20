/**
 * fastcontextTool.ts — FastContext repository explorer tool.
 *
 * Wraps Microsoft's FastContext (https://github.com/microsoft/fastcontext)
 * as a read-only codebase exploration tool. Everything is self-contained
 * inside the project:
 *
 *   bin/python/           — Portable Python 3.12 (embeddable) + pip + deps
 *   vendor/fastcontext/   — FastContext source code (git clone)
 *   src/core/tools/fastcontext_runner.py — Python wrapper
 *
 * All model/provider credentials come from Superagent's JSON config
 * (~/.superagent-r/model-config.json) and are passed as CLI arguments.
 * NO environment variables are used anywhere.
 */

import { execa } from "execa";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { Tool } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve the project root directory.
 * __dirname is either src/core/tools/ or dist/core/tools/ — go up 3 levels.
 */
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");

/** Path to the Python wrapper script (always in src/). */
const RUNNER_SCRIPT = path.join(
  PROJECT_ROOT, "src", "core", "tools", "fastcontext_runner.py"
);

/** FastContext source directory (vendored). */
const FC_SOURCE_DIR = path.join(PROJECT_ROOT, "vendor", "fastcontext", "src");

/** Path to the project-local portable Python executable. */
const PYTHON_BIN = process.platform === "win32"
  ? path.join(PROJECT_ROOT, "bin", "python", "python.exe")
  : path.join(PROJECT_ROOT, "bin", "python", "bin", "python3");

/** Default base URLs per provider type for OpenAI-compatible endpoints. */
const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  anthropic: "https://api.anthropic.com/v1",
};

/**
 * Resolve the OpenAI-compatible base URL, API key, and model name
 * for FastContext from Superagent's JSON config only.
 *
 * Priority:
 * 1. Researcher tier model + provider profile (if configured via /model)
 * 2. Subagent default model + provider profile
 * 3. Active (superagent/master) tier as ultimate fallback
 */
async function resolveFastContextCredentials(): Promise<{
  baseUrl: string;
  apiKey: string;
  model: string;
}> {
  const { loadModelConfig, getActivePreset } = await import("../config/jsonConfig.js");

  const config = loadModelConfig();
  const isMulti =
    process.argv.includes("--multi") || process.env.SUPERAGENT_MULTI === "true";
  const mode = isMulti ? "multi" : "single";
  const activePreset = getActivePreset<any>(mode);
  const providers = config.providers || [];

  // Determine tier config: researcher > subagentDefault > superagent
  const researcherTier = activePreset.models.subagentDetails?.researcher;
  const subagentDefault = activePreset.models.subagentDefault;
  const mainTier =
    mode === "multi"
      ? activePreset.models.master
      : activePreset.models.superagent;

  const tierConfig = researcherTier || subagentDefault || mainTier;

  // Find matching provider profile by ID
  let providerProfile = tierConfig?.providerProfileId
    ? providers.find((p: any) => p.id === tierConfig.providerProfileId)
    : undefined;

  // Fallback: find any provider with a non-empty API key
  if (!providerProfile) {
    providerProfile = providers.find(
      (p: any) => p.apiKey && p.apiKey.trim() !== ""
    );
  }

  const providerType: string = providerProfile?.provider || "openai";
  const apiKey: string = providerProfile?.apiKey || "";
  const customBaseUrl: string = providerProfile?.baseUrl || "";
  const model: string = tierConfig?.model || "gpt-4o";

  let baseUrl: string;
  if (customBaseUrl) {
    baseUrl = customBaseUrl;
  } else {
    baseUrl = DEFAULT_BASE_URLS[providerType] || DEFAULT_BASE_URLS.openai;
  }

  return { baseUrl, apiKey, model };
}

export const fastcontextTool: Tool = {
  name: "fastcontext",
  description:
    "Explore the codebase using Microsoft's FastContext — an AI-powered repository explorer " +
    "that uses read-only tools (Read, Glob, Grep) with multi-step reasoning and parallel tool " +
    "calls to find relevant code and return compact file-line citations. Uses the model " +
    "configured for the 'researcher' tier (set via /model). FastContext is significantly more " +
    "efficient than manual grep/read chains for broad exploration queries.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Natural-language exploration query. Be specific: name the behavior, subsystem, " +
          "error, or files you want to locate. Examples: 'Find the files that implement " +
          "authentication', 'Locate the request validation logic', 'Where are database " +
          "migrations defined?'",
      },
      maxTurns: {
        type: "number",
        description:
          "Maximum exploration turns (default: 6). Use 8-12 for deep architecture " +
          "tracing, 4-6 for focused lookups.",
      },
      citation: {
        type: "boolean",
        description:
          "If true, return only compact file:line citations (default: true). " +
          "Set to false for a more verbose explanation alongside citations.",
      },
    },
    required: ["query"],
  },

  async execute(args, cwd, signal) {
    const query = args.query as string;
    const maxTurns = (args.maxTurns as number) || 6;
    const citation = args.citation !== false; // default: true

    if (!query || query.trim().length === 0) {
      return "Error: 'query' parameter is required. Provide a specific exploration question.";
    }

    // ── 1. Verify project-local Python exists ──
    if (!existsSync(PYTHON_BIN)) {
      return (
        "FastContext portable Python is not installed.\n" +
        `Expected at: ${PYTHON_BIN}\n` +
        "Run the setup script to install:\n" +
        "  PowerShell: .\\bin\\setup-fastcontext.ps1\n"
      );
    }

    // ── 2. Resolve credentials from JSON config (no env vars) ──
    let baseUrl: string;
    let apiKey: string;
    let model: string;

    try {
      const creds = await resolveFastContextCredentials();
      baseUrl = creds.baseUrl;
      apiKey = creds.apiKey;
      model = creds.model;
    } catch (err: any) {
      return (
        `Error resolving model/provider config: ${err.message}\n` +
        "Ensure at least one provider is configured via /login."
      );
    }

    if (!apiKey || apiKey.trim() === "" || apiKey === "dummy") {
      return (
        "Error: No API key configured. Run /login to add provider credentials " +
        "before using FastContext."
      );
    }

    // ── 3. Build CLI args — ALL credentials as flags, ZERO env vars ──
    const cliArgs = [
      RUNNER_SCRIPT,
      "--source-dir", FC_SOURCE_DIR,
      "--model", model,
      "--api-key", apiKey,
      "--base-url", baseUrl,
      "--work-dir", cwd,
      "--query", query,
      "--max-turns", String(maxTurns),
    ];
    if (citation) {
      cliArgs.push("--citation");
    }

    // ── 4. Spawn Python runner with live log streaming ──
    try {
      // Get current agent to push live events into its UI stream
      const { agentLocalStorage } = await import("../agent.js");
      const agent = agentLocalStorage.getStore();
      const log = (msg: string) => {
        agent?.emitToolLog(msg);
      };

      const child = execa(PYTHON_BIN, cliArgs, {
        cwd,
        timeout: 180_000,
        reject: false,
        cancelSignal: signal,
        buffer: false,
      });

      // ── Stream stderr JSONL events → agent UI ──
      let stderrBuf = "";

      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split("\n");
        stderrBuf = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const evt = JSON.parse(trimmed);

            switch (evt.event) {
              case "start":
                log(`\n  [FC] ⚡ Exploring: "${evt.query}"\n`);
                break;
              case "turn":
                log(`  [FC] ── Turn ${evt.turn} ──\n`);
                break;
              case "thinking": {
                const snippet = (evt.text || "").replace(/\n/g, " ").slice(0, 140);
                const suffix = evt.has_tools ? " → tools" : "";
                log(`  [FC] 💭 ${snippet}${suffix}\n`);
                break;
              }
              case "tool_start": {
                const toolArgs = (evt.args || "").replace(/\n/g, " ").slice(0, 100);
                log(`  [FC] 🔧 ${evt.tool}: ${toolArgs}\n`);
                break;
              }
              case "tool_end": {
                const preview = (evt.preview || "").replace(/\n/g, " ").slice(0, 100);
                const icon = evt.ok ? "✅" : "❌";
                log(`  [FC] ${icon} ${preview}\n`);
                break;
              }
              case "error":
                log(`  [FC] 🚨 ${evt.text}\n`);
                break;
              case "done":
                log(`  [FC] ✔ Done (${evt.turns} turns)\n\n`);
                break;
            }
          } catch {
            // Non-JSON stderr
            log(`  [FC] ${trimmed}\n`);
          }
        }
      });

      const result = await child;

      // Flush remaining stderr
      if (stderrBuf.trim()) {
        try {
          const evt = JSON.parse(stderrBuf.trim());
          if (evt.event === "error") log(`  [FC] 🚨 ${evt.text}\n`);
        } catch {
          log(`  [FC] ${stderrBuf.trim()}\n`);
        }
      }

      const output = (result.stdout || "").trim();
      const stderrRaw = (result.stderr || "").trim();

      if (result.exitCode !== 0 && !output) {
        return (
          `FastContext exited with code ${result.exitCode}.\n` +
          (stderrRaw ? `stderr: ${stderrRaw}` : "No output was produced.")
        );
      }

      return output || "(FastContext returned no output)";
    } catch (err: any) {
      const msg = err?.message || String(err);

      if (msg.includes("timed out") || msg.includes("timeout")) {
        return (
          "FastContext timed out after 3 minutes. " +
          "Try a more specific query or reduce --max-turns."
        );
      }

      return `FastContext error: ${msg}`;
    }
  },
};
