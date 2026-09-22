import React, { useState, useMemo, useRef, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import fs from "fs";
import { wrapTextForDisplay } from "../utils/responseScroll.js";

import path from "path";

// Module-level cache: plan file content shared by planLines + totalLines
// computation, invalidated by mtime. Plan files rarely change mid-dialog,
// so this avoids reading the same file twice and keeps the dialog snappy
// when the plan is large.
const planReadCache: { key: string | null; mtimeMs: number; lines: string[] } = {
  key: null,
  mtimeMs: 0,
  lines: [],
};

export function resolveExistingPlanPath(initialPath: string): string | null {
  if (initialPath && fs.existsSync(initialPath)) return initialPath;
  const cwdPlan = path.join(process.cwd(), "implementation_plan.md");
  if (fs.existsSync(cwdPlan)) return cwdPlan;
  if (initialPath) {
    try {
      const dir = path.dirname(initialPath);
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        const match = files.find(f => f.endsWith("_implementation_plan.md") || f === "implementation_plan.md");
        if (match) return path.join(dir, match);
      }
    } catch {}
  }
  return null;
}

function readPlanLines(planFilePath: string): { lines: string[]; found: boolean; resolvedPath: string } {
  const resolved = resolveExistingPlanPath(planFilePath);
  if (!resolved) {
    return {
      lines: ["(No implementation plan file found. The agent has not prepared a plan yet.)"],
      found: false,
      resolvedPath: planFilePath,
    };
  }
  try {
    const stat = fs.statSync(resolved);
    if (
      planReadCache.key === resolved &&
      planReadCache.mtimeMs === stat.mtimeMs
    ) {
      return { lines: planReadCache.lines, found: true, resolvedPath: resolved };
    }
    const raw = fs.readFileSync(resolved, "utf8");
    const lines = raw.split("\n");
    planReadCache.key = resolved;
    planReadCache.mtimeMs = stat.mtimeMs;
    planReadCache.lines = lines;
    return { lines, found: true, resolvedPath: resolved };
  } catch {
    return {
      lines: ["(Plan file could not be read or is unreadable)"],
      found: false,
      resolvedPath: resolved,
    };
  }
}

interface PlanApprovalDialogProps {
  planFilePath: string;
  selectedIndex: number;
  step: number; // 1 = options, 2 = custom feedback input
  borderColor?: "yellow" | "cyan" | "blue" | "green" | "gray" | "white" | "red";
  terminalWidth?: number;
  /** Maximum number of plan content lines visible at once */
  maxContentHeight?: number;
  focus?: "plan" | "actions";
  scrollOffset?: number;
  onScrollChange?: (val: number) => void;
}

const OPTIONS = [
  { label: "Approve Plan & Proceed", emoji: "✅", color: "green" },
  { label: "Reject Plan & Stop", emoji: "❌", color: "red" },
  { label: "Custom Feedback / Discuss", emoji: "💬", color: "cyan" },
] as const;

