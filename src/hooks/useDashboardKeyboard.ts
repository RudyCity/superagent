import React from "react";
import { useInput } from "ink";
import fs from "fs";
import { getPasteSplit, filterSuggestions, getActiveCommandContext } from "../utils/text.js";
import { subagentInstances, backgroundTasks, isTaskInWorkspace } from "../core/tools/state.js";
import { getConfiguredProviders, getProviders } from "../core/config.js";
import { listCheckpointsForSession } from "../core/checkpoints.js";
import type { Agent } from "../core/agent.js";
import { PLAN_APPROVAL_OPTIONS } from "../components/plan-approval-dialog.js";
import { PROVIDER_TEMPLATE_LABELS } from "../core/loginWizardLogic.js";

export interface DashboardKeyboardContext {
  exit: () => void;
  stopAllRunningAgents: () => number;
  setCurrentTask: React.Dispatch<React.SetStateAction<string>>;
  setIsHistoryTruncated: React.Dispatch<React.SetStateAction<boolean>>;
  query: string;
  setQuery: React.Dispatch<React.SetStateAction<string>>;
  pastePrefixLength: number;
  pasteSuffixLength: number;
  isPasted: boolean;
  setIsPasted: React.Dispatch<React.SetStateAction<boolean>>;
  handleQuerySubmit: (val: string) => void;
  activeWizard: any;
  setActiveWizard: React.Dispatch<React.SetStateAction<any>>;
  focusArea: "list" | "logs" | "input" | "checklist" | "agents" | "procs";
  setFocusArea: React.Dispatch<React.SetStateAction<"list" | "logs" | "input" | "checklist" | "agents" | "procs">>;
  setLogScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  history: string[];
  historyIndex: number;
  setHistoryIndex: React.Dispatch<React.SetStateAction<number>>;
  tempInput: string;
  setTempInput: React.Dispatch<React.SetStateAction<string>>;
  wizardSelectedIndex: number;
  setWizardSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  wizardAllOptions: string[];
  wizardOptions: string[];
  wizardSelectedSet: Set<number>;
  setWizardSelectedSet: React.Dispatch<React.SetStateAction<Set<number>>>;
  setWizardOptions: React.Dispatch<React.SetStateAction<string[]>>;
  setWizardAllOptions: React.Dispatch<React.SetStateAction<string[]>>;
  setWizardIsLoadingModels: React.Dispatch<React.SetStateAction<boolean>>;
  pendingQuestion: any;
  setPendingQuestion: React.Dispatch<React.SetStateAction<any>>;
  suggestions: string[];
  planState: string;
  checklistTasks: any[];
  completedHistory?: any[];
  runningSubagentsCount: number;
  runningTasksCount: number;
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  sessions: any[];
  selectedIndex: number;
  wrappedLines: React.ReactNode[];
  logsCount: number;
  setChecklistScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  maxChecklistVisible: number;
  setAgentsScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  maxAgentsVisible: number;
  procsScrollOffset: number;
  setProcsScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  maxProcsVisible: number;
  procsSelectedIndex: number;
  setProcsSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  isProcessing?: boolean;
  setIsProcessing?: React.Dispatch<React.SetStateAction<boolean>>;
  setMasterLogs?: React.Dispatch<React.SetStateAction<string[]>>;
  lastTabPrefix?: string | null;
  queryCursorOffset?: number;
  setLastTabPrefix?: React.Dispatch<React.SetStateAction<string | null>>;
  agent?: Agent;
  checkpointsList?: any[];
  setCheckpointsList?: React.Dispatch<React.SetStateAction<any[]>>;
  groupBoundaries: any[];
  toggleGroupCollapse: (groupIndex: number) => void;
  expandCursorRef: React.MutableRefObject<number>;
}

