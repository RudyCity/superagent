import { useEffect, type MutableRefObject } from "react";
import { planApprovalChromeHeight } from "../components/plan-approval-dialog.js";
import fs from "fs";
import path from "path";
import os from "os";

function logMouseDebug(msg: string) {
  if (process.env.DEBUG_MOUSE !== "true") return;
  try {
    const logDir = path.join(os.homedir(), ".superagent-r");
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logPath = path.join(logDir, "superagent.log");
    fs.appendFileSync(logPath, msg);
  } catch (e) {
    // ignore
  }
}

export interface SectionBoundary {
  name: string;
  startRow: number;
  endRow: number;
  isHeader?: boolean;
}

export interface ChatLinePosition {
  index: number;
  startRow: number;
  endRow: number;
  isTruncated: boolean;
  type: string;
  isCollapsible?: boolean;
  /** If this position represents a nested child line, the parent line index */
  parentIndex?: number;
  /** If this position represents a nested child line, the child index within parent */
  childIndex?: number;
  /** The horizontal character length of the clickable area */
  length?: number;
}

export interface SingleAgentMouseContext {
  scrollChat: (direction: "up" | "down", amount?: number) => void;
  terminalHeight: number;
  focusMode: string;
  setFocusMode: (mode: any) => void;
  setScrollOffset: (val: number | ((prev: number) => number)) => void;

  // Focused response
  focusedResponseIndex: number | null;
  setFocusedResponseIndex: (val: number | null) => void;
  setFocusedResponseOffset: (val: number | ((prev: number) => number)) => void;
  focusWindowHeight: number;
  responseLinesCount: number;

  // Section boundaries (calculated in app.tsx)
  sections: SectionBoundary[];

  // Section scroll offsets
  setSuperagentsScrollOffset: (val: number | ((prev: number) => number)) => void;
  setSubagentsScrollOffset: (val: number | ((prev: number) => number)) => void;
  setProcsScrollOffset: (val: number | ((prev: number) => number)) => void;
  setChecklistScrollOffset: (val: number | ((prev: number) => number)) => void;

  // Counts and limits
  runningSuperagentsCount: number;
  runningSubagentsCount: number;
  runningTasksCount: number;
  checklistTasksCount: number;
  maxSuperagentsVisible: number;
  maxSubagentsVisible: number;
  maxProcsVisible: number;
  maxChecklistVisible: number;

  // Collapsible
  toggleCollapse: (section: string) => void;
  toggleChildExpand?: (parentIndex: number, childIndex: number) => void;

  // Chat item click
  openResponseAtIndex: (index: number) => void;
  visibleLinePositions: ChatLinePosition[];
  toggleLineExpand?: (index: number) => void;

  // Wizard scroll/click support
  activeWizard?: any;
  setActiveWizard?: (val: any) => void;
  wizardOptions?: string[];
  wizardSelectedIndex?: number;
  setWizardSelectedIndex?: (val: number | ((prev: number) => number)) => void;
  planPath?: string;
  handleWizardSubmit?: (val: string) => void;
  wizardHeaderRows?: number;

  // History click/scroll support
  history?: string[];
  historySelectedIndex?: number;
  setHistorySelectedIndex?: (val: number | ((prev: number) => number)) => void;

  // On input prompt click
  onInputClick?: (x: number, y: number) => void;
}

/**
 * Hook to enable mouse wheel scroll + click support in the terminal for the single-agent app.
 * Uses a ref-based approach so the event listener is registered once and always reads
 * the latest context values from the ref on each event.
 */