export function PlanApprovalDialog({
  planFilePath,
  selectedIndex,
  step,
  borderColor = "yellow",
  terminalWidth,
  maxContentHeight = 15,
  focus = "actions",
  scrollOffset: propScrollOffset,
  onScrollChange: propOnScrollChange,
}: PlanApprovalDialogProps) {
  const [localScrollOffset, setLocalScrollOffset] = useState(0);
  const scrollOffset = propScrollOffset !== undefined ? propScrollOffset : localScrollOffset;
  const setScrollOffset = (val: number | ((prev: number) => number)) => {
    const next = typeof val === "function" ? val(scrollOffset) : val;
    if (propOnScrollChange) {
      propOnScrollChange(next);
    } else {
      setLocalScrollOffset(next);
    }
  };

  // Read plan content (memoised on file path, mtime-cached across the module)
  const planInfo = useMemo(() => readPlanLines(planFilePath), [planFilePath]);
  const planLines = planInfo.lines;
  const isPlanFound = planInfo.found;
  const displayPlanPath = planInfo.resolvedPath;

  const totalLines = planLines.length;

  // Handle PageUp / PageDown / Arrow keys for plan content scroll
  const handlerRef = useRef<(_input: string, key: any) => void>();
  handlerRef.current = (_input, key) => {
    if (step !== 1) return;
    const isPlanFocused = focus === "plan";

    if (key.pageUp || (key.ctrl && key.upArrow) || (key.shift && key.upArrow) || (isPlanFocused && key.upArrow)) {
      const amount = (key.upArrow && !key.ctrl && !key.shift) ? 1 : maxContentHeight;
      setScrollOffset((prev) => Math.max(0, prev - amount));
    }
    if (key.pageDown || (key.ctrl && key.downArrow) || (key.shift && key.downArrow) || (isPlanFocused && key.downArrow)) {
      const amount = (key.downArrow && !key.ctrl && !key.shift) ? 1 : maxContentHeight;
      const maxScroll = Math.max(0, totalLines - maxContentHeight);
      setScrollOffset((prev) => Math.min(maxScroll, prev + amount));
    }
  };

  const stableHandler = useCallback((_input: string, key: any) => {
    handlerRef.current?.(_input, key);
  }, []);

  useInput(stableHandler);

  // Clamp scroll offset if content shrinks
  const maxScroll = Math.max(0, totalLines - maxContentHeight);
  const clampedOffset = Math.min(scrollOffset, maxScroll);

  const visibleLines = planLines.slice(clampedOffset, clampedOffset + maxContentHeight);
  const hasMoreAbove = clampedOffset > 0;
  const hasMoreBelow = clampedOffset + maxContentHeight < totalLines;

  const widthVal = terminalWidth || process.stdout.columns || 110;
  const contentWidth = Math.max(10, widthVal - 4);

  // ─── Step 2: custom feedback input prompt ───
  if (step === 2) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row" width="100%">
          <Text color={borderColor} wrap="truncate-end">
            ├───[ <Text bold color={borderColor}>💬 CUSTOM PLAN FEEDBACK (Type your message & press Enter, Esc: cancel):</Text> ]
          </Text>
        </Box>
        <Box flexDirection="row" width="100%">
          <Text color={borderColor}>│ </Text>
          <Text color="gray" dimColor wrap="truncate-end">
            Describe the changes you'd like — the agent will receive your feedback and revise the plan.
          </Text>
        </Box>
      </Box>
    );
  }

  const isPlanFocused = focus === "plan";
  const focusTag = isPlanFocused
    ? "⬅ Scroll Plan  |  → Focus Actions"
    : "↑↓ Navigate Actions  |  ← Scroll Plan";
  const totalLabel = `line ${clampedOffset + 1}–${Math.min(clampedOffset + maxContentHeight, totalLines)} of ${totalLines}`;

  // ─── Step 1: plan content + options ───
  return (
    <Box flexDirection="column" marginTop={1}>

      {/* ══ TOP BANNER ══ */}
      <Box flexDirection="row" width="100%">
        <Text bold color="yellow">╔══[ </Text>
        <Text bold color="yellow">⚡ PLAN</Text>
        <Text bold color="magenta"> APPROVAL</Text>
        <Text bold color="red"> REQUIRED</Text>
        <Text bold color="yellow"> ]══╗</Text>
      </Box>
      <Box flexDirection="row" width="100%">
        <Text bold color="yellow">║  </Text>
        <Text color={isPlanFound ? "gray" : "red"}>
          {isPlanFound ? "Agent has prepared a plan —" : "No implementation plan file found —"}
        </Text>
        <Text color="white" bold>
          {isPlanFound ? " review and decide before execution proceeds." : " agent has not prepared a plan yet."}
        </Text>
      </Box>
      <Box flexDirection="row" width="100%">
        <Text bold color="yellow">║  </Text>
        <Text color="gray" dimColor>Focus: </Text>
        <Text color="cyan" bold>{focusTag}</Text>
      </Box>
      <Box flexDirection="row" width="100%">
        <Text bold color="yellow">╚══[ </Text>
        <Text color="gray" dimColor>📄 </Text>
        <Text color="cyan" bold wrap="truncate-end">{displayPlanPath}</Text>
        <Text bold color="yellow"> ]</Text>
      </Box>

      {/* ── Plan Content header ── */}
      <Box flexDirection="row" width="100%">
        <Text color={borderColor}>┌─ </Text>
        <Text color={borderColor} bold>PLAN CONTENT</Text>
        <Text color="gray" dimColor> ({totalLabel})</Text>
        <Text color={borderColor}> ──────────────────────────────────</Text>
      </Box>

      {/* Scroll-up indicator */}
      {hasMoreAbove && (
        <Box flexDirection="row" width="100%">
          <Text color={borderColor}>│ </Text>
          <Text color="yellow" bold>▲ {clampedOffset} lines above</Text>
          <Text color="gray" dimColor>  (PgUp / Ctrl+↑)</Text>
        </Box>
      )}

      {/* Plan content viewport */}
      {visibleLines.map((line, idx) => {
        const wrappedLines = wrapTextForDisplay(line || " ", contentWidth);
        return wrappedLines.map((wl, wIdx) => (
          <Box key={`${clampedOffset + idx}-${wIdx}`} flexDirection="row" width="100%">
            <Text color={borderColor} dimColor>│ </Text>
            <Text color="white" wrap="truncate-end">{wl}</Text>
          </Box>
        ));
      })}

      {/* Scroll-down indicator */}
      {hasMoreBelow && (
        <Box flexDirection="row" width="100%">
          <Text color={borderColor}>│ </Text>
          <Text color="yellow" bold>▼ {totalLines - clampedOffset - maxContentHeight} lines below</Text>
          <Text color="gray" dimColor>  (PgDn / Ctrl+↓)</Text>
        </Box>
      )}

      {/* ── Actions header ── */}
      <Box flexDirection="row" width="100%">
        <Text color={borderColor}>├─ </Text>
        <Text color={borderColor} bold>ACTIONS</Text>
        <Text color={borderColor}> ──────────────────────────────────────────────────</Text>
      </Box>

      {/* Options */}
      {OPTIONS.map((opt, idx) => {
        const isSelected = idx === selectedIndex;
        return (
          <Box key={opt.label} flexDirection="row" width="100%">
            <Text color={borderColor}>│ </Text>
            {isSelected ? (
              <>
                <Text bold color={opt.color}>▶ [</Text>
                <Text bold color={opt.color}> {opt.emoji} {opt.label} </Text>
                <Text bold color={opt.color}>]</Text>
              </>
            ) : (
              <Text color="gray" dimColor>  {opt.emoji} {opt.label}</Text>
            )}
          </Box>
        );
      })}

      {/* Footer hint */}
      <Box flexDirection="row" width="100%">
        <Text color={borderColor}>└─ </Text>
        <Text color="gray" dimColor>↑↓ </Text>
        <Text color="white" dimColor>navigate</Text>
        <Text color="gray" dimColor>  ·  Enter </Text>
        <Text color="green" dimColor>confirm</Text>
        <Text color="gray" dimColor>  ·  ←→ </Text>
        <Text color="cyan" dimColor>switch focus</Text>
        <Text color="gray" dimColor>  ·  PgUp/PgDn </Text>
        <Text color="yellow" dimColor>scroll</Text>
      </Box>

    </Box>
  );
}

/** The default option labels — used by callers that set wizardOptions */
export const PLAN_APPROVAL_OPTIONS = OPTIONS.map((o) => `${o.emoji} ${o.label}`);

/** How many lines the plan approval dialog occupies (for chrome height calc) */
export function planApprovalChromeHeight(
  planFilePath: string,
  step: number,
  maxContentHeight: number = 15,
): number {
  if (step === 2) return 3; // title + hint + border
  let lines = 0;
  let totalLines = 0;
  try {
    totalLines = fs.readFileSync(planFilePath, "utf8").split("\n").length;
  } catch {
    totalLines = 1;
  }
  const visibleContent = Math.min(totalLines, maxContentHeight);
  lines += 4; // banner: ╔══, ║ desc, ║ focus, ╚══
  lines += 1; // PLAN CONTENT header
  if (totalLines > maxContentHeight) lines += 1; // scroll-up indicator
  lines += visibleContent;
  if (totalLines > maxContentHeight && totalLines > visibleContent) lines += 1; // scroll-down indicator
  lines += 1; // separator "Actions"
  lines += OPTIONS.length; // options
  lines += 1; // hint line
  return lines;
}
