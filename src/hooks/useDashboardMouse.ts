import React, { useEffect } from "react";
import path from "path";
import { wrapTextForDisplay } from "../utils/responseScroll.js";

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

          if (x <= leftLimit) {
            if (activeWizard) {
              setFocusArea("input");

              let options = wizardOptions;
              let maxVisible = 10;
              if (activeWizard.type === "model" && activeWizard.step === 3) {
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
                  const descWidth = Math.max(10, Math.floor(terminalSize.width * 0.40) - 4);
                  descLines = wrapTextForDisplay(description, descWidth).length;
                }

                const isLoading = (activeWizard.type === "model" && activeWizard.step === 3) && wizardIsLoadingModels;

                const y_options_start = workspaceStartRow
                  + leftTopHeight
                  + 1
                  + 1
                  + 1
                  + (description ? descLines + 1 : 0)
                  + (isLoading ? 2 : 0)
                  + (start > 0 ? 1 : 0);

                const optStartRow = y_options_start;
                const optEndRow = optStartRow + visibleCount - 1;

                if (y >= optStartRow && y <= optEndRow) {
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
                      setWizardSelectedIndex(targetIndex);
                      const selectedOption = options[targetIndex];
                      if (selectedOption === "Custom...") {
                        setActiveWizard({
                          type: "question",
                          step: 2,
                          data: { question: pendingQuestion?.question || "" },
                        });
                        setWizardOptions([]);
                        setWizardSelectedIndex(0);
                        setQuery("");
                      } else {
                        handleWizardSubmit(selectedOption);
                      }
                    }
                  }
                }
              }
            } else {
              const promptStartRow = workspaceStartRow + leftTopHeight + 1;
              if (y >= promptStartRow) {
                setFocusArea("input");
              } else {
                setFocusArea("list");
              }
            }
          } else if (x >= rightStart) {
            setFocusArea("logs");
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
