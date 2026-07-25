import type { ToolCall, ToolResult } from "./conversation.js";
import { logAdvisorEvent, logFailedPattern, getFailedPattern } from "./advisorLogger.js";

export interface AdvisorAction {
  action: "pass" | "warn_agent" | "pause_execution";
  message?: string;
  suggestion?: string;
  recommendedBackoffMs?: number;
  healthScore?: number;
  autoCorrectionHint?: string;
}

export interface AdvisorOptions {
  warningThreshold?: number;
  pauseThreshold?: number;
  errorThreshold?: number;
  enableLogging?: boolean;
  enableAdaptiveScaling?: boolean;
  enablePatternMemory?: boolean;
}

interface AgentState {
  consecutiveErrorsCount: number;
  consecutiveSameCallCount: number;
  lastCallKey: string;
}

const POLLING_STATUS_ACTIONS = new Set(["list", "report", "logs", "violations"]);
const BG_PROCESS_ACTIONS = new Set(["list", "status", "stream"]);

export class RealtimeAdvisor {
  private agentStates: Map<string, AgentState> = new Map();
  private baseWarningThreshold: number;
  private basePauseThreshold: number;
  private baseErrorThreshold: number;
  private enableLogging: boolean;
  private enableAdaptiveScaling: boolean;
  private enablePatternMemory: boolean;

  constructor(options?: AdvisorOptions) {
    this.baseWarningThreshold = options?.warningThreshold ?? 3;
    this.basePauseThreshold = options?.pauseThreshold ?? 5;
    this.baseErrorThreshold = options?.errorThreshold ?? 5;
    this.enableLogging = options?.enableLogging ?? true;
    this.enableAdaptiveScaling = options?.enableAdaptiveScaling ?? true;
    this.enablePatternMemory = options?.enablePatternMemory ?? true;
  }

  public updateOptions(options: AdvisorOptions): void {
    if (options.warningThreshold !== undefined) this.baseWarningThreshold = options.warningThreshold;
    if (options.pauseThreshold !== undefined) this.basePauseThreshold = options.pauseThreshold;
    if (options.errorThreshold !== undefined) this.baseErrorThreshold = options.errorThreshold;
    if (options.enableLogging !== undefined) this.enableLogging = options.enableLogging;
    if (options.enableAdaptiveScaling !== undefined) this.enableAdaptiveScaling = options.enableAdaptiveScaling;
    if (options.enablePatternMemory !== undefined) this.enablePatternMemory = options.enablePatternMemory;
  }

  private getEffectiveThresholds(toolCalls: ToolCall[]) {
    let warningThreshold = this.baseWarningThreshold;
    let pauseThreshold = this.basePauseThreshold;

    if (this.enableAdaptiveScaling && toolCalls.length > 0) {
      const toolNames = toolCalls.map(tc => tc.name);
      const isComplexTool = toolNames.some(name => 
        name.includes("replace_file") || name.includes("apply_patch") || name.includes("run_command")
      );
      if (isComplexTool) {
        warningThreshold += 1;
        pauseThreshold += 1;
      }
    }

    return { warningThreshold, pauseThreshold };
  }

  private getAgentState(agentId = "default"): AgentState {
    let state = this.agentStates.get(agentId);
    if (!state) {
      state = {
        consecutiveErrorsCount: 0,
        consecutiveSameCallCount: 0,
        lastCallKey: "",
      };
      this.agentStates.set(agentId, state);
    }
    return state;
  }

  /**
   * Calculates execution stability score (0-100%).
   */
  public getHealthScore(agentId = "default"): number {
    const state = this.getAgentState(agentId);
    let score = 100;
    score -= state.consecutiveErrorsCount * 15;
    if (state.consecutiveSameCallCount > 1) {
      score -= (state.consecutiveSameCallCount - 1) * 20;
    }
    return Math.max(0, score);
  }

