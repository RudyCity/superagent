import { generateText } from "ai";
import fs from "fs";
import { rateLimiter } from "../rateLimiter.js";
import { getModelInstanceForTier } from "../config.js";
import type { Agent } from "../agent.js";

export function isRetryableError(err: unknown): boolean {
  if (!err) return false;
  
  let msg = "";
  let statusCode: number | undefined;

  if (err instanceof Error) {
    if (err.name === "AbortError" || err.message.toLowerCase().includes("aborted") || err.message.toLowerCase().includes("abort")) return false;
    msg = err.message;
    statusCode = (err as any).statusCode || (err as any).status;
  } else if (typeof err === "object") {
    const obj = err as any;
    statusCode = obj.statusCode || obj.status || (obj.error && (obj.error.statusCode || obj.error.status));
    if (obj.message && typeof obj.message === "string") {
      msg = obj.message;
    } else if (obj.error && typeof obj.error === "object" && obj.error.message && typeof obj.error.message === "string") {
      msg = obj.error.message;
    } else {
      try {
        msg = JSON.stringify(obj);
      } catch {
        msg = String(err);
      }
    }
  } else {
    msg = String(err);
  }

  msg = msg.toLowerCase();
  
  if (statusCode === 401 || statusCode === 403 || statusCode === 400 || statusCode === 402) {
    return false;
  }

  if (
    msg.includes("api key") ||
    msg.includes("apikey") ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden") ||
    msg.includes("authentication") ||
    msg.includes("authorization") ||
    msg.includes("credentials") ||
    msg.includes("missing authentication header") ||
    msg.includes("credit required") ||
    msg.includes("no_credit") ||
    msg.includes("payment required") ||
    msg.includes("status 400") ||
    msg.includes("status: 400") ||
    msg.includes("invalid_request_error") ||
    msg.includes("empty response from model") ||
    msg.includes("tried to call unavailable tool") ||
    msg.includes("tried to call tool that is not available")
  ) {
    return false;
  }
  
  return true;
}

export function parsePayloadLimitBytes(msg: string): number | null {
  const normalized = msg.toLowerCase();
  const regex = /(?:max|limit|exceeded|exceeds|snippet:)\s*(?:is|to|of|:|=)?\s*["']?\s*(\d+(?:\.\d+)?)\s*(kb|mb|b|bytes|o)/i;
  const match = normalized.match(regex);
  if (match) {
    const value = parseFloat(match[1]);
    const unit = match[2];
    if (unit.startsWith("kb")) {
      return value * 1024;
    }
    if (unit.startsWith("mb")) {
      return value * 1024 * 1024;
    }
    if (unit === "b" || unit.startsWith("byte")) {
      return value;
    }
  }

  const regexNum = /(?:max|limit|exceeded|exceeds|size|body)\s*[:=]?\s*["']?\s*(\d{5,12})\b/i;
  const matchNum = normalized.match(regexNum);
  if (matchNum) {
    return parseInt(matchNum[1], 10);
  }

  return null;
}

export async function answerQuestionAsMaster(
  agent: Agent,
  question: string,
  options: string[],
  context: { source: string; role?: string; task?: string; branch?: string; typeName?: string }
): Promise<string> {
  if (options.length === 0) return "";

  let planContext = "";
  try {
    const planPath = agent.getPlanFilePath();
    if (fs.existsSync(planPath)) {
      planContext = fs.readFileSync(planPath, "utf-8");
    }
  } catch {}

  let recentHistory = "";
  try {
    const msgs = agent.conversation.getMessages();
    const recent = msgs.slice(-12);
    recentHistory = recent
      .map((m: any) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
      .join("\n");
  } catch {}

  const sourceLabel = context.source === "superagent"
    ? `Superagent (role: ${context.role || "?"}, branch: ${context.branch || "?"}, task: "${context.task || "?"}")`
    : `Subagent (role: ${context.role || "?"}, type: ${context.typeName || "?"})`;

  const optionsList = options.map((o, i) => `${i + 1}. ${o}`).join("\n");

  const prompt = `You are the Master Agent orchestrating a multi-agent development session.
A ${sourceLabel} has hit a decision point and is asking a question during task execution.
You must answer on behalf of the user based on your knowledge of the project, the implementation plan, and the overall task context.

QUESTION FROM THE AGENT:
${question}

AVAILABLE OPTIONS:
${optionsList}
${planContext ? `\n--- CURRENT IMPLEMENTATION PLAN ---\n${planContext.slice(0, 4000)}\n` : ""}${recentHistory ? `\n--- RECENT MASTER CONVERSATION CONTEXT ---\n${recentHistory.slice(0, 3000)}\n` : ""}
Pick the BEST option that aligns with the project goals, the implementation plan, and good engineering judgment.
Reply with ONLY the exact text of the chosen option — no numbering, no explanation, no markdown.
If none of the options are suitable, still pick the closest one.`;

  try {
    await rateLimiter.acquire(1);

    const result = await generateText({
      model: agent.getModel(),
      prompt,
    });

    try {
      const { addMasterTokens } = await import("../tools/state.js");
      addMasterTokens(result.usage?.promptTokens || 0, result.usage?.completionTokens || 0);
    } catch {}

    const cleaned = result.text.trim().replace(/^["']|["']$/g, "");

    const exact = options.find((o) => o === cleaned);
    if (exact) return exact;

    const lower = cleaned.toLowerCase();
    const loose = options.find((o) => lower.includes(o.toLowerCase()));
    if (loose) return loose;

    const numMatch = cleaned.match(/^(\d+)/);
    if (numMatch) {
      const idx = parseInt(numMatch[1], 10) - 1;
      if (idx >= 0 && idx < options.length) return options[idx];
    }

    return options[0];
  } catch {
    return options[0];
  }
}
