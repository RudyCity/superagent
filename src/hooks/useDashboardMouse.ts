import React, { useEffect } from "react";
import path from "path";
import { wrapTextForDisplay } from "../utils/responseScroll.js";
import { superagentInstances, subagentInstances, backgroundTasks } from "../core/tools/state.js";
import { getDashboardSuggestions } from "../utils/dashboardSuggestions.js";
import { filterSuggestions } from "../utils/text.js";

export interface DashboardMouseContext {
  wrappedLines: React.ReactNode[];
  logsCount: number;
  terminalSize: { width: number; height: number };
  activeWizard: any;
  setActiveWizard: React.Dispatch<React.SetStateAction<any>>;
  wizardOptions: string[];
  wizardSelectedIndex: number;
  setWizardSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  wizardSelectedSet: Set<number>;
  setWizardSelectedSet: React.Dispatch<React.SetStateAction<Set<number>>>;
  setWizardOptions: React.Dispatch<React.SetStateAction<string[]>>;
  pendingQuestion: any;
  handleWizardSubmit: (val: string) => void;
  query: string;
  setQuery: React.Dispatch<React.SetStateAction<string>>;
  wizardAllOptions: string[];
  workspaceHeight: number;
  leftTopHeight: number;
  wizardIsLoadingModels: boolean;
  agent: any;
  focusArea: string;
  setFocusArea: React.Dispatch<React.SetStateAction<any>>;
  setLogScrollOffset: React.Dispatch<React.SetStateAction<number>>;
}

