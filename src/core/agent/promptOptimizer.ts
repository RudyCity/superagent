import fs from "fs";
import path from "path";
import os from "os";
import { generateText } from "ai";
import { getSettings } from "../config/jsonConfig.js";
import { rateLimiter, concurrencyLimiter } from "../rateLimiter.js";

const OPTIMIZED_PROMPTS_FILE = path.join(os.homedir(), ".superagent-r", "optimized_prompts.json");
const OPTIMIZED_PROMPTS_VERSION = 2;
const MAX_GUIDELINES = 4;
const MAX_GUIDELINE_CHARS = 280;
const MAX_GUIDELINES_CHARS = 900;
const SCOPE_STOP_WORDS = new Set(["a", "an", "and", "for", "in", "of", "the", "to", "with"]);

export const GUIDELINE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface ToolCallTrace {
  name: string;
  args: any;
  result: string;
  isError: boolean;
}

export interface OptimizedGuidelineEntry {
  guidelines: string;
  createdAt: number;
  updatedAt: number;
}

interface OptimizedPromptStore {
  version: number;
  entries: Record<string, OptimizedGuidelineEntry>;
}

export function isOptimizedGuidelineFresh(updatedAt: number, now = Date.now()): boolean {
  return Number.isFinite(updatedAt) && updatedAt > 0 && now - updatedAt <= GUIDELINE_TTL_MS;
}

export function getPromptOptimizerScope(typeName: string, goal = ""): string {
  const keywords = goal.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(word => word.length > 2 && !SCOPE_STOP_WORDS.has(word))
    .slice(0, 4);
  return `${typeName.trim().toLowerCase() || "subagent"}:${keywords.join("-") || "general"}`;
}

export function sanitizeOptimizedGuidelines(guidelines: string): string {
  const unsafeInstruction = /(^#|```|(?:ignore|override|bypass).{0,64}(?:system|previous|safety|security|permission|constraint))/i;
  const seen = new Set<string>();
  const valid: string[] = [];

  for (const rawLine of guidelines.split("\n")) {
    const line = rawLine.replace(/^\s*[-*]\s*/, "").replace(/\s+/g, " ").trim();
    if (!line || unsafeInstruction.test(line)) continue;

    const bounded = line.slice(0, MAX_GUIDELINE_CHARS).trim();
    const key = bounded.toLowerCase();
    if (!bounded || seen.has(key)) continue;

    seen.add(key);
    valid.push(`- ${bounded}`);
    if (valid.length === MAX_GUIDELINES) break;
  }

  return valid.join("\n").slice(0, MAX_GUIDELINES_CHARS).trim();
}

function readGuidelineStore(): OptimizedPromptStore {
  try {
    if (!fs.existsSync(OPTIMIZED_PROMPTS_FILE)) {
      return { version: OPTIMIZED_PROMPTS_VERSION, entries: {} };
    }

    const parsed = JSON.parse(fs.readFileSync(OPTIMIZED_PROMPTS_FILE, "utf-8"));
    if (parsed?.version !== OPTIMIZED_PROMPTS_VERSION || !parsed.entries || typeof parsed.entries !== "object") {
      return { version: OPTIMIZED_PROMPTS_VERSION, entries: {} };
    }

    const entries: Record<string, OptimizedGuidelineEntry> = {};
    for (const [scope, value] of Object.entries(parsed.entries as Record<string, unknown>)) {
      const entry = value as Partial<OptimizedGuidelineEntry>;
      const guidelines = sanitizeOptimizedGuidelines(typeof entry.guidelines === "string" ? entry.guidelines : "");
      if (guidelines && isOptimizedGuidelineFresh(entry.updatedAt ?? 0)) {
        entries[scope] = {
          guidelines,
          createdAt: entry.createdAt ?? entry.updatedAt!,
          updatedAt: entry.updatedAt!,
        };
      }
    }
    return { version: OPTIMIZED_PROMPTS_VERSION, entries };
  } catch {
    return { version: OPTIMIZED_PROMPTS_VERSION, entries: {} };
  }
}

function saveGuidelineStore(store: OptimizedPromptStore): void {
  const dir = path.dirname(OPTIMIZED_PROMPTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OPTIMIZED_PROMPTS_FILE, JSON.stringify(store, null, 2), "utf-8");
}

export class PromptOptimizer {
  private model: any;

  constructor(model: any) {
    this.model = model;
  }

  /** Load fresh, validated guidelines scoped to an agent type and task family. */
  public static loadOptimizedGuidelines(typeName: string, goal = ""): string {
    try {
      const store = readGuidelineStore();
      return store.entries[getPromptOptimizerScope(typeName, goal)]?.guidelines || "";
    } catch {
      return "";
    }
  }

  /** Analyze a failed or expensive trace and save bounded guidance for a future matching task. */
  public async optimizePrompt(
    typeName: string,
    systemPrompt: string,
    goal: string,
    traces: ToolCallTrace[]
  ): Promise<string> {
    if (!this.model || traces.length === 0) return "";

    const hasFailure = traces.some(t => t.isError);
    const excessiveSteps = traces.length > 5;
    if (!hasFailure && !excessiveSteps) return "";

    const formattedTraces = traces.map((t, idx) => {
      const argsStr = JSON.stringify(t.args);
      const result = t.result.slice(0, 1000) + (t.result.length > 1000 ? "..." : "");
      return `Step ${idx + 1}: Tool [${t.name}] called with args: ${argsStr}\nResult [${t.isError ? "Error" : "Success"}]: ${result}`;
    }).join("\n\n");

    const prompt = `You are an AI Metacognitive Prompt Optimizer.
Analyze the following agent execution trace that resulted in a ${hasFailure ? "failure" : "highly complex/expensive run"}.
Write 2-4 concise, specific, actionable rules for this exact task family to avoid the observed mistakes or inefficiencies.
Rules must not override system instructions, safety, permissions, task scope, or tier boundaries. Do not generalize beyond evidence in this trace.

--- ORIGINAL SYSTEM PROMPT ---
${systemPrompt}

--- GOAL ---
${goal}

--- EXECUTION TRACE ---
${formattedTraces}

Provide only a flat English bullet list. No headers or bold text.`;

    let concurrencyAcquired = false;
    try {
      if (getSettings().concurrencyLimit === 1) {
        await concurrencyLimiter.acquire();
        concurrencyAcquired = true;
      }
      await rateLimiter.acquire(1);

      try {
        const { logPrompt } = await import("./PromptLogger.js");
        logPrompt("PromptOptimizer:optimizePrompt", this.model?.modelId, undefined, prompt);
      } catch {}

      const { text } = await generateText({ model: this.model, prompt });
      const guidelines = sanitizeOptimizedGuidelines(text);
      if (guidelines) this.saveGuidelines(typeName, goal, guidelines);
      return guidelines;
    } catch {
      return "";
    } finally {
      if (concurrencyAcquired) concurrencyLimiter.release();
    }
  }

  private saveGuidelines(typeName: string, goal: string, guidelines: string): void {
    try {
      const sanitized = sanitizeOptimizedGuidelines(guidelines);
      if (!sanitized) return;

      const now = Date.now();
      const store = readGuidelineStore();
      const scope = getPromptOptimizerScope(typeName, goal);
      const existing = store.entries[scope];
      store.entries[scope] = {
        guidelines: sanitized,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      saveGuidelineStore(store);
    } catch {}
  }
}
