import { useInput } from "ink";
import { useRef, useCallback } from "react";
import type { ChatLinePosition } from "./useMouseScroll.js";
import path from "path";
import fs from "fs";
import { getTruncatedAssistantIndexes, wrapTextForDisplay } from "../utils/responseScroll.js";
import { getPasteSplit, filterSuggestions, getInsertion } from "../utils/text.js";
import { reconstructChatLines } from "../utils/uiHelpers.js";
import { getConfiguredProviders, switchActiveProvider, fetchAndCacheModels, getContextWindowLimit, listHistorySessions, getModelPresets, BUILT_IN_PRESETS, getInstalledSkills, getProviderOptionsList, getProviders, getActiveProviderName, getResolvedModelWithProvider, getTierModel, getEffectiveMasterModel, getSettings } from "../core/config.js";
import { getDefaultModel } from "../core/slash-commands.js";
import { listCheckpointsForSession, terminateActiveTasksAndSubagents, restoreCheckpoint, deleteCheckpointById, type Checkpoint } from "../core/checkpoints.js";
import { getToolDescription } from "../core/permissions.js";
import { registerSubagentType, allTools, backgroundTasks, subagentInstances, superagentInstances, subscribeToTasks, subscribeToSubagents, subscribeToSuperagents, subscribeToSchedules, subscribeToActiveOutput, registerQuestionHandler, notifySubagentsChanged, isTaskInWorkspace } from "../core/tools.js";
import type { ChatLine } from "../core/slash-commands.js";
import type { ToolCall } from "../core/conversation.js";
import { contentToString } from "../core/conversation.js";
import type { Agent, QuestionItem } from "../core/agent.js";
import { PLAN_APPROVAL_OPTIONS } from "../components/plan-approval-dialog.js";

function formatArgs(args: string | Record<string, any>): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}

export interface KeyboardHandlerContext {
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  isProcessing: boolean;
  setIsProcessing: React.Dispatch<React.SetStateAction<boolean>>;
  activeWizard: {
    type: "login" | "model" | "plan_approve" | "permission" | "question" | "resume" | "goal" | "checkpoint" | "skills" | "exit_confirm" | "workspace";
    step: number;
    data: Record<string, string>;
    isMultiSelect?: boolean;
    questions?: QuestionItem[];
    currentQuestionIndex?: number;
    answers?: string[];
  } | null;
  setActiveWizard: React.Dispatch<React.SetStateAction<any>>;
  wizardOptions: string[];
  setWizardOptions: React.Dispatch<React.SetStateAction<string[]>>;
  wizardSelectedIndex: number;
  setWizardSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  wizardSelectedSet: Set<number>;
  setWizardSelectedSet: React.Dispatch<React.SetStateAction<Set<number>>>;
  checkpointsList: Checkpoint[];
  setCheckpointsList: React.Dispatch<React.SetStateAction<Checkpoint[]>>;
  lines: ChatLine[];
  setLines: React.Dispatch<React.SetStateAction<ChatLine[]>>;
  addLine: (line: ChatLine) => void;
  history: string[];
  setHistory: React.Dispatch<React.SetStateAction<string[]>>;
  historyIndex: number;
  setHistoryIndex: React.Dispatch<React.SetStateAction<number>>;
  tempInput: string;
  setTempInput: React.Dispatch<React.SetStateAction<string>>;
  scrollOffset: number;
  setScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  focusedResponseIndex: number | null;
  setFocusedResponseIndex: React.Dispatch<React.SetStateAction<number | null>>;
  focusedResponseOffset: number;
  setFocusedResponseOffset: React.Dispatch<React.SetStateAction<number>>;
  planState: string;
  setPlanState: React.Dispatch<React.SetStateAction<any>>;
  focusMode: "input" | "history" | "checklist" | "superagents" | "subagents" | "procs" | "chat";
  setFocusMode: React.Dispatch<React.SetStateAction<any>>;
  historySelectedIndex: number;
  setHistorySelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  checklistScrollOffset: number;
  setChecklistScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  superagentsScrollOffset: number;
  setSuperagentsScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  subagentsScrollOffset: number;
  setSubagentsScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  procsScrollOffset: number;
  setProcsScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  procsSelectedIndex: number;
  setProcsSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  terminalHeight: number;
  terminalWidth: number;
  checklistTasks: { status: string; text: string }[];
  completedHistory?: { status: string; text: string; remainingSeconds?: number }[];
  agentRef: React.MutableRefObject<Agent | null>;
  pendingPermission: {
    toolCall: ToolCall;
    description: string;
    resolve: (value: boolean) => void;
  } | null;
  setPendingPermission: React.Dispatch<React.SetStateAction<any>>;
  pendingQuestion: {
    question: string;
    options: string[];
    resolve: (value: any) => void;
  } | null;
  setPendingQuestion: React.Dispatch<React.SetStateAction<any>>;
  handleWizardSubmit: (value: string) => void;
  handleSubmit: (value: string) => void;
  handlePermissionResponse: (approved: boolean | "session") => void;
  openLatestTruncatedResponse: () => boolean;
  stopRunningSubagents: () => number;
  scrollChat: (direction: "up" | "down", amount?: number) => void;
  setContextLimit: React.Dispatch<React.SetStateAction<number>>;
  setActiveModel: React.Dispatch<React.SetStateAction<string>>;
  exit: () => void;
  isPasted: boolean;
  setIsPasted: React.Dispatch<React.SetStateAction<boolean>>;
  pastePrefixLength: number;
  pasteSuffixLength: number;
  lastTabPrefix: string | null;
  setLastTabPrefix: React.Dispatch<React.SetStateAction<string | null>>;
  commands: string[];
  suggestions?: string[];
  visibleLinePositions: ChatLinePosition[];
  toggleLineExpand: (index: number) => void;
  toggleChildExpand: (parentIndex: number, childIndex: number) => void;
  expandCursorRef: React.MutableRefObject<number>;
}

