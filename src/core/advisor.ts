import type { ToolCall, ToolResult } from "./conversation.js";
import { logAdvisorEvent, logFailedPattern, getFailedPattern } from "./advisorLogger.js";
import {
  WRITE_TOOLS,
  READ_TOOLS,
  type HistoryEntry,
  type ReadTarget,
  buildCallKey,
  sortedJsonStringify,
  extractReadTargets,
  extractReadPaths,
  isPollingOrStatusCall,
  hasStateMutatingAction,
  computeResultSignature,
  generateCycleSuggestion,
  generateRecoverySuggestion,
  detectCycle,
} from "./advisorHelpers.js";

export type { HistoryEntry, ReadTarget };
export { extractReadTargets, extractReadPaths };

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
  lastResultSig: string;
  successStreak: number;
  patternWarningHits: number;
  cycleWarningHits: number;
  recentReads: Map<string, number>;
  callHistory: HistoryEntry[];
}

const MAX_TRACKED_AGENTS = 30;
const MAX_RECENT_READS_PER_AGENT = 100;
const MAX_CALL_HISTORY_STEPS = 12;

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

  /**
   * Syncs live advisor settings from model-config.json.
   * Call this at the start of each agent loop run so runtime config changes
   * (e.g. /setting-advisor warn=2) take effect without restarting.
   */
  public syncSettings(s: {
    advisorWarningThreshold?: number;
    advisorPauseThreshold?: number;
    advisorErrorThreshold?: number;
    advisorAdaptiveScaling?: boolean;
    advisorPatternMemory?: boolean;
  }): void {
    if (s.advisorWarningThreshold !== undefined) this.baseWarningThreshold = s.advisorWarningThreshold;
    if (s.advisorPauseThreshold   !== undefined) this.basePauseThreshold   = s.advisorPauseThreshold;
    if (s.advisorErrorThreshold   !== undefined) this.baseErrorThreshold   = s.advisorErrorThreshold;
    if (s.advisorAdaptiveScaling  !== undefined) this.enableAdaptiveScaling = s.advisorAdaptiveScaling;
    if (s.advisorPatternMemory    !== undefined) this.enablePatternMemory   = s.advisorPatternMemory;
  }

  private getEffectiveThresholds(toolCalls: ToolCall[]) {
    let warningThreshold = this.baseWarningThreshold;
    let pauseThreshold = this.basePauseThreshold;

    if (this.enableAdaptiveScaling && toolCalls.length > 0) {
      const toolNames = toolCalls.map(tc => tc.name);
      const isComplexTool = toolNames.some(name =>
        name.includes("replace_file") || name.includes("apply_patch") || name.includes("run_command") ||
        name.includes("chrome") || name.includes("browser")
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
      // Memory bound: prevent unbounded growth from ephemeral subagents
      if (this.agentStates.size >= MAX_TRACKED_AGENTS) {
        const oldestKey = this.agentStates.keys().next().value;
        if (oldestKey && oldestKey !== "default" && oldestKey !== "single" && oldestKey !== "master") {
          this.agentStates.delete(oldestKey);
        }
      }

      state = {
        consecutiveErrorsCount: 0,
        consecutiveSameCallCount: 0,
        lastCallKey: "",
        lastResultSig: "",
        successStreak: 0,
        patternWarningHits: 0,
        cycleWarningHits: 0,
        recentReads: new Map(),
        callHistory: [],
      };
      this.agentStates.set(agentId, state);
    }
    if (!state.recentReads) state.recentReads = new Map();
    if (!state.callHistory) state.callHistory = [];
    return state;
  }

  /**
   * Calculates execution stability score (0-100%).
   */
  public getHealthScore(agentId = "default"): number {
    const state = this.getAgentState(agentId);
    let score = 100;
    // Penalize consecutive errors (capped at 6 for max -90)
    score -= Math.min(state.consecutiveErrorsCount, 6) * 15;
    // Penalize loop repetition
    if (state.consecutiveSameCallCount > 1) {
      score -= (state.consecutiveSameCallCount - 1) * 20;
    }
    // Penalize alternating cycle warning hits
    if (state.cycleWarningHits > 0) {
      score -= Math.min(state.cycleWarningHits * 25, 50);
    }
    // Penalize repeat pattern memory warnings
    if (state.patternWarningHits > 0) {
      score -= Math.min(state.patternWarningHits, 3) * 5;
    }
    // Penalize repeated unmodified file reads
    if (state.recentReads) {
      for (const [, count] of state.recentReads) {
        if (count > 2) {
          score -= Math.min((count - 2) * 15, 45);
        }
      }
    }
    // Boost score for sustained successful execution
    if (state.successStreak >= 5) {
      score = Math.min(100, score + 10);
    }
    return Math.max(0, score);
  }

  /**
   * Returns contextual auto-self-correction skill instructions.
   */
  public getAutoCorrectionSkillHint(action: AdvisorAction, toolNames: string[] = []): string {
    if (action.action === "pause_execution") {
      if (toolNames.some(t => t.includes("chrome") || t.includes("browser"))) {
        return "[SYSTEM AUTO-CORRECTION SKILL]: Browser automation loop limit reached. Stop repeating the same page actions. Summarize test results, proceed to next verification target, or close audit.";
      }
      return "[SYSTEM AUTO-CORRECTION SKILL]: Loop limit reached. STOP repeating current calls. Switch to 'systematic-debugging' skill: 1) Re-read file range using 'read', 2) Check parameters & paths, 3) Modify strategy before executing tools.";
    }
    if (action.action === "warn_agent") {
      if (toolNames.some(t => t.includes("edit") || t.includes("replace"))) {
        return "[SYSTEM AUTO-CORRECTION SKILL]: Edit pattern warning. Re-read target lines using 'read' to verify exact string match and whitespace before re-applying edit.";
      }
      if (toolNames.some(t => t.includes("chrome") || t.includes("browser"))) {
        return "[SYSTEM AUTO-CORRECTION SKILL]: Browser action warning. Target element or page state is unchanged. Navigate to a different page or conclude verification.";
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
          const sig = `${matchingCall.name}:${sortedJsonStringify(matchingCall.args)}`;
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
        const sig = `${tc.name}:${sortedJsonStringify(tc.args)}`;
        const pattern = getFailedPattern(sig);
        if (pattern) {
          state.patternWarningHits++;
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
      const currentCallKey = buildCallKey(toolCalls);
      const currentResultSig = computeResultSignature(toolResults);

      if (currentCallKey === state.lastCallKey) {
        // If results changed between calls, output or environment state updated
        if (state.lastResultSig && currentResultSig !== state.lastResultSig) {
          state.consecutiveSameCallCount = 1;
        } else {
          state.consecutiveSameCallCount++;
        }
      } else {
        state.consecutiveSameCallCount = 1;
        state.lastCallKey = currentCallKey;
      }
      state.lastResultSig = currentResultSig;

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

      // Check for file modifications vs repeated read inspections
      const hasWriteTool = toolCalls.some(tc => WRITE_TOOLS.has(tc.name.toLowerCase()));
      if (hasWriteTool) {
        state.recentReads.clear();
      } else {
        const readCalls = toolCalls.filter(tc => READ_TOOLS.has(tc.name.toLowerCase()));
        if (readCalls.length > 0) {
          const readWarnThreshold = Math.max(3, warningThreshold);
          const readPauseThreshold = Math.max(5, pauseThreshold);
          for (const rc of readCalls) {
            const targets = extractReadTargets(rc);
            for (const target of targets) {
              const norm = target.filePath.trim().toLowerCase();
              const targetKey = `${norm}::${target.rangeKey}`;
              const readCount = (state.recentReads.get(targetKey) || 0) + 1;

              // Bound recentReads map size
              if (state.recentReads.size >= MAX_RECENT_READS_PER_AGENT) {
                const oldest = state.recentReads.keys().next().value;
                if (oldest) state.recentReads.delete(oldest);
              }
              state.recentReads.set(targetKey, readCount);

              if (readCount >= readPauseThreshold) {
                const baseName = target.filePath.split(/[\/\\]/).pop() || target.filePath;
                const rangeDesc = target.isChunk ? ` (${target.rangeLabel})` : "";
                const suggestion = `Repeatedly reading '${baseName}'${rangeDesc} without edits. Synthesize your findings and answer the user directly, or make required file edits.`;
                const message = `Advisor detected an unprogressed read loop: '${baseName}'${rangeDesc} was read ${readCount} times without any file modifications. Pausing execution. Suggestion: ${suggestion}`;
                const autoCorrectionHint = "[SYSTEM AUTO-CORRECTION SKILL]: File inspection loop limit reached. STOP reading the same files. Synthesize collected data or execute edits.";

                if (this.enableLogging) {
                  logAdvisorEvent({
                    agentId,
                    action: "pause_execution",
                    reason: "repeated_read_loop",
                    toolNames: [rc.name],
                    consecutiveCount: readCount,
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
              } else if (readCount >= readWarnThreshold) {
                const baseName = target.filePath.split(/[\/\\]/).pop() || target.filePath;
                const rangeDesc = target.isChunk ? ` (${target.rangeLabel})` : "";
                const suggestion = `Avoid re-reading '${baseName}'${rangeDesc}. Synthesize your answer with existing context or proceed with concrete actions.`;
                const message = `ADVISOR WARNING: You have read '${baseName}'${rangeDesc} ${readCount} times without making any edits. Do not repeat identical file inspections. Suggestion: ${suggestion}`;
                const autoCorrectionHint = "[SYSTEM AUTO-CORRECTION SKILL]: Repeated read warning. Synthesize your findings and reply to the user, or take concrete action instead of reading again.";

                if (this.enableLogging) {
                  logAdvisorEvent({
                    agentId,
                    action: "warn_agent",
                    reason: "repeated_read_warning",
                    toolNames: [rc.name],
                    consecutiveCount: readCount,
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
        }
      }

      // Sliding window pattern detection for alternating non-consecutive loops
      const isMutating = hasStateMutatingAction(toolCalls, toolResults);
      const resultSig = computeResultSignature(toolResults);
      const currentEntry: HistoryEntry = {
        callKey: currentCallKey,
        toolNames: toolCalls.map(tc => tc.name),
        resultSig,
        isMutating,
      };
      state.callHistory.push(currentEntry);
      if (state.callHistory.length > MAX_CALL_HISTORY_STEPS) {
        state.callHistory.shift();
      }

      const cycle = detectCycle(state.callHistory, warningThreshold, pauseThreshold);
      if (cycle && state.consecutiveSameCallCount < cycle.occurrences) {
        state.cycleWarningHits++;
        const toolNamesList = cycle.toolNames;
        const toolNames = toolNamesList.join(", ");
        const suggestion = generateCycleSuggestion(toolNamesList);

        if (cycle.isPause) {
          const message = `Advisor detected an alternating loop repeating the same tool actions (${toolNames}) ${cycle.occurrences} times. Pausing execution. Suggestion: ${suggestion}`;
          const autoCorrectionHint = this.getAutoCorrectionSkillHint({ action: "pause_execution" }, toolNamesList);

          if (this.enableLogging) {
            logAdvisorEvent({
              agentId,
              action: "pause_execution",
              reason: "alternating_loop_pause",
              toolNames: toolNamesList,
              consecutiveCount: cycle.occurrences,
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
        } else {
          const message = `ADVISOR WARNING: You are cycling between repeated tool actions (${toolNames}) across recent steps. Suggestion: ${suggestion}`;
          const autoCorrectionHint = this.getAutoCorrectionSkillHint({ action: "warn_agent" }, toolNamesList);

          if (this.enableLogging) {
            logAdvisorEvent({
              agentId,
              action: "warn_agent",
              reason: "alternating_loop_warning",
              toolNames: toolNamesList,
              consecutiveCount: cycle.occurrences,
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
      } else {
        state.cycleWarningHits = 0;
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
      state.consecutiveErrorsCount += stepErrorCount;
      state.successStreak = 0;

      if (transientErrorDetected) {
        const backoffMs = Math.min(1000 * Math.pow(2, state.consecutiveErrorsCount), 16000);
        const suggestion = `Transient API/Network error detected (${transientErrorMessage}). Applying exponential backoff delay of ${backoffMs}ms before retrying.`;
        const message = `ADVISOR TRANSIENT ERROR: ${suggestion}`;

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
          recommendedBackoffMs: backoffMs,
          healthScore: this.getHealthScore(agentId),
          autoCorrectionHint: "[SYSTEM AUTO-CORRECTION SKILL]: Transient error encountered. Allow backoff timer to complete before retrying.",
        };
      }
    } else {
      state.consecutiveErrorsCount = 0;
      state.successStreak++;
    }

    // Consecutive error thresholds
    if (state.consecutiveErrorsCount >= this.baseErrorThreshold * 2) {
      const suggestion = `Stop attempting failing tool calls. Review error messages, inspect target environment, or switch approach.`;
      const message = `Advisor paused execution: encountered ${state.consecutiveErrorsCount} consecutive tool execution errors without progress. Pausing execution to prevent infinite failure loops. Suggestion: ${suggestion}`;
      const autoCorrectionHint = this.getAutoCorrectionSkillHint({ action: "pause_execution" });

      if (this.enableLogging) {
        logAdvisorEvent({
          agentId,
          action: "pause_execution",
          reason: "consecutive_errors_pause",
          consecutiveCount: state.consecutiveErrorsCount,
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
    } else if (state.consecutiveErrorsCount >= this.baseErrorThreshold) {
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
