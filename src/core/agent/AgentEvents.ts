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
  inputType?: "select" | "text" | "password";
}

export type QuestionHandler = (
  question: string | QuestionItem[],
  options?: string[],
  isMultiSelect?: boolean,
  initialCheckedIndices?: number[],
  inputType?: "select" | "text" | "password"
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
          // Some OpenAI-compatible providers (e.g. proxies that wrap a backend)
          // re-wrap upstream errors as a stringified JSON inside `error.details`.
          // The outer wrapper message is almost always just
          // "Backend request failed with status 4xx", which hides the real
          // cause. Try to unwrap one level to surface the actual error message.
          //
          // Recognized shapes (in order of preference):
          //   1. { error: { details: "<stringified JSON with .error.message>" } }
          //   2. { error: { message: "real cause" } }
          //   3. { details: "<stringified JSON with .error.message>" }
          //   4. { error: "raw string" }
          let innerMessage: string | undefined;
          let hasDetailsBlob = false;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === "object") {
              const errObj = (parsed as any).error;
              const detailsField = (parsed as any).details;

              // (1) Preferred: error.details is a stringified JSON blob.
              if (
                errObj && typeof errObj === "object" &&
                typeof errObj.details === "string"
              ) {
                hasDetailsBlob = true;
                try {
                  const innerParsed = JSON.parse(errObj.details);
                  if (innerParsed && typeof innerParsed === "object") {
                    const innerErr = (innerParsed as any).error ?? innerParsed;
                    if (innerErr && typeof innerErr === "object" && typeof innerErr.message === "string") {
                      innerMessage = innerErr.message;
                    } else if (typeof innerErr === "string") {
                      innerMessage = innerErr;
                    }
                  }
                } catch {
                  // details wasn't JSON — fall through to direct message.
                }
              }

              // (2) Fallback: error.message looks like the real cause
              // (only when no details blob was present).
              if (
                !innerMessage &&
                errObj && typeof errObj === "object" &&
                typeof errObj.message === "string" &&
                !hasDetailsBlob
              ) {
                innerMessage = errObj.message;
              }

              // (3) Top-level details blob.
              if (!innerMessage && typeof detailsField === "string") {
                try {
                  const innerParsed = JSON.parse(detailsField);
                  if (innerParsed && typeof innerParsed === "object") {
                    const innerErr = (innerParsed as any).error ?? innerParsed;
                    if (innerErr && typeof innerErr === "object" && typeof innerErr.message === "string") {
                      innerMessage = innerErr.message;
                    } else if (typeof innerErr === "string") {
                      innerMessage = innerErr;
                    }
                  }
                } catch {
                  // ignore
                }
              }

              // (4) Top-level error is a plain string.
              if (!innerMessage && typeof errObj === "string") {
                innerMessage = errObj;
              }
            }
          } catch {
            // body wasn't JSON — leave innerMessage undefined.
          }

          const maxSnippet = 600;
          const snippet = trimmed.length > maxSnippet ? trimmed.substring(0, maxSnippet) + "..." : trimmed;
          const cleanSnippet = snippet.replace(/\r?\n|\r/g, " ");
          extra += ` - response body snippet: "${cleanSnippet}"`;

          // If we extracted a more informative upstream message than the
          // generic AI-SDK wrapper, surface it as a separate field.
          if (
            innerMessage &&
            baseMessage &&
            innerMessage !== baseMessage &&
            (!baseMessage.includes(innerMessage) || /backend request failed/i.test(baseMessage))
          ) {
            extra += ` [upstream: ${innerMessage}]`;
          }

          // Friendly hint when the upstream complains about a model id.
          if (
            status === 400 &&
            innerMessage &&
            /model/i.test(innerMessage) &&
            /(duplicate|ambig|not found|unknown|invalid|multiple|exist)/i.test(innerMessage)
          ) {
            extra += " [hint: check the active preset's model name — if the upstream lists it more than once in /v1/models, switch to a uniquely-identified model]";
          }

          // Friendly hint when provider returns 402 Payment Required
          if (status === 402) {
            extra += " [hint: Provider balance or credits depleted. Top up your account balance or switch provider/preset with /model]";
          }
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
