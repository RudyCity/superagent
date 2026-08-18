import fs from "fs";
import path from "path";
import { generateText } from "ai";
import { getSettings } from "../config/jsonConfig.js";
import { rateLimiter, concurrencyLimiter } from "../rateLimiter.js";

export interface CriticReviewResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  critique?: string;
}

export class CriticAgent {
  private model: any;

  constructor(model: any) {
    this.model = model;
  }

  /**
   * Performs an automated critique of the modified files and test results.
   */
  public async reviewChanges(
    workspacePath: string,
    diffText: string,
    testOutput: string,
    buildOutput: string,
    planText?: string
  ): Promise<CriticReviewResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Basic sanity checks (conflict markers, syntax)
    if (diffText.includes("<<<<<<<") || diffText.includes("=======") || diffText.includes(">>>>>>>")) {
      errors.push("Leftover git conflict markers detected in code changes.");
    }

    // 2. Build output check
    const lowerBuild = buildOutput.toLowerCase();
    if (lowerBuild.includes("error ts") || lowerBuild.includes("compilation error") || lowerBuild.includes("failed to compile")) {
      errors.push(`Compilation failed: ${buildOutput.substring(0, 300)}`);
    }

    // 3. Test output check
    const lowerTest = testOutput.toLowerCase();
    if (lowerTest.includes("fail") || lowerTest.includes("failed") || lowerTest.includes("error")) {
      errors.push("Unit tests failed.");
    }

    // 4. LLM qualitative critique
    if (this.model) {
      const prompt = `# ROLE
Senior Code Reviewer & QA Agent.
Evaluate code changes against implementation plan and execution outputs.
Criteria: correctness, edge cases, security, invariant safety.

# CONTEXT
--- IMPLEMENTATION PLAN ---
${planText || "None provided"}

--- GIT DIFF ---
${diffText.substring(0, 10000)}

--- BUILD OUTPUT ---
${buildOutput}

--- TEST OUTPUT ---
${testOutput}

# OUTPUT SCHEMA (RAW JSON ONLY)
{
  "valid": true,
  "errors": [],
  "warnings": [],
  "critiqueText": "Detailed summary explaining the review decision"
}
Output ONLY raw JSON string. No markdown block formatting (\`\`\`), preamble, or explanations.`;

      let concurrencyAcquired = false;
      try {
        if (getSettings().concurrencyLimit === 1) {
          await concurrencyLimiter.acquire();
          concurrencyAcquired = true;
        }
        await rateLimiter.acquire(1);

        try {
          const { logPrompt } = await import("./PromptLogger.js");
          logPrompt("CriticAgent:reviewChanges", this.model?.modelId, undefined, prompt);
        } catch {}

        const { text } = await generateText({
          model: this.model,
          prompt,
        });

        // Strip potential markdown code blocks
        let cleanText = text.trim();
        if (cleanText.startsWith("```")) {
          cleanText = cleanText.replace(/^```[a-zA-Z0-9]*\r?\n/, "").replace(/\r?\n```$/, "");
        }

        const parsed = JSON.parse(cleanText.trim());
        if (parsed.errors && Array.isArray(parsed.errors)) {
          errors.push(...parsed.errors);
        }
        if (parsed.warnings && Array.isArray(parsed.warnings)) {
          warnings.push(...parsed.warnings);
        }
        return {
          valid: errors.length === 0 && parsed.valid !== false,
          errors,
          warnings,
          critique: parsed.critiqueText,
        };
      } catch (err: any) {
        warnings.push(`LLM critique skipped/failed: ${err.message}`);
      } finally {
        if (concurrencyAcquired) {
          concurrencyLimiter.release();
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}
