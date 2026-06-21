import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import fs from "fs";
import { wrapTextForDisplay } from "../utils/responseScroll.js";

interface PlanApprovalDialogProps {
  planFilePath: string;
  selectedIndex: number;
  step: number; // 1 = options, 2 = custom feedback input
  borderColor?: "yellow" | "cyan" | "magenta" | "green" | "gray" | "white" | "red";
  terminalWidth?: number;
  /** Maximum number of plan content lines visible at once */
  maxContentHeight?: number;
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
}: PlanApprovalDialogProps) {
  const [scrollOffset, setScrollOffset] = useState(0);

  // Read plan content (memoised on file path)
  const planLines = useMemo(() => {
    try {
      const raw = fs.readFileSync(planFilePath, "utf8");
      return raw.split("\n");
    } catch {
      return ["(Plan file not found or unreadable)"];
    }
  }, [planFilePath]);

  const totalLines = planLines.length;

  // Handle PageUp / PageDown for plan content scroll
  useInput((_input, key) => {
    if (step !== 1) return;
    if (key.pageUp || (key.ctrl && key.upArrow) || (key.shift && key.upArrow)) {
      setScrollOffset((prev) => Math.max(0, prev - maxContentHeight));
    }
    if (key.pageDown || (key.ctrl && key.downArrow) || (key.shift && key.downArrow)) {
      const maxScroll = Math.max(0, totalLines - maxContentHeight);
      setScrollOffset((prev) => Math.min(maxScroll, prev + maxContentHeight));
    }
  });

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

  // ─── Step 1: plan content + options ───
  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Title */}
      <Box flexDirection="row" width="100%">
        <Text color={borderColor} wrap="truncate-end">
          ├───[ <Text bold color={borderColor}>⚠️ PLAN APPROVAL REQUIRED</Text> ]
        </Text>
      </Box>

      {/* File path */}
      <Box flexDirection="row" width="100%">
        <Text color={borderColor}>│ </Text>
        <Text color="gray" dimColor wrap="truncate-end">
          File: <Text color="cyan" bold>{planFilePath}</Text>
        </Text>
      </Box>

      {/* Separator */}
      <Box flexDirection="row" width="100%">
        <Text color={borderColor}>├─────────────────────────────────── Plan Content ──</Text>
      </Box>

      {/* Scroll-up indicator */}
      {hasMoreAbove && (
        <Box flexDirection="row" width="100%">
          <Text color={borderColor}>│ </Text>
          <Text color="yellow" wrap="truncate-end">
            ▲ ... ({clampedOffset} more lines above — use PgUp/Ctrl+↑ to scroll) ...
          </Text>
        </Box>
      )}

      {/* Plan content viewport */}
      {visibleLines.map((line, idx) => {
        const wrappedLines = wrapTextForDisplay(line || " ", contentWidth);
        return wrappedLines.map((wl, wIdx) => (
          <Box key={`${clampedOffset + idx}-${wIdx}`} flexDirection="row" width="100%">
            <Text color={borderColor}>│ </Text>
            <Text color="white" wrap="truncate-end">{wl}</Text>
          </Box>
        ));
      })}

      {/* Scroll-down indicator */}
      {hasMoreBelow && (
        <Box flexDirection="row" width="100%">
          <Text color={borderColor}>│ </Text>
          <Text color="yellow" wrap="truncate-end">
            ▼ ... ({totalLines - clampedOffset - maxContentHeight} more lines below — use PgDn/Ctrl+↓ to scroll) ...
          </Text>
        </Box>
      )}

      {/* Separator */}
      <Box flexDirection="row" width="100%">
        <Text color={borderColor}>├─────────────────────────────────── Actions ───────</Text>
      </Box>

      {/* Options */}
      {OPTIONS.map((opt, idx) => {
        const isSelected = idx === selectedIndex;
        return (
          <Box key={opt.label} flexDirection="row" width="100%">
            <Text color={borderColor}>│ </Text>
            <Box flexDirection="row" flexShrink={1}>
              <Text
                color={isSelected ? opt.color : "gray"}
                bold={isSelected}
                dimColor={!isSelected}
                wrap="truncate-end"
              >
                {isSelected ? "❯ " : "  "}
                {opt.emoji} {opt.label}
              </Text>
            </Box>
          </Box>
        );
      })}

      {/* Hint */}
      <Box flexDirection="row" width="100%">
        <Text color={borderColor}>│ </Text>
        <Text color="gray" dimColor wrap="truncate-end">
          ↑/↓ navigate · Enter: select · PgUp/PgDn: scroll plan
        </Text>
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
  lines += 1; // title
  lines += 1; // file path
  lines += 1; // separator "Plan Content"
  if (totalLines > maxContentHeight) lines += 1; // scroll-up indicator
  lines += visibleContent;
  if (totalLines > maxContentHeight && totalLines > visibleContent) lines += 1; // scroll-down indicator
  lines += 1; // separator "Actions"
  lines += OPTIONS.length; // options
  lines += 1; // hint line
  return lines;
}
