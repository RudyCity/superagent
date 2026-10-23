import type { AssistantTaskDomain } from "../assistantRouting.js";

/**
 * Removes engineering-only workflow mandates for recognized non-programming tasks.
 * Never removes permission, risk, memory trust, or process-safety instructions.
 */
const ENGINEERING_ONLY = [
  "- KARPATHY_GUIDELINES:",
  "- POST_CHANGE_INTEGRITY:",
  "- ZERO_DEFECT:",
  "- WORKTREE:",
  "- PRE_MERGE:",
  "- POST_MERGE:",
  "- WORKTREE_PROTECTED:",
];

export function scopeSystemPromptForDomain(prompt: string, domain?: AssistantTaskDomain): string {
  if (!domain || !["writing", "creative", "productivity", "knowledge", "research", "conversation"].includes(domain)) {
    return prompt;
  }
  return prompt.split("\n").filter((line) =>
    !ENGINEERING_ONLY.some((prefix) => line.trimStart().startsWith(prefix))
  ).join("\n");
}
