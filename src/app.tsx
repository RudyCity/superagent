import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Box, Text, useApp } from "ink";
import ChatTextInput from "./components/ChatTextInput.js";
import { Agent } from "./core/agent.js";
import type { AgentEvent, PermissionHandler, QuestionHandler, QuestionItem } from "./core/agent.js";
import type { ToolCall } from "./core/conversation.js";
import { getContextWindowLimit, getInstalledSkills, getConfiguredProviders, switchActiveProvider, fetchAndCacheModels, getRootConfigDir, getEffectiveMasterModel, getSettings } from "./core/config.js";
import { type MessageContent, contentToString } from "./core/conversation.js";
import ImageAttachmentBar from "./components/ImageAttachmentBar.js";
import {
  readImageFromPath,
  readImageFromClipboard,
  attachmentToImagePart,
  type ImageAttachment,
} from "./utils/imageUtils.js";
import fs from "fs/promises";
import fsSync from "fs";
import { handleSlashCommand, getDefaultModel } from "./core/slash-commands.js";
import { registry } from "./core/commands/registry.js";
import { createCheckpoint, terminateActiveTasksAndSubagents } from "./core/checkpoints.js";
import { getToolDescription } from "./core/permissions.js";
import path from "path";
import { backgroundTasks, subagentInstances, superagentInstances, subscribeToTasks, subscribeToSubagents, subscribeToSuperagents, subscribeToSchedules, subscribeToActiveOutput, registerQuestionHandler, registerMasterAgent, notifyTasksChanged } from "./core/tools.js";
import { ProcessingIndicator } from "./components/common/LoadingIndicators.js";
import { ActiveAgentsList } from "./components/active-agents-list.js";
import { TaskChecklist } from "./components/task-checklist.js";
import { HistoryPanel } from "./components/history-panel.js";
import { execa } from "execa";
import { resolveCarriageReturns, formatArgs, formatCompactNumber, filterSuggestions, getInsertion, getPasteSplit, stripSgrMouseSequences } from "./utils/text.js";
import { reconstructChatLines } from "./utils/uiHelpers.js";
import { getTruncatedAssistantIndexes } from "./utils/responseScroll.js";
import { wrapTextForDisplay } from "./utils/responseScroll.js";
import type { ChatLine } from "./core/slash-commands.js";
import { readChecklistTasks, readTaskHistory } from "./core/taskChecklist.js";

// Hook & Component Baru
import { StatusBar } from "./components/status-bar.js";
import { WizardPanels } from "./components/wizard-panels.js";
import { PLAN_APPROVAL_OPTIONS, planApprovalChromeHeight } from "./components/plan-approval-dialog.js";
import { ChatArea, computeWrappedLines } from "./components/chat-area.js";
import { useWizardSubmit } from "./hooks/useWizardSubmit.js";
import { useKeyboardHandler } from "./hooks/useKeyboardHandler.js";
import { useMouseScroll, type SectionBoundary, type ChatLinePosition } from "./hooks/useMouseScroll.js";
import { useTencentdbStatus } from "./hooks/useTencentdbStatus.js";

export { stripSgrMouseSequences } from "./utils/text.js";

