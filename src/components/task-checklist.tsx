import React, { memo } from "react";
import { Box, Text } from "ink";
import { superagentInstances } from "../core/tools.js";

interface TaskChecklistProps {
  planState: string;
  checklistTasks: { status: string; text: string }[];
  checklistScrollOffset: number;
  maxChecklistVisible: number;
  focusMode: string;
  isMultiAgent: boolean;
  completedHistory?: { status: string; text: string; remainingSeconds?: number }[];
  maxHistoryVisible?: number;
  collapsedSections?: { superagents: boolean; subagents: boolean; procs: boolean; checklist: boolean };
}

export const TaskChecklist = memo(function TaskChecklist({
  planState,
  checklistTasks,
  checklistScrollOffset,
  maxChecklistVisible,
  focusMode,
  isMultiAgent,
  completedHistory = [],
  maxHistoryVisible = 3,
  collapsedSections,
}: TaskChecklistProps) {
  const hasActiveTasks = checklistTasks.length > 0;
  const hasHistory = completedHistory.length > 0;

  // Only show when plan is approved AND (there are active tasks OR completed history)
  if (planState !== "APPROVED" || (!hasActiveTasks && !hasHistory)) {
    return null;
  }

  const isCollapsed = collapsedSections?.checklist || false;
  const collapseIcon = isCollapsed ? "▶" : "▼";
  // Map dynamic task status overrides to count completed and ongoing tasks
  const resolvedTasks = checklistTasks.map((task) => {
    let status = task.status;
    if (isMultiAgent) {
      for (const inst of superagentInstances.values()) {
        const roleLower = inst.role.toLowerCase();
        if (task.text.toLowerCase().includes(roleLower)) {
          const isMergeOrCleanup = /merge|cleanup|prune/i.test(task.text);
          if (!isMergeOrCleanup) {
            if (inst.status === "running") {
              status = "/";
            } else if (inst.status === "paused") {
              status = "paused";
            } else if (inst.status === "completed") {
              status = "x";
            } else if (inst.status === "error") {
              status = "error";
            }
          } else {
            if (inst.status === "completed") {
              status = "/";
            }
          }
          break;
        }
      }
    }
    return { ...task, status };
  });

  const totalTasks = resolvedTasks.length;
  const completedTasks = resolvedTasks.filter((t) => t.status === "x").length;
  const ongoingTasks = resolvedTasks.filter((t) => t.status === "/").length;
  const hasScroll = totalTasks > maxChecklistVisible;
  const scrollIndicator = hasScroll
    ? ` [Scroll: ${checklistScrollOffset + 1}-${Math.min(totalTasks, checklistScrollOffset + maxChecklistVisible)}/${totalTasks}]`
    : "";
  const helpText = isCollapsed
    ? ""
    : (focusMode === "checklist" ? " [↑/▼ Scroll • Esc Exit]" : " [Ctrl+T Focus]");
  const visibleChecklist = resolvedTasks.slice(checklistScrollOffset, checklistScrollOffset + maxChecklistVisible);

  // History: show the most recent completed tasks (capped)
  const historyToShow = completedHistory.slice(-maxHistoryVisible);
  const hiddenHistoryCount = completedHistory.length - historyToShow.length;

  // Find the maximum remaining seconds for the countdown header
  const maxRemaining = historyToShow.reduce((max, t) => {
    if (t.remainingSeconds !== undefined && (max === undefined || t.remainingSeconds > max)) {
      return t.remainingSeconds;
    }
    return max;
  }, undefined as number | undefined);
  const headerTimeText = maxRemaining !== undefined ? ` ~ Hide in (${maxRemaining}s)` : "";

  const statusText = `(${completedTasks}/${totalTasks} comp. | ${ongoingTasks}/${totalTasks} ongoing)`;

  if (isCollapsed) {
    return (
      <Box flexDirection="column">
        <Text bold color={focusMode === "checklist" ? "green" : "cyan"}>
          {collapseIcon} ACTIVE TASK CHECKLIST {statusText}
        </Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
    >
      {/* Active Tasks Section */}
      {hasActiveTasks && (
        <>
          {/* Header */}
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold color={focusMode === "checklist" ? "green" : "cyan"}>
              {collapseIcon} ACTIVE TASK CHECKLIST {statusText}{scrollIndicator}{helpText}
            </Text>
          </Box>

          {/* Timeline task list */}
          {visibleChecklist.map((task, index) => {
            const idx = checklistScrollOffset + index;
            const status = task.status;
            let statusIcon = "○";
            let taskColor = "white";
            let connectorColor = "gray";
            let displayStatusText = "";

            if (status === "x") {
              statusIcon = "◉";
              taskColor = "gray";
              connectorColor = "green";
            } else if (status === "/") {
              statusIcon = "●";
              taskColor = "yellow";
              connectorColor = "yellow";
              displayStatusText = " (in progress)";
            } else if (status === "paused") {
              statusIcon = "⏸";
              taskColor = "blue";
              connectorColor = "blue";
              displayStatusText = " (paused)";
            } else if (status === "error") {
              statusIcon = "✗";
              taskColor = "red";
              connectorColor = "red";
              displayStatusText = " (failed)";
            }

            const connector = "├──";

            const isCompleted = status === "x";

            return (
              <Box key={idx} flexDirection="row">
                <Text color={connectorColor}>{connector} </Text>
                <Text color={connectorColor}>{statusIcon} </Text>
                <Text color={taskColor} strikethrough={isCompleted}>
                  {task.text}{displayStatusText}
                </Text>
              </Box>
            );
          })}
        </>
      )}

      {/* Completed History Section */}
      {hasHistory && (
        <>
          {/* History header */}
          <Box flexDirection="row" marginBottom={0}>
            <Text bold color="gray" dimColor>
              ✓ PREVIOUSLY COMPLETED ({completedHistory.length} tasks){headerTimeText}
            </Text>
          </Box>

          {/* Hidden count indicator */}
          {hiddenHistoryCount > 0 && (
            <Box flexDirection="row">
              <Text color="gray" dimColor>
                {"  "}… +{hiddenHistoryCount} more in history
              </Text>
            </Box>
          )}

          {/* History task list (dimmed, compact) */}
          {historyToShow.map((task, index) => {
            const connector = "├──";
            return (
              <Box key={`hist-${index}`} flexDirection="row">
                <Text color="gray" dimColor>{connector} </Text>
                <Text color="gray" dimColor>◉ </Text>
                <Text color="gray" dimColor strikethrough>
                  {task.text}
                </Text>
              </Box>
            );
          })}
        </>
      )}
    </Box>
  );
});