export function useDashboardMouse(ctx: DashboardMouseContext) {
  const {
    wrappedLines,
    logsCount,
    terminalSize,
    activeWizard,
    setActiveWizard,
    wizardOptions,
    wizardSelectedIndex,
    setWizardSelectedIndex,
    wizardSelectedSet,
    setWizardSelectedSet,
    setWizardOptions,
    pendingQuestion,
    handleWizardSubmit,
    query,
    setQuery,
    wizardAllOptions,
    workspaceHeight,
    leftTopHeight,
    wizardIsLoadingModels,
    agent,
    focusArea,
    setFocusArea,
    setLogScrollOffset,
  } = ctx;

  useEffect(() => {
    const enableMouseTracking = "\x1b[?1000h\x1b[?1006h";
    const disableMouseTracking = "\x1b[?1006l\x1b[?1000l";

    const handleMouseInput = (data: Buffer) => {
      const text = data.toString("utf8");
      const matches = text.matchAll(/\x1b\[<(?<btn>\d+);(?<col>\d+);(?<row>\d+)(?<action>[Mm])/g);

      for (const match of matches) {
        const btn = match.groups?.btn;
        const colStr = match.groups?.col;
        const rowStr = match.groups?.row;
        const action = match.groups?.action;

        if (btn === "64") {
          setLogScrollOffset((prev) => {
            const maxScroll = Math.max(0, wrappedLines.length - logsCount);
            return Math.min(prev + 1, maxScroll);
          });
        } else if (btn === "65") {
          setLogScrollOffset((prev) => Math.max(0, prev - 1));
        } else if (btn === "0" && action === "M" && colStr && rowStr) {
          const x = parseInt(colStr, 10);
          const y = parseInt(rowStr, 10);
          const leftLimit = Math.floor(terminalSize.width * 0.40);
          const rightStart = Math.floor(terminalSize.width * 0.42);
          const workspaceStartRow = 4;

          // Check wizard options clicks first (which is full-width in multi-agent layout)
          if (activeWizard) {
            let options = wizardOptions;
            let maxVisible = 10;
            if (activeWizard.type === "model" && (activeWizard.step === 3 || activeWizard.step === 24 || activeWizard.step === 34)) {
              const lc = query.trim().toLowerCase();
              options = lc
                ? wizardAllOptions.filter(m => m.toLowerCase().includes(lc))
                : wizardAllOptions;
              maxVisible = 8;
            }

            const total = options.length;
            if (total > 0) {
              let start = 0;
              if (total > maxVisible) {
                start = Math.max(0, wizardSelectedIndex - Math.floor(maxVisible / 2));
                const end = start + maxVisible;
                if (end > total) {
                  start = Math.max(0, total - maxVisible);
                }
              }
              const visibleCount = Math.min(total, maxVisible);

              let description = undefined;
              if (activeWizard.type === "plan_approve") {
                description = `Model AI telah merancang rencana di file: file:///${path.resolve(agent.getPlanFilePath()).replace(/\\/g, "/")}`;
              } else if (activeWizard.type === "question") {
                description = pendingQuestion?.question || "";
              } else if (activeWizard.type === "login" && activeWizard.step === 10) {
                description = "Choose a template catalog stack or let AI dynamically design your project details:";
              } else if (activeWizard.type === "login" && activeWizard.step === 11) {
                description = "Specify the name for this workspace:";
              } else if (activeWizard.type === "login" && activeWizard.step === 12) {
                description = "Give a one-sentence overview description of this software:";
              } else if (activeWizard.type === "login" && activeWizard.step === 13) {
                description = "State what you want to build (e.g. 'A command-line text editor in Rust'). AI will construct agents.md specs:";
              }

              let descLines = 0;
              if (description) {
                const descWidth = Math.max(10, terminalSize.width - 4);
                descLines = wrapTextForDisplay(description, descWidth).length;
              }

              const isLoading = (activeWizard.type === "model" && (activeWizard.step === 3 || activeWizard.step === 24 || activeWizard.step === 34)) && wizardIsLoadingModels;

              const y_options_start = 6
                + workspaceHeight
                + 1 // top spacer │
                + 1 // title
                + (description ? descLines + 1 : 0)
                + (isLoading ? 2 : 0)
                + (start > 0 ? 1 : 0);

              const optStartRow = y_options_start;
              const optEndRow = optStartRow + visibleCount - 1;

              if (y >= optStartRow && y <= optEndRow) {
                setFocusArea("input");
                const idx = y - optStartRow;
                const targetIndex = start + idx;
                if (
                  targetIndex >= 0 &&
                  targetIndex < total &&
                  options[targetIndex] !== "(no results — try different search)"
                ) {
                  if (activeWizard.isMultiSelect) {
                    setWizardSelectedSet((prev) => {
                      const next = new Set(prev);
                      if (next.has(targetIndex)) {
                        next.delete(targetIndex);
                      } else {
                        next.add(targetIndex);
                      }
                      return next;
                    });
                  } else {
                    const selectedOption = options[targetIndex];
                    if (selectedOption === "Custom...") {
                      setWizardSelectedIndex(targetIndex);
                      setActiveWizard({
                        type: "question",
                        step: 2,
                        data: { question: pendingQuestion?.question || "" },
                      });
                      setWizardOptions([]);
                      setWizardSelectedIndex(0);
                      setQuery("");
                    } else {
                      if (wizardSelectedIndex === targetIndex) {
                        handleWizardSubmit(selectedOption);
                      } else {
                        setWizardSelectedIndex(targetIndex);
                      }
                    }
                  }
                }
                return; // Handled wizard option click
              }
            }
          }

          // If click wasn't in wizard options, handle regular panel focusing
          const activeWTsCount = [...superagentInstances.values()]
            .filter((i) => i.status === "running")
            .map((i) => i.branch).length;
          const statusBarHeight = 5 + (activeWTsCount > 0 ? 1 : 0);
          const suggestions = getDashboardSuggestions(query);
          const isSuggestionsVisible = ctx.focusArea === "input" && query.startsWith("/") && suggestions.length > 0;
          const bottomPromptHeight = 1 + (isSuggestionsVisible ? 2 : 0);
          const promptStartRow = terminalSize.height - statusBarHeight - bottomPromptHeight + 1;

          if (y >= promptStartRow) {
            if (isSuggestionsVisible && y === promptStartRow) {
              // Clicked on suggestions line
              let col = 18; // 1-indexed column after "│   Suggestions: "
              const sliced = suggestions.slice(0, 5);
              let clickedSuggestion: string | null = null;
              for (let i = 0; i < sliced.length; i++) {
                const s = sliced[i];
                const nextCol = col + s.length;
                if (x >= col && x < nextCol) {
                  clickedSuggestion = s;
                  break;
                }
                col = nextCol + 2; // +2 for separator spaces
              }
              if (clickedSuggestion) {
                setQuery(clickedSuggestion);
              }
            }
            setFocusArea("input");
          } else if (y >= workspaceStartRow && y < workspaceStartRow + workspaceHeight) {
            if (x <= leftLimit) {
              if (y < workspaceStartRow + leftTopHeight) {
                setFocusArea("list");
              } else {
                setFocusArea("checklist");
              }
            } else if (x >= rightStart) {
              setFocusArea("logs");
            }
          } else if (y >= workspaceStartRow + workspaceHeight && y < promptStartRow) {
            // Clicked in the area below main workspace but above prompt
            const runningSubagentsCount = [...subagentInstances.values()]
              .filter((s) => s.status === "running").length;
            const runningTasksCount = [...backgroundTasks.values()]
              .filter((t) => t.isDetachedWindow || !t.hasExited).length;
            const maxAgentsVisible = 3;
            const maxProcsVisible = 5;

            let wizardHeight = 0;
            if (activeWizard) {
              const isModelSelectStep = activeWizard.type === "model" && (activeWizard.step === 3 || activeWizard.step === 24 || activeWizard.step === 34);
              const maxVis = isModelSelectStep ? 8 : 10;

              const lc = query.trim();
              const filteredModels = lc
                ? filterSuggestions(wizardAllOptions, lc)
                : wizardAllOptions;

              const effectiveOptions = isModelSelectStep
                ? (filteredModels.length > 0 ? filteredModels : ["(no results — try different search)"])
                : wizardOptions;

              let start = 0;
              let end = effectiveOptions.length;
              if (effectiveOptions.length > maxVis) {
                start = Math.max(0, wizardSelectedIndex - Math.floor(maxVis / 2));
                end = start + maxVis;
                if (end > effectiveOptions.length) {
                  end = effectiveOptions.length;
                  start = Math.max(0, end - maxVis);
                }
              }
              const optCount = end - start;
              const hasAbove = start > 0;
              const hasBelow = end < effectiveOptions.length;

              let wizardDescription = "";
              if (activeWizard.type === "plan_approve") {
                const planPath = agent ? agent.getPlanFilePath() : "";
                wizardDescription = `Model AI telah merancang rencana di file: file:///${planPath ? path.resolve(planPath).replace(/\\/g, "/") : ""}`;
              } else if (activeWizard.type === "question") {
                wizardDescription = pendingQuestion?.question || "";
              } else if (activeWizard.type === "login" && activeWizard.step === 10) {
                wizardDescription = "Choose a template catalog stack or let AI dynamically design your project details:";
              } else if (activeWizard.type === "login" && activeWizard.step === 11) {
                wizardDescription = "Specify the name for this workspace:";
              } else if (activeWizard.type === "login" && activeWizard.step === 12) {
                wizardDescription = "Give a one-sentence overview description of this software:";
              } else if (activeWizard.type === "login" && activeWizard.step === 13) {
                wizardDescription = "State what you want to build (e.g. 'A command-line text editor in Rust'). AI will construct agents.md specs:";
              }

              const descLines = wizardDescription
                ? wrapTextForDisplay(wizardDescription, Math.max(10, terminalSize.width - 4)).length
                : 0;

              const hasLoading = activeWizard.type === "model" && (activeWizard.step === 3 || activeWizard.step === 24 || activeWizard.step === 34) && wizardIsLoadingModels;

              wizardHeight += 1; // Outer top border │
              wizardHeight += 1; // Title line
              if (descLines > 0) {
                wizardHeight += descLines + 1; // Description lines + spacer │
              }
              if (hasLoading) {
                wizardHeight += 2; // Loading spinner + spacer
              }
              if (hasAbove) {
                wizardHeight += 1;
              }
              wizardHeight += optCount;
              if (hasBelow) {
                wizardHeight += 1;
              }
              wizardHeight += 1; // Outer bottom border │
            }

            const y_agents_start = workspaceStartRow + workspaceHeight + 2 + wizardHeight;
            const agentsCount = Math.min(runningSubagentsCount, maxAgentsVisible);
            const agentsHeight = runningSubagentsCount > 0 ? 1 + agentsCount : 0;

            const y_procs_start = y_agents_start + agentsHeight;
            const procsCount = Math.min(runningTasksCount, maxProcsVisible);
            const procsHeight = runningTasksCount > 0 ? 1 + procsCount : 0;

            if (runningSubagentsCount > 0 && y >= y_agents_start && y < y_agents_start + agentsHeight) {
              setFocusArea("agents");
            } else if (runningTasksCount > 0 && y >= y_procs_start && y < y_procs_start + procsHeight) {
              setFocusArea("procs");
            }
          }
        }
      }
    };

    process.stdout.write(enableMouseTracking);
    process.stdin.on("data", handleMouseInput);

    return () => {
      process.stdin.off("data", handleMouseInput);
      process.stdout.write(disableMouseTracking);
    };
  }, [
    wrappedLines.length,
    logsCount,
    terminalSize.width,
    terminalSize.height,
    activeWizard,
    wizardOptions,
    wizardSelectedIndex,
    pendingQuestion,
    handleWizardSubmit,
    query,
    wizardAllOptions,
    workspaceHeight,
    leftTopHeight,
    wizardIsLoadingModels,
    agent,
  ]);
}
