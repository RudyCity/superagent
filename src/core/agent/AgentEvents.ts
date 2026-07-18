import type { ToolCall, ToolResult } from "../conversation.js";
import type { ViolationRecord } from "../tools.js";

export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_start"; toolCall: ToolCall; description: string }
  | { type: "tool_end"; toolResult: ToolResult; description: string; toolCall?: ToolCall }
  | { type: "error"; message: string }
  | { type: "done" }
  | { type: "goal_done"; goal: string; summary: string }
  | { type: "permission_required"; toolCall: ToolCall; description: string }
  | { type: "illegal_operation"; violation: ViolationRecord }
  | { type: "token_usage"; promptTokens: number; completionTokens: number; durationMs?: number }
  | { type: "checkpoint_auto"; name: string; id: string }
  | { type: "tool_progress"; toolCallId: string; message: string }
  | { type: "model_download"; modelName: "classifier" | "embedding"; status: "downloading" | "progress" | "loaded"; progress?: number };

export type PermissionHandler = (
  toolCall: ToolCall,
  description: string
) => Promise<boolean | "session">;

export interface QuestionItem {
  question: string;
  options: string[];
  isMultiSelect?: boolean;
}

export type QuestionHandler = (
  question: string | QuestionItem[],
  options?: string[],
  isMultiSelect?: boolean,
  initialCheckedIndices?: number[]
) => Promise<string | string[]>;

export function formatError(err: unknown): string {
  if (!err) return "Unknown error";
  
  let baseMessage = "";
  let extra = "";
  const obj = err as any;

  if (err instanceof Error) {
    baseMessage = err.message;
  } else if (typeof err === "object") {
    if (obj.message && typeof obj.message === "string") {
      baseMessage = obj.message;
    } else if (obj.error && typeof obj.error === "object" && obj.error.message && typeof obj.error.message === "string") {
      baseMessage = obj.error.message;
    }
  }

  if (baseMessage) {
    try {
      let status: number | undefined;
      let bodyText: string | undefined;
      let currentCause: any = obj.cause;
      
      let current = obj;
      while (current && typeof current === "object") {
        if (status === undefined) {
          const s = current.statusCode || current.status || (current.error && (current.error.statusCode || current.error.status));
          if (s) {
            status = Number(s);
          }
        }
        if (bodyText === undefined) {
          const b = current.text || current.responseBody || (current.error && (current.error.text || current.error.responseBody));
          if (typeof b === "string" && b.trim()) {
            bodyText = b;
          }
        }
        if (current.cause) {
          currentCause = current.cause;
          current = current.cause;
        } else if (current.error && typeof current.error === "object" && current.error !== current) {
          current = current.error;
        } else {
          break;
        }
      }

      if (status) {
        extra += ` (status: ${status})`;
      }
      
      if (bodyText && typeof bodyText === "string") {
        const trimmed = bodyText.trim();
        if (trimmed) {
          const snippet = trimmed.length > 150 ? trimmed.substring(0, 150) + "..." : trimmed;
          const cleanSnippet = snippet.replace(/\r?\n|\r/g, " ");
          extra += ` - response body snippet: "${cleanSnippet}"`;
        }
      }
      
      if (currentCause) {
        const causeMsg = currentCause instanceof Error ? currentCause.message : String(currentCause);
        if (causeMsg && causeMsg !== baseMessage) {
          extra += ` - cause: ${causeMsg}`;
        }
      }
    } catch {
      // Ignore extraction failures
    }
    return baseMessage + extra;
  }

  if (typeof err === "object") {
    try {
      const codePart = obj.code || obj.status || (obj.error && (obj.error.code || obj.error.status))
        ? ` (status/code: ${obj.code || obj.status || (obj.error && (obj.error.code || obj.error.status))})`
        : "";
      return JSON.stringify(err) + codePart;
    } catch {
      // Fallback if JSON.stringify fails
    }
  }

  return String(err);
}
