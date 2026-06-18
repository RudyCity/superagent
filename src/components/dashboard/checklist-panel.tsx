import React from "react";
import { Box, Text } from "ink";

interface ChecklistPanelProps {
  planState: string;
  checklistTasks: any[];
  focusArea: string;
  checklistScrollOffset: number;
  maxChecklistVisible: number;
  agent: any;
  superagentInstances: any;
  completedHistory?: { status: string; text: string }[];
}

const MAX_HISTORY_VISIBLE = 3;

export function ChecklistPanel({
  planState,
  checklistTasks,
  focusArea,
  checklistScrollOffset,
  maxChecklistVisible,
  agent,
  superagentInstances,
  completedHistory = [],
}: ChecklistPanelProps) {
  const hasActiveTasks = checklistTasks.length > 0;
  const hasHistory = completedHistory.length > 0;

  // Only show when plan is approved AND (there are active tasks OR completed history)
  if (planState !== "APPROVED" || (!hasActiveTasks && !hasHistory)) {
    return null;
  }

  const totalTasks = checklistTasks.length;
  const completedTasks = checklistTasks.filter((t) => t.status === "x").length;
  const inProgressTasks = checklistTasks.filter((t) => t.status === "/").length;
  const pct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  const hasScroll = totalTasks > maxChecklistVisible;
  const scrollIndicator = hasScroll
    ? ` [Scroll: ${checklistScrollOffset + 1}-${Math.min(totalTasks, checklistScrollOffset + maxChecklistVisible)}/${totalTasks}]`
    : "";
  const helpText = focusArea === "checklist" ? " [↑/▼ Scroll • Esc Exit]" : "";
  const visibleChecklist = checklistTasks.slice(checklistScrollOffset, checklistScrollOffset + maxChecklistVisible);

  // Progress bar
  const barWidth = 20;
  const filledWidth = Math.round((pct / 100) * barWidth);
  const emptyWidth = barWidth - filledWidth;
  const progressBar = "█".repeat(filledWidth) + "░".repeat(emptyWidth);

  // History: show the most recent completed tasks (capped)
  const historyToShow = completedHistory.slice(-MAX_HISTORY_VISIBLE);
  const hiddenHistoryCount = completedHistory.length - historyToShow.length;

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      marginBottom={1}
    >
      {/* Active Tasks Section */}
      {hasActiveTasks && (
        <>
          {/* Header */}
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold color={focusArea === "checklist" ? "green" : "cyan"}>
              📋 ACTIVE TASK CHECKLIST ({completedTasks}/{totalTasks} completed){scrollIndicator}{helpText}
            </Text>
          </Box>

          {/* Progress bar */}
          <Box flexDirection="row" marginBottom={1}>
            <Text color="cyan">Progress: </Text>
            <Text color={pct === 100 ? "green" : "yellow"}>{progressBar}</Text>
            <Text color="cyan"> {pct}% ({completedTasks}/{totalTasks} completed, {inProgressTasks} in progress)</Text>
          </Box>

          {/* Timeline task list */}
          {visibleChecklist.map((task, index) => {
            const idx = checklistScrollOffset + index;
            const isLastVisible = index === visibleChecklist.length - 1;
            let status = task.status;
            let statusIcon = "○";
            let taskColor = "white";
            let connectorColor = "gray";
            let displayStatusText = "";

            // Dynamic status override in multi-agent mode based on active superagents
            if (agent && agent.isMultiAgent) {
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
              taskColor = "magenta";
              connectorColor = "magenta";
              displayStatusText = " (paused)";
            } else if (status === "error") {
              statusIcon = "✗";
              taskColor = "red";
              connectorColor = "red";
              displayStatusText = " (failed)";
            }

            const connector = isLastVisible && !hasHistory ? "└──" : "├──";

            return (
              <Box key={idx} flexDirection="column">
                <Box flexDirection="row">
                  <Text color={connectorColor}>{connector} </Text>
                  <Text color={connectorColor}>{statusIcon} </Text>
                  <Text color={taskColor} strikethrough={status === "x"}>
                    {task.text}{displayStatusText}
                  </Text>
                </Box>
                {(!isLastVisible || hasHistory) && (
                  <Box flexDirection="row">
                    <Text color="gray">│</Text>
                  </Box>
                )}
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
            const isLast = index === historyToShow.length - 1;
            const connector = isLast ? "└──" : "├──";
            return (
              <Box key={`hist-${index}`} flexDirection="column">
                <Box flexDirection="row">
                  <Text color="gray" dimColor>{connector} </Text>
                  <Text color="gray" dimColor>◉ </Text>
                  <Text color="gray" dimColor strikethrough>
                    {task.text}
                  </Text>
                </Box>
                {!isLast && (
                  <Box flexDirection="row">
                    <Text color="gray" dimColor>│</Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </>
      )}
    </Box>
  );
}
