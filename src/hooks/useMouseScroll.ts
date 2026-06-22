import { useEffect, type MutableRefObject } from "react";
import { planApprovalChromeHeight } from "../components/plan-approval-dialog.js";

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
    const enableMouseTracking = "\x1b[?1000h\x1b[?1006h";
    const disableMouseTracking = "\x1b[?1006l\x1b[?1000l";

    const handleMouseInput = (data: Buffer) => {
      const ctx = ctxRef.current;
      if (!ctx) return;

      const text = data.toString("utf8");
      const matches = text.matchAll(
        /\x1b\[<(?<btn>\d+);(?<col>\d+);(?<row>\d+)(?<action>[Mm])/g
      );

      for (const match of matches) {
        const btn = match.groups?.btn;
        const rowStr = match.groups?.row;
        const action = match.groups?.action;

        // --- Scroll wheel ---
        if (btn === "64") {
          // Scroll up
          if (ctx.activeWizard?.type === "plan_approve") {
            ctx.setActiveWizard?.((curr: any) => {
              if (!curr) return null;
              const currentOffset = curr.data?.scrollOffset || 0;
              const nextOffset = Math.max(0, currentOffset - 1);
              return { ...curr, data: { ...curr.data, scrollOffset: nextOffset } };
            });
          } else if (ctx.focusedResponseIndex !== null) {
            ctx.setFocusedResponseOffset((prev: number) => Math.max(0, prev - 1));
          } else if (
            ctx.focusMode === "superagents" ||
            ctx.focusMode === "subagents" ||
            ctx.focusMode === "procs" ||
            ctx.focusMode === "checklist"
          ) {
            scrollSection(ctx, ctx.focusMode, "up");
          } else {
            ctx.scrollChat("up");
          }
          continue;
        }

        if (btn === "65") {
          // Scroll down
          if (ctx.activeWizard?.type === "plan_approve") {
            ctx.setActiveWizard?.((curr: any) => {
              if (!curr) return null;
              const currentOffset = curr.data?.scrollOffset || 0;
              const nextOffset = currentOffset + 1;
              return { ...curr, data: { ...curr.data, scrollOffset: nextOffset } };
            });
          } else if (ctx.focusedResponseIndex !== null) {
            ctx.setFocusedResponseOffset((prev: number) => {
              const maxOffset = Math.max(0, ctx.responseLinesCount - ctx.focusWindowHeight);
              return Math.min(prev + 1, maxOffset);
            });
          } else if (
            ctx.focusMode === "superagents" ||
            ctx.focusMode === "subagents" ||
            ctx.focusMode === "procs" ||
            ctx.focusMode === "checklist"
          ) {
            scrollSection(ctx, ctx.focusMode, "down");
          } else {
            ctx.scrollChat("down");
          }
          continue;
        }

        // --- Click (button 0, press action "M") ---
        if (btn === "0" && action === "M" && rowStr) {
          const y = parseInt(rowStr, 10);

          // Find which section was clicked
          let clickedSection: SectionBoundary | null = null;
          for (const section of ctx.sections) {
            if (y >= section.startRow && y <= section.endRow) {
              clickedSection = section;
              break;
            }
          }

          if (!clickedSection) continue;

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
              for (const pos of ctx.visibleLinePositions) {
                if (y >= pos.startRow && y <= pos.endRow) {
                  // Nested child line click → toggle child expand/collapse
                  if (pos.parentIndex !== undefined && pos.childIndex !== undefined && pos.isCollapsible && ctx.toggleChildExpand) {
                    ctx.toggleChildExpand(pos.parentIndex, pos.childIndex);
                    handledClick = true;
                  }
                  // Collapsible line click → toggle expand/collapse
                  else if (pos.isCollapsible && ctx.toggleLineExpand) {
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
            case "input":
            case "wizard":
              if (ctx.activeWizard?.type === "plan_approve") {
                const planPath = ctx.planPath || "";
                const H = planApprovalChromeHeight(planPath, ctx.activeWizard.step);
                const optStartRow = clickedSection.startRow + H - 4; // OPTIONS.length + 1
                const optEndRow = clickedSection.startRow + H - 2;

                if (y < optStartRow - 1) {
                  ctx.setActiveWizard?.((curr: any) => curr ? { ...curr, data: { ...curr.data, focus: "plan" } } : null);
                } else if (y >= optStartRow - 1 && y <= optEndRow + 1) {
                  ctx.setActiveWizard?.((curr: any) => curr ? { ...curr, data: { ...curr.data, focus: "actions" } } : null);
                  if (y >= optStartRow && y <= optEndRow) {
                    const idx = y - optStartRow;
                    ctx.setWizardSelectedIndex?.(idx);
                  }
                }
              } else {
                ctx.setFocusMode("input");
              }
              break;
            // statusbar: ignore clicks
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
  }
}
