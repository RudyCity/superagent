import fs from "fs";
import path from "path";
import { getGlobalConfigDir, ensureGlobalConfigDir } from "../config.js";

/**
 * Utility to log the final prompt system prompt and messages/prompt to prompts.log.
 */
export function logPrompt(
  label: string,
  modelName: string | undefined,
  system: string | undefined,
  messages: any[] | string | undefined,
  agentOrMeta?: any
): void {
  try {
    ensureGlobalConfigDir();
    const logDir = getGlobalConfigDir();
    const logPath = path.join(logDir, "prompts.log");

    const timestamp = new Date().toISOString();
    let meta: Record<string, any> = {};

    if (agentOrMeta) {
      if (typeof agentOrMeta === "object") {
        if (agentOrMeta.conversation && typeof agentOrMeta.tier === "string") {
          // It's an Agent instance
          const agent = agentOrMeta;
          meta = {
            tier: agent.tier,
            depth: agent.delegationDepth,
            multi: agent.isMultiAgent,
            worktree: agent.worktreePath || "-",
            subagentType: agent.subagentType || "-",
            sessionId: agent.conversation?.sessionId || "-"
          };
        } else {
          // It's a plain metadata object
          meta = { ...agentOrMeta };
        }
      }
    }

    const logEntry = {
      timestamp,
      label,
      model: modelName || "-",
      ...meta,
      system,
      messages
    };

    fs.appendFileSync(logPath, JSON.stringify(logEntry) + "\n", "utf-8");
  } catch (err) {
    // Ignore logging errors to prevent crashing the agent
  }
}
