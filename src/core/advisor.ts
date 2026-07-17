import type { ToolCall, ToolResult } from "./conversation.js";

export interface AdvisorAction {
  action: "pass" | "warn_agent" | "pause_execution";
  message?: string;
}

export class RealtimeAdvisor {
  private consecutiveErrorsCount = 0;
  private consecutiveSameCallCount = 0;
  private lastCallKey = "";

  /**
   * Evaluates the latest step's tool calls and results.
   * Returns an AdvisorAction indicating what action the execution loop should take.
   */
  public evaluateStep(
    toolCalls: ToolCall[],
    toolResults: ToolResult[]
  ): AdvisorAction {
    if (toolCalls.length === 0) {
      return { action: "pass" };
    }

    // 1. Check for hallucinated/inaccessible tools (e.g. not registered, permission denied)
    for (const result of toolResults) {
      const resStr = result.result || "";
      if (
        result.isError &&
        (resStr.includes("not a registered tool") ||
          resStr.includes("Tool not found") ||
          resStr.includes("Access denied"))
      ) {
        return {
          action: "warn_agent",
          message: `ADVISOR WARNING: You attempted to call the tool "${result.name}" but it failed. Please verify that this tool is available in your active toolset before trying again.`,
        };
      }
    }

    // 2. Check for consecutively repeated identical tool calls
    const callKeys = toolCalls.map(tc => `${tc.name}:${JSON.stringify(tc.args)}`).sort();
    const currentCallKey = callKeys.join("|");

    if (currentCallKey === this.lastCallKey) {
      this.consecutiveSameCallCount++;
    } else {
      this.consecutiveSameCallCount = 1;
      this.lastCallKey = currentCallKey;
    }

    // Track consecutive errors
    const hasError = toolResults.some(r => r.isError);
    if (hasError) {
      this.consecutiveErrorsCount += toolResults.filter(r => r.isError).length;
    } else {
      this.consecutiveErrorsCount = 0;
    }

    // If repeating the exact same calls
    if (this.consecutiveSameCallCount >= 3) {
      const toolNames = toolCalls.map(tc => tc.name).join(", ");
      if (this.consecutiveSameCallCount >= 5) {
        return {
          action: "pause_execution",
          message: `Advisor detected an infinite loop of executing the same tool calls (${toolNames}) consecutively ${this.consecutiveSameCallCount} times. Pausing execution.`,
        };
      }

      if (hasError) {
        return {
          action: "warn_agent",
          message: `ADVISOR WARNING: You have executed the exact same tool calls (${toolNames}) consecutively ${this.consecutiveSameCallCount} times, and they returned errors. Do not repeat the same failing actions. Change your approach or inspect your input parameters.`,
        };
      } else {
        return {
          action: "warn_agent",
          message: `ADVISOR WARNING: You have executed the exact same tool calls (${toolNames}) consecutively ${this.consecutiveSameCallCount} times without any state changes. Check if you are stuck in a loop and try a different action.`,
        };
      }
    }

    // 3. Check for general consecutive errors threshold
    if (this.consecutiveErrorsCount >= 5) {
      return {
        action: "warn_agent",
        message: `ADVISOR WARNING: You have encountered ${this.consecutiveErrorsCount} consecutive tool execution errors in recent steps. Please pause and carefully debug the root cause of these failures before calling more tools.`,
      };
    }

    return { action: "pass" };
  }

  public reset(): void {
    this.consecutiveErrorsCount = 0;
    this.consecutiveSameCallCount = 0;
    this.lastCallKey = "";
  }
}