export function useDashboardKeyboard(ctx: DashboardKeyboardContext) {
  const {
    exit,
    stopAllRunningAgents,
    setCurrentTask,
    setIsHistoryTruncated,
    query,
    setQuery,
    pastePrefixLength,
    pasteSuffixLength,
    isPasted,
    setIsPasted,
    handleQuerySubmit,
    activeWizard,
    setActiveWizard,
    focusArea,
    setFocusArea,
    setLogScrollOffset,
    history,
    historyIndex,
    setHistoryIndex,
    tempInput,
    setTempInput,
    wizardSelectedIndex,
    setWizardSelectedIndex,
    wizardAllOptions,
    wizardOptions,
    wizardSelectedSet,
    setWizardSelectedSet,
    setWizardOptions,
    setWizardAllOptions,
    setWizardIsLoadingModels,
    pendingQuestion,
    setPendingQuestion,
    suggestions,
    planState,
    checklistTasks,
    completedHistory = [],
    runningSubagentsCount,
    runningTasksCount,
    setSelectedIndex,
    sessions,
    selectedIndex,
    wrappedLines,
    logsCount,
    setChecklistScrollOffset,
    maxChecklistVisible,
    setAgentsScrollOffset,
    maxAgentsVisible,
    procsScrollOffset,
    setProcsScrollOffset,
    maxProcsVisible,
    procsSelectedIndex,
    setProcsSelectedIndex,
    isProcessing = false,
    setIsProcessing = () => {},
    setMasterLogs,
    lastTabPrefix = null,
    queryCursorOffset,
    setLastTabPrefix,
    agent,
    checkpointsList,
    setCheckpointsList,
    groupBoundaries,
    toggleGroupCollapse,
    expandCursorRef,
  } = ctx;

  const handlerRef = React.useRef<(input: string, key: any) => void>();
  handlerRef.current = (input, key) => {
    // Ignore SGR mouse escape sequences that leak from terminal clicks
    if (input && (input.startsWith("[<") || input.startsWith("\x1b[<") || input.startsWith("\u001b[<"))) {
      return;
    }

    const isEscape = !!(key?.escape || ((input === "\x1b" || input === "\u001b") && input.length === 1));
    const isCtrlC = !!(input === "\x03" || (key?.ctrl && input === "c"));

    if (isCtrlC) {
      if (activeWizard) {
        const needsAbort = activeWizard.type === "question" || activeWizard.type === "plan_approve" || activeWizard.type === "permission";
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setWizardSelectedSet(new Set());
        setWizardAllOptions([]);
        setWizardIsLoadingModels(false);
        setQuery("");
        if (pendingQuestion) {
          pendingQuestion.resolve("__CANCEL__");
          setPendingQuestion(null);
        }
        if (setMasterLogs) {
          setMasterLogs((prev) => [...prev, "[SYSTEM] Wizard cancelled."].slice(-500));
        }
        if (needsAbort) {
          if (agent && activeWizard.type === "plan_approve") {
            agent.planState = "IDLE";
          }
          stopAllRunningAgents();
          setIsProcessing(false);
          setCurrentTask("Idle - Interrupted");
        }
        return;
      }
      // Always attempt to stop running agents first, regardless of
      // isProcessing flag. The flag can be false between tool calls
      // or when subagents are running independently of the master.
      const stopped = stopAllRunningAgents();
      if (stopped > 0 || isProcessing) {
        setIsProcessing(false);
        setCurrentTask("Idle - Interrupted");
        return;
      }
      setActiveWizard({
        type: "exit_confirm",
        step: 1,
        data: {},
      });
      setWizardOptions(["No, keep working", "Yes, exit"]);
      setWizardSelectedIndex(0);
      return;
    }

    if (key.ctrl && input === "t") {
      setIsHistoryTruncated((prev) => !prev);
      return;
    }

    if (key.ctrl && input === "b") {
      const workspacePath = agent?.workingDirectory || process.cwd();
      const runningTasksCount = [...backgroundTasks.values()].filter((t) => !t.isHidden && (t.isDetachedWindow || !t.hasExited) && isTaskInWorkspace(t.cwd, workspacePath)).length;
      if (runningTasksCount > 0) {
        setFocusArea((prev: any) => (prev === "procs" ? "input" : "procs"));
        setProcsSelectedIndex(0);
      }
      return;
    }

    // Ctrl+O: Cycle-expand tool/system log groups
    if (key.ctrl && input === "o" && !activeWizard) {
      const collapsibles = groupBoundaries.filter((g) => g.isCollapsible);
      if (collapsibles.length > 0) {
        const nextCursor = (expandCursorRef.current + 1) % collapsibles.length;
        expandCursorRef.current = nextCursor;
        const target = collapsibles[nextCursor];
        toggleGroupCollapse(target.groupIndex);
      }
      return;
    }

    // Ctrl+P: Open checkpoint wizard
    if (key.ctrl && input === "p") {
      if (isProcessing || activeWizard || !agent) return;
      const sessionPath = agent.getCurrentHistoryFilePath();
      listCheckpointsForSession(sessionPath)
        .then((checkpoints) => {
          if (checkpoints.length === 0) {
            setMasterLogs?.((prev) => [...prev, "[SYSTEM] No checkpoints found. Use /checkpoint <name> to create one."].slice(-500));
            return;
          }
          setCheckpointsList?.(checkpoints);
          const relTime = (ts: number) => {
            const diff = Math.floor((Date.now() - ts) / 1000);
            if (diff < 60) return `${diff}s ago`;
            if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
            if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
            return `${Math.floor(diff / 86400)}d ago`;
          };
          const options = checkpoints.map((c: any) => {
            const gitTag = c.gitSha ? ` [${c.gitSha}]` : "";
            return `📌 ${c.name}  |  ${c.messages.length} msgs  |  ${relTime(c.timestamp)}${gitTag}`;
          });
          setActiveWizard({ type: "checkpoint", step: 1, data: { action: "browse" } });
          setWizardOptions(options);
          setWizardSelectedIndex(0);
        })
        .catch(() => {
          setMasterLogs?.((prev) => [...prev, "[ERROR] Failed to list checkpoints."].slice(-500));
        });
      return;
    }

    const { inserted: currentInserted } = getPasteSplit(query, pastePrefixLength, pasteSuffixLength);
    const isPasteActive = isPasted && (currentInserted.length > 200 || currentInserted.includes("\n"));

    if (isEscape) {
      if (isPasteActive) {
        setQuery("");
        setIsPasted(false);
        setHistoryIndex(-1);
        return;
      }
    }

    // ESC: stop all running agents regardless of focus area
    if (isEscape && !activeWizard) {
      const stopped = stopAllRunningAgents();
      if (stopped > 0) {
        setCurrentTask("Idle - Interrupted");
        setIsProcessing(false);
        return;
      }
    }

    if (isEscape) {
      if (!activeWizard && focusArea === "input") {
        setQuery("");
        setHistoryIndex(-1);
        setLogScrollOffset(0);
        return;
      }
    }

    // Redirect printable characters to input if another panel is focused
    if (focusArea !== "input" && !activeWizard && input) {
      const hasControlChar = input.split("").some(char => {
        const code = char.charCodeAt(0);
        return code < 32 || code === 127;
      });
      const isPrintable =
        !hasControlChar &&
        !key.ctrl &&
        !key.meta &&
        !key.upArrow &&
        !key.downArrow &&
        !key.leftArrow &&
        !key.rightArrow &&
        !key.return &&
        !isEscape &&
        !key.tab &&
        !key.backspace &&
        !key.delete;

      if (isPrintable) {
        if (focusArea === "list" && input >= "1" && input <= "9") {
          // let list selection handle it
        } else {
          setFocusArea("input");
          setQuery((prev) => prev + input);
          setIsPasted(false);
          return;
        }
      }
    }

    if (focusArea === "input" && !activeWizard) {
      if (key.upArrow) {
        if (!isProcessing && history.length > 0) {
          let newIndex = historyIndex;
          if (historyIndex === -1) {
            setTempInput(query);
            newIndex = history.length - 1;
          } else if (historyIndex > 0) {
            newIndex = historyIndex - 1;
          }
          setHistoryIndex(newIndex);
          setQuery(history[newIndex]);
          setIsPasted(false);
        } else if (isProcessing) {
          setLogScrollOffset((prev) => {
            const maxScroll = Math.max(0, wrappedLines.length - logsCount);
            return Math.min(prev + 1, maxScroll);
          });
        }
        return;
      }

      if (key.downArrow) {
        if (!isProcessing && historyIndex !== -1) {
          if (historyIndex === history.length - 1) {
            setHistoryIndex(-1);
            setQuery(tempInput);
            setIsPasted(false);
          } else {
            const newIndex = historyIndex + 1;
            setHistoryIndex(newIndex);
            setQuery(history[newIndex]);
            setIsPasted(false);
          }
        } else if (isProcessing) {
          setLogScrollOffset((prev) => Math.max(0, prev - 1));
        }
        return;
      }
    }

    if (activeWizard) {
      if (activeWizard.type === "plan_approve") {
        if (key.leftArrow) {
          setActiveWizard((curr: any) => curr ? { ...curr, data: { ...curr.data, focus: "plan" } } : null);
          return;
        }
        if (key.rightArrow) {
          setActiveWizard((curr: any) => curr ? { ...curr, data: { ...curr.data, focus: "actions" } } : null);
          return;
        }
      }

      const currentFocus = activeWizard.data?.focus || "actions";
      if (key.upArrow) {
        if (activeWizard.type === "plan_approve" && currentFocus === "plan") {
          // Do not intercept, let it pass to PlanApprovalDialog local listener
        } else {
          if (activeWizard.type === "model" && (activeWizard.step === 3 || activeWizard.step === 4 || activeWizard.step === 15 || activeWizard.step === 24 || activeWizard.step === 25 || activeWizard.step === 30 || activeWizard.step === 34 || activeWizard.step === 35 || activeWizard.step === 40)) {
            const lc = query.trim();
            const len = lc
              ? filterSuggestions(wizardAllOptions, lc).length
              : wizardAllOptions.length;
            setWizardSelectedIndex((prev) => {
              const currentMax = Math.max(0, len - 1);
              const clampedPrev = Math.min(prev, currentMax);
              return Math.max(0, clampedPrev - 1);
            });
          } else if ((activeWizard.type === "workspace" && activeWizard.step === 1) || (activeWizard.type === "checkpoint" && activeWizard.step === 1 && activeWizard.data?.action !== "choose")) {
            const lc = query.trim();
            const len = lc
              ? filterSuggestions(wizardOptions, lc).length
              : wizardOptions.length;
            setWizardSelectedIndex((prev) => {
              const currentMax = Math.max(0, len - 1);
              const clampedPrev = Math.min(prev, currentMax);
              return Math.max(0, clampedPrev - 1);
            });
          } else {
            setWizardSelectedIndex((prev) => Math.max(0, prev - 1));
          }
          return;
        }
      }
      if (key.downArrow) {
        if (activeWizard.type === "plan_approve" && currentFocus === "plan") {
          // Do not intercept
        } else {
          if (activeWizard.type === "model" && (activeWizard.step === 3 || activeWizard.step === 4 || activeWizard.step === 15 || activeWizard.step === 24 || activeWizard.step === 25 || activeWizard.step === 30 || activeWizard.step === 34 || activeWizard.step === 35 || activeWizard.step === 40)) {
            const lc = query.trim();
            const len = lc
              ? filterSuggestions(wizardAllOptions, lc).length
              : wizardAllOptions.length;
            setWizardSelectedIndex((prev) => {
              const currentMax = Math.max(0, len - 1);
              const clampedPrev = Math.min(prev, currentMax);
              return Math.min(currentMax, clampedPrev + 1);
            });
          } else if ((activeWizard.type === "workspace" && activeWizard.step === 1) || (activeWizard.type === "checkpoint" && activeWizard.step === 1 && activeWizard.data?.action !== "choose")) {
            const lc = query.trim();
            const len = lc
              ? filterSuggestions(wizardOptions, lc).length
              : wizardOptions.length;
            setWizardSelectedIndex((prev) => {
              const currentMax = Math.max(0, len - 1);
              const clampedPrev = Math.min(prev, currentMax);
              return Math.min(currentMax, clampedPrev + 1);
            });
          } else {
            setWizardSelectedIndex((prev) => Math.min(Math.max(0, wizardOptions.length - 1), prev + 1));
          }
          return;
        }
      }
      if (key.return) {
        handleQuerySubmit(query);
        return;
      }
      if (activeWizard.isMultiSelect && input === " ") {
        setWizardSelectedSet((prev) => {
          const next = new Set(prev);
          if (next.has(wizardSelectedIndex)) {
            next.delete(wizardSelectedIndex);
          } else {
            next.add(wizardSelectedIndex);
          }
          return next;
        });
        return;
      }
      if (isEscape) {
        if (activeWizard && activeWizard.type === "question" && activeWizard.questions && activeWizard.currentQuestionIndex !== undefined && activeWizard.currentQuestionIndex > 0) {
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
            const prevAnsList = prevAns.split(", ").map((x: string) => x.trim());
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
              setQuery(prevAns);
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

        // plan_approve step 2: Escape goes back to step 1
        if (activeWizard && activeWizard.type === "plan_approve" && activeWizard.step === 2) {
          setWizardOptions([...PLAN_APPROVAL_OPTIONS]);
          setActiveWizard({ ...activeWizard, step: 1 });
          setQuery("");
          return;
        }
        if (activeWizard && activeWizard.type === "model" && activeWizard.step !== 1) {
          if (activeWizard.step === 50) {
            handleQuerySubmit("back");
          } else {
            handleQuerySubmit("< Back");
          }
          return;
        }
        if (activeWizard && activeWizard.type === "skills" && activeWizard.step === 2) {
          handleQuerySubmit("< Back");
          return;
        }
        if (activeWizard && activeWizard.type === "checkpoint" && activeWizard.step === 2) {
          handleQuerySubmit("< Back");
          return;
        }
        if (activeWizard && activeWizard.type === "login") {
          if (activeWizard.step === 2) {
            setActiveWizard({ type: "login", step: 1, data: {} });
            setWizardOptions(["1. List Configured Providers", "2. Create / Log in to a Provider", "3. Delete / Remove a Provider", "4. Edit an Existing Provider"]);
            setWizardSelectedIndex(0);
            setQuery("");
            return;
          } else if (activeWizard.step === 14) {
            setActiveWizard({ type: "login", step: 1, data: {} });
            setWizardOptions(["1. List Configured Providers", "2. Create / Log in to a Provider", "3. Delete / Remove a Provider", "4. Edit an Existing Provider"]);
            setWizardSelectedIndex(0);
            setQuery("");
            return;
          } else if (activeWizard.step === 15) {
            const list = getConfiguredProviders();
            setActiveWizard({ type: "login", step: 14, data: {} });
            setWizardOptions(list.map(
              (p, i) => `${i + 1}. ${p.name} [${p.type || "unknown"}]${p.baseUrl ? ` (${p.baseUrl})` : ""}`
            ));
            setWizardSelectedIndex(0);
            setQuery("");
            return;
          } else if (activeWizard.step === 3) {
            setActiveWizard({ type: "login", step: 2, data: {} });
            setWizardOptions([...PROVIDER_TEMPLATE_LABELS]);
            setWizardSelectedIndex(0);
            setQuery("");
            return;
          } else if (activeWizard.step === 4) {
            setActiveWizard({ type: "login", step: 3, data: { provider: activeWizard.data.provider } });
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            setQuery("");
            return;
          } else if (activeWizard.step === 5) {
            if (activeWizard.data.baseUrl || activeWizard.data.provider === "custom" || activeWizard.data.provider === "custom-anthropic") {
              setActiveWizard({ type: "login", step: 4, data: { provider: activeWizard.data.provider, name: activeWizard.data.name } });
            } else {
              setActiveWizard({ type: "login", step: 3, data: { provider: activeWizard.data.provider } });
            }
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            setQuery("");
            return;
          } else if (activeWizard.step === 7) {
            if (activeWizard.data.fromList === "true") {
              const providers = getProviders().filter(p => p.apiKey && p.apiKey.trim() !== "");
              setActiveWizard({ type: "login", step: 6, data: {} });
              setWizardOptions(providers.map(
                (p, i) => `${i + 1}. ${p.name} [${p.provider}]${p.baseUrl ? ` (${p.baseUrl})` : ""}`
              ));
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
            setQuery("");
            return;
          } else if (activeWizard.step === 11) {
            setActiveWizard({ type: "login", step: 10, data: activeWizard.data });
            setWizardOptions(["1. TypeScript (Recommended)", "2. JavaScript", "3. Python", "4. Rust", "5. Go", "6. AI-Assisted Initialization"]);
            setWizardSelectedIndex(0);
            setQuery("");
            return;
          } else if (activeWizard.step === 12) {
            setActiveWizard({ type: "login", step: 11, data: activeWizard.data });
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            setQuery("");
            return;
          } else if (activeWizard.step === 13) {
            setActiveWizard({ type: "login", step: 10, data: activeWizard.data });
            setWizardOptions(["1. TypeScript (Recommended)", "2. JavaScript", "3. Python", "4. Rust", "5. Go", "6. AI-Assisted Initialization"]);
            setWizardSelectedIndex(0);
            setQuery("");
            return;
          }
        }
        if (activeWizard && activeWizard.step !== 1) {
          const backOption = wizardOptions.find(opt => {
            const trimmed = opt.trim();
            const clean = trimmed.startsWith("•") ? trimmed.slice(1).trim() : trimmed;
            return clean === "< Back" || clean === "Back" || clean.toLowerCase() === "< back" || clean.toLowerCase() === "back";
          });
          if (backOption) {
            handleQuerySubmit(backOption);
            return;
          }
        }

        const needsAbort = activeWizard.type === "question" || activeWizard.type === "plan_approve" || activeWizard.type === "permission";
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setWizardSelectedSet(new Set());
        setWizardAllOptions([]);
        setWizardIsLoadingModels(false);
        setQuery("");
        if (pendingQuestion) {
          pendingQuestion.resolve("__CANCEL__");
          setPendingQuestion(null);
        }
        if (needsAbort) {
          if (agent && activeWizard.type === "plan_approve") {
            agent.planState = "IDLE";
          }
          stopAllRunningAgents();
          setIsProcessing(false);
          setCurrentTask("Idle - Interrupted");
        }
        return;
      }
    }

    if (key.tab) {
      const activeCmdCtx = focusArea === "input" ? getActiveCommandContext(query, queryCursorOffset ?? query.length) : null;
      if (focusArea === "input" && (activeCmdCtx || query.startsWith("/") || query.startsWith("!"))) {
        if (suggestions.length > 0) {
          if (setLastTabPrefix && !lastTabPrefix) {
            setLastTabPrefix(query);
          }
          const currentMatchIndex = suggestions.indexOf(query);
          let nextIndex = 0;
          if (currentMatchIndex !== -1) {
            nextIndex = (currentMatchIndex + 1) % suggestions.length;
          }
          if (suggestions.length === 1) {
            setQuery(suggestions[0] + " ");
            if (setLastTabPrefix) {
              setLastTabPrefix(null);
            }
          } else {
            setQuery(suggestions[nextIndex]);
          }
          setIsPasted(false);
          return;
        }
      }
      
      if (focusArea === "input") {
        setFocusArea("list");
      } else if (focusArea === "list") {
        if (planState === "APPROVED" && (checklistTasks.length > 0 || completedHistory.length > 0)) {
          setFocusArea("checklist");
        } else if (runningSubagentsCount > 0) {
          setFocusArea("agents");
        } else if (runningTasksCount > 0) {
          setFocusArea("procs");
        } else {
          setFocusArea("logs");
        }
      } else if (focusArea === "checklist") {
        if (runningSubagentsCount > 0) {
          setFocusArea("agents");
        } else if (runningTasksCount > 0) {
          setFocusArea("procs");
        } else {
          setFocusArea("logs");
        }
      } else if (focusArea === "agents") {
        if (runningTasksCount > 0) {
          setFocusArea("procs");
        } else {
          setFocusArea("logs");
        }
      } else if (focusArea === "procs") {
        setFocusArea("logs");
      } else {
        setFocusArea("input");
      }
      return;
    }

    if (focusArea === "list") {
      if (key.upArrow) {
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : Math.max(0, sessions.length - 1)));
      } else if (key.downArrow) {
        setSelectedIndex((prev) => (prev < sessions.length - 1 ? prev + 1 : 0));
      } else if (key.return) {
        setFocusArea("logs");
      } else if (isEscape) {
        setFocusArea("input");
      } else if (input >= "1" && input <= "9") {
        const targetIndex = parseInt(input, 10) - 1;
        if (targetIndex < sessions.length) {
          setSelectedIndex(targetIndex);
        }
      }
    } else if (focusArea === "logs") {
      if (key.upArrow) {
        setLogScrollOffset((prev) => {
          const maxScroll = Math.max(0, wrappedLines.length - logsCount);
          return Math.min(prev + 1, maxScroll);
        });
      } else if (key.downArrow) {
        setLogScrollOffset((prev) => Math.max(0, prev - 1));
      } else if (isEscape) {
        setLogScrollOffset(0);
        setFocusArea("list");
      }
    } else if (focusArea === "checklist") {
      if (key.upArrow) {
        setChecklistScrollOffset((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setChecklistScrollOffset((prev) => {
          const maxScroll = Math.max(0, checklistTasks.length - maxChecklistVisible);
          return Math.min(prev + 1, maxScroll);
        });
      } else if (isEscape) {
        setFocusArea("input");
      }
    } else if (focusArea === "agents") {
      if (key.upArrow) {
        setAgentsScrollOffset((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setAgentsScrollOffset((prev) => {
          const runningAgents = Array.from(subagentInstances.values()).filter((s) => s.status === "running");
          const maxScroll = Math.max(0, runningAgents.length - maxAgentsVisible);
          return Math.min(prev + 1, maxScroll);
        });
      } else if (isEscape) {
        setFocusArea("input");
      }
    } else if (focusArea === "procs") {
      const workspacePath = agent?.workingDirectory || process.cwd();
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
      } else if (key.downArrow) {
        setProcsSelectedIndex((prev) => {
          const next = Math.min(total - 1, prev + 1);
          if (next >= procsScrollOffset + maxProcsVisible) {
            setProcsScrollOffset(next - maxProcsVisible + 1);
          }
          return next;
        });
      } else if (key.return) {
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

          const header = `┌───[ 📄 LOG FOR PROCESS ${taskId} ]`;
          const cmdLine = `│ Command: ${task.command}`;
          const sep = `├──────────────────────────────────────────────`;
          const bodyLines = logContent.split("\n").map(l => `│ ${l}`);
          const footer = `└──────────────────────────────────────────────`;

          setMasterLogs?.((prev) => [...prev, header, cmdLine, sep, ...bodyLines, footer].slice(-500));
        }
      } else if (isEscape) {
        setFocusArea("input");
      }
    }
  };

  const stableHandler = React.useCallback((input: string, key: any) => {
    handlerRef.current?.(input, key);
  }, []);

  useInput(stableHandler);
}
