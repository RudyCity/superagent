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
import { existsSync, readdirSync, unlinkSync, mkdirSync } from "fs";
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

/** Default fallback models per provider type when tier model is not set. */
const DEFAULT_FALLBACK_MODELS: Record<string, string> = {
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-20250514",
  openrouter: "anthropic/claude-sonnet-4-20250514",
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
  tierName: string;
  providerName: string;
  providerType: string;
  providerMismatch: boolean;
}> {
  const { loadModelConfig, getActivePreset } = await import("../config/jsonConfig.js");

  const config = loadModelConfig();
  const isMulti = process.argv.includes("--multi");
  const mode = isMulti ? "multi" : "single";
  const activePreset = getActivePreset<any>(mode);
  const providers = config.providers || [];

  // Determine tier config: researcher > subagentDefault > main tier
  const researcherTier = activePreset.models.subagentDetails?.researcher;
  const subagentDefault = activePreset.models.subagentDefault;
  const mainTier =
    mode === "multi"
      ? activePreset.models.master
      : activePreset.models.superagent;

  let tierConfig: any;
  let tierName: string;

  if (researcherTier?.model) {
    tierConfig = researcherTier;
    tierName = "researcher";
  } else if (subagentDefault?.model) {
    tierConfig = subagentDefault;
    tierName = "subagentDefault";
  } else {
    tierConfig = mainTier;
    tierName = mode === "multi" ? "master" : "superagent";
  }

  // Find matching provider profile by ID
  let providerProfile: any;
  let providerMismatch = false;

  if (tierConfig?.providerProfileId) {
    providerProfile = providers.find(
      (p: any) => p.id === tierConfig.providerProfileId
    );
    if (!providerProfile) {
      // Provider ID specified in tier but not found — fallback with mismatch flag
      providerProfile = providers.find(
        (p: any) => p.apiKey && p.apiKey.trim() !== ""
      );
      providerMismatch = true;
    }
  } else {
    // No provider specified in tier — find any with API key
    providerProfile = providers.find(
      (p: any) => p.apiKey && p.apiKey.trim() !== ""
    );
  }

  const providerType: string = providerProfile?.provider || "openai";
  const apiKey: string = providerProfile?.apiKey || "";
  const customBaseUrl: string = providerProfile?.baseUrl || "";
  const providerName: string = providerProfile?.name || providerProfile?.id || "unknown";

  // Avoid provider/model mismatch when tier provider is missing.
  const model: string = providerMismatch
    ? (DEFAULT_FALLBACK_MODELS[providerType] || DEFAULT_FALLBACK_MODELS.openai)
    : (
      tierConfig?.model ||
      DEFAULT_FALLBACK_MODELS[providerType] ||
      DEFAULT_FALLBACK_MODELS.openai
    );

  const baseUrl = customBaseUrl || DEFAULT_BASE_URLS[providerType] || DEFAULT_BASE_URLS.openai;

  return { baseUrl, apiKey, model, tierName, providerName, providerType, providerMismatch };
}