export function useMouseScroll(
  ctxRef: MutableRefObject<SingleAgentMouseContext | null>
) {
  useEffect(() => {
    if (!process.stdin.isTTY) return;

    // Enable SGR extended mouse tracking (button events + SGR coordinates)
    const enableMouseTracking = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
    const disableMouseTracking = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

    const handleMouseInput = (data: Buffer) => {
      const ctx = ctxRef.current;
      if (!ctx) return;

      const text = data.toString("utf8");

      if (process.env.DEBUG_MOUSE === "true") {
        logMouseDebug(
          `[MOUSE DEBUG] Raw escape sequence: ${JSON.stringify(text)} (visible positions count: ${ctx.visibleLinePositions?.length || 0})\n` +
          `[MOUSE DEBUG] Current sections: ${JSON.stringify(ctx.sections)}\n`
        );
      }
      const matches = text.matchAll(
        /\x1b\[<(?<btn>\d+);(?<col>\d+);(?<row>\d+)(?<action>[Mm])/g
      );

      for (const match of matches) {
        const btn = match.groups?.btn;
        const colStr = match.groups?.col;
        const rowStr = match.groups?.row;
        const action = match.groups?.action;

        // --- Scroll wheel ---
        if (btn === "64" || btn === "65") {
          const isUp = btn === "64";
          const y = rowStr ? parseInt(rowStr, 10) : 0;

          // Find which section was scrolled (hovered)
          let hoveredSection: SectionBoundary | null = null;
          if (y > 0) {
            for (const section of ctx.sections) {
              if (y >= section.startRow && y <= section.endRow) {
                hoveredSection = section;
                break;
              }
            }
          }

          const sectionName = hoveredSection?.name;

          if (sectionName === "chat") {
            if (ctx.focusedResponseIndex !== null) {
              ctx.setFocusedResponseOffset((prev: number) => {
                if (isUp) {
                  return Math.max(0, prev - 10);
                } else {
                  const maxOffset = Math.max(0, ctx.responseLinesCount - ctx.focusWindowHeight);
                  return Math.min(prev + 10, maxOffset);
                }
              });
            } else {
              ctx.scrollChat(isUp ? "up" : "down", 3);
            }
          } else if (sectionName === "wizard" && ctx.activeWizard?.type === "plan_approve") {
            ctx.setActiveWizard?.((curr: any) => {
              if (!curr) return null;
              const currentOffset = parseInt(curr.data?.scrollOffset || "0", 10);
              const nextOffset = isUp ? Math.max(0, currentOffset - 1) : currentOffset + 1;
              return { ...curr, data: { ...curr.data, scrollOffset: String(nextOffset) } };
            });
          } else if (
            sectionName === "superagents" ||
            sectionName === "subagents" ||
            sectionName === "procs" ||
            sectionName === "checklist" ||
            sectionName === "history"
          ) {
            scrollSection(ctx, sectionName, isUp ? "up" : "down");
          } else {
            // Fallback scroll behavior if no section matches or hover detection isn't active
            if (ctx.activeWizard?.type === "plan_approve") {
              ctx.setActiveWizard?.((curr: any) => {
                if (!curr) return null;
                const currentOffset = parseInt(curr.data?.scrollOffset || "0", 10);
                const nextOffset = isUp ? Math.max(0, currentOffset - 1) : currentOffset + 1;
                return { ...curr, data: { ...curr.data, scrollOffset: String(nextOffset) } };
              });
            } else if (ctx.focusedResponseIndex !== null) {
              ctx.setFocusedResponseOffset((prev: number) => {
                if (isUp) return Math.max(0, prev - 10);
                const maxOffset = Math.max(0, ctx.responseLinesCount - ctx.focusWindowHeight);
                return Math.min(prev + 10, maxOffset);
              });
            } else if (
              ctx.focusMode === "superagents" ||
              ctx.focusMode === "subagents" ||
              ctx.focusMode === "procs" ||
              ctx.focusMode === "checklist" ||
              ctx.focusMode === "history"
            ) {
              scrollSection(ctx, ctx.focusMode, isUp ? "up" : "down");
            } else {
              ctx.scrollChat(isUp ? "up" : "down", 3);
            }
          }
          continue;
        }

        // --- Click (button 0, press action "M") ---
        if (btn === "0" && action === "M" && rowStr) {
          const y = parseInt(rowStr, 10);
          const x = colStr ? parseInt(colStr, 10) : 0;

          // Find which section was clicked
          let clickedSection: SectionBoundary | null = null;
          for (const section of ctx.sections) {
            if (y >= section.startRow && y <= section.endRow) {
              clickedSection = section;
              break;
            }
          }

          if (process.env.DEBUG_MOUSE === "true") {
            logMouseDebug(`[MOUSE DEBUG] Click at x=${x}, y=${y}. Matched section: ${clickedSection ? clickedSection.name : "none"}\n`);
          }

          // If click is near the bottom (input/statusbar area), set focusMode to "input" immediately
          if (!clickedSection) {
            if (y >= ctx.terminalHeight - 3) {
              ctx.setFocusMode("input");
            }
            continue;
          }

          const name = clickedSection.name;

          // Handle header clicks → toggle collapse
          if (name.endsWith("_header")) {
            const sectionName = name.replace("_header", "");
            ctx.toggleCollapse(sectionName);
            continue;
          }

          switch (name) {
            case "chat": {
              if (ctx.focusedResponseIndex !== null) {
                // Close focused response view on click
                ctx.setFocusedResponseIndex(null);
                ctx.setFocusedResponseOffset(0);
                break;
              }
              // Check if clicked on a chat line
              let handledClick = false;
              if (process.env.DEBUG_MOUSE === "true") {
                logMouseDebug(`[MOUSE DEBUG] Chat click: visible positions are: ${JSON.stringify(ctx.visibleLinePositions)}\n`);
              }
              for (const pos of ctx.visibleLinePositions) {
                const isCollapsibleClick = pos.isCollapsible ? y === pos.startRow : (y >= pos.startRow && y <= pos.endRow);
                // For collapsible headers, allow click anywhere on the row (wide emoji chars make length unreliable).
                // For non-collapsible multi-row blocks, still restrict to text width.
                const isWithinWidth = pos.isCollapsible || pos.length === undefined || x <= pos.length;

                if (isCollapsibleClick && isWithinWidth) {
                  if (process.env.DEBUG_MOUSE === "true") {
                    logMouseDebug(`[MOUSE DEBUG] Matched position: index=${pos.index}, type=${pos.type}, isCollapsible=${pos.isCollapsible}, parentIndex=${pos.parentIndex}, childIndex=${pos.childIndex}, length=${pos.length}\n`);
                  }
                  // Nested child line click → toggle child expand/collapse
                  if (pos.parentIndex !== undefined && pos.childIndex !== undefined && pos.isCollapsible && ctx.toggleChildExpand) {
                    if (process.env.DEBUG_MOUSE === "true") {
                      logMouseDebug(`[MOUSE DEBUG] Toggling child expand for parent=${pos.parentIndex}, child=${pos.childIndex}\n`);
                    }
                    ctx.toggleChildExpand(pos.parentIndex, pos.childIndex);
                    handledClick = true;
                  }
                  // Collapsible line click → toggle expand/collapse
                  else if (pos.isCollapsible && ctx.toggleLineExpand) {
                    if (process.env.DEBUG_MOUSE === "true") {
                      logMouseDebug(`[MOUSE DEBUG] Toggling line expand for index=${pos.index}\n`);
                    }
                    ctx.toggleLineExpand(pos.index);
                    handledClick = true;
                  }
                  // Truncated assistant line click → open scroll view
                  else if (pos.isTruncated && pos.type === "assistant") {
                    ctx.openResponseAtIndex(pos.index);
                    handledClick = true;
                  }
                  break;
                }
              }
              if (!handledClick) {
                ctx.setFocusMode("chat");
              }
              break;
            }
            case "superagents":
              ctx.setFocusMode("superagents");
              break;
            case "subagents":
              ctx.setFocusMode("subagents");
              break;
            case "procs":
              ctx.setFocusMode("procs");
              break;
            case "checklist":
              ctx.setFocusMode("checklist");
              break;
            case "history": {
              ctx.setFocusMode("history");
              const historyList = ctx.history || [];
              const uniqueHistory = Array.from(new Set(historyList));
              const total = uniqueHistory.length;
              if (total > 0) {
                const maxVisible = 10;
                const numericSelectedIndex = Math.min(Math.max(0, ctx.historySelectedIndex || 0), total - 1);
                let start = 0;
                let end = total;
                if (total > maxVisible) {
                  start = Math.max(0, numericSelectedIndex - Math.floor(maxVisible / 2));
                  end = start + maxVisible;
                  if (end > total) {
                    end = total;
                    start = Math.max(0, end - maxVisible);
                  }
                }
                const visibleCount = end - start;
                const hiddenAbove = start > 0;
                const startRowOfEntries = clickedSection.startRow + 1 + (hiddenAbove ? 1 : 0);
                const endRowOfEntries = startRowOfEntries + visibleCount - 1;

                if (y >= startRowOfEntries && y <= endRowOfEntries) {
                  const idx = start + (y - startRowOfEntries);
                  if (idx >= 0 && idx < total) {
                    ctx.setHistorySelectedIndex?.(idx);
                  }
                }
              }
              break;
            }
            case "statusbar":
            case "input":
              ctx.setFocusMode("input");
              ctx.onInputClick?.(x, y);
              break;
            case "wizard":
              if (ctx.activeWizard?.type === "plan_approve") {
                if (ctx.activeWizard.step === 2) {
                  ctx.setFocusMode("input");
                  break;
                }
                // In PlanApprovalDialog step 1, OPTIONS.length is 3.
                // The footer hint takes 1 line at the bottom.
                const optEndRow = clickedSection.endRow - 1;
                const optStartRow = optEndRow - 3 + 1; // 3 options

                if (y < optStartRow) {
                  ctx.setActiveWizard?.((curr: any) => curr ? { ...curr, data: { ...curr.data, focus: "plan" } } : null);
                } else if (y >= optStartRow && y <= optEndRow) {
                  ctx.setActiveWizard?.((curr: any) => curr ? { ...curr, data: { ...curr.data, focus: "actions" } } : null);
                  const idx = y - optStartRow;
                  ctx.setWizardSelectedIndex?.(idx);
                }
              } else if (ctx.activeWizard) {
                // Clicking on options for any other WizardDialog
                const options = ctx.wizardOptions || [];
                const total = options.length;
                if (total > 0) {
                  const maxVisible = 10;
                  const numericSelectedIndex = Math.min(Math.max(0, ctx.wizardSelectedIndex || 0), total - 1);
                  let start = 0;
                  let end = total;
                  if (total > maxVisible) {
                    start = Math.max(0, numericSelectedIndex - Math.floor(maxVisible / 2));
                    end = start + maxVisible;
                    if (end > total) {
                      end = total;
                      start = Math.max(0, end - maxVisible);
                    }
                  }
                  const visibleCount = end - start;

                  // Use computed wizardHeaderRows to locate option start row precisely
                  const headerRows = ctx.wizardHeaderRows ?? 3;
                  const optStartRow = clickedSection.startRow + headerRows;
                  const optEndRow = optStartRow + visibleCount - 1;

                  if (y >= optStartRow && y <= optEndRow) {
                    // Permission dialogs: clicking an option must NOT move the
                    // selection (prevents accidental approve/deny from a stray
                    // mouse click). Focus-only behavior.
                    if (ctx.activeWizard.type !== "permission") {
                      const idx = start + (y - optStartRow);
                      if (idx >= 0 && idx < total) {
                        ctx.setWizardSelectedIndex?.(idx);
                      }
                    }
                  }
                }
              } else {
                ctx.setFocusMode("input");
              }
              break;
          }
        }
      }
    };

    process.stdout.write(enableMouseTracking);
    process.stdin.on("data", handleMouseInput);

    // Last-resort cleanup: disable mouse tracking if process exits without React cleanup running
    const emergencyCleanup = () => {
      try {
        process.stdin.off("data", handleMouseInput);
        process.stdout.write(disableMouseTracking);
      } catch {}
    };
    process.once("exit", emergencyCleanup);
    process.once("SIGINT", emergencyCleanup);
    process.once("SIGTERM", emergencyCleanup);

    return () => {
      process.stdin.off("data", handleMouseInput);
      process.stdout.write(disableMouseTracking);
      // Remove emergency handlers so they don't fire after normal cleanup
      process.off("exit", emergencyCleanup);
      process.off("SIGINT", emergencyCleanup);
      process.off("SIGTERM", emergencyCleanup);
    };
  }, []); // Empty deps - listener registered once, reads latest ctx from ref
}

function scrollSection(
  ctx: SingleAgentMouseContext,
  section: string,
  direction: "up" | "down"
) {
  switch (section) {
    case "superagents":
      ctx.setSuperagentsScrollOffset((prev: number) => {
        if (direction === "up") return Math.max(0, prev - 1);
        const maxScroll = Math.max(0, ctx.runningSuperagentsCount - ctx.maxSuperagentsVisible);
        return Math.min(prev + 1, maxScroll);
      });
      break;
    case "subagents":
      ctx.setSubagentsScrollOffset((prev: number) => {
        if (direction === "up") return Math.max(0, prev - 1);
        const maxScroll = Math.max(0, ctx.runningSubagentsCount - ctx.maxSubagentsVisible);
        return Math.min(prev + 1, maxScroll);
      });
      break;
    case "procs":
      ctx.setProcsScrollOffset((prev: number) => {
        if (direction === "up") return Math.max(0, prev - 1);
        const maxScroll = Math.max(0, ctx.runningTasksCount - ctx.maxProcsVisible);
        return Math.min(prev + 1, maxScroll);
      });
      break;
    case "checklist":
      ctx.setChecklistScrollOffset((prev: number) => {
        if (direction === "up") return Math.max(0, prev - 1);
        const maxScroll = Math.max(0, ctx.checklistTasksCount - ctx.maxChecklistVisible);
        return Math.min(prev + 1, maxScroll);
      });
      break;
    case "history":
      if (ctx.setHistorySelectedIndex && ctx.history) {
        const uniqueHistory = Array.from(new Set(ctx.history));
        const total = uniqueHistory.length;
        if (total > 0) {
          ctx.setHistorySelectedIndex((prev: number) => {
            if (direction === "up") {
              return Math.max(0, prev - 1);
            } else {
              return Math.min(total - 1, prev + 1);
            }
          });
        }
      }
      break;
  }
}