  /**
   * Returns contextual auto-self-correction skill instructions.
   */
  public getAutoCorrectionSkillHint(action: AdvisorAction, toolNames: string[] = []): string {
    if (action.action === "pause_execution") {
      return "[SYSTEM AUTO-CORRECTION SKILL]: Loop limit reached. STOP repeating current calls. Switch to 'systematic-debugging' skill: 1) Re-read file range using 'read', 2) Check parameters & paths, 3) Modify strategy before executing tools.";
    }
    if (action.action === "warn_agent") {
      if (toolNames.some(t => t.includes("edit") || t.includes("replace"))) {
        return "[SYSTEM AUTO-CORRECTION SKILL]: Edit pattern warning. Re-read target lines using 'read' to verify exact string match and whitespace before re-applying edit.";
      }
      return "[SYSTEM AUTO-CORRECTION SKILL]: Execution warning triggered. Analyze prior tool output carefully and change parameters or tool selection.";
    }
    return "";
  }

  /**
   * Evaluates the latest step's tool calls and results.
   * Returns an AdvisorAction indicating what action the execution loop should take.
   */
  public evaluateStep(
    toolCalls: ToolCall[],
    toolResults: ToolResult[],
    agentId = "default"
  ): AdvisorAction {
    if (toolCalls.length === 0) {
      return { action: "pass", healthScore: this.getHealthScore(agentId) };
    }

    const state = this.getAgentState(agentId);
    const { warningThreshold, pauseThreshold } = this.getEffectiveThresholds(toolCalls);

    // Record failing patterns into Pattern Memory & detect transient errors
    let transientErrorDetected = false;
    let transientErrorMessage = "";
    for (let i = 0; i < toolResults.length; i++) {
      const result = toolResults[i];
      if (result.isError && result.result) {
        const resStr = result.result;
        const matchingCall = toolCalls.find(tc => tc.id === result.toolCallId) || toolCalls[i];
        if (matchingCall) {
          const sig = `${matchingCall.name}:${JSON.stringify(matchingCall.args)}`;
          logFailedPattern(sig, matchingCall.name, resStr.slice(0, 200));
        }

        if (
          resStr.includes("429") ||
          resStr.includes("rate limit") ||
          resStr.includes("ETIMEDOUT") ||
          resStr.includes("ECONNRESET") ||
          resStr.includes("503 Service Unavailable")
        ) {
          transientErrorDetected = true;
          transientErrorMessage = resStr.slice(0, 150);
        }
      }
    }

    // Check Pattern Memory for pre-execution early warnings
    if (this.enablePatternMemory && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        const sig = `${tc.name}:${JSON.stringify(tc.args)}`;
        const pattern = getFailedPattern(sig);
        if (pattern) {
          const suggestion = `Tool signature '${tc.name}' previously failed ${pattern.failCount} times with error: "${pattern.errorMessage}". Double-check arguments before proceeding.`;
          const message = `ADVISOR PATTERN WARNING: This specific tool call pattern (${tc.name}) has failed repeatedly in previous sessions. Suggestion: ${suggestion}`;
          const autoCorrectionHint = this.getAutoCorrectionSkillHint({ action: "warn_agent" }, [tc.name]);
          
          if (this.enableLogging) {
            logAdvisorEvent({
              agentId,
              action: "warn_agent",
              reason: "pattern_memory_warning",
              toolNames: [tc.name],
              message,
              suggestion,
            });
          }
          return {
            action: "warn_agent",
            message,
            suggestion,
            healthScore: this.getHealthScore(agentId),
            autoCorrectionHint,
          };
        }
      }
    }

