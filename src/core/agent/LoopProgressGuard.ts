import { createHash } from "node:crypto";
import type { ToolCall, ToolResult } from "../conversation.js";
import { buildCallKey, isPollingOrStatusCall } from "../advisorHelpers.js";

export type LoopProgressDecision =
  | { action: "continue"; repeated: number; backoffMs: number }
  | { action: "stop"; repeated: number; reason: "identical_tools" | "alternating_tools"; backoffMs: 0 };

const REPEATED_TOOL_LIMIT = 6;
const REPEATED_POLL_LIMIT = 10;
const ALTERNATING_CYCLE_LENGTH = 8;
const HISTORY_LIMIT = 10;

/**
 * Safety boundary independent of the optional advisor.
 * A repeated call alone is not stagnation; BOTH the call and its tool output
 * must remain unchanged before stopping. Changed status/output means progress.
 */
export class LoopProgressGuard {
  private readonly history: string[] = [];
  private previous = "";
  private repeated = 0;

  reset(): void {
    this.history.length = 0;
    this.previous = "";
    this.repeated = 0;
  }

  recordToolStep(calls: ToolCall[], results: ToolResult[]): LoopProgressDecision {
    if (calls.length === 0) {
      return { action: "continue", repeated: 0, backoffMs: 0 };
    }

    // Hash the entire tool result, not the first N chars: status changes often
    // occur beyond the common prefix of JSON tool outputs.
    const digest = createHash("sha256");
    digest.update(buildCallKey(calls));
    // buildCallKey truncates large arguments for the advisor's lightweight
    // fingerprint. Include full argument bytes so different edits with the
    // same prefix and length never collide in this hard stop guard.
    for (const call of calls) {
      digest.update("\u0000").update(call.name);
      digest.update(JSON.stringify(call.args ?? {}));
    }
    for (const result of results) {
      digest.update("\u0000").update(result.name);
      digest.update(result.isError ? "\u0001" : "\u0002");
      digest.update(typeof result.result === "string" ? result.result : String(result.result ?? ""));
    }
    const signature = digest.digest("hex");

    this.repeated = signature === this.previous ? this.repeated + 1 : 1;
    this.previous = signature;
    this.history.push(signature);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();

    const polling = results.every((result) => !result.isError) && calls.every((call) =>
      isPollingOrStatusCall(call.name, call.args) ||
      /(?:^|_)(?:status|poll|progress)$/.test(call.name)
    );
    if (this.repeated >= (polling ? REPEATED_POLL_LIMIT : REPEATED_TOOL_LIMIT)) {
      return { action: "stop", reason: "identical_tools", repeated: this.repeated, backoffMs: 0 };
    }

    if (this.history.length >= ALTERNATING_CYCLE_LENGTH) {
      const last = this.history.slice(-ALTERNATING_CYCLE_LENGTH);
      if (last[0] !== last[1] && last.every((entry, index) => entry === last[index % 2])) {
        return { action: "stop", reason: "alternating_tools", repeated: ALTERNATING_CYCLE_LENGTH, backoffMs: 0 };
      }
    }

    // Static status polling does not need a new LLM turn every few milliseconds.
    // The delay remains abort-aware in the caller. Changing status resets it.
    const backoffMs = polling && this.repeated >= 3
      ? Math.min(500 * 2 ** (this.repeated - 3), 4000)
      : 0;
    return { action: "continue", repeated: this.repeated, backoffMs };
  }
}
