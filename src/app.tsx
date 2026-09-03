import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Box, Text, useApp } from "ink";
import ChatTextInput, { ChatTextInputRef } from "./components/ChatTextInput.js";
import { Agent } from "./core/agent.js";
import type { AgentEvent, PermissionHandler, QuestionHandler, QuestionItem } from "./core/agent.js";
import type { ToolCall } from "./core/conversation.js";
import { getContextWindowLimit, getInstalledSkills, getConfiguredProviders, switchActiveProvider, fetchAndCacheModels, getRootConfigDir, getEffectiveMasterModel, getSettings, getModelPresets, getActivePreset, getTrustedDirectories } from "./core/config.js";
import { type MessageContent, contentToString } from "./core/conversation.js";
import ImageAttachmentBar from "./components/ImageAttachmentBar.js";
import {
  readImageFromPath,
  readImageFromClipboard,
  attachmentToImagePart,
  formatFileSize,
  type ImageAttachment,
} from "./utils/imageUtils.js";
import fs from "fs/promises";
import fsSync from "fs";
import { handleSlashCommand, getDefaultModel } from "./core/slash-commands.js";
import { registry } from "./core/commands/index.js";
import { createCheckpoint, terminateActiveTasksAndSubagents } from "./core/checkpoints.js";
import { getToolDescription } from "./core/permissions.js";
import path from "path";
import { backgroundTasks, subagentInstances, superagentInstances, subscribeToTasks, subscribeToSubagents, subscribeToSuperagents, subscribeToSchedules, subscribeToActiveOutput, registerQuestionHandler, registerMasterAgent, notifyTasksChanged, setActiveDevHookGlobal, isTaskInWorkspace, clearActiveToolOutput, appendActiveToolOutput } from "./core/tools.js";
import { ProcessingIndicator } from "./components/common/LoadingIndicators.js";
import { ActiveAgentsList } from "./components/active-agents-list.js";
import { TaskChecklist } from "./components/task-checklist.js";
import { HistoryPanel } from "./components/history-panel.js";
import { execa } from "execa";
import { resolveCarriageReturns, formatArgs, formatCompactNumber, filterSuggestions, getInsertion, getPasteSplit, stripSgrMouseSequences, updatePasteState, getActiveCommandContext } from "./utils/text.js";
import { createIncrementalStreamCleaner } from "./utils/streamText.js";
import { reconstructChatLines } from "./utils/uiHelpers.js";
import { tryStatSync } from "./core/tools/helpers.js";
import { getTruncatedAssistantIndexes } from "./utils/responseScroll.js";
import { wrapTextForDisplay } from "./utils/responseScroll.js";
import type { ChatLine } from "./core/slash-commands.js";
import { readChecklistTasks, readTaskHistory } from "./core/taskChecklist.js";
import { getActiveChainId, getWorkspaceChain } from "./core/workspace/WorkspaceChainConfig.js";
import { lockEventEmitter, getLockStats } from "./core/storage/sharedMemory.js";

// Hook & Component Baru
import { StatusBar } from "./components/status-bar.js";
import { WizardPanels } from "./components/wizard-panels.js";
import { PLAN_APPROVAL_OPTIONS, planApprovalChromeHeight } from "./components/plan-approval-dialog.js";
import { MessageSubmitDialog, type MessageSubmitChoice } from "./components/message-submit-dialog.js";
import { ChatArea, computeWrappedLines } from "./components/chat-area.js";
import { WizardHeaderRowsContext } from "./components/wizard-dialog.js";
import { useWizardSubmit } from "./hooks/useWizardSubmit.js";
import { useKeyboardHandler } from "./hooks/useKeyboardHandler.js";
import { useMouseScroll, type SectionBoundary, type ChatLinePosition } from "./hooks/useMouseScroll.js";
import { useRmemoryStatus } from "./hooks/useRmemoryStatus.js";

export { stripSgrMouseSequences } from "./utils/text.js";

/** Cheap size signal for memoizing token recounts: measures only the last message content. */
function lastContentLength(m?: { content?: unknown }): number {
  if (!m) return 0;
  const c = m.content as any;
  if (typeof c === "string") return c.length;
  if (Array.isArray(c)) {
    const lastPart = c[c.length - 1];
    if (!lastPart) return 0;
    if (lastPart.type === "text") return typeof lastPart.text === "string" ? lastPart.text.length : 0;
    if (lastPart.type === "image") return typeof lastPart.image === "string" ? lastPart.image.length : 0;
    return 0;
  }
  return 0;
}

/**
 * FNV-1a (32-bit) string hash. Fast, no dependencies, deterministic.
 * Used for content-aware memoization key so mid-history edits (e.g. tool
 * result updates) trigger token recount, not just last-message changes.
 */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Content-aware recount key.
 *
 * Previous version only checked `messages.length` + `lastContentLength(last)`.
 * That misses mid-history mutations: a tool result update, an in-place edit
 * to an earlier assistant message, or a re-issued system prompt would all
 * leave the Ctx:% bar stale until the *next* user turn.
 *
 * Now we hash a compact fingerprint of every message's content length + role
 * + first/last character sample. FNV-1a over this fingerprint stays cheap
 * (O(total chars)) but is collision-resistant enough for memo invalidation.
 */
function getContextRecountKey(messages: { role?: string; content?: unknown; toolCalls?: unknown[]; toolResults?: unknown[] }[]): string {
  if (messages.length === 0) return "0:";
  let totalLen = 0;
  const samples: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const len = lastContentLength(m);
    totalLen += len;
    const role = m.role || "?";
    // Sample first 8 chars and last 8 chars of content to detect in-place edits
    const c = m.content as any;
    let textSample = "";
    if (typeof c === "string") {
      textSample = c.length > 16 ? c.slice(0, 8) + c.slice(-8) : c;
    } else if (Array.isArray(c) && c.length > 0) {
      const first = c[0];
      if (first?.type === "text") textSample = first.text?.slice(0, 16) || "";
    }
    // Include tool call/result counts to detect tool-related changes
    const tcCount = Array.isArray(m.toolCalls) ? m.toolCalls.length : 0;
    const trCount = Array.isArray(m.toolResults) ? m.toolResults.length : 0;
    samples.push(`${role}:${len}:${tcCount}:${trCount}:${textSample}`);
  }
  return `${messages.length}:${totalLen}:${fnv1a(samples.join("|"))}`;
}

function getWizardBorderColor(activeWizard: any): "yellow" | "cyan" | "blue" | "gray" | "red" {
  if (!activeWizard) return "cyan";
  switch (activeWizard.type) {
    case "permission":
    case "plan_approve":
    case "goal":
      return "yellow";
    case "question":
    case "skills":
      return "cyan";
    case "resume":
      return "blue";
    case "checkpoint":
      return activeWizard.step === 2 ? "yellow" : "gray";
    case "login":
      return activeWizard.step === 13 ? "blue" : "cyan";
    case "model":
      return activeWizard.step === 41 ? "red" : "cyan";
    default:
      return "cyan";
  }
}

function cleanXmlForDisplay(text: string): string {
  let cleaned = text;

  // 1. Remove closed tool calls
  cleaned = cleaned.replace(/<function_calls\s*>[\s\S]*?<\/function_calls>/gi, "");
  cleaned = cleaned.replace(/<invoke\s+name="[^"]+"[^>]*>[\s\S]*?<\/invoke>/gi, "");

  const knownTools = [
    "ask_question", "run_command", "view_file", "write_to_file",
    "replace_file_content", "multi_replace_file_content", "search_web",
    "read_url_content", "invoke_subagent", "manage_subagents", "list_dir",
    "schedule", "manage_task", "ask_permission", "list_permissions"
  ];
  for (const tool of knownTools) {
    const escaped = tool.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
    const regex = new RegExp(`<${escaped}\\s*>([\\s\\S]*?)<\\/${escaped}>`, "gi");
    cleaned = cleaned.replace(regex, "");
  }

  // 2. If there's an unclosed tool call at the end, strip it
  const unclosedRegex = /<(function_calls|invoke|ask_question|run_command|view_file|write_to_file|replace_file_content|multi_replace_file_content|search_web|read_url_content|invoke_subagent|manage_subagents|list_dir|schedule|manage_task|ask_permission|list_permissions)\b[^>]*>[\s\S]*$/i;
  cleaned = cleaned.replace(unclosedRegex, "");

  // Also strip any partial opening tag at the very end of the string (e.g. "<ask_" or "<invo")
  cleaned = cleaned.replace(/<[a-zA-Z0-9_]*$/i, "");

  return cleaned;
}

/**
 * Shared incremental cleaners for the streaming display buffers.
 *
 * cleanXmlForDisplay runs ~25 regexes over its input; calling it on the
 * growing buffer every 40ms is O(n²) over a long response. The wrappers
 * freeze already-settled plain-prose content and only re-clean the volatile
 * tail. Final messages still go through a full clean via cleanFinal.
 */
const textStreamCleaner = createIncrementalStreamCleaner(cleanXmlForDisplay);
const reasoningStreamCleaner = createIncrementalStreamCleaner(cleanXmlForDisplay);