export function useKeyboardHandler(ctx: KeyboardHandlerContext) {
  const {
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
    completedHistory = [],
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
    suggestions = [],
    visibleLinePositions,
    toggleLineExpand,
    toggleChildExpand,
    expandCursorRef,
  } = ctx;

  const settings = getSettings();
  const maxChecklistVisible = settings.maxChecklistVisible ?? 3;
  const maxSuperagentsVisible = 2;
  const maxSubagentsVisible = 3;
  const maxProcsVisible = settings.maxProcsVisible ?? 3;

  const handlerRef = useRef<(inputChar: string, key: any) => void>();
  handlerRef.current = (inputChar, key) => {
    const isEscape = !!(key?.escape || ((inputChar === "\x1b" || inputChar === "\u001b") && inputChar.length === 1));
    const isCtrlC = !!(inputChar === "\x03" || (key?.ctrl && inputChar === "c"));

    // Ctrl+C when wizard is active: always cancel wizard first, never exit app.
    // This check must be BEFORE focusedResponseIndex and focusMode checks
    // so Ctrl+C always works to cancel the wizard regardless of UI state.
    if (isCtrlC && activeWizard) {
      const needsAbort = activeWizard.type === "permission" || activeWizard.type === "question" || activeWizard.type === "plan_approve";
      if (pendingPermission) {
        pendingPermission.resolve(false);
        setPendingPermission(null);
      }
      if (pendingQuestion) {
        pendingQuestion.resolve("__CANCEL__");
        setPendingQuestion(null);
      }
      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
      setFocusedResponseIndex?.(null);
      setFocusedResponseOffset?.(0);
      setFocusMode?.("input");
      setScrollOffset?.(0);
      addLine({
        type: "system",
        content: "Wizard cancelled.",
        timestamp: Date.now(),
      });
      if (needsAbort) {
        if (activeWizard.type === "plan_approve") {
          setPlanState("IDLE");
          if (agentRef.current) {
            agentRef.current.planState = "IDLE";
          }
        }
        stopRunningSubagents();
        agentRef.current?.abort();
        setIsProcessing(false);
      }
      return;
    }

    if (focusedResponseIndex !== null && focusedResponseIndex !== undefined && !activeWizard) {
      const width = Math.max(20, terminalWidth - 6);
      const maxLines = Math.max(8, Math.min(18, Math.floor(terminalHeight * 0.45)));
      const truncatedIndexes = getTruncatedAssistantIndexes(lines || [], maxLines, width);
      const currentPosition = truncatedIndexes.indexOf(focusedResponseIndex);
      const focusedLine = lines[focusedResponseIndex];
      const responseLines = focusedLine?.type === "assistant" ? wrapTextForDisplay(focusedLine.content, Math.max(20, width - 6)) : [];
      const focusWindowHeight = Math.max(5, terminalHeight - 13);
      const maxOffset = Math.max(0, responseLines.length - focusWindowHeight);

      if (isEscape) {
        setFocusedResponseIndex(null);
        setFocusedResponseOffset(0);
        return;
      }
      if (key.pageUp || (key.ctrl && key.upArrow)) {
        setFocusedResponseOffset((prev) => Math.max(0, prev - focusWindowHeight));
        return;
      }
      if (key.pageDown || (key.ctrl && key.downArrow)) {
        setFocusedResponseOffset((prev) => Math.min(maxOffset, prev + focusWindowHeight));
        return;
      }
      if (key.upArrow) {
        setFocusedResponseOffset((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setFocusedResponseOffset((prev) => Math.min(maxOffset, prev + 1));
        return;
      }
      return;
    }

    if (focusMode === "checklist" && !activeWizard) {
      if (key.upArrow) {
        setChecklistScrollOffset((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setChecklistScrollOffset((prev) => {
          const maxScroll = Math.max(0, checklistTasks.length - maxChecklistVisible);
          return Math.min(prev + 1, maxScroll);
        });
        return;
      }
      if (isEscape) {
        setFocusMode("input");
        return;
      }
      // Auto-return to input when user types a printable character
      if (inputChar && !key.ctrl && !key.meta && inputChar.length === 1 && inputChar >= ' ') {
        setFocusMode("input");
        return;
      }
      return;
    }

    if (focusMode === "superagents" && !activeWizard) {
      if (key.upArrow) {
        setSuperagentsScrollOffset((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setSuperagentsScrollOffset((prev) => {
          const runningSuperagentsCount = [...superagentInstances.values()].filter((s) => s.status === "running").length;
          const maxScroll = Math.max(0, runningSuperagentsCount - maxSuperagentsVisible);
          return Math.min(prev + 1, maxScroll);
        });
        return;
      }
      if (isEscape) {
        setFocusMode("input");
        return;
      }
      if (inputChar && !key.ctrl && !key.meta && inputChar.length === 1 && inputChar >= ' ') {
        setFocusMode("input");
        return;
      }
      return;
    }

    if (focusMode === "subagents" && !activeWizard) {
      if (key.upArrow) {
        setSubagentsScrollOffset((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setSubagentsScrollOffset((prev) => {
          const runningSubagentsCount = [...subagentInstances.values()].filter((s) => s.status === "running").length;
          const maxScroll = Math.max(0, runningSubagentsCount - maxSubagentsVisible);
          return Math.min(prev + 1, maxScroll);
        });
        return;
      }
      if (isEscape) {
        setFocusMode("input");
        return;
      }
      if (inputChar && !key.ctrl && !key.meta && inputChar.length === 1 && inputChar >= ' ') {
        setFocusMode("input");
        return;
      }
      return;
    }

    if (focusMode === "procs" && !activeWizard) {
      const workspacePath = agentRef.current?.workingDirectory || process.cwd();
      const runningProcs = Array.from(backgroundTasks.entries()).filter(([_, task]) => !task.hasExited && !task.isHidden && isTaskInWorkspace(task.cwd, workspacePath));
      const total = runningProcs.length;

      if (key.upArrow) {
        setProcsSelectedIndex((prev) => {
          const next = Math.max(0, prev - 1);
          if (next < procsScrollOffset) {
            setProcsScrollOffset(next);
          }
          return next;
        });
        return;
      }
      if (key.downArrow) {
        setProcsSelectedIndex((prev) => {
          const next = Math.min(total - 1, prev + 1);
          if (next >= procsScrollOffset + maxProcsVisible) {
            setProcsScrollOffset(next - maxProcsVisible + 1);
          }
          return next;
        });
        return;
      }
      if (key.return) {
        const selected = runningProcs[procsSelectedIndex];
        if (selected) {
          const [taskId, task] = selected;
          let logContent = "";
          if (task.logPath && fs.existsSync(task.logPath)) {
            try {
              const fullLog = fs.readFileSync(task.logPath, "utf-8");
              const logLines = fullLog.split("\n");
              logContent = logLines.slice(-40).join("\n");
            } catch (e) {
              logContent = `Error reading log file: ${e instanceof Error ? e.message : String(e)}`;
            }
          } else if (task.output && task.output.length > 0) {
            logContent = task.output.slice(-40).join("");
          } else {
            logContent = "No log output available yet.";
          }

          addLine({
            type: "system",
            content: `┌───[ 📄 LOG FOR PROCESS ${taskId} ]\n` +
                     `│ Command: ${task.command}\n` +
                     `├──────────────────────────────────────────────\n` +
                     logContent.split("\n").map(l => `│ ${l}`).join("\n") +
                     `\n└──────────────────────────────────────────────`,
            timestamp: Date.now()
          });
        }
        return;
      }
      if (isEscape) {
        setFocusMode("input");
        return;
      }
      if (inputChar && !key.ctrl && !key.meta && inputChar.length === 1 && inputChar >= ' ') {
        setFocusMode("input");
        return;
      }
      return;
    }

    if (focusMode === "chat" && !activeWizard) {
      if (key.pageUp) {
        scrollChat("up", 10);
        return;
      }
      if (key.pageDown) {
        scrollChat("down", 10);
        return;
      }
      if ((key.ctrl && key.upArrow) || (key.shift && key.upArrow)) {
        scrollChat("up", 1);
        return;
      }
      if ((key.ctrl && key.downArrow) || (key.shift && key.downArrow)) {
        scrollChat("down", 1);
        return;
      }
      if (key.upArrow) {
        scrollChat("up");
        return;
      }
      if (key.downArrow) {
        scrollChat("down");
        return;
      }
      if (isEscape) {
        setScrollOffset(0);
        setFocusMode("input");
        return;
      }
      // Auto-return to input when user types a printable character
      if (inputChar && !key.ctrl && !key.meta && inputChar.length === 1 && inputChar >= ' ') {
        setScrollOffset(0);
        setFocusMode("input");
        return;
      }
      return;
    }

    if (key.ctrl && inputChar === "h" && !activeWizard) {
      setFocusMode((prev: any) => {
        const next = prev === "input" ? "history" : "input";
        if (next === "history") {
          const uniqueHistory = Array.from(new Set(history));
          setHistorySelectedIndex(uniqueHistory.length > 0 ? uniqueHistory.length - 1 : 0);
        }
        return next;
      });
      return;
    }

    // Ctrl+T: Toggle checklist focus mode
    if (key.ctrl && inputChar === "t" && !activeWizard) {
      if (planState === "APPROVED" && (checklistTasks.length > 0 || completedHistory.length > 0)) {
        setFocusMode((prev: any) => (prev === "checklist" ? "input" : "checklist"));
      }
      return;
    }

    // Ctrl+B: Toggle active processes focus mode
    if (key.ctrl && inputChar === "b" && !activeWizard) {
      const workspacePath = agentRef.current?.workingDirectory || process.cwd();
      const runningTasksCount = [...backgroundTasks.values()].filter((t) => !t.isHidden && (t.isDetachedWindow || !t.hasExited) && isTaskInWorkspace(t.cwd, workspacePath)).length;
      if (runningTasksCount > 0) {
        setFocusMode((prev: any) => (prev === "procs" ? "input" : "procs"));
        setProcsSelectedIndex(0);
      }
      return;
    }

    // Ctrl+O: Cycle-expand tool/system entries
    if (key.ctrl && inputChar === "o" && !activeWizard) {
      const collapsibles = visibleLinePositions.filter((pos) => pos.isCollapsible);
      if (collapsibles.length > 0) {
        const nextCursor = (expandCursorRef.current + 1) % collapsibles.length;
        expandCursorRef.current = nextCursor;
        const target = collapsibles[nextCursor];
        if (target.parentIndex !== undefined && target.childIndex !== undefined && toggleChildExpand) {
          toggleChildExpand(target.parentIndex, target.childIndex);
        } else if (toggleLineExpand) {
          toggleLineExpand(target.index);
        }
      }
      return;
    }

    // Ctrl+P: Open checkpoint wizard
    if (key.ctrl && inputChar === "p") {
      if (isProcessing || activeWizard) return;
      if (!agentRef.current) return;
      const sessionPath = agentRef.current.getCurrentHistoryFilePath();
      listCheckpointsForSession(sessionPath)
        .then((checkpoints) => {
          if (checkpoints.length === 0) {
            addLine({ type: "system", content: "No checkpoints found. Use /checkpoint <name> to create one.", timestamp: Date.now() });
            return;
          }
          setCheckpointsList(checkpoints);
          const relTime = (ts: number) => {
            const diff = Math.floor((Date.now() - ts) / 1000);
            if (diff < 60) return `${diff}s ago`;
            if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
            if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
            return `${Math.floor(diff / 86400)}d ago`;
          };
          const options = checkpoints.map((c) => {
            const gitTag = c.gitSha ? ` [${c.gitSha}]` : "";
            return `📌 ${c.name}  |  ${c.messages.length} msgs  |  ${relTime(c.timestamp)}${gitTag}`;
          });
          setActiveWizard({ type: "checkpoint", step: 1, data: { action: "browse" } });
          setWizardOptions(options);
          setWizardSelectedIndex(0);
        })
        .catch(() => {
          addLine({ type: "error", content: "Failed to list checkpoints.", timestamp: Date.now() });
        });
      return;
    }

    if (focusMode === "history" && !activeWizard) {
      const uniqueHistory = Array.from(new Set(history));
      if (key.upArrow) {
        setHistorySelectedIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setHistorySelectedIndex((prev) => Math.min(uniqueHistory.length - 1, prev + 1));
        return;
      }
      if (key.return) {
        if (uniqueHistory.length > 0 && uniqueHistory[historySelectedIndex]) {
          setInput(uniqueHistory[historySelectedIndex]);
        }
        setFocusMode("input");
        return;
      }
      if (isEscape) {
        setFocusMode("input");
        return;
      }
      return;
    }

    if (activeWizard) {
      if (activeWizard.type === "login" && (activeWizard.step === 1 || activeWizard.step === 2 || activeWizard.step === 6 || activeWizard.step === 7 || activeWizard.step === 8 || activeWizard.step === 10 || activeWizard.step === 14 || activeWizard.step === 15 || activeWizard.step === 17)) {
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
          return;
        }
        if (key.return) {
          const selectedOption = wizardOptions[wizardSelectedIndex];
          if (!selectedOption) return;
          const now = Date.now();

          if (activeWizard.step === 1) {
            if (selectedOption.includes("Create / Log in")) {
              setActiveWizard({
                type: "login",
                step: 2,
                data: {},
              });
              setWizardOptions(["1. OpenRouter (Recommended)", "2. OpenAI", "3. Anthropic", "4. Custom OpenAI Endpoint", "5. Custom Anthropic Endpoint", "6. Google Gemini"]);
              setWizardSelectedIndex(0);
            } else if (selectedOption.includes("Delete / Remove")) {
              const providers = getProviders().filter((p: any) => p.apiKey && p.apiKey.trim() !== "");
              if (providers.length === 0) {
                addLine({ type: "system", content: "No providers configured yet.", timestamp: now });
                setActiveWizard(null);
                setWizardOptions([]);
                setWizardSelectedIndex(0);
              } else {
                const providerOptions = providers.map(
                  (p: any, i: number) => `${i + 1}. ${p.name} [${p.provider}]${p.baseUrl ? ` (${p.baseUrl})` : ""}`
                );
                setActiveWizard({ type: "login", step: 14, data: {} });
                setWizardOptions(providerOptions);
                setWizardSelectedIndex(0);
              }
            } else if (selectedOption.includes("Edit")) {
              const providers = getProviders().filter((p: any) => p.apiKey && p.apiKey.trim() !== "");
              if (providers.length === 0) {
                addLine({ type: "system", content: "No providers configured yet.", timestamp: now });
                setActiveWizard(null);
                setWizardOptions([]);
                setWizardSelectedIndex(0);
              } else {
                const providerOptions = providers.map(
                  (p: any, i: number) => `${i + 1}. ${p.name} [${p.provider}]${p.baseUrl ? ` (${p.baseUrl})` : ""}`
                );
                setActiveWizard({ type: "login", step: 17, data: {} });
                setWizardOptions(providerOptions);
                setWizardSelectedIndex(0);
              }
            } else {
              const providers = getProviders().filter((p: any) => p.apiKey && p.apiKey.trim() !== "");
              if (providers.length === 0) {
                addLine({ type: "system", content: "No providers configured yet. Use /login to create one.", timestamp: now });
                setActiveWizard(null);
                setWizardOptions([]);
                setWizardSelectedIndex(0);
              } else {
                const providerOptions = providers.map(
                  (p: any, i: number) => `${i + 1}. ${p.name} [${p.provider}]${p.baseUrl ? ` (${p.baseUrl})` : ""}`
                );
                setActiveWizard({ type: "login", step: 6, data: {} });
                setWizardOptions(providerOptions);
                setWizardSelectedIndex(0);
              }
            }
          } else if (activeWizard.step === 10) {
            handleWizardSubmit(selectedOption);
            return;
          } else if (activeWizard.step === 2) {
            const choice = selectedOption.toLowerCase();
            let provider = "";
            if (choice.includes("openrouter")) provider = "openrouter";
            else if (choice.includes("custom") && choice.includes("anthropic")) provider = "custom-anthropic";
            else if (choice.includes("custom") && choice.includes("openai")) provider = "custom";
            else if (choice.includes("custom")) provider = "custom";
            else if (choice.includes("openai")) provider = "openai";
            else if (choice.includes("anthropic")) provider = "anthropic";
            else if (choice.includes("gemini") || choice.includes("google")) provider = "gemini";

            addLine({
              type: "system",
              content: `Selected provider type: ${provider}`,
              timestamp: now,
            });

            setActiveWizard({
              type: "login",
              step: 3,
              data: { provider },
            });
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            setInput("");
          } else if (activeWizard.step === 6) {
            // Select provider from list → delegate to handleWizardSubmit with 1-based index
            const idx = wizardSelectedIndex + 1;
            handleWizardSubmit(String(idx));
          } else if (activeWizard.step === 7) {
            // Confirm connection test
            handleWizardSubmit(selectedOption);
          } else if (activeWizard.step === 8) {
            // Select model — support filter: use filtered list if input exists
            const currentInput = (typeof input === "string") ? input.trim() : "";
            const filteredModels = currentInput ? filterSuggestions(wizardOptions, currentInput) : wizardOptions;
            const clampedIdx = Math.min(wizardSelectedIndex, Math.max(0, filteredModels.length - 1));
            const chosenModel = filteredModels[clampedIdx] || wizardOptions[wizardSelectedIndex];
            if (chosenModel) {
              handleWizardSubmit(chosenModel);
            }
          } else if (activeWizard.step === 14) {
            // Select provider to delete
            const idx = wizardSelectedIndex + 1;
            handleWizardSubmit(String(idx));
          } else if (activeWizard.step === 15) {
            // Confirm deletion
            handleWizardSubmit(selectedOption);
          } else if (activeWizard.step === 17) {
            // Select provider to edit
            const idx = wizardSelectedIndex + 1;
            handleWizardSubmit(String(idx));
          }
          return;
        }
      } else if (activeWizard.type === "model" && activeWizard.step === 1 && wizardOptions.length > 0) {
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
          return;
        }
        if (key.return) {
          const choices = [
            "preset_load",    // 0
            "preset_list",    // 1
            "preset_create",  // 2
            "preset_edit",    // 3
            "preset_delete",  // 4
            "configure_tiers", // 5
            "back"            // 6
          ];
          const choice = choices[wizardSelectedIndex];
          if (!choice) return;

          if (choice === "back") {
            setActiveWizard(null);
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          }

          if (choice === "preset_load") {
            const presetMode = agentRef.current?.isMultiAgent ? "multi" as const : "single" as const;
            setActiveWizard({
              type: "model",
              step: 4,
              data: { tier: choice },
            });
            const presets = getModelPresets(presetMode);
            const options = presets.map(p => `${p.name} - ${p.description}${p.mode ? ` [${p.mode}]` : ""}`);
            setWizardOptions([...options, "< Back"]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          }

          if (choice === "preset_list") {
            const presetMode = agentRef.current?.isMultiAgent ? "multi" as const : "single" as const;
            const modeLabel = agentRef.current?.isMultiAgent ? "Multi-Agent" : "Single-Agent";
            const presets = getModelPresets(presetMode);
            const listStr = presets.map(p => {
              const modeInfo = p.mode ? ` [${p.mode}]` : "";
              const modelsStr = Object.entries(p.models).map(([k, v]) => `    - ${k}: ${v}`).join("\n");
              return `- **${p.name}**${modeInfo}: ${p.description}\n${modelsStr}`;
            }).join("\n");
            addLine({
              type: "system",
              content: `Available Model Presets (${modeLabel}):\n${listStr}`,
              timestamp: Date.now(),
            });
            setActiveWizard(null);
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            return;
          }

          if (choice === "preset_create") {
            setActiveWizard({
              type: "model",
              step: 20,
              data: { tier: choice },
            });
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          }

          if (choice === "preset_edit") {
            const presetMode = agentRef.current?.isMultiAgent ? "multi" as const : "single" as const;
            const modeLabel = agentRef.current?.isMultiAgent ? "Multi-Agent" : "Single-Agent";
            const presets = getModelPresets(presetMode);
            const customPresets = presets.filter(p => !BUILT_IN_PRESETS.some(bp => bp.name === p.name));
            if (customPresets.length === 0) {
              addLine({
                type: "error",
                content: `No custom presets available to edit for ${modeLabel} mode.`,
                timestamp: Date.now(),
              });
              setActiveWizard(null);
              setWizardOptions([]);
              setWizardSelectedIndex(0);
              return;
            }
            setActiveWizard({
              type: "model",
              step: 30,
              data: { tier: choice },
            });
            setWizardOptions([...customPresets.map(p => `${p.name} - ${p.description}`), "< Back"]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          }

          if (choice === "preset_delete") {
            const presetMode = agentRef.current?.isMultiAgent ? "multi" as const : "single" as const;
            const modeLabel = agentRef.current?.isMultiAgent ? "Multi-Agent" : "Single-Agent";
            const presets = getModelPresets(presetMode);
            const customPresets = presets.filter(p => !BUILT_IN_PRESETS.some(bp => bp.name === p.name));
            if (customPresets.length === 0) {
              addLine({
                type: "error",
                content: `No custom presets available to delete for ${modeLabel} mode.`,
                timestamp: Date.now(),
              });
              setActiveWizard(null);
              setWizardOptions([]);
              setWizardSelectedIndex(0);
              return;
            }
            setActiveWizard({
              type: "model",
              step: 40,
              data: { tier: choice },
            });
            setWizardOptions([...customPresets.map(p => `${p.name} - ${p.description}`), "< Back"]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          }

          if (choice === "configure_tiers") {
            const kbMode = agentRef.current?.isMultiAgent ? "multi" as const : "single" as const;
            const defaultResolved = getResolvedModelWithProvider("", true);
            const rawMaster = kbMode === "multi" ? (getTierModel(kbMode, "master") || "") : "";
            const masterModelFormatted = rawMaster ? getResolvedModelWithProvider(rawMaster, false) : `(use default: ${defaultResolved})`;
            const rawSuperagent = getTierModel(kbMode, "superagent") || "";
            const superagentModelFormatted = rawSuperagent ? getResolvedModelWithProvider(rawSuperagent, false) : `(use default: ${defaultResolved})`;
            const rawSubagent = getTierModel(kbMode, "subagent") || "";
            const subagentModelFormatted = rawSubagent ? getResolvedModelWithProvider(rawSubagent, false) : `(use default: ${defaultResolved})`;
            const rawResearcher = getTierModel(kbMode, "researcher") || "";
            const researcherModelFormatted = rawResearcher ? getResolvedModelWithProvider(rawResearcher, false) : `(use default: ${subagentModelFormatted})`;
            const rawCoder = getTierModel(kbMode, "coder") || "";
            const coderModelFormatted = rawCoder ? getResolvedModelWithProvider(rawCoder, false) : `(use default: ${subagentModelFormatted})`;
            const rawReviewer = getTierModel(kbMode, "reviewer") || "";
            const reviewerModelFormatted = rawReviewer ? getResolvedModelWithProvider(rawReviewer, false) : `(use default: ${subagentModelFormatted})`;
            const rawClassifier = getTierModel(kbMode, "classifier") || "";
            const classifierModelFormatted = rawClassifier ? getResolvedModelWithProvider(rawClassifier, false) : `(use default: ${subagentModelFormatted})`;
            const rawAdvisor = getTierModel(kbMode, "advisor") || "";
            const advisorModelFormatted = rawAdvisor ? getResolvedModelWithProvider(rawAdvisor, false) : `(use default: ${subagentModelFormatted})`;

            setActiveWizard({
              type: "model",
              step: 50,
              data: { ...activeWizard.data },
            });
            setWizardOptions([
              `1. Master Agent (depth 0) (${masterModelFormatted})`,
              `2. Superagent (depth 1) (${superagentModelFormatted})`,
              `3. Subagent (depth 2) (${subagentModelFormatted})`,
              `4. Feature: researcher (${researcherModelFormatted})`,
              `5. Feature: coder (${coderModelFormatted})`,
              `6. Feature: reviewer (${reviewerModelFormatted})`,
              `7. Feature: classifier (${classifierModelFormatted})`,
              `8. Feature: advisor (${advisorModelFormatted})`,
              `9. All Tiers (Overwrite All)`,
              `< Back`
            ]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          }
        }
      } else if (activeWizard.type === "model" && activeWizard.step === 50 && wizardOptions.length > 0) {
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
          return;
        }
        if (key.return) {
          const selectedOpt = (wizardOptions[wizardSelectedIndex] || "").toLowerCase();
          let tier = "";
          if (selectedOpt.includes("master")) tier = "master";
          else if (selectedOpt.includes("superagent")) tier = "superagent";
          else if (selectedOpt.includes("researcher")) tier = "researcher";
          else if (selectedOpt.includes("coder")) tier = "coder";
          else if (selectedOpt.includes("reviewer")) tier = "reviewer";
          else if (selectedOpt.includes("classifier")) tier = "classifier";
          else if (selectedOpt.includes("advisor")) tier = "advisor";
          else if (selectedOpt.includes("subagent")) tier = "subagent";
          else if (selectedOpt.includes("all")) tier = "all";
          else if (selectedOpt.includes("back") || selectedOpt.startsWith("<")) tier = "back";

          if (!tier) return;

          if (tier === "back") {
            const backModeLabel = agentRef?.current?.isMultiAgent ? "Multi-Agent" : "Single-Agent";
            setActiveWizard({
              type: "model",
              step: 1,
              data: {},
            });
            setWizardOptions([
              `1. Load/Apply Model Preset [${backModeLabel}]`,
              `2. List Model Presets [${backModeLabel}]`,
              `3. Create Model Preset [${backModeLabel}]`,
              `4. Edit Model Preset [${backModeLabel}]`,
              `5. Delete Model Preset [${backModeLabel}]`,
              "6. Configure Agent Tier Models"
            ]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          }

          setActiveWizard({
            type: "model",
            step: 2,
            data: { ...activeWizard.data, tier },
          });

          const list = getConfiguredProviders();
          const providerOptions = getProviderOptionsList(list);
          setWizardOptions(providerOptions);
          setWizardSelectedIndex(0);
          setInput("");
          return;
        }
      } else if (activeWizard.type === "model" && [60, 61, 62].includes(activeWizard.step) && wizardOptions.length > 0) {
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
          return;
        }
        if (key.return) {
          const selectedVal = wizardOptions[wizardSelectedIndex];
          if (selectedVal) {
            handleWizardSubmit(selectedVal);
          }
          return;
        }
      } else if (
        activeWizard.type === "model" && 
        (activeWizard.step === 2 || activeWizard.step === 22 || activeWizard.step === 23 || activeWizard.step === 32 || activeWizard.step === 33 || activeWizard.step === 41) && 
        wizardOptions.length > 0
      ) {
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
          return;
        }
        if (key.return) {
          const selectedVal = wizardOptions[wizardSelectedIndex];
          if (selectedVal) {
            handleWizardSubmit(selectedVal);
          }
          return;
        }
      } else if (activeWizard.type === "model" && (activeWizard.step === 3 || activeWizard.step === 4 || activeWizard.step === 15 || activeWizard.step === 24 || activeWizard.step === 25 || activeWizard.step === 30 || activeWizard.step === 34 || activeWizard.step === 35 || activeWizard.step === 40) && wizardOptions.length > 0) {
        const searchQuery = input.trim();
        const filtered = searchQuery
          ? filterSuggestions(wizardOptions, searchQuery)
          : wizardOptions;
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => {
            const currentMax = Math.max(0, filtered.length - 1);
            const clampedPrev = Math.min(prev, currentMax);
            return Math.max(0, clampedPrev - 1);
          });
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => {
            const currentMax = Math.max(0, filtered.length - 1);
            const clampedPrev = Math.min(prev, currentMax);
            return Math.min(currentMax, clampedPrev + 1);
          });
          return;
        }
        if (key.return) {
          const selectedVal = filtered[wizardSelectedIndex] ?? filtered[0];
          if (selectedVal) {
            handleWizardSubmit(selectedVal);
          }
          return;
        }
      } else if (activeWizard.type === "login" && activeWizard.step === 14 && wizardOptions.length > 0) {
        const providerSearchQuery = input.trim();
        const filteredProviders = providerSearchQuery
          ? filterSuggestions(wizardOptions, providerSearchQuery)
          : wizardOptions;
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => {
            const currentMax = Math.max(0, filteredProviders.length - 1);
            const clampedPrev = Math.min(prev, currentMax);
            return Math.max(0, clampedPrev - 1);
          });
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => {
            const currentMax = Math.max(0, filteredProviders.length - 1);
            const clampedPrev = Math.min(prev, currentMax);
            return Math.min(currentMax, clampedPrev + 1);
          });
          return;
        }
        if (key.return) {
          const chosen = filteredProviders[wizardSelectedIndex] ?? filteredProviders[0];
          if (chosen && chosen !== "(no results)") {
            const origIdx = wizardOptions.indexOf(chosen) + 1;
            handleWizardSubmit(String(origIdx));
          }
          return;
        }
      } else if (activeWizard.type === "workspace" && activeWizard.step === 1 && wizardOptions.length > 0) {
        const searchQuery = input.trim();
        const filtered = searchQuery
          ? filterSuggestions(wizardOptions, searchQuery)
          : wizardOptions;
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => {
            const currentMax = Math.max(0, filtered.length - 1);
            const clampedPrev = Math.min(prev, currentMax);
            return Math.max(0, clampedPrev - 1);
          });
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => {
            const currentMax = Math.max(0, filtered.length - 1);
            const clampedPrev = Math.min(prev, currentMax);
            return Math.min(currentMax, clampedPrev + 1);
          });
          return;
        }
        if (key.return) {
          const selectedVal = filtered[wizardSelectedIndex] ?? filtered[0];
          if (selectedVal) {
            handleWizardSubmit(selectedVal);
          }
          return;
        }
      } else if (activeWizard.type === "plan_approve") {
        if (activeWizard.step === 2) {
          // Step 2: custom feedback input — Escape goes back to step 1
          if (isEscape) {
            setWizardOptions([...PLAN_APPROVAL_OPTIONS]);
            setActiveWizard({ ...activeWizard, step: 1 });
            return;
          }
          // Enter and other keys are handled by the text input onSubmit
          return;
        }
        if (key.leftArrow) {
          setActiveWizard((curr: any) => curr ? { ...curr, data: { ...curr.data, focus: "plan" } } : null);
          return;
        }
        if (key.rightArrow) {
          setActiveWizard((curr: any) => curr ? { ...curr, data: { ...curr.data, focus: "actions" } } : null);
          return;
        }
        if (wizardOptions.length > 0) {
          const currentFocus = activeWizard.data?.focus || "actions";
          if (currentFocus === "actions") {
            if (key.upArrow) {
              setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
              return;
            }
            if (key.downArrow) {
              setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
              return;
            }
          }
          if (key.return) {
            if (wizardSelectedIndex === 0) {
              handleWizardSubmit("approve");
            } else if (wizardSelectedIndex === 1) {
              handleWizardSubmit("reject");
            } else {
              // Index 2: Custom Feedback — transition to step 2
              setWizardOptions([]);
              setActiveWizard({ ...activeWizard, step: 2 });
            }
            return;
          }
        }
      } else if (activeWizard.type === "permission" && wizardOptions.length > 0) {
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
          return;
        }
        if (key.return) {
          let approved: boolean | "session" = false;
          if (wizardSelectedIndex === 0) {
            approved = true;
          } else if (wizardSelectedIndex === wizardOptions.length - 1) {
            // Last option is always Deny
            approved = false;
          } else {
            // Middle option(s): "Allow for This Session"
            approved = "session";
          }
          handlePermissionResponse(approved);
          return;
        }
      } else if (activeWizard.type === "question" && wizardOptions.length > 0) {
        if (activeWizard.isMultiSelect && inputChar === " ") {
          setWizardSelectedSet((prev: Set<number>) => {
            const next = new Set<number>(prev);
            if (next.has(wizardSelectedIndex)) {
              next.delete(wizardSelectedIndex);
            } else {
              next.add(wizardSelectedIndex);
            }
            return next;
          });
          return;
        }
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
          return;
        }
        if (key.return) {
          if (activeWizard.isMultiSelect) {
            const selectedList = Array.from(wizardSelectedSet).map(idx => wizardOptions[idx]).filter(Boolean);
            const answer = selectedList.join(", ");
            
            const qList = activeWizard.questions;
            const currIdx = activeWizard.currentQuestionIndex;
            if (qList && currIdx !== undefined && pendingQuestion) {
              const updatedAnswers = [...(activeWizard.answers || [])];
              updatedAnswers[currIdx] = answer;
              
              addLine({
                type: "system",
                content: `❓ Answered: "${answer}"`,
                timestamp: Date.now(),
              });
              
              const nextIdx = currIdx + 1;
              if (nextIdx < qList.length) {
                const nextQ = qList[nextIdx];
                const hasOptions = Array.isArray(nextQ.options) && nextQ.options.length > 0;
                const allOptions = hasOptions ? [...nextQ.options, "Custom..."] : [];
                setPendingQuestion({
                  question: nextQ.question,
                  options: allOptions,
                  resolve: pendingQuestion.resolve,
                });
                setWizardOptions(allOptions);
                
                const nextSavedAns = updatedAnswers[nextIdx] || "";
                if (nextQ.isMultiSelect) {
                  const nextAnsList = nextSavedAns.split(", ").map((x: string) => x.trim());
                  const newSet = new Set<number>();
                  allOptions.forEach((opt, idx) => {
                    if (nextAnsList.includes(opt)) {
                      newSet.add(idx);
                    }
                  });
                  setWizardSelectedSet(newSet);
                  setWizardSelectedIndex(0);
                } else {
                  const optionIdx = nextQ.options.indexOf(nextSavedAns);
                  if (optionIdx >= 0) {
                    setWizardSelectedIndex(optionIdx);
                  } else {
                    setWizardSelectedIndex(0);
                  }
                  setWizardSelectedSet(new Set());
                }
                
                setInput("");
                
                const optionIdx = nextQ.options.indexOf(nextSavedAns);
                const isCustomAnswer = nextSavedAns !== "" && optionIdx < 0;
                
                if (isCustomAnswer && !nextQ.isMultiSelect) {
                  setWizardOptions([]);
                  setWizardSelectedIndex(0);
                  setInput(nextSavedAns);
                  setActiveWizard({
                    ...activeWizard,
                    step: 2,
                    currentQuestionIndex: nextIdx,
                    answers: updatedAnswers,
                    isMultiSelect: nextQ.isMultiSelect,
                  });
                } else {
                  setActiveWizard({
                    ...activeWizard,
                    step: hasOptions ? 1 : 2,
                    currentQuestionIndex: nextIdx,
                    answers: updatedAnswers,
                    isMultiSelect: nextQ.isMultiSelect,
                  });
                }
              } else {
                if (pendingQuestion) {
                  pendingQuestion.resolve(updatedAnswers);
                  setPendingQuestion(null);
                }
                setActiveWizard(null);
                setWizardOptions([]);
                setWizardSelectedIndex(0);
                setWizardSelectedSet(new Set());
              }
              return;
            }

            if (pendingQuestion) {
              pendingQuestion.resolve(answer);
              addLine({
                type: "system",
                content: `❓ Answered: "${answer}"`,
                timestamp: Date.now(),
              });
              setPendingQuestion(null);
              setActiveWizard(null);
              setWizardOptions([]);
              setWizardSelectedIndex(0);
              setWizardSelectedSet(new Set());
            }
            return;
          }
          const selectedOption = wizardOptions[wizardSelectedIndex];
          if (pendingQuestion) {
            if (selectedOption === "Custom...") {
              setActiveWizard({
                ...activeWizard,
                step: 2,
                data: { question: pendingQuestion?.question || "" },
              });
              setWizardOptions([]);
              setWizardSelectedIndex(0);
              setInput("");
              return;
            }
            
            const qList = activeWizard.questions;
            const currIdx = activeWizard.currentQuestionIndex;
            if (qList && currIdx !== undefined && pendingQuestion) {
              const updatedAnswers = [...(activeWizard.answers || [])];
              updatedAnswers[currIdx] = selectedOption;
              
              addLine({
                type: "system",
                content: `❓ Answered: "${selectedOption}"`,
                timestamp: Date.now(),
              });
              
              const nextIdx = currIdx + 1;
              if (nextIdx < qList.length) {
                const nextQ = qList[nextIdx];
                const hasOptions = Array.isArray(nextQ.options) && nextQ.options.length > 0;
                const allOptions = hasOptions ? [...nextQ.options, "Custom..."] : [];
                setPendingQuestion({
                  question: nextQ.question,
                  options: allOptions,
                  resolve: pendingQuestion.resolve,
                });
                setWizardOptions(allOptions);
                
                const nextSavedAns = updatedAnswers[nextIdx] || "";
                if (nextQ.isMultiSelect) {
                  const nextAnsList = nextSavedAns.split(", ").map((x: string) => x.trim());
                  const newSet = new Set<number>();
                  allOptions.forEach((opt, idx) => {
                    if (nextAnsList.includes(opt)) {
                      newSet.add(idx);
                    }
                  });
                  setWizardSelectedSet(newSet);
                  setWizardSelectedIndex(0);
                } else {
                  const optionIdx = nextQ.options.indexOf(nextSavedAns);
                  if (optionIdx >= 0) {
                    setWizardSelectedIndex(optionIdx);
                  } else {
                    setWizardSelectedIndex(0);
                  }
                  setWizardSelectedSet(new Set());
                }
                
                setInput("");
                
                const optionIdx = nextQ.options.indexOf(nextSavedAns);
                const isCustomAnswer = nextSavedAns !== "" && optionIdx < 0;
                
                if (isCustomAnswer && !nextQ.isMultiSelect) {
                  setWizardOptions([]);
                  setWizardSelectedIndex(0);
                  setInput(nextSavedAns);
                  setActiveWizard({
                    ...activeWizard,
                    step: 2,
                    currentQuestionIndex: nextIdx,
                    answers: updatedAnswers,
                    isMultiSelect: nextQ.isMultiSelect,
                  });
                } else {
                  setActiveWizard({
                    ...activeWizard,
                    step: hasOptions ? 1 : 2,
                    currentQuestionIndex: nextIdx,
                    answers: updatedAnswers,
                    isMultiSelect: nextQ.isMultiSelect,
                  });
                }
              } else {
                if (pendingQuestion) {
                  pendingQuestion.resolve(updatedAnswers);
                  setPendingQuestion(null);
                }
                setActiveWizard(null);
                setWizardOptions([]);
                setWizardSelectedIndex(0);
                setWizardSelectedSet(new Set());
              }
              return;
            }

            pendingQuestion.resolve(selectedOption);
            addLine({
              type: "system",
              content: `❓ Answered: "${selectedOption}"`,
              timestamp: Date.now(),
            });
            setPendingQuestion(null);
            setActiveWizard(null);
            setWizardOptions([]);
            setWizardSelectedIndex(0);
          }
          return;
        }
      } else if (activeWizard.type === "resume" && wizardOptions.length > 0) {
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
          return;
        }
        if (key.return) {
          const isMulti = agentRef.current?.isMultiAgent || false;
          const sessions = listHistorySessions(isMulti, false, undefined, 20).slice(0, 10);
          const chosen = sessions[wizardSelectedIndex];
          if (!chosen) return;
          const now = Date.now();
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          if (agentRef.current) {
            agentRef.current.loadHistoryFromPath(chosen.filePath)
              .then(() => {
                const msgs = agentRef.current!.getHistory().getMessages();
                const loadedLines = reconstructChatLines(msgs);
                const userInputs = msgs.filter(m => m.role === "user" && m.content && !contentToString(m.content).startsWith("[RMemory Agent Memory Context]:")).map(m => contentToString(m.content));
                setLines(loadedLines);
                setHistory(userInputs);
                setScrollOffset(0);
                if (agentRef.current) setPlanState(agentRef.current.planState);
                addLine({ type: "system", content: `✓ Session resumed: ${chosen.displayName} (${msgs.length} messages)`, timestamp: now });
              })
              .catch((err: any) => {
                addLine({ type: "error", content: `Failed to resume session: ${err.message}`, timestamp: now });
              });
          }
          return;
        }
      } else if (activeWizard.type === "checkpoint" && activeWizard.step === 1 && wizardOptions.length > 0) {
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
          return;
        }
        if (key.return) {
          const chosen = checkpointsList[wizardSelectedIndex];
          if (!chosen) return;
          const now = Date.now();
          const action = activeWizard.data.action || "browse";

          // "browse" mode: show action sub-menu (Restore or Delete)
          if (action === "browse") {
            setActiveWizard({ type: "checkpoint", step: 1, data: { action: "choose", checkpointIndex: String(wizardSelectedIndex) } });
            setWizardOptions(["🔄 Restore this checkpoint", "🗑️ Delete this checkpoint"]);
            setWizardSelectedIndex(0);
            return;
          }

          // "choose" sub-menu: user picked Restore or Delete
          if (action === "choose") {
            const chkIndex = parseInt(activeWizard.data.checkpointIndex || "0", 10);
            const targetChk = checkpointsList[chkIndex];
            if (!targetChk) return;

            if (wizardSelectedIndex === 0) {
              // Restore selected → check git
              if (targetChk.gitSha) {
                setActiveWizard({ type: "checkpoint", step: 2, data: { checkpointIndex: String(chkIndex) } });
                setWizardOptions(["✓ Yes, restore workspace to this commit (git stash & checkout)", "✗ No, only restore conversation history"]);
                setWizardSelectedIndex(0);
                return;
              }
              // No git → direct restore
              const sessionPath = agentRef.current?.getCurrentHistoryFilePath();
              if (!sessionPath) return;
              const checkpointsDir = path.join(path.dirname(sessionPath), "checkpoints");
              const chkPath = path.join(checkpointsDir, `checkpoint_${targetChk.timestamp}.json`);
              terminateActiveTasksAndSubagents();
              restoreCheckpoint(chkPath, sessionPath)
                .then(async () => {
                  if (agentRef.current) {
                    await agentRef.current.loadHistoryFromPath(sessionPath);
                    const msgs = agentRef.current.getHistory().getMessages();
                    const loadedLines = reconstructChatLines(msgs);
                    const userInputs = msgs.filter(m => m.role === "user" && m.content && !contentToString(m.content).startsWith("[RMemory Agent Memory Context]:")).map(m => contentToString(m.content));
                    setLines(loadedLines);
                    setHistory(userInputs);
                    setScrollOffset(0);
                    setPlanState(agentRef.current.planState);
                  }
                  addLine({ type: "system", content: `✓ Checkpoint "${targetChk.name}" restored successfully! (${targetChk.messages.length} messages)`, timestamp: now });
                })
                .catch((err: any) => {
                  addLine({ type: "error", content: `Failed to restore checkpoint: ${err.message}`, timestamp: now });
                });
              setActiveWizard(null);
              setWizardOptions([]);
              setWizardSelectedIndex(0);
              setCheckpointsList([]);
              return;
            } else {
              // Delete selected
              const sessionPath = agentRef.current?.getCurrentHistoryFilePath();
              if (!sessionPath) return;
              deleteCheckpointById(targetChk.id, sessionPath)
                .then((deleted) => {
                  if (deleted) {
                    addLine({ type: "system", content: `✓ Checkpoint "${targetChk.name}" deleted successfully.`, timestamp: Date.now() });
                  } else {
                    addLine({ type: "error", content: `Failed to delete checkpoint "${targetChk.name}".`, timestamp: Date.now() });
                  }
                })
                .catch((err: any) => {
                  addLine({ type: "error", content: `Failed to delete checkpoint: ${err.message}`, timestamp: Date.now() });
                });
              setActiveWizard(null);
              setWizardOptions([]);
              setWizardSelectedIndex(0);
              setCheckpointsList([]);
              return;
            }
          }

          // "restore" mode (direct from /checkpoint restore wizard)
          if (action === "restore") {
            if (chosen.gitSha) {
              setActiveWizard({ type: "checkpoint", step: 2, data: { checkpointIndex: String(wizardSelectedIndex) } });
              setWizardOptions(["✓ Yes, restore workspace to this commit (git stash & checkout)", "✗ No, only restore conversation history"]);
              setWizardSelectedIndex(0);
              return;
            }
            const sessionPath = agentRef.current?.getCurrentHistoryFilePath();
            if (!sessionPath) return;
            const checkpointsDir = path.join(path.dirname(sessionPath), "checkpoints");
            const chkPath = path.join(checkpointsDir, `checkpoint_${chosen.timestamp}.json`);
            terminateActiveTasksAndSubagents();
            restoreCheckpoint(chkPath, sessionPath)
              .then(async () => {
                if (agentRef.current) {
                  await agentRef.current.loadHistoryFromPath(sessionPath);
                  const msgs = agentRef.current.getHistory().getMessages();
                  const loadedLines = reconstructChatLines(msgs);
                  const userInputs = msgs.filter(m => m.role === "user" && m.content && !contentToString(m.content).startsWith("[RMemory Agent Memory Context]:")).map(m => contentToString(m.content));
                  setLines(loadedLines);
                  setHistory(userInputs);
                  setScrollOffset(0);
                  setPlanState(agentRef.current.planState);
                }
                addLine({ type: "system", content: `✓ Checkpoint "${chosen.name}" restored successfully! (${chosen.messages.length} messages)`, timestamp: now });
              })
              .catch((err: any) => {
                addLine({ type: "error", content: `Failed to restore checkpoint: ${err.message}`, timestamp: now });
              });
            setActiveWizard(null);
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            setCheckpointsList([]);
            return;
          }

          // "delete" mode (direct from /checkpoint delete wizard)
          if (action === "delete") {
            const sessionPath = agentRef.current?.getCurrentHistoryFilePath();
            if (!sessionPath) return;
            deleteCheckpointById(chosen.id, sessionPath)
              .then((deleted) => {
                if (deleted) {
                  addLine({ type: "system", content: `✓ Checkpoint "${chosen.name}" deleted successfully.`, timestamp: Date.now() });
                } else {
                  addLine({ type: "error", content: `Failed to delete checkpoint "${chosen.name}".`, timestamp: Date.now() });
                }
              })
              .catch((err: any) => {
                addLine({ type: "error", content: `Failed to delete checkpoint: ${err.message}`, timestamp: Date.now() });
              });
            setActiveWizard(null);
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            setCheckpointsList([]);
            return;
          }

          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setCheckpointsList([]);
        }
      } else if (activeWizard.type === "checkpoint" && activeWizard.step === 2) {
        // Git restore confirmation step
        if (key.upArrow) {
          setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
          return;
        }
        if (key.return) {
          const chkIndex = parseInt(activeWizard.data.checkpointIndex || "0", 10);
          const chosen = checkpointsList[chkIndex];
          if (!chosen) return;
          const now = Date.now();
          const doGitRestore = wizardSelectedIndex === 0;
          const sessionPath = agentRef.current?.getCurrentHistoryFilePath();
          if (!sessionPath) return;

          const checkpointsDir = path.join(path.dirname(sessionPath), "checkpoints");
          const chkPath = path.join(checkpointsDir, `checkpoint_${chosen.timestamp}.json`);

          terminateActiveTasksAndSubagents();

          (async () => {
            try {
              if (doGitRestore && chosen.gitSha) {
                try {
                  const { execa: execaFn } = await import("execa");
                  const targetCwd = agentRef.current?.workingDirectory || process.cwd();
                  await execaFn("git", ["stash", "--include-untracked"], { cwd: targetCwd, reject: false });
                  const checkoutRes = await execaFn("git", ["checkout", chosen.gitSha], { cwd: targetCwd, reject: false });
                  if (checkoutRes.failed) {
                    addLine({ type: "error", content: `Git restore failed: ${checkoutRes.stderr || checkoutRes.message}. Conversation history still restored.`, timestamp: now });
                  } else {
                    addLine({ type: "system", content: `✓ Workspace restored to Git commit: ${chosen.gitSha} (uncommitted changes stashed)`, timestamp: now });
                  }
                } catch (gitErr: any) {
                  addLine({ type: "error", content: `Git restore failed: ${gitErr.message}. Conversation history still restored.`, timestamp: now });
                }
              }

              await restoreCheckpoint(chkPath, sessionPath);
               if (agentRef.current) {
                await agentRef.current.loadHistoryFromPath(sessionPath);
                const msgs = agentRef.current.getHistory().getMessages();
                const loadedLines = reconstructChatLines(msgs);
                const userInputs = msgs.filter(m => m.role === "user" && m.content && !contentToString(m.content).startsWith("[RMemory Agent Memory Context]:")).map(m => contentToString(m.content));
                setLines(loadedLines);
                setHistory(userInputs);
                setScrollOffset(0);
                setPlanState(agentRef.current.planState);
              }
              addLine({ type: "system", content: `✓ Checkpoint "${chosen.name}" restored successfully! (${chosen.messages.length} messages)`, timestamp: now });
            } catch (err: any) {
              addLine({ type: "error", content: `Failed to restore checkpoint: ${err.message}`, timestamp: now });
            }
          })();

          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setCheckpointsList([]);
          return;
        }
      } else if (activeWizard.type === "skills" && wizardOptions.length > 0) {
        if (activeWizard.step === 1) {
          const searchQuery = input.trim();
          const filteredOptions = searchQuery
            ? filterSuggestions(wizardOptions, searchQuery)
            : wizardOptions;

          if (key.upArrow) {
            setWizardSelectedIndex((prev) => {
              const currentMax = Math.max(0, filteredOptions.length - 1);
              const clampedPrev = Math.min(prev, currentMax);
              return Math.max(0, clampedPrev - 1);
            });
            return;
          }
          if (key.downArrow) {
            setWizardSelectedIndex((prev) => {
              const currentMax = Math.max(0, filteredOptions.length - 1);
              const clampedPrev = Math.min(prev, currentMax);
              return Math.min(currentMax, clampedPrev + 1);
            });
            return;
          }
          if (key.return) {
            const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filteredOptions.length - 1));
            const selectedOption = filteredOptions[clampedIndex];
            if (!selectedOption || selectedOption === "(no results)") return;

            const skillsList = getInstalledSkills();
            const originalIndex = skillsList.findIndex((s) => {
              const provider = s.author || "local";
              return selectedOption.startsWith(`• ${provider}/${s.name}`);
            });

            if (originalIndex !== -1) {
              setActiveWizard({
                type: "skills",
                step: 2,
                data: { skillIndex: String(originalIndex) },
              });
              setWizardOptions([
                "✓ Use / Activate Skill",
                "ℹ View Details",
                "← Back to List",
              ]);
              setWizardSelectedIndex(0);
              setInput(""); // Clear search input query
            }
            return;
          }
        } else {
          // step === 2 logic:
          if (key.upArrow) {
            setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
            return;
          }
          if (key.downArrow) {
            setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
            return;
          }
          if (key.return) {
            const skillIndex = parseInt(activeWizard.data.skillIndex || "0", 10);
            const skillsList = getInstalledSkills();
            const chosen = skillsList[skillIndex];
            if (!chosen) return;

            if (wizardSelectedIndex === 0) {
              const now = Date.now();
              const slug = chosen.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
              addLine({
                type: "user",
                content: `❯ /skill-${slug}`,
                timestamp: now,
              });
              addLine({
                type: "system",
                content: `Activating skill "${chosen.name}"...\nInstruction path: ${chosen.path}`,
                timestamp: now,
              });
              setIsProcessing(true);
              agentRef.current?.sendMessage(
                `I would like you to use the following skill: "${chosen.name}".\nPlease read its instruction file at "${chosen.path}" using a file read tool first, and then help me with my request based on its instructions.`
              ).catch((err: any) => {
                addLine({ type: "error", content: `Skill activation error: ${err.message}`, timestamp: Date.now() });
              });

              setActiveWizard(null);
              setWizardOptions([]);
              setWizardSelectedIndex(0);
            } else if (wizardSelectedIndex === 1) {
              const now = Date.now();
              const provider = chosen.author || "local";
              const detailLines = [
                "┌───[ 📂 INSTALLED AGENT SKILLS ]",
                `│  • Name        : ${provider}/${chosen.name}`,
                `│    Description : ${chosen.description}`,
                `│    Path        : ${chosen.path}`,
                "└──────────────────────────────────────────────",
              ];
              addLine({
                type: "system",
                content: detailLines.join("\n"),
                timestamp: now,
              });
            } else {
              const options = skillsList.map((s) => {
                const provider = s.author || "local";
                return `• ${provider}/${s.name} - ${s.description.slice(0, 50)}${s.description.length > 50 ? "..." : ""}`;
              });
              setActiveWizard({
                type: "skills",
                step: 1,
                data: {},
              });
              setWizardOptions(options);
              setWizardSelectedIndex(skillIndex);
            }
            return;
          }
        }
      }
    }

    if (isCtrlC) {
      // Note: wizard-active case already handled at top of useInput callback
      if (stopRunningSubagents() > 0) {
        agentRef.current?.abort();
        setIsProcessing(false);
        return;
      }
      if (isProcessing || agentRef.current?.isAgentRunning() || agentRef.current?.wasRunningBeforeAbort) {
        agentRef.current?.abort();
        setIsProcessing(false);
        return;
      } else {
        setActiveWizard({
          type: "exit_confirm",
          step: 1,
          data: {},
        });
        setWizardOptions(["No, keep working", "Yes, exit"]);
        setWizardSelectedIndex(0);
      }
    }

    if (!activeWizard || activeWizard.type !== "plan_approve") {
      if (key.pageUp) {
        scrollChat("up", 10);
        if (focusMode === "input") setFocusMode("chat");
        return;
      } else if ((key.ctrl && key.upArrow) || (key.shift && key.upArrow)) {
        scrollChat("up", 1);
        if (focusMode === "input") setFocusMode("chat");
        return;
      }

      if (key.pageDown) {
        scrollChat("down", 10);
        if (focusMode === "input") setFocusMode("chat");
        return;
      } else if ((key.ctrl && key.downArrow) || (key.shift && key.downArrow)) {
        scrollChat("down", 1);
        if (focusMode === "input") setFocusMode("chat");
        return;
      }
    }

    if (isProcessing && !activeWizard) {
      if (key.upArrow) {
        scrollChat("up");
        return;
      }
      if (key.downArrow) {
        scrollChat("down");
        return;
      }
    }

    if (isEscape) {
      // Always reset scroll when ESC is pressed — regardless of other conditions.
      if (scrollOffset > 0) {
        setScrollOffset(0);
      }

      if (scrollOffset > 0 && !activeWizard && !isProcessing && !agentRef.current?.isAgentRunning() && !agentRef.current?.wasRunningBeforeAbort) {
        // Only scroll reset needed — nothing else to do.
      } else if (activeWizard) {
        if (activeWizard.type === "question" && activeWizard.questions && activeWizard.currentQuestionIndex !== undefined && activeWizard.currentQuestionIndex > 0) {
          const prevIndex = activeWizard.currentQuestionIndex - 1;
          const prevQ = activeWizard.questions[prevIndex];
          const hasOptions = Array.isArray(prevQ.options) && prevQ.options.length > 0;
          const allOptions = hasOptions ? [...prevQ.options, "Custom..."] : [];
          
          if (pendingQuestion) {
            setPendingQuestion({
              question: prevQ.question,
              options: allOptions,
              resolve: pendingQuestion.resolve,
            });
          }
          
          setWizardOptions(allOptions);
          
          const prevAns = activeWizard.answers?.[prevIndex] || "";
          if (prevQ.isMultiSelect) {
            const prevAnsList = prevAns.split(", ").map(x => x.trim());
            const newSet = new Set<number>();
            allOptions.forEach((opt, idx) => {
              if (prevAnsList.includes(opt)) {
                newSet.add(idx);
              }
            });
            setWizardSelectedSet(newSet);
            setWizardSelectedIndex(0);
            setActiveWizard({
              ...activeWizard,
              step: 1,
              currentQuestionIndex: prevIndex,
              isMultiSelect: prevQ.isMultiSelect,
            });
          } else {
            const optionIdx = prevQ.options.indexOf(prevAns);
            if (optionIdx >= 0) {
              setWizardSelectedIndex(optionIdx);
              setWizardSelectedSet(new Set());
              setActiveWizard({
                ...activeWizard,
                step: 1,
                currentQuestionIndex: prevIndex,
                isMultiSelect: prevQ.isMultiSelect,
              });
            } else if (prevAns !== "") {
              setWizardOptions([]);
              setWizardSelectedIndex(0);
              setWizardSelectedSet(new Set());
              setInput(prevAns);
              setActiveWizard({
                ...activeWizard,
                step: 2,
                currentQuestionIndex: prevIndex,
                isMultiSelect: prevQ.isMultiSelect,
              });
            } else {
              setWizardSelectedIndex(0);
              setWizardSelectedSet(new Set());
              setActiveWizard({
                ...activeWizard,
                step: hasOptions ? 1 : 2,
                currentQuestionIndex: prevIndex,
                isMultiSelect: prevQ.isMultiSelect,
              });
            }
          }
          return;
        }

        if (activeWizard.type === "model" && activeWizard.step !== 1) {
          if (activeWizard.step === 50) {
            handleWizardSubmit("back");
          } else {
            handleWizardSubmit("< Back");
          }
          return;
        } else if (activeWizard.type === "checkpoint" && activeWizard.step === 2) {
          setActiveWizard({ type: "checkpoint", step: 1, data: { action: "browse" } });
          const listOptions = checkpointsList.map((c: any) => `${c.name} (${new Date(c.timestamp).toLocaleString()}) - ${c.messages.length} messages`);
          setWizardOptions(listOptions);
          setWizardSelectedIndex(0);
          return;
        } else if (activeWizard.type === "skills" && activeWizard.step === 2) {
          const skillsList = getInstalledSkills();
          const options = skillsList.map((s) => {
            const provider = s.author || "local";
            return `• ${provider}/${s.name} - ${s.description.slice(0, 50)}${s.description.length > 50 ? "..." : ""}`;
          });
          const skillIndex = parseInt(activeWizard.data.skillIndex || "0", 10);
          setActiveWizard({
            type: "skills",
            step: 1,
            data: {},
          });
          setWizardOptions(options);
          setWizardSelectedIndex(skillIndex);
          setInput(""); // Clear input when returning to search
          return;
        } else if (activeWizard.type === "login") {
          if (activeWizard.step === 2) {
            // Back to step 1: Provider Manager main menu
            setActiveWizard({ type: "login", step: 1, data: {} });
            setWizardOptions(["1. List Configured Providers", "2. Create / Log in to a Provider", "3. Delete / Remove a Provider", "4. Edit an Existing Provider"]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          } else if (activeWizard.step === 14) {
            // Back to step 1: Provider Manager main menu
            setActiveWizard({ type: "login", step: 1, data: {} });
            setWizardOptions(["1. List Configured Providers", "2. Create / Log in to a Provider", "3. Delete / Remove a Provider", "4. Edit an Existing Provider"]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          } else if (activeWizard.step === 15) {
            // Back to step 14: Provider delete list
            const list = getConfiguredProviders();
            setActiveWizard({ type: "login", step: 14, data: {} });
            setWizardOptions(list.map(
              (p, i) => `${i + 1}. ${p.name} [${p.type || "unknown"}]${p.baseUrl ? ` (${p.baseUrl})` : ""}`
            ));
            setWizardSelectedIndex(0);
            setInput("");
            return;
          } else if (activeWizard.step === 17) {
            // Back to step 1: Provider Manager main menu
            setActiveWizard({ type: "login", step: 1, data: {} });
            setWizardOptions(["1. List Configured Providers", "2. Create / Log in to a Provider", "3. Delete / Remove a Provider", "4. Edit an Existing Provider"]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          } else if (activeWizard.step === 18) {
            // Back to step 17: Select provider to edit
            const list = getConfiguredProviders();
            setActiveWizard({ type: "login", step: 17, data: {} });
            setWizardOptions(list.map(
              (p, i) => `${i + 1}. ${p.name} [${p.type || "unknown"}]${p.baseUrl ? ` (${p.baseUrl})` : ""}`
            ));
            setWizardSelectedIndex(0);
            setInput("");
            return;
          } else if (activeWizard.step === 19) {
            // Back to step 18: Enter new API Key
            const masked = activeWizard.data.providerApiKey
              ? (activeWizard.data.providerApiKey.length <= 8 ? "*".repeat(activeWizard.data.providerApiKey.length) : `${activeWizard.data.providerApiKey.slice(0, 4)}...${activeWizard.data.providerApiKey.slice(-4)}`)
              : "None";
            addLine({
              type: "system",
              content: `Editing provider: ${activeWizard.data.providerName} [${activeWizard.data.providerType}]\nCurrent API Key: ${masked}\nCurrent Base URL: ${activeWizard.data.providerBaseUrl || "None"}\n\nEnter new API Key (or press Enter to keep current):`,
              timestamp: Date.now(),
            });
            setActiveWizard({
              type: "login",
              step: 18,
              data: {
                ...activeWizard.data,
              },
            });
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          } else if (activeWizard.step === 3) {
            // Back to step 2: Select provider template
            setActiveWizard({ type: "login", step: 2, data: {} });
            setWizardOptions(["1. OpenRouter (Recommended)", "2. OpenAI", "3. Anthropic", "4. Custom OpenAI Endpoint", "5. Custom Anthropic Endpoint", "6. Google Gemini"]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          } else if (activeWizard.step === 4) {
            // Back to step 3: Profile name (preserve provider)
            setActiveWizard({ type: "login", step: 3, data: { provider: activeWizard.data.provider } });
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          } else if (activeWizard.step === 5) {
            // Back to step 4 (custom with baseUrl) or step 3 (non-custom)
            if (activeWizard.data.baseUrl || activeWizard.data.provider === "custom" || activeWizard.data.provider === "custom-anthropic") {
              setActiveWizard({ type: "login", step: 4, data: { provider: activeWizard.data.provider, name: activeWizard.data.name } });
            } else {
              setActiveWizard({ type: "login", step: 3, data: { provider: activeWizard.data.provider } });
            }
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          } else if (activeWizard.step === 7) {
            // Back to step 6 (if fromList) or step 19 (if isEdit) or step 5 (new provider)
            if (activeWizard.data.fromList === "true") {
              const providers = getProviders().filter(p => p.apiKey && p.apiKey.trim() !== "");
              setActiveWizard({ type: "login", step: 6, data: {} });
              setWizardOptions(providers.map(
                (p, i) => `${i + 1}. ${p.name} [${p.provider}]${p.baseUrl ? ` (${p.baseUrl})` : ""}`
              ));
            } else if (activeWizard.data.isEdit === "true") {
              setActiveWizard({
                type: "login",
                step: 19,
                data: activeWizard.data,
              });
              setWizardOptions([]);
            } else {
              setActiveWizard({
                type: "login",
                step: 5,
                data: {
                  provider: activeWizard.data.providerType,
                  name: activeWizard.data.providerName,
                  baseUrl: activeWizard.data.providerBaseUrl,
                }
              });
              setWizardOptions([]);
            }
            setWizardSelectedIndex(0);
            setInput("");
            return;
          } else if (activeWizard.step === 11) {
            // Back to step 10: Tech stack selection
            setActiveWizard({ type: "login", step: 10, data: activeWizard.data });
            setWizardOptions(["1. TypeScript (Recommended)", "2. JavaScript", "3. Python", "4. Rust", "5. Go", "6. AI-Assisted Initialization"]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          } else if (activeWizard.step === 12) {
            // Back to step 11: Project name
            setActiveWizard({ type: "login", step: 11, data: activeWizard.data });
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          } else if (activeWizard.step === 13) {
            // Back to step 10: Tech stack selection
            setActiveWizard({ type: "login", step: 10, data: activeWizard.data });
            setWizardOptions(["1. TypeScript (Recommended)", "2. JavaScript", "3. Python", "4. Rust", "5. Go", "6. AI-Assisted Initialization"]);
            setWizardSelectedIndex(0);
            setInput("");
            return;
          }
          // Step 1 and Step 10: fall through to cancel wizard below
        }

        if (activeWizard.step !== 1) {
          const backOption = wizardOptions.find(opt => {
            const trimmed = opt.trim();
            const clean = trimmed.startsWith("•") ? trimmed.slice(1).trim() : trimmed;
            return clean === "< Back" || clean === "Back" || clean.toLowerCase() === "< back" || clean.toLowerCase() === "back";
          });
          if (backOption) {
            handleWizardSubmit(backOption);
            return;
          }
        }

        const needsAbort = activeWizard.type === "permission" || activeWizard.type === "question" || activeWizard.type === "plan_approve";
        if (pendingPermission) {
          pendingPermission.resolve(false);
          setPendingPermission(null);
        }
        if (pendingQuestion) {
          pendingQuestion.resolve("__CANCEL__");
          setPendingQuestion(null);
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setCheckpointsList([]);
        addLine({
          type: "system",
          content: "Wizard cancelled.",
          timestamp: Date.now(),
        });
        if (needsAbort) {
          if (activeWizard.type === "plan_approve") {
            setPlanState("IDLE");
            if (agentRef.current) {
              agentRef.current.planState = "IDLE";
            }
          }
          stopRunningSubagents();
          agentRef.current?.abort();
          setIsProcessing(false);
        }
      } else if (isProcessing || agentRef.current?.isAgentRunning() || agentRef.current?.wasRunningBeforeAbort) {
        if (stopRunningSubagents() > 0) {
          agentRef.current?.abort();
          setIsProcessing(false);
          return;
        }
        agentRef.current?.abort();
        setIsProcessing(false);
      } else {
        setInput("");
        setIsPasted(false);
        setHistoryIndex(-1);
      }
    }

    const { inserted: currentInserted } = getPasteSplit(input, pastePrefixLength, pasteSuffixLength);
    const isPasteActive = isPasted && (currentInserted.length > 200 || currentInserted.includes("\n"));

    if (isEscape) {
      if (isPasteActive) {
        setInput("");
        setIsPasted(false);
        setHistoryIndex(-1);
        return;
      }
    }

    if (key.upArrow && !isProcessing && history.length > 0) {
      let newIndex = historyIndex;
      if (historyIndex === -1) {
        setTempInput(input);
        newIndex = history.length - 1;
      } else if (historyIndex > 0) {
        newIndex = historyIndex - 1;
      }
      setHistoryIndex(newIndex);
      setInput(history[newIndex]);
      setIsPasted(false);
      return;
    }

    if (key.downArrow && !isProcessing) {
      if (historyIndex !== -1) {
        if (historyIndex === history.length - 1) {
          setHistoryIndex(-1);
          setInput(tempInput);
          setIsPasted(false);
        } else {
          const newIndex = historyIndex + 1;
          setHistoryIndex(newIndex);
          setInput(history[newIndex]);
          setIsPasted(false);
        }
      }
      return;
    }

    if (key.tab && !isProcessing) {
      if (input.startsWith("/") || input.startsWith("!")) {
        if (suggestions && suggestions.length > 0) {
          if (!lastTabPrefix) {
            setLastTabPrefix(input);
          }
          const currentMatchIndex = suggestions.indexOf(input);
          let nextIndex = 0;
          if (currentMatchIndex !== -1) {
            nextIndex = (currentMatchIndex + 1) % suggestions.length;
          }
          if (suggestions.length === 1) {
            setInput(suggestions[0] + " ");
            setLastTabPrefix(null);
          } else {
            setInput(suggestions[nextIndex]);
          }
          if (setIsPasted) {
            setIsPasted(false);
          }
          return;
        }

        const query = input;
        const matching = commands.filter((c) => c.startsWith(query));
        if (matching.length === 1 && matching[0]) {
          setInput(matching[0] + " ");
          setLastTabPrefix(null);
        } else if (matching.length > 1) {
          let commonPrefix = query;
          let possible = true;
          while (possible) {
            const nextChar = matching[0]?.[commonPrefix.length];
            if (!nextChar) break;
            for (let i = 1; i < matching.length; i++) {
              if (matching[i]?.[commonPrefix.length] !== nextChar) {
                possible = false;
                break;
              }
            }
            if (possible) {
              commonPrefix += nextChar;
            }
          }
          if (commonPrefix !== query) {
            setInput(commonPrefix);
            setLastTabPrefix(commonPrefix);
          } else {
            const list = matching.join("  ");
            addLine({
              type: "system",
              content: list,
              timestamp: Date.now(),
            });
            setLastTabPrefix(query);
          }
        }
      }
    }
  };

  const stableHandler = useCallback((inputChar: string, key: any) => {
    handlerRef.current?.(inputChar, key);
  }, []);

  useInput(stableHandler);

  // Small y/n listener for permission wizard
  const permHandlerRef = useRef<(inputChar: string) => void>();
  permHandlerRef.current = (inputChar) => {
    if (inputChar === "y" || inputChar === "Y") {
      handlePermissionResponse(true);
    } else if (inputChar === "n" || inputChar === "N") {
      handlePermissionResponse(false);
    } else if (inputChar === "s" || inputChar === "S") {
      handlePermissionResponse("session");
    }
  };

  const stablePermHandler = useCallback((inputChar: string, key: any) => {
    permHandlerRef.current?.(inputChar);
  }, []);

  useInput(
    stablePermHandler,
    { isActive: activeWizard?.type === "permission" }
  );
}
