import React from "react";
import { useInput } from "ink";
import { getPasteSplit, filterSuggestions } from "../utils/text.js";
import { subagentInstances, backgroundTasks } from "../core/tools/state.js";

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
  setProcsScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  maxProcsVisible: number;
  isProcessing?: boolean;
  setIsProcessing?: React.Dispatch<React.SetStateAction<boolean>>;
  setMasterLogs?: React.Dispatch<React.SetStateAction<string[]>>;
  lastTabPrefix?: string | null;
  setLastTabPrefix?: React.Dispatch<React.SetStateAction<string | null>>;
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
    setProcsScrollOffset,
    maxProcsVisible,
    isProcessing = false,
    setIsProcessing = () => {},
    setMasterLogs,
    lastTabPrefix = null,
    setLastTabPrefix,
  } = ctx;

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (activeWizard) {
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setWizardSelectedSet(new Set());
        setWizardAllOptions([]);
        setWizardIsLoadingModels(false);
        setQuery("");
        if (pendingQuestion) {
          pendingQuestion.resolve("");
          setPendingQuestion(null);
        }
        if (setMasterLogs) {
          setMasterLogs((prev) => [...prev, "[SYSTEM] Wizard cancelled."].slice(-500));
        }
        return;
      }
      if (isProcessing) {
        stopAllRunningAgents();
        setIsProcessing(false);
        setCurrentTask("Idle - Interrupted");
        return;
      }
      exit();
      return;
    }

    if (key.ctrl && input === "t") {
      setIsHistoryTruncated((prev) => !prev);
      return;
    }

    const { inserted: currentInserted } = getPasteSplit(query, pastePrefixLength, pasteSuffixLength);
    const isPasteActive = isPasted && (currentInserted.length > 200 || currentInserted.includes("\n"));

    if (
      (key.backspace || key.delete) &&
      isPasteActive
    ) {
      setQuery((prev) => {
        const next = prev.slice(0, -1);
        const { inserted: nextInserted } = getPasteSplit(next, pastePrefixLength, pasteSuffixLength);
        if (next.length <= pastePrefixLength + pasteSuffixLength || (nextInserted.length <= 200 && !nextInserted.includes("\n"))) {
          setIsPasted(false);
        }
        return next;
      });
      return;
    }

    if (key.return) {
      if (setLastTabPrefix) {
        setLastTabPrefix(null);
      }
      if (isPasteActive) {
        handleQuerySubmit(query);
        return;
      }
    }

    if (key.escape) {
      if (isPasteActive) {
        setQuery("");
        setIsPasted(false);
        setHistoryIndex(-1);
        return;
      }
    }

    if (key.escape) {
      if (!activeWizard && focusArea === "input") {
        if (stopAllRunningAgents() > 0) {
          setCurrentTask("Idle - Interrupted");
          return;
        }
      }
    }

    if (focusArea === "input" && !activeWizard) {
      if (key.escape) {
        setQuery("");
        setHistoryIndex(-1);
        setLogScrollOffset(0);
        return;
      }

      if (key.upArrow && history.length > 0) {
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
        return;
      }

      if (key.downArrow) {
        if (historyIndex !== -1) {
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
        }
        return;
      }
    }

    if (activeWizard) {
      if (key.upArrow) {
        if (activeWizard.type === "model" && (activeWizard.step === 3 || activeWizard.step === 24 || activeWizard.step === 34)) {
          const lc = query.trim();
          const len = lc
            ? filterSuggestions(wizardAllOptions, lc).length
            : wizardAllOptions.length;
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
      if (key.downArrow) {
        if (activeWizard.type === "model" && (activeWizard.step === 3 || activeWizard.step === 24 || activeWizard.step === 34)) {
          const lc = query.trim();
          const len = lc
            ? filterSuggestions(wizardAllOptions, lc).length
            : wizardAllOptions.length;
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
      if (key.escape) {
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

        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setWizardSelectedSet(new Set());
        setWizardAllOptions([]);
        setWizardIsLoadingModels(false);
        setQuery("");
        if (pendingQuestion) {
          pendingQuestion.resolve("");
          setPendingQuestion(null);
        }
        return;
      }
    }

    if (key.tab) {
      if (focusArea === "input" && query.startsWith("/")) {
        if (suggestions.length > 0) {
          if (setLastTabPrefix && !lastTabPrefix) {
            setLastTabPrefix(query);
          }
          const currentMatchIndex = suggestions.indexOf(query);
          let nextIndex = 0;
          if (currentMatchIndex !== -1) {
            nextIndex = (currentMatchIndex + 1) % suggestions.length;
          }
          setQuery(suggestions[nextIndex]);
          setIsPasted(false);
          return;
        }
      }
      
      if (focusArea === "input") {
        setFocusArea("list");
      } else if (focusArea === "list") {
        if (planState === "APPROVED" && checklistTasks.length > 0) {
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
      } else if (key.escape) {
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
      } else if (key.escape) {
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
      } else if (key.escape) {
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
      } else if (key.escape) {
        setFocusArea("input");
      }
    } else if (focusArea === "procs") {
      if (key.upArrow) {
        setProcsScrollOffset((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setProcsScrollOffset((prev) => {
          const runningProcs = Array.from(backgroundTasks.entries()).filter(([id, task]) => !task.hasExited);
          const maxScroll = Math.max(0, runningProcs.length - maxProcsVisible);
          return Math.min(prev + 1, maxScroll);
        });
      } else if (key.escape) {
        setFocusArea("input");
      }
    }
  });
}
