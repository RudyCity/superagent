import React from "react";
import { Box, Text } from "ink";
import { superagentInstances } from "../core/tools.js";

interface TaskChecklistProps {
  planState: string;
  checklistTasks: { status: string; text: string }[];
  checklistScrollOffset: number;
  maxChecklistVisible: number;
  focusMode: string;
  isMultiAgent: boolean;
}

export function TaskChecklist({
  planState,
  checklistTasks,
  checklistScrollOffset,
  maxChecklistVisible,
  focusMode,
  isMultiAgent,
}: TaskChecklistProps) {
  if (planState !== "APPROVED" || checklistTasks.length === 0) {
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
  const helpText = focusMode === "checklist" ? " [↑/▼ Scroll • Esc Exit]" : " [Ctrl+T Focus]";
  const visibleChecklist = checklistTasks.slice(checklistScrollOffset, checklistScrollOffset + maxChecklistVisible);

  // Progress bar
  const barWidth = 20;
  const filledWidth = Math.round((pct / 100) * barWidth);
  const emptyWidth = barWidth - filledWidth;
  const progressBar = "█".repeat(filledWidth) + "░".repeat(emptyWidth);

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      marginBottom={1}
      marginTop={1}
    >
      {/* Header */}
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={focusMode === "checklist" ? "green" : "cyan"}>
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
          taskColor = "magenta";
          connectorColor = "magenta";
          displayStatusText = " (paused)";
        } else if (status === "error") {
          statusIcon = "✗";
          taskColor = "red";
          connectorColor = "red";
          displayStatusText = " (failed)";
        }

        const connector = isLastVisible ? "└──" : "├──";

        return (
          <Box key={idx} flexDirection="column">
            <Box flexDirection="row">
              <Text color={connectorColor}>{connector} </Text>
              <Text color={connectorColor}>{statusIcon} </Text>
              <Text color={taskColor} strikethrough={status === "x"}>
                {task.text}{displayStatusText}
              </Text>
            </Box>
            {!isLastVisible && (
              <Box flexDirection="row">
                <Text color="gray">│</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
