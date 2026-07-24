import fs from "fs";
import path from "path";
import os from "os";
import { generateText } from "ai";
import { getSettings } from "../config/jsonConfig.js";
import { rateLimiter, concurrencyLimiter } from "../rateLimiter.js";

const OPTIMIZED_PROMPTS_FILE = path.join(os.homedir(), ".superagent-r", "optimized_prompts.json");

export interface ToolCallTrace {
  name: string;
  args: any;
  result: string;
  isError: boolean;
}

export class PromptOptimizer {
  private model: any;

  constructor(model: any) {
    this.model = model;
  }

  /**
   * Load previously optimized guidelines for a subagent type or task.
   */
  public static loadOptimizedGuidelines(typeName: string): string {
    try {
      if (fs.existsSync(OPTIMIZED_PROMPTS_FILE)) {
        const data = JSON.parse(fs.readFileSync(OPTIMIZED_PROMPTS_FILE, "utf-8"));
        return data[typeName] || "";
      }
    } catch {
      // Ignore read errors
    }
    return "";
  }

  /**
   * Analyze trace logs and optimize prompts for subsequent runs if needed.
   */
  public async optimizePrompt(
    typeName: string,
    systemPrompt: string,
    goal: string,
    traces: ToolCallTrace[]
  ): Promise<string> {
    if (!this.model || traces.length === 0) return "";

    const hasFailure = traces.some(t => t.isError);
    const excessiveSteps = traces.length > 5;

    // Only optimize if there was a failure or excessive step usage
    if (!hasFailure && !excessiveSteps) {
      return "";
    }

    const formattedTraces = traces.map((t, idx) => {
      const argsStr = JSON.stringify(t.args);
      const resStr = t.result.slice(0, 1000) + (t.result.length > 1000 ? "..." : "");
      return `Step ${idx + 1}: Tool [${t.name}] called with args: ${argsStr}\nResult [${t.isError ? "Error" : "Success"}]: ${resStr}`;
    }).join("\n\n");

    const prompt = `You are an AI Metacognitive Prompt Optimizer.
Analyze the following agent execution trace that resulted in a ${hasFailure ? "failure" : "highly complex/expensive run"}.
Your goal is to write 2-4 concise, specific, and actionable rules (optimized guidelines) to be appended to this agent's system prompt for future runs, instructing it on how to avoid the mistakes or inefficiencies observed in this trace.

--- ORIGINAL SYSTEM PROMPT ---
${systemPrompt}

--- GOAL ---
${goal}

--- EXECUTION TRACE ---
${formattedTraces}

Provide only the optimized guidelines as a flat bulleted list in English. Do not include markdown headers (like # or ##) or bold text (like **). Output only the guidelines block.`;

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

      const { text } = await generateText({
        model: this.model,
        prompt,
      });

      const newGuidelines = text.trim();
      if (newGuidelines) {
        this.saveGuidelines(typeName, newGuidelines);
      }
      return newGuidelines;
    } catch {
      return "";
    } finally {
      if (concurrencyAcquired) {
        concurrencyLimiter.release();
      }
    }
  }

  private saveGuidelines(typeName: string, guidelines: string): void {
    try {
      const dir = path.dirname(OPTIMIZED_PROMPTS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      let data: Record<string, string> = {};
      if (fs.existsSync(OPTIMIZED_PROMPTS_FILE)) {
        data = JSON.parse(fs.readFileSync(OPTIMIZED_PROMPTS_FILE, "utf-8"));
      }

      data[typeName] = guidelines;
      fs.writeFileSync(OPTIMIZED_PROMPTS_FILE, JSON.stringify(data, null, 2), "utf-8");
    } catch {
      // Ignore write errors
    }
  }
}
