import React from "react";
import { Box, Text } from "ink";
import { superagentInstances } from "../core/tools.js";
import { unicodeStrikethrough } from "../utils/text.js";

interface TaskChecklistProps {
  planState: string;
  checklistTasks: { status: string; text: string }[];
  checklistScrollOffset: number;
  maxChecklistVisible: number;
  focusMode: string;
  isMultiAgent: boolean;
  completedHistory?: { status: string; text: string }[];
}

const MAX_HISTORY_VISIBLE = 3;

export function TaskChecklist({
  planState,
  checklistTasks,
  checklistScrollOffset,
  maxChecklistVisible,
  focusMode,
  isMultiAgent,
  completedHistory = [],
}: TaskChecklistProps) {
  const hasActiveTasks = checklistTasks.length > 0;
  const hasHistory = completedHistory.length > 0;

  // Only show when plan is approved AND (there are active tasks OR completed history)
  if (planState !== "APPROVED" || (!hasActiveTasks && !hasHistory)) {
    return null;
  }

  const totalTasks = checklistTasks.length;
  const completedTasks = checklistTasks.filter((t) => t.status === "x").length;
  const hasScroll = totalTasks > maxChecklistVisible;
  const scrollIndicator = hasScroll
    ? ` [Scroll: ${checklistScrollOffset + 1}-${Math.min(totalTasks, checklistScrollOffset + maxChecklistVisible)}/${totalTasks}]`
    : "";
  const helpText = focusMode === "checklist" ? " [↑/▼ Scroll • Esc Exit]" : " [Ctrl+T Focus]";
  const visibleChecklist = checklistTasks.slice(checklistScrollOffset, checklistScrollOffset + maxChecklistVisible);

  // History: show the most recent completed tasks (capped)
  const historyToShow = completedHistory.slice(-MAX_HISTORY_VISIBLE);
  const hiddenHistoryCount = completedHistory.length - historyToShow.length;

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
              📋 ACTIVE TASK CHECKLIST ({completedTasks}/{totalTasks} completed){scrollIndicator}{helpText}
            </Text>
          </Box>

          {/* Timeline task list */}
          {visibleChecklist.map((task, index) => {
            const idx = checklistScrollOffset + index;
            let status = task.status;
            let statusIcon = "○";
            let taskColor = "white";
            let connectorColor = "gray";
            let displayStatusText = "";

            // Dynamic status override in multi-agent mode based on active superagents
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

            const displayText = status === "x"
              ? unicodeStrikethrough(task.text)
              : task.text;

            return (
              <Box key={idx} flexDirection="row">
                <Text color={connectorColor}>{connector} </Text>
                <Text color={connectorColor}>{statusIcon} </Text>
                <Text color={taskColor}>
                  {displayText}{displayStatusText}
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
              ✓ PREVIOUSLY COMPLETED ({completedHistory.length} tasks)
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
                <Text color="gray" dimColor>
                  {unicodeStrikethrough(task.text)}
                </Text>
              </Box>
            );
          })}
        </>
      )}
    </Box>
  );
}