    // 1. Check for hallucinated/inaccessible tools
    for (let i = 0; i < toolResults.length; i++) {
      const result = toolResults[i];
      if (result.isError) {
        const resStr = result.result || "";
        if (
          resStr.includes("not a registered tool") ||
          resStr.includes("Tool not found") ||
          resStr.includes("Access denied")
        ) {
          const suggestion = `Tool '${result.name}' is unavailable. Use 'get_skills' or check tool definitions to choose a registered alternative.`;
          const message = `ADVISOR WARNING: You attempted to call the tool "${result.name}" but it failed. Please verify that this tool is available in your active toolset before trying again. Suggestion: ${suggestion}`;
          const autoCorrectionHint = this.getAutoCorrectionSkillHint({ action: "warn_agent" }, [result.name]);

          if (this.enableLogging) {
            logAdvisorEvent({
              agentId,
              action: "warn_agent",
              reason: "hallucinated_tool",
              toolNames: [result.name],
              message,
              suggestion,
            });
          }
          return {
            action: "warn_agent",
            message,
            suggestion,
            healthScore: this.getHealthScore(agentId),
            autoCorrectionHint,
          };
        }
      }
    }

    // 2. Check for consecutively repeated identical tool calls
    let allArePolling = true;
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      if (!isPollingOrStatusCall(tc.name, tc.args)) {
        allArePolling = false;
        break;
      }
    }

    if (!allArePolling) {
      let currentCallKey: string;
      if (toolCalls.length === 1) {
        const tc = toolCalls[0];
        currentCallKey = `${tc.name}:${JSON.stringify(tc.args)}`;
      } else {
        const callKeys = new Array<string>(toolCalls.length);
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          callKeys[i] = `${tc.name}:${JSON.stringify(tc.args)}`;
        }
        callKeys.sort();
        currentCallKey = callKeys.join("|");
      }

      if (currentCallKey === state.lastCallKey) {
        state.consecutiveSameCallCount++;
      } else {
        state.consecutiveSameCallCount = 1;
        state.lastCallKey = currentCallKey;
      }

      // If repeating the exact same calls
      if (state.consecutiveSameCallCount >= warningThreshold) {
        const toolNamesList = toolCalls.map(tc => tc.name);
        const toolNames = toolNamesList.join(", ");

        if (state.consecutiveSameCallCount >= pauseThreshold) {
          const suggestion = `Execution paused. Modify file contents directly or try a different strategy instead of repeating ${toolNames}.`;
          const message = `Advisor detected an infinite loop of executing the same tool calls (${toolNames}) consecutively ${state.consecutiveSameCallCount} times. Pausing execution. Suggestion: ${suggestion}`;
          const autoCorrectionHint = this.getAutoCorrectionSkillHint({ action: "pause_execution" }, toolNamesList);

          if (this.enableLogging) {
            logAdvisorEvent({
              agentId,
              action: "pause_execution",
              reason: "loop_pause",
              toolNames: toolNamesList,
              consecutiveCount: state.consecutiveSameCallCount,
              message,
              suggestion,
            });
          }
          return {
            action: "pause_execution",
            message,
            suggestion,
            healthScore: this.getHealthScore(agentId),
            autoCorrectionHint,
          };
        }

        let hasError = false;
        for (let i = 0; i < toolResults.length; i++) {
          if (toolResults[i].isError) {
            hasError = true;
            break;
          }
        }

        const suggestion = generateRecoverySuggestion(toolNamesList, hasError);
        const message = hasError
          ? `ADVISOR WARNING: You have executed the exact same tool calls (${toolNames}) consecutively ${state.consecutiveSameCallCount} times, and they returned errors. Do not repeat the same failing actions. Change your approach or inspect your input parameters. Suggestion: ${suggestion}`
          : `ADVISOR WARNING: You have executed the exact same tool calls (${toolNames}) consecutively ${state.consecutiveSameCallCount} times without any state changes. Check if you are stuck in a loop and try a different action. Suggestion: ${suggestion}`;

        const autoCorrectionHint = this.getAutoCorrectionSkillHint({ action: "warn_agent" }, toolNamesList);

        if (this.enableLogging) {
          logAdvisorEvent({
            agentId,
            action: "warn_agent",
            reason: "loop_warning",
            toolNames: toolNamesList,
            consecutiveCount: state.consecutiveSameCallCount,
            message,
            suggestion,
          });
        }

        return {
          action: "warn_agent",
          message,
          suggestion,
          healthScore: this.getHealthScore(agentId),
          autoCorrectionHint,
        };
      }
    }

    // Track consecutive errors with Transient Error Backoff logic
    let stepErrorCount = 0;
    for (let i = 0; i < toolResults.length; i++) {
      if (toolResults[i].isError) {
        stepErrorCount++;
      }
    }

    if (stepErrorCount > 0) {
      if (transientErrorDetected) {
        const backoffMs = Math.min(1000 * Math.pow(2, state.consecutiveErrorsCount), 16000);
        const suggestion = `Transient API/Network error detected (${transientErrorMessage}). Applying exponential backoff delay of ${backoffMs}ms before retrying.`;
        const message = `ADVISOR TRANSIENT ERROR: ${suggestion}`;

        return {
          action: "warn_agent",
          message,
          suggestion,
          recommendedBackoffMs: backoffMs,
          healthScore: this.getHealthScore(agentId),
        };
      }

      state.consecutiveErrorsCount += stepErrorCount;
    } else {
      state.consecutiveErrorsCount = 0;
    }

    // 3. Check for general consecutive errors threshold
    if (state.consecutiveErrorsCount >= this.baseErrorThreshold) {
      const suggestion = `Multiple tool errors detected. Re-read recent tool outputs or error messages, verify parameters, or read target files before retrying.`;
      const message = `ADVISOR WARNING: You have encountered ${state.consecutiveErrorsCount} consecutive tool execution errors in recent steps. Please pause and carefully debug the root cause of these failures before calling more tools. Suggestion: ${suggestion}`;
      const autoCorrectionHint = this.getAutoCorrectionSkillHint({ action: "warn_agent" });

      if (this.enableLogging) {
        logAdvisorEvent({
          agentId,
          action: "warn_agent",
          reason: "consecutive_errors",
          consecutiveCount: state.consecutiveErrorsCount,
          message,
          suggestion,
        });
      }
      return {
        action: "warn_agent",
        message,
        suggestion,
        healthScore: this.getHealthScore(agentId),
        autoCorrectionHint,
      };
    }

    return { action: "pass", healthScore: this.getHealthScore(agentId) };
  }

  public reset(agentId?: string): void {
    if (agentId) {
      this.agentStates.delete(agentId);
    } else {
      this.agentStates.clear();
    }
  }
}

