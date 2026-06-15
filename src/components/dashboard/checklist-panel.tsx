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
}

export function ChecklistPanel({
  planState,
  checklistTasks,
  focusArea,
  checklistScrollOffset,
  maxChecklistVisible,
  agent,
  superagentInstances,
}: ChecklistPanelProps) {
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
  const helpText = focusArea === "checklist" ? " [↑/▼ Scroll • Esc Exit]" : "";
  const visibleChecklist = checklistTasks.slice(checklistScrollOffset, checklistScrollOffset + maxChecklistVisible);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focusArea === "checklist" ? "green" : "cyan"} paddingX={1} marginBottom={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={focusArea === "checklist" ? "green" : "cyan"}>
          📋 ACTIVE TASK CHECKLIST ({completedTasks}/{totalTasks} completed){scrollIndicator}{helpText}
        </Text>
      </Box>
      <Box flexDirection="row" marginBottom={1}>
        <Text color="cyan">Progress: {pct}% ({completedTasks}/{totalTasks} completed, {inProgressTasks} in progress)</Text>
      </Box>
      {visibleChecklist.map((task, index) => {
        const idx = checklistScrollOffset + index;
        let status = task.status;
        let statusChar = "[ ]";
        let taskColor = "white";
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
          statusChar = "[✓]";
          taskColor = "gray";
        } else if (status === "/") {
          statusChar = "[/]";
          taskColor = "yellow";
          displayStatusText = " (in progress)";
        } else if (status === "paused") {
          statusChar = "[⏸]";
          taskColor = "magenta";
          displayStatusText = " (paused)";
        } else if (status === "error") {
          statusChar = "[✗]";
          taskColor = "red";
          displayStatusText = " (failed)";
        }

        return (
          <Box key={idx} flexDirection="row">
            <Text color={status === "x" ? "green" : status === "/" ? "yellow" : status === "paused" ? "magenta" : status === "error" ? "red" : "cyan"}>
              {statusChar}{" "}
            </Text>
            <Text color={taskColor} strikethrough={status === "x"}>
              {task.text}{displayStatusText}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