function getWizardBorderColor(activeWizard: any): "yellow" | "cyan" | "blue" | "green" | "red" {
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
      return activeWizard.step === 2 ? "yellow" : "green";
    case "login":
      return activeWizard.step === 13 ? "blue" : "cyan";
    case "model":
      return activeWizard.step === 41 ? "red" : "cyan";
    default:
      return "cyan";
  }
}

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
  const setLines = useCallback((val: ChatLine[] | ((prev: ChatLine[]) => ChatLine[])) => {
    _setLines((prev) => {
      const next = typeof val === "function" ? val(prev) : val;
      if (next.length > 1000) {
        return next.slice(-1000);
      }
      return next;
    });
  }, []);
  const [input, setInput] = useState("");
  const [isPasted, setIsPasted] = useState(false);
  const [pastePrefixLength, setPastePrefixLength] = useState(0);
  const [pasteSuffixLength, setPasteSuffixLength] = useState(0);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isExecutingTool, setIsExecutingTool] = useState(false);
  const [streamDisplay, setStreamDisplay] = useState("");
  
  const [pendingPermission, setPendingPermission] = useState<{
    toolCall: ToolCall;
    description: string;
    resolve: (value: boolean | "session") => void;
  } | null>(null);

  const [pendingQuestion, setPendingQuestion] = useState<{
    question: string;
    options: string[];
    resolve: (value: any) => void;
  } | null>(null);

  const [lastTabPrefix, setLastTabPrefix] = useState<string | null>(null);
  const [tokensUp, setTokensUp] = useState(0);
  const [tokensDown, setTokensDown] = useState(0);
  const [lastPromptTokens, setLastPromptTokens] = useState(0);
  const [lastSpeed, setLastSpeed] = useState<number | null>(null);
  const [contextLimit, setContextLimit] = useState(256000);
  
  const streamBufferRef = useRef("");
  const lastStreamUpdateRef = useRef<number>(0);
  const streamTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [tempInput, setTempInput] = useState("");
  const agentRef = useRef<Agent | null>(null);

  // Persist input history to disk so it survives restarts
  const INPUT_HISTORY_FILE = path.join(getRootConfigDir(), "input-history.json");
  useEffect(() => {
    fs.readFile(INPUT_HISTORY_FILE, "utf8").then((raw) => {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setHistory(parsed);
      }
    }).catch(() => { /* first run or corrupt file — start fresh */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  
  const [scrollOffset, setScrollOffset] = useState(0);
  const [focusedResponseIndex, setFocusedResponseIndex] = useState<number | null>(null);
  const [focusedResponseOffset, setFocusedResponseOffset] = useState(0);
  
  const wrappedLinesLengthRef = useRef(0);
  const chatHeightLimitRef = useRef(15);
  
  const [runningTasksCount, setRunningTasksCount] = useState(0);
  const [runningSubagentsCount, setRunningSubagentsCount] = useState(0);
  const [runningSuperagentsCount, setRunningSuperagentsCount] = useState(0);
  
  const [goalMode, setGoalMode] = useState<{ goal: string; startedAt: number } | null>(null);
  const tencentdbStatus = useTencentdbStatus();
  const [toolTimeout, setToolTimeout] = useState<number | null>(null);
  const [toolStartTime, setToolStartTime] = useState<number | null>(null);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);

  const [activeWizard, setActiveWizard] = useState<{
    type: "login" | "model" | "plan_approve" | "permission" | "question" | "resume" | "goal" | "checkpoint" | "skills" | "exit_confirm";
    step: number;
    data: Record<string, string>;
    isMultiSelect?: boolean;
    questions?: QuestionItem[];
    currentQuestionIndex?: number;
    answers?: string[];
  } | null>(null);

  const [wizardSelectedSet, setWizardSelectedSet] = useState<Set<number>>(new Set());
  const [checkpointsList, setCheckpointsList] = useState<any[]>([]);
  const [wizardSelectedIndex, setWizardSelectedIndex] = useState(0);
  const [wizardOptions, setWizardOptions] = useState<string[]>([]);
  const [wizardIsLoadingModels, setWizardIsLoadingModels] = useState(false);
  const [planState, setPlanState] = useState<"IDLE" | "PLANNING_PENDING" | "APPROVED">("IDLE");
  const [activeModel, setActiveModel] = useState(() => getEffectiveMasterModel("single") || getDefaultModel());
  const [checklistTasks, setChecklistTasks] = useState<{ status: string; text: string }[]>([]);
  const [completedHistory, setCompletedHistory] = useState<{ status: string; text: string; remainingSeconds?: number }[]>([]);
  const [rawCompletedHistory, setRawCompletedHistory] = useState<{ status: string; text: string }[]>([]);
  const historyTimestampsRef = useRef<Map<string, number>>(new Map());
  const [focusMode, setFocusMode] = useState<"input" | "history" | "checklist" | "superagents" | "subagents" | "procs" | "chat">("input");

  // Automatically focus the input area when any wizard is active
  useEffect(() => {
    if (activeWizard) {
      setFocusMode("input");
    }
  }, [activeWizard]);

  const [historySelectedIndex, setHistorySelectedIndex] = useState<number>(0);

  const [checklistScrollOffset, setChecklistScrollOffset] = useState(0);
  const [superagentsScrollOffset, setSuperagentsScrollOffset] = useState(0);
  const [subagentsScrollOffset, setSubagentsScrollOffset] = useState(0);
  const [procsScrollOffset, setProcsScrollOffset] = useState(0);

  // Collapsible sections state
  const [collapsedSections, setCollapsedSections] = useState({
    superagents: false,
    subagents: false,
    procs: false,
  });

  // Visible line positions for mouse click detection
  const [visibleLinePositions, setVisibleLinePositions] = useState<
    Array<{ index: number; startRow: number; endRow: number; isTruncated: boolean; type: string; isCollapsible?: boolean; parentIndex?: number; childIndex?: number }>
  >([]);

  // Collapsible chat lines state (tool_start, tool_end, system, error)
  const [expandedLines, setExpandedLines] = useState<Set<number>>(new Set());
  // Expanded children: Map<parentLineIndex, Set<childIndex>>
  const [expandedChildren, setExpandedChildren] = useState<Map<number, Set<number>>>(new Map());


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

  const maxChecklistVisible = 3;
  const maxSuperagentsVisible = 2;
  const maxSubagentsVisible = 3;
  const maxProcsVisible = 3;

  const [terminalHeight, setTerminalHeight] = useState(process.stdout.rows || 30);
  const [terminalWidth, setTerminalWidth] = useState(process.stdout.columns || 80);
  const [gitBranch, setGitBranch] = useState<string>("");
  const [worktreeCount, setWorktreeCount] = useState<number>(0);

  const addLine = useCallback((line: ChatLine) => {
    setLines((prev) => [...prev, line]);
  }, []);

  /** Append a tool-related line (tool_start/tool_end) as a child of the last assistant message */
  const addToolChild = useCallback((child: ChatLine) => {
    setLines((prev) => {
      // Find the last assistant line
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].type === "assistant") {
          const updated = [...prev];
          const parent = { ...updated[i] };
          parent.children = [...(parent.children || []), child];
          updated[i] = parent;
          return updated;
        }
      }
      // Fallback: no assistant line found, add as top-level
      return [...prev, child];
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
    const content = streamBufferRef.current.trim();
    if (content) {
      addLine({
        type: "assistant",
        content,
        timestamp: Date.now(),
      });
    }
    streamBufferRef.current = "";
    setStreamDisplay("");
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
  });

  const handleSubmit = useCallback(
    async (value: string) => {
      if (isProcessing && !activeWizard) return;

      const trimmed = value.trim();

      if (activeWizard) {
        setInput("");
        setIsPasted(false);
        setLastTabPrefix(null);
        setHistoryIndex(-1);
        setScrollOffset(0);

        const isSelectionStep = 
          (activeWizard.type === "exit_confirm") ||
          (activeWizard.type === "login" && (activeWizard.step === 1 || activeWizard.step === 2 || activeWizard.step === 6 || activeWizard.step === 7 || activeWizard.step === 8 || activeWizard.step === 10)) ||
          (activeWizard.type === "model" && (activeWizard.step === 1 || activeWizard.step === 2 || activeWizard.step === 3 || activeWizard.step === 4 || activeWizard.step === 15 || activeWizard.step === 22 || activeWizard.step === 23 || activeWizard.step === 24 || activeWizard.step === 25 || activeWizard.step === 30 || activeWizard.step === 32 || activeWizard.step === 33 || activeWizard.step === 34 || activeWizard.step === 35 || activeWizard.step === 40 || activeWizard.step === 41 || activeWizard.step === 50)) ||
          (activeWizard.type === "permission") ||
          (activeWizard.type === "question" && wizardOptions.length > 0);

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
        const next = [...prev, trimmed].slice(-200);
        fs.writeFile(INPUT_HISTORY_FILE, JSON.stringify(next, null, 2), "utf8").catch(() => {});
        return next;
      });

      setInput("");
      setIsPasted(false);
      setLastTabPrefix(null);
      setHistoryIndex(-1);
      setScrollOffset(0);

      const runInteractiveProcess = async (command: string, cwd: string, env?: Record<string, string | undefined>) => {
        const wasRaw = process.stdin.isRaw;
        if (wasRaw) {
          process.stdin.setRawMode(false);
        }
        process.stdin.pause();

        let exitCode = 0;
        try {
          const { execSync } = await import("child_process");
          execSync(command, {
            cwd,
            env: { ...process.env, ...env },
            stdio: "inherit",
          });
        } catch (err: any) {
          exitCode = err.status ?? 1;
        }

        process.stdin.resume();
        if (wasRaw) {
          process.stdin.setRawMode(true);
        }
        return exitCode;
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
      setStreamDisplay("");

      // Build MessageContent — plain string or multimodal array
      let messageContent: MessageContent = trimmed;
      if (attachments.length > 0) {
        const parts: import("./core/conversation.js").MessageContent = [
          ...(trimmed ? [{ type: "text" as const, text: trimmed }] : []),
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

  const installedSkills = getInstalledSkills();
  const skillCommands = installedSkills.map(s => {
    const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    return `/skill-${slug}`;
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
          content: `📎 Clipboard image attached: ${attachment.filename}`,
          timestamp: Date.now(),
        });
      }
      // If null — clipboard had no image, normal text paste proceeds through stdin
    } catch {
      // Silently ignore — clipboard had no image
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

  const getSuggestions = (currentInput = input) => {
    if (!currentInput.startsWith("/")) return [];
    const trimmed = currentInput.trim();
    const parts = trimmed.split(/\s+/);
    const mainCommand = parts[0];

    if (!currentInput.includes(" ")) {
      return filterSuggestions(commands, currentInput);
    }

    if (mainCommand === "/processes" || mainCommand === "/procs") {
      if (currentInput.startsWith(`${mainCommand} stop`)) {
        const stopSuggestions = [`${mainCommand} stop all`];
        for (const [id] of backgroundTasks.entries()) {
          stopSuggestions.push(`${mainCommand} stop ${id}`);
        }
        return stopSuggestions.filter(p => p.startsWith(currentInput));
      }
      return [`${mainCommand} stop`, `${mainCommand} stop all`].filter(p => p.startsWith(currentInput));
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
        `${mainCommand} remove`
      ];
      return filterSuggestions(loginSuggestions, currentInput);
    }

    if (mainCommand === "/terminal") {
      if (currentInput.startsWith(`${mainCommand} stop`)) {
        const stopSuggestions = [`${mainCommand} stop all`];
        for (const [id] of backgroundTasks.entries()) {
          if (id.startsWith("term-")) stopSuggestions.push(`${mainCommand} stop ${id}`);
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
        if (fsSync.existsSync(hooksRoot)) {
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
      if (currentInput.startsWith(`${mainCommand} preset`)) {
        const presetSuggestions = [
          `${mainCommand} preset list`,
          `${mainCommand} preset save`,
        ];
        return filterSuggestions(presetSuggestions, currentInput);
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

    if (mainCommand === "/setting-tencentdb") {
      const tdbSuggestions = [
        "/setting-tencentdb on",
        "/setting-tencentdb off",
        "/setting-tencentdb status",
        "/setting-tencentdb show-bg-procs",
        "/setting-tencentdb hide-bg-procs",
      ];
      return filterSuggestions(tdbSuggestions, currentInput);
    }

    return [];
  };

  const handleInputChange = useCallback((val: string) => {
    const sanitizedVal = stripSgrMouseSequences(val);

    const lengthDiff = sanitizedVal.length - input.length;
    const containsNewline = sanitizedVal.includes("\n");
    if (lengthDiff < 0) {
      setIsPasted(false);
    } else if (lengthDiff > 15 || containsNewline) {
      setIsPasted(true);
      const { prefix, suffix } = getInsertion(input, sanitizedVal);
      setPastePrefixLength(prefix.length);
      setPasteSuffixLength(suffix.length);
    } else if (sanitizedVal.length === 0 || (sanitizedVal.length <= 200 && !containsNewline)) {
      setIsPasted(false);
    }
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
  }, [input, lastTabPrefix, activeWizard, wizardOptions]);

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

    }
    if (activeWizard.type === "model") {
      if (activeWizard.step === 1) return "Select model configuration option.";
      if (activeWizard.step === 2) return "Select provider for model tier.";
      if (activeWizard.step === 3) return "Select a configured provider profile, or create a new one.";
      if (activeWizard.step === 6) return "Enter a name for the new provider profile.";
      if (activeWizard.step === 7) return "Enter the custom endpoint base URL.";
      if (activeWizard.step === 8) return "Paste the API key for the new provider profile.";
      if (activeWizard.step === 15 || activeWizard.step === 24 || activeWizard.step === 34) return "Select an available model (type to filter).";
    }
    if (activeWizard.type === "question") {
      return pendingQuestion?.question || "Select an option or type a custom answer.";
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
    }
    if (activeWizard.type === "model") {
      if (activeWizard.step === 1) return "Select option using arrows and Enter...";
      if (activeWizard.step === 2) return "Enter provider number or select using arrows...";
      if (activeWizard.step === 20) return "Type preset name and press Enter (or type 'back' to go back)...";
      if (activeWizard.step === 21) return "Type preset description and press Enter (or type 'back' to go back)...";
      if (activeWizard.step === 22 || activeWizard.step === 32) return "Select tier option using arrows and Enter...";
      if (activeWizard.step === 23 || activeWizard.step === 33) return "Select provider using arrows and Enter...";
      if (activeWizard.step === 3 || activeWizard.step === 25 || activeWizard.step === 35) return "Select profile using arrows and Enter...";
      if (activeWizard.step === 15 || activeWizard.step === 24 || activeWizard.step === 34) return "🔍 Search models (type to filter, arrows to navigate, Enter to select)...";
      if (activeWizard.step === 30) return "Select preset to edit using arrows and Enter...";
      if (activeWizard.step === 31) return "Type new description and press Enter (or type 'back' to go back)...";
      if (activeWizard.step === 40) return "Select preset to delete using arrows and Enter...";
      if (activeWizard.step === 41) return "Select confirmation using arrows and Enter...";
      if (activeWizard.step === 50) return "Select agent tier using arrows and Enter...";
      if (activeWizard.step === 6) return "Enter config profile name (or press Enter for default)...";
      if (activeWizard.step === 7) return "Enter Custom Base URL...";
      if (activeWizard.step === 8) return "Paste API key...";
      return wizardOptions.length > 0
        ? "🔍 Search models (type to filter, arrows to navigate, Enter to select)..."
        : "Enter model name (e.g. google/gemini-2.5-flash)...";
    }
    if (activeWizard.type === "question") {
      if (activeWizard.step === 2) return "Type custom answer and press Enter...";
      return "Select option using arrows and Enter, or choose Custom...";
    }
    return "Enter value...";
  };

  const suggestions = getSuggestions(lastTabPrefix || input);

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
        case "text":
          streamBufferRef.current = resolveCarriageReturns(streamBufferRef.current + event.content);
          setStreamDisplay(streamBufferRef.current);
          lastStreamUpdateRef.current = Date.now();
          if (streamTimeoutRef.current) {
            clearTimeout(streamTimeoutRef.current);
            streamTimeoutRef.current = null;
          }
          break;
        case "tool_start": {
          if (streamTimeoutRef.current) {
            clearTimeout(streamTimeoutRef.current);
            streamTimeoutRef.current = null;
          }
          const content = streamBufferRef.current.trim();
          if (content) {
            flushBuffer();
          } else {
            const fallbackNarrative = `[SYS] Initiating action: ${event.description}...`;
            addLine({
              type: "assistant",
              content: fallbackNarrative,
              timestamp: Date.now(),
            });
            streamBufferRef.current = "";
            setStreamDisplay("");
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
          const resultContent = r.isError
            ? `Detail: ${r.result}`
            : `Output: ${r.result.slice(0, 500)}${r.result.length > 500 ? "..." : ""}`;
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
          setIsExecutingTool(false);
          setToolTimeout(null);
          setToolStartTime(null);
          setTimeLeft(null);
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
        const options = isModelCfgAccess
          ? ["Allow Access (one-time)", "Deny Access"]
          : isEnvFileAccess
          ? ["Allow Access (one-time)", "Allow for This Session", "Deny Access"]
          : isCmd
          ? ["Allow Command Execution", "Allow for This Session", "Deny Command Execution"]
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
    (question: string | QuestionItem[], options?: string[], isMultiSelect?: boolean, initialCheckedIndices?: number[]) => {
      return new Promise<any>((resolve) => {
        if (Array.isArray(question)) {
          const questions = question;
          const answers = new Array(questions.length).fill("");
          const q0 = questions[0];
          const hasOptions = Array.isArray(q0.options) && q0.options.length > 0;
          const allOptions = hasOptions ? [...q0.options, "Custom..."] : [];
          setPendingQuestion({ question: q0.question, options: allOptions, resolve });
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
          const hasOptions = Array.isArray(options) && options.length > 0;
          const allOptions = hasOptions ? [...options, "Custom..."] : [];
          setPendingQuestion({ question, options: allOptions, resolve });
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

    const handleSigint = () => {
      if (stopRunningSubagents() > 0) {
        agent.abort();
        setIsProcessing(false);
        setIsExecutingTool(false);
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
        setToolTimeout(null);
        setToolStartTime(null);
        setTimeLeft(null);
      } else {
        exit();
      }
    };
    process.on("SIGINT", handleSigint);

    agent.loadHistory(autoResume).then(() => {
      onSessionPath?.(agent.getCurrentHistoryFilePath());
      const msgs = agent.getHistory().getMessages();
      const userInputs: string[] = [];
      for (const m of msgs) {
        if (m.role === "user") {
          userInputs.push(contentToString(m.content));
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
        setStreamDisplay("");
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
    const fetchGitData = async () => {
      try {
        const { stdout } = await execa("git", ["branch", "--show-current"], { cwd: process.cwd(), reject: false });
        setGitBranch(stdout?.trim() || "");
      } catch {
        // ignore
      }
      try {
        const { stdout } = await execa("git", ["worktree", "list"], { cwd: process.cwd(), reject: false });
        if (stdout) {
          const lines = stdout.split("\n").filter(Boolean);
          setWorktreeCount(lines.length);
        } else {
          setWorktreeCount(0);
        }
      } catch {
        setWorktreeCount(0);
      }
    };
    fetchGitData();
    const interval = setInterval(fetchGitData, 5000);
    return () => clearInterval(interval);
  }, []);

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
    const count = [...backgroundTasks.values()].filter((t) => !t.hasExited).length;
    if (procsScrollOffset >= count && count > 0) {
      setProcsScrollOffset(Math.max(0, count - maxProcsVisible));
    }
  }, [lines, procsScrollOffset]);

  // Sync background triggers/notifications
  useEffect(() => {
    const unsubTasks = subscribeToTasks(() => {
      const allTasks = Array.from(backgroundTasks.values());
      setRunningTasksCount(
        allTasks.filter((t) => !t.hasExited).length
      );
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

          // Clean up completed headless tasks from the Map to prevent memory leaks
          backgroundTasks.delete(task.id);
          notifyTasksChanged();
        }
      });
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
  }, [addLine]);

  // Setup layouts & heights calculation
  const messageCount = lines.filter((l) => l.type === "user" || l.type === "assistant").length;
  const liveStreamTokens = Math.ceil(streamDisplay.length / 4);
  
  // Use ContextManager's TokenTracker for accurate context usage if available
  const cm = agentRef.current?.getContextManager?.();
  let activeContextUsage = 0;
  if (cm && agentRef.current) {
    const messages = agentRef.current.getHistory().getMessages();
    const breakdown = cm.estimateTokensForAll(messages);
    activeContextUsage = breakdown.total + liveStreamTokens;
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

  const inputLinesCount = input ? Math.max(1, Math.ceil((input.length + 6) / terminalWidth)) : 1;
  const activeToolLinesCount = activeToolOutput ? activeToolOutput.trim().split("\n").slice(-8).length : 0;
  const showBanner = messageCount === 0;

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
      // Steps 1,2,6,7,10 = pure selection; Step 8 = selection with search filter (needs input)
      return [1, 2, 6, 7, 10].includes(activeWizard.step);
    }
    if (activeWizard.type === "model") {
      // Steps 15,24,34 = model search/filter (needs input); others with options are pure selection
      return [1, 2, 3, 4, 22, 23, 25, 30, 32, 33, 35, 40, 41, 50].includes(activeWizard.step);
    }
    return false;
  })();

  let chromeHeight = (showBanner ? 15 : 8) + (isSelectionOnlyStep ? 0 : inputLinesCount);
  if (isExecutingTool) {
    chromeHeight += 3;
    if (activeToolLinesCount > 0) chromeHeight += activeToolLinesCount + 1;
  }
  if (planState === "PLANNING_PENDING") {
    chromeHeight += activeWizard?.type === "plan_approve"
      ? planApprovalChromeHeight(planPath, activeWizard.step)
      : 6;
  }
  if (activeWizard) {
    chromeHeight += 3;
    if (activeWizard.type === "login") {
      if (activeWizard.step === 1 || activeWizard.step === 2) chromeHeight += 8;
      else if (activeWizard.step === 10) chromeHeight += 8 + Math.min(6, wizardOptions.length);
      else if (
        activeWizard.step === 3 ||
        activeWizard.step === 4 ||
        activeWizard.step === 5 ||
        activeWizard.step === 9 ||
        activeWizard.step === 11 ||
        activeWizard.step === 12 ||
        activeWizard.step === 13
      ) chromeHeight += 6;
      else if (
        activeWizard.step === 6 ||
        activeWizard.step === 7 ||
        activeWizard.step === 8
      ) chromeHeight += 8 + Math.min(6, wizardOptions.length);
    } else if (activeWizard.type === "model") {
      chromeHeight += wizardOptions.length > 0 ? 13 : 6;
    } else if (activeWizard.type === "permission") {
      chromeHeight += 9;
    } else if (activeWizard.type === "question") {
      chromeHeight += 8 + Math.min(6, wizardOptions.length);
    }
  } else if (input.startsWith("/") && suggestions.length > 0) {
    chromeHeight += 2;
  }
  if (isProcessing) {
    if (streamDisplay && streamDisplay.trim().length > 0) chromeHeight += 2;
    else if (activeWizard?.type !== "permission" && !isExecutingTool) chromeHeight += 3;
  }
  if (planState === "APPROVED" && checklistTasks.length > 0) {
    chromeHeight += 1 + Math.min(checklistTasks.length, maxChecklistVisible);
  }
  // Account for completed history section height
  if (planState === "APPROVED" && completedHistory.length > 0) {
    const historyVisible = Math.min(completedHistory.length, 3);
    chromeHeight += 1 + historyVisible + (completedHistory.length > 3 ? 1 : 0);
  }

  let liveListHeight = 0;
  if (runningSuperagentsCount > 0 || runningSubagentsCount > 0 || runningTasksCount > 0) {
    if (runningSuperagentsCount > 0) {
      liveListHeight += collapsedSections.superagents
        ? 1
        : 1 + Math.min(runningSuperagentsCount, maxSuperagentsVisible) * 3;
    }
    if (runningSubagentsCount > 0) {
      liveListHeight += collapsedSections.subagents
        ? 1
        : 1 + Math.min(runningSubagentsCount, maxSubagentsVisible);
    }
    if (runningTasksCount > 0) {
      liveListHeight += 1 + Math.min(runningTasksCount, maxProcsVisible);
    }
  }
  chromeHeight += liveListHeight;

  const chatHeightLimit = Math.max(5, terminalHeight - chromeHeight - 1);

  // --- Calculate section boundaries for mouse click detection ---
  // Layout from bottom: StatusBar(3) + margin(1) + bottomChrome(content + margin) + ChatArea
  const statusBarTotalRows = 4; // 3 content + 1 marginTop
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
    procSectionHeight = 1 + Math.min(runningTasksCount, maxProcsVisible);
  }
  const totalAgentsHeight = saSectionHeight + subSectionHeight + procSectionHeight;

  // Checklist height
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
  } else if (input.startsWith("/") && suggestions.length > 0) {
    wizardSectionHeight += 2;
  }

  // Input section height (border line + input text lines) — hidden for selection-only wizard steps
  const inputSectionHeight = isSelectionOnlyStep ? 0 : 1 + inputLinesCount;

  // Bottom chrome: marginTop(1) + agents + checklist + wizard + input
  const bottomChromeContentHeight = totalAgentsHeight + checklistSectionHeight + wizardSectionHeight + inputSectionHeight;
  const bottomChromeTotalHeight = 1 + bottomChromeContentHeight; // +1 for marginTop of the chrome box

  // Chat area height on screen
  const chatAreaScreenHeight = mainContentHeight - bottomChromeTotalHeight;

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
    sectionBounds.push({ name: "checklist", startRow: row, endRow: row + checklistSectionHeight - 1 });
    row += checklistSectionHeight;
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
  sectionBounds.push({ name: "statusbar", startRow: terminalHeight - 2, endRow: terminalHeight });

  // Focused response scroll metrics
  const focusRespWidth = Math.max(20, terminalWidth - 6);
  const focusRespMaxLines = Math.max(8, Math.min(18, Math.floor(terminalHeight * 0.45)));
  const focusWindowHeight = Math.max(5, chatHeightLimit - 3);
  let responseLinesCount = 0;
  if (focusedResponseIndex !== null && lines[focusedResponseIndex]?.type === "assistant") {
    responseLinesCount = wrapTextForDisplay(lines[focusedResponseIndex].content, focusRespWidth).length;
  }

  // Chat content start row (after header, for visible line position calculation)
  // Banner: marginY(1) + inner_row(4) + marginY(1) = 6 rows; +1 header row → content starts at row 8
  // No git warning adds ~2 extra rows (marginY(1) + 1 content row)
  const bannerHeight = showBanner ? (gitBranch ? 6 : 8) : 0;
  const chatContentStartRow = bannerHeight + 1 /* header */ + 1 /* first content row */;

  const wrappedLines = useMemo(() => {
    return computeWrappedLines({
      lines,
      chatWidth: Math.max(20, terminalWidth - 6),
      maxAssistantResponseLines: 12,
      expandedLines,
      expandedChildren,
      tokensUp,
      tokensDown,
      modelName: activeModel,
      isProcessing,
      streamDisplay,
      isExecutingTool,
      activeToolOutput,
      timeLeft,
      formatCompactNumber,
    });
  }, [
    lines,
    terminalWidth,
    expandedLines,
    expandedChildren,
    tokensUp,
    tokensDown,
    activeModel,
    isProcessing,
    streamDisplay,
    isExecutingTool,
    activeToolOutput,
    timeLeft,
  ]);

  wrappedLinesLengthRef.current = wrappedLines.length;
  chatHeightLimitRef.current = chatHeightLimit;

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
    handleWizardSubmit,
  };

  return (
    <Box flexDirection="column" height={terminalHeight}>
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" width="100%" flexGrow={1}>
          
          {/* Render Chat & Logs */}
          <ChatArea
            showBanner={showBanner}
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
            wrappedLines={wrappedLines}
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
            />

            <TaskChecklist
              planState={planState}
              checklistTasks={checklistTasks}
              checklistScrollOffset={checklistScrollOffset}
              maxChecklistVisible={maxChecklistVisible}
              focusMode={focusMode}
              isMultiAgent={!!agentRef.current?.isMultiAgent}
              completedHistory={completedHistory}
            />

            {/* Input History Panel — shown when Ctrl+H is pressed */}
            <HistoryPanel
              history={history}
              historySelectedIndex={historySelectedIndex}
              focusMode={focusMode}
            />

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

            {/* CommandLine Input — hidden for selection-only wizard steps */}
            {!isSelectionOnlyStep && (
            <Box flexDirection="column">
              {(() => {
                const question = getWizardQuestion();
                if (!question) return null;
                return (
                  <Box flexDirection="row" marginBottom={1}>
                    <Text color={activeWizard ? getWizardBorderColor(activeWizard) : "green"}>│ </Text>
                    <Text color="cyan" wrap="truncate-end">{question}</Text>
                  </Box>
                );
              })()}
              <Text color={scrollOffset > 0 ? "yellow" : activeWizard ? getWizardBorderColor(activeWizard) : isProcessing ? "gray" : "green"}>
                └───[ <Text bold color={scrollOffset > 0 ? "yellow" : activeWizard ? getWizardBorderColor(activeWizard) : isProcessing ? "gray" : "green"}>
                  {activeWizard ? `⚙️ WIZARD: ${activeWizard.type.toUpperCase()} (Step ${activeWizard.step})` : "⌨️ COMM_LINK: ACTIVE"}
                </Text> ]
                {isProcessing && displayPrompt && (
                  <Text color="cyan" bold> ─── [ PROMPT: "{displayPrompt}" ]</Text>
                )}
              </Text>
              <Box flexDirection="row">
                <Text color={activeWizard ? getWizardBorderColor(activeWizard) : isProcessing ? "gray" : "green"}>│ ❯ </Text>
                {isProcessing && !activeWizard ? (
                  <ProcessingIndicator scrollOffset={scrollOffset} />
                ) : (() => {
                  const { prefix, inserted, suffix } = getPasteSplit(input, pastePrefixLength, pasteSuffixLength);
                  const isPasteActive = isPasted && (inserted.length > 200 || inserted.includes("\n"));
                  if (isPasteActive) {
                    const lineCount = inserted.split("\n").length;
                    return (
                      <Box flexDirection="row">
                        {prefix ? <Text>{prefix}</Text> : null}
                        <Text color="yellow" bold>[Pasted Text: {inserted.length} chars, {lineCount} lines] </Text>
                        {suffix ? <Text>{suffix}</Text> : null}
                        <Text dimColor>(Press Enter to send, Esc to clear)</Text>
                      </Box>
                    );
                  }
                  return (
                    <Box flexDirection="column">
                      {attachments.length > 0 && (
                        <ImageAttachmentBar
                          attachments={attachments}
                          onRemove={handleRemoveAttachment}
                          focused={focusMode === "input"}
                        />
                      )}
                      <ChatTextInput
                        focus={focusMode === "input"}
                        value={input}
                        onChange={handleInputChange}
                        onSubmit={handleSubmit}
                        placeholder={getWizardPlaceholder()}
                        onAttachImage={handleAttachImage}
                        onPasteImage={handlePasteImage}
                        onRemoveLastAttachment={handleRemoveLastAttachment}
                        attachmentCount={attachments.length}
                      />
                    </Box>
                  );
                })()}
              </Box>
            </Box>
            )}

          </Box>
        </Box>
      </Box>

      {/* Render Status Bar */}
      <StatusBar
        modelName={activeModel}
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
        tencentdbStatus={tencentdbStatus}
      />
    </Box>
  );
}