function generateRecoverySuggestion(toolNames: string[], hasError: boolean): string {
  if (toolNames.includes("edit") || toolNames.includes("replace_file_content")) {
    return hasError
      ? "Check exact string match or line range using 'read' before editing."
      : "The file might already contain the requested changes. Verify file content using 'read'.";
  }
  if (toolNames.includes("run_command") || toolNames.includes("bash")) {
    return "Check command syntax, dependencies, or environment variables.";
  }
  if (toolNames.includes("manage_subagents")) {
    return "Use 'schedule' or allow subagent background execution to proceed without continuous polling.";
  }
  return "Try an alternative tool or read relevant context before repeating the action.";
}

function isPollingOrStatusCall(name: string, args: any): boolean {
  const normalizedName = name.startsWith("default_api:") ? name.slice(12) : name;

  switch (normalizedName) {
    case "manage_subagents":
    case "manage_superagents": {
      const action = args?.action;
      return typeof action === "string" && POLLING_STATUS_ACTIONS.has(action);
    }
    case "manage_background_process": {
      const action = args?.action;
      return typeof action === "string" && BG_PROCESS_ACTIONS.has(action);
    }
    case "view_background_processes":
      return true;
    case "manage_tasks":
      return args?.action === "list";
    case "manage_task": {
      const action = args?.action;
      return action === "status" || action === "list";
    }
    default:
      return false;
  }
}