export const fastcontextTool: Tool = {
  name: "fastcontext",
  description:
    "Explore the codebase using Microsoft's FastContext — an AI-powered repository explorer " +
    "that uses read-only tools (Read, Glob, Grep) with multi-step reasoning and parallel tool " +
    "calls to find relevant code and return compact file-line citations. Uses the model " +
    "from the subagent tier (researcher > subagentDefault > main fallback). FastContext is significantly more " +
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
    let tierName: string;
    let providerName: string;
    let providerType: string;
    let providerMismatch: boolean;

    try {
      const creds = await resolveFastContextCredentials();
      baseUrl = creds.baseUrl;
      apiKey = creds.apiKey;
      model = creds.model;
      tierName = creds.tierName;
      providerName = creds.providerName;
      providerType = creds.providerType;
      providerMismatch = creds.providerMismatch;
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

    // ── 2.5. Generate unique trajectory path ──
    const trajectoryId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fcDir = path.join(cwd, ".fastcontext");
    const trajectoryPath = path.join(fcDir, `trajectory-${trajectoryId}.jsonl`);

    if (!existsSync(fcDir)) {
      mkdirSync(fcDir, { recursive: true });
    }

    // Cleanup stale trajectory files from previous runs
    try {
      const files = readdirSync(fcDir);
      for (const f of files) {
        if (f.startsWith("trajectory-") && f.endsWith(".jsonl")) {
          try { unlinkSync(path.join(fcDir, f)); } catch {}
        }
      }
    } catch {}

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
      "--trajectory-path", trajectoryPath,
      "--provider", providerType,
    ];
    if (citation) {
      cliArgs.push("--citation");
    }

    // ── 4. Spawn Python runner with live output panel ──
    try {
      // Use the dedicated SYSTEM_CALL_OUTPUT (LIVE) panel for progress,
      // keeping the AI text stream clean for the final answer only.
      const { appendActiveToolOutput, clearActiveToolOutput } =
        await import("./state.js");

      clearActiveToolOutput();

      const log = (line: string) => {
        appendActiveToolOutput(line + "\n");
      };

      // Show model/provider info at start
      log(`🤖 Model: ${model} (tier: ${tierName})`);
      log(`🔑 Provider: ${providerName} (${providerType})`);
      if (providerMismatch) {
        log(`⚠️  Provider from tier not found, using fallback provider`);
      }
      log("");

      const child = execa(PYTHON_BIN, cliArgs, {
        cwd,
        timeout: 180_000,
        reject: false,
        cancelSignal: signal,
        buffer: false,
      });

      // ── Accumulate stdout manually (buffer:false means result.stdout is always empty) ──
      let stdoutAll = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutAll += chunk.toString();
      });

      // ── Stream stderr JSONL events → live output panel ──
      let stderrBuf = "";
      let stderrAll = "";  // accumulate ALL stderr for error reporting (buffer:false empties result.stderr)

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderrAll += text;
        stderrBuf += text;
        const lines = stderrBuf.split("\n");
        stderrBuf = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const evt = JSON.parse(trimmed);

            switch (evt.event) {
              case "start":
                log(`⚡ Exploring: "${evt.query}"`);
                if (evt.backend) log(`  └─ backend: ${evt.backend}`);
                log("");
                break;
              case "turn":
                if (Number(evt.turn) > 1) log("");
                log(`── Turn ${evt.turn} ──`);
                break;
              case "thinking": {
                const snippet = (evt.text || "")
                  .replace(/\n/g, " ")
                  .slice(0, 160);
                if (snippet) log(`  💭 ${snippet}`);
                break;
              }
              case "tool_start": {
                const toolArgs = (evt.args || "")
                  .replace(/\n/g, " ")
                  .slice(0, 120);
                log(`  🔧 ${evt.tool}: ${toolArgs}`);
                break;
              }
              case "tool_end": {
                const preview = (evt.preview || "")
                  .replace(/\n/g, " ")
                  .slice(0, 120);
                const icon = evt.ok ? "✅" : "❌";
                log(`  ${icon} ${preview}`);
                break;
              }
              case "dedup": {
                const saved = evt.saved ?? 0;
                if (saved > 0) {
                  log(`  ♻️  deduped ${saved} redundant tool call${saved > 1 ? "s" : ""}`);
                }
                break;
              }
              case "retry": {
                log(`  ⏳ Retry ${evt.attempt}/${3} in ${evt.wait}s — ${(evt.reason || "").slice(0, 80)}`);
                break;
              }
              case "usage": {
                const total = evt.total_tokens ?? 0;
                const prompt = evt.prompt_tokens ?? 0;
                const completion = evt.completion_tokens ?? 0;
                if (total > 0) {
                  log(`  📊 tokens: ${total.toLocaleString()} (↑${prompt.toLocaleString()} ↓${completion.toLocaleString()})`);
                }
                break;
              }
              case "error":
                log(`  🚨 ${evt.text}`);
                break;
              case "done":
                log("");
                log(`✔ Done — ${evt.turns} turns`);
                break;
            }
          } catch {
            // Non-JSON stderr — pass through as-is
            log(`  ${trimmed}`);
          }

                break;
              }
              case "tool_start": {
                const toolArgs = (evt.args || "")
                  .replace(/\n/g, " ")
                  .slice(0, 120);
                log(`  🔧 ${evt.tool}: ${toolArgs}`);
                break;
              }
              case "tool_end": {
                const preview = (evt.preview || "")
                  .replace(/\n/g, " ")
                  .slice(0, 120);
                const icon = evt.ok ? "✅" : "❌";
                log(`  ${icon} ${preview}`);
                break;
              }
              case "error":
                log(`  🚨 ${evt.text}`);
                break;
              case "done":
                log("");
                log(`✔ Done — ${evt.turns} turns`);
                break;
            }
          } catch {
            // Non-JSON stderr — pass through as-is
            log(`  ${trimmed}`);
          }
        }
      });

      const result = await child;

      // Flush remaining stderr
      if (stderrBuf.trim()) {
        try {
          const evt = JSON.parse(stderrBuf.trim());
          if (evt.event === "error") log(`  🚨 ${evt.text}`);
        } catch {
          log(`  ${stderrBuf.trim()}`);
        }
      }

      // Clear the live panel so it doesn't linger after the tool finishes
      clearActiveToolOutput();

      // Cleanup trajectory file
      try {
        if (existsSync(trajectoryPath)) {
          unlinkSync(trajectoryPath);
        }
      } catch {}

      const output = stdoutAll.trim();
      const stderrRaw = stderrAll.trim() || (result.stderr || "").trim();

      if (result.exitCode !== 0) {
        const parts = [`FastContext exited with code ${result.exitCode}.`];
        if (output) parts.push(`stdout: ${output}`);
        if (stderrRaw) parts.push(`stderr: ${stderrRaw}`);
        if (!output && !stderrRaw) parts.push("No output was produced.");
        return parts.join("\n");
      }

      return output || "(FastContext returned no output)";
    } catch (err: any) {
      const msg = err?.message || String(err);

      // Ensure live panel is cleared on error too
      try {
        const { clearActiveToolOutput } = await import("./state.js");
        clearActiveToolOutput();
      } catch { /* ignore */ }

      // Cleanup trajectory file on error too
      try {
        if (existsSync(trajectoryPath)) {
          unlinkSync(trajectoryPath);
        }
      } catch {}

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