export function App({
  autoResume = false,
  onHistoryChange,
  onSessionPath,
  initialPrompt,
}: {
  autoResume?: boolean | string;
  onHistoryChange?: (exists: boolean) => void;
  onSessionPath?: (filePath: string) => void;
  initialPrompt?: string;
}) {
  const { exit } = useApp();
  const [lines, _setLines] = useState<ChatLine[]>([]);
  const linesRef = useRef<ChatLine[]>([]);
  const setLines = useCallback((val: ChatLine[] | ((prev: ChatLine[]) => ChatLine[])) => {
    _setLines((prev) => {
      const next = typeof val === "function" ? val(prev) : val;
      const finalVal = next.length > 1000 ? next.slice(-1000) : next;
      linesRef.current = finalVal;
      return finalVal;
    });
  }, []);
  const [input, setInput] = useState("");
  const [isPasted, setIsPasted] = useState(false);
  const [pastePrefixLength, setPastePrefixLength] = useState(0);
  const [pasteSuffixLength, setPasteSuffixLength] = useState(0);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [pendingSubmitMessage, setPendingSubmitMessage] = useState<{
    text: string;
    attachments: ImageAttachment[];
  } | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isExecutingTool, setIsExecutingTool] = useState(false);
  const [streamDisplay, setStreamDisplay] = useState("");
  const [activeToolName, setActiveToolName] = useState("");
  const [activeToolDesc, setActiveToolDesc] = useState("");
  
  const [pendingPermission, setPendingPermission] = useState<{
    toolCall: ToolCall;
    description: string;
    resolve: (value: boolean | "session") => void;
  } | null>(null);

  const [pendingQuestion, setPendingQuestion] = useState<{
    question: string;
    options: string[];
    resolve: (value: any) => void;
    inputType?: "select" | "text" | "password";
  } | null>(null);

  const [lastTabPrefix, setLastTabPrefix] = useState<string | null>(null);
  const [tokensUp, setTokensUp] = useState(0);
  const [tokensDown, setTokensDown] = useState(0);
  const [lastPromptTokens, setLastPromptTokens] = useState(0);
  const [lastSpeed, setLastSpeed] = useState<number | null>(null);
  const [contextLimit, setContextLimit] = useState(() => {
    try {
      const modelName = getEffectiveMasterModel("single") || getDefaultModel();
      return getContextWindowLimit(modelName);
    } catch {
      return 256000;
    }
  });
  const [activeLocks, setActiveLocks] = useState(0);
  const [sessionId, setSessionId] = useState<string>("");
  
  const streamBufferRef = useRef("");
  const lastStreamUpdateRef = useRef<number>(0);
  const streamTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const deferredStreamTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  const [reasoningDisplay, setReasoningDisplay] = useState("");
  const reasoningBufferRef = useRef("");
  const lastReasoningUpdateRef = useRef<number>(0);
  const deferredReasoningTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [tempInput, setTempInput] = useState("");
  const agentRef = useRef<Agent | null>(null);

  // Persist input history to SQLite database
  useEffect(() => {
    try {
      import("./core/config/paths.js").then(({ getWorkspaceId }) => {
        const wsId = getWorkspaceId();
        import("./core/storage/historyDb.js").then(({ getInputHistoryFromDb }) => {
          const dbHistory = getInputHistoryFromDb(wsId);
          if (dbHistory.length > 0) {
            setHistory(dbHistory);
          }
        }).catch(() => {});
      }).catch(() => {});
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  
  const [scrollOffset, setScrollOffset] = useState(0);
  const [focusedResponseIndex, setFocusedResponseIndex] = useState<number | null>(null);
  const [focusedResponseOffset, setFocusedResponseOffset] = useState(0);
  
  const wrappedLinesLengthRef = useRef(0);
  const lastWrappedLinesLengthRef = useRef(0);
  const chatHeightLimitRef = useRef(15);
  
  const [runningTasksCount, setRunningTasksCount] = useState(0);
  const [runningSubagentsCount, setRunningSubagentsCount] = useState(0);
  const [runningSuperagentsCount, setRunningSuperagentsCount] = useState(0);
  
  const [goalMode, setGoalMode] = useState<{ goal: string; startedAt: number } | null>(null);
  const rmemoryStatus = useRmemoryStatus();
  const [toolTimeout, setToolTimeout] = useState<number | null>(null);
  const [toolStartTime, setToolStartTime] = useState<number | null>(null);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);

  const [activeWizard, setActiveWizard] = useState<{
    type: "login" | "model" | "plan_approve" | "permission" | "question" | "resume" | "goal" | "checkpoint" | "skills" | "exit_confirm" | "workspace";
    step: number;
    data: Record<string, string>;
    isMultiSelect?: boolean;
    questions?: QuestionItem[];
    currentQuestionIndex?: number;
    answers?: string[];
  } | null>(null);

  const [workspacePath, setWorkspacePath] = useState<string>(process.cwd());

  const [wizardSelectedSet, setWizardSelectedSet] = useState<Set<number>>(new Set());
  const [checkpointsList, setCheckpointsList] = useState<any[]>([]);
  const [wizardSelectedIndex, setWizardSelectedIndex] = useState(0);
  const [wizardOptions, setWizardOptions] = useState<string[]>([]);
  const [wizardIsLoadingModels, setWizardIsLoadingModels] = useState(false);
  const [planState, setPlanState] = useState<"IDLE" | "PLANNING_PENDING" | "APPROVED">("IDLE");
  const [activeModel, setActiveModel] = useState(() => getEffectiveMasterModel("single") || getDefaultModel());
  const [activePresetName, setActivePresetName] = useState(() => {
    try { return getActivePreset<any>("single")?.name || ""; } catch { return ""; }
  });

  // Sync contextLimit with the active model's context window limit.
  // This ensures the Ctx: percentage display uses the correct denominator
  // on startup and whenever the model changes (e.g. via /model wizard).
  useEffect(() => {
    try {
      const limit = getContextWindowLimit(activeModel);
      setContextLimit(limit);
      // Also update the ContextManager if it exists
      const cm = agentRef.current?.getContextManager?.();
      if (cm) {
        cm.setThreshold(limit);
        cm.setModel(activeModel);
      }
    } catch {
      // Fall back to default if model lookup fails
      setContextLimit(256000);
    }
  }, [activeModel]);
  const [checklistTasks, setChecklistTasks] = useState<{ status: string; text: string }[]>([]);
  const [completedHistory, setCompletedHistory] = useState<{ status: string; text: string; remainingSeconds?: number }[]>([]);
  const [rawCompletedHistory, setRawCompletedHistory] = useState<{ status: string; text: string }[]>([]);
  const historyTimestampsRef = useRef<Map<string, number>>(new Map());
  const [classifierStatus, setClassifierStatus] = useState<"offline" | "loading" | "online">(() => {
    try {
      return getSettings().classifierEnabled !== false ? "online" : "offline";
    } catch {
      return "online";
    }
  });
  const [embeddingStatus, setEmbeddingStatus] = useState<"offline" | "loading" | "online">(() => {
    try {
      return getSettings().enableRmemory ? "online" : "offline";
    } catch {
      return "offline";
    }
  });
  const [focusMode, setFocusMode] = useState<"input" | "history" | "checklist" | "superagents" | "subagents" | "procs" | "chat">("input");

  const chatTextInputRef = useRef<ChatTextInputRef>(null);

  // Automatically focus the input area when any wizard is active
  useEffect(() => {
    if (activeWizard) {
      setFocusMode("input");
    }
  }, [activeWizard]);

  // Refresh active preset name whenever model changes OR wizard closes (e.g. after /model or /login).
  // Dual dependency covers: (1) model changed → activeModel differs, (2) same model but different
  // preset → activeModel is unchanged but activeWizard just turned null.
  useEffect(() => {
    try {
      setActivePresetName(getActivePreset<any>("single")?.name || "");
    } catch {
      setActivePresetName("");
    }
  }, [activeModel, activeWizard]);

  const [historySelectedIndex, setHistorySelectedIndex] = useState<number>(0);

  const [checklistScrollOffset, setChecklistScrollOffset] = useState(0);
  const [superagentsScrollOffset, setSuperagentsScrollOffset] = useState(0);
  const [subagentsScrollOffset, setSubagentsScrollOffset] = useState(0);
  const [procsScrollOffset, setProcsScrollOffset] = useState(0);
  const [procsSelectedIndex, setProcsSelectedIndex] = useState(0);

  // Collapsible sections state
  const [collapsedSections, setCollapsedSections] = useState({
    superagents: false,
    subagents: false,
    procs: false,
    checklist: false,
  });

  // Visible line positions for mouse click detection
  const [visibleLinePositions, setVisibleLinePositions] = useState<
    Array<{ index: number; startRow: number; endRow: number; isTruncated: boolean; type: string; isCollapsible?: boolean; parentIndex?: number; childIndex?: number }>
  >([]);

  // Computed wizard header rows for precise option click detection
  const [wizardHeaderRows, setWizardHeaderRows] = useState(3);

  // Collapsible chat lines state (tool_start, tool_end, system, error)
  const [expandedLines, setExpandedLines] = useState<Set<number>>(new Set());
  // Expanded children: Map<parentLineIndex, Set<childIndex>>
  const [expandedChildren, setExpandedChildren] = useState<Map<number, Set<number>>>(new Map());
  const expandCursorRef = useRef<number>(-1);


  // Smart collapse: auto-collapse completed tool calls, keep active ones expanded
  // Now handles nested children (tool events are children of assistant lines)
  useEffect(() => {
    setExpandedChildren(prev => {
      const next = new Map(prev);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.type === "assistant" && line.children && line.children.length > 0) {
          const childSet = new Set(next.get(i) || []);
          for (let c = 0; c < line.children.length; c++) {
            const child = line.children[c];
            if (child.type === "tool_start") {
              if (child.mergedResult) {
                // manage_tasks (update) — keep expanded by default so checklist progress is always visible
                if (child.content && child.content.includes("Managing tasks (update)")) {
                  childSet.add(c);
                } else {
                  // Tool completed — auto-collapse to merged single row
                  childSet.delete(c);
                }
              } else if (isExecutingTool) {
                // Tool still running — keep expanded so user sees live progress
                childSet.add(c);
              }
            }
          }
          next.set(i, childSet);
        }
      }
      return next;
    });
  }, [lines, isExecutingTool]);


  const toggleLineExpand = useCallback((index: number) => {
    setExpandedLines(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const toggleChildExpand = useCallback((parentIndex: number, childIndex: number) => {
    setExpandedChildren(prev => {
      const next = new Map(prev);
      const childSet = new Set(next.get(parentIndex) || []);
      if (childSet.has(childIndex)) {
        childSet.delete(childIndex);
      } else {
        childSet.add(childIndex);
      }
      next.set(parentIndex, childSet);
      return next;
    });
  }, []);

  // Expanded thinking blocks state: Set<lineIndex> (including -1 for live stream)
  const [expandedThinking, setExpandedThinking] = useState<Set<number>>(new Set());

  const toggleThinkingExpand = useCallback((index: number) => {
    setExpandedThinking(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const settings = getSettings();
  const maxChecklistVisible = settings.maxChecklistVisible ?? 3;
  const maxHistoryVisible = settings.maxHistoryVisible ?? 3;
  const maxSuperagentsVisible = 2;
  const maxSubagentsVisible = 3;
  const maxProcsVisible = settings.maxProcsVisible ?? 3;

  const [terminalHeight, setTerminalHeight] = useState(process.stdout.rows || 30);
  const [terminalWidth, setTerminalWidth] = useState(process.stdout.columns || 80);
  const [gitBranch, setGitBranch] = useState<string>("");
  const [worktreeCount, setWorktreeCount] = useState<number>(0);
  const [activeDevHook, setActiveDevHook] = useState<string | null>(null);
  const originalWorkingDirectoryRef = useRef<string>(process.cwd());

  const addLine = useCallback((line: ChatLine) => {
    setLines((prev) => {
      const nextIdx = prev.length;
      setExpandedLines((expanded) => {
        const next = new Set(expanded);
        next.add(nextIdx);
        return next;
      });
      return [...prev, line];
    });
  }, []);

  /** Append a tool-related line (tool_start/tool_end) as a child of the last assistant message */
  const addToolChild = useCallback((child: ChatLine) => {
    setLines((prev) => {
      if (prev.length === 0) {
        const newAssistant: ChatLine = {
          type: "assistant",
          content: "",
          timestamp: Date.now(),
          children: [child],
        };
        return [...prev, newAssistant];
      }
      const lastLine = prev[prev.length - 1];
      if (lastLine.type === "assistant") {
        const updated = [...prev];
        const parent = { ...updated[prev.length - 1] };
        parent.children = [...(parent.children || []), child];
        updated[prev.length - 1] = parent;
        return updated;
      } else {
        const newAssistant: ChatLine = {
          type: "assistant",
          content: "",
          timestamp: Date.now(),
          children: [child],
        };
        return [...prev, newAssistant];
      }
    });
  }, []);

  /**
   * Patch the most recent tool_start child with a mergedResult (from tool_end).
   * This avoids adding a separate tool_end child, keeping the display as a single merged row.
   */
  const patchLastToolStart = useCallback((result: { isError: boolean; content: string; description: string }) => {
    setLines((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].type === "assistant") {
          const children = prev[i].children;
          if (children && children.length > 0) {
            // Find the last tool_start child
            for (let c = children.length - 1; c >= 0; c--) {
              if (children[c].type === "tool_start") {
                const updated = [...prev];
                const parent = { ...updated[i] };
                const updatedChildren = [...children];
                updatedChildren[c] = { ...updatedChildren[c], mergedResult: result };
                parent.children = updatedChildren;
                updated[i] = parent;
                return updated;
              }
            }
          }
          break;
        }
      }
      return prev;
    });
  }, []);



  const scrollChat = useCallback((direction: "up" | "down", amount = 1) => {
    setScrollOffset((prev) => {
      if (direction === "down") {
        return Math.max(0, prev - amount);
      }
      const maxScroll = Math.max(0, wrappedLinesLengthRef.current - chatHeightLimitRef.current);
      return Math.min(prev + amount, maxScroll);
    });
  }, []);

  // Toggle collapsible section
  const toggleCollapse = useCallback((section: string) => {
    // The "checklist" section is always expanded — collapse/hide is
    // intentionally disabled so users always see plan progress. Treat
    // any toggle on it as a no-op.
    if (section === "checklist") return;
    setCollapsedSections((prev) => ({
      ...prev,
      [section]: !prev[section as keyof typeof prev],
    }));
  }, []);

  // Open a specific truncated response by index (for mouse click)
  const openResponseAtIndex = useCallback((index: number) => {
    if (index >= 0 && index < lines.length && lines[index]?.type === "assistant") {
      setFocusedResponseIndex(index);
      setFocusedResponseOffset(0);
      setScrollOffset(0);
    }
  }, [lines]);

  // Mouse context ref - updated on each render with latest values
  const mouseCtxRef = useRef<any>(null);

  // Enable mouse scroll + click for the single-agent app
  useMouseScroll(mouseCtxRef);

  const flushBuffer = useCallback(() => {
    if (streamTimeoutRef.current) {
      clearTimeout(streamTimeoutRef.current);
      streamTimeoutRef.current = null;
    }
    if (deferredStreamTimeoutRef.current) {
      clearTimeout(deferredStreamTimeoutRef.current);
      deferredStreamTimeoutRef.current = null;
    }
    if (deferredReasoningTimeoutRef.current) {
      clearTimeout(deferredReasoningTimeoutRef.current);
      deferredReasoningTimeoutRef.current = null;
    }
    const rawContent = streamBufferRef.current.trim();
    const reasoning = reasoningBufferRef.current.trim();
    if (rawContent || reasoning) {
      const content = textStreamCleaner.cleanFinal(rawContent).trim();
      addLine({
        type: "assistant",
        content,
        reasoning: reasoning || undefined,
        timestamp: Date.now(),
      });
    }
    streamBufferRef.current = "";
    reasoningBufferRef.current = "";
    textStreamCleaner.reset();
    reasoningStreamCleaner.reset();
    setStreamDisplay("");
    setReasoningDisplay("");
  }, [addLine]);

  const stopRunningSubagents = useCallback(() => {
    const runningSubagents = Array.from(subagentInstances.values()).filter((s) => s.status === "running");
    if (runningSubagents.length === 0) {
      return 0;
    }

    for (const inst of runningSubagents) {
      inst.agent.abort();
      subagentInstances.delete(inst.id);
    }

    addLine({
      type: "system",
      content: `Interrupted ${runningSubagents.length} running subagent${runningSubagents.length === 1 ? "" : "s"}.`,
      timestamp: Date.now(),
    });
    return runningSubagents.length;
  }, [addLine]);

  const openLatestTruncatedResponse = useCallback(() => {
    const width = Math.max(20, terminalWidth - 6);
    const maxLines = Math.max(8, Math.min(18, Math.floor(terminalHeight * 0.45)));
    const truncatedIndexes = getTruncatedAssistantIndexes(lines, maxLines, width);
    const latestIndex = truncatedIndexes[truncatedIndexes.length - 1];
    if (latestIndex !== undefined) {
      setFocusedResponseIndex(latestIndex);
      setFocusedResponseOffset(0);
      setScrollOffset(0);
      return true;
    }
    addLine({ type: "system", content: "No long response to open.", timestamp: Date.now() });
    return false;
  }, [addLine, lines, terminalHeight, terminalWidth]);

  const handlePermissionResponse = useCallback(
    (approved: boolean | "session") => {
      if (pendingPermission) {
        pendingPermission.resolve(approved);
        let content = "✗ Permission denied";
        if (approved === "session") {
          content = "✓ Permission granted (this session)";
        } else if (approved === true) {
          content = "✓ Permission granted";
        }
        addLine({
          type: "system",
          content,
          timestamp: Date.now(),
        });
        setPendingPermission(null);
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      }
    },
    [pendingPermission, addLine]
  );

  // Bind useWizardSubmit Hook
  const handleWizardSubmit = useWizardSubmit({
    activeWizard,
    setActiveWizard,
    wizardOptions,
    setWizardOptions,
    wizardSelectedIndex,
    setWizardSelectedIndex,
    setWizardSelectedSet,
    setCheckpointsList,
    addLine,
    setInput,
    isProcessing,
    setIsProcessing,
    setContextLimit,
    setActiveModel,
    setPlanState,
    setGoalMode,
    agentRef,
    pendingPermission,
    setPendingPermission,
    pendingQuestion,
    setPendingQuestion,
    wizardIsLoadingModels,
    setWizardIsLoadingModels,
    planState,
    streamBufferRef,
    setStreamDisplay,
    exit,
    clearLines: () => setLines([]),
    setWorkingDirectory: (newPath: string) => {
      setWorkspacePath(newPath);
      originalWorkingDirectoryRef.current = newPath;
      if (agentRef.current) {
        agentRef.current.workingDirectory = newPath;
      }
      if (!newPath.startsWith("ssh:") && !newPath.startsWith("ssh://")) {
        process.chdir(newPath);
      }
    },
  });

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();

      if (isProcessing && !activeWizard) {
        if (!trimmed && attachments.length === 0) return;

        // While the AI is still processing, show a dialog (Queue / Insert / Back)
        // so the user can decide what to do with the new message instead of
        // silently aborting the current run.
        setHistory((prev) => {
          if (prev.length > 0 && prev[prev.length - 1] === trimmed) {
            return prev;
          }
          if (trimmed) {
            try {
              import("./core/config/paths.js").then(({ getWorkspaceId }) => {
                const wsId = getWorkspaceId();
                import("./core/storage/historyDb.js").then(({ saveInputHistoryToDb }) => {
                  saveInputHistoryToDb(wsId, trimmed);
                }).catch(() => {});
              }).catch(() => {});
            } catch {}
          }
          return [...prev, trimmed].slice(-200);
        });

        const submittedAttachments = attachments;
        setInput("");
        setIsPasted(false);
        setPastePrefixLength(0);
        setPasteSuffixLength(0);
        setLastTabPrefix(null);
        setHistoryIndex(-1);
        setScrollOffset(0);
        setAttachments([]);

        setPendingSubmitMessage({
          text: trimmed,
          attachments: submittedAttachments,
        });
        return;
      }

      if (activeWizard) {
        setInput("");
        setIsPasted(false);
        setPastePrefixLength(0);
        setPasteSuffixLength(0);
        setLastTabPrefix(null);
        setHistoryIndex(-1);
        setScrollOffset(0);

        const isSelectionStep = 
          (activeWizard.type === "exit_confirm") ||
          (activeWizard.type === "login" && (activeWizard.step === 1 || activeWizard.step === 2 || activeWizard.step === 6 || activeWizard.step === 7 || activeWizard.step === 8 || activeWizard.step === 10 || activeWizard.step === 15 || activeWizard.step === 17)) ||
          (activeWizard.type === "model" && (activeWizard.step === 1 || activeWizard.step === 2 || activeWizard.step === 3 || activeWizard.step === 4 || activeWizard.step === 15 || activeWizard.step === 22 || activeWizard.step === 23 || activeWizard.step === 24 || activeWizard.step === 25 || activeWizard.step === 30 || activeWizard.step === 32 || activeWizard.step === 33 || activeWizard.step === 34 || activeWizard.step === 35 || activeWizard.step === 40 || activeWizard.step === 41 || activeWizard.step === 50)) ||
          (activeWizard.type === "permission") ||
          (activeWizard.type === "question" && wizardOptions.length > 0) ||
          (activeWizard.type === "workspace" && wizardOptions.length > 0);

        if (isSelectionStep) {
          return;
        }

        if (activeWizard.type === "plan_approve") {
          if (activeWizard.step === 2) {
            // Step 2: custom feedback input — send the typed text
            if (trimmed) handleWizardSubmit(trimmed);
          } else if (wizardOptions.length > 0) {
            // Step 1: option selection
            if (wizardSelectedIndex === 0) {
              handleWizardSubmit("approve");
            } else if (wizardSelectedIndex === 1) {
              handleWizardSubmit("reject");
            } else {
              // Index 2: Custom Feedback — transition to step 2
              setWizardOptions([]);
              setActiveWizard({ ...activeWizard, step: 2 });
            }
          }
        } else if (activeWizard.type === "login" && activeWizard.step === 14) {
            // Step 14: search-select provider to delete
            const currentInput = (typeof value === "string") ? value.trim() : "";
            const filteredProviders = currentInput ? filterSuggestions(wizardOptions, currentInput) : wizardOptions;
            const clampedIdx = Math.min(wizardSelectedIndex, Math.max(0, filteredProviders.length - 1));
            const chosenProvider = filteredProviders[clampedIdx];
            if (chosenProvider && chosenProvider !== "(no results)") {
              // Find the 1-based index in the original wizardOptions
              const origIdx = wizardOptions.indexOf(chosenProvider) + 1;
              handleWizardSubmit(String(origIdx));
            }
        } else {
          handleWizardSubmit(trimmed);
        }
        return;
      }

      if (!trimmed && attachments.length === 0) return;

      setHistory((prev) => {
        if (prev.length > 0 && prev[prev.length - 1] === trimmed) {
          return prev;
        }
        if (trimmed) {
          try {
            import("./core/config/paths.js").then(({ getWorkspaceId }) => {
              const wsId = getWorkspaceId();
              import("./core/storage/historyDb.js").then(({ saveInputHistoryToDb }) => {
                saveInputHistoryToDb(wsId, trimmed);
              }).catch(() => {});
            }).catch(() => {});
          } catch {}
        }
        return [...prev, trimmed].slice(-200);
      });

      setInput("");
      setIsPasted(false);
      setPastePrefixLength(0);
      setPasteSuffixLength(0);
      setLastTabPrefix(null);
      setHistoryIndex(-1);
      setScrollOffset(0);

      const runInteractiveProcess = async (
        command: string, 
        cwd: string, 
        env?: Record<string, string | undefined>,
        onData?: (chunk: string) => void
      ) => {
        const wasRaw = process.stdin.isRaw;
        if (wasRaw) {
          process.stdin.setRawMode(false);
        }
        process.stdin.pause();

        clearActiveToolOutput();
        setIsExecutingTool(true);
        setIsProcessing(true);
        setActiveToolName("command");
        setActiveToolDesc(command);
        let exitCode = 0;
        let output = "";
        try {
          const { execa } = await import("execa");
          let shellExe: string | boolean = true;
          if (process.platform === "win32") shellExe = "powershell.exe";
          
          const childProcess = execa(command, {
            cwd,
            env: { ...process.env, ...env },
            shell: shellExe,
            reject: false,
            all: true,
          });

          if (childProcess.all) {
            childProcess.all.on("data", (chunk: Buffer) => {
              const str = chunk.toString("utf-8");
              appendActiveToolOutput(str);
              output += str;
              if (onData) {
                onData(str);
              }
            });
          }

          const res = await childProcess;
          clearActiveToolOutput();
          exitCode = res.exitCode ?? 0;
          if (!output) {
            output = res.all || res.stdout || res.stderr || "";
          }
        } catch (err: any) {
          clearActiveToolOutput();
          exitCode = err.status ?? err.exitCode ?? 1;
          if (!output) {
            output = err.all || err.stdout || err.stderr || err.message || "";
          }
        } finally {
          clearActiveToolOutput();
          setIsExecutingTool(false);
          setIsProcessing(false);
          setActiveToolName("");
          setActiveToolDesc("");
        }

        process.stdin.resume();
        if (wasRaw) {
          process.stdin.setRawMode(true);
        }
        return { exitCode, output };
      };

      if (trimmed.startsWith("/")) {
        await handleSlashCommand(trimmed, {
          addLine,
          exit,
          agent: agentRef.current,
          setActiveWizard: (w: any) => {
            setActiveWizard(w);
          },
          setWizardOptions,
          setWizardSelectedIndex,
          setCheckpointsList,
          setIsProcessing,
          setLines,
          setHistory,
          setPlanState,
          setContextLimit,
          setActiveModel,
          setInputHistory: setHistory,
          clearLines: () => {
            setLines([]);
          },
          runInteractiveProcess,
          attachImage: handleAttachImage,
          pasteImage: handlePasteImage,
          setActiveDevHook: (name: string | null) => {
            setActiveDevHook(name);
            setActiveDevHookGlobal(name);
            if (agentRef.current) {
              if (name) {
                agentRef.current.workingDirectory = path.join(originalWorkingDirectoryRef.current, "internal-hooks", name);
              } else {
                agentRef.current.workingDirectory = originalWorkingDirectoryRef.current;
              }
            }
          },
          setWorkingDirectory: (newPath: string) => {
            setWorkspacePath(newPath);
            originalWorkingDirectoryRef.current = newPath;
            if (agentRef.current) {
              agentRef.current.workingDirectory = newPath;
            }
            process.chdir(newPath);
          },
        } as any);
        return;
      }

      if (trimmed.startsWith("!")) {
        const cmdVal = trimmed.slice(1).trim();
        await handleSlashCommand(`/terminal ${cmdVal}`, {
          addLine,
          exit,
          agent: agentRef.current,
          setActiveWizard: (w: any) => {
            setActiveWizard(w);
          },
          setWizardOptions,
          setWizardSelectedIndex,
          setCheckpointsList,
          setIsProcessing,
          setLines,
          setHistory,
          setPlanState,
          setContextLimit,
          setActiveModel,
          setInputHistory: setHistory,
          clearLines: () => {
            setLines([]);
          },
          runInteractiveProcess,
          attachImage: handleAttachImage,
          pasteImage: handlePasteImage,
          setActiveDevHook: (name: string | null) => {
            setActiveDevHook(name);
            setActiveDevHookGlobal(name);
            if (agentRef.current) {
              if (name) {
                agentRef.current.workingDirectory = path.join(originalWorkingDirectoryRef.current, "internal-hooks", name);
              } else {
                agentRef.current.workingDirectory = originalWorkingDirectoryRef.current;
              }
            }
          },
          setWorkingDirectory: (newPath: string) => {
            setWorkspacePath(newPath);
            originalWorkingDirectoryRef.current = newPath;
            if (agentRef.current) {
              agentRef.current.workingDirectory = newPath;
            }
            process.chdir(newPath);
          },
        } as any);
        return;
      }

      // Build display label (text only, images shown via attachment bar)
      const displayText = trimmed || (attachments.length > 0 ? `[${attachments.length} image${attachments.length > 1 ? "s" : ""}]` : "");
      addLine({
        type: "user",
        content: attachments.length > 0
          ? `❯ ${displayText} 📎×${attachments.length}`
          : `❯ ${trimmed}`,
        timestamp: Date.now(),
      });

      if (agentRef.current) {
        const sessionPath = agentRef.current.getCurrentHistoryFilePath();
        const msgs = agentRef.current.getHistory().getMessages();
        if (msgs.length > 0) {
          const preview = trimmed.slice(0, 40) + (trimmed.length > 40 ? "…" : "");
          createCheckpoint(sessionPath, `Auto: ${preview}`, msgs, agentRef.current.planState, agentRef.current.workingDirectory).catch(() => {});
        }
      }

      setIsProcessing(true);
      streamBufferRef.current = "";
      reasoningBufferRef.current = "";
      textStreamCleaner.reset();
      reasoningStreamCleaner.reset();
      setStreamDisplay("");
      setReasoningDisplay("");

      // Build MessageContent — plain string or multimodal array
      let messageContent: MessageContent = trimmed;
      if (attachments.length > 0) {
        const textParts: Array<{ type: "text"; text: string }> = trimmed
          ? [{ type: "text" as const, text: trimmed }]
          : [{ type: "text" as const, text: "I've attached an image for you to analyze." }];
        const parts: import("./core/conversation.js").MessageContent = [
          ...textParts,
          ...attachments.map(attachmentToImagePart),
        ];
        messageContent = parts;
      }

      // Clear attachments before sending
      setAttachments([]);

      await agentRef.current?.sendMessage(messageContent);
      if (agentRef.current) {
        const nextState = agentRef.current.planState;
        setPlanState(nextState);
        if (nextState === "PLANNING_PENDING") {
          setActiveWizard((curr) => {
            if (curr && curr.type === "plan_approve") return curr;
            setWizardOptions([...PLAN_APPROVAL_OPTIONS]);
            setWizardSelectedIndex(0);
            return {
              type: "plan_approve",
              step: 1,
              data: {},
            };
          });
        }
      }
    },
    [isProcessing, activeWizard, handleWizardSubmit, addLine, exit, wizardSelectedIndex, wizardOptions, attachments]
  );

  // ── MessageSubmitDialog handlers ──────────────────────────────────────────
  // When the user submits a message while the AI is still processing, we show
  // a dialog with three options: Queue (wait), Insert (stop now), Back (cancel).
  // These handlers implement the three choices.

  const buildUserLineContent = (
    text: string,
    attachmentsForLine: ImageAttachment[]
  ): string => {
    if (attachmentsForLine.length === 0) {
      return `❯ ${text}`;
    }
    const displayText = text || `[${attachmentsForLine.length} image${attachmentsForLine.length > 1 ? "s" : ""}]`;
    return `❯ ${displayText} 📎×${attachmentsForLine.length}`;
  };

  const buildMessageContent = (
    text: string,
    attachmentsForMessage: ImageAttachment[]
  ): MessageContent => {
    if (attachmentsForMessage.length === 0) return text;
    const textParts: Array<{ type: "text"; text: string }> = text
      ? [{ type: "text" as const, text }]
      : [{ type: "text" as const, text: "I've attached an image for you to analyze." }];
    return [
      ...textParts,
      ...attachmentsForMessage.map(attachmentToImagePart),
    ];
  };

  const handleMessageSubmitChoice = useCallback(
    (choice: MessageSubmitChoice) => {
      const pending = pendingSubmitMessage;
      if (!pending) return;

      const { text, attachments: submittedAttachments } = pending;
      setPendingSubmitMessage(null);

      if (choice === "back") {
        // Restore the typed text and attachments back into the input.
        setInput(text);
        setAttachments(submittedAttachments);
        return;
      }

      // Both Queue and Insert paths need to record the user line and build
      // the multimodal content payload.
      addLine({
        type: "user",
        content: buildUserLineContent(text, submittedAttachments),
        timestamp: Date.now(),
      });

      const messageContent = buildMessageContent(text, submittedAttachments);

      if (!agentRef.current) return;

      if (choice === "insert") {
        // Stop the current run first (this also clears the pending queue),
        // then enqueue the new message so it runs immediately after abort.
        agentRef.current.abort();
        agentRef.current.queueMessage(messageContent);
        return;
      }

      // choice === "queue": enqueue without aborting; the agent will drain the
      // queue automatically when the current run finishes.
      agentRef.current.queueMessage(messageContent);
    },
    [pendingSubmitMessage, addLine]
  );

  const installedSkills = getInstalledSkills();
  const skillCommands = installedSkills.map(s => {
    const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    return `/${slug}`;
  });

  // ── Image attachment handlers ─────────────────────────────────────────────

  const handleAttachImage = useCallback(async (filePath: string) => {
    try {
      const attachment = await readImageFromPath(filePath);
      setAttachments((prev) => [...prev, attachment]);
    } catch (err: any) {
      addLine({
        type: "system",
        content: `Could not attach image: ${err.message}`,
        timestamp: Date.now(),
      });
    }
  }, [addLine]);

  const handlePasteImage = useCallback(async () => {
    try {
      const attachment = await readImageFromClipboard();
      if (attachment) {
        setAttachments((prev) => [...prev, attachment]);
        addLine({
          type: "system",
          content: `📎 Clipboard image attached: ${attachment.filename} (${formatFileSize(attachment.sizeBytes)})`,
          timestamp: Date.now(),
        });
      } else {
        addLine({
          type: "system",
          content: `⚠️ No image found in system clipboard (or clipboard format not supported). Make sure you copied an image or took a screenshot first.`,
          timestamp: Date.now(),
        });
      }
    } catch (err: any) {
      addLine({
        type: "error",
        content: `Could not read image from clipboard: ${err?.message || err}`,
        timestamp: Date.now(),
      });
    }
  }, [addLine]);

  const handleRemoveLastAttachment = useCallback(() => {
    setAttachments((prev) => prev.slice(0, -1));
  }, []);

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);


  const commands = [
    ...new Set(
      registry.getAll().flatMap(cmd => {
        const names = [`/${cmd.name}`];
        if (cmd.aliases) names.push(...cmd.aliases.map(a => `/${a}`));
        return names;
      })
    ),
    ...skillCommands
  ];

  const getSuggestions = (originalInput = input) => {
    const context = getActiveCommandContext(originalInput, originalInput.length);
    if (!context) return [];

    const { commandSegment, isBang } = context;
    let currentInput = commandSegment;
    if (isBang) {
      currentInput = `/terminal ${commandSegment.slice(1).trim()}`;
    }

    const getRawSuggestions = () => {
      if (!currentInput.startsWith("/")) return [];
      const trimmed = currentInput.trim();
      const parts = trimmed.split(/\s+/);
      const mainCommand = parts[0];

      if (mainCommand === "/mp") {
        const presets = getModelPresets();
        const presetSuggestions = presets.length > 0
          ? presets.map(p => `/mp ${p.name}`)
          : ["/mp fast", "/mp default", "/mp balanced"];
        const searchTerm = currentInput.replace(/^\/mp\s*/i, "").trim();
        return searchTerm
          ? filterSuggestions(presetSuggestions, currentInput)
          : presetSuggestions;
      }

      if (mainCommand.startsWith("/mp-")) {
        const presets = getModelPresets();
        const presetSuggestions = presets.length > 0
          ? presets.map(p => `/mp-${p.name}`)
          : ["/mp-fast", "/mp-default", "/mp-balanced"];
        return filterSuggestions(presetSuggestions, currentInput);
      }

      if (!currentInput.includes(" ")) {
        return filterSuggestions(commands, currentInput);
      }

      if (mainCommand === "/processes" || mainCommand === "/procs") {
        if (currentInput.startsWith(`${mainCommand} stop`)) {
          const stopSuggestions = [`${mainCommand} stop all`];
          for (const [id, task] of backgroundTasks.entries()) {
            if (isTaskInWorkspace(task.cwd, workspacePath)) {
              stopSuggestions.push(`${mainCommand} stop ${id}`);
            }
          }
          return stopSuggestions.filter(p => p.startsWith(currentInput));
        }
        return [`${mainCommand} stop`, `${mainCommand} stop all`].filter(p => p.startsWith(currentInput));
      }

      if (mainCommand === "/workspace" || mainCommand === "/w") {
        if (currentInput.startsWith(`${mainCommand} use`)) {
          const dirs = getTrustedDirectories();
          const useSuggestions = dirs.map((_, idx) => `${mainCommand} use ${idx + 1}`);
          return useSuggestions.filter(p => p.startsWith(currentInput));
        }
        const workspaceSuggestions = [
          `${mainCommand} add`,
          `${mainCommand} use`
        ];
        return filterSuggestions(workspaceSuggestions, currentInput);
      }

      if (mainCommand === "/worktree" || mainCommand === "/worktrees") {
        const worktreeSuggestions = [
          `${mainCommand} list`,
          `${mainCommand} prune`,
          `${mainCommand} remove`
        ];
        return filterSuggestions(worktreeSuggestions, currentInput);
      }

      if (mainCommand === "/checkpoint") {
        const checkpointSuggestions = [
          `${mainCommand} list`,
          `${mainCommand} restore`,
          `${mainCommand} delete`
        ];
        return filterSuggestions(checkpointSuggestions, currentInput);
      }

      if (mainCommand === "/login") {
        const loginSuggestions = [
          `${mainCommand} add`,
          `${mainCommand} list`,
          `${mainCommand} remove`,
          `${mainCommand} edit`
        ];
        return filterSuggestions(loginSuggestions, currentInput);
      }

      if (mainCommand === "/terminal") {
        if (currentInput.startsWith(`${mainCommand} stop`)) {
          const stopSuggestions = [`${mainCommand} stop all`];
          for (const [id, task] of backgroundTasks.entries()) {
            if (id.startsWith("term-") && isTaskInWorkspace(task.cwd, workspacePath)) {
              stopSuggestions.push(`${mainCommand} stop ${id}`);
            }
          }
          return stopSuggestions.filter(p => p.startsWith(currentInput));
        }
        if (currentInput.startsWith(`${mainCommand} bg`)) {
          const bgSuggestions = [`${mainCommand} bg preset`];
          return bgSuggestions.filter(p => p.startsWith(currentInput));
        }
        const terminalSuggestions = [
          `${mainCommand} init`,
          `${mainCommand} bg`,
          `${mainCommand} stop`,
          `${mainCommand} stop all`,
          `${mainCommand} all`,
          `${mainCommand} preset`
        ];
        return filterSuggestions(terminalSuggestions, currentInput);
      }

      if (mainCommand === "/internal-hooks" || mainCommand === "/ih") {
        const subSuggestions = [`${mainCommand} init`, `${mainCommand} dev`, `${mainCommand} active`];
        if (parts.length === 2) {
          return filterSuggestions(subSuggestions, currentInput);
        }
        if (parts.length >= 3 && parts[1].toLowerCase() === "dev") {
          const hooksRoot = path.join(process.cwd(), "internal-hooks");
          let hookDirs: string[] = [];
          if (tryStatSync(hooksRoot)?.isDirectory()) {
            try {
              hookDirs = fsSync.readdirSync(hooksRoot, { withFileTypes: true })
                .filter(item => item.isDirectory())
                .map(item => `${mainCommand} dev ${item.name}`);
            } catch {}
          }
          return filterSuggestions(hookDirs, currentInput);
        }
        return filterSuggestions(subSuggestions, currentInput);
      }

      if (mainCommand === "/model") {
        const isMultiAgent = !!agentRef.current?.isMultiAgent;
        const currentParts = currentInput.trim().split(/\s+/);
        const endsWithSpace = currentInput.endsWith(" ");

        if (currentInput.startsWith(`${mainCommand} preset`)) {
          if (currentParts.length >= 3 && !["list", "save"].includes(currentParts[2])) {
            const prefix = currentParts.slice(0, 3).join(" ");
            const flagSuggestions = [
              `${prefix} --save`,
              `${prefix} --global`
            ];
            return filterSuggestions(flagSuggestions, currentInput);
          }
          
          const mode = isMultiAgent ? "multi" : "single";
          const presets = getModelPresets(mode).map(p => `${mainCommand} preset ${p.name}`);
          const presetSuggestions = [
            `${mainCommand} preset list`,
            `${mainCommand} preset save`,
            ...presets
          ];
          return filterSuggestions(presetSuggestions, currentInput);
        }

        if (currentParts.length >= 3 && ["master", "superagent", "subagent"].includes(currentParts[1])) {
          if (currentParts.length === 3 && endsWithSpace) {
            const prefix = currentParts.join(" ");
            return [
              `${prefix} --save`,
              `${prefix} --global`
            ];
          }
          if (currentParts.length === 4) {
            const prefix = currentParts.slice(0, 3).join(" ");
            const flagSuggestions = [
              `${prefix} --save`,
              `${prefix} --global`
            ];
            return filterSuggestions(flagSuggestions, currentInput);
          }
        }

        const modelSuggestions = [
          `${mainCommand} preset`,
          `${mainCommand} master`,
          `${mainCommand} superagent`,
          `${mainCommand} subagent`
        ];
        return filterSuggestions(modelSuggestions, currentInput);
      }

      if (mainCommand === "/compact") {
        const compactSuggestions = [
          `${mainCommand} now`
        ];
        return filterSuggestions(compactSuggestions, currentInput);
      }

      if (mainCommand === "/pin") {
        const pinSuggestions = [
          `${mainCommand} list`,
          `${mainCommand} list-messages`,
          `${mainCommand} last`,
          `${mainCommand} view`,
          `${mainCommand} tag`,
          `${mainCommand} unpin`
        ];
        return filterSuggestions(pinSuggestions, currentInput);
      }

      if (mainCommand === "/knowledge") {
        const knowledgeSuggestions = [
          `${mainCommand} list`,
          `${mainCommand} projects`
        ];
        return filterSuggestions(knowledgeSuggestions, currentInput);
      }

      if (mainCommand === "/search-history") {
        const shSuggestions = [
          `${mainCommand} --all`
        ];
        return filterSuggestions(shSuggestions, currentInput);
      }

      if (mainCommand === "/mcp") {
        const mcpSuggestions = [
          `${mainCommand} list`,
          `${mainCommand} add`,
          `${mainCommand} remove`,
          `${mainCommand} reload`
        ];
        return filterSuggestions(mcpSuggestions, currentInput);
      }

      if (mainCommand === "/ssh") {
        const sshSuggestions = [
          `${mainCommand} expand`,
          `${mainCommand} allowed`,
          `${mainCommand} status`
        ];
        return filterSuggestions(sshSuggestions, currentInput);
      }

      return [];
    };

    const res = getRawSuggestions();
    if (isBang) {
      return res.map(s => {
        if (s.startsWith("/terminal")) {
          const suffix = s.slice(9);
          if (suffix.startsWith(" ")) {
            return `!${suffix.trim()}`;
          }
          return `!${suffix}`;
        }
        return s;
      });
    }
    return res;
  };

  const handleInputChange = useCallback((val: string) => {
    const sanitizedVal = stripSgrMouseSequences(val);

    const nextPasteState = updatePasteState(input, sanitizedVal, {
      isPasted,
      pastePrefixLength,
      pasteSuffixLength,
    });
    setIsPasted(nextPasteState.isPasted);
    setPastePrefixLength(nextPasteState.pastePrefixLength);
    setPasteSuffixLength(nextPasteState.pasteSuffixLength);
    setInput(sanitizedVal);
    if (lastTabPrefix) {
      const suggs = getSuggestions(lastTabPrefix);
      if (!suggs.includes(sanitizedVal) && sanitizedVal !== lastTabPrefix) {
        setLastTabPrefix(null);
      }
    }
    if (activeWizard?.type === "model" && wizardOptions.length > 0) {
      setWizardSelectedIndex(0);
    }
  }, [input, lastTabPrefix, activeWizard, wizardOptions, isPasted, pastePrefixLength, pasteSuffixLength]);

  const getWizardQuestion = () => {
    if (!activeWizard) return null;
    if (activeWizard.type === "login") {
      if (activeWizard.step === 1) return "Select whether to view configured providers or create a new one.";
      if (activeWizard.step === 2) return "Select the provider type to configure.";
      if (activeWizard.step === 3) return "Enter a name for the provider profile (or press Enter for default).";
      if (activeWizard.step === 4) return "Enter the custom endpoint base URL.";
      if (activeWizard.step === 5) return "Paste the API key for this provider.";
      if (activeWizard.step === 6) return "Select a provider from the configured list.";
      if (activeWizard.step === 7) return "Select whether to test the provider connection first.";
      if (activeWizard.step === 8) return "Select an available model (type to filter).";
      if (activeWizard.step === 9) return "Type a test message to send to the model.";
      if (activeWizard.step === 10) return "Select the technology stack for the new project.";
      if (activeWizard.step === 11) return "Enter the project name (or press Enter for folder default).";
      if (activeWizard.step === 12) return "Enter a short project description.";
      if (activeWizard.step === 13) return "Describe the project you want to build; AI will create a specification.";
      if (activeWizard.step === 14) return "Select the provider to remove using arrows and Enter.";
      if (activeWizard.step === 15) return "Confirm deletion of the selected provider.";

    }
    if (activeWizard.type === "model") {
      if (activeWizard.step === 1) return "Select model configuration option.";
      if (activeWizard.step === 2) return "Select provider for model tier.";
      if (activeWizard.step === 3) return "Select a configured provider profile, or create a new one.";
      if (activeWizard.step === 6) return "Enter a name for the new provider profile.";
      if (activeWizard.step === 7) return "Enter the custom endpoint base URL.";
      if (activeWizard.step === 8) return "Paste the API key for the new provider profile.";
      if (activeWizard.step === 15 || activeWizard.step === 24 || activeWizard.step === 34) return "Select an available model (type to filter).";
      if (activeWizard.step === 60 || activeWizard.step === 61 || activeWizard.step === 62) {
        const modelName = activeWizard.data.tempModelName || activeWizard.data.tempFinalModelName || "";
        const cleanName = modelName.includes("@") ? modelName.split("@")[1] : modelName;
        return `Does the model "${cleanName}" support vision/image inputs?`;
      }
    }
    if (activeWizard.type === "question") {
      return pendingQuestion?.question || "Select an option or type a custom answer.";
    }
    if (activeWizard.type === "workspace") {
      if (activeWizard.step === 1) return "Select a workspace option using arrows and Enter.";
      if (activeWizard.step === 2) return "Select a workspace directory to switch to.";
      if (activeWizard.step === 3) return "Enter the directory path of the new workspace:";
      if (activeWizard.step === 6) return "Enter a friendly display name for the new workspace:";
      if (activeWizard.step === 4) return "Select a workspace directory to remove.";
      if (activeWizard.step === 5) return "Confirm removal of the selected workspace.";
      if (activeWizard.step === 7) return "Select a workspace chain to manage or create a new one.";
      if (activeWizard.step === 8) return "Select an action for the chosen workspace chain.";
      if (activeWizard.step === 9) return "Enter a name for the new workspace chain:";
      if (activeWizard.step === 10) return "Enter a new name for the workspace chain:";
      if (activeWizard.step === 11) return "Select a workspace to add as a node:";
      if (activeWizard.step === 12) return "Select a role for the new node:";
      if (activeWizard.step === 13) return "Select a node to remove from the chain:";
      if (activeWizard.step === 14) return "Confirm deletion of the workspace chain.";
      if (activeWizard.step === 15) return "Enter directory path or SSH target for the new node:";
    }
    if (activeWizard.type === "permission") {
      return pendingPermission?.description || "Allow or deny this action.";
    }
    return null;
  };

  const getWizardPlaceholder = () => {
    if (!activeWizard) return "Type a message or /help...";
    if (activeWizard.type === "skills") {
      if (activeWizard.step === 1) return "🔍 Search skills (type to filter, arrows to navigate, Enter to select)...";
      if (activeWizard.step === 2) return "Select action using arrows and Enter (Esc: Back)...";
    }
    if (activeWizard.type === "login") {
      if (activeWizard.step === 1) return "Select option using arrows and Enter (Esc: Cancel)...";
      if (activeWizard.step === 2) return "Select provider template using arrows and Enter (Esc: Back)...";
      if (activeWizard.step === 3) return "Enter config profile name (or press Enter for default, Esc: Back)...";
      if (activeWizard.step === 4) return "Enter Custom Base URL (Esc: Back)...";
      if (activeWizard.step === 5) return "Paste API key (Esc: Back)...";
      if (activeWizard.step === 6) return "Select provider using arrows and Enter (Esc: Cancel)...";
      if (activeWizard.step === 7) return "Select option using arrows and Enter (Esc: Back)...";
      if (activeWizard.step === 8) return "🔍 Search models (type to filter, arrows to navigate, Enter to select)...";
      if (activeWizard.step === 9) return "Type your test message and press Enter...";
      if (activeWizard.step === 10) return "Select option using arrows and Enter (Esc: Cancel)...";
      if (activeWizard.step === 11) return "Enter project name (press Enter for folder default, Esc: Back)...";
      if (activeWizard.step === 12) return "Enter project description (press Enter for default, Esc: Back)...";
      if (activeWizard.step === 13) return "Describe the project (e.g. CLI tool in Rust, Esc: Back)...";
      if (activeWizard.step === 14) return "Select provider to delete using arrows and Enter (Esc: Back)...";
      if (activeWizard.step === 15) return "Confirm deletion using arrows and Enter (Esc: Back)...";
    }
    if (activeWizard.type === "model") {
      if (activeWizard.step === 1) return "Select option using arrows and Enter...";
      if (activeWizard.step === 2) return "Enter provider number or select using arrows...";
      if (activeWizard.step === 20) return "Type preset name and press Enter (or type 'back' to go back)...";
      if (activeWizard.step === 21) return "Type preset description and press Enter (or type 'back' to go back)...";
      if (activeWizard.step === 22 || activeWizard.step === 32) return "Select tier option using arrows and Enter...";
      if (activeWizard.step === 23 || activeWizard.step === 33) return "Select provider using arrows and Enter...";
      if (activeWizard.step === 3 || activeWizard.step === 25 || activeWizard.step === 35) return "🔍 Search profiles (type to filter, arrows to navigate, Enter to select)...";
      if (activeWizard.step === 15 || activeWizard.step === 24 || activeWizard.step === 34) return "🔍 Search models (type to filter, arrows to navigate, Enter to select)...";
      if (activeWizard.step === 4 || activeWizard.step === 30 || activeWizard.step === 40) return "🔍 Search presets (type to filter, arrows to navigate, Enter to select)...";
      if (activeWizard.step === 31) return "Type new description and press Enter (or type 'back' to go back)...";
      if (activeWizard.step === 41) return "Select confirmation using arrows and Enter...";
      if (activeWizard.step === 50) return "Select agent tier using arrows and Enter...";
      if (activeWizard.step === 60 || activeWizard.step === 61 || activeWizard.step === 62) return "Select Yes or No using arrows and Enter...";
      if (activeWizard.step === 6) return "Enter config profile name (or press Enter for default)...";
      if (activeWizard.step === 7) return "Enter Custom Base URL...";
      if (activeWizard.step === 8) return "Paste API key...";
      return wizardOptions.length > 0
        ? "🔍 Search models (type to filter, arrows to navigate, Enter to select)..."
        : "Enter model name (e.g. google/gemini-2.5-flash)...";
    }
    if (activeWizard.type === "workspace") {
      if (activeWizard.step === 1) return "Select workspace option using arrows and Enter (Esc: Cancel)...";
      if (activeWizard.step === 2) return "🔍 Search workspaces (type to filter, arrows to navigate, Enter to select)...";
      if (activeWizard.step === 3) return "Enter workspace directory path and press Enter...";
      if (activeWizard.step === 6) return "Enter workspace display name (or press Enter for default)...";
      if (activeWizard.step === 4) return "🔍 Search workspaces to remove (type to filter, Enter to select)...";
      if (activeWizard.step === 5) return "Select confirmation using arrows and Enter...";
      if (activeWizard.step === 7) return "🔍 Search workspace chains (type to filter, Enter to select)...";
      if (activeWizard.step === 8) return "Select action using arrows and Enter (Esc: Back)...";
      if (activeWizard.step === 9) return "Enter workspace chain name and press Enter...";
      if (activeWizard.step === 10) return "Enter new chain name and press Enter...";
      if (activeWizard.step === 11) return "🔍 Search workspaces (type to filter, arrows to navigate, Enter to select)...";
      if (activeWizard.step === 12) return "Select role using arrows and Enter (Esc: Back)...";
      if (activeWizard.step === 13) return "Select node using arrows and Enter (Esc: Back)...";
      if (activeWizard.step === 14) return "Select confirmation using arrows and Enter...";
      if (activeWizard.step === 15) return "Enter node path or user@host:port/path target and press Enter...";
    }
    if (activeWizard.type === "question") {
      if (pendingQuestion?.inputType === "password") return "Enter password (hidden) and press Enter...";
      if (pendingQuestion?.inputType === "text") return "Type answer and press Enter...";
      if (activeWizard.step === 2) return "Type custom answer and press Enter...";
      return "Select option using arrows and Enter, or choose Custom...";
    }
    return "Enter value...";
  };

  const suggestions = (activeWizard && activeWizard.type !== "question" && activeWizard.type !== "model") ? [] : getSuggestions(lastTabPrefix || input);

  // Bind Keyboard Handler Hook
  useKeyboardHandler({
    input,
    setInput,
    isProcessing,
    setIsProcessing,
    activeWizard,
    setActiveWizard,
    wizardOptions,
    setWizardOptions,
    wizardSelectedIndex,
    setWizardSelectedIndex,
    wizardSelectedSet,
    setWizardSelectedSet,
    checkpointsList,
    setCheckpointsList,
    lines,
    setLines,
    addLine,
    history,
    setHistory,
    historyIndex,
    setHistoryIndex,
    tempInput,
    setTempInput,
    scrollOffset,
    setScrollOffset,
    focusedResponseIndex,
    setFocusedResponseIndex,
    focusedResponseOffset,
    setFocusedResponseOffset,
    planState,
    setPlanState,
    focusMode,
    setFocusMode,
    historySelectedIndex,
    setHistorySelectedIndex,
    checklistScrollOffset,
    setChecklistScrollOffset,
    superagentsScrollOffset,
    setSuperagentsScrollOffset,
    subagentsScrollOffset,
    setSubagentsScrollOffset,
    procsScrollOffset,
    setProcsScrollOffset,
    procsSelectedIndex,
    setProcsSelectedIndex,
    terminalHeight,
    terminalWidth,
    checklistTasks,
    completedHistory,
    agentRef,
    pendingPermission,
    setPendingPermission,
    pendingQuestion,
    setPendingQuestion,
    handleWizardSubmit,
    handleSubmit,
    handlePermissionResponse,
    openLatestTruncatedResponse,
    stopRunningSubagents,
    scrollChat,
    setContextLimit,
    setActiveModel,
    exit,
    isPasted,
    setIsPasted,
    pastePrefixLength,
    pasteSuffixLength,
    lastTabPrefix,
    setLastTabPrefix,
    commands,
    suggestions,
    visibleLinePositions,
    toggleLineExpand,
    toggleChildExpand,
    toggleThinkingExpand,
    expandCursorRef,
  });

  // Handle active outputs and task checklist updates
  const [activeToolOutput, setActiveToolOutput] = useState("");
  useEffect(() => {
    return subscribeToActiveOutput((out) => {
      setActiveToolOutput(out);
    });
  }, []);

  useEffect(() => {
    if (!isExecutingTool || !toolTimeout || !toolStartTime) {
      return;
    }
    const interval = setInterval(() => {
      const elapsed = Date.now() - toolStartTime;
      const remaining = Math.max(0, Math.ceil((toolTimeout - elapsed) / 1000));
      setTimeLeft(remaining);
    }, 1000);
    return () => clearInterval(interval);
  }, [isExecutingTool, toolTimeout, toolStartTime]);

  useEffect(() => {
    let active = true;
    let intervalId: NodeJS.Timeout | null = null;

    const check = async () => {
      const taskPath = agentRef.current ? agentRef.current.getTaskFilePath() : null;
      if (!taskPath) return;
      try {
        const result = await readChecklistTasks(taskPath);
        if (!active) return;
        setChecklistTasks(result.tasks);

        // Also poll the task history file for completed tasks archive
        try {
          const history = await readTaskHistory(taskPath);
          if (!active) return;
          setRawCompletedHistory(history);
        } catch {
          if (active) setRawCompletedHistory([]);
        }
      } catch (err: any) {
        if (active) {
          setChecklistTasks([]);
          setRawCompletedHistory([]);
        }
      }
    };

    if (planState === "APPROVED") {
      check();
      intervalId = setInterval(check, 2000);
    } else {
      setChecklistTasks([]);
      setRawCompletedHistory([]);
    }

    return () => {
      active = false;
      if (intervalId) clearInterval(intervalId);
    };
  }, [planState]);

  // Synchronize rawCompletedHistory with completedHistory using a 15-second auto-hide decay
  useEffect(() => {
    if (planState !== "APPROVED" || rawCompletedHistory.length === 0) {
      historyTimestampsRef.current.clear();
      setCompletedHistory([]);
      return;
    }

    const now = Date.now();
    // 1. Record timestamps for new items in rawCompletedHistory
    const currentTexts = new Set(rawCompletedHistory.map(t => t.text));
    for (const task of rawCompletedHistory) {
      if (!historyTimestampsRef.current.has(task.text)) {
        historyTimestampsRef.current.set(task.text, now);
      }
    }

    // 2. Clean up timestamps for tasks no longer in rawCompletedHistory
    for (const text of historyTimestampsRef.current.keys()) {
      if (!currentTexts.has(text)) {
        historyTimestampsRef.current.delete(text);
      }
    }

    // 3. Define a function to compute filtered history
    const updateFilteredHistory = () => {
      const currentTime = Date.now();
      const filtered = rawCompletedHistory
        .map(task => {
          const firstSeen = historyTimestampsRef.current.get(task.text);
          if (!firstSeen) return null;
          const elapsed = currentTime - firstSeen;
          const remainingSeconds = Math.max(0, Math.ceil((15000 - elapsed) / 1000));
          return { ...task, remainingSeconds };
        })
        .filter((task): task is { status: string; text: string; remainingSeconds: number } => {
          return task !== null && task.remainingSeconds > 0;
        });

      // Update state if the content or remainingSeconds changed
      setCompletedHistory(prev => {
        const hasChanged = prev.length !== filtered.length ||
          prev.some((t, i) => t.text !== filtered[i].text || t.remainingSeconds !== filtered[i].remainingSeconds);
        if (hasChanged) {
          return filtered;
        }
        return prev;
      });
    };

    // Run immediately
    updateFilteredHistory();

    // 4. Set up an interval to tick every 1 second and filter out expired items
    const interval = setInterval(updateFilteredHistory, 1000);

    return () => clearInterval(interval);
  }, [rawCompletedHistory, planState]);

  // Handle events and inits
  const handleEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.type) {
        case "text": {
          if (streamTimeoutRef.current) {
            clearTimeout(streamTimeoutRef.current);
            streamTimeoutRef.current = null;
          }
          streamBufferRef.current += event.content;

          // Throttle state updates to at most once every 40ms to prevent Ink render overload.
          const now = Date.now();
          if (now - lastStreamUpdateRef.current > 40) {
            setStreamDisplay(textStreamCleaner.clean(streamBufferRef.current));
            lastStreamUpdateRef.current = now;
            if (deferredStreamTimeoutRef.current) {
              clearTimeout(deferredStreamTimeoutRef.current);
              deferredStreamTimeoutRef.current = null;
            }
          } else {
            // Schedule a deferred update for the trailing characters if not already scheduled.
            if (!deferredStreamTimeoutRef.current) {
              deferredStreamTimeoutRef.current = setTimeout(() => {
                setStreamDisplay(textStreamCleaner.clean(streamBufferRef.current));
                lastStreamUpdateRef.current = Date.now();
                deferredStreamTimeoutRef.current = null;
              }, 40);
            }
          }
          break;
        }
        case "reasoning": {
          if (streamTimeoutRef.current) {
            clearTimeout(streamTimeoutRef.current);
            streamTimeoutRef.current = null;
          }
          reasoningBufferRef.current += event.content;
          
          const now = Date.now();
          if (now - lastReasoningUpdateRef.current > 40) {
            setReasoningDisplay(reasoningBufferRef.current);
            lastReasoningUpdateRef.current = now;
            if (deferredReasoningTimeoutRef.current) {
              clearTimeout(deferredReasoningTimeoutRef.current);
              deferredReasoningTimeoutRef.current = null;
            }
          } else {
            if (!deferredReasoningTimeoutRef.current) {
              deferredReasoningTimeoutRef.current = setTimeout(() => {
                setReasoningDisplay(reasoningBufferRef.current);
                lastReasoningUpdateRef.current = Date.now();
                deferredReasoningTimeoutRef.current = null;
              }, 40);
            }
          }
          break;
        }
        case "tool_start": {
          if (streamTimeoutRef.current) {
            clearTimeout(streamTimeoutRef.current);
            streamTimeoutRef.current = null;
          }
          const content = streamBufferRef.current.trim();
          const reasoning = reasoningBufferRef.current.trim();
          if (content || reasoning) {
            flushBuffer();
          } else {
            streamBufferRef.current = "";
            reasoningBufferRef.current = "";
            textStreamCleaner.reset();
            reasoningStreamCleaner.reset();
            setStreamDisplay("");
            setReasoningDisplay("");
          }
          const timeoutArg = event.toolCall.args?.timeout;
          if (typeof timeoutArg === "number") {
            setToolTimeout(timeoutArg);
            setToolStartTime(Date.now());
            setTimeLeft(Math.ceil(timeoutArg / 1000));
          } else {
            setToolTimeout(null);
            setToolStartTime(null);
            setTimeLeft(null);
          }
          setIsExecutingTool(true);
          setActiveToolName(event.toolCall.name);
          setActiveToolDesc(event.description || "");
          let prefixEmoji = "⚡";
          let customTitle = event.description;
          if (event.toolCall.name === "read" && typeof event.toolCall.args.filePath === "string") {
            const filePath = event.toolCall.args.filePath;
            if (filePath.includes("skills") && filePath.endsWith("SKILL.md")) {
              prefixEmoji = "📖";
              const parts = filePath.replace(/\\/g, "/").split("/");
              const skillName = parts[parts.length - 2] || "unknown";
              customTitle = `[SKILL] Loading instructions for: ${skillName}`;
            }
          }
          addToolChild({
            type: "tool_start",
            content: `${prefixEmoji} ${customTitle}\n   Detail: ${event.toolCall.name}(${formatArgs(event.toolCall.args)})`,
            timestamp: Date.now(),
          });
          break;
        }
        case "tool_progress": {
          const { message } = event;
          setLines((prev) => {
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].type === "assistant") {
                const children = prev[i].children;
                if (children && children.length > 0) {
                  for (let c = children.length - 1; c >= 0; c--) {
                    if (children[c].type === "tool_start" && !children[c].mergedResult) {
                      const updated = [...prev];
                      const parent = { ...updated[i] };
                      const updatedChildren = [...children];
                      updatedChildren[c] = {
                        ...updatedChildren[c],
                        content: updatedChildren[c].content + "\n" + message,
                      };
                      parent.children = updatedChildren;
                      updated[i] = parent;
                      return updated;
                    }
                  }
                }
                break;
              }
            }
            return prev;
          });
          break;
        }
        case "tool_end": {
          setIsExecutingTool(false);
          setActiveToolName("");
          setActiveToolDesc("");
          setToolTimeout(null);
          setToolStartTime(null);
          setTimeLeft(null);
          const r = event.toolResult;
          let prefixEmojiEnd = r.isError ? "✗" : "✓";
          let customTitleEnd = event.description;
          if (r.name === "read" && typeof event.description === "string") {
            const desc = event.description;
            if (desc.includes("skills") && desc.endsWith("SKILL.md")) {
              prefixEmojiEnd = r.isError ? "🚨" : "📖";
              const parts = desc.replace(/\\/g, "/").split("/");
              const skillName = parts[parts.length - 2] || "unknown";
              customTitleEnd = `[SKILL] Loaded instructions for: ${skillName}`;
            }
          }

          // Build result content — for bulk tools, list all files instead of truncating raw output
          let resultContent: string;
          if (r.isError) {
            resultContent = `Detail: ${r.result}`;
          } else {
            const tcArgs = event.toolCall?.args;
            // Bulk read: filePaths array with 2+ entries
            if (
              tcArgs?.filePaths &&
              Array.isArray(tcArgs.filePaths) &&
              tcArgs.filePaths.length > 1
            ) {
              const paths: string[] = tcArgs.filePaths.map((p: any) =>
                typeof p === "string" ? p : (p?.path ?? String(p))
              );
              resultContent = `Output: Read ${paths.length} files:\n${paths.map((p) => `  ${p}`).join("\n")}`;
            // Bulk edit: edits array with multiple unique file paths
            } else if (
              tcArgs?.edits &&
              Array.isArray(tcArgs.edits) &&
              tcArgs.edits.length > 0
            ) {
              const uniquePaths = Array.from(
                new Set(tcArgs.edits.map((e: any) => e.filePath ?? e.path).filter(Boolean))
              ) as string[];
              if (uniquePaths.length > 1) {
                resultContent = `Output: Edited ${uniquePaths.length} files:\n${uniquePaths.map((p) => `  ${p}`).join("\n")}`;
              } else {
                resultContent = `Output: ${r.result.slice(0, 500)}${r.result.length > 500 ? "..." : ""}`;
              }
            // Bulk write: files array with 2+ entries
            } else if (
              tcArgs?.files &&
              Array.isArray(tcArgs.files) &&
              tcArgs.files.length > 1
            ) {
              const paths = Array.from(
                new Set(tcArgs.files.map((f: any) => f.filePath ?? f.path).filter(Boolean))
              ) as string[];
              resultContent = `Output: Wrote ${paths.length} files:\n${paths.map((p) => `  ${p}`).join("\n")}`;
            // Bulk patch: patches array with 2+ entries
            } else if (
              tcArgs?.patches &&
              Array.isArray(tcArgs.patches) &&
              tcArgs.patches.length > 1
            ) {
              const paths = Array.from(
                new Set(tcArgs.patches.map((p: any) => p.filePath ?? p.path).filter(Boolean))
              ) as string[];
              resultContent = `Output: Patched ${paths.length} files:\n${paths.map((p) => `  ${p}`).join("\n")}`;
            } else {
              // Default: truncate raw output
              resultContent = `Output: ${r.result.slice(0, 500)}${r.result.length > 500 ? "..." : ""}`;
            }
          }

          // Patch the matching tool_start child with the result — no separate tool_end child needed
          patchLastToolStart({
            isError: !!r.isError,
            content: resultContent,
            description: customTitleEnd,
          });
          break;
        }


        case "error":
          if (streamTimeoutRef.current) {
            clearTimeout(streamTimeoutRef.current);
            streamTimeoutRef.current = null;
          }
          if (deferredStreamTimeoutRef.current) {
            clearTimeout(deferredStreamTimeoutRef.current);
            deferredStreamTimeoutRef.current = null;
          }
          if (deferredReasoningTimeoutRef.current) {
            clearTimeout(deferredReasoningTimeoutRef.current);
            deferredReasoningTimeoutRef.current = null;
          }
          setIsExecutingTool(false);
          setToolTimeout(null);
          setToolStartTime(null);
          setTimeLeft(null);
          flushBuffer();
          streamBufferRef.current = "";
          reasoningBufferRef.current = "";
          textStreamCleaner.reset();
          reasoningStreamCleaner.reset();
          setStreamDisplay("");
          setReasoningDisplay("");
          addLine({
            type: "error",
            content: `Error: ${event.message}`,
            timestamp: Date.now(),
          });
          break;
        case "done":
          if (streamTimeoutRef.current) {
            clearTimeout(streamTimeoutRef.current);
            streamTimeoutRef.current = null;
          }
          flushBuffer();
          streamBufferRef.current = "";
          reasoningBufferRef.current = "";
          textStreamCleaner.reset();
          reasoningStreamCleaner.reset();
          setStreamDisplay("");
          setReasoningDisplay("");
          setIsExecutingTool(false);
          setToolTimeout(null);
          setToolStartTime(null);
          setTimeLeft(null);
          setIsProcessing(false);
          break;
        case "goal_done":
          setGoalMode(null);
          if (agentRef.current) {
            agentRef.current.goalMode = null;
          }
          addLine({
            type: "system",
            content: `🎯 GOAL MODE COMPLETED\n   Goal: "${event.goal}"\n   ${event.summary}`,
            timestamp: Date.now(),
          });
          break;
        case "token_usage":
          setTokensUp((prev) => prev + (event.promptTokens || 0));
          setTokensDown((prev) => prev + (event.completionTokens || 0));
          setLastPromptTokens(event.promptTokens || 0);
          if (event.durationMs && event.completionTokens > 0) {
            const speed = (event.completionTokens || 0) / (event.durationMs / 1000);
            setLastSpeed(speed);
          }
          break;
        case "checkpoint_auto":
          addLine({
            type: "system",
            content: `💾 Auto-checkpoint: ${event.name} [${event.id}]`,
            timestamp: Date.now(),
          });
          break;
        case "model_download": {
          const { modelName, status, progress } = event;
          if (modelName === "classifier") {
            if (status === "downloading" || status === "progress") {
              setClassifierStatus("loading");
            } else if (status === "loaded") {
              setClassifierStatus("online");
            }
          } else if (modelName === "embedding") {
            if (status === "downloading" || status === "progress") {
              setEmbeddingStatus("loading");
            } else if (status === "loaded") {
              setEmbeddingStatus("online");
            }
          }

          setLines((prev) => {
            const updated = [...prev];
            const searchKey = `Downloading local ${modelName} model`;
            for (let i = updated.length - 1; i >= 0; i--) {
              if (updated[i].type === "system" && (updated[i].content.includes(searchKey) || updated[i].content.includes(`Local ${modelName} model`))) {
                if (status === "progress" && typeof progress === "number") {
                  updated[i] = {
                    ...updated[i],
                    content: `⏳ Downloading local ${modelName} model: ${progress.toFixed(1)}%`,
                  };
                } else if (status === "loaded") {
                  updated[i] = {
                    ...updated[i],
                    content: `✅ Local ${modelName} model loaded successfully.`,
                  };
                }
                return updated;
              }
            }
            let initialContent = "";
            if (status === "downloading") {
              initialContent = `⏳ Downloading local ${modelName} model (~${modelName === "embedding" ? "100MB" : "66MB"}) to cache...`;
            } else if (status === "progress" && typeof progress === "number") {
              initialContent = `⏳ Downloading local ${modelName} model: ${progress.toFixed(1)}%`;
            } else {
              return prev;
            }
            updated.push({
              type: "system",
              content: initialContent,
              timestamp: Date.now(),
            });
            return updated;
          });
          break;
        }
      }
      // Always sync planState for UI indicators (e.g. PENDING_PLAN banner),
      // but only open the approval wizard on "done" — after flushBuffer() has
      // committed all streamed text to chat lines. Opening on every event
      // caused the wizard to appear before the response finished printing.
      if (agentRef.current) {
        const nextState = agentRef.current.planState;
        setPlanState(nextState);
        if (event.type === "done" && nextState === "PLANNING_PENDING") {
          setActiveWizard((curr) => {
            if (curr && curr.type === "plan_approve") return curr;
            setWizardOptions([...PLAN_APPROVAL_OPTIONS]);
            setWizardSelectedIndex(0);
            return {
              type: "plan_approve",
              step: 1,
              data: {},
            };
          });
        }
      }
    },
    [flushBuffer, addLine, addToolChild]
  );

  const permissionHandler: PermissionHandler = useCallback(
    (toolCall: ToolCall, description: string) => {
      return new Promise<boolean | "session">((resolve) => {
        // model-config.json is always protected — no session-level bypass option
        const isModelCfgAccess = description.includes("model-config.json");
        // .env files are sensitive but can be session-scoped (user might be doing env-related work)
        const isEnvFileAccess = description.includes(".env file");
        const isCmd = ["bash", "run_command", "run_background_process"].includes(toolCall.name);
        const isFileWriteAccess = ["write", "write_to_file", "edit", "replace_file_content", "multi_replace_file_content", "apply_patch"].includes(toolCall.name);
        const options = isModelCfgAccess
          ? ["Allow Access (one-time)", "Deny Access"]
          : isEnvFileAccess
          ? ["Allow Access (one-time)", "Allow for This Session", "Deny Access"]
          : isCmd
          ? ["Allow Command Execution", "Allow for This Session", "Deny Command Execution"]
          : isFileWriteAccess
          ? ["Allow File Write (one-time)", "⚠️ Allow All File Writes This Session", "Deny File Write"]
          : ["Allow File/Directory Access", "Allow for This Session", "Deny File/Directory Access"];
        setPendingPermission({ toolCall, description, resolve });
        setWizardOptions(options);
        setWizardSelectedIndex(0);
        setActiveWizard({
          type: "permission",
          step: 1,
          data: {},
        });
      });
    },
    []
  );  const questionHandler: QuestionHandler = useCallback(
    (question: string | QuestionItem[], options?: string[], isMultiSelect?: boolean, initialCheckedIndices?: number[], inputType?: "select" | "text" | "password") => {
      return new Promise<any>((resolve) => {
        if (Array.isArray(question)) {
          const questions = question;
          const answers = new Array(questions.length).fill("");
          const q0 = questions[0];
          const effectiveInputType = inputType || q0.inputType;
          const isTextMode = effectiveInputType === "text" || effectiveInputType === "password";
          const hasOptions = !isTextMode && Array.isArray(q0.options) && q0.options.length > 0;
          const allOptions = hasOptions ? [...q0.options, "Custom..."] : [];
          setPendingQuestion({ question: q0.question, options: allOptions, resolve, inputType: effectiveInputType });
          setWizardOptions(allOptions);
          setWizardSelectedIndex(0);
          setWizardSelectedSet(initialCheckedIndices ? new Set(initialCheckedIndices) : new Set());
          setActiveWizard({
            type: "question",
            step: hasOptions ? 1 : 2,
            data: { question: q0.question },
            isMultiSelect: q0.isMultiSelect,
            questions,
            currentQuestionIndex: 0,
            answers,
          });
        } else {
          const isTextMode = inputType === "text" || inputType === "password";
          const hasOptions = !isTextMode && Array.isArray(options) && options.length > 0;
          const allOptions = hasOptions ? [...options, "Custom..."] : [];
          setPendingQuestion({ question, options: allOptions, resolve, inputType });
          setWizardOptions(allOptions);
          setWizardSelectedIndex(0);
          setWizardSelectedSet(initialCheckedIndices ? new Set(initialCheckedIndices) : new Set());
          setActiveWizard({
            type: "question",
            step: hasOptions ? 1 : 2,
            data: { question },
            isMultiSelect,
          });
        }
      });
    },
    []
  );
  const activeWizardRef = useRef(activeWizard);
  activeWizardRef.current = activeWizard;
  const pendingPermissionRef = useRef(pendingPermission);
  pendingPermissionRef.current = pendingPermission;
  const pendingQuestionRef = useRef(pendingQuestion);
  pendingQuestionRef.current = pendingQuestion;
  const isProcessingRef = useRef(isProcessing);
  isProcessingRef.current = isProcessing;

  useEffect(() => {
    registerQuestionHandler(questionHandler);
    const agent = new Agent(handleEvent, permissionHandler, questionHandler);
    agent.tier = "single";
    agentRef.current = agent;
    registerMasterAgent(agent);
    try {
      const initPath = agent.getCurrentHistoryFilePath();
      if (initPath) {
        setSessionId(path.basename(initPath, ".json"));
      }
    } catch {}

    // Register with extension server
    import("./server.js").then(({ registerCliAgent }) => {
      registerCliAgent(agent, process.cwd(), "single");
    }).catch(() => {});

    const handleSigint = () => {
      if (stopRunningSubagents() > 0) {
        agent.abort();
        setIsProcessing(false);
        setIsExecutingTool(false);
        setActiveToolName("");
        setActiveToolDesc("");
        setToolTimeout(null);
        setToolStartTime(null);
        setTimeLeft(null);
        return;
      }
      if (activeWizardRef.current || pendingPermissionRef.current || pendingQuestionRef.current) {
        return;
      }
      if (agent.isAgentRunning() || agent.wasRunningBeforeAbort || isProcessingRef.current) {
        agent.abort();
        setIsProcessing(false);
        setIsExecutingTool(false);
        setActiveToolName("");
        setActiveToolDesc("");
        setToolTimeout(null);
        setToolStartTime(null);
        setTimeLeft(null);
      } else {
        exit();
      }
    };
    process.on("SIGINT", handleSigint);

    agent.loadHistory(autoResume).then(() => {
      const sessionPath = agent.getCurrentHistoryFilePath();
      onSessionPath?.(sessionPath);
      if (sessionPath) {
        setSessionId(path.basename(sessionPath, ".json"));
      }
      const msgs = agent.getHistory().getMessages();
      const userInputs: string[] = [];
      for (const m of msgs) {
        if (m.role === "user") {
          const str = contentToString(m.content);
          if (!str.startsWith("[RMemory Agent Memory Context]:")) {
            userInputs.push(str);
          }
        }
      }
      if (autoResume) {
        setLines(reconstructChatLines(msgs));
      } else {
        agent.getHistory().clear();
      }
      setHistory(userInputs);

      if (initialPrompt && initialPrompt.trim()) {
        const prompt = initialPrompt.trim();
        setLines((prev) => [
          ...prev,
          {
            type: "user",
            content: `❯ ${prompt}`,
            timestamp: Date.now(),
          },
        ]);
        setIsProcessing(true);
         streamBufferRef.current = "";
         reasoningBufferRef.current = "";
         textStreamCleaner.reset();
         reasoningStreamCleaner.reset();
         setStreamDisplay("");
         setReasoningDisplay("");
        agent.sendMessage(prompt).then(() => {
          const nextState = agent.planState;
          setPlanState(nextState);
          if (nextState === "PLANNING_PENDING") {
            setActiveWizard((curr) => {
              if (curr && curr.type === "plan_approve") return curr;
              setWizardOptions([...PLAN_APPROVAL_OPTIONS]);
              setWizardSelectedIndex(0);
              return {
                type: "plan_approve",
                step: 1,
                data: {},
              };
            });
          }
        });
      }
    });

    return () => {
      process.off("SIGINT", handleSigint);
      registerQuestionHandler(null);
      registerMasterAgent(null);
    };
  }, [handleEvent, permissionHandler, questionHandler, exit, autoResume, initialPrompt, stopRunningSubagents, onSessionPath]);

  useEffect(() => {
    const hasMessages = agentRef.current ? agentRef.current.getHistory().getMessages().length > 0 : false;
    onHistoryChange?.(hasMessages);
  }, [lines, onHistoryChange]);

  useEffect(() => {
    const handleResize = () => {
      setTerminalHeight(process.stdout.rows || 30);
      setTerminalWidth(process.stdout.columns || 80);
    };
    process.stdout.on("resize", handleResize);
    return () => {
      process.stdout.off("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const fetchGitData = async () => {
      const targetCwd = agentRef.current?.workingDirectory || process.cwd();
      try {
        const [branchRes, worktreeRes] = await Promise.all([
          execa("git", ["branch", "--show-current"], { cwd: targetCwd, reject: false }).catch(() => ({ stdout: "" })),
          execa("git", ["worktree", "list"], { cwd: targetCwd, reject: false }).catch(() => ({ stdout: "" }))
        ]);

        if (!active) return;

        let branch = branchRes.stdout?.trim() || "";
        if (!branch) {
          const shaRes = await execa("git", ["rev-parse", "--short", "HEAD"], { cwd: targetCwd, reject: false }).catch(() => ({ stdout: "" }));
          branch = shaRes.stdout?.trim() || "";
        }
        setGitBranch(branch);

        if (worktreeRes.stdout) {
          const lines = worktreeRes.stdout.split("\n").filter(Boolean);
          setWorktreeCount(lines.length);
        } else {
          setWorktreeCount(0);
        }
      } catch {
        if (active) setWorktreeCount(0);
      }
    };
    fetchGitData();
    const interval = setInterval(fetchGitData, 10000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [workspacePath]);

  // Subscribe to lock status changes
  useEffect(() => {
    const updateLocks = () => {
      try {
        const stats = getLockStats(workspacePath);
        setActiveLocks(stats.totalActiveLocks);
      } catch (e) {
        // Ignore
      }
    };
    updateLocks();
    lockEventEmitter.on("lock_acquired", updateLocks);
    lockEventEmitter.on("lock_released", updateLocks);
    lockEventEmitter.on("lock_updated", updateLocks);
    lockEventEmitter.on("deadlock_recovered", updateLocks);
    return () => {
      lockEventEmitter.off("lock_acquired", updateLocks);
      lockEventEmitter.off("lock_released", updateLocks);
      lockEventEmitter.off("lock_updated", updateLocks);
      lockEventEmitter.off("deadlock_recovered", updateLocks);
    };
  }, [workspacePath]);

  // Subscribe to ContextManager compaction events so the user sees when
  // auto-compaction runs (previously silent). Re-subscribes when the agent
  // reference changes (multi-agent mode, mode switch, etc).
  useEffect(() => {
    const cm = agentRef.current?.getContextManager?.();
    if (!cm || typeof cm.on !== "function") return;

    const handleCompactionComplete = (payload: {
      strategy?: string;
      tokensBefore?: number;
      tokensAfter?: number;
      messagesBefore?: number;
      messagesAfter?: number;
      metadata?: Record<string, unknown>;
    }) => {
      const strategy = payload.strategy || "unknown";
      const before = payload.tokensBefore ?? 0;
      const after = payload.tokensAfter ?? 0;
      const saved = Math.max(0, before - after);
      const msgBefore = payload.messagesBefore ?? 0;
      const msgAfter = payload.messagesAfter ?? 0;
      const reducedPct = before > 0 ? Math.round((saved / before) * 100) : 0;
      const usedFallback = (payload.metadata as any)?.usedFallback === true;
      const usedLLM = (payload.metadata as any)?.usedLLM === true;
      const fallbackNote = usedFallback
        ? " (⚠️ heuristic fallback — lower quality, LLM unavailable)"
        : usedLLM
          ? ""
          : " (quality unknown)";
      addLine({
        type: "system",
        content: `🧹 Context auto-compacted via "${strategy}": ${msgBefore}→${msgAfter} messages, ${before.toLocaleString()}→${after.toLocaleString()} tokens (saved ${saved.toLocaleString()} / ${reducedPct}%)${fallbackNote}`,
        timestamp: Date.now(),
      });
    };

    const handleCompactionStart = (payload: { strategy?: string }) => {
      addLine({
        type: "system",
        content: `⚙️ Compacting context via "${payload.strategy || "selected"}" strategy…`,
        timestamp: Date.now(),
      });
    };

    cm.on("compaction:start", handleCompactionStart);
    cm.on("compaction:complete", handleCompactionComplete);
    return () => {
      if (typeof cm.off === "function") {
        cm.off("compaction:start", handleCompactionStart);
        cm.off("compaction:complete", handleCompactionComplete);
      }
    };
    // Re-subscribe when the underlying agent changes; re-resolve the CM each run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModel]);

  // Sync scroll offsets on list length change
  useEffect(() => {
    if (checklistScrollOffset >= checklistTasks.length && checklistTasks.length > 0) {
      setChecklistScrollOffset(Math.max(0, checklistTasks.length - maxChecklistVisible));
    }
  }, [checklistTasks.length, checklistScrollOffset]);

  useEffect(() => {
    const count = [...superagentInstances.values()].filter((s) => s.status === "running").length;
    if (superagentsScrollOffset >= count && count > 0) {
      setSuperagentsScrollOffset(Math.max(0, count - maxSuperagentsVisible));
    }
  }, [lines, superagentsScrollOffset]);

  useEffect(() => {
    const count = [...subagentInstances.values()].filter((s) => s.status === "running").length;
    if (subagentsScrollOffset >= count && count > 0) {
      setSubagentsScrollOffset(Math.max(0, count - maxSubagentsVisible));
    }
  }, [lines, subagentsScrollOffset]);

  useEffect(() => {
    const count = [...backgroundTasks.values()].filter((t) => !t.hasExited && !t.isHidden && isTaskInWorkspace(t.cwd, workspacePath)).length;
    if (procsScrollOffset >= count && count > 0) {
      setProcsScrollOffset(Math.max(0, count - maxProcsVisible));
    }
  }, [lines, procsScrollOffset, workspacePath]);

  // Sync background triggers/notifications
  useEffect(() => {
    const unsubTasks = subscribeToTasks(() => {
      const allTasks = Array.from(backgroundTasks.values());
      setRunningTasksCount(
        allTasks.filter((t) => !t.hasExited && !t.isHidden && isTaskInWorkspace(t.cwd, workspacePath)).length
      );
      let tasksChanged = false;
      allTasks.forEach((task) => {
        if (task.isDetachedWindow) return;
        if (task.hasExited && !(task as any).notified) {
          (task as any).notified = true;
          const msg = `⚙️ [BACKGROUND TASK NOTIFICATION]: Task ${task.id} ("${task.command}") has completed with exit code ${task.exitCode}!`;
          addLine({
            type: "system",
            content: msg,
            timestamp: Date.now()
          });

          if (task.notifyAgent && agentRef.current && !agentRef.current.isAgentRunning()) {
            setIsProcessing(true);
            addLine({
              type: "user",
              content: `❯ [SYSTEM TRIGGER] ${msg}`,
              timestamp: Date.now()
            });
            agentRef.current.sendMessage(msg).then(() => {
              if (agentRef.current) {
                setPlanState(agentRef.current.planState);
              }
            });
          }

          // Clean up completed headless tasks from the Map to prevent memory leaks
          backgroundTasks.delete(task.id);
          tasksChanged = true;
        }
      });
      if (tasksChanged) {
        notifyTasksChanged();
      }
    });

    const unsubSubagents = subscribeToSubagents(() => {
      setRunningSubagentsCount(
        Array.from(subagentInstances.values()).filter((s) => s.status === "running").length
      );
      const activeList = Array.from(subagentInstances.values());
      activeList.forEach((inst) => {
        if (inst.status === "completed" && inst.result && !(inst as any).notified) {
          (inst as any).notified = true;
          const msg = `🤖 [SUBAGENT NOTIFICATION]: Subagent ${inst.id} (${inst.role}) has completed!\nReport Summary:\n${inst.result}`;
          addLine({
            type: "system",
            content: msg,
            timestamp: Date.now()
          });

          if (agentRef.current && !agentRef.current.isAgentRunning()) {
            setIsProcessing(true);
            addLine({
              type: "user",
              content: `❯ [SYSTEM TRIGGER] ${msg}`,
              timestamp: Date.now()
            });
            agentRef.current.sendMessage(msg).then(() => {
              if (agentRef.current) {
                setPlanState(agentRef.current.planState);
              }
            });
          }
        }
      });
    });

    const unsubSuperagents = subscribeToSuperagents(() => {
      setRunningSuperagentsCount(
        Array.from(superagentInstances.values()).filter((s) => s.status === "running").length
      );
      const activeList = Array.from(superagentInstances.values());
      activeList.forEach((inst) => {
        if (inst.status === "completed" && inst.result && !(inst as any).notified) {
          (inst as any).notified = true;
          const msg = `⚡ [SUPERAGENT NOTIFICATION]: Superagent ${inst.id} (${inst.role}) has completed!\nReport Summary:\n${inst.result}`;
          addLine({
            type: "system",
            content: msg,
            timestamp: Date.now()
          });

          if (agentRef.current && !agentRef.current.isAgentRunning()) {
            setIsProcessing(true);
            addLine({
              type: "user",
              content: `❯ [SYSTEM TRIGGER] ${msg}`,
              timestamp: Date.now()
            });
            agentRef.current.sendMessage(msg).then(() => {
              if (agentRef.current) {
                setPlanState(agentRef.current.planState);
              }
            });
          }
        }
      });
    });

    const unsubSchedules = subscribeToSchedules((jobId, prompt) => {
      const msg = `⏳ [SCHEDULE NOTIFICATION]: Schedule job ${jobId} triggered! Prompt: ${prompt}`;
      addLine({
        type: "system",
        content: msg,
        timestamp: Date.now()
      });

      if (agentRef.current && !agentRef.current.isAgentRunning()) {
        setIsProcessing(true);
        addLine({
          type: "user",
          content: `❯ [SYSTEM TRIGGER] ${msg}`,
          timestamp: Date.now()
        });
        agentRef.current.sendMessage(msg).then(() => {
          if (agentRef.current) {
            setPlanState(agentRef.current.planState);
          }
        });
      }
    });

    return () => {
      unsubTasks();
      unsubSubagents();
      unsubSuperagents();
      unsubSchedules();
    };
  }, [addLine, workspacePath]);

  // Setup layouts & heights calculation
  const messageCount = lines.filter((l) => l.type === "user" || l.type === "assistant").length;
  // Use the same tiktoken-backed estimator as the rest of the context
  // accounting, so the Ctx:% bar doesn't drift from the actual API usage
  // Live streaming updates every 40ms; use lightweight heuristic (chars / 4)
  // instead of invoking Tiktoken WASM encoding 25x/sec, which allocates
  // native string buffers and causes GC thrashing during active responses.
  const liveStreamTokens = useMemo(() => {
    if (!streamDisplay) return 0;
    return Math.ceil(streamDisplay.length / 4);
  }, [streamDisplay]);
  
  // Use ContextManager's TokenTracker for accurate context usage if available
  const historyMessages = agentRef.current?.getHistory ? agentRef.current.getHistory().getMessages() : [];
  const tokenRecountKey = getContextRecountKey(historyMessages);
  const baseContextUsage = useMemo(() => {
    const cm = agentRef.current?.getContextManager?.();
    if (cm && agentRef.current) {
      try {
        const breakdown = cm.estimateTokensForAll(agentRef.current.getHistory().getMessages());
        return breakdown.total;
      } catch {
        return null;
      }
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenRecountKey]);
  let activeContextUsage = 0;
  if (baseContextUsage !== null) {
    activeContextUsage = baseContextUsage + liveStreamTokens;
  } else if (lastPromptTokens > 0) {
    activeContextUsage = lastPromptTokens + liveStreamTokens;
  }
  
  const contextPercentage = parseFloat(contextLimit > 0 ? ((activeContextUsage / contextLimit) * 100).toFixed(2) : "0.00");
  const lastUserLine = [...lines].reverse().find((l) => l.type === "user");
  const lastUserPrompt = lastUserLine ? lastUserLine.content.replace(/^❯ /, "").replace(/\n/g, " ") : "";
  const displayPrompt = lastUserPrompt.length > 50 ? lastUserPrompt.slice(0, 47) + "..." : lastUserPrompt;

  const planPath = agentRef.current ? agentRef.current.getPlanFilePath() : path.join(process.cwd(), "implementation_plan.md");
  const planUrl = `file:///${path.resolve(planPath).replace(/\\/g, "/")}`;

  const estimateMarkdownLines = (text: string, width: number): number => {
    let count = 0;
    const rawLines = text.split("\n");
    for (const l of rawLines) {
      count += Math.max(1, Math.ceil(l.length / width));
    }
    return count;
  };

  // Determine if current wizard step is a pure selection step (no text input needed)
  const isSelectionOnlyStep = (() => {
    if (!activeWizard) return false;
    if (activeWizard.type === "permission") return true;
    if (activeWizard.type === "plan_approve") return activeWizard.step !== 2;
    if (activeWizard.type === "resume") return true;
    if (activeWizard.type === "checkpoint") return true;
    if (activeWizard.type === "skills") return activeWizard.step !== 1;
    if (activeWizard.type === "question" && activeWizard.step !== 2) return true;
    if (activeWizard.type === "login") {
      // Steps 1,2,6,7,10,15 = pure selection; Step 8,14 = selection with search filter (needs input)
      return [1, 2, 6, 7, 10, 15].includes(activeWizard.step);
    }
    if (activeWizard.type === "model") {
      // Steps 15,24,34 = model search/filter (needs input); others with options are pure selection
      return [1, 2, 22, 23, 32, 33, 41, 50, 60, 61, 62].includes(activeWizard.step);
    }
    return false;
  })();

  // Account for input history panel height
  let historySectionHeight = 0;
  if (focusMode === "history") {
    const uniqueHistory = Array.from(new Set(history));
    if (uniqueHistory.length === 0) {
      historySectionHeight = 3;
    } else {
      const total = uniqueHistory.length;
      const maxVisible = 10;
      const half = Math.floor(maxVisible / 2);
      let startIdx = Math.max(0, historySelectedIndex - half);
      let endIdx = Math.min(total, startIdx + maxVisible);
      startIdx = Math.max(0, endIdx - maxVisible);
      const visibleCount = endIdx - startIdx;
      const hiddenAbove = startIdx;
      const hiddenBelow = total - endIdx;
      historySectionHeight = 2 + visibleCount;
      if (hiddenAbove > 0) historySectionHeight += 1;
      if (hiddenBelow > 0) historySectionHeight += 1;
    }
  }

  // --- Calculate section boundaries for mouse click detection ---
  // Layout from bottom: StatusBar(1) + margin(1) + bottomChrome(content + margin) + ChatArea
  const statusBarTotalRows = 2; // 1 content + 1 marginTop
  const mainContentHeight = terminalHeight - statusBarTotalRows;

  // Agent section heights (for boundary calc)
  let saSectionHeight = 0;
  let subSectionHeight = 0;
  let procSectionHeight = 0;
  if (runningSuperagentsCount > 0) {
    saSectionHeight = collapsedSections.superagents
      ? 1
      : 1 + Math.min(runningSuperagentsCount, maxSuperagentsVisible) * 3;
  }
  if (runningSubagentsCount > 0) {
    subSectionHeight = collapsedSections.subagents
      ? 1
      : 1 + Math.min(runningSubagentsCount, maxSubagentsVisible);
  }
  if (runningTasksCount > 0) {
    procSectionHeight = collapsedSections.procs
      ? 1
      : 1 + Math.min(runningTasksCount, maxProcsVisible);
  }
  const totalAgentsHeight = saSectionHeight + subSectionHeight + procSectionHeight;

  const inputLinesCount = input ? Math.max(1, Math.ceil((input.length + 6) / terminalWidth)) : 1;
  const activeToolLinesCount = activeToolOutput ? activeToolOutput.trim().split("\n").slice(-8).length : 0;
  const showBanner = messageCount === 0;

  // Checklist height — the ACTIVE TASK CHECKLIST is always expanded, so
  // we no longer honor collapsedSections.checklist when computing height.
  let checklistSectionHeight = 0;
  if (planState === "APPROVED" && checklistTasks.length > 0) {
    checklistSectionHeight = 1 + Math.min(checklistTasks.length, maxChecklistVisible);
  }
  // Account for completed history section height
  if (planState === "APPROVED" && completedHistory.length > 0) {
    const historyVisible = Math.min(completedHistory.length, 3);
    checklistSectionHeight += 1 + historyVisible + (completedHistory.length > 3 ? 1 : 0);
  }

  // Wizard/suggestions height
  let wizardSectionHeight = 0;
  if (activeWizard) {
    if (activeWizard.type === "plan_approve") {
      const planPath = agentRef.current?.getPlanFilePath() || "";
      wizardSectionHeight = planApprovalChromeHeight(planPath, activeWizard.step);
    } else {
      wizardSectionHeight += 3;
      if (activeWizard.type === "login") {
        if (activeWizard.step === 1 || activeWizard.step === 2) wizardSectionHeight += 8;
        else if (activeWizard.step === 10) wizardSectionHeight += 8 + Math.min(6, wizardOptions.length);
        else if ([3,4,6,11,12,13].includes(activeWizard.step)) wizardSectionHeight += 6;
      } else if (activeWizard.type === "model") {
        wizardSectionHeight += wizardOptions.length > 0 ? 13 : 6;
      } else if (activeWizard.type === "permission") {
        wizardSectionHeight += 9;
      } else if (activeWizard.type === "question") {
        wizardSectionHeight += 8 + Math.min(6, wizardOptions.length);
      }
    }
  } else if ((input.startsWith("/") || input.startsWith("!")) && suggestions.length > 0) {
    wizardSectionHeight += 2;
  }

  // Input section height (border line + input text lines + optional wizard question) — hidden for selection-only wizard steps
  let inputSectionHeight = isSelectionOnlyStep ? 0 : 1 + inputLinesCount;
  if (!isSelectionOnlyStep && getWizardQuestion()) {
    inputSectionHeight += 2; // 1 question line + 1 marginBottom line
  }

  // Banner: marginY(1) + inner_row(4) + marginY(1) = 6 rows; +1 header row → content starts at row 8
  // No git warning adds ~2 extra rows (marginY(1) + 1 content row)
  const bannerHeight = showBanner ? (gitBranch ? 6 : 8) : 0;
  const chatContentStartRow = bannerHeight + 1 /* header */ + 1 /* first content row */;

  // Bottom chrome: marginTop(1) + agents + checklist + history + wizard + input
  const bottomChromeContentHeight = totalAgentsHeight + checklistSectionHeight + historySectionHeight + wizardSectionHeight + inputSectionHeight;
  const bottomChromeTotalHeight = 1 + bottomChromeContentHeight; // +1 for marginTop of the chrome box

  // Chat area height on screen
  const chatAreaScreenHeight = mainContentHeight - bottomChromeTotalHeight;

  // Exact height limit for the scrollable chat messages to prevent any empty terminal gap
  const chatHeightLimit = Math.max(5, chatAreaScreenHeight - bannerHeight - 1);

  // Build section boundaries (row numbers 1-indexed from top)
  const sectionBounds: SectionBoundary[] = [];

  // Chat area
  sectionBounds.push({ name: "chat", startRow: 1, endRow: Math.max(1, chatAreaScreenHeight) });

  // Bottom chrome content starts after chat area + margin
  let row = chatAreaScreenHeight + 2; // +1 for margin, +1 to start at first content row

  // Agents (from top: superagents → subagents → procs)
  if (saSectionHeight > 0) {
    sectionBounds.push({ name: "superagents_header", startRow: row, endRow: row, isHeader: true });
    sectionBounds.push({ name: "superagents", startRow: row, endRow: row + saSectionHeight - 1 });
    row += saSectionHeight;
  }
  if (subSectionHeight > 0) {
    sectionBounds.push({ name: "subagents_header", startRow: row, endRow: row, isHeader: true });
    sectionBounds.push({ name: "subagents", startRow: row, endRow: row + subSectionHeight - 1 });
    row += subSectionHeight;
  }
  if (procSectionHeight > 0) {
    sectionBounds.push({ name: "procs_header", startRow: row, endRow: row, isHeader: true });
    sectionBounds.push({ name: "procs", startRow: row, endRow: row + procSectionHeight - 1 });
    row += procSectionHeight;
  }

  // Checklist
  if (checklistSectionHeight > 0) {
    sectionBounds.push({ name: "checklist_header", startRow: row, endRow: row, isHeader: true });
    sectionBounds.push({ name: "checklist", startRow: row, endRow: row + checklistSectionHeight - 1 });
    row += checklistSectionHeight;
  }

  // Input History Panel
  if (historySectionHeight > 0) {
    sectionBounds.push({ name: "history", startRow: row, endRow: row + historySectionHeight - 1 });
    row += historySectionHeight;
  }

  // Wizard/suggestions
  if (wizardSectionHeight > 0) {
    sectionBounds.push({ name: "wizard", startRow: row, endRow: row + wizardSectionHeight - 1 });
    row += wizardSectionHeight;
  }

  // Input
  if (inputSectionHeight > 0) {
    sectionBounds.push({ name: "input", startRow: row, endRow: row + inputSectionHeight - 1 });
    row += inputSectionHeight;
  }

  // Status bar
  sectionBounds.push({ name: "statusbar", startRow: terminalHeight - 1, endRow: terminalHeight });

  // Focused response scroll metrics
  const focusRespWidth = Math.max(20, terminalWidth - 6);
  const focusRespMaxLines = Math.max(8, Math.min(18, Math.floor(terminalHeight * 0.45)));
  const focusWindowHeight = Math.max(5, chatHeightLimit - 3);
  let responseLinesCount = 0;
  if (focusedResponseIndex !== null && lines[focusedResponseIndex]?.type === "assistant") {
    responseLinesCount = wrapTextForDisplay(lines[focusedResponseIndex].content, focusRespWidth).length;
  }

  const wrappedLines = useMemo(() => {
    return computeWrappedLines({
      lines,
      chatWidth: Math.max(20, terminalWidth - 6),
      maxAssistantResponseLines: 12,
      expandedLines,
      expandedChildren,
      expandedThinking,
      tokensUp,
      tokensDown,
      modelName: activeModel,
      isProcessing,
      streamDisplay,
      reasoningDisplay,
      isExecutingTool,
      activeToolOutput,
      timeLeft,
      formatCompactNumber,
      activeToolName,
      activeToolDesc,
    });
  }, [
    lines,
    terminalWidth,
    expandedLines,
    expandedChildren,
    expandedThinking,
    tokensUp,
    tokensDown,
    activeModel,
    isProcessing,
    streamDisplay,
    reasoningDisplay,
    isExecutingTool,
    activeToolOutput,
    timeLeft,
    activeToolName,
    activeToolDesc,
  ]);

  wrappedLinesLengthRef.current = wrappedLines.length;
  chatHeightLimitRef.current = chatHeightLimit;

  useEffect(() => {
    const prevLength = lastWrappedLinesLengthRef.current;
    const newLength = wrappedLines.length;
    lastWrappedLinesLengthRef.current = newLength;

    if (scrollOffset > 0 && newLength > prevLength) {
      setScrollOffset((prev) => prev + (newLength - prevLength));
    }
  }, [wrappedLines.length]);

  // Automatically return focus mode to input when user scrolls back to the bottom
  useEffect(() => {
    if (scrollOffset === 0 && focusMode === "chat") {
      setFocusMode("input");
    }
  }, [scrollOffset, focusMode]);

  const handleWizardHeaderRowsChange = useCallback((internalRows: number) => {
    let containerOffset = 1;
    if (activeWizard && activeWizard.type !== "permission") {
      containerOffset = 2;
      if (activeWizard.type === "question" && activeWizard.questions && activeWizard.currentQuestionIndex !== undefined) {
        containerOffset = 4;
      }
    }
    setWizardHeaderRows(containerOffset + internalRows);
  }, [activeWizard]);

  // Update mouse context ref (read by mouse handler on each event)
  mouseCtxRef.current = {
    scrollChat,
    terminalHeight,
    focusMode,
    setFocusMode,
    setScrollOffset,
    activeWizard,
    setActiveWizard,
    wizardOptions,
    wizardSelectedIndex,
    setWizardSelectedIndex,
    planPath,
    focusedResponseIndex,
    setFocusedResponseIndex,
    setFocusedResponseOffset,
    focusWindowHeight,
    responseLinesCount,
    sections: sectionBounds,
    setSuperagentsScrollOffset,
    setSubagentsScrollOffset,
    setProcsScrollOffset,
    setChecklistScrollOffset,
    runningSuperagentsCount,
    runningSubagentsCount,
    runningTasksCount,
    checklistTasksCount: checklistTasks.length,
    maxSuperagentsVisible,
    maxSubagentsVisible,
    maxProcsVisible,
    maxChecklistVisible,
    toggleCollapse,
    toggleChildExpand,
    openResponseAtIndex,
    visibleLinePositions,
    toggleLineExpand,
    toggleThinkingExpand,
    handleWizardSubmit,
    history,
    historySelectedIndex,
    setHistorySelectedIndex,
    wizardHeaderRows,
    onInputClick: (x: number, y: number) => {
      if (isSelectionOnlyStep) return;
      const clickedSection = sectionBounds.find((s) => s.name === "input");
      if (!clickedSection) return;

      const rowOffset = y - (clickedSection.endRow - inputLinesCount + 1);
      const colOffset = Math.max(0, x - 5);
      const clickedIndex = rowOffset * (terminalWidth - 4) + colOffset;
      const clampedIndex = Math.max(0, Math.min(clickedIndex, input.length));
      chatTextInputRef.current?.setCursorOffset(clampedIndex);
    },
  };

  const activeChainId = getActiveChainId(workspacePath);
  const activeChain = activeChainId ? getWorkspaceChain(activeChainId, workspacePath) : null;
  const primaryChainNode = activeChain ? activeChain.nodes.find((n) => n.id === activeChain.primaryNodeId || n.role === "main") : null;
  const primaryWorkspacePath = primaryChainNode?.path || workspacePath;

  return (
    <Box flexDirection="column" height={terminalHeight}>
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" width="100%" flexGrow={1}>
          
          {/* Render Chat & Logs */}
          <ChatArea
            showBanner={showBanner}
            classifierStatus={classifierStatus}
            embeddingStatus={embeddingStatus}
            workspacePath={workspacePath}
            primaryWorkspacePath={primaryWorkspacePath}
            sessionId={sessionId}
            focusMode={focusMode}
            scrollOffset={scrollOffset}
            focusedResponseIndex={focusedResponseIndex}
            setFocusedResponseIndex={setFocusedResponseIndex}
            focusedResponseOffset={focusedResponseOffset}
            setFocusedResponseOffset={setFocusedResponseOffset}
            lines={lines}
            chatHeightLimit={chatHeightLimit}
            terminalHeight={terminalHeight}
            terminalWidth={terminalWidth}
            isProcessing={isProcessing}
            streamDisplay={streamDisplay}
            reasoningDisplay={reasoningDisplay}
            tokensUp={tokensUp}
            tokensDown={tokensDown}
            liveStreamTokens={liveStreamTokens}
            modelName={activeModel}
            maxAssistantResponseLines={12}
            isExecutingTool={isExecutingTool}
            timeLeft={timeLeft}
            activeToolOutput={activeToolOutput}
            formatCompactNumber={formatCompactNumber}
            onVisibleLinesChange={setVisibleLinePositions}
            chatContentStartRow={chatContentStartRow}
            expandedLines={expandedLines}
            toggleLineExpand={toggleLineExpand}
            expandedChildren={expandedChildren}
            toggleChildExpand={toggleChildExpand}
            expandedThinking={expandedThinking}
            toggleThinkingExpand={toggleThinkingExpand}
            wrappedLines={wrappedLines}
            activeToolName={activeToolName}
            activeToolDesc={activeToolDesc}
          />

          {/* Active Agents, Tasks checklists & Wizard dialogs */}
          <Box flexDirection="column" paddingX={1} marginTop={1} flexShrink={0}>
            <ActiveAgentsList
              focusMode={focusMode}
              runningSuperagentsCount={runningSuperagentsCount}
              runningSubagentsCount={runningSubagentsCount}
              runningTasksCount={runningTasksCount}
              superagentsScrollOffset={superagentsScrollOffset}
              subagentsScrollOffset={subagentsScrollOffset}
              procsScrollOffset={procsScrollOffset}
              maxSuperagentsVisible={maxSuperagentsVisible}
              maxSubagentsVisible={maxSubagentsVisible}
              maxProcsVisible={maxProcsVisible}
              collapsedSections={collapsedSections}
              workspace={workspacePath}
              procsSelectedIndex={procsSelectedIndex}
            />

            <TaskChecklist
              planState={planState}
              checklistTasks={checklistTasks}
              checklistScrollOffset={checklistScrollOffset}
              maxChecklistVisible={maxChecklistVisible}
              focusMode={focusMode}
              isMultiAgent={!!agentRef.current?.isMultiAgent}
              completedHistory={completedHistory}
              maxHistoryVisible={maxHistoryVisible}
              collapsedSections={collapsedSections}
            />

            {/* Input History Panel — shown when Ctrl+H is pressed */}
            <HistoryPanel
              history={history}
              historySelectedIndex={historySelectedIndex}
              focusMode={focusMode}
            />

            <WizardHeaderRowsContext.Provider value={handleWizardHeaderRowsChange}>
              <WizardPanels
                activeWizard={activeWizard}
                wizardOptions={wizardOptions}
                wizardSelectedIndex={wizardSelectedIndex}
                wizardSelectedSet={wizardSelectedSet}
                pendingPermission={pendingPermission}
                pendingQuestion={pendingQuestion}
                planState={planState}
                planUrl={planUrl}
                planFilePath={planPath}
                input={input}
                wizardIsLoadingModels={wizardIsLoadingModels}
                checkpointsList={checkpointsList}
                goalMode={goalMode}
                suggestions={suggestions}
                focus={(activeWizard?.data?.focus as "plan" | "actions") || "actions"}
                scrollOffset={parseInt(activeWizard?.data?.scrollOffset || "0", 10)}
                onScrollChange={(offset) => setActiveWizard((curr: any) => curr ? { ...curr, data: { ...curr.data, scrollOffset: String(offset) } } : null)}
              />
            </WizardHeaderRowsContext.Provider>

            {/* MessageSubmitDialog — shown when the user submits a new message
                while the AI is still processing. Offers Queue / Insert / Back. */}
            {pendingSubmitMessage && (
              <MessageSubmitDialog
                messagePreview={pendingSubmitMessage.text}
                attachmentCount={pendingSubmitMessage.attachments.length}
                queuedCount={
                  (agentRef.current as any)?.pendingMessagesQueue?.length ?? 0
                }
                onChoose={handleMessageSubmitChoice}
              />
            )}

            {/* CommandLine Input — hidden for selection-only wizard steps */}
            {!isSelectionOnlyStep && (
            <Box flexDirection="column">
              {(() => {
                const question = getWizardQuestion();
                if (!question) return null;
                return (
                  <Box flexDirection="row" marginBottom={1}>
                    <Text color={activeWizard ? getWizardBorderColor(activeWizard) : "gray"}>│ </Text>
                    <Text color="cyan" wrap="truncate-end">{question}</Text>
                  </Box>
                );
              })()}
              <Text color={scrollOffset > 0 ? "yellow" : activeWizard ? getWizardBorderColor(activeWizard) : isProcessing ? "gray" : "gray"}>
                └───[ <Text bold color={scrollOffset > 0 ? "yellow" : activeWizard ? getWizardBorderColor(activeWizard) : isProcessing ? "gray" : "gray"}>
                  {activeWizard ? `⚙️ WIZARD: ${activeWizard.type.toUpperCase()} (Step ${activeWizard.step})` : "⌨️ COMM_LINK: ACTIVE"}
                </Text> ]
                {isProcessing && displayPrompt && (
                  <Text color="cyan" bold> ─── [ PROMPT: "{displayPrompt}" ]</Text>
                )}
              </Text>
              <Box flexDirection="row">
                <Text color={activeWizard ? getWizardBorderColor(activeWizard) : isProcessing ? "gray" : "gray"}>│ ❯ </Text>
                <Box flexDirection="column" flexGrow={1}>
                  {attachments.length > 0 && (
                    <ImageAttachmentBar
                      attachments={attachments}
                      onRemove={handleRemoveAttachment}
                      focused={focusMode === "input"}
                    />
                  )}
                  <ChatTextInput
                    ref={chatTextInputRef}
                    focus={focusMode === "input" && !pendingSubmitMessage}
                    value={input}
                    onChange={handleInputChange}
                    onSubmit={pendingSubmitMessage ? () => {} : handleSubmit}
                    placeholder={getWizardPlaceholder()}
                    onAttachImage={handleAttachImage}
                    onPasteImage={handlePasteImage}
                    onRemoveLastAttachment={handleRemoveLastAttachment}
                    attachmentCount={attachments.length}
                    immediate={!!activeWizard}
                    isPasted={isPasted}
                    pastePrefixLength={pastePrefixLength}
                    pasteSuffixLength={pasteSuffixLength}
                    mask={pendingQuestion?.inputType === "password" ? "•" : undefined}
                  />
                </Box>
              </Box>
            </Box>
            )}

          </Box>
        </Box>
      </Box>

      {/* Render Status Bar */}
      <StatusBar
        modelName={activeModel}
        presetName={activePresetName}
        contextPercentage={contextPercentage}
        tokensUp={tokensUp}
        tokensDown={tokensDown}
        liveStreamTokens={liveStreamTokens}
        activeContextUsage={activeContextUsage}
        contextLimit={contextLimit}
        messageCount={messageCount}
        runningTasksCount={runningTasksCount}
        runningSubagentsCount={runningSubagentsCount}
        gitBranch={gitBranch}
        worktreeCount={worktreeCount}
        lastSpeed={lastSpeed}
        formatCompactNumber={formatCompactNumber}
        rmemoryStatus={rmemoryStatus}
        activeDevHook={activeDevHook}
        workspace={workspacePath}
        isProcessing={isProcessing}
        activeChainName={activeChain?.name || null}
        activeChainNodeCount={activeChain?.nodes.length}
        activeLocks={activeLocks}
      />
    </Box>
  );
}
